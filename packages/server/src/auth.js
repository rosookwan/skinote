// @ts-check
// 기기 등록 · 직원 로그인 · 세션(plan D6 · §5-1 · §5-3). 서버는 공개 인터넷에 있으므로 등록한 기기에서만 직원 이름을 보이고 비밀번호를
// 받는다(sync 7).
//
//   POST /api/v2/device/enroll    { code, publicKey, agent } → 기기(등록 번호 12자리: 명령줄이 미리 승인해 한 번 보여 준 것)
//   POST /api/v2/device/challenge { deviceId } → 한 번 값(60초, 한 번만)
//   POST /api/v2/login/staff      { deviceId, nonce, signature } → 로그인 표(5분, 이 기기) + 직원 타일
//   POST /api/v2/login            { ticket, staffId, pin } → 세션 쿠키 + SessionInfo(주어진 쿠키의 세션은 먼저 끝낸다)
//   POST /api/v2/logout           → 204, 세션 · 알림 연결 끝
//   GET  /api/v2/session          → 200 SessionInfo 또는 401 { state: 'signed_out' }
//
// 비밀번호 잠금: (계정, 기기)마다 15분 안에 5번 틀리면 그 기기에서 그 사람만 10분 잠근다(설정 login_lockout, 423 LOCKED). 한 계정이
// 모든 기기에서 한 시간에 10번 넘게 틀리면 다음 확인마다 min(2^(n−10)초, 8초) 기다린 뒤 본다(잠그지 않고 늦춘다). 한 기기에서 한 시간에
// 20번 틀리면 그 기기의 비밀번호 로그인을 30분 쉰다. 틀린 확인은 적어도 300ms 걸린다. 셈은 control.login_attempts에서 온다(다시 시작해도
// 이어진다). 비밀번호 · 등록 번호 · 토큰은 기록에 적지 않는다.
// 한 계정 · 한 기기 · 한 로그인 표에는 한 번에 하나의 확인만 돈다(동시에 온 요청은 확인하지 않고 429 BUSY): 셈은 확인이 끝난 뒤에 오르므로,
// 동시에 보낸 여러 요청이 모두 잠금 확인을 지나 잠금보다 많이 맞춰 보는 일이 없다. 잠기면 그 로그인 표도 버린다.
// 기사 기기(driver_tablet · driver_phone)는 기사 역할의 직원만 타일에 보이고 로그인할 수 있다(휴대폰을 잃어도 관리자 이름 · 비밀번호를 겨눌
// 수 없게).
//
// 요청마다 기기를 다시 본다: 끊은 기기(DEVICE_REVOKED)의 세션은 곧바로 끝나고 알림 연결이 닫힌다. 기기 상태는 매장마다 60초 캐시이고
// 관리 소켓의 기기 끊기는 캐시를 바로 버린다.

import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CSRF_HEADER, isDriverDevice, loginMessage, parseAuthBody } from '@skinote/contract';
import { sessionExpiry } from '@skinote/domain';
import { HttpError, sendJson } from './http.js';
import { verifyPin } from './pin.js';
import { CappedMap, clearedSessionCookie, clientIp, createLimiter, csrfFor, ipHashOf, newToken, sameText, sessionCookie, sessionToken, sha256Hex } from './security.js';

/**
 * @typedef {import('node:http').IncomingMessage} IncomingMessage
 * @typedef {import('node:http').ServerResponse} ServerResponse
 * @typedef {import('@skinote/store').ControlStore} ControlStore
 * @typedef {import('@skinote/store').Session} Session
 * @typedef {import('@skinote/store').Device} Device
 * @typedef {import('@skinote/store').StaffRow} StaffRow
 * @typedef {import('@skinote/contract').SessionInfo} SessionInfo
 * @typedef {import('./shops.js').ShopPort} ShopPort
 * @typedef {import('./secrets.js').Secrets} Secrets
 * @typedef {import('./sse.js').Hub} Hub
 * @typedef {import('./permissions.js').Who} Who
 * @typedef {{
 *   session: Session,
 *   shopId: string,
 *   port: ShopPort,
 *   staff: StaffRow,
 *   device: Device,
 *   who: Who,
 *   csrf: string,
 * }} SessionContext
 * @typedef {{ ok: true, ctx: SessionContext } | { ok: false, status: number, code: string, clear: boolean }} SessionCheck
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const AUTH_LIMITS = Object.freeze({
  nonceMs: MINUTE,
  ticketMs: 5 * MINUTE,
  /** 한 번 값 · 로그인 표 지도의 크기. */
  mapSize: 10_000,
  /** 등록 번호: 주소마다 15분에 10번. */
  enrollPerIp: { capacity: 10, refillPerSec: 10 / (15 * 60) },
  /** 모든 주소의 등록 시도가 한 시간에 이보다 많으면 경보 줄(막지는 않는다: 한 사람이 모든 매장의 등록을 막지 못하게). */
  enrollAlertPerHour: 100,
  challengePerIp: { capacity: 30, refillPerSec: 30 / 60 },
  loginPerIp: { capacity: 60, refillPerSec: 60 / 60 },
  /** (계정, 기기) 잠금을 셀 때의 창. */
  pairWindowMs: 15 * MINUTE,
  /** 계정의 늦춤: 한 시간에 이만큼 틀린 뒤부터, 최대 8초(앱의 로그인 요청 제한 시간 20초보다 짧게: 늦춘 답이 연결 실패로 보이지 않게). */
  backoffFrom: 10,
  backoffMaxMs: 8_000,
  devicePause: { failures: 20, windowMs: HOUR, pauseMs: 30 * MINUTE },
  failureFloorMs: 300,
  driverSessionMs: 14 * DAY,
  deviceCacheMs: 60_000,
  /** 세션마다 API: 초당 30번, 한꺼번에 60번. */
  apiPerSession: { capacity: 60, refillPerSec: 30 },
});

/** @param {number} ms */
const iso = ms => new Date(ms).toISOString();

/**
 * @param {{
 *   secrets: Secrets,
 *   control: ControlStore,
 *   shops: Map<string, ShopPort>,
 *   hub: Hub,
 *   nowMs: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 * }} deps
 */
export function createAuth({ secrets, control, shops, hub, nowMs, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {} }) {
  /** 한 번 값 → 기기 · 끝. */
  const nonces = new CappedMap(AUTH_LIMITS.mapSize);
  /** 로그인 표 → 매장 · 기기 · 끝. */
  const tickets = new CappedMap(AUTH_LIMITS.mapSize);
  /** (계정|기기) → { until, since }: 잠금 끝과 셈을 다시 시작한 때. */
  const pairLocks = new CappedMap(50_000);
  /** 기기 → { until, failures: 시각[] }. */
  const devicePauses = new CappedMap(50_000);
  /** 매장 → { at, byId }. */
  /** @type {Map<string, { at: number, byId: Map<string, Device> }>} */
  const deviceCache = new Map();
  /** 지금 비밀번호를 확인 중인 계정 · 기기(한 번에 하나). */
  const checkingAccounts = new Set();
  const checkingDevices = new Set();
  const limiters = {
    enroll: createLimiter(AUTH_LIMITS.enrollPerIp),
    challenge: createLimiter(AUTH_LIMITS.challengePerIp),
    login: createLimiter(AUTH_LIMITS.loginPerIp),
    api: createLimiter(AUTH_LIMITS.apiPerSession),
  };
  /** @type {number[]} */
  let enrollTimes = [];
  let lastAlertAt = -Infinity;

  /** @param {IncomingMessage} req */
  const ipHash = req => ipHashOf(secrets.ipKey, clientIp(req, { proxyToken: secrets.proxyToken ?? null }));

  // ── 기기 캐시 ─────────────────────────────────────────────────────────

  /** @param {ShopPort} port @param {string} deviceId @param {number} now */
  function deviceOf(port, deviceId, now) {
    let entry = deviceCache.get(port.shopId);
    const stale = !entry || now - entry.at > AUTH_LIMITS.deviceCacheMs || now < entry.at;
    if (stale || (entry && !entry.byId.has(deviceId) && now - entry.at > 1_000)) {
      entry = { at: now, byId: new Map(port.devices.list().map(d => [d.id, d])) };
      deviceCache.set(port.shopId, entry);
    }
    return entry?.byId.get(deviceId);
  }

  /** 모든 매장에서 기기 찾기(기기 id는 ULID라 겹치지 않는다). @param {string} deviceId @param {number} now */
  function findDevice(deviceId, now) {
    for (const port of shops.values()) {
      const device = deviceOf(port, deviceId, now);
      if (device) return { port, device };
    }
    return null;
  }

  /**
   * 기기 끊기(관리 소켓 · 끊긴 기기를 본 요청): 기기 행, 그 기기의 세션, 알림 연결.
   * @param {string} shopId @param {string} deviceId @param {string} reason @param {number} now
   */
  function revokeDevice(shopId, deviceId, reason, now) {
    const port = shops.get(shopId);
    const revoked = port ? port.devices.revoke(deviceId, reason, now) : false;
    const sessions = control.revokeDeviceSessions(shopId, deviceId, 'device_revoked', now);
    const streams = hub.closeDevice(shopId, deviceId);
    deviceCache.delete(shopId);
    return { revoked, sessions, streams };
  }

  // ── 세션 ─────────────────────────────────────────────────────────────

  /** @param {number} status @param {string} code @param {boolean} clear @returns {SessionCheck} */
  const fail = (status, code, clear) => ({ ok: false, status, code, clear });

  /**
   * 세션 하나를 지금 본다: 끝남(시간 · 쉬는 시간) · 매장 · 기기 · 계정 · 직원. touch면(사람이 한 요청: 조회 · 명령 · 세션 보기 · 로그아웃)
   * 마지막 사용 시각을 1분에 한 번 적는다. 알림 연결의 심장 박동과 머리 묻기는 적지 않는다(열어 둔 화면만으로 쉬는 시간이 끝나지 않게).
   * @param {Session} session @param {number} now @param {{ touch?: boolean }} [options] @returns {SessionCheck}
   */
  function checkSession(session, now, { touch = true } = {}) {
    if (session.revokedAt !== undefined) return fail(401, session.revokeReason === 'device_revoked' ? 'DEVICE_REVOKED' : 'SIGNED_OUT', true);
    if (session.expiresAt <= now || session.lastUsedAt + session.idleTimeoutS * 1000 <= now) {
      control.revokeSession(session.id, 'expired', now);
      hub.closeSession(session.id);
      return fail(401, 'SESSION_EXPIRED', true);
    }
    const port = shops.get(session.tenantId);
    if (!port) return fail(503, 'SHOP_UNAVAILABLE', false);
    const device = deviceOf(port, session.deviceId, now);
    if (!device || device.status !== 'active') {
      control.revokeDeviceSessions(session.tenantId, session.deviceId, 'device_revoked', now);
      hub.closeDevice(session.tenantId, session.deviceId);
      return fail(401, 'DEVICE_REVOKED', true);
    }
    const account = control.account(session.accountId);
    const staff = port.staff().find(s => s.id === session.staffMemberId);
    if (!account || account.status !== 'active' || !staff) {
      control.revokeSession(session.id, 'staff_inactive', now);
      hub.closeSession(session.id);
      return fail(401, 'SIGNED_OUT', true);
    }
    if (touch) control.touchSession(session.id, now);
    const vehicleId = device.vehicleId ?? (staff.roleKey === 'driver' ? staff.vehicleId : undefined);
    return {
      ok: true,
      ctx: {
        session, shopId: port.shopId, port, staff, device,
        who: { roleKey: staff.roleKey, deviceKind: device.kind, ...(vehicleId ? { vehicleId } : {}) },
        csrf: csrfFor(secrets.sessionKey, session.id),
      },
    };
  }

  /** 요청의 세션(쿠키). @param {IncomingMessage} req @param {{ touch?: boolean }} [options] @returns {SessionCheck} */
  function sessionOf(req, options = {}) {
    const token = sessionToken(req);
    if (!token) return fail(401, 'SIGNED_OUT', req.headers.cookie !== undefined && /__Host-sn_session=/.test(req.headers.cookie));
    const session = control.sessionByTokenHash(sha256Hex(token));
    if (!session) return fail(401, 'SIGNED_OUT', true);
    return checkSession(session, nowMs(), options);
  }

  /** @param {IncomingMessage} req @param {SessionContext} ctx */
  const csrfOk = (req, ctx) => {
    const header = req.headers[CSRF_HEADER];
    return typeof header === 'string' && sameText(header, ctx.csrf);
  };

  /** @param {SessionContext} ctx */
  const sessionLimit = ctx => limiters.api.take(ctx.session.id, nowMs());

  /** @param {SessionContext} ctx @param {number} now @returns {SessionInfo} */
  function sessionInfo(ctx, now) {
    const { device, staff } = ctx;
    return {
      shop: { name: ctx.port.shopName(now) },
      staff: { id: staff.id, name: staff.name, roleKey: staff.roleKey },
      device: { id: device.id, kind: device.kind, label: device.label, ...(device.vehicleId ? { vehicleId: device.vehicleId } : {}) },
      csrf: ctx.csrf,
      idleTimeoutS: ctx.session.idleTimeoutS,
      serverTime: iso(now),
    };
  }

  /** 알림 연결이 아직 살아도 되는지(심장 박동마다). @param {{ sessionId: string }} stream */
  function streamAlive(stream) {
    const session = control.session(stream.sessionId);
    return !!session && checkSession(session, nowMs(), { touch: false }).ok;
  }

  // ── 잠금 셈 ────────────────────────────────────────────────────────────

  /**
   * (계정, 기기)의 잠금 상태. 지도에 없으면(서버를 다시 시작) 표에서 지난 15분의 실패를 센다.
   * @param {string} accountId @param {string} deviceId @param {number} now @param {{ maxFailures: number, lockMinutes: number }} lockout
   */
  function pairState(accountId, deviceId, now, lockout) {
    const key = accountId + '|' + deviceId;
    let st = pairLocks.get(key);
    if (!st) {
      const n = control.failuresSince({ accountId, deviceId, method: 'pin' }, now - AUTH_LIMITS.pairWindowMs);
      const until = n >= lockout.maxFailures ? now + lockout.lockMinutes * MINUTE : 0;
      st = { until, since: until };
      pairLocks.set(key, st);
    }
    return st;
  }

  /** 기기의 쉼 상태(지난 한 시간의 실패 시각). @param {string} deviceId @param {number} now */
  function deviceState(deviceId, now) {
    const { failures, windowMs, pauseMs } = AUTH_LIMITS.devicePause;
    let st = devicePauses.get(deviceId);
    if (!st) {
      const n = Math.min(failures, control.failuresSince({ deviceId, method: 'pin' }, now - windowMs));
      st = { until: n >= failures ? now + pauseMs : 0, failures: n >= failures ? [] : Array(n).fill(now) };
      devicePauses.set(deviceId, st);
    }
    st.failures = st.failures.filter(/** @param {number} t */ t => t > now - windowMs);
    return st;
  }

  /** 새 비밀번호(명령줄 rotate-pin): 그 계정의 잠금을 지도에서 지운다. @param {string} accountId */
  function resetAccount(accountId) {
    for (const key of [...pairLocks.keys()]) if (key.startsWith(accountId + '|')) pairLocks.delete(key);
  }

  // ── 길(핸들러) ─────────────────────────────────────────────────────────

  /** @param {ServerResponse} res */
  const clearCookie = res => res.setHeader('set-cookie', clearedSessionCookie());

  /** @param {number} now */
  function noteEnroll(now) {
    enrollTimes = enrollTimes.filter(t => t > now - HOUR);
    enrollTimes.push(now);
    if (enrollTimes.length > 100_000) enrollTimes = enrollTimes.slice(-AUTH_LIMITS.enrollAlertPerHour * 2);
    if (enrollTimes.length > AUTH_LIMITS.enrollAlertPerHour && now - lastAlertAt > HOUR) {
      lastAlertAt = now;
      log('ALERT enroll_attempts_high');
    }
  }

  /** P-256 공개 열쇠인지(createPublicKey가 읽고 곡선이 prime256v1). @param {import('@skinote/contract').DevicePublicKey} jwk */
  function publicKeyText(jwk) {
    const canonical = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    const key = createPublicKey({ key: canonical, format: 'jwk' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new HttpError(400, 'BAD_INPUT');
    return JSON.stringify(canonical);
  }

  /** @type {Record<string, (req: IncomingMessage, res: ServerResponse, input: { body: unknown, origin: string, ctx?: SessionContext }) => Promise<void> | void>} */
  const handlers = {
    /** 기기 등록. */
    enroll(req, res, { body }) {
      const parsed = parseAuthBody('enroll', body);
      if (!parsed.ok) throw new HttpError(400, 'BAD_INPUT', { problems: parsed.problems.slice(0, 5) });
      const now = nowMs();
      noteEnroll(now);
      const hash = ipHash(req);
      const codeHash = sha256Hex(parsed.body.code);
      /** @param {boolean} succeeded @param {string} reason @param {{ tenantId?: string, deviceId?: string }} [extra] */
      const attempt = (succeeded, reason, extra = {}) => control.recordAttempt({ loginId: 'enrollment', method: 'enrollment', succeeded, reason, ipHash: hash, now, ...extra });
      const route = control.route(codeHash);
      if (!route) {
        attempt(false, 'bad_code');
        throw new HttpError(400, 'BAD_CODE');
      }
      if (route.usedAt !== undefined || route.expiresAt <= now) {
        attempt(false, route.usedAt !== undefined ? 'code_used' : 'code_expired', { tenantId: route.tenantId });
        throw new HttpError(410, 'CODE_USED');
      }
      const port = shops.get(route.tenantId);
      if (!port) throw new HttpError(503, 'SHOP_UNAVAILABLE');
      const code = port.devices.codeById(route.codeId);
      if (!code || code.usedAt !== undefined || code.approvedAt === undefined || code.expiresAt <= now) {
        attempt(false, 'code_used', { tenantId: route.tenantId });
        throw new HttpError(410, 'CODE_USED');
      }
      let publicKey;
      try {
        publicKey = publicKeyText(parsed.body.publicKey);
      } catch {
        attempt(false, 'bad_key', { tenantId: route.tenantId });
        throw new HttpError(400, 'BAD_INPUT', { problems: ['publicKey: 모양이 틀렸다'] });
      }
      port.devices.claimCode(code.id, parsed.body.agent, now);
      const device = port.devices.enroll({ codeId: code.id, publicKey, now });
      control.useRoute(codeHash, now);
      attempt(true, 'ok', { tenantId: route.tenantId, deviceId: device.id });
      deviceCache.delete(port.shopId);
      log(`기기 등록 ${port.shopId} ${device.kind} ${device.shortNo}번`);
      sendJson(req, res, 200, { deviceId: device.id, kind: device.kind, label: device.label, ...(device.vehicleId ? { vehicleId: device.vehicleId } : {}) });
    },

    /** 한 번 값(기기가 있는지는 알려 주지 않는다: 서명이 맞아야 쓸모가 있다). */
    challenge(req, res, { body }) {
      const parsed = parseAuthBody('challenge', body);
      if (!parsed.ok) throw new HttpError(400, 'BAD_INPUT', { problems: parsed.problems.slice(0, 5) });
      const now = nowMs();
      const nonce = newToken();
      nonces.set(nonce, { deviceId: parsed.body.deviceId, expiresAt: now + AUTH_LIMITS.nonceMs });
      sendJson(req, res, 200, { nonce, expiresAt: iso(now + AUTH_LIMITS.nonceMs) });
    },

    /** 서명을 보고 로그인 표와 직원 타일을 준다. */
    staff(req, res, { body, origin }) {
      const parsed = parseAuthBody('staff', body);
      if (!parsed.ok) throw new HttpError(400, 'BAD_INPUT', { problems: parsed.problems.slice(0, 5) });
      const now = nowMs();
      const { deviceId, nonce, signature } = parsed.body;
      const issued = nonces.get(nonce);
      nonces.delete(nonce);
      if (!issued || issued.deviceId !== deviceId || issued.expiresAt <= now) throw new HttpError(401, 'BAD_SIGNATURE');
      const found = findDevice(deviceId, now);
      if (!found) throw new HttpError(404, 'DEVICE_UNKNOWN');
      if (found.device.status !== 'active') throw new HttpError(401, 'DEVICE_REVOKED');
      let ok = false;
      try {
        ok = verifySignature('sha256', Buffer.from(loginMessage(origin, deviceId, nonce), 'utf8'),
          { key: JSON.parse(found.device.publicKey), format: 'jwk', dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
      } catch {
        ok = false;
      }
      if (!ok) throw new HttpError(401, 'BAD_SIGNATURE');
      const ticket = newToken();
      tickets.set(ticket, { shopId: found.port.shopId, deviceId, expiresAt: now + AUTH_LIMITS.ticketMs });
      const driverDevice = isDriverDevice(found.device.kind);
      const staff = found.port.staff()
        .filter(s => s.accountId !== undefined && control.account(s.accountId)?.status === 'active' && (!driverDevice || s.roleKey === 'driver'))
        .map(s => ({ id: s.id, name: s.name }));
      sendJson(req, res, 200, { ticket, shopName: found.port.shopName(now), staff });
    },

    /** 비밀번호 로그인. */
    async login(req, res, { body }) {
      const parsed = parseAuthBody('login', body);
      if (!parsed.ok) throw new HttpError(400, 'BAD_INPUT', { problems: parsed.problems.slice(0, 5) });
      const now = nowMs();
      const ticket = tickets.get(parsed.body.ticket);
      if (!ticket || ticket.expiresAt <= now) throw new HttpError(401, 'BAD_TICKET');
      const port = shops.get(ticket.shopId);
      if (!port) throw new HttpError(503, 'SHOP_UNAVAILABLE');
      const device = deviceOf(port, ticket.deviceId, now);
      if (!device || device.status !== 'active') {
        tickets.delete(parsed.body.ticket);
        throw new HttpError(401, 'DEVICE_REVOKED');
      }
      const staff = port.staff().find(s => s.id === parsed.body.staffId && s.accountId !== undefined && (!isDriverDevice(device.kind) || s.roleKey === 'driver'));
      const account = staff?.accountId ? control.account(staff.accountId) : undefined;
      if (!staff || !account || account.status !== 'active' || !account.pinHash) throw new HttpError(400, 'UNKNOWN_STAFF');
      const pinHash = account.pinHash;
      const settings = port.authSettings(now);
      const hash = ipHash(req);

      // 한 번에 하나: 이 계정 · 이 기기 · 이 로그인 표의 확인이 도는 동안 온 요청은 맞춰 보지 않는다(셈이 오르기 전에 잠금 확인을 지나지 않게).
      if (checkingAccounts.has(account.id) || checkingDevices.has(device.id) || ticket.busy) throw new HttpError(429, 'BUSY');
      const pause = deviceState(device.id, now);
      if (pause.until > now) throw new HttpError(423, 'LOCKED', { lockedUntil: iso(pause.until) });
      const pair = pairState(account.id, device.id, now, settings.lockout);
      if (pair.until > now) {
        tickets.delete(parsed.body.ticket);
        throw new HttpError(423, 'LOCKED', { lockedUntil: iso(pair.until) });
      }
      checkingAccounts.add(account.id);
      checkingDevices.add(device.id);
      ticket.busy = true;
      /** @type {boolean} */
      let ok;
      /** @type {number} */
      let at;
      const started = performance.now();
      try {
        const recent = control.failuresSince({ accountId: account.id, method: 'pin' }, now - HOUR);
        if (recent >= AUTH_LIMITS.backoffFrom) await sleep(Math.min(2 ** (recent - AUTH_LIMITS.backoffFrom) * 1000, AUTH_LIMITS.backoffMaxMs));
        ok = await verifyPin(secrets.pinPepper, parsed.body.pin, pinHash);
        at = nowMs();
        if (!ok) {
          // 틀림: 셈을 올린 뒤에야 다음 확인이 돈다(아래 finally 전에 적는다).
          control.recordAttempt({ loginId: account.loginId ?? 'staff', accountId: account.id, tenantId: port.shopId, deviceId: device.id, method: 'pin', succeeded: false, reason: 'bad_password', ipHash: hash, now: at });
          control.loginFailed(account.id, at);
          const dev = deviceState(device.id, at);
          dev.failures.push(at);
          if (dev.failures.length >= AUTH_LIMITS.devicePause.failures) {
            dev.until = at + AUTH_LIMITS.devicePause.pauseMs;
            dev.failures = [];
            log(`기기 비밀번호 로그인 쉼 ${port.shopId} ${device.shortNo}번`);
          }
          const waited = performance.now() - started;
          if (waited < AUTH_LIMITS.failureFloorMs) await sleep(AUTH_LIMITS.failureFloorMs - waited);
        }
      } finally {
        checkingAccounts.delete(account.id);
        checkingDevices.delete(device.id);
        ticket.busy = false;
      }
      if (!ok) {
        const n = control.failuresSince({ accountId: account.id, deviceId: device.id, method: 'pin' }, Math.max(at - AUTH_LIMITS.pairWindowMs, pair.since));
        if (n >= settings.lockout.maxFailures) {
          pair.until = at + settings.lockout.lockMinutes * MINUTE;
          pair.since = pair.until;
          tickets.delete(parsed.body.ticket);
          throw new HttpError(423, 'LOCKED', { lockedUntil: iso(pair.until) });
        }
        const dev = deviceState(device.id, at);
        if (dev.until > at) throw new HttpError(423, 'LOCKED', { lockedUntil: iso(dev.until) });
        throw new HttpError(401, 'BAD_PIN');
      }

      // 맞음: 셈을 다시 시작하고, 주어진 쿠키의 세션을 끝내고, 새 세션.
      control.recordAttempt({ loginId: account.loginId ?? 'staff', accountId: account.id, tenantId: port.shopId, deviceId: device.id, method: 'pin', succeeded: true, reason: 'ok', ipHash: hash, now: at });
      control.loginSucceeded(account.id, at);
      pairLocks.delete(account.id + '|' + device.id);
      tickets.delete(parsed.body.ticket);
      const previous = sessionToken(req);
      if (previous) {
        const old = control.sessionByTokenHash(sha256Hex(previous));
        if (old && old.revokedAt === undefined) {
          control.revokeSession(old.id, 'relogin', at);
          hub.closeSession(old.id);
        }
      }
      const driver = isDriverDevice(device.kind);
      const idleTimeoutS = (driver ? settings.idleMinutes.driver : settings.idleMinutes.counter) * 60;
      const expiresAt = driver ? at + AUTH_LIMITS.driverSessionMs : sessionExpiry(at, settings.cutoff);
      const token = newToken();
      const userAgent = req.headers['user-agent'];
      const session = control.createSession({
        tokenHash: sha256Hex(token), accountId: account.id, tenantId: port.shopId, deviceId: device.id, staffMemberId: staff.id, idleTimeoutS, expiresAt,
        ipHash: hash, ...(typeof userAgent === 'string' ? { userAgent } : {}), now: at,
      });
      port.devices.signIn({ deviceId: device.id, staffMemberId: staff.id, method: 'pin', sessionId: session.id, now: at });
      const check = checkSession(session, at);
      if (!check.ok) throw new HttpError(check.status, check.code);
      sendJson(req, res, 200, sessionInfo(check.ctx, at), { 'set-cookie': sessionCookie(token, (expiresAt - at) / 1000) });
    },

    /** 로그아웃. */
    logout(req, res, { ctx }) {
      const session = /** @type {SessionContext} */ (ctx).session;
      control.revokeSession(session.id, 'logout', nowMs());
      hub.closeSession(session.id);
      sendJson(req, res, 204, null, { 'set-cookie': clearedSessionCookie() });
    },

    /** GET 세션(쿠키 없음 · 끝남은 401 signed_out). */
    session(req, res) {
      const check = sessionOf(req);
      if (!check.ok) {
        if (check.clear) clearCookie(res);
        throw new HttpError(check.status, check.code, check.status === 401 ? { state: 'signed_out' } : {});
      }
      sendJson(req, res, 200, sessionInfo(check.ctx, nowMs()));
    },
  };

  return {
    handlers,
    sessionOf,
    csrfOk,
    sessionLimit,
    streamAlive,
    revokeDevice,
    resetAccount,
    /** 로그인 전 길의 주소마다 제한. @param {'enroll' | 'challenge' | 'login'} kind */
    ipLimit: kind => /** @param {IncomingMessage} req */ req => limiters[kind].take(ipHash(req), nowMs()),
    /** 시험: 지도의 크기. */
    sizes: () => ({ nonces: nonces.size, tickets: tickets.size, pairLocks: pairLocks.size, devicePauses: devicePauses.size }),
  };
}

/** @typedef {ReturnType<typeof createAuth>} Auth */

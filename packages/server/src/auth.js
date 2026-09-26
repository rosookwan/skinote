// @ts-check
// 기기 등록 · 직원 로그인 · 세션(plan D6 · §5-1 · §5-3). 서버는 공개 인터넷에 있으므로 등록한 기기에서만 직원 이름을 보이고 비밀번호를
// 받는다(sync 7).
//
//   GET  /api/v2/device/enroll    → 등록 방법 { mode: 'code' } | { mode: 'open', vehicles }(로그인 전 · 기기 없이, 직원 이름 · 매장 자료 없음)
//   POST /api/v2/device/enroll    { code, publicKey, agent } → 기기(등록 번호 12자리: 명령줄이 미리 승인해 한 번 보여 준 것)
//   POST /api/v2/device/open-enroll { kind, vehicleId?, publicKey, agent } → 기기(열린 등록: 시험 매장만, 아래)
//   POST /api/v2/device/open-release { deviceId, nonce, signature } → 204(스스로 붙은 기기가 자기 등록을 끊고 기기 선택으로, 아래)
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
//
// 열린 등록(2026-09-26 시험 중 요청 "등록번호는 좀 빼줘"): 설정 SKINOTE_TEST_OPEN_ENROLL=on이고, 서버의 매장이 하나이며, 그 매장이 시험
// 매장(control tenants.is_test와 매장 파일 shops.is_test 모두 1, 상태 active)일 때만 켜진다. 그 밖에는 등록 방법이 'code'이고 열린 등록
// 요청은 403 ENROLL_CLOSED다(아무것도 바뀌지 않음). 켜지면 새 기기가 번호 없이 종류(카운터 · 기사 휴대폰 · 기사 태블릿)와 기사 기기의 차량을
// 골라 스스로 등록한다: 열쇠 · 서명 · 기기 번호는 번호 등록과 같고, 이름은 `시험 기기 N`(N = 기기 번호), registered_by는
// 'system:open_enroll'. 막는 것: 주소마다 15분에 10번, 끊기지 않은 열린 기기 30대까지(넘으면 409 DEVICE_LIMIT, 한 줄
// `기기 수 초과 · 관리자 확인 필요`, 새로 붙을 때 한 시간 넘게 로그인하지 않은 열린 기기는 먼저 끊는다), 등록마다 'ALERT open_enroll'
// 기록 줄. 직원 비밀번호 로그인 · 다섯 번 잠금 · 기기 끊기는 그대로다. 기한(SKINOTE_TEST_OPEN_ENROLL_UNTIL, 마지막 영업일)이 지나면
// 저절로 꺼진다.
//   - 스스로 붙은 기기는 열린 등록이 켜진 동안만 쓰인다(usable): 설정을 끄거나 · 기한이 지나거나 · 매장이 둘이 되거나 · 시험 매장이
//     아니게 되면 그런 기기를 모두 끊는다(cutOpenDevices: 서버 시작 때, 그리고 스스로 붙은 기기의 요청을 볼 때). 세션 · 알림 연결도
//     곧 끝나고 다시 쓰려면 등록 번호로 붙인다.
//   - 잠금 셈에서 스스로 붙은 기기는 모두 한 기기('open:<매장>')다: (계정, 열린 기기 모두) 15분 5번 잠금, 열린 기기 모두 한 시간 20번
//     쉼(쉬면 'ALERT open_enroll_pin'), 한 번에 하나의 확인. 기기를 더 붙여 잠금을 피하지 못한다. 번호로 붙인 기기의 확인 자리와 계정
//     늦춤 셈은 열린 기기와 따로다(열린 기기의 시도가 진짜 직원의 로그인을 막거나 늦추지 않게).
//   - 스스로 붙은 기사 기기의 차량 범위는 그 기사의 차량이 먼저다(기기를 붙인 사람이 차량을 골라 남의 목록을 보지 못하게). 기사에게
//     차량이 없을 때만 기기의 차량.
//   - 로그인 화면의 직원 타일 답에 openDevice(차량 이름)를 싣고, 기기는 open-release로 자기 등록을 끊고 기기 선택으로 돌아간다(종류 ·
//     차량을 잘못 골랐을 때). 서명은 로그인과 같다(한 번 값 · 기기 열쇠). 번호로 붙인 기기는 403 ENROLL_CLOSED.

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
  /** 열린 등록(시험 매장): 주소마다 15분에 10번(번호 등록과 따로 센다). */
  openEnrollPerIp: { capacity: 10, refillPerSec: 10 / (15 * 60) },
  /** 열린 등록으로 붙어 끊기지 않은 기기의 끝 수(시험 매장마다). */
  openEnrollCap: 30,
  /** 열린 등록으로 붙은 뒤 이만큼 로그인하지 않은 기기는 새 기기가 붙을 때 끊는다(열쇠를 잃은 기기가 자리를 차지하지 않게). */
  openUnusedMs: HOUR,
  /** 등록 방법 묻기: 주소마다 분에 60번. */
  enrollModePerIp: { capacity: 60, refillPerSec: 1 },
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

/** 열린 등록으로 붙은 기기의 이름(기기 번호 N). 문구 표 docs/design/wording.md 3-19(확인 대기). */
export const OPEN_DEVICE_LABEL = '시험 기기 {n}';
/** @param {number} shortNo */
const openDeviceLabel = shortNo => OPEN_DEVICE_LABEL.replace('{n}', String(shortNo));

/**
 * @param {{
 *   secrets: Secrets,
 *   control: ControlStore,
 *   shops: Map<string, ShopPort>,
 *   hub: Hub,
 *   nowMs: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 *   testOpenEnroll?: boolean,
 *   openEnrollUntil?: string | null,
 *   businessDateOf?: (ms: number) => string,
 *   shopCount?: number,
 * }} deps testOpenEnroll = 설정 SKINOTE_TEST_OPEN_ENROLL이 on, openEnrollUntil = 그 마지막 영업일(SKINOTE_TEST_OPEN_ENROLL_UNTIL, 없으면
 *   켜지지 않는다), businessDateOf = 시각의 영업일(매장 시간대 · 하루 기준 시각), shopCount = 설정한 매장 수(SKINOTE_SHOP_IDS)
 */
export function createAuth({
  secrets, control, shops, hub, nowMs, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {}, testOpenEnroll = false,
  openEnrollUntil = null, businessDateOf = ms => new Date(ms).toISOString().slice(0, 10), shopCount = shops.size,
}) {
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
    openEnroll: createLimiter(AUTH_LIMITS.openEnrollPerIp),
    enrollMode: createLimiter(AUTH_LIMITS.enrollModePerIp),
    challenge: createLimiter(AUTH_LIMITS.challengePerIp),
    login: createLimiter(AUTH_LIMITS.loginPerIp),
    api: createLimiter(AUTH_LIMITS.apiPerSession),
  };
  /** @type {number[]} */
  let enrollTimes = [];
  let lastAlertAt = -Infinity;
  let lastLimitAlertAt = -Infinity;
  /** 서버 시작 때 끊은 열린 기기 수(서버 안의 상태). */
  let cutAtStart = 0;

  /** @param {IncomingMessage} req */
  const ipHash = req => ipHashOf(secrets.ipKey, clientIp(req, { proxyToken: secrets.proxyToken ?? null }));

  // ── 기기 캐시 ─────────────────────────────────────────────────────────

  /** 매장의 기기 캐시(찾는 기기가 없으면 1초 뒤 다시 읽는다). @param {ShopPort} port @param {number} now @param {string} [wantId] */
  function cacheOf(port, now, wantId) {
    let entry = deviceCache.get(port.shopId);
    const stale = !entry || now - entry.at > AUTH_LIMITS.deviceCacheMs || now < entry.at;
    if (!entry || stale || (wantId !== undefined && !entry.byId.has(wantId) && now - entry.at > 1_000)) {
      entry = { at: now, byId: new Map(port.devices.list().map(d => [d.id, d])) };
      deviceCache.set(port.shopId, entry);
    }
    return entry;
  }

  /** @param {ShopPort} port @param {string} deviceId @param {number} now */
  const deviceOf = (port, deviceId, now) => cacheOf(port, now, deviceId).byId.get(deviceId);

  /**
   * 스스로 붙은 기기 가운데 since 뒤에 쓰였을 수 있는 것(끊기지 않음 · since 뒤에 끊김)의 id: 잠금 셈을 표에서 다시 셀 때 한 기기처럼 센다.
   * @param {ShopPort} port @param {number} now @param {number} since
   */
  const openIds = (port, now, since) => [...cacheOf(port, now).byId.values()]
    .filter(d => d.openEnrolled && (d.status === 'active' || (d.revokedAt ?? 0) > since)).map(d => d.id);

  /** 모든 매장에서 기기 찾기(기기 id는 ULID라 겹치지 않는다). @param {string} deviceId @param {number} now */
  function findDevice(deviceId, now) {
    for (const port of shops.values()) {
      const device = deviceOf(port, deviceId, now);
      if (device) return { port, device };
    }
    return null;
  }

  // ── 열린 등록(시험 매장) ──────────────────────────────────────────────

  /** 기한(마지막 영업일)이 지났는지. @param {number} now */
  const openExpired = now => testOpenEnroll && openEnrollUntil !== null && businessDateOf(now) > openEnrollUntil;

  /**
   * 열린 등록을 받을 매장: 설정이 켜져 있고, 기한(마지막 영업일) 안이고, 서버의 매장이 하나이고, 그 매장이 control · 매장 파일 모두 시험
   * 매장(상태 active)일 때만. 요청마다 본다(매장을 만든 뒤 · 새로 만든 뒤 · 기한이 지난 뒤에도 다시 시작 없이 맞게). 아니면 null(번호 등록).
   * @param {number} [now]
   * @returns {ShopPort | null}
   */
  function openTarget(now = nowMs()) {
    if (!testOpenEnroll || openEnrollUntil === null || openExpired(now) || shopCount !== 1 || shops.size !== 1) return null;
    const [port] = shops.values();
    if (!port) return null;
    const tenant = control.tenant(port.shopId);
    if (!tenant || !tenant.isTest || tenant.status !== 'active') return null;
    try {
      return port.isTest() ? port : null;
    } catch {
      return null;
    }
  }

  /** 열린 등록이 꺼진 까닭(기기 끊기의 revoke_reason). @param {number} now */
  const closedReason = now => (!testOpenEnroll ? 'open_enroll_off' : openExpired(now) ? 'open_enroll_expired' : 'open_enroll_closed');

  /**
   * 열린 등록을 받지 않는 매장의 스스로 붙은 기기를 모두 끊는다: 기기 행, 세션, 알림 연결. 서버 시작 때와, 스스로 붙은 기기가 열린 등록이
   * 꺼진 뒤에 온 때(usable) 부른다. 두 번 불러도 된다(이미 끊긴 기기는 세지 않는다). 끊은 수.
   * @param {number} now
   */
  function cutOpenDevices(now) {
    const target = openTarget(now);
    const reason = closedReason(now);
    let cut = 0;
    for (const port of shops.values()) {
      if (port === target) continue;
      /** @type {string[]} */
      let ids = [];
      try {
        ids = port.devices.revokeOpen(reason, now);
      } catch (error) {
        log(`열린 기기 끊기 실패 ${port.shopId}: ${error instanceof Error ? error.name : 'Error'}`);
        continue;
      }
      if (!ids.length) continue;
      for (const id of ids) {
        control.revokeDeviceSessions(port.shopId, id, 'device_revoked', now);
        hub.closeDevice(port.shopId, id);
      }
      deviceCache.delete(port.shopId);
      cut += ids.length;
      log(`ALERT open_enroll_cut ${port.shopId} · 열린 등록 꺼짐(${reason}) · 시험 기기 ${ids.length}대 끊음(다시 쓰려면 등록 번호)`);
    }
    return cut;
  }

  /**
   * 기기를 쓸 수 있는지: 끊기지 않았고, 스스로 붙은 기기면 그 매장이 지금 열린 등록을 받는다. 열린 등록이 꺼진 뒤 스스로 붙은 기기가
   * 오면 그런 기기를 모두 끊는다.
   * @param {ShopPort} port @param {Device} device @param {number} now
   */
  function usable(port, device, now) {
    if (device.status !== 'active') return false;
    if (!device.openEnrolled || openTarget(now) === port) return true;
    cutOpenDevices(now);
    return false;
  }

  /** 서버 시작: 열린 등록을 받지 않는 매장의 스스로 붙은 기기를 끊는다(설정을 끄고 다시 켠 때). 끊은 수. */
  function cutAtStartup() {
    cutAtStart = cutOpenDevices(nowMs());
    return cutAtStart;
  }

  /**
   * 서버 안의 상태(/api/health)에 싣는 열린 등록 상태(이름 · 열쇠 없음): 설정 flag · 켜짐 active · 기한 until과 남은 날 daysLeft · 기한
   * 지남 expired · 끊기지 않은 열린 기기 수 devices(모든 매장) · 시작 때 끊은 수 cutAtStart, 켜졌으면 매장 · 끝 수 · 24시간의 새 기기와
   * 열린 기기의 틀린 비밀번호 수.
   */
  function openEnrollStatus() {
    const now = nowMs();
    const port = openTarget(now);
    let devices = 0;
    for (const p of shops.values()) {
      try {
        devices += p.devices.openCount();
      } catch {
        /* 읽지 못한 매장은 세지 않는다 */
      }
    }
    const today = businessDateOf(now);
    const until = testOpenEnroll && openEnrollUntil !== null ? openEnrollUntil : null;
    /** @type {Record<string, unknown>} */
    const status = {
      flag: testOpenEnroll ? 'on' : 'off',
      active: !!port,
      ...(until ? { until, daysLeft: Math.round((Date.parse(until) - Date.parse(today)) / DAY), expired: until < today } : {}),
      devices,
      ...(cutAtStart ? { cutAtStart } : {}),
    };
    if (port) {
      const list = [...cacheOf(port, now).byId.values()];
      status.shopId = port.shopId;
      status.cap = AUTH_LIMITS.openEnrollCap;
      status.enrolled24h = list.filter(d => d.openEnrolled && d.registeredAt > now - DAY).length;
      try {
        status.pinFailures24h = control.failureCount({ deviceIds: openIds(port, now, now - DAY), method: 'pin' }, now - DAY);
      } catch {
        status.pinFailures24h = null;
      }
    }
    return status;
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
    if (!device || !usable(port, device, now)) {
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
    // 스스로 붙은 기사 기기는 기사의 차량이 먼저(기기를 붙인 사람이 고른 차량으로 남의 목록을 보지 못하게), 번호 기기는 기기의 차량이 먼저.
    const driverVan = staff.roleKey === 'driver' ? staff.vehicleId : undefined;
    const vehicleId = device.openEnrolled ? driverVan ?? device.vehicleId : device.vehicleId ?? driverVan;
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

  /** 잠금 셈의 기기 조건: 열린 기기 모두(pool) 또는 그 기기. @param {string} lockId @param {string[] | null} pool */
  const deviceFilter = (lockId, pool) => (pool ? { deviceIds: pool } : { deviceId: lockId });

  /**
   * (계정, 기기)의 잠금 상태. 지도에 없으면(서버를 다시 시작) 표에서 지난 15분의 실패를 센다. 스스로 붙은 기기는 lockId 'open:<매장>'과
   * 열린 기기 id 목록(pool)으로 모두 한 기기처럼 센다.
   * @param {string} accountId @param {string} lockId @param {number} now @param {{ maxFailures: number, lockMinutes: number }} lockout
   * @param {string[] | null} pool
   */
  function pairState(accountId, lockId, now, lockout, pool) {
    const key = accountId + '|' + lockId;
    let st = pairLocks.get(key);
    if (!st) {
      const n = control.failuresSince({ accountId, ...deviceFilter(lockId, pool), method: 'pin' }, now - AUTH_LIMITS.pairWindowMs);
      const until = n >= lockout.maxFailures ? now + lockout.lockMinutes * MINUTE : 0;
      st = { until, since: until };
      pairLocks.set(key, st);
    }
    return st;
  }

  /** 기기의 쉼 상태(지난 한 시간의 실패 시각). 열린 기기는 모두 한 기기. @param {string} lockId @param {number} now @param {string[] | null} pool */
  function deviceState(lockId, now, pool) {
    const { failures, windowMs, pauseMs } = AUTH_LIMITS.devicePause;
    let st = devicePauses.get(lockId);
    if (!st) {
      const n = Math.min(failures, control.failuresSince({ ...deviceFilter(lockId, pool), method: 'pin' }, now - windowMs));
      st = { until: n >= failures ? now + pauseMs : 0, failures: n >= failures ? [] : Array(n).fill(now) };
      devicePauses.set(lockId, st);
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

  /**
   * 한 번 값과 기기 서명을 본다(직원 타일 · 열린 기기 놓기): 한 번 값은 쓰면 버린다. 없는 기기 404, 쓸 수 없는 기기 401 DEVICE_REVOKED,
   * 서명이 틀리면 401 BAD_SIGNATURE.
   * @param {{ deviceId: string, nonce: string, signature: string }} body @param {string} origin @param {number} now
   */
  function signedDevice({ deviceId, nonce, signature }, origin, now) {
    const issued = nonces.get(nonce);
    nonces.delete(nonce);
    if (!issued || issued.deviceId !== deviceId || issued.expiresAt <= now) throw new HttpError(401, 'BAD_SIGNATURE');
    const found = findDevice(deviceId, now);
    if (!found) throw new HttpError(404, 'DEVICE_UNKNOWN');
    if (!usable(found.port, found.device, now)) throw new HttpError(401, 'DEVICE_REVOKED');
    let ok = false;
    try {
      ok = verifySignature('sha256', Buffer.from(loginMessage(origin, deviceId, nonce), 'utf8'),
        { key: JSON.parse(found.device.publicKey), format: 'jwk', dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
    } catch {
      ok = false;
    }
    if (!ok) throw new HttpError(401, 'BAD_SIGNATURE');
    return found;
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

    /** 등록 방법(로그인 전 · 기기 없이): 열린 등록이면 기사 기기가 고를 차량만 싣는다(직원 이름 · 매장 자료 없음). */
    enrollMode(req, res) {
      if (!limiters.enrollMode.take(ipHash(req), nowMs())) throw new HttpError(429, 'RATE_LIMITED');
      const port = openTarget();
      if (!port) {
        sendJson(req, res, 200, { mode: 'code' });
        return;
      }
      sendJson(req, res, 200, { mode: 'open', vehicles: port.vehicles(nowMs()) });
    },

    /** 열린 등록(시험 매장만): 고른 종류 · 차량과 기기 열쇠로 기기를 만든다. */
    openEnroll(req, res, { body }) {
      const parsed = parseAuthBody('openEnroll', body);
      if (!parsed.ok) throw new HttpError(400, 'BAD_INPUT', { problems: parsed.problems.slice(0, 5) });
      const now = nowMs();
      noteEnroll(now);
      const hash = ipHash(req);
      /** @param {boolean} succeeded @param {string} reason @param {{ tenantId?: string, deviceId?: string }} [extra] */
      const attempt = (succeeded, reason, extra = {}) => control.recordAttempt({ loginId: 'enrollment', method: 'enrollment', succeeded, reason, ipHash: hash, now, ...extra });
      const port = openTarget();
      if (!port) {
        attempt(false, 'open_closed');
        throw new HttpError(403, 'ENROLL_CLOSED');
      }
      const tenantId = port.shopId;
      const { kind, vehicleId } = parsed.body;
      if (vehicleId !== undefined && !port.vehicles(now).some(v => v.id === vehicleId)) {
        attempt(false, 'bad_vehicle', { tenantId });
        throw new HttpError(400, 'BAD_VEHICLE');
      }
      let publicKey;
      try {
        publicKey = publicKeyText(parsed.body.publicKey);
      } catch {
        attempt(false, 'bad_key', { tenantId });
        throw new HttpError(400, 'BAD_INPUT', { problems: ['publicKey: 모양이 틀렸다'] });
      }
      const cap = AUTH_LIMITS.openEnrollCap;
      const device = port.devices.enrollOpen({
        kind, ...(vehicleId !== undefined ? { vehicleId } : {}), publicKey, label: openDeviceLabel, cap, now, unusedBefore: now - AUTH_LIMITS.openUnusedMs,
      });
      deviceCache.delete(tenantId);
      if (!device) {
        attempt(false, 'open_limit', { tenantId });
        if (now - lastLimitAlertAt > HOUR) {
          lastLimitAlertAt = now;
          log(`ALERT open_enroll_limit ${tenantId} · 열린 기기 ${cap}대(끊은 뒤 다시)`);
        }
        throw new HttpError(409, 'DEVICE_LIMIT');
      }
      attempt(true, 'open', { tenantId, deviceId: device.id });
      log(`ALERT open_enroll ${tenantId} ${device.kind} ${device.shortNo}번 · 열린 기기 ${port.devices.openCount()}/${cap}(시험 매장, SKINOTE_TEST_OPEN_ENROLL)`);
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

    /** 서명을 보고 로그인 표와 직원 타일을 준다. 스스로 붙은 기기면 openDevice(기사 기기의 차량 이름)도. */
    staff(req, res, { body, origin }) {
      const parsed = parseAuthBody('staff', body);
      if (!parsed.ok) throw new HttpError(400, 'BAD_INPUT', { problems: parsed.problems.slice(0, 5) });
      const now = nowMs();
      const found = signedDevice(parsed.body, origin, now);
      const ticket = newToken();
      tickets.set(ticket, { shopId: found.port.shopId, deviceId: found.device.id, expiresAt: now + AUTH_LIMITS.ticketMs });
      const driverDevice = isDriverDevice(found.device.kind);
      const staff = found.port.staff()
        .filter(s => s.accountId !== undefined && control.account(s.accountId)?.status === 'active' && (!driverDevice || s.roleKey === 'driver'))
        .map(s => ({ id: s.id, name: s.name }));
      const vehicleName = found.device.vehicleId ? found.port.vehicles(now).find(v => v.id === found.device.vehicleId)?.name : undefined;
      const openDevice = found.device.openEnrolled ? { openDevice: vehicleName ? { vehicleName } : {} } : {};
      sendJson(req, res, 200, { ticket, shopName: found.port.shopName(now), staff, ...openDevice });
    },

    /** 스스로 붙은 기기가 자기 등록을 끊는다(열린 등록이 켜진 동안만, 로그인과 같은 서명). 기기 · 세션 · 알림 연결이 끝나고 204. */
    openRelease(req, res, { body, origin }) {
      const parsed = parseAuthBody('openRelease', body);
      if (!parsed.ok) throw new HttpError(400, 'BAD_INPUT', { problems: parsed.problems.slice(0, 5) });
      const now = nowMs();
      const found = signedDevice(parsed.body, origin, now);
      if (!found.device.openEnrolled) throw new HttpError(403, 'ENROLL_CLOSED');
      revokeDevice(found.port.shopId, found.device.id, 'open_release', now);
      log(`열린 기기 놓음 ${found.port.shopId} ${found.device.kind} ${found.device.shortNo}번(기기 선택으로)`);
      sendJson(req, res, 204, null);
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
      if (!device || !usable(port, device, now)) {
        tickets.delete(parsed.body.ticket);
        throw new HttpError(401, 'DEVICE_REVOKED');
      }
      const staff = port.staff().find(s => s.id === parsed.body.staffId && s.accountId !== undefined && (!isDriverDevice(device.kind) || s.roleKey === 'driver'));
      const account = staff?.accountId ? control.account(staff.accountId) : undefined;
      if (!staff || !account || account.status !== 'active' || !account.pinHash) throw new HttpError(400, 'UNKNOWN_STAFF');
      const pinHash = account.pinHash;
      const settings = port.authSettings(now);
      const hash = ipHash(req);

      // 스스로 붙은 기기는 잠금 셈에서 모두 한 기기('open:<매장>')다: 기기를 더 붙여 (계정, 기기) 잠금 · 기기 쉼을 피하지 못하게.
      // 확인 자리도 번호 기기와 따로 둔다(열린 기기가 확인을 쥐고 있어도 번호 기기의 진짜 직원이 BUSY를 받지 않게).
      const open = device.openEnrolled;
      const lockId = open ? 'open:' + port.shopId : device.id;
      const pool = open ? openIds(port, now, now - HOUR) : null;
      const accountSlot = (open ? 'open|' : '') + account.id;
      // 한 번에 하나: 이 계정 · 이 기기 · 이 로그인 표의 확인이 도는 동안 온 요청은 맞춰 보지 않는다(셈이 오르기 전에 잠금 확인을 지나지 않게).
      if (checkingAccounts.has(accountSlot) || checkingDevices.has(lockId) || ticket.busy) throw new HttpError(429, 'BUSY');
      const pause = deviceState(lockId, now, pool);
      if (pause.until > now) throw new HttpError(423, 'LOCKED', { lockedUntil: iso(pause.until) });
      const pair = pairState(account.id, lockId, now, settings.lockout, pool);
      if (pair.until > now) {
        tickets.delete(parsed.body.ticket);
        throw new HttpError(423, 'LOCKED', { lockedUntil: iso(pair.until) });
      }
      checkingAccounts.add(accountSlot);
      checkingDevices.add(lockId);
      ticket.busy = true;
      /** @type {boolean} */
      let ok;
      /** @type {number} */
      let at;
      const started = performance.now();
      try {
        // 계정의 늦춤: 열린 기기는 모든 기기의 실패로, 번호 기기는 열린 기기의 실패를 빼고 센다(열린 기기의 추측이 진짜 직원을 늦추지 않게).
        const recent = control.failuresSince({ accountId: account.id, method: 'pin', ...(open ? {} : { notDeviceIds: openIds(port, now, now - HOUR) }) }, now - HOUR);
        if (recent >= AUTH_LIMITS.backoffFrom) await sleep(Math.min(2 ** (recent - AUTH_LIMITS.backoffFrom) * 1000, AUTH_LIMITS.backoffMaxMs));
        ok = await verifyPin(secrets.pinPepper, parsed.body.pin, pinHash);
        at = nowMs();
        if (!ok) {
          // 틀림: 셈을 올린 뒤에야 다음 확인이 돈다(아래 finally 전에 적는다).
          control.recordAttempt({ loginId: account.loginId ?? 'staff', accountId: account.id, tenantId: port.shopId, deviceId: device.id, method: 'pin', succeeded: false, reason: 'bad_password', ipHash: hash, now: at });
          control.loginFailed(account.id, at);
          const dev = deviceState(lockId, at, pool);
          dev.failures.push(at);
          if (dev.failures.length >= AUTH_LIMITS.devicePause.failures) {
            dev.until = at + AUTH_LIMITS.devicePause.pauseMs;
            dev.failures = [];
            log(open
              ? `ALERT open_enroll_pin ${port.shopId} · 열린 기기 모두 비밀번호 로그인 쉼(한 시간 ${AUTH_LIMITS.devicePause.failures}번 틀림)`
              : `기기 비밀번호 로그인 쉼 ${port.shopId} ${device.shortNo}번`);
          }
          const waited = performance.now() - started;
          if (waited < AUTH_LIMITS.failureFloorMs) await sleep(AUTH_LIMITS.failureFloorMs - waited);
        }
      } finally {
        checkingAccounts.delete(accountSlot);
        checkingDevices.delete(lockId);
        ticket.busy = false;
      }
      if (!ok) {
        const n = control.failuresSince({ accountId: account.id, ...deviceFilter(lockId, pool), method: 'pin' }, Math.max(at - AUTH_LIMITS.pairWindowMs, pair.since));
        if (n >= settings.lockout.maxFailures) {
          pair.until = at + settings.lockout.lockMinutes * MINUTE;
          pair.since = pair.until;
          tickets.delete(parsed.body.ticket);
          if (open) log(`ALERT open_enroll_pin ${port.shopId} · 열린 기기에서 한 계정이 ${settings.lockout.maxFailures}번 틀려 잠김`);
          throw new HttpError(423, 'LOCKED', { lockedUntil: iso(pair.until) });
        }
        const dev = deviceState(lockId, at, pool);
        if (dev.until > at) throw new HttpError(423, 'LOCKED', { lockedUntil: iso(dev.until) });
        throw new HttpError(401, 'BAD_PIN');
      }

      // 맞음: 셈을 다시 시작하고, 주어진 쿠키의 세션을 끝내고, 새 세션.
      control.recordAttempt({ loginId: account.loginId ?? 'staff', accountId: account.id, tenantId: port.shopId, deviceId: device.id, method: 'pin', succeeded: true, reason: 'ok', ipHash: hash, now: at });
      control.loginSucceeded(account.id, at);
      pairLocks.delete(account.id + '|' + lockId);
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
    openEnrollStatus,
    cutAtStartup,
    /** 로그인 전 길의 주소마다 제한. @param {'enroll' | 'openEnroll' | 'challenge' | 'login'} kind */
    ipLimit: kind => /** @param {IncomingMessage} req */ req => limiters[kind].take(ipHash(req), nowMs()),
    /** 시험: 지도의 크기. */
    sizes: () => ({ nonces: nonces.size, tickets: tickets.size, pairLocks: pairLocks.size, devicePauses: devicePauses.size }),
  };
}

/** @typedef {ReturnType<typeof createAuth>} Auth */

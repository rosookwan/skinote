// @ts-check
// 기사 기기의 연결 끊김 기록 길(work/impl-offline/plan.md §4 · §6-3, ADR-22).
//   POST /api/v2/snapshot         차량 범위 사본(기사 기기 세션, 쉬는 시간을 늘리지 않음): 사본 · 내용 해시 · 이 기기의 기록(같은 읽기) · 번호 빈 곳.
//                                  같은 해시면 unchanged, 설정은 판이 다를 때만. 온전한 번호를 실은 사본은 개인정보 열람 한 줄(working_copy, 기기 · 차량 ·
//                                  영업일마다 한 줄 + 새 번호가 더해질 때마다 한 줄).
//   POST /api/v2/commands:batch   보냄 대기 묶음(기사 기기 세션 + CSRF): 1~50개, 기기 번호 차례로, 항목마다 한 트랜잭션 · 한 결과. 서명은 받은 그대로의
//                                  항목을 검사 전에 해시해 등록한 기기 열쇠로 본다(skinote-cmd-v1). 나쁜 서명 · 범위 밖은 적용하고 `공급자 확인 중`(ALERT
//                                  줄), 모양이 틀린 항목만 보류. 한 기기에 한 묶음씩(409 BUSY).
//   POST /api/v2/heartbeat        심장 박동(기사 기기 세션, 쉬는 시간을 늘리지 않음): 기기의 알림 → 차량 연결 셈, 답은 머리 · 운영 값.
//   POST /api/v2/device/deliver   세션이 끝난 기기의 전달(세션 없음, 한 번 값 서명 skinote-deliver-v1): 끊은 기기 · 로그아웃한 세션 · 모르는 세션 ·
//                                  오래된 세션의 기록은 보류, 시간이 끝난 세션은 적용, 계정 중지 · 비밀번호 바꿈 뒤의 기록은 적용 + `미확인 로그인`.
// 기록 줄에는 서명 · 봉투 · 본문을 적지 않는다(묶음마다 한 줄 · ALERT 줄은 코드 · 매장 · 기기 · 번호만).
// 세 번째 검토(work/impl-offline/plan.md §17, 2026-09-28):
//   - 받은 때는 항목마다 잰다(R3-2): 묶음이 쉬는 사이 관리자 승인 마감이 먼저 COMMIT하면 그 뒤의 돈은 다음 날에 든다(저장소도 마감 때 아래로 적지 않는다).
//   - 머리의 restoredUpToRev는 매장 파일의 되살린 기준(R3-1): 시험 매장 새로 만들기 · 처음 만들기는 null이라 기기가 옛 기록을 다시 보내지 않는다.
//   - 사본의 대기 업무 id는 거른다(R3-8): 이 차량과 이어진 접수이거나 이 기기에 앞서 보낸 사본의 접수만(서버 메모리, 7일), 기기가 알린 대기 수까지.
//   - 묶음의 차량은 서버가 아는 것만(R3-10): 지금 세션 · 기기 · recordedBy 세션(이 기기 · 이 직원의 세션일 때)의 차량. 업무에 묶인 기록의 차량을 모르면
//     범위 밖. 권한 없음은 공급자 확인 중(돈 · 재고)이나 적지 않음(순서 변경 · 방문 결과 · 긴급 확인).
//   - 개인정보 열람(R3-12): 기기 · 직원 · 차량 · 영업일마다, 사본의 새 접수 수 한 줄과 새 온전한 번호 수 한 줄(`…:full`).
//   - 시각의 범위(R3-13): 기기가 알린 가장 큰 번호의 기록(서버 메모리)보다 큰 번호가 그 알림 전에 일어났다고 하거나, 기록한 세션이 생기기 전에 일어났다고
//     하면 시계 확인.

import { createHash, verify } from 'node:crypto';
import {
  BATCH_LIMITS, DEVICE_LINK, SNAPSHOT_LIMITS, commandMessage, hasRequiredExpect, isDriverDevice, itemHashInput, parseOfflineBody, parseQueuedEnvelope,
  timeSourceOf,
} from '@skinote/contract';
import { fullNumberOrders, vanOrderIds } from '@skinote/domain';
import { HttpError, sendJson } from './http.js';
import { COMMAND_PERMISSIONS } from './permissions.js';
import { CappedMap } from './security.js';

/**
 * @typedef {import('node:http').IncomingMessage} IncomingMessage
 * @typedef {import('node:http').ServerResponse} ServerResponse
 * @typedef {import('./auth.js').SessionContext} SessionContext
 * @typedef {import('./shops.js').ShopPort} ShopPort
 * @typedef {import('./device-links.js').DeviceLinks} DeviceLinks
 * @typedef {import('@skinote/contract').DeviceReport} DeviceReport
 * @typedef {import('@skinote/contract').OfflinePolicy} OfflinePolicy
 * @typedef {import('@skinote/contract').QueuedItemResult} QueuedItemResult
 * @typedef {import('@skinote/contract').QueuedEnvelope} QueuedEnvelope
 * @typedef {import('@skinote/store').Device} Device
 * @typedef {import('@skinote/store').Actor} Actor
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** offline_policy의 기본값(시드와 같게, 설정 행이 없거나 칸이 빠졌을 때). */
export const OFFLINE_POLICY_DEFAULT = Object.freeze({
  pii_wipe_hours: { driver: 24 }, sent_pii_hours: 24, sent_log_days: 7, max_backdate_hours: 168, future_skew_minutes: 5, clock_warn_minutes: 2,
  app_lock_minutes: { driver_phone: 5, driver_tablet: 30 },
});

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
const bounded = (value, fallback, min, max) => (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback);

/**
 * 기사 기기에 알리는 운영 값(매장 설정 offline_policy + 서버 스위치 SKINOTE_DRIVER_LOCAL_FIRST, O2).
 * @param {ShopPort} port @param {{ localFirst: boolean, heartbeatMs?: number }} server @param {'driver_phone' | 'driver_tablet' | string} kind
 * @returns {OfflinePolicy}
 */
export function policyOf(port, server, kind) {
  /** @type {Record<string, any>} */
  let raw = {};
  try {
    raw = /** @type {Record<string, any>} */ (port.offlinePolicy());
  } catch {
    raw = {};
  }
  const lock = raw.app_lock_minutes && typeof raw.app_lock_minutes === 'object' ? raw.app_lock_minutes : OFFLINE_POLICY_DEFAULT.app_lock_minutes;
  const wipe = raw.pii_wipe_hours && typeof raw.pii_wipe_hours === 'object' ? raw.pii_wipe_hours : OFFLINE_POLICY_DEFAULT.pii_wipe_hours;
  const lockDefault = kind === 'driver_tablet' ? OFFLINE_POLICY_DEFAULT.app_lock_minutes.driver_tablet : OFFLINE_POLICY_DEFAULT.app_lock_minutes.driver_phone;
  return {
    localFirst: server.localFirst,
    heartbeatMs: server.heartbeatMs ?? DEVICE_LINK.heartbeatMs,
    piiWipeHours: bounded(wipe.driver, 24, 1, 24 * 14),
    sentPiiHours: bounded(raw.sent_pii_hours, 24, 1, 24 * 14),
    sentLogDays: bounded(raw.sent_log_days, 7, 1, 90),
    appLockMinutes: bounded(lock[kind], lockDefault, 0, 24 * 60),
    maxBackdateHours: bounded(raw.max_backdate_hours, 168, 1, 24 * 60),
    futureSkewMinutes: bounded(raw.future_skew_minutes, 5, 0, 24 * 60),
    clockWarnMinutes: bounded(raw.clock_warn_minutes, 2, 1, 24 * 60),
  };
}

/** 받은 그대로의 항목의 해시(검사 · 정리 전, O5). @param {unknown} item */
export const receivedItemHash = item => createHash('sha256').update(itemHashInput(item), 'utf8').digest('base64url');

/**
 * 보냄 대기 항목의 서명이 이 기기 열쇠의 것인지.
 * @param {Device} device @param {string} origin @param {Record<string, any>} item
 */
export function itemSignatureOk(device, origin, item) {
  const signature = item?.recordedBy?.signature;
  if (typeof signature !== 'string' || !Number.isSafeInteger(item?.deviceSeq)) return false;
  try {
    const message = commandMessage(origin, device.id, item.deviceSeq, receivedItemHash(item));
    return verify('sha256', Buffer.from(message, 'utf8'), { key: JSON.parse(device.publicKey), format: 'jwk', dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * 시각(O8): 일어난 때 = 받은 때 − 나이(max_backdate_hours로 자름), 시각의 출처는 시계 기준의 앞마디, 시계 확인은 증거가 있을 때만(jump- · 7일 밖 ·
 * 만든 때와 clock_warn 넘게 다름 · 같은 묶음의 앞 번호보다 이름 · 기기가 알린 시계 차이가 큼). 서버가 본 사실로도 묶는다(§17 R3-13):
 *   - marks: 이 기기가 알린 가장 큰 번호와 그 알림을 받은 때. 그때 번호가 이 항목보다 작았으면 이 항목은 그 뒤에 만든 것이다: 그보다 이르다고 하면 확인.
 *   - sessionCreatedAt: 기록한 세션(recordedBy)이 생긴 때. 그보다 이르다고 하면 확인.
 * @param {QueuedEnvelope} env @param {number} receivedAt @param {OfflinePolicy} policy @param {DeviceReport} report @param {{ seq: number, occurredAt: number } | undefined} prev
 * @param {{ marks?: readonly { seq: number, at: number }[], sessionCreatedAt?: number }} [seen]
 */
export function timeOf(env, receivedAt, policy, report, prev, seen = {}) {
  const warn = policy.clockWarnMinutes * MINUTE;
  let occurredAt = receivedAt - env.ageMs;
  let suspect = env.clockAnchor.startsWith('jump-');
  const floor = receivedAt - policy.maxBackdateHours * HOUR;
  if (occurredAt < floor) {
    occurredAt = floor;
    suspect = true;
  }
  const made = Date.parse(env.madeAt);
  if (Number.isFinite(made) && Math.abs(made - occurredAt) > warn) suspect = true;
  if (prev && env.deviceSeq > prev.seq && occurredAt < prev.occurredAt - warn) suspect = true;
  if (Math.abs(report.clockOffsetMs) > warn) suspect = true;
  const allocatedAfter = (seen.marks ?? []).filter(m => m.seq < env.deviceSeq).reduce((max, m) => Math.max(max, m.at), Number.NEGATIVE_INFINITY);
  if (occurredAt < allocatedAfter - warn) suspect = true;
  if (seen.sessionCreatedAt !== undefined && occurredAt < seen.sessionCreatedAt - warn) suspect = true;
  return { occurredAt, timeSource: timeSourceOf(env.clockAnchor), suspect };
}

/** 기사 기기 세션의 권한 역할(api.js permissionRole과 같다): 보냄 대기 · 전달은 기사 기기에서만 온다(§18 R4-3). */
const DRIVER_DEVICE_ROLE = 'driver';

/** 범위 밖 · 권한 없음이면 적지 않는 기록(돈 · 재고가 아님: 순서 변경 · 방문 결과 · 긴급 확인, §17 R3-10). */
export const NON_MONEY_QUEUED = new Set(['route.move', 'route.reset', 'task.visit', 'notification.ack']);

/** 기사 기기 세션의 차량(auth.js와 같은 셈): 스스로 붙은 기기는 기사의 차량이 먼저, 번호 기기는 기기의 차량이 먼저. @param {Device} device @param {{ vehicleId?: string }} staff */
const sessionVan = (device, staff) => (device.openEnrolled ? staff.vehicleId ?? device.vehicleId : device.vehicleId ?? staff.vehicleId);

/** 기기 번호 알림 기록을 두는 시간(보낸 기록을 두는 7일보다 조금 길게)과 기기마다 둘 수. */
const MARK_KEEP_MS = 8 * 24 * HOUR;
const MARK_MAX = 64;
/** 이 기기에 보낸 사본의 접수를 기억하는 시간(옮겨진 업무의 대기 항목, §17 R3-8). */
const KNOWN_KEEP_MS = 7 * 24 * HOUR;

/** 항목에서 요청번호 · 명령 · 번호를 읽는다(모양이 틀려도 보류 행을 적을 수 있는지). @param {unknown} item */
function idsOf(item) {
  const o = /** @type {Record<string, unknown>} */ (item && typeof item === 'object' ? item : {});
  return {
    requestId: typeof o.requestId === 'string' && ULID.test(o.requestId) ? o.requestId : undefined,
    type: typeof o.type === 'string' && o.type.length <= 64 ? o.type : undefined,
    deviceSeq: typeof o.deviceSeq === 'number' && Number.isSafeInteger(o.deviceSeq) && o.deviceSeq >= 1 && o.deviceSeq <= 2 ** 31 - 1 ? o.deviceSeq : undefined,
  };
}

/**
 * @param {{
 *   links: DeviceLinks,
 *   nowMs: () => number,
 *   log?: (line: string) => void,
 *   server: { localFirst: boolean, heartbeatMs?: number },
 *   control: import('@skinote/store').ControlStore,
 *   deliverDevice: (body: { deviceId: string, nonce: string, signature: string }, origin: string, now: number) => { port: ShopPort, device: Device },
 *   headOf: (port: ShopPort, now: number) => { epoch: string, rev: number, configRev: number, linkRev: number, businessDate: string, restoredUpToRev?: number | null },
 *   yieldTurn?: () => Promise<void>,
 * }} deps
 */
export function createOffline({ links, nowMs, log = () => {}, server, control, deliverDevice, headOf, yieldTurn = () => new Promise(resolve => setImmediate(resolve)) }) {
  /** 한 기기에 한 묶음 · 전달씩. */
  const busy = new Set();
  /** 사본의 개인정보 열람 기록: 기기 · 직원 · 차량 · 영업일 → 내려 준 접수 · 온전한 번호로 내려 준 접수(서버 메모리, 다시 띄우면 한 줄 더). */
  const copied = new CappedMap(10_000);
  /** 기기마다 앞서 보낸 사본의 접수 → 마지막으로 보낸 때(옮겨진 업무의 대기 항목만 사본에 남기는 근거, §17 R3-8). */
  const sentOrders = new CappedMap(2_000);
  /** 기기마다 알린 가장 큰 번호와 받은 때(시각의 범위, §17 R3-13). */
  const seqMarks = new CappedMap(2_000);

  /** 기기의 번호 알림 하나를 적는다. @param {string} deviceId @param {number} lastSeq @param {number} now */
  const markSeq = (deviceId, lastSeq, now) => {
    /** @type {{ seq: number, at: number }[]} */
    const list = (seqMarks.get(deviceId) ?? []).filter((/** @type {{ at: number }} */ m) => m.at > now - MARK_KEEP_MS);
    const last = list.at(-1);
    if (!last || last.seq !== lastSeq) list.push({ seq: lastSeq, at: now });
    else last.at = Math.max(last.at, now);
    seqMarks.set(deviceId, list.slice(-MARK_MAX));
  };
  /** 기기의 번호 알림 기록(없으면 빈 목록). @param {string} deviceId @returns {{ seq: number, at: number }[]} */
  const marksOf = deviceId => seqMarks.get(deviceId) ?? [];
  /** 이 기기에 보낸 사본의 접수(7일 안). @param {string} deviceId @param {number} now @returns {Set<string>} */
  const knownOrders = (deviceId, now) => {
    /** @type {Map<string, number> | undefined} */
    const seen = sentOrders.get(deviceId);
    return new Set([...(seen ?? new Map()).entries()].filter(([, at]) => at > now - KNOWN_KEEP_MS).map(([id]) => id));
  };
  /** @param {string} deviceId @param {readonly string[]} orderIds @param {number} now */
  const rememberOrders = (deviceId, orderIds, now) => {
    /** @type {Map<string, number>} */
    const seen = sentOrders.get(deviceId) ?? new Map();
    for (const [id, at] of seen) if (at <= now - KNOWN_KEEP_MS) seen.delete(id);
    for (const id of orderIds) seen.set(id, now);
    sentOrders.set(deviceId, seen);
  };

  /** @param {SessionContext | undefined} ctx */
  const driverOnly = ctx => {
    const session = /** @type {SessionContext} */ (ctx);
    if (!isDriverDevice(session.device.kind)) throw new HttpError(403, 'FORBIDDEN');
    return session;
  };

  /** @param {Device} device */
  const linkDevice = device => ({ id: device.id, kind: device.kind, label: device.label, ...(device.vehicleId ? { vehicleId: device.vehicleId } : {}) });

  /** 머리 · 운영 값(심장 박동 · 묶음 · 사본의 공통). @param {ShopPort} port @param {Device} device @param {number} now */
  const headBody = (port, device, now) => {
    const head = headOf(port, now);
    return {
      epoch: head.epoch, rev: head.rev, configRev: head.configRev, linkRev: head.linkRev, serverTime: new Date(now).toISOString(), currentBusinessDate: head.businessDate,
      restoredUpToRev: head.restoredUpToRev ?? null, policy: policyOf(port, server, device.kind),
    };
  };

  /**
   * 보냄 대기 항목 하나(묶음 · 전달의 공통). 보류 · 적용 · 표시를 정하고 저장소에 보낸다.
   * @param {{
   *   port: ShopPort, device: Device, origin: string, item: unknown, now: number, report: DeviceReport, policy: OfflinePolicy,
   *   who: { vehicleId?: string, staffId?: string, staffName?: string },
   *   session?: { hold?: 'session', unverified?: boolean, endedAt?: number },
   *   prev: { seq: number, occurredAt: number } | undefined,
   * }} input
   * @returns {{ result: QueuedItemResult, occurredAt?: number, flagged: boolean, held: boolean }}
   */
  function runItem({ port, device, origin, item, now, report, policy, who, session, prev }) {
    const ids = idsOf(item);
    const reject = (/** @type {string} */ code) => ({
      result: { requestId: ids.requestId ?? '', deviceSeq: ids.deviceSeq ?? 0, outcome: /** @type {const} */ ('rejected'), rev: 0, error: { code, message: '처리 실패 · 재시도 필요' }, reviews: [] },
      flagged: false, held: false,
    });
    if (Buffer.byteLength(JSON.stringify(item ?? null), 'utf8') > BATCH_LIMITS.itemBytes) return reject('BAD_INPUT');
    /** @param {'revoked' | 'malformed' | 'session'} reason @param {QueuedEnvelope} [parsedEnvelope] 읽힌 봉투(지문을 명령의 것으로, §18 R4-9) */
    const hold = (reason, parsedEnvelope) => {
      if (!ids.requestId || !ids.type) return reject('BAD_INPUT');
      const out = port.holdQueued({
        requestId: ids.requestId, type: ids.type, deviceId: device.id, ...(ids.deviceSeq !== undefined ? { deviceSeq: ids.deviceSeq } : {}), reason, envelope: item,
        ...(parsedEnvelope ? { parsed: parsedEnvelope } : {}),
        actorKey: 'device:' + device.id, receivedAt: now,
        ...(typeof /** @type {any} */ (item)?.recordedBy?.signature === 'string' ? { signature: /** @type {any} */ (item).recordedBy.signature.slice(0, 120) } : {}),
      });
      return {
        result: { requestId: ids.requestId, deviceSeq: ids.deviceSeq ?? 0, outcome: out.outcome, rev: out.rev, ...(out.error ? { error: { code: out.error.code, message: out.error.message } } : {}), reviews: out.reviews },
        flagged: false, held: out.outcome === 'held',
      };
    };
    const signed = itemSignatureOk(device, origin, /** @type {any} */ (item));
    const limits = port.limits(now);
    const parsed = parseQueuedEnvelope(item, { maxQuantity: limits.maxQuantity, deviceKind: /** @type {any} */ (device.kind) });
    // 끊은 기기(서버가 본 때로): 보류(O6, sync 7). 읽히는 봉투면 그 지문으로(§18 R4-9).
    if (device.status === 'revoked') return hold('revoked', parsed.ok ? parsed.envelope : undefined);
    if (!parsed.ok) return hold('malformed');
    // 세션 없는 전달: 나쁜 서명은 보류, 세션 규칙(O6).
    if (session && !signed) return hold('malformed', parsed.envelope);
    if (session?.hold) return hold(session.hold, parsed.envelope);
    const env = parsed.envelope;
    const staff = port.staff().find(s => s.id === env.recordedBy.staffId);
    // 기록한 세션(recordedBy.sessionId): 이 기기 · 이 매장 · 이 직원의 세션일 때만 그 차량과 생긴 때를 믿는다(§17 R3-10 · R3-13).
    const recorded = control.session(env.recordedBy.sessionId);
    const ownSession = recorded && recorded.deviceId === device.id && recorded.tenantId === port.shopId && recorded.staffMemberId === env.recordedBy.staffId ? recorded : undefined;
    const time = timeOf(env, now, policy, report, prev, { marks: marksOf(device.id), ...(ownSession ? { sessionCreatedAt: ownSession.createdAt } : {}) });
    const signedIn = port.lastSignIn(device.id, time.occurredAt) === env.recordedBy.staffId;
    const rule = COMMAND_PERMISSIONS[env.type];
    const perm = rule ? (rule.driverPerm !== undefined ? rule.driverPerm : rule.perm) : null;
    // 권한은 온라인 기사 세션과 같은 역할로 본다(api.js permissionRole: 기사 기기의 세션은 직원의 역할과 관계없이 기사 역할, features-1 E13b ·
    // §18 R4-3). 이 길에는 기사 기기만 온다(묶음 driverOnly · 전달 isDriverDevice). 임시 차량을 맡은 카운터 · 관리자도 온라인과 같은 규칙이다.
    // 없으면 공급자 확인 중(돈 · 재고) · 적지 않음(그 밖).
    const permitted = perm === null || port.permissions(DRIVER_DEVICE_ROLE).has(perm);
    const nonMoney = NON_MONEY_QUEUED.has(env.type);
    const late = session?.endedAt !== undefined && time.occurredAt > session.endedAt + policy.futureSkewMinutes * MINUTE;
    const unverified = !staff || !signedIn || session?.unverified === true || late;
    const staffName = staff?.name ?? who.staffName ?? '';
    /** @type {{ kindKey: 'clock_suspect' | 'unverified_sign_in', params: Record<string, string | number> }[]} */
    const reviews = [
      ...(time.suspect ? [{ kindKey: /** @type {const} */ ('clock_suspect'), params: { device: device.label, count: 1 } }] : []),
      ...(unverified ? [{ kindKey: /** @type {const} */ ('unverified_sign_in'), params: { device: device.label, staff: staffName || device.label, count: 1 } }] : []),
    ];
    /** @type {Actor} */
    const actor = {
      key: 'staff:' + (staff ? staff.id : who.staffId ?? env.recordedBy.staffId), name: staffName || device.label, roleKey: 'driver', deviceId: device.id,
      ...(who.vehicleId ? { vehicleId: who.vehicleId } : {}),
    };
    // 차량은 서버가 아는 것만(§17 R3-10): 지금 세션 · 기기 · 기록한 세션(이 기기 · 이 직원일 때)의 차량. 봉투의 직원 행에서 차량을 읽지 않는다.
    const vans = new Set([who.vehicleId, device.vehicleId, ownSession && staff ? sessionVan(device, staff) : undefined].filter(v => typeof v === 'string'));
    /** @param {import('@skinote/store').CommandScope} scope */
    const guard = scope => {
      if (scope.kind !== 'vehicle' || scope.vehicleIds.some(v => vans.has(v))) return null;
      // 업무에 묶인 기록의 차량을 모름(매장만의 접수 · 없는 업무)도 범위 밖이다(온라인 commandGuard와 같다).
      return nonMoney ? { code: /** @type {const} */ ('FORBIDDEN_SCOPE'), supersede: /** @type {const} */ (true) } : { code: /** @type {const} */ ('FORBIDDEN_SCOPE') };
    };
    /** @type {import('@skinote/store').QueuedFlag | undefined} */
    const flag = !permitted
      ? { code: 'FORBIDDEN', ...(nonMoney ? { supersede: /** @type {const} */ (true) } : {}) }
      : !signed ? { code: 'BAD_SIGNATURE' } : undefined;
    const out = port.commandQueued(env, actor, {
      deviceId: device.id, deviceSeq: env.deviceSeq, occurredAt: time.occurredAt, receivedAt: now, timeSource: time.timeSource, signature: env.recordedBy.signature,
      deviceLabel: device.label, ...(who.staffId && who.staffId !== env.recordedBy.staffId ? { submittedByKey: 'staff:' + who.staffId } : {}),
      ...(flag ? { flag } : {}), ...(reviews.length ? { reviews } : {}),
    }, guard);
    const dropped = out.outcome === 'superseded' && (out.error?.code === 'FORBIDDEN_SCOPE' || out.error?.code === 'FORBIDDEN');
    const flagged = !signed || !permitted || dropped || out.reviews.includes('command_held');
    if (flagged) log(`ALERT offline ${!permitted ? 'FORBIDDEN' : !signed ? 'BAD_SIGNATURE' : 'FORBIDDEN_SCOPE'} ${port.shopId} ${device.id} ${env.deviceSeq}`);
    if (!hasRequiredExpect(env.type, env.expect)) log(`ALERT offline EXPECT_MISSING ${port.shopId} ${device.id} ${env.deviceSeq}`);
    return {
      result: {
        requestId: env.requestId, deviceSeq: env.deviceSeq, outcome: out.outcome, rev: out.rev, ...(out.timeSource ? { timeSource: out.timeSource } : {}),
        ...(out.error ? { error: { code: out.error.code, message: out.error.message } } : {}), ...(out.canonical ? { canonical: out.canonical } : {}), reviews: out.reviews,
      },
      occurredAt: time.occurredAt, flagged, held: false,
    };
  }

  /**
   * 항목들을 기기 번호 차례로(같은 요청번호가 묶음 안에 두 번이면 첫 결과). 항목 사이에 다른 요청이 끼어들게 한 번씩 쉰다.
   * @param {unknown[]} items @param {(item: unknown, prev: { seq: number, occurredAt: number } | undefined) => ReturnType<typeof runItem>} each
   */
  async function runAll(items, each) {
    const sorted = items.map((item, i) => ({ item, i, seq: idsOf(item).deviceSeq ?? Number.MAX_SAFE_INTEGER })).sort((a, b) => a.seq - b.seq || a.i - b.i);
    /** @type {Map<string, QueuedItemResult>} */
    const byRequest = new Map();
    /** @type {QueuedItemResult[]} */
    const results = [];
    let prev;
    const counts = { applied: 0, held: 0, flagged: 0 };
    for (const { item } of sorted) {
      const ids = idsOf(item);
      const seen = ids.requestId ? byRequest.get(ids.requestId) : undefined;
      if (seen) {
        results.push(seen);
        continue;
      }
      const done = each(item, prev);
      results.push(done.result);
      if (ids.requestId) byRequest.set(ids.requestId, done.result);
      if (done.occurredAt !== undefined) prev = { seq: done.result.deviceSeq, occurredAt: done.occurredAt };
      if (done.held) counts.held += 1;
      else if (done.result.outcome === 'applied' || done.result.outcome === 'partially_applied') counts.applied += 1;
      if (done.flagged) counts.flagged += 1;
      await yieldTurn();
    }
    return { results, counts };
  }

  /** 한 기기에 한 묶음 · 전달씩. @template T @param {string} deviceId @param {() => Promise<T>} work */
  async function exclusive(deviceId, work) {
    if (busy.has(deviceId)) throw new HttpError(409, 'BUSY');
    busy.add(deviceId);
    try {
      return await work();
    } finally {
      busy.delete(deviceId);
    }
  }

  /** @type {Record<string, (req: IncomingMessage, res: ServerResponse, input: { body?: unknown, origin?: string, ctx?: SessionContext }) => Promise<void> | void>} */
  const handlers = {
    heartbeat(req, res, { body, ctx }) {
      const session = driverOnly(ctx);
      const parsed = parseOfflineBody('heartbeat', body);
      if (!parsed.ok) throw new HttpError(400, 'BAD_INPUT', { problems: parsed.problems.slice(0, 5) });
      const now = nowMs();
      links.report(session.shopId, linkDevice(session.device), parsed.body.report, { now });
      markSeq(session.device.id, parsed.body.report.lastSeq, now);
      sendJson(req, res, 200, { ...headBody(session.port, session.device, now), heartbeatMs: server.heartbeatMs ?? DEVICE_LINK.heartbeatMs });
    },

    snapshot(req, res, { body, ctx }) {
      const session = driverOnly(ctx);
      const parsed = parseOfflineBody('snapshot', body);
      if (!parsed.ok) throw new HttpError(400, 'BAD_INPUT', { problems: parsed.problems.slice(0, 5) });
      const vehicleId = session.who.vehicleId;
      if (!vehicleId) throw new HttpError(403, 'FORBIDDEN');
      const now = nowMs();
      const { port, device, staff } = session;
      links.report(session.shopId, linkDevice(device), parsed.body.report, { now });
      markSeq(device.id, parsed.body.report.lastSeq, now);
      const request = parsed.body;
      // 대기 업무 id는 이 기기에 앞서 보낸 사본의 접수와 기기가 알린 대기 수로 거른다(§17 R3-8).
      const read = port.snapshot(vehicleId, staff.id, device.id, {
        ...request, knownOrderIds: knownOrders(device.id, now), maxPending: parsed.body.report.pendingCount,
      }, now);
      // 기억하는 것은 이 차량과 이어진 접수만(결제로만 · 대기로만 든 접수는 아니다: 위조한 id로 결제 고리를 따라가지 못하게, §17 R3-8).
      rememberOrders(device.id, vanOrderIds(read.scoped, vehicleId), now);
      const unchanged = request.known?.epoch === read.epoch && request.known.hash === read.hash;
      if (!unchanged) {
        // 개인정보 열람(deployment 10-4, §17 R3-12): 기기 · 직원 · 차량 · 영업일마다, 사본에 새로 든 접수(이름 · 가린 번호도 개인정보) 수 한 줄과
        // 새로 든 온전한 번호 수 한 줄(`차량:날짜:full`). 새것이 없는 사본은 적지 않는다.
        const key = device.id + '|' + staff.id + '|' + vehicleId + '|' + read.businessDate;
        /** @type {{ all: Set<string>, full: Set<string> } | undefined} */
        const seen = copied.get(key);
        const fresh = read.scoped.orders.map(o => o.id).filter(id => !seen?.all.has(id));
        const freshFull = fullNumberOrders(read.scoped).filter(id => !seen?.full.has(id));
        const subject = vehicleId + ':' + read.businessDate;
        if (fresh.length > 0) port.logPii({ actorKey: 'staff:' + staff.id, deviceId: device.id, action: 'working_copy', subjectType: 'copy', subjectId: subject, itemCount: fresh.length, now });
        if (freshFull.length > 0) port.logPii({ actorKey: 'staff:' + staff.id, deviceId: device.id, action: 'working_copy', subjectType: 'copy', subjectId: subject + ':full', itemCount: freshFull.length, now });
        if (fresh.length > 0 || freshFull.length > 0) copied.set(key, { all: new Set([...(seen?.all ?? []), ...fresh]), full: new Set([...(seen?.full ?? []), ...freshFull]) });
      }
      const gaps = port.devices.gaps(device.id);
      const head = headOf(port, now);
      sendJson(req, res, 200, {
        ...headBody(port, device, now),
        epoch: read.epoch, rev: read.rev, configRev: read.configRev, linkRev: head.linkRev,
        scope: { vehicleId, businessDate: read.businessDate, cutoff: read.cutoff }, hash: read.hash, unchanged,
        ...(unchanged ? {} : { state: read.scoped }),
        ...(request.known?.configRev === read.configRev ? {} : { config: port.config(now) }),
        recorded: read.recorded.items, recordedMore: read.recorded.more, onlineRecorded: read.onlineRecorded,
        device: { highWater: port.devices.highWater(device.id), missing: gaps.missing },
      });
    },

    async batch(req, res, { body, ctx, origin }) {
      const session = driverOnly(ctx);
      const parsed = parseOfflineBody('batch', body);
      if (!parsed.ok) throw new HttpError(400, 'BAD_INPUT', { problems: parsed.problems.slice(0, 5) });
      const { port, device, staff } = session;
      await exclusive(device.id, async () => {
        const started = Date.now();
        const now = nowMs();
        const report = parsed.body.report;
        links.report(session.shopId, linkDevice(device), report, { now });
        const policy = policyOf(port, server, device.kind);
        const who = { staffId: staff.id, staffName: staff.name, ...(session.who.vehicleId ? { vehicleId: session.who.vehicleId } : {}) };
        // 받은 때는 항목마다(§17 R3-2): 항목 사이에 쉬는 동안 다른 요청(마감)이 COMMIT할 수 있다.
        const { results, counts } = await runAll(parsed.body.commands, (item, prev) => runItem({ port, device, origin: origin ?? '', item, now: nowMs(), report, policy, who, prev }));
        markSeq(device.id, report.lastSeq, now);
        const gaps = port.devices.gaps(device.id);
        log(`batch ${results.length} applied ${counts.applied} held ${counts.held} flagged ${counts.flagged} ${Date.now() - started}ms`);
        sendJson(req, res, 200, {
          ...headBody(port, device, nowMs()), heartbeatMs: server.heartbeatMs ?? DEVICE_LINK.heartbeatMs, results,
          device: { highWater: port.devices.highWater(device.id), missing: gaps.missing },
        });
      });
    },

    async deliver(req, res, { body, origin }) {
      const parsed = parseOfflineBody('deliver', body);
      if (!parsed.ok) throw new HttpError(400, 'BAD_INPUT', { problems: parsed.problems.slice(0, 5) });
      const now = nowMs();
      const { port, device } = deliverDevice(parsed.body, origin ?? '', now);
      if (!isDriverDevice(device.kind)) throw new HttpError(403, 'FORBIDDEN');
      await exclusive(device.id, async () => {
        const report = parsed.body.report;
        links.report(port.shopId, linkDevice(device), report, { session: false, now });
        const policy = policyOf(port, server, device.kind);
        const { results, counts } = await runAll(parsed.body.commands, (item, prev) => {
          const at = nowMs();
          const sessionId = /** @type {any} */ (item)?.recordedBy?.sessionId;
          const s = typeof sessionId === 'string' ? control.session(sessionId) : undefined;
          /** @type {{ hold?: 'session', unverified?: boolean, endedAt?: number }} */
          let rule = {};
          if (!s || s.deviceId !== device.id || s.tenantId !== port.shopId) rule = { hold: 'session' };
          else {
            const endedAt = s.revokedAt ?? Math.min(s.expiresAt, s.lastUsedAt + s.idleTimeoutS * 1000);
            const ended = s.revokedAt !== undefined || endedAt <= at;
            if (ended && s.revokeReason === 'logout') rule = { hold: 'session' };
            else if (ended && endedAt < at - policy.sentLogDays * 24 * HOUR) rule = { hold: 'session' };
            else if (ended && (s.revokeReason === 'staff_inactive' || s.revokeReason === 'pin_reset')) rule = { unverified: true, endedAt };
            else if (ended) rule = { endedAt };
          }
          const who = { ...(device.vehicleId ? { vehicleId: device.vehicleId } : {}), ...(s ? { staffId: s.staffMemberId } : {}) };
          return runItem({ port, device, origin: origin ?? '', item, now: at, report, policy, who, session: rule, prev });
        });
        markSeq(device.id, report.lastSeq, now);
        log(`deliver ${results.length} applied ${counts.applied} held ${counts.held} flagged ${counts.flagged}`);
        const revoked = device.status === 'revoked';
        const gaps = port.devices.gaps(device.id);
        sendJson(req, res, 200, {
          ...headBody(port, device, nowMs()), heartbeatMs: server.heartbeatMs ?? DEVICE_LINK.heartbeatMs, results,
          device: { highWater: port.devices.highWater(device.id), missing: gaps.missing, status: revoked ? 'revoked' : 'active', wipe: revoked },
        });
      });
    },
  };

  return { handlers, busy: () => busy.size };
}

/** 기사 기기 길의 본문 한도(바이트, §4). */
export const OFFLINE_BODY_LIMITS = Object.freeze({
  snapshot: SNAPSHOT_LIMITS.bodyBytes, batch: BATCH_LIMITS.bodyBytes, deliver: BATCH_LIMITS.bodyBytes, heartbeat: 2 * 1024, closingApprove: 1024,
});

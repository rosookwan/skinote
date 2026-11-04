// @ts-check
// 매장마다의 저장소 창구(ShopPort, plan §5-4). API · 로그인 · 관리 소켓은 이 모양만 보고, 실제 표 · 도메인은 여기서만 만난다:
//   - 저장소(@skinote/store의 ShopStore): 명령 트랜잭션, 상태(캐시), 기기 행, 직원, 역할 권한. SQL은 저장소에만 있다.
//   - 도메인(@skinote/domain): 읽기 모델(ledgerView · runQuery), 운영 문구(PRODUCTION_LINES).
//   - 화면 설정(config): 코드의 기본 설정(defaultUiConfig) + 매장 이름 · 시간대, configRev는 shops.config_rev(plan §0).
// 시험은 같은 모양의 가짜(test/fake-store.js)를 넣어 권한 · 범위 표를 본다.
//
// 쓰는 사람 잠금(D4): 서버는 시작할 때 설정한 매장마다 `<자료 폴더>/locks/<매장>.writer`를 잡고 끝날 때까지 쥔다. 하나라도 다른
// 프로세스(다른 서버 · 명령줄의 매장 만들기)가 쥐고 있으면 시작하지 않는다(WRITER_LOCKED): 한 매장 파일에 쓰는 사람은 하나다.
//
// 명령은 도메인의 execute(새 접수 id는 접수 번호에서: 'dated')로 돌고, 저장소가 앞뒤 상태를 표에 적는다(접수 · 재고 · 돈 · 보증금 ·
// 차량 업무 · 차량 현금 · 마감 · 운영 규칙). 명령의 범위(commandScope) · 충돌 키(conflictKeys) · 조회 범위(queryScope)도 도메인이 정한다.

import { createHash } from 'node:crypto';
import { defaultUiConfig, SNAPSHOT_LIMITS } from '@skinote/contract';
import { PRODUCTION_LINES, allowedPendingTaskIds, ledgerView, orderIdOfTask, queryScope, runQuery, vehicleScope } from '@skinote/domain';
import { acquireWriterLock, canonicalJson, currentSetting, logPiiAccess, openShopStore } from '@skinote/store';

/**
 * @typedef {import('@skinote/store').ShopStore} ShopStore
 * @typedef {import('@skinote/store').ShopHead} ShopHead
 * @typedef {import('@skinote/store').StaffRow} StaffRow
 * @typedef {import('@skinote/store').DeviceRows} DeviceRows
 * @typedef {import('@skinote/store').Actor} Actor
 * @typedef {import('@skinote/store').Guard} Guard
 * @typedef {import('@skinote/store').StoreOutcome} StoreOutcome
 * @typedef {import('@skinote/store').WriterLock} WriterLock
 * @typedef {import('@skinote/contract').AnyCommandEnvelope} AnyCommandEnvelope
 * @typedef {import('@skinote/contract').UiConfig} UiConfig
 * @typedef {import('@skinote/contract').ViewParams} ViewParams
 * @typedef {import('@skinote/contract').LedgerViewResult} LedgerViewResult
 * @typedef {import('@skinote/contract').QueryName} QueryName
 * @typedef {import('./config.js').ServerConfig} ServerConfig
 * @typedef {import('./databases.js').DatabaseEntry} DatabaseEntry
 * @typedef {import('./secrets.js').Secrets} Secrets
 * @typedef {{ kind: 'shop' } | { kind: 'vehicle', vehicleIds: string[] }} QueryScope
 * @typedef {{
 *   viewer?: { roleKey: string, permissions: readonly string[], staffId?: string, limits?: { maxDiscountAmount?: number, maxDiscountPercentBp?: number } },
 *   deviceId?: string,
 *   vehicleLinks?: import('@skinote/contract').VehicleLink[],
 *   deviceGaps?: import('@skinote/contract').DeviceGap[],
 *   heldCounts?: { deviceId: string, label: string, revoked: number, held: number, flagged: number }[],
 * }} QueryReader
 *   누가 묻나(세션의 역할 권한 · 직원 id · 기기): 읽기 모델이 막힌 것을 회색으로 그리고, 매장 설정 `차량 · 직원`이 직원이 쓴 기기를 싣는다. 카운터는
 *   차량 연결 · 번호 빈 곳 · 보류 수(work/impl-offline/plan.md §5-6)도 받는다.
 * @typedef {{
 *   epoch: string, rev: number, configRev: number, businessDate: string, cutoff: string, scoped: import('@skinote/domain').ShopState, hash: string,
 *   recorded: { items: import('@skinote/store').RecordedRow[], more: boolean }, onlineRecorded: { requestId: string, outcome: string, rev: number }[],
 *   pendingTaskIds: string[],
 * }} SnapshotRead
 *   기사 기기의 사본(O4): 차량 범위 상태 · 그 내용 해시(rev 뺌) · 이 기기의 기록(같은 읽기) · 사본에 남긴 보냄 대기 업무 id(거른 것, §17 R3-8).
 * @typedef {{
 *   cutoff: string,
 *   idleMinutes: { counter: number, driver: number },
 *   lockout: { maxFailures: number, lockMinutes: number },
 * }} AuthSettings
 * @typedef {{
 *   shopId: string,
 *   head(now: number): ShopHead,
 *   restoredUpToRev?: () => number | null,
 *   shopName(now: number): string,
 *   staff(): StaffRow[],
 *   permissions(roleKey: string): Map<string, string>,
 *   roleLimits(roleKey: string): { maxDiscountAmount?: number, maxDiscountPercentBp?: number },
 *   setRoleLimits(roleKey: string, limits: { maxDiscountAmount?: number, maxDiscountPercentBp?: number } | null): boolean,
 *   devices: DeviceRows,
 *   isTest(): boolean,
 *   vehicles(now: number): { id: string, name: string }[],
 *   authSettings(now: number): AuthSettings,
 *   limits(now: number): { maxQuantity: number },
 *   orderCount(now: number): number,
 *   config(now: number): UiConfig,
 *   ledgerView(viewKey: string, params: ViewParams, now: number, reader?: QueryReader): LedgerViewResult,
 *   query(name: QueryName, params: unknown, now: number, reader?: QueryReader): unknown,
 *   queryScope(name: string, params: unknown, now: number): QueryScope | null,
 *   command(envelope: AnyCommandEnvelope, actor: Actor, now: number, guard?: Guard, prepare?: import('@skinote/store').Prepare): StoreOutcome,
 *   commandQueued(envelope: AnyCommandEnvelope, actor: Actor, meta: import('@skinote/store').QueuedMeta, guard?: import('@skinote/store').QueuedGuard): import('@skinote/store').QueuedOutcome,
 *   holdQueued(input: import('@skinote/store').HeldInput): import('@skinote/store').QueuedOutcome,
 *   listHeld(): import('@skinote/store').HeldRow[],
 *   heldEnvelope(requestId: string): { envelope: unknown, deviceId?: string, deviceSeq?: number, receivedAt: number } | undefined,
 *   releaseHeld(envelope: AnyCommandEnvelope, actor: Actor, meta: import('@skinote/store').QueuedMeta): import('@skinote/store').QueuedOutcome,
 *   dismissHeld(requestId: string, now: number): boolean,
 *   snapshot(vehicleId: string, staffId: string, deviceId: string, request: { fromSeq: number, pendingTaskIds: readonly string[], onlinePending: readonly string[], knownOrderIds?: ReadonlySet<string>, maxPending?: number }, now: number): SnapshotRead,
 *   lastSignIn(deviceId: string, at: number): string | undefined,
 *   offlinePolicy(): Record<string, unknown>,
 *   logPii(entry: import('@skinote/store').PiiAccess): void,
 * }} ShopPort
 *   logPii: 개인정보 열람 한 번(전화 창의 온전한 번호 · 수거 목록 인쇄 · 기사 기기의 사본, features-1 E16 · E17, O4).
 *   commandQueued · holdQueued · snapshot · lastSignIn · offlinePolicy: 기사 기기의 연결 끊김 기록(work/impl-offline/plan.md §6-3).
 *   restoredUpToRev: 되살린 epoch의 기준 rev(아니면 null, 기사 기기가 옛 epoch의 기록을 다시 보낼지, §17 R3-1).
 */

/** sys_setting_definitions의 기본값(매장 설정 행이 없을 때). */
export const SESSION_IDLE_DEFAULT = Object.freeze({ counter: 480, driver: 20160 });
export const LOGIN_LOCKOUT_DEFAULT = Object.freeze({ maxFailures: 5, lockMinutes: 10 });

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
const bounded = (value, fallback, min, max) => (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback);

/**
 * 매장 파일 하나(마이그레이션해서 연 쓰기 연결)의 창구.
 * @param {{ db: NonNullable<DatabaseEntry['db']>, shopId: string }} entry
 * @param {{ secrets: Secrets, onCommit?: (head: ShopHead) => void, log?: (line: string) => void }} options
 * @returns {ShopPort}
 */
export function openShopPort(entry, { secrets, onCommit, log }) {
  const { db, shopId } = entry;
  const store = openShopStore(/** @type {any} */ (db), shopId, {
    secrets: { fingerprintKey: secrets.fingerprintKey },
    orderIds: 'dated',
    lines: PRODUCTION_LINES,
    ...(onCommit ? { onCommit } : {}),
    ...(log ? { log } : {}),
  });
  /** @param {number} now @param {QueryReader} [reader] */
  const readContext = (now, reader) => ({
    config: config(now), now, lines: PRODUCTION_LINES, ...(reader?.viewer ? { viewer: reader.viewer } : {}),
    ...(reader?.vehicleLinks ? { vehicleLinks: reader.vehicleLinks } : {}), ...(reader?.deviceGaps ? { deviceGaps: reader.deviceGaps } : {}),
    ...(reader?.heldCounts ? { heldCounts: reader.heldCounts } : {}),
  });
  /** 차량 범위 사본의 캐시(직원 행 없는 몫: 차량 · rev · 영업일 · 대기 업무, O4 · R2 18). @type {Map<string, import('@skinote/domain').ShopState>} */
  const scopeCache = new Map();
  /**
   * 직원이 마지막으로 로그인한 기기(매장 설정 `차량 · 직원`의 `기기 막기`). 묻는 기기 자신은 뺀다(자기 기기를 막아 로그인을 잃지 않게).
   * @param {string | undefined} askingDevice
   */
  const staffDevices = askingDevice => Object.fromEntries([...store.devices.lastUsers()].map(([staffId, list]) => [staffId, list.filter(d => d.id !== askingDevice)]));
  /** @param {number} now @returns {UiConfig} */
  const config = now => {
    const state = store.state(now);
    return { ...defaultUiConfig({ shopName: state.registry.shopName, timezone: state.registry.timezone }), configRev: store.head(now).configRev };
  };
  return {
    shopId,
    head: now => store.head(now),
    restoredUpToRev: () => store.restoredUpToRev(),
    shopName: now => store.state(now).registry.shopName,
    staff: () => store.staff(),
    permissions: roleKey => store.permissions(roleKey),
    roleLimits: roleKey => store.roleLimits(roleKey),
    setRoleLimits: (roleKey, limits) => store.setRoleLimits(roleKey, limits),
    devices: store.devices,
    // 시험 매장인지(shops.is_test)와 쓰는 차량(열린 기기 등록의 차량 고르기: id와 이름만).
    isTest: () => store.isTest(),
    vehicles: now => store.state(now).registry.vehicles.map(v => ({ id: v.id, name: v.label })),
    authSettings(now) {
      const idle = currentSetting(/** @type {any} */ (db), shopId, 'session_idle_minutes') ?? {};
      const lockout = currentSetting(/** @type {any} */ (db), shopId, 'login_lockout') ?? {};
      return {
        cutoff: store.state(now).settings.businessDayCutoff,
        idleMinutes: {
          counter: bounded(idle.counter, SESSION_IDLE_DEFAULT.counter, 5, 7 * 24 * 60),
          driver: bounded(idle.driver, SESSION_IDLE_DEFAULT.driver, 5, 60 * 24 * 60),
        },
        lockout: {
          maxFailures: bounded(lockout.max_failures, LOGIN_LOCKOUT_DEFAULT.maxFailures, 3, 20),
          lockMinutes: bounded(lockout.lock_minutes, LOGIN_LOCKOUT_DEFAULT.lockMinutes, 1, 24 * 60),
        },
      };
    },
    limits: now => ({ maxQuantity: store.state(now).registry.maxLineQuantity }),
    orderCount: now => store.state(now).orders.length,
    config,
    ledgerView: (viewKey, params, now, reader) => ledgerView(store.state(now), viewKey, params, readContext(now, reader)),
    query: (name, params, now, reader) => runQuery(store.state(now), name, /** @type {any} */ (params), {
      ...readContext(now, reader), ...(name === 'shopSettings' ? { staffDevices: staffDevices(reader?.deviceId) } : {}),
    }),
    // 기사 세션의 업무 · 접수 조회가 닿는 차량(없는 업무 · 접수는 null: 기사 세션은 거절, permissions.js).
    queryScope: (name, params, now) => queryScope(store.state(now), /** @type {any} */ (name), params),
    command: (envelope, actor, now, guard, prepare) => store.command(envelope, actor, now, guard, prepare),
    commandQueued: (envelope, actor, meta, guard) => store.commandQueued(envelope, actor, meta, guard),
    holdQueued: input => store.holdQueued(input),
    listHeld: () => store.listHeld(),
    heldEnvelope: requestId => store.heldEnvelope(requestId),
    releaseHeld: (envelope, actor, meta) => store.releaseHeld(envelope, actor, meta),
    dismissHeld: (requestId, now) => store.dismissHeld(requestId, now),
    snapshot(vehicleId, staffId, deviceId, request, now) {
      // 상태 · 기록을 한 번의 동기 읽기로(사이에 await 없음): 기록(recorded)에 든 요청번호는 이 사본에 들어 있다(O4).
      const state = store.state(now);
      const head = store.head(now);
      // 기기가 보낸 대기 업무 id는 거른다(§17 R3-8): 이 차량과 이어진 접수 · 이 기기에 앞서 보낸 사본의 접수만, 기기가 알린 대기 수까지.
      const pending = allowedPendingTaskIds(state, vehicleId, request.pendingTaskIds, request.knownOrderIds)
        .slice(0, Math.max(0, request.maxPending ?? request.pendingTaskIds.length));
      const pendingKey = createHash('sha256').update([...pending].sort().join('|')).digest('base64url').slice(0, 16);
      const cacheKey = vehicleId + '|' + head.rev + '|' + state.businessDate + '|' + state.epoch + '|' + pendingKey;
      let bare = scopeCache.get(cacheKey);
      if (!bare) {
        // 이미 거른 id라 knownOrderIds 없이 다시 거르면 옮겨진 접수가 빠진다: 거른 id의 접수를 그대로 알린다.
        bare = vehicleScope(state, vehicleId, { pendingTaskIds: pending, knownOrderIds: new Set(pending.map(orderIdOfTask)) });
        if (scopeCache.size >= 16) scopeCache.delete(/** @type {string} */ (scopeCache.keys().next().value));
        scopeCache.set(cacheKey, bare);
      }
      const scoped = { ...bare, staff: (state.staff ?? []).filter(x => x.id === staffId).map(x => ({ ...x })) };
      const hash = createHash('sha256').update(canonicalJson({ ...scoped, rev: 0 }), 'utf8').digest('base64url');
      const recorded = store.devices.recorded(deviceId, request.fromSeq, SNAPSHOT_LIMITS.recorded);
      const onlineRecorded = store.devices.onlineRecorded(deviceId, request.onlinePending);
      return {
        epoch: head.epoch, rev: head.rev, configRev: head.configRev, businessDate: state.businessDate, cutoff: state.settings.businessDayCutoff, scoped, hash, recorded, onlineRecorded,
        pendingTaskIds: pending,
      };
    },
    lastSignIn: (deviceId, at) => store.devices.lastSignIn(deviceId, at),
    offlinePolicy: () => currentSetting(/** @type {any} */ (db), shopId, 'offline_policy') ?? {},
    logPii: entry => { logPiiAccess(/** @type {any} */ (db), shopId, entry); },
  };
}

/** 쓰는 사람 잠금을 쥔 프로세스가 있어 시작하지 않음. */
export class WriterLockedError extends Error {
  /** @param {string[]} shopIds */
  constructor(shopIds) {
    super(`다른 프로세스가 매장 파일을 쓰는 중입니다(${shopIds.join(', ')}): 다른 서버나 명령줄(provision · load-sample)이 끝난 뒤 시작합니다`);
    this.name = 'WriterLockedError';
    this.code = 'WRITER_LOCKED';
    this.shopIds = shopIds;
  }
}

/**
 * 설정한 매장 모두의 쓰는 사람 잠금을 잡는다. 하나라도 못 잡으면 잡은 것을 놓고 WriterLockedError.
 * @param {ServerConfig} config
 * @returns {Map<string, WriterLock>}
 */
export function acquireShopLocks(config) {
  /** @type {Map<string, WriterLock>} */
  const locks = new Map();
  /** @type {string[]} */
  const held = [];
  for (const shopId of config.shopIds) {
    const lock = acquireWriterLock(config.dataDir, shopId);
    if (lock) locks.set(shopId, lock);
    else held.push(shopId);
  }
  if (held.length) {
    releaseShopLocks(locks);
    throw new WriterLockedError(held);
  }
  return locks;
}

/** @param {Map<string, WriterLock>} locks */
export function releaseShopLocks(locks) {
  for (const lock of locks.values()) {
    try {
      lock.release();
    } catch {
      /* 이미 놓음 */
    }
  }
  locks.clear();
}

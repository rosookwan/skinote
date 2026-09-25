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

import { defaultUiConfig } from '@skinote/contract';
import { PRODUCTION_LINES, ledgerView, queryScope, runQuery } from '@skinote/domain';
import { acquireWriterLock, currentSetting, openShopStore } from '@skinote/store';

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
 *   cutoff: string,
 *   idleMinutes: { counter: number, driver: number },
 *   lockout: { maxFailures: number, lockMinutes: number },
 * }} AuthSettings
 * @typedef {{
 *   shopId: string,
 *   head(now: number): ShopHead,
 *   shopName(now: number): string,
 *   staff(): StaffRow[],
 *   permissions(roleKey: string): Map<string, string>,
 *   devices: DeviceRows,
 *   authSettings(now: number): AuthSettings,
 *   limits(now: number): { maxQuantity: number },
 *   orderCount(now: number): number,
 *   config(now: number): UiConfig,
 *   ledgerView(viewKey: string, params: ViewParams, now: number): LedgerViewResult,
 *   query(name: QueryName, params: unknown, now: number): unknown,
 *   queryScope(name: string, params: unknown, now: number): QueryScope | null,
 *   command(envelope: AnyCommandEnvelope, actor: Actor, now: number, guard?: Guard): StoreOutcome,
 * }} ShopPort
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
  /** @param {number} now */
  const readContext = now => ({ config: config(now), now, lines: PRODUCTION_LINES });
  /** @param {number} now @returns {UiConfig} */
  const config = now => {
    const state = store.state(now);
    return { ...defaultUiConfig({ shopName: state.registry.shopName, timezone: state.registry.timezone }), configRev: store.head(now).configRev };
  };
  return {
    shopId,
    head: now => store.head(now),
    shopName: now => store.state(now).registry.shopName,
    staff: () => store.staff(),
    permissions: roleKey => store.permissions(roleKey),
    devices: store.devices,
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
    ledgerView: (viewKey, params, now) => ledgerView(store.state(now), viewKey, params, readContext(now)),
    query: (name, params, now) => runQuery(store.state(now), name, /** @type {any} */ (params), readContext(now)),
    // 기사 세션의 업무 · 접수 조회가 닿는 차량(없는 업무 · 접수는 null: 기사 세션은 거절, permissions.js).
    queryScope: (name, params, now) => queryScope(store.state(now), /** @type {any} */ (name), params),
    command: (envelope, actor, now, guard) => store.command(envelope, actor, now, guard),
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

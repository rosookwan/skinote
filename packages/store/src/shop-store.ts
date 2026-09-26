// 매장 하나의 저장소(plan §4-1 · §4-4 · §4-5). 서버는 매장마다 하나를 열고(쓰는 사람 잠금과 함께) 읽기 모델과 명령을 모두 여기로 보낸다.
//
// 명령 트랜잭션(sync 1을 줄인 것):
//   BEGIN IMMEDIATE → 이 파일이 그 매장인지 → command_log로 멱등(같은 요청번호: 끝난 결과는 그대로, 지문이 다르면 첫 결과 +
//   idempotencyMismatch + integrity_findings, 재시도할 거절 · 멈춤은 다시 판단) → 상태(캐시 또는 읽기) → 서버의 권한 확인(guard) →
//   의도 명령의 충돌(intent_marks) → execute → 적용이면 rev + 1 · 행 쓰기 · 의도 표시 · change_log · events(+ event_pii) · rev 셈 →
//   command_log → COMMIT → 알림(epoch · rev · configRev).
// 도중에 무엇이든 던지면 되돌리고 캐시를 버린 뒤, 작은 트랜잭션으로 command_log에 rejected INTERNAL(retryable)을 남긴다. 같은 요청번호가
// 다시 오면 처음부터 다시 판단한다. 명령은 BEGIN부터 COMMIT까지 await 없이 한 번에 돈다: 한 매장의 명령은 짜임새로 한 줄로 선다(D4).
import type { AnyCommandEnvelope, CommandOutcome } from '@skinote/contract';
import {
  commandScope as domainCommandScope, conflictKeys as domainConflictKeys, execute as domainExecute, linesOf, type CommandScope, type DomainLines, type ExecContext,
  type Execute, type ShopSpec, type ShopState,
} from '@skinote/domain';
import { StoreError } from './errors.ts';
import { all, num, one, run, str, type Db } from './db.ts';
import { businessDateAt, ensureBusinessDay } from './dates.ts';
import { deviceRows, type DeviceRows } from './devices.ts';
import { appendChanges, appendEvent, eventClass, fingerprintOf, intentConflict, isFinal, markIntents, readLog, recordFinding, shopFingerprintKey, splitPii, writeLog, type LogRow } from './journal.ts';
import { loadShopState, readHead, readRev, type ShopHead } from './load.ts';
import { provision as provisionShop, type ProvisionOptions, type ProvisionResult } from './provision.ts';
import { listStaff, rolePermissions, type StaffRow } from './registry-read.ts';
import { raiseReceiptCounter, writeState } from './write.ts';
import { isoOf } from './ids.ts';

/** 명령을 한 사람(세션에서, 봉투에서가 아니다). key = 'staff:<staff_members.id>'. */
export interface Actor {
  key: string;
  name: string;
  deviceId?: string;
  vehicleId?: string;
  roleKey?: string;
}

/** 명령이 닿는 범위(도메인 commandScope). 서버의 권한 확인(guard)이 기사 세션의 '자기 차량'을 본다. */
export type { CommandScope } from '@skinote/domain';
/** 서버의 권한 확인: 거절이면 결과(FORBIDDEN · FORBIDDEN_SCOPE), 괜찮으면 null. 멱등 확인 뒤에 부른다(이미 적용한 재전송은 누가 보내도 저장한 결과). */
export type Guard = (scope: CommandScope) => CommandOutcome | null;

/** 시험의 고장 고리: 이름 붙은 단계에서 한 번 던진다. 운영 코드는 넣지 않는다. */
export type FaultPhase = 'load' | 'execute' | 'write' | 'journal' | 'commit' | 'after_commit';
export type FaultHook = (phase: FaultPhase, envelope: AnyCommandEnvelope) => void;

/** 가져올 하루(load-sample): 그 날짜와 더할 접수 · 고정 · 보증금 · 결제 자리. 접수 번호는 그 날짜의 것이다. */
export interface ImportDay {
  date: string;
  orders: ShopState['orders'];
  pins: ShopState['pins'];
  deposits: ShopState['deposits'];
  paymentGroups: ShopState['paymentGroups'];
}

/** 가져오기의 작업 기록 종류(sys_event_types: engine import). */
const IMPORT_EVENT = 'legacy.imported';

/** 명령 결과 + 같은 요청번호의 다른 본문(첫 결과를 돌려주며 표시). */
export type StoreOutcome = CommandOutcome & { idempotencyMismatch?: true };

export interface ShopStoreOptions {
  /** SKINOTE_FINGERPRINT_KEY(32바이트). 매장마다 HKDF로 나눠 쓴다. */
  secrets: { fingerprintKey: Uint8Array };
  /** 명령 실행(없으면 도메인의 execute). 시험이 고장 · 다른 실행을 넣는다. */
  execute?: Execute;
  /** 새 접수 id의 모양(도메인 ApplyOptions): 서버 장부는 'dated'(날짜가 여럿이라 겹치지 않게, 기본). */
  orderIds?: 'sequence' | 'dated';
  /** 명령이 닿는 범위(없으면 도메인의 commandScope). */
  commandScope?: (state: ShopState, envelope: AnyCommandEnvelope) => CommandScope;
  /** 충돌 키(없으면 도메인의 conflictKeys, D12). null이면 의도 표시를 쓰지 않고 충돌도 보지 않는다. */
  conflictKeys?: ((state: ShopState, envelope: AnyCommandEnvelope) => { writes: string[]; reads: string[] }) | null;
  /** 거절 · 실패 한 줄(없으면 운영 문구). */
  lines?: DomainLines;
  /** COMMIT 뒤(SSE 알림). */
  onCommit?: (head: ShopHead) => void;
  /** 2초 넘은 명령 · 처리 오류의 기록 줄(본문 없이). */
  log?: (line: string) => void;
  fault?: FaultHook;
}

export interface ShopStore {
  readonly shopId: string;
  head(now: number): ShopHead;
  /** 이 시각의 도메인 상태(캐시: rev와 영업일이 같으면 다시 읽지 않는다). 읽기 전용으로 쓴다. */
  state(now: number): ShopState;
  command(envelope: AnyCommandEnvelope, actor: Actor, now: number, guard?: Guard): StoreOutcome;
  /** 빈 매장 파일에 매장을 만든다(§4-6). */
  provision(spec: ShopSpec, now: number, options: ProvisionOptions): ProvisionResult;
  /**
   * 하루치 자료를 넣는다(시험 매장만, §4-6 load-sample): 지금 상태에 day의 접수 · 고정 · 보증금 · 결제 자리를 더한 것을 명령처럼 한 rev로
   * 적는다. 같은 요청번호가 이미 있으면 적지 않고 replay.
   */
  importDay(day: ImportDay, requestId: string, now: number, actor: Actor): { orders: number; replay: boolean; rev: number };
  readonly devices: DeviceRows;
  /** 시험 매장인지(shops.is_test): 견본 불러오기 · 열린 기기 등록(SKINOTE_TEST_OPEN_ENROLL)은 시험 매장에만 된다. */
  isTest(): boolean;
  staff(): StaffRow[];
  permissions(roleKey: string): Map<string, string>;
  /** 캐시를 버린다(시험 · 다른 연결이 쓴 뒤). */
  dropCache(): void;
}

/** 명령의 주된 대상(events.aggregate_*): 본문의 접수 · 업무 · 차량 · 마감일, 규칙 저장은 매장. */
function aggregateOf(envelope: AnyCommandEnvelope, shopId: string): { type?: string; id?: string } {
  const p = envelope.payload as Record<string, unknown>;
  if (envelope.type === 'setting.set') return { type: 'shop', id: shopId };
  if (envelope.type === 'closing.close' && typeof p.date === 'string') return { type: 'closing', id: p.date };
  if (typeof p.orderId === 'string') return { type: 'order', id: p.orderId };
  if (typeof p.taskId === 'string') return { type: 'task', id: p.taskId };
  if (typeof p.vehicleId === 'string') return { type: 'vehicle', id: p.vehicleId };
  return {};
}

const SLOW_MS = 2_000;

export function openShopStore(db: Db, shopId: string, options: ShopStoreOptions): ShopStore {
  const key = shopFingerprintKey(options.secrets.fingerprintKey, shopId);
  const lines = linesOf(options);
  const execute = options.execute ?? domainExecute;
  const scopeOf = options.commandScope ?? domainCommandScope;
  const keysOf = options.conflictKeys === null ? undefined : options.conflictKeys ?? domainConflictKeys;
  let cache: { rev: number; businessDate: string; state: ShopState } | undefined;
  let busy = false;

  const guardBusy = () => {
    if (busy) throw new StoreError('REENTRANT', '한 매장의 트랜잭션 안에서 또 트랜잭션');
  };

  const load = (now: number): ShopState => {
    const rev = readRev(db, shopId);
    const businessDate = businessDateAt(db, shopId, now);
    if (cache && cache.rev === rev && cache.businessDate === businessDate) return cache.state;
    const state = loadShopState(db, shopId, now);
    cache = { rev, businessDate, state };
    return state;
  };

  /** 이 파일이 부른 매장인지(deployment 2-5). */
  const checkShop = () => {
    const ids = all(db, 'SELECT id FROM shops').map((r) => str(r.id));
    if (ids.length === 0) throw new StoreError('SHOP_NOT_PROVISIONED', '매장 파일에 매장이 없다');
    if (ids.length !== 1 || ids[0] !== shopId) throw new StoreError('SHOP_MISMATCH', '다른 매장의 파일이다');
  };

  const nextRev = (): number => {
    const floor = num(one(db, 'SELECT rev_floor FROM shop_instance WHERE shop_id = ?', shopId)?.rev_floor);
    return Math.max(readRev(db, shopId), floor) + 1;
  };

  function command(envelope: AnyCommandEnvelope, actor: Actor, now: number, guard?: Guard): StoreOutcome {
    guardBusy();
    busy = true;
    const started = Date.now();
    let open = false;
    // COMMIT 뒤에는 무슨 일이 있어도 적은 결과를 돌려준다(적용한 명령의 command_log를 INTERNAL로 덮지 않는다).
    let committed = false;
    let committedOutcome: CommandOutcome | undefined;
    let existing: LogRow | undefined;
    const fingerprint = fingerprintOf(key, envelope);
    const base = { requestId: envelope.requestId, asOfRev: envelope.basis.rev, rebased: false, changes: [] };
    const finish = (outcome: CommandOutcome, retryable: boolean, appliedRev?: number) =>
      writeLog(db, shopId, {
        requestId: envelope.requestId, actorKey: actor.key, deviceId: actor.deviceId, type: envelope.type, commandVersion: envelope.commandVersion, fingerprint,
        outcome, retryable, appliedRev, basis: envelope.basis, dependsOn: envelope.dependsOn, now,
      }, existing);
    try {
      db.exec('BEGIN IMMEDIATE');
      open = true;
      checkShop();
      existing = readLog(db, shopId, envelope.requestId);
      if (existing) {
        // 결과 글을 보관 기간 뒤에 지운 줄은 상태 · 적용 rev로 다시 만든다(다시 적용하지 않는다).
        const stored = (log: LogRow): CommandOutcome => log.result ?? {
          ...base, outcome: log.status, rev: log.appliedRev ?? readRev(db, shopId), epoch: readHead(db, shopId, now).epoch,
          ...(log.errorCode ? { error: { code: log.errorCode, message: lines.failed } } : {}),
        };
        if (existing.fingerprint !== fingerprint) {
          recordFinding(db, shopId, { checkKey: 'idempotency_mismatch', entityType: 'command_log', entityId: envelope.requestId, expected: existing.fingerprint, actual: fingerprint, now });
          const first = stored(existing);
          db.exec('COMMIT');
          open = false;
          return { ...first, idempotencyMismatch: true };
        }
        if (isFinal(existing)) {
          const first = stored(existing);
          db.exec('ROLLBACK');
          open = false;
          return first;
        }
      }
      options.fault?.('load', envelope);
      const before = load(now);
      const head = { epoch: before.epoch, rev: readRev(db, shopId) };

      if (guard) {
        const refusal = guard(scopeOf(before, envelope));
        if (refusal) {
          const outcome: CommandOutcome = { ...base, ...refusal, requestId: envelope.requestId, rev: head.rev, epoch: head.epoch, outcome: 'rejected' };
          finish(outcome, false);
          db.exec('COMMIT');
          open = false;
          return outcome;
        }
      }

      const keys = keysOf?.(before, envelope);
      if (keys && eventClass(db, envelope.type) === 'intent' && envelope.basis.epoch === head.epoch && intentConflict(db, shopId, [...keys.writes, ...keys.reads], envelope.basis.rev)) {
        const outcome: CommandOutcome = { ...base, outcome: 'conflict', rev: head.rev, epoch: head.epoch, error: { code: 'VERSION_CONFLICT', message: lines.failed } };
        finish(outcome, false);
        db.exec('COMMIT');
        open = false;
        return outcome;
      }

      options.fault?.('execute', envelope);
      const ctx: ExecContext = {
        now,
        actor: { key: actor.key, name: actor.name, ...(actor.deviceId ? { deviceId: actor.deviceId } : {}), ...(actor.vehicleId ? { vehicleId: actor.vehicleId } : {}), ...(actor.roleKey ? { roleKey: actor.roleKey } : {}) },
        outcomeOf: (requestId) => {
          const row = readLog(db, shopId, requestId);
          return row ? { outcome: row.status } : undefined;
        },
        lines,
        orderIds: options.orderIds ?? 'dated',
      };
      const result = execute(before, envelope, ctx);
      const applied = result.outcome.outcome === 'applied' || result.outcome.outcome === 'partially_applied';
      let outcome: CommandOutcome;
      let appliedRev: number | undefined;
      if (applied) {
        const rev = nextRev();
        appliedRev = rev;
        options.fault?.('write', envelope);
        // 이 명령의 영업일 행(열린 날 목록 · 기록일이 본다).
        ensureBusinessDay(db, shopId, businessDateAt(db, shopId, now), isoOf(now));
        const wctx = {
          db, shopId, now, rev, actor: { key: actor.key, name: actor.name, ...(actor.deviceId ? { deviceId: actor.deviceId } : {}) }, requestId: envelope.requestId,
          envelope, before, after: result.state, touched: [],
        };
        writeState(wctx);
        if (keys) markIntents(db, shopId, rev, keys.writes, now);
        appendChanges(db, shopId, rev, wctx.touched);
        outcome = { ...result.outcome, rev, epoch: head.epoch, requestId: envelope.requestId };
        const { clean, pii } = splitPii({ type: envelope.type, commandVersion: envelope.commandVersion, basis: envelope.basis, expect: envelope.expect, dependsOn: envelope.dependsOn, payload: envelope.payload });
        const aggregate = aggregateOf(envelope, shopId);
        options.fault?.('journal', envelope);
        appendEvent(db, shopId, {
          rev, epoch: head.epoch, requestId: envelope.requestId, actorKey: actor.key, actorName: actor.name, actorRoleKey: actor.roleKey, deviceId: actor.deviceId,
          type: envelope.type, commandVersion: envelope.commandVersion, engine: 'native', aggregateType: aggregate.type, aggregateId: aggregate.id,
          command: clean, result: outcome, pii, now, businessDate: businessDateAt(db, shopId, now),
        });
        run(db, "UPDATE shop_counters SET value = ? WHERE shop_id = ? AND counter_key = 'rev' AND scope_key = ''", rev, shopId);
      } else {
        outcome = { ...result.outcome, rev: head.rev, epoch: head.epoch, requestId: envelope.requestId };
      }
      finish(outcome, false, appliedRev);
      options.fault?.('commit', envelope);
      db.exec('COMMIT');
      open = false;
      committed = true;
      committedOutcome = outcome;
      // 표가 진실이다(ADR-01): 적은 뒤의 상태는 다음 읽기가 표에서 다시 읽는다(옮기기에서 빠진 칸이 캐시에 숨지 않게).
      if (applied) cache = undefined;
      // COMMIT 뒤의 일(알림 · 기록)이 던져도 적은 명령의 결과는 그대로 돌려준다(command_log를 되돌려 적지 않는다).
      try {
        options.fault?.('after_commit', envelope);
        if (applied) options.onCommit?.(readHead(db, shopId, now));
        const took = Date.now() - started;
        if (took > SLOW_MS) options.log?.('slow command ' + envelope.type + ' ' + took + 'ms');
      } catch (error) {
        options.log?.('after commit failed ' + envelope.type + ' ' + (error instanceof Error ? error.name : 'error'));
      }
      return outcome;
    } catch (error) {
      if (committed && committedOutcome) {
        options.log?.('after commit failed ' + envelope.type);
        return committedOutcome;
      }
      if (open) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // 이미 끝난 트랜잭션
        }
      }
      cache = undefined;
      options.log?.('command failed ' + envelope.type + ' ' + (error instanceof StoreError ? error.code : error instanceof Error ? error.name : 'error'));
      if (error instanceof StoreError && (error.code === 'SHOP_MISMATCH' || error.code === 'SHOP_NOT_PROVISIONED' || error.code === 'REENTRANT')) throw error;
      const outcome: CommandOutcome = { ...base, outcome: 'rejected', rev: 0, epoch: '', error: { code: 'INTERNAL', message: lines.failed } };
      try {
        db.exec('BEGIN IMMEDIATE');
        const headNow = readHead(db, shopId, now);
        outcome.rev = headNow.rev;
        outcome.epoch = headNow.epoch;
        existing = readLog(db, shopId, envelope.requestId);
        if (existing && (existing.appliedRev !== undefined || existing.status === 'applied' || existing.status === 'partially_applied')) {
          // 이미 적용한 줄은 덮지 않는다(두 번째 지킴: writeLog도 거절한다).
          const stored = existing.result;
          db.exec('ROLLBACK');
          if (stored) return stored;
          return { ...outcome, outcome: existing.status, rev: existing.appliedRev ?? outcome.rev };
        }
        finish(outcome, true);
        db.exec('COMMIT');
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {
          // 이미 끝남
        }
      }
      return outcome;
    } finally {
      busy = false;
    }
  }

  return {
    shopId,
    head: (now) => readHead(db, shopId, now),
    state: (now) => {
      guardBusy();
      // 한 읽기 트랜잭션(여러 표를 같은 시점으로 읽는다, §4-4).
      db.exec('BEGIN');
      try {
        const state = load(now);
        db.exec('COMMIT');
        return state;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    command,
    provision: (spec, now, provisionOptions) => {
      guardBusy();
      cache = undefined;
      return provisionShop(db, shopId, spec, now, provisionOptions);
    },
    importDay(day, requestId, now, actor) {
      guardBusy();
      busy = true;
      let open = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        open = true;
        checkShop();
        if (num(one(db, 'SELECT is_test FROM shops WHERE id = ?', shopId)?.is_test) !== 1) throw new StoreError('NOT_TEST_SHOP', '견본 자료는 시험 매장에만 넣는다');
        const seen = readLog(db, shopId, requestId);
        if (seen) {
          const rev = seen.appliedRev ?? readRev(db, shopId);
          db.exec('ROLLBACK');
          open = false;
          return { orders: day.orders.length, replay: true, rev };
        }
        const before = load(now);
        const after: ShopState = structuredClone(before);
        // 줄의 상품 key는 종류 그대로(견본 하루의 옛 줄에는 없다: 되읽기는 늘 채운다).
        after.orders.push(...day.orders.map((o) => ({ ...o, lines: o.lines.map((l) => ({ ...l, productKey: l.productKey ?? l.kind })) })));
        after.pins.push(...day.pins);
        after.deposits.push(...day.deposits);
        after.paymentGroups.push(...day.paymentGroups);
        const rev = nextRev();
        ensureBusinessDay(db, shopId, day.date, isoOf(now));
        const wctx = { db, shopId, now, rev, actor: { key: actor.key, name: actor.name }, requestId, before, after, touched: [] };
        writeState(wctx);
        const prefix = day.date.slice(2).replace(/-/g, '') + '-';
        const lastSeq = Math.max(0, ...day.orders.filter((o) => o.receiptNo.startsWith(prefix)).map((o) => Number(o.receiptNo.slice(prefix.length)) || 0));
        if (lastSeq > 0) raiseReceiptCounter(db, shopId, day.date, lastSeq);
        appendChanges(db, shopId, rev, wctx.touched);
        const epoch = readHead(db, shopId, now).epoch;
        const result = { outcome: 'applied', requestId, rev, asOfRev: rev - 1, epoch, rebased: false, changes: [], result: { orders: day.orders.length, date: day.date } };
        appendEvent(db, shopId, {
          rev, epoch, requestId, actorKey: actor.key, actorName: actor.name, type: IMPORT_EVENT, commandVersion: 1, engine: 'import',
          command: { date: day.date, orders: day.orders.length }, result, pii: {}, now, businessDate: businessDateAt(db, shopId, now), imported: true,
        });
        writeLog(db, shopId, {
          requestId, actorKey: actor.key, type: IMPORT_EVENT, commandVersion: 1, fingerprint: fingerprintOf(key, { type: IMPORT_EVENT as never, commandVersion: 1, payload: { date: day.date } as never }),
          outcome: result as CommandOutcome, retryable: false, appliedRev: rev, now,
        }, undefined);
        run(db, "UPDATE shop_counters SET value = ? WHERE shop_id = ? AND counter_key = 'rev' AND scope_key = ''", rev, shopId);
        db.exec('COMMIT');
        open = false;
        cache = undefined;
        try {
          options.onCommit?.(readHead(db, shopId, now));
        } catch {
          // 알림 실패는 가져오기 결과를 바꾸지 않는다
        }
        return { orders: day.orders.length, replay: false, rev };
      } catch (error) {
        if (open) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // 이미 끝남
          }
        }
        cache = undefined;
        throw error;
      } finally {
        busy = false;
      }
    },
    devices: deviceRows(db, shopId),
    isTest: () => num(one(db, 'SELECT is_test FROM shops WHERE id = ?', shopId)?.is_test) === 1,
    staff: () => listStaff(db, shopId),
    permissions: (roleKey) => rolePermissions(db, shopId, roleKey),
    dropCache: () => {
      cache = undefined;
    },
  };
}

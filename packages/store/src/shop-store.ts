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
  commandScope as domainCommandScope, conflictKeys as domainConflictKeys, execute as domainExecute, linesOf, queuedCommandScope, storeReview, type CommandScope,
  type DomainLines, type ExecContext, type Execute, type ShopSpec, type ShopState,
} from '@skinote/domain';
import { StoreError } from './errors.ts';
import { all, insert, num, one, run, str, text, type Db } from './db.ts';
import { businessDateAt, ensureBusinessDay } from './dates.ts';
import { deviceRows, type DeviceRows } from './devices.ts';
import {
  appendChanges, appendEvent, eventClass, fingerprintOf, HELD_EXPIRES_AT, intentConflict, isFinal, markIntents, readLog, recordFinding, sha256, shopFingerprintKey, splitPii,
  writeLog, type LogRow,
} from './journal.ts';
import { loadShopState, readHead, readInstance, readRev, type ShopHead } from './load.ts';
import { inWriteTransaction, provision as provisionShop, type ProvisionOptions, type ProvisionResult } from './provision.ts';
import { listStaff, roleLimits, rolePermissions, type StaffRow } from './registry-read.ts';
import { setRoleLimits } from './registry-write.ts';
import { raiseReceiptCounter, writeState } from './write.ts';
import { addDays, canonicalJson, isoOf } from './ids.ts';

/** 명령을 한 사람(세션에서, 봉투에서가 아니다). key = 'staff:<staff_members.id>'. */
export interface Actor {
  key: string;
  name: string;
  deviceId?: string;
  vehicleId?: string;
  roleKey?: string;
  /** 세션 역할의 권한 · 한도(서버). 도메인이 할인 권한 · 직접 입력 한도를 다시 본다(features-1 E10). 없으면 보지 않는다. */
  viewer?: { permissions: readonly string[]; limits?: { maxDiscountAmount?: number; maxDiscountPercentBp?: number } };
}

/** 명령이 닿는 범위(도메인 commandScope). 서버의 권한 확인(guard)이 기사 세션의 '자기 차량'을 본다. */
export type { CommandScope } from '@skinote/domain';
/** 서버의 권한 확인: 거절이면 결과(FORBIDDEN · FORBIDDEN_SCOPE), 괜찮으면 null. 멱등 확인 뒤에 부른다(이미 적용한 재전송은 누가 보내도 저장한 결과). */
export type Guard = (scope: CommandScope) => CommandOutcome | null;

/** 시험의 고장 고리: 이름 붙은 단계에서 한 번 던진다. 운영 코드는 넣지 않는다. */
export type FaultPhase = 'load' | 'execute' | 'write' | 'journal' | 'commit' | 'after_commit';
export type FaultHook = (phase: FaultPhase, envelope: AnyCommandEnvelope) => void;

/** 가져올 하루(load-sample): 그 날짜와 더할 접수 · 고정 · 보증금 · 결제 자리 · 견본 확인 필요. 접수 번호는 그 날짜의 것이다. */
export interface ImportDay {
  date: string;
  orders: ShopState['orders'];
  pins: ShopState['pins'];
  deposits: ShopState['deposits'];
  paymentGroups: ShopState['paymentGroups'];
  /** 견본 확인 필요(features-1 §9-6, 출처 import). 없으면 넣지 않는다. */
  reviews?: NonNullable<ShopState['reviews']>;
}

/** 가져오기의 작업 기록 종류(sys_event_types: engine import). */
const IMPORT_EVENT = 'legacy.imported';

/** 명령 결과 + 같은 요청번호의 다른 본문(첫 결과를 돌려주며 표시). */
export type StoreOutcome = CommandOutcome & { idempotencyMismatch?: true };

/**
 * 멱등 확인 뒤, 실행 전에 정규 명령을 만드는 고리(work/impl-offline/plan.md O12 · R2 13): 마감의 관리자 승인을 이 트랜잭션 안에서 쓰고 서버가 본 차량
 * 연결(links) · 승인(override)을 본문에 적는다. 같은 요청번호의 재전송은 이 고리 전에 저장한 결과를 돌려받는다. 거절이면 결과(APPROVAL_INVALID …).
 */
export type Prepare = (envelope: AnyCommandEnvelope) => AnyCommandEnvelope | CommandOutcome;

/** 보냄 대기 명령의 권한 확인(업무 id의 차량 범위): 범위 밖이면 적용하되 공급자 확인 중으로 표시(flag) 또는 적지 않음(supersede), 괜찮으면 null. */
export type QueuedGuard = (scope: CommandScope) => QueuedFlag | null;

/**
 * 공급자가 확인할 기록(나쁜 서명 · 범위 밖 · 권한 없음, O6 · §17 R3-10): 결과의 코드와 확인 필요 `공급자 확인 중`. supersede면 적용하지 않고
 * superseded로 적는다(돈 · 재고가 아닌 기록: 순서 변경 · 방문 결과 · 긴급 확인은 범위 밖이면 버린다, 적은 것이 없어 확인 필요도 없다).
 */
export interface QueuedFlag {
  code: 'BAD_SIGNATURE' | 'FORBIDDEN_SCOPE' | 'FORBIDDEN';
  supersede?: true;
}

/** 보냄 대기 명령 하나의 서버 쪽 값(§6-1). 행위자(actor)는 기록한 직원(서명된 recordedBy), 기기는 보낸 기기. */
export interface QueuedMeta {
  deviceId: string;
  deviceSeq: number;
  /** 일어난 때(받은 때 − 나이, 서버가 셈). */
  occurredAt: number;
  /** 서버가 받은 때(적은 때). */
  receivedAt: number;
  timeSource: 'monotonic' | 'wall_clock';
  signature?: string;
  /** 보낸 세션의 행위자(기록한 직원과 다를 때). */
  submittedByKey?: string;
  flag?: QueuedFlag;
  /** 기기의 이름(확인 필요 문장의 {device}). */
  deviceLabel: string;
  /** 더 적을 확인 필요(시계 확인 · 미확인 로그인). */
  reviews?: { kindKey: 'clock_suspect' | 'unverified_sign_in'; params: Record<string, string | number> }[];
}

/** 보냄 대기 명령의 결과: 이 명령이 더한 확인 필요의 종류와 시각의 출처. */
export type QueuedOutcome = StoreOutcome & { reviews: string[]; timeSource?: 'monotonic' | 'wall_clock' };

/** 보류 행 한 줄(명령줄). */
export interface HeldRow {
  requestId: string;
  deviceId?: string;
  deviceLabel?: string;
  deviceSeq?: number;
  type: string;
  receivedAt: number;
  reason: string;
  dismissed: boolean;
}

/** 보류할 기록(끊은 기기 · 모양이 틀린 봉투 · 세션 없는 전달의 규칙, O6 · O21): 적용하지 않고 받은 그대로 둔다. */
export interface HeldInput {
  requestId: string;
  type: string;
  deviceId: string;
  deviceSeq?: number;
  reason: 'revoked' | 'malformed' | 'session';
  /** 받은 그대로의 항목(서명 포함). */
  envelope: unknown;
  /** 읽힌 봉투(모양이 맞을 때): 지문을 명령의 것으로 적는다(§18 R4-9). */
  parsed?: Pick<AnyCommandEnvelope, 'type' | 'commandVersion' | 'payload'>;
  actorKey: string;
  receivedAt: number;
  signature?: string;
}

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
  /**
   * 되살린 epoch의 기준 rev(shop_instance.restored_up_to_rev). 되살린 epoch가 아니면(처음 만듦 · 시험 매장 새로 만들기) null: 기사 기기는 수일
   * 때만 옛 epoch의 보낸 기록을 다시 보낸다(work/impl-offline/plan.md O20 · §17 R3-1).
   */
  restoredUpToRev(): number | null;
  /** 이 시각의 도메인 상태(캐시: rev와 영업일이 같으면 다시 읽지 않는다). 읽기 전용으로 쓴다. */
  state(now: number): ShopState;
  command(envelope: AnyCommandEnvelope, actor: Actor, now: number, guard?: Guard, prepare?: Prepare): StoreOutcome;
  /**
   * 보냄 대기 명령 하나(work/impl-offline/plan.md §6-1, 한 트랜잭션): 같은 요청번호면 첫 결과(온라인으로 보낸 줄의 빈 기기 번호는 채움), 같은 기기 번호에
   * 다른 요청번호면 SEQ_REUSED(아무것도 적지 않음), 아니면 일어난 때로 실행하고 받은 때로 적는다(늦은 돈은 다음 열린 날). 범위 밖 · 나쁜 서명은 적용하고
   * `공급자 확인 중`을 남긴다. 기기의 가장 높은 번호를 올린다.
   */
  commandQueued(envelope: AnyCommandEnvelope, actor: Actor, meta: QueuedMeta, guard?: QueuedGuard): QueuedOutcome;
  /** 보류 행 하나(적용하지 않음, 봉투는 결과 칸에 둔다). 같은 요청번호가 있으면 그 결과. */
  holdQueued(input: HeldInput): QueuedOutcome;
  /** 보류 행 목록(명령줄 `held --list`, O21): 봉투 · 본문 없이 요청번호 · 기기 · 명령 · 받은 때 · 까닭 · 미반영 결정. */
  listHeld(): HeldRow[];
  /** 보류 행의 봉투(반영할 때 서버가 다시 검사한다). 보류 행이 아니거나 미반영으로 정한 것은 undefined. */
  heldEnvelope(requestId: string): { envelope: unknown; deviceId?: string; deviceSeq?: number; receivedAt: number } | undefined;
  /**
   * 보류 행을 반영한다(공급자가 정함, O21): 같은 요청번호의 보류 행을 그 자리에서 보냄 대기 사실로 적용한다(다시 판단: 결과 · 적용 rev · 끝낸 때가 바뀐다).
   * 보류 행이 아니면 그 결과 그대로.
   */
  releaseHeld(envelope: AnyCommandEnvelope, actor: Actor, meta: QueuedMeta): QueuedOutcome;
  /** 보류 행을 미반영으로 정한다(행은 보류로 남고 셈에서 빠진다). 바꾼 경우 true. */
  dismissHeld(requestId: string, now: number): boolean;
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
  /** 역할의 한도(role_permissions.limits_json을 합친 것: 직접 입력 할인의 금액 · 비율, features-1 E10). 없으면 빈 객체. */
  roleLimits(roleKey: string): { maxDiscountAmount?: number; maxDiscountPercentBp?: number };
  /**
   * 역할의 직접 입력 할인 한도를 바꾼다(명령줄 `shop set-limit`, 관리자 일, 2026-09-27 점검: 한도를 적는 길이 없었다). null은 한도 없음. 그 역할에
   * discount.manual이 없으면 false.
   */
  setRoleLimits(roleKey: string, limits: { maxDiscountAmount?: number; maxDiscountPercentBp?: number } | null): boolean;
  /** 캐시를 버린다(시험 · 다른 연결이 쓴 뒤). */
  dropCache(): void;
}

/** 명령의 주된 대상(events.aggregate_*): 본문의 접수 · 업무 · 차량 · 마감일, 규칙 저장은 매장. */
function aggregateOf(envelope: AnyCommandEnvelope, shopId: string): { type?: string; id?: string } {
  const p = envelope.payload as Record<string, unknown>;
  if (envelope.type === 'setting.set' || envelope.type === 'registry.update' || envelope.type === 'staff.set') return { type: 'shop', id: shopId };
  if (envelope.type === 'closing.close' && typeof p.date === 'string') return { type: 'closing', id: p.date };
  if (envelope.type === 'review.resolve' && typeof p.reviewId === 'string') return { type: 'review', id: p.reviewId };
  if (typeof p.orderId === 'string') return { type: 'order', id: p.orderId };
  if (typeof p.taskId === 'string') return { type: 'task', id: p.taskId };
  if (typeof p.vehicleId === 'string') return { type: 'vehicle', id: p.vehicleId };
  return {};
}

const SLOW_MS = 2_000;
/** 스위치를 끈 길에서 답을 잃은 온라인 시도가 끝난 결과 가운데 보냄 대기의 사실로 다시 판단하는 것(§18 R4-1). 막힘(blocked)은 늘 다시 판단한다. */
const REJUDGE_ONLINE: ReadonlySet<string> = new Set(['rejected', 'conflict']);

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

  function command(envelope: AnyCommandEnvelope, actor: Actor, now: number, guard?: Guard, prepare?: Prepare): StoreOutcome {
    return runCommand(envelope, actor, now, { ...(guard ? { guard } : {}), ...(prepare ? { prepare } : {}) });
  }

  /** 온라인 · 보냄 대기 명령의 한 트랜잭션. queued면 일어난 때로 실행하고 받은 때로 적는다. */
  function runCommand(input: AnyCommandEnvelope, actor: Actor, now: number, opts: {
    guard?: Guard; prepare?: Prepare; queued?: QueuedMeta; queuedGuard?: QueuedGuard; release?: boolean;
  }): QueuedOutcome {
    guardBusy();
    busy = true;
    const started = Date.now();
    let open = false;
    // COMMIT 뒤에는 무슨 일이 있어도 적은 결과를 돌려준다(적용한 명령의 command_log를 INTERNAL로 덮지 않는다).
    let committed = false;
    let committedOutcome: CommandOutcome | undefined;
    let existing: LogRow | undefined;
    let envelope = input;
    const q = opts.queued;
    // 보냄 대기: 일어난 때(occurredAt)로 실행하고, 받은 때(receivedAt)로 적는다. 적는 때는 트랜잭션 안에서 이미 적힌 마감보다 이르지 않게 올린다
    // (writeNow, 아래): 묶음이 받은 때를 잡은 뒤 다른 요청(관리자 승인 마감)이 먼저 COMMIT하면 그 뒤에 적는 돈이 닫힌 날에 들지 않게(§17 R3-2).
    const execNow = q ? q.occurredAt : now;
    let writeNow = q ? q.receivedAt : now;
    const fingerprint = fingerprintOf(key, envelope);
    const base = { requestId: envelope.requestId, asOfRev: envelope.basis.rev, rebased: false, changes: [] };
    let flagCode: string | undefined;
    const withReviews = (outcome: CommandOutcome, reviews: string[]): QueuedOutcome => ({ ...outcome, reviews, ...(q ? { timeSource: q.timeSource } : {}) });
    const finish = (outcome: CommandOutcome, retryable: boolean, appliedRev?: number, reviews: string[] = []) =>
      writeLog(db, shopId, {
        requestId: envelope.requestId, actorKey: actor.key, deviceId: q ? q.deviceId : actor.deviceId, type: envelope.type, commandVersion: envelope.commandVersion, fingerprint,
        outcome, retryable, appliedRev, basis: envelope.basis, dependsOn: envelope.dependsOn, now,
        ...(q ? {
          queued: {
            deviceSeq: q.deviceSeq, ...(q.signature ? { signature: q.signature } : {}), ...(q.submittedByKey ? { submittedByKey: q.submittedByKey } : {}),
            timeSource: q.timeSource, occurredAt: q.occurredAt, receivedAt: q.receivedAt, ...(flagCode ? { errorCode: flagCode } : {}),
            result: { ...outcome, reviews },
          },
        } : {}),
      }, existing);
    try {
      db.exec('BEGIN IMMEDIATE');
      open = true;
      checkShop();
      existing = readLog(db, shopId, envelope.requestId);
      if (existing) {
        // 결과 글을 보관 기간 뒤에 지운 줄은 상태 · 적용 rev로 다시 만든다(다시 적용하지 않는다).
        const stored = (log: LogRow): QueuedOutcome => {
          const first = log.result ?? {
            ...base, outcome: log.status, rev: log.appliedRev ?? readRev(db, shopId), epoch: readHead(db, shopId, now).epoch,
            ...(log.errorCode ? { error: { code: log.errorCode, message: lines.failed } } : {}),
          };
          return { ...first, reviews: (first as Partial<QueuedOutcome>).reviews ?? [] };
        };
        // 온라인으로 보낸 뒤 답을 잃어 보냄 대기로 다시 온 같은 요청(스위치를 끈 길, O9): 비어 있는 기기 번호를 채운다(번호가 비어 있을 때만).
        const filled = q && !opts.release ? fillDeviceSeq(envelope.requestId, q) : false;
        // 그 온라인 시도가 거절 · 충돌로 끝났다면(기기는 그 답을 잃었고 창은 `queued`로 닫혔다: 기사는 적었다고 안다) 보냄 대기의 사실로 다시
        // 판단한다(sync 8-12: 돈은 거절하지 않고 `중복 수납 의심` · 범위 밖은 표시, §18 R4-1). 번호를 이번에 채운 줄만(한 번만): 그 뒤의 같은 요청은
        // 새 결과를 돌려받는다. 지문이 다르면 아래의 멱등 어긋남이 먼저다.
        if (filled && existing.fingerprint === fingerprint && REJUDGE_ONLINE.has(existing.status)) {
          run(db, 'UPDATE command_log SET retryable = 1, time_source_key = ?, actor_signature = coalesce(?, actor_signature) WHERE shop_id = ? AND request_id = ?',
            q!.timeSource, q!.signature ?? null, shopId, envelope.requestId);
          existing = readLog(db, shopId, envelope.requestId);
        }
        // 보류 행의 반영(O21): 그 행을 다시 판단한다(지문은 반영하며 명령의 것으로 바꾼다).
        const releasing = opts.release === true && existing?.status === 'held';
        if (releasing) run(db, 'UPDATE command_log SET fingerprint = ?, retryable = 1 WHERE shop_id = ? AND request_id = ?', fingerprint, shopId, envelope.requestId);
        if (releasing) existing = readLog(db, shopId, envelope.requestId);
        if (existing && existing.fingerprint !== fingerprint) {
          recordFinding(db, shopId, { checkKey: 'idempotency_mismatch', entityType: 'command_log', entityId: envelope.requestId, expected: existing.fingerprint, actual: fingerprint, now });
          const first = stored(existing);
          db.exec('COMMIT');
          open = false;
          return { ...first, idempotencyMismatch: true };
        }
        if (existing && isFinal(existing)) {
          const first = stored(existing);
          db.exec(q ? 'COMMIT' : 'ROLLBACK');
          open = false;
          return first;
        }
      }
      if (q && !opts.release) {
        // 같은 기기 번호에 다른 요청번호: 아무것도 적지 않고 기기가 번호를 다시 준다(O9).
        const taken = one(db, 'SELECT request_id FROM command_log WHERE shop_id = ? AND device_id = ? AND device_seq = ?', shopId, q.deviceId, q.deviceSeq);
        if (taken && str(taken.request_id) !== envelope.requestId) {
          db.exec('ROLLBACK');
          open = false;
          const headNow = readHead(db, shopId, now);
          return withReviews({ ...base, outcome: 'rejected', rev: headNow.rev, epoch: headNow.epoch, error: { code: 'SEQ_REUSED', message: lines.failed } }, []);
        }
      }
      options.fault?.('load', envelope);
      const before = load(now);
      const head = { epoch: before.epoch, rev: readRev(db, shopId) };
      if (q) {
        // 이 트랜잭션 앞에 COMMIT한 마감(closedAt)은 이 기록보다 먼저다: 받은 때가 그보다 이르면(묶음이 받은 때를 먼저 잡음) 마감 때로 올린다.
        // 도메인의 올림 날(postingDate: recordedAt ≥ closedAt이면 다음 날)과 표의 posting_date가 같은 날을 가리킨다.
        const lastClosed = before.closings.reduce((max, c) => Math.max(max, c.closedAt), 0);
        if (lastClosed > writeNow) writeNow = lastClosed;
      }

      if (opts.guard) {
        const refusal = opts.guard(scopeOf(before, envelope));
        if (refusal) {
          const outcome: CommandOutcome = { ...base, ...refusal, requestId: envelope.requestId, rev: head.rev, epoch: head.epoch, outcome: 'rejected' };
          finish(outcome, false);
          db.exec('COMMIT');
          open = false;
          return withReviews(outcome, []);
        }
      }
      // 보냄 대기: 범위 밖이면 적용하고 표시(sync 8-12, O6). 돈 · 재고가 아닌 기록의 범위 밖 · 권한 없음은 적지 않는다(§17 R3-10).
      const flag = q ? (q.flag?.supersede ? q.flag : opts.queuedGuard?.(queuedCommandScope(before, envelope)) ?? q.flag) : undefined;
      if (flag) flagCode = flag.code;
      if (q && flag?.supersede) {
        const outcome: CommandOutcome = { ...base, outcome: 'superseded', rev: head.rev, epoch: head.epoch, requestId: envelope.requestId, error: { code: flag.code, message: lines.failed } };
        finish(outcome, false);
        raiseHighWater(q.deviceId, q.deviceSeq);
        db.exec('COMMIT');
        open = false;
        return withReviews(outcome, []);
      }

      if (opts.prepare) {
        // 마감의 승인 · 차량 연결(O12): 멱등 확인 뒤, 이 트랜잭션 안에서 정규 명령을 만든다.
        const prepared = opts.prepare(envelope);
        if (!('payload' in prepared)) {
          const outcome: CommandOutcome = { ...base, ...prepared, requestId: envelope.requestId, rev: head.rev, epoch: head.epoch, outcome: 'rejected' };
          finish(outcome, false);
          db.exec('COMMIT');
          open = false;
          return withReviews(outcome, []);
        }
        envelope = prepared;
      }

      const keys = keysOf?.(before, envelope);
      if (!q && keys && eventClass(db, envelope.type) === 'intent' && envelope.basis.epoch === head.epoch && intentConflict(db, shopId, [...keys.writes, ...keys.reads], envelope.basis.rev)) {
        const outcome: CommandOutcome = { ...base, outcome: 'conflict', rev: head.rev, epoch: head.epoch, error: { code: 'VERSION_CONFLICT', message: lines.failed } };
        finish(outcome, false);
        db.exec('COMMIT');
        open = false;
        return withReviews(outcome, []);
      }

      options.fault?.('execute', envelope);
      const ctx: ExecContext = {
        now: execNow,
        actor: { key: actor.key, name: actor.name, ...(actor.deviceId ? { deviceId: actor.deviceId } : {}), ...(actor.vehicleId ? { vehicleId: actor.vehicleId } : {}), ...(actor.roleKey ? { roleKey: actor.roleKey } : {}) },
        outcomeOf: (requestId) => {
          const row = readLog(db, shopId, requestId);
          return row ? { outcome: row.status } : undefined;
        },
        lines,
        orderIds: options.orderIds ?? 'dated',
        ...(actor.viewer ? { viewer: actor.viewer } : {}),
        ...(q ? { recordedAt: writeNow } : {}),
      };
      const result = execute(before, envelope, ctx);
      let after = result.state;
      // 보냄 대기의 확인 필요(공급자 확인 중 · 시계 확인 · 미확인 로그인): 명령 결과와 따로 이 기록에 붙인다(O6 · O8).
      if (q) {
        const extra = [...(flag ? [{ kindKey: 'command_held' as const, params: { device: q.deviceLabel, count: 1 } }] : []), ...(q.reviews ?? [])];
        if (extra.length) {
          after = after === before ? structuredClone(before) : after;
          const taskId = (envelope.payload as { taskId?: string }).taskId;
          const orderId = (envelope.payload as { orderId?: string }).orderId ?? (taskId ? taskId.split(':')[1] : undefined);
          const known = orderId !== undefined && after.orders.some((o) => o.id === orderId);
          extra.forEach((r, i) => storeReview(after, {
            id: envelope.requestId + ':s' + (i + 1), kindKey: r.kindKey, params: r.params, source: 'sync', createdAt: writeNow, targetDeviceId: q.deviceId,
            ...(known ? { orderId } : {}),
          }));
        }
      }
      const reviews = (after.reviews ?? []).slice((before.reviews ?? []).length).map((r) => r.kindKey);
      // 적은 것이 확인 필요뿐인 명령(이미 매장에 반납된 보냄 대기 수거: 결과는 superseded)도 새 상태를 적는다(features-1 E18).
      const applied = result.outcome.outcome === 'applied' || result.outcome.outcome === 'partially_applied'
        || ((result.outcome.outcome === 'superseded' || result.outcome.outcome === 'needs_review') && after !== before);
      let outcome: CommandOutcome;
      let appliedRev: number | undefined;
      if (applied) {
        const rev = nextRev();
        appliedRev = rev;
        options.fault?.('write', envelope);
        // 이 명령의 영업일 행(열린 날 목록 · 기록일이 본다).
        ensureBusinessDay(db, shopId, businessDateAt(db, shopId, writeNow), isoOf(writeNow));
        const wctx = {
          db, shopId, now: writeNow, rev, actor: { key: actor.key, name: actor.name, ...(actor.deviceId ? { deviceId: actor.deviceId } : {}) }, requestId: envelope.requestId,
          envelope, before, after, touched: [],
        };
        writeState(wctx);
        if (keys) markIntents(db, shopId, rev, keys.writes, writeNow);
        appendChanges(db, shopId, rev, wctx.touched);
        outcome = { ...result.outcome, rev, epoch: head.epoch, requestId: envelope.requestId };
        const { clean, pii } = splitPii({ type: envelope.type, commandVersion: envelope.commandVersion, basis: envelope.basis, expect: envelope.expect, dependsOn: envelope.dependsOn, payload: envelope.payload });
        const aggregate = aggregateOf(envelope, shopId);
        options.fault?.('journal', envelope);
        appendEvent(db, shopId, {
          rev, epoch: head.epoch, requestId: envelope.requestId, actorKey: actor.key, actorName: actor.name, actorRoleKey: actor.roleKey, deviceId: q ? q.deviceId : actor.deviceId,
          type: envelope.type, commandVersion: envelope.commandVersion, engine: 'native', aggregateType: aggregate.type, aggregateId: aggregate.id,
          command: clean, result: outcome, pii, now: writeNow, businessDate: businessDateAt(db, shopId, writeNow),
        });
        run(db, "UPDATE shop_counters SET value = ? WHERE shop_id = ? AND counter_key = 'rev' AND scope_key = ''", rev, shopId);
      } else {
        outcome = { ...result.outcome, rev: head.rev, epoch: head.epoch, requestId: envelope.requestId };
      }
      finish(outcome, false, appliedRev, reviews);
      if (opts.release) run(db, 'UPDATE command_log SET result_expires_at = ? WHERE shop_id = ? AND request_id = ?', addResultDays(writeNow), shopId, envelope.requestId);
      if (q) raiseHighWater(q.deviceId, q.deviceSeq);
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
      return withReviews(outcome, reviews);
    } catch (error) {
      if (committed && committedOutcome) {
        options.log?.('after commit failed ' + envelope.type);
        return withReviews(committedOutcome, []);
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
          if (stored) return withReviews(stored, (stored as Partial<QueuedOutcome>).reviews ?? []);
          return withReviews({ ...outcome, outcome: existing.status, rev: existing.appliedRev ?? outcome.rev }, []);
        }
        // 보냄 대기의 처리 오류는 기기 번호를 적지 않는다(다음 묶음이 같은 번호로 다시 보낸다: 번호 빈 곳이 되지 않게 행 자체를 남기지 않음).
        if (!q) finish(outcome, true);
        db.exec('COMMIT');
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {
          // 이미 끝남
        }
      }
      return withReviews(outcome, []);
    } finally {
      busy = false;
    }
  }

  /**
   * 온라인으로 먼저 온 같은 요청의 빈 기기 번호를 채운다(그 기기의 줄이고 번호가 비어 있고 번호가 쓰이지 않았을 때만, O9). 채웠으면 true(그 줄은 이
   * 기기의 온라인 줄이었다).
   */
  function fillDeviceSeq(requestId: string, q: QueuedMeta): boolean {
    const row = one(db, 'SELECT device_id, device_seq FROM command_log WHERE shop_id = ? AND request_id = ?', shopId, requestId);
    if (!row || text(row.device_id) !== q.deviceId || row.device_seq !== null) return false;
    if (one(db, 'SELECT 1 AS x FROM command_log WHERE shop_id = ? AND device_id = ? AND device_seq = ?', shopId, q.deviceId, q.deviceSeq)) return false;
    run(db, 'UPDATE command_log SET device_seq = ? WHERE shop_id = ? AND request_id = ?', q.deviceSeq, shopId, requestId);
    raiseHighWater(q.deviceId, q.deviceSeq);
    return true;
  }

  /** 기기의 가장 높은 번호(devices.last_device_seq, 줄 차례는 강제하지 않음). */
  function raiseHighWater(deviceId: string, seq: number): void {
    run(db, 'UPDATE devices SET last_device_seq = max(last_device_seq, ?) WHERE shop_id = ? AND id = ?', seq, shopId, deviceId);
  }

  function commandQueued(envelope: AnyCommandEnvelope, actor: Actor, meta: QueuedMeta, guard?: QueuedGuard): QueuedOutcome {
    return runCommand(envelope, actor, meta.receivedAt, { queued: meta, ...(guard ? { queuedGuard: guard } : {}) });
  }

  /** 결과 보관 끝(90일, 반영한 보류 행은 먼 끝을 보통 끝으로). */
  const addResultDays = (ms: number) => { const at = isoOf(ms); return addDays(at.slice(0, 10), 90) + at.slice(10); };

  function listHeld(): HeldRow[] {
    return all(db, `SELECT c.request_id, c.device_id, c.device_seq, c.command_type, c.received_at, c.result_json, d.label FROM command_log c
      LEFT JOIN devices d ON d.shop_id = c.shop_id AND d.id = c.device_id WHERE c.shop_id = ? AND c.status_key = 'held' ORDER BY c.received_at, c.rowid`, shopId).map((r) => {
      const held = (text(r.result_json) !== undefined ? (JSON.parse(str(r.result_json)) as { held?: { reason?: string; dismissed?: unknown } }).held : undefined) ?? {};
      return {
        requestId: str(r.request_id), ...(text(r.device_id) !== undefined ? { deviceId: str(r.device_id) } : {}), ...(text(r.label) !== undefined ? { deviceLabel: str(r.label) } : {}),
        ...(r.device_seq !== null ? { deviceSeq: num(r.device_seq) } : {}), type: str(r.command_type), receivedAt: Date.parse(str(r.received_at)), reason: held.reason ?? '',
        dismissed: held.dismissed !== undefined,
      };
    });
  }

  function heldEnvelope(requestId: string) {
    const r = one(db, "SELECT device_id, device_seq, received_at, result_json FROM command_log WHERE shop_id = ? AND request_id = ? AND status_key = 'held'", shopId, requestId);
    if (!r || text(r.result_json) === undefined) return undefined;
    const held = (JSON.parse(str(r.result_json)) as { held?: { envelope?: unknown; dismissed?: unknown } }).held;
    if (!held || held.dismissed !== undefined) return undefined;
    return {
      envelope: held.envelope, ...(text(r.device_id) !== undefined ? { deviceId: str(r.device_id) } : {}), ...(r.device_seq !== null ? { deviceSeq: num(r.device_seq) } : {}),
      receivedAt: Date.parse(str(r.received_at)),
    };
  }

  function releaseHeld(envelope: AnyCommandEnvelope, actor: Actor, meta: QueuedMeta): QueuedOutcome {
    return runCommand(envelope, actor, meta.receivedAt, { queued: meta, release: true });
  }

  function dismissHeld(requestId: string, now: number): boolean {
    return inWriteTransaction(db, () => {
      const r = one(db, "SELECT result_json FROM command_log WHERE shop_id = ? AND request_id = ? AND status_key = 'held'", shopId, requestId);
      if (!r || text(r.result_json) === undefined) return false;
      const result = JSON.parse(str(r.result_json)) as { held?: Record<string, unknown> };
      if (!result.held || result.held.dismissed !== undefined) return false;
      result.held.dismissed = { at: isoOf(now), by: 'supplier' };
      run(db, 'UPDATE command_log SET result_json = ? WHERE shop_id = ? AND request_id = ?', canonicalJson(result), shopId, requestId);
      return true;
    });
  }

  function holdQueued(input: HeldInput): QueuedOutcome {
    guardBusy();
    busy = true;
    try {
      return inWriteTransaction(db, () => {
        checkShop();
        const head = readHead(db, shopId, input.receivedAt);
        const base = { requestId: input.requestId, asOfRev: 0, rebased: false, changes: [], rev: head.rev, epoch: head.epoch };
        const found = readLog(db, shopId, input.requestId);
        if (found) {
          const first = found.result ?? { ...base, outcome: found.status };
          return { ...first, reviews: (first as Partial<QueuedOutcome>).reviews ?? [] };
        }
        if (input.deviceSeq !== undefined) {
          const taken = one(db, 'SELECT request_id FROM command_log WHERE shop_id = ? AND device_id = ? AND device_seq = ?', shopId, input.deviceId, input.deviceSeq);
          if (taken) return { ...base, outcome: 'rejected', error: { code: 'SEQ_REUSED', message: lines.failed }, reviews: [] };
        }
        const outcome: CommandOutcome = { ...base, outcome: 'held', error: { code: 'HELD_' + input.reason.toUpperCase(), message: lines.failed } };
        const at = isoOf(input.receivedAt);
        insert(db, 'command_log', {
          shop_id: shopId, request_id: input.requestId, actor_key: input.actorKey, device_id: input.deviceId, device_seq: input.deviceSeq, command_type: input.type.slice(0, 64),
          // 읽힌 봉투는 명령의 지문(같은 기록을 묶음으로 다시 보내면 지문이 같다: 거짓 멱등 어긋남이 없게, §18 R4-9), 읽히지 않은 것은 받은 그대로의 해시.
          command_version: 1, fingerprint: input.parsed ? fingerprintOf(key, input.parsed) : sha256(canonicalJson(input.envelope)), status_key: 'held', retryable: false, error_code: outcome.error!.code,
          result_json: canonicalJson({ ...outcome, reviews: [], held: { reason: input.reason, envelope: input.envelope } }), result_expires_at: HELD_EXPIRES_AT,
          depends_on_json: '[]', time_source_key: 'server', occurred_at: at, received_at: at, finished_at: at, actor_signature: input.signature,
        });
        if (input.deviceSeq !== undefined) raiseHighWater(input.deviceId, input.deviceSeq);
        return { ...outcome, reviews: [] };
      });
    } finally {
      busy = false;
    }
  }

  return {
    shopId,
    head: (now) => readHead(db, shopId, now),
    restoredUpToRev: () => readInstance(db, shopId)?.restoredUpToRev ?? null,
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
    commandQueued,
    holdQueued,
    listHeld,
    heldEnvelope,
    releaseHeld,
    dismissHeld,
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
        if (day.reviews?.length) after.reviews = [...(after.reviews ?? []), ...day.reviews];
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
    roleLimits: (roleKey) => roleLimits(db, shopId, roleKey),
    setRoleLimits: (roleKey, limits) => inWriteTransaction(db, () => setRoleLimits(db, shopId, roleKey, limits)),
    dropCache: () => {
      cache = undefined;
    },
  };
}

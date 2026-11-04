// 보냄 대기(work/impl-offline/plan.md O9 · O18 · O20 · O22 · §7-2): 기사 기기가 끊긴 채(또는 로컬 먼저 모드에서 늘) 기록한 명령. 요청번호가 키이고
// 기기 번호(seq)는 칸이다: 같은 창의 두 번 누름 · 다시 연 초안은 있는 항목을 돌려준다(두 번째 항목을 만들지 않는다).
//   - 넣기(enqueue): 잠금 'skinote-enqueue' 안에서 보냄 대기를 저장소에서 다시 읽고(다른 화면이 넣은 것도 보게), 확인 전 검사(부르는 쪽) → 본문을
//     먼저 봉인하고(WebCrypto는 트랜잭션 밖) → strict 트랜잭션 하나: 열쇠가 아직 있는지 · 기기 번호 셈 · 번호 올림 · 항목 add(겹치면 되돌림).
//     번호 = max(셈의 다음, 서버가 받은 가장 큰 번호 + 1, 이 기기의 보냄 대기 · 보낸 기록의 가장 큰 번호 + 1). 트랜잭션이 실패하면 셈도 오르지 않는다.
//   - 상태: queued → sending(보내는 중) → answered(답을 받음, 사본에 들 때까지 겹쳐 그림) / unconfirmed(보낸 뒤 답을 잃음: 같은 번호 · 요청번호로
//     다시 보냄). 사본의 recorded에 든 항목은 보낸 기록(sent)으로 옮긴다(사본을 쓰는 트랜잭션 안에서, settleInTx). 보류(held) 답은 곧바로 옮긴다.
//   - 보낸 기록(sent): 7일(sent_log_days) 두고, 개인정보 칸은 24시간(sent_pii_hours) 뒤 뺀다. 복구 뒤(새 epoch + 수인 restoredUpToRev) 그 뒤의
//     것은 같은 번호로 보냄 대기에 되돌린다(O20). 복구가 아닌 epoch 바뀜(시험 매장 새로 만들기)에는 되돌리지 않고 옛 답만 보낸 기록으로 옮긴다(§17 R3-1).
//   - 봉인: 본문(명령 · 행위자)은 보냄 대기 열쇠로. 보냄 대기와 보낸 기록은 같은 봉인 그대로 옮긴다(덧붙인 글 'command|<요청번호>|<keyId>').
import {
  PII_KEYS, type AnyCommandEnvelope, type Basis, type CommandOutcome, type CommandOutcomeKey, type CommandType, type Expect, type QueuedItemResult, type RecordedItem,
} from '@skinote/contract';
import type { ItemClock } from './clock.ts';
import { requireKey } from './keys.ts';
import type { LocalStore } from './local-store.ts';
import type { Rec, TxRequests } from './raw-store.ts';
import { isSealed, seal, sealContext, unseal, Unreadable, type Sealed } from './sealed.ts';

export const QUEUE_FMT = 1;

/** 봉인하는 몫: 서명 전의 명령과 그 일을 한 사람(세션). */
export interface CommandCore {
  type: CommandType;
  commandVersion: number;
  requestId: string;
  basis: Basis;
  expect?: Expect;
  dependsOn?: string[];
  payload: unknown;
  recordedBy: { staffId: string; sessionId: string };
}

export type QueueState = 'queued' | 'sending' | 'unconfirmed' | 'answered';

/** 보냄 대기 칸의 봉인하지 않는 몫(개인정보 없음). */
export interface QueueMeta extends ItemClock {
  fmt: number;
  requestId: string;
  seq: number;
  deviceId: string;
  type: CommandType;
  taskId?: string;
  orderId?: string;
  state: QueueState;
  outcome?: CommandOutcomeKey;
  answeredRev?: number;
  answeredEpoch?: string;
  reviews?: string[];
  /** 답의 오류 코드(있으면: NOTHING_LEFT · 범위 밖 …, 줄 메모가 할 일 없는 기록에 메모를 달지 않게, §18 R4-14). */
  errorCode?: string;
  attempts: number;
  lastError?: string;
  /** 혼자 보내도 거절되는 항목(이 앱 판에서는 다시 보내지 않는다, O6). */
  stuckVersion?: string;
  /** 만들 때 연결이 끊겨 있었다(다시 붙어 보낼 때 띠가 곧바로 `전송 중`). */
  madeOffline: boolean;
}

export type QueueRecord = QueueMeta & Sealed;

export interface QueueItem extends QueueMeta {
  core: CommandCore;
}

/** 보낸 기록 칸(봉인은 보냄 대기 때 그대로). */
export interface SentMeta {
  fmt: number;
  requestId: string;
  seq: number;
  deviceId: string;
  type: CommandType;
  taskId?: string;
  orderId?: string;
  outcome: CommandOutcomeKey;
  rev: number;
  epoch: string;
  reviews: string[];
  /** 답의 오류 코드(있으면, §18 R4-14). */
  errorCode?: string;
  answeredAt: number;
  piiStripped: boolean;
  createdWall: number;
  offsetAtCreate: number;
  canonical?: Record<string, unknown>;
}

export type SentRecord = SentMeta & Sealed;

export type EnqueueResult =
  | { kind: 'queued'; item: QueueItem; created: boolean }
  | { kind: 'sent'; outcome: CommandOutcomeKey }
  | { kind: 'refused'; outcome: CommandOutcome };

export interface AnswerSummary {
  answered: number;
  held: number;
  /** 답이 오기 전에 사본(recorded)이 이미 보낸 기록으로 옮긴 항목(보낸 것이다: 띠의 결과 줄, §17-4). */
  settled: number;
  retry: number;
  stuck: number;
  restamped: number;
  /** applied가 아닌 결과(띠의 결과 줄을 보일지). */
  notApplied: number;
}

/** 명령 봉투 → 봉인할 몫. */
export function coreOf(envelope: AnyCommandEnvelope, recordedBy: { staffId: string; sessionId: string }): CommandCore {
  return {
    type: envelope.type, commandVersion: envelope.commandVersion, requestId: envelope.requestId, basis: { epoch: envelope.basis.epoch, rev: envelope.basis.rev },
    ...(envelope.expect ? { expect: envelope.expect } : {}), ...(envelope.dependsOn ? { dependsOn: [...envelope.dependsOn] } : {}),
    payload: envelope.payload, recordedBy: { staffId: recordedBy.staffId, sessionId: recordedBy.sessionId },
  };
}

/** 봉인한 몫 → 겹쳐 그릴 봉투(기기 번호가 있어 보냄 대기 규칙으로 적용된다, 서명 칸 없음). */
export function overlayEnvelope(item: Pick<QueueItem, 'core' | 'seq'>): AnyCommandEnvelope {
  const c = item.core;
  return {
    type: c.type, commandVersion: c.commandVersion, requestId: c.requestId, basis: c.basis, deviceSeq: item.seq,
    ...(c.expect ? { expect: c.expect } : {}), ...(c.dependsOn ? { dependsOn: c.dependsOn } : {}), payload: c.payload,
  } as AnyCommandEnvelope;
}

const taskIdOf = (payload: unknown): string | undefined => {
  const t = payload && typeof payload === 'object' ? (payload as { taskId?: unknown }).taskId : undefined;
  return typeof t === 'string' ? t : undefined;
};
const orderIdOf = (payload: unknown, taskId: string | undefined): string | undefined => {
  const o = payload && typeof payload === 'object' ? (payload as { orderId?: unknown }).orderId : undefined;
  if (typeof o === 'string') return o;
  return taskId?.split(':')[1];
};

/**
 * 저장한 칸을 이 판의 모양으로(fmt 1). 모르는 판 · 빠진 칸은 null(열 수 없는 칸으로 센다, O15 · R2 23: 조용히 건너뛰지 않는다).
 */
export function upgradeQueueRecord(raw: Rec): QueueRecord | null {
  if (raw.fmt !== QUEUE_FMT) return null;
  const ok = typeof raw.requestId === 'string' && typeof raw.seq === 'number' && Number.isSafeInteger(raw.seq) && raw.seq >= 1
    && typeof raw.deviceId === 'string' && typeof raw.type === 'string'
    && (raw.state === 'queued' || raw.state === 'sending' || raw.state === 'unconfirmed' || raw.state === 'answered')
    && typeof raw.createdWall === 'number' && typeof raw.createdMono === 'number' && typeof raw.pageAnchor === 'string' && typeof raw.offsetAtCreate === 'number'
    && isSealed(raw);
  if (!ok) return null;
  return { attempts: 0, madeOffline: false, ...raw } as unknown as QueueRecord;
}

export function upgradeSentRecord(raw: Rec): SentRecord | null {
  if (raw.fmt !== QUEUE_FMT) return null;
  const ok = typeof raw.requestId === 'string' && typeof raw.seq === 'number' && typeof raw.deviceId === 'string' && typeof raw.outcome === 'string'
    && typeof raw.epoch === 'string' && typeof raw.answeredAt === 'number' && isSealed(raw);
  return ok ? ({ reviews: [], rev: 0, piiStripped: false, createdWall: 0, offsetAtCreate: 0, ...raw } as unknown as SentRecord) : null;
}

const RETRYABLE = new Set(['INTERNAL', 'BUSY', 'SHOP_UNAVAILABLE']);
const FINAL_OUTCOMES = new Set<CommandOutcomeKey>(['applied', 'partially_applied', 'superseded', 'needs_review']);

/** 묶음 답의 한 결과가 기다렸다 다시 보낼 것인지(INTERNAL · BUSY · SHOP_UNAVAILABLE, 답이 없는 거절 코드도 INTERNAL로 본다). */
export function isRetryableResult(r: Pick<QueuedItemResult, 'outcome' | 'error'>): boolean {
  if (FINAL_OUTCOMES.has(r.outcome) || r.outcome === 'held') return false;
  return RETRYABLE.has(r.error?.code ?? 'INTERNAL');
}
/** 서버가 rev를 새로 적을 수 있는 결과(그 rev가 결과의 rev다). 그 밖(보류 · 거절 · 충돌 · 막힘)은 기록 줄만 쓰고 rev는 그때의 머리다. */
const MAY_WRITE_REV = new Set<CommandOutcomeKey>(['applied', 'partially_applied', 'superseded', 'needs_review']);

/**
 * 복구 기준(restoredUpToRev) 뒤라 되살린 자료에 없을 수 있는 기록인지(O20 · §17 R3-3, 검토 1회 data-loss 2). rev를 적은 결과는 그 rev가 기준보다 클
 * 때만이다(기준 이하는 되살린 자료에 들어 있어 다시 보내면 두 번이 될 수 있다). rev를 적지 않는 결과(보류 · 거절 · 충돌)의 rev는 그때의 머리라, 기준과
 * 같아도 그 기록 줄은 백업 뒤에 쓰였을 수 있다: 같거나 크면 다시 보낸다(남아 있으면 서버가 요청번호로 첫 결과를 준다). 보류가 사라져 기기에서도
 * 지워지는 일을 막는다.
 */
export function afterRestorePoint(outcome: unknown, rev: unknown, restoredUpToRev: number): boolean {
  const n = Number(rev);
  if (!Number.isFinite(n)) return false;
  return MAY_WRITE_REV.has(outcome as CommandOutcomeKey) ? n > restoredUpToRev : n >= restoredUpToRev;
}

/** 개인정보 칸을 뺀 값(PII_KEYS, 깊이). */
export function stripPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPii);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (!PII_KEYS.has(k)) out[k] = stripPii(v);
  return out;
}

export class SendQueue {
  /** 연 본문(요청번호 + iv로 가린다). */
  private readonly opened = new Map<string, CommandCore>();
  private readonly local: LocalStore;
  private readonly subtle: SubtleCrypto;

  constructor(local: LocalStore, subtle: SubtleCrypto = globalThis.crypto.subtle) {
    this.local = local;
    this.subtle = subtle;
  }

  get deviceId(): string {
    return this.local.deviceId;
  }

  // ── 읽기 ──────────────────────────────────────────────────────────

  /** 보냄 대기(기기 번호 차례)와 열지 못한 칸 수. */
  async list(): Promise<{ items: QueueItem[]; unreadable: number }> {
    let rows: Rec[] = [];
    await this.local.raw.tx(['queue'], 'readonly', (t) => t.all('queue', (v) => { rows = v; }));
    const items: QueueItem[] = [];
    let unreadable = 0;
    for (const raw of rows) {
      const rec = upgradeQueueRecord(raw);
      if (!rec) {
        unreadable += 1;
        continue;
      }
      const core = await this.open(rec);
      if (!core) {
        unreadable += 1;
        continue;
      }
      const { keyId: _k, iv: _iv, body: _b, ...meta } = rec;
      items.push({ ...meta, core });
    }
    items.sort((a, b) => a.seq - b.seq);
    return { items, unreadable };
  }

  /** 보낸 기록(본문은 열지 않는다). */
  async sent(): Promise<SentRecord[]> {
    let rows: Rec[] = [];
    await this.local.raw.tx(['sent'], 'readonly', (t) => t.all('sent', (v) => { rows = v; }));
    return rows.map(upgradeSentRecord).filter((r): r is SentRecord => r !== null).sort((a, b) => a.seq - b.seq);
  }

  /** 이 기기의 번호 셈: 다음 번호 · 서버가 받은 가장 큰 번호 · 준 가장 큰 번호. */
  async counter(): Promise<{ next: number; highWater: number; lastSeq: number }> {
    let c: Rec | undefined;
    await this.local.raw.tx(['counters'], 'readonly', (t) => t.get('counters', this.deviceId, (v) => { c = v; }));
    const next = typeof c?.next === 'number' ? c.next : 1;
    return { next, highWater: typeof c?.highWater === 'number' ? c.highWater : 0, lastSeq: next - 1 };
  }

  private async open(rec: QueueRecord | SentRecord): Promise<CommandCore | null> {
    const cacheKey = rec.requestId + '|' + rec.keyId + '|' + Array.from(rec.iv).join(',');
    const cached = this.opened.get(cacheKey);
    if (cached) return cached;
    const key = await this.local.keys.key(rec.keyId);
    if (!key) return null;
    try {
      const core = await unseal<CommandCore>(key, rec, sealContext('command', rec.requestId, rec.keyId), this.subtle);
      this.opened.set(cacheKey, core);
      return core;
    } catch (error) {
      if (error instanceof Unreadable) return null;
      throw error;
    }
  }

  // ── 넣기 ──────────────────────────────────────────────────────────

  /**
   * 보냄 대기에 넣는다(O9 · O22). prevalidate는 잠금 안에서 다시 읽은 보냄 대기로 확인 전 검사를 하고, 거절 · 충돌이면 그 결과를 돌려준다
   * (아무것도 넣지 않는다). 같은 요청번호가 이미 있으면 그 항목(보낸 기록이면 그 결과)을 돌려준다. 저장이 실패하면 던진다(연결 끊김 기록을 끈다).
   */
  async enqueue(
    core: CommandCore,
    clock: ItemClock,
    options: { madeOffline: boolean; prevalidate?: (items: QueueItem[]) => CommandOutcome | null | Promise<CommandOutcome | null> },
  ): Promise<EnqueueResult> {
    const result = await this.local.withLock('skinote-enqueue', async (): Promise<EnqueueResult> => {
      const { items } = await this.list();
      const existing = items.find((i) => i.requestId === core.requestId);
      if (existing) return { kind: 'queued', item: existing, created: false };
      const done = (await this.sent()).find((s) => s.requestId === core.requestId);
      if (done) return { kind: 'sent', outcome: done.outcome };
      const refusal = options.prevalidate ? await options.prevalidate(items) : null;
      if (refusal) return { kind: 'refused', outcome: refusal };
      const key = await this.local.keys.queueKey(this.deviceId);
      const sealed = await seal(key.key, key.id, sealContext('command', core.requestId, key.id), core, this.subtle);
      const taskId = taskIdOf(core.payload);
      const orderId = orderIdOf(core.payload, taskId);
      let record: QueueRecord | undefined;
      await this.local.raw.tx(['keys', 'counters', 'queue', 'sent'], 'readwrite', (t) => {
        requireKey(t, key.id, () => this.allocate(t, (seq) => {
          record = {
            fmt: QUEUE_FMT, requestId: core.requestId, seq, deviceId: this.deviceId, type: core.type,
            ...(taskId ? { taskId } : {}), ...(orderId ? { orderId } : {}),
            state: 'queued', attempts: 0, madeOffline: options.madeOffline, ...clock, ...sealed,
          };
          t.add('queue', record as unknown as Rec);
        }));
      }, { durability: 'strict' });
      const { keyId: _k, iv: _iv, body: _b, ...meta } = record!;
      return { kind: 'queued', item: { ...meta, core }, created: true };
    });
    if (result.kind === 'queued' && result.created) this.local.notify('queue');
    return result;
  }

  /**
   * 트랜잭션 안에서 새 번호 하나(O9): max(셈의 다음, 서버가 받은 가장 큰 번호 + 1, 이 기기 보냄 대기 · 보낸 기록의 가장 큰 번호 + 1). 셈을 올린다.
   */
  private allocate(t: TxRequests, then: (seq: number) => void): void {
    t.get('counters', this.deviceId, (c) => t.all('queue', (queue) => t.all('sent', (sent) => {
      const mine = (rows: Rec[]) => rows.reduce((max, r) => (r.deviceId === this.deviceId && typeof r.seq === 'number' ? Math.max(max, r.seq) : max), 0);
      const highWater = typeof c?.highWater === 'number' ? c.highWater : 0;
      const seq = Math.max(typeof c?.next === 'number' ? c.next : 1, highWater + 1, mine(queue) + 1, mine(sent) + 1);
      t.put('counters', { deviceId: this.deviceId, next: seq + 1, highWater });
      then(seq);
    })));
  }

  // ── 상태 바꾸기 ────────────────────────────────────────────────────

  /** 항목들의 상태를 바꾼다(없는 항목은 건너뜀). 보낸 뒤 · 답을 잃음 · 다시 보냄. */
  async setState(requestIds: readonly string[], state: QueueState, patch: Partial<QueueMeta> = {}): Promise<void> {
    if (requestIds.length === 0) return;
    const ids = new Set(requestIds);
    await this.local.raw.tx(['queue'], 'readwrite', (t) => t.all('queue', (rows) => {
      for (const r of rows) if (ids.has(String(r.requestId)) && r.state !== 'answered') t.put('queue', { ...r, ...patch, state });
    }));
    this.local.notify('queue');
  }

  /** 되돌리기: 보내던 항목들을 앞 상태로(보내지 못함 · 서버가 바빠 받지 않음). */
  async revert(previous: ReadonlyMap<string, QueueState>): Promise<void> {
    if (previous.size === 0) return;
    await this.local.raw.tx(['queue'], 'readwrite', (t) => t.all('queue', (rows) => {
      for (const r of rows) {
        const prev = previous.get(String(r.requestId));
        if (prev && r.state === 'sending') t.put('queue', { ...r, state: prev });
      }
    }));
    this.local.notify('queue');
  }

  /** 보내던 항목들 가운데 아직 보내는 중인 것만 결과 확인 중으로(보내기를 시작한 뒤 이 화면에서 던짐, §17 R3-6). */
  async unconfirmSending(requestIds: readonly string[]): Promise<void> {
    if (requestIds.length === 0) return;
    const ids = new Set(requestIds);
    await this.local.raw.tx(['queue'], 'readwrite', (t) => t.all('queue', (rows) => {
      for (const r of rows) if (ids.has(String(r.requestId)) && r.state === 'sending') t.put('queue', { ...r, state: 'unconfirmed' });
    }));
    this.local.notify('queue');
  }

  /** 시작할 때: 보내던 채 남은 항목(화면이 닫힘)은 결과 확인 중(O18 · R2 2). */
  async recoverSending(): Promise<number> {
    let n = 0;
    await this.local.raw.tx(['queue'], 'readwrite', (t) => t.all('queue', (rows) => {
      for (const r of rows) if (r.state === 'sending') { n += 1; t.put('queue', { ...r, state: 'unconfirmed' }); }
    }));
    if (n) this.local.notify('queue');
    return n;
  }

  /** 서버가 받은 가장 큰 번호를 셈에 적는다(다음 번호가 그 위에서 시작). */
  async noteHighWater(highWater: number): Promise<void> {
    await this.local.raw.tx(['counters'], 'readwrite', (t) => t.get('counters', this.deviceId, (c) => {
      const prev = typeof c?.highWater === 'number' ? c.highWater : 0;
      if (highWater <= prev) return;
      t.put('counters', { deviceId: this.deviceId, next: typeof c?.next === 'number' ? c.next : 1, highWater });
    }));
  }

  /**
   * 묶음의 답(§4-4): 적용 · 일부 적용 · 이미 됨 · 확인 필요 → answered(사본이 알릴 때까지 겹침), 보류 → 곧바로 보낸 기록, 거절: 다시 보낼 것
   * (INTERNAL · BUSY) → queued, SEQ_REUSED → 서버가 받은 번호 위로 새 번호, BAD_INPUT(항목이 너무 큼) → 혼자 보내도 안 되는 항목(이 판에서는
   * 건너뜀). 답보다 먼저 사본이 보낸 기록으로 옮긴 항목은 settled로 센다(보낸 것: 띠의 결과 줄, §17-4).
   */
  async answer(results: readonly QueuedItemResult[], epoch: string, now: number, appVersion: string): Promise<AnswerSummary> {
    const summary: AnswerSummary = { answered: 0, held: 0, settled: 0, retry: 0, stuck: 0, restamped: 0, notApplied: 0 };
    const restamp: string[] = [];
    const byId = new Map(results.map((r) => [r.requestId, r]));
    await this.local.raw.tx(['queue', 'sent'], 'readwrite', (t) => t.all('queue', (rows) => t.all('sent', (sentRows) => {
      // 보내는 사이 사본이 먼저 옮긴 항목(다시 보낸 묶음과 사본 받기가 겹침): 칸은 그대로 두고 보낸 것으로 센다.
      const inQueue = new Set(rows.map((raw) => String(raw.requestId)));
      for (const s of sentRows) {
        const r = byId.get(String(s.requestId));
        if (!r || inQueue.has(r.requestId) || r.deviceSeq !== s.seq || (!FINAL_OUTCOMES.has(r.outcome) && r.outcome !== 'held')) continue;
        summary.settled += 1;
        if (r.outcome !== 'applied') summary.notApplied += 1;
      }
      for (const raw of rows) {
        const r = byId.get(String(raw.requestId));
        if (!r || r.deviceSeq !== raw.seq) continue;
        const rec = raw as unknown as QueueRecord;
        if (r.outcome !== 'applied') summary.notApplied += 1;
        const code = r.error?.code !== undefined ? { errorCode: r.error.code } : {};
        if (r.outcome === 'held') {
          summary.held += 1;
          t.delete('queue', rec.requestId);
          t.put('sent', sentOf(rec, { outcome: 'held', rev: r.rev, reviews: r.reviews, ...code }, epoch, now) as unknown as Rec);
        } else if (FINAL_OUTCOMES.has(r.outcome)) {
          summary.answered += 1;
          t.put('queue', { ...raw, state: 'answered', outcome: r.outcome, answeredRev: r.rev, answeredEpoch: epoch, reviews: r.reviews, ...code });
        } else {
          const code = r.error?.code ?? 'INTERNAL';
          const base = { ...raw, state: 'queued', attempts: rec.attempts + 1, lastError: code };
          if (code === 'SEQ_REUSED') {
            summary.restamped += 1;
            restamp.push(rec.requestId);
            t.put('queue', base);
          } else if (!RETRYABLE.has(code)) {
            summary.stuck += 1;
            t.put('queue', { ...base, stuckVersion: appVersion });
          } else {
            summary.retry += 1;
            t.put('queue', base);
          }
        }
      }
    })));
    for (const id of restamp) await this.restamp(id);
    this.local.notify('queue');
    return summary;
  }

  /** 혼자 보내도 거절되는 항목(400): 이 앱 판에서는 건너뛰고 stuckSeq로 알린다(O6). */
  async markStuck(requestId: string, error: string, appVersion: string): Promise<void> {
    await this.local.raw.tx(['queue'], 'readwrite', (t) => t.get('queue', requestId, (r) => {
      if (r) t.put('queue', { ...r, state: 'queued', lastError: error, stuckVersion: appVersion, attempts: (typeof r.attempts === 'number' ? r.attempts : 0) + 1 });
    }));
    this.local.notify('queue');
  }

  /** SEQ_REUSED: 같은 요청번호에 서버가 받은 번호 위의 새 번호(서명은 보낼 때 다시). */
  async restamp(requestId: string): Promise<number | null> {
    let seq: number | null = null;
    await this.local.withLock('skinote-enqueue', () => this.local.raw.tx(['counters', 'queue', 'sent'], 'readwrite', (t) => t.get('queue', requestId, (r) => {
      if (!r) return;
      this.allocate(t, (next) => {
        seq = next;
        t.put('queue', { ...r, seq: next, state: 'queued' });
      });
    }), { durability: 'strict' }));
    if (seq !== null) this.local.notify('queue');
    return seq;
  }

  /**
   * 사본의 recorded에 든 항목을 보낸 기록으로(사본을 쓰는 트랜잭션 안, O4): 그 사본이 이 항목을 이미 담았으니 더 겹치지 않는다. 답을 잃은
   * 항목도 여기서 결과를 안다.
   */
  settleInTx(t: TxRequests, recorded: readonly RecordedItem[], epoch: string, now: number): void {
    if (recorded.length === 0) return;
    const byId = new Map(recorded.map((r) => [r.requestId, r]));
    t.all('queue', (rows) => {
      for (const raw of rows) {
        const r = byId.get(String(raw.requestId));
        if (!r) continue;
        const rec = raw as unknown as QueueRecord;
        // 오류 코드: 사본의 것, 없으면(옛 서버) 같은 결과로 답을 받았던 항목의 것.
        const errorCode = r.errorCode ?? (rec.outcome === r.outcome ? rec.errorCode : undefined);
        t.delete('queue', rec.requestId);
        t.put('sent', sentOf(rec, { outcome: r.outcome, rev: r.rev, reviews: r.reviews, ...(errorCode !== undefined ? { errorCode } : {}) }, epoch, now) as unknown as Rec);
      }
    });
  }

  /**
   * 서버가 받지 못했다는 번호(missing): 이 epoch의 보낸 기록 · 답을 받은 항목이면 같은 번호로 다시 보낸다(O9). 이 epoch가 복구로 온 것이면
   * (meta.restoredEpoch) 그 기준 rev 뒤의 옛 epoch 기록도 본다(§17 R3-3: 사본 없이 복구를 맞은 기기). 새로 만든 시험 매장의 빠진 번호에는 옛
   * 기록을 넣지 않는다(R3-1): 보낸 기록도, 아직 사본에 들지 않은 답을 받은 항목도(§17-4: 답의 epoch를 본다). 기기가 아는 epoch보다 옛 epoch의
   * 답(늦게 온 답)이 알린 빈 번호는 쓰지 않는다.
   */
  async resendMissing(missing: readonly number[], epoch: string): Promise<number> {
    if (missing.length === 0) return 0;
    const seqs = new Set(missing);
    const meta = await this.local.readMeta().catch(() => null);
    if (meta?.epoch !== undefined && epoch < meta.epoch) return 0;
    const floor = meta?.restoredEpoch === epoch ? meta.restoredUpToRev : undefined;
    /** 이 epoch에서 답을 받았거나, 이 epoch가 복구로 왔고 그 기준 뒤의 옛 epoch 답인지. */
    const resend = (recordEpoch: unknown, outcome: unknown, rev: unknown) => recordEpoch === epoch
      || (floor !== undefined && typeof recordEpoch === 'string' && recordEpoch !== '' && recordEpoch < epoch && afterRestorePoint(outcome, rev, floor));
    let n = 0;
    await this.local.raw.tx(['queue', 'sent'], 'readwrite', (t) => {
      t.all('queue', (rows) => {
        for (const r of rows) {
          if (r.deviceId !== this.deviceId || !seqs.has(Number(r.seq)) || r.state !== 'answered' || !resend(r.answeredEpoch, r.outcome, r.answeredRev)) continue;
          n += 1;
          t.put('queue', { ...r, state: 'queued' });
        }
      });
      t.all('sent', (rows) => {
        for (const r of rows) {
          if (r.deviceId !== this.deviceId || !seqs.has(Number(r.seq))) continue;
          const same = r.epoch === epoch && r.outcome !== 'held';
          const olderAfterRestore = r.epoch !== epoch && resend(r.epoch, r.outcome, r.rev);
          if (!same && !olderAfterRestore) continue;
          n += 1;
          t.delete('sent', String(r.requestId));
          t.put('queue', backToQueue(r as unknown as SentRecord));
        }
      });
    });
    if (n) this.local.notify('queue');
    return n;
  }

  /**
   * 복구 뒤(O20 · §17 R3-1 · R3-3): 지금 epoch보다 옛 epoch에서 restoredUpToRev 뒤에 적용된(또는 보류된) 보낸 기록 · 답을 받은 항목을 같은 요청번호 ·
   * 같은 번호로 보냄 대기에 되돌린다(더 새 항목보다 번호가 작아 먼저 간다). 사본이 없어도 기록 자체의 epoch로 본다. 서버는 요청번호로 한 번만 적용하고,
   * 보류가 남아 있으면 보류를 다시 준다. 기준 뒤인지는 afterRestorePoint(보류 · 거절처럼 rev를 적지 않은 결과는 기준과 같아도 보낸다).
   */
  async requeueAfterRestore(currentEpoch: string, restoredUpToRev: number): Promise<number> {
    let n = 0;
    const older = (epoch: unknown) => typeof epoch === 'string' && epoch !== '' && epoch < currentEpoch;
    await this.local.withLock('skinote-enqueue', () => this.local.raw.tx(['queue', 'sent'], 'readwrite', (t) => {
      t.all('queue', (rows) => {
        for (const r of rows) {
          if (r.state === 'answered' && older(r.answeredEpoch) && afterRestorePoint(r.outcome, r.answeredRev, restoredUpToRev)) {
            n += 1;
            const { outcome: _o, answeredRev: _r, answeredEpoch: _e, reviews: _v, errorCode: _c, ...rest } = r;
            t.put('queue', { ...rest, state: 'queued' });
          }
        }
      });
      t.all('sent', (rows) => {
        for (const r of rows) {
          if (!older(r.epoch) || !afterRestorePoint(r.outcome, r.rev, restoredUpToRev)) continue;
          n += 1;
          t.delete('sent', String(r.requestId));
          t.put('queue', backToQueue(r as unknown as SentRecord));
        }
      });
    }, { durability: 'strict' }));
    if (n) this.local.notify('queue');
    return n;
  }

  /**
   * 복구가 아닌 epoch 바뀜(시험 매장 새로 만들기 · 복구 기준을 모름, §17 R3-1): 옛 epoch에서 답을 받은 항목을 그대로 보낸 기록으로 옮긴다(더 겹쳐 그리지
   * 않고 다시 보내지도 않는다). 보낸 기록은 그대로 둔다. 아직 답을 받지 않은 항목은 그대로 보낸다(기기에서 일어난 사실).
   */
  async settleOldEpoch(currentEpoch: string, now: number): Promise<number> {
    let n = 0;
    await this.local.withLock('skinote-enqueue', () => this.local.raw.tx(['queue', 'sent'], 'readwrite', (t) => {
      t.all('queue', (rows) => {
        for (const raw of rows) {
          const epoch = raw.answeredEpoch;
          if (raw.state !== 'answered' || typeof epoch !== 'string' || epoch === '' || epoch >= currentEpoch) continue;
          const rec = raw as unknown as QueueRecord;
          n += 1;
          t.delete('queue', rec.requestId);
          t.put('sent', sentOf(rec, { outcome: rec.outcome ?? 'applied', rev: rec.answeredRev ?? 0, reviews: rec.reviews ?? [], ...(rec.errorCode !== undefined ? { errorCode: rec.errorCode } : {}) }, epoch, now) as unknown as Rec);
        }
      });
    }, { durability: 'strict' }));
    if (n) this.local.notify('queue');
    return n;
  }

  /** 기록이 아는 가장 새 epoch(보낸 기록 · 답을 받은 항목, 없으면 undefined): 기기 메모에 epoch가 없던 기기의 기준. */
  async latestEpoch(): Promise<string | undefined> {
    let found: string | undefined;
    const take = (e: unknown) => { if (typeof e === 'string' && e !== '' && (found === undefined || e > found)) found = e; };
    await this.local.raw.tx(['queue', 'sent'], 'readonly', (t) => {
      t.all('queue', (rows) => { for (const r of rows) take(r.answeredEpoch); });
      t.all('sent', (rows) => { for (const r of rows) take(r.epoch); });
    });
    return found;
  }

  /**
   * 보낸 기록 정리(O14 f): sentLogDays 지난 것은 지우고, sentPiiHours 지난 것은 개인정보 칸을 뺀 본문으로 다시 봉인한다. 보냄 대기는 건드리지
   * 않는다.
   */
  async pruneSent(now: number, sentLogDays: number, sentPiiHours: number): Promise<{ removed: number; stripped: number }> {
    const all = await this.sent();
    const old = all.filter((s) => s.answeredAt < now - sentLogDays * 86_400_000);
    const strip = all.filter((s) => !s.piiStripped && s.answeredAt < now - sentPiiHours * 3_600_000 && !old.includes(s));
    const resealed: Rec[] = [];
    for (const s of strip) {
      const core = await this.open(s);
      if (!core) continue;
      const key = await this.local.keys.key(s.keyId);
      if (!key) continue;
      const cleaned = stripPii(core);
      resealed.push({ ...s, piiStripped: true, ...(await seal(key, s.keyId, sealContext('command', s.requestId, s.keyId), cleaned, this.subtle)) });
    }
    if (old.length === 0 && resealed.length === 0) return { removed: 0, stripped: 0 };
    await this.local.raw.tx(['sent'], 'readwrite', (t) => {
      for (const s of old) t.delete('sent', s.requestId);
      for (const r of resealed) t.put('sent', r);
    });
    return { removed: old.length, stripped: resealed.length };
  }

  /** 보낸 기록 하나의 본문(행 메모 · 시험). */
  async sentCore(record: SentRecord): Promise<CommandCore | null> {
    return this.open(record);
  }
}

/** 보냄 대기 칸 → 보낸 기록 칸(봉인은 그대로). */
function sentOf(rec: QueueRecord, answer: { outcome: CommandOutcomeKey; rev: number; reviews: string[]; errorCode?: string }, epoch: string, now: number): SentRecord {
  return {
    fmt: QUEUE_FMT, requestId: rec.requestId, seq: rec.seq, deviceId: rec.deviceId, type: rec.type,
    ...(rec.taskId ? { taskId: rec.taskId } : {}), ...(rec.orderId ? { orderId: rec.orderId } : {}),
    outcome: answer.outcome, rev: answer.rev, epoch, reviews: [...answer.reviews], ...(answer.errorCode !== undefined ? { errorCode: answer.errorCode } : {}),
    answeredAt: now, piiStripped: false,
    createdWall: rec.createdWall, offsetAtCreate: rec.offsetAtCreate, keyId: rec.keyId, iv: rec.iv, body: rec.body,
  };
}

/** 보낸 기록 → 보냄 대기(같은 번호, 앞 화면의 항목이라 나이는 벽시계로). */
function backToQueue(s: SentRecord): Rec {
  return {
    fmt: QUEUE_FMT, requestId: s.requestId, seq: s.seq, deviceId: s.deviceId, type: s.type, ...(s.taskId ? { taskId: s.taskId } : {}),
    ...(s.orderId ? { orderId: s.orderId } : {}), state: 'queued', attempts: 0, madeOffline: true,
    createdWall: s.createdWall, createdMono: 0, pageAnchor: '', offsetAtCreate: s.offsetAtCreate, keyId: s.keyId, iv: s.iv, body: s.body,
  };
}

// LocalClient(work/impl-offline/plan.md §7-3 · O1 · O2): 기사 기기의 사본(차량 범위 ShopState) 위에 보냄 대기를 겹쳐(@skinote/domain overlayQueue)
// 서버와 같은 읽기 모델을 그린다. 체험판의 FixtureClient처럼 도메인을 브라우저에서 돌리지만, 자료는 서버가 준 사본이고 기록은 보냄 대기로 간다.
//   - 읽기: 서버의 기사 세션 규칙(DRIVER_QUERY_RULES)을 그대로 따른다. deny는 FORBIDDEN, 목록은 자기 차량으로 바꿔 읽고, 업무 판 · 확인 창 초안 ·
//     전화는 그 업무 · 접수가 자기 차량에 있을 때만. 사본이 없거나 열 수 없으면 NETWORK(화면은 `연결 끊김 · … 조회 실패`).
//   - 지금 = 서버 시각 짐작. 영업일은 사본의 기준 시각(06:00)으로 다시 센다(끊긴 채 06:00을 넘겨도 새 날의 목록).
//   - 명령: 이 기기 종류가 끊긴 채 넣을 수 있는 명령(sys_offline_commands ∩ 명령)만 보냄 대기에 넣는다. 확인 전 검사(§5-8: epoch · 기준 없이,
//     돈의 바탕 · 남은 수는 본다)로 거절 · 충돌이면 창에 그대로 돌려주고 넣지 않는다. 다른 명령은 한 줄 거절(`입고 불가 · 연결 끊김` …).
//     저장이 실패하면 `전송 실패 · 재전송 필요`를 돌려주고 연결 끊김 기록을 끈다(O2).
//   - 기기 자신의 답(보낸 기록 · 답을 받은 항목): 줄 메모(§5-9 `매장 반납 완료` · `수거 수량 확인` · `중복 수납 의심` · `처리 보류 · …`).
import {
  BATCH_LIMITS, DomainError, driverQueryKey, driverQueryRule, isAccepted, offlineCommandTypes,
  type AnyCommandEnvelope, type CommandOutcome, type CommandOutcomeKey, type CommandType, type ConnectionState, type DomainClient, type LedgerViewResult,
  type PendingCommand, type QueryName, type QueryParams, type QueryResult, type SyncHead, type UiConfig, type ViewParams,
} from '@skinote/contract';
import {
  PRODUCTION_LINES, execute, ledgerView, outcomeNoteKey, overlayQueue, pendingLine, pendingSummary, queryScope, runQuery,
  type DeviceOutcome, type DomainLines, type OverlayItem, type OverlayResult, type ReadContext, type ShopState,
} from '@skinote/domain';
import { localBusinessDate, type ItemClock } from './clock.ts';
import type { CopyHead, LocalStore } from './local-store.ts';
import { coreOf, overlayEnvelope, type QueueItem, type SendQueue, type SentRecord } from './queue.ts';
import type { LocalWords } from './words.ts';

export type DriverKind = 'driver_phone' | 'driver_tablet';

export interface LocalClientOptions {
  local: LocalStore;
  queue: SendQueue;
  device: { id: string; kind: DriverKind };
  staff: { id: string; name: string };
  /** 세션의 공개 id(보냄 대기 봉투의 recordedBy.sessionId). */
  sessionId: string;
  /** 서버 시각 짐작(ms). */
  serverNow(): number;
  /** 새 항목의 시계. */
  stamp(): ItemClock;
  /** 지금 연결이 끊겼는지(항목의 madeOffline). */
  offline(): boolean;
  lines?: DomainLines;
  /** 창에 돌려주는 한 줄들(앱 문구 표). */
  words: LocalWords;
  /** 세션이 맡은 차량(다른 차량의 사본은 그리지 않는다). */
  vehicleId?: string;
  /** 기기 벽시계(보낸 기록의 줄 메모를 두는 하루). */
  wallNow?: () => number;
  /** 보냄 대기 밖에서 이 기기에 남은 기록 수(답을 잃은 온라인 명령, DriverClient): 바닥줄 · 업무 판의 `전송 대기`에 더한다(§18 R4-11). */
  extraPending?: () => number;
}

/** 기기 자신의 답을 줄 메모로 두는 동안(24시간). */
const OUTCOME_NOTE_MS = 24 * 3_600_000;

/** 보낼 봉투 한 항목의 여유(기기 번호 · 나이 · 시계 · 만든 때 · 서명 칸, O6의 8 KiB 안). */
const ITEM_ROOM = 512;

/** 끊긴 기사 기기에서 연결이 있어야 하는 명령의 한 줄(§9). */
export function offlineRefusalLine(type: CommandType, words: LocalWords): string {
  if (type === 'stock.receive') return words.receiveNeedsLink;
  if (type === 'cash.transfer') return words.handoverNeedsLink;
  if (type === 'payment_promise.set') return words.deferNeedsLink;
  return words.offlineLater;
}

/** 거절 결과 하나(창이 한 줄을 보이고 열린 채 남는다). */
export function refusalOutcome(envelope: AnyCommandEnvelope, code: string, message: string, state?: { rev: number; epoch: string }): CommandOutcome {
  return {
    outcome: 'rejected', requestId: envelope.requestId, rev: state?.rev ?? envelope.basis.rev, asOfRev: envelope.basis.rev, epoch: state?.epoch ?? envelope.basis.epoch,
    rebased: false, changes: [], error: { code, message },
  };
}

/** 줄 메모의 종류(§5-9): 도메인의 outcomeNoteKey(체험판과 같은 셈). */
export { outcomeNoteKey };

interface LoadedCopy {
  head: CopyHead;
  state: ShopState;
  config: UiConfig;
  version: number;
}

export class LocalClient implements DomainClient {
  private readonly o: LocalClientOptions;
  private readonly lines: DomainLines;
  private readonly listeners = new Set<(head: SyncHead) => void>();
  private copy: LoadedCopy | null = null;
  private copyState: 'none' | 'format' | 'unreadable' | 'ok' = 'none';
  private items: QueueItem[] = [];
  private unreadable = 0;
  private sentRecent: SentRecord[] = [];
  private version = 0;
  private cache: { key: string; result: OverlayResult } | null = null;
  private recordingOff = false;
  private copyTurn = 0;
  private queueTurn = 0;
  private readonly offNotice: () => void;
  private closed = false;

  constructor(options: LocalClientOptions) {
    this.o = options;
    this.lines = options.lines ?? PRODUCTION_LINES;
    this.offNotice = options.local.onNotice((notice) => {
      // 다른 화면이 넣은 · 받은 · 지운 것: 다시 읽는다(O22). 지움(shred)은 부르는 쪽(DriverClient)이 로그인으로 보낸다.
      void this.reload(notice.kind === 'queue' ? 'queue' : 'all');
    });
  }

  close(): void {
    this.closed = true;
    this.offNotice();
    this.listeners.clear();
  }

  // ── 저장소에서 다시 읽기 ───────────────────────────────────────────

  /** 사본 · 보냄 대기 · 보낸 기록을 다시 읽고 화면에 알린다. 겹친 읽기는 늦게 시작한 것만 남는다(먼저 시작한 느린 읽기가 새것을 덮지 않게). */
  async reload(what: 'all' | 'queue' | 'copy' = 'all'): Promise<void> {
    if (what === 'all' || what === 'copy') {
      const turn = ++this.copyTurn;
      const read = await this.o.local.readCopy();
      // 그사이 시작한 사본 읽기가 있으면 이 사본은 버린다(보냄 대기 몫은 아래에서 따로 본다).
      if (turn === this.copyTurn) this.applyCopy(read);
    }
    if (what === 'all' || what === 'queue') {
      const turn = ++this.queueTurn;
      const listed = await this.o.queue.list();
      const since = (this.o.wallNow ?? Date.now)() - OUTCOME_NOTE_MS;
      const sent = (await this.o.queue.sent()).filter((s) => s.answeredAt >= since);
      if (turn === this.queueTurn) {
        this.items = listed.items;
        this.unreadable = listed.unreadable;
        this.sentRecent = sent;
        this.version += 1;
      }
    }
    this.emit();
  }

  private applyCopy(read: Awaited<ReturnType<LocalStore['readCopy']>>): void {
    if (read.status === 'ok' && this.o.vehicleId !== undefined && read.head.vehicleId !== this.o.vehicleId) {
      // 다른 차량의 사본(같은 기기에서 차량을 바꾼 로그인): 새 사본이 올 때까지 그리지 않는다.
      this.copyState = 'none';
      this.copy = null;
    } else if (read.status === 'ok') {
      this.copyState = 'ok';
      const state = read.body.state;
      // 머리의 rev가 본문보다 늦을 수 있다(같은 내용의 새 판, unchanged): 창의 기준은 머리의 것.
      state.rev = Math.max(state.rev, read.head.rev);
      this.copy = { head: read.head, state, config: read.body.config, version: ++this.version };
    } else {
      this.copyState = read.status;
      this.copy = null;
    }
  }

  /** 사본이 있어 그릴 수 있는지. */
  hasCopy(): boolean {
    return this.copy !== null;
  }

  /** 사본의 상태(없음 · 이 빌드가 모르는 형식 · 열 수 없음 · 됨). */
  copyStatus(): 'none' | 'format' | 'unreadable' | 'ok' {
    return this.copyState;
  }

  copyHead(): CopyHead | null {
    return this.copy?.head ?? null;
  }

  /** 오늘 영업일(서버 시각 짐작 + 사본의 기준 시각). 사본이 없으면 null. */
  today(): string | null {
    return this.copy ? localBusinessDate(this.copy.state, this.o.serverNow()) : null;
  }

  /** 보냄 대기(기기 번호 차례). */
  queueItems(): readonly QueueItem[] {
    return this.items;
  }

  unreadableCount(): number {
    return this.unreadable;
  }

  isRecordingOff(): boolean {
    return this.recordingOff;
  }

  /** 대기 수(보냄 대기 + 보내는 중 + 결과 확인 중)와 그중 결과 확인 중, 가장 오래된 것. */
  counts(): { pending: number; unconfirmed: number; oldest?: number } {
    const waiting = this.items.filter((i) => i.state !== 'answered');
    const oldest = waiting.reduce<number | undefined>((min, i) => (min === undefined ? i.createdWall + i.offsetAtCreate : Math.min(min, i.createdWall + i.offsetAtCreate)), undefined);
    return { pending: waiting.length, unconfirmed: waiting.filter((i) => i.state === 'unconfirmed').length, ...(oldest !== undefined ? { oldest } : {}) };
  }

  // ── 겹친 상태 ─────────────────────────────────────────────────────

  /** 사본 + 보냄 대기(겹침). 사본이 없으면 NETWORK. */
  private overlaid(): { state: ShopState; result: OverlayResult; copy: LoadedCopy } {
    const copy = this.copy;
    if (!copy) throw new DomainError('NETWORK', this.copyState === 'none' ? 'no copy' : 'copy ' + this.copyState);
    const today = localBusinessDate(copy.state, this.o.serverNow());
    const key = copy.version + ':' + this.version + ':' + today;
    if (!this.cache || this.cache.key !== key) {
      const base: ShopState = { ...copy.state, businessDate: today };
      const result = overlayQueue(base, this.overlayItems(this.items), { lines: this.lines, actor: this.actor() });
      result.state.rev = copy.state.rev;
      this.cache = { key, result };
    }
    return { state: this.cache.result.state, result: this.cache.result, copy };
  }

  private overlayItems(items: readonly QueueItem[]): OverlayItem[] {
    return items.filter((i) => i.outcome !== 'held').map((i) => ({
      envelope: overlayEnvelope(i), at: i.createdWall + i.offsetAtCreate, state: i.state, ...(i.outcome ? { outcome: i.outcome } : {}),
    }));
  }

  private actor(): { staffId: string; name: string; deviceId: string } {
    return { staffId: this.o.staff.id, name: this.o.staff.name, deviceId: this.o.device.id };
  }

  /** 기기 자신의 답(답을 받은 항목 · 하루 안의 보낸 기록) → 업무마다 줄 메모. */
  private deviceOutcomes(): Map<string, DeviceOutcome> {
    const out = new Map<string, DeviceOutcome>();
    const note = (taskId: string | undefined, key: DeviceOutcome['key'] | null, at: number) => {
      if (!taskId || !key) return;
      const prev = out.get(taskId);
      if (!prev || prev.at <= at) out.set(taskId, { key, at });
    };
    const more = (x: { type: string; errorCode?: string }) => ({ type: x.type, ...(x.errorCode !== undefined ? { errorCode: x.errorCode } : {}) });
    for (const s of this.sentRecent) note(s.taskId, outcomeNoteKey(s.outcome, s.reviews, more(s)), s.answeredAt);
    for (const i of this.items) if (i.state === 'answered') note(i.taskId, outcomeNoteKey(i.outcome, i.reviews, more(i)), i.createdWall);
    return out;
  }

  /** 읽기 문맥(서버의 기사 세션과 같은 것 + 기기의 점선 · 결과 확인 중 · 사본 밖 수 · 줄 메모). */
  private context(): { state: ShopState; ctx: ReadContext; own: string } {
    const { state, result, copy } = this.overlaid();
    const ctx: ReadContext = {
      config: copy.config, now: this.o.serverNow(), lines: this.lines, pendingTasks: result.pendingTasks, unconfirmedTasks: result.unconfirmedTasks,
      unplacedCount: result.unplaced.length, deviceOutcomes: this.deviceOutcomes(), pendingMoney: result.pendingMoney,
      // 바닥줄 · 업무 판의 `전송 대기`: 띠 · 더 보기 · 전송 대기 목록과 같은 수(답을 받지 않은 기록 + 답을 잃은 온라인 명령, §18 R4-11).
      pendingRecordCount: this.counts().pending + (this.o.extraPending?.() ?? 0),
    };
    return { state, ctx, own: copy.head.vehicleId };
  }

  // ── DomainClient ──────────────────────────────────────────────────

  async config(): Promise<UiConfig> {
    if (!this.copy) throw new DomainError('NETWORK', 'no copy');
    return structuredClone(this.copy.config);
  }

  async ledgerView(viewKey: string, params: ViewParams): Promise<LedgerViewResult> {
    const rule = driverQueryRule(driverQueryKey('ledgerView', viewKey));
    if (rule !== 'own_list' && rule !== 'allow') throw new DomainError('FORBIDDEN', 'ledgerView:' + viewKey);
    const { state, ctx, own } = this.context();
    return structuredClone(ledgerView(state, viewKey, rule === 'own_list' ? { ...params, vehicleId: own } : params, ctx));
  }

  async query<Q extends QueryName>(name: Q, params: QueryParams[Q]): Promise<QueryResult[Q]> {
    const rule = driverQueryRule(driverQueryKey(name));
    if (rule === 'deny' || rule === 'own_list') throw new DomainError('FORBIDDEN', name);
    const { state, ctx, own } = this.context();
    if (rule === 'own_vehicle' && (name !== 'vehicleLoad' || (params as QueryParams['vehicleLoad']).vehicleId !== own)) throw new DomainError('FORBIDDEN', name);
    if (rule === 'task_scope') {
      const scope = queryScope(state, name, params);
      if (!scope || scope.kind !== 'vehicle' || !scope.vehicleIds.includes(own)) throw new DomainError('FORBIDDEN', name);
    }
    return structuredClone(runQuery(state, name, params, ctx));
  }

  async command(envelope: AnyCommandEnvelope): Promise<CommandOutcome> {
    const state = this.copy ? { rev: this.copy.state.rev, epoch: this.copy.head.epoch } : undefined;
    if (!(offlineCommandTypes(this.o.device.kind) as readonly string[]).includes(envelope.type)) {
      return refusalOutcome(envelope, 'OFFLINE', offlineRefusalLine(envelope.type, this.o.words), state);
    }
    // 저장할 곳이 없다: 연결되어 있으면 다시 누르면 서버로 바로 가고(DriverClient), 끊겼으면 종이에 적을 일이다(§17 R3-25).
    if (this.recordingOff) return refusalOutcome(envelope, 'RECORDING_OFF', this.o.offline() ? this.o.words.recordNeedsPaper : this.o.words.sendFailed, state);
    const core = coreOf(envelope, { staffId: this.o.staff.id, sessionId: this.o.sessionId });
    if (new TextEncoder().encode(JSON.stringify(core)).length > BATCH_LIMITS.itemBytes - ITEM_ROOM) return refusalOutcome(envelope, 'BAD_INPUT', this.o.words.sendFailed, state);
    let result;
    let caughtUp = false;
    try {
      result = await this.o.queue.enqueue(core, this.o.stamp(), {
        madeOffline: this.o.offline(),
        // 잠금 안에서: 다른 화면이 그사이 새 사본을 썼으면(보낸 항목이 보냄 대기에서 사본으로 옮겨짐) 그 사본부터 읽고 검사한다(O22).
        prevalidate: async (items) => { caughtUp = await this.catchUpCopy(); return this.prevalidate(envelope, items); },
      });
    } catch {
      // 저장할 곳이 없다(용량 · 사생활 보호 창 · 지운 열쇠): 창은 초안을 쥔 채 한 줄, 이 화면은 연결 끊김 기록을 끈다(O2).
      this.recordingOff = true;
      this.emit();
      return refusalOutcome(envelope, 'RECORDING_OFF', this.o.offline() ? this.o.words.recordNeedsPaper : this.o.words.sendFailed, state);
    }
    if (result.kind === 'refused') {
      // 거절은 잠금 안에서 다시 읽은 보냄 대기로 셈했다: 창이 다시 묻는 판도 같은 자료로 그리게 이 화면의 보냄 대기를 다시 읽는다.
      await this.reload('queue').catch(() => {});
      return result.outcome;
    }
    // 새 사본을 읽었으면 보냄 대기도 다시 읽는다(사본에 든 항목을 두 번 겹치지 않게).
    if ((result.kind === 'queued' && result.created) || caughtUp) await this.reload('queue');
    const base = { requestId: envelope.requestId, rev: state?.rev ?? envelope.basis.rev, asOfRev: envelope.basis.rev, epoch: state?.epoch ?? envelope.basis.epoch, rebased: false, changes: [] };
    // 이미 보내 답을 받은 요청번호(다시 누른 창): 그 결과. 아직 보냄 대기면 queued(창을 닫고 목록은 점선).
    if (result.kind === 'sent') return { ...base, outcome: result.outcome === 'held' ? 'queued' : result.outcome };
    return { ...base, outcome: 'queued' };
  }

  /**
   * 저장된 사본이 이 화면이 든 사본보다 새것이면(다른 화면이 사본을 받으며 답을 받은 항목을 보낸 기록으로 옮김) 그것을 읽는다. 알림(BroadcastChannel)을
   * 아직 처리하지 않은 화면이 옛 사본 + 줄어든 보냄 대기로 검사해 같은 돈을 다시 받는 틈을 막는다(O22). 읽지 못하면 든 사본으로 검사한다.
   */
  private async catchUpCopy(): Promise<boolean> {
    try {
      const stored = await this.o.local.copyHead();
      const mine = this.copy?.head;
      if (!stored || (mine && stored.epoch === mine.epoch && stored.rev === mine.rev && stored.hash === mine.hash)) return false;
      const turn = ++this.copyTurn;
      const read = await this.o.local.readCopy();
      if (turn !== this.copyTurn) return false;
      this.applyCopy(read);
      return true;
    } catch {
      // 저장소를 읽지 못함: 든 사본으로 검사한다(넣기는 뒤의 트랜잭션이 가린다).
      return false;
    }
  }

  /**
   * 확인 전 검사(§5-8): 잠금 안에서 다시 읽은 보냄 대기를 사본에 겹친 상태에서, epoch · 기준 없이 명령을 적용해 본다. 거절 · 충돌 · 멈춤이면 그 결과
   * (창이 그대로 보인다), 되면 null.
   */
  private prevalidate(envelope: AnyCommandEnvelope, items: readonly QueueItem[]): CommandOutcome | null {
    if (!this.copy) return null;
    const base: ShopState = { ...this.copy.state, businessDate: localBusinessDate(this.copy.state, this.o.serverNow()) };
    const others = items.filter((i) => i.requestId !== envelope.requestId);
    const over = overlayQueue(base, this.overlayItems(others), { lines: this.lines, actor: this.actor() });
    const sent = new Map(this.sentRecent.map((s) => [s.requestId, s.outcome]));
    const { deviceSeq: _seq, ...plain } = envelope as AnyCommandEnvelope & { deviceSeq?: number };
    const exec = execute(over.state, plain as AnyCommandEnvelope, {
      now: this.o.serverNow(), lines: this.lines, orderIds: 'dated', prevalidate: true,
      actor: { key: 'staff:' + this.o.staff.id, name: this.o.staff.name, deviceId: this.o.device.id },
      outcomeOf: (id) => {
        const o = over.outcomes.get(id);
        if (o) return { outcome: o.outcome };
        const s = sent.get(id);
        return s ? { outcome: s } : undefined;
      },
    });
    return isAccepted(exec.outcome) ? null : exec.outcome;
  }

  subscribe(onChange: (head: SyncHead) => void): () => void {
    this.listeners.add(onChange);
    return () => { this.listeners.delete(onChange); };
  }

  connection(): ConnectionState {
    const c = this.counts();
    return {
      online: false, pendingCount: c.pending, sendQueue: true, ...(c.unconfirmed ? { unconfirmedCount: c.unconfirmed } : {}),
      ...(this.recordingOff ? { recordingOff: true as const } : {}),
    };
  }

  /** 답을 잃은 온라인 명령(현금 인계 · 매장 입고 …)의 전송 대기 목록 한 줄(보냄 대기와 같은 말, §17 R3-19). */
  pendingEntry(envelope: AnyCommandEnvelope, at: number): PendingCommand {
    const line = pendingLine(this.copy?.state, envelope, at);
    return { requestId: envelope.requestId, type: envelope.type, state: 'unconfirmed', createdAt: new Date(at).toISOString(), summary: pendingSummary(line), line };
  }

  /**
   * 보냄 대기 목록(답을 받지 않은 것, 기기 번호 차례). 한 줄은 팀 · 끝 4자리 · 일 이름 · 돈 · 시각(체험판과 같은 말, domain pendingLine, §17 R3-19).
   * 팀은 사본에서 찾는다(사본이 없으면 팀 없이).
   */
  async pending(): Promise<PendingCommand[]> {
    const state = this.copy?.state;
    return this.items.filter((i) => i.state !== 'answered').map((i) => {
      const at = i.createdWall + i.offsetAtCreate;
      const line = pendingLine(state, overlayEnvelope(i), at);
      return {
        requestId: i.requestId, type: i.type, state: i.state === 'answered' ? 'applied' : i.state, createdAt: new Date(at).toISOString(),
        summary: pendingSummary(line), line,
      };
    });
  }

  /** 화면에 알린다(다시 읽기). */
  emit(): void {
    if (this.closed) return;
    const head: SyncHead = { epoch: this.copy?.head.epoch ?? '', rev: this.copy?.state.rev ?? 0, configRev: this.copy?.head.configRev ?? 0 };
    for (const l of [...this.listeners]) l(head);
  }
}

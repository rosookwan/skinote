// FixtureClient: 체험판(GitHub Pages)에서 서버 대신 쓰는 DomainClient. 운영의 HttpClient · LocalClient(ui 7절)가 올 때까지
// 화면을 실제 모양의 읽기 모델로 돌려 보려는 임시 대역이다. 규칙은 fixture/rules.ts · stamps.ts에 최소한만 있고, 화면은 이 규칙을
// 모른다(읽기 모델만 받는다). 자료는 브라우저 localStorage에 남고(없어도 돈다), '나가기' 화면에서 처음으로 되돌린다.
// 체험 시계는 12월 26일 15:40에서 시작해 페이지를 연 동안 실제 시간과 함께 가고, 닫혀 있던 동안은 멈춘다. 앞으로 돌릴 수 있다.
// 기기 역할(setDevice): 기사 화면을 여는 동안 이 클라이언트는 기사 기기(운영의 LocalClient 몫)다. 그 기기의 연결을 끊으면
// (setOffline) 허용된 명령은 보냄 대기에 쌓이고, 목록은 대기를 겹쳐 그려 받음 도장을 점선으로 보인다(sync 8-1).
// 다시 연결하면 쌓인 순서대로 보낸다. 카운터는 매장 네트워크라 늘 연결되어 있고, 기사 기기의 대기는 카운터에 보이지 않는다.
import {
  DomainError, defaultUiConfig, type AnyCommandEnvelope, type CommandOutcome, type CommandType, type ConnectionState, type DomainClient,
  type LedgerViewResult, type PendingCommand, type QueryName, type QueryParams, type QueryResult, type SyncHead, type UiConfig, type ViewParams,
} from '@skinote/contract';
import { applyCommand, OFFLINE_ALLOWED } from './commands.ts';
import type { FxState } from './model.ts';
import { findOrder, orderIdOfTask } from './rules.ts';
import { DEMO_START_MS, SHOP_NAME, createSeed } from './seed.ts';
import { MINUTE, hm, iso } from './time.ts';
import { collectionList, confirmDraft, dayLedger, findLast4, orderSlip, reviewList, type ViewContext } from './views.ts';

/** localStorage와 같은 모양(시험은 메모리 저장소를 넣는다). */
export interface FixtureStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FixtureClientOptions {
  /** 없거나 막히면 메모리에만 둔다(사생활 보호 창). */
  storage?: FixtureStorage | null;
  storageKey?: string;
  /** 실제 시계(시험에서 고정). */
  realNow?: () => number;
  /** 다른 탭(기사 화면 등)이 같은 자료를 바꾸면 따라 읽는다. */
  listenToOtherTabs?: boolean;
}

export const FIXTURE_STORAGE_KEY = 'skinote.demo.v1';

interface Saved {
  version: 2;
  state: FxState;
  /** 저장할 때의 체험 시계(ms). */
  clock: number;
}

/** 이 클라이언트가 맡은 기기: 카운터(포스) 또는 기사 기기. */
export type FixtureDevice = 'counter' | 'driver';

/** 되돌릴 때마다 새 epoch(같은 ms에 두 번 되돌려도 다르게). */
const newEpoch = (realMs: number) => 'demo-' + realMs.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const clone = <T,>(value: T): T => structuredClone(value);

export class FixtureClient implements DomainClient {
  private state: FxState;
  private anchorDemo: number;
  private anchorReal: number;
  private readonly settings: UiConfig;
  private readonly storage: FixtureStorage | null;
  private readonly key: string;
  private readonly realNow: () => number;
  private readonly listeners = new Set<(head: SyncHead) => void>();
  private device: FixtureDevice = 'counter';

  constructor(options: FixtureClientOptions = {}) {
    this.storage = options.storage ?? null;
    this.key = options.storageKey ?? FIXTURE_STORAGE_KEY;
    this.realNow = options.realNow ?? (() => Date.now());
    this.settings = defaultUiConfig({ shopName: SHOP_NAME, timezone: 'Asia/Seoul' });
    const saved = this.read();
    this.state = saved?.state ?? createSeed(newEpoch(this.realNow()));
    this.anchorDemo = saved?.clock ?? DEMO_START_MS;
    this.anchorReal = this.realNow();
    if (!saved) this.save();
    if (options.listenToOtherTabs && typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key !== this.key) return;
        const next = this.read();
        if (!next) return;
        this.state = next.state;
        this.anchorDemo = next.clock;
        this.anchorReal = this.realNow();
        this.emit();
      });
    }
  }

  // ── 체험 전용(화면의 '나가기'가 부른다) ───────────────────────────────

  /** 체험 시계(ms). */
  now(): number {
    return this.anchorDemo + (this.realNow() - this.anchorReal);
  }

  advanceClock(minutes: number): void {
    this.anchorDemo += minutes * MINUTE;
    this.save();
    this.emit();
  }

  /** 도장 · 수납을 모두 지우고 처음 자료 · 15:40으로. 열린 창의 명령은 epoch가 달라 거절된다. */
  reset(): void {
    this.state = createSeed(newEpoch(this.realNow()));
    this.anchorDemo = DEMO_START_MS;
    this.anchorReal = this.realNow();
    this.save();
    this.emit();
  }

  /** 시계를 저장한다(페이지를 닫을 때). */
  persist(): void {
    this.save();
  }

  /** 지금 화면이 어느 기기의 것인지(기사 화면을 열면 기사 기기). 같은 값이면 아무 일도 없다. */
  setDevice(device: FixtureDevice): void {
    this.device = device;
  }

  /** 기사 기기의 연결을 끊거나 잇는다. 이으면 보냄 대기를 쌓인 순서대로 보낸다(각 명령은 기기에서 확인한 시각으로). */
  setOffline(offline: boolean): void {
    const d = this.state.driverDevice;
    if (d.offline === offline) return;
    if (offline) {
      this.state.driverDevice = { ...d, offline: true, since: this.now() };
    } else {
      for (const q of d.queue) applyCommand(this.state, q.envelope, q.at);
      this.state.driverDevice = { offline: false, queue: [] };
    }
    this.save();
    this.emit();
  }

  /** 이 기기의 연결 상태. 카운터는 늘 연결되어 있다. */
  connection(): ConnectionState {
    const d = this.state.driverDevice;
    if (this.device !== 'driver') return { online: true, pendingCount: 0 };
    return { online: !d.offline, pendingCount: d.queue.length, ...(d.since !== undefined ? { lastSyncAt: iso(d.since) } : {}) };
  }

  /** 기사 기기의 연결이 끊겨 있는지(나가기 화면의 체험 단추). */
  driverOffline(): boolean {
    return this.state.driverDevice.offline;
  }

  // ── DomainClient ──────────────────────────────────────────────────

  async config(): Promise<UiConfig> {
    return clone(this.settings);
  }

  async ledgerView(viewKey: string, params: ViewParams): Promise<LedgerViewResult> {
    const ctx = this.context();
    switch (viewKey) {
      case 'day_ledger': return clone(dayLedger(ctx, params));
      case 'collection_list': return clone(collectionList(ctx, params));
      default: throw new DomainError('UNKNOWN_VIEW', '체험 자료에 없는 화면: ' + viewKey);
    }
  }

  async query<Q extends QueryName>(name: Q, params: QueryParams[Q]): Promise<QueryResult[Q]> {
    const ctx = this.context();
    const answer = (value: QueryResult[QueryName]) => clone(value) as QueryResult[Q];
    switch (name) {
      case 'orderSlip': {
        const p = params as QueryParams['orderSlip'];
        const slip = orderSlip(ctx, p.orderId, p.deviceClass);
        if (!slip) throw new DomainError('NOT_FOUND', '없는 접수: ' + p.orderId);
        return answer(slip);
      }
      case 'findLast4': return answer(findLast4(ctx, (params as QueryParams['findLast4']).last4));
      case 'confirmDraft': return answer(confirmDraft(ctx, params as QueryParams['confirmDraft']));
      case 'reviewList': return answer(reviewList(ctx));
      case 'vehicleLoad': {
        const list = collectionList(ctx, { vehicleId: (params as QueryParams['vehicleLoad']).vehicleId });
        return answer(list.vehicleLoad!);
      }
      default: throw new DomainError('UNKNOWN_VIEW', '체험 자료에 없는 조회: ' + String(name));
    }
  }

  async command(envelope: AnyCommandEnvelope): Promise<CommandOutcome> {
    if (this.device === 'driver' && this.state.driverDevice.offline) return clone(this.enqueue(envelope));
    const before = this.state.rev;
    const outcome = applyCommand(this.state, envelope, this.now());
    this.save();
    if (this.state.rev !== before) this.emit();
    return clone(outcome);
  }

  subscribe(onChange: (head: SyncHead) => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  async pending(): Promise<PendingCommand[]> {
    if (this.device !== 'driver') return [];
    return this.state.driverDevice.queue.map((q) => ({
      requestId: q.envelope.requestId, type: q.envelope.type, state: 'queued', createdAt: iso(q.at), summary: q.summary,
    }));
  }

  // ── 안쪽 ──────────────────────────────────────────────────────────

  /** 오프라인 기사 기기: 허용된 명령은 보냄 대기에(같은 요청번호는 한 번만), 나머지는 연결된 뒤에 하라고 돌려보낸다. */
  private enqueue(envelope: AnyCommandEnvelope): CommandOutcome {
    const base = { requestId: envelope.requestId, rev: this.state.rev, asOfRev: envelope.basis.rev, epoch: this.state.epoch, rebased: false, changes: [] };
    if (!OFFLINE_ALLOWED.has(envelope.type)) {
      return { ...base, outcome: 'rejected', error: { code: 'OFFLINE', message: '연결이 끊겨 있어 지금은 할 수 없습니다. 연결된 뒤에 다시 해 주세요.' } };
    }
    const queue = this.state.driverDevice.queue;
    if (!queue.some((q) => q.envelope.requestId === envelope.requestId)) {
      const at = this.now();
      queue.push({ envelope, at, summary: this.summary(envelope, at) });
      this.save();
      this.emit();
    }
    return { ...base, outcome: 'queued' };
  }

  /** 보냄 대기 목록의 한 줄('김민수 · 0025 받음 21:42'). */
  private summary(envelope: AnyCommandEnvelope, at: number): string {
    const taskId = 'taskId' in envelope.payload ? envelope.payload.taskId : undefined;
    const o = taskId ? findOrder(this.state, orderIdOfTask(taskId)) : undefined;
    const who = o ? o.teamName + ' · ' + o.last4 + ' ' : '';
    const what: Partial<Record<CommandType, string>> = { 'stock.collect': '받음', 'task.visit': '못 받음', 'route.move': '순서', 'route.reset': '시간순 되돌리기', 'notification.ack': '빨리 확인 확인' };
    return who + (what[envelope.type] ?? envelope.type) + ' ' + hm(at);
  }

  private context(): ViewContext {
    const base = { config: this.settings, now: this.now() };
    const queue = this.state.driverDevice.queue;
    if (this.device !== 'driver' || queue.length === 0) return { ...base, state: this.state };
    // 보냄 대기 겹치기(sync 8-1): 대기 명령을 복사본에 적용해 그리고 버린다. 받음만 대기인 업무는 점선.
    const shadow = structuredClone(this.state);
    const pendingTasks = new Set<string>();
    for (const q of shadow.driverDevice.queue) {
      const outcome = applyCommand(shadow, q.envelope, q.at);
      if (q.envelope.type === 'stock.collect' && outcome.outcome === 'applied') pendingTasks.add(q.envelope.payload.taskId);
    }
    return { ...base, state: shadow, pendingTasks };
  }

  private emit(): void {
    const head: SyncHead = { epoch: this.state.epoch, rev: this.state.rev, configRev: this.settings.configRev };
    for (const listener of [...this.listeners]) listener(head);
  }

  private read(): Saved | null {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return null;
      const saved = JSON.parse(raw) as Saved;
      if (saved.version !== 2 || saved.state?.version !== 2 || !Array.isArray(saved.state.orders) || !saved.state.driverDevice || typeof saved.clock !== 'number') return null;
      return saved;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      const saved: Saved = { version: 2, state: this.state, clock: this.now() };
      this.storage?.setItem(this.key, JSON.stringify(saved));
    } catch {
      // 저장이 막힌 브라우저에서도 체험은 돈다(새로 고치면 처음 자료).
    }
  }
}

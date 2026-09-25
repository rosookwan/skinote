// FixtureClient: 체험판(GitHub Pages)에서 서버 대신 쓰는 DomainClient — @skinote/domain의 메모리 어댑터(work/impl-server/plan.md D1).
// 규칙 · 명령 처리기 · 읽기 모델은 모두 도메인 패키지에 있고(서버와 같은 코드), 여기에는 체험판만의 것(시계 · 이야기 · 기사 기기의
// 보냄 대기 · localStorage · 체험 문구)만 있다. 화면은 규칙을 모른다(읽기 모델만 받는다). 자료는 브라우저 localStorage에 남고(없어도
// 돈다), '나가기' 화면에서 처음으로 되돌린다.
// 체험 시계는 12월 26일 15:40에서 시작해 페이지를 연 동안 실제 시간과 함께 가고, 닫혀 있던 동안은 멈춘다. 앞으로 돌릴 수 있다.
// 기기 역할(setDevice): 기사 화면을 여는 동안 이 클라이언트는 기사 기기(운영의 LocalClient 몫)다. 그 기기의 연결을 끊으면
// (setOffline) 허용된 명령은 보냄 대기에 쌓이고, 목록은 대기를 겹쳐 그려 받음 도장을 점선으로 보인다(sync 8-1).
// 다시 연결하면 쌓인 순서대로 보낸다. 카운터는 매장 네트워크라 늘 연결되어 있고, 기사 기기의 대기는 카운터에 보이지 않는다.
import {
  defaultUiConfig, type AnyCommandEnvelope, type CommandOutcome, type CommandType, type ConnectionState, type DomainClient,
  type LedgerViewResult, type PendingCommand, type QueryName, type QueryParams, type QueryResult, type SyncHead, type UiConfig, type ViewParams,
} from '@skinote/contract';
import {
  MINUTE, OFFLINE_ALLOWED, SAMPLE_STAFF, findOrder, hm, iso, ledgerView, orderIdOfTask, runQuery, sampleRegistry, type FxState, type ReadContext,
} from '@skinote/domain';
import { DEMO_LINES, DEMO_START_MS, applyCommand, createSeed } from './demo.ts';
import { applyStory } from './story.ts';

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
  /**
   * 뒷이야기(story.ts): 체험 시계를 앞으로 돌리면 그 사이의 사건을 적는다. 체험판은 켜고(main.tsx), 시험은 기본으로 끈다
   * (이야기를 보는 시험만 켠다).
   */
  story?: boolean;
}

export const FIXTURE_STORAGE_KEY = 'skinote.demo.v1';

interface Saved {
  version: 3;
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
  private readonly story: boolean;
  private device: FixtureDevice = 'counter';

  constructor(options: FixtureClientOptions = {}) {
    this.storage = options.storage ?? null;
    this.key = options.storageKey ?? FIXTURE_STORAGE_KEY;
    this.realNow = options.realNow ?? (() => Date.now());
    this.story = options.story ?? false;
    this.settings = defaultUiConfig({ shopName: sampleRegistry().shopName, timezone: 'Asia/Seoul' });
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

  /** 시계를 앞으로. 뒷이야기가 켜져 있으면 그 사이의 사건을 그 시각으로 적는다. */
  advanceClock(minutes: number): void {
    this.anchorDemo += minutes * MINUTE;
    // 사건의 명령은 applyCommand가 적용할 때 rev를 올린다(아래 emit이 화면에 알린다).
    if (this.story) applyStory(this.state, this.now(), applyCommand);
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

  /** 미리 보기 화면(로그인 타일)의 직원 이름: 견본 직원(SAMPLE_STAFF). 화면이 도메인을 가져오지 않게 체험판이 넘긴다(plan §6-3). */
  previewStaff(): string[] {
    return SAMPLE_STAFF.map((s) => s.name);
  }

  // ── DomainClient ──────────────────────────────────────────────────

  async config(): Promise<UiConfig> {
    return clone(this.settings);
  }

  async ledgerView(viewKey: string, params: ViewParams): Promise<LedgerViewResult> {
    const { state, ctx } = this.context();
    return clone(ledgerView(state, viewKey, params, ctx));
  }

  async query<Q extends QueryName>(name: Q, params: QueryParams[Q]): Promise<QueryResult[Q]> {
    const { state, ctx } = this.context();
    return clone(runQuery(state, name, params, ctx));
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
      return { ...base, outcome: 'rejected', error: { code: 'OFFLINE', message: '연결 끊김 · 연결 후 가능' } };
    }
    const queue = this.state.driverDevice.queue;
    if (!queue.some((q) => q.envelope.requestId === envelope.requestId)) {
      const at = this.now();
      // 보냄 대기의 명령은 기기 번호(deviceSeq)를 가진다: 서버는 돈의 바탕(expect)을 참고 값으로 적는다(sync 8-12).
      const seq = queue.reduce((max, q) => Math.max(max, q.envelope.deviceSeq ?? 0), 0) + 1;
      queue.push({ envelope: { ...envelope, deviceSeq: seq }, at, summary: this.summary(envelope, at) });
      this.save();
      this.emit();
    }
    return { ...base, outcome: 'queued' };
  }

  /** 전송 대기 목록의 한 줄('김민수 · 0025 수거 21:42'). */
  private summary(envelope: AnyCommandEnvelope, at: number): string {
    const taskId = 'taskId' in envelope.payload ? envelope.payload.taskId : undefined;
    const o = taskId ? findOrder(this.state, orderIdOfTask(taskId)) : undefined;
    const who = o ? o.teamName + ' · ' + o.last4 + ' ' : '';
    const what: Partial<Record<CommandType, string>> = {
      'stock.collect': '수거', 'stock.deliver': '배달', 'task.visit': taskId && taskId.startsWith('deliver:') ? '배달 실패' : '수거 실패', 'route.move': '순서 변경',
      'route.reset': '시간순 정렬', 'notification.ack': '긴급 확인', 'field.collect': '현장 수납', 'field.add_ticket': '리프트권 추가', 'field.deposit_return': '보증금 반환',
    };
    return who + (what[envelope.type] ?? envelope.type) + ' ' + hm(at);
  }

  /** 읽기 문맥: 지금 자료(기사 기기면 보냄 대기를 겹친 사본)와 화면 설정 · 체험 시계 · 체험 문구. */
  private context(): { state: FxState; ctx: ReadContext } {
    const base = { config: this.settings, now: this.now(), lines: DEMO_LINES };
    const queue = this.state.driverDevice.queue;
    if (this.device !== 'driver' || queue.length === 0) return { state: this.state, ctx: base };
    // 보냄 대기 겹치기(sync 8-1): 대기 명령을 복사본에 적용해 그리고 버린다. 수거 · 배달이 대기인 업무는 점선.
    const shadow = structuredClone(this.state);
    const pendingTasks = new Set<string>();
    for (const q of shadow.driverDevice.queue) {
      const outcome = applyCommand(shadow, q.envelope, q.at);
      if ((q.envelope.type === 'stock.collect' || q.envelope.type === 'stock.deliver') && outcome.outcome === 'applied') pendingTasks.add(q.envelope.payload.taskId);
    }
    return { state: shadow, ctx: { ...base, pendingTasks } };
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
      // 옛 판(2 이하)으로 저장된 체험 자료는 버리고 처음 자료로 시작한다(판 3: 운영 규칙 · 번호 · 보증금 · 돈통).
      if (saved.version !== 3 || saved.state?.version !== 3 || !Array.isArray(saved.state.orders) || !saved.state.driverDevice || !saved.state.settings
        || typeof saved.clock !== 'number') return null;
      // 매장 목록(registry)은 체험판 코드의 견본 값이다: 저장된 것이 없거나 옛것이어도 늘 지금 값을 쓴다.
      saved.state.registry = sampleRegistry();
      return saved;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      const saved: Saved = { version: 3, state: this.state, clock: this.now() };
      this.storage?.setItem(this.key, JSON.stringify(saved));
    } catch {
      // 저장이 막힌 브라우저에서도 체험은 돈다(새로 고치면 처음 자료).
    }
  }
}

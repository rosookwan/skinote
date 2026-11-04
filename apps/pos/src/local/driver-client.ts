// DriverClient(work/impl-offline/plan.md §7-4 · O2 · O3 · O18): 기사 기기(서버 모드)의 DomainClient. HttpClient(세션 · CSRF · 알림 연결 · 심장 박동 ·
// 사본 · 묶음 · 온라인 명령)와 LocalClient(사본 + 보냄 대기 겹침)를 묶는다. 카운터는 그대로 HttpClient다.
//   - 로컬 먼저(서버 policy.localFirst, 기본): 사본이 있으면 늘 사본으로 읽고(연결되어 있어도: 약한 신호에서 목록이 오가지 않게), 끊긴 채 넣을 수
//     있는 명령은 늘 보냄 대기로 넣은 뒤 곧바로 보낸다. 전화 창만 연결되어 있으면 서버 먼저(3초, 열람 기록), 아니면 사본.
//   - 스위치를 끔(SKINOTE_DRIVER_LOCAL_FIRST=off): 연결된 동안은 카운터처럼 서버로 읽고 보낸다. 끊긴 동안(넘기기 지연)만 사본 · 보냄 대기. 보낸 뒤 답을
//     잃은 끊김 허용 명령은 같은 요청번호로 보냄 대기에 넣는다(O2).
//   - 연결이 있어야 하는 명령(매장 입고 · 현금 인계 · 후불 처리 …): 끊겼으면 한 줄 거절. 매장 입고 · 현금 인계는 먼저 보냄 대기를 비우고(10초) 남으면
//     `입고 불가 · 전송 대기 {n}`(sync 8-4). 답을 잃으면 봉투를 봉인해 두고 `연결 끊김 · 결과 확인 중`, 다음 연결에서 같은 봉투로 다시 보낸다(O18).
//   - 연결 상태: HttpClient의 넘기기 지연 또는 10초 안의 성공한 묶음. 띠: 보내기가 2초 넘으면 `전송 중 · 전송 대기 n`, 끊긴 채 만든 것을 보냈거나 결과가
//     applied가 아니면 2분 동안(또는 다음 창까지) `전송 대기 0`.
//   - 세션 끝(401): 보낼 것이 있으면 세션 없는 전달(device/deliver)로 보내고, 사본은 늘 지운다(보낼 것이 남아도: 이름 · 번호는 지우고 보냄 대기는
//     그 열쇠로 남는다, §17 R3-9). 끊은 기기는 저장소에 보낼 것이 없을 때만 모두 지운다(저장소가 같은 트랜잭션에서 본다, R3-4).
//   - 로그아웃: 보낼 것이 남으면 `로그아웃 불가 · 전송 대기 {n}`(연결되어 있으면 먼저 보낸다). 되면 사본 · 사본 열쇠를 지운다(O14 c). 서버에 닿지
//     못하면 표시를 남겨 다음 연결에서 서버 로그아웃을 먼저 보낸다(R3-7).
//   - epoch: 기기 메모의 epoch와 서버의 것을 견준다(사본이 없어도, R3-3). 서버가 restoredUpToRev(수)를 주면 복구라 옛 기록을 다시 보내고(O20), 아니면
//     (시험 매장 새로 만들기) 옛 답만 보낸 기록으로 옮긴다(R3-1). 심장 박동 · 사본뿐 아니라 묶음의 답에서도 결과 · 빈 번호보다 먼저 본다(§17-4).
//   - 앱 잠금: 확인 값은 기사 역할만(R3-11). 기기에서 풀 수 없으면(확인 값 없음) 시작할 때 온라인 로그인(R3-7), 다섯 번 틀릴 때마다 시각까지 잠김(R3-24).
//   - 답을 잃은 온라인 명령은 한 건씩 칸에 두고(다른 화면의 것을 덮지 않게), 다시 보낸 답이 거절이면 띠에 `전송 실패 · 재전송 필요`(R3-5).
import {
  API_V2, DomainError, isAccepted, offlineCommandTypes,
  type AnyCommandEnvelope, type BatchResponse, type CommandOutcome, type ConnectionState, type DeliverRequest, type DeliverResponse, type DeviceReport,
  type DomainClient, type HeadInfo, type HeartbeatResponse, type LedgerViewResult, type OfflinePolicy, type PendingCommand, type QueryName,
  type QueryParams, type QueryResult, type SessionInfo, type SnapshotRequest, type SnapshotResponse, type SyncHead, type UiConfig, type ViewParams,
} from '@skinote/contract';
import { outcomeNoteCounts, outcomeNoteKey, pendingLine, recordTeam, type OutcomeNote } from '@skinote/domain';
import type { AuthAnswer } from '../app/auth-api.ts';
import { checkPin, createVerifier, isVerifier, lockDue, lockedUntil, lockoutMinutes, MAX_PIN_FAILURES, PIN_ITERATIONS, type PinVerifier } from './app-lock.ts';
import type { EventSourceFactory, HttpClient, HttpClientOptions, PostAnswer } from '../app/http-client.ts';
import { ageOf, madeAtOf, newPageAnchor, offsetFrom, stampItem, systemClocks, type Clocks } from './clock.ts';
import { Flusher, type FlushResult } from './flush.ts';
import { LocalClient, offlineRefusalLine, refusalOutcome, type DriverKind } from './local-client.ts';
import { LocalStore, type Channel, type Locks, type OnlinePending, type RefusedOnline } from './local-store.ts';
import { Maintenance } from './maintenance.ts';
import { isRetryableResult, overlayEnvelope, SendQueue, type AnswerSummary, type QueueItem } from './queue.ts';
import type { RawStore } from './raw-store.ts';
import { REMEMBERED_ID, VERIFIER_ID, type RememberedSession } from './remembered.ts';
import { deviceReport } from './report.ts';
import { signDeliver, signQueued } from './sign.ts';
import type { LocalWords } from './words.ts';
import { SnapshotSync, realTimers, type Timers } from './snapshots.ts';

/** 운영 값의 기본(서버가 policy를 주지 않았을 때: offline_policy 시드와 같다). */
export const POLICY_DEFAULT: OfflinePolicy = Object.freeze({
  localFirst: true, heartbeatMs: 20_000, piiWipeHours: 24, sentPiiHours: 24, sentLogDays: 7, appLockMinutes: 5, maxBackdateHours: 168,
  futureSkewMinutes: 5, clockWarnMinutes: 2,
});

/** DriverClient의 기다림들(ms). */
export interface DriverTiming {
  drainMs: number;
  refreshMs: number;
  phoneMs: number;
  sendingBandMs: number;
  settledMs: number;
  batchOnlineMs: number;
  pendingKickMs: number;
  maintenanceMs: number;
}

export const DRIVER_TIMING: Readonly<DriverTiming> = Object.freeze({
  /** 매장 입고 · 현금 인계 · 로그아웃 전에 보냄 대기를 비우는 기다림. */
  drainMs: 10_000,
  /** 온라인 명령이 적용된 뒤 사본을 기다리는 시간. */
  refreshMs: 5_000,
  /** 전화 창의 서버 먼저 기다림. */
  phoneMs: 3_000,
  /** 띠의 `전송 중`: 보내기가 이보다 길면. */
  sendingBandMs: 2_000,
  /** 띠의 `전송 대기 0`을 두는 시간. */
  settledMs: 120_000,
  /** 성공한 묶음 뒤 연결됨으로 보는 시간. */
  batchOnlineMs: 10_000,
  /** 보냄 대기가 비지 않은 동안 보내기를 청하는 간격. */
  pendingKickMs: 15_000,
  maintenanceMs: 60_000,
});

/** 화면이 보이는지와 가려짐 · 다시 보임 · 닫힘. */
export interface Visibility {
  visible(): boolean;
  /** 바뀔 때마다(가려짐 · 보임 · pagehide는 hidden). 되돌리는 함수. */
  listen(onChange: (visible: boolean) => void): () => void;
}

export function browserVisibility(): Visibility {
  if (typeof document === 'undefined' || typeof window === 'undefined') return { visible: () => true, listen: () => () => {} };
  return {
    visible: () => document.visibilityState !== 'hidden',
    listen(onChange) {
      const onVis = () => onChange(document.visibilityState !== 'hidden');
      const onHide = () => onChange(false);
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('pagehide', onHide);
      return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', onHide); };
    },
  };
}

/** persist() 허락 · 홈 화면 앱 · 서비스 워커가 맡은 화면(O16). */
export async function browserOfflineCapable(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
    const persisted = await navigator.storage?.persisted?.();
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
    return !!persisted && standalone && !!navigator.serviceWorker?.controller;
  } catch {
    return false;
  }
}

export interface DriverClientOptions {
  session: SessionInfo;
  /** 길(HttpClient)을 만드는 법: 부르는 쪽(session.tsx)이 넘긴다(이 묶음이 앱 뼈대의 모듈을 끌어오지 않게). */
  makeHttp: (options: HttpClientOptions) => HttpClient;
  raw: RawStore;
  /** 기기 열쇠의 비밀 열쇠(꺼낼 수 없음): 보냄 대기 · 전달의 서명. */
  deviceKey: CryptoKey;
  /** 서명 문장의 앱 주소(location.origin). */
  origin: string;
  /** 앱 자리(document.baseURI). */
  baseUrl: string;
  appVersion: string;
  /** 창에 돌려주는 한 줄들(앱 문구 표 app/strings.ts의 localWords). */
  words: LocalWords;
  /** 세션 없는 전달(auth-api). 없으면 세션이 끝난 뒤 보내지 못한다. */
  auth?: {
    challenge(deviceId: string): Promise<AuthAnswer<{ nonce: string }>>;
    deliver(body: DeliverRequest): Promise<AuthAnswer<DeliverResponse>>;
  };
  /** 세션이 끝남(전달 · 지움을 한 뒤). 부르는 쪽이 로그인 · 등록으로 간다. */
  onSessionLost?: (code: string) => void;
  fetch?: typeof fetch;
  eventSource?: EventSourceFactory | null;
  networkEvents?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  channel?: Channel | null;
  locks?: Locks;
  clocks?: Clocks;
  timers?: Timers;
  random?: () => number;
  visibility?: Visibility;
  offlineCapable?: () => Promise<boolean> | boolean;
  /** HttpClient의 넘기기 지연(시험). */
  failuresToOffline?: number;
  recoverMs?: number;
  retryDelaysMs?: readonly number[];
  log?: (message: string, detail?: unknown) => void;
  /** 기다림들(시험이 줄인다). */
  timing?: Partial<DriverTiming>;
  /** 앱 잠금 확인 값의 PBKDF2 반복 수(시험은 적게). */
  pinIterations?: number;
  /**
   * 기억한 세션으로 서버 없이 연다(boot의 open · locked, O15 · §18 R4-13): 띠의 `마지막 연결`은 기기 메모의 때이고 첫 답까지 끊김으로 시작한다.
   * 없으면 방금 서버가 준 세션(로그인 · 세션 묻기의 답)이다.
   */
  remembered?: boolean;
}

/** 앱 잠금 풀기의 답: 맞음 · 틀림 · 틀려서 잠김(until까지) · 기기에서 풀 수 없음(온라인 로그인). */
export interface UnlockResult {
  answer: 'ok' | 'wrong' | 'locked' | 'login';
  until?: number;
}

/** 앱 잠금 때인지: 잠글지, 기기에서 풀 수 없는지(온라인 로그인), 틀려서 잠긴 동안이면 그 끝. */
export interface LockStatus {
  due: boolean;
  needLogin: boolean;
  until?: number;
}

/** 다시 보낸 온라인 명령의 결과 가운데 거절이 아닌 것(적용 · 일부 · 확인 필요 · 이미 됨 superseded, §18 R4-15). */
const ACCEPTED_ONLINE: ReadonlySet<string> = new Set(['applied', 'partially_applied', 'needs_review', 'superseded', 'queued']);

const unknownOutcome = (envelope: AnyCommandEnvelope, words: LocalWords, head?: { rev: number; epoch: string }): CommandOutcome => ({
  outcome: 'unknown', requestId: envelope.requestId, rev: head?.rev ?? envelope.basis.rev, asOfRev: envelope.basis.rev, epoch: head?.epoch ?? envelope.basis.epoch,
  rebased: false, changes: [], error: { code: 'UNKNOWN', message: words.resultChecking },
});

export class DriverClient implements DomainClient {
  readonly http: HttpClient;
  readonly local: LocalStore;
  readonly queue: SendQueue;
  readonly localClient: LocalClient;
  readonly flusher: Flusher;
  readonly snapshots: SnapshotSync;
  readonly maintenance: Maintenance;
  private readonly o: DriverClientOptions;
  private readonly kind: DriverKind;
  private readonly offlineTypes: ReadonlySet<string>;
  private readonly clocks: Clocks;
  private readonly timers: Timers;
  private readonly visibility: Visibility;
  private readonly pageAnchor = newPageAnchor();
  private readonly listeners = new Set<(head: SyncHead) => void>();
  private readonly cleanups: (() => void)[] = [];
  private policy: OfflinePolicy;
  private offsetMs = 0;
  private capable = false;
  private lastBatchOkAt: number | null = null;
  private settledUntil = 0;
  /** 이번 보내기의 답에 붙은 줄 메모(종류 · 팀, 다 보내면 띠에, §17 R3-26 · §18 R4-17). */
  private batchNotes: OutcomeNote[] = [];
  private settledNotes: OutcomeNote[] = [];
  private onlinePending: OnlinePending[] = [];
  /**
   * 다시 보낸 온라인 명령이 받아들여지지 않은 것(띠 `처리 실패 · 현금 인계 350,000원 · 매장 확인`, §17 R3-5 · §18 R4-15): 같은 일을 다시 해 받아들여지거나
   * 영업일이 바뀌거나 로그아웃할 때까지(다른 확인 창을 열어도 남는다). 기기 메모에도 둔다(앱을 다시 켜도).
   */
  private refused: RefusedOnline[] = [];
  private resolving = false;
  private wasOnline = true;
  private closed = false;
  private lostCode: string | null = null;
  private sendingTimer: unknown = null;
  private settledTimer: unknown = null;
  private lastHead: SyncHead | null = null;
  private readonly timing: DriverTiming;

  /** 저장소를 열고(보내던 항목 → 결과 확인 중) 사본 · 보냄 대기를 읽은 클라이언트. start()로 돌기 시작한다. */
  static async open(options: DriverClientOptions): Promise<DriverClient> {
    const client = new DriverClient(options);
    await client.queue.recoverSending();
    const meta = await client.local.readMeta();
    client.offsetMs = meta.clockOffsetMs;
    client.refused = meta.refusedOnline ?? [];
    if (options.remembered) {
      // 서버 없이 연 앱(§18 R4-13): 마지막 연결은 기기 메모의 때, 첫 답까지 끊김(다시 붙으면 보내기 · 사본을 연결됨으로 다시 시작한다).
      client.http.startOffline(meta.lastContactAt);
      client.wasOnline = false;
    }
    client.onlinePending = await client.local.readOnline();
    await client.localClient.reload();
    const head = client.localClient.copyHead();
    if (head) client.policy = { ...head.policy, ...(options.session.policy ?? {}) };
    client.capable = await (options.offlineCapable ?? (() => false))();
    return client;
  }

  private constructor(options: DriverClientOptions) {
    const { session } = options;
    if (session.device.kind === 'pos') throw new Error('DriverClient는 기사 기기만');
    if (!session.session) throw new Error('세션 id가 없는 서버');
    this.o = options;
    this.timing = { ...DRIVER_TIMING, ...(options.timing ?? {}) };
    this.kind = session.device.kind;
    this.offlineTypes = new Set(offlineCommandTypes(this.kind));
    this.clocks = options.clocks ?? systemClocks;
    this.timers = options.timers ?? realTimers;
    this.visibility = options.visibility ?? browserVisibility();
    this.policy = { ...POLICY_DEFAULT, ...(session.policy ?? {}) };
    const sessionId = session.session.id;
    this.local = new LocalStore({
      raw: options.raw, deviceId: session.device.id, ...(options.channel !== undefined ? { channel: options.channel } : {}),
      ...(options.locks ? { locks: options.locks } : {}), now: () => this.clocks.wall(),
    });
    this.queue = new SendQueue(this.local);
    this.http = options.makeHttp({
      session, baseUrl: options.baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.eventSource !== undefined ? { eventSource: options.eventSource } : {}),
      ...(options.networkEvents !== undefined ? { networkEvents: options.networkEvents } : {}),
      ...(options.failuresToOffline !== undefined ? { failuresToOffline: options.failuresToOffline } : {}),
      ...(options.recoverMs !== undefined ? { recoverMs: options.recoverMs } : {}),
      ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
      ...(options.log ? { log: options.log } : {}),
      pollMs: this.policy.heartbeatMs,
      now: () => this.clocks.wall(),
      heartbeat: () => this.report(),
      onHeartbeat: (answer, sentAt, receivedAt) => { void this.onHeartbeat(answer, sentAt, receivedAt); },
      visible: () => this.visibility.visible(),
      onSessionLost: (code) => { void this.sessionLost(code); },
    });
    this.localClient = new LocalClient({
      local: this.local, queue: this.queue, device: { id: session.device.id, kind: this.kind }, staff: { id: session.staff.id, name: session.staff.name }, sessionId,
      serverNow: () => this.serverNow(), stamp: () => stampItem(this.clocks, this.pageAnchor, this.offsetMs), offline: () => !this.online(),
      wallNow: () => this.clocks.wall(), words: options.words, extraPending: () => this.onlinePending.length,
      ...(session.vehicleId ?? session.device.vehicleId ? { vehicleId: session.vehicleId ?? session.device.vehicleId } : {}),
    });
    this.flusher = new Flusher({
      queue: this.queue, appVersion: options.appVersion,
      sign: (item) => this.sign(item),
      report: () => this.report(),
      postBatch: (body, timeoutMs) => this.http.postJson<BatchResponse>(API_V2.commandsBatch, body, { timeoutMs, accept: (v) => !!v && typeof v === 'object' && Array.isArray((v as BatchResponse).results) }),
      heartbeat: () => this.heartbeatNow(),
      onHeartbeat: (answer) => this.afterHead(answer),
      // 묶음 답의 epoch(§17-4). 사본과 같은 epoch면 볼 것이 없다(잠금 · 메모 읽기 없이 곧바로 답을 적는다). restoredUpToRev 칸이 없는 옛 서버의
      // 답으로는 정하지 않는다(복구를 새로 만들기로 잘못 읽지 않게: 심장 박동 · 사본이 정한다).
      onAnswerEpoch: (answer) => (answer.restoredUpToRev === undefined || answer.epoch === this.localClient.copyHead()?.epoch ? Promise.resolve() : this.afterHead(answer)),
      onBatch: (answer, summary, sentAt, receivedAt) => this.onBatch(answer, summary, sentAt, receivedAt),
      onDrained: (result) => this.onDrained(result),
      onChange: () => this.onSendingChange(),
      exclusive: (work) => this.local.withLock('skinote-flush', work),
      timers: this.timers,
      ...(options.random ? { random: options.random } : {}),
      now: () => this.clocks.wall(),
    });
    this.snapshots = new SnapshotSync({
      local: this.local, queue: this.queue, appVersion: options.appVersion,
      post: (body: SnapshotRequest, timeoutMs) => this.http.postJson<SnapshotResponse>(API_V2.snapshot, body, { timeoutMs, accept: (v) => !!v && typeof v === 'object' && typeof (v as SnapshotResponse).hash === 'string' }),
      report: () => this.report(),
      onlinePending: async () => this.onlinePending.map((p) => p.envelope.requestId),
      onStored: (info) => this.onStored(info.response),
      onEpoch: async (epoch, restoredUpToRev) => {
        // 복구(O20)면 옛 epoch의 기록 중 복구 기준 뒤의 것을 같은 번호로 다시 보내고, 새로 만든 매장(기준 null)이면 옛 답만 정리한다(§17 R3-1 · R3-3).
        if (await this.epochSeen(epoch, restoredUpToRev)) this.flusher.kick();
      },
      timers: this.timers,
      wallNow: () => this.clocks.wall(),
    });
    this.maintenance = new Maintenance({
      local: this.local, queue: this.queue, staffId: session.staff.id, wallNow: () => this.clocks.wall(), serverNow: () => this.serverNow(), policy: () => this.policy,
    });
  }

  /** 돌기 시작: 알림 연결 · 심장 박동, 지움 시계, 첫 사본, 보내기. 세션을 기억한다(서버 없이 앱을 여는 길, O15). */
  start(): void {
    if (this.closed) return;
    void this.remember();
    this.http.start();
    this.cleanups.push(this.http.subscribe((head) => this.onHttpHead(head)));
    this.cleanups.push(this.localClient.subscribe(() => this.emit()));
    this.cleanups.push(this.local.onNotice((notice) => {
      if (notice.kind === 'shred' && !this.lostCode) {
        // 다른 화면이 로그아웃했다(같은 브라우저의 세션): 이 화면도 로그인으로.
        this.lostCode = 'SIGNED_OUT';
        this.close();
        this.o.onSessionLost?.('SIGNED_OUT');
      }
      if (notice.kind === 'meta') void this.local.readOnline().then((list) => { this.onlinePending = list; this.emit(); }, () => {});
    }));
    this.cleanups.push(this.visibility.listen((visible) => {
      if (visible) {
        this.http.poke();
        this.flusher.kick();
      } else {
        void this.hiddenReport();
      }
    }));
    const every = (ms: number, work: () => void) => {
      let handle: unknown;
      const loop = () => { handle = this.timers.setTimeout(() => { if (!this.closed) { work(); loop(); } }, ms); };
      loop();
      this.cleanups.push(() => this.timers.clearTimeout(handle));
    };
    every(this.timing.maintenanceMs, () => { void this.runMaintenance(); });
    every(this.timing.pendingKickMs, () => { if (this.localClient.counts().pending > 0) this.flusher.kick(); });
    void this.runMaintenance();
    void this.snapshots.request(true);
    this.flusher.kick();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.cleanups.splice(0)) c();
    if (this.sendingTimer !== null) this.timers.clearTimeout(this.sendingTimer);
    if (this.settledTimer !== null) this.timers.clearTimeout(this.settledTimer);
    this.flusher.stop();
    this.snapshots.stop();
    this.http.close();
    this.localClient.close();
    this.local.close();
    this.listeners.clear();
  }

  // ── 시계 · 모드 ──────────────────────────────────────────────────

  /** 서버 시각 짐작(ms). */
  serverNow(): number {
    return this.clocks.wall() + this.offsetMs;
  }

  /** 서버의 로컬 먼저 스위치(O2). */
  localFirst(): boolean {
    return this.policy.localFirst;
  }

  /** 연결됨: 넘기기 지연의 연결 또는 10초 안의 성공한 묶음. */
  online(): boolean {
    if (this.http.connection().online) return true;
    return this.lastBatchOkAt !== null && this.clocks.wall() - this.lastBatchOkAt < this.timing.batchOnlineMs;
  }

  private readLocal(): boolean {
    return this.localClient.hasCopy() && (this.localFirst() || !this.online());
  }

  // ── DomainClient ──────────────────────────────────────────────────

  config(): Promise<UiConfig> {
    return this.readLocal() ? this.localClient.config() : this.http.config();
  }

  ledgerView(viewKey: string, params: ViewParams): Promise<LedgerViewResult> {
    return this.readLocal() ? this.localClient.ledgerView(viewKey, params) : this.http.ledgerView(viewKey, params);
  }

  async query<Q extends QueryName>(name: Q, params: QueryParams[Q]): Promise<QueryResult[Q]> {
    if (name === 'phoneReveal' && this.online() && this.localClient.hasCopy()) {
      // 전화 창: 연결되어 있으면 서버 먼저(열람 기록), 3초 안에 안 되면 사본의 번호(오늘 열린 업무만 온전한 번호, O17).
      const fromServer = await Promise.race([
        this.http.query(name, params).then((v) => ({ ok: true as const, v }), (error: unknown) => ({ ok: false as const, error })),
        new Promise<{ ok: false; error: unknown }>((resolve) => { this.timers.setTimeout(() => resolve({ ok: false, error: new DomainError('NETWORK', 'slow') }), this.timing.phoneMs); }),
      ]);
      if (fromServer.ok) return fromServer.v;
      if (fromServer.error instanceof DomainError && (fromServer.error.code === 'FORBIDDEN' || fromServer.error.code === 'NOT_FOUND')) throw fromServer.error;
      return this.localClient.query(name, params);
    }
    return this.readLocal() ? this.localClient.query(name, params) : this.http.query(name, params);
  }

  async command(envelope: AnyCommandEnvelope): Promise<CommandOutcome> {
    if (this.closed) throw new DomainError('NETWORK', 'closed');
    // 답을 잃은 온라인 명령을 다시 누름: 같은 봉투로(서버가 첫 결과를 준다).
    if (this.onlinePending.some((p) => p.envelope.requestId === envelope.requestId)) return this.resendOnline(envelope.requestId, envelope);
    const offlineOk = this.offlineTypes.has(envelope.type);
    const online = this.online();
    const head = this.copyRef();
    // 저장할 곳이 없는 기기(recordingOff)는 연결된 동안 서버로 바로 보낸다(O2).
    if (offlineOk && !(this.localClient.isRecordingOff() && online) && (this.localFirst() || !online)) {
      // 보냄 대기(사본이 아직 없으면 확인 전 검사 없이: 기록은 잃지 않는다, 서버가 보냄 대기 규칙으로 적는다).
      const out = await this.localClient.command(envelope);
      if (out.outcome === 'queued') {
        this.dismissResults();
        this.flusher.kick();
      }
      this.emit();
      return out;
    }
    if (!online) return refusalOutcome(envelope, 'OFFLINE', offlineRefusalLine(envelope.type, this.o.words), head);
    if (!offlineOk && this.onlinePending.length > 0) {
      // 답을 잃은 온라인 명령이 풀리기 전에는 새 온라인 명령을 보내지 않는다(O18: 같은 일을 두 번 하지 않게). 먼저 다시 보내 본다.
      await this.resolveOnline();
      if (this.onlinePending.length > 0) return unknownOutcome(envelope, this.o.words, head);
    }
    if (!offlineOk && (envelope.type === 'stock.receive' || envelope.type === 'cash.transfer')) {
      // 인계 · 입고는 보냄 대기를 먼저 비운 뒤(sync 8-4): 남으면 한 줄, 주 버튼은 그대로(다시 누르면 다시 비운다).
      const left = await this.flusher.drain(this.timing.drainMs);
      if (left > 0) return refusalOutcome(envelope, 'PENDING', envelope.type === 'stock.receive' ? this.o.words.receiveWaiting(left) : this.o.words.handoverWaiting(left), head);
    }
    const out = await this.onlineCommand(envelope, offlineOk);
    // 받아들여지지 않았던 같은 일을 다시 해 받아들여졌다: 띠의 `처리 실패 · …`를 걷는다(§18 R4-15).
    if (isAccepted(out)) await this.clearRefused(envelope.type);
    return out;
  }

  subscribe(onChange: (head: SyncHead) => void): () => void {
    this.listeners.add(onChange);
    return () => { this.listeners.delete(onChange); };
  }

  connection(): ConnectionState {
    const base = this.http.connection();
    const counts = this.localClient.counts();
    const wall = this.clocks.wall();
    const sending = this.flusher.sendingSince();
    const showSending = sending !== null && (sending.offlineMade || wall - sending.since >= this.timing.sendingBandMs);
    // 한 수(§18 R4-11): 띠 · 더 보기 · 전송 대기 목록 제목 · 바닥줄 모두 답을 받지 않은 기록 + 답을 잃은 온라인 명령.
    const pending = counts.pending + this.onlinePending.length;
    const refused = this.refusedToday();
    return {
      online: this.online(), pendingCount: pending, sendQueue: true, ...(base.lastSyncAt ? { lastSyncAt: base.lastSyncAt } : {}),
      ...(showSending ? { sending: { remaining: pending } } : sending !== null ? { flushing: true as const } : {}),
      ...(counts.unconfirmed + this.onlinePending.length > 0 ? { unconfirmedCount: counts.unconfirmed + this.onlinePending.length } : {}),
      ...(pending === 0 && this.settledUntil > wall ? { settled: true as const } : {}),
      ...(pending === 0 && this.settledUntil > wall && this.settledNotes.length ? { settledNotes: outcomeNoteCounts(this.settledNotes) } : {}),
      ...(this.localClient.isRecordingOff() ? { recordingOff: true as const } : {}),
      ...(refused.length > 0 ? { refusedCount: refused.length, refused: refused.map((r) => ({ what: r.what, ...(r.money ? { money: r.money } : {}) })) } : {}),
    };
  }

  /**
   * 전송 대기 목록(띠 · 머리줄의 `전송 대기 {n}`과 같은 셈, §17 R3-19): 보냄 대기(기기 번호 차례) 뒤에 답을 잃은 온라인 명령(`결과 확인 중`).
   */
  async pending(): Promise<PendingCommand[]> {
    const queued = await this.localClient.pending();
    return [...queued, ...this.onlinePending.map((p) => this.localClient.pendingEntry(p.envelope, p.at))];
  }

  // ── 서버 모드의 것(session.tsx) ───────────────────────────────────

  /**
   * 지금 머리(오늘 영업일). 사본이 있고 로컬 먼저면 사본과 시계로(서버에 묻지 않는다: 산에서도 첫 화면), 아니면 서버.
   */
  async fetchHead(): Promise<HeadInfo> {
    const head = this.localClient.copyHead();
    const today = this.localClient.today();
    if (head && today && this.readLocal()) {
      return { epoch: head.epoch, rev: head.rev, configRev: head.configRev, serverTime: new Date(this.serverNow()).toISOString(), currentBusinessDate: today };
    }
    try {
      return await this.http.fetchHead();
    } catch (error) {
      if (head && today) return { epoch: head.epoch, rev: head.rev, configRev: head.configRev, serverTime: new Date(this.serverNow()).toISOString(), currentBusinessDate: today };
      throw error;
    }
  }

  /**
   * 다음 확인 창을 열 때: 띠의 `전송 대기 0`을 걷는다. `처리 실패 · …`는 걷지 않는다(§18 R4-15: 다른 도장을 눌렀다고 무엇이 안 되었는지 잊지 않게, 같은
   * 일을 다시 해 받아들여지거나 영업일이 바뀌거나 로그아웃할 때까지).
   */
  dismissResults(): void {
    if (this.settledUntil === 0) return;
    this.settledUntil = 0;
    this.settledNotes = [];
    this.emit();
  }

  /** 새 판 바꾸기를 미룰지(보내는 중 · 사본을 받는 중, O6). */
  busy(): boolean {
    return this.flusher.busy() || this.snapshots.busy();
  }

  /**
   * 로그아웃(O14 c): 보낼 것이 남으면 거절 한 줄(연결되어 있으면 먼저 보낸다). 되면 세션을 끝내고 사본 · 사본 열쇠를 지운다. 보냄 대기 열쇠 · 보낸
   * 기록 · 번호는 남는다.
   */
  async logout(): Promise<string | null> {
    // 남은 수는 저장소에서 센다(다른 화면이 방금 넣은 기록도, §18 R4-10 · sessionLost와 같다). 읽지 못하면 이 화면의 셈.
    let left = await this.storedWaiting();
    if (left > 0 && this.online()) {
      await this.resolveOnline();
      left = (await this.flusher.drain(this.timing.drainMs)) + this.onlinePending.length;
    }
    if (left > 0) return this.o.words.logoutWaiting(left);
    this.lostCode = 'LOGOUT';
    // 받기 · 보내기를 먼저 멈춘다(늦게 온 사본이 지운 뒤에 다시 쓰이지 않게).
    this.snapshots.stop();
    this.flusher.stop();
    const reached = await this.http.logoutConfirmed();
    // 서버에 닿지 못한 로그아웃: 세션이 서버에 남는다. 다음 연결에서 이 세션이 살아 있으면 먼저 서버 로그아웃을 보낸다(§17 R3-7).
    // 받아들여지지 않은 온라인 명령의 띠 줄도 걷는다(§18 R4-15: 다음 사람의 띠에 남지 않게).
    await this.local.patchMeta({ refusedOnline: [], ...(reached ? {} : { signOutPending: this.o.session.session!.id }) }).catch(() => undefined);
    await this.local.dropCopy();
    this.close();
    return null;
  }

  /** 이 기기에 남은 기록 수(저장소: 다른 화면이 넣은 것도) + 답을 잃은 온라인 명령. 저장소를 읽지 못하면 이 화면의 셈(§18 R4-10). */
  private async storedWaiting(): Promise<number> {
    try {
      const [{ items }, online] = await Promise.all([this.queue.list(), this.local.readOnline()]);
      return items.filter((i) => i.state !== 'answered').length + online.length;
    } catch {
      return this.localClient.counts().pending + this.onlinePending.length;
    }
  }

  /** 띠에 둘 받아들여지지 않은 온라인 명령(오늘 영업일의 것). */
  private refusedToday(): RefusedOnline[] {
    const today = this.localClient.today();
    return this.refused.filter((r) => r.day === undefined || today === null || r.day === today);
  }

  /** 같은 일이 받아들여졌다: 그 일의 `처리 실패` 줄을 걷는다(§18 R4-15). */
  private async clearRefused(type: string): Promise<void> {
    if (!this.refused.some((r) => r.type === type)) return;
    this.refused = this.refused.filter((r) => r.type !== type);
    await this.local.patchMeta({ refusedOnline: this.refused }).catch(() => undefined);
    this.emit();
  }

  // ── 기억한 세션 · 앱 잠금(O15) ────────────────────────────────────

  /** 로그인한 세션을 사본 열쇠로 봉인해 둔다(앱을 서버 없이 다시 열 때). 저장할 곳이 없으면 그냥 둔다. */
  private async remember(): Promise<void> {
    const record: RememberedSession = { fmt: 1, session: this.o.session, savedAt: this.clocks.wall() };
    await this.local.writeSessionRecord(REMEMBERED_ID, record).catch(() => undefined);
  }

  /**
   * 온라인 로그인이 된 바로 뒤: 틀린 수 · 잠김 · 서버에 닿지 못한 로그아웃 표시를 걷고 마지막 사용을 지금으로 적은 뒤(먼저: 곧바로 화면을 가려도
   * 잠기지 않게), 기사 역할이면 친 비밀번호로 앱 잠금의 확인 값을 만든다(비밀번호는 남기지 않는다). 다른 역할(임시 차량을 맡은 카운터 · 관리자)은
   * 확인 값을 만들지 않고 있던 것도 지운다(§17 R3-11: 카운터 로그인 · 마감 승인에도 쓰는 비밀번호의 확인 값을 개인 휴대폰에 두지 않는다): 그 사람은
   * 기기에서 잠금을 풀 수 없어 켤 때마다 온라인 로그인이다.
   */
  async setVerifier(pin: string): Promise<void> {
    try {
      await this.local.patchMeta({ lockFailures: 0, lockUntil: undefined, lastFailAt: undefined, lastUseAt: this.clocks.wall(), signOutPending: undefined });
      if (this.o.session.staff.roleKey !== 'driver') {
        await this.local.deleteSessionRecord(VERIFIER_ID);
        return;
      }
      const verifier = await createVerifier(pin, this.o.session.staff.id, this.o.pinIterations ?? PIN_ITERATIONS);
      await this.local.writeSessionRecord(VERIFIER_ID, verifier);
    } catch {
      // 만들지 못함(저장할 곳 없음): 기기에서 잠금을 풀 수 없어 다음 시작은 온라인 로그인이다.
    }
  }

  /** 기기 벽시계가 본 가장 늦은 때보다 뒤로 갔는지(시계 톱니: 기억한 세션이 끝난 것으로 본다). */
  private clockWentBack(meta: { maxSeenWall?: number }): boolean {
    return meta.maxSeenWall !== undefined && this.clocks.wall() < meta.maxSeenWall - this.policy.clockWarnMinutes * 60_000;
  }

  /**
   * 앱 잠금 때인지(앱이 켜지거나 뒤에서 돌아올 때). 이 사람의 확인 값이 있으면: 틀려서 잠긴 동안은 늘, 아니면 마지막 사용에서 app_lock_minutes가 지났을
   * 때(다섯 번 넘게 틀린 뒤에는 늘). 확인 값이 없거나 시계가 뒤로 갔으면 기기에서 풀 수 없다(needLogin): 켤 때(atStart)는 늘 잠그고(fail closed, §17
   * R3-7: 서버의 세션만으로 목록을 열지 않는다), 돌아올 때는 시간이 지났을 때만.
   */
  async lockDue(atStart = false): Promise<LockStatus> {
    const [meta, verifier] = await Promise.all([this.local.readMeta(), this.local.readSessionRecord<PinVerifier>(VERIFIER_ID)]);
    const now = this.clocks.wall();
    const minutes = this.policy.appLockMinutes;
    if (!isVerifier(verifier) || verifier.staffId !== this.o.session.staff.id || this.clockWentBack(meta)) {
      const due = atStart || lockDue(now, meta.lastUseAt, minutes);
      return { due, needLogin: due };
    }
    const until = lockedUntil(now, meta);
    if (until !== undefined) return { due: true, needLogin: false, until };
    return { due: (meta.lockFailures ?? 0) >= MAX_PIN_FAILURES || lockDue(now, meta.lastUseAt, minutes), needLogin: false };
  }

  /**
   * 기기에서 앱 잠금을 푼다(기억한 기사의 비밀번호). 다섯 번 틀릴 때마다 5 · 10 · 20 …분 잠근다(§17 R3-24: 기억한 세션은 지우지 않는다 — 산에서 신호가
   * 없어도 목록 · 번호로 돌아올 수 있게). 확인 값이 없거나 시계가 뒤로 갔으면 login(온라인 로그인).
   */
  async unlock(pin: string): Promise<UnlockResult> {
    const [meta, verifier] = await Promise.all([this.local.readMeta(), this.local.readSessionRecord<PinVerifier>(VERIFIER_ID)]);
    if (!isVerifier(verifier) || verifier.staffId !== this.o.session.staff.id || this.clockWentBack(meta)) return { answer: 'login' };
    const now = this.clocks.wall();
    const until = lockedUntil(now, meta);
    if (until !== undefined) return { answer: 'locked', until };
    if (await checkPin(verifier, pin)) {
      await this.local.patchMeta({ lockFailures: 0, lockUntil: undefined, lastFailAt: undefined, lastUseAt: now }).catch(() => undefined);
      return { answer: 'ok' };
    }
    const failures = (meta.lockFailures ?? 0) + 1;
    const minutes = lockoutMinutes(failures);
    const lockUntil = minutes > 0 ? now + minutes * 60_000 : undefined;
    await this.local.patchMeta({ lockFailures: failures, lastFailAt: now, ...(lockUntil !== undefined ? { lockUntil } : {}) }).catch(() => undefined);
    return lockUntil !== undefined ? { answer: 'locked', until: lockUntil } : { answer: 'wrong' };
  }

  /** 사람이 이 기기를 씀(누름 · 키): 부르는 쪽이 1분에 한 번만 부른다. */
  noteUse(): void {
    void this.local.patchMeta({ lastUseAt: this.clocks.wall() }).catch(() => undefined);
  }

  // ── 안 ────────────────────────────────────────────────────────────

  private copyRef(): { rev: number; epoch: string } | undefined {
    const h = this.localClient.copyHead();
    return h ? { rev: h.rev, epoch: h.epoch } : undefined;
  }

  private emit(head?: SyncHead): void {
    if (this.closed) return;
    const h = head ?? this.lastHead ?? { epoch: this.localClient.copyHead()?.epoch ?? '', rev: this.localClient.copyHead()?.rev ?? 0, configRev: this.localClient.copyHead()?.configRev ?? 0 };
    for (const l of [...this.listeners]) l(h);
  }

  /** 서버 머리(알림 · 심장 박동 · 답): 새 rev · epoch면 사본을 새로 받고, 다시 연결되었으면 보낸다. */
  private onHttpHead(head: SyncHead): void {
    this.lastHead = head;
    const copy = this.localClient.copyHead();
    if (head.epoch && (!copy || head.epoch !== copy.epoch || head.rev > copy.rev)) void this.snapshots.request();
    const online = this.online();
    if (online && !this.wasOnline) {
      this.flusher.reconnected();
      this.flusher.kick();
      void this.resolveOnline();
      void this.snapshots.request();
    }
    // 끊긴 때: 띠의 `마지막 연결`(길의 마지막 답)을 기기 메모에도 적는다(다시 켜도 같은 시각, §18 R4-13).
    if (!online && this.wasOnline) void this.keepLastContact(this.http.lastContactAt());
    this.wasOnline = online;
    this.emit(head);
  }

  /** 기기 메모의 마지막 연결을 앞으로만 옮긴다. */
  private async keepLastContact(at: number): Promise<void> {
    try {
      const meta = await this.local.readMeta();
      if ((meta.lastContactAt ?? 0) < at) await this.local.patchMeta({ lastContactAt: at });
    } catch {
      // 저장할 곳 없음: 이 화면의 띠는 그대로다.
    }
  }

  private async noteContact(serverTime: string | undefined, sentAt: number, receivedAt: number, human = false): Promise<void> {
    const offset = offsetFrom(serverTime, sentAt, receivedAt);
    if (offset !== null) this.offsetMs = offset;
    // 메모 쓰기가 실패해도(저장할 곳 없음) 이 화면의 셈은 이어진다.
    await this.local.patchMeta({
      lastContactAt: receivedAt, maxSeenWall: receivedAt, ...(offset !== null ? { clockOffsetMs: offset, offsetKnown: true } : {}),
      ...(human ? { lastTouchAt: receivedAt } : {}),
    }).catch(() => undefined);
  }

  private async onHeartbeat(answer: HeartbeatResponse, sentAt: number, receivedAt: number): Promise<void> {
    await this.noteContact(answer.serverTime, sentAt, receivedAt);
    await this.afterHead(answer);
    if (this.localClient.counts().pending > 0) this.flusher.kick();
    void this.resolveOnline();
  }

  /** 심장 박동 · 묶음의 운영 값과 epoch(O20: 새 epoch면 보내기 전에 되돌리기 · 정리, §17 R3-1 · R3-3). */
  private async afterHead(answer: { epoch: string; rev: number; policy?: OfflinePolicy; restoredUpToRev?: number | null }): Promise<void> {
    if (answer.policy) this.policy = { ...this.policy, ...answer.policy };
    if (await this.epochSeen(answer.epoch, answer.restoredUpToRev)) void this.snapshots.request(true);
  }

  /**
   * 서버의 epoch를 본다(심장 박동 · 묶음 · 사본마다). 기기가 아는 epoch(기기 메모, 없으면 사본 · 기록의 것)보다 새것이면: 서버가 복구 기준(수)을 주면
   * 옛 epoch의 보낸 기록 · 답을 받은 항목 중 그 뒤의 것을 같은 번호로 다시 보내고(O20), 아니면(시험 매장 새로 만들기 · 모름) 옛 답만 보낸 기록으로
   * 옮긴다(§17 R3-1: 새 매장에 옛 기록을 넣지 않는다). 사본이 없어도 기기 메모로 안다(R3-3). 바뀌었으면 true.
   */
  private async epochSeen(epoch: string | undefined, restoredUpToRev: number | null | undefined): Promise<boolean> {
    if (!epoch) return false;
    return this.local.withLock('skinote-epoch', async () => {
      const meta = await this.local.readMeta();
      const known = meta.epoch ?? this.localClient.copyHead()?.epoch ?? (await this.queue.latestEpoch());
      if (known === epoch) return false;
      if (known === undefined || epoch < known) {
        // 처음 보는 기기 · 옛 epoch의 늦은 답: 적어 두기만(처음) 하거나 무시한다.
        if (known === undefined) await this.local.patchMeta({ epoch });
        return false;
      }
      if (typeof restoredUpToRev === 'number') {
        await this.queue.requeueAfterRestore(epoch, restoredUpToRev);
        await this.local.patchMeta({ epoch, restoredEpoch: epoch, restoredUpToRev });
      } else {
        await this.queue.settleOldEpoch(epoch, this.clocks.wall());
        await this.local.patchMeta({ epoch });
      }
      await this.localClient.reload('queue');
      return true;
    });
  }

  private async heartbeatNow(): Promise<PostAnswer<HeartbeatResponse>> {
    const sentAt = this.clocks.wall();
    const answer = await this.http.postJson<HeartbeatResponse>(API_V2.heartbeat, { report: await this.report() }, { timeoutMs: 8_000 });
    if (answer.kind === 'ok') await this.noteContact(answer.body.serverTime, sentAt, this.clocks.wall());
    return answer;
  }

  private async onBatch(answer: BatchResponse, summary: AnswerSummary, sentAt: number, receivedAt: number): Promise<void> {
    this.lastBatchOkAt = receivedAt;
    // 끝난 결과(적용 · 이미 됨 · 확인 필요 · 보류)의 줄 메모만: 거절 · 충돌로 남은 항목은 사본이 정리할 때 센다(onStored). 팀마다 한 번(§18 R4-17).
    const byId = new Map(this.localClient.queueItems().map((i) => [i.requestId, i]));
    for (const r of answer.results) {
      if (isRetryableResult(r) || r.outcome === 'rejected' || r.outcome === 'conflict' || r.outcome === 'blocked') continue;
      const item = byId.get(r.requestId);
      const key = outcomeNoteKey(r.outcome, r.reviews, { ...(item ? { type: item.type } : {}), ...(r.error ? { errorCode: r.error.code } : {}) });
      if (key) this.batchNotes.push({ key, team: (item ? recordTeam(item.core.payload) : undefined) ?? r.requestId });
    }
    await this.noteContact(answer.serverTime, sentAt, receivedAt, summary.answered + summary.held + summary.settled > 0);
    await this.queue.noteHighWater(answer.device.highWater);
    await this.localClient.reload('queue');
    this.emit();
  }

  private async onDrained(result: FlushResult): Promise<void> {
    await this.snapshots.request(true);
    const notes = this.batchNotes;
    this.batchNotes = [];
    if (result.offlineMade || result.notApplied > 0) this.showSettled(notes);
    void this.resolveOnline();
    this.emit();
  }

  /** 띠의 결과 줄(`전송 대기 0 · 메모 n팀`)을 2분(또는 다음 창까지) 둔다. */
  private showSettled(notes: OutcomeNote[]): void {
    this.settledNotes = notes;
    this.settledUntil = this.clocks.wall() + this.timing.settledMs;
    if (this.settledTimer !== null) this.timers.clearTimeout(this.settledTimer);
    this.settledTimer = this.timers.setTimeout(() => { this.settledTimer = null; this.emit(); }, this.timing.settledMs);
  }

  private async onStored(response: SnapshotResponse): Promise<void> {
    if (response.policy) this.policy = { ...this.policy, ...response.policy };
    await this.local.patchMeta({ lastContactAt: this.clocks.wall() }).catch(() => undefined);
    for (const r of response.onlineRecorded) {
      const entry = this.onlinePending.find((p) => p.envelope.requestId === r.requestId);
      if (!entry) continue;
      // 서버에 적힌 것: 거절 · 충돌이었으면 띠에 한 줄(§17 R3-5). 할 일이 없어 적지 않음(superseded)은 거절이 아니다(§18 R4-15).
      if (!ACCEPTED_ONLINE.has(r.outcome)) await this.noteRefused(entry.envelope);
      await this.forgetOnline(r.requestId);
    }
    // 답을 받지 못한 채 사본이 정리한 기록(답을 잃고 사본이 먼저 옴 · 거절 · 충돌로 남은 항목): 그 줄 메모를 띠에도(§18 R4-1 · R4-14: 말없이 사라지지 않게).
    const waiting = new Map(this.localClient.queueItems().filter((i) => i.state !== 'answered').map((i) => [i.requestId, i]));
    const notes: OutcomeNote[] = [];
    for (const r of response.recorded) {
      const item = waiting.get(r.requestId);
      if (!item) continue;
      const key = outcomeNoteKey(r.outcome, r.reviews, { type: item.type, ...(r.errorCode !== undefined ? { errorCode: r.errorCode } : {}) });
      if (key) notes.push({ key, team: recordTeam(item.core.payload) ?? r.requestId });
    }
    if (notes.length) this.showSettled([...this.settledNotes.filter(() => this.settledUntil > this.clocks.wall()), ...notes]);
    await this.localClient.reload('all');
    if (response.device.missing.length) this.flusher.kick();
  }

  /**
   * 다시 보낸 온라인 명령이 받아들여지지 않았다: 띠에 무엇이 안 되었는지(`처리 실패 · 현금 인계 350,000원 · 매장 확인`, §18 R4-15). 일 이름 · 돈은
   * 전송 대기 목록과 같은 말(domain pendingLine, 팀 · 번호는 적지 않는다). 기기 메모에 두어 앱을 다시 켜도 남는다.
   */
  private async noteRefused(envelope: AnyCommandEnvelope): Promise<void> {
    if (this.refused.some((r) => r.requestId === envelope.requestId)) return;
    const line = pendingLine(undefined, envelope, this.serverNow());
    const today = this.localClient.today();
    this.refused = [...this.refused, {
      requestId: envelope.requestId, type: envelope.type, what: line.what, ...(line.money ? { money: line.money } : {}), ...(today ? { day: today } : {}), at: this.clocks.wall(),
    }];
    await this.local.patchMeta({ refusedOnline: this.refused }).catch(() => undefined);
    this.emit();
  }

  private onSendingChange(): void {
    // 보내는 중 · 결과 확인 중 · 앞 상태로: 대기 수와 점선을 다시 읽는다.
    void this.localClient.reload('queue').catch(() => {});
    const sending = this.flusher.sendingSince();
    if (this.sendingTimer !== null) this.timers.clearTimeout(this.sendingTimer);
    this.sendingTimer = null;
    if (sending && !sending.offlineMade) {
      // 2초가 넘으면 띠가 `전송 중`이 된다(그때 다시 그린다).
      this.sendingTimer = this.timers.setTimeout(() => { this.sendingTimer = null; this.emit(); }, this.timing.sendingBandMs);
    }
    this.emit();
  }

  /** 서명한 봉투(보낼 때의 나이 · 시계 기준, O5 · O8). */
  private async sign(item: QueueItem) {
    const { ageMs, clockAnchor } = ageOf(item, this.clocks, this.pageAnchor, this.offsetMs, this.policy.clockWarnMinutes * 60_000);
    const envelope = overlayEnvelope(item);
    return signQueued(
      { ...envelope, deviceSeq: item.seq, ageMs, clockAnchor, madeAt: madeAtOf(item), recordedBy: item.core.recordedBy } as Parameters<typeof signQueued>[0],
      this.o.deviceKey, this.o.origin, this.local.deviceId,
    );
  }

  /** 기기의 알림(개인정보 없음). 답을 잃은 온라인 명령도 결과 확인 중인 기록으로 센다(§18 R4-4: 카운터의 차량 표시 · 마감이 본다). */
  async report(visibility?: 'visible' | 'hidden'): Promise<DeviceReport> {
    const { items, unreadable } = await this.queue.list();
    const counter = await this.queue.counter();
    const head = this.localClient.copyHead();
    const copyUnreadable = this.localClient.copyStatus() === 'unreadable' ? 1 : 0;
    return deviceReport({
      items, lastSeq: counter.lastSeq, clockOffsetMs: this.offsetMs, appVersion: this.o.appVersion, offlineCapable: this.capable, localFirst: this.localFirst(),
      visibility: visibility ?? (this.visibility.visible() ? 'visible' : 'hidden'), unreadable: unreadable + copyUnreadable,
      ...(head ? { copy: { epoch: head.epoch, rev: head.rev } } : {}),
      onlinePending: this.onlinePending.map((p) => ({ at: p.at })),
    });
  }

  /** 화면이 가려질 때 마지막 알림 한 번(keepalive: 화면이 닫혀도 간다, O11). */
  private async hiddenReport(): Promise<void> {
    if (this.closed) return;
    try {
      await this.http.postJson(API_V2.heartbeat, { report: await this.report('hidden') }, { keepalive: true, timeoutMs: 8_000 });
    } catch {
      // 다음 연결이 다시 알린다.
    }
  }

  private async runMaintenance(): Promise<void> {
    try {
      const result = await this.maintenance.run();
      if (result.scrubbed || result.rolledTo) await this.localClient.reload('copy');
    } catch {
      // 다음 분에 다시.
    }
  }

  /** 온라인 명령 하나(연결됨). 답을 잃으면 봉인해 두고 결과 확인 중(O18), 끊김 허용 명령이고 스위치를 껐으면 보냄 대기로(O2). */
  private async onlineCommand(envelope: AnyCommandEnvelope, offlineOk: boolean): Promise<CommandOutcome> {
    let out: CommandOutcome;
    try {
      out = await this.http.command(envelope);
    } catch (error) {
      if (this.lostCode || !(error instanceof DomainError) || error.code !== 'NETWORK') throw error;
      if (offlineOk && this.localClient.hasCopy()) {
        const queued = await this.localClient.command(envelope);
        if (queued.outcome === 'queued') this.flusher.kick();
        this.emit();
        return queued;
      }
      await this.rememberOnline(envelope);
      return unknownOutcome(envelope, this.o.words, this.copyRef());
    }
    if (isAccepted(out)) {
      await this.local.patchMeta({ lastTouchAt: this.clocks.wall() }).catch(() => undefined);
      await this.refreshAfter();
    }
    return out;
  }

  /** 적용된 온라인 명령 뒤: 사본을 곧바로 새로 받는다(5초까지 기다림). */
  private async refreshAfter(): Promise<void> {
    await Promise.race([
      this.snapshots.request(true),
      new Promise<void>((resolve) => { this.timers.setTimeout(resolve, this.timing.refreshMs); }),
    ]);
  }

  /** 답을 잃은 온라인 명령 하나를 적는다(그 요청번호의 칸만: 다른 화면의 칸을 덮지 않는다, §17 R3-5). */
  private async rememberOnline(envelope: AnyCommandEnvelope): Promise<void> {
    if (this.onlinePending.some((p) => p.envelope.requestId === envelope.requestId)) return;
    const entry = { envelope, at: this.clocks.wall() };
    this.onlinePending = [...this.onlinePending, entry];
    try {
      await this.local.addOnline(entry);
    } catch {
      // 저장할 곳이 없어도 이 화면이 열린 동안은 다시 보낸다.
    }
    this.emit();
  }

  private async forgetOnline(requestId: string): Promise<void> {
    this.onlinePending = this.onlinePending.filter((p) => p.envelope.requestId !== requestId);
    try {
      await this.local.removeOnline(requestId);
    } catch {
      // 다음 연결에서 다시 보내면 서버가 첫 결과를 준다.
    }
    this.emit();
  }

  /** 답을 잃은 온라인 명령 하나를 같은 봉투로 다시 보낸다. 또 안 되면 결과 확인 중. */
  private async resendOnline(requestId: string, fallback: AnyCommandEnvelope): Promise<CommandOutcome> {
    const entry = this.onlinePending.find((p) => p.envelope.requestId === requestId);
    const envelope = entry?.envelope ?? fallback;
    if (!this.online()) return unknownOutcome(envelope, this.o.words, this.copyRef());
    let out: CommandOutcome;
    try {
      out = await this.http.command(envelope);
    } catch {
      return unknownOutcome(envelope, this.o.words, this.copyRef());
    }
    await this.forgetOnline(requestId);
    if (isAccepted(out)) {
      await this.clearRefused(envelope.type);
      await this.refreshAfter();
    }
    return out;
  }

  /** 연결될 때마다: 답을 잃은 온라인 명령을 모두 같은 봉투로 다시 보낸다(O18). */
  private async resolveOnline(): Promise<void> {
    if (this.resolving || this.onlinePending.length === 0 || !this.online()) return;
    this.resolving = true;
    try {
      for (const entry of [...this.onlinePending]) {
        try {
          const out = await this.http.command(entry.envelope);
          await this.forgetOnline(entry.envelope.requestId);
          // 받아들여지지 않은 답(거절 · 충돌)은 조용히 버리지 않는다: 띠에 무엇이 안 되었는지(§17 R3-5 · §18 R4-15, 창은 이미 닫혔다). 할 일이 없어
          // 적지 않음(superseded: 이미 됨)은 거절이 아니다.
          if (isAccepted(out)) {
            await this.clearRefused(entry.envelope.type);
            void this.snapshots.request(true);
          } else if (!ACCEPTED_ONLINE.has(out.outcome)) await this.noteRefused(entry.envelope);
        } catch {
          break;
        }
      }
    } finally {
      this.resolving = false;
    }
  }

  /**
   * 세션 끝(401, O14 d · e): 보낼 것이 있으면 세션 없는 전달로 보낸다. 다 보냈으면 사본을 지우고(끊은 기기는 모두 지우고), 부르는 쪽에 알린다.
   * 보내지 못했으면 사본 · 보냄 대기를 그대로 둔다(다음 로그인이 보낸다).
   */
  private async sessionLost(code: string): Promise<void> {
    if (this.lostCode) return;
    this.lostCode = code;
    this.flusher.stop();
    this.snapshots.stop();
    // 남은 수는 저장소에서 센다(다른 화면이 방금 넣은 기록도, §17 R3-4). 읽지 못하면 이 화면의 셈.
    const waiting = async () => (await this.queue.list().catch(() => null))?.items.filter((i) => i.state !== 'answered').length ?? this.localClient.counts().pending;
    const left = await waiting();
    let revoked = code === 'DEVICE_REVOKED';
    if (left > 0 && this.o.auth) {
      const delivered = await this.deliverAll();
      if (delivered) revoked ||= delivered.revoked;
    }
    try {
      // 사본(이름 · 번호) · 기억한 세션 · 확인 값은 늘 지운다(보낼 것이 남아도: 보냄 대기는 그 열쇠로 남아 다음 로그인이 보낸다, §17 R3-9).
      await this.local.dropCopy();
      // 끊은 기기는 모두 지운다: 저장소가 같은 트랜잭션에서 보낼 것이 없을 때만 지운다(R3-4).
      if (revoked) await this.local.wipeAll();
    } catch {
      // 지우지 못함: 다음 시작의 지움 시계가 한다.
    }
    const notify = this.o.onSessionLost;
    this.close();
    notify?.(code);
  }

  /** 세션 없는 전달(O6 · §4-5): 한 번 값에 서명하고 보냄 대기를 50개씩. 남은 수와 끊긴 기기인지. */
  private async deliverAll(): Promise<{ left: number; revoked: boolean } | null> {
    const auth = this.o.auth;
    if (!auth) return null;
    let revoked = false;
    try {
      for (let round = 0; round < 20; round += 1) {
        const { items } = await this.queue.list();
        const sendable = items.filter((i) => i.state !== 'answered' && i.stuckVersion !== this.o.appVersion).slice(0, 50);
        if (sendable.length === 0) break;
        const challenge = await auth.challenge(this.local.deviceId);
        if (!challenge.ok) break;
        const signature = await signDeliver(this.o.deviceKey, this.o.origin, this.local.deviceId, challenge.value.nonce);
        const commands = [];
        for (const item of sendable) commands.push(await this.sign(item));
        const answer = await auth.deliver({ deviceId: this.local.deviceId, nonce: challenge.value.nonce, signature, report: await this.report(), commands });
        if (!answer.ok) {
          if (answer.status === 0) await this.queue.setState(sendable.map((i) => i.requestId), 'unconfirmed');
          break;
        }
        await this.queue.answer(answer.value.results, answer.value.epoch, this.clocks.wall(), this.o.appVersion);
        revoked ||= answer.value.device.status === 'revoked' || answer.value.device.wipe;
      }
    } catch {
      // 보내지 못함: 남은 것은 다음 로그인이 보낸다.
    }
    const { items } = await this.queue.list();
    return { left: items.filter((i) => i.state !== 'answered').length, revoked };
  }
}

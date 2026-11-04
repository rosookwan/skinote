// 서버 클라이언트(HttpClient implements DomainClient, 계획 work/impl-server/plan.md 6-2). 화면은 체험판과 같은 DomainClient만 보고,
// 이 클라이언트가 우리 서버의 /api/v2를 부른다. 이 클라이언트 자신에는 보냄 대기가 없다(카운터는 연결이 있을 때만 쓴다): 보내지 못한 명령은
// 창이 초안을 쥔 채 `전송 실패 · 재전송 필요`를 보이고, 다시 누르면 같은 요청번호로 다시 보낸다(서버가 요청번호로 한 번만 적용한다). 기사 기기의
// 보냄 대기는 이 클라이언트를 길로 쓰는 DriverClient(local/)에 있다.
//
//   - 요청: 앱 자리 기준 상대 주소(new URL('api/v2/…', document.baseURI)), 같은 곳 쿠키, POST는 application/json + CSRF 머리, 10초.
//   - config()는 알림의 configRev가 바뀔 때까지 한 번 받은 것을 쓴다. ledgerView · query는 POST api/v2/query(GET 조회 길은 없다:
//     끝 4자리 · 이름이 주소 · 앞단 기록에 남지 않게).
//   - 조회 실패: 404 → NOT_FOUND, 400 모르는 화면 · 조회 → UNKNOWN_VIEW, 403 권한 · 범위 밖(기사 세션의 장부 · 다른 차량 업무) →
//     FORBIDDEN(`이 기기에서 사용 불가`, 다시 읽어도 같다 — `업무 없음`으로 숨기지 않는다), 401 → 세션 끝(onSessionLost) + NETWORK,
//     연결 없음 · 5xx → NETWORK.
//   - command: 연결 없음 · 502 · 503 · 504면 같은 본문을 1초 · 2초 · 4초 뒤 다시 보내고, 그래도 안 되면 NETWORK. 서버가 모양을 거절(400)
//     하면 거절 결과(BAD_INPUT, `처리 실패 · 재시도 필요`)로 돌려주고 개발자용 줄을 콘솔에 남긴다.
//   - subscribe: 알림 연결(EventSource api/v2/stream) 하나. rev · configRev가 바뀌거나 연결 상태가 바뀌면 부른다. 알림 연결이 끊긴 동안은
//     머리(GET api/v2/head)를 5초(카운터) · 10초(기사)마다 묻는다(sync 5의 온라인 판). 알림 연결이 살아 보여도 30초 동안 서버와 주고받은
//     것이 없으면 머리를 한 번 묻는다(죽은 연결에 매달린 EventSource는 스스로 알지 못한다): 안 되면 알림 연결을 닫고 끊김으로 본다.
//   - connection(): 넘기기 지연(sync 8-1, ui 4-3 · 5): 요청(조회 · 명령 · 머리 묻기)이 연속 두 번 실패하거나 기기가 네트워크를 잃으면
//     (offline 사건, 곧바로) 끊김, 끊긴 뒤에는 답이 10초 동안 계속 되어야 다시 연결됨. 한 번의 실패 · 한 번의 성공으로 띠 · 이름표가
//     깜빡이지 않는다(산속 기사 휴대폰). 마지막 연결 시각은 서버와 마지막으로 주고받은 때다.
//   - 기사 기기(work/impl-offline/plan.md §7-4 · §7-7): DriverClient가 이 클라이언트를 길로 쓴다. heartbeat를 주면 머리 묻기 대신 간격마다
//     POST heartbeat(기기의 대기 수 · 번호 · 시계 차이), postJson은 사본 · 묶음 · 전달의 한 번 보내기(다시 보내지 않음, 부르는 쪽이 정한다).
//     답의 머리(epoch · rev · linkRev)는 알림과 같이 센다. linkRev만 바뀌어도 알린다(카운터의 차량 표시).
// 비밀값: 세션 쿠키는 HttpOnly라 여기서 보지 못한다. CSRF 값은 메모리에만 둔다(SessionInfo.csrf).
import {
  API_V2, CSRF_HEADER, DomainError, isDriverDevice,
  type AnyCommandEnvelope, type CommandOutcome, type ConnectionState, type DeviceReport, type DomainClient, type HeadInfo, type HeartbeatResponse,
  type LedgerViewResult, type PendingCommand, type QueryName, type QueryParams, type QueryResult, type SessionInfo, type StaffPinResult, type SyncHead,
  type UiConfig, type ViewParams,
} from '@skinote/contract';
import { ServerRefusal } from './server-refusal.ts';
import { say } from './strings.ts';

/** EventSource에서 쓰는 만큼(시험은 가짜를 넣는다). */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface HttpClientOptions {
  session: SessionInfo;
  /** 앱 자리(document.baseURI). 상대 주소 api/v2/…를 여기서 푼다. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** 알림 연결을 여는 법. null이면 알림 연결 없이 머리만 묻는다. 없으면 브라우저의 EventSource. */
  eventSource?: EventSourceFactory | null;
  /** 세션이 끝났을 때(401 · CSRF 불일치). 부르는 쪽이 로그인 화면으로 돌아간다. 한 번만 부른다. */
  onSessionLost?: (code: string) => void;
  /** 알림 연결이 끊긴 동안 머리를 묻는 간격. 없으면 카운터 5초, 기사 10초. */
  pollMs?: number;
  timeoutMs?: number;
  /** 명령을 다시 보내기 전 기다림(연결 없음 · 502 · 503 · 504). */
  retryDelaysMs?: readonly number[];
  /** 알림 연결이 살아 보여도 이만큼 서버와 주고받은 것이 없으면 머리를 한 번 묻는다. */
  heartbeatMs?: number;
  /** 기기의 네트워크 사건(online · offline)을 듣는 곳. 없으면 브라우저 창, null이면 듣지 않는다. */
  networkEvents?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  /** 개발자용 줄(서버가 모양을 거절한 명령 등). 화면에는 나오지 않는다. */
  log?: (message: string, detail?: unknown) => void;
  now?: () => number;
  /** 끊김으로 넘기는 연속 실패 수(offline_policy.fallback_after_failures). */
  failuresToOffline?: number;
  /** 다시 연결됨으로 넘기기 전에 답이 계속 되어야 하는 시간(offline_policy.fallback_recover_seconds). */
  recoverMs?: number;
  /**
   * 기사 기기의 심장 박동(work/impl-offline/plan.md O11 · §7-4): 있으면 머리 묻기(GET head) 대신 pollMs마다 POST heartbeat로 기기의 알림을 보낸다
   * (알림 연결이 살아 있어도). 답은 onHeartbeat로 넘긴다.
   */
  heartbeat?: () => Promise<DeviceReport>;
  onHeartbeat?: (answer: HeartbeatResponse, sentAt: number, receivedAt: number) => void;
  /** 심장 박동을 보낼지(화면이 보이는 동안만). 없으면 늘. */
  visible?: () => boolean;
}

/**
 * 기사 기기의 새 길(사본 · 묶음 · 심장 박동 · 전달)의 답. 다시 보내지 않는다(부르는 쪽이 정한다). failed = 보내지 못했거나 답을 잃음(offline이면
 * 보내기 전부터 기기가 네트워크 없음을 알았다: 서버에 닿지 않았다).
 */
export type PostAnswer<T = unknown> =
  | { kind: 'ok'; status: number; body: T }
  | { kind: 'status'; status: number; code?: string; body?: unknown; retryAfterMs?: number }
  | { kind: 'failed'; offline: boolean };

export const HTTP_DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  retryDelaysMs: [1_000, 2_000, 4_000] as readonly number[],
  heartbeatMs: 30_000,
  pollCounterMs: 5_000,
  pollDriverMs: 10_000,
  failuresToOffline: 2,
  recoverMs: 10_000,
});

/** 심장 박동의 기다림(§7-5). */
const HEARTBEAT_TIMEOUT_MS = 8_000;

/** 명령을 다시 보내는 답(앞단 · 서버가 잠시 받지 못함). */
const RETRY_STATUS: ReadonlySet<number> = new Set([502, 503, 504]);
/** 세션이 끝난 답의 코드(401 모두 + CSRF 불일치). */
const SESSION_CODES: ReadonlySet<string> = new Set(['SIGNED_OUT', 'SESSION_EXPIRED', 'DEVICE_REVOKED', 'BAD_CSRF']);
/** EventSource.CLOSED. */
const ES_CLOSED = 2;

interface Answer {
  status: number;
  /** 우리 서버의 JSON 답(앞단의 HTML 오류 쪽 · 빈 답은 undefined). */
  body: unknown;
  /** 429의 retry-after(ms). */
  retryAfterMs?: number;
}

/** 보내지 못함(연결 없음 · 시간 초과). */
class NetworkFailure extends Error {
  constructor() {
    super('network');
    this.name = 'NetworkFailure';
  }
}

const codeOf = (body: unknown): string | undefined => {
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
};

const isOutcome = (body: unknown): body is CommandOutcome =>
  !!body && typeof body === 'object' && typeof (body as { outcome?: unknown }).outcome === 'string' && typeof (body as { requestId?: unknown }).requestId === 'string';

const isHead = (value: unknown): value is SyncHead =>
  !!value && typeof value === 'object' && typeof (value as SyncHead).rev === 'number' && typeof (value as SyncHead).configRev === 'number' && typeof (value as SyncHead).epoch === 'string'
  && ((value as SyncHead).linkRev === undefined || typeof (value as SyncHead).linkRev === 'number');

export class HttpClient implements DomainClient {
  private readonly fetchImpl: typeof fetch;
  private readonly makeStream: EventSourceFactory | null;
  private readonly baseUrl: string;
  private readonly csrf: string;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly heartbeatMs: number;
  private readonly networkEvents: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  private readonly onSessionLost: (code: string) => void;
  private readonly log: (message: string, detail?: unknown) => void;
  private readonly clock: () => number;
  private readonly listeners = new Set<(head: SyncHead) => void>();
  private head: SyncHead | null = null;
  private online = true;
  private lastSyncAt: string | undefined;
  private state: ConnectionState;
  private configCache: Promise<UiConfig> | null = null;
  private stream: EventSourceLike | null = null;
  private streamUp = false;
  /** 서버와 마지막으로 주고받은 때(clock). */
  private lastContact: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private started = false;
  private closed = false;
  private lost = false;
  private readonly failuresToOffline: number;
  private readonly recoverMs: number;
  /** 연속 실패 수(성공하면 0). */
  private failures = 0;
  /** 끊긴 동안 답이 되기 시작한 때(clock). 그 뒤 실패가 없이 recoverMs가 지나면 다시 연결됨. */
  private goodSince: number | null = null;
  private recoverTimer: ReturnType<typeof setTimeout> | null = null;
  /** 기억한 세션으로 서버 없이 열었다(startOffline): 첫 답이 오면 곧바로 연결됨(끊겼다 돌아온 것이 아니라 아직 묻지 않았을 뿐, §18 R4-13). */
  private bootOffline = false;
  private readonly heartbeatReport: (() => Promise<DeviceReport>) | null;
  private readonly onHeartbeat: ((answer: HeartbeatResponse, sentAt: number, receivedAt: number) => void) | null;
  private readonly visible: () => boolean;

  constructor(options: HttpClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.makeStream = options.eventSource === undefined
      ? (typeof EventSource === 'undefined' ? null : (url) => new EventSource(url) as unknown as EventSourceLike)
      : options.eventSource;
    this.baseUrl = options.baseUrl;
    this.csrf = options.session.csrf;
    this.pollMs = options.pollMs ?? (isDriverDevice(options.session.device.kind) ? HTTP_DEFAULTS.pollDriverMs : HTTP_DEFAULTS.pollCounterMs);
    this.timeoutMs = options.timeoutMs ?? HTTP_DEFAULTS.timeoutMs;
    this.retryDelaysMs = options.retryDelaysMs ?? HTTP_DEFAULTS.retryDelaysMs;
    this.heartbeatMs = options.heartbeatMs ?? HTTP_DEFAULTS.heartbeatMs;
    this.networkEvents = options.networkEvents === undefined ? (typeof window === 'undefined' ? null : window) : options.networkEvents;
    this.onSessionLost = options.onSessionLost ?? (() => {});
    this.log = options.log ?? ((message, detail) => console.error('[skinote] ' + message, detail ?? ''));
    this.clock = options.now ?? (() => Date.now());
    this.failuresToOffline = Math.max(1, options.failuresToOffline ?? HTTP_DEFAULTS.failuresToOffline);
    this.recoverMs = Math.max(0, options.recoverMs ?? HTTP_DEFAULTS.recoverMs);
    this.heartbeatReport = options.heartbeat ?? null;
    this.onHeartbeat = options.onHeartbeat ?? null;
    this.visible = options.visible ?? (() => true);
    // 방금 서버가 준 세션이다: 지금이 마지막 연결이다.
    this.lastContact = this.clock();
    this.lastSyncAt = new Date(this.lastContact).toISOString();
    this.state = { online: true, pendingCount: 0, sendQueue: false, lastSyncAt: this.lastSyncAt };
  }

  /**
   * 기억한 세션으로 서버 없이 연 기사 기기(O15 · §18 R4-13, start 전에): 마지막 연결은 기기 메모의 때(없으면 그대로)이고, 첫 답이 올 때까지 끊김으로
   * 시작한다. 앱을 다시 켤 때마다 `마지막 연결`이 켠 때로 밀리지 않고, 약한 신호에서 묻기가 시간 초과로 끝날 때까지 띠가 비지 않게.
   */
  startOffline(lastContactAt: number | undefined): void {
    if (this.started || this.closed) return;
    if (lastContactAt !== undefined && Number.isFinite(lastContactAt)) {
      this.lastContact = lastContactAt;
      this.lastSyncAt = new Date(lastContactAt).toISOString();
    }
    this.online = false;
    this.bootOffline = true;
    this.state = { online: false, pendingCount: 0, sendQueue: false, ...(this.lastSyncAt ? { lastSyncAt: this.lastSyncAt } : {}) };
  }

  /** 기기가 네트워크를 잃음: 알림 연결을 닫고 곧바로 끊김(기기가 확실히 아는 끊김이라 지연 없이). */
  private readonly onOffline = (): void => {
    this.dropStream();
    this.noteFailure(true);
  };

  /** 기기가 네트워크를 찾음: 곧바로 머리를 묻는다(되면 연결됨 · 알림 연결을 다시 연다). */
  private readonly onOnline = (): void => {
    void this.tick(true);
  };

  /** 알림 연결과 머리 묻기를 시작한다(한 번). 앱이 세션을 받은 뒤 부른다. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.openStream();
    this.pollTimer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.networkEvents?.addEventListener('offline', this.onOffline);
    this.networkEvents?.addEventListener('online', this.onOnline);
  }

  /** 알림 연결 · 머리 묻기를 멈춘다(로그아웃 · 세션 끝 · 화면을 닫음). */
  close(): void {
    this.closed = true;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.recoverTimer !== null) clearTimeout(this.recoverTimer);
    this.recoverTimer = null;
    this.stream?.close();
    this.stream = null;
    this.listeners.clear();
    this.networkEvents?.removeEventListener('offline', this.onOffline);
    this.networkEvents?.removeEventListener('online', this.onOnline);
  }

  // ── DomainClient ─────────────────────────────────────────────────────

  config(): Promise<UiConfig> {
    if (!this.configCache) {
      const loading = this.postQuery<UiConfig>({ name: 'config', params: {} });
      this.configCache = loading;
      // 실패한 것은 두지 않는다(다음에 다시 받는다).
      loading.catch(() => { if (this.configCache === loading) this.configCache = null; });
    }
    return this.configCache;
  }

  ledgerView(viewKey: string, params: ViewParams): Promise<LedgerViewResult> {
    return this.postQuery<LedgerViewResult>({ name: 'ledgerView', params: { viewKey, ...params } });
  }

  query<Q extends QueryName>(name: Q, params: QueryParams[Q]): Promise<QueryResult[Q]> {
    return this.postQuery<QueryResult[Q]>({ name, params: params ?? {} });
  }

  async command(envelope: AnyCommandEnvelope): Promise<CommandOutcome> {
    // 다시 보낼 때도 같은 본문(같은 요청번호 · 같은 글자): 서버가 요청번호와 지문으로 한 번만 적용한다.
    const body = JSON.stringify(envelope);
    for (let attempt = 0; ; attempt += 1) {
      let answer: Answer | null = null;
      try {
        answer = await this.send('POST', API_V2.command, body);
      } catch {
        this.noteFailure();
      }
      if (answer && answer.status === 200 && isOutcome(answer.body)) {
        this.noteSuccess();
        this.noteOutcome(answer.body);
        return answer.body;
      }
      if (answer && !RETRY_STATUS.has(answer.status)) return this.commandRefused(envelope, answer);
      if (answer) this.noteFailure();
      const delay = this.retryDelaysMs[attempt];
      if (delay === undefined || this.lost || this.closed) throw new DomainError('NETWORK', 'command not sent');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  subscribe(onChange: (head: SyncHead) => void): () => void {
    this.listeners.add(onChange);
    return () => { this.listeners.delete(onChange); };
  }

  connection(): ConnectionState {
    return this.state;
  }

  pending(): Promise<PendingCommand[]> {
    return Promise.resolve([]);
  }

  // ── 서버 모드에만 있는 것 ─────────────────────────────────────────────

  /** 지금 머리(오늘 영업일 · 서버 시각). 실패하면 DomainError. */
  async fetchHead(): Promise<HeadInfo> {
    let answer: Answer;
    try {
      answer = await this.send('GET', API_V2.head);
    } catch {
      this.noteFailure();
      throw new DomainError('NETWORK', 'head');
    }
    if (answer.status === 200 && isHead(answer.body)) {
      this.noteSuccess();
      this.applyHead(answer.body);
      return answer.body as HeadInfo;
    }
    throw this.readFailure(answer);
  }

  /**
   * 비밀번호 재발급(매장 설정 `차량 · 직원`, features-1 E15): 요청한 관리자의 비밀번호 ownPin을 먼저 서버가 본다. 새 비밀번호는 답에 한 번만
   * 온다(화면은 창을 닫으면 버린다). 실패는 코드로(PIN_MISMATCH · LOCKED · FORBIDDEN · NETWORK …) 던진다.
   */
  async staffPin(staffId: string, ownPin: string): Promise<StaffPinResult> {
    const answer = await this.serverOnly(API_V2.staffPin, { staffId, ownPin });
    const body = answer.body as Partial<StaffPinResult> | undefined;
    if (answer.status === 200 && body && typeof body.pin === 'string' && typeof body.name === 'string' && typeof body.staffId === 'string') {
      return { staffId: body.staffId, name: body.name, pin: body.pin };
    }
    throw new ServerRefusal(codeOf(answer.body) ?? 'INTERNAL', (answer.body as { lockedUntil?: string } | undefined)?.lockedUntil);
  }

  /** 기기 막기(device.manage): 204면 끝. 실패는 코드로 던진다. */
  async blockDevice(deviceId: string): Promise<void> {
    const answer = await this.serverOnly(API_V2.deviceBlock, { deviceId });
    if (answer.status === 204) return;
    throw new ServerRefusal(codeOf(answer.body) ?? 'INTERNAL');
  }

  /**
   * 막힌 마감을 넘기는 관리자 승인(work/impl-offline/plan.md O12 · §4-7): 본인 비밀번호를 서버가 보고(틀리면 잠김까지 센다) 5분짜리 승인 id를 준다.
   * 실패는 코드로(PIN_MISMATCH · LOCKED · FORBIDDEN · NETWORK …) 던진다. 비밀번호는 기록에 남지 않는다.
   */
  async closingApprove(date: string, ownPin: string): Promise<{ approvalId: string }> {
    const answer = await this.serverOnly(API_V2.closingApprove, { date, ownPin });
    const body = answer.body as { approvalId?: unknown } | undefined;
    if (answer.status === 200 && body && typeof body.approvalId === 'string') return { approvalId: body.approvalId };
    throw new ServerRefusal(codeOf(answer.body) ?? 'INTERNAL', (answer.body as { lockedUntil?: string } | undefined)?.lockedUntil);
  }

  /** 명령이 아닌 서버 길 하나(POST, 다시 보내지 않는다: 비밀번호 재발급은 두 번 보내면 두 번 바뀐다). */
  private async serverOnly(path: string, body: unknown): Promise<Answer> {
    let answer: Answer;
    try {
      answer = await this.send('POST', path, JSON.stringify(body));
    } catch {
      this.noteFailure();
      throw new ServerRefusal('NETWORK');
    }
    this.noteSuccess();
    if (answer.status === 401 || codeOf(answer.body) === 'BAD_CSRF') this.sessionLost(codeOf(answer.body) ?? 'SIGNED_OUT');
    return answer;
  }

  /**
   * 기사 기기의 새 길 하나(POST, CSRF, 다시 보내지 않음, work/impl-offline/plan.md §4). 넘기기 지연(연결 상태)은 다른 요청처럼 센다. 401 · CSRF
   * 불일치는 세션 끝. keepalive는 화면을 닫는 순간의 마지막 알림(pagehide).
   */
  async postJson<T>(path: string, body: unknown, options: { timeoutMs?: number; keepalive?: boolean; accept?: (value: unknown) => boolean } = {}): Promise<PostAnswer<T>> {
    const offlineBefore = typeof navigator !== 'undefined' && navigator.onLine === false;
    let answer: Answer;
    try {
      answer = await this.send('POST', path, JSON.stringify(body), options);
    } catch {
      this.noteFailure();
      return { kind: 'failed', offline: offlineBefore };
    }
    const code = codeOf(answer.body);
    if (answer.status === 401 || code === 'BAD_CSRF') {
      this.sessionLost(code ?? 'SIGNED_OUT');
      return { kind: 'status', status: answer.status, ...(code ? { code } : {}) };
    }
    if (answer.status === 200 && answer.body !== undefined && (!options.accept || options.accept(answer.body))) {
      this.noteSuccess();
      if (isHead(answer.body)) this.applyHead(answer.body);
      return { kind: 'ok', status: 200, body: answer.body as T };
    }
    // 앞단의 오류 쪽(JSON 없음) · 서버 오류는 연결 문제로 센다. 우리 서버가 답한 거절은 연결은 되어 있다.
    if (code === undefined || answer.status >= 500) this.noteFailure();
    else this.noteSuccess();
    return {
      kind: 'status', status: answer.status, ...(code ? { code } : {}), ...(answer.body !== undefined ? { body: answer.body } : {}),
      ...(answer.retryAfterMs !== undefined ? { retryAfterMs: answer.retryAfterMs } : {}),
    };
  }

  /** 지금 한 번 서버에 묻는다(기사 기기: 심장 박동). 화면이 다시 보일 때 · 네트워크를 찾았을 때. */
  poke(): void {
    void this.tick(true);
  }

  /** 서버와 마지막으로 주고받은 때(clock). */
  lastContactAt(): number {
    return this.lastContact;
  }

  /** 알림 연결이 살아 있는지. */
  streaming(): boolean {
    return this.streamUp;
  }

  /** 로그아웃: 세션을 끝낸다(연결이 없어도 이 기기에서는 끝낸다). */
  async logout(): Promise<void> {
    await this.logoutConfirmed();
  }

  /**
   * 로그아웃하고 서버에 닿았는지(204 · 이미 끝남 401). 연결이 없으면 false: 쿠키가 남지만 CSRF 값을 버리므로 이 화면에서는 쓸 수 없다. 기사 기기는
   * 표시를 남겨 다음 연결에서 서버 로그아웃을 먼저 보낸다(work/impl-offline/plan.md §17 R3-7).
   */
  async logoutConfirmed(): Promise<boolean> {
    let reached = false;
    try {
      const answer = await this.send('POST', API_V2.logout, '{}');
      reached = answer.status === 204 || answer.status === 200 || answer.status === 401;
    } catch {
      reached = false;
    }
    this.lost = true;
    this.close();
    return reached;
  }

  // ── 안 ────────────────────────────────────────────────────────────────

  private url(path: string): string {
    return new URL(path, this.baseUrl).href;
  }

  /** 한 번 보낸다. 연결 없음 · 시간 초과는 NetworkFailure를 던진다. */
  private async send(method: 'GET' | 'POST', path: string, body?: string, options: { timeoutMs?: number; keepalive?: boolean } = {}): Promise<Answer> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? this.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (method === 'POST') {
        headers['content-type'] = 'application/json';
        headers[CSRF_HEADER] = this.csrf;
      }
      const res = await this.fetchImpl(this.url(path), {
        method, headers, credentials: 'same-origin', cache: 'no-store', signal: abort.signal, ...(method === 'POST' ? { body: body ?? '{}' } : {}),
        ...(options.keepalive ? { keepalive: true } : {}),
      });
      const json = /application\/json/.test(res.headers.get('content-type') ?? '');
      const parsed: unknown = res.status !== 204 && json ? await res.json().catch(() => undefined) : undefined;
      const retryAfter = Number(res.headers.get('retry-after'));
      return { status: res.status, body: parsed, ...(res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}) };
    } catch {
      throw new NetworkFailure();
    } finally {
      clearTimeout(timer);
    }
  }

  private async postQuery<T>(query: { name: string; params: unknown }): Promise<T> {
    let answer: Answer;
    try {
      answer = await this.send('POST', API_V2.query, JSON.stringify(query));
    } catch {
      this.noteFailure();
      throw new DomainError('NETWORK', 'query ' + query.name);
    }
    if (answer.status === 200 && answer.body !== undefined) {
      this.noteSuccess();
      return answer.body as T;
    }
    throw this.readFailure(answer);
  }

  /** 조회 · 머리의 실패 답 → DomainError(세션이 끝났으면 알린다). */
  private readFailure(answer: Answer): DomainError {
    const code = codeOf(answer.body);
    if (answer.status === 401 || code === 'BAD_CSRF') {
      this.sessionLost(code ?? 'SIGNED_OUT');
      return new DomainError('NETWORK', code ?? 'SIGNED_OUT');
    }
    if (code === undefined || answer.status >= 500) {
      // 앞단(Caddy)의 오류 쪽 · 서버 없음: 연결 끊김.
      this.noteFailure();
      return new DomainError('NETWORK', 'status ' + answer.status);
    }
    // 우리 서버가 답했다: 연결은 되어 있다.
    this.noteSuccess();
    if (answer.status === 404) return new DomainError('NOT_FOUND', code);
    // 이 세션 · 기기가 읽을 수 없는 것(기사 세션의 장부 · 다른 차량 업무): 다시 읽어도 같다. `업무 없음`으로 숨기지 않는다.
    if (answer.status === 403 && (code === 'FORBIDDEN' || code === 'FORBIDDEN_SCOPE')) return new DomainError('FORBIDDEN', code);
    if (code === 'UNKNOWN_VIEW' || code === 'UNKNOWN_QUERY') return new DomainError('UNKNOWN_VIEW', code);
    if (answer.status === 400 || answer.status === 413) {
      this.log('서버가 조회 모양을 거절함', answer.body);
      return new DomainError('UNKNOWN_VIEW', code);
    }
    return new DomainError('NETWORK', code);
  }

  /** 명령이 200 결과가 아닌 답(다시 보내지 않는 것). */
  private commandRefused(envelope: AnyCommandEnvelope, answer: Answer): CommandOutcome {
    const code = codeOf(answer.body);
    if (answer.status === 401 || code === 'BAD_CSRF') {
      this.sessionLost(code ?? 'SIGNED_OUT');
      throw new DomainError('NETWORK', code ?? 'SIGNED_OUT');
    }
    if (code === undefined || answer.status >= 500) {
      this.noteFailure();
      throw new DomainError('NETWORK', 'status ' + answer.status);
    }
    this.noteSuccess();
    if (answer.status === 400 || answer.status === 413) {
      // 봉투의 모양이 틀렸다(앱과 서버의 판이 다름 · 앱의 잘못): 같은 것을 다시 보내도 같다.
      this.log('서버가 명령 모양을 거절함 ' + envelope.type, answer.body);
      return {
        outcome: 'rejected', requestId: envelope.requestId, rev: this.head?.rev ?? envelope.basis.rev, asOfRev: envelope.basis.rev,
        epoch: this.head?.epoch ?? envelope.basis.epoch, rebased: false, changes: [], error: { code: 'BAD_INPUT', message: say('commandFailed') },
      };
    }
    // 429 · 다른 곳에서 온 요청(403 BAD_ORIGIN) · 그 밖: 보내지 못한 것으로 본다(다시 누르면 같은 요청번호).
    if (answer.status !== 429) this.log('명령을 보내지 못함 ' + envelope.type, answer.body);
    throw new DomainError('NETWORK', code);
  }

  /** 적용된 명령의 rev가 아는 것보다 크면 바로 알린다(알림 연결이 늦거나 끊겨도 화면이 새로 읽는다). */
  private noteOutcome(outcome: CommandOutcome): void {
    if (!this.head || outcome.rev <= this.head.rev || outcome.epoch !== this.head.epoch) return;
    this.applyHead({ ...this.head, rev: outcome.rev });
  }

  private sessionLost(code: string): void {
    if (this.lost) return;
    this.lost = true;
    const notify = this.onSessionLost;
    this.close();
    notify(SESSION_CODES.has(code) ? code : 'SIGNED_OUT');
  }

  private setState(online: boolean): void {
    const changed = this.online !== online || this.state.lastSyncAt !== this.lastSyncAt;
    this.online = online;
    if (!changed) return;
    this.state = { online, pendingCount: 0, sendQueue: false, ...(this.lastSyncAt ? { lastSyncAt: this.lastSyncAt } : {}) };
    // 연결 상태만 바뀌어도 알린다(연결 띠 · 머리줄의 이름표가 다시 읽는다). 연결됨의 마지막 연결 시각은 바뀌어도 알리지 않는다.
    this.emit();
  }

  private noteSuccess(): void {
    this.failures = 0;
    this.lastContact = this.clock();
    this.lastSyncAt = new Date(this.lastContact).toISOString();
    if (this.bootOffline) {
      // 서버 없이 연 뒤의 첫 답: 곧바로 연결됨(되살아남의 10초를 기다리지 않는다).
      this.bootOffline = false;
      if (!this.online) {
        this.recovered();
        return;
      }
    }
    if (this.online) {
      // 연결된 동안은 마지막 연결 시각을 조용히 고쳐 둔다(끊기면 그 시각이 보인다).
      this.state = { online: true, pendingCount: 0, sendQueue: false, lastSyncAt: this.lastSyncAt };
      return;
    }
    // 끊긴 뒤의 첫 답: recoverMs 동안 실패가 없으면 다시 연결됨(한 번의 답으로 띠가 깜빡이지 않게).
    if (this.goodSince === null) this.goodSince = this.lastContact;
    if (this.lastContact - this.goodSince >= this.recoverMs) {
      this.recovered();
      return;
    }
    if (this.recoverTimer === null && !this.closed) {
      const wait = Math.max(0, this.goodSince + this.recoverMs - this.clock());
      this.recoverTimer = setTimeout(() => {
        this.recoverTimer = null;
        if (this.goodSince !== null && !this.online && !this.closed) this.recovered();
      }, wait);
    }
  }

  private recovered(): void {
    this.goodSince = null;
    if (this.recoverTimer !== null) clearTimeout(this.recoverTimer);
    this.recoverTimer = null;
    this.setState(true);
  }

  /** 실패 하나. 연속 failuresToOffline번이면 끊김(now면 곧바로: 기기가 네트워크를 잃음). 끊긴 동안의 실패는 다시 연결됨 셈을 되돌린다. */
  private noteFailure(now = false): void {
    this.failures += 1;
    this.goodSince = null;
    if (this.recoverTimer !== null) clearTimeout(this.recoverTimer);
    this.recoverTimer = null;
    if (this.online && (now || this.failures >= this.failuresToOffline)) this.setState(false);
  }

  private applyHead(next: SyncHead): void {
    const prev = this.head;
    this.head = { epoch: next.epoch, rev: next.rev, configRev: next.configRev, ...(next.linkRev !== undefined ? { linkRev: next.linkRev } : {}) };
    if (!prev) return;
    if (prev.configRev !== next.configRev) this.configCache = null;
    // 차량 연결이 바뀌면(linkRev) 카운터가 차량 표시를 다시 읽는다(work/impl-offline/plan.md O11).
    const linkMoved = next.linkRev !== undefined && prev.linkRev !== next.linkRev;
    if (prev.rev !== next.rev || prev.epoch !== next.epoch || prev.configRev !== next.configRev || linkMoved) this.emit();
  }

  private emit(): void {
    const head = this.head ?? { epoch: '', rev: 0, configRev: 0 };
    for (const listener of [...this.listeners]) listener(head);
  }

  private openStream(): void {
    if (!this.makeStream || this.closed || this.stream) return;
    let stream: EventSourceLike;
    try {
      stream = this.makeStream(this.url(API_V2.stream));
    } catch {
      this.streamDown();
      return;
    }
    this.stream = stream;
    stream.onopen = () => {
      if (this.stream !== stream) return;
      this.streamUp = true;
    };
    stream.addEventListener('head', (event: MessageEvent) => {
      if (this.stream !== stream) return;
      let head: unknown;
      try {
        head = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!isHead(head)) return;
      this.streamUp = true;
      this.noteSuccess();
      this.applyHead(head);
    });
    stream.addEventListener('bye', (event: MessageEvent) => {
      if (this.stream !== stream) return;
      stream.close();
      this.stream = null;
      this.streamDown();
      let reason = '';
      try {
        reason = String((JSON.parse(String(event.data)) as { reason?: unknown }).reason ?? '');
      } catch {
        reason = '';
      }
      // 로그아웃 · 기기 끊김: 머리를 한 번 물어 세션이 끝났는지 본다(401이면 로그인 화면으로). 서버 닫힘은 머리 묻기가 다시 잇는다.
      if (reason !== 'server_closing') void this.tick(true);
    });
    stream.onerror = () => {
      if (this.stream !== stream) return;
      this.streamDown();
      // 닫힌 알림 연결(401 · 서버 없음): 머리 묻기가 되면 다시 연다. 여는 중(CONNECTING)이면 브라우저가 스스로 다시 붙는다.
      if (stream.readyState === ES_CLOSED) {
        stream.close();
        this.stream = null;
      }
    };
  }

  /** 심장 박동 한 번(기사 기기): 기기의 알림을 보내고 답(머리 · 운영 값 · 서버 시각)을 넘긴다. 안 되면 NETWORK를 던진다. */
  private async beat(): Promise<void> {
    if (!this.heartbeatReport) return;
    const report = await this.heartbeatReport();
    const sentAt = this.clock();
    const answer = await this.postJson<HeartbeatResponse>(API_V2.heartbeat, { report }, { timeoutMs: HEARTBEAT_TIMEOUT_MS, accept: isHead });
    if (answer.kind === 'ok') {
      this.onHeartbeat?.(answer.body, sentAt, this.clock());
      return;
    }
    throw new DomainError('NETWORK', 'heartbeat');
  }

  private streamDown(): void {
    this.streamUp = false;
  }

  /** 알림 연결을 닫는다(머리 묻기가 되면 다시 연다). */
  private dropStream(): void {
    this.stream?.close();
    this.stream = null;
    this.streamDown();
  }

  /**
   * 머리 묻기: 알림 연결이 끊긴 동안은 간격마다, 살아 보이면 서버와 주고받은 지 heartbeatMs가 지났을 때만, force면 지금.
   * 머리가 안 되면(연결 없음) 알림 연결도 믿지 않는다: 닫고, 머리가 되면 다시 연다.
   */
  private async tick(force = false): Promise<void> {
    if (this.closed || this.lost || this.polling) return;
    // 기사 기기의 심장 박동은 알림 연결이 살아 있어도 간격마다 보낸다(서버가 기기의 대기 수 · 마지막 연결을 안다). 화면이 가려진 동안은 쉰다.
    if (this.heartbeatReport) {
      if (!force && !this.visible()) return;
    } else if (this.streamUp && !force && this.clock() - this.lastContact < this.heartbeatMs) return;
    this.polling = true;
    try {
      if (this.heartbeatReport) await this.beat();
      else await this.fetchHead();
      // 머리가 되면 닫힌 알림 연결을 다시 연다.
      if (!this.stream) this.openStream();
    } catch (error) {
      // fetchHead가 연결 상태 · 세션 끝을 이미 적었다.
      if (!this.lost && error instanceof DomainError && error.code === 'NETWORK') this.dropStream();
    } finally {
      this.polling = false;
    }
  }
}

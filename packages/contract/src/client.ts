// 화면과 도메인의 연결(ui 7절)과 명령 봉투(sync 2절). HttpClient(매장 PC 서버의 /api/v2)와
// LocalClient(체험판 · 기사 기기의 오프라인 읽기, 같은 store · domain 코드)가 이 형식을 구현한다.
import type { UiConfig } from './config.ts';
import type { ActionKey, DeviceClassKey } from './vocab.ts';
import type {
  Basis, BusinessDate, FindResult, IsoTime, LedgerViewResult, OrderSlip, ReviewItem, VehicleLoad,
} from './read-models.ts';
import { newRequestId } from './request-id.ts';

/** 이 앱이 아는 계약 판. 기기는 이 값을 알리고, config()는 그보다 늦게 들어온 sys 키를 쓰는 설정 행을 빼고 준다. */
export const CONTRACT_VERSION = 1;

/** ledgerView의 인자. 날짜가 없으면 서버의 영업일. */
export interface ViewParams {
  date?: BusinessDate;
  tabKey?: string;
  vehicleId?: string;
  /** 어느 등급 판으로 그릴지(기사 태블릿 · 휴대폰 · 카운터 수거 목록은 같은 화면 키의 다른 판). 없으면 서버가 기기에서 정한다. */
  deviceClass?: DeviceClassKey;
}

/** 확인 창 초안 조회의 인자(접수 확정 창 등, 틀이 따로인 것). */
export interface ConfirmDraftParams {
  orderId?: string;
  draftId?: string;
  actionKey: ActionKey;
  lineIds?: string[];
  /** 업무 단위 도장(받음 · 빨리 확인)의 업무. */
  taskId?: string;
  /** 차량 단위 일(매장 입고 · 시간순 되돌리기 · 인쇄)의 차량. */
  vehicleId?: string;
}

/** 확인 창이 확정하면 보낼 명령(종류와 본문). 창은 수량 −/+ · 고른 수단만 본문에 넣고, 나머지는 서버가 정한 그대로 보낸다. */
export type ConfirmCommand = { [T in CommandType]: { type: T; payload: CommandPayloads[T] } }[CommandType];

/** 확인 창에서 고르는 결제 수단 버튼(빠른 수단). 첫 것이 처음 선택이다. */
export interface ConfirmMethod {
  key: string;
  label: string;
}

/**
 * 확인 창 초안 조회의 결과: 창이 보일 요약과 돈 결정의 바탕(expect). command가 없으면 확정할 것이 없다는 뜻이고,
 * 창 대신 notice 한 문장('받을 돈이 없습니다')을 보인다.
 */
export interface ConfirmDraftView {
  basis: Basis;
  title: string;
  summary: string[];
  /** 돈 결정의 바탕(받을 돈). 창을 연 때 초안에 넣어 명령과 함께 보낸다(sync 4-2). 돈 명령은 이것이 없으면 거절된다. */
  expect?: Expect;
  /** 먼저 적용되어야 하는 명령의 요청번호(오프라인에서 이어진 명령, sync 2절). */
  dependsOn?: string[];
  quantity?: { value: number; min: number; max: number; unit: string };
  /** 주 버튼 이름('지급 도장 찍기 · 6개'). */
  confirmLabel?: string;
  command?: ConfirmCommand;
  /** 수납 창의 수단 버튼. 고른 key가 본문의 methodKey가 된다. */
  methods?: ConfirmMethod[];
  /** 확정할 것이 없을 때의 한 문장. */
  notice?: string;
}

/** 틀이 따로인 조회(ui 7절: orderSlip · confirmDraft · reviewList · vehicleLoad, 끝 4자리 찾기). */
export interface QueryMap {
  orderSlip: { params: { orderId: string; deviceClass?: DeviceClassKey }; result: OrderSlip };
  findLast4: { params: { last4: string; date?: BusinessDate }; result: FindResult };
  confirmDraft: { params: ConfirmDraftParams; result: ConfirmDraftView };
  reviewList: { params: { scope?: 'mine' | 'all' }; result: ReviewItem[] };
  vehicleLoad: { params: { vehicleId: string }; result: VehicleLoad };
}
export type QueryName = keyof QueryMap;
export type QueryParams = { [Q in QueryName]: QueryMap[Q]['params'] };
export type QueryResult = { [Q in QueryName]: QueryMap[Q]['result'] };

/** 돈 결정의 바탕이 된 숫자. 서버가 지금 값과 비교해 다르면 충돌(sync 4-2). */
export interface Expect {
  dueAmount?: number;
  refundAmount?: number;
  expectedCash?: Record<string, number>;
}

/** 이 화면 줄기가 보내는 명령의 본문. 명령 이름은 sys_event_types의 key다. */
export interface CommandPayloads {
  'stock.issue': { orderId: string; lines: { lineId: string; quantity: number; assetIds?: string[] }[] };
  'stock.direct_return': { orderId: string; lines: { lineId: string; quantity: number; assetIds?: string[] }[] };
  'stock.load': { taskId: string; lines: { lineId: string; quantity: number; assetIds?: string[] }[] };
  'stock.collect': { taskId: string; lines: { lineId: string; quantity: number; assetIds?: string[] }[] };
  'stock.receive': { vehicleId: string; taskIds: string[] };
  'payment.take': { orderIds: string[]; amount: number; methodKey: string; allocations?: { orderId: string; amount: number }[] };
  'route.move': { taskId: string; anchorTaskId: string | null; position: 'before' | 'after' | 'top' };
  'route.reset': { vehicleId: string; date: BusinessDate };
  'task.pin': { taskId: string; note?: string };
  'task.unpin': { pinId: string };
  'task.visit': { taskId: string; outcomeKey: string; retry?: { date: BusinessDate; at?: IsoTime } };
  'notification.ack': { notificationId: string };
}
export type CommandType = keyof CommandPayloads;

/** 돈을 옮기는 명령: expect(창이 본 받을 돈)가 없으면 서버가 거절한다(sync 4-2). */
export const MONEY_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>(['payment.take']);

/** 큐에 쌓였던 명령의 서명된 행위자(그 일을 한 순간 기기에 로그인한 직원). */
export interface RecordedBy {
  staffId: string;
  sessionId: string;
  signature: string;
}

/** 명령 봉투(sync 2절). 매장 · 역할 · 권한 · recorded_at · 영업일 · rev는 봉투에서 받지 않는다. */
export interface CommandEnvelope<T extends CommandType> {
  type: T;
  commandVersion: number;
  requestId: string;
  deviceSeq?: number;
  ageMs?: number;
  clockAnchor?: string;
  basis: Basis;
  expect?: Expect;
  dependsOn?: string[];
  recordedBy?: RecordedBy;
  replay?: Record<string, unknown> | null;
  payload: CommandPayloads[T];
}

/** 어느 명령이든 하나: type으로 가르면 payload의 모양이 정해진다(종류와 본문이 어긋난 봉투는 형식에서 막힌다). */
export type AnyCommandEnvelope = { [T in CommandType]: CommandEnvelope<T> }[CommandType];

/**
 * 명령 결과. queued는 서버 결과가 아니라 기기 쪽 결과다: 오프라인 기사 기기가 보냄 대기에 넣었다(sync 8-1).
 * 화면은 창을 닫고, 목록은 그 도장을 점선으로 그린다. 서버의 command_log에는 queued가 없다.
 */
export type CommandOutcomeKey = 'applied' | 'partially_applied' | 'superseded' | 'needs_review' | 'rejected' | 'blocked' | 'conflict' | 'queued';

/** 이어 붙은 결과의 달라진 것 한 줄('그사이 헬멧 1개가 추가되어 합계가 125,000원입니다'). */
export interface ChangeNote {
  message: string;
}

export interface CommandOutcome {
  outcome: CommandOutcomeKey;
  requestId: string;
  rev: number;
  asOfRev: number;
  epoch: string;
  rebased: boolean;
  changes: ChangeNote[];
  /** 서버가 정한 값(복구 때 다시 보내려고 기기가 보관). */
  canonical?: Record<string, unknown>;
  result?: Record<string, unknown>;
  /** 거절 · 충돌이면 쉬운 한 문장과 지금 상태. */
  error?: { code: string; message: string; current?: unknown };
}

export type PendingState = 'queued' | 'sending' | 'applied' | 'superseded' | 'needs_review' | 'rejected' | 'stalled';

/** 보냄 대기 목록의 한 건(오프라인 기사 기기). */
export interface PendingCommand {
  requestId: string;
  type: CommandType;
  state: PendingState;
  createdAt: IsoTime;
  /** 목록에 보일 한 줄('김민수 · 0025 받음 21:42'). */
  summary: string;
}

/** 동기화 머리(SSE 알림). configRev가 오르면 기기는 설정(config)을 다시 받는다(ui 2절). */
export interface SyncHead {
  epoch: string;
  rev: number;
  configRev: number;
}

/** 이 기기의 연결 상태(연결 띠 · 매장 입고의 연결 확인). 바뀌면 subscribe로 알린다. */
export interface ConnectionState {
  online: boolean;
  /** 보냄 대기에 있는 명령 수. */
  pendingCount: number;
  /** 마지막으로 서버와 맞춘 때(연결이 끊긴 때). */
  lastSyncAt?: IsoTime;
}

/**
 * 조회가 실패한 까닭. 화면은 코드로만 가르고 문장은 스스로 쓴다.
 * NOT_FOUND: 없는 접수 · 업무(다시 읽어도 같다), NETWORK: 연결이 끊겼거나 서버가 답하지 않음(다시 읽으면 될 수 있다),
 * UNKNOWN_VIEW: 이 서버에 없는 화면 · 조회(앱과 서버의 판이 다름).
 */
export type DomainErrorCode = 'NOT_FOUND' | 'NETWORK' | 'UNKNOWN_VIEW';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

/** 실패의 코드(DomainError가 아니면 NETWORK로 본다: 알 수 없는 실패는 다시 읽어 본다). */
export function domainErrorCode(error: unknown): DomainErrorCode {
  return error instanceof DomainError ? error.code : 'NETWORK';
}

/**
 * 화면과 서버가 함께 쓰는 형식(ui 7절).
 * 실패의 약속: 조회(config · ledgerView · query)는 실패하면 DomainError로 거절한다. command는 업무 결과(거절 · 충돌 포함)를
 * CommandOutcome으로 돌려주고, 보내지 못했을 때(연결 끊김)만 DomainError('NETWORK')로 거절한다. 부르는 쪽은 늘 거절을 받아
 * '처리 중'을 풀고 쉬운 한 문장을 보인다.
 */
export interface DomainClient {
  /** 레지스트리 · 사용 기능 · 문구 · config_rev(기기가 아는 키만). */
  config(): Promise<UiConfig>;
  /** 설정으로 그리는 모든 목록. */
  ledgerView(viewKey: string, params: ViewParams): Promise<LedgerViewResult>;
  /** 틀이 따로인 것(접수증, 확정 창 초안 등). */
  query<Q extends QueryName>(name: Q, params: QueryParams[Q]): Promise<QueryResult[Q]>;
  command(envelope: AnyCommandEnvelope): Promise<CommandOutcome>;
  /** 새 rev · 새 config_rev · 연결 상태가 바뀌면 부른다. */
  subscribe(onChange: (head: SyncHead) => void): () => void;
  /** 이 기기의 연결 상태(카운터는 매장 네트워크의 연결). */
  connection(): ConnectionState;
  /** 보냄 대기 목록(오프라인). */
  pending(): Promise<PendingCommand[]>;
}

/** 인쇄 작업 참조(매장 서버가 그려 얼린 문서). */
export interface PrintJobRef {
  jobId: string;
}
export interface PrintOutcome {
  ok: boolean;
  message?: string;
}

/** PWA와 데스크톱 포장 앱이 각자 구현하는 기기 기능(ui 7절). */
export interface PlatformBridge {
  print(job: PrintJobRef): Promise<PrintOutcome>;
  openDrawer(): Promise<void>;
  cardTerminal(intentId: string): Promise<void>;
  playAlert(kind: string): void;
  wakeLock(on: boolean): void;
  saveFile(name: string, data: Blob): Promise<void>;
  app(): { version: string; contract: number; updateReady: boolean; applyUpdate(): void };
}

/**
 * 확인 창의 명령 초안. 요청번호는 창이 열릴 때 한 번 만들고, 두 번 누르기 · '처리 중'에 또 누르기 · 창이 열린 채 새로 고침한 뒤
 * 같은 창을 다시 열 때(보내기 전)에는 같은 번호로 보낸다. 한 번 보낸 초안(sentAt)의 번호는 새 창에 다시 쓰지 않는다.
 * basis는 창이 그린 읽기 모델의 시점이고, 창이 열린 동안 새 rev가 와도 바뀌지 않는다.
 */
export interface CommandDraft<T extends CommandType> {
  requestId: string;
  type: T;
  commandVersion: number;
  openedAt: IsoTime;
  basis: Basis;
  payload: CommandPayloads[T];
  expect?: Expect;
  dependsOn?: string[];
  /** 이 초안으로 명령을 보낸 때. 있으면 이 요청번호는 끝난 일이다. */
  sentAt?: IsoTime;
}

/** 어느 명령이든 하나의 초안(type으로 가르면 payload가 정해진다). */
export type AnyCommandDraft = { [T in CommandType]: CommandDraft<T> }[CommandType];

export interface OpenDraftOptions {
  now?: number;
  requestId?: string;
  commandVersion?: number;
  expect?: Expect;
  dependsOn?: string[];
}

/** 확인 창을 열 때 부른다: 요청번호를 만들고 basis를 고정한다. 명령은 종류와 본문이 한 덩이(ConfirmCommand)다. */
export function openCommandDraft(command: ConfirmCommand, basis: Basis, options: OpenDraftOptions = {}): AnyCommandDraft {
  const now = options.now ?? Date.now();
  // 종류와 본문을 한 덩이로 받았으므로 초안도 같은 종류다(형식 검사기가 짝을 따라가지 못해 한 번만 넓힌다).
  const draft = {
    requestId: options.requestId ?? newRequestId(now),
    type: command.type,
    commandVersion: options.commandVersion ?? 1,
    openedAt: new Date(now).toISOString(),
    basis: { epoch: basis.epoch, rev: basis.rev },
    payload: command.payload,
  } as AnyCommandDraft;
  if (options.expect) draft.expect = options.expect;
  if (options.dependsOn) draft.dependsOn = options.dependsOn;
  return draft;
}

/**
 * 창을 다시 열 때 저장된 초안을 쓸지: 아직 보내지 않았고, 같은 명령 종류이고, 같은 basis(그 뒤로 바뀐 것이 없음)일 때만.
 * 한 번 보낸 초안이거나 자료가 바뀌었으면 새 요청번호로 새 초안을 만든다(새 의도에 옛 번호를 쓰면 서버가 옛 결과를 돌려준다).
 */
export function reusableDraft(saved: AnyCommandDraft | null | undefined, type: CommandType, basis: Basis): AnyCommandDraft | null {
  if (!saved || saved.sentAt !== undefined || saved.type !== type) return null;
  return saved.basis.epoch === basis.epoch && saved.basis.rev === basis.rev ? saved : null;
}

/** 기기 쪽 값(큐 명령이면 기기 번호 · 나이 · 서명). 온라인 명령은 비워 둔다. */
export interface DeviceStamp {
  deviceSeq?: number;
  ageMs?: number;
  clockAnchor?: string;
  recordedBy?: RecordedBy;
}

/**
 * 확정한 초안을 봉투로. 수량 −/+처럼 창에서 바뀐 본문은 command(같은 종류)로 덮는다(요청번호 · basis · expect는 그대로).
 * 종류가 다른 command를 넘기면 던진다(초안과 다른 일을 같은 요청번호로 보내지 않게).
 */
export function draftToEnvelope(draft: AnyCommandDraft, device: DeviceStamp = {}, command?: ConfirmCommand): AnyCommandEnvelope {
  if (command && command.type !== draft.type) throw new Error('초안과 다른 명령을 보낼 수 없다: ' + draft.type + ' ≠ ' + command.type);
  const envelope = {
    type: draft.type,
    commandVersion: draft.commandVersion,
    requestId: draft.requestId,
    basis: draft.basis,
    payload: command ? command.payload : draft.payload,
  } as AnyCommandEnvelope;
  if (draft.expect) envelope.expect = draft.expect;
  if (draft.dependsOn) envelope.dependsOn = draft.dependsOn;
  if (device.deviceSeq !== undefined) envelope.deviceSeq = device.deviceSeq;
  if (device.ageMs !== undefined) envelope.ageMs = device.ageMs;
  if (device.clockAnchor !== undefined) envelope.clockAnchor = device.clockAnchor;
  if (device.recordedBy) envelope.recordedBy = device.recordedBy;
  return envelope;
}

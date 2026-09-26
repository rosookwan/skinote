// 화면과 도메인의 연결(ui 7절)과 명령 봉투(sync 2절). HttpClient(매장 PC 서버의 /api/v2)와
// LocalClient(체험판 · 기사 기기의 오프라인 읽기, 같은 store · domain 코드)가 이 형식을 구현한다.
import type { UiConfig } from './config.ts';
import type { ActionKey, ConfirmTemplateKey, DeviceClassKey } from './vocab.ts';
import type {
  Basis, BusinessDate, FindResult, IsoTime, LedgerViewResult, OrderSlip, ReviewItem, VehicleLoad,
} from './read-models.ts';
import type {
  AddTicketSheetParams, AddTicketSheetView, CheckoutChoice, CheckoutSheetParams, CheckoutSheetView, ClosingSheetParams, ClosingSheetView,
  FieldPaySheetParams, FieldPaySheetView, GroupPaySheetParams, GroupPaySheetView, LineUnits, OrderDraftInput, OrderDraftParams, OrderDraftView,
  PartialPaySheetParams, PartialPaySheetView, PromiseInput, PromiseSheetParams, PromiseSheetView, ReturnPieceLine, ReturnSheetParams, ReturnSheetView, RuleChange,
  ShopRulesParams, ShopRulesView, TaskSheetParams, TaskSheetView,
} from './sheets.ts';
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
  /**
   * 수량 칸(ConfirmDraftView.counts)이 있는 창에서 사람이 고른 줄마다의 수(없으면 모두: 창을 연 때의 잔여 수). 고를 때마다 이 인자로 다시
   * 물으면 요약 · 주 버튼 · 명령을 새로 써 준다(반납 창 returnSheet의 picked와 같은 모양).
   */
  picked?: LineUnits[];
}

/** 확인 창이 확정하면 보낼 명령(종류와 본문). 창은 수량 −/+ · 고른 수단만 본문에 넣고, 나머지는 서버가 정한 그대로 보낸다. */
export type ConfirmCommand = { [T in CommandType]: { type: T; payload: CommandPayloads[T] } }[CommandType];

/**
 * 확정하면 이어서 보낼 명령 하나(반납 뒤의 보증금 반환, 지급 뒤의 보증금 입금, 리프트권 추가 뒤의 현장 수납).
 * 요청번호는 창이 열릴 때 명령마다 만들고, 앞 명령의 요청번호를 dependsOn으로 가진다(sync 2절).
 */
export interface ConfirmStep {
  command: ConfirmCommand;
  expect?: Expect;
}

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
  /**
   * 틀이 따로인 확인 창(sys_confirm_templates): 'return'이면 화면은 요약 창 대신 반납 확인 창(V1, returnSheet)을 연다.
   * 없으면 요약 창(ConfirmDialog).
   */
  template?: ConfirmTemplateKey;
  /** command 뒤에 이어서 보낼 명령들(앞 명령에 dependsOn). */
  then?: ConfirmStep[];
  /**
   * 줄마다의 수량 −/+ 칸(수량으로 세는 줄 여럿: 지급 · 적재 · 배달 · 수거, 2026-09-26 첫 매장). 처음 값은 잔여 수 그대로(모두 골라 둠)이고
   * 안 가져온 · 안 준 것만 낮춘다. 낮춘 수는 요약의 `잔여 · …` 줄에 있다. 반납 창(V1)의 수량 칸과 같은 모양(mode 'count').
   */
  counts?: ReturnPieceLine[];
}

/** 틀이 따로인 조회(ui 7절: orderSlip · confirmDraft · reviewList · vehicleLoad, 끝 4자리 찾기). */
export interface QueryMap {
  orderSlip: { params: { orderId: string; deviceClass?: DeviceClassKey }; result: OrderSlip };
  findLast4: { params: { last4: string; date?: BusinessDate }; result: FindResult };
  confirmDraft: { params: ConfirmDraftParams; result: ConfirmDraftView };
  reviewList: { params: { scope?: 'mine' | 'all' }; result: ReviewItem[] };
  vehicleLoad: { params: { vehicleId: string }; result: VehicleLoad };
  // 둘째 판 화면(sheets.ts): 사람이 고른 것을 인자로 다시 물으면 줄 글 · 합계 · 주 버튼 · 명령을 새로 써 준다.
  /** V1 반납 확인 창 · 부분 반납. */
  returnSheet: { params: ReturnSheetParams; result: ReturnSheetView };
  /** V9 일정 변경 · 부분 품목. */
  promiseSheet: { params: PromiseSheetParams; result: PromiseSheetView };
  /** V2 · V3 새 접수(기기의 초안을 미리 보기: 타일 · 고른 품목 · 합계 · 일정 고르기 · 접수 내용). */
  orderDraft: { params: OrderDraftParams; result: OrderDraftView };
  /** V4 접수 확정 창 · 칸별 수납. */
  checkoutSheet: { params: CheckoutSheetParams; result: CheckoutSheetView };
  /** V5 일괄 수납 · 여러 팀. */
  groupPaySheet: { params: GroupPaySheetParams; result: GroupPaySheetView };
  /** V5 부분 결제 판(팀 안의 품목 · 수량). */
  partialPaySheet: { params: PartialPaySheetParams; result: PartialPaySheetView };
  /** V6 하루 마감. */
  closingSheet: { params: ClosingSheetParams; result: ClosingSheetView };
  /** V7 기사 업무 판(배달 · 수거 한 팀). */
  taskSheet: { params: TaskSheetParams; result: TaskSheetView };
  /** V7 현장 수납 판. */
  fieldPaySheet: { params: FieldPaySheetParams; result: FieldPaySheetView };
  /** V7 리프트권 추가 판. */
  addTicketSheet: { params: AddTicketSheetParams; result: AddTicketSheetView };
  /** V8 매장 설정 · 운영 규칙. */
  shopRules: { params: ShopRulesParams; result: ShopRulesView };
}
export type QueryName = keyof QueryMap;
export type QueryParams = { [Q in QueryName]: QueryMap[Q]['params'] };
export type QueryResult = { [Q in QueryName]: QueryMap[Q]['result'] };

/** 돈 결정의 바탕이 된 숫자. 서버가 지금 값과 비교해 다르면 충돌(sync 4-2). */
export interface Expect {
  dueAmount?: number;
  refundAmount?: number;
  /** 돈통 · 차량 지갑 · 인계 id → 예상 현금(마감 · 차량 현금 점검). */
  expectedCash?: Record<string, number>;
  /** 이 팀 · 규칙의 보관 중 보증금(보증금 입금 · 반환). */
  depositHeld?: number;
  /** 팀마다 받을 금액(일괄 수납: 접수 id → 금액). */
  dueByOrder?: Record<string, number>;
  /** 창이 본 가격 계산(새 접수 · 리프트권 추가, catalog 8의 quote_hash). */
  quoteHash?: string;
}

/** 수납 한 건을 나누는 배분(팀마다, 품목으로 나눠 내면 줄 · 수량까지, data-model 4-12). */
export interface PaymentAllocationInput {
  orderId: string;
  amount: number;
  lines?: { lineId: string; quantity: number; amount: number }[];
}

/** 이 화면 줄기가 보내는 명령의 본문. 명령 이름은 sys_event_types의 key다. */
export interface CommandPayloads {
  'stock.issue': { orderId: string; lines: LineUnits[] };
  'stock.direct_return': { orderId: string; lines: LineUnits[] };
  'stock.load': { taskId: string; lines: LineUnits[] };
  'stock.collect': { taskId: string; lines: LineUnits[] };
  'stock.receive': { vehicleId: string; taskIds: string[]; lines?: LineUnits[] };
  /** 차량 배달(기사가 손님께 건넴, 오프라인 허용). */
  'stock.deliver': { taskId: string; lines: LineUnits[] };
  /**
   * 수납 한 건(카드 한 번 · 현금 한 번)과 배분. purposeKey는 결제 자리(payment_groups.purpose_key). payerOrderId는 일괄 수납(V5)의 결제 팀:
   * 그 팀이 내기로 한 몫(payment_promises)을 채우고, 품목 일부만 낸 팀의 남은 줄은 그 팀 몫(미수)으로 돌린다. 이때 expect.dueByOrder에
   * 창이 본 팀마다의 받을 금액을 싣고, 그사이 바뀐 팀이 있으면 충돌(error.current의 orderIds, `changedOrders`)이다.
   */
  'payment.take': {
    orderIds: string[]; amount: number; methodKey: string; allocations?: PaymentAllocationInput[];
    purposeKey?: 'multi_order' | 'split_by_items' | 'intake_confirm'; payerOrderId?: string;
  };
  /** 후불 처리(현장 수납 판) · 결제 팀 지정. */
  'payment_promise.set': { orderId: string; payerOrderId: string | null; lineIds?: string[] };
  /** 품목 줄 수량 일부의 일정 변경(N2): 떼어 낸 수량이 새 일정을 갖는다. */
  'promise.change': { orderId: string; kind: 'pickup' | 'return'; lines: { lineId: string; quantity: number }[]; promise: PromiseInput };
  /**
   * 새 접수 확정(V4): 약속 · 결제 약속 · 칸별 수납 · 보증금 입금이 한 명령. 적용되면 결과(result)에 새 접수의 id와 접수 번호
   * (`createdOrder`로 읽는다). 서버가 가격을 다시 계산해 expect.quoteHash와 다르면 충돌(catalog 8 QUOTE_CHANGED).
   */
  'order.create': { draft: OrderDraftInput; choices: CheckoutChoice[]; payerOrderId: string | null };
  /** 보증금 입금(팀 · 규칙마다 보관 하나, 매수는 보증금 장부). */
  'deposit.take': { orderId: string; ruleKey: string; lines: LineUnits[]; amount: number; methodKey: string };
  /** 보증금 반환(돌아온 매수만큼). refundMethodKey: cash · offset_due(미수 차감) · same_method. */
  'deposit.return': { orderId: string; ruleKey: string; lines: LineUnits[]; amount: number; refundMethodKey: string };
  /** 기사 현장 수납(차량 지갑, 오프라인 허용). */
  'field.collect': { taskId: string; orderId: string; amount: number; methodKey: string };
  /** 차량 예비권으로 리프트권 추가(권 줄 · 값 · 보증금을 한 명령으로). */
  'field.add_ticket': { taskId: string; orderId: string; productKey: string; quantity: number; assetIds: string[]; amount: number; deposit?: { ruleKey: string; amount: number } };
  /** 수거 현장의 권 보증금 반환(차량 지갑). */
  'field.deposit_return': { taskId: string; orderId: string; ruleKey: string; lines: LineUnits[]; amount: number };
  /** 차량 현금 인계(기사 → 넘기는 중 돈통). */
  'cash.transfer': { vehicleId: string; amount: number };
  /**
   * 카운터가 인계 현금을 세고 확인(넘기는 중 → 카운터 돈통, 차액은 과부족). transferId는 인계 id, 또는 아직 인계하지 않은 차량 지갑
   * (`van:<차량>`): 기사가 카운터에서 봉투를 건네면 그 자리에서 인계와 확인을 함께 적는다(마감 화면의 차량 현금 점검).
   */
  'cash.transfer_confirm': { transferId: string; countedAmount: number; reasonKey?: string; reasonNote?: string };
  /** 마감(돈통마다 센 금액, 점검 이월한 인계, 넘어가기 사유). */
  'closing.close': {
    date: BusinessDate;
    drawerCounts: { drawerId: string; countedAmount: number; expectedAmount?: number; reasonKey?: string; reasonNote?: string }[];
    deferredTransferIds: string[];
    overrideReason?: string;
  };
  /** 운영 규칙 저장(다음 기록부터). */
  'setting.set': { changes: RuleChange[] };
  'route.move': { taskId: string; anchorTaskId: string | null; position: 'before' | 'after' | 'top' };
  'route.reset': { vehicleId: string; date: BusinessDate };
  'task.pin': { taskId: string; note?: string };
  'task.unpin': { pinId: string };
  'task.visit': { taskId: string; outcomeKey: string; retry?: { date: BusinessDate; at?: IsoTime } };
  'notification.ack': { notificationId: string };
}
export type CommandType = keyof CommandPayloads;

/** 명령 이름 목록(실행 중에 쓰는 사본). 시험이 schema.sql의 sys_event_types와 맞춰 본다. */
export const COMMAND_TYPES = [
  'stock.issue', 'stock.direct_return', 'stock.load', 'stock.collect', 'stock.receive', 'stock.deliver',
  'payment.take', 'payment_promise.set', 'promise.change', 'order.create', 'deposit.take', 'deposit.return',
  'field.collect', 'field.add_ticket', 'field.deposit_return', 'cash.transfer', 'cash.transfer_confirm', 'closing.close', 'setting.set',
  'route.move', 'route.reset', 'task.pin', 'task.unpin', 'task.visit', 'notification.ack',
] as const satisfies readonly CommandType[];
// 목록이 모든 명령을 담았는지 형식으로 확인한다(명령을 더하고 목록을 잊으면 컴파일 오류).
const COMMAND_TYPES_COMPLETE: [Exclude<CommandType, (typeof COMMAND_TYPES)[number]>] extends [never] ? true : never = true;
void COMMAND_TYPES_COMPLETE;

/**
 * 돈을 옮기는 명령과 그 명령이 꼭 가져야 할 바탕(expect의 필드): 없으면 서버가 거절한다(sync 4-2, EXPECT_REQUIRED).
 * 창이 본 값과 지금 값이 다르면 충돌이다. 큐에서 온 기사 명령도 같은 바탕을 싣고, 서버는 참고 값으로 적는다(sync 8-12).
 */
export const MONEY_COMMAND_EXPECT: Readonly<Partial<Record<CommandType, readonly (keyof Expect)[]>>> = {
  'payment.take': ['dueAmount'],
  'order.create': ['quoteHash'],
  'deposit.take': ['depositHeld'],
  'deposit.return': ['depositHeld'],
  'field.collect': ['dueAmount'],
  'field.add_ticket': ['quoteHash'],
  'field.deposit_return': ['depositHeld'],
  'cash.transfer_confirm': ['expectedCash'],
  'closing.close': ['expectedCash'],
};

/** 돈을 옮기는 명령: expect(창이 본 받을 돈)가 없으면 서버가 거절한다(sync 4-2). */
export const MONEY_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>(Object.keys(MONEY_COMMAND_EXPECT) as CommandType[]);

/** 돈 명령의 봉투가 필요한 바탕을 모두 가졌는지(돈 명령이 아니면 참). */
export function hasRequiredExpect(type: CommandType, expect: Expect | undefined): boolean {
  const keys = MONEY_COMMAND_EXPECT[type];
  if (!keys) return true;
  return keys.every((key) => expect?.[key] !== undefined);
}

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

/** order.create의 결과에서 새 접수(적용되지 않았거나 모양이 틀리면 null). 같은 요청번호로 다시 보내도 같은 결과가 온다. */
export function createdOrder(outcome: CommandOutcome): { orderId: string; receiptNo: string } | null {
  const result = outcome.result;
  if (outcome.outcome !== 'applied' || !result) return null;
  const { orderId, receiptNo } = result;
  return typeof orderId === 'string' && typeof receiptNo === 'string' ? { orderId, receiptNo } : null;
}

/** 일괄 수납이 충돌했을 때 그사이 받을 금액이 바뀐 팀(`제외 후 수납`이 빼는 팀). 충돌이 아니거나 모양이 틀리면 빈 목록. */
export function changedOrders(outcome: CommandOutcome): string[] {
  if (outcome.outcome !== 'conflict') return [];
  const current = outcome.error?.current;
  const ids = current && typeof current === 'object' ? (current as { orderIds?: unknown }).orderIds : undefined;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
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
  /**
   * false면 이 기기에는 보냄 대기가 없다(서버에 붙은 기기: 명령은 바로 보내거나 거절된다). 화면은 바닥줄의 `전송 대기` 숫자를 그리지
   * 않는다. 없으면 보냄 대기가 있는 기기(체험판의 기사 기기).
   */
  sendQueue?: boolean;
  /** 마지막으로 서버와 맞춘 때(연결이 끊긴 때). */
  lastSyncAt?: IsoTime;
}

/**
 * 조회가 실패한 까닭. 화면은 코드로만 가르고 문장은 스스로 쓴다.
 * NOT_FOUND: 없는 접수 · 업무(다시 읽어도 같다), NETWORK: 연결이 끊겼거나 서버가 답하지 않음(다시 읽으면 될 수 있다),
 * UNKNOWN_VIEW: 이 서버에 없는 화면 · 조회(앱과 서버의 판이 다름).
 * FORBIDDEN: 이 세션 · 기기가 읽을 수 없는 것(기사 세션의 다른 차량 업무 · 장부). 다시 읽어도 같다(`이 기기에서 사용 불가`).
 */
export type DomainErrorCode = 'NOT_FOUND' | 'NETWORK' | 'UNKNOWN_VIEW' | 'FORBIDDEN';

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

/**
 * 창을 연 때의 초안(요청번호 · basis · dependsOn)에 서버가 지금 고른 것으로 써 준 명령(같은 종류)과 그때 본 바탕(expect)을 실은 봉투.
 * 명령이 없거나 종류가 다르면 null(보내지 않는다). expect를 주지 않으면 초안의 것(연 때 본 바탕)을 쓴다. 일괄 수납 · 접수 확정 · 일정 변경 ·
 * 기사 판 · 마감 · 매장 설정이 같은 길로 보낸다.
 */
export function envelopeFor(draft: AnyCommandDraft, command: ConfirmCommand | undefined, expect?: Expect): AnyCommandEnvelope | null {
  if (!command || command.type !== draft.type) return null;
  const envelope = draftToEnvelope(draft, {}, command);
  return expect ? { ...envelope, expect } : envelope;
}

/** 명령이 받아들여졌는지(적용 · 일부 적용 · 기사 기기의 보냄 대기): 창을 닫거나 이어진 명령을 계속 보내도 된다. */
export function isAccepted(outcome: Pick<CommandOutcome, 'outcome'>): boolean {
  return outcome.outcome === 'applied' || outcome.outcome === 'partially_applied' || outcome.outcome === 'queued';
}

/**
 * 이어서 보낼 명령들의 초안(sync 2절): 창이 열릴 때 명령마다 요청번호를 만들고, 앞 명령의 요청번호를 dependsOn으로 가진다.
 * basis는 첫 명령과 같다(창을 연 때). 본문 · expect는 서버가 준 그대로다. 요약 확인 창(ConfirmFlow)과 반납 확인 창이 같이 쓴다.
 */
export function chainDrafts(first: AnyCommandDraft, steps: readonly ConfirmStep[] | undefined, now: number = Date.now()): AnyCommandDraft[] {
  const out: AnyCommandDraft[] = [];
  let previous = first.requestId;
  for (const step of steps ?? []) {
    const draft = openCommandDraft(step.command, first.basis, { now, ...(step.expect ? { expect: step.expect } : {}), dependsOn: [previous] });
    out.push(draft);
    previous = draft.requestId;
  }
  return out;
}

/** 끊긴 채 보냄 대기에 넣는 기기 종류(sys_device_kinds의 매장 기기). 좁은 포스는 포스와 같다. */
export type OfflineDeviceKind = 'pos' | 'driver_tablet' | 'driver_phone';

/**
 * 기기 종류마다 연결이 끊겨도 보냄 대기에 넣을 수 있는 명령(sys_offline_commands 시드 그대로, sync 8-2 · ADR-19). 여기에 없는 명령은
 * 연결이 필요한 결정이다(일정 변경 · 운영 규칙 저장 · 마감 · 매장 입고 · 차량 현금 인계 …). 화면(끊겼을 때 창 대신 한 줄)과 체험 자료(보냄
 * 대기)가 이 한 곳을 쓴다. schema.sql 시드와 시험(vocab.test)으로 맞춘다.
 */
export const OFFLINE_COMMANDS: Readonly<Record<OfflineDeviceKind, readonly string[]>> = {
  pos: [
    'order.create', 'order.add', 'stock.issue', 'stock.direct_return', 'stock.load', 'ticket.hand_out', 'exchange.swap', 'payment.take', 'deposit.take',
    'deposit.return', 'print.request', 'notification.ack', 'device.sign_in',
  ],
  driver_tablet: [
    'stock.deliver', 'stock.collect', 'task.visit', 'field.collect', 'field.add_ticket', 'field.deposit_return', 'vendor_refund.attempt', 'route.move',
    'route.reset', 'notification.ack', 'device.sign_in',
  ],
  driver_phone: [
    'stock.deliver', 'stock.collect', 'task.visit', 'field.collect', 'field.add_ticket', 'field.deposit_return', 'vendor_refund.attempt', 'route.move',
    'route.reset', 'notification.ack', 'device.sign_in',
  ],
};

/** 기기 등급 → 끊긴 채 쓰는 기기 종류(좁은 포스는 포스). */
export function offlineDeviceKind(deviceClass: DeviceClassKey): OfflineDeviceKind {
  return deviceClass === 'driver_tablet' || deviceClass === 'driver_phone' ? deviceClass : 'pos';
}

/** 이 기기가 끊긴 채 이 명령을 보냄 대기에 넣을 수 있는지. 아니면 연결이 필요하다(창 대신 `… · 연결 후 가능` 한 줄). */
export function offlineAllowed(deviceClass: DeviceClassKey, type: CommandType): boolean {
  return OFFLINE_COMMANDS[offlineDeviceKind(deviceClass)].includes(type);
}

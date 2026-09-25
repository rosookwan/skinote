// 명령 실행의 목표 형식(work/impl-server/plan.md §3-3 · §3-4, 단계 B0): 이동 사실(LineMove), 바뀐 것(Change · ChangeSet), 실행 문맥
// (ExecContext)과 결과(ExecResult). 서버 저장소(packages/store)가 ChangeSet을 표의 행으로 옮긴다(§4-2).
// 지금은 형식만 있다: 명령 처리기는 아직 상태를 직접 고치고(commands.ts applyCommand), B2a(이동 사실) · B2c(execute · diffShop)가 이
// 형식으로 옮긴다. 저장소 쪽 단계가 먼저 형식을 가져다 쓸 수 있게 둔다.
import type { AnyCommandEnvelope, CommandOutcome, RuleChange } from '@skinote/contract';
import type { DomainLines, FxOrder, FxPin, FxPromise, FxPromiseSplit, ShopState } from './model.ts';

/** 줄 하나의 재고 이동 사실(stock_movements 한 건의 이 줄 몫). 줄의 수 셈(loaded · issued …)은 이 목록에서 나온다(B2a). */
export interface LineMove {
  /** `${requestId}:${n}`. */
  id: string;
  kind: 'load' | 'deliver' | 'direct_return' | 'collect' | 'receive';
  qty: number;
  /** 번호로 세는 줄의 번호(assets.id). 수량으로 세는 줄은 빈 목록. */
  assetIds: string[];
  /** 수량으로 세는 줄의 규격(고글 기본 규격). */
  variantKey?: string;
  /** 수량으로 세는 줄의 상태(늘 'ok'). */
  condition?: 'ok';
  at: number;
  /** 차량 업무(수거 · 입고 · 배달). */
  taskId?: string;
  /** 반납 일정 몫: 나눈 일정의 id, 원래 일정은 null. */
  bucket?: string | null;
  vehicleId?: string;
  /** 지급(deliver)의 출발지: 매장 또는 차량(현장 권 추가). */
  from?: 'shop' | 'vehicle';
}

/** 받기로 한 때(FxOrder.payWhen). */
export type FxPayWhen = FxOrder['payWhen'];

/** 상태의 한 가지 바뀜. 저장소는 종류마다 행을 쓴다(§4-2의 표). */
export type Change =
  | { t: 'order.insert'; orderId: string }
  | { t: 'order.promise'; orderId: string; kind: 'pickup' | 'return'; before: FxPromise; after: FxPromise }
  | { t: 'order.payWhen'; orderId: string; before?: FxPayWhen; after?: FxPayWhen }
  | { t: 'order.payer'; orderId: string; lineId?: string; before?: string; after?: string }
  | { t: 'line.insert'; orderId: string; lineId: string; batchSeq: number; source: 'driver_field' }
  | { t: 'line.move'; orderId: string; lineId: string; move: LineMove }
  | { t: 'split.set'; orderId: string; lineId: string; before: FxPromiseSplit[]; after: FxPromiseSplit[] }
  | { t: 'line.planned'; orderId: string; lineId: string; before: string[]; after: string[] }
  | { t: 'payment.insert'; groupId: string }
  | { t: 'deposit.apply'; orderId: string; paymentId: string }
  | { t: 'deposit.entry'; depositId: string; entryId: string; created: boolean }
  | { t: 'charge.insert'; orderId: string; chargeId: string }
  | { t: 'visit.insert'; orderId: string; index: number }
  | { t: 'pin.insert'; pinId: string }
  | { t: 'pin.status'; pinId: string; before: FxPin['status']; after: FxPin['status'] }
  | { t: 'route.rank'; taskId: string; rank: string | null }
  | { t: 'cash.transfer'; transferId: string }
  | { t: 'cash.confirm'; transferId: string }
  | { t: 'closing.insert'; date: string }
  | { t: 'settings.set'; changes: RuleChange[] }
  | { t: 'receipt.next'; date: string; value: number };

/** 명령 하나가 바꾼 것 모두와 건드린 접수 · 업무 · 차량(투영 · 알림 범위). */
export interface ChangeSet {
  changes: Change[];
  touchedOrders: string[];
  touchedTasks: string[];
  touchedVehicles: string[];
}

/** 명령을 실행하는 문맥: 서버 시각, 누가(세션에서), 먼저 온 명령의 결과(dependsOn), 거절 문구. */
export interface ExecContext {
  now: number;
  actor: { key: string; name: string; deviceId?: string; vehicleId?: string; roleKey?: string };
  outcomeOf(requestId: string): Pick<CommandOutcome, 'outcome'> | undefined;
  /** 없으면 PRODUCTION_LINES. */
  lines?: DomainLines;
  /** 새 접수 id의 모양(commands.ts ApplyOptions): 서버는 'dated'(날짜가 여럿인 장부), 없으면 'sequence'. */
  orderIds?: 'sequence' | 'dated';
}

/** execute의 결과: 화면에 돌려줄 결과, 바뀐 것, 새 상태(입력 상태는 고치지 않는다). */
export interface ExecResult {
  outcome: CommandOutcome;
  changes: ChangeSet;
  state: ShopState;
}

/** execute의 모양(B2c에서 만든다). 같은 요청번호의 멱등은 어댑터 몫이다. */
export type Execute = (state: ShopState, envelope: AnyCommandEnvelope, ctx: ExecContext) => ExecResult;

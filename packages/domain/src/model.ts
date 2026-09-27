// 가게 하나의 상태(ShopState): 도메인 규칙 · 명령 처리기 · 읽기 모델이 읽고 쓰는 모양. 운영 서버의 표(orders · order_lines ·
// promises · payments …)를 줄인 것이고, 메모리 어댑터(FixtureClient)와 서버 저장소(SQLite, packages/store)가 같은 모양을 채운다(work/impl-server/plan.md
// §3-2). 화면은 이 모양을 보지 않는다: 도메인이 여기서 읽기 모델(@skinote/contract)을 만들어 준다.
// 판 3: 운영 규칙(settings), 번호로 세는 실물(assets · 줄의 assetIds), 보증금 보관 · 장부(deposits), 결제 자리(paymentGroups),
// 돈통 · 차량 현금 인계 · 마감(drawers · cashTransfers · closings), 일정 변경(splits). 매장 목록 값(품목 · 결제 수단 · 구역 · 차량 …)은
// registry에 있다(예전의 모듈 상수).
// 옮기는 중(plan §3-3 B2a ~ B2d): 받은 명령의 결과(outcomes) · 기사 기기의 보냄 대기(driverDevice) · 이야기 사건(storyApplied)은 아직 이
// 모양에 있고 B2c에서 어댑터 몫(DemoState)으로 나간다. 이동 사실(moves) · 판 4 · configRev · openDays도 B2에서 더한다.
import type { AnyCommandEnvelope, CarryItem, CashCheckRow, ClosingMethodRow, CommandOutcome, ConditionKey, FitPart } from '@skinote/contract';
import type { FxDiscount, FxKind, FxPayMethod, FxPaySection, FxProduct } from './catalog.ts';

/** 받기 · 돌려주기 방법: 매장에서 직접, 또는 차량(배달 · 수거). */
export type FxMode = 'store' | 'vehicle';

/** 약속 하나(받기 또는 돌려주기). 장소는 구역 → 장소(솔마을 → 한솔동). */
export interface FxPromise {
  at: number;
  mode: FxMode;
  placeId?: string;
  vehicleId?: string;
  /** 약속에 붙은 말('조기 반납'). */
  note?: string;
}

/** 결제 칸. 리프트권은 선입금으로 먼저 받는 일이 많다(docs/52 2-6). */
export type FxSection = 'gear' | 'lift';

/**
 * 돈 수단(payment_methods). 빠른 수단(quick) 카드 · 현금 · 계좌이체는 확정 창의 버튼, 간편결제 · 상품권은 `기타` 판(catalog 15,
 * 매장 목록 registry.payMethods).
 */
export type FxMethodKey = 'card' | 'cash' | 'transfer' | 'easy_pay' | 'voucher';

/**
 * 접수의 수납 행의 수단: 돈 수단 셋 + 보증금 결제(`미수 차감`으로 맡은 보증금을 미수에 씀, data-model 4-12 deposit_apply, 문구 표
 * `보증금 결제`). 보증금 결제는 돈이 움직이지 않아 결제 자리(FxPaymentGroup)가 없고 마감의 결제 수단 표에 넣지 않는다(plan §8 D10).
 */
export type FxPayMethodKey = FxMethodKey | 'deposit';

/**
 * 재고 방식(catalog 2 tracking, 매장이 품목마다 고름): unit = 번호로 하나씩(번호 스티커 · 권 번호가 있는 매장), count = 수량(번호 없음:
 * 첫 매장은 장비 · 리프트권 모두 수량, 2026-09-26 사장님 답), none = 세지 않음.
 */
export type FxTracking = 'unit' | 'count' | 'none';

export interface FxLine {
  id: string;
  kind: string;
  /** 접수증의 이름('야간권 성인'). */
  label: string;
  /** 장부 품목 칸의 짧은 이름('야간권'). */
  shortLabel: string;
  qty: number;
  /** 수량 단위('매'). 없으면 '개'. 권(매)만 가진다: '6개 · 3매'처럼 개로 세는 장비와 따로 센다. */
  unit?: string;
  /** 이 품목을 세는 말(스키 · 보드 '대', 의류 '벌', 헬멧 '개', 권 '매'). 일정 변경 창의 '대여 2대' · '0대'. 없으면 unit ?? '개'. */
  countWord?: string;
  amount: number;
  /**
   * 할인 앞 값(order_lines.gross_amount): 접수 때 할인을 받은 줄만 가진다(amount = 뺀 뒤 값, 몫 = gross − amount). 없으면 amount가 할인 앞 값이다.
   * 접수증 품목 표의 금액 칸은 이 값이고, 할인은 품목 표 아래 출처 줄이다(features-1 §6-2).
   */
  gross?: number;
  /**
   * 1일 값(장비 줄, order_lines.unit_price · price_basis_key per_day): 줄을 만들 때의 요금표 값. 일정 변경의 연장 · 품목 취소의 연장 몫이 이 값으로
   * 센다(요금을 바꿔도 이미 받은 접수는 그대로, extension.ts). 없으면(옛 줄 · 견본 · 리프트권) 지금 요금표 값.
   */
  dayPrice?: number;
  section: FxSection;
  /** 돌려받는 품목인지(리프트권은 반납 없음). */
  returnable: boolean;
  capabilities: ConditionKey[];
  loaded: number;
  loadedAt?: number;
  issued: number;
  issuedAt?: number;
  /** 매장에서 직접 돌려받은 수. */
  returned: number;
  returnedAt?: number;
  /** 차량이 받은 수. */
  collected: number;
  collectedAt?: number;
  /** 차량이 받은 것 중 매장에 내려놓은 수(매장 입고). 차에 있는 것 = collected − received. */
  received: number;
  receivedAt?: number;
  /** 재고 방식. 없으면 unit(옛 줄). */
  tracking?: FxTracking;
  /** 이 줄에 지급한 번호(asset id, 지급한 차례). 수 셈(issued …)이 기준이고 번호는 그 사본이다. */
  assetIds?: string[];
  /** 준비해 둔 번호(지급할 때 이 번호부터). 없으면 매장 재고의 빈 번호. */
  plannedAssetIds?: string[];
  /** 돌아온 번호(매장 반납 · 차량 수거). */
  backAssetIds?: string[];
  /** 이 줄 값을 낼 다른 팀(줄 단위 결제 약속). 없으면 접수의 payerOrderId. */
  payerOrderId?: string;
  /** 새 접수에서 고른 상품 · 규격(옛 줄에는 없음). */
  productKey?: string;
  variantKey?: string;
  /**
   * 취소한 수(order_cancellation_lines의 합, features-1 E6): 줄은 얼린 채(qty 그대로) 살아 있는 수 = qty − cancelled(liveQty). 지급 · 적재 · 배달 ·
   * 업무 · 도장 · 품목 요약은 살아 있는 수로 세고, 반납 · 수거는 내준 것(issued − 돌아온 것)으로 센다(취소 뒤에 온 기사 기록도 적는다, E23).
   */
  cancelled?: number;
  /** 취소한 배달의 차에 실렸던 것 중 매장에 내려놓은 수(stock.receive of the deliver task, E7). 차에 남은 것 = leftover(l). */
  unloaded?: number;
  /** 품목 추가(order.add, features-1 §5-5)로 더한 줄의 차수: 카운터에서 더한 때. 없으면 첫 접수 또는 기사 현장 추가. */
  batch?: { source: 'counter'; at: number };
  /**
   * 즉시 교환(exchange.swap, features-1 §7): 사이즈를 바꾼 차례. 줄은 얼린 채(variantKey = 접수 때 규격) 자리마다 지금 규격을 이 기록으로 센다
   * (variants.ts slotVariants). 쌓기만 한다.
   */
  swaps?: FxSwap[];
  /**
   * 분실 처리한 수(stock.write_off − 되돌린 것, features-1 E20): 손님에게서 돌아오지 않아 청구 없이 닫은 권(폐기·분실). 손님에게 있는 수 =
   * 지급 − 반납 − 수거 − 분실(backCount가 센다). 분실 회수(asset.found)한 것도 여기에 남고 found로 따로 센다(지금 분실 = lost − found).
   */
  lost?: number;
  lostAt?: number;
  /** 분실 처리한 것 중 찾은 수(asset.found: 폐기·분실 → 매장). */
  found?: number;
  foundAt?: number;
}

/**
 * 즉시 교환 한 건(exchanges + exchange_units, features-1 §7-1): 줄의 수량 일부의 규격을 다른 규격으로. held(planned false)는 손님이 가진 것
 * (옛 규격이 매장으로 돌아오고 새 규격이 나감), planned는 아직 지급하지 않은 것(이동 없음, 뒤의 지급이 새 규격). 돈은 바뀌지 않는다(금액 유지).
 * base: 이 교환이 닿는 첫 자리(held = 그때 돌아온 수, planned = 그때 지급한 수 + 차에 실린 수). 저장소는 이동 기록에서 다시 센다.
 */
export interface FxSwap {
  /** = exchange.swap 명령의 요청번호(exchanges.id). */
  id: string;
  at: number;
  quantity: number;
  /** 옛 규격 · 새 규격(FxVariant.key). */
  from: string;
  to: string;
  planned: boolean;
  base: number;
  /** 교환한 사람(명령을 한 직원 이름, 저장소 events.actor_name). 명령을 한 사람을 모르면(메모리 어댑터) 없음. */
  byName?: string;
}

export interface FxPayment {
  id: string;
  amount: number;
  methodKey: FxPayMethodKey;
  at: number;
  /** 이 돈이 채운 결제 칸(선입금은 리프트권). 없으면 장비 → 리프트권 순으로 채운다. */
  section?: FxSection;
  /** 한 번에 여러 팀을 받은 묶음(요청번호 = FxPaymentGroup.id). 이 행은 그 돈의 이 팀 몫(배분)이다. */
  groupId?: string;
  /** 현금이 들어간 돈통(카운터 'counter', 차량 지갑 'van:v1'). 현금이 아니면 없음. */
  drawerId?: string;
  /** 품목으로 나눠 낸 몫(줄 · 수량 · 금액). 없으면 접수 전체. */
  lines?: { lineId: string; quantity: number; amount: number }[];
}

/** 결제 자리: 실제 돈 한 건(카드 한 번, 현금 한 번). 팀마다의 몫은 각 접수의 FxPayment(groupId). */
export interface FxPaymentGroup {
  id: string;
  purpose: 'intake_confirm' | 'multi_order' | 'split_by_items' | 'driver_field' | 'counter';
  amount: number;
  methodKey: FxMethodKey;
  at: number;
  drawerId?: string;
  /** 여러 팀 몫을 한 팀이 낸 돈(일괄 수납 · 대납 수납)의 그 팀. 접수증 돈 줄의 `대납 395,000원 · 카드 485,000원`이 이것으로 센다. */
  payerOrderId?: string;
}

/** 보증금 장부 한 줄(data-model 4-12 deposit_entries): 입금 · 반환 · 미수 차감 · 몰수 · 몰수 취소. */
export interface FxDepositEntry {
  id: string;
  kind: 'take' | 'refund' | 'apply' | 'keep' | 'restore';
  lineId: string;
  quantity: number;
  assetIds?: string[];
  amount: number;
  /** 돈이 움직인 수단 · 돈통(미수 차감 · 몰수는 현금이 움직이지 않음). */
  methodKey?: FxMethodKey;
  drawerId?: string;
  at: number;
}

/** 보증금 보관(팀 · 규칙마다 하나, 규칙 값 복사). 보관 금액 = 입금 + 몰수 취소 − 반환 − 미수 차감 − 몰수. 돈은 접수의 payments에 넣지 않는다. */
export interface FxDeposit {
  id: string;
  orderId: string;
  ruleKey: string;
  label: string;
  unitAmount: number;
  entries: FxDepositEntry[];
}

/** 보증금 규칙(deposit_rules, catalog 11-1). */
export interface FxDepositRule {
  key: string;
  label: string;
  /** 대상 품목 종류(지금은 결제 칸으로 가른다: 리프트권 줄). */
  section: FxSection;
  unitAmount: number;
  timing: 'at_intake' | 'at_issue';
  refundDefault: 'cash' | 'offset_due' | 'same_method';
  unreturned: 'keep' | 'charge_loss';
  lossAmount?: number;
  /** 반납 약속일 뒤 며칠째 마감이 정리하나(null = 사람이 정함). */
  afterDays: number | null;
  /** 받는 수단(결제 칸 lift_deposit의 수단). 이 매장은 현금만. */
  methods: FxMethodKey[];
}

/** 반납 타임(매장 설정 '반납 타임'). 심야 24:00은 hour 24(영업일 기준 시각 전이라 그날 장부). */
export interface FxReturnSlot {
  key: string;
  /** '오전타임 후' · '오후' · '야간' · '심야'. 화면 글은 이름 + 시각('야간 22:00'). */
  label: string;
  hour: number;
  minute: number;
  /**
   * 야간 반납 타임(return_slots.is_night): 더할 때 시각(20:00 이후)으로 정하고 시각을 바꿔도 그대로다(plan E12). 없으면 hour ≥ 20(옛 자료).
   * 야간 차량 약속의 늦음 기준(vehicleLate.nightMinutes)과 야간 수거 준비가 이것을 본다.
   */
  night?: boolean;
  /** 숨긴 반납 타임(return_slots.active 0): 고르기에서 빠지고, 지난 접수 · 늦음 · 장부는 그대로 읽는다. */
  hidden?: true;
  /**
   * 이 반납 타임이 가졌던 가장 이른 시각(시각을 늦춘 뒤에만, config_changes에서 읽음): 야간이 시작하는 시각은 이것까지 본다 — 22:00을 22:30으로
   * 바꿔도 이미 22:00에 잡은 접수의 늦음(빨강)이 움직이지 않게(plan E12).
   */
  earliest?: { hour: number; minute: number };
}

/** 운영 규칙(관리 → 매장 설정 → 운영 규칙, V8). 바꾸면 다음 기록부터: 이미 만든 줄 · 보관은 만들 때 복사한 값을 쓴다. */
export interface FxShopRules {
  /** 리프트권 반납(item_kinds.return_policy_key). */
  liftReturnPolicy: 'required' | 'optional';
  /** 리프트권 보증금 규칙. null = 보증금 미사용. */
  liftDeposit: FxDepositRule | null;
  /**
   * 보증금 미사용으로 바꾼 동안 둔 규칙 값(V8 `사용`으로 되돌리면 이 값으로 다시 시작한다). 이미 맡은 보증금은 맡을 때 복사한 값으로
   * 반환한다(FxDeposit). 없으면 시작 값.
   */
  liftDepositOff?: FxDepositRule;
  /** 리프트권 결제 · 전화 예약(prepayment_mode). */
  prepaymentMode: 'full_lift_ticket' | 'fixed_amount' | 'none';
  /** 예약금(prepayment_mode = fixed_amount의 팀당 금액). */
  prepaymentAmount?: number;
  /** 당일 취소 환불(same_day_cancel_refund_default). 접수 취소가 아직 없어 값만 둔다. */
  sameDayCancelRefund: 'refund' | 'no_refund';
  /** 영업일 기준 시각(shops.business_day_cutoff, 'HH:MM'). 바꾸면 다음 기록부터(V8, data-model 3-3). */
  businessDayCutoff: string;
  /** 바꾸기 전의 기준 시각(그 시각 until 전의 기록은 그 기준으로 센다: 지난 기록의 영업일이 움직이지 않게, time.ts shopCutoff). */
  cutoffBefore?: { until: number; cutoff: string }[];
  /** 시재(돈통 시작 돈). */
  openingCash: number;
  /** 기사 화면 미수 표시(driver_sees_due_amount). */
  driverSeesDue: boolean;
  returnSlots: FxReturnSlot[];
  /** 기본 반납 타임(권이 없는 새 접수의 반납 시각 처음 값, spec 3-5). 없으면 첫 반납 타임. */
  defaultReturnSlotKey?: string;
  /**
   * 차량 약속이 늦음(빨강)이 되기까지의 여유 분(vehicle_late_after_minutes, 마이그레이션 0003): minutes = 그 밖의 차량 약속, nightMinutes =
   * 야간 반납 타임(20시 이후 반납 타임 중 가장 이른 것) 이후의 차량 약속. 없으면 60 · 60(rules.ts lateAfter). 첫 매장은 스키장이 22:00에 끝나
   * 손님 연락이 22:30 ~ 23:00에 오므로 야간 90분(2026-09-26 답 15).
   */
  vehicleLate?: { minutes: number; nightMinutes: number };
  /** 야간 수거 준비 안내를 그 반납 타임 몇 분 전부터(night_collection_notice_minutes). 없으면 60. */
  nightNoticeMinutes?: number;
}

/**
 * 수량으로 세는 차량 예비 재고(번호 없는 차량 예비권, 첫 매장): 차량 · 상품마다 지금 차에 실린 수. 리프트권 추가(field.add_ticket)가
 * 줄이고, 다 쓰여도 행은 0으로 남는다(차례 = 매장 목록의 차량 차례 → 상품 차례). 번호로 세는 권의 예비권은 assets(vehicleId)다.
 */
export interface FxVanSpare {
  vehicleId: string;
  productKey: string;
  quantity: number;
}

/** 번호로 세는 실물 하나(스키 17번, 야간권 31번). 손님 · 차량 어디에 있는지는 줄의 번호로 알고, 차량 예비권만 vehicleId를 가진다. */
export interface FxAsset {
  id: string;
  kind: string;
  /** 스티커 · 권 번호('17'). 화면 글은 '17번'. */
  no: string;
  /** 차량 예비권(차량 재고). 없으면 매장. */
  vehicleId?: string;
}

/** 돈통 · 차량 지갑 · 넘기는 중 · 과부족(data-model 4-12 cash_drawers). */
export interface FxDrawer {
  id: string;
  kind: 'counter' | 'vehicle' | 'transit' | 'over_short';
  label: string;
  vehicleId?: string;
}

/** 차량 현금 인계와 카운터의 확인(cash_transfers · cash_transfer_confirmations). */
export interface FxCashTransfer {
  id: string;
  vehicleId: string;
  amount: number;
  at: number;
  confirmed?: { at: number; countedAmount: number; reasonKey?: string; reasonNote?: string };
}

/**
 * 마감 한 판(영업일마다, data-model 4-13 closings · closing_drawer_counts · closing_totals · closing_handover_items). counts는 돈통마다의
 * 예상 · 실제(차액 = 실제 − 예상), deferredTransferIds는 점검 이월한 차량 봉투, sheet는 마감 때 얼린 화면 줄(결제 수단 · 현금 점검 ·
 * 이월 항목 · 바닥줄): 마감 뒤에 들어온 기록은 이 판에 들지 않는다(다음 열린 날의 몫, data-model 3-3).
 */
export interface FxClosing {
  date: string;
  closedAt: number;
  counts: { drawerId: string; expected: number; counted: number; reasonKey?: string; reasonNote?: string }[];
  deferredTransferIds: string[];
  sheet?: FxClosingSheet;
}

/** 마감 때 얼린 화면 줄(읽기 모델 조각 그대로). */
export interface FxClosingSheet {
  methods: ClosingMethodRow[];
  cash: CashCheckRow[];
  carry: CarryItem[];
  footer: FitPart[];
}

/** 차량 매장 입고 한 번(stock.receive): 그 뒤에도 차에 남은 것은 `미입고`(확인 필요, 마감 이월 항목). */
export interface FxVanReceipt {
  vehicleId: string;
  at: number;
}

/**
 * 품목 줄 수량 일부의 다른 반납 일정(일정 변경 N2, V9). 나머지 수량은 접수의 giveBack(원래 일정)을 따른다.
 * id는 일정 하나의 id다: 같은 일정으로 옮긴 줄들(보드 1 · 헬멧 1 · 권 1매 → 22:00 솔마을 두솔동)은 같은 id를 줄마다 한 행씩 갖고,
 * 차량 업무 하나(collect:<접수>:<id>)가 된다. 수거 · 입고한 수는 그 일정의 몫으로 따로 센다(원래 일정 몫 = 줄의 수 − 나눈 일정의 수).
 */
export interface FxPromiseSplit {
  id: string;
  lineId: string;
  quantity: number;
  promise: FxPromise;
  at: number;
  /** 이 일정 몫으로 매장에 돌아온 수(매장 반납 때 적는다: 매장 일정으로 나눈 몫은 그 일정부터 채움, promises.ts attributeReturn). */
  returned?: number;
  /** 이 일정의 차량 업무가 수거한 수. */
  collected?: number;
  /** 그중 매장 입고한 수. */
  received?: number;
}

/**
 * 품목 줄 값 뒤의 청구 조정(charge_adjustments, catalog 14): 날을 옮긴 일정 변경의 연장 값. 늘어난 몫(extension, 금액 > 0)은 수량 ·
 * 늘어난 날을 갖고(order_extension_lines), 날을 되돌려 줄어든 몫(extension_undo `연장 취소`, 금액 < 0)은 금액만 갖는다(0001의 연장 표는
 * 음수를 받지 않는다, plan §3-3 7). 이미 받은 연장 날은 금액에서 센다(promise-sheet.ts extensionOf).
 * 할인 변경(discount_change, features-1 E9): 접수 뒤의 할인 적용 · 변경 · 해제가 청구를 바꾼 몫(더 큰 할인 = 음수). 줄마다 나눈 몫(lines, 합 =
 * amount)을 가져 줄마다의 청구(lineCharged)가 맞는다(표에는 줄마다 한 행, discount_application_id로 묶임).
 */
export type FxCharge =
  | {
    id: string;
    kind: 'discount_change';
    /** 이 바뀜을 적은 할인 적용(FxDiscountApplication.id = 그 명령의 요청번호). */
    applicationId: string;
    section: FxSection;
    amount: number;
    lines: { lineId: string; amount: number }[];
    at: number;
  }
  | {
    id: string;
    kind: 'extension';
    lineId: string;
    quantity: number;
    /** 늘어난 날 수. */
    days: number;
    amount: number;
    at: number;
  }
  | { id: string; kind: 'extension_undo'; lineId: string; amount: number; at: number }
  /** 취소한 수의 값(order_cancellation_lines · charge_adjustments cancellation, 음수, features-1 E5). */
  | { id: string; kind: 'cancellation'; cancellationId: string; lineId: string; amount: number; at: number }
  /** 환불 없음을 고른 취소의 줄 몫(charge_adjustments cancellation_fee, 양수 = 그 줄에서 비운 돈): 받은 돈이 그 줄에 남는다. 화면에는 `환불 없음`. */
  | { id: string; kind: 'cancellation_fee'; cancellationId: string; lineId: string; amount: number; at: number };

export interface FxOrder {
  id: string;
  receiptNo: string;
  /** 대표자 이름(현장 대여는 대표자만 적는다). */
  teamName: string;
  last4: string;
  /** 전화번호(견본 자료는 모두 010-0000-xxxx). */
  phone: string;
  channel: 'walk_in' | 'phone';
  party: number;
  /** 접수(전화 예약이면 예약한 때). */
  createdAt: number;
  pickup: FxPromise;
  giveBack: FxPromise;
  lines: FxLine[];
  payments: FxPayment[];
  /** 이 팀의 미수를 대신 낼 팀(결제할 팀, N19). */
  payerOrderId?: string;
  /** 돈을 받기로 한 때: 받을 때(수령) 또는 돌려줄 때(반납). */
  payWhen: 'pickup' | 'return';
  /** 기사 방문 결과(못 받음). 쌓기만 한다(task_visits). */
  visits?: FxVisit[];
  /** 줄 수량 일부의 다른 반납 일정(일정 변경). */
  splits?: FxPromiseSplit[];
  /** 청구 조정(연장). 청구 = 줄 값 + 조정. */
  charges?: FxCharge[];
  /**
   * 할인 적용(discount_applications, catalog 9): 칸마다 쌓인다. 접수 때의 할인은 줄 값(amount)에서 이미 뺐고(줄의 gross − amount), 뒤의 할인 적용 ·
   * 변경 · 해제는 앞 것을 대신하는 새 행(supersedes)과 청구 조정(discount_change)이다. 칸마다 마지막 행이 그 칸의 지금 할인이다(features-1 E9).
   */
  discounts?: FxDiscountApplication[];
  /** 돌려준 돈(features-1 E4): 받은 돈(payments)과 따로 둔다. 받은 돈 합 = 수납 − 환불(paidTotal). */
  refunds?: FxRefund[];
  /** 접수 취소 · 품목 취소(order_cancellations, features-1 §5): 쌓기만 한다. */
  cancellations?: FxCancellation[];
}

/**
 * 취소 한 건(order.cancel, data-model S8 · features-1 E5): id = 그 명령의 요청번호(환불의 까닭 id). 범위(접수 전체 · 품목), 구분(취소 요청 · 연락 없음),
 * 돈의 결정(환불 · 미수 결제 · 환불 없음 · 해당 없음), 줄마다 취소한 수와 그 값(청구에서 뺀 돈, cancellation 조정), 미수 결제면 수납에서 풀어
 * 접수 전체로 옮긴 돈(released: payment_reallocations).
 */
export interface FxCancellation {
  id: string;
  at: number;
  scope: 'order' | 'lines';
  reasonKey: 'request' | 'no_show';
  decision: 'refund' | 'apply_to_due' | 'no_refund' | 'not_applicable';
  lines: { lineId: string; quantity: number; amount: number }[];
  /** 미수 결제로 접수 전체로 옮긴 묶인 돈(payment_reallocations): 수납 · 그 수납이 묶였던 줄(없으면 그 수납의 칸) · 금액. */
  released?: { paymentId: string; lineId?: string; amount: number }[];
}

/** 할인 종류(sys_discount_kinds): 매장 할인(비율 · 금액), 직접 입력(금액 · 비율), 해제(none: 앞 할인을 없앰, 금액 0). */
export type FxDiscountKind = 'percent' | 'amount' | 'manual_amount' | 'manual_percent' | 'none';

/** 할인 적용 한 건(묶음 = 결제 칸마다 하나, 겹치지 않음: 새 행이 앞 행을 대신한다). */
export interface FxDiscountApplication {
  /** 접수 때는 '<접수>:da<n>', 뒤의 할인 적용은 그 명령의 요청번호(환불의 까닭 id, features-1 E3). */
  id: string;
  sectionKey: FxSection;
  /** 매장 할인의 key(discount_rules). 직접 입력 · 해제는 없음. */
  discountKey?: string;
  kind: FxDiscountKind;
  /** 할인 이름(사본, `10% 할인` · `할인 직접 입력` · `할인 해제`). */
  label: string;
  /** 값의 사본: 비율(%) 또는 금액(원). 해제는 없음. */
  value?: number;
  /** 이 칸에서 뺀 금액(10원 단위로 내림, 해제는 0). */
  amount: number;
  /** 직접 입력의 사유(개인 정보가 아닌 짧은 글, 20자). */
  reason?: string;
  /** 대신한 앞 적용. */
  supersedes?: string;
  at: number;
}

/**
 * 환불 한 건(payments kind refund, features-1 E4): 돌려준 수납(refundOf = 접수의 FxPayment id)과 수단(그 수납의 수단 또는 현금), 금액(> 0).
 * 그 수납이 채운 자리(줄 · 결제 칸 · 접수 전체)에서 뺀다(lines · section). 까닭(cause): 할인 변경 · 접수 취소는 그 명령의 id, 초과 수납은 없음.
 */
export interface FxRefund {
  id: string;
  refundOf: string;
  methodKey: FxMethodKey;
  amount: number;
  at: number;
  /** 현금이면 돈통(카운터 'counter'). */
  drawerId?: string;
  section?: FxSection;
  lines?: { lineId: string; quantity: number; amount: number }[];
  cause: { kind: 'discount' | 'cancellation' | 'overpaid'; id?: string };
  /** 까닭의 말(payments.reason: `할인 변경`). */
  reason: string;
}

/** 방문 결과 하나: 고객 부재 · 장소 변경 · 물품 미준비(수거) · 기타(배달) → 다시 갈 때. */
export interface FxVisit {
  at: number;
  /** 배달 업무의 방문(배달 실패). 없으면 수거 업무(수거 실패). 재방문은 그 업무의 일정(배달이면 수령 일정)을 옮긴다. */
  kind?: 'deliver';
  outcomeKey: FxVisitOutcome;
  /** 다시 갈 약속(없으면 매장이 정한다). */
  retryAt?: number;
  /** 옮기기 전의 약속 시각. */
  beforeAt: number;
}

export type FxVisitOutcome = 'customer_absent' | 'place_changed' | 'items_not_ready' | 'other';

/** 빨리 확인(매장이 기사에게 맨 위로 고정해 알림). */
export interface FxPin {
  id: string;
  orderId: string;
  /** 고정한 차량 업무(일정이 나뉜 접수). 없으면 그 접수의 원래 일정 업무. */
  taskId?: string;
  at: number;
  /** 매장이 적은 메모('조기 반납'). 없으면 긴급 줄에 메모 칸이 없다. */
  note?: string;
  status: 'requested' | 'delivered' | 'acknowledged';
}

export interface FxArea {
  id: string;
  label: string;
  /** 숙소 구역이면 장소 이름 앞에 구역 이름을 붙여 쓴다('솔마을 한솔동'). */
  lodging: boolean;
  places: FxPlace[];
  /** 숨긴 구역(areas.active 0): 고르기에서 빠진다(그 구역의 장소도). 지난 접수의 이름은 그대로 읽는다(plan E12). */
  hidden?: true;
}

/** 장소(places). 숨긴 장소는 고르기에서 빠지고 이미 고른 접수에서는 그대로 보인다. */
export interface FxPlace {
  id: string;
  label: string;
  hidden?: true;
}

/** 차량. 사용 종료한 차량(vehicles.active 0, 몰리는 날 더한 임시 차량)은 목록에 남아 마감 · 지난 업무가 이름을 읽는다(plan E13). */
export interface FxVehicle {
  id: string;
  label: string;
  ended?: true;
}

/** 직원 역할(roles.key). */
export type FxRoleKey = 'manager' | 'counter' | 'driver';

/**
 * 직원(staff_members): 이름 · 역할 · 지금 배정된 차량(vehicle_assignments의 열린 행), 사용 종료(suspended, `다시 사용`으로 되돌림). 이름은
 * 개인 정보라 명령 기록에서는 event_pii로 간다(journal PII_KEYS).
 */
export interface FxStaff {
  id: string;
  name: string;
  roleKey: FxRoleKey;
  vehicleId?: string;
  status: 'active' | 'suspended';
}

/** 기사 기기의 보냄 대기 한 건(오프라인에서 확인한 명령). 다시 연결되면 순서대로 보낸다(sync 8-3). */
export interface FxQueued {
  envelope: AnyCommandEnvelope;
  /** 기기에서 확인한 때(도장에 찍히는 시각). */
  at: number;
  summary: string;
}

/** 기사 기기의 연결 상태와 보냄 대기(B2c에서 어댑터 몫으로 옮긴다). 카운터는 매장 네트워크라 늘 연결되어 있다. */
export interface FxDevice {
  offline: boolean;
  /** 연결이 끊긴 때(마지막 맞춤). */
  since?: number;
  queue: FxQueued[];
  /** 이 기사 기기의 차량(마감의 막는 단계 `1호 차량 기록 2건 전송 대기`). 없으면 1호 차량(메모리 어댑터의 기사 기기). */
  vehicleId?: string;
}

/**
 * 저장된 확인 필요 한 건(review_items, features-1 E18): 지난 일을 적은 것(보냄 대기로 온 기사 기록이 카운터에 밀린 것 · 취소 뒤에 온 기사 기록 ·
 * 견본 자료)이라 사람이 `확인`으로 끝낸다. 문장(message)은 종류의 틀(REVIEW_TEMPLATES · REVIEW_COUNT_TEMPLATES)과 인자(params)로 만들 때 한 번
 * 그린다. 초과 수납 · 미입고 · 차량 예비권 기록 부족처럼 지금 상태를 말하는 것은 저장하지 않는다(읽을 때 센다, reviews.ts).
 */
export interface FxReview {
  /** `${요청번호}:r1`(명령이 만든 것) · 견본 `review-o24`(가져오기는 앞글자가 붙는다). */
  id: string;
  kindKey: string;
  params: Record<string, string | number>;
  message: string;
  orderId?: string;
  /** 그 기록의 차량 업무(수거 'collect:o21' …). */
  taskId?: string;
  /** 그 기록을 보낸 기기(서버: 세션의 기기, 메모리 어댑터는 없음). */
  targetDeviceId?: string;
  /** sync = 보냄 대기로 온 명령, import = 견본 자료. */
  source: 'sync' | 'import';
  createdAt: number;
  status: 'open' | 'resolved';
  /** 끝낸 것: 방법(`acknowledged` = 확인) · 때 · 누가(명령을 한 사람, 모르면 없음). */
  resolution?: { key: string; at: number; byName?: string };
}

/** 매장 목록 값(예전의 모듈 상수, plan §3-2): 품목 · 종류 타일 · 결제 수단 · 결제 칸 · 할인 · 구역 · 차량 · 사유. 서버는 표에서 읽는다(§4-2). */
export interface ShopRegistry {
  shopName: string;
  /** 매장 전화(shops.phone, 인쇄 머리 · 매장 정보). 없으면 비어 있다. */
  shopPhone?: string;
  timezone: 'Asia/Seoul';
  /** 상품(차례는 종류 타일의 차례). */
  products: Readonly<Record<string, FxProduct>>;
  /** 종류 타일(tile order). */
  kinds: readonly FxKind[];
  payMethods: readonly FxPayMethod[];
  paySections: readonly FxPaySection[];
  discounts: readonly FxDiscount[];
  areas: readonly FxArea[];
  vehicles: readonly FxVehicle[];
  /** 방문 결과 이름(reason_codes visit_result). */
  visitOutcomes: readonly { key: FxVisitOutcome; label: string }[];
  /** 현금 차액 사유(reason_codes closing_difference · handover). 'manual'은 직접 입력(글을 함께 적는다). */
  cashReasons: readonly { key: string; label: string }[];
  /** 한 초안 품목의 수 한도(shop_settings max_line_quantity). */
  maxLineQuantity: number;
}

/**
 * 도메인이 화면에 돌려주는 거절 · 충돌 한 줄(D16). 기본은 운영 문구(lines.ts PRODUCTION_LINES)이고, 메모리 어댑터(FixtureClient)는 자기
 * 문구를 넘긴다. 도메인 소스(src, sample 밖)에는 어댑터의 문구를 두지 않는다(시험이 확인).
 */
export interface DomainLines {
  /** 도메인이 모르는 입력 · 아직 없는 기능(UNSUPPORTED). */
  unsupported: string;
  /** 다른 epoch의 창에서 보낸 명령(EPOCH_CHANGED, 자료를 되돌리거나 복구한 뒤). */
  epochChanged: string;
  /** 로그인한 사람의 역할에 없는 권한(FORBIDDEN, 서버의 거절). */
  forbidden: string;
  /** 이 기기(차량)의 범위 밖(FORBIDDEN_SCOPE, 서버의 거절). */
  forbiddenScope: string;
  /** 처리 중 오류(INTERNAL, 서버). */
  failed: string;
}

export interface ShopState {
  version: 3;
  /** 자료를 처음으로 되돌리거나 복구할 때마다 바뀐다(열린 확인 창의 basis가 옛것이면 거절). */
  epoch: string;
  rev: number;
  businessDate: string;
  /** 매장 목록 값(품목 · 결제 수단 · 구역 · 차량 …). */
  registry: ShopRegistry;
  orders: FxOrder[];
  pins: FxPin[];
  /** 기사 방문 순서(업무 id → 순위 글자). 없으면 약속 시각순. */
  routeRanks: Record<string, string>;
  /** 받은 명령의 결과(요청번호 → 결과). 같은 요청번호가 다시 오면 다시 하지 않고 이것을 돌려준다. B2c에서 어댑터 몫으로 나간다. */
  outcomes: Record<string, CommandOutcome>;
  /** 기사 기기의 연결과 보냄 대기(메모리 어댑터가 끊고 잇는다). B2c에서 어댑터 몫으로 나간다. */
  driverDevice: FxDevice;
  /** 운영 규칙(매장 설정). */
  settings: FxShopRules;
  /** 번호로 세는 실물(매장 재고 · 차량 예비권). 번호 없는 매장은 비어 있다. */
  assets: FxAsset[];
  /** 수량으로 세는 차량 예비권(번호 없는 매장). 옛 자료 · 번호 매장에는 없을 수 있다. */
  vanSpares?: FxVanSpare[];
  /** 보증금 보관과 보증금 장부. */
  deposits: FxDeposit[];
  /** 결제 자리(돈 한 건). 배분은 접수마다의 payments. */
  paymentGroups: FxPaymentGroup[];
  drawers: FxDrawer[];
  cashTransfers: FxCashTransfer[];
  closings: FxClosing[];
  /** 차량 매장 입고. 옛 저장 자료에는 없을 수 있다. */
  vanReceipts?: FxVanReceipt[];
  /** 새 접수 번호의 다음 차례(261226-019). */
  nextReceiptSeq: number;
  /** 이미 적용한 이야기 사건(메모리 어댑터의 몫, B2c에서 나간다). */
  storyApplied: string[];
  /** 직원(매장 설정 `차량 · 직원`). 옛 저장 자료에는 없을 수 있다. */
  staff?: FxStaff[];
  /** 저장된 확인 필요(features-1 §9). 쌓기만 하고, 끝내면 status가 바뀐다. 옛 저장 자료에는 없을 수 있다. */
  reviews?: FxReview[];
}

/** 옛 이름(apps/pos 시험 · 메모리 어댑터가 쓴다). 새 코드는 ShopState를 쓴다. */
export type FxState = ShopState;

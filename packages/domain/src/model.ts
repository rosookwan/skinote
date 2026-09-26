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
 */
export type FxCharge =
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
  | { id: string; kind: 'extension_undo'; lineId: string; amount: number; at: number };

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
  /** 접수 때 적용한 할인(discount_applications, catalog 9): 칸마다 하나. 줄 값(amount)은 이미 뺀 값이고 이것은 기록이다. */
  discounts?: FxDiscountApplication[];
}

/** 할인 적용 한 건(묶음 = 결제 칸마다 하나, 겹치지 않음). */
export interface FxDiscountApplication {
  sectionKey: FxSection;
  discountKey: string;
  label: string;
  /** 뺀 금액(10원 단위로 내림). */
  amount: number;
  at: number;
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
  places: { id: string; label: string }[];
}

export interface FxVehicle {
  id: string;
  label: string;
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
}

/** 매장 목록 값(예전의 모듈 상수, plan §3-2): 품목 · 종류 타일 · 결제 수단 · 결제 칸 · 할인 · 구역 · 차량 · 사유. 서버는 표에서 읽는다(§4-2). */
export interface ShopRegistry {
  shopName: string;
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
}

/** 옛 이름(apps/pos 시험 · 메모리 어댑터가 쓴다). 새 코드는 ShopState를 쓴다. */
export type FxState = ShopState;

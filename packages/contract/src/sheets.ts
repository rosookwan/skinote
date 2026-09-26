// 둘째 판 화면(docs/design/screens-v2, V1 ~ V9)의 읽기 모델과 조회 인자(ui 6-2 · 6-4 ~ 6-9).
// 틀이 따로인 창 · 화면이라 ledgerView가 아니라 query로 읽는다. 사람이 고른 것(번호 · 수량 · 수단 · 일정)을 인자로 다시 물으면
// 서버(체험판은 FixtureClient)가 줄 글 · 합계 · 주 버튼 이름 · 보낼 명령을 새로 써 준다: 화면은 업무 규칙을 계산하지 않는다
// (남는 일정, 돌려줄 보증금, 대납 몫, 차액은 모두 여기서 온다). 창은 연 때의 basis · 요청번호를 지키고, 다시 물어 받은 명령의
// 본문만 초안에 덮는다(같은 종류, draftToEnvelope). 글은 문구 표(docs/design/wording.md)의 말로 서버가 쓴다.
import type { ActionKey, DeviceClassKey, ToneKey } from './vocab.ts';
import type { ConfirmCommand, ConfirmStep, Expect } from './client.ts';
import type { Basis, BusinessDate, FitPart, ItemCount, LedgerCell, ReadModelHead, ReasonCode, StampCell } from './read-models.ts';

// ── 공통 조각 ─────────────────────────────────────────────────────────

/** 글 조각 하나. 서버가 한 줄을 조각으로 주고 화면은 그리기만 한다('미반납:'만 굵게, '차액 0원'은 초록 굵게, '지연'만 빨강). */
export interface TextRun {
  text: string;
  strong?: boolean;
  /** 조각 색(늦음 red는 늦은 것에만, 완료 green, 결제 예정 blue, 옅은 먹 grey). */
  tone?: ToneKey;
}

/** 조각들로 된 한 줄. */
export type RichText = TextRun[];

/**
 * 고르기 버튼 하나(시안의 mk-choice). 고름 = 남색 바탕(주황 아님), 누를 수 없음 = 점선 회색이고 자리는 그대로 둔다
 * (창 높이 · 줄 자리가 흔들리지 않게). 두 줄 버튼은 secondLine('솔마을' / '두솔동', '접수 시' / '미입금: 지급 시').
 */
export interface ChoiceOption {
  key: string;
  label: string;
  secondLine?: string;
  selected: boolean;
  enabled: boolean;
  /** 누를 수 없는 까닭(읽는 이름에 붙음: '선택 불가 · 시간 지남'). */
  reason?: string;
  /** 누르면 다음 단(구역 → 장소) · 작은 창이 열린다(글 뒤의 '›'는 부품이 그린다). */
  opens?: boolean;
  /** 줄이 좁을 때 쓰는 짧은 이름('오전타임 후 12:00' → '12:00'). 없으면 늘 label. */
  short?: string;
}

/** 수량 −/+ 칸 하나. */
export interface QuantityInput {
  value: number;
  min: number;
  max: number;
  /** 단위('대' · '개' · '매' · '벌'). */
  unit: string;
}

/** 주 버튼(창 · 화면에 하나): 이름, 좁을 때의 짧은 이름들, 누를 수 있는지. */
export interface PrimaryLabel {
  label: string;
  alts: string[];
  enabled: boolean;
}

/** 구역 → 장소(PlaceChooser, ui 5 · 4-4). 순서는 매장 설정(체험 자료 AREAS) 그대로. */
export interface PlaceArea {
  key: string;
  label: string;
  /** 숙소 구역이면 장소 이름 앞에 구역 이름을 붙여 쓴다('솔마을 두솔동'). */
  lodging: boolean;
  places: { key: string; label: string }[];
}

/** 고른 장소: 매장 직접, 또는 구역의 장소(차량). */
export type PlacePick = { mode: 'store' } | { mode: 'vehicle'; placeKey: string };

/** 반납 시각의 값(SlotChooser): 날(오늘 · 내일 · 날짜) + 반납 타임(매장 설정의 key). */
export interface SlotPick {
  day: 'today' | 'tomorrow' | BusinessDate;
  slotKey: string;
}

/** 일정 입력(새 접수 초안 · 일정 변경): 방법 · 시각 · 장소 · 차량. */
export interface PromiseInput {
  mode: 'store' | 'vehicle';
  /** 지금 매장에서 바로(수령 `매장 직접 · 즉시`). */
  immediate?: boolean;
  slot?: SlotPick;
  /** 직접 입력한 시각('17:00', 차량 배달 시각). */
  time?: string;
  /** 수령일(전화 예약). 없으면 오늘. */
  day?: 'today' | 'tomorrow' | BusinessDate;
  placeKey?: string;
  vehicleId?: string;
}

/** 품목 줄의 일부(번호로 세는 품목은 번호, 수량 품목은 수량). 반납 · 수거 · 배달 · 보증금 · 부분 결제가 같은 모양을 쓴다. */
export interface LineUnits {
  lineId: string;
  quantity: number;
  assetIds?: string[];
}

// ── V1 반납 확인 창 · 부분 반납(ui 6-2, data-model 4-18) ──────────────────────────

export interface ReturnSheetParams {
  orderId: string;
  /** 줄 하나의 반납 칸을 눌러 열면 그 줄만, 없으면 모든 줄(처리 현황의 반납). */
  lineIds?: string[];
  /** 지금 고른 번호 · 수량. 없으면 처음 연 상태(이 팀이 가진 것 모두, 끊긴 카운터에서는 보증금이 걸린 번호 빼고). */
  picked?: LineUnits[];
  /** 반환 방법(보증금). 없으면 규칙의 기본(refund_default_key). */
  refundMethodKey?: string;
}

/** 반납 창의 품목 칸 하나(재고 방식 unit = 번호 버튼, count = −/+). 세지 않는 품목은 칸이 없다. */
export interface ReturnPieceLine {
  lineId: string;
  /** '스키', '야간권 성인'. */
  label: string;
  /**
   * 둘째 줄(모든 매장): 일정이 둘 이상이면 일정별 수('설천 2 · 두솔동 1'), 하나면 번호 칸은 '설천 2대', 수량 칸은 차량 수거 장소만('설천',
   * 매장 일정이면 빈 글). 규격이 있으면 앞에 규격 이름. 'N개 중'은 쓰지 않는다. 확인 창의 수량 칸(ConfirmDraftView.counts)은 규격 이름만.
   */
  note: string;
  mode: 'unit' | 'count';
  /** 번호 버튼('17번'). picked = 남색 바탕. */
  pieces?: { assetId: string; label: string; picked: boolean }[];
  quantity?: QuantityInput;
  /** 하나도 고르지 않은 줄(이름이 옅은 먹). */
  muted: boolean;
  /** 번호가 많아 한 줄 전체를 쓰는 칸. */
  wide: boolean;
  /** 그래도 넘치면 번호 버튼 대신 작은 창을 여는 버튼 글('대여 12개 · 번호 선택 ›'). */
  pickerLabel?: string;
  /** 보증금을 맡은 줄(권): 칸이 여러 쪽이면 첫 쪽에 온다(④ 보증금 줄과 같은 쪽에서 안 가져온 권을 뺄 수 있게). */
  deposit?: boolean;
  /** 읽는 이름(규격까지: '의류 사이즈 95'). 이름(label)은 상품 이름, 규격은 둘째 줄(note) 앞. 없으면 label. */
  ariaLabel?: string;
}

export interface ReturnSheetView {
  basis: Basis;
  /** '반납 처리 · 박준호 팀'. */
  title: string;
  /** ① '전체 선택 · 미반납 번호 해제', 늦은 반납이면 '반납 지연 · 일정 22:00'(빨강). */
  lead: RichText;
  /** ② 품목 칸들(한 줄에 둘, 줄 6개까지 한 쪽). */
  lines: ReturnPieceLine[];
  /** ③ '미반납:'(굵게) + ' 보드 1 · 헬멧 1 · 권 1매 → 22:00 솔마을 두솔동 수거 예정 · 설천 주차장 수거 취소'. */
  remainder: RichText;
  /** ④ 보증금 줄. 보증금을 맡지 않은 팀이면 없음(④ ⑤가 없는 창, 연 동안 그대로). */
  deposit?: RichText;
  /**
   * ④ 자리의 돈 한 줄(보증금 줄이 없는 창): 이 팀이 낼 미수가 있으면 검정 `미수 120,000원`(반납하러 온 손님에게 받을 돈을 놓치지 않게,
   * 2026-09-26 검토). 늦음이 아니라 빨강이 아니다. 수납은 접수증의 수납 처리.
   */
  money?: RichText;
  /** ⑤ 반환 방법 버튼(`현금` · `미수 차감 · 120,000원 → 110,000원`). 이름표 `반환 방법`은 화면 문구. */
  refundMethods?: ChoiceOption[];
  primary: PrimaryLabel;
  /**
   * 고른 것의 반납(stock.direct_return). 하나도 고르지 않으면 없음. 돌려받을 것은 없는데 돌아온 권의 보증금이 남았으면(이어 보낸 반환이
   * 막혔음) 보증금 반환(deposit.return) 하나와 그 바탕(expect), 주 버튼 `보증금 반환 · 10,000원`.
   */
  command?: ConfirmCommand;
  /** 반납 뒤의 보증금 반환(deposit.return, dependsOn 반납). */
  then?: ConfirmStep[];
  expect?: Expect;
}

// ── V9 일정 변경 · 부분 품목(ui 6-2 N2, data-model 4-6) ─────────────────────────

export interface PromiseSheetParams {
  orderId: string;
  /** 줄마다 옮길 수량. 없으면 모두 0. */
  quantities?: Record<string, number>;
  slot?: SlotPick;
  place?: PlacePick;
  vehicleId?: string;
}

export interface PromiseSheetView {
  basis: Basis;
  /** '일정 변경 · 박준호 팀'. */
  title: string;
  /** ① 변경 품목: 줄마다 수량 칸(둘째 줄 '대여 2대' 또는 일정별 수). */
  lines: { lineId: string; label: string; note: string; quantity: QuantityInput }[];
  /** ② 반납 시각: 반납 타임(오늘 지났거나 10분 안이면 누를 수 없음) + 날(`내일` · `다른 날 ›`). */
  slots: ChoiceOption[];
  days: ChoiceOption[];
  /** ③ 반납 장소: 구역 → 장소와 지금 고른 것. */
  areas: PlaceArea[];
  place: PlacePick;
  /** ④ 수거 차량(`매장 직접`이면 자리만 남는다: vehicleRowVisible false). */
  vehicles: ChoiceOption[];
  vehicleRowVisible: boolean;
  /** ⑤ 요약 두 줄: `변경` · `유지`. */
  summary: { changed: RichText; kept: RichText };
  /** `다른 날 ›`의 작은 창에 보일 날짜들(모레 · 12월 29일 …). key는 영업일('2026-12-28'). */
  calendar: ChoiceOption[];
  /**
   * 한 줄 알림('리프트권 당일 한정 · 날짜 변경 불가'). 옮길 품목이 없는 접수(모두 반납)는 창 대신 이 한 줄(`반납 완료`)과 닫기만.
   */
  notice?: string;
  primary: PrimaryLabel;
  /** promise.change(수량이 0이거나 일정이 그대로면 없음). */
  command?: ConfirmCommand;
  /** 날을 옮겨 연장 값이 붙으면 그 견적(quoteHash, catalog 8 · 14): 서버가 다시 계산해 다르면 충돌. */
  expect?: Expect;
}

// ── V2 · V3 새 접수(ui 6-6): 초안은 기기에 있고 명령은 V4의 order.create 하나 ───────────────

/** 새 접수의 고른 품목 하나(상품 · 규격 · 수량). 사람이 아니라 품목 단위다(대표자만 적는다). */
export interface DraftItem {
  productKey: string;
  variantKey?: string;
  quantity: number;
}

/** 기기에 있는 새 접수 초안(V2 · V3 · V4가 같은 것을 고친다). */
export interface OrderDraftInput {
  /** 구분(orders.booking_channel_key): 현장 접수 · 전화 예약(V3 `예약 · 수령일 ›`으로 정함). */
  channel: 'walk_in' | 'phone';
  /** 대표자(이름 · 연락처 숫자 · 인원). 연락처는 숫자만 두고 화면 글은 읽기 모델(leader.phone)이 쓴다. */
  leader: { name: string; phone: string; party: number };
  items: DraftItem[];
  /** 수령: 매장 직접 · 즉시({ mode: 'store', immediate: true }), 전화 예약(day · time · 장소), 차량 배달(time 또는 immediate · 장소). */
  pickup: PromiseInput;
  giveBack: PromiseInput;
  /**
   * 사람이 직접 고른 반납 일정(② 반납일 · ③ 반납 시각은 time, ④ 반납 장소는 place). 고르기 전에는 서버가 처음 값을 정한다:
   * 반납 시각은 고른 권종의 사용 창 끝(권이 없으면 설정의 기본 반납 타임), 장소는 수령한 곳(spec 3-5). 누른 뒤에는 따라가지 않는다.
   */
  returnSet?: { time?: boolean; place?: boolean };
}

export interface OrderDraftParams {
  draft: OrderDraftInput;
  /** 지금 연 종류 타일(고르는 줄 두 칸이 그 종류로). */
  openKindKey?: string;
  /** 지금 고른 규격(고르는 줄 2의 수량 칸). 묶음 종류(리프트권)는 상품(권종) key. 없으면 서버가 정한다(수가 있는 첫 규격, 없으면 없음). */
  openVariantKey?: string;
}

/** 고르는 줄 2의 −/+가 고치는 초안 품목(상품 · 규격). 화면은 이 품목의 수만 바꿔 다시 묻는다. */
export interface DraftTarget {
  productKey: string;
  variantKey?: string;
}

/** 종류 타일 하나(item_kinds의 picker_placement · 이름 · 순서 · 기능으로 나옴, ADR-05). */
export interface KindTile {
  key: string;
  label: string;
  /** '1일 40,000원', '야간권 35,000원', '권종 선택', '요금 미등록'. */
  secondLine: string;
  /** 칸이 좁을 때의 둘째 줄('40,000원', '야간권'). 없으면 늘 secondLine. */
  secondShort?: string;
  /** 고른 수(수 표시). 없으면 표시 없음. */
  count?: number;
  /** 지금 열린 종류(옅은 바탕 + 굵은 남색 테두리 + 아래 갈매기). */
  open: boolean;
}

/** 고르는 줄 두 칸: 규격 버튼(`의류 사이즈` · `95 · 2벌` …)과 고른 규격의 수량(`사이즈 100` · −/+ · `의류 합계 3벌`). */
export interface OrderPicker {
  kindKey: string;
  /**
   * 규격(묶음 종류는 권종) 버튼 줄. 규격이 없는 종류(스키 · 보드)는 없음(줄 1이 빈다). moreLabel이 있으면 한 줄에 다 들어가지 않을 때 끝 칸이
   * `규격 더 보기 ›`가 되어 모든 규격의 작은 창을 연다(부츠 220 ~ 300, spec 3-4). 없으면 같은 줄의 `더 보기`.
   */
  variants?: { label: string; options: ChoiceOption[]; moreLabel?: string };
  /** 고른 규격(또는 규격 없는 종류)의 수량 칸. 규격을 아직 고르지 않았으면 없고 hint 한 줄. */
  quantity?: { label: string; value: QuantityInput; note?: string; target: DraftTarget };
  /** 규격을 고르기 전 줄 2의 회색 한 줄('사이즈 선택' · '권종 선택'). */
  hint?: string;
}

/** 오른쪽 판의 두 줄 줄(`스키 4대` / `부츠 · 폴 포함` · 160,000원, 접수 내용은 금액 없음). */
export interface DraftLineView {
  key: string;
  title: string;
  note: string;
  amount?: number;
  /** 둘째 줄이 품목 목록이면 그 목록(좁으면 '외 N종'으로 줄인다): `스키 4` · `의류 3` · `헬멧 1`. */
  items?: string[];
  /** 누르면 고르는 줄에 여는 종류 · 규격(선택 품목 줄). 없으면 누르는 줄이 아니다(접수 내용). */
  open?: { kindKey: string; variantKey?: string };
}

/** 합계 줄(`장비` · `리프트권` · 굵은 `합계` · 회색 `보증금 · 별도`). 보증금은 합계에 넣지 않는다. */
export interface DraftTotal {
  label: string;
  amount: number;
  strong?: boolean;
  muted?: boolean;
}

/** V3 ① 수령 방법의 작은 창(`예약 · 수령일 ›` · `차량 배달 ›`): 날 · 시각 버튼과 장소. 버튼을 누르면 바로 초안에 들어간다. */
export interface PickupWindow {
  /** 수령일(`오늘` · `내일` · `다른 날 ›`, 전화 예약만). */
  days?: ChoiceOption[];
  /** 수령 · 배달 시각(`즉시` · `16:30` · `17:00` · `직접 입력 ›`). 직접 입력한 시각은 그 버튼의 둘째 줄. */
  times: ChoiceOption[];
  /** 수령 장소: 매장 직접 또는 구역의 장소(차량 배달). 차량 배달 창은 장소를 고르기 전에 store(아무것도 고르지 않음). */
  place: PlacePick;
}

export interface OrderDraftView extends ReadModelHead {
  /** 제목 옆 이름표(`전화 예약`, 현장 접수는 없음). */
  channelTag?: string;
  /** 대표자 줄: 연락처 글('010-0000-0042', 없으면 ''), 인원 칸('4명'). 이름은 초안 그대로 쓴다. */
  leader: { phone: string; party: QuantityInput };
  tiles: KindTile[];
  /** 종류 격자의 쪽(pos 3 × 3 = 9개 기준, ui 3-10). 화면은 잰 높이로 한 쪽의 줄 수를 다시 센다(1024×529는 2줄). */
  tilePages: number;
  picker?: OrderPicker;
  selected: DraftLineView[];
  totals: DraftTotal[];
  /** V3 묶음 넷. 반납 장소는 PlaceChooser(areas + place, 구역을 누르면 장소의 작은 창). */
  schedule: {
    pickup: ChoiceOption[];
    returnDays: ChoiceOption[];
    returnSlots: ChoiceOption[];
    areas: PlaceArea[];
    returnPlace: PlacePick;
    /** `다른 날 ›` 작은 창의 날짜(모레 · 12월 29일 …, key는 영업일). 반납일 · 수령일이 같이 쓴다. */
    calendar: ChoiceOption[];
    /** `예약 · 수령일 ›`의 작은 창(수령일 · 수령 시각 · 수령 장소). */
    reserve: PickupWindow;
    /** `차량 배달 ›`의 작은 창(배달 시각 · 배달 장소). */
    deliver: PickupWindow;
  };
  /** V3 오른쪽 판 `접수 내용`. */
  summary: DraftLineView[];
  /**
   * 다음 단계로 갈 수 있는지(대표자 · 품목, 일정). 품목은 있는데 대표자 이름이 없으면 itemsReason(`대표자 이름 필요`, 주 버튼 위 회색 한 줄)과
   * missing 'name'(대표자 칸 표시): 연락처 · 인원은 적지 않아도 된다.
   */
  ready: { items: boolean; schedule: boolean; itemsReason?: string; missing?: 'name' };
  /** 바닥줄 `새 접수 · 이민호 팀 · 4명`. */
  footer: string;
  /** 요금표로 계산한 견적(V4 order.create의 expect.quoteHash, catalog 8 QUOTE_CHANGED). 품목이 없으면 ''. */
  quoteHash: string;
}

// ── V4 접수 확정 창 · 칸별 수납(ui 6-4, catalog 15) ────────────────────────────

/**
 * 확정 창의 약속된 key(읽기 모델과 화면이 함께 쓴다): 수단 줄의 `후불`(later) · `기타`(other, 작은 창), `기타` 판의 `다른 팀 결제`
 * (other_team, 팀 찾기 숫자판), `할인 적용 ›` 판의 `할인 없음`(none), 결제 팀 줄의 이 팀(self).
 */
export const CHECKOUT_KEYS = { later: 'later', other: 'other', otherTeam: 'other_team', noDiscount: 'none', self: 'self' } as const;

/**
 * 새 접수(V3)의 고르기 버튼 key(읽기 모델과 화면이 함께 쓴다): 수령 방법 `매장 직접 · 즉시`(now) · `예약 · 수령일`(reserve) ·
 * `차량 배달`(deliver), 반납일 · 수령일 `오늘`(today) · `내일`(tomorrow) · `다른 날`(other, 작은 창), 시각의 `직접 입력`(custom, 숫자판),
 * 배달 시각의 `즉시`(now). `다른 날` 창의 날짜 버튼 key는 영업일('2026-12-29')이다.
 */
export const ORDER_DRAFT_KEYS = {
  now: 'now', reserve: 'reserve', deliver: 'deliver', today: 'today', tomorrow: 'tomorrow', other: 'other', custom: 'custom',
} as const;

/** 날 버튼 key → SlotPick.day(`오늘` · `내일` · 영업일 날짜). `다른 날`(other)은 날이 아니라 창을 연다(null). */
export function dayPickOf(key: string): SlotPick['day'] | null {
  if (key === ORDER_DRAFT_KEYS.other) return null;
  return key === ORDER_DRAFT_KEYS.today || key === ORDER_DRAFT_KEYS.tomorrow ? key : /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}

/** 결제 칸마다 고른 수단(`card` · `cash` · `transfer` · `later`(후불) · 기타 수단의 key)과 할인. */
export interface CheckoutChoice {
  sectionKey: string;
  methodKey: string;
  discountKey?: string;
  /**
   * 이 칸만 다른 팀이 낼 때(`기타` 판의 `다른 팀 결제`, methodKey `later`와 함께). 없으면 `후불`인 칸은 결제 팀 줄의 팀(spec 3-3:
   * 결제 팀 줄은 `후불`인 칸 모두에 걸린다).
   */
  payerOrderId?: string;
}

export interface CheckoutSheetParams {
  draft: OrderDraftInput;
  /** 없으면 칸의 기본 수단(장비 카드, 리프트권 현금, 전화 예약이면 선입금). */
  choices?: CheckoutChoice[];
  /** 후불인 칸 모두를 낼 팀(자기 접수면 null). */
  payerOrderId?: string | null;
  /**
   * 이 창에서 `다른 팀 찾기 · 끝 4자리`로 찾은 팀(결제 팀 줄의 버튼 자리). 결제 팀 줄은 이 팀 · 고른 팀 · 찾은 팀만 보인다(관련 없는 팀을
   * 한 번에 누를 수 없게).
   */
  foundPayerIds?: string[];
}

/** 결제 칸 하나: 두 줄 칸(제목 줄 + 수단 줄) 또는 버튼 없는 한 줄 칸(보증금, 수단이 하나). */
export interface CheckoutSection {
  key: string;
  label: string;
  /** 제목 줄의 품목(`스키 4 · 의류 3 · 헬멧 1`) 또는 보증금 칸의 설명(`4매 · 매장 기준 1매 5,000원 · 반납 시 반환`). */
  items: string;
  /** 제목 줄의 품목 목록(좁으면 '외 N종'으로 줄인다). 설명 글(보증금 칸)은 없음. */
  itemList?: string[];
  /** 회색 할인 상태(`할인 없음`, `10% 할인 · 225,000원 → 202,500원`). 보증금 칸은 없음. */
  discount?: string;
  /** 좁을 때의 할인 상태(`10% 할인`). 없으면 늘 discount. */
  discountShort?: string;
  /** 파란 `이정호 팀 결제 예정`. */
  payerNote?: string;
  amount: number;
  /** 지금 받지 않는 금액(후불): 옅은 먹. */
  amountMuted: boolean;
  /** 수단 줄(빠른 수단 + `후불` + `기타`). 없으면 한 줄 칸. */
  methods?: ChoiceOption[];
  discountable: boolean;
  /** `할인 적용 ›` 작은 창의 선택지(`할인 없음` + 그 칸 할인 묶음의 할인, 한 묶음에 하나 — catalog 9). */
  discounts?: ChoiceOption[];
  /** `기타` 작은 창의 선택지(빠른 수단이 아닌 수단 + `다른 팀 결제`). key `other_team`은 팀 찾기 숫자판을 연다(opens). */
  others?: ChoiceOption[];
  /** 한 줄 칸의 받는 돈(`현금 20,000원`). */
  single?: RichText;
  /** 이 칸의 지금 선택(화면은 이것을 고쳐 다시 묻는다: 수단 · 할인 · 이 칸만의 결제 팀). */
  choice: CheckoutChoice;
}

export interface CheckoutSheetView {
  basis: Basis;
  /** '결제 · 이민호 팀'. */
  title: string;
  sections: CheckoutSection[];
  /**
   * 결제 팀 줄: 후불인 칸이 없으면 자리만(visible false). 선택지는 팀(이 팀 key `self` + 다른 팀들, key는 접수 id)이고
   * `다른 팀 찾기 · 끝 4자리`(숫자판)는 화면의 버튼이다. 찾은 팀은 payerOrderId로 다시 물으면 선택지에 들어온다.
   */
  payer: { visible: boolean; label: string; options: ChoiceOption[] };
  /** 받을 금액 줄(`받을 금액` · `현금 160,000원` · `= 리프트권 140,000원 + 보증금 20,000원`, 없으면 `받을 금액 없음`). */
  due: RichText;
  /** 확정할 수 없는 까닭 한 줄(그사이 반납 시각이 지남: `선택 불가 · 10분 이내`). 받을 금액 줄 자리에 보인다. */
  notice?: string;
  primary: PrimaryLabel;
  /** order.create 하나(약속 · 결제 약속 · 칸별 수납 · 보증금 입금이 함께). */
  command?: ConfirmCommand;
  expect?: Expect;
}

// ── V5 일괄 수납 · 여러 팀(ui 6-7) ───────────────────────────────────────

/** 일괄 수납의 탭 key(읽기 모델과 화면이 함께 쓴다): 이 팀이 내는 팀들(group) · 장부의 미수(unpaid). */
export const GROUP_PAY_TABS = { group: 'group', unpaid: 'unpaid' } as const;

export interface GroupPaySheetParams {
  /** 다른 팀 몫까지 받을 팀(결제 팀). */
  orderId: string;
  /** 탭: 이 팀이 내는 팀들 · 미수. */
  tabKey?: 'group' | 'unpaid';
  /** 고른 팀(두 탭 모두의 것). 없으면 처음(이 팀과 이 팀이 내기로 한 팀 · 더한 팀 모두). */
  selected?: string[];
  /** 팀 안에서 품목으로 일부만(사람으로 나누지 않음). 남은 것 모두를 고른 것은 부분이 아니다. */
  parts?: { orderId: string; lines: LineUnits[] }[];
  /** 결제 수단(빠른 수단 · `기타` 판의 수단). 없으면 카드. */
  methodKey?: string;
  /** `팀 추가 · 끝 4자리`로 더한 팀(목록 끝에 선택된 채). */
  added?: string[];
}

export interface GroupPayRow {
  orderId: string;
  /** '이정호 · 0032'. */
  team: string;
  /** 이름표(`결제 팀` 회색 · `결제 예정` 파랑 · `미수` 회색). */
  tag: { text: string; tone: ToneKey };
  /** 이 수납에서 낼 품목(남은 수, 종류마다 합: `스키 4 · 의류 3 · 헬멧 1`). */
  items: ItemCount[];
  /** 그 팀 몫(받을 금액 칸, 다른 팀 몫을 미수라 부르지 않는다). 부분을 골라도 그대로다. */
  amount: number;
  selected: boolean;
  /** 끝 칸 버튼 글(`부분 결제 ›` · `부분 · 165,000원 ›`)과 읽는 이름. */
  partLabel: string;
  /** 좁을 때의 짧은 글(`165,000원 ›`). 없으면 늘 partLabel. */
  partShort?: string;
  partAria: string;
}

export interface GroupPaySheetView extends ReadModelHead {
  /** '일괄 수납'. */
  title: string;
  /** `이정호 팀 결제 · 6팀` · `미수 3`. */
  tabs: { key: string; label: string; selected: boolean }[];
  /** 지금 탭의 줄(쪽은 화면이 잰 높이로 나눈다). */
  rows: GroupPayRow[];
  /** 두 탭을 통틀어 고른 팀(화면은 이것을 고쳐 selected로 다시 묻는다). */
  selectedIds: string[];
  /** 오른쪽 판: 28px 금액과 `6팀 · 이정호 팀 결제`. */
  total: { amount: number; note: string };
  /** 2 × 2 수단(카드 · 현금 · 계좌이체 · `기타`, 기타 판의 수단을 고르면 `기타` 두 줄). */
  methods: ChoiceOption[];
  /** `기타` 작은 창의 수단(간편결제 · 상품권). */
  others: ChoiceOption[];
  primary: PrimaryLabel;
  /** payment.take 한 번(돈 한 건 + 팀 · 줄마다 배분, expect에 팀마다 받을 금액). */
  command?: ConfirmCommand;
  expect?: Expect;
  /** 더한 팀 중 낼 것이 없어 빠진 팀과 그 한 줄(`최은정 · 0024 · 받을 금액 없음`). 화면은 알리고 added에서 뺀다. */
  dropped?: { orderId: string; note: string }[];
}

/** 부분 결제 판(V5 `부분 결제 ›`): 그 팀의 남은 품목 줄마다 −/+. */
export interface PartialPaySheetParams {
  orderId: string;
  payerOrderId: string;
  /** 지금 고른 수. 없으면 남은 것 모두. */
  lines?: LineUnits[];
}

export interface PartialPaySheetView {
  basis: Basis;
  /** '부분 결제 · 이민호 팀'. */
  title: string;
  /**
   * 줄마다: 이름('의류'), 둘째 줄(규격이 앞에: '사이즈 95 · 잔여 2벌 · 1벌 20,000원'), −/+, 고른 수의 값. 읽는 이름(ariaLabel)은 규격까지
   * ('의류 사이즈 95': 같은 이름의 줄을 가른다).
   */
  lines: { lineId: string; label: string; ariaLabel: string; note: string; quantity: QuantityInput; amount: number }[];
  total: number;
  /** 합계 줄(`선택 165,000원 · 받을 금액 225,000원`). */
  summary: RichText;
  /** `잔여 전체 선택` · `균등 분할`의 결과(누르면 이 수량으로 다시 묻는다). 결과가 비면 누를 수 없다. */
  presets: { key: 'all' | 'even'; label: string; lines: LineUnits[]; enabled: boolean }[];
  primary: PrimaryLabel;
}

// ── V6 하루 마감(ui 6-8, data-model 4-13) ────────────────────────────────

/**
 * 돈통 하나를 센 금액(돈통 점검)과 차액의 사유(`잔돈 착오` · `원인 불명` · `직접 입력`의 글). 마감 명령의 drawerCounts와 같은 모양.
 * expectedAmount는 셀 때의 예상(서버가 점검 판에서 써 준 값): 그 뒤 예상이 바뀌면(차량 현금 점검 · 새 현금 수납) 그 셈은 다시 셀 차례다.
 */
export interface ClosingCount {
  drawerId: string;
  countedAmount: number;
  expectedAmount?: number;
  reasonKey?: string;
  reasonNote?: string;
}

/**
 * 마감 화면의 초안(명령이 아닌 화면 상태): 센 돈통 금액(돈통 점검 · 재점검)과 따로 둔 차량 봉투(점검 이월). 마감 명령(closing.close)이
 * 이것을 싣는다(plan §8 D3: 마감 전 돈통 셈을 적는 명령 · 장부 표는 없다). check는 열린 점검 판(아래 판)의 줄 key와 친 금액 · 고른 사유:
 * 서버가 그 판의 차액 줄 · 사유 버튼 · 주 버튼 · 보낼 명령을 써 준다(check는 화면 줄에는 들어가지 않는다).
 */
export interface ClosingSheetParams {
  /** 영업일. 없으면 서버의 영업일(기준 시각 06:00을 넣은 날). */
  date?: BusinessDate;
  counts?: ClosingCount[];
  /** 점검 이월한 줄(차량 현금 인계 id 또는 아직 인계하지 않은 차량 지갑 `van:<차량>`). */
  deferredTransferIds?: string[];
  check?: { key: string; countedAmount?: number; reasonKey?: string; reasonNote?: string };
}

/** 결제 수단 표 한 줄(수납이 없는 수단은 줄이 없다). */
export interface ClosingMethodRow {
  key: string;
  label: string;
  /** 회색 둘째 줄(`1호 차량 35,000원 포함`): 좁으면 짧은 글(`1호 차량 35,000원`) → 빠짐. */
  note?: FitPart[];
  count: number;
  amount: number;
}

/** 현금 점검 표 한 줄(차량 현금이 위, 카운터 돈통이 아래). */
export interface CashCheckRow {
  /** 차량 현금 인계 id, 아직 인계하지 않은 차량 지갑(`van:v1`), 또는 돈통 id(`counter`). */
  key: string;
  kind: 'van' | 'drawer';
  label: string;
  /** 회색 둘째 줄(`23:48 입고 · 전송 대기 0` · `시재 100,000원 포함`): 좁으면 뒤 조각부터 빠진다. */
  note: FitPart[];
  /** `예상 35,000원` · `예상 545,000원 · 보증금 5,000원 포함`(좁으면 굵지 않은 뒤 조각이 빠진다). 차례가 아닌 줄은 빈 줄. */
  expected: RichText;
  /** `실제 35,000원 · 차액 0원`(차액 초록 굵게) · `실제 — · 차액 —` · 보라 `미점검` · 회색 `점검 이월`. */
  actual?: RichText;
  /** 차례가 아닌 줄의 회색 한 줄(`차량 현금 점검 후`): 예상 · 실제와 끝 칸 자리를 함께 쓴다. */
  waiting?: string;
  /** 지금 할 일(옅은 주황 줄). */
  now: boolean;
  /** 끝난 점검 도장(`점검` / `00:32`)과 그 읽는 이름(`현금 점검 완료 00:32`). */
  stamp?: StampCell;
  stampAria?: string;
  /** 끝 칸 동작(칸 전체가 버튼): 재점검 · 점검 이월 · 점검(이월한 봉투를 오늘 셈). 누르면 점검 판(recount · check) 또는 이월(defer). */
  action?: { key: 'recount' | 'defer' | 'check'; label: string };
}

/**
 * 이월 항목 한 줄(누르면 그 접수증 · 장부 탭). 늦은 것만 빨강(`지연` 조각 · 줄 앞 늦음 막대). 둘째 줄은 좁으면 뒤 조각부터 빠진다.
 * 갈 곳이 없으면(미확인 현금 인계) 누르는 줄이 아니다.
 */
export interface CarryItem {
  key: string;
  title: RichText;
  note: FitPart[];
  late: boolean;
  /** 한 팀이면 그 접수증. */
  orderId?: string;
  /** 여러 팀이면 오늘 장부의 그 탭(`unpaid` · `return`, 화면 설정의 tab_key). */
  tabKey?: string;
}

/** 열린 점검 판(차량 현금 점검 · 돈통 점검 · 재점검, spec 3-7): 예상 · 친 금액의 차액 · 사유 · 판의 주 버튼 · 보낼 것. */
export interface ClosingCheckView {
  key: string;
  kind: 'van' | 'drawer';
  /** 판 제목(`1호 차량 현금` · `카운터 돈통`). */
  title: string;
  expected: RichText;
  /** 친 금액의 차액(`차액 0원` 초록 굵게 · `차액 −5,000원 · 사유 선택`). 아직 치지 않았으면 빈 줄. */
  diff: RichText;
  /** 차액 사유 버튼(`잔돈 착오` · `원인 불명` · `직접 입력 ›`). 차액이 0이면 누를 수 없고 자리만 남는다(판 높이가 흔들리지 않게). */
  reasons: ChoiceOption[];
  reasonsShown: boolean;
  /** 판의 주 버튼(`차량 현금 점검 · 35,000원` · `돈통 점검 · 545,000원`). 차액이 있으면 사유를 고른 뒤에 누를 수 있다. */
  primary: PrimaryLabel;
  /** 차량 현금: 보낼 명령(cash.transfer_confirm)과 바탕(expectedCash). */
  command?: ConfirmCommand;
  expect?: Expect;
  /** 돈통: 화면 초안(counts)에 넣을 셈. */
  count?: ClosingCount;
}

export interface ClosingSheetView extends ReadModelHead {
  date: BusinessDate;
  /** `12월 26일 (토) 마감`. */
  title: string;
  /** 기준 띠: 알약 `현재 27일 00:40`과 `26일 장부 · 기준 06:00 · 00:15 정하늘 · 0041 반납 포함`(좁으면 뒤 조각부터 빠진다). */
  band: { pill: string; parts: FitPart[] };
  methods: ClosingMethodRow[];
  cash: CashCheckRow[];
  carry: CarryItem[];
  /** 바닥줄 굵은 요약(`수납 합계 1,965,000원 · 돈통 차액 0원`): 좁으면 수납 합계가 먼저 빠지고 지금 할 일(`돈통 점검 필요`)은 남는다. */
  footer: FitPart[];
  /** 지금 할 일(주황 주 버튼): 차량 현금 점검 → 돈통 점검 → 마감. 끝났으면 null. 막히면(전송 대기) enabled false. */
  next: { kind: 'van_check' | 'drawer_count' | 'close'; label: string; alts: string[]; enabled: boolean; targetKey?: string; expectedAmount?: number } | null;
  /** params.check가 있을 때의 점검 판. */
  check?: ClosingCheckView;
  /** 막힘 한 줄(`1호 차량 · 전송 대기 있음`). */
  blocked?: string;
  /** 마감 뒤 한 줄(`12월 26일 마감 완료`). */
  closed?: string;
  /**
   * 마감을 누르기 전에 묻는 창(next가 close일 때): 영업 중에 닫으면 그 뒤의 기록은 다음 날 마감에 든다. 마지막 반납 타임 전이거나, 이 영업일의
   * 반납 예정 · 차량 미입고가 남았으면 `사실 · 할 일` 한 줄(`26일 반납 예정 42개 · 1호 차량 미입고`)과 버튼 `닫기` · 주 버튼(next.label).
   * 없으면 주 버튼이 바로 보낸다.
   */
  confirm?: { title: string; line: string };
  /** 마감(closing.close)의 명령과 바탕(expectedCash): next가 close일 때. */
  command?: ConfirmCommand;
  expect?: Expect;
}

// ── V7 기사 업무 판 · 배달 목록의 한 팀(ui 6-5) ──────────────────────────────

export interface TaskSheetParams {
  taskId: string;
  deviceClass?: DeviceClassKey;
}

/** 오른쪽 판의 큰 버튼 하나(선 그림 + 글). 그림은 화면이 동작 키로 고른다. */
export interface TaskSheetAction {
  actionKey: ActionKey;
  label: string;
  /** 둘째 줄(`야간권 재고 6매`). */
  secondLine?: string;
  enabled: boolean;
  reason?: string;
}

export interface TaskSheetView extends ReadModelHead {
  taskId: string;
  orderId: string;
  kind: 'deliver' | 'collect';
  /** `배달 · 17:00 만선 광장`(수거면 `수거 · 22:00 설천 주차장`). */
  title: string;
  /** `최하은 · 0026`. */
  team: string;
  /** 대표자 이름과 끝 4자리(창 제목 `전화 · 최하은 팀` · 방문 결과 판 제목에 따로 쓴다). */
  teamName: string;
  last4: string;
  /** `010-0000-0026 · 3명`(속성 자리 task_sheet가 있으면 끝에 붙음). */
  contact: string;
  phone?: string;
  /** 품목 표 칸(`품목` · `수량` · `적재` · `배달`)과 줄(도장 칸은 LedgerCell stamp). */
  columns: { key: string; label: string }[];
  lines: { lineId: string; label: string; qtyText: string; cells: Record<string, LedgerCell> }[];
  /** 돈 줄(`미수 없음`(초록) · `12/25 계좌이체 수납`, 맡은 보증금). 기사 화면 미수 표시가 꺼지면 없음. */
  money?: RichText[];
  actions: TaskSheetAction[];
  /** 반납 일정(배달 판만): `오늘 22:10 · 만선 티롤 앞 · 1호 차량`, 권이 있으면 `권 1매 포함 · 보증금 5,000원 반환`. */
  returnPlan?: string[];
  /** 바닥줄 가운데(`완료 0 · 잔여 1`, 끝나면 `배달 완료 · 16:57`). */
  progress: string;
  /** 보라 주 버튼(`배달 처리 · 6개`, 수거면 `수거 처리 · N개`). 모두 끝나면 enabled false. */
  primary: PrimaryLabel & { actionKey: ActionKey };
  /** 실패 판의 사유(업무 종류로 거름: 배달 `고객 부재` · `장소 변경` · `기타`). */
  visitReasons: ReasonCode[];
  /** 이 업무의 차량(머리줄 이름표 `1호 차량`). */
  vehicle: { id: string; label: string };
}

/** 현장 수납 판(`field.collect`): 받을 금액 · 빠른 수단(기사 허용 ≤ 3) · 금액 숫자판 · `후불 처리`. */
export interface FieldPaySheetParams {
  taskId: string;
  amount?: number;
  methodKey?: string;
  /**
   * 리프트권 추가에 이어 연 판이면 그 추가 명령의 요청번호: 받을 금액 줄이 권 값과 방금 받은 권 보증금(현금)을 합해 손에 받을 돈을 적는다
   * (`받을 금액 현금 40,000원 = 리프트권 35,000원 + 보증금 5,000원`).
   */
  afterTicket?: string;
}

export interface FieldPaySheetView {
  basis: Basis;
  title: string;
  due: RichText;
  methods: ChoiceOption[];
  /** 숫자판에 넣는 금액(처음은 미수, 미수가 없으면 0부터). */
  amount: { value: number; max?: number };
  primary: PrimaryLabel;
  command?: ConfirmCommand;
  expect?: Expect;
  /** `후불 처리`(payment_promise.set). */
  leaveUnpaid?: { label: string; command: ConfirmCommand };
}

/** 리프트권 추가 판(`field.add_ticket`): 차량 예비권 → 수량 → 값 · 보증금 → 곧바로 현장 수납(dependsOn). */
export interface AddTicketSheetParams {
  taskId: string;
  productKey?: string;
  quantity?: number;
}

export interface AddTicketSheetView {
  basis: Basis;
  title: string;
  /** 권종마다 차량 재고(`야간권 재고 6매`). */
  products: ChoiceOption[];
  quantity: QuantityInput;
  /** 값 · 보증금 줄(`야간권 1매 35,000원`, `보증금 · 매장 기준 1매 5,000원`). */
  lines: RichText[];
  primary: PrimaryLabel;
  command?: ConfirmCommand;
  then?: ConfirmStep[];
  expect?: Expect;
}

// ── V8 관리 · 매장 설정 · 운영 규칙(ui 6-9) ────────────────────────────────

/** 운영 규칙 바꿈이 고치는 표(RuleChange key의 첫 마디, schema.sql의 표 이름). */
export const RULE_TABLES = ['item_kinds', 'deposit_rules', 'shop_settings', 'shops'] as const;
export type RuleTable = (typeof RULE_TABLES)[number];

/** RuleChange key의 세 마디. */
export interface RuleKeyParts {
  table: RuleTable;
  /** 행 key(item_kinds.key · deposit_rules.key · shop_settings의 설정 key). shops는 이 매장 하나라 ''. */
  row: string;
  /** 열 이름. shop_settings는 그 설정 값(JSON)의 칸 이름(prepayment_mode의 mode · amount). */
  column: string;
}

/** RuleChange key를 만든다('<표>:<행>:<열>'). 행 · 열에 ':'는 쓰지 않는다. */
export function ruleKey(table: RuleTable, row: string, column: string): string {
  return table + ':' + row + ':' + column;
}

/** RuleChange key를 읽는다. 표가 목록에 없거나 마디가 셋이 아니면 null. */
export function parseRuleKey(key: string): RuleKeyParts | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const [table = '', row = '', column = ''] = parts;
  return (RULE_TABLES as readonly string[]).includes(table) && column !== '' ? { table: table as RuleTable, row, column } : null;
}

/**
 * 운영 규칙 한 곳의 바꿈. key는 ruleKey('<표>:<행 key>:<열>', 카드가 행에서 나오므로, ADR-05)이고 schema.sql과 같다:
 * 'item_kinds:lift:return_policy_key'(행은 매장의 품목 종류 key), 'deposit_rules:lift_ticket_card:unit_amount' · ':active'(INTEGER 0 · 1),
 * 'shop_settings:prepayment_mode:mode' · ':amount'(shop_settings의 JSON 값 {"mode": …, "amount": …}의 칸),
 * 'shop_settings:same_day_cancel_refund_default:decision', 'shops::business_day_cutoff'. 값은 그 열(칸)의 값('required', 5000, 1, '06:00').
 * 고르기 버튼은 RuleRow.values에 그 버튼의 값이 있으면 그것, 없으면 버튼 key를 보낸다.
 */
export interface RuleChange {
  key: string;
  value: string | number | boolean | null;
}

export interface ShopRulesParams {
  /** 아직 저장하지 않은 바꿈(화면 초안, 같은 key는 마지막 것). */
  changes?: RuleChange[];
}

/**
 * 숫자판으로 넣는 값(값 버튼 `1매 5,000원 ›`, 시각 줄의 `직접 입력`). 받는 범위는 서버가 준다: 범위 밖의 값은 숫자판의 `입력`이
 * 눌리지 않는다(금액은 원, 시각은 하루의 분 — 영업일 기준 시각 00:00 ~ 11:59).
 */
export interface RuleInput {
  /** 넣은 값의 바꿈 key(RuleChange.key). */
  key: string;
  mode: 'amount' | 'time';
  /** 숫자판 제목(이름 · 지금 값: `리프트권 보증금 · 1매 5,000원`, `영업일 기준 시각 · 06:00`). */
  title: string;
  min: number;
  max: number;
  /** 숫자판 표시 칸 아래 한 줄(`00:00 ~ 11:59`). */
  note?: string;
}

/** 카드 안의 줄 하나(이름표 + 고르기 버튼, 끝에 값 버튼 `1매 5,000원 ›`). 이름표가 없는 줄은 버튼이 카드 폭을 채운다. */
export interface RuleRow {
  /** 고르기 버튼의 바꿈 key(RuleChange.key). */
  key: string;
  label?: string;
  options: ChoiceOption[];
  /** 값 버튼(고르기가 아니라 남색이 되지 않는다, 글 뒤의 '›'는 부품이 그린다): 누르면 숫자판. */
  value?: { label: string; input: RuleInput };
  /** 고르기 중 숫자판을 여는 버튼(`직접 입력`): 버튼 key → 숫자판. */
  inputs?: Record<string, RuleInput>;
  /** 고르기 버튼이 보낼 값(버튼 key → RuleChange.value, 열의 형: `사용` → 1). 없으면 버튼 key. */
  values?: Record<string, RuleChange['value']>;
}

/** 운영 규칙 카드 하나(규칙 행마다 한 장: 반납 정책을 고르는 품목 종류마다 `○○ 반납`, 보증금 규칙마다 `○○ 보증금`). */
export interface RuleCard {
  key: string;
  title: string;
  /** 저장하지 않은 바꿈이 이 카드에 있다(이름표 `변경됨`). */
  changed: boolean;
  /** 한 줄 카드(제목 뒤 남는 폭을 버튼이 채움, `당일 취소 환불`). */
  inline: boolean;
  rows: RuleRow[];
  /**
   * 안내 · 예시 줄(`반납 필수 · 리프트권 반납 후 완료`, `27일 00:15 반납 → 26일 장부`, 회색 한 줄 `보증금 미사용`). 한 줄에 하나,
   * 조각의 tone grey는 옅은 먹.
   */
  notes: RichText[];
}

/** 저장 확인 창의 한 줄(전 → 후). */
export interface RuleChangeLine {
  key: string;
  /** `리프트권 반납`, `리프트권 보증금 · 입금 시점`. */
  label: string;
  before: string;
  after: string;
}

export interface ShopRulesView extends ReadModelHead {
  cards: RuleCard[];
  /** 바뀐 곳(전 → 후). 저장 확인 창 목록. 보이지 않게 된 줄(보증금 미사용의 입금 시점 …)의 바꿈은 세지 않는다. */
  changes: RuleChangeLine[];
  /** 바닥줄 굵은 글(`변경 3건 · 다음 기록부터 적용` · `변경 없음`). */
  footer: string;
  /** 저장 확인 창 제목(`변경 3건`)과 떠날 때 확인 창 제목(`미저장 변경 3건`). 바뀐 곳이 없으면 없음. */
  saveTitle?: string;
  unsavedTitle?: string;
  primary: PrimaryLabel;
  /** setting.set(바뀐 곳이 없으면 없음). */
  command?: ConfirmCommand;
  /** 저장이 거절될 까닭(`변경 불가 · 06:00 이후 가능`): 저장 확인 창이 보이고 주 버튼을 막는다. */
  rejection?: string;
}

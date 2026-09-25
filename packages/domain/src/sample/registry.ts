// 견본 매장의 목록 값(견본 registry): 품목 · 종류 타일 · 결제 수단 · 결제 칸 · 할인 · 구역과 장소 · 차량 · 사유. 체험판(FixtureClient),
// 시험, 서버의 견본 매장 만들기(provision --sample)가 같은 값을 쓴다(plan D14). 1일 값은 spec 2-3(야간권 성인 35,000원)이고, 오전권 ·
// 오후권 · 주간권 · 종일권의 값은 체험 값이다(impl-v2 plan §8 D5). 강습은 이 매장이 기능을 꺼서 타일이 없다.
import type { ConditionKey } from '@skinote/contract';
import type { FxDiscount, FxKind, FxPayMethod, FxPaySection, FxProduct, FxVariant } from '../catalog.ts';
import type { FxArea, FxVehicle, FxVisitOutcome, ShopRegistry } from '../model.ts';

export const SHOP_NAME = '우리 스키샵';

const GEAR_CAPS: ConditionKey[] = ['exchangeable', 'extendable'];

const ticket = (key: string, label: string, short: string, price: number, returnSlotKey: string): FxProduct => ({
  key, kindKey: 'lift', label, shortLabel: short, unit: '매', price, section: 'lift', returnable: false, capabilities: [], tracking: 'unit', countWord: '매', returnSlotKey,
});

/** 상품(차례는 종류 타일의 차례). 1일 값은 spec 2-3(야간권 성인 35,000원). */
export const PRODUCTS: Readonly<Record<string, FxProduct>> = {
  ski: { key: 'ski', kindKey: 'ski', label: '스키', price: 40_000, section: 'gear', returnable: true, capabilities: GEAR_CAPS, tracking: 'unit', countWord: '대', includes: '부츠 · 폴 포함' },
  board: { key: 'board', kindKey: 'board', label: '보드', price: 25_000, section: 'gear', returnable: true, capabilities: GEAR_CAPS, tracking: 'unit', countWord: '대' },
  boots: { key: 'boots', kindKey: 'boots', label: '부츠', price: 10_000, section: 'gear', returnable: true, capabilities: GEAR_CAPS, tracking: 'unit', countWord: '개' },
  clothes: { key: 'clothes', kindKey: 'clothes', label: '의류', price: 20_000, section: 'gear', returnable: true, capabilities: GEAR_CAPS, tracking: 'unit', countWord: '벌' },
  helmet: { key: 'helmet', kindKey: 'helmet', label: '헬멧', price: 5_000, section: 'gear', returnable: true, capabilities: GEAR_CAPS, tracking: 'unit', countWord: '개' },
  goggles: { key: 'goggles', kindKey: 'goggles', label: '고글', price: 5_000, section: 'gear', returnable: true, capabilities: GEAR_CAPS, tracking: 'count', countWord: '개' },
  morning_adult: ticket('morning_adult', '오전권 성인', '오전권', 45_000, 'morning'),
  afternoon_adult: ticket('afternoon_adult', '오후권 성인', '오후권', 45_000, 'afternoon'),
  night_adult: ticket('night_adult', '야간권 성인', '야간권', 35_000, 'night'),
  day_adult: ticket('day_adult', '주간권 성인', '주간권', 60_000, 'afternoon'),
  full_adult: ticket('full_adult', '종일권 성인', '종일권', 75_000, 'afternoon'),
};

const sizes = (labels: readonly string[], name: (label: string) => string): FxVariant[] => labels.map((label) => ({ key: label, label, name: name(label) }));
const numbered = (label: string) => '사이즈 ' + label;
const BOOTS = Array.from({ length: 17 }, (_, i) => String(220 + i * 5));

/** 종류 타일(tile order: 스키 · 보드 · 부츠 · 의류 · 헬멧 · 고글 · 리프트권, spec 3-4). 강습은 기능이 꺼져 없다. */
export const KINDS: readonly FxKind[] = [
  { key: 'ski', label: '스키', placement: 'tile', products: ['ski'] },
  { key: 'board', label: '보드', placement: 'tile', products: ['board'] },
  { key: 'boots', label: '부츠', placement: 'tile', products: ['boots'], axis: '사이즈', variants: sizes(BOOTS, numbered) },
  { key: 'clothes', label: '의류', placement: 'tile', products: ['clothes'], axis: '사이즈', variants: sizes(['90', '95', '100', '105', '110'], numbered) },
  // 헬멧 줄의 둘째 줄은 '중 사이즈'('사이즈 중'은 '사이즈 재는 중'으로 읽힘, 문구 표 3-6).
  { key: 'helmet', label: '헬멧', placement: 'tile', products: ['helmet'], axis: '사이즈', variants: sizes(['소', '중', '대'], (l) => l + ' 사이즈') },
  { key: 'goggles', label: '고글', placement: 'tile', products: ['goggles'], axis: '규격', variants: sizes(['어른', '어린이'], (l) => l) },
  { key: 'lift', label: '리프트권', placement: 'grouped', products: ['morning_adult', 'afternoon_adult', 'night_adult', 'day_adult', 'full_adult'], axis: '권종' },
];

/** 한 초안 품목의 수 한도(체험 값). */
export const MAX_QTY = 20;

/** 돈 수단(payment_methods). quick = 확정 창의 버튼, 나머지는 `기타` 판. */
export const PAY_METHODS: readonly FxPayMethod[] = [
  { key: 'card', label: '카드', quick: true },
  { key: 'cash', label: '현금', quick: true },
  { key: 'transfer', label: '계좌이체', quick: true },
  { key: 'easy_pay', label: '간편결제', quick: false },
  { key: 'voucher', label: '상품권', quick: false },
];

/** 결제 칸(payment_sections): 칸 이름과 기본 수단(장비 카드 · 리프트권 현금, spec 2-3). 보증금 칸은 보증금 규칙에서 온다. */
export const PAY_SECTIONS: readonly FxPaySection[] = [
  { key: 'gear', label: '장비', defaultMethod: 'card' },
  { key: 'lift', label: '리프트권', defaultMethod: 'cash' },
];

/** 할인(discount_rules): 체험 값은 두 묶음의 10% 하나(impl-v2 plan §8 D39). */
export const DISCOUNTS: readonly FxDiscount[] = [
  { key: 'ten_percent', label: '10% 할인', percent: 10, sections: ['gear', 'lift'] },
];

export const AREAS: readonly FxArea[] = [
  { id: 'seolcheon', label: '설천', lodging: false, places: [{ id: 'seolcheon_parking', label: '설천 주차장' }, { id: 'seolcheon_house', label: '설천 하우스 앞' }] },
  { id: 'manseon', label: '만선', lodging: false, places: [{ id: 'manseon_plaza', label: '만선 광장' }, { id: 'manseon_tirol', label: '만선 티롤 앞' }] },
  {
    id: 'solmaeul', label: '솔마을', lodging: true,
    places: [{ id: 'hansol', label: '한솔동' }, { id: 'dusol', label: '두솔동' }, { id: 'sesol', label: '세솔동' }, { id: 'nesol', label: '네솔동' }],
  },
  {
    id: 'kkotmaeul', label: '꽃마을', lodging: true,
    places: [
      { id: 'deulgukhwa', label: '들국화' }, { id: 'baekhap', label: '백합' }, { id: 'mindeulle', label: '민들레' },
      { id: 'gaenari', label: '개나리' }, { id: 'haebaragi', label: '해바라기' }, { id: 'cosmos', label: '코스모스' },
    ],
  },
];

export const VEHICLES: readonly FxVehicle[] = [
  { id: 'v1', label: '1호 차량' },
  { id: 'v2', label: '2호 차량' },
];

/** 방문 결과 이름(reason_codes의 visit_result 체험 값). 업무 종류마다 셋을 보인다(rules.ts VISIT_REASON_KEYS). */
export const VISIT_OUTCOMES: readonly { key: FxVisitOutcome; label: string }[] = [
  { key: 'customer_absent', label: '고객 부재' },
  { key: 'place_changed', label: '장소 변경' },
  { key: 'items_not_ready', label: '물품 미준비' },
  { key: 'other', label: '기타' },
];

/** 차액 사유(reason_codes의 체험 값, spec 3-7 · 문구 표 3-9). 직접 입력(manual)은 글을 함께 적는다. */
export const CASH_REASONS: readonly { key: string; label: string }[] = [
  { key: 'change_error', label: '잔돈 착오' },
  { key: 'unknown', label: '원인 불명' },
  { key: 'manual', label: '직접 입력' },
];

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 견본 매장의 목록 값(새 사본). */
export function sampleRegistry(): ShopRegistry {
  return copy({
    shopName: SHOP_NAME,
    timezone: 'Asia/Seoul',
    products: PRODUCTS,
    kinds: KINDS,
    payMethods: PAY_METHODS,
    paySections: PAY_SECTIONS,
    discounts: DISCOUNTS,
    areas: AREAS,
    vehicles: VEHICLES,
    visitOutcomes: VISIT_OUTCOMES,
    cashReasons: CASH_REASONS,
    maxLineQuantity: MAX_QTY,
  } satisfies ShopRegistry);
}

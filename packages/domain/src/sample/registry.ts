// 견본 매장의 목록 값(견본 registry): 품목 · 종류 타일 · 결제 수단 · 결제 칸 · 할인 · 구역과 장소 · 차량 · 사유. 체험판(FixtureClient),
// 시험, 서버의 견본 매장 만들기(provision --sample)가 같은 값을 쓴다(plan D14). 1일 값은 spec 2-3(야간권 성인 35,000원)이고, 오전권 ·
// 오후권 · 주간권 · 종일권의 값은 체험 값이다(impl-v2 plan §8 D5). 강습은 이 매장이 기능을 꺼서 타일이 없다.
// 첫 매장(2026-09-26 사장님 답): 장비에 관리 번호가 없고 리프트권 번호도 관리하지 않아 모든 품목을 수량으로 센다(tracking count). 결제는
// 카드 · 현금 · 계좌이체가 거의 전부(지역화폐 없음, 드문 것은 `기타` 판), 카드 단말기는 카운터 1대라 기사는 현금 · 계좌이체만 받는다
// (그 밖은 매장에서 후불). 차량은 1호 · 2호(붐비면 개인 차까지 3대 이상: 차량을 더하는 매장 설정은 아직 없음).
// 번호 스티커 · 권 번호가 있는 매장의 모양(shop 'numbered')도 둔다: 번호로 세는 규칙과 권 보증금이 계속 도는지 보는 시험용이다.
import type { ConditionKey } from '@skinote/contract';
import type { FxDiscount, FxKind, FxPayMethod, FxPaySection, FxProduct, FxVariant } from '../catalog.ts';
import type { FxArea, FxVehicle, FxVisitOutcome, ShopRegistry } from '../model.ts';

export const SHOP_NAME = '우리 스키샵';

/**
 * 견본 매장의 모양: first = 첫 매장(번호 없음 · 보증금 없음, 체험판과 서버의 시험 매장), numbered = 번호 스티커 · 권 번호와 권 보증금을
 * 켠 다른 매장(시험: 번호 · 보증금 규칙이 켜면 도는지).
 */
export type SampleShop = 'first' | 'numbered';

const GEAR_CAPS: ConditionKey[] = ['exchangeable', 'extendable'];

const ticket = (key: string, label: string, short: string, price: number, returnSlotKey: string): FxProduct => ({
  key, kindKey: 'lift', label, shortLabel: short, unit: '매', price, section: 'lift', returnable: false, capabilities: [], tracking: 'count', countWord: '매', returnSlotKey,
});

/** 상품(차례는 종류 타일의 차례). 1일 값은 spec 2-3(야간권 성인 35,000원). 첫 매장은 모두 수량으로 센다(번호 없음). */
export const PRODUCTS: Readonly<Record<string, FxProduct>> = {
  ski: { key: 'ski', kindKey: 'ski', label: '스키', price: 40_000, section: 'gear', returnable: true, capabilities: GEAR_CAPS, tracking: 'count', countWord: '대', includes: '부츠 · 폴 포함' },
  board: { key: 'board', kindKey: 'board', label: '보드', price: 25_000, section: 'gear', returnable: true, capabilities: GEAR_CAPS, tracking: 'count', countWord: '대' },
  boots: { key: 'boots', kindKey: 'boots', label: '부츠', price: 10_000, section: 'gear', returnable: true, capabilities: GEAR_CAPS, tracking: 'count', countWord: '개' },
  clothes: { key: 'clothes', kindKey: 'clothes', label: '의류', price: 20_000, section: 'gear', returnable: true, capabilities: GEAR_CAPS, tracking: 'count', countWord: '벌' },
  helmet: { key: 'helmet', kindKey: 'helmet', label: '헬멧', price: 5_000, section: 'gear', returnable: true, capabilities: GEAR_CAPS, tracking: 'count', countWord: '개' },
  goggles: { key: 'goggles', kindKey: 'goggles', label: '고글', price: 5_000, section: 'gear', returnable: true, capabilities: GEAR_CAPS, tracking: 'count', countWord: '개' },
  morning_adult: ticket('morning_adult', '오전권 성인', '오전권', 45_000, 'morning'),
  afternoon_adult: ticket('afternoon_adult', '오후권 성인', '오후권', 45_000, 'afternoon'),
  night_adult: ticket('night_adult', '야간권 성인', '야간권', 35_000, 'night'),
  day_adult: ticket('day_adult', '주간권 성인', '주간권', 60_000, 'afternoon'),
  full_adult: ticket('full_adult', '종일권 성인', '종일권', 75_000, 'afternoon'),
};

/** 번호 매장(shop 'numbered')에서 번호로 세는 상품: 고글 밖의 장비와 리프트권(번호 스티커 · 권 번호). */
export const NUMBERED_PRODUCTS: readonly string[] = ['ski', 'board', 'boots', 'clothes', 'helmet', 'morning_adult', 'afternoon_adult', 'night_adult', 'day_adult', 'full_adult'];

/** 그 모양의 상품 목록(번호 매장은 NUMBERED_PRODUCTS를 unit으로). */
function productsOf(shop: SampleShop): Record<string, FxProduct> {
  if (shop === 'first') return { ...PRODUCTS };
  return Object.fromEntries(Object.entries(PRODUCTS).map(([key, p]) => [key, NUMBERED_PRODUCTS.includes(key) ? { ...p, tracking: 'unit' as const } : p]));
}

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

/**
 * 돈 수단(payment_methods). quick = 확정 창의 버튼(카드 · 현금 · 계좌이체, 첫 매장 결제의 거의 전부), 나머지는 드문 경우의 `기타` 판(지역화폐 ·
 * 상품권은 받지 않음, README D7). `기타` 판의 간편결제는 견본 값이다(나머지 1%가 무엇인지는 열린 질문 37). driver = 기사가 현장에서 받는
 * 수단: 카드 단말기가 카운터 1대뿐이라 현금 · 계좌이체(가게 계좌)만, 안 되면 매장에서 후불.
 */
export const PAY_METHODS: readonly FxPayMethod[] = [
  { key: 'card', label: '카드', quick: true, driver: false },
  { key: 'cash', label: '현금', quick: true, driver: true },
  { key: 'transfer', label: '계좌이체', quick: true, driver: true },
  { key: 'easy_pay', label: '간편결제', quick: false, driver: false },
];

/**
 * 번호 매장 모양(견본 매장: 시안 V4 · V5 · V7이 그린 매장, spec 2-3 `견본(그림)`)의 돈 수단: 기사도 카드를 받고(3버튼 기사 수단 줄), `기타` 판에
 * 간편결제 · 상품권. 첫 매장 값(PAY_METHODS)과 달리 시안 그대로 두어 3버튼 줄 · 2줄 `기타` 판을 시험 · 규칙 검사가 계속 본다.
 */
export const SAMPLE_PAY_METHODS: readonly FxPayMethod[] = [
  { key: 'card', label: '카드', quick: true, driver: true },
  { key: 'cash', label: '현금', quick: true, driver: true },
  { key: 'transfer', label: '계좌이체', quick: true, driver: true },
  { key: 'easy_pay', label: '간편결제', quick: false, driver: false },
  { key: 'voucher', label: '상품권', quick: false, driver: false },
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

/** 차량(첫 매장 2대). 붐비는 날 개인 차까지 쓰는 3호 · 4호는 매장 설정의 `차량 · 직원`이 생기면 그때 더한다. */
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

/** 견본 매장의 목록 값(새 사본). shop: 첫 매장(기본) · 번호 매장. */
export function sampleRegistry(shop: SampleShop = 'first'): ShopRegistry {
  return copy({
    shopName: SHOP_NAME,
    timezone: 'Asia/Seoul',
    products: productsOf(shop),
    kinds: KINDS,
    payMethods: shop === 'first' ? PAY_METHODS : SAMPLE_PAY_METHODS,
    paySections: PAY_SECTIONS,
    discounts: DISCOUNTS,
    areas: AREAS,
    vehicles: VEHICLES,
    visitOutcomes: VISIT_OUTCOMES,
    cashReasons: CASH_REASONS,
    maxLineQuantity: MAX_QTY,
  } satisfies ShopRegistry);
}

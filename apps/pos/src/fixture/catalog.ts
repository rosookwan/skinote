// 체험 자료의 품목 목록(catalog 2 · 4 · 5 · 11, spec 2-3): 종류 타일(item_kinds의 picker_placement · 이름 · 순서), 상품과 1일 값,
// 규격 축(item_kind_attributes usage variant_axis), 리프트권 권종(ticket_products)과 그 사용 창의 끝(반납 시각의 처음 값), 재고 방식.
// 새 접수(V2 · V3)의 읽기 모델(order-draft.ts)과 처음 자료(seed.ts)가 같은 목록을 쓴다. 강습은 이 매장이 기능을 꺼서 타일이 없다.
// 화면은 종류 이름을 비교하지 않는다: 타일 · 규격 버튼 · 줄 글은 이 목록에서 읽기 모델이 만든다(ADR-05).
// 체험 전용이고 LocalClient가 오면 폴더째 없어진다. 오전권 · 오후권 · 주간권 · 종일권의 값은 체험 값이다(plan §8 D5).
// 끝에 확정 창(V4)의 결제 칸 · 결제 수단 · 할인(체험 값)이 있다.
import type { ConditionKey, DraftItem } from '@skinote/contract';
import type { FxMethodKey, FxSection, FxShopRules, FxTracking } from './model.ts';

/** 상품 하나(스키 · 야간권 성인 …). 새 접수의 초안 품목(DraftItem.productKey)과 접수 줄의 kind가 이 key다. */
export interface FxProduct {
  key: string;
  /** 종류 타일(FxKind.key). */
  kindKey: string;
  /** 접수증 · 선택 품목의 이름('야간권 성인'). */
  label: string;
  /** 장부 품목 칸 · 권종 버튼의 짧은 이름('야간권'). */
  shortLabel?: string;
  /** 수량 단위('매'). 권(매)만 가진다: '6개 · 3매'처럼 개로 세는 장비와 따로 센다. */
  unit?: string;
  /** 1일 값(원). */
  price: number;
  section: FxSection;
  /** 돌려받는 품목. 리프트권은 목록 값이 아니라 운영 규칙(liftReturnPolicy)에서 줄을 만들 때 복사한다. */
  returnable: boolean;
  capabilities: ConditionKey[];
  /** 재고 방식(catalog 2): 번호로 하나씩(unit) · 수량(count, 고글). */
  tracking: FxTracking;
  /** 세는 말(스키 · 보드 '대', 의류 '벌', 헬멧 · 부츠 · 고글 '개', 권 '매'). */
  countWord: string;
  /** 함께 나가는 것(선택 품목 둘째 줄 '부츠 · 폴 포함'). */
  includes?: string;
  /** 권종의 사용 창 끝 = 반납 시각의 처음 값(매장 설정 반납 타임의 key, catalog 11). */
  returnSlotKey?: string;
}

/** 규격 하나(의류 100, 헬멧 중). label은 버튼 글, name은 줄 2의 이름표 · 선택 품목 둘째 줄('사이즈 100' · '중 사이즈'). */
export interface FxVariant {
  key: string;
  label: string;
  name: string;
}

/** 종류 타일 하나. tile은 상품 하나 + 규격 축, grouped는 상품(권종) 여럿을 한 타일에서 고른다(catalog 2 · 11). */
export interface FxKind {
  key: string;
  label: string;
  placement: 'tile' | 'grouped';
  /** 이 종류의 상품(차례대로). tile은 하나. */
  products: string[];
  /** 규격 축의 이름('사이즈' · '규격'), grouped는 '권종'. 없으면 규격 없이 수량만. */
  axis?: string;
  variants?: FxVariant[];
  /** 규격이 한 줄에 다 들어가지 않을 때의 끝 칸(부츠 `규격 더 보기`). */
  moreLabel?: string;
}

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
  { key: 'boots', label: '부츠', placement: 'tile', products: ['boots'], axis: '사이즈', variants: sizes(BOOTS, numbered), moreLabel: '규격 더 보기' },
  { key: 'clothes', label: '의류', placement: 'tile', products: ['clothes'], axis: '사이즈', variants: sizes(['90', '95', '100', '105', '110'], numbered) },
  // 헬멧 줄의 둘째 줄은 '중 사이즈'('사이즈 중'은 '사이즈 재는 중'으로 읽힘, 문구 표 3-6).
  { key: 'helmet', label: '헬멧', placement: 'tile', products: ['helmet'], axis: '사이즈', variants: sizes(['소', '중', '대'], (l) => l + ' 사이즈') },
  { key: 'goggles', label: '고글', placement: 'tile', products: ['goggles'], axis: '규격', variants: sizes(['어른', '어린이'], (l) => l) },
  { key: 'lift', label: '리프트권', placement: 'grouped', products: ['morning_adult', 'afternoon_adult', 'night_adult', 'day_adult', 'full_adult'], axis: '권종' },
];

/** 한 초안 품목의 수 한도(체험 값). */
export const MAX_QTY = 20;

export const productOf = (key: string | undefined): FxProduct | undefined => (key ? PRODUCTS[key] : undefined);
export const kindOf = (key: string | undefined): FxKind | undefined => KINDS.find((k) => k.key === key);
export const variantOf = (kind: FxKind | undefined, key: string | undefined): FxVariant | undefined => kind?.variants?.find((v) => v.key === key);

/**
 * 줄 이름을 두 줄로(반납 창 · 부분 결제 판): 윗줄은 상품 이름('헬멧'), 둘째 줄의 앞에 규격 이름('중 사이즈' · '사이즈 95'). 규격이 없는
 * 줄(체험 자료의 옛 줄 · 권)은 줄 이름 그대로.
 */
export function lineNames(l: { label: string; productKey?: string; variantKey?: string }): { name: string; variant?: string } {
  const product = productOf(l.productKey);
  const variant = variantOf(kindOf(product?.kindKey), l.variantKey);
  return product && variant ? { name: product.label, variant: variant.name } : { name: l.label };
}

/** 알맞은 초안 품목만(아는 상품 · 그 종류의 규격, 수 1 ~ 한도), 같은 상품 · 규격은 합친다. 차례는 들어온 차례. */
export function cleanItems(items: readonly DraftItem[]): DraftItem[] {
  const out: DraftItem[] = [];
  for (const item of items) {
    const product = productOf(item.productKey);
    if (!product) continue;
    const kind = kindOf(product.kindKey);
    const needsVariant = kind?.placement === 'tile' && kind.variants !== undefined;
    if (needsVariant ? !variantOf(kind, item.variantKey) : item.variantKey !== undefined) continue;
    const quantity = Math.floor(item.quantity);
    if (!(quantity > 0)) continue;
    const same = out.find((x) => x.productKey === item.productKey && x.variantKey === item.variantKey);
    if (same) same.quantity = Math.min(MAX_QTY, same.quantity + quantity);
    else out.push({ productKey: item.productKey, ...(item.variantKey !== undefined ? { variantKey: item.variantKey } : {}), quantity: Math.min(MAX_QTY, quantity) });
  }
  return out;
}

/** 견적 한 줄(상품 · 규격 · 수 · 값). */
export interface QuoteLine {
  item: DraftItem;
  product: FxProduct;
  amount: number;
}

/** 요금표 견적(서버와 같은 계산, catalog 8): 장비 · 리프트권 합, 보증금(합계에 넣지 않음), quoteHash. */
export interface Quote {
  lines: QuoteLine[];
  /** 대여 날 수(수령 영업일부터 반납 영업일까지, 1 이상). 장비는 1일 값 × 수 × 날, 리프트권은 하루권이라 날과 상관없다. */
  days: number;
  gear: number;
  lift: number;
  total: number;
  /** 리프트권 보증금(매장 기준 1매 값 × 권 매수). 보증금을 쓰지 않는 매장은 0. */
  depositUnits: number;
  deposit: number;
  depositUnitAmount: number;
  hash: string;
}

/**
 * 초안 품목의 견적(catalog 8 · price_rule_tiers를 체험 값으로 줄임): 장비는 1일 값 × 수 × 대여 날 수, 리프트권은 1매 값 × 수(할인은 V4의
 * 할인 적용). 보증금은 돌려받는 리프트권에만(반납 선택 매장의 권은 돌아올 수 없어 보증금이 없다, catalog 11-1).
 */
export function quoteOf(items: readonly DraftItem[], rules: Pick<FxShopRules, 'liftDeposit' | 'liftReturnPolicy'>, days = 1): Quote {
  const span = Math.max(1, Math.floor(days) || 1);
  const lines = cleanItems(items).map((item) => {
    const product = productOf(item.productKey)!;
    return { item, product, amount: product.price * item.quantity * (product.section === 'gear' ? span : 1) };
  });
  const sum = (section: FxSection) => lines.filter((l) => l.product.section === section).reduce((n, l) => n + l.amount, 0);
  const gear = sum('gear');
  const lift = sum('lift');
  const rule = rules.liftReturnPolicy === 'required' ? rules.liftDeposit : null;
  const depositUnits = rule ? lines.filter((l) => l.product.section === rule.section).reduce((n, l) => n + l.item.quantity, 0) : 0;
  const depositUnitAmount = rule?.unitAmount ?? 0;
  const hash = lines.length
    ? 'quote:' + lines.map((l) => l.item.productKey + (l.item.variantKey ? '/' + l.item.variantKey : '') + 'x' + l.item.quantity + '=' + l.amount).join(',') + ':n' + span + ':d' + depositUnits * depositUnitAmount
    : '';
  return { lines, days: span, gear, lift, total: gear + lift, depositUnits, deposit: depositUnits * depositUnitAmount, depositUnitAmount, hash };
}

// ── 결제 칸 · 결제 수단 · 할인(V4 접수 확정 창, catalog 9 · 15 · spec 2-3) ─────────────────────────────

/** 돈 수단(payment_methods). quick = 확정 창의 버튼, 나머지는 `기타` 판. */
export interface FxPayMethod {
  key: FxMethodKey;
  label: string;
  quick: boolean;
}

export const PAY_METHODS: readonly FxPayMethod[] = [
  { key: 'card', label: '카드', quick: true },
  { key: 'cash', label: '현금', quick: true },
  { key: 'transfer', label: '계좌이체', quick: true },
  { key: 'easy_pay', label: '간편결제', quick: false },
  { key: 'voucher', label: '상품권', quick: false },
];

export const payMethodOf = (key: string | undefined): FxPayMethod | undefined => PAY_METHODS.find((m) => m.key === key);

/** 결제 칸(payment_sections): 칸 이름과 기본 수단(장비 카드 · 리프트권 현금, spec 2-3). 보증금 칸은 보증금 규칙에서 온다. */
export interface FxPaySection {
  key: FxSection;
  label: string;
  defaultMethod: FxMethodKey;
}

export const PAY_SECTIONS: readonly FxPaySection[] = [
  { key: 'gear', label: '장비', defaultMethod: 'card' },
  { key: 'lift', label: '리프트권', defaultMethod: 'cash' },
];

/** 할인 하나(discount_rules): 묶음(결제 칸)마다 하나만 고른다(catalog 9). 체험 값은 두 묶음의 10% 하나(plan §8 D39). */
export interface FxDiscount {
  key: string;
  label: string;
  percent: number;
  sections: readonly FxSection[];
}

export const DISCOUNTS: readonly FxDiscount[] = [
  { key: 'ten_percent', label: '10% 할인', percent: 10, sections: ['gear', 'lift'] },
];

export const discountOf = (key: string | undefined, section: FxSection): FxDiscount | undefined =>
  DISCOUNTS.find((d) => d.key === key && d.sections.includes(section));

/** 할인 금액: 칸 합계의 비율, 10원 단위로 내림(catalog 9). */
export const discountAmount = (gross: number, discount: FxDiscount | undefined): number =>
  discount ? Math.floor((gross * discount.percent) / 100 / 10) * 10 : 0;

/**
 * 할인을 칸 안 줄들에 나눈다(catalog 9: 총액 비율, 줄마다 10원 단위로 내리고 남은 끝전은 큰 줄부터 10원씩). 줄 값 − 몫을 돌려준다.
 */
export function discountedAmounts(amounts: readonly number[], discount: number): number[] {
  const gross = amounts.reduce((sum, a) => sum + a, 0);
  if (discount <= 0 || gross <= 0) return [...amounts];
  const shares = amounts.map((a) => Math.floor((discount * a) / gross / 10) * 10);
  let rest = discount - shares.reduce((sum, s) => sum + s, 0);
  const order = amounts.map((a, i) => ({ a, i })).sort((x, y) => y.a - x.a || x.i - y.i);
  for (let k = 0; rest > 0 && k < order.length * 1000; k += 1) {
    const { i } = order[k % order.length]!;
    shares[i] = (shares[i] ?? 0) + 10;
    rest -= 10;
  }
  return amounts.map((a, i) => a - (shares[i] ?? 0));
}

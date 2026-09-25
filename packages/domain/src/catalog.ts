// 품목 목록의 형식과 셈(catalog 2 · 4 · 5 · 8 · 9 · 11 · 15, spec 2-3): 종류 타일(item_kinds의 picker_placement · 이름 · 순서), 상품과
// 1일 값, 규격 축(item_kind_attributes usage variant_axis), 리프트권 권종(ticket_products)과 그 사용 창의 끝(반납 시각의 처음 값),
// 재고 방식, 결제 칸 · 결제 수단 · 할인. 값은 매장 목록(ShopState.registry)에 있다: 견본 값은 sample/registry.ts.
// 새 접수(V2 · V3)의 읽기 모델(order-draft.ts)과 처음 자료가 같은 목록을 쓴다.
// 화면은 종류 이름을 비교하지 않는다: 타일 · 규격 버튼 · 줄 글은 이 목록에서 읽기 모델이 만든다(ADR-05).
import type { ConditionKey, DraftItem } from '@skinote/contract';
import type { FxMethodKey, FxSection, FxShopRules, FxTracking, ShopRegistry } from './model.ts';

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
}

/**
 * 규격 버튼이 한 줄에 다 들어가지 않는 종류(부츠 220 ~ 300)의 끝 칸 이름. 규격이 이보다 많으면 끝 칸이 `규격 더 보기 ›`가 되어 모든
 * 규격의 작은 창을 연다(spec 3-4). 적으면 같은 줄의 `더 보기`.
 */
export const VARIANT_SHEET_AFTER = 8;
export const MORE_VARIANTS = '규격 더 보기';
export const moreLabelOf = (kind: Pick<FxKind, 'variants'>): string | undefined => ((kind.variants?.length ?? 0) > VARIANT_SHEET_AFTER ? MORE_VARIANTS : undefined);

type Products = Pick<ShopRegistry, 'products'>;
type Kinds = Pick<ShopRegistry, 'kinds'>;

export const productOf = (reg: Products, key: string | undefined): FxProduct | undefined => (key ? reg.products[key] : undefined);
export const kindOf = (reg: Kinds, key: string | undefined): FxKind | undefined => reg.kinds.find((k) => k.key === key);
export const variantOf = (kind: FxKind | undefined, key: string | undefined): FxVariant | undefined => kind?.variants?.find((v) => v.key === key);

/**
 * 줄 이름을 두 줄로(반납 창 · 부분 결제 판): 윗줄은 상품 이름('헬멧'), 둘째 줄의 앞에 규격 이름('중 사이즈' · '사이즈 95'). 규격이 없는
 * 줄(옛 줄 · 권)은 줄 이름 그대로.
 */
export function lineNames(reg: Products & Kinds, l: { label: string; productKey?: string; variantKey?: string }): { name: string; variant?: string } {
  const product = productOf(reg, l.productKey);
  const variant = variantOf(kindOf(reg, product?.kindKey), l.variantKey);
  return product && variant ? { name: product.label, variant: variant.name } : { name: l.label };
}

/** 알맞은 초안 품목만(아는 상품 · 그 종류의 규격, 수 1 ~ 한도), 같은 상품 · 규격은 합친다. 차례는 들어온 차례. */
export function cleanItems(reg: Products & Kinds & Pick<ShopRegistry, 'maxLineQuantity'>, items: readonly DraftItem[]): DraftItem[] {
  const MAX_QTY = reg.maxLineQuantity;
  const out: DraftItem[] = [];
  for (const item of items) {
    const product = productOf(reg, item.productKey);
    if (!product) continue;
    const kind = kindOf(reg, product.kindKey);
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
 * 초안 품목의 견적(catalog 8 · price_rule_tiers를 1일 값으로 줄임): 장비는 1일 값 × 수 × 대여 날 수, 리프트권은 1매 값 × 수(할인은 V4의
 * 할인 적용). 보증금은 돌려받는 리프트권에만(반납 선택 매장의 권은 돌아올 수 없어 보증금이 없다, catalog 11-1).
 */
export function quoteOf(
  reg: Products & Kinds & Pick<ShopRegistry, 'maxLineQuantity'>, items: readonly DraftItem[], rules: Pick<FxShopRules, 'liftDeposit' | 'liftReturnPolicy'>, days = 1,
): Quote {
  const span = Math.max(1, Math.floor(days) || 1);
  const lines = cleanItems(reg, items).map((item) => {
    const product = productOf(reg, item.productKey)!;
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

export const payMethodOf = (reg: Pick<ShopRegistry, 'payMethods'>, key: string | undefined): FxPayMethod | undefined => reg.payMethods.find((m) => m.key === key);

/** 결제 칸(payment_sections): 칸 이름과 기본 수단(장비 카드 · 리프트권 현금, spec 2-3). 보증금 칸은 보증금 규칙에서 온다. */
export interface FxPaySection {
  key: FxSection;
  label: string;
  defaultMethod: FxMethodKey;
}

/** 할인 하나(discount_rules): 묶음(결제 칸)마다 하나만 고른다(catalog 9). */
export interface FxDiscount {
  key: string;
  label: string;
  percent: number;
  sections: readonly FxSection[];
}

export const discountOf = (reg: Pick<ShopRegistry, 'discounts'>, key: string | undefined, section: FxSection): FxDiscount | undefined =>
  reg.discounts.find((d) => d.key === key && d.sections.includes(section));

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

/**
 * 리프트권 줄을 돌려받는지(item_kinds.return_policy_key를 운영 규칙에서 복사, catalog 11). 줄을 만들 때 한 번 복사하고,
 * 규칙을 바꾸면(V8) 다음에 만드는 줄부터다. 반납 선택(optional)은 반납이 끝남의 조건이 아니라 반납 칸이 없다.
 */
export const liftReturnable = (rules: Pick<FxShopRules, 'liftReturnPolicy'>) => rules.liftReturnPolicy === 'required';

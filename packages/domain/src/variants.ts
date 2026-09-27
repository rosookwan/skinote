// 수량으로 세는 규격 줄의 자리마다 지금 규격(즉시 교환 뒤, work/impl-features-1/plan.md §7-1 splitByVariants). 줄의 수(qty)만큼 자리가 있고 자리
// 차례가 지급 차례다: 지급 · 배달은 자리 0부터(차에 실은 것은 지급 뒤의 자리), 반납 · 수거도 먼저 나간 자리부터(FIFO). 처음에는 모든 자리가 접수 때
// 규격(variantKey)이고, 교환(FxSwap)은 그때의 첫 자리(base)부터 옛 규격 자리를 차례로 새 규격으로 바꾼다(held: 손님에게 있는 자리, planned: 매장에
// 있는 지급 전 자리). 이 한 셈을 읽기 모델(접수증 · 반납 창 · 기사 업무 판 · 교환 창)과 저장소(이동 줄의 규격)가 함께 써서, 재고의 규격 수가 이동과
// 맞고 기사가 손님이 가진 사이즈를 본다. 교환이 없는 줄은 이 셈을 쓰지 않는다(지금까지와 같은 한 규격).
// 이 파일은 model · catalog · promises(liveQty)만 가져온다(rules.ts가 조건 셈에 쓴다).
import { kindOf, lineNames, productOf, variantOf, type FxKind, type FxProduct } from './catalog.ts';
import type { FxLine, FxSwap, ShopRegistry } from './model.ts';
import { liveQty } from './promises.ts';

/** 규격 한 조각(규격 key · 수). */
export interface VariantPart {
  key: string;
  quantity: number;
}

/** 돌아온 수(매장 반납 + 차량 수거). */
export const backOf = (l: Pick<FxLine, 'returned' | 'collected'>): number => l.returned + l.collected;

/** 차에 실려 아직 건네지 않은 수(내려놓은 것 뺌, rules.ts vanLoaded와 같은 셈). */
export const vanOf = (l: Pick<FxLine, 'loaded' | 'issued' | 'unloaded'>): number => Math.max(0, Math.max(l.loaded, l.issued) - l.issued - (l.unloaded ?? 0));

/** 매장에 있는 지급 전 수(살아 있는 수 − 지급 − 차에 실린 것). planned 교환이 닿는 수. */
export const plannedInShop = (l: FxLine): number => Math.max(0, liveQty(l) - l.issued - vanOf(l));

/** 손님에게 있는 수(지급 − 돌아온 것). held 교환이 닿는 수. */
export const heldQty = (l: FxLine): number => Math.max(0, l.issued - backOf(l));

/** 교환한 줄인지(교환 기록이 있음). 없으면 모든 자리가 접수 때 규격이다. */
export const hasSwaps = (l: Pick<FxLine, 'swaps'>): boolean => (l.swaps?.length ?? 0) > 0;

/** 이 교환이 닿는 첫 자리(지금 줄 셈으로): held = 돌아온 수, planned = 지급 + 차에 실린 수. 명령이 교환을 적을 때 쓴다. */
export const swapBase = (l: FxLine, planned: boolean): number => (planned ? l.issued + vanOf(l) : backOf(l));

/** 자리마다 지금 규격(길이 = qty). 접수 때 규격이 없는 줄은 빈 목록(교환할 수 없다). */
export function slotVariants(l: Pick<FxLine, 'qty' | 'variantKey' | 'swaps'>): string[] {
  if (l.variantKey === undefined) return [];
  const slots = Array.from({ length: Math.max(0, l.qty) }, () => l.variantKey!);
  for (const s of l.swaps ?? []) applySwap(slots, s);
  return slots;
}

function applySwap(slots: string[], s: FxSwap): void {
  let left = s.quantity;
  for (let i = Math.max(0, s.base); i < slots.length && left > 0; i += 1) {
    if (slots[i] !== s.from) continue;
    slots[i] = s.to;
    left -= 1;
  }
}

/** 자리 [start, start + count)의 규격 조각(처음 나온 차례, 같은 규격은 합침). 줄의 자리를 넘으면 접수 때 규격으로 센다. */
export function variantRange(l: Pick<FxLine, 'qty' | 'variantKey' | 'swaps'>, start: number, count: number): VariantPart[] {
  if (count <= 0) return [];
  const slots = slotVariants(l);
  const out: VariantPart[] = [];
  for (let i = Math.max(0, start); i < Math.max(0, start) + count; i += 1) {
    const key = slots[i] ?? l.variantKey ?? '';
    const same = out.find((x) => x.key === key);
    if (same) same.quantity += 1;
    else out.push({ key, quantity: 1 });
  }
  return out;
}

/** 손님에게 있는 것의 규격(먼저 나간 자리부터 돌아오므로 [돌아온 수, 지급)). */
export const heldVariants = (l: FxLine): VariantPart[] => variantRange(l, backOf(l), heldQty(l));

/** 매장에 있는 지급 전 것의 규격(차에 실린 자리 뒤). */
export const plannedVariants = (l: FxLine): VariantPart[] => variantRange(l, l.issued + vanOf(l), plannedInShop(l));

/** 줄 전체의 지금 규격(나간 것 + 살아 있는 지급 전 것, 접수증 줄 이름). */
export const lineVariants = (l: FxLine): VariantPart[] => variantRange(l, 0, Math.max(liveQty(l), l.issued));

// ── 교환할 수 있는 줄(조건 exchangeable, plan §7-1) ─────────────────────────────

type Catalog = Pick<ShopRegistry, 'products' | 'kinds'>;

/** 줄의 상품 · 종류(접수 줄의 상품 key가 없는 옛 줄은 kind가 상품 key다). */
export function lineKind(reg: Catalog, l: Pick<FxLine, 'productKey' | 'kind'>): { product: FxProduct; kind: FxKind } | null {
  const product = productOf(reg, l.productKey ?? l.kind);
  const kind = kindOf(reg, product?.kindKey);
  return product && kind ? { product, kind } : null;
}

/**
 * 즉시 교환이 될 수 있는 줄의 모양(수가 남았는지는 보지 않음): 수량으로 세고, 접수 때 규격이 있고, 종류가 교환 가능(능력 exchangeable)이며 규격이
 * 둘 이상인 타일(사이즈가 있는 장비). 번호로 세는 줄 · 규격 없는 스키 · 보드 · 리프트권은 아니다.
 */
export function swapKind(reg: Catalog, l: FxLine): { product: FxProduct; kind: FxKind } | null {
  if ((l.tracking ?? 'unit') !== 'count' || l.variantKey === undefined || !l.capabilities.includes('exchangeable')) return null;
  const found = lineKind(reg, l);
  if (!found || found.kind.placement !== 'tile' || (found.kind.variants?.length ?? 0) < 2 || !variantOf(found.kind, l.variantKey)) return null;
  return found;
}

/** 지금 교환할 것이 있는 줄(손님에게 있는 것 또는 매장의 지급 전 것). 접수증 옆 동작 `즉시 교환`의 조건(exchangeable). */
export const lineCanSwap = (reg: Catalog, l: FxLine): boolean => swapKind(reg, l) !== null && (heldQty(l) > 0 || plannedInShop(l) > 0);

/** 규격 조각의 글: 하나면 `대 사이즈`, 여럿이면 `중 사이즈 1 · 대 사이즈 1`(규격 이름은 매장 목록의 이름). */
export function variantPartsText(reg: Catalog, l: Pick<FxLine, 'productKey' | 'kind'>, parts: readonly VariantPart[]): string {
  const kind = lineKind(reg, l)?.kind;
  const name = (key: string) => variantOf(kind, key)?.name ?? key;
  if (parts.length === 1) return name(parts[0]!.key);
  return parts.map((p) => name(p.key) + ' ' + p.quantity).join(' · ');
}

/** 교환한 줄의 지금 이름(`헬멧 대 사이즈` · `헬멧 중 사이즈 1 · 대 사이즈 1`). 교환하지 않은 줄 · 조각이 없으면 undefined(줄 이름 그대로). */
export function swappedLabel(reg: Catalog, l: FxLine, parts: readonly VariantPart[]): string | undefined {
  if (!hasSwaps(l) || parts.length === 0) return undefined;
  const found = lineKind(reg, l);
  return found ? found.product.label + ' ' + variantPartsText(reg, l, parts) : undefined;
}

/** 창 줄이 가리키는 쪽: 지급 · 적재 · 배달은 지급 전 것(pending), 수거 · 반납은 손님에게 있는 것(held). */
export type SizePhase = 'pending' | 'held';

/**
 * 창 줄의 이름(`헬멧` / `중 사이즈`): 즉시 교환한 줄은 그 쪽의 지금 사이즈(`대 사이즈` · `중 사이즈 1 · 대 사이즈 1`), 아니면 접수 때 사이즈
 * (catalog lineNames).
 */
export function namesNow(reg: Catalog, l: FxLine, phase: SizePhase): { name: string; variant?: string } {
  if (!hasSwaps(l)) return lineNames(reg, l);
  const parts = phase === 'held' ? heldVariants(l) : variantRange(l, l.issued, Math.max(0, liveQty(l) - l.issued));
  const found = lineKind(reg, l);
  if (!found || parts.length === 0) return lineNames(reg, l);
  return { name: found.product.label, variant: variantPartsText(reg, l, parts) };
}

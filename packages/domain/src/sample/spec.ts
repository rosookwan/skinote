// 견본 매장의 명세(sampleSpec)와 직원 예시(SAMPLE_STAFF). 서버의 `provision --sample`과 시험이 쓴다. 직원 이름은 예시이고 실제
// 사람이 아니다(실제 매장의 직원 이름은 저장소에 두지 않고 서버로 보내는 JSON에만 둔다, plan §13).
// 첫 매장(기본): 번호가 없어 모든 상품의 처음 재고가 수량이다(규격마다, 규격 없는 상품은 빈 key ''). 1호 차량 예비권은 야간권 6매(수량).
// 번호 매장 모양(shop 'numbered'): 번호 범위 · 차량 예비권 번호(고글만 수량).
import type { ShopSpec, StaffSpec } from '../spec.ts';
import { NUMBERED_PRODUCTS, sampleRegistry, SHOP_NAME, type SampleShop } from './registry.ts';
import { DRAWERS, STOCK_NUMBERS, VAN_SPARE, sampleRules } from './seed.ts';

/**
 * 번호 매장 모양의 시험 매장 번호 재고: 견본 하루의 번호(STOCK_NUMBERS)를 모두 담고, 장비와 야간권이 아닌 권은 더 넉넉하다(견본 하루를
 * 여러 날짜로 넣어도 앞 날짜의 팀이 가진 번호와 겹치지 않게, load-sample). 야간권은 1호 차량 예비권(51 ~ 56번) 앞에서 끝난다.
 */
const SPEC_STOCK_NUMBERS: Readonly<Record<string, readonly [number, number]>> = {
  ...STOCK_NUMBERS,
  ski: [1, 120], board: [1, 60], boots: [1, 120], helmet: [1, 90], clothes: [1, 120],
  morning_adult: [101, 160], afternoon_adult: [201, 260], day_adult: [301, 360], full_adult: [401, 460],
};

/** 규격 없는 상품의 수량 재고 key(ShopSpec.stock.counts의 규격 key). */
export const NO_VARIANT = '';

/**
 * 첫 매장의 처음 수량 재고(견본 값): 상품 → 규격 → 수. 번호 매장의 번호 수와 같은 규모다(견본 하루를 여러 날짜로 넣어도 모자라지 않게).
 * 규격이 있는 상품은 규격마다 고르게 나눈다(부츠 17 규격 · 의류 5 · 헬멧 3), 고글은 전과 같다.
 */
const TOTALS: Readonly<Record<string, number>> = {
  ski: 120, board: 60, boots: 119, clothes: 120, helmet: 90, morning_adult: 60, afternoon_adult: 60, night_adult: 60, day_adult: 60, full_adult: 60,
};
const GOGGLES: Readonly<Record<string, number>> = { 어른: 30, 어린이: 20 };

/** 그 모양의 처음 수량 재고. */
function countsOf(shop: SampleShop): Record<string, Record<string, number>> {
  const reg = sampleRegistry(shop);
  const out: Record<string, Record<string, number>> = { goggles: { ...GOGGLES } };
  if (shop === 'numbered') return out;
  for (const [key, total] of Object.entries(TOTALS)) {
    const variants = reg.kinds.find((k) => k.key === reg.products[key]?.kindKey)?.variants ?? [];
    out[key] = variants.length
      ? Object.fromEntries(variants.map((v) => [v.key, Math.floor(total / variants.length)]))
      : { [NO_VARIANT]: total };
  }
  return out;
}

/** 직원 예시(관리자 · 카운터 · 1호 차량 기사). 체험판의 미리 보기 화면(로그인 타일)도 이 이름을 쓴다. */
export const SAMPLE_STAFF: readonly StaffSpec[] = [
  { name: '한가람', role: 'manager' },
  { name: '오세린', role: 'counter' },
  { name: '문태오', role: 'driver', vehicleKey: 'v1' },
];

/** 견본 매장의 명세(새 사본). 시즌은 견본 값이다. shop: 첫 매장(기본) · 번호 매장. */
export function sampleSpec(shop: SampleShop = 'first'): ShopSpec {
  const settings = sampleRules(shop);
  const numbered = shop === 'numbered';
  return {
    shop: { code: 'sample', name: SHOP_NAME, cutoff: settings.businessDayCutoff, timezone: 'Asia/Seoul' },
    staff: SAMPLE_STAFF.map((s) => ({ ...s })),
    registry: sampleRegistry(shop),
    settings,
    drawers: DRAWERS.map((d) => ({ ...d })),
    stock: {
      numbers: numbered
        ? Object.fromEntries(Object.entries(SPEC_STOCK_NUMBERS).filter(([key]) => NUMBERED_PRODUCTS.includes(key)).map(([key, [from, to]]) => [key, [from, to] as const]))
        : {},
      counts: countsOf(shop),
      vehicleSpares: numbered ? [{ vehicleId: VAN_SPARE.vehicleId, productKey: VAN_SPARE.kind, numbers: [...VAN_SPARE.numbers] }] : [],
      vehicleCounts: numbered ? [] : [{ vehicleId: VAN_SPARE.vehicleId, productKey: VAN_SPARE.kind, quantity: VAN_SPARE.quantity }],
    },
    season: { from: '2026-12-01', to: '2027-03-31' },
  };
}

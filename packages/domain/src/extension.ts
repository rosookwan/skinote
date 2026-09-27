// 연장 값의 셈(catalog 14 · features-1 E5 개정 2026-09-27): 일정 변경의 연장 · 연장 취소와 품목 취소의 값이 같은 셈을 쓴다.
//   - 1일 값은 그 줄을 만들 때의 값(FxLine.dayPrice: 접수 · 품목 추가 때의 요금표 값)이다. 그 뒤에 요금을 바꿔도 이미 받은 접수의 연장 값은
//     움직이지 않는다(매장 설정 `요금 · 할인`의 약속). 값이 없는 옛 줄 · 견본 줄은 지금 요금표 값, 목록에 없으면 줄 값 ÷ 수.
//   - 늘어난 날은 일정 몫(bucket)마다 원래 반납일(o.giveBack)보다 늦은 날이다. 일정 변경은 옮기는 수마다 (새 날 − 옛 날) × 1일 값만 적고
//     (promise-sheet.ts extensionOf), 품목 취소는 취소한 수가 나온 일정 몫의 늘어난 날만 뺀다(order-edit.ts cancelPlan). 그래서 취소 조정 ·
//     환불 없음이 연장 셈에 섞이지 않는다.
import { productOf } from './catalog.ts';
import type { FxLine, FxOrder, FxPromise, ShopRegistry, ShopState } from './model.ts';
import { lineBuckets, liveQty } from './promises.ts';
import { businessDateOf, shopCutoff } from './time.ts';

const DAY = 86_400_000;

const dayDiff = (a: string, b: string) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / DAY);

/** 연장에 쓰는 1일 값: 줄을 만들 때의 값(dayPrice), 없으면 지금 요금표 값, 목록에 없는 옛 줄은 줄 값 ÷ 수. */
export const lineDayPrice = (reg: Pick<ShopRegistry, 'products'>, l: FxLine): number =>
  l.dayPrice ?? productOf(reg, l.productKey ?? l.kind)?.price ?? (l.qty > 0 ? l.amount / l.qty : 0);

/** 일정 하나가 원래 반납일보다 늦은 날(원래 반납일 · 그 앞이면 0). */
export function extraDays(state: ShopState, o: FxOrder, promise: Pick<FxPromise, 'at'>): number {
  const cutoff = shopCutoff(state.settings);
  return Math.max(0, dayDiff(businessDateOf(promise.at, cutoff), businessDateOf(o.giveBack.at, cutoff)));
}

/**
 * 취소할 수 q가 나온 일정 몫들의 늘어난 날의 합(수 × 날). 취소는 지급 전의 수부터(원래 일정 → 나눈 일정은 늦게 만든 것부터: 취소 뒤의 일정 줄이기
 * shrinkSplits와 같은 차례), 그다음 돌아온 수(원래 일정 → 나눈 일정은 만든 차례, 앞 취소가 쓴 돌아온 수는 건너뜀)에서 나온 것으로 센다.
 */
export function cancelExtensionDays(state: ShopState, o: FxOrder, l: FxLine, q: number): number {
  if (l.section === 'lift' || q <= 0) return 0;
  const buckets = lineBuckets(o, l);
  const live = liveQty(l);
  let rest = q;
  let days = 0;
  let unissued = Math.max(0, live - l.issued);
  for (const b of [buckets[0]!, ...buckets.slice(1).reverse()]) {
    if (rest <= 0 || unissued <= 0) break;
    const n = Math.min(rest, unissued, Math.max(0, b.planned - b.issued));
    if (n <= 0) continue;
    days += n * extraDays(state, o, b.promise);
    rest -= n;
    unissued -= n;
  }
  // 앞 취소가 쓴 돌아온 수(내준 수 − 살아 있는 수).
  let dead = Math.max(0, l.issued - live);
  for (const b of buckets) {
    if (rest <= 0) break;
    let back = b.returned + b.collected;
    const skip = Math.min(dead, back);
    dead -= skip;
    back -= skip;
    const n = Math.min(rest, back);
    if (n <= 0) continue;
    days += n * extraDays(state, o, b.promise);
    rest -= n;
  }
  return days;
}

// 접수 · 줄의 기본 규칙(돈 · 물건 · 다음 약속 · 늦음 · 능력 · 차량 수거 경로). 읽기 모델(views.ts · stamps.ts)과 명령 처리기가 쓴다.
// 화면(부품 · 화면 틀)은 이 규칙을 부르지 않는다 — 읽기 모델만 받는다(ADR-05).
import type { ConditionKey } from '@skinote/contract';
import type { FxArea, FxCancellation, FxCharge, FxLine, FxOrder, FxPin, FxPromise, FxReturnSlot, FxShopRules, FxVisitOutcome, ShopRegistry, ShopState } from './model.ts';
import { collectTaskIdOf, currentReturn, findTask, liveQty, orderTasks, returnQty, taskOrder, type FxTask } from './promises.ts';

export { liveQty, returnQty } from './promises.ts';
import { HOUR, MINUTE, bizHm, hm, kstAt, minutesOf, onBizDay, type BizDay, shopCutoff } from './time.ts';
import { lineCanSwap } from './variants.ts';

/** 매장 반납은 약속 30분 뒤, 차량 수거는 60분 뒤부터 늦음(빨강). 차량의 여유는 매장 설정(vehicleLate)이 있으면 그 값이다. */
export const LATE_AFTER_STORE = 30 * MINUTE;
export const LATE_AFTER_VEHICLE = 60 * MINUTE;
/** 야간 수거 준비 안내는 그 반납 타임 60분 전부터(ui 6-1). 매장 설정(nightNoticeMinutes)이 있으면 그 값이다. */
export const NIGHT_PREP_BEFORE = HOUR;

/** 야간 반납 타임인지(return_slots.is_night: 더할 때 20:00 이후면 야간, 시각을 바꿔도 그대로). 옛 자료는 20시 이후. */
export const isNightSlot = (s: FxReturnSlot) => s.night ?? s.hour >= 20;

/**
 * 야간이 시작하는 영업일 안 분: 야간 반납 타임(숨긴 것 포함) 중 가장 이른 시각. 반납 타임의 시각을 늦춰도 그 타임이 가졌던 가장 이른 시각
 * (earliest)까지 본다 — 22:00을 22:30으로 바꿔도 이미 22:00에 잡은 접수의 늦음(빨강)이 움직이지 않게(features-1 plan E12). 없으면 undefined.
 */
function nightStartMinutes(settings: Pick<FxShopRules, 'returnSlots'>): number | undefined {
  const night = settings.returnSlots.filter(isNightSlot).map((s) => Math.min(s.hour * 60 + s.minute, s.earliest ? s.earliest.hour * 60 + s.earliest.minute : Infinity));
  return night.length ? Math.min(...night) : undefined;
}

// ── 고르기의 목록(숨긴 행 · 사용 종료한 차량 빼고, 지금 값은 남김, plan E12) ─────────────────────

/** 고를 수 있는 반납 타임(숨김 뺌). keep은 지금 고른 것(숨겼어도 남긴다). */
export const activeSlots = (settings: Pick<FxShopRules, 'returnSlots'>, keep?: string) => settings.returnSlots.filter((s) => !s.hidden || s.key === keep);
/** 고를 수 있는 차량(사용 종료 뺌). keep은 지금 고른 차량. */
export const activeVehicles = (reg: Pick<ShopRegistry, 'vehicles'>, keep?: string) => reg.vehicles.filter((v) => !v.ended || v.id === keep);
/** 고를 수 있는 구역 · 장소(숨긴 구역 · 장소 뺌). keep은 지금 고른 장소(숨겼어도 그 구역과 함께 남긴다). */
export function activeAreas(reg: Pick<ShopRegistry, 'areas'>, keep?: string): FxArea[] {
  return reg.areas
    .map((a) => ({ ...a, places: a.places.filter((p) => (!a.hidden && !p.hidden) || p.id === keep) }))
    // 고를 장소가 없는 구역(막 더해 장소가 없음 · 모두 숨김)은 고르기에 두지 않는다.
    .filter((a) => a.places.length > 0);
}
/** 고를 수 있는 장소인지(숨긴 구역 · 장소가 아니거나 keep). */
export const usablePlace = (reg: Pick<ShopRegistry, 'areas'>, placeId: string | undefined, keep?: string) =>
  placeId !== undefined && activeAreas(reg, keep).some((a) => a.places.some((p) => p.id === placeId));

/**
 * 약속이 늦음(빨강)이 되기까지의 여유: 매장 30분, 차량은 매장 설정 vehicle_late_after_minutes(없으면 60분). 야간 반납 타임(첫 매장 22:00)
 * 이후의 차량 약속은 nightMinutes: 스키장이 22:00에 끝나 손님 연락이 22:30 ~ 23:00에 오는 매장은 그 시각의 수거가 늦음이 아니다(D7 답 15).
 */
export function lateAfter(settings: Pick<FxShopRules, 'returnSlots' | 'vehicleLate' | 'businessDayCutoff' | 'cutoffBefore'>, promise: Pick<FxPromise, 'at' | 'mode'>): number {
  if (promise.mode !== 'vehicle') return LATE_AFTER_STORE;
  const late = settings.vehicleLate;
  if (!late) return LATE_AFTER_VEHICLE;
  const night = nightStartMinutes(settings);
  const atNight = night !== undefined && minutesOf(bizHm(promise.at, shopCutoff(settings))) >= night;
  return (atNight ? late.nightMinutes : late.minutes) * MINUTE;
}

/** 약속의 늦음 기준 시각(약속 시각 + lateAfter). */
export const lateAtOf = (settings: Parameters<typeof lateAfter>[0], promise: Pick<FxPromise, 'at' | 'mode'>): number => promise.at + lateAfter(settings, promise);

/** 야간 수거 준비 안내를 반납 타임 몇 ms 전부터(매장 설정 night_collection_notice_minutes, 없으면 60분). */
export const nightNoticeBefore = (settings: Pick<FxShopRules, 'nightNoticeMinutes'>): number =>
  settings.nightNoticeMinutes !== undefined ? settings.nightNoticeMinutes * MINUTE : NIGHT_PREP_BEFORE;

// ── 영업일 · 반납 타임(운영 규칙 settings) ─────────────────────────────────

/** 이 매장의 지금 영업일(날짜 + 기준 시각). 오늘 · 내일 말과 도장 시각은 이것으로 가른다. */
export const bizDay = (state: ShopState): BizDay => ({ date: state.businessDate, cutoff: shopCutoff(state.settings) });

/** 반납 타임의 시각(심야 24:00은 다음 날 00:00 — 기준 시각 전이라 그 영업일의 일). */
export const slotAt = (date: string, slot: FxReturnSlot) => kstAt(date, 0, slot.hour, slot.minute);

/** 마지막 반납 타임(설정의 반납 타임 중 가장 늦은 것, 이 매장 심야 24:00). 이 시각이 지나면 장부 주 버튼이 '마감'이 된다. */
export function lastReturnSlotAt(state: ShopState, date: string): number {
  const times = state.settings.returnSlots.map((s) => slotAt(date, s));
  return times.length ? Math.max(...times) : kstAt(date, 1, 0, 0);
}

/**
 * 야간 수거 준비 안내의 반납 타임: 그날 차량 수거가 걸린 반납 타임 중 가장 늦은 것(이 매장 야간 22:00, 심야 24:00에는 차량 수거가
 * 없다). 없으면 undefined.
 */
export function nightPrepSlotAt(state: ShopState, date: string): number | undefined {
  const withVans = state.settings.returnSlots
    .map((s) => slotAt(date, s))
    .filter((at) => state.orders.some((o) => orderTasks(o).some((t) => t.promise.at === at)));
  return withVans.length ? Math.max(...withVans) : undefined;
}

/** 장소 이름: 숙소 구역이면 구역 이름을 붙인다('솔마을 한솔동'), 그 밖은 장소('설천 주차장'). 모르면 빈 글. */
export function placeLabel(reg: Pick<ShopRegistry, 'areas'>, placeId: string | undefined): string {
  for (const area of reg.areas) {
    const place = area.places.find((p) => p.id === placeId);
    if (place) return area.lodging ? area.label + ' ' + place.label : place.label;
  }
  return '';
}

/** 좁은 자리의 장소 이름: 숙소는 장소('들국화'), 그 밖은 구역('설천'). */
export function placeShortLabel(reg: Pick<ShopRegistry, 'areas'>, placeId: string | undefined): string {
  for (const area of reg.areas) {
    const place = area.places.find((p) => p.id === placeId);
    if (place) return area.lodging ? place.label : area.label;
  }
  return '';
}

export function vehicleLabel(reg: Pick<ShopRegistry, 'vehicles'>, vehicleId: string | undefined): string {
  return reg.vehicles.find((v) => v.id === vehicleId)?.label ?? '차량';
}

// ── 돈 ─────────────────────────────────────────────────────────────

/** 청구: 줄 값 + 청구 조정(일정 변경의 연장 값 · 할인 변경). */
export const charged = (o: FxOrder) => o.lines.reduce((sum, l) => sum + l.amount, 0) + (o.charges ?? []).reduce((sum, c) => sum + c.amount, 0);
/** 받은 돈(수납 · 보증금 결제 · 다른 팀이 낸 몫): 환불은 빼지 않은 합(features-1 E4). */
export const paidIn = (o: FxOrder) => o.payments.reduce((sum, p) => sum + p.amount, 0);
/** 돌려준 돈(환불 합). */
export const refunded = (o: FxOrder) => (o.refunds ?? []).reduce((sum, r) => sum + r.amount, 0);
/** 받은 돈 − 돌려준 돈(접수증 `수납`, 미수의 셈). */
export const paidTotal = (o: FxOrder) => paidIn(o) - refunded(o);
/** 이 팀 몫의 미수. */
export const ownDue = (o: FxOrder) => Math.max(0, charged(o) - paidTotal(o));
/** 청구보다 더 받은 돈(할인 · 취소 뒤, 환불 전: 확인 필요 `초과 수납`). */
export const overpaid = (o: FxOrder) => Math.max(0, paidTotal(o) - charged(o));

/** 청구 조정 한 건 중 이 줄의 몫: 연장 · 연장 취소는 그 줄의 금액, 할인 변경은 줄마다 나눈 몫. */
export const chargeOnLine = (c: FxCharge, lineId: string): number =>
  c.kind === 'discount_change' ? c.lines.reduce((sum, x) => sum + (x.lineId === lineId ? x.amount : 0), 0) : c.lineId === lineId ? c.amount : 0;

/** 수납 하나에서 아직 돌려줄 수 있는 돈(금액 − 그 수납을 가리킨 환불). 환불할 수 없는 수단(상품권)은 0(features-1 E4). */
export function refundableOf(reg: Pick<ShopRegistry, 'payMethods'>, o: FxOrder, paymentId: string): number {
  const p = o.payments.find((x) => x.id === paymentId);
  if (!p) return 0;
  const method = reg.payMethods.find((m) => m.key === p.methodKey);
  if (method?.refundable === false) return 0;
  return Math.max(0, p.amount - (o.refunds ?? []).filter((r) => r.refundOf === paymentId).reduce((sum, r) => sum + r.amount, 0));
}

export function findOrder(state: ShopState, orderId: string | undefined): FxOrder | undefined {
  return state.orders.find((o) => o.id === orderId);
}

// ── 줄마다의 돈(일괄 수납 V5 · 부분 결제, data-model 4-12 payment_allocations) ─────────────────────

/** 줄 하나의 청구: 줄 값 + 그 줄의 청구 조정(연장 · 할인 변경의 몫). */
export const lineCharged = (o: FxOrder, l: FxLine) => l.amount + (o.charges ?? []).reduce((sum, c) => sum + chargeOnLine(c, l.id), 0);

// ── 취소한 몫(features-1 E5 · E9) ──────────────────────────────────────

/** 이 줄의 취소들(취소한 차례)의 수. */
export const lineCancels = (o: FxOrder, l: FxLine): number[] =>
  (o.cancellations ?? []).flatMap((c) => c.lines.filter((x) => x.lineId === l.id && x.quantity > 0).map((x) => x.quantity));

/**
 * 금액 total을 수 qty 중 취소한 수만큼 차례로 뺀 몫의 합(취소 때마다 남은 금액 × 취소한 수 ÷ 그때 살아 있는 수, 10원 단위로 내림, 마지막 남은 수는
 * 나머지 전부). 취소 값 · 할인 앞 값 · 접수 때 할인의 몫이 같은 셈을 쓴다.
 */
export function cancelledShare(total: number, qty: number, cancels: readonly number[]): number {
  let live = qty;
  let rest = total;
  let cut = 0;
  for (const q of cancels) {
    if (live <= 0) break;
    const take = q >= live ? rest : Math.floor((rest * q) / live / 10) * 10;
    cut += take;
    rest -= take;
    live -= q;
  }
  return cut;
}

/** 취소 한 번의 값: 남은 금액 × 취소한 수 ÷ 살아 있는 수(10원 내림, 마지막 남은 수는 나머지). */
export const cancelPart = (rest: number, q: number, live: number): number => (q >= live ? rest : Math.floor((rest * q) / Math.max(1, live) / 10) * 10);

/** 줄의 할인 앞 값 중 살아 있는 몫(features-1 E9: 할인은 살아 있는 값으로 다시 센다). */
export const liveGross = (o: FxOrder, l: FxLine): number => {
  const gross = l.gross ?? l.amount;
  return gross - cancelledShare(gross, l.qty, lineCancels(o, l));
};

/** 접수 때 뺀 할인(gross − amount) 중 살아 있는 몫. */
export const liveCheckoutDiscount = (o: FxOrder, l: FxLine): number => {
  const cut = (l.gross ?? l.amount) - l.amount;
  return cut - cancelledShare(cut, l.qty, lineCancels(o, l));
};

/**
 * 취소 값을 셀 때의 줄의 남은 청구(features-1 E5): 줄 값 + 그 줄의 연장 · 연장 취소 + 앞 취소(음수). 할인 변경은 뺀다(할인은 취소 뒤 다시 센다, E9).
 */
export const lineRemaining = (o: FxOrder, l: FxLine): number =>
  l.amount + (o.charges ?? []).reduce((sum, c) => sum + (c.kind === 'extension' || c.kind === 'extension_undo' || c.kind === 'cancellation' ? (c.lineId === l.id ? c.amount : 0) : 0), 0);

/**
 * 취소 한 건이 비운 돈(features-1 E5 · E3): 그 취소의 줄에 묶인 수납이 줄 청구를 넘은 돈 + 그 줄들의 칸에 묶인 수납(선입금)이 칸을 채우고 남은 돈 +
 * 접수 전체 수납이 남긴 돈. 지금 상태로 센다(앞의 환불 · 환불 없음이 이미 줄였다). 환불 창 · 환불 명령이 이것까지만 돌려준다.
 */
export function cancellationFreed(o: FxOrder, c: FxCancellation): number {
  const fill = lineFill(o);
  const ids = new Set(c.lines.map((x) => x.lineId));
  const sections = new Set(o.lines.filter((l) => ids.has(l.id)).map((l) => l.section));
  let n = fill.orderExcess;
  for (const id of ids) n += fill.lineExcess.get(id) ?? 0;
  for (const s of sections) n += fill.sectionExcess.get(s) ?? 0;
  return n;
}

/** 취소 한 건이 청구에서 뺀 돈(cancellation 조정의 합, 양수) − 환불 없음으로 남긴 돈. */
export function cancellationRemoved(o: FxOrder, c: FxCancellation): number {
  const removed = -(o.charges ?? []).reduce((sum, x) => sum + (x.kind === 'cancellation' && x.cancellationId === c.id ? x.amount : 0), 0);
  const fees = (o.charges ?? []).reduce((sum, x) => sum + (x.kind === 'cancellation_fee' && x.cancellationId === c.id ? x.amount : 0), 0);
  return Math.max(0, removed - fees);
}

/** 줄마다 채운 돈과, 제자리(줄 · 칸 · 접수 전체)를 넘쳐 다른 줄로 넘친 돈의 출처(취소 · 할인이 비운 돈, features-1 E4b · E5). */
export interface LineFill {
  paid: Map<string, { amount: number; quantity: number }>;
  /** 줄에 묶인 수납이 그 줄 청구를 넘은 돈(줄마다). */
  lineExcess: Map<string, number>;
  /** 칸에 묶인 수납(선입금)이 그 칸을 채우고 남은 돈(칸마다). */
  sectionExcess: Map<string, number>;
  /** 접수 전체 수납이 줄을 채우고 남은 돈. */
  orderExcess: number;
}

/**
 * 줄마다 채운 돈(배분). 줄 · 수량을 적은 수납(부분 결제 · 일괄 수납의 몫 · 수납 창의 이 팀 몫)이 먼저 그 줄을 채우고(그 수납의 환불이 그 줄에서
 * 뺀다), 줄이 없는 수납은 그 칸(선입금 리프트권) 또는 접수 전체를 이 팀이 낼 줄부터 줄 차례(장비 → 리프트권)로 채운다(환불 몫을 뺀 금액).
 * 넘친 돈(할인 뒤 줄 · 칸의 청구보다 많이 묶인 돈)은 버리지 않고 이 접수의 다른 줄을 같은 차례로 채운다(features-1 E4c): 접수증 · 장부 ·
 * 일괄 수납 · 마감 이월 · 기사 미수가 모두 이 한 셈이라 청구 − 받은 돈(ownDue)과 늘 맞는다. 합 = min(받은 돈 − 환불, 줄 청구의 합).
 */
export function linePaid(o: FxOrder): Map<string, { amount: number; quantity: number }> {
  return lineFill(o).paid;
}

/** linePaid와 같은 셈에 넘친 돈의 출처를 함께(LineFill). */
export function lineFill(o: FxOrder): LineFill {
  const out = new Map<string, { amount: number; quantity: number }>(o.lines.map((l) => [l.id, { amount: 0, quantity: 0 }]));
  const lineExcess = new Map<string, number>();
  const sectionExcess = new Map<string, number>();
  let orderExcess = 0;
  const room = (l: FxLine) => Math.max(0, lineCharged(o, l) - (out.get(l.id)?.amount ?? 0));
  const refunds = o.refunds ?? [];
  for (const p of o.payments) {
    for (const x of p.lines ?? []) {
      const seen = out.get(x.lineId);
      if (seen) { seen.amount += x.amount; seen.quantity += x.quantity; }
    }
  }
  for (const r of refunds) {
    for (const x of r.lines ?? []) {
      const seen = out.get(x.lineId);
      if (seen) seen.amount -= x.amount;
    }
  }
  // 줄 청구보다 많이 묶인 돈은 넘친 돈(spill)으로 뺀다.
  let spill = 0;
  for (const l of o.lines) {
    const seen = out.get(l.id)!;
    const over = seen.amount - Math.max(0, lineCharged(o, l));
    if (over > 0) { seen.amount -= over; spill += over; lineExcess.set(l.id, over); }
  }
  // 줄이 없는 수납은 이 팀이 낼 줄부터(다른 팀이 내기로 한 줄은 그 팀 몫이라 뒤로), 그 안에서 장비 → 리프트권.
  const rank = (l: FxLine) => (linePayerId(o, l) === o.id ? 0 : 2) + (l.section === 'gear' ? 0 : 1);
  const ordered = [...o.lines].sort((a, b) => rank(a) - rank(b));
  const fill = (amount: number, section: FxLine['section'] | undefined): number => {
    let rest = amount;
    for (const l of ordered) {
      if (rest <= 0) break;
      if (section && l.section !== section) continue;
      const take = Math.min(rest, room(l));
      if (take <= 0) continue;
      out.get(l.id)!.amount += take;
      rest -= take;
    }
    return rest;
  };
  for (const p of o.payments) {
    // 줄이 없는 수납은 금액 전부, 줄에 묶인 수납은 묶이지 않은 나머지(옛 보냄 대기 현장 수납이 받을 돈보다 많이 받은 몫)가 접수 전체 돈이다.
    // 그 수납의 줄 없는 환불은 이 몫에서 뺀다(2026-09-27 점검: 나머지를 세지 않아 초과 수납 환불 뒤 줄 미수가 남았다).
    const bound = (p.lines ?? []).reduce((sum, x) => sum + x.amount, 0);
    const back = refunds.filter((r) => r.refundOf === p.id && !r.lines?.length).reduce((sum, r) => sum + r.amount, 0);
    const free = p.amount - bound - back;
    if (p.lines?.length && free <= 0) continue;
    const rest = fill(Math.max(0, free), p.section);
    if (rest > 0) {
      if (p.section) sectionExcess.set(p.section, (sectionExcess.get(p.section) ?? 0) + rest);
      else orderExcess += rest;
    }
    spill += rest;
  }
  if (spill > 0) fill(spill, undefined);
  return { paid: out, lineExcess, sectionExcess, orderExcess };
}

/** 줄 하나의 아직 받지 않은 돈. */
export const lineLeft = (o: FxOrder, l: FxLine, paid: ReadonlyMap<string, { amount: number }> = linePaid(o)) => Math.max(0, lineCharged(o, l) - (paid.get(l.id)?.amount ?? 0));

/**
 * 줄 하나에서 아직 받지 않은 수(부분 결제 판의 −/+ 최대). 줄 · 수량으로 받은 수를 빼고, 금액으로만 받은 몫은 한 개 값으로 나눠
 * 온전히 채운 수만큼 뺀다. 받을 돈이 남았으면 적어도 1.
 */
export function lineQtyLeft(o: FxOrder, l: FxLine, paid: ReadonlyMap<string, { amount: number; quantity: number }> = linePaid(o)): number {
  const left = lineLeft(o, l, paid);
  // 살아 있는 수로 센다(취소한 수는 값도 빠졌다, features-1 E6).
  const live = liveQty(l);
  if (left <= 0 || live <= 0) return 0;
  const unit = lineCharged(o, l) / live;
  const byQty = paid.get(l.id)?.quantity ?? 0;
  const byAmount = unit > 0 ? Math.floor(((paid.get(l.id)?.amount ?? 0) + 0.5) / unit) : 0;
  return Math.max(1, live - Math.max(byQty, byAmount));
}

/** 줄 하나에서 n개의 값(남은 수 모두면 남은 돈 그대로, 아니면 한 개 값 × n을 남은 돈 안에서). */
export function lineAmountFor(o: FxOrder, l: FxLine, n: number, paid: ReadonlyMap<string, { amount: number; quantity: number }> = linePaid(o)): number {
  const qtyLeft = lineQtyLeft(o, l, paid);
  const left = lineLeft(o, l, paid);
  if (n <= 0 || qtyLeft <= 0) return 0;
  if (n >= qtyLeft) return left;
  return Math.min(left, Math.round((lineCharged(o, l) / Math.max(1, liveQty(l))) * n));
}

/** 줄 값을 낼 팀(줄의 결제 팀 → 접수의 결제 팀 → 이 팀). */
export const linePayerId = (o: FxOrder, l: FxLine) => l.payerOrderId ?? o.payerOrderId ?? o.id;

/** payer가 이 접수에서 낼 몫(그 팀이 내기로 한 줄의 받지 않은 돈). */
export function dueFor(o: FxOrder, payerId: string): number {
  const paid = linePaid(o);
  return o.lines.filter((l) => linePayerId(o, l) === payerId).reduce((sum, l) => sum + lineLeft(o, l, paid), 0);
}

/**
 * 이 팀이 스스로 낼 미수: 결제 팀이 이 팀인 줄(줄의 결제 팀 → 접수의 결제 팀 → 이 팀)의 받지 않은 돈. 다른 팀이 내기로 한 줄은 빼고 센다
 * (그 돈은 그 팀의 대납, othersDue). 장부 미수 탭 · 수납 창의 이 팀 몫 · 기사 현장 수납 · 미수 차감 · 늦은 미수 · 마감 이월이 이 셈을 쓴다.
 * 청구 전체의 남은 돈(누가 내든)은 ownDue다.
 */
export const selfDue = (o: FxOrder) => dueFor(o, o.id);

/** 이 팀 줄을 대신 내기로 한 팀(접수의 결제 팀, 없으면 받을 돈이 남은 첫 줄의 결제 팀). 없으면 undefined. */
export function promisedPayer(state: ShopState, o: FxOrder): FxOrder | undefined {
  const byOrder = findOrder(state, o.payerOrderId);
  if (byOrder) return byOrder;
  const paid = linePaid(o);
  const line = o.lines.find((l) => linePayerId(o, l) !== o.id && lineLeft(o, l, paid) > 0);
  return line ? findOrder(state, linePayerId(o, line)) : undefined;
}

/**
 * 줄을 정해 낸 돈의 배분(줄 · 수량 · 금액): 주어진 줄(장비 → 리프트권 차례)의 받지 않은 돈을 amount까지 채운다. 줄을 다 채우면 남은 수 모두,
 * 일부면 한 개 값으로 온전히 채운 수. 수납 창 · 미수 차감이 이 팀 몫의 줄만 채우게 한다(다른 팀이 내기로 한 줄은 그 팀 몫).
 */
export function fillLines(o: FxOrder, lines: readonly FxLine[], amount: number): { lineId: string; quantity: number; amount: number }[] {
  const paid = linePaid(o);
  const out: { lineId: string; quantity: number; amount: number }[] = [];
  let rest = Math.max(0, amount);
  for (const l of [...lines].sort((a, b) => (a.section === 'gear' ? 0 : 1) - (b.section === 'gear' ? 0 : 1))) {
    if (rest <= 0) break;
    const left = lineLeft(o, l, paid);
    const take = Math.min(rest, left);
    if (take <= 0) continue;
    const qtyLeft = lineQtyLeft(o, l, paid);
    const unit = liveQty(l) > 0 ? lineCharged(o, l) / liveQty(l) : 0;
    const quantity = take >= left ? qtyLeft : unit > 0 ? Math.min(qtyLeft, Math.floor((take + 0.5) / unit)) : 0;
    out.push({ lineId: l.id, quantity, amount: take });
    rest -= take;
  }
  return out;
}

/** 이 팀 몫(결제 팀이 이 팀)의 받을 돈이 남은 줄. */
export function selfLines(o: FxOrder): FxLine[] {
  const paid = linePaid(o);
  return o.lines.filter((l) => linePayerId(o, l) === o.id && lineLeft(o, l, paid) > 0);
}

/** 이 팀이 대신 내기로 한 다른 팀들(그 팀 몫이 남은 것만, 접수 번호 차례). 줄 단위 결제 약속도 센다. */
export function coveredOrders(state: ShopState, o: FxOrder): FxOrder[] {
  return state.orders.filter((other) => other.id !== o.id && dueFor(other, o.id) > 0).sort((a, b) => a.receiptNo.localeCompare(b.receiptNo));
}

/** 이 팀이 대신 낼 몫의 합(대납). */
export const othersDue = (state: ShopState, o: FxOrder) => coveredOrders(state, o).reduce((sum, other) => sum + dueFor(other, o.id), 0);

// ── 물건 ────────────────────────────────────────────────────────────

export const isVehiclePickup = (o: FxOrder) => o.pickup.mode === 'vehicle';
/** 차량이 받는 반납 일정이 있는지(원래 일정이든 일정 변경으로 나눈 일정이든). */
export const isVehicleReturn = (o: FxOrder) => o.giveBack.mode === 'vehicle' || (o.splits ?? []).some((s) => s.quantity > 0 && s.promise.mode === 'vehicle');
/**
 * 손님 쪽에서 닫힌 수: 매장 반납 + 차량 수거 + 분실 처리(features-1 E20, 청구 없이 닫은 권). 손님에게 있는 수 = 지급 − 이것. 차량 · 매장의 실물
 * 셈(입고 · 규격 자리)은 반납 + 수거만 본다(variants.ts backOf).
 */
export const backCount = (l: FxLine) => l.returned + l.collected + (l.lost ?? 0);
export const pendingIssue = (o: FxOrder) => o.lines.some((l) => l.issued < liveQty(l));
export const pendingReturn = (o: FxOrder) => o.lines.some((l) => l.returnable && backCount(l) < returnQty(l));
/** 손님에게 나가 있는 수(내준 것 − 돌아온 것). 취소로 줄지 않는다(E6). */
export const outQty = (l: FxLine) => Math.max(0, l.issued - backCount(l));
/** 차에 실려 아직 건네지 않은 수(내려놓은 것 뺌, 취소한 것 포함). */
export const vanLoaded = (l: FxLine) => Math.max(0, Math.max(l.loaded, l.issued) - l.issued - (l.unloaded ?? 0));
/** 차에 실려 아직 건네지 않은 수 중 건넬 것(살아 있는 수까지, 배달 도장 · 배달 처리의 수). */
export const onVanToDeliver = (l: FxLine) => Math.max(0, Math.min(vanLoaded(l), liveQty(l) - l.issued));
/**
 * 취소한 배달의 차에 남은 것(features-1 E7): 실었지만 건네지 않은 것 중 이제 건넬 것이 아닌 수. `매장 입고`(stock.receive에 배달 업무)로 내려놓는다.
 * leftover = (적재 − 지급 − 내려놓음) − max(0, 살아 있는 수 − 지급).
 */
export const leftover = (l: FxLine) => Math.max(0, vanLoaded(l) - Math.max(0, liveQty(l) - l.issued));
/** 번호로 세는 줄(번호 스티커 · 권 번호). */
const numberedLine = (l: FxLine) => (l.tracking ?? 'unit') === 'unit';
/**
 * 취소할 수 있는 수(features-1 E7): 살아 있는 수 − 손님에게 있는 수 − 분실 처리한 수(지급 전 · 차에 실린 것 · 돌아온 것). 번호로 세는 줄은 차에 실린
 * 번호를 되돌리는 길이 없어 싣지 않은 것 · 돌아온 것만. 분실 처리한 권은 손님이 쓴 것이라 취소(환불)하지 않는다.
 */
export const cancellableQty = (l: FxLine) => Math.max(0, liveQty(l) - outQty(l) - (l.lost ?? 0) - (numberedLine(l) ? vanLoaded(l) : 0));
/**
 * 접수 전체를 취소할 수 있는지(features-1 E7): 손님에게 있는 것이 없고(번호 줄은 차에 실린 것도 없고) 취소할 수가 남았다. 모든 살아 있는 수를
 * 취소한다.
 */
export const orderCancellable = (o: FxOrder) =>
  o.lines.every((l) => outQty(l) === 0 && !(numberedLine(l) && vanLoaded(l) > 0)) && o.lines.some((l) => cancellableQty(l) > 0);
/** 모든 줄을 취소한 접수(접수 취소 · 품목 취소로 살아 있는 수가 없음): 장부의 옅은 줄 · `취소`. */
export const isCancelledOrder = (o: FxOrder) => (o.cancellations?.length ?? 0) > 0 && o.lines.every((l) => liveQty(l) === 0);
export const anyIssued = (o: FxOrder) => o.lines.some((l) => l.issued > 0);
/** 차량이 아직 받아야 할 수(내준 것 − 돌아온 것). */
export const collectLeft = (l: FxLine) => (l.returnable ? Math.max(0, l.issued - backCount(l)) : 0);
/** 차에 있는 수(받았지만 매장에 아직 내려놓지 않음). */
export const onVan = (l: FxLine) => Math.max(0, l.collected - (l.received ?? 0));
/** 차량 수거 업무가 끝났는지: 내준 것이 모두 돌아왔다(차량이 받았거나 손님이 매장에 가져왔다). */
export const collectDone = (o: FxOrder) => !o.lines.some((l) => collectLeft(l) > 0);
/** 셀 수 있는 장비(개) 수. 권(매)은 따로 센다. */
export const unitCount = (lines: readonly FxLine[], pick: (l: FxLine) => number) => lines.filter((l) => !l.unit).reduce((sum, l) => sum + pick(l), 0);

export function isFinished(state: ShopState, o: FxOrder): boolean {
  return !pendingIssue(o) && !pendingReturn(o) && ownDue(o) === 0 && othersDue(state, o) === 0;
}

// ── 다음 약속과 늦음 ─────────────────────────────────────────────────

export type DueKind = 'pickup' | 'deliver' | 'return' | 'pay';

export interface NextDue {
  kind: DueKind;
  at: number;
  /** 이 시각이 지나면 그 줄이 빨개진다. 없으면 늦음이 없다(매장 수령은 손님이 늦게 와도 빨강이 아님). */
  lateAt?: number;
}

export function nextDue(state: ShopState, o: FxOrder): NextDue | null {
  if (pendingIssue(o)) {
    if (isVehiclePickup(o)) {
      const loaded = o.lines.every((l) => Math.max(l.loaded, l.issued) - (l.unloaded ?? 0) >= liveQty(l));
      // 차량 배달은 약속 시각까지 싣고 떠나야 한다. 실은 뒤에는 기사가 전하는 시각 + 차량 여유(60분).
      return { kind: 'deliver', at: o.pickup.at, lateAt: loaded ? lateAtOf(state.settings, o.pickup) : o.pickup.at };
    }
    return { kind: 'pickup', at: o.pickup.at };
  }
  if (pendingReturn(o)) {
    // 일정이 나뉜 접수는 아직 남은 것 중 가장 이른 일정(일정 변경 N2).
    const back = currentReturn(o);
    return { kind: 'return', at: back.at, lateAt: lateAtOf(state.settings, back) };
  }
  if (ownDue(o) > 0 || othersDue(state, o) > 0) return { kind: 'pay', at: o.giveBack.at, lateAt: o.giveBack.at + LATE_AFTER_STORE };
  return null;
}

/** 늦은 미수의 기준: 받기로 한 때(받을 때 · 돌려줄 때)가 지났는데 미수. 늦지 않은 미수는 검정이다(N8). */
export function moneyLateAt(state: ShopState, o: FxOrder): number | undefined {
  // 이 팀이 스스로 낼 돈과 대신 낼 돈만 이 팀의 늦음이다(다른 팀이 내기로 한 줄은 그 팀의 늦음).
  if (selfDue(o) + othersDue(state, o) === 0) return undefined;
  // 반납 때 받기로 한 돈은 반납 일정 30분 뒤. 차량 늦음 설정(vehicleLate)이 있는 매장의 차량 수거는 그 수거가 늦을 때 늦는다(밤 수거를
  // 기다리는 동안 기사 화면의 미수가 빨개지지 않게, 2026-09-26 답 15). 설정이 없는 매장은 전과 같다.
  if (o.payWhen === 'return') {
    const back = currentReturn(o);
    return back.mode === 'vehicle' && state.settings.vehicleLate ? Math.max(back.at + LATE_AFTER_STORE, lateAtOf(state.settings, back)) : back.at + LATE_AFTER_STORE;
  }
  return pendingIssue(o) ? undefined : o.pickup.at + LATE_AFTER_STORE;
}

// ── 리프트권 분실 처리(features-1 E20) ─────────────────────────────────────

/** 보증금을 맡은 줄(보증금 매장의 권: 분실 처리 대신 보증금 몰수). */
export const lineHasDeposit = (state: ShopState, o: FxOrder, l: FxLine) => state.deposits.some((d) => d.orderId === o.id && d.entries.some((e) => e.lineId === l.id));

/**
 * 분실 처리할 수 있는 권 줄(E20): 리프트권 줄이고, 수량으로 세고(번호 권은 번호의 길이 따로), 돌려받는 줄이고, 보증금이 없다(보증금 매장은 `보증금 몰수`).
 */
export const lossEligible = (state: ShopState, o: FxOrder, l: FxLine) =>
  l.section === 'lift' && l.returnable && (l.tracking ?? 'unit') === 'count' && !lineHasDeposit(state, o, l);

// ── 줄마다의 능력(옆 동작의 조건) ────────────────────────────────────────

export function orderConditions(state: ShopState, o: FxOrder): ConditionKey[] {
  const out = new Set<ConditionKey>();
  for (const l of o.lines) {
    // 줄의 능력(연장 가능 …)은 내준 것이 있을 때. 즉시 교환(exchangeable)은 사이즈가 있는 수량 줄에 바꿀 것(손님에게 있는 것 · 매장의 지급 전
    // 것)이 있을 때만(features-1 §7-1: 번호 줄 · 사이즈 없는 스키 · 보드에는 동작이 없다).
    if (l.issued - backCount(l) > 0) for (const c of l.capabilities) if (c !== 'exchangeable') out.add(c);
    if (lineCanSwap(state.registry, l)) out.add('exchangeable');
    // 품목 취소(features-1 §5-4): 취소할 수 있는 수(지급 전 · 돌아온 것)가 남은 줄.
    if (cancellableQty(l) > 0) out.add('partial_cancel_allowed');
    if (l.returnable && backCount(l) < returnQty(l)) out.add('return_required');
    // 내준 장비가 아직 돌아오지 않음(조기 반납의 조건): 지급 전에는 없다.
    if (l.returnable && l.issued - backCount(l) > 0) out.add('has_items_out');
    // 미반납 리프트권(0004 tickets_out, 접수증 옆 동작 `분실 처리`): 분실 처리할 수 있는 권 줄에 손님에게 있는 권.
    if (outQty(l) > 0 && lossEligible(state, o, l)) out.add('tickets_out');
  }
  // 받을 돈이 있음(수납 옆 동작의 조건): 이 팀 미수이거나 이 팀이 대신 낼 몫.
  if (ownDue(o) > 0 || othersDue(state, o) > 0) out.add('has_due');
  // 열린 차량 업무: 아직 전하지 않은 배달, 내준 뒤 아직 받지 않은 수거(빨리 확인의 조건). 수거는 차량 일정마다.
  // 모두 취소한 접수는 열린 업무가 없다(긴급 요청을 띄우지 않는다, 2026-09-27 점검).
  if (!isCancelledOrder(o) && ((isVehiclePickup(o) && pendingIssue(o)) || orderTasks(o).some((t) => { const x = taskOrder(t); return anyIssued(x) && !collectDone(x); }))) out.add('has_open_tasks');
  if (isVehiclePickup(o)) out.add('vehicle_pickup');
  if (isVehicleReturn(o)) out.add('vehicle_return');
  // 진행 중 접수(할인 적용 · 품목 추가의 조건, 0004): 품목이 있고 모두 취소하지 않은 접수.
  if (o.lines.length > 0 && !isCancelledOrder(o)) out.add('order_open');
  // 접수 취소(0004 cancellable, 접수 단위): 손님에게 있는 것이 없고 취소할 수가 남은 접수(features-1 E7).
  if (orderCancellable(o)) out.add('cancellable');
  return [...out];
}

// ── 차량 수거 경로(방문 순서 · 빨리 확인) ─────────────────────────────────

/**
 * 이 차량 · 영업일의 수거 업무(차량 일정마다 하나, 그 일정 몫에 내준 것이 있는 것). 영업일로 가른다(심야 24:00 수거는 그 영업일).
 * 일정 변경으로 나뉜 접수는 업무가 둘 이상이다(박준호 팀 22:00 설천 주차장 · 22:00 솔마을 두솔동).
 */
export function routeTasks(state: ShopState, vehicleId: string, date: string): FxTask[] {
  const day = { date, cutoff: shopCutoff(state.settings) };
  return state.orders.flatMap((o) => orderTasks(o).filter((t) => t.promise.vehicleId === vehicleId && onBizDay(t.promise.at, day) && anyIssued(taskOrder(t))));
}

/**
 * 수거 목록 · 업무 판의 업무: 차량이 받을 것이 남았거나 차량이 받은 업무. 손님이 모두 매장에 가져와 차량이 받을 것이 없어진 업무(elsewhere
 * quantity = 받을 수)는 목록 · 완료 수에서 빠진다(data-model 4-18 · S16: 설천 주차장 업무는 받을 것이 없어져 수거 목록에서 빠진다).
 */
export function listTasks(state: ShopState, vehicleId: string, date: string): FxTask[] {
  return routeTasks(state, vehicleId, date).filter((t) => {
    const view = taskOrder(t);
    return !(collectDone(view) && !view.lines.some((l) => l.collected > 0));
  });
}

/** 긴급 요청이 걸린 업무(없으면 그 접수의 원래 일정 업무, 그것도 없으면 첫 업무). */
export function pinTask(state: ShopState, pin: FxPin): FxTask | undefined {
  const o = findOrder(state, pin.orderId);
  if (!o) return undefined;
  return findTask(state, pin.taskId ?? collectTaskIdOf(o, null)) ?? orderTasks(o)[0];
}

/** 긴급 요청의 업무 id(목록 줄 · 기사 알림이 가리키는 곳). */
export const pinTaskId = (state: ShopState, pin: FxPin) => pinTask(state, pin)?.id ?? pin.taskId ?? 'collect:' + pin.orderId;

/** 아직 끝나지 않은 수거 업무의 빨리 확인(가장 이른 약속부터). 받거나 매장에 돌아오면 사라진다. */
export function openPins(state: ShopState): FxPin[] {
  return state.pins
    .filter((p) => { const task = pinTask(state, p); return task !== undefined && !collectDone(taskOrder(task)); })
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** 반납 타임 묶음 키('s2200'). 업무를 비춘 접수(taskOrder)에서는 그 업무의 일정. */
export const slotKey = (o: FxOrder) => 's' + hm(o.giveBack.at).replace(':', '');

/**
 * 수거 목록의 순서(ui 6-3 sort manual_route): 반납 타임 → 빨리 확인 → 순위 → 접수 순(같은 접수는 원래 일정 먼저). 순위가 없는 업무
 * (첫 손 이동 전, 나중에 생긴 업무)는 순위가 있는 업무 뒤에 접수 순으로 온다.
 */
export function sortTasks(state: ShopState, tasks: readonly FxTask[]): FxTask[] {
  const pinned = new Set(openPins(state).map((p) => pinTaskId(state, p)));
  const rank = (t: FxTask) => state.routeRanks[t.id] ?? 'z' + t.order.receiptNo + (t.key ? ':' + t.key : '');
  return [...tasks].sort((a, b) =>
    a.promise.at - b.promise.at || Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || rank(a).localeCompare(rank(b)) || a.id.localeCompare(b.id));
}

/** 방문 결과 이름(reason_codes visit_result, 매장 목록 registry.visitOutcomes). 없는 key는 빈 글. */
export const visitOutcomeLabel = (reg: Pick<ShopRegistry, 'visitOutcomes'>, key: FxVisitOutcome) => reg.visitOutcomes.find((v) => v.key === key)?.label ?? '';

/** 매장이 쓰는 방문 결과인지. */
export const isVisitOutcome = (reg: Pick<ShopRegistry, 'visitOutcomes'>, key: string): key is FxVisitOutcome => reg.visitOutcomes.some((v) => v.key === key);

/**
 * 업무 종류마다 방문 결과 판의 사유(spec 3-8 · ui 6-3): 수거 `고객 부재` · `장소 변경` · `물품 미준비`, 배달 `고객 부재` · `장소 변경` ·
 * `기타`(문구 표 3-10: 판 제목 `배달 실패`를 되풀이하지 않음).
 */
export const VISIT_REASON_KEYS: Readonly<Record<'deliver' | 'collect', readonly FxVisitOutcome[]>> = {
  collect: ['customer_absent', 'place_changed', 'items_not_ready'],
  deliver: ['customer_absent', 'place_changed', 'other'],
};

export const visitReasons = (reg: Pick<ShopRegistry, 'visitOutcomes'>, kind: 'deliver' | 'collect') =>
  VISIT_REASON_KEYS[kind].filter((key) => isVisitOutcome(reg, key)).map((key) => ({ key, label: visitOutcomeLabel(reg, key) }));

/**
 * 차량 업무 id(배달 · 수거). 배달은 접수마다 하나('deliver:o26'), 수거는 차량 일정마다('collect:o22'는 원래 일정,
 * 'collect:o22:<일정 id>'는 일정 변경으로 나눈 일정, promises.ts).
 */
export const deliverTaskId = (o: FxOrder) => 'deliver:' + o.id;
/** 배달 업무 id인지('deliver:o26'). */
export const isDeliverTaskId = (taskId: string) => taskId.startsWith('deliver:');
/** 업무 id의 접수 id(둘째 마디). */
export function orderIdOfTask(taskId: string): string {
  return taskId.split(':')[1] ?? '';
}

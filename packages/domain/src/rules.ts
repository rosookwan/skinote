// 접수 · 줄의 기본 규칙(돈 · 물건 · 다음 약속 · 늦음 · 능력 · 차량 수거 경로). 읽기 모델(views.ts · stamps.ts)과 명령 처리기가 쓴다.
// 화면(부품 · 화면 틀)은 이 규칙을 부르지 않는다 — 읽기 모델만 받는다(ADR-05).
import type { ConditionKey } from '@skinote/contract';
import type { FxLine, FxOrder, FxPin, FxReturnSlot, FxVisitOutcome, ShopRegistry, ShopState } from './model.ts';
import { collectTaskIdOf, currentReturn, findTask, orderTasks, taskOrder, type FxTask } from './promises.ts';
import { HOUR, MINUTE, hm, kstAt, onBizDay, type BizDay, shopCutoff } from './time.ts';

/** 매장 반납은 약속 30분 뒤, 차량 수거는 60분 뒤부터 늦음(빨강). */
export const LATE_AFTER_STORE = 30 * MINUTE;
export const LATE_AFTER_VEHICLE = 60 * MINUTE;
/** 야간 수거 준비 안내는 그 반납 타임 60분 전부터(ui 6-1). */
export const NIGHT_PREP_BEFORE = HOUR;

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

/** 청구: 줄 값 + 청구 조정(일정 변경의 연장 값). */
export const charged = (o: FxOrder) => o.lines.reduce((sum, l) => sum + l.amount, 0) + (o.charges ?? []).reduce((sum, c) => sum + c.amount, 0);
export const paidTotal = (o: FxOrder) => o.payments.reduce((sum, p) => sum + p.amount, 0);
/** 이 팀 몫의 미수. */
export const ownDue = (o: FxOrder) => Math.max(0, charged(o) - paidTotal(o));

export function findOrder(state: ShopState, orderId: string | undefined): FxOrder | undefined {
  return state.orders.find((o) => o.id === orderId);
}

// ── 줄마다의 돈(일괄 수납 V5 · 부분 결제, data-model 4-12 payment_allocations) ─────────────────────

/** 줄 하나의 청구: 줄 값 + 그 줄의 청구 조정(연장). */
export const lineCharged = (o: FxOrder, l: FxLine) => l.amount + (o.charges ?? []).filter((c) => c.lineId === l.id).reduce((sum, c) => sum + c.amount, 0);

/**
 * 줄마다 채운 돈(배분). 줄 · 수량을 적은 수납(부분 결제 · 일괄 수납의 몫 · 수납 창의 이 팀 몫)이 먼저 그 줄을 채우고, 줄이 없는 수납은 그
 * 칸(선입금 리프트권) 또는 접수 전체를 이 팀이 낼 줄부터 줄 차례(장비 → 리프트권)로 채운다. 합은 수납 합과 같다(넘친 돈은 줄에 들어가지 않음).
 */
export function linePaid(o: FxOrder): Map<string, { amount: number; quantity: number }> {
  const out = new Map<string, { amount: number; quantity: number }>(o.lines.map((l) => [l.id, { amount: 0, quantity: 0 }]));
  const room = (l: FxLine) => Math.max(0, lineCharged(o, l) - (out.get(l.id)?.amount ?? 0));
  for (const p of o.payments) {
    for (const x of p.lines ?? []) {
      const seen = out.get(x.lineId);
      if (seen) { seen.amount += x.amount; seen.quantity += x.quantity; }
    }
  }
  // 줄이 없는 수납은 이 팀이 낼 줄부터(다른 팀이 내기로 한 줄은 그 팀 몫이라 뒤로), 그 안에서 장비 → 리프트권.
  const rank = (l: FxLine) => (linePayerId(o, l) === o.id ? 0 : 2) + (l.section === 'gear' ? 0 : 1);
  const ordered = [...o.lines].sort((a, b) => rank(a) - rank(b));
  for (const p of o.payments) {
    if (p.lines?.length) continue;
    let rest = p.amount;
    for (const l of ordered) {
      if (rest <= 0) break;
      if (p.section && l.section !== p.section) continue;
      const take = Math.min(rest, room(l));
      if (take <= 0) continue;
      out.get(l.id)!.amount += take;
      rest -= take;
    }
  }
  return out;
}

/** 줄 하나의 아직 받지 않은 돈. */
export const lineLeft = (o: FxOrder, l: FxLine, paid: ReadonlyMap<string, { amount: number }> = linePaid(o)) => Math.max(0, lineCharged(o, l) - (paid.get(l.id)?.amount ?? 0));

/**
 * 줄 하나에서 아직 받지 않은 수(부분 결제 판의 −/+ 최대). 줄 · 수량으로 받은 수를 빼고, 금액으로만 받은 몫은 한 개 값으로 나눠
 * 온전히 채운 수만큼 뺀다. 받을 돈이 남았으면 적어도 1.
 */
export function lineQtyLeft(o: FxOrder, l: FxLine, paid: ReadonlyMap<string, { amount: number; quantity: number }> = linePaid(o)): number {
  const left = lineLeft(o, l, paid);
  if (left <= 0 || l.qty <= 0) return 0;
  const unit = lineCharged(o, l) / l.qty;
  const byQty = paid.get(l.id)?.quantity ?? 0;
  const byAmount = unit > 0 ? Math.floor(((paid.get(l.id)?.amount ?? 0) + 0.5) / unit) : 0;
  return Math.max(1, l.qty - Math.max(byQty, byAmount));
}

/** 줄 하나에서 n개의 값(남은 수 모두면 남은 돈 그대로, 아니면 한 개 값 × n을 남은 돈 안에서). */
export function lineAmountFor(o: FxOrder, l: FxLine, n: number, paid: ReadonlyMap<string, { amount: number; quantity: number }> = linePaid(o)): number {
  const qtyLeft = lineQtyLeft(o, l, paid);
  const left = lineLeft(o, l, paid);
  if (n <= 0 || qtyLeft <= 0) return 0;
  if (n >= qtyLeft) return left;
  return Math.min(left, Math.round((lineCharged(o, l) / l.qty) * n));
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
    const unit = l.qty > 0 ? lineCharged(o, l) / l.qty : 0;
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
export const backCount = (l: FxLine) => l.returned + l.collected;
export const pendingIssue = (o: FxOrder) => o.lines.some((l) => l.issued < l.qty);
export const pendingReturn = (o: FxOrder) => o.lines.some((l) => l.returnable && backCount(l) < l.qty);
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
      const loaded = o.lines.every((l) => Math.max(l.loaded, l.issued) >= l.qty);
      // 차량 배달은 약속 시각까지 싣고 떠나야 한다. 실은 뒤에는 기사가 전하는 시각 + 60분.
      return { kind: 'deliver', at: o.pickup.at, lateAt: loaded ? o.pickup.at + LATE_AFTER_VEHICLE : o.pickup.at };
    }
    return { kind: 'pickup', at: o.pickup.at };
  }
  if (pendingReturn(o)) {
    // 일정이 나뉜 접수는 아직 남은 것 중 가장 이른 일정(일정 변경 N2).
    const back = currentReturn(o);
    return { kind: 'return', at: back.at, lateAt: back.at + (back.mode === 'vehicle' ? LATE_AFTER_VEHICLE : LATE_AFTER_STORE) };
  }
  if (ownDue(o) > 0 || othersDue(state, o) > 0) return { kind: 'pay', at: o.giveBack.at, lateAt: o.giveBack.at + LATE_AFTER_STORE };
  return null;
}

/** 늦은 미수의 기준: 받기로 한 때(받을 때 · 돌려줄 때)가 지났는데 미수. 늦지 않은 미수는 검정이다(N8). */
export function moneyLateAt(state: ShopState, o: FxOrder): number | undefined {
  // 이 팀이 스스로 낼 돈과 대신 낼 돈만 이 팀의 늦음이다(다른 팀이 내기로 한 줄은 그 팀의 늦음).
  if (selfDue(o) + othersDue(state, o) === 0) return undefined;
  if (o.payWhen === 'return') return currentReturn(o).at + LATE_AFTER_STORE;
  return pendingIssue(o) ? undefined : o.pickup.at + LATE_AFTER_STORE;
}

// ── 줄마다의 능력(옆 동작의 조건) ────────────────────────────────────────

export function orderConditions(state: ShopState, o: FxOrder): ConditionKey[] {
  const out = new Set<ConditionKey>();
  for (const l of o.lines) {
    if (l.issued - backCount(l) > 0) for (const c of l.capabilities) out.add(c);
    if (l.issued < l.qty) out.add('partial_cancel_allowed');
    if (l.returnable && backCount(l) < l.qty) out.add('return_required');
    // 내준 장비가 아직 돌아오지 않음(조기 반납의 조건): 지급 전에는 없다.
    if (l.returnable && l.issued - backCount(l) > 0) out.add('has_items_out');
  }
  // 받을 돈이 있음(수납 옆 동작의 조건): 이 팀 미수이거나 이 팀이 대신 낼 몫.
  if (ownDue(o) > 0 || othersDue(state, o) > 0) out.add('has_due');
  // 열린 차량 업무: 아직 전하지 않은 배달, 내준 뒤 아직 받지 않은 수거(빨리 확인의 조건). 수거는 차량 일정마다.
  if ((isVehiclePickup(o) && pendingIssue(o)) || orderTasks(o).some((t) => { const x = taskOrder(t); return anyIssued(x) && !collectDone(x); })) out.add('has_open_tasks');
  if (isVehiclePickup(o)) out.add('vehicle_pickup');
  if (isVehicleReturn(o)) out.add('vehicle_return');
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

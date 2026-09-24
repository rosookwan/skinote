// FixtureClient의 규칙: 운영 서버(packages/domain의 deriveStamp · 접수 상태 계산)를 대신해 체험 자료에서 읽기 모델을
// 만들 만큼만 줄여 흉내 낸다. 화면(부품 · 화면 틀)은 이 규칙을 부르지 않는다 — 읽기 모델만 받는다.
// 운영 규칙이 생기면(LocalClient) 이 파일은 통째로 없어진다. 규칙을 여기에 더 키우지 않는다.
import type { ConditionKey } from '@skinote/contract';
import type { FxLine, FxOrder, FxPin, FxState } from './model.ts';
import { AREAS, VEHICLES } from './seed.ts';
import { HOUR, MINUTE, hm, kstAt, kstDate } from './time.ts';

/** 반납 타임(매장 설정이 생기기 전의 체험 값). 마지막 타임이 지나면 주 버튼이 '마감'이 된다. */
export const RETURN_SLOTS = [
  { key: 'morning', label: '오전타임', hour: 12, minute: 0 },
  { key: 'afternoon', label: '오후타임', hour: 16, minute: 30 },
  { key: 'night', label: '야간타임', hour: 22, minute: 0 },
] as const;

/** 매장 반납은 약속 30분 뒤, 차량 수거는 60분 뒤부터 늦음(빨강). */
export const LATE_AFTER_STORE = 30 * MINUTE;
export const LATE_AFTER_VEHICLE = 60 * MINUTE;
/** 야간 수거 준비 안내는 야간 타임 60분 전부터(ui 6-1). */
export const NIGHT_PREP_BEFORE = HOUR;

export function lastReturnSlotAt(date: string): number {
  const last = RETURN_SLOTS[RETURN_SLOTS.length - 1]!;
  return kstAt(date, 0, last.hour, last.minute);
}

export function placeLabel(placeId: string | undefined): string {
  for (const area of AREAS) {
    const place = area.places.find((p) => p.id === placeId);
    if (place) return area.lodging ? area.label + ' ' + place.label : place.label;
  }
  return '';
}

/** 좁은 자리의 장소 이름: 숙소는 장소('들국화'), 그 밖은 구역('설천'). */
export function placeShortLabel(placeId: string | undefined): string {
  for (const area of AREAS) {
    const place = area.places.find((p) => p.id === placeId);
    if (place) return area.lodging ? place.label : area.label;
  }
  return '';
}

export function vehicleLabel(vehicleId: string | undefined): string {
  return VEHICLES.find((v) => v.id === vehicleId)?.label ?? '차량';
}

// ── 돈 ─────────────────────────────────────────────────────────────

export const charged = (o: FxOrder) => o.lines.reduce((sum, l) => sum + l.amount, 0);
export const paidTotal = (o: FxOrder) => o.payments.reduce((sum, p) => sum + p.amount, 0);
/** 이 팀 몫의 미수. */
export const ownDue = (o: FxOrder) => Math.max(0, charged(o) - paidTotal(o));

export function findOrder(state: FxState, orderId: string | undefined): FxOrder | undefined {
  return state.orders.find((o) => o.id === orderId);
}

/** 이 팀이 대신 내기로 한 다른 팀들(미수가 남은 것만). */
export function coveredOrders(state: FxState, o: FxOrder): FxOrder[] {
  return state.orders.filter((other) => other.payerOrderId === o.id && ownDue(other) > 0);
}

export const othersDue = (state: FxState, o: FxOrder) => coveredOrders(state, o).reduce((sum, other) => sum + ownDue(other), 0);

// ── 물건 ────────────────────────────────────────────────────────────

export const isVehiclePickup = (o: FxOrder) => o.pickup.mode === 'vehicle';
export const isVehicleReturn = (o: FxOrder) => o.giveBack.mode === 'vehicle';
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

export function isFinished(state: FxState, o: FxOrder): boolean {
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

export function nextDue(state: FxState, o: FxOrder): NextDue | null {
  if (pendingIssue(o)) {
    if (isVehiclePickup(o)) {
      const loaded = o.lines.every((l) => Math.max(l.loaded, l.issued) >= l.qty);
      // 차량 배달은 약속 시각까지 싣고 떠나야 한다. 실은 뒤에는 기사가 전하는 시각 + 60분.
      return { kind: 'deliver', at: o.pickup.at, lateAt: loaded ? o.pickup.at + LATE_AFTER_VEHICLE : o.pickup.at };
    }
    return { kind: 'pickup', at: o.pickup.at };
  }
  if (pendingReturn(o)) {
    return { kind: 'return', at: o.giveBack.at, lateAt: o.giveBack.at + (isVehicleReturn(o) ? LATE_AFTER_VEHICLE : LATE_AFTER_STORE) };
  }
  if (ownDue(o) > 0 || othersDue(state, o) > 0) return { kind: 'pay', at: o.giveBack.at, lateAt: o.giveBack.at + LATE_AFTER_STORE };
  return null;
}

/** 늦은 미수의 기준: 받기로 한 때(받을 때 · 돌려줄 때)가 지났는데 미수. 늦지 않은 미수는 검정이다(N8). */
export function moneyLateAt(state: FxState, o: FxOrder): number | undefined {
  if (ownDue(o) + othersDue(state, o) === 0 || o.payerOrderId) return undefined;
  if (o.payWhen === 'return') return o.giveBack.at + LATE_AFTER_STORE;
  return pendingIssue(o) ? undefined : o.pickup.at + LATE_AFTER_STORE;
}

// ── 줄마다의 능력(옆 동작의 조건) ────────────────────────────────────────

export function orderConditions(state: FxState, o: FxOrder): ConditionKey[] {
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
  // 열린 차량 업무: 아직 전하지 않은 배달, 내준 뒤 아직 받지 않은 수거(빨리 확인의 조건).
  if ((isVehiclePickup(o) && pendingIssue(o)) || (isVehicleReturn(o) && anyIssued(o) && !collectDone(o))) out.add('has_open_tasks');
  if (isVehiclePickup(o)) out.add('vehicle_pickup');
  if (isVehicleReturn(o)) out.add('vehicle_return');
  return [...out];
}

// ── 차량 수거 경로(방문 순서 · 빨리 확인) ─────────────────────────────────

/** 이 차량 · 영업일의 수거 업무(내준 것이 있는 차량 반납). */
export function routeOrders(state: FxState, vehicleId: string, date: string): FxOrder[] {
  return state.orders.filter((o) => isVehicleReturn(o) && o.giveBack.vehicleId === vehicleId && anyIssued(o) && kstDate(o.giveBack.at) === date);
}

/** 아직 끝나지 않은 수거 업무의 빨리 확인(가장 이른 약속부터). 받거나 매장에 돌아오면 사라진다. */
export function openPins(state: FxState): FxPin[] {
  return state.pins
    .filter((p) => { const o = findOrder(state, p.orderId); return o !== undefined && !collectDone(o); })
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** 반납 타임 묶음 키('s2200'). */
export const slotKey = (o: FxOrder) => 's' + hm(o.giveBack.at).replace(':', '');

/**
 * 수거 목록의 순서(ui 6-3 sort manual_route): 반납 타임 → 빨리 확인 → 순위 → 접수 순. 순위가 없는 업무(첫 손 이동 전,
 * 나중에 생긴 업무)는 순위가 있는 업무 뒤에 접수 순으로 온다.
 */
export function sortRoute(state: FxState, orders: readonly FxOrder[]): FxOrder[] {
  const pinned = new Set(openPins(state).map((p) => p.orderId));
  const rank = (o: FxOrder) => state.routeRanks[collectTaskId(o)] ?? 'z' + o.receiptNo;
  return [...orders].sort((a, b) =>
    a.giveBack.at - b.giveBack.at || Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || rank(a).localeCompare(rank(b)) || a.receiptNo.localeCompare(b.receiptNo));
}

/** 방문 결과 이름(reason_codes의 visit_result 체험 값). */
export const VISIT_OUTCOMES = {
  customer_absent: '고객 부재',
  place_changed: '장소 변경',
  items_not_ready: '물품 미준비',
} as const;

/** 차량 업무 id(배달 · 수거). 체험 자료에서는 접수마다 하나씩이라 접수 id에서 나온다. */
export const deliverTaskId = (o: FxOrder) => 'deliver:' + o.id;
export const collectTaskId = (o: FxOrder) => 'collect:' + o.id;
export function orderIdOfTask(taskId: string): string {
  return taskId.slice(taskId.indexOf(':') + 1);
}

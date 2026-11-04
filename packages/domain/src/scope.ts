// 기사 기기의 차량 범위 사본(work/impl-offline/plan.md O1 · O4 · §5-4): 서버가 기사 기기에 내려 주는 ShopState의 부분. 기기는 같은 도메인 읽기 모델을
// 이 사본(+ 보냄 대기 겹치기)으로 그린다. 시험(scope.test.ts)이 이 사본의 기사 읽기 모델 = 전체 상태의 기사 읽기 모델을 본다(사본이 모자라면 기기와
// 서버의 목록이 달라진다).
//   - 접수: 이 차량의 배달(수령 일정이 이 차량이고 오늘이거나 아직 건넬 · 차에 남은 것이 있음), 이 차량의 수거 업무(원래 · 나눈 일정이 이 차량이고
//     오늘이거나 손님에게 · 차에 남은 것이 있음), 보냄 대기 항목이 가리키는 업무의 접수(옮겨져도 대기 항목이 겹쳐질 곳이 남게), 그 접수와 결제로
//     이어진 접수(대신 내는 팀 · 대신 받는 팀: 기사 판의 `… 팀 결제 예정`과 대납 셈).
//   - 전화: 오늘 열린 이 차량 업무의 접수만 온전한 번호(산에서 전화, O17), 나머지는 가린 번호.
//   - 매장 목록 · 운영 규칙은 통째로(작고 그리는 데 필요), 직원은 세션의 한 사람, 돈통은 모두(이름만), 차량 현금 인계 · 입고 · 예비권은 이 차량 것,
//     마감은 지난 7일의 날짜 · 마감 때만(올림 날 셈), 번호 실물은 이 차량에 있거나 사본의 줄이 가리키는 것, 보증금 · 결제 자리는 사본의 접수 것,
//     긴급 요청 · 방문 순서는 사본의 업무 것. 확인 필요는 싣지 않는다(기사가 읽지 않는다).
import type { FxAsset, FxClosing, FxOrder, ShopState } from './model.ts';
import { maskPhone } from './order-draft.ts';
import { bucketOnVan, bucketOut, lineBuckets, orderTasks } from './promises.ts';
import { orderVans, taskIdVehicle } from './queued.ts';
import { findOrder, isVehiclePickup, orderIdOfTask, pendingIssue, pinTask, vanLoaded } from './rules.ts';
import { businessDateOf, kstAt, kstDate, shopCutoff } from './time.ts';

export interface VehicleScopeOptions {
  /** 사본을 받는 세션의 직원(직원 표에 이 한 사람). */
  staffId?: string;
  /**
   * 기기의 보냄 대기 항목이 가리키는 업무 id(옮겨져도 그 접수를 사본에 남긴다). 기기가 보내는 값이라 allowedPendingTaskIds로 거른다: 이 차량과
   * 이어진 접수이거나 knownOrderIds에 든 접수만(§17 R3-8).
   */
  pendingTaskIds?: readonly string[];
  /** 이 기기에 앞서 보낸 사본에 들었던 접수(서버가 기억, 기기의 06:00 좁히기는 가진 사본의 접수 모두). */
  knownOrderIds?: ReadonlySet<string>;
  /** 오늘 영업일(없으면 state.businessDate). */
  today?: string;
}

/**
 * 사본에 남길 보냄 대기 업무 id(§5-4 · §17 R3-8). 기기가 보낸 값이라 그대로 믿지 않는다: 업무 id 자체의 차량 · 그 접수가 이어진 차량이 이 차량이거나
 * (온라인 기사 세션이 읽을 수 있는 접수와 같은 범위), 이 기기에 앞서 보낸 사본에 들었던 접수(knownOrderIds: 옮겨져 이 차량과 끊긴 업무)만 남긴다.
 * 다른 차량의 업무 · 매장만의 접수 · 없는 접수는 버린다(사본이 다른 손님을 싣지 않게). 같은 id는 한 번.
 */
export function allowedPendingTaskIds(state: ShopState, vehicleId: string, taskIds: readonly string[], knownOrderIds?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const taskId of new Set(taskIds)) {
    const o = findOrder(state, orderIdOfTask(taskId));
    if (!o) continue;
    if (knownOrderIds?.has(o.id) || taskIdVehicle(state, taskId) === vehicleId || orderVans(o).includes(vehicleId)) out.push(taskId);
  }
  return out;
}

/** 마감을 남기는 날 수(올림 날 셈: 마감 뒤의 늦은 돈은 다음 열린 날). */
const CLOSING_DAYS = 7;

/**
 * 이 차량의 업무가 있는 접수인지(has: 오늘의 업무이거나 건넬 · 받을 · 차에 남은 것이 있음)와 온전한 번호를 실을지(open: 오늘까지의 업무에 남은 것이
 * 있음 — 내일 배달은 가린 번호).
 */
function vanWork(o: FxOrder, vehicleId: string, date: string, cutoff: ReturnType<typeof shopCutoff>): { has: boolean; open: boolean } {
  let has = false;
  let open = false;
  const upToToday = (at: number) => businessDateOf(at, cutoff) <= date;
  if (isVehiclePickup(o) && o.pickup.vehicleId === vehicleId) {
    const left = pendingIssue(o) || o.lines.some((l) => vanLoaded(l) > 0);
    if (left || businessDateOf(o.pickup.at, cutoff) === date) has = true;
    if (left && upToToday(o.pickup.at)) open = true;
  }
  for (const task of orderTasks(o)) {
    if (task.promise.vehicleId !== vehicleId) continue;
    const left = o.lines.some((l) => l.returnable && lineBuckets(o, l).some((b) => b.key === task.key && (bucketOut(b) > 0 || bucketOnVan(b) > 0)));
    if (left || businessDateOf(task.promise.at, cutoff) === date) has = true;
    if (left && upToToday(task.promise.at)) open = true;
  }
  return { has, open };
}

/**
 * 차량 범위 사본(§5-4). 입력 상태는 고치지 않는다(깊은 사본). 돌려준 사본의 rev · epoch · 영업일은 입력 그대로다.
 */
export function vehicleScope(state: ShopState, vehicleId: string, options: VehicleScopeOptions = {}): ShopState {
  const date = options.today ?? state.businessDate;
  const cutoff = shopCutoff(state.settings);
  const full = new Set<string>();
  const kept = new Set<string>();
  for (const o of state.orders) {
    const work = vanWork(o, vehicleId, date, cutoff);
    if (!work.has) continue;
    kept.add(o.id);
    if (work.open) full.add(o.id);
  }
  for (const taskId of allowedPendingTaskIds(state, vehicleId, options.pendingTaskIds ?? [], options.knownOrderIds)) {
    const o = findOrder(state, orderIdOfTask(taskId));
    if (o) kept.add(o.id);
  }
  // 결제로 이어진 접수(대신 내는 팀 · 대신 받는 팀). 한 번만 넓힌다(이어진 접수의 이어진 접수는 기사 판이 읽지 않는다).
  const core = [...kept];
  for (const id of core) {
    const o = findOrder(state, id)!;
    for (const payer of [o.payerOrderId, ...o.lines.map((l) => l.payerOrderId)]) if (payer && findOrder(state, payer)) kept.add(payer);
  }
  for (const other of state.orders) {
    if (kept.has(other.id)) continue;
    if ([other.payerOrderId, ...other.lines.map((l) => l.payerOrderId)].some((payer) => payer !== undefined && core.includes(payer))) kept.add(other.id);
  }

  const orders = state.orders.filter((o) => kept.has(o.id)).map((o) => {
    const copy = structuredClone(o);
    if (!full.has(o.id)) copy.phone = maskPhone(o.phone);
    return copy;
  });
  const orderIds = new Set(orders.map((o) => o.id));
  const assetRefs = new Set(orders.flatMap((o) => o.lines.flatMap((l) => [...(l.assetIds ?? []), ...(l.plannedAssetIds ?? []), ...(l.backAssetIds ?? [])])));
  const assets: FxAsset[] = state.assets.filter((a) => a.vehicleId === vehicleId || assetRefs.has(a.id)).map((a) => ({ ...a }));
  const groupIds = new Set(orders.flatMap((o) => o.payments.map((p) => p.groupId).filter((g): g is string => g !== undefined)));
  const taskIds = new Set(orders.flatMap((o) => [...orderTasks(o).map((t) => t.id), 'deliver:' + o.id]));
  const since = kstDate(kstAt(date, -CLOSING_DAYS, 12, 0));
  const closings: FxClosing[] = state.closings.filter((c) => c.date >= since).map((c) => ({ date: c.date, closedAt: c.closedAt, counts: [], deferredTransferIds: [] }));
  return {
    ...state,
    registry: structuredClone(state.registry),
    settings: structuredClone(state.settings),
    orders,
    pins: state.pins.filter((p) => orderIds.has(p.orderId) && (p.vehicleId ?? pinTask(state, p)?.promise.vehicleId) === vehicleId).map((p) => ({ ...p })),
    routeRanks: Object.fromEntries(Object.entries(state.routeRanks).filter(([id]) => taskIds.has(id))),
    outcomes: {},
    driverDevice: { offline: false, queue: [] },
    assets,
    vanSpares: (state.vanSpares ?? []).filter((x) => x.vehicleId === vehicleId).map((x) => ({ ...x })),
    deposits: state.deposits.filter((d) => orderIds.has(d.orderId)).map((d) => structuredClone(d)),
    paymentGroups: state.paymentGroups.filter((g) => groupIds.has(g.id)).map((g) => ({ ...g })),
    drawers: state.drawers.map((d) => ({ ...d })),
    cashTransfers: state.cashTransfers.filter((t) => t.vehicleId === vehicleId).map((t) => structuredClone(t)),
    closings,
    vanReceipts: (state.vanReceipts ?? []).filter((r) => r.vehicleId === vehicleId).map((r) => ({ ...r })),
    storyApplied: [],
    staff: (state.staff ?? []).filter((s) => s.id === options.staffId).map((s) => ({ ...s })),
    reviews: [],
  };
}

/**
 * 사본에서 서버가 '이 기기에 앞서 보낸 접수'(knownOrderIds)로 기억할 접수(§17 R3-8): 이 차량과 이어진 접수(배달 · 수거 업무의 차량)만. 결제로만
 * 이어진 접수 · 보냄 대기로만 남은 접수는 넣지 않는다: 위조한 대기 업무 id로 결제 고리를 따라 다른 팀을 한 사본씩 끌어오지 못하게(한 번 넓히기는
 * 이 차량과 이어졌던 접수에서만).
 */
export function vanOrderIds(scoped: ShopState, vehicleId: string): string[] {
  return scoped.orders.filter((o) => orderVans(o).includes(vehicleId)).map((o) => o.id);
}

/** 사본에 온전한 번호로 실린 접수 id(개인정보 열람 기록의 줄 수, deployment 10-4). */
export function fullNumberOrders(scoped: ShopState): string[] {
  return scoped.orders.filter((o) => o.phone !== '' && !o.phone.includes('*')).map((o) => o.id);
}

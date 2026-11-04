// 기사 세션의 조회 규칙(plan §5-4, D17; work/impl-offline/plan.md §4-1). 서버의 권한 확인(permissions.js queryAccess)과 기사 기기의 사본 읽기
// (LocalClient)가 같은 표로 거절한다: 사본으로 읽을 때도 서버가 막는 것은 막는다.
//   allow: 누구나(화면 설정) · own_list: 수거 · 배달 목록(차량을 자기 차량으로 바꿔 읽음) · own_vehicle: 자기 차량의 짐 ·
//   task_scope: 그 업무 · 접수가 자기 차량에 있을 때만 · deny: 기사 세션은 읽지 못함(장부 · 접수증 · 카운터의 판).

export type DriverQueryRule = 'allow' | 'own_list' | 'own_vehicle' | 'task_scope' | 'deny';

/** 조회 이름(장부 화면은 'ledgerView:<화면>')마다 기사 세션의 규칙. 없는 이름은 deny. */
export const DRIVER_QUERY_RULES: Readonly<Record<string, DriverQueryRule>> = /* @__PURE__ */ Object.freeze({
  config: 'allow',
  'ledgerView:collection_list': 'own_list',
  'ledgerView:delivery_list': 'own_list',
  'ledgerView:day_ledger': 'deny',
  vehicleLoad: 'own_vehicle',
  taskSheet: 'task_scope',
  fieldPaySheet: 'task_scope',
  addTicketSheet: 'task_scope',
  confirmDraft: 'task_scope',
  orderSlip: 'deny',
  findLast4: 'deny',
  reviewList: 'deny',
  orderDraft: 'deny',
  checkoutSheet: 'deny',
  groupPaySheet: 'deny',
  partialPaySheet: 'deny',
  promiseSheet: 'deny',
  returnSheet: 'deny',
  closingSheet: 'deny',
  shopRules: 'deny',
  shopSettings: 'deny',
  discountSheet: 'deny',
  cancelSheet: 'deny',
  exchangeSheet: 'deny',
  ticketBoard: 'deny',
  ticketLossSheet: 'deny',
  spareSheet: 'deny',
  // 전화 창(features-1 §8-4): 자기 차량의 업무(배달 · 수거)가 있는 접수만(도메인 queryScope).
  phoneReveal: 'task_scope',
  // 초과 수납의 환불 창(features-1 §9-1): 카운터 화면.
  refundSheet: 'deny',
});

/** 조회의 규칙 열쇠(장부 화면은 'ledgerView:<화면>'). */
export const driverQueryKey = (name: string, viewKey?: string): string => (name === 'ledgerView' ? 'ledgerView:' + (viewKey ?? '') : name);

/** 기사 세션의 규칙(없는 이름은 deny). */
export const driverQueryRule = (key: string): DriverQueryRule => DRIVER_QUERY_RULES[key] ?? 'deny';

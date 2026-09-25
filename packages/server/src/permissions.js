// @ts-check
// 명령 · 조회의 권한 표(plan §5-4, D17). 역할의 권한은 매장 파일(roles · role_permissions)에서 오고, 세션이 정한다(봉투가 아니다).
//
// 기사 세션 = 기사 기기(driver_tablet · driver_phone)에서 로그인했거나 역할이 기사인 세션. 기사 세션은 자기 차량(기기의 vehicle_id,
// 없으면 기사의 기본 차량)의 일만 한다(거절이 기본):
//   - 명령: 표에서 vehicle이 참인 명령만 되고, 저장소가 넘긴 범위(도메인 commandScope)가 { kind: 'vehicle', vehicleIds }이고 그 안에
//     자기 차량이 있어야 한다. vehicle이 없는 명령(수납 · 접수 · 보증금 · 일정 변경 · 현금 점검 · 마감 · 매장 설정 · 빨리 확인)은 기사
//     세션에서 역할과 관계없이 FORBIDDEN_SCOPE(`이 기기에서 사용 불가`) — 잃어버린 기사 휴대폰에서 관리자 비밀번호를 맞혀도 매장 전체의 돈 ·
//     마감을 할 수 없게. 역할에 권한이 없으면 FORBIDDEN(`권한 없음 · 관리자 확인 필요`). 둘 다 끝난 거절(retryable 0)로 command_log에
//     남는다. 권한 확인은 멱등 확인 뒤에 돈다(이미 적용한 재전송은 저장한 결과).
//   - 조회: 수거 · 배달 목록은 차량을 자기 차량으로 바꿔 읽는다. 차량 짐은 자기 차량만. 업무 판 · 현장 수납 · 리프트권 추가 · 확인 창
//     초안은 그 업무 · 접수가 자기 차량에 있을 때만(도메인 queryScope). 장부 · 접수증 · 끝 4자리 · 카운터의 판은 403.
// 도둑맞기 쉬운 기사 휴대폰으로 모든 손님과 돈을 읽을 수 없게 한다.

import { isDriverDevice } from '@skinote/contract';
import { PRODUCTION_LINES } from '@skinote/domain';

/**
 * @typedef {import('@skinote/contract').AnyCommandEnvelope} AnyCommandEnvelope
 * @typedef {import('@skinote/contract').CommandOutcome} CommandOutcome
 * @typedef {import('@skinote/contract').CommandType} CommandType
 * @typedef {import('@skinote/store').CommandScope} CommandScope
 * @typedef {import('./shops.js').QueryScope} QueryScope
 * @typedef {{ perm: string, driverPerm?: string | null, vehicle?: boolean, leaveUnpaid?: boolean }} CommandRule
 * @typedef {{
 *   roleKey: string,
 *   deviceKind: import('@skinote/contract').DeviceKind,
 *   vehicleId?: string,
 * }} Who
 */

/** 명령 → 권한(카운터 · 관리자), 기사 세션의 권한(없으면 같은 것, null이면 권한 없이), 자기 차량 규칙. */
/** @type {Readonly<Record<CommandType, CommandRule>>} */
export const COMMAND_PERMISSIONS = Object.freeze({
  'stock.issue': { perm: 'stock.move', vehicle: true },
  'stock.direct_return': { perm: 'stock.move', vehicle: true },
  'stock.load': { perm: 'stock.move', vehicle: true },
  'stock.collect': { perm: 'stock.move', vehicle: true },
  'stock.deliver': { perm: 'stock.move', vehicle: true },
  'stock.receive': { perm: 'stock.receive', vehicle: true },
  'payment.take': { perm: 'payment.take' },
  'payment_promise.set': { perm: 'payment.take', driverPerm: 'payment.collect_field', vehicle: true, leaveUnpaid: true },
  'promise.change': { perm: 'order.promise.change' },
  'order.create': { perm: 'order.create' },
  'deposit.take': { perm: 'deposit.take' },
  'deposit.return': { perm: 'deposit.return' },
  'field.collect': { perm: 'payment.collect_field', vehicle: true },
  'field.add_ticket': { perm: 'order.add', vehicle: true },
  'field.deposit_return': { perm: 'deposit.return_field', vehicle: true },
  'cash.transfer': { perm: 'cash.transfer', vehicle: true },
  'cash.transfer_confirm': { perm: 'cash.transfer.confirm' },
  'closing.close': { perm: 'closing.close' },
  'setting.set': { perm: 'settings.manage' },
  'route.move': { perm: 'route.reorder', vehicle: true },
  'route.reset': { perm: 'route.reorder', vehicle: true },
  'task.pin': { perm: 'task.pin' },
  'task.unpin': { perm: 'task.pin' },
  'task.visit': { perm: 'task.visit', vehicle: true },
  'notification.ack': { perm: 'task.pin', driverPerm: null, vehicle: true },
});

/** 기사 세션인가(기사 기기 또는 기사 역할). @param {Who} who */
export const isDriverSession = who => isDriverDevice(who.deviceKind) || who.roleKey === 'driver';

/** 거절(저장소가 요청번호 · rev · epoch · 바탕 rev를 채운다). @param {string} code @param {string} message */
const refusal = (code, message) => /** @type {CommandOutcome} */ (/** @type {unknown} */ ({ outcome: 'rejected', error: { code, message } }));

/**
 * 저장소에 넘길 권한 확인(guard). 거절이면 결과(FORBIDDEN · FORBIDDEN_SCOPE), 괜찮으면 null.
 * @param {Who} who @param {Map<string, string>} permissions 역할의 권한 → 범위 @param {AnyCommandEnvelope} envelope
 * @param {(line: string) => void} [log]
 * @returns {(scope: CommandScope) => CommandOutcome | null}
 */
export function commandGuard(who, permissions, envelope, log = () => {}) {
  const rule = COMMAND_PERMISSIONS[envelope.type];
  const driver = isDriverSession(who);
  return scope => {
    const need = driver && rule.driverPerm !== undefined ? rule.driverPerm : rule.perm;
    if (need !== null && !permissions.has(need)) {
      log(`명령 거절 FORBIDDEN ${envelope.type}`);
      return refusal('FORBIDDEN', PRODUCTION_LINES.forbidden);
    }
    if (!driver) return null;
    if (!rule.vehicle) {
      log(`명령 거절 FORBIDDEN_SCOPE ${envelope.type}`);
      return refusal('FORBIDDEN_SCOPE', PRODUCTION_LINES.forbiddenScope);
    }
    const own = who.vehicleId;
    const inScope = own !== undefined && scope.kind === 'vehicle' && scope.vehicleIds.includes(own);
    // 후불 처리(현장 수납 판)는 그 업무의 접수 자기 몫만: 다른 팀을 결제 팀으로 두지 않는다.
    const leaveUnpaidOk = !rule.leaveUnpaid || (envelope.type === 'payment_promise.set' && envelope.payload.payerOrderId === null
      && scope.kind === 'vehicle' && scope.orderId === envelope.payload.orderId);
    if (!inScope || !leaveUnpaidOk) {
      log(`명령 거절 FORBIDDEN_SCOPE ${envelope.type}`);
      return refusal('FORBIDDEN_SCOPE', PRODUCTION_LINES.forbiddenScope);
    }
    return null;
  };
}

/** 조회 이름마다 기사 세션의 규칙. */
/** @type {Readonly<Record<string, 'allow' | 'own_list' | 'own_vehicle' | 'task_scope' | 'deny'>>} */
export const DRIVER_QUERY_RULES = Object.freeze({
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
});

/**
 * 조회 권한. 카운터 · 관리자 세션은 모두 읽는다. 기사 세션은 위 표. 허락이면 읽을 인자(수거 · 배달 목록은 차량을 자기 차량으로 바꾼 것).
 * @param {Who} who @param {import('@skinote/contract').WireQuery} query
 * @param {() => QueryScope | null} scopeOf 도메인 queryScope(업무 · 접수 → 차량). 모르면 null(거절).
 * @returns {{ ok: true, query: import('@skinote/contract').WireQuery } | { ok: false }}
 */
export function queryAccess(who, query, scopeOf) {
  if (!isDriverSession(who)) return { ok: true, query };
  const key = query.name === 'ledgerView' ? 'ledgerView:' + query.viewKey : query.name;
  const rule = DRIVER_QUERY_RULES[key] ?? 'deny';
  const own = who.vehicleId;
  switch (rule) {
    case 'allow':
      return { ok: true, query };
    case 'own_list':
      if (query.name !== 'ledgerView' || own === undefined) return { ok: false };
      return { ok: true, query: { ...query, params: { ...query.params, vehicleId: own } } };
    case 'own_vehicle':
      return query.name === 'vehicleLoad' && own !== undefined && query.params.vehicleId === own ? { ok: true, query } : { ok: false };
    case 'task_scope': {
      const scope = own === undefined ? null : scopeOf();
      return scope && scope.kind === 'vehicle' && scope.vehicleIds.includes(/** @type {string} */ (own)) ? { ok: true, query } : { ok: false };
    }
    default:
      return { ok: false };
  }
}

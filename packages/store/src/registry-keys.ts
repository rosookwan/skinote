// 매장 목록 행의 id 규칙(plan §4-2). 목록 행은 도메인 key를 id로 쓰고, 도메인에 key가 없는 행(규격 축 · 선택지 · 요금 규칙 …)은 여기의
// 규칙으로 만든다. 쓰는 쪽(registry-write · provision)과 읽는 쪽(registry-read)이 같은 규칙을 쓴다.
import type { FxMethodKey } from '@skinote/domain';

/** 마감 범위 하나(한 카운터 매장, data-model 2-4). */
export const MAIN_SCOPE = 'main';
/** 보증금 결제(미수 차감)의 시스템 결제 수단(payment_methods.is_system). 돈이 움직이지 않는다. */
export const DEPOSIT_METHOD = 'deposit';
/** 보증금 칸(payment_sections.is_system): 보증금 규칙의 받는 수단은 이 칸의 기본 수단이다. */
export const DEPOSIT_SECTION = 'lift_deposit';
/** 현금 수단(payment_methods.affects_cash_drawer = 1). */
export const CASH_METHOD: FxMethodKey = 'cash';
/** 상품의 '함께 나가는 것' 글(FxProduct.includes)을 담는 상품 속성. */
export const INCLUDES_ATTRIBUTE = 'includes_note';
/** 리프트권 발권처(ticket_products · ticket_units의 거래처). */
export const TICKET_VENDOR = 'resort_vendor';
/** 기본 요금표와 그 첫 판. */
export const PRICE_LIST = 'standard';
export const PRICE_VERSION = 'standard:1';
/** 재고 위치: 바깥(기초 재고의 출발) · 매장 · 차량 · 손님(접수마다, 처음 쓸 때 만든다). */
export const EXTERNAL_LOCATION = 'external';
export const SHOP_LOCATION = 'shop';
export const vehicleLocation = (vehicleId: string) => 'vehicle:' + vehicleId;
export const customerLocation = (orderId: string) => 'cust:' + orderId;
/** 실물 상태 하나(정상). */
export const OK_CONDITION = 'ok';
/** 청구 조정 종류: 연장(+)과 연장 취소(−, plan §3-3 7). */
export const EXTENSION = 'extension';
export const EXTENSION_UNDO = 'extension_undo';

export const axisAttribute = (kindKey: string) => 'axis:' + kindKey;
export const axisOption = (kindKey: string, variantKey: string) => 'axis:' + kindKey + ':' + variantKey;
export const variantId = (productKey: string, variantKey: string) => productKey + ':' + variantKey;
export const priceRuleId = (productKey: string) => PRICE_VERSION + ':' + productKey;
export const reasonId = (domain: string, key: string) => domain + ':' + key;
export const kindTargetSeq = (index: number) => index + 1;

/** 사유 영역(sys_reason_domains). 현금 차액 사유는 마감 차액 · 인계 두 영역에 같은 목록을 둔다. */
export const VISIT_RESULT = 'visit_result';
export const CLOSING_DIFFERENCE = 'closing_difference';
export const HANDOVER = 'handover';

/** 설정 key(sys_setting_definitions)와 값 모양. */
export const SETTING = {
  prepayment: 'prepayment_mode',
  sameDayCancel: 'same_day_cancel_refund_default',
  driverSeesDue: 'driver_sees_due_amount',
  maxLineQuantity: 'max_line_quantity',
  openingCash: 'opening_cash',
  defaultReturnSlot: 'default_return_slot',
} as const;

/** 역할(roles.key)과 이름(직원 타일 · 사용 내역). */
export const ROLES = [
  { key: 'manager', label: '관리자' },
  { key: 'counter', label: '카운터' },
  { key: 'driver', label: '기사' },
] as const;

/**
 * 역할의 권한(plan §4-6): 관리자는 모두, 카운터는 매장 설정 · 직원 · 기기 · 마감 해제 밖 모두, 기사는 자기 차량의 일만(own_vehicle).
 * 권한 key는 sys_permissions에 있다(FK). 범위는 그 권한이 허락하는 것 중에서 고른다(scopes_json).
 */
export const COUNTER_EXCLUDED: readonly string[] = ['settings.manage', 'staff.manage', 'device.manage', 'closing.reopen'];
export const DRIVER_PERMISSIONS: readonly string[] = [
  'stock.move', 'stock.receive', 'task.visit', 'route.reorder', 'payment.collect_field', 'deposit.return_field', 'cash.transfer', 'order.add',
];

/** 시스템이 적은 행의 행위자(명령줄 · 매장 만들기). 화면에 이름이 나올 곳이 생기면 문구 표에서 이름을 정한다. */
export const SYSTEM_ACTOR = 'system:cli';

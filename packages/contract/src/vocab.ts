// 코드 키 어휘(sys_* 표)의 코드 쪽 사본이다. 값은 packages/schema/schema.sql의 시드와 같아야 하고,
// test/vocab.test.ts가 시드를 읽어 맞춰 본다. 화면은 이 키만 비교하고, 문구 · 색 · 순위는 설정에서 가져온다.

export const DEVICE_CLASS_KEYS = ['pos', 'pos_narrow', 'driver_tablet', 'driver_phone', 'print', 'admin'] as const;
export type DeviceClassKey = (typeof DEVICE_CLASS_KEYS)[number];

/** 매장 기기 등급(16px 규칙이 걸리는 등급). admin은 공급자의 숨은 콘솔 전용이라 빠진다. */
export const SHOP_DEVICE_CLASS_KEYS = ['pos', 'pos_narrow', 'driver_tablet', 'driver_phone'] as const satisfies readonly DeviceClassKey[];
export type ShopDeviceClassKey = (typeof SHOP_DEVICE_CLASS_KEYS)[number];

/** 등급 판이 없을 때 찾아가는 순서(ui 3-5). */
export const DEVICE_CLASS_FALLBACK: Readonly<Partial<Record<DeviceClassKey, DeviceClassKey>>> = {
  pos_narrow: 'pos',
  driver_phone: 'driver_tablet',
};

export const STAMP_STATE_KEYS = ['todo', 'partial', 'done', 'na', 'blocked', 'scheduled', 'delegated'] as const;
export type StampStateKey = (typeof STAMP_STATE_KEYS)[number];

export const TONE_KEYS = ['red', 'seal', 'orange', 'green', 'blue', 'purple', 'grey', 'ink'] as const;
export type ToneKey = (typeof TONE_KEYS)[number];
/** 늦은 것에만 쓰는 색(N8). 규칙 검사기와 설정 검사가 읽는다. */
export const LATE_ONLY_TONES: readonly ToneKey[] = ['red'];
/** 도장 주홍. 빨강으로 세지 않고 경고에 쓰지 않는다. */
export const SEAL_TONES: readonly ToneKey[] = ['seal'];

export const STAMP_TONE_BY_STATE: Readonly<Record<StampStateKey, ToneKey>> = {
  todo: 'ink',
  partial: 'orange',
  done: 'seal',
  na: 'grey',
  blocked: 'grey',
  scheduled: 'blue',
  delegated: 'purple',
};

export const COLUMN_RENDERER_KEYS = ['time', 'team', 'items', 'promise', 'place', 'money', 'stamp', 'attribute', 'text', 'vehicle', 'action'] as const;
export type ColumnRendererKey = (typeof COLUMN_RENDERER_KEYS)[number];
export type ColumnBindingKey = 'none' | 'stamp_step' | 'attribute' | 'action';
/** 칸 그리기마다 채워야 할 연결(sys_column_renderers.binding_key). */
export const COLUMN_BINDING: Readonly<Record<ColumnRendererKey, ColumnBindingKey>> = {
  time: 'none', team: 'none', items: 'none', promise: 'none', place: 'none', money: 'none',
  stamp: 'stamp_step', attribute: 'attribute', text: 'none', vehicle: 'none', action: 'action',
};

export const FIT_MODE_KEYS = ['parts', 'items', 'words', 'alts'] as const;
export type FitModeKey = (typeof FIT_MODE_KEYS)[number];

export const FOLD_MODE_KEYS = ['prefix', 'second_line'] as const;
export type FoldModeKey = (typeof FOLD_MODE_KEYS)[number];

export const ALIGN_KEYS = ['start', 'center', 'end'] as const;
export type AlignKey = (typeof ALIGN_KEYS)[number];

export const OVERFLOW_MODE_KEYS = ['more_sheet', 'page', 'fold', 'two_column'] as const;
export type OverflowModeKey = (typeof OVERFLOW_MODE_KEYS)[number];

export const STAMP_ROLLUP_KEYS = ['worst_of', 'first_open'] as const;
export type StampRollupKey = (typeof STAMP_ROLLUP_KEYS)[number];

export const STAMP_RULE_SCOPE = {
  qty_prepared: 'line',
  qty_loaded: 'line',
  qty_issued: 'line',
  qty_collected: 'line',
  qty_returned: 'line',
  ticket_secured: 'line',
  service_closed: 'line',
  order_due_zero: 'order',
  task_done: 'task',
  task_received: 'task',
} as const;
export type StampRuleKey = keyof typeof STAMP_RULE_SCOPE;
export const STAMP_RULE_KEYS = Object.keys(STAMP_RULE_SCOPE) as StampRuleKey[];

export const SCREEN_TEMPLATE_KEYS = ['ledger', 'slip', 'checklist', 'collection_list', 'driver_list', 'tiles', 'form', 'split'] as const;
export type ScreenTemplateKey = (typeof SCREEN_TEMPLATE_KEYS)[number];

export const SCREEN_ROUTES = {
  day_ledger: '/ledger/:date',
  order_slip: '/orders/:orderId',
  new_order: '/orders/new',
  find_last4: '/find/:last4',
  collection_list: '/collections/:date',
  driver_list: '/driver/:date',
  driver_task: '/driver/tasks/:taskId',
  van_stock: '/driver/stock',
  review_list: '/review',
  closing: '/closing/:date',
  lift_tickets: '/tickets',
  lessons: '/lessons/:date',
  stock: '/stock',
  intake_requests: '/intake',
  management: '/manage',
  more: '/more',
} as const;
export type ScreenKey = keyof typeof SCREEN_ROUTES;
export const SCREEN_KEYS = Object.keys(SCREEN_ROUTES) as ScreenKey[];

export const WORKSPACE_KEYS = ['pos', 'management', 'driver'] as const;
export type WorkspaceKey = (typeof WORKSPACE_KEYS)[number];

export const GROUP_KEYS = ['time_bucket', 'return_slot', 'place', 'area', 'vehicle'] as const;
export type GroupKey = (typeof GROUP_KEYS)[number];

export const SORT_KEY_IS_TIME = { next_due_at: true, promised_at: true, manual_route: false, receipt_no: false } as const;
export type SortKey = keyof typeof SORT_KEY_IS_TIME;
export const SORT_KEYS = Object.keys(SORT_KEY_IS_TIME) as SortKey[];

export const LEDGER_FILTER_KEYS = ['all', 'pickup', 'return', 'unpaid', 'vehicle', 'lessons', 'open_tasks', 'collected', 'remaining', 'pinned'] as const;
export type LedgerFilterKey = (typeof LEDGER_FILTER_KEYS)[number];

export const LEDGER_METRIC_KEYS = ['team_count', 'issued_count', 'returned_count', 'due_total', 'collected_count', 'pending_count', 'remaining_count', 'vehicle_load'] as const;
export type LedgerMetricKey = (typeof LEDGER_METRIC_KEYS)[number];

export const CONDITION_SCOPE = {
  always: 'any',
  vehicle_pickup: 'line',
  vehicle_return: 'line',
  return_required: 'line',
  exchangeable: 'line',
  extendable: 'line',
  partial_cancel_allowed: 'line',
  has_open_tasks: 'order',
  has_due: 'order',
  has_items_out: 'line',
  before_last_return_slot: 'view',
  after_last_return_slot: 'view',
} as const;
export type ConditionKey = keyof typeof CONDITION_SCOPE;
export const CONDITION_KEYS = Object.keys(CONDITION_SCOPE) as ConditionKey[];

export type ActionKindKey = 'stamp' | 'command' | 'screen' | 'device' | 'next';
export const ACTION_KIND = {
  'stamp.issue': 'stamp',
  'stamp.return': 'stamp',
  'stamp.load': 'stamp',
  'stamp.collect': 'stamp',
  'stamp.receive': 'stamp',
  'stamp.ticket_secure': 'stamp',
  'stamp.lesson_done': 'stamp',
  'stamp.pay': 'stamp',
  'stamp.prepare': 'stamp',
  'stamp.ticket_hand_out': 'stamp',
  next_step: 'next',
  new_order: 'screen',
  close_day: 'screen',
  receive_to_shop: 'command',
  pay: 'command',
  change_promise: 'command',
  exchange: 'command',
  extend: 'command',
  cancel: 'command',
  early_return: 'command',
  print: 'command',
  call: 'device',
  not_collected: 'command',
  not_delivered: 'command',
  field_collect: 'command',
  leave_unpaid: 'command',
  add_ticket: 'command',
  exchange_swap: 'command',
  move_up: 'command',
  move_down: 'command',
  move_top: 'command',
  route_reset: 'command',
  pin: 'command',
  open_slip: 'screen',
} as const satisfies Record<string, ActionKindKey>;
export type ActionKey = keyof typeof ACTION_KIND;
export const ACTION_KEYS = Object.keys(ACTION_KIND) as ActionKey[];

/** 동작의 기본 이름(sys_actions.label). 주 버튼 · 옆 동작 · 확인 창 제목이 쓴다(매장 문구 표가 생기면 그쪽이 먼저). */
export const ACTION_LABELS = {
  'stamp.issue': '지급 도장',
  'stamp.return': '반납 도장',
  'stamp.load': '적재 도장',
  'stamp.collect': '받음 도장',
  'stamp.receive': '입고 도장',
  'stamp.ticket_secure': '발권 도장',
  'stamp.lesson_done': '강습 도장',
  'stamp.pay': '수납 도장',
  'stamp.prepare': '준비 도장',
  'stamp.ticket_hand_out': '권 지급 도장',
  next_step: '다음 할 일',
  new_order: '새 접수',
  close_day: '마감',
  receive_to_shop: '매장 입고',
  pay: '수납',
  change_promise: '약속 바꾸기',
  exchange: '교환',
  extend: '연장',
  cancel: '접수 취소',
  early_return: '조기 반납',
  print: '인쇄',
  call: '전화',
  not_collected: '못 받음',
  not_delivered: '못 전함',
  field_collect: '현장 수납',
  leave_unpaid: '미수로 두기',
  add_ticket: '리프트권 추가',
  exchange_swap: '바꿔 드림',
  move_up: '▲',
  move_down: '▼',
  move_top: '맨 위로',
  route_reset: '시간순 되돌리기',
  pin: '빨리 확인',
  open_slip: '접수증 열기',
} as const satisfies Record<ActionKey, string>;

/**
 * 동작이 보내는 명령(sys_actions.command_key). 같은 명령을 하는 동작은 한 화면에 한 번만 보인다
 * (주황 주 버튼 '수납 도장'과 옆 동작 '수납'은 둘 다 payment.take).
 */
export const ACTION_COMMAND = {
  'stamp.issue': 'stock.issue',
  'stamp.return': 'stock.direct_return',
  'stamp.load': 'stock.load',
  'stamp.collect': 'stock.collect',
  'stamp.receive': 'stock.receive',
  'stamp.ticket_secure': 'ticket.allocate',
  'stamp.lesson_done': 'lesson.close',
  'stamp.pay': 'payment.take',
  'stamp.prepare': 'preparation.set',
  'stamp.ticket_hand_out': 'ticket.hand_out',
  next_step: null,
  new_order: null,
  close_day: null,
  receive_to_shop: 'stock.receive',
  pay: 'payment.take',
  change_promise: 'promise.change',
  exchange: 'exchange.request',
  extend: 'order.extend',
  cancel: 'order.cancel',
  early_return: 'early_return.create',
  print: 'print.request',
  call: null,
  not_collected: 'task.visit',
  not_delivered: 'task.visit',
  field_collect: 'field.collect',
  leave_unpaid: 'payment_promise.set',
  add_ticket: 'field.add_ticket',
  exchange_swap: 'exchange.swap',
  move_up: 'route.move',
  move_down: 'route.move',
  move_top: 'route.move',
  route_reset: 'route.reset',
  pin: 'task.pin',
  open_slip: null,
} as const satisfies Record<ActionKey, string | null>;

/** 동작이 여는 화면(sys_actions.screen_key, 종류 'screen'만). */
export const ACTION_SCREEN = {
  new_order: 'new_order',
  close_day: 'closing',
  open_slip: 'order_slip',
} as const satisfies Partial<Record<ActionKey, ScreenKey>>;

export const FEATURE_KEYS = [
  'vehicles', 'night_collection', 'lift_tickets', 'lessons', 'size_preinput', 'partner_ledger', 'deposits', 'prepayment',
  'exchange', 'driver_field_payment', 'multi_order_payment', 'split_payment', 'card_terminal', 'sms', 'bundles',
  'advanced_pricing', 'branches', 'label_printer', 'customer_profiles',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const ROW_GRAIN_KEYS = ['order', 'order_line', 'task', 'service_booking', 'asset'] as const;
export type RowGrainKey = (typeof ROW_GRAIN_KEYS)[number];

export const CONFIRM_TEMPLATE_KEYS = [
  'issue', 'return', 'load', 'collect', 'receive', 'pay', 'ticket_secure', 'lesson_close', 'prepare', 'visit_result', 'field_payment', 'add_ticket',
  'swap',
] as const;
export type ConfirmTemplateKey = (typeof CONFIRM_TEMPLATE_KEYS)[number];

export const STATUS_DOMAIN_KEYS = ['order', 'line', 'task', 'pay_state', 'promise', 'booking', 'stamp'] as const;
export type StatusDomainKey = (typeof STATUS_DOMAIN_KEYS)[number];

export const ORIGIN_KEYS = ['system', 'template', 'shop'] as const;
export type OriginKey = (typeof ORIGIN_KEYS)[number];

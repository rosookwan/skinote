// @ts-check
// 스모크 88개(옛 review/validate2.cjs의 동작 시험). 실행기로 마이그레이션을 적용한 매장 파일(메모리) 하나 위에서
// 차례로 돈다: 앞 시험이 넣은 행을 뒤 시험이 쓴다. 옛 스크립트에서 시험 사이에 있던 준비 문장은 다음 시험의 setup으로 옮겼다.
// 거절 시험은 오류 글이 기대한 제약(FOREIGN KEY, CHECK, APPEND_ONLY …) 때문인지까지 확인한다.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { migratedMemoryDb } from './helpers.js';

const EXPECTED_SMOKE_TESTS = 88;
const shop = migratedMemoryDb('shop');
after(() => shop.close());

const T = '2026-12-26T06:40:00.000Z';
/** @param {string} sql @param {...any} args */
const run = (sql, ...args) => shop.prepare(sql).run(...args);

let registered = 0;
/**
 * @param {string} name
 * @param {() => void} fn
 * @param {{ setup?: () => void }} [options]
 */
function ok(name, fn, { setup } = {}) {
  registered += 1;
  test(name, () => {
    setup?.();
    fn();
  });
}
/**
 * @param {string} name
 * @param {() => void} fn
 * @param {RegExp} pattern
 * @param {{ setup?: () => void }} [options]
 */
function rejects(name, fn, pattern, { setup } = {}) {
  registered += 1;
  test(name, () => {
    setup?.();
    assert.throws(fn, pattern);
  });
}

// ---- 두 매장과 기본 레지스트리 ---------------------------------------------------------------
for (const s of ['S1', 'S2']) {
  run(`INSERT INTO shops (id, code, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, s, s.toLowerCase(), s, T, T);
  run(`INSERT INTO closing_scopes (shop_id, id, key, label, created_at, updated_at) VALUES (?, 'main', 'main', '매장', ?, ?)`, s, T, T);
  run(`INSERT INTO roles (shop_id, id, key, label, created_at, updated_at) VALUES (?, 'r-counter', 'counter', '카운터', ?, ?)`, s, T, T);
  run(`INSERT INTO staff_members (shop_id, id, display_name, role_id, created_at, updated_at) VALUES (?, 'st-1', '김사장', 'r-counter', ?, ?)`, s, T, T);
  run(`INSERT INTO payment_methods (shop_id, id, key, label, affects_cash_drawer, created_at, updated_at) VALUES (?, 'cash', 'cash', '현금', 1, ?, ?)`, s, T, T);
  run(`INSERT INTO payment_methods (shop_id, id, key, label, affects_cash_drawer, created_at, updated_at) VALUES (?, 'card', 'card', '카드', 0, ?, ?)`, s, T, T);
  run(`INSERT INTO payment_sections (shop_id, id, key, label, created_at, updated_at) VALUES (?, 'gear', 'gear', '장비', ?, ?)`, s, T, T);
  run(`INSERT INTO discount_groups (shop_id, id, key, label, created_at, updated_at) VALUES (?, 'gear', 'gear', '장비', ?, ?)`, s, T, T);
  run(`INSERT INTO item_kinds (shop_id, id, key, label, fulfillment_mode_key, tracking_key, return_policy_key, default_price_basis_key, payment_section_id, discount_group_id, unit_label, created_at, updated_at)
       VALUES (?, 'equipment', 'equipment', '장비', 'rental', 'unit', 'required', 'per_day', 'gear', 'gear', '대', ?, ?)`, s, T, T);
  run(`INSERT INTO catalog_items (shop_id, id, item_kind_id, label, created_at, updated_at) VALUES (?, 'ski', 'equipment', '스키', ?, ?)`, s, T, T);
  run(`INSERT INTO catalog_items (shop_id, id, item_kind_id, label, created_at, updated_at) VALUES (?, 'board', 'equipment', '보드', ?, ?)`, s, T, T);
  run(`INSERT INTO asset_conditions (shop_id, id, key, label, issuable) VALUES (?, 'ready', 'ready', '사용 가능', 1)`, s);
  run(`INSERT INTO stock_locations (shop_id, id, kind_key, label, created_at) VALUES (?, 'loc-shop', 'shop', '매장', ?)`, s, T);
  run(`INSERT INTO stock_locations (shop_id, id, kind_key, label, created_at) VALUES (?, 'loc-ext', 'external', '외부', ?)`, s, T);
  run(`INSERT INTO cash_drawers (shop_id, id, kind_key, label, created_at, updated_at) VALUES (?, 'counter-1', 'counter', '카운터', ?, ?)`, s, T, T);
  run(`INSERT INTO business_days (shop_id, business_date, updated_at) VALUES (?, '2026-12-26', ?)`, s, T);
  run(`INSERT INTO adjustment_types (shop_id, id, key, label, report_group_key, sign, created_at, updated_at) VALUES (?, 'cancellation', 'cancellation', '취소', 'charge', -1, ?, ?)`, s, T, T);
  run(`INSERT INTO adjustment_types (shop_id, id, key, label, report_group_key, sign, created_at, updated_at) VALUES (?, 'extension', 'extension', '연장', 'charge', 1, ?, ?)`, s, T, T);
}
/** @param {string} s @param {string} id */
const order = (s, id) => {
  run(`INSERT INTO orders (shop_id, id, customer_name, booking_channel_key, business_date, config_rev, created_at, created_by, created_rev, updated_at)
       VALUES (?, ?, '박준호', 'walk_in', '2026-12-26', 1, ?, 'staff:st-1', 1, ?)`, s, id, T, T);
  run(`INSERT INTO order_batches (shop_id, id, order_id, seq, label, business_date, posting_date, created_at, created_by) VALUES (?, ?, ?, 1, '첫 접수', '2026-12-26', '2026-12-26', ?, 'staff:st-1')`, s, id + '-b1', id, T);
  run(`INSERT INTO order_lines (shop_id, id, order_id, batch_id, catalog_item_id, item_kind_id, fulfillment_mode_key, tracking_key, return_policy_key, payment_section_id, discount_group_id,
        label, unit_label, quantity, start_date, end_date, price_basis_key, billable_units, unit_price, gross_amount, discount_amount, net_amount, price_source_key, price_engine_key,
        created_at, created_by, created_rev, updated_at)
       VALUES (?, ?, ?, ?, 'ski', 'equipment', 'rental', 'unit', 'required', 'gear', 'gear', '스키', '대', 2, '2026-12-26', '2026-12-26', 'per_day', 1, 40000, 80000, 0, 80000, 'rule', 'per_day@1', ?, 'staff:st-1', 1, ?)`,
  s, id + '-l1', id, id + '-b1', T, T);
};
order('S1', 'O1');
order('S1', 'O2');
order('S2', 'O9');

// ---- 매장 경계와 약속 -----------------------------------------------------------------------
rejects('cross-shop reference is refused', () =>
  run(`INSERT INTO line_promises (shop_id, id, order_id, line_id, promise_type_key, method_key, quantity, promised_date, config_rev, created_at, created_by, created_rev)
       VALUES ('S1', 'p-x', 'O9', 'O9-l1', 'return', 'shop_direct', 1, '2026-12-26', 1, ?, 'staff:st-1', 1)`, T), /FOREIGN KEY/);
rejects('promise method must match promise type', () =>
  run(`INSERT INTO line_promises (shop_id, id, order_id, line_id, promise_type_key, method_key, quantity, promised_date, config_rev, created_at, created_by, created_rev)
       VALUES ('S1', 'p-y', 'O1', 'O1-l1', 'return', 'vehicle_delivery', 1, '2026-12-26', 1, ?, 'staff:st-1', 1)`, T), /FOREIGN KEY/);
ok('valid return promise', () =>
  run(`INSERT INTO line_promises (shop_id, id, order_id, line_id, promise_type_key, method_key, quantity, promised_date, promised_time, config_rev, created_at, created_by, created_rev)
       VALUES ('S1', 'p-1', 'O1', 'O1-l1', 'return', 'shop_direct', 2, '2026-12-26', '16:30', 1, ?, 'staff:st-1', 1)`, T));

// ---- 돈 -------------------------------------------------------------------------------------
/** @param {string} id @param {number} amount @param {{ kind?: string, card?: number, drawer?: string | null, intent?: string, approval?: string, refundOf?: string }} [o] */
const pay = (id, amount, o = {}) => run(`INSERT INTO payments (shop_id, id, kind_key, kind_requires_refund_of, kind_requires_deposit, kind_cash_sign, purpose_key, method_id, method_affects_cash, amount, cash_drawer_id,
    payment_intent_id, approval_no, refund_of_payment_id, closing_scope_id, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
  VALUES ('S1', ?, ?, ?, 0, ?, 'charge', ?, ?, ?, ?, ?, ?, ?, 'main', ?, ?, '2026-12-26', '2026-12-26', 'staff:st-1', '김사장', ?, 2)`,
id, o.kind || 'payment', o.kind === 'refund' ? 1 : 0, o.kind === 'refund' ? -1 : 1, o.card ? 'card' : 'cash', o.card ? 0 : 1, amount,
'drawer' in o ? o.drawer ?? null : (o.card ? null : 'counter-1'), o.intent || null, o.approval || null, o.refundOf || null, T, T, 'rq-' + id);
/** @param {string} payment @param {number} seq @param {string} orderId @param {string | null} lineId @param {number} amount @param {{ qty?: number, realloc?: string }} [extra] */
const alloc = (payment, seq, orderId, lineId, amount, extra = {}) => run(`INSERT INTO payment_allocations (shop_id, payment_id, seq, order_id, line_id, amount, allocated_quantity, reallocation_id, business_date, posting_date, actor_key, request_id, created_rev)
  VALUES ('S1', ?, ?, ?, ?, ?, ?, ?, '2026-12-26', '2026-12-26', 'staff:st-1', 'rq-al', 2)`, payment, seq, orderId, lineId, amount, extra.qty ?? null, extra.realloc ?? null);
ok('one card payment for two teams', () => {
  pay('pay-1', 160000, { card: 1, approval: '77770001' });
  alloc('pay-1', 1, 'O1', 'O1-l1', 80000);
  alloc('pay-1', 2, 'O2', 'O2-l1', 80000);
});
rejects('allocation to a line of another order', () => alloc('pay-1', 3, 'O1', 'O2-l1', 1), /FOREIGN KEY/);
rejects('negative allocation outside a reallocation', () => alloc('pay-1', 4, 'O1', null, -5000), /CHECK/);
ok('same approval number on another payment is recorded (review item, never a rejection)', () => pay('pay-2', 1000, { card: 1, approval: '77770001' }));
rejects('cash payment without a drawer', () => pay('pay-4', 1000, { drawer: null }), /CHECK/);
rejects('card payment put in a drawer', () => pay('pay-5', 1000, { card: 1, drawer: 'counter-1' }), /CHECK/);
rejects('refund that names no payment', () => pay('pay-6', 1000, { kind: 'refund' }), /CHECK/);
rejects('payment copying a wrong method flag', () => run(`INSERT INTO payments (shop_id, id, kind_key, kind_requires_refund_of, kind_requires_deposit, kind_cash_sign, purpose_key, method_id, method_affects_cash, amount,
    occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
  VALUES ('S1','pay-7','payment',0,0,1,'charge','cash',0,100,?,?,'2026-12-26','2026-12-26','staff:st-1','김사장','rq-7',2)`, T, T), /FOREIGN KEY/);
ok('refund linked to its payment', () => pay('pay-8', 1000, { kind: 'refund', refundOf: 'pay-2', card: 1 }));
ok('cash payment into the counter drawer', () => pay('pay-9', 5000));
rejects('a method flag cannot be edited while money uses it', () => run(`UPDATE payment_methods SET affects_cash_drawer = 0 WHERE shop_id = 'S1' AND id = 'cash'`), /FOREIGN KEY/);
rejects('payment row cannot be updated', () => run(`UPDATE payments SET amount = 1 WHERE id = 'pay-1'`), /APPEND_ONLY/);
rejects('payment row cannot be deleted', () => run(`DELETE FROM payments WHERE id = 'pay-1'`), /APPEND_ONLY/);
rejects('INSERT OR REPLACE cannot overwrite a payment (recursive_triggers)', () => run(`INSERT OR REPLACE INTO payments (shop_id, id, kind_key, kind_requires_refund_of, kind_requires_deposit, kind_cash_sign, purpose_key, method_id, method_affects_cash, amount,
    occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
  VALUES ('S1','pay-1','payment',0,0,1,'charge','card',0,1,?,?,'2026-12-26','2026-12-26','staff:st-1','김사장','rq-1',2)`, T, T), /APPEND_ONLY/);
ok('a free-text reason can be redacted', () => run(`UPDATE payments SET reason = '(지움)' WHERE id = 'pay-1'`));
rejects('a free-text reason cannot be edited', () => run(`UPDATE payments SET reason = '고침' WHERE id = 'pay-2'`), /REDACT_ONLY/);
rejects('posting date before business date', () =>
  run(`INSERT INTO payments (shop_id, id, kind_key, kind_requires_refund_of, kind_requires_deposit, kind_cash_sign, purpose_key, method_id, method_affects_cash, amount, cash_drawer_id, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
       VALUES ('S1','pay-3','payment',0,0,1,'charge','cash',1,100,'counter-1',?,?,'2026-12-26','2026-12-25','staff:st-1','김사장','rq-3',2)`, T, T), /CHECK/);
rejects('split allocation whose quantity sign disagrees with the amount', () => alloc('pay-1', 5, 'O1', 'O1-l1', -80000, { qty: 2, realloc: 'ra-1' }), /CHECK/, {
  setup: () => run(`INSERT INTO payment_reallocations (shop_id, id, payment_id, reason, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev) VALUES ('S1','ra-1','pay-1','옮김',?,?,'2026-12-26','2026-12-26','staff:st-1','김사장','rq-ra',3)`, T, T),
});
ok('split allocation reversed with a signed quantity', () => alloc('pay-1', 6, 'O1', 'O1-l1', -80000, { qty: -2, realloc: 'ra-1' }));
rejects('cancellation adjustment with the wrong sign', () => run(`INSERT INTO charge_adjustments (shop_id, id, order_id, adjustment_type_id, type_sign, amount, reason, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
  VALUES ('S1','adj-1','O1','cancellation',-1,5000,'취소',?,?,'2026-12-26','2026-12-26','staff:st-1','김사장','rq-adj1',3)`, T, T), /CHECK/);
rejects('adjustment copying a sign its type does not have', () => run(`INSERT INTO charge_adjustments (shop_id, id, order_id, adjustment_type_id, type_sign, amount, reason, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
  VALUES ('S1','adj-2','O1','cancellation',1,5000,'취소',?,?,'2026-12-26','2026-12-26','staff:st-1','김사장','rq-adj2',3)`, T, T), /FOREIGN KEY/);
rejects('cancellation line with an amount but no adjustment', () =>
  run(`INSERT INTO order_cancellation_lines (shop_id, cancellation_id, order_id, line_id, quantity, amount) VALUES ('S1','oc-1','O1','O1-l1',1,40000)`), /CHECK/, {
  setup: () => run(`INSERT INTO order_cancellations (shop_id, id, order_id, reason, refund_decision_key, total_amount, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
       VALUES ('S1','oc-1','O1','일정','refund',40000,?,?,'2026-12-26','2026-12-26','staff:st-1','김사장','rq-oc',3)`, T, T),
});
rejects('money row whose scope is not its drawer\'s scope', () => run(`INSERT INTO cash_entries (shop_id, id, cash_drawer_id, direction_key, amount, reason, closing_scope_id, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
  VALUES ('S1','ce-1','counter-b','in',1000,'시재','main',?,?,'2026-12-26','2026-12-26','staff:st-1','김사장','rq-ce1',3)`, T, T), /FOREIGN KEY/, {
  setup: () => {
    run(`INSERT INTO closing_scopes (shop_id, id, key, label, created_at, updated_at) VALUES ('S1','scope-b','branch_b','2호점',?,?)`, T, T);
    run(`INSERT INTO cash_drawers (shop_id, id, kind_key, label, closing_scope_id, created_at, updated_at) VALUES ('S1','counter-b','counter','2호점 카운터','scope-b',?,?)`, T, T);
  },
});

// ---- 청구 쪽도 고정 ---------------------------------------------------------------------------
rejects('line price cannot be edited', () => run(`UPDATE order_lines SET net_amount = 1, gross_amount = 1 WHERE shop_id = 'S1' AND id = 'O1-l1'`), /FROZEN/);
rejects('line quantity cannot be edited', () => run(`UPDATE order_lines SET quantity = 3 WHERE shop_id = 'S1' AND id = 'O1-l1'`), /FROZEN/);
ok('line projections stay writable', () => run(`UPDATE order_lines SET qty_issued = 1, progress_key = 'partial', current_end_date = '2026-12-27' WHERE shop_id = 'S1' AND id = 'O1-l1'`));
rejects('an order is never deleted', () => run(`DELETE FROM orders WHERE shop_id = 'S1' AND id = 'O2'`), /NO_DELETE|FOREIGN KEY/);
ok('same-day extension (오후 -> 야간)', () => {
  run(`INSERT INTO order_extensions (shop_id, id, order_id, total_amount, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
       VALUES ('S1','ox-1','O1',0,?,?,'2026-12-26','2026-12-26','staff:st-1','김사장','rq-ox1',3)`, T, T);
  run(`INSERT INTO order_extension_lines (shop_id, extension_id, order_id, line_id, scope_key, quantity, before_end_date, before_end_time, after_end_date, after_end_time, price_basis_key, added_units, amount)
       VALUES ('S1','ox-1','O1','O1-l1','line',2,'2026-12-26','16:30','2026-12-26','22:00','per_day',0,0)`);
});
rejects('extension that ends earlier', () =>
  run(`INSERT INTO order_extension_lines (shop_id, extension_id, order_id, line_id, scope_key, quantity, before_end_date, before_end_time, after_end_date, after_end_time, price_basis_key, added_units, amount)
       VALUES ('S1','ox-2','O2','O2-l1','line',2,'2026-12-26','22:00','2026-12-26','16:30','per_day',0,0)`), /CHECK/, {
  setup: () => run(`INSERT INTO order_extensions (shop_id, id, order_id, total_amount, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
       VALUES ('S1','ox-2','O2',0,?,?,'2026-12-26','2026-12-26','staff:st-1','김사장','rq-ox2',3)`, T, T),
});

// ---- 재고: 경로, 묶임, 차선의 claim, 되돌리기 한 번, 품목 바꾸기 ------------------------------------
/** @param {string} id @param {string} kind @param {string} from @param {string} fromKind @param {string} to @param {string} toKind */
const move = (id, kind, from, fromKind, to, toKind) => run(`INSERT INTO stock_movements (shop_id, id, kind_key, from_location_id, from_kind_key, to_location_id, to_kind_key, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
  VALUES ('S1', ?, ?, ?, ?, ?, ?, ?, ?, '2026-12-26', '2026-12-26', 'staff:st-1', '김사장', ?, 3)`, id, kind, from, fromKind, to, toKind, T, T, 'rq-' + id);
/** @param {string} mv @param {number} no @param {string} asset */
const mline = (mv, no, asset) => run(`INSERT INTO stock_movement_lines (shop_id, movement_id, line_no, catalog_item_id, asset_id, quantity, order_id, order_line_id, created_rev) VALUES ('S1',?,?,'ski',?,1,'O1','O1-l1',3)`, mv, no, asset);
ok('load shop -> van is a legal route', () => {
  move('mv-1', 'load', 'loc-shop', 'shop', 'loc-van1', 'vehicle');
  mline('mv-1', 1, 'ski-001');
}, {
  setup: () => {
    run(`INSERT INTO assets (shop_id, id, catalog_item_id, location_id, condition_id, acquired_at, created_rev) VALUES ('S1','ski-001','ski','loc-shop','ready',?,1)`, T);
    run(`INSERT INTO assets (shop_id, id, catalog_item_id, location_id, condition_id, acquired_at, created_rev) VALUES ('S1','ski-002','ski','loc-shop','ready',?,1)`, T);
    run(`INSERT INTO vehicles (shop_id, id, name, created_at, updated_at) VALUES ('S1','van-1','1호 차량',?,?)`, T, T);
    run(`INSERT INTO stock_locations (shop_id, id, kind_key, label, vehicle_id, created_at) VALUES ('S1','loc-van1','vehicle','1호 차량','van-1',?)`, T);
    run(`INSERT INTO stock_locations (shop_id, id, kind_key, label, order_id, created_at) VALUES ('S1','loc-O1','customer','박준호 팀','O1',?)`, T);
  },
});
rejects('collect shop -> customer is not a route', () => move('mv-2', 'collect', 'loc-shop', 'shop', 'loc-O1', 'customer'), /FOREIGN KEY/);
rejects('location kind must match the location row', () => move('mv-3', 'load', 'loc-van1', 'shop', 'loc-shop', 'vehicle'), /FOREIGN KEY/);
ok('reversal line mirrors the route', () => {
  move('mv-4', 'reversal', 'loc-van1', 'vehicle', 'loc-shop', 'shop');
  mline('mv-4', 1, 'ski-001');
  run(`INSERT INTO stock_movement_reversals (shop_id, reversed_movement_id, reversed_line_no, reversal_movement_id, reversal_line_no, created_rev) VALUES ('S1','mv-1',1,'mv-4',1,4)`);
});
rejects('a movement line is reversed only once', () =>
  run(`INSERT INTO stock_movement_reversals (shop_id, reversed_movement_id, reversed_line_no, reversal_movement_id, reversal_line_no, created_rev) VALUES ('S1','mv-1',1,'mv-5',1,5)`), /UNIQUE|PRIMARY/, {
  setup: () => {
    move('mv-5', 'reversal', 'loc-van1', 'vehicle', 'loc-shop', 'shop');
    mline('mv-5', 1, 'ski-001');
  },
});
rejects('reversal that points at no line of its own', () =>
  run(`INSERT INTO stock_movement_reversals (shop_id, reversed_movement_id, reversed_line_no, reversal_movement_id, reversal_line_no, created_rev) VALUES ('S1','mv-4',1,'mv-5',9,5)`), /FOREIGN KEY/);
ok('a moved unit can be reclassified to another SKU (movement lines keep their snapshot)', () => {
  run(`INSERT INTO asset_reclassifications (shop_id, id, asset_id, from_catalog_item_id, to_catalog_item_id, reason, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
       VALUES ('S1','rc-1','ski-001','ski','board','등급 조정',?,?,'2026-12-26','2026-12-26','staff:st-1','김사장','rq-rc1',6)`, T, T);
  run(`UPDATE assets SET catalog_item_id = 'board' WHERE shop_id = 'S1' AND id = 'ski-001'`);
});
rejects('count movement line without its conditions', () =>
  run(`INSERT INTO stock_movement_lines (shop_id, movement_id, line_no, catalog_item_id, variant_id, quantity, created_rev) VALUES ('S1','mv-1',2,'ski','ski-free',3,3)`), /CHECK/, {
  setup: () => run(`INSERT INTO item_variants (shop_id, id, catalog_item_id, label, created_at, updated_at) VALUES ('S1','ski-free','ski','공용',?,?)`, T, T),
});
/** @param {string} id @param {string} type @param {string} lane @param {number} excl @param {string | null} key @param {string | null} [binding] @param {number} [bound] */
const claim = (id, type, lane, excl, key, binding = 'bd-1', bound = 1) => run(`INSERT INTO asset_claims (shop_id, id, asset_id, binding_id, claim_type_key, lane_key, lane_exclusive, lane_bound, exclusive_key, order_id, order_line_id, created_at, created_by, created_rev)
  VALUES ('S1', ?, 'ski-002', ?, ?, ?, ?, ?, ?, 'O1', 'O1-l1', ?, 'staff:st-1', 3)`, id, binding, type, lane, excl, bound, key, T);
ok('preparation claim', () => claim('c-1', 'preparation', 'preparation', 1, 'ski-002|preparation'), {
  setup: () => run(`INSERT INTO asset_bindings (shop_id, id, asset_id, purpose_key, order_id, created_at, created_by, created_rev) VALUES ('S1','bd-1','ski-002','order','O1',?,'staff:st-1',3)`, T),
});
ok('transport claim on a prepared unit (different lane, same binding)', () => claim('c-2', 'task_delivery', 'transport', 1, 'ski-002|transport'));
rejects('second active binding for the same unit (another order)', () =>
  run(`INSERT INTO asset_bindings (shop_id, id, asset_id, purpose_key, order_id, created_at, created_by, created_rev) VALUES ('S1','bd-2','ski-002','order','O2',?,'staff:st-1',3)`, T), /UNIQUE/);
rejects('bound claim without a binding', () => claim('c-0', 'vendor_refund', 'disposition', 1, 'ski-002|disposition', null), /CHECK/);
rejects('claim on the binding of another unit', () => claim('c-10', 'vendor_refund', 'disposition', 1, 'ski-002|disposition', 'bd-3'), /FOREIGN KEY/, {
  setup: () => run(`INSERT INTO asset_bindings (shop_id, id, asset_id, purpose_key, order_id, created_at, created_by, created_rev) VALUES ('S1','bd-3','ski-001','order','O2',?,'staff:st-1',3)`, T),
});
rejects('second active claim in the same exclusive lane', () => claim('c-3', 'task_collection', 'transport', 1, 'ski-002|transport'), /UNIQUE/);
rejects('claim type in the wrong lane', () => claim('c-4', 'task_delivery', 'disposition', 1, 'ski-002|disposition'), /FOREIGN KEY/);
rejects('exclusive flag that disagrees with the lane', () => claim('c-5', 'line_fulfillment', 'ticket_window', 1, 'ski-002|ticket_window'), /FOREIGN KEY/);
rejects('exclusive key that does not match asset and lane', () => claim('c-6', 'vendor_refund', 'disposition', 1, 'ski-999|disposition'), /CHECK/);
ok('two windowed ticket claims coexist', () => {
  claim('c-7', 'line_fulfillment', 'ticket_window', 0, null);
  claim('c-8', 'line_fulfillment', 'ticket_window', 0, null);
});
ok('ending a claim frees the lane', () => {
  run(`UPDATE asset_claims SET ended_at = ?, end_reason_key = 'fulfilled' WHERE id = 'c-2'`, T);
  claim('c-9', 'task_collection', 'transport', 1, 'ski-002|transport');
});
rejects('movement line fulfilling a claim on another unit', () =>
  run(`INSERT INTO stock_movement_lines (shop_id, movement_id, line_no, catalog_item_id, asset_id, quantity, claim_id, created_rev) VALUES ('S1','mv-6',1,'ski','ski-001',1,'c-9',3)`), /FOREIGN KEY/, {
  setup: () => move('mv-6', 'load', 'loc-shop', 'shop', 'loc-van1', 'vehicle'),
});

// ---- 마감: 범위, 얼린 판, 범위 · 날짜마다 유효한 마감 하나 ---------------------------------------
/** @param {string} id @param {string} date @param {number} v @param {string} [scope] */
const closing = (id, date, v, scope = 'main') => run(`INSERT INTO closings (shop_id, id, closing_scope_id, business_date, version_no, opening_cash_amount, expected_cash_amount, counted_cash_amount, difference_amount, as_of_rev, report_json, report_schema, closed_at, actor_key, actor_name, request_id, created_rev)
  VALUES ('S1', ?, ?, ?, ?, 0, 1000, 1000, 0, 9, '{}', 1, ?, 'staff:st-1', '김사장', ?, 9)`, id, scope, date, v, T, 'rq-' + id);
ok('close the day', () => {
  closing('cl-1', '2026-12-26', 1);
  run(`UPDATE business_days SET active_closing_id = 'cl-1' WHERE shop_id = 'S1' AND closing_scope_id = 'main' AND business_date = '2026-12-26'`);
});
ok('a second scope closes the same date on its own', () => {
  run(`INSERT INTO business_days (shop_id, closing_scope_id, business_date, updated_at) VALUES ('S1','scope-b','2026-12-26',?)`, T);
  closing('cl-b1', '2026-12-26', 1, 'scope-b');
  run(`UPDATE business_days SET active_closing_id = 'cl-b1' WHERE shop_id = 'S1' AND closing_scope_id = 'scope-b' AND business_date = '2026-12-26'`);
});
rejects('closing difference must equal counted - expected', () => run(`INSERT INTO closings (shop_id, id, business_date, version_no, opening_cash_amount, expected_cash_amount, counted_cash_amount, difference_amount, as_of_rev, report_json, report_schema, closed_at, actor_key, actor_name, request_id, created_rev)
  VALUES ('S1','cl-x','2026-12-26',9,0,1000,900,0,9,'{}',1,?, 'staff:st-1','김사장','rq-x',9)`, T), /CHECK/);
rejects('active closing of another scope', () => run(`UPDATE business_days SET active_closing_id = 'cl-1' WHERE shop_id = 'S1' AND closing_scope_id = 'scope-b' AND business_date = '2026-12-26'`), /FOREIGN KEY/);
rejects('active closing of another date', () =>
  run(`UPDATE business_days SET active_closing_id = 'cl-1' WHERE shop_id = 'S1' AND closing_scope_id = 'main' AND business_date = '2026-12-27'`), /FOREIGN KEY/, {
  setup: () => run(`INSERT INTO business_days (shop_id, business_date, updated_at) VALUES ('S1','2026-12-27',?)`, T),
});
rejects('closing row cannot be edited', () => run(`UPDATE closings SET counted_cash_amount = 5 WHERE id = 'cl-1'`), /APPEND_ONLY/);
rejects('INSERT OR REPLACE cannot overwrite a closing', () => run(`INSERT OR REPLACE INTO closings (shop_id, id, business_date, version_no, opening_cash_amount, expected_cash_amount, counted_cash_amount, difference_amount, as_of_rev, report_json, report_schema, closed_at, actor_key, actor_name, request_id, created_rev)
  VALUES ('S1','cl-1','2026-12-26',1,0,1,1,0,9,'{}',1,?, 'staff:st-1','김사장','rq-cl-1',9)`, T), /APPEND_ONLY/);
rejects('a closing version is reopened once', () =>
  run(`INSERT INTO closing_reopenings (shop_id, id, closing_id, reason, reopened_at, actor_key, actor_name, request_id, created_rev) VALUES ('S1','ro-2','cl-1','정정',?,'staff:st-1','김사장','rq-ro2',10)`, T), /UNIQUE/, {
  setup: () => run(`INSERT INTO closing_reopenings (shop_id, id, closing_id, reason, reopened_at, actor_key, actor_name, request_id, created_rev) VALUES ('S1','ro-1','cl-1','정정',?,'staff:st-1','김사장','rq-ro1',10)`, T),
});
ok('handover item without an order (pending vendor refund)', () => run(`INSERT INTO closing_handover_items (shop_id, closing_id, seq, subject_type_key, subject_id, issue_key) VALUES ('S1','cl-1',1,'vendor_refund','vr-1','vendor_refund_pending')`));

// ---- 멱등: 요청번호 하나가 키 -----------------------------------------------------------------
/** @param {string} actor @param {string} req @param {number} seq */
const cmd = (actor, req, seq) => run(`INSERT INTO command_log (shop_id, actor_key, request_id, device_id, device_seq, command_type, command_version, fingerprint, status_key, result_expires_at, occurred_at, received_at)
  VALUES ('S1', ?, ?, 'dev-van1', ?, 'stock.collect', 1, 'fp', 'applied', '2027-03-26', ?, ?)`, actor, req, seq, T, T);
ok('device command seq 1', () => cmd('staff:st-1', 'rq-a', 1), {
  setup: () => run(`INSERT INTO devices (shop_id, id, kind_key, label, registered_at, registered_by) VALUES ('S1','dev-van1','driver_tablet','1호차 태블릿',?,'staff:st-1')`, T),
});
rejects('same request id resent under another session actor', () => cmd('staff:st-2', 'rq-a', 7), /UNIQUE|PRIMARY/);
rejects('same device_seq twice', () => cmd('staff:st-1', 'rq-b', 1), /UNIQUE/);

// ---- 작업 기록: 추가만, 확인된 보관 범위만 지움 --------------------------------------------------
/** @param {number} rev */
const ev = rev => run(`INSERT INTO events (shop_id, rev, epoch_id, request_id, actor_key, actor_name, command_type, command_version, engine_key, command_json, occurred_at, recorded_at, business_date, prev_hash, hash)
  VALUES ('S1', ?, 'ep-1', ?, 'staff:st-1', '김사장', 'payment.take', 1, 'native', '{}', ?, ?, '2026-12-26', 'h0', 'h1')`, rev, 'rq-ev' + rev, T, T);
ok('journal rows', () => {
  ev(1);
  ev(2);
});
rejects('journal row cannot be edited', () => run(`UPDATE events SET command_json = '{"x":1}' WHERE rev = 1`), /APPEND_ONLY/);
rejects('journal row cannot be deleted before archiving', () => run(`DELETE FROM events WHERE rev = 1`), /ARCHIVE_FIRST/);
rejects('a manifest alone does not allow deleting the journal', () => run(`DELETE FROM events WHERE rev = 1`), /ARCHIVE_FIRST/, {
  setup: () => run(`INSERT INTO archive_manifests (id, shop_id, table_name, epoch_id, schema_version, from_rev, to_rev, archive_file, row_count, checksum, created_at) VALUES ('am-1','S1','events','ep-1',1,1,1,'archive-2026-27.sqlite',1,'x',?)`, T),
});
ok('journal row deleted after a verified archive', () => {
  run(`INSERT INTO archive_verifications (shop_id, manifest_id, row_count, checksum, verified_at, actor_key) VALUES ('S1','am-1',1,'x',?,'system:archiver')`, T);
  run(`DELETE FROM events WHERE rev = 1`);
});

// ---- 속성: 형식, 대상 종류, 여러 값 ----------------------------------------------------------------
ok('order attribute value', () => run(`INSERT INTO order_attribute_values (shop_id, order_id, attribute_id, value_text, updated_at, updated_by) VALUES ('S1','O1','a-room','302',?, 'staff:st-1')`, T), {
  setup: () => {
    run(`INSERT INTO attribute_definitions (shop_id, id, entity_type_key, key, label, data_type_key, created_at, updated_at) VALUES ('S1','a-room','order','room_no','객실','text',?,?)`, T, T);
    run(`INSERT INTO attribute_definitions (shop_id, id, entity_type_key, key, label, data_type_key, multi_valued, created_at, updated_at) VALUES ('S1','a-phone2','order','contact','연락처','text',1,?,?)`, T, T);
  },
});
ok('multi-valued field keeps two values', () => {
  for (const q of [1, 2]) run(`INSERT INTO order_attribute_values (shop_id, order_id, attribute_id, value_seq, value_text, updated_at, updated_by) VALUES ('S1','O1','a-phone2',?,?,?, 'staff:st-1')`, q, 'v' + q, T);
});
rejects('order attribute stored on a line', () => run(`INSERT INTO line_attribute_values (shop_id, line_id, attribute_id, value_text, updated_at, updated_by) VALUES ('S1','O1-l1','a-room','302',?, 'staff:st-1')`, T), /FOREIGN KEY/);
rejects('two value columns at once', () => run(`INSERT INTO order_attribute_values (shop_id, order_id, attribute_id, value_text, value_int, updated_at, updated_by) VALUES ('S1','O2','a-room','302',302,?, 'staff:st-1')`, T), /CHECK/);

// ---- 요금: 대상, 게시된 판은 고정 -----------------------------------------------------------------
ok('kind-level price rule (every SKU of the kind)', () => run(`INSERT INTO price_rules (shop_id, id, price_list_version_id, item_kind_id, price_basis_key, unit_amount) VALUES ('S1','pr-k','std-v1','equipment','per_day',15000)`), {
  setup: () => {
    run(`INSERT INTO price_lists (shop_id, id, key, label, is_default, created_at, updated_at) VALUES ('S1','std','standard','기본',1,?,?)`, T, T);
    run(`INSERT INTO price_list_versions (shop_id, id, price_list_id, version_no, effective_from, created_at, created_by) VALUES ('S1','std-v1','std',1,'2026-12-01',?, 'staff:st-1')`, T);
    run(`INSERT INTO price_rules (shop_id, id, price_list_version_id, catalog_item_id, price_basis_key, unit_amount) VALUES ('S1','pr-1','std-v1','ski','per_day',40000)`);
  },
});
rejects('price rule with two targets', () => run(`INSERT INTO price_rules (shop_id, id, price_list_version_id, catalog_item_id, item_kind_id, price_basis_key, unit_amount) VALUES ('S1','pr-x','std-v1','ski','equipment','per_day',1)`), /CHECK/);
rejects('published price rule cannot change', () => run(`UPDATE price_rules SET unit_amount = 1 WHERE id = 'pr-1'`), /PUBLISHED/, {
  setup: () => run(`UPDATE price_list_versions SET status_key = 'published', published_at = ? WHERE id = 'std-v1'`, T),
});
rejects('no new rule in a published version', () => run(`INSERT INTO price_rules (shop_id, id, price_list_version_id, catalog_item_id, price_basis_key, unit_amount) VALUES ('S1','pr-2','std-v1','ski','per_day',1)`), /PUBLISHED/);
ok('a published version may be retired', () => run(`UPDATE price_list_versions SET status_key = 'retired', effective_to = '2027-03-31' WHERE id = 'std-v1'`));

// ---- 화면 설정: 코드가 아는 키는 FK 대상 ------------------------------------------------------------
/** @param {string} id @param {string} key @param {{ fold?: string, fit?: string }} [extra] */
const col = (id, key, extra = {}) => run(`INSERT INTO ledger_view_columns (shop_id, id, ledger_view_id, column_key, seq, header_label, renderer_key, min_width_em, preferred_width_em, fold_into_column_key, fit_mode_key)
  VALUES ('S1', ?, 'lv-1', ?, 1, ?, 'team', 8, 9, ?, ?)`, id, key, key, extra.fold ?? null, extra.fit ?? 'parts');
ok('ledger column', () => {
  col('lc-1', 'team');
  col('lc-2', 'time', { fold: 'team' });
}, {
  setup: () => run(`INSERT INTO ledger_views (shop_id, id, key, label, screen_key, template_key, device_class_key, updated_at) VALUES ('S1','lv-1','day_ledger','대여 장부','day_ledger','ledger','pos',?)`, T),
});
rejects('fold into a column that does not exist', () => col('lc-3', 'promise', { fold: 'tema' }), /FOREIGN KEY/);
rejects('unknown fit mode', () => col('lc-4', 'money', { fit: 'elipsis' }), /FOREIGN KEY/);
rejects('status word for a status the code does not have', () => run(`INSERT INTO status_terms (shop_id, domain_key, key, label, tone_key) VALUES ('S1','order','in_uze','이용 중','ink')`), /FOREIGN KEY/);
rejects('unknown tone', () => run(`INSERT INTO status_terms (shop_id, domain_key, key, label, tone_key) VALUES ('S1','order','in_use','이용 중','rosso')`), /FOREIGN KEY/);
rejects('menu entry pointing at an unknown screen', () => run(`INSERT INTO menu_entries (shop_id, id, workspace_key, key, label, screen_key, seq) VALUES ('S1','me-1','pos','x','X','stok',1)`), /FOREIGN KEY/);

// ---- 더하기만 하는 마이그레이션: 값이 든 STRICT 표에 열 추가, 장부 새 열 채우기 → 한 번만 트리거 -------------
ok('ALTER TABLE ADD COLUMN on a populated STRICT table', () => {
  shop.exec(`ALTER TABLE orders ADD COLUMN lodging_room_no TEXT`);
  shop.exec(`ALTER TABLE payments ADD COLUMN van_batch_no TEXT`);
  shop.exec(`CREATE INDEX orders_lodging_room ON orders (shop_id, lodging_room_no) WHERE lodging_room_no IS NOT NULL`);
  run(`INSERT INTO sys_soft_references (table_name, column_name, target_table, added_in) VALUES ('orders','lodging_place_id','places',2)`);
});
ok('a migration back-fills the new ledger column', () => run(`UPDATE payments SET van_batch_no = 'B-1' WHERE shop_id = 'S1'`));
rejects('then its set-once guard protects it', () => run(`UPDATE payments SET van_batch_no = 'B-2' WHERE id = 'pay-1'`), /APPEND_ONLY/, {
  setup: () => shop.exec(`CREATE TRIGGER payments_van_batch_no_once BEFORE UPDATE OF van_batch_no ON payments WHEN OLD.van_batch_no IS NOT NULL BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payments'); END;`),
});
ok('new sys vocabulary row is an INSERT', () => run(`INSERT INTO sys_fulfillment_modes (key, label, has_custody, needs_issue, default_return_policy_key, completion_rule_key, added_in) VALUES ('locker','보관함',0,0,'none','service_closed',2)`));

test(`smoke run registered ${EXPECTED_SMOKE_TESTS} checks and left foreign_key_check empty`, () => {
  assert.equal(registered, EXPECTED_SMOKE_TESTS);
  assert.deepEqual(shop.prepare('PRAGMA foreign_key_check').all(), []);
});

// @ts-check
// 사장님 답(2026-09-24)을 담은 구조의 동작 시험: 리프트권 보증금(매장이 고르는 규칙, 매수로 세는 보증금 장부),
// 부분 반납 · 조기 반납 · 교환이 사람이 아니라 품목 줄과 수량으로 같은 접수 안에서만 이어지는지, 자정을 넘긴 야간 반납.
// smoke.test.js처럼 실행기로 마이그레이션을 적용한 매장 파일(메모리) 하나 위에서 차례로 돈다(data-model 4-12 · 4-18 · 8절 S16 · S17).
// 예시는 docs/design/screens-v2의 박준호 팀(0022): 야간권 성인 3매, 이 매장 값 1매 5,000원.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { migratedMemoryDb } from './helpers.js';

const EXPECTED_CHECKS = 33;
const shop = migratedMemoryDb('shop');
after(() => shop.close());

const T = '2026-12-26T07:05:00.000Z'; // 16:05 KST
/** @param {string} sql @param {...any} args */
const run = (sql, ...args) => shop.prepare(sql).run(...args);
/** @param {string} sql @param {...any} args */
const get = (sql, ...args) => /** @type {any} */ (shop.prepare(sql).get(...args));

let registered = 0;
/** @param {string} name @param {() => void} fn @param {{ setup?: () => void }} [options] */
function ok(name, fn, { setup } = {}) {
  registered += 1;
  test(name, () => {
    setup?.();
    fn();
  });
}
/** @param {string} name @param {() => void} fn @param {RegExp} pattern @param {{ setup?: () => void }} [options] */
function rejects(name, fn, pattern, { setup } = {}) {
  registered += 1;
  test(name, () => {
    setup?.();
    assert.throws(fn, pattern);
  });
}

// ---- 매장과 레지스트리: 리프트권은 꼭 돌려받음(required), 보증금 결제 칸 ------------------------------------
run(`INSERT INTO shops (id, code, name, business_day_cutoff, created_at, updated_at) VALUES ('S1', 's1', '우리 스키샵', '06:00', ?, ?)`, T, T);
run(`INSERT INTO closing_scopes (shop_id, id, key, label, created_at, updated_at) VALUES ('S1', 'main', 'main', '매장', ?, ?)`, T, T);
for (const [id, key, label, cash] of [['cash', 'cash', '현금', 1], ['card', 'card', '카드', 0], ['internal', 'internal', '장부 안에서', 0]]) {
  run(`INSERT INTO payment_methods (shop_id, id, key, label, affects_cash_drawer, created_at, updated_at) VALUES ('S1', ?, ?, ?, ?, ?, ?)`, id, key, label, cash, T, T);
}
for (const [id, label] of [['gear', '장비'], ['lift', '리프트권'], ['lift_deposit', '리프트권 보증금']]) {
  run(`INSERT INTO payment_sections (shop_id, id, key, label, created_at, updated_at) VALUES ('S1', ?, ?, ?, ?, ?)`, id, id, label, T, T);
}
for (const [id, label] of [['gear', '장비'], ['lift', '리프트권']]) {
  run(`INSERT INTO discount_groups (shop_id, id, key, label, created_at, updated_at) VALUES ('S1', ?, ?, ?, ?, ?)`, id, id, label, T, T);
}
run(`INSERT INTO item_kinds (shop_id, id, key, label, fulfillment_mode_key, tracking_key, return_policy_key, default_price_basis_key, payment_section_id, discount_group_id, unit_label, created_at, updated_at)
     VALUES ('S1', 'equipment', 'equipment', '장비', 'rental', 'unit', 'required', 'per_day', 'gear', 'gear', '대', ?, ?)`, T, T);
run(`INSERT INTO item_kinds (shop_id, id, key, label, fulfillment_mode_key, tracking_key, return_policy_key, default_price_basis_key, payment_section_id, discount_group_id, ticketed, ends_same_day, unit_label, created_at, updated_at)
     VALUES ('S1', 'lift_ticket', 'lift_ticket', '리프트권', 'ticket', 'unit', 'required', 'per_unit', 'lift', 'lift', 1, 1, '매', ?, ?)`, T, T);
run(`INSERT INTO catalog_items (shop_id, id, item_kind_id, label, created_at, updated_at) VALUES ('S1', 'ski', 'equipment', '스키', ?, ?)`, T, T);
run(`INSERT INTO catalog_items (shop_id, id, item_kind_id, label, created_at, updated_at) VALUES ('S1', 'ticket-night', 'lift_ticket', '야간권 성인', ?, ?)`, T, T);
run(`INSERT INTO asset_conditions (shop_id, id, key, label, issuable) VALUES ('S1', 'ready', 'ready', '사용 가능', 1)`);
run(`INSERT INTO reason_codes (shop_id, id, domain_key, key, label) VALUES ('S1', 'rc-not-back', 'deposit', 'not_back', '안 돌아옴')`);
run(`INSERT INTO vehicles (shop_id, id, name, created_at, updated_at) VALUES ('S1', 'van-1', '1호 차량', ?, ?)`, T, T);
run(`INSERT INTO cash_drawers (shop_id, id, kind_key, label, created_at, updated_at) VALUES ('S1', 'counter-1', 'counter', '카운터', ?, ?)`, T, T);
run(`INSERT INTO cash_drawers (shop_id, id, kind_key, label, vehicle_id, created_at, updated_at) VALUES ('S1', 'wallet-van-1', 'vehicle', '1호 차량 지갑', 'van-1', ?, ?)`, T, T);
run(`INSERT INTO business_days (shop_id, business_date, updated_at) VALUES ('S1', '2026-12-26', ?)`, T);

/** @param {string} id @param {string} team */
const order = (id, team) => {
  run(`INSERT INTO orders (shop_id, id, customer_name, booking_channel_key, business_date, config_rev, created_at, created_by, created_rev, updated_at)
       VALUES ('S1', ?, ?, 'phone', '2026-12-26', 1, ?, 'staff:st-1', 1, ?)`, id, team, T, T);
  run(`INSERT INTO order_batches (shop_id, id, order_id, seq, label, business_date, posting_date, created_at, created_by) VALUES ('S1', ?, ?, 1, '첫 접수', '2026-12-26', '2026-12-26', ?, 'staff:st-1')`, id + '-b1', id, T);
};
/** @param {string} orderId @param {string} id @param {string} item @param {string} kind @param {string} mode @param {number} qty @param {number} price @param {string} unit */
const line = (orderId, id, item, kind, mode, qty, price, unit) =>
  run(`INSERT INTO order_lines (shop_id, id, order_id, batch_id, catalog_item_id, item_kind_id, fulfillment_mode_key, tracking_key, return_policy_key, payment_section_id, discount_group_id,
        label, unit_label, quantity, start_date, end_date, price_basis_key, billable_units, unit_price, gross_amount, discount_amount, net_amount, price_source_key, price_engine_key,
        created_at, created_by, created_rev, updated_at)
       VALUES ('S1', ?, ?, ?, ?, ?, ?, 'unit', 'required', ?, ?, ?, ?, ?, '2026-12-26', '2026-12-26', ?, 1, ?, ?, 0, ?, 'rule', 'per_unit@1', ?, 'staff:st-1', 1, ?)`,
  id, orderId, orderId + '-b1', item, kind, mode, kind === 'lift_ticket' ? 'lift' : 'gear', kind === 'lift_ticket' ? 'lift' : 'gear',
  item === 'ski' ? '스키' : '야간권 성인', unit, qty, kind === 'lift_ticket' ? 'per_unit' : 'per_day', price, price * qty, price * qty, T, T);
order('O22', '박준호');
line('O22', 'O22-l1', 'ski', 'equipment', 'rental', 2, 40000, '대');
line('O22', 'O22-l4', 'ticket-night', 'lift_ticket', 'ticket', 3, 35000, '매');
order('O26', '최하은');
line('O26', 'O26-l4', 'ticket-night', 'lift_ticket', 'ticket', 1, 35000, '매');

run(`INSERT INTO stock_locations (shop_id, id, kind_key, label, created_at) VALUES ('S1', 'loc-shop', 'shop', '매장', ?)`, T);
run(`INSERT INTO stock_locations (shop_id, id, kind_key, label, created_at) VALUES ('S1', 'loc-void', 'void', '없어짐', ?)`, T);
run(`INSERT INTO stock_locations (shop_id, id, kind_key, label, vehicle_id, created_at) VALUES ('S1', 'loc-van1', 'vehicle', '1호 차량', 'van-1', ?)`, T);
run(`INSERT INTO stock_locations (shop_id, id, kind_key, label, order_id, created_at) VALUES ('S1', 'loc-O22', 'customer', '박준호 팀', 'O22', ?)`, T);
run(`INSERT INTO stock_locations (shop_id, id, kind_key, label, order_id, created_at) VALUES ('S1', 'loc-O26', 'customer', '최하은 팀', 'O26', ?)`, T);
for (const t of ['t-1', 't-2', 't-3', 't-4', 's-1']) {
  run(`INSERT INTO assets (shop_id, id, catalog_item_id, location_id, condition_id, acquired_at, created_rev) VALUES ('S1', ?, ?, ?, 'ready', ?, 1)`,
    t, t.startsWith('s') ? 'ski' : 'ticket-night', t === 't-4' ? 'loc-O26' : 'loc-O22', T);
}

// ---- 보증금 규칙: 매장이 고르고, 대상은 종류나 상품 하나 --------------------------------------------------------
/** @param {string} id @param {{ kind?: string | null, item?: string | null, timing?: string, key?: string }} o */
const rule = (id, o) => run(`INSERT INTO deposit_rules (shop_id, id, key, label, item_kind_id, catalog_item_id, unit_amount, timing_key, payment_section_id, refund_default_key,
    unreturned_key, unreturned_after_days, effective_from, created_at, updated_at)
  VALUES ('S1', ?, ?, '리프트권 보증금', ?, ?, 5000, ?, 'lift_deposit', 'cash', 'keep', 1, '2026-11-01', ?, ?)`,
id, o.key ?? id, o.kind ?? null, o.item ?? null, o.timing ?? 'at_intake', T, T);
ok('a deposit rule for the lift ticket kind: 5,000 per 매, taken at intake, cash back, kept after one more closing', () => rule('dr-lift', { kind: 'lift_ticket' }));
rejects('a deposit rule with two targets', () => rule('dr-x', { kind: 'lift_ticket', item: 'ticket-night' }), /CHECK/);
rejects('a deposit rule with no target', () => rule('dr-y', {}), /CHECK/);
rejects('a deposit rule with a timing the code does not know (at_return)', () => rule('dr-z', { kind: 'lift_ticket', timing: 'at_return' }), /FOREIGN KEY/);
ok('a SKU rule may sit next to its kind rule (the command layer picks the SKU rule first)', () => rule('dr-night', { item: 'ticket-night', key: 'night_ticket_card' }));

// ---- 보증금 보관: 팀 · 규칙마다 하나, 규칙 값을 복사 ------------------------------------------------------------
/** @param {string} id @param {string} orderId */
const hold = (id, orderId) => run(`INSERT INTO deposits (shop_id, id, order_id, deposit_rule_id, label, unit_amount, refund_default_key, unreturned_key, unreturned_after_days, created_at, created_by)
  VALUES ('S1', ?, ?, 'dr-lift', '리프트권 보증금', 5000, 'cash', 'keep', 1, ?, 'staff:st-1')`, id, orderId, T);
ok('one deposit hold per team and rule, with the rule values copied', () => {
  hold('dp-22', 'O22');
  hold('dp-26', 'O26');
});
rejects('a second hold for the same team and rule', () => hold('dp-22b', 'O22'), /UNIQUE/);

// ---- 돈 한 건 + 매수 줄 -----------------------------------------------------------------------------------
const KIND = /** @type {Record<string, { cash: number }>} */ ({
  deposit_in: { cash: 1 }, deposit_out: { cash: -1 }, deposit_apply: { cash: 0 }, deposit_forfeit: { cash: 0 }, deposit_restore: { cash: 0 }, payment: { cash: 1 },
});
/** @param {string} id @param {string} kind @param {number} amount @param {{ deposit?: string | null, method?: string, drawer?: string | null, van?: string, at?: string, day?: string }} [o] */
const pay = (id, kind, amount, o = {}) => {
  const method = o.method ?? (KIND[kind].cash === 0 ? 'internal' : 'cash');
  const cash = method === 'cash' ? 1 : 0;
  const deposit = 'deposit' in o ? o.deposit ?? null : 'dp-22';
  const drawer = 'drawer' in o ? o.drawer ?? null : (cash && KIND[kind].cash !== 0 ? 'counter-1' : null);
  return run(`INSERT INTO payments (shop_id, id, kind_key, kind_requires_refund_of, kind_requires_deposit, kind_cash_sign, purpose_key, method_id, method_affects_cash, amount,
      cash_drawer_id, deposit_id, collected_by_vehicle_id, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
    VALUES ('S1', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staff:st-1', '김사장', ?, 2)`,
  id, kind, kind === 'payment' ? 0 : 1, KIND[kind].cash, kind === 'payment' ? 'charge' : 'deposit', method, cash, amount,
  drawer, deposit, o.van ?? null, o.at ?? T, o.at ?? T, o.day ?? '2026-12-26', o.day ?? '2026-12-26', 'rq-' + id);
};
const ENTRY = /** @type {Record<string, string>} */ ({ take: 'deposit_in', refund: 'deposit_out', apply: 'deposit_apply', keep: 'deposit_forfeit', restore: 'deposit_restore' });
/** @param {string} deposit @param {number} seq @param {string} kind @param {string} payment @param {{ order?: string, line?: string | null, qty?: number, amount?: number, asset?: string, mv?: string | null, mvLine?: number | null, paymentKind?: string, reason?: string, reasonCode?: string }} [o] */
const entry = (deposit, seq, kind, payment, o = {}) => run(`INSERT INTO deposit_entries (shop_id, deposit_id, seq, order_id, line_id, asset_id, entry_kind_key, payment_kind_key, quantity, amount, payment_id,
    movement_id, movement_line_no, reason_code_id, reason, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
  VALUES ('S1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-12-26', '2026-12-26', 'staff:st-1', '김사장', ?, 3)`,
deposit, seq, o.order ?? 'O22', 'line' in o ? o.line ?? null : 'O22-l4', o.asset ?? null, kind, o.paymentKind ?? ENTRY[kind], o.qty ?? 1, o.amount ?? 5000, payment,
o.mv ?? null, 'mvLine' in o ? o.mvLine ?? null : (o.mv ? 1 : null), o.reasonCode ?? null, o.reason ?? null, T, T, 'rq-e-' + deposit + seq);

ok('take: 3 매 x 5,000 = one cash money row and one unit row on the ticket line', () => {
  pay('dep-in-22', 'deposit_in', 15000);
  entry('dp-22', 1, 'take', 'dep-in-22', { qty: 3, amount: 15000 });
});
rejects('a unit row whose kind and copied money kind disagree', () => entry('dp-22', 2, 'take', 'dep-in-22', { paymentKind: 'deposit_out' }), /FOREIGN KEY/);
rejects('a take row naming a charge payment instead of deposit money', () => entry('dp-22', 2, 'take', 'pay-charge'), /FOREIGN KEY/, {
  setup: () => pay('pay-charge', 'payment', 120000, { deposit: null }),
});
rejects('a unit row on a line of another team', () => entry('dp-22', 2, 'take', 'dep-in-22', { line: 'O26-l4' }), /FOREIGN KEY/);
rejects('a unit row naming the money of another team\'s deposit', () => entry('dp-22', 2, 'take', 'dep-in-26'), /FOREIGN KEY/, {
  setup: () => {
    pay('dep-in-26', 'deposit_in', 5000, { deposit: 'dp-26', van: 'van-1', drawer: 'wallet-van-1' });
    entry('dp-26', 1, 'take', 'dep-in-26', { order: 'O26', line: 'O26-l4' });
  },
});
rejects('deposit money without a deposit', () => pay('dep-in-x', 'deposit_in', 5000, { deposit: null }), /CHECK/);

// ---- 부분 반납: 3매 중 2매가 21:30에 매장으로, 한 번에 현금 10,000원 ------------------------------------------------
/** @param {string} id @param {string} kind @param {string} from @param {string} fromKind @param {string} to @param {string} toKind @param {string} [orderId] */
const move = (id, kind, from, fromKind, to, toKind, orderId = 'O22') => run(`INSERT INTO stock_movements (shop_id, id, kind_key, from_location_id, from_kind_key, to_location_id, to_kind_key, order_id,
    occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
  VALUES ('S1', ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-12-26', '2026-12-26', 'staff:st-1', '김사장', ?, 3)`, id, kind, from, fromKind, to, toKind, orderId, T, T, 'rq-' + id);
/** @param {string} mv @param {number} no @param {string} asset @param {string} orderLine @param {string} [item] @param {string} [orderId] */
const mline = (mv, no, asset, orderLine, item = 'ticket-night', orderId = 'O22') => run(`INSERT INTO stock_movement_lines (shop_id, movement_id, line_no, catalog_item_id, asset_id, quantity, order_id, order_line_id, created_rev)
  VALUES ('S1', ?, ?, ?, ?, 1, ?, ?, 3)`, mv, no, item, asset, orderId, orderLine);
ok('partial return: two tickets and the skis come back; one refund of 10,000 carries a unit row per returned ticket', () => {
  move('mv-ret-1', 'direct_return', 'loc-O22', 'customer', 'loc-shop', 'shop');
  mline('mv-ret-1', 1, 't-1', 'O22-l4');
  mline('mv-ret-1', 2, 't-2', 'O22-l4');
  mline('mv-ret-1', 3, 's-1', 'O22-l1', 'ski');
  pay('dep-out-22a', 'deposit_out', 10000);
  entry('dp-22', 2, 'refund', 'dep-out-22a', { asset: 't-1', mv: 'mv-ret-1', mvLine: 1 });
  entry('dp-22', 3, 'refund', 'dep-out-22a', { asset: 't-2', mv: 'mv-ret-1', mvLine: 2 });
});
rejects('a refund row naming the movement line of another item line (the skis)', () => entry('dp-22', 4, 'refund', 'dep-out-22a', { mv: 'mv-ret-1', mvLine: 3 }), /FOREIGN KEY/);
rejects('a refund row naming a movement but no movement line', () => entry('dp-22', 4, 'refund', 'dep-out-22a', { mv: 'mv-ret-1', mvLine: null }), /CHECK/);
rejects('a refund row naming a movement line that does not exist', () => entry('dp-22', 4, 'refund', 'dep-out-22a', { mv: 'mv-ret-1', mvLine: 9 }), /FOREIGN KEY/);
ok('the van takes back the third ticket at 22:00 and hands back 5,000 from its wallet', () => {
  move('mv-col-1', 'collect', 'loc-O22', 'customer', 'loc-van1', 'vehicle');
  mline('mv-col-1', 1, 't-3', 'O22-l4');
  pay('dep-out-22b', 'deposit_out', 5000, { van: 'van-1', drawer: 'wallet-van-1', at: '2026-12-26T13:00:00.000Z' });
  entry('dp-22', 4, 'refund', 'dep-out-22b', { asset: 't-3', mv: 'mv-col-1' });
});
ok('held units of the team come back to 0 from the unit ledger (take 3 - refund 3)', () => {
  const held = get(`SELECT sum(k.unit_sign * e.quantity) AS units, sum(k.unit_sign * e.amount) AS amount FROM deposit_entries e
    JOIN sys_deposit_entry_kinds k ON k.key = e.entry_kind_key WHERE e.shop_id = 'S1' AND e.deposit_id = 'dp-22'`);
  assert.deepEqual({ ...held }, { units: 0, amount: 0 });
  const money = get(`SELECT sum(k.deposit_sign * p.amount) AS held FROM payments p JOIN sys_payment_kinds k ON k.key = p.kind_key WHERE p.shop_id = 'S1' AND p.deposit_id = 'dp-22'`);
  assert.equal(money.held, 0);
});
rejects('forfeited deposit money cannot sit in a cash drawer (no cash moves when the shop keeps it)', () => pay('dep-keep-x', 'deposit_forfeit', 5000, { deposit: 'dp-26', method: 'cash', drawer: 'counter-1' }), /CHECK/);

// ---- 안 돌아온 권: 보증금에서 뺌, 나중에 돌아오면 되돌리고 돌려드림 ---------------------------------------------------
ok('a ticket that never came back: written off, and its deposit kept (보증금에서 뺌)', () => {
  move('mv-lost-1', 'write_off', 'loc-O26', 'customer', 'loc-void', 'void', 'O26');
  mline('mv-lost-1', 1, 't-4', 'O26-l4', 'ticket-night', 'O26');
  pay('dep-keep-26', 'deposit_forfeit', 5000, { deposit: 'dp-26' });
  entry('dp-26', 2, 'keep', 'dep-keep-26', { order: 'O26', line: 'O26-l4', asset: 't-4', mv: 'mv-lost-1', reasonCode: 'rc-not-back', reason: '안 돌아옴' });
});
ok('it comes back two days later: the kept deposit is restored, then handed back in cash', () => {
  move('mv-found-1', 'found', 'loc-void', 'void', 'loc-shop', 'shop', 'O26');
  mline('mv-found-1', 1, 't-4', 'O26-l4', 'ticket-night', 'O26');
  pay('dep-restore-26', 'deposit_restore', 5000, { deposit: 'dp-26', day: '2026-12-28' });
  entry('dp-26', 3, 'restore', 'dep-restore-26', { order: 'O26', line: 'O26-l4', asset: 't-4', reason: '늦게 돌아옴' });
  pay('dep-out-26', 'deposit_out', 5000, { deposit: 'dp-26', day: '2026-12-28' });
  entry('dp-26', 4, 'refund', 'dep-out-26', { order: 'O26', line: 'O26-l4', asset: 't-4', mv: 'mv-found-1' });
});
ok('offset against what the team still owes (미수에서 빼기) is deposit money that pays the charge', () => {
  pay('dep-in-26b', 'deposit_in', 5000, { deposit: 'dp-26' });
  entry('dp-26', 5, 'take', 'dep-in-26b', { order: 'O26', line: 'O26-l4', reason: '다시 받음' });
  pay('dep-apply-26', 'deposit_apply', 5000, { deposit: 'dp-26' });
  entry('dp-26', 6, 'apply', 'dep-apply-26', { order: 'O26', line: 'O26-l4' });
  run(`INSERT INTO payment_allocations (shop_id, payment_id, seq, order_id, line_id, amount, business_date, posting_date, actor_key, request_id, created_rev)
       VALUES ('S1', 'dep-apply-26', 1, 'O26', 'O26-l4', 5000, '2026-12-26', '2026-12-26', 'staff:st-1', 'rq-al', 3)`);
});

// ---- 보증금 장부는 추가만 -----------------------------------------------------------------------------------
rejects('a deposit unit row cannot be edited', () => run(`UPDATE deposit_entries SET quantity = 2 WHERE deposit_id = 'dp-22' AND seq = 1`), /APPEND_ONLY/);
rejects('a deposit unit row cannot be deleted', () => run(`DELETE FROM deposit_entries WHERE deposit_id = 'dp-22' AND seq = 1`), /APPEND_ONLY/);
rejects('INSERT OR REPLACE cannot overwrite a deposit unit row (recursive_triggers)', () => run(`INSERT OR REPLACE INTO deposit_entries (shop_id, deposit_id, seq, order_id, line_id, entry_kind_key, payment_kind_key, quantity, amount, payment_id,
    occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
  VALUES ('S1','dp-22',1,'O22','O22-l4','take','deposit_in',1,5000,'dep-in-22',?,?,'2026-12-26','2026-12-26','staff:st-1','김사장','rq-r',3)`, T, T), /APPEND_ONLY/);
ok('its free-text reason can only be redacted', () => run(`UPDATE deposit_entries SET reason = '(지움)' WHERE deposit_id = 'dp-26' AND seq = 2`));
rejects('a deposit hold is never deleted', () => run(`DELETE FROM deposits WHERE id = 'dp-22'`), /NO_DELETE|FOREIGN KEY/);

// ---- 조기 반납 · 교환은 같은 접수의 줄과 약속만 --------------------------------------------------------------
ok('early return of one ticket of the team, on its own line and promise', () => {
  run(`INSERT INTO line_promises (shop_id, id, order_id, line_id, promise_type_key, method_key, quantity, promised_date, promised_time, config_rev, created_at, created_by, created_rev)
       VALUES ('S1', 'p-22-ret', 'O22', 'O22-l4', 'return', 'vehicle_collection', 3, '2026-12-26', '22:00', 1, ?, 'staff:st-1', 1)`, T);
  run(`INSERT INTO early_returns (shop_id, id, order_id, method_key, created_at, created_by) VALUES ('S1', 'er-1', 'O22', 'shop_direct', ?, 'staff:st-1')`, T);
  run(`INSERT INTO early_return_assets (shop_id, early_return_id, seq, order_id, asset_id, order_line_id, previous_promise_id) VALUES ('S1', 'er-1', 1, 'O22', 't-1', 'O22-l4', 'p-22-ret')`);
});
rejects('early return that names a line of another team', () =>
  run(`INSERT INTO early_return_assets (shop_id, early_return_id, seq, order_id, asset_id, order_line_id) VALUES ('S1', 'er-1', 2, 'O22', 't-4', 'O26-l4')`), /FOREIGN KEY/);
rejects('early return filed under another team than its header', () =>
  run(`INSERT INTO early_return_assets (shop_id, early_return_id, seq, order_id, asset_id, order_line_id) VALUES ('S1', 'er-1', 3, 'O26', 't-4', 'O26-l4')`), /FOREIGN KEY/);
rejects('exchange whose return promise belongs to another team', () =>
  run(`INSERT INTO exchange_units (shop_id, exchange_id, seq, order_id, old_asset_id, return_promise_id) VALUES ('S1', 'ex-1', 1, 'O26', 't-4', 'p-22-ret')`), /FOREIGN KEY/, {
  setup: () => run(`INSERT INTO exchanges (shop_id, id, order_id, line_id, catalog_item_id, method_key, created_at, created_by) VALUES ('S1', 'ex-1', 'O26', 'O26-l4', 'ticket-night', 'shop_counter', ?, 'staff:st-1')`, T),
});

// ---- 하루 기준 새벽 6시: 00:15 반납은 26일 장부 ----------------------------------------------------------------
ok('a night return at 00:15 (27th, KST) keeps the 26th as its business date', () => {
  assert.equal(get(`SELECT business_day_cutoff AS c FROM shops WHERE id = 'S1'`).c, '06:00');
  run(`INSERT INTO stock_movements (shop_id, id, kind_key, from_location_id, from_kind_key, to_location_id, to_kind_key, order_id,
      occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
    VALUES ('S1', 'mv-night', 'direct_return', 'loc-O26', 'customer', 'loc-shop', 'shop', 'O26', '2026-12-26T15:15:00.000Z', '2026-12-26T15:15:00.000Z',
      '2026-12-26', '2026-12-26', 'staff:st-1', '김사장', 'rq-night', 4)`);
});

test(`deposit and partial-return run registered ${EXPECTED_CHECKS} checks and left foreign_key_check empty`, () => {
  assert.equal(registered, EXPECTED_CHECKS);
  assert.deepEqual(shop.prepare('PRAGMA foreign_key_check').all(), []);
});

// @ts-check
// 마이그레이션 0002 첫 서버 연결(work/impl-server/plan.md §4-3): 0001이 든(값이 있는) 매장 파일에 더하기만 하고, 네 가지가 저마다
// 제 몫을 한다 — 나눈 일정의 묶음 열, 결제 칸 배분 열('한 번만' + 느슨한 참조), 이동 줄이 채운 일정 몫(새 장부 표), 설정 둘.

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { migrate } from '../src/migrate.js';
import { loadMigrations } from '../src/migrations.js';
import { MIGRATIONS, migratedMemoryDb, tempDir } from './helpers.js';

const temp = tempDir('skinote-0002-');
after(() => temp.cleanup());

const T = '2026-12-26T06:40:00.000Z';

/** @param {import('node:sqlite').DatabaseSync} db */
function fixture(db) {
  /** @param {string} sql @param {...any} args */
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(`INSERT INTO shops (id, code, name, created_at, updated_at) VALUES ('S1', 's1', '시험 매장', ?, ?)`, T, T);
  run(`INSERT INTO closing_scopes (shop_id, id, key, label, created_at, updated_at) VALUES ('S1', 'main', 'main', '매장', ?, ?)`, T, T);
  run(`INSERT INTO payment_methods (shop_id, id, key, label, affects_cash_drawer, created_at, updated_at) VALUES ('S1', 'card', 'card', '카드', 0, ?, ?)`, T, T);
  run(`INSERT INTO payment_sections (shop_id, id, key, label, created_at, updated_at) VALUES ('S1', 'lift', 'lift', '리프트권', ?, ?)`, T, T);
  run(`INSERT INTO discount_groups (shop_id, id, key, label, created_at, updated_at) VALUES ('S1', 'lift', 'lift', '리프트권', ?, ?)`, T, T);
  run(`INSERT INTO item_kinds (shop_id, id, key, label, fulfillment_mode_key, tracking_key, return_policy_key, default_price_basis_key, payment_section_id, discount_group_id, unit_label, created_at, updated_at)
       VALUES ('S1', 'ski', 'ski', '스키', 'rental', 'unit', 'required', 'per_day', 'lift', 'lift', '대', ?, ?)`, T, T);
  run(`INSERT INTO catalog_items (shop_id, id, item_kind_id, label, created_at, updated_at) VALUES ('S1', 'ski', 'ski', '스키', ?, ?)`, T, T);
  run(`INSERT INTO asset_conditions (shop_id, id, key, label, issuable) VALUES ('S1', 'ok', 'ok', '사용 가능', 1)`);
  run(`INSERT INTO stock_locations (shop_id, id, kind_key, label, created_at) VALUES ('S1', 'shop', 'shop', '매장', ?)`, T);
  for (const id of ['O1', 'O2']) {
    run(`INSERT INTO orders (shop_id, id, customer_name, booking_channel_key, business_date, config_rev, created_at, created_by, created_rev, updated_at)
         VALUES ('S1', ?, '김민수', 'walk_in', '2026-12-26', 1, ?, 'staff:st-1', 1, ?)`, id, T, T);
    run(`INSERT INTO order_batches (shop_id, id, order_id, seq, label, business_date, posting_date, created_at, created_by) VALUES ('S1', ?, ?, 1, '첫 접수', '2026-12-26', '2026-12-26', ?, 'staff:st-1')`, id + '-b1', id, T);
    run(`INSERT INTO order_lines (shop_id, id, order_id, batch_id, catalog_item_id, item_kind_id, fulfillment_mode_key, tracking_key, return_policy_key, payment_section_id, discount_group_id,
          label, unit_label, quantity, start_date, end_date, price_basis_key, billable_units, unit_price, gross_amount, discount_amount, net_amount, price_source_key, price_engine_key,
          created_at, created_by, created_rev, updated_at)
         VALUES ('S1', ?, ?, ?, 'ski', 'ski', 'rental', 'unit', 'required', 'lift', 'lift', '스키', '대', 2, '2026-12-26', '2026-12-26', 'per_day', 1, 40000, 80000, 0, 80000, 'rule', 'per_day@1', ?, 'staff:st-1', 1, ?)`,
    id + '-l1', id, id + '-b1', T, T);
  }
  run(`INSERT INTO assets (shop_id, id, catalog_item_id, location_id, condition_id, acquired_at, created_rev) VALUES ('S1', 'ski-1', 'ski', 'shop', 'ok', ?, 1)`, T);
  run(`INSERT INTO stock_locations (shop_id, id, kind_key, label, order_id, created_at) VALUES ('S1', 'cust:O1', 'customer', '김민수', 'O1', ?)`, T);
  run(`INSERT INTO stock_movements (shop_id, id, kind_key, from_location_id, from_kind_key, to_location_id, to_kind_key, order_id, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
       VALUES ('S1', 'mv-1', 'direct_return', 'cust:O1', 'customer', 'shop', 'shop', 'O1', ?, ?, '2026-12-26', '2026-12-26', 'staff:st-1', '오세린', 'rq-1', 2)`, T, T);
  run(`INSERT INTO stock_movement_lines (shop_id, movement_id, line_no, catalog_item_id, asset_id, quantity, order_id, order_line_id, created_rev) VALUES ('S1', 'mv-1', 1, 'ski', 'ski-1', 1, 'O1', 'O1-l1', 2)`);
  run(`INSERT INTO payments (shop_id, id, kind_key, kind_requires_refund_of, kind_requires_deposit, kind_cash_sign, purpose_key, method_id, method_affects_cash, amount,
        occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev)
       VALUES ('S1', 'pay-1', 'payment', 0, 0, 1, 'prepayment', 'card', 0, 105000, ?, ?, '2026-12-26', '2026-12-26', 'staff:st-1', '오세린', 'rq-2', 3)`, T, T);
  return run;
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} table */
const columns = (db, table) => /** @type {{ name: string }[]} */ (db.prepare(`PRAGMA table_info(${table})`).all()).map(c => c.name);
/** @param {import('node:sqlite').DatabaseSync} db @param {string} name */
const exists = (db, name) => /** @type {{ n: number }} */ (db.prepare('SELECT count(*) AS n FROM sqlite_schema WHERE name = ?').get(name)).n === 1;

test('0002 is shipped as the second shop migration and passes the forward-only numbering', () => {
  assert.deepEqual(loadMigrations('shop').map(m => m.name).slice(0, 2), ['0001_shop', '0002_shop_server_link']);
});

test('0002 applies on a shop file that already holds 0001 rows: backup first, rows kept, the new column empty on old rows', () => {
  const dir = join(temp.dir, 'upgrade');
  const only1 = join(dir, 'v1');
  mkdirSync(only1, { recursive: true });
  copyFileSync(join(MIGRATIONS, '0001_shop.sql'), join(only1, '0001_shop.sql'));
  const file = join(dir, 'shop-s1.sqlite');
  const first = migrate(file, 'shop', { migrationsDir: only1, appVersion: 'test' });
  try {
    assert.equal(first.version, 1);
    fixture(first.db);
    first.db.prepare(`INSERT INTO line_promises (shop_id, id, order_id, line_id, promise_type_key, method_key, quantity, promised_date, config_rev, created_at, created_by, created_rev)
      VALUES ('S1', 'p-old', 'O1', 'O1-l1', 'return', 'shop_direct', 2, '2026-12-26', 1, ?, 'staff:st-1', 1)`).run(T);
    first.db.prepare(`INSERT INTO payment_allocations (shop_id, payment_id, seq, order_id, amount, business_date, posting_date, actor_key, request_id, created_rev)
      VALUES ('S1', 'pay-1', 1, 'O1', 105000, '2026-12-26', '2026-12-26', 'staff:st-1', 'rq-2', 3)`).run();
  } finally {
    first.db.close();
  }
  // 0002까지만 든 폴더(뒤 마이그레이션 0003 …은 저마다의 시험이 본다).
  const upTo2 = join(dir, 'v2');
  mkdirSync(upTo2, { recursive: true });
  for (const name of ['0001_shop.sql', '0002_shop_server_link.sql']) copyFileSync(join(MIGRATIONS, name), join(upTo2, name));
  const second = migrate(file, 'shop', { migrationsDir: upTo2, appVersion: 'test' });
  try {
    assert.equal(second.status, 'migrated');
    assert.equal(second.version, 2);
    assert.deepEqual(second.applied.map(m => m.name), ['0002_shop_server_link']);
    assert.deepEqual(second.backups.map(b => `${b.kind_key}@${b.version}`), ['pre_migration@1', 'post_migration@2']);
    assert.ok(second.backups.every(b => existsSync(b.path)));
    const db = second.db;
    assert.equal(/** @type {any} */ (db.prepare("SELECT schedule_id FROM line_promises WHERE id = 'p-old'").get()).schedule_id, null);
    assert.equal(/** @type {any} */ (db.prepare("SELECT count(*) AS n FROM payment_allocation_sections").get()).n, 0);
    assert.equal(/** @type {any} */ (db.prepare("SELECT count(*) AS n FROM orders").get()).n, 2);
    // 이미 있는 배분 행은 그대로다(장부 표에 열을 더하지 않았다): 0001의 수정 금지 트리거가 모든 열을 지킨다.
    assert.throws(() => db.prepare("UPDATE payment_allocations SET amount = 1 WHERE payment_id = 'pay-1'").run(), /APPEND_ONLY payment_allocations/);
  } finally {
    second.db.close();
  }
});

test('1) line_promises.schedule_id groups a split schedule and is indexed', () => {
  const db = migratedMemoryDb('shop');
  try {
    const run = fixture(db);
    assert.ok(columns(db, 'line_promises').includes('schedule_id'));
    assert.ok(exists(db, 'line_promises_schedule'));
    run(`INSERT INTO line_promises (shop_id, id, order_id, line_id, promise_type_key, method_key, quantity, promised_date, promised_time, config_rev, created_at, created_by, created_rev)
         VALUES ('S1', 'p-main', 'O1', 'O1-l1', 'return', 'shop_direct', 1, '2026-12-26', '16:30', 1, ?, 'staff:st-1', 1)`, T);
    run(`INSERT INTO line_promises (shop_id, id, order_id, line_id, promise_type_key, method_key, quantity, promised_date, promised_time, schedule_id, config_rev, created_at, created_by, created_rev)
         VALUES ('S1', 'p-split', 'O1', 'O1-l1', 'return', 'shop_direct', 1, '2026-12-26', '22:00', 'sp-1', 1, ?, 'staff:st-1', 2)`, T);
    const rows = /** @type {any[]} */ (db.prepare("SELECT id FROM line_promises WHERE shop_id = 'S1' AND order_id = 'O1' AND schedule_id = 'sp-1'").all());
    assert.deepEqual(rows.map(r => r.id), ['p-split']);
    const plan = /** @type {any[]} */ (db.prepare("EXPLAIN QUERY PLAN SELECT id FROM line_promises WHERE shop_id = 'S1' AND order_id = 'O1' AND schedule_id = 'sp-1'").all());
    assert.ok(plan.some(p => /line_promises_schedule/.test(p.detail)), 'the partial index serves a schedule lookup');
    // 묶음은 행을 바꾸지 않고 새 행으로 옮긴다: 옛 행은 superseded(장부가 아니라 상태 열은 바뀐다).
    run(`UPDATE line_promises SET status_key = 'superseded', ended_at = ? WHERE id = 'p-split'`, T);
  } finally {
    db.close();
  }
});

test('2) payment_allocation_sections: a section-level allocation in its own append-only link table (never added later to a posted allocation)', () => {
  const db = migratedMemoryDb('shop');
  try {
    const run = fixture(db);
    assert.ok(!columns(db, 'payment_allocations').includes('payment_section_id'), 'the ledger table itself gets no new column');
    run(`INSERT INTO payment_allocations (shop_id, payment_id, seq, order_id, amount, business_date, posting_date, actor_key, request_id, created_rev)
         VALUES ('S1', 'pay-1', 1, 'O1', 105000, '2026-12-26', '2026-12-26', 'staff:st-1', 'rq-2', 3)`);
    run("INSERT INTO payment_allocation_sections (shop_id, payment_id, seq, payment_section_id, created_rev) VALUES ('S1', 'pay-1', 1, 'lift', 3)");
    assert.equal(/** @type {any} */ (db.prepare("SELECT payment_section_id FROM payment_allocation_sections WHERE payment_id = 'pay-1'").get()).payment_section_id, 'lift');
    assert.throws(() => run("INSERT INTO payment_allocation_sections (shop_id, payment_id, seq, payment_section_id, created_rev) VALUES ('S1', 'pay-1', 1, 'gear', 4)"), /UNIQUE|PRIMARY KEY/);
    assert.throws(() => run("INSERT INTO payment_allocation_sections (shop_id, payment_id, seq, payment_section_id, created_rev) VALUES ('S1', 'pay-9', 1, 'lift', 4)"), /FOREIGN KEY/, 'an allocation that does not exist');
    assert.throws(() => run("UPDATE payment_allocation_sections SET payment_section_id = 'gear'"), /APPEND_ONLY payment_allocation_sections/);
    assert.throws(() => run("DELETE FROM payment_allocation_sections"), /APPEND_ONLY payment_allocation_sections/);
    assert.throws(() => run("DELETE FROM payment_allocations WHERE payment_id = 'pay-1'"), /APPEND_ONLY payment_allocations/);
  } finally {
    db.close();
  }
});

test('3) line_promise_fulfillments: which promise a movement line filled — append-only, same order, quantity ≥ 1', () => {
  const db = migratedMemoryDb('shop');
  try {
    const run = fixture(db);
    run(`INSERT INTO line_promises (shop_id, id, order_id, line_id, promise_type_key, method_key, quantity, promised_date, schedule_id, config_rev, created_at, created_by, created_rev)
         VALUES ('S1', 'p-split', 'O1', 'O1-l1', 'return', 'shop_direct', 1, '2026-12-26', 'sp-1', 1, ?, 'staff:st-1', 1)`, T);
    run(`INSERT INTO line_promises (shop_id, id, order_id, line_id, promise_type_key, method_key, quantity, promised_date, config_rev, created_at, created_by, created_rev)
         VALUES ('S1', 'p-o2', 'O2', 'O2-l1', 'return', 'shop_direct', 2, '2026-12-26', 1, ?, 'staff:st-1', 1)`, T);
    const fill = (/** @type {string} */ promise, /** @type {string} */ order, /** @type {number} */ qty, line = 1) =>
      run(`INSERT INTO line_promise_fulfillments (shop_id, movement_id, line_no, order_id, promise_id, quantity, created_rev) VALUES ('S1', 'mv-1', ?, ?, ?, ?, 2)`, line, order, promise, qty);
    fill('p-split', 'O1', 1);
    assert.throws(() => fill('p-split', 'O1', 1), /UNIQUE|PRIMARY KEY/);
    assert.throws(() => fill('p-o2', 'O1', 1), /FOREIGN KEY/, 'a promise of another order');
    assert.throws(() => fill('p-split', 'O1', 1, 9), /FOREIGN KEY/, 'a movement line that does not exist');
    assert.throws(() => run(`INSERT INTO line_promise_fulfillments (shop_id, movement_id, line_no, order_id, promise_id, quantity, created_rev) VALUES ('S1', 'mv-1', 1, 'O2', 'p-o2', 0, 2)`), /CHECK/);
    assert.throws(() => run("UPDATE line_promise_fulfillments SET quantity = 2"), /APPEND_ONLY line_promise_fulfillments/);
    assert.throws(() => run("DELETE FROM line_promise_fulfillments"), /APPEND_ONLY line_promise_fulfillments/);
    assert.ok(exists(db, 'line_promise_fulfillments_promise'));
  } finally {
    db.close();
  }
});

test('4) two settings get a home: opening_cash (first closing only) and default_return_slot', () => {
  const db = migratedMemoryDb('shop');
  try {
    const run = fixture(db);
    const defs = /** @type {any[]} */ (db.prepare("SELECT key, value_schema_key, default_value, effective_dated, added_in FROM sys_setting_definitions WHERE key IN ('opening_cash', 'default_return_slot') ORDER BY key").all());
    assert.deepEqual(defs.map(d => ({ ...d })), [
      { key: 'default_return_slot', value_schema_key: 'setting.return_slot', default_value: '{"return_slot_id":null}', effective_dated: 0, added_in: 2 },
      { key: 'opening_cash', value_schema_key: 'setting.money_amount', default_value: '{"amount":0}', effective_dated: 0, added_in: 2 },
    ]);
    for (const [key, value] of [['opening_cash', '{"amount":100000}'], ['default_return_slot', '{"return_slot_id":"afternoon"}']]) {
      run(`INSERT INTO shop_settings (shop_id, setting_key, version_no, value_json, effective_from, created_at, created_by, created_rev) VALUES ('S1', ?, 1, ?, ?, ?, 'system:cli', 0)`, key, value, T, T);
    }
    assert.throws(() => run(`INSERT INTO shop_settings (shop_id, setting_key, version_no, value_json, effective_from, created_at, created_by, created_rev) VALUES ('S1', 'opening_cashx', 1, '{}', ?, ?, 'x', 0)`, T, T), /FOREIGN KEY/);
  } finally {
    db.close();
  }
});

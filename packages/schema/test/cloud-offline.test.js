// @ts-check
// 배치를 클라우드 중심으로 바꾼 결정(ADR-19, 2026-09-24)이 0001에 더한 것의 동작 시험.
// - 기기 종류마다 오프라인에서 쌓을 수 있는 명령(sys_offline_commands): 카운터는 사실(지급 · 반납 · 돈 · 보증금)과
//   새 현장 접수 · 품목 추가만, 기사 기기는 시즌 1 목록 그대로. 기존 결정을 바꾸는 명령은 어느 기기도 오프라인에서 못 한다.
// - 오프라인 카운터의 임시 접수 번호(orders.provisional_receipt_no)와 그 앞자리인 기기 번호(devices.short_no).
// - 라이선스의 오프라인 유예 · 기간 끝 유예(control licences), 확인 필요 종류, 백업 · 오프라인 설정의 기본값.
// - 셋째 검토(2026-09-24, 끊김 · 보안 · 운영 · 일관성): 카운터의 적재 · 권 주기 · 바꿔 드림, 오프라인 제한 어휘(sys_offline_limits),
//   기기 등록 번호의 길 찾기(control enrollment_routes)와 두 단계 허락, 공급자 허락(support_access_grants), 되살리기 연습의
//   두 길(restore_drills), 두 층 라이선스 키, 매장 끝내기 칸, 개인정보 읽기 기록(pii_access_log), 마감이 모든 기기를 기다림.
// sync-and-concurrency 8-2 · 8-3 · 8-12, deployment.md 5 · 6 · 9 · 10, data-model 4-1 · 4-3 · 4-6.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { migratedMemoryDb } from './helpers.js';

const shop = migratedMemoryDb('shop');
const control = migratedMemoryDb('control');
after(() => {
  shop.close();
  control.close();
});

const T = '2026-12-26T06:40:00.000Z'; // 15:40 KST
/** @param {import('node:sqlite').DatabaseSync} db @param {string} sql @param {...any} args */
const run = (db, sql, ...args) => db.prepare(sql).run(...args);
/** @param {import('node:sqlite').DatabaseSync} db @param {string} sql @param {...any} args */
const all = (db, sql, ...args) => /** @type {any[]} */ (db.prepare(sql).all(...args));
/** @param {import('node:sqlite').DatabaseSync} db @param {string} sql @param {...any} args */
const get = (db, sql, ...args) => /** @type {any} */ (db.prepare(sql).get(...args));
const sorted = (/** @type {string[]} */ list) => [...list].sort();

const COUNTER_OFFLINE = [
  'order.create', 'order.add', 'stock.issue', 'stock.direct_return', 'stock.load', 'ticket.hand_out', 'exchange.swap',
  'payment.take', 'deposit.take', 'deposit.return', 'print.request', 'notification.ack', 'device.sign_in',
];
const DRIVER_OFFLINE = [
  'stock.deliver', 'stock.collect', 'task.visit', 'field.collect', 'field.add_ticket', 'field.deposit_return',
  'vendor_refund.attempt', 'route.move', 'route.reset', 'notification.ack', 'device.sign_in',
];
/** 기존 결정을 바꾸는 명령: 다른 기기 · 기사에게 곧바로 닿아야 하므로 연결이 있어야 한다. */
const ONLINE_ONLY = [
  'promise.change', 'order.cancel', 'order.extend', 'discount.apply', 'payment.reallocate', 'payment.refund',
  'payment.intent_request', 'payment_promise.set', 'deposit.keep', 'closing.close', 'closing.reopen', 'task.reassign',
  'task.pin', 'setting.set', 'registry.update', 'device.register', 'stock.receive', 'cash.transfer', 'cash.transfer_confirm',
  'review.resolve', 'customer.anonymize',
];
const offlineFor = (/** @type {string} */ kind) =>
  all(shop, 'SELECT event_type_key AS k FROM sys_offline_commands WHERE device_kind_key = ?', kind).map(r => r.k);

// ---- 오프라인 명령 목록 ---------------------------------------------------------------------------------
test('offline_allowed on sys_event_types is exactly the union of sys_offline_commands', () => {
  const flagged = all(shop, 'SELECT key FROM sys_event_types WHERE offline_allowed = 1').map(r => r.key);
  const listed = all(shop, 'SELECT DISTINCT event_type_key AS k FROM sys_offline_commands').map(r => r.k);
  assert.deepEqual(sorted(flagged), sorted(listed));
});

test('the counter (pos) may queue exactly the facts of the counter (지급 · 반납 · 적재 · 권 주기 · 바꿔 드림 · 돈), new walk-ins and extra items', () => {
  assert.deepEqual(sorted(offlineFor('pos')), sorted(COUNTER_OFFLINE));
});

test('driver tablets and phones keep the season-1 offline list, the same on both', () => {
  assert.deepEqual(sorted(offlineFor('driver_tablet')), sorted(DRIVER_OFFLINE));
  assert.deepEqual(sorted(offlineFor('driver_phone')), sorted(DRIVER_OFFLINE));
  assert.deepEqual(offlineFor('print_agent'), []);
  assert.deepEqual(offlineFor('admin_console'), []);
});

test('no device may queue a decision about an existing order, task, day or setting while offline', () => {
  const listed = new Set(all(shop, 'SELECT event_type_key AS k FROM sys_offline_commands').map(r => r.k));
  for (const key of ONLINE_ONLY) {
    assert.ok(get(shop, 'SELECT 1 AS x FROM sys_event_types WHERE key = ?', key), `${key} is a known command`);
    assert.ok(!listed.has(key), `${key} must need the connection`);
  }
});

test('the only offline intents are a new walk-in and extra items of this team, each with an offline limit', () => {
  const intents = all(shop, `SELECT o.event_type_key AS k, o.limit_key AS lim FROM sys_offline_commands o
                               JOIN sys_event_types e ON e.key = o.event_type_key WHERE e.class_key = 'intent'`);
  assert.deepEqual(sorted([...new Set(intents.map(r => r.k))]), ['order.add', 'order.create']);
  for (const r of intents) assert.ok(r.lim, `${r.k} needs a limit_key`);
  const limit = (/** @type {string} */ k) =>
    get(shop, `SELECT limit_key FROM sys_offline_commands WHERE event_type_key = ? AND device_kind_key = 'pos'`, k).limit_key;
  assert.equal(limit('order.create'), 'walk_in_cached_quote');
  assert.equal(limit('order.add'), 'own_payer_cached_quote', 'offline extra items only on an open order this team pays for');
  assert.equal(limit('ticket.hand_out'), 'shop_ticket_stock');
  assert.equal(limit('exchange.swap'), 'same_line_swap');
});

test('offline limits are a code vocabulary: an unknown limit key is refused', () => {
  const keys = all(shop, 'SELECT key FROM sys_offline_limits').map(r => r.key);
  assert.deepEqual(sorted(keys), ['cached_quote', 'own_payer_cached_quote', 'same_line_swap', 'shop_ticket_stock', 'walk_in_cached_quote']);
  const used = new Set(all(shop, 'SELECT DISTINCT limit_key AS k FROM sys_offline_commands WHERE limit_key IS NOT NULL').map(r => r.k));
  for (const k of keys) assert.ok(used.has(k), `${k} is used by a command`);
  assert.throws(() => run(shop, `INSERT INTO sys_offline_commands (event_type_key, device_kind_key, limit_key, added_in)
                                 VALUES ('order.link', 'pos', 'cached_qoute', 2)`), /FOREIGN KEY/);
});

test('an offline counter can press every stamp it needs: its commands are on the counter offline list', () => {
  const offline = new Set(offlineFor('pos'));
  for (const action of ['stamp.issue', 'stamp.return', 'stamp.load', 'stamp.ticket_hand_out', 'stamp.pay', 'exchange_swap', 'print']) {
    const row = get(shop, 'SELECT command_key AS c FROM sys_actions WHERE key = ?', action);
    assert.ok(row, `${action} is an action`);
    assert.ok(offline.has(row.c), `${action} (${row.c}) works offline`);
  }
  // 권 배정(발권 도장)은 결정이라 연결이 필요하다. 끊긴 카운터는 권 주기(배정 + 지급을 한 사실로)를 쓴다.
  assert.ok(!offline.has(get(shop, `SELECT command_key AS c FROM sys_actions WHERE key = 'stamp.ticket_secure'`).c));
  assert.equal(get(shop, `SELECT label FROM sys_actions WHERE key = 'not_delivered'`).label, '못 전함');
  assert.equal(get(shop, `SELECT label FROM sys_actions WHERE key = 'add_ticket'`).label, '리프트권 추가');
});

test('every offline command runs on the native engine or behind the fact adapter', () => {
  const engines = all(shop, `SELECT DISTINCT e.engine_key AS k FROM sys_offline_commands o JOIN sys_event_types e ON e.key = o.event_type_key`);
  assert.deepEqual(sorted(engines.map(r => r.k)), ['adapter', 'native']);
});

test('money commands a counter may queue are all facts (never refused on arrival)', () => {
  const money = all(shop, `SELECT e.key AS k, e.class_key AS c FROM sys_offline_commands o JOIN sys_event_types e ON e.key = o.event_type_key
                            WHERE o.device_kind_key = 'pos' AND e.is_money = 1`);
  assert.deepEqual(sorted(money.map(r => r.k)), ['deposit.return', 'deposit.take', 'payment.take']);
  for (const r of money) assert.equal(r.c, 'fact', r.k);
});

test('sys_offline_commands rejects an unknown command or device kind', () => {
  assert.throws(() => run(shop, `INSERT INTO sys_offline_commands (event_type_key, device_kind_key, added_in) VALUES ('order.creat', 'pos', 2)`), /FOREIGN KEY/);
  assert.throws(() => run(shop, `INSERT INTO sys_offline_commands (event_type_key, device_kind_key, added_in) VALUES ('stock.issue', 'kiosk', 2)`), /FOREIGN KEY/);
  assert.throws(() => run(shop, `INSERT INTO sys_offline_commands (event_type_key, device_kind_key, added_in) VALUES ('stock.issue', 'pos', 2)`), /UNIQUE|PRIMARY/);
});

test('offline movement routes: counter 지급 · 매장 반납 · 적재 and the van routes; 매장 입고 and reversals need the connection', () => {
  const routes = all(shop, 'SELECT movement_kind_key || \':\' || from_kind_key || \'>\' || to_kind_key AS r FROM sys_movement_routes WHERE offline_allowed = 1').map(r => r.r);
  assert.deepEqual(sorted(routes), sorted([
    'deliver:shop>customer', 'direct_return:customer>shop', 'load:shop>vehicle',
    'deliver:vehicle>customer', 'collect:customer>vehicle', 'vendor_refund:vehicle>counterparty',
  ]));
  assert.equal(get(shop, `SELECT driver_allowed AS d FROM sys_movement_routes WHERE movement_kind_key = 'load'`).d, 0, '적재 stays a counter route');
  assert.equal(get(shop, `SELECT driver_allowed AS d FROM sys_movement_routes WHERE movement_kind_key = 'direct_return'`).d, 0, 'still a counter route');
});

// ---- 기기 번호와 임시 접수 번호 ---------------------------------------------------------------------------
run(shop, `INSERT INTO shops (id, code, name, business_day_cutoff, created_at, updated_at) VALUES ('S1', 's1', '우리 스키샵', '06:00', ?, ?)`, T, T);
/** @param {string} id @param {string} kind @param {number | null} no */
const device = (id, kind, no) =>
  run(shop, `INSERT INTO devices (shop_id, id, kind_key, label, short_no, registered_at, registered_by) VALUES ('S1', ?, ?, ?, ?, ?, 'staff:owner')`, id, kind, id, no, T);
device('counter-1', 'pos', 1);
device('counter-2', 'pos', 2);
device('van-1-tablet', 'driver_tablet', 3);
device('print-agent', 'print_agent', null);
device('card-agent', 'card_agent', null);

test('devices.short_no is unique per shop, optional, never 0, and a revoked device keeps its number', () => {
  assert.throws(() => device('counter-3', 'pos', 1), /UNIQUE/);
  assert.throws(() => device('counter-4', 'pos', 0), /CHECK/);
  run(shop, `UPDATE devices SET status_key = 'revoked', revoked_at = ? WHERE shop_id = 'S1' AND id = 'counter-2'`, T);
  assert.throws(() => device('counter-5', 'pos', 2), /UNIQUE/, 'a new device never takes a revoked device number');
  device('counter-6', 'pos', 4);
  assert.equal(get(shop, `SELECT COUNT(*) AS n FROM devices WHERE shop_id = 'S1' AND short_no IS NULL`).n, 2);
});

/** @param {string} id @param {{ receipt?: string | null, provisional?: string | null, device?: string | null, day?: string }} o */
const order = (id, { receipt = null, provisional = null, device: dev = null, day = '2026-12-26' } = {}) =>
  run(shop, `INSERT INTO orders (shop_id, id, receipt_no, provisional_receipt_no, customer_name, booking_channel_key, business_date, config_rev,
                                 created_at, created_by, device_id, created_rev, updated_at)
             VALUES ('S1', ?, ?, ?, '손님', 'walk_in', ?, 0, ?, 'staff:kim', ?, 1, ?)`, id, receipt, provisional, day, T, dev, T);

test('two offline counters print different provisional numbers; the same number twice is refused', () => {
  order('o-a', { provisional: '1-12', device: 'counter-1' });
  order('o-b', { provisional: '4-1', device: 'counter-6' });
  assert.throws(() => order('o-c', { provisional: '1-12', device: 'counter-1' }), /UNIQUE/);
  assert.throws(() => order('o-d', { provisional: '1-12', device: 'counter-1', day: '2026-12-27' }), /UNIQUE/,
    'the device counter never resets, so a number is unique across days too');
});

test('the server gives the final receipt number on arrival and the provisional number stays', () => {
  run(shop, `UPDATE orders SET receipt_no = '261226-031' WHERE shop_id = 'S1' AND id = 'o-a'`);
  const row = get(shop, `SELECT receipt_no, provisional_receipt_no FROM orders WHERE shop_id = 'S1' AND id = 'o-a'`);
  assert.deepEqual({ ...row }, { receipt_no: '261226-031', provisional_receipt_no: '1-12' });
  assert.throws(() => run(shop, `UPDATE orders SET receipt_no = '261226-031' WHERE shop_id = 'S1' AND id = 'o-b'`), /UNIQUE/);
  order('o-online', { receipt: '261226-032' });
  order('o-online-2', { receipt: '261226-033' });
});

test('a provisional number always names the device that printed it', () => {
  assert.throws(() => order('o-e', { provisional: '9-1' }), /CHECK/);
});

// ---- 확인 필요 종류와 설정 --------------------------------------------------------------------------------
test('review kinds for offline counters, revoked devices, lapsed licences, restores and held commands, each shown where it is needed', () => {
  const keys = ['asset_elsewhere', 'deposit_over_returned', 'revoked_device_record', 'offline_order_unapplied', 'device_unsynced',
    'licence_lapsed_record', 'unverified_sign_in', 'command_held', 'recomputed_after_restore'];
  const kinds = Object.fromEntries(all(shop, `SELECT key, routing_key, severity_key FROM sys_review_kinds WHERE key IN (${keys.map(() => '?').join(', ')})`, ...keys)
    .map(r => [r.key, `${r.routing_key}/${r.severity_key}`]));
  assert.deepEqual(kinds, {
    asset_elsewhere: 'origin_device/action', deposit_over_returned: 'order_banner/action', revoked_device_record: 'manager/action',
    offline_order_unapplied: 'origin_device/action', device_unsynced: 'dialog_step/blocking', licence_lapsed_record: 'manager/info',
    unverified_sign_in: 'manager/action', command_held: 'manager/info', recomputed_after_restore: 'manager/action',
  });
  assert.match(get(shop, `SELECT message_template AS m FROM sys_review_kinds WHERE key = 'deposit_over_returned'`).m, /\{drawer\}에서 나간 현금/,
    'a van wallet can pay out too, not only the counter drawer');
  assert.match(get(shop, `SELECT message_template AS m FROM sys_review_kinds WHERE key = 'revoked_device_record'`).m, /넣지 않고 두었습니다/);
});

test('backup and offline settings default to the cloud plan', () => {
  const backup = JSON.parse(get(shop, `SELECT default_value AS v FROM sys_setting_definitions WHERE key = 'backup_policy'`).v);
  assert.deepEqual(backup, {
    wal_keep_days: 7, daily_keep_days: 35, journal_pii_keep_days: 35, weekly_scrubbed_keep_weeks: 26, season_scrubbed_keep_years: 5,
    drill_weekday: 'mon', drill_time: '04:30', owner_export_scrubbed: true, owner_export: false,
  });
  const offline = JSON.parse(get(shop, `SELECT default_value AS v FROM sys_setting_definitions WHERE key = 'offline_policy'`).v);
  assert.equal(offline.max_backdate_hours, 168);
  assert.equal(offline.sent_log_days, 7);
  assert.equal(offline.sent_pii_hours, 24);
  assert.equal(offline.counter_days_ahead, 2);
  assert.equal(offline.counter_due_lookback_days, 30);
  assert.equal(offline.reconnect_window_seconds, 120);
  assert.deepEqual([offline.fallback_after_failures, offline.fallback_recover_seconds], [2, 10]);
  assert.deepEqual(offline.pii_wipe_hours, { driver: 24, counter: 72 });
  assert.deepEqual(offline.app_lock_minutes, { driver_phone: 5, driver_tablet: 30 });
  const closing = JSON.parse(get(shop, `SELECT default_value AS v FROM sys_setting_definitions WHERE key = 'closing_policy'`).v);
  assert.equal(closing.block_on_unsent_devices, true, 'a counter with unsent cash blocks the closing like a van does');
  const retention = JSON.parse(get(shop, `SELECT default_value AS v FROM sys_setting_definitions WHERE key = 'retention'`).v);
  assert.equal(retention.outbox_payload_days, 30);
  assert.equal(retention.pii_access_days, 365);
});

test('enrolment codes are claimed first and approved on the screen that made them; supplier devices are marked', () => {
  run(shop, `INSERT INTO device_enrollment_codes (shop_id, id, code_hash, kind_key, label, origin_key, expires_at, claimed_at, claimed_agent,
                                                  created_at, created_by)
             VALUES ('S1', 'code-1', 'h1', 'pos', '카운터 3', 'supplier', ?, ?, 'Windows · Chrome', ?, 'staff:owner')`, T, T, T);
  const row = get(shop, `SELECT origin_key, approved_at FROM device_enrollment_codes WHERE shop_id = 'S1' AND id = 'code-1'`);
  assert.deepEqual({ ...row }, { origin_key: 'supplier', approved_at: null });
  run(shop, `INSERT INTO devices (shop_id, id, kind_key, label, short_no, enrolled_by_supplier, registered_at, registered_by)
             VALUES ('S1', 'counter-7', 'pos', '카운터 3', 7, 1, ?, 'staff:owner')`, T);
  assert.throws(() => run(shop, `UPDATE devices SET enrolled_by_supplier = 2 WHERE shop_id = 'S1' AND id = 'counter-7'`), /CHECK/);
});

test('reads of personal data are logged per shop and device', () => {
  run(shop, `INSERT INTO pii_access_log (shop_id, id, actor_key, device_id, action_key, subject_type, subject_id, at, purge_after)
             VALUES ('S1', 'r1', 'staff:kim', 'counter-1', 'phone_reveal', 'order', 'o-a', ?, '2027-12-26T00:00:00.000Z')`, T);
  assert.throws(() => run(shop, `INSERT INTO pii_access_log (shop_id, id, actor_key, device_id, action_key, at, purge_after)
                                 VALUES ('S1', 'r2', 'staff:kim', 'no-such-device', 'last4_search', ?, ?)`, T, T), /FOREIGN KEY/);
  assert.throws(() => run(shop, `INSERT INTO pii_access_log (shop_id, id, actor_key, action_key, item_count, at, purge_after)
                                 VALUES ('S1', 'r3', 'staff:kim', 'list_print', 0, ?, ?)`, T, T), /CHECK/);
});

// ---- 라이선스 유예(control) --------------------------------------------------------------------------------
run(control, `INSERT INTO tenants (id, code, name, data_location, created_at, updated_at) VALUES ('S1', 's1', '우리 스키샵', 'sqlite:shop-S1.sqlite', ?, ?)`, T, T);
run(control, `INSERT INTO plans (key, label, created_at, updated_at) VALUES ('standard', '기본', ?, ?)`, T, T);
run(control, `INSERT INTO licence_signing_keys (key_id, algorithm, public_key, created_at) VALUES ('k1', 'Ed25519', 'cHVibGlj', ?)`, T);
/** @param {string} id @param {string} no @param {string} extra @param {...any} values */
const licence = (id, no, extra = '', ...values) =>
  run(control, `INSERT INTO licences (id, tenant_id, licence_no, plan_key, starts_on, expires_on, token, signing_key_id, issued_at, created_at, updated_at${extra ? ', ' + extra : ''})
                VALUES (?, 'S1', ?, 'standard', '2026-11-01', '2027-03-31', 'signed', 'k1', ?, ?, ?${values.map(() => ', ?').join('')})`, id, no, T, T, T, ...values);

test('a licence gives 14 days offline and 14 days after expiry unless the supplier sets otherwise', () => {
  licence('lic-1', 'L-0001');
  const row = get(control, `SELECT offline_grace_days AS o, expiry_grace_days AS e FROM licences WHERE id = 'lic-1'`);
  assert.deepEqual({ ...row }, { o: 14, e: 14 });
});

test('grace days stay in range: offline 1–60 days, after expiry 0–60 days', () => {
  run(control, `UPDATE licences SET status_key = 'deleted' WHERE id = 'lic-1'`);
  assert.throws(() => licence('lic-2', 'L-0002', 'offline_grace_days', 0), /CHECK/);
  assert.throws(() => licence('lic-3', 'L-0003', 'offline_grace_days', 61), /CHECK/);
  assert.throws(() => licence('lic-4', 'L-0004', 'expiry_grace_days', -1), /CHECK/);
  licence('lic-5', 'L-0005', 'expiry_grace_days', 0);
  assert.equal(get(control, `SELECT expiry_grace_days AS e FROM licences WHERE id = 'lic-5'`).e, 0);
});

// ---- 셋째 검토(보안 · 운영 · 일관성): control ----------------------------------------------------------------
run(control, `INSERT INTO tenants (id, code, name, data_location, created_at, updated_at) VALUES ('S2', 's2', '둘째 가게', 'sqlite:shop-S2.sqlite', ?, ?)`, T, T);

test('an enrolment code routes to exactly one shop: the same code cannot be live in two shops', () => {
  run(control, `INSERT INTO enrollment_routes (code_hash, tenant_id, code_id, expires_at, created_at) VALUES ('hash-a', 'S1', 'code-1', ?, ?)`, T, T);
  assert.throws(() => run(control, `INSERT INTO enrollment_routes (code_hash, tenant_id, code_id, expires_at, created_at)
                                    VALUES ('hash-a', 'S2', 'code-9', ?, ?)`, T, T), /UNIQUE|PRIMARY/);
  assert.throws(() => run(control, `INSERT INTO enrollment_routes (code_hash, tenant_id, code_id, expires_at, created_at)
                                    VALUES ('hash-b', 'no-shop', 'code-9', ?, ?)`, T, T), /FOREIGN KEY/);
});

test('the supplier sees unmasked data only inside a grant the shop gave, with an end time', () => {
  run(control, `INSERT INTO accounts (id, login_realm, login_id, display_name, created_at, updated_at) VALUES ('acc-owner', 's1', 'owner', '사장님', ?, ?)`, T, T);
  run(control, `INSERT INTO support_access_grants (id, tenant_id, kind_key, granted_by, reason, starts_at, expires_at, created_at)
                VALUES ('g1', 'S1', 'data_unmasked', 'acc-owner', '어제 돈 확인', '2026-12-27T01:00:00.000Z', '2026-12-27T03:00:00.000Z', ?)`, T);
  assert.throws(() => run(control, `INSERT INTO support_access_grants (id, tenant_id, kind_key, granted_by, reason, starts_at, expires_at, created_at)
                                    VALUES ('g2', 'S1', 'remote_screen', 'acc-owner', '화면 도움', ?, ?, ?)`, T, T, T), /CHECK/);
});

test('a restore drill may start from the replica generation or segments, not only from a snapshot row', () => {
  run(control, `INSERT INTO restore_drills (id, tenant_id, source_key, replica_generation, target_at, target_rev, started_at, outcome_key, report_json)
                VALUES ('d1', 'S1', 'replica', 'gen-7f3a', ?, 48213, ?, 'passed', '{}')`, T, T);
  run(control, `INSERT INTO restore_drills (id, tenant_id, source_key, provider_key, started_at, outcome_key, report_json)
                VALUES ('d2', 'S1', 'journal', 'second', ?, 'passed', '{}')`, T);
  assert.throws(() => run(control, `INSERT INTO restore_drills (id, source_key, backup_id, started_at, outcome_key, report_json)
                                    VALUES ('d3', 'snapshot', 'no-such-backup', ?, 'failed', '{}')`, T), /FOREIGN KEY/);
});

test('licence keys have two tiers: an online device-token key is certified by an offline root key', () => {
  run(control, `INSERT INTO licence_signing_keys (key_id, algorithm, public_key, purpose_key, certified_by, certificate, not_after, created_at)
                VALUES ('dt-1', 'Ed25519', 'ZGV2aWNl', 'device_token', 'k1', 'sig', '2027-01-31', ?)`, T);
  assert.equal(get(control, `SELECT purpose_key AS p FROM licence_signing_keys WHERE key_id = 'k1'`).p, 'licence');
  assert.throws(() => run(control, `INSERT INTO licence_signing_keys (key_id, algorithm, public_key, purpose_key, certified_by, created_at)
                                    VALUES ('dt-2', 'Ed25519', 'eA', 'device_token', 'no-root', ?)`, T), /FOREIGN KEY/);
  assert.throws(() => run(control, `INSERT INTO licence_signing_keys (key_id, algorithm, public_key, test_only, created_at)
                                    VALUES ('st-1', 'Ed25519', 'eA', 2, ?)`, T), /CHECK/);
});

test('a shop that ends its contract records the request and the destruction', () => {
  run(control, `UPDATE tenants SET status_key = 'closed', closing_requested_at = ?, data_destroyed_at = ? WHERE id = 'S2'`, T, T);
  const row = get(control, `SELECT closing_requested_at AS c, data_destroyed_at AS d FROM tenants WHERE id = 'S2'`);
  assert.deepEqual({ ...row }, { c: T, d: T });
});

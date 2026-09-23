#!/usr/bin/env node
// @ts-check
// 다섯 시즌 규모 측정(옛 review/bench2.cjs, data-model 10절). 시험에 넣지 않는다(몇 분, 약 500 MB).
//   node tools/bench.js [폴더] [--seasons N] [--keep]
// 실행기와 같은 연결(openDatabase: WAL, synchronous FULL, recursive_triggers)과 마이그레이션(applyPending)으로
// 매장 파일을 만들고, 합성 자료(시즌 × 100일 × 60팀)를 넣은 뒤 화면 조회와 접수 한 건 쓰기 시간을 잰다.
// 끝나면 파일을 지운다(--keep이면 남김).

import { createHash } from 'node:crypto';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../src/connection.js';
import { applyPending } from '../src/migrate.js';

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { dir: tmpdir(), seasons: 5, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--seasons') out.seasons = Math.max(1, Number(argv[++i]) || 5);
    else if (argv[i] === '--keep') out.keep = true;
    else out.dir = resolve(argv[i]);
  }
  return out;
}

/** @param {{ dir: string, seasons: number, keep: boolean }} options */
export function bench({ dir, seasons, keep }) {
  const file = join(dir, 'skinote-bench.sqlite');
  for (const f of [file, file + '-wal', file + '-shm']) if (existsSync(f)) unlinkSync(f);
  const db = openDatabase(file);
  applyPending(db, 'shop', { appVersion: 'bench' });
  const T = '2026-12-26T06:40:00.000Z';
  const S = 'jun';
  /** @param {string} s @param {...any} a */
  const run = (s, ...a) => db.prepare(s).run(...a);
  run(`INSERT INTO shops (id, code, name, created_at, updated_at) VALUES (?, 'shop1', '시험 매장', ?, ?)`, S, T, T);
  run(`INSERT INTO closing_scopes (shop_id, id, key, label, created_at, updated_at) VALUES (?, 'main', 'main', '매장', ?, ?)`, S, T, T);
  run(`INSERT INTO roles (shop_id, id, key, label, created_at, updated_at) VALUES (?, 'counter', 'counter', '카운터', ?, ?)`, S, T, T);
  run(`INSERT INTO staff_members (shop_id, id, display_name, role_id, created_at, updated_at) VALUES (?, 'st-1', '카운터1', 'counter', ?, ?)`, S, T, T);
  for (const [id, cash] of [['cash', 1], ['card', 0]]) run(`INSERT INTO payment_methods (shop_id, id, key, label, affects_cash_drawer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, S, id, id, id, cash, T, T);
  for (const id of ['gear', 'lift']) {
    run(`INSERT INTO payment_sections (shop_id, id, key, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, S, id, id, id, T, T);
    run(`INSERT INTO discount_groups (shop_id, id, key, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, S, id, id, id, T, T);
  }
  run(`INSERT INTO item_kinds (shop_id, id, key, label, fulfillment_mode_key, tracking_key, return_policy_key, default_price_basis_key, payment_section_id, discount_group_id, unit_label, created_at, updated_at) VALUES (?, 'equipment','equipment','장비','rental','unit','required','per_day','gear','gear','대',?,?)`, S, T, T);
  run(`INSERT INTO item_kinds (shop_id, id, key, label, fulfillment_mode_key, tracking_key, return_policy_key, default_price_basis_key, payment_section_id, discount_group_id, unit_label, ticketed, ends_same_day, created_at, updated_at) VALUES (?, 'lift_ticket','lift_ticket','리프트권','ticket','unit','optional','per_unit','lift','lift','매',1,1,?,?)`, S, T, T);
  const items = [['ski', 'equipment'], ['board', 'equipment'], ['helmet', 'equipment'], ['clothing', 'equipment'], ['ticket-night', 'lift_ticket']];
  for (const [id, k] of items) run(`INSERT INTO catalog_items (shop_id, id, item_kind_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, S, id, k, id, T, T);
  run(`INSERT INTO asset_conditions (shop_id, id, key, label, issuable) VALUES (?, 'ready','ready','사용 가능',1)`, S);
  run(`INSERT INTO stock_locations (shop_id, id, kind_key, label, created_at) VALUES (?, 'loc-shop','shop','매장',?)`, S, T);
  run(`INSERT INTO cash_drawers (shop_id, id, kind_key, label, created_at, updated_at) VALUES (?, 'counter-1','counter','카운터',?,?)`, S, T, T);
  run(`INSERT INTO vehicles (shop_id, id, name, created_at, updated_at) VALUES (?, 'van-1','1호 차량',?,?)`, S, T, T);
  run(`INSERT INTO stock_locations (shop_id, id, kind_key, label, vehicle_id, created_at) VALUES (?, 'loc-van1','vehicle','1호',  'van-1', ?)`, S, T);
  run(`INSERT INTO areas (shop_id, id, name, created_at, updated_at) VALUES (?, 'a1', '설천', ?, ?)`, S, T, T);
  run(`INSERT INTO places (shop_id, id, area_id, name, created_at, updated_at) VALUES (?, 'p1', 'a1', '설천 주차장', ?, ?)`, S, T, T);

  // ---- 합성 자료: 시즌 × 100일 × 60팀 ----
  const P = {
    day: db.prepare(`INSERT INTO business_days (shop_id, business_date, updated_at) VALUES (?, ?, ?)`),
    order: db.prepare(`INSERT INTO orders (shop_id, id, receipt_no, customer_name, customer_phone, booking_channel_key, business_date, config_rev, first_service_date, last_service_date, next_due_at, charged_amount, net_paid_amount, due_amount, is_open, created_at, created_by, created_rev, updated_at, updated_rev) VALUES (?, ?, ?, ?, ?, 'walk_in', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'staff:st-1', ?, ?, ?)`),
    batch: db.prepare(`INSERT INTO order_batches (shop_id, id, order_id, seq, label, business_date, posting_date, created_at, created_by) VALUES (?1, ?2, ?3, 1, '첫 접수', ?4, ?4, ?5, 'staff:st-1')`),
    line: db.prepare(`INSERT INTO order_lines (shop_id, id, order_id, batch_id, catalog_item_id, item_kind_id, fulfillment_mode_key, tracking_key, return_policy_key, payment_section_id, discount_group_id, label, unit_label, quantity, start_date, end_date, price_basis_key, billable_units, unit_price, gross_amount, discount_amount, net_amount, price_source_key, price_engine_key, qty_issued, qty_returned, created_at, created_by, created_rev, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'unit', ?, ?, ?, ?, '대', ?, ?, ?, ?, 1, ?, ?, 0, ?, 'rule', 'per_day@1', ?, ?, ?, 'staff:st-1', ?, ?)`),
    promise: db.prepare(`INSERT INTO line_promises (shop_id, id, order_id, line_id, promise_type_key, method_key, quantity, promised_date, promised_time, place_id, area_name, place_name, vehicle_id, config_rev, status_key, created_at, created_by, created_rev) VALUES (?, ?, ?, ?, 'return', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'staff:st-1', ?)`),
    pay: db.prepare(`INSERT INTO payments (shop_id, id, kind_key, kind_cash_sign, purpose_key, method_id, method_affects_cash, amount, cash_drawer_id, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev) VALUES (?1, ?2, 'payment', 1, 'charge', ?3, CASE WHEN ?3 = 'cash' THEN 1 ELSE 0 END, ?4, ?5, ?6, ?7, ?8, ?9, 'staff:st-1', '카운터1', ?10, ?11)`),
    alloc: db.prepare(`INSERT INTO payment_allocations (shop_id, payment_id, seq, order_id, line_id, amount, created_rev, business_date, posting_date, actor_key, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-12-26', '2026-12-26', 'staff:st-1', 'rq')`),
    loc: db.prepare(`INSERT INTO stock_locations (shop_id, id, kind_key, label, order_id, created_at) VALUES (?, ?, 'customer', ?, ?, ?)`),
    asset: db.prepare(`INSERT INTO assets (shop_id, id, catalog_item_id, location_id, condition_id, acquired_at, created_rev) VALUES (?, ?, ?, 'loc-shop', 'ready', ?, 1)`),
    move: db.prepare(`INSERT INTO stock_movements (shop_id, id, kind_key, from_location_id, from_kind_key, to_location_id, to_kind_key, order_id, occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, request_id, created_rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staff:st-1', '카운터1', ?, ?)`),
    mline: db.prepare(`INSERT INTO stock_movement_lines (shop_id, movement_id, line_no, catalog_item_id, asset_id, quantity, order_id, order_line_id, created_rev) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1)`),
    ev: db.prepare(`INSERT INTO events (shop_id, rev, epoch_id, request_id, actor_key, actor_name, command_type, command_version, engine_key, aggregate_type, aggregate_id, command_json, result_json, occurred_at, recorded_at, business_date, prev_hash, hash) VALUES (?, ?, 'ep1', ?, 'staff:st-1', '카운터1', ?, 1, 'native', 'order', ?, ?, '{}', ?, ?, ?, ?, ?)`),
    cl: db.prepare(`INSERT INTO change_log (shop_id, rev, seq, scope_key, entity_type, entity_id, op_key, aggregate_type, aggregate_id) VALUES (?, ?, ?, ?, ?, ?, 'upsert', 'order', ?)`),
    cmd: db.prepare(`INSERT INTO command_log (shop_id, actor_key, request_id, command_type, command_version, fingerprint, status_key, applied_rev, result_expires_at, occurred_at, received_at) VALUES (?, 'staff:st-1', ?, ?, 1, ?, 'applied', ?, '2099-01-01', ?, ?)`),
  };
  const ASSETS = 800;
  for (let i = 0; i < ASSETS; i += 1) P.asset.run(S, 'u' + i, items[i % 4][0], T);
  let rev = 0;
  let hash = 'genesis';
  let ord = 0;
  let mv = 0;
  let pay = 0;
  const t0 = Date.now();
  db.exec('BEGIN');
  const start = Date.parse('2022-12-01T00:00:00Z');
  for (let season = 0; season < seasons; season += 1) {
    for (let d = 0; d < 100; d += 1) {
      const date = new Date(start + (season * 365 + d) * 86400000).toISOString().slice(0, 10);
      P.day.run(S, date, T);
      for (let team = 0; team < 60; team += 1) {
        const oid = 'o' + (++ord);
        const at = date + 'T0' + (team % 9) + ':10:00.000Z';
        const lines = 3 + (team % 5);
        let charged = 0;
        /** @type {[string, string[], number, number][]} */
        const ls = [];
        for (let l = 0; l < lines; l += 1) {
          const it = items[l % 5];
          const qty = 1 + (l % 3);
          const amt = qty * 20000;
          charged += amt;
          ls.push([oid + '-l' + l, it, qty, amt]);
        }
        const open = season === seasons - 1 && d === 99 ? 1 : 0;
        P.order.run(S, oid, date.slice(2).replace(/-/g, '') + '-' + String(team + 1).padStart(3, '0'), '손님' + ord, '010-0000-' + String(ord % 10000).padStart(4, '0'), date, date, date, date + 'T13:00:00.000Z', charged, charged, 0, open, at, rev + 1, at, rev + 1);
        P.batch.run(S, oid + '-b1', oid, date, at);
        P.loc.run(S, 'loc-' + oid, oid, oid, at);
        for (const [lid, it, qty, amt] of ls) {
          const ticket = it[1] === 'lift_ticket';
          P.line.run(S, lid, oid, oid + '-b1', it[0], it[1], ticket ? 'ticket' : 'rental', ticket ? 'optional' : 'required', ticket ? 'lift' : 'gear', ticket ? 'lift' : 'gear', it[0], qty, date, date, ticket ? 'per_unit' : 'per_day', 20000, amt, amt, qty, ticket ? 0 : qty, at, rev + 1, at);
          const veh = team % 3 === 0;
          P.promise.run(S, lid + '-p1', oid, lid, 'shop_direct', qty, date, '16:30', null, null, null, null, 'superseded', at, rev + 1);
          P.promise.run(S, lid + '-p2', oid, lid, veh ? 'vehicle_collection' : 'shop_direct', qty, date, veh ? '22:00' : '16:30', veh ? 'p1' : null, veh ? '설천' : null, veh ? '설천 주차장' : null, veh ? 'van-1' : null, open ? 'active' : 'fulfilled', at, rev + 1);
        }
        const pid = 'pay' + (++pay);
        P.pay.run(S, pid, team % 2 ? 'card' : 'cash', charged, team % 2 ? null : 'counter-1', at, at, date, date, 'rq-' + pid, rev + 1);
        ls.forEach(([lid, , , amt], i) => P.alloc.run(S, pid, i + 1, oid, lid, amt, rev + 1));
        // 앞 두 줄은 지급 + 반납 이동(한 대씩)
        for (const [kind, from, fk, to, tk] of [['deliver', 'loc-shop', 'shop', 'loc-' + oid, 'customer'], ['direct_return', 'loc-' + oid, 'customer', 'loc-shop', 'shop']]) {
          const mid = 'mv' + (++mv);
          P.move.run(S, mid, kind, from, fk, to, tk, oid, at, at, date, date, 'rq-' + mid, rev + 1);
          for (let l = 0; l < 2; l += 1) P.mline.run(S, mid, l + 1, ls[l][1][0], 'u' + (((ord * 2) % 200) * 4 + l), oid, ls[l][0]);
        }
        // 접수마다 작업 기록 · 명령 기록 · 변경 목록 약 33줄
        for (let k = 0; k < 11; k += 1) {
          rev += 1;
          const cj = JSON.stringify({ orderId: oid, k, lines });
          const h = createHash('sha256').update(hash + rev + cj).digest('hex');
          P.ev.run(S, rev, 'rq-e' + rev, ['order.create', 'payment.take', 'stock.issue', 'stock.direct_return'][k % 4], oid, cj, at, at, date, hash, h);
          hash = h;
          P.cmd.run(S, 'rq-e' + rev, 'order.create', 'fp' + rev, rev, at, at);
          P.cl.run(S, rev, 1, 'store', 'orders', oid, oid);
          P.cl.run(S, rev, 2, k % 3 === 0 ? 'vehicle:van-1' : 'store', 'order_lines', ls[0][0], oid);
        }
      }
    }
  }
  db.exec('COMMIT');
  const loadMs = Date.now() - t0;
  run(`INSERT INTO shop_counters (shop_id, counter_key, scope_key, value) VALUES (?, 'rev', '', ?)`, S, rev);
  db.exec('ANALYZE');
  const count = (/** @type {string} */ t) => /** @type {any} */ (db.prepare(`SELECT count(*) c FROM ${t}`).get()).c;
  const counts = Object.fromEntries(['orders', 'order_lines', 'line_promises', 'payments', 'payment_allocations', 'stock_movement_lines', 'events', 'change_log', 'command_log'].map(t => [t, count(t)]));

  /** @param {string} label @param {() => void} fn @returns {[string, number]} */
  const time = (label, fn, n = 200) => {
    fn();
    const a = process.hrtime.bigint();
    for (let i = 0; i < n; i += 1) fn();
    return [label, Number(process.hrtime.bigint() - a) / 1e6 / n];
  };
  const lastDate = new Date(start + ((seasons - 1) * 365 + 99) * 86400000).toISOString().slice(0, 10);
  const q = {
    ledger: db.prepare(`SELECT o.id, o.receipt_no, o.customer_name, o.due_amount, o.next_due_at,
        (SELECT group_concat(l.label || ' ' || l.quantity, ' · ') FROM order_lines l WHERE l.shop_id = o.shop_id AND l.order_id = o.id) AS items,
        (SELECT min(p.promised_date || ' ' || coalesce(p.promised_time, '')) FROM line_promises p WHERE p.shop_id = o.shop_id AND p.order_id = o.id AND p.promise_type_key = 'return' AND p.status_key IN ('active','fulfilled')) AS next_return
      FROM orders o WHERE o.shop_id = ? AND o.last_service_date >= ? AND o.first_service_date <= ? ORDER BY o.next_due_at`),
    collection: db.prepare(`SELECT p.order_id, o.customer_name, o.customer_phone, p.promised_time, p.area_name, p.place_name, sum(p.quantity) qty
      FROM line_promises p JOIN orders o ON o.shop_id = p.shop_id AND o.id = p.order_id
      WHERE p.shop_id = ? AND p.status_key = 'active' AND p.promise_type_key = 'return' AND p.method_key = 'vehicle_collection' AND p.promised_date = ?
      GROUP BY p.order_id, p.promised_time, p.area_name, p.place_name ORDER BY p.promised_time, p.area_name`),
    balance: db.prepare(`SELECT 0
        + (SELECT coalesce(sum(net_amount),0) FROM order_lines l WHERE l.shop_id = o.shop_id AND l.order_id = o.id)
        + (SELECT coalesce(sum(amount),0) FROM charge_adjustments a WHERE a.shop_id = o.shop_id AND a.order_id = o.id) AS charged,
        (SELECT coalesce(sum(pa.amount * k.balance_sign),0) FROM payment_allocations pa JOIN payments p ON p.shop_id = pa.shop_id AND p.id = pa.payment_id JOIN sys_payment_kinds k ON k.key = p.kind_key WHERE pa.shop_id = o.shop_id AND pa.order_id = o.id) AS net_paid
      FROM orders o WHERE o.shop_id = ? AND o.id = ?`),
    sync: db.prepare(`SELECT rev, seq, entity_type, entity_id, op_key FROM change_log WHERE shop_id = ? AND scope_key = ? AND rev > ? ORDER BY rev, seq LIMIT 500`),
    last4: db.prepare(`SELECT id, customer_name FROM orders WHERE shop_id = ? AND customer_phone_last4 = ? AND is_open = 1`),
    closingCash: db.prepare(`SELECT p.method_id, sum(p.amount * k.balance_sign) FROM payments p JOIN sys_payment_kinds k ON k.key = p.kind_key WHERE p.shop_id = ? AND p.posting_date = ? GROUP BY p.method_id`),
    unitHistory: db.prepare(`SELECT m.id, m.kind_key, m.occurred_at FROM stock_movement_lines ml JOIN stock_movements m ON m.shop_id = ml.shop_id AND m.id = ml.movement_id WHERE ml.shop_id = ? AND ml.asset_id = ? ORDER BY ml.created_rev DESC LIMIT 20`),
    intent: db.prepare(`SELECT 1 FROM intent_marks WHERE shop_id = ? AND conflict_key = ? AND rev > ? LIMIT 1`),
  };
  const lastOrder = 'o' + Math.max(1, ord - 10);
  const results = [
    time('day ledger (60 teams, items, next return)', () => q.ledger.all(S, lastDate, lastDate)),
    time('collection list for a date', () => q.collection.all(S, lastDate)),
    time('order balance recomputed from ledgers', () => q.balance.get(S, lastOrder)),
    time('sync page (500 changes, vehicle scope)', () => q.sync.all(S, 'vehicle:van-1', rev - 5000)),
    time('keypad search by last 4 digits', () => q.last4.all(S, '9990')),
    time('closing totals by method for a day', () => q.closingCash.all(S, lastDate)),
    time('unit movement history (last 20)', () => q.unitHistory.all(S, 'u17')),
    time('intent conflict-key check', () => q.intent.all(S, 'line:o1-l1:return_promise', rev - 10)),
  ];
  // 접수 한 건 전체 쓰기: 접수, 차수, 줄 5, 약속 10, 수납, 배분 5, 작업 기록, 변경 목록, 명령 기록, 충돌 키
  let n = 0;
  const intake = () => {
    const oid = 'new' + (++n);
    const at = T;
    const date = '2026-12-26';
    db.exec('BEGIN IMMEDIATE');
    if (n === 1) run(`INSERT INTO business_days (shop_id, business_date, updated_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, S, date, T);
    rev += 1;
    P.order.run(S, oid, null, '박준호', '010-0000-0022', date, date, date, date + 'T13:00:00.000Z', 225000, 225000, 0, 1, at, rev, at, rev);
    P.batch.run(S, oid + '-b1', oid, date, at);
    const pid = 'np' + n;
    P.pay.run(S, pid, 'card', 225000, null, at, at, date, date, 'rq-' + pid, rev);
    for (let l = 0; l < 5; l += 1) {
      const lid = oid + '-l' + l;
      const it = items[l];
      const ticket = it[1] === 'lift_ticket';
      P.line.run(S, lid, oid, oid + '-b1', it[0], it[1], ticket ? 'ticket' : 'rental', ticket ? 'optional' : 'required', ticket ? 'lift' : 'gear', ticket ? 'lift' : 'gear', it[0], 1, date, date, ticket ? 'per_unit' : 'per_day', 45000, 45000, 45000, 0, 0, at, rev, at);
      P.promise.run(S, lid + '-pp', oid, lid, 'shop_direct', 1, date, '16:30', null, null, null, null, 'active', at, rev);
      P.promise.run(S, lid + '-pr', oid, lid, 'vehicle_collection', 1, date, '22:00', 'p1', '설천', '설천 주차장', 'van-1', 'active', at, rev);
      P.alloc.run(S, pid, l + 1, oid, lid, 45000, rev);
      run(`INSERT INTO intent_marks (shop_id, conflict_key, rev, created_at) VALUES (?, ?, ?, ?)`, S, 'line:' + lid + ':return_promise', rev, at);
    }
    const cj = JSON.stringify({ orderId: oid });
    const h = createHash('sha256').update(hash + rev + cj).digest('hex');
    P.ev.run(S, rev, 'rq-n' + n, 'order.create', oid, cj, at, at, date, hash, h);
    hash = h;
    P.cmd.run(S, 'rq-n' + n, 'order.create', 'fp', rev, at, at);
    for (let s = 0; s < 8; s += 1) P.cl.run(S, rev, s + 1, s < 6 ? 'store' : 'vehicle:van-1', 'order_lines', oid + '-l' + (s % 5), oid);
    run(`UPDATE shop_counters SET value = ? WHERE shop_id = ? AND counter_key = 'rev' AND scope_key = ''`, rev, S);
    db.exec('COMMIT');
  };
  results.push(time('intake write transaction (synchronous=FULL)', intake, 300));
  const size = statSync(file).size;
  const sqlite = /** @type {any} */ (db.prepare('select sqlite_version() v').get()).v;
  db.close();
  if (!keep) for (const f of [file, file + '-wal', file + '-shm']) if (existsSync(f)) unlinkSync(f);
  return { node: process.version, sqlite, seasons, loadSeconds: +(loadMs / 1000).toFixed(1), counts, fileMB: +(size / 1048576).toFixed(0), file: keep ? file : null, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { results, ...summary } = bench(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 1));
  for (const [label, ms] of results) console.log(ms.toFixed(3).padStart(8), 'ms ', label);
}

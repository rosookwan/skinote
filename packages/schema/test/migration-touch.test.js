// @ts-check
// 기존 이름 없는 접수도 그대로 보존하면서 선택 픽업 표식만 더한다. 운영 파일은 사용하지 않는다.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { migrate } from '../src/migrate.js';
import { MIGRATIONS, tempDir } from './helpers.js';

const temp = tempDir('skinote-touch-migration-');
after(() => temp.cleanup());
const T = '2026-12-26T06:40:00.000Z';

test('0005/0006 upgrade preserves legacy nameless orders, keeps pickup online-only and is idempotent', () => {
  const dir = join(temp.dir, 'migrations');
  mkdirSync(dir, { recursive: true });
  for (const name of ['0001_shop.sql', '0002_shop_server_link.sql', '0003_shop_vehicle_late.sql', '0004_shop_features.sql']) copyFileSync(join(MIGRATIONS, name), join(dir, name));
  const file = join(temp.dir, 'shop.sqlite');
  const first = migrate(file, 'shop', { migrationsDir: dir, appVersion: 'test' });
  const insert = `INSERT INTO orders (shop_id, id, customer_name, booking_channel_key, business_date, config_rev, created_at, created_by, created_rev, updated_at) VALUES ('S1', ?, ?, 'walk_in', '2026-12-26', 1, ?, 'staff:legacy', 1, ?)`;
  try {
    first.db.prepare(`INSERT INTO shops (id, code, name, created_at, updated_at) VALUES ('S1', 's1', '합성 시험 매장', ?, ?)`).run(T, T);
    first.db.prepare(insert).run('legacy', '', T, T);
  } finally { first.db.close(); }
  for (const name of ['0005_shop_touch.sql', '0006_shop_pickup_mark.sql']) copyFileSync(join(MIGRATIONS, name), join(dir, name));
  const second = migrate(file, 'shop', { migrationsDir: dir, appVersion: 'test' });
  try {
    assert.equal(second.version, 6);
    assert.deepEqual(second.applied.map(m => m.name), ['0005_shop_touch', '0006_shop_pickup_mark']);
    assert.deepEqual(second.backups.map(b => `${b.kind_key}@${b.version}`), ['pre_migration@4', 'post_migration@6']);
    const legacy = /** @type {any} */ (second.db.prepare("SELECT customer_name, customer_pickup, charged_amount, net_paid_amount, status_key FROM orders WHERE id = 'legacy'").get());
    assert.deepEqual({ ...legacy }, { customer_name: '', customer_pickup: 0, charged_amount: 0, net_paid_amount: 0, status_key: 'booked' });
    const event = /** @type {any} */ (second.db.prepare("SELECT offline_allowed, is_money, engine_key FROM sys_event_types WHERE key = 'order.customer_pickup'").get());
    assert.deepEqual({ ...event }, { offline_allowed: 0, is_money: 0, engine_key: 'native' });
    second.db.prepare("UPDATE orders SET customer_pickup = 1 WHERE id = 'legacy'").run();
    second.db.prepare(insert).run('without-new-field', '합성 이름', T, T);
  } finally { second.db.close(); }
  const third = migrate(file, 'shop', { migrationsDir: dir, appVersion: 'test' });
  try {
    assert.equal(third.version, 6);
    assert.deepEqual(third.applied, []);
    assert.deepEqual(third.db.prepare('SELECT id, customer_pickup FROM orders ORDER BY id').all().map(r => ({ ...r })), [{ id: 'legacy', customer_pickup: 1 }, { id: 'without-new-field', customer_pickup: 0 }]);
    const count = /** @type {any} */ (third.db.prepare("SELECT count(*) AS n FROM sys_event_types WHERE key = 'order.customer_pickup'").get());
    assert.equal(count.n, 1);
  } finally { third.db.close(); }
});

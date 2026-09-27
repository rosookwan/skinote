// @ts-check
// 마이그레이션 0004 기능 묶음 1(2026-09-27, work/impl-features-1/plan.md §3-1): 접수 취소의 처리기 행, 청구 없는 분실(stock.write_off),
// 접수증 옆 동작의 조건 셋과 동작 넷. 표 · 열은 더하지 않는다. 0003까지 든 매장 파일에 더하기만 하고, 두 번 적용되지 않는다.

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { migrate } from '../src/migrate.js';
import { loadMigrations } from '../src/migrations.js';
import { MIGRATIONS, migratedMemoryDb, tempDir } from './helpers.js';

const temp = tempDir('skinote-0004-');
after(() => temp.cleanup());

const T = '2026-12-26T06:40:00.000Z';

test('0004 is the fourth shop migration', () => {
  assert.deepEqual(loadMigrations('shop').map(m => m.name).slice(0, 4), ['0001_shop', '0002_shop_server_link', '0003_shop_vehicle_late', '0004_shop_features']);
});

test('0004: order.cancel runs natively, stock.write_off exists, three conditions and four side actions (added_in 4)', () => {
  const db = migratedMemoryDb('shop');
  try {
    const one = (sql, ...args) => /** @type {any} */ (db.prepare(sql).get(...args));
    assert.equal(one("SELECT engine_key FROM sys_event_types WHERE key = 'order.cancel'").engine_key, 'native');
    assert.deepEqual({ ...one("SELECT category_key, class_key, audit_label, is_money, offline_allowed, engine_key, added_in FROM sys_event_types WHERE key = 'stock.write_off'") }, {
      category_key: 'stock', class_key: 'intent', audit_label: '분실 처리', is_money: 0, offline_allowed: 0, engine_key: 'native', added_in: 4,
    });
    const conditions = /** @type {any[]} */ (db.prepare("SELECT key, scope_key FROM sys_conditions WHERE added_in = 4 ORDER BY key").all()).map(r => r.key + ':' + r.scope_key);
    assert.deepEqual(conditions, ['cancellable:order', 'order_open:order', 'tickets_out:line']);
    const actions = /** @type {any[]} */ (db.prepare("SELECT key, label, command_key FROM sys_actions WHERE added_in = 4 ORDER BY key").all()).map(r => [r.key, r.label, r.command_key]);
    assert.deepEqual(actions, [
      ['add_items', '품목 추가', 'order.add'], ['apply_discount', '할인 적용', 'discount.apply'], ['remove_items', '품목 취소', 'order.cancel'],
      ['ticket_loss', '분실 처리', 'stock.write_off'],
    ]);
  } finally {
    db.close();
  }
});

test('0004 applies on a file that holds 0001 ~ 0003 (backup first, then version 4) and is not applied twice', () => {
  const dir = join(temp.dir, 'upgrade');
  const upTo3 = join(dir, 'v3');
  mkdirSync(upTo3, { recursive: true });
  for (const name of ['0001_shop.sql', '0002_shop_server_link.sql', '0003_shop_vehicle_late.sql']) copyFileSync(join(MIGRATIONS, name), join(upTo3, name));
  const file = join(dir, 'shop-s1.sqlite');
  const first = migrate(file, 'shop', { migrationsDir: upTo3, appVersion: 'test' });
  first.db.prepare(`INSERT INTO shops (id, code, name, created_at, updated_at) VALUES ('S1', 's1', '시험 매장', ?, ?)`).run(T, T);
  first.db.close();
  const second = migrate(file, 'shop', { appVersion: 'test' });
  try {
    assert.equal(second.status, 'migrated');
    assert.equal(second.version, 4);
    assert.deepEqual(second.applied.map(m => m.name), ['0004_shop_features']);
    assert.deepEqual(second.backups.map(b => `${b.kind_key}@${b.version}`), ['pre_migration@3', 'post_migration@4']);
  } finally {
    second.db.close();
  }
  const third = migrate(file, 'shop', { appVersion: 'test' });
  try {
    assert.equal(third.version, 4);
    assert.deepEqual(third.applied, []);
  } finally {
    third.db.close();
  }
});

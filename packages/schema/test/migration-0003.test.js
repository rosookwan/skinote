// @ts-check
// 마이그레이션 0003 차량 늦음의 여유(2026-09-26 첫 매장 답 15, README D7): 설정 정의 한 행만 더한다. 0002까지 든 매장 파일에 더하기만 하고,
// 그 설정의 새 판(shop_settings)이 정의 FK를 지난다. 없는 매장은 시작 값(60 · 60)으로 읽는다(저장소 registry-read).

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { migrate } from '../src/migrate.js';
import { loadMigrations } from '../src/migrations.js';
import { MIGRATIONS, migratedMemoryDb, tempDir } from './helpers.js';

const temp = tempDir('skinote-0003-');
after(() => temp.cleanup());

const T = '2026-12-26T06:40:00.000Z';

test('0003 is the third shop migration', () => {
  assert.deepEqual(loadMigrations('shop').map(m => m.name).slice(0, 3), ['0001_shop', '0002_shop_server_link', '0003_shop_vehicle_late']);
});

test('0003 adds the vehicle_late_after_minutes definition (default 60 · 60, added_in 3) and a shop setting row can use it', () => {
  const db = migratedMemoryDb('shop');
  try {
    const def = /** @type {any} */ (db.prepare("SELECT key, label, value_schema_key, default_value, effective_dated, added_in FROM sys_setting_definitions WHERE key = 'vehicle_late_after_minutes'").get());
    assert.deepEqual({ ...def }, {
      key: 'vehicle_late_after_minutes', label: '차량 지연 기준', value_schema_key: 'setting.vehicle_late', default_value: '{"minutes":60,"night_minutes":60}', effective_dated: 0, added_in: 3,
    });
    db.prepare(`INSERT INTO shops (id, code, name, created_at, updated_at) VALUES ('S1', 's1', '시험 매장', ?, ?)`).run(T, T);
    db.prepare(`INSERT INTO shop_settings (shop_id, setting_key, version_no, value_json, effective_from, created_at, created_by, created_rev)
      VALUES ('S1', 'vehicle_late_after_minutes', 1, '{"minutes":60,"night_minutes":90}', ?, ?, 'system:cli', 0)`).run(T, T);
    assert.equal(/** @type {any} */ (db.prepare("SELECT count(*) AS n FROM shop_settings WHERE setting_key = 'vehicle_late_after_minutes'").get()).n, 1);
  } finally {
    db.close();
  }
});

test('0003 applies on a file that holds 0001 + 0002: backup first, then version 3', () => {
  const dir = join(temp.dir, 'upgrade');
  const upTo2 = join(dir, 'v2');
  mkdirSync(upTo2, { recursive: true });
  for (const name of ['0001_shop.sql', '0002_shop_server_link.sql']) copyFileSync(join(MIGRATIONS, name), join(upTo2, name));
  const file = join(dir, 'shop-s1.sqlite');
  const first = migrate(file, 'shop', { migrationsDir: upTo2, appVersion: 'test' });
  first.db.prepare(`INSERT INTO shops (id, code, name, created_at, updated_at) VALUES ('S1', 's1', '시험 매장', ?, ?)`).run(T, T);
  first.db.close();
  const second = migrate(file, 'shop', { appVersion: 'test' });
  try {
    assert.equal(second.status, 'migrated');
    assert.equal(second.version, 3);
    assert.deepEqual(second.applied.map(m => m.name), ['0003_shop_vehicle_late']);
    assert.deepEqual(second.backups.map(b => `${b.kind_key}@${b.version}`), ['pre_migration@2', 'post_migration@3']);
    assert.equal(/** @type {any} */ (second.db.prepare('SELECT count(*) AS n FROM shops').get()).n, 1);
  } finally {
    second.db.close();
  }
});

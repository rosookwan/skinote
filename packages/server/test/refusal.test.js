// @ts-check
// 모르는 더 새 마이그레이션이 적용된 파일(앱을 되돌린 경우): 실행기가 적용을 거절하고 읽기 전용으로 연다.
// 서버는 그 파일을 바꾸지 않고, 쓰기를 막고(control이면 모든 매장), 상태 확인은 503으로 계속 답한다(data-model 7-3).
// control이 쓰기 불가면 매장 파일은 마이그레이션하지 않는다(파일을 바꾸지도 새로 만들지도 않음, CONTROL_UNAVAILABLE).

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { inspectFile, loadMigrations, MIGRATIONS_DIR, migrate } from '@skinote/schema';
import { canWrite } from '../src/databases.js';
import { startServer } from '../src/server.js';
import { collectLog, request, sha256Of, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

/** 배포한 마이그레이션 수(종류마다): control 0001, shop 0001 + 0002. */
const KNOWN = { control: loadMigrations('control').length, shop: loadMigrations('shop').length };

/** 배포한 마이그레이션 + 앱이 모르는 다음 판을 적용한 파일을 만든다. @param {'control' | 'shop'} kind @param {string} file */
function newerFile(kind, file) {
  const dir = join(temp.dir, `newer-${kind}`);
  mkdirSync(dir, { recursive: true });
  for (const m of loadMigrations(kind)) copyFileSync(join(MIGRATIONS_DIR, `${m.name}.sql`), join(dir, `${m.name}.sql`));
  const next = String(KNOWN[kind] + 1).padStart(4, '0');
  writeFileSync(join(dir, `${next}_${kind}_future.sql`), `CREATE TABLE future_things (id TEXT PRIMARY KEY) STRICT;\n`);
  mkdirSync(join(file, '..'), { recursive: true });
  const result = migrate(file, kind, { migrationsDir: dir, backupDir: join(temp.dir, `newer-${kind}-backups`), appVersion: 'future' });
  assert.equal(result.version, KNOWN[kind] + 1);
  result.db.close();
}

/** 1부터 n까지. @param {number} n */
const upTo = n => Array.from({ length: n }, (_, i) => i + 1);

/** 파일에 적힌 적용 기록의 번호(실행기의 읽기 전용 보기). @param {string} file */
const appliedIds = file => inspectFile(file, 'shop').applied.map(row => row.id);

test('a shop file with an unknown newer migration is refused and opened read-only; other shops keep writing', async () => {
  const dataDir = join(temp.dir, 'shop-case');
  newerFile('shop', join(dataDir, 'db', 'shops', 'shop-new.sqlite'));
  const config = testConfig(dataDir, { SKINOTE_SHOP_IDS: 'shop-ok,shop-new' });
  const { lines, log } = collectLog();
  const app = await startServer(config, { log });
  try {
    const res = await request(app.port, '/api/health');
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    const refused = body.databases.find((/** @type {any} */ d) => d.shopId === 'shop-new');
    assert.equal(refused.status, 'refused');
    assert.equal(refused.reason, 'UNKNOWN_MIGRATION');
    assert.equal(refused.mode, 'read_only');
    assert.equal(refused.writable, false);
    assert.equal(refused.schemaVersion, KNOWN.shop + 1);
    assert.equal(refused.knownVersion, KNOWN.shop);
    assert.equal(refused.migrationCount, KNOWN.shop + 1);
    assert.equal(refused.journalMode, 'wal');
    assert.ok(refused.pageCount > 0);
    assert.deepEqual(body.shops.map((/** @type {any} */ s) => [s.shopId, s.writable]), [['shop-ok', true], ['shop-new', false]]);
    assert.ok(canWrite(app.entries, 'shop-ok'));
    assert.ok(!canWrite(app.entries, 'shop-new'));
    assert.ok(lines.some(l => l.startsWith('shops/shop-new.sqlite: 거절(UNKNOWN_MIGRATION)')), lines.join('\n'));

    const live = await request(app.port, '/api/health/live');
    assert.equal(live.status, 200, 'the process is alive even when a file is refused');
    await live.text();
  } finally {
    await app.close();
  }
  assert.deepEqual(appliedIds(join(dataDir, 'db', 'shops', 'shop-new.sqlite')), upTo(KNOWN.shop + 1), 'the refused file is untouched');
});

test('a refused control file blocks writes for every shop and leaves every shop file untouched', async () => {
  const dataDir = join(temp.dir, 'control-case');
  newerFile('control', join(dataDir, 'db', 'control.sqlite'));
  // shop-a: 이미 있는 매장 파일(판 1). shop-new: 아직 없는 매장.
  const shopA = join(dataDir, 'db', 'shops', 'shop-a.sqlite');
  mkdirSync(join(dataDir, 'db', 'shops'), { recursive: true });
  const made = migrate(shopA, 'shop', { backupDir: join(temp.dir, 'control-case-shop-backups') });
  made.db.close();
  const before = { ids: appliedIds(shopA), sha: sha256Of(shopA) };
  const config = testConfig(dataDir, { SKINOTE_SHOP_IDS: 'shop-a,shop-new' });
  const { lines, log } = collectLog();
  const app = await startServer(config, { log });
  try {
    const res = await request(app.port, '/api/health');
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.databases[0].status, 'refused');
    assert.equal(body.databases[0].reason, 'UNKNOWN_MIGRATION');
    const [a, fresh] = body.databases.slice(1);
    assert.deepEqual([a.status, a.reason, a.mode, a.writable, a.schemaVersion, a.migrationCount], ['refused', 'CONTROL_UNAVAILABLE', 'read_only', false, KNOWN.shop, KNOWN.shop]);
    assert.deepEqual([fresh.status, fresh.reason, fresh.mode, fresh.writable], ['refused', 'CONTROL_UNAVAILABLE', 'closed', false]);
    assert.deepEqual(body.shops.map((/** @type {any} */ s) => [s.shopId, s.writable]), [['shop-a', false], ['shop-new', false]]);
    assert.ok(!canWrite(app.entries, 'shop-a'));
    assert.ok(lines.some(l => l.startsWith('shops/shop-a.sqlite: control 쓰기 불가라 마이그레이션하지 않음')), lines.join('\n'));
  } finally {
    await app.close();
  }
  assert.deepEqual(appliedIds(shopA), before.ids, 'no migration was applied to the shop file');
  assert.equal(sha256Of(shopA), before.sha, 'the shop file is byte for byte the same');
  assert.ok(!existsSync(join(dataDir, 'db', 'shops', 'shop-new.sqlite')), 'a missing shop file is not created');
});

test('a file that is not a database fails without stopping the server', async () => {
  const dataDir = join(temp.dir, 'garbage-case');
  mkdirSync(join(dataDir, 'db', 'shops'), { recursive: true });
  writeFileSync(join(dataDir, 'db', 'shops', 'shop-bad.sqlite'), 'this is not a database file, just text that is long enough'.repeat(20));
  const config = testConfig(dataDir, { SKINOTE_SHOP_IDS: 'shop-bad,shop-good' });
  const app = await startServer(config, { log: () => {} });
  try {
    const res = await request(app.port, '/api/health');
    assert.equal(res.status, 503);
    const body = await res.json();
    const bad = body.databases.find((/** @type {any} */ d) => d.shopId === 'shop-bad');
    assert.equal(bad.status, 'failed');
    assert.equal(bad.writable, false);
    assert.equal(bad.reason, 'SQLITE_NOTADB', 'only an error code, never a message with paths');
    const good = body.databases.find((/** @type {any} */ d) => d.shopId === 'shop-good');
    assert.equal(good.status, 'migrated');
  } finally {
    await app.close();
  }
});

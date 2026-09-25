// @ts-check
// 날마다 백업: 모든 파일의 한 순간 사본 + quick_check + sha256(SHA256SUMS · manifest.json), 서버가 쓰는 중에도 됨(WAL에만 있는
// 행도 사본에 들어감), 반쪽 사본을 남기지 않음, 디스크 여유가 모자라면 쓰지 않음, 실패한 날에도 오래된 폴더를 지우되 파일마다
// 마지막 온전한 사본은 남김, 같은 날 사본 · migrations/ 사본 수 제한, README 5절 순서로 되살리기.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadMigrations, openDatabase } from '@skinote/schema';
import { checkBackupFile } from '../src/backup-files.js';
import {
  createLastBackupsReader, LOCK_FILE, MIGRATION_KEEP_COPIES, pruneMigrationBackups, readLastBackups, rotateBackups, runBackup, SAME_DAY_KEEP,
} from '../src/backup.js';
import { closeDatabases, openDatabases } from '../src/databases.js';
import { startServer } from '../src/server.js';
import { corruptPages, PACKAGE_DIR, request, sha256Of, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());
const quiet = { log: () => {} };
/** 서울 04:00 = UTC 전날 19:00. 영업일(06:00 기준)은 그 전날. */
const AT_0400_SEOUL = new Date('2026-09-24T19:00:00Z');
const TODAY = '2026-09-25';
/** 배포한 마이그레이션 수(종류마다): control 0001, shop 0001 + 0002. */
const KNOWN = { control: loadMigrations('control').length, shop: loadMigrations('shop').length };

/** @param {string} dir @param {string} shops @param {Record<string, string>} [env] */
function preparedConfig(dir, shops, env = {}) {
  const config = testConfig(join(temp.dir, dir), { SKINOTE_SHOP_IDS: shops, ...env });
  closeDatabases(openDatabases(config, quiet));
  return config;
}

/** 날짜 폴더의 SHA256SUMS가 폴더의 사본과 딱 맞는지(sha256sum -c와 같은 확인 + 적히지 않은 사본 없음). @param {string} dir */
function assertSumsMatch(dir) {
  const lines = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const listed = new Set();
  for (const line of lines) {
    const [sha, name] = line.split('  ');
    assert.equal(sha256Of(join(dir, name)), sha, `${name} matches its SHA256SUMS line`);
    listed.add(name);
  }
  const copies = readdirSync(dir).filter(n => n.endsWith('.sqlite'));
  assert.deepEqual(copies.sort(), [...listed].sort(), 'every copy in the folder is listed, and nothing else');
  assert.ok(!readdirSync(dir).some(n => n.startsWith('.partial-')), 'no .partial-* folder is left');
}

test('backs up control and every shop, including rows still in the WAL of the live write connection', () => {
  const config = preparedConfig('basic', 'shop-a,shop-b');
  // 서버가 쓰기 연결을 쥔 채로 백업한다(WAL이라 막지 않는다). 그 연결로 넣은 행은 아직 WAL에만 있다.
  const live = openDatabases(config, quiet);
  let result;
  try {
    const shopA = /** @type {import('node:sqlite').DatabaseSync} */ (live[1].db);
    shopA.prepare("INSERT INTO db_instance (singleton, instance_id, deployment_key, created_at) VALUES (1, 'wal-only-row', 'staging', '2026-09-24T18:59:00Z')").run();
    assert.ok(existsSync(join(config.shopDbDir, 'shop-a.sqlite-wal')));
    result = runBackup(config, { ...quiet, now: () => AT_0400_SEOUL });
  } finally {
    closeDatabases(live);
  }
  assert.equal(result.ok, true);
  assert.equal(result.date, TODAY, 'the folder uses the Seoul calendar date');
  assert.equal(result.businessDate, '2026-09-24', '04:00 is before the 06:00 cutoff: the previous business day');
  assert.deepEqual(result.items.map(i => i.source), ['control.sqlite', 'shops/shop-a.sqlite', 'shops/shop-b.sqlite']);
  const dir = join(config.backupDir, TODAY);
  assertSumsMatch(dir);
  for (const item of result.items) {
    assert.equal(item.ok, true);
    assert.equal(item.quickCheck, 'ok');
    const version = item.source === 'control.sqlite' ? KNOWN.control : KNOWN.shop;
    assert.equal(item.schemaVersion, version);
    assert.match(item.file ?? '', new RegExp(`^(control|shop-a|shop-b)\\.daily\\.v${String(version).padStart(4, '0')}\\.20260924T190000000Z\\.sqlite$`));
    assert.deepEqual(checkBackupFile(join(dir, /** @type {string} */ (item.file))), { ok: true });
  }
  const copyA = openDatabase(join(dir, /** @type {string} */ (result.items[1].file)), { readOnly: true });
  try {
    assert.deepEqual(copyA.prepare('SELECT instance_id FROM db_instance').all().map(r => r.instance_id), ['wal-only-row']);
  } finally {
    copyA.close();
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 1);
  assert.equal(manifest.runs.length, 1);
  assert.equal(manifest.runs[0].ok, true);
  assert.equal(manifest.runs[0].release, 'test');
  assert.equal(manifest.runs[0].businessDate, '2026-09-24');
  assert.ok(manifest.runs[0].backupBytes > 0);
  assert.ok(!JSON.stringify(manifest).includes(temp.dir), 'no absolute paths in the manifest');

  // 같은 날 두 번째: 이름이 겹치지 않고 manifest에 한 줄 더.
  const second = runBackup(config, { ...quiet, now: () => new Date(AT_0400_SEOUL.getTime() + 60_000) });
  assert.equal(second.ok, true);
  assert.equal(readdirSync(dir).filter(n => n.endsWith('.sqlite')).length, 6);
  assert.equal(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).runs.length, 2);
  assert.equal(readLastBackups(config.backupDir).get('shops/shop-a.sqlite'), '2026-09-24T19:01:00.000Z');
});

test('same-day runs keep only the newest copies per file and rewrite SHA256SUMS', () => {
  const config = preparedConfig('same-day', 'shop-a');
  const reader = createLastBackupsReader(config.backupDir);
  for (let i = 0; i < 5; i += 1) {
    const result = runBackup(config, { ...quiet, now: () => new Date(AT_0400_SEOUL.getTime() + i * 60_000) });
    assert.equal(result.ok, true);
    assert.equal(reader().get('control.sqlite'), new Date(AT_0400_SEOUL.getTime() + i * 60_000).toISOString(), 'the cached reader sees each run');
  }
  const dir = join(config.backupDir, TODAY);
  const copies = readdirSync(dir).filter(n => n.endsWith('.sqlite'));
  assert.equal(copies.length, 2 * SAME_DAY_KEEP);
  assert.ok(!copies.some(n => /T19000|T19010/.test(n)), `the two oldest runs are gone: ${copies.join(', ')}`);
  assertSumsMatch(dir);
});

test('rotation keeps the newest 14 date folders and today, never touches non-date folders', () => {
  const config = preparedConfig('rotate', 'shop-a');
  for (let day = 1; day <= 20; day += 1) {
    mkdirSync(join(config.backupDir, `2026-09-${String(day).padStart(2, '0')}`), { recursive: true });
  }
  mkdirSync(join(config.backupDir, 'notes'), { recursive: true });
  const result = runBackup(config, { ...quiet, now: () => AT_0400_SEOUL });
  assert.equal(result.ok, true);
  const left = readdirSync(config.backupDir).sort();
  const dates = left.filter(n => /^\d{4}-\d\d-\d\d$/.test(n));
  assert.equal(dates.length, 14);
  // 20개의 옛 폴더 + 오늘(25일) = 21개 → 오늘과 20일 ~ 8일(13개)이 남는다.
  assert.equal(dates[0], '2026-09-08');
  assert.equal(dates[13], TODAY);
  assert.deepEqual(result.removed, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07']);
  assert.ok(left.includes('migrations'), 'runner backups stay');
  assert.ok(left.includes('notes'), 'folders that are not dates stay');
  assert.ok(readdirSync(join(config.backupDir, 'migrations')).length > 0);

  assert.deepEqual(rotateBackups(config.backupDir, 1, '2026-09-20'), dates.filter(d => d !== TODAY && d !== '2026-09-20'),
    'today is kept even when it is not among the newest');
});

test('a failing file fails the run, but old folders still rotate except the last good copy of that file', () => {
  const config = preparedConfig('broken', 'shop-a,shop-b,shop-c');
  // 옛날 두 번의 성공: 2020-01-01, 2020-01-02(shop-b · shop-c의 마지막 온전한 사본).
  assert.equal(runBackup(config, { ...quiet, now: () => new Date('2020-01-01T03:00:00Z') }).ok, true);
  assert.equal(runBackup(config, { ...quiet, now: () => new Date('2020-01-02T03:00:00Z') }).ok, true);

  // shop-b: 열리지만 VACUUM INTO가 실패(가운데 쪽이 망가짐). shop-c: 데이터베이스가 아님. shop-gone: 파일 없음.
  corruptPages(join(config.shopDbDir, 'shop-b.sqlite'));
  writeFileSync(join(config.shopDbDir, 'shop-c.sqlite'), 'not a database'.repeat(400));
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(join(config.shopDbDir, `shop-c.sqlite${suffix}`))) writeFileSync(join(config.shopDbDir, `shop-c.sqlite${suffix}`), '');
  }
  const withMissing = testConfig(config.dataDir, { SKINOTE_SHOP_IDS: 'shop-a,shop-b,shop-c,shop-gone', SKINOTE_BACKUP_KEEP_DAYS: '1' });
  const result = runBackup(withMissing, { ...quiet, now: () => AT_0400_SEOUL });
  assert.equal(result.ok, false);
  const bySource = Object.fromEntries(result.items.map(i => [i.source, i]));
  assert.equal(bySource['control.sqlite'].ok, true);
  assert.equal(bySource['shops/shop-a.sqlite'].ok, true);
  assert.equal(bySource['shops/shop-b.sqlite'].error, 'SQLITE_CORRUPT');
  assert.equal(bySource['shops/shop-c.sqlite'].error, 'SQLITE_NOTADB');
  assert.equal(bySource['shops/shop-gone.sqlite'].error, 'MISSING');
  // 오늘 폴더가 control · shop-a의 마지막 사본을 가지므로 2020-01-01은 지우고, shop-b · shop-c의 마지막 사본(2020-01-02)은 남긴다.
  assert.deepEqual(result.removed, ['2020-01-01']);
  assert.ok(existsSync(join(config.backupDir, '2020-01-02')));
  const dir = join(config.backupDir, TODAY);
  const files = readdirSync(dir);
  assert.ok(!files.some(n => n.startsWith('shop-b.') || n.startsWith('shop-c.')), `no partial copy of the broken files: ${files.join(', ')}`);
  assertSumsMatch(dir);
});

test('not enough free disk: nothing is written, the run fails with NO_SPACE, old folders are pruned first', () => {
  const config = preparedConfig('no-space', 'shop-a', { SKINOTE_BACKUP_RESERVE_MB: '100', SKINOTE_BACKUP_KEEP_DAYS: '1' });
  for (const day of ['2026-09-01', '2026-09-02']) mkdirSync(join(config.backupDir, day), { recursive: true });
  const tiny = () => ({ bavail: 10, bsize: 1024 * 1024, blocks: 100_000 }); // 10 MB 남음
  const result = runBackup(config, { ...quiet, now: () => AT_0400_SEOUL, statfs: tiny });
  assert.equal(result.ok, false);
  assert.deepEqual(result.items.map(i => i.error), ['NO_SPACE', 'NO_SPACE']);
  assert.deepEqual(result.removed, ['2026-09-01', '2026-09-02'], 'rotation ran to free space');
  const dir = join(config.backupDir, TODAY);
  assert.deepEqual(readdirSync(dir), ['manifest.json'], 'no copy was written');

  // 여유가 넉넉하면 같은 설정으로 성공한다.
  const roomy = () => ({ bavail: 100_000, bsize: 1024 * 1024, blocks: 200_000 });
  assert.equal(runBackup(config, { ...quiet, now: () => AT_0400_SEOUL, statfs: roomy }).ok, true);
});

test('leftovers of a killed run (.partial-* and unlisted copies) are removed by the next run', () => {
  const config = preparedConfig('leftovers', 'shop-a');
  assert.equal(runBackup(config, { ...quiet, now: () => AT_0400_SEOUL }).ok, true);
  const dir = join(config.backupDir, TODAY);
  mkdirSync(join(dir, '.partial-12345'));
  writeFileSync(join(dir, '.partial-12345', 'shop-a.daily.v0001.20260924T185959000Z.sqlite'), 'half');
  writeFileSync(join(dir, 'shop-a.daily.v0001.20260924T185958000Z.sqlite'), 'unlisted');
  const result = runBackup(config, { ...quiet, now: () => new Date(AT_0400_SEOUL.getTime() + 60_000) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.cleaned.sort(), [`${TODAY}/.partial-12345`, `${TODAY}/shop-a.daily.v0001.20260924T185958000Z.sqlite`]);
  assertSumsMatch(dir);
});

test('only one backup runs at a time; a lock left by a finished process is taken over', () => {
  const config = preparedConfig('lock', 'shop-a');
  const lock = join(config.backupDir, LOCK_FILE);
  writeFileSync(lock, `${process.ppid}\n`); // 살아 있는 다른 프로세스(시험을 돌리는 쪽)
  assert.throws(() => runBackup(config, { ...quiet, now: () => AT_0400_SEOUL }), (/** @type {any} */ e) => e.code === 'BACKUP_RUNNING');
  assert.ok(!existsSync(join(config.backupDir, TODAY, 'SHA256SUMS')), 'nothing was written while locked');
  writeFileSync(lock, '999999999\n'); // 끝난 프로세스
  assert.equal(runBackup(config, { ...quiet, now: () => AT_0400_SEOUL }).ok, true);
  assert.ok(!existsSync(lock), 'the lock is released');
});

test('migrations/ keeps the newest 2 versions per file and kind, and the newest 3 copies per version', () => {
  const dir = join(temp.dir, 'migrations-prune');
  mkdirSync(dir, { recursive: true });
  for (const label of ['pre_migration', 'post_migration']) {
    for (let version = 1; version <= 4; version += 1) {
      for (let copy = 0; copy < 5; copy += 1) {
        const name = `shop-a.${label}.v${String(version).padStart(4, '0')}.2026090${version}T00000${copy}000Z.sqlite`;
        writeFileSync(join(dir, name), 'x');
        writeFileSync(join(dir, `${name}.verified`), '{}');
      }
    }
  }
  writeFileSync(join(dir, 'notes.txt'), 'kept');
  const dropped = pruneMigrationBackups(dir);
  assert.equal(dropped.length, 2 * (2 * 5 + 2 * (5 - MIGRATION_KEEP_COPIES)));
  const left = readdirSync(dir).filter(n => n.endsWith('.sqlite')).sort();
  assert.equal(left.length, 2 * 2 * MIGRATION_KEEP_COPIES);
  assert.ok(left.every(n => /\.v000[34]\./.test(n)), left.join(', '));
  assert.ok(left.includes('shop-a.post_migration.v0004.20260904T000004000Z.sqlite'), 'the newest post_migration copy stays');
  assert.equal(readdirSync(dir).filter(n => n.endsWith('.verified')).length, left.length, 'markers go with their copies');
  assert.ok(existsSync(join(dir, 'notes.txt')));
});

test('restore round trip following deploy/README.md section 5', async () => {
  const config = preparedConfig('restore', 'shop-a');
  const shopFile = join(config.shopDbDir, 'shop-a.sqlite');
  const live = openDatabases(config, quiet);
  try {
    /** @type {import('node:sqlite').DatabaseSync} */ (live[1].db)
      .prepare("INSERT INTO db_instance (singleton, instance_id, deployment_key, created_at) VALUES (1, 'before-backup', 'staging', '2026-09-24T18:00:00Z')").run();
  } finally {
    closeDatabases(live);
  }
  const backup = runBackup(config, { ...quiet, now: () => AT_0400_SEOUL });
  assert.equal(backup.ok, true);
  const copy = join(backup.dir, /** @type {string} */ (backup.items[1].file));

  // 백업 뒤의 쓰기(되살리면 잃는 것), 그리고 파일이 망가진 상황.
  const later = openDatabase(shopFile);
  later.prepare("UPDATE db_instance SET instance_id = 'after-backup'").run();
  later.close();
  corruptPages(shopFile);

  // 1. 서버를 멈춘 상태 2. SHA256SUMS 확인 3. -wal · -shm과 함께 옆으로 4. install -m 600으로 복사 5. 켜고 확인.
  assertSumsMatch(backup.dir);
  const stamp = '20260925T000000Z';
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(shopFile + suffix)) renameSync(shopFile + suffix, `${shopFile}${suffix}.before-restore-${stamp}`);
  }
  copyFileSync(copy, shopFile);
  chmodSync(shopFile, 0o600);

  const app = await startServer(config, quiet);
  try {
    const body = await (await request(app.port, '/api/health')).json();
    const shop = body.databases.find((/** @type {any} */ d) => d.shopId === 'shop-a');
    assert.equal(shop.status, 'up_to_date');
    assert.equal(shop.writable, true);
    assert.deepEqual(shop.warnings, []);
    assert.equal(body.ok, true);
    const db = /** @type {import('node:sqlite').DatabaseSync} */ (app.entries[1].db);
    assert.deepEqual(db.prepare('SELECT instance_id FROM db_instance').all().map(r => r.instance_id), ['before-backup']);
  } finally {
    await app.close();
  }
});

test('bin/backup.js exits 0 on success, 1 on failure, 78 on a config error', () => {
  const config = preparedConfig('cli', 'shop-a');
  const run = (/** @type {Record<string, string>} */ env) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'bin/backup.js'], {
    cwd: PACKAGE_DIR,
    env: { PATH: process.env.PATH ?? '', SKINOTE_DATA_DIR: config.dataDir, SKINOTE_RELEASE: 'test', SKINOTE_BACKUP_RESERVE_MB: '0', ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const ok = run({ SKINOTE_SHOP_IDS: 'shop-a' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /2\/2개 성공/);
  const failed = run({ SKINOTE_SHOP_IDS: 'shop-a,shop-missing' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /shops\/shop-missing\.sqlite \(MISSING\)/);
  const bad = run({ SKINOTE_SHOP_IDS: '../etc' });
  assert.equal(bad.status, 78);
});

test('each shop copy records its rev and epoch, and control tenant_epochs.max_rev_seen rises to it (restore needs the highest rev ever seen)', async () => {
  const { provisionedShop, cli: runCli, SHOP: shopId } = await import('./helpers.js');
  const { openControlStore } = await import('@skinote/store');
  const dataDir = join(temp.dir, 'max-rev');
  const shop = await provisionedShop(dataDir);
  // 견본 하루를 넣어 rev를 올린다(시험 매장).
  const loaded = await runCli(['load-sample', '--shop', shopId, '--date', '2026-12-26'], shop.env);
  assert.equal(loaded.code, 0, loaded.err);
  const config = testConfig(dataDir, shop.env);
  const result = runBackup(config, { ...quiet, now: () => AT_0400_SEOUL });
  assert.equal(result.ok, true);
  const item = result.items.find(i => i.kind === 'shop');
  assert.equal(item?.rev, 1, 'the copy holds rev 1 (the import)');
  assert.match(item?.epoch ?? '', /^[0-9A-HJKMNP-TV-Z]{26}$/);
  const manifest = JSON.parse(readFileSync(join(config.backupDir, TODAY, 'manifest.json'), 'utf8'));
  assert.equal(manifest.runs[0].items.find((/** @type {any} */ i) => i.kind === 'shop').rev, 1);
  const control = openDatabase(join(dataDir, 'db', 'control.sqlite'));
  try {
    assert.deepEqual(openControlStore(/** @type {any} */ (control)).currentEpoch(shopId), { epochNo: 1, epochId: item?.epoch, maxRevSeen: 1, revFloor: 0 });
  } finally {
    control.close();
  }
});

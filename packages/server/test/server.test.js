// @ts-check
// HTTP 서버: 상태 확인 본문의 모양(임시 폴더), 다시 시작하면 up_to_date, 백업 뒤 lastBackupAt · 경고, 앞단을 거친 요청에는 ok만,
// 살아 있음, 404 · 405, 요청 기록에 물음표 뒤(query) · 절대 주소의 사용자 정보가 없음, 닫으면 데이터베이스도 닫힘.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runBackup } from '../src/backup.js';
import { canWrite } from '../src/databases.js';
import { buildHealth } from '../src/health.js';
import { pathOf, startServer } from '../src/server.js';
import { loadMigrations } from '@skinote/schema';
import { collectLog, request, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());
/** 배포한 마이그레이션 수(종류마다): control 0001, shop 0001 + 0002. */
const KNOWN = /** @type {Record<string, number>} */ ({ control: loadMigrations('control').length, shop: loadMigrations('shop').length });
const SHOPS = '01K5ZQ8Y7M3N4P5Q6R7S8T9V0W,shop-b';

test('health on a fresh data dir: every file migrated, WAL, pages, no absolute paths', async () => {
  const dataDir = join(temp.dir, 'fresh');
  const config = testConfig(dataDir, { SKINOTE_SHOP_IDS: SHOPS });
  const { lines, log } = collectLog();
  const app = await startServer(config, { log });
  try {
    assert.ok(existsSync(join(dataDir, 'db', 'control.sqlite')));
    assert.ok(existsSync(join(dataDir, 'db', 'shops', '01K5ZQ8Y7M3N4P5Q6R7S8T9V0W.sqlite')));
    assert.ok(existsSync(join(dataDir, 'db', 'shops', 'shop-b.sqlite')));

    const res = await request(app.port, '/api/health');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const text = await res.text();
    assert.ok(!text.includes(temp.dir), 'no absolute path in the health payload');
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), [
      'cutoff', 'databases', 'disk', 'node', 'ok', 'release', 'serverTime', 'service', 'shops', 'startedAt', 'testOpenEnroll', 'timeZone', 'uptimeSeconds', 'warnings',
    ]);
    assert.ok(body.warnings.includes('BACKUP_MISSING'), 'no daily backup yet');
    assert.deepEqual(body.testOpenEnroll, { flag: 'off', active: false, devices: 0 }, 'open enrollment is off by default (no TEST_OPEN_ENROLL warning)');
    assert.ok(!body.warnings.includes('TEST_OPEN_ENROLL'));
    assert.equal(body.ok, true);
    assert.equal(body.service, 'skinote-server');
    assert.equal(body.release, 'test');
    assert.equal(body.timeZone, 'Asia/Seoul');
    assert.equal(body.cutoff, '06:00');
    assert.match(body.serverTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(body.shops.length, 2);
    for (const shop of body.shops) {
      assert.deepEqual(Object.keys(shop).sort(), ['businessDate', 'shopId', 'writable']);
      assert.match(shop.businessDate, /^\d{4}-\d\d-\d\d$/);
      assert.equal(shop.writable, true);
    }
    assert.deepEqual(body.databases.map((/** @type {any} */ d) => [d.kind, d.shopId, d.file]), [
      ['control', null, 'control.sqlite'],
      ['shop', '01K5ZQ8Y7M3N4P5Q6R7S8T9V0W', '01K5ZQ8Y7M3N4P5Q6R7S8T9V0W.sqlite'],
      ['shop', 'shop-b', 'shop-b.sqlite'],
    ]);
    for (const db of body.databases) {
      assert.equal(db.status, 'migrated');
      assert.equal(db.mode, 'read_write');
      assert.equal(db.writable, true);
      assert.equal(db.schemaVersion, KNOWN[db.kind]);
      assert.equal(db.knownVersion, KNOWN[db.kind]);
      assert.equal(db.migrationCount, KNOWN[db.kind]);
      assert.equal(db.appliedAtStart, KNOWN[db.kind]);
      assert.equal(db.reason, null);
      assert.deepEqual(db.warnings, []);
      assert.equal(db.journalMode, 'wal');
      assert.ok(db.pageCount > 0);
      assert.equal(db.pageSize, 4096);
      assert.equal(db.lastBackupAt, null);
    }
    assert.ok(body.disk === null || typeof body.disk.freeBytes === 'number');
    assert.ok(canWrite(app.entries, 'shop-b'));
    assert.ok(!canWrite(app.entries, 'no-such-shop'));

    const head = await request(app.port, '/api/health', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    assert.ok(lines.some(l => l.startsWith('control.sqlite: 적용 0001_control')), lines.join('\n'));
  } finally {
    await app.close();
  }
  assert.ok(app.entries.every(e => e.db === null && e.mode === 'closed'), 'close() closes every database');

  // 다시 시작: 남은 마이그레이션이 없다.
  const again = await startServer(config, { log: () => {} });
  try {
    const body = await (await request(again.port, '/api/health')).json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.databases.map((/** @type {any} */ d) => [d.status, d.appliedAtStart, d.migrationCount]), [
      ['up_to_date', 0, KNOWN.control], ['up_to_date', 0, KNOWN.shop], ['up_to_date', 0, KNOWN.shop],
    ]);

    // 백업 뒤에는 파일마다 마지막 백업 시각이 보인다.
    const backup = runBackup(config, { log: () => {}, now: () => new Date('2026-09-25T19:00:00Z') });
    assert.equal(backup.ok, true);
    const afterBackup = await (await request(again.port, '/api/health')).json();
    for (const db of afterBackup.databases) assert.equal(db.lastBackupAt, '2026-09-25T19:00:00.000Z');
    assert.ok(!afterBackup.warnings.includes('BACKUP_MISSING'));

    // 앞단(Caddy)을 거친 요청에는 ok만 준다(판 · 매장 id · 크기 · 디스크 없음).
    for (const header of ['x-forwarded-for', 'x-forwarded-proto', 'forwarded', 'via']) {
      const proxied = await request(again.port, '/api/health', { headers: { [header]: '203.0.113.7' } });
      assert.equal(proxied.status, 200, header);
      assert.deepEqual(await proxied.json(), { ok: true }, header);
    }
  } finally {
    await again.close();
  }
});

test('live, 404, 405 and request logging without query strings', async () => {
  const config = testConfig(join(temp.dir, 'routes'), { SKINOTE_SHOP_IDS: 'shop-a' });
  const { lines, log } = collectLog();
  const app = await startServer(config, { log });
  try {
    const live = await request(app.port, '/api/health/live');
    assert.equal(live.status, 200);
    assert.equal(await live.text(), 'ok\n');
    assert.match(live.headers.get('content-type') ?? '', /^text\/plain/);

    for (const path of ['/', '/api', '/api/health/', '/api/v2/commands', '/index.html', '/api/healthz']) {
      const res = await request(app.port, path);
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { ok: false, error: 'not_found' });
    }
    const post = await request(app.port, '/api/health', { method: 'POST', body: '{}' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    assert.deepEqual(await post.json(), { ok: false, error: 'method_not_allowed' });

    const withQuery = await request(app.port, '/api/health?phone=01000001234&name=secret');
    assert.equal(withQuery.status, 200, 'the query does not change the route');
    await withQuery.text();
    await new Promise(resolve => setTimeout(resolve, 20));
    const requestLines = lines.filter(l => /^(GET|HEAD|POST) /.test(l));
    assert.ok(requestLines.some(l => /^GET \/api\/health 200 \d+ms$/.test(l)), requestLines.join('\n'));
    assert.ok(requestLines.some(l => /^POST \/api\/health 405 \d+ms$/.test(l)), requestLines.join('\n'));
    assert.ok(requestLines.some(l => /^GET \/api\/v2\/commands 404 \d+ms$/.test(l)));
    assert.ok(!lines.join('\n').includes('01000001234'), 'no query string in the log');
    assert.ok(!lines.join('\n').includes('secret'), 'no query string in the log');

    // 절대 주소 모양의 요청 줄: 경로만 적고 사용자 정보 · 호스트는 적지 않는다.
    const raw = await new Promise((resolve, reject) => {
      const socket = connect(app.port, '127.0.0.1', () => {
        socket.end('GET http://someone:hunter2@example.invalid/api/health/live?x=1 HTTP/1.1\r\nHost: example.invalid\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', chunk => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    assert.match(String(raw), /^HTTP\/1\.1 200/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(lines.some(l => /^GET \/api\/health\/live 200 \d+ms$/.test(l)), lines.join('\n'));
    assert.ok(!lines.join('\n').includes('hunter2') && !lines.join('\n').includes('example.invalid'), 'no userinfo or host in the log');
  } finally {
    await app.close();
  }
});

test('pathOf: query and fragment cut, absolute-form reduced to the path, junk to a placeholder', () => {
  assert.equal(pathOf('/api/health?phone=1'), '/api/health');
  assert.equal(pathOf('/api/health#x'), '/api/health');
  assert.equal(pathOf('/api//health'), '/api//health', 'origin-form is compared as sent');
  assert.equal(pathOf('http://user:pass@host:8080/api/health?x'), '/api/health');
  assert.equal(pathOf('*'), '*');
  assert.equal(pathOf('user:pass@host/x'), '-');
  assert.equal(pathOf(undefined), '/');
});

test('health warnings: stale backups and a nearly full disk do not change ok', () => {
  const config = testConfig(join(temp.dir, 'warnings'), { SKINOTE_SHOP_IDS: 'shop-a', SKINOTE_BACKUP_RESERVE_MB: '1048576' });
  mkdirSync(config.dataDir, { recursive: true });
  const now = new Date('2026-09-25T10:00:00Z');
  /** @type {any[]} */
  const entries = ['control', 'shop'].map(kind => ({
    kind, shopId: kind === 'shop' ? 'shop-a' : null, source: kind === 'shop' ? 'shops/shop-a.sqlite' : 'control.sqlite',
    file: '/x', name: 'x.sqlite', status: 'up_to_date', mode: 'read_write', writable: true, warnings: [], db: null,
    schemaVersion: 1, knownVersion: 1, migrationCount: 1, appliedAtStart: 0, reason: null,
  }));
  const fresh = new Map([['control.sqlite', '2026-09-25T04:00:00.000Z'], ['shops/shop-a.sqlite', '2026-09-25T04:00:00.000Z']]);
  const stale = new Map([['control.sqlite', '2026-09-25T04:00:00.000Z'], ['shops/shop-a.sqlite', '2026-09-24T07:59:00.000Z']]);
  const base = { config, entries, startedAt: now, now };
  const ok = buildHealth({ ...base, lastBackups: fresh });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.warnings, ['DISK_LOW'], 'a 1 TB reserve is more than any test disk has free');
  const old = buildHealth({ ...base, lastBackups: stale });
  assert.equal(old.status, 200);
  assert.deepEqual(old.body.warnings, ['BACKUP_STALE', 'DISK_LOW']);
});

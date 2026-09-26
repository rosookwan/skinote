// @ts-check
// 설정 읽기: 기본값, 매장 id 검사(파일 이름으로 안전한 모양), 틀린 값은 모두 모아 한 번에 알림, 판 이름 파일.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ConfigError, isLoopbackHost, loadConfig, parseCutoff } from '../src/config.js';
import { tempDir } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());
const noRelease = { releaseFile: join(temp.dir, 'NO_RELEASE') };

/** @param {Record<string, string>} env */
function problemsOf(env) {
  try {
    loadConfig(env, { cwd: temp.dir, ...noRelease });
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems;
  }
  assert.fail('ConfigError를 기대했습니다');
}

test('defaults: ./data under cwd, 127.0.0.1:3100, Asia/Seoul, cutoff 06:00, release dev, 14 backup days', () => {
  const config = loadConfig({}, { cwd: temp.dir, ...noRelease });
  assert.equal(config.dataDir, join(temp.dir, 'data'));
  assert.equal(config.dbDir, join(temp.dir, 'data', 'db'));
  assert.equal(config.shopDbDir, join(temp.dir, 'data', 'db', 'shops'));
  assert.equal(config.backupDir, join(temp.dir, 'data', 'backups'));
  assert.equal(config.migrationBackupDir, join(temp.dir, 'data', 'backups', 'migrations'));
  assert.equal(config.port, 3100);
  assert.equal(config.host, '127.0.0.1');
  assert.deepEqual(config.shopIds, []);
  assert.equal(config.timeZone, 'Asia/Seoul');
  assert.equal(config.cutoff, '06:00');
  assert.equal(config.cutoffMinutes, 360);
  assert.equal(config.release, 'dev');
  assert.equal(config.backupKeepDays, 14);
  assert.equal(config.backupReserveBytes, 2048 * 1024 * 1024);
  assert.ok(Object.isFrozen(config));
});

test('values from the environment; blanks count as unset; shop ids are trimmed', () => {
  const config = loadConfig({
    SKINOTE_DATA_DIR: '/var/lib/skinote',
    SKINOTE_PORT: '3200',
    SKINOTE_HOST: '  ',
    SKINOTE_SHOP_IDS: ' 01K0000000000000000000000A, shop_2 ,shop-3',
    SKINOTE_TZ: 'UTC',
    SKINOTE_CUTOFF: '00:00',
    SKINOTE_RELEASE: '20260925T031500Z-ea53d4e',
    SKINOTE_BACKUP_KEEP_DAYS: '7',
    SKINOTE_BACKUP_RESERVE_MB: '0',
  }, noRelease);
  assert.equal(config.dataDir, '/var/lib/skinote');
  assert.equal(config.port, 3200);
  assert.equal(config.host, '127.0.0.1');
  assert.deepEqual(config.shopIds, ['01K0000000000000000000000A', 'shop_2', 'shop-3']);
  assert.equal(config.timeZone, 'UTC');
  assert.equal(config.cutoffMinutes, 0);
  assert.equal(config.release, '20260925T031500Z-ea53d4e');
  assert.equal(config.backupKeepDays, 7);
  assert.equal(config.backupReserveBytes, 0);
});

test('shop ids must be safe file names, unique (ignoring case) and not "control"', () => {
  for (const bad of ['../etc', 'a.b', 'a/b', 'a b', '-lead', '_lead', 'x'.repeat(65), '한글', 'control', 'CONTROL']) {
    const problems = problemsOf({ SKINOTE_SHOP_IDS: bad });
    assert.equal(problems.length, 1, `${bad}: ${problems.join(' / ')}`);
  }
  assert.match(problemsOf({ SKINOTE_SHOP_IDS: 'a,,b' })[0], /2번째 값이 비어/);
  assert.match(problemsOf({ SKINOTE_SHOP_IDS: 'a,b,' })[0], /3번째 값이 비어/);
  assert.match(problemsOf({ SKINOTE_SHOP_IDS: 'Shop1,shop1' })[0], /두 번/);
  assert.equal(loadConfig({ SKINOTE_SHOP_IDS: 'x'.repeat(64) }, noRelease).shopIds[0].length, 64);
});

test('every wrong value is reported at once', () => {
  const problems = problemsOf({
    SKINOTE_PORT: '0',
    SKINOTE_HOST: 'bad host',
    SKINOTE_SHOP_IDS: 'ok,../x',
    SKINOTE_TZ: 'Mars/Olympus',
    SKINOTE_CUTOFF: '6:00',
    SKINOTE_RELEASE: 'a/b',
    SKINOTE_BACKUP_KEEP_DAYS: '0',
    SKINOTE_BACKUP_RESERVE_MB: '-1',
  });
  assert.equal(problems.length, 8, problems.join('\n'));
  assert.match(problems.join('\n'), /SKINOTE_BACKUP_RESERVE_MB/);
  assert.match(problems.join('\n'), /SKINOTE_PORT/);
  assert.match(problems.join('\n'), /SKINOTE_TZ/);
  assert.match(problems.join('\n'), /SKINOTE_CUTOFF/);
});

test('port and cutoff ranges', () => {
  assert.equal(problemsOf({ SKINOTE_PORT: '65536' }).length, 1);
  assert.equal(problemsOf({ SKINOTE_PORT: '31.5' }).length, 1);
  assert.equal(problemsOf({ SKINOTE_CUTOFF: '24:00' }).length, 1);
  assert.equal(problemsOf({ SKINOTE_CUTOFF: '06:60' }).length, 1);
  assert.equal(parseCutoff('23:59'), 1439);
  assert.equal(parseCutoff('00:00'), 0);
  assert.equal(parseCutoff('6:00'), undefined);
});

test('release label: SKINOTE_RELEASE, else the RELEASE file written by deploy.sh, else dev', () => {
  const file = join(temp.dir, 'RELEASE');
  writeFileSync(file, '20260925T031500Z-ea53d4e\n');
  assert.equal(loadConfig({}, { cwd: temp.dir, releaseFile: file }).release, '20260925T031500Z-ea53d4e');
  assert.equal(loadConfig({ SKINOTE_RELEASE: 'manual-1' }, { cwd: temp.dir, releaseFile: file }).release, 'manual-1');
  writeFileSync(file, '../../etc/passwd\n');
  assert.throws(() => loadConfig({}, { cwd: temp.dir, releaseFile: file }), ConfigError);
});

test('loopback hosts', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) assert.ok(isLoopbackHost(host), host);
  for (const host of ['0.0.0.0', '::', '10.0.0.1', 'example.com']) assert.ok(!isLoopbackHost(host), host);
});

test('API settings: SKINOTE_API on/off, the public origin (required off loopback), the admin socket path', () => {
  const defaults = loadConfig({}, noRelease);
  assert.equal(defaults.api, 'on');
  assert.equal(defaults.publicOrigin, null, 'a loopback server may go without it (the Host header is compared)');
  assert.equal(defaults.adminSocket, '/run/skinote/admin.sock');
  assert.equal(defaults.secrets, null, 'secrets are read apart (secrets.js)');
  assert.equal(loadConfig({ SKINOTE_API: 'OFF' }, noRelease).api, 'off');
  assert.equal(loadConfig({ SKINOTE_ADMIN_SOCKET: 'off' }, noRelease).adminSocket, null);
  assert.equal(loadConfig({ SKINOTE_PUBLIC_ORIGIN: 'https://shop.example.com' }, noRelease).publicOrigin, 'https://shop.example.com');
  assert.equal(loadConfig({ SKINOTE_PUBLIC_ORIGIN: 'http://localhost:5183' }, noRelease).publicOrigin, 'http://localhost:5183');
  assert.match(problemsOf({ SKINOTE_API: 'maybe' })[0] ?? '', /SKINOTE_API/);
  for (const bad of ['shop.example.com', 'https://shop.example.com/app', 'https://a:b@shop.example.com', 'ftp://shop.example.com', 'https://shop.example.com?x=1', 'https://Shop.Example.com']) {
    assert.equal(problemsOf({ SKINOTE_PUBLIC_ORIGIN: bad }).length, 1, bad);
  }
  assert.match(problemsOf({ SKINOTE_HOST: '0.0.0.0' })[0] ?? '', /SKINOTE_PUBLIC_ORIGIN/, 'an open host needs the public origin');
  assert.equal(loadConfig({ SKINOTE_HOST: '0.0.0.0', SKINOTE_API: 'off' }, noRelease).host, '0.0.0.0', 'not with the API off');
  assert.match(problemsOf({ NODE_ENV: 'production' })[0] ?? '', /SKINOTE_PUBLIC_ORIGIN/, 'production (the unit sets NODE_ENV) needs the public origin');
  assert.equal(loadConfig({ NODE_ENV: 'production', SKINOTE_PUBLIC_ORIGIN: 'https://shop.example.com' }, noRelease).publicOrigin, 'https://shop.example.com');
  assert.equal(loadConfig({ NODE_ENV: 'production', SKINOTE_API: 'off' }, noRelease).api, 'off', 'not with the API off');
  assert.equal(problemsOf({ SKINOTE_ADMIN_SOCKET: 'relative.sock' }).length, 1);
  assert.equal(problemsOf({ SKINOTE_ADMIN_SOCKET: '/' + 'x'.repeat(120) }).length, 1, 'socket paths stay under 100 bytes');
});

test('SKINOTE_TEST_OPEN_ENROLL (test shops only): off by default, on/off in any case, on needs a last business day within 14 days', () => {
  // 2026-09-26 12:00 서울 = 영업일 2026-09-26.
  const now = new Date('2026-09-26T03:00:00Z');
  const at = { ...noRelease, now };
  const on = { SKINOTE_TEST_OPEN_ENROLL: 'on', SKINOTE_TEST_OPEN_ENROLL_UNTIL: '2026-10-03' };
  assert.equal(loadConfig({}, at).testOpenEnroll, 'off');
  assert.equal(loadConfig({}, at).testOpenEnrollUntil, null);
  assert.deepEqual([loadConfig(on, at).testOpenEnroll, loadConfig(on, at).testOpenEnrollUntil], ['on', '2026-10-03']);
  assert.equal(loadConfig({ ...on, SKINOTE_TEST_OPEN_ENROLL: ' ON ' }, at).testOpenEnroll, 'on');
  assert.equal(loadConfig({ SKINOTE_TEST_OPEN_ENROLL: 'off' }, at).testOpenEnroll, 'off');
  assert.equal(loadConfig({ SKINOTE_TEST_OPEN_ENROLL: '' }, at).testOpenEnroll, 'off', 'a blank counts as unset');
  assert.equal(loadConfig({ SKINOTE_TEST_OPEN_ENROLL: 'off', SKINOTE_TEST_OPEN_ENROLL_UNTIL: 'soon' }, at).testOpenEnrollUntil, null, 'off ignores the date');
  for (const bad of ['yes', '1', 'true', 'open']) {
    assert.match(problemsOf({ SKINOTE_TEST_OPEN_ENROLL: bad })[0] ?? '', /SKINOTE_TEST_OPEN_ENROLL은 on 또는 off/, bad);
  }
  const problems = (/** @type {Record<string, string>} */ env) => {
    try {
      loadConfig(env, { cwd: temp.dir, ...at });
    } catch (error) {
      return /** @type {ConfigError} */ (error).problems;
    }
    return [];
  };
  assert.match(problems({ SKINOTE_TEST_OPEN_ENROLL: 'on' })[0] ?? '', /SKINOTE_TEST_OPEN_ENROLL_UNTIL=YYYY-MM-DD/, 'on without a date stops the start');
  for (const bad of ['2026-02-30', '2026-9-30', 'next week']) {
    assert.match(problems({ ...on, SKINOTE_TEST_OPEN_ENROLL_UNTIL: bad })[0] ?? '', /SKINOTE_TEST_OPEN_ENROLL_UNTIL=YYYY-MM-DD/, bad);
  }
  assert.equal(loadConfig({ ...on, SKINOTE_TEST_OPEN_ENROLL_UNTIL: '2026-10-10' }, at).testOpenEnrollUntil, '2026-10-10', 'today + 14 is the furthest');
  assert.match(problems({ ...on, SKINOTE_TEST_OPEN_ENROLL_UNTIL: '2026-10-11' })[0] ?? '', /14일 안/);
  assert.equal(loadConfig({ ...on, SKINOTE_TEST_OPEN_ENROLL_UNTIL: '2026-09-20' }, at).testOpenEnrollUntil, '2026-09-20', 'a past day starts (open enrollment is just off, with a warning)');
  // 05:00 서울은 아직 전 영업일(09-25)이라 10-10은 15일 뒤.
  const early = { cwd: temp.dir, ...noRelease, now: new Date('2026-09-25T20:00:00Z') };
  assert.throws(() => loadConfig({ ...on, SKINOTE_TEST_OPEN_ENROLL_UNTIL: '2026-10-10' }, early), /14일 안/, 'the business day uses the 06:00 cutoff');
});

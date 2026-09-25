// @ts-check
// 시작점(src/main.js)을 따로 된 프로세스로: 환경 변수로 설정, 두 상태 확인 길, SIGTERM에 깔끔히 끝남(끝 코드 0),
// 같은 포트에 두 번째 서버는 파일을 열기 전에 끝남, 설정 오류는 78, 시작(마이그레이션 · 백업) 도중의 SIGTERM은 시작을 마친 뒤
// 깔끔히 끝남(반쯤 쓴 사본을 남기지 않음).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkBackupFile } from '../src/backup-files.js';
import { newSecretsEnv } from '../src/secrets.js';
import { freePort, PACKAGE_DIR, request, tempDir } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

/** 시험마다 새로 뽑은 비밀값(API를 켠 서버는 비밀값 넷이 있어야 시작한다), 관리 소켓 없음. */
const SECRETS = { ...newSecretsEnv(), SKINOTE_ADMIN_SOCKET: 'off' };

/** @param {Record<string, string>} env */
function start(env) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
    cwd: PACKAGE_DIR,
    env: { PATH: process.env.PATH ?? '', ...SECRETS, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => output };
}

/** @param {number} port */
async function waitLive(port, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await request(port, '/api/health/live');
      if (res.ok) return await res.text();
    } catch {
      /* 아직 안 뜸 */
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('서버가 뜨지 않았습니다');
}

test('main.js serves health, refuses a second instance on the same port, and exits 0 on SIGTERM', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const dataDir = join(temp.dir, 'data');
  const env = { SKINOTE_DATA_DIR: dataDir, SKINOTE_PORT: String(port), SKINOTE_SHOP_IDS: 'shop-a', SKINOTE_RELEASE: 'main-test' };
  const server = start(env);
  try {
    assert.equal(await waitLive(port), 'ok\n');
    const body = await (await request(port, '/api/health')).json();
    assert.equal(body.ok, true);
    assert.equal(body.release, 'main-test');

    const second = start({ ...env, SKINOTE_SHOP_IDS: 'shop-a,shop-second' });
    const secondExit = /** @type {{ code: number }} */ (await second.exited);
    assert.equal(secondExit.code, 1, second.output());
    assert.match(second.output(), /EADDRINUSE/);
    assert.ok(!existsSync(join(dataDir, 'db', 'shops', 'shop-second.sqlite')), 'the second instance never touched the data');
  } finally {
    server.child.kill('SIGTERM');
  }
  const exit = /** @type {{ code: number, signal: string | null }} */ (await server.exited);
  assert.equal(exit.code, 0, server.output());
  assert.match(server.output(), /SIGTERM 받음/);
  assert.match(server.output(), /종료: 데이터베이스를 닫았습니다/);
  assert.ok(!existsSync(join(dataDir, 'db', 'control.sqlite-wal')), 'closing checkpoints and removes the WAL file');
});

test('main.js exits 78 when the API is on and a secret is missing, and names the secret without a value', () => {
  const dataDir = join(temp.dir, 'no-secret');
  const env = { ...SECRETS };
  delete env.SKINOTE_IP_KEY;
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
    cwd: PACKAGE_DIR,
    env: { PATH: process.env.PATH ?? '', SKINOTE_DATA_DIR: dataDir, ...env, SKINOTE_SESSION_KEY: 'short' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /SKINOTE_IP_KEY가 없습니다/);
  assert.match(result.stderr, /SKINOTE_SESSION_KEY는 base64url/);
  for (const value of Object.values(env)) assert.ok(!result.stderr.includes(value) || value === 'off', 'no secret value in the output');
  assert.ok(!existsSync(dataDir));
});

test('main.js exits 78 on a config error without creating anything', () => {
  const dataDir = join(temp.dir, 'bad-config');
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
    cwd: PACKAGE_DIR,
    env: { PATH: process.env.PATH ?? '', SKINOTE_DATA_DIR: dataDir, SKINOTE_SHOP_IDS: 'a/b', SKINOTE_TZ: 'Nowhere/City' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /SKINOTE_TZ/);
  assert.match(result.stderr, /a\/b/);
  assert.ok(!existsSync(dataDir));
});

test('SIGTERM during startup waits for the migrations and their backups, then exits 0 with every copy intact', { timeout: 120_000 }, async () => {
  const port = await freePort();
  const dataDir = join(temp.dir, 'many');
  const shops = Array.from({ length: 30 }, (_, i) => `s${String(i).padStart(2, '0')}`);
  const server = start({ SKINOTE_DATA_DIR: dataDir, SKINOTE_PORT: String(port), SKINOTE_SHOP_IDS: shops.join(','), SKINOTE_RELEASE: 'main-test' });
  const migrations = join(dataDir, 'backups', 'migrations');
  // 첫 사본이 보이면(포트를 잡은 뒤, 곧 신호 처리가 걸린 뒤) 마이그레이션 도중에 SIGTERM을 보낸다.
  const until = Date.now() + 60_000;
  while (Date.now() < until && !(existsSync(migrations) && readdirSync(migrations).some(n => n.endsWith('.sqlite')))) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const copiesAtSignal = readdirSync(migrations).filter(n => n.endsWith('.sqlite')).length;
  server.child.kill('SIGTERM');
  const exit = /** @type {{ code: number, signal: string | null }} */ (await server.exited);
  assert.equal(exit.signal, null, server.output());
  assert.equal(exit.code, 0, server.output());
  assert.ok(copiesAtSignal < shops.length + 1, `the signal arrived during startup (${copiesAtSignal} copies by then)`);
  // 신호는 동기 시작이 끝난 뒤에 처리된다(어느 문구가 찍히는지는 그 순간에 달림). 중요한 것은 신호로 죽지 않은 것이다.
  assert.match(server.output(), /SIGTERM 받음/);
  assert.match(server.output(), /데이터베이스 31개 중 쓰기 가능 31개[\s\S]*종료: 데이터베이스를 닫았습니다/);
  const copies = readdirSync(migrations).filter(n => n.endsWith('.sqlite'));
  assert.equal(copies.length, shops.length + 1, 'every file finished its post_migration copy');
  for (const name of copies) assert.deepEqual(checkBackupFile(join(migrations, name)), { ok: true }, name);
});

#!/usr/bin/env node
// @ts-check
// 이 서버 패키지를 임시 자료 폴더로 한 번 띄워 본다: 두 상태 확인 길(앞단을 거친 요청에는 ok만) → 장부 API의 문(세션 없음 401, Origin 없는
// 명령 403, Origin이 맞아도 세션 없는 명령 401: 저장소 · 도메인 패키지까지 읽혀 API가 켜졌는지) → 백업 명령 → SIGTERM으로 깔끔히 끝남.
// deploy.sh가 올리기 전에 만든 릴리스 사본(릴리스/server)에서 돌려 빠진 파일 · 잘못 이은 @skinote/* 패키지를 잡는다.
// 비밀값은 이 점검만의 새 값(운영 secrets.env를 읽지 않음), 관리 소켓은 끈다(/run/skinote가 없는 맥에서도 돈다).
//   node bin/smoke.js [--expect-release <판 이름>]
// 끝 코드 0 = 통과, 1 = 실패. 임시 폴더는 끝나면 지운다. 운영 자료 폴더는 건드리지 않는다.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newSecretsEnv, newSecretValue, PROXY_TOKEN_NAME } from '../src/secrets.js';

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url));
const BACKUP = fileURLToPath(new URL('./backup.js', import.meta.url));
const FLAGS = ['--disable-warning=ExperimentalWarning'];
/** 점검 서버의 앱 주소(Origin 확인에만 쓴다: 이 이름으로 나가는 연결은 없다). */
const ORIGIN = 'https://smoke.invalid';

/** @returns {Promise<number>} */
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  await new Promise(resolve => server.close(() => resolve(undefined)));
  return port;
}

/** @param {string} url @param {number} timeoutMs */
async function waitFor(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      /* 아직 안 뜸 */
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${timeoutMs} ms 안에 답이 없습니다: ${url}`);
}

async function main() {
  const args = process.argv.slice(2);
  const expectIndex = args.indexOf('--expect-release');
  const expectRelease = expectIndex >= 0 ? args[expectIndex + 1] : undefined;
  const dataDir = mkdtempSync(join(tmpdir(), 'skinote-smoke-'));
  const port = await freePort();
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    SKINOTE_DATA_DIR: dataDir,
    SKINOTE_PORT: String(port),
    SKINOTE_HOST: '127.0.0.1',
    SKINOTE_SHOP_IDS: 'SMOKE',
    // 점검용 임시 폴더라 남길 여유를 따지지 않는다(디스크가 거의 찬 노트북에서도 점검이 돈다).
    SKINOTE_BACKUP_RESERVE_MB: '0',
    SKINOTE_API: 'on',
    SKINOTE_PUBLIC_ORIGIN: ORIGIN,
    SKINOTE_ADMIN_SOCKET: 'off',
    ...newSecretsEnv(),
    [PROXY_TOKEN_NAME]: newSecretValue(),
  };
  const child = spawn(process.execPath, [...FLAGS, MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  /** @type {Promise<number | null>} */
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  try {
    const live = await waitFor(`http://127.0.0.1:${port}/api/health/live`, 10_000);
    if ((await live.text()) !== 'ok\n') throw new Error('/api/health/live의 답이 ok가 아닙니다');
    const health = /** @type {any} */ (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json());
    if (health.ok !== true) throw new Error(`/api/health ok가 아닙니다: ${JSON.stringify(health.databases?.map((/** @type {any} */ d) => [d.file, d.status, d.reason]))}`);
    if (health.databases?.length !== 2) throw new Error('데이터베이스가 둘(control · SMOKE)이 아닙니다');
    if (expectRelease && health.release !== expectRelease) throw new Error(`판 이름이 다릅니다: ${health.release}(기대 ${expectRelease})`);
    const proxied = await (await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).json();
    if (JSON.stringify(proxied) !== JSON.stringify({ ok: true })) throw new Error(`앞단을 거친 /api/health가 ok만 주지 않습니다: ${JSON.stringify(proxied)}`);
    // 장부 API의 문: 저장소 · 도메인(@skinote/store · domain · contract)이 읽혀 API가 켜졌는지. 세션 · 명령 길이 404면 API가 꺼진 것.
    const base = `http://127.0.0.1:${port}/api/v2`;
    const session = await fetch(`${base}/session`, { headers: { 'sec-fetch-site': 'same-origin' } });
    if (session.status !== 401) throw new Error(`세션 없는 /api/v2/session이 401이 아닙니다: ${session.status}`);
    const json = { 'content-type': 'application/json' };
    const noOrigin = await fetch(`${base}/command`, { method: 'POST', headers: json, body: '{}' });
    if (noOrigin.status !== 403) throw new Error(`Origin 없는 /api/v2/command가 403이 아닙니다: ${noOrigin.status}`);
    const noSession = await fetch(`${base}/command`, { method: 'POST', headers: { ...json, origin: ORIGIN }, body: '{}' });
    if (noSession.status !== 401) throw new Error(`세션 없는 /api/v2/command가 401이 아닙니다: ${noSession.status}`);
    const backup = spawnSync(process.execPath, [...FLAGS, BACKUP], { env, encoding: 'utf8', timeout: 30_000 });
    if (backup.status !== 0) throw new Error(`백업 명령 실패(${backup.status}): ${backup.stderr || backup.stdout}`);
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const code = await exited;
    clearTimeout(timer);
    if (code !== 0) throw new Error(`SIGTERM 뒤 끝 코드 ${code}`);
    console.log(`점검 통과: ${health.release} · 데이터베이스 ${health.databases.length}개 · 장부 API(401 · 403 · 401) · 백업 · 종료`);
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGKILL');
    console.error(`점검 실패: ${error instanceof Error ? error.message : String(error)}`);
    if (output) console.error(output.trimEnd().split('\n').map(line => `  | ${line}`).join('\n'));
    process.exitCode = 1;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();

// @ts-check
// 배포 파일(deploy/): 셸 문법, 서버 유닛의 비밀값 파일 · /run/skinote(관리 소켓), Caddy 틀의 손님 주소 · 앞단 표 자리(값은 저장소에 없음),
// 설정 예시가 운영 설정(NODE_ENV=production, API 켬)으로 읽히는지, 맥 쪽 매장 명령줄 요청(deploy/shop-cli-request.mjs)이 bin/shop.js와
// 같은 깃발을 JSON 하나로 바꾸는지(명세 파일은 객체로 넣음), 서버 쪽 입구가 서버를 멈추는 명령이 bin/shop.js의 혼자 쓰는 명령과 같은지.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const DEPLOY = fileURLToPath(new URL('../../../deploy/', import.meta.url));
const read = (/** @type {string} */ name) => readFileSync(join(DEPLOY, name), 'utf8');

test('deploy scripts parse (bash -n) and --help lists the shop command line', () => {
  for (const script of ['deploy.sh', 'shop-cli.sh']) {
    const r = spawnSync('bash', ['-n', join(DEPLOY, script)], { encoding: 'utf8' });
    assert.equal(r.status, 0, script + ': ' + r.stderr);
  }
  const help = spawnSync('bash', [join(DEPLOY, 'deploy.sh'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--shop-cli <명령>/);
  assert.match(help.stdout, /--allow-no-e2e/);
  assert.doesNotMatch(help.stdout, /set -euo pipefail/);
});

test('the server-side entry stops the server for exactly the exclusive shop.js commands', async () => {
  const { EXCLUSIVE_OPS } = await import('../bin/shop.js');
  const solo = /^\s*([a-z-]+(?: \| [a-z-]+)*)\) solo=1 ;;$/m.exec(read('shop-cli.sh'))?.[1]?.split(' | ') ?? [];
  assert.deepEqual([...solo].sort(), [...EXCLUSIVE_OPS].sort());
  assert.match(read('shop-cli.sh'), /^\s*device-code \| rotate-pin \| revoke-device \| status\) solo=0 ;;$/m);
});

test('the server unit reads the secrets file and owns /run/skinote for the admin socket', () => {
  const unit = read('skinote-server.service');
  assert.match(unit, /^EnvironmentFile=\/etc\/skinote\/skinote\.env$/m);
  assert.match(unit, /^EnvironmentFile=-\/etc\/skinote\/secrets\.env$/m);
  assert.match(unit, /^RuntimeDirectory=skinote$/m);
  assert.match(unit, /^RuntimeDirectoryMode=0750$/m);
});

test('the Caddy template pins the client address and carries only a placeholder for the proxy token', () => {
  const site = read('skinote.caddy.template');
  const proxy = /reverse_proxy 127\.0\.0\.1:3100 \{([\s\S]*?)\n\t\t\}/.exec(site)?.[1] ?? '';
  assert.match(proxy, /^\t+header_up X-Forwarded-For \{remote_host\}$/m);
  assert.match(proxy, /^\t+header_up -Forwarded$/m);
  assert.match(proxy, /^\t+header_up X-Skinote-Proxy __SKINOTE_PROXY_TOKEN__$/m);
  assert.match(site, /^__SKINOTE_SITE__ \{$/m);
  // 저장소에는 표 값이 없다(자리만).
  assert.doesNotMatch(site, /X-Skinote-Proxy [A-Za-z0-9_-]{40,}/);
});

test('the settings example reads as a production config with the app address (secrets stay in secrets.env)', () => {
  /** @type {Record<string, string>} */
  const env = { NODE_ENV: 'production' };
  for (const line of read('skinote.env.example').split('\n')) {
    const m = /^(SKINOTE_[A-Z_]+)=(.*)$/.exec(line);
    if (m && m[1] && m[2] !== undefined) env[m[1]] = m[2];
  }
  assert.equal(env.SKINOTE_PUBLIC_ORIGIN, 'https://skinote.example.invalid');
  assert.equal(env.SKINOTE_API, 'on');
  for (const name of ['SKINOTE_PIN_PEPPER', 'SKINOTE_SESSION_KEY', 'SKINOTE_FINGERPRINT_KEY', 'SKINOTE_IP_KEY', 'SKINOTE_PROXY_TOKEN']) {
    assert.equal(env[name], undefined, name + ' is not in the settings example');
  }
  const config = loadConfig(env);
  assert.equal(config.api, 'on');
  assert.equal(config.port, 3100);
});

test('shop-cli-request turns the shop.js flags into one JSON request and inlines a spec file', () => {
  const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(DEPLOY, 'shop-cli-request.mjs'), ...args], { encoding: 'utf8' });
  const made = run(['provision', '--shop', 'S1', '--code', 'c-1', '--name', '시험 매장', '--sample', '--test', '--staff', '정하늘:manager', '--staff', '박기사:driver:v1']);
  assert.equal(made.status, 0, made.stderr);
  assert.deepEqual(JSON.parse(made.stdout), {
    op: 'provision',
    args: { shop: 'S1', code: 'c-1', name: '시험 매장', sample: true, test: true, staff: ['정하늘:manager', '박기사:driver:v1'] },
  });
  const dir = mkdtempSync(join(tmpdir(), 'sn-shop-cli-'));
  try {
    const specFile = join(dir, 'spec.json');
    writeFileSync(specFile, JSON.stringify({ shopName: '명세 매장' }));
    const withSpec = run(['provision', '--shop', 'S1', '--code', 'c-1', '--name', 'n', '--spec', specFile]);
    assert.equal(withSpec.status, 0, withSpec.stderr);
    assert.deepEqual(JSON.parse(withSpec.stdout).args.spec, { shopName: '명세 매장' });
    const missing = run(['provision', '--shop', 'S1', '--spec', join(dir, 'none.json')]);
    assert.equal(missing.status, 65);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(JSON.parse(run(['status', '--shop', 'S1']).stdout), { op: 'status', args: { shop: 'S1' } });
  assert.deepEqual(JSON.parse(run(['reset-test-shop', '--shop', 'S1']).stdout), { op: 'reset-test-shop', args: { shop: 'S1' } });
  assert.equal(run(['provision', '--bogus']).status, 64);
  assert.equal(run(['--stdin']).status, 64);
  assert.equal(run(['drop-shop', '--shop', 'S1']).status, 64);
});

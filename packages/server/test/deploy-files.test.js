// @ts-check
// 배포 파일(deploy/): 셸 문법, 서버 유닛의 비밀값 파일 · /run/skinote(관리 소켓), Caddy 틀의 손님 주소 · 앞단 표 자리(값은 저장소에 없음),
// 설정 예시가 운영 설정(NODE_ENV=production, API 켬)으로 읽히는지, 맥 쪽 매장 명령줄 요청(deploy/shop-cli-request.mjs)이 bin/shop.js와
// 같은 깃발을 JSON 하나로 바꾸는지(명세 파일은 객체로 넣음), 서버 쪽 입구가 서버를 멈추는 명령이 bin/shop.js의 혼자 쓰는 명령과 같은지.
// 시험 매장의 열린 기기 등록(SKINOTE_TEST_OPEN_ENROLL): 설정 예시는 off, 설치 작업 · 유닛은 그 줄을 바꾸지 않음, --set-env는 허락한 이름 ·
// 값만(ssh 전에 거절, 틀린 값은 찍지 않음), 상태 요약(HEALTH_JS)이 켜진 동안 경고 줄을 찍는지.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
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
  assert.equal(env.SKINOTE_TEST_OPEN_ENROLL, 'off', 'the example documents open enrollment as off');
  assert.equal(config.testOpenEnroll, 'off');
});

test('the install job and the units never turn open enrollment on; only --set-env changes that line', () => {
  const deploy = read('deploy.sh');
  const install = /remote_install_script\(\) \{([\s\S]*?)\nREMOTE\n\}/.exec(deploy)?.[1] ?? '';
  assert.ok(install.includes('skinote.env.example'), 'found the install script');
  // 설치 작업은 그 줄을 읽기만 한다(비밀값 파일에 있으면 · 켰는데 기한이 없으면 멈춤): 쓰는 sed · printf가 없다.
  for (const line of install.split('\n').filter(l => l.includes('SKINOTE_TEST_OPEN_ENROLL'))) {
    assert.match(line, /grep -(q|Eq) '\^SKINOTE_TEST_OPEN_ENROLL|fail "|^\s*#/, 'the install job only reads the line: ' + line.trim());
  }
  assert.match(install, /grep -q '\^SKINOTE_TEST_OPEN_ENROLL' "\$SECRETS_FILE"/, 'the install job refuses the setting in secrets.env');
  assert.match(install, /SKINOTE_TEST_OPEN_ENROLL_UNTIL=\[0-9\]\{4\}/, 'the install job refuses on without a last day');
  const secretsWriter = /if \[ ! -f "\$SECRETS_FILE" \]; then([\s\S]*?)\nfi\n/.exec(install)?.[1] ?? '';
  assert.ok(secretsWriter.includes('SECRET_NAMES'), 'found the secrets writer');
  assert.doesNotMatch(secretsWriter, /SKINOTE_TEST_OPEN_ENROLL/, 'the secrets writer never writes the setting');
  for (const unit of ['skinote-server.service', 'skinote-backup.service', 'skinote-alert@.service']) assert.doesNotMatch(read(unit), /SKINOTE_TEST_OPEN_ENROLL/, unit);
  assert.doesNotMatch(read('shop-cli.sh'), /SKINOTE_TEST_OPEN_ENROLL=on/);
  // --set-env의 서버 쪽: on은 기한을 함께 적고, off는 기한을 지우며, 비밀값 파일이 그 줄을 덮으면 멈춘다.
  const setEnv = /remote_set_env_script\(\) \{([\s\S]*?)\nREMOTE\n\}/.exec(deploy)?.[1] ?? '';
  assert.match(setEnv, /set_line SKINOTE_TEST_OPEN_ENROLL_UNTIL "\$until"/);
  assert.match(setEnv, /del_line SKINOTE_TEST_OPEN_ENROLL_UNTIL/);
  assert.match(setEnv, /DEFAULT_DAYS=7; MAX_DAYS=14/);
  assert.match(setEnv, /grep -q '\^SKINOTE_TEST_OPEN_ENROLL' "\$SECRETS_FILE"/);
  // --status는 도는 서버의 값을 기준으로 보이고 설정 파일과 다르면 한 줄을 더한다.
  const status = /remote_status_script\(\) \{([\s\S]*?)\nREMOTE\n\}/.exec(deploy)?.[1] ?? '';
  assert.match(status, /도는 서버 \$run_flag/);
  assert.match(status, /주의: 도는 서버\(\$run_flag\)와 설정 파일\(\$file_open\)이 다릅니다/);
  assert.match(status, /grep -E '\^ALERT open_enroll'/, '--status shows the open-enrollment alert lines of the last 24 hours');
});

test('--set-env takes only the allowed name and values, refuses before ssh and never echoes a refused value', () => {
  // SKINOTE_SSH를 틀린 모양으로 주어 검사를 지나도 ssh에 붙지 않게 한다(deploy/.env.local보다 환경 변수가 이긴다).
  const run = (/** @type {string[]} */ args) => spawnSync('bash', [join(DEPLOY, 'deploy.sh'), ...args], { encoding: 'utf8', env: { ...process.env, SKINOTE_SSH: 'not a host!' } });
  const secret = run(['--set-env', 'SKINOTE_PIN_PEPPER=do-not-print-me']);
  assert.equal(secret.status, 1);
  assert.match(secret.stderr, /--set-env로 바꿀 수 없는 설정입니다: SKINOTE_PIN_PEPPER/);
  assert.doesNotMatch(secret.stderr + secret.stdout, /do-not-print-me/);
  const value = run(['--set-env', 'SKINOTE_TEST_OPEN_ENROLL=yes-please']);
  assert.equal(value.status, 1);
  assert.match(value.stderr, /SKINOTE_TEST_OPEN_ENROLL은 on 또는 off/);
  assert.doesNotMatch(value.stderr, /yes-please/);
  assert.equal(run(['--set-env']).status, 1);
  assert.match(run(['--set-env', 'no-equals']).stderr, /이름=값/);
  const date = run(['--set-env', 'SKINOTE_TEST_OPEN_ENROLL_UNTIL=next-week']);
  assert.equal(date.status, 1);
  assert.match(date.stderr, /SKINOTE_TEST_OPEN_ENROLL_UNTIL은 YYYY-MM-DD/);
  for (const good of ['SKINOTE_TEST_OPEN_ENROLL=on', 'SKINOTE_TEST_OPEN_ENROLL=off', 'SKINOTE_TEST_OPEN_ENROLL_UNTIL=2026-10-03']) {
    const r = run(['--set-env', good]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SKINOTE_SSH는 ssh 별칭/, 'passes the allow list and stops only at the (bad) ssh target');
  }
  const help = spawnSync('bash', [join(DEPLOY, 'deploy.sh'), '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /--set-env <이름>=<값>/);
});

test('the health summary prints a warning line while open enrollment is on', async () => {
  const js = /^HEALTH_JS='\n([\s\S]*?)\n'$/m.exec(read('deploy.sh'))?.[1];
  assert.ok(js, 'found HEALTH_JS');
  /** @type {Record<string, unknown>} */
  let body = {};
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  const port = String(address && typeof address === 'object' ? address.port : 0);
  const summary = (/** @type {Record<string, unknown>} */ health) => {
    body = health;
    return new Promise(resolve => {
      const child = spawn(process.execPath, ['-e', js, '', port], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', b => { out += b; });
      child.on('exit', code => resolve({ code, out }));
    });
  };
  try {
    const base = { ok: true, release: 'r1', databases: [], disk: null };
    const on = /** @type {{ code: number, out: string }} */ (await summary({
      ...base, warnings: ['TEST_OPEN_ENROLL'],
      testOpenEnroll: { flag: 'on', active: true, until: '2026-10-03', daysLeft: 7, expired: false, shopId: 'S1', devices: 2, cap: 30, enrolled24h: 2, pinFailures24h: 4 },
    }));
    assert.equal(on.code, 0);
    assert.match(on.out, /주의 TEST_OPEN_ENROLL/);
    assert.match(on.out, /주의: 열린 기기 등록 켜짐\(시험 매장 S1 · 2026-10-03까지 7일 남음 · 열린 기기 2\/30대 · 24시간 새 기기 2 · 틀린 비밀번호 4\) · 실제 손님 자료 전에 끄기: deploy\/deploy\.sh --set-env SKINOTE_TEST_OPEN_ENROLL=off/);
    const idle = /** @type {{ code: number, out: string }} */ (await summary({ ...base, warnings: ['TEST_OPEN_ENROLL'], testOpenEnroll: { flag: 'on', active: false, devices: 0 } }));
    assert.match(idle.out, /설정만 켜짐/);
    const expired = /** @type {{ code: number, out: string }} */ (await summary({
      ...base, warnings: ['TEST_OPEN_ENROLL', 'TEST_OPEN_ENROLL_EXPIRED'], testOpenEnroll: { flag: 'on', active: false, until: '2026-09-20', daysLeft: -6, expired: true, devices: 0 },
    }));
    assert.match(expired.out, /열린 기기 등록 기한 지남\(2026-09-20/);
    const off = /** @type {{ code: number, out: string }} */ (await summary({ ...base, warnings: [], testOpenEnroll: { flag: 'off', active: false, devices: 0 } }));
    assert.doesNotMatch(off.out, /열린 기기 등록/);
    const cut = /** @type {{ code: number, out: string }} */ (await summary({ ...base, warnings: [], testOpenEnroll: { flag: 'off', active: false, devices: 0, cutAtStart: 3 } }));
    assert.match(cut.out, /열린 기기 등록 꺼짐: 시작할 때 스스로 붙은 시험 기기 3대를 끊음/);
    const left = /** @type {{ code: number, out: string }} */ (await summary({ ...base, warnings: ['TEST_OPEN_DEVICES_LEFT'], testOpenEnroll: { flag: 'off', active: false, devices: 2 } }));
    assert.match(left.out, /스스로 붙은 기기 2대가 남음/);
  } finally {
    server.close();
  }
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

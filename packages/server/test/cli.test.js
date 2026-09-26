// @ts-check
// 매장 명령줄(bin/shop.js, plan §5-5): 매장 만들기는 직원마다 비밀번호 하나를 표준 출력에만 찍고(표준 오류에는 비밀이 없다), 두 번째 만들기와
// 틀린 명세는 거절하고(control에 반쯤 남지 않는다), control의 epoch 기록(tenant_epochs)을 남기고, control에만 남고 멈춘 매장 만들기는
// 이어서 하고, 견본 하루 불러오기는 시험 매장에만 · 서버가 멈췄을 때만(날짜마다 한 번, 빈 번호로), --stdin JSON, 서버가 멈췄을 때의 운영
// 명령(등록 번호 · 비밀번호 새로 · 기기 끊기 · 상태), 쓰는 법 · 설정 오류의 끝 코드.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { sampleSpec } from '@skinote/domain';
import { openDatabase } from '@skinote/schema';
import { openControlStore, openShopStore, readInstance } from '@skinote/store';
import { EXIT } from '../bin/shop.js';
import { isWeakPin } from '../src/pin.js';
import { newSecretsEnv } from '../src/secrets.js';
import { startServer } from '../src/server.js';
import { cli, codeOf, device, PACKAGE_DIR, pinsOf, SHOP, STAFF, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

/** 서버를 한 번 띄워 파일을 마이그레이션하고 닫는다(명령줄은 마이그레이션하지 않는다). @param {string} name @param {Record<string, string>} [extra] */
async function migratedDir(name, extra = {}) {
  const dataDir = join(temp.dir, name);
  const env = {
    SKINOTE_DATA_DIR: dataDir, SKINOTE_SHOP_IDS: SHOP, SKINOTE_RELEASE: 'test', SKINOTE_BACKUP_RESERVE_MB: '0', SKINOTE_ADMIN_SOCKET: 'off',
    SKINOTE_PUBLIC_ORIGIN: 'https://shop.test', ...newSecretsEnv(), ...extra,
  };
  const app = await startServer(testConfig(dataDir, env), { log: () => {} });
  await app.close();
  return { dataDir, env };
}

const provisionArgs = (/** @type {string[]} */ extra = []) => ['provision', '--shop', SHOP, '--code', 'test-shop', '--name', '시험 매장', '--sample', ...STAFF.flatMap(s => ['--staff', s]), ...extra];

test('provision (a real process): one PIN per staff on stdout, nothing secret on stderr, exit 0; a second provision is refused', async () => {
  const { env } = await migratedDir('provision');
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'bin/shop.js', ...provisionArgs(['--test', '--pin-digits', '5'])], {
    cwd: PACKAGE_DIR, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines[0], '직원\t역할\t비밀번호');
  assert.equal(lines.length, 1 + STAFF.length, 'one line per staff member and nothing else');
  const pins = pinsOf(run.stdout);
  assert.deepEqual(Object.keys(pins), ['정하늘', '김카운터', '박기사']);
  for (const pin of Object.values(pins)) {
    assert.match(pin, /^\d{5}$/);
    assert.ok(!isWeakPin(pin));
    assert.ok(!run.stderr.includes(pin), 'no PIN on stderr');
  }
  assert.match(run.stderr, /시험 매장/);

  const again = await cli(provisionArgs(['--test']), env);
  assert.equal(again.code, EXIT.data);
  assert.match(again.err, /이미 만든 매장/);
  assert.equal(again.out, '');
});

test('provision records the shop epoch in control (tenant_epochs) for restores, and resumes a run that stopped after the control step', async () => {
  const { dataDir, env } = await migratedDir('epoch');
  assert.equal((await cli(provisionArgs(['--test']), env)).code, 0);
  const control = openDatabase(join(dataDir, 'db', 'control.sqlite'));
  const shopDb = openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'));
  try {
    const epoch = openControlStore(/** @type {any} */ (control)).currentEpoch(SHOP);
    assert.deepEqual(epoch, { epochNo: 1, epochId: readInstance(/** @type {any} */ (shopDb), SHOP)?.epochId, maxRevSeen: 0, revFloor: 0 });
  } finally {
    control.close();
    shopDb.close();
  }

  // control에만 매장이 생기고 매장 파일은 빈 채로 멈춘 실행(디스크 오류 · 죽임)을 흉내: control 단계만 한다.
  const half = await migratedDir('resume');
  const c2 = openDatabase(join(half.dataDir, 'db', 'control.sqlite'));
  try {
    openControlStore(/** @type {any} */ (c2)).provisionTenant({
      shopId: SHOP, code: 'test-shop', name: '시험 매장', isTest: true, staff: STAFF.map(s => ({ displayName: s.split(':')[0] ?? '', pinHash: null })),
    }, Date.now());
  } finally {
    c2.close();
  }
  const resumed = await cli(provisionArgs(['--test']), half.env);
  assert.equal(resumed.code, 0, resumed.err);
  assert.match(resumed.err, /이어서/);
  const pins = pinsOf(resumed.out);
  assert.deepEqual(Object.keys(pins), ['정하늘', '김카운터', '박기사'], 'fresh PINs for the same accounts');
  const codeOut = await cli(['device-code', '--shop', SHOP, '--kind', 'pos', '--label', '카운터 1'], half.env);
  const app = await startServer(testConfig(half.dataDir, half.env), { log: () => {} });
  try {
    const pos = device(app.port);
    assert.equal((await pos.enroll(codeOf(codeOut.out))).status, 200);
    assert.equal((await pos.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200, 'the new PIN works');
  } finally {
    await app.close();
  }
  const different = await migratedDir('resume-other');
  const c3 = openDatabase(join(different.dataDir, 'db', 'control.sqlite'));
  try {
    openControlStore(/** @type {any} */ (c3)).provisionTenant({ shopId: SHOP, code: 'test-shop', name: '시험 매장', isTest: true, staff: [{ displayName: '다른 사람', pinHash: null }] }, Date.now());
  } finally {
    c3.close();
  }
  const refused = await cli(provisionArgs(['--test']), different.env);
  assert.equal(refused.code, EXIT.data);
  assert.match(refused.err, /직원 명세가 다릅니다/);
  void openShopStore;
});

test('a bad spec is refused before anything is written; --spec reads a file; the same code twice is refused', async () => {
  const { dataDir, env } = await migratedDir('spec');
  const bad = await cli(['provision', '--shop', SHOP, '--code', 'test-shop', '--name', '시험 매장', '--sample', '--staff', '박기사:driver'], env);
  assert.equal(bad.code, EXIT.data, bad.err);
  assert.match(bad.err, /BAD_SPEC/);
  const control = openDatabase(join(dataDir, 'db', 'control.sqlite'), { readOnly: true });
  try {
    assert.equal(control.prepare('SELECT count(*) AS n FROM tenants').get()?.n, 0, 'the control file has no half-made shop');
  } finally {
    control.close();
  }
  const file = join(dataDir, 'spec.json');
  writeFileSync(file, JSON.stringify(sampleSpec()));
  const good = await cli(['provision', '--shop', SHOP, '--code', 'test-shop', '--name', '파일 매장', '--spec', file, '--staff', '정하늘:manager'], env);
  assert.equal(good.code, 0, good.err);
  assert.deepEqual(Object.keys(pinsOf(good.out)), ['정하늘']);
  const status = await cli(['status', '--shop', SHOP], env);
  assert.equal(status.code, 0, status.err);
  const body = JSON.parse(status.out);
  assert.deepEqual(body, { shopId: SHOP, provisioned: true, rev: 0, businessDate: body.businessDate, orders: 0, devices: { active: 0, revoked: 0 }, staff: 1 });
  assert.ok(!status.out.includes('정하늘'), 'status has no names');
});

test('load-sample: test shops only, never while the server runs; it puts the sample 18 teams in with free receipt numbers, and the same date twice writes nothing', async () => {
  const real = await migratedDir('real-shop');
  assert.equal((await cli(provisionArgs(), real.env)).code, 0);
  const refused = await cli(['load-sample', '--shop', SHOP, '--date', 'today'], real.env);
  assert.equal(refused.code, EXIT.data);
  assert.match(refused.err, /시험 매장/);

  const test1 = await migratedDir('test-shop');
  assert.equal((await cli(provisionArgs(['--test']), test1.env)).code, 0);
  const app = await startServer(testConfig(test1.dataDir, test1.env), { log: () => {} });
  try {
    const busy = await cli(['load-sample', '--shop', SHOP, '--date', 'today'], test1.env);
    assert.equal(busy.code, EXIT.unavailable);
    assert.match(busy.err, /서버가 이 매장 파일을 쓰는 중/);
    const provisionBusy = await cli(provisionArgs(['--test']), test1.env);
    assert.equal(provisionBusy.code, EXIT.unavailable);
  } finally {
    await app.close();
  }
  const loaded = await cli(['load-sample', '--shop', SHOP, '--date', '2026-12-27'], test1.env);
  assert.equal(loaded.code, 0, loaded.err);
  assert.match(loaded.out, /접수\t18팀\n/);
  const again = await cli(['load-sample', '--shop', SHOP, '--date', '2026-12-27'], test1.env);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /이미 넣음/);
  const other = await cli(['load-sample', '--shop', SHOP, '--date', '2026-12-28'], test1.env);
  assert.equal(other.code, 0, other.err);
  const status = await cli(['status', '--shop', SHOP], test1.env);
  assert.equal(JSON.parse(status.out).orders, 36, 'two dates side by side, ids and stock numbers never collide');
  const bad = await cli(['load-sample', '--shop', SHOP, '--date', '2026-13-45'], test1.env);
  assert.equal(bad.code, EXIT.usage);
});

test('load-sample picks the sample shape from the shop registry (numbered test shop → numbered day), and a registry that does not fit is refused with one line', async () => {
  const numbered = await migratedDir('numbered-shop');
  const file = join(numbered.dataDir, 'numbered.json');
  writeFileSync(file, JSON.stringify(sampleSpec('numbered')));
  assert.equal((await cli(['provision', '--shop', SHOP, '--code', 'test-shop', '--name', '번호 매장', '--spec', file, '--staff', '정하늘:manager', '--test'], numbered.env)).code, 0);
  const loaded = await cli(['load-sample', '--shop', SHOP, '--date', '2026-12-27'], numbered.env);
  assert.equal(loaded.code, 0, loaded.err);
  assert.match(loaded.out, /접수\t18팀\n/);

  const odd = await migratedDir('odd-shop');
  const spec = sampleSpec();
  // 스키만 번호로 세는 다른 명세: 번호 매장 모양의 견본 하루(권도 번호)가 이 목록과 맞지 않는다.
  spec.registry.products.ski = { ...spec.registry.products.ski, tracking: 'unit' };
  spec.stock.numbers = { ski: [1, 40] };
  delete spec.stock.counts.ski;
  const oddFile = join(odd.dataDir, 'odd.json');
  writeFileSync(oddFile, JSON.stringify(spec));
  const made = await cli(['provision', '--shop', SHOP, '--code', 'odd-shop', '--name', '다른 매장', '--spec', oddFile, '--staff', '정하늘:manager', '--test'], odd.env);
  assert.equal(made.code, 0, made.err);
  const refused = await cli(['load-sample', '--shop', SHOP, '--date', '2026-12-27'], odd.env);
  assert.equal(refused.code, EXIT.data);
  assert.match(refused.err, /견본 모양이 다릅니다 · reset-test-shop 먼저/);
  assert.equal(JSON.parse((await cli(['status', '--shop', SHOP], odd.env)).out).orders, 0, 'nothing was written');
});

test('--stdin JSON runs the same operations (deploy.sh --shop-cli), including an inline spec', async () => {
  const { env } = await migratedDir('stdin');
  const spec = sampleSpec();
  const made = await cli(['--stdin'], env, {
    stdin: JSON.stringify({ op: 'provision', args: { shop: SHOP, code: 'stdin-shop', name: '입력 매장', spec, staff: ['정하늘:manager', '박기사:driver:v1'], test: true } }),
  });
  assert.equal(made.code, 0, made.err);
  assert.deepEqual(Object.keys(pinsOf(made.out)), ['정하늘', '박기사']);
  const code = await cli(['--stdin'], env, { stdin: JSON.stringify({ op: 'device-code', args: { shop: SHOP, kind: 'driver_phone', label: '1호차 휴대폰', vehicle: 'v1' } }) });
  assert.equal(code.code, 0, code.err);
  assert.match(code.out, /등록 번호\t\d{4}-\d{4}-\d{4}/);
  const bad = await cli(['--stdin'], env, { stdin: '{"op":"drop"}' });
  assert.equal(bad.code, EXIT.usage);
  const notJson = await cli(['--stdin'], env, { stdin: 'provision --shop x' });
  assert.equal(notJson.code, EXIT.usage);
});

test('online-safe operations work with the server stopped: device code, new PIN, revoke, status', async () => {
  const { dataDir, env } = await migratedDir('offline-ops');
  const made = await cli(provisionArgs(['--test']), env);
  const pins = pinsOf(made.out);
  const code = await cli(['device-code', '--shop', SHOP, '--kind', 'pos', '--label', '카운터 1'], env);
  assert.equal(code.code, 0, code.err);
  assert.match(code.out, /^등록 번호\t\d{4}-\d{4}-\d{4}\n기기\t카운터 1 \(pos\)\n유효\t.+까지\n$/);
  const rotated = await cli(['rotate-pin', '--shop', SHOP, '--staff', '김카운터'], env);
  assert.equal(rotated.code, 0, rotated.err);
  const newPin = /** @type {string} */ (pinsOf(rotated.out)['김카운터']);
  assert.match(newPin, /^\d{4}$/);

  const app = await startServer(testConfig(dataDir, env), { log: () => {} });
  try {
    const a = device(app.port);
    assert.equal((await a.enroll(codeOf(code.out))).status, 200);
    if (newPin !== pins['김카운터']) assert.equal((await a.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 401, 'the old PIN no longer works');
    assert.equal((await a.login('김카운터', newPin)).status, 200);
  } finally {
    await app.close();
  }
  const revoked = await cli(['revoke-device', '--shop', SHOP, '--device', '카운터 1'], env);
  assert.equal(revoked.code, 0, revoked.err);
  assert.match(revoked.out, /기기 카운터 1 끊음 · 끝낸 세션 1개/);
  const status = JSON.parse((await cli(['status', '--shop', SHOP], env)).out);
  assert.deepEqual(status.devices, { active: 0, revoked: 1 });
  const again = await cli(['revoke-device', '--shop', SHOP, '--device', '없는 기기'], env);
  assert.equal(again.code, EXIT.data);
  const unknownStaff = await cli(['rotate-pin', '--shop', SHOP, '--staff', '모르는 사람'], env);
  assert.equal(unknownStaff.code, EXIT.data);
});

test('usage, config and file problems have their exit codes', async () => {
  const { env } = await migratedDir('usage');
  assert.equal((await cli(['drop-all'], env)).code, EXIT.usage);
  assert.equal((await cli(['status', '--shop', 'other-shop'], env)).code, EXIT.usage, 'the shop must be in SKINOTE_SHOP_IDS');
  assert.equal((await cli(['status', '--shop', SHOP, '--color', 'red'], env)).code, EXIT.usage);
  assert.equal((await cli(['provision', '--shop', SHOP, '--code', 'x1', '--name', '가'], env)).code, EXIT.usage, 'no --sample or --spec');
  assert.equal((await cli(['provision', '--shop', SHOP, '--code', 'BAD CODE', '--name', '가', '--sample'], env)).code, EXIT.usage);
  const noPepper = { ...env };
  delete noPepper.SKINOTE_PIN_PEPPER;
  const missing = await cli(provisionArgs(), noPepper);
  assert.equal(missing.code, EXIT.config);
  assert.match(missing.err, /SKINOTE_PIN_PEPPER/);
  const status = await cli(['status', '--shop', SHOP], noPepper);
  assert.equal(status.code, 0, 'status needs no PIN pepper');
  assert.equal(JSON.parse(status.out).provisioned, false);
  const noFile = await cli(['status', '--shop', 'shop-new'], { ...env, SKINOTE_SHOP_IDS: `${SHOP},shop-new` });
  assert.equal(noFile.code, EXIT.unavailable, 'a shop file the server never migrated');
  assert.match(noFile.err, /파일이 없습니다/);
});

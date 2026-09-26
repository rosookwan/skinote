// @ts-check
// 시험 매장 새로 만들기(bin/shop.js reset-test-shop): 실제 매장 · 도는 서버 · 만들지 않은 매장은 거절하고 아무것도 바꾸지 않는다. 시험
// 매장은 옛 파일의 사본(backups/resets, SHA256SUMS)을 받고 지금 견본으로 다시 만든다: 직원 계정 · 비밀번호 · 등록한 기기 · 열린 세션이
// 그대로 맞고, 새 epoch(옛 기준의 명령은 EPOCH_CHANGED), 옛 장부는 사본에만, 견본 하루(load-sample --date today)가 다시 들어간다.
// 두 번 해도 같다(epoch만 하나 더, 사본 둘). 새 명세에 차량이 없는 기사 기기는 끊고 그 세션을 끝내며, 기사는 첫 차량으로 옮긴다.
// 옛 견본 모양(번호 매장)으로 만든 시험 매장도 지금 견본으로 바뀌고 로그인이 이어진다(서버에 이미 있는 시험 매장의 경우).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { newRequestId } from '@skinote/contract';
import { sampleSpec } from '@skinote/domain';
import { openDatabase } from '@skinote/schema';
import { openControlStore, openShopStore, readInstance } from '@skinote/store';
import { EXIT } from '../bin/shop.js';
import { newSecretsEnv } from '../src/secrets.js';
import { startServer } from '../src/server.js';
import { cli, codeOf, device, deviceCode, ORIGIN, pinsOf, provisionedShop, SHOP, STAFF, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

const shopFile = (/** @type {string} */ dataDir) => join(dataDir, 'db', 'shops', SHOP + '.sqlite');
const controlFile = (/** @type {string} */ dataDir) => join(dataDir, 'db', 'control.sqlite');
const resetDir = (/** @type {string} */ dataDir) => join(dataDir, 'backups', 'resets');
const reset = (/** @type {Record<string, string>} */ env, /** @type {string[]} */ extra = []) => cli(['reset-test-shop', '--shop', SHOP, ...extra], env);

/** 파일의 직원(id · 이름 · 역할 · 차량 · 계정)과 epoch. 서버가 멈췄을 때만. @param {string} dataDir */
function shopFacts(dataDir) {
  const db = openDatabase(shopFile(dataDir));
  try {
    const store = openShopStore(/** @type {any} */ (db), SHOP, { secrets: { fingerprintKey: new Uint8Array(32) } });
    const now = Date.now();
    return { staff: store.staff(), instance: readInstance(/** @type {any} */ (db), SHOP), orders: store.state(now).orders.length, rev: store.head(now).rev, devices: store.devices.list() };
  } finally {
    db.close();
  }
}

/** control의 계정 수 · epoch 행 수. @param {string} dataDir */
function controlFacts(dataDir) {
  const db = openDatabase(controlFile(dataDir), { readOnly: true });
  try {
    const store = openControlStore(/** @type {any} */ (db));
    const count = (/** @type {string} */ table) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
    return { accounts: store.accountsOf(SHOP).map(a => ({ id: a.id, pinHash: a.pinHash })), epochs: count('tenant_epochs'), epoch: store.currentEpoch(SHOP) };
  } finally {
    db.close();
  }
}

/** 사본 폴더의 사본 이름들과 SHA256SUMS 줄들. @param {string} dataDir */
function backups(dataDir) {
  const dir = resetDir(dataDir);
  if (!existsSync(dir)) return { files: [], sums: [] };
  const files = readdirSync(dir).filter(n => n.endsWith('.sqlite')).sort();
  const sums = existsSync(join(dir, 'SHA256SUMS')) ? readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n') : [];
  return { files, sums };
}

/** 표준 출력의 '키\t값' 줄. @param {string} out @param {string} key */
const field = (out, key) => new RegExp(`^${key}\\t(.*)$`, 'm').exec(out)?.[1] ?? '';

test('refused and nothing changes: a real shop, a running server, other flags, a shop not made yet', async () => {
  // 실제 매장(--test 없음)
  const realDir = join(temp.dir, 'real');
  const env = {
    SKINOTE_DATA_DIR: realDir, SKINOTE_SHOP_IDS: SHOP, SKINOTE_RELEASE: 'test', SKINOTE_BACKUP_RESERVE_MB: '0', SKINOTE_ADMIN_SOCKET: 'off',
    SKINOTE_PUBLIC_ORIGIN: ORIGIN, ...newSecretsEnv(),
  };
  await (await startServer(testConfig(realDir, env), { log: () => {} })).close();
  const notMade = await reset(env);
  assert.equal(notMade.code, EXIT.unavailable, notMade.err);
  assert.match(notMade.err, /provision 먼저/);
  const made = await cli(['provision', '--shop', SHOP, '--code', 'real-shop', '--name', '실제 매장', '--sample', ...STAFF.flatMap(s => ['--staff', s])], env);
  assert.equal(made.code, 0, made.err);
  const before = shopFacts(realDir);
  const refused = await reset(env);
  assert.equal(refused.code, EXIT.data);
  assert.match(refused.err, /시험 매장/);
  assert.equal(refused.out, '');
  assert.deepEqual(shopFacts(realDir).instance, before.instance, 'the real shop keeps its epoch');
  assert.equal(existsSync(resetDir(realDir)), false, 'no copy was taken');

  // 시험 매장이라도 서버가 돌면 거절, 코드 · 이름 · 직원 · 비밀번호 깃발은 받지 않음
  const testDir = join(temp.dir, 'running');
  const shop = await provisionedShop(testDir);
  const app = await startServer(testConfig(testDir, shop.env), { log: () => {} });
  try {
    const busy = await reset(shop.env);
    assert.equal(busy.code, EXIT.unavailable);
    assert.match(busy.err, /서버가 이 매장 파일을 쓰는 중/);
  } finally {
    await app.close();
  }
  for (const extra of [['--staff', '정하늘:manager'], ['--code', 'other'], ['--name', '다른 이름'], ['--test'], ['--pin-digits', '6']]) {
    const bad = await reset(shop.env, extra);
    assert.equal(bad.code, EXIT.usage, extra.join(' '));
  }
  const both = await reset(shop.env, ['--sample', '--spec', join(testDir, 'x.json')]);
  assert.equal(both.code, EXIT.usage);
  assert.equal(shopFacts(testDir).instance?.epochNo, 1);
  assert.equal(existsSync(resetDir(testDir)), false);
});

test('keeps staff accounts, PINs, enrolled devices and open sessions; takes a checked copy first; the sample loads again after the reset', async () => {
  const dataDir = join(temp.dir, 'keep');
  const shop = await provisionedShop(dataDir);
  const posCode = await deviceCode(shop.env);
  const phoneCode = await deviceCode(shop.env, ['--kind', 'driver_phone', '--label', '1호차 휴대폰', '--vehicle', 'v1']);
  const pending = await deviceCode(shop.env, ['--kind', 'pos', '--label', '카운터 2']);
  const config = testConfig(dataDir, shop.env);
  let app = await startServer(config, { log: () => {} });
  const pos = device(app.port);
  const phone = device(app.port);
  /** @type {{ epoch: string, rev: number }} */
  let oldHead;
  try {
    assert.equal((await pos.enroll(posCode)).status, 200);
    assert.equal((await pos.login('김카운터', /** @type {string} */ (shop.pins['김카운터']))).status, 200);
    assert.equal((await phone.enroll(phoneCode)).status, 200);
    assert.equal((await phone.login('박기사', /** @type {string} */ (shop.pins['박기사']))).status, 200);
  } finally {
    await app.close();
  }
  const loaded = await cli(['load-sample', '--shop', SHOP, '--date', 'today'], shop.env);
  assert.equal(loaded.code, 0, loaded.err);
  const before = shopFacts(dataDir);
  const accountsBefore = controlFacts(dataDir).accounts;
  assert.ok(before.orders > 0 && before.rev > 0);
  oldHead = { epoch: /** @type {string} */ (before.instance?.epochId), rev: before.rev };

  const done = await reset(shop.env);
  assert.equal(done.code, 0, done.err);
  assert.equal(field(done.out, '시험 매장 새로 만듦'), SHOP);
  assert.equal(field(done.out, '직원'), '3명(계정 · 비밀번호 그대로)');
  assert.equal(field(done.out, '기기'), '2대 그대로 · 0대 끊음');
  assert.equal(field(done.out, '세션'), '2개 그대로 · 0개 끝냄');
  assert.match(field(done.out, 'epoch'), /^2 \(rev \d+부터, 옛 rev \d+\)$/);
  for (const pin of Object.values(shop.pins)) assert.ok(!done.out.includes(`\t${pin}\n`) && !done.err.includes(pin), 'no PIN is printed');
  assert.match(done.err, /load-sample --date today/);

  // 사본: 확인한 VACUUM INTO 사본 하나, SHA256SUMS의 sha256이 맞고 옛 접수가 모두 들어 있다.
  const copies = backups(dataDir);
  assert.equal(copies.files.length, 1);
  const copy = join(resetDir(dataDir), /** @type {string} */ (copies.files[0]));
  assert.equal(field(done.out, '백업'), copy);
  assert.match(/** @type {string} */ (copies.files[0]), new RegExp(`^${SHOP}\\.before_reset\\.v\\d{4}\\.\\d{8}T\\d{9}Z\\.sqlite$`));
  const sha = createHash('sha256').update(readFileSync(copy)).digest('hex');
  assert.equal(field(done.out, 'sha256'), sha);
  assert.deepEqual(copies.sums, [`${sha}  ${copies.files[0]}`]);
  const old = openDatabase(copy, { readOnly: true });
  try {
    assert.equal(Number(old.prepare('SELECT count(*) AS n FROM orders').get()?.n), before.orders, 'the old ledger is in the copy');
    assert.equal(old.prepare('SELECT epoch_id FROM shop_instance').get()?.epoch_id, oldHead.epoch);
  } finally {
    old.close();
  }

  // 새 파일: 같은 직원 id · 계정, 같은 기기, 옛 접수 없음, 새 epoch(2번, rev 바닥은 옛 rev + 1,000,000), 남은 임시 · 옆 파일 없음.
  const after1 = shopFacts(dataDir);
  assert.deepEqual(after1.staff, before.staff);
  assert.deepEqual(after1.devices.map(d => ({ id: d.id, shortNo: d.shortNo, status: d.status, key: d.publicKey })), before.devices.map(d => ({ id: d.id, shortNo: d.shortNo, status: d.status, key: d.publicKey })));
  assert.equal(after1.orders, 0);
  assert.equal(after1.instance?.epochNo, 2);
  assert.notEqual(after1.instance?.epochId, oldHead.epoch);
  assert.equal(after1.instance?.revFloor, before.rev + 1_000_000);
  const control = controlFacts(dataDir);
  assert.deepEqual(control.accounts, accountsBefore, 'accounts and PIN hashes are untouched');
  assert.deepEqual(control.epoch, { epochNo: 2, epochId: after1.instance?.epochId, maxRevSeen: 0, revFloor: before.rev + 1_000_000 });
  assert.deepEqual(readdirSync(join(dataDir, 'db', 'shops')).filter(n => n.startsWith('.reset-') || n.includes('.before-reset-')), []);

  app = await startServer(config, { log: () => {} });
  try {
    // 열린 세션이 그대로: 같은 쿠키로 세션 · 머리를 본다. 머리는 새 epoch.
    const same = device(app.port);
    Object.assign(same.state, { cookie: pos.state.cookie, csrf: pos.state.csrf });
    assert.equal((await same.get('/api/v2/session')).status, 200, 'the counter session survives the reset');
    const head = await (await same.get('/api/v2/head')).json();
    assert.equal(head.epoch, after1.instance?.epochId);
    const driver = device(app.port);
    Object.assign(driver.state, { cookie: phone.state.cookie, csrf: phone.state.csrf });
    assert.equal((await driver.get('/api/v2/session')).status, 200, 'the driver phone session survives the reset');
    // 옛 기준으로 보낸 명령은 적용하지 않는다(EPOCH_CHANGED).
    const stale = await (await same.command({ type: 'notification.ack', commandVersion: 1, requestId: newRequestId(), basis: oldHead, payload: { notificationId: 'pin:v1' } })).json();
    assert.equal(stale.error?.code, 'EPOCH_CHANGED');
    // 같은 기기(같은 열쇠)에서 같은 비밀번호로 다시 로그인.
    const again = device(app.port);
    Object.assign(again.state, { deviceId: pos.state.deviceId, key: pos.state.key });
    assert.equal((await again.login('김카운터', /** @type {string} */ (shop.pins['김카운터']))).status, 200, 'the same PIN on the same device');
    const phoneAgain = device(app.port);
    Object.assign(phoneAgain.state, { deviceId: phone.state.deviceId, key: phone.state.key });
    assert.equal((await phoneAgain.login('박기사', /** @type {string} */ (shop.pins['박기사']))).status, 200);
    // 아직 쓰지 않은 등록 번호도 그대로 쓴다.
    const third = device(app.port);
    assert.equal((await third.enroll(pending)).status, 200, 'an unused code made before the reset still enrolls');
  } finally {
    await app.close();
  }

  const reloaded = await cli(['load-sample', '--shop', SHOP, '--date', 'today'], shop.env);
  assert.equal(reloaded.code, 0, reloaded.err);
  assert.match(reloaded.out, /접수\t\d+팀\n/);
  assert.doesNotMatch(reloaded.out, /이미 넣음/);
  const status = JSON.parse((await cli(['status', '--shop', SHOP], shop.env)).out);
  assert.equal(status.orders, before.orders, 'the same sample day, once');
  assert.ok(status.rev > before.rev + 1_000_000, 'revs keep going up across the reset');
  assert.deepEqual(status.devices, { active: 3, revoked: 0 });
});

test('a second reset (rerun) works the same: logins kept, the epoch goes up once more, two copies, the sample loads', async () => {
  const dataDir = join(temp.dir, 'twice');
  const shop = await provisionedShop(dataDir);
  const code = await deviceCode(shop.env);
  const config = testConfig(dataDir, shop.env);
  let app = await startServer(config, { log: () => {} });
  const pos = device(app.port);
  try {
    assert.equal((await pos.enroll(code)).status, 200);
    assert.equal((await pos.login('정하늘', /** @type {string} */ (shop.pins['정하늘']))).status, 200);
  } finally {
    await app.close();
  }
  const staff = shopFacts(dataDir).staff;
  const accounts = controlFacts(dataDir).accounts;
  const first = await reset(shop.env);
  assert.equal(first.code, 0, first.err);
  const second = await reset(shop.env, ['--sample']);
  assert.equal(second.code, 0, second.err);
  assert.match(field(second.out, 'epoch'), /^3 /);
  assert.equal(field(second.out, '기기'), '1대 그대로 · 0대 끊음');
  assert.equal(field(second.out, '세션'), '1개 그대로 · 0개 끝냄');
  const facts = shopFacts(dataDir);
  assert.deepEqual(facts.staff, staff);
  assert.equal(facts.instance?.epochNo, 3);
  const control = controlFacts(dataDir);
  assert.deepEqual(control.accounts, accounts);
  assert.equal(control.epochs, 3, 'one epoch row per shop file');
  const copies = backups(dataDir);
  assert.equal(copies.files.length, 2);
  assert.equal(copies.sums.length, 2);
  for (const [i, name] of copies.files.entries()) {
    const sha = createHash('sha256').update(readFileSync(join(resetDir(dataDir), name))).digest('hex');
    assert.ok(copies.sums.includes(`${sha}  ${name}`), `SHA256SUMS lists copy ${i + 1}`);
  }
  assert.deepEqual(readdirSync(join(dataDir, 'db', 'shops')).filter(n => n !== SHOP + '.sqlite' && !n.startsWith(SHOP + '.sqlite-')), []);

  app = await startServer(config, { log: () => {} });
  try {
    const health = await (await fetch(`http://127.0.0.1:${app.port}/api/health`)).json();
    const file = health.databases.find((/** @type {{ shopId: string | null }} */ d) => d.shopId === SHOP);
    assert.deepEqual({ status: file.status, writable: file.writable, warnings: file.warnings }, { status: 'up_to_date', writable: true, warnings: [] }, 'the server opens the new file for writing');
    const same = device(app.port);
    Object.assign(same.state, { cookie: pos.state.cookie, csrf: pos.state.csrf });
    assert.equal((await same.get('/api/v2/session')).status, 200);
    const again = device(app.port);
    Object.assign(again.state, { deviceId: pos.state.deviceId, key: pos.state.key });
    assert.equal((await again.login('정하늘', /** @type {string} */ (shop.pins['정하늘']))).status, 200);
  } finally {
    await app.close();
  }
  const loaded = await cli(['load-sample', '--shop', SHOP, '--date', 'today'], shop.env);
  assert.equal(loaded.code, 0, loaded.err);
});

test('a driver device on a van the new spec lacks is cut off with its session, and says so; the driver moves to the first van', async () => {
  const dataDir = join(temp.dir, 'van');
  const env = {
    SKINOTE_DATA_DIR: dataDir, SKINOTE_SHOP_IDS: SHOP, SKINOTE_RELEASE: 'test', SKINOTE_BACKUP_RESERVE_MB: '0', SKINOTE_ADMIN_SOCKET: 'off',
    SKINOTE_PUBLIC_ORIGIN: ORIGIN, ...newSecretsEnv(),
  };
  await (await startServer(testConfig(dataDir, env), { log: () => {} })).close();
  // 옛 매장에는 3호 차량이 있다(지금 견본에는 없다).
  const spec = sampleSpec();
  spec.registry.vehicles = [...spec.registry.vehicles, { id: 'v3', label: '3호 차량' }];
  const specFile = join(dataDir, 'spec.json');
  writeFileSync(specFile, JSON.stringify(spec));
  const made = await cli(['provision', '--shop', SHOP, '--code', 'van-shop', '--name', '차량 매장', '--spec', specFile, '--test', '--staff', '정하늘:manager', '--staff', '최기사:driver:v3'], env);
  assert.equal(made.code, 0, made.err);
  const pins = pinsOf(made.out);
  const code = codeOf((await cli(['device-code', '--shop', SHOP, '--kind', 'driver_phone', '--label', '3호차 휴대폰', '--vehicle', 'v3'], env)).out);
  const config = testConfig(dataDir, env);
  let app = await startServer(config, { log: () => {} });
  const phone = device(app.port);
  try {
    assert.equal((await phone.enroll(code)).status, 200);
    assert.equal((await phone.login('최기사', /** @type {string} */ (pins['최기사']))).status, 200);
  } finally {
    await app.close();
  }

  const done = await reset(env);
  assert.equal(done.code, 0, done.err);
  assert.equal(field(done.out, '기기'), '0대 그대로 · 1대 끊음');
  assert.equal(field(done.out, '세션'), '0개 그대로 · 1개 끝냄');
  assert.match(done.err, /기사 1명의 차량이 새 명세에 없어/);
  assert.match(done.err, /기사 기기 1대를 끊었습니다/);
  const facts = shopFacts(dataDir);
  assert.deepEqual(facts.staff.map(s => ({ name: s.name, role: s.roleKey, vehicle: s.vehicleId })), [
    { name: '정하늘', role: 'manager', vehicle: undefined },
    { name: '최기사', role: 'driver', vehicle: 'v1' },
  ]);
  assert.deepEqual(facts.devices, []);

  app = await startServer(config, { log: () => {} });
  try {
    const same = device(app.port);
    Object.assign(same.state, { cookie: phone.state.cookie, csrf: phone.state.csrf });
    const session = await same.get('/api/v2/session');
    assert.equal(session.status, 401);
    assert.equal((await session.json()).code, 'DEVICE_REVOKED');
  } finally {
    await app.close();
  }
  // 다시 등록하면 1호 차량으로 로그인한다(같은 비밀번호).
  const code2 = await deviceCode(env, ['--kind', 'driver_phone', '--label', '1호차 휴대폰', '--vehicle', 'v1']);
  app = await startServer(config, { log: () => {} });
  try {
    const fresh = device(app.port);
    assert.equal((await fresh.enroll(code2)).status, 200);
    assert.equal((await fresh.login('최기사', /** @type {string} */ (pins['최기사']))).status, 200, 'the same PIN, now on van 1');
  } finally {
    await app.close();
  }
});

test('a test shop built from the old numbered sample (numbered pieces · deposit) becomes the current sample; logins stay and the sample loads', async () => {
  const dataDir = join(temp.dir, 'numbered');
  const env = {
    SKINOTE_DATA_DIR: dataDir, SKINOTE_SHOP_IDS: SHOP, SKINOTE_RELEASE: 'test', SKINOTE_BACKUP_RESERVE_MB: '0', SKINOTE_ADMIN_SOCKET: 'off',
    SKINOTE_PUBLIC_ORIGIN: ORIGIN, ...newSecretsEnv(),
  };
  await (await startServer(testConfig(dataDir, env), { log: () => {} })).close();
  // 옛 견본 모양(번호 매장)으로 만든 시험 매장: 서버에 이미 있는 시험 매장과 같은 모양.
  const specFile = join(dataDir, 'numbered.json');
  writeFileSync(specFile, JSON.stringify(/** @type {(shop: string) => unknown} */ (sampleSpec)('numbered')));
  const made = await cli(['provision', '--shop', SHOP, '--code', 'old-shop', '--name', '옛 견본 매장', '--spec', specFile, '--test', ...STAFF.flatMap(s => ['--staff', s])], env);
  assert.equal(made.code, 0, made.err);
  const pins = pinsOf(made.out);
  const code = await deviceCode(env);
  const assets = () => {
    const db = openDatabase(shopFile(dataDir), { readOnly: true });
    try {
      return Number(db.prepare('SELECT count(*) AS n FROM assets').get()?.n);
    } finally {
      db.close();
    }
  };
  assert.ok(assets() > 0, 'the old shop has numbered pieces');
  const config = testConfig(dataDir, env);
  let app = await startServer(config, { log: () => {} });
  const pos = device(app.port);
  try {
    assert.equal((await pos.enroll(code)).status, 200);
    assert.equal((await pos.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200);
  } finally {
    await app.close();
  }

  const done = await reset(env);
  assert.equal(done.code, 0, done.err);
  const current = sampleSpec();
  const numbered = Object.values(current.stock.numbers).reduce((n, [from, to]) => n + to - from + 1, 0) + current.stock.vehicleSpares.reduce((n, s) => n + s.numbers.length, 0);
  assert.equal(assets(), numbered, 'the numbered pieces are those of the current sample (none when it counts everything)');
  const loaded = await cli(['load-sample', '--shop', SHOP, '--date', 'today'], env);
  assert.equal(loaded.code, 0, loaded.err);
  app = await startServer(config, { log: () => {} });
  try {
    const same = device(app.port);
    Object.assign(same.state, { cookie: pos.state.cookie, csrf: pos.state.csrf });
    assert.equal((await same.get('/api/v2/session')).status, 200);
    const ledger = await same.query('ledgerView', { viewKey: 'day_ledger' });
    assert.equal(ledger.status, 200, 'the day ledger of the new shop reads');
  } finally {
    await app.close();
  }
});

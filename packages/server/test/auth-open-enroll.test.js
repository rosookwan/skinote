// @ts-check
// 시험 매장의 열린 기기 등록(2026-09-26 시험 중 요청 "등록번호는 좀 빼줘", 설정 SKINOTE_TEST_OPEN_ENROLL):
//   - 설정이 꺼져 있으면(기본) 시험 매장이어도 등록 방법은 번호(code)이고 열린 등록은 403 ENROLL_CLOSED.
//   - 설정이 켜져 있어도 시험 매장이 아니면 그대로 번호 등록이다(번호 등록은 늘 된다). 상태 확인에는 켜 둔 설정이 경고로 보인다.
//   - 켜져 있고 서버의 매장이 시험 매장 하나면: 등록 방법이 'open'과 차량(직원 이름 · 매장 이름 없음), 카운터가 번호 없이 `시험 기기 N`으로
//     등록되고 직원 비밀번호 로그인 · 다섯 번 잠금은 그대로다. 기사 기기는 매장의 차량이 꼭 있어야 하고 기사 타일만 본다.
//   - 주소마다 15분에 10번, 끊기지 않은 열린 기기 30대까지(409 DEVICE_LIMIT, 경보 줄), 끊은 기기는 자리를 비우고 세션이 곧 끝난다.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openDatabase } from '@skinote/schema';
import { startServer } from '../src/server.js';
import { cli, collectLog, device, deviceCode, openEnrollEnv, provisionedShop, request, SHOP, shortTempDir, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

const ON = openEnrollEnv();
const UNTIL = ON.SKINOTE_TEST_OPEN_ENROLL_UNTIL;

/** @param {string} dataDir */
const readShop = dataDir => openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'), { readOnly: true });
/** @param {string} dataDir */
const readControl = dataDir => openDatabase(join(dataDir, 'db', 'control.sqlite'), { readOnly: true });

/** 서버 안의 자세한 상태(앞단 머리 없이). @param {number} port */
const health = async port => (await request(port, '/api/health')).json();

/** @param {number} port */
const enrollMode = async port => {
  const res = await request(port, '/api/v2/device/enroll');
  return { status: res.status, body: await res.json() };
};

test('with the setting off (the default) a test shop keeps code enrollment: the mode is code and open enrollment is 403', async () => {
  const dataDir = join(temp.dir, 'off');
  const { env } = await provisionedShop(dataDir);
  const config = testConfig(dataDir, env);
  assert.equal(config.testOpenEnroll, 'off');
  const app = await startServer(config, { log: () => {} });
  try {
    assert.deepEqual(await enrollMode(app.port), { status: 200, body: { mode: 'code' } });
    const res = await device(app.port).openEnroll('pos');
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'ENROLL_CLOSED');
    const h = await health(app.port);
    assert.ok(!h.warnings.includes('TEST_OPEN_ENROLL'));
    assert.deepEqual(h.testOpenEnroll, { flag: 'off', active: false, devices: 0 });
    const shop = readShop(dataDir);
    try {
      assert.equal(shop.prepare('SELECT count(*) AS n FROM devices').get()?.n, 0);
    } finally {
      shop.close();
    }
    const control = readControl(dataDir);
    try {
      const rows = control.prepare("SELECT succeeded, reason_key FROM login_attempts WHERE method_key = 'enrollment'").all();
      assert.deepEqual(rows.map(r => [r.succeeded, r.reason_key]), [[0, 'open_closed']]);
    } finally {
      control.close();
    }
  } finally {
    await app.close();
  }
});

test('with the setting on, a shop that is not a test shop keeps code enrollment (codes still work) and the health shows the warning', async () => {
  const dataDir = join(temp.dir, 'real');
  const { env } = await provisionedShop(dataDir, ON, { test: false });
  const code = await deviceCode(env);
  const { lines, log } = collectLog();
  const app = await startServer(testConfig(dataDir, env), { log });
  try {
    assert.deepEqual(await enrollMode(app.port), { status: 200, body: { mode: 'code' } });
    const refused = await device(app.port).openEnroll('pos');
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, 'ENROLL_CLOSED');
    assert.equal((await device(app.port).enroll(code)).status, 200, 'a code still enrolls');
    const h = await health(app.port);
    assert.ok(h.warnings.includes('TEST_OPEN_ENROLL'), 'the setting shows while it is on');
    assert.deepEqual(h.testOpenEnroll, { flag: 'on', active: false, until: UNTIL, daysLeft: 7, expired: false, devices: 0 });
    assert.ok(lines.some(l => /SKINOTE_TEST_OPEN_ENROLL=on이지만 쓰지 않습니다/.test(l)));
    assert.ok(!lines.some(l => l.includes('ALERT open_enroll')));
  } finally {
    await app.close();
  }
});

test('a server with more than one shop keeps code enrollment even when its first shop is a test shop', async () => {
  const dataDir = join(temp.dir, 'two');
  const { env } = await provisionedShop(dataDir, ON);
  const app = await startServer(testConfig(dataDir, { ...env, SKINOTE_SHOP_IDS: SHOP + ',shop1other' }), { log: () => {} });
  try {
    assert.deepEqual((await enrollMode(app.port)).body, { mode: 'code' });
    assert.equal((await device(app.port).openEnroll('pos')).status, 403);
  } finally {
    await app.close();
  }
});

test('with the setting on and one test shop, a counter enrolls itself as 시험 기기 N and the staff PIN login and its lockout stay', async () => {
  const dataDir = join(temp.dir, 'counter');
  const { env, pins } = await provisionedShop(dataDir, ON);
  const { lines, log } = collectLog();
  const app = await startServer(testConfig(dataDir, env), { log, sleep: async () => {} });
  try {
    const mode = await enrollMode(app.port);
    assert.equal(mode.status, 200);
    assert.deepEqual(mode.body, { mode: 'open', vehicles: [{ id: 'v1', name: '1호 차량' }, { id: 'v2', name: '2호 차량' }] }, 'vans only: no staff or shop names');

    const a = device(app.port);
    const res = await a.openEnroll('pos');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['deviceId', 'kind', 'label']);
    assert.deepEqual({ kind: body.kind, label: body.label }, { kind: 'pos', label: '시험 기기 1' });
    assert.ok(lines.some(l => /^ALERT open_enroll shop0test pos 1번 · 열린 기기 1\/30/.test(l)), 'every open enrollment writes an alert line');

    // 번호 등록과 같은 서명 · 직원 타일 · 비밀번호 로그인.
    const list = await a.staffList();
    assert.equal(list.status, 200);
    assert.equal((await list.json()).staff.length, 3, 'a counter lists every staff member');
    const login = await a.login('김카운터', /** @type {string} */ (pins['김카운터']));
    assert.equal(login.status, 200);
    const info = await login.json();
    assert.deepEqual(info.device, { id: body.deviceId, kind: 'pos', label: '시험 기기 1' });
    assert.equal((await a.get('/api/v2/head')).status, 200);

    // 다섯 번 틀리면 이 기기에서 그 사람은 잠긴다(열린 등록이어도 그대로).
    const real = /** @type {string} */ (pins['정하늘']);
    const wrong = [...real].map(x => String((Number(x) + 1) % 10)).join('');
    const b = device(app.port);
    assert.equal((await b.openEnroll('pos')).status, 200);
    const codes = [];
    for (let i = 0; i < 5; i += 1) codes.push((await b.login('정하늘', wrong)).status);
    assert.deepEqual(codes, [401, 401, 401, 401, 423]);
    assert.equal((await b.login('정하늘', real)).status, 423, 'the right PIN waits for the lock too');

    const shop = readShop(dataDir);
    try {
      const rows = shop.prepare('SELECT short_no, kind_key, label, registered_by, public_key FROM devices ORDER BY short_no').all();
      assert.deepEqual(rows.map(r => [r.short_no, r.kind_key, r.label, r.registered_by]), [[1, 'pos', '시험 기기 1', 'system:open_enroll'], [2, 'pos', '시험 기기 2', 'system:open_enroll']]);
      assert.deepEqual(Object.keys(JSON.parse(String(rows[0]?.public_key))).sort(), ['crv', 'kty', 'x', 'y'], 'only the public part is kept');
    } finally {
      shop.close();
    }
    const h = await health(app.port);
    assert.ok(h.warnings.includes('TEST_OPEN_ENROLL'));
    assert.deepEqual(h.testOpenEnroll, {
      flag: 'on', active: true, until: UNTIL, daysLeft: 7, expired: false, devices: 2, shopId: SHOP, cap: 30, enrolled24h: 2, pinFailures24h: 5,
    });
    assert.equal(h.ok, true, 'the warning does not fail the health');
    assert.ok(lines.some(l => l.includes('주의: 열린 기기 등록 켬(SKINOTE_TEST_OPEN_ENROLL=on) · 시험 매장 shop0test')));
    for (const pin of Object.values(pins)) assert.ok(!lines.some(l => l.includes(pin)), 'no PIN in the log');
  } finally {
    await app.close();
  }
});

test('a driver device needs a van of the shop; it lists only drivers and its session rides in the chosen van', async () => {
  const dataDir = join(temp.dir, 'driver');
  const { env, pins } = await provisionedShop(dataDir, ON);
  const app = await startServer(testConfig(dataDir, env), { log: () => {} });
  try {
    const noVan = await device(app.port).openEnroll('driver_phone');
    assert.equal(noVan.status, 400);
    assert.equal((await noVan.json()).code, 'BAD_INPUT');
    const vanOnCounter = await device(app.port).openEnroll('pos', 'v1');
    assert.equal(vanOnCounter.status, 400);
    const unknownVan = await device(app.port).openEnroll('driver_tablet', 'v9');
    assert.equal(unknownVan.status, 400);
    assert.equal((await unknownVan.json()).code, 'BAD_VEHICLE');
    const bogusKind = await device(app.port).openEnroll('admin');
    assert.equal(bogusKind.status, 400);

    const phone = device(app.port);
    const res = await phone.openEnroll('driver_phone', 'v1');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deviceId: phone.state.deviceId, kind: 'driver_phone', label: '시험 기기 1', vehicleId: 'v1' });
    const list = await (await phone.staffList()).json();
    assert.deepEqual(list.staff.map((/** @type {{ name: string }} */ s) => s.name), ['박기사'], 'a driver device lists drivers only');
    const login = await phone.login('박기사', /** @type {string} */ (pins['박기사']));
    assert.equal(login.status, 200);
    assert.equal((await login.json()).device.vehicleId, 'v1');
    const ledger = await phone.query('ledgerView', { viewKey: 'day_ledger' });
    assert.equal(ledger.status, 403, 'a driver session still cannot read the day ledger');
  } finally {
    await app.close();
  }
});

test('open enrollment is limited per address and to 30 active open devices; revoking one frees a place and ends its session at once', async () => {
  const dataDir = join(temp.dir, 'limits');
  const socketDir = shortTempDir();
  try {
    const { env, pins } = await provisionedShop(dataDir, { ...ON, SKINOTE_ADMIN_SOCKET: join(socketDir.dir, 'a.sock') });
    const { lines, log } = collectLog();
    const app = await startServer(testConfig(dataDir, env), { log, sleep: async () => {} });
    try {
      // 한 주소: 15분에 10번(11번째 429).
      const statuses = [];
      for (let i = 0; i < 11; i += 1) statuses.push((await device(app.port, { forwardedFor: '203.0.113.1' }).openEnroll('pos')).status);
      assert.deepEqual(statuses, [...Array(10).fill(200), 429]);
      // 다른 주소들로 30대까지.
      for (const address of ['203.0.113.2', '203.0.113.3']) {
        for (let i = 0; i < 10; i += 1) assert.equal((await device(app.port, { forwardedFor: address }).openEnroll('pos')).status, 200);
      }
      const last = device(app.port, { forwardedFor: '203.0.113.4' });
      const full = await last.openEnroll('pos');
      assert.equal(full.status, 409);
      assert.equal((await full.json()).code, 'DEVICE_LIMIT');
      assert.equal((await device(app.port, { forwardedFor: '203.0.113.4' }).openEnroll('pos')).status, 409);
      assert.equal(lines.filter(l => l.startsWith('ALERT open_enroll_limit')).length, 1, 'one alert line an hour');
      assert.equal(lines.filter(l => l.startsWith('ALERT open_enroll ')).length, 30);
      const full30 = (await health(app.port)).testOpenEnroll;
      assert.deepEqual({ devices: full30.devices, cap: full30.cap, enrolled24h: full30.enrolled24h }, { devices: 30, cap: 30, enrolled24h: 30 });

      // 명령줄(서버가 도니 관리 소켓)로 한 대를 끊으면 자리가 하나 빈다. 새로 붙은 기기로 로그인한 뒤 그 기기도 끊으면 세션이 곧 끝난다.
      const one = device(app.port, { forwardedFor: '203.0.113.5' });
      const revokeFirst = await cli(['revoke-device', '--shop', SHOP, '--device', '시험 기기 1'], env);
      assert.equal(revokeFirst.code, 0, revokeFirst.err);
      assert.equal((await one.openEnroll('pos')).status, 200, 'a revoked open device frees a place');
      assert.equal((await one.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200);
      const label = /** @type {{ device: { label: string } }} */ (await (await one.get('/api/v2/session')).json()).device.label;
      assert.equal(label, '시험 기기 31', 'short numbers are never reused');
      const revoked = await cli(['revoke-device', '--shop', SHOP, '--device', label], env);
      assert.equal(revoked.code, 0, revoked.err);
      const after = await one.get('/api/v2/head');
      assert.equal(after.status, 401);
      assert.equal((await after.json()).code, 'DEVICE_REVOKED');
    } finally {
      await app.close();
    }
  } finally {
    socketDir.cleanup();
  }
});

/** 다시 띄운 서버(새 포트)에 같은 기기(열쇠 · 쿠키)로 붙는다. @param {ReturnType<typeof device>} old @param {number} port */
const rebind = (old, port) => {
  const next = device(port);
  Object.assign(next.state, old.state);
  return next;
};

/** 스스로 붙은 기기의 행(registered_by · 상태 · 까닭). @param {string} dataDir */
const openRows = dataDir => {
  const shop = readShop(dataDir);
  try {
    return shop.prepare("SELECT label, status_key, revoke_reason FROM devices WHERE registered_by = 'system:open_enroll' ORDER BY short_no").all()
      .map(r => [r.label, r.status_key, r.revoke_reason ?? null]);
  } finally {
    shop.close();
  }
};

test('turning the setting off cuts every self-registered device at the next start (sessions and staff tiles answer DEVICE_REVOKED); code devices stay', async () => {
  const dataDir = join(temp.dir, 'cut');
  const { env, pins } = await provisionedShop(dataDir, ON);
  const code = await deviceCode(env);
  let app = await startServer(testConfig(dataDir, env), { log: () => {}, sleep: async () => {} });
  let counter = device(app.port);
  let phone = device(app.port);
  let coded = device(app.port);
  try {
    assert.equal((await counter.openEnroll('pos')).status, 200);
    assert.equal((await counter.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200);
    assert.equal((await phone.openEnroll('driver_phone', 'v1')).status, 200);
    assert.equal((await phone.login('박기사', /** @type {string} */ (pins['박기사']))).status, 200);
    assert.equal((await coded.enroll(code)).status, 200);
    assert.equal((await coded.login('정하늘', /** @type {string} */ (pins['정하늘']))).status, 200);
  } finally {
    await app.close();
  }

  const off = { ...env, SKINOTE_TEST_OPEN_ENROLL: 'off' };
  const { lines, log } = collectLog();
  app = await startServer(testConfig(dataDir, off), { log });
  try {
    assert.ok(lines.some(l => /^ALERT open_enroll_cut shop0test · 열린 등록 꺼짐\(open_enroll_off\) · 시험 기기 2대 끊음/.test(l)), lines.join('\n'));
    assert.ok(lines.some(l => l.includes('스스로 붙은 시험 기기 2대를 끊었습니다')));
    counter = rebind(counter, app.port);
    phone = rebind(phone, app.port);
    coded = rebind(coded, app.port);
    const session = await counter.get('/api/v2/session');
    assert.equal(session.status, 401);
    assert.equal((await session.json()).code, 'DEVICE_REVOKED');
    const head = await phone.get('/api/v2/head');
    assert.equal(head.status, 401, 'the 14-day driver session ends too');
    assert.equal((await head.json()).code, 'DEVICE_REVOKED');
    const tiles = await counter.staffList();
    assert.equal(tiles.status, 401, 'no more staff tiles or PIN guesses from a self-registered device');
    assert.equal((await tiles.json()).code, 'DEVICE_REVOKED');
    assert.equal((await coded.get('/api/v2/session')).status, 200, 'a code-enrolled device keeps its session');
    assert.equal((await coded.staffList()).status, 200);
    const h = await health(app.port);
    assert.deepEqual(h.testOpenEnroll, { flag: 'off', active: false, devices: 0, cutAtStart: 2 });
    assert.ok(!h.warnings.includes('TEST_OPEN_DEVICES_LEFT'));
    assert.deepEqual(openRows(dataDir), [['시험 기기 1', 'revoked', 'open_enroll_off'], ['시험 기기 2', 'revoked', 'open_enroll_off']]);
  } finally {
    await app.close();
  }

  // 다시 켜도 끊긴 기기는 돌아오지 않는다(새로 기기 선택으로 붙는다).
  app = await startServer(testConfig(dataDir, env), { log: () => {} });
  try {
    counter = rebind(counter, app.port);
    assert.equal((await counter.staffList()).status, 401);
    assert.equal((await device(app.port).openEnroll('pos')).status, 200);
  } finally {
    await app.close();
  }
});

test('a second shop in SKINOTE_SHOP_IDS closes open enrollment and cuts the self-registered devices of the test shop', async () => {
  const dataDir = join(temp.dir, 'cut-two');
  const { env, pins } = await provisionedShop(dataDir, ON);
  let app = await startServer(testConfig(dataDir, env), { log: () => {} });
  let counter = device(app.port);
  try {
    assert.equal((await counter.openEnroll('pos')).status, 200);
    assert.equal((await counter.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200);
  } finally {
    await app.close();
  }
  app = await startServer(testConfig(dataDir, { ...env, SKINOTE_SHOP_IDS: SHOP + ',shop1other' }), { log: () => {} });
  try {
    counter = rebind(counter, app.port);
    const session = await counter.get('/api/v2/session');
    assert.equal(session.status, 401);
    assert.equal((await session.json()).code, 'DEVICE_REVOKED');
    assert.equal((await counter.staffList()).status, 401);
    assert.deepEqual(openRows(dataDir), [['시험 기기 1', 'revoked', 'open_enroll_closed']]);
  } finally {
    await app.close();
  }
});

test('open enrollment ends by itself after its last business day, and devices unused for an hour give their place back', async () => {
  const dataDir = join(temp.dir, 'expiry');
  const today = openEnrollEnv(0);
  const { env, pins } = await provisionedShop(dataDir, today);
  let clock = Date.now();
  const { lines, log } = collectLog();
  const app = await startServer(testConfig(dataDir, env), { log, now: () => new Date(clock), sleep: async () => {} });
  try {
    const unused = device(app.port);
    assert.equal((await unused.openEnroll('pos')).status, 200);
    clock += 61 * 60_000;
    const phone = device(app.port);
    assert.equal((await phone.openEnroll('driver_phone', 'v1')).status, 200);
    assert.deepEqual(openRows(dataDir), [['시험 기기 1', 'revoked', 'open_unused'], ['시험 기기 2', 'active', null]], 'an hour without a sign-in frees the place');
    assert.equal((await phone.login('박기사', /** @type {string} */ (pins['박기사']))).status, 200);
    assert.equal((await phone.get('/api/v2/head')).status, 200);
    assert.equal((await health(app.port)).testOpenEnroll.daysLeft, 0);

    clock += 2 * 24 * 60 * 60_000;
    assert.deepEqual((await enrollMode(app.port)).body, { mode: 'code' }, 'after the last day new devices need a code again');
    const head = await phone.get('/api/v2/head');
    assert.equal(head.status, 401);
    assert.equal((await head.json()).code, 'DEVICE_REVOKED');
    assert.ok(lines.some(l => l.startsWith('ALERT open_enroll_cut shop0test · 열린 등록 꺼짐(open_enroll_expired)')));
    const h = await health(app.port);
    assert.ok(h.warnings.includes('TEST_OPEN_ENROLL') && h.warnings.includes('TEST_OPEN_ENROLL_EXPIRED'));
    assert.deepEqual({ active: h.testOpenEnroll.active, expired: h.testOpenEnroll.expired, devices: h.testOpenEnroll.devices }, { active: false, expired: true, devices: 0 });
    assert.equal((await device(app.port).openEnroll('pos')).status, 403);
  } finally {
    await app.close();
  }
});

test('self-registered devices share one PIN lock: three of them lock an account after five misses in total, even after a restart; code devices are not slowed or kept BUSY', async () => {
  const dataDir = join(temp.dir, 'pool');
  const { env, pins } = await provisionedShop(dataDir, ON);
  const code = await deviceCode(env);
  /** @type {Promise<void> | null} */
  let hold = null;
  let held = 0;
  const sleep = async () => {
    if (hold) {
      held += 1;
      await hold;
    }
  };
  const { lines, log } = collectLog();
  let app = await startServer(testConfig(dataDir, env), { log, sleep });
  const real = /** @type {string} */ (pins['정하늘']);
  const wrong = [...real].map(x => String((Number(x) + 1) % 10)).join('');
  try {
    const guessers = [device(app.port), device(app.port), device(app.port)];
    for (const g of guessers) assert.equal((await g.openEnroll('pos')).status, 200);
    const coded = device(app.port);
    assert.equal((await coded.enroll(code)).status, 200);

    // 열린 기기가 한 계정의 확인을 쥔 동안에도 번호 기기의 진짜 직원은 BUSY 없이 로그인한다.
    /** @type {() => void} */
    let release = () => {};
    hold = new Promise(resolve => { release = () => resolve(undefined); });
    const slow = guessers[0].login('김카운터', '0000' === pins['김카운터'] ? '1111' : '0000');
    for (let i = 0; i < 200 && held === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(held, 1, 'the open device is inside its PIN check');
    const other = device(app.port);
    Object.assign(other.state, coded.state);
    assert.equal((await other.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200, 'no BUSY for a code device');
    hold = null;
    release();
    assert.equal((await slow).status, 401);

    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await /** @type {ReturnType<typeof device>} */ (guessers[i % 3]).login('정하늘', wrong)).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 423, 423], 'five misses over three devices lock them all');
    assert.equal((await /** @type {ReturnType<typeof device>} */ (guessers[1]).login('정하늘', real)).status, 423, 'the right PIN waits for the lock on every open device');
    const fourth = device(app.port);
    assert.equal((await fourth.openEnroll('pos')).status, 200);
    assert.equal((await fourth.login('정하늘', real)).status, 423, 'a new open device joins the same lock');
    assert.ok(lines.some(l => l.startsWith('ALERT open_enroll_pin shop0test')));
    const coded2 = device(app.port);
    Object.assign(coded2.state, coded.state);
    assert.equal((await coded2.login('정하늘', real)).status, 200, 'a code-enrolled device still logs the account in');
    assert.equal((await health(app.port)).testOpenEnroll.pinFailures24h, 6);
  } finally {
    await app.close();
  }
  app = await startServer(testConfig(dataDir, env), { log: () => {}, sleep });
  try {
    const fifth = device(app.port);
    assert.equal((await fifth.openEnroll('pos')).status, 200);
    assert.equal((await fifth.login('정하늘', real)).status, 423, 'the shared lock is rebuilt from login_attempts after a restart');
  } finally {
    await app.close();
  }
});

test('a self-registered device shows its van on the login tiles and can release itself; a driver on it keeps the van of the driver', async () => {
  const dataDir = join(temp.dir, 'release');
  const { env, pins } = await provisionedShop(dataDir, ON);
  const code = await deviceCode(env);
  const { lines, log } = collectLog();
  const app = await startServer(testConfig(dataDir, env), { log, sleep: async () => {} });
  try {
    const mode = await request(app.port, '/api/v2/device/enroll');
    assert.equal(mode.headers.get('cache-control'), 'no-store');

    const counter = device(app.port);
    assert.equal((await counter.openEnroll('pos')).status, 200);
    assert.deepEqual((await (await counter.staffList()).json()).openDevice, {});

    // 기기는 2호 차량으로 붙었지만 기사 박기사의 차량은 1호: 범위는 기사의 차량.
    const phone = device(app.port);
    assert.equal((await phone.openEnroll('driver_phone', 'v2')).status, 200);
    assert.deepEqual((await (await phone.staffList()).json()).openDevice, { vehicleName: '2호 차량' });
    assert.equal((await phone.login('박기사', /** @type {string} */ (pins['박기사']))).status, 200);
    assert.equal((await phone.query('vehicleLoad', { vehicleId: 'v1' })).status, 200, 'the driver keeps his own van');
    assert.equal((await phone.query('vehicleLoad', { vehicleId: 'v2' })).status, 403, 'the van picked on the device does not widen the scope');

    // 놓기: 기기 · 세션이 끝나고 자리가 빈다.
    const released = await phone.release();
    assert.equal(released.status, 204);
    const head = await phone.get('/api/v2/head');
    assert.equal(head.status, 401);
    assert.equal((await head.json()).code, 'DEVICE_REVOKED');
    assert.equal((await phone.staffList()).status, 401);
    assert.ok(lines.some(l => l.startsWith('열린 기기 놓음 shop0test driver_phone 2번')));
    assert.deepEqual(openRows(dataDir), [['시험 기기 1', 'active', null], ['시험 기기 2', 'revoked', 'open_release']]);

    // 번호로 붙인 기기는 놓을 수 없고, 서명이 틀리면 401.
    const coded = device(app.port);
    assert.equal((await coded.enroll(code)).status, 200);
    assert.equal((await (await coded.staffList()).json()).openDevice, undefined);
    const refused = await coded.release();
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, 'ENROLL_CLOSED');
    const body = await counter.signed();
    const forged = await counter.post('/api/v2/device/open-release', { ...body, signature: 'A'.repeat(86) });
    assert.equal(forged.status, 401);
    assert.equal((await counter.staffList()).status, 200, 'a forged release does not cut the device');
  } finally {
    await app.close();
  }
});

test('the CLI lists self-registered devices without staff names and revokes them all at once', async () => {
  const dataDir = join(temp.dir, 'cli-open');
  const { env, pins } = await provisionedShop(dataDir, ON);
  const app = await startServer(testConfig(dataDir, env), { log: () => {} });
  const a = device(app.port);
  try {
    assert.equal((await a.openEnroll('pos')).status, 200);
    assert.equal((await a.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200);
    assert.equal((await device(app.port).openEnroll('driver_tablet', 'v2')).status, 200);
  } finally {
    await app.close();
  }
  const status = await cli(['status', '--shop', SHOP], env);
  assert.equal(status.code, 0, status.err);
  const body = JSON.parse(status.out);
  assert.deepEqual(body.openDevices.map((/** @type {any} */ d) => [d.label, d.kind, d.vehicleId, d.signIns]), [['시험 기기 1', 'pos', undefined, 1], ['시험 기기 2', 'driver_tablet', 'v2', 0]]);
  assert.deepEqual(body.openDevices.map((/** @type {any} */ d) => d.agent), ['node', undefined], 'the browser of the last session tells the devices apart');
  assert.ok(!status.out.includes('김카운터'), 'no staff names');
  const both = await cli(['revoke-device', '--shop', SHOP, '--open-all', '--device', '시험 기기 1'], env);
  assert.equal(both.code, 65);
  const all = await cli(['revoke-device', '--shop', SHOP, '--open-all'], env);
  assert.equal(all.code, 0, all.err);
  assert.match(all.out, /스스로 붙은 시험 기기 2대 끊음 · 끝낸 세션 1개/);
  assert.deepEqual(openRows(dataDir).map(r => r[1]), ['revoked', 'revoked']);
  assert.equal(JSON.parse((await cli(['status', '--shop', SHOP], env)).out).openDevices, undefined);
});

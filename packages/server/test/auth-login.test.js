// @ts-check
// 직원 로그인(plan §5-3): 서명 · 비밀번호 → 쿠키 속성이 정확(__Host-, HttpOnly, Secure, SameSite=Strict, Path=/), 맨 한 번 값이나 다른
// 주소에 한 서명은 401, 한 번 값은 한 번만, 모르는 기기 404. 한 기기에서 한 사람이 5번 틀리면 그 기기에서만 10분 잠김(다른 기기는 된다),
// 계정의 10번째 실패부터 늦춤, 한 기기의 20번째 실패로 그 기기 30분 쉼, 로그인 기록(device_sign_ins), 다시 로그인하면 옛 쿠키의 세션은
// 끝난다, 기록에 비밀번호가 없다.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openDatabase } from '@skinote/schema';
import { startServer } from '../src/server.js';
import { collectLog, device, deviceCode, ORIGIN, provisionedShop, request, SHOP, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());
const MINUTE = 60_000;

/**
 * 시험 매장 + 등록 번호 n개 + 가짜 시계 · 기다림 기록으로 띄운 서버.
 * @param {string} name @param {number} codes
 */
async function setup(name, codes) {
  const dataDir = join(temp.dir, name);
  const shop = await provisionedShop(dataDir);
  const list = [];
  for (let i = 0; i < codes; i += 1) list.push(await deviceCode(shop.env, ['--kind', 'pos', '--label', `카운터 ${i + 1}`]));
  const clock = { t: Date.now() };
  /** @type {number[]} */
  const sleeps = [];
  const { lines, log } = collectLog();
  const app = await startServer(testConfig(dataDir, shop.env), {
    log, now: () => new Date(clock.t), sleep: async ms => { sleeps.push(ms); },
  });
  return { dataDir, pins: shop.pins, codes: list, clock, sleeps, lines, app };
}

/** 틀린 비밀번호(맞는 것과 다른 네 자리). @param {string} pin */
const wrongPin = pin => (pin === '0000' ? '1111' : '0000');

test('signature and PIN give a __Host- cookie with exact attributes and a SessionInfo', async () => {
  const { app, codes, pins, lines } = await setup('cookie', 1);
  try {
    const a = device(app.port);
    assert.equal((await a.enroll(/** @type {string} */ (codes[0]))).status, 200);
    const list = await a.staffList();
    assert.equal(list.status, 200);
    const tiles = await list.json();
    assert.equal(tiles.shopName, '시험 매장');
    assert.deepEqual(tiles.staff.map((/** @type {{ name: string }} */ s) => s.name), ['정하늘', '김카운터', '박기사']);
    assert.match(tiles.ticket, /^[A-Za-z0-9_-]{43}$/);

    const res = await a.post('/api/v2/login', { ticket: tiles.ticket, staffId: tiles.staff[1].id, pin: pins['김카운터'] });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^__Host-sn_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
    assert.ok(maxAge >= 12 * 3600 && maxAge <= 36 * 3600, 'a counter session lasts until the next cutoff at least 12 h away');
    const info = await res.json();
    assert.deepEqual(Object.keys(info).sort(), ['csrf', 'device', 'idleTimeoutS', 'serverTime', 'shop', 'staff']);
    assert.deepEqual(info.staff.name, '김카운터');
    assert.equal(info.staff.roleKey, 'counter');
    assert.equal(info.device.kind, 'pos');
    assert.equal(info.idleTimeoutS, 480 * 60);
    assert.ok(!lines.some(l => new RegExp('\\b' + pins['김카운터'] + '\\b').test(l)), 'no PIN in the log');
    // 같은 표로 다시 로그인할 수 없다(표는 한 번)
    const reuse = await a.post('/api/v2/login', { ticket: tiles.ticket, staffId: tiles.staff[1].id, pin: pins['김카운터'] });
    assert.equal(reuse.status, 401);
    assert.equal((await reuse.json()).code, 'BAD_TICKET');
  } finally {
    await app.close();
  }
});

test('the signature must cover the context, the origin, the device and a fresh nonce', async () => {
  const { app, codes } = await setup('signature', 1);
  try {
    const a = device(app.port);
    await a.enroll(/** @type {string} */ (codes[0]));
    const key = /** @type {NonNullable<typeof a.state.key>} */ (a.state.key);
    const deviceId = a.state.deviceId;
    /** @param {(nonce: string) => string} message */
    const attempt = async message => {
      const { nonce } = await (await a.post('/api/v2/device/challenge', { deviceId })).json();
      const res = await a.post('/api/v2/login/staff', { deviceId, nonce, signature: await key.sign(message(nonce)) });
      return { status: res.status, code: (await res.json()).code, nonce };
    };
    assert.deepEqual((await attempt(nonce => nonce)).status, 401, 'a signature over the bare nonce');
    assert.deepEqual((await attempt(nonce => `skinote-login-v1|https://evil.test|${deviceId}|${nonce}`)).code, 'BAD_SIGNATURE', 'another origin');
    assert.deepEqual((await attempt(nonce => `skinote-login-v1|${ORIGIN}|01K62M1QG0000000000000000A|${nonce}`)).code, 'BAD_SIGNATURE', 'another device');
    const good = await attempt(nonce => `skinote-login-v1|${ORIGIN}|${deviceId}|${nonce}`);
    assert.equal(good.status, 200);
    const replay = await a.post('/api/v2/login/staff', { deviceId, nonce: good.nonce, signature: await key.sign(`skinote-login-v1|${ORIGIN}|${deviceId}|${good.nonce}`) });
    assert.equal(replay.status, 401, 'a nonce is used once');

    const stranger = '01K62M1QG0000000000000000Q';
    const { nonce } = await (await a.post('/api/v2/device/challenge', { deviceId: stranger })).json();
    const unknown = await a.post('/api/v2/login/staff', { deviceId: stranger, nonce, signature: await key.sign(`skinote-login-v1|${ORIGIN}|${stranger}|${nonce}`) });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, 'DEVICE_UNKNOWN');
  } finally {
    await app.close();
  }
});

test('five wrong PINs lock that person on that device for 10 minutes only; another device still logs in', async () => {
  const { app, codes, pins, clock, dataDir } = await setup('lock', 2);
  try {
    const a = device(app.port);
    const b = device(app.port);
    await a.enroll(/** @type {string} */ (codes[0]));
    await b.enroll(/** @type {string} */ (codes[1]));
    const pin = /** @type {string} */ (pins['정하늘']);
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await a.login('정하늘', wrongPin(pin));
      results.push([res.status, (await res.json()).code]);
      clock.t += 1_000;
    }
    assert.deepEqual(results, [[401, 'BAD_PIN'], [401, 'BAD_PIN'], [401, 'BAD_PIN'], [401, 'BAD_PIN'], [423, 'LOCKED']]);
    const locked = await a.login('정하늘', pin);
    assert.equal(locked.status, 423, 'even the right PIN waits');
    const body = await locked.json();
    assert.equal(body.code, 'LOCKED');
    const until = Date.parse(body.lockedUntil);
    assert.ok(until - clock.t > 9 * MINUTE && until - clock.t <= 10 * MINUTE);

    assert.equal((await b.login('정하늘', pin)).status, 200, 'the same person on another device');
    assert.equal((await a.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200, 'another person on the locked device');

    clock.t += 9 * MINUTE;
    assert.equal((await a.login('정하늘', pin)).status, 423);
    clock.t += MINUTE;
    assert.equal((await a.login('정하늘', pin)).status, 200, 'after 10 minutes');

    const shop = openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'), { readOnly: true });
    try {
      const signIns = shop.prepare('SELECT device_id, seq, method_key, session_id FROM device_sign_ins ORDER BY device_id, seq').all();
      assert.equal(signIns.length, 3);
      assert.ok(signIns.every(r => r.method_key === 'pin' && typeof r.session_id === 'string'));
      assert.deepEqual(signIns.filter(r => r.device_id === a.state.deviceId).map(r => r.seq), [1, 2]);
    } finally {
      shop.close();
    }
  } finally {
    await app.close();
  }
});

test('from the 10th failure in an hour each further check of that account waits 1 s, 2 s … (never a lock across devices)', async () => {
  const { app, codes, pins, sleeps, clock } = await setup('backoff', 3);
  try {
    const devices = [device(app.port), device(app.port), device(app.port)];
    for (const [i, d] of devices.entries()) await d.enroll(/** @type {string} */ (codes[i]));
    const pin = /** @type {string} */ (pins['정하늘']);
    for (const d of devices.slice(0, 2)) {
      for (let i = 0; i < 5; i += 1) {
        await d.login('정하늘', wrongPin(pin));
        clock.t += 1_000;
      }
    }
    const floor = sleeps.filter(ms => ms >= 1_000);
    assert.deepEqual(floor, [], 'no back-off before the 10th failure');
    sleeps.length = 0;
    const third = /** @type {ReturnType<typeof device>} */ (devices[2]);
    await third.login('정하늘', wrongPin(pin));
    await third.login('정하늘', wrongPin(pin));
    assert.deepEqual(sleeps.filter(ms => ms >= 1_000), [1_000, 2_000]);
    sleeps.length = 0;
    const ok = await third.login('정하늘', pin);
    assert.equal(ok.status, 200, 'the right PIN still works after the wait');
    assert.deepEqual(sleeps, [4_000], 'after 12 failures the next check waits 2^2 s');
  } finally {
    await app.close();
  }
});

test('20 failures in an hour pause PIN login on that device for 30 minutes; a failure takes at least 300 ms', async () => {
  const { app, codes, pins, clock, sleeps } = await setup('pause', 1);
  try {
    const a = device(app.port);
    await a.enroll(/** @type {string} */ (codes[0]));
    const people = ['정하늘', '김카운터', '박기사'];
    let n = 0;
    for (const name of people) {
      for (let i = 0; i < 5; i += 1) {
        await a.login(name, wrongPin(/** @type {string} */ (pins[name])));
        n += 1;
        clock.t += 1_000;
      }
    }
    assert.equal(n, 15);
    assert.ok(sleeps.some(ms => ms > 0 && ms <= 300), 'a failure is padded to 300 ms');
    clock.t += 11 * MINUTE; // (계정, 기기) 잠금은 풀렸다
    for (let i = 0; i < 4; i += 1) {
      const res = await a.login('정하늘', wrongPin(/** @type {string} */ (pins['정하늘'])));
      assert.equal(res.status, 401);
      clock.t += 1_000;
    }
    const twentieth = await a.login('김카운터', wrongPin(/** @type {string} */ (pins['김카운터'])));
    assert.equal(twentieth.status, 423, 'the 20th failure on this device');
    const paused = await a.login('박기사', /** @type {string} */ (pins['박기사']));
    assert.equal(paused.status, 423, 'the whole device waits');
    const until = Date.parse((await paused.json()).lockedUntil);
    assert.ok(until - clock.t > 29 * MINUTE);
    clock.t += 31 * MINUTE;
    assert.equal((await a.login('박기사', /** @type {string} */ (pins['박기사']))).status, 200);
  } finally {
    await app.close();
  }
});

test('a real failure takes at least 300 ms (no injected sleep)', async () => {
  const dataDir = join(temp.dir, 'floor');
  const shop = await provisionedShop(dataDir);
  const code = await deviceCode(shop.env);
  const app = await startServer(testConfig(dataDir, shop.env), { log: () => {} });
  try {
    const a = device(app.port);
    await a.enroll(code);
    const list = await (await a.staffList()).json();
    const started = performance.now();
    const res = await a.post('/api/v2/login', { ticket: list.ticket, staffId: list.staff[0].id, pin: wrongPin(/** @type {string} */ (shop.pins['정하늘'])) });
    assert.equal(res.status, 401);
    assert.ok(performance.now() - started >= 295);
  } finally {
    await app.close();
  }
});

test('a new login revokes the session in the presented cookie; unknown staff is 400', async () => {
  const { app, codes, pins } = await setup('relogin', 1);
  try {
    const a = device(app.port);
    await a.enroll(/** @type {string} */ (codes[0]));
    assert.equal((await a.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200);
    const oldCookie = a.state.cookie;
    assert.equal((await a.login('정하늘', /** @type {string} */ (pins['정하늘']))).status, 200);
    assert.notEqual(a.state.cookie, oldCookie);
    const stale = await request(app.port, '/api/v2/session', { headers: { cookie: oldCookie, origin: ORIGIN } });
    assert.equal(stale.status, 401);
    assert.deepEqual(await stale.json(), { ok: false, service: 'skinote', code: 'SIGNED_OUT', state: 'signed_out' });
    assert.match(stale.headers.get('set-cookie') ?? '', /__Host-sn_session=; .*Max-Age=0/, 'the stale cookie is cleared');
    const now = await (await a.get('/api/v2/session')).json();
    assert.equal(now.staff.name, '정하늘');

    const list = await (await a.staffList()).json();
    const unknown = await a.post('/api/v2/login', { ticket: list.ticket, staffId: '01K62M1QG0000000000000000Z', pin: '1234' });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).code, 'UNKNOWN_STAFF');
  } finally {
    await app.close();
  }
});

test('parallel PIN guesses: one check at a time per account and device — the burst gets 429 BUSY and the right PIN inside it does not get in', async () => {
  const { app, codes, pins } = await setup('race', 1);
  try {
    const a = device(app.port);
    assert.equal((await a.enroll(/** @type {string} */ (codes[0]))).status, 200);
    const tiles = await (await a.staffList()).json();
    const staffId = tiles.staff.find((/** @type {{ name: string }} */ s) => s.name === '정하늘').id;
    const right = /** @type {string} */ (pins['정하늘']);
    const burst = [...Array(20).fill(wrongPin(right)).slice(0, 10), right, ...Array(10).fill(wrongPin(right))];
    const answers = await Promise.all(burst.map(async pin => {
      const res = await a.post('/api/v2/login', { ticket: tiles.ticket, staffId, pin });
      return { status: res.status, body: await res.json().catch(() => null) };
    }));
    const counts = answers.reduce((m, x) => ({ ...m, [x.status]: (m[x.status] ?? 0) + 1 }), /** @type {Record<number, number>} */ ({}));
    assert.equal(counts[200] ?? 0, 0, 'no session from inside a guessing burst: ' + JSON.stringify(counts));
    assert.ok((counts[429] ?? 0) >= 1, 'concurrent tries wait their turn (BUSY): ' + JSON.stringify(counts));
    assert.ok(answers.filter(x => x.status === 429).every(x => x.body?.code === 'BUSY'));
    const checked = answers.filter(x => x.status !== 429).length;
    assert.ok(checked <= 5, 'at most the lock limit of PINs were compared: ' + checked);
  } finally {
    await app.close();
  }
});

test('driver devices list and accept driver staff only: a stolen driver phone cannot aim at the manager', async () => {
  const dataDir = join(temp.dir, 'driver-tiles');
  const shop = await provisionedShop(dataDir);
  const tabletCode = await deviceCode(shop.env, ['--kind', 'driver_tablet', '--label', '1호차 태블릿', '--vehicle', 'v1']);
  const posCode = await deviceCode(shop.env, ['--kind', 'pos', '--label', '카운터 1']);
  const app = await startServer(testConfig(dataDir, shop.env), { log: () => {} });
  try {
    const tablet = device(app.port);
    const pos = device(app.port);
    await tablet.enroll(/** @type {string} */ (tabletCode));
    await pos.enroll(/** @type {string} */ (posCode));
    const tiles = await (await tablet.staffList()).json();
    assert.deepEqual(tiles.staff.map((/** @type {{ name: string }} */ s) => s.name), ['박기사']);
    const managerId = (await (await pos.staffList()).json()).staff.find((/** @type {{ name: string }} */ s) => s.name === '정하늘').id;
    const res = await tablet.post('/api/v2/login', { ticket: tiles.ticket, staffId: managerId, pin: shop.pins['정하늘'] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'UNKNOWN_STAFF');
    assert.equal((await tablet.login('박기사', /** @type {string} */ (shop.pins['박기사']))).status, 200);
  } finally {
    await app.close();
  }
});

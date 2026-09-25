// @ts-check
// 세션(plan §5-3): 쉬는 시간이 지나거나(카운터 480분) 끝 시각(07:00 로그인 → 다음 날 06:00)이 지나면 401 SESSION_EXPIRED와 쿠키 지움,
// 기사 기기 세션은 14일, 로그아웃 뒤 401, 다른 매장의 세션은 이 매장을 읽지 못함(매장은 세션에서 온다), 끊은 기기의 세션은 다음 요청에서
// 401 DEVICE_REVOKED, 쿠키 없는 세션 보기는 401 signed_out.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { kstAt } from '@skinote/domain';
import { startServer } from '../src/server.js';
import { cli, codeOf, device, deviceCode, pinsOf, provisionedShop, SHOP, STAFF, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** @param {string} name @param {number} start @param {string[]} [codeArgs] */
async function setup(name, start, codeArgs) {
  const dataDir = join(temp.dir, name);
  const shop = await provisionedShop(dataDir);
  const clock = { t: start };
  const code = await deviceCode(shop.env, codeArgs, () => clock.t);
  const app = await startServer(testConfig(dataDir, shop.env), { log: () => {}, now: () => new Date(clock.t), sleep: async () => {} });
  const a = device(app.port);
  const enrolled = await a.enroll(code);
  if (enrolled.status !== 200) {
    await app.close();
    assert.fail('enroll ' + enrolled.status);
  }
  return { app, a, clock, pins: shop.pins, env: shop.env };
}

test('a counter session ends after 480 idle minutes (401 SESSION_EXPIRED, cookie cleared)', async () => {
  const { app, a, clock, pins } = await setup('idle', kstAt('2026-12-26', 0, 9, 0));
  try {
    assert.equal((await a.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200);
    clock.t += 479 * MINUTE;
    assert.equal((await a.get('/api/v2/head')).status, 200, 'one minute before the idle limit');
    clock.t += 480 * MINUTE + MINUTE;
    const res = await a.get('/api/v2/head');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'SESSION_EXPIRED');
    assert.match(res.headers.get('set-cookie') ?? '', /Max-Age=0/);
  } finally {
    await app.close();
  }
});

test('a counter session that logged in at 07:00 ends at the next day\'s 06:00 cutoff even when used', async () => {
  const { app, a, clock, pins } = await setup('absolute', kstAt('2026-12-26', 0, 7, 0));
  try {
    const login = await a.login('김카운터', /** @type {string} */ (pins['김카운터']));
    assert.equal(login.status, 200);
    const maxAge = Number(/Max-Age=(\d+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]);
    assert.equal(maxAge, 23 * 3600, '07:00 → 06:00 the next day');
    for (const step of [7 * HOUR, 7 * HOUR, 7 * HOUR, 2 * HOUR - MINUTE]) {
      clock.t += step;
      // 사람이 한 요청(조회)이 마지막 사용 시각을 옮긴다(머리 묻기는 옮기지 않는다: 아래 시험).
      assert.equal((await a.query('config', {})).status, 200);
    }
    clock.t += MINUTE;
    const res = await a.get('/api/v2/head');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'SESSION_EXPIRED');
  } finally {
    await app.close();
  }
});

test('background polls (GET head · the stream heartbeat) do not keep an unattended counter signed in: the idle limit still ends it', async () => {
  const { app, a, clock, pins } = await setup('idle-polls', kstAt('2026-12-26', 0, 7, 0));
  try {
    assert.equal((await a.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200);
    // 8시간(480분) 동안 30초마다 머리를 묻는 화면을 흉내(10분마다 한 번씩 본다).
    let last = 200;
    for (let t = 0; t < 8 * HOUR - 10 * MINUTE; t += 10 * MINUTE) {
      clock.t += 10 * MINUTE;
      last = (await a.get('/api/v2/head')).status;
      assert.equal(last, 200, 'still inside the idle limit at +' + (t + 10 * MINUTE) / MINUTE + ' min');
    }
    clock.t += 20 * MINUTE;
    const res = await a.get('/api/v2/head');
    assert.equal(res.status, 401, 'the polls did not count as use');
    assert.equal((await res.json()).code, 'SESSION_EXPIRED');
  } finally {
    await app.close();
  }
});

test('a login at 05:50 lasts until 06:00 the day after (the first cutoff at least 12 h away)', async () => {
  const { app, a, pins } = await setup('early', kstAt('2026-12-27', 0, 5, 50));
  try {
    const login = await a.login('김카운터', /** @type {string} */ (pins['김카운터']));
    const maxAge = Number(/Max-Age=(\d+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]);
    assert.equal(maxAge, 24 * 3600 + 10 * 60);
  } finally {
    await app.close();
  }
});

test('a driver device session lasts 14 days and idles for 14 days', async () => {
  const { app, a, clock, pins } = await setup('driver', kstAt('2026-12-26', 0, 9, 0), ['--kind', 'driver_phone', '--label', '1호차 휴대폰', '--vehicle', 'v1']);
  try {
    const login = await a.login('박기사', /** @type {string} */ (pins['박기사']));
    assert.equal(login.status, 200);
    const info = await login.json();
    assert.equal(info.idleTimeoutS, 20160 * 60);
    assert.equal(info.device.kind, 'driver_phone');
    assert.equal(info.device.vehicleId, 'v1');
    assert.equal(Number(/Max-Age=(\d+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]), 14 * 24 * 3600);
    clock.t += 13 * 24 * HOUR;
    assert.equal((await a.get('/api/v2/head')).status, 200);
    clock.t += 24 * HOUR;
    assert.equal((await a.get('/api/v2/head')).status, 401);
  } finally {
    await app.close();
  }
});

test('logout needs CSRF, ends the session, and the cookie no longer works', async () => {
  const { app, a, pins } = await setup('logout', Date.now());
  try {
    await a.login('김카운터', /** @type {string} */ (pins['김카운터']));
    const cookie = a.state.cookie;
    const noCsrf = await a.post('/api/v2/logout', {}, { csrf: false });
    assert.equal(noCsrf.status, 403);
    const out = await a.post('/api/v2/logout', null, { raw: '' });
    assert.equal(out.status, 204);
    assert.match(out.headers.get('set-cookie') ?? '', /__Host-sn_session=; .*Max-Age=0/);
    const after = await a.get('/api/v2/session', { cookie });
    assert.equal(after.status, 401);
    assert.deepEqual(await after.json(), { ok: false, service: 'skinote', code: 'SIGNED_OUT', state: 'signed_out' });
    const none = await device(app.port).get('/api/v2/session');
    assert.equal(none.status, 401);
    assert.equal((await none.json()).state, 'signed_out');
  } finally {
    await app.close();
  }
});

test('a revoked device gets 401 DEVICE_REVOKED on its next request and its sessions end', async () => {
  const { app, a, pins } = await setup('revoked', Date.now());
  try {
    await a.login('김카운터', /** @type {string} */ (pins['김카운터']));
    assert.equal((await a.query('config')).status, 200);
    const auth = /** @type {NonNullable<typeof app.auth>} */ (app.auth);
    const result = auth.revokeDevice(SHOP, a.state.deviceId, 'test', Date.now());
    assert.equal(result.revoked, true);
    assert.equal(result.sessions, 1);
    const res = await a.query('config');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'DEVICE_REVOKED');
    const again = await a.staffList();
    assert.equal(again.status, 401, 'a revoked device cannot list staff');
  } finally {
    await app.close();
  }
});

test('the shop comes from the session: two shops on one server never see each other', async () => {
  const dataDir = join(temp.dir, 'two-shops');
  const shops = { a: 'shop0test', b: 'shop1test' };
  const first = await provisionedShop(dataDir, { SKINOTE_SHOP_IDS: `${shops.a},${shops.b}` });
  const env = first.env;
  const made = await cli(['provision', '--shop', shops.b, '--code', 'other-shop', '--name', '다른 매장', '--sample', '--test', ...STAFF.flatMap(s => ['--staff', s])], env);
  assert.equal(made.code, 0, made.err);
  const pinsB = pinsOf(made.out);
  const codeA = await deviceCode(env);
  const codeB = codeOf((await cli(['device-code', '--shop', shops.b, '--kind', 'pos', '--label', '카운터 1'], env)).out);
  const app = await startServer(testConfig(dataDir, env), { log: () => {} });
  try {
    const a = device(app.port);
    const b = device(app.port);
    await a.enroll(codeA);
    await b.enroll(codeB);
    assert.equal((await a.login('김카운터', /** @type {string} */ (first.pins['김카운터']))).status, 200);
    assert.equal((await b.login('김카운터', /** @type {string} */ (pinsB['김카운터']))).status, 200);
    const [headA, headB] = [await (await a.get('/api/v2/head')).json(), await (await b.get('/api/v2/head')).json()];
    assert.notEqual(headA.epoch, headB.epoch);
    assert.equal((await (await a.query('config')).json()).shopName, '시험 매장');
    assert.equal((await (await b.query('config')).json()).shopName, '다른 매장');
    // 다른 매장의 쿠키에 이 매장의 CSRF를 붙여도 이 매장으로 가지 않는다(세션마다 CSRF가 다르다)
    const mixed = await b.post('/api/v2/query', { name: 'config' }, { headers: { 'x-skinote-csrf': a.state.csrf } });
    assert.equal(mixed.status, 403);
    // A 매장의 기기로 B 매장의 직원 id를 보내도 로그인되지 않는다
    const listA = await (await a.staffList()).json();
    const listB = await (await b.staffList()).json();
    const cross = await a.post('/api/v2/login', { ticket: listA.ticket, staffId: listB.staff[1].id, pin: pinsB['김카운터'] });
    assert.equal(cross.status, 400);
  } finally {
    await app.close();
  }
});

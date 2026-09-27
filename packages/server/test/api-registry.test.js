// @ts-check
// 매장 설정의 목록 바꿈 · 직원 바꿈과 그 길(features-1 plan §4-3 · §4-6): registry.update는 settings.manage(값을 바꾸면 price_list.publish도),
// staff.set은 staff.manage — 카운터는 FORBIDDEN, 기사 기기는 FORBIDDEN_SCOPE. 저장하면 config_rev가 올라 머리(head)가 알린다. 읽기 모델은 보는
// 사람의 권한을 알아 카운터에게 `권한 없음 · 관리자 확인 필요`를 보인다. 비밀번호 재발급은 명령이 아닌 길(요청한 관리자의 비밀번호를 먼저 본다,
// 새 비밀번호는 한 번만 · no-store · 기록 줄에 없음 · 사용 내역 한 줄), 기기 막기는 device.manage. 사용 종료한 직원의 세션은 끝나고, 차량을
// 맡은 카운터는 기사 기기에 타일로 나와 그 차량의 목록을 본다(임시 차량, E13b).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDatabase } from '@skinote/schema';
import { after, before, describe, test } from 'node:test';
import { newRequestId } from '@skinote/contract';
import { startServer } from '../src/server.js';
import { collectLog, device, deviceCode, provisionedShop, SHOP, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

/** @param {Record<string, any>} basis @param {string} type @param {unknown} payload @param {Record<string, unknown>} [extra] */
const envelope = (basis, type, payload, extra = {}) => ({ type, commandVersion: 1, requestId: newRequestId(), basis: { epoch: basis.epoch, rev: basis.rev }, payload, ...extra });

describe('settings on the real shop file', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let app;
  /** @type {ReturnType<typeof device>} */ let manager;
  /** @type {ReturnType<typeof device>} */ let counter;
  /** @type {ReturnType<typeof device>} */ let driver;
  /** @type {Record<string, string>} */ let pins;
  /** @type {Record<string, string>} */ const spare = {};
  const logs = collectLog();
  let dataDir = '';

  before(async () => {
    dataDir = join(temp.dir, 'settings');
    const shop = await provisionedShop(dataDir);
    pins = shop.pins;
    const codes = [
      await deviceCode(shop.env), await deviceCode(shop.env, ['--kind', 'pos', '--label', '카운터 2']),
      await deviceCode(shop.env, ['--kind', 'driver_phone', '--label', '1호차 휴대폰', '--vehicle', 'v1']),
    ];
    // 서버가 도는 동안은 관리 소켓이 없어 등록 번호를 만들 수 없다: 뒤 시험의 기기 번호를 미리 만든다.
    spare.temp = await deviceCode(shop.env, ['--kind', 'driver_phone', '--label', '임시 휴대폰', '--vehicle', 'v2']);
    spare.phone2 = await deviceCode(shop.env, ['--kind', 'driver_phone', '--label', '1호차 휴대폰 2', '--vehicle', 'v1']);
    spare.pos4 = await deviceCode(shop.env, ['--kind', 'pos', '--label', '카운터 4']);
    spare.block = await deviceCode(shop.env, ['--kind', 'driver_phone', '--label', '막을 휴대폰', '--vehicle', 'v1']);
    app = await startServer(testConfig(dataDir, shop.env), { log: logs.log });
    manager = device(app.port);
    counter = device(app.port);
    driver = device(app.port);
    for (const [d, code, name] of /** @type {const} */ ([[manager, codes[0], '정하늘'], [counter, codes[1], '김카운터'], [driver, codes[2], '박기사']])) {
      assert.equal((await d.enroll(/** @type {string} */ (code))).status, 200);
      assert.equal((await d.login(name, /** @type {string} */ (pins[name]))).status, 200, name);
    }
  });
  after(async () => { await app?.close(); });

  const head = async () => (await manager.get('/api/v2/head')).json();
  /** @param {ReturnType<typeof device>} d @param {string} type @param {unknown} payload @param {Record<string, unknown>} [extra] */
  const send = async (d, type, payload, extra) => (await d.command(envelope(await head(), type, payload, extra))).json();
  /** 매장 파일의 직원 id(이름으로). @param {string} name */
  const staffId = async name => {
    const view = await (await manager.query('shopSettings', { tab: 'fleet' })).json();
    const item = view.cards[1].list.items.find((/** @type {{ label: string }} */ i) => i.label === name);
    return /** @type {string} */ (item.key.slice('staff:'.length));
  };

  test('registry.update: counter FORBIDDEN, a driver device refused, manager applies and config_rev rises; prices need price_list.publish', async () => {
    const change = { changes: [{ op: 'area.add', ref: 'n1', label: '설천 입구' }] };
    const fromCounter = await send(counter, 'registry.update', change);
    assert.equal(fromCounter.outcome, 'rejected');
    assert.equal(fromCounter.error.code, 'FORBIDDEN');
    assert.equal(fromCounter.error.message, '권한 없음 · 관리자 확인 필요');
    const fromDriver = await send(driver, 'registry.update', change);
    assert.equal(fromDriver.outcome, 'rejected', 'a driver device session has the driver role permissions');
    const before = await head();
    const applied = await send(manager, 'registry.update', { changes: [...change.changes, { op: 'price.set', productKey: 'ski', amount: 45_000 }] });
    assert.equal(applied.outcome, 'applied', JSON.stringify(applied.error ?? null));
    const after = await head();
    assert.equal(after.configRev, before.configRev + 1, 'one config_rev for the save');
    const places = await (await manager.query('shopSettings', { tab: 'places' })).json();
    assert.ok(places.cards.some((/** @type {{ title: string }} */ c) => c.title === '설천 입구'));
    const pricing = await (await manager.query('shopSettings', { tab: 'pricing' })).json();
    assert.equal(pricing.cards[0].list.items[0].tag, '1일 45,000원');
    // 새 접수(카운터)의 반납 장소 고르기에는 장소가 없는 새 구역이 없다(고를 장소가 생기면 나온다).
    const staffSet = await send(counter, 'staff.set', { changes: [{ op: 'staff.add', ref: 'n1', name: '강다온', role: 'counter' }] });
    assert.equal(staffSet.error.code, 'FORBIDDEN');
  });

  test('the read model knows the viewer: a counter sees `권한 없음 · 관리자 확인 필요` and a disabled save; the manager can save', async () => {
    const draft = { tab: 'places', changes: [{ op: 'area.add', ref: 'n1', label: '새 구역' }] };
    const asCounter = await (await counter.query('shopSettings', draft)).json();
    assert.equal(asCounter.footer, '권한 없음 · 관리자 확인 필요');
    assert.equal(asCounter.primary.enabled, false);
    const asManager = await (await manager.query('shopSettings', draft)).json();
    assert.equal(asManager.footer, '변경 1건 · 다음 기록부터 적용');
    assert.equal(asManager.primary.enabled, true);
    assert.equal((await driver.query('shopSettings', draft)).status, 403, 'no settings on a driver device');
  });

  test('a temporary vehicle, driven by a counter person: the driver phone shows the counter on its tiles, and the session sees that vehicle', async () => {
    const counterId = await staffId('김카운터');
    const van = await send(manager, 'registry.update', { changes: [{ op: 'vehicle.add', ref: 'n1', label: '3호 차량' }] });
    assert.equal(van.outcome, 'applied');
    const assigned = await send(manager, 'staff.set', { changes: [{ op: 'staff.update', id: counterId, vehicleId: 'new:n1' }] }, { dependsOn: [van.requestId] });
    assert.equal(assigned.outcome, 'applied', JSON.stringify(assigned.error ?? null));
    const phone = device(app.port);
    assert.equal((await phone.enroll(/** @type {string} */ (spare.temp))).status, 200);
    const tiles = await (await phone.staffList()).json();
    assert.deepEqual(tiles.staff.map((/** @type {{ name: string }} */ s) => s.name).sort(), ['김카운터', '박기사'], 'role driver or an assignment');
    assert.equal((await phone.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200);
    // 번호로 붙인 기사 기기는 기기의 차량이 먼저(2호 차량): 목록은 그 차량으로 읽힌다. 기사 권한이라 장부는 403.
    assert.equal((await phone.query('ledgerView', { viewKey: 'day_ledger' })).status, 403);
    const list = await (await phone.query('ledgerView', { viewKey: 'collection_list' })).json();
    assert.equal(list.currentBusinessDate !== undefined, true);
    // 사용 종료는 막히지 않는다(업무 · 재고 · 현금 없음). 그 차량의 배정도 끝난다.
    const ended = await send(manager, 'registry.update', { changes: [{ op: 'vehicle.active', id: van.requestId + ':n1', active: false }] });
    assert.equal(ended.outcome, 'applied', JSON.stringify(ended.error ?? null));
    const fleet = await (await manager.query('shopSettings', { tab: 'fleet' })).json();
    assert.equal(fleet.cards[0].list.items.at(-1).tag, '사용 종료');
  });

  test('PIN reset: the manager\'s own PIN first (wrong → 403 PIN_MISMATCH), then a new PIN once, no-store, not in the log, an audit row without the PIN', async () => {
    const driverId = await staffId('박기사');
    const bad = await manager.post('/api/v2/staff/pin', { staffId: driverId, ownPin: pins['정하늘'] === '0000' ? '1111' : '0000' });
    assert.equal(bad.status, 403);
    assert.equal((await bad.json()).code, 'PIN_MISMATCH');
    assert.equal((await counter.post('/api/v2/staff/pin', { staffId: driverId, ownPin: pins['김카운터'] })).status, 403, 'a counter cannot reset PINs');
    assert.equal((await driver.post('/api/v2/staff/pin', { staffId: driverId, ownPin: pins['박기사'] })).status, 403, 'not from a driver device');
    const res = await manager.post('/api/v2/staff/pin', { staffId: driverId, ownPin: pins['정하늘'] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const out = await res.json();
    assert.equal(out.name, '박기사');
    assert.match(out.pin, /^\d{4}$/);
    assert.equal(logs.lines.some(line => line.includes(out.pin)), false, 'the PIN is never logged');
    // 옛 세션은 끝나고 옛 비밀번호는 틀리며 새 비밀번호로 다시 로그인한다.
    assert.equal((await driver.query('ledgerView', { viewKey: 'collection_list' })).status, 401);
    const phone = device(app.port);
    assert.equal((await phone.enroll(/** @type {string} */ (spare.phone2))).status, 200);
    assert.equal((await phone.login('박기사', /** @type {string} */ (pins['박기사']))).status, 401);
    assert.equal((await phone.login('박기사', out.pin)).status, 200);
    const control = openDatabase(join(dataDir, 'db', 'control.sqlite'), { readOnly: true });
    try {
      const rows = control.prepare("SELECT action_key, outcome_key, target_id, after_json, message, ip_hash FROM platform_audit_log WHERE action_key = 'account.pin_reset' ORDER BY seq").all();
      assert.deepEqual(rows.map(r => r.outcome_key), ['denied', 'ok']);
      // 두 줄 모두 요청의 IP 해시(keyed HMAC)를 가진다(2026-09-27 점검).
      assert.ok(rows.every(r => typeof r.ip_hash === 'string' && r.ip_hash.length > 0), 'ip_hash on every pin_reset row');
      assert.equal(JSON.stringify(rows).includes(out.pin), false, 'no PIN in the audit rows');
    } finally {
      control.close();
    }
  });

  test('a new staff member gets a control account on the first PIN reset and can log in; suspending ends their session', async () => {
    const added = await send(manager, 'staff.set', { changes: [{ op: 'staff.add', ref: 'n1', name: '강다온', role: 'counter' }] });
    assert.equal(added.outcome, 'applied', JSON.stringify(added.error ?? null));
    const newId = added.result.staffIds[0];
    const reset = await (await manager.post('/api/v2/staff/pin', { staffId: newId, ownPin: pins['정하늘'] })).json();
    const pos = device(app.port);
    assert.equal((await pos.enroll(/** @type {string} */ (spare.pos4))).status, 200);
    assert.equal((await pos.login('강다온', reset.pin)).status, 200);
    assert.equal((await pos.get('/api/v2/head')).status, 200);
    const ended = await send(manager, 'staff.set', { changes: [{ op: 'staff.active', id: newId, active: false }] });
    assert.equal(ended.outcome, 'applied');
    assert.equal((await pos.get('/api/v2/head')).status, 401, 'the suspended person is signed out');
    const tiles = await (await pos.staffList()).json();
    assert.equal(tiles.staff.some((/** @type {{ name: string }} */ s) => s.name === '강다온'), false);
    const self = await send(manager, 'staff.set', { changes: [{ op: 'staff.active', id: await staffId('정하늘'), active: false }] });
    assert.equal(self.error?.message, '사용 종료 불가 · 본인');
  });

  test('device block: device.manage only; the blocked device is signed out; the asking device cannot block itself', async () => {
    const phone = device(app.port);
    assert.equal((await phone.enroll(/** @type {string} */ (spare.block))).status, 200);
    assert.equal((await counter.post('/api/v2/devices/block', { deviceId: phone.state.deviceId })).status, 403);
    assert.equal((await manager.post('/api/v2/devices/block', { deviceId: manager.state.deviceId })).status, 403);
    const res = await manager.post('/api/v2/devices/block', { deviceId: phone.state.deviceId });
    assert.equal(res.status, 204);
    assert.equal((await phone.staffList()).status, 401);
  });
});

void SHOP;

describe('PIN reset lockout', () => {
  test('wrong own PIN five times → 423 LOCKED with lockedUntil (the right PIN too), and the requester cannot log in again on that device until it ends', async () => {
    const dir = join(temp.dir, 'pin-lock');
    const shop = await provisionedShop(dir);
    const code = await deviceCode(shop.env);
    const app = await startServer(testConfig(dir, shop.env), { log: () => {} });
    try {
      const manager = device(app.port);
      assert.equal((await manager.enroll(/** @type {string} */ (code))).status, 200);
      const own = /** @type {string} */ (shop.pins['정하늘']);
      assert.equal((await manager.login('정하늘', own)).status, 200);
      const fleet = await (await manager.query('shopSettings', { tab: 'fleet' })).json();
      const target = fleet.cards[1].list.items.find((/** @type {{ label: string }} */ i) => i.label === '박기사').key.slice('staff:'.length);
      const wrong = own === '0000' ? '1111' : '0000';
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await manager.post('/api/v2/staff/pin', { staffId: target, ownPin: wrong })).status);
      assert.deepEqual(statuses, [403, 403, 403, 403, 423], 'the fifth wrong own PIN locks the pair');
      const locked = await manager.post('/api/v2/staff/pin', { staffId: target, ownPin: own });
      assert.equal(locked.status, 423, 'even the right PIN waits for the lock');
      assert.match((await locked.json()).lockedUntil ?? '', /^\d{4}-\d{2}-\d{2}T/);
      // 비밀번호 재발급의 실패는 로그인 실패와 같이 센다: 같은 기기에서 다시 로그인해도 잠김.
      assert.equal((await manager.login('정하늘', own)).status, 423);
    } finally {
      await app.close();
    }
  });
});

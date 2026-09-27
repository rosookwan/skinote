// @ts-check
// 리프트권 · 전화 · 인쇄의 서버 길(features-1 plan §8-2 · §8-3 · §8-4 · §8-5): 분실 처리 · 분실 회수는 권한 stock.correct(카운터 · 관리자), 예비권 적재 ·
// 입고는 카운터만(기사 세션은 FORBIDDEN_SCOPE), 리프트권 화면 · 창은 기사에게 403. 창(ticketLossSheet · spareSheet)이 준 명령을 서버가 적고 매장
// 파일에 이동(손님 → 폐기·분실, 폐기·분실 → 매장, 매장 ↔ 차량)이 남는다. 전화 창의 온전한 번호(phoneReveal)와 인쇄 수거 목록은 개인정보 열람 기록
// (pii_access_log)을 한 줄씩 남기고, 기사는 자기 차량 업무의 접수만 번호를 본다.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { newRequestId } from '@skinote/contract';
import { openDatabase } from '@skinote/schema';
import { commandGuard } from '../src/permissions.js';
import { startServer } from '../src/server.js';
import { device, deviceCode, provisionedShop, SHOP, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

/** @param {Record<string, any>} basis @param {string} type @param {unknown} payload @param {Record<string, unknown>} [extra] */
const envelope = (basis, type, payload, extra = {}) => ({ type, commandVersion: 1, requestId: newRequestId(), basis: { epoch: basis.epoch, rev: basis.rev }, payload, ...extra });

describe('lift tickets, phone and print on the real shop file', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let app;
  /** @type {ReturnType<typeof device>} */ let counter;
  /** @type {ReturnType<typeof device>} */ let driver;
  let dataDir = '';

  before(async () => {
    dataDir = join(temp.dir, 'tickets');
    const shop = await provisionedShop(dataDir);
    const codes = [await deviceCode(shop.env), await deviceCode(shop.env, ['--kind', 'driver_phone', '--label', '1호차 휴대폰', '--vehicle', 'v1'])];
    app = await startServer(testConfig(dataDir, shop.env), { log: () => {} });
    counter = device(app.port);
    driver = device(app.port);
    assert.equal((await counter.enroll(/** @type {string} */ (codes[0]))).status, 200);
    assert.equal((await driver.enroll(/** @type {string} */ (codes[1]))).status, 200);
    assert.equal((await counter.login('김카운터', /** @type {string} */ (shop.pins['김카운터']))).status, 200);
    assert.equal((await driver.login('박기사', /** @type {string} */ (shop.pins['박기사']))).status, 200);
  });
  after(async () => { await app?.close(); });

  const head = async () => (await counter.get('/api/v2/head')).json();
  /** @param {string} name @param {unknown} params */
  const ask = async (name, params) => (await counter.query(name, params)).json();
  /** @param {{ command?: any, expect?: any }} sheet */
  const run = async (sheet) => (await counter.command(envelope(await head(), sheet.command.type, sheet.command.payload, sheet.expect ? { expect: sheet.expect } : {}))).json();
  /** @param {(db: import('node:sqlite').DatabaseSync) => unknown} read */
  const shopFile = (read) => {
    const db = openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'));
    try { return read(/** @type {any} */ (db)); } finally { db.close(); }
  };
  /** 야간권 2매 · 스키 1(22:00 설천 주차장 · 1호 차량 수거), 지급까지. */
  const issuedOrder = async () => {
    const draft = {
      channel: 'walk_in', leader: { name: '권손님', phone: '01000007' + String(Math.floor(Math.random() * 900) + 100), party: 2 },
      items: [{ productKey: 'ski', quantity: 1 }, { productKey: 'night_adult', quantity: 2 }], pickup: { mode: 'store', immediate: true },
      giveBack: { mode: 'vehicle', slot: { day: 'today', slotKey: 'night' }, placeKey: 'seolcheon_parking', vehicleId: 'v1' }, returnSet: { time: true, place: true },
    };
    const created = await run(await ask('checkoutSheet', { draft, choices: [{ sectionKey: 'gear', methodKey: 'card' }, { sectionKey: 'lift', methodKey: 'card' }] }));
    assert.equal(created.outcome, 'applied', JSON.stringify(created.error ?? null));
    const orderId = /** @type {string} */ (created.result.orderId);
    assert.equal((await run(await ask('confirmDraft', { orderId, actionKey: 'stamp.issue' }))).outcome, 'applied');
    return { orderId, phone: draft.leader.phone };
  };

  test('a counter writes off one ticket and finds it: rows in the shop file, board counts, no money change', async () => {
    const { orderId } = await issuedOrder();
    const board = await ask('ticketBoard', { tab: 'unreturned' });
    const row = board.rows.find((/** @type {any} */ r) => r.orderId === orderId);
    assert.deepEqual(row.parts.map((/** @type {any} */ p) => p.text), ['야간권 2매', '반납 22:00 · 설천 주차장']);
    const money = (await ask('orderSlip', { orderId })).money;
    const sheet = await ask('ticketLossSheet', { orderId, direction: 'loss', picked: [{ lineId: row.orderId + '-l2', quantity: 1 }] });
    const lineId = sheet.lines[0].lineId;
    const picked = await ask('ticketLossSheet', { orderId, direction: 'loss', picked: [{ lineId, quantity: 1 }] });
    assert.equal(picked.primary.label, '분실 처리 · 야간권 1매');
    const out = await run(picked);
    assert.equal(out.outcome, 'applied', JSON.stringify(out.error ?? null));
    assert.deepEqual((await ask('orderSlip', { orderId })).money, money, 'no charge');
    const status = (await ask('ticketBoard', { tab: 'status' })).status.find((/** @type {any} */ r) => r.key === 'night_adult');
    assert.deepEqual([status.out, status.lost], [1, 1]);
    shopFile((db) => {
      assert.deepEqual(db.prepare(`SELECT m.kind_key AS k, m.from_location_id AS f, m.to_location_id AS t, ml.quantity AS q FROM stock_movements m
        JOIN stock_movement_lines ml ON ml.shop_id = m.shop_id AND ml.movement_id = m.id WHERE m.order_id = ? AND m.kind_key = 'write_off'`).all(orderId).map((/** @type {any} */ r) => [r.k, r.f, r.t, r.q]),
      [['write_off', 'cust:' + orderId, 'void', 1]]);
      assert.equal(/** @type {any} */ (db.prepare('SELECT qty_not_returned AS n FROM order_lines WHERE id = ?').get(lineId)).n, 1);
    });
    const found = await ask('ticketLossSheet', { orderId, direction: 'found' });
    assert.equal(found.primary.label, '분실 회수 · 야간권 1매');
    assert.equal((await run(found)).outcome, 'applied');
    assert.equal((await ask('ticketBoard', { tab: 'lost' })).rows.some((/** @type {any} */ r) => r.orderId === orderId), false);
    shopFile((db) => {
      assert.equal(/** @type {any} */ (db.prepare("SELECT count(*) AS n FROM stock_movements WHERE order_id = ? AND kind_key = 'found' AND from_location_id = 'void' AND to_location_id = 'shop'").get(orderId)).n, 1);
    });
  });

  test('spare tickets: the counter loads 2 onto 1호 차량 and unloads 1, the van stock follows; a driver session cannot', async () => {
    const before = (await ask('vehicleLoad', { vehicleId: 'v1' })).spareTickets;
    const base = before.find((/** @type {any} */ x) => x.label === '야간권')?.qty ?? 0;
    const load = await ask('spareSheet', { vehicleId: 'v1', direction: 'load', picked: [{ productKey: 'night_adult', quantity: 2 }] });
    assert.equal(load.primary.label, '예비권 적재 · 야간권 2매');
    assert.equal((await run(load)).outcome, 'applied');
    const unload = await ask('spareSheet', { vehicleId: 'v1', direction: 'unload', picked: [{ productKey: 'night_adult', quantity: 1 }] });
    assert.equal((await run(unload)).outcome, 'applied');
    assert.deepEqual((await ask('vehicleLoad', { vehicleId: 'v1' })).spareTickets, [{ label: '야간권', qty: base + 1, unit: '매' }]);
    const refused = await (await driver.command(envelope(await head(), 'stock.load', { vehicleId: 'v1', spares: [{ productKey: 'night_adult', quantity: 1 }] }))).json();
    assert.equal(refused.error?.code, 'FORBIDDEN_SCOPE');
    const unloadRefused = await (await driver.command(envelope(await head(), 'stock.receive', { vehicleId: 'v1', taskIds: [], spares: [{ productKey: 'night_adult', quantity: 1 }] }))).json();
    assert.equal(unloadRefused.error?.code, 'FORBIDDEN_SCOPE');
    for (const name of ['ticketBoard', 'ticketLossSheet', 'spareSheet']) {
      const params = name === 'ticketBoard' ? {} : name === 'spareSheet' ? { vehicleId: 'v1', direction: 'load' } : { orderId: 'none', direction: 'loss' };
      assert.equal((await driver.query(name, params)).status, 403, name);
    }
  });

  test('phone reveal and the printed collection list each write one pii_access_log row; a driver sees only its own vehicle\'s orders', async () => {
    const { orderId, phone } = await issuedOrder();
    const reveal = await ask('phoneReveal', { orderId });
    assert.equal(reveal.number.replace(/\D/g, ''), phone);
    const list = await (await counter.query('ledgerView', { viewKey: 'collection_list', vehicleId: 'v1', deviceClass: 'print' })).json();
    const row = list.rows.find((/** @type {any} */ r) => r.orderId === orderId);
    assert.equal(row.cells['action:call'].phone, '010-****-' + phone.slice(-4));
    assert.equal(JSON.stringify(list).includes(phone), false, 'the printed list carries no full number');
    const driverReveal = await driver.query('phoneReveal', { orderId });
    assert.equal(driverReveal.status, 200, 'the driver\'s own vehicle');
    // 매장 반납 팀(차량 업무 없음)의 번호는 기사가 볼 수 없다.
    const store = await run(await ask('checkoutSheet', {
      draft: { channel: 'walk_in', leader: { name: '매장손님', phone: '01000007999', party: 1 }, items: [{ productKey: 'ski', quantity: 1 }], pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' } },
      choices: [{ sectionKey: 'gear', methodKey: 'card' }],
    }));
    assert.equal((await driver.query('phoneReveal', { orderId: store.result.orderId })).status, 403);
    shopFile((db) => {
      const rows = db.prepare('SELECT actor_key AS a, device_id AS d, action_key AS k, subject_type AS s, subject_id AS id, item_count AS n, purge_after AS p, at FROM pii_access_log ORDER BY at, rowid').all();
      const reveals = rows.filter((/** @type {any} */ r) => r.k === 'phone_reveal' && r.id === orderId);
      assert.equal(reveals.length, 2, 'the counter and the driver');
      assert.equal(reveals.every((/** @type {any} */ r) => String(r.a).startsWith('staff:') && r.d && r.s === 'order'), true);
      const prints = rows.filter((/** @type {any} */ r) => r.k === 'list_print');
      assert.equal(prints.length, 1);
      assert.deepEqual([prints[0].s, prints[0].n], ['list', list.rows.length]);
      assert.equal(prints[0].p > prints[0].at, true, 'kept until the retention date');
      assert.equal(JSON.stringify(rows).includes(phone), false, 'the log holds no phone number');
    });
  });

  test('only phoneReveal carries the full number: lists, slip, task sheet and pins are masked (counter and driver); a printed slip writes a list_print row', async () => {
    const { orderId, phone } = await issuedOrder();
    const dashed = phone.slice(0, 3) + '-' + phone.slice(3, 7) + '-' + phone.slice(7);
    const full = (/** @type {unknown} */ x) => { const text = JSON.stringify(x); return text.includes(phone) || text.includes(dashed); };
    const reads = {
      ledger: await ask('ledgerView', { viewKey: 'day_ledger' }),
      list: await ask('ledgerView', { viewKey: 'collection_list', vehicleId: 'v1' }),
      slip: await ask('orderSlip', { orderId }),
      find: await ask('findLast4', { last4: phone.slice(-4) }),
      driverList: await (await driver.query('ledgerView', { viewKey: 'collection_list' })).json(),
      task: await (await driver.query('taskSheet', { taskId: 'collect:' + orderId })).json(),
    };
    for (const [name, body] of Object.entries(reads)) assert.equal(full(body), false, name + ' carries no full number');
    assert.equal(reads.slip.fields.find((/** @type {any} */ f) => f.key === 'phone').value, '010-****-' + phone.slice(-4));
    assert.equal(full(await ask('phoneReveal', { orderId })), true, 'the call window still gets it');
    const printed = await ask('orderSlip', { orderId, deviceClass: 'print' });
    assert.equal(full(printed), false);
    shopFile((db) => {
      const rows = db.prepare("SELECT subject_type AS s, subject_id AS id FROM pii_access_log WHERE action_key = 'list_print' AND subject_type = 'order'").all();
      assert.deepEqual(rows.map((/** @type {any} */ r) => [r.s, r.id]), [['order', orderId]], 'the printed slip is logged');
    });
  });
});

test('the permission table: write-off and found need stock.correct; spare load · unload are counter only', () => {
  const basis = { epoch: 'e', rev: 1 };
  /** @param {string} type @param {unknown} payload */
  const env = (type, payload) => /** @type {any} */ ({ type, commandVersion: 1, requestId: newRequestId(), basis, payload });
  const counter = { roleKey: 'counter', deviceKind: /** @type {const} */ ('pos') };
  const driver = { roleKey: 'driver', deviceKind: /** @type {const} */ ('driver_phone'), vehicleId: 'v1' };
  const shop = /** @type {const} */ ({ kind: 'shop' });
  const van = /** @type {const} */ ({ kind: 'vehicle', vehicleIds: ['v1'] });
  const writeOff = env('stock.write_off', { orderId: 'o1', lines: [{ lineId: 'o1-l1', quantity: 1 }], reasonKey: 'lost' });
  const found = env('asset.found', { orderId: 'o1', lines: [{ lineId: 'o1-l1', quantity: 1 }] });
  assert.equal(commandGuard(counter, new Map([['stock.correct', 'shop']]), writeOff)(shop), null);
  assert.equal(commandGuard(counter, new Map([['stock.move', 'shop']]), found)(shop)?.error?.code, 'FORBIDDEN');
  assert.equal(commandGuard(driver, new Map([['stock.correct', 'shop']]), writeOff)(shop)?.error?.code, 'FORBIDDEN_SCOPE');
  const spare = env('stock.load', { vehicleId: 'v1', spares: [{ productKey: 'night_adult', quantity: 1 }] });
  const task = env('stock.load', { taskId: 'deliver:o1', lines: [] });
  const perms = new Map([['stock.move', 'own_vehicle'], ['stock.receive', 'own_vehicle']]);
  assert.equal(commandGuard(counter, perms, spare)(van), null);
  assert.equal(commandGuard(driver, perms, spare)(van)?.error?.code, 'FORBIDDEN_SCOPE');
  assert.equal(commandGuard(driver, perms, task)(van), null, 'a driver may still load its own delivery');
  const unload = env('stock.receive', { vehicleId: 'v1', taskIds: [], spares: [{ productKey: 'night_adult', quantity: 1 }] });
  assert.equal(commandGuard(driver, perms, unload)(van)?.error?.code, 'FORBIDDEN_SCOPE');
  assert.equal(commandGuard(driver, perms, env('stock.receive', { vehicleId: 'v1', taskIds: ['collect:o1'] }))(van), null);
});

// @ts-check
// 즉시 교환의 권한과 서버 길(features-1 plan §7-4 · §7-6): exchange.swap은 권한 exchange.manage(카운터 · 관리자), 기사 세션은 FORBIDDEN_SCOPE(E14: 업무
// 판에 교환이 없다). 창(exchangeSheet)이 준 명령을 서버가 적고, 매장 파일에 교환 · 교환 단위 · 손님에게 있던 것의 이동 두 줄(exchange_id)이 남으며,
// 접수증은 지금 사이즈와 출처 줄을 보인다. 지급 전 교환은 이동이 없고, 뒤의 지급이 새 사이즈로 나간다.

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

describe('size exchange on the real shop file', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let app;
  /** @type {ReturnType<typeof device>} */ let counter;
  let dataDir = '';

  before(async () => {
    dataDir = join(temp.dir, 'exchange');
    const shop = await provisionedShop(dataDir);
    const code = await deviceCode(shop.env);
    app = await startServer(testConfig(dataDir, shop.env), { log: () => {} });
    counter = device(app.port);
    assert.equal((await counter.enroll(/** @type {string} */ (code))).status, 200);
    assert.equal((await counter.login('김카운터', /** @type {string} */ (shop.pins['김카운터']))).status, 200);
  });
  after(async () => { await app?.close(); });

  const head = async () => (await counter.get('/api/v2/head')).json();
  /** @param {string} name @param {unknown} params */
  const ask = async (name, params) => (await counter.query(name, params)).json();
  /** @param {{ command?: any, expect?: any }} sheet */
  const run = async (sheet) => (await counter.command(envelope(await head(), sheet.command.type, sheet.command.payload, sheet.expect ? { expect: sheet.expect } : {}))).json();
  /** @param {unknown[]} items @param {Record<string, unknown>} [pickup] */
  const draftOf = (items, pickup = { mode: 'store', immediate: true }) => ({
    channel: pickup.immediate ? 'walk_in' : 'phone', leader: { name: '교환손님', phone: '01000005' + String(Math.floor(Math.random() * 900) + 100), party: 2 }, items,
    pickup, giveBack: { mode: 'store' },
  });
  /** @param {unknown} draft */
  const create = async (draft) => {
    const created = await run(await ask('checkoutSheet', { draft, choices: [{ sectionKey: 'gear', methodKey: 'card' }] }));
    assert.equal(created.outcome, 'applied', JSON.stringify(created.error ?? null));
    return /** @type {string} */ (created.result.orderId);
  };

  test('a counter swaps one of two issued clothes 100 → 105: rows, movements, slip name and provenance row; money unchanged', async () => {
    const orderId = await create(draftOf([{ productKey: 'clothes', variantKey: '100', quantity: 2 }]));
    const issue = await ask('confirmDraft', { orderId, actionKey: 'stamp.issue' });
    assert.equal((await run(issue)).outcome, 'applied');
    const before = await ask('orderSlip', { orderId });
    const sheet = await ask('exchangeSheet', { orderId });
    assert.equal(sheet.title.startsWith('즉시 교환 · '), true);
    assert.deepEqual(sheet.items.map((/** @type {any} */ i) => i.label), ['의류 사이즈 100 · 2벌']);
    const picked = await ask('exchangeSheet', { orderId, lineId: sheet.lineId, from: '100', planned: false, quantity: 1, to: '105' });
    assert.equal(picked.primary.label, '즉시 교환 · 의류 1벌');
    const out = await run(picked);
    assert.equal(out.outcome, 'applied', JSON.stringify(out.error ?? null));
    const slip = await ask('orderSlip', { orderId });
    assert.equal(slip.lines[0].label, '의류 사이즈 105 1 · 사이즈 100 1');
    assert.match(slip.adjustments.map((/** @type {any} */ a) => a.parts.map((/** @type {any} */ p) => p.text).join(' · ')).join('|'), /^즉시 교환 · 의류 사이즈 100 → 사이즈 105 · 1벌 · \d\d:\d\d$/);
    assert.deepEqual(slip.money, before.money);
    const db = openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'));
    try {
      const ex = /** @type {any} */ (db.prepare('SELECT id, old_size, new_size, status_key, created_by FROM exchanges WHERE order_id = ?').get(orderId));
      assert.deepEqual([ex.id, ex.old_size, ex.new_size, ex.status_key, ex.created_by.startsWith('staff:')], [out.requestId, '사이즈 100', '사이즈 105', 'completed', true]);
      assert.deepEqual(db.prepare(`SELECT m.kind_key AS k, ml.variant_id AS v, ml.quantity AS q FROM stock_movements m JOIN stock_movement_lines ml ON ml.shop_id = m.shop_id AND ml.movement_id = m.id
        WHERE m.exchange_id = ? ORDER BY m.rowid`).all(ex.id).map((/** @type {any} */ r) => [r.k, r.v, r.q]), [['direct_return', 'clothes:100', 1], ['deliver', 'clothes:105', 1]]);
    } finally {
      db.close();
    }
    // 다시 보내도(같은 요청번호) 결과가 같고 교환이 늘지 않는다는 것은 저장소 시험(twin run)이 본다. 없는 사이즈는 거절.
    const bad = await (await counter.command(envelope(await head(), 'exchange.swap', { orderId, lineId: sheet.lineId, quantity: 1, from: '100', to: '300', planned: false }))).json();
    assert.equal(bad.error?.message, '교환 불가 · 교환 대상 없음');
  });

  test('a booked helmet is swapped before issue (no movement), and the issue then gives the new size', async () => {
    const orderId = await create(draftOf([{ productKey: 'helmet', variantKey: '중', quantity: 1 }], { mode: 'store', day: 'tomorrow', time: '09:00' }));
    const sheet = await ask('exchangeSheet', { orderId, to: '대' });
    assert.equal(sheet.quantity.name, '지급 예정 사이즈');
    assert.equal((await run(sheet)).outcome, 'applied');
    const issue = await ask('confirmDraft', { orderId, actionKey: 'stamp.issue' });
    assert.equal((await run(issue)).outcome, 'applied');
    const db = openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'));
    try {
      assert.deepEqual(db.prepare(`SELECT m.exchange_id AS ex, ml.variant_id AS v FROM stock_movements m JOIN stock_movement_lines ml ON ml.shop_id = m.shop_id AND ml.movement_id = m.id
        WHERE m.order_id = ? ORDER BY m.rowid`).all(orderId).map((/** @type {any} */ r) => [r.ex, r.v]), [[null, 'helmet:대']]);
    } finally {
      db.close();
    }
  });
});

test('the permission table: exchange.swap needs exchange.manage, a driver session is FORBIDDEN_SCOPE', () => {
  const basis = { epoch: 'e', rev: 1 };
  const swap = /** @type {any} */ ({ type: 'exchange.swap', commandVersion: 1, requestId: newRequestId(), basis, payload: { orderId: 'o1', lineId: 'o1-l1', quantity: 1, from: '중', to: '대', planned: false } });
  const counter = { roleKey: 'counter', deviceKind: /** @type {const} */ ('pos') };
  const driver = { roleKey: 'driver', deviceKind: /** @type {const} */ ('driver_phone'), vehicleId: 'v1' };
  const shop = /** @type {const} */ ({ kind: 'shop' });
  assert.equal(commandGuard(counter, new Map([['exchange.manage', 'shop']]), swap)(shop), null);
  assert.equal(commandGuard(counter, new Map([['order.add', 'shop']]), swap)(shop)?.error?.code, 'FORBIDDEN');
  assert.equal(commandGuard(driver, new Map([['exchange.manage', 'shop']]), swap)(shop)?.error?.code, 'FORBIDDEN_SCOPE');
});

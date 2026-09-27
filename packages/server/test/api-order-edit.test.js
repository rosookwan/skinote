// @ts-check
// 품목 추가 · 접수 취소 · 품목 취소의 권한과 서버 길(features-1 plan §5-3 · §5-5): order.cancel은 권한 order.cancel, order.add는 order.add, 이어진 환불은
// payment.refund. 기사 세션은 셋 모두 FORBIDDEN_SCOPE(차량 규칙 없음, 기사 역할의 order.add는 현장 리프트권 추가만). 창(cancelSheet · checkoutSheet
// addTo)이 준 명령을 서버가 적고, 매장 파일에 취소 · 환불 · 새 차수가 남는다.

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

describe('order edit on the real shop file', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let app;
  /** @type {ReturnType<typeof device>} */ let counter;
  let dataDir = '';

  before(async () => {
    dataDir = join(temp.dir, 'order-edit');
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
  /** 창의 명령과 이어진 명령(dependsOn)을 차례로. @param {{ command?: any, expect?: any, then?: any[] }} sheet */
  const run = async (sheet) => {
    const basis = await head();
    const first = envelope(basis, sheet.command.type, sheet.command.payload, { expect: sheet.expect });
    const outcomes = [await (await counter.command(first)).json()];
    let previous = first.requestId;
    for (const step of sheet.then ?? []) {
      const next = envelope(basis, step.command.type, step.command.payload, { expect: step.expect, dependsOn: [previous] });
      outcomes.push(await (await counter.command(next)).json());
      previous = next.requestId;
    }
    return outcomes;
  };
  const draftOf = (/** @type {unknown[]} */ items) => ({
    channel: 'walk_in', leader: { name: '취소손님', phone: '01000006' + String(Math.floor(Math.random() * 900) + 100), party: 2 }, items,
    pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' },
  });

  test('a counter adds items (cash) and cancels them with a cash refund; the shop file keeps the batch, the cancellation and the refund', async () => {
    const checkout = await ask('checkoutSheet', { draft: draftOf([{ productKey: 'ski', quantity: 2 }]), choices: [{ sectionKey: 'gear', methodKey: 'card' }] });
    const [created] = await run(checkout);
    assert.equal(created.outcome, 'applied', JSON.stringify(created.error ?? null));
    const orderId = created.result.orderId;
    const added = await ask('checkoutSheet', { draft: draftOf([{ productKey: 'helmet', variantKey: '중', quantity: 1 }]), addTo: orderId, choices: [{ sectionKey: 'gear', methodKey: 'cash' }] });
    assert.match(added.primary.label, /^추가 확정 · 현금 /);
    const [addOut] = await run(added);
    assert.equal(addOut.outcome, 'applied', JSON.stringify(addOut.error ?? null));
    const lineId = addOut.result.lineIds[0];
    const sheet = await ask('cancelSheet', { orderId, scope: 'lines', picked: [{ lineId, quantity: 1 }] });
    assert.match(sheet.primary.label, /^품목 취소 · 헬멧 .* · 환불 현금 /);
    const outcomes = await run(sheet);
    assert.deepEqual(outcomes.map((o) => o.outcome), ['applied', 'applied'], JSON.stringify(outcomes.map((o) => o.error ?? null)));
    // 접수 취소: 스키 둘 · 카드 환불(단말기 취소).
    const whole = await ask('cancelSheet', { orderId, scope: 'order', reasonKey: 'no_show' });
    assert.ok(whole.refunds.some((/** @type {any} */ r) => r.parts.some((/** @type {any} */ p) => p.text === '단말기 취소')));
    assert.deepEqual((await run(whole)).map((o) => o.outcome), ['applied', 'applied']);
    const ledger = await (await counter.query('ledgerView', { viewKey: 'day_ledger' })).json();
    const row = ledger.rows.find((/** @type {any} */ r) => r.orderId === orderId);
    assert.equal(row?.statusWord, '취소');
    const db = openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'));
    try {
      assert.equal(/** @type {any} */ (db.prepare("SELECT label FROM order_batches WHERE order_id = ? AND seq = 2").get(orderId))?.label, '품목 추가');
      assert.deepEqual(db.prepare('SELECT reason, refund_decision_key AS d FROM order_cancellations WHERE order_id = ? ORDER BY rowid').all(orderId).map((/** @type {any} */ r) => [r.reason, r.d]),
        [['품목 취소 · 취소 요청', 'refund'], ['접수 취소 · 연락 없음', 'refund']]);
      assert.deepEqual(db.prepare("SELECT method_id AS m FROM payments WHERE kind_key = 'refund' AND reason LIKE '%취소%' ORDER BY rowid").all().map((/** @type {any} */ r) => r.m), ['cash', 'card']);
      assert.equal(/** @type {any} */ (db.prepare('SELECT status_key FROM orders WHERE id = ?').get(orderId))?.status_key, 'cancelled');
    } finally {
      db.close();
    }
  });

  test('a refund with the cancellation cause and no cancellation behind it is refused (`환불 대상 없음`)', async () => {
    const checkout = await ask('checkoutSheet', { draft: draftOf([{ productKey: 'ski', quantity: 1 }]), choices: [{ sectionKey: 'gear', methodKey: 'cash' }] });
    const [created] = await run(checkout);
    const slip = await ask('orderSlip', { orderId: created.result.orderId });
    assert.equal(slip.money.paid, 40_000);
    const orders = await (await counter.query('findLast4', { last4: slip.last4 })).json();
    const orderId = orders.matches.at(-1).orderId;
    const basis = await head();
    const orphan = envelope(basis, 'payment.refund', { orderId, cause: 'cancellation', refunds: [{ paymentId: 'x', methodKey: 'cash', amount: 1_000 }] }, { expect: { refundAmount: 1_000 }, dependsOn: [newRequestId()] });
    const out = await (await counter.command(orphan)).json();
    assert.equal(out.outcome, 'rejected');
    assert.equal(out.error?.message, '환불 대상 없음');
  });
});

test('the permission table: order.cancel · order.add need their permission, a driver session is FORBIDDEN_SCOPE', () => {
  const basis = { epoch: 'e', rev: 1 };
  /** @param {string} type @param {unknown} payload */
  const env = (type, payload) => /** @type {any} */ ({ type, commandVersion: 1, requestId: newRequestId(), basis, payload });
  const counter = { roleKey: 'counter', deviceKind: /** @type {const} */ ('pos') };
  const driver = { roleKey: 'driver', deviceKind: /** @type {const} */ ('driver_phone'), vehicleId: 'v1' };
  const cancel = env('order.cancel', { orderId: 'o1', scope: 'order', lines: [], reasonKey: 'request', decision: 'not_applicable' });
  const add = env('order.add', { orderId: 'o1', items: [{ productKey: 'ski', quantity: 1 }], choices: [], payer: 'order' });
  const shop = /** @type {const} */ ({ kind: 'shop' });
  assert.equal(commandGuard(counter, new Map([['order.cancel', 'shop']]), cancel)(shop), null);
  assert.equal(commandGuard(counter, new Map([['order.add', 'shop']]), cancel)(shop)?.error?.code, 'FORBIDDEN');
  assert.equal(commandGuard(counter, new Map([['order.add', 'shop']]), add)(shop), null);
  assert.equal(commandGuard(driver, new Map([['order.add', 'own_vehicle'], ['order.cancel', 'shop']]), add)(shop)?.error?.code, 'FORBIDDEN_SCOPE');
  assert.equal(commandGuard(driver, new Map([['order.cancel', 'shop']]), cancel)(shop)?.error?.code, 'FORBIDDEN_SCOPE');
});

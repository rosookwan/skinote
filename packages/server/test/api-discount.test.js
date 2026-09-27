// @ts-check
// 할인 적용 · 환불의 권한(features-1 plan §6-4 · E10): discount.apply는 권한 discount.apply, 직접 입력은 discount.manual도(서버의 권한 표), 역할
// 한도(role_permissions.limits_json의 max_discount_amount)와 권한이 걸린 매장 할인(discount_rules.required_permission_key)은 도메인이 세션의
// 권한 · 한도로 다시 본다(`권한 없음 · 관리자 확인 필요`, FORBIDDEN). 한도가 없는 관리자는 된다. 결제 뒤 할인은 창이 이어 보내는 환불
// (payment.refund, cause discount)과 함께 적힌다. 기사 세션은 할인 · 환불을 하지 못한다.

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

describe('discounts on the real shop file', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let app;
  /** @type {ReturnType<typeof device>} */ let manager;
  /** @type {ReturnType<typeof device>} */ let counter;
  let dataDir = '';

  before(async () => {
    dataDir = join(temp.dir, 'discounts');
    const shop = await provisionedShop(dataDir);
    // 카운터의 직접 입력 한도 10,000원은 매장을 만들 때의 시작 값(ROLE_START_LIMITS, 2026-09-27 점검: 전에는 한도가 비어 있었다). 여기서는 적지 않고
    // 만든 그대로 읽는지 본다. 20% 리프트권 할인은 관리자 권한이 걸린 할인(시험 파일에만).
    const db = openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'));
    const limits = /** @type {any} */ (db.prepare("SELECT limits_json FROM role_permissions WHERE role_id = 'counter' AND permission_key = 'discount.manual'").get());
    assert.deepEqual(JSON.parse(limits.limits_json), { max_discount_amount: 10_000 });
    assert.equal(db.prepare("SELECT count(*) AS n FROM role_permissions WHERE role_id = 'counter' AND permission_key = 'cash.entry'").get()?.n, 0, 'the counter lacks cash.entry');
    db.prepare("UPDATE discount_rules SET required_permission_key = 'settings.manage' WHERE id = 'lift_twenty'").run();
    db.close();
    const codes = [await deviceCode(shop.env), await deviceCode(shop.env, ['--kind', 'pos', '--label', '카운터 2'])];
    app = await startServer(testConfig(dataDir, shop.env), { log: () => {} });
    manager = device(app.port);
    counter = device(app.port);
    for (const [d, code, name] of /** @type {const} */ ([[manager, codes[0], '정하늘'], [counter, codes[1], '김카운터']])) {
      assert.equal((await d.enroll(/** @type {string} */ (code))).status, 200);
      assert.equal((await d.login(name, /** @type {string} */ (shop.pins[name]))).status, 200, name);
    }
  });
  after(async () => { await app?.close(); });

  const head = async () => (await manager.get('/api/v2/head')).json();
  /** @param {ReturnType<typeof device>} d @param {string} type @param {unknown} payload @param {Record<string, unknown>} [extra] */
  const send = async (d, type, payload, extra) => (await d.command(envelope(await head(), type, payload, extra))).json();
  /** @param {ReturnType<typeof device>} d @param {string} name @param {unknown} params */
  const ask = async (d, name, params) => (await d.query(name, params)).json();

  /** 현장 접수 하나(장비 수단 · 후불)를 창이 준 명령으로. @param {string} name @param {string} methodKey */
  const newOrder = async (name, methodKey, items = [{ productKey: 'ski', quantity: 2 }, { productKey: 'helmet', variantKey: '중', quantity: 1 }], sectionKey = 'gear') => {
    const draft = {
      channel: 'walk_in', leader: { name, phone: '01000006' + String(Math.floor(Math.random() * 900) + 100), party: 2 }, items,
      pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' },
    };
    const sheet = await ask(manager, 'checkoutSheet', { draft, choices: [{ sectionKey, methodKey }] });
    const out = await send(manager, sheet.command.type, sheet.command.payload, { expect: sheet.expect });
    assert.equal(out.outcome, 'applied', JSON.stringify(out.error ?? null));
    return /** @type {string} */ (out.result.orderId);
  };
  /** 할인 적용 창의 명령과 이어진 환불을 차례로(창의 길). @param {ReturnType<typeof device>} d @param {Record<string, unknown>} params */
  const viaSheet = async (d, params) => {
    const sheet = await ask(d, 'discountSheet', params);
    if (!sheet.command) return { sheet, outcomes: [] };
    const basis = await head();
    const first = envelope(basis, sheet.command.type, sheet.command.payload, { expect: sheet.expect });
    const outcomes = [await (await d.command(first)).json()];
    let previous = first.requestId;
    for (const step of sheet.then ?? []) {
      const next = envelope(basis, step.command.type, step.command.payload, { expect: step.expect, dependsOn: [previous] });
      outcomes.push(await (await d.command(next)).json());
      previous = next.requestId;
    }
    return { sheet, outcomes };
  };

  test('counter manual within the limit applies, above the limit is FORBIDDEN; the sheet shows the limit and greys a gated rule', async () => {
    const orderId = await newOrder('할인가', 'later');
    const sheet = await ask(counter, 'discountSheet', { orderId, sectionKey: 'gear' });
    assert.deepEqual(sheet.manual.kinds.map((/** @type {any} */ k) => [k.key, k.limit]), [['amount', 10_000], ['percent', 11]]);
    const within = await viaSheet(counter, { orderId, sectionKey: 'gear', choice: { manual: { kind: 'amount', value: 5_000, reason: '단골' } } });
    assert.deepEqual(within.outcomes.map((/** @type {any} */ o) => o.outcome), ['applied']);
    const due = (await ask(counter, 'orderSlip', { orderId })).money.due;
    assert.equal(due, 80_000, 'charged 85,000 − 5,000');
    const over = await send(counter, 'discount.apply', { orderId, sectionKey: 'gear', choice: { manual: { kind: 'amount', value: 20_000, reason: '단골' } } }, { expect: { dueAmount: due } });
    assert.equal(over.outcome, 'rejected');
    assert.deepEqual(over.error, { code: 'FORBIDDEN', message: '권한 없음 · 관리자 확인 필요' });
    const overSheet = await ask(counter, 'discountSheet', { orderId, sectionKey: 'gear', choice: { manual: { kind: 'amount', value: 20_000, reason: '단골' } } });
    assert.equal(overSheet.notice, '권한 없음 · 관리자 확인 필요');
    assert.equal(overSheet.primary.enabled, false);
    // 관리자는 한도가 없다.
    const byManager = await viaSheet(manager, { orderId, sectionKey: 'gear', choice: { manual: { kind: 'amount', value: 20_000, reason: '행사' } } });
    assert.deepEqual(byManager.outcomes.map((/** @type {any} */ o) => o.outcome), ['applied']);
    assert.equal((await ask(manager, 'orderSlip', { orderId })).money.due, 65_000);
  });

  test('a rule gated by a permission the counter lacks is greyed and refused; the manager applies it', async () => {
    const orderId = await newOrder('권종', 'later', [{ productKey: 'night_adult', quantity: 2 }], 'lift');
    const sheet = await ask(counter, 'discountSheet', { orderId, sectionKey: 'lift' });
    const gated = sheet.choices.find((/** @type {any} */ c) => c.key === 'lift_twenty');
    assert.equal(gated.enabled, false);
    assert.equal(gated.reason, '권한 없음 · 관리자 확인 필요');
    const refused = await send(counter, 'discount.apply', { orderId, sectionKey: 'lift', choice: { ruleKey: 'lift_twenty' } }, { expect: { dueAmount: 70_000 } });
    assert.equal(refused.error?.code, 'FORBIDDEN');
    const ok = await viaSheet(manager, { orderId, sectionKey: 'lift', choice: { ruleKey: 'lift_twenty' } });
    assert.deepEqual(ok.outcomes.map((/** @type {any} */ o) => o.outcome), ['applied']);
  });

  test('after payment the discount chains a refund (cash), the slip and the closing show it, the shop file keeps the refund row', async () => {
    const orderId = await newOrder('결제뒤', 'card');
    const opened = await ask(counter, 'discountSheet', { orderId, sectionKey: 'gear', choice: { ruleKey: 'ten_percent' } });
    assert.equal(opened.refunds.length, 1);
    const payment = opened.refunds[0].paymentId;
    // 카드로 받은 돈을 현금으로 돌려주기는 cash.entry(관리자): 카운터에게 `현금`은 막힌 버튼이다(2026-09-27 점검).
    assert.deepEqual(opened.refunds[0].methods.map((/** @type {any} */ m) => [m.key, m.enabled]), [['card', true], ['cash', false]]);
    const done = await viaSheet(manager, { orderId, sectionKey: 'gear', choice: { ruleKey: 'ten_percent' }, methods: { [payment]: 'cash' } });
    assert.equal(done.sheet.primary.label, '할인 적용 · 환불 현금 8,500원');
    assert.deepEqual(done.outcomes.map((/** @type {any} */ o) => o.outcome), ['applied', 'applied']);
    const slip = await ask(counter, 'orderSlip', { orderId });
    assert.deepEqual([slip.money.charged, slip.money.paid, slip.money.due, slip.money.refunded], [76_500, 76_500, 0, 8_500]);
    const closing = await ask(manager, 'closingSheet', {});
    assert.ok(closing.methods.some((/** @type {any} */ m) => m.key === 'refund' && m.amount <= -8_500), 'the closing has the refund row');
    const db = openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'), { readOnly: true });
    try {
      const row = /** @type {any} */ (db.prepare("SELECT method_id, amount, reason, refund_of_payment_id FROM payments WHERE kind_key = 'refund' ORDER BY rowid DESC LIMIT 1").get());
      assert.deepEqual({ ...row, refund_of_payment_id: typeof row.refund_of_payment_id }, { method_id: 'cash', amount: 8_500, reason: '할인 변경', refund_of_payment_id: 'string' });
    } finally {
      db.close();
    }
    // 까닭 없는 환불은 거절(다른 초과 수납이 있어도 흡수하지 않는다).
    const orphan = await send(counter, 'payment.refund', { orderId, cause: 'discount', refunds: [{ paymentId: payment, methodKey: 'cash', amount: 1_000 }] }, { expect: { refundAmount: 1_000 } });
    assert.equal(orphan.error?.message, '환불 대상 없음');
    // 카운터가 창을 거치지 않고 카드 수납을 현금으로 돌려주려 하면 FORBIDDEN(받은 수단 그대로는 된다).
    const second = await newOrder('결제뒤둘', 'card');
    const sheet = await ask(counter, 'discountSheet', { orderId: second, sectionKey: 'gear', choice: { ruleKey: 'ten_percent' } });
    const apply = envelope(await head(), sheet.command.type, sheet.command.payload, { expect: sheet.expect });
    assert.equal((await (await counter.command(apply)).json()).outcome, 'applied');
    const refund = (/** @type {string} */ methodKey) => ({ orderId: second, cause: 'discount', refunds: [{ paymentId: sheet.refunds[0].paymentId, methodKey, amount: 8_500 }] });
    const cross = await send(counter, 'payment.refund', refund('cash'), { expect: { refundAmount: 8_500 }, dependsOn: [apply.requestId] });
    assert.equal(cross.error?.code, 'FORBIDDEN');
    const same = await send(counter, 'payment.refund', refund('card'), { expect: { refundAmount: 8_500 }, dependsOn: [apply.requestId] });
    assert.equal(same.outcome, 'applied', JSON.stringify(same.error ?? null));
  });

  test('a new order with a manual discount above the counter limit is FORBIDDEN; the checkout sheet greys nothing but the pad shows the limit', async () => {
    const draft = {
      channel: 'walk_in', leader: { name: '새손님', phone: '01000006999', party: 1 }, items: [{ productKey: 'ski', quantity: 2 }],
      pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' },
    };
    const choices = [{ sectionKey: 'gear', methodKey: 'card', discountKey: 'manual', manual: { kind: 'amount', value: 20_000, reason: '단골' } }];
    const sheet = await ask(counter, 'checkoutSheet', { draft, choices });
    assert.equal(sheet.notice, '권한 없음 · 관리자 확인 필요');
    assert.equal(sheet.primary.enabled, false);
    const refused = await send(counter, 'order.create', { draft, choices, payerOrderId: null }, { expect: { quoteHash: 'x' } });
    assert.equal(refused.error?.code, 'FORBIDDEN');
    const managerSheet = await ask(manager, 'checkoutSheet', { draft, choices });
    const ok = await send(manager, managerSheet.command.type, managerSheet.command.payload, { expect: managerSheet.expect });
    assert.equal(ok.outcome, 'applied', JSON.stringify(ok.error ?? null));
  });
});

test('a driver session cannot apply a discount or refund (commandGuard)', () => {
  const who = { roleKey: 'driver', deviceKind: /** @type {const} */ ('driver_phone'), vehicleId: 'v1' };
  const perms = new Map([['stock.move', 'own_vehicle'], ['payment.collect_field', 'own_vehicle']]);
  const basis = { epoch: 'E', rev: 1 };
  for (const [type, payload] of /** @type {const} */ ([
    ['discount.apply', { orderId: 'o1', sectionKey: 'gear', choice: { ruleKey: 'ten_percent' } }],
    ['payment.refund', { orderId: 'o1', cause: 'discount', refunds: [{ paymentId: 'p1', methodKey: 'cash', amount: 1_000 }] }],
  ])) {
    const refusal = commandGuard(who, perms, /** @type {any} */ (envelope(basis, type, payload)))({ kind: 'vehicle', vehicleIds: ['v1'] });
    assert.equal(refusal?.outcome, 'rejected', type);
  }
  // 카운터(할인 적용 권한만)는 직접 입력이면 discount.manual이 없어 FORBIDDEN.
  const counter = { roleKey: 'counter', deviceKind: /** @type {const} */ ('pos') };
  const guard = commandGuard(counter, new Map([['discount.apply', 'shop']]), /** @type {any} */ (envelope(basis, 'discount.apply', { orderId: 'o1', sectionKey: 'gear', choice: { manual: { kind: 'amount', value: 1_000, reason: '단골' } } })));
  assert.equal(guard({ kind: 'shop' })?.error?.code, 'FORBIDDEN');
  assert.equal(commandGuard(counter, new Map([['discount.apply', 'shop']]), /** @type {any} */ (envelope(basis, 'discount.apply', { orderId: 'o1', sectionKey: 'gear', choice: { none: true } })))({ kind: 'shop' }), null);
});

// @ts-check
// 명령(plan §5-4): 진짜 매장 파일에서 운영 규칙 저장 → 적용 · rev + 1, 같은 요청번호는 같은 결과(새 rev 없음), 같은 번호의 다른 본문은
// 첫 결과 + idempotencyMismatch, 처리 오류 뒤 같은 번호를 다시 보내면 한 번만 적용, 쓰는 사람 둘이 동시에 보내도 한 줄로 서서 rev가 겹치지
// 않음, 역할에 없는 권한은 FORBIDDEN. 새 접수는 표에 적혀 다른 기기의 장부에 보인다(한 장부), 같은 바탕의 둘째 운영 규칙 저장은 충돌.
// 기사 세션의 차량 규칙(FORBIDDEN_SCOPE)은 범위를 정해 둔 가짜 창구(fake-store.js)로, 기사 세션의 거절 기본은 commandGuard로 본다.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { newRequestId } from '@skinote/contract';
import { startServer } from '../src/server.js';
import { fakeShop } from './fake-store.js';
import { device, deviceCode, provisionedShop, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

/** @param {Record<string, any>} basis @param {string} type @param {unknown} payload @param {Record<string, unknown>} [extra] */
const envelope = (basis, type, payload, extra = {}) => ({ type, commandVersion: 1, requestId: newRequestId(), basis: { epoch: basis.epoch, rev: basis.rev }, payload, ...extra });
const refund = (/** @type {string} */ value) => ({ changes: [{ key: 'shop_settings:same_day_cancel_refund_default:decision', value }] });

describe('the real shop file', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let app;
  /** @type {ReturnType<typeof device>} */ let manager;
  /** @type {ReturnType<typeof device>} */ let manager2;
  /** @type {ReturnType<typeof device>} */ let counter;
  let crashNext = false;

  before(async () => {
    const dataDir = join(temp.dir, 'real');
    const shop = await provisionedShop(dataDir);
    const codes = [await deviceCode(shop.env), await deviceCode(shop.env, ['--kind', 'pos', '--label', '카운터 2']), await deviceCode(shop.env, ['--kind', 'pos', '--label', '카운터 3'])];
    app = await startServer(testConfig(dataDir, shop.env), {
      log: () => {},
      // 처리 오류 흉내: 창구의 명령이 한 번 던진다(저장소 안의 고장 단계별 되돌림은 저장소 시험이 본다).
      shopPort: real => ({
        ...real,
        command: (...args) => {
          if (crashNext) {
            crashNext = false;
            throw new Error('흉내 낸 처리 오류');
          }
          return real.command(...args);
        },
      }),
    });
    manager = device(app.port);
    manager2 = device(app.port);
    counter = device(app.port);
    for (const [d, code, name] of /** @type {const} */ ([[manager, codes[0], '정하늘'], [manager2, codes[1], '정하늘'], [counter, codes[2], '김카운터']])) {
      assert.equal((await d.enroll(/** @type {string} */ (code))).status, 200);
      assert.equal((await d.login(name, /** @type {string} */ (shop.pins[name]))).status, 200);
    }
  });
  after(async () => { await app?.close(); });

  const head = async () => (await manager.get('/api/v2/head')).json();

  test('setting.set applies once: rev + 1, the rules read it back, the same request id returns the same result', async () => {
    const before = await head();
    const env = envelope(before, 'setting.set', refund('no_refund'));
    const first = await (await manager.command(env)).json();
    assert.equal(first.outcome, 'applied');
    assert.equal(first.rev, before.rev + 1);
    assert.equal(first.requestId, env.requestId);
    assert.equal((await head()).rev, before.rev + 1);
    const rules = await (await manager.query('shopRules', {})).json();
    const refundCard = rules.cards.find((/** @type {{ key: string }} */ c) => c.key === 'refund');
    assert.ok(refundCard.rows[0].options.some((/** @type {any} */ o) => o.key === 'no_refund' && o.selected));

    const again = await (await manager.command(env)).json();
    assert.deepEqual(again, first, 'a resend gets the stored result');
    assert.equal((await head()).rev, before.rev + 1, 'no new rev');
    const fromOther = await (await manager2.command(env)).json();
    assert.deepEqual(fromOther, first, 'from another device too');

    const changed = await (await manager.command({ ...env, payload: refund('refund') })).json();
    assert.equal(changed.idempotencyMismatch, true);
    assert.equal(changed.rev, first.rev);
    assert.equal((await head()).rev, before.rev + 1, 'the other body was not applied');
  });

  test('a counter lacks settings.manage: FORBIDDEN with the role line, final (a resend is the same)', async () => {
    const env = envelope(await head(), 'setting.set', refund('refund'));
    const out = await (await counter.command(env)).json();
    assert.equal(out.outcome, 'rejected');
    assert.deepEqual(out.error, { code: 'FORBIDDEN', message: '권한 없음 · 관리자 확인 필요' });
    assert.deepEqual(await (await counter.command(env)).json(), out);
    // 관리자가 같은 요청번호를 보내도 첫 결과(끝난 거절)다: 새 의도는 새 요청번호다
    assert.deepEqual(await (await manager.command(env)).json(), out);
  });

  test('a new order is saved in the shop file: the other device sees the team in its ledger (one ledger)', async () => {
    const draft = { channel: 'walk_in', leader: { name: '김민수', phone: '01000001234', party: 1 }, items: [{ productKey: 'ski', quantity: 1 }], pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' } };
    const sheet = await (await counter.query('checkoutSheet', { draft })).json();
    assert.equal(sheet.command?.type, 'order.create', 'the read model offers the command');
    const before = await head();
    const out = await (await counter.command(envelope(before, sheet.command.type, sheet.command.payload, { expect: sheet.expect }))).json();
    assert.equal(out.outcome, 'applied', JSON.stringify(out.error ?? null));
    assert.match(out.result.orderId, /^n\d{9}$/, 'the server order id comes from the receipt number');
    assert.equal((await head()).rev, before.rev + 1);
    const ledger = await (await manager.query('ledgerView', { viewKey: 'day_ledger' })).json();
    assert.ok(JSON.stringify(ledger).includes('김민수'), 'the manager on another device reads the same ledger');
    const slip = await (await manager2.query('orderSlip', { orderId: out.result.orderId })).json();
    assert.ok(JSON.stringify(slip).includes('김민수'));
  });

  test('two rules saves from the same basis: the second is a conflict (VERSION_CONFLICT), nothing applied', async () => {
    const basis = await head();
    // 앞 시험이 '환불 없음'으로 두었다: 첫 저장은 '환불'로 바꾸고, 같은 바탕에서 연 둘째 창의 저장은 충돌이다.
    const first = await (await manager.command(envelope(basis, 'setting.set', refund('refund')))).json();
    const second = await (await manager2.command(envelope(basis, 'setting.set', refund('no_refund')))).json();
    assert.deepEqual([first.outcome, second.outcome], ['applied', 'conflict']);
    assert.equal(second.error?.code, 'VERSION_CONFLICT');
    assert.equal((await head()).rev, basis.rev + 1);
  });

  test('a crash while handling: 500 INTERNAL, then the same request id applies exactly once', async () => {
    const before = await head();
    const env = envelope(before, 'setting.set', refund('no_refund'));
    crashNext = true;
    const crashed = await manager.command(env);
    assert.equal(crashed.status, 500);
    assert.deepEqual(await crashed.json(), { ok: false, service: 'skinote', code: 'INTERNAL' });
    const retried = await (await manager.command(env)).json();
    assert.equal(retried.outcome, 'applied');
    assert.equal(retried.rev, before.rev + 1);
    assert.deepEqual(await (await manager.command(env)).json(), retried);
    assert.equal((await head()).rev, before.rev + 1);
  });

  test('two writers at once: every command is applied in one line, revs never repeat', async () => {
    const before = await head();
    // 사실 명령(차량 현금 인계)은 같은 바탕이어도 충돌하지 않는다: 둘 다 모두 적용되고 rev는 한 줄로 선다.
    /** @type {Promise<Response>[]} */
    const sends = [];
    for (let i = 0; i < 10; i += 1) {
      sends.push(manager.command(envelope(before, 'cash.transfer', { vehicleId: 'v1', amount: 1000 + i })));
      sends.push(manager2.command(envelope(before, 'cash.transfer', { vehicleId: 'v2', amount: 2000 + i })));
    }
    const outcomes = await Promise.all(sends.map(async p => (await p).json()));
    const applied = outcomes.filter(o => o.outcome === 'applied');
    assert.equal(applied.length, 20, 'every command applied: ' + JSON.stringify(outcomes.filter(o => o.outcome !== 'applied')));
    const revs = applied.map(o => o.rev).sort((a, b) => a - b);
    assert.equal(new Set(revs).size, revs.length, 'no rev twice');
    assert.deepEqual(revs, revs.map((_, i) => before.rev + 1 + i), 'revs are consecutive');
    assert.equal((await head()).rev, before.rev + applied.length);

    const same = envelope(await head(), 'cash.transfer', { vehicleId: 'v1', amount: 3000 });
    const [x, y] = await Promise.all([manager.command(same), manager2.command(same)]);
    const [ox, oy] = [await x.json(), await y.json()];
    assert.deepEqual(ox, oy, 'the same request id from two devices at once: one result');
  });

  test('bad input never reaches the store: quantity over the shop limit, a wrong type, an unknown command', async () => {
    const basis = await head();
    const over = await counter.command(envelope(basis, 'stock.issue', { orderId: 'o1', lines: [{ lineId: 'o1-l1', quantity: 21 }] }));
    assert.equal(over.status, 400);
    assert.equal((await over.json()).code, 'BAD_INPUT');
    const wrong = await counter.command(envelope(basis, 'cash.transfer', { vehicleId: 'v1', amount: '1000' }));
    assert.equal((await wrong.json()).code, 'BAD_INPUT');
    const unknown = await counter.command(envelope(basis, 'shop.delete', {}));
    assert.equal((await unknown.json()).code, 'UNKNOWN_COMMAND');
    assert.equal((await head()).rev, basis.rev);
  });
});

describe('driver sessions and the vehicle rule (a fake store port with fixed scopes)', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let app;
  /** @type {ReturnType<typeof fakeShop>} */
  let fake;
  /** @type {ReturnType<typeof device>} */ let driver;
  /** @type {ReturnType<typeof device>} */ let counter;
  const basis = { epoch: 'E', rev: 0 };

  before(async () => {
    const dataDir = join(temp.dir, 'fake');
    const shop = await provisionedShop(dataDir);
    const codes = [await deviceCode(shop.env, ['--kind', 'driver_tablet', '--label', '1호차 태블릿', '--vehicle', 'v1']), await deviceCode(shop.env)];
    app = await startServer(testConfig(dataDir, shop.env), {
      log: () => {},
      shopPort: real => {
        fake = fakeShop(real, {
          // 업무 id의 끝이 차량(collect:o1:v2 → v2), 알림 id도 같은 모양(pin:v2)
          scopeOf: env => {
            const p = /** @type {Record<string, string>} */ (env.payload);
            const ref = p.taskId ?? p.notificationId ?? p.vehicleId ?? p.orderId ?? '';
            const vehicle = /(v\d)$/.exec(ref)?.[1];
            return vehicle ? { kind: 'vehicle', vehicleIds: [vehicle], ...(p.orderId ? { orderId: p.orderId } : {}) } : { kind: 'shop' };
          },
        });
        return fake;
      },
    });
    driver = device(app.port);
    counter = device(app.port);
    await driver.enroll(/** @type {string} */ (codes[0]));
    await counter.enroll(/** @type {string} */ (codes[1]));
    assert.equal((await driver.login('박기사', /** @type {string} */ (shop.pins['박기사']))).status, 200);
    assert.equal((await counter.login('김카운터', /** @type {string} */ (shop.pins['김카운터']))).status, 200);
  });
  after(async () => { await app?.close(); });

  /** @param {ReturnType<typeof device>} who @param {string} type @param {unknown} payload @param {Record<string, unknown>} [extra] */
  const send = async (who, type, payload, extra) => (await who.command(envelope(basis, type, payload, extra))).json();

  test('a driver cannot close the day: FORBIDDEN (the role has no closing.close)', async () => {
    const out = await send(driver, 'closing.close', { date: '2026-12-26', drawerCounts: [], deferredTransferIds: [] }, { expect: { expectedCash: { counter: 0 } } });
    assert.equal(out.outcome, 'rejected');
    assert.deepEqual(out.error, { code: 'FORBIDDEN', message: '권한 없음 · 관리자 확인 필요' });
  });

  test('a driver command on another vehicle\'s task is FORBIDDEN_SCOPE; on its own vehicle it goes through', async () => {
    const other = await send(driver, 'stock.collect', { taskId: 'collect:o1:v2', lines: [] });
    assert.deepEqual(other.error, { code: 'FORBIDDEN_SCOPE', message: '이 기기에서 사용 불가' });
    const own = await send(driver, 'stock.collect', { taskId: 'collect:o1:v1', lines: [] });
    assert.equal(own.outcome, 'applied');
    const shopWide = await send(driver, 'stock.issue', { orderId: 'o1', lines: [] });
    assert.equal(shopWide.error?.code, 'FORBIDDEN_SCOPE', 'a driver cannot issue at the counter');
    const call = fake.calls.find(c => c.envelope.type === 'stock.collect' && /** @type {any} */ (c.envelope.payload).taskId === 'collect:o1:v1');
    assert.ok(call);
    assert.equal(call.actor.vehicleId, 'v1');
    assert.equal(call.actor.roleKey, 'driver');
    assert.equal(call.actor.deviceId, driver.state.deviceId);
    assert.match(call.actor.key, /^staff:[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test('notification.ack of another vehicle\'s pin is FORBIDDEN_SCOPE; its own needs no permission', async () => {
    assert.equal((await send(driver, 'notification.ack', { notificationId: 'pin:v2' })).error?.code, 'FORBIDDEN_SCOPE');
    assert.equal((await send(driver, 'notification.ack', { notificationId: 'pin:v1' })).outcome, 'applied');
  });

  test('후불 처리 from the field: only for the task\'s own order with no other payer', async () => {
    assert.equal((await send(driver, 'payment_promise.set', { orderId: 'o7v1', payerOrderId: null })).outcome, 'applied');
    assert.equal((await send(driver, 'payment_promise.set', { orderId: 'o7v1', payerOrderId: 'o9' })).error?.code, 'FORBIDDEN_SCOPE');
    assert.equal((await send(driver, 'payment_promise.set', { orderId: 'o8v2', payerOrderId: null })).error?.code, 'FORBIDDEN_SCOPE');
  });

  test('counters have no vehicle rule; the driver role still lacks counter permissions', async () => {
    assert.equal((await send(counter, 'stock.collect', { taskId: 'collect:o1:v2', lines: [] })).outcome, 'applied');
    assert.equal((await send(counter, 'payment_promise.set', { orderId: 'o8v2', payerOrderId: 'o9' })).outcome, 'applied');
    assert.equal((await send(driver, 'payment.take', { orderIds: ['o1'], amount: 1000, methodKey: 'cash' }, { expect: { dueAmount: 1000 } })).error?.code, 'FORBIDDEN');
    assert.equal((await send(driver, 'cash.transfer', { vehicleId: 'v1', amount: 1000 })).outcome, 'applied');
    assert.equal((await send(driver, 'cash.transfer', { vehicleId: 'v2', amount: 1000 })).error?.code, 'FORBIDDEN_SCOPE');
  });
});

describe('driver sessions deny by default (commandGuard)', () => {
  const all = new Map([['settings.manage', 'shop'], ['payment.take', 'shop'], ['closing.close', 'shop'], ['stock.move', 'shop'], ['task.pin', 'shop'], ['order.create', 'shop']]);
  /** @param {string} type @param {unknown} payload */
  const env = (type, payload) => /** @type {any} */ ({ type, commandVersion: 1, requestId: newRequestId(), basis: { epoch: 'E', rev: 0 }, payload });
  test('a manager on a driver device: shop-wide money, closing, rules, pins and new orders are FORBIDDEN_SCOPE even with the permission', async () => {
    const { commandGuard } = await import('../src/permissions.js');
    const who = { roleKey: 'manager', deviceKind: /** @type {const} */ ('driver_tablet'), vehicleId: 'v1' };
    for (const [type, payload] of /** @type {[string, unknown][]} */ ([
      ['setting.set', { changes: [] }], ['payment.take', { orderIds: ['o1'], amount: 1, methodKey: 'cash' }], ['closing.close', { date: '2026-12-26', drawerCounts: [], deferredTransferIds: [] }],
      ['task.pin', { taskId: 'collect:o1' }], ['order.create', {}], ['stock.issue', { orderId: 'o1', lines: [] }],
    ])) {
      const out = commandGuard(who, all, env(type, payload))({ kind: 'shop' });
      assert.equal(out?.error?.code, 'FORBIDDEN_SCOPE', type);
    }
    assert.equal(commandGuard(who, all, env('stock.collect', { taskId: 'collect:o1', lines: [] }))({ kind: 'vehicle', vehicleIds: ['v1'] }), null, 'its own vehicle work goes through');
    assert.equal(commandGuard(who, all, env('stock.collect', { taskId: 'collect:o1', lines: [] }))({ kind: 'vehicle', vehicleIds: ['v2'] })?.error?.code, 'FORBIDDEN_SCOPE');
    const counterPos = { roleKey: 'manager', deviceKind: /** @type {const} */ ('pos') };
    assert.equal(commandGuard(counterPos, all, env('setting.set', { changes: [] }))({ kind: 'shop' }), null, 'the same person on the counter POS');
  });
});

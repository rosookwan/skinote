const { test } = require('node:test');
const assert = require('node:assert/strict');
const Finance = require('../src/workflows/finance.js');
const { createService } = require('../src/workflows/service.js');
const { createMemoryRepository } = require('../src/returns/service.js');
const { createSqliteRepository } = require('../server/returns-repository.cjs');
const { newCommand } = require('../src/workflows/client.js');
const { fixture, ctx, shop, errorCode } = require('./workflows-fixtures.cjs');

function order(f, id = 'group', amount = 100000) {
  f.call('order.create', { id, customer: { name: '대표자', phone: '010-1111-2222' }, people: [{ id: 'person-1', name: '일행' }],
    batch: { id: 'initial', lines: [{ id: 'ski-line', sku: 'ski', quantity: 1, personId: 'person-1',
      start: '2026-09-09', end: '2026-09-09', price: { unitWon: amount } }] } });
}
const raw = f => f.repository.workflows(ctx.shopId);
const balance = (f, id = 'group') => Finance.summary(raw(f), id);
function pay(f, id, amountWon, extra = {}) {
  return f.call('finance.payment', { id, orderId: 'group', kind: 'payment', amountWon, method: 'cash', ...extra });
}
const carry = (orderId = 'group') => ({ orderId, reason: 'awaiting_payment', assignee: '마감 담당', nextDate: '2026-09-10' });

for (const mode of ['memory', 'sqlite']) test(mode + ': payments, line refunds, deposits, duplicate requests and stale writers preserve independent ledgers', () => {
  const repository = mode === 'sqlite' ? createSqliteRepository(':memory:') : createMemoryRepository();
  try {
    const f = fixture(repository); order(f);
    const command = newCommand('finance.payment', f.store.snapshot(), { id: 'received', orderId: 'group', kind: 'payment', amountWon: 100000,
      method: 'card', externalReference: 'terminal-receipt-1', allocations: [{ lineId: 'ski-line', amountWon: 100000 }] });
    f.store.execute(command); assert.equal(f.store.execute(command).duplicate, true);
    assert.equal(raw(f).payments.length, 1);
    const stale = newCommand('finance.payment', f.store.snapshot(), { id: 'stale-refund', orderId: 'group', kind: 'refund', amountWon: 10000,
      method: 'card', reason: '일부 환불', allocations: [{ lineId: 'ski-line', amountWon: 10000 }] });
    pay(f, 'deposit', 30000, { kind: 'deposit_in' });
    assert.throws(() => f.store.execute(stale), errorCode('VERSION_CONFLICT'));
    f.call('finance.adjustment', { id: 'discount', orderId: 'group', amountWon: -10000, reason: '현장 합의 할인' });
    pay(f, 'refund', 10000, { kind: 'refund', method: 'card', reason: '할인 차액', allocations: [{ lineId: 'ski-line', amountWon: 10000 }] });
    pay(f, 'deposit-back', 10000, { kind: 'deposit_out', reason: '보증금 일부 반환' });
    const current = balance(f);
    assert.equal(current.chargedWon, 90000); assert.equal(current.netPaidWon, 90000); assert.equal(current.dueWon, 0);
    assert.equal(current.depositHeldWon, 20000); assert.equal(current.lines[0].netPaidWon, 90000);
    const before = f.store.snapshot();
    assert.throws(() => pay(f, 'too-much-refund', 90001, { kind: 'refund', reason: '금액 오류' }), errorCode('QUANTITY_EXCEEDED'));
    assert.throws(() => pay(f, 'too-much-deposit', 20001, { kind: 'deposit_out', reason: '금액 오류' }), errorCode('QUANTITY_EXCEEDED'));
    assert.throws(() => pay(f, 'repeat-terminal', 100000, { method: 'card', externalReference: 'terminal-receipt-1' }), errorCode('ALREADY_EXISTS'));
    assert.deepEqual(f.store.snapshot(), before);
    assert.deepEqual(raw(f).payments[0].allocations, command.payload.allocations);
    assert.equal(raw(f).assets.length, 0, 'money never creates physical equipment');
  } finally { repository.close?.(); }
});

test('line allocation is exact, refund cannot drain another line, and overpayment remains a separate credit', () => {
  const f = fixture(); order(f);
  f.call('order.add', { orderId: 'group', batch: { id: 'extra', lines: [{ id: 'helmet-line', sku: 'helmet', quantity: 1,
    start: '2026-09-09', end: '2026-09-09', price: { unitWon: 20000 } }] } });
  pay(f, 'first', 100000, { allocations: [{ lineId: 'ski-line', amountWon: 100000 }] });
  const before = raw(f);
  assert.throws(() => pay(f, 'bad-allocation', 20000, { allocations: [{ lineId: 'helmet-line', amountWon: 19999 }] }), errorCode('INVALID_INPUT'));
  assert.throws(() => pay(f, 'wrong-line-refund', 10000, { kind: 'refund', reason: '환불', allocations: [{ lineId: 'helmet-line', amountWon: 10000 }] }), errorCode('QUANTITY_EXCEEDED'));
  assert.throws(() => pay(f, 'unallocated-refund', 10000, { kind: 'refund', reason: '환불' }), errorCode('INVALID_INPUT'));
  assert.deepEqual(raw(f), before);
  pay(f, 'extra-paid', 30000, { payer: '추가 일행', allocations: [{ lineId: 'helmet-line', amountWon: 30000 }] });
  assert.equal(balance(f).dueWon, 0); assert.equal(balance(f).creditWon, 10000);
  assert.throws(() => pay(f, 'allocated-deposit', 5000, { kind: 'deposit_in', allocations: [{ lineId: 'ski-line', amountWon: 5000 }] }), errorCode('INVALID_INPUT'));
});

test('unallocated receipts can be partially refunded without assuming a terminal action', () => {
  const f = fixture(); order(f); pay(f, 'cash', 60000); pay(f, 'transfer', 40000, { method: 'transfer' });
  pay(f, 'partial', 15000, { kind: 'refund', reason: '합의한 일부 환불' });
  assert.equal(balance(f).netPaidWon, 85000); assert.equal(balance(f).dueWon, 15000);
  assert.equal(balance(f).payments.every(row => !Object.hasOwn(row, 'approved')), true);
  assert.throws(() => f.call('finance.delete', { id: 'cash' }), errorCode('INVALID_INPUT'));
});

test('return and unissued cancellation do not automatically refund money or offset deposits', () => {
  const f = fixture(); order(f); pay(f, 'deposit', 100000, { kind: 'deposit_in' });
  const ids = f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds;
  f.call('order.issue', { orderId: 'group', lineItems: [{ lineId: 'ski-line', assetIds: ids }] });
  f.move('directReturn', ids, { kind: 'customer', id: 'group' }, shop);
  assert.equal(balance(f).dueWon, 100000); assert.equal(balance(f).depositHeldWon, 100000);
  order(f, 'cancel-group', 20000);
  pay(f, 'cancel-paid', 20000, { orderId: 'cancel-group', allocations: [{ lineId: 'ski-line', amountWon: 20000 }] });
  f.call('order.cancel', { orderId: 'cancel-group', reason: '방문 전 취소' });
  assert.equal(balance(f, 'cancel-group').chargedWon, 0); assert.equal(balance(f, 'cancel-group').creditWon, 20000);
  assert.equal(balance(f, 'cancel-group').refundWon, 0);
});

test('closing follows the remaining equipment return date after a partial return and extension', () => {
  const f = fixture();
  f.call('order.create', { id: 'group', customer: { name: '단체', phone: '010-1111-2222' }, people: [],
    batch: { id: 'initial', lines: [{ id: 'ski-line', sku: 'ski', quantity: 2,
      start: '2026-09-09', end: '2026-09-09', price: { unitWon: 10000, basis: 'per_day' } }] } });
  const ids = f.call('stock.receive', { sku: 'ski', quantity: 2 }).assetIds;
  f.call('order.issue', { orderId: 'group', lineItems: [{ lineId: 'ski-line', assetIds: ids }] });
  f.move('directReturn', [ids[0]], { kind: 'customer', id: 'group' }, shop);
  f.call('ops.extend', { orderId: 'group', lineIds: ['ski-line'], end: '2026-09-10', amountWon: 10000, reason: '남은 한 벌 내일까지 이용' });
  const today = Finance.day(raw(f), '2026-09-09').handoverDefaults.find(row => row.orderId === 'group');
  assert.equal(today.returnPending, false);
  assert.deepEqual(today.issues, ['payment']);
  assert.equal(today.dueWon, 30000, 'remaining rental date never clears the unpaid balance');
  const tomorrow = Finance.day(raw(f), '2026-09-10').handoverDefaults.find(row => row.orderId === 'group');
  assert.equal(tomorrow.returnPending, true);
  assert.equal(tomorrow.customerQuantity, 1);
  assert.equal(raw(f).orders[0].lines[0].returnPlan.date, '2026-09-09', 'returned equipment keeps its original promise');
});

test('closing includes actual cash, keeps immutable snapshots, and next-day additions affect only their processing day', () => {
  const f = fixture(); order(f); pay(f, 'cash', 60000); pay(f, 'card', 40000, { method: 'card' }); pay(f, 'deposit', 30000, { kind: 'deposit_in' });
  f.call('finance.cash', { id: 'expense', kind: 'out', amountWon: 5000, reason: '청소용품 현금 구매' });
  const close = { id: 'day-1', date: '2026-09-09', openingCashWon: 100000, countedCashWon: 184000,
    handover: [{ ...carry(), reason: 'scheduled' }] };
  assert.throws(() => f.call('closing.close', close), errorCode('INVALID_INPUT'));
  f.call('closing.close', { ...close, differenceReason: '시재 차액 1천원 확인 중' });
  const stored = Finance.closings(raw(f))[0];
  assert.equal(stored.expectedCashWon, 185000); assert.equal(stored.differenceWon, -1000);
  assert.throws(() => pay(f, 'after-close', 1000), errorCode('CLOSING_LOCKED'));
  assert.throws(() => f.call('closing.close', { ...close, id: 'duplicate', differenceReason: '중복' }), errorCode('ALREADY_EXISTS'));
  f.setTime('2026-09-10T00:00:00.000Z');
  f.call('order.add', { orderId: 'group', batch: { id: 'tomorrow-extra', lines: [{ id: 'next-day', sku: 'ski', quantity: 1,
    start: '2026-09-10', end: '2026-09-10', price: { unitWon: 20000 } }] } });
  pay(f, 'next-day-paid', 20000, { allocations: [{ lineId: 'next-day', amountWon: 20000 }] });
  const next = Finance.day(raw(f), '2026-09-10');
  assert.equal(next.chargedWon, 20000); assert.equal(next.openingCashWon, 184000);
  assert.equal(next.handoverDefaults[0].carriedForward, true); assert.equal(next.handoverDefaults[0].assignee, '마감 담당');
  f.call('closing.close', { id: 'day-2', date: '2026-09-10', countedCashWon: 204000 });
  assert.deepEqual(Finance.closings(raw(f))[0], stored);
  assert.equal(balance(f).chargedWon, 120000); assert.equal(balance(f).depositHeldWon, 30000);
  assert.equal(Finance.day(raw(f), '2026-09-09').chargedWon, 100000);
});

test('new unresolved work requires a selected reason and owner while prior handover defaults carry forward', () => {
  const f = fixture(); order(f);
  assert.throws(() => f.call('closing.close', { id: 'missing-owner', date: '2026-09-09', countedCashWon: 0 }), errorCode('INVALID_INPUT'));
  f.call('closing.close', { id: 'first', date: '2026-09-09', countedCashWon: 0, handover: [carry()] });
  f.setTime('2026-09-10T00:00:00.000Z');
  const defaultRow = Finance.day(raw(f), '2026-09-10').handoverDefaults[0];
  assert.equal(defaultRow.reason, 'awaiting_payment'); assert.equal(defaultRow.nextDate, '2026-09-10');
  order(f, 'new-group');
  assert.throws(() => f.call('closing.close', { id: 'second', date: '2026-09-10', countedCashWon: 0 }), errorCode('INVALID_INPUT'));
  f.call('closing.close', { id: 'second', date: '2026-09-10', countedCashWon: 0, handover: [carry('new-group')] });
  assert.equal(Finance.closings(raw(f))[1].snapshot.handover.length, 2);
});

test('reopening needs a trusted capability and a reason; reclose appends a new snapshot', () => {
  const f = fixture(); order(f); pay(f, 'paid', 100000);
  f.call('closing.close', { id: 'first', date: '2026-09-09', countedCashWon: 100000 });
  const original = Finance.closings(raw(f))[0].snapshot;
  assert.throws(() => f.call('closing.reopen', { id: 'first', reason: '정정' }), errorCode('FORBIDDEN'));
  assert.throws(() => f.call('closing.reopen', { id: 'first', reason: '정정', permissions: ['closing.reopen'] }), errorCode('INVALID_INPUT'));
  const manager = createService(f.repository, { ...ctx, actor: { id: 'manager', role: 'store', permissions: ['closing.reopen'] } }, f.clock);
  assert.throws(() => f.call('closing.reopen', { id: 'first', reason: '' }, manager), errorCode('INVALID_INPUT'));
  f.call('closing.reopen', { id: 'first', reason: '누락 현금 수납 확인' }, manager);
  pay(f, 'extra-cash', 1000);
  f.call('closing.close', { id: 'second', date: '2026-09-09', countedCashWon: 101000, handover: [{ ...carry(), reason: 'awaiting_refund' }] });
  const closings = Finance.closings(raw(f));
  assert.equal(closings.length, 2); assert.equal(closings[0].reopenings[0].actor.id, 'manager');
  assert.deepEqual(closings[0].snapshot, original); assert.equal(closings[1].snapshot.paymentWon, 101000);
  f.setTime('2026-09-10T00:00:00.000Z');
  assert.throws(() => f.call('closing.reopen', { id: 'second', reason: '과거 수정' }, manager), errorCode('INVALID_INPUT'));
});

test('charge adjustments require an audit reason, cannot make the receipt negative, and drivers cannot write money', () => {
  const f = fixture(); order(f);
  const before = raw(f);
  assert.throws(() => f.call('finance.adjustment', { id: 'bad', orderId: 'group', amountWon: -100001, reason: '과다 할인' }), errorCode('INVALID_INPUT'));
  assert.throws(() => f.call('finance.adjustment', { id: 'no-reason', orderId: 'group', amountWon: -1000 }), errorCode('INVALID_INPUT'));
  assert.throws(() => f.call('finance.payment', { id: 'driver', orderId: 'group', kind: 'payment', amountWon: 1000, method: 'cash' }, f.driver), errorCode('FORBIDDEN'));
  assert.deepEqual(raw(f), before);
  f.call('finance.adjustment', { id: 'fee', orderId: 'group', lineId: 'ski-line', amountWon: 5000, reason: '확인한 추가 요금' });
  assert.equal(balance(f).chargedWon, 105000); assert.equal(balance(f).netPaidWon, 0);
});

test('legacy total-only pricing is counted once and never invents an initial payment', () => {
  const state = { orders: [{ id: 'legacy', createdAt: '2026-09-09T00:00:00.000Z', legacyChargeWon: 120000,
    batches: [{ id: 'imported', createdAt: '2026-09-09T00:00:00.000Z' }], lines: [{ id: 'legacy-line', batchId: 'imported', price: { amountWon: 0 } }] }] };
  Finance.initialize(state);
  const view = Finance.summary(state, 'legacy');
  assert.equal(view.chargedWon, 120000); assert.equal(view.paymentWon, 0); assert.equal(view.dueWon, 120000);
  assert.deepEqual(state.payments, []);
});

test('a later-added rental is not due just because an earlier line in the group has finished', () => {
  const f = fixture(); order(f); pay(f, 'first-payment', 100000);
  const first = f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds;
  f.call('order.issue', { orderId: 'group', lineItems: [{ lineId: 'ski-line', assetIds: first }] });
  f.move('directReturn', first, { kind: 'customer', id: 'group' }, shop);
  f.call('order.add', { orderId: 'group', batch: { id: 'late-return', lines: [{ id: 'tomorrow', sku: 'ski', quantity: 1,
    start: '2026-09-09', end: '2026-09-10', price: { unitWon: 10000 } }] } });
  pay(f, 'extra-payment', 20000);
  f.call('order.issue', { orderId: 'group', lineItems: [{ lineId: 'tomorrow', assetIds: first }] });
  assert.deepEqual(Finance.day(raw(f), '2026-09-09').handoverDefaults, []);
  f.call('closing.close', { id: 'today', date: '2026-09-09', countedCashWon: 120000 });
  f.setTime('2026-09-10T00:00:00.000Z');
  const defaults = Finance.day(raw(f), '2026-09-10').handoverDefaults;
  assert.deepEqual(defaults[0].issues, ['return:tomorrow']); assert.equal(defaults[0].customerQuantity, 1);
  assert.equal(defaults[0].reason, null);
});

test('closing snapshots explicit partner obligations and unallocated money without repeating customer handover or changing cash', () => {
  const f = fixture();
  f.call('partner.save', { id: 'neighbor', name: '옆 매장', phone: '010-2222-3333' });
  f.call('partner.borrow', { id: 'borrow', partnerId: 'neighbor', sku: 'ski', quantity: 2, dueDate: '2026-09-10' });
  f.call('partner.agreement', { id: 'payable', partnerId: 'neighbor', kind: 'payable', amountWon: 30000, reason: '차입 약정' });
  f.call('partner.agreement', { id: 'receivable', partnerId: 'neighbor', kind: 'receivable', amountWon: 20000, reason: '대여 약정' });
  f.call('partner.offset', { id: 'offset', partnerId: 'neighbor', receivableId: 'receivable', payableId: 'payable', amountWon: 5000, reason: '명시 합의' });
  f.call('partner.money', { id: 'unallocated', partnerId: 'neighbor', kind: 'payment', amountWon: 3000, method: 'cash', reason: '약정 미배분 지급' });
  const before = f.store.snapshot().finance;
  assert.equal(before.partnerBalances[0].payableWon, 25000); assert.equal(before.partnerBalances[0].receivableWon, 15000); assert.equal(before.partnerBalances[0].unallocatedPaymentWon, 3000); assert.equal(before.partnerBalances[0].borrowedPendingQuantity, 2);
  f.call('closing.close', { id: 'close-partner', date: '2026-09-09', openingCashWon: 10000, countedCashWon: 7000 });
  const closed = structuredClone(raw(f).closings[0]); assert.deepEqual(closed.snapshot.partnerBalances, before.partnerBalances); assert.deepEqual(closed.snapshot.handover, []); assert.equal(closed.expectedCashWon, 7000);
  f.setTime('2026-09-10T00:00:00.000Z');
  f.call('partner.money', { id: 'tomorrow-paid', partnerId: 'neighbor', kind: 'payment', amountWon: 10000, method: 'transfer', agreementId: 'payable', reason: '다음날 실제 지급' });
  assert.equal(f.store.snapshot().finance.partnerBalances[0].payableWon, 15000); assert.deepEqual(raw(f).closings[0], closed);
});

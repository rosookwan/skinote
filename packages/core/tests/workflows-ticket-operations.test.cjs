const { test } = require('node:test');
const assert = require('node:assert/strict');
const Domain = require('../src/workflows/domain.js');
const Tickets = require('../src/workflows/ticket-operations.js');
const Orders = require('../src/workflows/orders.js');
const Reservations = require('../src/workflows/reservations.js');
const Finance = require('../src/workflows/finance.js');
const context = { shopId: 'shop-1', actor: { id: 'store', role: 'store' }, at: '2026-09-13T00:00:00.000Z' };
const customer = { name: '검증 고객', phone: '010-1234-5678' }, shop = { kind: 'shop', id: 'shop-1' };
const ticket = { validFrom: '2026-09-13T00:00:00.000Z', validTo: '2026-09-13T09:00:00.000Z', acceptedTypes: ['ticket-4h'], transferable: true, vendorId: 'resort-1' };
const copy = value => JSON.parse(JSON.stringify(value));
function fixture() {
  let state = Domain.fresh('shop-1'), n = 0;
  const call = (type, payload, actor = context, requestId = 'request-' + ++n) => { const executed = Domain.execute(state, { type, payload, requestId, expectedVersion: state.revision }, actor); state = executed.state; return executed.result; };
  const order = (id = 'old', extra = {}) => call('order.create', { id, customer, batch: { id: 'first', lines: [{ id: 'lift', sku: 'ticket-4h', quantity: 2, start: '2026-09-13', end: '2026-09-13', price: { unitWon: 45000 }, ...extra }] } });
  order(); order('next');
  const issue = (quantity = 1, conditions = {}) => call('ops.ticketIssue', { orderId: 'old', lineId: 'lift', quantity, ticket: { ...ticket, ...conditions } });
  const handover = ids => call('ops.issue', { orderId: 'old', lineItems: [{ lineId: 'lift', assetIds: ids }] });
  const collect = (ids, vehicleId = 'van-1') => call('ops.return', { orderId: 'old', lineItems: [{ lineId: 'lift', assetIds: ids }], mode: 'collect', vehicleId });
  const direct = ids => call('ops.return', { orderId: 'old', lineItems: [{ lineId: 'lift', assetIds: ids }], mode: 'direct' });
  return { call, order, issue, handover, collect, direct, get state() { return state; } };
}
const assignment = assetIds => ({ orderId: 'next', lineId: 'lift', assetIds, startTime: '13:00', endTime: '17:00' });
const refund = assetIds => ({ id: 'refund-1', assetIds, vehicleId: 'van-1', vendorId: 'resort-1', date: '2026-09-13', time: '17:00', place: '발권처' });
function rejected(f, type, payload, code, actor) { const before = copy(f.state); assert.throws(() => f.call(type, payload, actor), error => error.code === code); assert.deepEqual(f.state, before); }

test('returned ticket binds one exact new sale row with demand; old fulfilled demand, custody and money remain intact', () => {
  const f = fixture(), { assetIds } = f.issue(); f.handover(assetIds); f.direct(assetIds);
  const before = copy(f.state), old = Orders.view(f.state, 'old'); const result = f.call('tickets.assign', assignment(assetIds));
  assert.equal(result.assignedQuantity, 1); assert.equal(result.movedQuantity, 0); assert.deepEqual(Orders.view(f.state, 'old'), old);
  assert.equal(f.state.allocations.length, 2); assert.deepEqual(f.state.allocations[0], before.allocations[0]); assert.equal(f.state.allocations[1].reservationId, 'next');
  assert.equal(f.state.orders[1].lines[0].reservationBindings[0].lineId, result.reservationLineId);
  assert.deepEqual(f.state.movements, before.movements); assert.deepEqual(Finance.summary(f.state, 'next'), Finance.summary(before, 'next'));
  const summary = Reservations.summary(f.state, { date: '2026-09-13' }); assert.equal(summary.totals.find(t => t.ticketType === 'ticket-4h').needIssue, 0);
  f.call('ops.issue', { orderId: 'next', lineItems: [{ lineId: 'lift', assetIds }] }); assert.equal(f.state.assets[0].location.id, 'next'); assert.equal(Orders.view(f.state, 'next').lines[0].issuedQuantity, 1);
});

test('vehicle recovery requires actual receiving; receiving groups real vehicles and preserves unrelated stock', () => {
  const f = fixture(), { assetIds } = f.issue(2); f.handover(assetIds); f.collect([assetIds[0]]); f.collect([assetIds[1]], 'van-2');
  rejected(f, 'tickets.assign', assignment(assetIds), 'DEPENDENT_MOVEMENT');
  const other = f.call('stock.opening', { sku: 'ticket-4h', quantity: 1, location: { kind: 'vehicle', id: 'van-3' }, ticket }).assetIds[0];
  const before = copy(f.state.assets.find(a => a.id === other)); const result = f.call('tickets.receive', { assetIds });
  assert.equal(result.movementIds.length, 2); assert.ok(f.state.assets.filter(a => assetIds.includes(a.id)).every(a => a.location.kind === 'shop')); assert.deepEqual(f.state.assets.find(a => a.id === other), before);
  f.call('tickets.assign', assignment(assetIds));
});

test('reassignment rejects expired, incompatible time, nontransferable, duplicate demand, wrong row, lost and foreign reservations atomically', () => {
  for (const condition of ['expired', 'time', 'nontransferable', 'duplicate', 'wrong-row', 'lost', 'foreign']) {
    const f = fixture(), { assetIds } = f.issue(1, { transferable: condition !== 'nontransferable' }); f.handover(assetIds); f.direct(assetIds);
    let payload = assignment(assetIds), actor = context, expected = 'TICKET_UNAVAILABLE';
    if (condition === 'expired') actor = { ...context, at: '2026-09-13T10:00:00.000Z' };
    if (condition === 'time') payload.endTime = '19:00';
    if (condition === 'duplicate') f.call('tickets.assign', payload);
    if (condition === 'wrong-row') { payload.lineId = 'wrong'; expected = 'NOT_FOUND'; }
    if (condition === 'lost') f.state.assets[0].condition = 'lost';
    if (condition === 'foreign') { f.call('reservation.create', { id: 'next', orderId: 'other', customer, lines: [{ id: 'foreign', ticketType: 'ticket-4h', quantity: 1, useDate: '2026-09-13' }] }); expected = 'ALREADY_EXISTS'; }
    rejected(f, 'tickets.assign', payload, expected, actor);
  }
});

test('spare and refund cannot steal any unfulfilled reservation even in a different time window', () => {
  const f = fixture(), { assetIds } = f.issue();
  for (const [type, payload] of [['tickets.spare', { assetIds }], ['tickets.refundDispatch', refund(assetIds)]]) rejected(f, type, payload, 'TICKET_UNAVAILABLE');
  f.call('ops.cancelTicket', { orderId: 'old', lineId: 'lift', reason: '일행 미도착' });
  f.state.assets[0].purpose = 'delivery'; const before = copy(f.state.movements); f.call('tickets.spare', { assetIds });
  assert.equal(f.state.assets[0].purpose, 'spare'); assert.deepEqual(f.state.movements, before);
});

test('actual refund plan and load commit together, preserve stock identity and defer every money event until vendor confirmation', () => {
  const f = fixture(), { assetIds } = f.issue(); f.handover(assetIds); f.direct(assetIds);
  const before = copy(f.state), result = f.call('tickets.refundDispatch', refund(assetIds));
  assert.equal(result.loadedQuantity, 1); assert.equal(result.refundedWon, 0); assert.equal(f.state.assets.length, before.assets.length); assert.equal(f.state.assets[0].location.id, 'van-1'); assert.equal(f.state.assets[0].purpose, 'refund');
  assert.equal(f.state.refunds[0].attempts.length, 0); assert.deepEqual(Finance.summary(f.state, 'old'), Finance.summary(before, 'old'));
  f.call('refund.complete', { id: result.refundId, assetIds, amountWon: 35000 }); assert.equal(f.state.assets[0].location.kind, 'vendor'); assert.equal(Finance.summary(f.state, 'old').refundWon, 0);
});

test('refund rejects another vehicle, wrong vendor, pending delivery and late failure without creating a plan or movement', () => {
  for (const condition of ['vehicle', 'vendor', 'delivery', 'date']) {
    const f = fixture(), { assetIds } = f.issue();
    if (condition === 'delivery') f.call('ops.dispatch', { orderId: 'old', id: 'trip', lineItems: [{ lineId: 'lift', assetIds }], vehicleId: 'van-1', date: '2026-09-13', time: '10:00', place: '숙소' });
    else { f.handover(assetIds); if (condition === 'vehicle') f.collect(assetIds, 'van-2'); else f.direct(assetIds); }
    const payload = refund(assetIds); if (condition === 'vendor') payload.vendorId = 'wrong'; if (condition === 'date') payload.date = 'invalid';
    rejected(f, 'tickets.refundDispatch', payload, condition === 'vehicle' ? 'DEPENDENT_MOVEMENT' : condition === 'date' ? 'INVALID_INPUT' : 'TICKET_UNAVAILABLE');
  }
});

test('tickets commands enforce store role and stale revisions; duplicate retry performs no second allocation', () => {
  const f = fixture(), { assetIds } = f.issue(); f.handover(assetIds); f.direct(assetIds);
  rejected(f, 'tickets.assign', assignment(assetIds), 'FORBIDDEN', { ...context, actor: { id: 'driver', role: 'driver', vehicleId: 'van-1' } });
  const before = copy(f.state), cmd = { type: 'tickets.assign', payload: assignment(assetIds), requestId: 'unique', expectedVersion: before.revision };
  const first = Domain.execute(before, cmd, context), duplicate = Domain.execute(first.state, cmd, context);
  assert.deepEqual(duplicate.state, first.state); assert.equal(duplicate.duplicate, true);
  assert.throws(() => Domain.execute(first.state, { ...cmd, requestId: 'stale' }, context), e => e.code === 'VERSION_CONFLICT');
  assert.equal(Tickets.commands.length, 4); assert.equal(Tickets.canHandle('ticket.issue'), false);
});

test('reuse cannot issue the same physical ticket twice to the same sale row and nontransferable opening custody cannot change customers', () => {
  const f = fixture(), { assetIds } = f.issue(); f.handover(assetIds); f.direct(assetIds);
  rejected(f, 'tickets.assign', { ...assignment(assetIds), orderId: 'old' }, 'INVALID_INPUT');
  const opening = f.call('stock.opening', { sku: 'ticket-4h', quantity: 1, ticket: { ...ticket, transferable: false }, location: { kind: 'customer', id: 'old' } });
  f.call('stock.move', { kind: 'directReturn', assetIds: opening.assetIds, from: { kind: 'customer', id: 'old' }, to: shop });
  rejected(f, 'tickets.assign', assignment(opening.assetIds), 'TICKET_UNAVAILABLE');
});

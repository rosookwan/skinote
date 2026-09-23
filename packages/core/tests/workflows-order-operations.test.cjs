const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Ops = require('../src/workflows/order-operations.js');
const Orders = require('../src/workflows/orders.js');
const Inventory = require('../src/workflows/inventory.js');
const Dispatch = require('../src/workflows/dispatch.js');
const Finance = require('../src/workflows/finance.js');
const Exchanges = require('../src/workflows/exchanges.js');
const Reservations = require('../src/workflows/reservations.js');
const Domain = require('../src/workflows/domain.js');

const copy = value => JSON.parse(JSON.stringify(value));
const context = { shopId: 'shop-1', actor: { id: 'store-1', role: 'store' }, at: '2026-09-13T00:00:00.000Z' };
const driver = { ...context, actor: { id: 'driver-1', role: 'driver', vehicleId: 'van-1' } };
const shop = { kind: 'shop', id: 'shop-1' }, van = { kind: 'vehicle', id: 'van-1' };
const customer = { name: '김민수', phone: '010-1234-5678' };
const code = expected => error => error.code === expected;
const line = (overrides = {}) => ({ id: 'ski-line', sku: 'ski', quantity: 3, start: '2026-09-13', end: '2026-09-14', price: { unitWon: 20000 }, ...overrides });
const items = (assetIds, lineId = 'ski-line') => [{ lineId, assetIds }];
const orderPayload = (lines = [line()], id = 'receipt-1') => ({ id, customer, batch: { id: 'first', lines } });
const ticket = { validFrom: '2026-09-13T00:00:00.000Z', validTo: '2026-09-13T04:00:00.000Z', acceptedTypes: ['ticket-4h'], transferable: true, vendorId: 'resort-1' };
function fixture(lines = [line()]) {
  let state = Domain.fresh('shop-1');
  function call(type, payload, actor = context) {
    const next = copy(state);
    const module = Ops.canHandle(type) ? Ops : type.startsWith('order.') ? Orders : type.startsWith('task.') ? Dispatch : type.startsWith('exchange.') ? Exchanges : type.startsWith('reservation.') || ['ticket.allocate', 'ticket.release'].includes(type) ? Reservations : type.startsWith('finance.') || type.startsWith('closing.') ? Finance : Inventory;
    if (type === 'stock.move') Exchanges.beforeMove(next, payload, actor);
    const result = module.handle(next, type, payload, actor);
    if (type === 'stock.move') Exchanges.afterMove(next, result, actor);
    next.revision++; state = next; return result;
  }
  call('order.create', orderPayload(lines));
  return { call, get state() { return state; }, order: (id = 'receipt-1') => Orders.view(state, id),
    stock: (quantity = 3, sku = 'ski') => call('stock.receive', { sku, quantity }).assetIds,
    issue: assetIds => call('ops.issue', { orderId: 'receipt-1', lineItems: items(assetIds) }),
    dispatch: (assetIds, extra = {}) => call('ops.dispatch', { id: 'trip-1', orderId: 'receipt-1', lineItems: items(assetIds), vehicleId: 'van-1', date: '2026-09-13', time: '10:00', place: '숙소', ...extra }),
    collect: (assetIds, vehicleId = 'van-1') => call('ops.return', { orderId: 'receipt-1', lineItems: items(assetIds), mode: 'collect', vehicleId }) };
}

test('direct partial return and zero receipt preserve issue history, charge and all other rows', () => {
  const f = fixture([line(), line({ id: 'late', quantity: 1, start: '2026-09-14' })]), ids = f.stock(); f.issue(ids);
  const price = copy(f.order().lines[0].price), late = copy(f.order().lines[1]), count = f.state.movements.length;
  const zero = f.call('ops.return', { orderId: 'receipt-1', lineItems: items([]), mode: 'direct' });
  assert.equal(zero.receivedQuantity, 0); assert.equal(f.state.movements.length, count);
  const result = f.call('ops.return', { orderId: 'receipt-1', lineItems: items([ids[1]]), mode: 'direct' });
  assert.equal(result.receivedQuantity, 1); assert.equal(f.order().lines[0].issuedQuantity, 3);
  assert.deepEqual(f.order().lines[0].customerAssetIds, [ids[0], ids[2]]); assert.deepEqual(f.order().lines[0].shopAssetIds, [ids[1]]);
  assert.deepEqual(f.order().lines[0].price, price); assert.deepEqual(f.order().lines[1], late); assert.equal(f.order().amountWon, 140000);
  assert.equal(f.state.movements.at(-1).orderId, 'receipt-1'); assert.deepEqual(f.state.movements.at(-1).lineItems, items([ids[1]]));
  assert.throws(() => f.call('ops.return', { orderId: 'receipt-1', lineItems: items([ids[1]]), mode: 'direct' }), code('QUANTITY_EXCEEDED'));
});

test('collection and actual multi-vehicle receiving use separate movements and never collect another order', () => {
  const f = fixture(), ids = f.stock(); f.issue(ids); f.collect([ids[0]]); f.collect([ids[1]], 'van-2');
  const before = copy(f.state);
  assert.throws(() => f.call('ops.receive', { orderId: 'receipt-1', assetIds: [ids[0], ids[2]] }), code('QUANTITY_EXCEEDED')); assert.deepEqual(f.state, before);
  const result = f.call('ops.receive', { orderId: 'receipt-1', assetIds: [ids[0], ids[1]] });
  assert.deepEqual(result.vehicleIds, ['van-1', 'van-2']); assert.equal(result.movementIds.length, 2); assert.equal(result.receivedQuantity, 2);
  assert.deepEqual(f.order().lines[0].customerAssetIds, [ids[2]]); assert.deepEqual(f.order().lines[0].vehicleAssetIds, []); assert.equal(f.order().lines[0].issuedQuantity, 3);
  assert.equal(f.call('ops.receive', { orderId: 'receipt-1', assetIds: [] }).receivedQuantity, 0);
});

test('initial migrated custody can be received, and reused assets cannot satisfy old return obligations again', () => {
  const f = fixture([line({ quantity: 1 })]), [id] = f.call('stock.opening', { sku: 'ski', quantity: 1, location: van }).assetIds;
  f.state.orders[0].lines[0].initialAssetIds = [id]; f.state.assets[0].vehicleOrigin = 'customer';
  f.call('ops.receive', { orderId: 'receipt-1', assetIds: [id] });
  f.call('order.add', { orderId: 'receipt-1', batch: { id: 'late', lines: [line({ id: 'late', quantity: 1 })] } });
  f.call('ops.issue', { orderId: 'receipt-1', lineItems: items([id], 'late') });
  assert.equal(f.order().lines[0].shopQuantity, 1); assert.equal(f.order().lines[1].customerQuantity, 1);
  assert.throws(() => f.call('ops.return', { orderId: 'receipt-1', lineItems: items([id]), mode: 'direct' }), code('QUANTITY_EXCEEDED'));
  f.call('ops.return', { orderId: 'receipt-1', lineItems: items([id], 'late'), mode: 'direct' });
  assert.deepEqual(f.order().lines.map(row => row.shopQuantity), [1, 1]);
});

test('driver collection requires the correct active order task and vehicle; loss requires explicit recovery', () => {
  const f = fixture(), ids = f.stock(); f.issue(ids);
  const payload = { orderId: 'receipt-1', lineItems: items([ids[0]]), mode: 'collect', vehicleId: 'van-1' };
  assert.throws(() => f.call('ops.return', payload, driver), code('FORBIDDEN'));
  const plan = f.call('ops.schedule', { orderId: 'receipt-1', lineItems: items(ids), vehicleId: 'van-1', date: '2026-09-14', time: '17:00', place: '숙소' });
  assert.throws(() => f.call('ops.return', { ...payload, taskId: plan.taskId, vehicleId: 'van-2' }, driver), code('FORBIDDEN'));
  assert.throws(() => f.call('ops.return', { ...payload, taskId: plan.taskId, mode: 'direct' }, driver), code('FORBIDDEN'));
  f.call('ops.return', { ...payload, taskId: plan.taskId }, driver);
  assert.equal(f.state.tasks[0].status, 'waiting');
  f.state.assets.find(a => a.id === ids[1]).condition = 'lost';
  assert.throws(() => f.call('ops.return', { orderId: 'receipt-1', lineItems: items([ids[1]]), mode: 'direct' }), code('INVALID_INPUT'));
  f.state.assets.find(a => a.id === ids[0]).condition = 'lost';
  assert.throws(() => f.call('ops.receive', { orderId: 'receipt-1', assetIds: [ids[0]] }), code('INVALID_INPUT'));
});

test('partial dispatch reserves capacity without issuing; split deliveries cannot overbook or bypass reservations', () => {
  const f = fixture(), ids = f.stock(5); f.dispatch(ids.slice(0, 2));
  assert.equal(f.order().lines[0].issuedQuantity, 0); assert.equal(f.order().lines[0].unissuedQuantity, 3);
  assert.equal(f.state.movements.at(-1).taskId, null); assert.equal(f.state.movements.at(-1).allocationTaskId, 'trip-1');
  assert.equal(Dispatch.fulfilled(f.state, f.state.tasks[0], ids[0]), false);
  const before = copy(f.state);
  assert.throws(() => f.dispatch(ids.slice(2, 4), { id: 'trip-2', vehicleId: 'van-2' }), code('QUANTITY_EXCEEDED')); assert.deepEqual(f.state, before);
  assert.throws(() => f.issue(ids.slice(2, 4)), code('QUANTITY_EXCEEDED'));
  f.dispatch([ids[2]], { id: 'trip-2', vehicleId: 'van-2' });
  f.call('ops.deliver', { orderId: 'receipt-1', taskId: 'trip-1', lineItems: items([ids[0]]) }, driver);
  assert.equal(f.order().lines[0].issuedQuantity, 1); assert.equal(f.state.tasks[0].status, 'waiting');
  assert.throws(() => f.call('ops.deliver', { orderId: 'receipt-1', taskId: 'trip-2', lineItems: items([ids[2]]) }, driver), code('FORBIDDEN'));
  f.call('ops.deliver', { orderId: 'receipt-1', taskId: 'trip-1', lineItems: items([ids[1]]) }, driver);
  assert.equal(f.state.tasks[0].status, 'completed'); assert.equal(f.order().lines[0].issuedQuantity, 2);
});

test('partly delivered trip cancellation unloads only undelivered stock and allows a later dispatch', () => {
  const f = fixture(), ids = f.stock(); f.dispatch(ids);
  f.call('ops.deliver', { orderId: 'receipt-1', taskId: 'trip-1', lineItems: items([ids[0]]) }, driver);
  const result = f.call('ops.deliveryCancel', { taskId: 'trip-1', reason: '일행이 직접 방문', unload: true });
  assert.equal(result.unloadedQuantity, 2); assert.equal(result.releasedQuantity, 2); assert.equal(f.state.tasks[0].status, 'cancelled');
  assert.deepEqual(f.state.assets[0].location, { kind: 'customer', id: 'receipt-1' }); assert.deepEqual(f.state.assets[1].location, shop);
  assert.equal(f.order().lines[0].issuedQuantity, 1); assert.deepEqual(f.state.tasks[0].cancellation.undeliveredAssetIds, ids.slice(1));
  f.dispatch(ids.slice(1), { id: 'trip-2' });
  f.call('ops.deliver', { orderId: 'receipt-1', taskId: 'trip-2', lineItems: items(ids.slice(1)) }, driver);
  assert.equal(f.order().lines[0].issuedQuantity, 3); assert.equal(f.state.tasks[1].status, 'completed');
});

test('cancellation validates all physical locations before unloading and leaves the task intact on failure', () => {
  const f = fixture(), ids = f.stock(); f.dispatch(ids); f.state.assets[2].location = { kind: 'vehicle', id: 'van-2' }; const before = copy(f.state);
  assert.throws(() => f.call('ops.deliveryCancel', { taskId: 'trip-1', reason: '취소', unload: true }), code('DEPENDENT_MOVEMENT')); assert.deepEqual(f.state, before);
  assert.throws(() => f.call('ops.deliveryCancel', { taskId: 'trip-1', reason: '취소', unload: false }), code('INVALID_INPUT'));
  assert.throws(() => f.call('ops.deliveryCancel', { taskId: 'trip-1', reason: '취소', unload: true }, driver), code('FORBIDDEN'));
});

test('moving one collection appointment preserves other assets and records the previous assignment', () => {
  const f = fixture(), ids = f.stock(); f.issue(ids);
  const schedule = assetIds => f.call('ops.schedule', { orderId: 'receipt-1', lineItems: items(assetIds), date: '2026-09-14', time: '17:00', place: '스키장', vehicleId: 'van-1' });
  const first = schedule(ids), before = copy(f.state.movements), money = f.order().amountWon, second = schedule([ids[0]]);
  assert.notEqual(first.taskId, second.taskId); assert.deepEqual(f.state.tasks[0].assetIds, ids.slice(1));
  assert.deepEqual(f.state.tasks[0].reassignments[0].beforeAssetIds, ids); assert.deepEqual(f.state.movements, before); assert.equal(f.order().amountWon, money);
  f.call('ops.return', { orderId: 'receipt-1', lineItems: items([ids[0]]), mode: 'direct' });
  assert.equal(f.state.tasks[1].status, 'completed'); assert.equal(f.state.tasks[0].status, 'waiting');
  assert.throws(() => schedule([ids[0]]), code('QUANTITY_EXCEEDED'));
});

test('unsuccessful visit records zero movement and reschedules only the remaining work', () => {
  const f = fixture(), ids = f.stock(); f.dispatch(ids);
  f.call('ops.deliver', { orderId: 'receipt-1', taskId: 'trip-1', lineItems: items([ids[0]]) }, driver);
  const before = copy(f.state.movements), result = f.call('ops.visit', { taskId: 'trip-1', result: 'absent', nextDate: '2026-09-13', nextTime: '11:00', place: '새 숙소' }, driver);
  assert.equal(result.movedQuantity, 0); assert.deepEqual(f.state.movements, before); assert.equal(f.state.tasks[0].time, '11:00');
  assert.deepEqual(f.state.tasks[0].visits[0].remainingAssetIds, ids.slice(1)); assert.equal(f.state.tasks[0].visits[0].before.place, '숙소');
  assert.throws(() => f.call('ops.visit', { taskId: 'trip-1', result: 'none', nextDate: '2026-09-12', nextTime: '11:00', place: '숙소', reason: '확인' }, driver), code('INVALID_INPUT'));
  assert.throws(() => f.call('ops.visit', { taskId: 'trip-1', result: 'none', nextDate: '2026-09-14', nextTime: '11:00', place: '숙소' }, driver), code('INVALID_INPUT'));
});

test('native extension preserves original price and other batches, validates the extra charge and moves the return schedule', () => {
  const f = fixture([line(), line({ id: 'late', quantity: 1 })]), ids = f.stock(); f.issue(ids);
  f.call('ops.schedule', { orderId: 'receipt-1', lineItems: items(ids), date: '2026-09-14', time: '17:00', place: '스키장', vehicleId: 'van-1' });
  const before = copy(f.state), price = copy(f.order().lines[0].price), late = copy(f.order().lines[1]);
  const payload = { orderId: 'receipt-1', lineIds: ['ski-line'], end: '2026-09-16', amountWon: 120000, reason: '2일 추가 이용' };
  assert.throws(() => f.call('ops.extend', { ...payload, amountWon: 119999 }), code('INVALID_INPUT')); assert.deepEqual(f.state, before);
  const result = f.call('ops.extend', payload);
  assert.equal(result.amountWon, 120000); assert.deepEqual(f.order().lines[0].price, price); assert.deepEqual(f.order().lines[1], late);
  assert.equal(f.order().lines[0].end, '2026-09-16'); assert.equal(f.order().lines[0].returnPlan.date, '2026-09-16');
  assert.equal(f.state.tasks[0].status, 'cancelled'); assert.equal(f.state.tasks[1].date, '2026-09-16');
  assert.equal(Finance.summary(f.state, 'receipt-1').chargedWon, 280000); assert.equal(f.state.orders[0].extensions[0].changes[0].beforeEnd, '2026-09-14');
});

test('extension rejects excess whole-row pricing after partial return, unknown initial history and closed-day charges atomically', () => {
  const f = fixture(), ids = f.stock(); f.issue(ids);
  f.call('ops.return', { orderId: 'receipt-1', lineItems: items([ids[0]]), mode: 'direct' });
  const payload = { orderId: 'receipt-1', lineIds: ['ski-line'], end: '2026-09-15', amountWon: 60000, reason: '연장' };
  assert.throws(() => f.call('ops.extend', payload), code('INVALID_INPUT'));
  const legacy = fixture(); legacy.state.orders[0].lines[0].initialNonReturnQuantity = 1; assert.throws(() => legacy.call('ops.extend', payload), code('NO_CHANGE'));
  const closed = fixture(); closed.state.closings = [{ id: 'closed', date: '2026-09-13', reopenings: [] }]; const before = copy(closed.state);
  assert.throws(() => closed.call('ops.extend', payload), code('CLOSING_LOCKED')); assert.deepEqual(closed.state, before);
});

test('ticket issuing links the selected sales line, creates no delivery and rejects quantity or validity overflow atomically', () => {
  const f = fixture([line({ id: 'lift', sku: 'ticket-4h', quantity: 2, end: '2026-09-13', price: { unitWon: 45000 } })]);
  const payload = { orderId: 'receipt-1', lineId: 'lift', quantity: 1, ticket };
  const result = f.call('ops.ticketIssue', payload);
  assert.equal(result.assetIds.length, 1); assert.equal(f.order().lines[0].issuedQuantity, 0); assert.equal(f.state.reservations[0].id, 'receipt-1');
  assert.equal(f.state.reservations[0].orderId, 'receipt-1'); assert.equal(f.state.orders[0].lines[0].reservationBindings[0].lineId, result.reservationLineId);
  const before = copy(f.state);
  assert.throws(() => f.call('ops.ticketIssue', { ...payload, quantity: 2 }), code('QUANTITY_EXCEEDED')); assert.deepEqual(f.state, before);
  assert.throws(() => f.call('ops.ticketIssue', { ...payload, startTime: '08:00', endTime: '13:00' }), code('TICKET_UNAVAILABLE')); assert.deepEqual(f.state, before);
  f.call('ops.ticketIssue', payload); assert.equal(f.state.reservations[0].lines.length, 2);
});

test('direct equipment and ticket handover is one atomic command and validates the ticket sales-line binding', () => {
  const f = fixture([line({ quantity: 1 }), line({ id: 'lift', sku: 'ticket-4h', quantity: 1, end: '2026-09-13', price: { unitWon: 45000 } })]);
  const equipment = f.stock(1), issued = f.call('ops.ticketIssue', { orderId: 'receipt-1', lineId: 'lift', quantity: 1, ticket });
  const payload = { orderId: 'receipt-1', lineItems: [...items(equipment), ...items(issued.assetIds, 'lift')] }, before = copy(f.state);
  assert.throws(() => f.call('ops.issue', payload, { ...context, at: '2026-09-13T05:00:00.000Z' }), code('TICKET_UNAVAILABLE')); assert.deepEqual(f.state, before);
  const result = f.call('ops.issue', payload); assert.equal(result.movementIds.length, 2); assert.equal(result.issuedQuantity, 2);
  assert.deepEqual(f.order().lines.map(row => row.issuedQuantity), [1, 1]); assert.equal(f.state.allocations[0].fulfilledAt, context.at);
  assert.deepEqual(f.state.movements.at(-1).lineItems, items(issued.assetIds, 'lift'));
});

test('ticket-only trip loads without fulfillment and delivers only through its assigned driver task', () => {
  const f = fixture([line({ id: 'lift', sku: 'ticket-4h', quantity: 1, end: '2026-09-13', price: { unitWon: 45000 } })]);
  const issued = f.call('ops.ticketIssue', { orderId: 'receipt-1', lineId: 'lift', quantity: 1, ticket });
  f.dispatch(issued.assetIds, { lineItems: items(issued.assetIds, 'lift') });
  assert.equal(f.state.allocations[0].fulfilledAt, null); assert.equal(f.order().lines[0].issuedQuantity, 0);
  f.call('ops.deliver', { orderId: 'receipt-1', taskId: 'trip-1', lineItems: items(issued.assetIds, 'lift') }, driver);
  assert.equal(f.state.tasks[0].status, 'completed'); assert.equal(f.order().lines[0].issuedQuantity, 1);
});

test('explicit source linking prevents cross-team links and never retroactively adopts source custody', () => {
  const f = fixture(), [id] = f.stock(1);
  f.state.forms.push({ id: 'old-form', issues: [{ assetIds: [id] }] });
  f.call('stock.move', { kind: 'deliver', from: shop, to: { kind: 'customer', id: 'old-form' }, assetIds: [id] });
  const result = f.call('ops.link', { orderId: 'receipt-1', sourceType: 'form', sourceId: 'old-form' });
  assert.equal(result.historicalMovement, true); assert.equal(result.custodyMerged, false); assert.equal(f.order().lines[0].issuedQuantity, 0);
  assert.throws(() => f.call('ops.link', { orderId: 'receipt-1', sourceType: 'form', sourceId: 'old-form' }), code('NO_CHANGE'));
  f.call('order.create', orderPayload([line()], 'receipt-2'));
  assert.throws(() => f.call('ops.link', { orderId: 'receipt-2', sourceType: 'form', sourceId: 'old-form' }), code('ALREADY_EXISTS'));
});

test('ticket issuing uses the corrected customer profile without changing the original receipt customer', () => {
  const f = fixture([line({ id: 'lift', sku: 'ticket-4h', quantity: 1, end: '2026-09-13', price: { unitWon: 45000 } })]);
  f.state.orders[0].customer.phone = '';
  f.state.customerProfiles = [{ id: 'profile-1', orderIds: ['receipt-1'], phone: '010-9999-1111' }];
  f.call('ops.ticketIssue', { orderId: 'receipt-1', lineId: 'lift', quantity: 1, ticket });
  assert.equal(f.state.reservations[0].customer.phone, '010-9999-1111'); assert.equal(f.state.orders[0].customer.phone, '');
});

const exchangeRequest = (baseAssetIds, extra = {}) => ({ id: 'exchange-1', orderId: 'receipt-1', customerId: 'receipt-1', customerName: customer.name, kind: 'ski', baseAssetIds,
  reason: 'size', oldSize: '160', newSize: '170', method: 'vehicle', visit: { method: 'vehicle', date: '2026-09-13', time: '10:00', place: '숙소', vehicleId: 'van-1' },
  returnPlan: { method: 'vehicle', date: '2026-09-14', time: '17:00', place: '스키장', vehicleId: 'van-1' }, ...extra });
function exchangeDelivery(f, replacement, taskId = 'exchange-1-new') {
  f.call('stock.move', { kind: 'load', assetIds: replacement, from: shop, to: van, taskId });
  f.call('stock.move', { kind: 'deliver', assetIds: replacement, from: van, to: { kind: 'customer', id: 'receipt-1' }, taskId }, driver);
}

test('direct return accepts old and replacement exchange stock together and updates exchange completion through hooks', () => {
  const f = fixture([line({ quantity: 1 })]), [old, replacement] = f.stock(2); f.issue([old]);
  f.call('exchange.request', exchangeRequest([old])); f.call('exchange.prepare', { id: 'exchange-1', assetIds: [replacement] }); exchangeDelivery(f, [replacement]);
  assert.deepEqual(f.order().lines[0].customerAssetIds, [old, replacement]); assert.equal(f.order().lines[0].issuedQuantity, 1);
  assert.throws(() => f.call('ops.schedule', { orderId: 'receipt-1', lineItems: items([old]), date: '2026-09-14', time: '18:00', place: '숙소', vehicleId: 'van-1' }), code('DEPENDENT_MOVEMENT'));
  const result = f.call('ops.return', { orderId: 'receipt-1', lineItems: items([old, replacement]), mode: 'direct' });
  assert.equal(result.receivedQuantity, 2); assert.equal(result.movementIds.length, 2); assert.equal(f.state.exchanges[0].status, 'completed');
  assert.equal(f.state.exchanges[0].units[0].receivedAt, context.at); assert.equal(f.order().lines[0].customerQuantity, 0);
  assert.equal(f.order().lines[0].issuedQuantity, 1); assert.equal(f.order().amountWon, 40000);
});

test('exchange old collection and shop receipt update both ordinary custody and the exchange receipt record', () => {
  const f = fixture([line({ quantity: 1 })]), [old, replacement] = f.stock(2); f.issue([old]);
  f.call('exchange.request', exchangeRequest([old])); f.call('exchange.prepare', { id: 'exchange-1', assetIds: [replacement] }); exchangeDelivery(f, [replacement]);
  f.call('ops.return', { orderId: 'receipt-1', lineItems: items([old]), mode: 'collect', taskId: 'exchange-1-old' }, driver);
  assert.equal(f.state.exchanges[0].units[0].collectedAt, context.at); assert.equal(f.state.tasks.find(t => t.id === 'exchange-1-old').status, 'completed');
  f.call('ops.receive', { orderId: 'receipt-1', assetIds: [old] });
  assert.equal(f.state.exchanges[0].units[0].receivedAt, context.at); assert.equal(f.state.exchanges[0].status, 'completed');
  assert.deepEqual(f.order().lines[0].customerAssetIds, [replacement]); assert.equal(f.state.assets.find(a => a.id === old).exchangeReservationId, null);
});

test('component exchange blocks premature base return and its virtual line supports independent scheduling and return', () => {
  const f = fixture([line({ quantity: 1 })]), [base] = f.stock(1); f.issue([base]);
  f.call('exchange.request', exchangeRequest([base], { kind: 'ski-boots', oldSize: '260', newSize: '270', confirmExistingComponent: true }));
  assert.throws(() => f.call('ops.return', { orderId: 'receipt-1', lineItems: items([base]), mode: 'direct' }), code('DEPENDENT_MOVEMENT'));
  const replacement = f.stock(1, 'ski-boots'); f.call('exchange.prepare', { id: 'exchange-1', assetIds: replacement }); exchangeDelivery(f, replacement);
  const component = f.order().lines.find(line => line.component), source = copy(f.state.orders[0].lines);
  assert.equal(component.customerAssetIds.length, 2);
  const next = f.call('ops.schedule', { orderId: 'receipt-1', lineItems: items(replacement, component.id), date: '2026-09-15', time: '18:00', place: '매표소', vehicleId: 'van-2' });
  assert.equal(f.state.tasks.find(t => t.id === next.taskId).vehicleId, 'van-2'); assert.deepEqual(f.state.orders[0].lines, source);
  f.call('ops.return', { orderId: 'receipt-1', lineItems: items(component.customerAssetIds, component.id), mode: 'direct' });
  assert.equal(f.state.exchanges[0].status, 'completed'); assert.deepEqual(f.order().lines[0].customerAssetIds, [base]);
});

test('physical preparation records confirmed size, protects capacity and is consumed by direct issue', () => {
  const f = fixture([line({ quantity: 2 })]), ids = f.stock(3), before = copy(f.state);
  const prepare = { orderId: 'receipt-1', id: 'prep-1', lineItems: [{ lineId: 'ski-line', assets: [{ assetId: ids[0], size: '165 cm' }, { assetId: ids[1], size: '170 cm' }] }] };
  assert.throws(() => f.call('ops.prepare', { ...prepare, lineItems: [{ lineId: 'ski-line', assets: [{ assetId: ids[0], size: '' }] }] }), code('INVALID_INPUT')); assert.deepEqual(f.state, before);
  f.call('ops.prepare', prepare); assert.equal(f.state.assets[0].size, '165 cm'); assert.equal(f.order().lines[0].issuedQuantity, 0);
  assert.equal(Inventory.allocatable(f.state, f.state.assets[0]), false); assert.throws(() => f.issue([ids[2]]), code('QUANTITY_EXCEEDED'));
  const prepared = copy(f.state.orders[0].preparations[0]); f.issue([ids[0]]);
  assert.equal(f.state.assets[0].orderPreparation, undefined); assert.equal(f.state.movements.at(-1).before.assets[0].orderPreparation.preparationId, 'prep-1');
  assert.deepEqual(f.state.orders[0].preparations[0], prepared);
  const result = f.call('ops.prepareCancel', { orderId: 'receipt-1', preparationId: 'prep-1', reason: '남은 일행 취소' });
  assert.deepEqual(result.assetIds, [ids[1]]); assert.equal(f.state.assets[1].orderPreparation, undefined); assert.equal(f.state.assets[0].location.kind, 'customer');
});

test('prepared stock can only load into its own line and must be unloaded before preparation cancellation', () => {
  const f = fixture([line({ quantity: 1 }), line({ id: 'late', quantity: 1 })]), ids = f.stock(2);
  f.call('ops.prepare', { orderId: 'receipt-1', id: 'prep-1', lineItems: [{ lineId: 'ski-line', assets: [{ assetId: ids[0], size: '160' }] }] });
  assert.throws(() => f.call('ops.issue', { orderId: 'receipt-1', lineItems: items([ids[0]], 'late') }), code('ALREADY_EXISTS'));
  f.dispatch([ids[0]]); const before = copy(f.state);
  assert.throws(() => f.call('ops.prepareCancel', { orderId: 'receipt-1', preparationId: 'prep-1', reason: '배정 해제' }), code('DEPENDENT_MOVEMENT')); assert.deepEqual(f.state, before);
  f.call('ops.deliveryCancel', { taskId: 'trip-1', reason: '방문 수령으로 변경', unload: true });
  f.call('ops.prepareCancel', { orderId: 'receipt-1', preparationId: 'prep-1', reason: '규격 다시 확인' });
  assert.equal(f.state.assets[0].orderPreparation, undefined); assert.equal(Inventory.allocatable(f.state, f.state.assets[0]), true);
});

test('taskMove maps allocated planned items to unified lines and completes only after the final actual delivery', () => {
  const f = fixture(), ids = f.stock();
  f.call('task.save', { id: 'planned', orderId: 'receipt-1', customerId: 'receipt-1', kind: 'delivery', vehicleId: 'van-1', date: '2026-09-13', time: '10:00', place: '숙소', title: '예약 장비', plannedItems: [{ itemId: 'ski-line', sku: 'ski', quantity: 3 }] });
  f.call('task.allocate', { id: 'planned', items: [{ itemId: 'ski-line', assetIds: ids }] });
  f.call('stock.move', { kind: 'load', from: shop, to: van, assetIds: ids, taskId: 'planned' });
  const before = copy(f.state.movements); assert.equal(f.call('ops.taskMove', { taskId: 'planned', assetIds: [] }, driver).movedQuantity, 0); assert.deepEqual(f.state.movements, before);
  f.call('ops.taskMove', { taskId: 'planned', assetIds: [ids[0]] }, driver);
  assert.equal(f.order().lines[0].issuedQuantity, 1); assert.equal(f.state.tasks[0].status, 'waiting'); assert.deepEqual(f.state.movements.at(-1).lineItems, items([ids[0]]));
  assert.throws(() => f.call('ops.taskMove', { taskId: 'planned', assetIds: [ids[0]] }, driver), code('FORBIDDEN'));
  f.call('ops.taskMove', { taskId: 'planned', assetIds: ids.slice(1) }, driver); assert.equal(f.state.tasks[0].status, 'completed');
  const scheduled = f.call('ops.schedule', { orderId: 'receipt-1', lineItems: items(ids), date: '2026-09-14', time: '17:00', place: '숙소', vehicleId: 'van-1' });
  f.call('ops.taskMove', { taskId: scheduled.taskId, assetIds: ids }, driver);
  assert.equal(f.state.tasks[1].status, 'completed'); assert.deepEqual(f.order().lines[0].vehicleAssetIds, ids);
});

test('taskMove preserves legacy form person fulfillment and reservation allocation in the same completed transaction', () => {
  const f = fixture(), ids = f.stock(2);
  f.call('task.save', { id: 'form-trip', customerId: 'form-1', kind: 'delivery', vehicleId: 'van-1', date: '2026-09-13', time: '10:00', place: '숙소', title: '폼 장비', assetIds: ids });
  f.state.tasks[0].formId = 'form-1'; f.state.forms.push({ id: 'form-1', dispatches: [{ taskId: 'form-trip', people: [{ personId: 'p1', assetIds: ids }] }], issues: [] });
  f.call('stock.move', { kind: 'load', from: shop, to: van, assetIds: ids, taskId: 'form-trip' });
  f.call('ops.taskMove', { taskId: 'form-trip', assetIds: [ids[0]] }, driver); assert.equal(f.state.forms[0].issues.length, 0);
  f.call('ops.taskMove', { taskId: 'form-trip', assetIds: [ids[1]] }, driver); assert.equal(f.state.forms[0].issues.length, 1); assert.equal(f.state.tasks[0].status, 'completed');
  assert.equal(f.order().lines[0].issuedQuantity, 0);
  f.call('reservation.create', { id: 'reservation-1', customer, lines: [{ id: 'ticket-line', ticketType: 'ticket-4h', useDate: '2026-09-13', quantity: 1, startTime: '09:00', endTime: '13:00' }] });
  const issued = f.call('ticket.issue', { sku: 'ticket-4h', quantity: 1, ticket, reservationId: 'reservation-1', lineId: 'ticket-line' });
  f.call('task.save', { id: 'ticket-trip', customerId: 'reservation-1', reservationId: 'reservation-1', kind: 'delivery', vehicleId: 'van-1', date: '2026-09-13', time: '10:00', place: '숙소', title: '예약 권', assetIds: issued.assetIds });
  f.call('stock.move', { kind: 'load', from: shop, to: van, assetIds: issued.assetIds, taskId: 'ticket-trip' });
  f.call('ops.taskMove', { taskId: 'ticket-trip', assetIds: issued.assetIds }, driver);
  assert.equal(f.state.allocations[0].fulfilledAt, context.at); assert.equal(f.state.tasks[1].status, 'completed');
});

test('taskMove exchange delivery and collection run exchange hooks and leave original sale quantity unchanged', () => {
  const f = fixture([line({ quantity: 1 })]), [old, replacement] = f.stock(2); f.issue([old]);
  f.call('exchange.request', exchangeRequest([old])); f.call('exchange.prepare', { id: 'exchange-1', assetIds: [replacement] });
  f.call('stock.move', { kind: 'load', from: shop, to: van, assetIds: [replacement], taskId: 'exchange-1-new' });
  f.call('ops.taskMove', { taskId: 'exchange-1-new', assetIds: [replacement] }, driver);
  assert.equal(f.state.exchanges[0].units[0].deliveredAt, context.at); assert.equal(f.state.tasks.find(t => t.id === 'exchange-1-new').status, 'completed');
  assert.equal(f.order().lines[0].issuedQuantity, 1);
  f.call('ops.taskMove', { taskId: 'exchange-1-old', assetIds: [old] }, driver);
  assert.equal(f.state.exchanges[0].units[0].collectedAt, context.at); assert.equal(f.state.tasks.find(t => t.id === 'exchange-1-old').status, 'completed');
});

test('taskMove rejects wrong vehicle, cross-task assets and mismapped unified rows without moving anything', () => {
  const f = fixture(), ids = f.stock(4); f.dispatch(ids.slice(0, 3)); const before = copy(f.state);
  assert.throws(() => f.call('ops.taskMove', { taskId: 'trip-1', assetIds: [ids[0]] }, { ...driver, actor: { ...driver.actor, vehicleId: 'van-2' } }), code('FORBIDDEN'));
  assert.throws(() => f.call('ops.taskMove', { taskId: 'trip-1', assetIds: [ids[3]] }, driver), code('FORBIDDEN')); assert.deepEqual(f.state, before);
  f.state.tasks[0].lineItems = []; const mismapped = copy(f.state);
  assert.throws(() => f.call('ops.taskMove', { taskId: 'trip-1', assetIds: [ids[0]] }, driver), code('INVALID_INPUT')); assert.deepEqual(f.state, mismapped);
});

test('Domain.execute commits one taskMove event, deduplicates retries and rolls back invalid multi-line dispatch', () => {
  let state = Domain.fresh('shop-1'), sequence = 0;
  function execute(type, payload, actor = context) {
    const command = { type, payload, expectedVersion: state.revision, requestId: 'request-' + ++sequence };
    const result = Domain.execute(state, command, actor); state = result.state; return { result, command };
  }
  execute('order.create', orderPayload()); const stock = execute('stock.receive', { sku: 'ski', quantity: 3 }).result.result.assetIds;
  const before = copy(state);
  assert.throws(() => execute('ops.dispatch', { id: 'bad-trip', orderId: 'receipt-1', lineItems: [...items([stock[0]]), { lineId: 'missing', assetIds: [stock[1]] }], vehicleId: 'van-1', date: '2026-09-13', time: '10:00', place: '숙소' }), code('NOT_FOUND'));
  assert.deepEqual(state, before);
  execute('ops.dispatch', { id: 'trip-1', orderId: 'receipt-1', lineItems: items(stock), vehicleId: 'van-1', date: '2026-09-13', time: '10:00', place: '숙소' });
  const issued = execute('ops.taskMove', { taskId: 'trip-1', assetIds: stock }, driver), completed = copy(state);
  assert.equal(state.tasks[0].status, 'completed'); assert.equal(state.events.at(-1).type, 'ops.taskMove'); assert.equal(Orders.view(state, 'receipt-1').lines[0].issuedQuantity, 3);
  const retried = Domain.execute(state, issued.command, driver); assert.equal(retried.duplicate, true); assert.deepEqual(retried.state, completed);
  assert.throws(() => Domain.execute(state, { ...issued.command, requestId: 'stale-command' }, driver), code('VERSION_CONFLICT')); assert.deepEqual(state, completed);
});

test('browser UMD exposes all operation commands and rejects unrecognized commands', () => {
  const sandbox = { SkiWorkflowCommon: require('../src/workflows/common.js'), SkiWorkflowOrders: Orders, SkiWorkflowInventory: Inventory, SkiWorkflowDispatch: Dispatch, SkiWorkflowReservations: Reservations, SkiWorkflowFinance: Finance, SkiWorkflowExchanges: Exchanges };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/workflows/order-operations.js'), 'utf8'), sandbox);
  assert.deepEqual(Object.keys(sandbox.SkiWorkflowOrderOperations).sort(), ['canHandle', 'handle']);
  for (const type of ['return', 'receive', 'issue', 'dispatch', 'deliver', 'deliveryCancel', 'visit', 'schedule', 'extend', 'link', 'ticketIssue', 'cancelTicket', 'prepare', 'prepareCancel', 'taskMove']) assert.equal(Ops.canHandle('ops.' + type), true);
  assert.equal(Ops.canHandle('ops.unknown'), false); assert.throws(() => Ops.handle(Domain.fresh('shop-1'), 'ops.unknown', {}, context), code('INVALID_INPUT'));
});

const liftLine = (extra = {}) => line({ id: 'lift', sku: 'ticket-4h', quantity: 2, start: '2026-09-13', end: '2026-09-13', price: { unitWon: 45000 }, ...extra });
const cancelLift = { orderId: 'receipt-1', lineId: 'lift', reason: '일행 미도착' };
const issueLift = (f, extra = {}) => f.call('ops.ticketIssue', { orderId: 'receipt-1', lineId: 'lift', quantity: 1, ticket, ...extra });
const physical = assets => assets.map(({ lastRevision, ...asset }) => asset);

test('ticket cancellation releases every issue binding and reservation demand while retaining real stock, money and next-day sales', () => {
  const f = fixture([liftLine(), liftLine({ id: 'tomorrow', quantity: 1, start: '2026-09-14', end: '2026-09-14' })]);
  issueLift(f); issueLift(f);
  issueLift(f, { lineId: 'tomorrow', ticket: { ...ticket, validFrom: '2026-09-14T00:00:00.000Z', validTo: '2026-09-14T04:00:00.000Z' } });
  f.call('finance.payment', { id: 'paid', orderId: 'receipt-1', kind: 'payment', method: 'card', amountWon: 90000 });
  const before = copy(f.state), tomorrowBinding = before.orders[0].lines[1].reservationBindings[0];
  const result = f.call('ops.cancelTicket', cancelLift);
  assert.equal(result.cancelledDemandQuantity, 2); assert.equal(result.releasedAllocationQuantity, 2); assert.equal(result.cancelledAmountWon, 90000); assert.equal(result.physicalMovedQuantity, 0); assert.equal(result.refundedWon, 0);
  assert.equal(f.order().lines[0].cancelledQuantity, 2); assert.equal(f.order().lines[0].unissuedQuantity, 0); assert.equal(f.order().lines[0].issuedQuantity, 0);
  assert.ok(f.state.reservations[0].lines.filter(row => row.id !== tomorrowBinding.lineId).every(row => row.cancelledQuantity === row.quantity));
  assert.ok(f.state.allocations.filter(row => row.lineId !== tomorrowBinding.lineId).every(row => row.status === 'cancelled'));
  assert.deepEqual(f.state.orders[0].lines[1], before.orders[0].lines[1]); assert.deepEqual(f.state.reservations[0].lines.at(-1), before.reservations[0].lines.at(-1)); assert.deepEqual(f.state.allocations.at(-1), before.allocations.at(-1));
  assert.deepEqual(physical(f.state.assets), physical(before.assets)); assert.deepEqual(f.state.movements, before.movements); assert.deepEqual(f.state.payments, before.payments); assert.deepEqual(f.state.refunds, before.refunds);
  assert.equal(Finance.summary(f.state, 'receipt-1').creditWon, 45000); assert.equal(Finance.summary(f.state, 'receipt-1').refundWon, 0); assert.equal(f.state.orders[0].ticketCancellations[0].bindings.length, 2);
});

test('ticket cancellation also clears demand after manual allocation release without touching a later allocation', () => {
  const f = fixture([liftLine({ quantity: 1 })]), issued = issueLift(f), allocation = f.state.allocations[0];
  f.call('ticket.release', { allocationIds: [allocation.id] });
  f.call('reservation.create', { id: 'other-reservation', customer, lines: [{ id: 'other-line', ticketType: 'ticket-4h', useDate: '2026-09-13', quantity: 1, startTime: '09:00', endTime: '13:00' }] });
  f.call('ticket.allocate', { reservationId: 'other-reservation', lineId: 'other-line', assetIds: issued.assetIds });
  const asset = copy(f.state.assets[0]), other = copy(f.state.allocations[1]);
  const result = f.call('ops.cancelTicket', cancelLift); assert.equal(result.releasedAllocationQuantity, 0); assert.equal(result.cancelledDemandQuantity, 1);
  assert.deepEqual(f.state.assets[0], asset); assert.deepEqual(f.state.allocations[1], other); assert.equal(f.state.reservations[1].lines[0].cancelledQuantity, 0);
});

test('ticket cancellation blocks partly delivered, loaded, lost and foreign-bound tickets without changing any record', () => {
  for (const condition of ['delivered', 'loaded', 'lost', 'foreign']) {
    const f = fixture([liftLine()]), issued = issueLift(f, { quantity: 2 });
    if (condition === 'delivered') f.call('ops.issue', { orderId: 'receipt-1', lineItems: items([issued.assetIds[0]], 'lift') });
    if (condition === 'loaded') f.dispatch(issued.assetIds, { lineItems: items(issued.assetIds, 'lift') });
    if (condition === 'lost') f.state.assets[0].condition = 'lost';
    if (condition === 'foreign') {
      f.call('reservation.create', { id: 'foreign', orderId: 'other-order', customer, lines: [{ id: 'foreign-line', ticketType: 'ticket-4h', useDate: '2026-09-13', quantity: 1 }] });
      f.state.orders[0].lines[0].reservationBindings.push({ reservationId: 'foreign', lineId: 'foreign-line', assetIds: [], quantity: 1 });
    }
    const before = copy(f.state);
    assert.throws(() => f.call('ops.cancelTicket', cancelLift), code(condition === 'foreign' ? 'FORBIDDEN' : 'DEPENDENT_MOVEMENT')); assert.deepEqual(f.state, before, condition);
  }
});

test('loaded unissued tickets may cancel after actual unloading and delivery release; stock remains in the shop', () => {
  const f = fixture([liftLine()]), issued = issueLift(f, { quantity: 2 }); f.dispatch(issued.assetIds, { lineItems: items(issued.assetIds, 'lift') });
  f.call('ops.deliveryCancel', { taskId: 'trip-1', unload: true, reason: '매장 내림 확인' }); const movements = copy(f.state.movements);
  f.call('ops.cancelTicket', cancelLift);
  assert.deepEqual(f.state.movements, movements); assert.ok(f.state.assets.every(asset => I_same(asset.location, shop))); assert.equal(f.state.reservations[0].lines[0].cancelledQuantity, 2);
});

function I_same(a, b) { return a.kind === b.kind && a.id === b.id; }

test('an actually refunded unissued ticket can cancel its sale but no second vendor or customer refund is created', () => {
  const f = fixture([liftLine({ quantity: 1 })]), issued = issueLift(f);
  f.call('refund.plan', { id: 'vendor-refund', assetIds: issued.assetIds, vehicleId: 'van-1', vendorId: 'resort-1', date: '2026-09-13', time: '12:00', place: '발권처' });
  f.call('stock.move', { kind: 'load', from: shop, to: van, assetIds: issued.assetIds });
  f.call('refund.complete', { id: 'vendor-refund', assetIds: issued.assetIds, amountWon: 40000 });
  const before = copy(f.state); f.call('ops.cancelTicket', cancelLift);
  assert.deepEqual(f.state.refunds, before.refunds); assert.deepEqual(f.state.movements, before.movements); assert.deepEqual(physical(f.state.assets), physical(before.assets)); assert.equal(Finance.summary(f.state, 'receipt-1').refundWon, 0);
});

test('ticket cancellation preserves closing, role and negative-charge guards and rolls back the complete command', () => {
  for (const condition of ['closed', 'negative', 'driver']) {
    const f = fixture([liftLine()]); issueLift(f, { quantity: 2 });
    if (condition === 'closed') f.state.closings = [{ id: 'closed', date: '2026-09-13', reopenings: [] }];
    if (condition === 'negative') f.call('finance.adjustment', { id: 'discount', orderId: 'receipt-1', amountWon: -10000, reason: '별도 할인' });
    const before = copy(f.state), command = { type: 'ops.cancelTicket', payload: cancelLift, expectedVersion: before.revision, requestId: 'cancel-check' };
    assert.throws(() => Domain.execute(f.state, command, condition === 'driver' ? driver : context), code(condition === 'closed' ? 'DAY_CLOSED' : condition === 'driver' ? 'FORBIDDEN' : 'INVALID_INPUT')); assert.deepEqual(f.state, before);
  }
});

test('ticket cancellation commits once, deduplicates its retry, rejects stale copies and never revives demand', () => {
  const f = fixture([liftLine()]); issueLift(f, { quantity: 2 });
  const command = { type: 'ops.cancelTicket', payload: cancelLift, expectedVersion: f.state.revision, requestId: 'cancel-once' }, before = copy(f.state);
  const result = Domain.execute(f.state, command, context); assert.deepEqual(f.state, before); assert.equal(result.event.type, 'ops.cancelTicket');
  const retry = Domain.execute(result.state, command, context); assert.equal(retry.duplicate, true); assert.deepEqual(retry.state, result.state);
  assert.throws(() => Domain.execute(result.state, { ...command, requestId: 'stale-copy' }, context), code('VERSION_CONFLICT'));
  assert.throws(() => Domain.execute(result.state, { ...command, requestId: 'cancel-again', expectedVersion: result.state.revision }, context), code('NO_CHANGE'));
  assert.equal(result.state.orders[0].ticketCancellations.length, 1); assert.equal(result.state.reservations[0].lines[0].cancelledQuantity, 2);
});

test('actual issue materializes only issued return promises and groups matching plans across partial handovers', () => {
  const plan = { method: 'vehicle', date: '2026-09-14', time: '17:00', place: '숙소', vehicleId: 'van-2' };
  const f = fixture([line({ quantity: 2, returnPlan: plan }), line({ id: 'late', quantity: 1, returnPlan: plan }), line({ id: 'direct', quantity: 1 })]);
  const ids = f.stock(4); assert.equal(f.state.tasks.length, 0);
  const first = f.issue([ids[0]]); assert.equal(first.collectionTaskIds.length, 1); assert.deepEqual(f.state.tasks[0].assetIds, [ids[0]]);
  f.issue([ids[1]]); f.call('ops.issue', { orderId: 'receipt-1', lineItems: items([ids[2]], 'late') });
  assert.equal(f.state.tasks.length, 1); assert.equal(f.state.tasks[0].vehicleId, 'van-2'); assert.deepEqual(f.state.tasks[0].assetIds, ids.slice(0, 3)); assert.equal(f.state.tasks[0].lineItems.length, 2);
  f.call('ops.issue', { orderId: 'receipt-1', lineItems: items([ids[3]], 'direct') }); assert.equal(f.state.tasks[0].assetIds.length, 3);
  assert.equal(f.state.movements.filter(m => m.kind === 'collect').length, 0);
});

test('driver delivery and taskMove create collection promises for the configured other vehicle without premature physical collection', () => {
  for (const command of ['ops.deliver', 'ops.taskMove']) {
    const plan = { method: 'vehicle', date: '2026-09-14', time: '17:00', place: '숙소', vehicleId: 'van-2' };
    const f = fixture([line({ quantity: 1, returnPlan: plan })]), ids = f.stock(1); f.dispatch(ids);
    const result = f.call(command, command === 'ops.deliver' ? { orderId: 'receipt-1', taskId: 'trip-1', lineItems: items(ids) } : { taskId: 'trip-1', assetIds: ids }, driver);
    const task = f.state.tasks.find(t => t.kind === 'collection'); assert.equal(result.collectionTaskIds[0], task.id); assert.equal(task.vehicleId, 'van-2'); assert.equal(task.status, 'waiting'); assert.deepEqual(task.assetIds, ids);
    assert.equal(f.state.assets[0].location.kind, 'customer'); assert.equal(task.issueAssignments[0].actor.role, 'driver'); assert.equal(f.state.movements.filter(m => m.kind === 'collect').length, 0);
  }
});

test('partial return extension affects only remaining customer assets and preserves old periods, returned custody, money history and unrelated lines', () => {
  const plan = { method: 'vehicle', date: '2026-09-14', time: '17:00', place: '숙소', vehicleId: 'van-2' };
  const f = fixture([line({ quantity: 2, returnPlan: plan }), line({ id: 'late', quantity: 1 })]), ids = f.stock(2); f.issue(ids);
  f.call('ops.return', { orderId: 'receipt-1', lineItems: items([ids[0]]), mode: 'direct' });
  const before = copy(f.state), price = copy(f.order().lines[0].price), payload = { orderId: 'receipt-1', lineIds: ['ski-line'], end: '2026-09-16', amountWon: 40000, reason: '남은 1개만 2일 연장' };
  const result = f.call('ops.extend', payload), current = f.order().lines[0], change = f.state.orders[0].extensions[0].changes[0];
  assert.equal(result.extendedQuantity, 1); assert.equal(current.end, '2026-09-14'); assert.deepEqual(current.returnPlan, plan); assert.deepEqual(current.price, price);
  assert.deepEqual(change.assetIds, [ids[1]]); assert.equal(change.scope, 'assets'); assert.deepEqual(current.assetTerms.map(term => [term.assetId, term.end]), [[ids[1], '2026-09-16']]);
  assert.deepEqual(f.state.assets, before.assets); assert.deepEqual(f.state.movements, before.movements); assert.deepEqual(f.state.orders[0].lines[1], before.orders[0].lines[1]);
  const task = f.state.tasks.find(task => task.status === 'waiting' && task.date === '2026-09-16'); assert.deepEqual(task.assetIds, [ids[1]]); assert.equal(task.vehicleId, 'van-2');
  assert.equal(Finance.summary(f.state, 'receipt-1').chargedWon, Finance.summary(before, 'receipt-1').chargedWon + 40000);
  f.call('ops.extend', { ...payload, end: '2026-09-17', amountWon: 20000 }); assert.equal(f.order().lines[0].assetTerms[0].end, '2026-09-17'); assert.equal(f.state.orders[0].extensions[1].changes[0].assetChanges[0].beforeEnd, '2026-09-16');
  assert.equal(f.order().lines[0].end, '2026-09-14'); assert.equal(f.state.tasks.filter(task => task.status === 'waiting').length, 1);
});

test('partially issued extension leaves future unissued quantity at its original term and a later issue keeps that promise', () => {
  const plan = { method: 'vehicle', date: '2026-09-14', time: '17:00', place: '숙소', vehicleId: 'van-2' };
  const f = fixture([line({ quantity: 2, returnPlan: plan })]), ids = f.stock(2); f.issue([ids[0]]);
  f.call('ops.extend', { orderId: 'receipt-1', lineIds: ['ski-line'], end: '2026-09-16', amountWon: 40000, reason: '현재 이용 1개만 연장' });
  assert.equal(f.order().lines[0].end, '2026-09-14'); assert.equal(f.order().lines[0].unissuedQuantity, 1); f.issue([ids[1]]);
  assert.deepEqual(f.state.tasks.filter(task => task.status === 'waiting').map(task => ({ date: task.date, ids: task.assetIds })).sort((a,b) => a.date.localeCompare(b.date)), [{date:'2026-09-14',ids:[ids[1]]},{date:'2026-09-16',ids:[ids[0]]}]);
});

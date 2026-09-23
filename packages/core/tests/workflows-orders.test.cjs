const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Orders = require('../src/workflows/orders.js');
const Inventory = require('../src/workflows/inventory.js');
const Domain = require('../src/workflows/domain.js');

const copy = value => JSON.parse(JSON.stringify(value));
const customer = { name: '김민수', phone: '010-1234-5678' };
const shop = { kind: 'shop', id: 'shop-1' }, van = { kind: 'vehicle', id: 'van-1' };
const context = { shopId: 'shop-1', actor: { id: 'counter-1', role: 'store' }, at: '2026-09-13T00:00:00.000Z' };
const driver = { ...context, actor: { id: 'driver-1', role: 'driver', vehicleId: 'van-1' } };
const code = expected => error => error.code === expected;
const line = (overrides = {}) => ({ id: 'first-ski', sku: 'ski', quantity: 2, start: '2026-09-13', end: '2026-09-14', price: { unitWon: 20000, discountWon: 5000 }, ...overrides });
const create = (overrides = {}) => ({ id: 'receipt-1', customer, people: [{ id: 'person-1', name: '김민수' }], batch: { id: 'first', lines: [line()] }, ...overrides });
function fixture() {
  let state = Domain.fresh('shop-1');
  function call(type, payload, actor = context) {
    const next = copy(state);
    const result = type.startsWith('order.') ? Orders.handle(next, type, payload, actor) : Inventory.handle(next, type, payload, actor);
    next.revision++; state = next; return result;
  }
  return { call, get state() { return state; }, order: () => Orders.view(state, 'receipt-1'),
    stock: (quantity, sku = 'ski') => call('stock.receive', { sku, quantity }).assetIds,
    move: (kind, assetIds, from, to, extra = {}) => call('stock.move', { kind, assetIds, from, to, ...extra }) };
}

test('orders schema extension is backward compatible and read-only queries do not initialize it', () => {
  const state = { schemaVersion: 1, revision: 7, forms: [{ id: 'old-form' }] }, before = copy(state);
  assert.deepEqual(Orders.list(state), []); assert.deepEqual(state, before);
  assert.equal(Orders.initialize(state), state); assert.deepEqual(state, { ...before, orders: [] });
  const orders = state.orders; Orders.initialize(state); assert.equal(state.orders, orders);
  assert.throws(() => Orders.initialize({ orders: {} }), code('INVALID_INPUT'));
});

test('first receipt supports anonymous aliases, optional people and server-computed inclusive daily price', () => {
  const f = fixture(), payload = create({ people: [{ id: 'person-1' }, { id: 'person-2', name: '아버지' }] });
  const result = f.call('order.create', payload), order = f.order();
  assert.deepEqual(order.people, [{ id: 'person-1', name: '일행 1' }, { id: 'person-2', name: '아버지' }]);
  assert.equal(result.addedAmountWon, 75000); assert.equal(order.amountWon, 75000);
  assert.deepEqual(order.lines[0].price, { basis: 'per_day', days: 2, unitWon: 20000, discountWon: 5000, amountWon: 75000 });
  assert.equal(order.lines[0].pickupPlan.date, '2026-09-13'); assert.equal(order.lines[0].returnPlan.date, '2026-09-14');
  assert.equal(order.lines[0].cancelledQuantity, 0); assert.equal(order.status, 'awaiting_issue');
  payload.customer.name = '수정'; payload.batch.lines[0].price.unitWon = 0;
  assert.equal(f.order().customer.name, '김민수'); assert.equal(f.order().amountWon, 75000);
  const noPeople = fixture(); noPeople.call('order.create', create({ people: undefined })); assert.deepEqual(noPeople.order().people, []);
});

test('same-day and next-day additions retain old prices, people and schedules with distinct repeated-SKU lines', () => {
  const f = fixture(); f.call('order.create', create());
  const original = copy(f.state.orders[0]);
  f.call('order.add', { orderId: 'receipt-1', people: [{ id: 'late-person' }], batch: { id: 'tomorrow', label: '내일 도착 1명', lines: [line({ id: 'tomorrow-ski', quantity: 1, start: '2026-09-14', personId: 'late-person', price: { unitWon: 25000 } })] } });
  f.call('order.add', { orderId: 'receipt-1', batch: { id: 'today-extra', lines: [line({ id: 'today-clothing', sku: 'clothing', quantity: 1, end: '2026-09-13', personId: 'person-1', price: { unitWon: 10000 } })] } });
  const order = f.order();
  assert.equal(order.id, original.id); assert.deepEqual(f.state.orders[0].lines[0], original.lines[0]);
  assert.deepEqual(f.state.orders[0].batches[0], original.batches[0]); assert.deepEqual(order.people[0], original.people[0]);
  assert.equal(order.people[1].name, '일행 2'); assert.equal(order.lines[1].sku, order.lines[0].sku);
  assert.notEqual(order.lines[1].id, order.lines[0].id); assert.equal(order.lines[2].personId, 'person-1');
  assert.equal(order.amountWon, 110000); assert.equal(order.batches[1].amountWon, 25000);
  assert.deepEqual(order.lines.map(row => row.batchId), ['first', 'tomorrow', 'today-extra']);
});

test('equipment and daily separate lift-ticket sales share a receipt without creating ticket stock or reservations', () => {
  const f = fixture();
  f.call('order.create', create({ batch: { id: 'first', lines: [line(), line({ id: 'tickets-today', sku: 'ticket-4h', quantity: 2, end: '2026-09-13', price: { unitWon: 45000, discountWon: 5000, amountWon: 85000 } })] } }));
  f.call('order.add', { orderId: 'receipt-1', batch: { id: 'tickets-next-day', lines: [line({ id: 'tickets-tomorrow', sku: 'ticket-4h', quantity: 1, start: '2026-09-14', price: { unitWon: 40000 } })] } });
  const order = f.order(); assert.equal(order.amountWon, 200000);
  assert.deepEqual(order.lines[1].price, { basis: 'per_unit', days: 1, unitWon: 45000, discountWon: 5000, amountWon: 85000 });
  assert.equal(f.state.assets.length, 0); assert.equal(f.state.reservations.length, 0);
  for (const bad of [line({ sku: 'ticket-4h' }), line({ sku: 'ticket-4h', end: '2026-09-13', price: { basis: 'per_day', unitWon: 45000 } })]) {
    const rejected = fixture(); assert.throws(() => rejected.call('order.create', create({ batch: { id: 'first', lines: [bad] } })), code('INVALID_INPUT'));
  }
});

test('invalid prices, money overflow, periods, quantity, SKU and unsupported properties reject the entire receipt', () => {
  const invalid = [
    line({ price: { unitWon: -1 } }), line({ price: { unitWon: 1.5 } }), line({ price: { unitWon: '20000' } }),
    line({ price: { unitWon: 20000, discountWon: -1 } }), line({ price: { unitWon: 20000, discountWon: 80001 } }),
    line({ price: { unitWon: 20000, amountWon: 1 } }), line({ price: { unitWon: Number.MAX_SAFE_INTEGER } }),
    line({ price: { unitWon: 20000, basis: 'unknown' } }), line({ quantity: 0 }), line({ quantity: 1.5 }), line({ quantity: 501 }),
    line({ start: '2026-02-30' }), line({ start: '2026-09-15' }), line({ end: '2027-09-15' }),
    line({ initialAssetIds: ['external-asset'] }), line({ initialReturnedAssetIds: ['external-asset'] }), line({ initialNonReturnQuantity: 1 })
  ];
  for (const bad of invalid) {
    const f = fixture(), before = copy(f.state);
    assert.throws(() => f.call('order.create', create({ batch: { id: 'first', lines: [bad] } })), code('INVALID_INPUT'));
    assert.deepEqual(f.state, before);
  }
  const missing = fixture(); assert.throws(() => missing.call('order.create', create({ batch: { id: 'first', lines: [line({ sku: 'missing' })] } })), code('NOT_FOUND'));
  const overflow = fixture(); assert.throws(() => overflow.call('order.create', create({ batch: { id: 'first', lines: [line({ id: 'a', quantity: 1, end: '2026-09-13', price: { unitWon: Number.MAX_SAFE_INTEGER } }), line({ id: 'b', quantity: 1, end: '2026-09-13', price: { unitWon: 1 } })] } })), code('INVALID_INPUT'));
});

test('pickup and return plans keep distinct dates, places and vehicles and reject inconsistent schedules', () => {
  const f = fixture(), pickupPlan = { method: 'delivery', date: '2026-09-12', time: '18:00', place: '숙소', vehicleId: 'van-1' }, returnPlan = { method: 'vehicle', date: '2026-09-15', time: '09:00', place: '스키장', vehicleId: 'van-2' };
  f.call('order.create', create({ batch: { id: 'first', lines: [line({ pickupPlan, returnPlan })] } }));
  assert.deepEqual(f.order().lines[0].pickupPlan, pickupPlan); assert.deepEqual(f.order().lines[0].returnPlan, returnPlan);
  for (const bad of [
    { pickupPlan: { ...pickupPlan, date: '2026-09-14' } }, { pickupPlan: { ...pickupPlan, vehicleId: undefined } },
    { pickupPlan: { ...pickupPlan, time: '25:00' } }, { pickupPlan: { method: 'shop', vehicleId: 'van-1' } },
    { returnPlan: { ...returnPlan, date: '2026-09-13' } }, { returnPlan: { ...returnPlan, place: '' } },
    { returnPlan: { method: 'direct', vehicleId: 'van-1' } }
  ]) {
    const rejected = fixture(); assert.throws(() => rejected.call('order.create', create({ batch: { id: 'first', lines: [line(bad)] } })), code('INVALID_INPUT'));
  }
});

test('duplicate receipt, batch, person and line IDs and unknown people fail without changing accepted records', () => {
  const f = fixture(); f.call('order.create', create()); const before = copy(f.state);
  const failures = [
    ['order.create', create(), 'ALREADY_EXISTS'],
    ['order.add', { orderId: 'receipt-1', batch: { id: 'first', lines: [line({ id: 'new-line' })] } }, 'ALREADY_EXISTS'],
    ['order.add', { orderId: 'receipt-1', batch: { id: 'new-batch', lines: [line()] } }, 'ALREADY_EXISTS'],
    ['order.add', { orderId: 'receipt-1', people: [{ id: 'person-1', name: '다른 이름' }], batch: { id: 'new-batch', lines: [line({ id: 'new-line' })] } }, 'ALREADY_EXISTS'],
    ['order.add', { orderId: 'receipt-1', people: [{ id: 'person-2' }, { id: 'person-2' }], batch: { id: 'new-batch', lines: [line({ id: 'new-line' })] } }, 'ALREADY_EXISTS'],
    ['order.add', { orderId: 'receipt-1', people: [{ id: 'person-2' }], batch: { id: 'new-batch', lines: [line({ id: 'new-line' }), line({ id: 'new-line' })] } }, 'ALREADY_EXISTS'],
    ['order.add', { orderId: 'receipt-1', batch: { id: 'new-batch', lines: [line({ id: 'new-line', personId: 'unknown-person' })] } }, 'NOT_FOUND'],
    ['order.add', { orderId: 'missing', batch: { id: 'new-batch', lines: [line()] } }, 'NOT_FOUND']
  ];
  for (const [type, payload, error] of failures) { assert.throws(() => f.call(type, payload), code(error)); assert.deepEqual(f.state, before); }
});

test('unissued cancellation preserves original price and quantity, records reason and affects only selected lines', () => {
  const f = fixture(); f.call('order.create', create());
  f.call('order.add', { orderId: 'receipt-1', batch: { id: 'added', lines: [line({ id: 'late-ski', quantity: 1, start: '2026-09-14', price: { unitWon: 25000 } }), line({ id: 'late-helmet', sku: 'helmet', quantity: 1, start: '2026-09-14', price: { unitWon: 5000 } })] } });
  const before = copy(f.state.orders[0].lines);
  f.call('order.cancel', { orderId: 'receipt-1', batchId: 'added', lineIds: ['late-ski'], reason: '일행 장비 취소' });
  const order = f.order(); assert.deepEqual(f.state.orders[0].lines[0], before[0]);
  assert.deepEqual(order.lines[1].price, before[1].price); assert.equal(order.lines[1].quantity, 1); assert.equal(order.lines[1].cancelledQuantity, 1);
  assert.equal(order.amountWon, 80000); assert.equal(order.totals.originalAmountWon, 105000); assert.equal(order.totals.cancelledAmountWon, 25000);
  assert.equal(order.cancellations[0].reason, '일행 장비 취소'); assert.deepEqual(order.cancellations[0].lineIds, ['late-ski']);
  assert.equal(order.batches[1].status, 'active');
  f.call('order.cancel', { orderId: 'receipt-1', batchId: 'added', reason: '나머지 취소' });
  assert.equal(f.order().batches[1].status, 'cancelled'); assert.equal(f.order().amountWon, 75000);
  assert.throws(() => f.call('order.cancel', { orderId: 'receipt-1', lineIds: ['late-ski'], reason: '다시 취소' }), code('NO_CHANGE'));
  assert.throws(() => f.call('order.cancel', { orderId: 'receipt-1', batchId: 'added', lineIds: ['first-ski'], reason: '잘못 선택' }), code('INVALID_INPUT'));
});

test('cancellation selectors, reason and role are validated and cancelled receipt can receive a later addition', () => {
  const f = fixture(); f.call('order.create', create());
  for (const payload of [{ orderId: 'receipt-1', reason: '' }, { orderId: 'receipt-1', lineIds: [], reason: '취소' }, { orderId: 'receipt-1', lineIds: ['first-ski', 'first-ski'], reason: '취소' }]) assert.throws(() => f.call('order.cancel', payload), code('INVALID_INPUT'));
  assert.throws(() => f.call('order.cancel', { orderId: 'receipt-1', reason: '취소' }, driver), code('FORBIDDEN'));
  f.call('order.cancel', { orderId: 'receipt-1', reason: '전체 미방문' });
  assert.equal(f.order().status, 'cancelled'); assert.equal(f.order().amountWon, 0);
  const history = copy(f.state.orders[0].cancellations);
  f.call('order.add', { orderId: 'receipt-1', batch: { id: 'later', lines: [line({ id: 'later-ski' })] } });
  assert.deepEqual(f.state.orders[0].cancellations, history); assert.equal(f.order().status, 'awaiting_issue');
});

test('partial issue records immutable line linkage and separate return custody; additive batch retains old delivery', () => {
  const f = fixture(); f.call('order.create', create()); const ids = f.stock(2);
  const first = f.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'first-ski', assetIds: [ids[0]] }] });
  assert.equal(f.order().totals.customerQuantity, 1); assert.equal(f.order().totals.unissuedQuantity, 1); assert.equal(f.order().issueStatus, 'partially_issued');
  const recorded = copy(f.state.movements.find(movement => movement.id === first.movementId));
  f.call('order.add', { orderId: 'receipt-1', batch: { id: 'tomorrow', lines: [line({ id: 'tomorrow-ski', quantity: 1, start: '2026-09-14', price: { unitWon: 25000 } })] } });
  assert.deepEqual(f.state.movements.find(movement => movement.id === first.movementId), recorded);
  f.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'first-ski', assetIds: [ids[1]] }] });
  f.move('collect', [ids[0]], { kind: 'customer', id: 'receipt-1' }, van);
  let row = f.order().lines[0]; assert.deepEqual([row.customerQuantity, row.vehicleQuantity, row.shopQuantity], [1, 1, 0]);
  f.move('receive', [ids[0]], van, shop); f.move('directReturn', [ids[1]], { kind: 'customer', id: 'receipt-1' }, shop);
  assert.equal(f.order().lines[0].shopQuantity, 2); assert.equal(f.order().status, 'awaiting_issue');
  f.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'tomorrow-ski', assetIds: [ids[0]] }] });
  row = f.order(); assert.equal(row.lines[0].shopQuantity, 2); assert.equal(row.lines[1].customerQuantity, 1);
  assert.deepEqual(recorded.lineItems, [{ lineId: 'first-ski', assetIds: [ids[0]] }]); assert.equal(recorded.orderId, 'receipt-1');
});

test('issue validates remaining demand, unique assets, SKU, location, cancelled lines and customer permissions', () => {
  const f = fixture(); f.call('order.create', create()); const ids = f.stock(3), helmet = f.stock(1, 'helmet');
  f.call('order.add', { orderId: 'receipt-1', batch: { id: 'extra', lines: [line({ id: 'extra-ski', quantity: 1 })] } });
  for (const rows of [
    [{ lineId: 'first-ski', assetIds: ids }], [{ lineId: 'first-ski', assetIds: helmet }],
    [{ lineId: 'first-ski', assetIds: [ids[0]] }, { lineId: 'extra-ski', assetIds: [ids[0]] }],
    [{ lineId: 'first-ski', assetIds: [ids[0]] }, { lineId: 'first-ski', assetIds: [ids[1]] }]
  ]) {
    const before = copy(f.state); assert.throws(() => f.call('order.issue', { orderId: 'receipt-1', lineItems: rows })); assert.deepEqual(f.state, before);
  }
  assert.throws(() => f.call('order.issue', { orderId: 'receipt-1', vehicleId: 'van-1', lineItems: [{ lineId: 'first-ski', assetIds: [ids[0]] }] }), code('QUANTITY_EXCEEDED'));
  assert.throws(() => f.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'first-ski', assetIds: [ids[0]] }] }, driver), code('FORBIDDEN'));
  f.call('order.cancel', { orderId: 'receipt-1', lineIds: ['extra-ski'], reason: '추가 취소' });
  assert.throws(() => f.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'extra-ski', assetIds: [ids[0]] }] }), code('QUANTITY_EXCEEDED'));
  f.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'first-ski', assetIds: ids.slice(0, 2) }] });
  assert.throws(() => f.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'first-ski', assetIds: [ids[2]] }] }), code('QUANTITY_EXCEEDED'));
});

test('vehicle delivery uses the assigned order, line and driver and links the original task movement', () => {
  const f = fixture(); f.call('order.create', create()); const ids = f.stock(2); f.move('load', ids, shop, van);
  const task = { id: 'delivery-1', orderId: 'receipt-1', customerId: 'receipt-1', kind: 'delivery', vehicleId: 'van-1', status: 'waiting', assetIds: ids, lineItems: [{ lineId: 'first-ski', assetIds: ids }] };
  f.state.tasks.push(task);
  const payload = { orderId: 'receipt-1', vehicleId: 'van-1', taskId: task.id, lineItems: [{ lineId: 'first-ski', assetIds: ids }] };
  assert.throws(() => f.call('order.issue', payload, { ...driver, actor: { ...driver.actor, vehicleId: 'van-2' } }), code('FORBIDDEN'));
  const result = f.call('order.issue', payload, driver);
  assert.equal(f.order().totals.customerQuantity, 2); assert.equal(f.state.movements.find(m => m.id === result.movementId).taskId, task.id);
});

test('vehicle delivery rejects cross-order and cross-line task assignments', () => {
  const f = fixture(); f.call('order.create', create()); const ids = f.stock(1); f.move('load', ids, shop, van);
  const task = { id: 'delivery', orderId: 'other-order', customerId: 'receipt-1', kind: 'delivery', vehicleId: 'van-1', status: 'waiting', assetIds: ids, plannedItems: [{ itemId: 'other-line', assetIds: ids }] };
  f.state.tasks.push(task);
  const payload = { orderId: 'receipt-1', vehicleId: 'van-1', taskId: task.id, lineItems: [{ lineId: 'first-ski', assetIds: ids }] };
  assert.throws(() => f.call('order.issue', payload), code('INVALID_INPUT'));
  task.orderId = 'receipt-1'; assert.throws(() => f.call('order.issue', payload), code('INVALID_INPUT'));
});

test('ticket demand cannot bypass actual ticket issuance and reservation through order.issue', () => {
  const f = fixture(); f.call('order.create', create({ batch: { id: 'first', lines: [line({ id: 'ticket-line', sku: 'ticket-4h', end: '2026-09-13' })] } }));
  const ids = f.stock(1); const before = copy(f.state);
  assert.throws(() => f.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'ticket-line', assetIds: ids }] }), code('TICKET_UNAVAILABLE'));
  assert.deepEqual(f.state, before);
});

test('order issue cannot take physical stock reserved for another customer delivery', () => {
  const f = fixture(); f.call('order.create', create()); const ids = f.stock(1);
  f.state.tasks.push({ id: 'other-delivery', kind: 'delivery', orderId: 'other-order', customerId: 'other-order', vehicleId: 'van-1', status: 'waiting', assetIds: ids });
  const before = copy(f.state);
  assert.throws(() => f.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'first-ski', assetIds: ids }] }), code('ALREADY_EXISTS'));
  assert.deepEqual(f.state, before); assert.equal(f.order().totals.issuedQuantity, 0);
});

test('cancel blocks issued or task-assigned lines and never partially cancels mixed selections', () => {
  const f = fixture(); f.call('order.create', create());
  f.call('order.add', { orderId: 'receipt-1', batch: { id: 'extra', lines: [line({ id: 'extra-ski' })] } });
  const ids = f.stock(1); f.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'first-ski', assetIds: ids }] });
  const before = copy(f.state);
  assert.throws(() => f.call('order.cancel', { orderId: 'receipt-1', lineIds: ['extra-ski', 'first-ski'], reason: '전체 취소' }), code('DEPENDENT_MOVEMENT'));
  assert.deepEqual(f.state, before);
  f.state.tasks.push({ id: 'next-task', orderId: 'receipt-1', status: 'waiting', plannedItems: [{ itemId: 'extra-ski', quantity: 2, assetIds: [] }] });
  assert.throws(() => f.call('order.cancel', { orderId: 'receipt-1', batchId: 'extra', reason: '추가 취소' }), code('DEPENDENT_MOVEMENT'));
  f.state.tasks[0].status = 'cancelled'; f.call('order.cancel', { orderId: 'receipt-1', batchId: 'extra', reason: '배정 해제 후 취소' });
  assert.equal(f.order().lines[1].cancelledQuantity, 2);
});

test('migration seed keeps issued and confirmed history when initial physical stock is reused', () => {
  const f = fixture(); f.call('order.create', create({ batch: { id: 'first', lines: [line({ quantity: 3 })] } }));
  const customerAssets = f.call('stock.opening', { sku: 'ski', quantity: 1, location: { kind: 'customer', id: 'receipt-1' } }).assetIds;
  const vehicleAssets = f.call('stock.opening', { sku: 'ski', quantity: 1, location: van }).assetIds;
  const returnedAssets = f.stock(1);
  f.state.orders[0].lines[0].initialAssetIds = [...customerAssets, ...vehicleAssets, ...returnedAssets];
  f.state.orders[0].lines[0].initialReturnedAssetIds = returnedAssets;
  let row = f.order().lines[0]; assert.deepEqual([row.issuedQuantity, row.customerQuantity, row.vehicleQuantity, row.shopQuantity], [3, 1, 1, 1]);
  f.call('order.add', { orderId: 'receipt-1', batch: { id: 'again', lines: [line({ id: 'again-ski', quantity: 1 })] } });
  f.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'again-ski', assetIds: returnedAssets }] });
  row = f.order(); assert.equal(row.lines[0].shopQuantity, 1); assert.equal(row.lines[1].customerQuantity, 1);
  f.move('directReturn', customerAssets, { kind: 'customer', id: 'receipt-1' }, shop); f.move('receive', vehicleAssets, van, shop);
  assert.equal(f.order().lines[0].shopQuantity, 3);
  assert.throws(() => f.call('order.cancel', { orderId: 'receipt-1', lineIds: ['first-ski'], reason: '과거 접수 취소' }), code('DEPENDENT_MOVEMENT'));
});

test('migrated non-recoverable issuance and unknown line prices preserve legacy totals without inventing assets', () => {
  const f = fixture(); f.call('order.create', create({ batch: { id: 'first', lines: [line({ quantity: 2, price: { unitWon: 0 } })] } }));
  const order = f.state.orders[0]; order.customer.phone = ''; order.legacyChargeWon = 120000;
  order.lines[0].initialNonReturnQuantity = 2; order.lines[0].price.source = 'legacy-total-only';
  const row = f.order();
  assert.equal(row.amountWon, 120000); assert.equal(row.totals.originalAmountWon, 120000);
  assert.deepEqual([row.totals.issuedQuantity, row.totals.nonReturnQuantity, row.totals.unissuedQuantity], [2, 2, 0]);
  assert.equal(row.status, 'returned'); assert.equal(f.state.assets.length, 0);
  const ids = f.stock(1); assert.throws(() => f.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'first-ski', assetIds: ids }] }), code('QUANTITY_EXCEEDED'));
  f.call('order.add', { orderId: 'receipt-1', batch: { id: 'new', lines: [line({ id: 'new-ski', quantity: 1, price: { unitWon: 10000 } })] } });
  assert.equal(f.order().amountWon, 140000); assert.equal(Orders.list(f.state, { query: '김민수' }).length, 1);
});

test('undoing a direct return restores customer custody, and undoing issue restores unissued demand', () => {
  const f = fixture(); f.call('order.create', create({ batch: { id: 'first', lines: [line({ quantity: 1 })] } }));
  const ids = f.stock(1), delivered = f.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'first-ski', assetIds: ids }] });
  const returned = f.move('directReturn', ids, { kind: 'customer', id: 'receipt-1' }, shop);
  assert.equal(f.order().status, 'returned');
  f.call('movement.undo', { movementId: returned.movementId, reason: '반납 오입력' });
  assert.equal(f.order().totals.customerQuantity, 1); assert.equal(f.order().status, 'in_use');
  f.call('movement.undo', { movementId: delivered.movementId, reason: '반납 정정 뒤 지급 오입력도 복구' });
  assert.equal(f.order().totals.issuedQuantity, 0); assert.equal(f.order().totals.unissuedQuantity, 1);
  const direct = fixture(); direct.call('order.create', create()); const spare = direct.stock(1);
  const issue = direct.call('order.issue', { orderId: 'receipt-1', lineItems: [{ lineId: 'first-ski', assetIds: spare }] });
  direct.call('movement.undo', { movementId: issue.movementId, reason: '지급 오입력' });
  assert.equal(direct.order().totals.issuedQuantity, 0); assert.equal(direct.order().totals.unissuedQuantity, 2);
});

test('read models return detached records, date and person search, and retain cancelled original totals', () => {
  const f = fixture(); f.call('order.create', create());
  assert.equal(Orders.list(f.state, { query: '1234-5678' }).length, 1); assert.equal(Orders.list(f.state, { date: '2026-09-14', status: 'awaiting_issue' }).length, 1);
  assert.equal(Orders.list(f.state, { date: '2026-09-15' }).length, 0); assert.equal(Orders.list(f.state, { query: '  ' }).length, 1);
  const before = copy(f.state), order = f.order(); order.lines[0].price.unitWon = 0; order.customer.name = '바꾼 이름';
  assert.deepEqual(f.state, before);
  f.call('order.cancel', { orderId: 'receipt-1', reason: '미방문' });
  assert.equal(Orders.list(f.state, { status: 'cancelled' }).length, 1); assert.equal(Orders.list(f.state, { date: '2026-09-13' }).length, 0);
  assert.equal(f.order().totals.originalAmountWon, 75000); assert.equal(f.order().amountWon, 0);
});

test('orders UMD browser export loads after existing workflow dependencies', () => {
  const sandbox = vm.createContext({});
  for (const file of ['src/returns/domain.js', 'src/workflows/common.js', 'src/workflows/reservations.js', 'src/workflows/inventory.js', 'src/workflows/orders.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  assert.deepEqual(Object.keys(sandbox.SkiWorkflowOrders).sort(), ['handle', 'initialize', 'list', 'view']);
});

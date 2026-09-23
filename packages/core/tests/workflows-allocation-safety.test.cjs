const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSqliteRepository } = require('../server/returns-repository.cjs');
const { createMemoryRepository, createService: createReturnsService } = require('../src/returns/service.js');
const Inventory = require('../src/workflows/inventory.js');
const { fixture, ctx, shop, van, person, errorCode } = require('./workflows-fixtures.cjs');
const { sample } = require('./returns-fixtures.cjs');

async function prepared(f, id = 'walk-in', count = 1) {
  const form = await f.form(id, count);
  const people = Array.from({ length: count }, (_, i) => ({ ...person(i + 1), equipment: 'ski', helmet: false }));
  await form.submit(people);
  f.call('intake.review', { id, submissionVersion: 1 });
  f.call('intake.prepare', { id, reviewVersion: 1, personIds: people.map(p => p.id) });
  return people;
}
function planned(f, ids) {
  createReturnsService(f.repository, ctx, f.clock).execute({ type: 'create', orderId: 'reserved-order', requestId: 'reserved-order-create', expectedVersion: 0, payload: sample() });
  f.call('task.save', { id: 'reserved-delivery', kind: 'delivery', orderId: 'reserved-order', customerId: 'reserved-customer',
    vehicleId: 'van-1', date: '2026-09-09', time: '10:00', place: '광장', title: '기존 고객 배달',
    plannedItems: [{ itemId: 'ski-line', sku: 'ski', quantity: ids.length }] });
  f.call('task.allocate', { id: 'reserved-delivery', items: [{ itemId: 'ski-line', assetIds: ids }] });
}

for (const mode of ['memory', 'sqlite']) {
  test(mode + ': intake issue cannot take a delivery allocation and rolls back every selected person', async () => {
    const repository = mode === 'sqlite' ? createSqliteRepository(':memory:') : createMemoryRepository();
    try {
      const f = fixture(repository), people = await prepared(f, 'walk-in', 2);
      const ids = f.call('stock.receive', { sku: 'ski', quantity: 2 }).assetIds;
      planned(f, ids.slice(1));
      const before = f.store.snapshot();
      assert.throws(() => f.call('intake.issue', { id: 'walk-in', reviewVersion: 1, from: shop,
        people: people.map((p, i) => ({ personId: p.id, assetIds: [ids[i]] })) }), errorCode('ALREADY_EXISTS'));
      assert.deepEqual(f.store.snapshot(), before);
      assert.equal(f.store.intake('walk-in').issuedPeople, 0);
      f.call('task.status', { id: 'reserved-delivery', status: 'cancelled' });
      f.call('intake.issue', { id: 'walk-in', reviewVersion: 1, from: shop,
        people: people.map((p, i) => ({ personId: p.id, assetIds: [ids[i]] })) });
      assert.equal(f.store.intake('walk-in').issuedPeople, 2);
    } finally { repository.close?.(); }
  });

  test(mode + ': intake dispatch cannot relabel reserved stock even on the same vehicle', async () => {
    const repository = mode === 'sqlite' ? createSqliteRepository(':memory:') : createMemoryRepository();
    try {
      const f = fixture(repository); await prepared(f);
      const ids = f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds; planned(f, ids);
      const before = f.store.snapshot();
      assert.throws(() => f.call('intake.dispatch', { id: 'walk-in', reviewVersion: 1, people: [{ personId: 'person-1', assetIds: ids }],
        taskId: 'stolen-delivery', vehicleId: 'van-1', date: '2026-09-09', time: '11:00', place: '같은 차량' }), errorCode('ALREADY_EXISTS'));
      assert.deepEqual(f.store.snapshot(), before);
    } finally { repository.close?.(); }
  });
}

test('bound stock requires its task for loading and delivery; loading never completes delivery', () => {
  const f = fixture(), ids = f.call('stock.receive', { sku: 'ski', quantity: 2 }).assetIds; planned(f, ids);
  const destination = { kind: 'customer', id: 'reserved-customer' };
  assert.throws(() => f.move('load', ids, shop, van), errorCode('ALREADY_EXISTS'));
  assert.throws(() => f.move('load', ids, shop, { kind: 'vehicle', id: 'van-2' }, { taskId: 'reserved-delivery' }), errorCode('INVALID_INPUT'));
  f.move('load', ids, shop, van, { taskId: 'reserved-delivery' });
  assert.equal(f.driver.board().pending[0].remainingQuantity, 2);
  assert.throws(() => f.call('task.status', { id: 'reserved-delivery', status: 'completed' }), errorCode('QUANTITY_EXCEEDED'));
  assert.throws(() => f.move('deliver', ids, van, { kind: 'customer', id: 'unrelated' }), errorCode('ALREADY_EXISTS'));
  f.move('deliver', ids.slice(0, 1), van, destination, { taskId: 'reserved-delivery' }, f.driver);
  assert.equal(f.driver.board().pending[0].remainingQuantity, 1);
  f.move('deliver', ids.slice(1), van, destination, { taskId: 'reserved-delivery' }, f.driver);
  f.call('task.status', { id: 'reserved-delivery', status: 'completed' });
  f.move('directReturn', ids, destination, shop);
  f.move('deliver', ids, shop, { kind: 'customer', id: 'new-customer' });
});

test('explicit task cannot bypass a second equipment allocation; undo restores its claim', () => {
  const f = fixture(), ids = f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds;
  f.task('first', 'delivery', 'a', ids); f.task('second', 'delivery', 'b', ids);
  assert.throws(() => f.move('deliver', ids, shop, { kind: 'customer', id: 'a' }, { taskId: 'first' }), errorCode('ALREADY_EXISTS'));
  f.call('task.status', { id: 'second', status: 'cancelled' });
  const delivered = f.move('deliver', ids, shop, { kind: 'customer', id: 'a' }, { taskId: 'first' });
  f.call('movement.undo', { movementId: delivered.movementId, reason: '실제 지급 전 정정' });
  assert.throws(() => f.move('deliver', ids, shop, { kind: 'customer', id: 'b' }), errorCode('ALREADY_EXISTS'));
});

test('stock selection skips assigned equipment and supports the explicitly bound task', () => {
  const f = fixture(), ids = f.call('stock.receive', { sku: 'ski', quantity: 2 }).assetIds; planned(f, ids.slice(0, 1));
  const state = f.repository.workflows(ctx.shopId);
  assert.equal(Inventory.allocatable(state, state.assets.find(a => a.id === ids[0])), false);
  assert.deepEqual(Inventory.select(state, shop, [{ sku: 'ski', quantity: 1 }]), ids.slice(1));
  assert.deepEqual(Inventory.select(state, shop, [{ sku: 'ski', quantity: 1 }], { kind: 'load', to: van, taskId: 'reserved-delivery' }), ids.slice(0, 1));
});

test('nonoverlapping ticket reservations retain their own delivery tasks across reuse', () => {
  const f = fixture();
  f.book('morning', [{ id: 'am', useDate: '2026-09-09', startTime: '09:00', endTime: '12:00', ticketType: 'ticket-3h', quantity: 1 }]);
  f.book('afternoon', [{ id: 'pm', useDate: '2026-09-09', startTime: '14:00', endTime: '18:00', ticketType: 'ticket-4h', quantity: 1 }]);
  const ids = f.issue(1, { reservationId: 'morning', lineId: 'am' });
  f.call('ticket.allocate', { reservationId: 'afternoon', lineId: 'pm', assetIds: ids });
  f.task('morning-task', 'delivery', 'morning', ids); f.task('afternoon-task', 'delivery', 'afternoon', ids, '14:00');
  f.move('load', ids, shop, van, { taskId: 'morning-task' });
  f.move('deliver', ids, van, { kind: 'customer', id: 'morning' }, { taskId: 'morning-task' }, f.driver);
  f.task('morning-return', 'collection', 'morning', ids, '12:00');
  f.setTime('2026-09-09T03:00:00.000Z');
  f.move('collect', ids, { kind: 'customer', id: 'morning' }, van, { taskId: 'morning-return' }, f.driver);
  f.move('deliver', ids, van, { kind: 'customer', id: 'afternoon' }, { taskId: 'afternoon-task' }, f.driver);
  assert.equal(f.store.snapshot().allocations.filter(a => a.fulfilledAt).length, 2);
});

test('consecutive undo restores effective custody in reverse order while every correction advances the audit', () => {
  const f = fixture(), ids = f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds;
  const customer = { kind: 'customer', id: 'customer' };
  const loaded = f.move('load', ids, shop, van);
  const delivered = f.move('deliver', ids, van, customer);
  const collected = f.move('collect', ids, customer, van);
  const received = f.move('receive', ids, van, shop);
  const beforeRevision = f.store.snapshot().revision;
  for (const [step, location] of [[received, van], [collected, customer], [delivered, van], [loaded, shop]]) {
    f.call('movement.undo', { movementId: step.movementId, reason: '잘못 기록한 이동을 역순으로 정정' });
    assert.deepEqual(f.store.snapshot().assets.find(asset => asset.id === ids[0]).location, location);
  }
  assert.equal(f.store.snapshot().revision, beforeRevision + 4);
  assert.equal(f.store.history().corrections.length, 4);
  assert.throws(() => f.call('movement.undo', { movementId: loaded.movementId, reason: '중복 정정' }), errorCode('NO_CHANGE'));
});

test('new allocation, refund or maintenance after an undo still blocks reversing an older movement', () => {
  const allocated = fixture(), tickets = allocated.issue(1);
  const load = allocated.move('load', tickets, shop, van);
  const receive = allocated.move('receive', tickets, van, shop);
  allocated.call('movement.undo', { movementId: receive.movementId, reason: '차량에 그대로 있음' });
  allocated.book('reserved'); allocated.call('ticket.allocate', { reservationId: 'reserved', lineId: 'line-1', assetIds: tickets });
  assert.throws(() => allocated.call('movement.undo', { movementId: load.movementId, reason: '후속 배정 이후' }), errorCode('DEPENDENT_MOVEMENT'));
  allocated.call('refund.plan', { id: 'refund', assetIds: tickets, vehicleId: 'van-1', vendorId: 'resort-1', date: '2026-09-09', time: '12:00', place: '발권소' });
  allocated.call('refund.complete', { id: 'refund', assetIds: tickets, amountWon: 10000 }, allocated.driver);
  assert.throws(() => allocated.call('movement.undo', { movementId: load.movementId, reason: '환불 후' }), errorCode('DEPENDENT_MOVEMENT'));
  const maintained = fixture(), equipment = maintained.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds;
  const loaded = maintained.move('load', equipment, shop, van), received = maintained.move('receive', equipment, van, shop);
  maintained.call('movement.undo', { movementId: received.movementId, reason: '잘못 인수 확인' });
  maintained.call('management.asset', { assetIds: equipment, condition: 'inspection', reason: '차량 보관품 점검 필요' });
  assert.throws(() => maintained.call('movement.undo', { movementId: loaded.movementId, reason: '후속 점검 이후' }), errorCode('DEPENDENT_MOVEMENT'));
});

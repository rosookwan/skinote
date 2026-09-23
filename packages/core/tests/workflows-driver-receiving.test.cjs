const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, customer, shop, van, errorCode } = require('./workflows-fixtures.cjs');
const { newCommand } = require('../src/workflows/client.js');

function recovered() {
  const f = fixture();
  f.call('order.create', { id: 'rental', customer, people: [], batch: { id: 'rental-batch', lines: [{ id: 'ski-line', sku: 'ski', quantity: 4, start: '2026-09-09', end: '2026-09-09', price: { unitWon: 20000 } }] } });
  const ids = f.call('stock.receive', { sku: 'ski', quantity: 5 }).assetIds;
  f.call('ops.issue', { orderId: 'rental', lineItems: [{ lineId: 'ski-line', assetIds: ids.slice(0, 4) }] });
  for (const [assetIds, vehicleId] of [[ids.slice(0, 2), 'van-1'], [[ids[2]], 'van-2']]) f.call('ops.return', { orderId: 'rental', mode: 'collect', vehicleId, lineItems: [{ lineId: 'ski-line', assetIds }] });
  f.move('load', [ids[4]], shop, van, { purpose: 'spare' });
  return { ...f, ids };
}
const payload = ids => ({ kind: 'receive', assetIds: ids, from: van, to: shop });

test('driver receives only selected recovered items; store can receive the remaining items across vans', () => {
  const f = recovered(), before = f.store.snapshot(), money = before.orders[0].finance;
  f.move('receive', [f.ids[0]], van, shop, {}, f.driver);
  const after = f.store.snapshot();
  assert.equal(after.orders[0].totals.vehicleQuantity, 2);
  assert.equal(after.orders[0].totals.customerQuantity, 1);
  assert.equal(after.orders[0].totals.shopQuantity, 1);
  assert.deepEqual(after.orders[0].finance, money);
  const movement = f.repository.workflows('shop-1').movements.at(-1);
  assert.equal(movement.actor.role, 'driver'); assert.equal(movement.actor.vehicleId, 'van-1');
  assert.deepEqual(movement.assetIds, [f.ids[0]]);
  f.call('ops.receive', { orderId: 'rental', assetIds: f.ids.slice(1, 3) });
  assert.equal(f.store.snapshot().orders[0].totals.vehicleQuantity, 0);
  assert.equal(f.store.snapshot().orders[0].totals.shopQuantity, 3);
  assert.deepEqual(f.store.snapshot().orders[0].finance, money);
  assert.deepEqual(f.driver.vehicle().assets.map(a => a.id), [f.ids[4]]);
});

test('driver cannot receive another van, uncollected customer items, spare stock, or a mixed invalid selection', () => {
  const f = recovered();
  for (const [p, code] of [
    [{ ...payload([f.ids[2]]), from: { kind: 'vehicle', id: 'van-2' } }, 'FORBIDDEN'],
    [payload([f.ids[0], f.ids[2]]), 'QUANTITY_EXCEEDED'],
    [payload([f.ids[3]]), 'QUANTITY_EXCEEDED'],
    [payload([f.ids[0], f.ids[4]]), 'FORBIDDEN'],
    [{ ...payload([f.ids[0]]), to: { kind: 'shop', id: 'another-shop' } }, 'FORBIDDEN'],
    [payload([]), 'INVALID_INPUT'], [payload([f.ids[0], f.ids[0]]), 'INVALID_INPUT']
  ]) {
    const before = f.store.snapshot();
    assert.throws(() => f.call('stock.move', p, f.driver), errorCode(code));
    assert.deepEqual(f.store.snapshot(), before, 'rejected selection must not partially move items');
  }
  assert.equal(f.driver.snapshot().orders, undefined); assert.equal(f.driver.snapshot().finance, undefined);
});

test('lost and redelivery-assigned recovered items are excluded from driver receiving', () => {
  const f = recovered();
  f.call('management.asset', { assetIds: [f.ids[0]], condition: 'lost', reason: '차량 분실 확인' });
  f.task('redelivery', 'delivery', 'next-customer', [f.ids[1]], '14:00');
  assert.equal(f.driver.vehicle().totals.find(t => t.sku === 'ski').receivePending, 0);
  assert.deepEqual(f.driver.vehicle().assets.map(a => [a.id, a.stockState]), [[f.ids[0], 'check'], [f.ids[1], 'delivery'], [f.ids[4], 'spare']]);
  for (const id of f.ids.slice(0, 2)) {
    const before = f.store.snapshot();
    assert.throws(() => f.move('receive', [id], van, shop, {}, f.driver), errorCode('FORBIDDEN'));
    assert.deepEqual(f.store.snapshot(), before);
  }
});

test('reserved and refundable recovered tickets stay on the van until their assigned workflow is handled', () => {
  const f = fixture();
  f.book('tickets'); const ids = f.issue(1, { reservationId: 'tickets', lineId: 'line-1' });
  f.move('load', ids, shop, van); f.task('deliver', 'delivery', 'tickets', ids);
  f.move('deliver', ids, van, { kind: 'customer', id: 'tickets' }, { taskId: 'deliver' }, f.driver);
  f.task('collect', 'collection', 'tickets', ids);
  f.move('collect', ids, { kind: 'customer', id: 'tickets' }, van, { taskId: 'collect' }, f.driver);
  f.book('future', [{ id: 'later', useDate: '2026-09-10', ticketType: 'ticket-6h', quantity: 1 }]);
  f.call('ticket.allocate', { reservationId: 'future', lineId: 'later', assetIds: ids });
  assert.equal(f.driver.vehicle().assets[0].stockState, 'delivery');
  assert.throws(() => f.move('receive', ids, van, shop, {}, f.driver), errorCode('FORBIDDEN'));
  f.call('ticket.release', { allocationIds: f.store.snapshot().allocations.filter(a => a.reservationId === 'future' && a.status === 'active').map(a => a.id) });
  f.call('refund.plan', { id: 'refund', assetIds: ids, vehicleId: 'van-1', vendorId: 'resort-1', date: '2026-09-09', time: '15:00', place: '발권소' });
  const before = f.store.snapshot();
  assert.equal(f.driver.vehicle().assets[0].stockState, 'refund');
  assert.throws(() => f.move('receive', ids, van, shop, {}, f.driver), errorCode('FORBIDDEN'));
  assert.deepEqual(f.store.snapshot(), before);
});

test('driver receiving is atomic on stale data and idempotent after an uncertain response', () => {
  const f = recovered(), command = newCommand('stock.move', f.driver.snapshot(), payload(f.ids.slice(0, 2)));
  f.call('stock.receive', { sku: 'helmet', quantity: 1 });
  const before = f.store.snapshot();
  assert.throws(() => f.driver.execute(command), errorCode('VERSION_CONFLICT'));
  assert.deepEqual(f.store.snapshot(), before);
  const fresh = newCommand('stock.move', f.driver.snapshot(), payload(f.ids.slice(0, 2)));
  const first = f.driver.execute(fresh), saved = f.store.snapshot(), second = f.driver.execute(fresh);
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true);
  assert.deepEqual(f.store.snapshot(), saved);
  assert.throws(() => f.driver.execute({ ...fresh, payload: payload([f.ids[0]]) }), errorCode('IDEMPOTENCY_CONFLICT'));
});

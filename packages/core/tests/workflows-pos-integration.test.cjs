const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, customer, shop, van } = require('./workflows-fixtures.cjs');

test('unified dispatch notifications follow actual movements and close when the driver finishes, without duplicate emissions', () => {
  const f = fixture();
  f.call('order.create', { id: 'team', customer, batch: { id: 'first', lines: [{ id: 'ski-line', sku: 'ski', quantity: 2, start: '2026-09-09', end: '2026-09-09', price: { unitWon: 10000 } }] } });
  const ids = f.call('stock.receive', { sku: 'ski', quantity: 2 }).assetIds;
  const command = { type: 'ops.dispatch', requestId: 'once', expectedVersion: f.store.snapshot().revision, payload: { orderId: 'team', id: 'delivery', lineItems: [{ lineId: 'ski-line', assetIds: ids }], vehicleId: 'van-1', date: '2026-09-09', time: '10:00', place: '입구' } };
  f.store.execute(command);
  const notices = f.driver.snapshot().notifications;
  assert.ok(notices.records.some(n => n.taskId === 'delivery' && n.type === 'workflow-task' && n.lifecycle === 'active'));
  assert.ok(notices.records.some(n => n.type === 'load'));
  f.store.execute(command); assert.deepEqual(f.driver.snapshot().notifications, notices);
  f.call('ops.taskMove', { taskId: 'delivery', assetIds: ids }, f.driver);
  assert.equal(f.driver.snapshot().notifications.records.find(n => n.taskId === 'delivery' && n.type === 'workflow-task').lifecycle, 'resolved');
  assert.ok(f.store.snapshot().notifications.records.some(n => n.title === '고객 전달 내역'));
  assert.equal(f.store.snapshot().orders[0].totals.customerQuantity, 2);
  f.call('ops.schedule', { orderId: 'team', lineItems: [{ lineId: 'ski-line', assetIds: ids }], date: '2026-09-09', time: '17:00', place: '입구', vehicleId: 'van-1' });
  const task = f.driver.snapshot().tasks.find(t => t.kind === 'collection');
  f.call('ops.taskMove', { taskId: task.id, assetIds: ids.slice(0, 1) }, f.driver);
  assert.equal(f.store.snapshot().orders[0].totals.vehicleQuantity, 1);
  assert.equal(f.driver.snapshot().notifications.records.find(n => n.taskId === task.id && n.type === 'workflow-task').lifecycle, 'active');
  assert.ok(f.store.snapshot().notifications.records.some(n => n.title === '차량 수거 내역'));
});

test('a cancellation that would leave negative charges rolls back the order and financial journal', () => {
  const f = fixture();
  f.call('order.create', { id: 'team', customer, batch: { id: 'first', lines: [{ id: 'ski-line', sku: 'ski', quantity: 1, start: '2026-09-09', end: '2026-09-09', price: { unitWon: 10000 } }] } });
  f.call('finance.adjustment', { id: 'discount', orderId: 'team', amountWon: -5000, reason: '팀 할인' });
  const before = f.store.snapshot();
  assert.throws(() => f.call('order.cancel', { orderId: 'team', lineIds: ['ski-line'], reason: '미도착' }), e => e.code === 'INVALID_INPUT');
  assert.deepEqual(f.store.snapshot(), before);
});

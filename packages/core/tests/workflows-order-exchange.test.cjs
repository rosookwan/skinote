const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, customer, shop } = require('./workflows-fixtures.cjs');
const plan = { method: 'direct', date: '2026-09-09', time: '17:00', place: '매장', vehicleId: 'van-1' };
function setup(kind = 'ski', method = 'shop') {
  const f = fixture();
  f.call('order.create', { id: 'team', customer, batch: { id: 'first', lines: [{ id: 'ski-line', sku: 'ski', quantity: 1, start: '2026-09-09', end: '2026-09-09', price: { unitWon: 10000 } }] } });
  const old = f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds[0];
  f.call('order.issue', { orderId: 'team', lineItems: [{ lineId: 'ski-line', assetIds: [old] }] });
  f.call('exchange.request', { id: 'swap', orderId: 'team', customerId: 'team', customerName: customer.name, kind, baseAssetIds: [old], reason: 'size', oldSize: '150', newSize: '160', method, visit: { ...plan, method: method === 'vehicle' ? 'vehicle' : 'direct' }, returnPlan: { ...plan, method: method === 'vehicle' ? 'vehicle' : 'direct' }, ...(kind !== 'ski' ? { confirmExistingComponent: true } : {}) });
  const replacement = f.call('stock.receive', { sku: kind, quantity: 1 }).assetIds[0];
  f.call('exchange.prepare', { id: 'swap', assetIds: [replacement] });
  const load = method === 'vehicle' ? f.move('load', [replacement], shop, { kind: 'vehicle', id: 'van-1' }, { taskId: 'swap-new' }) : null;
  const delivery = f.move('deliver', [replacement], method === 'vehicle' ? { kind: 'vehicle', id: 'van-1' } : shop, { kind: 'customer', id: 'team' }, method === 'vehicle' ? { taskId: 'swap-new' } : { exchangeId: 'swap' });
  return { ...f, old, replacement, load, delivery, order: () => f.store.snapshot().orders[0] };
}
test('replacement and outstanding old equipment stay visible on the same line without increasing original charge or issued count', () => {
  const f = setup(), row = f.order().lines[0];
  assert.equal(row.issuedQuantity, 1); assert.equal(f.order().finance.chargedWon, 10000);
  assert.deepEqual(row.customerAssetIds.sort(), [f.old, f.replacement].sort());
  assert.equal(row.exchangeOutstandingQuantity, 1); assert.equal(f.order().status, 'awaiting_exchange');
  f.move('directReturn', [f.old], { kind: 'customer', id: 'team' }, shop, { exchangeId: 'swap' });
  assert.deepEqual(f.order().lines[0].customerAssetIds, [f.replacement]);
  assert.equal(f.order().status, 'in_use');
  f.move('directReturn', [f.replacement], { kind: 'customer', id: 'team' }, shop);
  assert.equal(f.order().status, 'returned'); assert.equal(f.order().lines[0].shopQuantity, 1);
  f.call('order.add', { orderId: 'team', batch: { id: 'second', lines: [{ id: 'later-ski', sku: 'ski', quantity: 1, start: '2026-09-09', end: '2026-09-09', price: { unitWon: 20000 } }] } });
  f.call('order.issue', { orderId: 'team', lineItems: [{ lineId: 'later-ski', assetIds: [f.old] }] });
  assert.deepEqual(f.order().lines[0].customerAssetIds, []);
  assert.deepEqual(f.order().lines[1].customerAssetIds, [f.old]);
});
test('exchanged set component has its own return row and cannot disappear when the main ski returns', () => {
  const f = setup('ski-boots'), o = f.order(), component = o.lines.find(l => l.component);
  assert.ok(component); assert.equal(o.finance.chargedWon, 10000);
  const oldBoot = f.store.snapshot().exchanges[0].units[0].oldAssetId;
  assert.deepEqual(component.customerAssetIds.sort(), [oldBoot, f.replacement].sort());
  f.move('directReturn', [oldBoot], { kind: 'customer', id: 'team' }, shop, { exchangeId: 'swap' });
  f.move('directReturn', [f.old], { kind: 'customer', id: 'team' }, shop);
  assert.equal(f.order().totals.customerQuantity, 1);
  assert.deepEqual(f.order().lines.find(l => l.component).customerAssetIds, [f.replacement]);
});
test('exchange corrections recover receipt, collection, delivery and loading in reverse order without removing normal guards', () => {
  const f = setup('ski', 'vehicle'), customerLocation = { kind: 'customer', id: 'team' }, van = { kind: 'vehicle', id: 'van-1' };
  const collected = f.move('collect', [f.old], customerLocation, van, { taskId: 'swap-old' });
  const received = f.move('receive', [f.old], van, shop);
  assert.equal(f.store.snapshot().exchanges[0].status, 'completed');
  assert.throws(() => f.call('movement.undo', { movementId: received.movementId, reason: '일반 정정 금지' }), e => e.code === 'DEPENDENT_MOVEMENT');
  assert.throws(() => f.call('exchange.recover', { id: 'swap', movementId: collected.movementId, reason: '입고 먼저 정정해야 함' }), e => e.code === 'DEPENDENT_MOVEMENT');
  for (const movement of [received, collected, f.delivery, f.load]) f.call('exchange.recover', { id: 'swap', movementId: movement.movementId, reason: '실물 확인 후 오입력 정정' });
  const state = f.store.snapshot(), exchange = state.exchanges[0];
  assert.equal(exchange.recoveries.length, 4); assert.equal(exchange.units[0].deliveredAt, undefined); assert.equal(exchange.units[0].receivedAt, undefined);
  assert.equal(state.assets.find(a => a.id === f.old).location.kind, 'customer'); assert.equal(state.assets.find(a => a.id === f.replacement).location.kind, 'shop');
  assert.equal(state.tasks.find(t => t.id === 'swap-return-0').status, 'cancelled');
  f.call('exchange.cancel', { id: 'swap', reason: '실제로는 교환하지 않음' });
  assert.equal(f.order().totals.issuedQuantity, 1); assert.deepEqual(f.order().lines[0].customerAssetIds, [f.old]);
  assert.equal(f.store.history().corrections.length, 4);
});
test('undone exchange delivery can be delivered again with its return obligation restored', () => {
  const f = setup('ski', 'vehicle');
  f.call('exchange.recover', { id: 'swap', movementId: f.delivery.movementId, reason: '전달 수량 오입력' });
  f.move('deliver', [f.replacement], { kind: 'vehicle', id: 'van-1' }, { kind: 'customer', id: 'team' }, { taskId: 'swap-new' });
  assert.equal(f.store.snapshot().tasks.find(t => t.id === 'swap-return-0').status, 'waiting');
  assert.deepEqual(f.order().lines[0].customerAssetIds.sort(), [f.old, f.replacement].sort());
});

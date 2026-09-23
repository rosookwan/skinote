const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, shop, van, errorCode } = require('./workflows-fixtures.cjs');
const { newCommand } = require('../src/workflows/client.js');
const { createService } = require('../src/workflows/service.js');
function setup(repository) {
  const f = fixture(repository), customer = { kind: 'customer', id: 'rental' };
  const skis = f.call('stock.receive', { sku: 'ski', quantity: 2 }).assetIds, wear = f.call('stock.receive', { sku: 'clothing', quantity: 2 }).assetIds;
  f.move('deliver', [...skis, ...wear], shop, customer); f.task('regular', 'collection', 'rental', [...skis, ...wear], '16:30');
  const payload = { id: 'early-1', orderId: 'rental', customerName: '김영희', assetIds: skis.slice(0, 1), reason: 'injury', memo: '일행 1명 부상', method: 'vehicle', visit: { date: '2026-09-09', time: '13:00', place: '만선 티롤 앞', vehicleId: 'van-1' } };
  return { ...f, skis, wear, customer, payload, state: () => f.store.snapshot(), early: () => f.store.snapshot().earlyReturns[0] };
}
test('one of two skis gets its own early collection while the other ski and clothing keep the original visit', () => {
  const f = setup(), before = f.state().assets; f.call('earlyReturn.create', f.payload);
  assert.deepEqual(f.state().assets, before, 'scheduling moves no physical inventory');
  const regular = f.state().tasks.find(t => t.id === 'regular'), early = f.state().tasks.find(t => t.earlyReturnId);
  assert.deepEqual(regular.assetIds, [f.skis[1], ...f.wear]); assert.equal(regular.time, '16:30'); assert.equal(early.time, '13:00'); assert.deepEqual(early.assetIds, f.skis.slice(0, 1)); assert.match(early.memo, /조기반납.*스키 1대.*부상/);
  assert.ok(f.driver.snapshot().notifications.records.some(n => n.taskId === early.id));
  f.move('collect', early.assetIds, f.customer, van, { taskId: early.id }, f.driver);
  assert.equal(f.early().collectedQuantity, 1); assert.equal(f.early().receivedQuantity, 0);
  f.move('receive', early.assetIds, van, shop); assert.equal(f.early().status, 'completed');
  assert.equal(f.state().assets.filter(a => a.location.kind === 'customer').length, 3);
});
test('splitting an already partial visit preserves its completed movements and remaining schedule', () => {
  const f = setup(); f.move('collect', f.wear.slice(0, 1), f.customer, van, { taskId: 'regular' }); f.call('task.status', { id: 'regular', status: 'in_progress' });
  const before = f.store.history().movements;
  f.call('earlyReturn.create', f.payload);
  const regular = f.state().tasks.find(t => t.id === 'regular'); assert.equal(regular.status, 'in_progress'); assert.deepEqual(regular.assetIds, [f.skis[1], ...f.wear]); assert.deepEqual(f.store.history().movements, before);
  assert.equal(f.state().assets.find(a => a.id === f.wear[0]).location.kind, 'vehicle');
});
test('direct early return records the injury and supports correction without returning the rest', () => {
  const f = setup(), payload = { ...f.payload, method: 'direct' }; delete payload.visit;
  f.call('earlyReturn.create', payload); assert.equal(f.early().status, 'completed');
  const m = f.store.history().movements.at(-1); assert.equal(m.reason, '부상'); assert.equal(m.memo, '일행 1명 부상'); assert.equal(m.earlyReturnId, 'early-1');
  assert.deepEqual(f.state().tasks.find(t => t.id === 'regular').fulfilledElsewhereAssetIds, f.skis.slice(0, 1));
  f.call('movement.undo', { movementId: m.id, reason: '잘못 선택한 한 대 정정' }); assert.equal(f.early().status, 'corrected'); assert.equal(f.early().receivedQuantity, 0);
  assert.equal(f.state().assets.filter(a => a.location.kind === 'customer').length, 4);
});
test('invalid, foreign, duplicate, already-collected and driver requests leave schedules and inventory unchanged', () => {
  const f = setup(), before = f.state();
  for (const payload of [{ ...f.payload, assetIds: [] }, { ...f.payload, visit: { ...f.payload.visit, time: '17:00' } }, { ...f.payload, orderId: 'other' }, { ...f.payload, reason: 'other', memo: '' }]) assert.throws(() => f.call('earlyReturn.create', payload));
  assert.deepEqual(f.state().tasks, before.tasks); assert.deepEqual(f.state().assets, before.assets);
  assert.throws(() => f.call('earlyReturn.create', f.payload, f.driver), errorCode('FORBIDDEN'));
  const command = newCommand('earlyReturn.create', f.state(), f.payload); f.store.execute(command); assert.equal(f.store.execute(command).duplicate, true);
  assert.throws(() => f.call('earlyReturn.create', { ...f.payload, id: 'early-2' }), errorCode('ALREADY_EXISTS'));
  const stale = newCommand('earlyReturn.create', f.state(), { ...f.payload, id: 'early-other', assetIds: f.skis.slice(1) }); f.call('stock.receive', { sku: 'helmet', quantity: 1 }); assert.throws(() => f.store.execute(stale), errorCode('VERSION_CONFLICT'));
  const otherDriver = createService(f.repository, { shopId: 'shop-1', actor: { role: 'driver', id: 'driver-2', vehicleId: 'van-2' } }, f.clock);
  assert.throws(() => f.move('collect', f.skis.slice(0, 1), f.customer, van, { taskId: 'early-1-collect-0' }, otherDriver), errorCode('FORBIDDEN'));
  f.move('collect', f.skis.slice(0, 1), f.customer, van, { taskId: 'early-1-collect-0' });
  assert.throws(() => f.call('earlyReturn.create', { ...f.payload, id: 'early-3' }), /현재 고객/);
});
test('direct return after an early pickup reservation resolves its actual custody without retaining a false pickup', () => {
  const f = setup(); f.call('earlyReturn.create', f.payload); f.move('directReturn', f.skis.slice(0, 1), f.customer, shop);
  assert.equal(f.state().tasks.find(t => t.earlyReturnId).status, 'completed'); assert.equal(f.early().status, 'completed'); assert.equal(f.early().receivedQuantity, 1);
  assert.equal(f.state().tasks.find(t => t.id === 'regular').status, 'waiting');
});
test('component exchange must hand over the replacement before its ski can return early, and each piece keeps its own return', () => {
  const f = setup(), visit = { ...f.payload.visit, method: 'vehicle' };
  f.call('exchange.request', { id: 'boots-1', orderId: 'rental', customerId: 'rental', customerName: '김영희', kind: 'ski-boots', baseAssetIds: f.skis.slice(0, 1), reason: 'size', oldSize: '255', newSize: '260', memo: '', method: 'shop', visit, returnPlan: { ...visit, time: '16:30' }, confirmExistingComponent: true });
  const before = f.state(); assert.throws(() => f.call('earlyReturn.create', f.payload), /교환/); assert.deepEqual(f.state().tasks, before.tasks);
  const boots = f.call('stock.receive', { sku: 'ski-boots', quantity: 1, size: '260', sourceReference: 'early-exchange-boots' }).assetIds;
  f.call('exchange.prepare', { id: 'boots-1', assetIds: boots }); f.move('deliver', boots, shop, f.customer, { exchangeId: 'boots-1' });
  f.call('earlyReturn.create', f.payload);
  assert.deepEqual(f.state().tasks.find(t => t.earlyReturnId).assetIds, f.skis.slice(0, 1));
  assert.deepEqual(f.state().tasks.find(t => t.id === 'boots-1-return-0').assetIds, boots);
  assert.equal(f.state().tasks.find(t => t.id === 'boots-1-return-0').time, '16:30');
  f.move('collect', f.skis.slice(0, 1), f.customer, van, { taskId: 'early-1-collect-0' }); f.move('receive', f.skis.slice(0, 1), van, shop);
  assert.equal(f.early().status, 'completed'); assert.equal(f.state().assets.find(a => a.id === boots[0]).location.kind, 'customer');
  assert.equal(f.state().exchanges[0].status, 'open', 'early return does not close outstanding old boots recovery');
});
test('early return is durable across SQLite reopen and keeps original quantities and plans', t => {
  const { createSqliteRepository } = require('../server/returns-repository.cjs');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skinote-early-')), file = path.join(dir, 'test.sqlite');
  let repository = createSqliteRepository(file); t.after(() => { repository.close(); fs.rmSync(dir, { recursive: true }); });
  const f = setup(repository); f.call('earlyReturn.create', f.payload); const before = f.state(); repository.close(); repository = createSqliteRepository(file);
  const next = fixture(repository).store.snapshot(); assert.deepEqual(next.earlyReturns, before.earlyReturns); assert.deepEqual(next.tasks, before.tasks); assert.deepEqual(next.assets, before.assets);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { ctx, sample, errorCode } = require('./returns-fixtures.cjs');
const { createMemoryRepository, createService } = require('../src/returns/service.js');
const { createSqliteRepository } = require('../server/returns-repository.cjs');
const command = (type, payload, expectedVersion, requestId) => ({ type, payload, orderId: 'order-1', expectedVersion, requestId });
const create = () => command('create', sample(), 0, 'create-1');
const issue = () => command('issue', { items: [{ itemId: 'ski', quantity: 2 }, { itemId: 'clothes', quantity: 2 }, { itemId: 'ticket', quantity: 2 }] }, 1, 'issue-1');
const collect = () => command('collect', { items: [{ itemId: 'ski', quantity: 2 }] }, 2, 'collect-1');

for (const storage of ['memory', 'sqlite']) {
  test(`${storage}: shared clients observe updates, scope is isolated, conflicts are atomic`, () => {
    const repository = storage === 'sqlite' ? createSqliteRepository(':memory:') : createMemoryRepository();
    try {
      const store = createService(repository, ctx);
      const driver = createService(repository, { ...ctx, actor: { id: 'driver-1', role: 'driver', vehicleId: 'van-1' } });
      const other = createService(repository, { ...ctx, shopId: 'other-shop' });
      const otherDriver = createService(repository, { ...ctx, actor: { id: 'driver-2', role: 'driver', vehicleId: 'van-2' } });
      store.execute(create()); store.execute(issue());
      const initial = driver.sync(); assert.equal(initial.orders.length, 1);
      const update = driver.execute(collect());
      assert.equal(update.order.totals.vehicleQuantity, 2);
      assert.equal(update.order.rental, undefined);
      assert.equal(update.order.items[2].recoveryValueWon, undefined);
      assert.equal(update.order.items[0].usage, undefined);
      const change = store.sync(initial.revision);
      assert.equal(change.orders[0].status, 'partial_return');
      assert.equal(store.sync(change.revision).orders.length, 0);
      assert.equal(other.sync().orders.length, 0);
      assert.throws(() => other.get('order-1'), errorCode('NOT_FOUND'));
      assert.throws(() => otherDriver.get('order-1'), errorCode('NOT_FOUND'));
      assert.equal(otherDriver.list().length, 0);
      assert.throws(() => driver.report(), errorCode('FORBIDDEN'));
      assert.throws(() => driver.history('order-1'), errorCode('FORBIDDEN'));
      assert.throws(() => store.execute(command('receiveDirect', { items: [{ itemId: 'ticket', quantity: 2 }] }, 2, 'stale-1')), errorCode('VERSION_CONFLICT'));
      assert.equal(store.get('order-1').version, 3);
      assert.equal(driver.execute(collect()).duplicate, true);
      assert.equal(store.sync(change.revision).revision, change.revision);
      assert.throws(() => store.list({ shopId: 'other-shop' }), errorCode('INVALID_INPUT'));
    } finally { repository.close?.(); }
  });
}
test('SQLite restarts retain counts, audit, version and duplicate request protection', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ski-returns-'));
  const file = path.join(dir, 'ledger.sqlite'); let repository;
  try {
    repository = createSqliteRepository(file);
    let store = createService(repository, ctx);
    store.execute(create()); store.execute(issue()); store.execute(collect());
    const version = store.sync().revision;
    repository.close(); repository = createSqliteRepository(file);
    store = createService(repository, ctx);
    assert.equal(store.get('order-1').totals.vehicleQuantity, 2);
    assert.equal(store.history('order-1').length, 3);
    assert.equal(store.sync().revision, version);
    assert.equal(store.execute(collect()).duplicate, true);
    assert.equal(store.history('order-1').length, 3);
    const connection2 = createSqliteRepository(file);
    try {
      const secondStore = createService(connection2, ctx);
      store.execute(command('receiveDirect', { items: [{ itemId: 'ticket', quantity: 1 }] }, 3, 'direct-1'));
      assert.equal(secondStore.get('order-1').version, 4);
      assert.throws(() => secondStore.execute(command('receiveDirect', { items: [{ itemId: 'ticket', quantity: 1 }] }, 3, 'direct-stale')), errorCode('VERSION_CONFLICT'));
      assert.equal(secondStore.get('order-1').items[2].shopQuantity, 1);
    } finally { connection2.close(); }
  } finally { repository?.close(); rmSync(dir, { recursive: true, force: true }); }
});

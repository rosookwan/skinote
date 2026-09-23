const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const R = require('../src/returns/service.js');
const W = require('../src/workflows/service.js');
const { createSqliteRepository } = require('../server/returns-repository.cjs');
const { ctx } = require('./workflows-fixtures.cjs');
const clock = () => '2026-09-13T00:00:00.000Z';
function seed(repository, id = 'old-1') {
  const service = R.createService(repository, ctx, clock);
  service.execute({ type: 'create', orderId: id, requestId: 'create-' + id, expectedVersion: 0,
    payload: { customer: { id: 'customer-1', name: '김민재', phone: '010-1234-5678' }, rental: { startDate: '2026-09-12', endDate: '2026-09-14', amountWon: 123000 }, vehicleId: 'van-2',
      items: [{ id: 'ski', label: '스키', category: 'equipment', plannedQuantity: 4, returnPlan: { method: 'vehicle', date: '2026-09-14' } }] } });
  service.execute({ type: 'issue', orderId: id, requestId: 'issue-' + id, expectedVersion: 1, payload: { items: [{ itemId: 'ski', quantity: 3 }] } });
  service.execute({ type: 'receiveDirect', orderId: id, requestId: 'return-' + id, expectedVersion: 2, payload: { items: [{ itemId: 'ski', quantity: 1 }] } });
  const driver = R.createService(repository, { ...ctx, actor: { id: 'driver-2', role: 'driver', vehicleId: 'van-2' } }, clock);
  driver.execute({ type: 'collect', orderId: id, requestId: 'collect-' + id, expectedVersion: 3, payload: { items: [{ itemId: 'ski', quantity: 1 }] } });
  return service;
}
test('legacy migration preserves physical quantities and original charge through SQLite restart, and blocks old writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ski-unified-')), file = join(dir, 'ops.sqlite');
  let repository = createSqliteRepository(file);
  try {
    const legacy = seed(repository), service = W.createService(repository, ctx, clock);
    const command = { type: 'legacy.migrate', requestId: 'migration-1', expectedVersion: 0, payload: { orderIds: ['old-1'] } };
    assert.deepEqual(service.execute(command).migrated, ['old-1']);
    assert.equal(service.execute(command).duplicate, true);
    const state = repository.workflows(ctx.shopId), marker = state.migrations[0];
    assert.deepEqual(marker.before, { planned: 4, issued: 3, customer: 1, vehicle: 1, returned: 1, chargeWon: 123000 });
    assert.deepEqual(marker.after, marker.before);
    assert.equal(state.assets.filter(a => a.location.id === 'van-2').length, 1);
    assert.equal(service.snapshot().orders[0].lines[0].unissuedQuantity, 1);
    assert.throws(() => legacy.execute({ type: 'receiveDirect', orderId: 'old-1', requestId: 'old-write', expectedVersion: 4, payload: { items: [{ itemId: 'ski', quantity: 1 }] } }), e => e.code === 'USE_UNIFIED_ORDER');
    repository.close(); repository = createSqliteRepository(file);
    assert.deepEqual(repository.workflows(ctx.shopId), state);
    const restarted = W.createService(repository, ctx, clock);
    const replay = restarted.execute({ ...command, requestId: 'migration-restart', expectedVersion: state.revision });
    assert.deepEqual(replay.unchanged, ['old-1']);
    assert.equal(restarted.snapshot().assets.length, 3);
    assert.equal(restarted.snapshot().orders.length, 1);
  } finally { repository.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('migration failure rolls back every order and notification; source records cannot be supplied by client', () => {
  const repository = createSqliteRepository(':memory:');
  try {
    seed(repository); const service = W.createService(repository, ctx, clock);
    assert.throws(() => service.execute({ type: 'legacy.migrate', requestId: 'failed', expectedVersion: 0, payload: { orderIds: ['old-1', 'missing'] } }), e => e.code === 'NOT_FOUND');
    assert.equal(repository.workflows(ctx.shopId), null);
    assert.throws(() => service.execute({ type: 'legacy.migrate', requestId: 'forged', expectedVersion: 0, payload: { orderIds: ['old-1'], legacyOrders: [] } }), e => e.code === 'INVALID_INPUT');
    const driver = W.createService(repository, { ...ctx, actor: { id: 'driver-2', role: 'driver', vehicleId: 'van-2' } }, clock);
    assert.throws(() => driver.execute({ type: 'legacy.migrate', requestId: 'driver', expectedVersion: 0, payload: { orderIds: ['old-1'] } }), e => e.code === 'FORBIDDEN');
    assert.equal(repository.workflows(ctx.shopId), null);
  } finally { repository.close(); }
});

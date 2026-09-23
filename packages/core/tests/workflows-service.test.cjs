const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createSqliteRepository } = require('../server/returns-repository.cjs');
const { createMemoryRepository, createService: returnsService } = require('../src/returns/service.js');
const { createService, publicRequest } = require('../src/workflows/service.js');
const { createService: notificationService } = require('../src/notifications/service.js');
const { newCommand, newIntakeCommand, createLocalClient } = require('../src/workflows/client.js');
const { sample } = require('./returns-fixtures.cjs');
const { fixture, ctx, driverCtx, shop, van, person, errorCode } = require('./workflows-fixtures.cjs');

for (const mode of ['memory', 'sqlite']) test(mode + ': version conflicts, atomic rollback, shared notification acknowledgement, and tenant/driver isolation', () => {
  const repository = mode === 'sqlite' ? createSqliteRepository(':memory:') : createMemoryRepository();
  try {
    const f = fixture(repository), other = createService(repository, { ...ctx, shopId: 'shop-2' }, f.clock);
    const stranger = createService(repository, { ...driverCtx, actor: { ...driverCtx.actor, vehicleId: 'van-2' } }, f.clock);
    const ids = f.issue(2), before = f.store.snapshot();
    assert.throws(() => f.move('load', [...ids, 'missing'], shop, van), errorCode('NOT_FOUND'));
    assert.equal(f.store.snapshot().revision, before.revision); assert.equal(repository.notifications(ctx.shopId).revision, 0);
    const preview = f.store.prepareMove({ kind: 'load', items: [{ sku: 'ticket-6h', quantity: 2 }], from: shop, to: van });
    assert.equal(preview.before.totals.at(-1).current, 0); assert.equal(preview.after.totals.at(-1).current, 2);
    assert.equal(f.store.snapshot().revision, before.revision, 'preview is read only');
    const command = newCommand('stock.move', preview.revision, preview.payload);
    f.store.execute(command); assert.equal(f.store.execute(command).duplicate, true);
    const notices = notificationService(repository, driverCtx, f.clock), notice = notices.list().records[0];
    notices.execute({ type: 'received', requestId: 'received-1', notificationId: notice.id, payload: {} });
    notices.execute({ type: 'ack', requestId: 'ack-1', notificationId: notice.id, payload: {} });
    assert.equal(f.driver.vehicle().totals.at(-1).current, 2, 'notice acknowledgement cannot load again');
    assert.equal(other.snapshot().assets.length, 0); assert.equal(stranger.snapshot().vehicle.assets.length, 0);
    assert.throws(() => stranger.vehicle({ vehicleId: 'van-1' }), errorCode('FORBIDDEN'));
    assert.throws(() => f.driver.reservations(), errorCode('FORBIDDEN'));
    assert.throws(() => f.driver.history(), errorCode('FORBIDDEN'));
    assert.throws(() => f.store.execute({ ...command, shopId: 'shop-2' }), errorCode('INVALID_INPUT'));
    assert.throws(() => f.store.execute({ ...command, requestId: 'conflict' }), errorCode('VERSION_CONFLICT'));
    assert.equal(f.driver.snapshot().forms, undefined);
  } finally { repository.close?.(); }
});

test('store reorder preserves appointment time and selected task, shares acknowledgement, and leaves existing priority request unread', () => {
  const f = fixture(), returns = returnsService(f.repository, ctx, f.clock);
  returns.execute({ type: 'create', requestId: 'old-order', expectedVersion: 0, orderId: 'order-1', payload: sample() });
  const noticesStore = notificationService(f.repository, ctx, f.clock), noticesDriver = notificationService(f.repository, driverCtx, f.clock);
  const priority = noticesStore.execute({ type: 'request', requestId: 'old-priority', payload: { orderId: 'order-1', expectedVersion: 1, message: '먼저 확인해 주세요.' } });
  f.task('first', 'delivery', 'a', [], '09:00'); f.task('second', 'delivery', 'b', [], '10:00'); f.task('third', 'collection', 'c', [], '11:00');
  f.call('dispatch.reorder', { vehicleId: 'van-1', date: '2026-09-09', taskId: 'third', action: 'top' });
  let board = f.driver.board({ selectedTaskId: 'second' });
  assert.deepEqual(board.pending.map(t => t.id), ['third', 'first', 'second']);
  assert.equal(board.pending[0].time, '11:00'); assert.equal(board.selectedTaskId, 'second');
  const notice = noticesDriver.list().records.find(n => n.type === 'sequence');
  assert.deepEqual(notice.changes.find(c => c.taskId === 'third'), { taskId: 'third', fromRank: 3, toRank: 1, title: 'third' });
  const cursor = f.driver.sync();
  noticesDriver.execute({ type: 'ack', requestId: 'sequence-ack', notificationId: notice.id, payload: {} });
  assert.equal(noticesDriver.list().records.find(n => n.id === priority.notificationId).acknowledgedAt, null);
  assert.equal(f.driver.sync({ afterRevision: cursor.revision, afterNotificationRevision: cursor.notificationRevision }).changed, true);
  f.call('task.priority', { id: 'third', message: '먼저 확인' });
  f.call('dispatch.reorder', { vehicleId: 'van-1', date: '2026-09-09', action: 'restore' });
  board = f.driver.board(); assert.deepEqual(board.pending.map(t => t.id), ['first', 'second', 'third']);
  assert.equal(board.notifications.records.find(n => n.type === 'priority' && n.taskId === 'third').acknowledgedAt, null);
  f.call('task.status', { id: 'first', status: 'completed' }, f.driver);
  assert.deepEqual(f.driver.board().pending.map(t => t.id), ['second', 'third']);
});

test('SQLite migration/restart and second writer retain physical inventory, audit, request dedup and form access', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ski-workflows-')), filename = path.join(dir, 'ledger.sqlite'); let repository;
  try {
    const old = new DatabaseSync(filename); old.exec('PRAGMA user_version = 2'); old.close();
    repository = createSqliteRepository(filename); let f = fixture(repository);
    const ids = f.issue(3); f.move('load', ids, shop, van); const form = await f.form(); await form.submit([person()]);
    const command = newCommand('stock.move', f.store.snapshot(), { kind: 'receive', from: van, to: shop, assetIds: [ids[0]] });
    f.store.execute(command); const version = f.store.snapshot().revision;
    repository.close(); repository = createSqliteRepository(filename); f = fixture(repository);
    assert.equal(f.store.snapshot().revision, version); assert.equal(f.driver.vehicle().totals.at(-1).current, 2);
    assert.equal(f.store.execute(command).duplicate, true); assert.equal((await publicRequest(repository, form.access, null, f.clock)).people.length, 1);
    const second = createSqliteRepository(filename);
    try {
      const other = createService(second, ctx, f.clock), stale = newCommand('stock.move', other.snapshot(), { kind: 'receive', assetIds: [ids[1]], from: van, to: shop });
      f.store.execute(stale);
      assert.throws(() => other.execute({ ...stale, requestId: 'writer-2' }), errorCode('VERSION_CONFLICT'));
      assert.equal(other.vehicle({ vehicleId: 'van-1' }).totals.at(-1).current, 1);
      const db = new DatabaseSync(filename);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workflow_events').get().n, other.snapshot().revision); db.close();
    } finally { second.close(); }
  } finally { repository?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('customer capability is scoped, revocable, expires, does not expose staff data, and submission uses its own version', async () => {
  const f = fixture(), form = await f.form(), other = await f.form('form-2');
  f.issue(1);
  await form.submit([person()]); // Does not conflict with stock/other-form revisions.
  const response = await form.get();
  assert.equal(response.access, undefined); assert.equal(response.reviews, undefined); assert.equal(response.printJobs, undefined);
  await assert.rejects(publicRequest(f.repository, { ...other.access, accessToken: form.accessToken }, null, f.clock), errorCode('UNAUTHORIZED'));
  await assert.rejects(publicRequest(f.repository, form.access, newCommand('stock.receive', 1, { sku: 'ski', quantity: 1 }), f.clock), errorCode('FORBIDDEN'));
  await assert.rejects(form.submit([person()], 0), errorCode('VERSION_CONFLICT'));
  f.call('intake.revoke', { id: 'form-1' }); await assert.rejects(form.get(), errorCode('FORM_CLOSED'));
  f.setTime('2026-09-13T00:00:00.000Z'); await assert.rejects(other.get(), errorCode('FORM_CLOSED'));
  assert.equal(f.store.intake('form-1').linkStatus, 'revoked'); assert.equal(f.store.intake('form-2').linkStatus, 'expired');
  const text = JSON.stringify(f.repository.workflows(ctx.shopId)); assert.ok(!text.includes(form.accessToken), 'only the token hash is persisted');
});

test('SMS adapter is optional; idempotent send, delivery receipt and unknown outcome remain distinct', async () => {
  let calls = 0;
  const f = fixture(undefined, { sms: { send: async ({ recipient, message, idempotencyKey }) => { calls++; assert.equal(recipient, '010-1111-2222'); assert.ok(message.includes('#shop=')); assert.ok(idempotencyKey); return { status: 'accepted', providerId: 'fake-receipt' }; } } });
  const form = await f.form(), command = newCommand('delivery.queue', f.store.snapshot(), { id: 'sms-1', formId: 'form-1' });
  const envelope = { command, accessToken: form.accessToken, publicUrl: 'https://example.test/form' };
  const first = await f.store.sendFormLink(envelope); assert.equal(first.status, 'accepted');
  await f.store.sendFormLink(envelope); assert.equal(calls, 1);
  const noAdapter = fixture(), preparedForm = await noAdapter.form();
  const prepared = await noAdapter.store.sendFormLink({ command: newCommand('delivery.queue', noAdapter.store.snapshot(), { id: 'prepared', formId: 'form-1' }), accessToken: preparedForm.accessToken, publicUrl: 'https://example.test/form' });
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.transportConfigured, false);
  assert.ok(!prepared.link.includes('홍길동')); assert.ok(!JSON.stringify(noAdapter.repository.workflows(ctx.shopId)).includes(preparedForm.accessToken));
  let failedCalls = 0;
  const failed = fixture(undefined, { sms: { send: async () => { failedCalls++; throw new Error('timeout'); } } }), failedForm = await failed.form();
  const failedEnvelope = { command: newCommand('delivery.queue', failed.store.snapshot(), { id: 'uncertain', formId: 'form-1' }), accessToken: failedForm.accessToken, publicUrl: 'https://example.test/form' };
  assert.equal((await failed.store.sendFormLink(failedEnvelope)).status, 'unknown');
  await failed.store.sendFormLink(failedEnvelope); assert.equal(failedCalls, 1, 'uncertain sends are not blindly repeated');
});

test('printer adapter distinguishes request/dispatch/confirmed and cannot duplicate a physical print on retry', async () => {
  let calls = 0; const f = fixture(undefined, { printer: { print: async job => { calls++; assert.ok(job.html.includes('장비 준비표')); return { status: 'confirmed', device: 'fake-printer' }; } } });
  const form = await f.form(); await form.submit([person()]); f.call('intake.review', { id: 'form-1', submissionVersion: 1 });
  f.call('print.request', { id: 'print-1', kind: 'a4', formIds: ['form-1'] });
  assert.equal((await f.store.dispatchPrint('print-1')).job.status, 'confirmed');
  await f.store.dispatchPrint('print-1'); assert.equal(calls, 1); assert.equal(f.store.intake('form-1').preparedPeople, 0);
});

test('local watch delivers shared changes immediately and stops cleanly', async () => {
  const f = fixture(), client = createLocalClient(f.driver, f.repository), changes = [], statuses = [];
  const watch = client.watch({ onChange: value => changes.push(value), onStatus: value => statuses.push(value) });
  await new Promise(resolve => setImmediate(resolve));
  f.issue(1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(changes.at(-1).revision, f.store.snapshot().revision); assert.equal(statuses.at(-1).connected, true);
  watch.stop(); const count = changes.length; f.issue(1); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(changes.length, count);
});

test('SQLite rolls back inventory and audit if notification storage fails after the state write', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ski-workflow-atomic-')), filename = path.join(dir, 'ledger.sqlite');
  const repository = createSqliteRepository(filename);
  try {
    const f = fixture(repository), ids = f.issue(1), before = f.store.snapshot().revision;
    const db = new DatabaseSync(filename);
    db.exec("CREATE TRIGGER fail_workflow_notice BEFORE UPDATE ON notification_state BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    assert.throws(() => f.move('load', ids, shop, van));
    assert.equal(f.store.snapshot().revision, before); assert.equal(f.driver.vehicle().totals.at(-1).current, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workflow_events').get().n, before);
    db.close();
  } finally { repository.close(); rmSync(dir, { recursive: true, force: true }); }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { R, ctx, sample, run, create, issued, errorCode } = require('./returns-fixtures.cjs');

test('actual issue quantities are independent of daily usage; clothes and tickets default to direct return', () => {
  const order = issued();
  assert.equal(order.items[0].issuedQuantity, 2);
  assert.equal(order.items[0].usage.reduce((sum, use) => sum + use.quantity, 0), 4);
  assert.deepEqual(order.items.map(item => item.returnPlan.method), ['vehicle', 'direct', 'direct']);
  assert.deepEqual(order.items.map(item => item.returnPlan.date), ['2026-09-08', '2026-09-08', '2026-09-08']);
  assert.equal(R.summarize(order).totals.customerQuantity, 6);
  assert.equal(order.items[2].recoveryValueWon, 1000);
});
test('ticket-only orders enter return management without equipment', () => {
  const input = sample(); input.items = [input.items[2]];
  const before = create(input);
  assert.equal(R.summarize(before).status, 'awaiting_issue');
  const order = issued(input);
  assert.equal(R.summarize(order).status, 'in_use');
  assert.equal(order.items[0].returnTarget, 2);
});
test('explicit nonrecoverable tickets and recoverable tickets stay separate', () => {
  const input = sample(); input.items = [{ ...input.items[2], plannedQuantity: 4, plannedReturnQuantity: 3 }];
  const order = issued(input);
  assert.equal(order.items[0].issuedQuantity, 4);
  assert.equal(order.items[0].returnTarget, 3);
});
test('invalid issue is atomic and cannot exceed planned stock or issue fractional counts', () => {
  const order = create(); const before = JSON.stringify(order);
  for (const quantity of [-1, 0, 1.5, 3, '2']) assert.throws(() => run(order, 'issue', { items: [{ itemId: 'ski', quantity }] }));
  assert.throws(() => run(order, 'issue', { items: [{ itemId: 'ski', quantity: 1 }, { itemId: 'missing', quantity: 1 }] }), errorCode('ITEM_NOT_FOUND'));
  assert.equal(JSON.stringify(order), before);
});
test('request replay is idempotent; changed payload and stale versions are rejected', () => {
  const order = create();
  const command = { type: 'issue', payload: { items: [{ itemId: 'ski', quantity: 1 }] }, orderId: order.id, expectedVersion: order.version, requestId: 'replay-1' };
  const first = R.execute(order, command, ctx);
  const second = R.execute(first.order, command, ctx);
  assert.equal(second.duplicate, true);
  assert.equal(second.order.version, first.order.version);
  assert.throws(() => R.execute(first.order, { ...command, payload: { items: [{ itemId: 'ski', quantity: 2 }] } }, ctx), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => run(first.order, 'issue', command.payload, { expectedVersion: 1 }), errorCode('VERSION_CONFLICT'));
});
test('shop boundary, issue permission, invalid dates and duplicate lines are enforced', () => {
  const order = create();
  assert.throws(() => run(order, 'issue', { items: [{ itemId: 'ski', quantity: 1 }] }, {}, { ...ctx, shopId: 'shop-2' }), errorCode('NOT_FOUND'));
  assert.throws(() => run(order, 'issue', { items: [{ itemId: 'ski', quantity: 1 }] }, {}, { ...ctx, actor: { id: 'driver-1', role: 'driver', vehicleId: 'van-1' } }), errorCode('FORBIDDEN'));
  const input = sample(); input.rental.endDate = '2026-02-30';
  assert.throws(() => create(input), errorCode('INVALID_INPUT'));
  assert.throws(() => create({ ...sample(), items: [sample().items[0], sample().items[0]] }), errorCode('INVALID_INPUT'));
});


test('equipment collected in vehicle, clothes returned at store, tickets returned next day', () => {
  let order = issued(); const rental = JSON.stringify(order.rental);
  const targets = order.items.map(item => ({ itemId: item.id, quantity: 2 }));
  const payload = R.prepareVehicleReturn(order, targets, [{ itemId: 'clothes', quantity: 2 }, { itemId: 'ticket', quantity: 2 }]);
  const collection = run(order, 'collect', payload, {}, { ...ctx, actor: { id: 'driver-1', role: 'driver', vehicleId: 'van-1' } });
  order = collection.order;
  assert.equal(R.summarize(order).status, 'partial_return');
  assert.equal(R.summarize(order).totals.customerQuantity, 4);
  assert.equal(order.items[0].vehicleQuantity, 2);
  order = run(order, 'receiveDirect', { items: [{ itemId: 'clothes', quantity: 2 }] }).order;
  order = run(order, 'planReturn', { items: [{ itemId: 'ticket', returnPlan: { date: '2026-09-09', slot: '오전', method: 'direct' } }] }).order;
  assert.equal(order.items[0].returnPlan.date, '2026-09-08');
  assert.equal(order.items[2].returnPlan.date, '2026-09-09');
  assert.equal(JSON.stringify(order.rental), rental);
  order = run(order, 'confirmVehicle', { collectionId: collection.event.requestId, items: [{ itemId: 'ski', quantity: 2 }] }).order;
  assert.equal(R.summarize(order).complete, false);
  order = run(order, 'receiveDirect', { items: [{ itemId: 'ticket', quantity: 2 }] }, {}, { ...ctx, at: '2026-09-09T01:00:00.000Z' }).order;
  assert.equal(R.summarize(order).status, 'returned');
  assert.equal(R.summarize(order).totals.shopQuantity, 6);
  assert.equal(R.summarize(order).totals.vehicleQuantity, 0);
});
test('full vehicle collection is pending shop confirmation, with no double count', () => {
  const order = issued();
  const collected = run(order, 'collect', R.prepareVehicleReturn(order, order.items.map(item => ({ itemId: item.id, quantity: 2 }))));
  assert.equal(R.summarize(collected.order).status, 'awaiting_shop');
  const confirmed = run(collected.order, 'confirmVehicle', { collectionId: collected.event.requestId, items: [{ itemId: 'ticket', quantity: 1 }] });
  assert.equal(R.summarize(confirmed.order).totals.customerQuantity, 0);
  assert.equal(R.summarize(confirmed.order).totals.vehicleQuantity, 5);
  assert.equal(R.summarize(confirmed.order).totals.shopQuantity, 1);
  assert.throws(() => run(confirmed.order, 'confirmVehicle', { collectionId: collected.event.requestId, items: [{ itemId: 'ticket', quantity: 2 }] }), errorCode('DEPENDENT_RETURN'));
  assert.throws(() => run(confirmed.order, 'receiveDirect', { items: [{ itemId: 'ticket', quantity: 1 }] }), errorCode('QUANTITY_EXCEEDED'));
});
test('return before issue and wrong vehicle are rejected; failed multi-line return is atomic', () => {
  const pending = create();
  assert.throws(() => run(pending, 'collect', { items: [{ itemId: 'ski', quantity: 1 }] }), errorCode('QUANTITY_EXCEEDED'));
  const order = issued(); const original = JSON.stringify(order);
  assert.throws(() => run(order, 'collect', { items: [{ itemId: 'ski', quantity: 2 }, { itemId: 'ticket', quantity: 3 }] }), errorCode('QUANTITY_EXCEEDED'));
  assert.throws(() => run(order, 'collect', { items: [{ itemId: 'ski', quantity: 1 }] }, {}, { ...ctx, actor: { id: 'driver-2', role: 'driver', vehicleId: 'van-2' } }), errorCode('FORBIDDEN'));
  assert.equal(JSON.stringify(order), original);
});
test('vehicle job scope excludes tomorrow tickets; all missing requires no reason or typing', () => {
  const order = issued();
  const payload = R.prepareVehicleReturn(order, [{ itemId: 'ski', quantity: 2 }]);
  assert.deepEqual(payload.items, [{ itemId: 'ski', quantity: 2 }]);
  assert.throws(() => R.prepareVehicleReturn(order, [{ itemId: 'ski', quantity: 2 }], [{ itemId: 'ticket', quantity: 1 }]), errorCode('INVALID_INPUT'));
  const allMissing = R.prepareVehicleReturn(order, [{ itemId: 'clothes', quantity: 2 }], [{ itemId: 'clothes', quantity: 2 }]);
  const result = run(order, 'collect', allMissing).order;
  assert.equal(result.items[1].returnPlan.method, 'direct');
  assert.equal(R.summarize(result).totals.customerQuantity, 6);
});
test('unissued items prevent premature completion and duplicate taps do not add returns', () => {
  let order = create();
  order = run(order, 'issue', { items: [{ itemId: 'ski', quantity: 1 }] }).order;
  const result = run(order, 'receiveDirect', { items: [{ itemId: 'ski', quantity: 1 }] }, { requestId: 'tap-1' });
  const retry = R.execute(result.order, { type: 'receiveDirect', orderId: order.id, payload: { items: [{ itemId: 'ski', quantity: 1 }] }, expectedVersion: order.version, requestId: 'tap-1' }, ctx);
  assert.equal(retry.duplicate, true);
  assert.equal(R.summarize(retry.order).complete, false);
  assert.equal(retry.order.items[0].shopQuantity, 1);
});

test('correction preserves original audit, recalculates stock and can reopen completed orders', () => {
  const original = issued();
  const receipt = run(original, 'receiveDirect', { items: original.items.map(item => ({ itemId: item.id, quantity: 2 })) });
  assert.equal(R.summarize(receipt.order).complete, true);
  const corrected = run(receipt.order, 'correctReturn', { movementId: receipt.event.requestId, items: [{ itemId: 'ticket', quantity: 1 }] });
  assert.equal(R.summarize(corrected.order).status, 'partial_return');
  assert.equal(R.summarize(corrected.order).totals.customerQuantity, 1);
  assert.equal(corrected.order.events.find(e => e.requestId === receipt.event.requestId).payload.items[2].quantity, 2);
  assert.equal(corrected.event.adjustment.before[2].quantity, 2);
  assert.equal(corrected.event.adjustment.after[2].quantity, 1);
  assert.equal(R.history(corrected.order).at(-1).actor.id, 'staff-1');
  assert.ok(!('fingerprint' in R.history(corrected.order)[0]));
});
test('driver can undo own collection, but cannot undo store confirmation or another driver receipt', () => {
  const driver = { ...ctx, actor: { id: 'driver-1', role: 'driver', vehicleId: 'van-1' } };
  const collected = run(issued(), 'collect', { items: [{ itemId: 'ski', quantity: 2 }] }, {}, driver);
  const undone = run(collected.order, 'undoReturn', { movementId: collected.event.requestId }, {}, driver);
  assert.equal(undone.order.items[0].vehicleQuantity, 0);
  assert.equal(R.summarize(undone.order).totals.customerQuantity, 6);
  assert.throws(() => run(collected.order, 'undoReturn', { movementId: collected.event.requestId }, {}, { ...driver, actor: { ...driver.actor, id: 'driver-2' } }), errorCode('FORBIDDEN'));
  const confirmed = run(collected.order, 'confirmVehicle', { collectionId: collected.event.requestId, items: [{ itemId: 'ski', quantity: 1 }] });
  assert.throws(() => run(confirmed.order, 'undoReturn', { movementId: confirmed.event.requestId }, {}, driver), errorCode('FORBIDDEN'));
});
test('confirmed collection cannot be reduced below linked confirmation; undo confirmation first', () => {
  const collected = run(issued(), 'collect', { items: [{ itemId: 'ski', quantity: 2 }] });
  const confirmed = run(collected.order, 'confirmVehicle', { collectionId: collected.event.requestId, items: [{ itemId: 'ski', quantity: 2 }] });
  assert.throws(() => run(confirmed.order, 'correctReturn', { movementId: collected.event.requestId, items: [{ itemId: 'ski', quantity: 1 }] }), errorCode('DEPENDENT_RETURN'));
  const undo = run(confirmed.order, 'undoReturn', { movementId: confirmed.event.requestId });
  const corrected = run(undo.order, 'correctReturn', { movementId: collected.event.requestId, items: [{ itemId: 'ski', quantity: 1 }] });
  assert.equal(corrected.order.items[0].vehicleQuantity, 1);
  assert.equal(corrected.order.items[0].shopQuantity, 0);
});
test('per-day worklist keeps tickets tomorrow and distinguishes overdue, direct and pending shop', () => {
  const collection = run(issued(), 'collect', { items: [{ itemId: 'ski', quantity: 2 }] });
  const order = run(collection.order, 'planReturn', { items: [{ itemId: 'ticket', returnPlan: { date: '2026-09-09', time: '09:00' } }] }).order;
  const options = { shopId: 'shop-1', now: '2026-09-09T00:30:00.000Z' };
  assert.deepEqual(R.worklist([order], { ...options, onDate: '2026-09-09' })[0].dueItems.map(item => item.id), ['ticket']);
  assert.deepEqual(R.worklist([order], { ...options, filter: 'overdue' })[0].dueItems.map(item => item.id), ['clothes', 'ticket']);
  assert.deepEqual(R.worklist([order], { ...options, filter: 'liftUnreturned' })[0].dueItems.map(item => item.id), ['ticket']);
  assert.equal(R.worklist([order], { ...options, filter: 'awaitingShop' })[0].pendingConfirmations[0].quantity, 2);
  assert.equal(R.worklist([order], { ...options, shopId: 'shop-2' }).length, 0);
});
test('recovery report uses Korea date, excludes second count at store, restates corrected receipt day', () => {
  const collected = run(issued(), 'collect', { items: [{ itemId: 'ticket', quantity: 2 }] }, {}, { ...ctx, at: '2026-09-07T15:10:00.000Z' });
  const confirmed = run(collected.order, 'confirmVehicle', { collectionId: collected.event.requestId, items: [{ itemId: 'ticket', quantity: 1 }] }, {}, { ...ctx, at: '2026-09-09T01:00:00.000Z' });
  let report = R.ticketReport([confirmed.order], { shopId: 'shop-1', fromDate: '2026-09-08', toDate: '2026-09-08' });
  assert.equal(report.recoveredQuantity, 2); assert.equal(report.recoveryValueWon, 2000); assert.equal(report.shopConfirmedQuantity, 0);
  assert.equal(report.currentVehicleQuantity, 1); assert.equal(report.currentShopQuantity, 1);
  const corrected = run(confirmed.order, 'correctReturn', { movementId: collected.event.requestId, items: [{ itemId: 'ticket', quantity: 1 }] }).order;
  report = R.ticketReport([corrected], { shopId: 'shop-1' });
  assert.equal(report.recoveredQuantity, 1); assert.equal(report.recoveryValueWon, 1000); assert.equal(report.shopConfirmedQuantity, 1);
  assert.equal(report.currentCustomerQuantity, 1);
  assert.equal(R.ticketReport([corrected], { shopId: 'shop-2' }).recoveredQuantity, 0);
});

test('historical correction cannot claim stock that was only issued later', () => {
  const firstIssue = run(create(), 'issue', { items: [{ itemId: 'ski', quantity: 1 }] }).order;
  const collected = run(firstIssue, 'collect', { items: [{ itemId: 'ski', quantity: 1 }] });
  const laterIssue = run(collected.order, 'issue', { items: [{ itemId: 'ski', quantity: 1 }] }).order;
  assert.throws(() => run(laterIssue, 'correctReturn', { movementId: collected.event.requestId, items: [{ itemId: 'ski', quantity: 2 }] }), errorCode('QUANTITY_EXCEEDED'));
  assert.equal(laterIssue.items[0].vehicleQuantity, 1);
});

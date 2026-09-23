const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, ticket, shop, van, person, errorCode } = require('./workflows-fixtures.cjs');
const { newCommand } = require('../src/workflows/client.js');

test('multi-day reservation totals, preissue, partial issue, cancellation and explicit compatible stock', () => {
  const f = fixture();
  f.book('hong', [
    { id: 'd9-3', useDate: '2026-09-09', issueDate: '2026-09-08', ticketType: 'ticket-3h', quantity: 4 },
    { id: 'd9-4', useDate: '2026-09-09', ticketType: 'ticket-4h', quantity: 3 },
    { id: 'd10-6', useDate: '2026-09-10', ticketType: 'ticket-6h', quantity: 2 }
  ]);
  assert.deepEqual(f.store.reservations({ date: '2026-09-09' }).totals.map(t => t.reserved), [4, 3, 0]);
  assert.deepEqual(f.store.reservations({ date: '2026-09-10' }).totals.map(t => t.reserved), [0, 0, 2]);
  f.issue(2, { reservationId: 'hong', lineId: 'd9-3' });
  const pre = f.store.reservations({ date: '2026-09-08', basis: 'issue' }).totals[0];
  assert.equal(pre.secured, 2); assert.equal(pre.needIssue, 2);
  assert.equal(f.store.reservations({ date: '2026-09-09', basis: 'issue' }).overdue[0].needIssue, 2);
  const existing = f.call('stock.opening', { sku: 'ticket-3h', quantity: 1, ticket, sourceReference: 'physical-count-1' }).assetIds;
  f.call('ticket.allocate', { reservationId: 'hong', lineId: 'd9-3', assetIds: existing });
  assert.equal(f.store.report().totals.find(t => t.sku === 'ticket-6h').newlyIssued, 2);
  f.call('reservation.cancel', { reservationId: 'hong', lineId: 'd9-3', quantity: 4 });
  assert.equal(f.store.reservations({ date: '2026-09-09' }).totals[0].reserved, 0);
  assert.equal(f.store.snapshot().assets.length, 3, 'cancelling demand never destroys physical tickets');
  assert.equal(f.store.reservations({ date: '2026-09-09', basis: 'issue' }).overdue.length, 0);
  assert.throws(() => f.call('reservation.issueDate', { id: 'hong', lineIds: ['d10-6'], issueDate: '2026-09-11' }), errorCode('INVALID_INPUT'));
});

test('morning equipment + ticket collection, future recovery, afternoon ticket-only redelivery, driver and store final receipt', () => {
  const f = fixture();
  f.book('morning', [{ id: 'am', useDate: '2026-09-09', startTime: '09:00', endTime: '12:00', ticketType: 'ticket-3h', quantity: 1 }]);
  f.book('afternoon', [{ id: 'pm', useDate: '2026-09-09', startTime: '14:00', endTime: '18:00', ticketType: 'ticket-4h', quantity: 1 }]);
  const tickets = f.issue(1, { ticket: { ...ticket, validFrom: '2026-09-09T09:00:00+09:00', validTo: '2026-09-09T18:00:00+09:00' }, reservationId: 'morning', lineId: 'am' });
  const equipment = f.call('stock.receive', { sku: 'ski', quantity: 2 }).assetIds;
  f.move('load', [...tickets, ...equipment], shop, van);
  f.task('deliver-am', 'delivery', 'morning', [...tickets, ...equipment]);
  f.move('deliver', [...tickets, ...equipment], van, { kind: 'customer', id: 'morning' }, { taskId: 'deliver-am' }, f.driver);
  f.call('ticket.allocate', { reservationId: 'afternoon', lineId: 'pm', assetIds: tickets });
  const waiting = f.store.reservations().rows.find(r => r.lineId === 'pm' || r.id === 'pm');
  assert.equal(waiting.waitingRecovery, 1); assert.equal(waiting.secured, 0);
  f.setTime('2026-09-09T03:00:00.000Z');
  f.task('collect-am', 'collection', 'morning', [...tickets, ...equipment], '12:00');
  f.move('collect', [...tickets, ...equipment], { kind: 'customer', id: 'morning' }, van, { taskId: 'collect-am' }, f.driver);
  assert.equal(f.store.reservations().rows.find(r => r.id === 'pm').secured, 1);
  f.task('deliver-pm', 'delivery', 'afternoon', tickets, '14:00');
  f.move('deliver', tickets, van, { kind: 'customer', id: 'afternoon' }, { taskId: 'deliver-pm' }, f.driver);
  const summary = f.driver.vehicle();
  assert.equal(summary.equipmentCount, 2); assert.equal(summary.totals.find(t => t.sku === 'ticket-6h').current, 0);
  assert.equal(summary.totals.find(t => t.sku === 'ticket-6h').recoveredToday, 1);
  assert.equal(f.store.report().totals.find(t => t.sku === 'ticket-6h').redelivered, 1);
  assert.equal(f.store.reservations().rows.find(r => r.id === 'am').secured, 1, 'past delivery remains fulfilled after reuse');
  f.setTime('2026-09-09T16:00:00.000Z'); // Next calendar day in Seoul.
  assert.equal(f.driver.vehicle().equipmentCount, 2);
  assert.equal(f.driver.vehicle().totals.find(t => t.sku === 'ski').recoveredToday, 0);
  f.move('receive', equipment.slice(0, 1), van, shop, {}, f.driver);
  assert.equal(f.driver.vehicle().equipmentCount, 1);
  f.move('receive', equipment.slice(1), van, shop); assert.equal(f.driver.vehicle().equipmentCount, 0);
});

test('clothing/helmet counts, store refund preload, and same-day ticket expiry use actual custody and time', () => {
  const f = fixture();
  for (const [sku, quantity] of [['ski', 3], ['board', 1], ['clothing', 2], ['helmet', 4]]) {
    const ids = f.call('stock.receive', { sku, quantity }).assetIds; f.move('load', ids, shop, van);
  }
  assert.equal(f.driver.vehicle().equipmentCount, 4);
  assert.equal(f.driver.vehicle().totals.find(t => t.sku === 'clothing').current, 2);
  assert.equal(f.driver.vehicle().totals.find(t => t.sku === 'helmet').current, 4);
  const ids = f.issue(2, { ticket: { ...ticket, validTo: '2026-09-09T12:00:00+09:00' } });
  f.call('refund.plan', { id: 'preload-refund', assetIds: [ids[0]], vehicleId: 'van-1', vendorId: 'resort-1', date: '2026-09-09', time: '10:00', place: '발권소' });
  assert.equal(f.driver.vehicle().totals.at(-1).current, 0);
  f.move('load', ids, shop, van); assert.equal(f.driver.vehicle().totals.at(-1).availableToDeliver, 1);
  f.setTime('2026-09-09T04:00:00.000Z'); assert.equal(f.driver.vehicle().totals.at(-1).availableToDeliver, 0);
  assert.equal(f.driver.vehicle().totals.at(-1).current, 2);
});

test('two refund tickets remain onboard until actual partial surrender; failed/refund cancellation do not move stock', () => {
  const f = fixture(); f.book('customer'); const assets = f.issue(2);
  f.call('ticket.allocate', { reservationId: 'customer', lineId: 'line-1', assetIds: [assets[0]] });
  f.move('load', assets, shop, van, { purpose: 'spare' });
  f.call('refund.plan', { id: 'refund-1', assetIds: assets, vehicleId: 'van-1', vendorId: 'resort-1', date: '2026-09-09', time: '10:00', place: '발권소' });
  let row = f.driver.vehicle().totals.find(t => t.sku === 'ticket-6h');
  assert.equal(row.current, 2); assert.equal(row.refundPending, 2); assert.equal(row.availableToDeliver, 0);
  assert.equal(f.store.reservations().totals[2].needIssue, 1);
  const result = f.call('refund.complete', { id: 'refund-1', assetIds: [assets[0]], amountWon: 30000 }, f.driver);
  assert.equal(result.completed, 1); assert.equal(result.remaining, 1);
  f.call('refund.complete', { id: 'refund-1', assetIds: [], amountWon: 0, note: '남은 권은 환불 불가' }, f.driver);
  assert.equal(f.driver.snapshot().refunds[0].status, 'incomplete');
  assert.equal(f.driver.snapshot().refunds[0].remainingQuantity, 1);
  assert.equal(f.driver.vehicle().totals.find(t => t.sku === 'ticket-6h').current, 1);
  assert.equal(f.store.report().refundAmountWon, 30000);
  assert.equal(f.store.reservations().totals[2].reserved, 1);
  f.call('refund.cancel', { id: 'refund-1', assetIds: [assets[1]], reason: '환불 요청 취소' });
  row = f.driver.vehicle().totals.find(t => t.sku === 'ticket-6h');
  assert.equal(row.current, 1); assert.equal(row.refundPending, 0);
  assert.throws(() => f.call('refund.complete', { id: 'refund-1', assetIds: [assets[0]], amountWon: 30000 }, f.driver), errorCode('NO_CHANGE'));
});

test('cancelling part of a pending refund removes only those tickets from the remaining work', () => {
  const f = fixture(), ids = f.issue(3); f.move('load', ids, shop, van);
  f.call('refund.plan', { id: 'partial-plan', assetIds: ids, vehicleId: 'van-1', vendorId: 'resort-1', date: '2026-09-09', time: '12:00', place: '발권소' });
  f.call('refund.cancel', { id: 'partial-plan', assetIds: [ids[0]], reason: '한 장은 보유' });
  assert.deepEqual(f.driver.board().pending[0].remainingAssetIds, ids.slice(1));
  assert.equal(f.driver.snapshot().refunds[0].remainingQuantity, 2);
  assert.equal(f.driver.snapshot().refunds[0].onboardQuantity, 2);
  assert.equal(f.driver.vehicle().totals.at(-1).current, 3);
});

test('overlap, validity, nontransferability, wrong location and duplicate allocation are rejected atomically', () => {
  const f = fixture(); f.book('a'); f.book('b'); const assets = f.issue(1);
  f.call('ticket.allocate', { reservationId: 'a', lineId: 'line-1', assetIds: assets });
  assert.throws(() => f.call('ticket.allocate', { reservationId: 'b', lineId: 'line-1', assetIds: assets }), errorCode('TICKET_UNAVAILABLE'));
  assert.throws(() => f.move('collect', assets, { kind: 'customer', id: 'a' }, van), errorCode('QUANTITY_EXCEEDED'));
  const late = f.issue(1, { ticket: { ...ticket, validFrom: '2026-09-10T00:00:00+09:00' } });
  assert.throws(() => f.call('ticket.allocate', { reservationId: 'b', lineId: 'line-1', assetIds: late }), errorCode('TICKET_UNAVAILABLE'));
  f.book('tomorrow', [{ id: 'next', useDate: '2026-09-10', ticketType: 'ticket-6h', quantity: 1 }]);
  const fixed = f.issue(1, { ticket: { ...ticket, transferable: false } });
  f.call('ticket.allocate', { reservationId: 'b', lineId: 'line-1', assetIds: fixed });
  assert.throws(() => f.call('ticket.allocate', { reservationId: 'tomorrow', lineId: 'next', assetIds: fixed }), errorCode('TICKET_UNAVAILABLE'));
});

test('additional loads are additive, duplicate retries stable, correction preserves history and blocks downstream dependencies', () => {
  const f = fixture(), assets = f.issue(5);
  f.move('load', assets.slice(0, 2), shop, van);
  const command = newCommand('stock.move', f.store.snapshot(), { kind: 'load', assetIds: assets.slice(2), from: shop, to: van });
  const moved = f.store.execute(command); assert.equal(f.store.execute(command).duplicate, true);
  assert.equal(f.driver.vehicle().totals.find(t => t.sku === 'ticket-6h').current, 5);
  f.call('movement.correct', { movementId: moved.movementId, keepAssetIds: [assets[2]], reason: '실제로 한 장만 실음' });
  assert.equal(f.driver.vehicle().totals.find(t => t.sku === 'ticket-6h').current, 3);
  f.book('new'); f.call('ticket.allocate', { reservationId: 'new', lineId: 'line-1', assetIds: [assets[2]] });
  assert.throws(() => f.call('movement.undo', { movementId: moved.movementId, reason: '잘못 입력' }), errorCode('DEPENDENT_MOVEMENT'));
  assert.equal(f.store.history().corrections.length, 1);
  assert.throws(() => f.store.execute({ ...command, requestId: 'stale' }), errorCode('VERSION_CONFLICT'));
  assert.throws(() => f.store.execute({ ...command, payload: { ...command.payload, assetIds: [assets[0]] } }), errorCode('IDEMPOTENCY_CONFLICT'));
});

test('20/21 person print pagination, partial submissions, reviewed snapshots, changed fields and actual equipment issue', async () => {
  const f = fixture(), form = await f.form('group-1', 23), people = Array.from({ length: 21 }, (_, i) => person(i + 1));
  await form.submit(people);
  assert.equal(f.store.intake('group-1').partial, true);
  f.call('intake.review', { id: 'group-1', submissionVersion: 1 });
  f.call('print.request', { id: 'print-1', kind: 'a4', formIds: ['group-1'] });
  const printed = f.store.print('print-1');
  assert.deepEqual(printed.job.document.pages.map(p => p.rows.length), [20, 1]);
  assert.equal(printed.job.status, 'queued'); assert.equal(f.store.intake('group-1').preparedPeople, 0);
  f.call('print.record', { id: 'print-1', status: 'confirmed', device: '매장 A4' });
  const changed = people.map(p => ({ ...p })); changed[0].footMm = 275;
  await form.submit(changed, 1);
  const view = f.store.intake('group-1');
  assert.equal(view.needsReview, true); assert.equal(view.changedAfterPrint, true);
  assert.equal(view.changesAfterPrint[0].fields[0].field, 'footMm');
  assert.equal(view.reviews[0].people[0].footMm, 260);
  assert.equal(f.store.print('print-1').job.document.pages[0].rows[0].footMm, 260);
  f.call('intake.review', { id: 'group-1', submissionVersion: 2 });
  f.call('intake.prepare', { id: 'group-1', reviewVersion: 2, personIds: ['person-1'] });
  const equipment = [...f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds, ...f.call('stock.receive', { sku: 'helmet', quantity: 1 }).assetIds];
  f.call('intake.issue', { id: 'group-1', reviewVersion: 2, from: shop, people: [{ personId: 'person-1', assetIds: equipment, actualFootMm: 270, actualEquipmentSize: '160cm' }] });
  assert.equal(f.store.intake('group-1').issues[0].actualFootMm, 270);
  assert.equal(f.store.snapshot().assets[0].location.id, 'group-1');
  assert.equal(f.store.intake('group-1').reviews.at(-1).people[0].footMm, 275);
});

test('five group labels, HTML escaping, unknown sizes, original reprint retained', async () => {
  const f = fixture(), ids = [];
  for (let i = 0; i < 5; i++) {
    const id = 'group-' + i, form = await f.form(id); ids.push(id);
    await form.submit([{ ...person(), name: '<script>x</script>', footMm: null, heightCm: null }]);
    f.call('intake.review', { id, submissionVersion: 1 });
  }
  f.call('print.request', { id: 'labels', kind: 'labels', formIds: ids });
  const labels = f.store.print('labels'); assert.equal(labels.job.document.labels.length, 5);
  assert.equal(labels.job.document.labels[0].phone, '010-1111-2222');
  f.call('print.request', { id: 'reprint', kind: 'labels', reprintOf: 'labels' });
  assert.deepEqual(f.store.print('reprint').job.document, labels.job.document);
  f.call('print.request', { id: 'a4', kind: 'a4', formIds: ids });
  const html = f.store.print('a4').html; assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>')); assert.ok(html.includes('현장 확인'));
});

test('partial work cannot be reassigned and correcting a completed movement reopens its task', () => {
  const f = fixture(), ids = f.call('stock.receive', { sku: 'ski', quantity: 2 }).assetIds;
  f.move('load', ids, shop, van); f.task('delivery', 'delivery', 'customer', ids);
  const first = f.move('deliver', [ids[0]], van, { kind: 'customer', id: 'customer' }, { taskId: 'delivery' }, f.driver);
  assert.throws(() => f.task('delivery', 'delivery', 'other', ids), errorCode('INVALID_INPUT'));
  assert.throws(() => f.task('delivery', 'delivery', 'customer', ids, '10:00'), errorCode('NO_CHANGE'));
  assert.throws(() => f.call('task.status', { id: 'delivery', status: 'completed' }, f.driver), errorCode('QUANTITY_EXCEEDED'));
  f.move('deliver', [ids[1]], van, { kind: 'customer', id: 'customer' }, { taskId: 'delivery' }, f.driver);
  f.call('task.status', { id: 'delivery', status: 'completed' }, f.driver);
  f.call('movement.undo', { movementId: first.movementId, reason: '한 대 전달 기록 정정' });
  assert.equal(f.driver.board().inProgress[0].status, 'in_progress');
  assert.equal(f.driver.vehicle().equipmentCount, 1);
});

test('vehicle ticket purpose changes preserve physical custody and cannot release active reservations', () => {
  const f = fixture(), ids = f.issue(2);
  f.move('load', ids, shop, van);
  const before = f.store.snapshot(), movementCount = f.store.history().movements.length;
  f.call('stock.purpose', { assetIds: ids, vehicleId: van.id, purpose: 'delivery' });
  const after = f.store.snapshot();
  assert.equal(after.assets.length, before.assets.length);
  assert.deepEqual(after.assets.map(a => [a.id, a.location, a.vehicleOrigin, a.ticket]), before.assets.map(a => [a.id, a.location, a.vehicleOrigin, a.ticket]));
  assert.equal(f.store.history().movements.length, movementCount);
  assert.ok(after.assets.every(a => a.purpose === 'delivery'));
  assert.throws(() => f.call('stock.purpose', { assetIds: ids, vehicleId: 'van-2', purpose: 'spare' }), errorCode('INVALID_INPUT'));
  assert.throws(() => f.call('stock.purpose', { assetIds: ids, vehicleId: van.id, purpose: 'spare' }, f.driver), errorCode('FORBIDDEN'));
  f.book('next'); f.call('ticket.allocate', { reservationId: 'next', lineId: 'line-1', assetIds: [ids[0]] });
  const revision = f.store.snapshot().revision;
  assert.throws(() => f.call('stock.purpose', { assetIds: ids, vehicleId: van.id, purpose: 'spare' }), errorCode('NO_CHANGE'));
  assert.equal(f.store.snapshot().revision, revision);
  f.call('stock.purpose', { assetIds: [ids[1]], vehicleId: van.id, purpose: 'spare' });
  assert.equal(f.store.snapshot().assets.find(a => a.id === ids[0]).purpose, 'delivery');
});

test('purpose change cannot bypass a refund plan or apply to equipment and shop-held tickets', () => {
  const f = fixture(), ids = f.issue(2), gear = f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds;
  f.move('load', [ids[0], ...gear], shop, van);
  const payload = { vehicleId: van.id, purpose: 'delivery' };
  assert.throws(() => f.call('stock.purpose', { ...payload, assetIds: [ids[1]] }), errorCode('INVALID_INPUT'));
  assert.throws(() => f.call('stock.purpose', { ...payload, assetIds: gear }), errorCode('INVALID_INPUT'));
  f.call('refund.plan', { id: 'purpose-refund', assetIds: [ids[0]], vehicleId: van.id, vendorId: 'resort-1', date: '2026-09-09', time: '17:00', place: '발권처' });
  const revision = f.store.snapshot().revision;
  assert.throws(() => f.call('stock.purpose', { ...payload, assetIds: [ids[0]] }), errorCode('NO_CHANGE'));
  assert.equal(f.store.snapshot().revision, revision);
  assert.equal(f.store.snapshot().assets.find(a => a.id === ids[0]).refundId, 'purpose-refund');
});

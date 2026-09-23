const { test } = require('node:test');
const assert = require('node:assert/strict');
const Docs = require('../src/workflows/order-documents.js');
const Orders = require('../src/workflows/orders.js');
const Intake = require('../src/workflows/intake.js');
const Prints = require('../src/workflows/documents.js');
const Ops = require('../src/workflows/order-operations.js');
const Inventory = require('../src/workflows/inventory.js');
const Domain = require('../src/workflows/domain.js');
const copy = value => JSON.parse(JSON.stringify(value));
const context = { shopId: 'shop-1', actor: { id: 'store-1', role: 'store' }, at: '2026-09-13T00:00:00.000Z' };
const customer = { name: '김민수', phone: '010-1234-5678' };
const expiry = '2026-09-16T00:00:00.000Z', hash = 'a'.repeat(64);
const code = expected => error => error.code === expected;
const line = (id, personId, extra = {}) => ({ id, personId, sku: 'ski', quantity: 1, start: '2026-09-13', end: '2026-09-14', price: { unitWon: 20000 }, ...extra });
const person = (id, extra = {}) => ({ id, name: id + ' 실명', equipment: 'ski', heightCm: 170, footMm: 260, clothing: false, clothingSize: '', helmet: false, ...extra });
function fixture() {
  let state = Domain.fresh('shop-1');
  function call(type, payload, actor = context) {
    const next = copy(state), module = Docs.canHandle(type) ? Docs : Ops.canHandle(type) ? Ops : type.startsWith('order.') ? Orders : type.startsWith('intake.') || type.startsWith('delivery.') ? Intake : type.startsWith('print.') ? Prints : Inventory;
    const result = module.handle(next, type, payload, actor); next.revision++; state = next; return result;
  }
  call('order.create', { id: 'receipt-1', customer, people: [{ id: 'first', name: '일행 1' }, { id: 'second', name: '일행 2' }], batch: { id: 'batch-1', label: '첫 접수', lines: [line('first-ski', 'first'), line('second-ski', 'second')] } });
  return { call, get state() { return state; }, order: () => state.orders[0], form: (id = 'form-1') => state.forms.find(form => form.id === id),
    createForm: (extra = {}) => call('docs.formCreate', { orderId: 'receipt-1', id: 'form-1', batchIds: ['batch-1'], accessHash: hash, expiresAt: expiry, ...extra }),
    submit: (people, formId = 'form-1') => call('intake.submit', { id: formId, people, status: 'submitted' }),
    apply: (extra = {}) => call('docs.formApply', { orderId: 'receipt-1', formId: 'form-1', submissionVersion: 1, ...extra }),
    print: (kind = 'a4', extra = {}) => call('docs.orderPrint', { orderId: 'receipt-1', id: 'print-1', kind, ...extra }) };
}

test('new form requests only selected batch people with stable IDs and current contact', () => {
  const f = fixture(); f.state.customerProfiles = [{ id: 'profile-1', orderIds: ['receipt-1'], phone: '010-9999-1111' }];
  const result = f.createForm({ personIds: ['second'] });
  assert.deepEqual(result.requestedPersonIds, ['second']); assert.equal(f.form().expectedPeople, 1); assert.equal(f.form().customer.phone, '010-9999-1111');
  assert.equal(f.order().customer.phone, customer.phone); assert.deepEqual(f.form().orderPersonLinks, [{ formPersonId: 'second', personId: 'second' }]);
  assert.deepEqual(f.form().requestedPeople, [person('second', { name: '일행 2', heightCm: null, footMm: null })]);
  assert.equal(f.form().access.hash, hash); assert.equal(result.status, 'prepared'); assert.equal(f.state.deliveries.length, 0);
});

test('late-arrival form targets only the new batch and leaves earlier submissions and prices unchanged', () => {
  const f = fixture(); f.createForm(); f.submit([person('first'), person('second')]); f.apply();
  const oldForm = copy(f.form()), oldLines = copy(f.order().lines), oldPeople = copy(f.order().people);
  f.call('order.add', { orderId: 'receipt-1', people: [{ id: 'late', name: '내일 일행' }], batch: { id: 'batch-2', label: '내일 도착 추가', lines: [line('late-ski', 'late', { start: '2026-09-14' }), line('first-extra', 'first', { sku: 'clothing', start: '2026-09-14', price: { unitWon: 10000 } })] } });
  f.createForm({ id: 'form-late', batchIds: ['batch-2'] });
  assert.deepEqual(f.form('form-late').orderPersonIds, ['late']); assert.equal(f.form('form-late').date, '2026-09-14');
  assert.deepEqual(f.form(), oldForm); assert.deepEqual(f.order().lines.slice(0, 2), oldLines); assert.deepEqual(f.order().people.slice(0, 2), oldPeople);
  assert.throws(() => f.createForm({ id: 'bad-form', batchIds: ['batch-2'], personIds: ['second'] }), code('INVALID_INPUT'));
});

test('partial submissions apply only submitted people and later correction preserves prior reviews and size snapshots', () => {
  const f = fixture(); f.createForm(); f.submit([person('first')]);
  const beforeLines = copy(f.order().lines), result = f.apply(), oldApplication = copy(f.order().preinputApplications[0]), oldReview = copy(f.form().reviews[0]);
  assert.deepEqual(result.appliedPersonIds, ['first']); assert.deepEqual(result.remainingPersonIds, ['second']); assert.equal(f.order().people[0].name, '일행 1');
  assert.equal(f.order().people[0].preinput.name, 'first 실명'); assert.equal(f.order().people[1].preinput, undefined);
  f.submit([person('first', { footMm: 270 }), person('second')]);
  assert.throws(() => f.apply(), code('VERSION_CONFLICT'));
  f.apply({ submissionVersion: 2 });
  assert.equal(f.order().people[0].preinput.footMm, 270); assert.equal(f.order().preinputApplications[1].changes[0].before.footMm, 260);
  assert.deepEqual(f.order().preinputApplications[0], oldApplication); assert.deepEqual(f.form().reviews[0], oldReview); assert.deepEqual(f.order().lines, beforeLines);
  assert.throws(() => f.apply({ submissionVersion: 2 }), code('NO_CHANGE'));
});

test('staff review correction changes only current preinput and cannot add unrelated people', () => {
  const f = fixture(); f.createForm({ personIds: ['first'] }); f.submit([person('first')]); const before = copy(f.state);
  assert.throws(() => f.apply({ people: [person('second')] }), code('INVALID_INPUT')); assert.deepEqual(f.state, before);
  assert.throws(() => f.apply({ people: {} }), code('INVALID_INPUT')); assert.deepEqual(f.state, before);
  f.apply({ people: [person('first', { footMm: 280 })] });
  assert.equal(f.form().submissions[0].people[0].footMm, 260); assert.equal(f.form().reviews[0].people[0].footMm, 280); assert.equal(f.order().people[0].preinput.footMm, 280);
});

test('a changed equipment request remains visible for staff review and never silently changes sold items or charge', () => {
  const f = fixture(); f.createForm({ personIds: ['first'] }); const lines = copy(f.order().lines);
  f.submit([person('first', { equipment: 'board', clothing: true, clothingSize: 'L', helmet: true })]); const result = f.apply();
  assert.equal(result.needsOrderReview, true); assert.deepEqual(f.order().people[0].preinput.orderDifferences.map(row => row.field), ['equipment', 'clothing', 'helmet']);
  assert.deepEqual(f.order().lines, lines); assert.equal(Orders.view(f.state, 'receipt-1').amountWon, 80000);
  f.print(); assert.match(Docs.html(f.state.printJobs[0].document), /요청 품목 차이 확인/);
});

test('already-known people require explicit reselection and team-common equipment does not invent participants', () => {
  const f = fixture(); f.createForm(); f.submit([person('first'), person('second')]); f.apply();
  assert.throws(() => f.createForm({ id: 'new-form' }), code('NO_CHANGE'));
  f.createForm({ id: 'retry-form', personIds: ['first'] }); assert.equal(f.form('retry-form').requestedPeople[0].footMm, 260);
  f.call('order.add', { orderId: 'receipt-1', batch: { id: 'common', lines: [line('common-ski', null)] } });
  assert.throws(() => f.createForm({ id: 'common-form', batchIds: ['common'] }), code('NO_CHANGE'));
  assert.equal(f.order().people.length, 2); f.print('a4', { batchIds: ['common'] }); assert.equal(f.state.printJobs[0].document.rows[0].personName, '팀 공용');
});

test('legacy form association requires explicit per-person mapping and never merges old physical issues', () => {
  const f = fixture();
  f.call('intake.create', { id: 'external', customer, expectedPeople: 2, accessHash: hash, expiresAt: expiry });
  f.submit([person('old-first'), person('unrelated')], 'external');
  f.call('ops.link', { orderId: 'receipt-1', sourceType: 'form', sourceId: 'external' });
  assert.throws(() => f.apply({ formId: 'external' }), code('INVALID_INPUT'));
  f.call('docs.formBind', { orderId: 'receipt-1', formId: 'external', batchIds: ['batch-1'], personLinks: [{ formPersonId: 'old-first', personId: 'first' }] });
  f.apply({ formId: 'external' });
  assert.equal(f.order().people[0].preinput.sourcePersonId, 'old-first'); assert.equal(f.order().people[0].preinput.id, 'first');
  assert.equal(f.form('external').submissions[0].people.length, 2); assert.equal(f.order().people[1].preinput, undefined); assert.equal(f.state.movements.length, 0);
  assert.throws(() => f.call('docs.formBind', { orderId: 'receipt-1', formId: 'external', personLinks: [{ formPersonId: 'old-first', personId: 'second' }] }), code('ALREADY_EXISTS'));
});

test('A4 and sticker snapshots include order, batch, additional status and separate dates with immutable originals', () => {
  const f = fixture(); f.createForm(); f.submit([person('first'), person('second')]); f.apply();
  f.call('order.add', { orderId: 'receipt-1', people: [{ id: 'late' }], batch: { id: 'batch-2', label: '내일 도착 추가', lines: [line('late-ski', 'late', { start: '2026-09-14' })] } });
  f.print('a4'); const original = copy(f.state.printJobs[0].document), firstHTML = Docs.html(original);
  assert.ok(firstHTML.includes('통합접수 ' + (f.order().receiptNo || 'receipt-1'))); assert.equal(original.orderId, 'receipt-1'); assert.match(firstHTML, /추가 · 내일 도착 추가/); assert.match(firstHTML, /batch-2/); assert.match(firstHTML, /2026-09-14/); assert.match(firstHTML, /발 260/);
  f.order().people[0].preinput.footMm = 280; assert.deepEqual(f.state.printJobs[0].document, original);
  f.print('sticker', { id: 'sticker', batchIds: ['batch-2'] }); const sticker = f.state.printJobs[1].document;
  assert.equal(sticker.labels.length, 1); assert.equal(sticker.labels[0].additional, true); assert.equal(sticker.labels[0].date, '2026-09-14'); assert.match(Docs.html(sticker), /추가 접수/);
  assert.equal(f.state.printJobs[0].status, 'queued'); assert.equal(f.state.assets.length, 0);
});

test('printed customer input and actual confirmed preparation size remain distinct', () => {
  const f = fixture(); f.createForm(); f.submit([person('first'), person('second')]); f.apply();
  const ids = f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds;
  f.call('ops.prepare', { orderId: 'receipt-1', id: 'prep-1', lineItems: [{ lineId: 'first-ski', assets: [{ assetId: ids[0], size: '165 cm' }] }] });
  f.print(); const row = f.state.printJobs[0].document.rows[0];
  assert.equal(row.footMm, 260); assert.equal(row.preparedSizes[0].size, '165 cm'); assert.equal(row.issuedQuantity, 0);
  assert.match(Docs.html(f.state.printJobs[0].document), /165 cm/); assert.equal(f.order().people[0].preinput.footMm, 260);
});

test('printed receipt number is frozen while internal links and older print snapshots remain readable', () => {
  const f = fixture(); f.order().receiptNo = '260913-042'; f.print();
  const original = copy(f.state.printJobs[0].document);
  assert.equal(original.receiptNo, '260913-042'); assert.equal(original.orderId, 'receipt-1');
  assert.equal(original.sources[0].orderId, 'receipt-1'); assert.match(Docs.html(original), /통합접수 260913-042/);
  f.order().receiptNo = '260913-043'; assert.match(Docs.html(original), /통합접수 260913-042/);
  f.print('sticker', { id: 'receipt-sticker' }); assert.match(Docs.html(f.state.printJobs[1].document), /260913-043/);
  const legacy = copy(original); delete legacy.receiptNo;
  for (const page of legacy.pages) for (const row of page.rows) delete row.orderDifferences;
  assert.match(Docs.html(legacy), /통합접수 receipt-1/);
});

test('print attempts truthfully track queued, dispatched and unknown without implying physical printing', () => {
  const f = fixture(); f.print();
  f.call('print.record', { id: 'print-1', status: 'dispatched', device: 'browser-preview', note: '브라우저 인쇄 창 호출' });
  f.call('print.record', { id: 'print-1', status: 'unknown', device: 'browser-preview', note: '실제 인쇄 결과는 확인할 수 없음' });
  assert.deepEqual(f.state.printJobs[0].attempts.map(a => a.status), ['dispatched', 'unknown']); assert.equal(f.state.printJobs[0].status, 'unknown');
  assert.equal(f.state.movements.length, 0); assert.equal(f.state.deliveries.length, 0);
});

test('HTML escapes customer, aliases, labels and asset sizes and paginates long preparation tables', () => {
  const f = fixture(); f.order().customer.name = '<script>alert(1)</script>'; f.order().people[0].name = '<img src=x onerror=alert(2)>';
  f.call('order.add', { orderId: 'receipt-1', batch: { id: 'large', label: '<script>bad</script>', lines: Array.from({ length: 30 }, (_, index) => line('line-' + index, 'first')) } });
  f.print(); const document = f.state.printJobs[0].document, html = Docs.html(document);
  assert.equal(document.pages.length, 3); assert.ok(document.pages.every(page => page.rows.length <= 14));
  assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;img/); assert.match(html, /default-src 'none'/);
  f.print('sticker', { id: 'many-stickers' }); const labels = f.state.printJobs[1].document.labels;
  assert.equal(labels.reduce((total, label) => total + label.rows.length, 0), 32); assert.ok(labels.every(label => label.rows.length <= 2));
  assert.ok(!Docs.html(f.state.printJobs[1].document).includes('overflow:hidden')); assert.match(Docs.html(f.state.printJobs[1].document), /15\/15장/);
});

test('invalid form authorization, duplicate print IDs, cancelled-only batches and driver commands are atomic', () => {
  const f = fixture(), before = copy(f.state);
  assert.throws(() => f.createForm({ accessHash: 'bad' }), code('INVALID_INPUT')); assert.deepEqual(f.state, before);
  assert.throws(() => f.createForm({ expiresAt: context.at }), code('INVALID_INPUT')); assert.deepEqual(f.state, before);
  const driver = { ...context, actor: { id: 'driver', role: 'driver', vehicleId: 'van-1' } };
  assert.throws(() => f.call('docs.orderPrint', { orderId: 'receipt-1', id: 'driver-print', kind: 'a4' }, driver), code('FORBIDDEN'));
  f.print(); assert.throws(() => f.print(), code('ALREADY_EXISTS'));
  f.call('order.cancel', { orderId: 'receipt-1', batchId: 'batch-1', reason: '미도착' }); assert.throws(() => f.print('sticker', { id: 'cancelled' }), code('NO_CHANGE'));
});

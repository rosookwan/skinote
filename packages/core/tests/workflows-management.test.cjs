const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepository } = require('../src/returns/service.js');
const { createSqliteRepository } = require('../server/returns-repository.cjs');
const Inventory = require('../src/workflows/inventory.js');
const Management = require('../src/workflows/management.js');
const Finance = require('../src/workflows/finance.js');
const { fixture, ctx, shop, van, errorCode } = require('./workflows-fixtures.cjs');
const raw = f => f.repository.workflows(ctx.shopId);
function order(f, id = 'group', phone = '010-1111-2222') {
  f.call('order.create', { id, customer: { name: '대표자', phone }, batch: { id: 'first', lines: [{ id: 'ski-line', sku: 'ski', quantity: 1,
    start: '2026-09-09', end: '2026-09-09', price: { unitWon: 10000 } }] } });
}
function partner(f, id = 'partner') { f.call('partner.save', { id, name: '이웃 스키샵', phone: '010-2222-3333' }); }

for (const mode of ['memory', 'sqlite']) test(mode + ': maintenance excludes stock from load, issue, delivery allocation and ready counts until inspection completes', () => {
  const repository = mode === 'sqlite' ? createSqliteRepository(':memory:') : createMemoryRepository();
  try {
    const f = fixture(repository); order(f);
    for (const condition of ['cleaning', 'inspection', 'repair', 'lost']) {
      const ids = f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds;
      f.call('management.asset', { assetIds: ids, condition, reason: '재대여 전 확인' });
      const before = raw(f);
      assert.equal(Inventory.allocatable(before, before.assets.find(asset => asset.id === ids[0])), false);
      assert.throws(() => f.move('load', ids, shop, van), errorCode('INVALID_INPUT'));
      assert.throws(() => f.call('order.issue', { orderId: 'group', lineItems: [{ lineId: 'ski-line', assetIds: ids }] }), errorCode('INVALID_INPUT'));
      assert.throws(() => f.task('bad-' + condition, 'delivery', 'customer', ids), errorCode('INVALID_INPUT'));
      assert.deepEqual(raw(f), before);
      assert.equal(Management.summary(before).inventory.find(row => row.sku === 'ski').available, 0);
      if (condition === 'lost') {
        assert.throws(() => f.call('management.asset', { assetIds: ids, condition: 'ready', reason: '실물확인 생략' }), errorCode('INVALID_INPUT'));
        f.call('management.found', { assetId: ids[0], condition: 'inspection', reason: '보관함에서 발견' });
      }
      f.call('management.asset', { assetIds: ids, condition: 'ready', reason: '점검 완료' });
      assert.equal(Management.summary(raw(f)).inventory.find(row => row.sku === 'ski').available, 1);
      f.move('deliver', ids, shop, { kind: 'customer', id: 'other-' + condition });
    }
  } finally { repository.close?.(); }
});

test('lost customer equipment retains the last holder; found makes a physical return and waits for inspection', () => {
  const f = fixture(); order(f);
  const ids = f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds;
  f.call('order.issue', { orderId: 'group', lineItems: [{ lineId: 'ski-line', assetIds: ids }] });
  f.task('collect', 'collection', 'group', ids);
  f.call('management.asset', { assetIds: ids, condition: 'lost', reason: '현장 분실 신고' });
  let asset = raw(f).assets.find(asset => asset.id === ids[0]);
  assert.deepEqual(asset.location, { kind: 'customer', id: 'group' });
  assert.deepEqual(asset.loss.lastKnownLocation, asset.location);
  const found = f.call('management.found', { assetId: ids[0], condition: 'inspection', reason: '매장에 습득품 도착' });
  asset = raw(f).assets.find(asset => asset.id === ids[0]);
  assert.deepEqual(asset.location, shop); assert.equal(asset.condition, 'inspection');
  assert.equal(raw(f).movements.find(row => row.id === found.movementId).recovery, 'found');
  assert.equal(f.store.snapshot().orders.find(row => row.id === 'group').status, 'returned');
  assert.equal(raw(f).tasks.find(row => row.id === 'collect').status, 'completed');
  assert.equal(Finance.summary(raw(f), 'group').dueWon, 10000, 'found does not forgive rental debt');
  assert.throws(() => f.call('management.found', { assetId: ids[0], condition: 'inspection', reason: '중복' }), errorCode('NO_CHANGE'));
  f.call('management.asset', { assetIds: ids, condition: 'ready', reason: '수량·상태 점검 완료' });
  f.move('deliver', ids, shop, { kind: 'customer', id: 'next-customer' });
});

test('bulk condition writes are atomic, vehicle loss uses actual store receipt, and drivers cannot change maintenance', () => {
  const f = fixture(), ids = f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds;
  const before = raw(f);
  assert.throws(() => f.call('management.asset', { assetIds: [...ids, 'missing'], condition: 'cleaning', reason: '검사' }), errorCode('NOT_FOUND'));
  assert.throws(() => f.call('management.asset', { assetIds: ids, condition: 'cleaning', reason: '검사' }, f.driver), errorCode('FORBIDDEN'));
  assert.deepEqual(raw(f), before);
  f.move('load', ids, shop, van);
  f.call('management.asset', { assetIds: ids, condition: 'lost', reason: '차량 분실 확인' });
  assert.equal(f.driver.vehicle().totals.find(row => row.sku === 'ski').availableToDeliver, 0);
  const result = f.call('management.found', { assetId: ids[0], condition: 'inspection', reason: '기사님이 찾아 매장 인계' });
  assert.equal(raw(f).movements.find(row => row.id === result.movementId).kind, 'receive');
  assert.deepEqual(raw(f).assetEvents.at(-1).before[0].location, van);
});

test('contact edits preserve accepted customer snapshots and similar visits link only by explicit selection', () => {
  const f = fixture(); order(f, 'first'); order(f, 'second'); order(f, 'other', '010-4444-5555');
  const original = structuredClone(raw(f).orders);
  const result = f.call('management.customer', { orderId: 'first', note: '연락 가능 시간 확인' });
  let view = Management.summary(raw(f));
  assert.deepEqual(view.customerProfiles[0].orderIds, ['first']);
  assert.deepEqual(view.customerProfiles[0].matchingCandidates.map(row => row.orderId), ['second']);
  f.call('management.customer.link', { profileId: result.profileId, orderIds: ['second'] });
  f.call('management.customer', { orderId: 'first', name: '새 연락처 이름', phone: '010-7777-8888' });
  assert.deepEqual(raw(f).orders, original);
  view = Management.summary(raw(f));
  assert.equal(view.customerProfiles[0].name, '새 연락처 이름'); assert.equal(view.customerProfiles[0].visits.length, 2);
  assert.equal(raw(f).orders.length, 3, 'linking never merges visits');
  const other = f.call('management.customer', { orderId: 'other', note: '다른 고객' });
  assert.throws(() => f.call('management.customer.link', { profileId: other.profileId, orderIds: ['first'] }), errorCode('ALREADY_EXISTS'));
});

test('settings are versioned; changing rates, staff or return presets leaves existing rentals and authentication unchanged', () => {
  const f = fixture(); order(f);
  const original = structuredClone(raw(f).orders[0]);
  const first = f.call('management.settings', { patch: { rates: [{ sku: 'ski', unitWon: 20000 }], places: ['광장', '주차장'],
    vehicles: [{ id: 'van-1', name: '1호 차량' }], returnTimes: [{ id: 'night', label: '야간 후', time: '22:00', dayOffset: 0 }],
    staff: [{ id: 'driver-1', name: '기사님', role: 'driver', phone: '010-3333-4444', vehicleId: 'van-1' }], nightCutoff: null } });
  assert.equal(first.authenticationChanged, false);
  const snapshot = structuredClone(raw(f).settingVersions[0]);
  f.call('management.settings', { patch: { rates: [{ sku: 'ski', unitWon: 25000 }], nightCutoff: '04:00' } });
  assert.deepEqual(raw(f).settingVersions[0], snapshot); assert.deepEqual(raw(f).orders[0], original);
  assert.equal(Management.summary(raw(f)).settings.rates[0].unitWon, 25000);
  assert.equal(Management.summary(raw(f)).settingsVersion, 2);
  assert.throws(() => f.call('management.settings', { patch: { rates: [{ sku: 'ski', unitWon: -1 }] } }), errorCode('INVALID_INPUT'));
  assert.throws(() => f.call('management.settings', { patch: { vehicles: [] } }), errorCode('INVALID_INPUT'));
  assert.throws(() => f.call('management.settings', { patch: { staff: [{ id: 'admin', name: '관리자', role: 'manager', permissions: ['closing.reopen'] }] } }), errorCode('INVALID_INPUT'));
});

test('pickup places are grouped by area; the flat place list stays in step and older settings are read without areas', () => {
  const f = fixture();
  f.call('management.settings', { patch: { places: ['만선 티롤 앞', '만선 광장', '설천 주차장', '곤도라 앞'] } });
  let settings = Management.summary(raw(f)).settings;
  assert.deepEqual(settings.areas.map(area => [area.name, area.places]), [['만선', ['만선 티롤 앞', '만선 광장']], ['기타', ['설천 주차장', '곤도라 앞']]]);
  f.call('management.settings', { patch: { areas: [{ id: 'a1', name: '만선', places: ['만선 티롤 앞', '만선 광장'] }, { id: 'a2', name: '설천', places: ['설천 주차장'] }, { id: 'area-etc', name: '기타', places: ['곤도라 앞'] }] } });
  settings = Management.summary(raw(f)).settings;
  assert.deepEqual(settings.places, ['만선 티롤 앞', '만선 광장', '설천 주차장', '곤도라 앞']);
  f.call('management.settings', { patch: { places: ['만선 티롤 앞', '설천 주차장', '설천 셔틀 정류장'] } });
  settings = Management.summary(raw(f)).settings;
  assert.deepEqual(settings.areas.map(area => [area.name, area.places]), [['만선', ['만선 티롤 앞']], ['설천', ['설천 주차장', '설천 셔틀 정류장']], ['기타', []]]);
  assert.throws(() => f.call('management.settings', { patch: { areas: [{ id: 'a1', name: '만선', places: ['광장'] }, { id: 'a2', name: '설천', places: ['광장'] }] } }), errorCode('INVALID_INPUT'));
  assert.throws(() => f.call('management.settings', { patch: { areas: [{ id: 'a1', name: '만선', places: [] }, { id: 'a2', name: '만선', places: [] }] } }), errorCode('INVALID_INPUT'));
  const legacy = structuredClone(raw(f)); // saved before areas and discounts existed
  legacy.settingVersions.at(-1).settings = { rates: [], places: ['만선 광장'], vehicles: [], returnTimes: [], staff: [], nightCutoff: null, store: { name: '', phone: '', address: '', link: '' } };
  assert.deepEqual(Management.summary(legacy).settings.areas, [{ id: 'area-etc', name: '기타', places: ['만선 광장'] }]);
  assert.deepEqual(Management.summary(legacy).settings.discounts, []);
});

test('discount presets are validated and one discount at a time is spread over the line prices', () => {
  const f = fixture();
  f.call('management.settings', { patch: { discounts: [{ id: 'd1', kind: 'perUnit', sku: 'ski', amountWon: 5000 }, { id: 'd2', kind: 'percent', percent: 10 }, { id: 'd3', kind: 'amount', amountWon: 10000 }, { id: 'd4', kind: 'liftPercent', percent: 27 }] } });
  assert.equal(Management.summary(raw(f)).settings.discounts.length, 4);
  assert.throws(() => f.call('management.settings', { patch: { discounts: [{ id: 'd1', kind: 'perUnit', sku: 'ski', amountWon: 5000 }, { id: 'd2', kind: 'perUnit', sku: 'ski', amountWon: 3000 }] } }), errorCode('INVALID_INPUT'));
  assert.throws(() => f.call('management.settings', { patch: { discounts: [{ id: 'd1', kind: 'percent', percent: 101 }] } }), errorCode('INVALID_INPUT'));
  assert.throws(() => f.call('management.settings', { patch: { discounts: [{ id: 'd1', kind: 'perUnit', sku: 'missing', amountWon: 1 }] } }), errorCode('NOT_FOUND'));
  const lines = [{ id: 'ski', sku: 'ski', quantity: 3, unitWon: 20000, days: 2 }, { id: 'coat', sku: 'clothing', quantity: 2, unitWon: 10000, days: 2 }, { id: 'lift', sku: 'ticket', quantity: 2, unitWon: 35000, days: 2, ticket: true }];
  const perUnit = Management.applyDiscounts(lines, { gear: { kind: 'perUnit', perUnit: { ski: 5000, clothing: 3000 } }, lift: { percent: 25 } });
  assert.deepEqual(perUnit, { lines: { ski: 30000, coat: 12000, lift: 17500 }, gearGrossWon: 160000, gearDiscountWon: 42000, liftGrossWon: 70000, liftDiscountWon: 17500 });
  const percent = Management.applyDiscounts(lines, { gear: { kind: 'percent', percent: 10 } });
  assert.equal(percent.gearDiscountWon, 16000); assert.deepEqual(percent.lines, { ski: 12000, coat: 4000, lift: 0 });
  const amount = Management.applyDiscounts(lines, { gear: { kind: 'amount', amountWon: 10000 }, lift: { percent: 27 } });
  assert.equal(amount.gearDiscountWon, 10000); assert.equal(amount.lines.ski + amount.lines.coat, 10000); assert.equal(amount.liftDiscountWon, 18900);
  assert.equal(Management.applyDiscounts(lines, { gear: { kind: 'amount', amountWon: 999999 } }).gearDiscountWon, 160000, 'never below zero');
  assert.deepEqual(Management.applyDiscounts(lines, { gear: { kind: 'none' } }).lines, { ski: 0, coat: 0, lift: 0 });
  const odd = Management.applyDiscounts([{ id: 'a', sku: 'ski', quantity: 1, unitWon: 33330, days: 1 }, { id: 'b', sku: 'board', quantity: 1, unitWon: 11110, days: 1 }], { gear: { kind: 'percent', percent: 27 } });
  assert.equal(odd.gearDiscountWon, 11990); assert.equal(odd.lines.a + odd.lines.b, 11990);
});

test('borrowed stock keeps partner ownership through rental; partial physical return never implies settlement', () => {
  const f = fixture(); partner(f);
  const borrowed = f.call('partner.borrow', { id: 'loan', partnerId: 'partner', sku: 'ski', quantity: 2, size: '160', dueDate: '2026-09-10' });
  assert.equal(borrowed.assetIds.length, 2);
  f.move('deliver', borrowed.assetIds.slice(0, 1), shop, { kind: 'customer', id: 'renter' });
  assert.throws(() => f.call('partner.return', { id: 'not-here', assetIds: borrowed.assetIds }), errorCode('QUANTITY_EXCEEDED'));
  assert.equal(raw(f).partnerReturns.length, 0);
  f.call('partner.return', { id: 'partial', assetIds: borrowed.assetIds.slice(1) });
  let view = Management.summary(raw(f)).partners[0];
  assert.equal(view.loans[0].returnedQuantity, 1); assert.equal(view.loans[0].outstandingQuantity, 1); assert.equal(view.paidWon, 0); assert.equal(view.agreedChargeWon, null);
  f.move('directReturn', borrowed.assetIds.slice(0, 1), { kind: 'customer', id: 'renter' }, shop);
  f.call('partner.money', { id: 'bank-paid', partnerId: 'partner', kind: 'payment', amountWon: 15000, reason: '별도로 합의한 대여료', method: 'transfer' });
  assert.equal(Management.summary(raw(f)).partners[0].loans[0].outstandingQuantity, 1);
  f.call('partner.return', { id: 'rest', assetIds: borrowed.assetIds.slice(0, 1) });
  assert.equal(Management.summary(raw(f)).partners[0].loans[0].outstandingQuantity, 0);
  assert.deepEqual(raw(f).assets.find(asset => asset.id === borrowed.assetIds[0]).owner, { kind: 'partner', id: 'partner' });
  assert.throws(() => f.call('partner.return', { id: 'twice', assetIds: borrowed.assetIds }), errorCode('QUANTITY_EXCEEDED'));
});

test('partner return rejects own or allocated equipment and partner cash reaches the drawer exactly once', () => {
  const f = fixture(); partner(f);
  const own = f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds;
  assert.throws(() => f.call('partner.return', { id: 'own', assetIds: own }), errorCode('INVALID_INPUT'));
  const loan = f.call('partner.borrow', { id: 'loan', partnerId: 'partner', sku: 'ski', quantity: 1, dueDate: '2026-09-10' });
  f.task('assigned', 'delivery', 'customer', loan.assetIds);
  assert.throws(() => f.call('partner.return', { id: 'assigned-return', assetIds: loan.assetIds }), errorCode('DEPENDENT_MOVEMENT'));
  const command = { type: 'partner.money', requestId: 'cash-once', expectedVersion: f.store.snapshot().revision,
    payload: { id: 'cash-receipt', partnerId: 'partner', kind: 'receipt', amountWon: 30000, method: 'cash', reason: '실제 받은 현금' } };
  f.store.execute(command); assert.equal(f.store.execute(command).duplicate, true);
  f.call('partner.money', { id: 'unknown-method', partnerId: 'partner', kind: 'receipt', amountWon: 90000, reason: '방법 확인 필요' });
  f.call('partner.money', { id: 'cash-payment', partnerId: 'partner', kind: 'payment', amountWon: 10000, method: 'cash', reason: '실제 지급한 현금' });
  assert.equal(Finance.day(raw(f), '2026-09-09').cashMovementWon, 20000);
  assert.equal(raw(f).cashEntries.length, 2); assert.equal(raw(f).partnerMoney.find(row => row.id === 'unknown-method').method, null);
  assert.equal(raw(f).cashEntries[0].partnerMoneyId, 'cash-receipt');
  f.call('closing.close', { id: 'closed', date: '2026-09-09', countedCashWon: 20000 });
  assert.throws(() => f.call('partner.money', { id: 'late', partnerId: 'partner', kind: 'receipt', amountWon: 1000, method: 'transfer', reason: '마감후' }), errorCode('CLOSING_LOCKED'));
});

test('prepared stock is unavailable to other orders and needs its exact order line for loading', () => {
  const f = fixture(), ids = f.call('stock.receive', { sku: 'ski', quantity: 1 }).assetIds;
  // This is the public inventory contract used by ops.prepare, independent of its UI.
  const state = structuredClone(raw(f)); state.assets[0].orderPreparation = { orderId: 'owner', lineId: 'line', preparationId: 'prepare' };
  assert.equal(Inventory.allocatable(state, state.assets[0]), false);
  assert.throws(() => Inventory.move(structuredClone(state), { kind: 'deliver', assetIds: ids, from: shop, to: { kind: 'customer', id: 'other' } }, { ...ctx, at: f.clock() }), errorCode('ALREADY_EXISTS'));
  const own = structuredClone(state);
  Inventory.move(own, { kind: 'deliver', assetIds: ids, from: shop, to: { kind: 'customer', id: 'owner' } }, { ...ctx, at: f.clock() });
  assert.equal(own.assets[0].location.id, 'owner');
  assert.equal(own.assets[0].orderPreparation, undefined);
  assert.equal(own.movements.at(-1).before.assets[0].orderPreparation.orderId, 'owner');
  state.tasks.push({ id: 'load-owner', kind: 'delivery', orderId: 'owner', customerId: 'owner', vehicleId: 'van-1', status: 'waiting', assetIds: ids,
    plannedItems: [{ itemId: 'different-line', assetIds: ids, quantity: 1 }] });
  assert.throws(() => Inventory.move(structuredClone(state), { kind: 'load', assetIds: ids, from: shop, to: van, taskId: 'load-owner' }, { ...ctx, at: f.clock() }), errorCode('ALREADY_EXISTS'));
  delete state.tasks[0].plannedItems;
  state.tasks[0].lineItems = [{ lineId: 'line', assetIds: ids }];
  Inventory.move(state, { kind: 'load', assetIds: ids, from: shop, to: van, taskId: 'load-owner' }, { ...ctx, at: f.clock() });
  assert.deepEqual(state.assets[0].location, van);
});

for (const mode of ['memory', 'sqlite']) test(mode + ': partner lending uses only free own stock and partial recovery preserves prior lending history after reuse', () => {
  const repository = mode === 'sqlite' ? createSqliteRepository(':memory:') : createMemoryRepository();
  try {
    const f = fixture(repository); partner(f);
    const ids = f.call('stock.receive', { sku: 'ski', quantity: 3 }).assetIds;
    const borrowed = f.call('partner.borrow', { id: 'borrow', partnerId: 'partner', sku: 'ski', quantity: 1, dueDate: '2026-09-10' }).assetIds;
    let before = raw(f);
    assert.throws(() => f.call('partner.lend', { id: 'bad-owner', partnerId: 'partner', assetIds: [ids[0], borrowed[0]], dueDate: '2026-09-10', reason: '실물 전달' }), errorCode('QUANTITY_EXCEEDED'));
    assert.deepEqual(raw(f), before);
    f.task('reserved', 'delivery', 'customer', [ids[2]]); before = raw(f);
    assert.throws(() => f.call('partner.lend', { id: 'bad-allocation', partnerId: 'partner', assetIds: [ids[0], ids[2]], dueDate: '2026-09-10', reason: '실물 전달' }), errorCode('QUANTITY_EXCEEDED'));
    assert.deepEqual(raw(f), before);
    const originalCount = raw(f).assets.length;
    f.call('partner.lend', { id: 'first-lending', partnerId: 'partner', assetIds: ids.slice(0, 2), dueDate: '2026-09-10', reason: '실물 전달' });
    assert.equal(raw(f).assets.length, originalCount, 'lending never fabricates stock');
    assert.deepEqual(raw(f).assets.find(a => a.id === ids[0]).location, { kind: 'vendor', id: 'partner' });
    assert.equal(Management.summary(raw(f)).inventory.find(r => r.sku === 'ski').partnerOut, 2);
    f.call('partner.receive', { id: 'receive-one', assetIds: [ids[0]], reason: '실물 회수' });
    assert.equal(raw(f).assets.find(a => a.id === ids[0]).condition, 'inspection');
    assert.equal(raw(f).assets.find(a => a.id === ids[0]).activePartnerLendingId, undefined);
    let view = Management.summary(raw(f)).partners[0]; assert.equal(view.lendings[0].receivedQuantity, 1); assert.equal(view.lendings[0].outstandingQuantity, 1); assert.equal(view.paidWon, 0);
    before = raw(f); assert.throws(() => f.call('partner.receive', { id: 'twice', assetIds: ids.slice(0, 2), reason: '중복 회수' }), errorCode('INVALID_INPUT')); assert.deepEqual(raw(f), before);
    assert.throws(() => f.call('partner.lend', { id: 'before-inspection', partnerId: 'partner', assetIds: [ids[0]], dueDate: '2026-09-10', reason: '다시 빌려주기' }), errorCode('QUANTITY_EXCEEDED'));
    f.call('management.asset', { assetIds: [ids[0]], condition: 'ready', reason: '점검 완료' });
    f.call('partner.lend', { id: 'second-lending', partnerId: 'partner', assetIds: [ids[0]], dueDate: '2026-09-11', reason: '다시 실물 전달' });
    view = Management.summary(raw(f)).partners[0]; assert.equal(view.lendings[0].receivedQuantity, 1); assert.equal(view.lendings[0].outstandingQuantity, 1); assert.equal(view.lendings[1].outstandingQuantity, 1);
    assert.throws(() => f.call('partner.receive', { id: 'driver-receive', assetIds: [ids[1]], reason: '차량 업무 아님' }, f.driver), errorCode('FORBIDDEN'));
  } finally { repository.close?.(); }
});

test('partner agreements, explicit offset and allocated actual payment preserve cash, unallocated money and immutable obligations', () => {
  const f = fixture(); partner(f); partner(f, 'other');
  f.call('partner.money', { id: 'old-unallocated', partnerId: 'partner', kind: 'payment', amountWon: 5000, method: 'transfer', reason: '별도 확인할 실제 지급' });
  f.call('partner.agreement', { id: 'payable', partnerId: 'partner', kind: 'payable', amountWon: 30000, reason: '빌린 장비 약정' });
  f.call('partner.agreement', { id: 'receivable', partnerId: 'partner', kind: 'receivable', amountWon: 20000, reason: '빌려준 장비 약정' });
  const original = structuredClone(raw(f).partnerAgreements);
  let p = Management.summary(raw(f)).partners.find(p => p.id === 'partner'); assert.equal(p.payableWon, 30000); assert.equal(p.unallocatedPaymentWon, 5000);
  const offset = { type: 'partner.offset', requestId: 'same-offset', expectedVersion: f.store.snapshot().revision, payload: { id: 'offset', partnerId: 'partner', receivableId: 'receivable', payableId: 'payable', amountWon: 5000, reason: '양사 상계 합의' } };
  f.store.execute(offset); assert.equal(f.store.execute(offset).duplicate, true); assert.equal(raw(f).partnerOffsets.length, 1); assert.equal(raw(f).cashEntries.length, 0);
  let before = raw(f);
  assert.throws(() => f.call('partner.offset', { id: 'too-much', partnerId: 'partner', receivableId: 'receivable', payableId: 'payable', amountWon: 16000, reason: '초과' }), errorCode('QUANTITY_EXCEEDED'));
  assert.throws(() => f.call('partner.offset', { id: 'wrong-partner', partnerId: 'other', receivableId: 'receivable', payableId: 'payable', amountWon: 1, reason: '다른 거래처' }), errorCode('INVALID_INPUT')); assert.deepEqual(raw(f), before);
  f.call('partner.money', { id: 'cash-paid', partnerId: 'partner', kind: 'payment', amountWon: 10000, method: 'cash', agreementId: 'payable', reason: '실제 지급 확인' });
  p = Management.summary(raw(f)).partners.find(p => p.id === 'partner'); assert.equal(p.payableWon, 15000); assert.equal(p.receivableWon, 15000); assert.equal(p.offsetWon, 5000); assert.equal(p.unallocatedPaymentWon, 5000);
  assert.equal(Finance.day(raw(f), '2026-09-09').cashMovementWon, -10000); assert.deepEqual(raw(f).partnerAgreements, original);
  before = raw(f); assert.throws(() => f.call('partner.money', { id: 'wrong-direction', partnerId: 'partner', kind: 'receipt', amountWon: 1, method: 'cash', agreementId: 'payable', reason: '방향 오류' }), errorCode('INVALID_INPUT')); assert.deepEqual(raw(f), before);
  f.call('closing.close', { id: 'closed', date: '2026-09-09', openingCashWon: 50000, countedCashWon: 40000 }); before = raw(f);
  assert.throws(() => f.call('partner.agreement', { id: 'after-close', partnerId: 'partner', kind: 'payable', amountWon: 1000, reason: '마감 후' }), errorCode('CLOSING_LOCKED'));
  assert.throws(() => f.call('partner.offset', { id: 'after-close', partnerId: 'partner', receivableId: 'receivable', payableId: 'payable', amountWon: 1, reason: '마감 후' }), errorCode('CLOSING_LOCKED')); assert.deepEqual(raw(f), before);
});

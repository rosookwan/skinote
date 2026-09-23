(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'), require('./inventory.js'), require('./orders.js'), require('./finance.js'));
  else root.SkiWorkflowManagement = factory(root.SkiWorkflowCommon, root.SkiWorkflowInventory, root.SkiWorkflowOrders, root.SkiWorkflowFinance);
})(globalThis, function (C, I, O, G) {
  'use strict';
  const LIMIT = Number.MAX_SAFE_INTEGER;
  const conditions = ['ready', 'cleaning', 'inspection', 'repair', 'lost'];
  const lists = ['assetEvents', 'customerProfiles', 'settingVersions', 'partners', 'partnerLoans', 'partnerReturns', 'partnerMoney', 'partnerLendings', 'partnerReceipts', 'partnerAgreements', 'partnerOffsets'];
  const defaults = () => ({ rates: [], places: [], areas: [], discounts: [], vehicles: [], returnTimes: [], staff: [], nightCutoff: null, store: { name: '', phone: '', address: '', link: '' } });
  // Pickup places are grouped by area (만선 · 설천 · 기타). `places` stays the flat list every other screen reads; `areas` is where they are edited.
  // Settings saved before areas existed are read through normalize(): a place goes to the area its name starts with, otherwise to 기타.
  function groupPlaces(places, areas) {
    const next = (areas || []).map(area => ({ id: area.id, name: area.name, places: area.places.filter(place => places.includes(place)) }));
    for (const place of places) {
      if (next.some(area => area.places.includes(place))) continue;
      let area = next.find(row => row.name !== '기타' && place.startsWith(row.name)) || next.find(row => row.id === 'area-etc');
      if (!area) { const head = place.split(' ')[0]; area = places.filter(row => row.startsWith(head + ' ')).length > 1 && head !== place ? { id: 'area-' + (next.length + 1), name: head, places: [] } : { id: 'area-etc', name: '기타', places: [] }; next.push(area); }
      area.places.push(place);
    }
    return next;
  }
  function normalize(settings) {
    const next = { ...defaults(), ...C.copy(settings || {}) };
    if (!settings?.areas) next.areas = groupPlaces(next.places, []);
    return next;
  }
  // Discounts never stack (docs/44): gear takes one of per-item-per-day, percent or an amount off the total; lift tickets take a percent of their own.
  // Returns the discount of every line (whole won, percent results drop below 10 won) so it can be stored on the line price.
  function applyDiscounts(lines, choice) {
    const gross = line => line.quantity * line.unitWon * (line.ticket ? 1 : line.days), floor10 = value => Math.floor(value / 10) * 10, result = Object.fromEntries(lines.map(line => [line.id, 0]));
    const spread = (group, total) => {
      const base = group.reduce((n, line) => n + gross(line), 0); let left = Math.min(total, base); if (!base || left <= 0) return;
      for (const line of group) { const part = Math.min(gross(line), floor10(total * gross(line) / base)); result[line.id] = part; left -= part; }
      for (const line of group.slice().sort((a, b) => gross(b) - gross(a))) { const room = gross(line) - result[line.id], add = Math.min(room, left); result[line.id] += add; left -= add; if (!left) break; }
    };
    const gear = lines.filter(line => !line.ticket), lift = lines.filter(line => line.ticket), g = choice?.gear || { kind: 'none' };
    if (g.kind === 'perUnit') for (const line of gear) result[line.id] = Math.min(gross(line), (g.perUnit?.[line.sku] || 0) * line.quantity * line.days);
    else if (g.kind === 'percent') spread(gear, floor10(gear.reduce((n, line) => n + gross(line), 0) * C.integer(g.percent, 1, 100) / 100));
    else if (g.kind === 'amount') spread(gear, C.integer(g.amountWon, 1, LIMIT));
    if (choice?.lift?.percent) spread(lift, floor10(lift.reduce((n, line) => n + gross(line), 0) * C.integer(choice.lift.percent, 1, 100) / 100));
    const total = group => group.reduce((n, line) => n + gross(line), 0), cut = group => group.reduce((n, line) => n + result[line.id], 0);
    return { lines: result, gearGrossWon: total(gear), gearDiscountWon: cut(gear), liftGrossWon: total(lift), liftDiscountWon: cut(lift) };
  }
  const sum = values => values.reduce((total, value) => C.integer(total + value, 0, LIMIT), 0);
  function initialize(state) {
    for (const key of lists) {
      if (state[key] == null) state[key] = [];
      if (!Array.isArray(state[key])) C.fail('INVALID_INPUT', '매장 관리 기록 형식을 확인해 주세요.');
    }
    return state;
  }
  function idFor(state, key, value) {
    const id = C.id(value);
    if (state[key].some(row => row.id === id)) C.fail('ALREADY_EXISTS', '이미 사용한 관리번호입니다. 기존 기록을 확인해 주세요.');
    return id;
  }
  const at = context => ({ at: C.instant(context.at), actor: C.copy(context.actor) });
  function assetEvent(state, type, assets, context, reason, before, extra = {}) {
    const event = { id: 'asset-event-' + (state.revision + 1) + '-' + (state.assetEvents.length + 1), type, assetIds: assets.map(asset => asset.id),
      reason, before: C.copy(before), ...at(context), ...extra };
    state.assetEvents.push(event); assets.forEach(asset => { asset.lastRevision = state.revision + 1; });
    return event;
  }
  function assetState(state, p, context) {
    C.keys(p, ['assetIds', 'condition', 'reason']);
    const assets = C.ids(p.assetIds).map(id => C.find(state.assets, id, '물품')), condition = C.oneOf(p.condition, conditions), reason = C.string(p.reason, 300);
    for (const asset of assets) {
      if (asset.location.kind === 'vendor') C.fail('INVALID_INPUT', '매장·차량·고객이 보유 중인 물품만 상태를 바꿀 수 있습니다.');
      if (asset.condition === 'lost' && condition !== 'lost') C.fail('INVALID_INPUT', '분실품은 발견 확인으로 실물 위치를 먼저 기록해 주세요.');
      if (condition === 'ready' && asset.location.kind !== 'shop') C.fail('INVALID_INPUT', '매장에 있는 물품의 준비 완료를 확인해 주세요.');
    }
    const changed = assets.filter(asset => asset.condition !== condition);
    if (!changed.length) C.fail('NO_CHANGE', '이미 선택한 상태입니다.');
    const before = C.copy(changed);
    for (const asset of changed) {
      if (condition === 'lost') asset.loss = { previousCondition: asset.condition, lastKnownLocation: C.copy(asset.location), reason, ...at(context) };
      asset.condition = condition;
    }
    const event = assetEvent(state, 'condition', changed, context, reason, before, { condition });
    return { assetEventId: event.id, assetIds: changed.map(asset => asset.id), condition };
  }
  function found(state, p, context) {
    C.keys(p, ['assetId', 'condition', 'reason']); C.oneOf(p.condition, ['inspection']);
    const asset = C.find(state.assets, p.assetId, '물품'), reason = C.string(p.reason, 300);
    if (asset.condition !== 'lost') C.fail('NO_CHANGE', '분실로 기록한 물품만 발견 확인할 수 있습니다.');
    if (!['shop', 'customer', 'vehicle'].includes(asset.location.kind)) C.fail('INVALID_INPUT', '분실품의 마지막 보관 위치를 확인해 주세요.');
    if (asset.exchangeReservationId) C.fail('DEPENDENT_MOVEMENT', '교환 진행 물품은 연결된 교환 기록을 먼저 확인해 주세요.');
    const before = C.copy([asset]), from = C.copy(asset.location), to = { kind: 'shop', id: state.shopId };
    let movement;
    if (from.kind !== 'shop') {
      const result = I.move(state, { kind: from.kind === 'customer' ? 'directReturn' : 'receive', from, to, assetIds: [asset.id] }, context);
      movement = C.find(state.movements, result.movementId);
      movement.recovery = 'found'; movement.reason = reason;
    } else {
      movement = { id: 'movement-' + (state.revision + 1) + '-' + (state.movements.length + 1), kind: 'found', assetIds: [asset.id], reversedAssetIds: [], from, to,
        before: { assets: before, allocations: C.copy(state.allocations.filter(row => row.assetId === asset.id)) }, revision: state.revision + 1, recovery: 'found', reason, ...at(context) };
      state.movements.push(movement);
    }
    asset.location = to; asset.condition = 'inspection'; asset.loss = { ...asset.loss, foundAt: context.at, foundBy: context.actor.id, foundReason: reason };
    const event = assetEvent(state, 'found', [asset], context, reason, before, { movementId: movement.id });
    return { assetId: asset.id, assetEventId: event.id, movementId: movement.id, condition: 'inspection' };
  }
  function customer(state, p, context) {
    C.keys(p, ['orderId', 'name', 'phone', 'note']);
    if (!['name', 'phone', 'note'].some(key => Object.hasOwn(p, key))) C.fail('NO_CHANGE', '수정할 연락처나 메모를 입력해 주세요.');
    const order = C.find(state.orders || [], p.orderId, '통합접수');
    let profile = state.customerProfiles.find(row => row.orderIds.includes(order.id));
    const original = profile || { name: order.customer.name, phone: order.customer.phone, note: '' };
    const name = C.string(p.name === undefined ? original.name : p.name, 60), phone = C.string(p.phone === undefined ? original.phone : p.phone, 24, true);
    const contact = { name, phone: phone ? C.customer({ name, phone }).phone : '' }, note = p.note == null ? original.note : C.string(p.note, 500, true);
    if (!profile) {
      profile = { id: 'customer-profile-' + (state.revision + 1), orderIds: [order.id], ...contact, note, history: [], createdAt: context.at };
      state.customerProfiles.push(profile);
    }
    profile.history.push({ before: { name: original.name, phone: original.phone, note: original.note }, after: { ...contact, note }, ...at(context) });
    Object.assign(profile, contact, { note, updatedAt: context.at });
    return { profileId: profile.id, orderId: order.id };
  }
  function customerLink(state, p, context) {
    C.keys(p, ['profileId', 'orderIds']);
    const profile = C.find(state.customerProfiles, p.profileId, '고객 연락처'), ids = C.ids(p.orderIds);
    ids.forEach(id => {
      C.find(state.orders || [], id, '방문 접수');
      if (state.customerProfiles.some(row => row.id !== profile.id && row.orderIds.includes(id))) C.fail('ALREADY_EXISTS', '다른 고객 연락처에 연결된 방문입니다. 기존 연결을 확인해 주세요.');
    });
    const additions = ids.filter(id => !profile.orderIds.includes(id));
    if (!additions.length) C.fail('NO_CHANGE', '이미 연결된 방문입니다.');
    profile.orderIds.push(...additions); profile.history.push({ type: 'link', orderIds: additions, ...at(context) });
    return { profileId: profile.id, orderIds: additions };
  }
  function unique(values, key, label) {
    if (new Set(values.map(row => key ? row[key] : row)).size !== values.length) C.fail('INVALID_INPUT', label + ' 항목이 중복되었습니다.');
    return values;
  }
  function settings(state, p, context) {
    C.keys(p, ['patch']); C.keys(p.patch, Object.keys(defaults()));
    if (!Object.keys(p.patch).length) C.fail('NO_CHANGE', '변경할 설정을 입력해 주세요.');
    const next = normalize(state.settingVersions.at(-1)?.settings);
    for (const [key, value] of Object.entries(p.patch)) {
      if (key === 'rates') next.rates = unique(C.list(value, 500, true).map(row => { C.keys(row, ['sku', 'unitWon']); return { sku: C.find(state.catalog, row.sku, '품목').id, unitWon: C.integer(row.unitWon, 0, LIMIT) }; }), 'sku', '품목 요금');
      if (key === 'places') { next.places = unique(C.list(value, 100, true).map(row => C.string(row, 160)), null, '장소'); if (!('areas' in p.patch)) next.areas = groupPlaces(next.places, next.areas); }
      if (key === 'areas') {
        next.areas = unique(unique(C.list(value, 30, true).map(row => { C.keys(row, ['id', 'name', 'places']); return { id: C.id(row.id), name: C.string(row.name, 30), places: C.list(row.places, 100, true).map(place => C.string(place, 160)) }; }), 'id', '구역'), 'name', '구역');
        next.places = unique(next.areas.flatMap(area => area.places), null, '장소'); if (next.places.length > 100) C.fail('INVALID_INPUT', '수령 장소는 100곳까지 등록할 수 있습니다.');
      }
      if (key === 'discounts') {
        next.discounts = unique(C.list(value, 40, true).map(row => {
          C.keys(row, ['id', 'kind', 'sku', 'amountWon', 'percent']); const kind = C.oneOf(row.kind, ['perUnit', 'percent', 'amount', 'liftPercent']), id = C.id(row.id);
          if (kind === 'perUnit') { const product = C.find(state.catalog, row.sku, '품목'); if (product.kind === 'liftTicket') C.fail('INVALID_INPUT', '리프트권은 리프트권 할인(%)으로 설정해 주세요.'); return { id, kind, sku: product.id, amountWon: C.integer(row.amountWon, 1, LIMIT) }; }
          return kind === 'amount' ? { id, kind, amountWon: C.integer(row.amountWon, 1, LIMIT) } : { id, kind, percent: C.integer(row.percent, 1, 100) };
        }), 'id', '할인');
        unique(next.discounts.filter(row => row.kind === 'perUnit').map(row => row.sku), null, '장비당 할인 품목');
        for (const kind of ['percent', 'amount', 'liftPercent']) unique(next.discounts.filter(row => row.kind === kind).map(row => row.percent ?? row.amountWon), null, '할인 값');
      }
      if (key === 'vehicles') next.vehicles = unique(C.list(value, 100, true).map(row => { C.keys(row, ['id', 'name']); return { id: C.id(row.id), name: C.string(row.name, 60) }; }), 'id', '차량');
      if (key === 'returnTimes') next.returnTimes = unique(C.list(value, 100, true).map(row => { C.keys(row, ['id', 'label', 'time', 'dayOffset']); return { id: C.id(row.id), label: C.string(row.label, 60), time: C.time(row.time), dayOffset: C.integer(row.dayOffset ?? 0, 0, 1) }; }), 'id', '반납 타임');
      if (key === 'staff') next.staff = unique(C.list(value, 100, true).map(row => {
        C.keys(row, ['id', 'name', 'role', 'phone', 'vehicleId']); const name = C.string(row.name, 60), role = C.oneOf(row.role, ['manager', 'counter', 'driver']);
        return { id: C.id(row.id), name, role, phone: row.phone ? C.customer({ name, phone: row.phone }).phone : '', vehicleId: row.vehicleId == null ? null : C.id(row.vehicleId) };
      }), 'id', '직원');
      if (key === 'nightCutoff') next.nightCutoff = value == null ? null : C.time(value);
      if (key === 'store') { C.keys(value || {}, ['name', 'phone', 'address', 'link']); next.store = { name: C.string(value?.name ?? '', 60, true), phone: C.string(value?.phone ?? '', 24, true), address: C.string(value?.address ?? '', 160, true), link: C.string(value?.link ?? '', 200, true) }; }
    }
    if (next.staff.some(staff => staff.vehicleId && (staff.role !== 'driver' || !next.vehicles.some(vehicle => vehicle.id === staff.vehicleId)))) C.fail('INVALID_INPUT', '기사님의 담당 차량을 등록한 차량에서 선택해 주세요.');
    const version = state.settingVersions.length + 1;
    state.settingVersions.push({ version, settings: next, ...at(context) });
    return { version, settings: C.copy(next), authenticationChanged: false };
  }
  function partnerSave(state, p, context) {
    C.keys(p, ['id', 'name', 'phone']); const id = C.id(p.id), contact = C.customer({ name: p.name, phone: p.phone });
    let partner = state.partners.find(row => row.id === id);
    if (!partner) { partner = { id, history: [], createdAt: context.at }; state.partners.push(partner); }
    partner.history.push({ name: contact.name, phone: contact.phone, ...at(context) }); Object.assign(partner, contact);
    return { partnerId: id };
  }
  function borrow(state, p, context) {
    C.keys(p, ['id', 'partnerId', 'sku', 'quantity', 'size', 'dueDate']);
    const id = idFor(state, 'partnerLoans', p.id), partner = C.find(state.partners, p.partnerId, '거래처'), sku = C.find(state.catalog, p.sku, '품목');
    if (sku.kind === 'liftTicket') C.fail('INVALID_INPUT', '리프트권은 발권·매입 조건을 확인하는 업무에서 처리해 주세요.');
    const quantity = C.integer(p.quantity, 1, 500), dueDate = C.date(p.dueDate), size = C.string(p.size, 24, true);
    if (dueDate < C.day(context.at)) C.fail('INVALID_INPUT', '돌려줄 예정일은 오늘 이후로 입력해 주세요.');
    const result = I.handle(state, 'stock.receive', { sku: sku.id, quantity, size, sourceReference: 'partner-loan-' + (state.revision + 1) }, context);
    for (const assetId of result.assetIds) Object.assign(C.find(state.assets, assetId), { owner: { kind: 'partner', id: partner.id }, loanId: id });
    state.partnerLoans.push({ id, partnerId: partner.id, sku: sku.id, quantity, size, dueDate, assetIds: result.assetIds, movementId: result.movementId, ...at(context) });
    return { loanId: id, partnerId: partner.id, assetIds: result.assetIds, movementId: result.movementId };
  }
  function returnPartner(state, p, context) {
    C.keys(p, ['id', 'assetIds']); const id = idFor(state, 'partnerReturns', p.id), assets = C.ids(p.assetIds).map(id => C.find(state.assets, id, '물품'));
    const partnerIds = new Set(assets.map(asset => asset.owner?.kind === 'partner' ? asset.owner.id : null));
    if (partnerIds.size !== 1 || partnerIds.has(null)) C.fail('INVALID_INPUT', '같은 거래처에서 빌려온 물품만 선택해 주세요.');
    const partnerId = [...partnerIds][0]; C.find(state.partners, partnerId, '거래처');
    for (const asset of assets) {
      const loan = C.find(state.partnerLoans, asset.loanId, '차입 장비');
      if (loan.partnerId !== partnerId || !loan.assetIds.includes(asset.id) || asset.location.kind !== 'shop' || asset.condition === 'lost') C.fail('QUANTITY_EXCEEDED', '매장에 실제 돌아온 차입 장비만 거래처에 반환할 수 있습니다.');
      if (asset.exchangeReservationId || !I.allocationAvailable(state, asset)) C.fail('DEPENDENT_MOVEMENT', '교환·배달에 배정된 물품은 연결 업무를 먼저 해제해 주세요.');
    }
    const before = C.copy(assets), to = { kind: 'vendor', id: partnerId };
    assets.forEach(asset => { asset.location = C.copy(to); asset.lastRevision = state.revision + 1; asset.partnerReturnedAt = context.at; });
    const movement = { id: 'movement-' + (state.revision + 1) + '-' + (state.movements.length + 1), kind: 'partnerReturn', assetIds: assets.map(asset => asset.id), reversedAssetIds: [],
      from: { kind: 'shop', id: state.shopId }, to, before: { assets: before, allocations: [] }, revision: state.revision + 1, partnerId, ...at(context) };
    state.movements.push(movement); state.partnerReturns.push({ id, partnerId, assetIds: movement.assetIds, movementId: movement.id, ...at(context) });
    return { partnerReturnId: id, partnerId, assetIds: movement.assetIds, movementId: movement.id };
  }
  function moneyOpen(state, context) {
    if ((state.closings || []).some(row => row.date === C.day(context.at) && !row.reopenings.length)) C.fail('CLOSING_LOCKED', '오늘은 마감되었습니다. 관리자 재개 후 거래처 금전을 기록해 주세요.');
  }
  function partnerMovement(state, kind, assets, from, to, context, reason, extra) {
    const before = C.copy(assets);
    const movement = { id: 'movement-' + (state.revision + 1) + '-' + (state.movements.length + 1), kind, assetIds: assets.map(a => a.id), reversedAssetIds: [],
      from, to, before: { assets: before, allocations: [] }, revision: state.revision + 1, reason, ...extra, ...at(context) };
    state.movements.push(movement); assets.forEach(a => { a.location = C.copy(to); a.lastRevision = state.revision + 1; });
    return movement;
  }
  function lend(state, p, context) {
    C.keys(p, ['id', 'partnerId', 'assetIds', 'dueDate', 'reason']); const id = idFor(state, 'partnerLendings', p.id), partnerId = C.find(state.partners, p.partnerId, '거래처').id;
    const assets = C.ids(p.assetIds).map(id => C.find(state.assets, id, '물품')), dueDate = C.date(p.dueDate), reason = C.string(p.reason, 300);
    if (dueDate < C.day(context.at)) C.fail('INVALID_INPUT', '돌려받을 예정일은 오늘 이후로 선택해 주세요.');
    for (const asset of assets) {
      if (asset.ticket || asset.owner?.kind === 'partner' || asset.location.kind !== 'shop' || asset.activePartnerLendingId || !I.allocatable(state, asset)) C.fail('QUANTITY_EXCEEDED', '매장에 있는 준비 완료·미배정 자사 장비만 빌려줄 수 있습니다.');
    }
    const movement = partnerMovement(state, 'partnerLend', assets, { kind: 'shop', id: state.shopId }, { kind: 'vendor', id: partnerId }, context, reason, { partnerId, lendingId: id });
    assets.forEach(asset => { asset.activePartnerLendingId = id; });
    state.partnerLendings.push({ id, partnerId, assetIds: assets.map(a => a.id), dueDate, reason, movementId: movement.id, ...at(context) });
    return { lendingId: id, partnerId, assetIds: movement.assetIds, movementId: movement.id };
  }
  function receivePartner(state, p, context) {
    C.keys(p, ['id', 'assetIds', 'reason']); const id = idFor(state, 'partnerReceipts', p.id), assets = C.ids(p.assetIds).map(id => C.find(state.assets, id, '물품')), reason = C.string(p.reason, 300);
    const partnerIds = new Set(assets.map(a => a.activePartnerLendingId ? C.find(state.partnerLendings, a.activePartnerLendingId).partnerId : null));
    if (partnerIds.size !== 1 || partnerIds.has(null)) C.fail('INVALID_INPUT', '같은 거래처에 빌려준 실물만 선택해 주세요.');
    const partnerId = [...partnerIds][0];
    assets.forEach(a => { const lending = C.find(state.partnerLendings, a.activePartnerLendingId); if (!lending.assetIds.includes(a.id) || a.location.kind !== 'vendor' || a.location.id !== partnerId) C.fail('QUANTITY_EXCEEDED', '거래처가 보유한 해당 실물의 실제 회수를 확인해 주세요.'); });
    const lineItems = assets.map(a => ({ assetId: a.id, lendingId: a.activePartnerLendingId }));
    const movement = partnerMovement(state, 'partnerReceive', assets, { kind: 'vendor', id: partnerId }, { kind: 'shop', id: state.shopId }, context, reason, { partnerId, lineItems });
    assets.forEach(a => { delete a.activePartnerLendingId; if (a.condition === 'lost') a.loss = { ...a.loss, foundAt: context.at, foundBy: context.actor.id, foundReason: reason }; a.condition = 'inspection'; });
    state.partnerReceipts.push({ id, partnerId, lineItems, assetIds: movement.assetIds, movementId: movement.id, reason, ...at(context) });
    return { partnerReceiptId: id, partnerId, assetIds: movement.assetIds, movementId: movement.id, condition: 'inspection' };
  }
  function agreementSummary(state, agreement) {
    const payments = (state.partnerMoney || []).filter(row => row.agreementId === agreement.id), offsets = (state.partnerOffsets || []).filter(row => row.receivableId === agreement.id || row.payableId === agreement.id);
    const paidWon = sum(payments.map(row => row.amountWon)), offsetWon = sum(offsets.map(row => row.amountWon));
    return { ...C.copy(agreement), paidWon, offsetWon, outstandingWon: C.integer(agreement.amountWon - paidWon - offsetWon, 0, LIMIT) };
  }
  function agreement(state, p, context) {
    C.keys(p, ['id', 'partnerId', 'kind', 'amountWon', 'reason']); moneyOpen(state, context);
    const id = idFor(state, 'partnerAgreements', p.id), partnerId = C.find(state.partners, p.partnerId, '거래처').id, kind = C.oneOf(p.kind, ['receivable', 'payable']), amountWon = C.integer(p.amountWon, 1, LIMIT), reason = C.string(p.reason, 300);
    sum([...state.partnerAgreements.filter(row => row.partnerId === partnerId && row.kind === kind).map(row => row.amountWon), amountWon]);
    state.partnerAgreements.push({ id, partnerId, kind, amountWon, reason, ...at(context) });
    return { agreementId: id, partnerId, kind, amountWon };
  }
  function offset(state, p, context) {
    C.keys(p, ['id', 'partnerId', 'receivableId', 'payableId', 'amountWon', 'reason']); moneyOpen(state, context);
    const id = idFor(state, 'partnerOffsets', p.id), partnerId = C.find(state.partners, p.partnerId, '거래처').id, receivable = C.find(state.partnerAgreements, p.receivableId, '받을 약정'), payable = C.find(state.partnerAgreements, p.payableId, '줄 약정');
    const amountWon = C.integer(p.amountWon, 1, LIMIT), reason = C.string(p.reason, 300);
    if (receivable.partnerId !== partnerId || payable.partnerId !== partnerId || receivable.kind !== 'receivable' || payable.kind !== 'payable') C.fail('INVALID_INPUT', '같은 거래처의 받을 약정과 줄 약정을 각각 선택해 주세요.');
    if (amountWon > agreementSummary(state, receivable).outstandingWon || amountWon > agreementSummary(state, payable).outstandingWon) C.fail('QUANTITY_EXCEEDED', '양쪽 약정에 남아 있는 금액까지만 상계할 수 있습니다.');
    state.partnerOffsets.push({ id, partnerId, receivableId: receivable.id, payableId: payable.id, amountWon, reason, ...at(context) });
    return { offsetId: id, partnerId, amountWon, cashMovementWon: 0 };
  }
  function partnerMoney(state, p, context) {
    C.keys(p, ['id', 'partnerId', 'kind', 'amountWon', 'reason', 'method', 'agreementId']);
    const id = idFor(state, 'partnerMoney', p.id), partnerId = C.find(state.partners, p.partnerId, '거래처').id;
    const kind = C.oneOf(p.kind, ['payment', 'receipt']), amountWon = C.integer(p.amountWon, 1, LIMIT), method = p.method == null ? null : C.oneOf(p.method, ['cash', 'card', 'transfer']), reason = C.string(p.reason, 300);
    sum([...state.partnerMoney.filter(row => row.partnerId === partnerId && row.kind === kind).map(row => row.amountWon), amountWon]);
    if ((state.closings || []).some(row => row.date === C.day(context.at) && !row.reopenings.length)) C.fail('CLOSING_LOCKED', '오늘은 마감되었습니다. 관리자 재개 후 거래처 금전을 기록해 주세요.');
    const agreementId = p.agreementId == null ? null : C.id(p.agreementId);
    if (agreementId) { const agreed = C.find(state.partnerAgreements, agreementId, '금액 약정'); if (agreed.partnerId !== partnerId || agreed.kind !== (kind === 'payment' ? 'payable' : 'receivable')) C.fail('INVALID_INPUT', '거래처와 지급·수납 방향이 같은 약정을 선택해 주세요.'); if (amountWon > agreementSummary(state, agreed).outstandingWon) C.fail('QUANTITY_EXCEEDED', '선택한 약정에 남은 금액을 초과합니다. 미배분 실제 금액으로 별도 기록해 주세요.'); }
    let cashEntryId = null;
    if (method === 'cash') {
      const result = G.handle(state, 'finance.cash', { id: 'partner-money-' + (state.revision + 1), kind: kind === 'receipt' ? 'in' : 'out', amountWon, reason }, context);
      cashEntryId = result.cashEntryId; const cashEntry = C.find(state.cashEntries, cashEntryId); cashEntry.partnerId = partnerId; cashEntry.partnerMoneyId = id;
    }
    state.partnerMoney.push({ id, partnerId, kind, amountWon, method, reason, agreementId, cashEntryId, status: method ? 'recorded' : 'method_unconfirmed', ...at(context) });
    return { partnerMoneyId: id, partnerId, kind, amountWon, cashEntryId };
  }
  function handle(state, type, p, context) {
    C.context(context); C.store(context); initialize(state);
    if (type === 'management.asset') return assetState(state, p, context);
    if (type === 'management.found') return found(state, p, context);
    if (type === 'management.customer') return customer(state, p, context);
    if (type === 'management.customer.link') return customerLink(state, p, context);
    if (type === 'management.settings') return settings(state, p, context);
    if (type === 'partner.save') return partnerSave(state, p, context);
    if (type === 'partner.borrow') return borrow(state, p, context);
    if (type === 'partner.return') return returnPartner(state, p, context);
    if (type === 'partner.lend') return lend(state, p, context);
    if (type === 'partner.receive') return receivePartner(state, p, context);
    if (type === 'partner.agreement') return agreement(state, p, context);
    if (type === 'partner.offset') return offset(state, p, context);
    if (type === 'partner.money') return partnerMoney(state, p, context);
    C.fail('INVALID_INPUT', '지원하지 않는 매장 관리 작업입니다.');
  }
  function summary(state) {
    const stored = key => state[key] || [], orders = state.orders || [], normalizePhone = value => String(value || '').replace(/\D/g, '');
    const settingsVersion = stored('settingVersions').at(-1);
    return { settings: normalize(settingsVersion?.settings), settingsVersion: settingsVersion?.version || 0, settingVersions: C.copy(stored('settingVersions')),
      inventory: state.catalog.map(sku => { const assets = state.assets.filter(asset => asset.sku === sku.id && (asset.location.kind !== 'vendor' || asset.activePartnerLendingId));
        return { sku: sku.id, label: sku.label, unit: sku.unit, total: assets.length, available: assets.filter(asset => asset.location.kind === 'shop' && I.allocatable(state, asset)).length,
          partnerOut: assets.filter(asset => asset.activePartnerLendingId).length, customer: assets.filter(asset => asset.location.kind === 'customer').length, vehicle: assets.filter(asset => asset.location.kind === 'vehicle').length,
          conditions: Object.fromEntries([...conditions, 'damaged'].map(condition => [condition, assets.filter(asset => asset.condition === condition).length])) };
      }), assets: C.copy(state.assets), assetEvents: C.copy(stored('assetEvents')),
      customerProfiles: stored('customerProfiles').map(profile => {
        const knownPhones = new Set([profile.phone, ...orders.filter(order => profile.orderIds.includes(order.id)).map(order => order.customer.phone)].map(normalizePhone).filter(Boolean));
        return { ...C.copy(profile), visits: profile.orderIds.map(id => O.view(state, id)),
          matchingCandidates: orders.filter(order => !stored('customerProfiles').some(row => row.orderIds.includes(order.id)) && knownPhones.has(normalizePhone(order.customer.phone))).map(order => ({ orderId: order.id, customer: C.copy(order.customer) })) };
      }),
      unlinkedVisits: orders.filter(order => !stored('customerProfiles').some(row => row.orderIds.includes(order.id))).map(order => ({ orderId: order.id, customer: C.copy(order.customer) })),
      partners: stored('partners').map(partner => { const loans = stored('partnerLoans').filter(loan => loan.partnerId === partner.id), payments = stored('partnerMoney').filter(row => row.partnerId === partner.id), agreements = stored('partnerAgreements').filter(row => row.partnerId === partner.id).map(row => agreementSummary(state, row)), offsets = stored('partnerOffsets').filter(row => row.partnerId === partner.id);
        const lendings = stored('partnerLendings').filter(row => row.partnerId === partner.id).map(row => { const receivedAssetIds = stored('partnerReceipts').flatMap(receipt => receipt.lineItems.filter(item => item.lendingId === row.id).map(item => item.assetId)); return { ...C.copy(row), receivedQuantity: receivedAssetIds.length, outstandingQuantity: row.assetIds.length - receivedAssetIds.length, outstandingAssetIds: row.assetIds.filter(id => !receivedAssetIds.includes(id)) }; });
        return { ...C.copy(partner), loans: loans.map(loan => ({ ...C.copy(loan), returnedQuantity: loan.assetIds.filter(id => { const asset = C.find(state.assets, id); return asset.location.kind === 'vendor' && asset.location.id === partner.id; }).length,
          outstandingQuantity: loan.assetIds.filter(id => C.find(state.assets, id).location.kind !== 'vendor').length })),
          money: C.copy(payments), paidWon: sum(payments.filter(row => row.kind === 'payment').map(row => row.amountWon)), receivedWon: sum(payments.filter(row => row.kind === 'receipt').map(row => row.amountWon)),
          lendings, agreements, offsets: C.copy(offsets), receivableWon: sum(agreements.filter(row => row.kind === 'receivable').map(row => row.outstandingWon)), payableWon: sum(agreements.filter(row => row.kind === 'payable').map(row => row.outstandingWon)), offsetWon: sum(offsets.map(row => row.amountWon)),
          unallocatedPaymentWon: sum(payments.filter(row => !row.agreementId && row.kind === 'payment').map(row => row.amountWon)), unallocatedReceiptWon: sum(payments.filter(row => !row.agreementId && row.kind === 'receipt').map(row => row.amountWon)), agreedChargeWon: agreements.some(row => row.kind === 'payable') ? sum(agreements.filter(row => row.kind === 'payable').map(row => row.amountWon)) : null };
      }), partnerReturns: C.copy(stored('partnerReturns')) };
  }
  return { initialize, handle, summary, applyDiscounts };
});

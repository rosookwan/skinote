(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'), require('./inventory.js'));
  else root.SkiWorkflowOrders = factory(root.SkiWorkflowCommon, root.SkiWorkflowInventory);
})(globalThis, function (C, I) {
  'use strict';
  const MAX_MONEY = Number.MAX_SAFE_INTEGER;
  const activeTask = task => ['waiting', 'in_progress'].includes(task.status);

  // Extend schemaVersion 1 snapshots without changing existing workflow records.
  function initialize(state) {
    if (state.orders == null) state.orders = [];
    if (!Array.isArray(state.orders)) C.fail('INVALID_INPUT', '통합접수 기록을 확인해 주세요.');
    return state;
  }
  function money(value) { return C.integer(value, 0, MAX_MONEY); }
  function sum(values) {
    return values.reduce((total, value) => money(total + money(value)), 0);
  }
  function newPeople(values, existing) {
    const ids = new Set(existing.map(person => person.id));
    return C.list(values == null ? [] : values, 500, true).map((value, index) => {
      C.keys(value, ['id', 'name']);
      const id = C.id(value.id);
      if (ids.has(id)) C.fail('ALREADY_EXISTS', '이미 등록한 일행입니다. 기존 일행을 선택해 주세요.');
      ids.add(id);
      return { id, name: C.string(value.name, 60, true) || '일행 ' + (existing.length + index + 1) };
    });
  }
  function plan(value, kind, start, end) {
    const pickup = kind === 'pickup', fallback = pickup ? 'shop' : 'direct';
    const raw = value == null ? { method: fallback } : value;
    C.keys(raw, ['method', 'date', 'time', 'place', 'vehicleId']);
    const method = C.oneOf(raw.method, pickup ? ['shop', 'delivery'] : ['direct', 'vehicle']);
    const date = C.date(raw.date == null ? pickup ? start : end : raw.date);
    if (pickup && date > start) C.fail('INVALID_INPUT', '수령 예정일은 이용 시작일보다 늦을 수 없습니다.');
    if (!pickup && date < end) C.fail('INVALID_INPUT', '반납 예정일은 이용 종료일보다 빠를 수 없습니다.');
    const vehicle = method === 'delivery' || method === 'vehicle';
    if (!vehicle && raw.vehicleId != null) C.fail('INVALID_INPUT', '매장 수령·직접반납에는 차량을 지정하지 않습니다.');
    return { method, date, time: raw.time == null && !vehicle ? null : C.time(raw.time),
      place: C.string(raw.place == null && !vehicle ? '매장' : raw.place), vehicleId: vehicle ? C.id(raw.vehicleId) : null };
  }
  function price(value, quantity, start, end, sku) {
    C.keys(value, ['basis', 'unitWon', 'discountWon', 'amountWon']);
    C.oneOf(sku.kind, ['equipment', 'clothing', 'helmet', 'liftTicket']);
    const ticket = sku.kind === 'liftTicket';
    const basis = C.oneOf(value.basis ?? (ticket ? 'per_unit' : 'per_day'), ['per_unit', 'per_day']);
    if (ticket && (start !== end || basis !== 'per_unit')) C.fail('INVALID_INPUT', '리프트권은 이용일별로 나누고 1매 기준 요금으로 접수해 주세요.');
    const days = C.integer((Date.parse(end) - Date.parse(start)) / 86400000 + 1, 1, 366);
    const unitWon = money(value.unitWon), discountWon = money(value.discountWon ?? 0);
    const grossWon = money(unitWon * quantity * (basis === 'per_day' ? days : 1));
    if (discountWon > grossWon) C.fail('INVALID_INPUT', '할인 금액이 이번 품목의 대여금액보다 큽니다.');
    const amountWon = grossWon - discountWon;
    if (value.amountWon != null && money(value.amountWon) !== amountWon) C.fail('INVALID_INPUT', '기간·수량·단가로 계산한 금액과 다릅니다.');
    return { basis, days, unitWon, discountWon, amountWon };
  }
  function newBatch(state, order, raw, people, context) {
    C.keys(raw, ['id', 'label', 'lines']);
    const id = C.id(raw.id);
    if (order.batches.some(batch => batch.id === id)) C.fail('ALREADY_EXISTS', '이미 등록한 추가 접수입니다.');
    const ids = new Set(order.lines.map(line => line.id));
    const lines = C.list(raw.lines, 500).map(value => {
      C.keys(value, ['id', 'sku', 'quantity', 'start', 'end', 'pickupPlan', 'returnPlan', 'price', 'personId']);
      const lineId = C.id(value.id), sku = C.find(state.catalog, value.sku, '품목');
      if (ids.has(lineId)) C.fail('ALREADY_EXISTS', '이미 사용한 품목 행 관리번호입니다. 새 행으로 추가해 주세요.');
      ids.add(lineId);
      const quantity = C.integer(value.quantity, 1, 500), start = C.date(value.start), end = C.date(value.end);
      if (end < start) C.fail('INVALID_INPUT', '이용 종료일은 시작일보다 빠를 수 없습니다.');
      const personId = value.personId == null ? null : C.find(people, value.personId, '일행').id;
      return { id: lineId, batchId: id, sku: sku.id, label: sku.label, category: sku.kind, unit: sku.unit,
        quantity, start, end, personId, pickupPlan: plan(value.pickupPlan, 'pickup', start, end),
        returnPlan: plan(value.returnPlan, 'return', start, end), price: price(value.price, quantity, start, end, sku), cancelledQuantity: 0 };
    });
    // Fail before appending a batch if the complete receipt cannot be summed
    // exactly. Existing accepted prices and their original totals are retained.
    sum([order.legacyChargeWon || 0, ...order.lines.map(line => line.price.amountWon), ...lines.map(line => line.price.amountWon)]);
    return { batch: { id, label: C.string(raw.label, 80, true) || (order.batches.length ? '추가 접수 ' + order.batches.length : '첫 접수'),
      lineIds: lines.map(line => line.id), createdAt: C.instant(context.at), actor: C.copy(context.actor) }, lines };
  }
  function movementLines(movement) {
    return Array.isArray(movement.lineItems) ? movement.lineItems : [];
  }
  function linkedAssets(movement, lineId) {
    const reversed = movement.reversedAssetIds || [];
    return movementLines(movement).filter(row => row.lineId === lineId).flatMap(row => row.assetIds || [])
      .filter(id => movement.assetIds.includes(id) && !reversed.includes(id));
  }
  function issued(state, orderId, lineId) {
    return (state.movements || []).filter(movement => movement.orderId === orderId && movement.kind === 'deliver')
      .flatMap(movement => linkedAssets(movement, lineId));
  }
  function initialIds(line) { return [...new Set([...(line.initialAssetIds || []), ...(line.initialReturnedAssetIds || [])])]; }
  function nonReturnQuantity(line) { return C.integer(line.initialNonReturnQuantity || 0, 0, Number.MAX_SAFE_INTEGER); }
  function taskTouches(task, orderId, lineId) {
    return task.orderId === orderId && ((task.lineItems || []).some(row => row.lineId === lineId) ||
      (task.plannedItems || []).some(row => row.itemId === lineId) || task.lineId === lineId);
  }
  function cancellationBlocked(state, order, line) {
    if (state.assets.some(a => a.orderPreparation?.orderId === order.id && a.orderPreparation.lineId === line.id)) return '준비한 물품의 배정을 먼저 해제해 주세요.';
    if ((line.reservationBindings || []).some(b => state.allocations.some(a => a.reservationId === b.reservationId && a.lineId === b.lineId && a.status === 'active'))) return '발권·배정한 리프트권을 먼저 해제하거나 반환해 주세요.';
    if (initialIds(line).length || nonReturnQuantity(line) || issued(state, order.id, line.id).length) return '이미 지급한 품목입니다. 반납·정정에서 처리해 주세요.';
    if ((state.tasks || []).some(task => activeTask(task) && taskTouches(task, order.id, line.id))) return '연결된 차량 업무를 먼저 해제하거나 변경해 주세요.';
    if ((state.movements || []).some(movement => movement.orderId === order.id && movement.kind === 'load' && linkedAssets(movement, line.id).some(id => {
      const asset = (state.assets || []).find(row => row.id === id);
      return asset && !I.same(asset.location, { kind: 'shop', id: state.shopId });
    }))) return '차량에 적재한 물품은 매장에 내린 뒤 접수를 취소해 주세요.';
    return null;
  }
  function cancel(state, p, context) {
    C.keys(p, ['orderId', 'batchId', 'lineIds', 'reason']);
    const order = C.find(state.orders, p.orderId, '통합접수'), reason = C.string(p.reason, 300);
    const batch = p.batchId == null ? null : C.find(order.batches, p.batchId, '추가 접수');
    const selected = p.lineIds == null ? order.lines.filter(line => (!batch || line.batchId === batch.id) && !line.cancelledQuantity) : C.ids(p.lineIds).map(id => {
      const line = C.find(order.lines, id, '품목 행');
      if (batch && line.batchId !== batch.id) C.fail('INVALID_INPUT', '선택한 추가 접수에 속한 품목만 취소할 수 있습니다.');
      return line;
    });
    if (!selected.length || selected.some(line => line.cancelledQuantity)) C.fail('NO_CHANGE', '취소할 미지급 품목이 없습니다.');
    for (const line of selected) {
      const blocked = cancellationBlocked(state, order, line);
      if (blocked) C.fail('DEPENDENT_MOVEMENT', blocked);
    }
    const record = { lineIds: selected.map(line => line.id), reason, at: C.instant(context.at), actor: C.copy(context.actor),
      amountWon: sum(selected.map(line => line.price.amountWon)) };
    for (const line of selected) line.cancelledQuantity = line.quantity;
    (order.cancellations ||= []).push(record);
    return { orderId: order.id, lineIds: record.lineIds.slice(), cancelledAmountWon: record.amountWon };
  }
  function issue(state, p, context) {
    C.keys(p, ['orderId', 'lineItems', 'vehicleId', 'taskId']);
    const order = C.find(state.orders, p.orderId, '통합접수');
    const from = p.vehicleId == null ? { kind: 'shop', id: state.shopId } : { kind: 'vehicle', id: C.id(p.vehicleId) };
    const task = p.taskId == null ? null : C.find(state.tasks, p.taskId, '배달 업무');
    if (task && (task.orderId !== order.id || task.customerId !== order.id)) C.fail('INVALID_INPUT', '이 통합접수에 연결된 배달 업무를 선택해 주세요.');
    const lineIds = new Set(), assetIds = new Set();
    const lineItems = C.list(p.lineItems, 500).map(row => {
      C.keys(row, ['lineId', 'assetIds']);
      const line = C.find(order.lines, row.lineId, '품목 행');
      if (lineIds.has(line.id)) C.fail('INVALID_INPUT', '같은 품목 행을 두 번 선택했습니다.');
      lineIds.add(line.id);
      if (line.category === 'liftTicket' || C.find(state.catalog, line.sku).kind === 'liftTicket') C.fail('TICKET_UNAVAILABLE', '리프트권은 실제 발권·권 배정 후 전달에서 처리해 주세요.');
      const ids = C.ids(row.assetIds);
      const left = line.quantity - (line.cancelledQuantity || 0) - initialIds(line).length - nonReturnQuantity(line) - issued(state, order.id, line.id).length;
      if (ids.length > left) C.fail('QUANTITY_EXCEEDED', '이번 품목의 남은 지급 예정 수량을 초과했습니다.');
      for (const id of ids) {
        if (assetIds.has(id)) C.fail('INVALID_INPUT', '같은 물품을 여러 품목 행에 지급할 수 없습니다.');
        assetIds.add(id);
        const asset = C.find(state.assets, id, '물품');
        if (asset.orderPreparation && (asset.orderPreparation.orderId !== order.id || asset.orderPreparation.lineId !== line.id)) C.fail('INVALID_INPUT', '다른 일행·품목 행에 준비한 장비입니다. 준비 배정을 확인해 주세요.');
        if (asset.sku !== line.sku || asset.ticket || asset.componentBaseId) C.fail('INVALID_INPUT', '접수한 품목에 맞는 대여 장비를 선택해 주세요.');
        if (!I.same(asset.location, from)) C.fail('QUANTITY_EXCEEDED', '선택한 매장·차량에 해당 물품이 없습니다.');
        if (task?.lineItems?.length && !task.lineItems.some(item => item.lineId === line.id && item.assetIds.includes(id))) C.fail('INVALID_INPUT', '배달 업무에 배정한 품목 행과 물품을 확인해 주세요.');
        if (task?.plannedItems?.length && !task.plannedItems.some(item => item.itemId === line.id && item.assetIds.includes(id))) C.fail('INVALID_INPUT', '배달 예정 품목의 물품 배정을 확인해 주세요.');
      }
      return { lineId: line.id, assetIds: ids };
    });
    // I.move owns physical stock, permissions, other-task reservations and
    // movement history. The outer workflow transaction commits both records.
    const result = I.move(state, { kind: 'deliver', from, to: { kind: 'customer', id: order.id }, assetIds: [...assetIds], ...(task ? { taskId: task.id } : {}) }, context);
    const movement = C.find(state.movements, result.movementId);
    movement.orderId = order.id; movement.lineItems = C.copy(lineItems);
    return { ...result, orderId: order.id, lineItems: C.copy(lineItems) };
  }
  function handle(state, type, p, context) {
    C.context(context); initialize(state);
    if (type === 'order.issue') return issue(state, p, context);
    C.store(context);
    if (type === 'order.cancel') return cancel(state, p, context);
    if (!['order.create', 'order.add'].includes(type)) C.fail('INVALID_INPUT', '지원하지 않는 통합접수 작업입니다.');
    C.keys(p, type === 'order.create' ? ['id', 'customer', 'people', 'batch'] : ['orderId', 'people', 'batch']);
    let order;
    if (type === 'order.create') {
      const id = C.id(p.id);
      if (state.orders.some(row => row.id === id)) C.fail('ALREADY_EXISTS', '이미 등록한 통합접수입니다.');
      const dayPrefix = C.day(context.at).replaceAll('-', '').slice(2);
      let receiptSequence = 1; while (state.orders.some(row => row.receiptNo === dayPrefix + '-' + String(receiptSequence).padStart(3, '0'))) receiptSequence++;
      order = { id, receiptNo: dayPrefix + '-' + String(receiptSequence).padStart(3, '0'), customer: C.customer(p.customer), people: [], batches: [], lines: [], createdAt: C.instant(context.at) };
    } else order = C.find(state.orders, p.orderId, '통합접수');
    const people = newPeople(p.people, order.people);
    const addition = newBatch(state, order, p.batch, [...order.people, ...people], context);
    order.people.push(...people); order.batches.push(addition.batch); order.lines.push(...addition.lines);
    if (type === 'order.create') state.orders.push(order);
    return { orderId: order.id, batchId: addition.batch.id, lineIds: addition.lines.map(line => line.id),
      addedAmountWon: sum(addition.lines.map(line => line.price.amountWon)) };
  }
  function custody(state, orderId, line) {
    const movements = state.movements || [];
    const occurrences = initialIds(line).map(id => ({ id, index: -1, returned: (line.initialReturnedAssetIds || []).includes(id) }));
    movements.forEach((movement, index) => {
      if (movement.orderId === orderId && movement.kind === 'deliver') for (const id of linkedAssets(movement, line.id)) occurrences.push({ id, index, returned: false });
    });
    const track = occurrence => {
      const result = kind => ({ assetId: occurrence.id, kind });
      if (occurrence.returned) return result('shop');
      let location = occurrence.index < 0 ? null : { kind: 'customer', id: orderId };
      if (!location) {
        const opening = movements.find(movement => movement.kind === 'stock.opening' && movement.assetIds.includes(occurrence.id));
        location = opening?.to || (state.assets || []).find(asset => asset.id === occurrence.id)?.location;
        if (location?.kind === 'shop') return result('shop');
      }
      if (!location) return result('unknown');
      for (let index = occurrence.index + 1; index < movements.length; index++) {
        const movement = movements[index];
        if (!movement.assetIds.includes(occurrence.id) || (movement.reversedAssetIds || []).includes(occurrence.id) || movement.kind === 'stock.opening') continue;
        if (['directReturn', 'collect'].includes(movement.kind) && location.kind === 'customer' && location.id === orderId && I.same(movement.from, location)) location = movement.to;
        else if (movement.kind === 'receive' && location.kind === 'vehicle' && I.same(movement.from, location)) location = movement.to;
        // A later reissue must not make a completed earlier rental look held
        // again. A transfer without its final handoff remains unresolved.
        else if (movement.kind === 'deliver') return result('unknown');
        if (location.kind === 'shop') return result('shop');
      }
      return result(location.kind === 'customer' && location.id === orderId ? 'customer' : location.kind === 'vehicle' ? 'vehicle' : 'unknown');
    };
    return occurrences.map(track);
  }
  function view(state, orderOrId) {
    const order = typeof orderOrId === 'string' ? C.find(state.orders || [], orderOrId, '통합접수') : orderOrId;
    if (!order) C.fail('NOT_FOUND', '통합접수를 찾을 수 없습니다.');
    const exchanges = (state.exchanges || []).filter(x => x.orderId === order.id && x.status !== 'cancelled');
    const belongs = (line, x, oldId) => {
      const creation = x.createdRevision || (state.events || []).find(event => event.type === 'exchange.request' && event.payload.id === x.id)?.version || Number.MAX_SAFE_INTEGER;
      const ownIssue = (state.movements || []).find(m => m.orderId === order.id && m.kind === 'deliver' && linkedAssets(m, line.id).includes(oldId));
      return !ownIssue || ownIssue.revision <= creation;
    };
    const lineage = line => {
      const known = new Set([...initialIds(line), ...issued(state, order.id, line.id)]);
      for (const x of exchanges) for (const u of x.units) if (known.has(u.oldAssetId) && u.newAssetId && belongs(line, x, u.oldAssetId)) known.add(u.newAssetId);
      return known;
    };
    const sourceLines = order.lines.slice();
    for (const x of exchanges.filter(x => !['ski', 'board'].includes(x.kind))) for (const [index, u] of x.units.entries()) {
      if (sourceLines.some(l => lineage(l).has(u.oldAssetId))) continue;
      const base = sourceLines.find(l => lineage(l).has(u.baseAssetId));
      if (!base) continue;
      const product = C.find(state.catalog, x.sku);
      sourceLines.push({ ...C.copy(base), id: 'component-' + x.id + '-' + index, sku: x.sku, label: product.label + ' (교환 구성품)', category: 'equipment', component: true, unit: product.unit, quantity: 1,
        price: { unitWon: 0, discountWon: 0, amountWon: 0, basis: 'per_unit', days: 1 }, initialAssetIds: [u.oldAssetId], initialReturnedAssetIds: [], initialNonReturnQuantity: 0, returnPlan: C.copy(u.returnPlan), cancelledQuantity: 0 });
    }
    const lines = sourceLines.map(line => {
      const cancelledQuantity = line.cancelledQuantity || 0;
      let locations = custody(state, order.id, line);
      const nonReturn = nonReturnQuantity(line), issuedQuantity = locations.length + nonReturn;
      for (const x of exchanges) for (const u of x.units) {
        const old = locations.find(l => l.assetId === u.oldAssetId);
        if (!old || !belongs(line, x, u.oldAssetId) || !u.deliveredAt || !u.newAssetId) continue;
        const delivery = (state.movements || []).find(m => m.kind === 'deliver' && m.assetIds.includes(u.newAssetId) && !m.reversedAssetIds.includes(u.newAssetId));
        if (!delivery) continue;
        const fake = { ...line, id: '__exchange_projection__', initialAssetIds: [], initialReturnedAssetIds: [] };
        const projected = custody({ ...state, movements: [...state.movements.slice(0, state.movements.indexOf(delivery)), { ...delivery, orderId: order.id, lineItems: [{ lineId: fake.id, assetIds: [u.newAssetId] }] }, ...state.movements.slice(state.movements.indexOf(delivery) + 1)] }, order.id, fake);
        locations = locations.filter(l => l !== old || l.kind !== 'shop');
        if (old.kind !== 'shop') old.exchangeOld = true;
        locations.push(...projected);
      }
      const assetIds = kind => locations.filter(location => location.kind === kind).map(location => location.assetId);
      const customerTerms = assetIds('customer').map(id => (line.assetTerms || []).find(term => term.assetId === id) || { assetId: id, end: line.end, returnPlan: line.returnPlan });
      const currentEnd = [...customerTerms.map(term => term.end), ...(line.quantity - cancelledQuantity - issuedQuantity > 0 ? [line.end] : [])].sort().at(-1) || line.end;
      const currentReturnDate = customerTerms.map(term => term.returnPlan.date).sort()[0] || line.returnPlan.date;
      return { ...C.copy(line), currentEnd, currentReturnDate, customerTerms: C.copy(customerTerms), cancelledQuantity, activeQuantity: line.quantity - cancelledQuantity, issuedQuantity,
        unissuedQuantity: Math.max(0, line.quantity - cancelledQuantity - issuedQuantity), activeAmountWon: cancelledQuantity ? 0 : line.price.amountWon,
        customerQuantity: assetIds('customer').length, vehicleQuantity: assetIds('vehicle').length,
        shopQuantity: assetIds('shop').length, unknownQuantity: assetIds('unknown').length, nonReturnQuantity: nonReturn,
        preparedAssetIds: (state.assets || []).filter(a => a.orderPreparation?.orderId === order.id && a.orderPreparation.lineId === line.id).map(a => a.id), exchangeOutstandingQuantity: locations.filter(l => l.exchangeOld && l.kind !== 'shop').length,
        customerAssetIds: assetIds('customer'), vehicleAssetIds: assetIds('vehicle'), shopAssetIds: assetIds('shop'), unknownAssetIds: assetIds('unknown') };
    });
    const totals = { quantity: sum(lines.map(line => line.quantity)), cancelledQuantity: sum(lines.map(line => line.cancelledQuantity)),
      activeQuantity: sum(lines.map(line => line.activeQuantity)), issuedQuantity: sum(lines.map(line => line.issuedQuantity)),
      unissuedQuantity: sum(lines.map(line => line.unissuedQuantity)), originalAmountWon: sum([order.legacyChargeWon || 0, ...lines.map(line => line.price.amountWon)]),
      cancelledAmountWon: sum(lines.filter(line => line.cancelledQuantity).map(line => line.price.amountWon)), amountWon: sum([order.legacyChargeWon || 0, ...lines.map(line => line.activeAmountWon)]),
      customerQuantity: sum(lines.map(line => line.customerQuantity)), vehicleQuantity: sum(lines.map(line => line.vehicleQuantity)),
      shopQuantity: sum(lines.map(line => line.shopQuantity)), unknownQuantity: sum(lines.map(line => line.unknownQuantity)), nonReturnQuantity: sum(lines.map(line => line.nonReturnQuantity)) };
    const batches = order.batches.map(batch => ({ ...C.copy(batch), amountWon: sum(lines.filter(line => line.batchId === batch.id).map(line => line.activeAmountWon)),
      status: lines.filter(line => line.batchId === batch.id).every(line => line.cancelledQuantity) ? 'cancelled' : 'active' }));
    const activeLines = lines.filter(line => line.activeQuantity);
    const exchangeOpenQuantity = exchanges.filter(x => x.status !== 'completed').reduce((n, x) => n + x.units.filter(u => !u.deliveredAt || !u.receivedAt).length, 0);
    const status = !activeLines.length ? 'cancelled' : exchangeOpenQuantity ? 'awaiting_exchange' : totals.unknownQuantity ? 'needs_review' : totals.customerQuantity ? totals.shopQuantity || totals.vehicleQuantity ? 'partial_return' : 'in_use' : totals.vehicleQuantity ? 'awaiting_shop' : totals.unissuedQuantity ? 'awaiting_issue' : 'returned';
    return { ...C.copy(order), lines, batches, totals, exchangeOpenQuantity, amountWon: totals.amountWon, status,
      issueStatus: totals.unissuedQuantity ? totals.issuedQuantity ? 'partially_issued' : 'awaiting_issue' : 'issued', complete: status === 'returned' || status === 'cancelled' };
  }
  function list(state, options = {}) {
    C.keys(options, ['query', 'date', 'status']);
    const query = C.string(typeof options.query === 'string' ? options.query.trim() : options.query, 160, true).replace(/[\s-]/g, '').toLocaleLowerCase();
    const date = options.date == null ? null : C.date(options.date);
    const status = options.status == null ? null : C.oneOf(options.status, ['awaiting_issue', 'in_use', 'partial_return', 'awaiting_shop', 'returned', 'cancelled', 'needs_review', 'awaiting_exchange']);
    return (state.orders || []).map(order => view(state, order)).filter(order => {
      const searchable = [order.id, order.customer.name, order.customer.phone, ...order.people.map(person => person.name)].join(' ').replace(/[\s-]/g, '').toLocaleLowerCase();
      return (!query || searchable.includes(query)) && (!date || order.lines.some(line => line.activeQuantity && line.start <= date && date <= line.end)) && (!status || order.status === status);
    });
  }
  return { initialize, handle, view, list };
});

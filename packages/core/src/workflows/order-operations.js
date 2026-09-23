(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'), require('./orders.js'), require('./inventory.js'), require('./dispatch.js'), require('./reservations.js'), require('./finance.js'), require('./exchanges.js'));
  else root.SkiWorkflowOrderOperations = factory(root.SkiWorkflowCommon, root.SkiWorkflowOrders, root.SkiWorkflowInventory, root.SkiWorkflowDispatch, root.SkiWorkflowReservations, root.SkiWorkflowFinance, root.SkiWorkflowExchanges);
})(globalThis, function (C, O, I, D, B, G, E) {
  'use strict';
  const commands = ['ops.return', 'ops.receive', 'ops.dispatch', 'ops.deliver', 'ops.issue', 'ops.deliveryCancel', 'ops.visit', 'ops.schedule', 'ops.extend', 'ops.link', 'ops.ticketIssue', 'ops.cancelTicket', 'ops.prepare', 'ops.prepareCancel', 'ops.taskMove'];
  const canHandle = type => commands.includes(type);
  const active = task => ['waiting', 'in_progress'].includes(task.status);
  const orderOf = (state, id) => C.find(state.orders || [], id, '통합접수');
  const same = (a, b) => !!a && !!b && I.same(a, b);
  const shop = state => ({ kind: 'shop', id: state.shopId });
  const effective = (movement, id) => movement.assetIds.includes(id) && !(movement.reversedAssetIds || []).includes(id);
  const generatedId = (state, label, rows) => {
    let sequence = rows.length + 1, id;
    do { id = label + '-' + (state.revision + 1) + '-' + sequence++; } while (rows.some(row => row.id === id));
    return id;
  };
  function remaining(state, task) {
    const kind = task.kind === 'delivery' ? 'deliver' : task.kind === 'collection' ? 'collect' : 'refund';
    return task.assetIds.filter(id => !(task.fulfilledElsewhereAssetIds || []).includes(id) && !state.movements.some(movement => movement.kind === kind && movement.taskId === task.id && effective(movement, id)));
  }
  function taskRows(task) {
    const rows = new Map();
    for (const row of [...(task.lineItems || []), ...(task.plannedItems || []).map(item => ({ lineId: item.itemId, assetIds: item.assetIds }))]) rows.set(row.lineId, [...new Set([...(rows.get(row.lineId) || []), ...row.assetIds])]);
    return [...rows].map(([lineId, assetIds]) => ({ lineId, assetIds }));
  }
  function linkedTask(state, id, orderId, kind, context) {
    const task = C.find(state.tasks, id, '차량 업무');
    if (task.orderId !== orderId || task.customerId !== orderId || kind && task.kind !== kind) C.fail('FORBIDDEN', '이 접수에 배정한 차량 업무를 선택해 주세요.');
    if (!active(task)) C.fail('NO_CHANGE', '이미 종료된 차량 업무입니다.');
    C.vehicle(context, task.vehicleId); return task;
  }
  function selection(state, order, values, field, empty = false) {
    const view = O.view(state, order), seenLines = new Set(), seenAssets = new Set();
    const result = C.list(values, 500, empty).map(value => {
      C.keys(value, ['lineId', 'assetIds']); const line = C.find(view.lines, value.lineId, '품목 행');
      if (seenLines.has(line.id)) C.fail('INVALID_INPUT', '같은 품목 행을 두 번 선택했습니다.');
      seenLines.add(line.id); const ids = C.list(value.assetIds, 500, empty).length ? C.ids(value.assetIds) : [];
      for (const id of ids) {
        if (seenAssets.has(id)) C.fail('INVALID_INPUT', '같은 실물을 여러 번 선택했습니다.');
        seenAssets.add(id); C.find(state.assets, id, '물품');
        if (field && !(line[field] || []).includes(id)) C.fail('QUANTITY_EXCEEDED', '선택한 품목 행의 현재 보유 물품을 다시 확인해 주세요.');
      }
      return { lineId: line.id, assetIds: ids };
    });
    C.list([...seenAssets], 500, empty); return result.filter(row => row.assetIds.length);
  }
  const flat = rows => rows.flatMap(row => row.assetIds);
  function move(state, payload, context) {
    if (['collect', 'receive', 'directReturn'].includes(payload.kind) && payload.assetIds.some(id => C.find(state.assets, id).condition === 'lost')) C.fail('INVALID_INPUT', '분실품은 발견 처리에서 실제 위치를 확인한 뒤 반납해 주세요.');
    E.beforeMove(state, payload, context); const result = I.move(state, payload, context); E.afterMove(state, result, context); return result;
  }
  function annotate(state, result, orderId, lineItems) {
    const movement = C.find(state.movements, result.movementId); movement.orderId = orderId; movement.lineItems = C.copy(lineItems);
    return result;
  }
  function finish(state, task, context) {
    if (task && active(task) && !remaining(state, task).length && !D.unassigned(task)) D.handle(state, 'task.status', { id: task.id, status: 'completed' }, context);
  }
  function returnItems(state, p, context) {
    C.keys(p, ['orderId', 'lineItems', 'mode', 'vehicleId', 'taskId']);
    const order = orderOf(state, p.orderId), mode = C.oneOf(p.mode, ['direct', 'collect']);
    if (mode === 'direct') C.store(context);
    const task = p.taskId == null ? null : linkedTask(state, p.taskId, order.id, 'collection', context);
    if (context.actor.role === 'driver' && !task) C.fail('FORBIDDEN', '기사님은 배정된 수거 업무에서 처리해 주세요.');
    const vehicleId = mode === 'collect' ? C.id(p.vehicleId ?? task?.vehicleId) : null;
    if (task && vehicleId && task.vehicleId !== vehicleId) C.fail('FORBIDDEN', '수거 업무의 담당 차량을 확인해 주세요.');
    const rows = selection(state, order, p.lineItems, 'customerAssetIds', true), assetIds = flat(rows);
    if (!assetIds.length) return { orderId: order.id, receivedQuantity: 0, movementIds: [] };
    const groups = new Map();
    for (const id of assetIds) {
      const key = mode === 'direct' ? C.find(state.assets, id).exchangeReservationId || '' : '';
      groups.set(key, [...(groups.get(key) || []), id]);
    }
    const movementIds = [];
    for (const [exchangeId, ids] of groups) {
      const selectedRows = rows.map(row => ({ lineId: row.lineId, assetIds: row.assetIds.filter(id => ids.includes(id)) })).filter(row => row.assetIds.length);
      const result = move(state, { kind: mode === 'direct' ? 'directReturn' : 'collect', from: { kind: 'customer', id: order.id },
        to: mode === 'direct' ? shop(state) : { kind: 'vehicle', id: vehicleId }, assetIds: ids, ...(exchangeId ? { exchangeId } : {}), ...(mode === 'collect' && task ? { taskId: task.id } : {}) }, context);
      annotate(state, result, order.id, selectedRows); movementIds.push(result.movementId);
    }
    finish(state, task, context);
    return { orderId: order.id, lineItems: rows, receivedQuantity: assetIds.length, movementIds };
  }
  function receive(state, p, context) {
    C.store(context); C.keys(p, ['orderId', 'assetIds']); const order = orderOf(state, p.orderId), view = O.view(state, order);
    const ids = C.list(p.assetIds, 500, true).length ? C.ids(p.assetIds) : [], groups = new Map();
    for (const id of ids) {
      const line = view.lines.find(row => row.vehicleAssetIds.includes(id)), asset = C.find(state.assets, id, '물품');
      if (!line || asset.location.kind !== 'vehicle') C.fail('QUANTITY_EXCEEDED', '이 접수에서 수거하여 차량에 보관 중인 물품만 선택해 주세요.');
      const group = groups.get(asset.location.id) || new Map();
      group.set(line.id, [...(group.get(line.id) || []), id]); groups.set(asset.location.id, group);
    }
    const movementIds = [];
    for (const [vehicleId, lines] of groups) {
      const lineItems = [...lines].map(([lineId, assetIds]) => ({ lineId, assetIds }));
      const result = move(state, { kind: 'receive', from: { kind: 'vehicle', id: vehicleId }, to: shop(state), assetIds: flat(lineItems) }, context);
      annotate(state, result, order.id, lineItems); movementIds.push(result.movementId);
    }
    return { orderId: order.id, receivedQuantity: ids.length, vehicleIds: [...groups.keys()], movementIds };
  }
  function ticketAllocation(state, order, line, asset) {
    const bindings = line.reservationBindings || [];
    const allocation = state.allocations.find(row => row.assetId === asset.id && row.reservationId === order.id && row.status === 'active' && !row.fulfilledAt && bindings.some(binding => binding.reservationId === row.reservationId && binding.lineId === row.lineId));
    if (!asset.ticket || !allocation) C.fail('TICKET_UNAVAILABLE', '이 접수의 판매 품목에 실제 발권·배정한 리프트권을 선택해 주세요.');
    return allocation;
  }
  function issueRows(state, order, values, from, task) {
    const rows = selection(state, order, values), view = O.view(state, order);
    for (const row of rows) {
      const line = C.find(view.lines, row.lineId), stored = C.find(order.lines, row.lineId);
      const otherPending = state.tasks.filter(candidate => candidate.id !== task?.id && candidate.orderId === order.id && candidate.kind === 'delivery' && active(candidate)).flatMap(candidate =>
        taskRows(candidate).filter(item => item.lineId === line.id).flatMap(item => item.assetIds.filter(id => remaining(state, candidate).includes(id))));
      const otherPrepared = state.assets.filter(asset => asset.orderPreparation?.orderId === order.id && asset.orderPreparation.lineId === line.id && !row.assetIds.includes(asset.id) && !(task?.assetIds || []).includes(asset.id)).map(asset => asset.id);
      if (row.assetIds.length > line.unissuedQuantity - new Set([...otherPending, ...otherPrepared]).size) C.fail('QUANTITY_EXCEEDED', '다른 준비·배달에 배정한 수량을 제외한 지급 예정 수량을 확인해 주세요.');
      for (const id of row.assetIds) {
        const asset = C.find(state.assets, id);
        if (asset.orderPreparation && (asset.orderPreparation.orderId !== order.id || asset.orderPreparation.lineId !== line.id)) C.fail('ALREADY_EXISTS', '다른 접수·품목 행에 준비한 물품입니다.');
        if (!same(asset.location, from)) C.fail('QUANTITY_EXCEEDED', '현재 담당 매장·차량에 해당 물품이 없습니다.');
        if (line.category === 'liftTicket') ticketAllocation(state, order, stored, asset);
        else if (asset.sku !== line.sku || asset.ticket || asset.componentBaseId) C.fail('INVALID_INPUT', '대여 품목에 맞는 장비를 선택해 주세요.');
        if (task && (!taskRows(task).some(item => item.lineId === line.id && item.assetIds.includes(id)) || !remaining(state, task).includes(id))) C.fail('FORBIDDEN', '이 배달에 배정되어 아직 전달하지 않은 물품만 선택해 주세요.');
      }
    }
    return rows;
  }
  function scheduleIssuedReturns(state, order, rows, context) {
    const taskIds = new Set();
    for (const row of rows) {
      const line = C.find(order.lines, row.lineId), plan = line.returnPlan;
      if (plan?.method !== 'vehicle') continue;
      const ids = row.assetIds.filter(id => !state.tasks.some(task => task.kind === 'collection' && task.customerId === order.id && active(task) && remaining(state, task).includes(id)));
      if (!ids.length) continue;
      let task = state.tasks.find(task => task.kind === 'collection' && task.orderId === order.id && task.customerId === order.id && active(task) && !task.exchangeId
        && task.vehicleId === plan.vehicleId && task.date === plan.date && task.time === plan.time && task.place === plan.place);
      if (!task) {
        task = { id: generatedId(state, 'order-collection', state.tasks), kind: 'collection', orderId: order.id, customerId: order.id, reservationId: null,
          vehicleId: C.id(plan.vehicleId), date: C.date(plan.date), time: C.time(plan.time), place: C.string(plan.place), title: order.customer.name + ' 반납 약속 수거',
          assetIds: [], lineItems: [], status: 'waiting', createdAt: context.at, source: 'issued-return-plan' };
        state.tasks.push(task);
      }
      task.assetIds.push(...ids); task.lineItems ||= [];
      const existing = task.lineItems.find(item => item.lineId === line.id);
      if (existing) existing.assetIds.push(...ids); else task.lineItems.push({ lineId: line.id, assetIds: ids.slice() });
      (task.issueAssignments ||= []).push({ lineId: line.id, assetIds: ids.slice(), at: context.at, actor: C.copy(context.actor) }); taskIds.add(task.id);
    }
    return [...taskIds];
  }
  function issue(state, p, context, delivery) {
    C.keys(p, delivery ? ['orderId', 'taskId', 'lineItems'] : ['orderId', 'lineItems']); const order = orderOf(state, p.orderId);
    if (!delivery) C.store(context);
    const task = delivery ? linkedTask(state, p.taskId, order.id, 'delivery', context) : null;
    const from = task ? { kind: 'vehicle', id: task.vehicleId } : shop(state), rows = issueRows(state, order, p.lineItems, from, task);
    const equipment = rows.filter(row => C.find(order.lines, row.lineId).category !== 'liftTicket'), tickets = rows.filter(row => C.find(order.lines, row.lineId).category === 'liftTicket');
    const movementIds = [];
    if (equipment.length) movementIds.push(O.handle(state, 'order.issue', { orderId: order.id, lineItems: equipment, ...(task ? { vehicleId: task.vehicleId, taskId: task.id } : {}) }, context).movementId);
    if (tickets.length) {
      const result = move(state, { kind: 'deliver', from, to: { kind: 'customer', id: order.id }, assetIds: flat(tickets), ...(task ? { taskId: task.id } : {}) }, context);
      annotate(state, result, order.id, tickets); movementIds.push(result.movementId);
    }
    finish(state, task, context);
    const collectionTaskIds = scheduleIssuedReturns(state, order, rows, context);
    return { orderId: order.id, taskId: task?.id || null, lineItems: rows, issuedQuantity: flat(rows).length, movementIds, collectionTaskIds };
  }
  function dispatch(state, p, context) {
    C.store(context); C.keys(p, ['orderId', 'id', 'lineItems', 'vehicleId', 'date', 'time', 'place']);
    const order = orderOf(state, p.orderId), id = C.id(p.id);
    if (state.tasks.some(task => task.id === id)) C.fail('ALREADY_EXISTS', '이미 등록한 배달입니다. 남은 업무에서 확인해 주세요.');
    const rows = issueRows(state, order, p.lineItems, shop(state));
    D.handle(state, 'task.save', { id, kind: 'delivery', orderId: order.id, customerId: order.id, vehicleId: p.vehicleId,
      date: p.date, time: p.time, place: p.place, title: order.customer.name + ' 추가 장비·권 전달', assetIds: flat(rows) }, context);
    const task = C.find(state.tasks, id); task.lineItems = C.copy(rows);
    const result = move(state, { kind: 'load', from: shop(state), to: { kind: 'vehicle', id: task.vehicleId }, assetIds: flat(rows), purpose: 'delivery', taskId: task.id }, context);
    annotate(state, result, order.id, rows);
    return { orderId: order.id, taskId: task.id, lineItems: rows, loadedQuantity: flat(rows).length, movementId: result.movementId };
  }
  function deliveryCancel(state, p, context) {
    C.store(context); C.keys(p, ['taskId', 'reason', 'unload']);
    const raw = C.find(state.tasks, p.taskId), task = linkedTask(state, p.taskId, raw.orderId, 'delivery', context);
    orderOf(state, task.orderId); const reason = C.string(p.reason, 300);
    if (p.unload !== true) C.fail('INVALID_INPUT', '미전달 물품을 실제로 매장에 내렸는지 확인해 주세요.');
    const pending = remaining(state, task), loaded = [];
    if (!pending.length) C.fail('NO_CHANGE', '취소할 미전달 물품이 없습니다.');
    for (const id of pending) {
      const asset = C.find(state.assets, id);
      if (same(asset.location, { kind: 'vehicle', id: task.vehicleId })) loaded.push(id);
      else if (!same(asset.location, shop(state))) C.fail('DEPENDENT_MOVEMENT', '다른 위치로 이동한 미전달 물품을 먼저 확인해 주세요.');
    }
    const movementIds = [];
    if (loaded.length) {
      const rows = taskRows(task).map(row => ({ lineId: row.lineId, assetIds: row.assetIds.filter(id => loaded.includes(id)) })).filter(row => row.assetIds.length);
      const result = move(state, { kind: 'receive', from: { kind: 'vehicle', id: task.vehicleId }, to: shop(state), assetIds: loaded }, context);
      annotate(state, result, task.orderId, rows); movementIds.push(result.movementId);
    }
    D.handle(state, 'task.status', { id: task.id, status: 'cancelled' }, context);
    task.cancellation = { reason, at: context.at, actor: C.copy(context.actor), undeliveredAssetIds: pending.slice(), unloadedAssetIds: loaded.slice() };
    return { orderId: task.orderId, taskId: task.id, unloadedQuantity: loaded.length, releasedQuantity: pending.length, movementIds };
  }
  function visit(state, p, context) {
    C.keys(p, ['taskId', 'result', 'nextDate', 'nextTime', 'place', 'reason']); const raw = C.find(state.tasks, p.taskId);
    const task = linkedTask(state, p.taskId, raw.orderId, null, context); orderOf(state, task.orderId);
    C.oneOf(task.kind, ['delivery', 'collection']);
    const result = C.oneOf(p.result, ['absent', 'location_changed', 'none']), date = C.date(p.nextDate), time = C.time(p.nextTime), place = C.string(p.place);
    if (Date.parse(date + 'T' + time + ':00+09:00') < Date.parse(context.at)) C.fail('INVALID_INPUT', '다음 방문은 현재 이후의 날짜·시간으로 입력해 주세요.');
    const record = { result, reason: C.string(p.reason, 300, result !== 'none'), at: context.at, actor: C.copy(context.actor),
      before: { date: task.date, time: task.time, place: task.place }, after: { date, time, place }, remainingAssetIds: remaining(state, task) };
    if (!record.remainingAssetIds.length && !D.unassigned(task)) C.fail('NO_CHANGE', '남은 방문 물품이 없습니다.');
    (task.visits ||= []).push(record); task.date = date; task.time = time; task.place = place; task.status = 'waiting';
    return { orderId: task.orderId, taskId: task.id, result, nextDate: date, nextTime: time, movedQuantity: 0 };
  }
  function replaceCollections(state, order, selected, context) {
    for (const task of state.tasks.filter(task => task.orderId === order.id && task.kind === 'collection' && active(task))) {
      const removed = remaining(state, task).filter(id => selected.includes(id)); if (!removed.length) continue;
      (task.reassignments ||= []).push({ at: context.at, actor: C.copy(context.actor), beforeAssetIds: task.assetIds.slice(), removedAssetIds: removed.slice() });
      task.assetIds = task.assetIds.filter(id => !removed.includes(id));
      if (task.lineItems) task.lineItems = task.lineItems.map(row => ({ lineId: row.lineId, assetIds: row.assetIds.filter(id => !removed.includes(id)) })).filter(row => row.assetIds.length);
      if (!remaining(state, task).length) D.handle(state, 'task.status', { id: task.id, status: task.assetIds.length ? 'completed' : 'cancelled' }, context);
    }
  }
  function schedule(state, p, context) {
    C.store(context); C.keys(p, ['orderId', 'lineItems', 'date', 'time', 'place', 'vehicleId']);
    const order = orderOf(state, p.orderId), rows = selection(state, order, p.lineItems, 'customerAssetIds');
    if (flat(rows).some(id => C.find(state.assets, id).exchangeReservationId)) C.fail('DEPENDENT_MOVEMENT', '교환 구품은 연결된 교환 회수 업무에서 다음 방문 일정을 변경해 주세요.');
    if (flat(rows).some(id => C.find(state.assets, id).condition === 'lost')) C.fail('INVALID_INPUT', '분실품은 발견 처리에서 실제 위치를 먼저 확인해 주세요.');
    const date = C.date(p.date), time = C.time(p.time), place = C.string(p.place), vehicleId = C.id(p.vehicleId);
    if (date < C.day(context.at)) C.fail('INVALID_INPUT', '지난 날짜로 새 수거를 예약할 수 없습니다.');
    const id = generatedId(state, 'order-collection', state.tasks), original = O.view(state, order);
    replaceCollections(state, order, flat(rows), context);
    D.handle(state, 'task.save', { id, kind: 'collection', orderId: order.id, customerId: order.id, vehicleId, date, time, place, title: order.customer.name + ' 수거', assetIds: flat(rows) }, context);
    C.find(state.tasks, id).lineItems = C.copy(rows);
    const plan = { method: 'vehicle', date, time, place, vehicleId };
    for (const row of rows) {
      const current = C.find(original.lines, row.lineId);
      const stored = order.lines.find(line => line.id === row.lineId);
      if (stored && current.unissuedQuantity === 0 && !current.shopQuantity && !current.vehicleQuantity && !current.unknownQuantity && !current.nonReturnQuantity && row.assetIds.length === current.customerAssetIds.length) stored.returnPlan = C.copy(plan);
    }
    (order.schedules ||= []).push({ taskId: id, lineItems: C.copy(rows), plan, at: context.at, actor: C.copy(context.actor) });
    return { orderId: order.id, taskId: id, lineItems: rows, scheduledQuantity: flat(rows).length };
  }
  function extend(state, p, context) {
    C.store(context); C.keys(p, ['orderId', 'lineIds', 'end', 'amountWon', 'reason']);
    const order = orderOf(state, p.orderId), view = O.view(state, order), end = C.date(p.end), reason = C.string(p.reason, 300), amountWon = C.integer(p.amountWon, 0, Number.MAX_SAFE_INTEGER);
    if ((state.closings || []).some(row => row.date === C.day(context.at) && !(row.reopenings || []).length)) C.fail('CLOSING_LOCKED', '마감된 날짜의 요금은 마감을 다시 연 뒤 변경해 주세요.');
    const lines = C.ids(p.lineIds).map(id => C.find(order.lines, id, '품목 행'));
    let expectedWon = 0, legacy = false;
    const changes = lines.map(line => {
      const current = C.find(view.lines, line.id), ids = current.customerAssetIds;
      if (!current.activeQuantity || !ids.length && (current.issuedQuantity || current.nonReturnQuantity)) C.fail('NO_CHANGE', '현재 고객이 이용 중인 물품 또는 아직 지급하지 않은 품목을 선택해 주세요.');
      if (current.exchangeOutstandingQuantity || ids.some(id => C.find(state.assets, id).exchangeReservationId || C.find(state.assets, id).condition === 'lost')) C.fail('DEPENDENT_MOVEMENT', '교환·분실 확인이 남은 품목은 해당 문제를 먼저 해결해 주세요.');
      if (line.category === 'liftTicket' || line.price.basis !== 'per_day') C.fail('INVALID_INPUT', '리프트권·정액 이용분은 해당 이용 조건을 새로 확인해 주세요.');
      const partial = ids.length && (current.shopQuantity || current.vehicleQuantity || current.unknownQuantity || current.nonReturnQuantity || current.unissuedQuantity);
      const assetChanges = (ids.length ? ids : [null]).map(assetId => {
        const term = (line.assetTerms || []).find(term => term.assetId === assetId), beforeEnd = term?.end || line.end;
        if (end <= beforeEnd || (Date.parse(end) - Date.parse(line.start)) / 86400000 + 1 > 366) C.fail('INVALID_INPUT', '현재 이용 종료일보다 늦은 366일 이내의 종료일을 입력해 주세요.');
        const task = assetId && state.tasks.find(task => task.kind === 'collection' && task.orderId === order.id && active(task) && remaining(state, task).includes(assetId));
        const beforeReturnPlan = task ? { method: 'vehicle', date: task.date, time: task.time, place: task.place, vehicleId: task.vehicleId } : C.copy(term?.returnPlan || line.returnPlan);
        const addedDays = (Date.parse(end) - Date.parse(beforeEnd)) / 86400000;
        if (line.price.source === 'legacy-total-only') legacy = true;
        else expectedWon = C.integer(expectedWon + line.price.unitWon * (assetId ? 1 : current.activeQuantity) * addedDays, 0, Number.MAX_SAFE_INTEGER);
        return { assetId, beforeEnd, afterEnd: end, beforeReturnPlan, afterReturnPlan: { ...beforeReturnPlan, date: beforeReturnPlan.date < end ? end : beforeReturnPlan.date }, addedDays };
      });
      return { lineId: line.id, scope: partial ? 'assets' : 'line', assetIds: ids.slice(), quantity: ids.length || current.activeQuantity,
        beforeEnd: line.end, afterEnd: end, beforeReturnPlan: C.copy(line.returnPlan), assetChanges };
    });
    if (legacy && lines.length !== 1) C.fail('INVALID_INPUT', '과거 단가를 모르는 품목은 한 행씩 추가 요금을 확인해 주세요.');
    if (!legacy && expectedWon !== amountWon) C.fail('INVALID_INPUT', '저장 단가·남은 이용 수량·실물별 추가 일수로 계산한 연장금액과 다릅니다.');
    const id = generatedId(state, 'order-extension', order.extensions || []), adjustmentId = amountWon ? generatedId(state, 'extension-charge', state.adjustments || []) : null;
    if (amountWon) G.handle(state, 'finance.adjustment', { id: adjustmentId, orderId: order.id, ...(lines.length === 1 ? { lineId: lines[0].id } : {}), amountWon, reason }, context);
    for (const change of changes) {
      const line = C.find(order.lines, change.lineId), groups = new Map();
      for (const assetChange of change.assetChanges) {
        if (!assetChange.assetId) continue;
        line.assetTerms ||= []; let term = line.assetTerms.find(term => term.assetId === assetChange.assetId);
        if (!term) { term = { assetId: assetChange.assetId }; line.assetTerms.push(term); }
        Object.assign(term, { end, returnPlan: C.copy(assetChange.afterReturnPlan), extensionId: id });
        if (assetChange.afterReturnPlan.method === 'vehicle') {
          const key = C.canonical(assetChange.afterReturnPlan), group = groups.get(key) || { plan: assetChange.afterReturnPlan, assetIds: [] };
          group.assetIds.push(assetChange.assetId); groups.set(key, group);
        }
      }
      for (const { plan, assetIds } of groups.values()) schedule(state, { orderId: order.id, lineItems: [{ lineId: line.id, assetIds }], date: plan.date, time: plan.time || '16:30', place: plan.place, vehicleId: plan.vehicleId }, context);
      if (change.scope === 'line') { line.end = end; if (line.returnPlan.date < end) line.returnPlan = { ...line.returnPlan, date: end }; }
      else line.returnPlan = C.copy(change.beforeReturnPlan);
    }
    (order.extensions ||= []).push({ id, lineIds: lines.map(line => line.id), changes, amountWon, adjustmentId, reason, at: context.at, actor: C.copy(context.actor) });
    return { orderId: order.id, extensionId: id, adjustmentId, amountWon, lineIds: lines.map(line => line.id), end, extendedQuantity: changes.reduce((sum, change) => sum + change.quantity, 0) };
  }
  function link(state, p, context) {
    C.store(context); C.keys(p, ['orderId', 'sourceType', 'sourceId']); const order = orderOf(state, p.orderId), sourceType = C.oneOf(p.sourceType, ['form', 'reservation']);
    const source = C.find(sourceType === 'form' ? state.forms : state.reservations, p.sourceId, sourceType === 'form' ? '입력폼' : '예약');
    if (source.orderId && source.orderId !== order.id || state.orders.some(other => other.id !== order.id && (other.links || []).some(row => row.sourceType === sourceType && row.sourceId === source.id))) C.fail('ALREADY_EXISTS', '다른 통합접수에 연결된 기록입니다. 기존 연결을 먼저 확인해 주세요.');
    if ((order.links || []).some(row => row.sourceType === sourceType && row.sourceId === source.id)) C.fail('NO_CHANGE', '이미 이 접수에 연결되어 있습니다.');
    const historicalMovement = state.movements.some(movement => movement.kind === 'deliver' && movement.to.id === source.id && movement.assetIds.some(id => effective(movement, id)));
    source.orderId = order.id;
    (order.links ||= []).push({ sourceType, sourceId: source.id, at: context.at, actor: C.copy(context.actor), historicalMovement, custodyMerged: false });
    return { orderId: order.id, sourceType, sourceId: source.id, historicalMovement, custodyMerged: false };
  }
  function ticketIssue(state, p, context) {
    C.store(context); C.keys(p, ['orderId', 'lineId', 'quantity', 'sku', 'ticket', 'startTime', 'endTime']);
    const order = orderOf(state, p.orderId), line = C.find(order.lines, p.lineId, '품목 행'), current = C.find(O.view(state, order).lines, line.id);
    if (line.category !== 'liftTicket' || line.start !== line.end) C.fail('INVALID_INPUT', '하루 이용 리프트권 판매 품목을 선택해 주세요.');
    const sku = C.find(state.catalog, p.sku ?? line.sku, '실제 발권 권종');
    if (sku.kind !== 'liftTicket' || sku.requiresTypeConfirmation) C.fail('INVALID_INPUT', '실제 발권한 시간권을 선택해 주세요.');
    const quantity = C.integer(p.quantity, 1, 500), bindings = line.reservationBindings || [];
    const secured = state.allocations.filter(allocation => allocation.reservationId === order.id && allocation.status === 'active' && !allocation.fulfilledAt && bindings.some(binding => binding.lineId === allocation.lineId)).length;
    if (quantity > current.unissuedQuantity - secured) C.fail('QUANTITY_EXCEEDED', '이미 발권한 수량을 제외한 남은 예약 수량을 확인해 주세요.');
    const ticket = p.ticket; C.keys(ticket, ['validFrom', 'validTo', 'acceptedTypes', 'transferable', 'vendorId']);
    const from = C.instant(ticket.validFrom), to = C.instant(ticket.validTo);
    const local = value => new Date(Date.parse(value) + 9 * 3600000).toISOString();
    const localFrom = local(from), localTo = local(to);
    const startTime = C.time(p.startTime ?? (localFrom.slice(0, 10) === line.start ? localFrom.slice(11, 16) : '00:00'));
    const endTime = C.time(p.endTime ?? (localTo.slice(0, 10) === line.start ? localTo.slice(11, 16) : '23:59'));
    if (endTime <= startTime) C.fail('INVALID_INPUT', '해당 이용일의 시작·종료 시간을 확인해 주세요.');
    let reservation = state.reservations.find(row => row.id === order.id);
    if (reservation && reservation.orderId !== order.id) C.fail('ALREADY_EXISTS', '같은 번호의 다른 예약이 있어 자동 연결할 수 없습니다.');
    const reservationLineId = generatedId(state, 'order-ticket-line', reservation?.lines || []);
    const ticketType = C.find(state.catalog, line.sku).requiresTypeConfirmation ? sku.id : line.sku;
    const reservationLine = { id: reservationLineId, ticketType, useDate: line.start, issueDate: C.day(context.at) < line.start ? C.day(context.at) : line.start, quantity, startTime, endTime };
    const profile = (state.customerProfiles || []).find(row => (row.orderIds || []).includes(order.id));
    const customer = { ...C.copy(order.customer), ...(profile?.phone ? { phone: profile.phone } : {}) };
    B.handle(state, reservation ? 'reservation.addLines' : 'reservation.create', reservation ? { id: order.id, lines: [reservationLine] } : { id: order.id, orderId: order.id, customer, lines: [reservationLine] }, context);
    const result = I.handle(state, 'ticket.issue', { sku: sku.id, quantity, ticket, reservationId: order.id, lineId: reservationLineId }, context);
    (line.reservationBindings ||= []).push({ reservationId: order.id, lineId: reservationLineId, assetIds: result.assetIds.slice(), quantity, at: context.at, actor: C.copy(context.actor) });
    (order.links ||= []); if (!order.links.some(row => row.sourceType === 'reservation' && row.sourceId === order.id)) order.links.push({ sourceType: 'reservation', sourceId: order.id, at: context.at, actor: C.copy(context.actor), historicalMovement: false, custodyMerged: false });
    return { ...result, orderId: order.id, lineId: line.id, reservationId: order.id, reservationLineId, issuedTicketQuantity: quantity };
  }
  function prepare(state, p, context) {
    C.store(context); C.keys(p, ['orderId', 'id', 'lineItems']); const order = orderOf(state, p.orderId);
    const id = p.id == null ? generatedId(state, 'order-preparation', order.preparations || []) : C.id(p.id);
    if ((order.preparations || []).some(row => row.id === id)) C.fail('ALREADY_EXISTS', '이미 등록한 준비 기록입니다.');
    const lineItems = C.list(p.lineItems).map(row => {
      C.keys(row, ['lineId', 'assets']);
      const line = C.find(order.lines, row.lineId);
      if (line.category === 'liftTicket') C.fail('INVALID_INPUT', '리프트권은 발권·배정에서 준비해 주세요.');
      return { lineId: line.id, assets: C.list(row.assets).map(value => { C.keys(value, ['assetId', 'size']); return { assetId: C.id(value.assetId), size: C.string(value.size, 24) }; }) };
    });
    const rows = issueRows(state, order, lineItems.map(row => ({ lineId: row.lineId, assetIds: row.assets.map(asset => asset.assetId) })), shop(state));
    for (const row of lineItems) for (const item of row.assets) {
      const asset = C.find(state.assets, item.assetId);
      if (!I.allocatable(state, asset) || asset.orderPreparation) C.fail('ALREADY_EXISTS', '정상 상태의 미배정 매장 물품을 선택해 주세요.');
      asset.orderPreparation = { orderId: order.id, lineId: row.lineId, preparationId: id, size: item.size, at: context.at };
      asset.size = item.size; asset.lastRevision = state.revision + 1;
    }
    (order.preparations ||= []).push({ id, lineItems: C.copy(lineItems), status: 'prepared', at: context.at, actor: C.copy(context.actor) });
    return { orderId: order.id, preparationId: id, preparedQuantity: flat(rows).length, lineItems: rows };
  }
  function cancelTicket(state, p, context) {
    C.store(context); C.keys(p, ['orderId', 'lineId', 'reason']);
    const order = orderOf(state, p.orderId), line = C.find(order.lines, p.lineId, '리프트권 판매 품목'), reason = C.string(p.reason, 300);
    const current = C.find(O.view(state, order).lines, line.id);
    if (line.category !== 'liftTicket') C.fail('INVALID_INPUT', '취소할 리프트권 판매 품목을 선택해 주세요.');
    if ((state.closings || []).some(closing => closing.date === C.day(context.at) && !(closing.reopenings || []).length)) C.fail('DAY_CLOSED', '오늘 마감이 확정되어 있습니다. 관리자 마감 재개 후 취소해 주세요.');
    if (current.cancelledQuantity || !current.unissuedQuantity) C.fail('NO_CHANGE', '이미 취소했거나 취소할 미지급 리프트권이 없습니다.');
    if (current.issuedQuantity) C.fail('DEPENDENT_MOVEMENT', '이미 지급한 권이 포함된 품목입니다. 실제 회수·발권처 반환을 확인하고 고객 수납·환불에서 정산해 주세요.');
    if (G.summary(state, order.id).chargedWon - current.activeAmountWon < 0) C.fail('INVALID_INPUT', '금액 조정 내역을 먼저 확인해 주세요. 취소 후 청구액이 음수가 됩니다.');
    const bindings = [], seen = new Set();
    for (const binding of line.reservationBindings || []) {
      const key = binding.reservationId + ':' + binding.lineId;
      if (seen.has(key)) continue;
      seen.add(key);
      const reservation = C.find(state.reservations, binding.reservationId, '발권 예약');
      if (reservation.id !== order.id || reservation.orderId !== order.id || order.lines.some(other => other.id !== line.id && (other.reservationBindings || []).some(row => row.reservationId === binding.reservationId && row.lineId === binding.lineId))) C.fail('FORBIDDEN', '다른 접수·판매 품목에 연결된 발권 예약은 취소할 수 없습니다.');
      const demand = C.find(reservation.lines, binding.lineId, '발권 예약 수요');
      const allocations = state.allocations.filter(allocation => allocation.reservationId === reservation.id && allocation.lineId === demand.id && allocation.status === 'active');
      if (allocations.some(allocation => allocation.fulfilledAt)) C.fail('DEPENDENT_MOVEMENT', '고객에게 지급한 발권 배정이 있습니다. 실제 권 회수·반환과 수납·환불을 먼저 확인해 주세요.');
      for (const allocation of allocations) {
        const asset = C.find(state.assets, allocation.assetId, '발권 실물');
        const returnedToVendor = asset.location.kind === 'vendor' && asset.ticket?.vendorId === asset.location.id && state.movements.some(movement => movement.kind === 'refund' && same(movement.to, asset.location) && effective(movement, asset.id));
        if (!asset.ticket || asset.condition === 'lost' || asset.exchangeReservationId || !same(asset.location, shop(state)) && !returnedToVendor) C.fail('DEPENDENT_MOVEMENT', '권의 실물을 먼저 확인해 주세요. 고객 지급·차량 적재분은 실제 회수와 매장 내리기, 발권처 반환에서 처리합니다.');
      }
      bindings.push({ reservationId: reservation.id, lineId: demand.id, cancelledDemandQuantity: demand.quantity - demand.cancelledQuantity, allocationIds: allocations.map(allocation => allocation.id), assetIds: allocations.map(allocation => allocation.assetId) });
    }
    if (state.tasks.some(task => active(task) && task.kind === 'delivery' && task.orderId === order.id && taskRows(task).some(row => row.lineId === line.id))) C.fail('DEPENDENT_MOVEMENT', '연결된 배달을 먼저 해제해 주세요. 차량에 실은 권은 실제로 매장에 내린 뒤 취소합니다.');
    // The outer workflow transaction commits demand release and receipt
    // cancellation together. Physical stock and money remain separate records.
    for (const binding of bindings) {
      if (binding.allocationIds.length) B.handle(state, 'ticket.release', { allocationIds: binding.allocationIds }, context);
      if (binding.cancelledDemandQuantity) B.handle(state, 'reservation.cancel', { reservationId: binding.reservationId, lineId: binding.lineId, quantity: binding.cancelledDemandQuantity }, context);
    }
    const cancelled = O.handle(state, 'order.cancel', { orderId: order.id, lineIds: [line.id], reason }, context);
    const id = generatedId(state, 'order-ticket-cancellation', order.ticketCancellations || []);
    (order.ticketCancellations ||= []).push({ id, lineId: line.id, bindings, reason, at: context.at, actor: C.copy(context.actor), cancelledAmountWon: cancelled.cancelledAmountWon });
    return { ...cancelled, lineId: line.id, ticketCancellationId: id, releasedAllocationQuantity: bindings.reduce((total, binding) => total + binding.allocationIds.length, 0),
      cancelledDemandQuantity: bindings.reduce((total, binding) => total + binding.cancelledDemandQuantity, 0), assetIds: [...new Set(bindings.flatMap(binding => binding.assetIds))], physicalMovedQuantity: 0, refundedWon: 0 };
  }
  function prepareCancel(state, p, context) {
    C.store(context); C.keys(p, ['orderId', 'preparationId', 'reason']); const order = orderOf(state, p.orderId);
    const preparation = C.find(order.preparations || [], p.preparationId, '준비 기록'), reason = C.string(p.reason, 300);
    if (preparation.status === 'cancelled') C.fail('NO_CHANGE', '이미 취소한 준비입니다.');
    const assets = state.assets.filter(asset => asset.orderPreparation?.orderId === order.id && asset.orderPreparation.preparationId === preparation.id);
    if (!assets.length) C.fail('NO_CHANGE', '해제할 준비 물품이 없습니다. 이미 지급한 물품은 반납에서 처리해 주세요.');
    if (assets.some(asset => !same(asset.location, shop(state)) || state.tasks.some(task => task.kind === 'delivery' && active(task) && remaining(state, task).includes(asset.id)))) C.fail('DEPENDENT_MOVEMENT', '적재·배달에 연결한 물품은 배달 취소와 매장 내리기를 먼저 처리해 주세요.');
    assets.forEach(asset => { delete asset.orderPreparation; asset.lastRevision = state.revision + 1; });
    preparation.status = 'cancelled'; preparation.cancellation = { reason, at: context.at, actor: C.copy(context.actor), releasedAssetIds: assets.map(asset => asset.id) };
    return { orderId: order.id, preparationId: preparation.id, releasedQuantity: assets.length, assetIds: assets.map(asset => asset.id) };
  }
  function taskMove(state, p, context) {
    C.keys(p, ['taskId', 'assetIds']); const task = C.find(state.tasks, p.taskId, '차량 업무');
    C.vehicle(context, task.vehicleId); C.oneOf(task.kind, ['delivery', 'collection']);
    if (!active(task)) C.fail('NO_CHANGE', '이미 종료된 차량 업무입니다.');
    const ids = C.list(p.assetIds, 500, true).length ? C.ids(p.assetIds) : [];
    if (ids.some(id => !remaining(state, task).includes(id))) C.fail('FORBIDDEN', '이 업무에서 아직 전달·수거하지 않은 물품만 선택해 주세요.');
    if (!ids.length) return { taskId: task.id, movedQuantity: 0, movementIds: [] };
    const order = (state.orders || []).find(order => order.id === task.orderId && order.id === task.customerId);
    if (order && task.kind === 'delivery' && !task.exchangeId) {
      const rows = taskRows(task).map(row => ({ lineId: row.lineId, assetIds: row.assetIds.filter(id => ids.includes(id)) })).filter(row => row.assetIds.length);
      if (flat(rows).length !== ids.length || new Set(flat(rows)).size !== ids.length) C.fail('INVALID_INPUT', '통합접수의 품목 행과 배정 물품 연결을 먼저 확인해 주세요.');
      return { ...issue(state, { orderId: order.id, taskId: task.id, lineItems: rows }, context, true), movedQuantity: ids.length };
    }
    if (order && task.kind === 'collection') {
      const rows = O.view(state, order).lines.map(line => ({ lineId: line.id, assetIds: ids.filter(id => line.customerAssetIds.includes(id)) })).filter(row => row.assetIds.length);
      if (flat(rows).length !== ids.length || new Set(flat(rows)).size !== ids.length) C.fail('QUANTITY_EXCEEDED', '현재 이 접수에서 고객이 보유한 물품을 다시 확인해 주세요.');
      return { ...returnItems(state, { orderId: order.id, taskId: task.id, lineItems: rows, mode: 'collect' }, context), taskId: task.id, movedQuantity: ids.length };
    }
    const delivery = task.kind === 'delivery';
    const result = move(state, { kind: delivery ? 'deliver' : 'collect', assetIds: ids, taskId: task.id,
      from: delivery ? { kind: 'vehicle', id: task.vehicleId } : { kind: 'customer', id: task.customerId },
      to: delivery ? { kind: 'customer', id: task.customerId } : { kind: 'vehicle', id: task.vehicleId } }, context);
    finish(state, task, context);
    return { taskId: task.id, movedQuantity: ids.length, movementIds: [result.movementId] };
  }
  function handle(state, type, p, context) {
    C.context(context); O.initialize(state);
    if (type === 'ops.return') return returnItems(state, p, context);
    if (type === 'ops.receive') return receive(state, p, context);
    if (type === 'ops.issue' || type === 'ops.deliver') return issue(state, p, context, type === 'ops.deliver');
    if (type === 'ops.dispatch') return dispatch(state, p, context);
    if (type === 'ops.deliveryCancel') return deliveryCancel(state, p, context);
    if (type === 'ops.visit') return visit(state, p, context);
    if (type === 'ops.schedule') return schedule(state, p, context);
    if (type === 'ops.extend') return extend(state, p, context);
    if (type === 'ops.link') return link(state, p, context);
    if (type === 'ops.ticketIssue') return ticketIssue(state, p, context);
    if (type === 'ops.cancelTicket') return cancelTicket(state, p, context);
    if (type === 'ops.prepare') return prepare(state, p, context);
    if (type === 'ops.prepareCancel') return prepareCancel(state, p, context);
    if (type === 'ops.taskMove') return taskMove(state, p, context);
    C.fail('INVALID_INPUT', '지원하지 않는 접수 처리입니다.');
  }
  return { handle, canHandle };
});

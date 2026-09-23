(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'));
  else root.SkiWorkflowDispatch = factory(root.SkiWorkflowCommon);
})(globalThis, function (C) {
  'use strict';
  const waiting = task => task.status === 'waiting';
  const fulfilled = (state, task, id) => (task.fulfilledElsewhereAssetIds || []).includes(id) || state.movements.some(m => (m.taskId === task.id || (task.refundId && m.refundId === task.refundId)) && m.kind === ({delivery:'deliver',collection:'collect',refund:'refund'}[task.kind]) && m.assetIds.includes(id) && !m.reversedAssetIds.includes(id));
  const unassigned = task => (task.plannedItems || []).reduce((n, i) => n + i.quantity - i.assetIds.length, 0);
  function ordered(state, vehicleId, date) {
    const rows = state.tasks.filter(t => t.vehicleId === vehicleId && t.date === date && waiting(t)).sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
    const override = state.sequences.find(s => s.vehicleId === vehicleId && s.date === date);
    if (!override) return rows;
    const rank = id => { const i = override.taskIds.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
    return rows.sort((a, b) => rank(a.id) - rank(b.id));
  }
  function handle(state, type, p, context) {
    if (type === 'task.priority') {
      C.keys(p, ['id', 'message']); const task = C.find(state.tasks, p.id); C.vehicle(context, task.vehicleId);
      if (!['waiting', 'in_progress'].includes(task.status)) C.fail('NO_CHANGE', '종료된 업무에는 확인 요청을 보낼 수 없습니다.');
      return { taskId: task.id, vehicleId: task.vehicleId, message: C.string(p.message, 300, true) };
    }
    if (type === 'task.save') {
      C.store(context); C.keys(p, ['id', 'kind', 'vehicleId', 'date', 'time', 'place', 'customerId', 'title', 'orderId', 'reservationId', 'assetIds', 'plannedItems']);
      const previous = state.tasks.find(t => t.id === p.id), previousVehicleId = previous?.vehicleId || null;
      if (previous?.exchangeId) C.fail('NO_CHANGE', '교환 업무는 장비교환 기록에서 확인해 주세요.');
      if (previous && previous.status !== 'waiting') C.fail('NO_CHANGE', '대기 중인 업무만 변경할 수 있습니다.');
      if (previous && (previous.customerId !== p.customerId || previous.kind !== p.kind || previous.orderId !== (p.orderId || null) || previous.reservationId !== (p.reservationId || null))) C.fail('INVALID_INPUT', '고객이나 업무 종류를 바꾸려면 새 업무를 등록해 주세요.');
      if (previous && state.movements.some(m => m.taskId === previous.id && m.assetIds.some(id => !m.reversedAssetIds.includes(id)))) C.fail('NO_CHANGE', '이미 일부 처리한 업무의 배정은 변경할 수 없습니다.');
      const next = { id: C.id(p.id), kind: C.oneOf(p.kind, ['delivery', 'collection']), vehicleId: C.id(p.vehicleId), date: C.date(p.date), time: C.time(p.time),
        place: C.string(p.place), customerId: C.id(p.customerId), title: C.string(p.title, 100), orderId: p.orderId ? C.id(p.orderId) : null,
        reservationId: p.reservationId ? C.find(state.reservations, p.reservationId).id : null, assetIds: p.assetIds?.length ? C.ids(p.assetIds) : [], status: 'waiting', createdAt: previous?.createdAt || context.at };
      next.assetIds.forEach(id => { const a = C.find(state.assets, id); if (next.kind === 'delivery' && (a.condition !== 'ready' || a.exchangeReservationId)) C.fail('INVALID_INPUT', '정상 미배정 장비를 선택해 주세요.'); });
      if (previous?.plannedItems) {
        if (p.plannedItems && C.canonical(p.plannedItems) !== C.canonical(previous.plannedItems) || C.canonical(next.assetIds) !== C.canonical(previous.assetIds)) C.fail('INVALID_INPUT', '접수 예정 수량은 물품 배정에서 처리해 주세요.');
        next.plannedItems = C.copy(previous.plannedItems);
      } else if (p.plannedItems) {
        if (p.kind !== 'delivery' || !p.orderId || next.assetIds.length || !Array.isArray(p.plannedItems) || !p.plannedItems.length || p.plannedItems.length > 200) C.fail('INVALID_INPUT', '접수의 배달 예정 품목을 확인해 주세요.');
        next.plannedItems = p.plannedItems.map(i => {
          C.keys(i, ['itemId', 'sku', 'quantity']);
          return { itemId: C.id(i.itemId), sku: C.find(state.catalog, i.sku).id, quantity: C.integer(i.quantity, 1, 1000000), assetIds: [] };
        });
        if (new Set(next.plannedItems.map(i => i.itemId)).size !== next.plannedItems.length) C.fail('INVALID_INPUT', '예정 품목이 중복되었습니다.');
      }
      if (previous && previous.vehicleId !== next.vehicleId && previous.assetIds.some(id => { const a = C.find(state.assets, id); return a.location.kind === 'vehicle' && a.location.id === previous.vehicleId; })) C.fail('DEPENDENT_MOVEMENT', '현재 차량에 실린 물품을 매장에 내린 후 담당 차량을 변경해 주세요.');
      if (previous) Object.assign(previous, next); else state.tasks.push(next);
      return { taskId: next.id, vehicleId: next.vehicleId, previousVehicleId };
    }
    if (type === 'task.allocate') {
      C.store(context); C.keys(p, ['id', 'items']);
      const task = C.find(state.tasks, p.id);
      if (task.exchangeId) C.fail('NO_CHANGE', '장비교환 화면에서 교환품을 준비해 주세요.');
      if (!task.plannedItems || !['waiting', 'in_progress'].includes(task.status)) C.fail('NO_CHANGE', '배달 예정 업무를 확인해 주세요.');
      if (!Array.isArray(p.items) || !p.items.length) C.fail('INVALID_INPUT', '배정할 물품을 선택해 주세요.');
      for (const row of p.items) {
        C.keys(row, ['itemId', 'assetIds']);
        const item = task.plannedItems.find(i => i.itemId === row.itemId), ids = C.ids(row.assetIds);
        if (!item || item.assetIds.length + ids.length > item.quantity) C.fail('QUANTITY_EXCEEDED', '접수의 배달 예정 수량을 초과했습니다.');
        for (const id of ids) {
          const asset = C.find(state.assets, id), sku = C.find(state.catalog, item.sku);
          if (asset.sku !== item.sku && !(sku.kind === 'liftTicket' && asset.ticket)) C.fail('INVALID_INPUT', '접수 품목과 배정 물품이 다릅니다.');
          if (asset.condition !== 'ready' || asset.exchangeReservationId) C.fail('INVALID_INPUT', '정상 미배정 재고를 선택해 주세요.');
          if (!(asset.location.kind === 'shop' || asset.location.kind === 'vehicle' && asset.location.id === task.vehicleId) || asset.refundId) C.fail('INVALID_INPUT', '매장 또는 담당 차량의 물품을 선택해 주세요.');
          if (state.tasks.some(t => t.kind === 'delivery' && ['waiting', 'in_progress'].includes(t.status) && t.assetIds.includes(id) && !fulfilled(state, t, id))) C.fail('ALREADY_EXISTS', '다른 배달에 배정된 물품입니다.');
          if (asset.ticket && !state.allocations.some(a => a.assetId === id && a.reservationId === task.customerId && a.status === 'active' && !a.fulfilledAt)) C.fail('TICKET_UNAVAILABLE', '고객에게 발권·배정한 리프트권을 선택해 주세요.');
          item.assetIds.push(id); task.assetIds.push(id);
        }
      }
      return { taskId: task.id, vehicleId: task.vehicleId };
    }
    if (type === 'task.status') {
      C.keys(p, ['id', 'status']); const task = C.find(state.tasks, p.id); C.vehicle(context, task.vehicleId);
      C.oneOf(p.status, ['waiting', 'in_progress', 'completed', 'cancelled']);
      if (p.status === 'cancelled') C.store(context);
      if (p.status === 'cancelled' && task.exchangeId) C.fail('NO_CHANGE', '장비교환 기록에서 연결된 업무를 함께 취소해 주세요.');
      if (p.status === 'cancelled' && task.formId) C.fail('NO_CHANGE', '인원별 장비가 적재된 배달은 일반 업무 취소로 해제할 수 없습니다.');
      if (['completed', 'cancelled'].includes(task.status)) C.fail('NO_CHANGE', '종료된 업무입니다.');
      if (task.kind === 'refund' && ['completed', 'cancelled'].includes(p.status)) C.fail('INVALID_INPUT', '환불 처리 또는 환불 취소에서 완료해 주세요.');
      if (p.status === 'completed' && (unassigned(task) || task.assetIds.some(id => !fulfilled(state, task, id)))) C.fail('QUANTITY_EXCEEDED', '아직 전달·수거하지 않은 예정 물품이 있습니다.');
      task.status = p.status; task.updatedAt = context.at;
      return { taskId: task.id, vehicleId: task.vehicleId };
    }
    if (type === 'dispatch.reorder') {
      C.store(context); C.keys(p, ['vehicleId', 'date', 'taskId', 'action']); const vehicleId = C.id(p.vehicleId), date = C.date(p.date);
      const action = C.oneOf(p.action, ['up', 'down', 'top', 'restore']); const before = ordered(state, vehicleId, date).map(t => t.id);
      let after = before.slice();
      if (action === 'restore') {
        after = state.tasks.filter(t => t.vehicleId === vehicleId && t.date === date && waiting(t)).sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id)).map(t => t.id);
      } else {
        const from = before.indexOf(C.id(p.taskId));
        if (from < 0) C.fail('NOT_FOUND', '대기 목록에서 업무를 찾을 수 없습니다.');
        const to = action === 'top' ? 0 : action === 'up' ? Math.max(0, from - 1) : Math.min(before.length - 1, from + 1);
        after.splice(from, 1); after.splice(to, 0, p.taskId);
      }
      const existing = state.sequences.find(s => s.vehicleId === vehicleId && s.date === date);
      if (C.canonical(before) === C.canonical(after) && !(action === 'restore' && existing)) C.fail('NO_CHANGE', '이미 해당 순서입니다.');
      state.sequences = state.sequences.filter(s => !(s.vehicleId === vehicleId && s.date === date));
      if (action !== 'restore') state.sequences.push({ vehicleId, date, taskIds: after, changedAt: context.at, changedBy: context.actor.id });
      return { vehicleId, date, taskId: p.taskId || null, action, taskIds: after, changes: after.flatMap((id, to) => {
        const from = before.indexOf(id); return from === to ? [] : [{ taskId: id, fromRank: from + 1, toRank: to + 1, title: C.find(state.tasks, id).title }];
      }), changedBy: context.actor.id, changedAt: context.at };
    }
    C.fail('INVALID_INPUT', '지원하지 않는 배차 작업입니다.');
  }
  function board(state, vehicleId, date, selectedTaskId) {
    C.id(vehicleId); C.date(date);
    const all = state.tasks.filter(t => t.vehicleId === vehicleId && t.date === date);
    const pending = ordered(state, vehicleId, date).map((t, index) => {
      const remainingAssetIds = t.assetIds.filter(id => !(t.fulfilledElsewhereAssetIds || []).includes(id) && !(t.refundId && C.find(state.refunds, t.refundId).cancelledAssetIds.includes(id)) && !state.movements.some(m => (m.taskId === t.id || (t.refundId && m.refundId === t.refundId)) && m.kind === ({delivery:'deliver',collection:'collect',refund:'refund'}[t.kind]) && m.assetIds.includes(id) && !m.reversedAssetIds.includes(id)));
      return { ...C.copy(t), rank: index + 1, remainingAssetIds, remainingQuantity: remainingAssetIds.length + unassigned(t),
        customer: C.copy(state.reservations.find(r => r.id === t.customerId)?.customer || state.forms.find(f => f.id === t.customerId)?.customer || null) };
    });
    const inProgress = all.filter(t => t.status === 'in_progress');
    const selected = all.find(t => t.id === selectedTaskId && ['waiting', 'in_progress'].includes(t.status));
    return { vehicleId, date, pending, inProgress: C.copy(inProgress), completed: C.copy(all.filter(t => ['completed', 'cancelled'].includes(t.status))),
      selectedTaskId: selected?.id || inProgress[0]?.id || pending[0]?.id || null, manualOrder: state.sequences.some(s => s.vehicleId === vehicleId && s.date === date) };
  }
  return { handle, ordered, board, unassigned, fulfilled };
});

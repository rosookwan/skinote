(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'), require('./inventory.js'), require('./dispatch.js'), require('./exchanges.js'));
  else root.SkiWorkflowEarlyReturns = factory(root.SkiWorkflowCommon, root.SkiWorkflowInventory, root.SkiWorkflowDispatch, root.SkiWorkflowExchanges);
})(globalThis, function (C, I, D, E) {
  'use strict';
  const reasons = { injury: '부상', schedule: '일정 변경', other: '기타' };
  function handle(state, type, p, context) {
    C.store(context); C.keys(p, ['id', 'orderId', 'customerName', 'assetIds', 'reason', 'memo', 'method', 'visit']);
    if (type !== 'earlyReturn.create') C.fail('INVALID_INPUT', '지원하지 않는 조기반납 작업입니다.');
    state.earlyReturns ||= [];
    const id = C.id(p.id); if (state.earlyReturns.some(r => r.id === id)) C.fail('ALREADY_EXISTS', '이미 기록한 조기반납입니다.');
    const orderId = C.id(p.orderId), assets = C.ids(p.assetIds).map(id => C.find(state.assets, id));
    const owner = id => id === orderId || state.reservations.some(r => r.id === id && r.orderId === orderId) || state.forms.some(f => f.id === id && f.orderId === orderId);
    if (assets.some(a => a.location.kind !== 'customer' || !owner(a.location.id) || a.exchangeReservationId)) C.fail('INVALID_INPUT', '현재 고객이 보유 중인 반납 가능한 물품을 선택해 주세요.');
    if (state.tasks.some(t => t.earlyReturnId && ['waiting', 'in_progress'].includes(t.status) && assets.some(a => t.assetIds.includes(a.id) && !D.fulfilled(state, t, a.id)))) C.fail('ALREADY_EXISTS', '이미 조기수거를 예약한 물품입니다. 해당 수거 업무에서 일정을 확인해 주세요.');
    const record = { id, orderId, customerName: C.string(p.customerName, 60), assetIds: assets.map(a => a.id), owners: Object.fromEntries(assets.map(a => [a.id, a.location.id])), reason: C.oneOf(p.reason, Object.keys(reasons)), memo: C.string(p.memo, 200, true),
      method: C.oneOf(p.method, ['direct', 'vehicle']), visit: null, taskIds: [], movementIds: [], previousPlans: [], at: context.at, revision: state.revision + 1, actor: C.copy(context.actor) };
    if (record.reason === 'other' && !record.memo) C.fail('INVALID_INPUT', '기타 사유는 메모에 내용을 적어 주세요.');
    // Validate every selected piece before splitting any existing visit.
    for (const customerId of new Set(assets.map(a => a.location.id))) E.beforeMove(state, { kind: 'directReturn', assetIds: assets.filter(a => a.location.id === customerId).map(a => a.id), from: { kind: 'customer', id: customerId }, to: { kind: 'shop', id: state.shopId } });
    if (record.method === 'vehicle') {
      C.keys(p.visit, ['date', 'time', 'place', 'vehicleId']);
      const visit = { date: C.date(p.visit.date), time: C.time(p.visit.time), place: C.string(p.visit.place), vehicleId: C.id(p.visit.vehicleId) };
      if (Date.parse(visit.date + 'T' + visit.time + ':00+09:00') < Date.parse(context.at)) C.fail('INVALID_INPUT', '지나지 않은 수거 일시를 선택해 주세요.');
      const affected = state.tasks.filter(t => t.kind === 'collection' && !t.exchangeId && ['waiting', 'in_progress'].includes(t.status) && assets.some(a => t.assetIds.includes(a.id) && !D.fulfilled(state, t, a.id)));
      if (affected.some(t => visit.date + 'T' + visit.time >= t.date + 'T' + t.time)) C.fail('INVALID_INPUT', '선택한 물품의 기존 수거 일시보다 빠른 시간을 선택해 주세요.');
      for (const t of affected) {
        const selected = t.assetIds.filter(id => record.assetIds.includes(id) && !D.fulfilled(state, t, id));
        record.previousPlans.push({ taskId: t.id, assetIds: selected, date: t.date, time: t.time, place: t.place, vehicleId: t.vehicleId });
        t.assetIds = t.assetIds.filter(id => !selected.includes(id));
        if (!t.assetIds.length) { t.status = 'cancelled'; t.changeReason = '조기수거 일정으로 분리'; }
        else if (t.assetIds.every(id => D.fulfilled(state, t, id))) t.status = 'completed';
      }
      record.visit = visit;
      for (const [index, customerId] of [...new Set(assets.map(a => a.location.id))].entries()) {
        const taskId = id + '-collect-' + index;
        D.handle(state, 'task.save', { id: taskId, kind: 'collection', customerId, orderId, ...visit, title: (record.customerName + ' · 조기반납 · ' + reasons[record.reason]).slice(0, 100), assetIds: assets.filter(a => a.location.id === customerId).map(a => a.id) }, context);
        const task = C.find(state.tasks, taskId); task.earlyReturnId = id; task.memo = summary(state, record); record.taskIds.push(taskId);
      }
    } else {
      if (p.visit != null) C.fail('INVALID_INPUT', '직접반납에는 차량 수거 예약을 함께 저장하지 않습니다.');
      for (const customerId of new Set(assets.map(a => a.location.id))) {
        const result = I.move(state, { kind: 'directReturn', assetIds: assets.filter(a => a.location.id === customerId).map(a => a.id), from: { kind: 'customer', id: customerId }, to: { kind: 'shop', id: state.shopId } }, context);
        const m = C.find(state.movements, result.movementId); m.earlyReturnId = id; m.reason = reasons[record.reason]; m.memo = record.memo;
        E.afterMove(state, result, context); record.movementIds.push(m.id);
      }
    }
    state.earlyReturns.push(record); return { earlyReturnId: id, taskIds: record.taskIds, assetIds: record.assetIds };
  }
  function summary(state, r) {
    const counts = state.catalog.map(s => ({ ...s, quantity: r.assetIds.filter(id => C.find(state.assets, id).sku === s.id).length })).filter(s => s.quantity);
    return '조기반납 · ' + counts.map(s => s.label + ' ' + s.quantity + s.unit).join(' · ') + ' · ' + reasons[r.reason] + (r.memo ? ' · ' + r.memo : '');
  }
  function view(state, r) {
    let collected = 0, received = 0;
    for (const id of r.assetIds) {
      const history = state.movements.filter(m => m.revision >= r.revision && m.assetIds.includes(id) && !m.reversedAssetIds.includes(id));
      const first = history.find(m => m.earlyReturnId === r.id || ['collect', 'directReturn'].includes(m.kind) && m.from?.id === r.owners[id]);
      if (!first) continue;
      collected++;
      if (first.kind === 'directReturn' || history.some(m => m.kind === 'receive' && m.revision > first.revision)) received++;
    }
    const cancelled = !!r.taskIds.length && r.taskIds.every(id => C.find(state.tasks, id).status === 'cancelled');
    return { ...C.copy(r), summary: summary(state, r), collectedQuantity: collected, receivedQuantity: received, status: received === r.assetIds.length ? 'completed' : collected ? 'partial' : r.method === 'direct' ? 'corrected' : cancelled ? 'rescheduled' : 'waiting' };
  }
  return { handle, view, reasons, summary };
});

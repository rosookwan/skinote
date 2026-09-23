(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'));
  else root.SkiWorkflowReservations = factory(root.SkiWorkflowCommon);
})(globalThis, function (C) {
  'use strict';
  function windowOf(line) {
    return { from: Date.parse(line.useDate + 'T' + (line.startTime || '00:00') + ':00+09:00'),
      to: Date.parse((line.endTime ? line.useDate : C.nextDate(line.useDate)) + 'T' + (line.endTime || '00:00') + ':00+09:00') };
  }
  function lineOf(state, reservationId, lineId) {
    const reservation = C.find(state.reservations, reservationId, '예약');
    return { reservation, line: C.find(reservation.lines, lineId, '예약 품목') };
  }
  const active = (state, reservationId, lineId) => state.allocations.filter(a => a.reservationId === reservationId && a.lineId === lineId && a.status === 'active');
  function line(state, row) {
    C.keys(row, ['id', 'useDate', 'issueDate', 'ticketType', 'quantity', 'startTime', 'endTime']);
    const sku = C.find(state.catalog, row.ticketType);
    if (sku.kind !== 'liftTicket') C.fail('INVALID_INPUT', '리프트권 권종을 선택해 주세요.');
    const result = { id: C.id(row.id), ticketType: sku.id, useDate: C.date(row.useDate), issueDate: C.date(row.issueDate || row.useDate), quantity: C.integer(row.quantity, 1), cancelledQuantity: 0 };
    if (row.startTime || row.endTime) {
      result.startTime = C.time(row.startTime); result.endTime = C.time(row.endTime);
      if (result.endTime <= result.startTime) C.fail('INVALID_INPUT', '종료 시간이 시작 시간보다 늦어야 합니다.');
    }
    if (result.issueDate > result.useDate) C.fail('INVALID_INPUT', '발권 예정일이 이용일보다 늦습니다.');
    return result;
  }
  function eligible(state, asset, reservationId, lineId) {
    const { line } = lineOf(state, reservationId, lineId), period = windowOf(line);
    if (asset.condition !== 'ready') return '사용 가능한 상태의 권을 선택해 주세요.';
    if (!asset.ticket || !asset.ticket.acceptedTypes.includes(line.ticketType)) return '사용 조건이 맞지 않는 권입니다.';
    if (asset.location.kind === 'vendor' || asset.refundId) return '환불 대상 권입니다.';
    if (Date.parse(asset.ticket.validFrom) > period.from || Date.parse(asset.ticket.validTo) < period.to) return '권의 유효시간과 예약 이용시간을 확인해 주세요.';
    const others = state.allocations.filter(a => a.assetId === asset.id && a.status === 'active');
    for (const a of others) {
      const other = windowOf(lineOf(state, a.reservationId, a.lineId).line);
      if (period.from < other.to && other.from < period.to) return '같은 시간대에 이미 배정한 권입니다.';
    }
    const previousCustomers = new Set(state.movements.filter(m => m.kind === 'deliver' && m.assetIds.includes(asset.id) && !m.reversedAssetIds.includes(asset.id)).map(m => m.to.id));
    if (!asset.ticket.transferable && ((asset.location.kind === 'customer' && asset.location.id !== reservationId) || [...previousCustomers].some(id => id !== reservationId) || others.some(a => a.reservationId !== reservationId))) return '다른 고객에게 재전달할 수 없는 권입니다.';
    return null;
  }
  function allocate(state, payload, context) {
    const { reservation, line } = lineOf(state, payload.reservationId, payload.lineId);
    const assetIds = C.ids(payload.assetIds), allocated = active(state, reservation.id, line.id);
    if (allocated.length + assetIds.length > line.quantity - line.cancelledQuantity) C.fail('QUANTITY_EXCEEDED', '예약 수량보다 많이 배정할 수 없습니다.');
    for (const assetId of assetIds) {
      const asset = C.find(state.assets, assetId), reason = eligible(state, asset, reservation.id, line.id);
      if (reason) C.fail('TICKET_UNAVAILABLE', reason);
      state.allocations.push({ id: 'allocation-' + (state.revision + 1) + '-' + (state.allocations.length + 1), assetId, reservationId: reservation.id, lineId: line.id,
        status: 'active', createdAt: context.at, fulfilledAt: null, returnedAt: null });
      asset.lastRevision = state.revision + 1;
    }
    return { reservationId: reservation.id, lineId: line.id, assetIds };
  }
  function release(state, allocation, context) {
    allocation.status = 'cancelled'; allocation.cancelledAt = context.at;
    C.find(state.assets, allocation.assetId).lastRevision = state.revision + 1;
  }
  function handle(state, type, p, context) {
    C.store(context);
    if (type === 'reservation.create' || type === 'reservation.addLines') {
      C.keys(p, type === 'reservation.create' ? ['id', 'customer', 'lines', 'orderId'] : ['id', 'lines']);
      const rows = C.list(p.lines).map(row => line(state, row));
      const reservation = type === 'reservation.create' ? { id: C.id(p.id), customer: C.customer(p.customer), orderId: p.orderId ? C.id(p.orderId) : null, lines: [], createdAt: context.at } : C.find(state.reservations, p.id);
      if (type === 'reservation.create' && state.reservations.some(r => r.id === reservation.id)) C.fail('ALREADY_EXISTS', '이미 등록된 예약입니다.');
      if (new Set([...reservation.lines, ...rows].map(row => row.id)).size !== reservation.lines.length + rows.length) C.fail('INVALID_INPUT', '예약 품목 관리번호가 중복됩니다.');
      reservation.lines.push(...rows);
      if (type === 'reservation.create') state.reservations.push(reservation);
      return { reservationId: reservation.id };
    }
    if (type === 'reservation.issueDate') {
      C.keys(p, ['id', 'lineIds', 'issueDate']); const r = C.find(state.reservations, p.id); const date = C.date(p.issueDate);
      for (const id of C.ids(p.lineIds)) { const l = C.find(r.lines, id); if (date > l.useDate) C.fail('INVALID_INPUT', '발권 예정일을 확인해 주세요.'); l.issueDate = date; }
      return { reservationId: r.id };
    }
    if (type === 'reservation.time') {
      C.keys(p, ['reservationId', 'lineId', 'startTime', 'endTime']);
      const { reservation, line } = lineOf(state, p.reservationId, p.lineId);
      const rows = active(state, reservation.id, line.id);
      if (rows.some(a => a.fulfilledAt)) C.fail('NO_CHANGE', '이미 전달한 예약의 이용시간은 바꿀 수 없습니다.');
      line.startTime = C.time(p.startTime); line.endTime = C.time(p.endTime);
      if (line.endTime <= line.startTime) C.fail('INVALID_INPUT', '종료 시간을 확인해 주세요.');
      for (const allocation of rows) {
        const preview = { ...state, allocations: state.allocations.filter(a => a.id !== allocation.id) };
        const reason = eligible(preview, C.find(state.assets, allocation.assetId), reservation.id, line.id);
        if (reason) C.fail('TICKET_UNAVAILABLE', reason);
      }
      return { reservationId: reservation.id, lineId: line.id };
    }
    if (type === 'reservation.cancel') {
      C.keys(p, ['reservationId', 'lineId', 'quantity']); const { reservation, line } = lineOf(state, p.reservationId, p.lineId);
      line.cancelledQuantity += C.integer(p.quantity, 1);
      if (line.cancelledQuantity > line.quantity) C.fail('QUANTITY_EXCEEDED', '남은 예약 수량을 초과했습니다.');
      const rows = active(state, reservation.id, line.id).sort((a, b) => Number(!!a.fulfilledAt) - Number(!!b.fulfilledAt) || b.id.localeCompare(a.id));
      rows.slice(0, Math.max(0, rows.length - (line.quantity - line.cancelledQuantity))).forEach(a => release(state, a, context));
      return { reservationId: reservation.id, lineId: line.id };
    }
    if (type === 'reservation.restore') {
      C.keys(p, ['reservationId', 'lineId', 'quantity']); const { reservation, line } = lineOf(state, p.reservationId, p.lineId);
      const quantity = C.integer(p.quantity, 1);
      if (quantity > line.cancelledQuantity) C.fail('QUANTITY_EXCEEDED', '취소한 수량보다 많이 복원할 수 없습니다.');
      line.cancelledQuantity -= quantity;
      // Restoring demand must not revive an allocation now promised to another customer.
      return { reservationId: reservation.id, lineId: line.id };
    }
    if (type === 'ticket.allocate') { C.keys(p, ['reservationId', 'lineId', 'assetIds']); return allocate(state, p, context); }
    if (type === 'ticket.release') {
      C.keys(p, ['allocationIds']); const rows = C.ids(p.allocationIds).map(id => C.find(state.allocations, id));
      for (const a of rows) { if (a.status !== 'active') C.fail('NO_CHANGE', '이미 배정 해제된 권입니다.'); release(state, a, context); }
      return { allocationIds: rows.map(a => a.id) };
    }
    C.fail('INVALID_INPUT', '지원하지 않는 예약 작업입니다.');
  }
  function summary(state, options = {}) {
    C.keys(options, ['date', 'basis']); const date = C.date(options.date), basis = C.oneOf(options.basis || 'use', ['use', 'issue']);
    const rows = [], overdue = [], totals = state.catalog.filter(s => s.kind === 'liftTicket').map(s => ({ ticketType: s.id, label: s.label, reserved: 0, secured: 0, waitingRecovery: 0, needIssue: 0 }));
    for (const reservation of state.reservations) for (const line of reservation.lines) {
      const reserved = line.quantity - line.cancelledQuantity;
      if (!reserved) continue;
      const allocations = active(state, reservation.id, line.id);
      const secured = allocations.filter(a => {
        const asset = C.find(state.assets, a.assetId);
        return !!a.fulfilledAt || (!asset.refundId && asset.location.kind !== 'vendor' && ['shop', 'vehicle'].includes(asset.location.kind));
      }).length;
      const waitingRecovery = allocations.filter(a => !a.fulfilledAt && C.find(state.assets, a.assetId).location.kind === 'customer').length;
      const row = { reservationId: reservation.id, customer: C.copy(reservation.customer), ...C.copy(line), reserved, secured, waitingRecovery, needIssue: Math.max(0, reserved - secured) };
      if (basis === 'issue' && line.issueDate < date && row.needIssue) overdue.push(row);
      if (line[basis === 'use' ? 'useDate' : 'issueDate'] !== date) continue;
      rows.push(row); const total = totals.find(t => t.ticketType === line.ticketType);
      for (const key of ['reserved', 'secured', 'waitingRecovery', 'needIssue']) total[key] += row[key];
    }
    return { date, basis, totals, rows, overdue };
  }
  return { handle, allocate, eligible, lineOf, windowOf, active, summary };
});

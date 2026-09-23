(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'), require('./orders.js'), require('./inventory.js'), require('./reservations.js'));
  else root.SkiWorkflowTicketOperations = factory(root.SkiWorkflowCommon, root.SkiWorkflowOrders, root.SkiWorkflowInventory, root.SkiWorkflowReservations);
})(globalThis, function (C, O, I, B) {
  'use strict';
  const commands = ['tickets.assign', 'tickets.receive', 'tickets.spare', 'tickets.refundDispatch'];
  const shop = state => ({ kind: 'shop', id: state.shopId });
  const completed = allocation => allocation.fulfilledAt && allocation.returnedAt;
  function selected(state, assetIds, context, ready = true) {
    C.store(context);
    return C.ids(assetIds).map(id => {
      const asset = C.find(state.assets, id, '리프트권');
      if (!asset.ticket || asset.condition === 'lost' || ready && asset.condition !== 'ready') C.fail('TICKET_UNAVAILABLE', '실물을 확인한 정상 리프트권을 선택해 주세요. 분실권은 발견 처리가 먼저입니다.');
      if (asset.refundId || asset.exchangeReservationId || asset.orderPreparation) C.fail('DEPENDENT_MOVEMENT', '환불·교환·준비에 연결된 권은 해당 업무를 먼저 확인해 주세요.');
      if (!I.allocationAvailable(state, asset) || state.allocations.some(a => a.assetId === id && a.status === 'active' && !completed(a))) C.fail('TICKET_UNAVAILABLE', '고객에게 배정되거나 아직 회수하지 않은 권입니다. 미지급분은 접수 취소·배달 해제, 지급분은 실제 반납을 먼저 확인하세요.');
      return asset;
    });
  }
  function assign(state, p, context) {
    C.keys(p, ['orderId', 'lineId', 'assetIds', 'startTime', 'endTime']);
    const assets = selected(state, p.assetIds, context), order = C.find(state.orders, p.orderId, '접수'), line = C.find(order.lines, p.lineId, '판매 품목');
    if (line.category !== 'liftTicket') C.fail('INVALID_INPUT', '재배정할 리프트권 판매 품목을 선택해 주세요.');
    if (assets.some(asset => !I.same(asset.location, shop(state)))) C.fail('DEPENDENT_MOVEMENT', '차량에서 실제 매장 입고를 확인한 뒤 재배정해 주세요.');
    const current = C.find(O.view(state, order).lines, line.id), bindings = line.reservationBindings || [];
    if (assets.some(asset => [...current.customerAssetIds, ...current.vehicleAssetIds, ...current.shopAssetIds, ...current.unknownAssetIds].includes(asset.id))) C.fail('INVALID_INPUT', '이 판매행에 이미 지급했던 권입니다. 새 추가 품목이나 다른 접수의 미지급 판매행을 선택하세요.');
    const secured = state.allocations.filter(a => a.status === 'active' && !a.fulfilledAt && bindings.some(b => b.reservationId === a.reservationId && b.lineId === a.lineId)).length;
    if (assets.length > current.unissuedQuantity - secured) C.fail('QUANTITY_EXCEEDED', '이미 발권·배정한 수량을 제외한 미지급 수량을 확인해 주세요.');
    let reservation = state.reservations.find(r => r.id === order.id);
    if (reservation && reservation.orderId !== order.id) C.fail('ALREADY_EXISTS', '다른 예약과 관리번호가 겹칩니다. 연결된 접수를 확인하세요.');
    let sequence = (reservation?.lines.length || 0) + 1, reservationLineId;
    do { reservationLineId = 'reuse-' + (state.revision + 1) + '-' + sequence++; } while (reservation?.lines.some(row => row.id === reservationLineId));
    const ticketType = C.find(state.catalog, line.sku);
    if (ticketType.requiresTypeConfirmation) C.fail('INVALID_INPUT', '접수의 리프트권 권종을 먼저 확인해 주세요.');
    const row = { id: reservationLineId, ticketType: line.sku, quantity: assets.length, useDate: line.start, issueDate: line.start, startTime: C.time(p.startTime), endTime: C.time(p.endTime) };
    const profile = (state.customerProfiles || []).find(row => (row.orderIds || []).includes(order.id));
    B.handle(state, reservation ? 'reservation.addLines' : 'reservation.create', reservation ? { id: order.id, lines: [row] } : { id: order.id, orderId: order.id, customer: { ...C.copy(order.customer), ...(profile?.phone ? { phone: profile.phone } : {}) }, lines: [row] }, context);
    // Returned fulfillment remains a satisfied historical demand. Exclude only
    // those completed uses from overlap checks, never future/unfulfilled claims.
    const preview = { ...state, allocations: state.allocations.filter(a => !completed(a)) };
    for (const asset of assets) {
      if (Date.parse(asset.ticket.validTo) <= Date.parse(context.at)) C.fail('TICKET_UNAVAILABLE', '유효시간이 지난 권은 재배정할 수 없습니다.');
      if (!asset.ticket.transferable && state.movements.some(m => m.assetIds.includes(asset.id) && !(m.reversedAssetIds || []).includes(asset.id) && [m.from, m.to].some(location => location?.kind === 'customer' && location.id !== order.id))) C.fail('TICKET_UNAVAILABLE', '다른 고객이 사용한 양도 불가 권입니다.');
      const reason = B.eligible(preview, asset, order.id, reservationLineId);
      if (reason) C.fail('TICKET_UNAVAILABLE', reason);
      const allocation = { id: 'allocation-' + (state.revision + 1) + '-' + (state.allocations.length + 1), assetId: asset.id, reservationId: order.id, lineId: reservationLineId, status: 'active', createdAt: context.at, fulfilledAt: null, returnedAt: null, source: 'recovered-ticket' };
      state.allocations.push(allocation); preview.allocations.push(allocation); asset.purpose = 'delivery'; asset.lastRevision = state.revision + 1;
    }
    (line.reservationBindings ||= []).push({ reservationId: order.id, lineId: reservationLineId, assetIds: assets.map(a => a.id), quantity: assets.length, source: 'recovered-ticket', at: context.at, actor: C.copy(context.actor) });
    (order.links ||= []); if (!order.links.some(link => link.sourceType === 'reservation' && link.sourceId === order.id)) order.links.push({ sourceType: 'reservation', sourceId: order.id, at: context.at, actor: C.copy(context.actor), historicalMovement: false, custodyMerged: false });
    return { orderId: order.id, lineId: line.id, reservationId: order.id, reservationLineId, assetIds: assets.map(a => a.id), assignedQuantity: assets.length, movedQuantity: 0 };
  }
  function handle(state, type, p, context) {
    C.store(context);
    if (type === 'tickets.assign') return assign(state, p, context);
    if (type === 'tickets.receive') {
      C.keys(p, ['assetIds']); const assets = selected(state, p.assetIds, context, false), groups = new Map();
      for (const asset of assets) {
        if (asset.location.kind !== 'vehicle') C.fail('QUANTITY_EXCEEDED', '차량에 보관 중인 권만 실제 입고 확인할 수 있습니다.');
        groups.set(asset.location.id, [...(groups.get(asset.location.id) || []), asset.id]);
      }
      const movementIds = [];
      for (const [vehicleId, assetIds] of groups) movementIds.push(I.move(state, { kind: 'receive', from: { kind: 'vehicle', id: vehicleId }, to: shop(state), assetIds }, context).movementId);
      return { assetIds: assets.map(a => a.id), receivedQuantity: assets.length, movementIds };
    }
    if (type === 'tickets.spare') {
      C.keys(p, ['assetIds']); const assets = selected(state, p.assetIds, context);
      if (assets.some(a => !['shop', 'vehicle'].includes(a.location.kind))) C.fail('TICKET_UNAVAILABLE', '매장·차량에서 실제 보관 중인 권만 예비 보관할 수 있습니다.');
      if (assets.every(a => a.purpose === 'spare')) C.fail('NO_CHANGE', '이미 예비 보관 중인 권입니다.');
      assets.forEach(a => { a.purpose = 'spare'; a.lastRevision = state.revision + 1; });
      return { assetIds: assets.map(a => a.id), spareQuantity: assets.length, movedQuantity: 0 };
    }
    if (type === 'tickets.refundDispatch') {
      C.keys(p, ['id', 'assetIds', 'vehicleId', 'vendorId', 'date', 'time', 'place']);
      const assets = selected(state, p.assetIds, context), vehicleId = C.id(p.vehicleId);
      if (assets.some(a => !I.same(a.location, shop(state)) && !I.same(a.location, { kind: 'vehicle', id: vehicleId }))) C.fail('DEPENDENT_MOVEMENT', '다른 차량의 권은 매장에 실제 입고한 뒤 담당 차량에 실어 주세요.');
      const result = I.handle(state, 'refund.plan', p, context), loadIds = assets.filter(a => a.location.kind === 'shop').map(a => a.id), movementIds = [];
      if (loadIds.length) movementIds.push(I.move(state, { kind: 'load', from: shop(state), to: { kind: 'vehicle', id: vehicleId }, assetIds: loadIds }, context).movementId);
      return { ...result, loadedQuantity: loadIds.length, movementIds, refundedWon: 0 };
    }
    C.fail('INVALID_INPUT', '지원하지 않는 회수권 작업입니다.');
  }
  return { commands, canHandle: type => commands.includes(type), handle };
});

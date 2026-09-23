(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SkiReturnDemo = factory();
})(globalThis, function () {
  'use strict';
  // Explicit physical quantities; never infer these from usage days or label text.
  function seed(service, today) {
    const rental = { startDate: today, endDate: today, amountWon: 0 };
    const drafts = [
      { id: 'RETURN-DEMO-1', customer: { id: 'DEMO-C-1', name: '반납 체험 고객' }, vehicleId: 'demo-van-1', items: [
        { id: 'ski', label: '스키', category: 'equipment', unit: '세트', plannedQuantity: 2 },
        { id: 'clothes', label: '의류', category: 'clothing', unit: '벌', plannedQuantity: 2 },
        { id: 'ticket', label: '리프트권', category: 'liftTicket', unit: '매', plannedQuantity: 2 }
      ] },
      { id: 'RETURN-DEMO-2', customer: { id: 'DEMO-C-2', name: '리프트권 단독 체험 고객' }, items: [
        { id: 'ticket', label: '리프트권', category: 'liftTicket', unit: '매', plannedQuantity: 4 }
      ] }
    ];
    for (const draft of drafts) {
      const { id, ...payload } = draft;
      try { service.get(id); continue; } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
      service.execute({ type: 'create', orderId: id, requestId: id + '-create', expectedVersion: 0, payload: { ...payload, rental } });
      service.execute({ type: 'issue', orderId: id, requestId: id + '-issue', expectedVersion: 1, payload: { items: draft.items.map(item => ({ itemId: item.id, quantity: item.plannedQuantity })) } });
    }
    return drafts.map(draft => draft.id);
  }
  function seedOperations(store, driver, orders) {
    const itemIds = { '스키': 'ski', '보드': 'board', '의류': 'clothes', '헬멧': 'helmet', '고글': 'goggles', '보호대': 'pads', '바이저 헬멧': 'visor' };
    for (const order of orders) {
      const returnPlan = { method: order.method === '차량 수거' ? 'vehicle' : 'direct', date: order.due, time: order.time || null, slot: order.slot, place: order.place };
      const equipment = order.items.map(([label, quantity], index) => ({ id: itemIds[label] || 'gear-' + index, label, category: label === '의류' ? 'clothing' : 'equipment', plannedQuantity: quantity, returnPlan }));
      const tickets = (order.ticketItems || []).map(ticket => ({ id: ticket.id, label: ticket.label, category: 'liftTicket', unit: '매', plannedQuantity: ticket.quantity, returnPlan: { method: 'direct', date: ticket.date, place: '매장' }, usage: [{ date: ticket.date, quantity: ticket.quantity }] }));
      const items = [...equipment, ...tickets];
      if (!items.length) continue;
      const pickupPlan = order.pickupPlan || (order.pickupMethod === 'delivery' ? Object.fromEntries(['equipment', 'liftTicket'].map(category => [category, { method: 'delivery', date: order.pickup, time: order.pickupTime, place: order.deliveryPlace, vehicleId: 'demo-van-1' }])) : undefined);
      let current = store.execute({ type: 'create', orderId: order.id, requestId: order.id + '-create', expectedVersion: 0, payload: { customer: { id: order.customer, name: order.name, phone: order.phone }, rental: { startDate: order.start, endDate: order.end, amountWon: order.amount }, vehicleId: 'demo-van-1', ...(pickupPlan ? { pickupPlan } : {}), returnPlan, items } }).order;
      const issue = [...equipment.filter(() => order.issued > 0).map(item => ({ itemId: item.id, quantity: item.plannedQuantity })), ...(order.ticketItems || []).filter(ticket => ticket.issued > 0).map(ticket => ({ itemId: ticket.id, quantity: ticket.issued }))];
      const command = (type, payload, client = store) => { current = client.execute({ type, orderId: order.id, requestId: order.id + '-' + type, expectedVersion: current.version, payload }).order; };
      if (issue.length) command('issue', { items: issue });
      const received = order.items.flatMap(([label,,returned], index) => returned ? [{ itemId: equipment[index].id, quantity: returned }] : []);
      if (received.length) command('receiveDirect', { items: received });
      if (order.collected) command('collect', { items: equipment.map(item => ({ itemId: item.id, quantity: item.plannedQuantity })) }, driver);
    }
    return orders.map(order => order.id);
  }
  return { seed, seedOperations };
});

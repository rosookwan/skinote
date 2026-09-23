(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./service.js'), require('./client.js'), require('./common.js'), require('./domain.js'));
  else root.SkiWorkflowDemo = factory(root.SkiWorkflowService, root.SkiWorkflowClient, root.SkiWorkflowCommon, root.SkiWorkflows);
})(globalThis, function (Service, Client, C, W) {
  'use strict';
  // One physical ledger for the page. Old return records are imported once;
  // their counters are never added to the vehicle ledger or mutated afterwards.
  function create(repository, today) {
    const shopId = 'demo-shop', vehicleId = 'demo-van-1', clock = () => today + 'T00:00:00.000Z';
    const shop = { kind: 'shop', id: shopId }, van = { kind: 'vehicle', id: vehicleId };
    const store = Service.createService(repository, { shopId, actor: { id: 'demo-store', role: 'store' } }, clock);
    const driver = Service.createService(repository, { shopId, actor: { id: 'demo-driver', role: 'driver', vehicleId } }, clock);
    const orders = new Map(), tokens = new Map();
    const snap = () => store.snapshot();
    const run = (type, payload, role = 'store') => (role === 'driver' ? driver : store).execute(Client.newCommand(type, snap(), payload));
    function atomic(apply, role = 'store') {
      const actor = role === 'driver' ? { id: 'demo-driver', role, vehicleId } : { id: 'demo-store', role: 'store' };
      let value;
      repository.transactWorkflows(shopId, (previous, notifications) => {
        let state = previous, last;
        value = apply((type, payload) => {
          last = W.execute(state, Client.newCommand(type, state.revision, payload), { shopId, actor, at: clock() });
          Service.project(notifications, last); state = last.state; return last.result;
        });
        return last;
      });
      return value;
    }
    const assets = ids => snap().assets.filter(a => ids.includes(a.id));
    const customerIds = id => [id, ...(orders.get(id)?.bindings.flatMap(b => b.reservationIds || []) || [])];
    function returnCustomer(id, ids) {
      const held = assets(ids); if (held.some(a => a.location.kind !== 'customer' || !customerIds(id).includes(a.location.id))) throw new Error('이 고객의 보유 물품을 확인해 주세요.');
      atomic(commit => { for (const owner of new Set(held.map(a => a.location.id))) commit('stock.move', { kind: 'directReturn', from: { kind: 'customer', id: owner }, to: shop, assetIds: held.filter(a => a.location.id === owner).map(a => a.id) }); });
    }
    const ticket = (date, sku, from = '00:00', to = '23:59', reusable = false) => ({ validFrom: date + 'T' + from + ':00+09:00', validTo: date + 'T' + to + ':59+09:00', acceptedTypes: reusable ? ['ticket-3h', 'ticket-4h', 'ticket-6h'] : [sku], transferable: reusable, vendorId: 'resort' });
    const open = (sku, quantity, location = shop, extra = {}) => quantity ? run('stock.opening', { sku, quantity, location, ...extra }).assetIds : [];
    const remaining = task => {
      const history = store.history().movements;
      const refund = snap().refunds.find(r => r.id === task.refundId);
      return task.assetIds.filter(id => !(task.fulfilledElsewhereAssetIds || []).includes(id) && !refund?.cancelledAssetIds.includes(id) && !history.some(m => (m.taskId === task.id || (task.refundId && m.refundId === task.refundId)) && m.assetIds.includes(id) && !m.reversedAssetIds.includes(id)));
    };
    const remainingQuantity = task => remaining(task).length + W.dispatch.unassigned(task);
    function saveTask(payload) { return run('task.save', { vehicleId, date: today, time: '16:30', place: '만선 광장', ...payload }); }
    function importOrder(order, initial = false) {
      if (orders.has(order.id)) { planDeliveries(orders.get(order.id)); return; }
      const copy = C.copy(order); copy.bindings = [];
      for (const item of copy.items) {
        let sku = item.id === 'clothes' ? 'clothing' : item.id;
        if (item.category === 'liftTicket') sku = 'legacy-' + item.id;
        if (!snap().catalog.some(s => s.id === sku)) run('catalog.add', { id: sku, label: item.label, kind: item.category === 'liftTicket' ? 'liftTicket' : item.category === 'clothing' ? 'clothing' : item.label.includes('헬멧') ? 'helmet' : 'equipment', unit: item.unit || '개', ...(item.category === 'liftTicket' ? { hours: 4 } : {}) });
        const meta = { itemId: item.id, sku, assetIds: [], initialVehicleAssetIds: [], stagedAssetIds: [], item: C.copy(item) };
        if (initial) for (const [location, quantity] of [[{ kind: 'customer', id: order.id }, item.customerQuantity], [van, item.vehicleQuantity], [shop, item.shopQuantity]]) {
          const ids = open(sku, quantity, location, { sourceReference: 'legacy:' + order.id + ':' + item.id + ':' + location.kind, ...(item.category === 'liftTicket' ? { ticket: ticket(item.returnPlan.date, sku) } : {}) }); meta.assetIds.push(...ids); if (location.kind === 'vehicle') meta.initialVehicleAssetIds.push(...ids);
        }
        copy.bindings.push(meta);
      }
      orders.set(order.id, copy);
      for (const [i, binding] of copy.bindings.entries()) {
        const plan = binding.item.returnPlan;
        const ids = assets(binding.assetIds).filter(a => a.location.kind === 'customer').map(a => a.id);
        if (ids.length && plan.method === 'vehicle') saveTask({ id: order.id + '-collect-' + i, kind: 'collection', customerId: order.id, title: order.customer.name + ' 수거', date: plan.date, time: plan.time || '16:30', place: plan.place || '만선 광장', orderId: order.id, assetIds: ids });
      }
      // Merge same-visit equipment into a single visible task, with stable IDs.
      const groups = new Map();
      for (const t of snap().tasks.filter(t => t.orderId === order.id)) {
        const key = [t.date, t.time, t.place].join('|');
        if (groups.has(key)) { const previous = groups.get(key); saveTask({ ...taskPayload(previous), assetIds: [...previous.assetIds, ...t.assetIds] }); previous.assetIds.push(...t.assetIds); run('task.status', { id: t.id, status: 'cancelled' }); }
        else groups.set(key, C.copy(t));
      }
      planDeliveries(copy);
    }
    function planDeliveries(order) {
      for (const category of ['equipment', 'liftTicket']) {
        const plan = order.pickupPlan?.[category]; if (plan?.method !== 'delivery') continue;
        const id = order.id + '-delivery-' + category;
        if (snap().tasks.some(t => t.id === id)) continue;
        const plannedItems = order.bindings.filter(b => (b.item.category === 'liftTicket') === (category === 'liftTicket')).flatMap(b => {
          const quantity = b.item.plannedQuantity - b.assetIds.length;
          return quantity > 0 ? [{ itemId: b.itemId, sku: b.sku, quantity }] : [];
        });
        if (plannedItems.length) saveTask({ id, kind: 'delivery', customerId: order.id, orderId: order.id, vehicleId: plan.vehicleId, date: plan.date, time: plan.time, place: plan.place, title: order.customer.name + (category === 'equipment' ? ' 장비 배달' : ' 리프트권 배달'), plannedItems });
      }
    }
    function taskPayload(t) { return Object.fromEntries(['id', 'kind', 'vehicleId', 'date', 'time', 'place', 'customerId', 'title', 'orderId', 'reservationId', 'assetIds'].filter(k => t[k] != null).map(k => [k, t[k]])); }
    function projectOrder(id) {
      const state = snap(), movements = store.history().movements;
      let order = orders.get(id);
      if (!order) {
        const owner = state.forms.find(f => f.id === id) || state.reservations.find(r => r.id === id);
        const replacedNew = (state.exchanges || []).filter(x => x.orderId === id && x.status !== 'cancelled').flatMap(x => x.units.map(u => u.newAssetId));
        const issuedIds = [...new Set(movements.filter(m => m.kind === 'deliver' && m.to.id === id).flatMap(m => m.assetIds.filter(a => !m.reversedAssetIds.includes(a) && !replacedNew.includes(a))))];
        if (!owner || !issuedIds.length) return null;
        const bindings = state.catalog.flatMap(sku => {
          const assetIds = state.assets.filter(a => issuedIds.includes(a.id) && a.sku === sku.id).map(a => a.id);
          return assetIds.length ? [{ sku: sku.id, assetIds, stagedAssetIds: [], initialVehicleAssetIds: [], item: { id: sku.id, label: sku.label, category: sku.kind === 'liftTicket' ? 'liftTicket' : 'equipment', plannedQuantity: assetIds.length } }] : [];
        });
        order = { id, customer: owner.customer, bindings };
      }
      order = { ...order, bindings: C.copy(order.bindings) };
      const exchanges = (state.exchanges || []).filter(x => x.orderId === id);
      const exchangeOpenQuantity = exchanges.filter(x => x.status !== 'cancelled').reduce((n, x) => n + x.units.filter(u => !u.deliveredAt || !u.receivedAt).length, 0);
      for (const x of exchanges.filter(x => W.exchanges.kinds[x.kind].component)) {
        const known = order.bindings.flatMap(b => b.assetIds);
        const ids = x.units.map(u => u.oldAssetId).filter(a => !known.includes(a) && !exchanges.some(y => y.units.some(u => u.newAssetId === a)));
        if (ids.length) order.bindings.push({ itemId: x.id, sku: x.sku, assetIds: ids, stagedAssetIds: [], initialVehicleAssetIds: [], item: { id: x.id, label: W.exchanges.kinds[x.kind].label, category: 'component', component: true, plannedQuantity: ids.length, returnPlan: x.returnPlan } });
      }
      const items = order.bindings.map(b => {
        const stagedIssued = (b.stagedAssetIds || []).filter(id => movements.some(m => m.kind === 'deliver' && m.to.id === order.id && m.assetIds.includes(id) && !m.reversedAssetIds.includes(id)));
        const tracked = [...new Set([...b.assetIds, ...stagedIssued].map(a => W.exchanges.resolve(state, a, id)))];
        const exchangePendingQuantity = tracked.filter(a => W.exchanges.pending(state, a, id)).length;
        b.assetIds = b.assetIds.map(a => W.exchanges.resolve(state, a, id)); b.stagedAssetIds = (b.stagedAssetIds || []).map(a => W.exchanges.resolve(state, a, id));
        const rows = state.assets.filter(a => tracked.includes(a.id) && !W.exchanges.pending(state, a.id, id));
        const customerQuantity = rows.filter(a => a.location.kind === 'customer' && [id, ...(b.reservationIds || [])].includes(a.location.id)).length;
        const vehicleQuantity = rows.filter(a => {
          if (a.location.kind !== 'vehicle') return false;
          const history = movements.filter(m => m.assetIds.includes(a.id) && !m.reversedAssetIds.includes(a.id));
          const collection = history.filter(m => m.kind === 'collect' && customerIds(id).includes(m.from.id)).at(-1) || (b.initialVehicleAssetIds.includes(a.id) ? history.find(m => m.kind === 'stock.opening') : null);
          return !!collection && !history.some(m => m.revision > collection.revision && ['receive', 'deliver'].includes(m.kind));
        }).length;
        return { ...b.item, exchangePendingQuantity, issuedQuantity: tracked.length, unissuedQuantity: Math.max(0, b.item.plannedQuantity - tracked.length), customerQuantity, vehicleQuantity, shopQuantity: rows.length - customerQuantity - vehicleQuantity, returnTarget: tracked.length };
      });
      const total = key => items.reduce((n, i) => n + i[key], 0);
      const status = exchangeOpenQuantity ? 'awaiting_exchange' : total('customerQuantity') ? total('shopQuantity') || total('vehicleQuantity') ? 'partial_return' : 'in_use' : total('vehicleQuantity') ? 'awaiting_shop' : total('unissuedQuantity') ? 'awaiting_issue' : 'returned';
      return { ...order, items, exchangeOpenQuantity, status, complete: status === 'returned', totals: { exchangePendingQuantity: total('exchangePendingQuantity'), customerQuantity: total('customerQuantity'), vehicleQuantity: total('vehicleQuantity'), shopQuantity: total('shopQuantity'), unissuedQuantity: total('unissuedQuantity') } };
    }
    function issueOrder(id) {
      const order = orders.get(id); if (!order) throw new Error('접수를 찾을 수 없습니다.');
      if (order.pickupPlan?.equipment?.method === 'delivery') throw new Error('배달 예정 장비는 장비 배달완료에서 실제 전달 수량을 확인해 주세요.');
      const plan = [];
      for (const b of order.bindings) {
        const quantity = b.item.plannedQuantity - b.assetIds.length - (b.stagedAssetIds || []).length; if (!quantity) continue;
        if (b.item.category === 'liftTicket') continue;
        const used = plan.flatMap(p => p.ids);
        const reserved = snap().tasks.filter(t => t.kind === 'delivery' && ['waiting', 'in_progress'].includes(t.status)).flatMap(remaining);
        const ids = snap().assets.filter(a => a.sku === b.sku && a.location.kind === 'shop' && W.exchanges.healthy(a) && !a.componentBaseId && !used.includes(a.id) && !reserved.includes(a.id)).slice(0, quantity).map(a => a.id);
        if (ids.length !== quantity) throw new Error(b.item.label + ' 매장 재고가 부족합니다.');
        plan.push({ b, ids });
      }
      if (!plan.length) throw new Error('지급할 물품이 없습니다.');
      run('stock.move', { kind: 'deliver', from: shop, to: { kind: 'customer', id }, assetIds: plan.flatMap(p => p.ids) });
      plan.forEach(p => p.b.assetIds.push(...p.ids));
      for (const [i, p] of plan.entries()) if (p.b.item.returnPlan.method === 'vehicle') { const rp = p.b.item.returnPlan; saveTask({ id: id + '-issued-' + i, kind: 'collection', customerId: id, title: order.customer.name + ' 수거', orderId: id, date: rp.date, time: rp.time || '16:30', place: rp.place || '만선 광장', assetIds: p.ids }); }
    }
    function dispatchOrder(id, details) {
      const task = deliveryTasks(id, 'equipment')[0];
      if (task) return loadDelivery(task.id);
      throw new Error('접수의 장비 배달 예정 정보를 확인해 주세요.');
    }
    const deliveryTasks = (id, category) => snap().tasks.filter(t => !t.exchangeId && t.orderId === id && t.kind === 'delivery' && t.plannedItems && ['waiting', 'in_progress'].includes(t.status) && t.plannedItems.every(i => (snap().catalog.find(s => s.id === i.sku)?.kind === 'liftTicket') === (category === 'liftTicket')));
    function deliveryCandidates(id, category) {
      const state = snap(), used = new Set(), reserved = new Set(state.tasks.filter(t => t.kind === 'delivery' && ['waiting', 'in_progress'].includes(t.status)).flatMap(remaining));
      return deliveryTasks(id, category).flatMap(task => task.plannedItems.flatMap(item => {
        const held = assets(remaining(task).filter(id => item.assetIds.includes(id))).filter(a => a.location.kind === 'shop' || a.location.kind === 'vehicle' && a.location.id === task.vehicleId);
        const available = category === 'liftTicket' ? [] : state.assets.filter(a => a.sku === item.sku && a.location.kind === 'shop' && W.exchanges.healthy(a) && !a.componentBaseId && !reserved.has(a.id) && !used.has(a.id)).slice(0, item.quantity - item.assetIds.length);
        available.forEach(a => used.add(a.id));
        return [...held, ...available].map(a => ({ ...a, taskId: task.id, itemId: item.itemId, needsAssignment: !item.assetIds.includes(a.id) }));
      }));
    }
    function scheduleCollection(commit, order, itemId, ids) {
      const binding = order.bindings.find(b => b.itemId === itemId), plan = binding.item.returnPlan;
      if (plan.method === 'vehicle') commit('task.save', { id: Client.randomId('order-collect-'), kind: 'collection', customerId: order.id, orderId: order.id, vehicleId: order.vehicleId || vehicleId, date: plan.date, time: plan.time || '16:30', place: plan.place || '만선 광장', title: order.customer.name + ' 수거', assetIds: ids });
    }
    function assignCandidates(commit, order, rows) {
      for (const taskId of new Set(rows.map(a => a.taskId))) {
        const selected = rows.filter(a => a.taskId === taskId && a.needsAssignment);
        const items = [...new Set(selected.map(a => a.itemId))].map(itemId => ({ itemId, assetIds: selected.filter(a => a.itemId === itemId).map(a => a.id) }));
        if (items.length) commit('task.allocate', { id: taskId, items });
        for (const item of items) scheduleCollection(commit, order, item.itemId, item.assetIds);
      }
    }
    function rememberCandidates(order, rows) {
      for (const a of rows.filter(a => a.needsAssignment)) order.bindings.find(b => b.itemId === a.itemId).stagedAssetIds.push(a.id);
    }
    function loadDelivery(taskId) {
      const task = snap().tasks.find(t => t.id === taskId);
      if (!task?.plannedItems || !['waiting', 'in_progress'].includes(task.status)) throw new Error('배달 예정 업무를 확인해 주세요.');
      if (task.exchangeId) { const ids = assets(remaining(task)).filter(a => a.location.kind === 'shop').map(a => a.id); if (!ids.length) throw new Error('장비교환 화면에서 교환품을 먼저 준비해 주세요.'); return run('stock.move', { kind: 'load', from: shop, to: { kind: 'vehicle', id: task.vehicleId }, assetIds: ids, purpose: 'delivery' }); }
      const category = task.plannedItems.every(i => snap().catalog.find(s => s.id === i.sku).kind === 'liftTicket') ? 'liftTicket' : 'equipment';
      const order = orders.get(task.orderId), rows = deliveryCandidates(order.id, category).filter(a => a.taskId === taskId && a.location.kind === 'shop');
      if (!rows.length) throw new Error(category === 'liftTicket' ? '발권한 리프트권이 없습니다. 먼저 발권·준비해 주세요.' : '새로 실을 매장 장비가 없습니다. 재고를 확인해 주세요.');
      atomic(commit => { assignCandidates(commit, order, rows); commit('stock.move', { kind: 'load', from: shop, to: { kind: 'vehicle', id: task.vehicleId }, assetIds: rows.map(a => a.id), purpose: 'delivery', taskId: task.id }); });
      rememberCandidates(order, rows);
    }
    function completeDelivery(id, category, assetIds) {
      C.oneOf(category, ['equipment', 'liftTicket']); C.ids(assetIds);
      const order = orders.get(id), candidates = deliveryCandidates(id, category), rows = assetIds.map(id => candidates.find(a => a.id === id));
      if (rows.some(a => !a)) throw new Error('전달할 물품이 변경됐습니다. 수량을 다시 확인해 주세요.');
      atomic(commit => {
        assignCandidates(commit, order, rows);
        for (const task of deliveryTasks(id, category)) {
          const selected = rows.filter(a => a.taskId === task.id);
          for (const key of new Set(selected.map(a => a.location.kind + ':' + a.location.id))) {
            const group = selected.filter(a => a.location.kind + ':' + a.location.id === key);
            commit('stock.move', { kind: 'deliver', from: group[0].location, to: { kind: 'customer', id }, assetIds: group.map(a => a.id), taskId: task.id });
          }
          if (selected.length && selected.length === remainingQuantity(task)) commit('task.status', { id: task.id, status: 'completed' });
        }
      });
      rememberCandidates(order, rows);
    }
    function issueLegacyTicket(orderId, itemId, values) {
      const order = orders.get(orderId), binding = order.bindings.find(b => b.itemId === itemId);
      if (!binding || binding.item.category !== 'liftTicket' || !Number.isInteger(values.quantity) || values.quantity < 1 || values.quantity > binding.item.plannedQuantity - binding.assetIds.length - binding.stagedAssetIds.length) throw new Error('접수의 남은 리프트권 발권 수량을 확인해 주세요.');
      const task = deliveryTasks(orderId, 'liftTicket').find(t => t.plannedItems.some(i => i.itemId === itemId));
      const local = at => new Date(Date.parse(at) + 9 * 3600000).toISOString();
      const start = local(values.ticket.validFrom), end = local(values.ticket.validTo), reservationId = task ? orderId : Client.randomId('legacy-book-'), lineId = Client.randomId('line-');
      const ids = atomic(commit => {
        const lines = [{ id: lineId, ticketType: values.sku, quantity: values.quantity, useDate: start.slice(0, 10), startTime: start.slice(11, 16), endTime: end.slice(11, 16) }];
        if (snap().reservations.some(r => r.id === reservationId)) commit('reservation.addLines', { id: reservationId, lines });
        else commit('reservation.create', { id: reservationId, customer: { name: order.customer.name, phone: order.customer.phone }, orderId, lines });
        const issued = commit('ticket.issue', { ...values, reservationId, lineId });
        if (task) {
          commit('task.allocate', { id: task.id, items: [{ itemId, assetIds: issued.assetIds }] });
          scheduleCollection(commit, order, itemId, issued.assetIds);
        } else commit('stock.move', { kind: 'deliver', from: shop, to: { kind: 'customer', id: reservationId }, assetIds: issued.assetIds });
        return issued.assetIds;
      });
      (task ? binding.stagedAssetIds : binding.assetIds).push(...ids); (binding.reservationIds ||= []).push(reservationId);
    }
    async function createForm(payload) {
      const envelope = await Client.newIntakeCommand(snap(), { id: Client.randomId('form-'), date: today, expiresAt: C.nextDate(C.nextDate(today)) + 'T14:59:59.000Z', ...payload });
      store.execute(envelope.command); tokens.set(envelope.command.payload.id, envelope.accessToken); return envelope.command.payload.id;
    }
    const guest = id => ({ get: () => Service.publicRequest(repository, { shopId, formId: id, accessToken: tokens.get(id) }, null, clock),
      submit: command => Service.publicRequest(repository, { shopId, formId: id, accessToken: tokens.get(id) }, command, clock) });
    async function seed(initialOrders) {
      initialOrders.forEach(o => importOrder(o, true));
      for (const [sku, quantity] of [['ski', 40], ['board', 30], ['clothing', 40], ['helmet', 30]]) open(sku, quantity, shop, { sourceReference: 'demo-pool-' + sku });
      for (const [sku, quantity] of [['ticket-3h', 2], ['ticket-4h', 5], ['ticket-6h', 3]]) {
        const ids = open(sku, quantity + 5, shop, { ticket: ticket(today, sku), sourceReference: 'demo-tickets-' + sku });
        run('stock.move', { kind: 'load', from: shop, to: van, assetIds: ids.slice(0, quantity), purpose: 'spare' });
      }
      for (const [id, name, startTime, endTime] of [['morning', '오전 김민재', '09:00', '12:00'], ['afternoon', '오후 박서윤', '12:00', '15:00']]) run('reservation.create', { id, customer: { name, phone: id === 'morning' ? '010-1111-1111' : '010-2222-2222' }, lines: [{ id: 'line', useDate: today, ticketType: 'ticket-4h', quantity: 2, startTime, endTime }] });
      const reuse = open('ticket-6h', 2, shop, { ticket: ticket(today, 'ticket-6h', '09:00', '15:00', true), sourceReference: 'demo-reuse' });
      run('ticket.allocate', { reservationId: 'morning', lineId: 'line', assetIds: reuse });
      const skis = open('ski', 2, shop, { sourceReference: 'demo-morning-ski' });
      run('stock.move', { kind: 'deliver', from: shop, to: { kind: 'customer', id: 'morning' }, assetIds: [...reuse, ...skis] });
      run('ticket.allocate', { reservationId: 'afternoon', lineId: 'line', assetIds: reuse });
      saveTask({ id: 'morning-collect', kind: 'collection', customerId: 'morning', title: '김민재 장비·권 수거', time: '12:00', assetIds: [...reuse, ...skis] });
      saveTask({ id: 'afternoon-deliver', kind: 'delivery', customerId: 'afternoon', title: '박서윤 리프트권 전달', time: '12:15', assetIds: reuse });
      run('reservation.create', { id: 'tomorrow-booking', customer: { name: '홍길동', phone: '010-1111-2222' }, lines: [
        { id: 'three', useDate: C.nextDate(today), ticketType: 'ticket-3h', quantity: 4, startTime: '09:00', endTime: '12:00' }, { id: 'four', useDate: C.nextDate(today), ticketType: 'ticket-4h', quantity: 3, startTime: '09:00', endTime: '13:00' }, { id: 'six', useDate: C.nextDate(C.nextDate(today)), ticketType: 'ticket-6h', quantity: 2, startTime: '09:00', endTime: '15:00' }
      ] });
      const ids = snap().assets.filter(a => a.sku === 'ticket-4h' && a.location.kind === 'vehicle').slice(0, 2).map(a => a.id);
      run('refund.plan', { id: 'demo-refund', assetIds: ids, vehicleId, vendorId: 'resort', date: today, time: '13:00', place: '리조트 매표소' });
      for (const [name, count] of [['박서윤', 3], ['홍길동', 21]]) {
        const id = await createForm({ customer: { name, phone: name === '박서윤' ? '010-2222-2222' : '010-1111-2222' }, expectedPeople: count, delivery: { date: today, time: '14:00', place: '설천 주차장', vehicleId } });
        run('intake.submit', { id, status: 'submitted', people: Array.from({ length: count }, (_, i) => ({ id: 'person-' + (i + 1), name: i ? '일행 ' + (i + 1) : name, equipment: i % 3 ? 'ski' : 'board', heightCm: 167 + i % 10, footMm: 240 + i % 5 * 5, clothing: i % 2 === 0, clothingSize: 'M', helmet: i % 2 === 0 })) });
      }
      // Seed assignments are not unread messages; the original priority remains.
      repository.transactNotifications(shopId, notices => { notices.records = notices.records.filter(n => !['workflow-task', 'load', 'intake-submitted'].includes(n.type)); });
    }
    return { shopId, vehicleId, shop, van, store, driver, snap, run, atomic, assets, ticket, remaining, remainingQuantity, saveTask, taskPayload, importOrder, projectOrder, issueOrder, issueLegacyTicket, dispatchOrder, deliveryTasks, deliveryCandidates, completeDelivery, loadDelivery, customerIds, returnCustomer, orders, tokens, createForm, guest, seed };
  }
  return { create };
});

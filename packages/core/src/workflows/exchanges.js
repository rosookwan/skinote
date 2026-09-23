(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'), require('./inventory.js'), require('./dispatch.js'));
  else root.SkiWorkflowExchanges = factory(root.SkiWorkflowCommon, root.SkiWorkflowInventory, root.SkiWorkflowDispatch);
})(globalThis, function (C, I, D) {
  'use strict';
  const kinds = {
    ski: { label: '스키', unit: '대', parent: 'ski' },
    'ski-boots': { label: '스키부츠', unit: '개', parent: 'ski', component: true },
    poles: { label: '폴대', unit: '개', parent: 'ski', component: true },
    board: { label: '보드', unit: '대', parent: 'board' },
    'board-boots': { label: '보드부츠', unit: '개', parent: 'board', component: true },
    'exchange-other': { label: '기타', unit: '개', component: true }
  };
  const reasons = { damage: '파손 교체', size: '사이즈 변경', other: '기타' };
  const active = x => x.status !== 'cancelled';
  const rows = state => state.exchanges || [];
  const healthy = a => a.condition === 'ready' && !a.exchangeReservationId;
  function resolve(state, id, orderId) {
    const seen = new Set();
    while (!seen.has(id)) {
      seen.add(id);
      const unit = rows(state).filter(x => active(x) && (!orderId || x.orderId === orderId)).flatMap(x => x.units).find(u => u.oldAssetId === id && u.deliveredAt);
      if (!unit) break; id = unit.newAssetId;
    }
    return id;
  }
  function pending(state, id, orderId) { return rows(state).filter(x => active(x) && (!orderId || x.orderId === orderId)).some(x => x.units.some(u => u.oldAssetId === id && !u.deliveredAt)); }
  function plan(value) {
    C.keys(value, ['method', 'date', 'time', 'place', 'vehicleId']);
    const method = C.oneOf(value.method, ['direct', 'vehicle']);
    return { method, date: C.date(value.date), time: C.time(value.time), place: C.string(value.place), vehicleId: C.id(value.vehicleId) };
  }
  function summary(x) {
    const k = kinds[x.kind];
    return '장비교환 · ' + k.label + ' ' + x.units.length + k.unit + ' · ' + reasons[x.reason] + (x.oldSize || x.newSize ? ' (' + (x.oldSize || '미기록') + ' → ' + (x.newSize || '미기록') + ')' : '') + (x.memo ? ' · ' + x.memo : '');
  }
  function task(state, x, side, context, ids = []) {
    const next = { id: x.id + '-' + side, kind: side === 'new' ? 'delivery' : 'collection', vehicleId: x.visit.vehicleId,
      date: x.visit.date, time: x.visit.time, place: x.visit.place, customerId: x.customerId, orderId: x.orderId, title: (x.customerName + ' · ' + summary(x)).slice(0, 100), assetIds: ids };
    if (side === 'new') next.plannedItems = [{ itemId: x.kind, sku: x.sku, quantity: x.units.length }];
    D.handle(state, 'task.save', next, context);
    const created = C.find(state.tasks, next.id); created.exchangeId = x.id; created.exchangeSide = side; created.memo = summary(x) + (side === 'new' ? ' · 새 장비 전달' : ' · 기존 장비 회수');
    return created;
  }
  function handle(state, type, p, context) {
    C.store(context); state.exchanges ||= [];
    if (type === 'exchange.request') {
      C.keys(p, ['id', 'orderId', 'customerId', 'customerName', 'kind', 'baseAssetIds', 'reason', 'oldSize', 'newSize', 'memo', 'method', 'visit', 'returnPlan', 'confirmExistingComponent']);
      const id = C.id(p.id); if (rows(state).some(x => x.id === id)) C.fail('ALREADY_EXISTS', '이미 등록한 교환 요청입니다.');
      const kind = C.oneOf(p.kind, Object.keys(kinds)), k = kinds[kind], customerId = C.id(p.customerId);
      if (p.orderId !== customerId && !state.forms.some(f => f.id === customerId && f.orderId === p.orderId)) C.fail('INVALID_INPUT', '교환 요청의 고객과 대여 접수가 다릅니다.');
      const bases = C.ids(p.baseAssetIds).map(id => C.find(state.assets, id));
      if (bases.some(a => a.location.kind !== 'customer' || a.location.id !== customerId || a.exchangeReservationId || (k.parent ? a.sku !== k.parent : !['ski', 'board'].includes(a.sku)))) C.fail('INVALID_INPUT', '현재 고객이 대여 중인 해당 장비를 선택해 주세요.');
      if (k.component && p.confirmExistingComponent !== true) C.fail('INVALID_INPUT', '대여 세트에 포함된 기존 구성품을 확인해 주세요.');
      const x = { id, orderId: C.id(p.orderId), customerId, customerName: C.string(p.customerName, 60), kind, sku: kind, reason: C.oneOf(p.reason, Object.keys(reasons)),
        oldSize: C.string(p.oldSize, 24, true), newSize: C.string(p.newSize, 24, true), memo: C.string(p.memo, 200, true), method: C.oneOf(p.method, ['shop', 'vehicle']),
        visit: plan(p.visit), returnPlan: plan(p.returnPlan), status: 'open', units: [], createdAt: context.at, createdRevision: state.revision + 1, actor: C.copy(context.actor) };
      if ((kind === 'exchange-other' || x.reason === 'other') && !x.memo) C.fail('INVALID_INPUT', '기타 품목·사유는 메모에 내용을 적어 주세요.');
      if (kind !== 'exchange-other' && (!x.oldSize || !x.newSize)) C.fail('INVALID_INPUT', '기존 규격과 새 규격을 입력해 주세요.');
      if (!state.catalog.some(s => s.id === kind)) state.catalog.push({ id: kind, label: k.label, kind: 'equipment', unit: k.unit, component: true });
      for (const base of bases) {
        if (rows(state).filter(active).some(e => e.kind === kind && e.units.some(u => resolve(state, u.baseAssetId, x.orderId) === base.id && (!u.deliveredAt || !u.receivedAt)))) C.fail('ALREADY_EXISTS', '해당 장비의 같은 품목 교환이 아직 진행 중입니다.');
        let old = base;
        if (k.component) {
          old = state.assets.find(a => a.componentBaseId && resolve(state, a.componentBaseId, x.orderId) === base.id && a.sku === kind && !a.exchangeReservationId && a.location.kind === 'customer' && a.location.id === customerId);
          if (!old) {
            const opened = I.handle(state, 'stock.opening', { sku: kind, quantity: 1, location: { kind: 'customer', id: customerId }, sourceReference: 'component-confirmation:' + id + ':' + base.id }, context);
            old = C.find(state.assets, opened.assetIds[0]); old.id = 'component-' + (state.revision + 1) + '-' + (x.units.length + 1); C.find(state.movements, opened.movementId).assetIds = [old.id]; old.componentBaseId = base.id;
            C.find(state.movements, opened.movementId).exchangeId = id;
          }
        }
        if (old.exchangeReservationId) C.fail('ALREADY_EXISTS', '이미 교환 요청에 연결된 물품입니다.');
        if (old.size && old.size !== x.oldSize) C.fail('INVALID_INPUT', '기록된 기존 규격과 다릅니다. 물품을 다시 확인해 주세요.');
        const savedPlans = [];
        for (const t of state.tasks.filter(t => t.kind === 'collection' && !t.exchangeId && ['waiting', 'in_progress'].includes(t.status) && t.assetIds.includes(old.id) && !D.fulfilled(state, t, old.id))) {
          savedPlans.push({ method: 'vehicle', date: t.date, time: t.time, place: t.place, vehicleId: t.vehicleId });
          t.assetIds = t.assetIds.filter(id => id !== old.id);
          if (t.assetIds.length && t.assetIds.every(id => D.fulfilled(state, t, id))) t.status = 'completed';
          if (!t.assetIds.length) { t.status = 'cancelled'; t.changeReason = '장비교환 회수로 분리'; }
        }
        old.exchangeReservationId = id; old.size = x.oldSize;
        if (x.reason === 'damage') old.condition = 'damaged';
        x.units.push({ baseAssetId: base.id, oldAssetId: old.id, newAssetId: null, returnPlan: savedPlans[0] || C.copy(x.returnPlan) });
      }
      rows(state).push(x);
      if (x.method === 'vehicle') { task(state, x, 'new', context); task(state, x, 'old', context, x.units.map(u => u.oldAssetId)); }
      return { exchangeId: id, taskIds: x.method === 'vehicle' ? [id + '-new', id + '-old'] : [] };
    }
    const x = C.find(rows(state), p.id, '교환 요청');
    if (!active(x)) C.fail('NO_CHANGE', '취소된 교환 요청입니다.');
    if (type === 'exchange.recover') {
      C.keys(p, ['id', 'movementId', 'assetIds', 'reason']);
      const movement = C.find(state.movements, p.movementId, '교환 이동');
      const ids = p.assetIds ? C.ids(p.assetIds) : movement.assetIds.filter(id => !movement.reversedAssetIds.includes(id));
      const result = I.recoverMovement(state, { movementId: movement.id, assetIds: ids, reason: C.string(p.reason, 300) }, context, x.id);
      const effective = (id, kind) => state.movements.filter(m => m.revision >= (x.createdRevision || 0) && m.kind === kind && m.assetIds.includes(id) && !m.reversedAssetIds.includes(id));
      for (const u of x.units) {
        const delivery = u.newAssetId && effective(u.newAssetId, 'deliver').find(m => m.to.id === x.customerId);
        const collection = effective(u.oldAssetId, 'collect').find(m => m.from.id === x.customerId);
        const receipt = [...effective(u.oldAssetId, 'directReturn'), ...effective(u.oldAssetId, 'receive')].sort((a, b) => a.revision - b.revision).at(-1);
        if (delivery) u.deliveredAt = delivery.at; else delete u.deliveredAt;
        if (collection) u.collectedAt = collection.at; else delete u.collectedAt;
        if (receipt) u.receivedAt = receipt.at; else delete u.receivedAt;
        const old = C.find(state.assets, u.oldAssetId); old.exchangeReservationId = u.receivedAt ? null : x.id;
        if (u.newAssetId) {
          const replacement = C.find(state.assets, u.newAssetId); replacement.exchangeReservationId = u.deliveredAt ? null : x.id;
          if (!u.deliveredAt) for (const task of state.tasks.filter(t => t.exchangeReturnId === x.id && t.assetIds.includes(u.newAssetId))) {
            task.status = 'cancelled'; task.recoveryCancelled = true; task.changeReason = '교환 전달 오입력 정정';
          }
        }
      }
      x.status = x.units.every(u => u.deliveredAt && u.receivedAt) ? 'completed' : 'open';
      (x.recoveries ||= []).push({ movementId: movement.id, assetIds: ids, reason: p.reason, at: context.at, actor: C.copy(context.actor) });
      return { ...result, orderId: x.orderId, exchangeId: x.id, taskIds: state.tasks.filter(t => t.exchangeId === x.id && ['waiting', 'in_progress'].includes(t.status)).map(t => t.id) };
    }
    if (type === 'exchange.prepare') {
      C.keys(p, ['id', 'assetIds']); const ids = C.ids(p.assetIds), units = x.units.filter(u => !u.newAssetId);
      if (ids.length > units.length) C.fail('QUANTITY_EXCEEDED', '준비할 교환 수량을 초과했습니다.');
      ids.forEach((id, index) => {
        const a = C.find(state.assets, id);
        if (a.sku !== x.sku || a.location.kind !== 'shop' || !healthy(a) || a.componentBaseId || a.size && a.size !== x.newSize || state.tasks.some(t => t.kind === 'delivery' && ['waiting', 'in_progress'].includes(t.status) && t.assetIds.includes(id) && !D.fulfilled(state, t, id))) C.fail('INVALID_INPUT', '규격이 맞는 정상 매장 재고를 선택해 주세요.');
        units[index].newAssetId = id; a.size = x.newSize; a.exchangeReservationId = x.id; a.lastRevision = state.revision + 1;
      });
      if (x.method === 'vehicle') {
        const t = C.find(state.tasks, x.id + '-new'); t.assetIds.push(...ids); t.plannedItems[0].assetIds.push(...ids);
      }
      return { exchangeId: x.id, assetIds: ids, taskIds: x.method === 'vehicle' ? [x.id + '-new'] : [] };
    }
    if (type === 'exchange.cancel') {
      C.keys(p, ['id', 'reason']); C.string(p.reason, 200);
      if (x.units.some(u => u.deliveredAt || u.collectedAt || u.receivedAt || u.newAssetId && C.find(state.assets, u.newAssetId).location.kind !== 'shop')) C.fail('DEPENDENT_MOVEMENT', '교환품을 실었거나 전달·회수한 기록이 있습니다. 실제 물품 위치를 먼저 확인해 주세요.');
      x.units.forEach((u, index) => {
        C.find(state.assets, u.oldAssetId).exchangeReservationId = null;
        if (u.newAssetId) C.find(state.assets, u.newAssetId).exchangeReservationId = null;
        schedule(state, x, u, index, u.oldAssetId, context);
      });
      state.tasks.filter(t => t.exchangeId === x.id).forEach(t => { t.status = 'cancelled'; });
      x.status = 'cancelled'; x.cancelReason = p.reason; x.cancelledAt = context.at;
      return { exchangeId: x.id, taskIds: [] };
    }
    C.fail('INVALID_INPUT', '지원하지 않는 교환 작업입니다.');
  }
  function schedule(state, x, u, index, assetId, context) {
    if (u.returnPlan.method !== 'vehicle') return;
    const p = u.returnPlan, id = x.id + '-return-' + index + (assetId === u.oldAssetId ? '-restored' : '');
    const previous = state.tasks.find(t => t.id === id);
    if (previous?.recoveryCancelled) { previous.status = 'waiting'; delete previous.recoveryCancelled; }
    D.handle(state, 'task.save', { id, kind: 'collection', customerId: x.customerId, orderId: x.orderId, title: x.customerName + (kinds[x.kind].component ? ' 교환 구성품 반납' : ' 장비 반납'),
      vehicleId: p.vehicleId, date: p.date, time: p.time, place: p.place, assetIds: [assetId] }, context);
    C.find(state.tasks, id).exchangeReturnId = x.id;
  }
  function beforeMove(state, p, context) {
    const task = p.taskId && C.find(state.tasks, p.taskId), exchangeId = p.exchangeId || task?.exchangeId;
    if (['collect', 'directReturn'].includes(p.kind) && !task?.exchangeId && rows(state).filter(active).some(x => kinds[x.kind].component && x.units.some(u => !u.deliveredAt && (p.assetIds || []).includes(resolve(state, u.baseAssetId, x.orderId))))) C.fail('DEPENDENT_MOVEMENT', '구성품 교환이 진행 중입니다. 교환을 완료하거나 요청을 취소한 뒤 해당 장비를 반납해 주세요.');
    for (const id of p.assetIds || []) {
      const a = C.find(state.assets, id);
      if (['load', 'deliver'].includes(p.kind) && a.condition !== 'ready') C.fail('INVALID_INPUT', '파손품은 정상 출고할 수 없습니다.');
      if (!a.exchangeReservationId) continue;
      const x = C.find(rows(state), a.exchangeReservationId), u = x.units.find(u => u.oldAssetId === id || u.newAssetId === id);
      const isOld = u.oldAssetId === id;
      if (isOld && !['collect', 'directReturn', 'receive'].includes(p.kind) || !isOld && !['load', 'deliver', 'receive'].includes(p.kind)) C.fail('INVALID_INPUT', '교환 물품은 연결된 전달·회수 업무에서 처리해 주세요.');
      if (['deliver', 'collect', 'directReturn'].includes(p.kind)) {
        if (exchangeId !== x.id || x.method === 'vehicle' && !(isOld && p.kind === 'directReturn' && context?.actor?.role === 'store') && task?.id !== x.id + (isOld ? '-old' : '-new')) C.fail('FORBIDDEN', '교환 물품은 연결된 전달·회수 업무에서 처리해 주세요.');
        if (!isOld && u.deliveredAt || isOld && (u.collectedAt || u.receivedAt)) C.fail('NO_CHANGE', '이미 처리한 교환 물품입니다.');
        if (!isOld && kinds[x.kind].component && C.find(state.assets, resolve(state, u.baseAssetId, x.orderId)).location.kind !== 'customer') C.fail('INVALID_INPUT', '대여 장비가 이미 반납되었습니다. 교환 요청을 먼저 확인해 주세요.');
      }
      if (p.kind === 'load' && (x.method !== 'vehicle' || p.to.id !== x.visit.vehicleId)) C.fail('FORBIDDEN', '교환 담당 차량에 실어 주세요.');
    }
    if (exchangeId && !(p.assetIds || []).every(id => C.find(rows(state), exchangeId).units.some(u => (task?.exchangeSide === 'old' || p.kind === 'directReturn' ? u.oldAssetId : u.newAssetId) === id))) C.fail('INVALID_INPUT', '교환 요청의 물품을 확인해 주세요.');
  }
  function afterMove(state, result, context) {
    const m = C.find(state.movements, result.movementId);
    for (const x of rows(state).filter(active)) for (const [index, u] of x.units.entries()) {
      if (m.assetIds.includes(u.newAssetId) && m.kind === 'deliver' && !u.deliveredAt) {
        u.deliveredAt = context.at; m.exchangeId = x.id;
        const a = C.find(state.assets, u.newAssetId); a.exchangeReservationId = null; a.exchangeNewId = x.id;
        if (kinds[x.kind].component) a.componentBaseId = u.baseAssetId;
        schedule(state, x, u, index, a.id, { ...context, actor: { id: context.actor.id, role: 'store' } });
      }
      if (m.assetIds.includes(u.oldAssetId) && ['collect', 'directReturn', 'receive'].includes(m.kind) && !u.receivedAt) {
        m.exchangeId = x.id;
        if (m.kind === 'collect') u.collectedAt = context.at;
        if (m.to.kind === 'shop') { u.receivedAt = context.at; const a = C.find(state.assets, u.oldAssetId); a.exchangeReservationId = null; a.componentBaseId = null; }
      }
      x.status = x.units.every(u => u.deliveredAt && u.receivedAt) ? 'completed' : 'open';
    }
  }
  return { handle, beforeMove, afterMove, kinds, reasons, summary, resolve, pending, healthy };
});

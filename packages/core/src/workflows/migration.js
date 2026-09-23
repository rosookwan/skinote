(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'), require('../returns/domain.js'));
  else root.SkiWorkflowMigration = factory(root.SkiWorkflowCommon, root.SkiReturns);
})(globalThis, function (C, R) {
  'use strict';
  // Only the service supplies the source records from the authenticated shop.
  // The command carries IDs, never client-supplied quantities or balances.
  function handle(state, payload, context) {
    C.store(context); C.keys(payload, ['orderIds']);
    const ids = C.ids(payload.orderIds), sources = context.legacyOrders || [];
    state.orders ||= []; state.migrations ||= [];
    const migrated = [], unchanged = [];
    for (const id of ids) {
      const source = C.find(sources, id, '이전 접수');
      if (source.shopId !== state.shopId) C.fail('FORBIDDEN', '매장을 확인해 주세요.');
      const fingerprint = C.canonical(source), prior = state.migrations.find(m => m.sourceId === id && m.kind === 'return-order-v1');
      if (prior) {
        if (prior.fingerprint !== fingerprint) C.fail('MIGRATION_CONFLICT', '이관 후 이전 접수가 변경되었습니다. 원 기록을 비교해 주세요.');
        unchanged.push(id); continue;
      }
      if (state.orders.some(o => o.id === id)) C.fail('ALREADY_EXISTS', '같은 번호의 통합접수가 있습니다.');
      const summary = R.summarize(source), batchId = 'legacy-initial';
      const lines = summary.items.map((item, index) => {
        let sku = item.id === 'clothes' ? 'clothing' : item.id;
        if (item.category === 'liftTicket') sku = 'legacy-' + item.id;
        if (!state.catalog.some(s => s.id === sku)) state.catalog.push({ id: sku, label: item.label, kind: item.category, unit: item.unit, ...(item.category === 'liftTicket' ? { hours: 4, requiresTypeConfirmation: true } : {}) });
        const lineId = 'legacy-line-' + (index + 1), initialAssetIds = [], initialReturnedAssetIds = [];
        const positions = [
          [{ kind: 'customer', id }, item.customerQuantity],
          [{ kind: 'vehicle', id: source.vehicleId }, item.vehicleQuantity],
          [{ kind: 'shop', id: state.shopId }, item.shopQuantity]
        ];
        for (const [location, quantity] of positions) {
          if (!quantity) continue;
          if (!location.id) C.fail('MIGRATION_CONFLICT', '기존 수거 차량을 확인해 주세요.');
          const reference = 'legacy:' + id + ':' + item.id + ':' + location.kind;
          const old = state.movements.find(m => m.kind === 'stock.opening' && m.sourceReference === reference);
          let assets;
          if (old) {
            assets = old.assetIds.map(a => C.find(state.assets, a, '기존 물품'));
            if (assets.length !== quantity || assets.some(a => a.sku !== sku)) C.fail('MIGRATION_CONFLICT', '기존 실물 기록과 이관 수량이 다릅니다.');
          } else {
            assets = Array.from({ length: quantity }, (_, unit) => ({
              id: 'migrated-' + id + '-' + index + '-' + location.kind + '-' + unit,
              lotId: 'migrated-' + id + '-' + index, sku, location: C.copy(location),
              ticket: item.category === 'liftTicket' ? { validFrom: item.returnPlan.date + 'T00:00:00+09:00', validTo: item.returnPlan.date + 'T23:59:59+09:00', acceptedTypes: [sku], transferable: false, vendorId: 'legacy-unconfirmed', requiresConfirmation: true } : null,
              size: '', condition: 'ready', purpose: 'spare', refundId: null,
              vehicleOrigin: location.kind === 'vehicle' ? 'customer' : null,
              acquiredAt: context.at, issuedAt: null, lastRevision: state.revision + 1
            }));
            if (assets.some(a => state.assets.some(existing => existing.id === a.id))) C.fail('MIGRATION_CONFLICT', '이관 물품번호가 이미 있습니다.');
            state.assets.push(...assets); state.stockReferences.push(reference);
            state.movements.push({ id: 'migration-' + id + '-' + index + '-' + location.kind, revision: state.revision + 1, at: context.at, actor: C.copy(context.actor), kind: 'stock.opening', assetIds: assets.map(a => a.id), reversedAssetIds: [], from: null, to: C.copy(location), before: { assets: [], allocations: [] }, sourceReference: reference, orderId: id });
          }
          initialAssetIds.push(...assets.map(a => a.id));
          if (location.kind === 'shop') initialReturnedAssetIds.push(...assets.map(a => a.id));
        }
        // Non-recoverable tickets still count as issued; do not invent stock.
        const nonReturnQuantity = item.issuedQuantity - item.returnTarget;
        const start = item.category === 'liftTicket' ? item.usage?.[0]?.date || item.returnPlan.date : source.rental.startDate;
        const end = item.category === 'liftTicket' ? start : source.rental.endDate;
        const pickup = source.pickupPlan?.[item.category === 'liftTicket' ? 'liftTicket' : 'equipment'] || { method: 'shop' };
        return { id: lineId, batchId, personId: null, sku, label: item.label, category: item.category, unit: item.unit, cancelledQuantity: 0, quantity: item.plannedQuantity, start, end,
          pickupPlan: { ...C.copy(pickup), date: pickup.date || start },
          returnPlan: { ...C.copy(item.returnPlan), ...(item.returnPlan.method === 'vehicle' ? { vehicleId: source.vehicleId } : {}) },
          price: { unitWon: 0, discountWon: 0, amountWon: 0, days: Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1, basis: item.category === 'liftTicket' ? 'per_unit' : 'per_day', source: 'legacy-total-only' },
          initialAssetIds, initialReturnedAssetIds, initialNonReturnQuantity: nonReturnQuantity,
          legacyItemId: item.id, createdAt: context.at, cancelledAt: null };
      });
      const order = { id, customer: { name: source.customer.name, phone: source.customer.phone || '' }, people: [],
        batches: [{ id: batchId, label: '기존 대여', createdAt: context.at, lineIds: lines.map(l => l.id) }], lines, createdAt: context.at,
        legacyChargeWon: source.rental.amountWon, legacySource: C.copy(source), source: 'return-order-v1' };
      for (const task of state.tasks.filter(t => t.orderId === id)) {
        for (const item of task.plannedItems || []) {
          const line = lines.find(l => l.legacyItemId === item.itemId);
          if (line) item.itemId = line.id;
        }
        task.lineItems = lines.map(l => ({ lineId: l.id, assetIds: task.assetIds.filter(assetId => l.initialAssetIds.includes(assetId) || (task.plannedItems || []).some(p => p.itemId === l.id && p.assetIds.includes(assetId))) })).filter(l => l.assetIds.length);
      }
      state.orders.push(order);
      const before = { planned: summary.items.reduce((n, l) => n + l.plannedQuantity, 0), issued: summary.totals.issuedQuantity, customer: summary.totals.customerQuantity, vehicle: summary.totals.vehicleQuantity, returned: summary.totals.shopQuantity, chargeWon: source.rental.amountWon };
      const after = { planned: lines.reduce((n, l) => n + l.quantity, 0), issued: lines.reduce((n, l) => n + l.initialAssetIds.length + l.initialNonReturnQuantity, 0), customer: lines.reduce((n, l) => n + l.initialAssetIds.filter(id => { const a = C.find(state.assets, id); return a.location.kind === 'customer' && a.location.id === source.id; }).length, 0), vehicle: lines.reduce((n, l) => n + l.initialAssetIds.filter(id => { const a = C.find(state.assets, id); return a.location.kind === 'vehicle' && a.location.id === source.vehicleId; }).length, 0), returned: lines.reduce((n, l) => n + l.initialReturnedAssetIds.filter(id => C.find(state.assets, id).location.kind === 'shop').length, 0), chargeWon: order.legacyChargeWon };
      if (C.canonical(before) !== C.canonical(after)) C.fail('MIGRATION_CONFLICT', '이관 전후 수량 또는 금액이 다릅니다.');
      state.migrations.push({ kind: 'return-order-v1', version: 1, sourceId: id, targetId: id, sourceVersion: source.version, fingerprint, at: context.at, before, after });
      migrated.push(id);
    }
    state.orderSchemaVersion = 1;
    return { migrated, unchanged };
  }
  return { handle };
});

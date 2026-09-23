(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./domain.js'), require('../notifications/domain.js'));
  else root.SkiReturnService = factory(root.SkiReturns, root.SkiNotifications);
})(globalThis, function (R, N) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const fail = (code, message) => { throw new R.ReturnError(code, message); };
  function revision(value) {
    if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_INPUT', '동기화 버전을 확인해 주세요.');
    return value;
  }
  function createMemoryRepository() {
    const shops = new Map();
    const listeners = new Set();
    const changed = () => { for (const listener of listeners) { try { listener(); } catch { /* A view listener cannot undo a committed transaction. */ } } };
    const shop = id => {
      if (!shops.has(id)) shops.set(id, { revision: 0, orders: new Map(), notifications: N.fresh() });
      return shops.get(id);
    };
    return {
      mode: 'memory',
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      get: (shopId, orderId) => copy(shop(shopId).orders.get(orderId)?.order ?? null),
      list: shopId => [...shop(shopId).orders.values()].map(entry => copy(entry.order)),
      notifications: shopId => copy(shop(shopId).notifications),
      workflows: shopId => copy(shop(shopId).workflows || null),
      transactWorkflows(shopId, apply) {
        const state = shop(shopId), notifications = copy(state.notifications);
        const result = apply(copy(state.workflows || null), notifications);
        if (!result.duplicate) {
          state.workflows = copy(result.state); state.notifications = notifications; changed();
        }
        return copy(result);
      },
      transactNotifications(shopId, apply) {
        const state = shop(shopId), next = copy(state.notifications), result = apply(next);
        state.notifications = next; changed(); return copy(result ?? null);
      },
      transact(shopId, orderId, apply) {
        const state = shop(shopId);
        const previous = copy(state.orders.get(orderId)?.order ?? null), result = apply(previous);
        if (!result.duplicate) {
          const notifications = copy(state.notifications);
          N.project(notifications, previous, result);
          state.orders.set(orderId, { order: copy(result.order), revision: ++state.revision });
          state.notifications = notifications;
          changed();
        }
        return result;
      },
      changes(shopId, afterRevision) {
        revision(afterRevision);
        const state = shop(shopId);
        if (afterRevision > state.revision) fail('INVALID_INPUT', '현재보다 큰 동기화 버전입니다.');
        return { revision: state.revision, orders: [...state.orders.values()].filter(entry => entry.revision > afterRevision).map(entry => copy(entry.order)) };
      }
    };
  }
  function createService(repository, trustedContext, clock = () => new Date().toISOString()) {
    const context = copy(trustedContext);
    const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(value);
    if (!validId(context.shopId) || !validId(context.actor?.id) || !['store', 'driver'].includes(context.actor.role) || (context.actor.vehicleId != null && !validId(context.actor.vehicleId)) || (context.actor.role === 'driver' && !context.actor.vehicleId)) fail('FORBIDDEN', '직원 소속과 역할을 확인해 주세요.');
    const visible = order => order && order.shopId === context.shopId && (context.actor.role === 'store' || order.vehicleId === context.actor.vehicleId);
    const load = orderId => {
      const order = repository.get(context.shopId, orderId);
      if (!visible(order)) fail('NOT_FOUND', '접수를 찾을 수 없습니다.');
      return order;
    };
    const itemView = item => {
      const { recoveryValueWon, usage, ...rest } = item;
      return context.actor.role === 'driver' ? rest : item;
    };
    function view(order) {
      const summary = R.summarize(order);
      return { ...summary, items: summary.items.map(itemView), pendingConfirmations: R.pendingConfirmations(order),
        recentMovements: order.movements.filter(movement => context.actor.role === 'store' || movement.actor.id === context.actor.id).map(movement => ({ id: movement.id, type: movement.type, at: movement.at, items: copy(movement.items), collectionId: movement.collectionId })),
        ...(context.actor.role === 'store' ? { rental: copy(order.rental) } : {}) };
    }
    return {
      mode: repository.mode,
      execute(command) {
        if ((repository.workflows?.(context.shopId)?.orders || []).some(o => o.id === command?.orderId && o.source === 'return-order-v1')) throw new R.ReturnError('USE_UNIFIED_ORDER', '통합접수로 이관된 기록입니다. 통합접수 화면에서 처리해 주세요.');
        // Ownership, identity and time are taken from the server context, never a request body.
        const result = repository.transact(context.shopId, command?.orderId, current => R.execute(current, command, { ...context, at: clock() }));
        return { order: view(result.order), duplicate: result.duplicate, appliedVersion: result.event.version, requestId: result.event.requestId };
      },
      get: orderId => view(load(orderId)),
      history(orderId) {
        if (context.actor.role !== 'store') fail('FORBIDDEN', '매장 직원만 전체 이력을 조회할 수 있습니다.');
        return R.history(load(orderId));
      },
      list(options = {}) {
        if (Object.keys(options).some(key => !['onDate', 'filter'].includes(key))) fail('INVALID_INPUT', '조회 조건을 확인해 주세요.');
        const orders = repository.list(context.shopId).filter(visible);
        const byId = new Map(orders.map(order => [order.id, order]));
        return R.worklist(orders, { ...options, shopId: context.shopId, now: clock() }).map(row => ({ ...view(byId.get(row.id)), dueItems: row.dueItems.map(itemView), pendingConfirmations: row.pendingConfirmations }));
      },
      report(options = {}) {
        if (context.actor.role !== 'store') fail('FORBIDDEN', '매장 직원만 회수 금액을 조회할 수 있습니다.');
        if (Object.keys(options).some(key => !['fromDate', 'toDate'].includes(key))) fail('INVALID_INPUT', '집계 조건을 확인해 주세요.');
        return R.ticketReport(repository.list(context.shopId), { ...options, shopId: context.shopId });
      },
      sync(afterRevision = 0) {
        const changes = repository.changes(context.shopId, revision(afterRevision));
        return { mode: repository.mode, revision: changes.revision, orders: changes.orders.filter(visible).map(view) };
      }
    };
  }
  return { createMemoryRepository, createService };
});

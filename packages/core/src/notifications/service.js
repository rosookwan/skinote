(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./domain.js'), require('../returns/domain.js'));
  else root.SkiNotificationService = factory(root.SkiNotifications, root.SkiReturns);
})(globalThis, function (N, R) {
  'use strict';
  function createService(repository, context, clock = () => new Date().toISOString()) {
    N.validContext(context);
    const state = () => repository.notifications(context.shopId);
    const visible = () => N.view(state(), context);
    const validate = options => { if (Object.keys(options).some(key => !['filter', 'cursor', 'limit'].includes(key))) throw new R.ReturnError('INVALID_INPUT', '조회 조건을 확인해 주세요.'); };
    return {
      list(options = {}) {
        validate(options);
        if (options.filter && !['all', 'unread'].includes(options.filter)) throw new R.ReturnError('INVALID_INPUT', '알림 필터를 확인해 주세요.');
        const data = N.view(state(), context, options.filter || 'all');
        const cursor = Number(options.cursor || 0), limit = Number(options.limit || 50);
        if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new R.ReturnError('INVALID_INPUT', '목록 범위를 확인해 주세요.');
        return { ...data, records: data.records.slice(cursor, cursor + limit), nextCursor: cursor + limit < data.records.length ? cursor + limit : null };
      },
      sync(cursor = 0) {
        cursor = Number(cursor);
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new R.ReturnError('INVALID_INPUT', '알림 갱신 번호를 확인해 주세요.');
        const data = visible();
        const reset = cursor === 0 || cursor > data.revision;
        return { ...data, records: reset ? data.records : data.records.filter(row => row.revision > cursor), reset, cursor: data.revision };
      },
      sent() {
        return { records: state().records.filter(row => row.senderScope === N.scope(context)).map(row => {
          const { sourceKey, ...rest } = row; return rest;
        }) };
      },
      tasks() { return state().tasks.filter(row => context.actor.role === 'store' || row.vehicleId === context.actor.vehicleId); },
      preferences() { return state().preferences[N.preferenceKey(context)] || N.defaults(context); },
      execute(command) {
        return repository.transactNotifications(context.shopId, current => N.execute(current, command, { ...context, at: clock() }, orderId => repository.get(context.shopId, orderId)));
      }
    };
  }
  return { createService };
});

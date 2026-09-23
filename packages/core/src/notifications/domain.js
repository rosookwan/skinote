(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../returns/domain.js'));
  else root.SkiNotifications = factory(root.SkiReturns);
})(globalThis, function (R) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const fail = (code, message) => { throw new R.ReturnError(code, message); };
  const fresh = () => ({ revision: 0, records: [], requests: {}, tasks: [], preferences: {} });
  const defaults = context => ({ sound: context?.actor?.role === 'driver', interval: 30, volume: 60 });
  const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
  const scope = context => context.actor.role === 'driver' ? 'vehicle:' + context.actor.vehicleId : 'store';
  const preferenceKey = context => (context.deviceId || context.actor.id) + ':' + scope(context);
  const validContext = context => {
    if (!id(context?.shopId) || !id(context?.actor?.id) || !['store', 'driver'].includes(context.actor.role) || (context.actor.role === 'driver' && !id(context.actor.vehicleId)) || (context.deviceId != null && !id(context.deviceId))) fail('FORBIDDEN', '알림 수신 권한을 확인해 주세요.');
  };
  function touch(state, record) { record.revision = ++state.revision; }
  function emit(state, event, recipient, type, title, summary, extra = {}) {
    const key = [event.orderId, event.requestId, type, recipient].join('|');
    const old = state.records.find(row => row.sourceKey === key);
    if (old) return old;
    const row = { id: 'notice-' + (state.revision + 1), sourceKey: key, sourceRequestId: event.requestId,
      orderId: event.orderId, recipient, type, title, summary, createdAt: event.at,
      lifecycle: 'active', acknowledgedAt: null, acknowledgedBy: null, receivedAt: null,
      attentionRequired: true, ...extra };
    touch(state, row); state.records.push(row); return row;
  }
  function closeWhere(state, matches, reason) {
    for (const row of state.records) if (row.lifecycle === 'active' && matches(row)) {
      row.lifecycle = reason; touch(state, row);
    }
  }
  const quantities = (order, rows) => rows.map(row => {
    const item = order.items.find(item => item.id === row.itemId);
    return item ? item.label + ' ' + row.quantity + (item.unit || '개') : '';
  }).filter(Boolean).join(' · ');
  function project(state, previous, result) {
    if (result.duplicate) return;
    const order = result.order, event = { ...result.event, orderId: order.id };
    const vehicle = order.vehicleId ? 'vehicle:' + order.vehicleId : null;
    const customer = order.customer.name;
    const summary = R.summarize(order);
    if (event.type === 'assignVehicle' && previous.vehicleId !== order.vehicleId) {
      const oldRecipient = 'vehicle:' + previous.vehicleId;
      for (const row of state.records.filter(row => row.orderId === order.id && row.recipient === oldRecipient)) {
        row.lifecycle = 'cancelled'; row.title = '담당 차량이 변경된 업무'; row.summary = '매장에서 담당 차량을 변경했습니다.';
        row.taskId = null; touch(state, row);
      }
      for (const task of state.tasks.filter(task => task.orderId === order.id)) { task.vehicleId = order.vehicleId; task.version++; }
      if (previous.vehicleId) emit(state, event, oldRecipient, 'cancelled', '담당 업무가 변경됐어요', '매장에서 다른 차량에 배정했습니다. 이 업무를 진행하지 않아도 됩니다.');
      emit(state, event, vehicle, 'assignment', customer + ' · 담당 업무 배정', '새로 배정된 업무의 일정과 장소를 확인해 주세요.');
    }
    if (event.type === 'collect') {
      const rows = event.payload.items || [], total = rows.reduce((n, row) => n + row.quantity, 0);
      const remaining = summary.items.filter(item => item.customerQuantity > 0).map(item => item.label + ' ' + item.customerQuantity + (item.unit || '개')).join(' · ');
      emit(state, event, 'store', 'collection', customer + (total ? ' · 수거 내역' : ' · 수거하지 못했어요'),
        (total ? quantities(order, rows) + ' 수거' : '받은 물품이 없습니다.') + (remaining ? '\n고객에게 남음 · ' + remaining : '\n매장에서 인계 수량을 확인해 주세요.'),
        { collectionId: event.requestId, actorName: event.actor.role === 'driver' ? '기사님' : '매장', attentionRequired: true });
      closeWhere(state, row => row.orderId === order.id && row.type === 'priority' && row.recipient === vehicle, 'resolved');
    }
    if (event.type === 'confirmVehicle') {
      const pending = R.pendingConfirmations(order).some(row => row.collectionId === event.payload.collectionId);
      if (!pending) closeWhere(state, row => row.orderId === order.id && row.collectionId === event.payload.collectionId, 'resolved');
      if (vehicle) emit(state, event, vehicle, 'handover', customer + ' · 매장 인계 확인', quantities(order, event.payload.items), { attentionRequired: false });
    }
    if (['correctReturn', 'undoReturn'].includes(event.type)) {
      const movementId = event.payload.movementId;
      closeWhere(state, row => row.orderId === order.id && row.collectionId === movementId, event.type === 'undoReturn' ? 'cancelled' : 'superseded');
      const recipient = event.actor.role === 'driver' ? 'store' : vehicle;
      if (recipient) emit(state, event, recipient, 'correction', customer + (event.type === 'undoReturn' ? ' · 수거 기록 취소' : ' · 반납 수량 변경'),
        '변경된 실제 수량과 남은 물품을 확인해 주세요.', { collectionId: movementId });
    }
    if (event.type === 'planReturn' && vehicle) {
      const rows = event.payload.items || [];
      const descriptions = rows.map(row => {
        const item = order.items.find(item => item.id === row.itemId), before = previous?.items.find(item => item.id === row.itemId);
        const line = plan => [plan.date, plan.time, plan.place, plan.method === 'direct' ? '매장 직접반납' : '차량 수거'].filter(Boolean).join(' · ');
        return item ? item.label + '\n' + (before ? line(before.returnPlan) + ' → ' : '') + line(item.returnPlan) : '';
      });
      closeWhere(state, row => row.orderId === order.id && row.recipient === vehicle && ['schedule', 'priority', 'assignment'].includes(row.type), 'superseded');
      emit(state, event, vehicle, 'schedule', customer + ' · 반납 일정 변경', descriptions.join('\n'));
    }
    if (event.type === 'create' && vehicle && order.items.some(item => item.returnPlan.method === 'vehicle')) {
      emit(state, event, vehicle, 'assignment', customer + ' · 새 수거 일정', '반납 예정일과 실제 지급 수량을 확인해 주세요.');
    }
    if (summary.complete) closeWhere(state, row => row.orderId === order.id && ['priority', 'assignment', 'schedule', 'collection'].includes(row.type), 'resolved');
    return state;
  }
  function view(state, context, filter = 'all') {
    validContext(context);
    const recipient = scope(context);
    const all = state.records.filter(row => row.recipient === recipient).map(row => {
      const { sourceKey, ...safe } = row;
      return copy(safe);
    });
    const unread = row => row.lifecycle === 'active' && !row.acknowledgedAt;
    return { revision: state.revision, unreadCount: all.filter(unread).length,
      records: all.filter(row => filter !== 'unread' || unread(row)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.revision - a.revision) };
  }
  function execute(state, command, context, getOrder) {
    validContext(context);
    if (!command || !id(command.requestId) || !['request', 'ack', 'received', 'preferences', 'task'].includes(command.type)) fail('INVALID_INPUT', '알림 요청 형식을 확인해 주세요.');
    const allowed = ['type', 'requestId', 'notificationId', 'payload'];
    if (Object.keys(command).some(key => !allowed.includes(key))) fail('INVALID_INPUT', '알림 요청에 알 수 없는 값이 있습니다.');
    const payload = command.payload || {};
    const checkKeys = keys => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !keys.includes(key))) fail('INVALID_INPUT', '입력 항목을 확인해 주세요.');
    };
    const fingerprint = R.canonical({ command, actor: context.actor, deviceId: context.deviceId || null });
    const requestKey = context.actor.id + ':' + command.requestId;
    if (state.requests[requestKey]) {
      if (state.requests[requestKey].fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', '같은 요청으로 다른 내용을 저장할 수 없습니다.');
      return { ...copy(state.requests[requestKey].result), duplicate: true };
    }
    const at = context.at || new Date().toISOString(), recipient = scope(context);
    const find = () => {
      const row = state.records.find(row => row.id === command.notificationId && row.recipient === recipient);
      if (!row) fail('NOT_FOUND', '이 알림을 확인할 수 없습니다.');
      return row;
    };
    let result;
    if (command.type === 'ack' || command.type === 'received') {
      checkKeys([]); const row = find();
      if (command.type === 'ack' && !row.acknowledgedAt && row.lifecycle === 'active') {
        row.acknowledgedAt = at; row.acknowledgedBy = context.actor.id; touch(state, row);
      }
      if (command.type === 'received' && !row.receivedAt) { row.receivedAt = at; touch(state, row); }
      result = { notificationId: row.id, acknowledgedAt: row.acknowledgedAt, lifecycle: row.lifecycle };
    } else if (command.type === 'preferences') {
      checkKeys(['sound', 'interval', 'volume']);
      if (typeof payload.sound !== 'boolean' || ![30, 60].includes(payload.interval) || !Number.isInteger(payload.volume) || payload.volume < 0 || payload.volume > 100) fail('INVALID_INPUT', '소리 설정을 확인해 주세요.');
      state.preferences[preferenceKey(context)] = copy(payload); ++state.revision; result = copy(payload);
    } else if (command.type === 'request') {
      checkKeys(['orderId', 'message', 'expectedVersion', 'taskId']);
      const order = getOrder(payload.orderId);
      if (!order || (context.actor.role === 'driver' && order.vehicleId !== context.actor.vehicleId)) fail('NOT_FOUND', '요청할 업무를 찾을 수 없습니다.');
      if (order.version !== payload.expectedVersion) fail('VERSION_CONFLICT', '업무가 바뀌었습니다. 최신 내용을 확인해 주세요.');
      if (R.summarize(order).complete) fail('INVALID_INPUT', '완료된 업무에는 확인 요청을 보낼 수 없습니다.');
      if (!order.vehicleId) fail('INVALID_INPUT', '담당 차량을 먼저 지정해 주세요.');
      const message = typeof payload.message === 'string' ? payload.message.trim() : '';
      if (!message || message.length > 240) fail('INVALID_INPUT', '요청 내용을 1~240자로 입력해 주세요.');
      if (payload.taskId && !state.tasks.some(task => task.id === payload.taskId && task.orderId === order.id && task.status === 'waiting')) fail('INVALID_INPUT', '진행 중인 업무를 선택해 주세요.');
      const to = context.actor.role === 'driver' ? 'store' : 'vehicle:' + order.vehicleId;
      const type = context.actor.role === 'driver' ? 'help' : 'priority';
      const existing = state.records.find(row => row.orderId === order.id && row.recipient === to && row.type === type && row.summary === message && row.lifecycle === 'active' && !row.acknowledgedAt);
      const row = existing || emit(state, { orderId: order.id, requestId: command.requestId, at }, to, type,
        order.customer.name + (type === 'help' ? ' · 기사님 요청' : ' · 매장 확인 요청'), message,
        { requestedBy: context.actor.id, senderScope: recipient, taskId: payload.taskId || null });
      result = { notificationId: row.id, duplicate: !!existing };
    } else {
      checkKeys(['id', 'orderId', 'expectedVersion', 'kind', 'vehicleId', 'date', 'time', 'place', 'status']);
      if (context.actor.role !== 'store') fail('FORBIDDEN', '매장에서 업무를 배정해 주세요.');
      const order = getOrder(payload.orderId);
      if (!order) fail('NOT_FOUND', '접수를 찾을 수 없습니다.');
      const previous = state.tasks.find(row => row.id === payload.id);
      if (!id(payload.id) || (previous && previous.orderId !== order.id) || (previous?.version || 0) !== payload.expectedVersion) fail('VERSION_CONFLICT', '업무의 최신 상태를 확인해 주세요.');
      if (!['delivery', 'return'].includes(payload.kind) || !['waiting', 'cancelled', 'completed'].includes(payload.status) || !id(payload.vehicleId)) fail('INVALID_INPUT', '업무 종류와 담당 차량을 확인해 주세요.');
      if (payload.vehicleId !== order.vehicleId) fail('INVALID_INPUT', '접수에 배정된 차량과 업무 차량이 다릅니다.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.date) || !Number.isFinite(Date.parse(payload.date)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(payload.time) || typeof payload.place !== 'string' || !payload.place.trim() || payload.place.length > 120) fail('INVALID_INPUT', '날짜·시간·장소를 확인해 주세요.');
      const task = { ...copy(payload), version: (previous?.version || 0) + 1 };
      delete task.expectedVersion;
      if (previous) state.tasks.splice(state.tasks.indexOf(previous), 1, task); else state.tasks.push(task);
      closeWhere(state, row => row.taskId === task.id, task.status === 'cancelled' ? 'cancelled' : 'superseded');
      const type = task.status === 'cancelled' ? 'cancelled' : task.status === 'completed' ? 'task-complete' : previous ? 'schedule' : 'assignment';
      const to = task.status === 'completed' ? 'store' : 'vehicle:' + task.vehicleId;
      const row = emit(state, { orderId: order.id, requestId: command.requestId, at }, to, type,
        order.customer.name + ' · ' + (task.kind === 'delivery' ? '배달' : '수거') + (task.status === 'cancelled' ? ' 일정 취소' : task.status === 'completed' ? ' 업무 처리' : previous ? ' 일정 변경' : ' 새 일정'),
        task.date + ' ' + task.time + ' · ' + task.place, { taskId: task.id, attentionRequired: task.status !== 'completed' });
      result = { task: copy(task), notificationId: row.id };
    }
    state.requests[requestKey] = { fingerprint, result: copy(result) };
    return result;
  }
  return { fresh, defaults, scope, preferenceKey, validContext, view, execute, project, emit, closeWhere, copy };
});

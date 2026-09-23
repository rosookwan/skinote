(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'), require('./domain.js'), require('../notifications/domain.js'));
  else root.SkiWorkflowService = factory(root.SkiWorkflowCommon, root.SkiWorkflows, root.SkiNotifications);
})(globalThis, function (C, W, N) {
  'use strict';
  function project(notifications, committed) {
    if (committed.duplicate) return;
    const { event, state, result } = committed;
    const source = { ...event, orderId: result.orderId || result.reservationId || result.taskId || result.formId || 'workflow' };
    const senderScope = event.actor.role === 'driver' ? 'vehicle:' + event.actor.vehicleId : 'store';
    if (event.type.startsWith('exchange.') || event.type === 'earlyReturn.create') {
      for (const id of result.taskIds || []) { const task = C.find(state.tasks, id); N.closeWhere(notifications, n => n.taskId === id && n.type === 'workflow-task', 'superseded'); N.emit(notifications, source, 'vehicle:' + task.vehicleId, 'workflow-task', task.title, task.memo, { senderScope, taskId: id }); }
      if (event.type === 'exchange.cancel') N.closeWhere(notifications, n => state.tasks.some(t => t.exchangeId === result.exchangeId && t.id === n.taskId), 'cancelled');
    }
    if (event.type === 'earlyReturn.create') {
      N.closeWhere(notifications, n => state.tasks.some(t => t.id === n.taskId && ['cancelled', 'completed'].includes(t.status)) && n.lifecycle === 'active', 'resolved');
      if (!result.taskIds.length) N.emit(notifications, source, 'store', 'workflow-collection', '일부 조기반납 접수', W.earlyReturns.summary(state, C.find(state.earlyReturns, result.earlyReturnId)), { senderScope, attentionRequired: false });
    }
    if (event.type === 'task.priority') {
      const task = C.find(state.tasks, result.taskId), recipient = event.actor.role === 'store' ? 'vehicle:' + task.vehicleId : 'store';
      const type = event.actor.role === 'store' ? 'priority' : 'help';
      if (!notifications.records.some(n => n.type === type && n.taskId === task.id && n.recipient === recipient && n.lifecycle === 'active' && !n.acknowledgedAt)) N.emit(notifications, source, recipient, type,
        task.title + (type === 'priority' ? ' · 우선 확인 요청' : ' · 매장 확인 요청'), result.message || '이번 업무를 확인해 주세요.', { senderScope, taskId: task.id });
    }
    if (event.type === 'dispatch.reorder') {
      const recipient = 'vehicle:' + result.vehicleId;
      N.closeWhere(notifications, n => n.type === 'sequence' && n.recipient === recipient && n.date === result.date, 'superseded');
      N.emit(notifications, source, recipient, 'sequence', '매장에서 방문 순서를 변경했어요',
        result.action === 'restore' ? '시간순으로 복원했습니다.' : result.changes.map(c => c.title + ' ' + c.fromRank + '번째 → ' + c.toRank + '번째').join('\n'),
        { senderScope, date: result.date, changes: C.copy(result.changes), changedBy: result.changedBy, taskId: result.taskId });
    }
    if (event.type === 'task.save' || event.type === 'refund.plan' || event.type === 'intake.dispatch') {
      const task = C.find(state.tasks, result.taskId);
      N.closeWhere(notifications, n => n.taskId === task.id && n.type === 'workflow-task', 'superseded');
      if (result.previousVehicleId && result.previousVehicleId !== task.vehicleId) {
        const oldRecipient = 'vehicle:' + result.previousVehicleId;
        N.closeWhere(notifications, n => n.taskId === task.id && n.recipient === oldRecipient, 'cancelled');
        N.emit(notifications, source, oldRecipient, 'workflow-reassigned', '담당 차량이 변경됐어요', '이 업무는 다른 차량에 배정했습니다.', { senderScope, taskId: task.id, attentionRequired: false });
      }
      N.emit(notifications, source, 'vehicle:' + task.vehicleId, 'workflow-task', task.title, [task.date, task.time, task.place].join(' · '), { senderScope, taskId: task.id });
    }
    if (event.type === 'stock.move') {
      const m = C.find(state.movements, result.movementId);
      const counts = state.catalog.map(s => ({ label: s.label, unit: s.unit, count: m.assetIds.filter(id => C.find(state.assets, id).sku === s.id).length })).filter(s => s.count).map(s => s.label + ' ' + s.count + s.unit).join(' · ');
      if (m.kind === 'load') N.emit(notifications, source, 'vehicle:' + m.to.id, 'load', '카운터에서 물품을 추가했어요', counts, { senderScope, movementId: m.id });
      if (m.kind === 'collect') N.emit(notifications, source, 'store', 'workflow-collection', '차량 수거 내역', counts, { senderScope, movementId: m.id });
    }
    if (event.type === 'stock.purpose') N.emit(notifications, source, 'vehicle:' + result.vehicleId, 'load', '리프트권 용도가 변경됐어요', result.assetIds.length + '매 · ' + (result.purpose === 'spare' ? '차량 예비분' : '고객 전달') + ' · 수량은 그대로입니다.', { senderScope });
    if (event.type === 'task.status' && ['completed', 'cancelled'].includes(event.payload.status)) N.closeWhere(notifications, n => n.taskId === result.taskId && ['priority', 'help', 'workflow-task'].includes(n.type), event.payload.status === 'completed' ? 'resolved' : 'cancelled');
    if (['movement.undo', 'movement.correct'].includes(event.type)) {
      const m = C.find(state.movements, result.movementId), vehicleId = m.to?.kind === 'vehicle' ? m.to.id : m.from?.kind === 'vehicle' ? m.from.id : null;
      N.closeWhere(notifications, n => n.movementId === m.id && n.type !== 'workflow-correction', 'superseded');
      for (const recipient of ['store', ...(vehicleId ? ['vehicle:' + vehicleId] : [])]) N.emit(notifications, source, recipient, 'workflow-correction', '물품 이동 기록이 정정됐어요', '정정 ' + result.correctedAssetIds.length + '개 · 현재 보관 수량을 확인해 주세요.', { senderScope, movementId: m.id });
    }
    if (event.type === 'refund.complete') N.emit(notifications, source, 'store', 'vendor-refund', '리프트권 환불 처리', '완료 ' + result.completed + '매 · 남음 ' + result.remaining + '매', { senderScope, refundId: result.refundId });
    if (event.type.startsWith('ops.') || event.type.startsWith('tickets.')) {
      for (const id of [...new Set([...(result.taskIds || []), ...(result.collectionTaskIds || []), ...(result.taskId ? [result.taskId] : [])])]) {
        const task = state.tasks.find(t => t.id === id); if (!task || !['waiting', 'in_progress'].includes(task.status)) continue;
        N.closeWhere(notifications, n => n.taskId === id && n.type === 'workflow-task', 'superseded');
        N.emit(notifications, source, 'vehicle:' + task.vehicleId, 'workflow-task', task.title, [task.date, task.time, task.place].join(' · '), { senderScope, taskId: id });
      }
      for (const movement of state.movements.filter(m => m.revision === event.version && ['load', 'collect', 'deliver'].includes(m.kind))) {
        const recipient = movement.kind === 'load' ? 'vehicle:' + movement.to.id : 'store';
        N.emit(notifications, source, recipient, movement.kind === 'load' ? 'load' : 'workflow-collection', { load: '차량에 물품을 실었어요', collect: '차량 수거 내역', deliver: '고객 전달 내역' }[movement.kind], '실제 이동 ' + movement.assetIds.length + '개', { senderScope, movementId: movement.id, taskId: movement.taskId });
      }
    }
    if (event.type === 'docs.formApply') N.closeWhere(notifications, n => n.formId === result.formId && n.type === 'intake-submitted', 'resolved');
    N.closeWhere(notifications, n => n.taskId && ['priority', 'help', 'workflow-task'].includes(n.type) && state.tasks.some(t => t.id === n.taskId && ['completed', 'cancelled'].includes(t.status)), 'resolved');
    if (event.type === 'intake.submit' && result.status === 'submitted') N.emit(notifications, source, 'store', 'intake-submitted', C.find(state.forms, result.formId).customer.name + ' · 입력폼 제출', '제출본 ' + result.submissionVersion + '을 확인해 주세요.', { senderScope: 'customer', formId: result.formId });
  }
  function commit(repository, shopId, command, context) {
    return repository.transactWorkflows(shopId, (current, notifications) => {
      const actualContext = command?.type === 'legacy.migrate' ? { ...context, legacyOrders: repository.list(shopId) } : context;
      const result = W.execute(current, command, actualContext); project(notifications, result); return result;
    });
  }
  function createService(repository, trustedContext, clock = () => new Date().toISOString(), adapters = {}) {
    const context = C.copy(C.context(trustedContext));
    const state = () => repository.workflows(context.shopId) || W.fresh(context.shopId);
    const now = () => C.instant(clock());
    const execute = command => {
      if (command?.type === 'task.save' && command.payload?.orderId) {
        const unified = (state().orders || []).find(o => o.id === command.payload.orderId);
        const order = unified || repository.get(context.shopId, command.payload.orderId);
        const vehicles = command.payload.kind === 'delivery' ? Object.values(order?.pickupPlan || {}).filter(p => p.method === 'delivery').map(p => p.vehicleId) : [];
        if (!order || !unified && ![order.vehicleId, ...vehicles].includes(command.payload.vehicleId)) C.fail('INVALID_INPUT', '접수의 담당 차량을 확인해 주세요.');
      }
      const result = commit(repository, context.shopId, command, { ...context, at: now() });
      return { ...C.copy(result.result), duplicate: result.duplicate, revision: result.state.revision };
    };
    const ownVehicle = requested => { const vehicleId = requested || context.actor.vehicleId; C.vehicle(context, vehicleId); return vehicleId; };
    const notify = () => N.view(repository.notifications(context.shopId), context);
    function snapshot() {
      const current = state(), notifications = notify();
      const tasks = current.tasks.filter(t => context.actor.role === 'store' || t.vehicleId === context.actor.vehicleId).map(task => {
        const customer = (current.orders || []).find(o => o.id === task.customerId || o.id === task.orderId)?.customer || current.reservations.find(r => r.id === task.customerId)?.customer || current.forms.find(f => f.id === task.customerId)?.customer || null;
        return { ...C.copy(task), customer: C.copy(customer), remainingAssetIds: task.assetIds.filter(id => !W.dispatch.fulfilled(current, task, id)), unassignedQuantity: W.dispatch.unassigned(task), physicalAssets: C.copy(current.assets.filter(a => task.assetIds.includes(a.id) && !W.dispatch.fulfilled(current, task, a.id) && (context.actor.role === 'store' || a.location.kind === 'shop' || a.location.kind === 'vehicle' && a.location.id === context.actor.vehicleId || a.location.kind === 'customer' && a.location.id === task.customerId))) };
      });
      if (context.actor.role === 'driver') return { revision: current.revision, mode: repository.mode, actor: C.copy(context.actor), shopId: context.shopId, at: now(), catalog: C.copy(current.catalog), tasks, notifications,
        earlyReturns: (current.earlyReturns || []).filter(r => r.visit?.vehicleId === context.actor.vehicleId).map(r => W.earlyReturns.view(current, r)), exchanges: C.copy((current.exchanges || []).filter(x => x.visit.vehicleId === context.actor.vehicleId)), vehicle: W.inventory.vehicleSummary(current, context.actor.vehicleId, C.day(now()), now()), refunds: current.refunds.filter(r => r.vehicleId === context.actor.vehicleId).map(r => W.inventory.refundSummary(current, r)) };
      return { revision: current.revision, mode: repository.mode, actor: C.copy(context.actor), shopId: context.shopId, at: now(), catalog: C.copy(current.catalog), tasks, notifications, assets: C.copy(current.assets), orders: W.orders.list(current).map(o => ({ ...o, finance: W.finance.summary(current, o.id) })), finance: W.finance.day(current, C.day(now()), W.management.summary(current).partners), closings: W.finance.closings(current), management: W.management.summary(current), migrations: C.copy(current.migrations || []),
        earlyReturns: (current.earlyReturns || []).map(r => W.earlyReturns.view(current, r)), exchanges: C.copy(current.exchanges || []), reservations: C.copy(current.reservations), allocations: C.copy(current.allocations), refunds: current.refunds.map(r => W.inventory.refundSummary(current, r)),
        forms: current.forms.map(f => W.intake.view(current, f, now())), printJobs: C.copy(current.printJobs), deliveries: C.copy(current.deliveries), sequences: C.copy(current.sequences) };
    }
    const service = {
      mode: repository.mode, execute, snapshot,
      prepareMove(options) {
        C.keys(options, ['kind', 'from', 'to', 'items', 'purpose', 'taskId']); const current = state();
        const assetIds = W.inventory.select(current, options.from, options.items, options), { items, ...rest } = options;
        const payload = { ...rest, assetIds }, command = { type: 'stock.move', requestId: 'preview-' + current.revision, expectedVersion: current.revision, payload };
        const preview = W.execute(current, command, { ...context, at: now() });
        const vehicleId = options.to.kind === 'vehicle' ? options.to.id : options.from.kind === 'vehicle' ? options.from.id : null;
        return { revision: current.revision, payload, added: assetIds.length, before: vehicleId ? W.inventory.vehicleSummary(current, vehicleId, C.day(now()), now()) : null,
          after: vehicleId ? W.inventory.vehicleSummary(preview.state, vehicleId, C.day(now()), now()) : null };
      },
      sync(options = {}) {
        C.keys(options, ['afterRevision', 'afterNotificationRevision']);
        const cursor = C.integer(Number(options.afterRevision || 0), 0, Number.MAX_SAFE_INTEGER), noticeCursor = C.integer(Number(options.afterNotificationRevision || 0), 0, Number.MAX_SAFE_INTEGER);
        const current = state(), notificationRevision = notify().revision;
        const changed = cursor !== current.revision || noticeCursor !== notificationRevision || cursor === 0;
        return { revision: current.revision, notificationRevision, reset: cursor > current.revision || noticeCursor > notificationRevision, changed,
          at: now(), mode: repository.mode, ...(changed ? { data: snapshot() } : {}) };
      },
      reservations(options = {}) { C.store(context); return W.reservations.summary(state(), { date: C.day(now()), ...options }); },
      vehicle(options = {}) { C.keys(options, ['vehicleId', 'date']); return W.inventory.vehicleSummary(state(), ownVehicle(options.vehicleId), options.date || C.day(now()), now()); },
      board(options = {}) {
        C.keys(options, ['vehicleId', 'date', 'selectedTaskId']);
        return { ...W.dispatch.board(state(), ownVehicle(options.vehicleId), options.date || C.day(now()), options.selectedTaskId), notifications: notify() };
      },
      intake(formId) { C.store(context); const current = state(); return W.intake.view(current, C.find(current.forms, formId), now()); },
      print(jobId) { C.store(context); const job = C.find(state().printJobs, jobId); return { job: C.copy(job), html: (job.document.template === 'order-preparation-v1' ? W.orderDocuments : W.documents).html(job.document) }; },
      async dispatchPrint(jobId) {
        C.store(context); const job = C.find(state().printJobs, jobId);
        if (!adapters.printer || job.status !== 'queued') return { ...service.print(jobId), transportConfigured: !!adapters.printer };
        const record = (status, device = '') => execute({ type: 'print.record', requestId: 'printer-status-' + state().revision + '-' + status, expectedVersion: state().revision, payload: { id: jobId, status, device } });
        record('dispatched');
        try {
          const receipt = await adapters.printer.print({ idempotencyKey: context.shopId + ':' + job.id, document: C.copy(job.document), html: (job.document.template === 'order-preparation-v1' ? W.orderDocuments : W.documents).html(job.document) });
          C.oneOf(receipt?.status, ['dispatched', 'confirmed']); record(receipt.status, C.string(receipt.device, 100));
        } catch { record('unknown'); }
        return { ...service.print(jobId), transportConfigured: true };
      },
      history(options = {}) {
        C.store(context); C.keys(options, ['afterVersion']); const current = state(), after = C.integer(Number(options.afterVersion || 0), 0, Number.MAX_SAFE_INTEGER);
        return { events: C.copy(current.events.filter(e => e.version > after)), movements: C.copy(current.movements.map(({ before, ...m }) => m)), corrections: C.copy(current.corrections) };
      },
      report(options = {}) {
        C.store(context); C.keys(options, ['date']); const date = C.date(options.date || C.day(now())), current = state();
        const rows = current.movements.filter(m => C.day(m.at) === date);
        return { date, totals: current.catalog.filter(s => s.kind === 'liftTicket').map(s => {
          const count = kind => rows.filter(m => m.kind === kind).reduce((n, m) => n + m.assetIds.filter(id => !m.reversedAssetIds.includes(id) && C.find(current.assets, id).sku === s.id).length, 0);
          return { sku: s.id, newlyIssued: count('ticket.issue'), recovered: count('collect') + count('directReturn'), refunded: count('refund'),
            redelivered: rows.filter(m => m.kind === 'deliver').reduce((n, m) => n + m.assetIds.filter(id => !m.reversedAssetIds.includes(id) && C.find(current.assets, id).sku === s.id && current.movements.some(before => before.revision < m.revision && before.kind === 'deliver' && before.assetIds.includes(id) && !before.reversedAssetIds.includes(id))).length, 0) };
        }), refundAmountWon: rows.filter(m => m.kind === 'refund').reduce((n, m) => n + m.amountWon, 0) };
      },
      async sendFormLink({ command, accessToken, publicUrl }) {
        C.store(context);
        if (command?.type !== 'delivery.queue') C.fail('INVALID_INPUT', '입력폼 발송 요청을 확인해 주세요.');
        const form = C.find(state().forms, command.payload?.formId);
        await checkAccess(form, accessToken, now());
        const link = formLink(publicUrl, context.shopId, form.id, accessToken);
        const result = execute(command), delivery = C.find(state().deliveries, result.deliveryId);
        const message = form.customer.name + '님, 일행의 장비 정보를 입력해 주세요.\n' + link;
        if (!adapters.sms || delivery.status !== 'prepared') return { ...result, status: delivery.status, transportConfigured: !!adapters.sms, message, link };
        const record = (status, receipt = {}) => execute({ type: 'delivery.record', requestId: 'delivery-status-' + state().revision + '-' + status, expectedVersion: state().revision, payload: { id: delivery.id, status, ...receipt } });
        record('sending');
        try {
          const receipt = await adapters.sms.send({ idempotencyKey: context.shopId + ':' + delivery.id, recipient: delivery.recipient, message });
          C.oneOf(receipt?.status, ['accepted', 'delivered']); C.string(receipt.providerId);
          record(receipt.status, { providerId: receipt.providerId });
        } catch { record('unknown', { note: '발송 결과를 확인하지 못했습니다. 발송처 확인 후 상태를 갱신해 주세요.' }); }
        return { deliveryId: delivery.id, status: C.find(state().deliveries, delivery.id).status, transportConfigured: true, revision: state().revision };
      }
    };
    return service;
  }
  async function hashToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) C.fail('UNAUTHORIZED', '입력 링크를 확인해 주세요.');
    const buffer = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function checkAccess(form, token, at) {
    const hash = await hashToken(token); let different = 0;
    for (let i = 0; i < 64; i++) different |= hash.charCodeAt(i) ^ form.access.hash.charCodeAt(i);
    if (different) C.fail('UNAUTHORIZED', '입력 링크를 확인해 주세요.');
    if (form.access.revokedAt || form.access.expiresAt <= at) C.fail('FORM_CLOSED', '입력 링크가 만료되었거나 닫혔습니다.');
  }
  function formLink(publicUrl, shopId, formId, token) {
    let url;
    try { url = new URL(publicUrl); } catch { C.fail('INVALID_INPUT', '고객 화면 주소를 확인해 주세요.'); }
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) C.fail('INVALID_INPUT', 'HTTPS 고객 화면 주소를 사용해 주세요.');
    url.search = ''; url.hash = new URLSearchParams({ shop: C.id(shopId), form: C.id(formId), token }).toString();
    return url.toString();
  }
  async function publicRequest(repository, { shopId, formId, accessToken }, command, clock = () => new Date().toISOString()) {
    C.id(shopId); C.id(formId); const at = C.instant(clock()), current = repository.workflows(shopId) || W.fresh(shopId);
    const form = current.forms.find(f => f.id === formId);
    if (!form) C.fail('UNAUTHORIZED', '입력 링크를 확인해 주세요.');
    await checkAccess(form, accessToken, at);
    if (command) {
      if (command.type !== 'intake.submit' || command.payload?.id !== formId) C.fail('FORBIDDEN', '해당 입력폼에만 제출할 수 있습니다.');
      // Check the token again inside the transaction: revocation must win a concurrent submit.
      const result = repository.transactWorkflows(shopId, (latest, notifications) => {
        const actual = C.find(latest.forms, formId);
        if (actual.access.hash !== form.access.hash || actual.access.revokedAt || actual.access.expiresAt <= at) C.fail('FORM_CLOSED', '입력 링크가 닫혔습니다.');
        const committed = W.execute(latest, command, { shopId, formId, actor: { id: formId, role: 'customer' }, at });
        project(notifications, committed); return committed;
      });
      return { formId, submissionVersion: result.result.submissionVersion, status: result.result.status, duplicate: result.duplicate };
    }
    return W.intake.publicView(form);
  }
  return { createService, publicRequest, hashToken, formLink, project };
});

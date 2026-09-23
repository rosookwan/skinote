(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'), require('./orders.js'));
  else root.SkiWorkflowFinance = factory(root.SkiWorkflowCommon, root.SkiWorkflowOrders);
})(globalThis, function (C, O) {
  'use strict';
  const LIMIT = Number.MAX_SAFE_INTEGER;
  const methods = ['cash', 'card', 'transfer'];
  const reasons = ['awaiting_payment', 'awaiting_refund', 'awaiting_return', 'awaiting_shop', 'scheduled', 'other'];
  const rows = (state, key) => state[key] || [];
  const money = (value, signed = false) => C.integer(value, signed ? -LIMIT : 0, LIMIT);
  const sum = values => values.reduce((total, value) => money(total + money(value, true), true), 0);
  const through = (row, date) => !date || C.day(row.at || row.createdAt) <= date;
  const on = (row, date) => C.day(row.at || row.createdAt) === date;
  function initialize(state) {
    for (const key of ['payments', 'adjustments', 'closings', 'cashEntries']) {
      if (state[key] == null) state[key] = [];
      if (!Array.isArray(state[key])) C.fail('INVALID_INPUT', '금전 원장 형식을 확인해 주세요.');
    }
    return state;
  }
  const closed = (state, date) => rows(state, 'closings').find(row => row.date === date && !(row.reopenings || []).length);
  function writable(state, context) {
    const date = C.day(context.at);
    if (closed(state, date)) C.fail('CLOSING_LOCKED', '오늘은 마감되었습니다. 관리자 재개 후 처리하거나 실제 다음 영업일에 기록해 주세요.');
    return date;
  }
  function identity(state, key, value) {
    const id = C.id(value);
    if (rows(state, key).some(row => row.id === id)) C.fail('ALREADY_EXISTS', '이미 기록한 관리번호입니다. 기존 원장을 확인해 주세요.');
    return id;
  }
  function lineAmounts(order, date) {
    return order.lines.filter(line => {
      const batch = order.batches.find(row => row.id === line.batchId);
      return through(batch || { createdAt: line.createdAt || order.createdAt }, date);
    }).map(line => {
      const cancelled = (order.cancellations || []).filter(row => through(row, date)).some(row => row.lineIds.includes(line.id));
      return { lineId: line.id, batchId: line.batchId, amountWon: cancelled ? 0 : money(line.price.amountWon) };
    });
  }
  function summary(state, orderId, date) {
    if (date) C.date(date);
    const order = C.find(state.orders || [], orderId, '통합접수');
    const payments = rows(state, 'payments').filter(row => row.orderId === orderId && through(row, date));
    const adjustments = rows(state, 'adjustments').filter(row => row.orderId === orderId && through(row, date));
    const lines = lineAmounts(order, date).map(line => ({ ...line,
      adjustmentWon: sum(adjustments.filter(row => row.lineId === line.lineId).map(row => row.amountWon)),
      netPaidWon: sum(payments.filter(row => ['payment', 'refund'].includes(row.kind)).flatMap(row => (row.allocations || []).filter(a => a.lineId === line.lineId).map(a => a.amountWon * (row.kind === 'refund' ? -1 : 1)))) }));
    const originalWon = sum([through(order, date) ? order.legacyChargeWon || 0 : 0, ...lines.map(line => line.amountWon)]);
    const chargedWon = sum([originalWon, ...adjustments.map(row => row.amountWon)]);
    const total = kind => sum(payments.filter(row => row.kind === kind).map(row => row.amountWon));
    const paymentWon = total('payment'), refundWon = total('refund'), netPaidWon = paymentWon - refundWon;
    const depositInWon = total('deposit_in'), depositOutWon = total('deposit_out');
    return { orderId, chargedWon, adjustmentWon: sum(adjustments.map(row => row.amountWon)), paymentWon, refundWon, netPaidWon,
      dueWon: Math.max(0, chargedWon - netPaidWon), creditWon: Math.max(0, netPaidWon - chargedWon),
      depositInWon, depositOutWon, depositHeldWon: depositInWon - depositOutWon, lines,
      unallocatedNetPaidWon: netPaidWon - sum(lines.map(line => line.netPaidWon)), payments: C.copy(payments), adjustments: C.copy(adjustments) };
  }
  function allocationRows(order, p, before) {
    if (p.allocations == null) return [];
    if (!['payment', 'refund'].includes(p.kind)) C.fail('INVALID_INPUT', '보증금은 대여 품목 금액과 별도로 기록해 주세요.');
    const allocations = C.list(p.allocations).map(row => {
      C.keys(row, ['lineId', 'amountWon']);
      const line = C.find(order.lines, row.lineId, '품목 행'), amountWon = C.integer(row.amountWon, 1, LIMIT);
      if (p.kind === 'refund' && amountWon > (before.lines.find(row => row.lineId === line.id)?.netPaidWon || 0)) C.fail('QUANTITY_EXCEEDED', '해당 품목에 배분해 받은 잔액보다 많이 환불할 수 없습니다.');
      return { lineId: line.id, amountWon };
    });
    if (new Set(allocations.map(row => row.lineId)).size !== allocations.length || sum(allocations.map(row => row.amountWon)) !== p.amountWon) C.fail('INVALID_INPUT', '품목별 배분액의 합계가 처리 금액과 같아야 하며 같은 행을 중복 배분할 수 없습니다.');
    return allocations;
  }
  function payment(state, p, context) {
    C.keys(p, ['id', 'orderId', 'kind', 'amountWon', 'method', 'payer', 'allocations', 'reason', 'externalReference']);
    const date = writable(state, context), id = identity(state, 'payments', p.id), order = C.find(state.orders || [], p.orderId, '통합접수');
    const kind = C.oneOf(p.kind, ['payment', 'refund', 'deposit_in', 'deposit_out']), amountWon = C.integer(p.amountWon, 1, LIMIT), method = C.oneOf(p.method, methods);
    const before = summary(state, order.id);
    if (kind === 'refund' && amountWon > before.netPaidWon) C.fail('QUANTITY_EXCEEDED', '고객에게 실제로 받은 대여대금 잔액보다 많이 환불할 수 없습니다.');
    if (kind === 'deposit_out' && amountWon > before.depositHeldWon) C.fail('QUANTITY_EXCEEDED', '보관 중인 보증금보다 많이 돌려줄 수 없습니다.');
    const allocations = allocationRows(order, p, before);
    // An unallocated refund must not erase money still attributed to a line.
    if (kind === 'refund' && !allocations.length && amountWon > before.unallocatedNetPaidWon) C.fail('INVALID_INPUT', '수납한 품목별 환불 배분을 지정해 주세요.');
    const externalReference = C.string(p.externalReference, 160, true);
    if (externalReference && state.payments.some(row => row.externalReference === externalReference && row.kind === kind && row.method === method)) C.fail('ALREADY_EXISTS', '같은 외부 거래번호가 이미 기록되어 있습니다.');
    const record = { id, orderId: order.id, kind, amountWon, method, allocations, payer: C.string(p.payer, 60, true),
      reason: C.string(p.reason, 300, !['refund', 'deposit_out'].includes(kind)), externalReference, date, at: context.at, actor: C.copy(context.actor) };
    state.payments.push(record);
    const after = summary(state, order.id);
    money(after.netPaidWon); money(after.depositHeldWon);
    return { paymentId: id, orderId: order.id, amountWon, kind, dueWon: after.dueWon, creditWon: after.creditWon, depositHeldWon: after.depositHeldWon };
  }
  function adjustment(state, p, context) {
    C.keys(p, ['id', 'orderId', 'lineId', 'amountWon', 'reason']);
    const date = writable(state, context), id = identity(state, 'adjustments', p.id), order = C.find(state.orders || [], p.orderId, '통합접수');
    const lineId = p.lineId == null ? null : C.find(order.lines, p.lineId, '품목 행').id;
    const amountWon = money(p.amountWon, true);
    if (!amountWon) C.fail('NO_CHANGE', '금액이 달라지는 조정을 입력해 주세요.');
    const chargedWon = sum([summary(state, order.id).chargedWon, amountWon]);
    if (chargedWon < 0) C.fail('INVALID_INPUT', '조정 후 청구액은 0원 이상이어야 합니다.');
    state.adjustments.push({ id, orderId: order.id, lineId, amountWon, reason: C.string(p.reason, 300), date, at: context.at, actor: C.copy(context.actor) });
    return { adjustmentId: id, orderId: order.id, chargedWon };
  }
  function cash(state, p, context) {
    C.keys(p, ['id', 'kind', 'amountWon', 'reason']);
    const date = writable(state, context), id = identity(state, 'cashEntries', p.id), kind = C.oneOf(p.kind, ['in', 'out']), amountWon = C.integer(p.amountWon, 1, LIMIT);
    state.cashEntries.push({ id, kind, amountWon, reason: C.string(p.reason, 300), date, at: context.at, actor: C.copy(context.actor) });
    return { cashEntryId: id, kind, amountWon };
  }
  function partnerBalances(partners) {
    return (partners || []).map(partner => ({ id: partner.id, name: partner.name, receivableWon: partner.receivableWon || 0, payableWon: partner.payableWon || 0,
      unallocatedPaymentWon: partner.unallocatedPaymentWon || 0, unallocatedReceiptWon: partner.unallocatedReceiptWon || 0, offsetWon: partner.offsetWon || 0,
      borrowedPendingQuantity: (partner.loans || []).reduce((n, row) => n + row.outstandingQuantity, 0), lentPendingQuantity: (partner.lendings || []).reduce((n, row) => n + row.outstandingQuantity, 0),
      agreementUnconfirmed: !(partner.agreements || []).length && ((partner.loans || []).length + (partner.lendings || []).length > 0) }));
  }
  function day(state, date, partners = []) {
    C.date(date);
    const payments = rows(state, 'payments').filter(row => on(row, date)), adjustments = rows(state, 'adjustments').filter(row => on(row, date)), cashEntries = rows(state, 'cashEntries').filter(row => on(row, date));
    const total = (kind, method) => sum(payments.filter(row => row.kind === kind && (!method || row.method === method)).map(row => row.amountWon));
    const byMethod = Object.fromEntries(methods.map(method => [method, { paymentWon: total('payment', method), refundWon: total('refund', method), depositInWon: total('deposit_in', method), depositOutWon: total('deposit_out', method) }]));
    const cashInWon = sum(cashEntries.filter(row => row.kind === 'in').map(row => row.amountWon)), cashOutWon = sum(cashEntries.filter(row => row.kind === 'out').map(row => row.amountWon));
    const previous = rows(state, 'closings').filter(row => row.date < date && !(row.reopenings || []).length).sort((a, b) => b.date.localeCompare(a.date))[0];
    const previousHandover = rows(state, 'closings').filter(row => row.date <= date).sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at)).at(-1);
    const orders = (state.orders || []).filter(order => through(order, date));
    const charges = orders.flatMap(order => [on(order, date) ? order.legacyChargeWon || 0 : 0, ...order.lines.filter(line => on(order.batches.find(batch => batch.id === line.batchId) || order, date)).map(line => line.price.amountWon),
      ...(order.cancellations || []).filter(row => on(row, date)).map(row => -row.amountWon)]);
    const handoverDefaults = orders.map(order => {
      const balance = summary(state, order.id, date), view = O.view(state, order), old = previousHandover?.snapshot.handover.find(row => row.orderId === order.id);
      const dueLines = view.lines.filter(line => (line.currentReturnDate || line.returnPlan.date) <= date && line.customerQuantity + line.vehicleQuantity + line.unknownQuantity > 0);
      const issues = [...(balance.dueWon ? ['payment'] : []), ...(balance.creditWon ? ['customer_credit'] : []), ...(balance.depositHeldWon ? ['deposit'] : []), ...dueLines.map(line => 'return:' + line.id)];
      if (!issues.length) return null;
      const newIssues = issues.filter(issue => !(old?.issues || []).includes(issue));
      return { orderId: order.id, customer: C.copy(order.customer), dueWon: balance.dueWon, creditWon: balance.creditWon, depositHeldWon: balance.depositHeldWon, issues, newIssues,
        returnPending: dueLines.length > 0, customerQuantity: sum(dueLines.map(line => line.customerQuantity)), vehicleQuantity: sum(dueLines.map(line => line.vehicleQuantity)),
        ...(old ? { reason: newIssues.length ? null : old.reason, assignee: old.assignee, nextDate: old.nextDate, note: old.note, carriedForward: !newIssues.length } : { reason: null, assignee: '', nextDate: null, note: '', carriedForward: false }) };
    }).filter(Boolean);
    const c = byMethod.cash;
    return { date, chargedWon: sum([...charges, ...adjustments.map(row => row.amountWon)]), adjustmentWon: sum(adjustments.map(row => row.amountWon)),
      paymentWon: total('payment'), refundWon: total('refund'), netReceivedWon: total('payment') - total('refund'), depositInWon: total('deposit_in'), depositOutWon: total('deposit_out'),
      byMethod, cashInWon, cashOutWon, cashMovementWon: sum([c.paymentWon, -c.refundWon, c.depositInWon, -c.depositOutWon, cashInWon, -cashOutWon]),
      openingCashWon: previous?.countedCashWon || 0, payments: C.copy(payments), adjustments: C.copy(adjustments), cashEntries: C.copy(cashEntries), handoverDefaults, handoverPhysicalBasis: 'current_custody', partnerBalances: partnerBalances(partners) };
  }
  function closeDay(state, p, context, partners) {
    C.keys(p, ['id', 'date', 'countedCashWon', 'openingCashWon', 'differenceReason', 'handover']);
    const date = C.date(p.date);
    if (date !== C.day(context.at)) C.fail('INVALID_INPUT', '실제 처리일의 마감만 확정할 수 있습니다. 지난 마감은 저장된 마감표에서 확인해 주세요.');
    if (closed(state, date)) C.fail('ALREADY_EXISTS', '이미 마감한 영업일입니다.');
    const id = identity(state, 'closings', p.id), report = day(state, date, partners), openingCashWon = money(p.openingCashWon ?? report.openingCashWon), countedCashWon = money(p.countedCashWon);
    const expectedCashWon = sum([openingCashWon, report.cashMovementWon]), differenceWon = sum([countedCashWon, -expectedCashWon]);
    const differenceReason = C.string(p.differenceReason, 300, differenceWon === 0);
    const supplied = p.handover == null ? [] : C.list(p.handover, 500, true);
    const seen = new Set();
    for (const row of supplied) {
      C.keys(row, ['orderId', 'reason', 'assignee', 'nextDate', 'note']); C.id(row.orderId);
      if (seen.has(row.orderId) || !report.handoverDefaults.some(item => item.orderId === row.orderId)) C.fail('INVALID_INPUT', '이월할 미처리 접수를 중복 없이 선택해 주세요.');
      seen.add(row.orderId);
    }
    const handover = report.handoverDefaults.map(item => {
      const selected = supplied.find(row => row.orderId === item.orderId) || item;
      if (!selected.reason || !selected.assignee) C.fail('INVALID_INPUT', '새 미처리 항목의 이월 사유와 담당자를 선택해 주세요.');
      const reason = C.oneOf(selected.reason, reasons);
      const nextDate = selected.nextDate == null ? null : C.date(selected.nextDate);
      return { ...item, reason, assignee: C.string(selected.assignee, 60), nextDate, note: C.string(selected.note, 300, reason !== 'other') };
    });
    const record = { id, date, openingCashWon, countedCashWon, expectedCashWon, differenceWon, differenceReason,
      at: context.at, actor: C.copy(context.actor), snapshot: { ...report, handover }, reopenings: [] };
    state.closings.push(record);
    return { closingId: id, date, expectedCashWon, countedCashWon, differenceWon, handoverCount: handover.length };
  }
  function handle(state, type, p, context, partners = []) {
    C.context(context); C.store(context); initialize(state);
    if (type === 'finance.payment') return payment(state, p, context);
    if (type === 'finance.adjustment') return adjustment(state, p, context);
    if (type === 'finance.cash') return cash(state, p, context);
    if (type === 'closing.close') return closeDay(state, p, context, partners);
    if (type === 'closing.reopen') {
      C.keys(p, ['id', 'reason']);
      if (!Array.isArray(context.actor.permissions) || !context.actor.permissions.includes('closing.reopen')) C.fail('FORBIDDEN', '마감 재개 권한이 있는 관리자가 처리해 주세요.');
      const record = C.find(state.closings, p.id, '마감표');
      if (record.reopenings.length) C.fail('NO_CHANGE', '이미 재개한 마감입니다.');
      if (record.date !== C.day(context.at)) C.fail('INVALID_INPUT', '지난 날짜의 마감은 수정하지 않습니다. 오늘 조정 내역으로 기록해 주세요.');
      record.reopenings.push({ at: context.at, actor: C.copy(context.actor), reason: C.string(p.reason, 300) });
      return { closingId: record.id, date: record.date, reopened: true };
    }
    C.fail('INVALID_INPUT', '지원하지 않는 금전 작업입니다.');
  }
  const closings = state => C.copy(rows(state, 'closings'));
  return { initialize, handle, summary, day, closings };
});

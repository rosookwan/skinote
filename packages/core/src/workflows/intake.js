(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'), require('./inventory.js'));
  else root.SkiWorkflowIntake = factory(root.SkiWorkflowCommon, root.SkiWorkflowInventory);
})(globalThis, function (C, I) {
  'use strict';
  const latestSubmitted = form => form.submissions.filter(s => s.status === 'submitted').at(-1) || null;
  const reviewed = form => form.reviews.at(-1) || null;
  function person(value, draft = false) {
    C.keys(value, ['id', 'name', 'equipment', 'heightCm', 'footMm', 'clothing', 'clothingSize', 'helmet']);
    if (typeof value.clothing !== 'boolean' || typeof value.helmet !== 'boolean') C.fail('INVALID_INPUT', '의류·헬멧 여부를 선택해 주세요.');
    return { id: C.id(value.id), name: C.string(value.name, 60, draft), equipment: value.equipment == null ? null : C.oneOf(value.equipment, ['ski', 'board']),
      heightCm: value.heightCm == null ? null : C.integer(value.heightCm, 60, 240), footMm: value.footMm == null ? null : C.integer(value.footMm, 130, 380),
      clothing: value.clothing, clothingSize: C.string(value.clothingSize, 24, true), helmet: value.helmet };
  }
  function people(values, draft = false) {
    const rows = C.list(values, 500, draft).map(value => person(value, draft));
    if (new Set(rows.map(p => p.id)).size !== rows.length) C.fail('INVALID_INPUT', '일행 관리번호가 중복되었습니다.');
    return rows;
  }
  function changes(before = [], after = []) {
    const result = [];
    for (const id of new Set([...before, ...after].map(p => p.id))) {
      const a = before.find(p => p.id === id), b = after.find(p => p.id === id);
      if (!a || !b) result.push({ personId: id, name: (b || a).name, type: !a ? 'added' : 'removed', fields: [] });
      else {
        const fields = Object.keys(b).filter(key => key !== 'id' && C.canonical(a[key]) !== C.canonical(b[key])).map(field => ({ field, before: a[field], after: b[field] }));
        if (fields.length) result.push({ personId: id, name: b.name, type: 'changed', fields });
      }
    }
    return result;
  }
  function handle(state, type, p, context) {
    if (type === 'intake.submit') {
      C.keys(p, ['id', 'people', 'status']);
      if (context.actor.role === 'driver' || (context.actor.role === 'customer' && context.formId !== p.id)) C.fail('FORBIDDEN', '이 입력폼에 접근할 수 없습니다.');
      const form = C.find(state.forms, p.id, '입력폼');
      if (form.access.revokedAt || form.access.expiresAt <= context.at) C.fail('FORM_CLOSED', '입력 링크가 만료되었거나 닫혔습니다.');
      const status = C.oneOf(p.status, ['draft', 'submitted']);
      const submission = { version: (form.submissions.at(-1)?.version || 0) + 1, people: people(p.people, status === 'draft'), status, at: context.at };
      if (form.orderPersonIds && submission.people.some(person => !form.orderPersonIds.includes(person.id))) C.fail('INVALID_INPUT', '요청받은 일행의 정보만 제출할 수 있습니다.');
      form.submissions.push(submission);
      return { formId: form.id, submissionVersion: submission.version, status };
    }
    C.store(context);
    if (type === 'intake.create') {
      C.keys(p, ['id', 'customer', 'expectedPeople', 'date', 'delivery', 'accessHash', 'expiresAt', 'orderId']);
      const formId = C.id(p.id);
      if (state.forms.some(f => f.id === formId)) C.fail('ALREADY_EXISTS', '이미 등록한 입력폼입니다.');
      if (!/^[a-f0-9]{64}$/.test(p.accessHash || '')) C.fail('INVALID_INPUT', '안전한 입력 링크를 생성해 주세요.');
      const expiresAt = C.instant(p.expiresAt);
      if (expiresAt <= context.at) C.fail('INVALID_INPUT', '입력 링크 만료 시각을 확인해 주세요.');
      let delivery = null;
      if (p.delivery) {
        C.keys(p.delivery, ['date', 'time', 'place', 'vehicleId']);
        delivery = { date: C.date(p.delivery.date), time: C.time(p.delivery.time), place: C.string(p.delivery.place), vehicleId: p.delivery.vehicleId ? C.id(p.delivery.vehicleId) : null };
      }
      state.forms.push({ id: formId, groupCode: 'T' + String(state.forms.length + 1).padStart(3, '0'), customer: C.customer(p.customer), expectedPeople: C.integer(p.expectedPeople, 1, 500), date: p.date ? C.date(p.date) : null,
        delivery, orderId: p.orderId ? C.id(p.orderId) : null, access: { hash: p.accessHash, expiresAt, revokedAt: null }, submissions: [], reviews: [], preparations: [], issues: [], createdAt: context.at });
      return { formId };
    }
    if (type === 'intake.renew') {
      C.keys(p, ['id', 'accessHash', 'expiresAt']); const form = C.find(state.forms, p.id);
      if (!/^[a-f0-9]{64}$/.test(p.accessHash || '') || p.accessHash === form.access.hash || C.instant(p.expiresAt) <= context.at) C.fail('INVALID_INPUT', '새 입력 링크와 만료 시각을 확인해 주세요.');
      form.access = { hash: p.accessHash, expiresAt: C.instant(p.expiresAt), revokedAt: null }; return { formId: form.id };
    }
    if (type === 'intake.revoke') {
      C.keys(p, ['id']); const form = C.find(state.forms, p.id); form.access.revokedAt = context.at; return { formId: form.id };
    }
    if (type === 'intake.review') {
      C.keys(p, ['id', 'submissionVersion', 'people']); const form = C.find(state.forms, p.id), submission = latestSubmitted(form);
      if (!submission || submission.version !== p.submissionVersion) C.fail('VERSION_CONFLICT', '최신 제출본을 확인해 주세요.');
      const rows = p.people ? people(p.people) : C.copy(submission.people);
      const review = { version: (reviewed(form)?.version || 0) + 1, sourceVersion: submission.version, people: rows, at: context.at, actor: context.actor.id };
      form.reviews.push(review);
      return { formId: form.id, reviewVersion: review.version };
    }
    if (type === 'intake.prepare') {
      C.keys(p, ['id', 'reviewVersion', 'personIds']); const form = C.find(state.forms, p.id), review = reviewed(form);
      if (!review || review.version !== p.reviewVersion) C.fail('VERSION_CONFLICT', '현재 매장 확정본을 확인해 주세요.');
      for (const id of C.ids(p.personIds)) {
        C.find(review.people, id);
        if (!form.preparations.some(r => r.reviewVersion === review.version && r.personId === id)) form.preparations.push({ personId: id, reviewVersion: review.version, at: context.at, actor: context.actor.id });
      }
      return { formId: form.id, reviewVersion: review.version };
    }
    if (type === 'intake.issue' || type === 'intake.dispatch') {
      C.keys(p, type === 'intake.issue' ? ['id', 'reviewVersion', 'people', 'from'] : ['id', 'reviewVersion', 'people', 'vehicleId', 'taskId', 'date', 'time', 'place']); const form = C.find(state.forms, p.id), review = reviewed(form);
      if (!review || review.version !== p.reviewVersion) C.fail('VERSION_CONFLICT', '현재 매장 확정본을 확인해 주세요.');
      if (latestSubmitted(form)?.version !== review.sourceVersion) C.fail('VERSION_CONFLICT', '고객이 수정한 최신 제출본을 먼저 확정해 주세요.');
      const selected = C.list(p.people).map(row => {
        C.keys(row, ['personId', 'assetIds', 'actualFootMm', 'actualEquipmentSize']); const personId = C.find(review.people, row.personId).id;
        if (form.issues.some(i => i.personId === personId) || !form.preparations.some(r => r.reviewVersion === review.version && r.personId === personId)) C.fail('NO_CHANGE', '준비를 마쳤고 아직 지급하지 않은 일행만 선택해 주세요.');
        const assetIds = C.ids(row.assetIds);
        if (assetIds.some(id => { const a = C.find(state.assets, id); return a.condition !== 'ready' || a.exchangeReservationId || a.componentBaseId; })) C.fail('INVALID_INPUT', '정상 미배정 장비를 선택해 주세요.');
        if (assetIds.some(id => C.find(state.assets, id).ticket)) C.fail('INVALID_INPUT', '리프트권은 예약 전달에서 처리해 주세요.');
        if ((form.dispatches || []).some(d => d.people.some(person => person.personId === personId) && C.find(state.tasks, d.taskId).status !== 'cancelled')) C.fail('NO_CHANGE', '이미 차량 배달에 배정한 일행입니다.');
        const person = C.find(review.people, personId), expected = [person.equipment, person.clothing ? 'clothing' : null, person.helmet ? 'helmet' : null].filter(Boolean).sort();
        const actual = assetIds.map(id => C.find(state.assets, id).sku).sort();
        if (C.canonical(expected) !== C.canonical(actual)) C.fail('INVALID_INPUT', '일행별 장비·의류·헬멧 수량을 확인해 주세요.');
        return { personId, assetIds, actualFootMm: row.actualFootMm == null ? null : C.integer(row.actualFootMm, 130, 380), actualEquipmentSize: C.string(row.actualEquipmentSize, 40, true), reviewVersion: review.version, at: context.at };
      });
      if (new Set(selected.map(r => r.personId)).size !== selected.length) C.fail('INVALID_INPUT', '일행을 중복 선택했습니다.');
      if (type === 'intake.dispatch') {
        const taskId = C.id(p.taskId), vehicleId = C.id(p.vehicleId);
        if (state.tasks.some(t => t.id === taskId)) C.fail('ALREADY_EXISTS', '이미 등록한 배달 업무입니다.');
        const task = { id: taskId, kind: 'delivery', vehicleId, date: C.date(p.date), time: C.time(p.time), place: C.string(p.place), customerId: form.id, title: form.customer.name + ' 장비 배달', assetIds: selected.flatMap(r => r.assetIds), status: 'waiting', createdAt: context.at, formId: form.id };
        const result = I.move(state, { kind: 'load', assetIds: task.assetIds, from: { kind: 'shop', id: state.shopId }, to: { kind: 'vehicle', id: vehicleId }, purpose: 'delivery' }, context);
        state.tasks.push(task); form.dispatches ||= []; form.dispatches.push({ taskId, reviewVersion: review.version, people: selected });
        return { ...result, formId: form.id, taskId };
      }
      const result = I.move(state, { kind: 'deliver', assetIds: selected.flatMap(r => r.assetIds), from: p.from, to: { kind: 'customer', id: form.id } }, context);
      C.find(state.movements, result.movementId).intakeId = form.id;
      form.issues.push(...selected);
      return { ...result, formId: form.id, issuedPeople: selected.length };
    }
    if (type === 'delivery.queue') {
      C.keys(p, ['id', 'formId']); const form = C.find(state.forms, p.formId); const deliveryId = C.id(p.id);
      if (form.access.revokedAt || form.access.expiresAt <= context.at) C.fail('FORM_CLOSED', '유효한 입력폼 링크가 필요합니다.');
      if (state.deliveries.some(d => d.id === deliveryId)) C.fail('ALREADY_EXISTS', '이미 준비한 발송 요청입니다.');
      state.deliveries.push({ id: deliveryId, formId: form.id, recipient: form.customer.phone, status: 'prepared', createdAt: context.at, attempts: [] });
      return { deliveryId, status: 'prepared' };
    }
    if (type === 'delivery.record') {
      C.keys(p, ['id', 'status', 'providerId', 'note']); const delivery = C.find(state.deliveries, p.id);
      const status = C.oneOf(p.status, ['sending', 'accepted', 'delivered', 'failed', 'unknown']);
      const transitions = { prepared: ['sending'], sending: ['accepted', 'delivered', 'failed', 'unknown'], unknown: ['accepted', 'delivered', 'failed'], accepted: ['delivered', 'failed'], failed: [], delivered: [] };
      if (!transitions[delivery.status].includes(status)) C.fail('NO_CHANGE', '발송 상태 전환을 확인해 주세요.');
      const providerId = C.string(p.providerId, 160, !['accepted', 'delivered'].includes(status));
      delivery.status = status; delivery.attempts.push({ status, providerId, note: C.string(p.note, 300, true), at: context.at });
      return { deliveryId: delivery.id, status };
    }
    C.fail('INVALID_INPUT', '지원하지 않는 입력폼 작업입니다.');
  }
  function view(state, form, at) {
    const { access, ...safe } = C.copy(form), latest = latestSubmitted(form), review = reviewed(form);
    const printed = state.printJobs.filter(j => j.kind === 'a4' && j.status === 'confirmed' && j.sources.some(s => s.formId === form.id)).at(-1);
    const printSource = printed?.sources.find(s => s.formId === form.id);
    const printedReview = printSource ? form.reviews.find(r => r.version === printSource.reviewVersion) : null;
    const customerChangesAfterPrint = printedReview && latest ? changes(form.submissions.find(s => s.version === printedReview.sourceVersion)?.people, latest.people) : [];
    const reviewChangesAfterPrint = printedReview && review ? changes(printedReview.people, review.people) : [];
    return { ...safe, linkStatus: access.revokedAt ? 'revoked' : at && access.expiresAt <= at ? 'expired' : 'active', expiresAt: access.expiresAt,
      submittedPeople: latest?.people.length || 0, expectedPeople: form.expectedPeople, partial: (latest?.people.length || 0) < form.expectedPeople,
      latestSubmissionVersion: latest?.version || 0, needsReview: !!latest && (!review || latest.version !== review.sourceVersion),
      changesSinceReview: review && latest ? changes(form.submissions.find(s => s.version === review.sourceVersion)?.people, latest.people) : [],
      changedAfterPrint: customerChangesAfterPrint.length > 0 || reviewChangesAfterPrint.length > 0,
      changesAfterPrint: customerChangesAfterPrint, reviewChangesAfterPrint,
      preparedPeople: form.preparations.filter(r => r.reviewVersion === review?.version).length, issuedPeople: form.issues.length };
  }
  function publicView(form) {
    const latest = form.submissions.at(-1);
    return { id: form.id, customer: C.copy(form.customer), expectedPeople: form.expectedPeople, date: form.date,
      submissionVersion: latest?.version || 0, status: latest?.status || 'empty', people: C.copy((latest?.people || form.requestedPeople || []).filter(person => !form.orderPersonIds || form.orderPersonIds.includes(person.id))), requestedPeople: C.copy(form.requestedPeople || []), requestedPersonIds: C.copy(form.orderPersonIds || []), remainingPersonIds: (form.orderPersonIds || []).filter(id => !(latest?.people || []).some(person => person.id === id)) };
  }
  return { handle, latestSubmitted, reviewed, changes, view, publicView };
});

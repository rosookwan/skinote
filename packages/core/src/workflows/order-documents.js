(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'), require('./orders.js'), require('./intake.js'), require('./documents.js'));
  else root.SkiWorkflowOrderDocuments = factory(root.SkiWorkflowCommon, root.SkiWorkflowOrders, root.SkiWorkflowIntake, root.SkiWorkflowDocuments);
})(globalThis, function (C, O, F, P) {
  'use strict';
  const canHandle = type => ['docs.formCreate', 'docs.formBind', 'docs.formApply', 'docs.orderPrint'].includes(type);
  const orderOf = (state, id) => C.find(state.orders || [], id, '통합접수');
  const customerOf = (state, order) => ({ ...C.copy(order.customer), ...((state.customerProfiles || []).find(profile => (profile.orderIds || []).includes(order.id))?.phone ? { phone: state.customerProfiles.find(profile => (profile.orderIds || []).includes(order.id)).phone } : {}) });
  function batchesOf(order, values) {
    const ids = values == null ? order.batches.map(batch => batch.id) : C.ids(values);
    return ids.map(id => C.find(order.batches, id, '접수 차수'));
  }
  const linesOf = (order, batches) => order.lines.filter(line => batches.some(batch => batch.id === line.batchId) && !(line.cancelledQuantity || 0));
  function linked(state, order, form) {
    if (form.orderId !== order.id || !(order.links || []).some(link => link.sourceType === 'form' && link.sourceId === form.id)) C.fail('FORBIDDEN', '이 접수에 명확하게 연결된 입력폼을 선택해 주세요.');
    return form;
  }
  function formCreate(state, p, context) {
    C.keys(p, ['orderId', 'id', 'batchIds', 'personIds', 'accessHash', 'expiresAt']); const order = orderOf(state, p.orderId), batches = batchesOf(order, p.batchIds);
    const lines = linesOf(order, batches).filter(line => line.category !== 'liftTicket'), eligibleIds = [...new Set(lines.map(line => line.personId).filter(Boolean))];
    const ids = p.personIds == null ? eligibleIds.filter(id => !C.find(order.people, id).preinput) : C.ids(p.personIds);
    if (!ids.length) C.fail('NO_CHANGE', '새로 입력할 일행이 없습니다. 기존 일행의 재확인은 대상을 직접 선택해 주세요.');
    if (ids.some(id => !eligibleIds.includes(id))) C.fail('INVALID_INPUT', '선택한 접수 차수의 장비 이용 일행을 선택해 주세요.');
    const requestedPeople = ids.map(id => {
      const person = C.find(order.people, id), input = person.preinput || {}, own = lines.filter(line => line.personId === id), equipment = [...new Set(own.filter(line => ['ski', 'board'].includes(line.sku)).map(line => line.sku))];
      return { id, name: input.name || person.name, equipment: equipment.length === 1 ? equipment[0] : null, heightCm: input.heightCm ?? null, footMm: input.footMm ?? null,
        clothing: own.some(line => line.category === 'clothing'), clothingSize: input.clothingSize || '', helmet: own.some(line => line.category === 'helmet') };
    });
    const dates = lines.filter(line => ids.includes(line.personId)).map(line => line.start).sort();
    const result = F.handle(state, 'intake.create', { id: p.id, orderId: order.id, customer: customerOf(state, order), expectedPeople: ids.length, date: dates[0], accessHash: p.accessHash, expiresAt: p.expiresAt }, context);
    const form = C.find(state.forms, result.formId);
    Object.assign(form, { orderPersonIds: ids.slice(), orderBatchIds: batches.map(batch => batch.id), orderPersonLinks: ids.map(id => ({ formPersonId: id, personId: id })), requestedPeople,
      orderRequest: { at: context.at, actor: C.copy(context.actor), batchLabels: batches.map(batch => batch.label || batch.id) } });
    (order.links ||= []).push({ sourceType: 'form', sourceId: form.id, at: context.at, actor: C.copy(context.actor), historicalMovement: false, custodyMerged: false });
    return { orderId: order.id, formId: form.id, requestedPersonIds: ids, batchIds: form.orderBatchIds.slice(), status: 'prepared' };
  }
  function formBind(state, p, context) {
    C.keys(p, ['orderId', 'formId', 'batchIds', 'personLinks']); const order = orderOf(state, p.orderId), form = linked(state, order, C.find(state.forms, p.formId)), batches = batchesOf(order, p.batchIds);
    if ((form.orderPersonLinks || []).length) C.fail('ALREADY_EXISTS', '이미 일행을 연결한 입력폼입니다. 기존 연결을 확인해 주세요.');
    const source = F.latestSubmitted(form) || F.reviewed(form);
    if (!source) C.fail('NOT_REVIEWED', '제출한 일행을 확인한 뒤 연결해 주세요.');
    const eligible = linesOf(order, batches).map(line => line.personId), links = C.list(p.personLinks).map(value => {
      C.keys(value, ['formPersonId', 'personId']); C.find(source.people, value.formPersonId, '입력폼 일행'); C.find(order.people, value.personId, '접수 일행');
      if (!eligible.includes(value.personId)) C.fail('INVALID_INPUT', '선택한 접수 차수의 일행을 연결해 주세요.');
      return { formPersonId: value.formPersonId, personId: value.personId };
    });
    if (new Set(links.map(link => link.personId)).size !== links.length || new Set(links.map(link => link.formPersonId)).size !== links.length) C.fail('INVALID_INPUT', '입력폼 일행과 접수 일행은 한 명씩 연결해 주세요.');
    form.orderPersonLinks = C.copy(links); form.orderPersonIds = links.map(link => link.formPersonId); form.orderBatchIds = batches.map(batch => batch.id);
    form.orderBinding = { links: C.copy(links), at: context.at, actor: C.copy(context.actor), custodyMerged: false };
    return { orderId: order.id, formId: form.id, linkedPeople: links.length, custodyMerged: false };
  }
  function formApply(state, p, context) {
    C.keys(p, ['orderId', 'formId', 'submissionVersion', 'people']); const order = orderOf(state, p.orderId), form = linked(state, order, C.find(state.forms, p.formId)), submitted = F.latestSubmitted(form);
    if (!submitted || submitted.version !== p.submissionVersion) C.fail('VERSION_CONFLICT', '최신 제출본을 확인한 뒤 적용해 주세요.');
    if (!(form.orderPersonLinks || []).length) C.fail('INVALID_INPUT', '입력폼 일행과 기존 접수 일행을 먼저 명확하게 연결해 주세요.');
    const selected = p.people == null ? submitted.people.filter(person => form.orderPersonLinks.some(link => link.formPersonId === person.id)) : C.list(p.people);
    if (selected.some(person => !form.orderPersonLinks.some(link => link.formPersonId === person.id))) C.fail('INVALID_INPUT', '이번 입력 요청에 연결한 일행만 적용할 수 있습니다.');
    const signature = C.canonical(selected);
    if ((order.preinputApplications || []).some(application => application.formId === form.id && application.submissionVersion === submitted.version && application.signature === signature)) C.fail('NO_CHANGE', '이 제출 내용은 이미 접수에 적용했습니다.');
    const reviewed = F.handle(state, 'intake.review', { id: form.id, submissionVersion: submitted.version, people: selected }, context);
    const review = F.reviewed(form), changes = review.people.map(person => {
      const target = C.find(order.people, C.find(form.orderPersonLinks.map(link => ({ id: link.formPersonId, personId: link.personId })), person.id).personId);
      const own = order.lines.filter(line => line.personId === target.id && !line.cancelledQuantity && (!form.orderBatchIds || form.orderBatchIds.includes(line.batchId)));
      const equipment = [...new Set(own.filter(line => ['ski', 'board'].includes(line.sku)).map(line => line.sku))];
      const expected = { equipment: equipment.length === 1 ? equipment[0] : null, clothing: own.some(line => line.category === 'clothing'), helmet: own.some(line => line.category === 'helmet') };
      const orderDifferences = Object.keys(expected).filter(field => (field !== 'equipment' || equipment.length <= 1) && person[field] !== expected[field]).map(field => ({ field, expected: expected[field], requested: person[field] }));
      const before = C.copy(target.preinput || null), after = { ...C.copy(person), id: target.id, sourceFormId: form.id, sourcePersonId: person.id, submissionVersion: submitted.version, reviewVersion: review.version, appliedAt: context.at, orderDifferences };
      target.preinput = after; return { personId: target.id, before, after: C.copy(after) };
    });
    (order.preinputApplications ||= []).push({ formId: form.id, submissionVersion: submitted.version, reviewVersion: review.version, signature, changes, at: context.at, actor: C.copy(context.actor) });
    return { ...reviewed, orderId: order.id, appliedPersonIds: changes.map(change => change.personId), needsOrderReview: changes.some(change => change.after.orderDifferences.length), remainingPersonIds: form.orderPersonLinks.filter(link => !review.people.some(person => person.id === link.formPersonId)).map(link => link.personId) };
  }
  function model(state, order, kind, batches, at) {
    const view = O.view(state, order), batchIds = batches.map(batch => batch.id), customer = customerOf(state, order);
    const rows = view.lines.filter(line => batchIds.includes(line.batchId) && !line.cancelledQuantity).map(line => {
      const batch = C.find(order.batches, line.batchId), person = order.people.find(person => person.id === line.personId), input = person?.preinput;
      const sizes = (line.preparedAssetIds || []).map(id => C.find(state.assets, id)).map(asset => ({ assetId: asset.id, size: asset.orderPreparation?.size || asset.size || '현장 확인' }));
      return { orderId: order.id, receiptNo: order.receiptNo || order.id, batchId: batch.id, batchLabel: batch.label || batch.id, additional: order.batches[0].id !== batch.id,
        lineId: line.id, personId: person?.id || null, personName: input?.name || person?.name || '팀 공용', label: line.label || C.find(state.catalog, line.sku).label,
        quantity: line.activeQuantity, unit: line.unit, start: line.start, end: line.end, pickupPlan: C.copy(line.pickupPlan), returnPlan: C.copy(line.returnPlan),
        heightCm: input?.heightCm ?? null, footMm: input?.footMm ?? null, clothingSize: input?.clothingSize || '', preparedSizes: sizes,
        issuedQuantity: line.issuedQuantity, unissuedQuantity: line.unissuedQuantity, customerQuantity: line.customerQuantity, orderDifferences: C.copy(input?.orderDifferences || []), inputSource: input ? { formId: input.sourceFormId, submissionVersion: input.submissionVersion, reviewVersion: input.reviewVersion } : null };
    });
    if (!rows.length) C.fail('NO_CHANGE', '출력할 미취소 품목이 없습니다.');
    const sources = batches.map(batch => ({ orderId: order.id, batchId: batch.id, lineIds: rows.filter(row => row.batchId === batch.id).map(row => row.lineId) }));
    const pages = []; for (let index = 0; index < rows.length; index += 14) pages.push({ number: pages.length + 1, rows: rows.slice(index, index + 14) });
    const labels = batches.flatMap(batch => [...new Set(rows.filter(row => row.batchId === batch.id).map(row => row.start))].flatMap(date => {
      const dated = rows.filter(row => row.batchId === batch.id && row.start === date), result = [];
      for (let index = 0; index < dated.length; index += 2) result.push({ orderId: order.id, receiptNo: order.receiptNo || order.id, batchId: batch.id, batchLabel: batch.label || batch.id, additional: order.batches[0].id !== batch.id,
        date, part: result.length + 1, parts: Math.ceil(dated.length / 2), rows: dated.slice(index, index + 2) });
      return result;
    }));
    return { template: 'order-preparation-v1', kind, generatedAt: at, orderId: order.id, receiptNo: order.receiptNo || order.id, customer, sources, rows, pages, labels,
      paper: kind === 'a4' ? { widthMm: 210, heightMm: 297, marginMm: 10 } : { widthMm: 80, heightMm: 50, marginMm: 3 } };
  }
  function orderPrint(state, p, context) {
    C.keys(p, ['orderId', 'id', 'kind', 'batchIds']); const order = orderOf(state, p.orderId), id = C.id(p.id), kind = C.oneOf(p.kind, ['a4', 'sticker']);
    if (state.printJobs.some(job => job.id === id)) C.fail('ALREADY_EXISTS', '이미 등록한 출력 요청입니다. 출력 이력에서 확인해 주세요.');
    const document = model(state, order, kind, batchesOf(order, p.batchIds), context.at);
    state.printJobs.push({ id, orderId: order.id, kind, status: 'queued', sources: C.copy(document.sources), document, createdAt: context.at, reprintOf: null, attempts: [] });
    return { orderId: order.id, printJobId: id, status: 'queued', batchIds: document.sources.map(source => source.batchId) };
  }
  const escape = P.escape, value = input => input == null || input === '' ? '현장 확인' : escape(input);
  function html(document) {
    const d = document, paper = d.paper;
    const css = '@page{size:' + paper.widthMm + 'mm ' + paper.heightMm + 'mm;margin:' + paper.marginMm + 'mm}*{box-sizing:border-box}body{margin:0;font-family:Arial,"Malgun Gothic",sans-serif;color:#111}section{break-after:page;page-break-after:always}section:last-child{break-after:auto}h1{margin:0 0 3mm;font-size:17pt}p{font-size:10pt;line-height:1.4;margin:0 0 3mm}table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:9pt}th,td{border:1px solid #555;padding:1.5mm;overflow-wrap:anywhere;vertical-align:top}th{background:#eee}tr{break-inside:avoid}small{font-size:8pt}.additional{font-weight:bold}.sticker{min-height:44mm;overflow-wrap:anywhere}.sticker h1{font-size:13pt}.sticker p{font-size:8.5pt;margin-bottom:1mm}@media screen{body{background:#eef0f4;padding:16px}section{background:white;width:' + (paper.widthMm - 2 * paper.marginMm) + 'mm;min-height:' + (paper.heightMm - 2 * paper.marginMm) + 'mm;padding:' + paper.marginMm + 'mm;box-sizing:content-box;margin:0 auto 16px;box-shadow:0 2px 8px #0002}.sticker{min-height:44mm}}';
    const body = d.kind === 'a4' ? d.pages.map(page => '<section><h1>' + escape(d.customer.name) + ' 팀 장비 준비표</h1><p>통합접수 ' + escape(d.receiptNo || d.orderId) + ' · ' + escape(d.customer.phone) + ' · ' + page.number + '/' + d.pages.length + '쪽</p><table><colgroup><col style="width:20%"><col style="width:17%"><col style="width:18%"><col style="width:20%"><col style="width:25%"></colgroup><thead><tr><th>접수 차수 / 이용일</th><th>일행</th><th>품목 / 수량</th><th>고객 입력</th><th>현장 준비 / 지급</th></tr></thead><tbody>' + page.rows.map(row => '<tr><td class="' + (row.additional ? 'additional' : '') + '">' + (row.additional ? '추가 · ' : '첫 접수 · ') + escape(row.batchLabel) + '<br><small>' + escape(row.batchId) + '<br>' + escape(row.start) + (row.end !== row.start ? '~' + escape(row.end) : '') + '</small></td><td>' + escape(row.personName) + '<br><small>' + escape(row.personId || '팀 공용') + '</small></td><td>' + escape(row.label) + ' ' + row.quantity + escape(row.unit) + '<br><small>' + escape(row.lineId) + '</small></td><td>키 ' + value(row.heightCm) + '<br>발 ' + value(row.footMm) + '<br>의류 ' + value(row.clothingSize) + (row.orderDifferences?.length ? '<br><b>요청 품목 차이 확인</b>' : '') + '</td><td>' + (row.preparedSizes.length ? row.preparedSizes.map(item => escape(item.size) + ' <small>(' + escape(item.assetId) + ')</small>').join('<br>') : '규격 현장 확인 □') + '<br>지급 ' + row.issuedQuantity + ' / 예정 ' + row.unissuedQuantity + '</td></tr>').join('') + '</tbody></table><p><small>고객 입력과 현장 준비 규격은 별도 기록입니다. 실제 지급은 POS 지급 확정으로 처리합니다.<br>출력 생성 ' + escape(d.generatedAt) + '</small></p></section>').join('')
      : d.labels.map(label => '<section class="sticker"><h1>' + escape(d.customer.name) + ' · ' + escape(label.receiptNo || d.receiptNo || label.orderId) + '</h1><p><b>' + (label.additional ? '추가 접수' : '첫 접수') + ' · ' + escape(label.batchLabel) + '</b><br>' + escape(label.batchId) + ' · 이용 ' + escape(label.date) + (label.parts > 1 ? ' · ' + label.part + '/' + label.parts + '장' : '') + '</p><p>' + label.rows.map(row => escape(row.label) + ' ' + row.quantity + escape(row.unit)).join(' · ') + '</p><p>' + escape(d.customer.phone) + '<br>접수 내역 기준 · 실제 지급은 POS 확인</p></section>').join('');
    return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>' + escape(d.receiptNo || d.orderId) + ' · 준비표</title><style>' + css + '</style></head><body>' + body + '</body></html>';
  }
  function handle(state, type, p, context) {
    C.context(context); C.store(context); O.initialize(state);
    if (type === 'docs.formCreate') return formCreate(state, p, context);
    if (type === 'docs.formBind') return formBind(state, p, context);
    if (type === 'docs.formApply') return formApply(state, p, context);
    if (type === 'docs.orderPrint') return orderPrint(state, p, context);
    C.fail('INVALID_INPUT', '지원하지 않는 사전입력·출력 작업입니다.');
  }
  return { canHandle, handle, model, html };
});

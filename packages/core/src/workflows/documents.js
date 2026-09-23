(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'), require('./intake.js'));
  else root.SkiWorkflowDocuments = factory(root.SkiWorkflowCommon, root.SkiWorkflowIntake);
})(globalThis, function (C, F) {
  'use strict';
  function model(state, kind, formIds, at, copies = 1) {
    const forms = C.ids(formIds).map(id => C.find(state.forms, id));
    const sources = forms.map(form => {
      const review = F.reviewed(form);
      if (!review) C.fail('NOT_REVIEWED', '매장에서 입력 내용을 확인한 뒤 출력해 주세요.');
      return { formId: form.id, reviewVersion: review.version, submissionVersion: review.sourceVersion };
    });
    if (kind === 'a4') {
      const rows = forms.flatMap(form => F.reviewed(form).people.map(person => ({ groupId: form.id, groupCode: form.groupCode, representative: form.customer.name, ...C.copy(person),
        preparationDate: form.date, actualIssue: C.copy(form.issues.find(i => i.personId === person.id) || null), reviewVersion: F.reviewed(form).version, submissionVersion: F.reviewed(form).sourceVersion })));
      const pages = [];
      for (let i = 0; i < rows.length; i += 20) pages.push({ number: pages.length + 1, rows: rows.slice(i, i + 20) });
      return { kind, paper: { widthMm: 210, heightMm: 297, marginMm: 10, rowsPerPage: 20 }, generatedAt: at, sources, peopleCount: rows.length, pages, copies: 1 };
    }
    C.oneOf(kind, ['labels']); C.integer(copies, 1, 10);
    const labels = forms.flatMap(form => {
      const review = F.reviewed(form), quantities = { ski: 0, board: 0, clothing: 0, helmet: 0 };
      for (const person of review.people) { if (person.equipment) quantities[person.equipment]++; if (person.clothing) quantities.clothing++; if (person.helmet) quantities.helmet++; }
      return Array.from({ length: copies }, (_, i) => ({ groupId: form.id, groupCode: form.groupCode, representative: form.customer.name, phone: form.customer.phone, quantities, delivery: C.copy(form.delivery),
        reviewVersion: review.version, submissionVersion: review.sourceVersion, copy: i + 1 }));
    });
    return { kind, paper: { widthMm: 80, heightMm: 50, marginMm: 3 }, generatedAt: at, sources, copies, labels };
  }
  function handle(state, type, p, context) {
    C.store(context);
    if (type === 'print.request') {
      C.keys(p, ['id', 'kind', 'formIds', 'copies', 'reprintOf']); const jobId = C.id(p.id);
      if (state.printJobs.some(j => j.id === jobId)) C.fail('ALREADY_EXISTS', '이미 등록한 출력 요청입니다.');
      const kind = C.oneOf(p.kind, ['a4', 'labels']);
      let data;
      if (p.reprintOf) {
        if (p.formIds || p.copies) C.fail('INVALID_INPUT', '재출력은 원본 출력 요청을 그대로 사용합니다.');
        const original = C.find(state.printJobs, p.reprintOf);
        if (original.kind !== kind) C.fail('INVALID_INPUT', '재출력 종류를 확인해 주세요.');
        data = C.copy(original.document);
      } else data = model(state, kind, p.formIds, context.at, p.copies || 1);
      const job = { id: jobId, kind, status: 'queued', sources: C.copy(data.sources), document: data, createdAt: context.at, reprintOf: p.reprintOf || null, attempts: [] };
      state.printJobs.push(job); return { printJobId: job.id, status: job.status };
    }
    if (type === 'print.record') {
      C.keys(p, ['id', 'status', 'device', 'note']); const job = C.find(state.printJobs, p.id);
      C.oneOf(p.status, ['dispatched', 'confirmed', 'failed', 'cancelled', 'unknown']);
      if (['confirmed', 'cancelled'].includes(job.status)) C.fail('NO_CHANGE', '종료된 출력 요청입니다. 재출력 요청을 만들어 주세요.');
      job.status = p.status; job.attempts.push({ status: p.status, device: C.string(p.device, 100, true), note: C.string(p.note, 300, true), at: context.at });
      return { printJobId: job.id, status: job.status };
    }
    C.fail('INVALID_INPUT', '지원하지 않는 출력 작업입니다.');
  }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const size = value => value == null ? '현장 확인' : escape(value);
  function html(document) {
    const p = document.paper;
    let css = '@page{size:' + p.widthMm + 'mm ' + p.heightMm + 'mm;margin:' + p.marginMm + 'mm}*{box-sizing:border-box}body{margin:0;color:#111;font-family:Arial,"Malgun Gothic",sans-serif}section{break-after:page;page-break-after:always}section:last-child{break-after:auto;page-break-after:auto}h1{font-size:16pt;margin:0 0 3mm}p{margin:0 0 3mm;font-size:10pt}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10.5pt}th,td{border:1px solid #555;padding:1mm;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}tr{height:9mm;break-inside:avoid}thead{display:table-header-group}th{background:#eee}.team-start td{border-top:2px solid #111}.small{font-size:8pt}.label{height:44mm;overflow:hidden}.label h1{font-size:18pt;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.label .phone{font-size:14pt;font-weight:bold}.label p{font-size:10pt;margin:0 0 1mm}';
    css += '@media screen{body{background:#eef0f4;padding:16px}section{background:#fff;width:' + (p.widthMm - 2 * p.marginMm) + 'mm;min-height:' + (p.heightMm - 2 * p.marginMm) + 'mm;box-sizing:content-box;padding:' + p.marginMm + 'mm;margin:0 auto 16px;box-shadow:0 2px 8px #0002}.label{height:44mm;min-height:44mm}}';
    const printedAt = new Date(Date.parse(document.generatedAt) + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
    let body;
    if (document.kind === 'a4') body = document.pages.map(page => '<section><h1>장비 준비표 · ' + document.peopleCount + '명</h1><p>' + escape(printedAt) + ' · ' + page.number + '/' + document.pages.length + '쪽 · 준비 ' + escape([...new Set(page.rows.map(r => r.preparationDate || '날짜 미정'))].join(' / ')) + ' · 키 cm / 발 mm</p><table><colgroup><col style="width:24%"><col style="width:14%"><col style="width:9%"><col style="width:10%"><col style="width:12%"><col style="width:13%"><col style="width:10%"><col style="width:8%"></colgroup><thead><tr><th>대표자 / 팀</th><th>이름</th><th>구분</th><th>키</th><th>발</th><th>의류</th><th>헬멧</th><th>준비</th></tr></thead><tbody>' + page.rows.map((r, i) => '<tr class="' + (!i || r.groupId !== page.rows[i - 1].groupId ? 'team-start' : '') + '"><td>' + escape(r.representative) + ' / ' + escape(r.groupCode) + '</td><td>' + escape(r.name) + '</td><td>' + (r.equipment === 'ski' ? '스키' : r.equipment === 'board' ? '보드' : '확인') + '</td><td>' + size(r.heightCm) + '</td><td>' + size(r.footMm) + '</td><td>' + (r.clothing ? escape(r.clothingSize || '현장 확인') : '없음') + '</td><td>' + (r.helmet ? '필요' : '없음') + '</td><td>□</td></tr>').join('') + '</tbody></table><p class="small">입력본 ' + escape([...new Set(page.rows.map(r => r.groupCode + ': 제출 ' + r.submissionVersion + ' / 확정 ' + r.reviewVersion))].join(' · ')) + '<br>사이즈는 고객 입력 기준입니다. 실제 지급 사이즈는 지급 기록에서 확인합니다.</p></section>').join('');
    else body = document.labels.map(l => '<section class="label"><h1>' + escape(l.representative) + ' · ' + escape(l.groupCode) + '</h1><p class="phone">' + escape(l.phone) + '</p><p>스키 ' + l.quantities.ski + ' · 보드 ' + l.quantities.board + ' · 의류 ' + l.quantities.clothing + ' · 헬멧 ' + l.quantities.helmet + '</p><p>' + escape(l.delivery ? [l.delivery.date, l.delivery.time, l.delivery.place].filter(Boolean).join(' · ') : '매장 수령') + '</p><p>입력 ' + l.submissionVersion + ' / 확정 ' + l.reviewVersion + ' · ' + escape(printedAt) + '</p></section>').join('');
    return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>스키샵 출력</title><style>' + css + '</style></head><body>' + body + '</body></html>';
  }
  return { model, handle, html, escape };
});

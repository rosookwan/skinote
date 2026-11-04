// 세 번째 검토(work/impl-offline/plan.md §17)의 기사 읽기 모델: 탭 · 묶음 · 바닥줄의 `완료`가 같은 셈(R3-15), 보내지 않은 도장의 업무 판 바닥줄은
// `처리 · 전송 대기`(R3-16), 보내는 동안 매장 반납된 팀의 줄이 남고 바닥줄 수가 맞음(R3-17), 보내지 않은 돈의 돈 줄 표시(R3-18), 매장 반납된 팀의 남은
// 줄은 반납 도장(R3-22), 적지 않은 기록의 메모(R3-26), 아직 지급하지 않은 팀은 끝나지 않음(R3-31).
import type { LedgerViewResult, StampCell } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { DEVICE_OUTCOME_NOTES, findOrder, ledgerView, outcomeNoteKey, overlayQueue, pendingLine, pendingSummary, routeTasks, runQuery, vehicleScope, type ShopState } from '../src/index.ts';
import { at, config, ctx, envelopeOf, first, lines, moveToVan, online } from './offline-helpers.ts';

const metric = (l: LedgerViewResult, key: string) => { const m = l.metrics.find((x) => x.metricKey === key); return m && 'value' in m ? m.value : undefined; };
const stampOf = (l: LedgerViewResult, taskId: string): StampCell => (Object.values(l.rows.find((r) => r.taskId === taskId)!.cells).find((c) => c.renderer === 'stamp') as { stamp: StampCell }).stamp;
const phone = (s: ShopState, extra: Record<string, unknown>, now = at(22, 20)) => ledgerView(s, 'collection_list', { vehicleId: 'v1', deviceClass: 'driver_phone' }, ctx(now, extra));

describe('collection list counts agree with the footer (R3-15 · R3-17)', () => {
  it('a record only waiting to be sent is not 완료 in the tab or the group; 전체 keeps it', () => {
    const copy = vehicleScope(first(), 'v1', { staffId: 'staff-3' });
    const c1 = envelopeOf(copy, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(copy, 'o25') } }, { deviceSeq: 1 });
    const c2 = envelopeOf(copy, { type: 'stock.collect', payload: { taskId: 'collect:o29', lines: lines(copy, 'o29') } }, { deviceSeq: 2 });
    const out = overlayQueue(copy, [{ envelope: c1, at: at(22, 0), state: 'queued' }, { envelope: c2, at: at(22, 1), state: 'queued' }]);
    const extra = { pendingTasks: out.pendingTasks, unconfirmedTasks: out.unconfirmedTasks };
    const before = phone(copy, {});
    const l = phone(out.state, extra);
    expect(l.tabCounts.collected).toBe(metric(l, 'collected_count'));
    expect(l.tabCounts.collected).toBe(before.tabCounts.collected);
    expect(metric(l, 'pending_count')).toBe(2);
    expect(l.tabCounts.all).toBe(before.tabCounts.all);
    for (const g of l.groups ?? []) {
      const inGroup = l.rows.filter((r) => r.groupKey === g.key);
      const beforeGroup = before.groups?.find((x) => x.key === g.key);
      if (inGroup.some((r) => r.taskId === 'collect:o25' || r.taskId === 'collect:o29')) expect(g.done).toBe(beforeGroup?.done);
    }
    // 전체는 점선 줄을 보이고, 완료 탭은 보이지 않는다.
    expect(stampOf(l, 'collect:o25').pending).toBe(true);
    const doneTab = ledgerView(out.state, 'collection_list', { vehicleId: 'v1', deviceClass: 'driver_phone', tabKey: 'collected' }, ctx(at(22, 20), extra));
    expect(doneTab.rows.some((r) => r.taskId === 'collect:o25')).toBe(false);
  });

  it('a team returned at the store while its queued collect is being sent stays in the list, and the footer counts it as 전송 대기', () => {
    const full = first();
    const copy = vehicleScope(full, 'v1', { staffId: 'staff-3' });
    const collect = envelopeOf(copy, { type: 'stock.collect', payload: { taskId: 'collect:o21', lines: lines(copy, 'o21') } }, { deviceSeq: 1 });
    // 그사이 카운터가 o21을 매장에서 모두 받았다(새 사본).
    expect(online(full, { type: 'stock.direct_return', payload: { orderId: 'o21', lines: findOrder(full, 'o21')!.lines.filter((l) => l.returnable).map((l) => ({ lineId: l.id, quantity: l.issued - l.returned })) } }, at(21, 50)).outcome).toBe('applied');
    const fresh = vehicleScope(full, 'v1', { staffId: 'staff-3', pendingTaskIds: ['collect:o21'] });
    const before = phone(copy, {});
    for (const state of ['sending', 'unconfirmed'] as const) {
      const out = overlayQueue(fresh, [{ envelope: collect, at: at(21, 40), state }]);
      const l = phone(out.state, { pendingTasks: out.pendingTasks, unconfirmedTasks: out.unconfirmedTasks });
      expect(l.rows.some((r) => r.taskId === 'collect:o21'), state).toBe(true);
      expect(l.tabCounts.all, state).toBe(before.tabCounts.all);
      expect(metric(l, 'pending_count'), state).toBe(1);
      expect(stampOf(l, 'collect:o21').pressNote?.lines[0], state).toMatch(state === 'sending' ? /처리 · 전송 대기$/ : /처리 · 결과 확인 중$/);
    }
  });

  it('the delivery list uses the same rule: a queued delivery is not 완료 in the group head or a 완료 tab (R3-15)', () => {
    const copy = vehicleScope(first(), 'v1', { staffId: 'staff-3' });
    const o26 = copy.orders.find((o) => o.id === 'o26')!;
    const deliver = envelopeOf(copy, { type: 'stock.deliver', payload: { taskId: 'deliver:o26', lines: o26.lines.map((l) => ({ lineId: l.id, quantity: l.qty })) } }, { deviceSeq: 1 });
    // 기본 설정의 배달 목록 탭은 전체 · 잔여다. 매장이 `완료` 탭을 더한 설정(설정 행)에서도 같은 셈인지 본다.
    const withDone = structuredClone(config);
    for (const v of withDone.ledgerViews) {
      if (v.key !== 'delivery_list' || !v.tabs) continue;
      const tabs = v.tabs;
      const tab = { ...tabs[0]!, tab_key: 'collected', label: '완료', filter_key: 'collected' as const, seq: 30 };
      v.tabs = [...tabs, tab];
    }
    const deliveries = (s: ShopState, extra: Record<string, unknown>) =>
      ledgerView(s, 'delivery_list', { vehicleId: 'v1', deviceClass: 'driver_phone' }, { config: withDone, now: at(17, 5), ...extra });
    const before = deliveries(copy, {});
    expect(before.tabCounts.collected).toBeDefined();
    const out = overlayQueue(copy, [{ envelope: deliver, at: at(17, 0), state: 'queued' }]);
    expect(out.outcomes.get(deliver.requestId)?.outcome).toBe('applied');
    const l = deliveries(out.state, { pendingTasks: out.pendingTasks, unconfirmedTasks: out.unconfirmedTasks });
    expect(l.tabCounts.collected).toBe(metric(l, 'collected_count'));
    expect(l.tabCounts.collected).toBe(before.tabCounts.collected);
    expect(l.tabCounts.all).toBe(before.tabCounts.all);
    const group = l.groups?.find((g) => l.rows.some((r) => r.taskId === 'deliver:o26' && r.groupKey === g.key));
    expect(group).toBeDefined();
    expect(group?.done).toBe(before.groups?.find((g) => g.key === group?.key)?.done);
    expect(metric(l, 'pending_count')).toBe(1);
    // 답이 오면(사본에 들면) 완료에 센다.
    const answered = overlayQueue(copy, [{ envelope: deliver, at: at(17, 0), state: 'answered', outcome: 'applied' }]);
    const after = deliveries(answered.state, { pendingTasks: answered.pendingTasks });
    expect(after.tabCounts.collected).toBe((before.tabCounts.collected ?? 0) + 1);
    expect(after.groups?.find((g) => g.key === group?.key)?.done).toBe((group?.done ?? 0) + 1);
  });

  it('a queued collect whose task left this van (moved to 2호, which collected it) still counts in the footer 전송 대기 until answered (R3-17)', () => {
    const full = first();
    const copy0 = vehicleScope(full, 'v1', { staffId: 'staff-3' });
    const collect = envelopeOf(copy0, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(copy0, 'o25') } }, { deviceSeq: 1 });
    // 그사이 카운터가 o25를 2호 차량으로 옮겼고 2호가 받았다. 새 사본은 보낼 기록 때문에 그 접수를 담지만 1호 차량의 일정에는 없다.
    moveToVan(full, 'o25', 'v2', at(21, 45));
    const moved = routeTasks(full, 'v2', full.businessDate).find((t) => t.order.id === 'o25')!;
    expect(moved.id).not.toBe('collect:o25');
    const got = online(full, { type: 'stock.collect', payload: { taskId: moved.id, lines: lines(full, 'o25') } }, at(21, 50));
    expect(got.outcome, JSON.stringify(got.error ?? null)).toBe('applied');
    const fresh = vehicleScope(full, 'v1', { staffId: 'staff-3', pendingTaskIds: ['collect:o25'] });
    const out = overlayQueue(fresh, [{ envelope: collect, at: at(21, 40), state: 'sending' }]);
    expect(out.pendingTasks.has('collect:o25')).toBe(true);
    expect(out.unplaced).toHaveLength(0);
    const l = phone(out.state, { pendingTasks: out.pendingTasks, unconfirmedTasks: out.unconfirmedTasks });
    expect(l.rows.some((r) => r.taskId === 'collect:o25')).toBe(false);
    // 줄은 없어도(1호 차량의 일이 아님) 띠의 `전송 대기 1`과 바닥줄의 수가 같다.
    expect(metric(l, 'pending_count')).toBe(1);
  });

  it('after the answer the store-returned row keeps the store’s 반납 stamp, not the van’s 수거 stamp (R3-22)', () => {
    const full = first();
    expect(online(full, { type: 'stock.direct_return', payload: { orderId: 'o21', lines: findOrder(full, 'o21')!.lines.filter((l) => l.returnable).map((l) => ({ lineId: l.id, quantity: l.issued - l.returned })) } }, at(21, 50)).outcome).toBe('applied');
    const copy = vehicleScope(full, 'v1', { staffId: 'staff-3' });
    const deviceOutcomes = new Map([['collect:o21', { key: 'returned' as const, at: at(22, 0) }]]);
    const l = phone(copy, { deviceOutcomes });
    const row = l.rows.find((r) => r.taskId === 'collect:o21')!;
    expect(row.reviewNote).toBe('매장 반납 완료');
    const stamp = stampOf(l, 'collect:o21');
    expect(stamp.stepKey).toBe('return');
    expect(stamp.stepKey).not.toBe('collect');
  });
});

describe('task sheet (R3-16 · R3-18 · R3-31)', () => {
  it('a finished task that is only queued reads `{시각} 처리 · 전송 대기` (or `결과 확인 중`), never 수거 완료', () => {
    const copy = vehicleScope(first(), 'v1', { staffId: 'staff-3' });
    const collect = envelopeOf(copy, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(copy, 'o25') } }, { deviceSeq: 1 });
    for (const [state, word] of [['queued', '전송 대기'], ['unconfirmed', '결과 확인 중']] as const) {
      const out = overlayQueue(copy, [{ envelope: collect, at: at(15, 40), state }]);
      const sheet = runQuery(out.state, 'taskSheet', { taskId: 'collect:o25', deviceClass: 'driver_tablet' }, ctx(at(15, 45), { pendingTasks: out.pendingTasks, unconfirmedTasks: out.unconfirmedTasks }));
      expect(sheet.progress).toBe('15:40 처리 · ' + word);
    }
    const answered = overlayQueue(copy, [{ envelope: collect, at: at(15, 40), state: 'answered', outcome: 'applied' }]);
    expect(runQuery(answered.state, 'taskSheet', { taskId: 'collect:o25', deviceClass: 'driver_tablet' }, ctx(at(15, 45), { pendingTasks: answered.pendingTasks })).progress).toBe('수거 완료 · 15:40');
  });

  it('a queued field payment adds `· 전송 대기` to the money line (`· 결과 확인 중` when the answer was lost)', () => {
    const copy = vehicleScope(first(), 'v1', { staffId: 'staff-3' });
    const sheet0 = runQuery(copy, 'fieldPaySheet', { taskId: 'collect:o28' }, ctx(at(15, 40)));
    const due = sheet0.expect?.dueAmount ?? 0;
    expect(due).toBeGreaterThan(0);
    const pay = envelopeOf(copy, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: due, methodKey: 'cash' } }, { deviceSeq: 1, expect: { dueAmount: due } });
    for (const [state, word] of [['queued', '전송 대기'], ['unconfirmed', '결과 확인 중']] as const) {
      const out = overlayQueue(copy, [{ envelope: pay, at: at(15, 40), state }]);
      expect(out.pendingMoney.get('o28')).toBe(state === 'unconfirmed');
      const sheet = runQuery(out.state, 'taskSheet', { taskId: 'collect:o28', deviceClass: 'driver_tablet' }, ctx(at(15, 45), { pendingMoney: out.pendingMoney }));
      const text = (sheet.money?.[0] ?? []).map((r) => r.text).join('');
      expect(text).toMatch(/^미수 없음 · 15:40 현금 수납 · /);
      expect(text.endsWith(' · ' + word)).toBe(true);
    }
    const answered = overlayQueue(copy, [{ envelope: pay, at: at(15, 40), state: 'answered', outcome: 'applied' }]);
    expect(answered.pendingMoney.size).toBe(0);
  });

  it('a collect task whose gear was never issued is not finished (the footer shows the list progress, 수거 실패 stays open)', () => {
    const s = first();
    // 박준호 팀(o22): 16:05에 매장에서 지급, 밤에 1호 차량 수거. 15:40에는 아무것도 내주지 않았다.
    const o = findOrder(s, 'o22')!;
    expect(o.giveBack).toMatchObject({ mode: 'vehicle', vehicleId: 'v1' });
    expect(o.lines.some((l) => l.returnable) && o.lines.every((l) => l.issued === 0)).toBe(true);
    const sheet = runQuery(s, 'taskSheet', { taskId: 'collect:o22', deviceClass: 'driver_tablet' }, ctx(at(15, 40)));
    expect(sheet.progress).toMatch(/^완료 \d+ · 잔여 \d+$/);
    expect(sheet.actions.find((a) => a.actionKey === 'not_collected')?.enabled).toBe(true);
    // 목록에서도 끝난 것이 아니다: 잔여에 세고 완료 탭에 없다.
    const l = ledgerView(s, 'collection_list', { vehicleId: 'v1', deviceClass: 'driver_tablet', tabKey: 'collected' }, ctx(at(15, 40)));
    expect(l.rows.some((r) => r.taskId === 'collect:o22')).toBe(false);
  });
});

describe('outcome notes (R3-26)', () => {
  it('every superseded outcome gets a note; known reasons keep their own note', () => {
    expect(outcomeNoteKey('superseded', [])).toBe('excluded');
    expect(DEVICE_OUTCOME_NOTES.excluded).toBe('처리 제외 · 매장 확인');
    expect(outcomeNoteKey('superseded', ['already_returned'])).toBe('returned');
    expect(outcomeNoteKey('applied', [])).toBeNull();
    expect(outcomeNoteKey('held', [])).toBe('held');
    for (const outcome of ['applied', 'partially_applied', 'superseded', 'needs_review', 'held']) {
      const key = outcomeNoteKey(outcome, []);
      // 적용한 것은 도장이 말하고, 적지 않은 것 · 보류는 메모가 말한다.
      expect(outcome === 'superseded' || outcome === 'held' ? key !== null : true).toBe(true);
    }
  });
});

describe('the pending list line (R3-19)', () => {
  it('names the team, the work, the money and the time the device made it (`김민수 · 0025 수거 21:42`)', () => {
    const copy = vehicleScope(first(), 'v1', { staffId: 'staff-3' });
    const collect = envelopeOf(copy, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(copy, 'o25') } }, { deviceSeq: 1 });
    const line = pendingLine(copy, collect, at(21, 42));
    expect(line).toEqual({ who: '김민수 · 0025', what: '수거', at: '21:42' });
    expect(pendingSummary(line)).toBe('김민수 · 0025 수거 21:42');
    const pay = envelopeOf(copy, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 120_000, methodKey: 'cash' } }, { deviceSeq: 2 });
    expect(pendingSummary(pendingLine(copy, pay, at(21, 45)))).toMatch(/^윤서준 · 0028 현장 수납 현금 120,000원 21:45$/);
    const visit = envelopeOf(copy, { type: 'task.visit', payload: { taskId: 'deliver:o26', outcomeKey: 'customer_absent' } }, { deviceSeq: 3 });
    expect(pendingLine(copy, visit, at(17, 5)).what).toBe('배달 실패');
    const absent = envelopeOf(copy, { type: 'task.visit', payload: { taskId: 'collect:o31', outcomeKey: 'customer_absent' } }, { deviceSeq: 4 });
    expect(pendingLine(copy, absent, at(22, 5)).what).toBe('수거 실패');
    // 사본에 없는 팀(옮겨져 빠짐) · 사본이 없음: 팀 없이 일 이름 · 시각.
    const gone = envelopeOf(copy, { type: 'stock.collect', payload: { taskId: 'collect:o999', lines: [] } }, { deviceSeq: 5 });
    expect(pendingLine(copy, gone, at(22, 10))).toEqual({ what: '수거', at: '22:10' });
    expect(pendingLine(undefined, pay, at(21, 45))).toEqual({ what: '현장 수납', money: '120,000원', at: '21:45' });
    // 연결이 있어야 하는 일(답을 잃은 온라인 명령)도 이름이 있다(영어 명령 이름이 화면에 나오지 않게).
    const receive = envelopeOf(copy, { type: 'stock.receive', payload: { vehicleId: 'v1', taskIds: [] } }, {});
    expect(pendingLine(copy, receive, at(22, 30))).toEqual({ what: '매장 입고', at: '22:30' });
  });
});

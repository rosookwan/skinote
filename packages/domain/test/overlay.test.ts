// 보냄 대기 겹치기(work/impl-offline/plan.md §5-5)와 기기의 확인 전 검사(§5-8): 사본 위에 대기 항목을 기기 번호 차례로 적용해 점선 도장 · 결과 확인
// 중 · 사본에 없는 항목을 센다. 확인 전 검사는 epoch를 보지 않고(창을 연 뒤 사본이 새로 와도 창이 실패하지 않음) 돈의 바탕 · 남은 수는 본다.
import { describe, expect, it } from 'vitest';
import { DEVICE_OUTCOME_NOTES, execute, findOrder, ledgerView, overlayQueue, PRODUCTION_LINES, vehicleScope } from '../src/index.ts';
import { at, ctx, envelopeOf, first, lines } from './offline-helpers.ts';

describe('overlayQueue', () => {
  it('applies items in device sequence order with their own time; answered items stay drawn but not dotted', () => {
    const copy = vehicleScope(first(), 'v1', { staffId: 'staff-3' });
    const collect = envelopeOf(copy, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(copy, 'o25') } }, { deviceSeq: 2 });
    const visit = envelopeOf(copy, { type: 'task.visit', payload: { taskId: 'collect:o29', outcomeKey: 'customer_absent' } }, { deviceSeq: 1 });
    const answered = envelopeOf(copy, { type: 'stock.collect', payload: { taskId: 'collect:o31', lines: lines(copy, 'o31') } }, { deviceSeq: 3 });
    const out = overlayQueue(copy, [
      { envelope: collect, at: at(22, 5), state: 'unconfirmed' },
      { envelope: visit, at: at(22, 0), state: 'queued' },
      { envelope: answered, at: at(22, 10), state: 'answered', outcome: 'applied' },
    ]);
    expect([...out.outcomes.keys()]).toEqual([visit.requestId, collect.requestId, answered.requestId]);
    expect(findOrder(out.state, 'o25')!.lines.map((l) => [l.collected, l.collectedAt])).toEqual([[4, at(22, 5)], [2, at(22, 5)]]);
    expect(findOrder(out.state, 'o31')!.lines[0]!.collected).toBe(3);
    expect([...out.pendingTasks]).toEqual(['collect:o25']);
    expect([...out.unconfirmedTasks]).toEqual(['collect:o25']);
    // 입력 사본은 그대로.
    expect(findOrder(copy, 'o25')!.lines[0]!.collected).toBe(0);
    // 목록은 점선 도장(대기 수 1).
    const list = ledgerView(out.state, 'collection_list', { vehicleId: 'v1', deviceClass: 'driver_phone' }, ctx(at(22, 20), { pendingTasks: out.pendingTasks }));
    const pending = list.metrics.find((m) => m.metricKey === 'pending_count');
    expect(pending && 'value' in pending ? pending.value : undefined).toBe(1);
  });

  it('items whose order is not in the copy are counted as unplaced, never dropped silently', () => {
    const copy = vehicleScope(first(), 'v1', { staffId: 'staff-3' });
    const stray = envelopeOf(copy, { type: 'stock.collect', payload: { taskId: 'collect:o999', lines: [] } }, { deviceSeq: 1 });
    const out = overlayQueue(copy, [{ envelope: stray, at: at(22, 0), state: 'queued' }]);
    expect(out.unplaced).toEqual([{ requestId: stray.requestId, taskId: 'collect:o999' }]);
  });
});

describe('prevalidate', () => {
  it('a copy refresh (new rev and epoch) while a dialog is open never makes its command fail', () => {
    const s = first();
    const env = envelopeOf(s, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(s, 'o25') } });
    const refreshed = { ...structuredClone(s), epoch: 'restored', rev: s.rev + 40 };
    const ctxOf = (prevalidate: boolean) => ({ now: at(22, 5), actor: { key: 'staff:staff-3', name: '박기사' }, outcomeOf: () => undefined, lines: PRODUCTION_LINES, ...(prevalidate ? { prevalidate } : {}) });
    expect(execute(refreshed, env, ctxOf(false)).outcome.error?.code).toBe('EPOCH_CHANGED');
    expect(execute(refreshed, env, ctxOf(true)).outcome.outcome).toBe('applied');
  });

  it('a changed due still conflicts, and a second collection of the same money in the overlay is refused', () => {
    const s = first();
    const ctxOf = { now: at(21, 0), actor: { key: 'staff:staff-3', name: '박기사', deviceId: 'dev-phone' }, outcomeOf: () => undefined, lines: PRODUCTION_LINES, prevalidate: true };
    const pay = (amount: number, due: number) => envelopeOf(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount, methodKey: 'cash' } }, { expect: { dueAmount: due } });
    expect(execute(s, pay(120_000, 100_000), ctxOf).outcome.error?.code).toBe('DUE_CHANGED');
    const once = execute(s, pay(120_000, 120_000), ctxOf);
    expect(once.outcome.outcome).toBe('applied');
    // 다른 화면(같은 기기)이 같은 돈을 다시: 겹친 상태에서는 받을 돈이 0이라 충돌(창이 다시 연다).
    expect(execute(once.state, pay(120_000, 120_000), ctxOf).outcome.error?.code).toBe('DUE_CHANGED');
  });
});

describe('기기의 읽기 문맥(§5-5 · §5-9, O18)', () => {
  it('배달 목록: 답을 잃은 배달의 누름 메모는 `결과 확인 중`, 사본 밖 항목은 바닥줄 전송 대기에 더한다', () => {
    const copy = vehicleScope(first(), 'v1', { staffId: 'staff-3' });
    const o26 = copy.orders.find((o) => o.id === 'o26')!;
    const deliver = envelopeOf(copy, { type: 'stock.deliver', payload: { taskId: 'deliver:o26', lines: o26.lines.map((l) => ({ lineId: l.id, quantity: l.qty })) } }, { deviceSeq: 1 });
    const out = overlayQueue(copy, [{ envelope: deliver, at: at(17, 0), state: 'unconfirmed' }]);
    expect(out.outcomes.get(deliver.requestId)?.outcome).toBe('applied');
    const list = ledgerView(out.state, 'delivery_list', { vehicleId: 'v1', deviceClass: 'driver_phone' }, ctx(at(17, 5), {
      pendingTasks: out.pendingTasks, unconfirmedTasks: out.unconfirmedTasks, unplacedCount: 2,
    }));
    const row = list.rows.find((r) => r.taskId === 'deliver:o26')!;
    const stamp = Object.values(row.cells).find((c) => c.renderer === 'stamp') as { stamp: { pending?: boolean; pressNote?: { lines: string[] } } };
    expect(stamp.stamp.pending).toBe(true);
    expect(stamp.stamp.pressNote?.lines).toEqual(['17:00 처리 · 결과 확인 중']);
    const pending = list.metrics.find((m) => m.metricKey === 'pending_count');
    expect(pending && 'value' in pending ? pending.value : undefined).toBe(3);
  });

  it('기기 자신의 답은 줄 메모(재방문보다 먼저), 카운터 판에는 없다', () => {
    const s = vehicleScope(first(), 'v1', { staffId: 'staff-3' });
    const deviceOutcomes = new Map([['collect:o25', { key: 'returned' as const, at: at(22, 0) }], ['collect:o29', { key: 'held' as const, at: at(22, 1) }]]);
    const driver = ledgerView(s, 'collection_list', { vehicleId: 'v1', deviceClass: 'driver_phone' }, ctx(at(22, 5), { deviceOutcomes }));
    expect(driver.rows.find((r) => r.taskId === 'collect:o25')?.reviewNote).toBe('매장 반납 완료');
    expect(driver.rows.find((r) => r.taskId === 'collect:o29')?.reviewNote).toBe('처리 보류 · 관리자 확인 필요');
    const counter = ledgerView(s, 'collection_list', { vehicleId: 'v1', deviceClass: 'pos' }, ctx(at(22, 5), { deviceOutcomes }));
    expect(counter.rows.find((r) => r.taskId === 'collect:o25')?.reviewNote).toBeUndefined();
    expect(DEVICE_OUTCOME_NOTES.collect_check).toBe('수거 수량 확인');
    expect(DEVICE_OUTCOME_NOTES.duplicate).toBe('중복 수납 의심');
  });
});

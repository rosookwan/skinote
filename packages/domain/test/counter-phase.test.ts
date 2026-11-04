// 세 단계는 표시 요약이다. 부분 반납·차량 미입고·미수가 완료로 숨지 않는지 확인한다.
import { defaultUiConfig } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { sampleDay } from '../src/sample/index.ts';
import { counterTeam } from '../src/views.ts';
import { charged, liveQty, nextDue } from '../src/rules.ts';
import { kstAt } from '../src/time.ts';

function sample() {
  const state = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
  const order = state.orders.find((o) => o.lines.some((l) => l.returnable && l.qty > 1))!;
  for (const line of order.lines) { line.issued = liveQty(line); line.returned = 0; line.collected = 0; line.received = 0; line.lost = 0; }
  order.payments = [{ id: 'counter-test-pay', amount: charged(order), methodKey: 'cash', at: kstAt('2026-12-26', 0, 15, 0) }];
  const ctx = { state, config: defaultUiConfig({ shopName: '시험 매장', timezone: 'Asia/Seoul' }), now: kstAt('2026-12-26', 0, 10, 0) };
  return { ctx, order, line: order.lines.find((l) => l.returnable && l.qty > 1)! };
}
describe('카운터 표시용 단계', () => {
  it('새 장부도 기존 장부의 지연 경계를 보존한다', () => {
    const {ctx,order}=sample();
    const due=nextDue(ctx.state,order);
    expect(counterTeam(ctx,order).lateAt).toBe(due?.lateAt === undefined ? undefined : new Date(due.lateAt).toISOString());
    for (const line of order.lines) if (line.returnable) line.returned=line.issued;
    expect(counterTeam(ctx,order).lateAt).toBeUndefined();
  });
  it('지급 전에는 접수, 지급 후 반납 전에는 렌탈이다', () => {
    const { ctx, order, line } = sample();
    expect(counterTeam(ctx, order).phase).toBe('rental');
    line.issued = 0;
    expect(counterTeam(ctx, order)).toMatchObject({ phase: 'intake', complete: false });
  });
  it('부분 반납은 반납·정산에 남고 미반납 수를 보여준다', () => {
    const { ctx, order, line } = sample(); line.returned = 1;
    const team = counterTeam(ctx, order);
    expect(team).toMatchObject({ phase: 'settlement', complete: false });
    expect(team.facts.some((p) => p.text.startsWith('미반납 '))).toBe(true);
  });
  it('차량 수거만 한 장비는 입고 완료로 표시하지 않는다', () => {
    const { ctx, order } = sample();
    for (const line of order.lines) if (line.returnable) line.collected = line.issued;
    expect(counterTeam(ctx, order)).toMatchObject({ phase: 'settlement', complete: false });
    expect(counterTeam(ctx, order).facts.some((p) => p.text.startsWith('미입고 '))).toBe(true);
  });
  it('매장 반납 후에도 미수가 있으면 완료 내역으로 숨지 않는다', () => {
    const { ctx, order } = sample();
    for (const line of order.lines) if (line.returnable) line.returned = line.issued;
    order.payments = [];
    expect(counterTeam(ctx, order)).toMatchObject({ phase: 'settlement', complete: false });
    expect(counterTeam(ctx, order).facts.some((p) => p.text.startsWith('미수 '))).toBe(true);
  });
});

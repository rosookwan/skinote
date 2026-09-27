// 확인 필요(features-1 plan §9-3 · §9-5): 체험판(FixtureClient)에서 15:40 견본 한 건 · 메뉴의 수, 기사 기기의 보냄 대기(연결 끊김 → 수거 → 카운터 매장
// 반납 → 다시 연결)가 만든 확인 필요(already_returned, 출처 sync), 줄의 버튼이 여는 곳(reviewPress), `확인`이 한 번만 끝내고 처리 완료 탭으로 가는지,
// 초과 수납의 환불 창이 수단을 바꿔 다시 묻고(withRefundMethod) 확정하면 사라지는지, 마감의 막는 단계, 경로(#/review · #/review/done)를 본다.
import { draftToEnvelope, openCommandDraft, type ConfirmCommand } from '@skinote/contract';
import type { FxState } from '@skinote/domain';
import { describe, expect, it } from 'vitest';
import { hrefFor, parseHash, screenRoute } from '../src/app/router.ts';
import { withRefundMethod } from '../src/components/RefundDialog.tsx';
import { reviewPress, reviewTabs } from '../src/screens/ReviewScreen.tsx';
import { DEMO_COUNTER_PERMISSIONS, FixtureClient } from '../src/fixture/fixture-client.ts';

const demo = (minutes = 0) => {
  const client = new FixtureClient({ realNow: () => 1_800_000_000_000, story: true });
  if (minutes) client.advanceClock(minutes);
  const state = () => (client as unknown as { state: FxState }).state;
  return { client, state };
};
const send = (client: FixtureClient, state: () => FxState, command: ConfirmCommand, extra: Parameters<typeof openCommandDraft>[2] = {}) =>
  client.command(draftToEnvelope(openCommandDraft(command, { epoch: state().epoch, rev: state().rev }, extra)));
const linesOf = (state: () => FxState, orderId: string) => state().orders.find((o) => o.id === orderId)!.lines.map((l) => ({ lineId: l.id, quantity: l.qty }));

describe('확인 필요 목록(체험판)', () => {
  it('15:40: 견본 한 건, 탭 `미처리 1` · `처리 완료`, 버튼이 여는 곳', async () => {
    const { client } = demo();
    const view = await client.query('reviewList', {});
    expect(view.count).toBe(1);
    const tabs = reviewTabs(view);
    expect(tabs.tabs.map((t) => [t.tab_key, t.label, t.shows_count])).toEqual([['open', '미처리', 1], ['done', '처리 완료', 0]]);
    expect(tabs.counts).toEqual({ open: 1 });
    const [resolve, slip] = view.items[0]!.choices!;
    expect(reviewPress(resolve!)).toEqual({ kind: 'resolve' });
    expect(reviewPress(slip!)).toEqual({ kind: 'route', route: { name: 'slip', orderId: 'o24' } });
    expect(reviewPress({ key: 'collections', label: '수거 목록', enabled: true, date: '2026-12-26', vehicleId: 'v1' })).toEqual({ kind: 'route', route: { name: 'collection', date: '2026-12-26', vehicleId: 'v1' } });
    expect(reviewPress({ key: 'tickets', label: '리프트권', enabled: true })).toEqual({ kind: 'route', route: { name: 'tickets', tab: 'status' } });
    expect(reviewPress({ key: 'refund', label: '환불 · 10,000원', enabled: true, orderId: 'o21' })).toEqual({ kind: 'refund', orderId: 'o21' });
    expect(reviewPress({ key: 'spare_load', label: '예비권 적재', enabled: true, vehicleId: 'v1' })).toEqual({ kind: 'spare', vehicleId: 'v1' });
    expect(reviewPress({ key: 'slip', label: '접수증', enabled: true })).toEqual({ kind: 'none' });
    expect(DEMO_COUNTER_PERMISSIONS).toContain('review.resolve');
  });

  it('기사 기기 연결 끊김 중의 수거(보냄 대기) → 카운터가 매장 반납 → 다시 연결: 줄마다 `매장 반납 완료 · 기사 수거 기록 제외`(출처 sync)', async () => {
    const { client, state } = demo();
    client.setDevice('driver');
    client.setOffline(true);
    const queued = await send(client, state, { type: 'stock.collect', payload: { taskId: 'collect:o21', lines: linesOf(state, 'o21') } });
    expect(queued.outcome).toBe('queued');
    client.setDevice('counter');
    expect((await send(client, state, { type: 'stock.direct_return', payload: { orderId: 'o21', lines: linesOf(state, 'o21') } })).outcome).toBe('applied');
    client.setOffline(false);
    const view = await client.query('reviewList', {});
    expect(view.count).toBe(3);
    expect(view.items.filter((x) => x.orderId === 'o21').map((x) => [x.kindKey, x.message, x.source])).toEqual([
      ['already_returned', '김민재 팀 스키 2대 매장 반납 완료 · 기사 수거 기록 제외', 'stored'],
      ['already_returned', '김민재 팀 의류 1벌 매장 반납 완료 · 기사 수거 기록 제외', 'stored'],
    ]);
    expect(state().reviews!.filter((r) => r.orderId === 'o21').every((r) => r.source === 'sync' && r.taskId === 'collect:o21')).toBe(true);

    // `확인`: 한 번만(같은 요청번호를 다시 보내도), 처리 완료 탭으로.
    const item = view.items.find((x) => x.orderId === 'o21')!;
    const command = item.choices![0]!.command!;
    const draft = openCommandDraft(command, view.basis);
    expect((await client.command(draftToEnvelope(draft))).outcome).toBe('applied');
    expect((await client.command(draftToEnvelope(draft))).outcome).toBe('applied');
    const after = await client.query('reviewList', {});
    expect(after.count).toBe(2);
    expect(after.done.map((x) => [x.id, x.resolvedLine])).toEqual([[item.id, '확인 완료 · 15:40']]);
  });

  it('초과 수납(보냄 대기 현장 수납): `환불 · 15,000원` → 환불 창(수단 현금 · 원래 수단) → 확정하면 사라진다', async () => {
    const { client, state } = demo(75);
    client.setDevice('driver');
    const sheet = await client.query('addTicketSheet', { taskId: 'deliver:o26' });
    expect(sheet.command).toBeDefined();
    const ticket = openCommandDraft(sheet.command!, sheet.basis, sheet.expect ? { expect: sheet.expect } : {});
    expect((await client.command(draftToEnvelope(ticket))).outcome).toBe('applied');
    client.setOffline(true);
    const collect: ConfirmCommand = { type: 'field.collect', payload: { taskId: 'deliver:o26', orderId: 'o26', amount: 50_000, methodKey: 'cash' } };
    expect((await send(client, state, collect, { expect: { dueAmount: 35_000 } })).outcome).toBe('queued');
    client.setOffline(false);
    client.setDevice('counter');
    const view = await client.query('reviewList', {});
    const item = view.items.find((x) => x.kindKey === 'overpaid')!;
    expect(item.choices!.map((c) => c.label)).toEqual(['환불 · 15,000원', '접수증']);
    const opened = await client.query('refundSheet', { orderId: 'o26' });
    expect(opened.title).toBe('환불 · 최하은 팀');
    expect(opened.primary.label).toBe('환불 · 현금 15,000원');
    const line = opened.refunds[0]!;
    expect(line.methods.map((m) => m.label)).toEqual(['현금']);
    const params = withRefundMethod({ orderId: 'o26' }, line.paymentId, 'cash');
    expect(params).toEqual({ orderId: 'o26', methods: { [line.paymentId]: 'cash' } });
    const again = await client.query('refundSheet', params);
    const draft = openCommandDraft({ type: 'payment.refund', payload: { orderId: 'o26', cause: 'overpaid', refunds: [] } }, opened.basis, { expect: again.expect! });
    expect((await client.command(draftToEnvelope(draft, {}, again.command))).outcome).toBe('applied');
    expect((await client.query('reviewList', {})).items.some((x) => x.kindKey === 'overpaid')).toBe(false);
  });

  it('마감의 막는 단계: 기사 기기에 보낼 기록이 있으면 마감 차례에 `1호 차량 기록 1건 전송 대기 · 마감 전 전송 필요`', async () => {
    const { client, state } = demo();
    const first = await client.query('closingSheet', {});
    const amount = first.next!.expectedAmount!;
    client.setDevice('driver');
    client.setOffline(true);
    expect((await send(client, state, { type: 'route.reset', payload: { vehicleId: 'v1', date: '2026-12-26' } })).outcome).toBe('queued');
    client.setDevice('counter');
    const sheet = await client.query('closingSheet', { counts: [{ drawerId: 'counter', countedAmount: amount, expectedAmount: amount }] });
    expect(sheet.next?.kind).toBe('close');
    expect(sheet.step?.message).toBe('1호 차량 기록 1건 전송 대기 · 마감 전 전송 필요');
    expect(sheet.step?.choices.map((c) => c.label)).toEqual(['재확인', '닫기']);
    client.setOffline(false);
    expect((await client.query('closingSheet', { counts: [{ drawerId: 'counter', countedAmount: amount, expectedAmount: amount }] })).step).toBeUndefined();
  });

  it('경로: #/review(미처리) · #/review/done(처리 완료), 메뉴 `확인 필요` → #/review', () => {
    expect(parseHash('#/review')).toEqual({ name: 'review', tab: 'open' });
    expect(parseHash('#/review/done')).toEqual({ name: 'review', tab: 'done' });
    expect(parseHash('#/review/other')).toEqual({ name: 'unknown' });
    expect(hrefFor({ name: 'review', tab: 'open' })).toBe('#/review');
    expect(hrefFor({ name: 'review', tab: 'done' })).toBe('#/review/done');
    expect(screenRoute('review_list')).toEqual({ name: 'review', tab: 'open' });
  });
});

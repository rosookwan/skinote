// 접수 취소 · 품목 취소 · 품목 추가(features-1 plan §5): 취소 창(CancelDialog)이 고른 것(수 · 구분 · 결정 · 수단)을 인자로 cancelSheet를 다시 묻고,
// 확정하면 창을 연 때의 요청번호로 취소 → 이어서 환불(dependsOn)을 보낸다. 품목 추가는 새 접수 화면의 ① 품목(orderDraft addTo)과 품목 추가의 확정 창
// (checkoutSheet addTo)이고, 경로는 #/orders/:orderId/add다. 수량 칸의 줄 수는 잰 창 높이의 모양 계산이다.
import {
  chainDrafts, envelopeFor, openCommandDraft, type AnyCommandEnvelope, type CancelSheetView, type CommandOutcome, type OrderDraftInput,
} from '@skinote/contract';
import { charged, ownDue, paidTotal, type FxState } from '@skinote/domain';
import { DEVICE_PROFILES } from '@skinote/ui';
import { describe, expect, it } from 'vitest';
import { hrefFor, parseHash } from '../src/app/router.ts';
import { withPayer } from '../src/components/CheckoutDialog.tsx';
import { cancelPieceRows, withCancelQuantity, withDecision, withMethod, withReason } from '../src/components/CancelDialog.tsx';
import { FixtureClient } from '../src/fixture/fixture-client.ts';

function demo() {
  const client = new FixtureClient({ realNow: () => 1_800_000_000_000 });
  const state = () => (client as unknown as { state: FxState }).state;
  return { client, state };
}

/** 창의 길: 연 때의 초안(요청번호 · basis) + 이어진 환불 초안 → 서버가 준 명령 · 바탕으로 봉투, 차례로 보낸다. */
async function confirm(client: FixtureClient, opened: CancelSheetView, view: CancelSheetView): Promise<CommandOutcome[]> {
  const draft = openCommandDraft({ type: 'order.cancel', payload: { orderId: 'x', scope: 'order', lines: [], reasonKey: 'request', decision: 'not_applicable' } }, opened.basis);
  const chain = view.then?.length ? chainDrafts(draft, view.then) : [];
  const envelopes = [envelopeFor(draft, view.command, view.expect), ...(view.then ?? []).map((step, i) => envelopeFor(chain[i]!, step.command, step.expect))];
  const out: CommandOutcome[] = [];
  for (const envelope of envelopes as AnyCommandEnvelope[]) {
    const outcome = await client.command(envelope);
    out.push(outcome);
    if (outcome.outcome !== 'applied') break;
  }
  return out;
}

const EMPTY: OrderDraftInput = { channel: 'walk_in', leader: { name: '', phone: '', party: 0 }, items: [], pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' } };

describe('취소 창(CancelDialog)', () => {
  it('박준호 팀 리프트권 품목 취소: 수를 올리면 돈 줄(환불 · 미수 결제 · 환불 없음), 미수 결제로 확정하면 장비 미수가 줄고 출처 줄', async () => {
    const { client, state } = demo();
    const opened = await client.query('cancelSheet', { orderId: 'o22', scope: 'lines' });
    expect(opened.lines.map((l) => l.label)).toEqual(['스키', '보드', '헬멧', '야간권 성인']);
    expect(opened.decisions).toBeUndefined();
    expect(opened.primary.enabled).toBe(false);
    let params = withCancelQuantity({ orderId: 'o22', scope: 'lines' }, opened, 'o22-l4', 3);
    const picked = await client.query('cancelSheet', params);
    expect(picked.decisions?.map((d) => [d.label, d.selected])).toEqual([['환불', true], ['미수 결제', false], ['환불 없음', false]]);
    params = withDecision(params, 'apply_to_due');
    const view = await client.query('cancelSheet', params);
    expect(view.refunds.map((r) => r.parts[0]!.text)).toEqual(['미수 결제 · 105,000원']);
    expect(view.primary.label).toBe('품목 취소 · 야간권 3매');
    expect((await confirm(client, opened, view)).map((o) => o.outcome)).toEqual(['applied']);
    const o = state().orders.find((x) => x.id === 'o22')!;
    expect(ownDue(o)).toBe(15_000);
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.adjustments?.map((a) => a.parts.map((p) => p.text).join(' · '))).toEqual(['품목 취소 · 야간권 3매', '미수 결제 · 105,000원']);
  });

  it('최하은 팀 접수 취소: 구분 `연락 없음`, 환불 줄을 현금으로 → 취소 · 환불, 모두 취소한 접수', async () => {
    const { client, state } = demo();
    const opened = await client.query('cancelSheet', { orderId: 'o26', scope: 'order' });
    expect(opened.reasons?.map((r) => r.label)).toEqual(['취소 요청', '연락 없음']);
    let params = withReason({ orderId: 'o26', scope: 'order' }, 'no_show');
    params = withMethod(params, opened.refunds[0]!.paymentId, 'cash');
    const view = await client.query('cancelSheet', params);
    expect(view.primary.label).toBe('접수 취소 · 환불 현금 135,000원');
    expect((await confirm(client, opened, view)).map((o) => o.outcome)).toEqual(['applied', 'applied']);
    const o = state().orders.find((x) => x.id === 'o26')!;
    expect([charged(o), paidTotal(o)]).toEqual([0, 0]);
    expect(o.cancellations?.[0]).toMatchObject({ scope: 'order', reasonKey: 'no_show', decision: 'refund' });
  });

  it('수량 칸의 줄 수는 잰 창 높이로(1024×529 두 줄, 1024×768 세 줄 끝), 적어도 한 줄', () => {
    const pos = DEVICE_PROFILES.pos;
    expect(cancelPieceRows(505, pos)).toBe(2);
    expect(cancelPieceRows(696, pos)).toBe(3);
    expect(cancelPieceRows(300, pos)).toBe(1);
  });
});

describe('품목 추가', () => {
  it('경로 #/orders/:orderId/add ↔ addItems', () => {
    expect(parseHash('#/orders/o21/add')).toEqual({ name: 'addItems', orderId: 'o21' });
    expect(hrefFor({ name: 'addItems', orderId: 'o21' })).toBe('#/orders/o21/add');
  });

  it('이서연 팀(결제 팀 이정호): ① 품목 → 확정 창의 결제 팀 줄 → 이 팀 결제 · 후불로 추가하면 그 줄은 이 팀 몫', async () => {
    const { client, state } = demo();
    const items = [{ productKey: 'helmet', variantKey: '중', quantity: 1 }];
    const draft = await client.query('orderDraft', { draft: { ...EMPTY, items }, addTo: 'o36' });
    expect(draft.add?.title).toBe('품목 추가 · 이서연 팀');
    const params = { draft: { ...EMPTY, items }, addTo: 'o36', choices: [{ sectionKey: 'gear', methodKey: 'later' }] };
    const opened = await client.query('checkoutSheet', params);
    expect(opened.payer.options.map((o) => o.label)).toEqual(['이정호 팀', '이 팀']);
    expect(opened.payer.find).toBe(false);
    const self = withPayer(params, 'self');
    expect(self.payer).toBe('self');
    const view = await client.query('checkoutSheet', self);
    expect(view.primary.label).toBe('추가 확정');
    const envelope = envelopeFor(openCommandDraft(view.command!, view.basis), view.command, view.expect)!;
    expect((await client.command(envelope)).outcome).toBe('applied');
    const o = state().orders.find((x) => x.id === 'o36')!;
    expect(o.lines.at(-1)).toMatchObject({ kind: 'helmet', payerOrderId: 'o36', batch: { source: 'counter' } });
  });
});

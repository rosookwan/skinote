// 할인 적용(features-1 plan §6): 접수증 옆 동작 `할인 적용`의 창(DiscountDialog)이 고른 것을 인자로 discountSheet를 다시 묻고, 확정하면 창을 연 때의
// 요청번호로 할인 적용 → 이어서 환불(dependsOn)을 보낸다. 접수 확정 창(V4)의 `직접 입력`은 같은 흐름(ManualDiscountFlow)이다. 체험판의 카운터
// (?viewer=counter)는 직접 입력 한도 10,000원이라 한도 밖은 숫자판에서 막히고, 명령도 `권한 없음 · 관리자 확인 필요`로 거절된다.
import {
  chainDrafts, CHECKOUT_KEYS, envelopeFor, openCommandDraft, type AnyCommandEnvelope, type CommandOutcome, type DiscountSheetParams, type DiscountSheetView,
  type OrderDraftInput,
} from '@skinote/contract';
import { charged, ownDue, paidTotal, type FxState } from '@skinote/domain';
import { describe, expect, it } from 'vitest';
import { withManualDiscount } from '../src/components/CheckoutDialog.tsx';
import { withChoice, withManual, withRefundMethod, withSection } from '../src/components/DiscountDialog.tsx';
import { manualAccepts, overLimit } from '../src/components/ManualDiscountFlow.tsx';
import { FixtureClient } from '../src/fixture/fixture-client.ts';

function demo(viewer?: 'counter') {
  const client = new FixtureClient({ realNow: () => 1_800_000_000_000, ...(viewer ? { viewer } : {}) });
  const state = () => (client as unknown as { state: FxState }).state;
  return { client, state };
}

/** 창의 길: 연 때의 초안(요청번호 · basis) + 이어진 환불 초안 → 서버가 준 명령 · 바탕으로 봉투, 차례로 보낸다. */
async function confirm(client: FixtureClient, opened: DiscountSheetView, view: DiscountSheetView): Promise<CommandOutcome[]> {
  const draft = openCommandDraft({ type: 'discount.apply', payload: { orderId: 'x', sectionKey: 'gear', choice: { none: true } } }, opened.basis);
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

describe('할인 적용 창(DiscountDialog)', () => {
  it('박준호 팀(장비 미수): 칸 · 할인을 골라 다시 묻고, 확정하면 미수가 줄고 접수증에 출처 줄', async () => {
    const { client, state } = demo();
    const opened = await client.query('discountSheet', { orderId: 'o22' });
    expect(opened.sections.map((s) => s.label)).toEqual(['장비', '리프트권']);
    expect(opened.choices.map((c) => c.label)).toEqual(['할인 없음', '10% 할인', '장비 5,000원 할인', '직접 입력']);
    const lift = await client.query('discountSheet', withSection({ orderId: 'o22' }, 'lift'));
    expect(lift.choices.map((c) => c.label)).toEqual(['할인 없음', '10% 할인', '리프트권 20% 할인', '직접 입력']);
    expect(lift.manual?.kinds.map((k) => k.key)).toEqual(['percent']);
    const params = withChoice({ orderId: 'o22' }, opened, 'ten_percent');
    const view = await client.query('discountSheet', params);
    expect(view.primary).toEqual({ label: '할인 적용 · 12,000원', alts: ['할인 적용 · 12,000원', '할인 적용'], enabled: true });
    const outcomes = await confirm(client, opened, view);
    expect(outcomes.map((o) => o.outcome)).toEqual(['applied']);
    const o = state().orders.find((x) => x.id === 'o22')!;
    expect(ownDue(o)).toBe(108_000);
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.adjustments?.map((a) => a.parts.map((p) => p.text).join(' · '))).toEqual(['장비 10% 할인']);
    expect(slip.activeConditions).toContain('order_open');
  });

  it('직접 입력 한도(체험 카운터 10,000원): 숫자판이 한도 밖을 받지 않고 한 줄, 한도 안은 적용', async () => {
    const { client } = demo('counter');
    const opened = await client.query('discountSheet', { orderId: 'o22' });
    const amount = opened.manual!.kinds.find((k) => k.key === 'amount')!;
    expect(amount.limit).toBe(10_000);
    expect(opened.manual!.overLimit).toBe('권한 없음 · 관리자 확인 필요');
    // 숫자판의 한 줄은 한도를 말한다(2026-09-27 점검: 권한은 있고 한도만 있다).
    expect(amount.overLimit).toBe('한도 10,000원 · 관리자 확인 필요');
    expect(manualAccepts(amount, '10000')).toBe(true);
    expect(manualAccepts(amount, '10010')).toBe(false);
    expect(overLimit(amount, '12000')).toBe(true);
    expect(manualAccepts(amount, '5005')).toBe(false);
    // 한도를 넘는 값을 인자로 물으면(화면을 거치지 않은 요청) 창이 막고, 명령도 거절된다.
    const over = await client.query('discountSheet', withManual({ orderId: 'o22' }, opened, { kind: 'amount', value: 20_000, reason: '단골' }));
    expect(over.notice).toBe('권한 없음 · 관리자 확인 필요');
    const forced = await client.command({
      type: 'discount.apply', commandVersion: 1, requestId: '01K62M3QG0000000000000000A', basis: opened.basis, expect: { dueAmount: 120_000 },
      payload: { orderId: 'o22', sectionKey: 'gear', choice: { manual: { kind: 'amount', value: 20_000, reason: '단골' } } },
    });
    expect(forced.error?.code).toBe('FORBIDDEN');
    const ok = await client.query('discountSheet', withManual({ orderId: 'o22' }, opened, { kind: 'amount', value: 10_000, reason: '단골' }));
    expect(ok.primary.enabled).toBe(true);
    expect((await confirm(client, opened, ok)).map((o) => o.outcome)).toEqual(['applied']);
  });

  it('결제 뒤(김민재 카드): 환불 줄의 수단을 현금으로 바꿔 확정하면 할인 적용 → 환불이 이어서 적용된다', async () => {
    const { client, state } = demo();
    const opened = await client.query('discountSheet', { orderId: 'o21' });
    const params: DiscountSheetParams = withChoice({ orderId: 'o21' }, opened, 'ten_percent');
    const first = await client.query('discountSheet', params);
    expect(first.refunds.map((r) => r.parts.map((p) => p.text).join(' · '))).toEqual(['환불 · 카드 10,000원 · 단말기 취소']);
    const cash = await client.query('discountSheet', withRefundMethod(params, first, first.refunds[0]!.paymentId, 'cash'));
    expect(cash.primary.label).toBe('할인 적용 · 환불 현금 10,000원');
    expect((await confirm(client, opened, cash)).map((o) => o.outcome)).toEqual(['applied', 'applied']);
    const o = state().orders.find((x) => x.id === 'o21')!;
    expect([charged(o), paidTotal(o), ownDue(o)]).toEqual([90_000, 90_000, 0]);
    const closing = await client.query('closingSheet', {});
    expect(closing.methods.find((m) => m.key === 'refund')).toMatchObject({ label: '환불', count: 1, amount: -10_000 });
  });

  it('카운터(체험 ?viewer=counter)의 접수증 옆 동작: 할인 적용 권한이 있으면 보이고, 없는 권한은 deniedPermissions로 빠진다', async () => {
    const { client } = demo('counter');
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.deniedPermissions ?? []).not.toContain('discount.apply');
  });
});

describe('접수 확정 창(V4)의 직접 입력', () => {
  const draft: OrderDraftInput = {
    channel: 'walk_in', leader: { name: '할인손님', phone: '01000000077', party: 2 }, items: [{ productKey: 'ski', quantity: 2 }],
    pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' },
  };
  it('`직접 입력`을 고르면 칸의 할인이 key manual과 값 · 사유가 되고, 다시 물은 상태 글에 값이 보인다', async () => {
    const { client } = demo();
    const view = await client.query('checkoutSheet', { draft });
    const gear = view.sections.find((s) => s.key === 'gear')!;
    expect(gear.discounts?.at(-1)).toMatchObject({ key: CHECKOUT_KEYS.manual, label: '직접 입력', opens: true, enabled: true });
    const params = withManualDiscount({ draft }, view, 'gear', { kind: 'percent', value: 15, reason: '단골' });
    expect(params.choices?.find((c) => c.sectionKey === 'gear')).toEqual({ sectionKey: 'gear', methodKey: 'card', discountKey: 'manual', manual: { kind: 'percent', value: 15, reason: '단골' } });
    const next = await client.query('checkoutSheet', params);
    expect(next.sections.find((s) => s.key === 'gear')!.discount).toBe('할인 직접 입력 · 15% · 80,000원 → 68,000원');
    expect(next.primary.label).toBe('접수 확정 · 카드 68,000원');
  });
});

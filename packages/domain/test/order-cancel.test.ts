// 접수 취소 · 품목 취소(features-1 plan §5-1 · §5-4 · §5-6): 창(cancelSheet)이 써 준 명령과 이어진 환불(payment.refund, cause 'cancellation')을 차례로
// 보내고, 명령마다 돈이 맞는지(assertMoney · assertMoneyViews)와 같은 요청번호를 두 번 보내도 한 번만 적용되는지를 본다.
import {
  defaultUiConfig, draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type CancelSheetParams, type CheckoutChoice, type ConfirmCommand, type Expect,
  type OrderDraftInput, type UiConfig,
} from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import {
  applyCommand, cancellableQty, charged, checkoutPlan, closingSheet, deliverTasks, findOrder, isCancelledOrder, kstAt, leftover, ledgerView, linePaid, liveQty,
  orderConditions, orderSlip, overpaid, ownDue, paidTotal, runQuery, type ShopState,
} from '../src/index.ts';
import { sampleDay } from '../src/sample/index.ts';
import { assertMoney, assertMoneyViews } from './money-check.ts';

const at = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const NOW = at(15, 40);
const config: UiConfig = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
const first = (): ShopState => sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
const ctx = (now = NOW) => ({ config, now });

let seq = 0;
const rid = () => '01K62M2QG00000000000001' + String(++seq).padStart(3, '0');
function envelopeOf(state: ShopState, command: ConfirmCommand, extra: { expect?: Expect; dependsOn?: string[]; requestId?: string; deviceSeq?: number } = {}): AnyCommandEnvelope {
  const draft = openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, {
    requestId: extra.requestId ?? rid(), ...(extra.expect ? { expect: extra.expect } : {}), ...(extra.dependsOn ? { dependsOn: extra.dependsOn } : {}),
  });
  return draftToEnvelope(draft, extra.deviceSeq !== undefined ? { deviceSeq: extra.deviceSeq } : {});
}
const order = (state: ShopState, id: string) => findOrder(state, id)!;

/** 창(cancelSheet)이 써 준 명령 · 이어진 환불을 차례로 보낸다(창의 길 그대로: 앞 명령이 적용되면 다음). */
function sendSheet(state: ShopState, params: CancelSheetParams, now = NOW) {
  const view = runQuery(state, 'cancelSheet', params, ctx(now));
  if (!view.command) return { view, outcomes: [] as ReturnType<typeof applyCommand>[] };
  const firstEnv = envelopeOf(state, view.command, view.expect ? { expect: view.expect } : {});
  const outcomes = [applyCommand(state, firstEnv, now)];
  let previous = firstEnv.requestId;
  for (const step of view.then ?? []) {
    if (outcomes.at(-1)!.outcome !== 'applied') break;
    const next = envelopeOf(state, step.command, { ...(step.expect ? { expect: step.expect } : {}), dependsOn: [previous] });
    outcomes.push(applyCommand(state, next, now));
    previous = next.requestId;
  }
  return { view, outcomes, first: firstEnv };
}

const check = (s: ShopState, ...ids: string[]) => {
  assertMoney(s);
  for (const id of ids) assertMoneyViews(s, id, NOW);
};

describe('접수 취소(order.cancel scope order)', () => {
  it('박준호(전화 예약 · 리프트권 선입금 105,000원): 환불 → 계좌이체 105,000원, 모두 취소, 장부 `취소` 흐린 줄', () => {
    const s = first();
    const view = runQuery(s, 'cancelSheet', { orderId: 'o22', scope: 'order' }, ctx());
    expect(view.title).toBe('접수 취소 · 박준호 팀');
    expect(view.reasons?.map((r) => [r.label, r.selected])).toEqual([['취소 요청', true], ['연락 없음', false]]);
    expect(view.decisions?.map((d) => d.label)).toEqual(['환불', '환불 없음']);
    expect(view.decision).toBe('refund');
    expect(view.refunds.map((r) => r.parts.map((p) => p.text).join(' · '))).toEqual(['환불 · 계좌이체 105,000원']);
    expect(view.refunds[0]!.methods.map((m) => m.label)).toEqual(['계좌이체', '현금']);
    expect(view.summary[0]!.map((r) => r.text).join('')).toBe('취소 금액 225,000원 · 환불 105,000원');
    expect(view.primary.label).toBe('접수 취소 · 환불 계좌이체 105,000원');
    const { outcomes } = sendSheet(s, { orderId: 'o22', scope: 'order', reasonKey: 'no_show' });
    expect(outcomes.map((x) => x.outcome)).toEqual(['applied', 'applied']);
    const o = order(s, 'o22');
    expect(isCancelledOrder(o)).toBe(true);
    expect(o.lines.map(liveQty)).toEqual([0, 0, 0, 0]);
    expect(charged(o)).toBe(0);
    expect(paidTotal(o)).toBe(0);
    expect(o.refunds?.map((r) => [r.methodKey, r.amount, r.section, r.cause.kind, r.reason])).toEqual([['transfer', 105_000, 'lift', 'cancellation', '접수 취소 · 연락 없음']]);
    expect(o.cancellations?.[0]).toMatchObject({ scope: 'order', reasonKey: 'no_show', decision: 'refund' });
    const slip = orderSlip({ state: s, config, now: NOW }, 'o22')!;
    expect(slip.adjustments?.map((a) => [a.parts.map((p) => p.text).join(' · '), a.amount ?? null, a.tone ?? null])).toEqual([
      ['접수 취소 · 연락 없음', -225_000, null], ['환불 · 계좌이체 105,000원', null, 'muted'],
    ]);
    expect(slip.activeConditions).not.toContain('order_open');
    expect(slip.activeConditions).not.toContain('cancellable');
    const ledger = ledgerView(s, 'day_ledger', {}, ctx());
    const row = ledger.rows.find((r) => r.orderId === 'o22')!;
    expect(row.statusWord).toBe('취소');
    expect(row.finished).toBe(true);
    expect(row.lateAt).toBeUndefined();
    const time = row.cells.time;
    expect(time?.renderer === 'time' ? time.parts.map((p) => p.text) : []).toContain('취소');
    check(s, 'o22');
    // 마감: 환불 한 줄(계좌이체).
    const closing = closingSheet({ state: s, config, now: at(23, 30) }, {});
    expect(closing.methods.find((m) => m.key === 'refund')).toMatchObject({ label: '환불', count: 1, amount: -105_000 });
  });

  it('환불 없음: 줄마다 수납 유지(청구 = 받은 돈), 초과 수납 없음 · 미수 없음', () => {
    const s = first();
    const { outcomes, view } = sendSheet(s, { orderId: 'o22', scope: 'order', decision: 'no_refund' });
    expect(view.refunds.map((r) => r.parts.map((p) => p.text).join(' · '))).toEqual(['환불 없음 · 수납 유지 105,000원']);
    expect(view.primary.label).toBe('접수 취소');
    expect(outcomes.map((x) => x.outcome)).toEqual(['applied']);
    const o = order(s, 'o22');
    expect(charged(o)).toBe(105_000);
    expect(overpaid(o)).toBe(0);
    expect(ownDue(o)).toBe(0);
    expect((o.charges ?? []).filter((c) => c.kind === 'cancellation_fee').map((c) => [c.lineId, c.amount])).toEqual([['o22-l4', 105_000]]);
    check(s, 'o22');
  });

  it('최하은(배달 적재 전 · 계좌이체로 모두 받음): 환불 135,000원을 현금으로, 1호 차량 배달 목록에서 빠진다', () => {
    const s = first();
    const paymentId = order(s, 'o26').payments[0]!.id;
    const { outcomes } = sendSheet(s, { orderId: 'o26', scope: 'order', methods: { [paymentId]: 'cash' } });
    expect(outcomes.map((x) => x.outcome)).toEqual(['applied', 'applied']);
    const o = order(s, 'o26');
    expect(o.refunds?.map((r) => [r.methodKey, r.amount, r.drawerId])).toEqual([['cash', 135_000, 'counter']]);
    expect(deliverTasks(s, 'v1', s.businessDate).map((t) => t.order.id)).not.toContain('o26');
    check(s, 'o26');
  });

  it('지급한 것이 손님에게 있으면 접수 취소 불가(`취소 불가 · 미반납 …`), 돌려받은 뒤에는 된다', () => {
    const s = first();
    const view = runQuery(s, 'cancelSheet', { orderId: 'o21', scope: 'order' }, ctx());
    expect(view.notice).toBe('취소 불가 · 미반납 스키 2 · 의류 1');
    expect(view.command).toBeUndefined();
    expect(orderConditions(s, order(s, 'o21'))).not.toContain('cancellable');
    // 최은정(모두 반납함): 접수 취소 가능, 반납한 것도 취소.
    const back = runQuery(s, 'cancelSheet', { orderId: 'o24', scope: 'order' }, ctx());
    expect(back.notice).toBeUndefined();
    expect(back.command).toBeDefined();
  });

  it('같은 요청번호를 두 번 보내도 취소 한 건 · 환불 한 건', () => {
    const s = first();
    const view = runQuery(s, 'cancelSheet', { orderId: 'o26', scope: 'order' }, ctx());
    const env = envelopeOf(s, view.command!, { expect: view.expect! });
    expect(applyCommand(s, env, NOW).outcome).toBe('applied');
    expect(applyCommand(s, env, NOW).outcome).toBe('applied');
    const step = view.then![0]!;
    const refund = envelopeOf(s, step.command, { expect: step.expect!, dependsOn: [env.requestId] });
    expect(applyCommand(s, refund, NOW).outcome).toBe('applied');
    expect(applyCommand(s, refund, NOW).outcome).toBe('applied');
    const o = order(s, 'o26');
    expect(o.cancellations).toHaveLength(1);
    expect(o.refunds).toHaveLength(1);
    check(s, 'o26');
  });

  it('까닭 없는 환불(취소가 비운 돈보다 많음 · 없는 취소)은 `환불 대상 없음`', () => {
    const s = first();
    const pay = order(s, 'o22').payments[0]!;
    const orphan = envelopeOf(s, { type: 'payment.refund', payload: { orderId: 'o22', cause: 'cancellation', refunds: [{ paymentId: pay.id, methodKey: 'transfer', amount: 5_000 }] } },
      { expect: { refundAmount: 5_000 }, dependsOn: [rid()] });
    expect(applyCommand(s, orphan, NOW).error?.message).toBe('환불 대상 없음');
    // 헬멧 1개(5,000원, 받은 돈 없음)를 취소한 뒤, 그 취소로 선입금 5,000원을 돌려줄 수 없다(비운 돈 0).
    const cut = sendSheet(s, { orderId: 'o22', scope: 'lines', picked: [{ lineId: 'o22-l3', quantity: 1 }] });
    expect(cut.view.decisions).toBeUndefined();
    expect(cut.view.primary.label).toBe('품목 취소 · 헬멧 1');
    const again = envelopeOf(s, { type: 'payment.refund', payload: { orderId: 'o22', cause: 'cancellation', refunds: [{ paymentId: pay.id, methodKey: 'transfer', amount: 5_000 }] } },
      { expect: { refundAmount: 5_000 }, dependsOn: [cut.first!.requestId] });
    expect(applyCommand(s, again, NOW).error?.message).toBe('환불 대상 없음');
    check(s, 'o22');
  });

  it('이정호(이서연 팀의 결제 팀)를 접수 취소하면 이서연 팀의 결제 예정이 풀린다', () => {
    const s = first();
    const view = runQuery(s, 'cancelSheet', { orderId: 'o32', scope: 'order' }, ctx());
    expect(view.decisions).toBeUndefined();
    expect(view.summary.map((line) => line.map((r) => r.text).join(''))).toEqual(['취소 금액 90,000원', '이서연 팀 결제 예정 해제']);
    sendSheet(s, { orderId: 'o32', scope: 'order' });
    expect(order(s, 'o36').payerOrderId).toBeUndefined();
    expect(ownDue(order(s, 'o36'))).toBeGreaterThan(0);
    check(s, 'o32', 'o36');
  });
});

describe('품목 취소(order.cancel scope lines)', () => {
  it('박준호 리프트권만 취소: 환불(장비 미수 그대로) · 미수 결제(장비 미수 −105,000) · 환불 없음', () => {
    const picked = [{ lineId: 'o22-l4', quantity: 3 }];
    const refund = first();
    const view = runQuery(refund, 'cancelSheet', { orderId: 'o22', scope: 'lines', picked }, ctx());
    expect(view.lines.map((l) => [l.label, l.quantity?.value, l.quantity?.max])).toEqual([['스키', 0, 2], ['보드', 0, 1], ['헬멧', 0, 3], ['야간권 성인', 3, 3]]);
    expect(view.decisions?.map((d) => d.label)).toEqual(['환불', '미수 결제', '환불 없음']);
    expect(view.primary.label).toBe('품목 취소 · 야간권 3매 · 환불 계좌이체 105,000원');
    sendSheet(refund, { orderId: 'o22', scope: 'lines', picked });
    expect(ownDue(order(refund, 'o22'))).toBe(120_000);
    expect(paidTotal(order(refund, 'o22'))).toBe(0);
    check(refund, 'o22');

    const apply = first();
    const applied = sendSheet(apply, { orderId: 'o22', scope: 'lines', picked, decision: 'apply_to_due' });
    expect(applied.view.refunds.map((r) => r.parts[0]!.text)).toEqual(['미수 결제 · 105,000원']);
    expect(applied.outcomes.map((x) => x.outcome)).toEqual(['applied']);
    const o = order(apply, 'o22');
    expect(ownDue(o)).toBe(15_000);
    expect(o.cancellations?.[0]?.released).toEqual([{ paymentId: o.payments[0]!.id, amount: 105_000 }]);
    expect(orderSlip({ state: apply, config, now: NOW }, 'o22')!.adjustments?.map((a) => a.parts.map((p) => p.text).join(' · '))).toEqual([
      '품목 취소 · 야간권 3매', '미수 결제 · 105,000원',
    ]);
    check(apply, 'o22');

    const keep = first();
    sendSheet(keep, { orderId: 'o22', scope: 'lines', picked, decision: 'no_refund' });
    expect(ownDue(order(keep, 'o22'))).toBe(120_000);
    expect(overpaid(order(keep, 'o22'))).toBe(0);
    check(keep, 'o22');
  });

  it('지급 전 수량 · 돌려받은 수량만 취소할 수 있고, 손님에게 있는 수량은 먼저 반납', () => {
    const s = first();
    const o21 = order(s, 'o21');
    expect(o21.lines.map(cancellableQty)).toEqual([0, 0]);
    const o24 = order(s, 'o24');
    expect(o24.lines.map(cancellableQty)).toEqual([1, 1]);
    // 최은정 스키 1(반납함)을 취소: 카드 수납이 비운 돈을 환불.
    const { outcomes } = sendSheet(s, { orderId: 'o24', scope: 'lines', picked: [{ lineId: 'o24-l1', quantity: 1 }] });
    expect(outcomes.map((x) => x.outcome)).toEqual(['applied', 'applied']);
    const o = order(s, 'o24');
    expect(o.refunds?.[0]?.methodKey).toBe('cash');
    expect(liveQty(o.lines[0]!)).toBe(0);
    check(s, 'o24');
  });

  it('할인(10%)을 받은 줄 일부를 취소하면 할인을 살아 있는 값으로 다시 센다(2 × 50,000 → 45,000)', () => {
    const s = first();
    const draft: OrderDraftInput = {
      channel: 'walk_in', leader: { name: '취소손님', phone: '01000000088', party: 2 }, items: [{ productKey: 'ski', quantity: 2 }],
      pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store', slot: { day: 'today', slotKey: 'night' } },
    };
    const choices: CheckoutChoice[] = [{ sectionKey: 'gear', methodKey: 'later', discountKey: 'ten_percent' }];
    const env = envelopeOf(s, { type: 'order.create', payload: { draft, choices, payerOrderId: null } }, { expect: { quoteHash: checkoutPlan(s, NOW, draft, choices, null).hash } });
    const created = applyCommand(s, env, NOW);
    const id = String(created.result?.orderId);
    expect(charged(order(s, id))).toBe(72_000);
    sendSheet(s, { orderId: id, scope: 'lines', picked: [{ lineId: id + '-l1', quantity: 1 }] });
    const o = order(s, id);
    expect(charged(o)).toBe(36_000);
    expect(ownDue(o)).toBe(36_000);
    check(s, id);
  });
});

describe('차에 실린 채 취소한 것(E7)', () => {
  it('최하은 적재 뒤 접수 취소: 차에 남은 것 6개 → 매장 입고(배달 업무)로 내려놓는다, 그 전까지 마감 `미입고`', () => {
    const s = first();
    const load = runQuery(s, 'confirmDraft', { orderId: 'o26', actionKey: 'stamp.load' }, ctx());
    expect(applyCommand(s, envelopeOf(s, load.command!), NOW).outcome).toBe('applied');
    sendSheet(s, { orderId: 'o26', scope: 'order' });
    const o = order(s, 'o26');
    expect(o.lines.map(leftover)).toEqual([3, 3]);
    const van = runQuery(s, 'vehicleLoad', { vehicleId: 'v1' }, ctx());
    expect(van.byTask.find((x) => x.note)?.teamName).toBe('최하은');
    expect(closingSheet({ state: s, config, now: at(23, 30) }, {}).carry.some((c) => c.key === 'review')).toBe(true);
    const receive = runQuery(s, 'confirmDraft', { actionKey: 'receive_to_shop', vehicleId: 'v1' }, ctx());
    expect(receive.command?.type).toBe('stock.receive');
    expect(applyCommand(s, envelopeOf(s, receive.command!), NOW).outcome).toBe('applied');
    expect(order(s, 'o26').lines.map(leftover)).toEqual([0, 0]);
    expect(order(s, 'o26').lines.map((l) => l.unloaded)).toEqual([3, 3]);
    check(s, 'o26');
  });

  it('취소 뒤에 온 기사의 배달 기록(보냄 대기)은 적용한다: 손님에게 나간 것은 돌려받을 것이 된다(E23)', () => {
    const s = first();
    const load = runQuery(s, 'confirmDraft', { orderId: 'o26', actionKey: 'stamp.load' }, ctx());
    applyCommand(s, envelopeOf(s, load.command!), NOW);
    sendSheet(s, { orderId: 'o26', scope: 'order', decision: 'no_refund' });
    const deliver = envelopeOf(s, { type: 'stock.deliver', payload: { taskId: 'deliver:o26', lines: [{ lineId: 'o26-l1', quantity: 3 }, { lineId: 'o26-l2', quantity: 3 }] } }, { deviceSeq: 7 });
    expect(applyCommand(s, deliver, at(17, 5)).outcome).toBe('applied');
    const o = order(s, 'o26');
    expect(o.lines.map((l) => l.issued)).toEqual([3, 3]);
    expect(o.lines.map(leftover)).toEqual([0, 0]);
    expect(orderConditions(s, o)).toContain('has_items_out');
    check(s, 'o26');
  });
});

describe('돈의 배분', () => {
  it('선입금 · 나눈 돈 · 줄마다 채운 돈이 취소 뒤에도 맞는다', () => {
    const s = first();
    sendSheet(s, { orderId: 'o22', scope: 'lines', picked: [{ lineId: 'o22-l1', quantity: 1 }] });
    const o = order(s, 'o22');
    const paid = linePaid(o);
    expect(paid.get('o22-l4')!.amount).toBe(105_000);
    expect(ownDue(o)).toBe(80_000);
    check(s, 'o22');
  });
});

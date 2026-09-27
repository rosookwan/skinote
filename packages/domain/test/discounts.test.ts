// 할인 적용(features-1 plan §6): 접수 때의 할인(매장 할인 · 직접 입력), 접수 뒤의 할인 적용 · 변경 · 해제(discount.apply)와 이어진 환불
// (payment.refund, cause 'discount'), 권한 · 한도(E10), 접수증 출처 줄 · 창(discountSheet). 명령마다 돈이 맞는지(assertMoney · assertMoneyViews)와
// 같은 요청번호를 두 번 보내도 한 번만 적용되는지(멱등)를 본다.
import {
  defaultUiConfig, draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type CheckoutChoice, type ConfirmCommand, type DiscountChoice, type Expect,
  type OrderDraftInput, type UiConfig,
} from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import {
  applyCommand, charged, checkoutPlan, closingSheet, currentApplication, findOrder, kstAt, linePaid, orderSlip, overpaid, ownDue, paidTotal, runQuery,
  sectionDiscountNow, type ApplyOptions, type ShopState,
} from '../src/index.ts';
import { sampleDay } from '../src/sample/index.ts';
import { assertMoney, assertMoneyViews } from './money-check.ts';

const at = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const NOW = at(15, 40);
const config: UiConfig = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
const first = (): ShopState => sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
const COUNTER = { roleKey: 'counter', permissions: ['discount.apply', 'discount.manual', 'payment.refund', 'order.create'] };
const ctx = (extra: Record<string, unknown> = {}) => ({ config, now: NOW, ...extra });

let seq = 0;
const rid = () => '01K62M2QG00000000000000' + String(++seq).padStart(3, '0');
function envelopeOf(state: ShopState, command: ConfirmCommand, extra: { expect?: Expect; dependsOn?: string[]; requestId?: string } = {}): AnyCommandEnvelope {
  const draft = openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, {
    requestId: extra.requestId ?? rid(), ...(extra.expect ? { expect: extra.expect } : {}), ...(extra.dependsOn ? { dependsOn: extra.dependsOn } : {}),
  });
  return draftToEnvelope(draft);
}
const order = (state: ShopState, id: string) => findOrder(state, id)!;

/** 창(discountSheet)이 써 준 명령 · 이어진 환불을 차례로 보낸다(창의 길 그대로: 앞 명령이 적용되면 다음). */
function sendSheet(state: ShopState, orderId: string, sectionKey: 'gear' | 'lift', choice: DiscountChoice, methods?: Record<string, string>, options: ApplyOptions = {}) {
  const view = runQuery(state, 'discountSheet', { orderId, sectionKey, choice, ...(methods ? { methods } : {}) }, ctx(options.viewer ? { viewer: { roleKey: 'counter', ...options.viewer } } : {}));
  if (!view.command) return { view, outcomes: [] };
  const first = envelopeOf(state, view.command, view.expect ? { expect: view.expect } : {});
  const outcomes = [applyCommand(state, first, NOW, undefined, options)];
  let previous = first.requestId;
  for (const step of view.then ?? []) {
    if (outcomes.at(-1)!.outcome !== 'applied') break;
    const next = envelopeOf(state, step.command, { ...(step.expect ? { expect: step.expect } : {}), dependsOn: [previous] });
    outcomes.push(applyCommand(state, next, NOW, undefined, options));
    previous = next.requestId;
  }
  return { view, outcomes, first };
}

const draft: OrderDraftInput = {
  channel: 'walk_in',
  leader: { name: '할인손님', phone: '01000000077', party: 2 },
  items: [{ productKey: 'ski', quantity: 2 }, { productKey: 'helmet', variantKey: '중', quantity: 1 }, { productKey: 'night_adult', quantity: 2 }],
  pickup: { mode: 'store', immediate: true },
  giveBack: { mode: 'store', slot: { day: 'today', slotKey: 'night' } },
};

function checkout(state: ShopState, choices: CheckoutChoice[], options: ApplyOptions = {}) {
  const view = runQuery(state, 'checkoutSheet', { draft, choices }, ctx(options.viewer ? { viewer: { roleKey: 'counter', ...options.viewer } } : {}));
  const envelope = envelopeOf(state, { type: 'order.create', payload: { draft, choices, payerOrderId: null } }, { expect: { quoteHash: checkoutPlan(state, NOW, draft, choices, null).hash } });
  return { view, outcome: applyCommand(state, envelope, NOW, undefined, options) };
}

describe('접수 때의 할인(V4 `할인 적용 ›`)', () => {
  it('매장 할인: 줄마다 할인 앞 값(gross) · 뺀 값(amount), 적용 한 건(값의 사본), 접수증은 할인 앞 값 + 출처 줄', () => {
    const s = first();
    // 장비 = 스키 2 × 40,000 + 헬멧 5,000 = 85,000원, 10% = 8,500원.
    const { outcome } = checkout(s, [{ sectionKey: 'gear', methodKey: 'card', discountKey: 'ten_percent' }, { sectionKey: 'lift', methodKey: 'cash' }]);
    expect(outcome.outcome).toBe('applied');
    const o = order(s, String(outcome.result?.orderId));
    expect(o.discounts).toEqual([{ id: o.id + ':da1', sectionKey: 'gear', discountKey: 'ten_percent', kind: 'percent', label: '10% 할인', value: 10, amount: 8_500, at: NOW }]);
    const gear = o.lines.filter((l) => l.section === 'gear');
    expect(gear.map((l) => [l.gross, l.amount])).toEqual([[80_000, 72_000], [5_000, 4_500]]);
    expect(o.lines.filter((l) => l.section === 'lift').every((l) => l.gross === undefined)).toBe(true);
    const slip = orderSlip({ state: s, config, now: NOW }, o.id)!;
    expect(slip.lines.map((l) => l.amount)).toEqual([80_000, 5_000, 70_000]);
    expect(slip.adjustments).toEqual([{ key: 'discount:gear', parts: [{ text: '장비 10% 할인', drop: 0, words: true }], amount: -8_500 }]);
    expect(slip.money.charged).toBe(76_500 + 70_000);
    assertMoney(s);
  });

  it('직접 입력(금액 · 비율, 10원 단위, 칸 합계까지)과 사유: 상태 글 · 적용 기록', () => {
    const s = first();
    const choice = (manual: { kind: 'amount' | 'percent'; value: number; reason: string }): CheckoutChoice[] => [
      { sectionKey: 'gear', methodKey: 'card', discountKey: 'manual', manual }, { sectionKey: 'lift', methodKey: 'cash', discountKey: 'manual', manual: { kind: 'percent', value: 15, reason: '단체' } },
    ];
    const view = runQuery(s, 'checkoutSheet', { draft, choices: choice({ kind: 'amount', value: 5_000, reason: ' 단골 ' }) }, ctx());
    const gear = view.sections.find((x) => x.key === 'gear')!;
    expect(gear.discount).toBe('할인 직접 입력 · 5,000원 · 85,000원 → 80,000원');
    expect(gear.discounts?.find((x) => x.key === 'manual')).toMatchObject({ label: '직접 입력', selected: true, secondLine: '5,000원', opens: true });
    expect(gear.manual?.kinds.map((k) => [k.key, k.input.title, k.input.max])).toEqual([['amount', '할인 금액 · 장비', 85_000], ['percent', '할인 비율 · 장비', 100]]);
    // 리프트권 칸은 비율만(종류 판 없이 숫자판).
    expect(view.sections.find((x) => x.key === 'lift')!.manual?.kinds.map((k) => k.key)).toEqual(['percent']);
    expect(view.sections.find((x) => x.key === 'lift')!.discount).toBe('할인 직접 입력 · 15% · 70,000원 → 59,500원');
    const { outcome } = checkout(s, choice({ kind: 'amount', value: 5_000, reason: ' 단골 ' }));
    expect(outcome.outcome).toBe('applied');
    const o = order(s, String(outcome.result?.orderId));
    expect(o.discounts?.map((d) => [d.kind, d.label, d.value, d.amount, d.reason])).toEqual([
      ['manual_amount', '할인 직접 입력', 5_000, 5_000, '단골'], ['manual_percent', '할인 직접 입력', 15, 10_500, '단체'],
    ]);
    expect(orderSlip({ state: s, config, now: NOW }, o.id)!.adjustments?.map((a) => [a.parts.map((p) => p.text).join(' · '), a.amount])).toEqual([
      ['장비 할인 직접 입력 · 단골', -5_000], ['리프트권 할인 직접 입력 · 단체', -10_500],
    ]);
    assertMoney(s);
    // 칸 합계를 넘는 금액은 칸 합계까지(85,000원), 리프트권 금액 · 범위 밖 · 10원 단위가 아닌 값 · 빈 사유는 미지원.
    const big = checkoutPlan(s, NOW, draft, [{ sectionKey: 'gear', methodKey: 'card', discountKey: 'manual', manual: { kind: 'amount', value: 90_000, reason: '행사' } }]);
    expect(big.sections.find((x) => x.pay.key === 'gear')!.net).toBe(0);
    for (const bad of [
      { sectionKey: 'lift', methodKey: 'cash', discountKey: 'manual', manual: { kind: 'amount' as const, value: 5_000, reason: '단골' } },
      { sectionKey: 'gear', methodKey: 'card', discountKey: 'manual', manual: { kind: 'amount' as const, value: 5_005, reason: '단골' } },
      { sectionKey: 'gear', methodKey: 'card', discountKey: 'manual', manual: { kind: 'percent' as const, value: 101, reason: '단골' } },
      { sectionKey: 'gear', methodKey: 'card', discountKey: 'manual', manual: { kind: 'amount' as const, value: 5_000, reason: '  ' } },
      { sectionKey: 'gear', methodKey: 'card', discountKey: 'manual' },
    ]) expect(checkoutPlan(s, NOW, draft, [bad]).invalid, JSON.stringify(bad)).toBe('unsupported');
  });

  it('권한 · 한도(E10): 권한 없으면 `직접 입력`이 회색, 한도를 넘으면 `권한 없음 · 관리자 확인 필요`로 거절, 권한 있는 할인만', () => {
    const s = first();
    const noManual = { permissions: ['discount.apply', 'order.create'] };
    const view = runQuery(s, 'checkoutSheet', { draft, choices: [] }, ctx({ viewer: { roleKey: 'counter', ...noManual } }));
    const gear = view.sections.find((x) => x.key === 'gear')!;
    expect(gear.discounts?.find((x) => x.key === 'manual')).toMatchObject({ enabled: false, reason: '권한 없음 · 관리자 확인 필요' });
    expect(gear.manual).toBeUndefined();
    const manual: CheckoutChoice[] = [{ sectionKey: 'gear', methodKey: 'card', discountKey: 'manual', manual: { kind: 'amount', value: 5_000, reason: '단골' } }];
    const refused = checkout(s, manual, { viewer: noManual });
    expect(refused.outcome.outcome).toBe('rejected');
    expect(refused.outcome.error).toEqual({ code: 'FORBIDDEN', message: '권한 없음 · 관리자 확인 필요' });
    // 한도 10,000원: 5,000원은 되고, 20%(17,000원)는 거절. 숫자판의 한도(금액 10,000원 · 비율 11%).
    const limited = { permissions: COUNTER.permissions, limits: { maxDiscountAmount: 10_000 } };
    const lview = runQuery(s, 'checkoutSheet', { draft, choices: [] }, ctx({ viewer: { roleKey: 'counter', ...limited } }));
    expect(lview.sections.find((x) => x.key === 'gear')!.manual?.kinds.map((k) => k.limit)).toEqual([10_000, 11]);
    const over = checkout(s, [{ sectionKey: 'gear', methodKey: 'card', discountKey: 'manual', manual: { kind: 'percent', value: 20, reason: '단골' } }], { viewer: limited });
    expect(over.outcome.error?.code).toBe('FORBIDDEN');
    expect(checkout(s, manual, { viewer: limited }).outcome.outcome).toBe('applied');
    // 권한이 걸린 매장 할인(required_permission_key): 권한 없는 사람은 회색 · 거절.
    s.registry = { ...s.registry, discounts: s.registry.discounts.map((d, i) => (i === 0 ? { ...d, requiredPermission: 'discount.special' } : d)) };
    const gated = runQuery(s, 'checkoutSheet', { draft, choices: [] }, ctx({ viewer: COUNTER }));
    expect(gated.sections.find((x) => x.key === 'gear')!.discounts?.find((x) => x.key === 'ten_percent')).toMatchObject({ enabled: false });
    expect(checkout(s, [{ sectionKey: 'gear', methodKey: 'card', discountKey: 'ten_percent' }], { viewer: COUNTER }).outcome.error?.code).toBe('FORBIDDEN');
    assertMoney(s);
  });
});

describe('접수 뒤의 할인 적용(discount.apply)', () => {
  it('결제 전(박준호 장비 미수 120,000원): 10% → 미수 108,000원, 직접 입력 20%로 변경, 해제 → 다시 120,000원', () => {
    const s = first();
    const o = order(s, 'o22');
    const opened = runQuery(s, 'discountSheet', { orderId: 'o22' }, ctx());
    expect(opened.title).toBe('할인 적용 · 박준호 팀');
    expect(opened.sections.map((x) => [x.key, x.selected])).toEqual([['gear', true], ['lift', false]]);
    expect(opened.choices.map((c) => [c.label, c.selected])).toEqual([['할인 없음', true], ['10% 할인', false], ['장비 5,000원 할인', false], ['직접 입력', false]]);
    // 막 연 창: 요약 줄 그대로, 주 버튼만 막힘. 지금 할인(할인 없음)을 다시 고르면 `변경 없음`.
    expect(opened.notice).toBeUndefined();
    // 바뀌지 않으면 화살표 없이 지금 청구(2026-09-27 점검).
    expect(opened.summary.map((r) => r.text).join('')).toBe('장비 120,000원 · 미수 120,000원');
    expect(opened.primary.enabled).toBe(false);
    expect(runQuery(s, 'discountSheet', { orderId: 'o22', choice: { none: true } }, ctx()).notice).toBe('변경 없음');

    const ten = sendSheet(s, 'o22', 'gear', { ruleKey: 'ten_percent' });
    expect(ten.view.summary.map((r) => r.text).join('')).toBe('장비 120,000원 → 108,000원 · 미수 108,000원');
    expect(ten.view.primary.label).toBe('할인 적용 · 12,000원');
    expect(ten.view.refunds).toEqual([]);
    expect(ten.outcomes.map((x) => x.outcome)).toEqual(['applied']);
    expect(ownDue(o)).toBe(108_000);
    expect(o.charges?.at(-1)).toMatchObject({ kind: 'discount_change', amount: -12_000, section: 'gear' });
    expect(orderSlip({ state: s, config, now: NOW }, 'o22')!.adjustments).toEqual([{ key: 'discount:gear', parts: [{ text: '장비 10% 할인', drop: 0, words: true }], amount: -12_000 }]);
    assertMoney(s);
    assertMoneyViews(s, 'o22', NOW);
    // 같은 요청번호를 다시 보내면 처음 결과(한 번만 적용).
    const again = applyCommand(s, ten.first!, NOW);
    expect(again.outcome).toBe('applied');
    expect(o.discounts?.length).toBe(1);
    expect(ownDue(o)).toBe(108_000);

    const twenty = sendSheet(s, 'o22', 'gear', { manual: { kind: 'percent', value: 20, reason: '단골' } });
    expect(twenty.outcomes.map((x) => x.outcome)).toEqual(['applied']);
    expect(currentApplication(o, 'gear')).toMatchObject({ kind: 'manual_percent', amount: 24_000, supersedes: ten.first!.requestId, reason: '단골' });
    expect(ownDue(o)).toBe(96_000);
    expect(orderSlip({ state: s, config, now: NOW }, 'o22')!.adjustments?.[0]).toMatchObject({ parts: [{ text: '장비 할인 직접 입력' }, { text: '단골' }], amount: -24_000 });
    assertMoney(s);

    const off = sendSheet(s, 'o22', 'gear', { none: true });
    // 요약의 앞 값은 그 칸의 지금 청구(96,000원): 해제하면 오르는 것이 보인다.
    expect(off.view.summary.map((r) => r.text).join('')).toBe('장비 96,000원 → 120,000원 · 미수 120,000원');
    expect(off.view.primary.label).toBe('할인 해제 · 24,000원');
    expect(off.outcomes.map((x) => x.outcome)).toEqual(['applied']);
    expect(ownDue(o)).toBe(120_000);
    expect(sectionDiscountNow(o, 'gear')).toBe(0);
    expect(orderSlip({ state: s, config, now: NOW }, 'o22')!.adjustments).toEqual([{ key: 'discount:gear', parts: [{ text: '장비 할인 해제', drop: 0 }], tone: 'muted' }]);
    assertMoney(s);
    assertMoneyViews(s, 'o22', NOW);
  });

  it('결제 뒤(김민재 카드 100,000원): 10% → 초과 10,000원을 환불(카드 또는 현금), 마감의 환불 줄 · 돈통', () => {
    const s = first();
    const o = order(s, 'o21');
    expect(charged(o)).toBe(100_000);
    const view = runQuery(s, 'discountSheet', { orderId: 'o21', choice: { ruleKey: 'ten_percent' } }, ctx());
    expect(view.summary.map((r) => r.text).join('')).toBe('장비 100,000원 → 90,000원 · 환불 10,000원');
    expect(view.refunds).toEqual([{
      paymentId: 'o21-p1', amount: 10_000, parts: [{ text: '환불 · 카드 10,000원', drop: 0 }, { text: '단말기 취소', drop: 1 }],
      methods: [{ key: 'card', label: '카드', selected: true, enabled: true }, { key: 'cash', label: '현금', selected: false, enabled: true }],
    }]);
    expect(view.primary.label).toBe('할인 적용 · 환불 카드 10,000원');
    // 현금으로 바꿔 돌려준다(카운터 돈통에서 나감).
    const counterBefore = closingSheet({ state: s, config, now: at(23, 50) }, {}).cash.find((c) => c.key === 'counter')!.expected.map((r) => r.text).join('');
    const sent = sendSheet(s, 'o21', 'gear', { ruleKey: 'ten_percent' }, { 'o21-p1': 'cash' });
    expect(sent.view.primary.label).toBe('할인 적용 · 환불 현금 10,000원');
    expect(sent.outcomes.map((x) => x.outcome)).toEqual(['applied', 'applied']);
    expect(overpaid(o)).toBe(0);
    expect(paidTotal(o)).toBe(90_000);
    expect(o.refunds).toEqual([{
      id: expect.stringMatching(/:0$/), refundOf: 'o21-p1', methodKey: 'cash', amount: 10_000, at: NOW, drawerId: 'counter',
      cause: { kind: 'discount', id: sent.first!.requestId }, reason: '할인 변경',
    }]);
    const slip = orderSlip({ state: s, config, now: NOW }, 'o21')!;
    expect(slip.money).toMatchObject({ charged: 90_000, paid: 90_000, due: 0, refunded: 10_000 });
    expect(slip.adjustments?.map((a) => [a.parts.map((p) => p.text).join(' · '), a.amount ?? null, a.tone ?? null])).toEqual([
      ['장비 10% 할인', -10_000, null], ['환불 · 현금 10,000원', null, 'muted'],
    ]);
    const closing = closingSheet({ state: s, config, now: at(23, 50) }, {});
    const refundRow = closing.methods.find((m) => m.key === 'refund')!;
    expect(refundRow).toMatchObject({ label: '환불', count: 1, amount: -10_000 });
    // 그날 받은 수단 줄이 있으면 그 수단의 환불은 그 줄의 둘째 줄(빠지지 않음, 2026-09-27 점검): 현금 줄 `환불 −10,000원`.
    expect(refundRow.note).toBeUndefined();
    expect(closing.methods.find((m) => m.key === 'cash')!.note?.[0]).toEqual({ text: '환불 −10,000원', drop: 0 });
    // 카드 줄은 받은 돈 그대로(환불은 한 줄로 따로).
    const card = closing.methods.find((m) => m.key === 'card')!;
    expect(card.amount).toBeGreaterThanOrEqual(100_000);
    const counterAfter = closing.cash.find((c) => c.key === 'counter')!.expected.map((r) => r.text).join('');
    expect(counterAfter).not.toBe(counterBefore);
    assertMoney(s);
    assertMoneyViews(s, 'o21', NOW);
  });

  it('칸에 묶인 선입금이 할인으로 넘치면(박준호 리프트권 20%) 넘친 돈은 장비 미수를 채운다(E4c), 환불 없음', () => {
    const s = first();
    const o = order(s, 'o22');
    const sent = sendSheet(s, 'o22', 'lift', { ruleKey: 'lift_twenty' });
    expect(sent.view.refunds).toEqual([]);
    expect(sent.outcomes.map((x) => x.outcome)).toEqual(['applied']);
    // 리프트권 105,000 → 84,000원, 선입금 105,000원 중 21,000원이 장비로.
    expect(charged(o)).toBe(204_000);
    expect(ownDue(o)).toBe(99_000);
    const paid = linePaid(o);
    expect(o.lines.filter((l) => l.section === 'gear').reduce((sum, l) => sum + paid.get(l.id)!.amount, 0)).toBe(21_000);
    assertMoney(s);
    assertMoneyViews(s, 'o22', NOW);
  });

  it('다른 팀이 낼 접수(이서연 → 이정호): 할인이 그 팀의 일괄 수납 몫을 줄인다', () => {
    const s = first();
    const sent = sendSheet(s, 'o36', 'gear', { ruleKey: 'gear_5000' });
    expect(sent.outcomes.map((x) => x.outcome)).toEqual(['applied']);
    const view = runQuery(s, 'groupPaySheet', { orderId: 'o32' }, ctx());
    expect(view.rows.find((r) => r.orderId === 'o36')!.amount).toBe(55_000);
    assertMoney(s);
    assertMoneyViews(s, 'o36', NOW);
  });

  it('창이 본 받을 금액이 바뀌었으면 충돌, 모르는 할인 · 칸은 미지원, 같은 할인은 `변경 없음`', () => {
    const s = first();
    const stale = envelopeOf(s, { type: 'discount.apply', payload: { orderId: 'o22', sectionKey: 'gear', choice: { ruleKey: 'ten_percent' } } }, { expect: { dueAmount: 1 } });
    expect(applyCommand(s, stale, NOW).error?.code).toBe('DUE_CHANGED');
    const unknown = envelopeOf(s, { type: 'discount.apply', payload: { orderId: 'o22', sectionKey: 'lift', choice: { ruleKey: 'gear_5000' } } }, { expect: { dueAmount: 120_000 } });
    expect(applyCommand(s, unknown, NOW).error?.code).toBe('UNSUPPORTED');
    const none = envelopeOf(s, { type: 'discount.apply', payload: { orderId: 'o22', sectionKey: 'gear', choice: { none: true } } }, { expect: { dueAmount: 120_000 } });
    expect(applyCommand(s, none, NOW)).toMatchObject({ outcome: 'superseded', error: { message: '변경 없음' } });
    const noExpect = envelopeOf(s, { type: 'discount.apply', payload: { orderId: 'o22', sectionKey: 'gear', choice: { ruleKey: 'ten_percent' } } });
    expect(applyCommand(s, noExpect, NOW).error?.code).toBe('EXPECT_REQUIRED');
    assertMoney(s);
  });

  it('권한 · 한도(E10): 직접 입력 권한이 없으면 창의 `직접 입력`이 회색이고 명령은 FORBIDDEN, 한도 안은 적용', () => {
    const s = first();
    const viewer = { roleKey: 'counter', permissions: ['discount.apply'] };
    const view = runQuery(s, 'discountSheet', { orderId: 'o22' }, ctx({ viewer }));
    expect(view.choices.find((c) => c.key === 'manual')).toMatchObject({ enabled: false, reason: '권한 없음 · 관리자 확인 필요' });
    expect(view.manual).toBeUndefined();
    const manual: DiscountChoice = { manual: { kind: 'amount', value: 20_000, reason: '단골' } };
    const refused = runQuery(s, 'discountSheet', { orderId: 'o22', choice: manual }, ctx({ viewer }));
    expect(refused.notice).toBe('권한 없음 · 관리자 확인 필요');
    expect(refused.primary.enabled).toBe(false);
    const env = envelopeOf(s, { type: 'discount.apply', payload: { orderId: 'o22', sectionKey: 'gear', choice: manual } }, { expect: { dueAmount: 120_000 } });
    expect(applyCommand(s, env, NOW, undefined, { viewer }).error).toEqual({ code: 'FORBIDDEN', message: '권한 없음 · 관리자 확인 필요' });
    const limited = { permissions: COUNTER.permissions, limits: { maxDiscountAmount: 10_000 } };
    expect(sendSheet(s, 'o22', 'gear', manual, undefined, { viewer: limited }).outcomes).toEqual([]);
    const ok = sendSheet(s, 'o22', 'gear', { manual: { kind: 'amount', value: 10_000, reason: '단골' } }, undefined, { viewer: limited });
    expect(ok.outcomes.map((x) => x.outcome)).toEqual(['applied']);
    assertMoney(s);
  });
});

describe('환불(payment.refund)의 까닭', () => {
  it('까닭 없는 환불 · 다른 까닭 · 비운 돈보다 많은 환불은 `환불 대상 없음`, 초과 수납이 따로 있어도 흡수하지 않는다', () => {
    const s = first();
    const o = order(s, 'o21');
    // 초과 수납 5,000원을 따로 만든다(보냄 대기로 늦게 온 현장 수납처럼).
    o.payments.push({ id: 'o21-extra', amount: 5_000, methodKey: 'cash', at: at(15, 0), drawerId: 'counter' });
    const refund = (dependsOn?: string[], amount = 5_000, paymentId = 'o21-extra') => applyCommand(s, envelopeOf(s, {
      type: 'payment.refund', payload: { orderId: 'o21', cause: 'discount', refunds: [{ paymentId, methodKey: 'cash', amount }] },
    }, { expect: { refundAmount: amount }, ...(dependsOn ? { dependsOn } : {}) }), NOW);
    expect(refund().error?.message).toBe('환불 대상 없음');
    expect(refund(['01K62M2QG0000000000000ZZZZ']).error?.message).toBe('환불 대상 없음');
    // 할인 10%(10,000원)의 환불은 비운 돈까지만.
    const apply = envelopeOf(s, { type: 'discount.apply', payload: { orderId: 'o21', sectionKey: 'gear', choice: { ruleKey: 'ten_percent' } } }, { expect: { dueAmount: 0 } });
    expect(applyCommand(s, apply, NOW).outcome).toBe('applied');
    expect(overpaid(o)).toBe(15_000);
    expect(refund([apply.requestId], 15_000, 'o21-p1').error?.message).toBe('환불 대상 없음');
    expect(refund([apply.requestId], 10_000, 'o21-p1').outcome).toBe('applied');
    expect(refund([apply.requestId], 5_000).error?.message).toBe('환불 대상 없음');
    // 남은 5,000원은 초과 수납(확인 필요)이다.
    expect(overpaid(o)).toBe(5_000);
    expect(runQuery(s, 'reviewList', {}, ctx()).items.some((x) => x.kindKey === 'overpaid' && x.orderId === 'o21')).toBe(true);
    const over = applyCommand(s, envelopeOf(s, {
      type: 'payment.refund', payload: { orderId: 'o21', cause: 'overpaid', refunds: [{ paymentId: 'o21-extra', methodKey: 'cash', amount: 5_000 }] },
    }, { expect: { refundAmount: 5_000 } }), NOW);
    expect(over.outcome).toBe('applied');
    expect(overpaid(o)).toBe(0);
    assertMoney(s);
  });

  it('수단은 원래 수단 또는 현금만, 한 수납의 돌려줄 돈까지, 창이 본 환불 금액이 다르면 충돌', () => {
    const s = first();
    const apply = envelopeOf(s, { type: 'discount.apply', payload: { orderId: 'o21', sectionKey: 'gear', choice: { ruleKey: 'ten_percent' } } }, { expect: { dueAmount: 0 } });
    applyCommand(s, apply, NOW);
    const refund = (methodKey: string, amount: number, refundAmount = amount) => applyCommand(s, envelopeOf(s, {
      type: 'payment.refund', payload: { orderId: 'o21', cause: 'discount', refunds: [{ paymentId: 'o21-p1', methodKey, amount }] },
    }, { expect: { refundAmount }, dependsOn: [apply.requestId] }), NOW);
    expect(refund('transfer', 10_000).error?.message).toBe('등록되지 않은 결제 수단');
    expect(refund('card', 10_000, 9_000).error?.code).toBe('REFUND_CHANGED');
    const ok = refund('card', 10_000);
    expect(ok.outcome).toBe('applied');
    const closing = closingSheet({ state: s, config, now: at(23, 50) }, {});
    expect(closing.methods.find((m) => m.key === 'refund')).toMatchObject({ amount: -10_000 });
    expect(closing.methods.find((m) => m.key === 'card')!.note?.[0]).toEqual({ text: '환불 −10,000원', drop: 0 });
    assertMoney(s);
  });
});

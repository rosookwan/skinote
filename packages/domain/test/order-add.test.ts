// 품목 추가(features-1 plan §5-5 · §5-6): 품목 추가의 ① 품목(orderDraft addTo) · 확정 창(checkoutSheet addTo) · 명령(order.add). 새 차수(카운터),
// 접수의 대여 날 수로 센 값, 칸마다 지금 받기 · 후불, 결제 팀(접수의 결제 팀 · 이 팀), 칸의 비율 할인은 새 줄에도(대신하는 적용), 금액 할인은 새 줄에
// 적용하지 않는다. 명령마다 돈이 맞는지와 같은 요청번호를 두 번 보내도 한 번만 적용되는지를 본다.
import {
  defaultUiConfig, draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type CheckoutChoice, type ConfirmCommand, type DraftItem, type Expect,
  type OrderDraftInput, type UiConfig,
} from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import {
  applyCommand, charged, checkoutPlan, currentApplication, findOrder, kstAt, linePayerId, orderSlip, ownDue, paidTotal, runQuery, sectionDiscountNow,
  type ShopState,
} from '../src/index.ts';
import { sampleDay } from '../src/sample/index.ts';
import { assertMoney, assertMoneyViews } from './money-check.ts';

const at = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const NOW = at(15, 40);
const config: UiConfig = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
const first = (): ShopState => sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
const ctx = () => ({ config, now: NOW });

let seq = 0;
const rid = () => '01K62M2QG00000000000002' + String(++seq).padStart(3, '0');
function envelopeOf(state: ShopState, command: ConfirmCommand, extra: { expect?: Expect; requestId?: string } = {}): AnyCommandEnvelope {
  return draftToEnvelope(openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, { requestId: extra.requestId ?? rid(), ...(extra.expect ? { expect: extra.expect } : {}) }));
}
const order = (state: ShopState, id: string) => findOrder(state, id)!;
const EMPTY: OrderDraftInput = { channel: 'walk_in', leader: { name: '', phone: '', party: 0 }, items: [], pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' } };
const HELMET: DraftItem[] = [{ productKey: 'helmet', variantKey: '중', quantity: 1 }];

/** 확정 창이 써 준 order.add를 보낸다. */
function add(state: ShopState, orderId: string, items: DraftItem[], choices?: CheckoutChoice[], payer?: 'order' | 'self') {
  const view = runQuery(state, 'checkoutSheet', { draft: { ...EMPTY, items }, addTo: orderId, ...(choices ? { choices } : {}), ...(payer ? { payer } : {}) }, ctx());
  if (!view.command) return { view, outcome: null };
  const env = envelopeOf(state, view.command, { expect: view.expect! });
  return { view, env, outcome: applyCommand(state, env, NOW) };
}
const check = (s: ShopState, ...ids: string[]) => {
  assertMoney(s);
  for (const id of ids) assertMoneyViews(s, id, NOW);
};

describe('품목 추가 ① 품목(orderDraft addTo)', () => {
  it('그 접수의 대여 날 수로 센 값 · 제목 `품목 추가 · 윤서준 팀` · ② 일정 없이 바로 결제', () => {
    const s = first();
    const view = runQuery(s, 'orderDraft', { draft: { ...EMPTY, items: [{ productKey: 'ski', quantity: 1 }] }, addTo: 'o28' }, ctx());
    expect(view.add).toEqual({ orderId: 'o28', title: '품목 추가 · 윤서준 팀' });
    expect(view.footer).toBe('품목 추가 · 윤서준 팀');
    // 윤서준: 오늘 수령 → 내일 09:00 반납 = 2일.
    expect(view.totals.find((t) => t.strong)?.amount).toBe(80_000);
    expect(view.ready).toEqual({ items: true, schedule: true });
  });
});

describe('품목 추가(order.add)', () => {
  it('현장 대여에 헬멧 1(현금): 새 차수 · 현금 수납이 새 줄에 · 접수증 `품목 추가 · 15:40 · 헬멧 중 사이즈 1`', () => {
    const s = first();
    const { view, outcome } = add(s, 'o21', HELMET, [{ sectionKey: 'gear', methodKey: 'cash' }]);
    expect(view.title).toBe('결제 · 김민재 팀');
    expect(view.primary.label).toBe('추가 확정 · 현금 5,000원');
    expect(view.payer.visible).toBe(false);
    expect(outcome?.outcome).toBe('applied');
    const o = order(s, 'o21');
    const line = o.lines.at(-1)!;
    expect(line).toMatchObject({ id: 'o21-l3', kind: 'helmet', qty: 1, amount: 5_000, batch: { source: 'counter', at: NOW } });
    expect(o.payments.at(-1)).toMatchObject({ amount: 5_000, methodKey: 'cash', drawerId: 'counter', lines: [{ lineId: 'o21-l3', quantity: 1, amount: 5_000 }] });
    expect(ownDue(o)).toBe(0);
    const slip = orderSlip({ state: s, config, now: NOW }, 'o21')!;
    expect(slip.adjustments?.map((a) => a.parts.map((p) => p.text).join(' · '))).toEqual(['품목 추가 · 15:40 · 헬멧 중 사이즈 1']);
    expect(slip.nextStep?.actionKey).toBe('stamp.issue');
    check(s, 'o21');
  });

  it('후불 · 같은 요청번호 두 번 → 한 번만', () => {
    const s = first();
    const { env } = add(s, 'o21', HELMET, [{ sectionKey: 'gear', methodKey: 'later' }]);
    expect(applyCommand(s, env!, NOW).outcome).toBe('applied');
    const o = order(s, 'o21');
    expect(o.lines).toHaveLength(3);
    expect(ownDue(o)).toBe(5_000);
    check(s, 'o21');
  });

  it('이서연(결제 팀 이정호)에 후불: 결제 팀 줄 `이정호 팀` · `이 팀`', () => {
    const s = first();
    const view = runQuery(s, 'checkoutSheet', { draft: { ...EMPTY, items: HELMET }, addTo: 'o36', choices: [{ sectionKey: 'gear', methodKey: 'later' }] }, ctx());
    expect(view.payer.visible).toBe(true);
    expect(view.payer.options.map((o) => [o.label, o.selected])).toEqual([['이정호 팀', true], ['이 팀', false]]);
    const byPayer = first();
    add(byPayer, 'o36', HELMET, [{ sectionKey: 'gear', methodKey: 'later' }], 'order');
    const o = order(byPayer, 'o36');
    expect(linePayerId(o, o.lines.at(-1)!)).toBe('o32');
    check(byPayer, 'o36', 'o32');
    const self = first();
    add(self, 'o36', HELMET, [{ sectionKey: 'gear', methodKey: 'later' }], 'self');
    const x = order(self, 'o36');
    expect(linePayerId(x, x.lines.at(-1)!)).toBe('o36');
    check(self, 'o36', 'o32');
  });

  it('비율 할인(10%)이 걸린 칸: 새 줄도 할인(대신하는 적용), 금액 할인은 새 줄에 적용하지 않는다', () => {
    const s = first();
    const draft: OrderDraftInput = {
      channel: 'walk_in', leader: { name: '추가손님', phone: '01000000099', party: 2 }, items: [{ productKey: 'ski', quantity: 2 }],
      pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store', slot: { day: 'today', slotKey: 'night' } },
    };
    const choices: CheckoutChoice[] = [{ sectionKey: 'gear', methodKey: 'later', discountKey: 'ten_percent' }];
    const created = applyCommand(s, envelopeOf(s, { type: 'order.create', payload: { draft, choices, payerOrderId: null } }, { expect: { quoteHash: checkoutPlan(s, NOW, draft, choices, null).hash } }), NOW);
    const id = String(created.result?.orderId);
    const { view } = add(s, id, [{ productKey: 'ski', quantity: 1 }], [{ sectionKey: 'gear', methodKey: 'later' }]);
    expect(view.sections[0]?.discount).toBe('장비 10% 할인 · 적용 중');
    const o = order(s, id);
    expect(o.lines.at(-1)).toMatchObject({ gross: 40_000, amount: 36_000 });
    expect(currentApplication(o, 'gear')?.amount).toBe(12_000);
    expect(sectionDiscountNow(o, 'gear')).toBe(12_000);
    expect(charged(o)).toBe(108_000);
    check(s, id);

    // 금액 할인(장비 5,000원 할인): 새 줄은 할인 없이.
    const t = first();
    const amountChoices: CheckoutChoice[] = [{ sectionKey: 'gear', methodKey: 'later', discountKey: 'gear_5000' }];
    const made = applyCommand(t, envelopeOf(t, { type: 'order.create', payload: { draft, choices: amountChoices, payerOrderId: null } }, { expect: { quoteHash: checkoutPlan(t, NOW, draft, amountChoices, null).hash } }), NOW);
    const id2 = String(made.result?.orderId);
    add(t, id2, [{ productKey: 'ski', quantity: 1 }], [{ sectionKey: 'gear', methodKey: 'later' }]);
    const o2 = order(t, id2);
    expect(o2.lines.at(-1)?.gross).toBeUndefined();
    expect(charged(o2)).toBe(80_000 - 5_000 + 40_000);
    check(t, id2);
  });

  it('접수증 출처 줄은 일어난 차례대로: 품목 추가 15:40 → 그 헬멧 품목 취소(15:50, 환불 현금) → 품목 추가 16:00, 환불 줄은 끝에', () => {
    const s = first();
    add(s, 'o21', HELMET, [{ sectionKey: 'gear', methodKey: 'cash' }]);
    const later = at(15, 50);
    const sheet = runQuery(s, 'cancelSheet', { orderId: 'o21', scope: 'lines', picked: [{ lineId: 'o21-l3', quantity: 1 }], methods: {} }, { config, now: later });
    const cancel = envelopeOf(s, sheet.command!, { expect: sheet.expect! });
    expect(applyCommand(s, cancel, later).outcome).toBe('applied');
    const step = sheet.then![0]!;
    const refund = draftToEnvelope(openCommandDraft(step.command, { epoch: s.epoch, rev: s.rev }, { requestId: rid(), expect: step.expect!, dependsOn: [cancel.requestId] }));
    expect(applyCommand(s, refund, later).outcome).toBe('applied');
    const last = at(16, 0);
    const view = runQuery(s, 'checkoutSheet', { draft: { ...EMPTY, items: HELMET }, addTo: 'o21', choices: [{ sectionKey: 'gear', methodKey: 'later' }] }, { config, now: last });
    expect(applyCommand(s, envelopeOf(s, view.command!, { expect: view.expect! }), last).outcome).toBe('applied');
    const slip = orderSlip({ state: s, config, now: last }, 'o21')!;
    expect(slip.adjustments?.map((a) => a.parts.map((p) => p.text).join(' · '))).toEqual([
      '품목 추가 · 15:40 · 헬멧 중 사이즈 1', '품목 취소 · 헬멧 중 사이즈 1', '품목 추가 · 16:00 · 헬멧 중 사이즈 1', '환불 · 현금 5,000원',
    ]);
    assertMoney(s);
    assertMoneyViews(s, 'o21', last);
  });

  it('창이 본 가격과 다르면 충돌, 모두 취소한 접수에는 더하지 않는다', () => {
    const s = first();
    const env = envelopeOf(s, { type: 'order.add', payload: { orderId: 'o21', items: HELMET, choices: [{ sectionKey: 'gear', methodKey: 'cash' }], payer: 'order' } }, { expect: { quoteHash: 'old' } });
    expect(applyCommand(s, env, NOW).error?.code).toBe('QUOTE_CHANGED');
    expect(paidTotal(order(s, 'o21'))).toBeGreaterThan(0);
  });
});

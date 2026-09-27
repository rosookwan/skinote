// 돈이 맞는지(features-1 plan §3-2 assertMoney · moneyViews): 명령마다 뒤에 부른다. 청구 = 줄 값 + 조정, 환불은 받은 수납을 가리키고 그 금액을
// 넘지 않으며, 칸마다 마지막 할인 적용 = 그 칸의 지금 할인, 줄마다 채운 돈의 합 = min(받은 돈 − 환불, 줄 청구 합), 마감의 결제 수단 표 합 = 그날 받은
// 돈 − 그날 돌려준 돈, 그리고 접수증 · 장부 · 일괄 수납 · 마감 이월이 같은 미수를 말한다.
import { defaultUiConfig, type UiConfig } from '@skinote/contract';
import { expect } from 'vitest';
import {
  charged, closingSheet, currentApplication, dueFor, groupPaySheet, lineCharged, linePaid, orderSlip, ownDue, paidIn, paidTotal, postingDate, refunded,
  sectionDiscountNow, type ShopState,
} from '../src/index.ts';

const config: UiConfig = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });

export function assertMoney(state: ShopState): void {
  for (const o of state.orders) {
    const where = o.id;
    // 1. 청구 = 줄 값 + 조정, 할인 변경의 줄 몫 합 = 그 조정 금액.
    expect(charged(o), where).toBe(o.lines.reduce((sum, l) => sum + l.amount, 0) + (o.charges ?? []).reduce((sum, c) => sum + c.amount, 0));
    for (const c of o.charges ?? []) {
      if (c.kind === 'discount_change') expect(c.lines.reduce((sum, x) => sum + x.amount, 0), where + ' ' + c.id).toBe(c.amount);
    }
    // 2. 환불은 이 접수의 받은 수납을 가리키고, 수단은 그 수납의 수단 또는 현금, 한 수납의 환불 합 ≤ 그 금액.
    for (const r of o.refunds ?? []) {
      const p = o.payments.find((x) => x.id === r.refundOf);
      expect(p, where + ' ' + r.id).toBeDefined();
      expect([p!.methodKey === 'deposit' ? 'cash' : p!.methodKey, 'cash']).toContain(r.methodKey);
      expect(r.amount).toBeGreaterThan(0);
    }
    for (const p of o.payments) {
      const back = (o.refunds ?? []).filter((r) => r.refundOf === p.id).reduce((sum, r) => sum + r.amount, 0);
      expect(back, where + ' ' + p.id).toBeLessThanOrEqual(p.amount);
    }
    // 4. 칸마다 마지막 할인 적용의 금액 = 그 칸의 지금 할인(줄 몫의 합).
    for (const section of ['gear', 'lift'] as const) {
      const app = currentApplication(o, section);
      if (app) expect(sectionDiscountNow(o, section), where + ' ' + section).toBe(app.amount);
    }
    // 5. 할인 까닭의 환불 합 ≤ 그 적용이 비운 돈, 받은 돈 − 환불 ≥ 0.
    const causes = new Set((o.refunds ?? []).flatMap((r) => (r.cause.kind === 'discount' && r.cause.id ? [r.cause.id] : [])));
    for (const id of causes) {
      const freed = -(o.charges ?? []).filter((c) => c.kind === 'discount_change' && c.applicationId === id).reduce((sum, c) => sum + c.amount, 0);
      const back = (o.refunds ?? []).filter((r) => r.cause.id === id).reduce((sum, r) => sum + r.amount, 0);
      expect(back, where + ' cause ' + id).toBeLessThanOrEqual(freed);
    }
    expect(paidTotal(o), where).toBeGreaterThanOrEqual(0);
    expect(paidTotal(o), where).toBe(paidIn(o) - refunded(o));
    // 7. 줄마다 채운 돈의 합 = min(받은 돈 − 환불, 줄 청구 합).
    const paid = linePaid(o);
    const sumPaid = [...paid.values()].reduce((sum, x) => sum + x.amount, 0);
    const room = o.lines.reduce((sum, l) => sum + Math.max(0, lineCharged(o, l)), 0);
    expect(sumPaid, where + ' linePaid').toBe(Math.min(paidTotal(o), room));
    for (const l of o.lines) expect(paid.get(l.id)!.amount, where + ' ' + l.id).toBeLessThanOrEqual(Math.max(0, lineCharged(o, l)));
  }
  // 3. 결제 자리마다 몫의 합 = 금액.
  for (const g of state.paymentGroups) {
    const shares = state.orders.flatMap((o) => o.payments.filter((p) => p.groupId === g.id));
    expect(shares.reduce((sum, p) => sum + p.amount, 0), g.id).toBe(g.amount);
  }
  // 6. 마감: 그날의 결제 수단 표 합(환불 줄 포함) = 그날 올린 받은 돈(보증금 결제 뺌) − 그날 올린 환불.
  const date = state.businessDate;
  const sheet = closingSheet({ state, config, now: state.orders.reduce((max, o) => Math.max(max, ...o.payments.map((p) => p.at)), 0) + 1 }, { date });
  const posted = (ms: number) => postingDate(state, ms) === date;
  const paidDay = state.orders.reduce((sum, o) => sum + o.payments.filter((p) => p.methodKey !== 'deposit' && posted(p.at)).reduce((n, p) => n + p.amount, 0), 0);
  const backDay = state.orders.reduce((sum, o) => sum + (o.refunds ?? []).filter((r) => posted(r.at)).reduce((n, r) => n + r.amount, 0), 0);
  expect(sheet.methods.reduce((sum, m) => sum + m.amount, 0), 'closing methods').toBe(paidDay - backDay);
}

/**
 * 한 접수의 미수를 모든 화면이 같게 말하는지: 접수증 돈 줄(money.due) = 청구 − 받은 돈, 줄 배분의 합(이 팀 몫 + 다른 팀 몫) = 그것, 결제 팀이 있으면
 * 그 팀의 일괄 수납 판의 이 팀 줄 금액 = 그 팀이 낼 몫.
 */
export function assertMoneyViews(state: ShopState, orderId: string, now: number): void {
  const o = state.orders.find((x) => x.id === orderId)!;
  const slip = orderSlip({ state, config, now }, orderId)!;
  expect(slip.money.due, orderId + ' slip due').toBe(ownDue(o));
  expect(slip.money.charged).toBe(charged(o));
  expect(slip.money.paid).toBe(paidTotal(o));
  const paid = linePaid(o);
  const left = o.lines.reduce((sum, l) => sum + Math.max(0, lineCharged(o, l) - paid.get(l.id)!.amount), 0);
  expect(left, orderId + ' line left').toBe(ownDue(o));
  const payer = o.payerOrderId;
  if (payer) {
    const view = groupPaySheet({ state, config, now }, { orderId: payer });
    const row = view.rows.find((r) => r.orderId === orderId);
    if (dueFor(o, payer) > 0) expect(row?.amount, orderId + ' group pay row').toBe(dueFor(o, payer));
  }
}

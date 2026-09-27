// 2026-09-27 점검의 돈 · 수 셈 고침: 취소 뒤의 일정 변경 연장, 연장을 받은 일정 몫만의 취소 값, 요금을 바꾼 뒤의 연장 값, 줄에 묶이지 않은 초과 수납의
// 환불, 창을 연 뒤 바뀐 취소 · 할인의 충돌, 취소가 푼 보증금의 반환, 결제 팀의 품목 취소, 차량 재고 · 지갑, 할인 몫의 끝전.
import {
  defaultUiConfig, draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type CancelSheetParams, type ConfirmCommand, type Expect, type OrderDraftInput, type UiConfig,
} from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import {
  applyCommand, charged, closingSheet, conflictKeys, ledgerView, depositOf, discountedAmounts, findOrder, heldAmount, kstAt, lineCharged, linePaid, overpaid, ownDue, runQuery, sampleRules,
  selfDue, vehicleEndRefusal, vehicleStock, walletBalance, type ShopState,
} from '../src/index.ts';
import { sampleDay } from '../src/sample/index.ts';
import { assertMoney, assertMoneyViews } from './money-check.ts';

const at = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const NOW = at(15, 40);
const config: UiConfig = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
const first = (): ShopState => sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
const ctx = (now = NOW) => ({ config, now });
const text = (runs: readonly { text: string }[] | undefined) => (runs ?? []).map((r) => r.text).join('');

let seq = 0;
const rid = () => '01K62M2QG00000000000009' + String(++seq).padStart(3, '0');
function envelopeOf(state: ShopState, command: ConfirmCommand, extra: { expect?: Expect; dependsOn?: string[]; deviceSeq?: number; rev?: number } = {}): AnyCommandEnvelope {
  const draft = openCommandDraft(command, { epoch: state.epoch, rev: extra.rev ?? state.rev }, {
    requestId: rid(), ...(extra.expect ? { expect: extra.expect } : {}), ...(extra.dependsOn ? { dependsOn: extra.dependsOn } : {}),
  });
  return draftToEnvelope(draft, extra.deviceSeq !== undefined ? { deviceSeq: extra.deviceSeq } : {});
}
const send = (state: ShopState, command: ConfirmCommand, now = NOW, extra: Parameters<typeof envelopeOf>[2] = {}) => applyCommand(state, envelopeOf(state, command, extra), now);
const order = (state: ShopState, id: string) => findOrder(state, id)!;
const line = (state: ShopState, id: string) => state.orders.flatMap((o) => o.lines).find((l) => l.id === id)!;

/** 창이 써 준 명령과 이어진 명령(환불 · 보증금 반환)을 차례로 보낸다. */
function sendView(state: ShopState, view: { command?: ConfirmCommand; expect?: Expect; then?: { command: ConfirmCommand; expect?: Expect }[] }, now = NOW) {
  if (!view.command) return [];
  const firstEnv = envelopeOf(state, view.command, view.expect ? { expect: view.expect } : {});
  const outcomes = [applyCommand(state, firstEnv, now)];
  let previous = firstEnv.requestId;
  for (const step of view.then ?? []) {
    if (outcomes.at(-1)!.outcome !== 'applied') break;
    const next = envelopeOf(state, step.command, { ...(step.expect ? { expect: step.expect } : {}), dependsOn: [previous] });
    outcomes.push(applyCommand(state, next, now));
    previous = next.requestId;
  }
  return outcomes;
}
const cancel = (state: ShopState, params: CancelSheetParams, now = NOW) => {
  const view = runQuery(state, 'cancelSheet', params, ctx(now));
  return { view, outcomes: sendView(state, view, now) };
};
const promise = (state: ShopState, lineId: string, n: number, slotKey: string, day: string) =>
  runQuery(state, 'promiseSheet', { orderId: lineId.split('-')[0]!, quantities: { [lineId]: n }, slot: { day: day as 'today', slotKey }, place: { mode: 'store' } }, ctx());
const directReturn = (state: ShopState, orderId: string, lineId: string, n: number) =>
  send(state, { type: 'stock.direct_return', payload: { orderId, lines: [{ lineId, quantity: n }] } });

describe('일정 변경의 연장(취소 뒤, extension.ts)', () => {
  it('품목 취소 뒤 남은 스키를 같은 날 22:00으로: 연장 없음, 내일로: 1일 × 1대 = 40,000원', () => {
    const s = first();
    expect(directReturn(s, 'o27', 'o27-l1', 1).outcome).toBe('applied');
    expect(cancel(s, { orderId: 'o27', scope: 'lines', picked: [{ lineId: 'o27-l1', quantity: 1 }] }).outcomes.map((x) => x.outcome)[0]).toBe('applied');
    expect(lineCharged(order(s, 'o27'), line(s, 'o27-l1'))).toBe(40_000);
    const same = promise(s, 'o27-l1', 1, 'night', 'today');
    expect(text(same.summary.changed)).not.toContain('연장');
    expect(same.expect).toBeUndefined();
    expect(sendView(s, same)[0]!.outcome).toBe('applied');
    expect((order(s, 'o27').charges ?? []).some((c) => c.kind === 'extension')).toBe(false);
    const tomorrow = promise(s, 'o27-l1', 1, 'night', 'tomorrow');
    expect(text(tomorrow.summary.changed)).toContain('연장 + 40,000원');
    expect(sendView(s, tomorrow)[0]!.outcome).toBe('applied');
    expect(lineCharged(order(s, 'o27'), line(s, 'o27-l1'))).toBe(80_000);
    assertMoney(s);
  });

  it('연장한 뒤 한 대를 반납 · 취소하고 남은 스키를 같은 날 더 늦게: 더 받지 않는다(남은 스키 이틀 80,000원)', () => {
    const s = first();
    const both = promise(s, 'o27-l1', 2, 'night', 'tomorrow');
    expect(text(both.summary.changed)).toContain('연장 + 80,000원');
    sendView(s, both);
    directReturn(s, 'o27', 'o27-l1', 1);
    const view = runQuery(s, 'cancelSheet', { orderId: 'o27', scope: 'lines', picked: [{ lineId: 'o27-l1', quantity: 1 }] }, ctx());
    // 취소한 스키는 연장한 일정에서 돌아온 것: 1일 값 + 연장 1일 = 80,000원.
    expect(text(view.summary[0])).toMatch(/^취소 금액 80,000원/);
    sendView(s, view);
    expect(lineCharged(order(s, 'o27'), line(s, 'o27-l1'))).toBe(80_000);
    const later = promise(s, 'o27-l1', 1, 'late_night', 'tomorrow');
    expect(text(later.summary.changed)).not.toContain('연장');
    sendView(s, later);
    expect(lineCharged(order(s, 'o27'), line(s, 'o27-l1'))).toBe(80_000);
    assertMoney(s);
  });

  it('요금을 바꾼 뒤의 연장은 접수 때 값(1일 40,000원), 견본 줄처럼 값이 없는 옛 줄은 지금 요금표', () => {
    const s = first();
    const draft: OrderDraftInput = {
      channel: 'walk_in', leader: { name: '한가을', phone: '01000000077', party: 1 }, items: [{ productKey: 'ski', quantity: 1 }],
      pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store', slot: { day: 'today', slotKey: 'night' } },
    };
    const sheet = runQuery(s, 'checkoutSheet', { draft, choices: [{ sectionKey: 'gear', methodKey: 'card' }] }, ctx());
    const created = sendView(s, sheet)[0]!;
    expect(created.outcome).toBe('applied');
    const id = String(created.result?.orderId);
    expect(line(s, id + '-l1').dayPrice).toBe(40_000);
    expect(send(s, { type: 'registry.update', payload: { changes: [{ op: 'price.set', productKey: 'ski', amount: 50_000 }] } } as ConfirmCommand).outcome).toBe('applied');
    send(s, { type: 'stock.issue', payload: { orderId: id, lines: [{ lineId: id + '-l1', quantity: 1 }] } });
    expect(text(promise(s, id + '-l1', 1, 'night', 'tomorrow').summary.changed)).toContain('연장 + 40,000원');
    expect(text(promise(s, 'o27-l1', 1, 'night', 'tomorrow').summary.changed)).toContain('연장 + 50,000원');
    // 10원 단위가 아닌 요금은 받지 않는다(할인 몫의 끝전).
    expect(send(s, { type: 'registry.update', payload: { changes: [{ op: 'price.set', productKey: 'ski', amount: 12_345 }] } } as ConfirmCommand).outcome).not.toBe('applied');
  });
});

describe('취소 값의 연장 몫(E5 개정)', () => {
  it('한 대만 내일로 옮긴(연장) 뒤 다른 스키를 반납 · 취소: 취소 금액 40,000원, 남은 스키 이틀 80,000원', () => {
    const s = first();
    sendView(s, promise(s, 'o27-l1', 1, 'night', 'tomorrow'));
    expect(lineCharged(order(s, 'o27'), line(s, 'o27-l1'))).toBe(120_000);
    directReturn(s, 'o27', 'o27-l1', 1);
    const { view, outcomes } = cancel(s, { orderId: 'o27', scope: 'lines', picked: [{ lineId: 'o27-l1', quantity: 1 }] });
    expect(text(view.summary[0])).toMatch(/^취소 금액 40,000원/);
    expect(outcomes[0]!.outcome).toBe('applied');
    expect(lineCharged(order(s, 'o27'), line(s, 'o27-l1'))).toBe(80_000);
    assertMoney(s);
  });
});

describe('초과 수납의 환불(줄에 묶이지 않은 몫)', () => {
  it('할인 뒤 보냄 대기 현장 수납 120,000원 → 초과 12,000원 환불: 줄 미수 없음, 돈이 맞는다', () => {
    const s = first();
    const discount = runQuery(s, 'discountSheet', { orderId: 'o28', sectionKey: 'gear', choice: { ruleKey: 'ten_percent' } }, ctx());
    expect(sendView(s, discount)[0]!.outcome).toBe('applied');
    expect(ownDue(order(s, 'o28'))).toBe(108_000);
    const collect = send(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 120_000, methodKey: 'cash' } }, NOW, { deviceSeq: 5, expect: { dueAmount: 108_000 } });
    expect(collect.outcome).toBe('applied');
    expect(overpaid(order(s, 'o28'))).toBe(12_000);
    assertMoney(s);
    const refund = runQuery(s, 'refundSheet', { orderId: 'o28' }, ctx());
    expect(refund.primary.label).toBe('환불 · 현금 12,000원');
    expect(sendView(s, refund)[0]!.outcome).toBe('applied');
    const o = order(s, 'o28');
    expect([ownDue(o), selfDue(o), overpaid(o)]).toEqual([0, 0, 0]);
    expect([...linePaid(o).values()].reduce((sum, x) => sum + x.amount, 0)).toBe(108_000);
    assertMoney(s);
    assertMoneyViews(s, 'o28', NOW);
    expect(runQuery(s, 'orderSlip', { orderId: 'o28' }, ctx()).money.due).toBe(0);
    expect(ledgerView(s, 'day_ledger', { tabKey: 'unpaid' }, ctx()).rows.some((r) => r.orderId === 'o28')).toBe(false);
  });
});

describe('환불 줄(수납 셋)', () => {
  it('최하은 팀 계좌이체 + 현금 + 카드 → 접수 취소: 환불 셋 모두 금액 · 수단 버튼, 큰 금액부터(창이 두 줄씩 쪽으로 넘긴다)', () => {
    const s = first();
    const EMPTY = { channel: 'walk_in' as const, leader: { name: '', phone: '', party: 0 }, items: [], pickup: { mode: 'store' as const, immediate: true }, giveBack: { mode: 'store' as const } };
    for (const methodKey of ['cash', 'card']) {
      const view = runQuery(s, 'checkoutSheet', { draft: { ...EMPTY, items: [{ productKey: 'helmet', variantKey: '중', quantity: 1 }] }, addTo: 'o26', choices: [{ sectionKey: 'gear', methodKey }] }, ctx());
      expect(sendView(s, view)[0]!.outcome).toBe('applied');
    }
    const view = runQuery(s, 'cancelSheet', { orderId: 'o26', scope: 'order' }, ctx());
    // 같은 금액은 늦게 받은 수납부터(E4b 차례).
    expect(view.refunds.map((r) => r.parts.map((x) => x.text).join(' · '))).toEqual(['환불 · 계좌이체 135,000원', '환불 · 카드 5,000원 · 단말기 취소', '환불 · 현금 5,000원']);
    expect(view.refunds.every((r) => r.methods.length >= 1)).toBe(true);
    expect(view.refunds.reduce((sum, r) => sum + r.amount, 0)).toBe(145_000);
    expect(view.primary.label).toMatch(/환불 145,000원$/);
    const refunds = sendView(s, view);
    expect(refunds.map((x) => x.outcome)).toEqual(['applied', 'applied']);
    assertMoney(s);
    // 마감: 수단마다 환불이 그 줄에(빠지지 않음), 오늘 받은 줄이 없는 계좌이체(어제 선입금)는 환불 줄의 둘째 줄.
    const closing = closingSheet({ state: s, config, now: at(23, 50) }, {});
    expect(closing.methods.find((m) => m.key === 'card')!.note?.[0]).toEqual({ text: '환불 −5,000원', drop: 0 });
    expect(closing.methods.find((m) => m.key === 'cash')!.note?.[0]).toEqual({ text: '환불 −5,000원', drop: 0 });
    expect(closing.methods.find((m) => m.key === 'refund')).toMatchObject({ count: 3, amount: -145_000, note: [{ text: '계좌이체 135,000원', drop: 0 }] });
    // 접수증 돈 줄: 수단 조각은 돌려준 몫을 뺀 것(모두 돌려줘 없음), `환불 145,000원`.
    const slip = runQuery(s, 'orderSlip', { orderId: 'o26' }, ctx());
    expect(slip.money).toMatchObject({ charged: 0, paid: 0, refunded: 145_000, payments: [] });
    expect(slip.cancelled).toEqual({ label: '취소' });
    expect(runQuery(s, 'promiseSheet', { orderId: 'o26' }, ctx()).notice).toBe('취소');
    expect(slip.activeConditions).not.toContain('order_open');
    // 장부 바닥줄: 팀 수에서 뺀 취소 접수를 따로 말한다(`합계 17팀 · 취소 1`, 탭 `전체 18`과 맞게).
    const ledger = ledgerView(s, 'day_ledger', {}, ctx());
    const team = ledger.metrics.find((m) => m.metricKey === 'team_count');
    expect(team).toMatchObject({ cancelled: 1 });
    if (team?.unit === 'team') expect(team.value + (team.cancelled ?? 0)).toBe(ledger.tabCounts.all);
  });
});

describe('줄 배분이 금액보다 적은 옛 수납', () => {
  it('묶이지 않은 나머지는 접수 전체 돈이고, 초과 수납 환불은 나머지부터 뺀다', () => {
    const s = first();
    sendView(s, runQuery(s, 'discountSheet', { orderId: 'o28', sectionKey: 'gear', choice: { ruleKey: 'ten_percent' } }, ctx()));
    order(s, 'o28').payments.push({
      id: 'o28-old', amount: 120_000, methodKey: 'cash', at: NOW, drawerId: 'counter',
      lines: [{ lineId: 'o28-l1', quantity: 2, amount: 72_000 }, { lineId: 'o28-l2', quantity: 2, amount: 36_000 }],
    });
    assertMoney(s);
    expect(overpaid(order(s, 'o28'))).toBe(12_000);
    expect(sendView(s, runQuery(s, 'refundSheet', { orderId: 'o28' }, ctx()))[0]!.outcome).toBe('applied');
    const o = order(s, 'o28');
    expect(o.refunds?.map((r) => [r.amount, r.lines?.length ?? 0])).toEqual([[12_000, 0]]);
    expect([selfDue(o), overpaid(o)]).toEqual([0, 0]);
    assertMoney(s);
    assertMoneyViews(s, 'o28', NOW);
  });
});

describe('창을 연 뒤 바뀐 취소 · 할인(E19)', () => {
  it('같은 품목 취소 창을 두 번 확정: 두 번째는 충돌(헬멧 1개만 취소 · 5,000원만 환불)', () => {
    const s = first();
    const a = runQuery(s, 'cancelSheet', { orderId: 'o26', scope: 'lines', picked: [{ lineId: 'o26-l2', quantity: 1 }] }, ctx());
    const b = runQuery(s, 'cancelSheet', { orderId: 'o26', scope: 'lines', picked: [{ lineId: 'o26-l2', quantity: 1 }] }, ctx());
    expect(sendView(s, a).map((x) => x.outcome)).toEqual(['applied', 'applied']);
    const second = sendView(s, b);
    expect(second[0]!.outcome).toBe('conflict');
    expect(line(s, 'o26-l2').cancelled).toBe(1);
    expect((order(s, 'o26').refunds ?? []).reduce((sum, r) => sum + r.amount, 0)).toBe(5_000);
    assertMoney(s);
  });

  it('헬멧 3 취소 창을 연 뒤 두 개를 지급: 조용히 줄이지 않고 `수량 변경됨 · 재시도 필요`', () => {
    const s = first();
    const stale = runQuery(s, 'cancelSheet', { orderId: 'o22', scope: 'lines', picked: [{ lineId: 'o22-l3', quantity: 3 }] }, ctx());
    expect(send(s, { type: 'stock.issue', payload: { orderId: 'o22', lines: [{ lineId: 'o22-l3', quantity: 2 }] } }).outcome).toBe('applied');
    const [outcome] = sendView(s, stale);
    expect(outcome!.outcome).toBe('conflict');
    expect(outcome!.error?.message).toBe('수량 변경됨 · 재시도 필요');
    expect(line(s, 'o22-l3').cancelled ?? 0).toBe(0);
  });

  it('할인 창을 연 뒤 다른 카운터의 품목 취소(환불 없음): 옛 창의 할인은 충돌', () => {
    const s = first();
    const stale = runQuery(s, 'discountSheet', { orderId: 'o24', sectionKey: 'gear', choice: { ruleKey: 'ten_percent' } }, ctx());
    expect(stale.primary.label).toBe('할인 적용 · 환불 현금 6,000원');
    expect(cancel(s, { orderId: 'o24', scope: 'lines', picked: [{ lineId: 'o24-l2', quantity: 1 }], decision: 'no_refund' }).outcomes[0]!.outcome).toBe('applied');
    expect(sendView(s, stale)[0]!.outcome).toBe('conflict');
    assertMoney(s);
  });

  it('충돌 키: 취소는 줄 수량 · 돈을 쓰고 값을 읽는다, 지급은 줄 수량을 쓴다', () => {
    const s = first();
    const keys = conflictKeys(s, envelopeOf(s, { type: 'order.cancel', payload: { orderId: 'o26', scope: 'lines', lines: [{ lineId: 'o26-l2', quantity: 1 }], reasonKey: 'request', decision: 'refund' } }));
    expect(keys.writes).toEqual(['line:o26-l2:quantity', 'order:o26:money']);
    expect(keys.reads).toEqual(['order:o26:money', 'line:o26-l2:price']);
    expect(conflictKeys(s, envelopeOf(s, { type: 'stock.issue', payload: { orderId: 'o22', lines: [{ lineId: 'o22-l3', quantity: 2 }] } })).writes).toEqual(['line:o22-l3:quantity']);
    expect(conflictKeys(s, envelopeOf(s, { type: 'order.add', payload: { orderId: 'o22', items: [], choices: [], payer: 'order' } })).writes).toEqual(['order:o22:lines', 'order:o22:money']);
  });
});

describe('취소가 푼 보증금', () => {
  const takeAndCancel = (s: ShopState) => {
    const rule = s.settings.liftDeposit!;
    expect(send(s, { type: 'deposit.take', payload: { orderId: 'o22', ruleKey: rule.key, lines: [{ lineId: 'o22-l4', quantity: 3 }], amount: 3 * rule.unitAmount, methodKey: 'cash' } }, NOW, { expect: { depositHeld: 0 } }).outcome).toBe('applied');
    const { view, outcomes } = cancel(s, { orderId: 'o22', scope: 'order' });
    return { rule, view, outcomes };
  };

  it('번호 매장: 권 3매 보증금 15,000원을 맡은 전화 예약을 접수 취소 → 환불과 이어서 보증금 반환', () => {
    const s = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo', shop: 'numbered' });
    const { rule, view, outcomes } = takeAndCancel(s);
    expect(view.refunds.map((r) => text(r.parts))).toContain('보증금 반환 · 현금 15,000원');
    expect(view.then?.map((x) => x.command.type)).toEqual(['payment.refund', 'deposit.return']);
    expect(outcomes.map((x) => x.outcome)).toEqual(['applied', 'applied', 'applied']);
    expect(heldAmount(depositOf(s, 'o22', rule.key))).toBe(0);
    assertMoney(s);
  });

  it('수량으로 세는 권에 보증금을 켠 매장: 같은 길', () => {
    const s = first();
    s.settings.liftDeposit = sampleRules('numbered').liftDeposit;
    const { rule, outcomes } = takeAndCancel(s);
    expect(outcomes.map((x) => x.outcome)).toEqual(['applied', 'applied', 'applied']);
    expect(heldAmount(depositOf(s, 'o22', rule.key))).toBe(0);
  });
});

describe('결제 팀 · 당일 취소 환불', () => {
  it('이정호 팀의 모든 줄을 품목 취소: 이서연 팀의 결제 예정을 푼다(미수는 이서연 팀 몫으로)', () => {
    const s = first();
    const { view, outcomes } = cancel(s, { orderId: 'o32', scope: 'lines', picked: [{ lineId: 'o32-l1', quantity: 2 }, { lineId: 'o32-l2', quantity: 2 }] });
    expect(view.summary.map(text)).toContain('이서연 팀 결제 예정 해제');
    expect(outcomes[0]!.outcome).toBe('applied');
    expect(order(s, 'o36').payerOrderId).toBeUndefined();
    expect(selfDue(order(s, 'o36'))).toBe(charged(order(s, 'o36')));
    assertMoney(s);
  });

  it('당일 취소 환불 `환불 없음`: 장비가 섞인 품목 취소는 환불이 처음 값, 리프트권만이면 환불 없음', () => {
    const s = first();
    s.settings.sameDayCancelRefund = 'no_refund';
    const later = at(16, 10);
    expect(runQuery(s, 'cancelSheet', { orderId: 'o22', scope: 'lines', picked: [{ lineId: 'o22-l3', quantity: 1 }, { lineId: 'o22-l4', quantity: 1 }] }, ctx(later)).decision).toBe('refund');
    expect(runQuery(s, 'cancelSheet', { orderId: 'o22', scope: 'lines', picked: [{ lineId: 'o22-l4', quantity: 1 }] }, ctx(later)).decision).toBe('no_refund');
  });
});

describe('차량 재고 · 지갑(사용 종료의 막힘)', () => {
  it('적재한 배달을 취소하고 매장 입고하면 차량 재고에서 빠진다', () => {
    const s = first();
    const start = vehicleStock(s, 'v1');
    const load = runQuery(s, 'confirmDraft', { orderId: 'o26', actionKey: 'stamp.load' }, ctx());
    sendView(s, load);
    expect(vehicleStock(s, 'v1')).toBe(start + 6);
    cancel(s, { orderId: 'o26', scope: 'order' });
    sendView(s, runQuery(s, 'confirmDraft', { actionKey: 'receive_to_shop', vehicleId: 'v1' }, ctx()));
    expect(vehicleStock(s, 'v1')).toBe(start);
  });

  it('전날 차량 지갑에 남은 현금은 다음 영업일에도 사용 종료를 막는다', () => {
    const s = first();
    s.registry = { ...s.registry, vehicles: [...s.registry.vehicles, { id: 'v3', label: '3호 차량' }] };
    s.drawers.push({ id: 'van:v3', kind: 'vehicle', label: '3호 차량 현금', vehicleId: 'v3' });
    order(s, 'o21').payments.push({ id: 'o21-van3', amount: 30_000, methodKey: 'cash', at: at(21, 0), drawerId: 'van:v3' });
    expect(vehicleEndRefusal(s, 'v3')).toBe('사용 종료 불가 · 차량 현금 30,000원');
    s.businessDate = '2026-12-27';
    expect(walletBalance(s, 'v3')).toBe(30_000);
    expect(vehicleEndRefusal(s, 'v3')).toBe('사용 종료 불가 · 차량 현금 30,000원');
  });
});

describe('받은 수단과 다른 수단의 환불(cash.entry)', () => {
  it('카운터(cash.entry 없음): 창의 `현금`은 막힌 버튼, 명령도 거절 · 받은 수단 그대로는 된다', () => {
    const s = first();
    const counter = { roleKey: 'counter', permissions: ['discount.apply', 'payment.refund'] };
    const view = runQuery(s, 'discountSheet', { orderId: 'o21', sectionKey: 'gear', choice: { ruleKey: 'ten_percent' }, methods: { 'o21-p1': 'cash' } }, { config, now: NOW, viewer: counter });
    expect(view.refunds[0]!.methods.map((m) => [m.key, m.enabled, m.selected])).toEqual([['card', true, true], ['cash', false, false]]);
    const apply = envelopeOf(s, view.command!, { expect: view.expect! });
    expect(applyCommand(s, apply, NOW, undefined, { viewer: counter }).outcome).toBe('applied');
    const refund = (methodKey: string) => envelopeOf(s, { type: 'payment.refund', payload: { orderId: 'o21', cause: 'discount', refunds: [{ paymentId: 'o21-p1', methodKey, amount: 10_000 }] } }, { expect: { refundAmount: 10_000 }, dependsOn: [apply.requestId] });
    expect(applyCommand(s, refund('cash'), NOW, undefined, { viewer: counter }).error?.code).toBe('FORBIDDEN');
    expect(applyCommand(s, refund('card'), NOW, undefined, { viewer: counter }).outcome).toBe('applied');
    assertMoney(s);
  });
});

describe('할인의 다시 셈 · 이어받기 · 미수 결제의 권한', () => {
  it('품목 취소의 할인 다시 셈은 할인을 받은 줄만: 기사가 요금표 값으로 더한 권의 청구는 그대로(2026-09-27 점검)', () => {
    const s = first();
    const lift = runQuery(s, 'discountSheet', { orderId: 'o22', sectionKey: 'lift', choice: { ruleKey: 'ten_percent' } }, ctx());
    expect(applyCommand(s, envelopeOf(s, lift.command!, { expect: lift.expect! }), NOW).outcome).toBe('applied');
    const o = order(s, 'o22');
    const base = o.lines.find((l) => l.id === 'o22-l4')!;
    // 기사가 현장에서 더한 권(field.add_ticket의 모양: 할인 없음, 요금표 값).
    o.lines.push({ ...structuredClone(base), id: 'o22-l9', qty: 1, amount: 35_000, gross: undefined, issued: 1, issuedAt: NOW });
    delete o.lines.at(-1)!.gross;
    const before = lineCharged(o, o.lines.at(-1)!);
    expect(cancel(s, { orderId: 'o22', scope: 'lines', picked: [{ lineId: 'o22-l4', quantity: 1 }] }).outcomes[0]!.outcome).toBe('applied');
    expect(lineCharged(order(s, 'o22'), order(s, 'o22').lines.at(-1)!)).toBe(before);
    // 장비 칸(취소하지 않은 칸)의 할인은 그대로(다시 셈 없음).
    expect((order(s, 'o22').discounts ?? []).filter((d) => d.sectionKey === 'gear')).toEqual([]);
    assertMoney(s);
  });

  it('품목 추가가 이어받는 직접 입력 비율 할인은 그 사람의 권한 · 한도 안이어야 한다', () => {
    const s = first();
    const manual = runQuery(s, 'discountSheet', { orderId: 'o28', sectionKey: 'gear', choice: { manual: { kind: 'percent', value: 8, reason: '단골' } } }, ctx());
    expect(applyCommand(s, envelopeOf(s, manual.command!, { expect: manual.expect! }), NOW).outcome).toBe('applied');
    const EMPTY = { channel: 'walk_in' as const, leader: { name: '', phone: '', party: 0 }, items: [], pickup: { mode: 'store' as const, immediate: true }, giveBack: { mode: 'store' as const } };
    const params = { draft: { ...EMPTY, items: [{ productKey: 'ski', quantity: 2 }] }, addTo: 'o28', choices: [{ sectionKey: 'gear' as const, methodKey: 'later' }] };
    const counter = { roleKey: 'counter', permissions: ['order.add', 'discount.apply', 'discount.manual'], limits: { maxDiscountAmount: 10_000 } };
    // 8% × (120,000 + 160,000) = 22,400원 > 한도 10,000원: 창은 막히고 명령은 FORBIDDEN.
    const sheet = runQuery(s, 'checkoutSheet', params, { config, now: NOW, viewer: counter });
    expect(sheet.notice).toBe('권한 없음 · 관리자 확인 필요');
    expect(sheet.primary.enabled).toBe(false);
    const open = runQuery(s, 'checkoutSheet', params, ctx());
    expect(applyCommand(s, envelopeOf(s, open.command!, { expect: open.expect! }), NOW, undefined, { viewer: counter }).error?.code).toBe('FORBIDDEN');
    expect(applyCommand(s, envelopeOf(s, open.command!, { expect: open.expect! }), NOW).outcome).toBe('applied');
    assertMoney(s);
  });

  it('미수 결제는 수납 이동(payment.reallocate): 없는 사람에게는 회색 · 명령 거절', () => {
    const s = first();
    const counter = { roleKey: 'counter', permissions: ['order.cancel', 'payment.refund'] };
    const view = runQuery(s, 'cancelSheet', { orderId: 'o22', scope: 'lines', picked: [{ lineId: 'o22-l4', quantity: 3 }] }, { config, now: NOW, viewer: counter });
    expect(view.decisions?.find((d) => d.key === 'apply_to_due')).toMatchObject({ enabled: false, reason: '권한 없음 · 관리자 확인 필요' });
    const asked = runQuery(s, 'cancelSheet', { orderId: 'o22', scope: 'lines', picked: [{ lineId: 'o22-l4', quantity: 3 }], decision: 'apply_to_due' }, { config, now: NOW, viewer: counter });
    expect(asked.decision).toBe('refund');
    const full = runQuery(s, 'cancelSheet', { orderId: 'o22', scope: 'lines', picked: [{ lineId: 'o22-l4', quantity: 3 }], decision: 'apply_to_due' }, ctx());
    expect(applyCommand(s, envelopeOf(s, full.command!, { expect: full.expect! }), NOW, undefined, { viewer: counter }).error?.code).toBe('FORBIDDEN');
    expect(applyCommand(s, envelopeOf(s, full.command!, { expect: full.expect! }), NOW).outcome).toBe('applied');
    assertMoney(s);
  });
});

describe('할인 몫의 끝전(catalog 9)', () => {
  it('몫은 줄 값을 넘지 않는다(음수 줄 없음), 합은 할인 금액', () => {
    expect(discountedAmounts([12_345, 5], 12_350)).toEqual([0, 0]);
    expect(discountedAmounts([15, 15], 30)).toEqual([0, 0]);
    expect(discountedAmounts([80_000, 5_000], 8_500)).toEqual([72_000, 4_500]);
    for (const [amounts, cut] of [[[33_333, 11_111, 7], 44_440], [[10, 10, 10], 20]] as const) {
      const out = discountedAmounts(amounts, cut);
      expect(out.every((x) => x >= 0)).toBe(true);
      expect(amounts.reduce((a, b) => a + b, 0) - out.reduce((a, b) => a + b, 0)).toBe(cut);
    }
  });
});

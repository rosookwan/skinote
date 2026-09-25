// 보증금(impl-v2 plan.md 4-1 · catalog 11-1 · data-model 4-12): 팀 · 규칙마다 보관 하나(규칙 값 복사), 돈은 보증금 장부
// (entries)에만 있고 접수의 수납(payments)에는 넣지 않는다(청구 · 미수와 따로). 보관 금액 = 입금 + 몰수 취소 − 반환 − 미수 차감 − 몰수.
// 매수도 장부가 줄마다 센다. 이 파일은 규칙 찾기 · 보관 셈 · 지급 때 받을 보증금 · 보증금 입금(deposit.take) · 반납 창(V1)의
// 보증금 반환(deposit.return: 현금 · 동일 수단 반환 · 미수 차감)을 한다. 기사 현장의 입금 · 반환(field.add_ticket · field.deposit_return,
// 차량 지갑)은 driver.ts가 이 파일의 셈(보관 금액 · 매수 · planRefunds)으로 한다.
import type { CommandEnvelope, Expect } from '@skinote/contract';
import type { FxDeposit, FxDepositEntry, FxDepositRule, FxLine, FxMethodKey, FxOrder, ShopState } from './model.ts';
import { heldNumbers } from './assets.ts';
import { conflict, done, rejected, type Result } from './result.ts';
import { backCount, fillLines, selfDue, selfLines } from './rules.ts';

const SIGN: Record<FxDepositEntry['kind'], number> = { take: 1, restore: 1, refund: -1, apply: -1, keep: -1 };

/**
 * 이 줄에 걸리는 보증금 규칙(deposit_rules의 대상 종류 = 지금은 규칙의 결제 칸, 이 매장 리프트권 보증금). 보증금 미사용이거나
 * 돌려받지 않는 줄이면 null.
 * 이미 받은 보관은 규칙 값을 복사해 두었으므로(FxDeposit) 규칙이 바뀌어도 그 팀에 말한 금액대로다.
 */
export function depositRuleFor(state: ShopState, l: FxLine): FxDepositRule | null {
  const rule = state.settings.liftDeposit;
  // 돌려받지 않는 줄(반납 선택 매장의 리프트권)은 보증금을 받지 않는다: 돌아올 수 없어 반환도 정리도 못 한다.
  return rule && rule.section === l.section && l.returnable ? rule : null;
}

/**
 * 맡은 보증금을 찾을 때의 규칙: 보증금 미사용으로 바꾼 동안(V8)에도 이미 맡은 보관은 그 규칙으로 찾아 반환한다(새로 받지는 않는다,
 * 새 보증금은 settings.liftDeposit만 본다).
 */
export function heldRule(state: ShopState): FxDepositRule | null {
  return state.settings.liftDeposit ?? state.settings.liftDepositOff ?? null;
}

export function depositOf(state: ShopState, orderId: string, ruleKey: string): FxDeposit | undefined {
  return state.deposits.find((d) => d.orderId === orderId && d.ruleKey === ruleKey);
}

/** 보관 중인 금액. */
export function heldAmount(dep: FxDeposit | undefined): number {
  return (dep?.entries ?? []).reduce((sum, e) => sum + SIGN[e.kind] * e.amount, 0);
}

/** 이 줄의 보관 매수(입금 + 몰수 취소 − 반환 − 미수 차감 − 몰수). */
export function heldUnits(dep: FxDeposit | undefined, lineId: string): number {
  return (dep?.entries ?? []).filter((e) => e.lineId === lineId).reduce((sum, e) => sum + SIGN[e.kind] * e.quantity, 0);
}

/** 이 팀이 맡긴 보증금 전부(접수증 돈 줄의 '보증금 15,000원'). */
export function orderDepositHeld(state: ShopState, o: FxOrder): number {
  return state.deposits.filter((d) => d.orderId === o.id).reduce((sum, d) => sum + heldAmount(d), 0);
}

/** 1매 금액: 이미 받은 보관이 있으면 그 복사 값, 없으면 지금 규칙. */
const unitAmountOf = (dep: FxDeposit | undefined, rule: FxDepositRule) => dep?.unitAmount ?? rule.unitAmount;

/** 지급하면서 받을 보증금(한 규칙). 줄마다 매수, 합 매수 · 금액, 받는 수단(규칙의 첫 수단). */
export interface DepositDue {
  rule: FxDepositRule;
  unitAmount: number;
  lines: { lineId: string; quantity: number }[];
  units: number;
  amount: number;
  methodKey: FxMethodKey;
  /** 창을 연 때의 보관 금액(명령의 expect.depositHeld). */
  held: number;
}

/**
 * 지급 창이 먼저 물을 보증금(catalog 11-1, data-model 5): 이번에 줄 권 중 아직 보증금을 받지 않은 매수. 입금 시점이 접수 시인데
 * 접수 때 받지 못한 팀(전화 예약)과 입금 시점이 지급 시인 매장이 같은 길이다. 보증금 미사용이거나 받을 매수가 없으면 null.
 */
export function depositDueAtIssue(state: ShopState, o: FxOrder, picks: readonly { l: FxLine; qty: number }[]): DepositDue | null {
  const rule = state.settings.liftDeposit;
  if (!rule) return null;
  const dep = depositOf(state, o.id, rule.key);
  const lines = picks.flatMap(({ l, qty }) => {
    if (depositRuleFor(state, l)?.key !== rule.key) return [];
    // 이번 지급 뒤 손님에게 나가 있을 매수 − 이미 받은 매수(이번에 주는 수를 넘지 않음).
    const out = l.issued + qty - (l.returned + l.collected);
    const need = Math.min(qty, Math.max(0, out - heldUnits(dep, l.id)));
    return need > 0 ? [{ lineId: l.id, quantity: need }] : [];
  });
  const units = lines.reduce((sum, x) => sum + x.quantity, 0);
  if (units === 0) return null;
  const unitAmount = unitAmountOf(dep, rule);
  return { rule, unitAmount, lines, units, amount: units * unitAmount, methodKey: rule.methods[0] ?? 'cash', held: heldAmount(dep) };
}

/**
 * 이미 내준 권 중 보증금을 받지 않은 매수(이어 보낸 보증금 입금이 그사이 막혔을 때: 지급은 되었는데 입금이 안 됨). 창을 다시 열면
 * 지급 창이 이 매수만 묻는다(`보증금 입금 · 15,000원`, data-model 4-18 `창 안에서 다시 보임`). 없으면 null.
 */
export function depositDueForIssued(state: ShopState, o: FxOrder): DepositDue | null {
  const rule = state.settings.liftDeposit;
  if (!rule) return null;
  const dep = depositOf(state, o.id, rule.key);
  const lines = o.lines.flatMap((l) => {
    if (depositRuleFor(state, l)?.key !== rule.key) return [];
    const need = Math.max(0, l.issued - (l.returned + l.collected) - heldUnits(dep, l.id));
    return need > 0 ? [{ lineId: l.id, quantity: need }] : [];
  });
  const units = lines.reduce((sum, x) => sum + x.quantity, 0);
  if (units === 0) return null;
  const unitAmount = unitAmountOf(dep, rule);
  return { rule, unitAmount, lines, units, amount: units * unitAmount, methodKey: rule.methods[0] ?? 'cash', held: heldAmount(dep) };
}

/**
 * 돌아왔는데 아직 보증금을 돌려주지 않은 매수(줄마다): 보관 매수 − 아직 손님에게 있는 매수. 이어 보낸 보증금 반환이 막혔을 때 남는다.
 * 반납 창(V1)이 이 매수도 돌려줄 보증금에 넣고, 돌려받을 것이 없으면 보증금 반환만 한다.
 */
export function backHeldUnits(dep: FxDeposit | undefined, l: FxLine): number {
  return Math.max(0, heldUnits(dep, l.id) - Math.max(0, l.issued - backCount(l)));
}

/** 돌아온 번호 중 보증금을 아직 정리하지 않은 것(돌아온 차례). */
export function unsettledBack(dep: FxDeposit, l: FxLine): string[] {
  const settled = new Set(dep.entries.filter((e) => e.lineId === l.id && e.kind !== 'take').flatMap((e) => e.assetIds ?? []));
  return (l.backAssetIds ?? []).filter((id) => !settled.has(id));
}

/** 팀 전체의 돌아왔는데 돌려주지 않은 보증금(처리 현황 `보증금 반환 · 10,000원`). 없으면 null. */
export function backHeldRefund(state: ShopState, o: FxOrder): { dep: FxDeposit; units: number; amount: number } | null {
  for (const dep of state.deposits.filter((d) => d.orderId === o.id && heldAmount(d) > 0)) {
    const units = o.lines.reduce((n, l) => n + backHeldUnits(dep, l), 0);
    if (units > 0) return { dep, units, amount: units * dep.unitAmount };
  }
  return null;
}

/**
 * 보증금 입금(deposit.take, 카운터): 규칙이 있고, 수단이 규칙의 수단이고, 창이 본 보관 금액(expect.depositHeld)이 지금과 같고,
 * 매수가 그 줄의 권(내줬거나 내줄 것) − 이미 받은 매수를 넘지 않을 때만. 금액은 매수 × 1매 금액이어야 한다. 현금은 카운터 돈통.
 * 매수의 번호는 이 줄이 지금 내준 번호 중 아직 보증금을 받지 않은 것(지급 뒤에 오면 그 번호).
 */
export function takeDeposit(state: ShopState, envelope: CommandEnvelope<'deposit.take'>, now: number): Result {
  const p = envelope.payload;
  const o = state.orders.find((x) => x.id === p.orderId);
  if (!o) return rejected('접수 없음');
  const existing = depositOf(state, o.id, p.ruleKey);
  const rule = state.settings.liftDeposit;
  if (!rule || rule.key !== p.ruleKey) return rejected('보증금 미사용');
  const methodKey = p.methodKey as FxMethodKey;
  if (!rule.methods.includes(methodKey)) return rejected('등록되지 않은 결제 수단');
  const expect: Expect = envelope.expect ?? {};
  if (expect.depositHeld !== heldAmount(existing)) return conflict('DEPOSIT_CHANGED', '보증금 변경됨 · 재시도 필요');
  const unitAmount = unitAmountOf(existing, rule);
  const takes: { l: FxLine; quantity: number }[] = [];
  for (const entry of p.lines) {
    const l = o.lines.find((x) => x.id === entry.lineId);
    if (!l || depositRuleFor(state, l)?.key !== rule.key) return rejected('보증금 입금 불가 · 권 매수 없음');
    const quantity = Math.max(0, Math.floor(entry.quantity));
    const room = l.qty - (l.returned + l.collected) - heldUnits(existing, l.id);
    if (quantity > room) return rejected('보증금 입금 불가 · 권 매수 초과');
    if (quantity > 0) takes.push({ l, quantity });
  }
  const units = takes.reduce((sum, x) => sum + x.quantity, 0);
  if (units === 0) return rejected('보증금 입금 불가 · 권 매수 없음');
  if (p.amount !== units * unitAmount) return rejected('보증금 금액 불일치');
  const dep: FxDeposit = existing ?? { id: 'dep:' + o.id + ':' + rule.key, orderId: o.id, ruleKey: rule.key, label: rule.label, unitAmount, entries: [] };
  if (!existing) state.deposits.push(dep);
  takes.forEach(({ l, quantity }, i) => {
    const covered = new Set(dep.entries.filter((e) => e.lineId === l.id && e.kind === 'take').flatMap((e) => e.assetIds ?? []));
    const numbers = heldNumbers(l).filter((id) => !covered.has(id)).slice(0, quantity);
    dep.entries.push({
      id: envelope.requestId + ':' + i, kind: 'take', lineId: l.id, quantity, amount: quantity * unitAmount, methodKey, at: now,
      ...(numbers.length ? { assetIds: numbers } : {}),
      ...(methodKey === 'cash' ? { drawerId: 'counter' } : {}),
    });
  });
  return done;
}

/** 돌려줄 권(줄 · 매수 · 번호). */
export interface RefundPick {
  l: FxLine;
  quantity: number;
  assetIds?: string[];
}

/**
 * 보증금 반환의 줄마다 매수 · 번호(반납 창의 deposit.return과 수거 현장의 field.deposit_return이 같이 쓴다): 매수는 보관 매수와 '돌아왔지만
 * 아직 정리하지 않은 매수'를 넘지 않고, 번호는 돌아온 번호 중 고른 것(없으면 아직 정리하지 않은 것을 돌아온 차례로). 금액 = 매수 × 1매 금액.
 */
export function planRefunds(o: FxOrder, dep: FxDeposit, lines: readonly { lineId: string; quantity: number; assetIds?: string[] }[], amount: number): { refunds: RefundPick[]; amount: number } | { error: string } {
  const refunds: RefundPick[] = [];
  for (const entry of lines) {
    const l = o.lines.find((x) => x.id === entry.lineId);
    const quantity = Math.max(0, Math.floor(entry.quantity));
    if (!l) return { error: '보증금 반환 불가 · 권 매수 없음' };
    if (quantity === 0) continue;
    if (quantity > heldUnits(dep, l.id)) return { error: '보증금 반환 불가 · 권 매수 초과' };
    if (quantity > backCount(l) - settledUnits(dep, l.id)) return { error: '보증금 반환 불가 · 리프트권 미반납' };
    const settled = new Set(dep.entries.filter((e) => e.lineId === l.id && e.kind !== 'take').flatMap((e) => e.assetIds ?? []));
    const back = (l.backAssetIds ?? []).filter((id) => !settled.has(id));
    const asked = [...new Set(entry.assetIds ?? [])].filter((id) => back.includes(id));
    const numbers = (asked.length ? asked : back).slice(0, quantity);
    refunds.push({ l, quantity, ...(numbers.length ? { assetIds: numbers } : {}) });
  }
  const units = refunds.reduce((sum, x) => sum + x.quantity, 0);
  if (units === 0) return { error: '보증금 반환 불가 · 권 매수 없음' };
  const total = units * dep.unitAmount;
  if (amount !== total) return { error: '보증금 금액 불일치' };
  return { refunds, amount: total };
}

/** 이 줄에서 보증금을 이미 정리한 매수(반환 · 미수 차감 · 몰수 − 몰수 취소). */
function settledUnits(dep: FxDeposit, lineId: string): number {
  return dep.entries.filter((e) => e.lineId === lineId).reduce((sum, e) => sum + (e.kind === 'take' ? 0 : -SIGN[e.kind] * e.quantity), 0);
}

/** 보증금을 받은 수단(첫 입금 줄). 반환 방법 '동일 수단 반환'이 쓴다. */
export function takenMethod(dep: FxDeposit | undefined): FxMethodKey {
  return dep?.entries.find((e) => e.kind === 'take')?.methodKey ?? 'cash';
}

/**
 * 반환 방법(sys_deposit_refund_methods)의 key: 현금 반환 · 동일 수단 반환 · 미수 차감. 반납 창(V1)의 버튼과 명령이 같은 key를 쓴다.
 * 받은 수단이 현금이면 `현금`, 카드 · 계좌이체면 동일 수단(`카드 취소` · `계좌 반환`).
 */
export type RefundMethodKey = 'cash' | 'same_method' | 'offset_due';

/** 받은 수단으로 돌려주는 방법의 key(현금이면 cash, 아니면 same_method). */
export const baseRefundKey = (dep: FxDeposit | undefined): RefundMethodKey => (takenMethod(dep) === 'cash' ? 'cash' : 'same_method');

/**
 * 미수 차감을 고를 수 있는지: 이 팀이 스스로 낼 미수(결제 팀이 이 팀인 줄)가 반환 금액 이상일 때(다른 팀이 내기로 한 줄은 그 팀의 돈이라
 * 차감하지 않는다).
 * 보증금은 청구에 저절로 쓰지 않는다(data-model 4-12): 사람이 고른다.
 */
export function canOffset(o: FxOrder, amount: number): boolean {
  return amount > 0 && selfDue(o) >= amount;
}

/**
 * 보증금 반환(deposit.return, 반납 창 V1 · data-model 4-18): 돌아온 권만큼. 보관(팀 · 규칙마다 하나)이 있고, 창이 본 보관 금액
 * (expect.depositHeld)이 지금과 같고, 줄마다 매수가 보관 매수와 '돌아왔지만 아직 정리하지 않은 매수'를 넘지 않을 때만. 금액은
 * 매수 × 1매 금액(보관에 복사한 값). 반환 방법:
 *   - cash: 현금 반환(카운터 돈통에서 나감, drawerId counter).
 *   - same_method: 받은 수단으로(카드 취소 · 계좌 반환, 현금으로 받았으면 현금과 같다).
 *   - offset_due: 미수 차감. 보증금 장부에 apply 줄, 접수의 수납에 '보증금 결제' 한 행(돈은 움직이지 않음). 창이 본 미수
 *     (expect.dueAmount)가 지금과 다르면 충돌.
 * 반납(stock.direct_return) 뒤에 이어 온다(dependsOn). 돈 명령이라 앞 명령이 되지 않아도 멈추지 않고(plan §8 D11), 권이 아직 돌아오지
 * 않았으면 여기서 거절한다(`보증금 반환 불가 · 리프트권 미반납`).
 */
export function returnDeposit(state: ShopState, envelope: CommandEnvelope<'deposit.return'>, now: number): Result {
  const p = envelope.payload;
  const o = state.orders.find((x) => x.id === p.orderId);
  if (!o) return rejected('접수 없음');
  const dep = depositOf(state, o.id, p.ruleKey);
  if (!dep || heldAmount(dep) <= 0) return rejected('보증금 반환 불가 · 권 매수 없음');
  const expect: Expect = envelope.expect ?? {};
  if (expect.depositHeld !== heldAmount(dep)) return conflict('DEPOSIT_CHANGED', '보증금 변경됨 · 재시도 필요');
  const plan = planRefunds(o, dep, p.lines, p.amount);
  if ('error' in plan) return rejected(plan.error);
  const { refunds, amount } = plan;

  const key = p.refundMethodKey;
  if (key === 'offset_due') {
    if (!canOffset(o, amount)) return rejected('미수 차감 불가');
    if (expect.dueAmount !== undefined && expect.dueAmount !== selfDue(o)) return conflict('DUE_CHANGED', '받을 금액 변경됨 · 재시도 필요');
    // 보증금 결제는 이 팀이 스스로 낼 줄만 채운다(다른 팀이 내기로 한 줄을 채우지 않게).
    const lines = fillLines(o, selfLines(o), amount);
    refunds.forEach(({ l, quantity, assetIds }, i) => {
      dep.entries.push({ id: envelope.requestId + ':' + i, kind: 'apply', lineId: l.id, quantity, amount: quantity * dep.unitAmount, at: now, ...(assetIds ? { assetIds } : {}) });
    });
    o.payments.push({ id: envelope.requestId, amount, methodKey: 'deposit', at: now, ...(lines.length ? { lines } : {}) });
    return done;
  }
  if (key !== 'cash' && key !== 'same_method') return rejected('등록되지 않은 결제 수단');
  const methodKey: FxMethodKey = key === 'cash' ? 'cash' : takenMethod(dep);
  refunds.forEach(({ l, quantity, assetIds }, i) => {
    dep.entries.push({
      id: envelope.requestId + ':' + i, kind: 'refund', lineId: l.id, quantity, amount: quantity * dep.unitAmount, methodKey, at: now,
      ...(assetIds ? { assetIds } : {}),
      ...(methodKey === 'cash' ? { drawerId: 'counter' } : {}),
    });
  });
  return done;
}

// V5 일괄 수납 · 여러 팀(spec 3-6, ui 6-7)의 읽기 모델(groupPaySheet · partialPaySheet)과 일괄 수납 명령(payment.take + 결제 팀)의
// 처리. 화면은 고른 팀 · 탭 · 팀마다 고른 품목 수 · 수단 · 더한 팀만 인자로 다시 묻고,
// 줄 글 · 받을 금액 · 합계 · 주 버튼 · 명령은 모두 여기서 쓴다(문구 표 docs/design/wording.md 3-8의 말).
//   - 줄: 이 팀(`결제 팀`, 제 몫) · 이 팀이 내기로 한 팀(`결제 예정`, 그 팀 줄 중 이 팀이 낼 몫, 줄 단위 결제 약속 포함) · `팀 추가 · 끝 4자리`로
//     더한 팀. `미수` 탭은 장부의 미수 탭과 같은 정의(다른 팀이 낼 몫은 미수로 세지 않음)이고 이 팀이 맨 위다.
//   - 부분 결제는 품목 · 수량으로만 고른다(사람으로 나누지 않음, 사장님 답 5). 받을 금액 칸은 그대로, 합계 · 주 버튼은 고른 만큼.
//   - 수납(payment.take)은 돈 한 건(결제 자리 multi_order)과 팀마다의 몫(줄 · 수량 · 금액 배분, data-model 4-12). 창이 본 팀마다의 받을
//     금액(expect.dueByOrder)이 지금과 다르면 충돌이고, 그사이 다른 카운터가 받은 팀은 `강지은 팀 45,000원 수납 완료 · 다른 카운터`(sync 4-3).
//     품목 일부만 낸 팀의 남은 줄은 그 팀 몫(미수, 반납 시)으로 돌아간다(plan §4-1, V5 #part: 이민호 팀 의류 3).
import {
  ACTION_LABELS, CHECKOUT_KEYS, DomainError, GROUP_PAY_TABS, type ChoiceOption, type CommandEnvelope, type ConfirmCommand, type Expect, type GroupPayRow,
  type GroupPaySheetParams, type GroupPaySheetView, type LineUnits, type PartialPaySheetParams, type PartialPaySheetView, type PaymentAllocationInput,
} from '@skinote/contract';
import { lineNames, payMethodOf } from './catalog.ts';
import type { FxLine, FxMethodKey, FxOrder, FxPaymentGroup, ShopState } from './model.ts';
import { conflict, nothing, rejected, type Result } from './result.ts';
import {
  coveredOrders, dueFor, findOrder, lineAmountFor, lineCharged, lineLeft, linePaid, linePayerId, lineQtyLeft, nextDue, selfDue,
} from './rules.ts';
import { itemCounts } from './stamps.ts';
import { iso } from './time.ts';
import type { ViewContext } from './views.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';
const teamLabel = (o: FxOrder) => o.teamName + ' · ' + o.last4;
const countWordOf = (l: FxLine) => l.countWord ?? l.unit ?? '개';
/** 수납 처리(sys_actions stamp.pay 이름): 주 버튼 앞말. */
const PAY_LABEL = ACTION_LABELS['stamp.pay'];
const DEFAULT_METHOD: FxMethodKey = 'card';

// ── 셈(읽기 모델과 명령이 같은 셈을 쓴다) ─────────────────────────────────

/** 줄의 종류: 이 팀(제 몫) · 이 팀이 내기로 한 팀 · 다른 팀이 내기로 한 팀 · 미수. */
type RowKind = 'self' | 'covered' | 'promised' | 'unpaid';

/** 한 팀 안에서 고른 품목 수(부분 결제). */
interface PartPlan {
  lines: { line: FxLine; quantity: number; amount: number }[];
  amount: number;
}

interface RowPlan {
  order: FxOrder;
  kind: RowKind;
  /** 이 수납에서 낼 줄(받을 돈이 남은 것). */
  lines: FxLine[];
  /** 받을 금액 칸(그 팀 몫 모두). */
  amount: number;
  part: PartPlan | null;
}

export interface GroupPayPlan {
  payer: FxOrder;
  group: RowPlan[];
  unpaid: RowPlan[];
  /** 수납에 드는 팀(고른 팀 중 받을 금액이 있는 것, 탭 차례: 이 팀이 내는 팀 → 미수 탭에만 있는 팀). */
  selected: RowPlan[];
  dropped: { order: FxOrder; note: string }[];
  methodKey: FxMethodKey;
  /** 받은 수단 key가 틀림(창은 막고, 명령은 거절). */
  invalidMethod: boolean;
  total: number;
}

/**
 * payer가 이 수납에서 팀 X의 낼 줄: 이 팀이면 스스로 낼 줄, 이 팀이 내기로 한 팀이면 그 몫의 줄(줄 · 접수의 결제 팀), 그 밖의 팀(미수 탭 ·
 * 더한 팀)은 받을 돈이 남은 줄 모두.
 */
export function payableLines(payer: FxOrder, x: FxOrder): FxLine[] {
  const paid = linePaid(x);
  const open = x.lines.filter((l) => lineLeft(x, l, paid) > 0);
  const promised = open.filter((l) => linePayerId(x, l) === payer.id);
  // 이 팀 자신이면 스스로 낼 줄(다른 팀이 내기로 한 줄은 그 팀 몫). 스스로 낼 것이 없으면 남은 줄 모두(직접 수납).
  if (x.id === payer.id) return promised.length ? promised : open;
  return promised.length ? promised : open;
}

/** payer가 이 수납에서 팀 X에게서 받을 금액(받을 금액 칸). */
export function amountFor(payer: FxOrder, x: FxOrder): number {
  const paid = linePaid(x);
  return payableLines(payer, x).reduce((sum, l) => sum + lineLeft(x, l, paid), 0);
}

function kindOf(payer: FxOrder, x: FxOrder): RowKind {
  if (x.id === payer.id) return 'self';
  if (dueFor(x, payer.id) > 0) return 'covered';
  if (x.lines.some((l) => linePayerId(x, l) !== x.id && lineLeft(x, l) > 0)) return 'promised';
  return 'unpaid';
}

function rowOf(payer: FxOrder, x: FxOrder): RowPlan {
  const paid = linePaid(x);
  const lines = payableLines(payer, x);
  return { order: x, kind: kindOf(payer, x), lines, amount: lines.reduce((sum, l) => sum + lineLeft(x, l, paid), 0), part: null };
}

/** 장부의 미수 탭과 같은 정의: 이 팀이 스스로 낼 미수가 있는 팀(다른 팀이 내기로 한 줄은 그 팀의 대납). */
const isUnpaid = (o: FxOrder) => selfDue(o) > 0;

/**
 * 팀 안에서 고른 품목 수(인자) → 부분 결제. 낼 줄이 아닌 줄 · 0은 빼고 수는 남은 수까지. 남은 것을 모두 골랐으면 부분이 아니다(null),
 * 하나도 고르지 않았어도 부분이 아니다(부분 결제 판의 주 버튼이 막는다).
 */
function partOf(row: RowPlan, lines: readonly LineUnits[] | undefined): PartPlan | null {
  if (!lines) return null;
  const x = row.order;
  const paid = linePaid(x);
  const chosen = row.lines.map((line) => {
    const max = lineQtyLeft(x, line, paid);
    const want = lines.filter((u) => u.lineId === line.id).reduce((sum, u) => sum + Math.max(0, Math.floor(u.quantity) || 0), 0);
    const quantity = Math.min(max, want);
    return { line, quantity, amount: lineAmountFor(x, line, quantity, paid), all: quantity === max };
  });
  if (chosen.every((c) => c.all)) return null;
  const picked = chosen.filter((c) => c.quantity > 0).map(({ line, quantity, amount }) => ({ line, quantity, amount }));
  if (picked.length === 0) return null;
  return { lines: picked, amount: picked.reduce((sum, c) => sum + c.amount, 0) };
}

export function groupPayPlan(state: ShopState, params: GroupPaySheetParams): GroupPayPlan {
  const payer = findOrder(state, params.orderId);
  if (!payer) throw new DomainError('NOT_FOUND', '없는 접수: ' + params.orderId);
  const group: RowPlan[] = [];
  if (amountFor(payer, payer) > 0) group.push(rowOf(payer, payer));
  for (const x of coveredOrders(state, payer)) group.push(rowOf(payer, x));
  const dropped: GroupPayPlan['dropped'] = [];
  for (const id of params.added ?? []) {
    const x = findOrder(state, id);
    if (!x || group.some((r) => r.order.id === id)) continue;
    const row = rowOf(payer, x);
    if (row.amount > 0) group.push(row);
    else dropped.push({ order: x, note: teamLabel(x) + ' · 받을 금액 없음' });
  }
  // 미수 탭: 이 팀이 맨 위, 나머지는 장부처럼 다음 일정 차례(같으면 접수 번호).
  const others = state.orders.filter((o) => o.id !== payer.id && isUnpaid(o))
    .sort((a, b) => (nextDue(state, a)?.at ?? Infinity) - (nextDue(state, b)?.at ?? Infinity) || a.receiptNo.localeCompare(b.receiptNo));
  const unpaid = [...(isUnpaid(payer) ? [payer] : []), ...others].map((x) => group.find((r) => r.order.id === x.id) ?? rowOf(payer, x));

  const all = [...group, ...unpaid.filter((r) => !group.includes(r))];
  const parts = new Map((params.parts ?? []).map((p) => [p.orderId, p.lines] as const));
  for (const row of all) row.part = partOf(row, parts.get(row.order.id));
  const chosen = new Set(params.selected ?? group.map((r) => r.order.id));
  const selected = all.filter((r) => chosen.has(r.order.id) && r.amount > 0);
  const method = params.methodKey === undefined ? payMethodOf(state.registry, DEFAULT_METHOD) : payMethodOf(state.registry, params.methodKey);
  return {
    payer, group, unpaid, selected, dropped,
    methodKey: method?.key ?? DEFAULT_METHOD,
    invalidMethod: method === undefined,
    total: selected.reduce((sum, r) => sum + (r.part?.amount ?? r.amount), 0),
  };
}

/** 한 팀의 배분(줄 · 수량 · 금액). 부분이 아니면 낼 줄 모두의 남은 수 · 남은 돈. */
function allocationOf(row: RowPlan): PaymentAllocationInput & { lines: { lineId: string; quantity: number; amount: number }[] } {
  const x = row.order;
  const paid = linePaid(x);
  const lines = row.part
    ? row.part.lines.map((c) => ({ lineId: c.line.id, quantity: c.quantity, amount: c.amount }))
    : row.lines.map((l) => ({ lineId: l.id, quantity: lineQtyLeft(x, l, paid), amount: lineLeft(x, l, paid) }));
  return { orderId: x.id, amount: lines.reduce((sum, l) => sum + l.amount, 0), lines };
}

/** 결제 자리의 목적: 여러 팀이면 일괄 수납, 한 팀의 품목 일부면 품목별 수납, 그 밖은 카운터 수납. */
function purposeOf(plan: GroupPayPlan): 'multi_order' | 'split_by_items' | undefined {
  if (plan.selected.length > 1) return 'multi_order';
  return plan.selected[0]?.part ? 'split_by_items' : undefined;
}

/** 셈 → 보낼 명령과 창이 본 바탕(받을 금액 합 · 팀마다의 받을 금액). 고른 팀이 없거나 수단이 틀리면 null. */
export function groupPayCommand(plan: GroupPayPlan): { command: ConfirmCommand; expect: Expect } | null {
  if (plan.selected.length === 0 || plan.total <= 0 || plan.invalidMethod) return null;
  const allocations = plan.selected.map(allocationOf);
  const purpose = purposeOf(plan);
  return {
    command: {
      type: 'payment.take',
      payload: {
        orderIds: allocations.map((a) => a.orderId), amount: plan.total, methodKey: plan.methodKey, allocations,
        ...(purpose ? { purposeKey: purpose } : {}), payerOrderId: plan.payer.id,
      },
    },
    expect: { dueAmount: plan.total, dueByOrder: Object.fromEntries(plan.selected.map((r) => [r.order.id, r.amount])) },
  };
}

// ── 읽기 모델(groupPaySheet) ───────────────────────────────────────────

const TAG: Record<RowKind, { text: string; tone: 'grey' | 'blue' }> = {
  self: { text: '결제 팀', tone: 'grey' },
  covered: { text: '결제 예정', tone: 'blue' },
  promised: { text: '결제 예정', tone: 'blue' },
  unpaid: { text: '미수', tone: 'grey' },
};

function rowView(row: RowPlan, selected: boolean): GroupPayRow {
  const x = row.order;
  const paid = linePaid(x);
  const items = itemCounts(row.lines, (l) => lineQtyLeft(x, l, paid));
  const part = row.part;
  const picked = part ? itemCounts(part.lines.map((c) => c.line), (l) => part.lines.find((c) => c.line === l)?.quantity ?? 0) : [];
  return {
    orderId: x.id,
    team: teamLabel(x),
    tag: TAG[row.kind],
    items,
    amount: row.amount,
    selected,
    partLabel: part ? '부분 · ' + won(part.amount) + ' ›' : '부분 결제 ›',
    ...(part ? { partShort: won(part.amount) + ' ›' } : {}),
    partAria: part
      ? [teamLabel(x), '부분 ' + won(part.amount), ...picked.map((i) => i.label + ' ' + i.qty + (i.unit ?? '')), '품목 다시 선택'].join(' · ')
      : teamLabel(x) + ' · 부분 결제 · 품목 선택',
  };
}

export function groupPaySheet(ctx: ViewContext, params: GroupPaySheetParams): GroupPaySheetView {
  const state = ctx.state;
  const plan = groupPayPlan(state, params);
  const tab = params.tabKey === GROUP_PAY_TABS.unpaid ? GROUP_PAY_TABS.unpaid : GROUP_PAY_TABS.group;
  const chosen = new Set(plan.selected.map((r) => r.order.id));
  // 미수 탭에도 고른 팀이 먼저 보인다(그다음 더할 수 있는 미수 팀): 보이는 체크와 주 버튼의 금액이 늘 같게.
  const tabRows = tab === GROUP_PAY_TABS.group ? plan.group : [...plan.selected, ...plan.unpaid.filter((r) => !plan.selected.includes(r))];
  const rows = tabRows.map((r) => rowView(r, chosen.has(r.order.id)));
  const n = plan.selected.length;
  const method = payMethodOf(state.registry, plan.methodKey);
  const nonQuick = method !== undefined && !method.quick;
  const methods: ChoiceOption[] = [
    ...state.registry.payMethods.filter((m) => m.quick).map((m) => ({ key: m.key, label: m.label, selected: plan.methodKey === m.key, enabled: true })),
    { key: CHECKOUT_KEYS.other, label: '기타', selected: nonQuick, enabled: true, ...(nonQuick ? { secondLine: method.label } : {}) },
  ];
  const others: ChoiceOption[] = state.registry.payMethods.filter((m) => !m.quick).map((m) => ({ key: m.key, label: m.label, selected: plan.methodKey === m.key, enabled: true }));
  const send = groupPayCommand(plan);
  const ready = send !== null;
  const label = ready ? PAY_LABEL + ' · ' + n + '팀 · ' + won(plan.total) : PAY_LABEL;
  return {
    basis: { epoch: state.epoch, rev: state.rev },
    serverTime: iso(ctx.now),
    currentBusinessDate: state.businessDate,
    title: '일괄 수납',
    tabs: [
      { key: GROUP_PAY_TABS.group, label: plan.payer.teamName + ' 팀 결제 · ' + plan.group.length + '팀', selected: tab === GROUP_PAY_TABS.group },
      { key: GROUP_PAY_TABS.unpaid, label: '미수 ' + plan.unpaid.length, selected: tab === GROUP_PAY_TABS.unpaid },
    ],
    rows,
    selectedIds: plan.selected.map((r) => r.order.id),
    total: { amount: plan.total, note: n + '팀 · ' + plan.payer.teamName + ' 팀 결제' },
    methods,
    others,
    primary: { label, alts: ready ? [label, PAY_LABEL + ' · ' + won(plan.total), PAY_LABEL] : [], enabled: ready },
    ...(send ?? {}),
    ...(plan.dropped.length ? { dropped: plan.dropped.map((d) => ({ orderId: d.order.id, note: d.note })) } : {}),
  };
}

// ── 부분 결제 판(partialPaySheet) ─────────────────────────────────────────

/**
 * 균등 분할: 결제 팀과 이 팀이 반씩(받을 금액 ÷ 2)에 가장 가깝게, 넘지 않게 품목을 고른다(한 개 값이 큰 줄부터). 사람으로 나누지 않는다.
 */
export function evenSplit(x: FxOrder, lines: readonly FxLine[]): LineUnits[] {
  const paid = linePaid(x);
  const total = lines.reduce((sum, l) => sum + lineLeft(x, l, paid), 0);
  const target = Math.floor(total / 2);
  const unit = (l: FxLine) => lineCharged(x, l) / Math.max(1, l.qty);
  let acc = 0;
  const take = new Map<string, number>();
  for (const l of [...lines].sort((a, b) => unit(b) - unit(a))) {
    const max = lineQtyLeft(x, l, paid);
    let n = Math.min(max, Math.floor((target - acc) / Math.max(1, unit(l))));
    while (n > 0 && acc + lineAmountFor(x, l, n, paid) > target) n -= 1;
    take.set(l.id, n);
    acc += lineAmountFor(x, l, n, paid);
  }
  return lines.map((l) => ({ lineId: l.id, quantity: take.get(l.id) ?? 0 }));
}

export function partialPaySheet(ctx: ViewContext, params: PartialPaySheetParams): PartialPaySheetView {
  const state = ctx.state;
  const x = findOrder(state, params.orderId);
  const payer = findOrder(state, params.payerOrderId);
  if (!x || !payer) throw new DomainError('NOT_FOUND', '없는 접수: ' + (x ? params.payerOrderId : params.orderId));
  const paid = linePaid(x);
  const lines = payableLines(payer, x);
  const chosen = (l: FxLine) => {
    const max = lineQtyLeft(x, l, paid);
    if (!params.lines) return max;
    const want = params.lines.filter((u) => u.lineId === l.id).reduce((sum, u) => sum + Math.max(0, Math.floor(u.quantity) || 0), 0);
    return Math.min(max, want);
  };
  const rows = lines.map((l) => {
    const max = lineQtyLeft(x, l, paid);
    const word = countWordOf(l);
    const unitAmount = lineAmountFor(x, l, 1, paid);
    const value = chosen(l);
    const names = lineNames(state.registry, l);
    return {
      lineId: l.id,
      label: names.name,
      ariaLabel: l.label,
      note: [names.variant, '잔여 ' + max + word, '1' + word + ' ' + won(unitAmount)].filter(Boolean).join(' · '),
      quantity: { value, min: 0, max, unit: word },
      amount: lineAmountFor(x, l, value, paid),
    };
  });
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  const due = lines.reduce((sum, l) => sum + lineLeft(x, l, paid), 0);
  const all = lines.map((l) => ({ lineId: l.id, quantity: lineQtyLeft(x, l, paid) }));
  const even = evenSplit(x, lines);
  return {
    basis: { epoch: state.epoch, rev: state.rev },
    title: '부분 결제 · ' + x.teamName + ' 팀',
    lines: rows,
    total,
    summary: [{ text: '선택 ' }, { text: won(total), strong: true }, { text: ' · 받을 금액 ' + won(due) }],
    presets: [
      { key: 'all', label: '잔여 전체 선택', lines: all, enabled: all.some((u) => u.quantity > 0) },
      { key: 'even', label: '균등 분할', lines: even, enabled: even.some((u) => u.quantity > 0) },
    ],
    primary: total > 0 ? { label: '선택 · ' + won(total), alts: ['선택 · ' + won(total), '선택'], enabled: true } : { label: '선택', alts: [], enabled: false },
  };
}

// ── 명령(payment.take · 결제 팀) ────────────────────────────────────────

/**
 * 품목 일부만 낸 팀의 남은 줄을 그 팀 몫으로 돌린다: 결제 팀이 내기로 한 줄(줄의 결제 팀 · 접수의 결제 팀) 중 받을 돈이 남은 것은 결제 팀을
 * 지우고, 접수의 결제 팀도 지운다(다른 팀이 내기로 한 줄은 그대로). 남은 미수는 반납 때 받는다(work/impl-v2/plan.md §8 D47).
 */
function releaseLeft(x: FxOrder, payerId: string): void {
  const paid = linePaid(x);
  for (const l of x.lines) {
    if (l.payerOrderId === payerId && lineLeft(x, l, paid) > 0) delete l.payerOrderId;
  }
  if (x.payerOrderId === payerId) {
    // 접수의 결제 팀을 지우면 줄의 결제 팀이 없는 줄은 이 팀 몫이 된다. 이미 낸 줄은 그대로 두고, 아직 이 팀이 내기로 한 줄이 없게 한다.
    delete x.payerOrderId;
  }
  x.payWhen = 'return';
}

/**
 * 결제 팀이 있는 수납(일괄 수납 V5, 대납 수납 창): 창이 보낸 배분을 지금 셈(groupPayPlan)으로 다시 계산해 팀마다의 받을 금액(expect.dueByOrder)
 * · 합(expect.dueAmount)이 같을 때만 돈 한 건 + 팀마다의 몫(줄 · 수량 · 금액)을 적는다. 그사이 다른 카운터가 받은 팀은 충돌 한 줄과 그 팀 id.
 */
export function takeGroupPayment(state: ShopState, envelope: CommandEnvelope<'payment.take'>, now: number): Result {
  const p = envelope.payload;
  const payer = findOrder(state, p.payerOrderId);
  if (!payer) return rejected('접수 없음');
  const allocations: PaymentAllocationInput[] = p.allocations?.length ? p.allocations : p.orderIds.map((orderId) => ({ orderId, amount: 0 }));
  const targets = allocations.map((a) => findOrder(state, a.orderId));
  if (targets.some((o) => o === undefined)) return rejected('접수 없음');
  if (!payMethodOf(state.registry, p.methodKey)) return rejected('등록되지 않은 결제 수단');
  if (!(p.amount > 0) || !Number.isInteger(p.amount)) return rejected('받을 금액 없음');
  const ids = allocations.map((a) => a.orderId);
  const plan = groupPayPlan(state, {
    orderId: payer.id,
    selected: ids,
    added: ids,
    parts: allocations.filter((a) => a.lines?.length).map((a) => ({ orderId: a.orderId, lines: a.lines!.map((l) => ({ lineId: l.lineId, quantity: l.quantity })) })),
    methodKey: p.methodKey,
  });
  // 팀마다: 창이 본 받을 금액과 지금(그사이 다른 카운터가 받았으면 0).
  const current = (id: string) => plan.selected.find((r) => r.order.id === id)?.amount ?? 0;
  const seen = envelope.expect?.dueByOrder ?? {};
  const changed = ids.filter((id) => seen[id] !== undefined && seen[id] !== current(id));
  if (changed.length) {
    const paidElsewhere = changed.filter((id) => current(id) === 0);
    const first = paidElsewhere.length === changed.length ? findOrder(state, paidElsewhere[0]) : undefined;
    const message = first ? first.teamName + ' 팀 ' + won(seen[first.id] ?? 0) + ' 수납 완료 · 다른 카운터' : '받을 금액 변경됨 · 재시도 필요';
    return { outcome: 'conflict', error: { code: 'DUE_CHANGED', message, current: { orderIds: changed } } };
  }
  if (plan.total === 0) return nothing('받을 금액 없음');
  if (envelope.expect?.dueAmount !== undefined && envelope.expect.dueAmount !== plan.total) {
    return conflict('DUE_CHANGED', '받을 금액 변경됨 · 재시도 필요');
  }
  if (plan.selected.length !== ids.length) return conflict('DUE_CHANGED', '받을 금액 변경됨 · 재시도 필요');

  // 실제 돈 한 건(결제 자리)과 팀마다의 몫. 현금은 카운터 돈통.
  const drawer = plan.methodKey === 'cash' ? { drawerId: 'counter' } : {};
  const purpose = p.purposeKey ?? purposeOf(plan) ?? 'counter';
  const group: FxPaymentGroup = { id: envelope.requestId, purpose, amount: plan.total, methodKey: plan.methodKey, at: now, ...drawer, payerOrderId: payer.id };
  state.paymentGroups.push(group);
  plan.selected.forEach((row, i) => {
    const share = allocationOf(row);
    // 줄 배분이 없는 몫은 lines를 두지 않는다(빈 목록과 없음은 같은 뜻이다: 접수 전체를 채운다, rules.ts linePaid).
    row.order.payments.push({
      id: envelope.requestId + ':' + i, amount: share.amount, methodKey: plan.methodKey, at: now, groupId: envelope.requestId,
      ...(share.lines.length ? { lines: share.lines } : {}), ...drawer,
    });
  });
  // 이 팀이 내기로 한 팀(covered) 중 품목 일부만 낸 팀: 남은 줄은 그 팀 몫. 더한 팀 · 미수 탭의 팀은 약속이 없어 그대로(결제 시점도 그대로).
  for (const row of plan.selected) if (row.part && row.kind === 'covered') releaseLeft(row.order, payer.id);
  return { outcome: 'applied' };
}

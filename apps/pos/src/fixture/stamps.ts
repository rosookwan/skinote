// FixtureClient의 도장 계산(운영의 deriveStamp를 줄여 흉내 냄, ui 3-2). 줄(품목 줄) 단위로 상태를 정하고,
// 장부의 팀 한 줄에는 칸의 모으는 법(worst_of · first_open)으로 모은다. 남은 일 목록과 다음 할 일도 여기서 만든다.
// 도장은 단계의 키가 아니라 규칙(rule_key: qty_issued · qty_returned · order_due_zero …)으로 계산한다: 설정에 도장 단계나
// 도장 칸을 더하면(같은 규칙을 쓰는 한) 여기를 고치지 않아도 나온다. 모르는 규칙은 '해당 없음'이다.
import type { ChecklistItem, FitPart, ItemCount, NextStep, PressNote, StampCell, StampRuleKey, StampStepRow } from '@skinote/contract';
import { STAMP_RULE_SCOPE } from '@skinote/contract';
import type { FxLine, FxOrder, FxState } from './model.ts';
import {
  backCount, coveredOrders, findOrder, isVehiclePickup, isVehicleReturn, LATE_AFTER_STORE, LATE_AFTER_VEHICLE, moneyLateAt, othersDue, ownDue,
  paidTotal, pendingIssue, pendingReturn, placeLabel, unitCount, vehicleLabel, charged,
} from './rules.ts';
import { dayWord, hm, iso, kstDate } from './time.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';

type Steps = ReadonlyMap<string, StampStepRow>;

/** 그 규칙을 쓰는 단계의 키(막힌 도장의 '먼저 할 단계'). 없으면 규칙 이름을 그대로. */
function stepOfRule(steps: Steps, rule: StampRuleKey): StampStepRow | undefined {
  for (const step of steps.values()) if (step.rule_key === rule) return step;
  return undefined;
}

/** 차량이 할 도장을 카운터에서 눌렀을 때: 누가 · 언제 한다는 한 문장과 '매장에서 …'(손님이 매장에 왔을 때). */
function delegatedNote(step: StampStepRow, vehicle: string, at: number, verb: string): PressNote {
  return {
    lines: [vehicle + '이 ' + hm(at) + '에 ' + verb, '손님이 매장에 오셨으면 매장에서 도장을 찍습니다.'],
    action: { actionKey: step.action_key, label: '매장에서 ' + step.label },
  };
}

/** 도장에 찍는 시각은 그 영업일(today)에 찍은 것만. 전날 선입금 같은 것은 시각 없이 도장만. */
const stampAt = (ms: number | undefined, today: string) => (ms === undefined || kstDate(ms) !== today ? {} : { at: iso(ms) });

function latest(...values: (number | undefined)[]): number | undefined {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? Math.max(...known) : undefined;
}

function countState(stepKey: string, have: number, need: number, at: number | undefined, today: string): StampCell {
  if (have >= need) return { stepKey, state: 'done', ...stampAt(at, today) };
  if (have > 0) return { stepKey, state: 'partial', progress: { done: have, total: need } };
  return { stepKey, state: 'todo' };
}

function blocked(step: StampStepRow, by: StampStepRow | undefined, message: string): StampCell {
  return { stepKey: step.key, state: 'blocked', blockedBy: { stepKey: by?.key ?? step.key, message } };
}

/** 줄 하나의 도장(줄 단위 규칙). null이면 그 단계가 이 줄에 해당 없음(na). */
export function lineStamp(o: FxOrder, l: FxLine, step: StampStepRow, steps: Steps, today: string): StampCell | null {
  switch (step.rule_key) {
    case 'qty_loaded': {
      if (!isVehiclePickup(o)) return null;
      return countState(step.key, Math.max(l.loaded, l.issued), l.qty, l.loadedAt ?? l.issuedAt, today);
    }
    case 'qty_issued': {
      if (isVehiclePickup(o) && l.issued < l.qty) {
        const load = stepOfRule(steps, 'qty_loaded');
        if (Math.max(l.loaded, l.issued) < l.qty) return blocked(step, load, '차량에 먼저 실어야 지급할 수 있습니다');
        // 실은 뒤의 지급(전달)은 기사가 한다: 카운터 칸은 보라 '차량 17:00'(N1 · N6).
        const vehicle = vehicleLabel(o.pickup.vehicleId);
        return { stepKey: step.key, state: 'delegated', at: iso(o.pickup.at), delegatedTo: vehicle, pressNote: delegatedNote(step, vehicle, o.pickup.at, '손님께 전합니다.') };
      }
      return countState(step.key, l.issued, l.qty, l.issuedAt, today);
    }
    case 'qty_returned': {
      if (!l.returnable) return null;
      const back = backCount(l);
      if (back >= l.qty) return { stepKey: step.key, state: 'done', ...stampAt(latest(l.returnedAt, l.collectedAt), today) };
      if (l.issued === 0) return blocked(step, stepOfRule(steps, 'qty_issued'), '지급을 먼저 해야 반납할 수 있습니다');
      if (isVehicleReturn(o)) {
        const vehicle = vehicleLabel(o.giveBack.vehicleId);
        return { stepKey: step.key, state: 'delegated', at: iso(o.giveBack.at), delegatedTo: vehicle, pressNote: delegatedNote(step, vehicle, o.giveBack.at, '받습니다.') };
      }
      return countState(step.key, back, l.qty, latest(l.returnedAt, l.collectedAt), today);
    }
    case 'qty_collected': {
      // 차량 수거(받음): 내준 것 중 돌아온 수(차량이 받았거나 손님이 매장에 가져옴).
      if (!l.returnable || !isVehicleReturn(o)) return null;
      if (l.issued === 0) return blocked(step, stepOfRule(steps, 'qty_issued'), '지급을 먼저 해야 받을 수 있습니다');
      return countState(step.key, backCount(l), l.issued, l.collectedAt, today);
    }
    case 'task_received': {
      // 매장 입고: 차량이 받은 것 중 매장에 내려놓은 수.
      if (!l.returnable || !isVehicleReturn(o) || l.collected === 0) return null;
      return countState(step.key, l.received ?? 0, l.collected, l.receivedAt, today);
    }
    case 'ticket_secured': {
      // 체험 자료에는 발권 기록이 따로 없다: 권(리프트권) 줄은 건네면 발권된 것으로 본다.
      if (l.section !== 'lift') return null;
      return countState(step.key, l.issued, l.qty, l.issuedAt, today);
    }
    default:
      return null;
  }
}

/** 수납 도장(접수 단위, order_due_zero). 다른 팀이 낼 몫만 남으면 '예정', 이 팀이 대신 낼 몫이 남으면 끝이 아니다. */
export function payStamp(state: FxState, o: FxOrder, stepKey = 'pay'): StampCell {
  const due = ownDue(o);
  const others = othersDue(state, o);
  if (charged(o) === 0 && others === 0) return { stepKey, state: 'na' };
  if (due === 0 && others === 0) {
    const last = o.payments.reduce<number | undefined>((max, p) => (max === undefined || p.at > max ? p.at : max), undefined);
    return { stepKey, state: 'done', ...stampAt(last, state.businessDate) };
  }
  const payer = findOrder(state, o.payerOrderId);
  if (due > 0 && payer && others === 0) return { stepKey, state: 'scheduled', scheduledNote: payer.teamName + ' 팀 결제 예정' };
  // 돈은 개수로 세지 않는다: 일부만 받았으면 '일부'.
  if (paidTotal(o) > 0) return { stepKey, state: 'partial' };
  return { stepKey, state: 'todo' };
}

/** 줄 단위 규칙마다 한 줄에서 채워야 할 수(받음은 내준 수, 입고는 받은 수, 나머지는 줄 수량). */
const NEED: Partial<Record<StampRuleKey, (l: FxLine) => number>> = {
  qty_collected: (l) => l.issued,
  task_received: (l) => l.collected,
};

/**
 * 팀 한 줄로 모으기(worst_of): 해당 없음은 빼고, 카운터가 할 일(할 일 · 일부)이 남았으면 그것,
 * 없으면 차량이 할 일 → 예정 → 먼저 할 일 → 끝 순. 끝과 할 일이 섞이면 '일부'(개수로).
 */
export function rollupStep(o: FxOrder, step: StampStepRow, steps: Steps, today: string): StampCell {
  const cells = o.lines.map((l) => ({ line: l, cell: lineStamp(o, l, step, steps, today) })).filter((x): x is { line: FxLine; cell: StampCell } => x.cell !== null);
  if (cells.length === 0) return { stepKey: step.key, state: 'na' };
  if (cells.every((x) => x.cell.state === 'done')) {
    return { stepKey: step.key, state: 'done', ...stampAt(latest(...cells.map((x) => (x.cell.at ? Date.parse(x.cell.at) : undefined))), today) };
  }
  const open = cells.filter((x) => x.cell.state === 'todo' || x.cell.state === 'partial');
  if (open.length > 0) {
    const need = (x: { line: FxLine; cell: StampCell }) => x.cell.progress?.total ?? NEED[step.rule_key]?.(x.line) ?? x.line.qty;
    const have = (x: { line: FxLine; cell: StampCell }) => (x.cell.state === 'done' ? need(x) : x.cell.progress?.done ?? 0);
    const done = cells.reduce((sum, x) => sum + have(x), 0);
    const total = cells.reduce((sum, x) => sum + need(x), 0);
    return done > 0 ? { stepKey: step.key, state: 'partial', progress: { done, total } } : { stepKey: step.key, state: 'todo' };
  }
  for (const state of ['delegated', 'scheduled', 'blocked'] as const) {
    const hit = cells.find((x) => x.cell.state === state);
    if (hit) return hit.cell;
  }
  return cells[0]!.cell;
}

/** 단계 하나의 접수 단위 도장: 줄 단위 규칙은 줄들을 모으고, 접수 단위 규칙(order_due_zero)은 접수에서. */
export function stepStamp(state: FxState, o: FxOrder, step: StampStepRow, steps: Steps): StampCell {
  // 접수 단위 규칙은 지금 order_due_zero 하나다(다른 접수 단위 규칙이 생기면 여기에 더한다).
  if (step.rule_key === 'order_due_zero') return payStamp(state, o, step.key);
  return rollupStep(o, step, steps, state.businessDate);
}

/** 칸 하나의 도장(칸 설정의 단계 사슬): 하나면 그 단계, 여럿이면 아직 끝나지 않은 첫 단계(first_open, 적재 → 지급). */
export function columnStamp(state: FxState, o: FxOrder, stepKeys: readonly string[], steps: Steps): StampCell {
  let last: StampCell = { stepKey: stepKeys.at(-1) ?? '', state: 'na' };
  for (const key of stepKeys) {
    const step = steps.get(key);
    if (!step) continue;
    const cell = stepStamp(state, o, step, steps);
    if (cell.state === 'na') continue;
    if (cell.state !== 'done') return cell;
    last = cell;
  }
  return last;
}

// ── 남은 일 목록(B2)과 다음 할 일 ─────────────────────────────────────────

const CHANNEL_LABEL = { phone: '전화 예약', walk_in: '현장 방문' } as const;

/** 줄 단위 규칙마다 '남은 수'(이 단계에서 아직 할 수): 품목 요약과 주 버튼의 수. */
const LEFT: Partial<Record<StampRuleKey, (l: FxLine) => number>> = {
  qty_loaded: (l) => l.qty - Math.max(l.loaded, l.issued),
  qty_issued: (l) => l.qty - l.issued,
  qty_returned: (l) => (l.returnable ? l.qty - backCount(l) : 0),
  qty_collected: (l) => (l.returnable ? Math.max(0, l.issued - backCount(l)) : 0),
  ticket_secured: (l) => (l.section === 'lift' ? l.qty - l.issued : 0),
};

const itemsOf = (lines: readonly FxLine[], qtyOf: (l: FxLine) => number): ItemCount[] =>
  lines.filter((l) => qtyOf(l) > 0).map((l) => ({ label: l.shortLabel, qty: qtyOf(l), ...(l.unit ? { unit: l.unit } : {}) }));

/** 주 버튼 · 확인 창의 수: 개로 세는 장비 수 + 다른 단위('매')별 수. */
export function figureOf(lines: readonly FxLine[], qtyOf: (l: FxLine) => number): ChecklistItem['figure'] {
  const byUnit = new Map<string, number>();
  for (const l of lines) if (l.unit && qtyOf(l) > 0) byUnit.set(l.unit, (byUnit.get(l.unit) ?? 0) + qtyOf(l));
  return { count: unitCount(lines, qtyOf), ...(byUnit.size ? { units: [...byUnit.entries()].map(([unit, qty]) => ({ unit, qty })) } : {}) };
}

/** 반납의 늦음 기준: 약속 뒤 매장 30분 · 차량 60분(아직 돌아올 것이 있을 때만). */
export function returnLateAt(o: FxOrder): number | undefined {
  if (!pendingReturn(o) || !o.lines.some((l) => l.issued > 0)) return undefined;
  return o.giveBack.at + (isVehicleReturn(o) ? LATE_AFTER_VEHICLE : LATE_AFTER_STORE);
}

/** 차량 배달의 늦음 기준(싣기 전에는 약속 시각, 실은 뒤에는 + 60분). 매장 수령은 늦음이 없다. */
export function deliverLateAt(o: FxOrder): number | undefined {
  if (!isVehiclePickup(o) || !pendingIssue(o)) return undefined;
  const loaded = o.lines.every((l) => Math.max(l.loaded, l.issued) >= l.qty);
  return loaded ? o.pickup.at + LATE_AFTER_VEHICLE : o.pickup.at;
}

/**
 * 남은 일 목록: 접수 한 줄(끝) + 접수증 화면 설정의 도장 칸들의 단계와 접수 단위 단계(수납)를 급한 순서(urgency_out → urgency_back)로.
 * 돈을 돌려줄 때 받기로 한 팀은 수납이 반납 뒤로 간다. 카운터가 할 수 있는 첫 일이 '지금'이고, 차량이 할 일 · 다른 팀이 낼 돈은
 * 지금이 될 수 없다. 품목이 있는 일은 둘째 줄에 품목(items), 늦음의 기준 시각(lateAt)을 함께 준다.
 */
export function checklist(state: FxState, o: FxOrder, steps: Steps, slipStepKeys: readonly string[], today: string): { items: ChecklistItem[]; next: NextStep | null } {
  type Draft = Omit<ChecklistItem, 'state'> & { status: StampCell['state']; order: number };
  const drafts: Draft[] = [];
  const prepaid = o.payments.filter((p) => p.section === 'lift' && p.at < o.pickup.at).reduce((sum, p) => sum + p.amount, 0);
  drafts.push({
    stepKey: 'order', actionKey: 'next_step', status: 'done', order: 0,
    parts: [{ text: '접수', drop: 0 }, { text: CHANNEL_LABEL[o.channel], drop: 1 }, ...(prepaid > 0 ? [{ text: '리프트권 ' + won(prepaid) + ' 받음', drop: 2 }] : [])],
  });
  const orderScope = [...steps.values()].filter((s) => STAMP_RULE_SCOPE[s.rule_key] === 'order').map((s) => s.key);
  const keys = [...new Set([...slipStepKeys, ...orderScope])];
  for (const key of keys) {
    const step = steps.get(key);
    if (!step) continue;
    const cell = stepStamp(state, o, step, steps);
    if (cell.state === 'na') continue;
    const back = step.urgency_back > 0;
    let order = back ? 500 + step.urgency_back : step.urgency_out;
    const parts: FitPart[] = [{ text: step.checklist_label, drop: 0 }];
    let items: ItemCount[] | undefined;
    let figure: ChecklistItem['figure'];
    let lateAt: number | undefined;
    const left = LEFT[step.rule_key];
    if (left) {
      // 끝난 일은 그 단계가 걸린 줄 모두, 남은 일은 남은 수만.
      const applies = (l: FxLine) => lineStamp(o, l, step, steps, today) !== null;
      items = cell.state === 'done' ? itemsOf(o.lines.filter(applies), (l) => l.qty) : itemsOf(o.lines, left);
      figure = figureOf(o.lines, left);
    }
    switch (step.rule_key) {
      case 'qty_loaded':
        parts.push({ text: vehicleLabel(o.pickup.vehicleId), drop: 9 });
        lateAt = deliverLateAt(o);
        break;
      case 'qty_issued':
        if (cell.state === 'delegated') parts.push({ text: '차량이 전함', drop: 7 }, { text: hm(o.pickup.at) + ' ' + placeLabel(o.pickup.placeId), drop: 8 });
        lateAt = deliverLateAt(o);
        break;
      case 'qty_returned': {
        const giveBack = o.giveBack;
        parts.push(
          { text: dayWord(giveBack.at, today) + ' ' + hm(giveBack.at), drop: 1 },
          { text: giveBack.mode === 'store' ? '매장' : placeLabel(giveBack.placeId), drop: 2 },
          ...(giveBack.mode === 'vehicle' ? [{ text: '차량이 받음', drop: 3 }] : []),
          ...(giveBack.note ? [{ text: giveBack.note, drop: 4 }] : []),
        );
        // 반납은 품목을 둘째 줄에 적지 않는다(반납 약속이 한 줄을 채운다).
        items = undefined;
        lateAt = returnLateAt(o);
        break;
      }
      case 'order_due_zero': {
        const due = ownDue(o);
        const others = othersDue(state, o);
        const payer = findOrder(state, o.payerOrderId);
        if (cell.state === 'done') parts.push({ text: won(paidTotal(o)), drop: 1 });
        else if (cell.state === 'scheduled' && payer) parts.push({ text: payer.teamName + ' 팀 결제 예정', drop: 1 }, { text: won(due), drop: 2 });
        else parts.push({ text: won(due + others), drop: 1 }, ...coveredOrders(state, o).map((other, i) => ({ text: other.teamName + ' 팀 몫 포함', drop: 2 + i })));
        figure = { amount: due + others };
        // 돌려줄 때 받기로 한 돈은 반납 뒤에(결제 시점).
        if (o.payWhen === 'return') order = 1000 + step.urgency_out;
        lateAt = moneyLateAt(state, o);
        break;
      }
      default:
        break;
    }
    drafts.push({
      stepKey: step.key, actionKey: step.action_key, status: cell.state, parts, order,
      ...(figure ? { figure } : {}), ...(items?.length ? { items } : {}), ...(lateAt !== undefined && cell.state !== 'done' ? { lateAt: iso(lateAt) } : {}),
    });
  }

  drafts.sort((a, b) => a.order - b.order);
  let next: NextStep | null = null;
  const out = drafts.map(({ status, order: _order, ...item }): ChecklistItem => {
    const finished = status === 'done';
    const counterCan = status === 'todo' || status === 'partial';
    if (!finished && counterCan && next === null) {
      next = { stepKey: item.stepKey, actionKey: item.actionKey, ...(item.figure ? { figure: item.figure } : {}) };
      return { ...item, state: 'now' };
    }
    return { ...item, state: finished ? 'done' : 'later' };
  });
  return { items: out, next };
}

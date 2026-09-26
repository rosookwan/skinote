// 도장 계산(deriveStamp, ui 3-2). 줄(품목 줄) 단위로 상태를 정하고,
// 장부의 팀 한 줄에는 칸의 모으는 법(worst_of · first_open)으로 모은다. 남은 일 목록과 다음 할 일도 여기서 만든다.
// 도장은 단계의 키가 아니라 규칙(rule_key: qty_issued · qty_returned · order_due_zero …)으로 계산한다: 설정에 도장 단계나
// 도장 칸을 더하면(같은 규칙을 쓰는 한) 여기를 고치지 않아도 나온다. 모르는 규칙은 '해당 없음'이다.
import type { ChecklistItem, FitPart, ItemCount, NextStep, PressNote, StampCell, StampRuleKey, StampStepRow } from '@skinote/contract';
import { STAMP_RULE_SCOPE } from '@skinote/contract';
import type { FxLine, FxOrder, ShopRegistry, ShopState } from './model.ts';
import { backHeldRefund, depositDueForIssued } from './deposits.ts';
import { bucketLeft, currentReturn, lineBuckets, openReturns } from './promises.ts';
import {
  backCount, bizDay, coveredOrders, findOrder, isVehiclePickup, isVehicleReturn, lateAtOf, moneyLateAt, othersDue, ownDue,
  paidTotal, pendingIssue, pendingReturn, placeLabel, unitCount, vehicleLabel, charged,
} from './rules.ts';
import { bizHm, businessDateOf, dayWord, hm, iso, onBizDay, when, type BizDay } from './time.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';

type Steps = ReadonlyMap<string, StampStepRow>;

/** 그 규칙을 쓰는 단계의 키(막힌 도장의 '먼저 할 단계'). 없으면 규칙 이름을 그대로. */
function stepOfRule(steps: Steps, rule: StampRuleKey): StampStepRow | undefined {
  for (const step of steps.values()) if (step.rule_key === rule) return step;
  return undefined;
}

/**
 * 차량이 할 도장을 카운터에서 눌렀을 때: 누가 · 언제 한다는 한 줄('1호 차량 수거 예정 · 22:00')과 '매장 반납 처리'(손님이 매장에
 * 왔을 때). 이름 뒤에 조사를 붙이지 않는다(작업 이름 work는 '배달' · '수거').
 */
function delegatedNote(step: StampStepRow, vehicle: string, at: number, work: string): PressNote {
  return {
    lines: [vehicle + ' ' + work + ' 예정 · ' + hm(at)],
    action: { actionKey: step.action_key, label: '매장 ' + step.label + ' 처리' },
  };
}

/**
 * 도장에 찍는 시각은 그 영업일(today)에 찍은 것만. 전날 선입금 같은 것은 시각 없이 도장만. 영업일로 가르므로 기준 시각(06:00) 전의
 * 새벽 반납(27일 00:15)은 26일 장부의 도장에 시각이 찍힌다.
 */
const stampAt = (ms: number | undefined, today: BizDay) => (ms === undefined || !onBizDay(ms, today) ? {} : { at: iso(ms) });

function latest(...values: (number | undefined)[]): number | undefined {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? Math.max(...known) : undefined;
}

function countState(stepKey: string, have: number, need: number, at: number | undefined, today: BizDay): StampCell {
  if (have >= need) return { stepKey, state: 'done', ...stampAt(at, today) };
  if (have > 0) return { stepKey, state: 'partial', progress: { done: have, total: need } };
  return { stepKey, state: 'todo' };
}

/**
 * 막힌 도장: 누른 단계와 기다리는 단계를 한 줄에('반납 불가 · 지급 대기', '지급 불가 · 적재 대기'). 창은 기다리는 단계의 것이
 * 열리므로(지급 처리), 첫 줄이 왜 그 창인지 말한다. 이름은 도장 단계 설정에서 온다.
 */
function blocked(step: StampStepRow, by: StampStepRow | undefined): StampCell {
  return { stepKey: step.key, state: 'blocked', blockedBy: { stepKey: by?.key ?? step.key, message: blockedMessage(step, by) } };
}

export const blockedMessage = (step: Pick<StampStepRow, 'label'>, by: Pick<StampStepRow, 'label'> | undefined) =>
  step.label + ' 불가 · ' + (by ? by.label + ' 대기' : '이전 단계 대기');

/** 차량 이름을 읽는 매장 목록(도장의 `1호 차량 수거 예정`). */
type Reg = Pick<ShopRegistry, 'vehicles'>;

/** 줄 하나의 도장을 만드는 함수(카운터 lineStamp · 기사 기기 driverLineStamp). */
export type LineStampFn = (reg: Reg, o: FxOrder, l: FxLine, step: StampStepRow, steps: Steps, today: BizDay) => StampCell | null;

/** 줄 하나의 도장(줄 단위 규칙). null이면 그 단계가 이 줄에 해당 없음(na). */
export function lineStamp(reg: Reg, o: FxOrder, l: FxLine, step: StampStepRow, steps: Steps, today: BizDay): StampCell | null {
  switch (step.rule_key) {
    case 'qty_loaded': {
      if (!isVehiclePickup(o)) return null;
      return countState(step.key, Math.max(l.loaded, l.issued), l.qty, l.loadedAt ?? l.issuedAt, today);
    }
    case 'qty_issued': {
      if (isVehiclePickup(o) && l.issued < l.qty) {
        const load = stepOfRule(steps, 'qty_loaded');
        if (Math.max(l.loaded, l.issued) < l.qty) return blocked(step, load);
        // 실은 뒤의 지급(전달)은 기사가 한다: 카운터 칸은 보라 '차량 17:00'(N1 · N6).
        const vehicle = vehicleLabel(reg, o.pickup.vehicleId);
        return { stepKey: step.key, state: 'delegated', at: iso(o.pickup.at), delegatedTo: vehicle, pressNote: delegatedNote(step, vehicle, o.pickup.at, '배달') };
      }
      return countState(step.key, l.issued, l.qty, l.issuedAt, today);
    }
    case 'qty_returned': {
      if (!l.returnable) return null;
      const back = backCount(l);
      if (back >= l.qty) return { stepKey: step.key, state: 'done', ...stampAt(latest(l.returnedAt, l.collectedAt), today) };
      if (l.issued === 0) return blocked(step, stepOfRule(steps, 'qty_issued'));
      // 남은 몫이 모두 차량 일정이면 차량 담당(가장 이른 일정). 일정 변경으로 일부를 매장 직접으로 옮겼으면 카운터가 받는다.
      const open = lineBuckets(o, l).filter((b) => b.planned > 0 && bucketLeft(b) > 0).sort((a, b) => a.promise.at - b.promise.at);
      const van = open[0];
      if (van && open.every((b) => b.promise.mode === 'vehicle')) {
        const vehicle = vehicleLabel(reg, van.promise.vehicleId);
        // 일부가 이미 돌아왔으면(부분 반납) 돌아온 수를 함께(`2/3`): 나중에 접수증을 보는 사람이 하나도 안 돌아온 줄로 읽지 않게.
        return {
          stepKey: step.key, state: 'delegated', at: iso(van.promise.at), delegatedTo: vehicle, pressNote: delegatedNote(step, vehicle, van.promise.at, '수거'),
          ...(back > 0 ? { progress: { done: back, total: l.qty } } : {}),
        };
      }
      return countState(step.key, back, l.qty, latest(l.returnedAt, l.collectedAt), today);
    }
    case 'qty_collected': {
      // 차량 수거(받음): 내준 것 중 돌아온 수(차량이 받았거나 손님이 매장에 가져옴).
      if (!l.returnable || !isVehicleReturn(o)) return null;
      if (l.issued === 0) return blocked(step, stepOfRule(steps, 'qty_issued'));
      return countState(step.key, backCount(l), l.issued, l.collectedAt, today);
    }
    case 'task_received': {
      // 매장 입고: 차량이 받은 것 중 매장에 내려놓은 수.
      if (!l.returnable || !isVehicleReturn(o) || l.collected === 0) return null;
      return countState(step.key, l.received ?? 0, l.collected, l.receivedAt, today);
    }
    case 'ticket_secured': {
      // 발권 기록은 아직 따로 없다: 권(리프트권) 줄은 건네면 발권된 것으로 본다.
      if (l.section !== 'lift') return null;
      return countState(step.key, l.issued, l.qty, l.issuedAt, today);
    }
    default:
      return null;
  }
}

/**
 * 수납 도장(접수 단위, order_due_zero). 다른 팀이 낼 몫만 남으면 '예정', 이 팀이 대신 낼 몫이 남으면 끝이 아니다.
 * 예정 도장을 누르면 창 대신 한 줄('이정호 팀 결제 예정')과 '직접 수납 · 60,000원'(이 팀이 지금 직접 낼 때).
 */
export function payStamp(state: ShopState, o: FxOrder, step: Pick<StampStepRow, 'key' | 'action_key'> = { key: 'pay', action_key: 'stamp.pay' }): StampCell {
  const stepKey = step.key;
  const due = ownDue(o);
  const others = othersDue(state, o);
  if (charged(o) === 0 && others === 0) return { stepKey, state: 'na' };
  if (due === 0 && others === 0) {
    const last = o.payments.reduce<number | undefined>((max, p) => (max === undefined || p.at > max ? p.at : max), undefined);
    return { stepKey, state: 'done', ...stampAt(last, bizDay(state)) };
  }
  const payer = findOrder(state, o.payerOrderId);
  if (due > 0 && payer && others === 0) {
    const note = payer.teamName + ' 팀 결제 예정';
    return { stepKey, state: 'scheduled', scheduledNote: note, pressNote: { lines: [note], action: { actionKey: step.action_key, label: '직접 수납 · ' + won(due) } } };
  }
  // 돈은 개수로 세지 않는다: 일부만 받았으면 '부분'.
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
export function rollupStep(reg: Reg, o: FxOrder, step: StampStepRow, steps: Steps, today: BizDay, lineFn: LineStampFn = lineStamp): StampCell {
  const cells = o.lines.map((l) => ({ line: l, cell: lineFn(reg, o, l, step, steps, today) })).filter((x): x is { line: FxLine; cell: StampCell } => x.cell !== null);
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
export function stepStamp(state: ShopState, o: FxOrder, step: StampStepRow, steps: Steps): StampCell {
  // 접수 단위 규칙은 지금 order_due_zero 하나다(다른 접수 단위 규칙이 생기면 여기에 더한다).
  if (step.rule_key === 'order_due_zero') return payStamp(state, o, step);
  return rollupStep(state.registry, o, step, steps, bizDay(state));
}

/** 칸 하나의 도장(칸 설정의 단계 사슬): 하나면 그 단계, 여럿이면 아직 끝나지 않은 첫 단계(first_open, 적재 → 지급). */
export function columnStamp(state: ShopState, o: FxOrder, stepKeys: readonly string[], steps: Steps): StampCell {
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

// ── 기사 기기의 차량 배달(배달 목록 · 업무 판 V7) ─────────────────────────────────

/**
 * 기사 기기가 부르는 차량 배달 단계의 이름(문구 표 결정 4): 매장의 `지급`과 같은 단계(qty_issued)지만 기사 화면에서는 `배달`이다
 * (sys_movement_kinds deliver `지급·배달`). 도장 칸이 이 이름을 가진다(StampCell.label).
 */
export const DELIVER_WORD = '배달';

/**
 * 기사 기기의 줄 도장: 차량 배달 접수의 지급 단계는 기사가 할 일이다(카운터에서는 보라 '차량 17:00'). 실은 수가 있으면 미처리 · 부분,
 * 모두 건넸으면 `배달` 완료(시각), 아직 싣지 않았으면 대기(`배달 불가 · 적재 대기`). 나머지 단계 · 매장 수령 접수는 카운터와 같다.
 */
export function driverLineStamp(reg: Reg, o: FxOrder, l: FxLine, step: StampStepRow, steps: Steps, today: BizDay): StampCell | null {
  if (step.rule_key !== 'qty_issued' || !isVehiclePickup(o)) return lineStamp(reg, o, l, step, steps, today);
  const label = DELIVER_WORD;
  if (l.issued >= l.qty) return { stepKey: step.key, state: 'done', label, ...stampAt(l.issuedAt, today) };
  const onVanQty = Math.max(l.loaded, l.issued) - l.issued;
  if (onVanQty <= 0) {
    const load = stepOfRule(steps, 'qty_loaded');
    return { stepKey: step.key, state: 'blocked', label, blockedBy: { stepKey: load?.key ?? step.key, message: blockedMessage({ label }, load) } };
  }
  return l.issued > 0 ? { stepKey: step.key, state: 'partial', label, progress: { done: l.issued, total: l.qty } } : { stepKey: step.key, state: 'todo', label };
}

/** 기사 기기의 칸 도장(단계 사슬 first_open, 적재 → 배달): 줄은 driverLineStamp로 모으고, 배달 단계는 모인 도장도 `배달`이다. */
export function driverColumnStamp(reg: Reg, o: FxOrder, stepKeys: readonly string[], steps: Steps, today: BizDay): StampCell {
  let last: StampCell = { stepKey: stepKeys.at(-1) ?? '', state: 'na' };
  for (const key of stepKeys) {
    const step = steps.get(key);
    if (!step) continue;
    let cell = rollupStep(reg, o, step, steps, today, driverLineStamp);
    if (step.rule_key === 'qty_issued' && isVehiclePickup(o) && cell.state !== 'na') cell = { ...cell, label: DELIVER_WORD };
    if (cell.state === 'na') continue;
    if (cell.state !== 'done') return cell;
    last = cell;
  }
  return last;
}

// ── 남은 일 목록(B2)과 다음 할 일 ─────────────────────────────────────────

const CHANNEL_LABEL = { phone: '전화 예약', walk_in: '현장 접수' } as const;

/** 줄 단위 규칙마다 '남은 수'(이 단계에서 아직 할 수): 품목 요약과 주 버튼의 수. */
const LEFT: Partial<Record<StampRuleKey, (l: FxLine) => number>> = {
  qty_loaded: (l) => l.qty - Math.max(l.loaded, l.issued),
  qty_issued: (l) => l.qty - l.issued,
  qty_returned: (l) => (l.returnable ? l.qty - backCount(l) : 0),
  qty_collected: (l) => (l.returnable ? Math.max(0, l.issued - backCount(l)) : 0),
  ticket_secured: (l) => (l.section === 'lift' ? l.qty - l.issued : 0),
};

/**
 * 품목 요약(장부 품목 칸 · 처리 현황 둘째 줄): 같은 품목(짧은 이름 · 단위)은 한 칸으로 더한다. 새 접수는 규격마다 줄이 따로라
 * (의류 사이즈 95 × 2 · 사이즈 100 × 1) 요약은 `의류 3`이다. 차례는 처음 나온 차례.
 */
export function itemCounts(lines: readonly FxLine[], qtyOf: (l: FxLine) => number): ItemCount[] {
  const out: ItemCount[] = [];
  for (const l of lines) {
    const qty = qtyOf(l);
    if (qty <= 0) continue;
    const same = out.find((x) => x.label === l.shortLabel && (x.unit ?? '') === (l.unit ?? ''));
    if (same) same.qty += qty;
    else out.push({ label: l.shortLabel, qty, ...(l.unit ? { unit: l.unit } : {}) });
  }
  return out;
}

const itemsOf = itemCounts;

/** 주 버튼 · 확인 창의 수: 개로 세는 장비 수 + 다른 단위('매')별 수. */
export function figureOf(lines: readonly FxLine[], qtyOf: (l: FxLine) => number): ChecklistItem['figure'] {
  const byUnit = new Map<string, number>();
  for (const l of lines) if (l.unit && qtyOf(l) > 0) byUnit.set(l.unit, (byUnit.get(l.unit) ?? 0) + qtyOf(l));
  return { count: unitCount(lines, qtyOf), ...(byUnit.size ? { units: [...byUnit.entries()].map(([unit, qty]) => ({ unit, qty })) } : {}) };
}

/** 반납의 늦음 기준: 아직 남은 가장 이른 일정 뒤 매장 30분 · 차량은 매장 설정의 여유(lateAtOf, 아직 돌아올 것이 있을 때만). */
export function returnLateAt(state: ShopState, o: FxOrder): number | undefined {
  if (!pendingReturn(o) || !o.lines.some((l) => l.issued > 0)) return undefined;
  return lateAtOf(state.settings, currentReturn(o));
}

/** 차량 배달의 늦음 기준(싣기 전에는 약속 시각, 실은 뒤에는 + 차량 여유). 매장 수령은 늦음이 없다. */
export function deliverLateAt(state: ShopState, o: FxOrder): number | undefined {
  if (!isVehiclePickup(o) || !pendingIssue(o)) return undefined;
  const loaded = o.lines.every((l) => Math.max(l.loaded, l.issued) >= l.qty);
  return loaded ? lateAtOf(state.settings, o.pickup) : o.pickup.at;
}

/**
 * 남은 일 목록: 접수 한 줄(끝) + 접수증 화면 설정의 도장 칸들의 단계와 접수 단위 단계(수납)를 급한 순서(urgency_out → urgency_back)로.
 * 돈을 돌려줄 때 받기로 한 팀은 수납이 반납 뒤로 간다. 카운터가 할 수 있는 첫 일이 '지금'이고, 차량이 할 일 · 다른 팀이 낼 돈은
 * 지금이 될 수 없다. 품목이 있는 일은 둘째 줄에 품목(items), 늦음의 기준 시각(lateAt)을 함께 준다.
 */
export function checklist(state: ShopState, o: FxOrder, steps: Steps, slipStepKeys: readonly string[], today: BizDay): { items: ChecklistItem[]; next: NextStep | null } {
  // later: 지금 할 일(주 버튼)이 되지 않는 줄. 다음 영업일 뒤의 매장 반납은 손님이 일찍 왔을 때 사람이 줄을 눌러 하는 조기 반납이지
  // 주 버튼이 아니다(그사이 받을 돈이 있으면 수납이 지금 할 일).
  type Draft = Omit<ChecklistItem, 'state'> & { status: StampCell['state']; order: number; later?: boolean };
  const drafts: Draft[] = [];
  const prepaid = o.payments.filter((p) => p.section === 'lift' && p.at < o.pickup.at).reduce((sum, p) => sum + p.amount, 0);
  drafts.push({
    stepKey: 'order', actionKey: 'next_step', status: 'done', order: 0,
    parts: [{ text: '접수', drop: 0 }, { text: CHANNEL_LABEL[o.channel], drop: 1 }, ...(prepaid > 0 ? [{ text: '리프트권 ' + won(prepaid) + ' 수납', drop: 2 }] : [])],
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
    let second: FitPart[] | undefined;
    let items: ItemCount[] | undefined;
    let figure: ChecklistItem['figure'];
    let lateAt: number | undefined;
    let laterDay = false;
    const left = LEFT[step.rule_key];
    if (left) {
      // 끝난 일은 그 단계가 걸린 줄 모두, 남은 일은 남은 수만.
      const applies = (l: FxLine) => lineStamp(state.registry, o, l, step, steps, today) !== null;
      items = cell.state === 'done' ? itemsOf(o.lines.filter(applies), (l) => l.qty) : itemsOf(o.lines, left);
      figure = figureOf(o.lines, left);
    }
    switch (step.rule_key) {
      case 'qty_loaded':
        parts.push({ text: vehicleLabel(state.registry, o.pickup.vehicleId), drop: 9 });
        lateAt = deliverLateAt(state, o);
        break;
      case 'qty_issued':
        if (cell.state === 'delegated') parts.push({ text: '차량 배달', drop: 7 }, { text: hm(o.pickup.at) + ' ' + placeLabel(state.registry, o.pickup.placeId), drop: 8 });
        lateAt = deliverLateAt(state, o);
        break;
      case 'qty_returned': {
        // 윗줄 '반납 · 오늘 22:00', 둘째 줄은 장소 · 방법('설천 주차장 · 차량 수거'). 일정 변경으로 일정이 둘 이상이면 둘째 줄이
        // 장소들('설천 주차장 · 솔마을 두솔동', 시각이 다른 일정은 시각을 붙임). 반납은 품목을 적지 않는다.
        const opens = openReturns(o).map((g) => g.promise);
        const list = opens.length ? opens : [o.giveBack];
        const first = list[0]!;
        const where = (p: typeof first) => (p.mode === 'store' ? '매장' : placeLabel(state.registry, p.placeId));
        parts.push({ text: dayWord(first.at, today.date, today.cutoff) + ' ' + bizHm(first.at, today.cutoff), drop: 1 });
        second = list.length === 1
          ? [
            { text: where(first), drop: 0 },
            ...(first.mode === 'vehicle' ? [{ text: '차량 수거', drop: 1 }] : []),
            ...(first.note ? [{ text: first.note, drop: 2 }] : []),
          ]
          : list.map((p, i) => ({ text: (p.at === first.at ? '' : when(p.at, today.date, today.cutoff) + ' ') + where(p), drop: i === 0 ? 0 : i }));
        items = undefined;
        lateAt = returnLateAt(state, o);
        laterDay = businessDateOf(first.at, today.cutoff) > today.date;
        break;
      }
      case 'order_due_zero': {
        const due = ownDue(o);
        const others = othersDue(state, o);
        const payer = findOrder(state, o.payerOrderId);
        if (cell.state === 'done') parts.push({ text: won(paidTotal(o)), drop: 1 });
        else if (cell.state === 'scheduled' && payer) parts.push({ text: payer.teamName + ' 팀 결제 예정', drop: 1 }, { text: won(due), drop: 2 });
        else parts.push({ text: won(due + others), drop: 1 }, ...coveredOrders(state, o).map((other, i) => ({ text: other.teamName + ' 팀분 대납', drop: 2 + i })));
        figure = { amount: due + others };
        // 돌려줄 때 받기로 한 돈은 반납 뒤에(결제 시점).
        if (o.payWhen === 'return') order = 1000 + step.urgency_out;
        lateAt = moneyLateAt(state, o);
        break;
      }
      default:
        break;
    }
    // 줄을 누르면 그 단계를 접수 전체로 연다(장부의 팀 한 줄 도장과 같은 모음: 차량 담당이면 알림과 '매장 반납 처리', spec 3-1).
    drafts.push({
      stepKey: step.key, actionKey: step.action_key, status: cell.state, parts, order, stamp: cell, ...(laterDay ? { later: true } : {}),
      ...(figure ? { figure } : {}), ...(items?.length ? { items } : {}), ...(second?.length ? { second } : {}),
      ...(lateAt !== undefined && cell.state !== 'done' ? { lateAt: iso(lateAt) } : {}),
    });
  }

  // 이어 보낸 보증금 명령이 막혀 남은 것(data-model 4-18): 지급은 끝났는데 보증금을 받지 못한 권 · 돌아왔는데 돌려주지 않은 보증금. 누르면 그
  // 단계의 창이 보증금만 다시 묻는다(지금 할 일은 아니다: 주 버튼을 가져가지 않는다).
  const stepByRule = (rule: StampRuleKey) => keys.map((k) => steps.get(k)).find((st) => st?.rule_key === rule);
  const issueStep = stepByRule('qty_issued');
  const intake = issueStep ? depositDueForIssued(state, o) : null;
  if (issueStep && intake) {
    drafts.push({
      stepKey: 'deposit_take', actionKey: issueStep.action_key, status: 'partial', later: true, order: issueStep.urgency_out + 0.5,
      parts: [{ text: '보증금 입금', drop: 0 }, { text: won(intake.amount), drop: 1 }], stamp: { stepKey: issueStep.key, state: 'todo' },
    });
  }
  const returnStep = stepByRule('qty_returned');
  const refund = returnStep ? backHeldRefund(state, o) : null;
  if (returnStep && refund) {
    drafts.push({
      stepKey: 'deposit_refund', actionKey: returnStep.action_key, status: 'partial', later: true, order: 500 + returnStep.urgency_back + 0.5,
      parts: [{ text: '보증금 반환', drop: 0 }, { text: won(refund.amount), drop: 1 }], stamp: { stepKey: returnStep.key, state: 'todo' },
    });
  }

  drafts.sort((a, b) => a.order - b.order);
  let next: NextStep | null = null;
  const out = drafts.map(({ status, order: _order, later, ...item }): ChecklistItem => {
    const finished = status === 'done';
    const counterCan = (status === 'todo' || status === 'partial') && !later;
    if (!finished && counterCan && next === null) {
      next = { stepKey: item.stepKey, actionKey: item.actionKey, ...(item.figure ? { figure: item.figure } : {}) };
      return { ...item, state: 'now' };
    }
    return { ...item, state: finished ? 'done' : 'later' };
  });
  return { items: out, next };
}

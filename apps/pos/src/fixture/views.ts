// FixtureClient의 읽기 모델 만들기(ui 7절의 서버 몫): 화면 설정(칸 · 탭 · 숫자)을 읽어 줄마다 칸 값을 만든다.
// 칸은 column_key가 아니라 그리기(renderer_key)와 연결(도장 단계의 rule_key · 동작)로 채운다: 설정에 도장 칸 · 장소 칸 ·
// 차량 칸을 더하면 여기를 고치지 않아도 나온다. 체험 자료에 없는 값(매장 속성 attribute, 뜻을 모르는 글 칸 text)은 칸 값을
// 만들지 않고, 화면은 빈칸으로 그린다(다른 칸의 값을 짐작해 넣지 않는다).
import {
  ACTION_LABELS, STAMP_RULE_SCOPE, resolveLedgerView, stampStepMap, statusTerm, visibleView,
  type ConfirmDraftParams, type ConfirmDraftView, type ConfirmStep, type DeviceClassKey, type DisabledAction, type FindResult, type FitPart, type LedgerCell,
  type LedgerColumnRow, type LedgerRow, type LedgerTabRow, type LedgerViewResult, type MetricValue, type OrderSlip, type PinRow,
  type ResolvedLedgerView, type ReviewItem, type SlipLine, type StampCell, type StampStepRow, type UiConfig, type ViewParams,
} from '@skinote/contract';
import type { FxLine, FxOrder, FxState } from './model.ts';
import { notReceived, notReceivedText } from './closing.ts';
import { backHeldRefund, depositDueAtIssue, depositDueForIssued, orderDepositHeld } from './deposits.ts';
import { collectDepositStep, deliverDone, deliverTasks, figureWords, findDeliverTask, onVanToDeliver, spareTickets, type FxDeliverTask } from './driver.ts';
import { productOf } from './catalog.ts';
import { currentReturn, findTask, openReturns, orderTasks, taskOrder, type FxTask } from './promises.ts';
import {
  anyIssued, backCount, bizDay, collectDone, collectLeft, coveredOrders, deliverTaskId, findOrder, isDeliverTaskId, isFinished, isVehiclePickup,
  isVehicleReturn, lastReturnSlotAt, LATE_AFTER_VEHICLE, moneyLateAt, nextDue, NIGHT_PREP_BEFORE, nightPrepSlotAt, onVan, openPins, orderConditions,
  listTasks, orderIdOfTask, othersDue, ownDue, dueFor, paidTotal, pendingIssue, pendingReturn, pinTask, pinTaskId, placeLabel, placeShortLabel, promisedPayer, routeTasks,
  selfDue, slotKey,
  sortTasks, unitCount, vehicleLabel, VISIT_OUTCOMES, visitReasons, charged, type DueKind,
} from './rules.ts';
import {
  blockedMessage, checklist, columnStamp, DELIVER_WORD, deliverLateAt, driverColumnStamp, figureOf, itemCounts, lineStamp, returnLateAt, stepStamp,
} from './stamps.ts';
import { bizHm, businessDateOf, dateTitle, dayWord, hm, iso, onBizDay, when, shopCutoff } from './time.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';

/** 장부 안의 시각(오늘이면 '22:00', 다른 영업일이면 '내일 09:00'). */
const whenIn = (ctx: ViewContext, ms: number) => when(ms, ctx.state.businessDate, shopCutoff(ctx.state.settings));

export interface ViewContext {
  state: FxState;
  config: UiConfig;
  now: number;
  /** 기사 기기에서 그릴 때: 보냄 대기로만 받은 업무(점선 도장, '대기' 숫자). */
  pendingTasks?: ReadonlySet<string>;
}

const head = (ctx: ViewContext) => ({
  basis: { epoch: ctx.state.epoch, rev: ctx.state.rev },
  serverTime: iso(ctx.now),
  currentBusinessDate: ctx.state.businessDate,
});

function view(ctx: ViewContext, key: string, deviceClass: DeviceClassKey): ResolvedLedgerView | undefined {
  const resolved = resolveLedgerView(ctx.config.ledgerViews, key, deviceClass);
  return resolved ? visibleView(resolved, ctx.config.features) : undefined;
}

const steps = (ctx: ViewContext): ReadonlyMap<string, StampStepRow> => stampStepMap(ctx.config.stampSteps, ctx.config.features);
const stepOfRule = (ctx: ViewContext, rule: StampStepRow['rule_key']) => [...steps(ctx).values()].find((s) => s.rule_key === rule);

// ── 칸 값 ────────────────────────────────────────────────────────────

const DUE_WORD: Record<DueKind, string> = { pickup: '수령', deliver: '배달', return: '반납', pay: '수납' };

/**
 * 시각 칸: 시각(빠지지 않음, 아랫줄)과 윗줄 조각들 — 다른 날이면 날짜 말('내일', 좁아도 남음), 그 뒤에 종류('수령' · '반납',
 * 좁으면 먼저 빠짐). 날짜와 시각을 한 조각('내일 09:00')으로 두면 좁은 칸에서 낱말이 빠져 시각이 사라진다.
 */
function timeCell(ctx: ViewContext, o: FxOrder): LedgerCell {
  const due = nextDue(ctx.state, o);
  const at = due?.at ?? currentReturn(o).at;
  const day = bizDay(ctx.state);
  const otherDay = !onBizDay(at, day);
  return {
    renderer: 'time',
    at: iso(at),
    parts: [
      ...(otherDay ? [{ text: dayWord(at, day.date, day.cutoff), drop: 1 }] : []),
      { text: due ? DUE_WORD[due.kind] : '반납', drop: 2 },
      { text: bizHm(at, day.cutoff), drop: 0 },
    ],
  };
}

/** 장부 품목 칸: 같은 품목(짧은 이름)은 한 칸으로 센다(새 접수의 의류 95 × 2 · 100 × 1 → 의류 3). */
function itemsOf(lines: readonly FxLine[]) {
  return itemCounts(lines, (l) => l.qty);
}

/** 반납 일정: '22:00 설천 주차장 · 차량', '16:30 매장', '내일 09:00 솔마을 한솔동 · 차량'. 일정이 나뉘었으면 아직 남은 가장 이른 일정. */
function promiseParts(ctx: ViewContext, o: FxOrder): FitPart[] {
  const p = currentReturn(o);
  const where = p.mode === 'store' ? '매장' : placeLabel(p.placeId);
  return [
    { text: whenIn(ctx, p.at) + ' ' + where, drop: 0, words: true },
    ...(p.mode === 'vehicle' ? [{ text: '차량', drop: 1 }] : []),
    ...(p.note ? [{ text: p.note, drop: 2 }] : []),
  ];
}

/**
 * 돈 칸. 미수는 늘 이 팀 몫이다. 다른 팀 몫(대납)까지 받을 팀은 합을 '받을 금액'으로 쓴다(미수 두 가지가 보이지 않게).
 * 좁으면 두 줄(작은 윗줄 '미수' · 아랫줄 '120,000원')로 이름과 단위를 함께 지킨다.
 */
function moneyCell(ctx: ViewContext, o: FxOrder): LedgerCell {
  const due = ownDue(o);
  const others = othersDue(ctx.state, o);
  const late = moneyLateAt(ctx.state, o);
  const lateAt = late === undefined ? {} : { lateAt: iso(late) };
  const term = (key: string) => statusTerm(ctx.config.statusTerms, 'pay_state', key, ctx.config.locale);
  if (charged(o) === 0 && others === 0) {
    const none = term('none');
    return { renderer: 'money', alts: [none.label], tone: none.tone };
  }
  if (due === 0 && others === 0) {
    const paid = term('paid');
    return { renderer: 'money', alts: [paid.label], tone: paid.tone };
  }
  const payer = findOrder(ctx.state, o.payerOrderId);
  if (payer && others === 0) {
    return { renderer: 'money', alts: [payer.teamName + ' 팀 결제 예정', '결제 예정'], stacked: { over: payer.teamName + ' 팀', main: '결제 예정' }, tone: term('promised').tone };
  }
  const unpaid = term('unpaid').label;
  if (others > 0) {
    const total = won(due + others);
    return {
      renderer: 'money',
      alts: [unpaid + ' ' + won(due) + ' · 대납 ' + won(others), '받을 금액 ' + total, total],
      stacked: { over: '받을 금액', main: total },
      tone: 'ink',
      ...lateAt,
    };
  }
  return { renderer: 'money', alts: [unpaid + ' ' + won(due), won(due)], stacked: { over: unpaid, main: won(due) }, tone: 'ink', ...lateAt };
}

/** 장소 칸(반납 장소): 긴 이름 → 짧은 이름('설천' · '들국화') → 빼기. 매장 반납은 '매장'. */
function placeCell(o: FxOrder): LedgerCell {
  const p = currentReturn(o);
  if (p.mode === 'store') return { renderer: 'place', parts: [{ text: '매장', drop: 0 }] };
  return { renderer: 'place', parts: [{ text: placeLabel(p.placeId), short: placeShortLabel(p.placeId), drop: 0, words: true }] };
}

/** 차량 칸: 차량 배달 · 수거가 있는 팀만. */
function vehicleCell(o: FxOrder): LedgerCell | null {
  const id = currentReturn(o).vehicleId ?? o.pickup.vehicleId;
  return id ? { renderer: 'vehicle', parts: [{ text: vehicleLabel(id), drop: 0 }] } : null;
}

function cellFor(ctx: ViewContext, o: FxOrder, column: LedgerColumnRow): LedgerCell | null {
  switch (column.renderer_key) {
    case 'time': return timeCell(ctx, o);
    case 'team': return { renderer: 'team', name: o.teamName, last4: o.last4 };
    case 'items': return { renderer: 'items', items: itemsOf(o.lines) };
    case 'promise': return { renderer: 'promise', parts: promiseParts(ctx, o) };
    case 'place': return placeCell(o);
    case 'vehicle': return vehicleCell(o);
    case 'money': return moneyCell(ctx, o);
    case 'stamp': return { renderer: 'stamp', stamp: columnStamp(ctx.state, o, column.step_keys ?? [], steps(ctx)) };
    case 'action': return column.action_key === 'call' ? { renderer: 'action', actionKey: 'call', enabled: o.phone !== '', phone: o.phone } : null;
    // 매장 속성 칸 · 뜻을 모르는 글 칸: 체험 자료에는 값이 없다(빈칸).
    case 'attribute':
    case 'text':
      return null;
  }
}

// ── 오늘 대여 장부(day_ledger) ─────────────────────────────────────────

type OrderFilter = (ctx: ViewContext, o: FxOrder) => boolean;

const FILTERS: Partial<Record<LedgerTabRow['filter_key'], OrderFilter>> = {
  all: () => true,
  pickup: (_ctx, o) => pendingIssue(o),
  return: (_ctx, o) => anyIssued(o) && pendingReturn(o),
  unpaid: (_ctx, o) => selfDue(o) > 0,
  vehicle: (_ctx, o) => isVehiclePickup(o) || isVehicleReturn(o),
  lessons: () => false,
};

function metricValue(ctx: ViewContext, orders: readonly FxOrder[], key: MetricValue['metricKey']): MetricValue | null {
  switch (key) {
    case 'team_count': return { metricKey: key, unit: 'team', value: orders.length };
    case 'issued_count': return { metricKey: key, unit: 'count', value: orders.filter((o) => o.lines.length > 0 && !pendingIssue(o)).length };
    case 'returned_count': return { metricKey: key, unit: 'count', value: orders.filter((o) => o.lines.some((l) => l.returnable) && !pendingReturn(o)).length };
    case 'due_total': return { metricKey: key, unit: 'won', value: orders.reduce((sum, o) => sum + ownDue(o), 0) };
    default: return null;
  }
}

/** 줄 순서: 다음 약속 시각(next_due_at) 순, 끝난 팀은 맨 뒤(N15). 같은 시각은 접수 순. */
function sortOrders(ctx: ViewContext, orders: readonly FxOrder[]): FxOrder[] {
  const key = (o: FxOrder) => {
    const due = isFinished(ctx.state, o) ? null : nextDue(ctx.state, o);
    return due ? due.at : Number.POSITIVE_INFINITY;
  };
  return [...orders].sort((a, b) => key(a) - key(b) || a.receiptNo.localeCompare(b.receiptNo));
}

/** 야간 수거 준비 안내: 그날 차량 수거가 걸린 가장 늦은 반납 타임(야간 22:00)의 60분 전부터 그 시각까지, 가장 많은 장소. */
function nightPrep(ctx: ViewContext, orders: readonly FxOrder[]): LedgerViewResult['nightPrep'] {
  const slotAt = nightPrepSlotAt(ctx.state, ctx.state.businessDate);
  if (slotAt === undefined || ctx.now < slotAt - NIGHT_PREP_BEFORE || ctx.now > slotAt) return undefined;
  const byPlace = new Map<string, number>();
  // 차량 일정마다(일정이 나뉜 팀은 장소마다 한 번).
  for (const task of orders.flatMap(orderTasks)) {
    if (task.promise.at !== slotAt || !pendingReturn(taskOrder(task))) continue;
    const place = task.promise.placeId ?? '';
    byPlace.set(place, (byPlace.get(place) ?? 0) + 1);
  }
  const top = [...byPlace.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? { slotAt: iso(slotAt), placeLabel: placeLabel(top[0]), teams: top[1] } : undefined;
}

export function dayLedger(ctx: ViewContext, params: ViewParams): LedgerViewResult {
  const date = params.date ?? ctx.state.businessDate;
  const deviceClass = params.deviceClass ?? 'pos';
  const v = view(ctx, 'day_ledger', deviceClass);
  if (!v) throw new Error('화면 설정이 없다: day_ledger');
  const dayOrders = date === ctx.state.businessDate ? ctx.state.orders : [];
  const tabKey = v.tabs.some((t) => t.tab_key === params.tabKey) ? params.tabKey! : v.tabs[0]?.tab_key ?? 'all';
  const filterOf = (key: string) => FILTERS[v.tabs.find((t) => t.tab_key === key)?.filter_key ?? 'all'] ?? (() => true);
  const shown = sortOrders(ctx, dayOrders.filter((o) => filterOf(tabKey)(ctx, o)));
  const tabCounts = Object.fromEntries(v.tabs.map((t) => [t.tab_key, dayOrders.filter((o) => filterOf(t.tab_key)(ctx, o)).length]));

  const rows: LedgerRow[] = shown.map((o, i) => {
    const finished = isFinished(ctx.state, o);
    const due = finished ? null : nextDue(ctx.state, o);
    const cells: LedgerRow['cells'] = {};
    for (const column of v.columns) {
      const cell = cellFor(ctx, o, column);
      if (cell) cells[column.column_key] = cell;
    }
    // 모인 도장 칸(좁은 화면)이 보일 다음 단계: 칸 순서에서 카운터가 할 첫 도장.
    const next = v.columns
      .map((c) => cells[c.column_key])
      .find((c) => c?.renderer === 'stamp' && (c.stamp.state === 'todo' || c.stamp.state === 'partial'));
    return {
      id: o.id,
      orderId: o.id,
      rank: String(i).padStart(4, '0'),
      ...(due ? { dueAt: iso(due.at) } : {}),
      ...(due?.lateAt !== undefined ? { lateAt: iso(due.lateAt) } : {}),
      finished,
      cells,
      conditions: orderConditions(ctx.state, o),
      ...(next?.renderer === 'stamp' ? { nextStepKey: next.stamp.stepKey } : {}),
    };
  });

  const metrics = v.metrics.map((m) => metricValue(ctx, dayOrders, m.metric_key)).filter((m): m is MetricValue => m !== null);
  // 마지막 반납 타임(심야 24:00)이 지나면 주 버튼이 '마감'(after_last_return_slot).
  const after = ctx.now >= lastReturnSlotAt(ctx.state, ctx.state.businessDate);
  const prep = nightPrep(ctx, dayOrders);
  return {
    ...head(ctx),
    viewKey: 'day_ledger',
    deviceClass,
    titleValues: { date },
    activeTabKey: tabKey,
    tabCounts,
    groups: [],
    rows,
    metrics,
    activeConditions: [after ? 'after_last_return_slot' : 'before_last_return_slot'],
    ...(prep ? { nightPrep: prep } : {}),
    // 이미 마감한 영업일: 제목 옆 이름표(마감 뒤의 기록은 다음 날 마감에 든다, closing.ts postingDate).
    ...(ctx.state.closings.some((c) => c.date === date) ? { closedTag: '마감 완료' } : {}),
  };
}

// ── 수거 목록(collection_list: 기사 태블릿 · 휴대폰 · 카운터) ───────────────────────────

/** 수거 실패 뒤 다시 갈 시각으로 옮긴 업무(마지막 방문 결과의 재방문 시각이 지금 반납 일정). */
const isRevisit = (o: FxOrder) => { const last = o.visits?.filter((v) => v.kind !== 'deliver').at(-1); return last?.retryAt === o.giveBack.at; };

const COLLECT_FILTERS: Partial<Record<LedgerTabRow['filter_key'], (o: FxOrder) => boolean>> = {
  all: () => true,
  remaining: (o) => !collectDone(o),
  collected: (o) => collectDone(o),
};

/** 기사 기기에서만 찍는 도장(수거 · 입고): 카운터가 누르면 창 대신 한 줄('1호 차량 수거 예정')과 '접수증'. */
const DRIVER_RULES: ReadonlySet<string> = new Set(['qty_collected', 'task_received']);

/**
 * 수거 목록의 도장 칸: 칸의 단계를 규칙으로 계산하고(수거 · 입고 · 반납 …), 전송 대기로만 받은 업무는 점선.
 * 카운터(포스 판)에서 기사가 찍을 도장을 누르면 창 대신 한 줄(누가 하는지)과 '접수증'이 뜬다.
 */
function listStamp(ctx: ViewContext, o: FxOrder, column: LedgerColumnRow, counter: boolean, pending: boolean): StampCell {
  const all = steps(ctx);
  const cell = columnStamp(ctx.state, o, column.step_keys ?? [], all);
  const rule = all.get(cell.stepKey)?.rule_key;
  if (cell.state === 'done' && pending) {
    return {
      ...cell, pending: true,
      pressNote: { lines: [(cell.at ? hm(Date.parse(cell.at)) + ' ' : '') + '처리 · 전송 대기'] },
    };
  }
  if (counter && rule && DRIVER_RULES.has(rule) && (cell.state === 'todo' || cell.state === 'partial')) {
    return {
      ...cell,
      pressNote: {
        lines: [vehicleLabel(o.giveBack.vehicleId) + ' 수거 예정'],
        action: { actionKey: 'open_slip', label: ACTION_LABELS.open_slip },
      },
    };
  }
  return cell;
}

/** 차량 재고: 품목별 합(수거했지만 매장에 아직 입고하지 않은 것). 권은 단위('매')와 함께. */
function loadItems(orders: readonly FxOrder[], qty: (l: FxLine) => number) {
  const byLabel = new Map<string, { qty: number; unit?: string }>();
  for (const o of orders) {
    for (const l of o.lines) {
      if (qty(l) <= 0) continue;
      const seen = byLabel.get(l.shortLabel);
      byLabel.set(l.shortLabel, { qty: (seen?.qty ?? 0) + qty(l), ...(l.unit ? { unit: l.unit } : {}) });
    }
  }
  return [...byLabel.entries()].map(([label, x]) => ({ label, qty: x.qty, ...(x.unit ? { unit: x.unit } : {}) }));
}

/**
 * 줄마다 지금 누를 수 없는 동작(회색)과 까닭. 순서 동작(▲ · ▼ · 맨 위로)은 보이는 목록의 같은 반납 타임 안에서, 빨리 확인으로
 * 고정된 줄은 옮길 수 없다(맨 위에 있다).
 */
function rowDisabled(o: FxOrder, position: { index: number; count: number } | null): DisabledAction[] {
  const out: DisabledAction[] = [];
  if (collectDone(o)) out.push({ actionKey: 'not_collected', reason: '수거 완료' });
  if (!o.phone) out.push({ actionKey: 'call', reason: '전화번호 없음' });
  if (position === null) {
    for (const actionKey of ['move_up', 'move_down', 'move_top'] as const) out.push({ actionKey, reason: '긴급 고정 · 이동 불가' });
  } else {
    if (position.index === 0) out.push({ actionKey: 'move_up', reason: '맨 위' }, { actionKey: 'move_top', reason: '맨 위' });
    if (position.index === position.count - 1) out.push({ actionKey: 'move_down', reason: '맨 아래' });
  }
  return out;
}

export function collectionList(ctx: ViewContext, params: ViewParams): LedgerViewResult {
  const deviceClass = params.deviceClass ?? 'driver_tablet';
  const v = view(ctx, 'collection_list', deviceClass);
  if (!v) throw new Error('화면 설정이 없다: collection_list');
  const counter = deviceClass === 'pos' || deviceClass === 'pos_narrow';
  const vehicleId = params.vehicleId ?? 'v1';
  const date = params.date ?? ctx.state.businessDate;
  const pending = ctx.pendingTasks ?? new Set<string>();
  // 줄은 차량 업무(반납 일정)마다: 일정 변경으로 나뉜 팀은 두 줄(22:00 설천 주차장 · 22:00 솔마을 두솔동). 칸 · 도장 · 품목은
  // 그 업무의 몫만 비춘 접수(taskOrder)로 그린다.
  // 손님이 모두 매장에 가져와 차량이 받을 것이 없어진 업무는 빠진다(listTasks, data-model 4-18).
  const tasks = date === ctx.state.businessDate ? listTasks(ctx.state, vehicleId, date) : [];
  const projected = new Map(tasks.map((t) => [t.id, taskOrder(t)] as const));
  const po = (t: FxTask) => projected.get(t.id) ?? taskOrder(t);
  const slotOf = (t: FxTask) => slotKey(po(t));
  const tabKey = v.tabs.some((t) => t.tab_key === params.tabKey) ? params.tabKey! : v.tabs[0]?.tab_key ?? 'all';
  const filterOf = (key: string) => COLLECT_FILTERS[v.tabs.find((t) => t.tab_key === key)?.filter_key ?? 'all'] ?? (() => true);
  const shown = sortTasks(ctx.state, tasks.filter((t) => filterOf(tabKey)(po(t))));
  const pinned = new Set(openPins(ctx.state).map((p) => pinTaskId(ctx.state, p)));
  // 묶음 제목은 반납 타임('22:00 반납'). 수거 실패 뒤 다시 갈 시각으로 옮긴 업무만 있는 묶음은 '23:50 재방문'이고,
  // 반납 타임 묶음에 섞인 재방문 업무는 줄에 '재방문'을 붙인다(묶음 제목과 겹쳐 쓰지 않음).
  const revisitSlots = new Set(tasks.filter((t) => tasks.filter((x) => slotOf(x) === slotOf(t)).every((x) => isRevisit(po(x)))).map(slotOf));
  const groups = [...new Map(shown.map((t) => [slotOf(t), t.promise.at] as const)).entries()].map(([key, at]) => {
    const inSlot = tasks.filter((t) => slotOf(t) === key);
    return { key, label: hm(at) + ' ' + (revisitSlots.has(key) ? '재방문' : '반납'), shortLabel: hm(at), at: iso(at), done: inSlot.filter((t) => collectDone(po(t))).length, total: inSlot.length };
  });
  const rows: LedgerRow[] = shown.map((t, i) => {
    const o = po(t);
    const taskId = t.id;
    const done = collectDone(o);
    const cells: LedgerRow['cells'] = {};
    for (const column of v.columns) {
      if (column.renderer_key === 'stamp') cells[column.column_key] = { renderer: 'stamp', stamp: listStamp(ctx, o, column, counter, pending.has(taskId)) };
      // 수거 목록의 품목은 차량이 받을 것(내준 반납 품목)만.
      else if (column.renderer_key === 'items') cells[column.column_key] = { renderer: 'items', items: itemsOf(o.lines.filter((l) => l.returnable && l.issued > 0)) };
      else {
        const cell = cellFor(ctx, o, column);
        if (cell) cells[column.column_key] = cell;
      }
    }
    // 보이는 목록에서 같은 반납 타임 · 고정되지 않은 줄 사이의 자리(▲ · ▼ · 맨 위로의 가능 여부).
    const siblings = shown.filter((x) => slotOf(x) === slotOf(t) && !pinned.has(x.id));
    const position = pinned.has(taskId) ? null : { index: siblings.indexOf(t), count: siblings.length };
    const disabledActions = rowDisabled(o, position);
    return {
      id: taskId, orderId: t.order.id, taskId, groupKey: slotOf(t),
      subgroupLabel: placeLabel(t.promise.placeId), subgroupShortLabel: placeShortLabel(t.promise.placeId),
      rank: String(i).padStart(4, '0'), dueAt: iso(t.promise.at),
      // 차량 수거는 약속 60분 뒤부터 늦음(빨강). 받은 업무는 늦지 않다.
      ...(done ? {} : { lateAt: iso(t.promise.at + LATE_AFTER_VEHICLE) }),
      finished: false, cells,
      conditions: orderConditions(ctx.state, t.order),
      ...(disabledActions.length ? { disabledActions } : {}),
      ...(!done && isRevisit(o) && !revisitSlots.has(slotOf(t)) ? { reviewNote: '재방문' } : {}),
    };
  });
  const views = tasks.map(po);
  const van = vanStock(ctx, vehicleId, date);
  const onVanItems = van.items;
  const doneCount = views.filter(collectDone).length;
  const pendingCount = tasks.filter((t) => pending.has(t.id)).length;
  const metrics: MetricValue[] = v.metrics.flatMap((m): MetricValue[] => {
    switch (m.metric_key) {
      case 'collected_count': return [{ metricKey: m.metric_key, unit: 'count', value: doneCount - pendingCount }];
      // 전송 대기는 기사 기기의 것이다: 카운터(포스 판)에는 보낼 기록이 없어 숫자를 주지 않는다.
      case 'pending_count': return counter ? [] : [{ metricKey: m.metric_key, unit: 'count', value: pendingCount }];
      case 'remaining_count': return [{ metricKey: m.metric_key, unit: 'count', value: tasks.length - doneCount }];
      case 'vehicle_load': return [{ metricKey: m.metric_key, unit: 'items', items: onVanItems }];
      default: return [];
    }
  });
  const inList = new Set(tasks.map((t) => t.id));
  const pins: PinRow[] = openPins(ctx.state).flatMap((p) => {
    const task = pinTask(ctx.state, p);
    if (!task || !inList.has(task.id)) return [];
    const o = task.order;
    // 장소는 기사에게 가장 중요하다: 메모가 먼저 빠지고(시각은 화면이 그 다음에 뺀다), 장소는 짧은 이름('들국화')으로 줄었다가 마지막에 빠진다.
    return [{
      pinId: p.id, taskId: task.id, orderId: o.id, at: iso(p.at), phone: o.phone, status: p.status,
      parts: [
        { text: placeLabel(task.promise.placeId), short: placeShortLabel(task.promise.placeId), drop: 1 },
        { text: o.teamName + ' · ' + o.last4, drop: 0 },
        ...(p.note ? [{ text: p.note, drop: 3 }] : []),
      ],
    }];
  });
  const vehicle = { id: vehicleId, label: vehicleLabel(vehicleId) };
  return {
    ...head(ctx),
    viewKey: 'collection_list',
    deviceClass,
    titleValues: { date, vehicle: vehicle.label },
    activeTabKey: tabKey,
    tabCounts: Object.fromEntries(v.tabs.map((t) => [t.tab_key, tasks.filter((x) => filterOf(t.tab_key)(po(x))).length])),
    groups,
    rows,
    metrics,
    activeConditions: [],
    primaryFigure: van.figure,
    pins,
    vehicle,
    vehicleLoad: van.load,
    visitReasons: visitReasons('collect'),
  };
}

/**
 * 차량 재고(문구 표: 지금 차량에 있는 장비 · 권, ui 6-5): 실었지만 아직 건네지 않은 배달 품목(그 배달 팀 아래), 수거했지만 매장에 아직 입고하지
 * 않은 것(업무마다 누구 것인지), 차량 예비권(`예비권 6매`). 매장 입고 주 버튼의 수(figure)는 그중 입고할 수 있는 것(수거한 것)만이라 두 수는
 * 일부러 다르다. 수거 목록 · 배달 목록이 같은 셈을 쓴다(주 버튼 `매장 입고 · N개`는 목록과 상관없이 차에 있는 것이다).
 */
function vanStock(ctx: ViewContext, vehicleId: string, date: string) {
  const today = date === ctx.state.businessDate;
  const tasks = today ? routeTasks(ctx.state, vehicleId, date) : [];
  const views = tasks.map(taskOrder);
  const deliveries = today ? deliverTasks(ctx.state, vehicleId, date) : [];
  const spare = today ? spareTickets(ctx.state, vehicleId) : [];
  const spareItems = spare.flatMap((x) => {
    const product = productOf(x.productKey);
    return x.ids.length ? [{ label: product?.shortLabel ?? product?.label ?? x.productKey, qty: x.ids.length, unit: product?.unit ?? '매' }] : [];
  });
  const spareTotal = spareItems.reduce((n, x) => n + x.qty, 0);
  const loaded = (l: FxLine) => onVanToDeliver(l);
  const items = [
    ...itemCounts([...deliveries.flatMap((d) => d.order.lines.filter((l) => loaded(l) > 0).map((l) => ({ ...l, qty: loaded(l) }))),
      ...views.flatMap((o) => o.lines.filter((l) => onVan(l) > 0).map((l) => ({ ...l, qty: onVan(l) })))], (l) => l.qty),
    ...(spareTotal > 0 ? [{ label: '예비권', qty: spareTotal, unit: spareItems[0]?.unit ?? '매' }] : []),
  ];
  const byTask = [
    ...deliveries.flatMap((d) => {
      const list = itemsOf(d.order.lines.filter((l) => loaded(l) > 0).map((l) => ({ ...l, qty: loaded(l) })));
      return list.length ? [{ taskId: d.id, teamName: d.order.teamName, last4: d.order.last4, items: list }] : [];
    }),
    ...tasks.flatMap((t, i) => {
      const o = views[i]!;
      const list = itemsOf(o.lines.filter((l) => onVan(l) > 0).map((l) => ({ ...l, qty: onVan(l) })));
      return list.length ? [{ taskId: t.id, teamName: o.teamName, last4: o.last4, items: list }] : [];
    }),
  ];
  return {
    items,
    figure: figureOf(views.flatMap((o) => o.lines), onVan) ?? { count: 0 },
    load: { vehicleId, vehicleLabel: vehicleLabel(vehicleId), items, spareTickets: spareItems, byTask },
  };
}

// ── 배달 목록(delivery_list: 기사 태블릿 · 휴대폰, ui 6-5) ─────────────────────────────

const DELIVER_FILTERS: Partial<Record<LedgerTabRow['filter_key'], (o: FxOrder) => boolean>> = {
  all: () => true,
  remaining: (o) => !deliverDone(o),
  collected: (o) => deliverDone(o),
};

/**
 * 기사의 배달 목록(아침 · 낮): 이 차량 · 영업일의 차량 배달 업무(접수마다 하나). 묶음은 배달 시각('17:00 배달 · 0 / 1'), 줄 안의 장소
 * 이름표, 칸은 설정(배달 도장 사슬 적재 → 배달 · 팀 · 품목 · 전화). 기사가 할 배달 단계는 미처리(카운터의 보라 '차량 17:00'이 아님)이고
 * 이름이 `배달`이다. 줄의 팀 칸을 누르면 업무 판(V7). 주 버튼(설정 next_step)은 아직 건네지 않은 첫 배달의 `배달 처리 · 6개`(nextTask).
 */
export function deliveryList(ctx: ViewContext, params: ViewParams): LedgerViewResult {
  const deviceClass = params.deviceClass ?? 'driver_tablet';
  const v = view(ctx, 'delivery_list', deviceClass);
  if (!v) throw new Error('화면 설정이 없다: delivery_list');
  const vehicleId = params.vehicleId ?? 'v1';
  const date = params.date ?? ctx.state.businessDate;
  const pending = ctx.pendingTasks ?? new Set<string>();
  const all = steps(ctx);
  const today = bizDay(ctx.state);
  const tasks = date === ctx.state.businessDate ? deliverTasks(ctx.state, vehicleId, date) : [];
  const tabKey = v.tabs.some((t) => t.tab_key === params.tabKey) ? params.tabKey! : v.tabs[0]?.tab_key ?? 'all';
  const filterOf = (key: string) => DELIVER_FILTERS[v.tabs.find((t) => t.tab_key === key)?.filter_key ?? 'all'] ?? (() => true);
  const shown = tasks.filter((t) => filterOf(tabKey)(t.order));
  const groupOf = (t: FxDeliverTask) => 'd' + hm(t.promise.at).replace(':', '');
  const groups = [...new Map(shown.map((t) => [groupOf(t), t.promise.at] as const)).entries()].map(([key, at]) => {
    const inSlot = tasks.filter((t) => groupOf(t) === key);
    return { key, label: hm(at) + ' ' + DELIVER_WORD, shortLabel: hm(at), at: iso(at), done: inSlot.filter((t) => deliverDone(t.order)).length, total: inSlot.length };
  });
  const rows: LedgerRow[] = shown.map((t, i) => {
    const o = t.order;
    const finished = deliverDone(o);
    const cells: LedgerRow['cells'] = {};
    for (const column of v.columns) {
      if (column.renderer_key === 'stamp') {
        const cell = driverColumnStamp(o, column.step_keys ?? [], all, today);
        const queued = cell.state === 'done' && pending.has(t.id);
        cells[column.column_key] = {
          renderer: 'stamp',
          stamp: queued ? { ...cell, pending: true, pressNote: { lines: [(cell.at ? hm(Date.parse(cell.at)) + ' ' : '') + '처리 · 전송 대기'] } } : cell,
        };
      } else {
        const cell = cellFor(ctx, o, column);
        if (cell) cells[column.column_key] = cell;
      }
    }
    const late = deliverLateAt(o);
    return {
      id: t.id, orderId: o.id, taskId: t.id, groupKey: groupOf(t),
      subgroupLabel: placeLabel(t.promise.placeId), subgroupShortLabel: placeShortLabel(t.promise.placeId),
      rank: String(i).padStart(4, '0'), dueAt: iso(t.promise.at),
      ...(!finished && late !== undefined ? { lateAt: iso(late) } : {}),
      finished: false, cells,
      conditions: orderConditions(ctx.state, o),
    };
  });
  const doneCount = tasks.filter((t) => deliverDone(t.order)).length;
  const pendingCount = tasks.filter((t) => pending.has(t.id)).length;
  const van = vanStock(ctx, vehicleId, date);
  // 주 버튼(next_step): 아직 건네지 않은 첫 배달(배달 시각 차례)을 그 팀의 배달 처리로. 실은 것이 없거나 남은 배달이 없으면 누를 수 없음.
  const deliverName = DELIVER_WORD + ' 처리';
  const next = tasks.find((t) => !deliverDone(t.order) && t.order.lines.some((l) => onVanToDeliver(l) > 0));
  const nextFigure = next ? figureWords(next.order.lines, onVanToDeliver) : '';
  const nextTask: LedgerViewResult['nextTask'] = next
    ? { taskId: next.id, actionKey: 'stamp.issue', label: deliverName + ' · ' + nextFigure, alts: [deliverName + ' · ' + nextFigure, deliverName], enabled: true }
    : { actionKey: 'stamp.issue', label: deliverName, alts: [deliverName], enabled: false };
  const metrics: MetricValue[] = v.metrics.flatMap((m): MetricValue[] => {
    switch (m.metric_key) {
      case 'collected_count': return [{ metricKey: m.metric_key, unit: 'count', value: doneCount - pendingCount }];
      case 'pending_count': return [{ metricKey: m.metric_key, unit: 'count', value: pendingCount }];
      case 'remaining_count': return [{ metricKey: m.metric_key, unit: 'count', value: tasks.length - doneCount }];
      case 'vehicle_load': return [{ metricKey: m.metric_key, unit: 'items', items: van.items }];
      default: return [];
    }
  });
  return {
    ...head(ctx),
    viewKey: 'delivery_list',
    deviceClass,
    titleValues: { date, vehicle: vehicleLabel(vehicleId) },
    activeTabKey: tabKey,
    tabCounts: Object.fromEntries(v.tabs.map((t) => [t.tab_key, tasks.filter((x) => filterOf(t.tab_key)(x.order)).length])),
    groups,
    rows,
    metrics,
    activeConditions: [],
    primaryFigure: van.figure,
    nextTask,
    vehicle: { id: vehicleId, label: vehicleLabel(vehicleId) },
    vehicleLoad: van.load,
    visitReasons: visitReasons('deliver'),
  };
}

// ── 대여 접수증(order_slip) ─────────────────────────────────────────────

const CHANNEL_LABEL = { phone: '전화 예약', walk_in: '현장 접수' } as const;
/** 수납 수단 이름. 보증금 결제는 반납 창의 `미수 차감`이 남긴 수납 쪽 기록(문구 표 3-9). */
const METHOD_LABEL = { card: '카드', cash: '현금', transfer: '계좌이체', easy_pay: '간편결제', voucher: '상품권', deposit: '보증금 결제' } as const;

/**
 * 접수증 품목 줄: 설정의 칸마다 값을 채운다. 줄 단위(order_line)에서 품목 칸은 그 줄의 이름, 금액 칸은 그 줄의 금액,
 * 수량 칸(글 칸 'qty')은 수량 글자, 도장 칸은 그 줄의 도장(해당 없으면 칸 값 없음 → 화면이 그 칸을 뺀다).
 */
function slipLine(ctx: ViewContext, o: FxOrder, l: FxLine, columns: readonly LedgerColumnRow[]): SlipLine {
  const all = steps(ctx);
  const cells: SlipLine['cells'] = {};
  for (const column of columns) {
    switch (column.renderer_key) {
      case 'items':
        cells[column.column_key] = { renderer: 'text', parts: [{ text: l.label, drop: 0, words: true }] };
        break;
      case 'money':
        cells[column.column_key] = { renderer: 'money', alts: [won(l.amount)], tone: 'ink' };
        break;
      case 'text':
        // 체험 자료가 아는 글 칸은 수량뿐이다(매장이 더한 글 칸은 값이 없어 빈칸).
        if (column.column_key === 'qty') cells[column.column_key] = { renderer: 'text', parts: [{ text: l.qty + (l.unit ?? ''), drop: 0 }] };
        break;
      case 'stamp': {
        const key = column.step_keys?.at(-1);
        const step = key ? all.get(key) : undefined;
        if (!step) break;
        const day = bizDay(ctx.state);
        const cell = lineStamp(o, l, step, all, day);
        // 이 줄에 해당 없는 단계(반납 선택 매장의 리프트권 반납)는 '—', 이 접수에 아예 없는 단계(매장 수령의 적재)는 칸 값 없음.
        if (cell) cells[column.column_key] = { renderer: 'stamp', stamp: cell };
        else if (o.lines.some((x) => lineStamp(o, x, step, all, day))) cells[column.column_key] = { renderer: 'stamp', stamp: { stepKey: step.key, state: 'na' } };
        break;
      }
      default:
        break;
    }
  }
  return {
    id: l.id,
    isBundle: false,
    label: l.label,
    qty: l.qty,
    qtyText: l.qty + (l.unit ?? ''),
    amount: l.amount,
    cells,
    capabilities: l.issued > backCount(l) ? l.capabilities : [],
  };
}

export function orderSlip(ctx: ViewContext, orderId: string, deviceClass: DeviceClassKey = 'pos'): OrderSlip | null {
  const o = findOrder(ctx.state, orderId);
  if (!o) return null;
  const v = view(ctx, 'order_slip', deviceClass);
  if (!v) throw new Error('화면 설정이 없다: order_slip');
  const today = ctx.state.businessDate;
  const all = steps(ctx);
  const slipSteps = v.columns.filter((c) => c.renderer_key === 'stamp').flatMap((c) => c.step_keys ?? []);
  const { items, next } = checklist(ctx.state, o, all, slipSteps, bizDay(ctx.state));
  const depositHeld = orderDepositHeld(ctx.state, o);
  const payer = findOrder(ctx.state, o.payerOrderId);
  const due = ownDue(o);
  const covered = coveredOrders(ctx.state, o);
  const others = othersDue(ctx.state, o);
  const late = moneyLateAt(ctx.state, o);
  const pin = openPins(ctx.state).find((p) => p.orderId === o.id);
  // 반납 일정이 품목 · 수량으로 나뉘었으면(일정 변경) 그 수: 접수증 일정 줄이 '반납 일정 2건 ›'.
  const returns = openReturns(o).length;
  const promiseLine = (kind: 'pickup' | 'return') => {
    const p = kind === 'pickup' ? o.pickup : currentReturn(o);
    const lateAt = kind === 'pickup' ? deliverLateAt(o) : returnLateAt(o);
    return {
      kind,
      at: iso(p.at),
      when: whenIn(ctx, p.at),
      ...(lateAt !== undefined ? { lateAt: iso(lateAt) } : {}),
      ...(kind === 'return' && returns > 1 ? { count: returns } : {}),
      parts: [
        { text: p.mode === 'store' ? '매장' : placeLabel(p.placeId), drop: 1 },
        ...(p.mode === 'vehicle' ? [{ text: vehicleLabel(p.vehicleId), drop: 2 }] : []),
        ...(p.note ? [{ text: p.note, drop: 3 }] : []),
        ...(kind === 'return' && pin ? [{ text: pin.status === 'acknowledged' ? '긴급 · 기사 확인' : '긴급 요청', drop: 4 }] : []),
      ],
    };
  };
  const orderStamps = [...all.values()].filter((s) => STAMP_RULE_SCOPE[s.rule_key] === 'order').map((s) => stepStamp(ctx.state, o, s, all)).filter((c) => c.state !== 'na');
  // 이 팀이 결제 팀으로 낸 돈 중 다른 팀 몫(일괄 수납 · 대납 수납): 돈 한 건의 실제 금액과 수단(가장 최근 결제).
  const paidGroups = ctx.state.paymentGroups.filter((g) => g.payerOrderId === o.id).sort((a, b) => a.at - b.at);
  const paidForOthers = paidGroups.reduce((sum, g) => sum + ctx.state.orders
    .filter((x) => x.id !== o.id)
    .reduce((n, x) => n + x.payments.filter((p) => p.groupId === g.id).reduce((m, p) => m + p.amount, 0), 0), 0);
  const lastGroup = paidGroups.at(-1);
  return {
    ...head(ctx),
    orderId: o.id,
    receiptNo: o.receiptNo,
    businessDate: today,
    teamName: o.teamName,
    last4: o.last4,
    fields: [
      { key: 'date', label: '날짜', value: dateTitle(today), drop: 2 },
      { key: 'channel', label: '구분', value: CHANNEL_LABEL[o.channel], drop: 3 },
      { key: 'name', label: '대표자', value: o.teamName, drop: 0 },
      // 적지 않은 연락처 · 인원(현장 접수는 대표자만 적기도 한다)은 빈 칸 대신 칸째 뺀다.
      ...(o.phone ? [{ key: 'phone', label: '연락처', value: o.phone, drop: 0 }] : []),
      ...(o.party > 0 ? [{ key: 'party', label: '인원', value: o.party + '명', drop: 1 }] : []),
    ],
    lines: o.lines.map((l) => slipLine(ctx, o, l, v.columns)),
    promises: { distinct: Math.max(1, returns), lines: [promiseLine('pickup'), promiseLine('return')] },
    money: {
      charged: charged(o),
      paid: paidTotal(o),
      due,
      payments: o.payments.map((p) => ({ amount: p.amount, methodLabel: METHOD_LABEL[p.methodKey], date: businessDateOf(p.at, shopCutoff(ctx.state.settings)) })),
      ...(payer && due > 0 ? { promisedBy: { teamName: payer.teamName + ' 팀', amount: due } } : {}),
      ...(others > 0 ? { collectForOthers: others, collectTotal: due + others } : {}),
      // 맡은 보증금(청구 · 미수와 따로, data-model 4-12). 없으면 조각이 없다.
      ...(depositHeld > 0 ? { depositHeld } : {}),
      ...(paidForOthers > 0 && lastGroup
        ? { paidForOthers: { amount: paidForOthers, methodLabel: METHOD_LABEL[lastGroup.methodKey], total: paidGroups.filter((g) => g.methodKey === lastGroup.methodKey).reduce((n, g) => n + g.amount, 0) } }
        : {}),
      ...(late !== undefined ? { lateAt: iso(late) } : {}),
    },
    orderStamps,
    // 다른 팀 몫까지 받을 팀(결제 예정 팀이 딸림): 수납은 보통 수납 창이 아니라 일괄 수납 화면(V5, ui 6-7). 팀 수는 이 팀(제 몫이 있으면) 포함.
    ...(covered.length ? { groupPay: { teams: covered.length + (due > 0 ? 1 : 0), amount: due + others } } : {}),
    checklist: items,
    nextStep: next,
    activeConditions: orderConditions(ctx.state, o),
  };
}

// ── 끝 4자리 찾기 · 확인 필요 ──────────────────────────────────────────

export function findLast4(ctx: ViewContext, last4: string): FindResult {
  const matches = ctx.state.orders
    .filter((o) => o.last4 === last4)
    .map((o) => ({ orderId: o.id, teamName: o.teamName, last4: o.last4, parts: promiseParts(ctx, o) }));
  return { last4, matches };
}

export function reviewList(ctx: ViewContext): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const o of ctx.state.orders) {
    const due = nextDue(ctx.state, o);
    if (due?.kind === 'return' && due.lateAt !== undefined && due.lateAt <= ctx.now) {
      out.push({
        id: 'late:' + o.id, kindKey: 'late_return', severity: 'action', createdAt: iso(due.lateAt), orderId: o.id,
        message: o.teamName + ' 팀 반납 지연 · ' + whenIn(ctx, due.at) + ' ' + (currentReturn(o).mode === 'store' ? '매장' : placeLabel(currentReturn(o).placeId)),
      });
    }
  }
  for (const p of openPins(ctx.state)) {
    const o = findOrder(ctx.state, p.orderId);
    if (!o || p.status === 'acknowledged') continue;
    const place = pinTask(ctx.state, p)?.promise.placeId ?? o.giveBack.placeId;
    out.push({
      id: 'pin:' + p.id, kindKey: 'pin', severity: 'info', createdAt: iso(p.at), orderId: o.id,
      message: o.teamName + ' 팀 ' + (p.note ? p.note + ' · ' : '') + hm(p.at) + ' ' + placeLabel(place) + ' · 긴급 요청',
    });
  }
  // 매장 입고 뒤에도 차에 남은 것(부분 입고, closing.ts): 마감의 이월 항목 `확인 필요`와 같은 것.
  for (const x of notReceived(ctx.state, ctx.state.businessDate)) {
    out.push({
      id: 'unreceived:' + x.l.id, kindKey: 'not_received', severity: 'action', createdAt: iso(x.at), orderId: x.o.id,
      message: x.o.teamName + ' 팀 ' + notReceivedText(x.l, x.qty),
    });
  }
  // 초과 수납(sys_review_kinds overpaid): 보냄 대기로 온 현장 수납은 기기에서 이미 받은 돈이라 받을 돈보다 많아도 적는다(driver.ts).
  for (const o of ctx.state.orders) {
    const over = paidTotal(o) - charged(o);
    if (over <= 0) continue;
    const last = o.payments.reduce((max, p) => Math.max(max, p.at), 0);
    out.push({
      id: 'overpaid:' + o.id, kindKey: 'overpaid', severity: 'action', createdAt: iso(last), orderId: o.id,
      message: o.teamName + ' 팀 초과 수납 ' + won(over) + ' · 환불 또는 다른 팀 이동',
    });
  }
  for (const o of ctx.state.orders) {
    const visit = o.visits?.at(-1);
    // 배달 실패는 건넬 때까지, 수거 실패는 받을 때까지 남는다.
    if (!visit || (visit.kind === 'deliver' ? deliverDone(o) : collectDone(o))) continue;
    out.push({
      id: 'visit:' + o.id + ':' + visit.at, kindKey: 'visit_result', severity: 'info', createdAt: iso(visit.at), orderId: o.id,
      message: o.teamName + ' 팀 ' + VISIT_OUTCOMES[visit.outcomeKey] + (visit.retryAt !== undefined ? ' · 재방문 ' + whenIn(ctx, visit.retryAt) : ''),
    });
  }
  return out;
}

// ── 확인 창 초안 ─────────────────────────────────────────────────────

const unitWord = (l: FxLine) => l.unit ?? '개';
const itemLine = (lines: readonly { l: FxLine; qty: number }[]) => lines.map(({ l, qty }) => l.label + ' ' + qty + (l.unit ?? '')).join(' · ');

/** '6개', '6개 · 3매'(주 버튼의 수와 같은 셈). */
function countWords(lines: readonly { l: FxLine; qty: number }[]): string {
  const units = unitCount(lines.map((x) => x.l), (l) => lines.find((x) => x.l === l)?.qty ?? 0);
  const byUnit = new Map<string, number>();
  for (const { l, qty } of lines) if (l.unit) byUnit.set(l.unit, (byUnit.get(l.unit) ?? 0) + qty);
  return [...(units > 0 ? [units + '개'] : []), ...[...byUnit.entries()].map(([u, n]) => n + u)].join(' · ');
}

function notice(ctx: ViewContext, title: string, message: string): ConfirmDraftView {
  return { basis: head(ctx).basis, title, summary: [], notice: message };
}

type Pick = { l: FxLine; qty: number };

function stockDraft(
  ctx: ViewContext,
  o: FxOrder,
  params: ConfirmDraftParams,
  actionLabel: string,
  left: (l: FxLine) => number,
  emptyMessage: string,
  build: (picks: Pick[]) => ConfirmDraftView['command'],
  more?: (picks: Pick[]) => { summary: string; label: string; then: ConfirmStep[] } | null,
): ConfirmDraftView {
  const scope = params.lineIds?.length ? o.lines.filter((l) => params.lineIds!.includes(l.id)) : o.lines;
  const picks = scope.map((l) => ({ l, qty: left(l) })).filter((x) => x.qty > 0);
  const title = actionLabel + ' · ' + o.teamName + ' 팀';
  if (picks.length === 0) return notice(ctx, title, emptyMessage);
  const base = { basis: head(ctx).basis, title, command: build(picks) };
  // 이어서 보낼 명령(지급 뒤의 보증금 입금)이 있으면 수량 −/+ 없이 잔여 수 그대로: 이어진 명령의 매수 · 금액이 창을 연 때 정해진다.
  const extra = more?.(picks) ?? null;
  if (extra) {
    return { ...base, summary: [itemLine(picks), extra.summary], confirmLabel: actionLabel + ' · ' + countWords(picks) + ' · ' + extra.label, then: extra.then };
  }
  const single = params.lineIds?.length === 1 && picks.length === 1 ? picks[0]! : null;
  if (single) {
    return {
      ...base,
      summary: [single.l.label + ' · 잔여 ' + single.qty + unitWord(single.l)],
      quantity: { value: single.qty, min: 1, max: single.qty, unit: unitWord(single.l) },
      confirmLabel: actionLabel,
    };
  }
  return { ...base, summary: [itemLine(picks)], confirmLabel: actionLabel + ' · ' + countWords(picks) };
}

/**
 * 지급 창이 먼저 묻는 보증금(catalog 11-1): 접수 때 받지 못한 권(전화 예약)이면 요약 한 줄(확정 창 V4의 보증금 칸과 같은 말)과
 * 주 버튼의 '보증금 15,000원', 지급 뒤에 이어 보낼 보증금 입금(deposit.take, 창을 연 때의 보관 금액 expect).
 */
function issueDeposit(ctx: ViewContext, o: FxOrder, picks: Pick[]): { summary: string; label: string; then: ConfirmStep[] } | null {
  const due = depositDueAtIssue(ctx.state, o, picks);
  if (!due) return null;
  const unit = picks.find((x) => due.lines.some((d) => d.lineId === x.l.id))?.l.unit ?? '개';
  return {
    summary: [due.rule.label, due.units + unit, '매장 기준 1' + unit + ' ' + won(due.unitAmount), '반납 시 반환', METHOD_LABEL[due.methodKey] + ' ' + won(due.amount)].join(' · '),
    label: '보증금 ' + won(due.amount),
    then: [{
      command: { type: 'deposit.take', payload: { orderId: o.id, ruleKey: due.rule.key, lines: due.lines, amount: due.amount, methodKey: due.methodKey } },
      expect: { depositHeld: due.held },
    }],
  };
}

/**
 * 지급은 끝났는데 보증금을 받지 못한 권(이어 보낸 보증금 입금이 막혔음): 요약 한 줄과 주 버튼 `보증금 입금 · 15,000원`, 명령은 보증금 입금
 * 하나(창을 연 때의 보관 금액 expect). 없으면 null.
 */
function issuedDepositDraft(ctx: ViewContext, o: FxOrder): ConfirmDraftView | null {
  const due = depositDueForIssued(ctx.state, o);
  if (!due) return null;
  const unit = o.lines.find((l) => due.lines.some((d) => d.lineId === l.id))?.unit ?? '개';
  return {
    basis: head(ctx).basis,
    title: '보증금 입금 · ' + o.teamName + ' 팀',
    summary: [[due.rule.label, due.units + unit, '매장 기준 1' + unit + ' ' + won(due.unitAmount), '반납 시 반환', METHOD_LABEL[due.methodKey] + ' ' + won(due.amount)].join(' · ')],
    confirmLabel: '보증금 입금 · ' + won(due.amount),
    expect: { depositHeld: due.held },
    command: { type: 'deposit.take', payload: { orderId: o.id, ruleKey: due.rule.key, lines: due.lines, amount: due.amount, methodKey: due.methodKey } },
  };
}

/** 매장 입고(차량 단위): 차량 재고를 모두 매장으로. 연결이 있어야 한다(sync 8-4). */
function receiveDraft(ctx: ViewContext, vehicleId: string): ConfirmDraftView {
  // 업무(반납 일정)마다 차에 있는 몫. 팀 수는 접수 수(일정이 나뉜 팀도 한 팀).
  const tasks = routeTasks(ctx.state, vehicleId, ctx.state.businessDate).filter((t) => taskOrder(t).lines.some((l) => onVan(l) > 0));
  const title = ACTION_LABELS.receive_to_shop + ' · ' + vehicleLabel(vehicleId);
  if (tasks.length === 0) return notice(ctx, title, '입고 대상 없음');
  const views = tasks.map(taskOrder);
  const items = loadItems(views, onVan);
  const onVanLines = views.flatMap((o) => o.lines).map((l) => ({ l, qty: onVan(l) })).filter((x) => x.qty > 0);
  const teams = new Set(tasks.map((t) => t.order.id)).size;
  return {
    basis: head(ctx).basis,
    title,
    summary: [[teams + '팀', ...items.map((it) => it.label + ' ' + it.qty + (it.unit ?? ''))].join(' · ')],
    confirmLabel: ACTION_LABELS.receive_to_shop + ' · ' + countWords(onVanLines),
    command: { type: 'stock.receive', payload: { vehicleId, taskIds: tasks.map((t) => t.id) } },
  };
}

/** 시간순 정렬(차량 · 날짜 단위): 직접 바꾼 방문 순서를 모두 지운다. 목록 전체가 바뀌므로 확인 창을 거친다. */
function routeResetDraft(ctx: ViewContext, vehicleId: string): ConfirmDraftView {
  const title = ACTION_LABELS.route_reset + ' · ' + vehicleLabel(vehicleId);
  const moved = routeTasks(ctx.state, vehicleId, ctx.state.businessDate).filter((t) => t.id in ctx.state.routeRanks);
  if (moved.length === 0) return notice(ctx, title, '이미 시간순');
  return {
    basis: head(ctx).basis,
    title,
    summary: ['수동 순서 삭제 · 시간순 정렬', '긴급 줄 맨 위 유지'],
    confirmLabel: ACTION_LABELS.route_reset,
    command: { type: 'route.reset', payload: { vehicleId, date: ctx.state.businessDate } },
  };
}

/** 배달 확인 창(기사 기기): 실은 수만큼, 줄 하나면 수량 −/+ (부분 배달). 아직 싣지 않았으면 한 줄 `배달 불가 · 적재 대기`. */
function deliverDraft(ctx: ViewContext, params: ConfirmDraftParams): ConfirmDraftView {
  const task = findDeliverTask(ctx.state, params.taskId ?? '');
  const name = DELIVER_WORD + ' 처리';
  if (!task) return notice(ctx, name, '업무 없음');
  const o = task.order;
  const load = stepOfRule(ctx, 'qty_loaded');
  return stockDraft(ctx, o, params, name, onVanToDeliver,
    pendingIssue(o) ? blockedMessage({ label: DELIVER_WORD }, load) : DELIVER_WORD + ' 완료',
    (picks) => ({ type: 'stock.deliver', payload: { taskId: task.id, lines: picks.map(({ l, qty }) => ({ lineId: l.id, quantity: qty })) } }));
}

export function confirmDraft(ctx: ViewContext, params: ConfirmDraftParams): ConfirmDraftView {
  if (params.actionKey === 'receive_to_shop') return receiveDraft(ctx, params.vehicleId ?? 'v1');
  if (params.actionKey === 'route_reset') return routeResetDraft(ctx, params.vehicleId ?? 'v1');
  if (params.actionKey === 'print') {
    return notice(ctx, ACTION_LABELS.print, '체험판 미지원');
  }
  const o = findOrder(ctx.state, params.orderId ?? (params.taskId ? orderIdOfTask(params.taskId) : undefined));
  if (!o) return notice(ctx, '확인', '접수 없음');
  const label = (key: keyof typeof ACTION_LABELS) => ACTION_LABELS[key];
  const lines = (picks: Pick[]) => picks.map(({ l, qty }) => ({ lineId: l.id, quantity: qty }));
  // 차량 수거 업무: 목록 줄의 업무(반납 일정), 접수에서 누르면 아직 받지 않은 첫 업무(없으면 첫 업무).
  const task = (params.taskId ? findTask(ctx.state, params.taskId) : undefined)
    ?? orderTasks(o).find((t) => { const x = taskOrder(t); return anyIssued(x) && !collectDone(x); }) ?? orderTasks(o)[0];
  switch (params.actionKey) {
    case 'stamp.collect': {
      if (!task) return notice(ctx, label('stamp.collect') + ' · ' + o.teamName + ' 팀', '수거 대상 없음');
      const x = taskOrder(task);
      // 수거할 권에 맡은 보증금이 있으면 확인 창에 한 줄(`권 1매 보증금 5,000원 반환 · 차량 현금`)과 이어 보낼 현장 보증금 반환(spec 3-8).
      return stockDraft(ctx, x, params, label('stamp.collect'), collectLeft,
        collectDone(x) ? '수거 완료' : '수거 대상 없음',
        (picks) => ({ type: 'stock.collect', payload: { taskId: task.id, lines: lines(picks) } }),
        (picks) => collectDepositStep(ctx.state, task, picks));
    }
    case 'pin': {
      const title = label('pin') + ' · ' + o.teamName + ' 팀';
      const x = task ? taskOrder(task) : null;
      if (!task || !x || !anyIssued(x) || collectDone(x)) return notice(ctx, title, '차량 수거 대상 없음');
      const at = task.promise.at;
      if (!onBizDay(at, bizDay(ctx.state))) return notice(ctx, title, whenIn(ctx, at) + ' 수거 · 오늘 목록 제외');
      const open = openPins(ctx.state).find((p) => pinTaskId(ctx.state, p) === task.id);
      if (open) return notice(ctx, title, open.status === 'acknowledged' ? '긴급 요청 · 기사 확인 완료' : '긴급 요청 · 기사 확인 대기');
      // 메모는 반납 일정에 적힌 것만(없으면 비움: 긴급 줄에 뜻 없는 글을 넣지 않는다).
      const note = task.promise.note;
      return {
        basis: head(ctx).basis,
        title,
        summary: [
          [hm(at) + ' ' + placeLabel(task.promise.placeId), o.teamName, o.last4, ...(note ? [note] : [])].join(' · '),
          vehicleLabel(task.promise.vehicleId) + ' 수거 목록 맨 위 고정 · 기사 알림',
        ],
        confirmLabel: label('pin'),
        command: { type: 'task.pin', payload: { taskId: task.id, ...(note ? { note } : {}) } },
      };
    }
    case 'stamp.issue': {
      // 기사 기기의 배달 업무('deliver:<접수>'): 차에 실은 것을 손님께 건넴(stock.deliver, 창 제목 · 주 버튼 `배달 처리`, 문구 표 결정 4).
      if (params.taskId && isDeliverTaskId(params.taskId)) return deliverDraft(ctx, params);
      const draft = stockDraft(ctx, o, params, label('stamp.issue'), (l) => l.qty - l.issued, '지급 완료',
        (picks) => ({ type: 'stock.issue', payload: { orderId: o.id, lines: lines(picks) } }),
        (picks) => issueDeposit(ctx, o, picks));
      // 다 지급했는데 이어 보낸 보증금 입금이 막혀 받지 못한 권이 있으면 보증금 입금만(창 안에서 다시, data-model 4-18).
      return draft.command ? draft : issuedDepositDraft(ctx, o) ?? draft;
    }
    case 'stamp.return': {
      // 반납은 틀이 따로인 반납 확인 창(V1, template 'return'): 화면은 요약 창 대신 returnSheet로 번호 · 수량 · 보증금을 고르게 한다.
      // 돌려받을 것이 없으면 창 대신 한 줄(반납 완료 · 반납 불가 · 지급 대기). 다만 돌아온 권의 보증금이 남았으면(이어 보낸 반환이
      // 막혔음) V1이 보증금 반환만 한다.
      const draft = stockDraft(ctx, o, params, label('stamp.return'), (l) => (l.returnable ? l.issued - backCount(l) : 0),
        anyIssued(o) ? '반납 완료' : blockedMessage(stepOfRule(ctx, 'qty_returned') ?? { label: '반납' }, stepOfRule(ctx, 'qty_issued')),
        (picks) => ({ type: 'stock.direct_return', payload: { orderId: o.id, lines: lines(picks) } }));
      if (draft.command) return { ...draft, template: 'return' };
      const back = backHeldRefund(ctx.state, o);
      return back ? { ...draft, template: 'return', command: { type: 'stock.direct_return', payload: { orderId: o.id, lines: [] } } } : draft;
    }
    case 'stamp.load':
      return stockDraft(ctx, o, params, label('stamp.load'), (l) => (isVehiclePickup(o) ? l.qty - Math.max(l.loaded, l.issued) : 0),
        '적재 완료',
        (picks) => ({ type: 'stock.load', payload: { taskId: deliverTaskId(o), lines: lines(picks) } }));
    case 'stamp.pay':
    case 'pay': {
      const covered = coveredOrders(ctx.state, o);
      // 이 팀 몫: 스스로 낼 줄의 미수(다른 팀이 내기로 한 줄은 그 팀 몫). 스스로 낼 것이 없고 다른 팀이 내기로 한 돈만 남았으면 그 돈을
      // 지금 직접 낸다(예정 도장의 `직접 수납 · 60,000원`). 명령(payment.take)이 같은 셈으로 이 팀 몫의 줄만 채운다.
      const self = selfDue(o);
      const direct = self === 0 && covered.length === 0 ? ownDue(o) : 0;
      const own = self > 0 ? self : direct;
      const targets = [...(own > 0 ? [o] : []), ...covered];
      // 팀마다 이 수납에서 받을 몫: 이 팀은 위의 몫, 이 팀이 내기로 한 팀은 그 몫(줄 단위 결제 약속까지).
      const share = (t: FxOrder) => (t === o ? own : dueFor(t, o.id));
      const total = targets.reduce((sum, t) => sum + share(t), 0);
      const title = label('pay') + ' · ' + o.teamName + ' 팀';
      if (total === 0) return notice(ctx, title, '받을 금액 없음');
      const payer = promisedPayer(ctx.state, o);
      // 대신 내는 팀: 이 팀 미수와 다른 팀분 대납을 나눠 적고 합이 받을 금액(접수증 돈 줄 '미수 · 대납'과 같은 말).
      const summary = covered.length > 0
        ? [...(self > 0 ? ['미수 ' + won(self)] : []), ...covered.map((t) => t.teamName + ' 팀분 대납 ' + won(share(t))), '받을 금액 ' + won(total)]
        : payer && direct > 0
          ? [payer.teamName + ' 팀 결제 예정', '직접 결제 · ' + won(total)]
          : ['받을 금액 ' + won(total)];
      return {
        basis: head(ctx).basis,
        title,
        summary,
        // 창을 연 때 본 받을 금액: 명령과 함께 가고, 그사이 바뀌었으면 서버가 충돌로 돌려보낸다(sync 4-2).
        expect: { dueAmount: total },
        methods: [{ key: 'card', label: '카드' }, { key: 'cash', label: '현금' }, { key: 'transfer', label: '계좌이체' }],
        confirmLabel: label('stamp.pay') + ' · ' + won(total),
        command: {
          type: 'payment.take',
          payload: {
            orderIds: targets.map((t) => t.id), amount: total, methodKey: 'card', allocations: targets.map((t) => ({ orderId: t.id, amount: share(t) })),
            // 대신 내는 팀이면 결제 팀(그 팀이 내기로 한 몫만 채운다, group-pay.ts).
            ...(covered.length ? { payerOrderId: o.id } : {}),
          },
        },
      };
    }
    default:
      return notice(ctx, label(params.actionKey), '체험판 미지원');
  }
}

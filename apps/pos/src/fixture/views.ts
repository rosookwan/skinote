// FixtureClient의 읽기 모델 만들기(ui 7절의 서버 몫): 화면 설정(칸 · 탭 · 숫자)을 읽어 줄마다 칸 값을 만든다.
// 칸은 column_key가 아니라 그리기(renderer_key)와 연결(도장 단계의 rule_key · 동작)로 채운다: 설정에 도장 칸 · 장소 칸 ·
// 차량 칸을 더하면 여기를 고치지 않아도 나온다. 체험 자료에 없는 값(매장 속성 attribute, 뜻을 모르는 글 칸 text)은 칸 값을
// 만들지 않고, 화면은 빈칸으로 그린다(다른 칸의 값을 짐작해 넣지 않는다).
import {
  ACTION_LABELS, STAMP_RULE_SCOPE, resolveLedgerView, stampStepMap, statusTerm, visibleView,
  type ConfirmDraftParams, type ConfirmDraftView, type DeviceClassKey, type DisabledAction, type FindResult, type FitPart, type LedgerCell,
  type LedgerColumnRow, type LedgerRow, type LedgerTabRow, type LedgerViewResult, type MetricValue, type OrderSlip, type PinRow,
  type ResolvedLedgerView, type ReviewItem, type SlipLine, type StampCell, type StampStepRow, type UiConfig, type ViewParams,
} from '@skinote/contract';
import type { FxLine, FxOrder, FxState } from './model.ts';
import {
  anyIssued, backCount, collectDone, collectLeft, collectTaskId, coveredOrders, deliverTaskId, findOrder, isFinished, isVehiclePickup,
  isVehicleReturn, lastReturnSlotAt, LATE_AFTER_VEHICLE, moneyLateAt, nextDue, NIGHT_PREP_BEFORE, onVan, openPins, orderConditions, orderIdOfTask,
  othersDue, ownDue, paidTotal, pendingIssue, pendingReturn, placeLabel, placeShortLabel, routeOrders, slotKey, sortRoute, unitCount,
  vehicleLabel, VISIT_OUTCOMES, charged, type DueKind,
} from './rules.ts';
import { checklist, columnStamp, deliverLateAt, lineStamp, returnLateAt, stepStamp } from './stamps.ts';
import { dateTitle, dayWord, hm, iso, kstDate, when } from './time.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';

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

// ── 칸 값 ────────────────────────────────────────────────────────────

const DUE_WORD: Record<DueKind, string> = { pickup: '수령', deliver: '배달', return: '반납', pay: '수납' };

/**
 * 시각 칸: 시각(빠지지 않음, 아랫줄)과 윗줄 조각들 — 다른 날이면 날짜 말('내일', 좁아도 남음), 그 뒤에 종류('수령' · '반납',
 * 좁으면 먼저 빠짐). 날짜와 시각을 한 조각('내일 09:00')으로 두면 좁은 칸에서 낱말이 빠져 시각이 사라진다.
 */
function timeCell(ctx: ViewContext, o: FxOrder): LedgerCell {
  const due = nextDue(ctx.state, o);
  const at = due?.at ?? o.giveBack.at;
  const otherDay = kstDate(at) !== ctx.state.businessDate;
  return {
    renderer: 'time',
    at: iso(at),
    parts: [
      ...(otherDay ? [{ text: dayWord(at, ctx.state.businessDate), drop: 1 }] : []),
      { text: due ? DUE_WORD[due.kind] : '반납', drop: 2 },
      { text: hm(at), drop: 0 },
    ],
  };
}

function itemsOf(lines: readonly FxLine[]) {
  return lines.map((l) => ({ label: l.shortLabel, qty: l.qty, ...(l.unit ? { unit: l.unit } : {}) }));
}

/** 반납 약속: '22:00 설천 주차장 · 차량', '16:30 매장', '내일 09:00 솔마을 한솔동 · 차량'. */
function promiseParts(ctx: ViewContext, o: FxOrder): FitPart[] {
  const p = o.giveBack;
  const where = p.mode === 'store' ? '매장' : placeLabel(p.placeId);
  return [
    { text: when(p.at, ctx.state.businessDate) + ' ' + where, drop: 0, words: true },
    ...(p.mode === 'vehicle' ? [{ text: '차량', drop: 1 }] : []),
    ...(p.note ? [{ text: p.note, drop: 2 }] : []),
  ];
}

/**
 * 돈 칸. 미수는 늘 이 팀 몫이다. 다른 팀 몫까지 받을 팀은 합을 '받을 돈'으로 쓴다(미수 두 가지가 보이지 않게).
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
      alts: [unpaid + ' ' + won(due) + ' · 다른 팀 몫 ' + won(others), '받을 돈 ' + total, total],
      stacked: { over: '받을 돈', main: total },
      tone: 'ink',
      ...lateAt,
    };
  }
  return { renderer: 'money', alts: [unpaid + ' ' + won(due), won(due)], stacked: { over: unpaid, main: won(due) }, tone: 'ink', ...lateAt };
}

/** 장소 칸(반납 장소): 긴 이름 → 짧은 이름('설천' · '들국화') → 빼기. 매장 반납은 '매장'. */
function placeCell(o: FxOrder): LedgerCell {
  const p = o.giveBack;
  if (p.mode === 'store') return { renderer: 'place', parts: [{ text: '매장', drop: 0 }] };
  return { renderer: 'place', parts: [{ text: placeLabel(p.placeId), short: placeShortLabel(p.placeId), drop: 0, words: true }] };
}

/** 차량 칸: 차량 배달 · 수거가 있는 팀만. */
function vehicleCell(o: FxOrder): LedgerCell | null {
  const id = o.giveBack.vehicleId ?? o.pickup.vehicleId;
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
  unpaid: (_ctx, o) => ownDue(o) > 0 && !o.payerOrderId,
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

function nightPrep(ctx: ViewContext, orders: readonly FxOrder[]): LedgerViewResult['nightPrep'] {
  const slotAt = lastReturnSlotAt(ctx.state.businessDate);
  if (ctx.now < slotAt - NIGHT_PREP_BEFORE || ctx.now > slotAt) return undefined;
  const byPlace = new Map<string, number>();
  for (const o of orders) {
    if (!isVehicleReturn(o) || o.giveBack.at !== slotAt || !pendingReturn(o)) continue;
    byPlace.set(o.giveBack.placeId ?? '', (byPlace.get(o.giveBack.placeId ?? '') ?? 0) + 1);
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
  const after = ctx.now >= lastReturnSlotAt(ctx.state.businessDate);
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
  };
}

// ── 수거 목록(collection_list: 기사 태블릿 · 휴대폰 · 카운터) ───────────────────────────

const COLLECT_FILTERS: Partial<Record<LedgerTabRow['filter_key'], (o: FxOrder) => boolean>> = {
  all: () => true,
  remaining: (o) => !collectDone(o),
  collected: (o) => collectDone(o),
};

/** 기사 기기에서만 찍는 도장(받음 · 입고): 카운터가 누르면 창 대신 이 문장과 '접수증 열기'. */
const DRIVER_RULES: ReadonlySet<string> = new Set(['qty_collected', 'task_received']);

/**
 * 수거 목록의 도장 칸: 칸의 단계를 규칙으로 계산하고(받음 · 입고 · 반납 …), 보냄 대기로만 받은 업무는 점선.
 * 카운터(포스 판)에서 기사가 찍을 도장을 누르면 창 대신 한 문장(누가 찍는지)과 '접수증 열기'가 뜬다.
 */
function listStamp(ctx: ViewContext, o: FxOrder, column: LedgerColumnRow, counter: boolean, pending: boolean): StampCell {
  const all = steps(ctx);
  const cell = columnStamp(ctx.state, o, column.step_keys ?? [], all);
  const rule = all.get(cell.stepKey)?.rule_key;
  if (cell.state === 'done' && pending) {
    return {
      ...cell, pending: true,
      pressNote: { lines: [(cell.at ? hm(Date.parse(cell.at)) + '에 찍었습니다.' : '찍었습니다.'), '연결이 끊겨 보냄 대기에 있습니다. 연결되면 보냅니다.'] },
    };
  }
  if (counter && rule && DRIVER_RULES.has(rule) && (cell.state === 'todo' || cell.state === 'partial')) {
    return {
      ...cell,
      pressNote: {
        lines: [vehicleLabel(o.giveBack.vehicleId) + ' 기사가 받으면 찍힙니다.', '손님이 매장에 직접 가져왔으면 접수증에서 반납 도장을 찍습니다.'],
        action: { actionKey: 'open_slip', label: ACTION_LABELS.open_slip },
      },
    };
  }
  return cell;
}

/** 차에 있는 것: 품목별 합(받았지만 매장에 아직 내려놓지 않은 것). */
function loadItems(orders: readonly FxOrder[], qty: (l: FxLine) => number) {
  const byLabel = new Map<string, number>();
  for (const o of orders) for (const l of o.lines) if (qty(l) > 0) byLabel.set(l.shortLabel, (byLabel.get(l.shortLabel) ?? 0) + qty(l));
  return [...byLabel.entries()].map(([label, n]) => ({ label, qty: n }));
}

/**
 * 줄마다 지금 누를 수 없는 동작(회색)과 까닭. 순서 동작(▲ · ▼ · 맨 위로)은 보이는 목록의 같은 반납 타임 안에서, 빨리 확인으로
 * 고정된 줄은 옮길 수 없다(맨 위에 있다).
 */
function rowDisabled(o: FxOrder, position: { index: number; count: number } | null): DisabledAction[] {
  const out: DisabledAction[] = [];
  if (collectDone(o)) out.push({ actionKey: 'not_collected', reason: '이미 받았습니다.' });
  if (!o.phone) out.push({ actionKey: 'call', reason: '전화번호가 없습니다.' });
  if (position === null) {
    for (const actionKey of ['move_up', 'move_down', 'move_top'] as const) out.push({ actionKey, reason: '빨리 확인으로 고정된 줄은 옮기지 않습니다.' });
  } else {
    if (position.index === 0) out.push({ actionKey: 'move_up', reason: '맨 위 줄입니다.' }, { actionKey: 'move_top', reason: '맨 위 줄입니다.' });
    if (position.index === position.count - 1) out.push({ actionKey: 'move_down', reason: '맨 아래 줄입니다.' });
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
  const tasks = date === ctx.state.businessDate ? routeOrders(ctx.state, vehicleId, date) : [];
  const tabKey = v.tabs.some((t) => t.tab_key === params.tabKey) ? params.tabKey! : v.tabs[0]?.tab_key ?? 'all';
  const filterOf = (key: string) => COLLECT_FILTERS[v.tabs.find((t) => t.tab_key === key)?.filter_key ?? 'all'] ?? (() => true);
  const shown = sortRoute(ctx.state, tasks.filter(filterOf(tabKey)));
  const pinned = new Set(openPins(ctx.state).map((p) => p.orderId));
  const groups = [...new Map(shown.map((o) => [slotKey(o), o.giveBack.at] as const)).entries()].map(([key, at]) => {
    const inSlot = tasks.filter((o) => slotKey(o) === key);
    return { key, label: hm(at) + ' 반납', shortLabel: hm(at), at: iso(at), done: inSlot.filter(collectDone).length, total: inSlot.length };
  });
  const rows: LedgerRow[] = shown.map((o, i) => {
    const taskId = collectTaskId(o);
    const done = collectDone(o);
    const byShop = done && !o.lines.some((l) => l.collected > 0);
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
    const siblings = shown.filter((x) => slotKey(x) === slotKey(o) && !pinned.has(x.id));
    const position = pinned.has(o.id) ? null : { index: siblings.indexOf(o), count: siblings.length };
    const disabledActions = rowDisabled(o, position);
    return {
      id: taskId, orderId: o.id, taskId, groupKey: slotKey(o),
      subgroupLabel: placeLabel(o.giveBack.placeId), subgroupShortLabel: placeShortLabel(o.giveBack.placeId),
      rank: String(i).padStart(4, '0'), dueAt: iso(o.giveBack.at),
      // 차량 수거는 약속 60분 뒤부터 늦음(빨강). 받은 업무는 늦지 않다.
      ...(done ? {} : { lateAt: iso(o.giveBack.at + LATE_AFTER_VEHICLE) }),
      finished: false, cells,
      conditions: orderConditions(ctx.state, o),
      ...(disabledActions.length ? { disabledActions } : {}),
      ...(byShop ? { reviewNote: '매장에서 받음' } : {}),
    };
  });
  const onVanItems = loadItems(tasks, onVan);
  const doneCount = tasks.filter(collectDone).length;
  const pendingCount = tasks.filter((o) => pending.has(collectTaskId(o))).length;
  const metrics: MetricValue[] = v.metrics.flatMap((m): MetricValue[] => {
    switch (m.metric_key) {
      case 'collected_count': return [{ metricKey: m.metric_key, unit: 'count', value: doneCount - pendingCount }];
      case 'pending_count': return [{ metricKey: m.metric_key, unit: 'count', value: pendingCount }];
      case 'remaining_count': return [{ metricKey: m.metric_key, unit: 'count', value: tasks.length - doneCount }];
      case 'vehicle_load': return [{ metricKey: m.metric_key, unit: 'items', items: onVanItems }];
      default: return [];
    }
  });
  const inList = new Set(tasks.map((o) => o.id));
  const pins: PinRow[] = openPins(ctx.state).flatMap((p) => {
    const o = findOrder(ctx.state, p.orderId);
    if (!o || !inList.has(o.id)) return [];
    // 장소는 기사에게 가장 중요하다: 메모가 먼저 빠지고(시각은 화면이 그 다음에 뺀다), 장소는 짧은 이름('들국화')으로 줄었다가 마지막에 빠진다.
    return [{
      pinId: p.id, taskId: collectTaskId(o), orderId: o.id, at: iso(p.at), phone: o.phone, status: p.status,
      parts: [{ text: placeLabel(o.giveBack.placeId), short: placeShortLabel(o.giveBack.placeId), drop: 1 }, { text: o.teamName + ' · ' + o.last4, drop: 0 }, { text: p.note, drop: 3 }],
    }];
  });
  const vehicle = { id: vehicleId, label: vehicleLabel(vehicleId) };
  const byTask = tasks.flatMap((o) => {
    const items = itemsOf(o.lines.filter((l) => onVan(l) > 0).map((l) => ({ ...l, qty: onVan(l) })));
    return items.length ? [{ taskId: collectTaskId(o), teamName: o.teamName, last4: o.last4, items }] : [];
  });
  return {
    ...head(ctx),
    viewKey: 'collection_list',
    deviceClass,
    titleValues: { date, vehicle: vehicle.label },
    activeTabKey: tabKey,
    tabCounts: Object.fromEntries(v.tabs.map((t) => [t.tab_key, tasks.filter(filterOf(t.tab_key)).length])),
    groups,
    rows,
    metrics,
    activeConditions: [],
    primaryFigure: { count: tasks.reduce((sum, o) => sum + unitCount(o.lines, onVan), 0) },
    pins,
    vehicle,
    vehicleLoad: { vehicleId, vehicleLabel: vehicle.label, items: onVanItems, spareTickets: [], byTask },
    visitReasons: Object.entries(VISIT_OUTCOMES).map(([key, label]) => ({ key, label })),
  };
}

// ── 대여 접수증(order_slip) ─────────────────────────────────────────────

const CHANNEL_LABEL = { phone: '전화 예약', walk_in: '현장 방문' } as const;
const METHOD_LABEL = { card: '카드', cash: '현금', transfer: '계좌이체' } as const;

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
        const cell = lineStamp(o, l, step, all, ctx.state.businessDate);
        // 이 줄에 해당 없는 단계(리프트권의 반납)는 '—', 이 접수에 아예 없는 단계(매장 수령의 적재)는 칸 값 없음.
        if (cell) cells[column.column_key] = { renderer: 'stamp', stamp: cell };
        else if (o.lines.some((x) => lineStamp(o, x, step, all, ctx.state.businessDate))) cells[column.column_key] = { renderer: 'stamp', stamp: { stepKey: step.key, state: 'na' } };
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
  const { items, next } = checklist(ctx.state, o, all, slipSteps, today);
  const payer = findOrder(ctx.state, o.payerOrderId);
  const due = ownDue(o);
  const others = othersDue(ctx.state, o);
  const late = moneyLateAt(ctx.state, o);
  const pin = openPins(ctx.state).find((p) => p.orderId === o.id);
  const promiseLine = (kind: 'pickup' | 'return') => {
    const p = kind === 'pickup' ? o.pickup : o.giveBack;
    const lateAt = kind === 'pickup' ? deliverLateAt(o) : returnLateAt(o);
    return {
      kind,
      at: iso(p.at),
      ...(lateAt !== undefined ? { lateAt: iso(lateAt) } : {}),
      parts: [
        { text: p.mode === 'store' ? '매장' : placeLabel(p.placeId), drop: 1 },
        ...(p.mode === 'vehicle' ? [{ text: vehicleLabel(p.vehicleId), drop: 2 }] : []),
        ...(p.note ? [{ text: p.note, drop: 3 }] : []),
        ...(kind === 'return' && pin ? [{ text: pin.status === 'acknowledged' ? '빨리 확인 · 기사 확인' : '빨리 확인 보냄', drop: 4 }] : []),
      ],
    };
  };
  const orderStamps = [...all.values()].filter((s) => STAMP_RULE_SCOPE[s.rule_key] === 'order').map((s) => stepStamp(ctx.state, o, s, all)).filter((c) => c.state !== 'na');
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
      { key: 'phone', label: '연락처', value: o.phone, drop: 0 },
      { key: 'party', label: '인원', value: o.party + '명', drop: 1 },
    ],
    lines: o.lines.map((l) => slipLine(ctx, o, l, v.columns)),
    promises: { distinct: 1, lines: [promiseLine('pickup'), promiseLine('return')] },
    money: {
      charged: charged(o),
      paid: paidTotal(o),
      due,
      payments: o.payments.map((p) => ({ amount: p.amount, methodLabel: METHOD_LABEL[p.methodKey], date: kstDate(p.at) })),
      ...(payer && due > 0 ? { promisedBy: { teamName: payer.teamName + ' 팀', amount: due } } : {}),
      ...(others > 0 ? { collectForOthers: others, collectTotal: due + others } : {}),
      ...(late !== undefined ? { lateAt: iso(late) } : {}),
    },
    orderStamps,
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
        message: o.teamName + ' 팀 반납이 늦었습니다 · ' + when(due.at, ctx.state.businessDate) + ' ' + (o.giveBack.mode === 'store' ? '매장' : placeLabel(o.giveBack.placeId)),
      });
    }
  }
  for (const p of openPins(ctx.state)) {
    const o = findOrder(ctx.state, p.orderId);
    if (!o || p.status === 'acknowledged') continue;
    out.push({
      id: 'pin:' + p.id, kindKey: 'pin', severity: 'info', createdAt: iso(p.at), orderId: o.id,
      message: o.teamName + ' 팀 ' + p.note + ' · ' + hm(p.at) + ' ' + placeLabel(o.giveBack.placeId) + ' · 기사에게 빨리 확인으로 알림',
    });
  }
  for (const o of ctx.state.orders) {
    const visit = o.visits?.at(-1);
    if (!visit || collectDone(o)) continue;
    out.push({
      id: 'visit:' + o.id + ':' + visit.at, kindKey: 'visit_result', severity: 'info', createdAt: iso(visit.at), orderId: o.id,
      message: o.teamName + ' 팀 ' + VISIT_OUTCOMES[visit.outcomeKey] + (visit.retryAt !== undefined ? ' · ' + when(visit.retryAt, ctx.state.businessDate) + '에 다시 감' : ''),
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
  closing: string,
  emptyMessage: string,
  build: (picks: Pick[]) => ConfirmDraftView['command'],
): ConfirmDraftView {
  const scope = params.lineIds?.length ? o.lines.filter((l) => params.lineIds!.includes(l.id)) : o.lines;
  const picks = scope.map((l) => ({ l, qty: left(l) })).filter((x) => x.qty > 0);
  const title = actionLabel + ' · ' + o.teamName + ' 팀';
  if (picks.length === 0) return notice(ctx, title, emptyMessage);
  const single = params.lineIds?.length === 1 && picks.length === 1 ? picks[0]! : null;
  const base = { basis: head(ctx).basis, title, command: build(picks) };
  if (single) {
    return {
      ...base,
      summary: [single.l.label + ' · 남은 ' + single.qty + unitWord(single.l), closing],
      quantity: { value: single.qty, min: 1, max: single.qty, unit: unitWord(single.l) },
      confirmLabel: actionLabel + ' 찍기',
    };
  }
  return { ...base, summary: [itemLine(picks), closing], confirmLabel: actionLabel + ' 찍기 · ' + countWords(picks) };
}

/** 매장 입고(차량 단위): 차에 있는 것을 모두 매장으로. 연결이 있어야 한다(sync 8-4). */
function receiveDraft(ctx: ViewContext, vehicleId: string): ConfirmDraftView {
  const tasks = routeOrders(ctx.state, vehicleId, ctx.state.businessDate).filter((o) => o.lines.some((l) => onVan(l) > 0));
  const title = ACTION_LABELS.receive_to_shop + ' · ' + vehicleLabel(vehicleId);
  if (tasks.length === 0) return notice(ctx, title, '차에 받은 것이 없습니다.');
  const items = loadItems(tasks, onVan);
  const units = tasks.reduce((sum, o) => sum + unitCount(o.lines, onVan), 0);
  return {
    basis: head(ctx).basis,
    title,
    summary: [items.map((it) => it.label + ' ' + it.qty).join(' · '), tasks.length + '팀 것을 매장에 내려놓았으면 입고합니다.'],
    confirmLabel: ACTION_LABELS.receive_to_shop + ' · ' + units + '개',
    command: { type: 'stock.receive', payload: { vehicleId, taskIds: tasks.map(collectTaskId) } },
  };
}

/** 시간순 되돌리기(차량 · 날짜 단위): 직접 바꾼 방문 순서를 모두 지운다. 목록 전체가 바뀌므로 확인 창을 거친다. */
function routeResetDraft(ctx: ViewContext, vehicleId: string): ConfirmDraftView {
  const title = ACTION_LABELS.route_reset + ' · ' + vehicleLabel(vehicleId);
  const moved = routeOrders(ctx.state, vehicleId, ctx.state.businessDate).filter((o) => collectTaskId(o) in ctx.state.routeRanks);
  if (moved.length === 0) return notice(ctx, title, '이미 약속 시각 순서입니다.');
  return {
    basis: head(ctx).basis,
    title,
    summary: ['직접 바꾼 방문 순서를 모두 지우고 약속 시각 순서로 되돌립니다.', '빨리 확인으로 고정한 줄은 그대로 맨 위에 있습니다.'],
    confirmLabel: '되돌리기',
    command: { type: 'route.reset', payload: { vehicleId, date: ctx.state.businessDate } },
  };
}

export function confirmDraft(ctx: ViewContext, params: ConfirmDraftParams): ConfirmDraftView {
  if (params.actionKey === 'receive_to_shop') return receiveDraft(ctx, params.vehicleId ?? 'v1');
  if (params.actionKey === 'route_reset') return routeResetDraft(ctx, params.vehicleId ?? 'v1');
  if (params.actionKey === 'print') {
    return notice(ctx, ACTION_LABELS.print, params.vehicleId
      ? '수거 목록 인쇄는 아직 만드는 중입니다. 팀마다 한 줄씩 종이 한 장에 인쇄합니다.'
      : '접수증 인쇄는 아직 만드는 중입니다.');
  }
  const o = findOrder(ctx.state, params.orderId ?? (params.taskId ? orderIdOfTask(params.taskId) : undefined));
  if (!o) return notice(ctx, '확인', '이 접수를 찾을 수 없습니다.');
  const label = (key: keyof typeof ACTION_LABELS) => ACTION_LABELS[key];
  const lines = (picks: Pick[]) => picks.map(({ l, qty }) => ({ lineId: l.id, quantity: qty }));
  switch (params.actionKey) {
    case 'stamp.collect':
      return stockDraft(ctx, o, params, label('stamp.collect'), collectLeft, vehicleLabel(o.giveBack.vehicleId) + '에 실었으면 도장을 찍습니다.',
        collectDone(o) ? '이미 모두 받았습니다.' : '받을 것이 없습니다.',
        (picks) => ({ type: 'stock.collect', payload: { taskId: collectTaskId(o), lines: lines(picks) } }));
    case 'pin': {
      const title = label('pin') + ' · ' + o.teamName + ' 팀';
      if (!isVehicleReturn(o) || !anyIssued(o) || collectDone(o)) return notice(ctx, title, '차량이 받을 반납이 없습니다.');
      if (kstDate(o.giveBack.at) !== ctx.state.businessDate) return notice(ctx, title, when(o.giveBack.at, ctx.state.businessDate) + ' 수거라 오늘 수거 목록에 없습니다.');
      const open = openPins(ctx.state).find((p) => p.orderId === o.id);
      if (open) return notice(ctx, title, open.status === 'acknowledged' ? '이미 보냈고 기사가 확인했습니다.' : '이미 보냈습니다. 기사 확인을 기다립니다.');
      const note = o.giveBack.note ?? '매장 요청';
      return {
        basis: head(ctx).basis,
        title,
        summary: [
          hm(o.giveBack.at) + ' ' + placeLabel(o.giveBack.placeId) + ' · ' + o.teamName + ' · ' + o.last4 + ' · ' + note,
          vehicleLabel(o.giveBack.vehicleId) + ' 수거 목록 맨 위에 고정하고 기사에게 알립니다.',
        ],
        confirmLabel: label('pin') + ' 보내기',
        command: { type: 'task.pin', payload: { taskId: collectTaskId(o), note } },
      };
    }
    case 'stamp.issue':
      return stockDraft(ctx, o, params, label('stamp.issue'), (l) => l.qty - l.issued, '손님께 드렸으면 도장을 찍습니다.', '이미 모두 지급했습니다.',
        (picks) => ({ type: 'stock.issue', payload: { orderId: o.id, lines: lines(picks) } }));
    case 'stamp.return':
      return stockDraft(ctx, o, params, label('stamp.return'), (l) => (l.returnable ? l.issued - backCount(l) : 0), '매장에서 돌려받았으면 도장을 찍습니다.',
        anyIssued(o) ? '이미 모두 반납했습니다.' : '지급을 먼저 해야 반납할 수 있습니다.',
        (picks) => ({ type: 'stock.direct_return', payload: { orderId: o.id, lines: lines(picks) } }));
    case 'stamp.load':
      return stockDraft(ctx, o, params, label('stamp.load'), (l) => (isVehiclePickup(o) ? l.qty - Math.max(l.loaded, l.issued) : 0),
        vehicleLabel(o.pickup.vehicleId) + '에 실었으면 도장을 찍습니다.', '이미 모두 실었습니다.',
        (picks) => ({ type: 'stock.load', payload: { taskId: deliverTaskId(o), lines: lines(picks) } }));
    case 'stamp.pay':
    case 'pay': {
      const covered = coveredOrders(ctx.state, o);
      const targets = [...(ownDue(o) > 0 ? [o] : []), ...covered];
      const total = targets.reduce((sum, t) => sum + ownDue(t), 0);
      const title = label('pay') + ' · ' + o.teamName + ' 팀';
      if (total === 0) return notice(ctx, title, '받을 돈이 없습니다.');
      const payer = findOrder(ctx.state, o.payerOrderId);
      const summary = covered.length > 0
        ? [...targets.map((t) => t.teamName + ' 팀 ' + won(ownDue(t))), '받을 돈 ' + won(total)]
        : payer
          ? [payer.teamName + ' 팀이 내기로 했습니다.', '지금 이 팀이 ' + won(total) + '을 냅니다.']
          : ['받을 돈 ' + won(total)];
      return {
        basis: head(ctx).basis,
        title,
        summary,
        // 창을 연 때 본 받을 돈: 명령과 함께 가고, 그사이 바뀌었으면 서버가 충돌로 돌려보낸다(sync 4-2).
        expect: { dueAmount: total },
        methods: [{ key: 'card', label: '카드' }, { key: 'cash', label: '현금' }, { key: 'transfer', label: '계좌이체' }],
        confirmLabel: label('stamp.pay') + ' 찍기 · ' + won(total),
        command: {
          type: 'payment.take',
          payload: { orderIds: targets.map((t) => t.id), amount: total, methodKey: 'card', allocations: targets.map((t) => ({ orderId: t.id, amount: ownDue(t) })) },
        },
      };
    }
    default:
      return notice(ctx, label(params.actionKey), '체험 자료에서는 아직 할 수 없는 일입니다.');
  }
}

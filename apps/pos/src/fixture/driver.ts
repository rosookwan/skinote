// 기사 기기의 배달 · 업무 판(V7, spec 3-8 · ui 6-5)의 체험 셈(서버 몫): 배달 업무(차량 배달 접수 하나 = 업무 하나, 'deliver:<접수>'),
// 업무 판 읽기 모델(taskSheet: 배달 · 수거), 현장 수납 판(fieldPaySheet → field.collect), 리프트권 추가 판(addTicketSheet →
// field.add_ticket), 수거 현장의 권 보증금 반환(field.deposit_return), 현장 수납 판의 후불 처리(payment_promise.set).
// 기사 명령(배달 · 현장 수납 · 리프트권 추가 · 보증금 반환)은 오프라인에서도 되는 사실이다(sync 8-2): 보냄 대기로 온 명령(deviceSeq가 있음)의
// 돈의 바탕(expect)은 참고 값이라 달라도 돌려보내지 않는다(8-12). 화면은 이 셈을 모른다(읽기 모델만). LocalClient가 오면 폴더째 없어진다.
// 이 파일은 views.ts를 가져오지 않는다(views.ts가 이 파일의 배달 업무 · 보증금 줄을 쓴다).
import {
  ACTION_LABELS, DomainError, stampStepMap, type AddTicketSheetParams, type AddTicketSheetView, type ChoiceOption, type CommandEnvelope, type ConfirmStep,
  type FieldPaySheetParams, type FieldPaySheetView, type LedgerCell, type RichText, type StampCell, type StampStepRow, type TaskSheetAction,
  type TaskSheetParams, type TaskSheetView, type TextRun,
} from '@skinote/contract';
import { heldNumbers } from './assets.ts';
import { PAY_SECTIONS, payMethodOf, productOf } from './catalog.ts';
import { depositOf, heldAmount, heldRule, heldUnits, orderDepositHeld, planRefunds } from './deposits.ts';
import type { FxDeposit, FxLine, FxMethodKey, FxOrder, FxPromise, FxState } from './model.ts';
import { bucketOut, currentReturn, findTask, taskBucket, taskOrder, type FxTask } from './promises.ts';
import { conflict, done, nothing, rejected, type Result } from './result.ts';
import {
  backCount, bizDay, collectDone, collectLeft, deliverTaskId, fillLines, findOrder, isDeliverTaskId, isVehiclePickup, moneyLateAt, orderIdOfTask, ownDue,
  listTasks, pendingIssue, placeLabel, promisedPayer, routeTasks, selfDue, selfLines, vehicleLabel, visitReasons,
} from './rules.ts';
import { liftReturnable } from './seed.ts';
import { DELIVER_WORD, driverLineStamp, figureOf, lineStamp } from './stamps.ts';
import { bizHm, businessDateOf, dayWord, hm, iso, onBizDay, when, shopCutoff } from './time.ts';
import type { ViewContext } from './views.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';

// ── 배달 업무 ────────────────────────────────────────────────────────

/** 차량 배달 업무 하나: 차량 배달 접수(수령 일정이 차량)의 배달. id 'deliver:<접수>'. */
export interface FxDeliverTask {
  id: string;
  order: FxOrder;
  promise: FxPromise;
}

/** 이 차량 · 영업일의 배달 업무(배달 시각 → 접수 번호 차례). */
export function deliverTasks(state: FxState, vehicleId: string, date: string): FxDeliverTask[] {
  const day = { date, cutoff: shopCutoff(state.settings) };
  return state.orders
    .filter((o) => isVehiclePickup(o) && o.pickup.vehicleId === vehicleId && onBizDay(o.pickup.at, day))
    .map((o) => ({ id: deliverTaskId(o), order: o, promise: o.pickup }))
    .sort((a, b) => a.promise.at - b.promise.at || a.order.receiptNo.localeCompare(b.order.receiptNo));
}

export function findDeliverTask(state: FxState, taskId: string): FxDeliverTask | undefined {
  if (!isDeliverTaskId(taskId)) return undefined;
  const o = findOrder(state, orderIdOfTask(taskId));
  return o && isVehiclePickup(o) ? { id: taskId, order: o, promise: o.pickup } : undefined;
}

/** 배달이 끝났는지(모두 건넴). */
export const deliverDone = (o: FxOrder) => !pendingIssue(o);
/** 차에 실려 아직 건네지 않은 수. */
export const onVanToDeliver = (l: FxLine) => Math.max(l.loaded, l.issued) - l.issued;
/** 아직 싣지 않은 수. */
const toLoad = (l: FxLine) => l.qty - Math.max(l.loaded, l.issued);

/** 업무 판이 그리는 업무(배달 · 수거). view는 그 업무의 몫만 비춘 접수(수거는 taskOrder, 배달은 접수 그대로). */
export type FxAnyTask =
  | { kind: 'deliver'; id: string; order: FxOrder; promise: FxPromise; view: FxOrder }
  | { kind: 'collect'; id: string; order: FxOrder; promise: FxPromise; view: FxOrder; task: FxTask };

export function resolveTask(state: FxState, taskId: string): FxAnyTask | undefined {
  const d = findDeliverTask(state, taskId);
  if (d) return { kind: 'deliver', id: d.id, order: d.order, promise: d.promise, view: d.order };
  const c = findTask(state, taskId);
  return c ? { kind: 'collect', id: c.id, order: c.order, promise: c.promise, view: taskOrder(c), task: c } : undefined;
}

/** 업무의 차량(없으면 1호 차량). */
const vehicleOf = (t: FxAnyTask) => t.promise.vehicleId ?? 'v1';
/** 차량 지갑(현장 수납 · 현장 보증금의 현금이 드는 돈통). */
const vanDrawer = (vehicleId: string) => 'van:' + vehicleId;

// ── 차량 예비권 ──────────────────────────────────────────────────────

const noOf = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1)) || 0;

/** 차량 예비권(차량에 실린 권, 아직 손님에게 가지 않은 번호): 상품마다 번호 차례. 리프트권 상품만. */
export function spareTickets(state: FxState, vehicleId: string): { productKey: string; ids: string[] }[] {
  const held = new Set(state.orders.flatMap((o) => o.lines.flatMap((l) => heldNumbers(l))));
  const byProduct = new Map<string, string[]>();
  for (const a of state.assets) {
    if (a.vehicleId !== vehicleId || held.has(a.id) || productOf(a.kind)?.section !== 'lift') continue;
    byProduct.set(a.kind, [...(byProduct.get(a.kind) ?? []), a.id]);
  }
  return [...byProduct.entries()].map(([productKey, ids]) => ({ productKey, ids: ids.sort((x, y) => noOf(x) - noOf(y)) }));
}

/** 리프트권 추가 버튼의 둘째 줄: 권종 하나면 `야간권 재고 6매`, 둘 이상이면 `예비권 재고 9매`(spec 3-8). 없으면 없음. */
function spareLine(spare: { productKey: string; ids: string[] }[]): string | undefined {
  const total = spare.reduce((n, s) => n + s.ids.length, 0);
  if (total === 0) return undefined;
  const only = spare.length === 1 ? productOf(spare[0]!.productKey) : undefined;
  return (only ? only.shortLabel ?? only.label : '예비권') + ' 재고 ' + total + (only?.unit ?? '매');
}

// ── 돈 ─────────────────────────────────────────────────────────────

/** 기사가 받을 돈: 이 팀이 스스로 낼 미수(다른 팀이 내기로 한 줄은 그 팀이 낸다). */
export function fieldDue(_state: FxState, o: FxOrder): number {
  return selfDue(o);
}

/** 기사가 받을 수 있는 수단(payment_methods.driver_allowed, 빠른 수단 ≤ 3): 카드 · 현금 · 계좌이체. 처음은 현금. */
export const DRIVER_METHODS: readonly FxMethodKey[] = ['card', 'cash', 'transfer'];
const DRIVER_DEFAULT_METHOD: FxMethodKey = 'cash';

const METHOD_WORD: Record<string, string> = { card: '카드', cash: '현금', transfer: '계좌이체', easy_pay: '간편결제', voucher: '상품권' };

/** '6개 · 3매'(주 버튼의 수). */
export function figureWords(lines: readonly FxLine[], qty: (l: FxLine) => number): string {
  const f = figureOf(lines, qty);
  return [...((f?.count ?? 0) > 0 ? [f!.count + '개'] : []), ...(f?.units ?? []).map((u) => u.qty + u.unit)].join(' · ');
}

/** 권(리프트권) 줄의 단위 이름('매'). */
const unitOf = (lines: readonly FxLine[]) => lines.find((l) => l.unit)?.unit ?? '매';

/** 보증금 보관의 권 매수(줄마다 보관 매수의 합). */
function heldTicketUnits(dep: FxDeposit | undefined, lines: readonly FxLine[]): number {
  return lines.reduce((n, l) => n + Math.max(0, heldUnits(dep, l.id)), 0);
}

// ── 업무 판(taskSheet) ─────────────────────────────────────────────────

const steps = (ctx: ViewContext) => stampStepMap(ctx.config.stampSteps, ctx.config.features);
const stepOfRule = (all: ReadonlyMap<string, StampStepRow>, rule: StampStepRow['rule_key']) => [...all.values()].find((s) => s.rule_key === rule);

/** 전송 대기로만 받은 업무의 끝난 도장은 점선(sync 8-1). */
const pendingCell = (cell: StampCell, pending: boolean): StampCell => (pending && cell.state === 'done' ? { ...cell, pending: true } : cell);

/** 돈 줄의 마지막 수납 조각(`12/25 계좌이체 수납`, 오늘이면 `16:58 현금 수납`). 보증금 결제는 수단이 아니라 빼고 센다. */
function lastPayment(state: FxState, o: FxOrder): string | undefined {
  const last = [...o.payments].filter((p) => p.methodKey !== 'deposit').sort((a, b) => a.at - b.at).at(-1);
  if (!last) return undefined;
  const date = businessDateOf(last.at, shopCutoff(state.settings));
  const [, m = '1', d = '1'] = date.split('-');
  const at = date === state.businessDate ? hm(last.at) : Number(m) + '/' + Number(d);
  return at + ' ' + (METHOD_WORD[last.methodKey] ?? '') + ' 수납';
}

/**
 * 돈 줄(설정 driver_sees_due_amount): 첫 줄 `미수 없음`(초록) · 마지막 수납 · 맡은 보증금(`보증금 · 권 1매 5,000원`), 수거 업무에서 돌아올
 * 권의 보증금이 있으면 둘째 줄 `권 1매 보증금 5,000원 반환`. 다른 팀이 낼 팀은 파란 `이정호 팀 결제 예정`. 늦은 미수만 빨강.
 */
function moneyLines(ctx: ViewContext, t: FxAnyTask): RichText[] | undefined {
  const { state } = ctx;
  if (!state.settings.driverSeesDue) return undefined;
  const o = t.order;
  const due = fieldDue(state, o);
  const payer = promisedPayer(state, o);
  const first: TextRun[] = [];
  if (payer && due === 0 && ownDue(o) > 0) first.push({ text: payer.teamName + ' 팀 결제 예정', strong: true, tone: 'blue' });
  else if (due > 0) {
    const late = moneyLateAt(state, o);
    first.push({ text: '미수 ' + won(due), strong: true, ...(late !== undefined && late <= ctx.now ? { tone: 'red' as const } : {}) });
  } else first.push({ text: '미수 없음', strong: true, tone: 'green' });
  const paid = lastPayment(state, o);
  if (paid) first.push({ text: ' · ' + paid });
  const rule = heldRule(state);
  const dep = rule ? depositOf(state, o.id, rule.key) : undefined;
  const held = orderDepositHeld(state, o);
  if (held > 0) {
    const tickets = o.lines.filter((l) => heldUnits(dep, l.id) > 0);
    first.push({ text: ' · 보증금 · 권 ' + heldTicketUnits(dep, tickets) + unitOf(tickets) + ' ' + won(held) });
  }
  const out: RichText[] = [first];
  if (t.kind === 'collect' && dep) {
    const refund = collectRefund(t, dep);
    if (refund) out.push([{ text: '권 ' + refund.units + refund.unit + ' 보증금 ' + won(refund.amount) + ' 반환' }]);
  }
  return out;
}

/** 수거 업무에서 돌아올 권의 보증금(줄마다 수거할 수와 보관 매수 중 작은 것). */
function collectRefund(t: Extract<FxAnyTask, { kind: 'collect' }>, dep: FxDeposit): { units: number; unit: string; amount: number; lines: { lineId: string; quantity: number }[] } | null {
  const lines = t.order.lines.flatMap((l) => {
    const b = l.returnable ? taskBucket(t.task, l) : undefined;
    const units = b ? Math.min(bucketOut(b), Math.max(0, heldUnits(dep, l.id))) : 0;
    return units > 0 ? [{ l, units }] : [];
  });
  const units = lines.reduce((n, x) => n + x.units, 0);
  if (units === 0) return null;
  return { units, unit: unitOf(lines.map((x) => x.l)), amount: units * dep.unitAmount, lines: lines.map((x) => ({ lineId: x.l.id, quantity: x.units })) };
}

/** 반납 일정(배달 판만): `오늘 22:10 · 만선 티롤 앞 · 1호 차량`, 권이 있으면 `권 1매 포함 · 보증금 5,000원 반환`. */
function returnPlan(state: FxState, o: FxOrder): string[] {
  const p = currentReturn(o);
  const today = bizDay(state);
  const where = p.mode === 'store' ? '매장' : placeLabel(p.placeId);
  const first = [dayWord(p.at, today.date, today.cutoff) + ' ' + bizHm(p.at, today.cutoff), where, ...(p.mode === 'vehicle' ? [vehicleLabel(p.vehicleId)] : [])].join(' · ');
  const tickets = o.lines.filter((l) => l.returnable && l.section === 'lift' && l.qty - backCount(l) > 0);
  const units = tickets.reduce((n, l) => n + l.qty - backCount(l), 0);
  if (units === 0) return [first];
  const rule = heldRule(state);
  const dep = rule ? depositOf(state, o.id, rule.key) : undefined;
  const heldAmt = dep ? heldTicketUnits(dep, tickets) * dep.unitAmount : 0;
  return [first, '권 ' + units + unitOf(tickets) + ' 포함' + (heldAmt > 0 ? ' · 보증금 ' + won(heldAmt) + ' 반환' : '')];
}

/** 업무 판(V7): 배달 · 수거 한 팀. */
export function taskSheet(ctx: ViewContext, params: TaskSheetParams): TaskSheetView {
  const { state } = ctx;
  const t = resolveTask(state, params.taskId);
  if (!t) throw new DomainError('NOT_FOUND', '없는 업무: ' + params.taskId);
  const all = steps(ctx);
  const today = bizDay(state);
  const o = t.order;
  const x = t.view;
  const vehicleId = vehicleOf(t);
  const pending = ctx.pendingTasks?.has(t.id) ?? false;
  const loadStep = stepOfRule(all, 'qty_loaded');
  const issueStep = stepOfRule(all, 'qty_issued');
  const collectStep = stepOfRule(all, 'qty_collected');
  const deliver = t.kind === 'deliver';
  const kindWord = deliver ? DELIVER_WORD : collectStep?.label ?? '';
  const place = t.promise.mode === 'store' ? '매장' : placeLabel(t.promise.placeId);

  const stampColumns: { key: string; label: string; step: StampStepRow | undefined; driver: boolean }[] = deliver
    ? [{ key: 'load', label: loadStep?.label ?? '', step: loadStep, driver: false }, { key: 'deliver', label: DELIVER_WORD, step: issueStep, driver: true }]
    : [{ key: 'collect', label: collectStep?.label ?? '', step: collectStep, driver: false }];
  const shownLines = deliver ? x.lines : x.lines.filter((l) => l.returnable);
  const lines = shownLines.map((l) => {
    const cells: Record<string, LedgerCell> = {};
    for (const c of stampColumns) {
      if (!c.step) continue;
      const cell = (c.driver ? driverLineStamp : lineStamp)(x, l, c.step, all, today);
      if (cell) cells[c.key] = { renderer: 'stamp', stamp: pendingCell(cell, pending && c.key !== 'load') };
    }
    return { lineId: l.id, label: l.label, qtyText: l.qty + (l.countWord ?? l.unit ?? '개'), cells };
  });

  const finished = deliver ? deliverDone(o) : collectDone(x);
  const spare = spareTickets(state, vehicleId);
  const spareText = spareLine(spare);
  const failKey = deliver ? 'not_delivered' : 'not_collected';
  const doneWord = kindWord + ' 완료';
  const actions: TaskSheetAction[] = [
    { actionKey: 'field_collect', label: ACTION_LABELS.field_collect, enabled: true },
    spareText
      ? { actionKey: 'add_ticket', label: ACTION_LABELS.add_ticket, secondLine: spareText, enabled: true }
      : { actionKey: 'add_ticket', label: ACTION_LABELS.add_ticket, secondLine: '차량 권 재고 없음', enabled: false, reason: '차량 권 재고 없음' },
    { actionKey: failKey, label: ACTION_LABELS[failKey], enabled: !finished, ...(finished ? { reason: doneWord } : {}) },
    { actionKey: 'call', label: ACTION_LABELS.call, enabled: o.phone !== '', ...(o.phone ? {} : { reason: '전화번호 없음' }) },
  ];

  // 바닥줄 가운데: 이 차량 · 영업일 목록의 완료 · 잔여(전송 대기로만 끝난 업무는 완료에 세지 않음, 목록 바닥줄과 같은 셈), 이 업무가 끝났으면
  // `배달 완료 · 16:57` · `수거 완료 · 22:00`.
  let progress: string;
  if (finished) {
    const at = Math.max(...x.lines.map((l) => (deliver ? l.issuedAt : l.collectedAt) ?? 0));
    progress = at > 0 ? doneWord + ' · ' + hm(at) : doneWord;
  } else {
    const list = deliver
      ? deliverTasks(state, vehicleId, state.businessDate).map((d) => ({ id: d.id, done: deliverDone(d.order) }))
      : listTasks(state, vehicleId, state.businessDate).map((c) => ({ id: c.id, done: collectDone(taskOrder(c)) }));
    const doneCount = list.filter((d) => d.done && !ctx.pendingTasks?.has(d.id)).length;
    progress = '완료 ' + doneCount + ' · 잔여 ' + list.filter((d) => !d.done).length;
  }

  // 보라 주 버튼 하나: 배달은 실은 것이 있으면 `배달 처리 · 6개`, 아직 싣지 않았으면 `적재 처리 · 6개`(매장에서), 모두 건넸으면 누를 수 없음.
  // 수거는 `수거 처리 · 6개`(권이 있으면 `· 1매`).
  let primary: TaskSheetView['primary'];
  if (deliver) {
    const ready = figureWords(o.lines, onVanToDeliver);
    const load = figureWords(o.lines, toLoad);
    const deliverName = DELIVER_WORD + ' 처리';
    if (ready) primary = { label: deliverName + ' · ' + ready, alts: [deliverName + ' · ' + ready, deliverName], enabled: true, actionKey: 'stamp.issue' };
    else if (load && pendingIssue(o)) primary = { label: ACTION_LABELS['stamp.load'] + ' · ' + load, alts: [ACTION_LABELS['stamp.load'] + ' · ' + load, ACTION_LABELS['stamp.load']], enabled: true, actionKey: 'stamp.load' };
    else primary = { label: deliverName, alts: [deliverName], enabled: false, actionKey: 'stamp.issue' };
  } else {
    const left = figureWords(x.lines, collectLeft);
    const name = ACTION_LABELS['stamp.collect'];
    primary = left ? { label: name + ' · ' + left, alts: [name + ' · ' + left, name], enabled: true, actionKey: 'stamp.collect' } : { label: name, alts: [name], enabled: false, actionKey: 'stamp.collect' };
  }
  const money = moneyLines(ctx, t);
  return {
    basis: { epoch: state.epoch, rev: state.rev },
    serverTime: iso(ctx.now),
    currentBusinessDate: state.businessDate,
    taskId: t.id,
    orderId: o.id,
    kind: t.kind,
    title: kindWord + ' · ' + when(t.promise.at, today.date, today.cutoff) + ' ' + place,
    team: o.teamName + ' · ' + o.last4,
    teamName: o.teamName,
    last4: o.last4,
    contact: [o.phone, o.party > 0 ? o.party + '명' : ''].filter(Boolean).join(' · '),
    ...(o.phone ? { phone: o.phone } : {}),
    columns: [{ key: 'item', label: '품목' }, { key: 'qty', label: '수량' }, ...stampColumns.map((c) => ({ key: c.key, label: c.label }))],
    lines,
    ...(money ? { money } : {}),
    actions,
    ...(deliver ? { returnPlan: returnPlan(state, o) } : {}),
    progress,
    primary,
    visitReasons: visitReasons(t.kind),
    vehicle: { id: vehicleId, label: vehicleLabel(vehicleId) },
  };
}

// ── 현장 수납 판(fieldPaySheet) ───────────────────────────────────────────

export function fieldPaySheet(ctx: ViewContext, params: FieldPaySheetParams): FieldPaySheetView {
  const { state } = ctx;
  const t = resolveTask(state, params.taskId);
  if (!t) throw new DomainError('NOT_FOUND', '없는 업무: ' + params.taskId);
  const o = t.order;
  // 리프트권 추가에 이어 연 판(afterTicket): 권 값과 방금 받은 권 보증금(현금)을 합한 손에 받을 돈을 한 줄로(V4 받을 금액 줄과 같은 모양).
  // 끊긴 기사 기기에서도 같다: 기기의 읽기 모델은 전송 대기 명령을 겹쳐 그린다(fixture-client context, sync 8-1).
  const ticket = params.afterTicket ? ticketTaken(state, o, params.afterTicket) : null;
  const due = fieldDue(state, o);
  const payer = promisedPayer(state, o);
  const methodKey = DRIVER_METHODS.includes(params.methodKey as FxMethodKey) ? (params.methodKey as FxMethodKey) : DRIVER_DEFAULT_METHOD;
  const amount = Math.max(0, Math.floor(params.amount ?? due));
  const methods: ChoiceOption[] = DRIVER_METHODS.map((key) => ({ key, label: payMethodOf(key)?.label ?? key, selected: key === methodKey, enabled: true }));
  const late = moneyLateAt(state, o);
  const tone = late !== undefined && late <= ctx.now ? { tone: 'red' as const } : {};
  const dueLine: RichText = ticket && ticket.deposit > 0 && due > 0 && methodKey === 'cash'
    ? [
      { text: '받을 금액 현금 ' + won(amount + ticket.deposit), strong: true, ...tone },
      // 받을 돈이 권 값 그대로면 `리프트권`, 앞의 미수가 함께면 `미수`.
      { text: ' = ' + (amount === ticket.lineAmount ? ticket.label : '미수') + ' ' + won(amount) + ' + 보증금 ' + won(ticket.deposit) },
    ]
    : payer && due === 0 && ownDue(o) > 0
      ? [{ text: payer.teamName + ' 팀 결제 예정', strong: true, tone: 'blue' }]
      : due > 0
        ? [{ text: '미수 ' + won(due), strong: true, ...tone }]
        : [{ text: '미수 없음', strong: true, tone: 'green' }];
  const name = ACTION_LABELS.field_collect;
  // 받을 돈보다 많이는 받지 않는다(줄에 넣을 수 없는 돈은 수납이 아니다, data-model 5). 받을 돈이 없으면 누를 수 없다.
  const ok = amount > 0 && due > 0 && amount <= due;
  const methodWord = payMethodOf(methodKey)?.label ?? '';
  return {
    basis: { epoch: state.epoch, rev: state.rev },
    title: name + ' · ' + o.teamName + ' 팀',
    due: dueLine,
    methods,
    amount: { value: amount, max: due },
    primary: ok
      ? { label: name + ' · ' + methodWord + ' ' + won(amount), alts: [name + ' · ' + methodWord + ' ' + won(amount), name + ' · ' + won(amount), name], enabled: true }
      : { label: name, alts: [name], enabled: false },
    ...(ok ? { command: { type: 'field.collect' as const, payload: { taskId: t.id, orderId: o.id, amount, methodKey } }, expect: { dueAmount: due } } : {}),
    // 후불 처리: 이 팀 미수를 반납 때 받기로(결제 약속 later). 이미 반납 때 받기로 했으면 없음.
    ...(due > 0 && o.payWhen !== 'return'
      ? { leaveUnpaid: { label: ACTION_LABELS.leave_unpaid, command: { type: 'payment_promise.set' as const, payload: { orderId: o.id, payerOrderId: null } } } }
      : {}),
  };
}

// ── 리프트권 추가 판(addTicketSheet) ────────────────────────────────────────

/** 권 추가의 값(그때 요금표: 1매 값 × 매수)과 보증금(규칙이 있으면 매수 × 1매 보증금, 이미 받은 보관이 있으면 그 복사 값), 가격 확인 값. */
export function ticketQuote(state: FxState, o: FxOrder, productKey: string, quantity: number): { amount: number; deposit?: { ruleKey: string; amount: number; unitAmount: number }; hash: string } {
  const product = productOf(productKey);
  const amount = (product?.price ?? 0) * quantity;
  // 보증금은 돌려받는 권에만(반납 선택 매장의 권은 돌아올 수 없다).
  const rule = liftReturnable(state.settings) ? state.settings.liftDeposit : null;
  const unitAmount = rule && product && rule.section === product.section ? depositOf(state, o.id, rule.key)?.unitAmount ?? rule.unitAmount : 0;
  const deposit = rule && unitAmount > 0 ? { ruleKey: rule.key, amount: quantity * unitAmount, unitAmount } : undefined;
  return { amount, ...(deposit ? { deposit } : {}), hash: 'ticket:' + productKey + 'x' + quantity + '=' + amount + ':d' + (deposit?.amount ?? 0) };
}

export function addTicketSheet(ctx: ViewContext, params: AddTicketSheetParams): AddTicketSheetView {
  const { state } = ctx;
  const t = resolveTask(state, params.taskId);
  if (!t) throw new DomainError('NOT_FOUND', '없는 업무: ' + params.taskId);
  const o = t.order;
  const spare = spareTickets(state, vehicleOf(t));
  const chosen = spare.find((s) => s.productKey === params.productKey) ?? spare[0];
  const name = ACTION_LABELS.add_ticket;
  const title = name + ' · ' + o.teamName + ' 팀';
  const basis = { epoch: state.epoch, rev: state.rev };
  if (!chosen) {
    return { basis, title, products: [], quantity: { value: 0, min: 0, max: 0, unit: '매' }, lines: [[{ text: '차량 권 재고 없음', strong: true }]], primary: { label: name, alts: [name], enabled: false } };
  }
  const product = productOf(chosen.productKey)!;
  const unit = product.unit ?? '매';
  const quantity = Math.min(chosen.ids.length, Math.max(1, Math.floor(params.quantity ?? 1)));
  const quote = ticketQuote(state, o, product.key, quantity);
  const rule = state.settings.liftDeposit;
  const short = product.shortLabel ?? product.label;
  const lines: RichText[] = [[{ text: short + ' ' + quantity + unit, strong: true }, { text: ' ' + won(quote.amount) }]];
  if (quote.deposit && rule) {
    // 좁으면 설명 조각(반납 시 반환 → 매장 기준 → 매수)이 뒤에서부터 빠지고 받을 돈(굵은 `현금 5,000원`)은 남는다(RichLine).
    lines.push([
      { text: rule.label, strong: true },
      { text: ' · ' + quantity + unit },
      { text: ' · 매장 기준 1' + unit + ' ' + won(quote.deposit.unitAmount) },
      { text: ' · 반납 시 반환' },
      { text: ' · ' + (METHOD_WORD[rule.methods[0] ?? 'cash'] ?? '') + ' ' + won(quote.deposit.amount), strong: true },
    ]);
  }
  const label = [name, quantity + unit, ...(quote.deposit ? ['보증금 ' + won(quote.deposit.amount)] : [])].join(' · ');
  // 좁으면 매수보다 돈을 먼저 지킨다(`리프트권 추가 · 보증금 5,000원`).
  const moneyAlt = quote.deposit ? [name + ' · 보증금 ' + won(quote.deposit.amount)] : [];
  return {
    basis,
    title,
    products: spare.map((s) => {
      const p = productOf(s.productKey);
      return { key: s.productKey, label: p?.shortLabel ?? p?.label ?? s.productKey, secondLine: '재고 ' + s.ids.length + (p?.unit ?? '매'), selected: s === chosen, enabled: s.ids.length > 0 };
    }),
    quantity: { value: quantity, min: 1, max: chosen.ids.length, unit },
    lines,
    primary: { label, alts: [label, ...moneyAlt, name + ' · ' + quantity + unit, name], enabled: true },
    command: {
      type: 'field.add_ticket',
      payload: {
        taskId: t.id, orderId: o.id, productKey: product.key, quantity, assetIds: chosen.ids.slice(0, quantity), amount: quote.amount,
        ...(quote.deposit ? { deposit: { ruleKey: quote.deposit.ruleKey, amount: quote.deposit.amount } } : {}),
      },
    },
    expect: { quoteHash: quote.hash },
  };
}

// ── 수거 확인 창의 보증금 줄 ───────────────────────────────────────────────

/**
 * 수거 확인 창(stamp.collect)에 붙는 권 보증금 반환(spec 3-8, ui 6-5): 수거할 권 중 보증금을 맡은 매수만큼 한 줄 `권 1매 보증금 5,000원 반환 ·
 * 차량 현금`과 주 버튼의 `보증금 5,000원`, 수거에 이어 보낼 field.deposit_return(창을 연 때의 보관 금액 expect). 없으면 null.
 */
export function collectDepositStep(state: FxState, task: FxTask, picks: readonly { l: FxLine; qty: number }[]): { summary: string; label: string; then: ConfirmStep[] } | null {
  const rule = heldRule(state);
  const o = task.order;
  const dep = rule ? depositOf(state, o.id, rule.key) : undefined;
  if (!dep) return null;
  const lines = picks.flatMap(({ l, qty }) => {
    const units = Math.min(qty, Math.max(0, heldUnits(dep, l.id)));
    return units > 0 ? [{ l, units }] : [];
  });
  const units = lines.reduce((n, x) => n + x.units, 0);
  if (units === 0) return null;
  const amount = units * dep.unitAmount;
  const unit = unitOf(lines.map((x) => x.l));
  return {
    summary: '권 ' + units + unit + ' 보증금 ' + won(amount) + ' 반환 · 차량 현금',
    label: '보증금 ' + won(amount),
    then: [{
      command: { type: 'field.deposit_return', payload: { taskId: task.id, orderId: o.id, ruleKey: dep.ruleKey, lines: lines.map((x) => ({ lineId: x.l.id, quantity: x.units })), amount } },
      expect: { depositHeld: heldAmount(dep) },
    }],
  };
}

// ── 명령 ────────────────────────────────────────────────────────────

/** 보냄 대기로 온 명령(기기 번호가 있음): 돈의 바탕은 참고 값이다(sync 8-12). */
const queued = (envelope: { deviceSeq?: number }) => envelope.deviceSeq !== undefined;

/** 업무와 접수가 맞는지(명령의 업무 id와 접수 id). */
function taskOf(state: FxState, taskId: string, orderId: string): FxAnyTask | undefined {
  const t = resolveTask(state, taskId);
  return t && t.order.id === orderId ? t : undefined;
}

/**
 * 현장 수납(field.collect): 차량 지갑(현금) · 카드 · 계좌이체. 돈 한 건(결제 자리 driver_field) + 이 팀 몫 한 행(이 팀이 스스로 낼 줄만 채운다).
 * 연결된 기기에서는 받을 돈(이 팀 몫 미수)보다 많이 받지 않는다: 받을 돈이 없거나 넘치면 거절(data-model 5: 줄마다 받은 돈 ≤ 줄 청구).
 * 보냄 대기로 온 명령은 기기에서 이미 받은 돈이라 적용하고, 넘친 몫은 확인 필요 `초과 수납`이 된다(views.ts reviewList).
 */
export function fieldCollect(state: FxState, envelope: CommandEnvelope<'field.collect'>, now: number): Result {
  const p = envelope.payload;
  const t = taskOf(state, p.taskId, p.orderId);
  if (!t) return rejected('업무 없음');
  const methodKey = p.methodKey as FxMethodKey;
  if (!DRIVER_METHODS.includes(methodKey)) return rejected('등록되지 않은 결제 수단');
  const amount = Math.floor(p.amount);
  if (!(amount > 0)) return rejected('받을 금액 없음');
  const due = fieldDue(state, t.order);
  if (!queued(envelope)) {
    if (envelope.expect?.dueAmount !== due) return conflict('DUE_CHANGED', '받을 금액 변경됨 · 재시도 필요');
    if (due === 0) return rejected('받을 금액 없음');
    if (amount > due) return rejected('초과 수납 · 받을 금액 ' + won(due));
  }
  const drawer = methodKey === 'cash' ? { drawerId: vanDrawer(vehicleOf(t)) } : {};
  const lines = fillLines(t.order, selfLines(t.order), amount);
  state.paymentGroups.push({ id: envelope.requestId, purpose: 'driver_field', amount, methodKey, at: now, ...drawer });
  t.order.payments.push({ id: envelope.requestId + ':0', amount, methodKey, at: now, groupId: envelope.requestId, ...drawer, ...(lines.length ? { lines } : {}) });
  return done;
}

/** 리프트권 추가 명령(요청번호)이 적은 권 줄의 이름과 받은 보증금(현금). 그 명령이 적용되지 않았으면 null. */
export function ticketTaken(state: FxState, o: FxOrder, requestId: string): { label: string; lineAmount: number; deposit: number } | null {
  const entry = state.deposits.filter((d) => d.orderId === o.id).flatMap((d) => d.entries).find((e) => e.id === requestId + ':d');
  if (!entry || entry.methodKey !== 'cash') return null;
  const line = o.lines.find((l) => l.id === entry.lineId);
  return { label: PAY_SECTIONS.find((x) => x.key === line?.section)?.label ?? line?.shortLabel ?? '', lineAmount: line?.amount ?? 0, deposit: entry.amount };
}


/**
 * 리프트권 추가(field.add_ticket, catalog 11-1): 차량 예비권 번호로 권 줄을 더하고(값 = 그때 요금표, 반납 여부는 운영 규칙에서 복사,
 * 지급까지 한 번에) 규칙이 있으면 보증금 입금(차량 지갑 현금, 보증금 장부 take). 번호는 차량 예비권이어야 하고, 창이 본 가격(quoteHash)과
 * 같아야 한다. 값은 이 팀 미수가 되고 곧바로 현장 수납 판이 받는다(dependsOn).
 */
export function addTicket(state: FxState, envelope: CommandEnvelope<'field.add_ticket'>, now: number): Result {
  const p = envelope.payload;
  const t = taskOf(state, p.taskId, p.orderId);
  if (!t) return rejected('업무 없음');
  const o = t.order;
  const product = productOf(p.productKey);
  if (!product || product.section !== 'lift') return rejected('체험판 미지원');
  const vehicleId = vehicleOf(t);
  const spare = spareTickets(state, vehicleId).find((s) => s.productKey === product.key)?.ids ?? [];
  const quantity = Math.floor(p.quantity);
  if (!(quantity > 0) || p.assetIds.length !== quantity || p.assetIds.some((id) => !spare.includes(id)) || new Set(p.assetIds).size !== quantity) {
    return rejected('차량 권 재고 없음');
  }
  const quote = ticketQuote(state, o, product.key, quantity);
  if (!queued(envelope) && envelope.expect?.quoteHash !== quote.hash) return conflict('QUOTE_CHANGED', '받을 금액 변경됨 · 재시도 필요');
  if (p.amount !== quote.amount || (p.deposit?.amount ?? 0) !== (quote.deposit?.amount ?? 0)) return conflict('QUOTE_CHANGED', '받을 금액 변경됨 · 재시도 필요');
  let n = o.lines.length + 1;
  while (o.lines.some((l) => l.id === o.id + '-l' + n)) n += 1;
  const line: FxLine = {
    id: o.id + '-l' + n, kind: product.key, productKey: product.key, label: product.label, shortLabel: product.shortLabel ?? product.label, qty: quantity,
    ...(product.unit ? { unit: product.unit } : {}), countWord: product.countWord, amount: quote.amount, section: product.section,
    returnable: liftReturnable(state.settings), capabilities: [...product.capabilities], tracking: product.tracking,
    loaded: 0, issued: quantity, issuedAt: now, returned: 0, collected: 0, received: 0, assetIds: [...p.assetIds],
  };
  o.lines.push(line);
  // 손님에게 간 권은 차량 예비권이 아니다(돌아오면 매장 재고).
  for (const id of p.assetIds) {
    const asset = state.assets.find((a) => a.id === id);
    if (asset) delete asset.vehicleId;
  }
  const rule = state.settings.liftDeposit;
  if (quote.deposit && rule && line.returnable) {
    let dep = depositOf(state, o.id, rule.key);
    if (!dep) {
      dep = { id: 'dep:' + o.id + ':' + rule.key, orderId: o.id, ruleKey: rule.key, label: rule.label, unitAmount: quote.deposit.unitAmount, entries: [] };
      state.deposits.push(dep);
    }
    const methodKey = rule.methods[0] ?? 'cash';
    dep.entries.push({
      id: envelope.requestId + ':d', kind: 'take', lineId: line.id, quantity, assetIds: [...p.assetIds], amount: quote.deposit.amount, methodKey, at: now,
      ...(methodKey === 'cash' ? { drawerId: vanDrawer(vehicleId) } : {}),
    });
  }
  return done;
}

/**
 * 수거 현장의 권 보증금 반환(field.deposit_return, sync 8-2): 돌아온 권만큼 차량 지갑에서 현금으로. 수거(stock.collect)에 이어 온다(dependsOn).
 * 돈이라 앞 명령이 되지 않아도 멈추지 않지만, 권이 아직 돌아오지 않았으면 여기서 거절한다(`보증금 반환 불가 · 리프트권 미반납`).
 */
export function fieldDepositReturn(state: FxState, envelope: CommandEnvelope<'field.deposit_return'>, now: number): Result {
  const p = envelope.payload;
  const t = taskOf(state, p.taskId, p.orderId);
  if (!t) return rejected('업무 없음');
  const dep = depositOf(state, t.order.id, p.ruleKey);
  if (!dep || heldAmount(dep) <= 0) return rejected('보증금 반환 불가 · 권 매수 없음');
  if (!queued(envelope) && envelope.expect?.depositHeld !== heldAmount(dep)) return conflict('DEPOSIT_CHANGED', '보증금 변경됨 · 재시도 필요');
  const plan = planRefunds(t.order, dep, p.lines, p.amount);
  if ('error' in plan) return rejected(plan.error);
  const drawerId = vanDrawer(vehicleOf(t));
  plan.refunds.forEach(({ l, quantity, assetIds }, i) => {
    dep.entries.push({ id: envelope.requestId + ':' + i, kind: 'refund', lineId: l.id, quantity, amount: quantity * dep.unitAmount, methodKey: 'cash', drawerId, at: now, ...(assetIds ? { assetIds } : {}) });
  });
  return done;
}

/**
 * 후불 처리(payment_promise.set, 현장 수납 판): 이 팀 미수를 반납 때 받기로 적는다(결제 약속 later — 반납 일정 30분 뒤까지 늦음이 아님).
 * 체험판은 이 팀 자신(payerOrderId null · 이 팀)만: 다른 팀을 결제 팀으로 정하는 것은 카운터의 결정이다(체험판 미지원).
 */
export function setPaymentPromise(state: FxState, envelope: CommandEnvelope<'payment_promise.set'>, _now: number): Result {
  const p = envelope.payload;
  const o = findOrder(state, p.orderId);
  if (!o) return rejected('접수 없음');
  if (p.payerOrderId !== null && p.payerOrderId !== o.id) return rejected('체험판 미지원');
  if (ownDue(o) === 0) return nothing('받을 금액 없음');
  if (o.payWhen === 'return' && !o.payerOrderId) return nothing('처리 완료');
  o.payWhen = 'return';
  return done;
}

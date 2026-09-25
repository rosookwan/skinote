// V6 하루 마감(spec 3-7, ui 6-8, data-model 4-12 · 4-13 · S16 · S17)의 체험 몫(서버가 할 일): 마감 화면의 읽기 모델(closingSheet)과
// 차량 현금 인계(cash.transfer) · 인계 확인(cash.transfer_confirm) · 마감(closing.close), 매장 입고 뒤 차에 남은 것(`헬멧 1개 미입고`).
// 돈은 영업일(기준 시각 06:00)로 가른다: 27일 00:15 반납 · 00:32 점검은 26일 영업일이다. 결제 수단 표는 수납(payments, 보증금 결제 빼고)을
// 수단마다 세고(결제 자리 하나 = 1건, 결제 자리가 없는 처음 자료는 한 행 = 1건), 돈통 예상은 시재 + 그 돈통의 현금 수납 + 현금 보증금
// (입금 − 반환) + 확인한 차량 인계(센 금액)다. 체험 자료는 하루뿐이라 rev 창 대신 영업일로 센다(data-model 4-13의 rev 창은 운영 서버 몫).
// 보증금은 매출이 아니라 결제 수단 표에 없고 돈통 예상에만 든다(`보증금 5,000원 포함`). 마감 차례: 차량 현금 점검 → 돈통 점검 → 마감.
// 돈통 셈은 명령 · 장부 표가 없어 화면 초안(params.counts)으로 오고 마감 명령이 싣는다(plan §8 D3). 이 파일은 체험 전용이고 LocalClient가
// 오면 없어진다.
import {
  DomainError, type CarryItem, type CashCheckRow, type ChoiceOption, type ClosingCheckView, type ClosingCount, type ClosingMethodRow,
  type ClosingSheetParams, type ClosingSheetView, type CommandEnvelope, type FitPart, type RichText, type StampCell,
} from '@skinote/contract';
import { PAY_METHODS, PAY_SECTIONS } from './catalog.ts';
import { heldAmount, heldUnits } from './deposits.ts';
import type { FxCashTransfer, FxClosing, FxClosingSheet, FxDepositEntry, FxLine, FxOrder, FxState } from './model.ts';
import { bucketOnVan, bucketOut, currentReturn, lineBuckets, taskBucket } from './promises.ts';
import { countWordOf, countWords, pieceWord, slotTime } from './promise-sheet.ts';
import { conflict, done, nothing, rejected, type Result } from './result.ts';
import {
  lastReturnSlotAt, LATE_AFTER_STORE, LATE_AFTER_VEHICLE, moneyLateAt, othersDue, pendingIssue, routeTasks, selfDue, slotAt, vehicleLabel,
} from './rules.ts';
import { DRAWERS, VEHICLES } from './seed.ts';
import { businessDateOf, dateTitle, hm, iso, kstAt, kstDate, shopCutoff } from './time.ts';
import type { ViewContext } from './views.ts';

/** 카운터 돈통. */
export const COUNTER = 'counter';
/** 이 체험판의 기사 기기(나가기 화면의 연결 해제 · 전송 대기)는 1호 차량의 것이다. */
const DRIVER_DEVICE_VEHICLE = 'v1';
const vanDrawer = (vehicleId: string) => 'van:' + vehicleId;
/** 아직 인계하지 않은 차량 지갑의 key(`van:v1`)면 그 차량. */
const walletVehicle = (key: string) => VEHICLES.find((v) => vanDrawer(v.id) === key)?.id;
const drawerLabel = (id: string) => DRAWERS.find((d) => d.id === id)?.label ?? '';

/** 차액 사유(reason_codes의 체험 값, spec 3-7 · 문구 표 3-9). 직접 입력은 글을 함께 적는다. */
export const DIFF_REASONS = [
  { key: 'change_error', label: '잔돈 착오' },
  { key: 'unknown', label: '원인 불명' },
  { key: 'manual', label: '직접 입력' },
] as const;
const MANUAL = 'manual';
const isReason = (key: string | undefined) => DIFF_REASONS.some((r) => r.key === key);

// 이름(문구 표 3-9의 말).
const VAN_CHECK = '차량 현금 점검';
const DRAWER_CHECK = '돈통 점검';
const CLOSE = '마감';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';
/** 부호 있는 금액(빼기는 `−`, 문구 표 3-9 `차액 −5,000원`). */
const minusWon = (n: number) => (n < 0 ? '−' : '') + won(Math.abs(n));
/** 차액 글: 0원 · +5,000원 · −5,000원. */
const diffWon = (n: number) => (n > 0 ? '+' : '') + minusWon(n);
const dayOf = (date: string) => Number(date.split('-')[2]) + '일';
const monthDay = (date: string) => { const [, m = '1', d = '1'] = date.split('-'); return Number(m) + '월 ' + Number(d) + '일'; };

/**
 * 마감 화면의 시각 글: 그 영업일의 날짜 안이면 '22:10', 자정을 넘긴 날이면 '27일 00:40'(자정 뒤 · 기준 시각 전에 그리는 마감 화면은
 * 오늘 · 내일 대신 날짜를 쓴다, spec 2-5).
 */
export function closingWhen(ms: number, date: string): string {
  const day = kstDate(ms);
  if (day === date) return hm(ms);
  const [, m1] = date.split('-');
  const [, m2 = '1', d2 = '1'] = day.split('-');
  return (m1 === m2 ? Number(d2) + '일 ' : Number(m2) + '월 ' + Number(d2) + '일 ') + hm(ms);
}

const inDay = (state: FxState, date: string) => (ms: number) => businessDateOf(ms, shopCutoff(state.settings)) === date;

/**
 * 돈 기록의 올림 날(posting date, data-model 3-3): 그 기록의 영업일이 이미 마감되었고 마감 뒤에 적힌 것이면 다음 열린 영업일의 것이다
 * (27일 00:40에 26일을 마감한 뒤 00:50의 수납은 27일 마감에 든다). 마감의 결제 수단 표 · 돈통 예상 · 차량 지갑이 이 날로 센다.
 */
export function postingDate(state: FxState, ms: number): string {
  let date = businessDateOf(ms, shopCutoff(state.settings));
  for (let guard = 0; guard < 31; guard += 1) {
    const closed = state.closings.find((c) => c.date === date);
    // 마감한 그 순간 이후(같은 시각 포함: 마감 명령 뒤에 적힌 것)의 기록은 다음 날.
    if (!closed || ms < closed.closedAt) return date;
    date = kstDate(kstAt(date, 1, 12, 0));
  }
  return date;
}

/** 그 영업일에 올린 돈 기록인지(마감 뒤의 기록은 다음 열린 날). */
const postedOn = (state: FxState, date: string) => (ms: number) => postingDate(state, ms) === date;

// ── 돈통 · 차량 지갑 ─────────────────────────────────────────────────

/** 이 영업일에 그 돈통 · 차량 지갑에 든 현금 수납(결제 자리의 팀 몫 합). */
function paidCash(state: FxState, date: string, drawerId: string): number {
  const day = postedOn(state, date);
  return state.orders.reduce((sum, o) => sum + o.payments.filter((p) => p.drawerId === drawerId && day(p.at)).reduce((n, p) => n + p.amount, 0), 0);
}

const DEPOSIT_SIGN: Record<FxDepositEntry['kind'], number> = { take: 1, restore: 1, refund: -1, apply: 0, keep: 0 };

/** 이 영업일의 현금 보증금(입금 · 몰수 취소 +, 반환 −): 그 돈통 · 차량 지갑. 미수 차감 · 몰수는 현금이 움직이지 않는다. */
function depositCash(state: FxState, date: string, drawerId: string): number {
  const day = postedOn(state, date);
  return state.deposits.reduce((sum, dep) => sum + dep.entries.filter((e) => e.drawerId === drawerId && day(e.at)).reduce((n, e) => n + DEPOSIT_SIGN[e.kind] * e.amount, 0), 0);
}

/** 이 영업일의 그 차량 현금 인계(인계한 차례). */
const transfersOf = (state: FxState, date: string, vehicleId: string) => state.cashTransfers.filter((t) => t.vehicleId === vehicleId && postedOn(state, date)(t.at));

/** 차량 지갑에 남은 현금(아직 인계하지 않음): 현장 수납 + 현장 보증금(입금 − 반환) − 인계. */
export function walletLeft(state: FxState, date: string, vehicleId: string): number {
  const drawer = vanDrawer(vehicleId);
  return paidCash(state, date, drawer) + depositCash(state, date, drawer) - transfersOf(state, date, vehicleId).reduce((n, t) => n + t.amount, 0);
}

/**
 * 카운터 돈통 예상(spec 2-4 검산): 시재 + 카운터 현금 수납 + 카운터 현금 보증금 + 확인한 차량 인계(센 금액). 보증금 몫(`보증금 N원 포함`)은
 * 카운터의 보증금과 확인한 인계가 가져온 그 차량 지갑의 보증금이다.
 */
function counterExpected(state: FxState, date: string): { amount: number; deposit: number } {
  let amount = state.settings.openingCash + paidCash(state, date, COUNTER) + depositCash(state, date, COUNTER);
  let deposit = depositCash(state, date, COUNTER);
  for (const v of VEHICLES) {
    const confirmed = transfersOf(state, date, v.id).filter((t) => t.confirmed);
    if (!confirmed.length) continue;
    amount += confirmed.reduce((n, t) => n + (t.confirmed?.countedAmount ?? 0), 0);
    deposit += depositCash(state, date, vanDrawer(v.id));
  }
  return { amount, deposit };
}

// ── 매장 입고 뒤 차에 남은 것(확인 필요) ─────────────────────────────────────

/** 그 차량의 이 영업일 마지막 매장 입고. */
function lastReceipt(state: FxState, date: string, vehicleId: string): number | undefined {
  const day = inDay(state, date);
  const times = (state.vanReceipts ?? []).filter((r) => r.vehicleId === vehicleId && day(r.at)).map((r) => r.at);
  return times.length ? Math.max(...times) : undefined;
}

/** 매장 입고 뒤에도 차에 남은 것: 입고 전에 수거했는데 내려놓지 않은 수(`김민수 · 0025 · 헬멧 1개 미입고`). */
export function notReceived(state: FxState, date: string): { o: FxOrder; l: FxLine; qty: number; at: number }[] {
  const out: { o: FxOrder; l: FxLine; qty: number; at: number }[] = [];
  for (const v of VEHICLES) {
    const at = lastReceipt(state, date, v.id);
    if (at === undefined) continue;
    for (const task of routeTasks(state, v.id, date)) {
      for (const l of task.order.lines) {
        const b = l.returnable ? taskBucket(task, l) : undefined;
        const qty = b ? bucketOnVan(b) : 0;
        if (qty > 0 && (l.collectedAt ?? 0) <= at) out.push({ o: task.order, l, qty, at });
      }
    }
  }
  return out;
}

/** 미입고 한 줄의 말(`헬멧 1개 미입고`). */
export const notReceivedText = (l: FxLine, qty: number) => pieceWord(l) + ' ' + qty + countWordOf(l) + ' 미입고';

// ── 마감의 셈(화면과 명령이 함께 쓴다) ─────────────────────────────────────

/** 현금 점검 표의 차량 한 줄: 인계(transfer) 또는 아직 인계하지 않은 지갑(key `van:v1`). */
interface VanItem {
  key: string;
  vehicleId: string;
  amount: number;
  transfer?: FxCashTransfer;
  deferred: boolean;
}

interface ClosingPlan {
  date: string;
  closing?: FxClosing;
  vans: VanItem[];
  /** 오늘 점검할 차량 줄(확인 안 됨 · 이월 안 함). */
  pendingVans: VanItem[];
  counter: { amount: number; deposit: number };
  /** 카운터 돈통의 셈(초안). 예상이 바뀌어 차액의 사유가 없게 되면 다시 셀 차례다(ready false). */
  count?: ClosingCount;
  /** 센 뒤에 예상이 바뀐 셈(다시 셀 차례). */
  countStale: boolean;
  countReady: boolean;
  methods: ClosingMethodRow[];
  total: number;
  /** 보낼 것이 남은 기사 기기(`1호 차량 · 전송 대기 있음`). */
  blocked?: string;
}

const reasonOk = (diff: number, reasonKey: string | undefined, reasonNote: string | undefined) =>
  diff === 0 || (isReason(reasonKey) && (reasonKey !== MANUAL || (reasonNote ?? '').trim() !== ''));

function methodRows(state: FxState, date: string): ClosingMethodRow[] {
  const day = postedOn(state, date);
  const acc = new Map<string, { amount: number; groups: Set<string>; vans: Map<string, number> }>();
  for (const o of state.orders) {
    for (const p of o.payments) {
      // 보증금 결제(미수 차감)는 돈이 움직이지 않아 수단 표에 없다(plan §8 D10).
      if (p.methodKey === 'deposit' || !day(p.at)) continue;
      const a = acc.get(p.methodKey) ?? { amount: 0, groups: new Set<string>(), vans: new Map<string, number>() };
      a.amount += p.amount;
      a.groups.add(p.groupId ?? p.id);
      const vehicle = p.drawerId ? walletVehicle(p.drawerId) : undefined;
      if (vehicle) a.vans.set(vehicle, (a.vans.get(vehicle) ?? 0) + p.amount);
      acc.set(p.methodKey, a);
    }
  }
  return PAY_METHODS.flatMap((m) => {
    const a = acc.get(m.key);
    if (!a || a.amount <= 0) return [];
    const note: FitPart[] = [...a.vans].filter(([, n]) => n > 0).map(([v, n]) => ({ text: vehicleLabel(v) + ' ' + won(n) + ' 포함', drop: 1, short: vehicleLabel(v) + ' ' + won(n) }));
    return [{ key: m.key, label: m.label, ...(note.length ? { note } : {}), count: a.groups.size, amount: a.amount }];
  });
}

function closingPlan(state: FxState, date: string, params: Pick<ClosingSheetParams, 'counts' | 'deferredTransferIds'>): ClosingPlan {
  const deferred = new Set(params.deferredTransferIds ?? []);
  const vans: VanItem[] = [];
  for (const v of VEHICLES) {
    for (const t of transfersOf(state, date, v.id)) {
      vans.push({ key: t.id, vehicleId: v.id, amount: t.amount, transfer: t, deferred: !t.confirmed && deferred.has(t.id) });
    }
    const left = walletLeft(state, date, v.id);
    if (left !== 0) vans.push({ key: vanDrawer(v.id), vehicleId: v.id, amount: left, deferred: deferred.has(vanDrawer(v.id)) });
  }
  const counter = counterExpected(state, date);
  const count = (params.counts ?? []).find((c) => c.drawerId === COUNTER);
  // 센 뒤에 예상이 바뀌었으면(차량 현금 점검 · 새 현금 수납) 그 셈은 다시 셀 차례다.
  const stale = count?.expectedAmount !== undefined && count.expectedAmount !== counter.amount;
  const methods = methodRows(state, date);
  const queue = state.driverDevice.queue.length;
  return {
    date,
    ...(state.closings.find((c) => c.date === date) ? { closing: state.closings.find((c) => c.date === date)! } : {}),
    vans,
    pendingVans: vans.filter((x) => !x.transfer?.confirmed && !x.deferred),
    counter,
    ...(count ? { count } : {}),
    countStale: stale,
    countReady: count !== undefined && !stale && reasonOk(count.countedAmount - counter.amount, count.reasonKey, count.reasonNote),
    methods,
    total: methods.reduce((n, m) => n + m.amount, 0),
    ...(queue > 0 ? { blocked: vehicleLabel(DRIVER_DEVICE_VEHICLE) + ' · 전송 대기 있음' } : {}),
  };
}

// ── 화면 줄 ─────────────────────────────────────────────────────────

const pending = (state: FxState, vehicleId: string) => (vehicleId === DRIVER_DEVICE_VEHICLE ? state.driverDevice.queue.length : 0);

function actualRuns(counted: number, diff: number): RichText {
  return [{ text: '실제 ' + won(counted) + ' · ' }, { text: '차액 ' + diffWon(diff), strong: true, ...(diff === 0 ? { tone: 'green' as const } : {}) }];
}

function vanRow(state: FxState, date: string, item: VanItem, now: boolean): CashCheckRow {
  const t = item.transfer;
  const receipt = t ? t.at : lastReceipt(state, date, item.vehicleId);
  const note: FitPart[] = [
    { text: receipt !== undefined ? hm(receipt) + ' 입고' : '입고 대기', drop: 1 },
    { text: '전송 대기 ' + pending(state, item.vehicleId), drop: 2 },
  ];
  const base = { key: item.key, kind: 'van' as const, label: drawerLabel(vanDrawer(item.vehicleId)), note, expected: [{ text: '예상 ' + won(item.amount) }] };
  const c = t?.confirmed;
  if (c) {
    const stamp: StampCell = { stepKey: 'cash_check', state: 'done', label: '점검', at: iso(c.at) };
    return { ...base, actual: actualRuns(c.countedAmount, c.countedAmount - item.amount), now: false, stamp, stampAria: '현금 점검 완료 ' + hm(c.at) };
  }
  if (item.deferred) return { ...base, actual: [{ text: '점검 이월', strong: true, tone: 'grey' }], now: false, action: { key: 'check', label: '점검' } };
  return { ...base, actual: [{ text: '미점검', strong: true, tone: 'purple' }], now, action: { key: 'defer', label: '점검 이월' } };
}

function expectedRuns(counter: { amount: number; deposit: number }): RichText {
  return [{ text: '예상 ' + won(counter.amount) }, ...(counter.deposit !== 0 ? [{ text: ' · 보증금 ' + minusWon(counter.deposit) + ' 포함' }] : [])];
}

function counterRow(state: FxState, plan: ClosingPlan, now: boolean): CashCheckRow {
  const opening = '시재 ' + won(state.settings.openingCash);
  const base = { key: COUNTER, kind: 'drawer' as const, label: drawerLabel(COUNTER), note: [{ text: opening + ' 포함', drop: 1, short: opening }] };
  // 차량 현금을 세기 전에는 돈통 차례가 아니다(세고 확인해야 넘기는 중 돈통에서 카운터 돈통으로 들어온다, spec 3-7).
  if (plan.pendingVans.length) return { ...base, expected: [], waiting: VAN_CHECK + ' 후', now: false };
  const expected = expectedRuns(plan.counter);
  if (!plan.count) return { ...base, expected, actual: [{ text: '실제 — · 차액 —' }], now };
  return {
    ...base, expected, actual: actualRuns(plan.count.countedAmount, plan.count.countedAmount - plan.counter.amount), now, action: { key: 'recount', label: '재점검' },
  };
}

// ── 이월 항목 ────────────────────────────────────────────────────────

const late = (text: string): RichText => [{ text }, { text: '지연', strong: true, tone: 'red' }];

/** 팀 목록의 둘째 줄: 한 팀이면 이름 · 끝 4자리 · 더 할 말(좁으면 빠짐), 둘이면 `윤서준 · 0028 / 이정호 · 0032`, 셋 이상이면 `윤서준 · 0028 외 2팀`. */
function teamsNote(teams: readonly FxOrder[], more?: string): FitPart[] {
  const [first, second] = teams;
  if (!first) return [];
  if (teams.length === 1) return [{ text: first.teamName, drop: 0 }, { text: first.last4, drop: 0 }, ...(more ? [{ text: more, drop: 1 }] : [])];
  const head = first.teamName + ' · ' + first.last4;
  const others = head + ' 외 ' + (teams.length - 1) + '팀';
  if (teams.length === 2 && second) return [{ text: head + ' / ' + second.teamName + ' · ' + second.last4, drop: 1, short: others }];
  return [{ text: first.teamName, drop: 0 }, { text: first.last4 + ' 외 ' + (teams.length - 1) + '팀', drop: 0 }];
}

/** 한 팀이면 접수증, 여러 팀이면 장부 탭. */
const openOf = (teams: readonly FxOrder[], tabKey?: string) => (teams.length === 1 ? { orderId: teams[0]!.id } : tabKey ? { tabKey } : {});

function dueCarry(state: FxState, now: number, date: string): CarryItem[] {
  // 팀마다 스스로 낼 미수 + 대신 낼 몫(다른 팀이 내기로 한 줄은 그 팀 쪽에서 한 번만 센다: 두 번 세지 않게).
  const amountOf = (o: FxOrder) => selfDue(o) + othersDue(state, o);
  const teams = state.orders.filter((o) => amountOf(o) > 0);
  if (!teams.length) return [];
  const dueAt = (o: FxOrder) => (o.payWhen === 'return' ? currentReturn(o).at : o.pickup.at);
  teams.sort((a, b) => dueAt(a) - dueAt(b) || a.receiptNo.localeCompare(b.receiptNo));
  const total = teams.reduce((n, o) => n + amountOf(o), 0);
  const isLate = teams.some((o) => { const at = moneyLateAt(state, o); return at !== undefined && at <= now; });
  const head = '미수 · ' + teams.length + '팀 · ' + won(total);
  const first = teams[0]!;
  const when = first.payWhen === 'return' ? closingWhen(currentReturn(first).at, date) + ' 반납 시' : pendingIssue(first) ? closingWhen(first.pickup.at, date) + ' 수령 시' : undefined;
  return [{ key: 'due', title: isLate ? late(head + ' · ') : [{ text: head }], note: teamsNote(teams, when), late: isLate, ...openOf(teams, 'unpaid') }];
}

/** 돌아오지 않은 것: 다음 영업일 뒤의 일정은 `27일 반납 예정`(지연 아님), 늦은 것은 종류마다 `리프트권 미반납 · 1매 · 지연`. */
function returnCarry(state: FxState, now: number, date: string): CarryItem[] {
  const cutoff = shopCutoff(state.settings);
  const planned = new Map<string, { at: number; o: FxOrder; l: FxLine; n: number }[]>();
  const overdue = new Map<string, { at: number; o: FxOrder; l: FxLine; n: number }[]>();
  for (const o of state.orders) {
    for (const l of o.lines) {
      if (!l.returnable) continue;
      for (const b of lineBuckets(o, l)) {
        const n = bucketOut(b);
        if (n <= 0) continue;
        const lateAt = b.promise.at + (b.promise.mode === 'vehicle' ? LATE_AFTER_VEHICLE : LATE_AFTER_STORE);
        const day = businessDateOf(b.promise.at, cutoff);
        const entry = { at: b.promise.at, o, l, n };
        if (day <= date && lateAt <= now) overdue.set(l.section, [...(overdue.get(l.section) ?? []), entry]);
        else planned.set(day, [...(planned.get(day) ?? []), entry]);
      }
    }
  }
  const teamsOf = (list: readonly { at: number; o: FxOrder }[]) => {
    const first = new Map<FxOrder, number>();
    for (const x of list) first.set(x.o, Math.min(first.get(x.o) ?? Number.POSITIVE_INFINITY, x.at));
    return [...first].sort((a, b) => a[1] - b[1] || a[0].receiptNo.localeCompare(b[0].receiptNo)).map(([o]) => o);
  };
  const figure = (list: readonly { l: FxLine; n: number }[]) => countWords(list.map((x) => ({ l: x.l, n: x.n })));
  const out: CarryItem[] = [];
  for (const day of [...planned.keys()].sort()) {
    const list = planned.get(day)!;
    const teams = teamsOf(list);
    out.push({
      key: 'planned:' + day, title: [{ text: dayOf(day) + ' 반납 예정 · ' + figure(list) + ' · ' + teams.length + '팀' }], note: teamsNote(teams), late: false,
      ...openOf(teams, 'return'),
    });
  }
  for (const section of PAY_SECTIONS) {
    const list = overdue.get(section.key);
    if (!list) continue;
    const teams = teamsOf(list);
    const first = list.filter((x) => x.o === teams[0]).sort((a, b) => a.at - b.at)[0]!;
    out.push({
      key: 'overdue:' + section.key, title: late(section.label + ' 미반납 · ' + figure(list) + ' · '),
      note: teamsNote(teams, '반납 ' + closingWhen(first.at, date)), late: true, ...openOf(teams, 'return'),
    });
  }
  return out;
}

/** 맡고 있는 보증금(이월, data-model 4-13 인계 deposit): `보증금 보관 중 · 리프트권 1매 · 5,000원` / `최하은 · 0026 · 돈통 보관`. */
function depositCarry(state: FxState, date: string): CarryItem[] {
  const held = state.deposits.filter((d) => heldAmount(d) > 0);
  if (!held.length) return [];
  const orders = held.map((d) => state.orders.find((o) => o.id === d.orderId)).filter((o): o is FxOrder => o !== undefined);
  const teams = [...new Set(orders)].sort((a, b) => a.receiptNo.localeCompare(b.receiptNo));
  const amount = held.reduce((n, d) => n + heldAmount(d), 0);
  // 매수는 보증금 장부(권 줄마다), 단위 · 종류 이름은 그 줄과 결제 칸(리프트권).
  const lines = orders.flatMap((o) => o.lines.map((l) => ({ o, l })));
  let units = 0;
  let unit = '';
  let section = '';
  for (const d of held) {
    for (const { o, l } of lines) {
      if (o.id !== d.orderId) continue;
      const n = heldUnits(d, l.id);
      if (n <= 0) continue;
      units += n;
      unit = unit || (l.unit ?? countWordOf(l));
      section = section || (PAY_SECTIONS.find((s) => s.key === l.section)?.label ?? '');
    }
  }
  // 돈이 있는 곳: 현금 보증금은 돈통(차량 지갑에서 받았어도 그 차량이 인계했으면 돈통), 아직 인계 전이면 그 차량.
  const first = held[0]!;
  const take = first.entries.find((e) => e.kind === 'take');
  const vehicle = take?.drawerId ? walletVehicle(take.drawerId) : undefined;
  const handed = vehicle !== undefined && transfersOf(state, date, vehicle).some((t) => t.at >= take!.at);
  const where = take?.methodKey !== 'cash' ? undefined : vehicle && !handed ? vehicleLabel(vehicle) + ' 보관' : '돈통 보관';
  return [{
    key: 'deposit',
    title: [{ text: '보증금 보관 중' }, ...(units > 0 ? [{ text: ' · ' + section + ' ' + units + unit }] : []), { text: ' · ' + won(amount), strong: true }],
    note: teamsNote(teams, teams.length === 1 ? where : undefined), late: false, ...openOf(teams),
  }];
}

function reviewCarry(state: FxState, date: string): CarryItem[] {
  const items = notReceived(state, date);
  const first = items[0];
  if (!first) return [];
  const note: FitPart[] = items.length === 1
    ? [{ text: first.o.teamName, drop: 0 }, { text: first.o.last4, drop: 0 }, { text: notReceivedText(first.l, first.qty), drop: 1 }]
    : [{ text: first.o.teamName, drop: 0 }, { text: first.o.last4 + ' 외 ' + (items.length - 1) + '건', drop: 0 }];
  return [{ key: 'review', title: [{ text: '확인 필요 · ' + items.length + '건' }], note, late: false, ...(items.length === 1 ? { orderId: first.o.id } : {}) }];
}

function transferCarry(state: FxState, date: string, plan: ClosingPlan): CarryItem[] {
  return plan.vans.filter((x) => x.deferred).map((x) => {
    const receipt = x.transfer ? x.transfer.at : lastReceipt(state, date, x.vehicleId);
    return {
      key: 'transfer:' + x.key, title: [{ text: '미확인 현금 인계 · ' + won(x.amount) }],
      note: [{ text: vehicleLabel(x.vehicleId), drop: 0 }, { text: receipt !== undefined ? hm(receipt) + ' 입고' : '입고 대기', drop: 1 }], late: false,
    };
  });
}

function carryItems(state: FxState, now: number, date: string, plan: ClosingPlan): CarryItem[] {
  return [...dueCarry(state, now, date), ...returnCarry(state, now, date), ...depositCarry(state, date), ...reviewCarry(state, date), ...transferCarry(state, date, plan)];
}

// ── 마감 전에 묻는 한 줄 ───────────────────────────────────────────────

/**
 * 영업 중 마감의 확인 한 줄(`26일 반납 예정 42개 · 1호 차량 미입고`): 이 영업일에 아직 돌아올 것(늦지 않은 반납 예정), 수거 · 입고가
 * 남은 차량, 그것이 없어도 마지막 반납 타임 전이면 그 타임(`심야 24:00 전`). 없으면(마지막 반납 타임 뒤이고 모두 돌아옴) 묻지 않는다.
 */
export function closeConfirmLine(state: FxState, now: number, date: string): string | undefined {
  const cutoff = shopCutoff(state.settings);
  const facts: string[] = [];
  const due: { l: FxLine; n: number }[] = [];
  for (const o of state.orders) {
    for (const l of o.lines) {
      if (!l.returnable) continue;
      for (const b of lineBuckets(o, l)) {
        const n = bucketOut(b);
        const lateAt = b.promise.at + (b.promise.mode === 'vehicle' ? LATE_AFTER_VEHICLE : LATE_AFTER_STORE);
        if (n > 0 && businessDateOf(b.promise.at, cutoff) === date && lateAt > now) due.push({ l, n });
      }
    }
  }
  if (due.length) facts.push(dayOf(date) + ' 반납 예정 ' + countWords(due));
  // 차량: 아직 받으러 갈 것(늦지 않은 수거)이 있거나, 마지막 매장 입고 뒤에 받은 것이 차에 있다. 늦은 수거 · 입고 뒤 남은 것은 이월
  // 항목(`리프트권 미반납` · `확인 필요`)이라 묻지 않는다.
  for (const v of VEHICLES) {
    const receipt = lastReceipt(state, date, v.id);
    const out = routeTasks(state, v.id, date).some((task) => task.promise.at + LATE_AFTER_VEHICLE > now && task.order.lines.some((l) => {
      const b = l.returnable ? taskBucket(task, l) : undefined;
      return b !== undefined && (bucketOut(b) > 0 || (bucketOnVan(b) > 0 && (receipt === undefined || (l.collectedAt ?? 0) > receipt)));
    }));
    if (out) facts.push(vehicleLabel(v.id) + ' 미입고');
  }
  if (!facts.length && now < lastReturnSlotAt(state, date)) {
    const last = [...state.settings.returnSlots].sort((a, b) => slotAt(date, b) - slotAt(date, a))[0];
    if (last) facts.push(last.label + ' ' + slotTime(last) + ' 전');
  }
  return facts.length ? facts.join(' · ') : undefined;
}

// ── 읽기 모델 ────────────────────────────────────────────────────────

/** 기준 띠의 둘째 조각: 자정을 넘겨 이 영업일에 든 매장 반납(`00:15 정하늘 · 0041 반납 포함`). */
function afterMidnight(state: FxState, date: string): string | undefined {
  const day = inDay(state, date);
  const first = new Map<FxOrder, number>();
  for (const o of state.orders) {
    for (const l of o.lines) {
      const at = l.returnedAt;
      if (at === undefined || kstDate(at) === date || !day(at)) continue;
      first.set(o, Math.min(first.get(o) ?? Number.POSITIVE_INFINITY, at));
    }
  }
  const list = [...first].sort((a, b) => a[1] - b[1]);
  const top = list[0];
  if (!top) return undefined;
  return hm(top[1]) + ' ' + top[0].teamName + ' · ' + top[0].last4 + (list.length > 1 ? ' 외 ' + (list.length - 1) + '팀' : '') + ' 반납 포함';
}

function reasonOptions(diff: number | undefined, reasonKey: string | undefined): ChoiceOption[] {
  const open = diff !== undefined && diff !== 0;
  return DIFF_REASONS.map((r) => ({ key: r.key, label: r.label, selected: open && r.key === reasonKey, enabled: open, ...(r.key === MANUAL ? { opens: true } : {}) }));
}

/** 열린 점검 판(차량 현금 · 돈통): 친 금액의 차액 · 사유 · 판의 주 버튼 · 보낼 것. 그 줄이 점검할 차례가 아니면 없음. */
function checkView(plan: ClosingPlan, input: NonNullable<ClosingSheetParams['check']>): ClosingCheckView | undefined {
  const van = plan.vans.find((x) => x.key === input.key && !x.transfer?.confirmed);
  const drawer = input.key === COUNTER && plan.pendingVans.length === 0;
  if (!van && !drawer) return undefined;
  const expected = van ? van.amount : plan.counter.amount;
  const name = van ? VAN_CHECK : DRAWER_CHECK;
  const counted = input.countedAmount !== undefined && Number.isFinite(input.countedAmount) && input.countedAmount >= 0 ? Math.floor(input.countedAmount) : undefined;
  const diff = counted === undefined ? undefined : counted - expected;
  const reasonKey = diff ? input.reasonKey : undefined;
  const ok = diff !== undefined && reasonOk(diff, reasonKey, input.reasonNote);
  const reason = reasonKey && isReason(reasonKey) ? { reasonKey, ...(reasonKey === MANUAL ? { reasonNote: (input.reasonNote ?? '').trim() } : {}) } : {};
  const diffLine: RichText = diff === undefined ? []
    : diff === 0 ? [{ text: '차액 0원', strong: true, tone: 'green' }]
      : [{ text: '차액 ' + diffWon(diff), strong: true }, ...(ok ? [] : [{ text: ' · 사유 선택' }])];
  const view: ClosingCheckView = {
    key: input.key,
    kind: van ? 'van' : 'drawer',
    title: van ? drawerLabel(vanDrawer(van.vehicleId)) : drawerLabel(COUNTER),
    expected: van ? [{ text: '예상 ' + won(expected) }] : expectedRuns(plan.counter),
    diff: diffLine,
    reasons: reasonOptions(diff, reasonKey),
    reasonsShown: diff !== undefined && diff !== 0,
    primary: counted === undefined ? { label: name, alts: [name], enabled: false } : { label: name + ' · ' + won(counted), alts: [name + ' · ' + won(counted), name], enabled: ok },
  };
  if (counted === undefined || !ok) return view;
  if (van) {
    return {
      ...view,
      command: { type: 'cash.transfer_confirm', payload: { transferId: van.key, countedAmount: counted, ...reason } },
      expect: { expectedCash: { [van.key]: expected } },
    };
  }
  return { ...view, count: { drawerId: COUNTER, countedAmount: counted, expectedAmount: expected, ...reason } };
}

/** 마감 명령(closing.close): 센 돈통 · 이월한 봉투, 바탕 = 카운터 돈통 예상. */
function closeCommand(plan: ClosingPlan) {
  const deferred = plan.vans.filter((x) => x.deferred).map((x) => x.key);
  return {
    command: { type: 'closing.close' as const, payload: { date: plan.date, drawerCounts: plan.count ? [plan.count] : [], deferredTransferIds: deferred } },
    expect: { expectedCash: { [COUNTER]: plan.counter.amount } },
  };
}

/** 바닥줄 요약: 수납 합계(좁으면 먼저 빠짐) · 지금 할 일 또는 돈통 차액. */
function footerOf(plan: ClosingPlan, next: ClosingSheetView['next']): FitPart[] {
  const tail = next?.kind === 'van_check' ? VAN_CHECK + ' 필요'
    : next?.kind === 'drawer_count' ? DRAWER_CHECK + ' 필요'
      : '돈통 차액 ' + diffWon((plan.count?.countedAmount ?? plan.counter.amount) - plan.counter.amount);
  return [{ text: '수납 합계 ' + won(plan.total), drop: 1 }, { text: tail, drop: 0 }];
}

/** 마감 때 얼린 화면 줄(지금 할 일 · 끝 칸 동작은 없음). */
function frozenSheet(state: FxState, now: number, plan: ClosingPlan): FxClosingSheet {
  const cash = [...plan.vans.map((x) => vanRow(state, plan.date, x, false)), counterRow(state, plan, false)]
    .map(({ action: _action, ...row }) => ({ ...row, now: false }));
  return { methods: plan.methods, cash, carry: carryItems(state, now, plan.date, plan), footer: footerOf(plan, null) };
}

export function closingSheet(ctx: ViewContext, params: ClosingSheetParams): ClosingSheetView {
  const state = ctx.state;
  const date = params.date ?? state.businessDate;
  if (date !== state.businessDate) throw new DomainError('NOT_FOUND', '체험 자료에 없는 마감: ' + date);
  const plan = closingPlan(state, date, params);
  const head = { basis: { epoch: state.epoch, rev: state.rev }, serverTime: iso(ctx.now), currentBusinessDate: state.businessDate };
  const extra = afterMidnight(state, date);
  const band = {
    pill: '현재 ' + closingWhen(ctx.now, date),
    parts: [{ text: dayOf(date) + ' 장부', drop: 0 }, { text: '기준 ' + state.settings.businessDayCutoff, drop: 2 }, ...(extra ? [{ text: extra, drop: 1 }] : [])],
  };
  const title = dateTitle(date) + ' ' + CLOSE;
  if (plan.closing) {
    const sheet = plan.closing.sheet ?? frozenSheet(state, plan.closing.closedAt, plan);
    return { ...head, date, title, band, ...sheet, next: null, closed: monthDay(date) + ' ' + CLOSE + ' 완료' };
  }
  const van = plan.pendingVans[0];
  const next: NonNullable<ClosingSheetView['next']> = van
    ? { kind: 'van_check', label: VAN_CHECK + ' · ' + won(van.amount), alts: [VAN_CHECK + ' · ' + won(van.amount), VAN_CHECK], enabled: true, targetKey: van.key, expectedAmount: van.amount }
    : !plan.countReady
      ? { kind: 'drawer_count', label: DRAWER_CHECK, alts: [DRAWER_CHECK], enabled: true, targetKey: COUNTER, expectedAmount: plan.counter.amount }
      : { kind: 'close', label: CLOSE + ' · ' + monthDay(date), alts: [CLOSE + ' · ' + monthDay(date), CLOSE], enabled: plan.blocked === undefined };
  const cash = [...plan.vans.map((x) => vanRow(state, date, x, x === van)), counterRow(state, plan, next.kind === 'drawer_count')];
  const check = params.check ? checkView(plan, params.check) : undefined;
  const confirmLine = next.kind === 'close' ? closeConfirmLine(state, ctx.now, date) : undefined;
  return {
    ...head, date, title, band, methods: plan.methods, cash, carry: carryItems(state, ctx.now, date, plan), footer: footerOf(plan, next), next,
    ...(check ? { check } : {}),
    ...(plan.blocked ? { blocked: plan.blocked } : {}),
    ...(confirmLine ? { confirm: { title: next.label, line: confirmLine } } : {}),
    ...(next.kind === 'close' ? closeCommand(plan) : {}),
  };
}

// ── 명령 ────────────────────────────────────────────────────────────

const closedOn = (state: FxState, date: string) => state.closings.some((c) => c.date === date);

/**
 * 차량 현금 인계(cash.transfer, 기사 → 넘기는 중 돈통): 매장 입고 때 기사가 봉투를 건넨다(이야기 23:48). 연결이 필요하다. 그 영업일을
 * 마감한 뒤의 인계는 다음 열린 날의 것이다(postingDate).
 */
export function transferCash(state: FxState, envelope: CommandEnvelope<'cash.transfer'>, now: number): Result {
  const p = envelope.payload;
  const amount = Math.floor(p.amount);
  if (!VEHICLES.some((v) => v.id === p.vehicleId) || !(amount > 0)) return rejected('체험판 미지원');
  state.cashTransfers.push({ id: envelope.requestId, vehicleId: p.vehicleId, amount, at: now });
  return done;
}

/**
 * 차량 현금 점검(cash.transfer_confirm): 카운터가 인계 봉투를 세고 확인한다(넘기는 중 → 카운터 돈통 센 금액, 차액은 과부족 돈통).
 * 아직 인계하지 않은 지갑(`van:v1`)이면 그 자리에서 인계와 확인을 함께 적는다. 창이 본 예상(expectedCash)이 지금과 다르면 충돌,
 * 차액이 있으면 사유가 있어야 한다. 한 번 확인한 인계는 다시 세지 않는다(재점검 없음, spec 3-7).
 */
export function confirmTransfer(state: FxState, envelope: CommandEnvelope<'cash.transfer_confirm'>, now: number): Result {
  const p = envelope.payload;
  // 마감한 영업일 뒤의 점검은 다음 열린 날의 차량 지갑 · 인계를 센다(postingDate).
  const date = postingDate(state, now);
  const found = state.cashTransfers.find((t) => t.id === p.transferId);
  const vehicleId = found ? found.vehicleId : walletVehicle(p.transferId);
  if (!vehicleId) return rejected('체험판 미지원');
  if (found?.confirmed) return nothing('점검 완료');
  const expected = found ? found.amount : walletLeft(state, date, vehicleId);
  if (!found && expected <= 0) return nothing('점검 완료');
  if (envelope.expect?.expectedCash?.[p.transferId] !== expected) return conflict('CASH_CHANGED', '예상 현금 변경됨 · 재점검 필요');
  const counted = Math.floor(p.countedAmount);
  if (!(counted >= 0)) return rejected('체험판 미지원');
  if (!reasonOk(counted - expected, p.reasonKey, p.reasonNote)) return rejected('차액 ' + diffWon(counted - expected) + ' · 사유 선택');
  const transfer = found ?? { id: envelope.requestId, vehicleId, amount: expected, at: now };
  if (!found) state.cashTransfers.push(transfer);
  const reason = counted !== expected && p.reasonKey ? { reasonKey: p.reasonKey, ...(p.reasonNote ? { reasonNote: p.reasonNote.trim() } : {}) } : {};
  transfer.confirmed = { at: now, countedAmount: counted, ...reason };
  return done;
}

/**
 * 마감(closing.close, data-model 4-13): 그 영업일을 닫는다. 보낼 것이 남은 기사 기기가 있거나, 확인 · 이월하지 않은 차량 봉투가 있거나,
 * 돈통을 세지 않았거나, 차액에 사유가 없으면 거절. 창이 본 돈통 예상(expectedCash.counter)이 지금과 다르면 충돌. 돈통 셈 · 이월한 봉투와
 * 그때의 화면 줄(결제 수단 · 현금 점검 · 이월 항목)을 얼린다. 안 돌아온 권의 보증금 정리(unreturned_after_days)는 반납 일정 다음 영업일의
 * 마감 몫이라 이 날(26일)에는 없다(체험 자료에 27일이 없다, plan §8).
 */
export function closeDay(state: FxState, envelope: CommandEnvelope<'closing.close'>, now: number): Result {
  const p = envelope.payload;
  if (p.date !== state.businessDate) return rejected('체험판 미지원');
  if (closedOn(state, p.date)) return nothing(monthDay(p.date) + ' ' + CLOSE + ' 완료');
  const plan = closingPlan(state, p.date, { counts: p.drawerCounts, deferredTransferIds: p.deferredTransferIds });
  if (plan.blocked) return rejected(plan.blocked);
  if (plan.pendingVans.length) return rejected(VAN_CHECK + ' 필요');
  if (!plan.count || plan.countStale) return rejected(DRAWER_CHECK + ' 필요');
  if (envelope.expect?.expectedCash?.[COUNTER] !== plan.counter.amount) return conflict('CASH_CHANGED', '예상 현금 변경됨 · 재점검 필요');
  const diff = plan.count.countedAmount - plan.counter.amount;
  if (!plan.countReady) return rejected('차액 ' + diffWon(diff) + ' · 사유 선택');
  const reason = diff !== 0 && plan.count.reasonKey ? { reasonKey: plan.count.reasonKey, ...(plan.count.reasonNote ? { reasonNote: plan.count.reasonNote } : {}) } : {};
  state.closings.push({
    date: p.date,
    closedAt: now,
    counts: [{ drawerId: COUNTER, expected: plan.counter.amount, counted: plan.count.countedAmount, ...reason }],
    deferredTransferIds: plan.vans.filter((x) => x.deferred).map((x) => x.key),
    sheet: frozenSheet(state, now, plan),
  });
  return done;
}

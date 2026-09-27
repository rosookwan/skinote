// 확인 필요(features-1 §9, E18 · E23 · sync 4-3 · 8-12): 머리줄 메뉴 `확인 필요`의 목록(reviewList), 저장하는 확인 필요(보냄 대기로 온 기사 기록이
// 카운터에 밀린 것), `확인`(review.resolve), 초과 수납의 환불 창(refundSheet), 마감의 막는 단계(van_unsynced).
//   - 저장된 것(stored, ShopState.reviews ↔ review_items): 지난 일을 적은 것. 보냄 대기로 온 수거가 이미 매장에 반납된 것(already_returned) · 남은 것보다
//     많은 것(collect_exceeds), 접수 취소 뒤에 온 기사 기록(task_cancelled), 견본 자료(import). 사람이 `확인`으로 끝낸다.
//   - 지금 상태에서 센 것(derived): 초과 수납 · 미입고 · 차량 예비권 기록 부족. 고치면(환불 · 매장 입고 · 예비권 적재) 스스로 사라진다.
//   - 알림(notice): 늦은 반납 · 긴급 요청 · 방문 결과. 머리줄 알림 종에만.
// 메뉴의 수 = 열린 저장된 것 + 지금 상태에서 센 것. 문장은 시드 틀(REVIEW_TEMPLATES)이나 세는 말 틀(REVIEW_COUNT_TEMPLATES)로 그리고, 줄의 조각은
// ` · `로 나눠 사실(첫 조각)은 빠지지 않고 뒤 조각(할 일)부터 빠진다. 화면은 셈하지 않는다.
import {
  DomainError, REVIEW_TEMPLATES, reviewMessage, type AnyCommandEnvelope, type CommandEnvelope, type FitPart, type RefundSheetParams, type RefundSheetView,
  type ReviewChoice, type ReviewItem, type ReviewListView,
} from '@skinote/contract';
import { notReceived, notReceivedText } from './closing.ts';
import { pickRefunds, refundLineViews } from './discounts.ts';
import { payMethodOf } from './catalog.ts';
import { deliverDone } from './driver.ts';
import { linesOf } from './lines.ts';
import type { FxLine, FxOrder, FxReview, ShopState } from './model.ts';
import { countWordOf } from './promise-sheet.ts';
import { currentReturn, type FxTask } from './promises.ts';
import { nothing, rejected, type Result } from './result.ts';
import {
  charged, collectDone, findOrder, isCancelledOrder, liveQty, nextDue, openPins, orderIdOfTask, overpaid, paidTotal, pinTask, placeLabel, vehicleLabel,
  visitOutcomeLabel,
} from './rules.ts';
import { businessDateOf, hm, iso, shopCutoff, when } from './time.ts';
import type { ViewContext } from './views.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';
const amountText = (n: number) => Math.round(n).toLocaleString('ko-KR');

/** 확인 필요 화면 · 버튼 · 창의 말(문구 표 3-20 `확인 필요`). */
export const REVIEW_WORDS = Object.freeze({
  title: '확인 필요',
  tabOpen: '미처리',
  tabDone: '처리 완료',
  emptyOpen: '미처리 없음',
  emptyDone: '처리 완료 없음',
  resolve: '확인',
  slip: '접수증',
  refund: '환불',
  collections: '수거 목록',
  spareLoad: '예비권 적재',
  tickets: '리프트권',
  resolved: '확인 완료',
  noTarget: '확인 대상 없음',
  noRefund: '환불 대상 없음',
  overpaid: '초과 수납',
});

/** 끝낸 방법(review_items.resolution_key, code-owned): 확인. */
export const REVIEW_RESOLUTIONS = ['acknowledged'] as const;

/** 명령을 한 사람(서버: 세션의 직원 · 기기, 메모리 어댑터: 없음). */
export interface ReviewActor {
  staffId?: string;
  name?: string;
  deviceId?: string;
}

const inside = (state: ShopState, id: string) => (state.reviews ?? []).some((r) => r.id === id);

/** 저장된 확인 필요 한 건을 더한다(문장은 종류의 틀로 그린다). */
function storeReview(state: ShopState, review: Omit<FxReview, 'message' | 'status'>): FxReview {
  const message = reviewMessage(review.kindKey, review.params);
  const row: FxReview = { ...review, message, status: 'open' };
  if (!inside(state, row.id)) state.reviews = [...(state.reviews ?? []), row];
  return row;
}

// ── 저장하는 확인 필요(보냄 대기로 온 기사 기록, E18 · E20 · E23) ────────────────────────

/** 수거 한 줄의 계획(commands.ts planStock의 결과 모양). */
interface CollectPick {
  l: FxLine;
  qty: number;
}

/**
 * 보냄 대기로 온 수거(stock.collect, deviceSeq 있음)가 남은 것보다 많이 받았다고 할 때(E18): 그 줄이 그사이 매장에서 반납됐으면 줄마다
 * `already_returned`(`최은정 팀 스키 1대 매장 반납 완료 · 기사 수거 기록 제외`), 그래도 남는 몫(분실 처리를 되돌린 몫을 넘은 것, E20)은 팀에 한 건
 * `collect_exceeds`(`… 팀 수거 3개 · 대여 중 2개 · 2개만 반영`). 적은 수는 기록이 가진 것만(움직인 것은 명령이 적는다). 같은 요청번호의 재시도는
 * 명령 결과가 막는다(한 번만).
 */
export function collectReviews(
  state: ShopState, envelope: CommandEnvelope<'stock.collect'>, task: FxTask, asked: ReadonlyMap<string, number>, picks: readonly CollectPick[], now: number,
  actor: ReviewActor | undefined,
): FxReview[] {
  if (envelope.deviceSeq === undefined) return [];
  const o = task.order;
  const base = (n: number) => ({
    id: envelope.requestId + ':r' + n, orderId: o.id, taskId: task.id, source: 'sync' as const, createdAt: now,
    ...(actor?.deviceId ? { targetDeviceId: actor.deviceId } : {}),
  });
  const out: FxReview[] = [];
  let askedAll = 0;
  let tookAll = 0;
  let unexplained = 0;
  const units = new Set<string>();
  for (const l of o.lines) {
    const want = asked.get(l.id) ?? 0;
    if (want <= 0) continue;
    const took = picks.filter((x) => x.l.id === l.id).reduce((sum, x) => sum + x.qty, 0);
    askedAll += want;
    tookAll += took;
    units.add(countWordOf(l));
    const excess = Math.max(0, want - took);
    if (excess === 0) continue;
    // 매장에서 직접 반납한 수(그사이 카운터가 받은 것)까지는 `이미 반납`, 그 밖은 수거 수량 확인.
    const returnedHere = Math.min(excess, l.returned);
    if (returnedHere > 0) {
      out.push(storeReview(state, {
        ...base(out.length + 1), kindKey: 'already_returned', params: { team: o.teamName, item: l.shortLabel, qty: returnedHere, unit: countWordOf(l) },
      }));
    }
    unexplained += excess - returnedHere;
  }
  if (unexplained > 0) {
    const unit = units.size === 1 ? [...units][0]! : '개';
    out.push(storeReview(state, { ...base(out.length + 1), kindKey: 'collect_exceeds', params: { team: o.teamName, qty: askedAll, left: tookAll, unit } }));
  }
  return out;
}

/** 보냄 대기로 온 기사 기록 중 접수 취소 뒤에 적히는 것(E23): 배달 · 방문 결과 · 현장 수납 · 리프트권 추가. */
const TASK_FACTS = new Set<AnyCommandEnvelope['type']>(['stock.deliver', 'task.visit', 'field.collect', 'field.add_ticket']);

/**
 * 취소한 접수 · 줄에 온 기사 기록(E23, 적용한 뒤에 부른다): 사실은 적고(facts win) 팀에 한 건 `task_cancelled`(`{팀} 팀 업무 취소 후 기사 기록 수신`).
 * 접수를 모두 취소했거나, 배달이 살아 있는 수보다 많이 건넸을 때(취소한 줄의 몫).
 */
export function cancelledTaskReview(state: ShopState, envelope: AnyCommandEnvelope, now: number, actor: ReviewActor | undefined): FxReview | null {
  if (envelope.deviceSeq === undefined || !TASK_FACTS.has(envelope.type)) return null;
  const taskId = (envelope.payload as { taskId?: string }).taskId;
  const o = findOrder(state, taskId ? orderIdOfTask(taskId) : undefined);
  if (!o || !(o.cancellations?.length)) return null;
  const cancelled = isCancelledOrder(o) || (envelope.type === 'stock.deliver' && o.lines.some((l) => l.issued > liveQty(l)));
  if (!cancelled) return null;
  return storeReview(state, {
    id: envelope.requestId + ':r1', kindKey: 'task_cancelled', params: { team: o.teamName }, orderId: o.id, ...(taskId ? { taskId } : {}), source: 'sync',
    createdAt: now, ...(actor?.deviceId ? { targetDeviceId: actor.deviceId } : {}),
  });
}

// ── 확인(review.resolve) ──────────────────────────────────────────────

/**
 * 확인 필요 한 건을 끝낸다(review.resolve, intent): 방법 · 때 · 누가(명령을 한 사람). 없는 것은 거절(`확인 대상 없음`), 이미 끝낸 것은 된 것으로
 * (`확인 완료`, 다른 사람이 먼저 누름). 지금 상태에서 센 것(초과 수납 …)은 저장된 것이 아니라 끝낼 수 없다(고치면 사라진다).
 */
export function resolveReview(state: ShopState, envelope: CommandEnvelope<'review.resolve'>, now: number, actor: ReviewActor | undefined): Result {
  const p = envelope.payload;
  const review = (state.reviews ?? []).find((r) => r.id === p.reviewId);
  if (!review) return rejected(REVIEW_WORDS.noTarget);
  if (!(REVIEW_RESOLUTIONS as readonly string[]).includes(p.resolutionKey)) return rejected(REVIEW_WORDS.noTarget);
  if (review.status === 'resolved') return nothing(REVIEW_WORDS.resolved);
  review.status = 'resolved';
  review.resolution = { key: p.resolutionKey, at: now, ...(actor?.name ? { byName: actor.name } : {}) };
  return { outcome: 'applied', result: { reviewId: review.id } };
}

// ── 목록(reviewList) ─────────────────────────────────────────────────

/** 문장 → 맞춤 조각: 첫 조각(사실)은 빠지지 않고, 뒤 조각일수록 먼저 빠진다(할 일). */
export function reviewParts(message: string): FitPart[] {
  return message.split(' · ').map((text, i) => ({ text, drop: i }));
}

const severityOf = (kindKey: string): ReviewItem['severity'] => REVIEW_TEMPLATES[kindKey]?.severity ?? 'action';
const allowed = (ctx: ViewContext, permission: string) => !ctx.viewer || ctx.viewer.permissions.includes(permission);

/** 권한이 없으면 누를 수 없고 까닭(`권한 없음 · 관리자 확인 필요`). */
function gated(ctx: ViewContext, choice: Omit<ReviewChoice, 'enabled'>, permission: string): ReviewChoice {
  return allowed(ctx, permission) ? { ...choice, enabled: true } : { ...choice, enabled: false, reason: linesOf(ctx).forbidden };
}

const slipChoice = (ctx: ViewContext, orderId: string | undefined): ReviewChoice[] =>
  orderId && findOrder(ctx.state, orderId) ? [{ key: 'slip', label: REVIEW_WORDS.slip, enabled: true, orderId }] : [];

/** 저장된 것 한 건: 열린 것은 `확인` · `접수증`, 끝낸 것은 옅은 줄과 `확인 완료 · 16:20 · 한가람`. */
function storedItem(ctx: ViewContext, r: FxReview): ReviewItem {
  const base: ReviewItem = {
    id: r.id, kindKey: r.kindKey, message: r.message, parts: reviewParts(r.message), severity: severityOf(r.kindKey), createdAt: iso(r.createdAt),
    ...(r.orderId ? { orderId: r.orderId } : {}), ...(r.taskId ? { taskId: r.taskId } : {}), source: 'stored', status: r.status,
  };
  if (r.status === 'resolved') {
    const at = r.resolution?.at ?? r.createdAt;
    return { ...base, tone: 'muted', resolvedLine: [REVIEW_WORDS.resolved, hm(at), ...(r.resolution?.byName ? [r.resolution.byName] : [])].join(' · ') };
  }
  const resolve = gated(ctx, {
    key: 'resolve', label: REVIEW_WORDS.resolve, command: { type: 'review.resolve', payload: { reviewId: r.id, resolutionKey: 'acknowledged' } },
  }, 'review.resolve');
  return { ...base, choices: [resolve, ...slipChoice(ctx, r.orderId)] };
}

/** 지금 상태에서 센 것(초과 수납 · 미입고 · 차량 예비권 기록 부족): 고치면 사라진다. */
function derivedItems(ctx: ViewContext): ReviewItem[] {
  const { state } = ctx;
  const out: ReviewItem[] = [];
  // 매장 입고 뒤에도 차에 남은 것(부분 입고 · 취소한 배달의 차에 남은 것, closing.ts): 마감의 이월 항목 `확인 필요`와 같은 것.
  for (const x of notReceived(state, state.businessDate)) {
    const message = x.o.teamName + ' 팀 ' + notReceivedText(x.l, x.qty);
    out.push({
      id: 'unreceived:' + x.l.id, kindKey: 'not_received', message, parts: reviewParts(message), severity: 'action', createdAt: iso(x.at), orderId: x.o.id, source: 'derived',
      choices: [
        { key: 'collections', label: REVIEW_WORDS.collections, enabled: true, date: state.businessDate, ...(x.vehicleId ? { vehicleId: x.vehicleId } : {}) },
        ...slipChoice(ctx, x.o.id),
      ],
    });
  }
  // 초과 수납(sys_review_kinds overpaid): 보냄 대기로 온 현장 수납은 기기에서 이미 받은 돈이라 받을 돈보다 많아도 적는다(driver.ts). 환불하면 사라진다.
  for (const o of state.orders) {
    const over = paidTotal(o) - charged(o);
    if (over <= 0) continue;
    const last = o.payments.reduce((max, p) => Math.max(max, p.at), 0);
    const message = reviewMessage('overpaid', { team: o.teamName, amount: amountText(over) });
    out.push({
      id: 'overpaid:' + o.id, kindKey: 'overpaid', message, parts: reviewParts(message), severity: 'action', createdAt: iso(last), orderId: o.id, source: 'derived',
      choices: [gated(ctx, { key: 'refund', label: REVIEW_WORDS.refund + ' · ' + won(over), orderId: o.id }, 'payment.refund'), ...slipChoice(ctx, o.id)],
    });
  }
  // 차량 예비권 기록 부족(sys_review_kinds ticket_unavailable 자리): 끊긴 기사 기기가 기록된 차량 재고보다 많이 건넨 권(driver.ts addTicket). 건넨 사실은
  // 적었고 기록이 모자란 것이라 사람이 차량 재고를 센다(예비권 적재로 채우면 사라진다). 문구는 wording.md 3-18.
  for (const x of state.vanSpares ?? []) {
    if (x.quantity >= 0) continue;
    const product = state.registry.products[x.productKey];
    const message = vehicleLabel(state.registry, x.vehicleId) + ' ' + (product?.shortLabel ?? product?.label ?? x.productKey) + ' 재고 기록 부족 ' + -x.quantity
      + (product?.unit ?? '매') + ' · 차량 재고 확인';
    out.push({
      id: 'van_spare:' + x.vehicleId + ':' + x.productKey, kindKey: 'ticket_unavailable', message, parts: reviewParts(message), severity: 'action', createdAt: iso(ctx.now),
      source: 'derived',
      choices: [
        gated(ctx, { key: 'spare_load', label: REVIEW_WORDS.spareLoad, vehicleId: x.vehicleId }, 'stock.move'),
        { key: 'tickets', label: REVIEW_WORDS.tickets, enabled: true },
      ],
    });
  }
  return out;
}

/** 알림(머리줄 알림 종): 늦은 반납 · 긴급 요청 · 방문 결과. */
function noticeItems(ctx: ViewContext): ReviewItem[] {
  const { state } = ctx;
  const whenIn = (ms: number) => when(ms, state.businessDate, shopCutoff(state.settings));
  const out: ReviewItem[] = [];
  for (const o of state.orders) {
    const due = nextDue(state, o);
    if (due?.kind === 'return' && due.lateAt !== undefined && due.lateAt <= ctx.now) {
      out.push({
        id: 'late:' + o.id, kindKey: 'late_return', severity: 'action', createdAt: iso(due.lateAt), orderId: o.id, source: 'notice',
        message: o.teamName + ' 팀 반납 지연 · ' + whenIn(due.at) + ' ' + (currentReturn(o).mode === 'store' ? '매장' : placeLabel(state.registry, currentReturn(o).placeId)),
      });
    }
  }
  for (const p of openPins(state)) {
    const o = findOrder(state, p.orderId);
    if (!o || p.status === 'acknowledged') continue;
    const place = pinTask(state, p)?.promise.placeId ?? o.giveBack.placeId;
    out.push({
      id: 'pin:' + p.id, kindKey: 'pin', severity: 'info', createdAt: iso(p.at), orderId: o.id, source: 'notice',
      message: o.teamName + ' 팀 ' + (p.note ? p.note + ' · ' : '') + hm(p.at) + ' ' + placeLabel(state.registry, place) + ' · 긴급 요청',
    });
  }
  for (const o of state.orders) {
    const visit = o.visits?.at(-1);
    // 배달 실패는 건넬 때까지, 수거 실패는 받을 때까지 남는다.
    if (!visit || (visit.kind === 'deliver' ? deliverDone(o) : collectDone(o))) continue;
    out.push({
      id: 'visit:' + o.id + ':' + visit.at, kindKey: 'visit_result', severity: 'info', createdAt: iso(visit.at), orderId: o.id, source: 'notice',
      message: o.teamName + ' 팀 ' + visitOutcomeLabel(state.registry, visit.outcomeKey) + (visit.retryAt !== undefined ? ' · 재방문 ' + whenIn(visit.retryAt) : ''),
    });
  }
  return out;
}

/** 열린 확인 필요의 수(메뉴 `확인 필요`의 수): 열린 저장된 것 + 지금 상태에서 센 것. */
export function reviewCount(ctx: ViewContext): number {
  return (ctx.state.reviews ?? []).filter((r) => r.status === 'open').length + derivedItems(ctx).length;
}

/**
 * 확인 필요 목록(머리줄 메뉴, #/review): 열린 것(먼저 적힌 것부터) · 오늘 영업일에 끝낸 저장된 것(늦게 끝낸 것부터) · 알림 · 메뉴의 수.
 */
export function reviewList(ctx: ViewContext): ReviewListView {
  const { state } = ctx;
  const stored = state.reviews ?? [];
  const byTime = (a: ReviewItem, b: ReviewItem) => a.createdAt.localeCompare(b.createdAt);
  const items = [...stored.filter((r) => r.status === 'open').map((r) => storedItem(ctx, r)), ...derivedItems(ctx)].sort(byTime);
  const cutoff = shopCutoff(state.settings);
  const done = stored
    .filter((r) => r.status === 'resolved' && businessDateOf(r.resolution?.at ?? r.createdAt, cutoff) === state.businessDate)
    .sort((a, b) => (b.resolution?.at ?? 0) - (a.resolution?.at ?? 0))
    .map((r) => storedItem(ctx, r));
  return {
    basis: { epoch: state.epoch, rev: state.rev }, serverTime: iso(ctx.now), currentBusinessDate: state.businessDate,
    title: REVIEW_WORDS.title,
    tabs: [{ key: 'open', label: REVIEW_WORDS.tabOpen, count: items.length }, { key: 'done', label: REVIEW_WORDS.tabDone }],
    items, done, notices: noticeItems(ctx), count: items.length,
    empty: { open: REVIEW_WORDS.emptyOpen, done: REVIEW_WORDS.emptyDone },
  };
}

// ── 초과 수납의 환불 창(refundSheet) ─────────────────────────────────────

/**
 * 초과 수납의 `환불 · {금액}` 창(features-1 §9-1): 더 받은 돈을 늦게 받은 수납부터 나눈 환불 줄(수납마다 원래 수단 · 현금, 카드면 `단말기 취소`), 요약
 * `초과 수납 10,000원 · 환불 10,000원`, 주 버튼 `환불 · 현금 10,000원`, 명령 payment.refund(cause 'overpaid')와 바탕(expect.refundAmount).
 */
export function refundSheet(ctx: ViewContext, params: RefundSheetParams): RefundSheetView {
  const { state } = ctx;
  const o: FxOrder | undefined = findOrder(state, params.orderId);
  if (!o) throw new DomainError('NOT_FOUND', '없는 접수: ' + params.orderId);
  const reg = state.registry;
  const over = overpaid(o);
  const { picks, short } = pickRefunds(reg, o, over, () => 0, params.methods ?? {}, undefined, ctx.viewer);
  const { lines } = refundLineViews(reg, o, picks, short);
  const total = picks.reduce((sum, x) => sum + x.amount, 0);
  const head = { basis: { epoch: state.epoch, rev: state.rev }, serverTime: iso(ctx.now), currentBusinessDate: state.businessDate };
  const title = REVIEW_WORDS.refund + ' · ' + o.teamName + ' 팀';
  const summary = [{ text: REVIEW_WORDS.overpaid + ' ' + won(over) + ' · ' }, { text: REVIEW_WORDS.refund + ' ' + won(total), strong: true }];
  if (total <= 0) {
    return { ...head, title, refunds: lines, summary, notice: REVIEW_WORDS.noRefund, primary: { label: REVIEW_WORDS.refund, alts: [REVIEW_WORDS.refund], enabled: false } };
  }
  const methods = new Set(picks.map((x) => x.methodKey));
  const methodLabel = methods.size === 1 ? payMethodOf(reg, [...methods][0]!)?.label : undefined;
  const plain = REVIEW_WORDS.refund + ' · ' + won(total);
  const label = methodLabel ? REVIEW_WORDS.refund + ' · ' + methodLabel + ' ' + won(total) : plain;
  return {
    ...head, title, refunds: lines, summary,
    primary: { label, alts: [...new Set([label, plain, REVIEW_WORDS.refund])], enabled: true },
    command: {
      type: 'payment.refund',
      payload: { orderId: o.id, cause: 'overpaid', refunds: picks.map((x) => ({ paymentId: x.payment.id, methodKey: x.methodKey, amount: x.amount })) },
    },
    expect: { refundAmount: total },
  };
}

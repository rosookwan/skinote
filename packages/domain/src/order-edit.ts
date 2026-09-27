// 접수 취소 · 품목 취소 · 품목 추가(work/impl-features-1/plan.md §5, E5 · E6 · E7 · E8 · E9 · E22 · E23).
//   - order.cancel: 접수 전체(손님에게 있는 것이 없을 때, 취소할 수 모두) 또는 품목 수량(지급 전 · 차에 실린 것 · 돌아온 것). 줄마다 취소 값 = 줄의
//     남은 청구(줄 값 + 연장 + 앞 취소) × 취소한 수 ÷ 살아 있는 수(10원 내림, 마지막 남은 수는 나머지), cancellation 조정(음수). 같은 명령에서 칸의
//     할인을 살아 있는 값으로 다시 센다(E9: 비율은 살아 있는 값의 %, 금액은 min(금액, 살아 있는 값)). 비운 돈(취소한 줄 · 그 칸에 묶인 돈이 청구를
//     넘은 몫 + 접수 전체 수납이 남긴 몫)의 결정: 환불(창이 이어서 payment.refund) · 미수 결제(돈은 그대로, 묶인 수납을 접수 전체로 옮김 = released) ·
//     환불 없음(줄마다 cancellation_fee = 그 줄에서 비운 돈) · 해당 없음(비운 돈 없음). 접수 취소는 이 팀을 결제 팀으로 둔 팀의 결제 예정을 푼다.
//     차에 실린 채 취소한 것은 `차에 남은 것`(leftover)이고 매장 입고(stock.receive에 배달 업무)로 내려놓는다.
//   - 창(cancelSheet): 수량 −/+ · 구분 · 환불 결정 · 환불 줄(수납마다 원래 수단 또는 현금) · 요약 · 주 버튼 · 명령(취소 → 환불).
//   - order.add: 품목 추가(새 차수, 접수의 일정 · 결제 팀, 칸마다 지금 받기 · 후불, 할인 고르기 없음). 칸의 비율 할인은 새 줄에도(대신하는 적용),
//     금액 할인은 새 줄에 적용하지 않는다(E9). 접수의 대여 날 수로 값을 센다.
// 화면 글은 docs/design/wording.md 3-20(확인 대기)의 말이다.
import {
  CHECKOUT_KEYS, DomainError, type CancelDecision, type CancelReasonKey, type CancelScope, type CancelSheetParams, type CancelSheetView,
  type CheckoutChoice, type CheckoutSection, type CheckoutSheetParams, type CheckoutSheetView, type ChoiceOption, type CommandEnvelope, type ConfirmStep, type DraftItem,
  type FitPart, type LineUnits, type RefundInput, type RefundLineView, type ReturnPieceLine, type RichText, type SlipAdjustment,
} from '@skinote/contract';
import { CANCEL_WORDS, cancellationLabel, reasonLabel } from './cancel-words.ts';
import { swapAdjustments } from './exchange.ts';
import { lossAdjustments } from './tickets.ts';
import { cleanItems, discountedAmounts, kindOf, liftReturnable, lineNames, manualDiscountAmount, payMethodOf, quoteOf, variantOf, type QuoteLine } from './catalog.ts';
import {
  currentApplication, lineDiscountNow, manualAllowed, manualWithinLimit, pickRefunds, refundLineViews, ruleAllowed, sectionGross, sectionLines, sharesOf,
  type DiscountViewer, type PaymentRefundPick,
} from './discounts.ts';
import type { DomainLines, FxCancellation, FxDiscountApplication, FxLine, FxMethodKey, FxOrder, FxPayment, FxPaymentGroup, FxSection, ShopRegistry, ShopState } from './model.ts';
import { baseRefundKey, depositReturnable, heldAmount, heldUnits, takenMethod } from './deposits.ts';
import { cancelExtensionDays, lineDayPrice } from './extension.ts';
import { dayCount } from './order-draft.ts';
import { lineBuckets } from './promises.ts';
import { conflict, rejected, unsupported, type Result } from './result.ts';
import {
  cancelPart, cancelledShare, cancellationFreed, cancellationRemoved, cancellableQty, findOrder, isCancelledOrder, lineCancels, lineFill, lineRemaining, liveGross, liveQty,
  orderCancellable, outQty, overpaid, ownDue, vanLoaded,
} from './rules.ts';
import { businessDateOf, hm, iso, shopCutoff } from './time.ts';
import type { ViewContext } from './views.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';
const countWord = (l: FxLine) => l.countWord ?? l.unit ?? '개';

// ── 취소의 셈(창과 명령이 함께 쓴다) ─────────────────────────────────────

interface CancelLine {
  l: FxLine;
  quantity: number;
  /** 청구에서 뺀 돈(양수). */
  amount: number;
}

interface CancelPlan {
  scope: CancelScope;
  reasonKey: CancelReasonKey;
  lines: CancelLine[];
  /** 막힌 까닭(`취소 불가 · 미반납 스키 2`). */
  refusal?: string;
  /** 청구에서 뺀 돈 합. */
  total: number;
  /** 취소를 적용한 뒤의 접수(복사본: 결정 전 — 환불 · 환불 없음 · 미수 결제 없이). */
  after: FxOrder;
  cancellation: FxCancellation;
  /** 이 취소가 비운 돈. */
  freed: number;
  /** 고를 수 있는 결정(비운 돈이 없으면 빈 목록 = 해당 없음). */
  decisions: Exclude<CancelDecision, 'not_applicable'>[];
  /** 처음 결정(E8). */
  decisionDefault: CancelDecision;
  /** 결제 예정을 풀 팀(접수 취소, 이 팀을 결제 팀으로 둔 팀). */
  released: FxOrder[];
}

/** 품목 한 조각(`헬멧 1` · `의류 사이즈 95 2`). */
function itemText(reg: ShopRegistry, l: FxLine, qty: number): string {
  const names = lineNames(reg, l);
  return (names.variant ? names.name + ' ' + names.variant : l.shortLabel) + ' ' + qty + (l.unit ?? '');
}

/** 품목 목록(`헬멧 1 · 스키 2`, 셋 이상은 `헬멧 1 외 2종`). */
function itemsText(reg: ShopRegistry, picks: readonly { l: FxLine; qty: number }[]): string {
  const shown = picks.filter((x) => x.qty > 0);
  if (!shown.length) return '';
  if (shown.length <= 2) return shown.map((x) => itemText(reg, x.l, x.qty)).join(' · ');
  return itemText(reg, shown[0]!.l, shown[0]!.qty) + ' 외 ' + (shown.length - 1) + '종';
}

/** 모두 취소할 수 없는 까닭: 손님에게 있는 것(`취소 불가 · 미반납 스키 2`) 또는 차에 실린 번호 줄. */
function refusalOf(reg: ShopRegistry, o: FxOrder): string {
  const out = o.lines.map((l) => ({ l, qty: outQty(l) })).filter((x) => x.qty > 0);
  if (out.length) return CANCEL_WORDS.notCancellable + ' ' + itemsText(reg, out);
  const loaded = o.lines.map((l) => ({ l, qty: vanLoaded(l) })).filter((x) => x.qty > 0);
  return CANCEL_WORDS.loadedRefusal + ' ' + itemsText(reg, loaded);
}

/**
 * 줄 하나의 나눈 일정(일정 변경)을 반납 쪽의 수에 맞춘다(취소 뒤, E6 · plan §5-1: 원래 일정부터, 그다음 나눈 일정은 늦게 만든 것부터). 원래 일정 몫의
 * 지급한 수는 그대로 두고, 넘치는 나눈 일정 몫을 그 일정의 지급하지 않은 수만큼 줄인다(0이면 뺀다).
 */
function shrinkSplits(o: FxOrder, l: FxLine, before: ReturnType<typeof lineBuckets>): void {
  const splits = (o.splits ?? []).filter((s) => s.lineId === l.id && s.quantity > 0);
  if (!splits.length) return;
  const mainIssued = before.find((b) => b.key === null)?.issued ?? 0;
  const room = Math.max(0, Math.max(liveQty(l), l.issued) - mainIssued);
  let excess = splits.reduce((sum, s) => sum + s.quantity, 0) - room;
  for (const s of [...splits].reverse()) {
    if (excess <= 0) break;
    const issued = before.find((b) => b.key === s.id)?.issued ?? 0;
    const take = Math.min(excess, Math.max(0, s.quantity - issued));
    s.quantity -= take;
    excess -= take;
  }
  o.splits = (o.splits ?? []).filter((s) => s.quantity > 0);
}

/**
 * 칸의 할인을 살아 있는 값으로 다시 센다(E9): 비율은 살아 있는 값의 %, 금액은 min(금액, 살아 있는 값). 바뀐 줄이 있으면 대신하는 적용 한 건과 할인
 * 변경 조정(차이, 줄마다 몫). 새 적용 id = `${id}:d<칸>`.
 */
function rebaseDiscounts(reg: ShopRegistry, o: FxOrder, id: string, now: number, sections: ReadonlySet<FxSection>): void {
  for (const s of reg.paySections) {
    // 취소한 줄이 있는 칸만 다시 센다: 다른 칸(기사가 더한 권 · 이미 받은 값)의 청구를 조용히 바꾸지 않는다(2026-09-27 점검).
    if (!sections.has(s.key)) continue;
    const current = currentApplication(o, s.key);
    if (!current || current.kind === 'none' || current.value === undefined) continue;
    // 할인을 받은 적이 있는 줄만(접수 때 할인 · 할인 변경의 몫): 기사가 요금표 값으로 더한 권은 할인 밖이다(field.add_ticket).
    const lines = sectionLines(o, s.key).filter((l) => l.gross !== undefined || (o.charges ?? []).some((c) => c.kind === 'discount_change' && c.lines.some((x) => x.lineId === l.id)));
    const gross = lines.reduce((sum, l) => sum + liveGross(o, l), 0);
    const percent = current.kind === 'percent' || current.kind === 'manual_percent';
    const target = manualDiscountAmount(gross, { kind: percent ? 'percent' : 'amount', value: current.value });
    const shares = sharesOf(o, lines, target);
    const parts = lines.map((l, i) => ({ lineId: l.id, amount: lineDiscountNow(o, l) - shares[i]! })).filter((x) => x.amount !== 0);
    // 취소가 할인 몫을 함께 뺐으면(접수 때 할인) 조정 없이 새 금액만 적는다: 칸의 마지막 적용 = 그 칸의 지금 할인(plan §3-2 assert 4).
    if (!parts.length && target === current.amount) continue;
    const appId = id + ':d' + s.key;
    const { id: _id, supersedes: _supersedes, at: _at, amount: _amount, ...rest } = current;
    o.discounts = [...(o.discounts ?? []), { ...rest, id: appId, amount: target, supersedes: current.id, at: now }];
    if (!parts.length) continue;
    o.charges = [...(o.charges ?? []), {
      id: appId + ':dc', kind: 'discount_change', applicationId: appId, section: s.key, amount: parts.reduce((sum, x) => sum + x.amount, 0), lines: parts, at: now,
    }];
  }
}

/**
 * 취소 값(features-1 E5, 2026-09-27 개정): 줄 값의 살아 있는 몫 × 취소한 수 ÷ 살아 있는 수(10원 내림) + 취소한 수가 나온 일정 몫의 연장(늘어난 날 ×
 * 1일 값, 남은 연장까지). 연장은 그 연장을 받은 일정 몫의 수에만 붙는다: 늘리지 않은 원래 일정의 스키를 취소하면 연장 값은 남는다(앞 셈은 연장을 모든
 * 수에 고르게 나눠 남은 스키의 이틀 값이 줄었다). 마지막 남은 수는 남은 청구 전부.
 */
function cancelValue(state: ShopState, o: FxOrder, l: FxLine, quantity: number): number {
  const live = liveQty(l);
  const remaining = lineRemaining(o, l);
  if (quantity >= live) return Math.max(0, remaining);
  const base = l.amount - cancelledShare(l.amount, l.qty, lineCancels(o, l));
  const extLeft = Math.max(0, remaining - base);
  const ext = Math.min(extLeft, Math.round(lineDayPrice(state.registry, l) * cancelExtensionDays(state, o, l, quantity)));
  return Math.max(0, cancelPart(base, quantity, live) + ext);
}

/**
 * 취소의 셈: 줄마다 취소할 수 · 값, 적용한 뒤의 접수(취소 조정 · 살아 있는 수 · 나눈 일정 · 할인 다시 셈), 비운 돈, 고를 수 있는 결정. 접수 취소는
 * 취소할 수 있는 수 모두(손님에게 있는 것이 있으면 까닭), 품목 취소는 고른 수(취소할 수까지).
 */
function cancelPlan(state: ShopState, o: FxOrder, scope: CancelScope, picked: readonly LineUnits[], reasonKey: CancelReasonKey, id: string, now: number): CancelPlan {
  const reg = state.registry;
  const want = new Map<string, number>();
  for (const x of picked) want.set(x.lineId, (want.get(x.lineId) ?? 0) + Math.max(0, Math.floor(x.quantity)));
  const refusal = scope === 'order' && !orderCancellable(o) && !isCancelledOrder(o) ? refusalOf(reg, o) : undefined;
  const after = structuredClone(o);
  const lines: CancelLine[] = [];
  if (!refusal) {
    for (const l of after.lines) {
      const quantity = Math.min(cancellableQty(l), scope === 'order' ? cancellableQty(l) : want.get(l.id) ?? 0);
      if (quantity <= 0) continue;
      const amount = cancelValue(state, after, l, quantity);
      const before = lineBuckets(after, l);
      l.cancelled = (l.cancelled ?? 0) + quantity;
      shrinkSplits(after, l, before);
      lines.push({ l, quantity, amount });
    }
  }
  const cancellation: FxCancellation = {
    id, at: now, scope, reasonKey, decision: 'not_applicable', lines: lines.map((x) => ({ lineId: x.l.id, quantity: x.quantity, amount: x.amount })),
  };
  if (lines.length) {
    after.cancellations = [...(after.cancellations ?? []), cancellation];
    const charges = lines.filter((x) => x.amount > 0).map((x, k) => ({ id: id + ':c' + k, kind: 'cancellation' as const, cancellationId: id, lineId: x.l.id, amount: -x.amount, at: now }));
    if (charges.length) after.charges = [...(after.charges ?? []), ...charges];
    rebaseDiscounts(reg, after, id, now, new Set(lines.map((x) => x.l.section)));
  }
  const total = lines.reduce((sum, x) => sum + x.amount, 0);
  const freed = lines.length ? Math.min(cancellationFreed(after, cancellation), cancellationRemoved(after, cancellation)) : 0;
  const decisions: CancelPlan['decisions'] = freed > 0 ? ['refund', ...(freed > overpaid(after) ? ['apply_to_due' as const] : []), 'no_refund'] : [];
  // 처음 결정(E8): 환불. 매장 설정 `당일 취소 환불`이 환불 없음이면, 이용일 당일 이후의 리프트권 취소와 연락 없음만 환불 없음.
  const cutoff = shopCutoff(state.settings);
  const useDayPassed = businessDateOf(now, cutoff) >= businessDateOf(o.pickup.at, cutoff);
  // 당일 취소 환불은 리프트권 취소와 연락 없음의 설정이다: 장비가 섞인 품목 취소는 환불이 처음 값(2026-09-27 점검, 장비 돈까지 남기지 않게).
  const narrow = reasonKey === 'no_show' || (useDayPassed && lines.length > 0 && lines.every((x) => x.l.section === 'lift'));
  const decisionDefault: CancelDecision = freed <= 0 ? 'not_applicable' : state.settings.sameDayCancelRefund === 'no_refund' && narrow ? 'no_refund' : 'refund';
  // 결제 예정을 푸는 팀: 접수 취소, 또는 품목 취소가 모든 줄을 비운 때(취소 행이 되는 결제 팀은 남의 몫을 낼 수 없다). 줄이 남는 품목 취소는 그대로 둔다.
  const emptied = lines.length > 0 && after.lines.every((l) => liveQty(l) === 0);
  const released = lines.length && (scope === 'order' || emptied)
    ? state.orders.filter((x) => x.id !== o.id && (x.payerOrderId === o.id || x.lines.some((l) => l.payerOrderId === o.id)))
    : [];
  return { scope, reasonKey, lines, ...(refusal ? { refusal } : {}), total, after, cancellation, freed, decisions, decisionDefault, released };
}

/** 취소한 줄 · 칸에 묶인 수납부터(E4b): 취소한 줄에 묶인 수납 → 그 칸의 선입금 → 접수 전체 → 나머지. */
function cancelRank(o: FxOrder, c: FxCancellation): (p: FxPayment) => number {
  const ids = new Set(c.lines.map((x) => x.lineId));
  const sections = new Set(o.lines.filter((l) => ids.has(l.id)).map((l) => l.section));
  return (p) => (p.lines?.length ? (p.lines.some((x) => ids.has(x.lineId)) ? 0 : 3) : p.section === undefined ? 2 : sections.has(p.section) ? 1 : 3);
}

/** 줄에 묶인 수납이 취소한 줄에 채운 돈(그 수납의 환불을 뺀 것): 환불 · 옮김이 그 수납에서 가져갈 수 있는 끝. */
function boundOn(o: FxOrder, p: FxPayment, ids: ReadonlySet<string>): number {
  if (!p.lines?.length) return Number.POSITIVE_INFINITY;
  let n = p.lines.reduce((sum, x) => sum + (ids.has(x.lineId) ? x.amount : 0), 0);
  for (const r of o.refunds ?? []) if (r.refundOf === p.id) n -= (r.lines ?? []).reduce((sum, x) => sum + (ids.has(x.lineId) ? x.amount : 0), 0);
  return Math.max(0, n);
}

/** 비운 돈을 돌려줄 수납(E4b, 두 줄까지 창에): 취소한 줄 · 칸에 묶인 것부터 늦게 받은 것부터. */
function cancelPicks(reg: ShopRegistry, o: FxOrder, c: FxCancellation, amount: number, methods: Readonly<Record<string, string>> = {}, viewer?: DiscountViewer) {
  const ids = new Set(c.lines.map((x) => x.lineId));
  return pickRefunds(reg, o, amount, cancelRank(o, c), methods, (p) => boundOn(o, p, ids), viewer);
}

/** 미수 결제로 접수 전체로 옮길 묶인 돈(취소한 줄에 묶인 수납 → 그 칸의 선입금, 늦게 받은 것부터). */
function releasedOf(o: FxOrder, c: FxCancellation, amount: number): NonNullable<FxCancellation['released']> {
  const fill = lineFill(o);
  const ids = new Set(c.lines.map((x) => x.lineId));
  const lineRoom = [...ids].reduce((sum, id) => sum + (fill.lineExcess.get(id) ?? 0), 0);
  const sections = new Set(o.lines.filter((l) => ids.has(l.id)).map((l) => l.section));
  const sectionRoom = [...sections].reduce((sum, s) => sum + (fill.sectionExcess.get(s) ?? 0), 0);
  const out: NonNullable<FxCancellation['released']> = [];
  let rest = Math.min(amount, lineRoom + sectionRoom);
  const ordered = o.payments.map((p, i) => ({ p, i })).sort((a, b) => b.p.at - a.p.at || b.i - a.i).map((x) => x.p);
  let lineLeft = lineRoom;
  for (const p of ordered) {
    if (rest <= 0 || lineLeft <= 0) break;
    if (!p.lines?.length) continue;
    for (const x of p.lines) {
      if (!ids.has(x.lineId) || rest <= 0 || lineLeft <= 0) continue;
      const take = Math.min(rest, lineLeft, boundOn(o, { ...p, lines: [x] }, new Set([x.lineId])), fill.lineExcess.get(x.lineId) ?? 0);
      if (take <= 0) continue;
      out.push({ paymentId: p.id, lineId: x.lineId, amount: take });
      rest -= take;
      lineLeft -= take;
    }
  }
  let sectionLeft = sectionRoom;
  for (const p of ordered) {
    if (rest <= 0 || sectionLeft <= 0) break;
    if (p.lines?.length || p.section === undefined || !sections.has(p.section)) continue;
    const take = Math.min(rest, sectionLeft, p.amount - (o.refunds ?? []).filter((r) => r.refundOf === p.id).reduce((sum, r) => sum + r.amount, 0));
    if (take <= 0) continue;
    out.push({ paymentId: p.id, amount: take });
    rest -= take;
    sectionLeft -= take;
  }
  return out;
}

/**
 * 환불 없음: 비운 돈을 취소한 줄에 남긴다(그 줄의 취소 값까지): 줄에 묶인 돈은 그 줄에, 칸에 묶인 돈(선입금)은 그 칸의 취소한 줄에, 접수 전체 수납이
 * 남긴 돈은 남은 자리가 있는 줄에.
 */
function feesOf(o: FxOrder, c: FxCancellation, freed: number): { lineId: string; amount: number }[] {
  const fill = lineFill(o);
  const sectionOf = (lineId: string) => o.lines.find((l) => l.id === lineId)?.section;
  const fees = c.lines.map((x) => ({ lineId: x.lineId, section: sectionOf(x.lineId), cap: x.amount, amount: Math.min(x.amount, fill.lineExcess.get(x.lineId) ?? 0) }));
  let rest = freed - fees.reduce((sum, x) => sum + x.amount, 0);
  const put = (pick: (f: (typeof fees)[number]) => boolean, budget: number) => {
    let left = Math.min(rest, budget);
    for (const f of fees) {
      if (left <= 0) break;
      if (!pick(f)) continue;
      const take = Math.min(left, f.cap - f.amount);
      f.amount += take;
      left -= take;
      rest -= take;
    }
  };
  for (const [section, excess] of fill.sectionExcess) put((f) => f.section === section, excess);
  put(() => true, rest);
  return fees.filter((f) => f.amount > 0).map((f) => ({ lineId: f.lineId, amount: f.amount }));
}

/**
 * 결정을 적용한 접수(명령 · 창의 미리 보기가 같은 셈): 환불 없음은 줄마다 cancellation_fee, 미수 결제는 released, 환불은 그대로(환불이 이어서 온다).
 */
function withDecision(state: ShopState, plan: CancelPlan, decision: CancelDecision, now: number): FxOrder {
  const o = plan.after;
  const c = o.cancellations?.find((x) => x.id === plan.cancellation.id);
  if (!c) return o;
  c.decision = decision;
  if (decision === 'no_refund') {
    const fees = feesOf(o, c, plan.freed);
    if (fees.length) {
      o.charges = [...(o.charges ?? []), ...fees.map((f, k) => ({ id: c.id + ':f' + k, kind: 'cancellation_fee' as const, cancellationId: c.id, lineId: f.lineId, amount: f.amount, at: now }))];
    }
  } else if (decision === 'apply_to_due') {
    const released = releasedOf(o, c, plan.freed - overpaid(o));
    if (released.length) c.released = released;
  }
  return o;
}

/** 미수 결제(묶인 수납을 접수 전체로 옮김)의 권한(sys_permissions payment.reallocate `수납 이동`). 보는 사람이 없으면(메모리 어댑터의 관리자) 허락. */
const reallocateAllowed = (viewer: DiscountViewer | undefined) => !viewer || viewer.permissions.includes('payment.reallocate');

/**
 * 창이 본 취소의 값(expect.quoteHash): 취소 금액 · 비운 돈 · 취소한 뒤 줄마다 살아 있는 수. 그사이 다른 명령(같은 창을 두 번 확정 · 다른 카운터의 취소 ·
 * 할인)이 값이나 수를 바꿨으면 충돌이다(메모리 어댑터에도: 서버의 intent 충돌 키와 같은 몫).
 */
const cancelQuote = (plan: Pick<CancelPlan, 'total' | 'freed' | 'lines'>) =>
  'cancel:' + plan.total + ':' + plan.freed + ':' + plan.lines.map((x) => x.l.id + '=' + liveQty(x.l)).join(',');

/** 명령의 수와 지금 취소할 수 있는 수가 다른지: 품목 취소는 고른 수가 취소할 수를 넘을 때, 접수 취소는 창이 본 줄 · 수가 지금과 다를 때. */
function quantityChanged(plan: CancelPlan, scope: CancelScope, requested: readonly LineUnits[]): boolean {
  const got = new Map(plan.lines.map((x) => [x.l.id, x.quantity]));
  const want = new Map<string, number>();
  for (const x of requested) want.set(x.lineId, (want.get(x.lineId) ?? 0) + Math.max(0, Math.floor(x.quantity)));
  if (scope === 'lines') return [...want].some(([id, n]) => n > (got.get(id) ?? 0));
  if (!requested.length) return false;
  return [...new Set([...got.keys(), ...want.keys()])].some((id) => (got.get(id) ?? 0) !== (want.get(id) ?? 0));
}

/**
 * 접수 취소 · 품목 취소(order.cancel): 창이 본 받을 금액(expect.dueAmount) · 취소의 값(expect.quoteHash) · 수가 지금과 다르면 충돌. 결과: 취소 id(= 요청번호, 환불의 까닭) · 비운 돈.
 */
export function cancelOrder(state: ShopState, envelope: CommandEnvelope<'order.cancel'>, now: number, lines: DomainLines, viewer?: DiscountViewer): Result {
  const p = envelope.payload;
  const index = state.orders.findIndex((o) => o.id === p.orderId);
  const o = state.orders[index];
  if (!o) return rejected('접수 없음');
  const plan = cancelPlan(state, o, p.scope, p.lines, p.reasonKey, envelope.requestId, now);
  if (plan.refusal) return rejected(plan.refusal);
  if (!plan.lines.length) return rejected(CANCEL_WORDS.nothing);
  // 창을 연 뒤 수가 바뀌었다(다른 카운터의 지급 · 취소, E19): 고른 수를 조용히 줄이지 않고 충돌로 돌려보낸다.
  if (quantityChanged(plan, p.scope, p.lines)) return conflict('QUANTITY_CHANGED', CANCEL_WORDS.quantityChanged);
  if (envelope.expect?.quoteHash !== undefined && envelope.expect.quoteHash !== cancelQuote(plan)) return conflict('QUOTE_CHANGED', '받을 금액 변경됨 · 재시도 필요');
  let decision: CancelDecision = p.decision;
  if (plan.freed <= 0) decision = 'not_applicable';
  else if (decision === 'not_applicable' || !plan.decisions.includes(decision)) return unsupported(lines);
  else if (decision === 'apply_to_due' && !reallocateAllowed(viewer)) return { outcome: 'rejected', error: { code: 'FORBIDDEN', message: lines.forbidden } };
  if (envelope.expect?.dueAmount !== undefined && envelope.expect.dueAmount !== ownDue(o)) return conflict('DUE_CHANGED', '받을 금액 변경됨 · 재시도 필요');
  const next = withDecision(state, plan, decision, now);
  state.orders[index] = next;
  // 접수 취소: 이 팀을 결제 팀으로 둔 팀의 결제 예정을 푼다(그 팀의 몫은 그 팀의 미수로).
  for (const x of plan.released) {
    delete x.payerOrderId;
    for (const l of x.lines) if (l.payerOrderId === o.id) delete l.payerOrderId;
  }
  return { outcome: 'applied', result: { cancellationId: envelope.requestId, freed: plan.freed } };
}

// ── 창(cancelSheet) ───────────────────────────────────────────────────

/**
 * 취소가 푼 보증금(features-1 E5, 2026-09-27 점검): 보관 중인 보증금 중 취소로 돌려줄 수 있게 된 권(지급하지 않은 채 취소 · 돌아온 권)의 몫을 규칙마다
 * 한 번에 반환한다(받은 수단: 현금이면 현금, 아니면 그 수단). 창의 한 줄 `보증금 반환 · {수단} {금액}`과 이어지는 deposit.return.
 */
function cancelDeposits(state: ShopState, o: FxOrder, plan: CancelPlan): { line: RefundLineView; step: ConfirmStep }[] {
  if (!plan.lines.length || plan.refusal) return [];
  const ids = new Set(plan.lines.map((x) => x.l.id));
  return state.deposits.filter((d) => d.orderId === o.id && heldAmount(d) > 0).flatMap((dep) => {
    const lines = plan.after.lines.filter((l) => ids.has(l.id))
      .map((l) => ({ lineId: l.id, quantity: Math.max(0, Math.min(heldUnits(dep, l.id), depositReturnable(l, dep))) }))
      .filter((x) => x.quantity > 0);
    const units = lines.reduce((sum, x) => sum + x.quantity, 0);
    if (!units) return [];
    const amount = units * dep.unitAmount;
    const key = baseRefundKey(dep);
    const text = CANCEL_WORDS.depositReturn + ' · ' + methodLabelOf(state.registry, key === 'cash' ? 'cash' : takenMethod(dep)) + ' ' + won(amount);
    return [{
      line: { paymentId: '', parts: [{ text, drop: 0 }], amount, methods: [] },
      step: {
        command: { type: 'deposit.return' as const, payload: { orderId: o.id, ruleKey: dep.ruleKey, lines, amount, refundMethodKey: key } },
        expect: { depositHeld: heldAmount(dep) },
      },
    }];
  });
}

/** 결정 한 줄(미수 결제 · 환불 없음): 수단 버튼 없는 환불 줄 자리. */
const decisionLine = (text: string): RefundLineView => ({ paymentId: '', parts: [{ text, drop: 0 }], amount: 0, methods: [] });

const DECISION_LABEL: Record<Exclude<CancelDecision, 'not_applicable'>, string> = {
  refund: CANCEL_WORDS.refund, apply_to_due: CANCEL_WORDS.applyToDue, no_refund: CANCEL_WORDS.noRefund,
};

const methodLabelOf = (reg: ShopRegistry, key: string) => (key === 'deposit' ? '보증금 결제' : payMethodOf(reg, key)?.label ?? '');

/**
 * 접수증 옆 동작 `접수 취소` · `품목 취소`의 창: 수량 칸(품목 취소) · 구분(접수 취소) · 돈 줄 `환불`(비운 돈이 있을 때) · 환불 줄 · 요약 · 주 버튼 ·
 * 명령(order.cancel, 이어서 payment.refund).
 */
export function cancelSheet(ctx: ViewContext, params: CancelSheetParams): CancelSheetView {
  const state = ctx.state;
  const reg = state.registry;
  const o = findOrder(state, params.orderId);
  if (!o) throw new DomainError('NOT_FOUND', '없는 접수: ' + params.orderId);
  const scope = params.scope;
  const reasonKey: CancelReasonKey = scope === 'order' ? params.reasonKey ?? 'request' : 'request';
  const cancellable = o.lines.filter((l) => cancellableQty(l) > 0);
  const picked: LineUnits[] = scope === 'lines'
    ? cancellable.map((l) => ({ lineId: l.id, quantity: Math.min(cancellableQty(l), Math.max(0, Math.floor(params.picked?.find((x) => x.lineId === l.id)?.quantity ?? 0))) }))
    : [];
  // 창의 미리 보기: 요청번호가 없으니 임시 id로 센다(명령은 요청번호로 다시 센다: 같은 셈).
  const plan = cancelPlan(state, o, scope, picked, reasonKey, 'preview', ctx.now);
  const decision: CancelDecision = plan.freed <= 0 ? 'not_applicable'
    : params.decision && plan.decisions.includes(params.decision) && (params.decision !== 'apply_to_due' || reallocateAllowed(ctx.viewer)) ? params.decision
      : plan.decisionDefault;
  const after = withDecision(state, plan, decision, ctx.now);
  const c = after.cancellations?.find((x) => x.id === 'preview');

  const lines: ReturnPieceLine[] = scope === 'lines' ? cancellable.map((l) => {
    const names = lineNames(reg, l);
    const value = picked.find((x) => x.lineId === l.id)?.quantity ?? 0;
    return {
      lineId: l.id, label: names.name, note: names.variant ?? '', mode: 'count', quantity: { value, min: 0, max: cancellableQty(l), unit: countWord(l) },
      muted: value === 0, wide: false, ...(names.variant ? { ariaLabel: names.name + ' ' + names.variant } : {}),
    };
  }) : [];

  // 환불 줄: 환불은 수납마다(금액이 큰 것부터, 창이 두 줄씩 쪽으로 넘긴다), 미수 결제 · 환불 없음은 한 줄.
  let refunds: RefundLineView[] = [];
  let picks: PaymentRefundPick[] = [];
  if (c && decision === 'refund') {
    const found = cancelPicks(reg, after, c, plan.freed, params.methods ?? {}, ctx.viewer);
    picks = found.picks;
    refunds = refundLineViews(reg, after, picks, found.short).lines;
  } else if (decision === 'apply_to_due') {
    refunds = [decisionLine(CANCEL_WORDS.applyToDue + ' · ' + won(plan.freed))];
  } else if (decision === 'no_refund') {
    refunds = [decisionLine(CANCEL_WORDS.noRefund + ' · ' + CANCEL_WORDS.keep + ' ' + won(plan.freed))];
  }
  const refundTotal = picks.reduce((sum, x) => sum + x.amount, 0);
  // 맡은 보증금: 취소로 돌려줄 수 있게 된 권의 보증금은 이어서 반환한다(환불 줄 뒤에 한 줄, 명령은 환불 뒤).
  const deposits = cancelDeposits(state, o, plan);
  refunds = [...refunds, ...deposits.map((x) => x.line)];

  const moneyPart = decision === 'refund' && refundTotal > 0 ? CANCEL_WORDS.refund + ' ' + won(refundTotal)
    : decision === 'apply_to_due' ? CANCEL_WORDS.applyToDue + ' ' + won(plan.freed)
      : decision === 'no_refund' ? CANCEL_WORDS.noRefund : '';
  const summary: RichText[] = [
    [{ text: CANCEL_WORDS.amount + ' ' + won(plan.total), strong: true }, ...(moneyPart ? [{ text: ' · ' + moneyPart }] : [])],
    ...(plan.released.length ? [[{ text: plan.released.map((x) => x.teamName + ' 팀').join(' · ') + ' ' + CANCEL_WORDS.payerRelease }]] : []),
  ];

  const name = scope === 'order' ? CANCEL_WORDS.orderCancel : CANCEL_WORDS.removeItems;
  const items = scope === 'lines' ? itemsText(reg, plan.lines.map((x) => ({ l: x.l, qty: x.quantity }))) : '';
  const methods = [...new Set(picks.map((x) => x.methodKey))];
  const refundWord = refundTotal > 0 ? CANCEL_WORDS.refund + ' ' + (methods.length === 1 ? methodLabelOf(reg, methods[0]!) + ' ' : '') + won(refundTotal) : '';
  const label = [name, ...(items ? [items] : []), ...(refundWord ? [refundWord] : [])].join(' · ');
  const alts = [label, ...(refundWord && items ? [name + ' · ' + items + ' · ' + CANCEL_WORDS.refund + ' ' + won(refundTotal)] : []),
    ...(refundWord ? [name + ' · ' + CANCEL_WORDS.refund + ' ' + won(refundTotal)] : []), ...(items ? [name + ' · ' + items] : []), name];
  const ready = !plan.refusal && plan.lines.length > 0 && !isCancelledOrder(o);
  const refundInputs: RefundInput[] = picks.map((x) => ({ paymentId: x.payment.id, methodKey: x.methodKey, amount: x.amount }));
  const commandLines: LineUnits[] = plan.lines.map((x) => ({ lineId: x.l.id, quantity: x.quantity }));
  return {
    basis: { epoch: state.epoch, rev: state.rev },
    serverTime: iso(ctx.now),
    currentBusinessDate: state.businessDate,
    title: name + ' · ' + o.teamName + ' 팀',
    scope,
    lines,
    ...(scope === 'order' ? {
      reasons: (['request', 'no_show'] as const).map((key) => ({ key, label: reasonLabel(key), selected: key === reasonKey, enabled: true })),
    } : {}),
    ...(plan.decisions.length ? {
      decisions: plan.decisions.map((key) => {
        // 미수 결제는 수납 이동(payment.reallocate): 권한이 없으면 회색 · 까닭(서버가 다시 막는다).
        const off = key === 'apply_to_due' && !reallocateAllowed(ctx.viewer);
        return { key, label: DECISION_LABEL[key], selected: key === decision, enabled: !off, ...(off ? { reason: (ctx.lines ?? { forbidden: '권한 없음 · 관리자 확인 필요' }).forbidden } : {}) };
      }),
    } : {}),
    refunds,
    summary,
    ...(plan.refusal ? { notice: plan.refusal } : {}),
    picked,
    reasonKey,
    decision,
    primary: { label, alts: [...new Set(alts)], enabled: ready },
    ...(ready ? {
      command: { type: 'order.cancel' as const, payload: { orderId: o.id, scope, lines: commandLines, reasonKey, decision } },
      expect: { dueAmount: ownDue(o), quoteHash: cancelQuote(plan) },
      ...(refundInputs.length || deposits.length ? {
        then: [
          ...(refundInputs.length
            ? [{ command: { type: 'payment.refund' as const, payload: { orderId: o.id, cause: 'cancellation' as const, refunds: refundInputs } }, expect: { refundAmount: refundTotal } }]
            : []),
          ...deposits.map((x) => x.step),
        ],
      } : {}),
    } : {}),
  };
}

// ── 접수증 출처 줄 · 장부 ─────────────────────────────────────────────────

/** 취소 한 건의 줄마다 접수 때 할인 몫(취소 값은 할인 뒤 값이라, 접수증 품목 표의 할인 앞 값과 맞추려고 더한다). */
function cancelledDiscount(o: FxOrder, c: FxCancellation, l: FxLine): number {
  const cancels = lineCancels(o, l);
  const all = (o.cancellations ?? []).filter((x) => x.lines.some((y) => y.lineId === l.id && y.quantity > 0));
  const index = all.findIndex((x) => x.id === c.id);
  if (index < 0) return 0;
  const cut = (l.gross ?? l.amount) - l.amount;
  return cancelledShare(cut, l.qty, cancels.slice(0, index + 1)) - cancelledShare(cut, l.qty, cancels.slice(0, index));
}

/**
 * 접수증 품목 표 아래의 취소 · 추가 출처 줄: `품목 취소 · 헬멧 1 · −5,000원`, `접수 취소 · 연락 없음 · −225,000원`(할인 앞 값), `환불 없음 · 수납 유지 ·
 * +105,000원`, `미수 결제 · 105,000원`(옅은 먹), `품목 추가 · 16:20 · 헬멧 1`(옅은 먹), `즉시 교환 · 헬멧 중 사이즈 → 대 사이즈 · 1개 · 16:20`(옅은
 * 먹, features-1 §7). 금액이 있는 줄 = 청구에 든다(품목 표 + 금액 줄 = 청구).
 */
export function editAdjustments(reg: ShopRegistry, o: FxOrder): SlipAdjustment[] {
  // 일어난 차례대로(품목 추가 · 취소가 섞이면 시각 순, 같은 시각은 추가 먼저).
  const timed: { at: number; rank: number; rows: SlipAdjustment[] }[] = [];
  for (const c of o.cancellations ?? []) {
    const out: SlipAdjustment[] = [];
    timed.push({ at: c.at, rank: 1, rows: out });
    const removed = -(o.charges ?? []).reduce((sum, x) => sum + (x.kind === 'cancellation' && x.cancellationId === c.id ? x.amount : 0), 0);
    const discount = c.lines.reduce((sum, x) => { const l = o.lines.find((y) => y.id === x.lineId); return sum + (l ? cancelledDiscount(o, c, l) : 0); }, 0);
    const picks = c.lines.flatMap((x) => { const l = o.lines.find((y) => y.id === x.lineId); return l ? [{ l, qty: x.quantity }] : []; });
    const parts: FitPart[] = c.scope === 'order'
      ? [{ text: CANCEL_WORDS.orderCancel, drop: 0 }, { text: reasonLabel(c.reasonKey), drop: 1 }]
      : [{ text: CANCEL_WORDS.removeItems, drop: 0 }, { text: itemsText(reg, picks), drop: 1 }];
    out.push({ key: 'cancel:' + c.id, parts, ...(removed + discount > 0 ? { amount: -(removed + discount) } : {}) });
    const fees = (o.charges ?? []).reduce((sum, x) => sum + (x.kind === 'cancellation_fee' && x.cancellationId === c.id ? x.amount : 0), 0);
    if (fees > 0) out.push({ key: 'fee:' + c.id, parts: [{ text: CANCEL_WORDS.noRefund, drop: 0 }, { text: CANCEL_WORDS.keep, drop: 1 }], amount: fees });
    const released = (c.released ?? []).reduce((sum, x) => sum + x.amount, 0);
    if (released > 0) out.push({ key: 'released:' + c.id, parts: [{ text: CANCEL_WORDS.applyToDue + ' · ' + won(released), drop: 0 }], tone: 'muted' });
  }
  // 품목 추가(차수마다 한 줄).
  const batches = new Map<number, FxLine[]>();
  for (const l of o.lines) if (l.batch) batches.set(l.batch.at, [...(batches.get(l.batch.at) ?? []), l]);
  for (const [at, list] of batches) {
    timed.push({
      at, rank: 0, rows: [{
        key: 'add:' + at, tone: 'muted',
        parts: [{ text: CANCEL_WORDS.addItems, drop: 0 }, { text: hm(at), drop: 2 }, { text: itemsText(reg, list.map((l) => ({ l, qty: l.qty }))), drop: 1 }],
      }],
    });
  }
  // 즉시 교환(features-1 §7-2, 옅은 먹 · 금액 없음): 같은 시각이면 추가 · 취소 뒤.
  for (const x of swapAdjustments(reg, o)) timed.push({ ...x, rank: 2 });
  // 분실 처리 · 분실 회수(features-1 §8-1, 옅은 먹 · 금액 없음: 청구 없음).
  for (const x of lossAdjustments(reg, o)) timed.push({ ...x, rank: 3 });
  return timed.sort((a, b) => a.at - b.at || a.rank - b.rank).flatMap((x) => x.rows);
}

// ── 품목 추가(order.add, §5-5) ───────────────────────────────────────────

/** 품목 추가의 칸 하나. */
interface AddSection {
  key: FxSection;
  label: string;
  lines: QuoteLine[];
  gross: number;
  /** 새 줄마다 할인 뒤 값(칸의 비율 할인을 이어받으면 몫을 뺀 값). */
  netLines: number[];
  net: number;
  methodKey: FxMethodKey | typeof CHECKOUT_KEYS.later;
  laterAllowed: boolean;
  /** 이어받는 비율 할인(대신하는 적용의 새 합). */
  inherit?: { current: FxDiscountApplication; total: number };
  /** 이어받을 할인을 이 사람이 쓸 수 없다(직접 입력의 권한 · 한도, 매장 할인의 권한): 창은 막히고 명령은 거절(2026-09-27 점검). */
  forbidden?: true;
}

export interface AddPlan {
  o: FxOrder;
  days: number;
  sections: AddSection[];
  items: DraftItem[];
  payer: 'order' | 'self';
  /** 결제 팀 줄이 보이는지(접수에 결제 팀이 있음, E22). */
  payerRow: boolean;
  invalid?: 'method' | 'unsupported';
  hash: string;
  choices: CheckoutChoice[];
}

/** 품목 추가의 셈(창과 명령이 같은 셈). */
export function addPlan(
  state: ShopState, o: FxOrder, items: readonly DraftItem[], choices: readonly CheckoutChoice[] = [], payer: 'order' | 'self' = 'order', viewer?: DiscountViewer,
): AddPlan {
  const reg = state.registry;
  const cutoff = shopCutoff(state.settings);
  const days = dayCount(businessDateOf(o.pickup.at, cutoff), businessDateOf(o.giveBack.at, cutoff));
  const quote = quoteOf(reg, items, state.settings, days);
  const given = new Map(choices.map((c) => [c.sectionKey, c]));
  const prepaid = o.channel === 'phone' && state.settings.prepaymentMode === 'full_lift_ticket';
  let invalid: AddPlan['invalid'];
  const sections: AddSection[] = [];
  for (const pay of reg.paySections) {
    const lines = quote.lines.filter((l) => l.product.section === pay.key);
    if (!lines.length) continue;
    const gross = lines.reduce((sum, l) => sum + l.amount, 0);
    const laterAllowed = !(prepaid && pay.key === 'lift');
    const choice = given.get(pay.key);
    let methodKey: AddSection['methodKey'] = pay.defaultMethod;
    if (choice) {
      const method = payMethodOf(reg, choice.methodKey);
      if (method) methodKey = method.key;
      else if (choice.methodKey === CHECKOUT_KEYS.later && laterAllowed) methodKey = CHECKOUT_KEYS.later;
      else invalid ??= 'method';
      // 품목 추가는 할인을 고르지 않는다(칸의 할인은 할인 적용으로, E9).
      if (choice.discountKey !== undefined || choice.manual !== undefined || choice.payerOrderId !== undefined) invalid ??= 'unsupported';
    }
    // 칸의 비율 할인은 새 줄에도(대신하는 적용: 살아 있는 값 + 새 값의 %). 금액 할인은 새 줄에 적용하지 않는다.
    const current = currentApplication(o, pay.key);
    const percent = current && (current.kind === 'percent' || current.kind === 'manual_percent') && current.value !== undefined ? current : undefined;
    let netLines = lines.map((l) => l.amount);
    let inherit: AddSection['inherit'];
    if (percent) {
      const total = manualDiscountAmount(sectionGross(o, pay.key) + gross, { kind: 'percent', value: percent.value! });
      const now = sectionLines(o, pay.key).reduce((sum, l) => sum + lineDiscountNow(o, l), 0);
      const extra = Math.max(0, Math.min(gross, total - now));
      netLines = discountedAmounts(lines.map((l) => l.amount), extra);
      inherit = { current: percent, total: now + extra };
    }
    // 이어받는 할인이 넓어지는 몫도 그 할인의 권한 · 한도 안이어야 한다(직접 입력 8%가 품목을 더하면 한도를 넘을 수 있다).
    const rule = percent?.discountKey ? reg.discounts.find((d) => d.key === percent.discountKey) : undefined;
    const forbidden = inherit !== undefined && (percent!.kind === 'manual_percent'
      ? !manualAllowed(viewer) || !manualWithinLimit(viewer, sectionGross(o, pay.key) + gross, { kind: 'percent', value: percent!.value! })
      : rule !== undefined && !ruleAllowed(viewer, rule));
    sections.push({
      key: pay.key, label: pay.label, lines, gross, netLines, net: netLines.reduce((sum, n) => sum + n, 0), methodKey, laterAllowed, ...(inherit ? { inherit } : {}),
      ...(forbidden ? { forbidden: true as const } : {}),
    });
  }
  for (const c of choices) if (!sections.some((s) => s.key === c.sectionKey)) invalid ??= 'unsupported';
  const hash = quote.hash ? 'add:' + quote.hash + '|' + sections.map((s) => s.key + '=' + s.net).join(',') : '';
  return {
    o, days, sections, items: cleanItems(reg, items), payer, payerRow: o.payerOrderId !== undefined, ...(invalid ? { invalid } : {}), hash,
    choices: sections.map((s) => ({ sectionKey: s.key, methodKey: s.methodKey })),
  };
}

/** 접수증 · 반납 창의 줄 이름(규격이 있으면 그 이름을 붙인다). */
function lineLabel(reg: ShopRegistry, l: QuoteLine): string {
  const variant = variantOf(kindOf(reg, l.product.kindKey), l.item.variantKey);
  return variant ? l.product.label + ' ' + variant.name : l.product.label;
}

/**
 * 품목 추가(order.add): 창이 본 가격(expect.quoteHash)과 같을 때만. 새 줄(`<접수>-l<n>`, 차수 counter), 칸마다 지금 받은 돈(결제 자리 counter, 새 줄에
 * 배분) 또는 후불(결제 팀: 접수의 결제 팀 그대로 · 이 팀), 이어받는 비율 할인의 대신하는 적용. 결과: 새 줄 id.
 */
export function addItems(state: ShopState, envelope: CommandEnvelope<'order.add'>, now: number, domainLines: DomainLines, viewer?: DiscountViewer): Result {
  const p = envelope.payload;
  const o = findOrder(state, p.orderId);
  if (!o) return rejected('접수 없음');
  if (isCancelledOrder(o)) return unsupported(domainLines);
  const plan = addPlan(state, o, p.items, p.choices, p.payer, viewer);
  if (plan.invalid) return plan.invalid === 'method' ? rejected('등록되지 않은 결제 수단') : unsupported(domainLines);
  if (plan.sections.some((s) => s.forbidden)) return { outcome: 'rejected', error: { code: 'FORBIDDEN', message: domainLines.forbidden } };
  if (!plan.items.length || !plan.sections.length) return unsupported(domainLines);
  if (envelope.expect?.quoteHash !== plan.hash) return conflict('QUOTE_CHANGED', '받을 금액 변경됨 · 재시도 필요');
  const reg = state.registry;
  const lineIds: string[] = [];
  let n = o.lines.length + 1;
  const nextId = () => {
    while (o.lines.some((l) => l.id === o.id + '-l' + n)) n += 1;
    return o.id + '-l' + n;
  };
  const selfPays = p.payer === 'self' && o.payerOrderId !== undefined;
  for (const s of plan.sections) {
    const added: { l: FxLine; net: number; qty: number }[] = [];
    s.lines.forEach((q, i) => {
      const product = q.product;
      const net = s.netLines[i] ?? q.amount;
      const l: FxLine = {
        id: nextId(), kind: product.key, label: lineLabel(reg, q), shortLabel: product.shortLabel ?? product.label, qty: q.item.quantity,
        ...(product.unit ? { unit: product.unit } : {}), countWord: product.countWord, amount: net, ...(net < q.amount ? { gross: q.amount } : {}),
        ...(product.section === 'gear' ? { dayPrice: product.price } : {}),
        section: product.section, returnable: product.section === 'lift' ? liftReturnable(state.settings) : product.returnable,
        capabilities: [...product.capabilities], tracking: product.tracking, loaded: 0, issued: 0, returned: 0, collected: 0, received: 0, productKey: product.key,
        ...(q.item.variantKey !== undefined ? { variantKey: q.item.variantKey } : {}), ...(selfPays ? { payerOrderId: o.id } : {}),
        batch: { source: 'counter', at: now },
      };
      o.lines.push(l);
      lineIds.push(l.id);
      added.push({ l, net, qty: q.item.quantity });
    });
    if (s.inherit) {
      const appId = envelope.requestId + ':d' + s.key;
      const { id: _id, supersedes: _supersedes, at: _at, amount: _amount, ...rest } = s.inherit.current;
      o.discounts = [...(o.discounts ?? []), { ...rest, id: appId, amount: s.inherit.total, supersedes: s.inherit.current.id, at: now }];
    }
    if (s.methodKey === CHECKOUT_KEYS.later || s.net <= 0) continue;
    const groupId = envelope.requestId + ':' + s.key;
    const drawer = s.methodKey === 'cash' ? { drawerId: 'counter' } : {};
    const group: FxPaymentGroup = { id: groupId, purpose: 'counter', amount: s.net, methodKey: s.methodKey, at: now, ...drawer };
    state.paymentGroups.push(group);
    const allocations = added.filter((x) => x.net > 0).map((x) => ({ lineId: x.l.id, quantity: x.qty, amount: x.net }));
    o.payments.push({ id: groupId, amount: s.net, methodKey: s.methodKey, at: now, groupId, ...drawer, lines: allocations });
  }
  return { outcome: 'applied', result: { lineIds } };
}

/** 품목 추가의 칸 상태 글(이어받는 할인 `장비 10% 할인 · 적용 중`, 없으면 없음). */
const inheritText = (s: AddSection) => (s.inherit ? s.label + ' ' + s.inherit.current.label + ' · ' + CANCEL_WORDS.inherited : undefined);

/** 칸 제목 줄의 품목(`헬멧 1 · 스키 2`, 하루를 넘기면 `· 2일`). */
function sectionItems(reg: ShopRegistry, s: AddSection, days: number): string[] {
  return [
    ...s.lines.map((l) => {
      const variant = variantOf(kindOf(reg, l.product.kindKey), l.item.variantKey);
      return (l.product.shortLabel ?? l.product.label) + (variant ? ' ' + variant.label : '') + ' ' + l.item.quantity + (l.product.unit ?? '');
    }),
    ...(s.key === 'gear' && days > 1 ? [days + '일'] : []),
  ];
}

/**
 * 품목 추가의 확정 창(checkoutSheet addTo): 칸마다 수단(빠른 수단 · `후불` · `기타`, 할인 고르기 없음), 칸 상태에 이어받는 할인, 결제 팀 줄(`결제 팀 ·
 * 이정호 팀` · `이 팀 결제`, 접수에 결제 팀이 있을 때), 받을 금액 줄, 주 버튼 `추가 확정 · 현금 45,000원` · `추가 확정`, 명령 order.add.
 */
export function addCheckoutSheet(ctx: ViewContext, params: CheckoutSheetParams): CheckoutSheetView {
  const state = ctx.state;
  const reg = state.registry;
  const o = findOrder(state, params.addTo);
  if (!o) throw new DomainError('NOT_FOUND', '없는 접수: ' + params.addTo);
  const payerKey = params.payer ?? 'order';
  const plan = addPlan(state, o, params.draft.items, params.choices ?? [], payerKey, ctx.viewer);
  const quick = reg.payMethods.filter((m) => m.quick);
  const payerTeam = findOrder(state, o.payerOrderId);
  const sections: CheckoutSection[] = plan.sections.map((s) => {
    const later = s.methodKey === CHECKOUT_KEYS.later;
    const method = payMethodOf(reg, s.methodKey);
    const nonQuick = method !== undefined && !method.quick;
    const itemList = sectionItems(reg, s, plan.days);
    const status = inheritText(s);
    return {
      key: s.key, label: s.label, items: itemList.join(' · '), itemList,
      ...(status ? { discount: status, discountShort: s.inherit!.current.label + ' · ' + CANCEL_WORDS.inherited } : {}),
      ...(later && payerTeam && plan.payer === 'order' ? { payerNote: payerTeam.teamName + ' 팀 결제 예정' } : {}),
      amount: s.net, amountMuted: later,
      methods: [
        ...quick.map((m) => ({ key: m.key, label: m.label, selected: s.methodKey === m.key, enabled: true })),
        { key: CHECKOUT_KEYS.later, label: '후불', selected: later, enabled: s.laterAllowed },
        { key: CHECKOUT_KEYS.other, label: '기타', selected: nonQuick, enabled: true, ...(nonQuick ? { secondLine: method.label } : {}) },
      ],
      discountable: false,
      others: reg.payMethods.filter((m) => !m.quick).map((m) => ({ key: m.key, label: m.label, selected: s.methodKey === m.key, enabled: true })),
      choice: plan.choices.find((c) => c.sectionKey === s.key)!,
    };
  });
  const laterSections = plan.sections.filter((s) => s.methodKey === CHECKOUT_KEYS.later);
  const payerOptions: ChoiceOption[] = payerTeam
    ? [
      // 줄 이름이 이미 `… · 결제 팀`이라 버튼은 팀만(2026-09-27 점검: `결제 팀`이 한 줄에 두 번).
      { key: 'order', label: payerTeam.teamName + ' 팀', selected: plan.payer === 'order', enabled: true },
      { key: 'self', label: CANCEL_WORDS.thisTeam, selected: plan.payer === 'self', enabled: true },
    ]
    : [];
  const paid = plan.sections.filter((s) => s.methodKey !== CHECKOUT_KEYS.later && s.net > 0);
  const byMethod = reg.payMethods.map((m) => ({ key: m.key, label: m.label, amount: paid.filter((s) => s.methodKey === m.key).reduce((sum, s) => sum + s.net, 0) }))
    .filter((m) => m.amount > 0);
  const total = byMethod.reduce((sum, m) => sum + m.amount, 0);
  const due: RichText = total === 0
    ? [{ text: '받을 금액 없음', strong: true }]
    : [{ text: '받을 금액', strong: true }, { text: ' ' + byMethod.map((m) => m.label + ' ' + won(m.amount)).join(' · '), strong: true }];
  const base = CANCEL_WORDS.confirmAdd;
  const label = total === 0 ? base : base + ' · ' + byMethod.map((m) => m.label + ' ' + won(m.amount)).join(' · ');
  const alts = [label, ...(byMethod.length > 1 ? [base + ' · ' + won(total)] : []), ...(label !== base ? [base] : [])];
  const forbidden = plan.sections.some((s) => s.forbidden);
  const ready = plan.items.length > 0 && plan.sections.length > 0 && !plan.invalid && !isCancelledOrder(o) && !forbidden;
  return {
    basis: { epoch: state.epoch, rev: state.rev },
    title: '결제 · ' + o.teamName + ' 팀',
    sections,
    payer: {
      visible: plan.payerRow && laterSections.length > 0,
      label: laterSections.length ? laterSections.map((s) => s.label).join(' · ') + ' ' + won(laterSections.reduce((sum, s) => sum + s.net, 0)) + ' · ' + CANCEL_WORDS.payerTeam : CANCEL_WORDS.payerTeam,
      options: payerOptions,
      find: false,
    },
    due,
    ...(forbidden ? { notice: (ctx.lines ?? { forbidden: '권한 없음 · 관리자 확인 필요' }).forbidden } : {}),
    primary: { label, alts, enabled: ready },
    ...(ready ? {
      command: { type: 'order.add' as const, payload: { orderId: o.id, items: plan.items, choices: plan.choices, payer: plan.payer } },
      expect: { quoteHash: plan.hash },
    } : {}),
  };
}

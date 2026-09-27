// 할인 적용(work/impl-features-1/plan.md §6, catalog 9 · E9 · E10 · E3 · E4 · E4b): 접수 뒤의 할인 적용 · 변경 · 해제(discount.apply)와 그 뒤의
// 환불(payment.refund), 접수증 옆 동작 `할인 적용`의 창(discountSheet), 직접 입력(금액 · 비율 · 사유)의 흐름, 접수증 품목 표 아래의 출처 줄.
//   - 할인 묶음(결제 칸)마다 할인은 하나다: 새 할인 적용이 그 칸의 지금 적용을 대신하고(supersedes), 차이는 청구 조정 `discount_change`(더 큰 할인
//     = 음수)이며 줄마다 나눈 몫을 가진다(줄 청구 lineCharged가 맞게). 해제는 금액 0의 적용 + 양수 조정이다. 새 금액은 칸의 할인 앞 값(줄의 gross)으로
//     센다. 칸의 마지막 적용 = 그 칸의 지금 할인(plan §3-2 assert 4).
//   - 직접 입력은 권한 `discount.manual`, 역할 한도(limits_json의 금액 · 비율), 매장 할인은 그 할인의 권한(required_permission_key)이 있어야 한다.
//     읽기 모델은 막힌 것을 회색 · 까닭(`권한 없음 · 관리자 확인 필요`)으로 그리고, 명령은 보는 사람(ApplyOptions.viewer: 서버는 세션의 역할)으로
//     다시 막는다(서버의 권한 확인은 discount.apply · discount.manual).
//   - 할인이 커져 접수가 더 낸 돈이 되면 창이 이어서 환불을 보낸다(cause 'discount', dependsOn = 할인 적용의 요청번호). 환불은 그 칸에 묶인 수납부터
//     (줄 → 칸 → 접수 전체 → 나머지, 그 안에서 늦게 받은 것부터) 그 수납의 수단 또는 현금으로 돌려준다(E4b). 까닭이 없거나 그 까닭이 비운 돈보다
//     많으면 `환불 대상 없음`.
// 화면 글은 docs/design/wording.md 3-20(확인 대기)의 말이다.
import {
  CHECKOUT_KEYS, DomainError, type ChoiceOption, type CommandEnvelope, type DiscountChoice, type DiscountSectionKey, type DiscountSheetParams,
  type DiscountSheetView, type FitPart, type ManualDiscount, type ManualDiscountSpec, type RefundInput, type RefundLineView, type RichText,
  type SlipAdjustment,
} from '@skinote/contract';
import { activeDiscounts, discountAmount, discountedAmounts, manualDiscountAmount, payMethodOf, type FxDiscount } from './catalog.ts';
import type { DomainLines, FxDiscountApplication, FxLine, FxMethodKey, FxOrder, FxPayment, FxRefund, FxSection, ShopRegistry, ShopState } from './model.ts';
import { conflict, nothing, rejected, unsupported, type Result } from './result.ts';
import { cancellationLabel } from './cancel-words.ts';
import {
  cancellationFreed, cancellationRemoved, charged, findOrder, liveCheckoutDiscount, liveGross, overpaid, ownDue, paidTotal, refundableOf,
} from './rules.ts';
import { iso } from './time.ts';
import type { RoleLimits, ViewContext } from './views.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';
const minusWon = (n: number) => (n < 0 ? '−' : '') + won(Math.abs(n));

/** 화면 글(wording.md 3-20). */
export const DISCOUNT_WORDS = Object.freeze({
  none: '할인 없음',
  manualChoice: '직접 입력',
  manualLabel: '할인 직접 입력',
  removal: '할인 해제',
  apply: '할인 적용',
  kindAmount: '금액',
  kindPercent: '비율',
  padAmount: '할인 금액',
  padPercent: '할인 비율',
  reasonTitle: '할인 사유',
  noChange: '변경 없음',
  refund: '환불',
  refundCause: '할인 변경',
  overpaidCause: '초과 수납',
  noTarget: '환불 대상 없음',
  terminal: '단말기 취소',
  notRefundable: '환불 불가',
  due: '미수',
  noDue: '미수 없음',
  /** 한도를 넘은 직접 입력의 한 줄(`한도 10,000원 · 관리자 확인 필요`). */
  limit: '한도',
  managerCheck: '관리자 확인 필요',
});

/** 직접 입력의 범위(원 · %): 금액 10원 ~ 1,000,000원(10원 단위, 칸 합계까지), 비율 1 ~ 100%. 사유 20자. */
export const MANUAL_DISCOUNT = Object.freeze({ amountMin: 10, amountMax: 1_000_000, amountStep: 10, percentMin: 1, percentMax: 100, reasonMax: 20 });

/** 권한 key(sys_permissions). */
const PERM_MANUAL = 'discount.manual';
/**
 * 받은 수단과 다른 수단으로 돌려주기(카드 · 계좌이체를 현금으로: 돈통에서 현금이 나감)의 권한(`cash.entry` 현금 출납, 2026-09-27 점검: 카운터 한 사람이
 * 카드로 받고 할인 · 취소 뒤 현금으로 돌려줄 수 있었다). 관리자만 가진다(카운터의 시작 권한에서 뺐다).
 */
export const PERM_CROSS_REFUND = 'cash.entry';

/** 이 수납을 이 수단으로 돌려줄 수 있는지(받은 수단 그대로는 누구나, 다른 수단은 cash.entry). 보증금 결제는 현금이 제 수단이다. */
export const crossRefundAllowed = (viewer: DiscountViewer | undefined, p: Pick<FxPayment, 'methodKey'>, methodKey: string) =>
  methodKey === (p.methodKey === 'deposit' ? 'cash' : p.methodKey) || has(viewer, PERM_CROSS_REFUND);

/** 할인을 보는 · 하는 사람(읽기 모델의 viewer, 명령의 ApplyOptions.viewer). 없으면 모두 허락(메모리 어댑터의 관리자). */
export interface DiscountViewer {
  permissions: readonly string[];
  limits?: RoleLimits;
}

// ── 칸의 할인 셈 ─────────────────────────────────────────────────────

/** 줄의 할인 앞 값(얼린 줄 전체: 접수증 금액 칸). */
export const lineGross = (l: FxLine) => l.gross ?? l.amount;
export const sectionLines = (o: FxOrder, section: FxSection) => o.lines.filter((l) => l.section === section);
/** 칸의 할인 앞 값 중 살아 있는 몫(그 칸 줄의 liveGross 합, 취소한 수는 뺀다 · features-1 E9). */
export const sectionGross = (o: FxOrder, section: FxSection) => sectionLines(o, section).reduce((sum, l) => sum + liveGross(o, l), 0);

/**
 * 줄의 지금 할인 몫: 접수 때 뺀 몫(gross − amount) 중 살아 있는 몫 − 뒤의 할인 변경 몫(청구 조정: 더 큰 할인은 음수라 몫이 커진다). 취소는 그 수의
 * 접수 때 할인 몫을 함께 뺐다(취소 값은 줄 값 = 할인 뒤 값으로 센다).
 */
export function lineDiscountNow(o: FxOrder, l: FxLine): number {
  const changes = (o.charges ?? []).reduce((sum, c) => sum + (c.kind === 'discount_change' ? c.lines.reduce((n, x) => n + (x.lineId === l.id ? x.amount : 0), 0) : 0), 0);
  return liveCheckoutDiscount(o, l) - changes;
}

/** 칸의 지금 할인(줄 몫의 합). 그 칸의 마지막 적용 금액과 같다(plan §3-2 assert 4). */
export const sectionDiscountNow = (o: FxOrder, section: FxSection) => sectionLines(o, section).reduce((sum, l) => sum + lineDiscountNow(o, l), 0);

/** 칸의 지금 할인 적용(마지막 행). 없으면 undefined. */
export const currentApplication = (o: FxOrder, section: FxSection): FxDiscountApplication | undefined =>
  [...(o.discounts ?? [])].reverse().find((d) => d.sectionKey === section);

/** 금액을 칸 줄들에 나눈 몫(catalog 9: 총액 비율, 10원 단위, 끝전은 큰 줄부터). 살아 있는 할인 앞 값으로 나눈다. */
export function sharesOf(o: FxOrder, lines: readonly FxLine[], amount: number): number[] {
  const grosses = lines.map((l) => liveGross(o, l));
  return discountedAmounts(grosses, amount).map((net, i) => grosses[i]! - net);
}

// ── 권한 · 한도 ───────────────────────────────────────────────────────

const has = (viewer: DiscountViewer | undefined, permission: string) => !viewer || viewer.permissions.includes(permission);

/** 매장 할인을 쓸 수 있는지(그 할인의 권한). */
export const ruleAllowed = (viewer: DiscountViewer | undefined, rule: Pick<FxDiscount, 'requiredPermission'>) =>
  rule.requiredPermission === undefined || has(viewer, rule.requiredPermission);

/** 직접 입력을 할 수 있는지(권한 discount.manual). */
export const manualAllowed = (viewer: DiscountViewer | undefined) => has(viewer, PERM_MANUAL);

/** 직접 입력이 한도 안인지: 금액 한도는 뺀 금액에, 비율 한도는 비율에(features-1 E10). */
export function manualWithinLimit(viewer: DiscountViewer | undefined, gross: number, manual: Pick<ManualDiscount, 'kind' | 'value'>): boolean {
  const limits = viewer?.limits;
  if (!limits) return true;
  if (limits.maxDiscountAmount !== undefined && manualDiscountAmount(gross, manual) > limits.maxDiscountAmount) return false;
  return !(manual.kind === 'percent' && limits.maxDiscountPercentBp !== undefined && manual.value * 100 > limits.maxDiscountPercentBp);
}

/** 직접 입력 값이 받는 모양인지(범위 · 10원 단위 · 리프트권은 비율만 · 사유). */
export function manualValid(section: FxSection, manual: ManualDiscount): boolean {
  const reason = manual.reason.trim();
  if (reason === '' || [...reason].length > MANUAL_DISCOUNT.reasonMax || !Number.isSafeInteger(manual.value)) return false;
  if (manual.kind === 'amount') {
    return section !== 'lift' && manual.value >= MANUAL_DISCOUNT.amountMin && manual.value <= MANUAL_DISCOUNT.amountMax && manual.value % MANUAL_DISCOUNT.amountStep === 0;
  }
  return manual.value >= MANUAL_DISCOUNT.percentMin && manual.value <= MANUAL_DISCOUNT.percentMax;
}

/** 숫자판의 한도(그 종류의 단위): 금액은 금액 한도, 비율은 비율 한도와 금액 한도 안의 가장 큰 %. 한도가 없으면 undefined. */
function padLimit(viewer: DiscountViewer | undefined, gross: number, kind: ManualDiscount['kind']): number | undefined {
  const limits = viewer?.limits;
  if (!limits || (limits.maxDiscountAmount === undefined && limits.maxDiscountPercentBp === undefined)) return undefined;
  if (kind === 'amount') return limits.maxDiscountAmount;
  let best = 0;
  for (let p = MANUAL_DISCOUNT.percentMax; p >= MANUAL_DISCOUNT.percentMin; p -= 1) {
    if (manualWithinLimit(viewer, gross, { kind, value: p })) { best = p; break; }
  }
  return best;
}

/**
 * 직접 입력의 흐름(종류 판 → 숫자판 → 사유 키보드): 칸 이름 · 할인 앞 값으로 범위를 정한다. 리프트권은 비율 하나(판 없이 숫자판). 권한이 없으면
 * undefined(고르기의 `직접 입력`이 회색).
 */
export function manualSpec(viewer: DiscountViewer | undefined, section: FxSection, sectionLabel: string, gross: number, forbidden: string): ManualDiscountSpec | undefined {
  if (!manualAllowed(viewer)) return undefined;
  const amountMax = Math.max(MANUAL_DISCOUNT.amountMin, Math.min(MANUAL_DISCOUNT.amountMax, Math.floor(gross / MANUAL_DISCOUNT.amountStep) * MANUAL_DISCOUNT.amountStep));
  const amountLimit = padLimit(viewer, gross, 'amount');
  const percentLimit = padLimit(viewer, gross, 'percent');
  const kinds: ManualDiscountSpec['kinds'] = [
    ...(section === 'lift' ? [] : [{
      key: 'amount' as const, label: DISCOUNT_WORDS.kindAmount,
      input: {
        key: 'manual:amount', mode: 'amount' as const, title: DISCOUNT_WORDS.padAmount + ' · ' + sectionLabel, min: MANUAL_DISCOUNT.amountMin, max: amountMax,
        step: MANUAL_DISCOUNT.amountStep, note: sectionLabel + ' ' + won(gross),
      },
      ...(amountLimit !== undefined ? { limit: amountLimit, overLimit: DISCOUNT_WORDS.limit + ' ' + won(amountLimit) + ' · ' + DISCOUNT_WORDS.managerCheck } : {}),
    }]),
    {
      key: 'percent' as const, label: DISCOUNT_WORDS.kindPercent,
      input: {
        key: 'manual:percent', mode: 'percent' as const, title: DISCOUNT_WORDS.padPercent + ' · ' + sectionLabel, min: MANUAL_DISCOUNT.percentMin,
        max: MANUAL_DISCOUNT.percentMax, note: sectionLabel + ' ' + won(gross),
      },
      ...(percentLimit !== undefined ? { limit: percentLimit, overLimit: DISCOUNT_WORDS.limit + ' ' + percentLimit + '% · ' + DISCOUNT_WORDS.managerCheck } : {}),
    },
  ];
  return {
    title: DISCOUNT_WORDS.manualLabel + ' · ' + sectionLabel,
    kinds,
    overLimit: forbidden,
    reason: { title: DISCOUNT_WORDS.reasonTitle, maxLength: MANUAL_DISCOUNT.reasonMax },
  };
}

/** 직접 입력 값의 글(`5,000원` · `10%`). */
export const manualValueText = (manual: Pick<ManualDiscount, 'kind' | 'value'>) => (manual.kind === 'amount' ? won(manual.value) : manual.value + '%');

// ── 할인 바꿈의 셈(창과 명령이 함께 쓴다) ─────────────────────────────────────

type Invalid = 'unsupported' | 'forbidden' | 'same';

interface DiscountPlan {
  section: FxSection;
  lines: FxLine[];
  gross: number;
  /** 지금 할인(칸의 줄 몫 합). */
  before: number;
  /** 새 할인. */
  after: number;
  current?: FxDiscountApplication;
  app: Omit<FxDiscountApplication, 'id' | 'at' | 'supersedes' | 'sectionKey'>;
  /** 줄마다 청구가 바뀌는 몫(앞 몫 − 새 몫, 합 = before − after). 0인 줄은 없다. */
  parts: { lineId: string; amount: number }[];
  invalid?: Invalid;
}

const sameApp = (a: FxDiscountApplication | undefined, b: DiscountPlan['app']) =>
  a !== undefined && a.kind === b.kind && a.discountKey === b.discountKey && a.value === b.value && (a.reason ?? '') === (b.reason ?? '');

function discountPlan(reg: ShopRegistry, o: FxOrder, section: FxSection, choice: DiscountChoice, viewer: DiscountViewer | undefined): DiscountPlan {
  const lines = sectionLines(o, section);
  const gross = sectionGross(o, section);
  const current = currentApplication(o, section);
  const before = sectionDiscountNow(o, section);
  let invalid: Invalid | undefined;
  let app: DiscountPlan['app'];
  if ('ruleKey' in choice) {
    const rule = activeDiscounts(reg).find((d) => d.key === choice.ruleKey && d.sections.includes(section));
    if (!rule) invalid = 'unsupported';
    else if (!ruleAllowed(viewer, rule)) invalid = 'forbidden';
    app = rule
      ? { discountKey: rule.key, kind: rule.kind, label: rule.label, value: rule.value, amount: discountAmount(gross, rule) }
      : { kind: 'none', label: DISCOUNT_WORDS.removal, amount: 0 };
  } else if ('manual' in choice) {
    const m = choice.manual;
    if (!manualValid(section, m)) invalid = 'unsupported';
    else if (!manualAllowed(viewer) || !manualWithinLimit(viewer, gross, m)) invalid = 'forbidden';
    app = {
      kind: m.kind === 'amount' ? 'manual_amount' : 'manual_percent', label: DISCOUNT_WORDS.manualLabel, value: m.value, reason: m.reason.trim(),
      amount: invalid === 'unsupported' ? 0 : manualDiscountAmount(gross, m),
    };
  } else {
    app = { kind: 'none', label: DISCOUNT_WORDS.removal, amount: 0 };
  }
  // 살아 있는 줄이 없는 칸(모두 취소)에는 할인을 적용하지 않는다(features-1 §6-1).
  if (!lines.length || gross <= 0) invalid = 'unsupported';
  const after = app.amount;
  // 같은 할인을 다시 고름(값도 같음) · 할인이 없는데 해제: 바뀜 없음.
  if (!invalid && after === before && (sameApp(current, app) || (app.kind === 'none' && (current === undefined || current.kind === 'none')))) invalid = 'same';
  const newShares = sharesOf(o, lines, after);
  const parts = lines.map((l, i) => ({ lineId: l.id, amount: lineDiscountNow(o, l) - newShares[i]! })).filter((x) => x.amount !== 0);
  return { section, lines, gross, before, after, ...(current ? { current } : {}), app, parts, ...(invalid ? { invalid } : {}) };
}

/** 창이 본 할인의 값(expect.quoteHash): 칸의 할인 앞 값 · 지금 할인 · 새 할인. */
const discountQuote = (plan: Pick<DiscountPlan, 'gross' | 'before' | 'after'>) => 'discount:' + plan.gross + ':' + plan.before + ':' + plan.after;

/** 막힌 수단 버튼의 까닭(읽기 모델, 운영 문구: lines.ts PRODUCTION_LINES.forbidden과 같은 말). */
const FORBIDDEN_LINE = '권한 없음 · 관리자 확인 필요';

const forbiddenResult = (lines: DomainLines): Result => ({ outcome: 'rejected', error: { code: 'FORBIDDEN', message: lines.forbidden } });

/**
 * 할인 적용 · 변경 · 해제(discount.apply): 그 칸의 지금 적용을 대신하는 새 적용(id = 요청번호)과 청구 조정(차이가 있을 때). 창이 본 받을 금액
 * (expect.dueAmount)이 지금과 다르면 충돌. 결과: 새 적용 id · 접수의 더 낸 돈(환불할 돈).
 */
export function applyDiscount(
  state: ShopState, envelope: CommandEnvelope<'discount.apply'>, now: number, lines: DomainLines, viewer?: DiscountViewer,
): Result {
  const p = envelope.payload;
  const o = findOrder(state, p.orderId);
  if (!o) return rejected('접수 없음');
  const plan = discountPlan(state.registry, o, p.sectionKey, p.choice, viewer);
  if (plan.invalid === 'forbidden') return forbiddenResult(lines);
  if (plan.invalid === 'unsupported') return unsupported(lines);
  if (plan.invalid === 'same') return nothing(DISCOUNT_WORDS.noChange);
  if (envelope.expect?.dueAmount !== undefined && envelope.expect.dueAmount !== ownDue(o)) return conflict('DUE_CHANGED', '받을 금액 변경됨 · 재시도 필요');
  // 창이 본 칸의 값 · 새 할인(E19): 결제가 끝난 접수는 받을 금액이 0이라 그사이의 취소 · 추가를 이것으로 안다.
  if (envelope.expect?.quoteHash !== undefined && envelope.expect.quoteHash !== discountQuote(plan)) return conflict('QUOTE_CHANGED', '받을 금액 변경됨 · 재시도 필요');
  const id = envelope.requestId;
  o.discounts = [...(o.discounts ?? []), { id, sectionKey: p.sectionKey, ...plan.app, ...(plan.current ? { supersedes: plan.current.id } : {}), at: now }];
  const change = plan.before - plan.after;
  if (change !== 0) {
    o.charges = [...(o.charges ?? []), { id: id + ':dc', kind: 'discount_change', applicationId: id, section: p.sectionKey, amount: change, lines: plan.parts, at: now }];
  }
  return { outcome: 'applied', result: { applicationId: id, overpaid: overpaid(o) } };
}

// ── 환불(payment.refund) ─────────────────────────────────────────────

/** 할인 적용이 비운 돈(청구가 줄어든 몫). 해제 · 더 작은 할인은 0. */
const freedBy = (o: FxOrder, applicationId: string) =>
  Math.max(0, -(o.charges ?? []).filter((c) => c.kind === 'discount_change' && c.applicationId === applicationId).reduce((sum, c) => sum + c.amount, 0));

/** 까닭이 이미 돌려준 돈. */
const refundedFor = (o: FxOrder, causeId: string) => (o.refunds ?? []).filter((r) => r.cause.id === causeId).reduce((sum, r) => sum + r.amount, 0);

/** 환불 수단: 그 수납의 수단 또는 현금(보증금 결제는 현금만, E4). */
function refundMethods(p: FxPayment): FxMethodKey[] {
  if (p.methodKey === 'deposit') return ['cash'];
  return p.methodKey === 'cash' ? ['cash'] : [p.methodKey, 'cash'];
}

/** 줄에 묶인 수납이 아직 돌려줄 수 있는 줄 몫(그 수납의 앞 환불을 뺀 것). */
function lineRoom(o: FxOrder, p: FxPayment): Map<string, number> {
  const room = new Map<string, number>();
  for (const x of p.lines ?? []) room.set(x.lineId, (room.get(x.lineId) ?? 0) + x.amount);
  for (const r of o.refunds ?? []) {
    if (r.refundOf !== p.id) continue;
    for (const x of r.lines ?? []) room.set(x.lineId, (room.get(x.lineId) ?? 0) - x.amount);
  }
  return room;
}

/** 줄에 묶인 수납의 묶이지 않은 나머지(금액 − 줄 배분 − 그 수납의 줄 없는 환불): 접수 전체 돈이라 환불이 먼저 여기서 뺀다. */
function freeOf(o: FxOrder, p: FxPayment): number {
  const bound = (p.lines ?? []).reduce((sum, x) => sum + x.amount, 0);
  const back = (o.refunds ?? []).filter((r) => r.refundOf === p.id && !r.lines?.length).reduce((sum, r) => sum + r.amount, 0);
  return p.amount - bound - back;
}

/** 줄에 묶인 수납의 환불이 뺄 줄(먼저 뺄 줄: 할인은 그 칸 줄, 취소는 취소한 줄 · 뒤 줄부터). */
function mirrorLines(o: FxOrder, p: FxPayment, amount: number, prefer: (lineId: string) => boolean): { lineId: string; quantity: number; amount: number }[] {
  const room = lineRoom(o, p);
  const order = [...room.keys()].reverse().sort((a, b) => Number(prefer(b)) - Number(prefer(a)));
  const out: { lineId: string; quantity: number; amount: number }[] = [];
  let rest = amount;
  for (const lineId of order) {
    if (rest <= 0) break;
    const take = Math.min(rest, Math.max(0, room.get(lineId) ?? 0));
    if (take <= 0) continue;
    out.push({ lineId, quantity: 0, amount: take });
    rest -= take;
  }
  return out;
}

/**
 * 환불(payment.refund, E3 · E4): 까닭 확인(할인 변경은 dependsOn[0]의 적용, 초과 수납은 지금 더 낸 돈), 줄마다 그 수납의 돌려줄 수 있는 돈 안에서
 * 원래 수단 또는 현금. 그 수납이 채운 자리(줄 · 칸)를 거울처럼 뺀다. 창이 본 환불 금액(expect.refundAmount)이 줄의 합과 다르면 충돌.
 */
export function refundPayments(state: ShopState, envelope: CommandEnvelope<'payment.refund'>, now: number, lines: DomainLines, viewer?: DiscountViewer): Result {
  const p = envelope.payload;
  const o = findOrder(state, p.orderId);
  if (!o) return rejected('접수 없음');
  const total = p.refunds.reduce((sum, r) => sum + r.amount, 0);
  if (envelope.expect?.refundAmount !== undefined && envelope.expect.refundAmount !== total) return conflict('REFUND_CHANGED', '받을 금액 변경됨 · 재시도 필요');
  let allowed: number;
  let causeId: string | undefined;
  let prefer: (lineId: string) => boolean = () => false;
  let reason: string;
  if (p.cause === 'discount') {
    causeId = envelope.dependsOn?.[0];
    const app = causeId ? o.discounts?.find((d) => d.id === causeId) : undefined;
    if (!app || !causeId) return rejected(DISCOUNT_WORDS.noTarget);
    allowed = Math.min(overpaid(o), freedBy(o, causeId) - refundedFor(o, causeId));
    const section: FxSection = app.sectionKey;
    prefer = (lineId) => o.lines.find((l) => l.id === lineId)?.section === section;
    reason = DISCOUNT_WORDS.refundCause;
  } else if (p.cause === 'cancellation') {
    // 취소가 비운 돈(features-1 E3 · E5): 그 취소의 줄 · 칸에 묶인 돈이 청구를 넘은 몫까지, 취소가 청구에서 뺀 돈 − 이미 돌려준 돈을 넘지 않게.
    causeId = envelope.dependsOn?.[0];
    const c = causeId ? o.cancellations?.find((x) => x.id === causeId) : undefined;
    if (!c || !causeId) return rejected(DISCOUNT_WORDS.noTarget);
    allowed = Math.min(cancellationFreed(o, c), cancellationRemoved(o, c) - refundedFor(o, causeId));
    const ids = new Set(c.lines.map((x) => x.lineId));
    prefer = (lineId) => ids.has(lineId);
    reason = cancellationLabel(c);
  } else if (p.cause === 'overpaid') {
    allowed = overpaid(o);
    reason = DISCOUNT_WORDS.overpaidCause;
  } else {
    return unsupported(lines);
  }
  if (!(total > 0) || total > allowed) return rejected(DISCOUNT_WORDS.noTarget);
  const planned: FxRefund[] = [];
  const left = new Map<string, number>();
  for (const [k, r] of p.refunds.entries()) {
    const pay = o.payments.find((x) => x.id === r.paymentId);
    if (!pay) return rejected(DISCOUNT_WORDS.noTarget);
    if (!payMethodOf(state.registry, r.methodKey) || !refundMethods(pay).includes(r.methodKey as FxMethodKey)) return rejected('등록되지 않은 결제 수단');
    if (!crossRefundAllowed(viewer, pay, r.methodKey)) return forbiddenResult(lines);
    const room = left.get(pay.id) ?? refundableOf(state.registry, o, pay.id);
    if (!(r.amount > 0) || r.amount > room) return rejected(DISCOUNT_WORDS.noTarget);
    left.set(pay.id, room - r.amount);
    const seen = { ...o, refunds: [...(o.refunds ?? []), ...planned] };
    // 줄에 묶인 수납은 묶이지 않은 나머지(접수 전체 돈)에서 먼저, 그다음 그 수납의 줄에서 거울처럼 뺀다.
    const free = pay.lines?.length ? Math.max(0, Math.min(r.amount, freeOf(seen, pay))) : 0;
    const mirrored = pay.lines?.length && r.amount > free ? mirrorLines(seen, pay, r.amount - free, prefer) : undefined;
    if (mirrored && mirrored.reduce((sum, x) => sum + x.amount, 0) !== r.amount - free) return rejected(DISCOUNT_WORDS.noTarget);
    const common = {
      refundOf: pay.id, methodKey: r.methodKey as FxMethodKey, at: now, ...(r.methodKey === 'cash' ? { drawerId: 'counter' } : {}),
      ...(pay.section ? { section: pay.section } : {}), cause: { kind: p.cause, ...(causeId ? { id: causeId } : {}) }, reason,
    };
    if (pay.lines?.length && free > 0 && mirrored) {
      planned.push({ ...common, id: envelope.requestId + ':' + k, amount: free });
      planned.push({ ...common, id: envelope.requestId + ':' + k + 'l', amount: r.amount - free, lines: mirrored });
    } else {
      planned.push({ ...common, id: envelope.requestId + ':' + k, amount: r.amount, ...(mirrored ? { lines: mirrored } : {}) });
    }
  }
  o.refunds = [...(o.refunds ?? []), ...planned];
  return { outcome: 'applied', result: { refunded: total } };
}

// ── 환불 나눔(E4b: 어느 수납에서 돌려주나) ─────────────────────────────────

export interface PaymentRefundPick {
  payment: FxPayment;
  amount: number;
  methodKey: FxMethodKey;
  methods: FxMethodKey[];
  /** 이 사람이 고를 수 없는 수단(받은 수단과 다른 수단, cash.entry 없음). */
  blocked?: FxMethodKey[];
}

/**
 * 돌려줄 돈을 수납에 나눈다: 그 칸 줄에 묶인 수납 → 그 칸에 묶인 수납 → 접수 전체 수납 → 나머지, 무리 안에서 늦게 받은 것부터, 수납마다 돌려줄 수
 * 있는 돈까지. 모자란 돈(환불할 수 없는 수단)은 short. methods는 창이 고른 수단(수납 id → 수단, 없으면 그 수납의 수단).
 */
export function refundPicks(
  reg: ShopRegistry, o: FxOrder, amount: number, section: FxSection | undefined, methods: Readonly<Record<string, string>> = {}, viewer?: DiscountViewer,
): { picks: PaymentRefundPick[]; short: number } {
  const inSection = (p: FxPayment) => (p.lines ?? []).some((x) => o.lines.find((l) => l.id === x.lineId)?.section === section);
  return pickRefunds(reg, o, amount, (p) => (p.lines?.length ? (inSection(p) ? 0 : 3) : p.section === undefined ? 2 : p.section === section ? 1 : 3), methods, undefined, viewer);
}

/**
 * 돌려줄 돈을 수납에 나누는 셈(E4b): 무리(group, 작을수록 먼저) → 늦게 받은 것부터, 수납마다 돌려줄 수 있는 돈까지. 할인은 칸, 취소는 취소한 줄 ·
 * 칸으로 무리를 정한다.
 */
export function pickRefunds(
  reg: ShopRegistry, o: FxOrder, amount: number, group: (p: FxPayment) => number, methods: Readonly<Record<string, string>> = {},
  cap: (p: FxPayment) => number = () => Number.POSITIVE_INFINITY, viewer?: DiscountViewer,
): { picks: PaymentRefundPick[]; short: number } {
  const ordered = o.payments.map((p, i) => ({ p, i })).sort((a, b) => group(a.p) - group(b.p) || b.p.at - a.p.at || b.i - a.i).map((x) => x.p);
  const picks: PaymentRefundPick[] = [];
  let rest = amount;
  for (const p of ordered) {
    if (rest <= 0) break;
    const take = Math.min(rest, refundableOf(reg, o, p.id), cap(p));
    if (take <= 0) continue;
    const options = refundMethods(p);
    const blocked = options.filter((m) => !crossRefundAllowed(viewer, p, m));
    const chosen = methods[p.id];
    const methodKey = chosen && (options as string[]).includes(chosen) && !(blocked as string[]).includes(chosen) ? (chosen as FxMethodKey) : options[0]!;
    picks.push({ payment: p, amount: take, methodKey, methods: options, ...(blocked.length ? { blocked } : {}) });
    rest -= take;
  }
  return { picks, short: Math.max(0, rest) };
}

const methodLabelOf = (reg: ShopRegistry, key: string) => (key === 'deposit' ? '보증금 결제' : payMethodOf(reg, key)?.label ?? '');

/** 환불 한 줄의 글(`환불 · 계좌이체 105,000원`, 카드면 `· 단말기 취소`). */
export function refundParts(reg: ShopRegistry, methodKey: string, amount: number): FitPart[] {
  return [
    { text: DISCOUNT_WORDS.refund + ' · ' + methodLabelOf(reg, methodKey) + ' ' + won(amount), drop: 0 },
    ...(methodKey === 'card' ? [{ text: DISCOUNT_WORDS.terminal, drop: 1 }] : []),
  ];
}

/**
 * 창의 환불 줄: 수납마다 한 줄(금액이 큰 것부터), 환불할 수 없는 몫은 끝에 한 줄. 모든 줄이 금액과 수단 버튼을 가진다 — 창은 두 줄 자리를 쪽으로
 * 넘긴다(`‹ 1 / 2쪽 ›`). 예전의 `외 {n}건 · 같은 수단`은 가장 큰 환불(계좌이체 135,000원)을 금액 · 수단 없이 숨겼다(2026-09-27 점검).
 */
export function refundLineViews(reg: ShopRegistry, o: FxOrder, picks: readonly PaymentRefundPick[], short: number): { lines: RefundLineView[] } {
  const lines: RefundLineView[] = [...picks].map((x, i) => ({ x, i })).sort((a, b) => b.x.amount - a.x.amount || a.i - b.i).map(({ x }) => ({
    paymentId: x.payment.id,
    parts: refundParts(reg, x.methodKey, x.amount),
    amount: x.amount,
    methods: x.methods.map((key) => {
      const off = x.blocked?.includes(key) ?? false;
      return { key, label: methodLabelOf(reg, key), selected: key === x.methodKey, enabled: !off, ...(off ? { reason: FORBIDDEN_LINE } : {}) };
    }),
  }));
  if (short > 0) {
    const kept = o.payments.find((p) => payMethodOf(reg, p.methodKey)?.refundable === false);
    lines.push({
      paymentId: '', amount: 0, methods: [],
      parts: [{ text: (kept ? methodLabelOf(reg, kept.methodKey) + ' ' : '') + won(short) + ' · ' + DISCOUNT_WORDS.notRefundable, drop: 0 }],
    });
  }
  return { lines };
}

// ── 창(discountSheet) ─────────────────────────────────────────────────

/** 지금 적용을 고른 것으로(해제 · 없음 → 할인 없음). */
function choiceOf(app: FxDiscountApplication | undefined): DiscountChoice {
  if (!app || app.kind === 'none') return { none: true };
  if ((app.kind === 'manual_amount' || app.kind === 'manual_percent') && app.value !== undefined) {
    return { manual: { kind: app.kind === 'manual_amount' ? 'amount' : 'percent', value: app.value, reason: app.reason ?? '' } };
  }
  return app.discountKey ? { ruleKey: app.discountKey } : { none: true };
}

const choiceKey = (choice: DiscountChoice) => ('ruleKey' in choice ? choice.ruleKey : 'manual' in choice ? CHECKOUT_KEYS.manual : CHECKOUT_KEYS.noDiscount);

/** 칸의 할인 고르기(`할인 없음` + 매장 할인 + `직접 입력 ›`). 권한이 없는 것은 회색 · 까닭. */
export function discountOptions(
  reg: ShopRegistry, section: FxSection, selectedKey: string, viewer: DiscountViewer | undefined, forbidden: string, manual?: Pick<ManualDiscount, 'kind' | 'value'>,
): ChoiceOption[] {
  const manualOk = manualAllowed(viewer);
  return [
    { key: CHECKOUT_KEYS.noDiscount, label: DISCOUNT_WORDS.none, selected: selectedKey === CHECKOUT_KEYS.noDiscount, enabled: true },
    ...activeDiscounts(reg).filter((d) => d.sections.includes(section)).map((d) => {
      const ok = ruleAllowed(viewer, d);
      return { key: d.key, label: d.label, selected: selectedKey === d.key, enabled: ok, ...(ok ? {} : { reason: forbidden }) };
    }),
    {
      key: CHECKOUT_KEYS.manual, label: DISCOUNT_WORDS.manualChoice, opens: true, selected: selectedKey === CHECKOUT_KEYS.manual, enabled: manualOk,
      ...(manualOk ? {} : { reason: forbidden }), ...(manual && selectedKey === CHECKOUT_KEYS.manual ? { secondLine: manualValueText(manual) } : {}),
    },
  ];
}

/**
 * 접수증 옆 동작 `할인 적용`의 창: 칸 줄 · 할인 고르기 · 요약(`장비 225,000원 → 202,500원 · 미수 202,500원`, 앞 값은 그 칸의 지금 청구) · 환불 줄(더 낸 돈이 될 때) · 주 버튼 ·
 * 명령(discount.apply, 이어서 payment.refund).
 */
export function discountSheet(ctx: ViewContext, params: DiscountSheetParams): DiscountSheetView {
  const state = ctx.state;
  const reg = state.registry;
  const forbidden = (ctx.lines ?? { forbidden: '권한 없음 · 관리자 확인 필요' }).forbidden;
  const o = findOrder(state, params.orderId);
  if (!o) throw new DomainError('NOT_FOUND', '없는 접수: ' + params.orderId);
  // 살아 있는 줄이 있는 칸만(모두 취소한 칸은 빠진다).
  const withLines = reg.paySections.filter((s) => sectionGross(o, s.key) > 0);
  const section: DiscountSectionKey = withLines.find((s) => s.key === params.sectionKey)?.key ?? withLines[0]?.key ?? 'gear';
  const sectionLabel = reg.paySections.find((s) => s.key === section)?.label ?? '';
  const current = currentApplication(o, section);
  const choice = params.choice ?? choiceOf(current);
  const plan = discountPlan(reg, o, section, choice, ctx.viewer);
  // 청구 조정(더 큰 할인 = 음수): 새 청구 = 지금 청구 + change.
  const change = plan.invalid ? 0 : plan.before - plan.after;
  const chargedAfter = charged(o) + change;
  const paid = paidTotal(o);
  const dueAfter = Math.max(0, chargedAfter - paid);
  const overAfter = Math.max(0, paid - chargedAfter);
  // 이 바뀜이 비운 돈만 돌려준다(앞에서 더 낸 돈은 확인 필요 `초과 수납`의 몫).
  const refundAmount = Math.min(overAfter, Math.max(0, -change));
  const { picks, short } = refundAmount > 0 ? refundPicks(reg, o, refundAmount, section, params.methods ?? {}, ctx.viewer) : { picks: [], short: 0 };
  const refundView = refundLineViews(reg, o, picks, short);
  const refundTotal = picks.reduce((sum, x) => sum + x.amount, 0);

  // 칸의 지금 청구 → 새 청구(할인 앞 값이 아니라 지금 받는 값에서: 해제하면 오르는 것이 보이게, 2026-09-27 점검). 바뀌지 않으면 화살표 없이 지금 값.
  const nowCharge = plan.gross - plan.before;
  const nextCharge = plan.invalid ? nowCharge : plan.gross - plan.after;
  const summary: RichText = [
    { text: sectionLabel + ' ' + won(nowCharge) + (nextCharge !== nowCharge ? ' → ' + won(nextCharge) : ''), strong: true },
    { text: ' · ' + (overAfter > 0 ? DISCOUNT_WORDS.refund + ' ' + won(overAfter) : dueAfter > 0 ? DISCOUNT_WORDS.due + ' ' + won(dueAfter) : DISCOUNT_WORDS.noDue) },
  ];
  // `변경 없음`은 사람이 지금 할인을 다시 골랐을 때만(창을 막 연 때는 요약 줄 그대로, 주 버튼만 막힘).
  const notice = plan.invalid === 'same' && params.choice !== undefined ? DISCOUNT_WORDS.noChange : plan.invalid === 'forbidden' ? forbidden : undefined;
  const methods = [...new Set(picks.map((x) => x.methodKey))];
  const removal = !plan.invalid && plan.app.kind === 'none';
  let label: string = DISCOUNT_WORDS.apply;
  const alts: string[] = [];
  if (!plan.invalid) {
    if (removal) label = DISCOUNT_WORDS.removal + ' · ' + won(plan.before);
    else if (refundTotal > 0) {
      label = DISCOUNT_WORDS.apply + ' · ' + DISCOUNT_WORDS.refund + ' ' + (methods.length === 1 ? methodLabelOf(reg, methods[0]!) + ' ' : '') + won(refundTotal);
      alts.push(DISCOUNT_WORDS.apply + ' · ' + DISCOUNT_WORDS.refund + ' ' + won(refundTotal));
    } else label = DISCOUNT_WORDS.apply + ' · ' + won(plan.after);
    alts.push(removal ? DISCOUNT_WORDS.removal : DISCOUNT_WORDS.apply);
  }
  const ready = !plan.invalid;
  const refunds: RefundInput[] = picks.map((x) => ({ paymentId: x.payment.id, methodKey: x.methodKey, amount: x.amount }));
  const manual = 'manual' in choice ? choice.manual : undefined;
  const spec = manualSpec(ctx.viewer, section, sectionLabel, plan.gross, forbidden);
  return {
    basis: { epoch: state.epoch, rev: state.rev },
    serverTime: iso(ctx.now),
    currentBusinessDate: state.businessDate,
    title: DISCOUNT_WORDS.apply + ' · ' + o.teamName + ' 팀',
    sections: withLines.map((s) => ({ key: s.key, label: s.label, selected: s.key === section, enabled: true })),
    choices: discountOptions(reg, section, choiceKey(choice), ctx.viewer, forbidden, manual),
    ...(spec ? { manual: spec } : {}),
    summary,
    refunds: refundView.lines,
    ...(notice ? { notice } : {}),
    choice,
    sectionKey: section,
    primary: { label, alts: [...new Set([label, ...alts])], enabled: ready },
    ...(ready
      ? {
        command: { type: 'discount.apply' as const, payload: { orderId: o.id, sectionKey: section, choice } },
        expect: { dueAmount: ownDue(o), quoteHash: discountQuote(plan) },
        ...(refunds.length
          ? { then: [{ command: { type: 'payment.refund' as const, payload: { orderId: o.id, cause: 'discount' as const, refunds } }, expect: { refundAmount: refundTotal } }] }
          : {}),
      }
      : {}),
  };
}

// ── 접수증 출처 줄 ─────────────────────────────────────────────────────

/**
 * 접수증 품목 표 아래의 출처 줄: 칸마다 지금 할인(`장비 10% 할인 · −22,500원`, 직접 입력은 사유 `장비 할인 직접 입력 · 단골 · −5,000원`), 할인을
 * 해제한 칸은 `장비 할인 해제`(옅은 먹, 금액 없음), 환불은 `환불 · 현금 22,500원`(옅은 먹, 금액 없음: 청구가 아니다). 금액이 있는 줄 = 청구에 든다.
 */
export function slipAdjustments(reg: ShopRegistry, o: FxOrder, middle: readonly SlipAdjustment[] = []): SlipAdjustment[] {
  const out: SlipAdjustment[] = [];
  for (const s of reg.paySections) {
    const app = currentApplication(o, s.key);
    if (!app) continue;
    const now = sectionDiscountNow(o, s.key);
    if (app.kind === 'none' || now <= 0) {
      if (app.kind === 'none') out.push({ key: 'discount:' + s.key, parts: [{ text: s.label + ' ' + DISCOUNT_WORDS.removal, drop: 0 }], tone: 'muted' });
      continue;
    }
    out.push({
      key: 'discount:' + s.key,
      parts: [{ text: s.label + ' ' + app.label, drop: 0, words: true }, ...(app.reason ? [{ text: app.reason, drop: 1 }] : [])],
      amount: -now,
    });
  }
  // 할인 줄 뒤에 취소 · 추가 줄(middle, order-edit.ts), 맨 뒤에 환불(돈이 나간 차례).
  out.push(...middle);
  for (const r of o.refunds ?? []) out.push({ key: 'refund:' + r.id, parts: refundParts(reg, r.methodKey, r.amount), tone: 'muted' });
  return out;
}

/** 금액 줄의 글(`−22,500원`). */
export const adjustmentAmountText = (amount: number) => minusWon(amount);

// V4 접수 확정 창 · 칸별 수납(spec 3-3, ui 4-5 · 6-4, catalog 15)의 읽기 모델(checkoutSheet)과 명령(order.create). 체험 전용이고
// LocalClient가 오면 폴더째 없어진다. 화면은 칸마다 누른 수단 · 할인 · 결제 팀만 인자로 다시 묻고, 칸 글 · 결제 팀 줄 · 받을 금액 줄 ·
// 주 버튼 · 명령은 모두 여기서 쓴다(문구 표 docs/design/wording.md 3-7의 말).
//   - 칸: 장비 · 리프트권(두 줄 칸: 빠른 수단 카드 · 현금 · 계좌이체 + `후불` + `기타` + `할인 적용 ›`), 리프트권 보증금(수단이 현금
//     하나라 버튼 없는 한 줄 칸, 입금 시점 접수 시 · 현장 접수만 — 전화 예약은 지급 창이 묻는다, plan §8 D38).
//   - 처음 선택은 칸의 기본 수단(장비 카드 · 리프트권 현금). 전화 예약이면 선입금 전액(prepayment_mode)이라 리프트권 칸의 `후불`을
//     누를 수 없다. `후불`인 칸은 옅은 먹 금액이고, 결제 팀 줄(이 팀 · 다른 팀을 내는 팀 · 찾은 팀)이 `후불`인 칸 모두에 걸린다.
//     한 칸만 다른 팀이 내게 하려면 `기타` 판의 `다른 팀 결제`(그 칸의 payerOrderId).
//   - 할인은 칸(할인 묶음)마다 하나(10원 단위로 내림, 줄에 비율로 나눔 — catalog 9). 가격 계산은 요금표(quoteOf)와 같고, 명령의
//     expect.quoteHash가 서버가 다시 계산한 값과 다르면 충돌(QUOTE_CHANGED).
//   - 확정(order.create)은 명령 하나: 접수(접수 번호 261226-0NN) · 품목 줄(번호는 지급 때) · 수령 · 반납 일정 · 칸마다 실제 돈 한 건
//     (결제 자리 intake_confirm) · 보증금 입금(보증금 장부, 수납이 아님) · `후불` 칸의 결제 팀(줄 · 접수).
import {
  CHECKOUT_KEYS, type CheckoutChoice, type CheckoutSection, type CheckoutSheetParams, type CheckoutSheetView, type ChoiceOption, type CommandEnvelope,
  type OrderDraftInput, type RichText,
} from '@skinote/contract';
import {
  DISCOUNTS, KINDS, PAY_METHODS, PAY_SECTIONS, cleanItems, discountAmount, discountOf, discountedAmounts, kindOf, payMethodOf, variantOf, type FxDiscount,
  type FxPaySection, type Quote, type QuoteLine,
} from './catalog.ts';
import type { FxDeposit, FxDepositRule, FxLine, FxMethodKey, FxOrder, FxPayment, FxPaymentGroup, FxPromise, FxState } from './model.ts';
import { phoneText, resolveSchedule, type ResolvedPickup, type ResolvedReturn } from './order-draft.ts';
import { PAST, timeReason } from './promise-sheet.ts';
import { conflict, rejected, type Result } from './result.ts';
import { findOrder } from './rules.ts';
import { liftReturnable } from './seed.ts';
import type { ViewContext } from './views.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';

/** 후불(payment_timings later) · `기타` · `기타` 판의 `다른 팀 결제` · `할인 없음` · 결제 팀 줄의 이 팀(계약의 약속된 key). */
export const LATER = CHECKOUT_KEYS.later;
const OTHER = CHECKOUT_KEYS.other;
const OTHER_TEAM = CHECKOUT_KEYS.otherTeam;
const NO_DISCOUNT = CHECKOUT_KEYS.noDiscount;
export const SELF = CHECKOUT_KEYS.self;
/** 결제 팀 줄에 보일 다른 팀 수(찾은 팀 포함). */
const PAYER_OPTIONS = 2;
const UNKNOWN = '체험판 미지원';
const UNKNOWN_METHOD = '등록되지 않은 결제 수단';

// ── 셈(화면의 읽기 모델과 order.create가 같은 셈을 쓴다) ─────────────────────────

/** 두 줄 칸 하나(장비 · 리프트권)의 셈. */
interface PlanSection {
  pay: FxPaySection;
  lines: QuoteLine[];
  gross: number;
  discount?: FxDiscount;
  net: number;
  /** 줄마다 할인을 뺀 값(lines 차례). */
  netLines: number[];
  methodKey: FxMethodKey | typeof LATER;
  /** 이 칸만의 다른 팀(`기타` → `다른 팀 결제`). */
  ownPayer?: FxOrder;
  /** `후불`을 고를 수 있는지(전화 예약의 리프트권은 선입금 전액). */
  laterAllowed: boolean;
}

/** 보증금 칸(규칙 하나, 입금 시점 접수 시 · 현장 접수). */
interface PlanDeposit {
  rule: FxDepositRule;
  lines: QuoteLine[];
  units: number;
  unitAmount: number;
  amount: number;
  methodKey: FxMethodKey;
}

export interface CheckoutPlan {
  draft: OrderDraftInput;
  pickup: ResolvedPickup;
  giveBack: ResolvedReturn;
  quote: Quote;
  sections: PlanSection[];
  deposit: PlanDeposit | null;
  /** 결제 팀 줄의 팀(다른 팀). null이면 이 팀. */
  payer: FxOrder | null;
  /** 받은 인자 중 틀린 것(없는 칸 · 수단 · 팀): 창은 만들지 않고, 명령은 거절한다. */
  invalid?: string;
  /** 대표자 · 품목이 있음. */
  itemsReady: boolean;
  /** 수령 · 반납 일정이 정해졌고 지금 고를 수 있음. */
  scheduleReady: boolean;
  /** 일정이 안 되는 까닭(그사이 시각이 지남). */
  reason?: string;
  /** 서버가 계산한 가격(요금표 견적 + 칸마다 할인 뒤 금액). 명령의 expect.quoteHash. */
  hash: string;
  /** 명령에 실을 선택(칸마다 하나, 보증금 칸 포함). */
  choices: CheckoutChoice[];
}

/** 결제 칸 키 → 그 칸의 금액이 있는 줄. */
const linesOf = (quote: Quote, pay: FxPaySection) => quote.lines.filter((l) => l.product.section === pay.key);

/** 보증금 칸: 규칙이 있고 입금 시점이 접수 시이고 현장 접수(손님이 카운터에 있음)일 때. 전화 예약은 지급 창이 묻는다(D38). */
function depositOf(state: FxState, draft: OrderDraftInput, quote: Quote): PlanDeposit | null {
  const rule = state.settings.liftDeposit;
  if (!rule || rule.timing !== 'at_intake' || draft.channel !== 'walk_in' || quote.depositUnits <= 0) return null;
  const lines = quote.lines.filter((l) => l.product.section === rule.section);
  return { rule, lines, units: quote.depositUnits, unitAmount: quote.depositUnitAmount, amount: quote.deposit, methodKey: rule.methods[0] ?? 'cash' };
}

/** 인자의 선택을 읽는다(없으면 칸의 기본). 틀린 것(없는 칸 · 수단 · 할인 · 팀)은 invalid로 알린다: 창은 주 버튼을 막고, 명령은 거절한다. */
export function checkoutPlan(
  state: FxState, now: number, draft: OrderDraftInput, choices: readonly CheckoutChoice[] = [], payerOrderId?: string | null,
): CheckoutPlan {
  const { pickup, giveBack, quote } = resolveSchedule(state, now, draft);
  let invalid: string | undefined;
  const given = new Map(choices.map((c) => [c.sectionKey, c]));
  const prepaid = draft.channel === 'phone' && state.settings.prepaymentMode === 'full_lift_ticket';
  const sections: PlanSection[] = [];
  for (const pay of PAY_SECTIONS) {
    const lines = linesOf(quote, pay);
    if (!lines.length) continue;
    const gross = lines.reduce((sum, l) => sum + l.amount, 0);
    const choice = given.get(pay.key);
    const laterAllowed = !(prepaid && pay.key === 'lift');
    let methodKey: PlanSection['methodKey'] = pay.defaultMethod;
    let ownPayer: FxOrder | undefined;
    if (choice) {
      const method = payMethodOf(choice.methodKey);
      if (method) methodKey = method.key;
      else if (choice.methodKey === LATER && laterAllowed) methodKey = LATER;
      else invalid ??= UNKNOWN_METHOD;
      if (choice.payerOrderId !== undefined) {
        const other = findOrder(state, choice.payerOrderId);
        if (other && methodKey === LATER) ownPayer = other;
        else invalid ??= UNKNOWN;
      }
    }
    const discount = choice?.discountKey && choice.discountKey !== NO_DISCOUNT ? discountOf(choice.discountKey, pay.key) : undefined;
    if (choice?.discountKey && choice.discountKey !== NO_DISCOUNT && !discount) invalid ??= UNKNOWN;
    const cut = discountAmount(gross, discount);
    const netLines = discountedAmounts(lines.map((l) => l.amount), cut);
    sections.push({ pay, lines, gross, ...(discount ? { discount } : {}), net: gross - cut, netLines, methodKey, ...(ownPayer ? { ownPayer } : {}), laterAllowed });
  }
  const deposit = depositOf(state, draft, quote);
  const depositChoice = deposit ? given.get(deposit.rule.key) : undefined;
  if (deposit && depositChoice) {
    const method = payMethodOf(depositChoice.methodKey);
    if (method && deposit.rule.methods.includes(method.key)) deposit.methodKey = method.key;
    else invalid ??= UNKNOWN_METHOD;
  }
  for (const c of choices) {
    if (!sections.some((s) => s.pay.key === c.sectionKey) && c.sectionKey !== deposit?.rule.key) invalid ??= UNKNOWN;
  }
  const payer = payerOrderId ? findOrder(state, payerOrderId) ?? null : null;
  if (payerOrderId && !payer) invalid ??= UNKNOWN;

  const name = draft.leader.name.trim();
  const itemsReady = name !== '' && cleanItems(draft.items).length > 0;
  const scheduleReady = pickup.complete && giveBack.complete;
  const reason = scheduleReady ? undefined : (giveBack.at !== undefined ? timeReason(giveBack.at, now) : undefined) ?? PAST;
  const hash = quote.hash + '|' + sections.map((s) => s.pay.key + (s.discount ? '-' + s.discount.key : '') + '=' + s.net).join(',');
  const resolved: CheckoutChoice[] = [
    ...sections.map((s) => ({
      sectionKey: s.pay.key, methodKey: s.methodKey, ...(s.discount ? { discountKey: s.discount.key } : {}), ...(s.ownPayer ? { payerOrderId: s.ownPayer.id } : {}),
    })),
    ...(deposit ? [{ sectionKey: deposit.rule.key, methodKey: deposit.methodKey }] : []),
  ];
  return {
    draft, pickup, giveBack, quote, sections, deposit, payer, ...(invalid ? { invalid } : {}), itemsReady, scheduleReady, ...(reason ? { reason } : {}),
    hash, choices: resolved,
  };
}

/** `후불`인 칸을 낼 팀(이 칸만의 팀, 아니면 결제 팀 줄의 팀). null = 이 팀. */
const payerOf = (plan: CheckoutPlan, s: PlanSection): FxOrder | null => (s.methodKey === LATER ? s.ownPayer ?? plan.payer : null);

// ── 읽기 모델(checkoutSheet) ───────────────────────────────────────────

const teamLabel = (o: FxOrder) => o.teamName + (o.last4 ? ' · ' + o.last4 : '');
const last4Of = (digits: string) => (digits.replace(/\D/g, '').length >= 4 ? digits.replace(/\D/g, '').slice(-4) : '');
const methodLabel = (key: string) => payMethodOf(key)?.label ?? '';

/** 칸 제목 줄의 품목: 장비는 종류마다(`스키 4 · 의류 3 · 헬멧 1`, 하루를 넘기면 `· 2일`), 리프트권은 권종마다(`야간권 성인 4매`). */
function itemList(s: PlanSection, days: number): string[] {
  if (s.pay.key === 'lift') return s.lines.map((l) => l.product.label + ' ' + l.item.quantity + l.product.countWord);
  return [
    ...KINDS.flatMap((k) => {
      const n = s.lines.filter((l) => l.product.kindKey === k.key).reduce((sum, l) => sum + l.item.quantity, 0);
      return n > 0 ? [k.label + ' ' + n] : [];
    }),
    ...(days > 1 ? [days + '일'] : []),
  ];
}

/** 이 칸 할인 묶음의 할인(`할인 적용 ›` 작은 창). */
const discountsFor = (s: PlanSection) => DISCOUNTS.filter((d) => d.sections.includes(s.pay.key));

/**
 * 결제 팀 줄에 보일 다른 팀: 고른 팀과 이 창에서 끝 4자리로 찾은 팀만(찾은 차례, 같은 팀은 한 번). 오늘 다른 팀 몫을 내는 팀을 모두
 * 내보이면 관련 없는 현장 접수에도 한 번 누름으로 남의 가족에게 청구가 걸린다.
 */
function linkedTeams(state: FxState, payer: FxOrder | null, found: readonly string[] | undefined): FxOrder[] {
  const ids = [...(payer ? [payer.id] : []), ...(found ?? [])];
  return [...new Set(ids)].map((id) => findOrder(state, id)).filter((o): o is FxOrder => o !== undefined);
}

function sectionView(plan: CheckoutPlan, s: PlanSection): CheckoutSection {
  const later = s.methodKey === LATER;
  const payer = payerOf(plan, s);
  const method = payMethodOf(s.methodKey);
  const nonQuick = method !== undefined && !method.quick;
  const quick = PAY_METHODS.filter((m) => m.quick);
  const methods: ChoiceOption[] = [
    ...quick.map((m) => ({ key: m.key, label: m.label, selected: s.methodKey === m.key, enabled: true })),
    { key: LATER, label: '후불', selected: later && !s.ownPayer, enabled: s.laterAllowed },
    {
      key: OTHER, label: '기타', selected: nonQuick || s.ownPayer !== undefined, enabled: true,
      ...(nonQuick ? { secondLine: method.label } : s.ownPayer ? { secondLine: teamLabel(s.ownPayer) } : {}),
    },
  ];
  const discounts: ChoiceOption[] = [
    { key: NO_DISCOUNT, label: '할인 없음', selected: !s.discount, enabled: true },
    ...discountsFor(s).map((d) => ({ key: d.key, label: d.label, selected: s.discount?.key === d.key, enabled: true })),
  ];
  const others: ChoiceOption[] = [
    ...PAY_METHODS.filter((m) => !m.quick).map((m) => ({ key: m.key, label: m.label, selected: s.methodKey === m.key, enabled: true })),
    ...(s.laterAllowed ? [{ key: OTHER_TEAM, label: '다른 팀 결제', opens: true, selected: s.ownPayer !== undefined, enabled: true }] : []),
  ];
  const items = itemList(s, plan.quote.days);
  return {
    key: s.pay.key,
    label: s.pay.label,
    items: items.join(' · '),
    itemList: items,
    ...(s.discount ? { discount: s.discount.label + ' · ' + won(s.gross) + ' → ' + won(s.net), discountShort: s.discount.label } : { discount: '할인 없음' }),
    ...(payer ? { payerNote: payer.teamName + ' 팀 결제 예정' } : {}),
    amount: s.net,
    amountMuted: later,
    methods,
    discountable: true,
    discounts,
    others,
    choice: plan.choices.find((c) => c.sectionKey === s.pay.key)!,
  };
}

function depositView(plan: CheckoutPlan, d: PlanDeposit): CheckoutSection {
  const word = d.lines[0]?.product.countWord ?? '매';
  const two = d.rule.methods.length > 1;
  return {
    key: d.rule.key,
    label: d.rule.label,
    items: [d.units + word, '매장 기준 1' + word + ' ' + won(d.unitAmount), '반납 시 반환'].join(' · '),
    amount: d.amount,
    amountMuted: false,
    discountable: false,
    ...(two
      ? { methods: d.rule.methods.map((key) => ({ key, label: methodLabel(key), selected: d.methodKey === key, enabled: true })) }
      : { single: [{ text: methodLabel(d.methodKey) + ' ' + won(d.amount), strong: true }] }),
    choice: plan.choices.find((c) => c.sectionKey === d.rule.key)!,
  };
}

/** 지금 받을 돈(수단마다 합, PAY_METHODS 차례)과 그 구성(칸 · 보증금). */
function dueOf(plan: CheckoutPlan) {
  const parts: { label: string; amount: number; methodKey: FxMethodKey }[] = [];
  for (const s of plan.sections) {
    if (s.methodKey !== LATER && s.net > 0) parts.push({ label: s.pay.label, amount: s.net, methodKey: s.methodKey });
  }
  const deposit = plan.deposit && plan.deposit.amount > 0 ? { label: '보증금', amount: plan.deposit.amount, methodKey: plan.deposit.methodKey } : null;
  const all = [...parts, ...(deposit ? [deposit] : [])];
  const byMethod = PAY_METHODS.map((m) => ({ key: m.key, label: m.label, amount: all.filter((p) => p.methodKey === m.key).reduce((sum, p) => sum + p.amount, 0) }))
    .filter((m) => m.amount > 0);
  return { all, deposit, byMethod, total: all.reduce((sum, p) => sum + p.amount, 0) };
}

export function checkoutSheet(ctx: ViewContext, params: CheckoutSheetParams): CheckoutSheetView {
  const state = ctx.state;
  const plan = checkoutPlan(state, ctx.now, params.draft, params.choices ?? [], params.payerOrderId);
  const name = params.draft.leader.name.trim();
  const title = name ? '결제 · ' + name + ' 팀' : '결제';

  const sections = [...plan.sections.map((s) => sectionView(plan, s)), ...(plan.deposit ? [depositView(plan, plan.deposit)] : [])];

  // 결제 팀 줄: `후불`인 칸(이 칸만의 팀이 없는 것) 모두에 건다. 이 팀 · 찾은 팀 · 다른 팀 몫을 내는 팀.
  const laterRow = plan.sections.filter((s) => s.methodKey === LATER && !s.ownPayer);
  const selfLabel = name + (last4Of(params.draft.leader.phone) ? ' · ' + last4Of(params.draft.leader.phone) : '');
  const others = linkedTeams(state, plan.payer, params.foundPayerIds).slice(0, PAYER_OPTIONS);
  const payer = {
    visible: laterRow.length > 0,
    label: laterRow.length
      ? laterRow.map((s) => s.pay.label).join(' · ') + ' ' + won(laterRow.reduce((sum, s) => sum + s.net, 0)) + ' · 결제 팀'
      : '결제 팀',
    options: [
      { key: SELF, label: selfLabel, selected: plan.payer === null, enabled: true },
      ...others.map((o) => ({ key: o.id, label: teamLabel(o), selected: plan.payer?.id === o.id, enabled: true })),
    ],
  };

  const due = dueOf(plan);
  let dueLine: RichText;
  if (due.total === 0) dueLine = [{ text: '받을 금액 없음', strong: true }];
  else if (due.byMethod.length === 1) {
    const only = due.byMethod[0]!;
    dueLine = [
      { text: '받을 금액', strong: true },
      { text: ' ' + only.label + ' ' + won(only.amount), strong: true },
      ...(due.all.length > 1 ? [{ text: ' = ' + due.all.map((p) => p.label + ' ' + won(p.amount)).join(' + ') }] : []),
    ];
  } else {
    dueLine = [
      { text: '받을 금액', strong: true },
      { text: ' ' + due.byMethod.map((m) => m.label + ' ' + won(m.amount)).join(' · '), strong: true },
      ...(due.deposit ? [{ text: ' (' + methodLabel(due.deposit.methodKey) + ' 중 보증금 ' + won(due.deposit.amount) + ')' }] : []),
    ];
  }
  const base = '접수 확정';
  const label = due.total === 0 ? base : base + ' · ' + due.byMethod.map((m) => m.label + ' ' + won(m.amount)).join(' · ');
  const alts = [label, ...(due.byMethod.length > 1 ? [base + ' · ' + won(due.total)] : []), ...(label !== base ? [base] : [])];
  const ready = plan.itemsReady && plan.scheduleReady && !plan.invalid;
  return {
    basis: { epoch: state.epoch, rev: state.rev },
    title,
    sections,
    payer,
    due: dueLine,
    ...(plan.itemsReady && !plan.scheduleReady && plan.reason ? { notice: plan.reason } : {}),
    primary: { label, alts, enabled: ready },
    ...(ready
      ? {
        command: { type: 'order.create' as const, payload: { draft: params.draft, choices: plan.choices, payerOrderId: plan.payer?.id ?? null } },
        expect: { quoteHash: plan.hash },
      }
      : {}),
  };
}

// ── 명령(order.create) ────────────────────────────────────────────────

/** 접수증 · 반납 창의 줄 이름: 규격이 있으면 그 이름을 붙인다('의류 사이즈 95', '헬멧 중 사이즈', '고글 어른'). */
function lineLabel(l: QuoteLine): string {
  const kind = kindOf(l.product.kindKey);
  const variant = variantOf(kind, l.item.variantKey);
  return variant ? l.product.label + ' ' + variant.name : l.product.label;
}

const promiseOf = (at: number, mode: 'store' | 'vehicle', placeKey: string | undefined, vehicleId: string): FxPromise =>
  mode === 'vehicle' ? { at, mode, ...(placeKey ? { placeId: placeKey } : {}), vehicleId } : { at, mode: 'store' };

/**
 * 새 접수 확정(order.create): 창이 본 가격(expect.quoteHash)이 지금 셈과 같고 선택이 모두 맞을 때만 접수 하나를 만든다. 품목 줄은
 * 규격마다 한 줄(번호는 지급 때), 리프트권 줄의 반납 여부는 운영 규칙에서 복사, 칸마다 실제 돈 한 건(결제 자리 intake_confirm,
 * 현금은 카운터 돈통), 보증금은 보증금 장부의 입금(수납이 아님), `후불` 칸은 결제 팀(다른 팀이면 줄 · 접수에 적는다). 결과에 새 접수
 * id · 접수 번호(같은 요청번호로 다시 보내면 applyCommand가 처음 결과를 돌려준다).
 */
export function createOrder(state: FxState, envelope: CommandEnvelope<'order.create'>, now: number): Result {
  const p = envelope.payload;
  const plan = checkoutPlan(state, now, p.draft, p.choices, p.payerOrderId);
  if (plan.invalid) return rejected(plan.invalid);
  if (!plan.itemsReady) return rejected(UNKNOWN);
  if (!plan.scheduleReady) return conflict('SCHEDULE_CHANGED', plan.reason ?? PAST);
  if (envelope.expect?.quoteHash !== plan.hash) return conflict('QUOTE_CHANGED', '받을 금액 변경됨 · 재시도 필요');
  const { draft, pickup, giveBack } = plan;
  if (giveBack.at === undefined) return rejected(UNKNOWN);

  const seq = state.nextReceiptSeq;
  const id = 'n' + seq;
  const receiptNo = state.businessDate.slice(2).replace(/-/g, '') + '-' + String(seq).padStart(3, '0');
  const digits = draft.leader.phone.replace(/\D/g, '');
  const lines: FxLine[] = [];
  let n = 0;
  for (const s of plan.sections) {
    const payer = payerOf(plan, s);
    s.lines.forEach((q, i) => {
      n += 1;
      const product = q.product;
      lines.push({
        id: id + '-l' + n,
        kind: product.key,
        label: lineLabel(q),
        shortLabel: product.shortLabel ?? product.label,
        qty: q.item.quantity,
        ...(product.unit ? { unit: product.unit } : {}),
        countWord: product.countWord,
        amount: s.netLines[i] ?? q.amount,
        section: product.section,
        returnable: product.section === 'lift' ? liftReturnable(state.settings) : product.returnable,
        capabilities: [...product.capabilities],
        tracking: product.tracking,
        loaded: 0,
        issued: 0,
        returned: 0,
        collected: 0,
        received: 0,
        productKey: product.key,
        ...(q.item.variantKey !== undefined ? { variantKey: q.item.variantKey } : {}),
        ...(payer ? { payerOrderId: payer.id } : {}),
      });
    });
  }

  // 칸마다 실제 돈 한 건(ADR-09). 후불 칸은 돈이 없다.
  const payments: FxPayment[] = [];
  for (const s of plan.sections) {
    if (s.methodKey === LATER || s.net <= 0) continue;
    const groupId = envelope.requestId + ':' + s.pay.key;
    const drawer = s.methodKey === 'cash' ? { drawerId: 'counter' } : {};
    const group: FxPaymentGroup = { id: groupId, purpose: 'intake_confirm', amount: s.net, methodKey: s.methodKey, at: now, ...drawer };
    state.paymentGroups.push(group);
    payments.push({ id: groupId, amount: s.net, methodKey: s.methodKey, at: now, section: s.pay.key, groupId, ...drawer });
  }

  // 결제 팀: 후불 칸이 모두 같은 다른 팀이면 접수에도 적는다(장부 금액 칸 `이정호 팀 결제 예정`, 그 팀의 받을 금액). 이 팀의 후불은
  // 매장 직접 · 즉시면 반납 때, 예약 · 배달이면 수령 때 받는다.
  const laterSections = plan.sections.filter((s) => s.methodKey === LATER && s.net > 0);
  const laterPayers = [...new Set(laterSections.map((s) => payerOf(plan, s)?.id ?? SELF))];
  const orderPayer = laterPayers.length === 1 && laterPayers[0] !== SELF ? laterPayers[0] : undefined;
  const selfLater = laterPayers.includes(SELF);

  const o: FxOrder = {
    id,
    receiptNo,
    teamName: draft.leader.name.trim(),
    last4: last4Of(digits),
    phone: phoneText(digits),
    channel: draft.channel,
    party: Math.max(0, Math.floor(draft.leader.party) || 0),
    createdAt: now,
    pickup: promiseOf(pickup.at, pickup.mode, pickup.placeKey, giveBack.vehicleId),
    giveBack: promiseOf(giveBack.at, giveBack.mode, giveBack.placeKey, giveBack.vehicleId),
    lines,
    payments,
    ...(orderPayer ? { payerOrderId: orderPayer } : {}),
    payWhen: selfLater && pickup.kind === 'now' ? 'return' : 'pickup',
    ...(plan.sections.some((s) => s.discount)
      ? {
        discounts: plan.sections.filter((s) => s.discount).map((s) => ({
          sectionKey: s.pay.key, discountKey: s.discount!.key, label: s.discount!.label, amount: s.gross - s.net, at: now,
        })),
      }
      : {}),
  };

  // 보증금 입금(접수 시, 현장 접수): 팀 · 규칙마다 보관 하나(규칙 값 복사), 매수는 권 줄마다. 번호는 지급 때 정해진다.
  if (plan.deposit) {
    const d = plan.deposit;
    const dep: FxDeposit = { id: 'dep:' + id + ':' + d.rule.key, orderId: id, ruleKey: d.rule.key, label: d.rule.label, unitAmount: d.unitAmount, entries: [] };
    d.lines.forEach((q, i) => {
      const line = lines.find((l) => l.productKey === q.product.key && l.variantKey === q.item.variantKey);
      if (!line) return;
      dep.entries.push({
        id: envelope.requestId + ':d' + i, kind: 'take', lineId: line.id, quantity: q.item.quantity, amount: q.item.quantity * d.unitAmount,
        methodKey: d.methodKey, at: now, ...(d.methodKey === 'cash' ? { drawerId: 'counter' } : {}),
      });
    });
    state.deposits.push(dep);
  }

  state.orders.push(o);
  state.nextReceiptSeq = seq + 1;
  return { outcome: 'applied', result: { orderId: id, receiptNo } };
}

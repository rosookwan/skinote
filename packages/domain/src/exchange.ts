// 즉시 교환(work/impl-features-1/plan.md §7, E14): 카운터에서 사이즈가 있는 수량 줄(의류 · 헬멧 · 부츠 · 고글 …)의 수량 일부를 같은 종류의 다른
// 사이즈로 바꾼다. 손님에게 있는 것(held)은 옛 사이즈가 매장으로 돌아오고 새 사이즈가 나간다(저장소의 이동 두 줄), 아직 지급하지 않은 것(planned,
// 전화 예약의 준비한 사이즈)은 이동 없이 뒤의 지급이 새 사이즈다. 돈은 바뀌지 않는다(값은 상품마다, `금액 유지`). 누가 · 언제는 명령을 한 사람 ·
// 시각(FxSwap.byName · at). 기사 업무 판에는 없다(E14: 2 × 2 버튼 판에 자리가 없고 exchange.swap은 기사 오프라인 목록에 없다).
//   - exchange.swap: 줄 · 옛 사이즈 · 지급 전인지 · 수 · 새 사이즈를 확인하고 교환 한 건을 쌓는다(variants.ts의 자리 셈).
//   - 창(exchangeSheet): 교환 품목 · 수량 · 지급 사이즈 · 요약 · 주 버튼 · 명령.
//   - 접수증 출처 줄: `즉시 교환 · 헬멧 중 사이즈 → 대 사이즈 · 1개 · 16:20`(옅은 먹, 금액 없음).
// 화면 글은 docs/design/wording.md 3-20(확인 대기)의 말이다.
import {
  ACTION_LABELS, DomainError, type ChoiceOption, type CommandEnvelope, type ExchangeItemOption, type ExchangeSheetParams, type ExchangeSheetView, type FitPart,
  type SlipAdjustment,
} from '@skinote/contract';
import { variantOf, type FxKind } from './catalog.ts';
import type { DomainLines, FxLine, FxOrder, FxSwap, ShopRegistry, ShopState } from './model.ts';
import { rejected, type Result } from './result.ts';
import { findOrder } from './rules.ts';
import { hm, iso } from './time.ts';
import { heldVariants, lineKind, plannedVariants, swapBase, swapKind, type VariantPart } from './variants.ts';
import type { ViewContext } from './views.ts';

export const EXCHANGE_WORDS = Object.freeze({
  /** 동작 이름(시드 sys_actions.exchange_swap). */
  action: ACTION_LABELS.exchange_swap,
  held: '반납 사이즈',
  planned: '지급 예정 사이즈',
  keep: '금액 유지',
  none: '교환 불가 · 교환 대상 없음',
});

const countWord = (l: FxLine) => l.countWord ?? l.unit ?? '개';

/** 교환 품목 하나: 줄 · 지급 전인지 · 옛 사이즈 · 그 사이즈의 수. */
export interface SwapItem {
  l: FxLine;
  planned: boolean;
  from: string;
  count: number;
}

/**
 * 접수의 교환 품목(줄 차례, 줄마다 손님에게 있는 것의 사이즈 → 매장의 지급 전 것의 사이즈). 교환할 수 없는 줄(번호 줄 · 사이즈 없는 줄 · 능력 없음)은
 * 빠진다.
 */
export function swapItems(reg: ShopRegistry, o: FxOrder): SwapItem[] {
  const out: SwapItem[] = [];
  for (const l of o.lines) {
    if (!swapKind(reg, l)) continue;
    const push = (parts: readonly VariantPart[], planned: boolean) => {
      for (const p of parts) if (p.quantity > 0) out.push({ l, planned, from: p.key, count: p.quantity });
    };
    push(heldVariants(l), false);
    push(plannedVariants(l), true);
  }
  return out;
}

const itemKey = (x: Pick<SwapItem, 'planned' | 'from'> & { lineId: string }) => x.lineId + '|' + (x.planned ? 'p' : 'h') + '|' + x.from;

/** 사이즈 이름(`중 사이즈` · `사이즈 100`, 매장 목록의 이름). 모르면 key. */
const sizeName = (kind: FxKind | undefined, key: string) => variantOf(kind, key)?.name ?? key;

/**
 * 즉시 교환(exchange.swap): 교환할 수 있는 줄이고, 옛 사이즈가 그 쪽(손님 · 매장의 지급 전)에 그만큼 있고, 새 사이즈가 같은 종류의 다른 사이즈면
 * 교환 한 건(요청번호 = 교환 id)을 줄에 쌓는다. 돈은 그대로다. 결과: 교환 id.
 */
export function exchangeSwap(state: ShopState, envelope: CommandEnvelope<'exchange.swap'>, now: number, _lines: DomainLines, actor?: { name?: string }): Result {
  const p = envelope.payload;
  const o = findOrder(state, p.orderId);
  if (!o) return rejected('접수 없음');
  const l = o.lines.find((x) => x.id === p.lineId);
  const found = l ? swapKind(state.registry, l) : null;
  if (!l || !found) return rejected(EXCHANGE_WORDS.none);
  const quantity = Math.floor(p.quantity);
  if (!(quantity >= 1) || p.from === p.to || !variantOf(found.kind, p.to)) return rejected(EXCHANGE_WORDS.none);
  const have = (p.planned ? plannedVariants(l) : heldVariants(l)).find((x) => x.key === p.from)?.quantity ?? 0;
  if (have < quantity) return rejected(EXCHANGE_WORDS.none);
  const swap: FxSwap = {
    id: envelope.requestId, at: now, quantity, from: p.from, to: p.to, planned: p.planned, base: swapBase(l, p.planned),
    ...(actor?.name ? { byName: actor.name } : {}),
  };
  l.swaps = [...(l.swaps ?? []), swap];
  return { outcome: 'applied', result: { exchangeId: envelope.requestId } };
}

// ── 창(exchangeSheet) ─────────────────────────────────────────────────

/**
 * 접수증 옆 동작 `즉시 교환`의 창: 교환 품목(버튼) · 수량(−/+, 둘째 줄에 옛 사이즈) · 지급 사이즈(그 종류의 다른 사이즈) · 요약 · 주 버튼 · 명령.
 * 교환할 것이 없으면 한 줄 `교환 불가 · 교환 대상 없음`(다른 카운터가 그사이 반납 처리한 때).
 */
export function exchangeSheet(ctx: ViewContext, params: ExchangeSheetParams): ExchangeSheetView {
  const state = ctx.state;
  const reg = state.registry;
  const o = findOrder(state, params.orderId);
  if (!o) throw new DomainError('NOT_FOUND', '없는 접수: ' + params.orderId);
  const items = swapItems(reg, o);
  const picked = items.find((x) => x.l.id === params.lineId && x.from === params.from && x.planned === (params.planned ?? false)) ?? items[0];
  const head = { basis: { epoch: state.epoch, rev: state.rev }, serverTime: iso(ctx.now), currentBusinessDate: state.businessDate };
  const title = EXCHANGE_WORDS.action + ' · ' + o.teamName + ' 팀';
  if (!picked) {
    return {
      ...head, title, items: [], sizes: [], summary: [], notice: EXCHANGE_WORDS.none,
      primary: { label: EXCHANGE_WORDS.action, alts: [EXCHANGE_WORDS.action], enabled: false },
    };
  }
  const found = lineKind(reg, picked.l)!;
  const kind = found.kind;
  const quantity = Math.min(picked.count, Math.max(1, Math.floor(params.quantity ?? 1)));
  const to = params.to !== undefined && params.to !== picked.from && variantOf(kind, params.to) ? params.to : undefined;
  const word = countWord(picked.l);
  // 교환 품목 버튼(`헬멧 중 사이즈 · 2개`, `의류 사이즈 100 · 1벌`): 수 앞의 `·`로 사이즈 숫자와 수가 붙어 읽히지 않게.
  const options: ExchangeItemOption[] = items.map((x) => {
    const lk = lineKind(reg, x.l);
    const label = (lk?.product.label ?? x.l.shortLabel) + ' ' + sizeName(lk?.kind, x.from) + ' · ' + x.count + countWord(x.l);
    return { key: itemKey({ lineId: x.l.id, planned: x.planned, from: x.from }), label, selected: x === picked, enabled: true, lineId: x.l.id, from: x.from, planned: x.planned };
  });
  const sizes: ChoiceOption[] = (kind.variants ?? []).filter((v) => v.key !== picked.from).map((v) => ({ key: v.key, label: v.label, selected: v.key === to, enabled: true }));
  const change = found.product.label + ' ' + sizeName(kind, picked.from) + (to ? ' → ' + sizeName(kind, to) : '');
  const label = EXCHANGE_WORDS.action + ' · ' + found.product.label + ' ' + quantity + word;
  return {
    ...head,
    title,
    items: options,
    quantity: {
      name: picked.planned ? EXCHANGE_WORDS.planned : EXCHANGE_WORDS.held,
      note: sizeName(kind, picked.from),
      input: { value: quantity, min: 1, max: picked.count, unit: word },
    },
    sizes,
    summary: [{ text: change, strong: true }, { text: ' · ' + quantity + word + ' · ' + EXCHANGE_WORDS.keep }],
    lineId: picked.l.id,
    from: picked.from,
    planned: picked.planned,
    ...(to ? { to } : {}),
    primary: { label, alts: [label, EXCHANGE_WORDS.action], enabled: to !== undefined },
    ...(to ? {
      command: { type: 'exchange.swap' as const, payload: { orderId: o.id, lineId: picked.l.id, quantity, from: picked.from, to, planned: picked.planned } },
    } : {}),
  };
}

// ── 접수증 출처 줄 ────────────────────────────────────────────────────

/**
 * 교환 한 건의 출처 줄 조각(`즉시 교환 · 헬멧 중 사이즈 → 대 사이즈 · 1개 · 16:20`): 좁으면 시각 → 수 → 옛 사이즈(`헬멧 → 대 사이즈`) 차례로 줄인다
 * (좁은 포스 875×600의 접수증 품목 표).
 */
export function swapParts(reg: ShopRegistry, l: FxLine, s: FxSwap): FitPart[] {
  const found = lineKind(reg, l);
  const kind = found?.kind;
  const product = found?.product.label ?? l.shortLabel;
  return [
    { text: EXCHANGE_WORDS.action, drop: 0 },
    { text: product + ' ' + sizeName(kind, s.from) + ' → ' + sizeName(kind, s.to), short: product + ' → ' + sizeName(kind, s.to), drop: 1 },
    { text: s.quantity + countWord(l), drop: 2 },
    { text: hm(s.at), drop: 3 },
  ];
}

/** 접수의 교환 출처 줄(일어난 차례: order-edit.ts editAdjustments가 취소 · 추가와 시각 순으로 섞는다). */
export function swapAdjustments(reg: ShopRegistry, o: FxOrder): { at: number; rows: SlipAdjustment[] }[] {
  return o.lines.flatMap((l) => (l.swaps ?? []).map((s) => ({ at: s.at, rows: [{ key: 'swap:' + s.id, parts: swapParts(reg, l, s), tone: 'muted' as const }] })));
}

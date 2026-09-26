// V1 반납 확인 창 · 부분 반납(spec 3-1, ui 6-2, data-model 4-18)의 읽기 모델(returnSheet).
// 창은 처음에 이 팀이 가진 것을 모두 골라 두고(번호로 세는 품목은 번호, 수량 품목은 수량 — 첫 매장은 모두 수량), 사람이 고른 것(번호 · 수량 ·
// 반환 방법)을 인자로 다시 물으면 미반납 줄 · 보증금 줄 · 반환 방법 · 주 버튼 · 명령을 여기서 새로 쓴다(화면은 계산하지 않는다).
//   - 매장 반납은 원래 일정부터 채운다(promises.ts lineBuckets): 미반납 줄은 그 결과로 남는 일정(`수거 예정`)과 받을 것이 없어지는
//     차량 수거(`수거 취소`)를 적는다. 약속은 고치지 않는다(채운 일정의 수거 업무는 '매장 반납'으로 남음, plan §8 D20).
//   - 보증금은 고른 권 중 보관 중인 매수만큼(`권 2매 보증금 10,000원 반환`), 반환 방법은 받은 수단(`현금`) 또는 `미수 차감`.
//   - 명령은 반납(stock.direct_return, 번호로 세는 줄은 돌아온 번호) 하나와 이어지는 보증금 반환(deposit.return, dependsOn) 하나.
// 칸 모양은 재고 방식으로 고른다(ui 3-1): unit = 이 팀이 가진 번호 버튼, count = −/+ 수량, none = 칸 없음(명령에는 그 줄 전부).
import {
  ACTION_LABELS, DomainError, type ChoiceOption, type ConfirmStep, type ReturnPieceLine, type ReturnSheetParams, type ReturnSheetView,
  type RichText, type TextRun,
} from '@skinote/contract';
import { heldNumbers, numbered } from './assets.ts';
import { lineNames } from './catalog.ts';
import { backHeldUnits, baseRefundKey, canOffset, heldAmount, heldUnits, takenMethod, unsettledBack, type RefundMethodKey } from './deposits.ts';
import type { FxDeposit, FxLine, FxOrder, FxPromise, ShopRegistry, ShopState } from './model.ts';
import { countWordOf, countWords, piecesText, pieceWord, placeText, whenText } from './promise-sheet.ts';
import { attributeReturn, bucketOut, lineBuckets, returnPromises, samePromise } from './promises.ts';
import { backCount, findOrder, lateAtOf, othersDue, placeShortLabel, selfDue } from './rules.ts';
import { businessDateOf, shopCutoff } from './time.ts';
import type { ViewContext } from './views.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';

/** 번호가 이만큼부터는 반 칸에 들어가지 않아 그 줄이 한 줄 전체를 쓴다(spec 3-1: 4개 이상). */
const WIDE_FROM = 4;
/** 번호가 이보다 많으면 한 줄에도 들어가지 않아 번호 버튼 대신 작은 창(`대여 12개 · 번호 선택 ›`)을 연다(875 폭 창 기준 8개). */
const PICKER_OVER = 8;

/** ① 회색 표시: 번호 칸이 있으면 번호를 빼고(문구 표 3-4), 수량 칸만 있으면(번호 없는 매장, 첫 매장) 수를 줄인다(문구 표 3-18, 확인 대기). */
const LEAD = '전체 선택 · 미반납 번호 해제';
const LEAD_COUNT = '전체 선택 · 미반납 수량 감소';

type Mode = 'unit' | 'count' | 'none';

/** 이 팀이 아직 가진 수(돌려받는 줄만). */
const heldOf = (l: FxLine) => (l.returnable ? Math.max(0, l.issued - backCount(l)) : 0);

/** 칸 모양(재고 방식). 번호로 세는 줄인데 번호가 모자라면(옛 자료) 수량 칸. */
function modeOf(l: FxLine): Mode {
  if ((l.tracking ?? 'unit') === 'none') return 'none';
  return numbered(l) && heldNumbers(l).length === heldOf(l) ? 'unit' : 'count';
}

const noOf = (state: ShopState, id: string) => state.assets.find((a) => a.id === id)?.no ?? id.slice(id.lastIndexOf('-') + 1);

/** 줄 하나에서 지금 고른 것(번호 · 수). 인자에 고른 것이 없으면 처음 연 상태(가진 것 모두). 세지 않는 줄은 늘 전부. */
interface Pick {
  l: FxLine;
  mode: Mode;
  held: number;
  ids: string[];
  n: number;
}

function pickOf(l: FxLine, params: ReturnSheetParams): Pick {
  const mode = modeOf(l);
  const held = heldOf(l);
  if (mode === 'none' || !params.picked) {
    const ids = mode === 'unit' ? heldNumbers(l) : [];
    return { l, mode, held, ids, n: held };
  }
  const entry = params.picked.find((p) => p.lineId === l.id);
  if (mode === 'unit') {
    const numbers = heldNumbers(l);
    // 번호 없이 수만 오면 가진 번호의 앞에서부터.
    const ids = entry?.assetIds ? numbers.filter((id) => entry.assetIds!.includes(id)) : numbers.slice(0, Math.max(0, Math.floor(entry?.quantity ?? 0)));
    return { l, mode, held, ids, n: ids.length };
  }
  return { l, mode, held, ids: [], n: Math.min(held, Math.max(0, Math.floor(entry?.quantity ?? 0))) };
}

/** 장소 이름을 읽는 매장 목록(이 파일의 Pick은 고른 줄이라 구역만 따로 이름 붙인다). */
type Areas = { readonly areas: ShopRegistry['areas'] };

/** 일정의 짧은 이름: 차량은 장소 짧은 이름('설천' · '두솔동'), 매장은 '매장'. */
const shortName = (reg: Areas, p: FxPromise) => (p.mode === 'vehicle' ? placeShortLabel(reg, p.placeId) : '매장');

/**
 * 칸 둘째 줄(모든 매장 같음, 2026-09-26): 이 줄이 반납 일정 둘 이상으로 나뉘어 나가 있으면 일정별 수(`설천 2 · 두솔동 1`: −/+로 줄이거나
 * 번호를 뺀 것이 어느 일정의 몫으로 남는지). 일정이 하나면 번호 칸은 그 일정과 수(`설천 2대`, 시안 V1: 번호 버튼만으로는 수가 한눈에 안
 * 보임), 수량 칸은 차량 수거 일정의 장소만(`설천`) · 매장 일정은 없음(−/+ 칸의 수가 곧 그 수라 `매장 4대` 옆 `4대`처럼 같은 수를 두 번
 * 쓰지 않고, `매장`이 매장 재고로 읽히지 않게). `N개 중`은 쓰지 않는다(헬멧 규격 `중`과 헷갈림). 짧은 이름이 겹치면 온전한 장소 이름.
 */
function lineNote(reg: Areas, o: FxOrder, l: FxLine, mode: 'unit' | 'count' | 'none'): string {
  const open = lineBuckets(o, l).filter((b) => b.planned > 0 && bucketOut(b) > 0);
  if (open.length <= 1) {
    const promise = open[0]?.promise ?? o.giveBack;
    if (mode === 'unit') return shortName(reg, promise) + ' ' + heldOf(l) + countWordOf(l);
    return promise.mode === 'vehicle' ? shortName(reg, promise) : '';
  }
  const short = open.map((b) => shortName(reg, b.promise));
  const names = new Set(short).size === short.length ? short : open.map((b) => placeText(reg, b.promise));
  return open.map((b, i) => names[i] + ' ' + bucketOut(b)).join(' · ');
}

// ── 미반납 줄(③) ────────────────────────────────────────────────────

/** 고른 것을 매장에서 받았다고 치고 본 접수(읽기 전용 사본: 명령과 같이 일정 몫을 적고 반납 수를 더함). */
function afterReturn(o: FxOrder, picks: readonly Pick[]): FxOrder {
  const copy: FxOrder = { ...o, lines: o.lines.map((l) => ({ ...l })), ...(o.splits ? { splits: o.splits.map((s) => ({ ...s })) } : {}) };
  for (const p of picks) {
    const l = copy.lines.find((x) => x.id === p.l.id);
    if (!l || p.n <= 0) continue;
    attributeReturn(copy, l, p.n);
    l.returned += p.n;
  }
  return copy;
}

/** 반납 일정마다 손님에게 나가 있는 줄 · 수(일정이 같은 몫은 하나로). */
function outByPromise(o: FxOrder): { promise: FxPromise; lines: { l: FxLine; n: number }[] }[] {
  return returnPromises(o).map((g) => ({ promise: g.promise, lines: g.lines.map((x) => ({ l: x.l, n: bucketOut(x.bucket) })).filter((x) => x.n > 0) }));
}

/** 남는 일정 한 조각: 아직 오지 않은 일정은 `예정`, 지난 일정은 `일정 22:00`(문구 표 원칙 3). */
function promiseLeft(state: ShopState, p: FxPromise, now: number): string {
  const when = whenText(state, p.at);
  if (p.mode === 'vehicle') return p.at > now ? when + ' ' + placeText(state.registry, p) + ' 수거 예정' : placeText(state.registry, p) + ' 수거 · 일정 ' + when;
  return p.at > now ? when + ' 매장 반납 예정' : '매장 반납 · 일정 ' + when;
}

/**
 * `미반납: 보드 1 · 헬멧 1 · 권 1매 → 22:00 솔마을 두솔동 수거 예정 · 설천 주차장 수거 취소`(모두면 `미반납 없음 · … 수거 취소`).
 * 접수 전체를 본다(줄 하나로 연 창도 다른 줄이 아직 나가 있으면 미반납이다). 조각은 좁을 때 뒤에서부터 빠진다(RichLine).
 */
function remainderOf(state: ShopState, o: FxOrder, picks: readonly Pick[], now: number): RichText {
  const before = outByPromise(o);
  const after = outByPromise(afterReturn(o, picks));
  const left = o.lines.map((l) => ({ l, n: after.reduce((sum, g) => sum + (g.lines.find((x) => x.l.id === l.id)?.n ?? 0), 0) })).filter((x) => x.n > 0);
  const remaining = after.filter((g) => g.lines.length > 0).sort((a, b) => a.promise.at - b.promise.at);
  const cancelled = before.filter((g) => g.lines.length > 0 && g.promise.mode === 'vehicle' && !remaining.some((a) => samePromise(a.promise, g.promise)));
  const cancelRun: TextRun[] = cancelled.length ? [{ text: ' · ' + cancelled.map((g) => placeText(state.registry, g.promise)).join(' · ') + ' 수거 취소' }] : [];
  if (left.length === 0) return [{ text: '미반납 없음', strong: true }, ...cancelRun];
  const tail = remaining.map((g, i) => ({ text: (i === 0 ? ' → ' : ' · ') + promiseLeft(state, g.promise, now) }));
  return [{ text: '미반납:', strong: true }, { text: ' ' + piecesText(left).join(' · ') }, ...tail, ...cancelRun];
}

// ── 보증금(④ ⑤) ──────────────────────────────────────────────────

interface Refund {
  dep: FxDeposit;
  lines: { lineId: string; quantity: number; assetIds?: string[] }[];
  units: number;
  amount: number;
  /** 단위('매')와 짧은 품목 말('권'). */
  unit: string;
  word: string;
}

/**
 * 돌려줄 보증금: 고른 권 중 보관 중인 매수 + 이미 돌아왔는데 아직 돌려주지 않은 매수(이어 보낸 반환이 막혔던 권, backHeldUnits). 창의 범위
 * (all: 줄 하나로 연 창이면 그 줄)에 보관 매수가 없으면 null(④ ⑤가 없는 창).
 */
function refundOf(state: ShopState, o: FxOrder, all: readonly FxLine[], picks: readonly Pick[]): Refund | null {
  const dep = state.deposits.find((d) => d.orderId === o.id && heldAmount(d) > 0 && all.some((l) => heldUnits(d, l.id) > 0));
  if (!dep) return null;
  const lines = all.flatMap((l) => {
    const back = backHeldUnits(dep, l);
    const p = picks.find((x) => x.l.id === l.id);
    const picked = p ? Math.min(p.n, heldUnits(dep, l.id) - back) : 0;
    const units = back + picked;
    if (units <= 0) return [];
    const ids = [...unsettledBack(dep, l).slice(0, back), ...(p?.ids ?? []).slice(0, picked)];
    return [{ lineId: l.id, quantity: units, ...(ids.length ? { assetIds: ids } : {}) }];
  });
  const units = lines.reduce((sum, x) => sum + x.quantity, 0);
  const first = all.find((l) => heldUnits(dep, l.id) > 0)!;
  return { dep, lines, units, amount: units * dep.unitAmount, unit: first.unit ?? countWordOf(first), word: pieceWord(first) };
}

/** `권 2매 보증금 10,000원 반환 · 매장 기준 1매 5,000원 · 잔여 보증금 5,000원(권 1매)`(돌려줄 것이 없으면 `보증금 반환 없음 · …`). */
function depositLine(o: FxOrder, r: Refund): RichText {
  const leftAmount = heldAmount(r.dep) - r.amount;
  const leftUnits = o.lines.reduce((sum, l) => sum + heldUnits(r.dep, l.id), 0) - r.units;
  const rest: TextRun[] = [
    { text: ' · 매장 기준 1' + r.unit + ' ' + won(r.dep.unitAmount) },
    { text: ' · 잔여 보증금 ' + (leftAmount > 0 ? won(leftAmount) + '(' + r.word + ' ' + leftUnits + r.unit + ')' : '없음') },
  ];
  if (r.amount === 0) return [{ text: '보증금 반환 없음', strong: true }, ...rest];
  return [{ text: r.word + ' ' + r.units + r.unit + ' 보증금 ' }, { text: won(r.amount) + ' 반환', strong: true }, ...rest];
}

/**
 * 반환 방법 버튼: 받은 수단(`현금`, 카드면 `카드 취소 · 10,000원`, 계좌이체면 `계좌 반환`)과, 이 팀 미수가 반환 금액 이상이면
 * `미수 차감 · 120,000원 → 110,000원`. 처음 고른 것은 규칙의 기본(refund_default_key), 사람이 고른 것이 있으면 그것.
 * 돌려줄 것이 없으면(권을 하나도 고르지 않음) 버튼은 누를 수 없다(자리는 그대로).
 */
function refundMethods(state: ShopState, o: FxOrder, r: Refund, wanted: string | undefined): { options: ChoiceOption[]; selected: RefundMethodKey | null } {
  const base = baseRefundKey(r.dep);
  const taken = takenMethod(r.dep);
  const baseLabel = base === 'cash' ? '현금' : taken === 'card' ? '카드 취소 · ' + won(r.amount) : '계좌 반환';
  const due = selfDue(o);
  const offset = canOffset(o, r.amount);
  const keys: RefundMethodKey[] = r.amount > 0 ? [base, ...(offset ? ['offset_due' as const] : [])] : [];
  const rule = state.settings.liftDeposit;
  const fallback: RefundMethodKey = rule?.key === r.dep.ruleKey && rule.refundDefault === 'offset_due' && offset ? 'offset_due' : base;
  const selected = keys.includes(wanted as RefundMethodKey) ? (wanted as RefundMethodKey) : keys.length ? fallback : null;
  const options: ChoiceOption[] = [
    { key: base, label: baseLabel, selected: selected === base, enabled: r.amount > 0 },
    ...(offset ? [{ key: 'offset_due', label: '미수 차감 · ' + won(due) + ' → ' + won(due - r.amount), selected: selected === 'offset_due', enabled: true }] : []),
  ];
  return { options, selected };
}

// ── 주 버튼 ────────────────────────────────────────────────────────

/**
 * `반납 처리 · 스키 2 · 헬멧 2 · 권 2매 · 보증금 10,000원`(일부), 모두 고르면 지급 창과 같은 셈 `반납 처리 · 6개 · 3매 · 보증금 15,000원`.
 * 좁으면 품목을 `외 N종`으로 줄이고(말줄임표 없음), 그다음 수 셈. 하나도 고르지 않으면 `반납 처리`(누를 수 없음).
 */
function primaryOf(picks: readonly Pick[], refund: number): ReturnSheetView['primary'] {
  const name = ACTION_LABELS['stamp.return'];
  const chosen = picks.filter((p) => p.n > 0);
  if (chosen.length === 0) return { label: name, alts: [name], enabled: false };
  const money = refund > 0 ? ' · 보증금 ' + won(refund) : '';
  const counts = countWords(chosen.map((p) => ({ l: p.l, n: p.n })));
  // 보증금이 없으면(첫 매장) 돈 없는 글과 같은 줄이 겹치므로 한 번만.
  const unique = (list: string[]) => [...new Set(list)];
  if (picks.every((p) => p.n === p.held)) {
    const label = name + ' · ' + counts + money;
    return { label, alts: unique([label, name + ' · ' + counts, name]), enabled: true };
  }
  const items = piecesText(chosen.map((p) => ({ l: p.l, n: p.n })));
  const label = name + ' · ' + items.join(' · ') + money;
  const shorter = items.slice(1).map((_, i) => items.slice(0, items.length - 1 - i).join(' · ') + ' 외 ' + (i + 1) + '종')
    .map((text) => name + ' · ' + text + money);
  return { label, alts: unique([label, ...shorter, name + ' · ' + counts + money, name + ' · ' + counts, name]), enabled: true };
}

// ── returnSheet ───────────────────────────────────────────────────

export function returnSheet(ctx: ViewContext, params: ReturnSheetParams): ReturnSheetView {
  const state = ctx.state;
  const o = findOrder(state, params.orderId);
  if (!o) throw new DomainError('NOT_FOUND', '없는 접수: ' + params.orderId);
  const title = ACTION_LABELS['stamp.return'] + ' · ' + o.teamName + ' 팀';
  // 창의 범위(줄 하나로 연 창이면 그 줄), 그중 아직 손님에게 있는 줄(번호 · 수량 칸).
  const range = o.lines.filter((l) => !params.lineIds?.length || params.lineIds.includes(l.id));
  const scope = range.filter((l) => heldOf(l) > 0);
  const picks = scope.map((l) => pickOf(l, params));

  // ① 한 줄: 보인 줄의 가장 이른 남은 일정이 늦었으면(매장 30분 · 차량 여유 뒤, 장부의 늦음과 같은 기준) 빨강 `반납 지연 · 일정 22:00`.
  const first = scope.flatMap((l) => lineBuckets(o, l).filter((b) => b.planned > 0 && bucketOut(b) > 0).map((b) => b.promise)).sort((a, b) => a.at - b.at)[0];
  const late = first !== undefined && ctx.now >= lateAtOf(state.settings, first);
  // 다음 영업일 뒤의 일정을 오늘 받으면 조기 반납이다: 첫 줄이 그 일정을 알린다(`조기 반납 · 일정 내일 12:00`, 모두 골라 둔 것은 그대로).
  const early = first !== undefined && businessDateOf(first.at, shopCutoff(state.settings)) > state.businessDate;
  const lead: RichText = late
    ? [{ text: '반납 지연 · 일정 ' + whenText(state, first.at), strong: true, tone: 'red' }]
    : early ? [{ text: '조기 반납', strong: true }, { text: ' · 일정 ' + whenText(state, first.at) }]
      : scope.length === 0 ? [{ text: '반납 완료', strong: true }] : [{ text: picks.some((p) => p.mode === 'unit') ? LEAD : LEAD_COUNT }];

  // ② 품목 칸(세지 않는 줄은 칸이 없다). 보증금을 맡은 줄은 표시(deposit): 칸이 여러 쪽이면 창이 첫 쪽에 둔다.
  const held = state.deposits.filter((d) => d.orderId === o.id && heldAmount(d) > 0);
  const lines: ReturnPieceLine[] = picks.filter((p) => p.mode !== 'none').map((p): ReturnPieceLine => {
    // 규격은 둘째 줄 앞에('헬멧' / '중 사이즈 · 매장 1개').
    const names = lineNames(state.registry, p.l);
    const base = {
      lineId: p.l.id, label: names.name, note: [names.variant, lineNote(state.registry, o, p.l, p.mode)].filter(Boolean).join(' · '), muted: p.n === 0,
      ...(names.variant ? { ariaLabel: p.l.label } : {}),
      ...(held.some((d) => heldUnits(d, p.l.id) > 0) ? { deposit: true } : {}),
    };
    if (p.mode === 'unit') {
      const pieces = heldNumbers(p.l).map((id) => ({ assetId: id, label: noOf(state, id) + '번', picked: p.ids.includes(id) }));
      const picker = p.held > PICKER_OVER ? { pickerLabel: '대여 ' + p.held + countWordOf(p.l) + ' · 번호 선택 ›' } : {};
      return { ...base, mode: 'unit', pieces, wide: p.held >= WIDE_FROM, ...picker };
    }
    return { ...base, mode: 'count', quantity: { value: p.n, min: 0, max: p.held, unit: countWordOf(p.l) }, wide: false };
  });

  const refund = refundOf(state, o, range, picks);
  const methods = refund ? refundMethods(state, o, refund, params.refundMethodKey) : null;
  const chosen = picks.filter((p) => p.n > 0);
  const view: ReturnSheetView = {
    basis: { epoch: state.epoch, rev: state.rev },
    title,
    lead,
    lines,
    remainder: remainderOf(state, o, picks, ctx.now),
    ...(refund ? { deposit: depositLine(o, refund) } : {}),
    ...(!refund && selfDue(o) + othersDue(state, o) > 0 ? { money: [{ text: '미수 ' + won(selfDue(o) + othersDue(state, o)), strong: true }] } : {}),
    ...(methods ? { refundMethods: methods.options } : {}),
    primary: primaryOf(picks, refund?.amount ?? 0),
  };
  if (chosen.length === 0) {
    // 돌려받을 것은 없고 돌아온 권의 보증금만 남았다(이어 보낸 반환이 막혔음): 보증금 반환 하나(창 안에서 다시, data-model 4-18).
    if (!refund || refund.amount <= 0 || !methods?.selected) return view;
    const label = '보증금 반환 · ' + won(refund.amount);
    return {
      ...view,
      primary: { label, alts: [label, '보증금 반환'], enabled: true },
      command: {
        type: 'deposit.return',
        payload: { orderId: o.id, ruleKey: refund.dep.ruleKey, lines: refund.lines, amount: refund.amount, refundMethodKey: methods.selected },
      },
      expect: { depositHeld: heldAmount(refund.dep), dueAmount: selfDue(o) },
    };
  }
  const then: ConfirmStep[] = refund && refund.amount > 0 && methods?.selected
    ? [{
      command: {
        type: 'deposit.return',
        payload: { orderId: o.id, ruleKey: refund.dep.ruleKey, lines: refund.lines, amount: refund.amount, refundMethodKey: methods.selected },
      },
      // 창이 본 보관 금액과 미수(미수 차감이면 서버가 맞춰 본다).
      expect: { depositHeld: heldAmount(refund.dep), dueAmount: selfDue(o) },
    }]
    : [];
  return {
    ...view,
    command: {
      type: 'stock.direct_return',
      payload: { orderId: o.id, lines: chosen.map((p) => ({ lineId: p.l.id, quantity: p.n, ...(p.mode === 'unit' ? { assetIds: p.ids } : {}) })) },
    },
    ...(then.length ? { then } : {}),
  };
}

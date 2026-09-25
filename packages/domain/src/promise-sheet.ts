// V9 일정 변경 · 부분 품목(spec 3-2, ui 6-2 N2)의 읽기 모델(promiseSheet)과 명령(promise.change).
// 일정은 줄의 수량에 붙고, 수량 일부를 떼어 새 일정을 만든다(promises.ts의 일정 몫). 어느 장비인지는 반납 · 수거 때
// 번호로 적으므로 이 창은 수량만 고른다. 화면은 고른 것(수량 · 반납 타임 · 날 · 장소 · 차량)만 인자로 다시 묻고, 줄 글 · 요약 ·
// 주 버튼 · 명령은 모두 여기서 쓴다(문구 표 docs/design/wording.md 3-5의 말).
//   - 옮길 수 있는 수 = 아직 돌아오지 않은 수(지급 전 포함). 옮기는 수는 원래 일정부터 떼고, 새 일정이 원래 일정이면 나눈 일정이 줄어든다.
//   - 오늘 이미 지났거나 10분 안인 반납 타임은 고를 수 없다(점선 · 회색, 까닭은 읽는 이름).
//   - 리프트권은 하루권이라 날을 옮길 수 없다(`리프트권 당일 한정 · 날짜 변경 불가`).
//   - 날을 옮기면 연장 값(catalog 14: 요금표 1일 값 × 수량 × 늘어난 날)을 요약 · 주 버튼에 적고, 명령이 청구 조정으로 남긴다. 줄마다 이미
//     적은 연장과의 차이만 적는다(되돌리면 음수 조정 = 연장 취소).
//   - `매장 직접`은 차량을 비운다(수거 차량 줄은 자리만 남는다).
import {
  ACTION_LABELS, DomainError, type ChoiceOption, type CommandEnvelope, type PlacePick, type PromiseInput, type PromiseSheetParams,
  type PromiseSheetView, type RichText, type SlotPick,
} from '@skinote/contract';
import { productOf } from './catalog.ts';
import type { DomainLines, FxCharge, FxLine, FxOrder, FxPromise, FxPromiseSplit, FxReturnSlot, ShopRegistry, ShopState } from './model.ts';
import { bucketLeft, currentReturn, lineBuckets, returnPromises, samePromise, type FxBucket } from './promises.ts';
import { conflict, done, nothing, rejected, unsupported, type Result } from './result.ts';
import { findOrder, placeLabel, placeShortLabel, slotAt, vehicleLabel } from './rules.ts';
import { businessDateOf, dayWord, hm, kstAt, kstDate, MINUTE, shopCutoff } from './time.ts';
import type { ViewContext } from './views.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';
const DAY = 24 * 60 * MINUTE;
/** 이보다 가까운 반납 타임은 고를 수 없다(V3와 같은 기준). */
const TOO_SOON = 10 * MINUTE;

export const PAST = '선택 불가 · 시간 지남';
export const SOON = '선택 불가 · 10분 이내';
const LIFT_SAME_DAY = '리프트권 당일 한정 · 날짜 변경 불가';

// ── 날 · 시각 · 장소 글 ──────────────────────────────────────────────

const cutoffOf = (state: ShopState) => shopCutoff(state.settings);
const bizDate = (state: ShopState, at: number) => businessDateOf(at, cutoffOf(state));

export function addDays(date: string, days: number): string {
  return kstDate(kstAt(date, days, 12, 0));
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / DAY);
}

/** 고른 날의 영업일. */
export function dateOf(state: ShopState, day: SlotPick['day']): string {
  if (day === 'today') return state.businessDate;
  if (day === 'tomorrow') return addDays(state.businessDate, 1);
  return day;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 반납 타임의 시각 글('12:00', 심야는 '24:00'). */
export const slotTime = (s: FxReturnSlot) => pad(s.hour) + ':' + pad(s.minute);

/** 영업일 안의 시각 글: 기준 시각(06:00) 전의 새벽은 그 영업일의 24시 뒤('24:00'). */
export function timeText(state: ShopState, at: number): string {
  const text = hm(at);
  if (kstDate(at) === bizDate(state, at)) return text;
  const [h = 0, m = 0] = text.split(':').map(Number);
  return pad(h + 24) + ':' + pad(m);
}

/** '22:00' · '내일 22:00'(오늘이 아니면 날 말). 반납 창(V1)도 쓴다. */
export function whenText(state: ShopState, at: number): string {
  const date = bizDate(state, at);
  const time = timeText(state, at);
  return date === state.businessDate ? time : dayWord(at, state.businessDate, cutoffOf(state)) + ' ' + time;
}

/** 일정의 장소 글: 차량은 장소('설천 주차장' · '솔마을 두솔동'), 매장은 '매장'. */
export const placeText = (reg: Pick<ShopRegistry, 'areas'>, p: FxPromise) => (p.mode === 'vehicle' ? placeLabel(reg, p.placeId) : '매장');
/** 일정 한 줄('22:00 설천 주차장'). */
const promiseText = (state: ShopState, p: FxPromise) => whenText(state, p.at) + ' ' + placeText(state.registry, p);

/** 요약 · 버튼의 품목 말: 권은 짧은 말 '권'(문구 표 1-4), 장비는 짧은 이름. */
export const pieceWord = (l: FxLine) => (l.section === 'lift' ? '권' : l.shortLabel);
export const pieceText = (l: FxLine, n: number) => pieceWord(l) + ' ' + n + (l.unit ?? '');
export const countWordOf = (l: FxLine) => l.countWord ?? l.unit ?? '개';

/**
 * 요약 · 버튼의 품목 조각('스키 4 · 의류 3 · 권 4매'): 품목 말 · 단위가 같은 줄(의류 사이즈 95 · 100)은 한 조각으로 더한다(장부 칸의
 * itemCounts와 같이 `의류 2 · 의류 1`이 되지 않게). 순서는 처음 나온 줄 차례.
 */
export function piecesText(picks: readonly { l: FxLine; n: number }[]): string[] {
  const out: { word: string; unit: string; n: number }[] = [];
  for (const { l, n } of picks) {
    if (n <= 0) continue;
    const word = pieceWord(l);
    const unit = l.unit ?? '';
    const same = out.find((x) => x.word === word && x.unit === unit);
    if (same) same.n += n;
    else out.push({ word, unit, n });
  }
  return out.map((x) => x.word + ' ' + x.n + x.unit);
}

/** '2개 · 1매'(개로 세는 장비 + 다른 단위). */
export function countWords(picks: readonly { l: FxLine; n: number }[]): string {
  const units = picks.filter((x) => !x.l.unit).reduce((sum, x) => sum + x.n, 0);
  const byUnit = new Map<string, number>();
  for (const { l, n } of picks) if (l.unit) byUnit.set(l.unit, (byUnit.get(l.unit) ?? 0) + n);
  return [...(units > 0 ? [units + '개'] : []), ...[...byUnit.entries()].map(([u, n]) => n + u)].join(' · ');
}

// ── 고른 것 → 일정 ──────────────────────────────────────────────────

/** 일정의 고른 모양(반납 타임 · 장소 · 차량). 반납 타임이 아닌 시각(21:50 조기 반납)이면 slotKey ''(시각 그대로). */
function pickOf(state: ShopState, p: FxPromise): { slot: SlotPick; place: PlacePick } {
  const date = bizDate(state, p.at);
  const day: SlotPick['day'] = date === state.businessDate ? 'today' : date === addDays(state.businessDate, 1) ? 'tomorrow' : date;
  const slot = state.settings.returnSlots.find((s) => slotAt(date, s) === p.at);
  return {
    slot: { day, slotKey: slot?.key ?? '' },
    place: p.mode === 'vehicle' ? { mode: 'vehicle', placeKey: p.placeId ?? '' } : { mode: 'store' },
  };
}

export const knownPlace = (reg: Pick<ShopRegistry, 'areas'>, key: string | undefined) => reg.areas.some((a) => a.places.some((p) => p.id === key));

/**
 * 일정 입력(PromiseInput)을 일정으로. 반납 타임이 없거나 ''이면 source의 시각을 그 날로 옮긴다. 매장 설정에 없는 반납 타임 · 장소 ·
 * 차량은 창이 만들 수 없는 입력이라 새 문구 없이 미지원 입력(lines.unsupported)으로 거절한다(문구 표에 없는 말을 만들지 않는다).
 */
function resolvePromise(state: ShopState, input: PromiseInput, source: FxPromise): FxPromise | { unsupported: true } {
  let at = source.at;
  if (input.slot) {
    const date = dateOf(state, input.slot.day);
    const slot = state.settings.returnSlots.find((s) => s.key === input.slot!.slotKey);
    if (slot) at = slotAt(date, slot);
    else if (input.slot.slotKey === '') at = source.at + dayDiff(date, bizDate(state, source.at)) * DAY;
    else return { unsupported: true };
  }
  if (input.mode === 'store') return { at, mode: 'store' };
  if (!knownPlace(state.registry, input.placeKey)) return { unsupported: true };
  const vehicles = state.registry.vehicles;
  const vehicleId = input.vehicleId ?? source.vehicleId ?? vehicles[0]?.id;
  if (!vehicles.some((v) => v.id === vehicleId)) return { unsupported: true };
  return { at, mode: 'vehicle', placeId: input.placeKey!, vehicleId: vehicleId! };
}

/** 고를 수 없는 시각의 까닭(지남 · 10분 안). */
export function timeReason(at: number, now: number): string | undefined {
  if (at <= now) return PAST;
  if (at < now + TOO_SOON) return SOON;
  return undefined;
}

// ── 옮기기 계획(창과 명령이 같은 셈) ───────────────────────────────────

interface Take { b: FxBucket; n: number }
interface LineMove { l: FxLine; want: number; takes: Take[]; moving: number }

/** 줄 하나에서 want만큼 target으로: 원래 일정부터(이미 target인 몫은 빼고). */
function planLine(o: FxOrder, l: FxLine, want: number, target: FxPromise): LineMove {
  const takes: Take[] = [];
  let rest = want;
  for (const b of lineBuckets(o, l)) {
    if (b.planned <= 0 || samePromise(b.promise, target)) continue;
    const n = Math.min(rest, bucketLeft(b));
    if (n <= 0) continue;
    takes.push({ b, n });
    rest -= n;
  }
  return { l, want, takes, moving: want - rest };
}

/** 연장에 쓰는 1일 값: 요금표 값(catalog 14: 할인은 고르지 않으면 연장에 적용하지 않는다). 목록에 없는 옛 줄은 줄 값 ÷ 수. */
const dayPrice = (reg: Pick<ShopRegistry, 'products'>, l: FxLine) => productOf(reg, l.productKey ?? l.kind)?.price ?? (l.qty > 0 ? l.amount / l.qty : 0);

/** 새 일정의 id(접수 안에서 차례: p1 · p2 …). 차량 업무 id의 셋째 마디가 된다. */
function newSplitId(splits: readonly FxPromiseSplit[]): string {
  const ids = new Set(splits.map((s) => s.id));
  let n = ids.size + 1;
  while (ids.has('p' + n)) n += 1;
  return 'p' + n;
}

/**
 * 옮긴 뒤의 나눈 일정(명령과 창의 미리 보기가 같은 셈): 원래 일정이 새 일정이면 나눈 일정만 줄고, 같은 나눈 일정이 있으면 거기에 더하고,
 * 아니면 새 일정. 수량이 0인 행은 뺀다. 원래 접수는 고치지 않는다(복사본).
 */
function nextSplits(o: FxOrder, moves: readonly LineMove[], target: FxPromise, now: number): FxPromiseSplit[] {
  const splits = (o.splits ?? []).map((row) => ({ ...row }));
  const toMain = samePromise(o.giveBack, target);
  const key = toMain ? null : splits.find((row) => row.quantity > 0 && samePromise(row.promise, target))?.id ?? newSplitId(splits);
  for (const m of moves) {
    for (const { b, n } of m.takes) {
      if (b.key === null) continue;
      const row = splits.find((x) => x.id === b.key && x.lineId === m.l.id);
      if (row) row.quantity -= n;
    }
    if (key === null) continue;
    let row = splits.find((x) => x.id === key && x.lineId === m.l.id);
    if (!row) {
      row = { id: key, lineId: m.l.id, quantity: 0, promise: { ...target }, at: now };
      splits.push(row);
    }
    row.quantity += m.moving;
  }
  return splits.filter((row) => row.quantity > 0);
}

/**
 * 연장 값(장비만, catalog 14): 원래 반납 일정(값을 받은 날)보다 늦은 나눈 일정마다 1일 값 × 수량 × 늦은 날. 줄마다 이미 적은 연장
 * (청구 조정의 합)과의 차이만 이번에 적는다: 날을 되돌리면 음수(연장 취소), 같은 날로 여러 번 옮겨도 한 번만 받는다.
 */
type ChargePart = FxCharge extends infer C ? (C extends FxCharge ? Omit<C, 'id' | 'at'> : never) : never;

function extensionOf(state: ShopState, o: FxOrder, moves: readonly LineMove[], target: FxPromise, now: number): { amount: number; parts: ChargePart[] } {
  const after = nextSplits(o, moves, target, now);
  const mainDate = bizDate(state, o.giveBack.at);
  const parts: ChargePart[] = [];
  for (const m of moves) {
    if (m.l.section === 'lift' || m.l.qty <= 0) continue;
    const unitDays = after.filter((row) => row.lineId === m.l.id)
      .reduce((sum, row) => sum + Math.max(0, dayDiff(bizDate(state, row.promise.at), mainDate)) * row.quantity, 0);
    const price = dayPrice(state.registry, m.l);
    const want = Math.round(price * unitDays);
    const mine = (o.charges ?? []).filter((c) => c.lineId === m.l.id);
    const had = mine.reduce((sum, c) => sum + c.amount, 0);
    // 이미 받은 연장 날: 늘어난 몫의 날 × 수에서 되돌린 몫(연장 취소 금액 ÷ 1일 값)을 뺀다.
    const hadDays = mine.reduce((sum, c) => sum + (c.kind === 'extension' ? c.days * c.quantity : price > 0 ? c.amount / price : 0), 0);
    if (want === had) continue;
    if (want > had) {
      const days = m.moving > 0 ? Math.max(0, Math.round((unitDays - hadDays) / m.moving)) : 0;
      parts.push({ kind: 'extension', lineId: m.l.id, quantity: m.moving, days, amount: want - had });
    } else {
      parts.push({ kind: 'extension_undo', lineId: m.l.id, amount: want - had });
    }
  }
  return { amount: parts.reduce((sum, x) => sum + x.amount, 0), parts };
}

/** 리프트권(하루권)을 다른 날로 옮기는지. */
const liftDayChange = (state: ShopState, moves: readonly LineMove[], target: FxPromise) =>
  moves.some((m) => m.l.section === 'lift' && m.takes.some(({ b }) => bizDate(state, b.promise.at) !== bizDate(state, target.at)));

const quoteHash = (amount: number) => 'extension:' + amount;

// ── promiseSheet(V9 창) ──────────────────────────────────────────────

/** 줄의 둘째 줄: 일정이 둘 이상이면 일정별 수('설천 2 · 두솔동 1'), 아니면 '대여 2대'. */
function lineNote(reg: Pick<ShopRegistry, 'areas'>, o: FxOrder, l: FxLine): string {
  const open = lineBuckets(o, l).filter((b) => b.planned > 0 && bucketLeft(b) > 0);
  if (open.length > 1) {
    return open.map((b) => (b.promise.mode === 'vehicle' ? placeShortLabel(reg, b.promise.placeId) : '매장') + ' ' + bucketLeft(b)).join(' · ');
  }
  return '대여 ' + l.qty + countWordOf(l);
}

const NONE: RichText = [{ text: '없음', tone: 'grey' }];

export function promiseSheet(ctx: ViewContext, params: PromiseSheetParams): PromiseSheetView {
  const state = ctx.state;
  const o = findOrder(state, params.orderId);
  if (!o) throw new DomainError('NOT_FOUND', '없는 접수: ' + params.orderId);
  const basis = { epoch: state.epoch, rev: state.rev };
  const title = ACTION_LABELS.change_promise + ' · ' + o.teamName + ' 팀';
  const base = currentReturn(o);
  const baseLines = o.lines.filter((l) => l.returnable).map((l) => ({ l, left: lineBuckets(o, l).reduce((n, b) => n + bucketLeft(b), 0) })).filter((x) => x.left > 0);

  // 고른 것(없으면 지금 일정).
  const start = pickOf(state, base);
  const slot = params.slot ?? start.slot;
  const place = params.place ?? start.place;
  const vehicleId = params.vehicleId ?? base.vehicleId ?? state.registry.vehicles[0]?.id ?? '';
  const input: PromiseInput = { mode: place.mode, slot, ...(place.mode === 'vehicle' ? { placeKey: place.placeKey, vehicleId } : {}) };
  const resolved = resolvePromise(state, input, base);
  const target = 'unsupported' in resolved ? null : resolved;

  // ② 반납 시각: 반납 타임(고른 날의 시각이 지났거나 10분 안이면 누를 수 없음) + 날.
  const date = dateOf(state, slot.day);
  const slots: ChoiceOption[] = state.settings.returnSlots.map((s) => {
    const reason = timeReason(slotAt(date, s), ctx.now);
    // 지금 일정의 타임이 이미 지났으면(지연 반납) 고른 것으로 보이지 않는다: 새 일정은 다른 타임을 골라야 한다.
    return { key: s.key, label: s.label + ' ' + slotTime(s), short: slotTime(s), selected: slot.slotKey === s.key && !reason, enabled: !reason, ...(reason ? { reason } : {}) };
  });
  const tomorrow = addDays(state.businessDate, 1);
  const otherDay = date !== state.businessDate && date !== tomorrow;
  const dayLabel = (d: string) => dayWord(kstAt(d, 0, 12, 0), state.businessDate, cutoffOf(state));
  const days: ChoiceOption[] = [
    { key: 'tomorrow', label: '내일', selected: date === tomorrow, enabled: true },
    { key: 'other', label: '다른 날', opens: true, selected: otherDay, enabled: true, ...(otherDay ? { secondLine: dayLabel(date) } : {}) },
  ];
  const calendar: ChoiceOption[] = [2, 3, 4, 5, 6, 7].map((n) => {
    const d = addDays(state.businessDate, n);
    return { key: d, label: dayLabel(d), selected: d === date, enabled: true };
  });

  // ③ ④ 장소 · 차량.
  const areas = state.registry.areas.map((a) => ({ key: a.id, label: a.label, lodging: a.lodging, places: a.places.map((p) => ({ key: p.id, label: p.label })) }));
  const vehicles: ChoiceOption[] = state.registry.vehicles.map((v) => ({ key: v.id, label: v.label, selected: place.mode === 'vehicle' && vehicleId === v.id, enabled: true }));

  // ① 변경 품목.
  const qty = (lineId: string, max: number) => Math.min(max, Math.max(0, Math.floor(params.quantities?.[lineId] ?? 0)));
  const lines = baseLines.map(({ l, left }) => ({
    lineId: l.id, label: l.label, note: lineNote(state.registry, o, l), quantity: { value: qty(l.id, left), min: 0, max: left, unit: countWordOf(l) },
  }));

  const common = { basis, title, lines, slots, days, calendar, areas, place, vehicles, vehicleRowVisible: place.mode === 'vehicle' };
  if (baseLines.length === 0) {
    // 옮길 것이 없다(모두 반납 · 수거): 창 대신 한 줄.
    return { ...common, summary: { changed: NONE, kept: NONE }, notice: '반납 완료', primary: { label: ACTION_LABELS.change_promise, alts: [], enabled: false } };
  }

  // ⑤ 요약과 주 버튼.
  const moves = target ? baseLines.map(({ l, left }) => planLine(o, l, qty(l.id, left), target)).filter((m) => m.moving > 0) : [];
  const moving = moves.map((m) => ({ l: m.l, n: m.moving }));
  const itemsText = piecesText(moving).join(' · ');
  const sources = returnPromises(o).filter((g) => moves.some((m) => m.takes.some(({ b }) => samePromise(b.promise, g.promise))));
  const keptGroups = (sources.length ? sources : returnPromises(o).filter((g) => samePromise(g.promise, base)))
    .map((g) => {
      const left = g.lines.map(({ l, left: n }) => {
        const taken = moves.find((m) => m.l === l)?.takes.filter(({ b }) => samePromise(b.promise, g.promise)).reduce((sum, t) => sum + t.n, 0) ?? 0;
        return { l, n: n - taken };
      }).filter((x) => x.n > 0);
      return { g, left };
    })
    .filter((x) => x.left.length > 0);
  const vehicleOf = (p: FxPromise) => (p.mode === 'vehicle' ? [{ text: ' · ' + vehicleLabel(state.registry, p.vehicleId) }] : []);
  const kept: RichText = keptGroups.length
    ? [
      { text: piecesText(keptGroups[0]!.left).join(' · ') + ': ' + promiseText(state, keptGroups[0]!.g.promise) },
      ...vehicleOf(keptGroups[0]!.g.promise),
      ...(keptGroups.length > 1 ? [{ text: ' · 외 ' + (keptGroups.length - 1) + '건' }] : []),
    ]
    : NONE;

  const extension = target ? extensionOf(state, o, moves, target, ctx.now) : { amount: 0, parts: [] };
  const notice = target && liftDayChange(state, moves, target) ? LIFT_SAME_DAY : undefined;
  const timeBad = target ? timeReason(target.at, ctx.now) : PAST;
  const changed: RichText = target && moves.length
    ? [
      { text: itemsText + ': ' + sources.map((g) => promiseText(state, g.promise)).join(' · ') + ' → ' },
      { text: whenText(state, target.at) + ' ' + (target.mode === 'vehicle' ? placeLabel(state.registry, target.placeId) : '매장 직접 반납'), strong: true },
      ...vehicleOf(target),
      ...(extension.amount > 0 ? [{ text: ' · 연장 + ' + won(extension.amount) }] : extension.amount < 0 ? [{ text: ' · 연장 −' + won(-extension.amount) }] : []),
    ]
    : NONE;

  const name = ACTION_LABELS.change_promise;
  const ready = target !== null && moves.length > 0 && !notice && !timeBad;
  const money = extension.amount > 0 ? ' · ' + won(extension.amount) : '';
  const label = ready ? name + ' · ' + itemsText + money : name;
  const primary = { label, alts: ready ? [label, name + ' · ' + countWords(moving) + money, name] : [name], enabled: ready };
  const view: PromiseSheetView = { ...common, summary: { changed, kept }, ...(notice ? { notice } : {}), primary };
  if (!ready) return view;
  return {
    ...view,
    command: { type: 'promise.change', payload: { orderId: o.id, kind: 'return', lines: moves.map((m) => ({ lineId: m.l.id, quantity: m.moving })), promise: input } },
    ...(extension.amount !== 0 ? { expect: { quoteHash: quoteHash(extension.amount) } } : {}),
  };
}

// ── promise.change(명령) ─────────────────────────────────────────────

/**
 * 일정 변경(수량 일부 → 새 반납 일정). 결정 명령이라 창을 연 뒤 그 품목이 돌아왔으면(차량 수거 · 매장 반납) 충돌로 돌려보낸다
 * (`1호 차량 스키 2 수거 완료 · 일정 확인`). 날을 옮긴 연장 값은 창이 본 견적(expect.quoteHash)과 같을 때만 청구 조정으로 적는다.
 */
export function changePromise(state: ShopState, envelope: CommandEnvelope<'promise.change'>, now: number, lines: DomainLines): Result {
  const p = envelope.payload;
  const o = findOrder(state, p.orderId);
  if (!o) return rejected('접수 없음');
  // 수령 일정 변경은 아직 없다(V9는 반납 일정).
  if (p.kind !== 'return') return unsupported(lines);
  const resolved = resolvePromise(state, p.promise, currentReturn(o));
  if ('unsupported' in resolved) return unsupported(lines);
  const target = resolved;
  const reason = timeReason(target.at, now);
  if (reason) return rejected(reason);
  const moves: LineMove[] = [];
  for (const entry of p.lines) {
    const l = o.lines.find((x) => x.id === entry.lineId);
    const want = Math.max(0, Math.floor(entry.quantity));
    if (!l || !l.returnable || want === 0) continue;
    const move = planLine(o, l, want, target);
    if (move.moving < want) {
      // 창을 연 뒤 돌아온 것이 있다: 차량이 받았으면 그 차량과 수, 아니면 반납 완료.
      const van = lineBuckets(o, l).find((b) => b.collected > 0 && b.promise.mode === 'vehicle');
      return conflict('PROMISE_CHANGED', van ? vehicleLabel(state.registry, van.promise.vehicleId) + ' ' + pieceText(l, van.collected) + ' 수거 완료 · 일정 확인' : '반납 완료');
    }
    moves.push(move);
  }
  if (moves.length === 0) return nothing('변경 없음');
  if (liftDayChange(state, moves, target)) return rejected(LIFT_SAME_DAY);
  const extension = extensionOf(state, o, moves, target, now);
  if (extension.amount !== 0 && envelope.expect?.quoteHash !== quoteHash(extension.amount)) {
    return conflict('QUOTE_CHANGED', '받을 금액 변경됨 · 재시도 필요');
  }

  // 새 일정(nextSplits): 원래 일정이면 나눈 일정만 줄고, 같은 나눈 일정이 있으면 거기에 더하고, 아니면 새 일정.
  o.splits = nextSplits(o, moves, target, now);
  if (extension.parts.length) {
    o.charges = [...(o.charges ?? []), ...extension.parts.map((c, i) => ({ ...c, id: envelope.requestId + ':' + i, at: now }))];
  }
  return done;
}

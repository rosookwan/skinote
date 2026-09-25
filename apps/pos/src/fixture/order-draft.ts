// V2 새 접수 ① 품목 · V3 ② 일정(spec 3-4 · 3-5, ui 6-6)의 읽기 모델(orderDraft). 체험 전용이고 LocalClient가 오면 폴더째 없어진다.
// 초안은 기기(화면의 new-order-draft.ts)에 있고 명령은 V4의 order.create 하나다(5단계). 화면은 누른 것(이름 · 연락처 숫자 · 인원 ·
// 품목 수 · 수령 · 반납 일정)만 초안에 넣어 다시 묻고, 타일 · 고르는 줄 · 선택 품목 · 합계 · 일정 버튼 · 접수 내용 · 바닥줄 글은 모두
// 여기서 쓴다(문구 표 docs/design/wording.md 3-6의 말).
//   - 종류 타일 · 규격 · 권종 · 값은 품목 목록(catalog.ts)에서. 보증금은 합계에 넣지 않고 `보증금 · 별도`로 따로 적는다.
//   - 반납 시각의 처음 값은 고른 권종의 사용 창 끝(야간권 → 야간 22:00), 권이 없으면 설정의 기본 반납 타임. 그 타임을 오늘 고를 수
//     없으면(지났거나 10분 안) 반납일의 처음 값이 내일. 사람이 반납일 · 반납 시각을 누른 뒤에는 따라가지 않는다(returnSet).
//   - 반납 장소의 처음 값은 수령한 곳(매장 직접 또는 배달 장소). 전화 예약은 수령일 · 시각 · 장소, 차량 배달은 시각 · 장소를 작은 창에서.
//   - 수령보다 이른 반납 타임 · 날은 누를 수 없다(점선 · 회색, 까닭 없음 — plan §8 D34).
// order.create(5단계)는 resolveSchedule · quoteOf로 같은 일정 · 견적을 쓴다.
import {
  ORDER_DRAFT_KEYS as K, type ChoiceOption, type DraftLineView, type DraftTotal, type KindTile, type OrderDraftInput, type OrderDraftParams,
  type OrderDraftView, type OrderPicker, type PickupWindow, type PlaceArea, type PlacePick,
} from '@skinote/contract';
import { KINDS, MAX_QTY, PRODUCTS, cleanItems, kindOf, quoteOf, variantOf, type FxKind, type Quote } from './catalog.ts';
import type { FxReturnSlot, FxState } from './model.ts';
import { addDays, dateOf, knownPlace, slotTime, timeReason, timeText } from './promise-sheet.ts';
import { placeLabel, slotAt } from './rules.ts';
import { AREAS, VEHICLES } from './seed.ts';
import { MINUTE, businessDateOf, dayWord, hm, iso, kstAt, shopCutoff } from './time.ts';
import type { ViewContext } from './views.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';

const CHANNEL_PHONE = '전화 예약';
/** 품목은 있는데 대표자 이름이 없을 때 `다음 · 일정` 위의 까닭(문구 표 3-6). */
const NAME_NEEDED = '대표자 이름 필요';
const STORE = '매장 직접';
/** 전화 예약의 수령 시각 버튼(체험 값)과 처음 값. */
const RESERVE_TIMES = ['08:00', '09:00', '13:00', '18:00'] as const;
const RESERVE_DEFAULT = { day: 'tomorrow' as const, time: '09:00' };
const HALF_HOUR = 30 * MINUTE;
/** 인원 칸의 한도(체험 값). */
const MAX_PARTY = 30;

// ── 대표자 ──────────────────────────────────────────────────────────

/** 연락처 숫자 → '010-0000-0042'(3 · 4 · 4, 10자리는 3 · 3 · 4). 숫자만 받는다. */
export function phoneText(digits: string): string {
  const d = digits.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 7) return d.slice(0, 3) + '-' + d.slice(3);
  if (d.length <= 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
  return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
}

// ── 일정(수령 · 반납) ──────────────────────────────────────────────

/** 'HH:MM' → 시 · 분(24시간). 틀리면 null. */
export function parseTime(text: string | undefined): { h: number; m: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(text ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, m: min } : null;
}

/** 대여 날 수(수령 영업일 → 반납 영업일, 같은 날 1). */
export function dayCount(from: string, to: string): number {
  return Math.max(1, Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000) + 1);
}

export interface ResolvedPickup {
  /** 매장 직접 · 즉시(now), 전화 예약(reserve), 현장 접수의 차량 배달(deliver). */
  kind: 'now' | 'reserve' | 'deliver';
  /** 수령 시각(ms). 즉시면 지금. */
  at: number;
  /** 수령 영업일. */
  date: string;
  mode: 'store' | 'vehicle';
  placeKey?: string;
  immediate: boolean;
  /** 고른 시각 글('09:00'). */
  time?: string;
  /** 접수할 만큼 정해졌는지(시각이 지나지 않음 · 차량 배달은 장소). */
  complete: boolean;
}

export interface ResolvedReturn {
  date: string;
  slot?: FxReturnSlot;
  at?: number;
  /** 고른(또는 처음 값) 반납 타임을 누를 수 있는지. */
  available: boolean;
  mode: 'store' | 'vehicle';
  placeKey?: string;
  vehicleId: string;
  complete: boolean;
}

function resolvePickup(state: FxState, now: number, draft: OrderDraftInput): ResolvedPickup {
  const p = draft.pickup;
  const placeKey = p.mode === 'vehicle' && knownPlace(p.placeKey) ? p.placeKey : undefined;
  const placed = p.mode === 'store' || placeKey !== undefined;
  if (draft.channel === 'phone') {
    const date = dateOf(state, p.day ?? RESERVE_DEFAULT.day);
    const time = p.time ?? RESERVE_DEFAULT.time;
    const t = parseTime(time);
    const at = t ? kstAt(date, 0, t.h, t.m) : now;
    return { kind: 'reserve', at: Math.max(at, now), date, mode: p.mode, ...(placeKey ? { placeKey } : {}), immediate: false, time, complete: t !== null && at > now && placed };
  }
  if (p.mode === 'vehicle') {
    const t = parseTime(p.time);
    const immediate = p.immediate === true || !p.time;
    const at = immediate ? now : t ? kstAt(state.businessDate, 0, t.h, t.m) : now;
    return {
      kind: 'deliver', at: Math.max(at, now), date: state.businessDate, mode: 'vehicle', ...(placeKey ? { placeKey } : {}), immediate,
      ...(immediate ? {} : { time: p.time }), complete: (immediate || (t !== null && at > now)) && placed,
    };
  }
  return { kind: 'now', at: now, date: businessDateOf(now, shopCutoff(state.settings)), mode: 'store', immediate: true, complete: true };
}

/** 반납 타임을 누를 수 있는지: 지났거나 10분 안이면 까닭과 함께 막고, 수령보다 이르면 까닭 없이 막는다. */
function slotBlock(at: number, now: number, pickupAt: number): { enabled: boolean; reason?: string } {
  const reason = timeReason(at, now);
  if (reason) return { enabled: false, reason };
  return { enabled: at > pickupAt };
}

/** 반납 시각의 처음 값: 고른 권종의 사용 창 끝(권종이 여럿이면 가장 늦은 것), 권이 없으면 설정의 기본 반납 타임. */
function defaultSlot(state: FxState, quote: Quote): FxReturnSlot | undefined {
  const slots = state.settings.returnSlots;
  const keys = new Set(quote.lines.flatMap((l) => (l.product.returnSlotKey ? [l.product.returnSlotKey] : [])));
  const fromTickets = slots.filter((s) => keys.has(s.key)).sort((a, b) => b.hour * 60 + b.minute - (a.hour * 60 + a.minute))[0];
  return fromTickets ?? slots.find((s) => s.key === state.settings.defaultReturnSlotKey) ?? slots[0];
}

/** 수령 · 반납 일정(화면의 읽기 모델과 order.create가 같은 셈을 쓴다). */
export function resolveSchedule(state: FxState, now: number, draft: OrderDraftInput): { pickup: ResolvedPickup; giveBack: ResolvedReturn; quote: Quote } {
  // 반납 타임의 처음 값은 권종에서(날과 상관없음), 값은 일정이 정해진 뒤 대여 날 수로 다시 센다.
  const oneDay = quoteOf(draft.items, state.settings);
  const pickup = resolvePickup(state, now, draft);
  const slots = state.settings.returnSlots;
  const open = (date: string, slot: FxReturnSlot) => slotBlock(slotAt(date, slot), now, pickup.at).enabled;
  let date: string;
  let slot: FxReturnSlot | undefined;
  const chosen = draft.returnSet?.time ? draft.giveBack.slot : undefined;
  if (chosen) {
    date = dateOf(state, chosen.day);
    slot = slots.find((s) => s.key === chosen.slotKey);
  } else {
    // 처음 값의 타임을 오늘 고를 수 없으면(지났거나 10분 안) 오늘의 다음 타임(16:20 → 야간 22:00), 오늘 남은 타임이 없을 때만 내일.
    // 하루 값으로 하룻밤을 빌려주는 일이 말없이 생기지 않게 한다.
    slot = defaultSlot(state, oneDay);
    date = pickup.date;
    if (slot && !open(date, slot)) {
      const base = slot;
      const later = slots.filter((s) => slotAt(date, s) > slotAt(date, base) && open(date, s)).sort((a, b) => slotAt(date, a) - slotAt(date, b))[0];
      if (later) slot = later;
      else date = addDays(date, 1);
    }
  }
  // 대여 날 수: 수령 영업일부터 반납 영업일까지(같은 날 1일, 다음 날 2일). 일정 변경(V9)의 연장 값과 같은 날 셈이다.
  const quote = quoteOf(draft.items, state.settings, dayCount(pickup.date, date));
  const available = slot !== undefined && open(date, slot);
  // 반납 장소: 고르기 전에는 수령한 곳(차량 배달 장소 · 매장).
  const gb = draft.giveBack;
  const followed: PlacePick = pickup.mode === 'vehicle' && pickup.placeKey ? { mode: 'vehicle', placeKey: pickup.placeKey } : { mode: 'store' };
  const place: PlacePick = draft.returnSet?.place ? (gb.mode === 'vehicle' ? { mode: 'vehicle', placeKey: gb.placeKey ?? '' } : { mode: 'store' }) : followed;
  const placeKey = place.mode === 'vehicle' && knownPlace(place.placeKey) ? place.placeKey : undefined;
  const vehicleId = gb.vehicleId && VEHICLES.some((v) => v.id === gb.vehicleId) ? gb.vehicleId : VEHICLES[0]?.id ?? '';
  const giveBack: ResolvedReturn = {
    date, ...(slot ? { slot, at: slotAt(date, slot) } : {}), available, mode: place.mode, ...(placeKey ? { placeKey } : {}), vehicleId,
    complete: available && (place.mode === 'store' || placeKey !== undefined),
  };
  return { pickup, giveBack, quote };
}

// ── 글 조각 ─────────────────────────────────────────────────────────

const dayOfDate = (state: FxState, date: string) => dayWord(kstAt(date, 0, 12, 0), state.businessDate, shopCutoff(state.settings));
/** '오늘 22:00' · '내일 09:00' · '오늘 24:00'(심야). */
const dayTime = (state: FxState, at: number) => dayWord(at, state.businessDate, shopCutoff(state.settings)) + ' ' + timeText(state, at);
const plural = (n: number, word: string) => n + word;

/** 다음 두 번의 30분(차량 배달 시각 버튼, 16:25 → 16:30 · 17:00). */
function nextHalfHours(now: number): number[] {
  const first = Math.floor(now / HALF_HOUR) * HALF_HOUR + HALF_HOUR;
  return [first, first + HALF_HOUR];
}

/** 직접 입력 버튼(입력한 시각이 버튼에 없으면 둘째 줄에 그 시각). */
const customOption = (time: string | undefined, listed: readonly string[]): ChoiceOption => {
  const custom = time !== undefined && !listed.includes(time) && parseTime(time) !== null;
  return { key: K.custom, label: '직접 입력', opens: true, selected: custom, enabled: true, ...(custom ? { secondLine: time } : {}) };
};

const pickOfPlace = (mode: 'store' | 'vehicle', placeKey: string | undefined): PlacePick =>
  mode === 'vehicle' && placeKey ? { mode: 'vehicle', placeKey } : { mode: 'store' };

// ── orderDraft(V2 · V3) ─────────────────────────────────────────────

function tileOf(kind: FxKind, quote: Quote, openKey: string | undefined): KindTile {
  const lines = quote.lines.filter((l) => l.product.kindKey === kind.key);
  const count = lines.reduce((n, l) => n + l.item.quantity, 0);
  let secondLine: string;
  let secondShort: string | undefined;
  if (kind.placement === 'grouped') {
    const chosen = kind.products.map((key) => PRODUCTS[key]!).filter((p) => lines.some((l) => l.product === p));
    const first = chosen[0];
    if (!first) secondLine = kind.axis + ' 선택';
    else if (chosen.length === 1) { secondLine = (first.shortLabel ?? first.label) + ' ' + won(first.price); secondShort = first.shortLabel ?? first.label; }
    else { secondLine = chosen.map((p) => p.shortLabel ?? p.label).join(' · '); secondShort = (first.shortLabel ?? first.label) + ' 외 ' + (chosen.length - 1) + '종'; }
  } else {
    const product = PRODUCTS[kind.products[0] ?? '']!;
    secondLine = '1일 ' + won(product.price);
    secondShort = won(product.price);
  }
  return { key: kind.key, label: kind.label, secondLine, ...(secondShort && secondShort !== secondLine ? { secondShort } : {}), ...(count > 0 ? { count } : {}), open: kind.key === openKey };
}

function pickerOf(kind: FxKind, quote: Quote, openVariant: string | undefined): OrderPicker {
  const qtyOf = (productKey: string, variantKey?: string) =>
    quote.lines.find((l) => l.item.productKey === productKey && l.item.variantKey === variantKey)?.item.quantity ?? 0;
  const total = quote.lines.filter((l) => l.product.kindKey === kind.key).reduce((n, l) => n + l.item.quantity, 0);
  if (kind.placement === 'grouped') {
    const products = kind.products.map((key) => PRODUCTS[key]!);
    const open = products.find((p) => p.key === openVariant) ?? products.find((p) => qtyOf(p.key) > 0);
    const word = open?.countWord ?? products[0]?.countWord ?? '매';
    const options: ChoiceOption[] = products.map((p) => {
      const n = qtyOf(p.key);
      const short = p.shortLabel ?? p.label;
      return { key: p.key, label: n > 0 ? short + ' · ' + plural(n, p.countWord) : short, short, selected: p === open, enabled: true };
    });
    const variants = { label: kind.label + ' ' + kind.axis, options };
    if (!open) return { kindKey: kind.key, variants, hint: kind.axis + ' 선택' };
    return {
      kindKey: kind.key, variants,
      quantity: {
        label: open.shortLabel ?? open.label, value: { value: qtyOf(open.key), min: 0, max: MAX_QTY, unit: open.countWord },
        ...(total > 0 ? { note: kind.label + ' 합계 ' + plural(total, word) } : {}), target: { productKey: open.key },
      },
    };
  }
  const product = PRODUCTS[kind.products[0] ?? '']!;
  if (!kind.variants) {
    return {
      kindKey: kind.key,
      quantity: { label: '수량', value: { value: qtyOf(product.key), min: 0, max: MAX_QTY, unit: product.countWord }, target: { productKey: product.key } },
    };
  }
  const open = variantOf(kind, openVariant) ?? kind.variants.find((v) => qtyOf(product.key, v.key) > 0);
  const options: ChoiceOption[] = kind.variants.map((v) => {
    const n = qtyOf(product.key, v.key);
    return { key: v.key, label: n > 0 ? v.label + ' · ' + plural(n, product.countWord) : v.label, short: v.label, selected: v === open, enabled: true };
  });
  const variants = { label: kind.label + ' ' + kind.axis, options, ...(kind.moreLabel ? { moreLabel: kind.moreLabel } : {}) };
  if (!open) return { kindKey: kind.key, variants, hint: kind.axis + ' 선택' };
  return {
    kindKey: kind.key, variants,
    quantity: {
      label: open.name, value: { value: qtyOf(product.key, open.key), min: 0, max: MAX_QTY, unit: product.countWord },
      ...(total > 0 ? { note: kind.label + ' 합계 ' + plural(total, product.countWord) } : {}), target: { productKey: product.key, variantKey: open.key },
    },
  };
}

/** 선택 품목 줄: 장비는 종류마다(`의류 3벌` / `95 2벌 · 100 1벌`), 리프트권은 권종마다(`야간권 성인 4매` / 보증금). */
function selectedRows(state: FxState, quote: Quote): DraftLineView[] {
  const rows: DraftLineView[] = [];
  // 보증금은 돌려받는 권에만(견적이 센 1매 금액이 있을 때).
  const depositUnit = quote.depositUnitAmount > 0 && state.settings.liftDeposit ? state.settings.liftDeposit : null;
  for (const kind of KINDS) {
    const lines = quote.lines.filter((l) => l.product.kindKey === kind.key);
    if (!lines.length) continue;
    if (kind.placement === 'grouped') {
      for (const l of lines) {
        const note = depositUnit && depositUnit.section === l.product.section ? '보증금 · 매장 기준 1매 ' + won(depositUnit.unitAmount) : '1매 ' + won(l.product.price);
        rows.push({ key: l.product.key, title: l.product.label + ' ' + plural(l.item.quantity, l.product.countWord), note, amount: l.amount, open: { kindKey: kind.key, variantKey: l.product.key } });
      }
      continue;
    }
    const product = lines[0]!.product;
    const total = lines.reduce((n, l) => n + l.item.quantity, 0);
    const amount = lines.reduce((n, l) => n + l.amount, 0);
    let note: string;
    if (!kind.variants) note = product.includes ?? '1일 ' + won(product.price);
    else if (lines.length === 1) note = variantOf(kind, lines[0]!.item.variantKey)?.name ?? '';
    else note = lines.map((l) => (variantOf(kind, l.item.variantKey)?.label ?? '') + ' ' + plural(l.item.quantity, product.countWord)).join(' · ');
    // 하루를 넘기는 대여면 날 수를 앞에(금액 = 1일 값 × 수 × 날).
    if (quote.days > 1) note = quote.days + '일 · ' + note;
    const firstVariant = lines[0]!.item.variantKey;
    rows.push({ key: kind.key, title: product.label + ' ' + plural(total, product.countWord), note, amount, open: { kindKey: kind.key, ...(firstVariant ? { variantKey: firstVariant } : {}) } });
  }
  return rows;
}

function totalsOf(quote: Quote): DraftTotal[] {
  if (!quote.lines.length) return [];
  return [
    ...(quote.gear > 0 ? [{ label: '장비', amount: quote.gear }] : []),
    ...(quote.lift > 0 ? [{ label: '리프트권', amount: quote.lift }] : []),
    { label: '합계', amount: quote.total, strong: true },
    ...(quote.deposit > 0 ? [{ label: '보증금 · 별도', amount: quote.deposit, muted: true }] : []),
  ];
}

export function orderDraft(ctx: ViewContext, params: OrderDraftParams): OrderDraftView {
  const state = ctx.state;
  const now = ctx.now;
  const draft = params.draft;
  const today = state.businessDate;
  const { pickup, giveBack, quote } = resolveSchedule(state, now, draft);
  const items = cleanItems(draft.items);
  const openKind = kindOf(params.openKindKey);

  // ① 품목
  const tiles = KINDS.map((k) => tileOf(k, quote, openKind?.key));
  const picker = openKind ? pickerOf(openKind, quote, params.openVariantKey) : undefined;
  const name = draft.leader.name.trim();
  const party = Math.min(MAX_PARTY, Math.max(0, Math.floor(draft.leader.party) || 0));

  // ② 일정: 수령 방법
  // 버튼 둘째 줄: 틀린 시각(직접 입력 '25:99')은 적지 않는다(다음 단계도 막힘).
  const pickupTime = parseTime(pickup.time) ? pickup.time : undefined;
  const reserveLine = pickup.kind === 'reserve'
    ? [dayOfDate(state, pickup.date), pickupTime, pickup.mode === 'vehicle' ? (pickup.placeKey ? placeLabel(pickup.placeKey) : '차량 배달') : STORE].filter(Boolean).join(' ')
    : undefined;
  const deliverLine = pickup.kind === 'deliver' ? [pickup.immediate ? '즉시' : pickupTime, pickup.placeKey ? placeLabel(pickup.placeKey) : ''].filter(Boolean).join(' ') : undefined;
  const pickupOptions: ChoiceOption[] = [
    { key: K.now, label: STORE + ' · 즉시', selected: pickup.kind === 'now', enabled: true },
    reserveLine !== undefined
      ? { key: K.reserve, label: '예약', secondLine: reserveLine, selected: true, enabled: true }
      : { key: K.reserve, label: '예약 · 수령일', opens: true, selected: false, enabled: true },
    deliverLine !== undefined
      ? { key: K.deliver, label: '차량 배달', ...(deliverLine ? { secondLine: deliverLine } : {}), selected: true, enabled: true }
      : { key: K.deliver, label: '차량 배달', opens: true, selected: false, enabled: true },
  ];

  // 반납일 · 반납 시각(수령일보다 이른 날, 수령보다 이른 타임은 누를 수 없다).
  const tomorrow = addDays(today, 1);
  const beforePickup = (date: string) => date < pickup.date;
  const otherDay = giveBack.date !== today && giveBack.date !== tomorrow;
  const returnDays: ChoiceOption[] = [
    { key: K.today, label: '오늘', selected: giveBack.date === today, enabled: !beforePickup(today) },
    { key: K.tomorrow, label: '내일', selected: giveBack.date === tomorrow, enabled: !beforePickup(tomorrow) },
    { key: K.other, label: '다른 날', opens: true, selected: otherDay, enabled: true, ...(otherDay ? { secondLine: dayOfDate(state, giveBack.date) } : {}) },
  ];
  const returnSlots: ChoiceOption[] = state.settings.returnSlots.map((s) => {
    const block = slotBlock(slotAt(giveBack.date, s), now, pickup.at);
    return {
      key: s.key, label: s.label + ' ' + slotTime(s), short: slotTime(s), selected: giveBack.slot?.key === s.key && block.enabled, enabled: block.enabled,
      ...(block.reason ? { reason: block.reason } : {}),
    };
  });
  const calendar: ChoiceOption[] = [2, 3, 4, 5, 6, 7].map((n) => {
    const d = addDays(today, n);
    return { key: d, label: dayOfDate(state, d), selected: d === giveBack.date, enabled: !beforePickup(d) };
  });
  const areas: PlaceArea[] = AREAS.map((a) => ({ key: a.id, label: a.label, lodging: a.lodging, places: a.places.map((p) => ({ key: p.id, label: p.label })) }));

  // 작은 창: 전화 예약(수령일 · 수령 시각 · 수령 장소), 차량 배달(배달 시각 · 배달 장소). 아직 그 수령 방법이 아니면 창은 처음 값(예약
  // 내일 09:00 매장 직접, 배달 즉시)을 골라 둔 모양으로만 보인다: 창을 열고 닫기만 하면 초안은 그대로다(화면은 누른 것만 초안에 넣는다).
  const reserveDate = pickup.kind === 'reserve' ? pickup.date : dateOf(state, RESERVE_DEFAULT.day);
  const reserveTime = pickup.kind === 'reserve' ? pickup.time : RESERVE_DEFAULT.time;
  const reserveOther = reserveDate !== today && reserveDate !== tomorrow;
  const reserve: PickupWindow = {
    days: [
      { key: K.today, label: '오늘', selected: reserveDate === today, enabled: true },
      { key: K.tomorrow, label: '내일', selected: reserveDate === tomorrow, enabled: true },
      { key: K.other, label: '다른 날', opens: true, selected: reserveOther, enabled: true, ...(reserveOther ? { secondLine: dayOfDate(state, reserveDate) } : {}) },
    ],
    times: [
      ...RESERVE_TIMES.map((time) => {
        const t = parseTime(time)!;
        const reason = timeReason(kstAt(reserveDate, 0, t.h, t.m), now);
        return { key: time, label: time, selected: reserveTime === time && !reason, enabled: !reason, ...(reason ? { reason } : {}) };
      }),
      customOption(reserveTime, RESERVE_TIMES),
    ],
    place: pickup.kind === 'reserve' ? pickOfPlace(pickup.mode, pickup.placeKey) : { mode: 'store' },
  };
  const halfHours = nextHalfHours(now).map(hm);
  const deliverTime = pickup.kind === 'deliver' && !pickup.immediate ? pickup.time : undefined;
  const deliver: PickupWindow = {
    times: [
      { key: K.now, label: '즉시', selected: pickup.kind !== 'deliver' || pickup.immediate, enabled: true },
      ...halfHours.map((time) => ({ key: time, label: time, selected: deliverTime === time, enabled: true })),
      customOption(deliverTime, halfHours),
    ],
    place: pickup.kind === 'deliver' ? pickOfPlace('vehicle', pickup.placeKey) : { mode: 'store' },
  };

  // 접수 내용(V3 오른쪽 판).
  const pickupTitle = pickup.immediate ? '수령 · 즉시 ' + hm(now) : '수령 · ' + dayTime(state, pickup.at);
  const pickupNote = pickup.mode === 'vehicle' ? [pickup.placeKey ? placeLabel(pickup.placeKey) : '', '차량 배달'].filter(Boolean).join(' · ') : STORE;
  const returnTitle = giveBack.available && giveBack.at !== undefined ? '반납 · ' + dayTime(state, giveBack.at) : '반납 · ' + dayOfDate(state, giveBack.date);
  const returnNote = giveBack.mode === 'vehicle' ? [giveBack.placeKey ? placeLabel(giveBack.placeKey) : '', '차량 수거'].filter(Boolean).join(' · ') : STORE + ' 반납';
  const gearItems = [
    ...KINDS.filter((k) => k.placement === 'tile').flatMap((k) => {
      const n = quote.lines.filter((l) => l.product.kindKey === k.key).reduce((sum, l) => sum + l.item.quantity, 0);
      return n > 0 ? [k.label + ' ' + n] : [];
    }),
    // 하루를 넘기면 날 수를 함께(장비 값 = 1일 값 × 수 × 날).
    ...(quote.days > 1 ? [quote.days + '일'] : []),
  ];
  const liftItems = quote.lines.filter((l) => l.product.section === 'lift').map((l) => (l.product.shortLabel ?? l.product.label) + ' ' + plural(l.item.quantity, l.product.countWord));
  const liftNote = [...liftItems, ...(quote.deposit > 0 ? ['보증금 ' + won(quote.deposit) + ' 별도'] : [])];
  const summary: DraftLineView[] = [
    { key: 'pickup', title: pickupTitle, note: pickupNote },
    { key: 'return', title: returnTitle, note: returnNote },
    ...(quote.gear > 0 ? [{ key: 'gear', title: '장비 ' + won(quote.gear), note: gearItems.join(' · '), items: gearItems }] : []),
    ...(quote.lift > 0 ? [{ key: 'lift', title: '리프트권 ' + won(quote.lift), note: liftNote.join(' · '), items: liftNote }] : []),
  ];

  const itemsReady = name !== '' && items.length > 0;
  // 품목을 골랐는데 이름이 없으면 까닭 한 줄(연락처 · 인원은 적지 않아도 된다).
  const nameMissing = name === '' && items.length > 0;
  const footer = ['새 접수', ...(name ? [name + ' 팀'] : []), ...(party > 0 ? [party + '명'] : [])].join(' · ');
  return {
    basis: { epoch: state.epoch, rev: state.rev },
    serverTime: iso(now),
    currentBusinessDate: today,
    ...(draft.channel === 'phone' ? { channelTag: CHANNEL_PHONE } : {}),
    leader: { phone: phoneText(draft.leader.phone), party: { value: party, min: 0, max: MAX_PARTY, unit: '명' } },
    tiles,
    tilePages: Math.max(1, Math.ceil(tiles.length / 9)),
    ...(picker ? { picker } : {}),
    selected: selectedRows(state, quote),
    totals: totalsOf(quote),
    schedule: {
      pickup: pickupOptions, returnDays, returnSlots, areas, returnPlace: pickOfPlace(giveBack.mode, giveBack.placeKey), calendar, reserve, deliver,
    },
    summary,
    ready: {
      items: itemsReady, schedule: itemsReady && pickup.complete && giveBack.complete,
      ...(nameMissing ? { itemsReason: NAME_NEEDED, missing: 'name' as const } : {}),
    },
    footer,
    quoteHash: quote.hash,
  };
}

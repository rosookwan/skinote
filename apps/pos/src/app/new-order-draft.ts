// 새 접수 초안(V2 ① 품목 · V3 ② 일정 · V4 ③ 결제가 같은 것을 고친다, spec 3-4 · 3-5). 초안은 이 기기에만 있고(sessionStorage: 새로
// 고침 · 다른 화면에 다녀와도 남음), 명령은 V4의 order.create 하나다. 접수를 확정하거나 `접수 취소`를 누르면(체험 자료 초기화도) 지운다.
// 여기 함수는 사람이 누른 것을 초안에 넣기만 한다(규칙 계산 없음): 줄 글 · 합계 · 반납 시각과 장소의 처음 값 · 누를 수 있는지는
// 서버가 orderDraft로 쓴다. 수량 −/+는 초안의 수에서 하나를 더하고 빼므로 답을 받기 전에 두 번 눌러도 잃지 않는다.
import type { DraftTarget, OrderDraftInput, OrderDraftParams, OrderDraftView, PlacePick, SlotPick } from '@skinote/contract';

export interface NewOrderState {
  draft: OrderDraftInput;
  /** 지금 연 종류 타일과 규격(화면 상태, 단계를 오가도 남는다). */
  openKindKey?: string;
  openVariantKey?: string;
}

export const EMPTY_NEW_ORDER: NewOrderState = {
  draft: {
    channel: 'walk_in',
    leader: { name: '', phone: '', party: 0 },
    items: [],
    pickup: { mode: 'store', immediate: true },
    giveBack: { mode: 'store' },
  },
};

/** 사람이 적거나 고른 것이 있는지(바닥줄 `접수 취소`를 보일지): 이름 · 연락처 · 인원 · 품목 · 수령 방법 · 반납을 누른 것. */
export function hasDraft(state: NewOrderState): boolean {
  const d = state.draft;
  return d.leader.name.trim() !== '' || d.leader.phone !== '' || d.leader.party > 0 || d.items.length > 0 || d.channel !== 'walk_in'
    || d.pickup.mode !== 'store' || d.returnSet !== undefined;
}

/** 서버에 물을 인자(초안 + 연 종류 · 규격). */
export function draftParams(state: NewOrderState): OrderDraftParams {
  return {
    draft: state.draft,
    ...(state.openKindKey ? { openKindKey: state.openKindKey } : {}),
    ...(state.openVariantKey ? { openVariantKey: state.openVariantKey } : {}),
  };
}

const withDraft = (state: NewOrderState, draft: Partial<OrderDraftInput>): NewOrderState => ({ ...state, draft: { ...state.draft, ...draft } });

// ── ① 품목 ─────────────────────────────────────────────────────────

export const withName = (state: NewOrderState, name: string) => withDraft(state, { leader: { ...state.draft.leader, name } });
export const withPhone = (state: NewOrderState, digits: string) => withDraft(state, { leader: { ...state.draft.leader, phone: digits.replace(/\D/g, '') } });
export const withParty = (state: NewOrderState, party: number) => withDraft(state, { leader: { ...state.draft.leader, party: Math.max(0, party) } });

/** 종류 타일 · 선택 품목 줄을 눌렀다: 그 종류(와 규격)를 고르는 줄에 연다. 규격을 주지 않으면 서버가 정한다. */
export function withOpenKind(state: NewOrderState, kindKey: string, variantKey?: string): NewOrderState {
  const { openVariantKey: _drop, ...rest } = state;
  return { ...rest, openKindKey: kindKey, ...(variantKey ? { openVariantKey: variantKey } : {}) };
}

export const withOpenVariant = (state: NewOrderState, variantKey: string): NewOrderState => ({ ...state, openVariantKey: variantKey });

const sameTarget = (a: DraftTarget, b: { productKey: string; variantKey?: string }) => a.productKey === b.productKey && (a.variantKey ?? '') === (b.variantKey ?? '');

/** 초안에 든 이 품목(상품 · 규격)의 수. */
export const qtyOf = (state: NewOrderState, target: DraftTarget) => state.draft.items.find((i) => sameTarget(target, i))?.quantity ?? 0;

/** 이 품목의 수를 바꾼다(0이면 뺀다). 한도는 부르는 쪽이 읽기 모델의 max로 막는다. */
export function withQuantity(state: NewOrderState, target: DraftTarget, quantity: number): NewOrderState {
  const n = Math.max(0, Math.floor(quantity));
  const items = state.draft.items;
  if (n === 0) return withDraft(state, { items: items.filter((i) => !sameTarget(target, i)) });
  if (items.some((i) => sameTarget(target, i))) return withDraft(state, { items: items.map((i) => (sameTarget(target, i) ? { ...i, quantity: n } : i)) });
  return withDraft(state, { items: [...items, { productKey: target.productKey, ...(target.variantKey ? { variantKey: target.variantKey } : {}), quantity: n }] });
}

// ── ② 일정: 수령 방법 ────────────────────────────────────────────────

/** `매장 직접 · 즉시`(현장 접수). */
export const withPickupNow = (state: NewOrderState) => withDraft(state, { channel: 'walk_in', pickup: { mode: 'store', immediate: true } });

/** 전화 예약(수령일 · 수령 시각 · 수령 장소). 처음 누르면 구분이 전화 예약이 되고, 주지 않은 것은 지금 예약 값(없으면 서버의 처음 값). */
export function withReserve(state: NewOrderState, patch: { day?: SlotPick['day']; time?: string; place?: PlacePick }): NewOrderState {
  const prev = state.draft.channel === 'phone' ? state.draft.pickup : undefined;
  const place = patch.place ?? (prev ? (prev.mode === 'vehicle' ? { mode: 'vehicle' as const, placeKey: prev.placeKey ?? '' } : { mode: 'store' as const }) : { mode: 'store' as const });
  const day = patch.day ?? prev?.day;
  const time = patch.time ?? prev?.time;
  return withDraft(state, {
    channel: 'phone',
    pickup: { mode: place.mode, ...(day ? { day } : {}), ...(time ? { time } : {}), ...(place.mode === 'vehicle' ? { placeKey: place.placeKey } : {}) },
  });
}

/** 현장 접수의 차량 배달(배달 시각 `즉시` · 시각, 배달 장소). */
export function withDeliver(state: NewOrderState, patch: { time?: 'now' | string; place?: PlacePick }): NewOrderState {
  const prev = state.draft.channel === 'walk_in' && state.draft.pickup.mode === 'vehicle' ? state.draft.pickup : undefined;
  const placeKey = patch.place ? (patch.place.mode === 'vehicle' ? patch.place.placeKey : undefined) : prev?.placeKey;
  const time = patch.time ?? (prev?.immediate || !prev?.time ? 'now' : prev.time);
  return withDraft(state, {
    channel: 'walk_in',
    pickup: { mode: 'vehicle', ...(time === 'now' ? { immediate: true } : { time }), ...(placeKey ? { placeKey } : {}) },
  });
}

// ── ② 일정: 반납일 · 반납 시각 · 반납 장소 ─────────────────────────────

/** 지금 보이는 반납일(`오늘` · `내일` · `다른 날`의 날짜). */
function shownDay(view: OrderDraftView): SlotPick['day'] {
  const day = view.schedule.returnDays.find((d) => d.selected)?.key;
  if (day === 'tomorrow') return 'tomorrow';
  if (day === 'other') return view.schedule.calendar.find((d) => d.selected)?.key ?? 'today';
  return 'today';
}

/** 지금 반납 타임(사람이 고른 것, 없으면 보이는 것). */
const shownSlot = (state: NewOrderState, view: OrderDraftView) =>
  (state.draft.returnSet?.time ? state.draft.giveBack.slot?.slotKey : undefined) || view.schedule.returnSlots.find((s) => s.selected)?.key || '';

const withReturnSlotPick = (state: NewOrderState, slot: SlotPick) =>
  withDraft(state, { giveBack: { ...state.draft.giveBack, slot }, returnSet: { ...state.draft.returnSet, time: true } });

/** 반납일(`오늘` · `내일` · 날짜). 반납 타임은 그대로. */
export const withReturnDay = (state: NewOrderState, view: OrderDraftView, day: SlotPick['day']) => withReturnSlotPick(state, { day, slotKey: shownSlot(state, view) });

/** 반납 시각(반납 타임). 날은 지금 보이는 반납일. */
export const withReturnSlot = (state: NewOrderState, view: OrderDraftView, slotKey: string) => withReturnSlotPick(state, { day: shownDay(view), slotKey });

/** 반납 장소(매장 직접 또는 구역의 장소). */
export function withReturnPlace(state: NewOrderState, place: PlacePick): NewOrderState {
  const { placeKey: _drop, ...giveBack } = state.draft.giveBack;
  return withDraft(state, {
    giveBack: { ...giveBack, mode: place.mode, ...(place.mode === 'vehicle' ? { placeKey: place.placeKey } : {}) },
    returnSet: { ...state.draft.returnSet, place: true },
  });
}

// ── 저장(이 기기의 sessionStorage) ─────────────────────────────────────

const STORE_KEY = 'sn-new-order';

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** 저장된 초안(없거나 모양이 틀리면 빈 초안). */
export function loadNewOrder(storage: Pick<Storage, 'getItem'> | null = session()): NewOrderState {
  try {
    const raw = storage?.getItem(STORE_KEY);
    if (!raw) return EMPTY_NEW_ORDER;
    const saved = JSON.parse(raw) as NewOrderState;
    const d = saved?.draft;
    if (!d || !Array.isArray(d.items) || !d.leader || typeof d.leader.name !== 'string' || !d.pickup || !d.giveBack) return EMPTY_NEW_ORDER;
    return saved;
  } catch {
    return EMPTY_NEW_ORDER;
  }
}

export function saveNewOrder(state: NewOrderState, storage: Pick<Storage, 'setItem'> | null = session()): void {
  try {
    storage?.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // 저장이 막힌 브라우저에서도 화면은 돈다(새로 고치면 빈 초안).
  }
}

export function clearNewOrder(storage: Pick<Storage, 'removeItem'> | null = session()): void {
  try {
    storage?.removeItem(STORE_KEY);
  } catch {
    // 위와 같음.
  }
}

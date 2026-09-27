// 매장 설정의 목록 바꿈(registry.update)과 직원 바꿈(staff.set), features-1 plan §4-1 · E12 · E13 · E13c · E25. 매장 정보 · 장소 · 반납 타임 ·
// 요금 · 할인 · 차량 · 직원 탭이 한 번의 저장으로 명령 하나(차량 · 직원 탭은 목록 바꿈 뒤에 직원 바꿈)를 보낸다. 바꿈(op)은 차례대로 적용하고,
// 하나라도 거절되면 명령 전체를 거절한다(아무것도 바뀌지 않음). 다음 기록부터다: 만든 줄 · 약속은 만들 때의 값(줄 값 · 장소 id)을 가지고,
// 숨긴 행 · 사용 종료한 차량은 목록에 남아 지난 접수 · 마감이 이름을 읽는다(숨김 = 고르기에서만 빠짐).
// 새 행의 id: 초안은 ref('n1')로 행을 더하고 그 행을 'new:<ref>'로 가리킨다. 명령은 `${요청번호}:<ref>`로 바꾸고(창은 id를 만들지 않는다),
// 미리 보기(settings-view.ts)는 'new:<ref>'를 그대로 id로 쓴다. 직원 바꿈의 'new:<ref>' 차량은 앞 명령(dependsOn[0])이 더한 차량이다.
import type { CommandEnvelope, RegistryOp, SettingsOp, StaffOp } from '@skinote/contract';
import type { FxDiscount, FxProduct } from './catalog.ts';
import type { DomainLines, FxArea, FxReturnSlot, FxShopRules, FxStaff, FxVehicle, ShopRegistry, ShopState } from './model.ts';
import { bucketLeft, bucketOnVan, lineBuckets, orderTasks } from './promises.ts';
import { done, nothing, rejected, unsupported, type Result } from './result.ts';
import { isVehiclePickup, pendingIssue, vanLoaded } from './rules.ts';
import { walletBalance } from './closing.ts';
import { minutesOf } from './time.ts';

// ── 거절 한 줄(문구 표 3-20, `사실 · 할 일`) ──────────────────────────────────

export const SETTINGS_LINES = {
  duplicate: '이름 중복 · 다른 이름 필요',
  duplicateHidden: '숨김 항목 중복 · 숨김 해제 필요',
  hideLastSlot: '숨김 불가 · 마지막 반납 타임',
  hideDefaultSlot: '숨김 불가 · 기본 반납 타임',
  hideTicketSlot: '숨김 불가 · 리프트권 반납 타임',
  // 미처리 업무는 가는 곳(수거 목록 · 기사의 배달 목록)과 맞게 나눠 센다(2026-09-27 점검: `수거 목록 ›`의 수와 달랐다).
  endCollects: '사용 종료 불가 · 미처리 수거 {n}건',
  endDeliveries: '사용 종료 불가 · 미처리 배달 {n}건',
  endBoth: '사용 종료 불가 · 미처리 수거 {c} · 배달 {d}',
  endStock: '사용 종료 불가 · 차량 재고 {n}개',
  endCash: '사용 종료 불가 · 차량 현금 {amount}',
  endTransfer: '사용 종료 불가 · 현금 인계 미확인',
  endLastManager: '사용 종료 불가 · 마지막 관리자',
  endSelf: '사용 종료 불가 · 본인',
  /** 역할 판의 막힌 까닭(2026-09-27 점검, 문구 표 3-20 확인 대기). */
  roleLastManager: '역할 변경 불가 · 마지막 관리자',
  /** 차량 판의 `없음`이 막힌 까닭: 기사는 차량이 있어야 한다. */
  driverNeedsVehicle: '차량 해제 불가 · 기사 역할',
  noVehicle: '차량 없음 · 관리자 확인 필요',
  noChange: '변경 없음',
} as const;

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));

/** 값의 범위(wire WIRE_LIMITS와 같은 끝, 도메인이 다시 본다). */
export const SETTINGS_RANGES = {
  label: 20,
  // 요금은 10원 단위(할인 몫을 10원씩 나누므로: 끝전이 줄 값을 넘지 않게, 2026-09-27 점검).
  price: { min: 10, max: 10_000_000, step: 10 },
  percent: { min: 1, max: 100 },
  amount: { min: 10, max: 1_000_000, step: 10 },
  notice: { min: 0, max: 180 },
  late: { min: 0, max: 240 },
} as const;

/** 야간 반납 타임이 되는 시각(20:00 이후, return_slots.is_night를 더할 때 정한다). */
export const NIGHT_FROM_MINUTES = 20 * 60;

// ── id ────────────────────────────────────────────────────────────

/** 새 행 id를 만들고 가리킴을 푸는 규칙(명령과 미리 보기가 다르다). */
export interface RowIds {
  /** ref로 더한 행의 id. */
  make: (ref: string) => string;
  /** 초안이 가리킨 id('new:<ref>' 또는 있는 id) → 상태의 id. */
  resolve: (id: string) => string;
  /** 직원 바꿈이 가리킨 차량 id(앞 명령에서 더한 차량). */
  vehicle: (id: string) => string;
}

const NEW = 'new:';

/** 명령의 id: `${요청번호}:<ref>`, 직원 바꿈의 새 차량은 앞 명령(dependsOn[0])의 것. */
export function commandIds(requestId: string, previous?: string): RowIds {
  const resolve = (id: string) => (id.startsWith(NEW) ? requestId + ':' + id.slice(NEW.length) : id);
  return {
    make: (ref) => requestId + ':' + ref,
    resolve,
    vehicle: (id) => (id.startsWith(NEW) ? (previous ? previous + ':' + id.slice(NEW.length) : '') : id),
  };
}

/** 미리 보기의 id: 새 행은 'new:<ref>' 그대로(초안이 다시 그 행을 가리킬 수 있게). */
export const PREVIEW_IDS: RowIds = { make: (ref) => NEW + ref, resolve: (id) => id, vehicle: (id) => id };

// ── 도움 ────────────────────────────────────────────────────────────

/** 이름 다듬기(앞뒤 빈칸, 가운데 빈칸 하나). 빈 이름 · 한도 넘음이면 undefined. */
export function cleanLabel(label: string | undefined): string | undefined {
  if (typeof label !== 'string') return undefined;
  const text = label.replace(/\s+/g, ' ').trim();
  return text.length >= 1 && [...text].length <= SETTINGS_RANGES.label && !/\p{Cc}|</u.test(text) ? text : undefined;
}

/** 같은 목록의 이름 겹침(숨긴 행 포함, 자기 행 뺌): 거절 한 줄 또는 undefined. */
function duplicateOf<T extends { label: string; hidden?: true; ended?: true }>(list: readonly T[], label: string, self?: T): string | undefined {
  const other = list.find((x) => x !== self && x.label === label);
  if (!other) return undefined;
  return other.hidden || other.ended ? SETTINGS_LINES.duplicateHidden : SETTINGS_LINES.duplicate;
}

/** 목록 안에서 옮기기(차례 toIndex, 넘으면 끝으로). */
function moveIn<T>(list: T[], item: T, toIndex: number): boolean {
  const from = list.indexOf(item);
  if (from < 0) return false;
  const to = Math.max(0, Math.min(list.length - 1, Math.floor(toIndex)));
  list.splice(from, 1);
  list.splice(to, 0, item);
  return true;
}

/**
 * 'HH:MM'(숫자판) → 반납 타임의 시 · 분. 영업일 기준 시각 전의 시각(00:30)은 그 영업일의 밤이라 24를 더한다(심야 24:00 = hour 24).
 * 모양이 틀리면 undefined.
 */
export function slotHourOf(time: string, cutoff: string): { hour: number; minute: number } | undefined {
  if (!/^\d{2}:\d{2}$/.test(time)) return undefined;
  const [h = 0, m = 0] = time.split(':').map(Number);
  if (h > 23 || m > 59) return undefined;
  return { hour: h * 60 + m < minutesOf(cutoff) ? h + 24 : h, minute: m };
}

const slotMinutes = (s: { hour: number; minute: number }) => s.hour * 60 + s.minute;

/** 사용 중인 권종(상품)이 그 반납 타임에 끝나는지(권의 사용 창 끝 = 반납 시각의 처음 값). */
const ticketSlot = (reg: ShopRegistry, slotKey: string) => Object.values(reg.products).some((p) => p.returnSlotKey === slotKey);

// ── 차량 사용 종료의 막힘(E13) ─────────────────────────────────────────────

/** 그 차량의 미처리 업무(날짜 상관없음): 아직 건네지 않은 배달, 아직 받을 것이 남은 수거. */
export function vehicleOpenTasks(state: ShopState, vehicleId: string): number {
  const { collects, deliveries } = vehicleOpenTaskCounts(state, vehicleId);
  return collects + deliveries;
}

/** 그 차량의 미처리 수거 · 배달 수(사용 종료의 막힘 한 줄이 나눠 말한다). */
export function vehicleOpenTaskCounts(state: ShopState, vehicleId: string): { collects: number; deliveries: number } {
  let collects = 0;
  let deliveries = 0;
  for (const o of state.orders) {
    if (isVehiclePickup(o) && o.pickup.vehicleId === vehicleId && pendingIssue(o)) deliveries += 1;
    for (const t of orderTasks(o)) {
      if (t.promise.vehicleId !== vehicleId) continue;
      const left = o.lines.some((l) => l.returnable && lineBuckets(o, l).some((b) => b.key === t.key && bucketLeft(b) > 0));
      if (left) collects += 1;
    }
  }
  return { collects, deliveries };
}

/** 그 차량에 실린 것: 수거하고 내려놓지 않은 수, 싣고 건네지 않은 수, 예비권(수량 · 번호). */
export function vehicleStock(state: ShopState, vehicleId: string): number {
  let n = 0;
  for (const o of state.orders) {
    for (const l of o.lines) {
      for (const b of lineBuckets(o, l)) if (b.promise.mode === 'vehicle' && b.promise.vehicleId === vehicleId) n += bucketOnVan(b);
      // 싣고 건네지 않은 수(취소한 배달의 차에 남은 것을 매장 입고로 내려놓으면 빠진다: vanLoaded는 내려놓은 수를 뺀다).
      if (isVehiclePickup(o) && o.pickup.vehicleId === vehicleId) n += vanLoaded(l);
    }
  }
  n += (state.vanSpares ?? []).filter((s) => s.vehicleId === vehicleId).reduce((sum, s) => sum + s.quantity, 0);
  n += state.assets.filter((a) => a.vehicleId === vehicleId).length;
  return n;
}

/** 차량 사용 종료를 막는 까닭(없으면 undefined): 미처리 업무 · 차량 재고 · 인계하지 않은 현금 · 확인하지 않은 인계. */
export function vehicleEndRefusal(state: ShopState, vehicleId: string): string | undefined {
  const { collects, deliveries } = vehicleOpenTaskCounts(state, vehicleId);
  if (collects > 0 && deliveries > 0) return fill(SETTINGS_LINES.endBoth, { c: collects, d: deliveries });
  if (collects > 0) return fill(SETTINGS_LINES.endCollects, { n: collects });
  if (deliveries > 0) return fill(SETTINGS_LINES.endDeliveries, { n: deliveries });
  const stock = vehicleStock(state, vehicleId);
  if (stock > 0) return fill(SETTINGS_LINES.endStock, { n: stock });
  // 차량 지갑은 날을 가리지 않고 센다: 점검 이월한 전날의 현금도 지갑에 남아 있다(2026-09-27 점검).
  const cash = walletBalance(state, vehicleId);
  if (cash > 0) return fill(SETTINGS_LINES.endCash, { amount: won(cash) });
  if (state.cashTransfers.some((t) => t.vehicleId === vehicleId && !t.confirmed)) return SETTINGS_LINES.endTransfer;
  return undefined;
}

// ── 반납 타임 숨김의 막힘(E12) ──────────────────────────────────────────────

export function slotHideRefusal(reg: ShopRegistry, settings: FxShopRules, slot: FxReturnSlot): string | undefined {
  const active = settings.returnSlots.filter((s) => !s.hidden);
  if (active.length <= 1 && active.includes(slot)) return SETTINGS_LINES.hideLastSlot;
  if ((settings.defaultReturnSlotKey ?? active[0]?.key) === slot.key) return SETTINGS_LINES.hideDefaultSlot;
  if (ticketSlot(reg, slot.key)) return SETTINGS_LINES.hideTicketSlot;
  return undefined;
}

// ── 목록 바꿈 ────────────────────────────────────────────────────────

type MutableRegistry = Omit<ShopRegistry, 'products' | 'areas' | 'vehicles' | 'discounts'> & {
  products: Record<string, FxProduct>;
  areas: FxArea[];
  vehicles: FxVehicle[];
  discounts: FxDiscount[];
};

/** 목록 바꿈을 적용할 판(복사본): 목록 값 · 운영 규칙 · 돈통 · 직원. */
export interface SettingsDraft {
  registry: MutableRegistry;
  settings: FxShopRules;
  drawers: ShopState['drawers'];
  staff: FxStaff[];
}

export const draftOf = (state: ShopState): SettingsDraft => ({
  registry: structuredClone(state.registry) as MutableRegistry,
  settings: structuredClone(state.settings),
  drawers: structuredClone(state.drawers),
  staff: structuredClone(state.staff ?? []),
});

/** 거절(한 줄 또는 모르는 입력). */
type Refusal = { message: string } | { unsupported: true };
const refuse = (message: string): Refusal => ({ message });
const BAD: Refusal = { unsupported: true };

const findArea = (d: SettingsDraft, id: string) => d.registry.areas.find((a) => a.id === id);
function findPlace(d: SettingsDraft, id: string): { area: FxArea; place: FxArea['places'][number] } | undefined {
  for (const area of d.registry.areas) {
    const place = area.places.find((p) => p.id === id);
    if (place) return { area, place };
  }
  return undefined;
}
const findSlot = (d: SettingsDraft, id: string) => d.settings.returnSlots.find((s) => s.key === id);
const findVehicle = (d: SettingsDraft, id: string) => d.registry.vehicles.find((v) => v.id === id);
const findDiscount = (d: SettingsDraft, id: string) => d.registry.discounts.find((x) => x.key === id);

/** 할인 값의 범위(비율 1 ~ 100, 금액 10원 단위 10 ~ 1,000,000). */
export function discountValueOk(kind: FxDiscount['kind'], value: number): boolean {
  if (!Number.isInteger(value)) return false;
  if (kind === 'percent') return value >= SETTINGS_RANGES.percent.min && value <= SETTINGS_RANGES.percent.max;
  return value >= SETTINGS_RANGES.amount.min && value <= SETTINGS_RANGES.amount.max && value % SETTINGS_RANGES.amount.step === 0;
}

const intIn = (n: number, range: { min: number; max: number }) => Number.isInteger(n) && n >= range.min && n <= range.max;

/**
 * 목록 바꿈 하나를 판에 적용한다. state는 읽기만 한다(차량 사용 종료의 막힘 · 그 차량의 업무를 본다). 거절이면 까닭.
 */
export function applyRegistryOp(state: ShopState, d: SettingsDraft, op: RegistryOp, ids: RowIds): Refusal | undefined {
  const reg = d.registry;
  switch (op.op) {
    case 'shop.set': {
      if (op.name !== undefined) {
        const name = cleanLabel(op.name);
        if (!name) return BAD;
        reg.shopName = name;
      }
      if (op.phone !== undefined) {
        if (!/^(\d{9,11})?$/.test(op.phone)) return BAD;
        if (op.phone) reg.shopPhone = op.phone;
        else delete reg.shopPhone;
      }
      return undefined;
    }
    case 'area.add': {
      const label = cleanLabel(op.label);
      if (!label) return BAD;
      const dup = duplicateOf(reg.areas, label);
      if (dup) return refuse(dup);
      const id = ids.make(op.ref);
      if (findArea(d, id)) return BAD;
      reg.areas.push({ id, label, lodging: false, places: [] });
      return undefined;
    }
    case 'area.rename': {
      const area = findArea(d, ids.resolve(op.id));
      const label = cleanLabel(op.label);
      if (!area || !label) return BAD;
      const dup = duplicateOf(reg.areas, label, area);
      if (dup) return refuse(dup);
      area.label = label;
      return undefined;
    }
    case 'area.hide': {
      const area = findArea(d, ids.resolve(op.id));
      if (!area) return BAD;
      if (op.hidden) area.hidden = true;
      else delete area.hidden;
      return undefined;
    }
    case 'area.move': {
      const area = findArea(d, ids.resolve(op.id));
      return area && moveIn(reg.areas, area, op.toIndex) ? undefined : BAD;
    }
    case 'place.add': {
      const area = findArea(d, ids.resolve(op.areaId));
      const label = cleanLabel(op.label);
      if (!area || !label) return BAD;
      const dup = duplicateOf(area.places, label);
      if (dup) return refuse(dup);
      const id = ids.make(op.ref);
      if (findPlace(d, id)) return BAD;
      area.places.push({ id, label });
      return undefined;
    }
    case 'place.rename': {
      const found = findPlace(d, ids.resolve(op.id));
      const label = cleanLabel(op.label);
      if (!found || !label) return BAD;
      const dup = duplicateOf(found.area.places, label, found.place);
      if (dup) return refuse(dup);
      found.place.label = label;
      return undefined;
    }
    case 'place.hide': {
      const found = findPlace(d, ids.resolve(op.id));
      if (!found) return BAD;
      if (op.hidden) found.place.hidden = true;
      else delete found.place.hidden;
      return undefined;
    }
    case 'place.move': {
      const found = findPlace(d, ids.resolve(op.id));
      return found && moveIn(found.area.places, found.place, op.toIndex) ? undefined : BAD;
    }
    case 'slot.add': {
      const label = cleanLabel(op.label);
      const at = slotHourOf(op.time, d.settings.businessDayCutoff);
      if (!label || !at) return BAD;
      const dup = duplicateOf(d.settings.returnSlots, label);
      if (dup) return refuse(dup);
      const key = ids.make(op.ref);
      if (findSlot(d, key)) return BAD;
      d.settings.returnSlots.push({ key, label, hour: at.hour, minute: at.minute, night: slotMinutes(at) >= NIGHT_FROM_MINUTES });
      return undefined;
    }
    case 'slot.update': {
      const slot = findSlot(d, ids.resolve(op.id));
      if (!slot) return BAD;
      if (op.label !== undefined) {
        const label = cleanLabel(op.label);
        if (!label) return BAD;
        const dup = duplicateOf(d.settings.returnSlots, label, slot);
        if (dup) return refuse(dup);
        slot.label = label;
      }
      if (op.time !== undefined) {
        const at = slotHourOf(op.time, d.settings.businessDayCutoff);
        if (!at) return BAD;
        // 야간 여부는 그대로(E12). 늦춘 시각이면 가장 이른 시각을 남긴다(이미 잡은 접수의 늦음이 움직이지 않게).
        const earliest = Math.min(slotMinutes(slot), slot.earliest ? slotMinutes(slot.earliest) : Infinity);
        if (slot.night === undefined) slot.night = slotMinutes(slot) >= NIGHT_FROM_MINUTES;
        slot.hour = at.hour;
        slot.minute = at.minute;
        if (earliest < slotMinutes(at)) slot.earliest = { hour: Math.floor(earliest / 60), minute: earliest % 60 };
        else delete slot.earliest;
      }
      return undefined;
    }
    case 'slot.hide': {
      const slot = findSlot(d, ids.resolve(op.id));
      if (!slot) return BAD;
      if (op.hidden) {
        const why = slotHideRefusal(reg as ShopRegistry, d.settings, slot);
        if (why) return refuse(why);
        slot.hidden = true;
      } else {
        delete slot.hidden;
      }
      return undefined;
    }
    case 'slot.move': {
      const slot = findSlot(d, ids.resolve(op.id));
      return slot && moveIn(d.settings.returnSlots, slot, op.toIndex) ? undefined : BAD;
    }
    case 'price.set': {
      const product = reg.products[op.productKey];
      if (!product || !intIn(op.amount, SETTINGS_RANGES.price) || op.amount % SETTINGS_RANGES.price.step !== 0) return BAD;
      reg.products[op.productKey] = { ...product, price: op.amount };
      return undefined;
    }
    case 'discount.add': {
      const label = cleanLabel(op.label);
      const sections = [...new Set(op.sections)];
      if (!label || !sections.length || !sections.every((s) => reg.paySections.some((p) => p.key === s))) return BAD;
      // 리프트권 칸은 비율만(plan E9).
      if (op.kind !== 'percent' && sections.includes('lift')) return BAD;
      if (!discountValueOk(op.kind, op.value)) return BAD;
      const dup = duplicateOf(reg.discounts, label);
      if (dup) return refuse(dup);
      const key = ids.make(op.ref);
      if (findDiscount(d, key)) return BAD;
      // 칸 차례는 결제 칸의 차례(장비 → 리프트권).
      const ordered = reg.paySections.map((p) => p.key).filter((k) => sections.includes(k));
      reg.discounts.push({ key, label, kind: op.kind, value: op.value, sections: ordered });
      return undefined;
    }
    case 'discount.update': {
      const rule = findDiscount(d, ids.resolve(op.id));
      if (!rule) return BAD;
      if (op.label !== undefined) {
        const label = cleanLabel(op.label);
        if (!label) return BAD;
        const dup = duplicateOf(reg.discounts, label, rule);
        if (dup) return refuse(dup);
        rule.label = label;
      }
      if (op.value !== undefined) {
        if (!discountValueOk(rule.kind, op.value)) return BAD;
        rule.value = op.value;
      }
      return undefined;
    }
    case 'discount.active': {
      const rule = findDiscount(d, ids.resolve(op.id));
      if (!rule) return BAD;
      if (op.active) delete rule.hidden;
      else rule.hidden = true;
      return undefined;
    }
    case 'vehicle.add': {
      const label = cleanLabel(op.label);
      if (!label) return BAD;
      const dup = duplicateOf(reg.vehicles, label);
      if (dup) return refuse(dup);
      const id = ids.make(op.ref);
      if (findVehicle(d, id)) return BAD;
      reg.vehicles.push({ id, label });
      d.drawers.push({ id: 'van:' + id, kind: 'vehicle', label: label + ' 현금', vehicleId: id });
      return undefined;
    }
    case 'vehicle.rename': {
      const vehicle = findVehicle(d, ids.resolve(op.id));
      const label = cleanLabel(op.label);
      if (!vehicle || !label) return BAD;
      const dup = duplicateOf(reg.vehicles, label, vehicle);
      if (dup) return refuse(dup);
      vehicle.label = label;
      const drawer = d.drawers.find((x) => x.vehicleId === vehicle.id);
      if (drawer) drawer.label = label + ' 현금';
      return undefined;
    }
    case 'vehicle.active': {
      const vehicle = findVehicle(d, ids.resolve(op.id));
      if (!vehicle) return BAD;
      if (op.active) {
        delete vehicle.ended;
        return undefined;
      }
      if (vehicle.ended) return undefined;
      const why = vehicleEndRefusal(state, vehicle.id);
      if (why) return refuse(why);
      vehicle.ended = true;
      // 그 차량의 배정도 끝난다(직원의 지금 차량이 빈다).
      for (const s of d.staff) if (s.vehicleId === vehicle.id) delete s.vehicleId;
      return undefined;
    }
    case 'setting.default_slot': {
      const slot = findSlot(d, ids.resolve(op.slotId));
      if (!slot || slot.hidden) return BAD;
      d.settings.defaultReturnSlotKey = slot.key;
      return undefined;
    }
    case 'setting.night_notice':
      if (!intIn(op.minutes, SETTINGS_RANGES.notice)) return BAD;
      d.settings.nightNoticeMinutes = op.minutes;
      return undefined;
    case 'setting.vehicle_late':
      if (!intIn(op.minutes, SETTINGS_RANGES.late) || !intIn(op.nightMinutes, SETTINGS_RANGES.late)) return BAD;
      d.settings.vehicleLate = { minutes: op.minutes, nightMinutes: op.nightMinutes };
      return undefined;
    default:
      return BAD;
  }
}

// ── 직원 바꿈 ────────────────────────────────────────────────────────

/** 명령을 한 사람(세션의 직원, 봉투가 아니다). 없으면(메모리 어댑터) `본인` 막힘을 보지 않는다. */
export interface SettingsActor {
  staffId?: string;
}

const activeManagers = (staff: readonly FxStaff[]) => staff.filter((s) => s.status === 'active' && s.roleKey === 'manager');
const ROLE_KEYS = ['manager', 'counter', 'driver'] as const;

/** 쓸 수 있는 차량(사용 종료 아님)의 id인지. */
const usableVehicle = (d: SettingsDraft, id: string) => d.registry.vehicles.some((v) => v.id === id && !v.ended);

export function applyStaffOp(d: SettingsDraft, op: StaffOp, ids: RowIds, actor: SettingsActor | undefined): Refusal | undefined {
  const find = (id: string) => d.staff.find((s) => s.id === ids.resolve(id));
  switch (op.op) {
    case 'staff.add': {
      const name = cleanLabel(op.name);
      if (!name || !ROLE_KEYS.includes(op.role)) return BAD;
      const vehicleId = op.vehicleId === undefined ? undefined : ids.vehicle(op.vehicleId);
      if (vehicleId !== undefined && !usableVehicle(d, vehicleId)) return BAD;
      if (op.role === 'driver' && vehicleId === undefined) return refuse(SETTINGS_LINES.noVehicle);
      const dup = d.staff.find((s) => s.name === name);
      if (dup) return refuse(dup.status === 'active' ? SETTINGS_LINES.duplicate : SETTINGS_LINES.duplicateHidden);
      const id = ids.make(op.ref);
      if (d.staff.some((s) => s.id === id)) return BAD;
      d.staff.push({ id, name, roleKey: op.role, ...(vehicleId ? { vehicleId } : {}), status: 'active' });
      return undefined;
    }
    case 'staff.update': {
      const person = find(op.id);
      if (!person) return BAD;
      if (op.role !== undefined) {
        if (!ROLE_KEYS.includes(op.role)) return BAD;
        if (person.roleKey === 'manager' && op.role !== 'manager' && person.status === 'active' && activeManagers(d.staff).length <= 1) {
          return refuse(SETTINGS_LINES.endLastManager);
        }
        person.roleKey = op.role;
      }
      if (op.vehicleId !== undefined) {
        if (op.vehicleId === null) {
          delete person.vehicleId;
        } else {
          const vehicleId = ids.vehicle(op.vehicleId);
          if (!usableVehicle(d, vehicleId)) return BAD;
          person.vehicleId = vehicleId;
        }
      }
      if (person.status === 'active' && person.roleKey === 'driver' && person.vehicleId === undefined) return refuse(SETTINGS_LINES.noVehicle);
      return undefined;
    }
    case 'staff.active': {
      const person = find(op.id);
      if (!person) return BAD;
      if (op.active) {
        person.status = 'active';
        if (person.roleKey === 'driver' && person.vehicleId === undefined) return refuse(SETTINGS_LINES.noVehicle);
        return undefined;
      }
      if (person.status === 'suspended') return undefined;
      if (actor?.staffId && actor.staffId === person.id) return refuse(SETTINGS_LINES.endSelf);
      if (person.roleKey === 'manager' && activeManagers(d.staff).length <= 1) return refuse(SETTINGS_LINES.endLastManager);
      person.status = 'suspended';
      // 사용 종료한 사람의 차량 배정도 끝난다(다시 쓸 때 다시 배정).
      delete person.vehicleId;
      return undefined;
    }
    default:
      return BAD;
  }
}

/** 초안 모두(두 종류 섞임)를 차례로 판에 적용한다. 거절이면 그 차례와 까닭. */
export function applySettingsOps(
  state: ShopState, d: SettingsDraft, ops: readonly SettingsOp[], ids: RowIds, actor?: SettingsActor,
): { at: number; refusal: Refusal } | undefined {
  for (const [at, op] of ops.entries()) {
    const refusal = op.op.startsWith('staff.') ? applyStaffOp(d, op as StaffOp, ids, actor) : applyRegistryOp(state, d, op as RegistryOp, ids);
    if (refusal) return { at, refusal };
  }
  return undefined;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 판을 상태에 넣는다(바뀐 것이 없으면 false). */
function commit(state: ShopState, d: SettingsDraft): boolean {
  const changed = !sameJson(state.registry, d.registry) || !sameJson(state.settings, d.settings) || !sameJson(state.drawers, d.drawers)
    || !sameJson(state.staff ?? [], d.staff);
  if (!changed) return false;
  state.registry = d.registry;
  state.settings = d.settings;
  state.drawers = d.drawers;
  state.staff = d.staff;
  return true;
}

const resultOf = (refusal: Refusal, lines: DomainLines): Result => ('message' in refusal ? rejected(refusal.message) : unsupported(lines));

/** 매장 목록 바꿈(registry.update, 연결 필요): 모두 받거나 모두 거절. */
export function applyRegistryUpdate(state: ShopState, envelope: CommandEnvelope<'registry.update'>, lines: DomainLines): Result {
  const d = draftOf(state);
  const ids = commandIds(envelope.requestId);
  for (const op of envelope.payload.changes ?? []) {
    if (op.op.startsWith('staff.')) return unsupported(lines);
    const refusal = applyRegistryOp(state, d, op, ids);
    if (refusal) return resultOf(refusal, lines);
  }
  if (!commit(state, d)) return nothing(SETTINGS_LINES.noChange);
  return done;
}

/** 직원 바꿈(staff.set). 결과에 새 직원 id(비밀번호 재발급을 이어 부를 수 있게). */
export function applyStaffSet(state: ShopState, envelope: CommandEnvelope<'staff.set'>, lines: DomainLines, actor?: SettingsActor): Result {
  const d = draftOf(state);
  const ids = commandIds(envelope.requestId, envelope.dependsOn?.[0]);
  const staffIds: string[] = [];
  for (const op of envelope.payload.changes ?? []) {
    if (!op.op.startsWith('staff.')) return unsupported(lines);
    const refusal = applyStaffOp(d, op, ids, actor);
    if (refusal) return resultOf(refusal, lines);
    if (op.op === 'staff.add') staffIds.push(ids.make(op.ref));
  }
  if (!commit(state, d)) return nothing(SETTINGS_LINES.noChange);
  return { outcome: 'applied', result: { staffIds } };
}

/** 이 명령이 건드리는 목록 행(충돌 키 registry:<표>:<id>, E19). */
export function settingsTouches(ops: readonly SettingsOp[], requestId: string, previous?: string): string[] {
  const ids = commandIds(requestId, previous);
  const out = new Set<string>();
  for (const op of ops) {
    const key = (table: string, id: string) => out.add('registry:' + table + ':' + id);
    switch (op.op) {
      case 'shop.set': key('shops', ''); break;
      case 'area.add': key('areas', ids.make(op.ref)); break;
      case 'area.rename': case 'area.hide': case 'area.move': key('areas', ids.resolve(op.id)); break;
      case 'place.add': key('places', ids.make(op.ref)); key('areas', ids.resolve(op.areaId)); break;
      case 'place.rename': case 'place.hide': case 'place.move': key('places', ids.resolve(op.id)); break;
      case 'slot.add': key('return_slots', ids.make(op.ref)); break;
      case 'slot.update': case 'slot.hide': case 'slot.move': key('return_slots', ids.resolve(op.id)); break;
      case 'price.set': key('price_rules', op.productKey); break;
      case 'discount.add': key('discount_rules', ids.make(op.ref)); break;
      case 'discount.update': case 'discount.active': key('discount_rules', ids.resolve(op.id)); break;
      case 'vehicle.add': key('vehicles', ids.make(op.ref)); break;
      case 'vehicle.rename': case 'vehicle.active': key('vehicles', ids.resolve(op.id)); break;
      case 'setting.default_slot': key('shop_settings', 'default_return_slot'); break;
      case 'setting.night_notice': key('shop_settings', 'night_collection_notice_minutes'); break;
      case 'setting.vehicle_late': key('shop_settings', 'vehicle_late_after_minutes'); break;
      case 'staff.add': key('staff_members', ids.make(op.ref)); break;
      case 'staff.update': case 'staff.active': key('staff_members', ids.resolve(op.id)); break;
    }
  }
  return [...out];
}

/** 이 매장의 쓰는 차량 · 숨기지 않은 반납 타임(고르기). */
export const usableVehicles = (reg: Pick<ShopRegistry, 'vehicles'>) => reg.vehicles.filter((v) => !v.ended);

// 표 → 매장 목록 값(ShopRegistry) · 운영 규칙(FxShopRules) · 돈통(plan §4-2). registry-write가 쓴 모양을 그대로 되읽는다
// (load(write(x)) ≡ x). 차례는 sort 열, sort가 없는 표(차량 · 돈통)는 넣은 차례(rowid)다. 시스템 행(보증금 결제 수단 · 보증금 칸)은
// 매장 목록에 넣지 않는다.
import type {
  FxArea, FxDepositRule, FxDiscount, FxDrawer, FxKind, FxMethodKey, FxPayMethod, FxPaySection, FxProduct, FxReturnSlot, FxSection, FxShopRules, FxStaff, FxVehicle,
  FxVisitOutcome, ShopRegistry,
} from '@skinote/domain';
import type { ConditionKey } from '@skinote/contract';
import { StoreError } from './errors.ts';
import { cutoffHistory } from './dates.ts';
import { all, num, one, str, text, type Db, type Row } from './db.ts';
import { axisAttribute, CLOSING_DIFFERENCE, DEPOSIT_SECTION, INCLUDES_ATTRIBUTE, SETTING, VISIT_RESULT } from './registry-keys.ts';

const bool = (value: unknown) => value === 1 || value === 1n;

/** 설정의 지금 값(가장 높은 판, 적용 시각이 지난 것). 없으면 undefined. */
export function currentSetting<T = Record<string, unknown>>(db: Db, shopId: string, key: string, nowIso?: string): T | undefined {
  const row = nowIso
    ? one(db, "SELECT value_json FROM shop_settings WHERE shop_id = ? AND setting_key = ? AND scope_key = '' AND effective_from <= ? ORDER BY version_no DESC LIMIT 1", shopId, key, nowIso)
    : one(db, "SELECT value_json FROM shop_settings WHERE shop_id = ? AND setting_key = ? AND scope_key = '' ORDER BY version_no DESC LIMIT 1", shopId, key);
  return row ? (JSON.parse(str(row.value_json)) as T) : undefined;
}

/** 반납 타임의 시(24:00 → 24). */
const slotHour = (row: Row) => {
  const [h = 0] = str(row.local_time).split(':').map(Number);
  return h + 24 * num(row.day_offset);
};

export interface LoadedRegistry {
  registry: ShopRegistry;
  settings: FxShopRules;
  drawers: FxDrawer[];
}

/** 매장 목록 값 · 운영 규칙 · 돈통. nowIso를 주면 그때 적용된 설정 판을 읽는다. */
export function loadRegistry(db: Db, shopId: string, nowIso?: string): LoadedRegistry {
  const shop = one(db, 'SELECT name, phone, timezone FROM shops WHERE id = ?', shopId);
  if (!shop) throw new StoreError('SHOP_NOT_PROVISIONED', '매장 행이 없다: ' + shopId);
  if (shop.timezone !== 'Asia/Seoul') throw new StoreError('TIMEZONE_UNSUPPORTED', '매장 시간대: ' + String(shop.timezone));

  // 반납 타임(권의 반납 시각 처음 값을 시각으로 찾는다). 숨긴 타임(active 0)도 읽는다: 지난 접수 · 늦음이 그 타임을 본다(features-1 E12).
  const slotRows = all(db, 'SELECT id, label, local_time, day_offset, is_night, active FROM return_slots WHERE shop_id = ? ORDER BY sort, rowid', shopId);
  const returnSlots: FxReturnSlot[] = slotRows.map((r) => {
    const [, m = 0] = str(r.local_time).split(':').map(Number);
    const slot: FxReturnSlot = { key: str(r.id), label: str(r.label), hour: slotHour(r), minute: m, night: bool(r.is_night) };
    const earliest = slotEarliest(db, shopId, slot);
    return { ...slot, ...(bool(r.active) ? {} : { hidden: true as const }), ...(earliest ? { earliest } : {}) };
  });

  const kindRows = all(db, `SELECT id, label, fulfillment_mode_key, tracking_key, return_policy_key, payment_section_id, exchangeable, extendable, picker_placement_key, unit_label
    FROM item_kinds WHERE shop_id = ? AND active = 1 ORDER BY sort, rowid`, shopId);
  const kindById = new Map(kindRows.map((r) => [str(r.id), r]));
  const itemRows = all(db, 'SELECT id, item_kind_id, label, short_label, unit_label, tracking_key FROM catalog_items WHERE shop_id = ? AND active = 1 AND archived_at IS NULL ORDER BY sort, rowid', shopId);
  // 1일 값: 기본 판매 요금표의 게시한 판(뒤 판이 앞 판을 덮는다). 판 안의 상품 규칙 하나가 그 상품의 값이다.
  const prices = new Map(all(db, `SELECT r.catalog_item_id, r.unit_amount FROM price_rules r
    JOIN price_list_versions v ON v.shop_id = r.shop_id AND v.id = r.price_list_version_id
    JOIN price_lists l ON l.shop_id = v.shop_id AND l.id = v.price_list_id
    WHERE r.shop_id = ? AND l.is_default = 1 AND l.purpose_key = 'sale' AND v.status_key = 'published' AND r.catalog_item_id IS NOT NULL
      AND r.variant_id IS NULL AND r.unit_amount IS NOT NULL ORDER BY v.version_no, r.priority`, shopId)
    .map((r) => [str(r.catalog_item_id), num(r.unit_amount)]));
  const includes = new Map(all(db, 'SELECT catalog_item_id, value_text FROM catalog_item_attribute_values WHERE shop_id = ? AND attribute_id = ?', shopId, INCLUDES_ATTRIBUTE)
    .map((r) => [str(r.catalog_item_id), str(r.value_text)]));
  const windows = new Map(all(db, 'SELECT catalog_item_id, window_end FROM ticket_products WHERE shop_id = ?', shopId).map((r) => [str(r.catalog_item_id), text(r.window_end)]));

  const products: Record<string, FxProduct> = {};
  const productsOfKind = new Map<string, string[]>();
  for (const r of itemRows) {
    const key = str(r.id);
    const kind = kindById.get(str(r.item_kind_id));
    if (!kind) continue;
    const ticket = kind.fulfillment_mode_key === 'ticket';
    const capabilities: ConditionKey[] = [];
    if (bool(kind.exchangeable)) capabilities.push('exchangeable');
    if (bool(kind.extendable)) capabilities.push('extendable');
    const countWord = text(r.unit_label) ?? str(kind.unit_label);
    const price = prices.get(key);
    if (price === undefined) throw new StoreError('BAD_SPEC', '요금 규칙 없는 상품: ' + key);
    const windowEnd = windows.get(key);
    const slot = windowEnd === undefined ? undefined : returnSlots.find((s) => slotRowTime(s) === windowEnd);
    products[key] = {
      key,
      kindKey: str(kind.id),
      label: str(r.label),
      ...(text(r.short_label) !== undefined ? { shortLabel: str(r.short_label) } : {}),
      ...(ticket ? { unit: countWord } : {}),
      price,
      section: str(kind.payment_section_id) as FxSection,
      returnable: !ticket && kind.return_policy_key === 'required',
      capabilities,
      tracking: (text(r.tracking_key) ?? str(kind.tracking_key)) as FxProduct['tracking'],
      countWord,
      ...(includes.has(key) ? { includes: includes.get(key)! } : {}),
      ...(slot ? { returnSlotKey: slot.key } : {}),
    };
    productsOfKind.set(str(kind.id), [...(productsOfKind.get(str(kind.id)) ?? []), key]);
  }

  const axes = new Map(all(db, `SELECT a.item_kind_id, d.label FROM item_kind_attributes a JOIN attribute_definitions d ON d.shop_id = a.shop_id AND d.id = a.attribute_id
    WHERE a.shop_id = ? AND a.usage_key = 'variant_axis'`, shopId).map((r) => [str(r.item_kind_id), str(r.label)]));
  const kinds: FxKind[] = kindRows.map((k) => {
    const key = str(k.id);
    const list = productsOfKind.get(key) ?? [];
    const first = list[0];
    const variantRows = first === undefined ? [] : all(db, `SELECT v.code, v.label AS name, o.label FROM item_variants v
      JOIN variant_attribute_values x ON x.shop_id = v.shop_id AND x.variant_id = v.id AND x.attribute_id = ?
      JOIN attribute_options o ON o.shop_id = x.shop_id AND o.attribute_id = x.attribute_id AND o.id = x.option_id
      WHERE v.shop_id = ? AND v.catalog_item_id = ? AND v.active = 1 ORDER BY v.sort, v.rowid`, axisAttribute(key), shopId, first);
    const axis = axes.get(key);
    return {
      key,
      label: str(k.label),
      placement: str(k.picker_placement_key) as FxKind['placement'],
      products: list,
      ...(axis !== undefined ? { axis } : {}),
      ...(variantRows.length ? { variants: variantRows.map((v) => ({ key: str(v.code), label: str(v.label), name: str(v.name) })) } : {}),
    };
  });

  // 환불할 수 없는 수단(refundable 0, 상품권)만 표시한다(features-1 E4).
  const payMethods: FxPayMethod[] = all(db, 'SELECT key, label, quick, driver_allowed, refundable FROM payment_methods WHERE shop_id = ? AND active = 1 AND is_system = 0 ORDER BY sort, rowid', shopId)
    .map((r) => ({
      key: str(r.key) as FxMethodKey, label: str(r.label), quick: bool(r.quick), driver: bool(r.driver_allowed), ...(bool(r.refundable) ? {} : { refundable: false as const }),
    }));
  const paySections: FxPaySection[] = all(db, 'SELECT key, label, default_method_id FROM payment_sections WHERE shop_id = ? AND active = 1 AND is_system = 0 ORDER BY sort, rowid', shopId)
    .map((r) => ({ key: str(r.key) as FxSection, label: str(r.label), defaultMethod: str(r.default_method_id) as FxMethodKey }));
  const sectionOfKind = new Map(kindRows.map((k) => [str(k.id), str(k.payment_section_id)]));
  // 할인: 미사용(active 0)도 읽는다(hidden). 비율은 percent_bp, 금액은 amount(features-1 E9).
  const discounts: FxDiscount[] = all(db, 'SELECT id, label, discount_kind_key, percent_bp, amount, active, required_permission_key FROM discount_rules WHERE shop_id = ? ORDER BY sort, rowid', shopId).map((d) => {
    const sections: FxSection[] = [];
    for (const t of all(db, 'SELECT item_kind_id FROM discount_rule_targets WHERE shop_id = ? AND discount_rule_id = ? ORDER BY seq', shopId, str(d.id))) {
      const s = sectionOfKind.get(str(t.item_kind_id)) as FxSection | undefined;
      if (s && !sections.includes(s)) sections.push(s);
    }
    const kind = str(d.discount_kind_key);
    if (kind !== 'percent' && kind !== 'amount') throw new StoreError('BAD_SPEC', '읽지 못하는 할인 종류: ' + kind);
    return {
      key: str(d.id), label: str(d.label), kind, value: kind === 'percent' ? num(d.percent_bp) / 100 : num(d.amount), sections,
      ...(bool(d.active) ? {} : { hidden: true as const }),
      ...(text(d.required_permission_key) !== undefined ? { requiredPermission: str(d.required_permission_key) } : {}),
    };
  });

  // 구역 · 장소 · 차량: 숨긴(active 0) · 사용 종료한 행도 읽는다(지난 접수 · 마감이 이름을 읽는다, features-1 E12 · E13).
  const lodging = new Set(all(db, "SELECT place_id FROM place_uses WHERE shop_id = ? AND use_key = 'lodging'", shopId).map((r) => str(r.place_id)));
  const areas: FxArea[] = all(db, 'SELECT id, name, active FROM areas WHERE shop_id = ? ORDER BY sort, rowid', shopId).map((a) => {
    const places = all(db, 'SELECT id, name, active FROM places WHERE shop_id = ? AND area_id = ? ORDER BY sort, rowid', shopId, str(a.id))
      .map((p) => ({ id: str(p.id), label: str(p.name), ...(bool(p.active) ? {} : { hidden: true as const }) }));
    return {
      id: str(a.id), label: str(a.name), lodging: places.length > 0 && places.every((p) => lodging.has(p.id)), places,
      ...(bool(a.active) ? {} : { hidden: true as const }),
    };
  });
  const vehicles: FxVehicle[] = all(db, 'SELECT id, name, active FROM vehicles WHERE shop_id = ? ORDER BY rowid', shopId)
    .map((v) => ({ id: str(v.id), label: str(v.name), ...(bool(v.active) ? {} : { ended: true as const }) }));
  const reasons = (domain: string) => all(db, 'SELECT key, label FROM reason_codes WHERE shop_id = ? AND domain_key = ? AND active = 1 ORDER BY sort, rowid', shopId, domain)
    .map((r) => ({ key: str(r.key), label: str(r.label) }));

  const max = currentSetting<{ max?: number }>(db, shopId, SETTING.maxLineQuantity, nowIso);
  const registry: ShopRegistry = {
    shopName: str(shop.name),
    ...(text(shop.phone) !== undefined ? { shopPhone: str(shop.phone) } : {}),
    timezone: 'Asia/Seoul',
    products,
    kinds,
    payMethods,
    paySections,
    discounts,
    areas,
    vehicles,
    visitOutcomes: reasons(VISIT_RESULT) as { key: FxVisitOutcome; label: string }[],
    cashReasons: reasons(CLOSING_DIFFERENCE),
    maxLineQuantity: num(max?.max, 500),
  };

  // 운영 규칙
  const liftKind = kinds.find((k) => products[k.products[0] ?? '']?.section === 'lift');
  const liftPolicy = liftKind ? kindById.get(liftKind.key)?.return_policy_key : undefined;
  const ruleRow = one(db, `SELECT r.*, s.default_method_id, k.payment_section_id AS kind_section FROM deposit_rules r
    JOIN item_kinds k ON k.shop_id = r.shop_id AND k.id = r.item_kind_id
    LEFT JOIN payment_sections s ON s.shop_id = r.shop_id AND s.id = r.payment_section_id
    WHERE r.shop_id = ? AND r.payment_section_id = ? ORDER BY r.sort, r.rowid LIMIT 1`, shopId, DEPOSIT_SECTION);
  const rule: FxDepositRule | undefined = ruleRow && {
    key: str(ruleRow.key),
    label: str(ruleRow.label),
    section: str(ruleRow.kind_section) as FxSection,
    unitAmount: num(ruleRow.unit_amount),
    timing: str(ruleRow.timing_key) as FxDepositRule['timing'],
    refundDefault: str(ruleRow.refund_default_key) as FxDepositRule['refundDefault'],
    unreturned: str(ruleRow.unreturned_key) as FxDepositRule['unreturned'],
    ...(ruleRow.loss_amount !== null ? { lossAmount: num(ruleRow.loss_amount) } : {}),
    afterDays: ruleRow.unreturned_after_days === null ? null : num(ruleRow.unreturned_after_days),
    methods: [str(ruleRow.default_method_id) as FxMethodKey],
  };
  const prepay = currentSetting<{ mode: FxShopRules['prepaymentMode']; amount?: number }>(db, shopId, SETTING.prepayment, nowIso) ?? { mode: 'none' };
  const refund = currentSetting<{ decision: FxShopRules['sameDayCancelRefund'] }>(db, shopId, SETTING.sameDayCancel, nowIso) ?? { decision: 'refund' };
  const seesDue = currentSetting<{ enabled: boolean }>(db, shopId, SETTING.driverSeesDue, nowIso) ?? { enabled: true };
  const opening = currentSetting<{ amount: number }>(db, shopId, SETTING.openingCash, nowIso) ?? { amount: 0 };
  const defaultSlot = currentSetting<{ return_slot_id: string | null }>(db, shopId, SETTING.defaultReturnSlot, nowIso);
  const vehicleLate = currentSetting<{ minutes: number; night_minutes: number }>(db, shopId, SETTING.vehicleLate, nowIso);
  const nightNotice = currentSetting<{ minutes: number }>(db, shopId, SETTING.nightNotice, nowIso);
  const cutoff = cutoffHistory(db, shopId);
  const settings: FxShopRules = {
    liftReturnPolicy: (liftPolicy === 'optional' ? 'optional' : 'required'),
    liftDeposit: rule && ruleRow && bool(ruleRow.active) ? rule : null,
    ...(rule && ruleRow && !bool(ruleRow.active) ? { liftDepositOff: rule } : {}),
    prepaymentMode: prepay.mode,
    ...(prepay.amount !== undefined ? { prepaymentAmount: prepay.amount } : {}),
    sameDayCancelRefund: refund.decision,
    businessDayCutoff: cutoff.current,
    ...(cutoff.before.length ? { cutoffBefore: cutoff.before } : {}),
    openingCash: opening.amount,
    driverSeesDue: seesDue.enabled,
    returnSlots,
    ...(defaultSlot?.return_slot_id ? { defaultReturnSlotKey: defaultSlot.return_slot_id } : {}),
    ...(vehicleLate ? { vehicleLate: { minutes: num(vehicleLate.minutes, 60), nightMinutes: num(vehicleLate.night_minutes, 60) } } : {}),
    ...(nightNotice ? { nightNoticeMinutes: num(nightNotice.minutes, 60) } : {}),
  };

  const drawers: FxDrawer[] = all(db, 'SELECT id, kind_key, label, vehicle_id FROM cash_drawers WHERE shop_id = ? AND active = 1 ORDER BY rowid', shopId).map((d) => ({
    id: str(d.id), kind: str(d.kind_key) as FxDrawer['kind'], label: str(d.label), ...(text(d.vehicle_id) !== undefined ? { vehicleId: str(d.vehicle_id) } : {}),
  }));
  return { registry, settings, drawers };
}

/**
 * 반납 타임이 가졌던 가장 이른 시각(시각을 바꾼 기록 config_changes의 앞 값): 지금 시각보다 이르면 그 시각, 아니면 없음(도메인 settings.ts와 같은
 * 셈 — 야간이 시작하는 시각이 이미 잡은 접수의 늦음을 옮기지 않게, features-1 E12).
 */
function slotEarliest(db: Db, shopId: string, slot: FxReturnSlot): { hour: number; minute: number } | undefined {
  let earliest = Infinity;
  for (const r of all(db, "SELECT before_json FROM config_changes WHERE shop_id = ? AND entity_type = 'return_slots' AND entity_id = ?", shopId, slot.key)) {
    const before = r.before_json === null ? undefined : (JSON.parse(str(r.before_json)) as { local_time?: string; day_offset?: number });
    if (!before?.local_time) continue;
    const [h = 0, m = 0] = before.local_time.split(':').map(Number);
    earliest = Math.min(earliest, (h + 24 * (before.day_offset ?? 0)) * 60 + m);
  }
  const now = slot.hour * 60 + slot.minute;
  return earliest < now ? { hour: Math.floor(earliest / 60), minute: earliest % 60 } : undefined;
}

/** 반납 타임의 표 시각(권의 window_end와 맞춰 본다). 24:00은 00:00. */
function slotRowTime(slot: FxReturnSlot): string {
  const hour = slot.hour % 24;
  return String(hour).padStart(2, '0') + ':' + String(slot.minute).padStart(2, '0');
}

/** 직원 타일(로그인 화면, 서버 auth): 쓰는 직원과 역할 · 차량. 기사 기기는 기사를 먼저 보인다(서버가 정렬). */
export interface StaffRow {
  id: string;
  name: string;
  roleKey: string;
  vehicleId?: string;
  accountId?: string;
}

/**
 * 직원의 지금 차량: 끝나지 않은 배정(vehicle_assignments, ended_at 없음 · 시작한 날이 오늘 이전) 중 가장 새것. 배정 행이 하나도 없는 옛 직원만
 * default_vehicle_id(읽기 대신 값, features-1 E13). 배정은 직원 바꿈(staff.set)만 쓴다.
 */
function currentVehicle(db: Db, shopId: string, staffId: string, fallback: string | undefined): string | undefined {
  const open = one(db, `SELECT vehicle_id FROM vehicle_assignments WHERE shop_id = ? AND staff_member_id = ? AND ended_at IS NULL
    ORDER BY valid_from DESC, rowid DESC LIMIT 1`, shopId, staffId);
  if (open) return str(open.vehicle_id);
  const any = one(db, 'SELECT 1 AS x FROM vehicle_assignments WHERE shop_id = ? AND staff_member_id = ? LIMIT 1', shopId, staffId);
  return any ? undefined : fallback;
}

export function listStaff(db: Db, shopId: string): StaffRow[] {
  return all(db, `SELECT s.id, s.display_name, s.account_id, s.default_vehicle_id, r.key AS role_key FROM staff_members s
    JOIN roles r ON r.shop_id = s.shop_id AND r.id = s.role_id WHERE s.shop_id = ? AND s.status_key = 'active' ORDER BY s.rowid`, shopId).map((r) => {
    const vehicleId = currentVehicle(db, shopId, str(r.id), text(r.default_vehicle_id));
    return {
      id: str(r.id), name: str(r.display_name), roleKey: str(r.role_key),
      ...(vehicleId !== undefined ? { vehicleId } : {}),
      ...(text(r.account_id) !== undefined ? { accountId: str(r.account_id) } : {}),
    };
  });
}

/** 직원(매장 설정 `차량 · 직원`, ShopState.staff): 쓰는 사람과 사용 종료(suspended)한 사람. 끝난(ended) · 옛 행위자(legacy)는 빼고. */
export function loadStaff(db: Db, shopId: string): FxStaff[] {
  return all(db, `SELECT s.id, s.display_name, s.default_vehicle_id, s.status_key, r.key AS role_key FROM staff_members s
    JOIN roles r ON r.shop_id = s.shop_id AND r.id = s.role_id WHERE s.shop_id = ? AND s.status_key IN ('active', 'suspended') ORDER BY s.rowid`, shopId).map((r) => {
    const roleKey = str(r.role_key);
    if (roleKey !== 'manager' && roleKey !== 'counter' && roleKey !== 'driver') throw new StoreError('BAD_SPEC', '읽지 못하는 역할: ' + roleKey);
    const vehicleId = currentVehicle(db, shopId, str(r.id), text(r.default_vehicle_id));
    return {
      id: str(r.id), name: str(r.display_name), roleKey, ...(vehicleId !== undefined ? { vehicleId } : {}),
      status: str(r.status_key) === 'active' ? 'active' as const : 'suspended' as const,
    };
  });
}

/** 역할의 권한(권한 key → 범위). 서버의 권한 표(permissions.js)가 세션마다 읽는다. */
export function rolePermissions(db: Db, shopId: string, roleKey: string): Map<string, string> {
  return new Map(all(db, `SELECT p.permission_key, p.scope_key FROM role_permissions p JOIN roles r ON r.shop_id = p.shop_id AND r.id = p.role_id
    WHERE p.shop_id = ? AND r.key = ?`, shopId, roleKey).map((r) => [str(r.permission_key), str(r.scope_key)]));
}

/**
 * 역할의 한도(role_permissions.limits_json: `{"max_discount_amount": 10000, "max_discount_percent_bp": 1000}`, 보통 discount.manual 줄). 여러 줄에
 * 있으면 가장 작은 값. 없으면 빈 객체(한도 없음, features-1 E10 · 열린 질문 plan §14 Q3).
 */
export function roleLimits(db: Db, shopId: string, roleKey: string): { maxDiscountAmount?: number; maxDiscountPercentBp?: number } {
  const out: { maxDiscountAmount?: number; maxDiscountPercentBp?: number } = {};
  for (const r of all(db, `SELECT p.limits_json FROM role_permissions p JOIN roles r ON r.shop_id = p.shop_id AND r.id = p.role_id
    WHERE p.shop_id = ? AND r.key = ? AND p.limits_json IS NOT NULL`, shopId, roleKey)) {
    const parsed = JSON.parse(str(r.limits_json)) as { max_discount_amount?: unknown; max_discount_percent_bp?: unknown };
    if (typeof parsed.max_discount_amount === 'number') out.maxDiscountAmount = Math.min(out.maxDiscountAmount ?? Infinity, parsed.max_discount_amount);
    if (typeof parsed.max_discount_percent_bp === 'number') out.maxDiscountPercentBp = Math.min(out.maxDiscountPercentBp ?? Infinity, parsed.max_discount_percent_bp);
  }
  return out;
}

// 매장 목록 값(ShopRegistry) · 운영 규칙(FxShopRules) · 돈통 → 표(plan §4-2 '머리와 목록'). 매장을 만들 때(provision) 한 번 모두
// 쓰고, 운영 규칙 저장(setting.set)은 바뀐 곳만 쓴다(목록 행은 제자리 수정 + config_changes 기록, 설정은 shop_settings 새 판).
// 되읽기(registry-read)가 같은 값을 돌려주는 것이 기준이다(load(write(x)) ≡ x, D3). 규칙 셈은 하지 않고 모양만 옮긴다.
import type { FxDepositRule, FxDiscount, FxDrawer, FxKind, FxProduct, FxReturnSlot, FxShopRules, ShopRegistry } from '@skinote/domain';
import { StoreError } from './errors.ts';
import { canonicalJson, isoOf } from './ids.ts';
import { insert, num, one, run, str, type Db } from './db.ts';
import {
  axisAttribute, axisOption, CANCELLATION, CANCELLATION_FEE, CANCELLATION_REASON, CASH_METHOD, CLOSING_DIFFERENCE, DEPOSIT_METHOD, DEPOSIT_SECTION, DISCOUNT_CHANGE, EXTENSION,
  EXTENSION_UNDO, HANDOVER, INCLUDES_ATTRIBUTE,
  MAIN_SCOPE, OK_CONDITION, PRICE_LIST, PRICE_VERSION, priceRuleId, reasonId, SETTING, TICKET_VENDOR, defaultVariantId, variantId, VISIT_RESULT,
} from './registry-keys.ts';

/** 누가 언제 쓰나(목록 행의 updated_at · config_changes · shop_settings). */
export interface WriteMeta {
  now: number;
  actorKey: string;
  requestId?: string;
  /** 이 쓰기의 rev(매장 만들기는 0). */
  rev: number;
}

const bad = (message: string): never => {
  throw new StoreError('BAD_SPEC', message);
};

/** 반납 타임의 표 모양: 24:00 → 00:00 + 하루 뒤(return_slots.day_offset). */
export function slotRow(slot: FxReturnSlot): { local_time: string; day_offset: number } {
  const day = Math.floor(slot.hour / 24);
  const hour = slot.hour - day * 24;
  return { local_time: String(hour).padStart(2, '0') + ':' + String(slot.minute).padStart(2, '0'), day_offset: day };
}

/** 종류의 상품(모두 목록에 있어야 한다). */
function kindProducts(reg: ShopRegistry, kind: FxKind): FxProduct[] {
  const list = kind.products.map((key) => reg.products[key] ?? bad('종류 ' + kind.key + '의 상품이 목록에 없다: ' + key));
  if (!list.length) bad('상품 없는 종류: ' + kind.key);
  for (const p of list) if (p.kindKey !== kind.key) bad('상품 ' + p.key + '의 종류가 ' + kind.key + '가 아니다');
  return list;
}

/** 권(리프트권)인지: 수량 단위(unit, '매')를 가진 상품은 권이다(catalog 2, FxProduct.unit). */
const isTicket = (products: readonly FxProduct[]) => products.some((p) => p.unit !== undefined);

/** 종류의 반납 정책: 리프트권 칸의 종류는 운영 규칙(liftReturnPolicy), 장비는 상품의 returnable. */
function returnPolicyOf(products: readonly FxProduct[], settings: FxShopRules): string {
  const first = products[0]!;
  if (first.section === 'lift') return settings.liftReturnPolicy;
  return first.returnable ? 'required' : 'none';
}

/** 운영 규칙의 보증금 규칙(사용 중이거나 미사용으로 둔 값). 둘 다 있으면 되읽을 수 없어 거절한다. */
export function depositRuleOf(settings: FxShopRules): FxDepositRule | undefined {
  if (settings.liftDeposit && settings.liftDepositOff) bad('보증금 규칙이 사용 · 미사용 둘 다 있다');
  return settings.liftDeposit ?? settings.liftDepositOff;
}

/** 반납 타임의 야간 여부(return_slots.is_night): 도메인 값, 없으면(옛 자료) 20시 이후. */
export const slotNight = (s: FxReturnSlot) => s.night ?? s.hour >= 20;

/** 청구 조정 종류 `할인 변경`(부호 0: 할인이 커지면 음수, 줄면 양수, features-1 E9). */
function insertDiscountChangeType(db: Db, shopId: string, at: string): void {
  insert(db, 'adjustment_types', {
    shop_id: shopId, id: DISCOUNT_CHANGE, key: DISCOUNT_CHANGE, label: '할인 변경', report_group_key: 'discount', sign: 0, is_system: true, sort: 3, created_at: at, updated_at: at,
  });
}

/** `할인 변경` 종류가 없으면 둔다(0004 전에 만든 매장 파일: 코드가 처음 쓸 때, features-1 §3-2). */
export function ensureDiscountChangeType(db: Db, shopId: string, at: string): void {
  if (!one(db, 'SELECT 1 AS x FROM adjustment_types WHERE shop_id = ? AND id = ?', shopId, DISCOUNT_CHANGE)) insertDiscountChangeType(db, shopId, at);
}

/**
 * 취소의 청구 조정 종류(취소 −, 환불 없음 +)와 구분 사유(취소 요청 · 연락 없음)가 없으면 둔다(0004 전에 만든 매장 파일: 코드가 처음 쓸 때, 새 매장은
 * 매장 만들기가, features-1 §3-2). 이름은 문구 표 3-20의 말.
 */
export function ensureCancellationKinds(db: Db, shopId: string, at: string): void {
  const base = { shop_id: shopId, is_system: true, created_at: at, updated_at: at };
  if (!one(db, 'SELECT 1 AS x FROM adjustment_types WHERE shop_id = ? AND id = ?', shopId, CANCELLATION)) {
    insert(db, 'adjustment_types', { ...base, id: CANCELLATION, key: CANCELLATION, label: '취소', report_group_key: 'charge', sign: -1, sort: 4 });
  }
  if (!one(db, 'SELECT 1 AS x FROM adjustment_types WHERE shop_id = ? AND id = ?', shopId, CANCELLATION_FEE)) {
    insert(db, 'adjustment_types', { ...base, id: CANCELLATION_FEE, key: CANCELLATION_FEE, label: '환불 없음', report_group_key: 'fee', sign: 1, sort: 5 });
  }
  const reasons = [{ key: 'request', label: '취소 요청' }, { key: 'no_show', label: '연락 없음' }];
  reasons.forEach((r, i) => {
    const id = reasonId(CANCELLATION_REASON, r.key);
    if (!one(db, 'SELECT 1 AS x FROM reason_codes WHERE shop_id = ? AND id = ?', shopId, id)) {
      insert(db, 'reason_codes', { shop_id: shopId, id, domain_key: CANCELLATION_REASON, key: r.key, label: r.label, is_system: true, sort: i });
    }
  });
}

/** 할인 묶음이 내는 종류(discount_group_kinds)를 둔다(매장 만들기는 비율만 두었다, features-1 E10). */
export function ensureGroupKind(db: Db, shopId: string, group: string, kind: string): void {
  if (one(db, 'SELECT 1 AS x FROM discount_group_kinds WHERE shop_id = ? AND discount_group_id = ? AND discount_kind_key = ?', shopId, group, kind)) return;
  const sort = num(one(db, 'SELECT count(*) AS n FROM discount_group_kinds WHERE shop_id = ? AND discount_group_id = ?', shopId, group)?.n);
  insert(db, 'discount_group_kinds', { shop_id: shopId, discount_group_id: group, discount_kind_key: kind, sort });
}

/** 할인 규칙 한 행과 대상(결제 칸의 종류들). 규칙이 칸 여럿에 걸리면 첫 칸의 묶음에 둔다(plan §4-2). */
export function insertDiscountRule(db: Db, shopId: string, reg: ShopRegistry, d: FxDiscount, sort: number, at: string, rev = 0): void {
  const group = d.sections[0] ?? bad('할인 ' + d.key + '의 결제 칸이 없다');
  ensureGroupKind(db, shopId, group, d.kind);
  insert(db, 'discount_rules', {
    shop_id: shopId, id: d.key, label: d.label, discount_kind_key: d.kind, discount_group_id: group,
    ...(d.kind === 'percent' ? { percent_bp: Math.round(d.value * 100) } : { amount: d.value }), rounding_unit: 10, sort, active: !d.hidden,
    required_permission_key: d.requiredPermission,
    created_at: at, updated_at: at, updated_rev: rev,
  });
  let seq = 0;
  for (const section of d.sections) {
    const kinds = reg.kinds.filter((k) => reg.products[k.products[0] ?? '']?.section === section);
    if (!kinds.length) bad('할인 ' + d.key + '의 결제 칸 ' + section + '에 종류가 없다');
    for (const k of kinds) insert(db, 'discount_rule_targets', { shop_id: shopId, discount_rule_id: d.key, seq: (seq += 1), item_kind_id: k.key });
  }
}

/** 설정 값의 JSON(shop_settings.value_json). */
export function settingValues(reg: ShopRegistry, settings: FxShopRules): Record<string, unknown> {
  return {
    [SETTING.prepayment]: { mode: settings.prepaymentMode, ...(settings.prepaymentAmount !== undefined ? { amount: settings.prepaymentAmount } : {}) },
    [SETTING.sameDayCancel]: { decision: settings.sameDayCancelRefund },
    [SETTING.driverSeesDue]: { enabled: settings.driverSeesDue },
    [SETTING.maxLineQuantity]: { max: reg.maxLineQuantity },
    [SETTING.openingCash]: { amount: settings.openingCash },
    [SETTING.defaultReturnSlot]: { return_slot_id: settings.defaultReturnSlotKey ?? null },
    // 없는 매장(옛 명세)은 적지 않는다: 되읽기가 없음 = 시작 값(rules.ts lateAfter · nightNoticeBefore)으로 읽는다.
    ...(settings.vehicleLate ? { [SETTING.vehicleLate]: { minutes: settings.vehicleLate.minutes, night_minutes: settings.vehicleLate.nightMinutes } } : {}),
    ...(settings.nightNoticeMinutes !== undefined ? { [SETTING.nightNotice]: { minutes: settings.nightNoticeMinutes } } : {}),
  };
}

/** 설정 새 판(shop_settings는 장부: 바꿈은 늘 새 판이다). */
export function writeSetting(db: Db, shopId: string, key: string, value: unknown, meta: WriteMeta): void {
  const last = one(db, "SELECT max(version_no) AS v FROM shop_settings WHERE shop_id = ? AND setting_key = ? AND scope_key = ''", shopId, key);
  const at = isoOf(meta.now);
  insert(db, 'shop_settings', {
    shop_id: shopId, setting_key: key, version_no: num(last?.v) + 1, value_json: canonicalJson(value), effective_from: at, created_at: at,
    created_by: meta.actorKey, request_id: meta.requestId, created_rev: meta.rev,
  });
}

function insertDepositRule(db: Db, shopId: string, reg: ShopRegistry, rule: FxDepositRule, active: boolean, effectiveFrom: string, at: string): void {
  const kind = reg.kinds.find((k) => reg.products[k.products[0] ?? '']?.section === rule.section) ?? bad('보증금 규칙의 대상 종류가 없다: ' + rule.section);
  if (rule.methods.length !== 1) bad('보증금 받는 수단은 하나다(칸의 기본 수단): ' + rule.methods.join(','));
  if (!one(db, 'SELECT 1 AS x FROM payment_sections WHERE shop_id = ? AND id = ?', shopId, DEPOSIT_SECTION)) {
    const sort = num(one(db, 'SELECT count(*) AS n FROM payment_sections WHERE shop_id = ?', shopId)?.n);
    insert(db, 'payment_sections', {
      shop_id: shopId, id: DEPOSIT_SECTION, key: DEPOSIT_SECTION, label: rule.label, default_method_id: rule.methods[0], sort, is_system: true, created_at: at, updated_at: at,
    });
  }
  insert(db, 'deposit_rules', {
    shop_id: shopId, id: rule.key, key: rule.key, label: rule.label, item_kind_id: kind.key, unit_amount: rule.unitAmount, timing_key: rule.timing,
    payment_section_id: DEPOSIT_SECTION, refund_default_key: rule.refundDefault, unreturned_key: rule.unreturned, unreturned_after_days: rule.afterDays,
    loss_amount: rule.lossAmount, effective_from: effectiveFrom, active, created_at: at, updated_at: at,
  });
}

/**
 * 매장 목록 값 · 운영 규칙 · 돈통을 모두 쓴다(빈 매장 파일, provision 안에서). 요금표는 초안 판에 규칙을 넣은 뒤 게시한다(게시한 판의
 * 규칙은 바꿀 수 없다: price_rules_frozen_*).
 */
export function writeRegistry(
  db: Db, shopId: string, reg: ShopRegistry, settings: FxShopRules, drawers: readonly FxDrawer[], meta: WriteMeta, effectiveFrom: string,
): void {
  const at = isoOf(meta.now);
  const base = { shop_id: shopId, created_at: at, updated_at: at };

  reg.vehicles.forEach((v) => insert(db, 'vehicles', { ...base, id: v.id, code: v.id, name: v.label, active: !v.ended, retired_at: v.ended ? at : undefined }));
  drawers.forEach((d) => insert(db, 'cash_drawers', { ...base, id: d.id, kind_key: d.kind, label: d.label, vehicle_id: d.vehicleId, closing_scope_id: MAIN_SCOPE }));

  reg.payMethods.forEach((m, i) => insert(db, 'payment_methods', {
    ...base, id: m.key, key: m.key, label: m.label, affects_cash_drawer: m.key === CASH_METHOD, driver_allowed: m.driver, quick: m.quick, sort: i,
    refundable: m.refundable !== false,
  }));
  // 보증금 결제(미수 차감): 돈이 움직이지 않는 시스템 수단. 매장 목록(registry.payMethods)에는 없다.
  insert(db, 'payment_methods', {
    ...base, id: DEPOSIT_METHOD, key: DEPOSIT_METHOD, label: '보증금 결제', affects_cash_drawer: false, quick: false, refundable: false, is_system: true, sort: reg.payMethods.length,
  });
  reg.paySections.forEach((s, i) => {
    insert(db, 'payment_sections', { ...base, id: s.key, key: s.key, label: s.label, default_method_id: s.defaultMethod, sort: i });
    insert(db, 'discount_groups', { ...base, id: s.key, key: s.key, label: s.label, sort: i });
    insert(db, 'discount_group_kinds', { shop_id: shopId, discount_group_id: s.key, discount_kind_key: 'percent' });
  });

  // 종류 · 규격 축 · 상품
  const productOrder = Object.values(reg.products);
  const sectionOfKind = new Map<string, string>();
  reg.kinds.forEach((kind, i) => {
    const products = kindProducts(reg, kind);
    const first = products[0]!;
    for (const p of products) {
      if (p.section !== first.section) bad('종류 ' + kind.key + '의 상품 결제 칸이 다르다');
      if (canonicalJson(p.capabilities) !== canonicalJson(first.capabilities)) bad('종류 ' + kind.key + '의 상품 능력 값이 다르다');
    }
    if (!reg.paySections.some((s) => s.key === first.section)) bad('종류 ' + kind.key + '의 결제 칸이 목록에 없다: ' + first.section);
    for (const cap of first.capabilities) if (cap !== 'exchangeable' && cap !== 'extendable') bad('종류 능력 값은 exchangeable · extendable만 표에 있다: ' + cap);
    const ticket = isTicket(products);
    sectionOfKind.set(kind.key, first.section);
    insert(db, 'item_kinds', {
      ...base, id: kind.key, key: kind.key, label: kind.label, fulfillment_mode_key: ticket ? 'ticket' : 'rental', tracking_key: first.tracking,
      return_policy_key: returnPolicyOf(products, settings), default_price_basis_key: ticket ? 'per_unit' : 'per_day', payment_section_id: first.section,
      discount_group_id: first.section, sized: (kind.variants?.length ?? 0) > 0, exchangeable: first.capabilities.includes('exchangeable'),
      extendable: first.capabilities.includes('extendable'), ends_same_day: ticket, ticketed: ticket, picker_placement_key: kind.placement,
      unit_label: first.countWord, sort: i,
    });
    if (kind.axis !== undefined) {
      insert(db, 'attribute_definitions', {
        ...base, id: axisAttribute(kind.key), entity_type_key: 'item_variant', key: 'axis_' + kind.key, label: kind.axis, data_type_key: 'option', sort: i,
      });
      insert(db, 'item_kind_attributes', { shop_id: shopId, item_kind_id: kind.key, attribute_id: axisAttribute(kind.key), usage_key: 'variant_axis', required: true, sort: 0 });
      (kind.variants ?? []).forEach((v, j) => insert(db, 'attribute_options', {
        shop_id: shopId, id: axisOption(kind.key, v.key), attribute_id: axisAttribute(kind.key), key: v.key, label: v.label, sort: j,
      }));
    } else if (kind.variants?.length) {
      bad('규격 축 이름 없는 규격: ' + kind.key);
    }
  });

  if (productOrder.some((p) => p.includes !== undefined)) {
    insert(db, 'attribute_definitions', { ...base, id: INCLUDES_ATTRIBUTE, entity_type_key: 'catalog_item', key: INCLUDES_ATTRIBUTE, label: '포함', data_type_key: 'text' });
  }
  if (productOrder.some((p) => p.unit !== undefined)) {
    insert(db, 'counterparties', { ...base, id: TICKET_VENDOR, name: '발권처' });
    insert(db, 'counterparty_roles', { shop_id: shopId, counterparty_id: TICKET_VENDOR, role_key: 'resort_vendor' });
  }
  productOrder.forEach((p, i) => {
    const kind = reg.kinds.find((k) => k.key === p.kindKey) ?? bad('상품 ' + p.key + '의 종류가 목록에 없다');
    if (!kind.products.includes(p.key)) bad('상품 ' + p.key + '가 종류 ' + kind.key + '의 상품 목록에 없다');
    insert(db, 'catalog_items', {
      ...base, id: p.key, item_kind_id: p.kindKey, code: p.key, label: p.label, short_label: p.shortLabel, unit_label: p.countWord, tracking_key: p.tracking, sort: i,
    });
    if (p.unit !== undefined && p.unit !== p.countWord) bad('권의 수량 단위와 세는 말이 다르다: ' + p.key);
    if (p.includes !== undefined) {
      insert(db, 'catalog_item_attribute_values', { shop_id: shopId, catalog_item_id: p.key, attribute_id: INCLUDES_ATTRIBUTE, value_text: p.includes, updated_at: at, updated_by: meta.actorKey });
    }
    (kind.variants ?? []).forEach((v, j) => {
      insert(db, 'item_variants', { ...base, id: variantId(p.key, v.key), catalog_item_id: p.key, code: v.key, label: v.name, sort: j });
      insert(db, 'variant_attribute_values', {
        shop_id: shopId, variant_id: variantId(p.key, v.key), attribute_id: axisAttribute(kind.key), option_id: axisOption(kind.key, v.key), updated_at: at, updated_by: meta.actorKey,
      });
    });
    // 수량 상품은 기본 규격 하나(축 값 없음: 목록 되읽기의 규격에 나오지 않는다). 규격 없는 수량 상품(첫 매장의 스키 · 권)의 재고와, 규격 없이
    // 적힌 줄(견본 하루의 의류 · 헬멧 줄)의 이동 줄이 이 규격을 쓴다(수량 이동 줄은 늘 규격을 가진다).
    if (p.tracking === 'count') {
      insert(db, 'item_variants', { ...base, id: defaultVariantId(p.key), catalog_item_id: p.key, label: p.label, sort: kind.variants?.length ?? 0 });
    }
    if (p.unit !== undefined) {
      const slot = p.returnSlotKey === undefined ? undefined : (settings.returnSlots.find((s) => s.key === p.returnSlotKey) ?? bad('권 ' + p.key + '의 반납 타임이 없다: ' + p.returnSlotKey));
      insert(db, 'ticket_products', { shop_id: shopId, catalog_item_id: p.key, vendor_counterparty_id: TICKET_VENDOR, window_end: slot ? slotRow(slot).local_time : undefined });
    } else if (p.returnSlotKey !== undefined) {
      bad('권이 아닌 상품의 반납 타임: ' + p.key);
    }
  });

  // 요금표: 초안 → 규칙 → 게시
  insert(db, 'price_lists', { ...base, id: PRICE_LIST, key: PRICE_LIST, label: '기본', purpose_key: 'sale', is_default: true });
  insert(db, 'price_list_versions', { shop_id: shopId, id: PRICE_VERSION, price_list_id: PRICE_LIST, version_no: 1, status_key: 'draft', effective_from: effectiveFrom, created_at: at, created_by: meta.actorKey });
  for (const p of productOrder) {
    insert(db, 'price_rules', {
      shop_id: shopId, id: priceRuleId(p.key), price_list_version_id: PRICE_VERSION, catalog_item_id: p.key, price_basis_key: p.unit !== undefined ? 'per_unit' : 'per_day', unit_amount: p.price,
    });
  }
  run(db, "UPDATE price_list_versions SET status_key = 'published', published_at = ?, published_by = ? WHERE shop_id = ? AND id = ?", at, meta.actorKey, shopId, PRICE_VERSION);

  // 할인: 규칙 하나가 결제 칸 여럿에 걸리면 첫 칸의 묶음에 두고 대상은 그 칸들의 종류(plan §4-2)
  reg.discounts.forEach((d, i) => insertDiscountRule(db, shopId, reg, d, i, at));

  // 보증금 규칙(있으면)
  const rule = depositRuleOf(settings);
  if (rule) insertDepositRule(db, shopId, reg, rule, settings.liftDeposit !== null, effectiveFrom, at);

  // 구역 · 장소(숙소 구역은 장소마다 쓰임 lodging)
  reg.areas.forEach((a, i) => {
    insert(db, 'areas', { ...base, id: a.id, name: a.label, sort: i, active: !a.hidden });
    if (a.lodging && !a.places.length) bad('장소 없는 숙소 구역은 되읽을 수 없다: ' + a.id);
    a.places.forEach((p, j) => {
      insert(db, 'places', { ...base, id: p.id, area_id: a.id, name: p.label, sort: j, active: !p.hidden });
      if (a.lodging) insert(db, 'place_uses', { shop_id: shopId, place_id: p.id, use_key: 'lodging' });
    });
  });

  settings.returnSlots.forEach((s, i) => {
    if (s.earliest) bad('새 매장의 반납 타임에는 시각을 바꾼 기록이 없다: ' + s.key);
    insert(db, 'return_slots', { ...base, id: s.key, label: s.label, ...slotRow(s), is_night: slotNight(s), sort: i, active: !s.hidden });
  });
  if (settings.defaultReturnSlotKey !== undefined && !settings.returnSlots.some((s) => s.key === settings.defaultReturnSlotKey)) bad('기본 반납 타임이 목록에 없다');

  reg.visitOutcomes.forEach((o, i) => insert(db, 'reason_codes', { shop_id: shopId, id: reasonId(VISIT_RESULT, o.key), domain_key: VISIT_RESULT, key: o.key, label: o.label, sort: i }));
  for (const domain of [CLOSING_DIFFERENCE, HANDOVER]) {
    reg.cashReasons.forEach((r, i) => insert(db, 'reason_codes', { shop_id: shopId, id: reasonId(domain, r.key), domain_key: domain, key: r.key, label: r.label, requires_memo: r.key === 'manual', sort: i }));
  }
  insert(db, 'adjustment_types', { ...base, id: EXTENSION, key: EXTENSION, label: '연장', report_group_key: 'charge', sign: 1, is_system: true, sort: 1 });
  insert(db, 'adjustment_types', { ...base, id: EXTENSION_UNDO, key: EXTENSION_UNDO, label: '연장 취소', report_group_key: 'charge', sign: -1, is_system: true, sort: 2 });
  insertDiscountChangeType(db, shopId, at);
  ensureCancellationKinds(db, shopId, at);
  insert(db, 'asset_conditions', { shop_id: shopId, id: OK_CONDITION, key: OK_CONDITION, label: '사용 가능', issuable: true, settable_manually: false, is_system: true, sort: 0 });

  for (const [key, value] of Object.entries(settingValues(reg, settings))) writeSetting(db, shopId, key, value, meta);
}

/** 바뀐 목록 행 한 줄의 기록(config_changes). */
export interface ConfigChange {
  entity: string;
  id: string;
  before: unknown;
  after: unknown;
  at?: number;
}

/**
 * 한 명령의 설정 쓰기를 끝낸다(features-1 E25): 바뀐 것이 있으면 shops.config_rev를 한 번만 올리고 바뀐 행마다 config_changes 한 줄. 새 값을
 * 돌려준다(바뀐 것이 없으면 지금 값).
 */
export function finishConfig(db: Db, shopId: string, changes: readonly ConfigChange[], versioned: boolean, meta: WriteMeta): { configRev: number } {
  const current = num(one(db, 'SELECT config_rev FROM shops WHERE id = ?', shopId)?.config_rev);
  if (!changes.length && !versioned) return { configRev: current };
  const at = isoOf(meta.now);
  const configRev = current + 1;
  run(db, 'UPDATE shops SET config_rev = ?, updated_at = ?, updated_rev = ? WHERE id = ?', configRev, at, meta.rev, shopId);
  changes.forEach((c, i) => insert(db, 'config_changes', {
    shop_id: shopId, config_rev: configRev, seq: i + 1, entity_type: c.entity, entity_id: c.id,
    before_json: c.before === null ? null : canonicalJson(c.before), after_json: canonicalJson(c.after), actor_key: meta.actorKey, request_id: meta.requestId,
    at: c.at !== undefined ? isoOf(c.at) : at,
  }));
  return { configRev };
}

/**
 * 운영 규칙 저장(setting.set)의 쓰기: 전 · 후 운영 규칙을 비교해 바뀐 곳만 쓴다. 리프트권 반납(item_kinds.return_policy_key) ·
 * 보증금 규칙(deposit_rules · 보증금 칸의 기본 수단) · 영업일 기준 시각(shops, 바꾼 때 = 도메인이 적은 until)은 목록 행 제자리 수정 +
 * config_changes, 선입금 · 당일 취소 환불 · 그 밖의 설정은 shop_settings 새 판이다. 옮기지 못하는 바뀜이 남으면 UNMAPPED_CHANGE.
 * 바뀐 것이 있으면 shops.config_rev를 하나 올리고 새 값을 돌려준다.
 */
export function writeSettingsChange(
  db: Db, shopId: string, reg: ShopRegistry, before: FxShopRules, after: FxShopRules, meta: WriteMeta,
): { configRev: number } {
  const { changes, versioned } = settingsRows(db, shopId, reg, before, after, meta);
  return finishConfig(db, shopId, changes, versioned, meta);
}

/**
 * 운영 규칙의 바뀐 행만 쓴다(config_rev는 올리지 않음: 명령마다 finishConfig가 한 번). 바뀐 목록 행(config_changes에 적을 것)과 설정 새 판이
 * 있었는지를 돌려준다.
 */
export function settingsRows(
  db: Db, shopId: string, reg: ShopRegistry, before: FxShopRules, after: FxShopRules, meta: WriteMeta,
): { changes: ConfigChange[]; versioned: boolean } {
  const at = isoOf(meta.now);
  const changes: ConfigChange[] = [];
  const handled = new Set<keyof FxShopRules>();
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

  handled.add('liftReturnPolicy');
  if (before.liftReturnPolicy !== after.liftReturnPolicy) {
    const kinds = reg.kinds.filter((k) => reg.products[k.products[0] ?? '']?.section === 'lift');
    for (const k of kinds) {
      run(db, 'UPDATE item_kinds SET return_policy_key = ?, updated_at = ?, updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?', after.liftReturnPolicy, at, meta.rev, shopId, k.key);
      changes.push({ entity: 'item_kinds', id: k.key, before: { return_policy_key: before.liftReturnPolicy }, after: { return_policy_key: after.liftReturnPolicy } });
    }
  }

  handled.add('liftDeposit');
  handled.add('liftDepositOff');
  const ruleBefore = depositRuleOf(before);
  const ruleAfter = depositRuleOf(after);
  const activeBefore = before.liftDeposit != null;
  const activeAfter = after.liftDeposit != null;
  if (!same(ruleBefore, ruleAfter) || activeBefore !== activeAfter) {
    if (!ruleAfter) throw new StoreError('UNMAPPED_CHANGE', '보증금 규칙을 지우는 바뀜은 표에 없다(미사용은 active = 0)');
    const row = one(db, 'SELECT id FROM deposit_rules WHERE shop_id = ? AND id = ?', shopId, ruleAfter.key);
    if (!row) {
      insertDepositRule(db, shopId, reg, ruleAfter, activeAfter, at.slice(0, 10), at);
      changes.push({ entity: 'deposit_rules', id: ruleAfter.key, before: null, after: { ...ruleAfter, active: activeAfter } });
    } else {
      if (ruleBefore && ruleBefore.key !== ruleAfter.key) throw new StoreError('UNMAPPED_CHANGE', '보증금 규칙 key 바꾸기');
      if (ruleAfter.methods.length !== 1) bad('보증금 받는 수단은 하나다');
      run(db, `UPDATE deposit_rules SET label = ?, unit_amount = ?, timing_key = ?, refund_default_key = ?, unreturned_key = ?, unreturned_after_days = ?, loss_amount = ?,
        active = ?, updated_at = ?, updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?`,
      ruleAfter.label, ruleAfter.unitAmount, ruleAfter.timing, ruleAfter.refundDefault, ruleAfter.unreturned, ruleAfter.afterDays, ruleAfter.lossAmount,
      activeAfter, at, meta.rev, shopId, ruleAfter.key);
      if (!same(ruleBefore?.methods, ruleAfter.methods)) {
        run(db, 'UPDATE payment_sections SET default_method_id = ?, updated_at = ?, updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?', ruleAfter.methods[0], at, meta.rev, shopId, DEPOSIT_SECTION);
      }
      changes.push({ entity: 'deposit_rules', id: ruleAfter.key, before: { ...ruleBefore, active: activeBefore }, after: { ...ruleAfter, active: activeAfter } });
    }
  }

  handled.add('businessDayCutoff');
  handled.add('cutoffBefore');
  const oldHistory = before.cutoffBefore ?? [];
  const newHistory = after.cutoffBefore ?? [];
  if (before.businessDayCutoff !== after.businessDayCutoff || !same(oldHistory, newHistory)) {
    if (!same(newHistory.slice(0, oldHistory.length), oldHistory) || newHistory.length !== oldHistory.length + 1 || newHistory.at(-1)?.cutoff !== before.businessDayCutoff) {
      throw new StoreError('UNMAPPED_CHANGE', '기준 시각 기록은 끝에 하나씩만 더한다');
    }
    run(db, 'UPDATE shops SET business_day_cutoff = ?, updated_at = ?, updated_rev = ?, version = version + 1 WHERE id = ?', after.businessDayCutoff, at, meta.rev, shopId);
    changes.push({ entity: 'shops', id: shopId, before: { business_day_cutoff: before.businessDayCutoff }, after: { business_day_cutoff: after.businessDayCutoff }, at: newHistory.at(-1)!.until });
  }

  handled.add('returnSlots');
  if (!same(before.returnSlots, after.returnSlots)) {
    // 반납 타임은 지우지 않는다(숨김 = active 0). 행마다 바뀐 칸만 고치고 config_changes 한 줄: 앞 값의 시각이 `가장 이른 시각`(earliest)의
    // 근거다(registry-read slotEarliest). 야간 여부(is_night)는 더할 때만 적는다(features-1 E12).
    const kept = new Set(after.returnSlots.map((s) => s.key));
    if (before.returnSlots.some((s) => !kept.has(s.key))) throw new StoreError('UNMAPPED_CHANGE', '반납 타임을 지우는 바뀜은 표에 없다(숨김은 active 0)');
    const rowOf = (s: FxReturnSlot, i: number) => ({ label: s.label, ...slotRow(s), sort: i, active: s.hidden ? 0 : 1 });
    after.returnSlots.forEach((s, i) => {
      const was = before.returnSlots.find((x) => x.key === s.key);
      const row = rowOf(s, i);
      if (!was) {
        insert(db, 'return_slots', { shop_id: shopId, id: s.key, ...row, is_night: slotNight(s), created_at: at, updated_at: at, updated_rev: meta.rev });
        changes.push({ entity: 'return_slots', id: s.key, before: null, after: { ...row, is_night: slotNight(s) ? 1 : 0 } });
        return;
      }
      if (slotNight(was) !== slotNight(s)) throw new StoreError('UNMAPPED_CHANGE', '반납 타임의 야간 여부 바꾸기: ' + s.key);
      const old = rowOf(was, before.returnSlots.indexOf(was));
      if (same(old, row)) return;
      run(db, `UPDATE return_slots SET label = ?, local_time = ?, day_offset = ?, sort = ?, active = ?, updated_at = ?, updated_rev = ?, version = version + 1
        WHERE shop_id = ? AND id = ?`, row.label, row.local_time, row.day_offset, row.sort, row.active, at, meta.rev, shopId, s.key);
      changes.push({ entity: 'return_slots', id: s.key, before: old, after: row });
      // 그 타임에 끝나는 권종의 사용 창 끝(ticket_products.window_end)도 새 시각으로(권의 반납 시각 처음 값이 타임을 따라가게).
      if (old.local_time !== row.local_time) {
        for (const p of Object.values(reg.products)) {
          if (p.returnSlotKey === s.key) run(db, 'UPDATE ticket_products SET window_end = ? WHERE shop_id = ? AND catalog_item_id = ?', row.local_time, shopId, p.key);
        }
      }
    });
  }

  // 설정 새 판(값이 바뀐 key만)
  for (const k of ['prepaymentMode', 'prepaymentAmount', 'sameDayCancelRefund', 'driverSeesDue', 'openingCash', 'defaultReturnSlotKey', 'vehicleLate', 'nightNoticeMinutes'] as const) handled.add(k);
  const valuesBefore = settingValues(reg, before);
  const valuesAfter = settingValues(reg, after);
  // 있던 설정을 지우는 바뀜은 표에 없다(설정은 새 판만 쌓는다).
  const dropped = Object.keys(valuesBefore).filter((key) => !(key in valuesAfter));
  if (dropped.length) throw new StoreError('UNMAPPED_CHANGE', '설정을 지우는 바뀜: ' + dropped.join(', '));
  for (const [key, value] of Object.entries(valuesAfter)) {
    if (!same(valuesBefore[key], value)) writeSetting(db, shopId, key, value, meta);
  }

  const left = (Object.keys({ ...before, ...after }) as (keyof FxShopRules)[]).filter((k) => !handled.has(k) && !same(before[k], after[k]));
  if (left.length) throw new StoreError('UNMAPPED_CHANGE', '표로 옮기지 못한 운영 규칙: ' + left.join(', '));

  const versioned = Object.keys(valuesAfter).some((key) => !same(valuesBefore[key], valuesAfter[key]));
  return { changes, versioned };
}

/**
 * 역할의 직접 입력 할인 한도(role_permissions.limits_json of discount.manual)를 적는다. 쓰기 트랜잭션은 부르는 쪽(shop-store). 설정 값이라 장부 표가
 * 아니다(바꿔 쓴다). 그 역할에 discount.manual이 없으면 false.
 */
export function setRoleLimits(db: Db, shopId: string, roleKey: string, limits: { maxDiscountAmount?: number; maxDiscountPercentBp?: number } | null): boolean {
  const json = limits && (limits.maxDiscountAmount !== undefined || limits.maxDiscountPercentBp !== undefined)
    ? JSON.stringify({
      ...(limits.maxDiscountAmount !== undefined ? { max_discount_amount: limits.maxDiscountAmount } : {}),
      ...(limits.maxDiscountPercentBp !== undefined ? { max_discount_percent_bp: limits.maxDiscountPercentBp } : {}),
    })
    : null;
  const row = one(db, `SELECT p.role_id FROM role_permissions p JOIN roles r ON r.shop_id = p.shop_id AND r.id = p.role_id
    WHERE p.shop_id = ? AND r.key = ? AND p.permission_key = 'discount.manual'`, shopId, roleKey);
  if (!row) return false;
  run(db, "UPDATE role_permissions SET limits_json = ? WHERE shop_id = ? AND role_id = ? AND permission_key = 'discount.manual'", json, shopId, str(row.role_id));
  return true;
}

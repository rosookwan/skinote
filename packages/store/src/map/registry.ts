// 매장 목록 값 · 돈통 · 직원의 바뀜 → 표(features-1 plan §4-2 · E12 · E13 · E25). 운영 규칙(settings)의 바뀜은 registry-write의 settingsRows,
// 여기는 목록 바꿈(registry.update) · 직원 바꿈(staff.set)이 고치는 행이다: 매장 이름 · 전화(shops), 구역 · 장소(areas · places · place_uses),
// 1일 값(새 요금표 판: 게시한 판은 고칠 수 없다), 할인(discount_rules · 대상), 차량(vehicles · 재고 위치 · 지갑 돈통), 직원(staff_members ·
// vehicle_assignments). 목록 행은 지우지 않는다(숨김 · 사용 종료 = active 0 · status suspended). 행마다 config_changes 한 줄이고 config_rev는 명령마다
// 한 번(finishConfig). 표로 옮길 수 없는 바뀜(종류 · 수단 · 칸 · 사유 · 행 지우기 · 차례 바꾸기 …)은 UNMAPPED_CHANGE.
import type { FxArea, FxDiscount, FxDrawer, FxStaff, ShopRegistry } from '@skinote/domain';
import { canonicalJson, isoOf } from '../ids.ts';
import { all, insert, num, one, run, str } from '../db.ts';
import { finishConfig, insertDiscountRule, settingsRows, type ConfigChange } from '../registry-write.ts';
import { MAIN_SCOPE, PRICE_LIST, vehicleLocation } from '../registry-keys.ts';
import { businessDateOfCtx, unmapped, type WriteContext } from './common.ts';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** 목록 값 가운데 이 판에서 고칠 수 없는 칸(바뀌면 UNMAPPED_CHANGE). */
const FIXED_KEYS: readonly (keyof ShopRegistry)[] = ['timezone', 'kinds', 'payMethods', 'paySections', 'visitOutcomes', 'cashReasons', 'maxLineQuantity'];

/**
 * 새 직원의 control 계정 id(비밀번호 재발급이 처음 부를 때 control에 만든다, E15). 매장 id를 앞에 붙인다: 직원 id는 창이 보낸 요청번호 · ref에서
 * 오므로(`<요청번호>:<ref>`), 다른 매장의 같은 id가 같은 계정을 가리키지 않게(2026-09-27 점검, 매장 경계).
 */
export const staffAccountId = (shopId: string, staffId: string) => 'acct:' + shopId + ':' + staffId;

/**
 * 명령 하나의 설정 쓰기(write.ts가 부른다): 운영 규칙 · 목록 값 · 돈통 · 직원을 옮기고 config_rev를 한 번 올린다. 바뀐 것이 없으면 아무것도 쓰지
 * 않는다.
 */
export function writeConfig(ctx: WriteContext): void {
  const { before, after, db, shopId } = ctx;
  const meta = { now: ctx.now, actorKey: ctx.actor.key, requestId: ctx.requestId, rev: ctx.rev };
  const changes: ConfigChange[] = [];
  let versioned = false;
  if (!same(before.settings, after.settings)) {
    const out = settingsRows(db, shopId, after.registry, before.settings, after.settings, meta);
    changes.push(...out.changes);
    versioned = out.versioned;
  }
  if (!same(before.registry, after.registry)) registryRows(ctx, changes);
  if (!same(before.drawers, after.drawers)) drawerRows(ctx, changes);
  if (!same(before.staff ?? [], after.staff ?? [])) staffRows(ctx, changes);
  if (!changes.length && !versioned) return;
  finishConfig(db, shopId, changes, versioned, meta);
  ctx.touched.push({ scope: 'store', entityType: 'shops', entityId: shopId, aggregateType: 'shop', aggregateId: shopId });
}

// ── 목록 값 ──────────────────────────────────────────────────────────

function registryRows(ctx: WriteContext, changes: ConfigChange[]): void {
  const b = ctx.before.registry;
  const a = ctx.after.registry;
  for (const key of FIXED_KEYS) if (!same(b[key], a[key])) unmapped('이 판에서 고칠 수 없는 목록 값: ' + key);
  shopRows(ctx, b, a, changes);
  areaRows(ctx, b.areas, a.areas, changes);
  priceRows(ctx, b, a, changes);
  discountRows(ctx, b.discounts, a.discounts, changes);
  vehicleRows(ctx, b, a, changes);
}

function shopRows(ctx: WriteContext, b: ShopRegistry, a: ShopRegistry, changes: ConfigChange[]): void {
  if (b.shopName === a.shopName && (b.shopPhone ?? null) === (a.shopPhone ?? null)) return;
  run(ctx.db, 'UPDATE shops SET name = ?, phone = ?, updated_at = ?, updated_rev = ?, version = version + 1 WHERE id = ?',
    a.shopName, a.shopPhone ?? null, isoOf(ctx.now), ctx.rev, ctx.shopId);
  changes.push({ entity: 'shops', id: ctx.shopId, before: { name: b.shopName, phone: b.shopPhone ?? null }, after: { name: a.shopName, phone: a.shopPhone ?? null } });
}

/** 한 목록의 차례(sort)가 앞 행 차례 그대로인지: 지운 행은 없어야 한다. */
function keepRows<T extends { id: string }>(before: readonly T[], after: readonly T[], what: string): void {
  const ids = new Set(after.map((x) => x.id));
  if (before.some((x) => !ids.has(x.id))) unmapped(what + '을(를) 지우는 바뀜은 표에 없다(숨김은 active 0)');
}

function areaRows(ctx: WriteContext, before: readonly FxArea[], after: readonly FxArea[], changes: ConfigChange[]): void {
  const at = isoOf(ctx.now);
  keepRows(before, after, '구역');
  after.forEach((area, i) => {
    const was = before.find((x) => x.id === area.id);
    const row = { name: area.label, sort: i, active: area.hidden ? 0 : 1 };
    if (!was) {
      if (area.lodging) unmapped('장소 없는 숙소 구역은 더할 수 없다: ' + area.id);
      insert(ctx.db, 'areas', { shop_id: ctx.shopId, id: area.id, ...row, created_at: at, updated_at: at, updated_rev: ctx.rev });
      changes.push({ entity: 'areas', id: area.id, before: null, after: row });
    } else {
      const old = { name: was.label, sort: before.indexOf(was), active: was.hidden ? 0 : 1 };
      if (!same(old, row)) {
        run(ctx.db, 'UPDATE areas SET name = ?, sort = ?, active = ?, updated_at = ?, updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?',
          row.name, row.sort, row.active, at, ctx.rev, ctx.shopId, area.id);
        changes.push({ entity: 'areas', id: area.id, before: old, after: row });
      }
      if (was.lodging !== area.lodging && was.places.length > 0) unmapped('숙소 구역 바꾸기: ' + area.id);
    }
    placeRows(ctx, area, was, changes);
  });
}

function placeRows(ctx: WriteContext, area: FxArea, was: FxArea | undefined, changes: ConfigChange[]): void {
  const at = isoOf(ctx.now);
  const before = was?.places ?? [];
  keepRows(before, area.places, '장소');
  area.places.forEach((p, i) => {
    const old = before.find((x) => x.id === p.id);
    const row = { area_id: area.id, name: p.label, sort: i, active: p.hidden ? 0 : 1 };
    if (!old) {
      // 다른 구역에 있던 장소를 옮기는 바뀜은 표에 없다.
      if (one(ctx.db, 'SELECT 1 AS x FROM places WHERE shop_id = ? AND id = ?', ctx.shopId, p.id)) unmapped('장소를 다른 구역으로 옮기기: ' + p.id);
      insert(ctx.db, 'places', { shop_id: ctx.shopId, id: p.id, ...row, created_at: at, updated_at: at, updated_rev: ctx.rev });
      // 숙소 구역의 장소는 쓰임 lodging(되읽기가 구역의 숙소 여부를 장소의 쓰임으로 안다).
      if (area.lodging) insert(ctx.db, 'place_uses', { shop_id: ctx.shopId, place_id: p.id, use_key: 'lodging' });
      changes.push({ entity: 'places', id: p.id, before: null, after: row });
      return;
    }
    const oldRow = { area_id: area.id, name: old.label, sort: before.indexOf(old), active: old.hidden ? 0 : 1 };
    if (same(oldRow, row)) return;
    run(ctx.db, 'UPDATE places SET name = ?, sort = ?, active = ?, updated_at = ?, updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?',
      row.name, row.sort, row.active, at, ctx.rev, ctx.shopId, p.id);
    changes.push({ entity: 'places', id: p.id, before: oldRow, after: row });
  });
}

/**
 * 1일 값: 게시한 요금표 판은 고칠 수 없어(price_rules_frozen_*) 새 판을 만든다 — 초안 판에 모든 상품의 값을 옮기고 게시, 옛 판은 retired ·
 * effective_to = 오늘(features-1 E12). 되읽기는 게시한 판만 본다.
 */
function priceRows(ctx: WriteContext, b: ShopRegistry, a: ShopRegistry, changes: ConfigChange[]): void {
  const keys = Object.keys(a.products);
  if (!same(Object.keys(b.products), keys)) unmapped('상품을 더하거나 빼는 바뀜');
  const changed = keys.filter((k) => {
    const x = b.products[k]!;
    const y = a.products[k]!;
    if (!same({ ...x, price: 0 }, { ...y, price: 0 })) unmapped('상품의 값 밖의 칸 바꾸기: ' + k);
    return x.price !== y.price;
  });
  if (!changed.length) return;
  const db = ctx.db;
  const at = isoOf(ctx.now);
  const today = businessDateOfCtx(ctx, ctx.now);
  const current = one(db, `SELECT id, version_no, effective_from FROM price_list_versions WHERE shop_id = ? AND price_list_id = ? AND status_key = 'published'
    ORDER BY version_no DESC LIMIT 1`, ctx.shopId, PRICE_LIST);
  const versionNo = num(one(db, 'SELECT max(version_no) AS v FROM price_list_versions WHERE shop_id = ? AND price_list_id = ?', ctx.shopId, PRICE_LIST)?.v) + 1;
  const id = PRICE_LIST + ':' + versionNo;
  const from = current && str(current.effective_from) > today ? str(current.effective_from) : today;
  insert(db, 'price_list_versions', {
    shop_id: ctx.shopId, id, price_list_id: PRICE_LIST, version_no: versionNo, status_key: 'draft', effective_from: from, created_at: at, created_by: ctx.actor.key,
  });
  for (const p of Object.values(a.products)) {
    insert(db, 'price_rules', {
      shop_id: ctx.shopId, id: id + ':' + p.key, price_list_version_id: id, catalog_item_id: p.key, price_basis_key: p.unit !== undefined ? 'per_unit' : 'per_day', unit_amount: p.price,
    });
  }
  run(db, "UPDATE price_list_versions SET status_key = 'published', published_at = ?, published_by = ? WHERE shop_id = ? AND id = ?", at, ctx.actor.key, ctx.shopId, id);
  for (const r of all(db, "SELECT id, effective_from FROM price_list_versions WHERE shop_id = ? AND price_list_id = ? AND status_key = 'published' AND id <> ?", ctx.shopId, PRICE_LIST, id)) {
    run(db, "UPDATE price_list_versions SET status_key = 'retired', effective_to = ? WHERE shop_id = ? AND id = ?", str(r.effective_from) > from ? str(r.effective_from) : from, ctx.shopId, str(r.id));
  }
  for (const k of changed) changes.push({ entity: 'price_rules', id: k, before: { unit_amount: b.products[k]!.price }, after: { unit_amount: a.products[k]!.price, price_list_version_id: id } });
}

function discountRows(ctx: WriteContext, before: readonly FxDiscount[], after: readonly FxDiscount[], changes: ConfigChange[]): void {
  const at = isoOf(ctx.now);
  const ids = new Set(after.map((d) => d.key));
  if (before.some((d) => !ids.has(d.key))) unmapped('할인을 지우는 바뀜은 표에 없다(미사용은 active 0)');
  after.forEach((d, i) => {
    const was = before.find((x) => x.key === d.key);
    if (!was) {
      insertDiscountRule(ctx.db, ctx.shopId, ctx.after.registry, d, i, at, ctx.rev);
      changes.push({ entity: 'discount_rules', id: d.key, before: null, after: d });
      return;
    }
    if (was.kind !== d.kind || !same(was.sections, d.sections)) unmapped('할인의 종류 · 대상 바꾸기(미사용 + 새 할인): ' + d.key);
    if (before.indexOf(was) !== i) unmapped('할인의 차례 바꾸기: ' + d.key);
    if (same(was, d)) return;
    run(ctx.db, `UPDATE discount_rules SET label = ?, percent_bp = ?, amount = ?, active = ?, updated_at = ?, updated_rev = ?, version = version + 1
      WHERE shop_id = ? AND id = ?`, d.label, d.kind === 'percent' ? Math.round(d.value * 100) : null, d.kind === 'amount' ? d.value : null, d.hidden ? 0 : 1,
    at, ctx.rev, ctx.shopId, d.key);
    changes.push({ entity: 'discount_rules', id: d.key, before: was, after: d });
  });
}

function vehicleRows(ctx: WriteContext, b: ShopRegistry, a: ShopRegistry, changes: ConfigChange[]): void {
  const at = isoOf(ctx.now);
  if (a.vehicles.length < b.vehicles.length || b.vehicles.some((v, i) => a.vehicles[i]?.id !== v.id)) unmapped('차량을 지우거나 차례를 바꾸는 바뀜');
  a.vehicles.forEach((v, i) => {
    const was = b.vehicles[i];
    if (!was) {
      insert(ctx.db, 'vehicles', {
        shop_id: ctx.shopId, id: v.id, name: v.label, active: !v.ended, retired_at: v.ended ? at : undefined, created_at: at, updated_at: at, updated_rev: ctx.rev,
      });
      // 차량 재고 위치(수거 · 적재 · 매장 입고의 이동이 쓴다).
      if (!one(ctx.db, 'SELECT 1 AS x FROM stock_locations WHERE shop_id = ? AND id = ?', ctx.shopId, vehicleLocation(v.id))) {
        insert(ctx.db, 'stock_locations', { shop_id: ctx.shopId, id: vehicleLocation(v.id), kind_key: 'vehicle', label: v.label, vehicle_id: v.id, created_at: at });
      }
      changes.push({ entity: 'vehicles', id: v.id, before: null, after: { name: v.label, active: v.ended ? 0 : 1 } });
      return;
    }
    if (same(was, v)) return;
    run(ctx.db, `UPDATE vehicles SET name = ?, active = ?, retired_at = ?, updated_at = ?, updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?`,
      v.label, v.ended ? 0 : 1, v.ended ? at : null, at, ctx.rev, ctx.shopId, v.id);
    changes.push({ entity: 'vehicles', id: v.id, before: { name: was.label, active: was.ended ? 0 : 1 }, after: { name: v.label, active: v.ended ? 0 : 1 } });
  });
}

// ── 돈통(차량 지갑) ─────────────────────────────────────────────────────

/** 차량을 더하면 지갑 돈통이 붙고, 차량 이름을 바꾸면 지갑 이름도(마감의 `3호 차량 현금`). 그 밖의 바뀜은 없다. */
function drawerRows(ctx: WriteContext, changes: ConfigChange[]): void {
  const b = ctx.before.drawers;
  const a = ctx.after.drawers;
  const at = isoOf(ctx.now);
  if (a.length < b.length || b.some((d, i) => a[i]?.id !== d.id)) unmapped('돈통을 지우거나 차례를 바꾸는 바뀜');
  a.forEach((d: FxDrawer, i) => {
    const was = b[i];
    if (!was) {
      if (d.kind !== 'vehicle' || !d.vehicleId) unmapped('차량 지갑 밖의 새 돈통: ' + d.id);
      insert(ctx.db, 'cash_drawers', {
        shop_id: ctx.shopId, id: d.id, kind_key: d.kind, label: d.label, vehicle_id: d.vehicleId, closing_scope_id: MAIN_SCOPE, created_at: at, updated_at: at, updated_rev: ctx.rev,
      });
      changes.push({ entity: 'cash_drawers', id: d.id, before: null, after: { label: d.label, vehicle_id: d.vehicleId } });
      return;
    }
    if (same(was, d)) return;
    if (!same({ ...was, label: '' }, { ...d, label: '' })) unmapped('돈통의 이름 밖의 칸 바꾸기: ' + d.id);
    run(ctx.db, 'UPDATE cash_drawers SET label = ?, updated_at = ?, updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?', d.label, at, ctx.rev, ctx.shopId, d.id);
    changes.push({ entity: 'cash_drawers', id: d.id, before: { label: was.label }, after: { label: d.label } });
  });
}

// ── 직원 ────────────────────────────────────────────────────────────

/**
 * 직원: 새 사람은 staff_members(계정 id는 비밀번호 재발급이 control에 만들 것으로 미리 정함, 역할, active)와 차량 배정, 역할 · 상태는 행을 고치고
 * (사용 종료 = suspended), 차량이 바뀌면 열린 배정을 끝내고(valid_to 오늘 · ended_at 지금) 새 배정을 연다. default_vehicle_id는 쓰지 않는다
 * (옛 행의 읽기 대신 값, E13).
 */
function staffRows(ctx: WriteContext, changes: ConfigChange[]): void {
  const before = ctx.before.staff ?? [];
  const after = ctx.after.staff ?? [];
  const db = ctx.db;
  const at = isoOf(ctx.now);
  const today = businessDateOfCtx(ctx, ctx.now);
  if (after.length < before.length || before.some((s, i) => after[i]?.id !== s.id)) unmapped('직원을 지우거나 차례를 바꾸는 바뀜');
  const openAssignment = (s: FxStaff) => {
    run(db, `UPDATE vehicle_assignments SET valid_to = CASE WHEN valid_from > ? THEN valid_from ELSE ? END, ended_at = ?
      WHERE shop_id = ? AND staff_member_id = ? AND ended_at IS NULL`, today, today, at, ctx.shopId, s.id);
    if (s.vehicleId) {
      insert(db, 'vehicle_assignments', {
        shop_id: ctx.shopId, id: ctx.requestId + ':va:' + s.id, vehicle_id: s.vehicleId, staff_member_id: s.id, valid_from: today, created_at: at, created_by: ctx.actor.key,
      });
    }
  };
  after.forEach((s, i) => {
    const was = before[i];
    const row = { display_name: s.name, role_id: s.roleKey, status_key: s.status };
    if (!was) {
      insert(db, 'staff_members', {
        shop_id: ctx.shopId, id: s.id, account_id: staffAccountId(ctx.shopId, s.id), ...row, created_at: at, updated_at: at, updated_rev: ctx.rev,
      });
      if (s.vehicleId) openAssignment(s);
      changes.push({ entity: 'staff_members', id: s.id, before: null, after: { role_id: s.roleKey, status_key: s.status, vehicle_id: s.vehicleId ?? null } });
      return;
    }
    if (same(was, s)) return;
    if (was.name !== s.name) unmapped('직원 이름 바꾸기');
    const old = { role_id: was.roleKey, status_key: was.status, vehicle_id: was.vehicleId ?? null };
    const now = { role_id: s.roleKey, status_key: s.status, vehicle_id: s.vehicleId ?? null };
    if (was.roleKey !== s.roleKey || was.status !== s.status) {
      run(db, 'UPDATE staff_members SET role_id = ?, status_key = ?, updated_at = ?, updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?',
        s.roleKey, s.status, at, ctx.rev, ctx.shopId, s.id);
    }
    if (was.vehicleId !== s.vehicleId) openAssignment(s);
    // 이름은 개인 정보라 config_changes에 싣지 않는다(명령 기록의 event_pii에만).
    changes.push({ entity: 'staff_members', id: s.id, before: old, after: now });
  });
}


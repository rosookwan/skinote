// 매장 만들기(plan §4-6): 빈 매장 파일(shops가 빔)에 명세(ShopSpec)를 한 트랜잭션으로 쓴다 — 매장 · epoch · 마감 범위, 역할과 권한,
// 차량 · 직원 · 차량 배정 · 돈통, 매장 목록 값 · 요금표 · 운영 규칙(registry-write), rev · 기기 번호 셈, 재고 위치 · 실물 · 기초 재고
// 이동 · 수량 재고. control 파일의 계정(tenants · accounts)은 control 저장소가 같은 명령줄 실행에서 따로 쓴다(control/).
// 매장은 한 번만 만든다: 두 번째 만들기는 거절한다(장부는 지우지 않으니 새로 시작하려면 새 매장 id).
import { assetId, businessDateOf, kstAt, type ShopSpec } from '@skinote/domain';
import { StoreError } from './errors.ts';
import { addDays, isoOf, ulid } from './ids.ts';
import { all, insert, num, one, str, type Db } from './db.ts';
import { ensureBusinessDay } from './dates.ts';
import { writeRegistry } from './registry-write.ts';
import {
  COUNTER_EXCLUDED, DRIVER_PERMISSIONS, EXTERNAL_LOCATION, MAIN_SCOPE, OK_CONDITION, ROLES, SHOP_LOCATION, SYSTEM_ACTOR, TICKET_VENDOR, variantId, vehicleLocation,
} from './registry-keys.ts';
import type { StaffRow } from './registry-read.ts';

export interface ProvisionOptions {
  /** 시험 매장(shops.is_test): 견본 불러오기(load-sample)는 시험 매장에만 된다. */
  isTest: boolean;
  /** 직원마다 control 계정 id(명세의 직원 차례). 없으면 계정 없이 만든다(시험). */
  accountIds?: readonly (string | undefined)[];
}

export interface ProvisionResult {
  epoch: string;
  businessDate: string;
  staff: StaffRow[];
}

/** 쓰는 트랜잭션 하나(BEGIN IMMEDIATE ~ COMMIT). 실패하면 되돌리고 다시 던진다. */
export function inWriteTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 이미 끝난 트랜잭션
    }
    throw error;
  }
}

/** 역할마다 권한과 범위(권한이 허락하는 범위 중: 매장 역할은 shop, 기사는 own_vehicle). */
function grants(db: Db): Map<string, { key: string; scope: string }[]> {
  const perms = all(db, 'SELECT key, scopes_json FROM sys_permissions ORDER BY key').map((r) => ({ key: str(r.key), scopes: JSON.parse(str(r.scopes_json)) as string[] }));
  const pick = (scopes: string[], want: string) => (scopes.includes(want) ? want : scopes[0] ?? 'shop');
  const known = new Set(perms.map((p) => p.key));
  for (const key of [...COUNTER_EXCLUDED, ...DRIVER_PERMISSIONS]) if (!known.has(key)) throw new StoreError('BAD_SPEC', '모르는 권한: ' + key);
  return new Map([
    ['manager', perms.map((p) => ({ key: p.key, scope: pick(p.scopes, 'shop') }))],
    ['counter', perms.filter((p) => !COUNTER_EXCLUDED.includes(p.key)).map((p) => ({ key: p.key, scope: pick(p.scopes, 'shop') }))],
    ['driver', perms.filter((p) => DRIVER_PERMISSIONS.includes(p.key)).map((p) => ({ key: p.key, scope: pick(p.scopes, 'own_vehicle') }))],
  ]);
}

/** 명세가 표로 옮겨지는지 먼저 본다(쓰다가 멈추지 않게). */
function checkSpec(spec: ShopSpec): void {
  if (spec.shop.timezone !== 'Asia/Seoul' || spec.registry.timezone !== 'Asia/Seoul') throw new StoreError('TIMEZONE_UNSUPPORTED', '매장 시간대는 Asia/Seoul만(D13)');
  if (spec.shop.cutoff !== spec.settings.businessDayCutoff) throw new StoreError('BAD_SPEC', '매장 기준 시각과 운영 규칙의 기준 시각이 다르다');
  if (spec.settings.cutoffBefore?.length) throw new StoreError('BAD_SPEC', '새 매장에는 기준 시각을 바꾼 기록이 없다');
  if (spec.shop.name !== spec.registry.shopName) throw new StoreError('BAD_SPEC', '매장 이름이 둘이다');
  const vehicles = new Set(spec.registry.vehicles.map((v) => v.id));
  for (const s of spec.staff) {
    if (s.role === 'driver' && (!s.vehicleKey || !vehicles.has(s.vehicleKey))) throw new StoreError('BAD_SPEC', '기사의 차량이 없다: ' + s.name);
    if (s.role !== 'driver' && s.vehicleKey !== undefined) throw new StoreError('BAD_SPEC', '기사가 아닌 직원의 차량: ' + s.name);
    if (!s.name.trim()) throw new StoreError('BAD_SPEC', '이름 없는 직원');
  }
  for (const d of spec.drawers) if (d.vehicleId !== undefined && !vehicles.has(d.vehicleId)) throw new StoreError('BAD_SPEC', '돈통의 차량이 없다: ' + d.id);
  if (spec.season.to < spec.season.from) throw new StoreError('BAD_SPEC', '시즌 끝이 시작보다 이르다');
}

/**
 * 빈 매장 파일에 매장을 만든다. 파일은 이미 마이그레이션되어 있어야 한다(서버가 시작할 때 한다). shops에 행이 있으면
 * ALREADY_PROVISIONED.
 */
export function provision(db: Db, shopId: string, spec: ShopSpec, now: number, options: ProvisionOptions): ProvisionResult {
  checkSpec(spec);
  return inWriteTransaction(db, () => {
    if (num(one(db, 'SELECT count(*) AS n FROM shops')?.n) > 0) throw new StoreError('ALREADY_PROVISIONED', '이미 만든 매장 파일이다');
    const at = isoOf(now);
    const businessDate = businessDateOf(now, spec.shop.cutoff);
    const effectiveFrom = spec.season.from < businessDate ? spec.season.from : businessDate;
    const meta = { now, actorKey: SYSTEM_ACTOR, rev: 0 };
    const base = { shop_id: shopId, created_at: at, updated_at: at };
    const epoch = ulid(now);

    insert(db, 'shops', {
      id: shopId, code: spec.shop.code, name: spec.shop.name, timezone: spec.shop.timezone, business_day_cutoff: spec.shop.cutoff, is_test: options.isTest,
      config_rev: 0, created_at: at, updated_at: at,
    });
    insert(db, 'shop_instance', { shop_id: shopId, epoch_id: epoch, epoch_no: 1, rev_floor: 0, updated_at: at });
    insert(db, 'closing_scopes', { ...base, id: MAIN_SCOPE, key: MAIN_SCOPE, label: '매장' });
    const roleGrants = grants(db);
    ROLES.forEach((r, i) => {
      insert(db, 'roles', { ...base, id: r.key, key: r.key, label: r.label, is_system: true, sort: i });
      for (const g of roleGrants.get(r.key) ?? []) insert(db, 'role_permissions', { shop_id: shopId, role_id: r.key, permission_key: g.key, scope_key: g.scope });
    });

    writeRegistry(db, shopId, spec.registry, spec.settings, spec.drawers, meta, effectiveFrom);

    const staff: StaffRow[] = spec.staff.map((s, i) => {
      const id = ulid(now);
      const accountId = options.accountIds?.[i];
      insert(db, 'staff_members', { ...base, id, account_id: accountId, display_name: s.name, role_id: s.role, default_vehicle_id: s.vehicleKey });
      if (s.vehicleKey) {
        insert(db, 'vehicle_assignments', { shop_id: shopId, id: ulid(now), vehicle_id: s.vehicleKey, staff_member_id: id, valid_from: effectiveFrom, created_at: at, created_by: SYSTEM_ACTOR });
      }
      return { id, name: s.name, roleKey: s.role, ...(s.vehicleKey ? { vehicleId: s.vehicleKey } : {}), ...(accountId ? { accountId } : {}) };
    });

    insert(db, 'shop_counters', { shop_id: shopId, counter_key: 'rev', scope_key: '', value: 0 });
    insert(db, 'shop_counters', { shop_id: shopId, counter_key: 'device_short_no', scope_key: '', value: 0 });
    ensureBusinessDay(db, shopId, businessDate, at);

    writeOpeningStock(db, shopId, spec, now, businessDate);
    return { epoch, businessDate, staff };
  });
}

/**
 * 재고 위치와 기초 재고: 번호 실물(assets, 권은 ticket_units도)을 매장 · 차량에 두고, 위치마다 기초 재고 이동(stock_opening, 바깥 →
 * 매장 · 차량) 한 건과 실물마다 이동 줄을 쓴다. 수량 품목(고글)은 규격마다 이동 줄 + stock_balances.
 */
function writeOpeningStock(db: Db, shopId: string, spec: ShopSpec, now: number, businessDate: string): void {
  const at = isoOf(now);
  const reg = spec.registry;
  insert(db, 'stock_locations', { shop_id: shopId, id: EXTERNAL_LOCATION, kind_key: 'external', label: '외부', created_at: at });
  insert(db, 'stock_locations', { shop_id: shopId, id: SHOP_LOCATION, kind_key: 'shop', label: '매장', created_at: at });
  for (const v of reg.vehicles) insert(db, 'stock_locations', { shop_id: shopId, id: vehicleLocation(v.id), kind_key: 'vehicle', label: v.label, vehicle_id: v.id, created_at: at });

  const units = new Map<string, { productKey: string; no: string }[]>();
  const add = (location: string, productKey: string, no: string) => {
    const product = reg.products[productKey];
    if (!product) throw new StoreError('BAD_SPEC', '재고의 상품이 목록에 없다: ' + productKey);
    if (product.tracking !== 'unit') throw new StoreError('BAD_SPEC', '번호 재고는 번호로 세는 상품만: ' + productKey);
    units.set(location, [...(units.get(location) ?? []), { productKey, no }]);
  };
  for (const [productKey, [from, to]] of Object.entries(spec.stock.numbers)) for (let n = from; n <= to; n += 1) add(SHOP_LOCATION, productKey, String(n));
  for (const spare of spec.stock.vehicleSpares) for (const no of spare.numbers) add(vehicleLocation(spare.vehicleId), spare.productKey, no);

  const counts: { productKey: string; variantKey: string; quantity: number }[] = [];
  for (const [productKey, byVariant] of Object.entries(spec.stock.counts)) {
    const product = reg.products[productKey];
    if (!product || product.tracking !== 'count') throw new StoreError('BAD_SPEC', '수량 재고는 수량으로 세는 상품만: ' + productKey);
    const variants = reg.kinds.find((k) => k.key === product.kindKey)?.variants ?? [];
    for (const [variantKey, quantity] of Object.entries(byVariant)) {
      if (!variants.some((v) => v.key === variantKey)) throw new StoreError('BAD_SPEC', '수량 재고의 규격이 없다: ' + productKey + ' ' + variantKey);
      if (quantity > 0) counts.push({ productKey, variantKey, quantity });
    }
  }

  const validFrom = isoOf(kstAt(spec.season.from, 0, 0, 0));
  const validTo = isoOf(kstAt(addDays(spec.season.to, 1), 0, 0, 0));
  const locations = [...new Set([...units.keys(), ...(counts.length ? [SHOP_LOCATION] : [])])];
  for (const location of locations) {
    const movementId = 'opening:' + location;
    const kind = location === SHOP_LOCATION ? 'shop' : 'vehicle';
    insert(db, 'stock_movements', {
      shop_id: shopId, id: movementId, kind_key: 'stock_opening', from_location_id: EXTERNAL_LOCATION, from_kind_key: 'external', to_location_id: location, to_kind_key: kind,
      occurred_at: at, recorded_at: at, closing_scope_id: MAIN_SCOPE, business_date: businessDate, posting_date: businessDate, actor_key: SYSTEM_ACTOR, actor_name: SYSTEM_ACTOR,
      request_id: 'provision:' + shopId, created_rev: 0,
    });
    let lineNo = 0;
    for (const u of units.get(location) ?? []) {
      const id = assetId(u.productKey, u.no);
      insert(db, 'assets', {
        shop_id: shopId, id, catalog_item_id: u.productKey, serial_no: u.no, location_id: location, condition_id: OK_CONDITION, last_movement_id: movementId, acquired_at: at, created_rev: 0,
      });
      if (reg.products[u.productKey]?.unit !== undefined) {
        insert(db, 'ticket_units', {
          shop_id: shopId, asset_id: id, vendor_counterparty_id: TICKET_VENDOR, valid_from: validFrom, valid_to: validTo, transferable: true, ticket_no: u.no,
          issued_at: at, issued_business_date: businessDate,
        });
      }
      insert(db, 'stock_movement_lines', { shop_id: shopId, movement_id: movementId, line_no: (lineNo += 1), catalog_item_id: u.productKey, asset_id: id, quantity: 1, created_rev: 0 });
    }
    if (location === SHOP_LOCATION) {
      for (const c of counts) {
        const variant = variantId(c.productKey, c.variantKey);
        insert(db, 'stock_movement_lines', {
          shop_id: shopId, movement_id: movementId, line_no: (lineNo += 1), catalog_item_id: c.productKey, variant_id: variant, quantity: c.quantity,
          before_condition_id: OK_CONDITION, after_condition_id: OK_CONDITION, created_rev: 0,
        });
        insert(db, 'stock_balances', { shop_id: shopId, location_id: SHOP_LOCATION, variant_id: variant, condition_id: OK_CONDITION, quantity: c.quantity, updated_rev: 0 });
      }
    }
  }
}

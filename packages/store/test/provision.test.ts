// 매장 만들기(plan §4-6 · §4-8): 견본 명세를 표에 쓰고 되읽으면 같은 목록 값 · 운영 규칙 · 돈통 · 실물이 나온다(load(write(x)) ≡ x).
// 두 번째 만들기는 거절되고, 표로 옮길 수 없는 명세는 아무것도 쓰지 않고 거절된다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAMPLE_STAFF, sampleDay, sampleRegistry, sampleRules, sampleSpec } from '@skinote/domain/sample';
import { DRAWERS } from '@skinote/domain/sample';
import type { ShopSpec } from '@skinote/domain';
import {
  all, COUNTER_EXCLUDED, DRIVER_PERMISSIONS, isStoreError, loadAssets, loadRegistry, loadShopState, num, one, openShopStore, provision, str, variantId,
} from '../src/index.ts';
import { countDiff, migrated, provisioned, rowCounts, secrets, SHOP, T0 } from './helpers.ts';

test('the sample shop round-trips: registry, rules and drawers read back exactly as sampleRegistry() · sampleRules() · DRAWERS', () => {
  const { db } = provisioned();
  const loaded = loadRegistry(db, SHOP);
  assert.deepEqual(loaded.registry, sampleRegistry());
  assert.deepEqual(loaded.settings, sampleRules());
  assert.deepEqual(loaded.drawers, DRAWERS.map((d) => ({ ...d })));
  assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
});

test('the numbered stock reads back as the spec stock and holds every sample day asset (shop stock + van 1 spare night tickets)', () => {
  const { db } = provisioned();
  const day = sampleDay({ date: '2026-12-26', epoch: 'x', ids: 'demo' });
  const spec = sampleSpec();
  const assets = loadAssets(db, SHOP);
  const specCount = Object.values(spec.stock.numbers).reduce((n, [from, to]) => n + to - from + 1, 0) + spec.stock.vehicleSpares.reduce((n, s) => n + s.numbers.length, 0);
  assert.equal(assets.length, specCount);
  const byId = new Map(assets.map((a) => [a.id, a]));
  for (const a of day.assets) assert.deepEqual(byId.get(a.id), a, a.id);
  // 권은 ticket_units(발권처 · 시즌 유효 기간), 실물마다 기초 재고 이동 줄 하나, 마지막 이동 = 기초 재고
  const tickets = assets.filter((a) => sampleRegistry().products[a.kind]?.unit !== undefined).length;
  assert.equal(num(one(db, 'SELECT count(*) AS n FROM ticket_units')?.n), tickets);
  // 번호 실물마다 한 줄 + 수량 품목(고글)의 규격마다 한 줄
  const countLines = Object.values(spec.stock.counts).reduce((n, byVariant) => n + Object.keys(byVariant).length, 0);
  assert.equal(num(one(db, 'SELECT count(*) AS n FROM stock_movement_lines')?.n), assets.length + countLines);
  assert.equal(num(one(db, "SELECT count(*) AS n FROM assets WHERE last_movement_id LIKE 'opening:%'")?.n), assets.length);
  const van = all(db, "SELECT a.id FROM assets a WHERE a.location_id = 'vehicle:v1' ORDER BY a.rowid").map((r) => str(r.id));
  assert.deepEqual(van, day.assets.filter((a) => a.vehicleId === 'v1').map((a) => a.id));
});

test('the loaded ShopState head: provision epoch, rev 0, the business day, receipt 001 next, empty ledgers', () => {
  const { db, epoch } = provisioned();
  const state = loadShopState(db, SHOP, T0 + 60_000);
  assert.equal(state.epoch, epoch);
  assert.equal(state.rev, 0);
  assert.equal(state.businessDate, '2026-12-26');
  assert.equal(state.nextReceiptSeq, 1);
  assert.deepEqual([state.orders, state.pins, state.closings, state.cashTransfers], [[], [], [], []]);
  // 06:00 전은 전날 영업일
  assert.equal(loadShopState(db, SHOP, T0 + 20 * 3_600_000).businessDate, '2026-12-26');
  assert.equal(loadShopState(db, SHOP, T0 + 21 * 3_600_000).businessDate, '2026-12-27');
});

test('roles: manager has every permission, counter all but settings · staff · device · reopen, driver only its own-vehicle work', () => {
  const { store, db } = provisioned();
  const all_ = num(one(db, 'SELECT count(*) AS n FROM sys_permissions')?.n);
  const manager = store.permissions('manager');
  const counter = store.permissions('counter');
  const driver = store.permissions('driver');
  assert.equal(manager.size, all_);
  assert.equal(counter.size, all_ - COUNTER_EXCLUDED.length);
  for (const key of COUNTER_EXCLUDED) assert.equal(counter.has(key), false, key);
  assert.deepEqual([...driver.keys()].sort(), [...DRIVER_PERMISSIONS].sort());
  for (const scope of driver.values()) assert.equal(scope, 'own_vehicle');
  assert.equal(manager.get('payment.collect_field'), 'own_vehicle', 'a permission that only knows own_vehicle keeps it');
  assert.equal(manager.get('payment.take'), 'shop');
});

test('staff: the sample staff with roles and the driver van; a driver gets a vehicle assignment', () => {
  const { store, db } = provisioned();
  const staff = store.staff();
  assert.deepEqual(staff.map((s) => ({ name: s.name, role: s.roleKey, vehicle: s.vehicleId })), SAMPLE_STAFF.map((s) => ({ name: s.name, role: s.role, vehicle: s.vehicleKey })));
  assert.equal(num(one(db, 'SELECT count(*) AS n FROM vehicle_assignments')?.n), 1);
  assert.equal(str(one(db, 'SELECT vehicle_id FROM vehicle_assignments')?.vehicle_id), 'v1');
});

test('a second provision of the same file is refused and writes nothing', () => {
  const { store, db } = provisioned();
  const before = rowCounts(db);
  assert.throws(() => store.provision(sampleSpec(), T0 + 1, { isTest: true }), (e: unknown) => isStoreError(e, 'ALREADY_PROVISIONED'));
  assert.deepEqual(countDiff(before, rowCounts(db)), {});
});

test('specs the tables cannot hold are refused before anything is written', () => {
  const bad: [string, (s: ShopSpec) => void, string][] = [
    ['another timezone', (s) => { (s.shop as { timezone: string }).timezone = 'Asia/Tokyo'; }, 'TIMEZONE_UNSUPPORTED'],
    ['a driver without a van', (s) => { s.staff.push({ name: '박기사', role: 'driver' }); }, 'BAD_SPEC'],
    ['a counter with a van', (s) => { s.staff.push({ name: '김카운터', role: 'counter', vehicleKey: 'v1' }); }, 'BAD_SPEC'],
    ['a deposit rule both on and off', (s) => { s.settings.liftDepositOff = { ...s.settings.liftDeposit! }; }, 'BAD_SPEC'],
    ['a product of an unknown kind', (s) => { (s.registry.products as Record<string, unknown>).sled = { ...s.registry.products.ski, key: 'sled', kindKey: 'sled' }; }, 'BAD_SPEC'],
    ['count stock of a numbered product', (s) => { s.stock.counts = { ski: { '어른': 1 } }; }, 'BAD_SPEC'],
    ['cutoff differs between shop and rules', (s) => { s.shop.cutoff = '05:00'; }, 'BAD_SPEC'],
  ];
  for (const [name, change, code] of bad) {
    const db = migrated('shop');
    const spec = sampleSpec();
    change(spec);
    assert.throws(() => provision(db, SHOP, spec, T0, { isTest: true }), (e: unknown) => isStoreError(e, code as never), name);
    assert.equal(num(one(db, 'SELECT count(*) AS n FROM shops')?.n), 0, name + ': rolled back');
    db.close();
  }
});

test('a different shop round-trips too: renamed van, extra place, new price, deposit off with kept values, optional return, no default slot', () => {
  const spec = sampleSpec();
  const reg = spec.registry as unknown as { vehicles: { id: string; label: string }[]; areas: { id: string; label: string; lodging: boolean; places: { id: string; label: string }[] }[] };
  reg.vehicles[0]!.label = '큰 차';
  reg.areas[1]!.places.push({ id: 'manseon_gate', label: '만선 정문' });
  (spec.registry.products as Record<string, { price: number }>).board!.price = 27_000;
  spec.settings.liftDepositOff = { ...spec.settings.liftDeposit!, unitAmount: 7_000, afterDays: null };
  delete (spec.settings.liftDepositOff as { lossAmount?: number }).lossAmount;
  spec.settings.liftDeposit = null;
  spec.settings.liftReturnPolicy = 'optional';
  delete spec.settings.defaultReturnSlotKey;
  delete spec.settings.prepaymentAmount;
  spec.settings.prepaymentMode = 'none';
  spec.settings.openingCash = 0;
  spec.settings.driverSeesDue = false;
  spec.stock.counts = { goggles: { '어른': 10, '어린이': 4 } };
  const db = migrated('shop');
  const store = openShopStore(db, SHOP, { secrets: secrets() });
  store.provision(spec, T0, { isTest: false });
  const loaded = loadRegistry(db, SHOP);
  assert.deepEqual(loaded.registry, spec.registry);
  assert.deepEqual(loaded.settings, spec.settings);
  // 수량 재고: 규격마다 기초 재고 이동 줄 + stock_balances
  const balances = all(db, 'SELECT variant_id, quantity FROM stock_balances ORDER BY variant_id').map((r) => [str(r.variant_id), num(r.quantity)]);
  assert.deepEqual(balances, [[variantId('goggles', '어른'), 10], [variantId('goggles', '어린이'), 4]]);
  assert.equal(num(one(db, "SELECT count(*) AS n FROM stock_movement_lines WHERE variant_id IS NOT NULL AND before_condition_id = 'ok' AND after_condition_id = 'ok'")?.n), 2);
  assert.equal(num(one(db, 'SELECT is_test FROM shops')?.is_test), 0);
  assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
});

test('the price list is published after its rules were written (published rules are frozen)', () => {
  const { db } = provisioned();
  assert.equal(str(one(db, "SELECT status_key FROM price_list_versions WHERE id = 'standard:1'")?.status_key), 'published');
  assert.throws(() => db.exec("UPDATE price_rules SET unit_amount = 1 WHERE id = 'standard:1:ski'"), /PUBLISHED/);
});

// 매장 설정의 목록 바꿈(registry.update) · 직원 바꿈(staff.set)의 표 옮기기(features-1 plan §4-2 · §4-6). 명령마다 메모리(도메인 execute)와
// 저장소(매장 파일)의 상태가 같은지(쌍둥이), 새로 연 저장소도 같은지 보고, 표의 모양을 본다: 행은 지우지 않고(숨김 · 사용 종료 = active 0 ·
// suspended), config_changes는 바뀐 행마다 한 줄, config_rev는 명령마다 한 번, 값은 새 요금표 판(옛 판 retired), 차량은 재고 위치 · 지갑 돈통과
// 함께, 직원은 계정 id를 미리 정하고 차량 배정을 열고 닫는다. 지난 접수의 줄 값 · 약속 행은 그대로다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AnyCommandEnvelope, type CommandOutcome, type RegistryOp, type StaffOp } from '@skinote/contract';
import { PRODUCTION_LINES, execute, kstAt, lateAtOf, sampleDay, type ShopState } from '@skinote/domain';
import { all, canonicalJson, num, one, str, type ShopStore, type Db } from '../src/index.ts';
import { COUNTER, envelope, provisioned, rowCounts, SHOP, T0 } from './helpers.ts';

const DATE = '2026-12-26';
const at = (h: number, m: number) => kstAt(DATE, 0, h, m);
const comparable = (s: ShopState) => canonicalJson({ ...s, outcomes: {}, storyApplied: [], driverDevice: { offline: false, queue: [] } });

interface Twin {
  db: Db;
  store: ShopStore;
  memory: ShopState;
  reopen(): ShopStore;
  run(env: AnyCommandEnvelope, now: number, name: string, actorKey?: string): CommandOutcome;
}

function twin(): Twin {
  const { db, store, reopen } = provisioned();
  const empty = store.state(T0);
  const day = sampleDay({ date: DATE, epoch: empty.epoch, ids: 'demo' });
  const imported = store.importDay({ date: DATE, orders: day.orders, pins: day.pins, deposits: day.deposits, paymentGroups: day.paymentGroups }, 'import:sample:' + DATE, T0, COUNTER);
  const outcomes = new Map<string, CommandOutcome['outcome']>();
  const t: Twin = {
    db, store, reopen,
    memory: store.state(T0),
    run(env, now, name, actorKey = COUNTER.key) {
      const actor = { ...COUNTER, key: actorKey };
      const mem = execute(t.memory, env, { now, actor, outcomeOf: (id) => (outcomes.has(id) ? { outcome: outcomes.get(id)! } : undefined), lines: PRODUCTION_LINES, orderIds: 'dated' });
      const got = store.command(env, actor, now);
      assert.equal(got.outcome, mem.outcome.outcome, name + ': outcome ' + JSON.stringify(got.error ?? null));
      assert.deepEqual(got.result ?? null, mem.outcome.result ?? null, name + ': result');
      outcomes.set(env.requestId, got.outcome);
      if (got.outcome === 'applied') t.memory = { ...mem.state, rev: got.rev };
      assert.equal(comparable(store.state(now)), comparable(t.memory), name + ': the shop file reads back the memory state');
      assert.equal(comparable(reopen().state(now)), comparable(t.memory), name + ': a fresh store too');
      return got;
    },
  };
  assert.equal(imported.replay, false);
  return t;
}

const basis = (t: Twin) => ({ epoch: t.memory.epoch, rev: t.memory.rev });
const reg = (t: Twin, changes: RegistryOp[], now = at(15, 40), name = 'registry.update') => t.run(envelope('registry.update', { changes }, basis(t)), now, name);
const configRev = (db: Db) => num(one(db, 'SELECT config_rev FROM shops')?.config_rev);
/** 행(SQLite 행은 원형이 없는 객체라 비교 전에 보통 객체로). */
const row = (db: Db, sql: string, ...args: (string | number)[]) => ({ ...one(db, sql, ...args) });

test('shop info, areas and places: rows are updated in place, hidden rows stay (active 0), one config_changes row each, config_rev once per command', () => {
  const t = twin();
  const rev0 = configRev(t.db);
  const out = reg(t, [
    { op: 'shop.set', name: '첫 매장', phone: '01000000009' }, { op: 'area.add', ref: 'n1', label: '설천 입구' },
    { op: 'place.add', ref: 'n2', areaId: 'new:n1', label: '매표소' }, { op: 'place.add', ref: 'n3', areaId: 'solmaeul', label: '다솔동' },
    { op: 'place.hide', id: 'seolcheon_parking', hidden: true }, { op: 'area.move', id: 'manseon', toIndex: 0 }, { op: 'area.hide', id: 'kkotmaeul', hidden: true },
  ]);
  assert.equal(out.outcome, 'applied');
  assert.equal(configRev(t.db), rev0 + 1, 'config_rev rises once for the whole save');
  assert.deepEqual(row(t.db, 'SELECT name, phone FROM shops'), { name: '첫 매장', phone: '01000000009' });
  assert.equal(num(one(t.db, "SELECT active FROM places WHERE id = 'seolcheon_parking'")?.active), 0);
  assert.equal(num(one(t.db, "SELECT active FROM areas WHERE id = 'kkotmaeul'")?.active), 0);
  // 숙소 구역에 더한 장소는 쓰임 lodging(되읽기가 구역의 숙소 여부를 잃지 않게).
  assert.equal(num(one(t.db, "SELECT count(*) AS n FROM place_uses WHERE place_id = ? AND use_key = 'lodging'", out.requestId + ':n3')?.n), 1);
  const rows = all(t.db, 'SELECT entity_type, entity_id FROM config_changes WHERE config_rev = ? ORDER BY seq', rev0 + 1).map((r) => str(r.entity_type) + ':' + str(r.entity_id));
  assert.ok(rows.includes('shops:shop0test') && rows.includes('areas:' + out.requestId + ':n1') && rows.includes('places:seolcheon_parking'), rows.join(', '));
  // 지난 접수의 약속 행은 장소 이름 사본 그대로(이름을 바꿔도 행을 고치지 않는다).
  const before = num(one(t.db, 'SELECT count(*) AS n FROM line_promises')?.n);
  reg(t, [{ op: 'place.rename', id: 'seolcheon_house', label: '설천 하우스' }]);
  assert.equal(num(one(t.db, 'SELECT count(*) AS n FROM line_promises')?.n), before, 'no promise row is written by a rename');
});

test('return slots: add with the night flag, time change keeps the night flag, moves ticket windows and records the earliest time; red status unchanged', () => {
  const t = twin();
  const added = reg(t, [{ op: 'slot.add', ref: 'n1', label: '저녁', time: '19:00' }, { op: 'setting.default_slot', slotId: 'new:n1' }, { op: 'setting.night_notice', minutes: 30 }]);
  assert.equal(num(one(t.db, 'SELECT is_night FROM return_slots WHERE id = ?', added.requestId + ':n1')?.is_night), 0);
  const lateBefore = t.memory.orders.map((o) => lateAtOf(t.memory.settings, o.giveBack));
  reg(t, [{ op: 'slot.update', id: 'night', time: '22:30' }, { op: 'setting.vehicle_late', minutes: 60, nightMinutes: 120 }]);
  assert.equal(str(one(t.db, "SELECT window_end FROM ticket_products WHERE catalog_item_id = 'night_adult'")?.window_end), '22:30');
  assert.deepEqual(t.memory.settings.returnSlots.find((s) => s.key === 'night')!.earliest, { hour: 22, minute: 0 });
  reg(t, [{ op: 'setting.vehicle_late', minutes: 60, nightMinutes: 90 }]);
  assert.deepEqual(t.memory.orders.map((o) => lateAtOf(t.memory.settings, o.giveBack)), lateBefore, 'moving the night slot keeps every existing red time');
  reg(t, [{ op: 'slot.hide', id: 'late_night', hidden: true }]);
  assert.equal(num(one(t.db, "SELECT active FROM return_slots WHERE id = 'late_night'")?.active), 0);
  const night = reg(t, [{ op: 'slot.add', ref: 'n1', label: '밤', time: '20:30' }], at(15, 50), 'night slot');
  assert.equal(num(one(t.db, 'SELECT is_night FROM return_slots WHERE id = ?', night.requestId + ':n1')?.is_night), 1, 'a slot added at 20:00 or later is a night slot');
});

test('prices: a new published price list version with every product, the old one retired; order lines keep their amount', () => {
  const t = twin();
  const lineAmounts = all(t.db, 'SELECT id, net_amount FROM order_lines ORDER BY id').map((r) => [str(r.id), num(r.net_amount)]);
  reg(t, [{ op: 'price.set', productKey: 'ski', amount: 45_000 }]);
  reg(t, [{ op: 'price.set', productKey: 'night_adult', amount: 36_000 }], at(15, 50), 'second price');
  const versions = all(t.db, "SELECT version_no, status_key, effective_to FROM price_list_versions ORDER BY version_no").map((r) => [num(r.version_no), str(r.status_key)]);
  assert.deepEqual(versions, [[1, 'retired'], [2, 'retired'], [3, 'published']]);
  assert.equal(num(one(t.db, "SELECT count(*) AS n FROM price_rules WHERE price_list_version_id = 'standard:3'")?.n), Object.keys(t.memory.registry.products).length);
  assert.equal(num(one(t.db, "SELECT unit_amount FROM price_rules WHERE price_list_version_id = 'standard:3' AND catalog_item_id = 'ski'")?.unit_amount), 45_000);
  assert.deepEqual(all(t.db, 'SELECT id, net_amount FROM order_lines ORDER BY id').map((r) => [str(r.id), num(r.net_amount)]), lineAmounts);
});

test('discounts: amount and percent rules, value and active changes in place, group kinds ensured', () => {
  const t = twin();
  const out = reg(t, [
    { op: 'discount.add', ref: 'n1', label: '단골 3,000원', kind: 'amount', value: 3_000, sections: ['gear'] },
    { op: 'discount.update', id: 'ten_percent', value: 15, label: '15% 할인' }, { op: 'discount.active', id: 'lift_twenty', active: false },
  ]);
  assert.deepEqual(row(t.db, 'SELECT discount_kind_key, amount, percent_bp, active FROM discount_rules WHERE id = ?', out.requestId + ':n1'),
    { discount_kind_key: 'amount', amount: 3000, percent_bp: null, active: 1 });
  assert.deepEqual(row(t.db, "SELECT label, percent_bp FROM discount_rules WHERE id = 'ten_percent'"), { label: '15% 할인', percent_bp: 1500 });
  assert.equal(num(one(t.db, "SELECT count(*) AS n FROM discount_group_kinds WHERE discount_group_id = 'gear' AND discount_kind_key = 'amount'")?.n), 1);
});

test('vehicles: add with its stock location and wallet drawer, rename renames the wallet, end and reuse the same row; refused while it has work', () => {
  const t = twin();
  const out = reg(t, [{ op: 'vehicle.add', ref: 'n1', label: '3호 차량' }]);
  const id = out.requestId + ':n1';
  assert.deepEqual(row(t.db, 'SELECT name, active FROM vehicles WHERE id = ?', id), { name: '3호 차량', active: 1 });
  assert.equal(num(one(t.db, 'SELECT count(*) AS n FROM stock_locations WHERE vehicle_id = ?', id)?.n), 1);
  assert.equal(str(one(t.db, 'SELECT label FROM cash_drawers WHERE vehicle_id = ?', id)?.label), '3호 차량 현금');
  reg(t, [{ op: 'vehicle.rename', id, label: '임시 차량' }]);
  assert.equal(str(one(t.db, 'SELECT label FROM cash_drawers WHERE vehicle_id = ?', id)?.label), '임시 차량 현금');
  reg(t, [{ op: 'vehicle.active', id, active: false }]);
  assert.equal(num(one(t.db, 'SELECT active FROM vehicles WHERE id = ?', id)?.active), 0);
  assert.ok(one(t.db, 'SELECT retired_at FROM vehicles WHERE id = ?', id)?.retired_at);
  reg(t, [{ op: 'vehicle.active', id, active: true }]);
  assert.deepEqual(row(t.db, 'SELECT active, retired_at FROM vehicles WHERE id = ?', id), { active: 1, retired_at: null });
  const refused = reg(t, [{ op: 'vehicle.active', id: 'v1', active: false }], at(15, 50), 'end v1');
  assert.equal(refused.outcome, 'rejected');
  assert.match(refused.error?.message ?? '', /^사용 종료 불가 · 미처리 (수거|배달)/);
});

test('staff: a new person with a reserved account id and an open assignment on the vehicle added just before; role, vehicle and suspend; names stay out of command_json', () => {
  const t = twin();
  const counts = rowCounts(t.db);
  const van = reg(t, [{ op: 'vehicle.add', ref: 'n1', label: '3호 차량' }]);
  const staffEnv = envelope('staff.set', { changes: [{ op: 'staff.add', ref: 'n2', name: '박준', role: 'driver', vehicleId: 'new:n1' }] }, basis(t), { dependsOn: [van.requestId] });
  const added = t.run(staffEnv, at(15, 41), 'staff.add');
  const id = staffEnv.requestId + ':n2';
  assert.deepEqual(added.result, { staffIds: [id] });
  assert.deepEqual(row(t.db, 'SELECT account_id, role_id, status_key, default_vehicle_id FROM staff_members WHERE id = ?', id),
    { account_id: 'acct:' + SHOP + ':' + id, role_id: 'driver', status_key: 'active', default_vehicle_id: null });
  assert.equal(str(one(t.db, 'SELECT vehicle_id FROM vehicle_assignments WHERE staff_member_id = ? AND ended_at IS NULL', id)?.vehicle_id), van.requestId + ':n1');
  // 같은 요청번호를 다시: 행이 늘지 않는다.
  const rows = rowCounts(t.db);
  assert.deepEqual(t.store.command(staffEnv, COUNTER, at(15, 42)).result, added.result);
  assert.deepEqual(rowCounts(t.db), rows);
  const counter = t.memory.staff!.find((s) => s.roleKey === 'counter')!;
  const run = (changes: StaffOp[], name: string) => t.run(envelope('staff.set', { changes }, basis(t)), at(15, 43), name);
  assert.equal(run([{ op: 'staff.update', id: counter.id, vehicleId: 'v2' }], 'assign').outcome, 'applied');
  assert.equal(run([{ op: 'staff.update', id: counter.id, vehicleId: 'v1' }], 'reassign').outcome, 'applied');
  const assignments = all(t.db, 'SELECT vehicle_id, ended_at FROM vehicle_assignments WHERE staff_member_id = ? ORDER BY rowid', counter.id);
  assert.deepEqual(assignments.map((r) => [str(r.vehicle_id), r.ended_at === null]), [['v2', false], ['v1', true]]);
  assert.equal(run([{ op: 'staff.active', id: counter.id, active: false }], 'suspend').outcome, 'applied');
  assert.equal(str(one(t.db, 'SELECT status_key FROM staff_members WHERE id = ?', counter.id)?.status_key), 'suspended');
  assert.equal(t.store.staff().some((s) => s.id === counter.id), false, 'a suspended person is not on the login tiles');
  // 이름은 명령 기록(events.command_json)에 없고 event_pii에만.
  for (const r of all(t.db, "SELECT command_json FROM events WHERE command_type = 'staff.set'")) assert.equal(str(r.command_json).includes('박준'), false);
  // 이 시험에서 지운 행이 없다(행 수는 늘기만).
  for (const [table, n] of Object.entries(counts)) assert.ok((rowCounts(t.db)[table] ?? 0) >= n, table + ' never shrinks');
});

test('the actor of the session: ending oneself is refused through the store too', () => {
  const t = twin();
  const manager = t.memory.staff!.find((s) => s.roleKey === 'manager')!;
  const counter = t.memory.staff!.find((s) => s.roleKey === 'counter')!;
  const env = envelope('staff.set', { changes: [{ op: 'staff.active', id: counter.id, active: false }] }, basis(t));
  const self = t.run(env, at(15, 40), 'self', 'staff:' + counter.id);
  assert.equal(self.error?.message, '사용 종료 불가 · 본인');
  const last = t.run(envelope('staff.set', { changes: [{ op: 'staff.update', id: manager.id, role: 'counter' }] }, basis(t)), at(15, 41), 'last manager');
  assert.equal(last.error?.message, '사용 종료 불가 · 마지막 관리자');
});

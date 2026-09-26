// 시험 매장 새로 만들기의 저장소 몫(reset.ts): 옛 파일에서 이어 갈 것(직원 id · 계정, 기기, 등록 번호, 기기 번호 셈, epoch · rev)을 읽고,
// 새 빈 파일에 명세 + 이어 갈 것을 한 트랜잭션으로 쓴다. 직원 id · 기기 id · 기기 번호가 같고, epoch은 넘겨준 번호 · rev 바닥이며, 새
// 명세에 차량이 없는 기사 기기와 그 등록 번호는 옮기지 않는다. 도중에 실패하면 새 파일은 빈 채로 남는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleSpec } from '@skinote/domain/sample';
import type { ShopSpec } from '@skinote/domain';
import { all, isStoreError, num, one, openShopStore, readInstance, readResetCarry, rebuildShop, sha256, type ResetCarry } from '../src/index.ts';
import { migrated, MINUTE, rowCounts, secrets, SHOP, T0 } from './helpers.ts';

const HOUR = 60 * MINUTE;

/** 옛 매장: 견본 + 3호 차량, 관리자 · 카운터 · 1호 · 3호 기사(계정 id 있음), 기기 셋(카운터 · 1호 · 3호), 아직 안 쓴 번호 하나, 끊긴 기기 하나. */
function oldShop() {
  const db = migrated('shop');
  const spec: ShopSpec = sampleSpec();
  spec.registry.vehicles = [...spec.registry.vehicles, { id: 'v3', label: '3호 차량' }];
  spec.staff = [
    { name: '한가람', role: 'manager' },
    { name: '오세린', role: 'counter' },
    { name: '문태오', role: 'driver', vehicleKey: 'v1' },
    { name: '최기사', role: 'driver', vehicleKey: 'v3' },
  ];
  const store = openShopStore(db, SHOP, { secrets: secrets() });
  store.provision(spec, T0, { isTest: true, accountIds: ['acc-1', 'acc-2', 'acc-3', 'acc-4'] });
  const rows = store.devices;
  const enroll = (digits: string, kind: 'pos' | 'driver_phone', label: string, vehicleId?: string) => {
    const code = rows.createCode({ codeHash: sha256(digits), kind, label, ...(vehicleId ? { vehicleId } : {}), expiresAt: T0 + HOUR, now: T0 });
    return rows.enroll({ codeId: code.id, publicKey: `{"kty":"EC","x":"${digits}"}`, now: T0 + MINUTE });
  };
  const pos = enroll('111111111111', 'pos', '카운터 1');
  const van1 = enroll('222222222222', 'driver_phone', '1호차 휴대폰', 'v1');
  const van3 = enroll('333333333333', 'driver_phone', '3호차 휴대폰', 'v3');
  const lost = enroll('444444444444', 'pos', '잃어버린 카운터');
  rows.revoke(lost.id, 'lost', T0 + 2 * MINUTE);
  rows.createCode({ codeHash: sha256('555555555555'), kind: 'pos', label: '카운터 2', expiresAt: T0 + HOUR, now: T0 });
  return { db, store, pos, van1, van3, lost };
}

const devicesOf = (db: ReturnType<typeof migrated>) =>
  all(db, 'SELECT id, kind_key, label, vehicle_id, short_no, public_key, status_key, revoked_at FROM devices ORDER BY short_no');

test('readResetCarry reads staff ids and accounts, every device and code, the device number counter, the epoch and rev', () => {
  const { db, store } = oldShop();
  const carry = readResetCarry(db, SHOP);
  assert.equal(carry.isTest, true);
  assert.equal(carry.epochNo, 1);
  assert.equal(carry.rev, 0);
  assert.equal(carry.revFloor, 0);
  assert.deepEqual(carry.staff, store.staff());
  assert.deepEqual(carry.staff.map((s) => s.accountId), ['acc-1', 'acc-2', 'acc-3', 'acc-4']);
  assert.equal(carry.devices.length, 4);
  assert.equal(carry.codes.length, 5);
  assert.equal(carry.deviceShortNo, 4);
  assert.throws(() => readResetCarry(db, 'other-shop'), (e: unknown) => isStoreError(e, 'SHOP_MISMATCH'));
  assert.throws(() => readResetCarry(migrated('shop'), SHOP), (e: unknown) => isStoreError(e, 'SHOP_NOT_PROVISIONED'));
});

/** 새 명세(지금 견본, 3호 차량 없음) + 이어 갈 직원(3호 기사는 1호로). */
function nextSpec(carry: ResetCarry): ShopSpec {
  const spec = sampleSpec();
  spec.staff = carry.staff.map((s) => (s.roleKey === 'driver'
    ? { name: s.name, role: 'driver' as const, vehicleKey: s.vehicleId === 'v3' ? 'v1' : s.vehicleId }
    : { name: s.name, role: s.roleKey as 'manager' | 'counter' }));
  return spec;
}

test('rebuildShop keeps staff ids and accounts, devices (with keys, numbers and revoked state) and codes; drops the van the spec lacks', () => {
  const old = oldShop();
  const carry = readResetCarry(old.db, SHOP);
  const db = migrated('shop');
  const made = rebuildShop(db, SHOP, nextSpec(carry), T0 + HOUR, { carry, epoch: { no: 2, revFloor: 1_000_000 } });
  assert.deepEqual(made.devices.dropped, [old.van3.id]);
  assert.deepEqual(made.devices.kept, [old.pos.id, old.van1.id, old.lost.id]);
  assert.equal(made.codes, 4, 'the van 3 code is not carried; the unused code is');
  const store = openShopStore(db, SHOP, { secrets: secrets() });
  assert.deepEqual(store.staff().map((s) => ({ id: s.id, account: s.accountId, vehicle: s.vehicleId })), carry.staff.map((s) => ({
    id: s.id, account: s.accountId, vehicle: s.vehicleId === 'v3' ? 'v1' : s.vehicleId,
  })));
  assert.deepEqual(devicesOf(db), devicesOf(old.db).filter((d) => d.id !== old.van3.id));
  assert.equal(store.devices.statusMap().get(old.lost.id), 'revoked', 'a revoked device stays revoked');
  assert.ok(store.devices.codeByHash(sha256('555555555555')), 'an unused code still routes to its row');
  assert.equal(store.devices.codeByHash(sha256('333333333333')), undefined);
  assert.equal(num(one(db, "SELECT value FROM shop_counters WHERE counter_key = 'device_short_no'")?.value), 4, 'device numbers are never reused');
  assert.deepEqual(readInstance(db, SHOP), { epochId: made.epoch, epochNo: 2, revFloor: 1_000_000 });
  assert.notEqual(made.epoch, readInstance(old.db, SHOP)?.epochId);
  assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
  // 다음 등록은 다음 기기 번호, 다음 rev는 바닥 위.
  const code = store.devices.createCode({ codeHash: sha256('666666666666'), kind: 'pos', label: '카운터 3', expiresAt: T0 + 2 * HOUR, now: T0 + HOUR });
  assert.equal(store.devices.enroll({ codeId: code.id, publicKey: '{}', now: T0 + HOUR }).shortNo, 5);
  assert.equal(store.head(T0 + HOUR).rev, 0);
  assert.equal(store.state(T0 + HOUR).orders.length, 0);
});

test('rebuildShop refuses staff that differ from the carry and writes nothing; a failure half-way leaves the new file empty', () => {
  const old = oldShop();
  const carry = readResetCarry(old.db, SHOP);
  const db = migrated('shop');
  const empty = rowCounts(db);
  const wrong = nextSpec(carry);
  wrong.staff = wrong.staff.slice(1);
  assert.throws(() => rebuildShop(db, SHOP, wrong, T0, { carry, epoch: { no: 2, revFloor: 0 } }), (e: unknown) => isStoreError(e, 'BAD_SPEC'));
  assert.deepEqual(rowCounts(db), empty);
  // 옮길 등록 번호 하나가 망가짐(모르는 기기 종류) → 매장 만들기까지 모두 되돌림.
  const broken: ResetCarry = { ...carry, codes: [...carry.codes, { ...carry.codes[4]!, id: 'code-x', code_hash: sha256('777777777777'), kind_key: 'toaster' }] };
  assert.throws(() => rebuildShop(db, SHOP, nextSpec(carry), T0, { carry: broken, epoch: { no: 2, revFloor: 0 } }));
  assert.deepEqual(rowCounts(db), empty, 'one transaction: nothing stays');
  assert.throws(() => rebuildShop(db, SHOP, nextSpec(carry), T0, { carry, epoch: { no: 0, revFloor: 0 } }), (e: unknown) => isStoreError(e, 'BAD_SPEC'));
  // 그다음 제대로 하면 된다.
  rebuildShop(db, SHOP, nextSpec(carry), T0, { carry, epoch: { no: 2, revFloor: 0 } });
  assert.equal(num(one(db, 'SELECT count(*) AS n FROM shops')?.n), 1);
});

// 매장 파일의 기기 행(plan §4-7, D6): 명령줄이 만든(미리 승인한) 12자리 등록 번호로 한 번만 등록, 기기 번호는 셈에서, 로그인 기록은
// rev를 올리지 않음, 끊은 기기는 상태 지도에서 revoked. 열린 등록(시험 매장, SKINOTE_TEST_OPEN_ENROLL): 기기가 고른 종류 · 차량,
// 기기 번호로 만든 이름, 끊기지 않은 열린 기기의 끝 수.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPEN_ENROLL_ACTOR, isStoreError, num, one, openShopStore, sha256, str } from '../src/index.ts';
import { MINUTE, migrated, provisioned, secrets, SHOP, T0 } from './helpers.ts';
import { sampleSpec } from '@skinote/domain/sample';

const HOUR = 60 * MINUTE;
const code = (digits: string) => sha256(digits);

test('a pre-approved code enrolls a device once; short numbers count up; the code is marked used', () => {
  const { store, db } = provisioned();
  const rows = store.devices;
  const a = rows.createCode({ codeHash: code('123456789012'), kind: 'pos', label: '카운터 1', expiresAt: T0 + HOUR, now: T0 });
  assert.equal(rows.codeByHash(code('123456789012'))?.id, a.id);
  assert.ok(a.approvedAt !== undefined, 'the CLI pre-approves (system:cli)');
  assert.equal(str(one(db, 'SELECT approved_by FROM device_enrollment_codes')?.approved_by), 'system:cli');
  const d1 = rows.enroll({ codeId: a.id, publicKey: '{"kty":"EC"}', now: T0 + MINUTE });
  assert.deepEqual({ kind: d1.kind, label: d1.label, shortNo: d1.shortNo, status: d1.status }, { kind: 'pos', label: '카운터 1', shortNo: 1, status: 'active' });
  assert.equal(rows.codeById(a.id)?.deviceId, d1.id);
  assert.throws(() => rows.enroll({ codeId: a.id, publicKey: '{}', now: T0 + 2 * MINUTE }), (e: unknown) => isStoreError(e, 'NOT_FOUND'), 'a used code');
  const b = rows.createCode({ codeHash: code('999999999999'), kind: 'driver_tablet', label: '1호 차량 태블릿', vehicleId: 'v1', expiresAt: T0 + HOUR, now: T0 });
  const d2 = rows.enroll({ codeId: b.id, publicKey: '{}', now: T0 + 3 * MINUTE });
  assert.deepEqual({ shortNo: d2.shortNo, vehicleId: d2.vehicleId }, { shortNo: 2, vehicleId: 'v1' });
  assert.equal(num(one(db, "SELECT value FROM shop_counters WHERE counter_key = 'device_short_no'")?.value), 2);
  assert.equal(rows.find('1호 차량 태블릿')?.id, d2.id);
  assert.equal(rows.find(d1.id)?.label, '카운터 1');
});

test('an expired code does not enroll; a counter code cannot carry a van and a driver code needs one', () => {
  const { store } = provisioned();
  const rows = store.devices;
  const old = rows.createCode({ codeHash: code('111111111111'), kind: 'pos', label: '카운터 2', expiresAt: T0 + MINUTE, now: T0 });
  assert.throws(() => rows.enroll({ codeId: old.id, publicKey: '{}', now: T0 + 2 * MINUTE }), (e: unknown) => isStoreError(e, 'NOT_FOUND'));
  assert.throws(() => rows.createCode({ codeHash: code('222222222222'), kind: 'pos', label: 'x', vehicleId: 'v1', expiresAt: T0 + HOUR, now: T0 }), (e: unknown) => isStoreError(e, 'BAD_SPEC'));
  assert.throws(() => rows.createCode({ codeHash: code('333333333333'), kind: 'driver_phone', label: 'x', expiresAt: T0 + HOUR, now: T0 }), (e: unknown) => isStoreError(e, 'BAD_SPEC'));
  assert.throws(() => rows.createCode({ codeHash: '123456789012', kind: 'pos', label: 'x', expiresAt: T0 + HOUR, now: T0 }), (e: unknown) => isStoreError(e, 'BAD_SPEC'), 'the raw code is never stored');
});

test('sign-ins count per device, carry the current rev without bumping it; revoke shows in the status map once', () => {
  const { store, db } = provisioned();
  const rows = store.devices;
  const c = rows.createCode({ codeHash: code('444444444444'), kind: 'pos', label: '카운터 1', expiresAt: T0 + HOUR, now: T0 });
  const d = rows.enroll({ codeId: c.id, publicKey: '{}', now: T0 });
  const staff = store.staff()[1]!;
  assert.equal(rows.signIn({ deviceId: d.id, staffMemberId: staff.id, method: 'pin', sessionId: 'sess-1', now: T0 + MINUTE }), 1);
  assert.equal(rows.signIn({ deviceId: d.id, staffMemberId: staff.id, method: 'pin', now: T0 + 2 * MINUTE }), 2);
  assert.equal(num(one(db, 'SELECT max(created_rev) AS r FROM device_sign_ins')?.r), 0);
  assert.equal(store.head(T0).rev, 0, 'a sign-in is a system record (sync 3)');
  assert.equal(rows.device(d.id)?.lastSeenAt, T0 + 2 * MINUTE);
  assert.equal(rows.statusMap().get(d.id), 'active');
  assert.equal(rows.revoke(d.id, 'lost', T0 + 3 * MINUTE), true);
  assert.equal(rows.revoke(d.id, 'lost', T0 + 4 * MINUTE), false);
  assert.equal(rows.statusMap().get(d.id), 'revoked');
  assert.equal(rows.device(d.id)?.revokedAt, T0 + 3 * MINUTE);
});

test('open enrollment makes a device from the chosen kind and van, names it by its short number, and stops at the cap of active open devices', () => {
  const { store, db } = provisioned();
  const rows = store.devices;
  assert.equal(store.isTest(), true);
  const label = (n: number) => '시험 기기 ' + n;
  const badSpec = (e: unknown) => isStoreError(e, 'BAD_SPEC');
  const a = rows.enrollOpen({ kind: 'pos', publicKey: '{"kty":"EC"}', label, cap: 2, now: T0 });
  assert.deepEqual({ kind: a?.kind, label: a?.label, shortNo: a?.shortNo, vehicleId: a?.vehicleId, status: a?.status }, { kind: 'pos', label: '시험 기기 1', shortNo: 1, vehicleId: undefined, status: 'active' });
  assert.equal(str(one(db, 'SELECT registered_by FROM devices WHERE id = ?', a!.id)?.registered_by), OPEN_ENROLL_ACTOR);
  assert.throws(() => rows.enrollOpen({ kind: 'driver_phone', publicKey: '{}', label, cap: 2, now: T0 }), badSpec, 'a driver device needs a van');
  assert.throws(() => rows.enrollOpen({ kind: 'pos', vehicleId: 'v1', publicKey: '{}', label, cap: 2, now: T0 }), badSpec, 'a counter has no van');
  assert.throws(() => rows.enrollOpen({ kind: 'driver_tablet', vehicleId: 'v9', publicKey: '{}', label, cap: 2, now: T0 }), badSpec, 'only a van of the shop');
  const b = rows.enrollOpen({ kind: 'driver_phone', vehicleId: 'v1', publicKey: '{}', label, cap: 2, now: T0 + MINUTE });
  assert.deepEqual({ label: b?.label, shortNo: b?.shortNo, vehicleId: b?.vehicleId }, { label: '시험 기기 2', shortNo: 2, vehicleId: 'v1' });
  assert.equal(rows.openCount(), 2);
  // 끝 수: 아무것도 적지 않는다(기기 번호 셈도 그대로).
  assert.equal(rows.enrollOpen({ kind: 'pos', publicKey: '{}', label, cap: 2, now: T0 + 2 * MINUTE }), null);
  assert.equal(num(one(db, "SELECT value FROM shop_counters WHERE counter_key = 'device_short_no'")?.value), 2);
  assert.equal(num(one(db, 'SELECT count(*) AS n FROM devices')?.n), 2);
  // 번호로 붙은 기기는 세지 않고, 끊은 열린 기기는 자리를 비운다(기기 번호는 다시 쓰지 않는다).
  const c = rows.createCode({ codeHash: sha256('555555555555'), kind: 'pos', label: '카운터 1', expiresAt: T0 + 60 * MINUTE, now: T0 });
  rows.enroll({ codeId: c.id, publicKey: '{}', now: T0 + 3 * MINUTE });
  assert.equal(rows.openCount(), 2);
  assert.equal(rows.revoke(a!.id, 'cli', T0 + 4 * MINUTE), true);
  assert.equal(rows.openCount(), 1);
  const d = rows.enrollOpen({ kind: 'pos', publicKey: '{}', label, cap: 2, now: T0 + 5 * MINUTE });
  assert.deepEqual({ label: d?.label, shortNo: d?.shortNo }, { label: '시험 기기 4', shortNo: 4 });
  assert.equal(rows.find('시험 기기 2')?.id, b!.id, 'revoke-device finds an open device by its label');
});

test('open devices are marked, listed with their sign-ins, revoked together, and unused ones give their place back', () => {
  const { store } = provisioned();
  const rows = store.devices;
  const label = (n: number) => '시험 기기 ' + n;
  const c = rows.createCode({ codeHash: sha256('666666666666'), kind: 'pos', label: '카운터 1', expiresAt: T0 + 60 * MINUTE, now: T0 });
  const coded = rows.enroll({ codeId: c.id, publicKey: '{}', now: T0 });
  assert.equal(coded.openEnrolled, false);
  const a = rows.enrollOpen({ kind: 'pos', publicKey: '{}', label, cap: 30, now: T0 + MINUTE })!;
  const b = rows.enrollOpen({ kind: 'driver_phone', vehicleId: 'v1', publicKey: '{}', label, cap: 30, now: T0 + 2 * MINUTE })!;
  assert.equal(a.openEnrolled, true);
  assert.equal(rows.device(b.id)?.openEnrolled, true);
  rows.signIn({ deviceId: a.id, staffMemberId: store.staff()[0]!.id, method: 'pin', now: T0 + 3 * MINUTE });
  assert.deepEqual(rows.openDevices().map((d) => [d.label, d.kind, d.vehicleId, d.signIns, d.lastSignInAt]), [
    ['시험 기기 2', 'pos', undefined, 1, T0 + 3 * MINUTE],
    ['시험 기기 3', 'driver_phone', 'v1', 0, undefined],
  ]);
  // 한 시간 넘게 로그인하지 않은 열린 기기는 새 기기가 붙을 때 끊긴다(로그인한 기기와 번호 기기는 그대로).
  const d = rows.enrollOpen({ kind: 'pos', publicKey: '{}', label, cap: 30, now: T0 + 2 * HOUR, unusedBefore: T0 + HOUR })!;
  assert.equal(rows.device(b.id)?.status, 'revoked');
  assert.equal(rows.device(a.id)?.status, 'active');
  assert.deepEqual(rows.openDevices().map((x) => x.id), [a.id, d.id]);
  // 모두 끊기: 열린 기기만, 끊긴 것은 다시 세지 않는다.
  assert.deepEqual(rows.revokeOpen('open_enroll_off', T0 + 3 * HOUR), [a.id, d.id]);
  assert.deepEqual(rows.revokeOpen('open_enroll_off', T0 + 3 * HOUR), []);
  assert.equal(rows.openCount(), 0);
  assert.equal(rows.device(coded.id)?.status, 'active', 'a code-enrolled device stays');
});

test('a shop provisioned without --test is not a test shop', () => {
  const db = migrated('shop', ':memory:');
  const store = openShopStore(db, SHOP, { secrets: secrets() });
  store.provision(sampleSpec('first'), T0, { isTest: false });
  assert.equal(store.isTest(), false);
});

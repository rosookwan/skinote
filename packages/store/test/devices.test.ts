// 매장 파일의 기기 행(plan §4-7, D6): 명령줄이 만든(미리 승인한) 12자리 등록 번호로 한 번만 등록, 기기 번호는 셈에서, 로그인 기록은
// rev를 올리지 않음, 끊은 기기는 상태 지도에서 revoked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStoreError, num, one, sha256, str } from '../src/index.ts';
import { MINUTE, provisioned, T0 } from './helpers.ts';

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

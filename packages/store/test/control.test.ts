// control 파일의 행(plan §4-7): 매장 · 직원 계정, 세션(토큰 해시만, 기기째 끊기), 로그인 시도(계정 × 기기로 센다), 등록 번호 길잡이.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStoreError, num, one, openControlStore, sha256 } from '../src/index.ts';
import { migrated, MINUTE, T0 } from './helpers.ts';

const HOUR = 60 * MINUTE;
const setup = () => {
  const db = migrated('control');
  const control = openControlStore(db);
  const { accountIds } = control.provisionTenant({
    shopId: 'shop0test', code: 'sample', name: '우리 스키샵', isTest: true,
    staff: [{ displayName: '한가람', pinHash: 'scrypt$N=16384,r=8,p=1$c2FsdA$aGFzaA' }, { displayName: '오세린', pinHash: null }, { displayName: '문태오', pinHash: null }],
  }, T0);
  return { db, control, accountIds };
};

test('a tenant with staff accounts: login ids per realm, the tenant link, no second provision', () => {
  const { control, accountIds } = setup();
  assert.equal(accountIds.length, 3);
  assert.deepEqual(control.tenant('shop0test'), { id: 'shop0test', code: 'sample', name: '우리 스키샵', dataLocation: 'sqlite:shop-shop0test.sqlite', status: 'active', isTest: true });
  assert.deepEqual(control.accountsOf('shop0test').map((a) => [a.displayName, a.loginRealm, a.loginId]), [['한가람', 'sample', 'staff-1'], ['오세린', 'sample', 'staff-2'], ['문태오', 'sample', 'staff-3']]);
  assert.throws(() => control.provisionTenant({ shopId: 'shop0test', code: 'x', name: 'x', isTest: true, staff: [] }, T0), (e: unknown) => isStoreError(e, 'ALREADY_PROVISIONED'));
});

test('PIN hash rotation resets the failure count; failures count up; success resets', () => {
  const { control, accountIds } = setup();
  const id = accountIds[0]!;
  assert.equal(control.loginFailed(id, T0), 1);
  assert.equal(control.loginFailed(id, T0), 2);
  control.loginSucceeded(id, T0 + MINUTE);
  assert.deepEqual([control.account(id)?.pinFailedCount, control.account(id)?.lastLoginAt], [0, T0 + MINUTE]);
  control.loginFailed(id, T0);
  control.setPinHash(id, 'scrypt$new', T0 + 2 * MINUTE);
  assert.deepEqual([control.account(id)?.pinHash, control.account(id)?.pinFailedCount], ['scrypt$new', 0]);
});

test('sessions: stored by token hash only; touched at most once a minute; one revoke, or every session of one device', () => {
  const { db, control, accountIds } = setup();
  const make = (token: string, device: string) => control.createSession({
    tokenHash: sha256(token), accountId: accountIds[0]!, tenantId: 'shop0test', deviceId: device, staffMemberId: 'st-1', idleTimeoutS: 480 * 60, expiresAt: T0 + 12 * HOUR, now: T0,
  });
  const a = make('token-a', 'dev-a');
  make('token-b', 'dev-a');
  const c = make('token-c', 'dev-b');
  assert.equal(num(one(db, "SELECT count(*) AS n FROM sessions WHERE token_hash = 'token-a'")?.n), 0, 'no raw token');
  assert.equal(control.sessionByTokenHash(sha256('token-a'))?.id, a.id);
  assert.equal(control.touchSession(a.id, T0 + 30_000), false, 'within a minute');
  assert.equal(control.touchSession(a.id, T0 + MINUTE), true);
  assert.equal(control.session(a.id)?.lastUsedAt, T0 + MINUTE);
  assert.equal(control.revokeDeviceSessions('shop0test', 'dev-a', 'device_revoked', T0 + 2 * MINUTE), 2);
  assert.deepEqual(control.openSessionsOfDevice('shop0test', 'dev-a', T0 + 3 * MINUTE), []);
  assert.deepEqual(control.openSessionsOfDevice('shop0test', 'dev-b', T0 + 3 * MINUTE).map((s) => s.id), [c.id], 'another device is untouched');
  assert.equal(control.revokeSession(c.id, 'logout', T0 + 4 * MINUTE), true);
  assert.equal(control.revokeSession(c.id, 'logout', T0 + 5 * MINUTE), false);
  assert.equal(control.session(c.id)?.revokeReason, 'logout');
});

test('the last user agent of a device: newest session that recorded one (the CLI status tells self-registered devices apart)', () => {
  const { control, accountIds } = setup();
  const make = (token: string, device: string, at: number, userAgent?: string) => control.createSession({
    tokenHash: sha256(token), accountId: accountIds[0]!, tenantId: 'shop0test', deviceId: device, staffMemberId: 'st-1', idleTimeoutS: 60, expiresAt: at + HOUR, now: at,
    ...(userAgent !== undefined ? { userAgent } : {}),
  });
  assert.equal(control.lastUserAgent('shop0test', 'dev-a'), undefined);
  make('ua-1', 'dev-a', T0, 'Android Chrome');
  make('ua-2', 'dev-a', T0 + MINUTE, 'Windows Edge');
  make('ua-3', 'dev-a', T0 + 2 * MINUTE);
  make('ua-4', 'dev-b', T0 + 3 * MINUTE, 'iPhone Safari');
  assert.equal(control.lastUserAgent('shop0test', 'dev-a'), 'Windows Edge');
  assert.equal(control.lastUserAgent('shop0test', 'dev-b'), 'iPhone Safari');
  assert.equal(control.lastUserAgent('other', 'dev-a'), undefined);
});

test('login attempts: failures counted per (account, device), per account and per address; a success restarts the count', () => {
  const { control, accountIds } = setup();
  const acc = accountIds[0]!;
  const fail = (device: string, at: number, ip = 'ip-1') => control.recordAttempt({ loginId: 'staff-1', accountId: acc, tenantId: 'shop0test', deviceId: device, method: 'pin', succeeded: false, reason: 'bad_pin', ipHash: ip, now: at });
  for (let i = 0; i < 5; i += 1) fail('dev-a', T0 + i * MINUTE);
  fail('dev-b', T0 + 6 * MINUTE, 'ip-2');
  const since = T0 - 15 * MINUTE;
  assert.equal(control.failuresSince({ accountId: acc, deviceId: 'dev-a', method: 'pin' }, since), 5);
  assert.equal(control.failuresSince({ accountId: acc, deviceId: 'dev-b', method: 'pin' }, since), 1);
  assert.equal(control.failuresSince({ accountId: acc, method: 'pin' }, since), 6);
  assert.equal(control.failuresSince({ ipHash: 'ip-2' }, since), 1);
  assert.equal(control.failuresSince({ accountId: acc, deviceId: 'dev-a' }, T0 + 2 * MINUTE + 1), 2, 'the window');
  control.recordAttempt({ loginId: 'staff-1', accountId: acc, tenantId: 'shop0test', deviceId: 'dev-a', method: 'pin', succeeded: true, reason: 'ok', now: T0 + 7 * MINUTE });
  assert.equal(control.failuresSince({ accountId: acc, deviceId: 'dev-a', method: 'pin' }, since), 0, 'reset by the success on that device');
  assert.equal(control.failuresSince({ accountId: acc, deviceId: 'dev-b', method: 'pin' }, since), 1, 'the other device keeps its count');
});

test('login attempts can be counted over a set of devices, or leaving a set out (open-enrolled devices counted as one)', () => {
  const { control, accountIds } = setup();
  const acc = accountIds[0]!;
  const fail = (device: string | undefined, at: number) => control.recordAttempt({
    loginId: 'staff-1', accountId: acc, tenantId: 'shop0test', ...(device ? { deviceId: device } : {}), method: 'pin', succeeded: false, reason: 'bad_pin', now: at,
  });
  fail('open-1', T0);
  fail('open-2', T0 + MINUTE);
  fail('open-3', T0 + 2 * MINUTE);
  fail('code-1', T0 + 3 * MINUTE);
  fail(undefined, T0 + 4 * MINUTE);
  const since = T0 - 15 * MINUTE;
  const pool = ['open-1', 'open-2', 'open-3'];
  assert.equal(control.failuresSince({ accountId: acc, deviceIds: pool, method: 'pin' }, since), 3);
  assert.equal(control.failuresSince({ deviceIds: pool, method: 'pin' }, since), 3);
  assert.equal(control.failuresSince({ accountId: acc, deviceIds: [], method: 'pin' }, since), 0, 'an empty set matches nothing');
  assert.equal(control.failuresSince({ accountId: acc, notDeviceIds: pool, method: 'pin' }, since), 2, 'the rest, attempts without a device included');
  assert.equal(control.failuresSince({ accountId: acc, notDeviceIds: [], method: 'pin' }, since), 5);
  control.recordAttempt({ loginId: 'staff-1', accountId: acc, tenantId: 'shop0test', deviceId: 'open-2', method: 'pin', succeeded: true, reason: 'ok', now: T0 + 5 * MINUTE });
  assert.equal(control.failuresSince({ accountId: acc, deviceIds: pool, method: 'pin' }, since), 0, 'a success on one device of the set restarts the set');
  assert.equal(control.failuresSince({ accountId: acc, notDeviceIds: pool, method: 'pin' }, since), 2, 'the rest keeps its count');
  assert.equal(control.failureCount({ deviceIds: pool, method: 'pin' }, since), 3, 'failureCount counts every failure, successes or not');
  assert.equal(control.failureCount({ deviceIds: pool, method: 'pin' }, T0 + MINUTE), 1, 'after since only');
});

test('enrollment routes: a code hash routes to one shop code id; claim and use stamp once', () => {
  const { control } = setup();
  control.insertRoute({ codeHash: sha256('123456789012'), tenantId: 'shop0test', codeId: 'code-1', expiresAt: T0 + HOUR, now: T0 });
  assert.deepEqual(control.route(sha256('123456789012')), { codeHash: sha256('123456789012'), tenantId: 'shop0test', codeId: 'code-1', expiresAt: T0 + HOUR });
  assert.throws(() => control.insertRoute({ codeHash: sha256('123456789012'), tenantId: 'shop0test', codeId: 'code-2', expiresAt: T0 + HOUR, now: T0 }), /UNIQUE|PRIMARY/);
  control.claimRoute(sha256('123456789012'), T0 + MINUTE);
  control.useRoute(sha256('123456789012'), T0 + 2 * MINUTE);
  control.useRoute(sha256('123456789012'), T0 + 3 * MINUTE);
  const r = control.route(sha256('123456789012'));
  assert.deepEqual([r?.claimedAt, r?.usedAt], [T0 + MINUTE, T0 + 2 * MINUTE]);
});

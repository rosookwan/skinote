// @ts-check
// 기사 기기의 연결 셈(work/impl-offline/plan.md O11, 가짜 시계): 60초 조용하면 끊김, 숨긴 화면의 대기 0 알림 뒤 조용하면 조용함(표시 없음), 대기가
// 남은 알림 뒤 조용하면 끊김, 대기가 오래 남으면 전송 대기(약한 신호), 돌아온 뒤 10초 이어지거나 대기 0이어야 연결됨(깜빡임 없음), 한 차량의 태블릿 ·
// 휴대폰은 가장 나쁜 쪽, 깨끗한 로그아웃은 쉼(idle), 세션 없이 대기가 남으면 끊김, 차량 셈이 바뀌면 linkRev가 오르고, 다시 띄우면 표의 사실로 다시 센다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeviceLinks } from '../src/device-links.js';

const SHOP = 'shop0test';
const phone = { id: 'dev-phone', kind: 'driver_phone', label: '1호 차량 휴대폰', vehicleId: 'v1' };
const tablet = { id: 'dev-tablet', kind: 'driver_tablet', label: '1호 차량 태블릿', vehicleId: 'v1' };
/** @param {Partial<import('@skinote/contract').DeviceReport>} over @returns {import('@skinote/contract').DeviceReport} */
const report = (over = {}) => ({
  pendingCount: 0, unconfirmedCount: 0, lastSeq: 0, clockOffsetMs: 0, appVersion: 'test', offlineCapable: true, localFirst: true, visibility: 'visible', unreadable: 0, ...over,
});

function setup() {
  const clock = { t: Date.parse('2026-12-26T12:00:00.000Z') };
  /** @type {string[]} */
  const changes = [];
  /** @type {{ deviceId: string, pending: number }[]} */
  const persisted = [];
  const links = createDeviceLinks({
    nowMs: () => clock.t, onChange: shopId => changes.push(shopId),
    persist: (_shop, deviceId, r) => persisted.push({ deviceId, pending: r.pendingCount }),
  });
  const van = () => links.vehicleLinks(SHOP, clock.t).find(l => l.vehicleId === 'v1');
  return { clock, links, changes, persisted, van };
}

test('online → offline after 60 s of silence; since = the last contact; linkRev and onChange follow', () => {
  const { clock, links, changes, van } = setup();
  links.report(SHOP, phone, report());
  assert.equal(van()?.state, 'online');
  const rev = links.linkRev(SHOP);
  clock.t += 59_000;
  links.sweep();
  assert.equal(van()?.state, 'online');
  clock.t += 2_000;
  links.sweep();
  assert.equal(van()?.state, 'offline');
  assert.equal(van()?.since, new Date(clock.t - 61_000).toISOString());
  assert.equal(van()?.reportedPending, 0);
  assert.ok(links.linkRev(SHOP) > rev);
  assert.ok(changes.length >= 2);
});

test('a hidden report with nothing pending then silence = asleep; a hidden report with pending = offline', () => {
  const { clock, links, van } = setup();
  links.report(SHOP, phone, report({ visibility: 'hidden' }));
  clock.t += 120_000;
  assert.equal(van()?.state, 'asleep');
  links.report(SHOP, phone, report({ visibility: 'hidden', pendingCount: 2, oldestPendingAt: new Date(clock.t - 5_000).toISOString() }));
  clock.t += 120_000;
  assert.equal(van()?.state, 'offline');
  assert.equal(van()?.reportedPending, 2);
  assert.equal(van()?.since, new Date(clock.t - 125_000).toISOString(), 'since = the oldest pending item, not the last flap');
});

test('stuck: in contact but pending older than two heartbeats, or a stuck item', () => {
  const { clock, links, van } = setup();
  links.report(SHOP, phone, report({ pendingCount: 3, oldestPendingAt: new Date(clock.t - 10_000).toISOString() }));
  assert.equal(van()?.state, 'online');
  links.report(SHOP, phone, report({ pendingCount: 3, oldestPendingAt: new Date(clock.t - 45_000).toISOString() }));
  assert.equal(van()?.state, 'stuck');
  links.report(SHOP, phone, report({ stuckSeq: 7 }));
  assert.equal(van()?.state, 'stuck');
});

test('hysteresis: back from offline with pending needs 10 s of contact or a zero report', () => {
  const { clock, links, van } = setup();
  links.report(SHOP, phone, report({ pendingCount: 2, oldestPendingAt: new Date(clock.t).toISOString() }));
  clock.t += 70_000;
  links.sweep();
  assert.equal(van()?.state, 'offline');
  links.touch(SHOP, phone);
  assert.equal(van()?.state, 'offline', 'one contact is not enough');
  clock.t += 11_000;
  links.touch(SHOP, phone);
  assert.notEqual(van()?.state, 'offline');
  clock.t += 70_000;
  links.sweep();
  links.report(SHOP, phone, report({ pendingCount: 0 }));
  assert.equal(van()?.state, 'online', 'a zero report brings it back at once');
});

test('a parked tablet cannot hide the phone in the mountains: the van takes the worst device', () => {
  const { clock, links, van } = setup();
  links.report(SHOP, phone, report({ pendingCount: 12, oldestPendingAt: new Date(clock.t).toISOString() }));
  clock.t += 90_000;
  links.report(SHOP, tablet, report());
  assert.equal(van()?.state, 'offline');
  assert.equal(van()?.deviceKind, 'driver_phone');
  assert.equal(van()?.reportedPending, 12);
  assert.deepEqual(links.vanPendingElsewhere(SHOP, 'v1', tablet.id), { deviceKind: 'driver_phone', pending: 12, label: '1호 차량 휴대폰' });
  assert.equal(links.vanPendingElsewhere(SHOP, 'v1', phone.id), undefined);
});

test('the other device is named: its label and the staff member who last signed in on it (§17 R3-28, two personal phones on one van)', () => {
  const { clock, links } = setup();
  const second = { id: 'dev-phone-2', kind: 'driver_phone', label: '1호 차량 휴대폰', vehicleId: 'v1' };
  links.touch(SHOP, { ...phone, staffName: '박기사' });
  links.report(SHOP, phone, report({ pendingCount: 3, oldestPendingAt: new Date(clock.t).toISOString() }));
  // 세션 없는 알림(전달)은 직원 이름을 지우지 않는다.
  links.report(SHOP, phone, report({ pendingCount: 3 }), { session: false });
  assert.deepEqual(links.vanPendingElsewhere(SHOP, 'v1', second.id), { deviceKind: 'driver_phone', pending: 3, label: '1호 차량 휴대폰', staffName: '박기사' });
});

test('a clean logout is idle; no session but pending stays offline; a revoked device with pending stays offline', () => {
  const { clock, links, van } = setup();
  links.report(SHOP, phone, report());
  links.sessionEnded(SHOP, phone.id);
  clock.t += 120_000;
  assert.equal(van()?.state, 'idle');
  links.report(SHOP, phone, report({ pendingCount: 1 }), { session: false });
  links.sessionEnded(SHOP, phone.id);
  clock.t += 120_000;
  assert.equal(van()?.state, 'offline');
  const facts = links.facts(SHOP);
  assert.deepEqual(facts.map(f => [f.vehicleId, f.state, f.reportedPending]), [['v1', 'offline', 1]]);
  links.revoked(SHOP, phone.id);
  assert.equal(van()?.state, 'offline');
});

test('persist: at most once a minute per device, and at once when pending crosses zero', () => {
  const { clock, links, persisted } = setup();
  links.report(SHOP, phone, report());
  clock.t += 20_000;
  links.report(SHOP, phone, report());
  assert.equal(persisted.length, 1);
  clock.t += 5_000;
  links.report(SHOP, phone, report({ pendingCount: 1 }));
  assert.equal(persisted.length, 2, 'crossing zero is written at once');
  clock.t += 70_000;
  links.report(SHOP, phone, report({ pendingCount: 1 }));
  assert.equal(persisted.length, 3);
});

test('restart: rebuilt from the written facts and the open sessions', () => {
  const { clock, links, van } = setup();
  links.restore(SHOP, [
    { deviceId: phone.id, kind: 'driver_phone', vehicleId: 'v1', label: phone.label, status: 'active', lastSeenAt: clock.t - 300_000, queueDepth: 4, lastSeq: 9 },
    { deviceId: 'counter', kind: 'pos', label: '카운터 1', status: 'active', lastSeq: 0 },
  ], new Set([phone.id]));
  assert.equal(van()?.state, 'offline');
  assert.equal(van()?.reportedPending, 4);
  const quiet = setup();
  quiet.links.restore(SHOP, [{ deviceId: phone.id, kind: 'driver_phone', vehicleId: 'v1', label: phone.label, status: 'active', lastSeenAt: quiet.clock.t - 300_000, queueDepth: 0, lastSeq: 9 }], new Set([phone.id]));
  assert.equal(quiet.van()?.state, 'asleep', 'a device that last said nothing was pending is treated as a pocketed phone');
});

test('pendingCount already holds the unconfirmed records: three records, two of them unconfirmed, show as 3 (§18 R4-7)', () => {
  const { clock, links, van } = setup();
  links.report(SHOP, phone, report({ pendingCount: 3, unconfirmedCount: 2, oldestPendingAt: new Date(clock.t).toISOString() }));
  clock.t += 10 * 60_000;
  links.sweep();
  assert.equal(van()?.state, 'offline');
  assert.equal(van()?.reportedPending, 3);
});

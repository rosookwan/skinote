// @ts-check
// 보류된 기사 기록의 공급자 길(work/impl-offline/plan.md O21)과 끊을 때의 대기 알림: 보낼 기록 3건을 알린 기사 기기도 revoke-device가 묻지 않고
// 끊고 그 수를 알림 줄로 보인다(§17 R3-14: 그 수는 기기가 정한다). 끊은 기기가 세션 없이 전달한 기록은 보류(revoked)되고, 명령줄 held --list가 본문
// 없이 보이고, --apply가 그 자리에서 적용하고, --dismiss가 미반영으로 정한다(행은 보류로 남고 목록의 미반영 칸).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { canonicalJson, commandMessage, deliverMessage, newRequestId, unsignedItem } from '@skinote/contract';
import { kstAt } from '@skinote/domain';
import { openDatabase } from '@skinote/schema';
import { startServer } from '../src/server.js';
import { cli, device, deviceCode, ORIGIN, provisionedShop, SHOP, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

const report = (/** @type {number} */ pending) => ({
  pendingCount: pending, unconfirmedCount: 0, lastSeq: 2, clockOffsetMs: 0, appVersion: 'test', offlineCapable: true, localFirst: true, visibility: 'visible', unreadable: 0,
});

test('revoke-device revokes a driver device that reported pending records and prints the count; delivered records of a revoked device are held and the supplier applies or dismisses them', async () => {
  const dataDir = join(temp.dir, 'held');
  const shop = await provisionedShop(dataDir);
  const clock = { t: kstAt('2026-12-26', 0, 21, 0) };
  assert.equal((await cli(['load-sample', '--shop', SHOP, '--date', 'today'], shop.env, { now: () => clock.t })).code, 0);
  const code = await deviceCode(shop.env, ['--kind', 'driver_phone', '--label', '1호차 휴대폰', '--vehicle', 'v1'], () => clock.t);
  let app = await startServer(testConfig(dataDir, shop.env), { log: () => {}, now: () => new Date(clock.t), sleep: async () => {} });
  const driver = device(app.port);
  assert.equal((await driver.enroll(code)).status, 200);
  const login = await driver.login('박기사', /** @type {string} */ (shop.pins['박기사']));
  const info = await login.json();
  clock.t += 5_000;
  assert.equal((await driver.post('/api/v2/heartbeat', { report: report(3) })).status, 200);
  const head = await (await driver.get('/api/v2/head')).json();
  const rows = (await (await driver.query('ledgerView', { viewKey: 'collection_list' })).json()).rows.filter((/** @type {any} */ r) => r.taskId);
  const item = async (/** @type {number} */ seq, /** @type {string} */ taskId) => {
    const x = {
      type: 'task.visit', commandVersion: 1, requestId: newRequestId(clock.t + seq), deviceSeq: seq, ageMs: 1_000, clockAnchor: 'mono-abcdefgh', madeAt: new Date(clock.t - 1_000).toISOString(),
      basis: { epoch: head.epoch, rev: head.rev }, dependsOn: [], recordedBy: { staffId: info.staff.id, sessionId: info.session.id, signature: 'A'.repeat(86) },
      payload: { taskId, outcomeKey: 'customer_absent' },
    };
    const hash = createHash('sha256').update(canonicalJson(unsignedItem(x)), 'utf8').digest('base64url');
    x.recordedBy.signature = await /** @type {NonNullable<typeof driver.state.key>} */ (driver.state.key).sign(commandMessage(ORIGIN, driver.state.deviceId, seq, hash));
    return x;
  };
  const items = [await item(1, rows[0].taskId), await item(2, rows[1].taskId)];
  await app.close();

  // 서버가 멈춘 동안의 명령줄: 표에 적힌 대기 3건 → 묻지 않고 끊고 그 수를 알림 줄로(--force 없이).
  const revoked = await cli(['revoke-device', '--shop', SHOP, '--device', driver.state.deviceId], shop.env, { now: () => clock.t });
  assert.equal(revoked.code, 0, revoked.err);
  assert.match(revoked.out, /끊음/);
  assert.match(revoked.out, /보낼 기록 3건/);
  const again1 = await cli(['revoke-device', '--shop', SHOP, '--device', driver.state.deviceId, '--force'], shop.env, { now: () => clock.t });
  assert.equal(again1.code, 0, again1.err);
  assert.match(again1.out, /이미 끊겨 있음/);

  // 끊은 기기의 전달: 보류(revoked) + 지움.
  app = await startServer(testConfig(dataDir, shop.env), { log: () => {}, now: () => new Date(clock.t), sleep: async () => {} });
  const again = device(app.port);
  Object.assign(again.state, { deviceId: driver.state.deviceId, key: driver.state.key });
  const challenge = await (await again.post('/api/v2/device/challenge', { deviceId: driver.state.deviceId })).json();
  const signature = await /** @type {NonNullable<typeof driver.state.key>} */ (driver.state.key).sign(deliverMessage(ORIGIN, driver.state.deviceId, challenge.nonce));
  const delivered = await (await again.post('/api/v2/device/deliver', { deviceId: driver.state.deviceId, nonce: challenge.nonce, signature, report: report(2), commands: items }, { csrf: false })).json();
  assert.deepEqual(delivered.results.map((/** @type {any} */ r) => r.outcome), ['held', 'held']);
  assert.equal(delivered.device.wipe, true);
  await app.close();

  // 목록(본문 없음) → 하나 반영 · 하나 미반영.
  const list = await cli(['held', '--shop', SHOP, '--list'], shop.env, { now: () => clock.t });
  assert.equal(list.code, 0, list.err);
  const lines = list.out.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.slice(1).every(l => l.includes('revoked') && l.includes('1호차 휴대폰') && l.includes('task.visit')));
  assert.ok(!list.out.includes('customer_absent'), 'no payload in the list');
  const applied = await cli(['held', '--shop', SHOP, '--apply', items[0].requestId], shop.env, { now: () => clock.t });
  assert.equal(applied.code, 0, applied.err);
  assert.match(applied.out, /반영 · applied/);
  const dismissed = await cli(['held', '--shop', SHOP, '--dismiss', items[1].requestId], shop.env, { now: () => clock.t });
  assert.equal(dismissed.code, 0, dismissed.err);
  const after2 = await cli(['held', '--shop', SHOP, '--list'], shop.env, { now: () => clock.t });
  const left = after2.out.trim().split('\n').slice(1);
  assert.equal(left.length, 1);
  assert.ok(left[0]?.endsWith('\t예'), 'the dismissed record stays held and is marked');
  assert.equal((await cli(['held', '--shop', SHOP, '--apply', items[1].requestId], shop.env, { now: () => clock.t })).code, 65, 'a dismissed record is not applied');
  const db = openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'));
  try {
    const row = /** @type {any} */ (db.prepare('SELECT status_key AS s, applied_rev AS r, result_expires_at AS x FROM command_log WHERE request_id = ?').get(items[0].requestId));
    assert.equal(row.s, 'applied');
    assert.ok(row.r > 0);
    assert.notEqual(row.x, '9999-12-31T00:00:00.000Z');
  } finally {
    db.close();
  }
});

test('delivery without a session: an expired session applies; a session ended by a PIN change applies with unverified_sign_in', async () => {
  const dataDir = join(temp.dir, 'expired');
  const shop = await provisionedShop(dataDir);
  const clock = { t: kstAt('2026-12-26', 0, 21, 0) };
  assert.equal((await cli(['load-sample', '--shop', SHOP, '--date', 'today'], shop.env, { now: () => clock.t })).code, 0);
  const code = await deviceCode(shop.env, ['--kind', 'driver_phone', '--label', '1호차 휴대폰', '--vehicle', 'v1'], () => clock.t);
  const app = await startServer(testConfig(dataDir, shop.env), { log: () => {}, now: () => new Date(clock.t), sleep: async () => {} });
  try {
    const driver = device(app.port);
    assert.equal((await driver.enroll(code)).status, 200);
    const info = await (await driver.login('박기사', /** @type {string} */ (shop.pins['박기사']))).json();
    clock.t += 5_000;
    const head = await (await driver.get('/api/v2/head')).json();
    const rows = (await (await driver.query('ledgerView', { viewKey: 'collection_list' })).json()).rows.filter((/** @type {any} */ r) => r.taskId);
    const item = async (/** @type {number} */ seq, /** @type {string} */ taskId, /** @type {string} */ sessionId, ageMs = 1_000) => {
      const x = {
        type: 'task.visit', commandVersion: 1, requestId: newRequestId(clock.t + seq), deviceSeq: seq, ageMs, clockAnchor: 'wall-abcdefgh', madeAt: new Date(clock.t - ageMs).toISOString(),
        basis: { epoch: head.epoch, rev: head.rev }, dependsOn: [], recordedBy: { staffId: info.staff.id, sessionId, signature: 'A'.repeat(86) },
        payload: { taskId, outcomeKey: 'customer_absent' },
      };
      const hash = createHash('sha256').update(canonicalJson(unsignedItem(x)), 'utf8').digest('base64url');
      x.recordedBy.signature = await /** @type {NonNullable<typeof driver.state.key>} */ (driver.state.key).sign(commandMessage(ORIGIN, driver.state.deviceId, seq, hash));
      return x;
    };
    const deliver = async (/** @type {any[]} */ commands) => {
      const challenge = await (await driver.post('/api/v2/device/challenge', { deviceId: driver.state.deviceId })).json();
      const signature = await /** @type {NonNullable<typeof driver.state.key>} */ (driver.state.key).sign(deliverMessage(ORIGIN, driver.state.deviceId, challenge.nonce));
      return (await driver.post('/api/v2/device/deliver', { deviceId: driver.state.deviceId, nonce: challenge.nonce, signature, report: report(commands.length), commands }, { csrf: false })).json();
    };
    // 1) 비밀번호 바꿈으로 끝난 세션: 적용 + 미확인 로그인.
    const first = await item(1, rows[0].taskId, info.session.id);
    // 비밀번호 바꿈(명령줄 rotate-pin · 재발급)이 끝낸 세션: 서버가 도는 시험이라 control 파일에서 직접 끝낸다.
    const db = openDatabase(join(dataDir, 'db', 'control.sqlite'));
    try {
      db.prepare("UPDATE sessions SET revoked_at = ?, revoke_reason = 'pin_reset' WHERE id = ?").run(new Date(clock.t).toISOString(), info.session.id);
    } finally {
      db.close();
    }
    const pinReset = await deliver([first]);
    assert.deepEqual(pinReset.results.map((/** @type {any} */ r) => [r.outcome, r.reviews.includes('unverified_sign_in')]), [['applied', true]]);
    // 2) 다시 로그인한 세션(14일)이 끊긴 사이에 끝남: 끝나기 한 시간 전에 적은 기록을 끝난 뒤에 보내면 적용(확인 필요 없음).
    const info2 = await (await driver.login('박기사', /** @type {string} */ (shop.pins['박기사']))).json();
    clock.t += 14 * 24 * 3_600_000 - 3_600_000;
    const madeAt = clock.t;
    clock.t += 2 * 3_600_000;
    const second = await item(2, rows[1].taskId, info2.session.id, clock.t - madeAt);
    const expired = await deliver([second]);
    assert.deepEqual(expired.results.map((/** @type {any} */ r) => [r.outcome, r.reviews]), [['applied', []]]);
  } finally {
    await app.close();
  }
});

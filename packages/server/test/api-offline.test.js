// @ts-check
// 기사 기기의 연결 끊김 기록 길(work/impl-offline/plan.md §4 · §6-3) — 진짜 매장 파일 · 가짜 시계:
//   - 심장 박동 · 사본은 기사 기기만(카운터 403), 운영 값, 같은 해시는 unchanged, 설정은 처음만, 개인정보 열람은 기기 · 직원 · 차량 · 영업일마다(새 접수 ·
//     새 온전한 번호 두 줄, §17 R3-12).
//   - 묶음: 받은 그대로 해시한 서명(기기 열쇠), 기기 번호 차례, 같은 요청은 첫 결과, 같은 번호의 다른 요청은 SEQ_REUSED, 묶음 안의 같은 요청은 한 번,
//     나쁜 서명은 적용 + `공급자 확인 중` + ALERT 줄, 모양이 틀린 항목은 보류, 큰 항목은 BAD_INPUT, 51개 · CSRF 없음 · 카운터는 길에서 거절.
//   - 카운터: 조용한 차량의 수거 목록 표시 · 머리의 linkRev · 막힌 마감, 관리자 승인(자기 비밀번호) → 마감 적용(사유 · 정규 차량 연결), 답을 잃은 재전송은
//     첫 결과, 다른 요청의 같은 승인은 APPROVAL_INVALID, 카운터 역할은 승인 403.
//   - 세션 없는 전달: 로그아웃한 세션의 기록은 보류, 시간이 끝난 세션은 적용, 끊은 기기는 보류 + wipe.
//   - 기록 줄에 비밀번호 · 서명이 없다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { canonicalJson, commandMessage, deliverMessage, newRequestId, unsignedItem } from '@skinote/contract';
import { kstAt } from '@skinote/domain';
import { openDatabase } from '@skinote/schema';
import { startServer } from '../src/server.js';
import { cli, collectLog, device, deviceCode, ORIGIN, provisionedShop, SHOP, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

/** @param {Partial<import('@skinote/contract').DeviceReport>} [over] @returns {import('@skinote/contract').DeviceReport} */
const report = (over = {}) => ({
  pendingCount: 0, unconfirmedCount: 0, lastSeq: 0, clockOffsetMs: 0, appVersion: 'test', offlineCapable: true, localFirst: true, visibility: 'visible', unreadable: 0, ...over,
});

/**
 * 서명한 보냄 대기 항목(받은 그대로 해시하는 서버와 같은 셈).
 * @param {ReturnType<typeof device>} dev @param {any} info 로그인 답(SessionInfo) @param {{ type: string, payload: unknown, seq: number, basis: { epoch: string, rev: number }, now: number, ageMs?: number, requestId?: string }} x
 */
async function signed(dev, info, x) {
  const item = {
    type: x.type, commandVersion: 1, requestId: x.requestId ?? newRequestId(x.now + x.seq), deviceSeq: x.seq, ageMs: x.ageMs ?? 1_000, clockAnchor: 'mono-abcdefgh',
    madeAt: new Date(x.now - (x.ageMs ?? 1_000)).toISOString(), basis: x.basis, dependsOn: [],
    recordedBy: { staffId: info.staff.id, sessionId: info.session.id, signature: 'A'.repeat(86) },
    payload: x.payload,
  };
  const hash = createHash('sha256').update(canonicalJson(unsignedItem(item)), 'utf8').digest('base64url');
  const key = /** @type {NonNullable<typeof dev.state.key>} */ (dev.state.key);
  item.recordedBy.signature = await key.sign(commandMessage(ORIGIN, dev.state.deviceId, x.seq, hash));
  return item;
}

describe('driver offline routes on the real shop file', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let app;
  /** @type {ReturnType<typeof device>} */ let driver;
  /** @type {ReturnType<typeof device>} */ let counter;
  /** @type {ReturnType<typeof device>} */ let manager;
  /** @type {any} */ let driverInfo;
  /** @type {Record<string, string>} */ let pins = {};
  /** @type {Record<string, string>} */ let env = {};
  let dataDir = '';
  const clock = { t: kstAt('2026-12-26', 0, 21, 0) };
  const logs = collectLog();

  /** @param {(db: any) => unknown} read */
  const shopFile = read => {
    const db = openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'));
    try { return read(/** @type {any} */ (db)); } finally { db.close(); }
  };
  const head = async () => (await (await counter.get('/api/v2/head')).json());
  /** @param {string} viewKey */
  const driverRows = async viewKey => (await (await driver.query('ledgerView', { viewKey })).json()).rows;

  before(async () => {
    dataDir = join(temp.dir, 'offline');
    const shop = await provisionedShop(dataDir);
    env = shop.env;
    pins = shop.pins;
    const sample = await cli(['load-sample', '--shop', SHOP, '--date', 'today'], env, { now: () => clock.t });
    assert.equal(sample.code, 0, sample.err);
    const codes = [
      await deviceCode(env, ['--kind', 'driver_phone', '--label', '1호차 휴대폰', '--vehicle', 'v1'], () => clock.t),
      await deviceCode(env, ['--kind', 'pos', '--label', '카운터 1'], () => clock.t),
      await deviceCode(env, ['--kind', 'pos', '--label', '카운터 2'], () => clock.t),
    ];
    app = await startServer(testConfig(dataDir, env), { log: logs.log, now: () => new Date(clock.t), sleep: async () => {} });
    driver = device(app.port);
    counter = device(app.port);
    manager = device(app.port);
    assert.equal((await driver.enroll(/** @type {string} */ (codes[0]))).status, 200);
    assert.equal((await counter.enroll(/** @type {string} */ (codes[1]))).status, 200);
    assert.equal((await manager.enroll(/** @type {string} */ (codes[2]))).status, 200);
    const login = await driver.login('박기사', /** @type {string} */ (pins['박기사']));
    assert.equal(login.status, 200);
    driverInfo = await login.json();
    assert.equal((await counter.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200);
    assert.equal((await manager.login('정하늘', /** @type {string} */ (pins['정하늘']))).status, 200);
    // 기록은 로그인 뒤에 만든다(행위자 확인: 그때 이 기기에 로그인한 직원).
    clock.t += 5_000;
  });
  after(async () => { await app?.close(); });

  test('the driver session answer carries the session id, the van and the offline policy', () => {
    assert.match(driverInfo.session.id, /^[0-9A-Z]{26}$/);
    assert.equal(driverInfo.vehicleId, 'v1');
    assert.deepEqual(driverInfo.policy, {
      localFirst: true, heartbeatMs: 20_000, piiWipeHours: 24, sentPiiHours: 24, sentLogDays: 7, appLockMinutes: 5, maxBackdateHours: 168, futureSkewMinutes: 5, clockWarnMinutes: 2,
    });
  });

  test('heartbeat and snapshot: driver devices only; unchanged by hash; config only once; working_copy rows per device · staff · vehicle · date', async () => {
    const beat = await driver.post('/api/v2/heartbeat', { report: report() });
    assert.equal(beat.status, 200);
    const b = await beat.json();
    assert.deepEqual(Object.keys(b).sort(), ['configRev', 'currentBusinessDate', 'epoch', 'heartbeatMs', 'linkRev', 'policy', 'restoredUpToRev', 'rev', 'serverTime']);
    assert.equal((await counter.post('/api/v2/heartbeat', { report: report() })).status, 403);
    assert.equal((await driver.post('/api/v2/heartbeat', { report: { ...report(), phone: '01000000000' } })).status, 400);
    assert.equal((await driver.post('/api/v2/heartbeat', { report: report() }, { csrf: false })).status, 403, 'CSRF');

    const first = await driver.post('/api/v2/snapshot', { fromSeq: 1, pendingTaskIds: [], onlinePending: [], report: report() });
    assert.equal(first.status, 200);
    const s1 = await first.json();
    assert.equal(s1.unchanged, false);
    assert.ok(s1.state && s1.config, 'the first copy carries the state and the config');
    assert.equal(s1.scope.vehicleId, 'v1');
    assert.match(s1.hash, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(s1.state.orders.length > 0);
    // 온전한 번호는 오늘 열린 1호 차량 업무의 접수만, 직원은 이 사람만, 확인 필요는 싣지 않는다.
    assert.deepEqual(s1.state.staff.map((/** @type {any} */ x) => x.name), ['박기사']);
    assert.deepEqual(s1.state.reviews, []);
    assert.ok(s1.state.orders.every((/** @type {any} */ o) => o.phone === '' || /^010-0000-\d{4}$/.test(o.phone) || o.phone.includes('*')));
    const rows = () => /** @type {any[]} */ (shopFile(db => db.prepare("SELECT action_key AS a, subject_type AS s, subject_id AS i, item_count AS n FROM pii_access_log WHERE action_key = 'working_copy'").all()));
    // 새 접수 수 한 줄 + 새 온전한 번호 수 한 줄(§17 R3-12).
    assert.deepEqual(rows().map(r => [r.s, r.i]), [['copy', 'v1:2026-12-26'], ['copy', 'v1:2026-12-26:full']]);
    assert.equal(rows()[0].n, s1.state.orders.length);
    const again = await (await driver.post('/api/v2/snapshot', { known: { epoch: s1.epoch, rev: s1.rev, hash: s1.hash, configRev: s1.configRev }, fromSeq: 1, pendingTaskIds: [], onlinePending: [], report: report() })).json();
    assert.equal(again.unchanged, true);
    assert.equal(again.state, undefined);
    assert.equal(again.config, undefined);
    assert.equal(rows().length, 2, 'an unchanged copy writes no row');
    assert.equal((await counter.post('/api/v2/snapshot', { fromSeq: 1, pendingTaskIds: [], onlinePending: [], report: report() })).status, 403);
  });

  test('batch: signed items in device order, first results on resend, SEQ_REUSED, in-batch duplicates, flags, holds and limits', async () => {
    const h = await head();
    const basis = { epoch: h.epoch, rev: h.rev };
    const rows = (await driverRows('collection_list')).filter((/** @type {any} */ r) => r.taskId);
    const [a, b, c] = rows;
    assert.ok(a && b && c, 'the sample day gives three collect tasks on van 1');
    const visit = (/** @type {any} */ row, /** @type {number} */ seq, /** @type {Record<string, unknown>} */ over = {}) =>
      signed(driver, driverInfo, { type: 'task.visit', payload: { taskId: row.taskId, outcomeKey: 'customer_absent' }, seq, basis, now: clock.t, ...over });
    const i2 = await visit(b, 2);
    const i1 = await visit(a, 1);
    const res = await driver.post('/api/v2/commands:batch', { report: report({ pendingCount: 2, lastSeq: 2 }), commands: [i2, i1, i1] });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.deepEqual(out.results.map((/** @type {any} */ r) => [r.deviceSeq, r.outcome, r.timeSource]), [[1, 'applied', 'monotonic'], [1, 'applied', 'monotonic'], [2, 'applied', 'monotonic']]);
    assert.equal(out.results[0].rev, out.results[1].rev, 'the in-batch duplicate answers the first result');
    assert.deepEqual(out.device, { highWater: 2, missing: [] });
    const logRows = /** @type {any[]} */ (shopFile(db => db.prepare('SELECT device_seq AS s, time_source_key AS t, actor_signature AS g FROM command_log WHERE device_id = ? ORDER BY device_seq').all(driver.state.deviceId)));
    assert.deepEqual(logRows.map(r => [r.s, r.t, typeof r.g]), [[1, 'monotonic', 'string'], [2, 'monotonic', 'string']]);
    // 다시 보냄: 첫 결과.
    const resend = await (await driver.post('/api/v2/commands:batch', { report: report(), commands: [i1, i2] })).json();
    assert.deepEqual(resend.results.map((/** @type {any} */ r) => r.rev), [out.results[0].rev, out.results[2].rev]);
    // 같은 번호의 다른 요청.
    const clash = await visit(c, 2);
    assert.deepEqual((await (await driver.post('/api/v2/commands:batch', { report: report(), commands: [clash] })).json()).results.map((/** @type {any} */ r) => r.error?.code), ['SEQ_REUSED']);
    // 나쁜 서명: 적용 + `공급자 확인 중` + ALERT 줄.
    const forged = await visit(c, 3);
    forged.payload = { ...forged.payload, outcomeKey: 'place_changed' };
    const flagged = (await (await driver.post('/api/v2/commands:batch', { report: report(), commands: [forged] })).json()).results[0];
    assert.equal(flagged.outcome, 'applied');
    assert.ok(flagged.reviews.includes('command_held'));
    assert.ok(logs.lines.some(l => l.startsWith('ALERT offline BAD_SIGNATURE ' + SHOP + ' ' + driver.state.deviceId + ' 3')));
    // 모양이 틀린 항목: 보류(적용하지 않음, 봉투는 먼 끝까지).
    const broken = await visit(c, 4);
    broken.payload = { taskId: c.taskId };
    const held = (await (await driver.post('/api/v2/commands:batch', { report: report(), commands: [broken] })).json()).results[0];
    assert.equal(held.outcome, 'held');
    assert.equal(/** @type {any} */ (shopFile(db => db.prepare('SELECT result_expires_at AS x FROM command_log WHERE request_id = ?').get(broken.requestId))).x, '9999-12-31T00:00:00.000Z');
    // 큰 항목 · 51개 · CSRF 없음 · 카운터.
    const big = await visit(c, 5, { requestId: newRequestId(clock.t + 99) });
    /** @type {any} */ (big.payload).taskId = 'collect:' + 'x'.repeat(90);
    /** @type {any} */ (big).pad = 'y'.repeat(9_000);
    assert.deepEqual((await (await driver.post('/api/v2/commands:batch', { report: report(), commands: [big] })).json()).results.map((/** @type {any} */ r) => [r.outcome, r.error?.code]), [['rejected', 'BAD_INPUT']]);
    assert.equal((await driver.post('/api/v2/commands:batch', { report: report(), commands: Array(51).fill(i1) })).status, 400);
    assert.equal((await driver.post('/api/v2/commands:batch', { report: report(), commands: [i1] }, { csrf: false })).status, 403);
    assert.equal((await counter.post('/api/v2/commands:batch', { report: report(), commands: [i1] })).status, 403);
    // 번호 빈 곳: 5를 건너뛰고 7.
    const i7 = await visit(c, 7);
    const gap = await (await driver.post('/api/v2/commands:batch', { report: report({ lastSeq: 7 }), commands: [i7] })).json();
    assert.deepEqual(gap.device, { highWater: 7, missing: [5, 6] });
  });

  test('counters see a silent van, the closing blocks, and a manager approval (own PIN) closes it once', async () => {
    const h0 = await head();
    // 기사 휴대폰이 대기 2건을 알린 뒤 조용해진다(보이는 채).
    assert.equal((await driver.post('/api/v2/heartbeat', { report: report({ pendingCount: 2, oldestPendingAt: new Date(clock.t).toISOString(), lastSeq: 9 }) })).status, 200);
    clock.t += 90_000;
    app.links?.sweep();
    const h1 = await head();
    assert.ok(h1.linkRev > h0.linkRev, 'linkRev moved');
    const list = await (await counter.query('ledgerView', { viewKey: 'collection_list', vehicleId: 'v1', deviceClass: 'pos' })).json();
    assert.deepEqual(list.link.parts.map((/** @type {any} */ p) => p.text), ['1호 차량 연결 끊김', '21:00부터', '전송 대기 2']);
    // 마감: 막힘.
    const sheetOf = async (/** @type {any} */ who, /** @type {any} */ params = {}) => (await (await who.query('closingSheet', params)).json());
    const first = await sheetOf(manager);
    const counted = first.next?.kind === 'drawer_count' ? first.next.expectedAmount : 0;
    const sheet = await sheetOf(manager, { counts: [{ drawerId: 'counter', countedAmount: counted }] });
    assert.equal(sheet.step?.message, '1호 차량 기록 2건 전송 대기 · 마감 전 전송 필요');
    assert.deepEqual(sheet.step.choices.map((/** @type {any} */ c) => c.key), ['recheck', 'approve', 'close']);
    const counterSheet = await sheetOf(counter, { counts: [{ drawerId: 'counter', countedAmount: counted }] });
    assert.deepEqual(counterSheet.step.choices.map((/** @type {any} */ c) => c.key), ['recheck', 'close'], 'a counter role has no approve');
    const h2 = await head();
    const envelope = (/** @type {Record<string, unknown>} */ extra = {}) => ({
      type: 'closing.close', commandVersion: 1, requestId: newRequestId(clock.t + Math.floor(Math.random() * 1000)), basis: { epoch: h2.epoch, rev: h2.rev },
      expect: sheet.expect, payload: { ...sheet.command.payload, ...extra },
    });
    const blocked = await (await manager.command(envelope())).json();
    assert.deepEqual([blocked.outcome, blocked.error?.message], ['rejected', '1호 차량 · 전송 대기 있음']);
    // 승인: 카운터 역할 403, 틀린 비밀번호 403 PIN_MISMATCH, 맞으면 승인 id.
    assert.equal((await counter.post('/api/v2/closing/approve', { date: '2026-12-26', ownPin: pins['김카운터'] })).status, 403);
    const wrong = await manager.post('/api/v2/closing/approve', { date: '2026-12-26', ownPin: pins['정하늘'] === '0000' ? '1111' : '0000' });
    assert.deepEqual([wrong.status, (await wrong.json()).code], [403, 'PIN_MISMATCH']);
    const ok = await manager.post('/api/v2/closing/approve', { date: '2026-12-26', ownPin: pins['정하늘'] });
    assert.equal(ok.status, 200);
    const approval = await ok.json();
    assert.match(approval.approvalId, /^[A-Za-z0-9_-]{22}$/);
    const close = envelope({ unsynced: { approvalId: approval.approvalId, reason: '휴대폰 꺼짐' } });
    const done = await (await manager.command(close)).json();
    assert.equal(done.outcome, 'applied', JSON.stringify(done.error ?? null));
    const again = await (await manager.command(close)).json();
    assert.deepEqual([again.outcome, again.rev], ['applied', done.rev], 'a resend after a lost answer is the first result, not APPROVAL_INVALID');
    const reuse = await (await manager.command(envelope({ unsynced: { approvalId: approval.approvalId, reason: '다시' } }))).json();
    assert.ok(reuse.outcome !== 'applied');
    const closing = /** @type {any} */ (shopFile(db => db.prepare('SELECT override_reason AS r FROM closings').get()));
    assert.equal(closing.r, '휴대폰 꺼짐');
    const journal = JSON.parse(/** @type {any} */ (shopFile(db => db.prepare("SELECT command_json AS j FROM events WHERE command_type = 'closing.close'").get())).j);
    assert.deepEqual(journal.payload.links.map((/** @type {any} */ l) => [l.vehicleId, l.state, l.reportedPending]), [['v1', 'offline', 2]]);
    assert.equal(journal.payload.unsynced, undefined);
  });

  test('delivery without a session: a logged-out session is held, a revoked device is held with wipe', async () => {
    const h = await head();
    const rows = (await driverRows('collection_list')).filter((/** @type {any} */ r) => r.taskId);
    const item = await signed(driver, driverInfo, { type: 'task.visit', payload: { taskId: rows[0].taskId, outcomeKey: 'customer_absent' }, seq: 20, basis: { epoch: h.epoch, rev: h.rev }, now: clock.t });
    assert.equal((await driver.post('/api/v2/logout', {})).status, 204);
    const deliver = async (/** @type {any[]} */ commands) => {
      const challenge = await (await driver.post('/api/v2/device/challenge', { deviceId: driver.state.deviceId })).json();
      const key = /** @type {NonNullable<typeof driver.state.key>} */ (driver.state.key);
      const signature = await key.sign(deliverMessage(ORIGIN, driver.state.deviceId, challenge.nonce));
      return driver.post('/api/v2/device/deliver', { deviceId: driver.state.deviceId, nonce: challenge.nonce, signature, report: report({ pendingCount: commands.length }), commands }, { csrf: false });
    };
    const res = await deliver([item]);
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.deepEqual(out.results.map((/** @type {any} */ r) => r.outcome), ['held']);
    assert.deepEqual([out.device.status, out.device.wipe], ['active', false]);
    // 끊은 기기: 보류 + 지움.
    app.auth?.revokeDevice(SHOP, driver.state.deviceId, 'test', clock.t);
    const item2 = await signed(driver, driverInfo, { type: 'task.visit', payload: { taskId: rows[0].taskId, outcomeKey: 'customer_absent' }, seq: 21, basis: { epoch: h.epoch, rev: h.rev }, now: clock.t });
    const res2 = await (await deliver([item2])).json();
    assert.deepEqual(res2.results.map((/** @type {any} */ r) => r.outcome), ['held']);
    assert.deepEqual([res2.device.status, res2.device.wipe], ['revoked', true]);
    // 나쁜 전달 서명.
    const challenge = await (await driver.post('/api/v2/device/challenge', { deviceId: driver.state.deviceId })).json();
    const bad = await driver.post('/api/v2/device/deliver', { deviceId: driver.state.deviceId, nonce: challenge.nonce, signature: 'B'.repeat(86), report: report(), commands: [item2] }, { csrf: false });
    assert.equal(bad.status, 401);
  });

  test('no PIN or signature in the log', () => {
    for (const pin of Object.values(pins)) assert.ok(!logs.lines.some(l => new RegExp('\\b' + pin + '\\b').test(l)), 'no PIN');
    assert.ok(!logs.lines.some(l => /[A-Za-z0-9_-]{86}/.test(l)), 'no signature');
  });
});

// @ts-check
// 기사 기기 길의 네 번째 검토(work/impl-offline/plan.md §18, review round 2, 2026-09-28) — 진짜 매장 파일 · 가짜 시계:
//   - R4-1: 스위치를 끈 길에서 답을 잃은 온라인 시도(거절 · 충돌)가 같은 요청번호의 보냄 대기 사실로 다시 오면 보냄 대기 규칙으로 다시 판단한다
//     (돈은 적용 + `중복 수납 의심`, 요청번호로 한 번만).
//   - R4-3: 기사 기기의 보냄 대기 권한은 온라인과 같은 기사 역할(임시 차량을 맡은 카운터도): 온라인이 FORBIDDEN이면 보냄 대기도 권한 없음 규칙.
//   - R4-5: 사본의 대기 업무 id를 답을 받지 않은 것부터 보내면 알린 대기 수로 잘라도 옮겨진 팀이 사본에 남는다.
//   - R4-9: 보류된 기록을 묶음으로 다시 보내도(전달의 답을 잃음) 거짓 멱등 어긋남이 적히지 않는다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { canonicalJson, commandMessage, deliverMessage, newRequestId, unsignedItem } from '@skinote/contract';
import { kstAt } from '@skinote/domain';
import { openDatabase } from '@skinote/schema';
import { startServer } from '../src/server.js';
import { cli, collectLog, device, deviceCode, deviceReport as report, ORIGIN, provisionedShop, SHOP, STAFF, signedItem as signed, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

/**
 * 서명한 보냄 대기 항목(요청번호 · 돈의 바탕을 정한다).
 * @param {ReturnType<typeof device>} dev @param {{ staffId: string, sessionId: string }} by
 * @param {{ type: string, payload: unknown, seq: number, basis: { epoch: string, rev: number }, now: number, requestId: string, expect?: unknown }} x
 */
async function signedAs(dev, by, x) {
  /** @type {Record<string, any>} */
  const item = {
    type: x.type, commandVersion: 1, requestId: x.requestId, deviceSeq: x.seq, ageMs: 1_000, clockAnchor: 'mono-abcdefgh', madeAt: new Date(x.now - 1_000).toISOString(),
    basis: x.basis, dependsOn: [], ...(x.expect ? { expect: x.expect } : {}), recordedBy: { staffId: by.staffId, sessionId: by.sessionId, signature: 'A'.repeat(86) },
    payload: x.payload,
  };
  const hash = createHash('sha256').update(canonicalJson(unsignedItem(/** @type {any} */ (item))), 'utf8').digest('base64url');
  item.recordedBy.signature = await /** @type {NonNullable<typeof dev.state.key>} */ (dev.state.key).sign(commandMessage(ORIGIN, dev.state.deviceId, x.seq, hash));
  return item;
}

describe('fourth review of the driver offline routes', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */ let app;
  /** @type {ReturnType<typeof device>} */ let phone;
  /** @type {ReturnType<typeof device>} */ let phone2;
  /** @type {ReturnType<typeof device>} */ let counter;
  /** @type {any} */ let info;
  /** @type {any} */ let info2;
  /** @type {Record<string, string>} */ let pins = {};
  let dataDir = '';
  const clock = { t: kstAt('2026-12-26', 0, 20, 0) };
  const logs = collectLog();
  /** @param {(db: any) => unknown} read */
  const shopFile = read => {
    const db = openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'));
    try { return read(/** @type {any} */ (db)); } finally { db.close(); }
  };
  const head = async () => (await (await counter.get('/api/v2/head')).json());
  const snapshot = async (/** @type {ReturnType<typeof device>} */ dev, /** @type {Record<string, unknown>} */ over = {}) =>
    (await dev.post('/api/v2/snapshot', { fromSeq: 1, pendingTaskIds: [], onlinePending: [], report: report(), ...over })).json();
  /** @param {string} vehicleId */
  const vanTasks = async vehicleId => (await (await counter.query('ledgerView', { viewKey: 'collection_list', vehicleId, deviceClass: 'pos' })).json()).rows
    .filter((/** @type {any} */ r) => r.taskId).map((/** @type {any} */ r) => ({ taskId: /** @type {string} */ (r.taskId), orderId: /** @type {string} */ (r.orderId) }));
  /** @param {string} orderId @param {string} vehicleId */
  const moveTo = async (orderId, vehicleId) => {
    const first = await (await counter.query('promiseSheet', { orderId })).json();
    const quantities = Object.fromEntries(first.lines.map((/** @type {any} */ l) => [l.lineId, l.quantity.max]));
    const placeKey = first.areas.flatMap((/** @type {any} */ a) => a.places)[0].key;
    const sheet = await (await counter.query('promiseSheet', { orderId, quantities, slot: { day: 'today', slotKey: 'late_night' }, place: { mode: 'vehicle', placeKey }, vehicleId })).json();
    assert.ok(sheet.command, JSON.stringify(sheet.notice ?? sheet.primary));
    const out = await (await counter.command({ type: sheet.command.type, commandVersion: 1, requestId: newRequestId(clock.t), basis: sheet.basis, payload: sheet.command.payload, ...(sheet.expect ? { expect: sheet.expect } : {}) })).json();
    assert.equal(out.outcome, 'applied', JSON.stringify(out.error ?? null));
  };
  /** 1호 차량의 업무 가운데 받을 돈이 있는 것과 그 현장 수납 판. */
  const taskWithDue = async () => {
    const copy = await snapshot(phone);
    const fromCopy = copy.state.orders.flatMap((/** @type {any} */ o) => [{ taskId: 'collect:' + o.id, orderId: o.id }, { taskId: 'deliver:' + o.id, orderId: o.id }]);
    for (const t of [...await vanTasks('v1'), ...fromCopy]) {
      const q = await (await phone.query('fieldPaySheet', { taskId: t.taskId, methodKey: 'cash' })).json();
      if (q.command && (q.expect?.dueAmount ?? 0) > 0) return { task: t, sheet: q };
    }
    throw new Error('no van-1 task with money due');
  };

  before(async () => {
    dataDir = join(temp.dir, 'r4');
    const shop = await provisionedShop(dataDir, {}, { staff: [...STAFF] });
    pins = shop.pins;
    assert.equal((await cli(['load-sample', '--shop', SHOP, '--date', 'today'], shop.env, { now: () => clock.t })).code, 0);
    const codes = [
      await deviceCode(shop.env, ['--kind', 'driver_phone', '--label', '1호차 휴대폰', '--vehicle', 'v1'], () => clock.t),
      await deviceCode(shop.env, ['--kind', 'driver_phone', '--label', '2호차 휴대폰', '--vehicle', 'v2'], () => clock.t),
      await deviceCode(shop.env, ['--kind', 'pos', '--label', '카운터 1'], () => clock.t),
    ];
    app = await startServer(testConfig(dataDir, shop.env), { log: logs.log, now: () => new Date(clock.t), sleep: async () => {} });
    phone = device(app.port);
    phone2 = device(app.port);
    counter = device(app.port);
    assert.equal((await phone.enroll(/** @type {string} */ (codes[0]))).status, 200);
    assert.equal((await phone2.enroll(/** @type {string} */ (codes[1]))).status, 200);
    assert.equal((await counter.enroll(/** @type {string} */ (codes[2]))).status, 200);
    info = await (await phone.login('박기사', /** @type {string} */ (pins['박기사']))).json();
    assert.equal((await counter.login('정하늘', /** @type {string} */ (pins['정하늘']))).status, 200);
    // 김카운터: 바쁜 밤에 2호 차량을 모는 카운터 직원(features-1 E13b: 직원의 차량이 있으면 기사 기기에 로그인 타일이 보인다).
    const clerkId = /** @type {any} */ (shopFile(db => db.prepare("SELECT id FROM staff_members WHERE display_name = '김카운터'").get())).id;
    const h0 = await head();
    const assigned = await (await counter.command({ type: 'staff.set', commandVersion: 1, requestId: newRequestId(clock.t), basis: { epoch: h0.epoch, rev: h0.rev }, payload: { changes: [{ op: 'staff.update', id: clerkId, vehicleId: 'v2' }] } })).json();
    assert.equal(assigned.outcome, 'applied', JSON.stringify(assigned.error ?? null));
    const r2 = await phone2.login('김카운터', /** @type {string} */ (pins['김카운터']));
    assert.equal(r2.status, 200, await r2.clone().text());
    info2 = await r2.json();
    clock.t += 5_000;
  });
  after(async () => { await app?.close(); });

  test('R4-1: a lost online refusal re-sent as the same queued fact is judged by the queued rules — the money is applied with a duplicate review, once', async () => {
    const { task, sheet } = await taskWithDue();
    const due = sheet.expect.dueAmount;
    const h = await head();
    // 손님이 먼저 카운터에서 냈다.
    const paid = await (await counter.command({ type: 'payment.take', commandVersion: 1, requestId: newRequestId(clock.t), basis: { epoch: h.epoch, rev: h.rev }, payload: { orderIds: [task.orderId], amount: due, methodKey: 'cash' }, expect: { dueAmount: due } })).json();
    assert.equal(paid.outcome, 'applied', JSON.stringify(paid.error ?? null));
    // 기사(스위치를 끔: 온라인 먼저)가 현금을 받았다: 서버는 거절(DUE_CHANGED)하고 그 답을 기기가 잃는다.
    const requestId = newRequestId(clock.t + 7);
    const online = await (await phone.command({ type: 'field.collect', commandVersion: 1, requestId, basis: sheet.basis, payload: sheet.command.payload, expect: sheet.expect })).json();
    assert.deepEqual([online.outcome, online.error?.code], ['conflict', 'DUE_CHANGED']);
    const before = (await head()).rev;
    // 기기는 같은 봉투를 보냄 대기의 사실로 다시 보낸다(driver-client O2).
    const by = { staffId: info.staff.id, sessionId: info.session.id };
    const item = await signedAs(phone, by, { type: 'field.collect', payload: sheet.command.payload, expect: sheet.expect, seq: 30, basis: sheet.basis, now: clock.t, requestId });
    const out = await (await phone.post('/api/v2/commands:batch', { report: report({ pendingCount: 1, lastSeq: 30 }), commands: [item] })).json();
    const [r] = out.results;
    assert.ok(r.outcome === 'applied' || r.outcome === 'partially_applied', JSON.stringify(r));
    assert.ok(r.reviews.includes('possible_duplicate_money'), JSON.stringify(r.reviews));
    assert.equal((await head()).rev, before + 1, 'the driver cash is in the ledger once');
    const row = /** @type {any} */ (shopFile(db => db.prepare('SELECT status_key AS s, device_seq AS q, time_source_key AS t FROM command_log WHERE request_id = ?').get(requestId)));
    assert.deepEqual([row.s, row.q, row.t], [r.outcome, 30, 'monotonic']);
    const reviews = /** @type {any[]} */ (shopFile(db => db.prepare("SELECT kind_key AS k FROM review_items WHERE request_id = ?").all(requestId)));
    assert.ok(reviews.some(x => x.k === 'possible_duplicate_money'), JSON.stringify(reviews));
    // 같은 항목을 다시 보내면(답을 또 잃음) 첫 결과를 준다: 두 번 적용하지 않는다.
    const again = (await (await phone.post('/api/v2/commands:batch', { report: report({ pendingCount: 1, unconfirmedCount: 1, lastSeq: 30 }), commands: [item] })).json()).results[0];
    assert.deepEqual([again.outcome, again.rev], [r.outcome, r.rev]);
    assert.equal((await head()).rev, before + 1);
    // 사본의 기록도 새 결과다(기기의 보낸 기록이 거절로 남지 않는다).
    const copy = await snapshot(phone, { fromSeq: 30, report: report({ lastSeq: 30 }) });
    assert.deepEqual(copy.recorded.filter((/** @type {any} */ x) => x.requestId === requestId).map((/** @type {any} */ x) => x.outcome), [r.outcome]);
    // 온라인으로 다시 보낸 같은 요청(결과 확인 중을 풀려는 온라인 재전송)도 같은 결과.
    const resent = await (await phone.command({ type: 'field.collect', commandVersion: 1, requestId, basis: sheet.basis, payload: sheet.command.payload, expect: sheet.expect })).json();
    assert.equal(resent.outcome, r.outcome);
  });

  test('R4-1: an online refusal whose answer arrived is not re-judged by a different queued envelope (fingerprint) and an online row of another device is not touched', async () => {
    const { sheet } = await taskWithDue();
    const requestId = newRequestId(clock.t + 11);
    // 온라인 거절(받을 금액이 달라 DUE_CHANGED가 되게 바탕을 틀리게).
    const wrong = { dueAmount: sheet.expect.dueAmount + 1_000 };
    const online = await (await phone.command({ type: 'field.collect', commandVersion: 1, requestId, basis: sheet.basis, payload: sheet.command.payload, expect: wrong })).json();
    assert.equal(online.outcome, 'conflict', JSON.stringify(online));
    // 다른 기기(2호 휴대폰)가 같은 요청번호를 보냄 대기로: 그 기기의 온라인 줄이 아니라 다시 판단하지 않는다(첫 결과).
    const by2 = { staffId: info2.staff.id, sessionId: info2.session.id };
    const other = await signedAs(phone2, by2, { type: 'field.collect', payload: sheet.command.payload, expect: wrong, seq: 5, basis: sheet.basis, now: clock.t, requestId });
    const r = (await (await phone2.post('/api/v2/commands:batch', { report: report({ pendingCount: 1, lastSeq: 5 }), commands: [other] })).json()).results[0];
    assert.deepEqual([r.outcome, r.error?.code], ['conflict', 'DUE_CHANGED']);
  });

  test('R4-3: a counter clerk driving a van gets the same rules queued as online — without task.visit the visit is superseded FORBIDDEN, money is applied and flagged', async () => {
    const [task1] = await vanTasks('v1');
    assert.ok(task1);
    await moveTo(task1.orderId, 'v2');
    const [v2] = await vanTasks('v2');
    assert.ok(v2, 'van 2 has a task');
    const taken = /** @type {any[]} */ (shopFile(db => {
      const rows = db.prepare("SELECT * FROM role_permissions WHERE role_id = 'driver' AND permission_key IN ('task.visit', 'payment.collect_field')").all();
      db.prepare("DELETE FROM role_permissions WHERE role_id = 'driver' AND permission_key IN ('task.visit', 'payment.collect_field')").run();
      return rows;
    }));
    assert.equal(taken.length, 2);
    try {
      const h = await head();
      const basis = { epoch: h.epoch, rev: h.rev };
      // 온라인: 기사 기기의 세션은 기사 역할 → FORBIDDEN.
      const online = await (await phone2.command({ type: 'task.visit', commandVersion: 1, requestId: newRequestId(clock.t), basis, payload: { taskId: v2.taskId, outcomeKey: 'customer_absent' } })).json();
      assert.deepEqual([online.outcome, online.error?.code], ['rejected', 'FORBIDDEN']);
      // 보냄 대기(로컬 먼저: 연결되어 있어도 이 길): 같은 기사 역할 → 방문 결과는 적지 않음, 돈은 적용 + 공급자 확인 중(예전에는 카운터 역할로 보아 표시 없이 적용).
      const by = { staffId: info2.staff.id, sessionId: info2.session.id };
      const visit = await signed(phone2, by, { type: 'task.visit', payload: { taskId: v2.taskId, outcomeKey: 'customer_absent' }, seq: 1, basis, now: clock.t });
      const pay = await signed(phone2, by, { type: 'field.collect', payload: { taskId: v2.taskId, orderId: v2.orderId, amount: 1_000, methodKey: 'cash' }, seq: 2, basis, now: clock.t });
      const out = await (await phone2.post('/api/v2/commands:batch', { report: report({ pendingCount: 2, lastSeq: 2 }), commands: [visit, pay] })).json();
      const [r1, r2] = out.results;
      assert.deepEqual([r1.outcome, r1.error?.code, r1.reviews], ['superseded', 'FORBIDDEN', []]);
      assert.ok(r2.outcome === 'applied' || r2.outcome === 'partially_applied', JSON.stringify(r2));
      assert.ok(r2.reviews.includes('command_held'), JSON.stringify(r2.reviews));
      const actor = /** @type {any} */ (shopFile(db => db.prepare('SELECT actor_role_key AS r FROM events WHERE request_id = ?').get(pay.requestId)));
      assert.equal(actor?.r, 'driver');
    } finally {
      shopFile(db => {
        const put = db.prepare('INSERT INTO role_permissions (' + Object.keys(taken[0]).join(', ') + ') VALUES (' + Object.keys(taken[0]).map(() => '?').join(', ') + ')');
        for (const row of taken) put.run(...Object.values(row));
      });
    }
  });

  test('R4-5: unanswered tasks first in pendingTaskIds keep a moved team in the copy under the reported count', async () => {
    const tasks = await vanTasks('v1');
    const [answered, pending] = tasks;
    assert.ok(answered && pending, JSON.stringify(tasks));
    assert.ok((await snapshot(phone)).state.orders.some((/** @type {any} */ o) => o.id === pending.orderId));
    await moveTo(pending.orderId, 'v2');
    // 기기(R4-5 뒤): 답을 받지 않은 업무가 먼저, 답을 받은 업무가 뒤. 대기 수 1이면 앞의 것이 남는다.
    const kept = await snapshot(phone, { fromSeq: 1, pendingTaskIds: [pending.taskId, answered.taskId], report: report({ pendingCount: 1 }) });
    assert.ok(kept.state.orders.some((/** @type {any} */ o) => o.id === pending.orderId), 'the waiting record keeps its moved team');
  });

  test('R4-9: a held record re-sent through the batch answers held and writes no idempotency_mismatch finding', async () => {
    const [task] = await vanTasks('v1');
    assert.ok(task);
    const h = await head();
    // 서버가 모르는 세션으로 적은 기록(전달의 규칙이 보류한다).
    const ghost = { staffId: info.staff.id, sessionId: newRequestId(clock.t - 60_000) };
    const item = await signed(phone, ghost, { type: 'task.visit', payload: { taskId: task.taskId, outcomeKey: 'customer_absent' }, seq: 50, basis: { epoch: h.epoch, rev: h.rev }, now: clock.t });
    const challenge = await (await phone.post('/api/v2/device/challenge', { deviceId: phone.state.deviceId })).json();
    const signature = await /** @type {any} */ (phone.state.key).sign(deliverMessage(ORIGIN, phone.state.deviceId, challenge.nonce));
    const d = await (await phone.post('/api/v2/device/deliver', { deviceId: phone.state.deviceId, nonce: challenge.nonce, signature, report: report({ pendingCount: 1, lastSeq: 50 }), commands: [item] }, { csrf: false })).json();
    assert.deepEqual(d.results.map((/** @type {any} */ r) => r.outcome), ['held']);
    // 같은 바이트를 묶음으로(전달의 답을 잃어 결과 확인 중이던 기록이 다음 세션과 함께 나감).
    const out = await (await phone.post('/api/v2/commands:batch', { report: report({ pendingCount: 1, unconfirmedCount: 1, lastSeq: 50 }), commands: [item] })).json();
    assert.equal(out.results[0].outcome, 'held');
    const found = /** @type {any[]} */ (shopFile(db => db.prepare('SELECT check_key FROM integrity_findings WHERE entity_id = ?').all(item.requestId)));
    assert.deepEqual(found, []);
    // 바뀐 바이트(같은 요청번호 · 다른 본문)는 여전히 어긋남이다.
    const changed = await signed(phone, ghost, { type: 'task.visit', payload: { taskId: task.taskId, outcomeKey: 'place_changed' }, seq: 50, basis: { epoch: h.epoch, rev: h.rev }, now: clock.t });
    const tampered = { ...changed, requestId: item.requestId };
    await (await phone.post('/api/v2/commands:batch', { report: report({ pendingCount: 1, lastSeq: 50 }), commands: [tampered] })).json();
    const after = /** @type {any[]} */ (shopFile(db => db.prepare('SELECT check_key AS k FROM integrity_findings WHERE entity_id = ?').all(item.requestId)));
    assert.deepEqual(after.map(f => f.k), ['idempotency_mismatch']);
  });
});

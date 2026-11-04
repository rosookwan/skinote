// @ts-check
// 기사 기기 길의 세 번째 검토(work/impl-offline/plan.md §17, 2026-09-28) — 진짜 매장 파일 · 가짜 시계:
//   - R3-1: 머리의 restoredUpToRev는 매장 파일의 되살린 기준(처음 만든 매장 · 시험 매장 새로 만들기는 null, 되살린 매장은 그 수).
//   - R3-8: 사본의 대기 업무 id는 거른다(다른 차량의 업무 · 매장만의 접수는 사본을 바꾸지 않는다). 앞서 보낸 접수로 기억하는 것은 이 차량과 이어진
//     접수만(결제로만 든 팀은 위조한 id로 다시 끌어오지 못한다).
//   - R3-10: 묶음의 차량은 서버가 아는 것만(봉투의 직원 행의 차량을 읽지 않음), 차량을 모르는 업무의 돈은 `공급자 확인 중`, 범위 밖의 방문 결과는 적지 않음.
//     역할에 권한이 없으면 돈은 적용 + `공급자 확인 중`(FORBIDDEN, 미확인 로그인이 아님), 순서 변경은 적지 않음.
//   - R3-12: 개인정보 열람은 기기 · 직원 · 차량 · 영업일마다(새 접수 수 한 줄 + 새 온전한 번호 수 한 줄).
//   - R3-13: 기기가 알린 번호보다 큰 번호가 그 알림 전에 일어났다고 하거나, 기록한 세션이 생기기 전이면 시계 확인.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { canonicalJson, commandMessage, newRequestId, unsignedItem } from '@skinote/contract';
import { kstAt } from '@skinote/domain';
import { openDatabase } from '@skinote/schema';
import { startServer } from '../src/server.js';
import { cli, collectLog, device, deviceCode, ORIGIN, provisionedShop, SHOP, STAFF, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

/** @param {Partial<import('@skinote/contract').DeviceReport>} [over] @returns {import('@skinote/contract').DeviceReport} */
const report = (over = {}) => ({
  pendingCount: 0, unconfirmedCount: 0, lastSeq: 0, clockOffsetMs: 0, appVersion: 'test', offlineCapable: true, localFirst: true, visibility: 'visible', unreadable: 0, ...over,
});

/**
 * 서명한 보냄 대기 항목.
 * @param {ReturnType<typeof device>} dev @param {{ staffId: string, sessionId: string }} by
 * @param {{ type: string, payload: unknown, seq: number, basis: { epoch: string, rev: number }, now: number, ageMs?: number }} x
 */
async function signed(dev, by, x) {
  const ageMs = x.ageMs ?? 1_000;
  const item = {
    type: x.type, commandVersion: 1, requestId: newRequestId(x.now + x.seq), deviceSeq: x.seq, ageMs, clockAnchor: 'mono-abcdefgh',
    madeAt: new Date(x.now - ageMs).toISOString(), basis: x.basis, dependsOn: [], recordedBy: { staffId: by.staffId, sessionId: by.sessionId, signature: 'A'.repeat(86) },
    payload: x.payload,
  };
  const hash = createHash('sha256').update(canonicalJson(unsignedItem(item)), 'utf8').digest('base64url');
  item.recordedBy.signature = await /** @type {NonNullable<typeof dev.state.key>} */ (dev.state.key).sign(commandMessage(ORIGIN, dev.state.deviceId, x.seq, hash));
  return item;
}

describe('third review of the driver offline routes', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */ let app;
  /** @type {ReturnType<typeof device>} */ let phone;
  /** @type {ReturnType<typeof device>} */ let phone2;
  /** @type {ReturnType<typeof device>} */ let counter;
  /** @type {any} */ let info;
  /** @type {any} */ let info2;
  /** @type {Record<string, string>} */ let pins = {};
  /** @type {Record<string, string>} */ let env = {};
  let dataDir = '';
  let secondCode = '';
  const clock = { t: kstAt('2026-12-26', 0, 20, 0) };
  const logs = collectLog();
  const start = async () => startServer(testConfig(dataDir, env), { log: logs.log, now: () => new Date(clock.t), sleep: async () => {} });
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
    .filter((/** @type {any} */ r) => r.taskId).map((/** @type {any} */ r) => ({ taskId: r.taskId, orderId: /** @type {string} */ (r.orderId) }));
  /** 1호 사본 · 2호 목록에 없는 접수(매장만의 접수). */
  const storeOnly = async () => {
    const own = new Set((await snapshot(phone)).state.orders.map((/** @type {any} */ o) => o.id));
    const v2 = new Set((await vanTasks('v2')).map(t => t.orderId));
    const ledger = (await (await counter.query('ledgerView', { viewKey: 'day_ledger' })).json()).rows.map((/** @type {any} */ r) => r.orderId).filter(Boolean);
    return [...new Set(ledger)].filter(id => !own.has(id) && !v2.has(id));
  };
  /** 접수 하나의 반납을 그 차량 심야로 옮긴다(카운터의 일정 변경). @param {string} orderId @param {string} [vehicleId] */
  const moveTo = async (orderId, vehicleId = 'v2') => {
    const first = await (await counter.query('promiseSheet', { orderId })).json();
    const quantities = Object.fromEntries(first.lines.map((/** @type {any} */ l) => [l.lineId, l.quantity.max]));
    const placeKey = first.areas.flatMap((/** @type {any} */ a) => a.places)[0].key;
    const sheet = await (await counter.query('promiseSheet', { orderId, quantities, slot: { day: 'today', slotKey: 'late_night' }, place: { mode: 'vehicle', placeKey }, vehicleId })).json();
    assert.ok(sheet.command, JSON.stringify(sheet.notice ?? sheet.primary));
    const out = await (await counter.command({ type: sheet.command.type, commandVersion: 1, requestId: newRequestId(clock.t), basis: sheet.basis, payload: sheet.command.payload, ...(sheet.expect ? { expect: sheet.expect } : {}) })).json();
    assert.equal(out.outcome, 'applied', JSON.stringify(out.error ?? null));
  };
  /** 끝 4자리로 찾은 오늘의 접수 id(예시 자료: 이서연 0036은 이정호 0032가 대신 낸다). @param {string} last4 */
  const orderOf = async last4 => /** @type {string} */ ((await (await counter.query('findLast4', { last4 })).json()).matches[0]?.orderId);
  /** 2호 차량의 업무 하나(없으면 매장만의 접수 하나를 옮겨 만든다). */
  const v2Task = async () => {
    const have = await vanTasks('v2');
    if (have.length) return /** @type {{ taskId: string, orderId: string }} */ (have[0]);
    const [id] = await storeOnly();
    assert.ok(id, 'the sample day has a store-only order');
    await moveTo(id, 'v2');
    const made = await vanTasks('v2');
    assert.ok(made[0], 'the moved order gives a van-2 task');
    return made[0];
  };

  before(async () => {
    dataDir = join(temp.dir, 'r3');
    const shop = await provisionedShop(dataDir, {}, { staff: [...STAFF, '이기사:driver:v2'] });
    env = shop.env;
    pins = shop.pins;
    assert.equal((await cli(['load-sample', '--shop', SHOP, '--date', 'today'], env, { now: () => clock.t })).code, 0);
    const codes = [
      await deviceCode(env, ['--kind', 'driver_phone', '--label', '1호차 휴대폰', '--vehicle', 'v1'], () => clock.t),
      await deviceCode(env, ['--kind', 'driver_phone', '--label', '2호차 휴대폰', '--vehicle', 'v2'], () => clock.t),
      await deviceCode(env, ['--kind', 'pos', '--label', '카운터 1'], () => clock.t),
      // 같은 1호 차량의 둘째 개인 휴대폰(R3-28).
      await deviceCode(env, ['--kind', 'driver_phone', '--label', '1호차 휴대폰 둘', '--vehicle', 'v1', '--minutes', '1440'], () => clock.t),
    ];
    secondCode = /** @type {string} */ (codes[3]);
    app = await start();
    phone = device(app.port);
    phone2 = device(app.port);
    counter = device(app.port);
    assert.equal((await phone.enroll(/** @type {string} */ (codes[0]))).status, 200);
    assert.equal((await phone2.enroll(/** @type {string} */ (codes[1]))).status, 200);
    assert.equal((await counter.enroll(/** @type {string} */ (codes[2]))).status, 200);
    info = await (await phone.login('박기사', /** @type {string} */ (pins['박기사']))).json();
    info2 = await (await phone2.login('이기사', /** @type {string} */ (pins['이기사']))).json();
    assert.equal((await counter.login('김카운터', /** @type {string} */ (pins['김카운터']))).status, 200);
    clock.t += 5_000;
  });
  after(async () => { await app?.close(); });

  test('R3-1: a provisioned shop answers restoredUpToRev null on heartbeat and snapshot; a restored shop file answers its restore point', async () => {
    const beat = await (await phone.post('/api/v2/heartbeat', { report: report() })).json();
    assert.equal(beat.restoredUpToRev, null);
    assert.equal((await snapshot(phone)).restoredUpToRev, null);
    // 되살린 매장(shop_instance.restored_up_to_rev가 수): 같은 길이 그 수를 준다(매장 파일에서 그때마다 읽는다). 기기는 이 수일 때만 옛 기록을 다시 보낸다.
    const db = openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'));
    try {
      db.prepare('UPDATE shop_instance SET restored_up_to_rev = 41').run();
      assert.equal((await (await phone.post('/api/v2/heartbeat', { report: report() })).json()).restoredUpToRev, 41);
      assert.equal((await snapshot(phone)).restoredUpToRev, 41);
    } finally {
      db.prepare('UPDATE shop_instance SET restored_up_to_rev = NULL').run();
      db.close();
    }
    assert.equal((await (await phone.post('/api/v2/heartbeat', { report: report() })).json()).restoredUpToRev, null);
  });

  test('R3-8: forged pending task ids (another van, a store-only order) do not add orders to the copy; the pending count caps them', async () => {
    const v2 = await v2Task();
    const plain = await snapshot(phone);
    const own = new Set(plain.state.orders.map((/** @type {any} */ o) => o.id));
    assert.ok(!own.has(v2.orderId), 'the van-2 order is not in the van-1 copy');
    const stores = await storeOnly();
    assert.ok(stores.length > 0, 'the sample day has a store-only order');
    const forged = [v2.taskId, ...stores.map(id => 'collect:' + id)];
    const out = await snapshot(phone, { pendingTaskIds: forged, report: report({ pendingCount: forged.length }) });
    assert.deepEqual(out.state.orders.map((/** @type {any} */ o) => o.id).sort(), [...own].sort(), 'no order of another van or of the store');
    // 자기 차량의 업무 id는 그대로(사본이 같다).
    const withOwn = await snapshot(phone, { pendingTaskIds: ['collect:' + [...own][0]], report: report({ pendingCount: 1 }) });
    assert.equal(withOwn.hash, plain.hash);
  });

  test('R3-8: only orders tied to this van are remembered as sent — a team that was in an earlier copy only as a payer is not pulled back by a forged pending id', async () => {
    const paid = await orderOf('0036');
    const payer = await orderOf('0032');
    assert.ok(paid && payer, 'the sample day has the two family teams');
    // 대신 받는 팀(0036)을 1호 차량으로: 1호 사본에 대신 내는 팀(0032)이 결제로만 든다.
    await moveTo(paid, 'v1');
    const ids = (/** @type {any} */ copy) => copy.state.orders.map((/** @type {any} */ o) => o.id);
    const linked = await snapshot(phone);
    assert.ok(ids(linked).includes(paid) && ids(linked).includes(payer), JSON.stringify(ids(linked)));
    // 0036을 2호 차량으로: 1호 사본에서 둘 다 빠진다.
    await moveTo(paid, 'v2');
    const plain = await snapshot(phone);
    assert.ok(!ids(plain).includes(paid) && !ids(plain).includes(payer));
    // 결제로만 들었던 0032의 위조한 대기 업무 id: 사본이 바뀌지 않는다(0032도, 그 결제로 이어진 0036도 끌어오지 않는다).
    const forged = await snapshot(phone, { pendingTaskIds: ['collect:' + payer, 'deliver:' + payer], report: report({ pendingCount: 2 }) });
    assert.equal(forged.hash, plain.hash);
    // 이 차량과 이어졌던 0036(옮겨진 업무의 대기 항목)은 사본에 남는다.
    const moved = await snapshot(phone, { pendingTaskIds: ['collect:' + paid], report: report({ pendingCount: 1 }) });
    assert.ok(ids(moved).includes(paid));
    // 기기가 알린 대기 수까지만(0이면 대기 업무 id를 쓰지 않는다).
    assert.equal((await snapshot(phone, { pendingTaskIds: ['collect:' + paid], report: report({ pendingCount: 0 }) })).hash, plain.hash);
  });

  test('R3-10: vans come from server facts only; an unknown van for money is flagged; an out-of-scope visit is superseded with nothing written', async () => {
    const h = await head();
    const basis = { epoch: h.epoch, rev: h.rev };
    const v2task = await v2Task();
    // 1호 휴대폰이 2호 기사의 직원 id를 적은 2호 업무의 수거 실패(돈 · 재고 아님): 봉투의 직원(2호) 차량을 믿지 않아 범위 밖 → 적지 않음.
    const visit = await signed(phone, { staffId: info2.staff.id, sessionId: info.session.id }, { type: 'task.visit', payload: { taskId: v2task.taskId, outcomeKey: 'customer_absent' }, seq: 1, basis, now: clock.t });
    // 같은 2호 업무의 현장 수납(돈): 적용 + `공급자 확인 중`.
    const pay = await signed(phone, { staffId: info.staff.id, sessionId: info.session.id }, { type: 'field.collect', payload: { taskId: v2task.taskId, orderId: v2task.orderId, amount: 1_000, methodKey: 'cash' }, seq: 2, basis, now: clock.t });
    const before = (await head()).rev;
    const out = await (await phone.post('/api/v2/commands:batch', { report: report({ pendingCount: 2, lastSeq: 2 }), commands: [visit, pay] })).json();
    const [r1, r2] = out.results;
    assert.deepEqual([r1.outcome, r1.error?.code, r1.reviews], ['superseded', 'FORBIDDEN_SCOPE', []]);
    assert.equal(r2.outcome, 'applied');
    assert.ok(r2.reviews.includes('command_held'), JSON.stringify(r2.reviews));
    assert.equal((await head()).rev, before + 1, 'only the money was written');
    assert.ok(logs.lines.some(l => l.startsWith('ALERT offline FORBIDDEN_SCOPE ' + SHOP + ' ' + phone.state.deviceId + ' 1')));
    // 매장만의 접수(업무의 차량을 모름)의 현장 수납: 범위 밖 → 적용 + `공급자 확인 중`(예전에는 표시 없이 적용).
    const [storeOrder] = await storeOnly();
    assert.ok(storeOrder);
    const h2 = await head();
    const storePay = await signed(phone, { staffId: info.staff.id, sessionId: info.session.id }, { type: 'field.collect', payload: { taskId: 'collect:' + storeOrder, orderId: storeOrder, amount: 1_000, methodKey: 'cash' }, seq: 3, basis: { epoch: h2.epoch, rev: h2.rev }, now: clock.t });
    const r3 = (await (await phone.post('/api/v2/commands:batch', { report: report({ pendingCount: 1, lastSeq: 3 }), commands: [storePay] })).json()).results[0];
    if (r3.outcome === 'applied' || r3.outcome === 'partially_applied') assert.ok(r3.reviews.includes('command_held'), JSON.stringify(r3));
    const code = /** @type {any} */ (shopFile(db => db.prepare('SELECT error_code AS e FROM command_log WHERE request_id = ?').get(storePay.requestId))).e;
    assert.equal(code, 'FORBIDDEN_SCOPE');
  });

  test('R3-13: an item numbered above a reported lastSeq that claims to predate that report, or predates its session, is clock_suspect', async () => {
    const h = await head();
    const basis = { epoch: h.epoch, rev: h.rev };
    const [task] = await vanTasks('v1');
    assert.ok(task);
    // 세션이 생긴 지 한참 뒤(세션의 시작으로는 잡히지 않는 때): 알린 번호만으로 잡는지 본다.
    clock.t += 60 * 60_000;
    assert.equal((await phone.post('/api/v2/heartbeat', { report: report({ lastSeq: 10 }) })).status, 200);
    const reportedAt = clock.t;
    clock.t += 10 * 60_000;
    // 번호 11은 lastSeq 10을 알린 뒤에 만든 것: 15분 전(알림보다 5분 앞)이라고 하면 확인.
    const early = await signed(phone, { staffId: info.staff.id, sessionId: info.session.id }, { type: 'route.move', payload: { taskId: task.taskId, anchorTaskId: null, position: 'top' }, seq: 11, basis, now: clock.t, ageMs: 15 * 60_000 });
    const fine = await signed(phone, { staffId: info.staff.id, sessionId: info.session.id }, { type: 'route.move', payload: { taskId: task.taskId, anchorTaskId: null, position: 'top' }, seq: 12, basis, now: clock.t, ageMs: 60_000 });
    const out = await (await phone.post('/api/v2/commands:batch', { report: report({ pendingCount: 2, lastSeq: 12 }), commands: [early, fine] })).json();
    assert.ok(reportedAt > clock.t - 15 * 60_000);
    assert.ok(out.results[0].reviews.includes('clock_suspect'), JSON.stringify(out.results[0]));
    assert.ok(!out.results[1].reviews.includes('clock_suspect'), JSON.stringify(out.results[1]));
    // 세션이 생기기 전이라고 하는 기록(2호 휴대폰의 첫 번호, 로그인보다 1시간 앞).
    const h2 = await head();
    const v2task = await v2Task();
    const before = await signed(phone2, { staffId: info2.staff.id, sessionId: info2.session.id }, { type: 'route.move', payload: { taskId: v2task?.taskId, anchorTaskId: null, position: 'top' }, seq: 1, basis: { epoch: h2.epoch, rev: h2.rev }, now: clock.t, ageMs: 2 * 3_600_000 });
    const r = (await (await phone2.post('/api/v2/commands:batch', { report: report({ pendingCount: 1, lastSeq: 1 }), commands: [before] })).json()).results[0];
    assert.ok(r.reviews.includes('clock_suspect'), JSON.stringify(r));
  });

  test('R3-10: a role without the permission — money is applied and flagged FORBIDDEN, a route change is superseded with nothing written', async () => {
    const [task] = await vanTasks('v1');
    assert.ok(task);
    const taken = /** @type {any[]} */ (shopFile(db => {
      const rows = db.prepare("SELECT * FROM role_permissions WHERE role_id = 'driver' AND permission_key IN ('route.reorder', 'payment.collect_field')").all();
      db.prepare("DELETE FROM role_permissions WHERE role_id = 'driver' AND permission_key IN ('route.reorder', 'payment.collect_field')").run();
      return rows;
    }));
    assert.equal(taken.length, 2, 'the driver role had both permissions');
    try {
      const h = await head();
      const basis = { epoch: h.epoch, rev: h.rev };
      const by = { staffId: info.staff.id, sessionId: info.session.id };
      const move = await signed(phone, by, { type: 'route.move', payload: { taskId: task.taskId, anchorTaskId: null, position: 'top' }, seq: 13, basis, now: clock.t });
      const pay = await signed(phone, by, { type: 'field.collect', payload: { taskId: task.taskId, orderId: task.orderId, amount: 1_000, methodKey: 'cash' }, seq: 14, basis, now: clock.t });
      const out = await (await phone.post('/api/v2/commands:batch', { report: report({ pendingCount: 2, lastSeq: 14 }), commands: [move, pay] })).json();
      const [r1, r2] = out.results;
      assert.deepEqual([r1.outcome, r1.error?.code, r1.reviews], ['superseded', 'FORBIDDEN', []]);
      assert.ok(r2.outcome === 'applied' || r2.outcome === 'partially_applied', JSON.stringify(r2));
      assert.ok(r2.reviews.includes('command_held'), JSON.stringify(r2.reviews));
      assert.ok(!r2.reviews.includes('unverified_sign_in'), 'a missing permission is not an unverified sign-in');
      assert.equal((await head()).rev, h.rev + 1, 'only the money was written');
      const codes = /** @type {any[]} */ (shopFile(db => db.prepare('SELECT request_id AS r, error_code AS e FROM command_log WHERE request_id IN (?, ?)').all(move.requestId, pay.requestId)));
      assert.deepEqual(Object.fromEntries(codes.map(c => [c.r, c.e])), { [move.requestId]: 'FORBIDDEN', [pay.requestId]: 'FORBIDDEN' });
      assert.ok(logs.lines.some(l => l.startsWith('ALERT offline FORBIDDEN ' + SHOP + ' ' + phone.state.deviceId + ' 14')));
    } finally {
      shopFile(db => {
        const put = db.prepare('INSERT INTO role_permissions (' + Object.keys(taken[0]).join(', ') + ') VALUES (' + Object.keys(taken[0]).map(() => '?').join(', ') + ')');
        for (const row of taken) put.run(...Object.values(row));
      });
    }
  });

  test('R3-12: the working copy is logged per device · staff · vehicle · date, all new orders and new full numbers separately', async () => {
    const rows = () => /** @type {any[]} */ (shopFile(db => db.prepare("SELECT actor_key AS a, subject_id AS i, item_count AS n FROM pii_access_log WHERE action_key = 'working_copy' AND device_id = ? ORDER BY rowid").all(phone.state.deviceId)));
    const mine = rows().filter(r => r.a === 'staff:' + info.staff.id);
    const all = mine.find(r => r.i === 'v1:2026-12-26');
    const full = mine.find(r => r.i === 'v1:2026-12-26:full');
    assert.ok(all && full, JSON.stringify(mine));
    const copy = await snapshot(phone);
    assert.equal(all.n, copy.state.orders.length, 'every order in the copy is counted (names and masked numbers too)');
    assert.ok(full.n <= all.n);
    // 같은 기기에 다른 직원이 로그인해 같은 사본을 받으면 그 직원 이름으로 다시 적는다.
    const lo = await phone.post('/api/v2/logout', {});
    assert.equal(lo.status, 204, await lo.text());
    assert.equal((await phone.login('이기사', /** @type {string} */ (pins['이기사']))).status, 200);
    const counted = rows().length;
    const other = await snapshot(phone);
    assert.equal(other.state.orders.length, copy.state.orders.length);
    const added = rows().slice(counted);
    assert.ok(added.length >= 1 && added.every(r => r.a !== 'staff:' + info.staff.id), JSON.stringify(added));
  });

  test('R3-28: a login on a second phone of the same van names the other phone (label and the staff member last signed in on it) and its count', async () => {
    // 1호차 휴대폰(지금 이기사가 로그인)이 보낼 기록 2건을 알린다.
    const beat = await phone.post('/api/v2/heartbeat', { report: report({ pendingCount: 2, lastSeq: 40, oldestPendingAt: new Date(clock.t).toISOString() }) });
    assert.equal(beat.status, 200, await beat.text());
    const phone3 = device(app.port);
    assert.equal((await phone3.enroll(secondCode)).status, 200);
    const got = await (await phone3.login('박기사', /** @type {string} */ (pins['박기사']))).json();
    assert.deepEqual(got.vanPendingElsewhere, { deviceKind: 'driver_phone', pending: 2, label: '1호차 휴대폰', staffName: '이기사' });
    assert.equal((await phone.post('/api/v2/heartbeat', { report: report({ pendingCount: 0, lastSeq: 40 }) })).status, 200);
  });
});

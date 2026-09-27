// @ts-check
// 확인 필요의 서버 길(features-1 plan §9-2 · §9-5): 견본 하루(load-sample)의 확인 필요 한 건이 카운터의 `reviewList`에 열린 것으로 오고(메뉴의 수),
// 카운터가 그 줄의 `확인`(review.resolve)을 보내면 처리 완료 탭으로 가고(누가 · 때), 서버를 다시 띄워도 그대로다. 기사 세션은 목록 · 환불 창을
// 읽지 못하고(403) `확인`을 보내지 못한다(FORBIDDEN · FORBIDDEN_SCOPE). 권한 표: review.resolve는 권한 review.resolve. 서버 모드는 온라인만이라 보냄 대기 명령의
// 칸(deviceSeq)은 봉투에서 거절된다(QUEUE_NOT_SUPPORTED): 보냄 대기로 온 수거의 확인 필요(출처 sync · 기기)는 저장소 쌍둥이 실행이 본다.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { newRequestId } from '@skinote/contract';
import { openDatabase } from '@skinote/schema';
import { commandGuard } from '../src/permissions.js';
import { startServer } from '../src/server.js';
import { cli, device, deviceCode, provisionedShop, SHOP, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

/** @param {Record<string, any>} basis @param {string} type @param {unknown} payload @param {Record<string, unknown>} [extra] */
const envelope = (basis, type, payload, extra = {}) => ({ type, commandVersion: 1, requestId: newRequestId(), basis: { epoch: basis.epoch, rev: basis.rev }, payload, ...extra });

describe('확인 필요 on the real shop file', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let app;
  /** @type {ReturnType<typeof device>} */ let counter;
  /** @type {ReturnType<typeof device>} */ let driver;
  let dataDir = '';
  /** @type {Record<string, string>} */ let env = {};

  before(async () => {
    dataDir = join(temp.dir, 'review');
    const shop = await provisionedShop(dataDir);
    env = shop.env;
    const sample = await cli(['load-sample', '--shop', SHOP, '--date', 'today'], env);
    assert.equal(sample.code, 0, sample.err);
    const codes = [await deviceCode(env), await deviceCode(env, ['--kind', 'driver_phone', '--label', '1호차 휴대폰', '--vehicle', 'v1'])];
    app = await startServer(testConfig(dataDir, env), { log: () => {} });
    counter = device(app.port);
    driver = device(app.port);
    assert.equal((await counter.enroll(/** @type {string} */ (codes[0]))).status, 200);
    assert.equal((await driver.enroll(/** @type {string} */ (codes[1]))).status, 200);
    assert.equal((await counter.login('김카운터', /** @type {string} */ (shop.pins['김카운터']))).status, 200);
    assert.equal((await driver.login('박기사', /** @type {string} */ (shop.pins['박기사']))).status, 200);
  });
  after(async () => { await app?.close(); });

  /** @param {(db: any) => unknown} read */
  const shopFile = (read) => {
    const db = openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'));
    try { return read(/** @type {any} */ (db)); } finally { db.close(); }
  };

  test('the imported sample item is open with `확인` · `접수증`; the counter resolves it once; a restart keeps it; the driver cannot', async () => {
    const list = await (await counter.query('reviewList', {})).json();
    const item = list.items.find((/** @type {any} */ x) => x.kindKey === 'already_returned');
    assert.ok(item, JSON.stringify(list.items));
    assert.equal(item.message, '최은정 팀 스키 1대 매장 반납 완료 · 기사 수거 기록 제외');
    assert.equal(item.source, 'stored');
    assert.deepEqual(item.choices.map((/** @type {any} */ c) => [c.key, c.label, c.enabled]), [['resolve', '확인', true], ['slip', '접수증', true]]);
    assert.equal(list.count, list.items.length);
    assert.deepEqual(list.tabs[0], { key: 'open', label: '미처리', count: list.count });
    shopFile((db) => {
      const row = db.prepare('SELECT source_key AS s, device_id AS d, task_id AS t, status_key AS st FROM review_items WHERE id = ?').get(item.id);
      assert.deepEqual({ ...row }, { s: 'import', d: null, t: null, st: 'open' });
    });

    // 기사 세션: 목록 · 환불 창 403, `확인`은 거절(기사 역할에는 review.resolve가 없다: FORBIDDEN, 있어도 기사 기기에서는 FORBIDDEN_SCOPE — 아래 권한 표).
    assert.equal((await driver.query('reviewList', {})).status, 403);
    assert.equal((await driver.query('refundSheet', { orderId: item.orderId })).status, 403);
    const head = await (await counter.get('/api/v2/head')).json();
    const refused = await (await driver.command(envelope(head, 'review.resolve', item.choices[0].command.payload))).json();
    assert.equal(refused.error?.code, 'FORBIDDEN');
    // 서버 모드는 온라인만: 보냄 대기 명령의 칸은 봉투에서 거절.
    const queued = await driver.command(envelope(head, 'stock.collect', { taskId: 'collect:' + item.orderId, lines: [] }, { deviceSeq: 1 }));
    assert.equal(queued.status, 400);
    assert.equal((await queued.json()).code, 'QUEUE_NOT_SUPPORTED');

    // 카운터의 `확인`: 적용 → 처리 완료 탭(`확인 완료 · HH:MM · 김카운터`), 같은 요청번호를 다시 보내도 한 번, 다른 요청은 `확인 완료`.
    const resolve = envelope(head, 'review.resolve', item.choices[0].command.payload);
    const done = await (await counter.command(resolve)).json();
    assert.equal(done.outcome, 'applied', JSON.stringify(done.error ?? null));
    const replay = await (await counter.command(resolve)).json();
    assert.deepEqual([replay.outcome, replay.rev], ['applied', done.rev]);
    const head2 = await (await counter.get('/api/v2/head')).json();
    const again = await (await counter.command(envelope(head2, 'review.resolve', item.choices[0].command.payload))).json();
    assert.deepEqual([again.outcome, again.error?.message], ['superseded', '확인 완료']);
    const after1 = await (await counter.query('reviewList', {})).json();
    assert.equal(after1.count, list.count - 1);
    const doneRow = after1.done.find((/** @type {any} */ x) => x.id === item.id);
    assert.match(doneRow.resolvedLine, /^확인 완료 · \d{2}:\d{2} · 김카운터$/);
    shopFile((db) => {
      const row = db.prepare('SELECT status_key AS st, resolution_key AS rk, resolved_by AS rb, updated_rev AS ur FROM review_items WHERE id = ?').get(item.id);
      assert.equal(row.st, 'resolved');
      assert.equal(row.rk, 'acknowledged');
      assert.match(String(row.rb), /^staff:/);
      assert.equal(row.ur, done.rev);
    });

    // 다시 띄워도 그대로(처리 완료 · 누가).
    await app.close();
    app = await startServer(testConfig(dataDir, env), { log: () => {} });
    const fresh = device(app.port);
    Object.assign(fresh.state, { cookie: counter.state.cookie, csrf: counter.state.csrf });
    const restarted = await (await fresh.query('reviewList', {})).json();
    assert.equal(restarted.count, after1.count);
    assert.equal(restarted.done.find((/** @type {any} */ x) => x.id === item.id)?.resolvedLine, doneRow.resolvedLine);
    counter = fresh;
  });

  test('the refund window of an order that is not overpaid says `환불 대상 없음` and carries no command', async () => {
    const list = await (await counter.query('ledgerView', { viewKey: 'day_ledger' })).json();
    const orderId = list.rows[0].orderId;
    const sheet = await (await counter.query('refundSheet', { orderId })).json();
    assert.equal(sheet.notice, '환불 대상 없음');
    assert.equal(sheet.command, undefined);
    assert.equal(sheet.primary.enabled, false);
  });
});

test('the permission table: review.resolve needs review.resolve; a driver session is refused', () => {
  const basis = { epoch: 'e', rev: 1 };
  const env = /** @type {any} */ ({ type: 'review.resolve', commandVersion: 1, requestId: newRequestId(), basis, payload: { reviewId: 'r1', resolutionKey: 'acknowledged' } });
  const counter = { roleKey: 'counter', deviceKind: /** @type {const} */ ('pos') };
  const driver = { roleKey: 'driver', deviceKind: /** @type {const} */ ('driver_phone'), vehicleId: 'v1' };
  const shop = /** @type {const} */ ({ kind: 'shop' });
  assert.equal(commandGuard(counter, new Map([['review.resolve', 'shop']]), env)(shop), null);
  assert.equal(commandGuard(counter, new Map([['stock.move', 'shop']]), env)(shop)?.error?.code, 'FORBIDDEN');
  assert.equal(commandGuard(driver, new Map([['review.resolve', 'shop']]), env)(shop)?.error?.code, 'FORBIDDEN_SCOPE');
});

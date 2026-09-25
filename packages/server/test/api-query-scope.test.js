// @ts-check
// 조회 권한(plan §5-4 조회 표, D17): 기사 세션은 수거 · 배달 목록(차량을 자기 차량으로 바꿔 읽음), 자기 차량의 짐, 자기 차량 업무의 판 ·
// 현장 수납 · 리프트권 추가 · 확인 창 초안, 화면 설정만 읽고 나머지(장부 · 접수증 · 끝 4자리 · 카운터의 판)는 403. 카운터 세션은 모두
// 읽는다. 표의 모든 줄을 기사 세션으로 부른다(범위를 정해 둔 가짜 창구). 진짜 매장 파일에서는 도메인 queryScope가 아직 없어 기사의 업무
// 판은 거절 쪽으로 기울고, 카운터는 모든 조회를 읽는다(없는 접수는 404).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DRIVER_QUERY_RULES } from '../src/permissions.js';
import { startServer } from '../src/server.js';
import { fakeShop } from './fake-store.js';
import { device, deviceCode, provisionedShop, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

const draft = { channel: 'walk_in', leader: { name: '', phone: '', party: 1 }, items: [], pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' } };
/** 조회마다 맞는 인자(업무 · 접수 id의 끝이 차량: 가짜 창구가 그것으로 범위를 정한다). @type {Record<string, unknown>} */
const PARAMS = {
  config: {},
  'ledgerView:day_ledger': { viewKey: 'day_ledger' },
  'ledgerView:collection_list': { viewKey: 'collection_list', vehicleId: 'v2' },
  'ledgerView:delivery_list': { viewKey: 'delivery_list' },
  vehicleLoad: { vehicleId: 'v1' },
  taskSheet: { taskId: 'collect:o1v1' },
  fieldPaySheet: { taskId: 'collect:o1v1' },
  addTicketSheet: { taskId: 'deliver:o2v1' },
  confirmDraft: { actionKey: 'stamp.collect', taskId: 'collect:o1v1' },
  orderSlip: { orderId: 'o1v1' },
  findLast4: { last4: '1234' },
  reviewList: {},
  orderDraft: { draft },
  checkoutSheet: { draft },
  groupPaySheet: { orderId: 'o1v1' },
  partialPaySheet: { orderId: 'o1v1', payerOrderId: 'o2v1' },
  promiseSheet: { orderId: 'o1v1' },
  returnSheet: { orderId: 'o1v1' },
  closingSheet: {},
  shopRules: {},
};

/** @param {string} key */
const bodyOf = key => (key.startsWith('ledgerView:') ? { name: 'ledgerView', params: PARAMS[key] } : { name: key, params: PARAMS[key] });

describe('the query table (fake store port)', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let app;
  /** @type {ReturnType<typeof device>} */ let driver;
  /** @type {ReturnType<typeof device>} */ let counter;

  before(async () => {
    const dataDir = join(temp.dir, 'fake');
    const shop = await provisionedShop(dataDir);
    const codes = [await deviceCode(shop.env, ['--kind', 'driver_phone', '--label', '1호차 휴대폰', '--vehicle', 'v1']), await deviceCode(shop.env)];
    app = await startServer(testConfig(dataDir, shop.env), {
      log: () => {},
      shopPort: real => fakeShop(real, {
        scopeOfQuery: (_name, params) => {
          const ref = String(params.taskId ?? params.orderId ?? params.vehicleId ?? '');
          const vehicle = /(v\d)$/.exec(ref)?.[1];
          return vehicle ? { kind: 'vehicle', vehicleIds: [vehicle] } : null;
        },
      }),
    });
    driver = device(app.port);
    counter = device(app.port);
    await driver.enroll(/** @type {string} */ (codes[0]));
    await counter.enroll(/** @type {string} */ (codes[1]));
    assert.equal((await driver.login('박기사', /** @type {string} */ (shop.pins['박기사']))).status, 200);
    assert.equal((await counter.login('김카운터', /** @type {string} */ (shop.pins['김카운터']))).status, 200);
  });
  after(async () => { await app?.close(); });

  test('every row of the table from a driver session: allowed ones answer, the rest are 403', async () => {
    assert.deepEqual(Object.keys(PARAMS).sort(), Object.keys(DRIVER_QUERY_RULES).sort(), 'the test covers every row');
    for (const [key, rule] of Object.entries(DRIVER_QUERY_RULES)) {
      const res = await driver.post('/api/v2/query', bodyOf(key));
      const body = await res.json();
      if (rule === 'deny') {
        assert.equal(res.status, 403, key);
        assert.equal(body.code, 'FORBIDDEN', key);
      } else {
        assert.equal(res.status, 200, key + ' ' + JSON.stringify(body));
      }
    }
  });

  test('driver lists are forced to the device\'s vehicle', async () => {
    const asked = await (await driver.query('ledgerView', { viewKey: 'collection_list', vehicleId: 'v2' })).json();
    assert.equal(asked.params.vehicleId, 'v1');
    const none = await (await driver.query('ledgerView', { viewKey: 'delivery_list' })).json();
    assert.equal(none.params.vehicleId, 'v1');
    const counterList = await (await counter.query('ledgerView', { viewKey: 'collection_list', vehicleId: 'v2' })).json();
    assert.equal(counterList.params.vehicleId, 'v2', 'counters read any vehicle');
  });

  test('another vehicle\'s load, task or draft is 403 for a driver', async () => {
    assert.equal((await driver.query('vehicleLoad', { vehicleId: 'v2' })).status, 403);
    assert.equal((await driver.query('taskSheet', { taskId: 'collect:o1v2' })).status, 403);
    assert.equal((await driver.query('fieldPaySheet', { taskId: 'collect:o9' })).status, 403, 'an unknown scope is refused');
    assert.equal((await driver.query('confirmDraft', { actionKey: 'stamp.collect', orderId: 'o3v2' })).status, 403);
  });

  test('a counter session reads every query', async () => {
    for (const key of Object.keys(PARAMS)) {
      const res = await counter.post('/api/v2/query', bodyOf(key));
      assert.equal(res.status, 200, key);
      await res.json();
    }
  });
});

describe('the real shop file', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let app;
  /** @type {ReturnType<typeof device>} */ let driver;
  /** @type {ReturnType<typeof device>} */ let counter;

  before(async () => {
    const dataDir = join(temp.dir, 'real');
    const shop = await provisionedShop(dataDir);
    const codes = [await deviceCode(shop.env, ['--kind', 'driver_tablet', '--label', '1호차 태블릿', '--vehicle', 'v1']), await deviceCode(shop.env)];
    app = await startServer(testConfig(dataDir, shop.env), { log: () => {} });
    driver = device(app.port);
    counter = device(app.port);
    await driver.enroll(/** @type {string} */ (codes[0]));
    await counter.enroll(/** @type {string} */ (codes[1]));
    assert.equal((await driver.login('박기사', /** @type {string} */ (shop.pins['박기사']))).status, 200);
    assert.equal((await counter.login('김카운터', /** @type {string} */ (shop.pins['김카운터']))).status, 200);
  });
  after(async () => { await app?.close(); });

  test('a counter reads the read models of the provisioned shop; a missing order is 404', async () => {
    const config = await (await counter.query('config')).json();
    assert.equal(config.shopName, '시험 매장');
    assert.equal(config.timezone, 'Asia/Seoul');
    for (const key of ['ledgerView:day_ledger', 'ledgerView:collection_list', 'ledgerView:delivery_list', 'vehicleLoad', 'findLast4', 'reviewList', 'orderDraft', 'checkoutSheet', 'closingSheet', 'shopRules']) {
      const res = await counter.post('/api/v2/query', bodyOf(key));
      assert.equal(res.status, 200, key + ' ' + (res.status === 200 ? '' : await res.text()));
      await res.json();
    }
    const slip = await counter.query('orderSlip', { orderId: 'nope' });
    assert.equal(slip.status, 404);
    assert.equal((await slip.json()).code, 'NOT_FOUND');
  });

  test('a driver on the real store: own lists and load answer; task sheets wait for the domain scope (403)', async () => {
    const list = await driver.query('ledgerView', { viewKey: 'collection_list' });
    assert.equal(list.status, 200);
    await list.json();
    const load = await driver.query('vehicleLoad', { vehicleId: 'v1' });
    assert.equal(load.status, 200);
    await load.json();
    assert.equal((await driver.query('taskSheet', { taskId: 'collect:o1' })).status, 403);
    assert.equal((await driver.query('ledgerView', { viewKey: 'day_ledger' })).status, 403);
  });
});

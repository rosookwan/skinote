const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHttpClient, createLocalClient, newCommand } = require('../src/returns/client.js');
const { createMemoryRepository, createService } = require('../src/returns/service.js');
const { seed } = require('../src/returns/demo.js');
const { ctx, sample } = require('./returns-fixtures.cjs');

test('UI command captures quantity and version once so retries retain the original request', async () => {
  const service = createService(createMemoryRepository(), ctx);
  const client = createLocalClient(service);
  const payload = sample(); const command = newCommand('create', { id: 'order-1', version: 0 }, payload);
  payload.items[0].plannedQuantity = 100;
  const result = await client.execute(command);
  assert.equal(result.order.items[0].plannedQuantity, 2);
  assert.equal((await client.execute(command)).duplicate, true);
  assert.equal((await client.sync()).revision, 1);
});
test('HTTP client preserves conflict details and leaves uncertain writes for explicit retry', async () => {
  const requests = [];
  const config = { baseUrl: 'https://returns.example', token: 'test-token-'.padEnd(40, 'x'), fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { ok: false, status: 409, json: async () => ({ error: { code: 'VERSION_CONFLICT', message: '최신 내역을 확인해 주세요.' } }) };
  } };
  const client = createHttpClient(config);
  const command = newCommand('create', { id: 'order-1', version: 0 }, sample());
  await assert.rejects(client.execute(command), error => error.code === 'VERSION_CONFLICT' && error.status === 409);
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].options.body).requestId, command.requestId);
  const failed = createHttpClient({ ...config, fetchImpl: async () => { throw new Error('network down'); } });
  await assert.rejects(failed.execute(command), error => error.code === 'CONNECTION_ERROR');
  assert.equal(requests.length, 1);
  assert.throws(() => createHttpClient({ ...config, baseUrl: 'http://public.example' }));
  assert.throws(() => createHttpClient({ ...config, baseUrl: 'https://returns.example?token=secret' }));
});
test('demo seeding is repeatable without resetting existing returns', () => {
  const service = createService(createMemoryRepository(), ctx);
  const ids = seed(service, '2026-09-07');
  const order = service.get(ids[1]);
  service.execute(newCommand('receiveDirect', order, { items: [{ itemId: 'ticket', quantity: 1 }] }));
  seed(service, '2026-09-08');
  assert.equal(service.get(ids[1]).items[0].shopQuantity, 1);
  assert.equal(service.get(ids[1]).items[0].returnPlan.date, '2026-09-07');
});
test('watch stops delivery after logout while an in-flight request finishes', async () => {
  let release; const updates = [], statuses = [];
  const client = createLocalClient({ mode: 'memory', sync: () => new Promise(resolve => { release = resolve; }) });
  const stop = client.watch({ onChange: result => updates.push(result), onStatus: status => statuses.push(status) });
  stop(); release({ revision: 1, orders: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updates, []); assert.deepEqual(statuses, []);
});

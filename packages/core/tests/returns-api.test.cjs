const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { createSqliteRepository } = require('../server/returns-repository.cjs');
const { createApiServer, tokenAuthenticator } = require('../server/returns-api.cjs');
const { sample } = require('./returns-fixtures.cjs');

test('HTTP clients share durable return updates with trusted roles, conflict and replay responses', async t => {
  const repository = createSqliteRepository(':memory:');
  const tokens = { store: 'test-store-'.padEnd(40, 's'), driver: 'test-driver-'.padEnd(40, 'd'), other: 'test-other-'.padEnd(40, 'o') };
  const credentials = Object.entries(tokens).map(([role, token]) => ({ tokenHash: createHash('sha256').update(token).digest('hex'), shopId: role === 'other' ? 'shop-2' : 'shop-1', actor: { id: role, role: role === 'driver' ? 'driver' : 'store', ...(role === 'driver' ? { vehicleId: 'van-1' } : {}) } }));
  const server = createApiServer({ repository, authenticate: tokenAuthenticator(credentials), clock: () => '2026-09-08T08:00:00.000Z', allowedOrigins: ['http://127.0.0.1:58148'] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); repository.close(); });
  const url = 'http://127.0.0.1:' + server.address().port;
  async function call(route, { role = 'store', body, headers = {} } = {}) {
    const response = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(role ? { Authorization: 'Bearer ' + tokens[role] } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  const make = (type, payload, expectedVersion, requestId) => ({ type, payload, expectedVersion, requestId, orderId: 'order-1' });
  const post = (body, role = 'store') => call('/api/returns/commands', { body, role });
  assert.equal((await call('/health', { role: null })).status, 200);
  assert.equal((await call('/api/returns', { role: null })).status, 401);
  assert.equal((await call('/api/returns', { headers: { Origin: 'https://unknown.example' } })).status, 403);
  assert.equal((await post(make('create', sample(), 0, 'create-1'))).status, 200);
  assert.equal((await post(make('issue', { items: sample().items.map(item => ({ itemId: item.id, quantity: 2 })) }, 1, 'issue-1'))).status, 200);
  assert.equal((await call('/api/returns/orders/order-1', { role: 'other' })).status, 404);
  const current = await call('/api/returns/sync', { role: 'driver' });
  assert.equal(current.data.orders[0].version, 2);
  assert.equal(current.data.orders[0].rental, undefined);
  const pickup = make('collect', { items: [{ itemId: 'ski', quantity: 2 }] }, 2, 'collect-1');
  const [a, b] = await Promise.all([post(pickup, 'driver'), post(pickup, 'driver')]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(Number(a.data.duplicate) + Number(b.data.duplicate), 1);
  const updates = await call('/api/returns/sync?afterRevision=' + current.data.revision);
  assert.equal(updates.data.orders[0].totals.vehicleQuantity, 2);
  assert.equal((await post({ ...pickup, requestId: 'old-version' }, 'driver')).status, 409);
  assert.equal((await post(make('receiveDirect', { items: [{ itemId: 'ticket', quantity: 1 }] }, 3, 'fake-store'), 'driver')).status, 403);
  assert.equal((await post({ ...pickup, actor: { role: 'store' } })).status, 400);
  assert.equal((await call('/api/returns/report', { role: 'driver' })).status, 403);
  assert.equal((await call('/api/returns/orders/order-1/history')).data.events.length, 3);
  assert.equal((await call('/api/returns/sync?afterRevision=-1')).status, 400);
  assert.equal((await call('/api/returns?shopId=shop-2')).status, 400);
  assert.equal((await post(null)).status, 400);
});

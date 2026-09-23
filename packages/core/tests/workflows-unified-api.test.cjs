const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createApiServer, tokenAuthenticator } = require('../server/returns-api.cjs');
const { createSqliteRepository } = require('../server/returns-repository.cjs');
const { createHttpClient, newCommand } = require('../src/workflows/client.js');
test('one visit survives HTTP and SQLite restart with late arrivals, independent lines, duplicate issue and stale add', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ski-api-v2-')), db = join(dir, 'ops.sqlite');
  const token = 'integration-test-only-'.padEnd(48, 'x');
  const authenticate = tokenAuthenticator([{ tokenHash: createHash('sha256').update(token).digest('hex'), shopId: 'shop-1', actor: { id: 'store-1', role: 'store' } }]);
  let repository, server;
  async function start() {
    repository = createSqliteRepository(db); server = createApiServer({ repository, authenticate, clock: () => '2026-09-13T00:00:00.000Z' });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return createHttpClient({ baseUrl: 'http://127.0.0.1:' + server.address().port, token });
  }
  async function stop() { await new Promise(resolve => server.close(resolve)); repository.close(); }
  try {
    let client = await start();
    const run = async (type, payload) => client.execute(newCommand(type, await client.snapshot(), payload));
    const line = (id, personId, date, sku = 'ski') => ({ id, personId, sku, quantity: 1, start: date, end: date, price: { unitWon: 10000, discountWon: id === 'a-ski' ? 1000 : 0 } });
    await run('order.create', { id: 'team-1', customer: { name: '한 팀', phone: '010-1234-1234' }, people: [{ id: 'A', name: 'A' }, { id: 'B' }], batch: { id: 'first', lines: [line('a-ski', 'A', '2026-09-13'), line('b-ski', 'B', '2026-09-13')] } });
    const stock = await run('stock.receive', { sku: 'ski', quantity: 3 });
    const issue = newCommand('order.issue', await client.snapshot(), { orderId: 'team-1', lineItems: [{ lineId: 'a-ski', assetIds: stock.assetIds.slice(0, 1) }, { lineId: 'b-ski', assetIds: stock.assetIds.slice(1, 2) }] });
    const response = await Promise.all([client.execute(issue), client.execute(issue)]);
    assert.equal(response.filter(r => r.duplicate).length, 1);
    const before = (await client.snapshot()).orders[0];
    await run('order.add', { orderId: 'team-1', people: [{ id: 'C' }], batch: { id: 'same-day', lines: [line('c-ski', 'C', '2026-09-13')] } });
    const stale = newCommand('order.add', await client.snapshot(), { orderId: 'team-1', people: [{ id: 'D' }], batch: { id: 'tomorrow', lines: [line('d-ski', 'D', '2026-09-14')] } });
    await run('order.add', { orderId: 'team-1', batch: { id: 'a-extra', lines: [line('a-clothes', 'A', '2026-09-13', 'clothing')] } });
    await assert.rejects(client.execute(stale), e => e.code === 'VERSION_CONFLICT');
    await run(stale.type, stale.payload);
    const state = await client.snapshot(), order = state.orders[0];
    assert.deepEqual(order.lines.slice(0, 2), before.lines);
    assert.equal(order.customer.phone, before.customer.phone);
    assert.equal(order.lines.length, 5); assert.equal(order.people.length, 4);
    assert.equal(order.totals.issuedQuantity, 2); assert.equal(order.totals.unissuedQuantity, 3);
    await stop(); client = await start();
    assert.deepEqual((await client.snapshot()).orders, state.orders);
    assert.deepEqual((await client.snapshot()).assets, state.assets);
    await stop(); server = null;
  } finally { if (server?.listening) await stop(); rmSync(dir, { recursive: true, force: true }); }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHttpClient } = require('../src/workflows/client.js');
test('uncertain request recovery is encrypted and isolated by endpoint and staff key', async () => {
  const values = new Map(), pendingStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const options = { baseUrl: 'http://localhost:1234', token: 'a'.repeat(48), pendingStorage };
  const first = createHttpClient(options), command = { type: 'finance.payment', requestId: 'payment-request-1', expectedVersion: 3, payload: { orderId: 'team-a', amountWon: 10000 } };
  await first.persistPending(command);
  assert.ok(![...values.values()].join('').includes('team-a'));
  assert.ok(![...values.values()].join('').includes(options.token));
  const [name, encrypted] = [...values][0], lookupBytes = Uint8Array.from(name.split(':').at(-1).match(/../g).map(hex => parseInt(hex, 16))), publicLookupKey = await crypto.subtle.importKey('raw', lookupBytes, 'AES-GCM', false, ['decrypt']), envelope = JSON.parse(encrypted);
  await assert.rejects(crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(envelope.iv) }, publicLookupKey, Uint8Array.from(envelope.data)));
  assert.deepEqual(await createHttpClient(options).restorePending(), command);
  assert.equal(await createHttpClient({ ...options, token: 'b'.repeat(48) }).restorePending(), null);
  assert.equal(await createHttpClient({ ...options, baseUrl: 'http://localhost:1235' }).restorePending(), null);
  await first.clearPending(); assert.equal(await first.restorePending(), null);
});
test('unavailable local recovery storage fails before a write can be submitted', async () => {
  const client = createHttpClient({ baseUrl: 'http://localhost:1234', token: 'c'.repeat(48), pendingStorage: { setItem() { throw new Error('quota'); } } });
  await assert.rejects(client.persistPending({ requestId: 'once' }), error => error.code === 'PENDING_STORAGE_ERROR');
});

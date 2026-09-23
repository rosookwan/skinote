const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createSqliteRepository } = require('../server/returns-repository.cjs');
const { fixture, customer } = require('./workflows-fixtures.cjs');
const { backup, restore, inspect } = require('../scripts/backup-workflows.cjs');
test('online SQLite backup restores unified orders, money and audit without overwriting a destination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ski-backup-')), source = join(dir, 'source.sqlite'), copy = join(dir, 'backup.sqlite'), restored = join(dir, 'restored.sqlite');
  const repo = createSqliteRepository(source), f = fixture(repo);
  try {
    f.call('order.create', { id: 'one-visit', customer, batch: { id: 'first', lines: [{ id: 'line', sku: 'ski', quantity: 1, start: '2026-09-09', end: '2026-09-09', price: { unitWon: 10000 } }] } });
    f.call('finance.payment', { id: 'paid', orderId: 'one-visit', kind: 'payment', method: 'cash', amountWon: 10000 });
    const original = inspect(source), saved = backup(source, copy);
    assert.deepEqual(saved, original); assert.deepEqual(restore(copy, restored), original);
    const reopened = createSqliteRepository(restored);
    try { assert.deepEqual(reopened.workflows('shop-1'), repo.workflows('shop-1')); } finally { reopened.close(); }
    assert.throws(() => restore(copy, restored), /이미/); assert.throws(() => backup(source, copy), /이미/);
  } finally { repo.close(); rmSync(dir, { recursive: true, force: true }); }
});

// @ts-check
// 장부 트리거 생성기가 schema.sql의 트리거를 글자 하나까지 그대로 다시 만드는지(옛 review/gen-triggers.cjs를 옮긴 것).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CONTROL_LEDGERS, LEDGERS, NO_DELETE } from '../src/guards.js';
import { splitStatements } from '../src/sql.js';
import { regenerate } from '../tools/gen-triggers.js';
import { SCHEMA_FILE } from './helpers.js';

const schema = readFileSync(SCHEMA_FILE, 'utf8');
const triggerNames = (/** @type {string} */ sql) =>
  splitStatements(sql).filter(s => s.tokens[0].upper === 'CREATE' && s.tokens[1].upper === 'TRIGGER').map(s => s.tokens[2].value);

test('regenerating the ledger triggers reproduces schema.sql exactly', () => {
  const again = regenerate(schema);
  if (again !== schema) {
    const a = schema.split('\n');
    const b = again.split('\n');
    const at = a.findIndex((line, i) => line !== b[i]);
    assert.fail(`${at + 1}번째 줄부터 다릅니다:\n  지금: ${a[at]}\n  생성: ${b[at]}\n고치려면: npm run gen-triggers -w @skinote/schema`);
  }
});

test('the generator covers 50 shop ledgers, 2 control ledgers and 13 no-delete business tables', () => {
  assert.equal(LEDGERS.length, 50);
  assert.equal(new Set(LEDGERS).size, 50);
  assert.equal(CONTROL_LEDGERS.length, 2);
  assert.equal(NO_DELETE.length, 13);
  const names = new Set(triggerNames(schema));
  for (const t of [...LEDGERS, ...CONTROL_LEDGERS]) {
    assert.ok(names.has(`${t}_no_update`), `${t}_no_update`);
    assert.ok(names.has(`${t}_no_delete`), `${t}_no_delete`);
  }
  for (const t of NO_DELETE) assert.ok(names.has(`${t}_no_delete`), `${t}_no_delete`);
  assert.equal(names.size, 155, 'control 4 + shop 151');
});

test('a stale column list in schema.sql is caught by the regeneration', () => {
  const tampered = schema.replace(/(CREATE TRIGGER payments_no_update BEFORE UPDATE OF\n\s+)shop_id, /, '$1');
  assert.notEqual(tampered, schema, 'the payments guard was edited');
  assert.equal(regenerate(tampered), schema, 'regeneration restores the full column list');
});

test('hand-written price triggers outside the generated block are left alone', () => {
  const again = regenerate(schema);
  for (const name of ['price_list_versions_frozen', 'price_rules_frozen_insert', 'price_rule_tiers_frozen_delete']) {
    assert.ok(triggerNames(again).includes(name), name);
  }
});

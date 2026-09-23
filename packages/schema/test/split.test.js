// @ts-check
// schema.sql을 표시 줄로 나눈 마이그레이션 0001이 저장소의 파일과 같은지(어긋나면 npm run split).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildMigrations, splitSchema } from '../src/split.js';
import { staleMigrations } from '../tools/split.js';
import { MIGRATIONS, SCHEMA_FILE } from './helpers.js';

const schema = readFileSync(SCHEMA_FILE, 'utf8');

test('migrations 0001_control.sql and 0001_shop.sql are up to date with schema.sql', () => {
  assert.deepEqual(staleMigrations(), [], 'schema.sql과 어긋남: npm run split -w @skinote/schema');
  const wanted = buildMigrations(schema);
  assert.deepEqual(Object.keys(wanted).sort(), ['0001_control.sql', '0001_shop.sql']);
  for (const [name, text] of Object.entries(wanted)) assert.equal(readFileSync(join(MIGRATIONS, name), 'utf8'), text, name);
});

test('each migration holds exactly its database part and its seed part', () => {
  const { parts } = splitSchema(schema);
  for (const kind of /** @type {const} */ (['control', 'shop'])) {
    const text = readFileSync(join(MIGRATIONS, `0001_${kind}.sql`), 'utf8');
    assert.ok(text.includes(`-- @database ${kind}\n${parts[kind].database}`), `${kind} database part`);
    assert.ok(text.endsWith(`-- @seed ${kind}\n${parts[kind].seed}`), `${kind} seed part`);
    const other = kind === 'control' ? 'shop' : 'control';
    assert.ok(!text.includes(`-- @database ${other}`) && !text.includes(`-- @seed ${other}`), `${kind} holds no ${other} part`);
  }
  assert.match(parts.control.database, /CREATE TABLE accounts /);
  assert.doesNotMatch(parts.control.database, /CREATE TABLE orders /);
  assert.match(parts.shop.database, /CREATE TABLE orders /);
  assert.match(parts.shop.seed, /^INSERT INTO sys_features /m);
});

test('the split is the same for a file with CRLF line ends and a BOM', () => {
  const windows = '﻿' + schema.replace(/\n/g, '\r\n');
  assert.deepEqual(buildMigrations(windows), buildMigrations(schema));
});

test('a missing, repeated or misspelled marker line stops the split', () => {
  assert.throws(() => splitSchema(schema.replace('-- @seed shop\n', '')), /"-- @seed shop"가 없습니다/);
  assert.throws(() => splitSchema(schema + '\n-- @seed control\nSELECT 1;\n'), /두 번/);
  assert.throws(() => splitSchema(schema.replace('-- @seed shop\n', '-- @seeds shop\n')), /알 수 없는 표시 줄/);
  assert.throws(() => splitSchema(schema.replace(/-- @seed control\n[\s\S]*?(?=\n-- @seed shop)/, '-- @seed control\n')), /비어 있습니다/);
});

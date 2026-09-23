// @ts-check
// 스키마 구조 확인(옛 review/validate2.cjs의 앞부분). 실행기로 마이그레이션을 적용한 DB에서 본다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMigrations } from '../src/migrations.js';
import { findListChecks, inspectStructure, integrityOf } from '../src/structure.js';
import { migratedMemoryDb } from './helpers.js';

/** data-model.md 머리 표와 README '확인한 것'에 적힌 0001의 숫자. */
const DOCUMENTED_0001 = {
  control: { tables: 28, sysTables: 1, tenantTables: 0, indexes: 19, triggers: 4, fkGroups: 26 },
  shop: { tables: 260, sysTables: 62, tenantTables: 194, indexes: 207, triggers: 148, fkGroups: 827 },
};

for (const kind of /** @type {const} */ (['control', 'shop'])) {
  test(`${kind}: every foreign key group targets a primary key or a full unique index, and there is no inline UNIQUE`, () => {
    const db = migratedMemoryDb(kind);
    try {
      const { problems, fkGroups } = inspectStructure(db);
      assert.ok(fkGroups > 0);
      assert.deepEqual(problems, []);
    } finally {
      db.close();
    }
  });

  test(`${kind}: no CHECK (x IN (...)) list other than booleans and signs in any migration`, () => {
    for (const migration of loadMigrations(kind)) assert.deepEqual(findListChecks(migration.sql), [], migration.name);
  });

  test(`${kind}: foreign_key_check is empty and integrity_check is ok after the migrations and seeds`, () => {
    const db = migratedMemoryDb(kind);
    try {
      const { fkCheck, integrity } = integrityOf(db);
      assert.deepEqual(fkCheck, []);
      assert.deepEqual(integrity, ['ok']);
    } finally {
      db.close();
    }
  });

  test(`${kind}: migration 0001 has the table, index, trigger and foreign key counts written in the docs`, () => {
    const db = migratedMemoryDb(kind, loadMigrations(kind).slice(0, 1));
    try {
      const { problems, ...counts } = inspectStructure(db);
      assert.deepEqual(counts, DOCUMENTED_0001[kind]);
    } finally {
      db.close();
    }
  });
}

test('the list-CHECK finder catches an enum but allows booleans and signs', () => {
  assert.deepEqual(findListChecks("CREATE TABLE t (a INTEGER CHECK (a IN (0, 1)), s INTEGER CHECK (s IN (-1, 0, 1)));"), []);
  const found = findListChecks("CREATE TABLE t (k TEXT CHECK (k IN ('cash', 'card')));");
  assert.equal(found.length, 1);
  assert.equal(found[0].values, "'cash','card'");
});

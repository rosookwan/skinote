// @ts-check
// 시험이 함께 쓰는 도우미. 파일 이름이 *.test.js가 아니라 node --test가 따로 돌리지 않는다.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/connection.js';
import { applyPending } from '../src/migrate.js';
import { loadMigrations } from '../src/migrations.js';

export const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
export const SCHEMA_FILE = join(PACKAGE_DIR, 'schema.sql');
export const MIGRATIONS = join(PACKAGE_DIR, 'migrations');

/**
 * 마이그레이션을 적용한 메모리 DB(실행기와 같은 길).
 * @param {'control' | 'shop'} kind
 * @param {import('../src/migrations.js').Migration[]} [migrations]
 */
export function migratedMemoryDb(kind, migrations = loadMigrations(kind)) {
  const db = openDatabase(':memory:');
  applyPending(db, kind, { migrations, appVersion: 'test' });
  return db;
}

/** 시험마다 지울 임시 폴더. */
export function tempDir(prefix = 'skinote-schema-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

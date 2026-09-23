// @ts-check
// 마이그레이션 파일 찾기와 checksum. 파일 이름은 `NNNN_<control|shop>[_<이름>].sql`이고 번호는 종류마다 1부터 빈틈없이 이어진다.
// 앞으로만 간다: 번호를 건너뛰거나 겹치거나, 이름 모양이 틀린 .sql 파일이 있으면 아무것도 적용하지 않고 오류를 낸다.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSource } from './sql.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
export const FILE_PATTERN = /^(\d{4})_(control|shop)(?:_([a-z0-9]+(?:_[a-z0-9]+)*))?\.sql$/;

/**
 * @typedef {'control' | 'shop'} DatabaseKind
 * @typedef {{ id: number, name: string, kind: DatabaseKind, file: string | null, sql: string, checksum: string }} Migration
 */

export class MigrationSetError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'MigrationSetError';
    this.code = 'BAD_MIGRATION_SET';
  }
}

/** @param {string} kind @returns {asserts kind is DatabaseKind} */
export function assertKind(kind) {
  if (kind !== 'control' && kind !== 'shop') throw new MigrationSetError(`데이터베이스 종류는 control 또는 shop입니다: ${kind}`);
}

/**
 * 마이그레이션 원문의 sha256(16진수). BOM과 줄 끝(CRLF)은 맞춘 뒤 계산하므로 Windows에서 받은 파일도 같은 값이다.
 * @param {string} text
 */
export function checksum(text) {
  return createHash('sha256').update(normalizeSource(text), 'utf8').digest('hex');
}

/**
 * 이름과 내용으로 마이그레이션 목록을 만든다(시험 · 메모리 DB용, 파일 없이).
 * @param {DatabaseKind} kind
 * @param {{ name: string, sql: string, file?: string | null }[]} sources
 * @returns {Migration[]}
 */
export function fromSources(kind, sources) {
  assertKind(kind);
  const migrations = sources.map(({ name, sql, file = null }) => {
    const m = `${name}.sql`.match(FILE_PATTERN);
    if (!m) throw new MigrationSetError(`마이그레이션 이름 모양이 틀렸습니다: ${name}(NNNN_${kind}[_이름])`);
    if (m[2] !== kind) throw new MigrationSetError(`${name}은(는) ${kind} 마이그레이션이 아닙니다`);
    return { id: Number(m[1]), name, kind, file, sql, checksum: checksum(sql) };
  });
  migrations.sort((a, b) => a.id - b.id);
  migrations.forEach((migration, index) => {
    if (migration.id !== index + 1) {
      const expected = String(index + 1).padStart(4, '0');
      throw new MigrationSetError(`${kind} 마이그레이션 번호가 이어지지 않습니다: ${expected}_${kind} 자리에 ${migration.name}`);
    }
  });
  return migrations;
}

/**
 * 폴더에서 한 종류의 마이그레이션을 번호순으로 읽는다.
 * @param {DatabaseKind} kind
 * @param {string} [dir]
 * @returns {Migration[]}
 */
export function loadMigrations(kind, dir = MIGRATIONS_DIR) {
  assertKind(kind);
  const sources = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.toLowerCase().endsWith('.sql')) continue;
    const m = entry.match(FILE_PATTERN);
    if (!m) throw new MigrationSetError(`마이그레이션 폴더에 이름 모양이 틀린 파일이 있습니다: ${entry}`);
    if (m[2] !== kind) continue;
    const file = join(dir, entry);
    sources.push({ name: entry.slice(0, -4), sql: readFileSync(file, 'utf8'), file });
  }
  if (!sources.length) throw new MigrationSetError(`${kind} 마이그레이션이 없습니다: ${dir}`);
  return fromSources(kind, sources);
}

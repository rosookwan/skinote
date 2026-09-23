// @ts-check
// 연결 설정. 서버 · 가져오기 · 검증기 · 복구 시험 · 실행기가 모두 이 함수로 연다(data-model 7-3, sync 10-1).
// 연결마다 foreign_keys · recursive_triggers를 켜고 다시 읽어 확인한다. 하나라도 꺼져 있으면 연결을 닫고 오류를 낸다.
// recursive_triggers가 꺼지면 INSERT OR REPLACE가 장부의 삭제 금지 트리거를 건너뛰므로 장부가 덮어써질 수 있다.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** 파일 DB 연결마다 맞아야 하는 값(PRAGMA 이름 → 다시 읽은 값). synchronous 2 = FULL. */
export const CONNECTION_SETTINGS = Object.freeze({
  journal_mode: 'wal',
  synchronous: 2,
  foreign_keys: 1,
  recursive_triggers: 1,
  busy_timeout: 5000,
});

export class ConnectionSettingsError extends Error {
  /** @param {{ pragma: string, expected: unknown, actual: unknown }[]} mismatches */
  constructor(mismatches) {
    super('연결 설정이 맞지 않아 시작하지 않습니다: ' + mismatches.map(m => `${m.pragma}=${m.actual}(기대 ${m.expected})`).join(', '));
    this.name = 'ConnectionSettingsError';
    this.code = 'CONNECTION_SETTINGS';
    this.mismatches = mismatches;
  }
}

/** @param {DatabaseSync} db */
export function isMemoryDatabase(db) {
  const location = typeof db.location === 'function' ? db.location() : undefined;
  return location == null || location === '' || location === ':memory:';
}

/**
 * @param {DatabaseSync} db
 * @param {string} pragma
 */
function readPragma(db, pragma) {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  return row ? Object.values(row)[0] : undefined;
}

/**
 * 연결의 설정을 다시 읽어 확인한다. 다른 패키지(store · server)가 스스로 연 연결도 이 함수로 확인한다.
 * 메모리 DB(시험 · 체험판)는 WAL을 쓸 수 없고 읽기 전용 연결은 파일의 모드를 바꾸지 못하므로,
 * 그 둘은 journal_mode를 확인하지 않는다(requireWal = false).
 * @param {DatabaseSync} db
 * @param {{ requireWal?: boolean }} [options]
 * @returns {Record<string, unknown>} 읽은 값
 */
export function verifyConnection(db, { requireWal = !isMemoryDatabase(db) } = {}) {
  /** @type {Record<string, unknown>} */
  const actual = {};
  const mismatches = [];
  for (const [pragma, expected] of Object.entries(CONNECTION_SETTINGS)) {
    if (pragma === 'journal_mode' && !requireWal) continue;
    let value = readPragma(db, pragma);
    if (typeof value === 'string') value = value.toLowerCase();
    actual[pragma] = value;
    if (value !== expected) mismatches.push({ pragma, expected, actual: value });
  }
  if (mismatches.length) throw new ConnectionSettingsError(mismatches);
  return actual;
}

/**
 * 연결을 열고 설정을 켠 뒤 확인한다.
 * - 새 파일(표가 하나도 없음)이면 첫 표를 만들기 전에 auto_vacuum = INCREMENTAL.
 * - 쓰기 연결은 journal_mode = WAL. 읽기 전용 연결은 파일의 모드를 그대로 쓴다(WAL 파일이면 'wal').
 * - 모든 연결: busy_timeout = 5000(맨 먼저), synchronous = FULL, foreign_keys = ON, recursive_triggers = ON.
 * @param {string} file 파일 경로 또는 ':memory:'
 * @param {{ readOnly?: boolean }} [options]
 */
export function openDatabase(file, { readOnly = false } = {}) {
  const memory = file === ':memory:';
  if (readOnly && memory) throw new Error('메모리 DB는 읽기 전용으로 열 수 없습니다');
  if (readOnly && !existsSync(file)) throw new Error(`읽기 전용으로 열 파일이 없습니다: ${file}`);
  const db = readOnly ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file);
  try {
    // 기다리기(busy_timeout)를 맨 먼저 켠다: 다른 프로세스가 같은 파일을 쓰는 중이면 아래의 읽기 · journal_mode 바꾸기가
    // 곧바로 'database is locked'로 실패하지 않고 5초까지 기다린다.
    db.exec('PRAGMA busy_timeout = 5000');
    if (!readOnly && !memory) {
      const tables = /** @type {{ n: number }} */ (db.prepare('SELECT count(*) AS n FROM sqlite_schema').get()).n;
      if (tables === 0) db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      db.exec('PRAGMA journal_mode = WAL');
    }
    db.exec('PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;');
    verifyConnection(db, { requireWal: !memory && !readOnly });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

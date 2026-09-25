// @ts-check
// 시작할 때 control 파일과 매장 파일을 하나씩 마이그레이션 실행기(@skinote/schema의 migrate)로 연다.
// 한 파일이 거절(모르는 더 새 판 · checksum 다름 …)되거나 실패해도 서버는 멈추지 않는다: 그 파일은 읽기 전용이고
// 쓰기를 받지 않으며(writable = false), 상태 확인(/api/health)은 계속 답한다(data-model 7-3, deployment 7절).
//
// 쓰기 연결로 연 파일은 쓰기를 열기 전에 두 가지를 더 본다.
//   - 정말 쓸 수 있는가: 파일 · 폴더 권한이 없으면 SQLite는 말없이 읽기 전용으로 연다(root로 되살린 파일 등).
//     BEGIN IMMEDIATE 안에서 user_version을 같은 값으로 써 보고 되돌린다. 안 되면 READ_ONLY_FILE, 쓰기 막음.
//   - 그 판의 post_migration 백업이 온전한가(backup-files.js): 잘렸으면 치우고 다시 받고, 못 받으면 쓰기 막음.
// control이 쓰기 불가면 매장 파일은 마이그레이션하지 않고 읽기 전용으로만 연다(CONTROL_UNAVAILABLE): 어차피 쓸 수 없고,
// 매장 파일만 새 판으로 올라가면 전 릴리스로 되돌릴 때 모든 매장이 거절된다.
//
// 이 파일의 PRAGMA(journal_mode · page_count · page_size 읽기, 쓰기 확인)는 운영 상태 보기용이다. 업무 SQL이 아니며,
// @skinote/schema에 같은 일을 하는 함수(예: inspectConnection)가 생기면 그쪽으로 옮긴다.

import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadMigrations, migrate, openDatabase, readState } from '@skinote/schema';
import { ensurePostMigrationBackup, markVerified } from './backup-files.js';
import { errorCode, messageOf } from './errors.js';

/**
 * @typedef {import('node:sqlite').DatabaseSync} DatabaseSync
 * @typedef {import('./config.js').ServerConfig} ServerConfig
 * @typedef {'control' | 'shop'} DatabaseKind
 * @typedef {{ kind: DatabaseKind, shopId: string | null, file: string, source: string }} DatabaseTarget
 * @typedef {DatabaseTarget & {
 *   name: string,
 *   status: 'migrated' | 'up_to_date' | 'refused' | 'failed',
 *   mode: 'read_write' | 'read_only' | 'closed',
 *   schemaVersion: number | null,
 *   knownVersion: number | null,
 *   migrationCount: number | null,
 *   appliedAtStart: number,
 *   reason: string | null,
 *   warnings: string[],
 *   writable: boolean,
 *   db: DatabaseSync | null,
 * }} DatabaseEntry
 */

/** 자료 폴더의 하위 폴더를 만든다(주인만 읽고 쓰기). @param {ServerConfig} config */
export function ensureDataDirs(config) {
  for (const dir of [config.dataDir, config.dbDir, config.shopDbDir, config.backupDir, config.migrationBackupDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * 설정이 가리키는 데이터베이스 파일들(control 먼저). source는 db 폴더에서의 상대 경로로, 백업 목록의 열쇠다.
 * @param {ServerConfig} config
 * @returns {DatabaseTarget[]}
 */
export function databaseTargets(config) {
  return [
    { kind: 'control', shopId: null, file: join(config.dbDir, 'control.sqlite'), source: 'control.sqlite' },
    ...config.shopIds.map(shopId => /** @type {DatabaseTarget} */ ({
      kind: 'shop', shopId, file: join(config.shopDbDir, `${shopId}.sqlite`), source: `shops/${shopId}.sqlite`,
    })),
  ];
}

/** 쓰기를 막는 경고(하나라도 있으면 writable = false). */
export const BLOCKING_WARNINGS = Object.freeze(['POST_MIGRATION_BACKUP_MISSING', 'READ_ONLY_FILE']);

/**
 * 쓰기 연결이 정말 파일에 쓸 수 있는지 본다. user_version을 지금 값 그대로 쓰는 트랜잭션을 열고 되돌린다(파일은 바뀌지 않는다).
 * 파일이나 폴더에 쓰기 권한이 없으면 BEGIN IMMEDIATE나 쓰기에서 'attempt to write a readonly database'가 난다.
 * @param {DatabaseSync} db
 * @returns {string | null} 문제 코드(없으면 null)
 */
export function probeWrite(db) {
  let open = false;
  try {
    const row = db.prepare('PRAGMA user_version').get();
    const version = Number(row ? Object.values(row)[0] : 0) | 0;
    db.exec('BEGIN IMMEDIATE');
    open = true;
    db.exec(`PRAGMA user_version = ${version}`);
    return null;
  } catch (error) {
    return errorCode(error, 'WRITE_PROBE_FAILED');
  } finally {
    if (open) { try { db.exec('ROLLBACK'); } catch { /* 이미 끝난 트랜잭션 */ } }
  }
}

/** @param {DatabaseTarget} target @returns {DatabaseEntry} */
function blankEntry(target) {
  return {
    ...target,
    name: basename(target.file),
    status: 'failed',
    mode: 'closed',
    schemaVersion: null,
    knownVersion: null,
    migrationCount: null,
    appliedAtStart: 0,
    reason: null,
    warnings: [],
    writable: false,
    db: null,
  };
}

/**
 * 연결이 있으면 적용 기록 수 · 판을 채운다(스키노트 파일이 아니면 셀 것이 없다).
 * @param {DatabaseEntry} entry @param {ReturnType<typeof loadMigrations> | undefined} migrations
 */
function fillState(entry, migrations) {
  if (!entry.db || !migrations) return;
  try {
    const state = readState(entry.db, entry.kind, migrations);
    entry.migrationCount = state.applied.length;
    entry.schemaVersion ??= state.version;
  } catch {
    /* 스키노트 파일이 아니다 */
  }
}

/** 파일이 있으면 상태만이라도 보이게 읽기 전용으로 연다. @param {DatabaseEntry} entry */
function openReadOnly(entry) {
  if (!existsSync(entry.file)) return;
  try {
    entry.db = openDatabase(entry.file, { readOnly: true });
    entry.mode = 'read_only';
  } catch {
    entry.db = null;
  }
}

/**
 * control이 쓰기 불가일 때의 매장 파일: 마이그레이션하지 않고(파일을 바꾸지 않음) 읽기 전용으로만 연다.
 * @param {DatabaseTarget} target @param {(line: string) => void} log
 * @returns {DatabaseEntry}
 */
export function openHeldBack(target, log) {
  const entry = blankEntry(target);
  entry.status = 'refused';
  entry.reason = 'CONTROL_UNAVAILABLE';
  /** @type {ReturnType<typeof loadMigrations> | undefined} */
  let migrations;
  try {
    migrations = loadMigrations(target.kind);
    entry.knownVersion = migrations.length ? migrations[migrations.length - 1].id : 0;
  } catch {
    /* 목록을 읽지 못해도 파일은 건드리지 않는다 */
  }
  openReadOnly(entry);
  fillState(entry, migrations);
  log(`${target.source}: control 쓰기 불가라 마이그레이션하지 않음 · 판 ${entry.schemaVersion ?? '-'} · 쓰기 막음`);
  return entry;
}

/**
 * 파일 하나를 마이그레이션해서 연다. 던지지 않는다(실패는 entry.status = 'failed').
 * @param {DatabaseTarget} target
 * @param {ServerConfig} config
 * @param {{ log: (line: string) => void, now: () => Date }} io
 * @returns {DatabaseEntry}
 */
export function openOne(target, config, { log, now }) {
  const entry = blankEntry(target);
  const label = target.source;
  /** @type {ReturnType<typeof loadMigrations> | undefined} */
  let migrations;
  try {
    migrations = loadMigrations(target.kind);
    entry.knownVersion = migrations.length ? migrations[migrations.length - 1].id : 0;
    const result = migrate(target.file, target.kind, {
      migrations,
      backupDir: config.migrationBackupDir,
      appVersion: config.release,
      now,
    });
    entry.db = result.db;
    entry.status = result.status;
    entry.mode = result.mode;
    entry.schemaVersion = result.version;
    entry.appliedAtStart = result.applied.length;
    entry.reason = result.reason ?? null;
    for (const m of result.applied) log(`${label}: 적용 ${m.name} (${m.duration_ms} ms)`);
    if (result.status === 'refused') {
      for (const p of result.problems) log(`${label}: 거절(${p.code}) ${p.message}`);
    }
    if (result.status === 'failed' && result.error) log(`${label}: 실패(${result.error.code}) ${result.error.message}`);
    // 실행기가 돌려준 사본은 quick_check를 통과한 것이다: 다음 시작이 다시 읽지 않게 표시한다.
    for (const record of result.backups) markVerified(record.path, now());
    if (result.mode === 'read_write') {
      const readOnly = probeWrite(result.db);
      if (readOnly) {
        entry.warnings.push('READ_ONLY_FILE');
        log(`${label}: 쓰기 연결인데 파일에 쓸 수 없음(${readOnly}), 쓰기 막음: 파일 · 폴더의 주인과 권한 확인`);
      } else if (result.version > 0) {
        // 실행기의 약속(쓰기 전에 그 판의 post_migration 백업이 있다)을 온전한 사본으로 지킨다.
        const backup = ensurePostMigrationBackup(result.db, {
          file: target.file, version: result.version, backupDir: config.migrationBackupDir, now, log, label,
        });
        if (!backup.ok) entry.warnings.push('POST_MIGRATION_BACKUP_MISSING');
        else if (backup.broken.length) entry.warnings.push('POST_MIGRATION_BACKUP_RETAKEN');
      }
    }
    entry.writable = entry.mode === 'read_write' && !entry.warnings.some(w => BLOCKING_WARNINGS.includes(w));
  } catch (error) {
    entry.status = 'failed';
    entry.reason = errorCode(error, 'OPEN_FAILED');
    entry.writable = false;
    log(`${label}: 열지 못함(${entry.reason}) ${messageOf(error)}`);
    if (entry.db) {
      try { entry.db.close(); } catch { /* 이미 닫힘 */ }
      entry.db = null;
    }
    entry.mode = 'closed';
    openReadOnly(entry);
  }
  fillState(entry, migrations);
  log(`${label}: ${entry.status} · 판 ${entry.schemaVersion ?? '-'} · ${entry.writable ? '쓰기 가능' : '쓰기 막음'}`);
  return entry;
}

/**
 * 모든 파일을 연다: control 먼저, control이 쓰기 가능할 때만 매장 파일을 마이그레이션해서 연다(아니면 읽기 전용으로만).
 * @param {ServerConfig} config
 * @param {{ log?: (line: string) => void, now?: () => Date }} [io]
 */
export function openDatabases(config, { log = console.log, now = () => new Date() } = {}) {
  ensureDataDirs(config);
  const [controlTarget, ...shopTargets] = databaseTargets(config);
  const control = openOne(controlTarget, config, { log, now });
  const shops = shopTargets.map(target => (control.writable ? openOne(target, config, { log, now }) : openHeldBack(target, log)));
  return [control, ...shops];
}

/**
 * 운영 상태 값(개인정보 없음). 연결이 없으면 모두 null.
 * @param {DatabaseSync | null} db
 * @returns {{ journalMode: string | null, pageCount: number | null, pageSize: number | null }}
 */
export function inspectConnection(db) {
  if (!db) return { journalMode: null, pageCount: null, pageSize: null };
  /** @param {string} pragma */
  const one = pragma => {
    try {
      const row = db.prepare(`PRAGMA ${pragma}`).get();
      return row ? Object.values(row)[0] : null;
    } catch {
      return null;
    }
  };
  const journal = one('journal_mode');
  const pageCount = one('page_count');
  const pageSize = one('page_size');
  return {
    journalMode: typeof journal === 'string' ? journal.toLowerCase() : null,
    pageCount: typeof pageCount === 'number' ? pageCount : null,
    pageSize: typeof pageSize === 'number' ? pageSize : null,
  };
}

/**
 * 그 매장에 쓸 수 있는지: control과 그 매장 파일이 모두 쓰기 연결이어야 한다(쓰기 경로가 생기면 이것으로 막는다).
 * @param {DatabaseEntry[]} entries @param {string} shopId
 */
export function canWrite(entries, shopId) {
  const control = entries.find(e => e.kind === 'control');
  const shop = entries.find(e => e.kind === 'shop' && e.shopId === shopId);
  return !!control?.writable && !!shop?.writable;
}

/** 모든 연결을 닫는다(두 번 불러도 된다). @param {DatabaseEntry[]} entries */
export function closeDatabases(entries) {
  for (const entry of entries) {
    if (!entry.db) continue;
    try {
      entry.db.close();
    } catch {
      /* 이미 닫힘 */
    }
    entry.db = null;
    entry.mode = 'closed';
    entry.writable = false;
  }
}

// @ts-check
// 마이그레이션 실행기(data-model 7-3, migration-plan 6절 1주차).
//
// 순서: 읽기 전용으로 적용 기록 보기 → 모르는 판 · checksum 다름이면 적용하지 않고 그 읽기 전용 연결을 돌려줌
//   → 쓰기 연결 열기(설정 확인) → 남은 마이그레이션을 모두 먼저 훑어 트랜잭션 · PRAGMA 문장이 있으면 아무것도 바꾸지 않고 거절
//   → 비어 있지 않은 파일이면 `pre_migration` 백업(VACUUM INTO, quick_check) → 마이그레이션마다 BEGIN IMMEDIATE ·
//   (그사이 다른 프로세스가 적용했는지 다시 봄) · 적용 · foreign_key_check · quick_check · schema_migrations 기록(checksum) · COMMIT
//   → 적용 직후 `post_migration` 백업 → afterSchema 고리(ui_defaults.apply, json_schemas 싣기 자리).
// 실패하면 그 마이그레이션을 되돌리고 멈춘다. 앞에서 커밋한 마이그레이션은 남고(하나에 트랜잭션 하나), 파일은 읽기 전용으로 다시 연다
// (앱 N은 스키마 N을 기대하므로 옛 스키마로 쓰지 않는다, data-model 7-3).
// post_migration 백업이 실패해도 적용은 이미 커밋되었다: 결과에 backupError를 붙이고, 다음 시작(up_to_date)에서 그 판의
// post_migration 백업이 없으면 다시 받는다(일지 조각이 늘 같은 판의 백업에서 이어지게, 7-3).

import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase } from './connection.js';
import { assertKind, loadMigrations } from './migrations.js';
import { findRunnerOwnedStatements } from './sql.js';

export { CONNECTION_SETTINGS, ConnectionSettingsError, openDatabase, verifyConnection } from './connection.js';
export { checksum, fromSources, loadMigrations, MIGRATIONS_DIR } from './migrations.js';

/**
 * @typedef {import('node:sqlite').DatabaseSync} DatabaseSync
 * @typedef {import('./migrations.js').Migration} Migration
 * @typedef {import('./migrations.js').DatabaseKind} DatabaseKind
 * @typedef {{ id: number, name: string, database_key: string, checksum: string, app_version: string, applied_at: string }} AppliedRow
 * @typedef {{ code: string, message: string, id?: number, name?: string }} StateProblem
 * @typedef {{ kind: DatabaseKind, version: number, tables: number, applied: AppliedRow[], pending: Migration[], problems: StateProblem[] }} DatabaseState
 * @typedef {{ kind_key: string, path: string, sha256: string, bytes: number, version: number, created_at: string }} BackupRecord
 * @typedef {{ id: number, name: string, checksum: string, duration_ms: number }} AppliedMigration
 */

const PACKAGE_VERSION = /** @type {{ version: string }} */ (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))).version;

export class MigrationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ migration?: string, cause?: unknown, problems?: StateProblem[], applied?: AppliedMigration[], detail?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'MigrationError';
    this.code = code;
    this.migration = extra.migration;
    this.problems = extra.problems ?? [];
    /** @type {AppliedMigration[]} */
    this.applied = extra.applied ?? [];
    this.detail = extra.detail;
  }
}

/** 적용을 거절하는 까닭과 쉬운 설명. 순서가 우선순위다(맨 앞의 것이 result.reason). */
export const REFUSAL_MESSAGES = Object.freeze({
  WRONG_DATABASE: '다른 종류의 파일입니다(control과 shop이 바뀌었는지 확인해 주세요).',
  FOREIGN_FILE: '스키노트 파일이 아닙니다(적용 기록 표가 없는데 다른 표가 있습니다).',
  UNKNOWN_MIGRATION: '이 파일은 더 새 앱으로 고쳐졌습니다. 앱을 업데이트해 주세요.',
  CHECKSUM_MISMATCH: '이미 적용한 마이그레이션 파일의 내용이 바뀌었습니다.',
  NAME_MISMATCH: '이미 적용한 번호의 마이그레이션 이름이 다릅니다.',
  MISSING_MIGRATION: '적용 기록에 빠진 번호가 있습니다.',
  RUNNER_OWNED_STATEMENT: '마이그레이션에 트랜잭션 · PRAGMA 문장이 있습니다(실행기가 맡음). 아무것도 적용하지 않았습니다.',
  SQL_SYNTAX: '마이그레이션 문장을 읽지 못했습니다. 아무것도 적용하지 않았습니다.',
});
const REFUSAL_ORDER = Object.keys(REFUSAL_MESSAGES);

/**
 * 파일에 적용한 마이그레이션과 앱이 아는 마이그레이션을 맞춰 본다. 아무것도 쓰지 않는다.
 * @param {DatabaseSync} db
 * @param {DatabaseKind} kind
 * @param {Migration[]} migrations
 * @returns {DatabaseState}
 */
export function readState(db, kind, migrations) {
  assertKind(kind);
  const tables = /** @type {{ n: number }} */ (
    db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()
  ).n;
  const hasLedger = !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get();
  /** @type {StateProblem[]} */
  const problems = [];
  /** @type {AppliedRow[]} */
  let applied = [];
  if (!hasLedger) {
    if (tables > 0) problems.push({ code: 'FOREIGN_FILE', message: REFUSAL_MESSAGES.FOREIGN_FILE });
  } else {
    applied = /** @type {AppliedRow[]} */ (
      db.prepare('SELECT id, name, database_key, checksum, app_version, applied_at FROM schema_migrations ORDER BY id').all()
    );
    const known = new Map(migrations.map(m => [m.id, m]));
    const maxKnown = migrations.length ? migrations[migrations.length - 1].id : 0;
    applied.forEach((row, index) => {
      const at = { id: row.id, name: row.name };
      if (row.database_key !== kind) {
        problems.push({ code: 'WRONG_DATABASE', ...at, message: `${row.name}은(는) ${row.database_key} 파일의 기록입니다. ${REFUSAL_MESSAGES.WRONG_DATABASE}` });
      }
      const migration = known.get(row.id);
      if (!migration) {
        const newer = row.id > maxKnown ? '앱이 모르는 더 새 판' : '앱이 모르는 판';
        problems.push({ code: 'UNKNOWN_MIGRATION', ...at, message: `${row.name}: ${newer}. ${REFUSAL_MESSAGES.UNKNOWN_MIGRATION}` });
      } else if (migration.name !== row.name) {
        problems.push({ code: 'NAME_MISMATCH', ...at, message: `${row.id}번: 파일은 ${row.name}, 앱은 ${migration.name}. ${REFUSAL_MESSAGES.NAME_MISMATCH}` });
      } else if (migration.checksum !== row.checksum) {
        problems.push({ code: 'CHECKSUM_MISMATCH', ...at, message: `${row.name}: 기록 ${row.checksum.slice(0, 12)}…, 앱 ${migration.checksum.slice(0, 12)}…. ${REFUSAL_MESSAGES.CHECKSUM_MISMATCH}` });
      }
      if (row.id !== index + 1) {
        problems.push({ code: 'MISSING_MIGRATION', ...at, message: `${index + 1}번 자리에 ${row.name}. ${REFUSAL_MESSAGES.MISSING_MIGRATION}` });
      }
    });
  }
  problems.sort((a, b) => REFUSAL_ORDER.indexOf(a.code) - REFUSAL_ORDER.indexOf(b.code));
  const version = applied.length ? applied[applied.length - 1].id : 0;
  const pending = problems.length ? [] : migrations.filter(m => m.id > version);
  return { kind, version, tables, applied, pending, problems };
}

/**
 * 남은 마이그레이션을 적용하기 전에 모두 훑는다: 문장을 읽을 수 없거나 트랜잭션 · PRAGMA 문장이 있으면 그 문제들(하나라도 있으면
 * 아무것도 적용하지 않는다). 중간 판까지 적용하고 멈춰 반쯤 올라간 파일이 되지 않게.
 * @param {Migration[]} pending
 * @returns {StateProblem[]}
 */
export function checkPendingSql(pending) {
  /** @type {StateProblem[]} */
  const problems = [];
  for (const migration of pending) {
    const at = { id: migration.id, name: migration.name };
    let owned;
    try {
      owned = findRunnerOwnedStatements(migration.sql);
    } catch (error) {
      problems.push({ code: 'SQL_SYNTAX', ...at, message: `${migration.name}: ${error instanceof Error ? error.message : String(error)}. ${REFUSAL_MESSAGES.SQL_SYNTAX}` });
      continue;
    }
    if (owned.length) {
      problems.push({
        code: 'RUNNER_OWNED_STATEMENT', ...at,
        message: `${migration.name}: 트랜잭션 · PRAGMA는 실행기가 맡습니다(${owned.map(o => `${o.keyword} ${o.line}번째 줄`).join(', ')}). ${REFUSAL_MESSAGES.RUNNER_OWNED_STATEMENT}`,
      });
    }
  }
  return problems;
}

/** 지금 파일에 적용된 가장 높은 판(적용 기록 표가 없으면 0). BEGIN IMMEDIATE 안에서 다시 읽는다. */
function appliedVersion(/** @type {DatabaseSync} */ db) {
  const hasLedger = !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!hasLedger) return 0;
  return /** @type {{ v: number }} */ (db.prepare('SELECT coalesce(max(id), 0) AS v FROM schema_migrations').get()).v;
}

/**
 * 열린 연결에 남은 마이그레이션을 적용한다(백업 없음). 파일에는 migrate()를 쓰고, 이 함수는 메모리 DB(시험 · 체험판)와 migrate() 안에서 쓴다.
 * 마이그레이션 하나 = 트랜잭션 하나(BEGIN IMMEDIATE). 실패하면 그 마이그레이션만 되돌리고 MigrationError를 던진다(error.applied = 앞에서 커밋한 것).
 * 적용 전에 남은 것을 모두 훑어(checkPendingSql) 문제가 있으면 아무것도 적용하지 않고 던진다. 트랜잭션을 잡은 뒤 그사이 다른 프로세스가
 * 같은 판을 적용했으면(같은 파일을 두 실행기가 동시에 올림) 되돌리고 건너뛴다(실패가 아님).
 * @param {DatabaseSync} db openDatabase()로 연 연결
 * @param {DatabaseKind} kind
 * @param {{ migrations?: Migration[], appVersion?: string, now?: () => Date }} [options]
 * @returns {AppliedMigration[]}
 */
export function applyPending(db, kind, { migrations = loadMigrations(kind), appVersion = PACKAGE_VERSION, now = () => new Date() } = {}) {
  const state = readState(db, kind, migrations);
  if (state.problems.length) {
    throw new MigrationError(state.problems[0].code, state.problems.map(p => p.message).join(' / '), { problems: state.problems });
  }
  return applyMigrations(db, kind, state.pending, { appVersion, now });
}

/**
 * 읽어 둔 남은 마이그레이션(pending)을 차례로 적용한다. 먼저 모두 훑어 문제가 있으면 아무것도 적용하지 않고 던진다.
 * pending은 트랜잭션 밖에서 읽은 것이라, 트랜잭션을 잡은 뒤 그 판이 이미 적용되었으면 건너뛴다.
 * @param {DatabaseSync} db
 * @param {DatabaseKind} kind
 * @param {Migration[]} pending
 * @param {{ appVersion?: string, now?: () => Date }} [options]
 * @returns {AppliedMigration[]}
 */
export function applyMigrations(db, kind, pending, { appVersion = PACKAGE_VERSION, now = () => new Date() } = {}) {
  const sqlProblems = checkPendingSql(pending);
  if (sqlProblems.length) {
    throw new MigrationError(sqlProblems[0].code, sqlProblems.map(p => p.message).join(' / '), { problems: sqlProblems, migration: sqlProblems[0].name, applied: [] });
  }
  /** @type {AppliedMigration[]} */
  const applied = [];
  for (const migration of pending) {
    const started = performance.now();
    let inTransaction = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      // 그사이 다른 프로세스가 이 판을 적용했으면 건너뛴다(읽은 상태는 트랜잭션 밖에서 본 것이다).
      if (appliedVersion(db) >= migration.id) {
        db.exec('ROLLBACK');
        inTransaction = false;
        continue;
      }
      db.exec(migration.sql);
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) {
        throw new MigrationError('FOREIGN_KEY_CHECK', `${migration.name}: 외래 키가 맞지 않는 행 ${violations.length}개`, { migration: migration.name, detail: violations.slice(0, 20) });
      }
      const quick = /** @type {{ quick_check: string }[]} */ (db.prepare('PRAGMA quick_check').all());
      if (quick.length !== 1 || quick[0].quick_check !== 'ok') {
        throw new MigrationError('QUICK_CHECK', `${migration.name}: quick_check 실패`, { migration: migration.name, detail: quick.slice(0, 20) });
      }
      const duration = Math.round(performance.now() - started);
      db.prepare(
        'INSERT INTO schema_migrations (id, name, database_key, checksum, app_version, applied_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(migration.id, migration.name, kind, migration.checksum, appVersion, now().toISOString(), duration);
      db.exec('COMMIT');
      inTransaction = false;
      applied.push({ id: migration.id, name: migration.name, checksum: migration.checksum, duration_ms: duration });
    } catch (error) {
      if (inTransaction) { try { db.exec('ROLLBACK'); } catch { /* 이미 끝난 트랜잭션 */ } }
      if (error instanceof MigrationError) {
        error.applied = applied;
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new MigrationError('MIGRATION_FAILED', `${migration.name}: ${message}`, { migration: migration.name, cause: error, applied });
    }
  }
  return applied;
}

/**
 * 큰 파일도 메모리에 한 번에 올리지 않고 sha256을 잰다.
 * @param {string} file
 */
function sha256File(file) {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * VACUUM INTO로 전체 백업을 만들고 quick_check로 확인한다. 결과는 control `backups` 행에 적을 값이다(적는 일은 부르는 쪽).
 * @param {DatabaseSync} db
 * @param {{ file: string, label: string, version: number, backupDir?: string, now?: () => Date }} options
 * @returns {BackupRecord}
 */
export function backupDatabase(db, { file, label, version, backupDir, now = () => new Date() }) {
  const dir = resolve(backupDir ?? join(dirname(resolve(file)), 'backups'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = now();
  const stamp = at.toISOString().replace(/[-:.]/g, '');
  const base = basename(file).replace(/\.(sqlite3?|db)$/i, '');
  const stem = `${base}.${label}.v${String(version).padStart(4, '0')}.${stamp}`;
  // 이름은 빈 파일을 'wx'(없을 때만 만듦)로 먼저 잡는다: 같은 순간 두 프로세스가 같은 이름을 고르지 않게. VACUUM INTO는 빈 파일에 쓸 수 있다.
  const target = claimFile(dir, stem);
  db.prepare('VACUUM INTO ?').run(target);
  try { chmodSync(target, 0o600); } catch { /* Windows에서는 권한 비트가 없다 */ }
  const check = openDatabase(target, { readOnly: true });
  try {
    const quick = /** @type {{ quick_check: string }[]} */ (check.prepare('PRAGMA quick_check').all());
    if (quick.length !== 1 || quick[0].quick_check !== 'ok') throw new MigrationError('BACKUP_CHECK', `백업 확인 실패: ${target}`);
  } finally {
    check.close();
  }
  return { kind_key: label, path: target, sha256: sha256File(target), bytes: statSync(target).size, version, created_at: at.toISOString() };
}

/**
 * 백업 파일 이름을 잡는다(빈 파일을 원자적으로 만든다). 같은 이름이 있으면 -2, -3 …
 * @param {string} dir @param {string} stem
 */
function claimFile(dir, stem) {
  for (let n = 1; ; n += 1) {
    const target = join(dir, n === 1 ? `${stem}.sqlite` : `${stem}-${n}.sqlite`);
    try {
      closeSync(openSync(target, 'wx', 0o600));
      return target;
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error).code !== 'EEXIST') throw error;
    }
  }
}

/**
 * 그 판의 post_migration 백업이 백업 폴더에 있는지(이름 모양 '<파일>.post_migration.v0002.<시각>.sqlite').
 * @param {string} file @param {number} version @param {string | undefined} backupDir
 */
function hasPostMigrationBackup(file, version, backupDir) {
  const dir = resolve(backupDir ?? join(dirname(resolve(file)), 'backups'));
  if (!existsSync(dir)) return false;
  const base = basename(file).replace(/\.(sqlite3?|db)$/i, '');
  const prefix = `${base}.post_migration.v${String(version).padStart(4, '0')}.`;
  return readdirSync(dir).some(name => name.startsWith(prefix) && name.endsWith('.sqlite') && statSync(join(dir, name)).size > 0);
}

/**
 * @typedef {{
 *   status: 'migrated' | 'up_to_date' | 'refused' | 'failed',
 *   mode: 'read_write' | 'read_only',
 *   db: DatabaseSync,
 *   kind: DatabaseKind,
 *   file: string,
 *   version: number,
 *   applied: AppliedMigration[],
 *   backups: BackupRecord[],
 *   reason?: string,
 *   problems: StateProblem[],
 *   error?: MigrationError,
 *   backupError?: Error,
 * }} MigrateResult
 */

/**
 * 파일 하나에 그 종류의 마이그레이션을 적용한다. 돌려준 db는 부르는 쪽이 닫는다.
 * - 'migrated' · 'up_to_date': 쓰기 연결(mode 'read_write').
 * - 'refused': 모르는 더 새 판 · checksum 다름 · 다른 종류 파일 · 스키노트 파일 아님 · 남은 마이그레이션에 트랜잭션 · PRAGMA 문장
 *   → 아무것도 바꾸지 않고 읽기 전용 연결.
 * - 'failed': 마이그레이션 하나가 실패해 되돌림 → 읽기 전용 연결과 error. 앞에서 커밋한 판은 남고 post_migration 백업을 받는다.
 * - backupError: 적용은 커밋되었지만 post_migration 백업을 받지 못했다. 부르는 쪽은 쓰기 전에 다시 시도하고(backupDatabase),
 *   다시 시작하면 up_to_date 길에서 그 판의 백업을 받는다.
 * 연결 설정(foreign_keys · recursive_triggers · WAL · FULL)이 맞지 않으면 ConnectionSettingsError를 던진다(시작하지 않음).
 * @param {string} file
 * @param {DatabaseKind} kind
 * @param {{
 *   migrations?: Migration[],
 *   migrationsDir?: string,
 *   backupDir?: string,
 *   appVersion?: string,
 *   now?: () => Date,
 *   afterSchema?: (db: DatabaseSync, result: MigrateResult) => void,
 * }} [options]
 * @returns {MigrateResult}
 */
export function migrate(file, kind, options = {}) {
  assertKind(kind);
  if (!file || file === ':memory:') throw new Error('migrate()는 파일에만 씁니다. 메모리 DB는 openDatabase() + applyPending()을 쓰세요.');
  const migrations = options.migrations ?? loadMigrations(kind, options.migrationsDir);
  const now = options.now ?? (() => new Date());
  /**
   * @param {DatabaseSync} readOnlyDb
   * @param {DatabaseState} refusedState
   * @returns {MigrateResult}
   */
  const refuse = (readOnlyDb, refusedState) => ({
    kind, file: resolve(file), problems: refusedState.problems, status: 'refused', mode: 'read_only', db: readOnlyDb,
    version: refusedState.version, applied: [], backups: [], reason: refusedState.problems[0].code,
  });
  // 이미 있는 파일은 먼저 읽기 전용으로 본다. 거절할 파일(더 새 판, 다른 파일)은 쓰기 연결로 열지 않아
  // journal_mode 같은 것도 바꾸지 않는다.
  if (existsSync(file) && statSync(file).size > 0) {
    const readOnlyDb = openDatabase(file, { readOnly: true });
    try {
      const first = readState(readOnlyDb, kind, migrations);
      if (first.problems.length) return refuse(readOnlyDb, first);
    } catch (error) {
      readOnlyDb.close();
      throw error;
    }
    readOnlyDb.close();
  }
  const db = openDatabase(file);
  /** @type {DatabaseState} */
  let state;
  try {
    state = readState(db, kind, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  const base = { kind, file: resolve(file), problems: state.problems };
  if (state.problems.length) {
    db.close();
    return refuse(openDatabase(file, { readOnly: true }), state);
  }
  /** @type {BackupRecord[]} */
  const backups = [];
  if (!state.pending.length) {
    /** @type {MigrateResult} */
    const result = { ...base, status: 'up_to_date', mode: 'read_write', db, version: state.version, applied: [], backups };
    // 지난번에 post_migration 백업을 받지 못하고 멈췄으면(디스크 가득 등) 지금 받는다.
    if (state.version > 0 && state.tables > 0 && !hasPostMigrationBackup(file, state.version, options.backupDir)) {
      try {
        backups.push(backupDatabase(db, { file, label: 'post_migration', version: state.version, backupDir: options.backupDir, now }));
      } catch (error) {
        result.backupError = /** @type {Error} */ (error);
      }
    }
    return runAfterSchema(result, options.afterSchema);
  }
  const sqlProblems = checkPendingSql(state.pending);
  if (sqlProblems.length) {
    db.close();
    return refuse(openDatabase(file, { readOnly: true }), { ...state, problems: sqlProblems });
  }
  try {
    if (state.tables > 0) backups.push(backupDatabase(db, { file, label: 'pre_migration', version: state.version, backupDir: options.backupDir, now }));
  } catch (error) {
    db.close();
    throw error;
  }
  /** @type {AppliedMigration[]} */
  let applied = [];
  /** @type {MigrationError | undefined} */
  let failure;
  try {
    applied = applyPending(db, kind, { migrations, appVersion: options.appVersion ?? PACKAGE_VERSION, now });
  } catch (error) {
    if (!(error instanceof MigrationError)) {
      db.close();
      throw error;
    }
    failure = error;
    applied = error.applied;
  }
  // 그사이 다른 프로세스가 모두 적용했으면(건너뜀) 지금 판은 파일에서 다시 읽는다.
  const version = applied.length ? applied[applied.length - 1].id : readState(db, kind, migrations).version;
  /** @type {Error | undefined} */
  let backupError;
  if (applied.length) {
    try {
      backups.push(backupDatabase(db, { file, label: 'post_migration', version, backupDir: options.backupDir, now }));
    } catch (error) {
      // 적용은 이미 커밋되었다: 멈추지 않고 알린다(다음 시작에서 다시 받는다).
      backupError = /** @type {Error} */ (error);
    }
  }
  if (failure) {
    db.close();
    return {
      ...base, status: 'failed', mode: 'read_only', db: openDatabase(file, { readOnly: true }),
      version, applied, backups, reason: failure.code, error: failure, ...(backupError ? { backupError } : {}),
    };
  }
  /** @type {MigrateResult} */
  const result = {
    ...base, status: applied.length ? 'migrated' : 'up_to_date', mode: 'read_write', db, version, applied, backups,
    ...(backupError ? { backupError } : {}),
  };
  return runAfterSchema(result, options.afterSchema);
}

/**
 * 쓰기로 시작할 때마다 부르는 고리. 고리가 실패하면 연결을 닫고 오류를 그대로 올린다(시작하지 않음).
 * @param {MigrateResult} result
 * @param {((db: DatabaseSync, result: MigrateResult) => void) | undefined} hook
 */
function runAfterSchema(result, hook) {
  if (!hook) return result;
  try {
    hook(result.db, result);
  } catch (error) {
    result.db.close();
    throw error;
  }
  return result;
}

/**
 * 파일을 읽기 전용으로 열어 적용 상태만 본다(바꾸지 않음). 없는 파일은 판 0으로 본다.
 * @param {string} file
 * @param {DatabaseKind} kind
 * @param {{ migrations?: Migration[], migrationsDir?: string }} [options]
 */
export function inspectFile(file, kind, options = {}) {
  assertKind(kind);
  const migrations = options.migrations ?? loadMigrations(kind, options.migrationsDir);
  if (!existsSync(file)) {
    return { kind, version: 0, tables: 0, applied: [], pending: migrations, problems: [], exists: false };
  }
  const db = openDatabase(file, { readOnly: true });
  try {
    return { ...readState(db, kind, migrations), exists: true };
  } finally {
    db.close();
  }
}

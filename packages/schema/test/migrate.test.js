// @ts-check
// 마이그레이션 실행기(data-model 7-3): 연결 설정 확인, 앞으로만 가는 번호, checksum, 모르는 판 · checksum 다름이면 읽기 전용,
// 값이 든 파일은 적용 전 백업, 마이그레이션 하나 = 트랜잭션 하나, 적용 뒤 백업, 명령줄 도구.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ConnectionSettingsError, openDatabase, verifyConnection } from '../src/connection.js';
import { applyMigrations, applyPending, backupDatabase, inspectFile, migrate, readState } from '../src/migrate.js';
import { checksum, loadMigrations, MigrationSetError } from '../src/migrations.js';
import { MIGRATIONS, PACKAGE_DIR, tempDir } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());
let serial = 0;
/** 시험마다 새 폴더. */
const fresh = () => {
  const dir = join(temp.dir, `case-${++serial}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * control 0001 복사본과 덧붙일 마이그레이션이 든 폴더.
 * @param {string} dir @param {Record<string, string>} [extra] 파일 이름 → 내용
 */
function migrationsDir(dir, extra = {}) {
  const out = join(dir, 'migrations');
  mkdirSync(out, { recursive: true });
  copyFileSync(join(MIGRATIONS, '0001_control.sql'), join(out, '0001_control.sql'));
  for (const [name, sql] of Object.entries(extra)) writeFileSync(join(out, name), sql);
  return out;
}

/** @param {DatabaseSync} db @param {string} pragma */
const pragma = (db, pragma) => Object.values(/** @type {object} */ (db.prepare(`PRAGMA ${pragma}`).get()))[0];
/** @param {DatabaseSync} db @param {string} table */
const columns = (db, table) => /** @type {{ name: string }[]} */ (db.prepare(`PRAGMA table_info(${table})`).all()).map(c => c.name);

const LOCALE = { '0002_control_locale.sql': '-- 계정의 화면 언어(예시)\nALTER TABLE accounts ADD COLUMN locale TEXT;\n' };

for (const kind of /** @type {const} */ (['control', 'shop'])) {
  test(`${kind}: a fresh file gets 0001 with WAL, synchronous FULL, foreign keys, recursive triggers and incremental auto_vacuum`, () => {
    const dir = fresh();
    const file = join(dir, `${kind}.sqlite`);
    const result = migrate(file, kind, { appVersion: '0.1.0-test' });
    try {
      assert.equal(result.status, 'migrated');
      assert.equal(result.mode, 'read_write');
      assert.equal(result.version, 1);
      assert.deepEqual(result.applied.map(m => m.name), [`0001_${kind}`]);
      assert.deepEqual(result.backups.map(b => b.kind_key), ['post_migration'], 'no pre_migration backup for an empty file');
      const db = result.db;
      assert.equal(pragma(db, 'journal_mode'), 'wal');
      assert.equal(pragma(db, 'synchronous'), 2);
      assert.equal(pragma(db, 'foreign_keys'), 1);
      assert.equal(pragma(db, 'recursive_triggers'), 1);
      assert.equal(pragma(db, 'busy_timeout'), 5000);
      assert.equal(pragma(db, 'auto_vacuum'), 2, 'INCREMENTAL before the first table');
      const rows = /** @type {any[]} */ (db.prepare('SELECT id, name, database_key, checksum, app_version, applied_at, duration_ms FROM schema_migrations').all());
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 1);
      assert.equal(rows[0].name, `0001_${kind}`);
      assert.equal(rows[0].database_key, kind);
      assert.equal(rows[0].checksum, checksum(readFileSync(join(MIGRATIONS, `0001_${kind}.sql`), 'utf8')));
      assert.equal(rows[0].app_version, '0.1.0-test');
      assert.match(rows[0].applied_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      const backup = result.backups[0];
      assert.ok(existsSync(backup.path));
      assert.match(backup.sha256, /^[0-9a-f]{64}$/);
      assert.equal(backup.version, 1);
    } finally {
      result.db.close();
    }
  });
}

test('INSERT OR REPLACE on a ledger is refused on a runner connection (recursive_triggers is on)', () => {
  const file = join(fresh(), 'control.sqlite');
  const result = migrate(file, 'control');
  try {
    const insert = (/** @type {string} */ verb) => result.db.prepare(`${verb} INTO platform_audit_log (chain_id, seq, id, at, actor_label, category_key, action_key, outcome_key, prev_hash, hash)
      VALUES ('c1', 1, 'a1', '2026-09-23T00:00:00.000Z', 'system', 'backup', 'backup.verified', 'ok', 'h0', 'h1')`).run();
    insert('INSERT');
    assert.throws(() => insert('INSERT OR REPLACE'), /APPEND_ONLY platform_audit_log/);
  } finally {
    result.db.close();
  }
});

test('running again on an up-to-date file changes nothing and takes no backup', () => {
  const dir = fresh();
  const file = join(dir, 'control.sqlite');
  migrate(file, 'control').db.close();
  const before = readdirSync(join(dir, 'backups')).length;
  const again = migrate(file, 'control');
  again.db.close();
  assert.equal(again.status, 'up_to_date');
  assert.equal(again.mode, 'read_write');
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.backups, []);
  assert.equal(readdirSync(join(dir, 'backups')).length, before);
});

test('a new migration on a file with rows is applied after a pre_migration backup and followed by a post_migration backup', () => {
  const dir = fresh();
  const file = join(dir, 'control.sqlite');
  const backupDir = join(dir, 'kept');
  const first = migrate(file, 'control', { migrationsDir: migrationsDir(join(dir, 'v1')), backupDir });
  first.db.prepare("INSERT INTO json_schemas (key, version, json_schema, created_at) VALUES ('licence.claims', 1, '{}', '2026-09-23T00:00:00.000Z')").run();
  first.db.close();

  const result = migrate(file, 'control', { migrationsDir: migrationsDir(join(dir, 'v2'), LOCALE), backupDir });
  try {
    assert.equal(result.status, 'migrated');
    assert.equal(result.version, 2);
    assert.deepEqual(result.applied.map(m => m.name), ['0002_control_locale']);
    assert.deepEqual(result.backups.map(b => `${b.kind_key}@${b.version}`), ['pre_migration@1', 'post_migration@2']);
    assert.ok(columns(result.db, 'accounts').includes('locale'));
    const recorded = /** @type {any[]} */ (result.db.prepare('SELECT name, checksum FROM schema_migrations ORDER BY id').all());
    assert.deepEqual(recorded.map(r => r.name), ['0001_control', '0002_control_locale']);
    assert.equal(recorded[1].checksum, checksum(LOCALE['0002_control_locale.sql']));
  } finally {
    result.db.close();
  }
  const [pre, post] = result.backups;
  const old = new DatabaseSync(pre.path, { readOnly: true });
  try {
    assert.ok(!columns(old, 'accounts').includes('locale'), 'the pre_migration backup has the old schema');
    assert.equal(/** @type {any} */ (old.prepare('SELECT count(*) AS n FROM json_schemas').get()).n, 1, 'and the rows');
    assert.equal(/** @type {any} */ (old.prepare('SELECT max(id) AS v FROM schema_migrations').get()).v, 1);
  } finally {
    old.close();
  }
  const fresher = new DatabaseSync(post.path, { readOnly: true });
  try {
    assert.ok(columns(fresher, 'accounts').includes('locale'), 'the post_migration backup has the new schema');
  } finally {
    fresher.close();
  }
  assert.ok(pre.path.startsWith(backupDir) && post.path.startsWith(backupDir));
});

test('an unknown newer migration: nothing is applied and the file opens read-only', () => {
  const dir = fresh();
  const file = join(dir, 'control.sqlite');
  migrate(file, 'control', { migrationsDir: migrationsDir(join(dir, 'new'), LOCALE) }).db.close();
  const backups = readdirSync(join(dir, 'backups')).length;

  const result = migrate(file, 'control', { migrationsDir: migrationsDir(join(dir, 'old')) });
  try {
    assert.equal(result.status, 'refused');
    assert.equal(result.mode, 'read_only');
    assert.equal(result.reason, 'UNKNOWN_MIGRATION');
    assert.match(result.problems[0].message, /앱을 업데이트해 주세요/);
    assert.equal(result.version, 2);
    assert.equal(/** @type {any} */ (result.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).n, 2, 'reads still work');
    assert.throws(() => result.db.exec("INSERT INTO json_schemas (key, version, json_schema, created_at) VALUES ('x', 1, '{}', 'x')"), /readonly/);
    assert.equal(pragma(result.db, 'foreign_keys'), 1);
    assert.equal(pragma(result.db, 'recursive_triggers'), 1);
  } finally {
    result.db.close();
  }
  assert.equal(readdirSync(join(dir, 'backups')).length, backups, 'no backup for a refused file');
  assert.equal(inspectFile(file, 'control', { migrationsDir: join(dir, 'old', 'migrations') }).problems[0].code, 'UNKNOWN_MIGRATION');
});

test('a shipped migration whose content changed (checksum mismatch) is refused and the file opens read-only', () => {
  const dir = fresh();
  const file = join(dir, 'control.sqlite');
  migrate(file, 'control', { migrationsDir: migrationsDir(join(dir, 'a')) }).db.close();
  const edited = migrationsDir(join(dir, 'b'));
  writeFileSync(join(edited, '0001_control.sql'), readFileSync(join(edited, '0001_control.sql'), 'utf8') + '\n-- 손으로 고친 줄\n');
  const result = migrate(file, 'control', { migrationsDir: edited });
  try {
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'CHECKSUM_MISMATCH');
    assert.equal(result.mode, 'read_only');
    assert.throws(() => result.db.exec('CREATE TABLE x (a)'), /readonly/);
  } finally {
    result.db.close();
  }
});

test('the same migration saved with CRLF line ends and a BOM keeps its checksum', () => {
  const text = readFileSync(join(MIGRATIONS, '0001_control.sql'), 'utf8');
  assert.equal(checksum('\uFEFF' + text.replace(/\n/g, '\r\n')), checksum(text));
  const dir = fresh();
  const file = join(dir, 'control.sqlite');
  migrate(file, 'control').db.close();
  const windows = migrationsDir(join(dir, 'win'));
  writeFileSync(join(windows, '0001_control.sql'), '\uFEFF' + text.replace(/\n/g, '\r\n'));
  const result = migrate(file, 'control', { migrationsDir: windows });
  result.db.close();
  assert.equal(result.status, 'up_to_date');
});

test('a failing migration is rolled back, earlier ones stay, and the file opens read-only', () => {
  const dir = fresh();
  const file = join(dir, 'control.sqlite');
  const migrations = migrationsDir(dir, {
    ...LOCALE,
    '0003_control_broken.sql': 'ALTER TABLE accounts ADD COLUMN nickname TEXT;\nINSERT INTO no_such_table VALUES (1);\n',
  });
  const result = migrate(file, 'control', { migrationsDir: migrations });
  try {
    assert.equal(result.status, 'failed');
    assert.equal(result.mode, 'read_only');
    assert.equal(result.error?.code, 'MIGRATION_FAILED');
    assert.equal(result.error?.migration, '0003_control_broken');
    assert.equal(result.version, 2);
    assert.deepEqual(result.applied.map(m => m.name), ['0001_control', '0002_control_locale']);
    const cols = columns(result.db, 'accounts');
    assert.ok(cols.includes('locale'));
    assert.ok(!cols.includes('nickname'), 'the half-applied 0003 was rolled back');
    assert.equal(/** @type {any} */ (result.db.prepare('SELECT max(id) AS v FROM schema_migrations').get()).v, 2);
    assert.deepEqual(result.backups.map(b => `${b.kind_key}@${b.version}`), ['post_migration@2']);
  } finally {
    result.db.close();
  }
});

test('a migration file with transaction control or a PRAGMA is refused before anything runs (no backup, nothing applied)', () => {
  const dir = fresh();
  const file = join(dir, 'control.sqlite');
  migrate(file, 'control', { migrationsDir: migrationsDir(join(dir, 'a')) }).db.close();
  const backups = readdirSync(join(dir, 'backups')).length;
  for (const sql of ['PRAGMA foreign_keys = OFF;\n', "COMMIT;\nINSERT INTO sys_features (key, label, description, default_enabled, depends_on_json, added_in) VALUES ('x', 'x', 'x', 0, '[]', 2);\n"]) {
    const result = migrate(file, 'control', { migrationsDir: migrationsDir(join(dir, `b${sql.length}`), { '0002_control_bad.sql': sql }) });
    result.db.close();
    assert.equal(result.status, 'refused');
    assert.equal(result.mode, 'read_only');
    assert.equal(result.reason, 'RUNNER_OWNED_STATEMENT');
    assert.equal(result.version, 1);
  }
  assert.equal(readdirSync(join(dir, 'backups')).length, backups, 'no pre_migration backup for a refused set');
});

test('a bad later migration refuses the whole set: an earlier good one is not applied either (no half-upgraded file)', () => {
  const dir = fresh();
  const file = join(dir, 'control.sqlite');
  migrate(file, 'control', { migrationsDir: migrationsDir(join(dir, 'a')) }).db.close();
  const result = migrate(file, 'control', { migrationsDir: migrationsDir(join(dir, 'b'), { ...LOCALE, '0003_control_pragma.sql': 'PRAGMA foreign_keys = OFF;\n' }) });
  try {
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'RUNNER_OWNED_STATEMENT');
    assert.equal(result.version, 1);
    assert.ok(!columns(result.db, 'accounts').includes('locale'), '0002 was not applied');
  } finally {
    result.db.close();
  }
  // applyPending(메모리 DB · 체험판)도 같은 규칙으로 던지고 아무것도 적용하지 않는다.
  const db = openDatabase(':memory:');
  try {
    const migrations = loadMigrations('control', migrationsDir(join(dir, 'c'), { ...LOCALE, '0003_control_pragma.sql': 'PRAGMA foreign_keys = OFF;\n' }));
    assert.throws(() => applyPending(db, 'control', { migrations }), (error) => /** @type {any} */ (error).code === 'RUNNER_OWNED_STATEMENT' && /** @type {any} */ (error).applied.length === 0);
    assert.equal(/** @type {any} */ (db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'schema_migrations'").get()).n, 0);
  } finally {
    db.close();
  }
});

test('a deferred foreign key left broken by a migration fails FOREIGN_KEY_CHECK: rolled back, version stays, file opens read-only', () => {
  const dir = fresh();
  const file = join(dir, 'control.sqlite');
  migrate(file, 'control', { migrationsDir: migrationsDir(join(dir, 'a')) }).db.close();
  const broken = {
    '0002_control_deferred.sql': 'CREATE TABLE sys_parents (key TEXT NOT NULL PRIMARY KEY, added_in INTEGER NOT NULL) STRICT;\n'
      + 'CREATE TABLE sys_children (key TEXT NOT NULL PRIMARY KEY, parent_key TEXT NOT NULL REFERENCES sys_parents (key) DEFERRABLE INITIALLY DEFERRED, added_in INTEGER NOT NULL) STRICT;\n'
      + "INSERT INTO sys_children (key, parent_key, added_in) VALUES ('orphan', 'missing', 2);\n",
  };
  const result = migrate(file, 'control', { migrationsDir: migrationsDir(join(dir, 'b'), broken) });
  try {
    assert.equal(result.status, 'failed');
    assert.equal(result.mode, 'read_only');
    assert.equal(result.error?.code, 'FOREIGN_KEY_CHECK');
    assert.equal(result.error?.migration, '0002_control_deferred');
    assert.equal(result.version, 1);
    assert.deepEqual(result.applied, []);
    assert.ok(Array.isArray(result.error?.detail) && result.error.detail.length === 1, 'the violating row is listed');
    assert.equal(/** @type {any} */ (result.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'sys_children'").get()).n, 0, 'rolled back');
    assert.throws(() => result.db.exec('CREATE TABLE x (a)'), /readonly/);
  } finally {
    result.db.close();
  }
});

test('two runners on one file: a migration applied by the other process in between is skipped, not failed', () => {
  const dir = fresh();
  const file = join(dir, 'control.sqlite');
  migrate(file, 'control', { migrationsDir: migrationsDir(join(dir, 'a')) }).db.close();
  const migrations = loadMigrations('control', migrationsDir(join(dir, 'b'), LOCALE));
  const late = openDatabase(file);
  const early = openDatabase(file);
  try {
    // 늦은 쪽이 먼저 상태를 읽었다(0002가 남음) → 이른 쪽이 0002를 적용 → 늦은 쪽이 트랜잭션을 잡고 다시 보면 이미 됨.
    const pending = readState(late, 'control', migrations).pending;
    assert.deepEqual(pending.map(m => m.name), ['0002_control_locale']);
    assert.deepEqual(applyPending(early, 'control', { migrations }).map(m => m.name), ['0002_control_locale']);
    assert.deepEqual(applyMigrations(late, 'control', pending), []);
    assert.equal(/** @type {any} */ (late.prepare('SELECT count(*) AS n FROM schema_migrations').get()).n, 2);
  } finally {
    late.close();
    early.close();
  }
  // 백업 이름은 원자적으로 잡는다: 같은 순간 두 번 받아도 다른 파일.
  const db = openDatabase(file);
  try {
    const at = () => new Date('2026-12-26T06:40:00.000Z');
    const one = backupDatabase(db, { file, label: 'pre_migration', version: 2, now: at });
    const two = backupDatabase(db, { file, label: 'pre_migration', version: 2, now: at });
    assert.notEqual(one.path, two.path);
    assert.match(two.path, /-2\.sqlite$/);
  } finally {
    db.close();
  }
});

test('a second process opening a file another process is writing waits (busy_timeout first) instead of failing', async () => {
  const dir = fresh();
  const file = join(dir, 'busy.sqlite');
  const seed = new DatabaseSync(file);
  seed.exec('CREATE TABLE t (a INTEGER)');
  seed.close();
  // 다른 프로세스가 배타 잠금을 0.8초 쥐고 있다가 푼다.
  const holder = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec('BEGIN EXCLUSIVE'); db.exec('INSERT INTO t VALUES (1)');
    process.stdout.write('locked\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    db.exec('COMMIT'); db.close();
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const started = Date.now();
  const db = openDatabase(file);
  try {
    assert.ok(Date.now() - started >= 200, 'it waited for the lock');
    assert.equal(pragma(db, 'journal_mode'), 'wal');
  } finally {
    db.close();
  }
  await new Promise((resolve) => holder.on('exit', resolve));
});

test('when the post_migration backup fails, the migration stays committed, backupError is returned, and the next start takes it', () => {
  const dir = fresh();
  const file = join(dir, 'control.sqlite');
  const notADir = join(dir, 'not-a-dir');
  writeFileSync(notADir, 'x');
  const first = migrate(file, 'control', { backupDir: notADir });
  try {
    assert.equal(first.status, 'migrated');
    assert.equal(first.mode, 'read_write');
    assert.equal(first.version, 1);
    assert.ok(first.backupError, 'the failure is reported, not thrown');
    assert.deepEqual(first.backups, []);
  } finally {
    first.db.close();
  }
  const good = join(dir, 'kept');
  const again = migrate(file, 'control', { backupDir: good });
  try {
    assert.equal(again.status, 'up_to_date');
    assert.deepEqual(again.backups.map(b => `${b.kind_key}@${b.version}`), ['post_migration@1']);
  } finally {
    again.db.close();
  }
  const third = migrate(file, 'control', { backupDir: good });
  third.db.close();
  assert.deepEqual(third.backups, [], 'only once per version');
});

test('a file of the other kind, or a SQLite file that is not Skinote, is refused and left as it was', () => {
  const dir = fresh();
  const control = join(dir, 'control.sqlite');
  migrate(control, 'control').db.close();
  const wrong = migrate(control, 'shop');
  wrong.db.close();
  assert.equal(wrong.status, 'refused');
  assert.equal(wrong.reason, 'WRONG_DATABASE');

  const foreign = join(dir, 'returns.sqlite');
  const raw = new DatabaseSync(foreign);
  raw.exec("CREATE TABLE workflow_state (shop_id TEXT PRIMARY KEY, state_json TEXT); INSERT INTO workflow_state VALUES ('shop1', '{}');");
  raw.close();
  const result = migrate(foreign, 'shop');
  result.db.close();
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'FOREIGN_FILE');
  const check = new DatabaseSync(foreign, { readOnly: true });
  try {
    assert.equal(pragma(check, 'journal_mode'), 'delete', 'the foreign file was not switched to WAL');
    assert.deepEqual(/** @type {any[]} */ (check.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).map(r => r.name), ['workflow_state']);
  } finally {
    check.close();
  }
});

test('every connection is verified: foreign_keys or recursive_triggers off, or a file not in WAL, is refused', () => {
  const memory = openDatabase(':memory:');
  assert.equal(verifyConnection(memory).recursive_triggers, 1);
  memory.exec('PRAGMA recursive_triggers = OFF');
  assert.throws(() => verifyConnection(memory), e => e instanceof ConnectionSettingsError && /recursive_triggers=0/.test(e.message));
  memory.exec('PRAGMA recursive_triggers = ON; PRAGMA foreign_keys = OFF');
  assert.throws(() => verifyConnection(memory), /foreign_keys=0/);
  memory.close();

  const file = join(fresh(), 'plain.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; CREATE TABLE t (a)');
  assert.throws(() => verifyConnection(raw), /journal_mode=delete/);
  raw.exec('PRAGMA synchronous = NORMAL; PRAGMA journal_mode = WAL');
  assert.throws(() => verifyConnection(raw), /synchronous=1/);
  raw.close();
});

test('the afterSchema hook (place for ui_defaults.apply) runs on every writable start, never on a refused file', () => {
  const dir = fresh();
  const file = join(dir, 'control.sqlite');
  /** @type {string[]} */
  const seen = [];
  const afterSchema = (/** @type {DatabaseSync} */ db, /** @type {{ status: string }} */ result) => {
    seen.push(result.status);
    db.prepare('SELECT 1').get();
  };
  migrate(file, 'control', { afterSchema }).db.close();
  migrate(file, 'control', { afterSchema }).db.close();
  migrate(file, 'shop', { afterSchema }).db.close();
  assert.deepEqual(seen, ['migrated', 'up_to_date']);
});

test('migration numbering is forward-only: a gap, a duplicate or a misnamed file stops the runner', () => {
  const gap = migrationsDir(fresh(), { '0003_control_late.sql': 'SELECT 1;' });
  assert.throws(() => loadMigrations('control', gap), e => e instanceof MigrationSetError && /0002_control/.test(e.message));
  const twice = migrationsDir(fresh(), { '0001_control_again.sql': 'SELECT 1;' });
  assert.throws(() => loadMigrations('control', twice), MigrationSetError);
  const misnamed = migrationsDir(fresh(), { '2_control.sql': 'SELECT 1;' });
  assert.throws(() => loadMigrations('control', misnamed), /이름 모양이 틀린 파일/);
  assert.deepEqual(loadMigrations('shop').map(m => m.name), ['0001_shop']);
  assert.deepEqual(loadMigrations('control').map(m => m.name), ['0001_control']);
});

test('inspectFile reports a missing file as version 0 without creating it', () => {
  const file = join(fresh(), 'none.sqlite');
  const state = inspectFile(file, 'shop');
  assert.equal(state.exists, false);
  assert.equal(state.version, 0);
  assert.deepEqual(state.pending.map(m => m.name), ['0001_shop']);
  assert.equal(existsSync(file), false);
});

test('the command line tool migrates, reports up to date, refuses the wrong kind and explains usage', () => {
  const dir = fresh();
  const file = join(dir, 'control.sqlite');
  const cli = (/** @type {string[]} */ ...args) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(PACKAGE_DIR, 'bin', 'migrate.js'), ...args], { encoding: 'utf8' });

  const first = cli('control', file, '--backup-dir', join(dir, 'b'));
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /적용: 0001_control/);
  assert.match(first.stdout, /끝: 지금 판 1/);

  const second = cli('control', file);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /이미 최신입니다\(판 1\)/);

  const wrong = cli('shop', file);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stdout, /거절\(WRONG_DATABASE\)/);

  const status = cli('control', file, '--status', '--json');
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).pending, []);

  const usage = cli('stock', file);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /사용법/);
});

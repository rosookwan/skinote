#!/usr/bin/env node
// @ts-check
// 마이그레이션 실행 명령.
//   node packages/schema/bin/migrate.js <control|shop> <파일> [--backup-dir <폴더>] [--app-version <판>] [--status] [--json]
// 끝 코드: 0 = 적용함 · 이미 최신(또는 --status로 문제 없음), 2 = 적용을 거절하고 읽기 전용(모르는 더 새 판, checksum 다름 …),
// 1 = 적용 실패(되돌림) · 연결 설정 오류 · 잘못 부름 · 서버가 매장 파일을 쓰는 중.
// 서버 자료 폴더의 매장 파일(<자료 폴더>/db/shops/<매장 id>.sqlite)이면 서버 · 명령줄과 같은 쓰는 사람 잠금
// (<자료 폴더>/locks/<매장 id>.writer, 저장소 lock.ts와 같은 방법)을 먼저 잡는다: 서버가 도는 동안 표를 바꾸지 않게(D4).

import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { openDatabase } from '../src/connection.js';
import { inspectFile, migrate } from '../src/migrate.js';

const USAGE = '사용법: migrate <control|shop> <파일> [--backup-dir <폴더>] [--app-version <판>] [--status] [--json]';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ positional: string[], backupDir?: string, appVersion?: string, status: boolean, json: boolean }} */
  const out = { positional: [], status: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--status') out.status = true;
    else if (a === '--json') out.json = true;
    else if (a === '--backup-dir' || a === '--app-version') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${a} 다음에 값이 필요합니다`);
      if (a === '--backup-dir') out.backupDir = value;
      else out.appVersion = value;
      i += 1;
    } else if (a.startsWith('--')) throw new Error(`모르는 선택: ${a}`);
    else out.positional.push(a);
  }
  return out;
}

/** npm run migrate -w @skinote/schema로 부르면 npm이 패키지 폴더에서 돌리므로, 상대 경로는 부른 곳(INIT_CWD) 기준으로 푼다. */
function baseDir() {
  return process.env.npm_lifecycle_event === 'migrate' && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd();
}

/** @param {string} p */
const fromBase = p => (isAbsolute(p) ? p : resolve(baseDir(), p));

/**
 * 매장 파일이면 쓰는 사람 잠금을 잡는다(쥔 프로세스가 있으면 null, 매장 파일이 아니면 풀 것 없는 잠금).
 * @param {'control' | 'shop'} kind @param {string} file
 * @returns {{ release(): void } | null}
 */
function writerLock(kind, file) {
  const none = { release() {} };
  if (kind !== 'shop' || basename(dirname(file)) !== 'shops' || basename(dirname(dirname(file))) !== 'db') return none;
  const shopId = basename(file).replace(/\.sqlite$/, '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(shopId)) return none;
  const dir = join(dirname(dirname(dirname(file))), 'locks');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o750 });
  const busy = (/** @type {unknown} */ e) => /SQLITE_BUSY|database is locked/i.test(String(/** @type {{ message?: unknown }} */ (e)?.message ?? e));
  let db;
  try {
    db = openDatabase(join(dir, shopId + '.writer'));
    db.exec('CREATE TABLE IF NOT EXISTS writer_lock (shop_id TEXT NOT NULL PRIMARY KEY) STRICT');
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    db?.close();
    if (busy(error)) return null;
    throw error;
  }
  const held = db;
  return { release() { try { held.exec('ROLLBACK'); } finally { held.close(); } } };
}

/** @param {string[]} argv */
function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`${/** @type {Error} */ (error).message}\n${USAGE}`);
    return 1;
  }
  const [kind, fileArg] = args.positional;
  if ((kind !== 'control' && kind !== 'shop') || !fileArg || args.positional.length !== 2) {
    console.error(USAGE);
    return 1;
  }
  const file = fromBase(fileArg);

  if (args.status) {
    const state = inspectFile(file, kind);
    if (args.json) {
      console.log(JSON.stringify({ kind, file, exists: state.exists, version: state.version, pending: state.pending.map(m => m.name), problems: state.problems }, null, 2));
    } else {
      console.log(`${kind} ${file}`);
      console.log(state.exists ? `  지금 판: ${state.version}` : '  파일이 아직 없습니다(판 0)');
      console.log(`  남은 마이그레이션: ${state.pending.map(m => m.name).join(', ') || '없음'}`);
      for (const p of state.problems) console.log(`  문제(${p.code}): ${p.message}`);
    }
    return state.problems.length ? 2 : 0;
  }

  const lock = writerLock(kind, file);
  if (!lock) {
    console.error('서버(또는 명령줄)가 이 매장 파일을 쓰는 중입니다: 서버를 멈춘 뒤 다시 합니다(sudo systemctl stop skinote-server)');
    return 1;
  }
  let result;
  try {
    result = migrate(file, kind, {
      backupDir: args.backupDir ? fromBase(args.backupDir) : undefined,
      appVersion: args.appVersion,
    });
    result.db.close();
  } finally {
    lock.release();
  }
  if (args.json) {
    const { db, error, ...rest } = result;
    console.log(JSON.stringify({ ...rest, error: error ? { code: error.code, message: error.message } : undefined }, null, 2));
  } else {
    console.log(`${kind} ${result.file}`);
    for (const b of result.backups.filter(x => x.kind_key === 'pre_migration')) console.log(`  적용 전 백업: ${b.path}`);
    for (const m of result.applied) console.log(`  적용: ${m.name} (${m.duration_ms} ms)`);
    for (const b of result.backups.filter(x => x.kind_key === 'post_migration')) console.log(`  적용 뒤 백업: ${b.path}`);
    if (result.status === 'migrated') console.log(`  끝: 지금 판 ${result.version}`);
    if (result.status === 'up_to_date') console.log(`  이미 최신입니다(판 ${result.version}).`);
    if (result.status === 'refused') {
      for (const p of result.problems) console.log(`  거절(${p.code}): ${p.message}`);
      console.log(`  아무것도 바꾸지 않았습니다. 이 파일은 읽기 전용으로만 열립니다(판 ${result.version}).`);
    }
    if (result.status === 'failed' && result.error) {
      console.log(`  실패(${result.error.code}): ${result.error.message}`);
      console.log(`  그 마이그레이션은 되돌렸습니다. 지금 판 ${result.version}, 읽기 전용으로만 열립니다.`);
    }
  }
  if (result.status === 'refused') return 2;
  if (result.status === 'failed') return 1;
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  const e = /** @type {Error & { code?: string }} */ (error);
  console.error(`오류${e.code ? `(${e.code})` : ''}: ${e.message}`);
  process.exitCode = 1;
}

// @ts-check
// 백업 파일(VACUUM INTO 사본)의 이름 읽기와 확인.
//
// 실행기(@skinote/schema backupDatabase)는 사본을 마지막 이름으로 바로 쓰고, '그 판의 post_migration 백업이 있는가'를
// 크기 > 0으로만 본다. 그래서 VACUUM INTO 도중에 프로세스가 죽으면(systemctl stop · 배포의 되돌리기 · 메모리 부족) 잘린
// 사본이 남고, 다음 시작은 그 사본을 믿고 쓰기를 연다. 이 모듈은 쓰기를 열기 전에 그 판의 가장 새 사본을 확인한다:
//   1) 옆에 -journal · -wal이 없다(끝나지 않은 VACUUM INTO의 흔적)
//   2) 머리(100바이트): 'SQLite format 3', 쪽 크기, 파일 크기가 쪽 크기의 배수이고 머리의 쪽 수 × 쪽 크기와 같다
//   3) 읽기 전용으로 열어 quick_check
// 통과한 사본 옆에 '<이름>.verified'(크기 · 고친 시각)를 남겨 다음 시작에는 3)을 건너뛴다(큰 파일 · 많은 매장에서 시작이 느려지지 않게).
// 실행기가 스스로 확인한(quick_check를 통과해 돌려준) 사본에도 곧바로 남긴다.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { backupDatabase, openDatabase } from '@skinote/schema';
import { errorCode, messageOf } from './errors.js';

/**
 * @typedef {import('node:sqlite').DatabaseSync} DatabaseSync
 * @typedef {{ name: string, base: string, label: string, version: number, stamp: string, n: number }} BackupName
 * @typedef {{ ok: true } | { ok: false, reason: string }} FileCheck
 */

/** '<파일>.<label>.v<판 4자리 이상>.<UTC 시각 20260924T190000000Z>[-<n>].sqlite' */
const NAME_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.([a-z_]+)\.v(\d{4,})\.(\d{8}T\d{9}Z)(?:-(\d+))?\.sqlite$/;
export const VERIFIED_SUFFIX = '.verified';
export const BROKEN_SUFFIX = '.broken';

/** 백업 파일 이름을 읽는다(모양이 다르면 null). @param {string} name @returns {BackupName | null} */
export function parseBackupName(name) {
  const m = NAME_PATTERN.exec(name);
  if (!m) return null;
  return { name, base: m[1], label: m[2], version: Number(m[3]), stamp: m[4], n: m[5] ? Number(m[5]) : 1 };
}

/** 오래된 것 먼저(시각, 같은 시각이면 -2 · -3 …). @param {BackupName} a @param {BackupName} b */
export function compareBackupNames(a, b) {
  if (a.stamp !== b.stamp) return a.stamp < b.stamp ? -1 : 1;
  return a.n - b.n;
}

/** 데이터베이스 파일 경로 → 백업 이름의 앞부분('shops/abc.sqlite' → 'abc'). @param {string} file */
export function backupBaseOf(file) {
  return basename(file).replace(/\.(sqlite3?|db)$/i, '');
}

/** @param {string} path @param {number} length */
function readHead(path, length) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * 파일 머리와 크기만 보는 빠른 확인(파일 전체를 읽지 않는다).
 * @param {string} path
 * @returns {FileCheck}
 */
export function checkBackupHeader(path) {
  if (!existsSync(path)) return { ok: false, reason: 'MISSING' };
  for (const suffix of ['-journal', '-wal']) {
    if (existsSync(path + suffix)) return { ok: false, reason: 'HOT_JOURNAL' };
  }
  const size = statSync(path).size;
  if (size === 0) return { ok: false, reason: 'EMPTY' };
  if (size < 100) return { ok: false, reason: 'TRUNCATED' };
  const head = readHead(path, 100);
  if (head.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') return { ok: false, reason: 'NOT_SQLITE' };
  const raw = head.readUInt16BE(16);
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return { ok: false, reason: 'BAD_HEADER' };
  if (size % pageSize !== 0) return { ok: false, reason: 'TRUNCATED' };
  const changeCounter = head.readUInt32BE(24);
  const pageCount = head.readUInt32BE(28);
  const validFor = head.readUInt32BE(92);
  if (validFor === changeCounter && pageCount > 0 && pageCount * pageSize !== size) return { ok: false, reason: 'TRUNCATED' };
  return { ok: true };
}

/**
 * 머리 확인 + 읽기 전용으로 열어 quick_check.
 * @param {string} path
 * @returns {FileCheck}
 */
export function checkBackupFile(path) {
  const head = checkBackupHeader(path);
  if (!head.ok) return head;
  let db;
  try {
    db = openDatabase(path, { readOnly: true });
    const rows = db.prepare('PRAGMA quick_check').all();
    const values = rows.map(row => Object.values(row)[0]);
    return values.length === 1 && values[0] === 'ok' ? { ok: true } : { ok: false, reason: 'QUICK_CHECK' };
  } catch (error) {
    return { ok: false, reason: errorCode(error, 'OPEN_FAILED') };
  } finally {
    try { db?.close(); } catch { /* 이미 닫힘 */ }
  }
}

/** 확인 표시가 지금 파일(크기 · 고친 시각)과 맞는지. @param {string} path */
export function isVerified(path) {
  try {
    const marker = JSON.parse(readFileSync(path + VERIFIED_SUFFIX, 'utf8'));
    const stat = statSync(path);
    return marker?.bytes === stat.size && marker?.mtimeMs === stat.mtimeMs;
  } catch {
    return false;
  }
}

/** 확인한 파일 옆에 표시를 남긴다(실패해도 다음 시작에 다시 확인할 뿐이다). @param {string} path @param {Date} at */
export function markVerified(path, at) {
  try {
    const stat = statSync(path);
    writeFileSync(path + VERIFIED_SUFFIX, JSON.stringify({ bytes: stat.size, mtimeMs: stat.mtimeMs, checkedAt: at.toISOString() }) + '\n', { mode: 0o600 });
  } catch {
    /* 표시는 빨리 가기 위한 것일 뿐 */
  }
}

/** 망가진 사본을 옆으로 치운다(빈 파일은 지운다). 확인 표시와 남은 -journal도 함께. @param {string} path */
function setAside(path) {
  try {
    if (statSync(path).size === 0) unlinkSync(path);
    else renameSync(path, path + BROKEN_SUFFIX);
  } catch { /* 이미 없음 */ }
  for (const suffix of ['-journal', '-wal', '-shm']) {
    if (existsSync(path + suffix)) {
      try { renameSync(path + suffix, path + suffix + BROKEN_SUFFIX); } catch { /* 그대로 둠 */ }
    }
  }
  try { unlinkSync(path + VERIFIED_SUFFIX); } catch { /* 없음 */ }
}

/**
 * 그 판의 post_migration 사본을 쓰기 전에 확인한다. 가장 새 사본이 망가졌으면 옆으로 치우고(<이름>.broken) 지금 연결에서
 * 새로 받는다. 새로 받지 못하면 ok = false(부르는 쪽이 쓰기를 막는다).
 * @param {DatabaseSync} db 쓰기 연결
 * @param {{ file: string, version: number, backupDir: string, now: () => Date, log: (line: string) => void, label: string }} options
 * @returns {{ ok: boolean, path: string | null, retaken: boolean, broken: string[], reason: string | null }}
 */
export function ensurePostMigrationBackup(db, { file, version, backupDir, now, log, label }) {
  const base = backupBaseOf(file);
  /** @type {string[]} */
  const broken = [];
  const copies = () => (existsSync(backupDir) ? readdirSync(backupDir) : [])
    .map(parseBackupName)
    .filter(n => !!n && n.base === base && n.label === 'post_migration' && n.version === version)
    .map(n => /** @type {BackupName} */ (n))
    .sort(compareBackupNames);
  const names = copies();
  const newest = names.at(-1);
  if (newest) {
    const path = join(backupDir, newest.name);
    // 머리 · 크기 · -journal은 늘 본다(싸다). 파일 전체를 읽는 quick_check만 표시가 맞으면 건너뛴다.
    const head = checkBackupHeader(path);
    if (head.ok && isVerified(path)) return { ok: true, path, retaken: false, broken, reason: null };
    const check = head.ok ? checkBackupFile(path) : head;
    if (check.ok) {
      markVerified(path, now());
      return { ok: true, path, retaken: false, broken, reason: null };
    }
    broken.push(newest.name);
    log(`${label}: 적용 뒤 백업 ${newest.name}이(가) 망가짐(${check.reason}) → ${BROKEN_SUFFIX}로 치우고 다시 받음`);
    setAside(path);
  }
  const before = new Set(copies().map(n => n.name));
  try {
    const record = backupDatabase(db, { file, label: 'post_migration', version, backupDir, now });
    markVerified(record.path, now());
    log(`${label}: 적용 뒤 백업 다시 받음 ${basename(record.path)}`);
    return { ok: true, path: record.path, retaken: true, broken, reason: null };
  } catch (error) {
    // 실행기가 잡아 둔 빈 이름이나 반쯤 쓴 사본을 남기지 않는다(다음 시작이 그것을 믿지 않게).
    for (const n of copies()) if (!before.has(n.name)) setAside(join(backupDir, n.name));
    log(`${label}: 적용 뒤 백업 실패, 쓰기 막음: ${messageOf(error)}`);
    return { ok: false, path: null, retaken: false, broken, reason: errorCode(error, 'BACKUP_FAILED') };
  }
}

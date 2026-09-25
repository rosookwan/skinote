// @ts-check
// 날마다 백업(deployment 6-1의 '날마다 스냅샷'의 첫 판, 서버 안에만). 모든 데이터베이스 파일을 읽기 전용으로 열어
// VACUUM INTO로 한 순간의 사본을 만들고(쓰는 서버를 막지 않음, WAL), quick_check와 sha256을 적는다.
// 실제 복사 · 확인은 마이그레이션 실행기의 backupDatabase()를 그대로 쓴다.
//
//   <자료 폴더>/backups/<YYYY-MM-DD>/<control|매장 id>.daily.v<판>.<UTC 시각>.sqlite
//                                   /SHA256SUMS      (sha256sum -c로 확인. 되살릴 때는 여기에 적힌 파일만 쓴다)
//                                   /manifest.json   (돌린 때마다 한 줄: 영업일 · 파일 · 판 · 크기 · sha256 · 결과)
//
// 날짜 폴더는 설정 시간대(SKINOTE_TZ)의 달력 날짜다. 새벽 04:00에 돌므로 폴더 D에는 영업일 D-1의 마감 뒤 모습이 든다
// (manifest의 businessDate가 그 영업일이다).
//
// 사본은 먼저 날짜 폴더 안의 '.partial-*' 폴더에 만들고, quick_check와 sha256이 끝난 뒤에만 날짜 폴더로 옮긴다: 도중에 죽어도
// 반쪽 사본이 온전한 사본처럼 보이지 않는다. 다음 실행은 남은 '.partial-*'와 SHA256SUMS에 없는 사본을 지운다.
//
// 여러 앱이 나눠 쓰는 디스크를 채우지 않게:
//   - 쓰기 전에 여유를 본다: (원본 합계 × 2 + 남길 여유 SKINOTE_BACKUP_RESERVE_MB)보다 적으면 먼저 오래된 폴더를 지워 보고,
//     그래도 모자라면 아무것도 쓰지 않고 NO_SPACE로 실패한다(파일마다 쓰기 직전에도 다시 본다).
//   - 오래된 날짜 폴더 지우기는 결과와 상관없이 늘 한다: 가장 새 N개(기본 14)와 오늘, 그리고 파일마다 온전한 사본이 든
//     가장 새 폴더(그 파일이 요즘 계속 실패해도 마지막 사본은 남는다)를 남긴다.
//   - 같은 날 여러 번 돌려도(손으로, 놓친 실행) 파일마다 가장 새 3개만 남긴다.
//   - migrations/(실행기의 적용 전 · 뒤 사본)는 파일 · 종류마다 가장 새 판 2개, 판마다 가장 새 3개만 남긴다.
//   - 실행마다 backups/ 전체 크기와 디스크 여유를 기록한다.
// 매장 파일의 사본마다 그 rev · epoch를 manifest에 적고 control의 tenant_epochs.max_rev_seen을 올린다(되살릴 때 rev_floor = 지금까지
// 본 가장 큰 rev + 1,000,000을 셀 수 있게, data-model · sync 10-2 · deployment 6절). 그 행이 없으면(예전 판이 만든 매장) 만든다.
// 아직 하지 않은 것: 공개 키 암호화, 다른 구역 · 다른 회사 저장소로 올리기(6-1), control backups 표에 적기.

import {
  appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync,
  statfsSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { backupDatabase, loadMigrations, openDatabase, readState } from '@skinote/schema';
import { openControlStore, readInstance, readRev } from '@skinote/store';
import { compareBackupNames, parseBackupName, VERIFIED_SUFFIX } from './backup-files.js';
import { businessDate, localDate } from './clock.js';
import { SHOP_ID_PATTERN } from './config.js';
import { databaseTargets } from './databases.js';
import { errorCode, messageOf } from './errors.js';

/**
 * @typedef {import('./config.js').ServerConfig} ServerConfig
 * @typedef {import('./databases.js').DatabaseTarget} DatabaseTarget
 * @typedef {import('./backup-files.js').BackupName} BackupName
 * @typedef {{
 *   kind: 'control' | 'shop',
 *   shopId: string | null,
 *   source: string,
 *   ok: boolean,
 *   file?: string,
 *   sha256?: string,
 *   bytes?: number,
 *   schemaVersion?: number,
 *   quickCheck?: 'ok',
 *   createdAt?: string,
 *   error?: string,
 *   epoch?: string,
 *   epochNo?: number,
 *   rev?: number,
 * }} BackupItem
 * @typedef {{
 *   startedAt: string,
 *   finishedAt: string,
 *   businessDate: string,
 *   ok: boolean,
 *   release: string,
 *   items: BackupItem[],
 *   removed: string[],
 *   pruned: string[],
 *   prunedMigrations: string[],
 *   cleaned: string[],
 *   backupBytes: number,
 *   freeBytes: number | null,
 * }} BackupRun
 * @typedef {(path: string) => { bavail: number, bsize: number, blocks: number }} StatFs
 */

export const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MANIFEST = 'manifest.json';
export const SUMS = 'SHA256SUMS';
export const PARTIAL_PREFIX = '.partial-';
/** 같은 날짜 폴더에 파일마다 남길 사본 수. */
export const SAME_DAY_KEEP = 3;
/** migrations/: 파일 · 종류(pre · post)마다 남길 판 수와 판마다 남길 사본 수. */
export const MIGRATION_KEEP_VERSIONS = 2;
export const MIGRATION_KEEP_COPIES = 3;

/**
 * 백업할 파일: 설정의 control · 매장 파일, 그리고 설정에서 빠졌지만 매장 폴더에 남은 매장 파일(지우기 전까지는 백업한다).
 * @param {ServerConfig} config
 * @returns {DatabaseTarget[]}
 */
export function listBackupTargets(config) {
  const targets = databaseTargets(config);
  const known = new Set(config.shopIds.map(id => id.toLowerCase()));
  if (existsSync(config.shopDbDir)) {
    for (const name of readdirSync(config.shopDbDir).sort()) {
      const m = /^(.+)\.sqlite$/.exec(name);
      if (!m || !SHOP_ID_PATTERN.test(m[1]) || known.has(m[1].toLowerCase()) || m[1].toLowerCase() === 'control') continue;
      targets.push({ kind: 'shop', shopId: m[1], file: join(config.shopDbDir, name), source: `shops/${name}` });
    }
  }
  return targets;
}

/** @param {string} path */
function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** 원본 한 파일이 차지하는 크기(본 파일 + 아직 합치지 않은 WAL). @param {DatabaseTarget} target */
function sourceBytes(target) {
  return sizeOf(target.file) + sizeOf(`${target.file}-wal`);
}

/** 디스크 여유(읽지 못하면 null). @param {string} dir @param {StatFs} statfs */
export function freeSpace(dir, statfs = statfsSync) {
  try {
    const s = statfs(dir);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/** 폴더 아래 파일 크기의 합(링크는 따라가지 않는다). @param {string} dir */
export function directoryBytes(dir) {
  let total = 0;
  /** @type {string[]} */
  const stack = [dir];
  while (stack.length) {
    const current = /** @type {string} */ (stack.pop());
    let names;
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(current, name);
      try {
        const s = lstatSync(path);
        if (s.isDirectory()) stack.push(path);
        else if (s.isFile()) total += s.size;
      } catch {
        /* 그사이 지워짐 */
      }
    }
  }
  return total;
}

/** SHA256SUMS를 읽는다(파일 이름 → sha256, 적힌 순서). @param {string} dir */
function readSums(dir) {
  /** @type {Map<string, string>} */
  const sums = new Map();
  let text = '';
  try {
    text = readFileSync(join(dir, SUMS), 'utf8');
  } catch {
    return sums;
  }
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (m) sums.set(m[2], m[1]);
  }
  return sums;
}

/** SHA256SUMS를 통째로 다시 쓴다(임시 파일 → 이름 바꿈). @param {string} dir @param {Map<string, string>} sums */
function writeSums(dir, sums) {
  const file = join(dir, SUMS);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, [...sums].map(([name, sha]) => `${sha}  ${name}\n`).join(''), { mode: 0o600 });
  renameSync(tmp, file);
}

/** @param {string} dir @returns {any[]} */
function readRuns(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));
    return Array.isArray(manifest?.runs) ? manifest.runs : [];
  } catch {
    return [];
  }
}

/**
 * 지난 실행이 도중에 죽으며 남긴 것을 치운다: '.partial-*' 폴더, SHA256SUMS에 없는 '*.daily.*.sqlite'(끝까지 확인하지 못한 사본).
 * 치운 이름을 돌려준다.
 * @param {string} dateDir
 */
export function cleanLeftovers(dateDir) {
  /** @type {string[]} */
  const cleaned = [];
  let names;
  try {
    names = readdirSync(dateDir);
  } catch {
    return cleaned;
  }
  const sums = readSums(dateDir);
  for (const name of names) {
    const path = join(dateDir, name);
    if (name.startsWith(PARTIAL_PREFIX)) {
      rmSync(path, { recursive: true, force: true });
      cleaned.push(name);
    } else if (/\.daily\.v\d+\..+\.sqlite$/.test(name) && !sums.has(name)) {
      rmSync(path, { force: true });
      cleaned.push(name);
    }
  }
  return cleaned;
}

/**
 * 확인을 마친 사본을 날짜 폴더로 옮긴다(같은 이름이 있으면 덮지 않고 -2, -3 …).
 * @param {string} from @param {string} dir
 */
function placeCopy(from, dir) {
  const name = basename(from);
  const stem = name.replace(/\.sqlite$/, '');
  for (let n = 1; ; n += 1) {
    const target = join(dir, n === 1 ? name : `${stem}-${n}.sqlite`);
    try {
      linkSync(from, target);
      unlinkSync(from);
      return target;
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error).code;
      if (code === 'EEXIST') continue;
      // 하드 링크를 못 쓰는 파일 시스템: 없는 이름일 때만 옮긴다.
      if (existsSync(target)) continue;
      renameSync(from, target);
      return target;
    }
  }
}

/**
 * 파일 하나의 백업. 던지지 않는다. 사본은 '.partial-*' 폴더에서 만들고 확인이 끝난 것만 날짜 폴더로 옮긴다.
 * @param {DatabaseTarget} target @param {string} dir @param {() => Date} now @param {(line: string) => void} log
 * @returns {BackupItem}
 */
function backupOne(target, dir, now, log) {
  /** @type {BackupItem} */
  const item = { kind: target.kind, shopId: target.shopId, source: target.source, ok: false };
  if (!existsSync(target.file)) {
    item.error = 'MISSING';
    log(`${target.source}: 파일 없음`);
    return item;
  }
  /** @type {string | undefined} */
  let partial;
  let db;
  try {
    partial = mkdtempSync(join(dir, PARTIAL_PREFIX));
    db = openDatabase(target.file, { readOnly: true });
    let version = 0;
    try {
      version = readState(db, target.kind, loadMigrations(target.kind)).version;
    } catch {
      /* 판을 읽지 못해도 사본은 만든다 */
    }
    const record = backupDatabase(db, { file: target.file, label: 'daily', version, backupDir: partial, now });
    const placed = placeCopy(record.path, dir);
    item.ok = true;
    item.file = basename(placed);
    item.sha256 = record.sha256;
    item.bytes = record.bytes;
    item.schemaVersion = record.version;
    item.quickCheck = 'ok';
    item.createdAt = record.created_at;
    log(`${target.source}: ${item.file} · ${record.bytes} bytes · sha256 ${record.sha256.slice(0, 12)}`);
  } catch (error) {
    item.error = errorCode(error, 'BACKUP_FAILED');
    log(`${target.source}: 백업 실패(${item.error}) ${messageOf(error)}`);
  } finally {
    try { db?.close(); } catch { /* 이미 닫힘 */ }
    if (partial) rmSync(partial, { recursive: true, force: true });
  }
  return item;
}

/**
 * manifest.json에 이번 실행을 더한다(임시 파일에 쓰고 이름을 바꿈). 읽을 수 없는 manifest는 옆으로 치우고 새로 시작한다.
 * @param {string} dir @param {BackupRun} run
 */
function appendManifest(dir, run) {
  const file = join(dir, MANIFEST);
  /** @type {{ format: 1, runs: BackupRun[] }} */
  let manifest = { format: 1, runs: [] };
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && Array.isArray(parsed.runs)) manifest = { format: 1, runs: parsed.runs };
      else throw new Error('모양이 틀림');
    } catch {
      renameSync(file, `${file}.broken-${Date.now()}`);
    }
  }
  manifest.runs.push(run);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * 날짜 폴더마다(새것부터) 온전한 사본이 든 파일(source): manifest에서 ok이고 사본이 폴더에 아직 있는 것.
 * @param {string} backupDir @param {string[]} dates 새것부터
 * @returns {Map<string, string>} source → 그 사본이 든 가장 새 날짜 폴더
 */
function newestGoodFolders(backupDir, dates) {
  /** @type {Map<string, string>} */
  const newest = new Map();
  for (const date of dates) {
    const dir = join(backupDir, date);
    for (const run of readRuns(dir)) {
      for (const item of Array.isArray(run?.items) ? run.items : []) {
        if (!item?.ok || typeof item.source !== 'string' || typeof item.file !== 'string' || newest.has(item.source)) continue;
        if (existsSync(join(dir, item.file))) newest.set(item.source, date);
      }
    }
  }
  return newest;
}

/**
 * 오래된 날짜 폴더를 지운다. 남기는 것: 가장 새 keep개, 오늘, 그리고 파일(source)마다 온전한 사본이 든 가장 새 폴더
 * (protect를 주면 그 파일들만). 이번 실행의 성공 여부와 상관없이 불러도 된다. 지운 폴더 이름을 돌려준다.
 * @param {string} backupDir @param {number} keep @param {string} today @param {Set<string>} [protect]
 */
export function rotateBackups(backupDir, keep, today, protect) {
  if (!existsSync(backupDir)) return [];
  const dates = readdirSync(backupDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && DATE_DIR_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .reverse();
  const keepSet = new Set([...dates.slice(0, keep), today]);
  for (const [source, date] of newestGoodFolders(backupDir, dates)) {
    if (!protect || protect.has(source)) keepSet.add(date);
  }
  const removed = [];
  for (const name of dates) {
    if (keepSet.has(name)) continue;
    rmSync(join(backupDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed.sort();
}

/**
 * 한 날짜 폴더 안에서 파일마다 가장 새 keep개의 사본만 남기고(SHA256SUMS도 고쳐 씀) 지운 이름을 돌려준다.
 * @param {string} dir @param {number} keep
 */
export function pruneSameDay(dir, keep) {
  const sums = readSums(dir);
  /** @type {Map<string, BackupName[]>} */
  const groups = new Map();
  for (const name of sums.keys()) {
    const parsed = parseBackupName(name);
    if (!parsed || parsed.label !== 'daily') continue;
    const list = groups.get(parsed.base) ?? [];
    list.push(parsed);
    groups.set(parsed.base, list);
  }
  /** @type {string[]} */
  const dropped = [];
  for (const list of groups.values()) {
    list.sort(compareBackupNames);
    for (const old of list.slice(0, Math.max(0, list.length - keep))) {
      rmSync(join(dir, old.name), { force: true });
      sums.delete(old.name);
      dropped.push(old.name);
    }
  }
  if (dropped.length) writeSums(dir, sums);
  return dropped.sort();
}

/**
 * migrations/의 적용 전 · 뒤 사본을 줄인다: 파일 · 종류마다 가장 새 판 keepVersions개, 판마다 가장 새 keepCopies개.
 * 지금 판의 가장 새 post_migration 사본은 늘 남는다(실행기 · 서버가 쓰기 전에 찾는 것). 지운 이름을 돌려준다.
 * @param {string} dir @param {{ keepVersions?: number, keepCopies?: number }} [options]
 */
export function pruneMigrationBackups(dir, { keepVersions = MIGRATION_KEEP_VERSIONS, keepCopies = MIGRATION_KEEP_COPIES } = {}) {
  if (!existsSync(dir)) return [];
  /** @type {Map<string, BackupName[]>} */
  const groups = new Map();
  for (const name of readdirSync(dir)) {
    const parsed = parseBackupName(name);
    if (!parsed || (parsed.label !== 'pre_migration' && parsed.label !== 'post_migration')) continue;
    const key = `${parsed.base}\0${parsed.label}`;
    const list = groups.get(key) ?? [];
    list.push(parsed);
    groups.set(key, list);
  }
  /** @type {string[]} */
  const dropped = [];
  for (const list of groups.values()) {
    const versions = [...new Set(list.map(n => n.version))].sort((a, b) => b - a);
    const kept = new Set(versions.slice(0, keepVersions));
    for (const version of versions) {
      const copies = list.filter(n => n.version === version).sort(compareBackupNames);
      const drop = kept.has(version) ? copies.slice(0, Math.max(0, copies.length - keepCopies)) : copies;
      for (const old of drop) {
        rmSync(join(dir, old.name), { force: true });
        rmSync(join(dir, old.name + VERIFIED_SUFFIX), { force: true });
        dropped.push(old.name);
      }
    }
  }
  return dropped.sort();
}

export const LOCK_FILE = '.backup.lock';

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {{ code?: string }} */ (error).code === 'EPERM';
  }
}

/**
 * 한 번에 한 백업만 돈다(손으로 돌린 것과 타이머가 겹쳐도 서로의 '.partial-*'를 치우지 않게). 잠금 파일에 pid를 적고,
 * 그 pid가 이미 끝났으면 넘겨받는다. 풀어 주는 함수를 돌려준다.
 * @param {string} backupDir
 */
export function acquireBackupLock(backupDir) {
  const file = join(backupDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      return () => { try { unlinkSync(file); } catch { /* 이미 없음 */ } };
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error).code !== 'EEXIST') throw error;
      const holder = Number.parseInt(readFileSync(file, 'utf8'), 10);
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && isAlive(holder)) {
        throw Object.assign(new Error(`다른 백업이 도는 중입니다(pid ${holder})`), { code: 'BACKUP_RUNNING' });
      }
      rmSync(file, { force: true });
    }
  }
  throw Object.assign(new Error('백업 잠금을 잡지 못했습니다'), { code: 'BACKUP_RUNNING' });
}

/** @param {number} bytes */
function mb(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/**
 * 매장 사본마다 rev · epoch를 적고(manifest 항목) control tenant_epochs.max_rev_seen을 올린다. 던지지 않는다(기록만).
 * @param {ServerConfig} config @param {string} dir @param {BackupItem[]} items @param {() => Date} now @param {(line: string) => void} log
 */
function recordRevs(config, dir, items, now, log) {
  const shops = items.filter(item => item.ok && item.kind === 'shop' && item.shopId && item.file);
  if (!shops.length) return;
  for (const item of shops) {
    let db;
    try {
      db = openDatabase(join(dir, /** @type {string} */ (item.file)), { readOnly: true });
      const instance = readInstance(/** @type {any} */ (db), /** @type {string} */ (item.shopId));
      if (instance) {
        item.epoch = instance.epochId;
        item.rev = readRev(/** @type {any} */ (db), /** @type {string} */ (item.shopId));
        item.epochNo = instance.epochNo;
      }
    } catch (error) {
      log(`${item.source}: 사본의 rev를 읽지 못함 ${messageOf(error)}`);
    } finally {
      try { db?.close(); } catch { /* 이미 닫힘 */ }
    }
  }
  const controlFile = join(config.dbDir, 'control.sqlite');
  if (!existsSync(controlFile)) return;
  let control;
  try {
    control = openDatabase(controlFile);
    const store = openControlStore(/** @type {any} */ (control));
    for (const item of shops) {
      if (item.epoch === undefined || item.rev === undefined || !item.shopId) continue;
      if (!store.tenant(item.shopId)) continue;
      if (!store.raiseMaxRevSeen(item.shopId, item.epoch, item.rev)) {
        store.recordEpoch({ tenantId: item.shopId, epochNo: item.epochNo ?? 1, epochId: item.epoch, now: now().getTime() });
        store.raiseMaxRevSeen(item.shopId, item.epoch, item.rev);
      }
    }
  } catch (error) {
    log(`control의 본 rev를 올리지 못함(tenant_epochs): ${messageOf(error)}`);
  } finally {
    try { control?.close(); } catch { /* 이미 닫힘 */ }
  }
}

/**
 * 모든 파일을 백업한다. 하나라도 실패하면 ok = false(끝 코드 1). 오래된 폴더 정리는 결과와 상관없이 한다.
 * 다른 백업이 도는 중이면 BACKUP_RUNNING을 던진다.
 * @param {ServerConfig} config
 * @param {{ now?: () => Date, log?: (line: string) => void, statfs?: StatFs }} [io]
 */
export function runBackup(config, io = {}) {
  mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  const release = acquireBackupLock(config.backupDir);
  try {
    return runBackupLocked(config, io);
  } finally {
    release();
  }
}

/**
 * @param {ServerConfig} config
 * @param {{ now?: () => Date, log?: (line: string) => void, statfs?: StatFs }} io
 */
function runBackupLocked(config, { now = () => new Date(), log = console.log, statfs = statfsSync }) {
  const started = now();
  const date = localDate(started, config.timeZone);
  mkdirSync(config.migrationBackupDir, { recursive: true, mode: 0o700 });
  const dir = join(config.backupDir, date);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  /** @type {string[]} */
  const cleaned = [];
  for (const name of readdirSync(config.backupDir).filter(n => DATE_DIR_PATTERN.test(n))) {
    for (const left of cleanLeftovers(join(config.backupDir, name))) cleaned.push(`${name}/${left}`);
  }
  for (const name of cleaned) log(`지난 실행이 남긴 것 지움: ${name}`);

  const targets = listBackupTargets(config);
  const protect = new Set(targets.map(t => t.source));
  const reserve = config.backupReserveBytes;
  const needAll = 2 * targets.reduce((sum, t) => sum + sourceBytes(t), 0) + reserve;
  /** @type {string[]} */
  const removed = [];
  let space = freeSpace(dir, statfs);
  if (space && space.freeBytes < needAll) {
    // 먼저 지워도 되는 것을 지워 본다(오늘 폴더와 파일마다 마지막 온전한 사본은 남는다).
    removed.push(...rotateBackups(config.backupDir, config.backupKeepDays, date, protect));
    space = freeSpace(dir, statfs);
  }
  const enough = !space || space.freeBytes >= needAll;
  if (!enough && space) log(`디스크 여유 부족: 남은 ${mb(space.freeBytes)}, 필요 ${mb(needAll)}(원본 × 2 + 남길 여유) · 아무것도 쓰지 않음`);

  const items = targets.map(target => {
    if (!enough) return /** @type {BackupItem} */ ({ kind: target.kind, shopId: target.shopId, source: target.source, ok: false, error: 'NO_SPACE' });
    const now1 = freeSpace(dir, statfs);
    const need = sourceBytes(target) + reserve;
    if (now1 && now1.freeBytes < need) {
      log(`${target.source}: 디스크 여유 부족(남은 ${mb(now1.freeBytes)}, 필요 ${mb(need)}) · 건너뜀`);
      return /** @type {BackupItem} */ ({ kind: target.kind, shopId: target.shopId, source: target.source, ok: false, error: 'NO_SPACE' });
    }
    const item = backupOne(target, dir, now, log);
    if (item.ok) appendFileSync(join(dir, SUMS), `${item.sha256}  ${item.file}\n`, { mode: 0o600 });
    return item;
  });
  let ok = items.length > 0 && items.every(item => item.ok);
  recordRevs(config, dir, items, now, log);

  const pruned = pruneSameDay(dir, SAME_DAY_KEEP);
  removed.push(...rotateBackups(config.backupDir, config.backupKeepDays, date, protect));
  const prunedMigrations = pruneMigrationBackups(config.migrationBackupDir);
  const backupBytes = directoryBytes(config.backupDir);
  const after = freeSpace(dir, statfs);

  /** @type {BackupRun} */
  const run = {
    startedAt: started.toISOString(),
    finishedAt: now().toISOString(),
    businessDate: businessDate(started, config.timeZone, config.cutoffMinutes),
    ok,
    release: config.release,
    items,
    removed: removed.sort(),
    pruned,
    prunedMigrations,
    cleaned,
    backupBytes,
    freeBytes: after ? after.freeBytes : null,
  };
  try {
    appendManifest(dir, run);
  } catch (error) {
    ok = false;
    run.ok = false;
    log(`manifest.json을 쓰지 못함(${errorCode(error, 'MANIFEST_FAILED')}) ${messageOf(error)}`);
  }
  for (const name of run.removed) log(`오래된 백업 폴더 지움: ${name}`);
  for (const name of pruned) log(`같은 날 오래된 사본 지움: ${name}`);
  for (const name of prunedMigrations) log(`오래된 마이그레이션 사본 지움: ${name}`);
  log(`백업 폴더 전체 ${mb(backupBytes)}${after ? ` · 디스크 여유 ${mb(after.freeBytes)}` : ''}`);
  return { ok, date, dir, businessDate: run.businessDate, items, removed: run.removed, pruned, prunedMigrations, cleaned, backupBytes };
}

/**
 * 파일(source)마다 가장 최근에 성공한 백업 시각. 날짜 폴더를 새것부터 읽는다.
 * @param {string} backupDir
 * @returns {Map<string, string>}
 */
export function readLastBackups(backupDir) {
  /** @type {Map<string, string>} */
  const last = new Map();
  if (!existsSync(backupDir)) return last;
  let dates;
  try {
    dates = readdirSync(backupDir).filter(name => DATE_DIR_PATTERN.test(name)).sort().reverse();
  } catch {
    return last;
  }
  for (const date of dates) {
    for (const run of readRuns(join(backupDir, date))) {
      for (const item of Array.isArray(run?.items) ? run.items : []) {
        if (!item?.ok || typeof item.source !== 'string' || typeof item.createdAt !== 'string') continue;
        const seen = last.get(item.source);
        if (!seen || seen < item.createdAt) last.set(item.source, item.createdAt);
      }
    }
  }
  return last;
}

/** manifest들이 바뀌었는지 가를 값(날짜 폴더 이름 + manifest 크기 · 고친 시각). @param {string} backupDir */
function manifestSignature(backupDir) {
  try {
    return readdirSync(backupDir)
      .filter(name => DATE_DIR_PATTERN.test(name))
      .sort()
      .map(date => {
        try {
          const s = statSync(join(backupDir, date, MANIFEST));
          return `${date}:${s.size}:${s.mtimeMs}`;
        } catch {
          return `${date}:-`;
        }
      })
      .join('|');
  } catch {
    return '';
  }
}

/**
 * readLastBackups를 manifest가 바뀐 때만 다시 읽는 함수(상태 확인이 요청마다 manifest를 모두 읽지 않게).
 * @param {string} backupDir
 * @returns {() => Map<string, string>}
 */
export function createLastBackupsReader(backupDir) {
  /** @type {string | null} */
  let signature = null;
  /** @type {Map<string, string>} */
  let cached = new Map();
  return () => {
    const next = manifestSignature(backupDir);
    if (next !== signature) {
      cached = readLastBackups(backupDir);
      signature = next;
    }
    return cached;
  };
}

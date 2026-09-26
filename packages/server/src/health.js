// @ts-check
// GET /api/health의 본문. 감시(deployment 8절)와 배포 확인이 읽는다.
// 개인정보가 없다: 손님 · 직원 자료를 읽지 않고, 경로는 파일 이름만, 오류는 코드만 싣는다(메시지에 경로가 들어갈 수 있다).
//
// 자세한 본문(판 · Node 판 · 매장 id · 파일 크기 · 백업 시각 · 디스크)은 서버 안에서만 준다(127.0.0.1:3100, deploy.sh --status).
// 앞단(Caddy)을 거친 요청에는 { ok }만 준다(server.js). Caddy도 바깥의 /api/health를 404로 막는다(skinote.caddy.template).
//
// warnings(ok와 상관없음, 알림 · 아침 묶음용):
//   BACKUP_MISSING  날마다 백업이 한 번도 없는 파일이 있다
//   BACKUP_STALE    마지막 날마다 백업이 26시간보다 오래된 파일이 있다(백업 타이머가 멈췄거나 계속 실패)
//   DISK_LOW        자료 디스크가 80% 넘게 찼거나 여유가 SKINOTE_BACKUP_RESERVE_MB보다 적다
//   TEST_OPEN_ENROLL 설정 SKINOTE_TEST_OPEN_ENROLL이 켜져 있다(시험 매장의 열린 기기 등록: 실제 손님 자료 전에 끈다). 본문의
//                   testOpenEnroll에 설정 · 켜짐(서버의 매장이 시험 매장 하나이고 기한 안일 때만) · 기한 · 남은 날 · 매장 · 열린 기기 수 ·
//                   끝 수 · 24시간의 새 기기 · 열린 기기의 틀린 비밀번호 수가 있다.
//   TEST_OPEN_ENROLL_EXPIRED 설정은 켜져 있지만 기한(SKINOTE_TEST_OPEN_ENROLL_UNTIL)이 지나 열린 등록이 꺼졌다(설정을 끄거나 기한을 늘림)
//   TEST_OPEN_DEVICES_LEFT 열린 등록이 꺼졌는데 스스로 붙은 기기가 끊기지 않고 남아 있다(서버가 다음 요청 · 다시 시작 때 끊는다)

import { statfsSync } from 'node:fs';
import { businessDate } from './clock.js';
import { inspectConnection } from './databases.js';

/**
 * @typedef {import('./config.js').ServerConfig} ServerConfig
 * @typedef {import('./databases.js').DatabaseEntry} DatabaseEntry
 */

const HEALTHY = new Set(['migrated', 'up_to_date']);
export const BACKUP_STALE_MS = 26 * 60 * 60 * 1000;
export const DISK_LOW_PERCENT = 80;

/** 자료 폴더가 있는 디스크의 여유(경로는 싣지 않는다). @param {string} dir */
function diskOf(dir) {
  try {
    const s = statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { totalBytes: total, freeBytes: free, usedPercent: total ? Math.round(((total - free) / total) * 1000) / 10 : null };
  } catch {
    return null;
  }
}

/**
 * 모든 파일이 쓰기 가능한지(상태 확인의 ok). 무거운 일(PRAGMA · 파일 읽기)을 하지 않는다.
 * @param {DatabaseEntry[] | null} entries @param {boolean} shuttingDown
 */
export function healthOk(entries, shuttingDown) {
  return !shuttingDown && !!entries && entries.length > 0
    && entries.every(e => HEALTHY.has(e.status) && e.mode === 'read_write' && e.writable);
}

/**
 * @param {{
 *   config: ServerConfig,
 *   entries: DatabaseEntry[],
 *   startedAt: Date,
 *   now: Date,
 *   lastBackups: Map<string, string>,
 *   shuttingDown?: boolean,
 *   openEnroll?: { flag: string, active: boolean, expired?: boolean, devices?: number | null } & Record<string, unknown>,
 * }} input
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
export function buildHealth({ config, entries, startedAt, now, lastBackups, shuttingDown = false, openEnroll }) {
  const databases = entries.map(entry => {
    const info = inspectConnection(entry.db);
    return {
      kind: entry.kind,
      shopId: entry.shopId,
      file: entry.name,
      status: entry.status,
      mode: entry.mode,
      writable: entry.writable,
      schemaVersion: entry.schemaVersion,
      knownVersion: entry.knownVersion,
      migrationCount: entry.migrationCount,
      appliedAtStart: entry.appliedAtStart,
      reason: entry.reason,
      warnings: entry.warnings,
      journalMode: info.journalMode,
      pageCount: info.pageCount,
      pageSize: info.pageSize,
      lastBackupAt: lastBackups.get(entry.source) ?? null,
    };
  });
  const control = entries.find(e => e.kind === 'control');
  const date = businessDate(now, config.timeZone, config.cutoffMinutes);
  const shops = entries
    .filter(e => e.kind === 'shop')
    .map(e => ({ shopId: e.shopId, businessDate: date, writable: !!control?.writable && e.writable }));
  const ok = healthOk(entries, shuttingDown);
  const disk = diskOf(config.dataDir);

  /** @type {string[]} */
  const warnings = [];
  const backedUp = databases.filter(d => d.mode !== 'closed');
  if (backedUp.some(d => d.lastBackupAt === null)) warnings.push('BACKUP_MISSING');
  if (backedUp.some(d => d.lastBackupAt !== null && now.getTime() - Date.parse(d.lastBackupAt) > BACKUP_STALE_MS)) {
    warnings.push('BACKUP_STALE');
  }
  if (disk && ((disk.usedPercent ?? 0) >= DISK_LOW_PERCENT || disk.freeBytes < config.backupReserveBytes)) warnings.push('DISK_LOW');
  if (config.testOpenEnroll === 'on') warnings.push('TEST_OPEN_ENROLL');
  if (openEnroll?.expired === true) warnings.push('TEST_OPEN_ENROLL_EXPIRED');
  if (openEnroll && !openEnroll.active && (openEnroll.devices ?? 0) > 0) warnings.push('TEST_OPEN_DEVICES_LEFT');

  return {
    status: ok ? 200 : 503,
    body: {
      ok,
      service: 'skinote-server',
      release: config.release,
      node: process.version,
      serverTime: now.toISOString(),
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000)),
      timeZone: config.timeZone,
      cutoff: config.cutoff,
      ...(shuttingDown ? { shuttingDown: true } : {}),
      warnings,
      testOpenEnroll: openEnroll ?? { flag: config.testOpenEnroll, active: false },
      shops,
      databases,
      disk,
    },
  };
}

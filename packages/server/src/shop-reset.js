// @ts-check
// 시험 매장 새로 만들기(명령줄 reset-test-shop, 매장 파일을 혼자 쓰는 명령). 옛 견본(번호 실물 · 보증금 …)으로 만든 시험 매장을 지금
// 견본(또는 명세 파일)으로 다시 만든다. 직원 계정 · 비밀번호 · 등록한 기기 · 로그인은 되도록 그대로 둔다. 실제 매장은 거절한다(장부는
// 지우지 않는다). SQL은 없다(@skinote/store · @skinote/schema).
//
//   1. 시험 매장만: control tenants.is_test와 매장 파일의 shops.is_test가 모두 1. 옛 파일에서 이어 갈 것을 읽는다(직원 id · 계정,
//      기기, 등록 번호, 기기 번호 셈, epoch, rev).
//   2. 명세(견본이나 파일) + 지금 직원(이름 · 역할 · 차량 · 계정)으로 메모리 파일에 먼저 만들어 본다: 틀린 명세는 파일을 건드리지 않는다.
//      새 명세에 기사의 차량이 없으면 그 기사는 새 명세의 첫 차량으로 옮긴다(알림 한 줄).
//   3. 디스크 여유(옛 파일 × 2 + SKINOTE_BACKUP_RESERVE_MB)를 보고, 옛 파일의 사본을 받는다:
//      <자료>/backups/resets/<매장>.before_reset.v<판>.<UTC 시각>.sqlite (VACUUM INTO · quick_check · sha256, 같은 폴더 SHA256SUMS에 한 줄).
//   4. 새 파일을 매장 폴더의 임시 이름(.reset-<매장>-<시각>.sqlite, 백업 · 상태 확인이 매장 파일로 보지 않는 이름)에 만든다:
//      마이그레이션(0001 + 0002 …) → 매장 만들기 + 이어 가기(한 트랜잭션, epoch = 옛 번호 + 1, rev 바닥 = 지금까지 쓴 가장 큰 rev
//      + 1,000,000: sync 10-2의 되살리기와 같은 규칙) → 상태를 한 번 읽어 봄 → 닫기(WAL이 남지 않아야 한다).
//   5. 옛 연결을 닫고, 남은 -wal · -shm을 옆으로 옮긴 뒤 임시 파일을 제자리 이름으로 바꾼다(rename 한 번: 제자리에는 늘 온전한 파일
//      하나가 있다). 옆으로 옮긴 -wal · -shm은 지운다(내용은 3의 사본에 있다). 새 파일의 적용 뒤 백업(post_migration)을 받는다.
//   6. control: 새 epoch(tenant_epochs), 새 명세에 차량이 없어 옮기지 못한 기기의 세션을 끝낸다. 계정 · 비밀번호 · 다른 세션은 그대로다.
// 새 epoch이라 열려 있던 화면은 다음 머리 묻기 · 알림 연결에서 새로 읽고, 옛 기준으로 보낸 명령은 EPOCH_CHANGED('자료 복구 · 재확인
// 필요')를 받는다. 옛 장부(접수 · 돈 · 재고)와 기기 로그인 기록은 3의 사본에만 남는다.

import { appendFileSync, chmodSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { applyPending, backupDatabase, loadMigrations, openDatabase, readState } from '@skinote/schema';
import { openControlStore, openShopStore, readResetCarry, rebuildShop } from '@skinote/store';
import { markVerified } from './backup-files.js';
import { freeSpace } from './backup.js';

/**
 * @typedef {import('node:sqlite').DatabaseSync} DatabaseSync
 * @typedef {import('./config.js').ServerConfig} ServerConfig
 * @typedef {import('@skinote/domain').ShopSpec} ShopSpec
 * @typedef {import('@skinote/domain').StaffSpec} StaffSpec
 * @typedef {{
 *   shopId: string,
 *   staff: number,
 *   movedDrivers: number,
 *   devices: { kept: number, dropped: number },
 *   codes: number,
 *   sessions: { kept: number, ended: number },
 *   epoch: { no: number, id: string, revFloor: number },
 *   oldRev: number,
 *   backup: { path: string, sha256: string, bytes: number },
 *   warnings: string[],
 * }} ResetSummary
 */

/** 사본을 두는 폴더(<자료>/backups 아래). 날마다 백업 · 상태 확인은 날짜 폴더만 보므로 이 폴더를 지우거나 세지 않는다. */
export const RESET_DIR = 'resets';
/** 사본의 이름표(<매장>.before_reset.v<판>.<시각>.sqlite). */
export const RESET_LABEL = 'before_reset';
/** 새 epoch의 rev 바닥 = 지금까지 쓴 가장 큰 rev + 이 값(sync 10-2). */
export const REV_FLOOR_STEP = 1_000_000;
/** 떼어 둔 옛 -wal · -shm의 꼬리. */
const ASIDE = '.before-reset-';

/** 새로 만들기의 거절 · 실패(코드는 명령줄이 끝 코드로 바꾼다). */
export class ResetError extends Error {
  /** @param {'NOT_PROVISIONED' | 'NOT_TEST_SHOP' | 'BAD_SPEC' | 'NO_SPACE' | 'SWAP_FAILED'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ResetError';
    this.code = code;
  }
}

/** 매장 파일의 임시 이름 앞부분(점으로 시작: 매장 id 모양이 아니라 백업 · 상태 확인이 매장 파일로 보지 않는다). @param {string} shopId */
const tempPrefix = shopId => `.reset-${shopId}-`;

/** @param {string} path */
function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** 파일과 그 -wal · -shm · -journal을 지운다(임시 파일만). @param {string} path */
function removeSet(path) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
}

/** 지난 실행이 남긴 임시 파일(도중에 멈춘 새로 만들기)을 치운다. @param {string} dir @param {string} shopId */
function cleanTemp(dir, shopId) {
  const prefix = tempPrefix(shopId);
  /** @type {string[]} */
  const removed = [];
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!name.startsWith(prefix)) continue;
    rmSync(join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

/** 오류 코드(저장소 · 스키마). @param {unknown} error */
const codeOf = error => /** @type {{ code?: unknown }} */ (error ?? {}).code;

/**
 * 새 명세: 바탕 명세(견본 · 파일)에 이 매장의 코드 · 이름(control)과 지금 직원을 넣는다. 새 명세에 기사의 차량이 없으면 첫 차량으로.
 * @param {ShopSpec} base @param {{ code: string, name: string }} tenant @param {import('@skinote/store').StaffRow[]} staff
 */
function specFor(base, tenant, staff) {
  const spec = structuredClone(base);
  spec.shop = { ...spec.shop, code: tenant.code, name: tenant.name };
  spec.registry = { ...spec.registry, shopName: tenant.name };
  const vehicleIds = (spec.registry.vehicles ?? []).map(v => v.id);
  let movedDrivers = 0;
  spec.staff = staff.map(s => {
    const role = /** @type {StaffSpec['role']} */ (s.roleKey);
    if (role !== 'driver') return { name: s.name, role };
    const same = s.vehicleId !== undefined && vehicleIds.includes(s.vehicleId);
    if (!same) movedDrivers += 1;
    const vehicleKey = same ? s.vehicleId : vehicleIds[0];
    return { name: s.name, role, ...(vehicleKey !== undefined ? { vehicleKey } : {}) };
  });
  return { spec, movedDrivers };
}

/**
 * 시험 매장 하나를 지금 명세로 다시 만든다(서버가 멈춰 있고 부르는 쪽이 쓰는 사람 잠금을 쥐고 있어야 한다).
 * shopDb는 이 함수가 닫는다(파일을 바꾸기 전에). controlDb는 부르는 쪽이 닫는다.
 * @param {ServerConfig} config
 * @param {string} shopId
 * @param {{
 *   controlDb: DatabaseSync,
 *   shopDb: DatabaseSync,
 *   closeShop: () => void,
 *   baseSpec: ShopSpec,
 *   now: number,
 *   fingerprintKey: Uint8Array,
 * }} input
 * @returns {ResetSummary}
 */
export function resetTestShop(config, shopId, { controlDb, shopDb, closeShop, baseSpec, now, fingerprintKey }) {
  const control = openControlStore(/** @type {any} */ (controlDb));
  const tenant = control.tenant(shopId);
  if (!tenant) throw new ResetError('NOT_PROVISIONED', '아직 만들지 않은 매장입니다(provision 먼저)');
  if (!tenant.isTest) throw new ResetError('NOT_TEST_SHOP', '시험 매장(provision --test)만 새로 만듭니다: 실제 매장의 장부는 지우지 않습니다');
  let carry;
  try {
    carry = readResetCarry(/** @type {any} */ (shopDb), shopId);
  } catch (error) {
    if (codeOf(error) === 'SHOP_NOT_PROVISIONED') throw new ResetError('NOT_PROVISIONED', '매장 파일에 매장이 없습니다: 같은 --staff로 provision을 다시 하면 이어서 만듭니다');
    throw error;
  }
  if (!carry.isTest) throw new ResetError('NOT_TEST_SHOP', '매장 파일이 시험 매장이 아닙니다(control과 다름): 사람이 확인해야 합니다');
  if (carry.staff.length === 0) throw new ResetError('BAD_SPEC', '이어 갈 직원이 없습니다');

  const { spec, movedDrivers } = specFor(baseSpec, tenant, carry.staff);
  const known = control.currentEpoch(shopId);
  const epoch = {
    no: Math.max(carry.epochNo, known?.epochNo ?? 0) + 1,
    revFloor: Math.max(carry.rev, carry.revFloor, known?.maxRevSeen ?? 0, known?.revFloor ?? 0) + REV_FLOOR_STEP,
  };
  const migrations = loadMigrations('shop');
  const version = readState(shopDb, 'shop', migrations).version;
  const at = () => new Date(now);

  // 2. 메모리 파일에 먼저: 틀린 명세 · 옮길 수 없는 기기는 여기서 멈춘다(파일 · 사본을 만들기 전).
  const dry = openDatabase(':memory:');
  try {
    applyPending(dry, 'shop', { migrations, appVersion: config.release, now: at });
    rebuildShop(/** @type {any} */ (dry), shopId, spec, now, { carry, epoch });
  } catch (error) {
    const code = codeOf(error);
    if (code === 'BAD_SPEC' || code === 'TIMEZONE_UNSUPPORTED') throw new ResetError('BAD_SPEC', `명세가 틀렸습니다(${String(code)}): ${/** @type {Error} */ (error).message}`);
    throw error;
  } finally {
    dry.close();
  }

  // 3. 디스크 여유와 옛 파일의 사본.
  const file = join(config.shopDbDir, shopId + '.sqlite');
  const bytes = sizeOf(file) + sizeOf(file + '-wal');
  const space = freeSpace(config.dataDir);
  if (space && space.freeBytes < bytes * 2 + config.backupReserveBytes) {
    throw new ResetError('NO_SPACE', `디스크 여유가 모자랍니다(여유 ${Math.floor(space.freeBytes / 1048576)} MB, 필요 ${Math.ceil((bytes * 2 + config.backupReserveBytes) / 1048576)} MB): 아무것도 바꾸지 않았습니다`);
  }
  const resetDir = join(config.backupDir, RESET_DIR);
  const record = backupDatabase(shopDb, { file, label: RESET_LABEL, version, backupDir: resetDir, now: at });
  markVerified(record.path, at());
  appendFileSync(join(resetDir, 'SHA256SUMS'), `${record.sha256}  ${basename(record.path)}\n`, { mode: 0o600 });

  // 4. 새 파일(임시 이름).
  cleanTemp(config.shopDbDir, shopId);
  const stamp = at().toISOString().replace(/[-:.]/g, '');
  const temp = join(config.shopDbDir, `${tempPrefix(shopId)}${stamp}.sqlite`);
  /** @type {import('@skinote/store').RebuildResult} */
  let made;
  const fresh = openDatabase(temp);
  try {
    try { chmodSync(temp, 0o600); } catch { /* Windows에는 권한 비트가 없다 */ }
    applyPending(fresh, 'shop', { migrations, appVersion: config.release, now: at });
    made = rebuildShop(/** @type {any} */ (fresh), shopId, spec, now, { carry, epoch });
    openShopStore(/** @type {any} */ (fresh), shopId, { secrets: { fingerprintKey } }).state(now);
  } catch (error) {
    fresh.close();
    removeSet(temp);
    throw error;
  }
  fresh.close();
  if (sizeOf(temp + '-wal') > 0) {
    removeSet(temp);
    throw new ResetError('SWAP_FAILED', '새 파일을 닫았는데 WAL이 남았습니다: 아무것도 바꾸지 않았습니다(옛 파일 그대로)');
  }
  rmSync(temp + '-wal', { force: true });
  rmSync(temp + '-shm', { force: true });

  // 5. 파일 바꾸기.
  closeShop();
  /** @type {[string, string][]} */
  const aside = [];
  try {
    for (const suffix of ['-wal', '-shm']) {
      if (!existsSync(file + suffix)) continue;
      const to = `${file}${suffix}${ASIDE}${stamp}`;
      renameSync(file + suffix, to);
      aside.push([to, file + suffix]);
    }
    renameSync(temp, file);
  } catch (error) {
    for (const [to, from] of aside) {
      try { renameSync(to, from); } catch { /* 사본(3)이 있다 */ }
    }
    removeSet(temp);
    throw new ResetError('SWAP_FAILED', `파일을 바꾸지 못했습니다(${String(codeOf(error) ?? 'ERROR')}): 옛 파일 그대로, 사본 ${basename(record.path)}`);
  }
  for (const [to] of aside) rmSync(to, { force: true });

  /** @type {string[]} */
  const warnings = [];
  const live = openDatabase(file);
  try {
    const post = backupDatabase(live, { file, label: 'post_migration', version: migrations.at(-1)?.id ?? version, backupDir: config.migrationBackupDir, now: at });
    markVerified(post.path, at());
  } catch {
    warnings.push('새 파일의 적용 뒤 백업(post_migration)을 받지 못했습니다: 서버는 옛 파일의 적용 뒤 백업을 보고 그대로 켜집니다');
  } finally {
    live.close();
  }

  // 6. control: 새 epoch, 옮기지 못한 기기의 세션.
  control.recordEpoch({ tenantId: shopId, epochNo: epoch.no, epochId: made.epoch, now, revFloor: epoch.revFloor });
  let ended = 0;
  for (const deviceId of made.devices.dropped) ended += control.revokeDeviceSessions(shopId, deviceId, 'device_revoked', now);
  const kept = made.devices.kept.reduce((n, deviceId) => n + control.openSessionsOfDevice(shopId, deviceId, now).length, 0);

  return {
    shopId,
    staff: carry.staff.length,
    movedDrivers,
    devices: { kept: made.devices.kept.length, dropped: made.devices.dropped.length },
    codes: made.codes,
    sessions: { kept, ended },
    epoch: { no: epoch.no, id: made.epoch, revFloor: epoch.revFloor },
    oldRev: carry.rev,
    backup: { path: record.path, sha256: record.sha256, bytes: record.bytes },
    warnings,
  };
}

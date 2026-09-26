// 시험 매장 새로 만들기(서버 명령줄 reset-test-shop)의 저장소 몫. 옛 견본으로 만든 시험 매장을 지금 명세로 다시 만들 때, 옛 매장 파일에서
// 이어 갈 것(직원 id · 계정, 기기, 등록 번호, 기기 번호 셈, epoch · rev)을 읽고(readResetCarry), 새 빈 파일(마이그레이션만 한 것)에
// 명세와 이어 갈 것을 한 트랜잭션으로 쓴다(rebuildShop). 직원 id · 기기 id가 같으니 control의 계정 · 비밀번호 · 세션이 그대로 맞는다.
// 새 명세에 차량이 없는 기사 기기는 옮기지 않는다(부르는 쪽이 그 기기의 세션을 끝낸다). 기기 로그인 기록(device_sign_ins)은 옛 epoch의
// 기록이라 옮기지 않는다(옛 파일의 백업에 남는다). 파일 바꾸기 · 백업 · control 행은 서버(packages/server/src/shop-reset.js)가 한다.
import type { ShopSpec } from '@skinote/domain';
import { StoreError } from './errors.ts';
import { all, insert, num, one, run, str, text, type Db, type Row } from './db.ts';
import { readRev } from './load.ts';
import { checkSpec, inWriteTransaction, provisionRows, type ProvisionResult } from './provision.ts';
import { MAIN_SCOPE } from './registry-keys.ts';
import { listStaff, type StaffRow } from './registry-read.ts';

/** 옛 매장 파일에서 새 파일로 이어 갈 것. */
export interface ResetCarry {
  /** shops.is_test(시험 매장만 새로 만든다). */
  isTest: boolean;
  epochNo: number;
  rev: number;
  revFloor: number;
  /** 지금 직원(쓰는 중인 것만, 만든 차례). */
  staff: StaffRow[];
  /** devices 행 그대로(끊긴 기기 포함). */
  devices: Row[];
  /** device_enrollment_codes 행 그대로(쓴 번호 · 아직 안 쓴 번호). */
  codes: Row[];
  /** shop_counters('device_short_no'): 기기 번호는 다시 쓰지 않는다. */
  deviceShortNo: number;
}

export interface RebuildOptions {
  carry: ResetCarry;
  /** 새 epoch(옛 번호 + 1)와 rev 바닥(지금까지 쓴 가장 큰 rev + 1,000,000, sync 10-2). */
  epoch: { no: number; revFloor: number };
}

export interface RebuildResult extends ProvisionResult {
  /** 옮긴 기기 id와 옮기지 못한 기기 id(새 명세에 그 차량이 없음). */
  devices: { kept: string[]; dropped: string[] };
  /** 옮긴 등록 번호 행 수. */
  codes: number;
}

/** 옛 매장 파일에서 이어 갈 것을 읽는다. 매장이 없으면 SHOP_NOT_PROVISIONED, 다른 매장의 파일이면 SHOP_MISMATCH. */
export function readResetCarry(db: Db, shopId: string): ResetCarry {
  const ids = all(db, 'SELECT id FROM shops').map((r) => str(r.id));
  if (ids.length === 0) throw new StoreError('SHOP_NOT_PROVISIONED', '매장 파일에 매장이 없다');
  if (ids.length !== 1 || ids[0] !== shopId) throw new StoreError('SHOP_MISMATCH', '다른 매장의 파일이다');
  const shop = one(db, 'SELECT s.is_test, i.epoch_no, i.rev_floor FROM shops s JOIN shop_instance i ON i.shop_id = s.id WHERE s.id = ?', shopId);
  if (!shop) throw new StoreError('SHOP_NOT_PROVISIONED', '매장의 epoch 행이 없다: ' + shopId);
  return {
    isTest: num(shop.is_test) === 1,
    epochNo: num(shop.epoch_no, 1),
    rev: readRev(db, shopId),
    revFloor: num(shop.rev_floor),
    staff: listStaff(db, shopId),
    devices: all(db, 'SELECT * FROM devices WHERE shop_id = ? ORDER BY rowid', shopId),
    codes: all(db, 'SELECT * FROM device_enrollment_codes WHERE shop_id = ? ORDER BY rowid', shopId),
    deviceShortNo: num(one(db, "SELECT value FROM shop_counters WHERE shop_id = ? AND counter_key = 'device_short_no' AND scope_key = ''", shopId)?.value),
  };
}

/**
 * 새 빈 파일에 매장을 만들고 이어 갈 것을 넣는다(한 트랜잭션: 도중에 실패하면 파일은 빈 채로 남는다). 명세의 직원은 carry.staff와 같은
 * 차례여야 한다(id · 계정은 carry에서). 기기의 지점은 비우고(만들기에 지점이 없다), 마감 범위는 'main'만 남긴다.
 */
export function rebuildShop(db: Db, shopId: string, spec: ShopSpec, now: number, { carry, epoch }: RebuildOptions): RebuildResult {
  checkSpec(spec);
  if (spec.staff.length !== carry.staff.length || spec.staff.some((s, i) => s.name !== carry.staff[i]?.name || s.role !== carry.staff[i]?.roleKey)) {
    throw new StoreError('BAD_SPEC', '명세의 직원이 이어 갈 직원과 다르다');
  }
  return inWriteTransaction(db, () => {
    const made = provisionRows(db, shopId, spec, now, {
      isTest: carry.isTest,
      accountIds: carry.staff.map((s) => s.accountId),
      staffIds: carry.staff.map((s) => s.id),
      epoch,
    });
    const vehicles = new Set(spec.registry.vehicles.map((v) => v.id));
    const kept: string[] = [];
    const dropped: string[] = [];
    let shortNo = carry.deviceShortNo;
    for (const row of carry.devices) {
      const vehicle = text(row.vehicle_id);
      if (vehicle !== undefined && !vehicles.has(vehicle)) {
        dropped.push(str(row.id));
        continue;
      }
      insert(db, 'devices', { ...row, shop_id: shopId, branch_id: null, closing_scope_id: text(row.closing_scope_id) === MAIN_SCOPE ? MAIN_SCOPE : null });
      kept.push(str(row.id));
      shortNo = Math.max(shortNo, num(row.short_no));
    }
    const keptIds = new Set(kept);
    let codes = 0;
    for (const row of carry.codes) {
      const vehicle = text(row.vehicle_id);
      const device = text(row.device_id);
      if ((vehicle !== undefined && !vehicles.has(vehicle)) || (device !== undefined && !keptIds.has(device))) continue;
      insert(db, 'device_enrollment_codes', { ...row, shop_id: shopId });
      codes += 1;
    }
    run(db, "UPDATE shop_counters SET value = ? WHERE shop_id = ? AND counter_key = 'device_short_no' AND scope_key = ''", shortNo, shopId);
    return { ...made, devices: { kept, dropped }, codes };
  });
}

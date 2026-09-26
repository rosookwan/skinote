// 매장 파일 쪽 기기 행(plan §4-7): 등록 번호(device_enrollment_codes), 기기(devices), 로그인 기록(device_sign_ins), 끊기(revoke).
// 매장 파일의 쓰는 사람 잠금 안에서 돈다(서버가 쥔 연결, 또는 서버가 멈췄을 때의 명령줄). 번호 자체는 저장하지 않고 sha256만 둔다
// (번호는 명령줄이 한 번 보여 준다, D9). 기기 로그인 기록은 시스템 기록이라 rev를 올리지 않는다(sync 3).
// 열린 등록(enrollOpen, 2026-09-26 시험 중 요청): 시험 매장에서 서버 설정 SKINOTE_TEST_OPEN_ENROLL이 켜져 있을 때만 서버가 부른다.
// 번호 없이 기기가 고른 종류 · 차량으로 기기를 만들고(열쇠 · 기기 번호 · 행 모양은 번호 등록과 같다) registered_by를
// 'system:open_enroll'로 남긴다(Device.openEnrolled). 끊기지 않은 열린 기기가 끝 수(cap)면 만들지 않는다. 새로 붙일 때 한 시간 넘게
// 한 번도 로그인하지 않은 열린 기기는 먼저 끊는다(열쇠를 잃은 기기 · 버려진 기기가 자리를 차지하지 않게). 설정을 끄거나 기한이 지나면
// 서버가 revokeOpen으로 열린 기기를 모두 끊는다(다시 쓰려면 등록 번호로).
import { StoreError } from './errors.ts';
import { isoOf, msOf, ulid } from './ids.ts';
import { all, atomically, insert, num, one, run, str, text, type Db, type Row } from './db.ts';
import { SYSTEM_ACTOR } from './registry-keys.ts';
import { readRev } from './load.ts';

export type DeviceKind = 'pos' | 'driver_tablet' | 'driver_phone';
export type DeviceStatus = 'active' | 'revoked';

/** 열린 등록(시험 매장, SKINOTE_TEST_OPEN_ENROLL)으로 붙은 기기의 registered_by. 끝 수는 이 값의 끊기지 않은 기기로 센다. */
export const OPEN_ENROLL_ACTOR = 'system:open_enroll';

export interface EnrollmentCode {
  id: string;
  kind: DeviceKind;
  label: string;
  vehicleId?: string;
  expiresAt: number;
  approvedAt?: number;
  claimedAt?: number;
  usedAt?: number;
  deviceId?: string;
}

export interface Device {
  id: string;
  kind: DeviceKind;
  label: string;
  vehicleId?: string;
  shortNo: number;
  publicKey: string;
  status: DeviceStatus;
  registeredAt: number;
  revokedAt?: number;
  lastSeenAt?: number;
  /** 열린 등록(registered_by 'system:open_enroll')으로 스스로 붙은 기기. 서버는 열린 등록이 켜진 동안만 쓰게 한다. */
  openEnrolled: boolean;
}

/** 명령줄 status의 열린 기기 한 줄(이름 없이: 직원 이름 · 열쇠 없음). */
export interface OpenDeviceSummary {
  id: string;
  label: string;
  kind: DeviceKind;
  vehicleId?: string;
  shortNo: number;
  registeredAt: number;
  lastSeenAt?: number;
  /** 이 기기의 로그인 수(device_sign_ins). */
  signIns: number;
  lastSignInAt?: number;
}

const codeOf = (r: Row): EnrollmentCode => ({
  id: str(r.id),
  kind: str(r.kind_key) as DeviceKind,
  label: str(r.label),
  ...(text(r.vehicle_id) !== undefined ? { vehicleId: str(r.vehicle_id) } : {}),
  expiresAt: msOf(str(r.expires_at)),
  ...(text(r.approved_at) !== undefined ? { approvedAt: msOf(str(r.approved_at)) } : {}),
  ...(text(r.claimed_at) !== undefined ? { claimedAt: msOf(str(r.claimed_at)) } : {}),
  ...(text(r.used_at) !== undefined ? { usedAt: msOf(str(r.used_at)) } : {}),
  ...(text(r.device_id) !== undefined ? { deviceId: str(r.device_id) } : {}),
});

const deviceOf = (r: Row): Device => ({
  id: str(r.id),
  kind: str(r.kind_key) as DeviceKind,
  label: str(r.label),
  ...(text(r.vehicle_id) !== undefined ? { vehicleId: str(r.vehicle_id) } : {}),
  shortNo: num(r.short_no),
  publicKey: str(r.public_key),
  status: str(r.status_key) as DeviceStatus,
  registeredAt: msOf(str(r.registered_at)),
  ...(text(r.revoked_at) !== undefined ? { revokedAt: msOf(str(r.revoked_at)) } : {}),
  ...(text(r.last_seen_at) !== undefined ? { lastSeenAt: msOf(str(r.last_seen_at)) } : {}),
  openEnrolled: text(r.registered_by) === OPEN_ENROLL_ACTOR,
});

export interface DeviceRows {
  /** 등록 번호를 만든다(명령줄이 미리 승인: approved_by 'system:cli', plan §0). 번호는 sha256(codeHash)만. */
  createCode(input: { codeHash: string; kind: DeviceKind; label: string; vehicleId?: string; expiresAt: number; now: number; createdBy?: string }): EnrollmentCode;
  codeById(id: string): EnrollmentCode | undefined;
  codeByHash(codeHash: string): EnrollmentCode | undefined;
  /** 기기가 번호를 넣은 때와 기기가 말한 모양('Windows · Chrome'). */
  claimCode(id: string, agent: string, now: number): void;
  /** 번호로 기기를 등록한다: 종류 · 이름 · 차량은 번호에서, 기기 번호(short_no)는 셈에서. 번호는 쓴 것으로 표시한다. */
  enroll(input: { codeId: string; publicKey: string; now: number }): Device;
  /**
   * 열린 등록(시험 매장만: 서버가 설정과 시험 매장을 본 뒤 부른다). 종류 · 차량은 기기가 고른 것(기사 기기는 매장의 쓰는 차량이 꼭 있어야
   * 하고 카운터는 차량이 없다, 아니면 BAD_SPEC), 이름은 기기 번호로 만든 label(shortNo), 기기 번호는 번호 등록과 같은 셈. 끊기지 않은
   * 열린 기기가 이미 cap개면 아무것도 적지 않고 null. 세기 전에 unusedBefore보다 먼저 붙어 한 번도 로그인하지 않은 열린 기기를
   * 끊는다(까닭 'open_unused', 세션이 없는 기기라 끝낼 세션도 없다).
   */
  enrollOpen(input: {
    kind: DeviceKind; vehicleId?: string; publicKey: string; label: (shortNo: number) => string; cap: number; now: number; unusedBefore?: number;
  }): Device | null;
  /** 열린 등록으로 붙어 아직 끊기지 않은 기기 수. */
  openCount(): number;
  /** 끊기지 않은 열린 기기를 모두 끊는다(설정을 끔 · 기한 지남 · 명령줄 revoke-device --open-all). 끊은 기기 id(서버가 세션을 끝낸다). */
  revokeOpen(reason: string, now: number): string[];
  /** 끊기지 않은 열린 기기와 로그인 수(명령줄 status, 기기 번호 차례). */
  openDevices(): OpenDeviceSummary[];
  device(id: string): Device | undefined;
  /** 이름이나 id로 찾기(명령줄 revoke-device). */
  find(labelOrId: string): Device | undefined;
  list(): Device[];
  /** 로그인 한 번(device_sign_ins 다음 차례, devices.last_seen_at). rev는 올리지 않는다. */
  signIn(input: { deviceId: string; staffMemberId: string; method: 'pin' | 'password'; sessionId?: string; now: number }): number;
  touch(deviceId: string, now: number): void;
  /** 기기 끊기: 새 세션을 막는다(서버가 세션 · 스트림을 끝낸다). 이미 끊긴 기기는 그대로. */
  revoke(deviceId: string, reason: string, now: number): boolean;
  /** 기기 id → 상태(서버의 기기 상태 캐시). */
  statusMap(): Map<string, DeviceStatus>;
}

export function deviceRows(db: Db, shopId: string): DeviceRows {
  /** 기기 행 하나: 기기 번호(short_no)는 셈에서 한 칸 올려 쓴다(다시 쓰지 않음). 부르는 쪽이 트랜잭션(atomically) 안에서 부른다. */
  const insertDevice = (input: { kind: DeviceKind; vehicleId?: string; label: (shortNo: number) => string; publicKey: string; registeredBy: string; now: number }) => {
    const counter = one(db, "SELECT value FROM shop_counters WHERE shop_id = ? AND counter_key = 'device_short_no' AND scope_key = ''", shopId);
    const shortNo = num(counter?.value) + 1;
    if (counter) run(db, "UPDATE shop_counters SET value = ? WHERE shop_id = ? AND counter_key = 'device_short_no' AND scope_key = ''", shortNo, shopId);
    else insert(db, 'shop_counters', { shop_id: shopId, counter_key: 'device_short_no', scope_key: '', value: shortNo });
    const id = ulid(input.now);
    const at = isoOf(input.now);
    insert(db, 'devices', {
      shop_id: shopId, id, kind_key: input.kind, label: input.label(shortNo), vehicle_id: input.vehicleId, short_no: shortNo, public_key: input.publicKey,
      offline_capable: false, status_key: 'active', registered_at: at, registered_by: input.registeredBy, last_seen_at: at,
    });
    return id;
  };
  /** 등록 한 번(셈 · 기기 · 번호 표시를 한 덩어리로). */
  const enrollOnce = (input: { codeId: string; publicKey: string; now: number }): Device => {
    const code = rows.codeById(input.codeId);
    if (!code) throw new StoreError('NOT_FOUND', '등록 번호가 없다');
    if (code.usedAt !== undefined || code.approvedAt === undefined || code.expiresAt <= input.now) throw new StoreError('NOT_FOUND', '쓸 수 없는 등록 번호');
    const id = insertDevice({
      kind: code.kind, label: () => code.label, publicKey: input.publicKey, registeredBy: SYSTEM_ACTOR, now: input.now,
      ...(code.vehicleId !== undefined ? { vehicleId: code.vehicleId } : {}),
    });
    const at = isoOf(input.now);
    run(db, 'UPDATE device_enrollment_codes SET used_at = ?, device_id = ?, claimed_at = coalesce(claimed_at, ?) WHERE shop_id = ? AND id = ?', at, id, at, shopId, code.id);
    return rows.device(id)!;
  };
  const countOpen = () => num(one(db, "SELECT count(*) AS n FROM devices WHERE shop_id = ? AND registered_by = ? AND status_key = 'active'", shopId, OPEN_ENROLL_ACTOR)?.n);
  const revokeWhere = (extra: string, reason: string, now: number, ...params: (string | number)[]) => {
    const ids = all(db, "SELECT id FROM devices WHERE shop_id = ? AND registered_by = ? AND status_key = 'active'" + extra + ' ORDER BY short_no', shopId, OPEN_ENROLL_ACTOR, ...params).map((r) => str(r.id));
    for (const id of ids) rows.revoke(id, reason, now);
    return ids;
  };
  const rows: DeviceRows = {
    createCode(input) {
      const id = ulid(input.now);
      const at = isoOf(input.now);
      if (!/^[0-9a-f]{64}$/.test(input.codeHash)) throw new StoreError('BAD_SPEC', '등록 번호 해시 모양');
      if (input.kind === 'pos' ? input.vehicleId !== undefined : input.vehicleId === undefined) throw new StoreError('BAD_SPEC', '기사 기기만 차량을 가진다');
      insert(db, 'device_enrollment_codes', {
        shop_id: shopId, id, code_hash: input.codeHash, kind_key: input.kind, vehicle_id: input.vehicleId, label: input.label, origin_key: 'shop',
        expires_at: isoOf(input.expiresAt), approved_at: at, approved_by: SYSTEM_ACTOR, created_at: at, created_by: input.createdBy ?? SYSTEM_ACTOR,
      });
      return rows.codeById(id)!;
    },
    codeById(id) {
      const r = one(db, 'SELECT * FROM device_enrollment_codes WHERE shop_id = ? AND id = ?', shopId, id);
      return r && codeOf(r);
    },
    codeByHash(codeHash) {
      const r = one(db, 'SELECT * FROM device_enrollment_codes WHERE shop_id = ? AND code_hash = ?', shopId, codeHash);
      return r && codeOf(r);
    },
    claimCode(id, agent, now) {
      run(db, 'UPDATE device_enrollment_codes SET claimed_at = coalesce(claimed_at, ?), claimed_agent = coalesce(claimed_agent, ?) WHERE shop_id = ? AND id = ?', isoOf(now), agent.slice(0, 80), shopId, id);
    },
    enroll(input) {
      return atomically(db, () => enrollOnce(input));
    },
    enrollOpen(input) {
      if (input.kind === 'pos' ? input.vehicleId !== undefined : input.vehicleId === undefined) throw new StoreError('BAD_SPEC', '기사 기기만 차량을 가진다');
      return atomically(db, () => {
        if (input.vehicleId !== undefined && !one(db, 'SELECT 1 AS ok FROM vehicles WHERE shop_id = ? AND id = ? AND active = 1', shopId, input.vehicleId)) {
          throw new StoreError('BAD_SPEC', '쓰는 차량이 아니다');
        }
        if (input.unusedBefore !== undefined) {
          revokeWhere(' AND registered_at < ? AND NOT EXISTS (SELECT 1 FROM device_sign_ins s WHERE s.shop_id = devices.shop_id AND s.device_id = devices.id)',
            'open_unused', input.now, isoOf(input.unusedBefore));
        }
        if (countOpen() >= input.cap) return null;
        const id = insertDevice({
          kind: input.kind, label: input.label, publicKey: input.publicKey, registeredBy: OPEN_ENROLL_ACTOR, now: input.now,
          ...(input.vehicleId !== undefined ? { vehicleId: input.vehicleId } : {}),
        });
        return rows.device(id)!;
      });
    },
    openCount: countOpen,
    revokeOpen(reason, now) {
      return atomically(db, () => revokeWhere('', reason, now));
    },
    openDevices() {
      return all(db, `SELECT d.*, (SELECT count(*) FROM device_sign_ins s WHERE s.shop_id = d.shop_id AND s.device_id = d.id) AS sign_ins,
          (SELECT max(signed_in_at) FROM device_sign_ins s WHERE s.shop_id = d.shop_id AND s.device_id = d.id) AS last_sign_in_at
        FROM devices d WHERE d.shop_id = ? AND d.registered_by = ? AND d.status_key = 'active' ORDER BY d.short_no`, shopId, OPEN_ENROLL_ACTOR).map((r) => {
        const d = deviceOf(r);
        return {
          id: d.id, label: d.label, kind: d.kind, ...(d.vehicleId !== undefined ? { vehicleId: d.vehicleId } : {}), shortNo: d.shortNo, registeredAt: d.registeredAt,
          ...(d.lastSeenAt !== undefined ? { lastSeenAt: d.lastSeenAt } : {}), signIns: num(r.sign_ins),
          ...(text(r.last_sign_in_at) !== undefined ? { lastSignInAt: msOf(str(r.last_sign_in_at)) } : {}),
        };
      });
    },
    device(id) {
      const r = one(db, 'SELECT * FROM devices WHERE shop_id = ? AND id = ?', shopId, id);
      return r && deviceOf(r);
    },
    find(labelOrId) {
      const byId = rows.device(labelOrId);
      if (byId) return byId;
      const found = all(db, 'SELECT * FROM devices WHERE shop_id = ? AND label = ? ORDER BY registered_at DESC', shopId, labelOrId);
      return found[0] && deviceOf(found[0]);
    },
    list() {
      return all(db, 'SELECT * FROM devices WHERE shop_id = ? ORDER BY short_no', shopId).map(deviceOf);
    },
    signIn(input) {
      return atomically(db, () => {
        const seq = num(one(db, 'SELECT max(seq) AS s FROM device_sign_ins WHERE shop_id = ? AND device_id = ?', shopId, input.deviceId)?.s) + 1;
        insert(db, 'device_sign_ins', {
          shop_id: shopId, device_id: input.deviceId, seq, staff_member_id: input.staffMemberId, method_key: input.method, signed_in_at: isoOf(input.now),
          session_id: input.sessionId, created_rev: readRev(db, shopId),
        });
        rows.touch(input.deviceId, input.now);
        return seq;
      });
    },
    touch(deviceId, now) {
      run(db, 'UPDATE devices SET last_seen_at = ? WHERE shop_id = ? AND id = ?', isoOf(now), shopId, deviceId);
    },
    revoke(deviceId, reason, now) {
      const r = run(db, "UPDATE devices SET status_key = 'revoked', revoked_at = ?, revoke_reason = ?, version = version + 1 WHERE shop_id = ? AND id = ? AND status_key <> 'revoked'",
        isoOf(now), reason, shopId, deviceId);
      return Number(r.changes) > 0;
    },
    statusMap() {
      return new Map(all(db, 'SELECT id, status_key FROM devices WHERE shop_id = ?', shopId).map((r) => [str(r.id), str(r.status_key) as DeviceStatus]));
    },
  };
  return rows;
}

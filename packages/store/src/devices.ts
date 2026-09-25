// 매장 파일 쪽 기기 행(plan §4-7): 등록 번호(device_enrollment_codes), 기기(devices), 로그인 기록(device_sign_ins), 끊기(revoke).
// 매장 파일의 쓰는 사람 잠금 안에서 돈다(서버가 쥔 연결, 또는 서버가 멈췄을 때의 명령줄). 번호 자체는 저장하지 않고 sha256만 둔다
// (번호는 명령줄이 한 번 보여 준다, D9). 기기 로그인 기록은 시스템 기록이라 rev를 올리지 않는다(sync 3).
import { StoreError } from './errors.ts';
import { isoOf, msOf, ulid } from './ids.ts';
import { all, atomically, insert, num, one, run, str, text, type Db, type Row } from './db.ts';
import { SYSTEM_ACTOR } from './registry-keys.ts';
import { readRev } from './load.ts';

export type DeviceKind = 'pos' | 'driver_tablet' | 'driver_phone';
export type DeviceStatus = 'active' | 'revoked';

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
  /** 등록 한 번(셈 · 기기 · 번호 표시를 한 덩어리로). */
  const enrollOnce = (input: { codeId: string; publicKey: string; now: number }): Device => {
    const code = rows.codeById(input.codeId);
    if (!code) throw new StoreError('NOT_FOUND', '등록 번호가 없다');
    if (code.usedAt !== undefined || code.approvedAt === undefined || code.expiresAt <= input.now) throw new StoreError('NOT_FOUND', '쓸 수 없는 등록 번호');
    const counter = one(db, "SELECT value FROM shop_counters WHERE shop_id = ? AND counter_key = 'device_short_no' AND scope_key = ''", shopId);
    const shortNo = num(counter?.value) + 1;
    if (counter) run(db, "UPDATE shop_counters SET value = ? WHERE shop_id = ? AND counter_key = 'device_short_no' AND scope_key = ''", shortNo, shopId);
    else insert(db, 'shop_counters', { shop_id: shopId, counter_key: 'device_short_no', scope_key: '', value: shortNo });
    const id = ulid(input.now);
    const at = isoOf(input.now);
    insert(db, 'devices', {
      shop_id: shopId, id, kind_key: code.kind, label: code.label, vehicle_id: code.vehicleId, short_no: shortNo, public_key: input.publicKey,
      offline_capable: false, status_key: 'active', registered_at: at, registered_by: SYSTEM_ACTOR, last_seen_at: at,
    });
    run(db, 'UPDATE device_enrollment_codes SET used_at = ?, device_id = ?, claimed_at = coalesce(claimed_at, ?) WHERE shop_id = ? AND id = ?', at, id, at, shopId, code.id);
    return rows.device(id)!;
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

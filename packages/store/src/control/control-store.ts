// control 파일의 행(plan §4-7): 매장 목록(tenants), 직원 계정(accounts · account_tenants), 세션(sessions), 로그인 시도
// (login_attempts), 등록 번호 길잡이(enrollment_routes). 서버의 로그인 · 세션(auth.js)과 명령줄(provision · rotate-pin · revoke)이
// 쓴다. 비밀번호 해시(scrypt)는 서버가 만들어 넘기고 여기서는 PHC 글자만 저장한다. 세션 토큰은 sha256만 둔다.
import { StoreError } from '../errors.ts';
import { isoOf, msOf, ulid } from '../ids.ts';
import { all, insert, num, one, run, str, text, type Db, type InValue, type Row } from '../db.ts';

export interface Tenant {
  id: string;
  code: string;
  name: string;
  dataLocation: string;
  status: string;
  isTest: boolean;
}

export interface Account {
  id: string;
  loginRealm: string;
  loginId?: string;
  displayName: string;
  pinHash?: string;
  pinFailedCount: number;
  status: string;
  lastLoginAt?: number;
}

export interface Session {
  id: string;
  kind: 'staff';
  accountId: string;
  tenantId: string;
  deviceId: string;
  staffMemberId: string;
  createdAt: number;
  lastUsedAt: number;
  idleTimeoutS: number;
  expiresAt: number;
  revokedAt?: number;
  revokeReason?: string;
}

export interface EnrollmentRoute {
  codeHash: string;
  tenantId: string;
  codeId: string;
  expiresAt: number;
  claimedAt?: number;
  usedAt?: number;
}

/** 로그인 시도의 방법. pin_reset은 시도가 아니라 새 비밀번호(명령줄 rotate-pin)의 표시다: 그 계정의 실패 셈이 거기서 다시 시작한다. */
export type AttemptMethod = 'pin' | 'password' | 'enrollment' | 'pin_reset';

export interface AttemptFilter {
  accountId?: string;
  deviceId?: string;
  ipHash?: string;
  method?: AttemptMethod;
}

export interface ControlStore {
  /** 매장 하나와 그 직원 계정(명령줄 provision, 같은 실행에서 매장 파일은 provision()). 직원 차례대로 계정 id. */
  provisionTenant(input: {
    shopId: string; code: string; name: string; isTest: boolean; staff: readonly { displayName: string; pinHash: string | null }[];
  }, now: number): { accountIds: string[] };
  tenant(id: string): Tenant | undefined;
  tenantByCode(code: string): Tenant | undefined;
  account(id: string): Account | undefined;
  accountsOf(tenantId: string): Account[];
  /** 새 PIN(rotate-pin): 실패 수도 0으로. */
  setPinHash(accountId: string, pinHash: string, now: number): void;
  /** PIN이 맞음: 마지막 로그인 · 실패 수 0. */
  loginSucceeded(accountId: string, now: number): void;
  /** PIN이 틀림: 계정의 누적 실패 수(잠금 판단은 login_attempts로, pin_locked_until은 쓰지 않는다 — 모든 기기가 잠기므로). */
  loginFailed(accountId: string, now: number): number;
  createSession(input: {
    tokenHash: string; accountId: string; tenantId: string; deviceId: string; staffMemberId: string; idleTimeoutS: number; expiresAt: number;
    ipHash?: string; userAgent?: string; now: number;
  }): Session;
  sessionByTokenHash(tokenHash: string): Session | undefined;
  session(id: string): Session | undefined;
  /** 마지막 사용 시각(1분에 한 번까지만 쓴다). 쓴 경우 true. */
  touchSession(id: string, now: number): boolean;
  revokeSession(id: string, reason: string, now: number): boolean;
  /** 한 기기의 열린 세션을 모두 끝낸다(기기 끊기, sessions_device 인덱스). 끝낸 수. */
  revokeDeviceSessions(tenantId: string, deviceId: string, reason: string, now: number): number;
  /** 한 기기의 열린 세션(스트림 닫기 · 시험). */
  openSessionsOfDevice(tenantId: string, deviceId: string, now: number): Session[];
  recordAttempt(input: {
    loginId: string; accountId?: string; tenantId?: string; deviceId?: string; method: AttemptMethod; succeeded: boolean; reason?: string; ipHash?: string; now: number;
  }): void;
  /** since 뒤의 실패 수(같은 조건의 마지막 성공 뒤만 센다: 성공하면 셈이 다시 시작한다). */
  failuresSince(filter: AttemptFilter, since: number): number;
  insertRoute(input: { codeHash: string; tenantId: string; codeId: string; expiresAt: number; now: number }): void;
  /**
   * 매장의 epoch 기록(tenant_epochs): 매장 파일을 잃어도 control에 남아 되살릴 때 rev_floor(지금까지 본 가장 큰 rev + 1,000,000)를 셀 수
   * 있게 한다(data-model · sync 10-2). 같은 (매장, 번호)가 있으면 그대로 둔다.
   */
  recordEpoch(input: { tenantId: string; epochNo: number; epochId: string; now: number; revFloor?: number }): void;
  /** 매장의 지금 epoch 기록(없으면 undefined). */
  currentEpoch(tenantId: string): { epochNo: number; epochId: string; maxRevSeen: number; revFloor: number } | undefined;
  /** 본 rev를 올린다(백업 · 기기 보고): max_rev_seen = max(지금, rev). 그 epoch 행이 없으면 false. */
  raiseMaxRevSeen(tenantId: string, epochId: string, rev: number): boolean;
  route(codeHash: string): EnrollmentRoute | undefined;
  claimRoute(codeHash: string, now: number): void;
  useRoute(codeHash: string, now: number): void;
}

const tenantOf = (r: Row): Tenant => ({
  id: str(r.id), code: str(r.code), name: str(r.name), dataLocation: str(r.data_location), status: str(r.status_key), isTest: num(r.is_test) === 1,
});
const accountOf = (r: Row): Account => ({
  id: str(r.id), loginRealm: str(r.login_realm), ...(text(r.login_id) !== undefined ? { loginId: str(r.login_id) } : {}), displayName: str(r.display_name),
  ...(text(r.pin_hash) !== undefined ? { pinHash: str(r.pin_hash) } : {}), pinFailedCount: num(r.pin_failed_count), status: str(r.status_key),
  ...(text(r.last_login_at) !== undefined ? { lastLoginAt: msOf(str(r.last_login_at)) } : {}),
});
const sessionOf = (r: Row): Session => ({
  id: str(r.id), kind: 'staff', accountId: str(r.account_id), tenantId: str(r.tenant_id), deviceId: str(r.device_id), staffMemberId: str(r.staff_member_id),
  createdAt: msOf(str(r.created_at)), lastUsedAt: msOf(str(r.last_used_at)), idleTimeoutS: num(r.idle_timeout_s), expiresAt: msOf(str(r.expires_at)),
  ...(text(r.revoked_at) !== undefined ? { revokedAt: msOf(str(r.revoked_at)) } : {}),
  ...(text(r.revoke_reason) !== undefined ? { revokeReason: str(r.revoke_reason) } : {}),
});
const routeOf = (r: Row): EnrollmentRoute => ({
  codeHash: str(r.code_hash), tenantId: str(r.tenant_id), codeId: str(r.code_id), expiresAt: msOf(str(r.expires_at)),
  ...(text(r.claimed_at) !== undefined ? { claimedAt: msOf(str(r.claimed_at)) } : {}),
  ...(text(r.used_at) !== undefined ? { usedAt: msOf(str(r.used_at)) } : {}),
});

/** 1분(세션 마지막 사용 시각을 이보다 자주 쓰지 않는다). */
const TOUCH_EVERY_MS = 60_000;

/** 쓰는 트랜잭션 하나. control 파일은 매장 파일과 따로 잠근다. */
function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 이미 끝남
    }
    throw error;
  }
}

export function openControlStore(db: Db): ControlStore {
  const store: ControlStore = {
    provisionTenant(input, now) {
      const at = isoOf(now);
      return tx(db, () => {
        if (store.tenant(input.shopId)) throw new StoreError('ALREADY_PROVISIONED', '이미 있는 매장: ' + input.shopId);
        insert(db, 'tenants', {
          id: input.shopId, code: input.code, name: input.name, data_location: 'sqlite:shop-' + input.shopId + '.sqlite', is_test: input.isTest, created_at: at, updated_at: at,
        });
        const start = num(one(db, 'SELECT count(*) AS n FROM accounts WHERE login_realm = ?', input.code)?.n);
        const accountIds = input.staff.map((s, i) => {
          const id = ulid(now);
          insert(db, 'accounts', {
            id, login_realm: input.code, login_id: 'staff-' + (start + i + 1), display_name: s.displayName, pin_hash: s.pinHash, must_change_password: false,
            status_key: 'active', created_at: at, updated_at: at,
          });
          insert(db, 'account_tenants', { account_id: id, tenant_id: input.shopId, status_key: 'active', updated_at: at });
          return id;
        });
        return { accountIds };
      });
    },
    tenant(id) {
      const r = one(db, 'SELECT * FROM tenants WHERE id = ?', id);
      return r && tenantOf(r);
    },
    tenantByCode(code) {
      const r = one(db, 'SELECT * FROM tenants WHERE code = ?', code);
      return r && tenantOf(r);
    },
    account(id) {
      const r = one(db, 'SELECT * FROM accounts WHERE id = ?', id);
      return r && accountOf(r);
    },
    accountsOf(tenantId) {
      return all(db, "SELECT a.* FROM accounts a JOIN account_tenants t ON t.account_id = a.id WHERE t.tenant_id = ? AND t.status_key = 'active' ORDER BY a.rowid", tenantId).map(accountOf);
    },
    setPinHash(accountId, pinHash, now) {
      run(db, 'UPDATE accounts SET pin_hash = ?, pin_failed_count = 0, pin_locked_until = NULL, updated_at = ?, version = version + 1 WHERE id = ?', pinHash, isoOf(now), accountId);
    },
    loginSucceeded(accountId, now) {
      run(db, 'UPDATE accounts SET last_login_at = ?, pin_failed_count = 0, updated_at = ? WHERE id = ?', isoOf(now), isoOf(now), accountId);
    },
    loginFailed(accountId, now) {
      run(db, 'UPDATE accounts SET pin_failed_count = pin_failed_count + 1, updated_at = ? WHERE id = ?', isoOf(now), accountId);
      return num(one(db, 'SELECT pin_failed_count FROM accounts WHERE id = ?', accountId)?.pin_failed_count);
    },
    createSession(input) {
      const id = ulid(input.now);
      const at = isoOf(input.now);
      insert(db, 'sessions', {
        id, token_hash: input.tokenHash, kind_key: 'staff', account_id: input.accountId, tenant_id: input.tenantId, device_id: input.deviceId,
        staff_member_id: input.staffMemberId, created_at: at, last_used_at: at, idle_timeout_s: input.idleTimeoutS, expires_at: isoOf(input.expiresAt),
        ip_hash: input.ipHash, user_agent: input.userAgent?.slice(0, 120),
      });
      return store.session(id)!;
    },
    sessionByTokenHash(tokenHash) {
      const r = one(db, 'SELECT * FROM sessions WHERE token_hash = ?', tokenHash);
      return r && sessionOf(r);
    },
    session(id) {
      const r = one(db, 'SELECT * FROM sessions WHERE id = ?', id);
      return r && sessionOf(r);
    },
    touchSession(id, now) {
      const r = run(db, 'UPDATE sessions SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL AND last_used_at <= ?', isoOf(now), id, isoOf(now - TOUCH_EVERY_MS));
      return Number(r.changes) > 0;
    },
    revokeSession(id, reason, now) {
      const r = run(db, 'UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL', isoOf(now), reason, id);
      return Number(r.changes) > 0;
    },
    revokeDeviceSessions(tenantId, deviceId, reason, now) {
      const r = run(db, 'UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE tenant_id = ? AND device_id = ? AND revoked_at IS NULL', isoOf(now), reason, tenantId, deviceId);
      return Number(r.changes);
    },
    openSessionsOfDevice(tenantId, deviceId, now) {
      return all(db, 'SELECT * FROM sessions WHERE tenant_id = ? AND device_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at', tenantId, deviceId, isoOf(now)).map(sessionOf);
    },
    recordAttempt(input) {
      insert(db, 'login_attempts', {
        login_id: input.loginId, account_id: input.accountId, tenant_id: input.tenantId, device_id: input.deviceId, method_key: input.method,
        succeeded: input.succeeded, reason_key: input.reason, ip_hash: input.ipHash, at: isoOf(input.now),
      });
    },
    failuresSince(filter, since) {
      const where: string[] = [];
      const params: InValue[] = [];
      for (const [col, value] of [['account_id', filter.accountId], ['device_id', filter.deviceId], ['ip_hash', filter.ipHash], ['method_key', filter.method]] as const) {
        if (value === undefined) continue;
        where.push(col + ' = ?');
        params.push(value);
      }
      const cond = where.length ? where.join(' AND ') + ' AND ' : '';
      const lastOk = text(one(db, 'SELECT max(at) AS at FROM login_attempts WHERE ' + cond + 'succeeded = 1', ...params)?.at);
      // 새 비밀번호(pin_reset)는 그 계정의 셈을 다시 시작한다(계정이 걸린 셈만: 기기 쉼은 기기의 일이다).
      const lastReset = filter.accountId !== undefined
        ? text(one(db, "SELECT max(at) AS at FROM login_attempts WHERE account_id = ? AND method_key = 'pin_reset'", filter.accountId)?.at)
        : undefined;
      const marks = [lastOk, lastReset].filter((x): x is string => x !== undefined).map(msOf);
      const from = Math.max(since, ...marks);
      return num(one(db, 'SELECT count(*) AS n FROM login_attempts WHERE ' + cond + 'succeeded = 0 AND at > ?', ...params, isoOf(from))?.n);
    },
    insertRoute(input) {
      insert(db, 'enrollment_routes', {
        code_hash: input.codeHash, tenant_id: input.tenantId, code_id: input.codeId, origin_key: 'shop', expires_at: isoOf(input.expiresAt), created_at: isoOf(input.now),
      });
    },
    route(codeHash) {
      const r = one(db, 'SELECT * FROM enrollment_routes WHERE code_hash = ?', codeHash);
      return r && routeOf(r);
    },
    recordEpoch(input) {
      tx(db, () => {
        if (one(db, 'SELECT 1 AS x FROM tenant_epochs WHERE tenant_id = ? AND epoch_no = ?', input.tenantId, input.epochNo)) return;
        insert(db, 'tenant_epochs', {
          tenant_id: input.tenantId, epoch_no: input.epochNo, epoch_id: input.epochId, started_at: isoOf(input.now), rev_floor: input.revFloor ?? 0, max_rev_seen: 0,
        });
      });
    },
    currentEpoch(tenantId) {
      const r = one(db, 'SELECT epoch_no, epoch_id, max_rev_seen, rev_floor FROM tenant_epochs WHERE tenant_id = ? ORDER BY epoch_no DESC LIMIT 1', tenantId);
      return r && { epochNo: num(r.epoch_no), epochId: str(r.epoch_id), maxRevSeen: num(r.max_rev_seen), revFloor: num(r.rev_floor) };
    },
    raiseMaxRevSeen(tenantId, epochId, rev) {
      return tx(db, () => Number(run(db, 'UPDATE tenant_epochs SET max_rev_seen = max(max_rev_seen, ?) WHERE tenant_id = ? AND epoch_id = ?', rev, tenantId, epochId).changes) > 0);
    },
    claimRoute(codeHash, now) {
      run(db, 'UPDATE enrollment_routes SET claimed_at = coalesce(claimed_at, ?) WHERE code_hash = ?', isoOf(now), codeHash);
    },
    useRoute(codeHash, now) {
      run(db, 'UPDATE enrollment_routes SET used_at = ?, claimed_at = coalesce(claimed_at, ?) WHERE code_hash = ? AND used_at IS NULL', isoOf(now), isoOf(now), codeHash);
    },
  };
  return store;
}

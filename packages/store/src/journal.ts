// 작업 기록(data-model 4-16, sync 1 · 3, plan §4-5): 명령 기록(command_log: 멱등 · 결과), 작업 기록(events: rev마다 한 줄, 해시
// 사슬), 개인정보(event_pii: 기록 줄은 이름 · 전화 · 자유 글 대신 참조만 갖고 값은 여기, 보관 기간 뒤 지움), 바뀐 행(change_log: 동기화
// 범위마다), 의도 표시(intent_marks: 충돌 확인), 확인 결과(integrity_findings).
// 지문(fingerprint)은 매장마다의 비밀 열쇠로 만든 HMAC이다: 맨 sha256이면 전화번호를 거꾸로 맞춰 볼 수 있다(sync 2).
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { AnyCommandEnvelope, CommandOutcome, CommandOutcomeKey } from '@skinote/contract';
import { addDays, canonicalJson, isoOf, ulid } from './ids.ts';
import { all, insert, num, one, run, str, text, type Db } from './db.ts';

/** 명령 본문에서 개인정보 · 자유 글로 보는 칸(값이 글이면 참조로 바꾼다). */
export const PII_KEYS: ReadonlySet<string> = new Set(['name', 'teamName', 'phone', 'note', 'reason', 'reasonNote', 'overrideReason', 'placeNote', 'memo']);

/** 개인정보를 뺀 본문과 뺀 값(경로 → 값). 뺀 자리는 { ref: 경로 }다. */
export function splitPii(value: unknown, path = ''): { clean: unknown; pii: Record<string, string> } {
  const pii: Record<string, string> = {};
  const walk = (v: unknown, at: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, at + '[' + i + ']'));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const here = at ? at + '.' + k : k;
        if (PII_KEYS.has(k) && typeof x === 'string') {
          pii[here] = x;
          out[k] = { ref: here };
        } else {
          out[k] = walk(x, here);
        }
      }
      return out;
    }
    return v;
  };
  return { clean: walk(value, path), pii };
}

/** 매장마다의 지문 열쇠: HKDF(SKINOTE_FINGERPRINT_KEY, 매장 id). */
export function shopFingerprintKey(secret: Uint8Array, shopId: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), 'skinote-fingerprint-v1|' + shopId, 32));
}

/** 명령 지문: HMAC(매장 열쇠, 정규 JSON {type, commandVersion, payload(개인정보는 참조)}). basis · 시각 · 요청번호는 넣지 않는다. */
export function fingerprintOf(key: Uint8Array, envelope: Pick<AnyCommandEnvelope, 'type' | 'commandVersion' | 'payload'>): string {
  const { clean } = splitPii(envelope.payload, 'payload');
  return createHmac('sha256', key).update(canonicalJson({ type: envelope.type, commandVersion: envelope.commandVersion, payload: clean })).digest('hex');
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// ── command_log ─────────────────────────────────────────────────────────────

export interface LogRow {
  requestId: string;
  fingerprint: string;
  status: CommandOutcomeKey;
  retryable: boolean;
  errorCode?: string;
  result?: CommandOutcome;
  appliedRev?: number;
  receivedAt: string;
}

export function readLog(db: Db, shopId: string, requestId: string): LogRow | undefined {
  const r = one(db, 'SELECT request_id, fingerprint, status_key, retryable, error_code, result_json, applied_rev, received_at FROM command_log WHERE shop_id = ? AND request_id = ?', shopId, requestId);
  if (!r) return undefined;
  return {
    requestId: str(r.request_id),
    fingerprint: str(r.fingerprint),
    status: str(r.status_key) as CommandOutcomeKey,
    retryable: num(r.retryable) === 1,
    ...(text(r.error_code) !== undefined ? { errorCode: str(r.error_code) } : {}),
    ...(text(r.result_json) !== undefined ? { result: JSON.parse(str(r.result_json)) as CommandOutcome } : {}),
    ...(r.applied_rev !== null ? { appliedRev: num(r.applied_rev) } : {}),
    receivedAt: str(r.received_at),
  };
}

/** 끝난 결과인지(같은 요청번호가 다시 오면 저장한 결과를 돌려준다). 다시 판단하는 것: retryable 거절과 멈춤(blocked). */
export const isFinal = (log: LogRow): boolean => !log.retryable && log.status !== 'blocked';

export interface LogWrite {
  requestId: string;
  actorKey: string;
  deviceId?: string;
  type: string;
  commandVersion: number;
  fingerprint: string;
  outcome: CommandOutcome;
  retryable: boolean;
  appliedRev?: number;
  basis?: { epoch: string; rev: number };
  dependsOn?: readonly string[];
  now: number;
}

/** 결과 보관 기간(retention.command_result_days 기본 90일). */
const RESULT_DAYS = 90;

/**
 * 명령 기록 한 줄: 처음이면 넣고, 다시 판단한 것이면 고친다(받은 시각은 그대로). command_log는 장부가 아니다. 이미 적용한 줄(applied ·
 * partially_applied · applied_rev 있음)은 고치지 않는다(false): 적은 명령을 실패로 덮으면 다시 보낸 요청이 두 번 적힌다.
 */
export function writeLog(db: Db, shopId: string, w: LogWrite, existing: LogRow | undefined): boolean {
  const at = isoOf(w.now);
  const fields = {
    status_key: w.outcome.outcome,
    retryable: w.retryable,
    error_code: w.outcome.error?.code,
    result_json: canonicalJson(w.outcome),
    result_expires_at: addDays(at.slice(0, 10), RESULT_DAYS) + at.slice(10),
    applied_rev: w.appliedRev,
    basis_epoch_id: w.basis?.epoch,
    basis_rev: w.basis?.rev,
    occurred_at: at,
    finished_at: at,
  };
  if (!existing) {
    insert(db, 'command_log', {
      shop_id: shopId, request_id: w.requestId, actor_key: w.actorKey, device_id: w.deviceId, command_type: w.type, command_version: w.commandVersion,
      fingerprint: w.fingerprint, ...fields, depends_on_json: JSON.stringify(w.dependsOn ?? []), time_source_key: 'server', received_at: at,
    });
    return true;
  }
  if (existing.appliedRev !== undefined || existing.status === 'applied' || existing.status === 'partially_applied') return false;
  run(db, `UPDATE command_log SET status_key = ?, retryable = ?, error_code = ?, result_json = ?, result_expires_at = ?, applied_rev = ?, basis_epoch_id = ?,
    basis_rev = ?, occurred_at = ?, finished_at = ? WHERE shop_id = ? AND request_id = ?`,
  fields.status_key, fields.retryable, fields.error_code, fields.result_json, fields.result_expires_at, fields.applied_rev, fields.basis_epoch_id,
  fields.basis_rev, fields.occurred_at, fields.finished_at, shopId, w.requestId);
  return true;
}

// ── events · event_pii ──────────────────────────────────────────────────────

export interface EventWrite {
  rev: number;
  epoch: string;
  requestId: string;
  actorKey: string;
  actorName: string;
  actorRoleKey?: string;
  deviceId?: string;
  type: string;
  commandVersion: number;
  engine: 'native' | 'import';
  aggregateType?: string;
  aggregateId?: string;
  /** 개인정보를 뺀 정규 명령(서버가 정한 값 포함). */
  command: unknown;
  result: unknown;
  pii: Record<string, string>;
  now: number;
  businessDate: string;
  imported?: boolean;
}

/** 개인정보 보관 기간(retention.event_pii_days 기본 30일). */
const PII_DAYS = 30;

/** 사슬의 한 줄 해시: sha256(앞 해시 ‖ 정규 [rev, 요청번호, 행위자, 명령, 명령 JSON, 결과 JSON, 개인정보 약속, 적은 시각]). */
export const eventHash = (prevHash: string, row: { rev: number; request_id: string; actor_key: string; command_type: string; command_json: string; result_json: string | null; pii_commitment: string | null; recorded_at: string }) =>
  sha256(prevHash + canonicalJson([row.rev, row.request_id, row.actor_key, row.command_type, row.command_json, row.result_json, row.pii_commitment, row.recorded_at]));

/** 작업 기록 한 줄(+ 개인정보가 있으면 event_pii). 돌려주는 것: 이 줄의 해시. */
export function appendEvent(db: Db, shopId: string, e: EventWrite): string {
  const at = isoOf(e.now);
  const prevHash = text(one(db, 'SELECT hash FROM events WHERE shop_id = ? ORDER BY rev DESC LIMIT 1', shopId)?.hash) ?? '';
  const hasPii = Object.keys(e.pii).length > 0;
  const salt = hasPii ? randomBytes(16).toString('hex') : '';
  const piiJson = hasPii ? canonicalJson(e.pii) : null;
  const row = {
    rev: e.rev, request_id: e.requestId, actor_key: e.actorKey, command_type: e.type, command_json: canonicalJson(e.command), result_json: canonicalJson(e.result),
    pii_commitment: piiJson === null ? null : sha256(salt + piiJson), recorded_at: at,
  };
  const hash = eventHash(prevHash, row);
  insert(db, 'events', {
    shop_id: shopId, ...row, epoch_id: e.epoch, actor_name: e.actorName, actor_role_key: e.actorRoleKey, device_id: e.deviceId, command_version: e.commandVersion,
    engine_key: e.engine, aggregate_type: e.aggregateType, aggregate_id: e.aggregateId, occurred_at: at, business_date: e.businessDate, imported: e.imported ?? false,
    prev_hash: prevHash, hash,
  });
  if (piiJson !== null) insert(db, 'event_pii', { shop_id: shopId, rev: e.rev, salt, pii_json: piiJson, purge_after: addDays(at.slice(0, 10), PII_DAYS) + at.slice(10) });
  return hash;
}

/** 사슬 확인: 줄마다 앞 해시와 이 줄 해시를 다시 센다. 처음 어긋난 rev(없으면 null). */
export function verifyChain(db: Db, shopId: string): { rows: number; brokenAt: number | null } {
  let prev = '';
  const rows = all(db, 'SELECT rev, request_id, actor_key, command_type, command_json, result_json, pii_commitment, recorded_at, prev_hash, hash FROM events WHERE shop_id = ? ORDER BY rev', shopId);
  for (const r of rows) {
    const expect = eventHash(prev, {
      rev: num(r.rev), request_id: str(r.request_id), actor_key: str(r.actor_key), command_type: str(r.command_type), command_json: str(r.command_json),
      result_json: text(r.result_json) ?? null, pii_commitment: text(r.pii_commitment) ?? null, recorded_at: str(r.recorded_at),
    });
    if (r.prev_hash !== prev || r.hash !== expect) return { rows: rows.length, brokenAt: num(r.rev) };
    prev = str(r.hash);
  }
  return { rows: rows.length, brokenAt: null };
}

// ── change_log · intent_marks · integrity_findings ──────────────────────────

export interface ChangeEntry {
  scope: string;
  entityType: string;
  entityId: string;
  op?: 'upsert' | 'tombstone';
  aggregateType?: string;
  aggregateId?: string;
}

/** 이 rev가 건드린 행(범위마다). 같은 (범위, 표, id)는 한 번. */
export function appendChanges(db: Db, shopId: string, rev: number, entries: readonly ChangeEntry[]): number {
  const seen = new Set<string>();
  let seq = 0;
  for (const e of entries) {
    const key = e.scope + '|' + e.entityType + '|' + e.entityId;
    if (seen.has(key)) continue;
    seen.add(key);
    insert(db, 'change_log', {
      shop_id: shopId, rev, seq: (seq += 1), scope_key: e.scope, entity_type: e.entityType, entity_id: e.entityId, op_key: e.op ?? 'upsert',
      aggregate_type: e.aggregateType, aggregate_id: e.aggregateId,
    });
  }
  return seq;
}

export function markIntents(db: Db, shopId: string, rev: number, keys: readonly string[], now: number): void {
  for (const key of new Set(keys)) insert(db, 'intent_marks', { shop_id: shopId, conflict_key: key, rev, created_at: isoOf(now) });
}

/** 바탕(basis.rev) 뒤에 이 key들을 건드린 rev가 있는지(의도 명령의 충돌, D12). */
export function intentConflict(db: Db, shopId: string, keys: readonly string[], basisRev: number): boolean {
  for (const key of new Set(keys)) {
    if (one(db, 'SELECT 1 AS x FROM intent_marks WHERE shop_id = ? AND conflict_key = ? AND rev > ? LIMIT 1', shopId, key, basisRev)) return true;
  }
  return false;
}

/** 명령 종류의 충돌 부류(sys_event_types.class_key: fact · intent · commutative · system). */
export const eventClass = (db: Db, type: string): string | undefined => text(one(db, 'SELECT class_key FROM sys_event_types WHERE key = ?', type)?.class_key);

export function recordFinding(db: Db, shopId: string, f: { checkKey: string; entityType?: string; entityId?: string; expected?: unknown; actual?: unknown; now: number }): void {
  insert(db, 'integrity_findings', {
    shop_id: shopId, id: ulid(f.now), run_id: 'command:' + (f.entityId ?? ''), check_key: f.checkKey, entity_type: f.entityType, entity_id: f.entityId,
    expected_json: f.expected === undefined ? undefined : canonicalJson(f.expected), actual_json: f.actual === undefined ? undefined : canonicalJson(f.actual), found_at: isoOf(f.now),
  });
}

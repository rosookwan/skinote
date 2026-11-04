// 기사 기기의 연결 끊김 기록(work/impl-offline/plan.md §4, ADR-22): 보냄 대기 명령의 서명 · 묶음 보내기 · 사본 받기 · 심장 박동 · 세션 없는
// 전달 · 마감 승인의 형식과 한도. 기사 기기(apps/pos의 local/)와 서버(packages/server의 offline.js)가 이 형식만 본다.
//   - 보냄 대기 명령은 기기 열쇠로 보낼 때 서명한다: `skinote-cmd-v1|<origin>|<deviceId>|<deviceSeq>|<항목 해시>`. 항목 해시 =
//     b64url(sha256(UTF-8 canonicalJson(항목에서 recordedBy.signature를 뺀 것))). 서버는 받은 그대로의 항목을 검사 전에 해시한다(O5).
//   - 앞마디(skinote-cmd-v1)가 로그인 서명(skinote-login-v1)과 달라 한 열쇠의 두 쓰임이 섞이지 않는다.
//   - 개인정보는 주소에 싣지 않는다(모두 JSON POST). 기기가 알리는 것(DeviceReport)에는 개인정보가 없다.
import type { AnyCommandEnvelope, CommandOutcomeKey, CommandType, RecordedBy } from './client.ts';
import { COMMAND_TYPES, OFFLINE_COMMANDS } from './client.ts';
import { canonicalJson } from './canonical.ts';
import type { IsoTime } from './read-models.ts';

// ── 서명 ─────────────────────────────────────────────────────────────

/** 보냄 대기 명령 서명의 앞마디. */
export const COMMAND_CONTEXT = 'skinote-cmd-v1';
/** 세션 없는 전달(device/deliver) 서명의 앞마디. */
export const DELIVER_CONTEXT = 'skinote-deliver-v1';

/** 보냄 대기 명령의 서명 문장: `skinote-cmd-v1|<origin>|<deviceId>|<deviceSeq>|<항목 해시>`(UTF-8). */
export function commandMessage(origin: string, deviceId: string, deviceSeq: number, itemHash: string): string {
  return COMMAND_CONTEXT + '|' + origin + '|' + deviceId + '|' + deviceSeq + '|' + itemHash;
}

/** 세션 없는 전달의 서명 문장: `skinote-deliver-v1|<origin>|<deviceId>|<nonce>`. */
export function deliverMessage(origin: string, deviceId: string, nonce: string): string {
  return DELIVER_CONTEXT + '|' + origin + '|' + deviceId + '|' + nonce;
}

/**
 * 서명이 덮는 항목: 받은(또는 보낼) 항목에서 recordedBy.signature만 뺀 것. 다른 칸은 고치지 않는다(서버는 검사 · 정리 전의 값으로 센다).
 * 항목이 객체가 아니면 그대로.
 */
export function unsignedItem(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const { recordedBy, ...rest } = item as Record<string, unknown>;
  if (!recordedBy || typeof recordedBy !== 'object' || Array.isArray(recordedBy)) return recordedBy === undefined ? rest : { ...rest, recordedBy };
  const { signature: _signature, ...by } = recordedBy as Record<string, unknown>;
  return { ...rest, recordedBy: by };
}

/** 항목 해시에 넣는 글(정규 JSON). 해시(sha256 · base64url)는 부르는 쪽이 한다(서버 node:crypto, 기기 WebCrypto). */
export const itemHashInput = (item: unknown): string => canonicalJson(unsignedItem(item));

/** 바이트 → base64url(덧붙임 없음). */
export function base64Url(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 항목 해시(WebCrypto: 브라우저와 Node ≥ 22). 서버는 같은 값을 node:crypto로 센다(시험이 맞춘다). */
export async function itemHash(item: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(itemHashInput(item)));
  return base64Url(new Uint8Array(digest));
}

// ── 한도 ─────────────────────────────────────────────────────────────

/** 기기 연결 셈(O11): 심장 박동 간격, 끊김으로 보는 조용한 시간, 다시 연결로 보는 이어진 연결, 서버의 살피기 · 적기 간격. */
export const DEVICE_LINK = /* @__PURE__ */ Object.freeze({
  heartbeatMs: 20_000, offlineAfterMs: 60_000, recoverMs: 10_000, sweepMs: 10_000, persistEveryMs: 60_000, minHeartbeatMs: 1_500,
});
/** 묶음 보내기의 한도(O6). */
export const BATCH_LIMITS = /* @__PURE__ */ Object.freeze({ commands: 50, bodyBytes: 256 * 1024, itemBytes: 8 * 1024, ageMsMax: 366 * 86_400_000 });
/** 사본 받기의 한도(O4). */
export const SNAPSHOT_LIMITS = /* @__PURE__ */ Object.freeze({ pendingTaskIds: 300, onlinePending: 20, recorded: 1_000, bodyBytes: 32 * 1024, minGapMs: 2_000 });
/** 한 번에 알리는 빠진 번호 수(O9). */
export const MISSING_LIMIT = 50;

// ── 기기가 알리는 것 ───────────────────────────────────────────────────

/** 기사 기기가 심장 박동 · 사본 · 묶음 · 전달마다 알리는 것(개인정보 없음). */
export interface DeviceReport {
  /** 보냄 대기 + 보내는 중 + 결과 확인 중(답을 받은 것은 세지 않는다). */
  pendingCount: number;
  unconfirmedCount: number;
  /** 가장 오래된 대기 항목을 만든 때(서버 시각 짐작). */
  oldestPendingAt?: IsoTime;
  /** 이 기기가 준 가장 큰 기기 번호(처음이면 0). */
  lastSeq: number;
  /** 서버 시각 − 기기 시계(마지막 좋은 답 때, 처음이면 0). */
  clockOffsetMs: number;
  /** 앱 판(40자까지). */
  appVersion: string;
  /** persist() 허락 · 홈 화면 앱 · 서비스 워커가 맡은 화면(O16). */
  offlineCapable: boolean;
  /** 기기가 지금 쓰는 모드(O2). */
  localFirst: boolean;
  visibility: 'visible' | 'hidden';
  /** 열지 못한 봉인 기록 수(O13). */
  unreadable: number;
  /** 혼자 보내도 거절되는 항목의 번호(O6). */
  stuckSeq?: number;
  /** 기기가 가진 사본의 판. */
  copy?: { epoch: string; rev: number };
}

/** 차량의 연결(카운터의 읽기 모델): 기기 가운데 가장 나쁜 것(O11). */
export type VehicleLinkState = 'online' | 'stuck' | 'asleep' | 'offline' | 'idle';

export interface VehicleLink {
  vehicleId: string;
  state: VehicleLinkState;
  /** `21:40부터`의 때(O11). */
  since?: IsoTime;
  lastContactAt?: IsoTime;
  /** 기기가 알린 대기 수(null = 모름). */
  reportedPending: number | null;
  /** 상태를 정한 기기의 종류(줄의 `휴대폰` · `태블릿`). */
  deviceKind?: 'driver_phone' | 'driver_tablet';
}

/** 마감 명령에 서버가 적는 차량 연결 사실(O12: 정규 명령에 들어가 다시 실행해도 같다). */
export interface VehicleLinkFact {
  vehicleId: string;
  state: VehicleLinkState;
  since?: IsoTime;
  reportedPending: number | null;
  stuck?: boolean;
}

/** 번호 빈 곳(O9): 기기의 기록 가운데 서버가 받지 못한 것. */
export interface DeviceGap {
  deviceId: string;
  label: string;
  missing: number;
  since: IsoTime;
}

/** 서버가 기사 기기에 알리는 운영 값(offline_policy + 서버 스위치). */
export interface OfflinePolicy {
  localFirst: boolean;
  heartbeatMs: number;
  piiWipeHours: number;
  sentPiiHours: number;
  sentLogDays: number;
  appLockMinutes: number;
  maxBackdateHours: number;
  futureSkewMinutes: number;
  clockWarnMinutes: number;
}

// ── 보냄 대기 봉투 ───────────────────────────────────────────────────

/** 서명된 보냄 대기 봉투(§4-3): 온라인 봉투 + 기기 번호 · 나이 · 시계 기준 · 만든 때 · 서명한 행위자. */
export type QueuedEnvelope = AnyCommandEnvelope & {
  deviceSeq: number;
  ageMs: number;
  clockAnchor: string;
  madeAt: IsoTime;
  recordedBy: RecordedBy;
};

/** 시계 기준의 앞마디(O8): mono = 두 시계가 맞음, wall = 벽시계 나이(잠든 기기 · 앞 화면), jump = 벽시계가 뒤로 감(단조 시계 나이). */
export type ClockAnchorKind = 'mono' | 'wall' | 'jump';
export const CLOCK_ANCHOR_PATTERN = /^(mono|wall|jump)-[0-9A-Za-z]{8,32}$/;

/** 시계 기준 → command_log.time_source_key(monotonic · wall_clock). */
export function timeSourceOf(clockAnchor: string): 'monotonic' | 'wall_clock' {
  return clockAnchor.startsWith('wall-') ? 'wall_clock' : 'monotonic';
}

/** 기기 종류의 끊긴 채 넣을 수 있는 명령(시드 sys_offline_commands ∩ 명령 이름: vendor_refund.attempt · device.sign_in은 명령이 아니다). */
export function offlineCommandTypes(kind: 'pos' | 'driver_tablet' | 'driver_phone'): CommandType[] {
  const allowed = OFFLINE_COMMANDS[kind];
  return COMMAND_TYPES.filter((type) => allowed.includes(type));
}

// ── 사본 받기(POST api/v2/snapshot) ─────────────────────────────────────

export interface SnapshotRequest {
  /** 기기가 가진 사본(없으면 처음). */
  known?: { epoch: string; rev: number; hash: string; configRev: number };
  /** 기기가 아직 가진(답을 받지 않았거나 사본에 들지 않은) 가장 작은 기기 번호(없으면 1). */
  fromSeq: number;
  /** 보냄 대기 항목의 업무 id(옮겨진 업무도 사본에 남게, O4). */
  pendingTaskIds: string[];
  /** 답을 잃은 온라인 명령의 요청번호(O18). */
  onlinePending: string[];
  report: DeviceReport;
}

/** 이 기기의 기록 한 줄(사본과 같은 읽기에서 읽는다, O4). */
export interface RecordedItem {
  requestId: string;
  deviceSeq: number;
  outcome: CommandOutcomeKey;
  rev: number;
  reviews: string[];
  /** 결과의 오류 코드(있으면: 적지 않은 까닭 NOTHING_LEFT · 범위 밖 …). 기기의 줄 메모가 할 일 없는 기록에 메모를 달지 않게(§18 R4-14). 옛 서버는 없다. */
  errorCode?: string;
}

export interface SnapshotResponse {
  epoch: string;
  rev: number;
  configRev: number;
  linkRev: number;
  serverTime: IsoTime;
  currentBusinessDate: string;
  /**
   * 되살린 epoch의 기준 rev(shop_instance.restored_up_to_rev): 백업에서 되살린 매장만 수이고, 처음 만든 매장 · 시험 매장 새로 만들기는 null이다. 기기는
   * epoch가 바뀌었고 이 값이 수일 때만 옛 epoch의 보낸 기록을 다시 보낸다(O20 · §17 R3-1: 새로 만든 시험 매장에 옛 기록을 넣지 않게).
   */
  restoredUpToRev: number | null;
  policy: OfflinePolicy;
  scope: { vehicleId: string; businessDate: string; cutoff: string };
  hash: string;
  unchanged: boolean;
  /** 차량 범위의 ShopState(unchanged면 없음). 형식은 도메인의 것이라 여기서는 열어 둔다. */
  state?: Record<string, unknown>;
  /** 화면 설정(known.configRev와 다를 때만). */
  config?: unknown;
  recorded: RecordedItem[];
  recordedMore: boolean;
  onlineRecorded: { requestId: string; outcome: CommandOutcomeKey; rev: number }[];
  device: { highWater: number; missing: number[] };
}

// ── 묶음 보내기(POST api/v2/commands:batch) ─────────────────────────────

export interface BatchRequest {
  report: DeviceReport;
  commands: unknown[];
}

/** 묶음의 항목 하나의 결과(§4-4). */
export interface QueuedItemResult {
  requestId: string;
  deviceSeq: number;
  outcome: CommandOutcomeKey;
  rev: number;
  timeSource?: 'monotonic' | 'wall_clock';
  error?: { code: string; message: string };
  canonical?: Record<string, unknown>;
  /** 이 명령이 더한 확인 필요의 종류(문장 없음). */
  reviews: string[];
}

export interface BatchResponse {
  epoch: string;
  rev: number;
  configRev: number;
  linkRev: number;
  serverTime: IsoTime;
  /** 되살린 epoch의 기준 rev(되살린 매장만, 아니면 null, §17 R3-1). 옛 서버는 칸이 없다. */
  restoredUpToRev?: number | null;
  heartbeatMs: number;
  results: QueuedItemResult[];
  device: { highWater: number; missing: number[] };
}

// ── 세션 없는 전달(POST api/v2/device/deliver) ───────────────────────────

export interface DeliverRequest {
  deviceId: string;
  nonce: string;
  signature: string;
  report: DeviceReport;
  commands: unknown[];
}

export interface DeliverResponse extends Omit<BatchResponse, 'device'> {
  device: { highWater: number; missing: number[]; status: 'active' | 'revoked'; wipe: boolean };
}

// ── 심장 박동(POST api/v2/heartbeat) ──────────────────────────────────

export interface HeartbeatRequest {
  report: DeviceReport;
}

export interface HeartbeatResponse {
  epoch: string;
  rev: number;
  configRev: number;
  linkRev: number;
  heartbeatMs: number;
  serverTime: IsoTime;
  currentBusinessDate: string;
  restoredUpToRev: number | null;
  policy: OfflinePolicy;
}

// ── 마감 승인(POST api/v2/closing/approve) ─────────────────────────────

export interface ClosingApproveRequest {
  date: string;
  ownPin: string;
}

export interface ClosingApproveResponse {
  approvalId: string;
  expiresAt: IsoTime;
}

/** 마감 승인의 사유 길이(화면 키보드 `사유`). */
export const OVERRIDE_REASON_MAX = 20;

/** 서명된 보냄 대기 봉투인지(형식만: 검사는 parseQueuedEnvelope). */
export const isQueuedEnvelope = (envelope: AnyCommandEnvelope): envelope is QueuedEnvelope =>
  envelope.deviceSeq !== undefined && envelope.recordedBy !== undefined;

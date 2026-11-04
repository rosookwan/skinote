// 기억한 세션(work/impl-offline/plan.md O15 · §7-6): 기사 기기가 서버 없이 앱을 열어(산에서 새로 고침 · 앱을 다시 켬) 바로 목록으로 가게, 로그인한
// 세션의 서버 답(SessionInfo)을 사본 열쇠로 봉인해 둔다. 유효한지는 서버의 규칙을 따라 기기에서 센다(순수 함수, 시계가 뒤로 간 경우 포함):
//   - 세션의 끝(session.expiresAt, 서버 시각)과 쉬는 시간(마지막으로 사람이 한 일을 보낸 때 lastTouchAt + idleTimeoutS: 심장 박동 · 사본 받기는
//     쉬는 시간을 늘리지 않는다, 서버와 같음) 안.
//   - 사본의 24시간 창(마지막 연결 + pii_wipe_hours) 안, 읽을 수 있는 사본.
//   - 시계 톱니(O14 g): 벽시계가 본 가장 늦은 때보다 clock_warn_minutes 넘게 뒤면 끝난 것으로 본다.
//   - 앱 잠금(O15 d): 마지막 사용에서 app_lock_minutes가 지났으면 잠금(기사의 비밀번호를 기기에서 본다). 틀려서 잠긴 동안(lockUntil)은 그 시각까지
//     잠김(§17 R3-24).
// 끝났으면 앱은 기다리지 않고 평소처럼 서버에 묻는다(닿지 않으면 연결 끊김 화면에 `전송 대기 {n}`, 보냄 대기는 남는다).
import type { OfflinePolicy, SessionInfo } from '@skinote/contract';
import { lockDue, lockedUntil, MAX_PIN_FAILURES } from './app-lock.ts';

/** 기억한 세션 칸(사본 열쇠로 봉인, 'session' 저장소 id REMEMBERED_ID). */
export interface RememberedSession {
  fmt: 1;
  session: SessionInfo;
  /** 적은 때(기기 벽시계). */
  savedAt: number;
}

export const REMEMBERED_ID = 'remembered';
export const VERIFIER_ID = 'verifier';

export function isRemembered(value: unknown): value is RememberedSession {
  const v = value as Partial<RememberedSession> | null;
  const s = v?.session;
  return !!v && v.fmt === 1 && typeof v.savedAt === 'number' && !!s && typeof s.csrf === 'string' && !!s.staff && !!s.device && !!s.session
    && (s.device.kind === 'driver_phone' || s.device.kind === 'driver_tablet');
}

export type StartDecision = 'open' | 'locked' | 'expired' | 'none';

export interface RememberedInput {
  /** 지금(기기 벽시계). */
  now: number;
  record: RememberedSession | null;
  /** 사본을 읽을 수 있는지(판이 맞고 열쇠가 있음). */
  copyOk: boolean;
  /** 비밀번호 확인 값이 있는지(없으면 기기에서 잠금을 풀 수 없다: 서버에 묻는 길로). */
  verifier: boolean;
  meta: { lastContactAt?: number; lastTouchAt?: number; lastUseAt?: number; maxSeenWall?: number; clockOffsetMs: number; lockFailures?: number; lockUntil?: number };
  policy: Pick<OfflinePolicy, 'piiWipeHours' | 'appLockMinutes' | 'clockWarnMinutes'>;
}

export interface RememberedStart {
  decision: StartDecision;
  /** 끝난 까닭(시험 · 기록용, 화면에 쓰지 않는다). */
  why?: 'no_record' | 'no_copy' | 'no_verifier' | 'clock' | 'expired' | 'idle' | 'copy_window' | 'locked_out';
}

/**
 * 기억한 세션으로 서버 없이 열어도 되는지(순수). 세션 자체가 끝났는지(시계 · 끝 · 쉬는 시간 · 24시간 창)를 먼저 보고, 그다음 이 기기에서 열 수 있는지
 * (사본을 읽을 수 있음 · 확인 값 있음)를 본다: 켤 때의 지움 시계(boot.ts)는 앞의 까닭일 때만 지운다(§17-2 R3-9).
 */
export function rememberedStart(input: RememberedInput): RememberedStart {
  const { now, record, meta, policy } = input;
  if (!record) return { decision: 'none', why: 'no_record' };
  const warn = policy.clockWarnMinutes * 60_000;
  if (meta.maxSeenWall !== undefined && now < meta.maxSeenWall - warn) return { decision: 'expired', why: 'clock' };
  const session = record.session.session;
  const expiresAt = session ? Date.parse(session.expiresAt) : Number.NaN;
  // 세션의 끝은 서버 시각: 기기 벽시계 + 마지막으로 안 차이로 견준다.
  if (!Number.isFinite(expiresAt) || now + meta.clockOffsetMs >= expiresAt) return { decision: 'expired', why: 'expired' };
  const idleS = session?.idleTimeoutS ?? record.session.idleTimeoutS;
  const touched = meta.lastTouchAt ?? record.savedAt;
  if (idleS > 0 && now >= touched + idleS * 1000) return { decision: 'expired', why: 'idle' };
  const contact = meta.lastContactAt ?? record.savedAt;
  if (now >= contact + policy.piiWipeHours * 3_600_000) return { decision: 'expired', why: 'copy_window' };
  if (!input.copyOk) return { decision: 'expired', why: 'no_copy' };
  if (!input.verifier) return { decision: 'expired', why: 'no_verifier' };
  if (lockedUntil(now, meta) !== undefined) return { decision: 'locked', why: 'locked_out' };
  const failed = (meta.lockFailures ?? 0) >= MAX_PIN_FAILURES;
  return { decision: failed || lockDue(now, meta.lastUseAt, policy.appLockMinutes) ? 'locked' : 'open' };
}

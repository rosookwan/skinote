// 기기 등록 · 로그인 요청(계획 work/impl-server/plan.md 5-1 · 6-3). 로그인 전 길이라 CSRF 머리가 없다(서버는 Origin과 주소마다 제한으로
// 지킨다). 답은 { ok, value } 또는 실패의 상태 · 코드(연결 없음은 status 0, code NETWORK). 비밀값(등록 번호 · 비밀번호)은 본문에만 있고
// 기록 · 주소에 남기지 않는다. 등록 방법 묻기(GET)와 시험 매장의 열린 등록(종류 · 차량을 골라 스스로 등록), 스스로 붙은 기기의
// 놓기(서명, 204)도 여기 있다.
import {
  API_V2, enrollCodeDigits, isEnrollMode,
  type Challenge, type DeviceKind, type DevicePublicKey, type EnrolledDevice, type EnrollMode, type SessionInfo, type StaffList,
} from '@skinote/contract';
import { isSessionInfo } from './runtime.ts';

export type AuthAnswer<T> = { ok: true; value: T } | { ok: false; status: number; code: string; lockedUntil?: string };

export interface AuthApi {
  /** 등록 방법(번호 · 열린 등록과 차량). 로그인 전 · 기기 없이 묻는다. */
  enrollMode(): Promise<AuthAnswer<EnrollMode>>;
  /** 열린 등록(시험 매장): 카운터는 차량 없이, 기사 기기는 차량과 함께. */
  openEnroll(kind: DeviceKind, vehicleId: string | undefined, publicKey: DevicePublicKey, agent: string): Promise<AuthAnswer<EnrolledDevice>>;
  enroll(code: string, publicKey: DevicePublicKey, agent: string): Promise<AuthAnswer<EnrolledDevice>>;
  challenge(deviceId: string): Promise<AuthAnswer<Challenge>>;
  staff(deviceId: string, nonce: string, signature: string): Promise<AuthAnswer<StaffList>>;
  login(ticket: string, staffId: string, pin: string): Promise<AuthAnswer<SessionInfo>>;
  /** 스스로 붙은 기기가 자기 등록을 끊는다(열린 등록이 켜진 동안만, 로그인과 같은 서명). 됨은 204(값 없음). */
  openRelease(deviceId: string, nonce: string, signature: string): Promise<AuthAnswer<null>>;
}

const TIMEOUT_MS = 10_000;

/** 기기가 말한 모양(승인 기록에만, 80자까지, 제어 문자 · '<' 없음). */
export function deviceAgent(userAgent: string): string {
  return userAgent.replace(/[\p{Cc}<]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'browser';
}

export function createAuthApi(baseUrl: string, fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)): AuthApi {
  const send = async <T>(path: string, body: unknown, accept: (value: unknown) => value is T, okStatus = 200): Promise<AuthAnswer<T>> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(new URL(path, baseUrl).href, body === undefined
        ? { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: abort.signal, headers: { accept: 'application/json' } }
        : {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
        });
      const json = /application\/json/.test(res.headers.get('content-type') ?? '');
      const value: unknown = json ? await res.json().catch(() => undefined) : undefined;
      if (res.status === okStatus && okStatus === 204) return { ok: true, value: null as T };
      if (res.status === okStatus && accept(value)) return { ok: true, value };
      const fields = value && typeof value === 'object' ? (value as { code?: unknown; lockedUntil?: unknown; service?: unknown }) : {};
      // 우리 서버의 실패 답이 아니면(앞단의 오류 쪽) 연결 문제로 본다.
      const code = fields.service === 'skinote' && typeof fields.code === 'string' ? fields.code : 'NETWORK';
      return { ok: false, status: res.status, code, ...(typeof fields.lockedUntil === 'string' ? { lockedUntil: fields.lockedUntil } : {}) };
    } catch {
      return { ok: false, status: 0, code: 'NETWORK' };
    } finally {
      clearTimeout(timer);
    }
  };
  const post = <T>(path: string, body: unknown, accept: (value: unknown) => value is T) => send(path, body, accept);
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
  const isDevice = (v: unknown): v is EnrolledDevice => isObject(v) && typeof v.deviceId === 'string' && typeof v.kind === 'string' && typeof v.label === 'string';
  return {
    enrollMode: () => send(API_V2.enrollMode, undefined, isEnrollMode),
    openEnroll: (kind, vehicleId, publicKey, agent) =>
      post(API_V2.openEnroll, { kind, ...(vehicleId !== undefined ? { vehicleId } : {}), publicKey, agent: deviceAgent(agent) }, isDevice),
    enroll: (code, publicKey, agent) => post(API_V2.enroll, { code: enrollCodeDigits(code), publicKey, agent: deviceAgent(agent) }, isDevice),
    challenge: (deviceId) => post(API_V2.challenge, { deviceId }, (v): v is Challenge => isObject(v) && typeof v.nonce === 'string'),
    staff: (deviceId, nonce, signature) => post(API_V2.staff, { deviceId, nonce, signature },
      (v): v is StaffList => isObject(v) && typeof v.ticket === 'string' && Array.isArray(v.staff) && typeof v.shopName === 'string'),
    login: (ticket, staffId, pin) => post(API_V2.login, { ticket, staffId, pin }, isSessionInfo),
    openRelease: (deviceId, nonce, signature) => send(API_V2.openRelease, { deviceId, nonce, signature }, (v): v is null => v === null, 204),
  };
}

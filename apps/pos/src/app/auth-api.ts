// 기기 등록 · 로그인 요청(계획 work/impl-server/plan.md 5-1 · 6-3). 로그인 전 길이라 CSRF 머리가 없다(서버는 Origin과 주소마다 제한으로
// 지킨다). 답은 { ok, value } 또는 실패의 상태 · 코드(연결 없음은 status 0, code NETWORK). 비밀값(등록 번호 · 비밀번호)은 본문에만 있고
// 기록 · 주소에 남기지 않는다.
import {
  API_V2, enrollCodeDigits,
  type Challenge, type DevicePublicKey, type EnrolledDevice, type SessionInfo, type StaffList,
} from '@skinote/contract';
import { isSessionInfo } from './runtime.ts';

export type AuthAnswer<T> = { ok: true; value: T } | { ok: false; status: number; code: string; lockedUntil?: string };

export interface AuthApi {
  enroll(code: string, publicKey: DevicePublicKey, agent: string): Promise<AuthAnswer<EnrolledDevice>>;
  challenge(deviceId: string): Promise<AuthAnswer<Challenge>>;
  staff(deviceId: string, nonce: string, signature: string): Promise<AuthAnswer<StaffList>>;
  login(ticket: string, staffId: string, pin: string): Promise<AuthAnswer<SessionInfo>>;
}

const TIMEOUT_MS = 10_000;

/** 기기가 말한 모양(승인 기록에만, 80자까지, 제어 문자 · '<' 없음). */
export function deviceAgent(userAgent: string): string {
  return userAgent.replace(/[\p{Cc}<]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'browser';
}

export function createAuthApi(baseUrl: string, fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)): AuthApi {
  const post = async <T>(path: string, body: unknown, accept: (value: unknown) => value is T): Promise<AuthAnswer<T>> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(new URL(path, baseUrl).href, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
      });
      const json = /application\/json/.test(res.headers.get('content-type') ?? '');
      const value: unknown = json ? await res.json().catch(() => undefined) : undefined;
      if (res.status === 200 && accept(value)) return { ok: true, value };
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
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
  return {
    enroll: (code, publicKey, agent) => post(API_V2.enroll, { code: enrollCodeDigits(code), publicKey, agent: deviceAgent(agent) },
      (v): v is EnrolledDevice => isObject(v) && typeof v.deviceId === 'string' && typeof v.kind === 'string' && typeof v.label === 'string'),
    challenge: (deviceId) => post(API_V2.challenge, { deviceId }, (v): v is Challenge => isObject(v) && typeof v.nonce === 'string'),
    staff: (deviceId, nonce, signature) => post(API_V2.staff, { deviceId, nonce, signature },
      (v): v is StaffList => isObject(v) && typeof v.ticket === 'string' && Array.isArray(v.staff) && typeof v.shopName === 'string'),
    login: (ticket, staffId, pin) => post(API_V2.login, { ticket, staffId, pin }, isSessionInfo),
  };
}

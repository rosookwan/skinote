// 앱 잠금(work/impl-offline/plan.md O15 d · §7-6, sync 7 `끊긴 동안`): 개인 휴대폰을 잃었을 때 끊긴 채로 손님 이름 · 번호를 보지 못하게, 앱이 켜지거나
// 뒤에서 돌아올 때 마지막 사용에서 `app_lock_minutes`(휴대폰 5분 · 태블릿 30분, 매장 설정)가 지났으면 기억한 기사의 비밀번호를 기기에서 다시 본다.
//   - 확인 값: 마지막 온라인 로그인 때 기사가 친 비밀번호로 만든 PBKDF2-SHA-256(무작위 소금 16바이트, 310,000번). 비밀번호 자체는 남기지 않는다.
//     확인 값은 사본 열쇠로 봉인한다(local-store writeSessionRecord: 로그아웃 · 401 · 끊은 기기에서 사본과 함께 지워진다).
//   - 다섯 번 틀릴 때마다 잠긴다(5분, 다음은 10 · 20 …분, 24시간까지): `로그인 잠김 · {시각} 이후 가능`(3-17), 그동안 숫자 키를 누를 수 없다. 기억한
//     세션은 지우지 않는다(산에서 신호가 없어도 목록 · 번호로 돌아올 수 있게, §17 R3-24). 연결되어 있으면 평소 로그인(서버 비밀번호 · 서버의 잠김)도 된다.
//     시계를 뒤로 돌리면 기억한 세션이 끝난 것으로 보고(시계 톱니) 온라인 로그인으로 간다.
//   - 확인 값은 기사 역할만 만든다(§17 R3-11): 다른 역할(임시 차량을 맡은 카운터 · 관리자)은 기기에서 풀 수 없어 온라인 로그인이다.
// 순수 함수와 WebCrypto만 쓴다(시험은 적은 반복 수).

/** 기억한 기사의 비밀번호 확인 값(봉인해 둔다). */
export interface PinVerifier {
  fmt: 1;
  staffId: string;
  /** base64(16바이트). */
  salt: string;
  iterations: number;
  /** base64(PBKDF2 256비트). */
  hash: string;
}

export const PIN_ITERATIONS = 310_000;
/** 이만큼 틀릴 때마다 잠근다. */
export const MAX_PIN_FAILURES = 5;
/** 첫 잠김(분)과 가장 긴 잠김(분). 다섯 번 더 틀릴 때마다 두 배. */
export const LOCKOUT_BASE_MINUTES = 5;
export const LOCKOUT_MAX_MINUTES = 24 * 60;

/** 연달아 틀린 수 → 이번에 걸 잠김(분). 다섯의 배수가 아니면 0(§17 R3-24). */
export function lockoutMinutes(failures: number): number {
  if (failures < MAX_PIN_FAILURES || failures % MAX_PIN_FAILURES !== 0) return 0;
  return Math.min(LOCKOUT_MAX_MINUTES, LOCKOUT_BASE_MINUTES * 2 ** (failures / MAX_PIN_FAILURES - 1));
}

/** 걸려 있는 잠김이 풀리는 때(없거나 지났으면 undefined). */
export function lockedUntil(now: number, meta: { lockUntil?: number }): number | undefined {
  return meta.lockUntil !== undefined && now < meta.lockUntil ? meta.lockUntil : undefined;
}

const b64 = (bytes: Uint8Array): string => {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
};
const unb64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number, subtle: SubtleCrypto): Promise<Uint8Array> {
  const base = await subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
  return new Uint8Array(bits);
}

/** 비밀번호의 확인 값을 만든다(온라인 로그인이 된 바로 뒤, 비밀번호가 메모리에 있는 그때만). */
export async function createVerifier(pin: string, staffId: string, iterations = PIN_ITERATIONS, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<PinVerifier> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, iterations, subtle);
  return { fmt: 1, staffId, salt: b64(salt), iterations, hash: b64(hash) };
}

/** 친 비밀번호가 맞는지(같은 길이의 모든 바이트를 본다: 틀린 자리에 따라 시간이 달라지지 않게). */
export async function checkPin(verifier: PinVerifier, pin: string, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<boolean> {
  if (!/^\d{4,6}$/.test(pin)) return false;
  const got = await derive(pin, unb64(verifier.salt), verifier.iterations, subtle);
  const want = unb64(verifier.hash);
  let diff = got.length ^ want.length;
  for (let i = 0; i < Math.max(got.length, want.length); i += 1) diff |= (got[i] ?? 0) ^ (want[i] ?? 0);
  return diff === 0;
}

/** 확인 값 모양이 맞는지(봉인에서 꺼낸 값). */
export function isVerifier(value: unknown): value is PinVerifier {
  const v = value as Partial<PinVerifier> | null;
  return !!v && v.fmt === 1 && typeof v.staffId === 'string' && typeof v.salt === 'string' && typeof v.hash === 'string'
    && typeof v.iterations === 'number' && v.iterations >= 1;
}

/**
 * 잠글 때인지(순수): 마지막 사용(lastUseAt, 기기 벽시계)에서 minutes가 지났으면. 벽시계가 뒤로 갔으면(마지막 사용보다 이르면) 잠근다(시계를 돌려
 * 잠금을 피하지 못하게). 마지막 사용을 모르면 잠근다.
 */
export function lockDue(now: number, lastUseAt: number | undefined, minutes: number): boolean {
  if (lastUseAt === undefined) return true;
  if (now < lastUseAt) return true;
  return now - lastUseAt >= Math.max(0, minutes) * 60_000;
}

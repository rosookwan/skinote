// 봉인(work/impl-offline/plan.md O13): 기기에 두는 사본 · 보냄 대기 · 보낸 기록 · 기억한 세션의 본문은 꺼낼 수 없는 AES-GCM 256 열쇠로 봉인한다.
// 봉인 하나 = { keyId, iv(12바이트, 매번 새로), body }. 덧붙인 글(AAD) `<종류>|<키>|<keyId>`가 봉인을 그 자리에 묶는다: 다른 칸 · 다른 열쇠의
// 봉인으로 바꿔 넣으면 열리지 않는다. 보냄 대기와 보낸 기록은 같은 기록의 두 때라 종류가 'command' 하나다(옮길 때 다시 봉인하지 않고 한
// 트랜잭션으로 옮긴다, 계획의 `store|primaryKey|keyId`에서 바꾼 점 · §15).
// 열쇠를 지우면(crypto-shredding) 남은 봉인은 누구도 열 수 없다: 브라우저가 줄 수 있는 유일한 진짜 지움이다.

export interface Sealed {
  keyId: string;
  iv: Uint8Array;
  body: Uint8Array;
}

/** 봉인을 열 수 없음(열쇠가 없음 · 다른 자리의 봉인 · 깨진 값). 기기는 센다(DeviceReport.unreadable). */
export class Unreadable extends Error {
  constructor(what: string) {
    super('unreadable: ' + what);
    this.name = 'Unreadable';
  }
}

/** 덧붙인 글: 봉인의 종류 · 칸의 키 · 열쇠 id. */
export const sealContext = (kind: 'command' | 'snapshot' | 'session' | 'online', key: string, keyId: string): string => kind + '|' + key + '|' + keyId;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 새 봉인 열쇠(꺼낼 수 없음). */
export function newSealKey(subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<CryptoKey> {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

/** 값(JSON)을 봉인한다. */
export async function seal(key: CryptoKey, keyId: string, context: string, value: unknown, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<Sealed> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(JSON.stringify(value));
  const body = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, data);
  return { keyId, iv, body: new Uint8Array(body) };
}

/** 봉인을 연다. 열쇠가 다르거나 자리가 다르면 Unreadable. */
export async function unseal<T>(key: CryptoKey, sealed: Sealed, context: string, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<T> {
  let plain: ArrayBuffer;
  try {
    plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(sealed.iv), additionalData: encoder.encode(context) },
      key,
      new Uint8Array(sealed.body),
    );
  } catch {
    throw new Unreadable(context);
  }
  try {
    return JSON.parse(decoder.decode(plain)) as T;
  } catch {
    throw new Unreadable(context);
  }
}

/** 칸이 봉인 모양인지(keyId · iv · body). */
export function isSealed(value: unknown): value is Sealed {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Sealed>;
  return typeof v.keyId === 'string' && v.iv instanceof Uint8Array && v.body instanceof Uint8Array;
}

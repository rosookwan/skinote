// 기기 열쇠(계획 work/impl-server/plan.md D6 · 6-3). 기기를 등록할 때 WebCrypto ECDSA P-256 열쇠 쌍을 만들고(비밀 열쇠는 꺼낼 수
// 없음), 공개 열쇠만 서버에 보낸다. 로그인할 때마다 서버의 한 번 값에 `skinote-login-v1|<앱 주소>|<기기 id>|<한 번 값>`으로 서명한다
// (앞마디가 있어 같은 열쇠가 나중에 보냄 대기 명령에 서명해도 헷갈리지 않는다).
// 등록한 기기(id · 종류 · 이름 · 차량)와 열쇠 쌍은 IndexedDB `skinote-device`에 둔다(CryptoKey는 구조화 복사로 그대로 들어간다).
// 서버가 모르는 기기(404 DEVICE_UNKNOWN)이거나 끊은 기기(401 DEVICE_REVOKED)면 지우고 다시 등록한다.
import { loginMessage, type DevicePublicKey, type EnrolledDevice } from '@skinote/contract';

/** 이 기기에 둔 등록(열쇠 쌍 포함). */
export interface StoredDevice extends EnrolledDevice {
  keyPair: CryptoKeyPair;
}

/** 등록을 두는 곳(브라우저는 IndexedDB, 시험은 메모리). */
export interface DeviceKeyStore {
  load(): Promise<StoredDevice | null>;
  save(device: StoredDevice): Promise<void>;
  forget(): Promise<void>;
}

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** base64url(끝 = 없음). */
export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = '';
  for (const b of view) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 새 열쇠 쌍: 비밀 열쇠는 꺼낼 수 없다(extractable false). 공개 열쇠는 언제나 꺼낼 수 있다(WebCrypto). */
export function newDeviceKeyPair(subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<CryptoKeyPair> {
  return subtle.generateKey(ALGORITHM, false, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

/** 서버에 보낼 공개 열쇠(JWK의 kty · crv · x · y만). */
export async function publicJwk(pair: CryptoKeyPair, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<DevicePublicKey> {
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('P-256 공개 열쇠가 아니다');
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/** 로그인 서명: loginMessage(앱 주소, 기기 id, 한 번 값)의 ECDSA P-256 SHA-256 서명(r ‖ s 64바이트, base64url 86자). */
export async function signLogin(privateKey: CryptoKey, origin: string, deviceId: string, nonce: string, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
  const data = new TextEncoder().encode(loginMessage(origin, deviceId, nonce));
  return base64url(await subtle.sign(SIGN, privateKey, data));
}

/** 메모리에 두는 곳(시험 · IndexedDB가 없는 브라우저의 이번 창). */
export function memoryDeviceStore(initial: StoredDevice | null = null): DeviceKeyStore {
  let current = initial;
  return {
    load: () => Promise.resolve(current),
    save: (device) => { current = device; return Promise.resolve(); },
    forget: () => { current = null; return Promise.resolve(); },
  };
}

const DB_NAME = 'skinote-device';
const STORE = 'device';
const KEY = 'current';

/** IndexedDB에 두는 곳. 열지 못하면(사생활 창 등) 던진다: 부르는 쪽이 메모리로 바꾼다. */
export function indexedDbDeviceStore(idb: IDBFactory = globalThis.indexedDB): DeviceKeyStore {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
  });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB'));
      });
    } finally {
      db.close();
    }
  };
  return {
    load: async () => {
      const value = await run<unknown>('readonly', (store) => store.get(KEY));
      return isStoredDevice(value) ? value : null;
    },
    save: async (device) => { await run('readwrite', (store) => store.put(device, KEY)); },
    forget: async () => { await run('readwrite', (store) => store.delete(KEY)); },
  };
}

/** 두었던 것이 등록 모양인지(옛 판 · 깨진 값은 없는 것으로 본다). */
export function isStoredDevice(value: unknown): value is StoredDevice {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<StoredDevice>;
  return typeof v.deviceId === 'string' && typeof v.label === 'string' && (v.kind === 'pos' || v.kind === 'driver_tablet' || v.kind === 'driver_phone')
    && !!v.keyPair && typeof v.keyPair === 'object' && 'privateKey' in v.keyPair && 'publicKey' in v.keyPair;
}

/** 브라우저의 등록 두는 곳: IndexedDB, 안 되면 메모리(이 창이 닫히면 다시 등록). */
export function browserDeviceStore(): DeviceKeyStore {
  if (typeof indexedDB === 'undefined') return memoryDeviceStore();
  const idb = indexedDbDeviceStore();
  const fallback = memoryDeviceStore();
  let broken = false;
  const guard = <T>(work: (store: DeviceKeyStore) => Promise<T>): Promise<T> => (broken ? work(fallback) : work(idb).catch(() => {
    broken = true;
    return work(fallback);
  }));
  return {
    load: () => guard((s) => s.load()),
    save: (device) => guard((s) => s.save(device)),
    forget: () => guard((s) => s.forget()),
  };
}

// 기기 열쇠(계획 work/impl-server/plan.md D6 · 6-6 device-key.test): Node의 WebCrypto로 열쇠 쌍 → 공개 열쇠 JWK(서버의 입력 검사를
// 지남) → 로그인 문장 서명(r ‖ s 64바이트, base64url 86자)이 공개 열쇠로 맞는지, 다른 문장 · 다른 앱 주소로는 틀린지, 비밀 열쇠는 꺼낼
// 수 없는지. 두는 곳(메모리)과 두었던 값의 모양 확인.
import { loginMessage, parseAuthBody } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { base64url, isStoredDevice, memoryDeviceStore, newDeviceKeyPair, publicJwk, signLogin } from '../src/app/device-key.ts';

const subtle = globalThis.crypto.subtle;
const ORIGIN = 'https://pos.example';
const DEVICE = '01J00000000000000000000002';
const NONCE = base64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));

const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function verify(publicKey: JsonWebKey, message: string, signature: string): Promise<boolean> {
  const key = await subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(signature), new TextEncoder().encode(message));
}

describe('기기 열쇠', () => {
  it('비밀 열쇠는 꺼낼 수 없고 공개 열쇠는 P-256 JWK(kty · crv · x · y만)', async () => {
    const pair = await newDeviceKeyPair();
    expect(pair.privateKey.extractable).toBe(false);
    await expect(subtle.exportKey('jwk', pair.privateKey)).rejects.toBeTruthy();
    const jwk = await publicJwk(pair);
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect([jwk.kty, jwk.crv, jwk.x.length, jwk.y.length]).toEqual(['EC', 'P-256', 43, 43]);
    // 서버의 등록 본문 검사(@skinote/contract wire)를 지난다.
    expect(parseAuthBody('enroll', { code: '123456789012', publicKey: jwk, agent: 'Windows · Chrome' }).ok).toBe(true);
  });

  it('로그인 서명: 앞마디 · 앱 주소 · 기기 · 한 번 값의 문장에만 맞는다', async () => {
    const pair = await newDeviceKeyPair();
    const jwk = await publicJwk(pair);
    const signature = await signLogin(pair.privateKey, ORIGIN, DEVICE, NONCE);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(await verify(jwk, loginMessage(ORIGIN, DEVICE, NONCE), signature)).toBe(true);
    expect(loginMessage(ORIGIN, DEVICE, NONCE)).toBe('skinote-login-v1|' + ORIGIN + '|' + DEVICE + '|' + NONCE);
    expect(await verify(jwk, NONCE, signature)).toBe(false);
    expect(await verify(jwk, loginMessage('https://other.example', DEVICE, NONCE), signature)).toBe(false);
    expect(parseAuthBody('staff', { deviceId: DEVICE, nonce: NONCE, signature }).ok).toBe(true);
  });

  it('두는 곳(메모리): 두기 · 읽기 · 지우기, 모양이 틀린 값은 없는 것으로', async () => {
    const pair = await newDeviceKeyPair();
    const store = memoryDeviceStore();
    expect(await store.load()).toBeNull();
    const device = { deviceId: DEVICE, kind: 'driver_phone' as const, label: '1호 차량 휴대폰', vehicleId: 'v1', keyPair: pair };
    await store.save(device);
    expect(await store.load()).toBe(device);
    expect(isStoredDevice(device)).toBe(true);
    await store.forget();
    expect(await store.load()).toBeNull();
    expect(isStoredDevice({ deviceId: DEVICE, kind: 'pos', label: '카운터 1' })).toBe(false);
    expect(isStoredDevice({ ...device, kind: 'laptop' })).toBe(false);
  });

  it('base64url은 끝 = 없이, + / 대신 - _', () => {
    expect(base64url(new Uint8Array([251, 255, 191]))).toBe('-_-_');
    expect(base64url(new Uint8Array([1]))).toBe('AQ');
  });
});

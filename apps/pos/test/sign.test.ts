// 보냄 대기 서명(work/impl-offline/plan.md O5 · §4-3, §7-9 sign.test): 공유 벡터의 항목 해시가 같고, 기기(WebCrypto)가 만든 서명을 서버와 같은
// 검사(node:crypto verify, IEEE P1363)가 받아들이며, 한 칸이라도 바뀌면 받아들이지 않는다.
import { commandMessage, itemHash, itemHashInput, type QueuedEnvelope } from '@skinote/contract';
import { verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { signQueued, type UnsignedQueued } from '../src/local/sign.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../packages/contract/test/vectors/queued-items.json', import.meta.url), 'utf8')) as { name: string; text: string; canonical: string; hash: string }[];
const ORIGIN = 'https://pos.example';
const DEVICE = '01JF00000000000000000DEV01';

function b64(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

/** 서버(offline.js itemSignatureOk)와 같은 검사. */
async function serverVerifies(item: QueuedEnvelope, publicKey: CryptoKey): Promise<boolean> {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  const message = new TextEncoder().encode(commandMessage(ORIGIN, DEVICE, item.deviceSeq, await itemHash(item)));
  return verify('sha256', message, { key: jwk, format: 'jwk', dsaEncoding: 'ieee-p1363' }, b64(item.recordedBy.signature));
}

describe('보냄 대기 서명', () => {
  it('공유 벡터: 정규 JSON과 항목 해시가 계약 · 저장소 · 서버와 같다', async () => {
    expect(vectors.length).toBeGreaterThan(3);
    for (const v of vectors) {
      const item = JSON.parse(v.text) as unknown;
      expect(itemHashInput(item), v.name).toBe(v.canonical);
      expect(await itemHash(item), v.name).toBe(v.hash);
    }
  });

  it('기기가 만든 서명(86자)을 서버의 검사가 받아들이고, 칸이 바뀌면 받아들이지 않는다', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const envelopes = vectors.filter((v) => (JSON.parse(v.text) as { recordedBy?: unknown }).recordedBy !== undefined);
    expect(envelopes.length).toBeGreaterThanOrEqual(3);
    for (const v of envelopes) {
      const { recordedBy, ...rest } = JSON.parse(v.text) as QueuedEnvelope;
      const unsigned = { ...rest, recordedBy: { staffId: recordedBy.staffId, sessionId: recordedBy.sessionId } } as UnsignedQueued;
      const signed = await signQueued(unsigned, pair.privateKey, ORIGIN, DEVICE);
      expect(signed.recordedBy.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
      // 서명 칸을 뺀 항목은 넣은 것과 같다(서명이 다른 칸을 바꾸지 않는다).
      expect(itemHashInput(signed)).toBe(v.canonical);
      expect(await serverVerifies(signed, pair.publicKey), v.name).toBe(true);
      expect(await serverVerifies({ ...signed, ageMs: signed.ageMs + 1 }, pair.publicKey)).toBe(false);
      expect(await serverVerifies({ ...signed, deviceSeq: signed.deviceSeq + 1 }, pair.publicKey)).toBe(false);
    }
  });
});

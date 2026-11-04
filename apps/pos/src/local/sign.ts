// 보냄 대기 명령의 서명(work/impl-offline/plan.md O5 · §4-3): 보낼 때마다(나이 ageMs가 보낼 때마다 바뀐다) 기기 열쇠(꺼낼 수 없는 ECDSA P-256)로
// `skinote-cmd-v1|<앱 주소>|<기기 id>|<기기 번호>|<항목 해시>`에 서명한다. 항목 해시 = b64url(sha256(canonicalJson(서명 칸을 뺀 항목))). 서버는 받은
// 그대로의 항목으로 같은 해시를 센다(검사 전). 서명은 IEEE P1363(r ‖ s 64바이트, base64url 86자): 로그인 서명과 같은 모양이다.
import { base64Url, commandMessage, deliverMessage, itemHash, type QueuedEnvelope, type RecordedBy } from '@skinote/contract';

/** 서명 전의 보냄 대기 봉투(recordedBy에 서명이 없다). */
export type UnsignedQueued = Omit<QueuedEnvelope, 'recordedBy'> & { recordedBy: Omit<RecordedBy, 'signature'> };

export async function signQueued(item: UnsignedQueued, privateKey: CryptoKey, origin: string, deviceId: string, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<QueuedEnvelope> {
  const hash = await itemHash(item);
  const message = new TextEncoder().encode(commandMessage(origin, deviceId, item.deviceSeq, hash));
  const signature = base64Url(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, message)));
  return { ...item, recordedBy: { ...item.recordedBy, signature } } as QueuedEnvelope;
}

/**
 * 세션 없는 전달의 서명(§4-5): deliverMessage(앱 주소, 기기 id, 한 번 값). 로그인 서명(app/device-key.ts signLogin)과 앞마디(skinote-deliver-v1)만
 * 다르다. 이 묶음(local/)이 앱 뼈대의 모듈을 끌어오지 않게 여기에 둔다.
 */
export async function signDeliver(privateKey: CryptoKey, origin: string, deviceId: string, nonce: string, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
  const data = new TextEncoder().encode(deliverMessage(origin, deviceId, nonce));
  return base64Url(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data)));
}

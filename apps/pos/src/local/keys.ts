// 봉인 열쇠 두 가지(work/impl-offline/plan.md O13):
//   - 보냄 대기 열쇠(kind 'queue', 기기 id마다 하나, id `queue:<기기 id>`): 보냄 대기 · 보낸 기록 · 답을 잃은 온라인 명령을 봉인한다. 로그아웃에도
//     남고(로그아웃은 보냄 대기가 비어야 한다) 끊은 기기가 기록을 모두 전달한 뒤에만 지운다.
//   - 사본 열쇠(kind 'copy'): 사본 · 기억한 세션 · 비밀번호 확인 값을 봉인한다. 새 사본을 통째로 쓸 때와 24시간 지움 때 새 열쇠로 다시 봉인하고
//     옛 열쇠를 지운다(crypto-shredding).
// 열쇠는 꺼낼 수 없는 CryptoKey 그대로 `keys` 저장소에 둔다(구조화 복사). 봉인 칸마다 keyId가 있고, 가리키는 칸이 있는 열쇠는 지우지 않는다
// (부르는 쪽이 다시 봉인한 뒤 지운다).
import { TxAborted, type RawStore, type Rec, type TxRequests } from './raw-store.ts';
import { newSealKey } from './sealed.ts';

export type KeyKind = 'queue' | 'copy';

export interface KeyRecord {
  id: string;
  kind: KeyKind;
  deviceId: string;
  key: CryptoKey;
  createdAt: number;
}

export const queueKeyId = (deviceId: string): string => 'queue:' + deviceId;

/** 무작위 id(base64url 16자). */
export function randomId(bytes = 12): string {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  let text = '';
  for (const b of raw) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const isKeyRecord = (value: Rec | undefined): value is Rec & KeyRecord =>
  !!value && typeof value.id === 'string' && (value.kind === 'queue' || value.kind === 'copy') && typeof value.deviceId === 'string'
  && typeof value.key === 'object' && value.key !== null && typeof value.createdAt === 'number';

export class KeyRing {
  private readonly cache = new Map<string, CryptoKey>();
  private readonly raw: RawStore;
  private readonly subtle: SubtleCrypto;
  private readonly now: () => number;

  constructor(raw: RawStore, subtle: SubtleCrypto = globalThis.crypto.subtle, now: () => number = () => Date.now()) {
    this.raw = raw;
    this.subtle = subtle;
    this.now = now;
  }

  /** 열쇠 하나(없으면 null: 지운 열쇠의 봉인은 열 수 없다). */
  async key(id: string): Promise<CryptoKey | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    let found: Rec | undefined;
    await this.raw.tx(['keys'], 'readonly', (t) => t.get('keys', id, (v) => { found = v; }));
    if (!isKeyRecord(found)) return null;
    this.cache.set(id, found.key);
    return found.key;
  }

  /** 모든 열쇠(종류 · 만든 때). */
  async list(): Promise<KeyRecord[]> {
    let rows: Rec[] = [];
    await this.raw.tx(['keys'], 'readonly', (t) => t.all('keys', (v) => { rows = v; }));
    return rows.filter(isKeyRecord).map((r) => ({ id: r.id, kind: r.kind, deviceId: r.deviceId, key: r.key, createdAt: r.createdAt }));
  }

  /** 이 기기의 보냄 대기 열쇠(없으면 만든다). 두 화면이 함께 만들어도 하나만 남는다(add 겹침 → 다시 읽음). */
  async queueKey(deviceId: string): Promise<KeyRecord> {
    const id = queueKeyId(deviceId);
    const existing = await this.record(id);
    if (existing) return existing;
    const record: KeyRecord = { id, kind: 'queue', deviceId, key: await newSealKey(this.subtle), createdAt: this.now() };
    try {
      await this.raw.tx(['keys'], 'readwrite', (t) => t.add('keys', record as unknown as Rec), { durability: 'strict' });
      this.cache.set(id, record.key);
      return record;
    } catch (error) {
      const again = await this.record(id);
      if (again) return again;
      throw error;
    }
  }

  /** 지금 쓰는 사본 열쇠(가장 늦게 만든 것). 없으면 null. */
  async currentCopyKey(): Promise<KeyRecord | null> {
    const copies = (await this.list()).filter((k) => k.kind === 'copy').sort((a, b) => a.createdAt - b.createdAt);
    const last = copies.at(-1);
    if (last) this.cache.set(last.id, last.key);
    return last ?? null;
  }

  /** 새 사본 열쇠(아직 저장하지 않음: 부르는 쪽이 새 봉인과 한 트랜잭션으로 넣는다). */
  async newCopyKey(deviceId: string): Promise<KeyRecord> {
    const createdAt = Math.max(this.now(), ((await this.currentCopyKey())?.createdAt ?? 0) + 1);
    return { id: 'copy:' + randomId(), kind: 'copy', deviceId, key: await newSealKey(this.subtle), createdAt };
  }

  /** 저장한 뒤 알게 된 열쇠를 기억한다(같은 화면의 다음 읽기). */
  remember(record: KeyRecord): void {
    this.cache.set(record.id, record.key);
  }

  /** 지운 열쇠를 잊는다(다른 화면이 지웠다는 알림 · 지운 뒤). */
  forget(ids?: readonly string[]): void {
    if (!ids) this.cache.clear();
    else for (const id of ids) this.cache.delete(id);
  }

  private async record(id: string): Promise<KeyRecord | null> {
    let found: Rec | undefined;
    await this.raw.tx(['keys'], 'readonly', (t) => t.get('keys', id, (v) => { found = v; }));
    if (!isKeyRecord(found)) return null;
    this.cache.set(id, found.key);
    return { id: found.id, kind: found.kind, deviceId: found.deviceId, key: found.key, createdAt: found.createdAt };
  }
}

/** 트랜잭션 안: 열쇠가 아직 있는지 보고 없으면 되돌린다(다른 화면이 지웠다, O9 · O22). */
export function requireKey(t: TxRequests, keyId: string, then: () => void): void {
  t.get('keys', keyId, (v) => {
    if (!v) {
      t.abort('KEY_GONE');
      return;
    }
    then();
  });
}

export { TxAborted };

// 기사 기기의 저장소 바닥(work/impl-offline/plan.md §7-1, O9 · O13): IndexedDB `skinote-local`과 같은 모양의 작은 틀. 브라우저는 idb-store.ts,
// 시험은 MemoryRawStore(아래)를 쓴다. 틀이 하는 일은 IndexedDB의 트랜잭션 규칙 그대로다:
//   - 한 트랜잭션 안의 요청은 동기로만 낸다. 답은 콜백으로 오고, 콜백 안에서 같은 트랜잭션에 요청을 더 낼 수 있다. WebCrypto 같은 기다림을
//     트랜잭션 안에 넣으면 IndexedDB가 트랜잭션을 저절로 끝내 버리므로(O9), 봉인은 트랜잭션 전에 한다.
//   - add는 같은 키가 있으면 트랜잭션 전체를 되돌린다(번호 · 요청번호가 겹치지 않게).
//   - 트랜잭션이 끝나지 못하면(되돌림 · 용량 초과 · 닫힌 화면) 그 안의 쓰기는 하나도 남지 않는다.
// 저장소 이름과 키(keyPath)는 여기 한 곳에 둔다: 열쇠(keys) · 기기 번호(counters) · 보냄 대기(queue) · 보낸 기록(sent) · 사본(snapshot) ·
// 기억한 세션(session) · 기기 메모(meta). `skinote-local`은 지우지 않는다(deleteDatabase 없음, 필요하면 저장소를 비운다).

export type StoreName = 'keys' | 'counters' | 'queue' | 'sent' | 'snapshot' | 'session' | 'meta';

export const LOCAL_DB = 'skinote-local';
export const LOCAL_DB_VERSION = 1;

/** 저장소마다의 키(keyPath)와 기기 번호 찾아보기(index 'seq'). */
export const STORE_SPECS: Readonly<Record<StoreName, { keyPath: string; seqIndex?: true }>> = Object.freeze({
  keys: { keyPath: 'id' },
  counters: { keyPath: 'deviceId' },
  queue: { keyPath: 'requestId', seqIndex: true },
  sent: { keyPath: 'requestId', seqIndex: true },
  snapshot: { keyPath: 'id' },
  session: { keyPath: 'id' },
  meta: { keyPath: 'id' },
});

export const STORE_NAMES = Object.keys(STORE_SPECS) as StoreName[];

/** 저장소 한 칸(구조화 복사가 되는 값: CryptoKey · Uint8Array 포함). */
export type Rec = Record<string, unknown>;

/** 한 트랜잭션 안의 요청. 답은 콜백으로 오고, 콜백 안에서 같은 트랜잭션의 요청을 더 낼 수 있다. */
export interface TxRequests {
  get(store: StoreName, key: string, then: (value: Rec | undefined) => void): void;
  /** 저장소의 모든 칸(키 차례). */
  all(store: StoreName, then: (values: Rec[]) => void): void;
  put(store: StoreName, value: Rec): void;
  /** 같은 키가 있으면 트랜잭션 전체가 되돌려진다. */
  add(store: StoreName, value: Rec): void;
  delete(store: StoreName, key: string): void;
  clear(store: StoreName): void;
  /** 트랜잭션을 되돌린다(아무것도 쓰지 않는다). 기다리던 약속은 TxAborted로 거절된다. */
  abort(reason: string): void;
}

export interface TxOptions {
  /** 'strict': 디스크에 닿은 뒤 끝남(보냄 대기 넣기, O9). */
  durability?: 'strict' | 'default';
}

export interface RawStore {
  tx(stores: readonly StoreName[], mode: 'readonly' | 'readwrite', work: (t: TxRequests) => void, options?: TxOptions): Promise<void>;
  close(): void;
}

/** 트랜잭션을 스스로 되돌림(abort)이나 키 겹침으로 끝냄. */
export class TxAborted extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super('tx aborted: ' + reason);
    this.name = 'TxAborted';
    this.reason = reason;
  }
}

/** 기기 저장소를 열 수 없음(사생활 보호 창 · IndexedDB 없음 · 용량): 연결 끊김 기록을 끈다(O2). */
export class LocalStoreUnavailable extends Error {
  constructor(cause?: unknown) {
    super('local store unavailable' + (cause instanceof Error ? ': ' + cause.message : ''));
    this.name = 'LocalStoreUnavailable';
  }
}

export const keyOf = (store: StoreName, value: Rec): string => {
  const key = value[STORE_SPECS[store].keyPath];
  if (typeof key !== 'string' || key === '') throw new TypeError('키가 없는 칸: ' + store);
  return key;
};

// ── 한 번에 하나(트랜잭션 하나로 감싼 도우미) ─────────────────────────────

export async function readOne(store: RawStore, name: StoreName, key: string): Promise<Rec | undefined> {
  let out: Rec | undefined;
  await store.tx([name], 'readonly', (t) => t.get(name, key, (v) => { out = v; }));
  return out;
}

export async function readAll(store: RawStore, name: StoreName): Promise<Rec[]> {
  let out: Rec[] = [];
  await store.tx([name], 'readonly', (t) => t.all(name, (v) => { out = v; }));
  return out;
}

export function writeOne(store: RawStore, name: StoreName, value: Rec, options?: TxOptions): Promise<void> {
  return store.tx([name], 'readwrite', (t) => t.put(name, value), options);
}

export function removeOne(store: RawStore, name: StoreName, key: string): Promise<void> {
  return store.tx([name], 'readwrite', (t) => t.delete(name, key));
}

// ── 시험용 메모리 저장소 ─────────────────────────────────────────────

const clone = <T,>(value: T): T => structuredClone(value);

/**
 * 메모리 저장소(시험). IndexedDB처럼: 트랜잭션은 다음 마이크로태스크에 돌고, 요청의 답은 낸 차례로 오며, 되돌리거나 콜백이 던지면 아무것도
 * 남지 않는다. 값은 구조화 복사로 넣고 꺼낸다. 같은 저장소를 두 클라이언트(두 화면 · 다시 연 화면)가 함께 쓸 수 있다.
 */
export class MemoryRawStore implements RawStore {
  private readonly data = new Map<StoreName, Map<string, Rec>>(STORE_NAMES.map((name) => [name, new Map()]));
  /** 시험: 다음 쓰기 트랜잭션을 이 까닭으로 실패시킨다(용량 초과 · 닫힌 화면). */
  failNextWrite: string | null = null;
  /** 시험: 모든 쓰기를 실패시킨다(저장할 곳 없음). */
  failWrites: string | null = null;
  /** 끝난 쓰기 트랜잭션 수(시험이 센다). */
  commits = 0;
  private closed = false;

  tx(stores: readonly StoreName[], mode: 'readonly' | 'readwrite', work: (t: TxRequests) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        if (this.closed) {
          reject(new LocalStoreUnavailable(new Error('closed')));
          return;
        }
        const scope = new Set(stores);
        const working = new Map<StoreName, Map<string, Rec>>(stores.map((s) => [s, new Map(this.data.get(s))]));
        const steps: (() => void)[] = [];
        let failed: Error | null = null;
        const inScope = (s: StoreName) => {
          if (!scope.has(s)) throw new Error('트랜잭션 밖의 저장소: ' + s);
          return working.get(s)!;
        };
        const writable = () => {
          if (mode !== 'readwrite') throw new Error('읽기 트랜잭션에서 쓰기');
        };
        const t: TxRequests = {
          get: (s, key, then) => { const m = inScope(s); steps.push(() => then(m.has(key) ? clone(m.get(key)!) : undefined)); },
          all: (s, then) => {
            const m = inScope(s);
            steps.push(() => then([...m.keys()].sort().map((k) => clone(m.get(k)!))));
          },
          put: (s, value) => { writable(); const m = inScope(s); const v = clone(value); steps.push(() => { m.set(keyOf(s, v), v); }); },
          add: (s, value) => {
            writable();
            const m = inScope(s);
            const v = clone(value);
            steps.push(() => {
              const key = keyOf(s, v);
              if (m.has(key)) throw new TxAborted('ConstraintError ' + s);
              m.set(key, v);
            });
          },
          delete: (s, key) => { writable(); const m = inScope(s); steps.push(() => { m.delete(key); }); },
          clear: (s) => { writable(); const m = inScope(s); steps.push(() => { m.clear(); }); },
          abort: (reason) => { failed ??= new TxAborted(reason); },
        };
        try {
          work(t);
          while (steps.length && !failed) steps.shift()!();
        } catch (error) {
          failed ??= error instanceof Error ? error : new Error(String(error));
        }
        if (!failed && mode === 'readwrite') {
          const forced = this.failWrites ?? this.failNextWrite;
          if (forced) {
            this.failNextWrite = null;
            failed = new DOMException(forced, 'QuotaExceededError');
          }
        }
        if (failed) {
          reject(failed);
          return;
        }
        if (mode === 'readwrite') {
          for (const [s, m] of working) this.data.set(s, m);
          this.commits += 1;
        }
        resolve();
      });
    });
  }

  close(): void {
    this.closed = true;
  }

  /** 시험: 한 저장소의 칸 수. */
  size(store: StoreName): number {
    return this.data.get(store)!.size;
  }

  /** 시험: 한 칸을 그대로(복사) 본다. */
  peek(store: StoreName, key: string): Rec | undefined {
    const v = this.data.get(store)!.get(key);
    return v === undefined ? undefined : clone(v);
  }

  /** 시험: 한 칸을 그대로 바꾼다(옛 판 기록 · 깨진 기록). */
  poke(store: StoreName, value: Rec): void {
    this.data.get(store)!.set(keyOf(store, value), clone(value));
  }
}

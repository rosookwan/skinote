// IndexedDB `skinote-local`(work/impl-offline/plan.md §7-1): raw-store.ts의 틀을 브라우저에서. 여는 데 실패하면(사생활 보호 창 · IndexedDB 없음 ·
// 막힌 판 바꿈) LocalStoreUnavailable을 던진다: 부르는 쪽이 연결 끊김 기록을 끈다(O2, 메모리로 대신하지 않는다). 데이터베이스를 지우지 않는다
// (deleteDatabase 없음): 기기 번호 · 보냄 대기 열쇠가 함께 사라지지 않게(O9 · O13).
// 요청의 답은 IndexedDB의 success 사건에서 부른다(같은 트랜잭션에 이어서 요청할 수 있다). 콜백이 던지면 트랜잭션을 되돌린다.
import { LOCAL_DB, LOCAL_DB_VERSION, LocalStoreUnavailable, STORE_NAMES, STORE_SPECS, TxAborted, type RawStore, type Rec, type StoreName, type TxRequests } from './raw-store.ts';

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(LOCAL_DB, LOCAL_DB_VERSION);
    } catch (error) {
      reject(new LocalStoreUnavailable(error));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORE_NAMES) {
        if (db.objectStoreNames.contains(name)) continue;
        const spec = STORE_SPECS[name];
        const store = db.createObjectStore(name, { keyPath: spec.keyPath });
        if (spec.seqIndex) store.createIndex('seq', 'seq', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new LocalStoreUnavailable(request.error));
    request.onblocked = () => reject(new LocalStoreUnavailable(new Error('blocked')));
  });
}

/** 브라우저의 `skinote-local`을 연다. 없거나 열리지 않으면 LocalStoreUnavailable. */
export async function openIdbStore(idb: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB): Promise<RawStore> {
  if (!idb) throw new LocalStoreUnavailable(new Error('no indexedDB'));
  const db = await openDb(idb);
  // 다른 화면이 새 판으로 열려 하면 닫아 준다(다음 쓰기는 LocalStoreUnavailable로 거절된다).
  db.onversionchange = () => db.close();
  let closed = false;
  return {
    tx(stores, mode, work, options) {
      return new Promise<void>((resolve, reject) => {
        let transaction: IDBTransaction;
        try {
          if (closed) throw new Error('closed');
          transaction = db.transaction([...stores], mode, { durability: options?.durability ?? 'default' });
        } catch (error) {
          reject(new LocalStoreUnavailable(error));
          return;
        }
        let failure: Error | null = null;
        const fail = (error: unknown) => {
          failure ??= error instanceof Error ? error : new Error(String(error));
          try {
            transaction.abort();
          } catch {
            // 이미 끝남.
          }
        };
        /** 답 콜백: 던지면 트랜잭션을 되돌린다. */
        const answer = <T,>(request: IDBRequest<T>, then: (value: T) => void) => {
          request.onsuccess = () => {
            if (failure) return;
            try {
              then(request.result);
            } catch (error) {
              fail(error);
            }
          };
        };
        const os = (name: StoreName) => transaction.objectStore(name);
        const t: TxRequests = {
          get: (name, key, then) => answer(os(name).get(key), (v) => then(v as Rec | undefined)),
          all: (name, then) => answer(os(name).getAll(), (v) => then(v as Rec[])),
          put: (name, value) => { os(name).put(value); },
          add: (name, value) => {
            const request = os(name).add(value);
            request.onerror = () => { failure ??= new TxAborted('ConstraintError ' + name); };
          },
          delete: (name, key) => { os(name).delete(key); },
          clear: (name) => { os(name).clear(); },
          abort: (reason) => fail(new TxAborted(reason)),
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(failure ?? transaction.error ?? new TxAborted('abort'));
        transaction.onerror = () => { failure ??= transaction.error ?? new Error('IndexedDB'); };
        try {
          work(t);
        } catch (error) {
          fail(error);
        }
      });
    },
    close() {
      closed = true;
      db.close();
    },
  };
}

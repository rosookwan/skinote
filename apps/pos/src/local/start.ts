// 기사 기기의 DriverClient를 여는 곳(work/impl-offline/plan.md §7-7): session.tsx가 로그인한 기사 기기에서만 따로 받는 묶음(도메인 포함)이다. 카운터 ·
// 체험판은 받지 않는다.
//   - 기기 저장소(IndexedDB `skinote-local`)를 열지 못하면 null: 부르는 쪽이 HttpClient로(연결된 동안만) 돈다(O2: 메모리로 대신하지 않는다).
//   - 로그인 때 저장 공간 유지(navigator.storage.persist)를 청한다(O16: 거절해도 끊김 기록은 한다).
//   - 앱 판은 이 묶음 파일 이름(빌드마다 바뀌는 해시)에서 센다(서버의 막힌 항목 판정 · 알림).
import { API_V2, CSRF_HEADER, type SessionInfo } from '@skinote/contract';
import type { AuthApi } from '../app/auth-api.ts';
import type { HttpClient, HttpClientOptions } from '../app/http-client.ts';
import { browserOfflineCapable, DriverClient } from './driver-client.ts';
import { openIdbStore } from './idb-store.ts';
import { browserChannel, browserLocks, LocalStore } from './local-store.ts';
import { readAll, type RawStore } from './raw-store.ts';
import { appVersionOf } from './report.ts';
import type { LocalWords } from './words.ts';

/** 이 빌드의 앱 판(묶음 파일 이름, 개발 서버에서는 모듈 이름). */
export const APP_VERSION = appVersionOf(new URL(import.meta.url).pathname.split('/').pop() ?? 'dev');

export interface OpenDriverInput {
  session: SessionInfo;
  baseUrl: string;
  origin: string;
  /** 기기 열쇠의 비밀 열쇠. */
  deviceKey: CryptoKey;
  fetchImpl?: typeof fetch;
  onSessionLost: (code: string) => void;
  /** 창에 돌려주는 한 줄들(app/strings.ts localWords). */
  words: LocalWords;
  /** 길(HttpClient)을 만드는 법과 로그인 전 길(세션 없는 전달): session.tsx가 넘긴다. */
  makeHttp: (options: HttpClientOptions) => HttpClient;
  auth: Pick<AuthApi, 'challenge' | 'deliver'>;
  /** 기억한 세션으로 서버 없이 연다(boot open · locked, §18 R4-13). */
  remembered?: boolean;
}

/** 기사 기기의 클라이언트(시작함). 저장소를 열 수 없으면 null. */
export async function openDriverClient(input: OpenDriverInput): Promise<DriverClient | null> {
  let raw;
  try {
    raw = await openIdbStore();
  } catch {
    return null;
  }
  try {
    await navigator.storage?.persist?.();
  } catch {
    // 거절 · 없음: 끊김 기록은 그대로 한다(O16).
  }
  const client = await DriverClient.open({
    session: input.session, raw, deviceKey: input.deviceKey, origin: input.origin, baseUrl: input.baseUrl, appVersion: APP_VERSION,
    ...(input.fetchImpl ? { fetch: input.fetchImpl } : {}),
    auth: input.auth, makeHttp: input.makeHttp, onSessionLost: input.onSessionLost, words: input.words,
    channel: browserChannel(), locks: browserLocks(), offlineCapable: browserOfflineCapable, ...(input.remembered ? { remembered: true } : {}),
  });
  client.start();
  return client;
}

/**
 * 이 기기에 아직 서버에 가지 않은 기록이 있는지(보냄 대기의 답을 받지 않은 항목 수). 기기 열쇠를 잊기 전에 본다(O14 h: 기록이 남은 동안 열쇠 · 저장소를
 * 지우지 않는다). 저장소를 열 수 없으면 0.
 */
export async function localPendingCount(): Promise<number> {
  try {
    const raw = await openIdbStore();
    try {
      const rows = await readAll(raw, 'queue');
      return rows.filter((r) => r.state !== 'answered').length;
    } finally {
      raw.close();
    }
  } catch {
    return 0;
  }
}

/** 기기 저장소를 여는 법(시험은 메모리 저장소를 넣는다). */
type OpenRaw = () => Promise<RawStore>;

/** 기기 저장소를 열어 일 하나를 한다(열 수 없으면 fallback). */
async function withLocal<T>(work: (local: LocalStore) => Promise<T>, fallback: T, open: OpenRaw = openIdbStore): Promise<T> {
  let raw;
  try {
    raw = await open();
  } catch {
    return fallback;
  }
  const local = new LocalStore({ raw, deviceId: '', channel: browserChannel(), locks: browserLocks() });
  try {
    return await work(local);
  } catch {
    return fallback;
  } finally {
    local.close();
    raw.close();
  }
}

/**
 * 세션이 끝났다(로그아웃 상태 · 만료 · 끊은 기기 · 모르는 기기, §17 R3-9): 이름 · 번호가 든 사본 · 기억한 세션 · 확인 값을 지운다. wipe면(끊은 · 모르는
 * 기기) 보낼 기록이 없을 때만 모두 지운다(저장소가 같은 트랜잭션에서 본다: 보낼 기록이 있으면 지우지 않는다). 모두 지웠는지.
 */
export async function clearLocalAfterSignOut(wipe: boolean, open: OpenRaw = openIdbStore): Promise<boolean> {
  return withLocal(async (local) => {
    await local.dropCopy();
    return wipe ? local.wipeAll() : false;
  }, false, open);
}

/** 서버에 닿지 못한 로그아웃의 세션 id(§17 R3-7). 없으면 undefined. */
export async function signOutPendingId(open: OpenRaw = openIdbStore): Promise<string | undefined> {
  return withLocal(async (local) => (await local.readMeta()).signOutPending, undefined, open);
}

/**
 * 서버가 준 세션이 서버에 닿지 못한 로그아웃의 세션인지(§17 R3-7): 그렇다면 먼저 서버 로그아웃을 보내고 true(부르는 쪽은 그 세션을 열지 않고 로그인
 * 화면으로 간다, 서버 로그아웃이 닿지 않아도). 다른 세션이거나 표시가 없으면 false.
 */
export async function pendingSignOut(session: SessionInfo, baseUrl: string, fetchImpl?: typeof fetch, open: OpenRaw = openIdbStore): Promise<boolean> {
  const id = await signOutPendingId(open);
  if (id === undefined || id !== session.session?.id) return false;
  await finishSignOut(baseUrl, session.csrf, fetchImpl, open);
  return true;
}

/**
 * 서버에 닿지 못한 로그아웃을 이제 보낸다(그 세션의 CSRF로): 되면(204 · 이미 끝남 401) 표시를 지우고 true. 서버에 닿지 않으면 false(표시는 남고, 부르는
 * 쪽은 그 세션을 열지 않는다).
 */
export async function finishSignOut(
  baseUrl: string, csrf: string, fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init), open: OpenRaw = openIdbStore,
): Promise<boolean> {
  let done = false;
  try {
    const res = await fetchImpl(new URL(API_V2.logout, baseUrl).href, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json', 'content-type': 'application/json', [CSRF_HEADER]: csrf }, body: '{}',
    });
    done = res.status === 204 || res.status === 200 || res.status === 401;
  } catch {
    done = false;
  }
  if (done) await withLocal(async (local) => { await local.patchMeta({ signOutPending: undefined }); return true; }, false, open);
  return done;
}

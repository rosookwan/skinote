// 화면이 쓰는 DomainClient 문맥과 읽기 모델 불러오기. 화면은 읽기 모델만 받아 그린다(규칙 계산 없음).
// 새 rev 알림(subscribe)이 오면 다시 읽는데, 손가락이 화면에 닿아 있거나 창이 열려 있는 동안(hold)은 미뤘다가 끝난 뒤 한 번 읽는다(ui 6-1).
// 다시 읽기가 실패하면 가진 읽기 모델을 그대로 두고(화면이 비지 않게) 실패의 코드만 알리고, 잠시 뒤 다시 읽는다.
// 설정은 config_rev가 오르면(ui 2절) 다시 받는다.
import { domainErrorCode, type ConnectionState, type DomainClient, type DomainErrorCode, type UiConfig } from '@skinote/contract';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/** 체험판 전용 조작(시계 · 처음으로 · 기사 기기 연결). 운영 클라이언트에는 없다. */
export interface DemoControls {
  now(): number;
  advanceClock(minutes: number): void;
  reset(): void;
  /** 지금 화면이 어느 기기의 것인지(운영에서는 기기마다 클라이언트가 따로다). */
  setDevice(device: 'counter' | 'driver'): void;
  /** 기사 기기의 연결을 끊거나 잇는다(체험). */
  setOffline(offline: boolean): void;
  driverOffline(): boolean;
}

export type AppClient = DomainClient & Partial<DemoControls>;

/** 실패한 읽기를 다시 해 보기까지(연결이 돌아오면 곧 다시 그린다). */
const RETRY_AFTER_MS = 5_000;
/** 서버 시각이 바꾸는 늦음 · 주 버튼 조건을 다시 읽는 간격. */
const REFRESH_EVERY_MS = 60_000;

const ClientContext = createContext<AppClient | null>(null);
const ConfigContext = createContext<UiConfig | null>(null);

export function ClientProvider({ client, children }: { client: AppClient; children: ReactNode }) {
  const [config, setConfig] = useState<UiConfig | null>(null);
  const known = useRef<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      client.config().then((c) => {
        if (!alive) return;
        known.current = c.configRev;
        setConfig(c);
      }, () => {
        // 설정을 받지 못했다: 잠시 뒤 다시 받는다(그동안 화면은 설정을 기다린다).
        if (alive) setTimeout(load, RETRY_AFTER_MS);
      });
    };
    load();
    const off = client.subscribe((head) => { if (known.current !== null && head.configRev !== known.current) load(); });
    return () => { alive = false; off(); };
  }, [client]);
  return (
    <ClientContext.Provider value={client}>
      <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>
    </ClientContext.Provider>
  );
}

export function useClient(): AppClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('ClientProvider 밖에서 useClient를 불렀다');
  return client;
}

/** 설정(레지스트리 · 기능 · 문구). 읽기 전에는 null. */
export function useConfig(): UiConfig | null {
  return useContext(ConfigContext);
}

/** 새 rev 알림과 1분마다(서버 시각이 바꾸는 늦음 · 주 버튼 조건)의 다시 읽기 신호. */
function useChangeTick(client: AppClient): [number, () => void] {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const off = client.subscribe(() => setTick((t) => t + 1));
    const timer = setInterval(() => setTick((t) => t + 1), REFRESH_EVERY_MS);
    return () => { off(); clearInterval(timer); };
  }, [client]);
  return [tick, () => setTick((t) => t + 1)];
}

export interface Live<T> {
  /** 마지막으로 읽은 읽기 모델(다시 읽기가 실패해도 남는다). */
  data: T | null;
  /** 마지막 읽기가 실패했으면 그 까닭(없는 접수 · 연결 끊김 …). */
  error: DomainErrorCode | null;
}

/** useLive가 쥔 상태(어느 열쇠 · 어느 알림 번호에서 읽었는지). */
export interface LiveState<T> extends Live<T> {
  key: string | null;
  tick: number;
}

/**
 * 읽기가 실패했을 때의 다음 상태: 같은 열쇠면 가진 읽기 모델을 그대로 두고(화면이 비지 않게) 까닭만 적고, 다른 열쇠면 비운다.
 * 없는 것(NOT_FOUND)이 아니면 잠시 뒤 다시 읽는다(retry).
 */
export function afterFailure<T>(prev: LiveState<T>, key: string, error: unknown, tick: number): { state: LiveState<T>; retry: boolean } {
  const code = domainErrorCode(error);
  return { state: { data: prev.key === key ? prev.data : null, error: code, key, tick }, retry: code !== 'NOT_FOUND' };
}

/**
 * 읽기 모델 하나를 불러 두고, 바뀌면 다시 읽는다. hold가 참이면(창이 열림 · 손가락이 닿음) 이미 가진 것을 그대로 두고
 * 새로 읽기를 미룬다. key가 바뀌면(다른 접수 · 다른 탭) 바로 읽는다. 실패하면 가진 것을 지우지 않고 잠시 뒤 다시 읽는다.
 */
export function useLive<T>(key: string, load: (client: AppClient) => Promise<T>, hold = false): Live<T> {
  const client = useClient();
  const [tick, retry] = useChangeTick(client);
  const [state, setState] = useState<LiveState<T>>({ data: null, error: null, key: null, tick: -1 });
  const loadRef = useRef(load);
  loadRef.current = load;
  const sameKey = state.key === key;
  const loaded = sameKey && (state.data !== null || state.error !== null);
  const fresh = loaded && state.tick === tick;
  useEffect(() => {
    // 같은 것을 이미 가졌으면: 새 알림이 없거나(fresh), 알림이 있어도 창 · 손가락 때문에 미루는 중(hold)이면 읽지 않는다.
    if (loaded && (fresh || hold)) return;
    let alive = true;
    const at = tick;
    loadRef.current(client).then(
      (data) => { if (alive) setState({ data, error: null, key, tick: at }); },
      (error: unknown) => {
        if (!alive) return;
        setState((prev) => afterFailure(prev, key, error, at).state);
        // 없는 것(NOT_FOUND)은 다시 읽어도 같다. 연결 문제는 잠시 뒤 다시.
        if (afterFailure(state, key, error, at).retry) setTimeout(() => { if (alive) retry(); }, RETRY_AFTER_MS);
      },
    );
    return () => { alive = false; };
  }, [client, key, tick, hold, loaded, fresh]);
  return sameKey ? { data: state.data, error: state.error } : { data: null, error: null };
}

/** 이 기기의 연결 상태(연결 띠 · 매장 입고의 연결 확인). 바뀌면 subscribe로 다시 읽는다. */
export function useConnection(): ConnectionState {
  const client = useClient();
  const [state, setState] = useState<ConnectionState>(() => client.connection());
  useEffect(() => {
    const read = () => setState((prev) => {
      const next = client.connection();
      return prev.online === next.online && prev.pendingCount === next.pendingCount && prev.lastSyncAt === next.lastSyncAt ? prev : next;
    });
    read();
    return client.subscribe(read);
  }, [client]);
  return state;
}

/** 손가락이 화면에 닿아 있는지(닿아 있는 동안 온 새로 고침은 미룬다). */
export function usePointerDown(): boolean {
  const [down, setDown] = useState(false);
  useEffect(() => {
    const on = () => setDown(true);
    const off = () => setDown(false);
    document.addEventListener('pointerdown', on, true);
    document.addEventListener('pointerup', off, true);
    document.addEventListener('pointercancel', off, true);
    // 창 밖에서 손을 떼면 pointerup이 오지 않는다: 창이 초점을 잃으면 뗀 것으로 본다(새로 고침이 멈추지 않게).
    window.addEventListener('blur', off);
    return () => {
      document.removeEventListener('pointerdown', on, true);
      document.removeEventListener('pointerup', off, true);
      document.removeEventListener('pointercancel', off, true);
      window.removeEventListener('blur', off);
    };
  }, []);
  return down;
}

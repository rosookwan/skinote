// 서버 모드의 앱(계획 work/impl-server/plan.md 6-1 · 6-3). 세션이 생길 때까지 등록 · 로그인 · 연결 끊김 화면을 보이고, 로그인하면
// HttpClient를 만들어 체험판과 같은 앱(App)을 그 클라이언트로 그린다. 이 파일과 HttpClient · 기기 열쇠 · 등록 · 로그인 화면은 서버
// 모드에서만 받는 묶음이다(체험판은 받지 않는다).
//
// 흐름: 세션 있음 → 앱 / 로그아웃 상태 → 이 기기의 등록(IndexedDB)이 있으면 로그인, 없으면 기기 등록 / 서버에 닿지 않음 → 연결 끊김
// (5초마다 다시 묻는다, 체험판으로 가지 않는다). 앱을 쓰는 중 세션이 끝나면(401) 다시 묻고: 로그인 만료면 로그인 화면에 `로그인 만료 ·
// 재로그인 필요`, 끊은 기기면 등록을 지우고 기기 등록으로. 로그아웃은 나가기 화면이 부른다(useSession().logout).
import { API_V2, type SessionInfo, type StaffList, type StaffTile } from '@skinote/contract';
import { DeviceProfileProvider, formatTime } from '@skinote/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EnrollScreen, OfflineScreen } from '../screens/EnrollScreen.tsx';
import { LoginScreen, type PinAnswer } from '../screens/LoginScreen.tsx';
import { App } from './App.tsx';
import { createAuthApi, type AuthApi } from './auth-api.ts';
import { ClientProvider } from './client.tsx';
import { browserDeviceStore, newDeviceKeyPair, publicJwk, signLogin, type DeviceKeyStore, type StoredDevice } from './device-key.ts';
import { HttpClient } from './http-client.ts';
import { go } from './router.ts';
import { probeSession, type RuntimeMode } from './runtime.ts';
import { SessionContext, roleOf, type SessionControls } from './session-context.ts';
import { say } from './strings.ts';

/** 로그인 전 화면의 시간대(D13: 서버는 Asia/Seoul 매장만 연다). 로그인 뒤에는 설정(config)의 값. */
const TIMEZONE = 'Asia/Seoul';
const RETRY_MS = 5_000;
/** 오늘 영업일을 다시 묻는 간격(장부가 바뀌지 않아도). */
const TODAY_REFRESH_MS = 5 * 60_000;

export interface ServerAppProps {
  initial: Exclude<RuntimeMode, { mode: 'demo' }>;
  /** 앱 자리(document.baseURI). */
  baseUrl: string;
  /** 서명 문장의 앱 주소(location.origin). */
  origin: string;
  deviceStore?: DeviceKeyStore;
  authApi?: AuthApi;
  fetchImpl?: typeof fetch;
}

type Gate =
  | { step: 'boot' }
  | { step: 'offline' }
  | { step: 'enroll' }
  | { step: 'login'; device: StoredDevice; notice: string | null }
  | { step: 'ready'; session: SessionInfo; client: HttpClient };

/** 등록 실패 코드 → 한 줄. */
export function enrollLine(code: string): string {
  if (code === 'BAD_CODE' || code === 'BAD_INPUT') return say('enrollBadCode');
  if (code === 'CODE_USED') return say('enrollUsed');
  if (code === 'RATE_LIMITED') return say('tooManyTries');
  return say('sendFailed');
}

/** 비밀번호 실패 코드 → 한 줄(잠김은 풀리는 시각). BUSY = 같은 사람 · 기기의 확인이 도는 중(두 번 누름 · 다른 기기). */
export function pinLine(code: string, lockedUntil: string | undefined, timezone: string): string {
  if (code === 'BAD_PIN') return say('pinWrong');
  if (code === 'LOCKED') return lockedUntil ? say('loginLocked', { time: formatTime(lockedUntil, timezone) }) : say('tooManyTries');
  if (code === 'RATE_LIMITED' || code === 'BUSY') return say('tooManyTries');
  return say('sendFailed');
}

/** 로그인 화면의 답: 잠김이면 풀리는 시각까지 줄을 남기게 시각을 함께 넘긴다. */
export function pinAnswer(code: string, lockedUntil: string | undefined, timezone: string): PinAnswer {
  const line = pinLine(code, lockedUntil, timezone);
  return code === 'LOCKED' && lockedUntil ? { line, lockedUntil } : line;
}

export function ServerApp({ initial, baseUrl, origin, deviceStore, authApi, fetchImpl }: ServerAppProps) {
  const store = useMemo(() => deviceStore ?? browserDeviceStore(), [deviceStore]);
  const api = useMemo(() => authApi ?? createAuthApi(baseUrl, fetchImpl), [authApi, baseUrl, fetchImpl]);
  const [gate, setGate] = useState<Gate>({ step: 'boot' });
  const [today, setToday] = useState<string | null>(null);
  const lastSync = useRef<string | undefined>(undefined);
  const current = useRef<Gate>(gate);
  current.current = gate;

  /** 지금 문(gate)을 바꾼다. 쓰던 HttpClient는 닫는다. */
  const move = useCallback((next: Gate) => {
    const prev = current.current;
    if (prev.step === 'ready' && (next.step !== 'ready' || next.client !== prev.client)) {
      lastSync.current = prev.client.connection().lastSyncAt ?? lastSync.current;
      prev.client.close();
    }
    current.current = next;
    setGate(next);
  }, []);

  const probe = useRef<() => void>(() => {});

  const ready = useCallback((session: SessionInfo) => {
    lastSync.current = new Date().toISOString();
    const client = new HttpClient({ session, baseUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}), onSessionLost: () => probe.current() });
    client.start();
    setToday(null);
    move({ step: 'ready', session, client });
  }, [baseUrl, fetchImpl, move]);

  /** 로그아웃 상태: 이 기기의 등록이 있으면 로그인, 없거나 끊긴 기기면 기기 등록. */
  const signedOut = useCallback(async (code: string | null) => {
    if (code === 'DEVICE_REVOKED') await store.forget();
    const device = await store.load();
    if (!device) move({ step: 'enroll' });
    else move({ step: 'login', device, notice: code === 'SESSION_EXPIRED' ? say('loginExpired') : null });
  }, [move, store]);

  probe.current = () => {
    void probeSession(fetchImpl ?? ((input, init) => globalThis.fetch(input, init)), new URL(API_V2.session, baseUrl).href).then((answer) => {
      if (answer.kind === 'session') ready(answer.session);
      else if (answer.kind === 'signed_out') void signedOut(answer.code);
      else move({ step: 'offline' });
    });
  };

  // 처음: main.tsx가 물어본 답으로 시작한다.
  useEffect(() => {
    if (current.current.step !== 'boot') return;
    if (initial.mode === 'server-offline') move({ step: 'offline' });
    else if (initial.session) ready(initial.session);
    else void signedOut(null);
  }, [initial, move, ready, signedOut]);

  // 기사 기기의 첫 화면은 오늘 영업일이 필요하다: 머리를 받을 때까지 묻고(실패하면 연결 끊김 화면 + 다시 묻기), 그 뒤에도 장부가 바뀔
  // 때마다 · 5분마다 다시 묻는다(기사 세션은 14일이라 밤을 넘긴 태블릿이 06:00 뒤에도 어제 목록으로 가지 않게).
  const readyClient = gate.step === 'ready' ? gate.client : null;
  const [todayFailed, setTodayFailed] = useState(false);
  const askToday = useRef<() => void>(() => {});
  useEffect(() => {
    if (!readyClient) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      readyClient.fetchHead().then((head) => {
        if (!alive) return;
        setTodayFailed(false);
        setToday((prev) => (prev === head.currentBusinessDate ? prev : head.currentBusinessDate));
      }, () => {
        if (!alive) return;
        setTodayFailed(true);
        timer = setTimeout(ask, RETRY_MS);
      });
    };
    askToday.current = ask;
    ask();
    const unsubscribe = readyClient.subscribe(() => ask());
    const every = setInterval(ask, TODAY_REFRESH_MS);
    return () => { alive = false; if (timer) clearTimeout(timer); clearInterval(every); unsubscribe(); };
  }, [readyClient]);

  const enroll = useCallback(async (code: string): Promise<string | null> => {
    let keyPair: CryptoKeyPair;
    let publicKey;
    try {
      keyPair = await newDeviceKeyPair();
      publicKey = await publicJwk(keyPair);
    } catch {
      // 안전하지 않은 주소(https 아님)에서는 WebCrypto가 없다.
      return say('sendFailed');
    }
    const answer = await api.enroll(code, publicKey, typeof navigator === 'undefined' ? '' : navigator.userAgent);
    if (!answer.ok) return enrollLine(answer.code);
    const device: StoredDevice = { ...answer.value, keyPair };
    await store.save(device);
    move({ step: 'login', device, notice: null });
    return null;
  }, [api, move, store]);

  const logout = useCallback(async () => {
    const g = current.current;
    if (g.step !== 'ready') return;
    await g.client.logout();
    // 다음 사람은 나가기 화면이 아니라 기기의 첫 화면(장부 · 수거 목록)에서 시작한다: 처음 화면(#/)으로 두면 로그인 뒤 첫 화면으로 간다.
    // 세션이 저절로 끝난 때(로그인 만료)는 여기로 오지 않는다: 그 사람은 보던 화면으로 돌아간다.
    go({ name: 'start' }, { replace: true });
    await signedOut(null);
  }, [signedOut]);

  const retry = useCallback(() => probe.current(), []);
  const deviceGone = useCallback(() => { void signedOut('DEVICE_REVOKED'); }, [signedOut]);

  const retryToday = useCallback(() => askToday.current(), []);
  const controls = useMemo<SessionControls | null>(
    () => (gate.step === 'ready' ? { info: gate.session, today, todayFailed, retryToday, lastSyncAt: gate.client.connection().lastSyncAt, logout } : null),
    [gate, today, todayFailed, retryToday, logout],
  );

  if (gate.step === 'ready' && controls) {
    return (
      <SessionContext.Provider value={controls}>
        <ClientProvider key={gate.session.csrf} client={gate.client}>
          <App />
        </ClientProvider>
      </SessionContext.Provider>
    );
  }
  const role = gate.step === 'login' ? roleOf(gate.device.kind) : 'counter';
  return (
    <DeviceProfileProvider role={role} timezone={TIMEZONE}>
      {gate.step === 'offline' ? <OfflineScreen lastSyncAt={lastSync.current} onRetry={retry} /> : null}
      {gate.step === 'enroll' ? <EnrollScreen onSubmit={enroll} /> : null}
      {gate.step === 'login' ? (
        <LoginGate
          key={gate.device.deviceId}
          device={gate.device}
          notice={gate.notice}
          api={api}
          origin={origin}
          onSession={ready}
          onDeviceGone={deviceGone}
        />
      ) : null}
    </DeviceProfileProvider>
  );
}

type StaffLoad = { kind: 'list'; list: StaffList } | { kind: 'gone' } | { kind: 'failed' };

/** 로그인 화면의 서버 몫: 한 번 값에 서명 → 직원 타일 · 로그인 표, 비밀번호 보내기. */
function LoginGate({ device, notice, api, origin, onSession, onDeviceGone }: {
  device: StoredDevice;
  notice: string | null;
  api: AuthApi;
  origin: string;
  onSession: (session: SessionInfo) => void;
  onDeviceGone: () => void;
}) {
  const [list, setList] = useState<StaffList | null>(null);
  const [note, setNote] = useState<string | null>(notice);
  const ticket = useRef<string | null>(null);

  const load = useCallback(async (): Promise<StaffLoad> => {
    const challenge = await api.challenge(device.deviceId);
    if (!challenge.ok) return challenge.code === 'DEVICE_UNKNOWN' || challenge.code === 'DEVICE_REVOKED' ? { kind: 'gone' } : { kind: 'failed' };
    let signature: string;
    try {
      signature = await signLogin(device.keyPair.privateKey, origin, device.deviceId, challenge.value.nonce);
    } catch {
      return { kind: 'failed' };
    }
    const staff = await api.staff(device.deviceId, challenge.value.nonce, signature);
    if (staff.ok) return { kind: 'list', list: staff.value };
    return staff.code === 'DEVICE_UNKNOWN' || staff.code === 'DEVICE_REVOKED' ? { kind: 'gone' } : { kind: 'failed' };
  }, [api, device, origin]);

  const take = useCallback((result: StaffLoad): boolean => {
    if (result.kind === 'gone') {
      onDeviceGone();
      return false;
    }
    if (result.kind === 'failed') {
      setNote(say('findFailed'));
      return false;
    }
    ticket.current = result.list.ticket;
    setList(result.list);
    return true;
  }, [onDeviceGone]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      void load().then((result) => {
        if (!alive) return;
        if (take(result)) setNote(notice);
        else if (result.kind === 'failed') timer = setTimeout(run, RETRY_MS);
      });
    };
    run();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [load, take, notice]);

  const onPin = useCallback(async (tile: StaffTile, pin: string): Promise<PinAnswer> => {
    const held = ticket.current;
    if (!held) return say('findFailed');
    let answer = await api.login(held, tile.id, pin);
    if (!answer.ok && answer.code === 'BAD_TICKET') {
      // 로그인 표는 5분이다: 새로 받아 같은 비밀번호로 한 번 더.
      const again = await load();
      if (!take(again)) return again.kind === 'gone' ? null : say('findFailed');
      answer = await api.login(ticket.current ?? '', tile.id, pin);
    }
    if (answer.ok) {
      onSession(answer.value);
      return null;
    }
    if (answer.code === 'DEVICE_REVOKED' || answer.code === 'DEVICE_UNKNOWN') {
      onDeviceGone();
      return null;
    }
    if (answer.code === 'UNKNOWN_STAFF') {
      // 직원 목록이 바뀌었다: 다시 받는다.
      take(await load());
      return say('findFailed');
    }
    return pinAnswer(answer.code, answer.lockedUntil, TIMEZONE);
  }, [api, load, onDeviceGone, onSession, take]);

  return <LoginScreen shopName={list?.shopName ?? ''} staff={list?.staff ?? null} note={note} onPin={onPin} />;
}

// 서버 모드의 앱(계획 work/impl-server/plan.md 6-1 · 6-3). 세션이 생길 때까지 등록 · 로그인 · 연결 끊김 화면을 보이고, 로그인하면
// HttpClient를 만들어 체험판과 같은 앱(App)을 그 클라이언트로 그린다. 이 파일과 HttpClient · 기기 열쇠 · 등록 · 로그인 화면은 서버
// 모드에서만 받는 묶음이다(체험판은 받지 않는다).
//
// 흐름: 세션 있음 → 앱 / 로그아웃 상태 → 이 기기의 등록(IndexedDB)이 있으면 로그인, 없으면 서버에 등록 방법을 묻고 기기 등록(등록 번호)
// 또는 기기 선택(시험 매장의 열린 등록: 종류 · 차량을 골라 스스로 등록) / 서버에 닿지 않음 → 연결 끊김(5초마다 다시 묻는다, 체험판으로
// 가지 않는다). 앱을 쓰는 중 세션이 끝나면(401) 다시 묻고: 로그인 만료면 로그인 화면에 `로그인 만료 · 재로그인 필요`, 끊은 기기면 등록을
// 지우고 기기 등록 · 기기 선택으로. 로그아웃은 나가기 화면이 부른다(useSession().logout).
// 기기 종류를 모르는 첫 화면(기기 등록 · 기기 선택 · 연결 끊김)은 휴대폰 폭이면 기사 등급(휴대폰)으로, 아니면 카운터 등급으로 그린다.
// 기기 선택에서 기사 기기를 고른 뒤의 차량 선택은 기사 등급이다(태블릿 크기에서도 56px 누르는 곳).
// 기기 등록 · 기기 선택 화면은 30초마다와 화면이 다시 보일 때 등록 방법을 다시 묻는다(서버 설정을 켬 · 끔 · 기한이 지남을 따른다).
// 기기 선택이 번호 등록으로 바뀌면(설정을 끔 · 기한 지남) 숫자판에 한 줄 `기기 선택 종료 · 등록 번호 필요`를 남긴다.
// 열린 등록으로 스스로 붙은 기기의 로그인 화면은 종류 · 차량을 한 줄에 보이고 `기기 선택`(open-release: 등록을 끊고 기기 선택으로)을 둔다.
// 기사 기기(work/impl-offline/plan.md §7-7): 서버가 기사 기기의 운영 값(policy)과 세션 id를 주면 DriverClient(사본 + 보냄 대기, 따로 받는 묶음
// local/start.ts)로 돈다. 기기 저장소를 열 수 없으면 HttpClient로(연결된 동안만). 보낼 기록이 남은 동안은 기기 열쇠를 잊지 않고(끊은 기기 · 모르는 기기 ·
// 기기 선택), 로그아웃은 `로그아웃 불가 · 전송 대기 {n}` 한 줄을 돌려준다.
// 앱 시작(O15): 기억한 세션이 유효한 기사 기기는 main.tsx가 server-local로 연다 — 서버를 기다리지 않고 DriverClient로 곧바로 목록(서버 묻기는 뒤에서,
// 다른 세션이면 새로 연다). 앱 잠금 때면(켜질 때 · 뒤에서 돌아올 때 마지막 사용에서 app_lock_minutes가 지남) 기억한 기사의 비밀번호 판을 목록 대신
// 보이고(보내기는 뒤에서 계속), 기기에서 확인 값으로 본다. 다섯 번 틀릴 때마다 `로그인 잠김 · {시각} 이후 가능`(5 · 10 · 20 …분, 숫자 키를 누를 수
// 없음): 연결되어 있으면 평소 로그인(직원 타일 · 서버 비밀번호)도 된다. 판의 줄은 이 기기의 `전송 대기 {n}`(§17 R3-24).
// 잠금은 닫힌 쪽으로(§17 R3-7): 방금 비밀번호로 로그인한 것이 아니면 서버가 세션을 주어도 목록을 그리기 전에 잠금 때인지 보고, 기기에서 풀 수 없으면
// (확인 값 없음 · 기사 역할이 아님 · 시계가 뒤로 감) 온라인 로그인이다. 서버에 닿지 못한 로그아웃의 세션이면 먼저 서버 로그아웃을 보내고 열지 않는다.
// 세션이 끝나면(로그아웃 상태 · 만료 · 끊은 · 모르는 기기) 이름 · 번호가 든 사본과 세션 칸을 지운다(§17 R3-9, 끊은 · 모르는 기기는 보낼 기록이 없으면 모두).
// 온라인 로그인이 된 바로 뒤 친 비밀번호로 확인 값을 만들고(기사 역할만), 같은 차량의 다른 기기가 보낼 기록을 가졌으면 목록에서 한 번 알린다.
// 연결 끊김 화면은 이 기기의 `전송 대기 {n}`, 되살린 서버가 모르는 기기면 `기기 등록 없음 · 공급자 연락`, 저장할 곳이 없으면 `이 기기 저장 불가`.
import {
  API_V2, isDriverDevice,
  type DeviceKind, type DomainClient, type EnrollMode, type EnrollVehicle, type HeadInfo, type SessionInfo, type StaffList, type StaffTile,
} from '@skinote/contract';
import { DEVICE_PROFILES, DeviceProfileProvider, formatTime, pickDeviceClass, t, useViewportSize, type DeviceRole } from '@skinote/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChooseScreen } from '../screens/ChooseScreen.tsx';
import { EnrollScreen, OfflineScreen } from '../screens/EnrollScreen.tsx';
import { LoginScreen, type PinAnswer } from '../screens/LoginScreen.tsx';
import { App } from './App.tsx';
import { createAuthApi, type AuthAnswer, type AuthApi } from './auth-api.ts';
import { ClientProvider, type ServerControls } from './client.tsx';
import { browserDeviceStore, newDeviceKeyPair, publicJwk, signLogin, type DeviceKeyStore, type StoredDevice } from './device-key.ts';
import { HttpClient } from './http-client.ts';
import { go } from './router.ts';
import { setUpdateBlocker } from './pwa.ts';
import { probeSession, type RuntimeMode } from './runtime.ts';
import { SessionContext, lockPadNote, roleOf, type SessionControls } from './session-context.ts';
import { localWords, say } from './strings.ts';
import type { LockStatus, UnlockResult } from '../local/driver-client.ts';

/** 로그인 전 화면의 시간대(D13: 서버는 Asia/Seoul 매장만 연다). 로그인 뒤에는 설정(config)의 값. */
const TIMEZONE = 'Asia/Seoul';
const RETRY_MS = 5_000;
/** 기기 등록 · 기기 선택 화면이 등록 방법을 다시 묻는 간격. */
const MODE_REFRESH_MS = 30_000;
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

type DriverKind = Exclude<DeviceKind, 'pos'>;

/** 기사 기기(DriverClient)의 앱 잠금(O15 d). HttpClient에는 없다. */
export interface LockControls {
  setVerifier(pin: string): Promise<void>;
  lockDue(atStart?: boolean): Promise<LockStatus>;
  unlock(pin: string): Promise<UnlockResult>;
  noteUse(): void;
}

/** 로그인한 세션의 클라이언트: 카운터는 HttpClient, 기사 기기는 DriverClient(사본 + 보냄 대기). */
export type ServerClient = DomainClient & Partial<ServerControls> & Partial<LockControls> & {
  close(): void;
  /** 보내는 중 · 사본을 받는 중(새 판 바꾸기를 미룬다, pwa.ts). 기사 기기만. */
  busy?(): boolean;
  fetchHead(): Promise<HeadInfo>;
  /** 세션을 끝낸다. 한 줄(문자열)이면 끝내지 않았다(`로그아웃 불가 · 전송 대기 {n}`). */
  logout(): Promise<string | null | void>;
};

/**
 * 앱 잠금의 모양: 기억한 기사의 비밀번호 판, 또는 기기에서 풀 수 없어 온라인 로그인(needLogin: 연결되어 있으면 로그인 화면, 끊겼으면 `로그인 잠김 · 연결
 * 후 가능`). until이면 틀려서 그 시각까지 잠김(`로그인 잠김 · {시각} 이후 가능`).
 */
export interface LockState {
  needLogin: boolean;
  until?: number;
}

/**
 * 기사 기기의 세션을 열 때의 잠금(§17 R3-7, 닫힌 쪽으로): 기억한 세션의 잠금(locked)이면 그대로, 방금 비밀번호로 로그인했으면(pin) 없음. 그 밖(서버
 * 묻기가 세션을 줌 · 기억한 세션으로 곧바로 엶)은 목록을 그리기 전에 기기에 묻고, 기기에서 풀 수 없거나(확인 값 없음 · 기사 역할이 아님 · 시계가 뒤로
 * 감) 저장소가 없거나 묻기가 던지면 온라인 로그인(needLogin). 서버의 세션만으로는 목록을 열지 않는다.
 */
export async function startLock(opts: { pin?: string; locked?: LockState }, client: Partial<Pick<LockControls, 'lockDue'>> | null): Promise<LockState | null> {
  if (opts.locked) return opts.locked;
  if (opts.pin) return null;
  const status: LockStatus = client?.lockDue ? await client.lockDue(true).catch(() => ({ due: true, needLogin: true })) : { due: true, needLogin: true };
  return status.due ? { needLogin: status.needLogin, ...(status.until !== undefined ? { until: status.until } : {}) } : null;
}

/** 잠금 판 대신 평소 로그인(직원 타일 · 서버 비밀번호)으로 갈지: 연결되어 있고, 기기에서 풀 수 없거나 틀려서 잠긴 동안. */
export const lockNeedsServer = (lock: LockState, online: boolean, now: number): boolean =>
  online && (lock.needLogin || (lock.until !== undefined && lock.until > now));

/**
 * 앱 잠금 판의 답(순수, 시험): 맞음 → 풀림(null), 틀림 → `비밀번호 불일치 · 재입력 필요`, 틀려서 잠김 → `로그인 잠김 · {시각} 이후 가능`(풀리는 시각까지
 * 줄이 남음), 기기에서 풀 수 없음 → `로그인 잠김 · 연결 후 가능`.
 */
export function unlockLine(result: UnlockResult, timezone: string): PinAnswer {
  if (result.answer === 'ok') return null;
  if (result.answer === 'wrong') return say('pinWrong');
  if (result.answer === 'locked' && result.until !== undefined) {
    const at = new Date(result.until).toISOString();
    return { line: say('loginLocked', { time: formatTime(at, timezone) }), lockedUntil: at };
  }
  return say('lockOffline');
}

/** 앱 잠금 판의 줄: 기기에서 풀 수 없음 · 틀려서 잠긴 동안(시각이 지났으면 없음). */
const lockLine = (lock: LockState, timezone: string, now: number): string | undefined => {
  if (lock.needLogin) return say('lockOffline');
  if (lock.until !== undefined && lock.until > now) return say('loginLocked', { time: formatTime(new Date(lock.until).toISOString(), timezone) });
  return undefined;
};


/** 기사 기기를 DriverClient로 돌릴지: 기사 기기이고 서버가 운영 값 · 세션 id를 준다(옛 서버는 HttpClient). */
export const driverLocal = (session: SessionInfo): boolean => isDriverDevice(session.device.kind) && !!session.policy && !!session.session;

export type Gate =
  | { step: 'boot' }
  | { step: 'offline'; pending?: number; notice?: string; driver?: boolean }
  | { step: 'enroll'; notice?: string }
  | { step: 'choose'; vehicles: readonly EnrollVehicle[]; kind: DriverKind | null }
  | { step: 'login'; device: StoredDevice; notice: string | null; pending: number }
  | { step: 'ready'; session: SessionInfo; client: ServerClient };

/**
 * 등록 방법 묻기의 답 → 첫 화면. open: 기기 선택(차량), code: 기기 등록, 옛 서버(이 길이 없음: 404 · 405)도 기기 등록. 그 밖의 실패
 * (연결 없음 · 주소마다 제한 429 · 서버 오류 5xx …)는 연결 끊김: 5초마다 다시 묻는다(한 번 막혔다고 번호 화면에 묶이지 않게).
 */
export function enrollGate(answer: AuthAnswer<EnrollMode>): { step: 'enroll' } | { step: 'offline' } | { step: 'choose'; vehicles: readonly EnrollVehicle[] } {
  if (answer.ok) return answer.value.mode === 'open' ? { step: 'choose', vehicles: answer.value.vehicles } : { step: 'enroll' };
  if (answer.status === 404 || answer.status === 405) return { step: 'enroll' };
  return { step: 'offline' };
}

/**
 * 등록 방법 답의 첫 화면을 문(gate)으로(기기 선택은 아직 종류를 고르지 않음). 기기 선택에서 번호 등록으로 바뀐 것이면(closed) 숫자판에
 * `기기 선택 종료 · 등록 번호 필요`.
 */
export function gateOf(next: ReturnType<typeof enrollGate>, closed = false): Gate {
  if (next.step === 'choose') return { ...next, kind: null };
  return next.step === 'enroll' && closed ? { step: 'enroll', notice: say('chooseClosed') } : next;
}

/** 차량 목록이 같은지(id · 이름). */
const sameVehicles = (a: readonly EnrollVehicle[], b: readonly EnrollVehicle[]) =>
  a.length === b.length && a.every((v, i) => v.id === b[i]?.id && v.name === b[i]?.name);

/** 스스로 붙은 기기의 로그인 줄에 더할 기기 모양: 종류 이름(처음 화면의 말) · 기사 기기의 차량 이름. */
export function openDeviceLine(kind: DeviceKind, vehicleName: string | undefined): string {
  const name = say(kind === 'pos' ? 'startCounter' : kind === 'driver_phone' ? 'startPhone' : 'startTablet');
  return vehicleName ? name + ' · ' + vehicleName : name;
}

/** 열린 등록 실패 코드 → 한 줄. 끝 수 · 시도 초과 · 차량 · 전송 실패. */
export function openEnrollLine(code: string): string {
  if (code === 'DEVICE_LIMIT') return say('deviceLimit');
  if (code === 'RATE_LIMITED') return say('tooManyTries');
  if (code === 'BAD_VEHICLE' || code === 'BAD_INPUT') return say('commandFailed');
  return say('sendFailed');
}

/**
 * 기기 종류를 모르는 첫 화면의 역할: 휴대폰 폭(기사 등급이면 휴대폰이 되는 폭)이면 기사(휴대폰 등급: 56px 누르는 곳), 아니면 카운터.
 * 규칙 검사기는 이 화면들을 휴대폰 크기에서 기사 등급으로 잰다(#/preview/enroll · choose ?device=phone).
 */
export function firstVisitRole(viewport: { width: number; height: number }): DeviceRole {
  return pickDeviceClass(viewport, 'driver') === 'driver_phone' ? 'driver' : 'counter';
}

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
  const viewport = useViewportSize(DEVICE_PROFILES.pos.checkSizes[0] ?? { width: 1024, height: 600 });
  const [today, setToday] = useState<string | null>(null);
  const lastSync = useRef<string | undefined>(undefined);
  /** 앱 잠금(기사 기기): 목록 대신 기억한 기사의 비밀번호 판. 클라이언트는 뒤에서 계속 돈다. */
  const [lock, setLock] = useState<LockState | null>(null);
  /** 같은 차량의 다른 기기가 보낼 기록을 가짐(로그인 답, 목록이 한 번 알린다). */
  const [elsewhere, setElsewhere] = useState<SessionInfo['vanPendingElsewhere'] | null>(null);
  /** 이 기기에 저장할 곳이 없다(기사 기기: 연결 끊김 기록을 하지 못함). */
  const noLocal = useRef(false);
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
  /** 이 기기에 서버로 가지 않은 기록 수(기사 기기의 보냄 대기). 없거나 열 수 없으면 0. */
  const pendingHere = useCallback(async (): Promise<number> => {
    try {
      const { localPendingCount } = await import('../local/start.ts');
      return await localPendingCount();
    } catch {
      return 0;
    }
  }, []);

  /** 만드는 중인 클라이언트의 차례(늦게 끝난 옛 만들기가 새 세션을 덮지 않게). */
  const making = useRef(0);

  /**
   * 세션으로 앱을 연다. pin: 온라인 로그인에서 친 비밀번호(기사 기기의 앱 잠금 확인 값을 만든다), locked: 앱 잠금 판으로 연다(기억한 세션),
   * login: 로그인 답(같은 차량의 다른 기기 알림).
   */
  const signedOutRef = useRef<(code: string | null) => void>(() => {});
  const ready = useCallback((session: SessionInfo, opts: { pin?: string; locked?: LockState; login?: boolean; remembered?: boolean } = {}) => {
    lastSync.current = new Date().toISOString();
    const turn = ++making.current;
    if (opts.login) setElsewhere(session.vanPendingElsewhere ?? null);
    const http = () => {
      const client = new HttpClient({ session, baseUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}), onSessionLost: () => probe.current() });
      client.start();
      return client;
    };
    setToday(null);
    if (!driverLocal(session)) {
      setLock(null);
      move({ step: 'ready', session, client: http() });
      return;
    }
    // 기사 기기: 사본 + 보냄 대기(따로 받는 묶음). 저장소를 열 수 없으면 HttpClient(연결된 동안만).
    void (async () => {
      if (!opts.pin) {
        // 서버에 닿지 못한 로그아웃의 세션(§17 R3-7): 먼저 서버 로그아웃을 보내고 이 세션은 열지 않는다(로그인 화면으로).
        const { pendingSignOut } = await import('../local/start.ts');
        if (await pendingSignOut(session, baseUrl, fetchImpl)) {
          if (turn === making.current) signedOutRef.current(null);
          return;
        }
      }
      let client: ServerClient | null = null;
      try {
        const device = await store.load();
        if (device) {
          const { openDriverClient } = await import('../local/start.ts');
          client = await openDriverClient({
            session, baseUrl, origin, deviceKey: device.keyPair.privateKey, ...(fetchImpl ? { fetchImpl } : {}), onSessionLost: () => probe.current(), words: localWords(),
            makeHttp: (options) => new HttpClient(options), auth: api, ...(opts.remembered ? { remembered: true } : {}),
          });
        }
      } catch {
        client = null;
      }
      if (turn !== making.current) {
        client?.close();
        return;
      }
      noLocal.current = client === null;
      if (client && opts.pin) void client.setVerifier?.(opts.pin);
      // 앱 잠금은 닫힌 쪽으로(§17 R3-7): 방금 비밀번호로 로그인한 것이 아니면 목록을 그리기 전에 잠금 때인지 본다. 기기에서 풀 수 없으면(확인 값 없음 ·
      // 저장할 곳 없음) 온라인 로그인.
      const locked = await startLock(opts, client);
      if (turn !== making.current) {
        client?.close();
        return;
      }
      setLock(locked);
      move({ step: 'ready', session, client: client ?? http() });
    })();
  }, [api, baseUrl, fetchImpl, move, origin, store]);

  /** 연결 끊김 화면(이 기기의 보낼 기록 수, 한 줄). */
  const toOffline = useCallback(async (notice?: string) => {
    const pending = await pendingHere();
    const line = notice ?? (noLocal.current ? say('recordingOff') : undefined);
    // 기사 기기(이 기기의 등록 종류): 목록 · 번호는 연결될 때까지 볼 수 없다는 한 줄(§17 R3-30).
    const driver = isDriverDevice((await store.load().catch(() => null))?.kind ?? 'pos');
    move({ step: 'offline', ...(pending > 0 ? { pending } : {}), ...(line ? { notice: line } : {}), ...(driver ? { driver } : {}) });
  }, [move, pendingHere, store]);


  /** 등록이 없는 기기의 첫 화면: 서버에 등록 방법을 물어 기기 등록(번호) · 기기 선택(열린 등록) · 연결 끊김. */
  const toEnroll = useCallback(async () => {
    move(gateOf(enrollGate(await api.enrollMode())));
  }, [api, move]);

  // 기기 등록 · 기기 선택 화면이 열려 있는 동안 등록 방법이 바뀌면 따른다(30초마다 · 화면이 다시 보일 때). 잠깐의 실패로는 옮기지 않는다.
  const gateStep = gate.step;
  useEffect(() => {
    if (gateStep !== 'enroll' && gateStep !== 'choose') return undefined;
    let alive = true;
    const ask = () => {
      void api.enrollMode().then((answer) => {
        const g = current.current;
        if (!alive || (g.step !== 'enroll' && g.step !== 'choose')) return;
        const next = enrollGate(answer);
        if (next.step === 'offline') return;
        if (next.step !== g.step) move(gateOf(next, g.step === 'choose'));
        else if (next.step === 'choose' && g.step === 'choose' && !sameVehicles(next.vehicles, g.vehicles)) move({ ...g, vehicles: next.vehicles });
      });
    };
    const timer = setInterval(ask, MODE_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') ask(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [gateStep, api, move]);

  /**
   * 로그아웃 상태: 이 기기의 등록이 있으면 로그인, 없거나 끊긴 기기면 기기 등록 · 기기 선택. 서버로 가지 않은 기록이 남았으면 기기 열쇠를 잊지 않는다
   * (O14 h: 나중에 보낼 수 있게): 끊긴 기기는 연결 끊김 화면에서 다시 묻는다.
   */
  const signedOut = useCallback(async (code: string | null) => {
    const pending = await pendingHere();
    const gone = code === 'DEVICE_REVOKED' || code === 'DEVICE_UNKNOWN';
    // 세션이 없다: 이름 · 번호가 든 사본 · 기억한 세션 · 확인 값을 지운다(§17 R3-9, DriverClient가 돌지 않아도). 끊은 · 모르는 기기는 보낼 기록이 없으면
    // 모두(저장소가 같은 트랜잭션에서 다시 본다).
    try {
      const { clearLocalAfterSignOut } = await import('../local/start.ts');
      await clearLocalAfterSignOut(gone && pending === 0);
    } catch {
      // 저장소 없음: 지울 것도 없다.
    }
    if (gone) {
      if (pending > 0) {
        // 보낼 기록이 남았다: 기기 열쇠 · 보냄 대기를 지우지 않고 연결 끊김 화면(모르는 기기는 `기기 등록 없음 · 공급자 연락`, O14 h).
        move({ step: 'offline', pending, driver: true, ...(code === 'DEVICE_UNKNOWN' ? { notice: say('deviceUnknown') } : {}) });
        return;
      }
      await store.forget();
    }
    const device = await store.load();
    if (!device) await toEnroll();
    else move({ step: 'login', device, notice: code === 'SESSION_EXPIRED' ? say('loginExpired') : null, pending });
  }, [move, pendingHere, store, toEnroll]);
  signedOutRef.current = (code) => { void signedOut(code); };

  probe.current = () => {
    void probeSession(fetchImpl ?? ((input, init) => globalThis.fetch(input, init)), new URL(API_V2.session, baseUrl).href).then((answer) => {
      if (answer.kind === 'session') ready(answer.session);
      else if (answer.kind === 'signed_out') void signedOut(answer.code);
      else void toOffline();
    });
  };

  // 처음: main.tsx가 물어본 답으로 시작한다. 기억한 세션(server-local)은 서버를 기다리지 않고 열고, 서버 묻기는 뒤에서 한다(다른 세션이면 그것으로
  // 새로 연다. 끝난 세션은 DriverClient의 심장 박동이 401로 알고 보낸 뒤 로그인으로 간다).
  useEffect(() => {
    if (current.current.step !== 'boot') return;
    if (initial.mode === 'server-local') {
      const { start } = initial;
      // 서버 없이 연다(§18 R4-13): 띠의 마지막 연결은 기기 메모의 때, 첫 답까지 끊김.
      ready(start.session, { remembered: true, ...(start.decision === 'locked' ? { locked: { needLogin: false, ...(start.lockUntil !== undefined ? { until: start.lockUntil } : {}) } } : {}) });
      void probeSession(fetchImpl ?? ((input, init) => globalThis.fetch(input, init)), new URL(API_V2.session, baseUrl).href).then((answer) => {
        const g = current.current;
        if (answer.kind === 'session' && g.step === 'ready' && answer.session.session?.id !== g.session.session?.id) ready(answer.session);
      });
    } else if (initial.mode === 'server-offline') void toOffline();
    else if (initial.session) ready(initial.session);
    else void signedOut(null);
  }, [initial, move, ready, signedOut, toOffline, fetchImpl, baseUrl]);

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
    move({ step: 'login', device, notice: null, pending: 0 });
    return null;
  }, [api, move, store]);

  /** 열린 등록(기기 선택): 새 열쇠 + 고른 종류 · 차량. 되면 로그인 화면, 꺼졌으면 등록 방법을 다시 물어 기기 등록으로. */
  const chooseDevice = useCallback(async (kind: DeviceKind, vehicleId?: string): Promise<string | null> => {
    let keyPair: CryptoKeyPair;
    let publicKey;
    try {
      keyPair = await newDeviceKeyPair();
      publicKey = await publicJwk(keyPair);
    } catch {
      return say('sendFailed');
    }
    const answer = await api.openEnroll(kind, vehicleId, publicKey, typeof navigator === 'undefined' ? '' : navigator.userAgent);
    if (answer.ok) {
      const device: StoredDevice = { ...answer.value, keyPair };
      await store.save(device);
      move({ step: 'login', device, notice: null, pending: 0 });
      return null;
    }
    if (answer.code === 'ENROLL_CLOSED') {
      // 열린 등록이 꺼졌다(설정을 끔 · 기한 지남): 등록 방법을 다시 물어 숫자판으로, 한 줄로 까닭을 남긴다.
      move(gateOf(enrollGate(await api.enrollMode()), true));
      return null;
    }
    if (answer.code === 'BAD_VEHICLE') {
      // 차량 목록이 바뀌었다: 등록 방법을 다시 받아 그린다(여전히 기기 선택이면 고른 종류 그대로 한 줄을 남긴다).
      const again = enrollGate(await api.enrollMode());
      const g = current.current;
      move(again.step === 'choose' ? { ...again, kind: g.step === 'choose' ? g.kind : null } : gateOf(again, true));
      if (again.step !== 'choose') return null;
    }
    return openEnrollLine(answer.code);
  }, [api, move, store]);

  /** 기기 선택의 종류(기사 기기를 고르면 차량 선택: 기사 등급으로 그린다, null이면 종류 버튼으로). */
  const chooseKind = useCallback((kind: DriverKind | null) => {
    const g = current.current;
    if (g.step === 'choose' && g.kind !== kind) move({ ...g, kind });
  }, [move]);

  const logout = useCallback(async (): Promise<string | null> => {
    const g = current.current;
    if (g.step !== 'ready') return null;
    // 기사 기기에 보낼 기록이 남으면 끝내지 않고 한 줄(`로그아웃 불가 · 전송 대기 {n}`, O14 c).
    const refused = await g.client.logout();
    if (typeof refused === 'string') return refused;
    // 다음 사람은 나가기 화면이 아니라 기기의 첫 화면(장부 · 수거 목록)에서 시작한다: 처음 화면(#/)으로 두면 로그인 뒤 첫 화면으로 간다.
    // 세션이 저절로 끝난 때(로그인 만료)는 여기로 오지 않는다: 그 사람은 보던 화면으로 돌아간다.
    go({ name: 'start' }, { replace: true });
    await signedOut(null);
    return null;
  }, [signedOut]);

  const retry = useCallback(() => probe.current(), []);
  const deviceGone = useCallback((code: string = 'DEVICE_REVOKED') => { void signedOut(code); }, [signedOut]);
  /** 온라인 로그인이 되었다(비밀번호가 메모리에 있는 그때: 기사 기기의 앱 잠금 확인 값). */
  const loggedIn = useCallback((session: SessionInfo, pin?: string) => ready(session, { ...(pin ? { pin } : {}), login: true }), [ready]);

  // 기사 기기가 보내는 중이면 새 판 바꾸기를 미룬다(O6).
  const busyClient = gate.step === 'ready' && gate.client.busy ? gate.client : null;
  useEffect(() => {
    if (!busyClient?.busy) return undefined;
    setUpdateBlocker(() => busyClient.busy?.() ?? false);
    return () => setUpdateBlocker(null);
  }, [busyClient]);

  // 기사 기기의 앱 잠금(O15 d): 누름 · 키마다 마지막 사용(1분에 한 번 적음), 뒤로 가면 적고, 돌아오면 잠글 때인지 본다.
  const lockClient = gate.step === 'ready' && gate.client.lockDue ? gate.client : null;
  useEffect(() => {
    const client = lockClient;
    if (!client?.noteUse || !client.lockDue) return undefined;
    let last = 0;
    const onUse = () => {
      const now = Date.now();
      if (now - last < 60_000) return;
      last = now;
      client.noteUse?.();
    };
    const onVisible = () => {
      if (document.visibilityState === 'hidden') { client.noteUse?.(); last = Date.now(); return; }
      void client.lockDue?.().then((l) => {
        const g = current.current;
        if (l.due && g.step === 'ready' && g.client === client) setLock({ needLogin: l.needLogin, ...(l.until !== undefined ? { until: l.until } : {}) });
      });
    };
    window.addEventListener('pointerdown', onUse, { capture: true, passive: true });
    window.addEventListener('keydown', onUse, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('pointerdown', onUse, { capture: true });
      window.removeEventListener('keydown', onUse, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [lockClient]);

  // 잠금 판: 연결 상태 · 전송 대기를 따라 다시 그리고, 기기에서 풀 수 없거나 틀려서 잠긴 동안 연결되면 평소 로그인(직원 타일 · 서버 비밀번호)으로 간다.
  const [lockDevice, setLockDevice] = useState<StoredDevice | null | undefined>(undefined);
  const [, redrawLock] = useState(0);
  const lockedClient = lock && gate.step === 'ready' ? gate.client : null;
  useEffect(() => {
    if (!lockedClient) return undefined;
    let alive = true;
    void store.load().then((device) => { if (alive) setLockDevice(device); });
    const off = lockedClient.subscribe(() => redrawLock((n) => n + 1));
    return () => { alive = false; off(); };
  }, [lockedClient, store]);
  // 틀려서 잠긴 시각이 지나면 판의 줄을 걷는다(비밀번호 판은 그대로).
  const lockUntil = lock?.until;
  useEffect(() => {
    if (lockUntil === undefined) return undefined;
    const timer = setTimeout(() => setLock((l) => (l && l.until === lockUntil ? { needLogin: l.needLogin } : l)), Math.max(0, lockUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [lockUntil]);
  // 기기에서 풀 수 없는데 이 기기의 등록도 없다(기기 열쇠를 잃음): 로그인할 길이 없으니 로그아웃 상태로(등록 화면).
  const needLogin = lock?.needLogin === true;
  useEffect(() => {
    if (needLogin && lockDevice === null) signedOutRef.current(null);
  }, [needLogin, lockDevice]);

  const unlockPin = useCallback(async (_tile: StaffTile, pin: string): Promise<PinAnswer> => {
    const g = current.current;
    if (g.step !== 'ready' || !g.client.unlock) return say('sendFailed');
    const result = await g.client.unlock(pin);
    if (result.answer === 'ok') setLock(null);
    else if (result.answer === 'login') setLock({ needLogin: true });
    else if (result.answer === 'locked') setLock({ needLogin: false, ...(result.until !== undefined ? { until: result.until } : {}) });
    return unlockLine(result, TIMEZONE);
  }, []);

  const retryToday = useCallback(() => askToday.current(), []);
  const dismissElsewhere = useCallback(() => setElsewhere(null), []);
  const controls = useMemo<SessionControls | null>(
    () => (gate.step === 'ready'
      ? {
          info: gate.session, today, todayFailed, retryToday, lastSyncAt: gate.client.connection().lastSyncAt, logout,
          ...(elsewhere ? { elsewhere, dismissElsewhere } : {}),
        }
      : null),
    [gate, today, todayFailed, retryToday, logout, elsewhere, dismissElsewhere],
  );

  if (gate.step === 'ready' && lock) {
    const tile: StaffTile = { id: gate.session.staff.id, name: gate.session.staff.name };
    const conn = gate.client.connection();
    const now = Date.now();
    const line = lockLine(lock, TIMEZONE, now);
    // 기기에서 풀 수 없거나 틀려서 잠긴 동안 연결되어 있으면 평소 로그인(서버 비밀번호 · 서버의 잠김).
    const relogin = lockNeedsServer(lock, conn.online, now) && lockDevice ? lockDevice : null;
    return (
      <DeviceProfileProvider role="driver" timezone={TIMEZONE}>
        {relogin ? (
          <LoginGate
            key={'relogin:' + relogin.deviceId}
            device={relogin}
            notice={null}
            api={api}
            origin={origin}
            onSession={loggedIn}
            onDeviceGone={deviceGone}
            pending={conn.pendingCount}
          />
        ) : (
          <LoginScreen
            key={'lock:' + tile.id}
            shopName={gate.session.shop.name}
            staff={[tile]}
            openFor={tile}
            // 판 뒤에서 보내기는 이어진다: 이 기기의 보낼 기록 수를 보인다(§17 R3-24).
            note={lockPadNote(conn)}
            onPin={unlockPin}
            {...(line !== undefined ? { locked: line } : {})}
          />
        )}
      </DeviceProfileProvider>
    );
  }

  if (gate.step === 'ready' && controls) {
    return (
      <SessionContext.Provider value={controls}>
        <ClientProvider key={gate.session.csrf} client={gate.client}>
          <App />
        </ClientProvider>
      </SessionContext.Provider>
    );
  }
  const role = gate.step === 'login' ? roleOf(gate.device.kind) : gate.step === 'choose' && gate.kind ? 'driver' : firstVisitRole(viewport);
  return (
    <DeviceProfileProvider role={role} timezone={TIMEZONE}>
      {gate.step === 'offline' ? (
        <OfflineScreen lastSyncAt={lastSync.current} onRetry={retry} {...(gate.pending ? { pending: gate.pending } : {})} {...(gate.notice ? { notice: gate.notice } : {})} {...(gate.driver ? { driver: true } : {})} />
      ) : null}
      {gate.step === 'enroll' ? <EnrollScreen onSubmit={enroll} {...(gate.notice ? { notice: gate.notice } : {})} /> : null}
      {gate.step === 'choose' ? <ChooseScreen vehicles={gate.vehicles} kind={gate.kind} onKind={chooseKind} onChoose={chooseDevice} /> : null}
      {gate.step === 'login' ? (
        <LoginGate
          key={gate.device.deviceId}
          device={gate.device}
          notice={gate.notice}
          api={api}
          origin={origin}
          onSession={loggedIn}
          onDeviceGone={deviceGone}
          pending={gate.pending}
        />
      ) : null}
    </DeviceProfileProvider>
  );
}

type StaffLoad = { kind: 'list'; list: StaffList } | { kind: 'gone'; code: string } | { kind: 'failed' };

/** 로그인 화면의 서버 몫: 한 번 값에 서명 → 직원 타일 · 로그인 표, 비밀번호 보내기. 보낼 기록이 남은 기기는 `기기 선택`을 두지 않는다(O14 h). */
function LoginGate({ device, notice, api, origin, onSession, onDeviceGone, pending }: {
  device: StoredDevice;
  notice: string | null;
  api: AuthApi;
  origin: string;
  /** 로그인이 되었다(친 비밀번호와 함께: 기사 기기의 앱 잠금 확인 값). */
  onSession: (session: SessionInfo, pin?: string) => void;
  /** 끊은 · 모르는 기기(코드: DEVICE_REVOKED · DEVICE_UNKNOWN). */
  onDeviceGone: (code?: string) => void;
  pending: number;
}) {
  const [list, setList] = useState<StaffList | null>(null);
  const [note, setNote] = useState<string | null>(notice);
  const [releasing, setReleasing] = useState(false);
  const ticket = useRef<string | null>(null);

  /** 한 번 값에 서명(직원 타일 · 기기 놓기). 끊긴 기기는 'gone'(코드는 goneCode). */
  const goneCode = useRef('DEVICE_REVOKED');
  const signed = useCallback(async (): Promise<{ nonce: string; signature: string } | 'gone' | 'failed'> => {
    const challenge = await api.challenge(device.deviceId);
    if (!challenge.ok && (challenge.code === 'DEVICE_UNKNOWN' || challenge.code === 'DEVICE_REVOKED')) goneCode.current = challenge.code;
    if (!challenge.ok) return challenge.code === 'DEVICE_UNKNOWN' || challenge.code === 'DEVICE_REVOKED' ? 'gone' : 'failed';
    try {
      return { nonce: challenge.value.nonce, signature: await signLogin(device.keyPair.privateKey, origin, device.deviceId, challenge.value.nonce) };
    } catch {
      return 'failed';
    }
  }, [api, device, origin]);

  const load = useCallback(async (): Promise<StaffLoad> => {
    const proof = await signed();
    if (proof === 'gone') return { kind: 'gone', code: goneCode.current };
    if (proof === 'failed') return { kind: 'failed' };
    const staff = await api.staff(device.deviceId, proof.nonce, proof.signature);
    if (staff.ok) return { kind: 'list', list: staff.value };
    return staff.code === 'DEVICE_UNKNOWN' || staff.code === 'DEVICE_REVOKED' ? { kind: 'gone', code: staff.code } : { kind: 'failed' };
  }, [api, device, signed]);

  /** 기기 선택(스스로 붙은 기기만): 서버에서 이 기기의 등록을 끊고 열쇠를 지운 뒤 기기 선택으로. */
  const release = useCallback(async () => {
    if (releasing) return;
    setReleasing(true);
    const proof = await signed();
    const answer = proof === 'gone' || proof === 'failed' ? null : await api.openRelease(device.deviceId, proof.nonce, proof.signature);
    setReleasing(false);
    if (proof === 'gone' || (answer && (answer.ok || answer.code === 'DEVICE_REVOKED' || answer.code === 'DEVICE_UNKNOWN'))) {
      onDeviceGone(answer && !answer.ok ? answer.code : 'DEVICE_REVOKED');
      return;
    }
    setNote(proof === 'failed' || answer?.status === 0 ? say('sendFailed') : say('commandFailed'));
  }, [api, device, onDeviceGone, releasing, signed]);

  const take = useCallback((result: StaffLoad): boolean => {
    if (result.kind === 'gone') {
      onDeviceGone(result.code);
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
      onSession(answer.value, pin);
      return null;
    }
    if (answer.code === 'DEVICE_REVOKED' || answer.code === 'DEVICE_UNKNOWN') {
      onDeviceGone(answer.code);
      return null;
    }
    if (answer.code === 'UNKNOWN_STAFF') {
      // 직원 목록이 바뀌었다: 다시 받는다.
      take(await load());
      return say('findFailed');
    }
    return pinAnswer(answer.code, answer.lockedUntil, TIMEZONE);
  }, [api, load, onDeviceGone, onSession, take]);

  const open = pending > 0 ? undefined : list?.openDevice;
  return (
    <LoginScreen
      shopName={list?.shopName ?? ''}
      staff={list?.staff ?? null}
      note={note}
      onPin={onPin}
      {...(open ? { deviceLine: openDeviceLine(device.kind, open.vehicleName), onChooseDevice: () => { void release(); }, choosing: releasing } : {})}
    />
  );
}

// 서버 모드의 세션 문맥(계획 work/impl-server/plan.md 6-3). 로그인한 직원 · 기기와 로그아웃을 화면(나가기 · 앱 뼈대)이 읽는다.
// 체험판에는 세션이 없다(null): 화면은 null이면 체험판의 모양 그대로 그린다. 서버 코드(HttpClient · 기기 열쇠)는 여기 없다 —
// 이 작은 모듈만 첫 묶음에 들고, 등록 · 로그인 화면과 HttpClient는 서버 모드에서만 받는 묶음(session.tsx)이다.
import { isDriverDevice, type ConnectionState, type DeviceKind, type SessionInfo } from '@skinote/contract';
import { t } from '@skinote/ui';
import { createContext, useContext } from 'react';
import type { DeviceShape, Route } from './router.ts';
import { say } from './strings.ts';

export interface SessionControls {
  info: SessionInfo;
  /** 서버의 오늘 영업일(머리에서, 장부가 바뀔 때 · 5분마다 다시 묻는다). 아직 모르면 null. */
  today: string | null;
  /** 오늘을 묻다가 실패함(기사 기기의 첫 화면이 연결 끊김 화면을 보인다). */
  todayFailed?: boolean;
  /** 오늘을 지금 다시 묻는다(연결 끊김 화면의 `재시도`). */
  retryToday?: () => void;
  /** 마지막 연결(연결 끊김 화면). */
  lastSyncAt?: string | undefined;
  /** 로그아웃(세션을 끝내고 로그인 화면으로). 끝내지 못하면 한 줄(기사 기기에 보낼 기록이 남음: `로그아웃 불가 · 전송 대기 {n}`). */
  logout(): Promise<string | null>;
  /**
   * 로그인 때 같은 차량의 다른 기기가 보낼 기록을 가졌거나 수를 모른 채 끊겼다(서버 답, sync 6 · work/impl-offline/plan.md §8-1): 기사 목록이 한 번
   * `1호 차량 휴대폰 미전송 기록 가능 · 휴대폰 전송 필요`를 알리고 dismissElsewhere를 부른다.
   */
  elsewhere?: { deviceKind: 'driver_phone' | 'driver_tablet'; pending: number | null; label?: string; staffName?: string };
  dismissElsewhere?: () => void;
}

export const SessionContext = createContext<SessionControls | null>(null);

/** 로그인한 세션(체험판 · 로그인 전은 null). */
export function useSession(): SessionControls | null {
  return useContext(SessionContext);
}

/** 기기 종류 → 역할: 포스는 카운터, 기사 태블릿 · 휴대폰은 기사. */
export function roleOf(kind: DeviceKind): 'counter' | 'driver' {
  return isDriverDevice(kind) ? 'driver' : 'counter';
}

/** 기사 기기의 화면 모양: 기사 휴대폰은 휴대폰 모양(?device=phone), 그 밖은 태블릿. */
export function shapeOf(kind: DeviceKind): DeviceShape {
  return kind === 'driver_phone' ? 'phone' : 'tablet';
}

/**
 * 기기의 첫 화면: 카운터는 오늘 장부(#/ledger), 기사는 그 영업일의 수거 목록(#/driver/<오늘>[?device=phone]).
 * 기사는 오늘을 알아야 한다(모르면 null: 머리를 받은 뒤 다시 부른다).
 */
export function homeRoute(kind: DeviceKind, today: string | null): Route | null {
  if (!isDriverDevice(kind)) return { name: 'ledger', date: null };
  return today ? { name: 'driver', date: today, device: shapeOf(kind) } : null;
}

/** 기사 기기에서 열 수 있는 화면(기사 세션은 장부 · 접수증 · 관리를 읽지 못한다, plan §5-4). */
export function driverRouteAllowed(route: Route): boolean {
  return route.name === 'driver' || route.name === 'deliveries' || route.name === 'task' || (route.name === 'exit' && route.from === 'driver');
}

/**
 * 서버 모드에서 지금 경로를 그대로 둘지, 어디로 옮길지(null = 그대로). 처음 화면(#/)은 기기의 첫 화면으로, 기사 기기가 기사 화면 밖을
 * 열면 수거 목록으로, 체험판 미리 보기(#/preview)는 첫 화면으로.
 */
export function serverRedirect(route: Route, kind: DeviceKind, today: string | null): Route | null | 'wait' {
  const home = homeRoute(kind, today);
  const needsHome = route.name === 'start' || route.name === 'preview' || route.name === 'unknown' || (isDriverDevice(kind) && !driverRouteAllowed(route));
  if (!needsHome) return null;
  return home ?? 'wait';
}

/**
 * 같은 차량의 다른 기기가 보낼 기록을 가짐(로그인 때 한 번, 기사 목록의 알림). 서버가 그 기기를 알려 주면 등록 이름 · 마지막 로그인 직원과 수
 * (`1호 차량 휴대폰 · 박기사 기록 2건 전송 대기 · 해당 기기 전송 필요`, 수를 모르면 `… 미전송 기록 가능 · …`, §17 R3-28), 옛 서버는 기기 종류의 줄.
 */
export function elsewhereLine(other: NonNullable<SessionControls['elsewhere']>, vehicle: string): string {
  if (!other.label) return say(other.deviceKind === 'driver_phone' ? 'elsewherePhone' : 'elsewhereTablet', { vehicle });
  const device = other.staffName ? other.label + ' · ' + other.staffName : other.label;
  return other.pending !== null && other.pending > 0 ? say('elsewhereDevice', { device, n: other.pending }) : say('elsewhereDeviceMaybe', { device });
}

/**
 * 앱 잠금 판 위의 한 줄(§17 R3-24): 판 뒤에서 보내기는 이어지므로 이 기기에 아직 답을 받지 않은 기록이 있으면 `전송 대기 {n}`(띠와 같은 말), 없으면
 * 없음. 순수 함수(시험, 미리 보기 #/preview/lock도 같은 셈).
 */
export const lockPadNote = (connection: Pick<ConnectionState, 'pendingCount'>): string | null =>
  (connection.pendingCount > 0 ? t('pendingCount', { n: connection.pendingCount }) : null);

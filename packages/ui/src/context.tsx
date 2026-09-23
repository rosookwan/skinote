// 기기 등급을 고르고 크기 변수(CSS)를 까는 뿌리 부품, 그리고 부품들이 쓰는 문맥(등급 · 시간대 · 지금 시각).
import type { DeviceClassKey, IsoTime } from '@skinote/contract';
import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { DEVICE_PROFILES, pickDeviceClass, profileCssVars, type DeviceProfile, type DeviceRole, type Size } from './device-profile.ts';
import { useViewportSize } from './measure.ts';

export interface UiContextValue {
  profile: DeviceProfile;
  viewport: Size;
  timezone: string;
}

const UiContext = createContext<UiContextValue>({
  profile: DEVICE_PROFILES.pos,
  viewport: DEVICE_PROFILES.pos.checkSizes[0] ?? { width: 1024, height: 600 },
  timezone: 'Asia/Seoul',
});

export interface DeviceProfileProviderProps {
  role: DeviceRole;
  /** 매장 시간대(UiConfig.timezone). */
  timezone: string;
  /** 크기를 고정할 때(촬영 · 시험 · 서버 그리기). 없으면 창 크기를 잰다. */
  size?: Size;
  /** 등급을 고정할 때(시험). 없으면 잰 크기와 역할로 고른다. */
  deviceClass?: DeviceClassKey;
  className?: string;
  children: ReactNode;
}

/** 등급을 고르고 크기 변수(--sn-*)와 강조색(data-accent)을 까는 뿌리. 모든 부품은 이 안에 있어야 한다. */
export function DeviceProfileProvider({ role, timezone, size, deviceClass, className, children }: DeviceProfileProviderProps) {
  const measured = useViewportSize(size ?? DEVICE_PROFILES.pos.checkSizes[0] ?? { width: 1024, height: 600 });
  const viewport = size ?? measured;
  const key = deviceClass ?? pickDeviceClass(viewport, role);
  const profile = DEVICE_PROFILES[key];
  const value = useMemo(() => ({ profile, viewport, timezone }), [profile, viewport, timezone]);
  const style = useMemo(() => profileCssVars(profile) as CSSProperties, [profile]);
  return (
    <UiContext.Provider value={value}>
      <div className={'sn-root' + (className ? ' ' + className : '')} data-device={profile.key} data-accent={profile.accent} style={style}>
        {children}
      </div>
    </UiContext.Provider>
  );
}

export function useUi(): UiContextValue {
  return useContext(UiContext);
}

export function useDeviceProfile(): DeviceProfile {
  return useContext(UiContext).profile;
}

/**
 * 서버 시각 차이로 고친 지금 시각(ms). 읽기 모델의 serverTime을 받은 때의 차이를 쓰고, 분이 바뀔 때마다 다시 그린다.
 * '지금' 줄과 늦음(lateAt 비교)은 이 값으로 칠한다(ui 7절). 아무도 쓰지 않아도 22:00이 지나면 그 줄이 빨개진다.
 */
export function useServerNow(serverTime: IsoTime | undefined): number {
  const offset = useMemo(() => (serverTime ? Date.parse(serverTime) - Date.now() : 0), [serverTime]);
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const tick = () => setNow(Date.now() + offset);
    tick();
    let interval: ReturnType<typeof setInterval> | undefined;
    const untilNextMinute = 60_000 - ((Date.now() + offset) % 60_000);
    const timeout = setTimeout(() => {
      tick();
      interval = setInterval(tick, 60_000);
    }, untilNextMinute);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [offset]);
  return now;
}

/** 늦었는지: 서버가 정한 lateAt과 고친 지금 시각의 비교뿐(규칙은 서버에 있다). */
export function isLate(lateAt: IsoTime | undefined, nowMs: number): boolean {
  return lateAt !== undefined && Date.parse(lateAt) <= nowMs;
}

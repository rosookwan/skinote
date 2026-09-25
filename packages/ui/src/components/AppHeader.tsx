// 머리줄(ui 5 AppHeader, 3-6 화면 지도). 왼쪽 레일 대신: `장부`(홈) · 끝 4자리 찾기 · 메뉴(등급 칸 수) · 더 보기 · 알림 ·
// 관리(늘 끝) · 나가기. 새 접수는 머리줄이 아니라 바닥줄의 주 버튼이다. 기사 기기는 장부 버튼 없이 차량 이름표와
// 끝 4자리(숫자판이 아래 판일 때) · 메뉴 · 알림 · 나가기.
// 폭이 모자라면 잰 폭으로 차례대로 줄인다: ① 메뉴를 하나씩 더 보기로 ② 나가기를 그림만 ③ 나가기를 더 보기 안으로
// ④ 장부 버튼을 그림만 ⑤ 차량 이름표를 더 보기 판의 제목으로 ⑥ 더 보기를 그림만 ⑦ 끝 4자리를 그림만.
// 낱말 버튼('끝 4자리' · '더 보기')이 그림만 되기 전에 이름표부터 비킨다(고령 · 장갑: 그림만인 버튼은 뜻을 알기 어렵다).
// 매장 이름은 남는 폭에 들어갈 때만 보이고, 들어가지 않으면 자리도 차지하지 않는다.
// 서버 연결이 끊긴 카운터(connection, 계획 work/impl-server/plan.md 6-4): 매장 이름 자리에 회색 이름표 `연결 끊김`(남는 폭이 있으면
// `연결 끊김 · 마지막 연결 16:48`). 늦음이 아니라 빨강을 쓰지 않고, 머리줄 높이도 그대로다. `연결 끊김`은 늘 보이도록 줄이는 단계가
// 그 폭을 먼저 남긴다.
import type { ConnectionState, MenuEntryRow } from '@skinote/contract';
import { fitList, type TextFitInput } from '@skinote/layout';
import { useMemo, useRef, useState } from 'react';
import { useDeviceProfile, useUi } from '../context.tsx';
import { formatTime } from '../format.ts';
import { Icon } from '../icons.tsx';
import { useElementSize, useFontsVersion, useIsoLayoutEffect } from '../measure.ts';
import { t } from '../strings.ko-KR.ts';
import { TextFit } from './TextFit.tsx';

export interface AppHeaderMore {
  entries: MenuEntryRow[];
  /** 나가기가 더 보기 안으로 들어갔는지(좁은 휴대폰). 판에 나가기 버튼을 그려야 한다. */
  includesExit: boolean;
  /** 머리줄에서 빠진 차량 이름표(판 제목에 붙인다: '더 보기 · 1호 차량'). */
  vehicleLabel?: string;
}

export interface AppHeaderProps {
  shopName: string;
  /** 기사 기기: '1호 차량'. */
  vehicleLabel?: string;
  /** menuFor()로 거른 메뉴 행(일터 · 등급 · 기능 · 권한). */
  menu: MenuEntryRow[];
  alertCount: number;
  /** 지금 화면의 메뉴 키(켜진 표시). */
  currentKey?: string;
  /** 장부(홈). 없으면 버튼을 그리지 않는다(기사 기기: 목록이 곧 홈). */
  onHome?: () => void;
  /** 끝 4자리 찾기(포스 · 숫자판이 아래 판인 기사 기기). 옆 판 숫자판이 있는 기사 태블릿은 넘기지 않는다. */
  onFind?: () => void;
  onMenu: (entry: MenuEntryRow) => void;
  onMore?: (more: AppHeaderMore) => void;
  onAlerts: () => void;
  onExit: () => void;
  /** 이 기기의 연결 상태(서버에 붙은 카운터). 끊겼을 때만 이름표가 보인다. 없으면(체험판 · 기사 기기는 연결 띠) 그리지 않는다. */
  connection?: Pick<ConnectionState, 'online' | 'lastSyncAt'>;
}

/** 머리줄의 연결 끊김 이름표 글: 긴 것부터(`연결 끊김 · 마지막 연결 16:48`, `연결 끊김`). 순수 함수(시험). */
export function headerOfflineAlts(lastSyncAt: string | undefined, timezone: string): string[] {
  const short = t('offline');
  return lastSyncAt ? [short + ' · ' + t('lastSync', { time: formatTime(lastSyncAt, timezone) }), short] : [short];
}

/** 끊겼을 때 매장 이름 자리의 이름표. 남는 폭(잰 폭에서 이름표 여백 · 테두리를 뺀 것)에 긴 글부터 맞춘다. */
function OfflineTag({ lastSyncAt }: { lastSyncAt: string | undefined }) {
  const profile = useDeviceProfile();
  const { timezone } = useUi();
  const ref = useRef<HTMLSpanElement>(null);
  const size = useElementSize(ref);
  const alts = headerOfflineAlts(lastSyncAt, timezone);
  const input = useMemo<TextFitInput>(() => ({ mode: 'alts', alts }), [alts.join('|')]);
  const width = size ? Math.max(0, size.width - 2 * profile.space.xs - 2 * profile.line.hair) : undefined;
  return (
    <span ref={ref} className="sn-tag-slot sn-header-offline" role="status" aria-label={alts[0]}>
      {width !== undefined ? <TextFit className="sn-tag" input={input} width={width} /> : null}
    </span>
  );
}

/** 줄이는 단계: 0 그대로, 1 나가기 그림만, 2 나가기를 더 보기 안으로, 3 장부 그림만, 4 차량 이름표를 더 보기로, 5 더 보기 그림만, 6 끝 4자리 그림만. */
const LEVEL = { exitIcon: 1, exitInMore: 2, homeIcon: 3, vehicleInMore: 4, moreIcon: 5, findIcon: 6 } as const;
const LAST_LEVEL = LEVEL.findIcon;

export function AppHeader({ shopName, vehicleLabel, menu, alertCount, currentKey, onHome, onFind, onMenu, onMore, onAlerts, onExit, connection }: AppHeaderProps) {
  const offline = connection !== undefined && !connection.online;
  const profile = useDeviceProfile();
  const barRef = useRef<HTMLElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const bar = useElementSize(barRef);
  const fonts = useFontsVersion();
  // 메뉴는 내용(키 · 이름)으로 비교한다: 부르는 쪽이 그릴 때마다 새 배열을 넘겨도(손가락이 닿을 때 다시 그림) 줄인 단계를
  // 처음으로 되돌리지 않는다. 되돌리면 누르는 사이에 버튼이 바뀌어 누름이 사라진다.
  const menuSignature = menu.map((m) => m.key + ':' + m.label + ':' + m.pinned_end).join('|');
  const entries = useMemo(() => menu.map((m) => ({ ...m, pinnedEnd: m.pinned_end === 1 })), [menuSignature]);
  const [limit, setLimit] = useState(profile.capacity.menu);
  const [level, setLevel] = useState(0);
  useIsoLayoutEffect(() => {
    setLimit(profile.capacity.menu);
    setLevel(0);
  }, [bar?.width, profile.capacity.menu, fonts, menuSignature, Boolean(onFind), Boolean(onHome), vehicleLabel, offline]);
  // 오른쪽 묶음 + 장부 버튼 · 차량 이름표가 머리줄 폭을 넘으면 한 단계씩 줄인다.
  useIsoLayoutEffect(() => {
    const header = barRef.current;
    const left = leftRef.current;
    const right = rightRef.current;
    if (!header || !left || !right || typeof getComputedStyle === 'undefined') return;
    const hs = getComputedStyle(header);
    const ls = getComputedStyle(left);
    const inner = header.clientWidth - parseFloat(hs.paddingLeft) - parseFloat(hs.paddingRight) - (parseFloat(hs.columnGap) || 0);
    // 매장 이름 · 연결 끊김 이름표는 남는 폭을 쓴다: 이름표는 가장 짧은 글(`연결 끊김`)의 폭(min-width)만 남기면 된다.
    const fixed = [...left.children].filter((el) => !el.classList.contains('sn-header-shop') && !el.classList.contains('sn-header-offline'));
    const tag = left.querySelector('.sn-header-offline');
    const tagNeed = tag ? parseFloat(getComputedStyle(tag).minWidth) || 0 : 0;
    const leftNeed = fixed.reduce((w, el) => w + (el as HTMLElement).offsetWidth, 0) + (parseFloat(ls.columnGap) || 0) * fixed.length + tagNeed;
    if (right.scrollWidth + leftNeed <= inner + 1) return;
    const freeCount = entries.filter((e) => !e.pinnedEnd).length;
    if (limit > 0 && freeCount > 0) setLimit(Math.min(limit, freeCount) - 1);
    else if (level < LAST_LEVEL) setLevel(level + 1);
  });
  const fitted = fitList(entries, limit);
  const free = fitted.shown.filter((m) => !m.pinnedEnd);
  const pinned = fitted.shown.filter((m) => m.pinnedEnd);
  const exitInMore = level >= LEVEL.exitInMore;
  const vehicleInMore = Boolean(vehicleLabel) && level >= LEVEL.vehicleInMore;
  const showMore = fitted.overflow.length > 0 || exitInMore || vehicleInMore;
  const iconOnly = (min: number) => level >= min;

  return (
    <header ref={barRef} className="sn-header">
      <div ref={leftRef} className="sn-header-left">
        {onHome ? (
          <button type="button" className="sn-header-home" aria-label={t('home')} onClick={onHome}>
            <Icon name="book" />
            {iconOnly(LEVEL.homeIcon) ? null : <span>{t('home')}</span>}
          </button>
        ) : null}
        {offline ? <OfflineTag lastSyncAt={connection?.lastSyncAt} /> : <TextFit className="sn-header-shop" input={{ mode: 'parts', parts: [{ text: shopName, drop: 1 }] }} />}
        {vehicleLabel && !vehicleInMore ? <span className="sn-unit">{vehicleLabel}</span> : null}
      </div>
      <div ref={rightRef} className="sn-header-right">
        {onFind ? (
          <button type="button" className={iconOnly(LEVEL.findIcon) ? 'sn-icon-button sn-header-find' : 'sn-button sn-header-find'} aria-label={t('find')} onClick={onFind}>
            <Icon name="keypad" />
            {iconOnly(LEVEL.findIcon) ? null : <span>{t('find')}</span>}
          </button>
        ) : null}
        {free.map((entry) => (
          <button key={entry.key} type="button" className="sn-button" aria-current={entry.key === currentKey ? 'page' : undefined} onClick={() => onMenu(entry)}>
            {entry.label}
          </button>
        ))}
        {showMore ? (
          <button
            type="button"
            className={iconOnly(LEVEL.moreIcon) ? 'sn-icon-button' : 'sn-button'}
            aria-label={t('more')}
            onClick={() => onMore?.({ entries: fitted.overflow, includesExit: exitInMore, ...(vehicleInMore && vehicleLabel ? { vehicleLabel } : {}) })}
          >
            {iconOnly(LEVEL.moreIcon) ? <Icon name="more" /> : t('more')}
          </button>
        ) : null}
        <button type="button" className="sn-icon-button" aria-label={alertCount > 0 ? t('alertsCount', { n: alertCount }) : t('alerts')} onClick={onAlerts}>
          <Icon name="bell" />
          {alertCount > 0 ? <span className="sn-badge">{alertCount > 99 ? '99+' : alertCount}</span> : null}
        </button>
        {pinned.map((entry) => (
          <button key={entry.key} type="button" className="sn-button" aria-current={entry.key === currentKey ? 'page' : undefined} onClick={() => onMenu(entry)}>
            {entry.label}
          </button>
        ))}
        {exitInMore ? null : (
          <button type="button" className={iconOnly(LEVEL.exitIcon) ? 'sn-icon-button' : 'sn-button'} aria-label={t('exit')} onClick={onExit}>
            <Icon name="exit" />
            {iconOnly(LEVEL.exitIcon) ? null : <span>{t('exit')}</span>}
          </button>
        )}
      </div>
    </header>
  );
}

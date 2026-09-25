// 제목 · 색인 탭 줄(ui 5 IndexTabs). 한 화면에 제목은 하나, 켜진 탭은 종이 색인처럼 앞으로 나온다.
// 탭 수는 등급의 칸 수(6 · 5 · 4 · 3)이고, 넘치면 우선순위 낮은 탭이 '더 보기' 탭으로 간다. 폭이 모자라도 같은 규칙으로 줄인다.
import type { LedgerTabRow } from '@skinote/contract';
import { fitList, shortCount } from '@skinote/layout';
import { useMemo, useRef, useState } from 'react';
import { useDeviceProfile } from '../context.tsx';
import { measureFor, useElementSize, useFontsVersion, useIsoLayoutEffect } from '../measure.ts';
import { t } from '../strings.ko-KR.ts';
import { Tag } from './Tag.tsx';
import { TextFit } from './TextFit.tsx';

export interface IndexTabsProps {
  /** 화면 제목('12월 26일 (토) 대여 장부'). 한 화면에 하나. */
  title: string;
  tabs: LedgerTabRow[];
  counts: Record<string, number>;
  active: string;
  onSelect: (tabKey: string) => void;
  /** '더 보기' 탭(넘친 탭들). */
  onMore?: (tabs: LedgerTabRow[]) => void;
  /** 제목 옆 이름표(`마감 완료`). 탭과 같이 폭을 잰다. */
  tag?: string;
}

export function IndexTabs({ title, tabs, counts, active, onSelect, onMore, tag }: IndexTabsProps) {
  const profile = useDeviceProfile();
  const navRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const tagRef = useRef<HTMLSpanElement>(null);
  const bar = useElementSize(barRef);
  const fonts = useFontsVersion();
  const entries = useMemo(() => tabs.map((tab) => ({ ...tab, pinnedEnd: false })), [tabs]);
  const [limit, setLimit] = useState(profile.capacity.tabs);
  // 크기가 바뀌면 등급 칸 수부터 다시 세고, 넘치면 하나씩 줄인다(잰 폭으로 맞춤).
  useIsoLayoutEffect(() => { setLimit(profile.capacity.tabs); }, [bar?.width, profile.capacity.tabs, fonts, tabs, tag]);
  // 탭이 먼저다: 제목은 낱말을 줄여 비켜 주고(첫 낱말은 남김), 그래도 탭이 넘치면 탭을 더 보기로 보낸다.
  useIsoLayoutEffect(() => {
    const bar = barRef.current;
    const nav = navRef.current;
    const heading = titleRef.current;
    if (!bar || !nav || !heading || typeof getComputedStyle === 'undefined' || limit <= 1) return;
    const bs = getComputedStyle(bar);
    const inner = bar.clientWidth - parseFloat(bs.paddingLeft) - parseFloat(bs.paddingRight) - (parseFloat(bs.columnGap) || 0);
    const titleMin = measureFor(heading.firstElementChild ?? heading, profile.titleFontPx)(title.split(' ')[0] ?? '');
    const tagWidth = tagRef.current ? tagRef.current.offsetWidth + (parseFloat(bs.columnGap) || 0) : 0;
    if (nav.scrollWidth + titleMin + tagWidth > inner + 1) setLimit(limit - 1);
  });
  const fitted = fitList(entries, limit, { moreTakesSlot: true });
  const activeHidden = fitted.overflow.some((tab) => tab.tab_key === active);

  const label = (tab: LedgerTabRow) => {
    const name = tab.label;
    const count = tab.shows_count === 1 && counts[tab.tab_key] !== undefined ? ' ' + shortCount(counts[tab.tab_key] ?? 0) : '';
    return name + count;
  };

  return (
    <div ref={barRef} className="sn-titlebar">
      <h1 ref={titleRef} className="sn-title"><TextFit input={{ mode: 'words', text: title }} /></h1>
      {tag ? <span ref={tagRef} className="sn-title-tag"><Tag text={tag} /></span> : null}
      <div ref={navRef} className="sn-tabs" role="tablist" aria-label={title}>
        {fitted.shown.map((tab) => (
          <button
            key={tab.tab_key}
            type="button"
            role="tab"
            className="sn-tab"
            aria-selected={tab.tab_key === active}
            onClick={() => onSelect(tab.tab_key)}
          >
            {label(tab)}
          </button>
        ))}
        {fitted.overflow.length > 0 ? (
          <button type="button" role="tab" className="sn-tab is-more" aria-selected={activeHidden} onClick={() => onMore?.(fitted.overflow)}>
            {activeHidden ? label(fitted.overflow.find((tab) => tab.tab_key === active)!) : t('more')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

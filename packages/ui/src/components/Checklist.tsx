// 처리 현황(ui 5 Checklist, B2). 끝난 일은 한 줄('완료 3건')로 접고, 지금 할 일은 주황 테두리 · 바탕, 나머지는 회색.
// '지금'이라는 글자는 붙이지 않는다: 바로 옆 '지급'과 한눈에 헷갈린다(색과 aria-current로 알린다).
// 순서와 '지금'은 읽기 모델이 정했다(urgency_out · urgency_back). 큰 버튼(주 버튼)은 지금 할 일 하나다.
// 품목이 있는 일은 둘째 줄에 품목 요약('스키 2 · 보드 1 · 헬멧 3 · 야간권 3매', 넘치면 '외 N종'), 반납은 둘째 줄에 장소 · 방법
// ('설천 주차장 · 차량 수거', 일정이 나뉘면 '설천 주차장 · 솔마을 두솔동'). 지연된 일은 '반납 지연'과 지연 색.
// 부르는 쪽이 onItemPress를 주면 도장이 있는 끝나지 않은 줄은 줄 전체가 버튼이다: 그 단계를 접수 전체로 연다(접수증의 처리 현황
// `반납`에서 열면 모든 줄의 반납 창, spec 3-1). 무엇이 열리는지는 부르는 쪽(도장 누르기와 같은 길)이 정한다. 누를 수 있는 줄은 먹색 글과
// 끝의 `›`로 보이고, 회색은 누를 수 없는 줄에만 쓴다.
import type { ChecklistItem } from '@skinote/contract';
import type { TextPart } from '@skinote/layout';
import { useRef, type ReactNode } from 'react';
import { isLate, useDeviceProfile } from '../context.tsx';
import { formatItem } from '../format.ts';
import { Icon } from '../icons.tsx';
import { useElementSize } from '../measure.ts';
import { t } from '../strings.ko-KR.ts';
import { TextFit } from './TextFit.tsx';

export interface ChecklistProps {
  items: ChecklistItem[];
  /** 서버 시각 차이로 고친 지금(늦음 비교). */
  nowMs: number;
  /** 목록 아래의 큰 버튼(지금 할 일, PrimaryButton). */
  primary?: ReactNode;
  /** 줄을 누름(도장이 있는 끝나지 않은 줄만 누를 수 있다). 없으면 줄은 글이다. */
  onItemPress?: (item: ChecklistItem) => void;
}

/** 지연된 일: 첫 조각(단계 이름)에 '지연'을 붙인다('반납 지연 · 오늘 12:00 · 매장'). 첫 조각은 빠지지 않는다. */
function withLate(parts: readonly TextPart[]): TextPart[] {
  const [first, ...rest] = parts;
  if (!first) return [{ text: t('late'), drop: 0 }];
  return [{ ...first, text: t('lateKind', { label: first.text }), drop: 0 }, ...rest];
}

export function Checklist({ items, nowMs, primary, onItemPress }: ChecklistProps) {
  const profile = useDeviceProfile();
  const listRef = useRef<HTMLOListElement>(null);
  const box = useElementSize(listRef);
  const done = items.filter((item) => item.state === 'done');
  const now = items.filter((item) => item.state === 'now');
  const later = items.filter((item) => item.state === 'later');
  // 잰 높이에 들어가는 줄 수. 지키는 순서: 지금 할 일 > '남은 일 N개 더' > 끝난 일 한 줄 > 나머지 할 일. 보이는 줄의 차례는 읽기 모델의
  // 차례 그대로다(반납 때 받는 돈이면 차량이 할 반납이 지금 할 수납 위에 온다: V9 · V1 뒤 화면).
  const rows = box ? Math.max(1, Math.floor(box.height / profile.minTargetPx)) : items.length;
  const shownNow = now.slice(0, rows);
  const budget = rows - shownNow.length;
  const doneLine = done.length > 0 ? 1 : 0;
  let showDone = doneLine === 1;
  let shown = later;
  let showMoreLine = false;
  if (later.length + doneLine > budget) {
    showMoreLine = budget >= 1;
    let rest = budget - (showMoreLine ? 1 : 0);
    showDone = doneLine === 1 && rest >= 1;
    rest -= showDone ? 1 : 0;
    shown = later.slice(0, Math.max(0, rest));
  }
  const hidden = later.length - shown.length + (now.length - shownNow.length);
  showMoreLine = showMoreLine && hidden > 0;
  return (
    <section className="sn-checklist">
      <ol ref={listRef} className="sn-checklist-list">
        {showDone ? (
          <li className="sn-check is-done">
            <span className="sn-check-mark"><Icon name="check" /></span>
            <span className="sn-fit">{t('doneSteps', { n: done.length })}</span>
          </li>
        ) : null}
        {items.filter((item) => shownNow.includes(item) || shown.includes(item)).map((item) => {
          const late = isLate(item.lateAt, nowMs);
          const body = (
            <>
              <span className="sn-check-mark" />
              <span className="sn-check-lines">
                <TextFit input={{ mode: 'parts', parts: late ? withLate(item.parts) : item.parts }} {...(late ? { className: 'tone-late' } : {})} />
                {item.items?.length
                  ? <TextFit className="sn-check-items" input={{ mode: 'items', items: item.items.map(formatItem) }} />
                  : item.second?.length ? <TextFit className="sn-check-items" input={{ mode: 'parts', parts: item.second }} /> : null}
              </span>
            </>
          );
          const pressable = onItemPress !== undefined && item.stamp !== undefined;
          // 누를 수 있는 줄은 먹색 글과 끝의 `›`(누를 수 없는 줄만 회색이다: 회색 줄은 막힌 것으로 읽힌다).
          return (
            <li key={item.stepKey} className={'sn-check is-' + item.state + (pressable ? ' is-pressable' : '')} aria-current={item.state === 'now' ? 'step' : undefined}>
              {pressable ? (
                <button type="button" className="sn-check-press" onClick={() => onItemPress(item)}>
                  {body}
                  <span className="sn-check-go" aria-hidden="true"><Icon name="right" /></span>
                </button>
              ) : body}
            </li>
          );
        })}
        {showMoreLine ? (
          <li className="sn-check is-later">
            <span className="sn-check-mark" />
            <span className="sn-fit">{t('moreSteps', { n: hidden })}</span>
          </li>
        ) : null}
      </ol>
      {primary}
    </section>
  );
}

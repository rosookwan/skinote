// 남은 일 목록(ui 5 Checklist, B2). 끝난 일은 한 줄('끝난 일 3')로 접고, 지금 할 일은 주황 테두리 · 바탕, 나머지는 회색.
// '지금'이라는 글자는 붙이지 않는다: 바로 옆 '지급'과 한눈에 헷갈린다(색과 aria-current로 알린다).
// 순서와 '지금'은 읽기 모델이 정했다(urgency_out · urgency_back). 큰 버튼(주 버튼)은 지금 할 일 하나다.
// 품목이 있는 일은 둘째 줄에 품목 요약('스키 2 · 보드 1 · 헬멧 3 · 야간권 3매', 넘치면 '외 N종'). 늦은 일은 '늦음'과 늦음 색.
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
}

/** 늦은 일: 첫 요약 조각(시각) 뒤에 '늦음'(빠지지 않음). */
function withLate(parts: readonly TextPart[]): TextPart[] {
  const at = Math.min(2, parts.length);
  return [...parts.slice(0, at), { text: t('late'), drop: 0 }, ...parts.slice(at)];
}

export function Checklist({ items, nowMs, primary }: ChecklistProps) {
  const profile = useDeviceProfile();
  const listRef = useRef<HTMLOListElement>(null);
  const box = useElementSize(listRef);
  const done = items.filter((item) => item.state === 'done');
  const now = items.filter((item) => item.state === 'now');
  const later = items.filter((item) => item.state === 'later');
  // 잰 높이에 들어가는 줄 수. 지키는 순서: 지금 할 일 > '남은 일 N개 더' > 끝난 일 한 줄 > 나머지 할 일.
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
        {[...shownNow, ...shown].map((item) => {
          const late = isLate(item.lateAt, nowMs);
          return (
            <li key={item.stepKey} className={'sn-check is-' + item.state} aria-current={item.state === 'now' ? 'step' : undefined}>
              <span className="sn-check-mark" />
              <span className="sn-check-lines">
                <TextFit input={{ mode: 'parts', parts: late ? withLate(item.parts) : item.parts }} {...(late ? { className: 'tone-late' } : {})} />
                {item.items?.length ? <TextFit className="sn-check-items" input={{ mode: 'items', items: item.items.map(formatItem) }} /> : null}
              </span>
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

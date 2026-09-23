// 쪽 넘김(ui 5 Pager): 바닥줄의 '‹ 1 / 3쪽 ›'. 버튼은 등급의 최소 누르는 곳 크기다. 한 쪽뿐이면 그리지 않는다.
import { Icon } from '../icons.tsx';
import { t } from '../strings.ko-KR.ts';

export interface PagerProps {
  /** 0부터. */
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  /** 품목 표만 넘길 때 '품목 1 / 3쪽'. */
  label?: string;
}

export function Pager({ page, pageCount, onChange, label }: PagerProps) {
  if (pageCount <= 1) return null;
  const current = Math.min(Math.max(0, page), pageCount - 1);
  const text = label ? t('pageOf', { label, page: current + 1, total: pageCount }) : t('page', { page: current + 1, total: pageCount });
  return (
    <nav className="sn-pager" aria-label={text}>
      <button type="button" className="sn-pager-button" aria-label={t('prevPage')} disabled={current === 0} onClick={() => onChange(current - 1)}>
        <Icon name="left" />
      </button>
      <span className="sn-pager-text" aria-live="polite">{text}</span>
      <button type="button" className="sn-pager-button" aria-label={t('nextPage')} disabled={current >= pageCount - 1} onClick={() => onChange(current + 1)}>
        <Icon name="right" />
      </button>
    </nav>
  );
}

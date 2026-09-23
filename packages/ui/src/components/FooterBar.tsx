// 바닥줄(ui 5 FooterBar): 숫자('합계 18팀 · 지급 14 · 반납 9 · 미수 485,000원'), 쪽 넘김, 주 버튼 하나.
// 숫자가 넘치면 합치고('지급/반납 14/9') 그다음 우선순위 낮은 숫자를 뺀다(ui 4-4, layout의 fitMetrics).
import type { LedgerMetricRow, MetricValue } from '@skinote/contract';
import { fitMetrics, type MetricText } from '@skinote/layout';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useDeviceProfile } from '../context.tsx';
import { formatMetricValue } from '../format.ts';
import { approximateMeasure, measureFor, useElementSize, useFontsVersion, useIsoLayoutEffect } from '../measure.ts';
import { PrimaryButton, type PrimaryButtonProps } from './PrimaryButton.tsx';

export interface FooterMetric {
  row: LedgerMetricRow;
  value: MetricValue;
}

export interface FooterBarProps {
  metrics: FooterMetric[];
  /** Pager(한 쪽뿐이면 비어 있음). */
  pager?: ReactNode;
  primary?: PrimaryButtonProps | null;
  /** 숫자 대신 넣을 것(드물게). */
  children?: ReactNode;
}

/** 설정 행 + 값 → 맞추기 입력. 개수 값만 합칠 수 있다. */
export function metricTexts(metrics: readonly FooterMetric[]): MetricText[] {
  return [...metrics]
    .sort((a, b) => a.row.seq - b.row.seq)
    .map(({ row, value }) => {
      const formatted = formatMetricValue(value);
      return {
        key: row.metric_key,
        label: row.label,
        value: formatted.text,
        priority: row.priority,
        foldable: row.overflow_key === 'fold' && value.unit === 'count',
        ...(formatted.items ? { items: formatted.items } : {}),
      };
    });
}

export function FooterBar({ metrics, pager, primary, children }: FooterBarProps) {
  const profile = useDeviceProfile();
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  const fonts = useFontsVersion();
  const texts = useMemo(() => metricTexts(metrics), [metrics]);
  const [text, setText] = useState(() => (size ? fitMetrics(texts, size.width, approximateMeasure(profile.baseFontPx)).text : texts.map((m) => m.label + ' ' + m.value).join(' · ')));
  useIsoLayoutEffect(() => {
    if (!size) return;
    const fitted = fitMetrics(texts, size.width, measureFor(ref.current, profile.baseFontPx));
    // 숫자 하나도 들어가지 않으면 비운다(잘린 글자를 보이지 않는다).
    setText(fitted.fits ? fitted.text : '');
  }, [texts, size, fonts, profile.baseFontPx]);
  // 주 버튼이 가로 전체인 등급(휴대폰)은 바닥줄에 숫자를 두지 않는다: 같은 숫자가 색인 탭의 개수에 있다.
  const fill = profile.primaryFullWidth && Boolean(primary);
  return (
    <footer className="sn-footer">
      {fill ? null : (
        <div ref={ref} className="sn-footer-metrics">
          {children ?? <span className="sn-fit">{text}</span>}
        </div>
      )}
      {pager ? <div className="sn-footer-pager">{pager}</div> : null}
      {primary ? <PrimaryButton {...primary} fill={fill || primary.fill === true} /> : null}
    </footer>
  );
}

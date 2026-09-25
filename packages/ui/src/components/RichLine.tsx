// 글 조각 줄(RichLine): 읽기 모델의 한 줄(TextRun[])을 굵게 · 색으로 그린다('22:00 솔마을 두솔동'만 굵게). 한 줄에 다 들어가지 않으면
// 끝에서부터 덜 중요한 조각(굵지 않은 조각, 첫 조각은 빼지 않음)을 통째로 뺀다(말줄임표 없음). 빨강(red)은 늦은 것에만(tone-late).
import type { TextRun } from '@skinote/contract';
import { useRef, useState } from 'react';
import { useElementSize, useFontsVersion, useIsoLayoutEffect } from '../measure.ts';

export interface RichLineProps {
  runs: readonly TextRun[];
  className?: string;
}

const toneClass = (run: TextRun) => (run.tone ? (run.tone === 'red' ? 'tone-late' : 'tone-' + run.tone) : undefined);

export function RichLine({ runs, className }: RichLineProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const box = useElementSize(ref);
  const fonts = useFontsVersion();
  const signature = JSON.stringify([runs, box?.width ?? 0, fonts]);
  const [fit, setFit] = useState({ signature, dropped: 0 });
  const dropped = fit.signature === signature ? fit.dropped : 0;
  // 뺄 수 있는 조각: 뒤에서부터, 굵지 않고 첫 조각이 아닌 것.
  const droppable = runs.map((r, i) => ({ r, i })).filter(({ r, i }) => i > 0 && !r.strong).map(({ i }) => i).reverse();
  const hidden = new Set(droppable.slice(0, dropped));
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // scrollWidth는 정수로 반올림돼 1~2px 넘침을 놓친다(리눅스 글자 폭에서 실제로 걸림): 조각의 오른쪽 끝을 소수점까지 잰다.
    const rect = el.getBoundingClientRect();
    let right = rect.left;
    for (const child of Array.from(el.children)) right = Math.max(right, child.getBoundingClientRect().right);
    const over = el.scrollWidth > el.clientWidth || right > rect.right + 0.5;
    if (over && dropped < droppable.length) setFit({ signature, dropped: dropped + 1 });
    else if (fit.signature !== signature) setFit({ signature, dropped });
  });
  return (
    <span ref={ref} className={['sn-rich', className ?? ''].filter(Boolean).join(' ')}>
      {runs.map((run, i) => {
        if (hidden.has(i)) return null;
        const tone = toneClass(run);
        return run.strong
          ? <b key={i} {...(tone ? { className: tone } : {})}>{run.text}</b>
          : <span key={i} {...(tone ? { className: tone } : {})}>{run.text}</span>;
      })}
    </span>
  );
}

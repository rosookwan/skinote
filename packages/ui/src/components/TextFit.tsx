// 글자 맞추기 부품(ui 5 TextFit). 말줄임표 없이 덜 중요한 부분이 통째로 빠진다(@skinote/layout의 fitText).
// 폭은 부르는 쪽이 알면(장부 칸) width로 받고, 모르면 스스로 잰다. 묶은 글꼴을 다 읽으면 다시 맞춘다.
import { fitText, fullText, type Measure, type TextFitInput } from '@skinote/layout';
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useDeviceProfile } from '../context.tsx';
import { approximateMeasure, measureFor, useElementSize, useFontsVersion, useIsoLayoutEffect } from '../measure.ts';

export interface TextFitProps {
  input: TextFitInput;
  /** 글자에 쓸 수 있는 폭(px). 없으면 요소의 폭을 잰다. */
  width?: number;
  className?: string;
  /** 다 빼도 넘치면 두 줄로 내려도 되는 자리(휴대폰 두 줄 줄). */
  allowTwoLines?: boolean;
  /** 한 줄에 안 들어가면 이 줄 수까지 내려 쓴다(빨리 확인 64px 줄은 두 줄). 넘길 때는 낱말 사이에서만 줄이 바뀐다. */
  lines?: number;
  style?: CSSProperties;
  /**
   * 고른 글을 그리는 법(없으면 글 그대로). 맞추기는 글로 하고, 그리기만 조각마다 색을 달리할 때 쓴다(합친 묶음 제목에서 늦은 묶음만 늦음 색).
   * 같은 글꼴 · 크기로만 그린다(폭이 달라지면 안 된다).
   */
  render?: (text: string) => ReactNode;
}

/** 여러 줄로 내려 쓸 때 줄 끝 빈자리를 셈한 몫(낱말 사이에서만 줄이 바뀌므로 넉넉히 뺀다). */
const WRAP_SHARE = 0.85;

export function fitLines(input: TextFitInput, width: number, lines: number, measure: Measure): { text: string; fits: boolean; wrapped: boolean } {
  // 대체 문구(주 버튼 이름)는 긴 것부터: 한 줄에 들어가거나, 여러 줄이 허락되면 그 줄 수에 들어가는 첫 문구(짧은 이름으로 수 · 돈을 빼기 전에).
  if (input.mode === 'alts' && lines > 1) {
    for (const text of input.alts) {
      const w = measure(text);
      if (w <= width) return { text, fits: true, wrapped: false };
      if (w <= width * lines * WRAP_SHARE) return { text, fits: true, wrapped: true };
    }
  }
  const one = fitText(input, width, measure);
  if (one.fits || lines <= 1) return { ...one, wrapped: false };
  const many = fitText(input, width * lines * WRAP_SHARE, measure);
  return { text: many.text, fits: many.fits, wrapped: true };
}

export function TextFit({ input, width, className, allowTwoLines = false, lines = 1, style, render }: TextFitProps) {
  const profile = useDeviceProfile();
  const ref = useRef<HTMLSpanElement>(null);
  const measured = useElementSize(ref);
  const fonts = useFontsVersion();
  const key = useMemo(() => JSON.stringify(input), [input]);
  const available = width ?? measured?.width;
  // 재기 전(서버 그리기 · 첫 그리기)에는 폭을 알면 대강의 글자 폭으로 맞춰 둔다.
  const initial = useMemo(() => {
    if (available === undefined) return { text: fullText(input), fits: true, wrapped: false };
    return fitLines(input, available, lines, approximateMeasure(profile.baseFontPx));
  }, [input, available, lines, profile.baseFontPx]);
  const [fitted, setFitted] = useState({ ...initial, key, fonts });
  // 폭을 받지 않고 스스로 재는 자리(버튼 안 글 등): 글이 바뀌거나 글꼴을 읽으면 온전한 글을 먼저 그려 가진 폭을 다시 잰다.
  // 그러지 않으면 앞서 줄인 글의 폭에 갇혀('매장 입고' → '입고 3개') 자리가 있어도 늘지 않는다.
  const stale = width === undefined && (fitted.key !== key || fitted.fonts !== fonts);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    const room = width ?? (el ? el.clientWidth : undefined);
    if (room === undefined) return;
    const result = fitLines(input, room, lines, measureFor(el, profile.baseFontPx));
    setFitted((prev) => (prev.key === key && prev.fonts === fonts && prev.text === result.text && prev.fits === result.fits && prev.wrapped === result.wrapped
      ? prev
      : { ...result, key, fonts }));
  }, [key, width, measured?.width, lines, fonts, profile.baseFontPx]);
  const shown = typeof window === 'undefined' ? initial : stale ? { text: fullText(input), fits: true, wrapped: false } : fitted;
  const classes = ['sn-fit', shown.wrapped || (!shown.fits && allowTwoLines) ? 'is-two-lines' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <span ref={ref} className={classes} style={style} data-fits={shown.fits ? undefined : 'false'}>
      {render ? render(shown.text) : shown.text}
    </span>
  );
}

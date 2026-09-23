// 재기: 요소 크기(ResizeObserver), 묶은 글꼴을 읽은 뒤 다시 맞추기, 글자 폭(canvas). 크기 숫자는 없다.
import type { Measure } from '@skinote/layout';
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import type { Size } from './device-profile.ts';

/** 서버 그리기(SSR)에서는 useEffect, 브라우저에서는 useLayoutEffect(그리기 전에 재고 맞춘다). */
export const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** 요소의 안쪽 크기. 처음(재기 전)과 서버 그리기에서는 fallback. */
export function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>, fallback: Size | null = null): Size | null {
  const [size, setSize] = useState<Size | null>(fallback);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      setSize((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** 창 크기(CSS px). 브라우저 확대(110 · 125%)도 줄어든 CSS px로 온다. */
export function useViewportSize(fallback: Size): Size {
  const [size, setSize] = useState<Size>(() =>
    typeof window === 'undefined' ? fallback : { width: window.innerWidth, height: window.innerHeight },
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const read = () => setSize((prev) => (prev.width === window.innerWidth && prev.height === window.innerHeight ? prev : { width: window.innerWidth, height: window.innerHeight }));
    read();
    window.addEventListener('resize', read);
    window.visualViewport?.addEventListener('resize', read);
    return () => {
      window.removeEventListener('resize', read);
      window.visualViewport?.removeEventListener('resize', read);
    };
  }, []);
  return size;
}

/** 묶은 글꼴(Pretendard)을 다 읽으면 오르는 번호. 글자 맞추기와 칸 폭은 이 번호가 바뀌면 다시 돈다. */
export function useFontsVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (typeof document === 'undefined' || !('fonts' in document)) return;
    let alive = true;
    const bump = () => { if (alive) setVersion((v) => v + 1); };
    void document.fonts.ready.then(bump);
    document.fonts.addEventListener('loadingdone', bump);
    return () => {
      alive = false;
      document.fonts.removeEventListener('loadingdone', bump);
    };
  }, []);
  return version;
}

const measurers = new Map<string, Measure>();

// 글꼴을 읽기 전에 잰 폭(대체 글꼴의 폭)은 묶은 글꼴을 다 읽으면 버린다. useFontsVersion의 번호가 오르기 전에 비운다.
if (typeof document !== 'undefined' && 'fonts' in document) {
  const forget = () => measurers.clear();
  document.fonts.addEventListener('loadingdone', forget);
  void document.fonts.ready.then(forget);
}

/**
 * 글자 폭 재기(canvas). font는 getComputedStyle(el).font 값이다. 문서가 없는 곳(서버 그리기, 시험)에서는
 * approximateMeasure로 떨어진다 — 그 값은 대강이라 설정 명령의 맞춤 검사에는 쓰지 않는다.
 */
export function canvasMeasure(font: string): Measure {
  const cached = measurers.get(font);
  if (cached) return cached;
  let measure: Measure;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const context = canvas?.getContext('2d') ?? null;
  if (context) {
    context.font = font;
    const widths = new Map<string, number>();
    measure = (text) => {
      let w = widths.get(text);
      if (w === undefined) {
        w = context.measureText(text).width;
        if (widths.size > 2000) widths.clear();
        widths.set(text, w);
      }
      return w;
    };
  } else {
    measure = approximateMeasure(Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? '16'));
  }
  measurers.set(font, measure);
  return measure;
}

/**
 * 대강의 글자 폭(Pretendard 굵은 글자를 Chromium에서 잰 값의 어림: 한글 0.87em, 숫자 · 영문 0.62em, 빈칸 · 문장 부호 0.3em).
 * 문서가 없는 곳(서버 그리기 · 시험)에서만 쓴다. 설정 명령의 맞춤 검사에는 묶은 글꼴의 글자 폭 표를 쓴다.
 */
export function approximateMeasure(fontPx: number): Measure {
  return (text) => {
    let w = 0;
    for (const ch of text) {
      if (/[ㄱ-ㆎ가-힣]/.test(ch)) w += fontPx * 0.87;
      else if (/[\s.,:;·'/()]/.test(ch)) w += fontPx * 0.3;
      else w += fontPx * 0.62;
    }
    return w;
  };
}

/** 요소의 글꼴로 재는 함수. */
export function measureFor(el: Element | null, fallbackPx: number): Measure {
  if (!el || typeof getComputedStyle === 'undefined') return approximateMeasure(fallbackPx);
  const style = getComputedStyle(el);
  const font = style.font || [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
  return canvasMeasure(font);
}

// 화면 키보드(한글 글자판, 계획 work/impl-server/plan.md 7-3): 포스에 실제 자판이 없어 이름 · 사유를 이 판의 키로 친다. 숫자판(NumberPad)처럼
// 아래에서 올라오는 판이고, 제목 · 표시 칸 · 두벌식 키 · `정정` · `띄어쓰기` · `숫자`/`한글` · `닫기` · 주 버튼 `입력`을 가진다.
// `닫기`는 키 줄 밖(제목 줄 끝, 제목 줄이 없으면 표시 칸 줄 끝)이다: 치던 글을 묻지 않고 버리는 키가 글쇠 사이에 있지 않게.
// 받지 않는 글(낱자모가 남은 이름)은 `입력`을 눌렀을 때만 알린다: 이름을 치는 동안은 새 글자마다 자음 하나가 먼저 오므로 치는 중에
// 안내를 띄우거나 `입력`을 막지 않는다. 안내는 제목 아래 한 줄(제목은 늘 보인다)이고 다음 키를 누르면 사라진다.
// 편집 칸(input · textarea · contentEditable)이 없다: 표시 칸은 <output>이고 글은 이 판의 키로만 들어가므로 Windows 터치 · 안드로이드 ·
// 아이폰의 운영체제 자판이 뜨지 않는다. 한글 조합은 hangul.ts(순수 함수)가 한다.
// 모양(두벌식 줄 배치 rows · 자모 차례 격자 grid, 제목 줄 유무)과 표시 칸 줄 수는 잰 판 크기 · 잰 글자 폭으로 layout fitKeyboard가
// 고르고, 키 크기는 DeviceProfile.keyboard에서 온다(크기 숫자로 가르지 않는다).
// 카운터 PC에 자판이 있으면 그것도 받는다: 글쇠 자리(KeyboardEvent.code)를 두벌식 자모로 읽어(운영체제 입력기 · 한/영 상태와 상관없이)
// 같은 조합 함수에 넣는다. 들어가기 = 입력, Esc = 닫기. 판이 열려 있는 동안 아래 화면의 단축키는 받지 않는다(잡기 단계에서 막음).
import { fitKeyboard } from '@skinote/layout';
import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { useUi } from '../context.tsx';
import type { DeviceProfile } from '../device-profile.ts';
import { jamoForCode, typeKey, type HangulKey, type HangulState } from '../hangul.ts';
import { KEYBOARD_LAYOUTS, KEYBOARD_SYMBOLS, shiftedJamo, type KeyboardKey, type KeyboardPage } from '../keyboard-layouts.ts';
import { approximateMeasure, measureFor, useElementSize, useFontsVersion, useIsoLayoutEffect } from '../measure.ts';
import { t } from '../strings.ko-KR.ts';

export interface HangulKeyboardProps {
  /** 판 제목('대표자', '직접 입력'). 제목 줄이 없으면 표시 칸 앞의 회색 이름표. */
  title: string;
  /** 처음 글(이미 적은 이름). */
  value: string;
  /** 빈 표시 칸의 회색 글('이름'). */
  placeholder?: string;
  /** 칠 수 있는 글자 수(코드 포인트). 표시 칸은 이만큼의 가장 넓은 글자가 들어가는 줄 수로 열린다. */
  maxLength: number;
  /** `입력`: 앞뒤 빈칸을 뺀 글. */
  onSubmit: (text: string) => void;
  onClose: () => void;
  /** 받는 글인지(부르는 쪽: 낱자모가 없는 이름). 받지 않는 글에 `입력`을 누르면 넘기지 않고 note를 보인다. */
  accept?: (text: string) => boolean;
  /** accept가 받지 않는 글에 `입력`을 눌렀을 때 제목 아래에 뜨는 회색 한 줄(`글자 미완성 · 정정 필요`). 다음 키에 사라진다. */
  note?: string;
}

/** 판의 상태: 친 글(조합 중인지), 보이는 쪽(한글 · 숫자), 쌍자음 키(한 번 쓰면 풀린다). */
export interface KeyboardState {
  hangul: HangulState;
  page: KeyboardPage;
  shift: boolean;
}

export function initialKeyboardState(value: string, maxLength: number): KeyboardState {
  return { hangul: { text: Array.from(value).slice(0, maxLength).join(''), composing: false }, page: 'hangul', shift: false };
}

/**
 * 판의 키 하나를 누른 뒤의 상태(`닫기` · `입력`은 부르는 쪽이 한다). 쌍자음은 자모 하나를 치면 풀리고(휴대폰 자판처럼, 길게 누르기 없음),
 * 쪽을 바꾸면 조합이 닫힌다.
 */
export function pressKeyboardKey(state: KeyboardState, key: KeyboardKey, maxLength: number): KeyboardState {
  switch (key.kind) {
    case 'jamo': return { ...state, hangul: typeKey(state.hangul, { jamo: shiftedJamo(key.jamo, state.shift) }, maxLength), shift: false };
    case 'char': return { ...state, hangul: typeKey(state.hangul, { char: key.char }, maxLength) };
    case 'space': return { ...state, hangul: typeKey(state.hangul, 'space', maxLength) };
    case 'erase': return { ...state, hangul: typeKey(state.hangul, 'backspace', maxLength) };
    case 'shift': return { ...state, shift: !state.shift };
    case 'page': return { hangul: typeKey(state.hangul, 'commit', maxLength), page: key.to, shift: false };
    default: return state;
  }
}

/** `입력`(또는 들어가기)의 뜻: 빈 글은 아무 일 없음, 받지 않는 글은 넘기지 않고 안내 한 줄, 아니면 앞뒤 빈칸을 뺀 글을 넘긴다. */
export type KeyboardSubmit = { type: 'none' } | { type: 'note' } | { type: 'submit'; text: string };

export function keyboardSubmit(text: string, accept?: (text: string) => boolean): KeyboardSubmit {
  const trimmed = text.trim();
  if (trimmed === '') return { type: 'none' };
  if (accept && !accept(text)) return { type: 'note' };
  return { type: 'submit', text: trimmed };
}

/** 실제 자판 누름의 뜻: 글자 · 입력 · 닫기, 막기만(판에 없는 글자), 그대로 두기(Tab · 기능 글쇠 · Ctrl 조합). */
export type PhysicalKeyAction = { type: 'key'; key: HangulKey } | { type: 'submit' } | { type: 'close' } | { type: 'block' } | { type: 'pass' };

const SYMBOLS: ReadonlySet<string> = new Set(KEYBOARD_SYMBOLS);

/** 실제 자판 누름 → 판의 동작. 글자 글쇠는 자리(code)로 두벌식 자모를 읽는다(한/영 상태와 상관없음). 영어 글자는 치지 않는다. */
export function physicalKeyAction(event: Pick<KeyboardEvent, 'code' | 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>): PhysicalKeyAction {
  if (event.ctrlKey || event.metaKey || event.altKey) return { type: 'pass' };
  if (event.key === 'Enter') return { type: 'submit' };
  if (event.key === 'Escape') return { type: 'close' };
  if (event.key === 'Backspace') return { type: 'key', key: 'backspace' };
  if (event.code === 'Space' || event.key === ' ') return { type: 'key', key: 'space' };
  const jamo = jamoForCode(event.code, event.shiftKey);
  if (jamo) return { type: 'key', key: { jamo } };
  if (/^\d$/.test(event.key) || SYMBOLS.has(event.key)) return { type: 'key', key: { char: event.key } };
  // 판에 없는 글자(영어 · 다른 기호)는 막고, 이름이 여러 글자인 글쇠(Tab · 화살표 · F5 …)는 그대로 둔다.
  return event.key.length === 1 ? { type: 'block' } : { type: 'pass' };
}

interface Metrics { glyphPx: number; lineHeightPx: number; titleLabelPx: number }

/** 표시 칸에서 가장 넓은 글자를 찾는 표본(한글 음절 · 낱자모 · 숫자). */
const GLYPH_SAMPLES = ['가', '뷁', '힣', '꽤', 'ㅃ', 'ㅙ', 'ㄻ', 'ㅢ', '8'];
/** 표시 칸 글의 줄 간격(CSS .sn-kb-text와 같음, 재기 전 어림에만 쓴다). */
const TEXT_LINE_HEIGHT = 1.3;

/** 재기 전(서버 그리기 · 시험)의 어림: 글자 폭 = 글자 크기(한글은 1em보다 좁다), 제목 폭은 대강의 글자 폭. */
function guessMetrics(profile: DeviceProfile, labels: readonly string[]): Metrics {
  const label = approximateMeasure(profile.bodyFontPx);
  return {
    glyphPx: profile.bigFontPx,
    lineHeightPx: Math.ceil(profile.bigFontPx * TEXT_LINE_HEIGHT),
    titleLabelPx: Math.ceil(Math.max(0, ...labels.map((s) => label(s)))),
  };
}

const px = (n: number) => n + 'px';
/** 키 폭 칸 수(CSS가 칸 폭 · 사이로 폭을 계산한다). */
const unitsStyle = (units: number) => ({ '--sn-kb-n': String(units) }) as CSSProperties;
/** 키를 눌러도 표시 칸 · 판의 초점이 키로 옮겨 가지 않게(실제 자판의 들어가기가 그 키를 다시 누르지 않게). */
const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

export function HangulKeyboard({ title, value, placeholder, maxLength, onSubmit, onClose, accept, note }: HangulKeyboardProps) {
  const { profile, viewport } = useUi();
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const box = useElementSize(overlayRef, viewport) ?? viewport;
  const [state, setState] = useState(() => initialKeyboardState(value, maxLength));
  // 받지 않는 글에 `입력`을 눌렀는지(안내 한 줄을 보인다). 다음 키를 누르면 풀린다.
  const [tried, setTried] = useState(false);
  const text = state.hangul.text;
  const ready = text.trim() !== '';
  const noteShown = Boolean(note) && tried;
  const submit = () => {
    const action = keyboardSubmit(text, accept);
    if (action.type === 'note') setTried(true);
    else if (action.type === 'submit') onSubmit(action.text);
  };

  // 잰 글자 폭 · 줄 높이 · 제목 폭(묶은 글꼴을 다 읽으면 다시 잰다).
  const fonts = useFontsVersion();
  const [metrics, setMetrics] = useState<Metrics>(() => guessMetrics(profile, note ? [title, note] : [title]));
  useIsoLayoutEffect(() => {
    const textEl = textRef.current;
    const titleEl = titleRef.current;
    if (!textEl || !titleEl) return;
    const glyph = measureFor(textEl, profile.bigFontPx);
    const label = measureFor(titleEl, profile.bodyFontPx);
    const next: Metrics = {
      glyphPx: Math.max(...GLYPH_SAMPLES.map((s) => glyph(s))),
      lineHeightPx: Number.parseFloat(getComputedStyle(textEl).lineHeight) || Math.ceil(profile.bigFontPx * TEXT_LINE_HEIGHT),
      titleLabelPx: Math.ceil(Math.max(label(title), note ? label(note) : 0)) + 1,
    };
    setMetrics((prev) => (prev.glyphPx === next.glyphPx && prev.lineHeightPx === next.lineHeightPx && prev.titleLabelPx === next.titleLabelPx ? prev : next));
  }, [fonts, profile, title, note]);
  const fit = fitKeyboard(box, profile.keyboard, { maxLength, ...metrics });
  const layout = KEYBOARD_LAYOUTS[fit.layout];
  const rows = layout.pages[state.page];

  // 실제 자판: 판이 맨 위 창일 때만, 잡기 단계에서 받아 아래 화면 · 숫자판의 단축키로 가지 않게 한다.
  const live = useRef({ ready, submit, onClose, maxLength });
  useIsoLayoutEffect(() => { live.current = { ready, submit, onClose, maxLength }; });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      // 위에 다른 창이 떠 있으면 그 창의 누름이다(보이는 창 가운데 마지막이 맨 위).
      const shown = [...document.querySelectorAll('[role="dialog"]')].filter((d) => d.getClientRects().length > 0);
      if (shown.at(-1) !== overlay) return;
      event.stopPropagation();
      const action = physicalKeyAction(event);
      if (action.type === 'pass') return;
      event.preventDefault();
      if (action.type === 'submit') live.current.submit();
      else if (action.type === 'close') live.current.onClose();
      else if (action.type === 'key') {
        const key = action.key;
        setTried(false);
        setState((s) => ({ ...s, hangul: typeKey(s.hangul, key, live.current.maxLength), shift: false }));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // 열 때 판으로 초점을 옮기고, 닫을 때 연 버튼으로 돌려준다.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.focus({ preventScroll: true });
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  const press = (key: KeyboardKey) => {
    setTried(false);
    setState((s) => pressKeyboardKey(s, key, maxLength));
  };
  const closeKey = (
    <button type="button" className="sn-kb-key is-word sn-kb-close" style={unitsStyle(1)} onMouseDown={keepFocus} onClick={onClose}>{t('close')}</button>
  );
  // 제목과 그 아래의 안내 한 줄(한 칸에 위아래로: 폭은 둘 중 넓은 것, 높이는 제목 줄 · 표시 칸 줄 = 키 높이 안).
  const label = (
    <div className="sn-kb-label">
      <h2 ref={titleRef} id={titleId} className="sn-kb-title">{title}</h2>
      {noteShown ? <p className="sn-kb-title sn-kb-note" role="status">{note}</p> : null}
    </div>
  );

  const renderKey = (key: KeyboardKey, index: number) => {
    const style = unitsStyle(key.units);
    const common = { type: 'button' as const, style, onMouseDown: keepFocus };
    switch (key.kind) {
      case 'blank': return <span key={index} className="sn-kb-blank" style={style} aria-hidden="true" />;
      case 'jamo': return <button key={index} {...common} className="sn-kb-key is-jamo" onClick={() => press(key)}>{shiftedJamo(key.jamo, state.shift)}</button>;
      case 'char': return <button key={index} {...common} className="sn-kb-key" onClick={() => press(key)}>{key.char}</button>;
      case 'shift':
        return <button key={index} {...common} className="sn-kb-key is-word" aria-pressed={state.shift} onClick={() => press(key)}>{t('shiftKey')}</button>;
      case 'erase': return <button key={index} {...common} className="sn-kb-key is-word" onClick={() => press(key)}>{t('erase')}</button>;
      case 'space': return <button key={index} {...common} className="sn-kb-key is-word" onClick={() => press(key)}>{t('space')}</button>;
      case 'page':
        return <button key={index} {...common} className="sn-kb-key is-word" onClick={() => press(key)}>{key.to === 'number' ? t('pageNumber') : t('pageHangul')}</button>;
      case 'enter':
        return <button key={index} {...common} className="sn-kb-key is-go" data-primary="true" disabled={!ready} onClick={submit}>{t('enter')}</button>;
    }
  };

  const chars = Array.from(text);
  const last = state.hangul.composing ? chars.pop() : undefined;
  const sheetStyle = {
    width: px(fit.sheetWidthPx),
    '--sn-kb-unit': px(Math.floor(fit.unitPx * 100) / 100),
    '--sn-kb-rows': String(layout.keyRows),
    '--sn-kb-lines': String(fit.displayLines),
    '--sn-kb-display-h': px(fit.displayPx),
    '--sn-kb-title-h': px(fit.titleRowPx),
  } as CSSProperties;

  return (
    <div ref={overlayRef} className="sn-sheet-overlay sn-kb-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <section
        ref={sheetRef}
        className={'sn-kb is-' + fit.layout + (fit.titleRow ? ' has-title' : ' is-compact') + ' is-' + state.page}
        tabIndex={-1}
        style={sheetStyle}
        data-layout={fit.layout}
        data-lines={fit.displayLines}
        data-max={maxLength}
        data-fits={fit.fits ? undefined : 'false'}
      >
        {fit.titleRow ? (
          <div className="sn-kb-head">
            {label}
            {closeKey}
          </div>
        ) : null}
        <div className="sn-kb-display-row">
          {fit.titleRow ? null : label}
          <output className={'sn-kb-display' + (text ? ' has-value' : '')} aria-live="polite" aria-labelledby={titleId} data-value={text}>
            <span ref={textRef} className="sn-kb-text">
              {chars.join('')}
              {last !== undefined ? <span className="sn-kb-composing">{last}</span> : null}
              <span className="sn-kb-caret" aria-hidden="true" />
              {text || !placeholder ? null : <span className="sn-kb-placeholder">{placeholder}</span>}
            </span>
          </output>
          {fit.titleRow ? null : closeKey}
        </div>
        <div className="sn-kb-keys">
          {rows.map((row, i) => <div key={state.page + i} className="sn-kb-row">{row.map(renderKey)}</div>)}
        </div>
      </section>
    </div>
  );
}

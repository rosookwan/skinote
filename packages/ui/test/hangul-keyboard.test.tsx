// 화면 키보드(HangulKeyboard, 계획 7-3): 서버 그리기로 모양(편집 칸 없음 · 주 버튼 하나 · 등급별 배치 · 문구)을 보고, 키 누름 ·
// 실제 자판 누름은 순수 함수(pressKeyboardKey · physicalKeyAction)로 본다. 브라우저 크기 규칙은 규칙 검사기(check-ui-rules.mjs)가 잰다.
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DeviceProfileProvider, HangulKeyboard, KEYBOARD_LAYOUTS, hasLoneJamo, initialKeyboardState, keyboardSubmit, physicalKeyAction, pressKeyboardKey,
  pressesFor, t, type HangulKeyboardProps, type KeyboardKey, type KeyboardState,
} from '../src/index.ts';
import type { DeviceRole, Size } from '../src/device-profile.ts';

const noop = () => {};

function render(node: ReactElement, size: Size = { width: 1024, height: 600 }, role: DeviceRole = 'counter'): string {
  return renderToStaticMarkup(<DeviceProfileProvider role={role} timezone="Asia/Seoul" size={size}>{node}</DeviceProfileProvider>);
}

const keyboard = (props: Partial<HangulKeyboardProps> = {}) => (
  <HangulKeyboard title="대표자" value="" placeholder="이름" maxLength={20} onSubmit={noop} onClose={noop} {...props} />
);

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[0]);
const texts = (html: string) => buttons(html).map((b) => b.replace(/<[^>]+>/g, '')).filter(Boolean);

describe('모양(서버 그리기)', () => {
  it('편집 칸이 없다: 표시 칸은 output, 운영체제 자판이 뜰 곳이 없다', () => {
    const html = render(keyboard());
    expect(html).not.toMatch(/<input|<textarea|contenteditable/i);
    expect(html).toContain('<output class="sn-kb-display"');
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="[^"]+"/);
    expect(html).toContain('class="sn-sheet-overlay sn-kb-overlay"');
  });

  it('1024×600 포스: 두벌식 줄 배치 + 제목 줄(닫기가 그 줄 끝), 키 32개(닫기 · 자모 26 · 쌍자음 · 정정 · 숫자 · 띄어쓰기 · 입력)', () => {
    const html = render(keyboard());
    expect(html).toContain('data-layout="rows"');
    expect(html).toContain('sn-kb is-rows has-title is-hangul');
    expect(buttons(html)).toHaveLength(26 + 6);
    // `닫기`는 키 줄 밖(제목 줄 끝): 치던 글을 버리는 키가 글쇠 사이에 있지 않다.
    expect(html).toMatch(/<div class="sn-kb-head"><div class="sn-kb-label"><h2[^>]*>대표자<\/h2><\/div><button[^>]*sn-kb-close[^>]*>닫기<\/button><\/div>/);
    const keys = html.slice(html.indexOf('class="sn-kb-keys"'));
    expect(keys).not.toContain('>닫기<');
    expect(texts(html).slice(1, 11)).toEqual(['ㅂ', 'ㅈ', 'ㄷ', 'ㄱ', 'ㅅ', 'ㅛ', 'ㅕ', 'ㅑ', 'ㅐ', 'ㅔ']);
    for (const word of [t('erase'), t('close'), t('pageNumber'), t('space'), t('enter')]) expect(texts(html)).toContain(word);
    // 쌍자음 키는 글자로 보인다(그림만 있는 키는 어르신 · 장갑 손에 어렵다).
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>쌍자음<\/button>/);
    expect(html).not.toContain('<svg');
    // 자모 키는 등급의 자모 글자 크기(--sn-kb-glyph), 말 키는 본문 크기.
    expect(html.match(/class="sn-kb-key is-jamo"/g)).toHaveLength(26);
    expect(html).toContain('<h2 id=');
    expect(html).toContain('>대표자</h2>');
    // 빈 글: 회색 '이름'과 막대, 주 버튼 `입력`은 하나이고 눌리지 않는다.
    expect(html).toContain('<span class="sn-kb-placeholder">이름</span>');
    expect(html.match(/data-primary="true"/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*class="sn-kb-key is-go" data-primary="true" disabled=""/);
  });

  it('키 폭은 칸 수(1 · 1.5 · 2 · 2.5 · 5.5), 한 칸 폭 · 표시 칸 · 제목 줄 높이는 잰 판 크기에서', () => {
    const html = render(keyboard());
    expect(html).toContain('--sn-kb-unit:76.4px');
    expect(html).toContain('--sn-kb-display-h:56px');
    expect(html).toContain('--sn-kb-title-h:56px');
    expect(html).toContain('width:860px');
    for (const units of ['1.5', '2', '2.5', '5.5', '0.5']) expect(html).toContain('--sn-kb-n:' + units);
  });

  it('360×640 기사 휴대폰: 자모 격자 + 제목 줄(닫기가 제목 줄에), 폭 전체', () => {
    const html = render(keyboard({ maxLength: 40 }), { width: 360, height: 640 }, 'driver');
    expect(html).toContain('data-layout="grid"');
    expect(html).toContain('width:360px');
    expect(html).toContain('--sn-kb-unit:64px');
    expect(html).toMatch(/<div class="sn-kb-head"><div class="sn-kb-label"><h2[^>]*>대표자<\/h2><\/div><button[^>]*>닫기<\/button><\/div>/);
    expect(texts(html).slice(1, 6)).toEqual(['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ']);
    expect(html).toContain('data-lines="3"');
  });

  it('640×360(가로로 돌린 휴대폰): 제목 줄 없이 표시 칸 앞의 이름표, 닫기는 표시 칸 줄 끝', () => {
    const html = render(keyboard({ maxLength: 40 }), { width: 640, height: 360 }, 'driver');
    expect(html).toContain('sn-kb is-rows is-compact');
    expect(html).toMatch(/<div class="sn-kb-display-row"><div class="sn-kb-label"><h2[^>]*>대표자<\/h2><\/div><output[\s\S]*?<\/output><button[^>]*>닫기<\/button><\/div>/);
  });

  it('처음 글이 있으면 보이고 `입력`이 눌린다(한도를 넘는 처음 글은 자른다)', () => {
    const html = render(keyboard({ value: '김민수' }));
    expect(html).toContain('<span class="sn-kb-text">김민수<span class="sn-kb-caret" aria-hidden="true"></span></span>');
    expect(html).toContain('sn-kb-display has-value');
    expect(html).not.toMatch(/data-primary="true" disabled/);
    expect(initialKeyboardState('가나다라', 3).hangul.text).toBe('가나다');
  });

  it('이름을 치는 동안(새 글자마다 자음 하나가 먼저 온다)은 안내 한 줄이 없고 `입력`이 눌린다: 박준호 · 김영희 · 이정호 · 최하은', () => {
    const accept = (text: string) => !hasLoneJamo(text);
    for (const name of ['박준호', '김영희', '이정호', '최하은']) {
      let state = initialKeyboardState('', 20);
      for (const k of pressesFor(name)) {
        if (typeof k !== 'object' || !('jamo' in k)) continue;
        state = pressKeyboardKey(state, { kind: 'jamo', jamo: k.jamo, units: 1 }, 20);
        const html = render(keyboard({ value: state.hangul.text, accept, note: t('textIncomplete') }));
        expect(html, name + ' · ' + state.hangul.text).not.toContain('sn-kb-note');
        expect(html, name + ' · ' + state.hangul.text).not.toMatch(/data-primary="true" disabled/);
        expect(html).toMatch(/<h2 id="[^"]+" class="sn-kb-title">대표자<\/h2>/);
      }
      expect(state.hangul.text).toBe(name);
    }
  });

  it('`입력`의 뜻: 빈 글은 아무 일 없음, 낱자모가 남으면 넘기지 않고 안내, 아니면 앞뒤 빈칸을 뺀 글', () => {
    const accept = (text: string) => !hasLoneJamo(text);
    expect(keyboardSubmit('  ', accept)).toEqual({ type: 'none' });
    expect(keyboardSubmit('김민ㅅ', accept)).toEqual({ type: 'note' });
    expect(keyboardSubmit(' 김민수 ', accept)).toEqual({ type: 'submit', text: '김민수' });
    expect(keyboardSubmit('ㅋㅋ')).toEqual({ type: 'submit', text: 'ㅋㅋ' });
    // 낱자모가 남은 처음 글도 판을 열 때는 안내 없이 제목만(안내는 `입력`을 누른 뒤).
    const html = render(keyboard({ value: '김민ㅅ', accept, note: t('textIncomplete') }));
    expect(html).not.toContain('sn-kb-note');
    expect(html).not.toMatch(/\shidden=""/);
  });

  it('영어 글자 · 말줄임표가 없다', () => {
    for (const html of [render(keyboard()), render(keyboard({ maxLength: 40 }), { width: 360, height: 640 }, 'driver')]) {
      const visible = html.replace(/<[^>]+>/g, '\n');
      expect(visible).not.toMatch(/[A-Za-z]/);
      expect(visible).not.toContain('…');
      for (const [, label] of html.matchAll(/aria-label="([^"]*)"/g)) expect(label).not.toMatch(/[A-Za-z]/);
    }
  });
});

describe('키 누름(pressKeyboardKey)', () => {
  const start: KeyboardState = initialKeyboardState('', 20);
  const key = (k: KeyboardKey) => k;
  const jamo = (j: string) => key({ kind: 'jamo', jamo: j, units: 1 });
  const shift = key({ kind: 'shift', units: 1.5 });
  const press = (s: KeyboardState, ...keys: KeyboardKey[]) => keys.reduce((acc, k) => pressKeyboardKey(acc, k, 20), s);

  it('ㄱ ㅣ ㅁ → 김', () => {
    expect(press(start, jamo('ㄱ'), jamo('ㅣ'), jamo('ㅁ')).hangul).toEqual({ text: '김', composing: true });
  });

  it('쌍자음은 한 번만: ⇧ ㄱ ㅗ ㄱ → 꼭(두 번째 ㄱ은 그대로)', () => {
    const s = press(start, shift, jamo('ㄱ'), jamo('ㅗ'), jamo('ㄱ'));
    expect(s.hangul.text).toBe('꼭');
    expect(s.shift).toBe(false);
    expect(press(start, shift).shift).toBe(true);
    expect(press(start, shift, shift).shift).toBe(false);
    // ㅐ · ㅔ도 쌍자음 키로 ㅒ · ㅖ.
    expect(press(start, jamo('ㅇ'), shift, jamo('ㅐ')).hangul.text).toBe('얘');
  });

  it('숫자 쪽으로 바꾸면 조합이 닫히고 쌍자음이 풀린다', () => {
    const toNumber = KEYBOARD_LAYOUTS.rows.pages.hangul[3]!.find((k) => k.kind === 'page')!;
    const toHangul = KEYBOARD_LAYOUTS.rows.pages.number[3]!.find((k) => k.kind === 'page')!;
    const s = press(start, jamo('ㄱ'), jamo('ㅏ'), shift, toNumber);
    expect(s).toEqual({ hangul: { text: '가', composing: false }, page: 'number', shift: false });
    const back = press(s, { kind: 'char', char: '2', units: 1 }, toHangul, jamo('ㅇ'));
    expect(back.hangul.text).toBe('가2ㅇ');
    expect(back.page).toBe('hangul');
  });

  it('정정 · 띄어쓰기 · 입력(판은 모름)', () => {
    const typed = press(start, jamo('ㄷ'), jamo('ㅏ'), jamo('ㄹ'), jamo('ㄱ'));
    expect(press(typed, { kind: 'erase', units: 1.5 }).hangul.text).toBe('달');
    expect(press(typed, { kind: 'space', units: 5.5 }).hangul).toEqual({ text: '닭 ', composing: false });
    expect(press(typed, { kind: 'enter', units: 2.5 })).toBe(typed);
  });

  it('한도(20자)를 넘지 않는다', () => {
    let s = start;
    for (let i = 0; i < 30; i += 1) s = press(s, jamo('ㅂ'), jamo('ㅜ'), jamo('ㅔ'), jamo('ㄹ'), jamo('ㄱ'));
    expect(Array.from(s.hangul.text)).toHaveLength(20);
    expect(s.hangul.text).toBe('뷁'.repeat(20));
  });
});

describe('실제 자판(physicalKeyAction)', () => {
  const ev = (code: string, key: string, extra: Partial<KeyboardEvent> = {}) => ({ code, key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

  it('글쇠 자리로 두벌식 자모(한/영 상태 무관), Shift는 쌍자음', () => {
    expect(physicalKeyAction(ev('KeyR', 'r'))).toEqual({ type: 'key', key: { jamo: 'ㄱ' } });
    expect(physicalKeyAction(ev('KeyR', 'ㄱ'))).toEqual({ type: 'key', key: { jamo: 'ㄱ' } });
    expect(physicalKeyAction(ev('KeyR', 'R', { shiftKey: true }))).toEqual({ type: 'key', key: { jamo: 'ㄲ' } });
    expect(physicalKeyAction(ev('KeyK', 'k'))).toEqual({ type: 'key', key: { jamo: 'ㅏ' } });
  });

  it('숫자 · 판의 기호 · 정정 · 띄어쓰기 · 들어가기 · Esc', () => {
    expect(physicalKeyAction(ev('Digit7', '7'))).toEqual({ type: 'key', key: { char: '7' } });
    expect(physicalKeyAction(ev('Numpad3', '3'))).toEqual({ type: 'key', key: { char: '3' } });
    expect(physicalKeyAction(ev('Minus', '-'))).toEqual({ type: 'key', key: { char: '-' } });
    expect(physicalKeyAction(ev('Digit9', '(', { shiftKey: true }))).toEqual({ type: 'key', key: { char: '(' } });
    expect(physicalKeyAction(ev('Backspace', 'Backspace'))).toEqual({ type: 'key', key: 'backspace' });
    expect(physicalKeyAction(ev('Space', ' '))).toEqual({ type: 'key', key: 'space' });
    expect(physicalKeyAction(ev('Enter', 'Enter'))).toEqual({ type: 'submit' });
    expect(physicalKeyAction(ev('NumpadEnter', 'Enter'))).toEqual({ type: 'submit' });
    expect(physicalKeyAction(ev('Escape', 'Escape'))).toEqual({ type: 'close' });
  });

  it('판에 없는 글자는 막고, Tab · 기능 글쇠 · Ctrl 조합은 그대로 둔다', () => {
    expect(physicalKeyAction(ev('Digit1', '!', { shiftKey: true }))).toEqual({ type: 'block' });
    expect(physicalKeyAction(ev('Semicolon', ';'))).toEqual({ type: 'block' });
    expect(physicalKeyAction(ev('Tab', 'Tab'))).toEqual({ type: 'pass' });
    expect(physicalKeyAction(ev('F5', 'F5'))).toEqual({ type: 'pass' });
    expect(physicalKeyAction(ev('ShiftLeft', 'Shift', { shiftKey: true }))).toEqual({ type: 'pass' });
    expect(physicalKeyAction(ev('KeyR', 'r', { ctrlKey: true }))).toEqual({ type: 'pass' });
    expect(physicalKeyAction(ev('KeyC', 'c', { metaKey: true }))).toEqual({ type: 'pass' });
  });
});

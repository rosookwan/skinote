// 화면 키보드의 키 배치(keyboard-layouts.ts, 계획 7-2): 줄마다 칸 수 합 = 배치의 칸 수, 쪽의 줄 수 ≤ 모양의 키 줄 수, 두벌식 자모가
// 빠짐없이 한 번씩, 숫자 쪽의 숫자 · 기호, 쪽마다 `입력` · `정정` · `띄어쓰기` · 쪽 바꾸기가 하나씩, 맨 아래 줄의 `입력`이 두 쪽에서 같은 자리.
// `닫기`는 어느 배치의 키 줄에도 없다(판의 제목 줄 · 표시 칸 줄 끝).
import { KEYBOARD_SHAPES } from '@skinote/layout';
import { describe, expect, it } from 'vitest';
import { DUBEOLSIK, typeKey } from '../src/hangul.ts';
import { KEYBOARD_LAYOUTS, KEYBOARD_SYMBOLS, rowUnits, shiftedJamo, type KeyboardKey } from '../src/keyboard-layouts.ts';

const layouts = Object.values(KEYBOARD_LAYOUTS);
const all = (rows: readonly (readonly KeyboardKey[])[]) => rows.flat();
const jamoOf = (rows: readonly (readonly KeyboardKey[])[]) => all(rows).flatMap((k) => (k.kind === 'jamo' ? [k.jamo] : []));
const charsOf = (rows: readonly (readonly KeyboardKey[])[]) => all(rows).flatMap((k) => (k.kind === 'char' ? [k.char] : []));
const count = (rows: readonly (readonly KeyboardKey[])[], kind: KeyboardKey['kind']) => all(rows).filter((k) => k.kind === kind).length;

describe('키 배치', () => {
  it.each(layouts.map((l) => [l.key, l] as const))('%s: 줄마다 칸 수 합이 배치의 칸 수, 줄 수는 모양의 키 줄 수', (_, layout) => {
    expect(layout.columns).toBe(KEYBOARD_SHAPES[layout.key].columns);
    expect(layout.keyRows).toBe(KEYBOARD_SHAPES[layout.key].keyRows);
    expect(layout.pages.hangul).toHaveLength(layout.keyRows);
    expect(layout.pages.number.length).toBeLessThanOrEqual(layout.keyRows);
    for (const page of Object.values(layout.pages)) for (const row of page) expect(rowUnits(row)).toBe(layout.columns);
  });

  it.each(layouts.map((l) => [l.key, l] as const))('%s: 쪽마다 입력 · 정정 · 띄어쓰기 · 쪽 바꾸기가 하나씩', (_, layout) => {
    for (const page of Object.values(layout.pages)) {
      expect(count(page, 'enter')).toBe(1);
      expect(count(page, 'erase')).toBe(1);
      expect(count(page, 'space')).toBe(1);
      expect(count(page, 'page')).toBe(1);
      expect(all(page).some((k) => (k.kind as string) === 'close')).toBe(false);
    }
    expect(count(layout.pages.hangul, 'shift')).toBe(1);
    expect(count(layout.pages.number, 'shift')).toBe(0);
    const toggles = Object.entries(layout.pages).map(([name, page]) => [name, all(page).find((k) => k.kind === 'page')]);
    expect(toggles).toEqual([['hangul', expect.objectContaining({ to: 'number' })], ['number', expect.objectContaining({ to: 'hangul' })]]);
  });

  it.each(layouts.map((l) => [l.key, l] as const))('%s: 맨 아래 줄은 두 쪽에서 같은 자리(입력 · 띄어쓰기가 움직이지 않는다)', (_, layout) => {
    const shape = (row: readonly KeyboardKey[] | undefined) => (row ?? []).map((k) => k.kind + ':' + k.units);
    expect(shape(layout.pages.hangul.at(-1))).toEqual(shape(layout.pages.number.at(-1)));
  });

  it('두벌식 줄 배치: 두벌식 세 줄 그대로, 가운데 줄은 반 칸 들여쓰기', () => {
    const hangul = KEYBOARD_LAYOUTS.rows.pages.hangul;
    expect(hangul.slice(0, 3).map((row) => row.flatMap((k) => (k.kind === 'jamo' ? [k.jamo] : [])))).toEqual(DUBEOLSIK.rows);
    expect(hangul[1]?.[0]).toEqual({ kind: 'blank', units: 0.5 });
    expect(hangul[2]?.map((k) => k.kind + ':' + k.units)).toEqual(['shift:1.5', ...Array(7).fill('jamo:1'), 'erase:1.5']);
    // `닫기`가 빠진 두 칸은 `숫자`(1.5 → 2)와 `띄어쓰기`(4 → 5.5)가 나눠 가진다.
    expect(hangul[3]?.map((k) => k.kind + ':' + k.units)).toEqual(['page:2', 'space:5.5', 'enter:2.5']);
  });

  it('자모 격자: 자음 14 · 모음 10 · ㅐ ㅔ가 사전 차례로 한 번씩, 정정 3칸', () => {
    expect(jamoOf(KEYBOARD_LAYOUTS.grid.pages.hangul)).toEqual([
      'ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
      'ㅏ', 'ㅑ', 'ㅓ', 'ㅕ', 'ㅗ', 'ㅛ', 'ㅜ', 'ㅠ', 'ㅡ', 'ㅣ', 'ㅐ', 'ㅔ',
    ]);
    expect(all(KEYBOARD_LAYOUTS.grid.pages.hangul).find((k) => k.kind === 'erase')?.units).toBe(3);
  });

  it.each(layouts.map((l) => [l.key, l] as const))('%s: 두 배치가 같은 자모(두벌식 26개)를 가진다', (_, layout) => {
    expect(jamoOf(layout.pages.hangul).sort()).toEqual(DUBEOLSIK.rows.flat().sort());
  });

  it.each(layouts.map((l) => [l.key, l] as const))('%s: 숫자 쪽은 숫자 0 ~ 9와 기호가 한 번씩', (_, layout) => {
    const chars = charsOf(layout.pages.number);
    expect(chars.filter((c) => /\d/.test(c)).sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(chars.filter((c) => !/\d/.test(c)).sort()).toEqual([...KEYBOARD_SYMBOLS].sort());
    expect(new Set(chars).size).toBe(chars.length);
  });

  it('쌍자음 키: ㅂ ㅈ ㄷ ㄱ ㅅ ㅐ ㅔ만 바뀌고, 바뀐 자모도 조합된다', () => {
    const shifted = DUBEOLSIK.rows.flat().map((j) => shiftedJamo(j, true));
    expect(shifted.filter((j, i) => j !== DUBEOLSIK.rows.flat()[i])).toEqual(['ㅃ', 'ㅉ', 'ㄸ', 'ㄲ', 'ㅆ', 'ㅒ', 'ㅖ']);
    expect(shiftedJamo('ㅂ', false)).toBe('ㅂ');
    for (const jamo of [...DUBEOLSIK.rows.flat(), ...shifted]) {
      const typed = typeKey({ text: '', composing: false }, { jamo }, 5);
      expect(typed.text, jamo).toBe(jamo);
    }
  });
});

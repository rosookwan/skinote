// 화면 키보드의 키 배치(계획 work/impl-server/plan.md 7-2). 자료만 있고 그리기는 HangulKeyboard가 한다.
// 키 폭은 칸(unit) 수이고 줄마다 칸 수의 합이 배치의 칸 수(rows 10 · grid 5)와 같다(시험이 맞춰 본다).
// 두 쪽: 한글(자모 · 쌍자음 · 정정 · 띄어쓰기) · 숫자(숫자 · 기호). 쪽의 줄 수는 layout KEYBOARD_SHAPES의 keyRows 이하이고,
// 줄이 적은 쪽은 아래에 붙인다(맨 아래 줄의 `입력` · `띄어쓰기`가 쪽을 바꿔도 같은 자리에 있다).
// `닫기`는 키 줄에 없다(치던 글을 묻지 않고 버리는 키가 글쇠 사이에 있지 않게): 판의 제목 줄 끝, 제목 줄이 없으면 표시 칸 줄 끝.
// 어느 배치를 쓸지는 잰 판 크기로 layout fitKeyboard가 고른다.
import { KEYBOARD_SHAPES, type KeyboardLayoutKey } from '@skinote/layout';
import { DUBEOLSIK } from './hangul.ts';

export type KeyboardPage = 'hangul' | 'number';

/** 키 하나. units = 칸 수(0.5 칸 들여쓰기는 blank). */
export type KeyboardKey =
  | { kind: 'jamo'; jamo: string; units: number }
  | { kind: 'char'; char: string; units: number }
  | { kind: 'shift' | 'erase' | 'space' | 'enter'; units: number }
  | { kind: 'page'; to: KeyboardPage; units: number }
  | { kind: 'blank'; units: number };

export interface KeyboardLayout {
  key: KeyboardLayoutKey;
  columns: number;
  /** 키 줄 수(두 쪽 가운데 많은 쪽, 판 높이의 기준). */
  keyRows: number;
  pages: Readonly<Record<KeyboardPage, readonly (readonly KeyboardKey[])[]>>;
}

const jamo = (list: readonly string[], units = 1): KeyboardKey[] => list.map((j) => ({ kind: 'jamo', jamo: j, units }));
const chars = (list: readonly string[], units = 1): KeyboardKey[] => list.map((c) => ({ kind: 'char', char: c, units }));

/** 숫자 쪽의 기호(이름 · 사유에 쓰는 것만). */
export const KEYBOARD_SYMBOLS = ['-', '.', ',', '(', ')', '·', '/', ':', '~'] as const;

const [ROW1 = [], ROW2 = [], ROW3 = []] = DUBEOLSIK.rows;

/** 두벌식 줄 배치(10칸): 포스 · 좁은 포스 · 기사 태블릿 · 가로로 돌린 휴대폰. */
const ROWS: KeyboardLayout = {
  key: 'rows',
  columns: KEYBOARD_SHAPES.rows.columns,
  keyRows: KEYBOARD_SHAPES.rows.keyRows,
  pages: {
    hangul: [
      jamo(ROW1),
      [{ kind: 'blank', units: 0.5 }, ...jamo(ROW2), { kind: 'blank', units: 0.5 }],
      [{ kind: 'shift', units: 1.5 }, ...jamo(ROW3), { kind: 'erase', units: 1.5 }],
      [{ kind: 'page', to: 'number', units: 2 }, { kind: 'space', units: 5.5 }, { kind: 'enter', units: 2.5 }],
    ],
    number: [
      chars(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']),
      chars(['-', '.', ',', '(', ')'], 2),
      [...chars(['·', '/', ':', '~'], 2), { kind: 'erase', units: 2 }],
      [{ kind: 'page', to: 'hangul', units: 2 }, { kind: 'space', units: 5.5 }, { kind: 'enter', units: 2.5 }],
    ],
  },
};

/** 자모 차례 격자(늘 5칸): 세운 휴대폰. */
const GRID: KeyboardLayout = {
  key: 'grid',
  columns: KEYBOARD_SHAPES.grid.columns,
  keyRows: KEYBOARD_SHAPES.grid.keyRows,
  pages: {
    hangul: [
      jamo(['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ']),
      jamo(['ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ']),
      [...jamo(['ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']), { kind: 'shift', units: 1 }],
      jamo(['ㅏ', 'ㅑ', 'ㅓ', 'ㅕ', 'ㅗ']),
      jamo(['ㅛ', 'ㅜ', 'ㅠ', 'ㅡ', 'ㅣ']),
      [...jamo(['ㅐ', 'ㅔ']), { kind: 'erase', units: 3 }],
      [{ kind: 'page', to: 'number', units: 1.5 }, { kind: 'space', units: 2 }, { kind: 'enter', units: 1.5 }],
    ],
    number: [
      chars(['1', '2', '3', '-', '.']),
      chars(['4', '5', '6', '(', ')']),
      chars(['7', '8', '9', '·', '/']),
      [...chars([',', '0', ':', '~']), { kind: 'erase', units: 1 }],
      [{ kind: 'page', to: 'hangul', units: 1.5 }, { kind: 'space', units: 2 }, { kind: 'enter', units: 1.5 }],
    ],
  },
};

export const KEYBOARD_LAYOUTS: Readonly<Record<KeyboardLayoutKey, KeyboardLayout>> = { rows: ROWS, grid: GRID };

/** 줄의 칸 수 합. */
export const rowUnits = (row: readonly KeyboardKey[]) => row.reduce((sum, key) => sum + key.units, 0);

/** 쌍자음 키(⇧)가 켜졌을 때 키에 보이는 자모(ㅂ → ㅃ, ㅐ → ㅒ …). 바뀌지 않는 자모는 그대로. */
export const shiftedJamo = (j: string, shift: boolean) => (shift ? (DUBEOLSIK.shifted[j] ?? j) : j);

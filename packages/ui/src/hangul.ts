// 한글 조합(두벌식, 계획 work/impl-server/plan.md 7-1). 화면 키보드(HangulKeyboard)의 글자를 만드는 순수 함수이고 React · DOM이 없다.
// 글자판에는 편집 칸이 없어(운영체제 자판이 뜨지 않게) 운영체제의 한글 입력기 대신 이 함수가 자모를 음절로 묶는다.
// 조합은 마지막 한 음절(열린 음절)에서만 한다. 앞 음절은 닫혀 있어 다시 열지 않는다. 받침이 다음 모음을 만나면 다음 음절의 첫소리로
// 옮긴다(닭 + ㅏ → 달가). 지우기(`정정`)는 조합 중이면 마지막 자모 하나, 아니면 한 글자를 지운다.
// 음절 = 0xAC00 + (첫소리 × 21 + 가운뎃소리) × 28 + 끝소리(첫소리 19 · 가운뎃소리 21 · 끝소리 27 + 없음).

export interface HangulState {
  text: string;
  /** 마지막 글자(음절 또는 낱자모)가 아직 열려 있어 다음 자모와 묶일 수 있는지. */
  composing: boolean;
}

/** 자모 하나(`{ jamo: 'ㄱ' }`), 조합하지 않는 글자(숫자 · 기호), 지우기, 띄어쓰기, 조합 끝내기. */
export type HangulKey = { jamo: string } | { char: string } | 'backspace' | 'space' | 'commit';

const SYLLABLE_BASE = 0xac00;
const SYLLABLE_LAST = 0xd7a3;

/** 첫소리 19. */
const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'] as const;
/** 가운뎃소리 21(겹모음 ㅘ ㅙ ㅚ ㅝ ㅞ ㅟ ㅢ 포함). */
const JUNG = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'] as const;
/** 끝소리 27 + 없음(0). ㄸ · ㅃ · ㅉ는 받침이 아니다. */
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'] as const;

/** 두 번 눌러 만드는 겹모음. */
const VOWEL_PAIRS: Readonly<Record<string, readonly [string, string]>> = {
  'ㅘ': ['ㅗ', 'ㅏ'], 'ㅙ': ['ㅗ', 'ㅐ'], 'ㅚ': ['ㅗ', 'ㅣ'], 'ㅝ': ['ㅜ', 'ㅓ'], 'ㅞ': ['ㅜ', 'ㅔ'], 'ㅟ': ['ㅜ', 'ㅣ'], 'ㅢ': ['ㅡ', 'ㅣ'],
};
/** 두 번 눌러 만드는 겹받침. */
const FINAL_PAIRS: Readonly<Record<string, readonly [string, string]>> = {
  'ㄳ': ['ㄱ', 'ㅅ'], 'ㄵ': ['ㄴ', 'ㅈ'], 'ㄶ': ['ㄴ', 'ㅎ'], 'ㄺ': ['ㄹ', 'ㄱ'], 'ㄻ': ['ㄹ', 'ㅁ'], 'ㄼ': ['ㄹ', 'ㅂ'],
  'ㄽ': ['ㄹ', 'ㅅ'], 'ㄾ': ['ㄹ', 'ㅌ'], 'ㄿ': ['ㄹ', 'ㅍ'], 'ㅀ': ['ㄹ', 'ㅎ'], 'ㅄ': ['ㅂ', 'ㅅ'],
};

const joinOf = (pairs: Readonly<Record<string, readonly [string, string]>>) =>
  new Map(Object.entries(pairs).map(([whole, [a, b]]) => [a + b, whole]));
const VOWEL_JOIN = joinOf(VOWEL_PAIRS);
const FINAL_JOIN = joinOf(FINAL_PAIRS);

const CHO_INDEX = new Map<string, number>(CHO.map((c, i) => [c, i]));
const JUNG_INDEX = new Map<string, number>(JUNG.map((v, i) => [v, i]));
const JONG_INDEX = new Map<string, number>(JONG.map((t, i) => [t, i]).filter(([t]) => t !== '') as [string, number][]);

/** 한글 호환 자모(U+3131 ~ U+318E): 낱자모로 남은 글자. */
const LONE_JAMO = /[ㄱ-ㆎ]/;

/** 자모 하나가 자음인지(겹자음 · 겹받침 포함). */
const isConsonant = (j: string) => j >= 'ㄱ' && j <= 'ㅎ';
const isVowel = (j: string) => j >= 'ㅏ' && j <= 'ㅣ';

/** 열린 음절의 모양: 자음만(L) · 모음만(V) · 자음 + 모음(LV) · 자음 + 모음 + 받침(LVT). */
type Open =
  | { kind: 'L'; cho: string }
  | { kind: 'V'; jung: string }
  | { kind: 'LV'; cho: string; jung: string }
  | { kind: 'LVT'; cho: string; jung: string; jong: string };

function compose(open: Open): string {
  switch (open.kind) {
    case 'L': return open.cho;
    case 'V': return open.jung;
    case 'LV':
    case 'LVT': {
      const cho = CHO_INDEX.get(open.cho) ?? 0;
      const jung = JUNG_INDEX.get(open.jung) ?? 0;
      const jong = open.kind === 'LVT' ? (JONG_INDEX.get(open.jong) ?? 0) : 0;
      return String.fromCodePoint(SYLLABLE_BASE + (cho * 21 + jung) * 28 + jong);
    }
  }
}

/** 글자 하나를 열린 음절로 푼다. 음절도 한글 자모도 아니면 null. */
function decompose(ch: string): Open | null {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= SYLLABLE_BASE && code <= SYLLABLE_LAST) {
    const index = code - SYLLABLE_BASE;
    const cho = CHO[Math.floor(index / 588)]!;
    const jung = JUNG[Math.floor((index % 588) / 28)]!;
    const jong = JONG[index % 28]!;
    return jong ? { kind: 'LVT', cho, jung, jong } : { kind: 'LV', cho, jung };
  }
  if (CHO_INDEX.has(ch)) return { kind: 'L', cho: ch };
  if (JUNG_INDEX.has(ch)) return { kind: 'V', jung: ch };
  return null;
}

/** 코드 포인트 단위로 자른 글(한글은 모두 BMP라 한 글자 = 한 코드 포인트). */
const chars = (text: string) => Array.from(text);

function withLast(text: string, last: string): string {
  const list = chars(text);
  list[list.length - 1] = last;
  return list.join('');
}

function withoutLast(text: string): string {
  const list = chars(text);
  list.pop();
  return list.join('');
}

/** 겹모음 · 겹받침을 한 번에 넘겨도 누른 순서대로 푼다(ㅘ → ㅗ, ㅏ). 쌍자음 · ㅒ · ㅖ는 한 번 누름이다. */
function pressesOf(jamo: string): string[] {
  return [...(VOWEL_PAIRS[jamo] ?? FINAL_PAIRS[jamo] ?? [jamo])];
}

function typeJamo(state: HangulState, jamo: string, maxLength: number): HangulState {
  const length = chars(state.text).length;
  /** 새 글자를 더한다(한도면 누름을 버린다). */
  const append = (open: Open, closePrev = state.text): HangulState =>
    chars(closePrev).length >= maxLength ? state : { text: closePrev + compose(open), composing: true };
  const open = state.composing && length ? decompose(chars(state.text).at(-1)!) : null;
  if (isVowel(jamo)) {
    if (!open) return append({ kind: 'V', jung: jamo });
    switch (open.kind) {
      case 'L': return { text: withLast(state.text, compose({ kind: 'LV', cho: open.cho, jung: jamo })), composing: true };
      case 'V': {
        const joined = VOWEL_JOIN.get(open.jung + jamo);
        return joined ? { text: withLast(state.text, joined), composing: true } : append({ kind: 'V', jung: jamo });
      }
      case 'LV': {
        const joined = VOWEL_JOIN.get(open.jung + jamo);
        return joined ? { text: withLast(state.text, compose({ ...open, jung: joined })), composing: true } : append({ kind: 'V', jung: jamo });
      }
      case 'LVT': {
        // 받침(겹받침이면 뒤 자음)이 다음 음절의 첫소리로 옮겨 간다: 닭 + ㅏ → 달가, 갑 + ㅣ → 가비. 앞 음절은 닫힌다.
        if (length >= maxLength) return state;
        const pair = FINAL_PAIRS[open.jong];
        const stay = pair ? compose({ ...open, jong: pair[0] }) : compose({ kind: 'LV', cho: open.cho, jung: open.jung });
        const moved = pair ? pair[1] : open.jong;
        return { text: withLast(state.text, stay) + compose({ kind: 'LV', cho: moved, jung: jamo }), composing: true };
      }
    }
  }
  if (!isConsonant(jamo)) return state;
  if (!open) return append({ kind: 'L', cho: jamo });
  switch (open.kind) {
    case 'L':
    case 'V':
      // 낱자음끼리는 묶지 않는다(쌍자음은 쌍자음 키로만).
      return append({ kind: 'L', cho: jamo });
    case 'LV':
      return JONG_INDEX.has(jamo)
        ? { text: withLast(state.text, compose({ kind: 'LVT', cho: open.cho, jung: open.jung, jong: jamo })), composing: true }
        : append({ kind: 'L', cho: jamo });
    case 'LVT': {
      const joined = FINAL_JOIN.get(open.jong + jamo);
      return joined ? { text: withLast(state.text, compose({ ...open, jong: joined })), composing: true } : append({ kind: 'L', cho: jamo });
    }
  }
}

function backspace(state: HangulState): HangulState {
  const list = chars(state.text);
  if (!list.length) return { text: '', composing: false };
  const open = state.composing ? decompose(list.at(-1)!) : null;
  if (!open) return { text: withoutLast(state.text), composing: false };
  const shorter = (next: Open): HangulState => ({ text: withLast(state.text, compose(next)), composing: true });
  switch (open.kind) {
    case 'L': return { text: withoutLast(state.text), composing: false };
    case 'V': {
      const pair = VOWEL_PAIRS[open.jung];
      return pair ? shorter({ kind: 'V', jung: pair[0] }) : { text: withoutLast(state.text), composing: false };
    }
    case 'LV': {
      const pair = VOWEL_PAIRS[open.jung];
      return shorter(pair ? { ...open, jung: pair[0] } : { kind: 'L', cho: open.cho });
    }
    case 'LVT': {
      const pair = FINAL_PAIRS[open.jong];
      return shorter(pair ? { ...open, jong: pair[0] } : { kind: 'LV', cho: open.cho, jung: open.jung });
    }
  }
}

/**
 * 키 하나를 누른 뒤의 상태. maxLength는 코드 포인트 수다: 한도에서 글자를 더하는 누름은 버리고, 마지막 음절만 바꾸는 누름(받침 · 겹모음)은
 * 받는다. 띄어쓰기 · 숫자 · 기호 · `commit`은 조합을 닫는다.
 */
export function typeKey(state: HangulState, key: HangulKey, maxLength: number): HangulState {
  if (key === 'backspace') return backspace(state);
  if (key === 'commit') return { text: state.text, composing: false };
  const room = chars(state.text).length < maxLength;
  if (key === 'space') return room ? { text: state.text + ' ', composing: false } : { text: state.text, composing: false };
  if ('char' in key) return room && key.char ? { text: state.text + key.char, composing: false } : { text: state.text, composing: false };
  return pressesOf(key.jamo).reduce((s, jamo) => typeJamo(s, jamo, maxLength), state);
}

/** 여러 키를 차례로(시험 · 미리 채우기). */
export function typeKeys(state: HangulState, keys: readonly HangulKey[], maxLength: number): HangulState {
  return keys.reduce((s, key) => typeKey(s, key, maxLength), state);
}

/**
 * 음절을 누름 순서의 자모로 푼다(닭 → ㄷ ㅏ ㄹ ㄱ, 왜 → ㅇ ㅗ ㅐ, 꽃 → ㄲ ㅗ ㅊ). 한글이 아닌 글자는 그대로 한 누름.
 * 시험과 미리 보기가 글을 키 누름으로 바꿀 때 쓴다.
 */
export function pressesFor(text: string): HangulKey[] {
  const keys: HangulKey[] = [];
  for (const ch of chars(text)) {
    const open = decompose(ch);
    if (!open) { keys.push(ch === ' ' ? 'space' : { char: ch }); continue; }
    const parts = open.kind === 'L' ? [open.cho] : open.kind === 'V' ? [open.jung] : [open.cho, open.jung, ...(open.kind === 'LVT' ? [open.jong] : [])];
    for (const part of parts) for (const jamo of pressesOf(part)) keys.push({ jamo });
  }
  return keys;
}

/** 낱자모(한글 호환 자모)가 남았는지: '김민ㅅ' · 'ㅋㅋ'는 true, '김민수'는 false. 이름 · 사유에 쓰지 않는다. */
export function hasLoneJamo(text: string): boolean {
  return LONE_JAMO.test(text);
}

/** 두벌식 글자판: 세 줄의 자모와 쌍자음 키(⇧)가 바꾸는 자모. */
export const DUBEOLSIK: { rows: string[][]; shifted: Record<string, string> } = {
  rows: [
    ['ㅂ', 'ㅈ', 'ㄷ', 'ㄱ', 'ㅅ', 'ㅛ', 'ㅕ', 'ㅑ', 'ㅐ', 'ㅔ'],
    ['ㅁ', 'ㄴ', 'ㅇ', 'ㄹ', 'ㅎ', 'ㅗ', 'ㅓ', 'ㅏ', 'ㅣ'],
    ['ㅋ', 'ㅌ', 'ㅊ', 'ㅍ', 'ㅠ', 'ㅜ', 'ㅡ'],
  ],
  shifted: { 'ㅂ': 'ㅃ', 'ㅈ': 'ㅉ', 'ㄷ': 'ㄸ', 'ㄱ': 'ㄲ', 'ㅅ': 'ㅆ', 'ㅐ': 'ㅒ', 'ㅔ': 'ㅖ' },
};

/** 실제 자판의 글쇠 자리(KeyboardEvent.code) → 두벌식 자모. 한/영 상태와 상관없이 자리로 읽는다. */
const CODE_JAMO: Readonly<Record<string, string>> = {
  KeyQ: 'ㅂ', KeyW: 'ㅈ', KeyE: 'ㄷ', KeyR: 'ㄱ', KeyT: 'ㅅ', KeyY: 'ㅛ', KeyU: 'ㅕ', KeyI: 'ㅑ', KeyO: 'ㅐ', KeyP: 'ㅔ',
  KeyA: 'ㅁ', KeyS: 'ㄴ', KeyD: 'ㅇ', KeyF: 'ㄹ', KeyG: 'ㅎ', KeyH: 'ㅗ', KeyJ: 'ㅓ', KeyK: 'ㅏ', KeyL: 'ㅣ',
  KeyZ: 'ㅋ', KeyX: 'ㅌ', KeyC: 'ㅊ', KeyV: 'ㅍ', KeyB: 'ㅠ', KeyN: 'ㅜ', KeyM: 'ㅡ',
};

/** KeyQ → ㅂ(Shift면 ㅃ) … 두벌식. 쌍자음 · ㅒ · ㅖ가 없는 글쇠는 Shift여도 그 자모. 글자 글쇠가 아니면 null. */
export function jamoForCode(code: string, shift: boolean): string | null {
  const jamo = CODE_JAMO[code];
  if (!jamo) return null;
  return shift ? (DUBEOLSIK.shifted[jamo] ?? jamo) : jamo;
}

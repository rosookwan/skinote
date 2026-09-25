// 한글 조합(hangul.ts, 계획 work/impl-server/plan.md 7-1): 음절 모양마다, 겹받침 11 · 겹모음 7, 받침 옮기기, 자모 단위 지우기, 한도,
// 두벌식 글쇠 자리, 낱자모 찾기, 무작위 누름의 성질(늘 올바른 글자 · 음절 글의 되풀이).
import { describe, expect, it } from 'vitest';
import { DUBEOLSIK, hasLoneJamo, jamoForCode, pressesFor, typeKey, typeKeys, type HangulKey, type HangulState } from '../src/hangul.ts';

const EMPTY: HangulState = { text: '', composing: false };
const MAX = 100;

/** 글자마다 키 하나: 한글 자모는 자모 키, ' '는 띄어쓰기, '⌫'는 정정, '·'은 조합 끝내기, 그 밖은 글자 키. */
function keys(sequence: string): HangulKey[] {
  return Array.from(sequence).map((ch): HangulKey => {
    if (ch === ' ') return 'space';
    if (ch === '⌫') return 'backspace';
    if (ch === '·') return 'commit';
    return /[ㄱ-ㆎ]/.test(ch) ? { jamo: ch } : { char: ch };
  });
}

const type = (sequence: string, max = MAX, from: HangulState = EMPTY) => typeKeys(from, keys(sequence), max);
const text = (sequence: string, max = MAX) => type(sequence, max).text;

describe('이름 · 흔한 글', () => {
  it.each([
    ['ㄱㅣㅁㅁㅣㄴㅅㅜ', '김민수'],
    ['ㅂㅏㄱㅈㅜㄴㅎㅗ', '박준호'],
    ['ㅇㅣㅅㅓㅇㅕㄴ', '이서연'],
    ['ㅈㅓㅇㅎㅏㄴㅡㄹ', '정하늘'],
    ['ㅊㅗㅣㅇㅡㄴㅈㅓㅇ', '최은정'],
    ['ㅇㅗㅅㅡㅇㅁㅣㄴ', '오승민'],
    ['ㅇㅣㅁㅣㄴㅎㅗ', '이민호'],
    ['ㅎㅏㄴㅈㅣㅁㅣㄴ', '한지민'],
  ])('%s → %s', (sequence, expected) => {
    expect(text(sequence)).toBe(expected);
  });
});

describe('어려운 음절', () => {
  it.each([
    ['ㄷㅏㄹㄱㄱㅏㄹㅂㅣ', '닭갈비'],
    ['ㅂㅜㅔㄹㄱ', '뷁'],
    ['ㅇㅣㄹㄱㅇㅓ', '읽어'],
    ['ㅇㅓㅂㅅㅇㅓ', '없어'],
    ['ㅇㅏㄴㅈㅇㅏ', '앉아'],
    ['ㅇㅗㅐ', '왜'],
    ['ㅇㅡㅣㅅㅏ', '의사'],
    ['ㄲㅗㅊ', '꽃'],
    ['ㅆㅏㅇ', '쌍'],
    ['ㅇㅒ', '얘'],
    ['ㅇㅖ', '예'],
    ['ㄱㅏㅆㅇㅓ', '갔어'],
    ['ㄲㅏㄲㄷㅜㄱㅣ', '깎두기'],
  ])('%s → %s', (sequence, expected) => {
    expect(text(sequence)).toBe(expected);
  });
});

describe('겹받침(ㄳ ㄵ ㄶ ㄺ ㄻ ㄼ ㄽ ㄾ ㄿ ㅀ ㅄ)', () => {
  // [누름, 겹받침 음절, 모음을 더하면(뒤 자음이 다음 음절로), 정정 한 번 뒤]
  it.each([
    ['ㄴㅓㄱㅅ', '넋', 'ㅣ', '넉시', '넉'],
    ['ㅇㅏㄴㅈ', '앉', 'ㅏ', '안자', '안'],
    ['ㅇㅏㄴㅎ', '않', 'ㅏ', '안하', '안'],
    ['ㄷㅏㄹㄱ', '닭', 'ㅏ', '달가', '달'],
    ['ㅅㅏㄹㅁ', '삶', 'ㅏ', '살마', '살'],
    ['ㄴㅓㄹㅂ', '넓', 'ㅓ', '널버', '널'],
    ['ㄱㅗㄹㅅ', '곬', 'ㅣ', '골시', '골'],
    ['ㅎㅏㄹㅌ', '핥', 'ㅏ', '할타', '할'],
    ['ㅇㅡㄹㅍ', '읊', 'ㅓ', '을퍼', '을'],
    ['ㅅㅣㄹㅎ', '싫', 'ㅓ', '실허', '실'],
    ['ㄱㅏㅂㅅ', '값', 'ㅣ', '갑시', '갑'],
  ])('%s → %s, + %s → %s, 정정 → %s', (sequence, whole, vowel, moved, erased) => {
    expect(text(sequence)).toBe(whole);
    expect(text(sequence + vowel)).toBe(moved);
    expect(text(sequence + '⌫')).toBe(erased);
  });

  it('겹받침 뒤에 묶이지 않는 자음은 새 음절', () => {
    expect(text('ㄷㅏㄹㄱㄱ')).toBe('닭ㄱ');
    expect(text('ㄱㅏㅂㅅㅅ')).toBe('값ㅅ');
  });

  it('받침이 될 수 없는 자음(ㄸ ㅃ ㅉ)은 새 음절', () => {
    expect(text('ㄸㅏㄸ')).toBe('따ㄸ');
    expect(text('ㄱㅏㅃ')).toBe('가ㅃ');
    expect(text('ㄱㅏㅉㅏ')).toBe('가짜');
    expect(text('ㅇㅏㄹㄸㅏ')).toBe('알따');
  });
});

describe('겹모음(ㅘ ㅙ ㅚ ㅝ ㅞ ㅟ ㅢ)', () => {
  it.each([
    ['ㄱㅗㅏ', '과', '고'],
    ['ㄱㅗㅐ', '괘', '고'],
    ['ㄱㅗㅣ', '괴', '고'],
    ['ㄱㅜㅓ', '궈', '구'],
    ['ㄱㅜㅔ', '궤', '구'],
    ['ㄱㅜㅣ', '귀', '구'],
    ['ㄱㅡㅣ', '긔', '그'],
  ])('%s → %s, 정정 → %s', (sequence, whole, erased) => {
    expect(text(sequence)).toBe(whole);
    expect(text(sequence + '⌫')).toBe(erased);
  });

  it('묶이지 않는 모음은 새 낱모음', () => {
    expect(text('ㄱㅏㅏ')).toBe('가ㅏ');
    expect(text('ㄱㅗㅓ')).toBe('고ㅓ');
    expect(text('ㄱㅘㅏ')).toBe('과ㅏ');
  });

  it('겹모음을 한 번에 넘겨도 누른 차례로 푼다', () => {
    expect(typeKeys(EMPTY, [{ jamo: 'ㄱ' }, { jamo: 'ㅘ' }], MAX).text).toBe('과');
    expect(typeKeys(EMPTY, [{ jamo: 'ㄷ' }, { jamo: 'ㅏ' }, { jamo: 'ㄺ' }], MAX).text).toBe('닭');
  });
});

describe('낱자모끼리', () => {
  it('낱모음 + 모음: 묶이면 겹모음(ㅗ + ㅏ → ㅘ, ㅜ + ㅓ → ㅝ), 아니면 새 낱모음(ㅏ + ㅏ → ㅏㅏ)', () => {
    expect(text('ㅗㅏ')).toBe('ㅘ');
    expect(text('ㅜㅓ')).toBe('ㅝ');
    expect(text('ㅡㅣ')).toBe('ㅢ');
    expect(text('ㅏㅏ')).toBe('ㅏㅏ');
    expect(text('ㅗㅏ⌫')).toBe('ㅗ');
  });

  it('낱자음 + 자음은 새 낱자음(저절로 쌍자음 · 겹자음이 되지 않는다)', () => {
    expect(text('ㄱㄱ')).toBe('ㄱㄱ');
    expect(text('ㄱㅅ')).toBe('ㄱㅅ');
    expect(text('ㅋㅋ')).toBe('ㅋㅋ');
  });

  it('낱모음 뒤 자음 · 낱자음 뒤 모음', () => {
    expect(text('ㅏㄱ')).toBe('ㅏㄱ');
    expect(text('ㄱㅏ')).toBe('가');
    expect(text('ㅏㄱㅏ')).toBe('ㅏ가');
  });
});

describe('받침 옮기기', () => {
  it('닭 + ㅏ → 달가, 갑 + ㅣ → 가비: 앞 음절은 닫힌다', () => {
    expect(text('ㄷㅏㄹㄱㅏ')).toBe('달가');
    expect(text('ㄱㅏㅂㅣ')).toBe('가비');
    // 앞 음절(달)이 닫혀 다음 자음이 달의 받침이 되지 않는다.
    expect(text('ㄷㅏㄹㄱㅏ⌫⌫ㅁ')).toBe('달ㅁ');
  });

  it('쌍받침(ㄲ ㅆ)도 통째로 옮긴다', () => {
    expect(text('ㄱㅏㅆㅏ')).toBe('가싸');
    expect(text('ㄲㅏㄲㅏ')).toBe('까까');
  });
});

describe('정정(자모 단위)', () => {
  it('닭 → 달 → 다 → ㄷ → 빈 글', () => {
    const steps: string[] = [];
    let s = type('ㄷㅏㄹㄱ');
    for (let i = 0; i < 4; i += 1) { s = typeKey(s, 'backspace', MAX); steps.push(s.text); }
    expect(steps).toEqual(['달', '다', 'ㄷ', '']);
    expect(s.composing).toBe(false);
  });

  it('와 → 오, 꽤 → 꼬', () => {
    expect(text('ㅇㅗㅏ⌫')).toBe('오');
    expect(text('ㄲㅗㅐ⌫')).toBe('꼬');
  });

  it('닭 + ㅏ 뒤: 달가 → 달ㄱ → 달(조합 끝) → 빈 글(닫힌 달은 통째로)', () => {
    let s = type('ㄷㅏㄹㄱㅏ');
    expect(s).toEqual({ text: '달가', composing: true });
    s = typeKey(s, 'backspace', MAX);
    expect(s).toEqual({ text: '달ㄱ', composing: true });
    s = typeKey(s, 'backspace', MAX);
    expect(s).toEqual({ text: '달', composing: false });
    s = typeKey(s, 'backspace', MAX);
    expect(s).toEqual({ text: '', composing: false });
  });

  it('조합 중이 아니면 한 글자씩(처음 글 · 띄어쓰기 뒤)', () => {
    const start: HangulState = { text: '김민', composing: false };
    expect(typeKey(start, 'backspace', MAX)).toEqual({ text: '김', composing: false });
    expect(type('ㄱㅣㅁ ⌫', MAX)).toEqual({ text: '김', composing: false });
    expect(type('ㄱㅣㅁ ⌫⌫', MAX)).toEqual({ text: '', composing: false });
    expect(typeKey(EMPTY, 'backspace', MAX)).toEqual(EMPTY);
  });

  it('정정 뒤 다시 치면 이어서 조합한다', () => {
    expect(text('ㄱㅣㅁ⌫ㄴ')).toBe('긴');
    expect(text('ㄱㅣ⌫⌫ㅂㅏ')).toBe('바');
  });
});

describe('조합 닫기: 띄어쓰기 · 숫자 · 기호 · 조합 끝내기', () => {
  it('닫힌 음절에는 받침이 붙지 않는다', () => {
    expect(text('ㄱㅏ ㅇ')).toBe('가 ㅇ');
    expect(text('ㄱㅏ·ㅇ')).toBe('가ㅇ');
    expect(text('ㄱㅏ1ㅇ')).toBe('가1ㅇ');
    expect(text('ㄱㅏ-ㅇㅏ')).toBe('가-아');
  });

  it('처음 글(이미 적은 이름) 뒤에 치면 새 음절', () => {
    expect(type('ㅅㅜ', MAX, { text: '김민', composing: false }).text).toBe('김민수');
    expect(type('ㄴ', MAX, { text: '기', composing: false }).text).toBe('기ㄴ');
  });

  it('조합 상태', () => {
    expect(type('ㄱㅏ').composing).toBe(true);
    expect(type('ㄱㅏ ').composing).toBe(false);
    expect(type('ㄱㅏ·').composing).toBe(false);
    expect(type('ㄱㅏ7').composing).toBe(false);
  });
});

describe('한도(코드 포인트)', () => {
  it('한도에서 글자를 더하는 누름은 버리고, 마지막 음절만 바꾸는 누름은 받는다', () => {
    expect(text('ㄱㅣㅁㅁㅣㄴㅅ', 2)).toBe('김민');
    expect(text('ㄱㅏㄹㄱ', 1)).toBe('갉');
    expect(text('ㄱㅏㄹㄱㅏ', 1)).toBe('갉');
    expect(text('ㄱㅗㅏ', 1)).toBe('과');
    expect(text('ㄱㅏ ㄴ', 1)).toBe('가');
    expect(text('ㄱㅏ12', 2)).toBe('가1');
  });

  it('한도의 띄어쓰기는 글을 늘리지 않고 조합만 닫는다', () => {
    expect(type('ㄱㅏ ', 1)).toEqual({ text: '가', composing: false });
    expect(type('ㄱㅏ ㄴ', 1).text).toBe('가');
  });

  it('한도에서도 정정은 된다', () => {
    expect(text('ㄱㅏㄴ⌫', 1)).toBe('가');
    expect(text('ㄱㅏㄴㄴㅏ', 2)).toBe('간나');
  });
});

describe('낱자모 찾기(hasLoneJamo)', () => {
  it.each([
    ['김민ㅅ', true],
    ['ㅋㅋ', true],
    ['ㅘ', true],
    ['김민수', false],
    ['', false],
    ['김 민수 2', false],
    ['잔돈 착오 (1,000원)', false],
  ])('%s → %s', (value, lone) => {
    expect(hasLoneJamo(value)).toBe(lone);
  });
});

describe('두벌식 글쇠 자리(jamoForCode)', () => {
  const unshifted: Record<string, string> = {
    KeyQ: 'ㅂ', KeyW: 'ㅈ', KeyE: 'ㄷ', KeyR: 'ㄱ', KeyT: 'ㅅ', KeyY: 'ㅛ', KeyU: 'ㅕ', KeyI: 'ㅑ', KeyO: 'ㅐ', KeyP: 'ㅔ',
    KeyA: 'ㅁ', KeyS: 'ㄴ', KeyD: 'ㅇ', KeyF: 'ㄹ', KeyG: 'ㅎ', KeyH: 'ㅗ', KeyJ: 'ㅓ', KeyK: 'ㅏ', KeyL: 'ㅣ',
    KeyZ: 'ㅋ', KeyX: 'ㅌ', KeyC: 'ㅊ', KeyV: 'ㅍ', KeyB: 'ㅠ', KeyN: 'ㅜ', KeyM: 'ㅡ',
  };
  const shifted: Record<string, string> = { ...unshifted, KeyQ: 'ㅃ', KeyW: 'ㅉ', KeyE: 'ㄸ', KeyR: 'ㄲ', KeyT: 'ㅆ', KeyO: 'ㅒ', KeyP: 'ㅖ' };

  it('글자 글쇠 26개(Shift 없이)', () => {
    for (const [code, jamo] of Object.entries(unshifted)) expect(jamoForCode(code, false), code).toBe(jamo);
  });

  it('Shift: ㅃ ㅉ ㄸ ㄲ ㅆ ㅒ ㅖ, 나머지는 그대로', () => {
    for (const [code, jamo] of Object.entries(shifted)) expect(jamoForCode(code, true), code).toBe(jamo);
  });

  it('글자 글쇠가 아니면 null', () => {
    for (const code of ['Digit1', 'Space', 'Enter', 'Backspace', 'ShiftLeft', 'Semicolon', 'Numpad1', '']) expect(jamoForCode(code, false)).toBeNull();
  });

  it('글판의 줄은 글쇠 자리와 같은 자모다', () => {
    const codes = [['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'], ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'], ['Z', 'X', 'C', 'V', 'B', 'N', 'M']];
    expect(codes.map((row) => row.map((c) => jamoForCode('Key' + c, false)))).toEqual(DUBEOLSIK.rows);
    expect(Object.keys(DUBEOLSIK.shifted).sort()).toEqual(['ㄱ', 'ㄷ', 'ㅂ', 'ㅅ', 'ㅈ', 'ㅐ', 'ㅔ'].sort());
  });
});

describe('누름으로 풀기(pressesFor)', () => {
  it('음절을 누름 차례의 자모로', () => {
    expect(pressesFor('닭')).toEqual(keys('ㄷㅏㄹㄱ'));
    expect(pressesFor('왜')).toEqual(keys('ㅇㅗㅐ'));
    expect(pressesFor('꽃 1')).toEqual(keys('ㄲㅗㅊ 1'));
    expect(pressesFor('힣')).toEqual(keys('ㅎㅣㅎ'));
  });
});

// ── 무작위 누름의 성질(씨앗을 고정한 의사 난수) ─────────────────────────

function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL_KEYS = [...DUBEOLSIK.rows.flat(), ...Object.values(DUBEOLSIK.shifted)];
const VALID = /^[가-힣ㄱ-ㆎ 0-9]*$/u;

describe('성질', () => {
  it('무작위 자모 · 띄어쓰기 · 숫자 · 정정: 글은 늘 온전한 음절 · 낱자모 · 빈칸 · 숫자이고 한도를 넘지 않는다', () => {
    const next = random(20260926);
    for (let run = 0; run < 400; run += 1) {
      const max = 1 + Math.floor(next() * 12);
      let s = EMPTY;
      for (let i = 0; i < 40; i += 1) {
        const r = next();
        const key: HangulKey = r < 0.08 ? 'space' : r < 0.14 ? { char: String(Math.floor(next() * 10)) } : r < 0.24 ? 'backspace' : r < 0.27 ? 'commit' : { jamo: ALL_KEYS[Math.floor(next() * ALL_KEYS.length)]! };
        s = typeKey(s, key, max);
        expect(s.text).toMatch(VALID);
        expect(Array.from(s.text).length).toBeLessThanOrEqual(max);
        if (!s.text) expect(s.composing).toBe(false);
      }
    }
  });

  it('온전한 음절 글을 자모로 풀어 치면 같은 글이 된다(두벌식은 되풀이된다)', () => {
    const next = random(42);
    for (let run = 0; run < 300; run += 1) {
      const length = 1 + Math.floor(next() * 8);
      let word = '';
      for (let i = 0; i < length; i += 1) word += next() < 0.1 ? ' ' : String.fromCodePoint(0xac00 + Math.floor(next() * 11172));
      expect(typeKeys(EMPTY, pressesFor(word), MAX).text, word).toBe(word);
    }
  });

  it('치는 동안의 정정은 조합을 거꾸로 푼다: 모두 지우면 빈 글', () => {
    const next = random(7);
    for (let run = 0; run < 100; run += 1) {
      let word = '';
      for (let i = 0; i < 4; i += 1) word += String.fromCodePoint(0xac00 + Math.floor(next() * 11172));
      const keysOfWord = pressesFor(word);
      let s = typeKeys(EMPTY, keysOfWord, MAX);
      for (let i = 0; i < keysOfWord.length; i += 1) s = typeKey(s, 'backspace', MAX);
      expect(s, word).toEqual(EMPTY);
    }
  });
});

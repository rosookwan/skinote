// 화면 키보드의 모양 고르기(fitKeyboard, 계획 work/impl-server/plan.md 7-2): 검사 크기 13개와 가로로 돌린 휴대폰 3개에서 늘 맞고,
// 포스 · 좁은 포스 · 기사 태블릿은 두벌식 줄 배치 + 제목 줄, 세운 휴대폰은 자모 격자 + 제목 줄, 640×360은 제목 없는 줄 배치.
// `닫기`는 어느 모양이든 키 줄 밖(제목 줄 끝, 제목 줄이 없으면 표시 칸 줄 끝)이라 제목 줄은 키 높이 이상이다.
// 폭(키 한 칸 ≥ 키 크기)과 높이(판 ≤ 잰 높이)를 모두 본다.
import { describe, expect, it } from 'vitest';
import { fitKeyboard, KEYBOARD_MAX_DISPLAY_LINES, KEYBOARD_SHAPES, type KeyboardSpec, type KeyboardText } from '../src/index.ts';

// DeviceProfile.keyboard의 값(@skinote/ui device-profile.ts, 그 시험이 같은 값인지 본다).
const POS: KeyboardSpec = { keyPx: 56, gapPx: 8, insetPx: 12, maxWidthPx: 860, titlePx: 40, displayPadPx: 12 };
const TABLET: KeyboardSpec = { ...POS, maxWidthPx: 900 };
const PHONE: KeyboardSpec = { keyPx: 56, gapPx: 6, insetPx: 8, maxWidthPx: null, titlePx: 56, displayPadPx: 8 };

type Size = [number, number];
const POS_SIZES: Size[] = [[1024, 600], [1024, 569], [1024, 529], [1024, 768], [1366, 768]];
const NARROW_SIZES: Size[] = [[907, 648], [875, 600]];
const TABLET_SIZES: Size[] = [[1024, 520], [1024, 600], [1280, 720]];
const PHONE_SIZES: Size[] = [[360, 640], [390, 740], [412, 780]];
const SIDEWAYS: Size[] = [[640, 360], [740, 390], [780, 412]];

/** 잰 글자 값의 폭: 표시 칸 글자 16 · 18 · 20px(줄 높이 1.3배), 제목 '대표자'(80) · 안내 '글자 미완성 · 정정 필요'(190), 글자 수 20 · 40. */
const TEXTS: KeyboardText[] = [16, 18, 20].flatMap((glyphPx) =>
  [80, 190].flatMap((titleLabelPx) => [20, 40].map((maxLength) => ({ maxLength, glyphPx, lineHeightPx: Math.ceil(glyphPx * 1.3), titleLabelPx }))),
);

const box = ([width, height]: Size) => ({ width, height });
const cases = (sizes: Size[], spec: KeyboardSpec) => sizes.flatMap((size) => TEXTS.map((text) => [size.join('×'), size, spec, text] as const));

describe('검사 크기마다 맞는 모양', () => {
  it.each(cases([...POS_SIZES, ...NARROW_SIZES], POS))('포스 %s: 줄 배치 + 제목 줄', (_, size, spec, text) => {
    const fit = fitKeyboard(box(size), spec, text);
    expect(fit.fits).toBe(true);
    expect([fit.layout, fit.titleRow]).toEqual(['rows', true]);
    expect(fit.unitPx).toBeGreaterThanOrEqual(spec.keyPx);
    expect(fit.sheetHeightPx).toBeLessThanOrEqual(size[1]);
    expect(fit.sheetWidthPx).toBe(Math.min(size[0], 860));
  });

  it.each(cases(TABLET_SIZES, TABLET))('기사 태블릿 %s: 줄 배치 + 제목 줄', (_, size, spec, text) => {
    const fit = fitKeyboard(box(size), spec, text);
    expect(fit.fits).toBe(true);
    expect([fit.layout, fit.titleRow]).toEqual(['rows', true]);
    expect(fit.titleRowPx).toBeGreaterThanOrEqual(spec.keyPx);
    expect(fit.sheetHeightPx).toBeLessThanOrEqual(size[1]);
  });

  it.each(cases(PHONE_SIZES, PHONE))('기사 휴대폰 %s: 자모 격자 + 제목 줄(닫기가 그 줄에)', (_, size, spec, text) => {
    const fit = fitKeyboard(box(size), spec, text);
    expect(fit.fits).toBe(true);
    expect([fit.layout, fit.titleRow]).toEqual(['grid', true]);
    expect(fit.unitPx).toBeGreaterThanOrEqual(spec.keyPx);
    expect(fit.titleRowPx).toBeGreaterThanOrEqual(spec.keyPx);
    expect(fit.sheetHeightPx).toBeLessThanOrEqual(size[1]);
    expect(fit.sheetWidthPx).toBe(size[0]);
  });

  it.each(cases(SIDEWAYS, PHONE))('가로로 돌린 휴대폰 %s: 줄 배치로 맞는다', (_, size, spec, text) => {
    const fit = fitKeyboard(box(size), spec, text);
    expect(fit.fits).toBe(true);
    expect(fit.layout).toBe('rows');
    expect(fit.unitPx).toBeGreaterThanOrEqual(spec.keyPx);
    expect(fit.sheetHeightPx).toBeLessThanOrEqual(size[1]);
  });

  it.each(TEXTS.map((text) => [text.glyphPx, text.titleLabelPx, text.maxLength, text] as const))(
    '640×360(글자 %ipx, 제목 %ipx, %i자): 제목 줄 없는 줄 배치(제목은 표시 칸 앞의 이름표)',
    (_, __, ___, text) => {
      const fit = fitKeyboard({ width: 640, height: 360 }, PHONE, text);
      expect([fit.fits, fit.layout, fit.titleRow]).toEqual([true, 'rows', false]);
      expect(fit.titleRowPx).toBe(0);
    },
  );
});

describe('높이 계산', () => {
  const name20: KeyboardText = { maxLength: 20, glyphPx: 20, lineHeightPx: 26, titleLabelPx: 80 };
  const reason40: KeyboardText = { maxLength: 40, glyphPx: 20, lineHeightPx: 26, titleLabelPx: 80 };

  it('1024×529(줄 배치 + 제목 줄): 여백 24 + 제목 줄 56(닫기가 그 줄에) + 8 + 표시 칸 56(한 줄) + 8 + 키 4줄 × 56 + 3 × 8 = 400', () => {
    const fit = fitKeyboard({ width: 1024, height: 529 }, POS, name20);
    expect(fit.unitPx).toBeCloseTo(76.4, 5);
    expect(fit.displayLines).toBe(1);
    expect(fit.displayPx).toBe(56);
    expect(fit.titleRowPx).toBe(56);
    expect(fit.sheetHeightPx).toBe(400);
    // 사유 40자도 한 줄(812 ÷ 20 = 40자).
    expect(fitKeyboard({ width: 1024, height: 529 }, POS, reason40).displayLines).toBe(1);
  });

  it('360×640(격자 + 제목 줄): 여백 16 + 제목 56 + 6 + 표시 칸 94(세 줄) + 6 + 키 7줄 × 56 + 6 × 6 = 606', () => {
    const fit = fitKeyboard({ width: 360, height: 640 }, PHONE, reason40);
    expect(fit.unitPx).toBe(64);
    expect(fit.displayLines).toBe(3);
    expect(fit.displayPx).toBe(3 * 26 + 2 * 8);
    expect(fit.sheetHeightPx).toBe(606);
  });

  it('640×360: 제목 줄이 있으면 394 > 360이라 제목 · 닫기를 표시 칸 줄로(332)', () => {
    const fit = fitKeyboard({ width: 640, height: 360 }, PHONE, reason40);
    expect([fit.layout, fit.titleRow, fit.displayLines]).toEqual(['rows', false, 2]);
    expect(fit.unitPx).toBe(57);
    expect(fit.sheetHeightPx).toBe(16 + 68 + 6 + 4 * 56 + 3 * 6);
    const withTitle = 16 + 56 + 6 + 68 + 6 + 4 * 56 + 3 * 6;
    expect(withTitle).toBeGreaterThan(360);
  });

  it('표시 칸 줄 수는 가장 넓은 글자가 한도까지 들어가는 수(최대 3줄)', () => {
    const phone = (maxLength: number) => fitKeyboard({ width: 360, height: 640 }, PHONE, { ...reason40, maxLength });
    expect(phone(16).displayLines).toBe(1);
    expect(phone(17).displayLines).toBe(2);
    expect(phone(32).displayLines).toBe(2);
    expect(phone(33).displayLines).toBe(3);
    expect(phone(48).displayLines).toBe(KEYBOARD_MAX_DISPLAY_LINES);
    // 세 줄로도 들어가지 않으면 이 크기에 맞는 모양이 없다.
    expect(phone(49).fits).toBe(false);
  });
});

describe('맞지 않는 크기', () => {
  it('폭도 높이도 모자라면 fits: false(가장 작은 모양)', () => {
    const fit = fitKeyboard({ width: 280, height: 400 }, PHONE, { maxLength: 20, glyphPx: 20, lineHeightPx: 26, titleLabelPx: 80 });
    expect(fit.fits).toBe(false);
    expect([fit.layout, fit.titleRow]).toEqual(['grid', false]);
  });

  it('제목(안내)이 제목 줄에 들어가지 않으면 제목 줄 모양을 쓰지 않는다', () => {
    const wide = fitKeyboard({ width: 360, height: 640 }, PHONE, { maxLength: 20, glyphPx: 20, lineHeightPx: 26, titleLabelPx: 300 });
    expect(wide.titleRow).toBe(false);
  });

  it('키 모양의 칸 수 · 줄 수', () => {
    expect(KEYBOARD_SHAPES).toEqual({ rows: { columns: 10, keyRows: 4 }, grid: { columns: 5, keyRows: 7 } });
  });
});

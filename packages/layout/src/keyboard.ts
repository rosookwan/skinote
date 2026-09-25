// 화면 키보드(한글 글자판)의 모양 고르기(계획 work/impl-server/plan.md 7-2). 잰 판 크기(폭과 높이)와 기기 등급의 키 크기로
// 두벌식 줄 배치(`rows`, 10칸) · 자모 차례 격자(`grid`, 5칸)와 제목 줄의 있고 없음을 고른다. 화면 크기 숫자로 가르지 않는다.
// 차례: rows + 제목 줄 → rows(제목 · 닫기를 표시 칸 줄에) → grid + 제목 줄 → grid(제목 · 닫기를 표시 칸 줄에).
// `닫기`(한 칸)는 어느 모양이든 키 줄 밖이다: 제목 줄 끝, 제목 줄이 없으면 표시 칸 줄 끝(치던 글을 버리는 키가 글쇠 사이에 있지 않게).
// 폭(키 한 칸 ≥ 키 크기)과 높이(판 ≤ 잰 높이)가 모두 맞는 첫 모양을 쓴다. 표시 칸은 가장 긴 글(maxLength)이 잰 글자 폭으로
// 들어가는 줄 수(최대 3줄)만큼 높고, 스크롤 · 잘림 · 뒤쪽만 보이기가 없다.

export type KeyboardLayoutKey = 'rows' | 'grid';

/**
 * 모양마다 칸 수와 키 줄 수(글자판 쪽 가운데 가장 많은 줄). 키 배치 자료(@skinote/ui keyboard-layouts.ts)가 이 수와 같은지 그 시험이
 * 맞춰 본다.
 */
export const KEYBOARD_SHAPES: Readonly<Record<KeyboardLayoutKey, { columns: number; keyRows: number }>> = {
  rows: { columns: 10, keyRows: 4 },
  grid: { columns: 5, keyRows: 7 },
};

/** 등급의 키보드 크기(DeviceProfile.keyboard). */
export interface KeyboardSpec {
  /** 키 높이 · 한 칸의 가장 작은 폭(누르는 곳). */
  keyPx: number;
  /** 키 사이 · 줄 사이. */
  gapPx: number;
  /** 판 안 여백(위 · 아래 · 옆). */
  insetPx: number;
  /** 판의 가장 큰 폭. null이면 판 폭 전체(휴대폰). */
  maxWidthPx: number | null;
  /** 제목 줄 높이(그 줄에 `닫기`가 있어 실제 줄은 키 높이보다 낮지 않다). */
  titlePx: number;
  /** 표시 칸의 안 여백(테두리 포함, 한쪽). */
  displayPadPx: number;
}

/** 잰 글자 값. */
export interface KeyboardText {
  /** 칠 수 있는 글자 수(코드 포인트). */
  maxLength: number;
  /** 표시 칸 글꼴에서 가장 넓은 글자의 폭(잰 값, `가` · `뷁` …). */
  glyphPx: number;
  /** 표시 칸의 줄 높이(잰 값). */
  lineHeightPx: number;
  /** 제목(과 그 아래에 뜨는 한 줄 안내) 글의 폭(잰 값, 둘 중 넓은 것). 둘은 한 칸에 위아래로 선다. */
  titleLabelPx: number;
}

export interface KeyboardFit {
  /** 이 판 크기에 맞는 모양이 있는지(없으면 가장 작은 모양을 돌려주고 false). */
  fits: boolean;
  layout: KeyboardLayoutKey;
  /** 제목 줄이 따로 있는지(없으면 제목은 표시 칸 줄 앞의 이름표). */
  titleRow: boolean;
  /** 키 한 칸의 폭. */
  unitPx: number;
  /** 표시 칸 줄 수(1 ~ 3). */
  displayLines: number;
  displayPx: number;
  /** 제목 줄 높이(없으면 0). */
  titleRowPx: number;
  sheetWidthPx: number;
  sheetHeightPx: number;
}

/** 표시 칸이 가질 수 있는 가장 많은 줄. */
export const KEYBOARD_MAX_DISPLAY_LINES = 3;

const CANDIDATES: readonly [KeyboardLayoutKey, boolean][] = [['rows', true], ['rows', false], ['grid', true], ['grid', false]];

function tryLayout(
  box: { width: number; height: number },
  kb: KeyboardSpec,
  text: KeyboardText,
  layout: KeyboardLayoutKey,
  titleRow: boolean,
): KeyboardFit {
  const { columns, keyRows } = KEYBOARD_SHAPES[layout];
  const sheetWidthPx = Math.max(0, kb.maxWidthPx === null ? box.width : Math.min(box.width, kb.maxWidthPx));
  const inner = sheetWidthPx - 2 * kb.insetPx;
  const unitPx = (inner - (columns - 1) * kb.gapPx) / columns;
  // `닫기`(한 칸)는 제목 줄 끝에, 제목 줄이 없으면 표시 칸 줄 끝에 있다(두 모양 모두).
  const closePx = unitPx + kb.gapPx;
  const titleRowPx = titleRow ? Math.max(kb.titlePx, kb.keyPx) : 0;
  const titleFits = !titleRow || text.titleLabelPx <= inner - closePx;
  const labelPx = titleRow ? 0 : text.titleLabelPx + kb.gapPx + closePx;
  const textWidth = inner - labelPx - 2 * kb.displayPadPx;
  const perLine = text.glyphPx > 0 ? Math.floor(textWidth / text.glyphPx) : 0;
  const displayLines = perLine > 0 ? Math.max(1, Math.ceil(text.maxLength / perLine)) : Number.POSITIVE_INFINITY;
  const shownLines = Math.min(displayLines, KEYBOARD_MAX_DISPLAY_LINES);
  const displayPx = Math.max(kb.keyPx, shownLines * text.lineHeightPx + 2 * kb.displayPadPx);
  const keysPx = keyRows * kb.keyPx + (keyRows - 1) * kb.gapPx;
  const sheetHeightPx = 2 * kb.insetPx + (titleRowPx ? titleRowPx + kb.gapPx : 0) + displayPx + kb.gapPx + keysPx;
  const fits = unitPx >= kb.keyPx && titleFits && displayLines <= KEYBOARD_MAX_DISPLAY_LINES && sheetHeightPx <= box.height;
  return { fits, layout, titleRow, unitPx, displayLines: shownLines, displayPx, titleRowPx, sheetWidthPx, sheetHeightPx };
}

/**
 * 판 크기(아래에서 올라오는 판이 쓸 수 있는 폭 · 높이)에 맞는 키보드 모양. 폭과 높이를 모두 본다.
 * 맞는 모양이 없으면 가장 작은 모양(grid, 제목 줄 없음)을 fits: false로 돌려준다(시험이 그 크기를 실패로 알린다).
 */
export function fitKeyboard(box: { width: number; height: number }, kb: KeyboardSpec, text: KeyboardText): KeyboardFit {
  let last: KeyboardFit | null = null;
  for (const [layout, titleRow] of CANDIDATES) {
    last = tryLayout(box, kb, text, layout, titleRow);
    if (last.fits) return last;
  }
  return last!;
}

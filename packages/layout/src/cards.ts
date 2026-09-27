// 카드 목록의 칸 · 쪽 나누기(packCards): 관리 화면의 카드(매장 설정 · 운영 규칙 V8, spec 3-9)를 위에서 아래로 채우고, 모자라면 오른쪽
// 칸으로(사이 16), 칸이 다 차면 다음 쪽으로 넘긴다. 카드는 자르지 않는다(ui 4-3): 한 칸보다 큰 카드는 그 칸을 혼자 쓴다(넘치면 검사기가
// 잡는다). 높이 · 폭은 부르는 쪽이 DeviceProfile 값으로 센다(카드 높이는 @skinote/ui의 ruleCardHeight).

/**
 * 한 쪽에 두는 칸 수: 칸 폭이 카드의 가장 작은 폭 이상인 만큼(적어도 1). 1024 폭(글 폭 964, 카드 474)은 두 칸, 좁은 포스(875 · 907)는 한 칸.
 */
export function cardColumns(widthPx: number, minCardPx: number, gapPx: number): number {
  if (!(widthPx > 0) || !(minCardPx > 0)) return 1;
  return Math.max(1, Math.floor((widthPx + gapPx) / (minCardPx + gapPx)));
}

/**
 * 카드 높이들을 쪽 → 칸 → 카드 차례(색인)로 나눈다. 칸 높이는 roomPx, 카드 사이는 gapPx. 카드가 없으면 빈 칸 하나의 쪽 하나.
 * 예) 시안 V8 1024×600(자리 396): [[0, 1], [2, 3, 4]] 한 쪽, 1024×529(자리 325): [[0], [1]] · [[2, 3], [4]] 두 쪽.
 */
export function packCards(heights: readonly number[], roomPx: number, gapPx: number, columns: number): number[][][] {
  const perPage = Math.max(1, Math.floor(columns));
  const pages: number[][][] = [];
  let page: number[][] = [[]];
  let used = 0;
  heights.forEach((h, i) => {
    const column = page[page.length - 1]!;
    if (column.length === 0) { column.push(i); used = h; return; }
    if (used + gapPx + h <= roomPx) { column.push(i); used += gapPx + h; return; }
    if (page.length < perPage) page.push([i]);
    else { pages.push(page); page = [[i]]; }
    used = h;
  });
  pages.push(page);
  return pages;
}

// ── 매장 설정의 목록 카드(features-1 plan §4-4 · E26) ─────────────────────────────

/** 넓은 글자(한글 · 한자 · 가나): 1em, 그 밖(숫자 · 기호 · 빈칸): 0.6em(문구 표 1-3의 어림보다 넉넉하게). */
const WIDE = /[ᄀ-ᇿ　-鿿가-힯豈-﫿]/u;

/** 글 폭 어림(그리기 전 칸 수를 고를 때): 그린 뒤 넘치면 규칙 검사기가 잡는다. */
export function estimateTextPx(text: string, fontPx: number): number {
  let em = 0;
  for (const ch of text) em += WIDE.test(ch) ? 1 : 0.6;
  return Math.ceil(em * fontPx);
}

/**
 * 목록의 한 줄 칸 수: max부터 1까지, 칸 폭(카드 안 폭을 사이 gap으로 나눈 것) − 안 여백 둘에 가장 긴 글(이름 · 둘째 줄)이 들어가는 가장 큰 수.
 * 예) 474 폭 카드(안 446)에 `설천 하우스 앞`(16px, 112px)은 세 칸(143 − 16 = 127), `기사 · 1호 차량`은 두 칸.
 */
export function listColumns(innerPx: number, texts: readonly string[], fontPx: number, padPx: number, gapPx: number, max: number): number {
  const widest = texts.reduce((w, text) => Math.max(w, estimateTextPx(text, fontPx)), 0);
  for (let n = Math.max(1, Math.floor(max)); n > 1; n -= 1) {
    const cell = (innerPx - (n - 1) * gapPx) / n;
    if (cell - 2 * padPx >= widest) return n;
  }
  return 1;
}

/**
 * 목록 줄을 카드 조각으로 나눈다(E26: 카드가 쪽 높이보다 길면 다음 카드 `{title} (계속)`로 잇는다). total = 목록 줄 수, first = 첫 조각에 들어가는
 * 줄 수, next = 이어지는 조각에 들어가는 줄 수(적어도 1). 각 조각의 [시작 줄, 끝 줄) 목록.
 */
export function splitListRows(total: number, first: number, next: number): [number, number][] {
  const out: [number, number][] = [];
  let at = 0;
  let room = Math.max(1, Math.floor(first));
  while (at < total || out.length === 0) {
    const end = Math.min(total, at + room);
    out.push([at, end]);
    at = end;
    room = Math.max(1, Math.floor(next));
    if (total === 0) break;
  }
  return out;
}

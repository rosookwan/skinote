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

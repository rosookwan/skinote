// 남는 높이를 줄에 나눠 쓰기(fillRows). 줄 수가 적으면 줄이 커지고(최대 maxPx), 많으면 최소 높이(minPx)로 한 쪽에 들어가는 만큼만
// 두고 나머지는 다음 쪽이다(스크롤 없음). 기사 업무 판(V7, spec 3-8)의 품목 줄 60 ~ 88, 하루 마감(V6)의 줄 52 ~ 88이 쓴다.
// 높이는 부르는 쪽이 DeviceProfile 값으로 센다: 업무 판은 연결 띠가 떠 있을 때의 높이(띠를 늘 뺀 높이)라 연결이 끊겨도 줄 크기가 그대로다.

export interface RowFill {
  /** 한 줄의 높이(px, 정수). */
  rowPx: number;
  /** 한 쪽에 들어가는 줄 수(적어도 1). */
  perPage: number;
  pageCount: number;
}

/**
 * @param availablePx 줄에 쓸 수 있는 높이(표 머리 · 돈 줄 · 사이를 뺀 것)
 * @param rows 줄 수
 * @param minPx 줄의 최소 높이(누르는 곳이 들어가는 높이)
 * @param maxPx 줄의 최대 높이(줄이 적어도 이보다 커지지 않는다)
 */
export function fillRows(availablePx: number, rows: number, minPx: number, maxPx: number): RowFill {
  const room = Math.max(0, Math.floor(availablePx));
  const low = Math.max(1, Math.floor(minPx));
  const high = Math.max(low, Math.floor(maxPx));
  const perPage = Math.max(1, Math.floor(room / low));
  const count = Math.max(0, Math.floor(rows));
  const shown = Math.max(1, Math.min(count, perPage));
  const rowPx = Math.min(high, Math.max(low, Math.floor(room / shown)));
  return { rowPx, perPage, pageCount: Math.max(1, Math.ceil(count / perPage)) };
}

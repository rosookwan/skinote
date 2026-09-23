// 넘치는 목록의 한 모델(ui 4-4): 머리줄 메뉴, 색인 탭, 옆 동작, 결제 수단, 빨리 확인. 행마다 priority(낮은 것부터
// 밀려남)가 있고, 등급의 칸 수(DeviceProfile)를 넘치면 '더 보기'로 간다. 보이는 것은 원래 순서(seq)를 지킨다.

export interface CapacityEntry {
  seq: number;
  priority: number;
  /** 늘 끝에 보이고 칸 수에 세지 않는다('관리'). */
  pinnedEnd?: boolean;
}

export interface CapacityResult<T> {
  /** 보일 것(seq 순서, 고정된 것은 뒤). */
  shown: T[];
  /** '더 보기'로 간 것(seq 순서). */
  overflow: T[];
}

export interface FitListOptions {
  /** '더 보기'가 칸 하나를 차지하는지(색인 탭은 차지하고, 머리줄은 따로 있는 더 보기 버튼을 쓴다). */
  moreTakesSlot?: boolean;
}

export function fitList<T extends CapacityEntry>(entries: readonly T[], capacity: number, options: FitListOptions = {}): CapacityResult<T> {
  const pinned = entries.filter((e) => e.pinnedEnd).sort((a, b) => a.seq - b.seq);
  const free = entries.filter((e) => !e.pinnedEnd).sort((a, b) => a.seq - b.seq);
  if (free.length <= capacity) return { shown: [...free, ...pinned], overflow: [] };
  const slots = Math.max(0, capacity - (options.moreTakesSlot ? 1 : 0));
  const keep = new Set(
    [...free]
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq)
      .slice(0, slots),
  );
  return { shown: [...free.filter((e) => keep.has(e)), ...pinned], overflow: free.filter((e) => !keep.has(e)) };
}

/** 폭으로도 자른다: 보일 것의 잰 폭 합이 가진 폭을 넘으면 우선순위 낮은 것부터 더 밀어낸다. */
export function fitListByWidth<T extends CapacityEntry>(
  entries: readonly T[],
  capacity: number,
  widthOf: (entry: T) => number,
  availablePx: number,
  moreWidthPx: number,
  options: FitListOptions = {},
): CapacityResult<T> {
  let limit = Math.min(capacity, entries.filter((e) => !e.pinnedEnd).length);
  for (;;) {
    const result = fitList(entries, limit, options);
    const needsMore = result.overflow.length > 0;
    const used = result.shown.reduce((sum, e) => sum + widthOf(e), 0) + (needsMore ? moreWidthPx : 0);
    if (used <= availablePx || limit <= 0) return result;
    limit -= 1;
  }
}

/** 탭 개수 표시: 세 자리면 짧게('99+'). */
export function shortCount(n: number): string {
  return n > 99 ? '99+' : String(n);
}

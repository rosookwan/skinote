// 잰 높이로 쪽 나누기(ui 4-3). 고정 '7줄'이 아니라 잰 항목을 순서대로 채운다: 줄(52 · 60 · 64 · 88px),
// 묶음 제목(다음 줄과 떨어지지 않음), 지금 줄(24px 구분선으로 셈, 줄을 덮지 않음). 빨리 확인 줄 · 연결 띠 · 안내 띠는
// 쪽마다 위에 고정되므로 fixedTopPx로 뺀다. 한 쪽에는 온전한 줄만 넣는다.

export interface FlowRow {
  id: string;
  /** 묶음 키(없으면 묶음 없음). */
  group?: string;
  /** 이 줄의 높이(px). */
  heightPx: number;
}

export interface PaginateOptions {
  /** 목록에 쓸 수 있는 잰 높이(px): 화면 높이에서 머리 · 제목 · 표 머리 · 바닥을 뺀 것. */
  availablePx: number;
  /** 쪽마다 위에 고정되는 것(빨리 확인 줄 64, 연결 띠 32, 안내 띠)의 합. */
  fixedTopPx?: number;
  /** 묶음 제목 높이. 0이면 제목을 그리지 않는 틀(장부는 시각 칸이 묶음을 대신한다). */
  groupTitlePx?: number;
  /** 지금 줄 높이와 위치(이 줄 앞, rows.length면 맨 뒤). null이면 없음. */
  nowLinePx?: number;
  nowBeforeIndex?: number | null;
  /** 다음 쪽 첫 묶음을 이 쪽 끝에 알림 줄로('22:10 반납 · 0 / 2 · 다음 쪽'). 남는 높이가 제목 높이 이상일 때만. */
  hintNextGroup?: boolean;
  /** 목록 높이가 이 값보다 낮으면, 제목 두 개보다 한 제목 + 줄이 더 들어갈 때 쪽마다 제목을 하나로 합친다(docs/42 2-3 규칙 5). */
  combineHeadingsBelowPx?: number;
}

export type PageEntry =
  | { kind: 'group'; key: string; continued: boolean }
  /** 합친 제목: 이 쪽의 묶음들을 한 줄에('22:00 · 22:10 반납'). */
  | { kind: 'groups'; keys: string[]; continued: boolean }
  | { kind: 'row'; id: string; index: number }
  | { kind: 'now' }
  | { kind: 'hint'; key: string };

export interface Page {
  index: number;
  entries: PageEntry[];
  /** 이 쪽 줄의 첫 · 끝 번호(rows 기준, 끝은 포함하지 않음). */
  from: number;
  to: number;
  usedPx: number;
  /** 줄 하나도 들어가지 않는 높이(억지로 한 줄을 넣었다). */
  overflow: boolean;
}

interface Fill {
  entries: PageEntry[];
  next: number;
  used: number;
  nowPlaced: boolean;
  lastGroup: string | undefined;
}

function fillSectioned(rows: readonly FlowRow[], start: number, room: number, o: Required<Omit<PaginateOptions, 'nowBeforeIndex'>> & { nowBeforeIndex: number | null }, prevGroup: string | undefined, nowDone: boolean): Fill {
  const entries: PageEntry[] = [];
  let used = 0;
  let i = start;
  let current: string | undefined;
  let nowPlaced = nowDone;
  while (i < rows.length) {
    const row = rows[i]!;
    const heading = o.groupTitlePx > 0 && row.group !== undefined && row.group !== current ? o.groupTitlePx : 0;
    const now = !nowPlaced && o.nowBeforeIndex === i ? o.nowLinePx : 0;
    const cost = heading + now + row.heightPx;
    if (used + cost > room) break;
    if (heading) entries.push({ kind: 'group', key: row.group!, continued: i === start && row.group === prevGroup });
    if (now) { entries.push({ kind: 'now' }); nowPlaced = true; }
    entries.push({ kind: 'row', id: row.id, index: i });
    used += cost;
    current = row.group;
    i += 1;
  }
  // 모든 시각이 지났으면 지금 줄은 맨 뒤(끝난 팀 앞)에 온다.
  if (!nowPlaced && o.nowBeforeIndex === i && i === rows.length && used + o.nowLinePx <= room && i > start) {
    entries.push({ kind: 'now' });
    used += o.nowLinePx;
    nowPlaced = true;
  }
  return { entries, next: i, used, nowPlaced, lastGroup: current };
}

function fillCombined(rows: readonly FlowRow[], start: number, room: number, o: Required<Omit<PaginateOptions, 'nowBeforeIndex'>> & { nowBeforeIndex: number | null }, prevGroup: string | undefined, nowDone: boolean): Fill {
  const entries: PageEntry[] = [];
  let used = o.groupTitlePx;
  let i = start;
  let nowPlaced = nowDone;
  const keys: string[] = [];
  while (i < rows.length) {
    const row = rows[i]!;
    const now = !nowPlaced && o.nowBeforeIndex === i ? o.nowLinePx : 0;
    if (used + now + row.heightPx > room) break;
    if (now) { entries.push({ kind: 'now' }); nowPlaced = true; }
    entries.push({ kind: 'row', id: row.id, index: i });
    if (row.group !== undefined && !keys.includes(row.group)) keys.push(row.group);
    used += now + row.heightPx;
    i += 1;
  }
  const first = rows[start];
  entries.unshift({ kind: 'groups', keys, continued: first?.group !== undefined && first.group === prevGroup });
  return { entries, next: i, used, nowPlaced, lastGroup: rows[i - 1]?.group };
}

/** 줄을 쪽으로 나눈다. 줄이 없어도 빈 쪽 하나를 돌려준다. */
export function paginate(rows: readonly FlowRow[], options: PaginateOptions): Page[] {
  const o = {
    availablePx: options.availablePx,
    fixedTopPx: options.fixedTopPx ?? 0,
    groupTitlePx: options.groupTitlePx ?? 0,
    nowLinePx: options.nowLinePx ?? 0,
    nowBeforeIndex: options.nowBeforeIndex ?? null,
    hintNextGroup: options.hintNextGroup ?? false,
    combineHeadingsBelowPx: options.combineHeadingsBelowPx ?? 0,
  };
  const room = Math.max(0, o.availablePx - o.fixedTopPx);
  const pages: Page[] = [];
  let start = 0;
  let prevGroup: string | undefined;
  let nowDone = o.nowBeforeIndex === null;
  while (start < rows.length || pages.length === 0) {
    let fill = fillSectioned(rows, start, room, o, prevGroup, nowDone);
    if (o.groupTitlePx > 0 && o.availablePx < o.combineHeadingsBelowPx) {
      const combined = fillCombined(rows, start, room, o, prevGroup, nowDone);
      const sectionHeadings = fill.entries.filter((e) => e.kind === 'group').length;
      if (sectionHeadings > 1 && combined.next > fill.next) fill = combined;
    }
    let overflow = false;
    if (fill.next === start && start < rows.length) {
      // 한 줄도 들어가지 않는 높이: 멈추지 않도록 한 줄을 억지로 넣고 표시한다(규칙 검사가 잡는다).
      const row = rows[start]!;
      fill = { entries: [{ kind: 'row', id: row.id, index: start }], next: start + 1, used: row.heightPx, nowPlaced: nowDone, lastGroup: row.group };
      overflow = true;
    }
    const lastEntry = fill.entries.at(-1);
    const nextRow = rows[fill.next];
    if (o.hintNextGroup && o.groupTitlePx > 0 && nextRow?.group !== undefined && nextRow.group !== fill.lastGroup && lastEntry?.kind !== 'hint' && room - fill.used >= o.groupTitlePx) {
      fill.entries.push({ kind: 'hint', key: nextRow.group });
      fill.used += o.groupTitlePx;
    }
    pages.push({ index: pages.length, entries: fill.entries, from: start, to: fill.next, usedPx: fill.used + o.fixedTopPx, overflow });
    nowDone = fill.nowPlaced;
    prevGroup = fill.lastGroup;
    if (fill.next === start) break;
    start = fill.next;
  }
  return pages;
}

/** 묶음 없이 같은 높이 줄이 한 쪽에 몇 개 들어가는지. */
export function rowsPerPage(availablePx: number, rowPx: number, extras: { fixedTopPx?: number; groupTitlePx?: number; nowLinePx?: number } = {}): number {
  const room = availablePx - (extras.fixedTopPx ?? 0) - (extras.groupTitlePx ?? 0) - (extras.nowLinePx ?? 0);
  return Math.max(0, Math.floor(room / rowPx));
}

/** 그 줄이 있는 쪽(없으면 -1). */
export function pageOfRow(pages: readonly Page[], rowId: string): number {
  return pages.findIndex((page) => page.entries.some((e) => e.kind === 'row' && e.id === rowId));
}

/** 지금 줄이 있는 쪽(없으면 -1). */
export function pageOfNowLine(pages: readonly Page[]): number {
  return pages.findIndex((page) => page.entries.some((e) => e.kind === 'now'));
}

/** 처음 여는 쪽: 고른 줄이 있으면 그 줄의 쪽, 아니면 지금 줄이 있는 쪽, 아니면 첫 쪽. */
export function initialPage(pages: readonly Page[], selectedRowId?: string | null): number {
  if (selectedRowId) {
    const selected = pageOfRow(pages, selectedRowId);
    if (selected >= 0) return selected;
  }
  return Math.max(0, pageOfNowLine(pages));
}

/**
 * 지금 줄의 자리: 시각순 줄에서 지금보다 늦은 첫 줄 앞. 모든 시각이 지났으면 마지막 시각 줄 뒤(끝난 팀 앞).
 * 시각이 있는 줄이 없으면 null. times는 줄 순서대로의 시각(ms, 없으면 null)이다.
 */
export function nowLineIndex(times: readonly (number | null)[], nowMs: number): number | null {
  let lastTimed = -1;
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    if (t === null || t === undefined) continue;
    if (t > nowMs) return i;
    lastTimed = i;
  }
  return lastTimed >= 0 ? lastTimed + 1 : null;
}

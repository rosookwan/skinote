// ui 4-3 · 6-2 · 6-3의 높이 계산을 확인한다(숫자는 문서의 표 그대로).
import { describe, expect, it } from 'vitest';
import {
  initialPage, listAreaHeight, nowLineIndex, pageOfNowLine, paginate, rowsPerPage, slipFixedHeight, slipItemRows,
  type FlowRow, type Page,
} from '../src/index.ts';

const POS = { headerPx: 60, titleTabsPx: 60, footerPx: 72, tableHeadPx: 40 };
const TABLET = { headerPx: 60, titleTabsPx: 56, footerPx: 80 };
const PHONE = { headerPx: 56, titleTabsPx: 56, footerPx: 72 };
const SLIP = { headerPx: 60, titlePx: 60, fieldsPx: 40, promisePx: 32, moneyPx: 40, tableHeadPx: 40, footerPx: 72 };

const rows = (n: number, heightPx: number, group?: (i: number) => string): FlowRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: 'r' + i, heightPx, ...(group ? { group: group(i) } : {}) }));
const rowIds = (page: Page) => page.entries.flatMap((e) => (e.kind === 'row' ? [e.id] : []));

describe('포스 장부(1024 폭)', () => {
  it('1024×600: 232px를 빼고 368px에 52px 줄 7개, 지금 줄이 있으면 6개', () => {
    const h = listAreaHeight(600, POS);
    expect(h).toBe(368);
    expect(rowsPerPage(h, 52)).toBe(7);
    expect(rowsPerPage(h, 52, { nowLinePx: 24 })).toBe(6);
  });

  it('설치한 PWA 1024×529는 297px에 5개, 1024×569는 337px에 6개', () => {
    expect(listAreaHeight(529, POS)).toBe(297);
    expect(rowsPerPage(listAreaHeight(529, POS), 52)).toBe(5);
    expect(listAreaHeight(569, POS)).toBe(337);
    expect(rowsPerPage(listAreaHeight(569, POS), 52)).toBe(6);
  });

  it('잰 줄을 순서대로 채우고, 지금 줄(24px)이 든 쪽은 한 줄 적다. 처음 여는 쪽은 지금 줄의 쪽', () => {
    const pages = paginate(rows(20, 52), { availablePx: 368, nowLinePx: 24, nowBeforeIndex: 9 });
    expect(pages.map((p) => p.to - p.from)).toEqual([7, 6, 7]);
    expect(pageOfNowLine(pages)).toBe(1);
    expect(pages[1]!.entries.map((e) => e.kind)).toEqual(['row', 'row', 'now', 'row', 'row', 'row', 'row']);
    expect(initialPage(pages)).toBe(1);
    expect(initialPage(pages, 'r15')).toBe(2);
    for (const page of pages) expect(page.usedPx).toBeLessThanOrEqual(368);
  });

  it('모든 시각이 지났으면 지금 줄은 마지막 시각 줄 뒤, 끝난 팀 앞', () => {
    const t = (h: number, m: number) => Date.UTC(2026, 11, 26, h, m);
    const times = [t(0, 0), t(0, 10), t(7, 0), null, null];
    expect(nowLineIndex(times, t(6, 40))).toBe(2);
    expect(nowLineIndex(times, t(14, 0))).toBe(3);
    expect(nowLineIndex([null, null], t(6, 40))).toBeNull();
  });

  it('줄이 없어도 빈 쪽 하나', () => {
    const pages = paginate([], { availablePx: 368 });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.entries).toEqual([]);
  });
});

describe('기사 수거 목록', () => {
  it('태블릿 1024×520: 196px를 빼고 324px, 빨리 확인 64 + 묶음 제목 40을 빼면 60px 줄 3개', () => {
    const h = listAreaHeight(520, TABLET);
    expect(h).toBe(324);
    expect(rowsPerPage(h, 60, { fixedTopPx: 64, groupTitlePx: 40 })).toBe(3);
    const pages = paginate(rows(5, 60, (i) => (i < 3 ? '22:00' : '22:10')), { availablePx: h, fixedTopPx: 64, groupTitlePx: 40, hintNextGroup: true });
    expect(pages).toHaveLength(2);
    expect(pages[0]!.entries).toEqual([
      { kind: 'group', key: '22:00', continued: false },
      { kind: 'row', id: 'r0', index: 0 },
      { kind: 'row', id: 'r1', index: 1 },
      { kind: 'row', id: 'r2', index: 2 },
      { kind: 'hint', key: '22:10' },
    ]);
    expect(pages[0]!.usedPx).toBe(324);
    expect(pages[1]!.entries[0]).toEqual({ kind: 'group', key: '22:10', continued: false });
  });

  it('빨리 확인 · 묶음 제목이 없으면 5개, 오프라인 연결 띠(32px)를 빼도 빨리 확인 · 제목과 3개', () => {
    expect(rowsPerPage(listAreaHeight(520, TABLET), 60)).toBe(5);
    const offline = listAreaHeight(520, { ...TABLET, connectionStripPx: 32 });
    expect(offline).toBe(292);
    expect(rowsPerPage(offline, 60, { fixedTopPx: 64, groupTitlePx: 40 })).toBe(3);
  });

  it('묶음이 다음 쪽으로 이어지면 제목을 다시 보이고 (이어서) 표시', () => {
    const pages = paginate(rows(5, 60, () => '22:00'), { availablePx: 324, fixedTopPx: 64, groupTitlePx: 40 });
    expect(pages.map(rowIds)).toEqual([['r0', 'r1', 'r2'], ['r3', 'r4']]);
    expect(pages[1]!.entries[0]).toEqual({ kind: 'group', key: '22:00', continued: true });
  });

  it('휴대폰 360×640: 184px를 빼고 456px, 묶음 제목과 64px 두 줄 줄 6개(빨리 확인이 있으면 5개), 오프라인 424px에도 6개', () => {
    const h = listAreaHeight(640, PHONE);
    expect(h).toBe(456);
    expect(rowsPerPage(h, 64, { groupTitlePx: 40 })).toBe(6);
    expect(rowsPerPage(h, 64, { groupTitlePx: 40, fixedTopPx: 64 })).toBe(5);
    const offline = listAreaHeight(640, { ...PHONE, connectionStripPx: 32 });
    expect(offline).toBe(424);
    expect(rowsPerPage(offline, 64, { groupTitlePx: 40 })).toBe(6);
    const pages = paginate(rows(8, 64, () => '22:00'), { availablePx: h, groupTitlePx: 40 });
    expect(pages.map((p) => p.to - p.from)).toEqual([6, 2]);
  });

  it('목록이 낮아 묶음 제목 두 개가 줄을 먹으면 쪽마다 제목 하나에 시간대를 함께 적는다', () => {
    const list = rows(6, 60, (i) => ['22:00', '22:10', '22:20', '22:30', '22:40', '22:50'][i]!);
    const sectioned = paginate(list, { availablePx: 324, groupTitlePx: 40 });
    expect(rowIds(sectioned[0]!)).toHaveLength(3);
    const combined = paginate(list, { availablePx: 324, groupTitlePx: 40, combineHeadingsBelowPx: 640 });
    expect(combined[0]!.entries[0]).toEqual({ kind: 'groups', keys: ['22:00', '22:10', '22:20', '22:30'], continued: false });
    expect(rowIds(combined[0]!)).toHaveLength(4);
  });
});

describe('접수증 품목 표(ui 6-2)', () => {
  it('위쪽 고정 344px, 품목 줄(52px) 한 쪽: 1024×600 4줄, 875×600 4줄, 1024×529 3줄', () => {
    expect(slipFixedHeight(SLIP)).toBe(344);
    expect(slipItemRows(600, SLIP, 52)).toBe(4);
    expect(slipItemRows(529, SLIP, 52)).toBe(3);
    expect(slipItemRows(569, SLIP, 52)).toBe(4);
  });
});

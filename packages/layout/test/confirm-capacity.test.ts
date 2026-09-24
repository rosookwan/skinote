import { describe, expect, it } from 'vitest';
import { confirmWindow, fitList, fitListByWidth, keypadPlacement, methodRowWidth, shortCount, type ConfirmWindowSpec } from '../src/index.ts';

// ui 4-5의 숫자(DeviceProfile의 confirm 값과 같음).
const SPEC: ConfirmWindowSpec = {
  sideMarginPx: 32, maxWidthPx: 860, marginYPx: 24, compactMarginYPx: 12, minHeightPx: 504,
  titlePx: 56, sectionPx: 104, payerRowPx: 64, primaryRowPx: 72, paddingXPx: 24, methodButtonMinPx: 110, methodGapPx: 12,
};

describe('접수 확정 창(ui 4-5)', () => {
  it('1024×600: 창 860 × 552, 한 쪽 3칸(504px), 칸이 4개면 두 쪽', () => {
    const w = confirmWindow({ width: 1024, height: 600 }, SPEC, 3, 4);
    expect(w.widthPx).toBe(860);
    expect(w.heightPx).toBe(552);
    expect(w.sectionsPerPage).toBe(3);
    expect(w.pageCount).toBe(1);
    expect(confirmWindow({ width: 1024, height: 600 }, SPEC, 4, 4).pageCount).toBe(2);
    // 가장 작은 창(504) = 제목 + 칸 3 × 칸 높이 + 결제할 팀 줄 + 주 버튼 줄.
    expect(SPEC.titlePx + 3 * SPEC.sectionPx + SPEC.payerRowPx + SPEC.primaryRowPx).toBe(SPEC.minHeightPx);
  });

  it('1024×529(설치한 PWA): 창 505에도 3칸', () => {
    const w = confirmWindow({ width: 1024, height: 529 }, SPEC, 3, 4);
    expect(w.heightPx).toBe(505);
    expect(w.sectionsPerPage).toBe(3);
    expect(w.tooSmall).toBe(false);
    expect(confirmWindow({ width: 1024, height: 569 }, SPEC, 3, 4).sectionsPerPage).toBe(3);
    // 1024×768은 5칸이 들어가지만 등급의 '한 쪽 결제 칸'(3)으로 묶는다.
    expect(confirmWindow({ width: 1024, height: 768 }, SPEC, 4, 4).sectionsPerPage).toBe(5);
    expect(confirmWindow({ width: 1024, height: 768 }, SPEC, 4, 4, 3).pageCount).toBe(2);
  });

  it('875×600: 창 폭 811 → 수단 버튼 6개(720px)가 들어간다(빠른 수단 4 + 후불 + 기타)', () => {
    const w = confirmWindow({ width: 875, height: 600 }, SPEC, 3, 4);
    expect(w.widthPx).toBe(811);
    expect(w.methodButtonsFit).toBeGreaterThanOrEqual(6);
    expect(w.quickShown).toBe(4);
    expect(methodRowWidth(6, SPEC)).toBe(720);
  });
});

describe('넘치는 목록(ui 4-4)', () => {
  const menu = [
    { key: 'collection_list', seq: 10, priority: 80 },
    { key: 'lift_tickets', seq: 20, priority: 60 },
    { key: 'review_list', seq: 30, priority: 90 },
    { key: 'intake_requests', seq: 40, priority: 40 },
    { key: 'management', seq: 90, priority: 100, pinnedEnd: true },
  ];

  it('메뉴 칸 수를 넘치면 우선순위 낮은 것부터 더 보기로, 관리는 늘 끝(칸 수에 세지 않음)', () => {
    const pos = fitList(menu, 3);
    expect(pos.shown.map((m) => m.key)).toEqual(['collection_list', 'lift_tickets', 'review_list', 'management']);
    expect(pos.overflow.map((m) => m.key)).toEqual(['intake_requests']);
    const narrow = fitList(menu, 2);
    expect(narrow.shown.map((m) => m.key)).toEqual(['collection_list', 'review_list', 'management']);
    const phone = fitList(menu, 1);
    expect(phone.shown.map((m) => m.key)).toEqual(['review_list', 'management']);
  });

  it('탭은 더 보기가 칸 하나를 차지한다', () => {
    const tabs = [10, 20, 30, 40, 50, 60].map((seq, i) => ({ key: 't' + i, seq, priority: [100, 60, 60, 80, 40, 20][i]! }));
    expect(fitList(tabs, 6, { moreTakesSlot: true }).overflow).toEqual([]);
    const five = fitList(tabs, 5, { moreTakesSlot: true });
    expect(five.shown.map((t) => t.key)).toEqual(['t0', 't1', 't2', 't3']);
    expect(five.overflow.map((t) => t.key)).toEqual(['t4', 't5']);
  });

  it('폭으로도 자른다', () => {
    const result = fitListByWidth(menu, 3, () => 120, 400, 100);
    // 관리 120 + 메뉴 2개 240 = 360 + 더 보기 100 > 400 → 메뉴 1개
    expect(result.shown.map((m) => m.key)).toEqual(['review_list', 'management']);
  });

  it('개수는 세 자리면 99+', () => {
    expect(shortCount(18)).toBe('18');
    expect(shortCount(120)).toBe('99+');
  });

  it('숫자판: 높이 600 이상 태블릿은 옆 판, 1024×520과 휴대폰은 아래 판', () => {
    expect(keypadPlacement(600, 600, true)).toBe('side');
    expect(keypadPlacement(520, 600, true)).toBe('sheet');
    expect(keypadPlacement(740, 600, false)).toBe('sheet');
  });
});

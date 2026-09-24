// ui 4-2의 크기별 결과(판 좌우 여백 30px씩, em × 16 = px)와 6-2 · 6-3의 폭을 그대로 확인한다.
import { resolveLedgerView, uiDefaults, visibleView, type Features } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { columnSpecs, fitColumns, type ColumnLayout } from '../src/index.ts';

const BASE = 16;
// 판 좌우 여백(DeviceProfile.sheetInsetPx: 포스 30 · 기사 16). 화면은 판 폭을 재고, 여기서는 같은 값을 빼서 쓴다.
const POS_INSET = 30;
const DRIVER_INSET = 16;
const sheet = (viewportWidth: number, inset = POS_INSET) => viewportWidth - 2 * inset;
/** 브라우저 확대가 걸린 CSS px 폭(1024 × 125% → 819.2). */
const zoomed = (deviceWidth: number, percent: number) => (deviceWidth * 100) / percent;

function specsFor(key: string, deviceClass: 'pos' | 'driver_tablet' | 'driver_phone', features: Features) {
  const view = resolveLedgerView(uiDefaults.ledger_views, key, deviceClass);
  if (!view) throw new Error('화면 설정 없음 ' + key);
  return columnSpecs(visibleView(view, features).columns);
}

const ledger = (features: Features) => specsFor('day_ledger', 'pos', features);
const widthOf = (layout: ColumnLayout, key: string) => layout.columns.find((c) => c.key === key)?.px ?? Number.NaN;
const total = (layout: ColumnLayout) => layout.columns.reduce((sum, c) => sum + c.px, 0);
const NO_LESSONS: Features = { vehicles: true, lessons: false };
const LESSONS: Features = { vehicles: true, lessons: true };

describe('오늘 대여 장부 칸 폭(ui 4-2)', () => {
  it('1024×600: W 964, 원함 합 948 → 그대로, 남는 16px은 비율로', () => {
    const layout = fitColumns(ledger(NO_LESSONS), sheet(1024), { basePx: BASE, secondLineAllowed: false });
    expect(layout.widthPx).toBe(964);
    expect(layout.mode).toBe('fit');
    expect(layout.totalPreferredPx).toBe(948);
    expect(layout.folds).toEqual([]);
    expect(widthOf(layout, 'time')).toBe(66);
    expect(widthOf(layout, 'stamp:issue')).toBe(68);
    expect(widthOf(layout, 'items')).toBeCloseTo(196 + (16 * 3) / 7, 6);
    expect(widthOf(layout, 'promise')).toBeCloseTo(214 + (16 * 2) / 7, 6);
    expect(total(layout)).toBeCloseTo(964, 6);
  });

  it('907×648: W 847, 최소 합 812 ≤ 847 → 모자란 101px를 (원함 − 최소) 비율로 줄임', () => {
    const layout = fitColumns(ledger(NO_LESSONS), sheet(907), { basePx: BASE, secondLineAllowed: false });
    expect(layout.widthPx).toBe(847);
    expect(layout.mode).toBe('fit');
    expect(layout.totalMinPx).toBe(812);
    expect(layout.folds).toEqual([]);
    expect(widthOf(layout, 'items')).toBeCloseTo(196 - (101 * 44) / 136, 6);
    expect(total(layout)).toBeCloseTo(847, 6);
    for (const c of layout.columns) expect(c.px).toBeGreaterThanOrEqual(c.minPx - 1e-6);
  });

  it('875×600: W 815, 최소 합 812 ≤ 815 → 합치지 않고 줄이기만(시각 칸이 모든 줄에 따로 남는다)', () => {
    const layout = fitColumns(ledger(NO_LESSONS), sheet(875), { basePx: BASE, secondLineAllowed: false });
    expect(layout.widthPx).toBe(815);
    expect(layout.mode).toBe('fit');
    expect(layout.folds).toEqual([]);
    expect(layout.totalMinPx).toBe(812);
    // 시각 칸 최소 64px(글자 48px): '22:00'이 굵은 16px로 들어가고, 날짜 말 · 종류('내일 반납')는 칸 안 윗줄에.
    expect(widthOf(layout, 'time')).toBeCloseTo(66 - (133 * 2) / 136, 6);
    expect(widthOf(layout, 'time')).toBeGreaterThanOrEqual(64);
    expect(widthOf(layout, 'team')).toBeCloseTo(144 - (133 * 12) / 136, 6);
    expect(total(layout)).toBeCloseTo(815, 6);
    for (const c of layout.columns) expect(c.px).toBeGreaterThanOrEqual(c.minPx - 1e-6);
  });

  it('시각이 팀 칸에 합쳐지면 팀 최소가 4em 늘어(132 → 196) 굵은 글자 \'22:00 · 한동수 · 0034\'(약 174px)가 들어간다', () => {
    const layout = fitColumns(ledger(NO_LESSONS), 790, { basePx: BASE, secondLineAllowed: false });
    expect(layout.folds).toEqual([{ from: 'time', into: 'team', mode: 'prefix' }]);
    const team = layout.columns.find((c) => c.key === 'team')!;
    expect(team.minPx).toBe(196);
    expect(team.folded).toEqual([{ key: 'time', mode: 'prefix' }]);
    expect(team.px - 16).toBeGreaterThanOrEqual(174);
  });

  it('강습 도장이 더해지면 875 · 907 모두 시각을 합치고 도장 네 칸을 한 칸(5em)으로 모아 700', () => {
    for (const screen of [875, 907]) {
      const layout = fitColumns(ledger(LESSONS), sheet(screen), { basePx: BASE, secondLineAllowed: false });
      expect(layout.mode).toBe('fit');
      expect(layout.folds.map((f) => f.from)).toEqual(['time']);
      expect(layout.collapsedGroups).toEqual([{ group: 'stamps', keys: ['stamp:issue', 'stamp:return', 'stamp:pay', 'stamp:lesson_done'] }]);
      expect(layout.totalMinPx).toBe(700);
      const stamps = layout.columns.filter((c) => c.collapsed.length > 0);
      expect(stamps).toHaveLength(1);
      expect(stamps[0]!.minPx).toBe(80);
    }
    // 1024에서는 강습 칸이 더해져도 줄이기로 들어간다(최소 합 876 ≤ 964).
    const wide = fitColumns(ledger(LESSONS), 964, { basePx: BASE, secondLineAllowed: false });
    expect(wide.folds).toEqual([]);
    expect(wide.collapsedGroups).toEqual([]);
    expect(wide.totalMinPx).toBe(876);
  });

  it('1024×600을 125%로 확대(819 CSS px, 판 759): 시각을 합쳐도 812 > 759 → 도장 모음으로 700', () => {
    const w = sheet(zoomed(1024, 125));
    expect(Math.floor(w)).toBe(759);
    const layout = fitColumns(ledger(NO_LESSONS), w, { basePx: BASE, secondLineAllowed: false });
    expect(layout.mode).toBe('fit');
    expect(layout.folds.map((f) => f.from)).toEqual(['time']);
    expect(layout.collapsedGroups.map((g) => g.keys.length)).toEqual([3]);
    expect(layout.totalMinPx).toBe(700);
  });

  it('110% 확대(판 871)는 줄이기만으로 들어간다', () => {
    const layout = fitColumns(ledger(NO_LESSONS), sheet(zoomed(1024, 110)), { basePx: BASE, secondLineAllowed: false });
    expect(layout.mode).toBe('fit');
    expect(layout.folds).toEqual([]);
    expect(layout.collapsedGroups).toEqual([]);
  });

  it('판이 700px보다 좁으면 두 줄 줄(1줄 팀 · 품목, 2줄 일정 · 금액 · 도장), 그보다 훨씬 좁으면 들어가지 않음', () => {
    const stacked = fitColumns(ledger(NO_LESSONS), 699, { basePx: BASE, secondLineAllowed: false });
    expect(stacked.mode).toBe('stacked');
    expect(stacked.columns.filter((c) => c.line === 1).map((c) => c.key)).toEqual(['team', 'items']);
    expect(stacked.columns.filter((c) => c.line === 2).map((c) => c.key)).toEqual(['promise', 'money', 'stamp:issue']);
    for (const line of [1, 2] as const) {
      expect(stacked.columns.filter((c) => c.line === line).reduce((s, c) => s + c.px, 0)).toBeLessThanOrEqual(699 + 1e-6);
    }
    const narrow = fitColumns(ledger(NO_LESSONS), 300, { basePx: BASE, secondLineAllowed: false });
    expect(narrow.mode).toBe('too_narrow');
  });
});

describe('기사 수거 목록 칸 폭(ui 6-3)', () => {
  it('휴대폰 360×640: 수거 5.5em · 팀 11.5em(품목은 둘째 줄) · 전화 3.5em = 328 = 360 − 32', () => {
    const w = sheet(360, DRIVER_INSET);
    expect(w).toBe(328);
    const layout = fitColumns(specsFor('collection_list', 'driver_phone', { vehicles: true }), w, { basePx: BASE, secondLineAllowed: true });
    expect(layout.mode).toBe('fit');
    expect(layout.columns.map((c) => [c.key, c.px])).toEqual([['stamp:collect', 88], ['team', 184], ['action:call', 56]]);
    expect(layout.folds).toEqual([{ from: 'items', into: 'team', mode: 'second_line' }]);
    expect(layout.columns.find((c) => c.key === 'team')?.folded).toEqual([{ key: 'items', mode: 'second_line' }]);
  });

  it('두 줄이 허락되지 않으면 품목은 합치지 못하고 빠진다', () => {
    const layout = fitColumns(specsFor('collection_list', 'driver_phone', { vehicles: true }), 328, { basePx: BASE, secondLineAllowed: false });
    expect(layout.dropped).toEqual(['items']);
    expect(layout.folds).toEqual([]);
  });

  it('태블릿 1024×520(판 992)과 숫자판 옆 판이 있는 1024×600(판 700)은 네 칸 그대로, 남는 폭은 팀 칸이 더 가진다(장소 이름표 자리)', () => {
    for (const w of [sheet(1024, DRIVER_INSET), 700]) {
      const layout = fitColumns(specsFor('collection_list', 'driver_tablet', { vehicles: true }), w, { basePx: BASE, secondLineAllowed: false });
      expect(layout.mode).toBe('fit');
      expect(layout.columns.map((c) => c.key)).toEqual(['stamp:collect', 'team', 'items', 'action:call']);
      expect(layout.folds).toEqual([]);
      expect(layout.columns.find((c) => c.key === 'stamp:collect')!.px).toBeGreaterThanOrEqual(88);
      // 팀 칸 = 이름 · 끝 4자리(약 104px) + 장소 이름표('설천 주차장', 약 100px) + 사이 · 여백이 들어가는 폭.
      expect(widthOf(layout, 'team')).toBeGreaterThanOrEqual(224);
      expect(widthOf(layout, 'team')).toBeGreaterThan(widthOf(layout, 'items'));
    }
  });
});

describe('접수증 품목 표 폭(ui 6-2)', () => {
  it('875×600: 519px 안에 504(품목 152 + 수량 56 + 금액 104 + 도장 3 × 64), 남는 폭은 품목', () => {
    const specs = specsFor('order_slip', 'pos', { vehicles: true });
    const layout = fitColumns(specs, 519, { basePx: BASE, secondLineAllowed: false });
    expect(layout.mode).toBe('fit');
    expect(layout.totalMinPx).toBe(504);
    expect(widthOf(layout, 'qty')).toBe(56);
    expect(widthOf(layout, 'amount')).toBe(104);
    expect(widthOf(layout, 'stamp:issue')).toBe(64);
    expect(widthOf(layout, 'items')).toBeCloseTo(152 + 15, 6);
  });

  it('1024×600: 표 668px, 품목이 남는 폭을 모두 가진다', () => {
    const layout = fitColumns(specsFor('order_slip', 'pos', { vehicles: true }), 964 - 280 - 16, { basePx: BASE, secondLineAllowed: false });
    expect(layout.mode).toBe('fit');
    expect(widthOf(layout, 'items')).toBeCloseTo(668 - 56 - 104 - 3 * 64, 6);
  });
});

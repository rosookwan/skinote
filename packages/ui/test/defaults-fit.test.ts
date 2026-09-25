// 설정 시험(ui 8절): 기본 설정(ui-defaults.json)의 모든 화면이 등급의 모든 검사 크기(+ 1024×600의 110 · 125% 확대)에서
// 4-2 칸 맞춤과 4-3 쪽 나누기로 들어가는지. 크기 숫자는 DeviceProfile에서만 읽는다.
import { DEFAULT_FEATURES, resolveLedgerView, uiDefaults, visibleView, type DeviceClassKey, type Features } from '@skinote/contract';
import { columnSpecs, confirmWindow, fitColumns, fitList, listAreaHeight, rowsPerPage } from '@skinote/layout';
import { describe, expect, it } from 'vitest';
import { DEVICE_PROFILES, type Size } from '../src/device-profile.ts';

/** 브라우저 확대가 걸린 CSS px(1024 × 125% → 819.2). */
const zoomed = (px: number, percent: number) => (px * 100) / percent;

const FEATURE_SETS: Record<string, Features> = {
  기본: DEFAULT_FEATURES,
  '강습 · 리프트권 켜짐': { ...DEFAULT_FEATURES, lessons: true, lift_tickets: true, night_collection: true },
  '차량 꺼짐': { ...DEFAULT_FEATURES, vehicles: false },
};

/** 등급의 검사 크기 + 포스는 1024×600의 110 · 125% 확대(CSS px가 줄어든 크기). */
function sizesFor(deviceClass: DeviceClassKey): Size[] {
  const sizes = [...DEVICE_PROFILES[deviceClass].checkSizes];
  if (deviceClass === 'pos_narrow') for (const zoom of [110, 125]) sizes.push({ width: zoomed(1024, zoom), height: zoomed(600, zoom) });
  return sizes;
}

const CASES: { key: string; deviceClass: DeviceClassKey }[] = [
  { key: 'day_ledger', deviceClass: 'pos' },
  { key: 'day_ledger', deviceClass: 'pos_narrow' },
  { key: 'order_slip', deviceClass: 'pos' },
  { key: 'order_slip', deviceClass: 'pos_narrow' },
  { key: 'collection_list', deviceClass: 'driver_tablet' },
  { key: 'collection_list', deviceClass: 'driver_phone' },
  { key: 'collection_list', deviceClass: 'pos' },
  { key: 'collection_list', deviceClass: 'pos_narrow' },
  { key: 'delivery_list', deviceClass: 'driver_tablet' },
  { key: 'delivery_list', deviceClass: 'driver_phone' },
];

describe('기본 설정이 모든 대상 크기에 들어간다', () => {
  for (const [featureName, features] of Object.entries(FEATURE_SETS)) {
    for (const { key, deviceClass } of CASES) {
      const profile = DEVICE_PROFILES[deviceClass];
      const resolved = resolveLedgerView(uiDefaults.ledger_views, key, deviceClass);
      it(`${featureName} · ${key} / ${deviceClass}`, () => {
        expect(resolved).toBeDefined();
        const view = visibleView(resolved!, features);
        for (const size of sizesFor(deviceClass)) {
          const where = `${size.width}×${size.height}`;
          let width = size.width - 2 * profile.sheetInsetPx;
          if (view.template_key === 'slip') width -= profile.slip!.sidePanelPx + profile.slip!.gapPx;
          if (view.template_key === 'driver_list' && profile.keypad.allowSide && size.height >= profile.keypad.sidePanelMinHeightPx) {
            width -= profile.keypad.sidePanelPx + profile.deskGapPx;
          }
          const layout = fitColumns(columnSpecs(view.columns), width, { basePx: profile.baseFontPx, secondLineAllowed: profile.secondLineRows });
          expect(layout.mode, where).toBe('fit');
          // 빠지지 않는 칸(drop 0)은 늘 보이거나(모인 도장 포함) 다른 칸 안에 합쳐진다.
          const shown = new Set(layout.columns.flatMap((c) => [c.key, ...c.collapsed, ...c.folded.map((f) => f.key)]));
          for (const column of view.columns) if (column.drop_priority === 0) expect(shown.has(column.column_key), where + ' ' + column.column_key).toBe(true);
          // 탭은 등급 칸 수 안에 들거나 더 보기로 간다.
          const tabs = fitList(view.tabs.map((t) => ({ ...t, pinnedEnd: false })), profile.capacity.tabs, { moreTakesSlot: true });
          expect(tabs.shown.length, where).toBeLessThanOrEqual(profile.capacity.tabs);
        }
      });
    }
  }
});

describe('등급의 목록 높이에 줄이 들어간다', () => {
  it('포스 장부: 모든 검사 크기에서 한 쪽에 줄 5개 이상(현재 줄 포함 4개 이상)', () => {
    for (const cls of ['pos', 'pos_narrow'] as const) {
      const p = DEVICE_PROFILES[cls];
      for (const size of p.checkSizes) {
        const h = listAreaHeight(size.height, { headerPx: p.headerPx, titleTabsPx: p.titleTabsPx, footerPx: p.footerPx, tableHeadPx: p.tableHeadPx });
        expect(rowsPerPage(h, p.rowPx), cls + ' ' + size.height).toBeGreaterThanOrEqual(5);
        expect(rowsPerPage(h, p.rowPx, { nowLinePx: p.nowLinePx }), cls + ' ' + size.height).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('기사 기기: 긴급 · 묶음 제목 · 연결 띠가 모두 있어도 한 쪽에 줄 3개 이상', () => {
    for (const cls of ['driver_tablet', 'driver_phone'] as const) {
      const p = DEVICE_PROFILES[cls];
      for (const size of p.checkSizes) {
        const h = listAreaHeight(size.height, { headerPx: p.headerPx, titleTabsPx: p.titleTabsPx, footerPx: p.footerPx, connectionStripPx: p.connectionStripPx });
        expect(rowsPerPage(h, p.rowPx, { fixedTopPx: p.pinRowPx, groupTitlePx: p.groupTitlePx }), cls + ' ' + size.height).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('포스 확정 창: 모든 검사 크기에서 한 쪽 3칸, 수단 버튼 6개(빠른 수단 4)', () => {
    for (const cls of ['pos', 'pos_narrow'] as const) {
      const p = DEVICE_PROFILES[cls];
      for (const size of p.checkSizes) {
        const w = confirmWindow(size, p.confirm, 3, p.capacity.quickMethods, p.capacity.paymentSectionsPerPage);
        expect(w.sectionsPerPage, cls + ' ' + size.width + '×' + size.height).toBe(p.capacity.paymentSectionsPerPage);
        expect(w.quickShown).toBe(p.capacity.quickMethods);
        expect(w.tooSmall).toBe(false);
      }
    }
  });
});

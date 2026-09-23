// DeviceProfile(ui 3-7)가 문서의 표와 같은지, 부품 CSS가 크기 숫자 없이 등급 변수만 쓰는지 본다.
import { readFileSync } from 'node:fs';
import { SHOP_DEVICE_CLASS_KEYS } from '@skinote/contract';
import { listAreaHeight, slipItemRows } from '@skinote/layout';
import { describe, expect, it } from 'vitest';
import { DEVICE_PROFILES, pickDeviceClass, profileCssVars } from '../src/device-profile.ts';

const css = (name: string) => readFileSync(new URL('../src/styles/' + name, import.meta.url), 'utf8');
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

describe('기기 등급 값(ui 3-7)', () => {
  it('매장 기기 등급은 글자 16px 이상, 누르는 곳 52px(기사 56px) 이상', () => {
    for (const key of SHOP_DEVICE_CLASS_KEYS) {
      const p = DEVICE_PROFILES[key];
      expect(p.minFontPx).toBeGreaterThanOrEqual(16);
      expect(p.baseFontPx).toBeGreaterThanOrEqual(16);
      expect(p.minTargetPx).toBeGreaterThanOrEqual(key.startsWith('driver') ? 56 : 52);
      expect(p.rowPx).toBeGreaterThanOrEqual(p.minTargetPx);
      expect(p.keypad.keyPx).toBeGreaterThanOrEqual(p.minTargetPx);
      expect(p.pinRowPx).toBeGreaterThanOrEqual(p.minTargetPx);
    }
  });

  it('표의 높이와 칸 수', () => {
    const pick = (key: keyof typeof DEVICE_PROFILES) => {
      const p = DEVICE_PROFILES[key];
      return [p.primaryButtonPx, p.headerPx, p.titleTabsPx, p.footerPx, p.rowPx, p.capacity.menu, p.capacity.tabs, p.capacity.quickMethods, p.accent];
    };
    expect(pick('pos')).toEqual([56, 60, 60, 72, 52, 3, 6, 4, 'orange']);
    expect(pick('pos_narrow')).toEqual([56, 60, 60, 72, 52, 2, 5, 4, 'orange']);
    expect(pick('driver_tablet')).toEqual([72, 60, 56, 80, 60, 2, 4, 3, 'purple']);
    expect(pick('driver_phone')).toEqual([64, 56, 56, 72, 64, 1, 3, 2, 'purple']);
    expect(DEVICE_PROFILES.pos.capacity.paymentSectionsPerPage).toBe(3);
    expect(DEVICE_PROFILES.driver_phone.primaryFullWidth).toBe(true);
    // 휴대폰은 묶음 제목을 합치지 않는다(팀 칸에 반납 타임을 붙일 자리가 없다).
    expect(DEVICE_PROFILES.driver_phone.combineHeadingsBelowPx).toBe(0);
    expect(DEVICE_PROFILES.driver_tablet.combineHeadingsBelowPx).toBe(640);
    expect(DEVICE_PROFILES.driver_tablet.connectionStripPx).toBe(32);
    expect(DEVICE_PROFILES.admin.minFontPx).toBe(14);
  });

  it('잰 크기와 역할로 등급을 고른다(설치한 PWA 높이 · 확대 포함)', () => {
    expect(pickDeviceClass({ width: 1024, height: 600 }, 'counter')).toBe('pos');
    expect(pickDeviceClass({ width: 1024, height: 529 }, 'counter')).toBe('pos');
    expect(pickDeviceClass({ width: 1366, height: 768 }, 'manager')).toBe('pos');
    expect(pickDeviceClass({ width: 907, height: 648 }, 'counter')).toBe('pos_narrow');
    expect(pickDeviceClass({ width: 875, height: 600 }, 'counter')).toBe('pos_narrow');
    expect(pickDeviceClass({ width: 819.2, height: 480 }, 'counter')).toBe('pos_narrow');
    expect(pickDeviceClass({ width: 1024, height: 520 }, 'driver')).toBe('driver_tablet');
    expect(pickDeviceClass({ width: 1280, height: 720 }, 'driver')).toBe('driver_tablet');
    for (const size of DEVICE_PROFILES.driver_phone.checkSizes) expect(pickDeviceClass(size, 'driver')).toBe('driver_phone');
    for (const size of DEVICE_PROFILES.pos.checkSizes) expect(pickDeviceClass(size, 'counter')).toBe('pos');
  });

  it('등급 값으로 계산한 높이가 문서와 같다', () => {
    const pos = DEVICE_PROFILES.pos;
    const chrome = { headerPx: pos.headerPx, titleTabsPx: pos.titleTabsPx, footerPx: pos.footerPx, tableHeadPx: pos.tableHeadPx };
    expect([600, 569, 529].map((h) => listAreaHeight(h, chrome))).toEqual([368, 337, 297]);
    const slip = { headerPx: pos.headerPx, footerPx: pos.footerPx, tableHeadPx: pos.tableHeadPx, titlePx: pos.slip!.titlePx, fieldsPx: pos.slip!.fieldsPx, promisePx: pos.slip!.promisePx, moneyPx: pos.slip!.moneyPx };
    expect([600, 529].map((h) => slipItemRows(h, slip, pos.rowPx))).toEqual([4, 3]);
    const tablet = DEVICE_PROFILES.driver_tablet;
    expect(listAreaHeight(520, { headerPx: tablet.headerPx, titleTabsPx: tablet.titleTabsPx, footerPx: tablet.footerPx })).toBe(324);
    const phone = DEVICE_PROFILES.driver_phone;
    expect(listAreaHeight(640, { headerPx: phone.headerPx, titleTabsPx: phone.titleTabsPx, footerPx: phone.footerPx })).toBe(456);
    // 판 폭 = 화면 폭 − 2 × 판 좌우 여백(책상 틈 + 종이 안 여백, --sn-desk-gap + --sn-paper-pad로 까는 값).
    expect(1024 - 2 * pos.sheetInsetPx).toBe(964);
    expect(360 - 2 * phone.sheetInsetPx).toBe(328);
    expect(pos.deskGapPx + Number.parseFloat(profileCssVars(pos)['--sn-paper-pad']!)).toBe(pos.sheetInsetPx);
  });
});

describe('디자인 토큰과 부품 CSS', () => {
  const components = withoutComments(css('components.css'));
  const tokens = withoutComments(css('tokens.css'));

  it('부품 CSS에 px 숫자가 없다(크기는 모두 DeviceProfile 변수)', () => {
    expect(components.match(/\d+(?:\.\d+)?px/g) ?? []).toEqual([]);
    expect(tokens.match(/\d+(?:\.\d+)?px/g) ?? []).toEqual([]);
  });

  it('부품 CSS가 쓰는 크기 변수는 모두 DeviceProfile이 깐다', () => {
    const provided = new Set([...Object.keys(profileCssVars(DEVICE_PROFILES.pos)), ...[...tokens.matchAll(/(--sn-[\w-]+)\s*:/g)].map((m) => m[1])]);
    const used = new Set([...components.matchAll(/var\((--sn-[\w-]+)/g)].map((m) => m[1]));
    const missing = [...used].filter((name) => !provided.has(name));
    expect(missing).toEqual([]);
    for (const key of SHOP_DEVICE_CLASS_KEYS) expect(Object.keys(profileCssVars(DEVICE_PROFILES[key])).sort()).toEqual(Object.keys(profileCssVars(DEVICE_PROFILES.pos)).sort());
  });

  it('말줄임표 · 스크롤 영역 · 16px 아래 글자가 없다', () => {
    const all = components + tokens;
    expect(all).not.toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(all).not.toMatch(/overflow(-[xy])?\s*:\s*(auto|scroll)/);
    expect(all).not.toMatch(/font-size\s*:(?!\s*var\()/);
  });

  it('도장 주홍은 늦음 빨강과 다른 색이고, 빨강은 늦은 것의 모양에만 쓴다', () => {
    const color = (name: string) => new RegExp(name + '\\s*:\\s*(#[0-9A-Fa-f]{6})').exec(tokens)?.[1];
    expect(color('--sn-seal')).toMatch(/^#/);
    expect(color('--sn-late')).toMatch(/^#/);
    expect(color('--sn-seal')).not.toBe(color('--sn-late'));
    const rules = [...(components + tokens).matchAll(/([^{}]+)\{([^}]*)\}/g)];
    const lateUsers = rules.filter(([, , body]) => /var\(--sn-late\)/.test(body ?? '')).map(([, selector]) => (selector ?? '').trim());
    expect(lateUsers.length).toBeGreaterThan(0);
    for (const selector of lateUsers) expect(selector).toMatch(/late/);
  });
});

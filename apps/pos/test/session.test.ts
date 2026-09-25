// 서버 모드의 세션(계획 work/impl-server/plan.md 6-3 · 6-6 session.test): 기기 종류 → 역할 · 첫 화면, 기사 기기가 열 수 있는 화면,
// 등록 · 비밀번호 실패의 한 줄(문구 표 3-17), 로그인 타일의 칸 · 쪽, 등록 요청의 기기 모양 글.
import { describe, expect, it } from 'vitest';
import { deviceAgent } from '../src/app/auth-api.ts';
import { parseHash } from '../src/app/router.ts';
import { driverRouteAllowed, homeRoute, roleOf, serverRedirect, shapeOf } from '../src/app/session-context.ts';
import { enrollLine, pinLine } from '../src/app/session.tsx';
import { staffGrid } from '../src/screens/LoginScreen.tsx';

describe('기기 종류 → 역할 · 첫 화면', () => {
  it('포스는 카운터(오늘 장부), 기사 태블릿 · 휴대폰은 기사(그 영업일의 수거 목록, 휴대폰 모양)', () => {
    expect([roleOf('pos'), roleOf('driver_tablet'), roleOf('driver_phone')]).toEqual(['counter', 'driver', 'driver']);
    expect([shapeOf('driver_tablet'), shapeOf('driver_phone')]).toEqual(['tablet', 'phone']);
    expect(homeRoute('pos', null)).toEqual({ name: 'ledger', date: null });
    expect(homeRoute('driver_tablet', '2026-12-26')).toEqual({ name: 'driver', date: '2026-12-26', device: 'tablet' });
    expect(homeRoute('driver_phone', '2026-12-26')).toEqual({ name: 'driver', date: '2026-12-26', device: 'phone' });
    // 기사는 오늘을 알아야 한다(머리를 받기 전에는 없음).
    expect(homeRoute('driver_phone', null)).toBeNull();
  });

  it('기사 기기는 기사 화면만(장부 · 접수증 · 관리 주소는 수거 목록으로)', () => {
    for (const hash of ['#/driver/2026-12-26', '#/driver/2026-12-26/deliveries', '#/driver/tasks/t1', '#/exit?from=driver']) expect(driverRouteAllowed(parseHash(hash))).toBe(true);
    for (const hash of ['#/ledger', '#/orders/o1', '#/manage', '#/exit', '#/collections']) expect(driverRouteAllowed(parseHash(hash))).toBe(false);
    const home = { name: 'driver', date: '2026-12-26', device: 'tablet' };
    expect(serverRedirect(parseHash('#/ledger'), 'driver_tablet', '2026-12-26')).toEqual(home);
    expect(serverRedirect(parseHash('#/ledger'), 'driver_tablet', null)).toBe('wait');
    expect(serverRedirect(parseHash('#/driver/2026-12-26'), 'driver_tablet', '2026-12-26')).toBeNull();
  });

  it('처음 화면 · 미리 보기 · 모르는 주소는 기기의 첫 화면으로, 카운터는 그 밖을 그대로', () => {
    expect(serverRedirect(parseHash('#/'), 'pos', null)).toEqual({ name: 'ledger', date: null });
    expect(serverRedirect(parseHash('#/preview/login'), 'pos', null)).toEqual({ name: 'ledger', date: null });
    expect(serverRedirect(parseHash('#/nowhere'), 'pos', null)).toEqual({ name: 'ledger', date: null });
    expect(serverRedirect(parseHash('#/'), 'driver_phone', '2026-12-26')).toEqual({ name: 'driver', date: '2026-12-26', device: 'phone' });
    for (const hash of ['#/ledger', '#/orders/o1', '#/manage/settings/rules', '#/collections', '#/exit', '#/driver/2026-12-26']) {
      expect(serverRedirect(parseHash(hash), 'pos', null)).toBeNull();
    }
  });
});

describe('실패의 한 줄(문구 표 3-17)', () => {
  it('등록 번호: 불일치 · 만료 · 시도 초과 · 전송 실패', () => {
    expect(enrollLine('BAD_CODE')).toBe('등록 번호 불일치 · 재입력 필요');
    expect(enrollLine('BAD_INPUT')).toBe('등록 번호 불일치 · 재입력 필요');
    expect(enrollLine('CODE_USED')).toBe('등록 번호 만료 · 새 번호 필요');
    expect(enrollLine('RATE_LIMITED')).toBe('시도 횟수 초과 · 잠시 후 재시도');
    expect(enrollLine('NETWORK')).toBe('전송 실패 · 재전송 필요');
  });

  it('비밀번호: 불일치 · 잠김(매장 시각) · 시도 초과', () => {
    expect(pinLine('BAD_PIN', undefined, 'Asia/Seoul')).toBe('비밀번호 불일치 · 재입력 필요');
    expect(pinLine('LOCKED', '2026-12-26T07:50:00.000Z', 'Asia/Seoul')).toBe('로그인 잠김 · 16:50 이후 가능');
    expect(pinLine('LOCKED', undefined, 'Asia/Seoul')).toBe('시도 횟수 초과 · 잠시 후 재시도');
    expect(pinLine('RATE_LIMITED', undefined, 'Asia/Seoul')).toBe('시도 횟수 초과 · 잠시 후 재시도');
    expect(pinLine('NETWORK', undefined, 'Asia/Seoul')).toBe('전송 실패 · 재전송 필요');
  });
});

describe('로그인 타일의 칸 · 쪽(잰 크기)', () => {
  const tile = { heightPx: 72, minWidthPx: 216, gapPx: 8 };
  it('포스 종이(624 폭)는 두 칸, 휴대폰(280 폭)은 한 칸, 줄 수는 잰 높이', () => {
    expect(staffGrid({ width: 624, height: 300 }, tile)).toEqual({ columns: 2, rows: 3, perPage: 6 });
    expect(staffGrid({ width: 624, height: 312 }, tile)).toEqual({ columns: 2, rows: 4, perPage: 8 });
    expect(staffGrid({ width: 280, height: 400 }, tile)).toEqual({ columns: 1, rows: 5, perPage: 5 });
    // 한 줄도 안 들어가도 한 줄(반쯤 잘린 줄은 검사기가 잡는다).
    expect(staffGrid({ width: 280, height: 20 }, tile).rows).toBe(1);
  });
});

describe('등록 요청의 기기 모양 글', () => {
  it('80자까지, 제어 문자 · 꺾쇠 없이', () => {
    expect(deviceAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)\n<script>')).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) script>');
    expect(deviceAgent('x'.repeat(200))).toHaveLength(80);
    expect(deviceAgent('')).toBe('browser');
  });
});

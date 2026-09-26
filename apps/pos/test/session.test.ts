// 서버 모드의 세션(계획 work/impl-server/plan.md 6-3 · 6-6 session.test): 기기 종류 → 역할 · 첫 화면, 기사 기기가 열 수 있는 화면,
// 등록 · 비밀번호 실패의 한 줄(문구 표 3-17), 로그인 타일의 칸 · 쪽, 등록 요청의 기기 모양 글. 시험 매장의 열린 등록(문구 표 3-19):
// 등록 방법 답 → 첫 화면(기기 선택 · 기기 등록 · 연결 끊김), 열린 등록 실패의 한 줄, 첫 화면의 역할(휴대폰 폭은 기사 등급), 요청 모양.
import { API_V2 } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { createAuthApi, deviceAgent } from '../src/app/auth-api.ts';
import { parseHash } from '../src/app/router.ts';
import { driverRouteAllowed, homeRoute, roleOf, serverRedirect, shapeOf } from '../src/app/session-context.ts';
import { enrollGate, enrollLine, firstVisitRole, gateOf, openDeviceLine, openEnrollLine, pinLine } from '../src/app/session.tsx';
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

describe('시험 매장의 열린 등록(문구 표 3-19)', () => {
  const vehicles = [{ id: 'v1', name: '1호 차량' }, { id: 'v2', name: '2호 차량' }];
  it('등록 방법 답 → 첫 화면: open은 기기 선택(차량), code · 옛 서버(404 · 405)는 기기 등록, 연결 없음 · 주소마다 제한 · 5xx는 연결 끊김(다시 묻는다)', () => {
    expect(enrollGate({ ok: true, value: { mode: 'open', vehicles } })).toEqual({ step: 'choose', vehicles });
    expect(enrollGate({ ok: true, value: { mode: 'code' } })).toEqual({ step: 'enroll' });
    expect(enrollGate({ ok: false, status: 405, code: 'NETWORK' })).toEqual({ step: 'enroll' });
    expect(enrollGate({ ok: false, status: 404, code: 'NETWORK' })).toEqual({ step: 'enroll' });
    expect(enrollGate({ ok: false, status: 429, code: 'RATE_LIMITED' })).toEqual({ step: 'offline' });
    expect(enrollGate({ ok: false, status: 403, code: 'BAD_ORIGIN' })).toEqual({ step: 'offline' });
    expect(enrollGate({ ok: false, status: 0, code: 'NETWORK' })).toEqual({ step: 'offline' });
    expect(enrollGate({ ok: false, status: 503, code: 'SHOP_UNAVAILABLE' })).toEqual({ step: 'offline' });
  });

  it('기기 선택에서 번호 등록으로 바뀜(서버가 열린 등록을 끔 · 기한 지남): 숫자판의 첫 한 줄, 처음 오는 번호 등록에는 없음', () => {
    expect(gateOf({ step: 'enroll' }, true)).toEqual({ step: 'enroll', notice: '기기 선택 종료 · 등록 번호 필요' });
    expect(gateOf({ step: 'enroll' })).toEqual({ step: 'enroll' });
    expect(gateOf({ step: 'offline' }, true)).toEqual({ step: 'offline' });
    expect(gateOf({ step: 'choose', vehicles }, true)).toEqual({ step: 'choose', vehicles, kind: null });
  });

  it('열린 등록 실패의 한 줄: 기기 수 초과 · 시도 초과 · 차량(처리 실패) · 전송 실패', () => {
    expect(openEnrollLine('DEVICE_LIMIT')).toBe('기기 수 초과 · 관리자 확인 필요');
    expect(openEnrollLine('RATE_LIMITED')).toBe('시도 횟수 초과 · 잠시 후 재시도');
    expect(openEnrollLine('BAD_VEHICLE')).toBe('처리 실패 · 재시도 필요');
    expect(openEnrollLine('BAD_INPUT')).toBe('처리 실패 · 재시도 필요');
    expect(openEnrollLine('NETWORK')).toBe('전송 실패 · 재전송 필요');
  });

  it('스스로 붙은 기기의 로그인 줄: 종류 이름(처음 화면의 말)과 기사 기기의 차량', () => {
    expect(openDeviceLine('pos', undefined)).toBe('카운터(포스)');
    expect(openDeviceLine('driver_phone', '1호 차량')).toBe('기사 휴대폰 · 1호 차량');
    expect(openDeviceLine('driver_tablet', '2호 차량')).toBe('기사 태블릿 · 2호 차량');
  });

  it('기기 놓기: 서명 본문을 POST, 204는 됨(값 없음), 실패는 코드', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const answers = [
      new Response(null, { status: 204 }),
      new Response(JSON.stringify({ ok: false, service: 'skinote', code: 'ENROLL_CLOSED' }), { status: 403, headers: { 'content-type': 'application/json' } }),
    ];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return answers.shift()!;
    }) as typeof fetch;
    const api = createAuthApi('https://shop.test/', fetchImpl);
    expect(await api.openRelease('D1', 'n', 's')).toEqual({ ok: true, value: null });
    expect(await api.openRelease('D1', 'n', 's')).toEqual({ ok: false, status: 403, code: 'ENROLL_CLOSED' });
    expect(calls[0]).toEqual({ url: 'https://shop.test/' + API_V2.openRelease, body: { deviceId: 'D1', nonce: 'n', signature: 's' } });
  });

  it('기기 종류를 모르는 첫 화면: 휴대폰 폭은 기사(휴대폰 등급), 태블릿 · 포스 폭은 카운터', () => {
    expect(firstVisitRole({ width: 360, height: 640 })).toBe('driver');
    expect(firstVisitRole({ width: 412, height: 780 })).toBe('driver');
    expect(firstVisitRole({ width: 875, height: 600 })).toBe('counter');
    expect(firstVisitRole({ width: 1024, height: 529 })).toBe('counter');
  });

  it('요청: 등록 방법은 GET(본문 없음), 열린 등록은 POST — 카운터는 차량 칸 없이, 기사 기기는 차량과 함께', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    const answers = [
      reply(200, { mode: 'open', vehicles }),
      reply(200, { deviceId: 'D1', kind: 'pos', label: '시험 기기 1' }),
      reply(200, { deviceId: 'D2', kind: 'driver_phone', label: '시험 기기 2', vehicleId: 'v1' }),
      reply(409, { ok: false, service: 'skinote', code: 'DEVICE_LIMIT' }),
      reply(405, { ok: false, error: 'method_not_allowed' }),
    ];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return answers.shift()!;
    }) as typeof fetch;
    const api = createAuthApi('https://shop.test/', fetchImpl);
    const key = { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y' };
    expect(await api.enrollMode()).toEqual({ ok: true, value: { mode: 'open', vehicles } });
    expect((await api.openEnroll('pos', undefined, key, 'Windows\nChrome')).ok).toBe(true);
    const phone = await api.openEnroll('driver_phone', 'v1', key, 'Android');
    expect(phone.ok && phone.value.vehicleId).toBe('v1');
    expect(await api.openEnroll('pos', undefined, key, 'x')).toEqual({ ok: false, status: 409, code: 'DEVICE_LIMIT' });
    expect(await api.enrollMode()).toEqual({ ok: false, status: 405, code: 'NETWORK' });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', 'https://shop.test/' + API_V2.enrollMode],
      ['POST', 'https://shop.test/' + API_V2.openEnroll],
      ['POST', 'https://shop.test/' + API_V2.openEnroll],
      ['POST', 'https://shop.test/' + API_V2.openEnroll],
      ['GET', 'https://shop.test/' + API_V2.enrollMode],
    ]);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[1]?.body).toEqual({ kind: 'pos', publicKey: key, agent: 'Windows Chrome' });
    expect(calls[2]?.body).toEqual({ kind: 'driver_phone', vehicleId: 'v1', publicKey: key, agent: 'Android' });
  });
});

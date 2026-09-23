// 화면 틀의 작은 규칙: 해시 경로, 자리 지키기(ui 6-1), 버튼 이름, 가져오기 경계(ui 7절).
import { DomainError, type LedgerRow } from '@skinote/contract';
import { DEVICE_PROFILES } from '@skinote/ui';
import { confirmWindow } from '@skinote/layout';
import { describe, expect, it } from 'vitest';
import { BOUNDARY_RULES, findBoundaryViolations } from '../../../scripts/check-import-boundary.mts';
import { afterFailure, type LiveState } from '../src/app/client.tsx';
import { stepButton } from '../src/app/labels.ts';
import { APP_STRINGS_KO, say } from '../src/app/strings.ts';
import { choicesPerPage } from '../src/components/NoticeDialog.tsx';
import { laterThanNow } from '../src/components/VisitResultDialog.tsx';
import { kstAt } from '../src/fixture/time.ts';
import { hrefFor, parseHash } from '../src/app/router.ts';
import { keepPositions } from '../src/screens/keep-position.ts';

describe('해시 경로', () => {
  it('sys_screens 모양(/ledger/:date · /orders/:orderId)과 체험판 경로', () => {
    expect(parseHash('')).toEqual({ name: 'start' });
    expect(parseHash('#/')).toEqual({ name: 'start' });
    expect(parseHash('#/ledger/2026-12-26')).toEqual({ name: 'ledger', date: '2026-12-26' });
    expect(parseHash('#/ledger')).toEqual({ name: 'ledger', date: null });
    expect(parseHash('#/ledger/어제')).toEqual({ name: 'unknown' });
    expect(parseHash('#/orders/o22')).toEqual({ name: 'slip', orderId: 'o22' });
    expect(parseHash('#/exit')).toEqual({ name: 'exit' });
    expect(parseHash('#/driver/2026-12-26?device=phone')).toEqual({ name: 'driver', date: '2026-12-26', device: 'phone' });
    for (const hash of ['#/', '#/ledger/2026-12-26', '#/ledger', '#/orders/o22', '#/exit', '#/driver/2026-12-26', '#/driver/2026-12-26?device=phone', '#/collections/2026-12-26', '#/collections', '#/exit?from=driver']) {
      expect(hrefFor(parseHash(hash))).toBe(hash);
    }
  });

  it('수거 목록은 sys_screens 모양(/collections/:date)과 줄임 주소(/collection/:date), 기사 기기의 나가기', () => {
    expect(parseHash('#/collections/2026-12-26')).toEqual({ name: 'collection', date: '2026-12-26' });
    expect(parseHash('#/collection/2026-12-26')).toEqual({ name: 'collection', date: '2026-12-26' });
    expect(parseHash('#/collection')).toEqual({ name: 'collection', date: null });
    expect(parseHash('#/collections/어제')).toEqual({ name: 'unknown' });
    expect(parseHash('#/exit?from=driver')).toEqual({ name: 'exit', from: 'driver' });
    expect(parseHash('#/exit?from=elsewhere')).toEqual({ name: 'exit' });
  });
});

const r = (id: string, dueAt: string): LedgerRow => ({ id, rank: id, dueAt, finished: false, cells: {} });

describe('자리 지키기', () => {
  it('다음 약속이 바뀐 줄은 제자리에 두고 자리 바뀜 표시, 새 줄은 끝에, 없어진 줄은 빠진다', () => {
    const first = keepPositions([r('a', '12:00'), r('b', '16:00'), r('c', '16:30')], null, 'k1');
    expect(first.rows.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    // b에 도장을 찍어 다음 약속이 22:00이 됨 → 서버 순서는 a · c · b, d가 새로 생김.
    const next = keepPositions([r('a', '12:00'), r('c', '16:30'), r('d', '17:00'), r('b', '22:00')], first.placed, 'k1');
    expect(next.rows.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(next.rows.map((x) => x.moved ?? false)).toEqual([false, true, false, false]);
    const gone = keepPositions([r('b', '22:00'), r('d', '17:00')], next.placed, 'k1');
    expect(gone.rows.map((x) => x.id)).toEqual(['b', 'd']);
  });

  it('쪽을 넘기거나 60초가 지나면(settle 값이 바뀌면) 서버 순서로', () => {
    const first = keepPositions([r('a', '12:00'), r('b', '16:00')], null, 'k1');
    const settled = keepPositions([r('a', '12:00'), r('b', '22:00')].reverse(), first.placed, 'k2');
    expect(settled.rows.map((x) => x.id)).toEqual(['b', 'a']);
    expect(settled.rows.some((x) => x.moved)).toBe(false);
  });
});

describe('버튼 이름', () => {
  it('동작 이름 + 읽기 모델이 준 수', () => {
    expect(stepButton('stamp.issue', { count: 6 })).toEqual({ label: '지급 도장 · 6개', alts: ['지급 도장 · 6개', '지급 도장'] });
    expect(stepButton('stamp.pay', { amount: 120_000 }).label).toBe('수납 도장 · 120,000원');
    expect(stepButton('new_order', undefined)).toEqual({ label: '새 접수', alts: ['새 접수'] });
    // 권(매)이 섞이면 확인 창과 같은 수: '지급 도장 · 6개 · 3매'. 좁으면 매 → 개 순으로 뺀다.
    expect(stepButton('stamp.issue', { count: 6, units: [{ unit: '매', qty: 3 }] })).toEqual({
      label: '지급 도장 · 6개 · 3매', alts: ['지급 도장 · 6개 · 3매', '지급 도장 · 6개', '지급 도장'],
    });
  });
});

describe('방문 결과 판의 시각(자정 넘은 야간 수거)', () => {
  const seoul = 'Asia/Seoul';
  it('영업일 오늘(26일)의 22:00은 27일 00:10에는 이미 지났고, 내일(27일) 22:00은 남았다', () => {
    const afterMidnight = kstAt('2026-12-26', 1, 0, 10);
    expect(laterThanNow('2026-12-26', '22:00', afterMidnight, seoul)).toBe(false);
    expect(laterThanNow('2026-12-26', '00:30', afterMidnight, seoul)).toBe(false);
    expect(laterThanNow('2026-12-27', '22:00', afterMidnight, seoul)).toBe(true);
    // 저녁 21:40에는 오늘 22:00이 10분 뒤 이후라 고를 수 있고, 21:45는 10분이 안 남아 빠진다.
    const evening = kstAt('2026-12-26', 0, 21, 40);
    expect(laterThanNow('2026-12-26', '22:00', evening, seoul, 10 * 60_000)).toBe(true);
    expect(laterThanNow('2026-12-26', '21:45', evening, seoul, 10 * 60_000)).toBe(false);
  });
});

describe('고르기 판의 쪽(스크롤 없음)', () => {
  it('창 높이로 한 쪽의 버튼 수를 센다: 1024×600 포스는 두 칸 × 줄 수, 휴대폰은 그보다 적다', () => {
    const pos = DEVICE_PROFILES.pos;
    const phone = DEVICE_PROFILES.driver_phone;
    const posPage = choicesPerPage(pos, confirmWindow({ width: 1024, height: 600 }, pos.confirm, 1, 0).heightPx);
    const phonePage = choicesPerPage(phone, confirmWindow({ width: 360, height: 640 }, phone.confirm, 1, 0).heightPx);
    expect(posPage % 2).toBe(0);
    expect(posPage).toBeGreaterThanOrEqual(6);
    expect(phonePage).toBeGreaterThanOrEqual(2);
    // 한 쪽이 창 본문 높이를 넘지 않는다.
    const rows = posPage / 2;
    const body = confirmWindow({ width: 1024, height: 600 }, pos.confirm, 1, 0).heightPx - pos.confirm.titlePx - pos.confirm.primaryRowPx - 2 * pos.space.m;
    expect(rows * pos.primaryButtonPx + (rows - 1) * pos.space.s).toBeLessThanOrEqual(body);
  });
});

describe('앱 문구 표', () => {
  it('영어 글자 · 말줄임표 없음, 자리의 값이 빠지면 던진다(빈칸 · 자리 글자를 보이지 않는다)', () => {
    for (const text of Object.values(APP_STRINGS_KO)) {
      // 자리 이름({time})은 채워진 뒤에는 보이지 않는다.
      expect(text.replace(/\{\w+\}/g, '')).not.toMatch(/[A-Za-z]/);
      expect(text).not.toContain('…');
    }
    expect(say('notFound', { last4: '0030' })).toBe('끝 4자리가 0030인 팀이 없습니다');
    // @ts-expect-error 값이 빠진 자리
    expect(() => say('teamName')).toThrow('{name}');
  });
});

describe('가져오기 경계', () => {
  it('apps/pos · packages/ui는 @skinote/core와 Node 내장 모듈을 가져오지 않는다', () => {
    expect(findBoundaryViolations(new URL('../../../', import.meta.url))).toEqual([]);
  });

  it('layout · contract · 화면의 경계', () => {
    const rule = (dir: string) => BOUNDARY_RULES.find((r) => r.dir === dir)!;
    expect(rule('packages/layout/src').forbid('react')).toMatch(/순수/);
    expect(rule('packages/layout/src').forbid('@skinote/ui')).toMatch(/고리/);
    expect(rule('packages/layout/src').forbid('node:fs')).toMatch(/Node/);
    expect(rule('packages/layout/src').forbid('@skinote/contract')).toBeNull();
    expect(rule('packages/contract/src').forbid('@skinote/layout')).toMatch(/contract/);
    expect(rule('packages/contract/src').forbid('react-dom/server')).toMatch(/React/);
    expect(rule('apps/pos/src/screens').forbid('../fixture/rules.ts')).toMatch(/fixture/);
    expect(rule('apps/pos/src/components').forbid('../app/client.tsx')).toBeNull();
  });

  it('검사기가 잡는 것', () => {
    const [pos, ui] = BOUNDARY_RULES;
    expect(pos!.forbid('@skinote/core')).toMatch(/core/);
    expect(pos!.forbid('node:fs')).toMatch(/Node/);
    expect(pos!.forbid('fs')).toMatch(/Node/);
    expect(pos!.forbid('@skinote/schema')).toMatch(/contract · ui · layout/);
    expect(pos!.forbid('../../packages/core/src/workflows/domain.js')).toMatch(/core/);
    expect(pos!.forbid('@skinote/ui')).toBeNull();
    expect(pos!.forbid('@skinote/ui/styles.css')).toBeNull();
    expect(pos!.forbid('react')).toBeNull();
    expect(ui!.forbid('@skinote/core/src/x')).toMatch(/core/);
    expect(ui!.forbid('node:path')).toMatch(/Node/);
    expect(ui!.forbid('@skinote/layout')).toBeNull();
  });
});

describe('읽기가 실패할 때(DomainClient가 거절)', () => {
  it('같은 화면이면 가진 읽기 모델을 지우지 않고 까닭만 적는다, 연결 문제는 다시 읽고 없는 접수는 다시 읽지 않는다', async () => {
    const rejecting = {
      query: () => Promise.reject(new DomainError('NETWORK', '연결 끊김')),
      missing: () => Promise.reject(new DomainError('NOT_FOUND', '없는 접수')),
    };
    const held: LiveState<string> = { data: '박준호 접수증', error: null, key: 'slip:o22', tick: 3 };
    const network = await rejecting.query().catch((error: unknown) => afterFailure(held, 'slip:o22', error, 4));
    expect(network).toEqual({ state: { data: '박준호 접수증', error: 'NETWORK', key: 'slip:o22', tick: 4 }, retry: true });
    const missing = await rejecting.missing().catch((error: unknown) => afterFailure(held, 'slip:nope', error, 4));
    expect(missing).toEqual({ state: { data: null, error: 'NOT_FOUND', key: 'slip:nope', tick: 4 }, retry: false });
    // 모르는 실패(예외)는 연결 문제로 본다.
    expect(afterFailure(held, 'slip:o22', new Error('fetch failed'), 5).state.error).toBe('NETWORK');
  });
});

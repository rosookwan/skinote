// 기사 연결 끊김 기록의 화면 조각(work/impl-offline/plan.md §17 검토 1회 driver-ux): 전송 대기 목록(R3-19 · 머리줄 자리와 창의 줄), 잠금 판의
// `전송 대기 {n}`과 잠긴 숫자 키(R3-24), 기사 기기의 연결 끊김 화면 `수거 목록 · 연결 후 조회 가능`(R3-30). 서버 그리기로 본다(잰 크기는 규칙 검사 몫).
import type { PendingCommand } from '@skinote/contract';
import { DeviceProfileProvider, type DeviceRole, type Size } from '@skinote/ui';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { lockPadNote } from '../src/app/session-context.ts';
import { PendingListDialog, pendingRowAlts } from '../src/components/PendingListDialog.tsx';
import { OfflineScreen } from '../src/screens/EnrollScreen.tsx';
import { LoginScreen } from '../src/screens/LoginScreen.tsx';
import { PENDING_MENU_KEY, pendingMenu } from '../src/screens/CollectionListScreen.tsx';

const render = (node: ReactElement, size: Size = { width: 360, height: 640 }, role: DeviceRole = 'driver') =>
  renderToStaticMarkup(<DeviceProfileProvider role={role} timezone="Asia/Seoul" size={size}>{node}</DeviceProfileProvider>);
const noop = () => {};

let seq = 0;
const item = (over: Partial<PendingCommand>): PendingCommand => ({
  requestId: '01K62M3QG0000000000000' + String(1000 + ++seq), type: 'stock.collect', state: 'queued', createdAt: '2026-12-26T12:42:00.000Z',
  summary: '김민수 · 0025 수거 21:42', line: { who: '김민수 · 0025', what: '수거', at: '21:42' }, ...over,
});

describe('전송 대기 목록(§17 R3-19)', () => {
  it('머리줄 자리: 보냄 대기가 있는 기기에 수가 있을 때만, 우선순위가 가장 낮아 좁으면 먼저 더 보기로', () => {
    expect(pendingMenu({ pendingCount: 0 })).toBeNull();
    expect(pendingMenu({ pendingCount: 3, sendQueue: false })).toBeNull();
    const menu = pendingMenu({ pendingCount: 3, sendQueue: true });
    expect(menu?.count).toBe(3);
    expect(menu?.entry).toMatchObject({ key: PENDING_MENU_KEY, label: '전송 대기', priority: 0, pinned_end: 0, workspace_key: 'driver' });
  });

  it('줄: 첫 줄 팀 · 끝 4자리, 둘째 줄 일 · 돈 · 시각(좁으면 돈 · 시각부터 빠짐), 답을 잃은 것은 `· 결과 확인 중`', () => {
    expect(pendingRowAlts(item({}))).toEqual({ name: '김민수 · 0025', alts: ['수거 21:42', '수거'] });
    const pay = item({ type: 'field.collect', state: 'unconfirmed', line: { who: '윤서준 · 0028', what: '현장 수납', money: '현금 120,000원', at: '21:45' } });
    expect(pendingRowAlts(pay)).toEqual({ name: '윤서준 · 0028', alts: ['현장 수납 현금 120,000원 21:45 · 결과 확인 중', '현장 수납 21:45 · 결과 확인 중', '현장 수납 · 결과 확인 중'] });
    // 팀이 없는 일(답을 잃은 매장 입고): 이름이 일, 둘째 줄은 시각.
    const receive = item({ type: 'stock.receive', state: 'unconfirmed', line: { what: '매장 입고', at: '22:30' } });
    expect(pendingRowAlts(receive)).toEqual({ name: '매장 입고', alts: ['22:30 · 결과 확인 중', '결과 확인 중'] });
    // 줄 조각이 없는 옛 기기: 한 줄 그대로.
    const { line: _line, ...old } = item({});
    expect(pendingRowAlts(old)).toEqual({ name: '김민수 · 0025 수거 21:42', alts: [] });
  });

  it('창: 제목 `전송 대기 {n}`, 줄마다 팀과 일, 쪽을 넘기면 나머지(스크롤 없음)', () => {
    const items = Array.from({ length: 9 }, (_, i) => item({ requestId: '01K62M3QG000000000000000' + String(i).padStart(2, '0'), line: { who: '팀' + i + ' · 00' + (10 + i), what: '수거', at: '21:4' + i } }));
    const html = render(<PendingListDialog items={items} onClose={noop} />);
    expect(html).toContain('전송 대기 9');
    expect(html).toContain('<span class="pos-pending-name">팀0 · 0010</span>');
    expect(html).toContain('수거 21:40');
    // 360×640: 한 쪽에 다 들어가지 않는다 → 쪽 넘김.
    const shown = (html.match(/class="pos-pending-row"/g) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(9);
    expect(html).toMatch(/1 \/ \d+쪽/);
    expect(html).not.toMatch(/[A-Za-z]{3,}(?![^<]*>)/);
  });
});

describe('잠금 판 · 연결 끊김 화면(§17 R3-24 · R3-30)', () => {
  it('잠금 판 위의 `전송 대기 {n}`(없으면 없음)', () => {
    expect(lockPadNote({ pendingCount: 0 })).toBeNull();
    expect(lockPadNote({ pendingCount: 2 })).toBe('전송 대기 2');
  });

  it('틀려서 잠긴 판은 숫자 키를 누를 수 없고 그 줄이 판에 있다', () => {
    const tile = { id: 'staff-3', name: '문태오' };
    const locked = render(<LoginScreen shopName="" staff={[tile]} openFor={tile} note={lockPadNote({ pendingCount: 2 })} onPin={() => Promise.resolve(null)} locked="로그인 잠김 · 21:05 이후 가능" />);
    expect(locked).toContain('전송 대기 2');
    expect(locked).toContain('로그인 잠김 · 21:05 이후 가능');
    expect((locked.match(/<button type="button" class="sn-key" disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(10);
    const open = render(<LoginScreen shopName="" staff={[tile]} openFor={tile} note={null} onPin={() => Promise.resolve(null)} />);
    expect((open.match(/<button type="button" class="sn-key" disabled=""/g) ?? []).length).toBe(0);
  });

  it('기사 기기의 연결 끊김 화면은 목록 · 번호를 연결 후에 볼 수 있다는 한 줄, 카운터는 없음', () => {
    const driver = render(<OfflineScreen lastSyncAt="2026-12-26T12:40:00.000Z" onRetry={noop} pending={3} driver />);
    expect(driver).toContain('전송 대기 3');
    expect(driver).toContain('수거 목록 · 연결 후 조회 가능');
    const counter = render(<OfflineScreen lastSyncAt="2026-12-26T12:40:00.000Z" onRetry={noop} />, { width: 1024, height: 600 }, 'counter');
    expect(counter).not.toContain('수거 목록 · 연결 후 조회 가능');
  });
});

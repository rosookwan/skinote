// 리프트권 · 인쇄 · 전화(features-1 plan §8): 체험판(FixtureClient)에서 리프트권 화면의 탭(ticketTabs) · 줄, 분실 처리 · 예비권 창이 고른 수를 인자로 다시
// 묻고(withPiece) 확정하면 창을 연 때의 요청번호로 명령을 보내는지, 경로(#/tickets · #/print/…) · 메뉴(`리프트권` → #/tickets), 전화 창의 기기 능력
// (canDial: 기사 기기만 `tel:`), 인쇄 쪽 높이(printGeometry)가 A4 한 쪽에 온전한 줄만 담는지 본다.
import { availableActions, defaultUiConfig, envelopeFor, openCommandDraft, resolveLedgerView, type ConfirmCommand } from '@skinote/contract';
import { printPages } from '@skinote/layout';
import { DEVICE_PROFILES } from '@skinote/ui/device-profile';
import { describe, expect, it } from 'vitest';
import { hrefFor, parseHash, screenRoute } from '../src/app/router.ts';
import { canDial, telHref } from '../src/app/runtime.ts';
import { A4, printGeometry } from '../src/components/PrintDocument.tsx';
import { pieceSheetRows, withPiece } from '../src/components/TicketLossDialog.tsx';
import { ticketTabs, vehicleBlockPx } from '../src/screens/TicketsScreen.tsx';
import { DEMO_COUNTER_PERMISSIONS, FixtureClient } from '../src/fixture/fixture-client.ts';

const demo = (options: { viewer?: 'counter' } = {}) => new FixtureClient({ realNow: () => 1_800_000_000_000, story: true, ...options });

async function send(client: FixtureClient, basis: { epoch: string; rev: number }, shape: ConfirmCommand, command: ConfirmCommand | undefined) {
  const envelope = envelopeFor(openCommandDraft(shape, basis), command);
  expect(envelope).not.toBeNull();
  return client.command(envelope!);
}

describe('리프트권 화면 · 창(체험판)', () => {
  it('16:10(박준호 지급 뒤): 현황 · 미반납 탭 수, 분실 처리 1매 → 분실 탭 · 분실 회수', async () => {
    const client = demo();
    client.advanceClock(30);
    const status = await client.query('ticketBoard', { tab: 'status' });
    const tabs = ticketTabs(status);
    expect(tabs.tabs.map((t) => [t.tab_key, t.label, t.shows_count])).toEqual([['status', '현황', 0], ['unreturned', '미반납', 1], ['lost', '분실', 1]]);
    expect(tabs.counts).toEqual({ unreturned: 1, lost: 0 });
    expect(status.status.find((r) => r.label === '야간권')).toMatchObject({ issued: 3, out: 3 });
    const out = await client.query('ticketBoard', { tab: 'unreturned' });
    const row = out.rows.find((r) => r.orderId === 'o22')!;
    expect(row.parts.map((p) => p.text)).toEqual(['야간권 3매', '반납 22:00 · 설천 주차장']);
    const opened = await client.query('ticketLossSheet', { orderId: 'o22', direction: 'loss' });
    const lineId = opened.lines[0]!.lineId;
    const picked = withPiece(opened.picked, (x) => x.lineId, lineId, 1, (id, quantity) => ({ lineId: id, quantity }));
    expect(picked).toEqual([{ lineId, quantity: 1 }]);
    const view = await client.query('ticketLossSheet', { orderId: 'o22', direction: 'loss', picked });
    expect(view.primary.label).toBe('분실 처리 · 야간권 1매');
    const shape: ConfirmCommand = { type: 'stock.write_off', payload: { orderId: 'o22', lines: [], reasonKey: 'lost' } };
    expect((await send(client, opened.basis, shape, view.command)).outcome).toBe('applied');
    const lost = await client.query('ticketBoard', { tab: 'lost' });
    expect(lost.rows.map((r) => r.parts.map((p) => p.text))).toEqual([['야간권 1매', '분실 16:10']]);
    const found = await client.query('ticketLossSheet', { orderId: 'o22', direction: 'found' });
    expect((await send(client, found.basis, { type: 'asset.found', payload: { orderId: 'o22', lines: [] } }, found.command)).outcome).toBe('applied');
    expect((await client.query('ticketBoard', { tab: 'lost' })).empty).toBe('분실 없음');
  });

  it('예비권 적재 2매 → 차량 재고 8매, 입고 창은 차에 있는 수까지', async () => {
    const client = demo();
    const opened = await client.query('spareSheet', { vehicleId: 'v1', direction: 'load' });
    const picked = withPiece(opened.picked, (x) => x.productKey, 'night_adult', 2, (id, quantity) => ({ productKey: id, quantity }));
    const view = await client.query('spareSheet', { vehicleId: 'v1', direction: 'load', picked });
    expect(view.primary.label).toBe('예비권 적재 · 야간권 2매');
    expect((await send(client, opened.basis, { type: 'stock.load', payload: { vehicleId: 'v1', spares: [] } }, view.command)).outcome).toBe('applied');
    expect((await client.query('vehicleLoad', { vehicleId: 'v1' })).spareTickets).toEqual([{ label: '야간권', qty: 8, unit: '매' }]);
    const unload = await client.query('spareSheet', { vehicleId: 'v1', direction: 'unload' });
    expect(unload.lines.map((l) => [l.lineId, l.quantity?.max])).toEqual([['night_adult', 8]]);
  });

  it('옆 동작 `분실 처리`: 미반납 권이 있는 팀만(조건 tickets_out), 카운터 권한에 stock.correct', async () => {
    const client = demo({ viewer: 'counter' });
    client.advanceClock(30);
    const config = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
    const slipView = resolveLedgerView(config.ledgerViews, 'order_slip', 'pos')!;
    expect(DEMO_COUNTER_PERMISSIONS).toContain('stock.correct');
    const tickets = await client.query('orderSlip', { orderId: 'o22' });
    expect(availableActions(slipView.actions, tickets.activeConditions, tickets.deniedPermissions ?? []).map((a) => a.action_key)).toContain('ticket_loss');
    const none = await client.query('orderSlip', { orderId: 'o21' });
    expect(availableActions(slipView.actions, none.activeConditions, none.deniedPermissions ?? []).map((a) => a.action_key)).not.toContain('ticket_loss');
  });
});

describe('경로 · 메뉴 · 기기 능력 · 쪽 높이', () => {
  it('리프트권 · 인쇄 경로', () => {
    expect(parseHash('#/tickets')).toEqual({ name: 'tickets', tab: 'status' });
    expect(parseHash('#/tickets/unreturned')).toEqual({ name: 'tickets', tab: 'unreturned' });
    expect(parseHash('#/tickets/other').name).toBe('unknown');
    expect(hrefFor({ name: 'tickets', tab: 'lost' })).toBe('#/tickets/lost');
    expect(screenRoute('lift_tickets')).toEqual({ name: 'tickets', tab: 'status' });
    expect(parseHash('#/print/collections/2026-12-26?vehicle=v1&page=2')).toEqual({ name: 'printCollection', date: '2026-12-26', vehicleId: 'v1', page: 2 });
    expect(hrefFor({ name: 'printCollection', date: '2026-12-26', vehicleId: 'v1', page: 1 })).toBe('#/print/collections/2026-12-26?vehicle=v1');
    expect(parseHash('#/print/orders/o22')).toEqual({ name: 'printSlip', orderId: 'o22', page: 1 });
  });

  it('전화: 기사 기기만 `tel:`(카운터 PC는 번호만)', () => {
    expect(canDial('driver_phone')).toBe(true);
    expect(canDial('driver_tablet')).toBe(true);
    expect(canDial('pos')).toBe(false);
    expect(canDial('pos_narrow')).toBe(false);
    expect(telHref('010-0000-0026')).toBe('tel:01000000026');
    expect(telHref('')).toBeNull();
  });

  it('A4 한 쪽: 인쇄 등급(본문 14 · 쪽 번호 12 · 줄 28)으로 32줄, 반쯤 잘린 줄 없음', () => {
    const profile = DEVICE_PROFILES.print;
    expect([profile.bodyFontPx, profile.minFontPx, profile.rowPx]).toEqual([14, 12, 28]);
    const geo = printGeometry(profile);
    const perPage = Math.floor((geo.bodyPx - geo.tableHeadPx) / geo.rowPx);
    expect(perPage).toBeGreaterThanOrEqual(30);
    expect(geo.headPx + geo.footPx + geo.bodyPx + 2 * A4.marginPx).toBe(A4.height);
    const pages = printPages(Array.from({ length: 40 }, () => geo.rowPx), geo.bodyPx - geo.tableHeadPx);
    expect(pages.map((p) => p.to - p.from)).toEqual([perPage, 40 - perPage]);
  });

  it('창 · 화면 모양 계산: 수량 칸 줄 수(1024×529 창에서도 한 줄 이상), 차량 칸 높이는 누르는 곳 + 두 줄', () => {
    const pos = DEVICE_PROFILES.pos;
    expect(pieceSheetRows(505, 2, pos)).toBeGreaterThanOrEqual(1);
    expect(pieceSheetRows(552, 1, pos)).toBe(pos.pages.returnPieceRows);
    expect(vehicleBlockPx(pos)).toBeGreaterThan(pos.minTargetPx + 2 * pos.minFontPx);
  });
});

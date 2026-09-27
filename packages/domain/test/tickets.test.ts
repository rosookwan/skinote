// 리프트권(features-1 plan §8-5): 화면(ticketBoard) · 분실 처리(stock.write_off) · 분실 회수(asset.found) · 보냄 대기 수거의 분실 되돌리기 · 예비권
// 적재 · 입고(stock.load · stock.receive의 spares) · 전화 창(phoneReveal) · 인쇄 판(가린 번호). 명령마다 돈이 그대로인지(assertMoney), 같은 요청번호를
// 두 번 보내도 한 번만 적용되는지, 보증금 매장 · 번호 권은 거절되는지 본다.
import {
  defaultUiConfig, draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type ConfirmCommand, type UiConfig,
} from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import {
  applyCommand, cancellableQty, charged, closingSheet, conflictKeys, findOrder, isFinished, kstAt, ledgerView, listTasks, lostNow, maskPhone, orderConditions, orderSlip,
  outQty, paidTotal, pendingReturn, runQuery, type FxLine, type ShopState,
} from '../src/index.ts';
import { sampleDay } from '../src/sample/index.ts';
import { assertMoney, assertMoneyViews } from './money-check.ts';

const at = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const NOW = at(16, 10);
const config: UiConfig = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
const first = (): ShopState => sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
const ctx = (now = NOW) => ({ config, now });

let seq = 0;
const rid = () => '01K62M2QG00000000000004' + String(++seq).padStart(3, '0');
function envelopeOf(state: ShopState, command: ConfirmCommand, extra: Partial<AnyCommandEnvelope> = {}): AnyCommandEnvelope {
  return { ...draftToEnvelope(openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, { requestId: rid() })), ...extra } as AnyCommandEnvelope;
}
const send = (s: ShopState, command: ConfirmCommand, now = NOW, extra: Partial<AnyCommandEnvelope> = {}) => applyCommand(s, envelopeOf(s, command, extra), now);
const ticket = (s: ShopState, orderId = 'o22'): FxLine => findOrder(s, orderId)!.lines.find((l) => l.section === 'lift')!;
const board = (s: ShopState, tab: 'status' | 'unreturned' | 'lost' = 'status', now = NOW) => runQuery(s, 'ticketBoard', { tab }, ctx(now));
const rowsText = (s: ShopState, orderId: string) => orderSlip({ state: s, config, now: NOW }, orderId)!.adjustments?.map((a) => a.parts.map((p) => p.text).join(' · ')) ?? [];

/** 박준호 팀(o22, 전화 예약): 16:05 수령 · 지급(스키 2 · 보드 1 · 헬멧 3 · 야간권 3매, 반납 22:00 설천 주차장 · 1호 차량). */
function issued(): ShopState {
  const s = first();
  const o = findOrder(s, 'o22')!;
  expect(send(s, { type: 'stock.issue', payload: { orderId: 'o22', lines: o.lines.map((l) => ({ lineId: l.id, quantity: l.qty })) } }, at(16, 5)).outcome).toBe('applied');
  return s;
}

describe('리프트권 화면(ticketBoard)', () => {
  it('15:40 현황: 권종 다섯 + 합계(지급 전이라 0), 차량 칸(1호 예비권 야간권 6매 · 2호 없음), 탭 수', () => {
    const view = board(first(), 'status', at(15, 40));
    expect(view.title).toBe('12월 26일 (토) 리프트권');
    expect(view.tabs).toEqual([{ key: 'status', label: '현황' }, { key: 'unreturned', label: '미반납', count: 0 }, { key: 'lost', label: '분실', count: 0 }]);
    expect(view.columns.map((c) => c.label)).toEqual(['권종', '지급', '미반납', '반납', '분실']);
    expect(view.status.map((r) => r.label)).toEqual(['오전권', '오후권', '야간권', '주간권', '종일권', '합계']);
    expect(view.status.every((r) => r.issued === 0 && r.out === 0)).toBe(true);
    expect(view.vehicles).toEqual([
      { vehicleId: 'v1', label: '1호 차량', stock: '예비권 재고 야간권 6매', load: { label: '예비권 적재', enabled: true }, unload: { label: '예비권 입고', enabled: true } },
      { vehicleId: 'v2', label: '2호 차량', stock: '예비권 재고 없음', load: { label: '예비권 적재', enabled: true }, unload: { label: '예비권 입고', enabled: false, reason: '입고 대상 없음' } },
    ]);
    expect(board(first(), 'unreturned', at(15, 40))).toMatchObject({ rows: [], empty: '미반납 없음', status: [], vehicles: [] });
  });

  it('지급 뒤: 야간권 지급 3 · 미반납 3, 미반납 줄(모든 날) · 조건 tickets_out, 늦으면 빨강', () => {
    const s = issued();
    const view = board(s);
    expect(view.status.find((r) => r.key === 'night_adult')).toMatchObject({ issued: 3, out: 3, returned: 0, lost: 0, unit: '매' });
    expect(view.status.at(-1)).toMatchObject({ label: '합계', issued: 3, out: 3, total: true });
    const out = board(s, 'unreturned');
    expect(out.tabs[1]).toEqual({ key: 'unreturned', label: '미반납', count: 1 });
    expect(out.rows).toEqual([{
      key: 'out:o22', orderId: 'o22', team: '박준호 · 0022', teamName: '박준호', late: false,
      parts: [{ text: '야간권 3매', drop: 0 }, { text: '반납 22:00 · 설천 주차장', drop: 1, words: true }],
      actions: [{ key: 'loss', label: '분실 처리', enabled: true }, { key: 'call', label: '전화', enabled: true }],
    }]);
    expect(orderConditions(s, findOrder(s, 'o22')!)).toContain('tickets_out');
    // 22:00 차량 수거는 야간 90분 뒤(23:30)부터 늦음.
    expect(board(s, 'unreturned', at(23, 20)).rows[0]!.late).toBe(false);
    expect(board(s, 'unreturned', at(23, 31)).rows[0]!.late).toBe(true);
    // 영업일이 지나도(다음 날의 미반납 탭) 남는다: `반납 어제 22:00`.
    const next = structuredClone(s);
    next.businessDate = '2026-12-27';
    expect(board(next, 'unreturned', at(10, 0, 1)).rows[0]!.parts[1]!.text).toBe('반납 어제 22:00 · 설천 주차장');
    expect(board(next, 'status', at(10, 0, 1)).status.every((r) => r.issued === 0)).toBe(true);
  });

  it('보증금 매장(번호 권): 분실 처리 없음(보증금 몰수), 예비권 적재 · 입고 막힘', () => {
    const s = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo', shop: 'numbered' });
    const view = board(s, 'status', at(15, 40));
    expect(view.vehicles[0]).toMatchObject({ load: { enabled: false, reason: '예비권 적재 불가 · 번호 권' }, unload: { enabled: false } });
    expect(s.orders.some((o) => orderConditions(s, o).includes('tickets_out'))).toBe(false);
  });
});

describe('분실 처리(stock.write_off) · 분실 회수(asset.found)', () => {
  it('창: 처음 값은 0(2026-09-27 점검: 한 번 더 누르면 모두 지워지지 않게), `청구 없음`, 고른 수가 주 버튼 · 명령', () => {
    const s = issued();
    const l = ticket(s);
    const opened = runQuery(s, 'ticketLossSheet', { orderId: 'o22', direction: 'loss' }, ctx());
    expect(opened.title).toBe('분실 처리 · 박준호 팀');
    expect(opened.lines).toEqual([{ lineId: l.id, label: '야간권 성인', mode: 'count', muted: true, wide: false, note: '반납 22:00 · 설천 주차장', quantity: { value: 0, min: 0, max: 3, unit: '매' } }]);
    expect(opened.primary).toMatchObject({ label: '분실 처리', enabled: false });
    expect(opened.command).toBeUndefined();
    const all = runQuery(s, 'ticketLossSheet', { orderId: 'o22', direction: 'loss', picked: [{ lineId: l.id, quantity: 3 }] }, ctx());
    expect(all.notes).toEqual([[{ text: '청구 없음', strong: true }]]);
    expect(all.primary).toEqual({ label: '분실 처리 · 야간권 3매', alts: ['분실 처리 · 야간권 3매', '분실 처리'], enabled: true });
    const one = runQuery(s, 'ticketLossSheet', { orderId: 'o22', direction: 'loss', picked: [{ lineId: l.id, quantity: 1 }] }, ctx());
    expect(one.command).toEqual({ type: 'stock.write_off', payload: { orderId: 'o22', lines: [{ lineId: l.id, quantity: 1 }], reasonKey: 'lost' } });
    const none = runQuery(s, 'ticketLossSheet', { orderId: 'o22', direction: 'loss', picked: [{ lineId: l.id, quantity: 0 }] }, ctx());
    expect(none).toMatchObject({ primary: { label: '분실 처리', enabled: false } });
    expect(none.command).toBeUndefined();
    expect(runQuery(s, 'ticketLossSheet', { orderId: 'o21', direction: 'loss' }, ctx())).toMatchObject({ lines: [], notice: '분실 대상 없음', primary: { enabled: false } });
  });

  it('1매 분실 처리: 미반납 2 · 분실 1, 수거 업무는 2매, 돈 그대로, 출처 줄, 같은 요청번호 두 번 → 한 번', () => {
    const s = issued();
    const o = findOrder(s, 'o22')!;
    const l = ticket(s);
    const money = { charged: charged(o), paid: paidTotal(o) };
    const env = envelopeOf(s, { type: 'stock.write_off', payload: { orderId: 'o22', lines: [{ lineId: l.id, quantity: 1 }], reasonKey: 'lost' } });
    const outcome = applyCommand(s, env, NOW);
    expect(outcome).toMatchObject({ outcome: 'applied', result: { lost: 1 } });
    expect(applyCommand(s, env, NOW)).toBe(outcome);
    expect(ticket(s)).toMatchObject({ lost: 1, lostAt: NOW });
    expect(outQty(ticket(s))).toBe(2);
    expect({ charged: charged(o), paid: paidTotal(o) }).toEqual(money);
    assertMoney(s);
    assertMoneyViews(s, 'o22', NOW);
    const view = board(s);
    expect(view.status.find((r) => r.key === 'night_adult')).toMatchObject({ issued: 3, out: 2, lost: 1 });
    expect(view.tabs.map((t) => t.count)).toEqual([undefined, 1, 1]);
    expect(board(s, 'lost').rows).toEqual([{
      key: 'lost:o22', orderId: 'o22', team: '박준호 · 0022', teamName: '박준호', late: false,
      parts: [{ text: '야간권 1매', drop: 0 }, { text: '분실 16:10', drop: 1 }], actions: [{ key: 'found', label: '분실 회수', enabled: true }],
    }]);
    // 오늘 분실은 시각, 어제는 `어제`(제목의 날짜를 다시 쓰지 않는다, 2026-09-27 점검).
    const tomorrow = structuredClone(s);
    tomorrow.businessDate = '2026-12-27';
    expect(board(tomorrow, 'lost').rows[0]!.parts[1]).toEqual({ text: '분실 어제', drop: 1 });
    // 수거 목록 · 업무 판은 남은 2매만.
    const list = ledgerView(s, 'collection_list', { vehicleId: 'v1' }, ctx());
    const row = list.rows.find((r) => r.orderId === 'o22')!;
    expect(row.cells.items).toMatchObject({ items: expect.arrayContaining([{ label: '야간권', qty: 2, unit: '매' }]) });
    expect(rowsText(s, 'o22')).toContain('분실 처리 · 야간권 1매 · 16:10');
    expect(conflictKeys(s, env)).toEqual({ writes: ['line:' + l.id + ':quantity'], reads: [] });
  });

  it('분실 처리한 권은 품목 취소(환불)할 수 없다(E7: 취소할 수 = 살아 있는 수 − 손님에게 있는 수 − 분실)', () => {
    const s = issued();
    const l = ticket(s);
    send(s, { type: 'stock.write_off', payload: { orderId: 'o22', lines: [{ lineId: l.id, quantity: 3 }], reasonKey: 'lost' } });
    expect(cancellableQty(ticket(s))).toBe(0);
    expect(orderConditions(s, findOrder(s, 'o22')!)).not.toContain('tickets_out');
  });

  it('거절: 손님에게 있는 수보다 많이 · 권이 아닌 줄 · 보증금 줄', () => {
    const s = issued();
    const l = ticket(s);
    expect(send(s, { type: 'stock.write_off', payload: { orderId: 'o22', lines: [{ lineId: l.id, quantity: 4 }], reasonKey: 'lost' } })).toMatchObject({ outcome: 'rejected', error: { message: '분실 대상 없음' } });
    const ski = findOrder(s, 'o22')!.lines[0]!;
    expect(send(s, { type: 'stock.write_off', payload: { orderId: 'o22', lines: [{ lineId: ski.id, quantity: 1 }], reasonKey: 'lost' } }).outcome).toBe('rejected');
    expect(send(s, { type: 'asset.found', payload: { orderId: 'o22', lines: [{ lineId: l.id, quantity: 1 }] } }).outcome).toBe('rejected');
    expect(ticket(s).lost).toBeUndefined();
    // 번호 권 · 보증금 매장(견본 numbered): 분실 처리가 아니라 보증금 몰수의 길이다.
    const numbered = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo', shop: 'numbered' });
    const n22 = findOrder(numbered, 'o22')!;
    const nt = n22.lines.find((x) => x.section === 'lift')!;
    expect(send(numbered, { type: 'stock.write_off', payload: { orderId: 'o22', lines: [{ lineId: nt.id, quantity: 1 }], reasonKey: 'lost' } }).outcome).toBe('rejected');
  });

  it('분실 회수: 지금 분실이 줄고(매장으로), 손님에게 있는 수는 그대로', () => {
    const s = issued();
    const l = ticket(s);
    send(s, { type: 'stock.write_off', payload: { orderId: 'o22', lines: [{ lineId: l.id, quantity: 1 }], reasonKey: 'lost' } });
    const view = runQuery(s, 'ticketLossSheet', { orderId: 'o22', direction: 'found' }, ctx());
    expect(view).toMatchObject({ title: '분실 회수 · 박준호 팀', notes: [], primary: { label: '분실 회수 · 야간권 1매', enabled: true } });
    expect(view.lines[0]).toMatchObject({ note: '분실 16:10', quantity: { value: 1, max: 1 } });
    expect(applyCommand(s, envelopeOf(s, view.command!), at(16, 20))).toMatchObject({ outcome: 'applied', result: { found: 1 } });
    expect(lostNow(ticket(s))).toBe(0);
    expect(outQty(ticket(s))).toBe(2);
    expect(board(s).status.find((r) => r.key === 'night_adult')).toMatchObject({ out: 2, lost: 0 });
    expect(board(s, 'lost')).toMatchObject({ rows: [], empty: '분실 없음' });
    expect(rowsText(s, 'o22')).toEqual(expect.arrayContaining(['분실 처리 · 야간권 1매 · 16:10', '분실 회수 · 야간권 1매 · 16:20']));
    assertMoney(s);
  });

  it('남은 것이 권뿐이면 모두 분실 처리 → `22:00 설천 주차장 수거 취소`, 수거 업무가 사라지고 반납 끝', () => {
    const s = issued();
    const o = findOrder(s, 'o22')!;
    send(s, { type: 'stock.direct_return', payload: { orderId: 'o22', lines: o.lines.filter((l) => l.section !== 'lift').map((l) => ({ lineId: l.id, quantity: l.qty })) } }, at(21, 31));
    const view = runQuery(s, 'ticketLossSheet', { orderId: 'o22', direction: 'loss', picked: [{ lineId: ticket(s).id, quantity: 3 }] }, ctx(at(23, 40)));
    expect(view.notes).toEqual([[{ text: '청구 없음', strong: true }], [{ text: '22:00 설천 주차장 수거 취소', strong: true }]]);
    // 수거가 없어지면 주 버튼도 말한다.
    expect(view.primary.label).toBe('분실 처리 · 야간권 3매 · 수거 취소');
    expect(closingSheet({ state: s, config, now: at(23, 40) }, {}).carry.find((c) => c.key === 'overdue:lift')).toMatchObject({ ticketTab: 'unreturned', late: true });
    expect(applyCommand(s, envelopeOf(s, view.command!), at(23, 40)).outcome).toBe('applied');
    expect(pendingReturn(o)).toBe(false);
    expect(listTasks(s, 'v1', '2026-12-26').some((t) => t.order.id === 'o22')).toBe(false);
    expect(closingSheet({ state: s, config, now: at(23, 45) }, {}).carry.some((c) => c.key === 'overdue:lift')).toBe(false);
    expect(orderConditions(s, o)).not.toContain('tickets_out');
    // 장비 값 120,000원(반납 때 받기로 함)은 그대로 미수.
    expect(isFinished(s, o)).toBe(false);
    assertMoney(s);
  });

  it('보냄 대기로 온 수거가 손님에게 있는 수보다 많으면 분실 처리를 먼저 되돌린다(연결된 수거는 남은 수까지)', () => {
    const s = issued();
    const l = ticket(s);
    send(s, { type: 'stock.write_off', payload: { orderId: 'o22', lines: [{ lineId: l.id, quantity: 1 }], reasonKey: 'lost' } });
    const online = structuredClone(s);
    expect(send(online, { type: 'stock.collect', payload: { taskId: 'collect:o22', lines: [{ lineId: l.id, quantity: 3 }] } }, at(22, 40)).outcome).toBe('applied');
    expect(ticket(online)).toMatchObject({ collected: 2, lost: 1 });
    expect(send(s, { type: 'stock.collect', payload: { taskId: 'collect:o22', lines: [{ lineId: l.id, quantity: 3 }] } }, at(22, 40), { deviceSeq: 1 }).outcome).toBe('applied');
    expect(ticket(s)).toMatchObject({ collected: 3, lost: 0 });
    expect(outQty(ticket(s))).toBe(0);
    assertMoney(s);
  });
});

describe('예비권 적재 · 입고(stock.load · stock.receive의 spares)', () => {
  it('창: 권종마다 −/+ 처음 0, 요약 `1호 차량 예비권 재고 6매 → 8매`, 주 버튼 `예비권 적재 · 야간권 2매`', () => {
    const s = first();
    const empty = runQuery(s, 'spareSheet', { vehicleId: 'v1', direction: 'load' }, ctx());
    expect(empty.title).toBe('예비권 적재 · 1호 차량');
    expect(empty.lines.map((x) => x.label)).toEqual(['오전권 성인', '오후권 성인', '야간권 성인', '주간권 성인', '종일권 성인']);
    expect(empty.lines[2]).toMatchObject({ lineId: 'night_adult', note: '차량 재고 6매', quantity: { value: 0, min: 0, max: s.registry.maxLineQuantity, unit: '매' }, muted: true });
    expect(empty.primary).toEqual({ label: '예비권 적재', alts: ['예비권 적재', '예비권 적재'], enabled: false });
    const two = runQuery(s, 'spareSheet', { vehicleId: 'v1', direction: 'load', picked: [{ productKey: 'night_adult', quantity: 2 }] }, ctx());
    expect(two.summary.map((r) => r.text).join('')).toBe('1호 차량 예비권 재고 6매 → 8매');
    expect(two.primary.label).toBe('예비권 적재 · 야간권 2매');
    expect(two.command).toEqual({ type: 'stock.load', payload: { vehicleId: 'v1', spares: [{ productKey: 'night_adult', quantity: 2 }] } });
    const unload = runQuery(s, 'spareSheet', { vehicleId: 'v2', direction: 'unload' }, ctx());
    expect(unload).toMatchObject({ title: '예비권 입고 · 2호 차량', lines: [], notice: '입고 대상 없음', primary: { enabled: false } });
  });

  it('적재 → 차량 재고 8매(업무 판 · 차량 재고), 2호 차량은 새 행(차례: 차량 → 상품), 입고는 차에 있는 수까지, 같은 요청번호 두 번 → 한 번', () => {
    const s = first();
    const env = envelopeOf(s, { type: 'stock.load', payload: { vehicleId: 'v1', spares: [{ productKey: 'night_adult', quantity: 2 }] } });
    const outcome = applyCommand(s, env, NOW);
    expect(outcome.outcome).toBe('applied');
    expect(applyCommand(s, env, NOW)).toBe(outcome);
    expect(s.vanSpares).toEqual([{ vehicleId: 'v1', productKey: 'night_adult', quantity: 8 }]);
    expect(conflictKeys(s, env)).toEqual({ writes: ['vehicle:v1:spares'], reads: [] });
    expect(runQuery(s, 'vehicleLoad', { vehicleId: 'v1' }, ctx()).spareTickets).toEqual([{ label: '야간권', qty: 8, unit: '매' }]);
    expect(send(s, { type: 'stock.load', payload: { vehicleId: 'v2', spares: [{ productKey: 'morning_adult', quantity: 3 }, { productKey: 'night_adult', quantity: 1 }] } }).outcome).toBe('applied');
    expect(s.vanSpares).toEqual([
      { vehicleId: 'v1', productKey: 'night_adult', quantity: 8 },
      { vehicleId: 'v2', productKey: 'morning_adult', quantity: 3 },
      { vehicleId: 'v2', productKey: 'night_adult', quantity: 1 },
    ]);
    expect(board(s).vehicles[1]!.stock).toBe('예비권 재고 오전권 3매 · 야간권 1매');
    expect(send(s, { type: 'stock.receive', payload: { vehicleId: 'v2', taskIds: [], spares: [{ productKey: 'night_adult', quantity: 2 }] } })).toMatchObject({ outcome: 'rejected', error: { message: '입고 대상 없음' } });
    const back = envelopeOf(s, { type: 'stock.receive', payload: { vehicleId: 'v2', taskIds: [], spares: [{ productKey: 'night_adult', quantity: 1 }] } });
    expect(applyCommand(s, back, NOW).outcome).toBe('applied');
    expect(s.vanSpares![2]).toEqual({ vehicleId: 'v2', productKey: 'night_adult', quantity: 0 });
    expect(conflictKeys(s, back).writes).toEqual(['vehicle:v2:spares']);
    // 매장 입고 기록(미입고의 기준)은 예비권 입고로 생기지 않는다.
    expect(s.vanReceipts ?? []).toEqual([]);
    // 번호 권 · 리프트권이 아닌 상품은 거절.
    expect(send(s, { type: 'stock.load', payload: { vehicleId: 'v1', spares: [{ productKey: 'ski', quantity: 1 }] } }).outcome).toBe('rejected');
    const numbered = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo', shop: 'numbered' });
    expect(send(numbered, { type: 'stock.load', payload: { vehicleId: 'v1', spares: [{ productKey: 'night_adult', quantity: 1 }] } }).outcome).toBe('rejected');
    assertMoney(s);
  });
});

describe('전화 · 인쇄(features-1 §8-3 · §8-4)', () => {
  it('전화 창의 온전한 번호와 인쇄의 가린 번호', () => {
    const s = first();
    expect(runQuery(s, 'phoneReveal', { orderId: 'o26' }, ctx())).toEqual({ title: '전화 · 최하은 팀', number: '010-0000-0026' });
    expect(() => runQuery(s, 'phoneReveal', { orderId: 'none' }, ctx())).toThrow('없는 접수');
    expect(maskPhone('010-0000-0025')).toBe('010-****-0025');
    expect(maskPhone('01000000025')).toBe('010-****-0025');
    expect(maskPhone('')).toBe('');
  });

  it('인쇄 수거 목록: 팀 · 가린 번호 · 품목 · 반납 · 차량(도장 없음), 인쇄 접수증: 가린 연락처', () => {
    const s = first();
    const list = ledgerView(s, 'collection_list', { vehicleId: 'v1', deviceClass: 'print' }, ctx());
    expect(list.deviceClass).toBe('print');
    const row = list.rows.find((r) => r.orderId === 'o25')!;
    expect(Object.keys(row.cells)).toEqual(['team', 'action:call', 'items', 'promise', 'vehicle']);
    expect(row.cells['action:call']).toEqual({ renderer: 'action', actionKey: 'call', enabled: true, phone: '010-****-0025' });
    // 손님 번호는 가린 것뿐(머리의 매장 전화 010-0000-0000은 손님 정보가 아니다).
    expect(JSON.stringify(list)).not.toMatch(/010-0000-(?!0000)\d{4}/);
    expect(list.printHead).toEqual({ shopName: s.registry.shopName, shopPhone: '010-0000-0000' });
    const slip = runQuery(s, 'orderSlip', { orderId: 'o25', deviceClass: 'print' }, ctx());
    expect(slip.fields.find((f) => f.key === 'phone')?.value).toBe('010-****-0025');
    expect(Object.keys(slip.lines[0]!.cells)).toEqual(['items', 'qty', 'amount']);
  });
});

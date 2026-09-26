// FixtureClient(체험판의 서버 대역)가 시안의 하루를 그대로 돌려주는지, 명령 · 요청번호 · 저장 · 체험 시계가 약속대로 도는지.
import {
  defaultUiConfig, draftToEnvelope, openCommandDraft, uiDefaults, type ConfirmCommand, type ConfirmDraftView, type LedgerRow, type LedgerViewResult,
  type UiConfig,
} from '@skinote/contract';
import { openOrRestoreDraft } from '@skinote/ui';
import { describe, expect, it } from 'vitest';
import { confirmEnvelope, draftOptions } from '../src/components/ConfirmFlow.tsx';
import { collectionList, dayLedger, kstAt, orderSlip } from '@skinote/domain';
import { AREAS } from '@skinote/domain/sample';
import { createSeed, DEMO_START_MS } from '../src/fixture/demo.ts';
import { FixtureClient, type FixtureStorage } from '../src/fixture/fixture-client.ts';

class MemoryStorage implements FixtureStorage {
  readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

const at = (h: number, m: number, day = 0) => new Date(kstAt('2026-12-26', day, h, m)).toISOString();

function setup(storage: FixtureStorage = new MemoryStorage()) {
  let real = 1_800_000_000_000;
  const client = new FixtureClient({ storage, realNow: () => real });
  return { client, storage, pass: (ms: number) => { real += ms; } };
}

const row = (result: LedgerViewResult, id: string): LedgerRow => {
  const hit = result.rows.find((r) => r.id === id);
  if (!hit) throw new Error('줄이 없다: ' + id);
  return hit;
};
const stamp = (r: LedgerRow, key: string) => {
  const cell = r.cells[key];
  if (cell?.renderer !== 'stamp') throw new Error('도장 칸이 아니다: ' + key);
  return cell.stamp;
};
const money = (r: LedgerRow) => {
  const cell = r.cells['money'];
  if (cell?.renderer !== 'money') throw new Error('돈 칸이 아니다');
  return cell;
};

/** 화면과 같은 길: 창을 연 때 초안(요청번호 · basis · expect) → 사람이 고른 수량 · 수단 → 봉투(ConfirmFlow의 함수 그대로). */
async function confirmAndSend(client: FixtureClient, view: ConfirmDraftView, choices: { qty?: number; method?: string } = {}) {
  if (!view.command) throw new Error('확정할 명령이 없다: ' + view.notice);
  const draft = openOrRestoreDraft(null, view.command, view.basis, draftOptions(view));
  const envelope = confirmEnvelope(draft, view.command, choices.qty ?? null, choices.method ?? null);
  return { envelope, outcome: await client.command(envelope) };
}

/** 확인 창이 필요 없는 명령(순서 · 확인 · 방문 결과): 목록의 basis로. */
function plainEnvelope(command: ConfirmCommand, basis: { epoch: string; rev: number }) {
  return draftToEnvelope(openCommandDraft(command, basis));
}

describe('체험 자료(시안의 하루)', () => {
  it('18팀, 번호는 모두 가짜(010-0000-xxxx), 끝 4자리는 겹치지 않는다', () => {
    const state = createSeed('e');
    expect(state.orders).toHaveLength(18);
    for (const o of state.orders) expect(o.phone).toMatch(/^010-0000-\d{4}$/);
    expect(new Set(state.orders.map((o) => o.last4)).size).toBe(18);
    const park = state.orders.find((o) => o.teamName === '박준호')!;
    expect(park.lines.map((l) => [l.label, l.qty])).toEqual([['스키', 2], ['보드', 1], ['헬멧', 3], ['야간권 성인', 3]]);
    expect(park.payments).toEqual([expect.objectContaining({ amount: 105_000, section: 'lift', methodKey: 'transfer' })]);
    expect(AREAS.find((a) => a.label === '솔마을')?.places.map((p) => p.label)).toContain('한솔동');
    expect(AREAS.find((a) => a.label === '꽃마을')?.places.map((p) => p.label)).toContain('들국화');
  });

  it('오늘 대여 장부: 15:40, 지연 줄이 맨 위, 다음 일정 순, 완료 팀은 맨 뒤', async () => {
    const { client } = setup();
    const ledger = await client.ledgerView('day_ledger', { tabKey: 'all' });
    expect(ledger.serverTime).toBe(at(15, 40));
    expect(ledger.currentBusinessDate).toBe('2026-12-26');
    expect(ledger.rows.map((r) => r.id).slice(0, 6)).toEqual(['o27', 'o22', 'o32', 'o21', 'o23', 'o36']);
    expect(ledger.rows.at(-1)).toMatchObject({ id: 'o24', finished: true });
    expect(ledger.tabCounts).toEqual({ all: 18, pickup: 3, return: 14, unpaid: 4, vehicle: 14 });
    expect(ledger.metrics).toEqual([
      { metricKey: 'team_count', unit: 'team', value: 18 },
      { metricKey: 'issued_count', unit: 'count', value: 15 },
      { metricKey: 'returned_count', unit: 'count', value: 1 },
      { metricKey: 'due_total', unit: 'won', value: 455_000 },
    ]);
    expect(ledger.activeConditions).toEqual(['before_last_return_slot']);
    expect(ledger.nightPrep).toBeUndefined();
  });

  it('박준호 팀 한 줄: 수령 16:00, 반납 일정 22:00 설천 주차장 · 차량, 미수 120,000원(검정), 도장 지급 · 반납(대기) · 수납(부분)', async () => {
    const { client } = setup();
    const r = row(await client.ledgerView('day_ledger', {}), 'o22');
    expect(r.dueAt).toBe(at(16, 0));
    expect(r.lateAt).toBeUndefined();
    expect(r.cells['team']).toEqual({ renderer: 'team', name: '박준호', last4: '0022' });
    expect(r.cells['items']).toMatchObject({ items: [{ label: '스키', qty: 2 }, { label: '보드', qty: 1 }, { label: '헬멧', qty: 3 }, { label: '야간권', qty: 3, unit: '매' }] });
    expect(r.cells['promise']).toMatchObject({ parts: [{ text: '22:00 설천 주차장' }, { text: '차량' }] });
    expect(money(r)).toMatchObject({ alts: ['미수 120,000원', '120,000원'], stacked: { over: '미수', main: '120,000원' }, tone: 'ink' });
    // 장비 값은 반납 때 받기로 했다(spec 2-4 16:05): 미수의 지연 기준은 그 반납의 지연 기준 — 차량 수거라 22:00 + 야간 90분(첫 매장
    // 운영 규칙 vehicleLate, 2026-09-26 답 15). 그 전에는 검정.
    expect(money(r).lateAt).toBe(at(23, 30));
    expect(stamp(r, 'stamp:issue')).toEqual({ stepKey: 'issue', state: 'todo' });
    expect(stamp(r, 'stamp:return')).toMatchObject({ stepKey: 'return', state: 'blocked', blockedBy: { stepKey: 'issue', message: '반납 불가 · 지급 대기' } });
    expect(stamp(r, 'stamp:pay')).toEqual({ stepKey: 'pay', state: 'partial' });
  });

  it('여러 경우: 지연 미수(빨강 기준 시각), 차량 배달은 적재부터, 다른 팀 결제, 차량 반납은 차량 수거', async () => {
    const { client } = setup();
    const ledger = await client.ledgerView('day_ledger', {});
    const late = row(ledger, 'o27');
    expect(Date.parse(late.lateAt!)).toBeLessThanOrEqual(Date.parse(ledger.serverTime));
    expect(Date.parse(money(late).lateAt!)).toBeLessThanOrEqual(Date.parse(ledger.serverTime));
    expect(money(late).alts[0]).toBe('미수 65,000원');
    expect(stamp(row(ledger, 'o26'), 'stamp:issue')).toEqual({ stepKey: 'load', state: 'todo' });
    // 전날 받은 선입금의 수납 도장에는 시각을 찍지 않는다(오늘 장부에 어제 시각이 보이지 않게).
    expect(stamp(row(ledger, 'o26'), 'stamp:pay')).toEqual({ stepKey: 'pay', state: 'done' });
    expect(stamp(row(ledger, 'o21'), 'stamp:pay')).toEqual({ stepKey: 'pay', state: 'done', at: at(9, 5) });
    expect(money(row(ledger, 'o36'))).toMatchObject({ alts: ['이정호 팀 결제 예정', '결제 예정'], tone: 'blue' });
    expect(stamp(row(ledger, 'o36'), 'stamp:pay')).toMatchObject({ state: 'scheduled', scheduledNote: '이정호 팀 결제 예정' });
    // 예정 도장을 누르면: 누가 낼지 한 줄과 '직접 수납 · 금액'(이 팀이 지금 직접 낼 때, 동작 이름 + 금액).
    expect(stamp(row(ledger, 'o36'), 'stamp:pay').pressNote).toEqual({ lines: ['이정호 팀 결제 예정'], action: { actionKey: 'stamp.pay', label: '직접 수납 · 60,000원' } });
    // 미수는 이 팀 몫만: 다른 팀 몫(대납)까지 받을 팀의 합은 '받을 금액'(미수 두 가지가 보이지 않게).
    expect(money(row(ledger, 'o32'))).toMatchObject({ alts: ['미수 90,000원 · 대납 60,000원', '받을 금액 150,000원', '150,000원'], stacked: { over: '받을 금액', main: '150,000원' } });
    expect(stamp(row(ledger, 'o25'), 'stamp:return')).toMatchObject({ stepKey: 'return', state: 'delegated', at: at(22, 0), delegatedTo: '1호 차량' });
    // 차량이 할 도장을 카운터에서 누르면: 누가 · 언제 하는지 한 줄과 '매장 반납 처리'(서버가 정한 글 · 동작, 조사 없음).
    expect(stamp(row(ledger, 'o25'), 'stamp:return').pressNote).toEqual({
      lines: ['1호 차량 수거 예정 · 22:00'],
      action: { actionKey: 'stamp.return', label: '매장 반납 처리' },
    });
    expect(stamp(row(ledger, 'o25'), 'stamp:issue')).toEqual({ stepKey: 'issue', state: 'done', at: at(9, 18) });
    expect(row(ledger, 'o39').cells['promise']).toMatchObject({ parts: [{ text: '21:50 꽃마을 들국화' }, { text: '차량' }, { text: '조기 반납' }] });
    expect(row(ledger, 'o28').cells['promise']).toMatchObject({ parts: [{ text: '내일 09:00 솔마을 한솔동' }, { text: '차량' }] });
  });

  it('탭: 수령 · 미수 · 차량만 걸러 준다', async () => {
    const { client } = setup();
    expect((await client.ledgerView('day_ledger', { tabKey: 'pickup' })).rows.map((r) => r.id)).toEqual(['o22', 'o32', 'o26']);
    expect((await client.ledgerView('day_ledger', { tabKey: 'unpaid' })).rows.map((r) => r.id).sort()).toEqual(['o22', 'o27', 'o28', 'o32']);
    const vehicle = await client.ledgerView('day_ledger', { tabKey: 'vehicle' });
    expect(vehicle.activeTabKey).toBe('vehicle');
    expect(vehicle.rows.every((r) => ['o21', 'o22', 'o23', 'o25', 'o26', 'o28', 'o29', 'o31', 'o33', 'o34', 'o35', 'o37', 'o39', 'o41'].includes(r.id))).toBe(true);
  });
});

describe('대여 접수증과 처리 현황', () => {
  it('박준호 팀: 칸 한 줄, 품목 네 줄(적재 칸 없음), 일정 두 줄, 돈 줄, 처리 현황 — 지금은 지급 처리 · 6개', async () => {
    const { client } = setup();
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.receiptNo).toBe('261226-017');
    expect(slip.fields.map((f) => f.label + ' ' + f.value)).toEqual(['날짜 12월 26일 (토)', '구분 전화 예약', '대표자 박준호', '연락처 010-0000-0022', '인원 3명']);
    expect(slip.lines).toHaveLength(4);
    for (const line of slip.lines) expect(line.cells['stamp:load']).toBeUndefined();
    // 리프트권 반납 필수(이 매장 운영 규칙): 권 줄에도 반납 칸이 있다(지급 전이라 대기).
    expect(slip.lines[3]).toMatchObject({ label: '야간권 성인', qtyText: '3매', amount: 105_000, cells: { 'stamp:return': { stamp: { stepKey: 'return', state: 'blocked' } } } });
    expect(slip.promises.lines.map((l) => [l.kind, l.at, l.parts.map((p) => p.text)])).toEqual([
      ['pickup', at(16, 0), ['매장']],
      ['return', at(22, 0), ['설천 주차장', '1호 차량']],
    ]);
    expect(slip.money).toMatchObject({ charged: 225_000, paid: 105_000, due: 120_000, payments: [{ amount: 105_000, methodLabel: '계좌이체', date: '2026-12-24' }] });
    // 전화 예약이라 권 보증금을 아직 받지 않았다(지급 창이 먼저 묻는다): 돈 줄에 보증금 조각이 없다.
    expect(slip.money.depositHeld).toBeUndefined();
    // 장비 값은 반납 때 받기로 해서(payWhen return) 수납이 반납 뒤에 온다(V9 · V1의 처리 현황과 같은 차례).
    expect(slip.checklist.map((c) => [c.stepKey, c.state])).toEqual([['order', 'done'], ['issue', 'now'], ['return', 'later'], ['pay', 'later']]);
    expect(slip.checklist[0]!.parts.map((p) => p.text)).toEqual(['접수', '전화 예약', '리프트권 105,000원 수납']);
    expect(slip.checklist[1]!.parts.map((p) => p.text)).toEqual(['장비 지급']);
    // 품목은 둘째 줄(화면이 넘치면 '외 N종'으로 줄인다).
    expect(slip.checklist[1]!.items).toEqual([{ label: '스키', qty: 2 }, { label: '보드', qty: 1 }, { label: '헬멧', qty: 3 }, { label: '야간권', qty: 3, unit: '매' }]);
    // 반납은 두 줄: 윗줄 '반납 · 오늘 22:00', 둘째 줄 '설천 주차장 · 차량 수거'(V9 뒤 화면).
    expect(slip.checklist[2]!.parts.map((p) => p.text)).toEqual(['반납', '오늘 22:00']);
    expect(slip.checklist[2]!.second?.map((p) => p.text)).toEqual(['설천 주차장', '차량 수거']);
    // 주 버튼의 수는 확인 창과 같은 셈(개 + 매).
    expect(slip.nextStep).toEqual({ stepKey: 'issue', actionKey: 'stamp.issue', figure: { count: 6, units: [{ unit: '매', qty: 3 }] } });
    expect(slip.activeConditions).toEqual(expect.arrayContaining(['partial_cancel_allowed', 'return_required', 'vehicle_return', 'has_due']));
    // 아직 내준 것이 없으니 조기 반납의 조건(has_items_out)은 없다.
    expect(slip.activeConditions).not.toContain('has_items_out');
    // 품목 표의 칸은 서버가 모두 채운다(품목 이름 · 수량 · 금액 · 도장).
    expect(slip.lines[0]!.cells['items']).toEqual({ renderer: 'text', parts: [{ text: '스키', drop: 0, words: true }] });
    expect(slip.lines[0]!.cells['qty']).toEqual({ renderer: 'text', parts: [{ text: '2', drop: 0 }] });
    expect(slip.lines[0]!.cells['amount']).toEqual({ renderer: 'money', alts: ['80,000원'], tone: 'ink' });
  });

  it('차량 배달 팀(최하은): 적재 칸이 있고, 다음 처리는 차량 적재', async () => {
    const { client } = setup();
    const slip = await client.query('orderSlip', { orderId: 'o26' });
    expect(slip.lines[0]!.cells['stamp:load']).toMatchObject({ stamp: { stepKey: 'load', state: 'todo' } });
    expect(slip.lines[0]!.cells['stamp:issue']).toMatchObject({ stamp: { state: 'blocked', blockedBy: { stepKey: 'load', message: '지급 불가 · 적재 대기' } } });
    expect(slip.nextStep).toEqual({ stepKey: 'load', actionKey: 'stamp.load', figure: { count: 6 } });
  });

  it('지연 반납(김영희, 12:00 매장): 처리 현황 · 일정 줄에 지연의 기준 시각, 받을 금액이 없는 팀에는 수납 조건이 없다', async () => {
    const { client } = setup();
    const slip = await client.query('orderSlip', { orderId: 'o27' });
    expect(slip.checklist.find((c) => c.stepKey === 'return')?.lateAt).toBe(at(12, 30));
    expect(slip.promises.lines.find((l) => l.kind === 'return')?.lateAt).toBe(at(12, 30));
    const paid = await client.query('orderSlip', { orderId: 'o21' });
    expect(paid.activeConditions).not.toContain('has_due');
    expect(paid.activeConditions).toContain('has_items_out');
  });

  it('대납하는 팀(이정호): 미수는 이 팀 몫, 받을 금액은 합', async () => {
    const { client } = setup();
    const slip = await client.query('orderSlip', { orderId: 'o32' });
    expect(slip.money).toMatchObject({ due: 90_000, collectForOthers: 60_000, collectTotal: 150_000 });
  });

  it('없는 접수는 NOT_FOUND로 거절한다(연결 문제와 가른다)', async () => {
    const { client } = setup();
    await expect(client.query('orderSlip', { orderId: 'nope' })).rejects.toMatchObject({ name: 'DomainError', code: 'NOT_FOUND' });
  });
});

describe('확인 창 → 명령 → 도장', () => {
  it('지급 처리: 초안이 잔여 수를 모두 담고(안내 문장 없음), 보내면 도장에 처리 시각이 붙고, 다음 처리가 수납이 된다', async () => {
    const { client, pass } = setup();
    const view = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' });
    expect(view.title).toBe('지급 처리 · 박준호 팀');
    // 첫 매장은 권 보증금이 없어 지급 창에 보증금 줄 · 이어 보낼 명령이 없다(번호 · 보증금 매장은 v2-core.test.ts).
    expect(view.summary).toEqual(['스키 2 · 보드 1 · 헬멧 3 · 야간권 성인 3매']);
    expect(view.confirmLabel).toBe('지급 처리 · 6개 · 3매');
    expect(view.quantity).toBeUndefined();
    expect(view.then).toBeUndefined();
    expect(view.command).toEqual({ type: 'stock.issue', payload: { orderId: 'o22', lines: [
      { lineId: 'o22-l1', quantity: 2 }, { lineId: 'o22-l2', quantity: 1 }, { lineId: 'o22-l3', quantity: 3 }, { lineId: 'o22-l4', quantity: 3 },
    ] } });
    pass(2 * 60_000);
    let changes = 0;
    client.subscribe(() => { changes += 1; });
    const { envelope, outcome } = await confirmAndSend(client, view);
    expect(outcome).toMatchObject({ outcome: 'applied', rev: view.basis.rev + 1, asOfRev: view.basis.rev, rebased: false });
    expect(envelope.basis).toEqual(view.basis);
    expect(changes).toBe(1);
    const r = row(await client.ledgerView('day_ledger', {}), 'o22');
    expect(stamp(r, 'stamp:issue')).toEqual({ stepKey: 'issue', state: 'done', at: at(15, 42) });
    expect(stamp(r, 'stamp:return')).toMatchObject({ state: 'delegated' });
    expect((await client.query('orderSlip', { orderId: 'o22' })).lines[3]!.cells['stamp:return']).toMatchObject({ stamp: { state: 'delegated', delegatedTo: '1호 차량' } });
    expect(r.dueAt).toBe(at(22, 0));
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.nextStep).toEqual({ stepKey: 'pay', actionKey: 'stamp.pay', figure: { amount: 120_000 } });
    // 지급한 뒤에는 조기 반납의 조건이 생긴다.
    expect(slip.activeConditions).toContain('has_items_out');
    // 같은 요청번호로 다시 보내면(두 번 누르기 · 처리 중에 또 누르기) 다시 하지 않고 처음 결과.
    const again = await client.command(envelope);
    expect(again).toEqual(outcome);
    expect(changes).toBe(1);
  });

  it('한 줄 도장: 수량 −/+로 부분 지급하면 칸은 부분(개수)', async () => {
    const { client } = setup();
    const view = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue', lineIds: ['o22-l1'] });
    expect(view.quantity).toEqual({ value: 2, min: 1, max: 2, unit: '개' });
    expect(view.summary).toEqual(['스키 · 잔여 2개']);
    expect(view.confirmLabel).toBe('지급 처리');
    await confirmAndSend(client, view, { qty: 1 });
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.lines[0]!.cells['stamp:issue']).toMatchObject({ stamp: { state: 'partial', progress: { done: 1, total: 2 } } });
    const r = row(await client.ledgerView('day_ledger', {}), 'o22');
    expect(stamp(r, 'stamp:issue')).toMatchObject({ state: 'partial', progress: { done: 1, total: 9 } });
  });

  it('수납: 이정호 팀이 이서연 팀 몫까지 한 번에 내면 두 팀 모두 미수 0, 수단은 창에서 선택', async () => {
    const { client } = setup();
    const view = await client.query('confirmDraft', { orderId: 'o32', actionKey: 'stamp.pay' });
    expect(view.summary).toEqual(['미수 90,000원', '이서연 팀분 대납 60,000원', '받을 금액 150,000원']);
    expect(view.methods?.map((m) => m.label)).toEqual(['카드', '현금', '계좌이체']);
    expect(view.expect).toEqual({ dueAmount: 150_000 });
    const { envelope, outcome } = await confirmAndSend(client, view, { method: 'cash' });
    // 창을 연 때 본 받을 돈이 봉투에 실려 간다(sync 4-2).
    expect(envelope.expect).toEqual({ dueAmount: 150_000 });
    expect(envelope.type === 'payment.take' && envelope.payload.methodKey).toBe('cash');
    expect(outcome.outcome).toBe('applied');
    const ledger = await client.ledgerView('day_ledger', {});
    expect(stamp(row(ledger, 'o32'), 'stamp:pay')).toMatchObject({ state: 'done' });
    expect(stamp(row(ledger, 'o36'), 'stamp:pay')).toMatchObject({ state: 'done' });
    expect(money(row(ledger, 'o36')).alts).toEqual(['수납 완료']);
  });

  it('돈이 그사이 바뀌면 충돌, expect 없는 돈 명령은 거절, 받을 금액이 없으면 창 대신 한 줄', async () => {
    const { client } = setup();
    const view = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'pay' });
    // 창을 연 뒤 다른 카운터가 이 팀 돈을 일부 받았다: 이 창의 expect(120,000원)는 이제 맞지 않다.
    const opened = openOrRestoreDraft(null, view.command!, view.basis, draftOptions(view));
    const other = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'pay' });
    await confirmAndSend(client, { ...other, command: { type: 'payment.take', payload: { orderIds: ['o22'], amount: 20_000, methodKey: 'cash' } }, expect: { dueAmount: 120_000 } });
    const late = await client.command(confirmEnvelope(opened, view.command!, null, null));
    expect(late.outcome).toBe('conflict');
    expect(late.error).toEqual({ code: 'DUE_CHANGED', message: '받을 금액 변경됨 · 재시도 필요' });
    // 받을 돈을 확인하지 않은 돈 명령(expect 없음)은 적용하지 않는다.
    const bare = await client.command(plainEnvelope(view.command!, (await client.ledgerView('day_ledger', {})).basis));
    expect(bare.outcome).toBe('rejected');
    expect(bare.error?.code).toBe('EXPECT_REQUIRED');
    const paid = await client.query('confirmDraft', { orderId: 'o21', actionKey: 'pay' });
    expect(paid.command).toBeUndefined();
    expect(paid.notice).toBe('받을 금액 없음');
  });

  it('적재 처리 뒤 차량 배달 팀의 지급 칸은 보라 차량 17:00', async () => {
    const { client } = setup();
    const view = await client.query('confirmDraft', { orderId: 'o26', actionKey: 'stamp.load' });
    expect(view.command).toMatchObject({ type: 'stock.load', payload: { taskId: 'deliver:o26' } });
    await confirmAndSend(client, view);
    const r = row(await client.ledgerView('day_ledger', {}), 'o26');
    expect(stamp(r, 'stamp:issue')).toMatchObject({ stepKey: 'issue', state: 'delegated', at: at(17, 0), delegatedTo: '1호 차량' });
    expect(stamp(r, 'stamp:issue').pressNote).toEqual({ lines: ['1호 차량 배달 예정 · 17:00'], action: { actionKey: 'stamp.issue', label: '매장 지급 처리' } });
  });

  it('초기화 뒤 옛 창의 명령은 거절(epoch)', async () => {
    const { client } = setup();
    const view = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' });
    client.reset();
    const { outcome } = await confirmAndSend(client, view);
    expect(outcome.outcome).toBe('conflict');
    expect(outcome.error).toEqual({ code: 'EPOCH_CHANGED', message: '체험 자료 초기화됨 · 재시도 필요' });
  });
});

describe('찾기 · 저장 · 체험 시계', () => {
  it('끝 4자리 찾기', async () => {
    const { client } = setup();
    expect((await client.query('findLast4', { last4: '0022' })).matches).toEqual([
      expect.objectContaining({ orderId: 'o22', teamName: '박준호', last4: '0022' }),
    ]);
    expect((await client.query('findLast4', { last4: '9999' })).matches).toEqual([]);
  });

  it('저장소에 남고 다른 창(새 클라이언트)이 이어서 읽는다. 초기화하면 15:40 체험 자료', async () => {
    const storage = new MemoryStorage();
    const first = setup(storage);
    await confirmAndSend(first.client, await first.client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' }));
    first.pass(5 * 60_000);
    first.client.persist();
    const second = setup(storage);
    const ledger = await second.client.ledgerView('day_ledger', {});
    expect(stamp(row(ledger, 'o22'), 'stamp:issue').state).toBe('done');
    expect(ledger.serverTime).toBe(at(15, 45));
    second.client.reset();
    const fresh = await second.client.ledgerView('day_ledger', {});
    expect(stamp(row(fresh, 'o22'), 'stamp:issue').state).toBe('todo');
    expect(fresh.serverTime).toBe(at(15, 40));
  });

  it('매장 목록(registry)이 없는 옛 저장(도메인 패키지 전의 판 3)도 이어서 읽고, 목록은 늘 지금 견본 값이다', async () => {
    const storage = new MemoryStorage();
    const first = setup(storage);
    await confirmAndSend(first.client, await first.client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' }));
    first.client.persist();
    const saved = JSON.parse(storage.getItem('skinote.demo.v1')!) as { state: Record<string, unknown> };
    delete saved.state['registry'];
    storage.setItem('skinote.demo.v1', JSON.stringify(saved));
    const second = setup(storage);
    const ledger = await second.client.ledgerView('day_ledger', {});
    expect(stamp(row(ledger, 'o22'), 'stamp:issue').state).toBe('done');
    const list = await second.client.ledgerView('collection_list', { vehicleId: 'v1' });
    expect(list.vehicle?.label).toBe('1호 차량');
    expect(second.client.previewStaff()).toHaveLength(3);
    // 기기 선택 미리 보기의 차량(체험 매장의 차량: id와 이름만).
    expect(second.client.previewVehicles()).toEqual([{ id: 'v1', name: '1호 차량' }, { id: 'v2', name: '2호 차량' }]);
  });

  it('저장소가 막히거나 망가져도 처음 자료로 돈다', async () => {
    const broken = new MemoryStorage();
    broken.setItem('skinote.demo.v1', '{망가짐');
    expect((await setup(broken).client.ledgerView('day_ledger', {})).rows).toHaveLength(18);
    // 옛 판(version 1)으로 저장된 체험 자료는 버리고 처음 자료로 시작한다.
    broken.setItem('skinote.demo.v1', JSON.stringify({ version: 1, state: { version: 1, orders: [] }, clock: 0 }));
    const { client } = setup(broken);
    expect((await client.ledgerView('day_ledger', {})).rows).toHaveLength(18);
    const blocked: FixtureStorage = { getItem: () => { throw new Error('막힘'); }, setItem: () => { throw new Error('막힘'); }, removeItem: () => {} };
    expect((await setup(blocked).client.ledgerView('day_ledger', {})).rows).toHaveLength(18);
  });

  it('시계를 앞으로: 21:10부터 야간 수거 준비 안내(차량 수거가 있는 마지막 타임 22:00, 그 수거가 늦음이 되는 23:30 전까지), 심야 24:00 뒤에는 주 버튼 조건이 마지막 반납 타임 뒤', async () => {
    const { client } = setup();
    client.advanceClock(5 * 60 + 30);
    const prep = await client.ledgerView('day_ledger', {});
    expect(prep.serverTime).toBe(at(21, 10));
    expect(prep.nightPrep).toEqual({ slotAt: at(22, 0), placeLabel: '설천 주차장', teams: 8 });
    client.advanceClock(60);
    const collecting = await client.ledgerView('day_ledger', {});
    // 마지막 반납 타임은 심야 24:00(운영 규칙의 반납 타임): 22:10에는 아직 마감 전.
    expect(collecting.activeConditions).toEqual(['before_last_return_slot']);
    // 22:00 뒤에도 밤 수거가 이어지는 동안(첫 매장 야간 90분, 2026-09-26 답 15) 안내가 남는다: 카운터가 22:00 ~ 23:30에 밤 일을 본다.
    expect(collecting.nightPrep).toEqual({ slotAt: at(22, 0), placeLabel: '설천 주차장', teams: 8 });
    client.advanceClock(80);
    const late = await client.ledgerView('day_ledger', {});
    expect(late.serverTime).toBe(at(23, 30));
    expect(late.nightPrep).toBeUndefined();
    client.advanceClock(40);
    const after = await client.ledgerView('day_ledger', {});
    expect(after.serverTime).toBe(at(0, 10, 1));
    // 27일 00:10도 06:00 전이라 26일 영업일 장부다.
    expect(after.currentBusinessDate).toBe('2026-12-26');
    expect(after.activeConditions).toEqual(['after_last_return_slot']);
  });

  it('기사 수거 목록(다음 단계가 쓸 읽기 모델): 반납 타임 묶음, 긴급 한 건', async () => {
    const { client } = setup();
    const list = await client.ledgerView('collection_list', { vehicleId: 'v1' });
    expect(list.groups.map((g) => g.label)).toEqual(['16:30 반납', '21:50 반납', '22:00 반납', '22:10 반납']);
    expect(list.pins).toHaveLength(1);
    expect(list.pins![0]!.parts.map((p) => p.text)).toEqual(['꽃마을 들국화', '오승민 · 0039', '조기 반납']);
  });
});

describe('수거 목록(C3) · 긴급 · 기사 기기 연결', () => {
  const list = (client: FixtureClient, params: Parameters<FixtureClient['ledgerView']>[1] = {}) => client.ledgerView('collection_list', { vehicleId: 'v1', ...params });
  const metric = (result: LedgerViewResult, key: string) => result.metrics.find((m) => m.metricKey === key);
  const ids = (result: LedgerViewResult, group?: string) => result.rows.filter((r) => group === undefined || r.groupKey === group).map((r) => r.id);

  it('읽기 모델: 반납 타임 묶음(짧은 이름), 장소 이름표, 완료 · 전송 대기 · 잔여, 차량 재고는 예비권뿐, 등급 판', async () => {
    const { client } = setup();
    const tablet = await list(client);
    expect(tablet.groups.map((g) => [g.label, g.shortLabel, g.done, g.total])).toEqual([
      ['16:30 반납', '16:30', 0, 2], ['21:50 반납', '21:50', 0, 1], ['22:00 반납', '22:00', 0, 7], ['22:10 반납', '22:10', 0, 1],
    ]);
    const kim = row(tablet, 'collect:o25');
    // 22:00 야간 반납 타임의 차량 수거는 90분 뒤(23:30)부터 늦음(첫 매장 운영 규칙 vehicleLate, 2026-09-26 답 15).
    expect(kim).toMatchObject({ subgroupLabel: '설천 주차장', subgroupShortLabel: '설천', lateAt: at(23, 30), taskId: 'collect:o25', orderId: 'o25' });
    expect(row(tablet, 'collect:o39')).toMatchObject({ subgroupLabel: '꽃마을 들국화', subgroupShortLabel: '들국화' });
    expect(stamp(kim, 'stamp:collect')).toEqual({ stepKey: 'collect', state: 'todo' });
    expect([metric(tablet, 'collected_count'), metric(tablet, 'pending_count'), metric(tablet, 'remaining_count')].map((m) => m && 'value' in m ? m.value : null)).toEqual([0, 0, 11]);
    // 차량 재고(문구 표: 지금 차량에 있는 장비 · 권)는 예비권도 센다. 매장 입고 수(primaryFigure)는 입고할 것(수거한 것)만이라 0.
    expect(metric(tablet, 'vehicle_load')).toEqual({ metricKey: 'vehicle_load', unit: 'items', items: [{ label: '예비권', qty: 6, unit: '매' }] });
    expect(tablet.primaryFigure).toEqual({ count: 0 });
    expect(tablet.tabCounts).toEqual({ all: 11, remaining: 11, collected: 0 });
    const counter = await list(client, { deviceClass: 'pos' });
    expect(counter.deviceClass).toBe('pos');
    expect(counter.titleValues).toEqual({ date: '2026-12-26', vehicle: '1호 차량' });
    expect(Object.keys(row(counter, 'collect:o25').cells)).toEqual(Object.keys(kim.cells));
    const phone = await list(client, { deviceClass: 'driver_phone' });
    expect(ids(phone)).toEqual(ids(tablet));
  });

  it('수거 처리: 확인 창 → stock.collect → 수거 시각 · 차량 재고 · 매장 입고 수, 매장 입고 뒤에는 0', async () => {
    const { client, pass } = setup();
    const view = await client.query('confirmDraft', { orderId: 'o25', taskId: 'collect:o25', actionKey: 'stamp.collect' });
    expect(view.title).toBe('수거 처리 · 김민수 팀');
    expect(view.confirmLabel).toBe('수거 처리 · 6개');
    expect(view.summary).toEqual(['스키 4 · 헬멧 2']);
    expect(view.command).toEqual({ type: 'stock.collect', payload: { taskId: 'collect:o25', lines: [{ lineId: 'o25-l1', quantity: 4 }, { lineId: 'o25-l2', quantity: 2 }] } });
    pass(60_000);
    expect((await confirmAndSend(client, view)).outcome.outcome).toBe('applied');
    const after = await list(client);
    expect(stamp(row(after, 'collect:o25'), 'stamp:collect')).toEqual({ stepKey: 'collect', state: 'done', at: at(15, 41) });
    expect(row(after, 'collect:o25').lateAt).toBeUndefined();
    expect(metric(after, 'vehicle_load')).toMatchObject({ items: [{ label: '스키', qty: 4 }, { label: '헬멧', qty: 2 }, { label: '예비권', qty: 6, unit: '매' }] });
    expect(after.primaryFigure).toEqual({ count: 6 });
    expect(after.groups.find((g) => g.key === 's2200')).toMatchObject({ done: 1, total: 7 });
    expect(after.vehicleLoad?.byTask).toEqual([{ taskId: 'collect:o25', teamName: '김민수', last4: '0025', items: [{ label: '스키', qty: 4 }, { label: '헬멧', qty: 2 }] }]);
    const again = await client.query('confirmDraft', { taskId: 'collect:o25', actionKey: 'stamp.collect' });
    expect(again.notice).toBe('수거 완료');
    const receive = await client.query('confirmDraft', { actionKey: 'receive_to_shop', vehicleId: 'v1' });
    expect(receive).toMatchObject({ title: '매장 입고 · 1호 차량', summary: ['1팀 · 스키 4 · 헬멧 2'], confirmLabel: '매장 입고 · 6개', command: { type: 'stock.receive', payload: { vehicleId: 'v1', taskIds: ['collect:o25'] } } });
    await confirmAndSend(client, receive);
    const received = await list(client);
    expect(received.primaryFigure).toEqual({ count: 0 });
    expect(metric(received, 'vehicle_load')).toMatchObject({ items: [{ label: '예비권', qty: 6, unit: '매' }] });
    expect((await client.query('confirmDraft', { actionKey: 'receive_to_shop', vehicleId: 'v1' })).notice).toBe('입고 대상 없음');
  });

  it('▲ · ▼ · 맨 위로는 한 반납 타임 안에서만, 시간순 정렬', async () => {
    const { client } = setup();
    const before = await list(client);
    const slot = ids(before, 's2200');
    expect(slot[0]).toBe('collect:o25');
    const send = async (command: ConfirmCommand) => client.command(plainEnvelope(command, (await list(client)).basis));
    expect((await send({ type: 'route.move', payload: { taskId: slot[2]!, anchorTaskId: slot[1]!, position: 'before' } })).outcome).toBe('applied');
    expect(ids(await list(client), 's2200')).toEqual([slot[0], slot[2], slot[1], ...slot.slice(3)]);
    expect((await send({ type: 'route.move', payload: { taskId: slot[6]!, anchorTaskId: slot[0]!, position: 'top' } })).outcome).toBe('applied');
    expect(ids(await list(client), 's2200')[0]).toBe(slot[6]);
    // 다른 반납 타임의 줄을 기준으로는 옮기지 않는다.
    const other = await send({ type: 'route.move', payload: { taskId: slot[0]!, anchorTaskId: 'collect:o21', position: 'before' } });
    expect(other.outcome).toBe('rejected');
    expect(other.error?.message).toBe('이동 불가 · 다른 반납 타임');
    // 시간순 정렬은 목록 전체가 바뀌므로 확인 창을 거친다(서버가 초안을 준다).
    const reset = await client.query('confirmDraft', { actionKey: 'route_reset', vehicleId: 'v1' });
    expect(reset).toMatchObject({ title: '시간순 정렬 · 1호 차량', summary: ['수동 순서 삭제 · 시간순 정렬', '긴급 줄 맨 위 유지'], confirmLabel: '시간순 정렬', command: { type: 'route.reset', payload: { vehicleId: 'v1', date: '2026-12-26' } } });
    expect((await confirmAndSend(client, reset)).outcome.outcome).toBe('applied');
    expect(ids(await list(client), 's2200')).toEqual(slot);
    expect((await client.query('confirmDraft', { actionKey: 'route_reset', vehicleId: 'v1' })).notice).toBe('이미 시간순');
  });

  it('긴급 요청(카운터 → 기사): 확인 창 → 맨 위 고정 · 두 번은 이미 됨 · 기사 확인 · 수거하면 사라짐', async () => {
    const { client } = setup();
    const slip = await client.query('orderSlip', { orderId: 'o31' });
    expect(slip.activeConditions).toContain('has_open_tasks');
    expect((await client.query('orderSlip', { orderId: 'o22' })).activeConditions).not.toContain('has_open_tasks');
    const view = await client.query('confirmDraft', { orderId: 'o31', actionKey: 'pin' });
    expect(view).toMatchObject({ title: '긴급 요청 · 서지훈 팀', confirmLabel: '긴급 요청', command: { type: 'task.pin', payload: { taskId: 'collect:o31' } } });
    // 반납 일정에 메모가 없으면 긴급 줄에도 메모가 없다(뜻 없는 기본 글을 넣지 않음).
    expect(view.command?.type === 'task.pin' ? view.command.payload.note : 'x').toBeUndefined();
    expect(view.summary[0]).toBe('22:00 설천 주차장 · 서지훈 · 0031');
    expect(view.summary[1]).toBe('1호 차량 수거 목록 맨 위 고정 · 기사 알림');
    await confirmAndSend(client, view);
    const pinned = await list(client);
    expect(pinned.pins?.map((p) => [p.taskId, p.status])).toEqual([['collect:o39', 'requested'], ['collect:o31', 'requested']]);
    expect(ids(pinned, 's2200')[0]).toBe('collect:o31');
    expect((await client.query('orderSlip', { orderId: 'o31' })).promises.lines[1]!.parts.map((p) => p.text)).toContain('긴급 요청');
    expect((await client.query('confirmDraft', { orderId: 'o31', actionKey: 'pin' })).notice).toBe('긴급 요청 · 기사 확인 대기');
    const twice = await client.command(plainEnvelope({ type: 'task.pin', payload: { taskId: 'collect:o31' } }, pinned.basis));
    expect(twice).toMatchObject({ outcome: 'superseded', error: { message: '긴급 요청 완료' } });
    expect((await client.query('confirmDraft', { orderId: 'o28', actionKey: 'pin' })).notice).toBe('내일 09:00 수거 · 오늘 목록 제외');
    const pin = pinned.pins!.find((p) => p.taskId === 'collect:o31')!;
    await client.command(plainEnvelope({ type: 'notification.ack', payload: { notificationId: pin.pinId } }, pinned.basis));
    expect((await list(client)).pins?.find((p) => p.taskId === 'collect:o31')?.status).toBe('acknowledged');
    await confirmAndSend(client, await client.query('confirmDraft', { taskId: 'collect:o31', actionKey: 'stamp.collect' }));
    expect((await list(client)).pins?.map((p) => p.taskId)).toEqual(['collect:o39']);
  });

  it('수거 실패(방문 결과): 내일로 옮기면 오늘 목록에서 빠지고 장부 일정 · 확인 필요에 보인다', async () => {
    const { client } = setup();
    const basis = (await list(client)).basis;
    const retryAt = new Date(kstAt('2026-12-26', 1, 22, 0)).toISOString();
    const outcome = await client.command(plainEnvelope({ type: 'task.visit', payload: { taskId: 'collect:o34', outcomeKey: 'customer_absent', retry: { date: '2026-12-27', at: retryAt } } }, basis));
    expect(outcome.outcome).toBe('applied');
    expect(ids(await list(client))).not.toContain('collect:o34');
    expect(row(await client.ledgerView('day_ledger', {}), 'o34').cells['promise']).toMatchObject({ parts: [{ text: '내일 22:00 설천 주차장' }, { text: '차량' }] });
    expect((await client.query('reviewList', {})).map((r) => r.message)).toContain('한동수 팀 고객 부재 · 재방문 내일 22:00');
    const bad = await client.command(plainEnvelope({ type: 'task.visit', payload: { taskId: 'collect:o35', outcomeKey: 'nope' } }, basis));
    expect(bad.outcome).toBe('rejected');
  });

  it('수거 실패 뒤 오늘 다시 가면: 재방문만 있는 묶음은 재방문, 반납 타임에 섞이면 줄에 재방문', async () => {
    const { client } = setup();
    const basis = (await list(client)).basis;
    const retryAt = new Date(kstAt('2026-12-26', 0, 23, 50)).toISOString();
    await client.command(plainEnvelope({ type: 'task.visit', payload: { taskId: 'collect:o23', outcomeKey: 'customer_absent', retry: { date: '2026-12-26', at: retryAt } } }, basis));
    const after = await list(client);
    expect(after.groups.find((g) => g.key === 's2350')).toMatchObject({ label: '23:50 재방문', shortLabel: '23:50' });
    expect(after.rows.find((r) => r.id === 'collect:o23')?.reviewNote).toBeUndefined();
    expect(after.groups.find((g) => g.key === 's2200')?.label).toBe('22:00 반납');
    // 반납 타임(22:00)으로 다시 가면 묶음은 '22:00 반납' 그대로이고 그 줄에 '재방문'.
    const at22 = new Date(kstAt('2026-12-26', 0, 22, 0)).toISOString();
    await client.command(plainEnvelope({ type: 'task.visit', payload: { taskId: 'collect:o21', outcomeKey: 'customer_absent', retry: { date: '2026-12-26', at: at22 } } }, after.basis));
    const mixed = await list(client);
    expect(mixed.groups.find((g) => g.key === 's2200')?.label).toBe('22:00 반납');
    expect(mixed.rows.find((r) => r.id === 'collect:o21')?.reviewNote).toBe('재방문');
  });

  it('기사 기기 연결 끊김: 수거는 전송 대기(점선 · 전송 대기 수), 카운터에는 안 보이고, 매장 입고는 거절, 재연결하면 보낸다', async () => {
    const { client, pass } = setup();
    client.setDevice('driver');
    client.setOffline(true);
    expect(client.connection()).toEqual({ online: false, pendingCount: 0, lastSyncAt: at(15, 40) });
    pass(2 * 60_000);
    const view = await client.query('confirmDraft', { taskId: 'collect:o25', actionKey: 'stamp.collect' });
    const { envelope, outcome } = await confirmAndSend(client, view);
    expect(outcome.outcome).toBe('queued');
    expect((await client.command(envelope)).outcome).toBe('queued');
    expect(client.connection().pendingCount).toBe(1);
    expect((await client.pending()).map((p) => [p.type, p.state, p.summary])).toEqual([['stock.collect', 'queued', '김민수 · 0025 수거 15:42']]);
    const driver = await list(client);
    expect(stamp(row(driver, 'collect:o25'), 'stamp:collect')).toMatchObject({ stepKey: 'collect', state: 'done', at: at(15, 42), pending: true });
    expect(stamp(row(driver, 'collect:o25'), 'stamp:collect').pressNote?.lines).toEqual(['15:42 처리 · 전송 대기']);
    expect([metric(driver, 'collected_count'), metric(driver, 'pending_count'), metric(driver, 'remaining_count')].map((m) => m && 'value' in m ? m.value : null)).toEqual([0, 1, 10]);
    const receive = await client.query('confirmDraft', { actionKey: 'receive_to_shop', vehicleId: 'v1' });
    expect((await confirmAndSend(client, receive)).outcome).toMatchObject({ outcome: 'rejected', error: { code: 'OFFLINE', message: '연결 끊김 · 연결 후 가능' } });
    client.setDevice('counter');
    expect(stamp(row(await list(client, { deviceClass: 'pos' }), 'collect:o25'), 'stamp:collect').state).toBe('todo');
    expect(client.connection()).toEqual({ online: true, pendingCount: 0 });
    expect(await client.pending()).toEqual([]);
    client.setDevice('driver');
    pass(10 * 60_000);
    client.setOffline(false);
    expect(client.connection()).toEqual({ online: true, pendingCount: 0 });
    const synced = await list(client);
    // 도장 시각은 보낸 때가 아니라 기기에서 확인한 때(15:42).
    expect(stamp(row(synced, 'collect:o25'), 'stamp:collect')).toEqual({ stepKey: 'collect', state: 'done', at: at(15, 42) });
    expect(metric(synced, 'collected_count')).toMatchObject({ value: 1 });
    expect((await client.command(envelope)).outcome).toBe('applied');
  });
});

describe('줄의 능력 · 누를 수 없는 동작 · 도장 알림(서버가 정함)', () => {
  it('수거 목록: 수거 완료 줄의 수거 실패, 묶음 첫 · 끝 줄의 ▲ · ▼, 긴급으로 고정된 줄의 순서는 회색', async () => {
    const { client } = setup();
    const tablet = await client.ledgerView('collection_list', { vehicleId: 'v1' });
    const slot = tablet.rows.filter((r) => r.groupKey === 's2200');
    const off = (r: LedgerRow) => (r.disabledActions ?? []).map((d) => d.actionKey).sort();
    expect(off(slot[0]!)).toEqual(['move_top', 'move_up']);
    expect(off(slot.at(-1)!)).toEqual(['move_down']);
    expect(off(slot[1]!)).toEqual([]);
    expect(off(row(tablet, 'collect:o39'))).toEqual(['move_down', 'move_top', 'move_up']);
    expect(row(tablet, 'collect:o39').disabledActions?.[0]?.reason).toBe('긴급 고정 · 이동 불가');
    expect(row(tablet, 'collect:o25').conditions).toEqual(expect.arrayContaining(['vehicle_return', 'has_open_tasks', 'has_items_out']));
    expect(tablet.visitReasons?.map((r) => r.label)).toEqual(['고객 부재', '장소 변경', '물품 미준비']);
    await confirmAndSend(client, await client.query('confirmDraft', { taskId: 'collect:o25', actionKey: 'stamp.collect' }));
    const after = await client.ledgerView('collection_list', { vehicleId: 'v1' });
    expect(row(after, 'collect:o25').disabledActions).toContainEqual({ actionKey: 'not_collected', reason: '수거 완료' });
  });

  it('카운터(포스 판)의 수거 도장은 기사가 찍는다: 창 대신 한 줄과 접수증', async () => {
    const { client } = setup();
    const counter = await client.ledgerView('collection_list', { vehicleId: 'v1', deviceClass: 'pos' });
    expect(stamp(row(counter, 'collect:o25'), 'stamp:collect')).toMatchObject({
      state: 'todo',
      pressNote: {
        lines: ['1호 차량 수거 예정'],
        action: { actionKey: 'open_slip', label: '접수증' },
      },
    });
    const driver = await client.ledgerView('collection_list', { vehicleId: 'v1', deviceClass: 'driver_tablet' });
    expect(stamp(row(driver, 'collect:o25'), 'stamp:collect').pressNote).toBeUndefined();
  });
});

describe('설정에 칸을 더하면 코드를 고치지 않아도 나온다(ui 3-4 · 7절)', () => {
  const state = () => createSeed('e');
  /** 기본 설정에 칸을 더한 설정(발권 도장 칸 · 장소 칸 · 규격 글 칸). */
  function withExtraColumns(): UiConfig {
    const config = structuredClone(defaultUiConfig({ features: { lift_tickets: true } }));
    const ledger = config.ledgerViews.find((v) => v.key === 'day_ledger')!;
    const base = ledger.columns.find((c) => c.column_key === 'stamp:pay')!;
    const promise = ledger.columns.find((c) => c.column_key === 'promise')!;
    ledger.columns.push(
      { ...base, column_key: 'stamp:ticket', seq: 85, header_label: '발권', step_keys: ['ticket_secure'] },
      { ...promise, column_key: 'place', seq: 45, header_label: '장소', renderer_key: 'place' },
    );
    const slip = config.ledgerViews.find((v) => v.key === 'order_slip')!;
    const qty = slip.columns.find((c) => c.column_key === 'qty')!;
    slip.columns.push({ ...qty, column_key: 'size', seq: 25, header_label: '규격' });
    return config;
  }

  it('발권 도장 칸(규칙 ticket_secured)은 리프트권이 있는 팀에만 미처리, 장소 칸은 긴 이름과 짧은 이름', () => {
    const ctx = { state: state(), config: withExtraColumns(), now: DEMO_START_MS };
    const ledger = dayLedger(ctx, {});
    expect(stamp(row(ledger, 'o22'), 'stamp:ticket')).toEqual({ stepKey: 'ticket_secure', state: 'todo' });
    expect(stamp(row(ledger, 'o21'), 'stamp:ticket')).toEqual({ stepKey: 'ticket_secure', state: 'na' });
    expect(row(ledger, 'o39').cells['place']).toEqual({ renderer: 'place', parts: [{ text: '꽃마을 들국화', short: '들국화', drop: 0, words: true }] });
    expect(row(ledger, 'o27').cells['place']).toEqual({ renderer: 'place', parts: [{ text: '매장', drop: 0 }] });
  });

  it('접수증에 뜻을 모르는 글 칸(규격)을 더하면 빈칸이다(다른 칸의 값을 짐작해 넣지 않는다)', () => {
    const ctx = { state: state(), config: withExtraColumns(), now: DEMO_START_MS };
    const slip = orderSlip(ctx, 'o22')!;
    expect(slip.lines[0]!.cells['size']).toBeUndefined();
    expect(slip.lines[0]!.cells['qty']).toEqual({ renderer: 'text', parts: [{ text: '2', drop: 0 }] });
  });

  it('수거 목록에 반납 도장 칸을 더하면 수거가 아니라 반납 규칙으로 채운다', () => {
    const config = structuredClone(defaultUiConfig());
    const tablet = config.ledgerViews.find((v) => v.key === 'collection_list' && v.device_class_key === 'driver_tablet')!;
    const collect = tablet.columns[0]!;
    tablet.columns.push({ ...collect, column_key: 'stamp:return', seq: 15, header_label: '반납', step_keys: ['return'], min_width_em: 4, preferred_width_em: 4 });
    const list = collectionList({ state: state(), config, now: DEMO_START_MS }, { vehicleId: 'v1' });
    expect(stamp(row(list, 'collect:o25'), 'stamp:return')).toMatchObject({ stepKey: 'return', state: 'delegated' });
    expect(stamp(row(list, 'collect:o25'), 'stamp:collect')).toEqual({ stepKey: 'collect', state: 'todo' });
    expect(uiDefaults.rev).toBeGreaterThan(1);
  });
});

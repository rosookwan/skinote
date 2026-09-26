// 둘째 판 2단계(work/impl-v2/plan.md 5절 Step 2): V9 일정 변경 · 부분 품목(spec 3-2). 줄 수량 일부를 새 반납 일정으로 떼어 내고
// (promise.change), 차량 업무가 일정마다 생기며(collect:o22 · collect:o22:p1), 접수증 일정 줄 · 처리 현황 · 수거 목록이 나뉜 일정을
// 보인다. 창의 읽기 모델(promiseSheet)은 고른 것(수량 · 반납 타임 · 날 · 장소 · 차량)을 인자로 다시 물으면 줄 글 · 요약 · 주 버튼 · 명령을
// 새로 쓴다. 뒷이야기 19:41(박준호 팀 일정 변경).
import {
  draftToEnvelope, openCommandDraft, type CommandOutcome, type ConfirmCommand, type Expect, type PromiseSheetParams, type PromiseSheetView,
  type RichText,
} from '@skinote/contract';
import { openOrRestoreDraft } from '@skinote/ui';
import { describe, expect, it } from 'vitest';
import { promiseEnvelope, withDay, withPlace, withQuantity, withSlot, withVehicle } from '../src/components/PromiseDialog.tsx';
import { charged, findTask, type FxState, heldNumbers, kstAt, lineBuckets, orderTasks } from '@skinote/domain';
import { applyCommand } from '../src/fixture/demo.ts';
import { FixtureClient } from '../src/fixture/fixture-client.ts';
import { promiseEntry } from '../src/screens/OrderSlipScreen.tsx';

const ms = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const iso = (h: number, m: number, day = 0) => new Date(ms(h, m, day)).toISOString();
const text = (runs: RichText) => runs.map((r) => r.text).join('');

/** 19:40(V9 시안의 순간): 뒷이야기를 켜고 체험 시계를 4시간 앞으로(16:05 박준호 지급 · 보증금 …, 19:41 일정 변경은 아직). */
function at1940() {
  let real = 1_800_000_000_000;
  const client = new FixtureClient({ realNow: () => real, story: true });
  client.advanceClock(240);
  const state = () => (client as unknown as { state: FxState }).state;
  return { client, state, pass: (minutes: number) => { real += minutes * 60_000; } };
}

/** 시안 V9의 고른 것: 보드 1 · 헬멧 1 · 권 1매 → 솔마을 두솔동. */
const DRAWN: PromiseSheetParams = {
  orderId: 'o22', quantities: { 'o22-l2': 1, 'o22-l3': 1, 'o22-l4': 1 }, place: { mode: 'vehicle', placeKey: 'dusol' },
};

/** 화면과 같은 길: 창을 연 때의 초안(요청번호 · basis) → 확정할 때 서버가 준 명령과 견적으로 봉투. */
async function confirm(client: FixtureClient, opened: PromiseSheetView, view: PromiseSheetView): Promise<CommandOutcome> {
  const draft = openOrRestoreDraft(null, { type: 'promise.change', payload: { orderId: 'o22', kind: 'return', lines: [], promise: { mode: 'store' } } }, opened.basis);
  const envelope = promiseEnvelope(draft, view);
  if (!envelope) throw new Error('보낼 명령이 없다');
  return client.command(envelope);
}

function send(state: FxState, command: ConfirmCommand, extra: { expect?: Expect } = {}, now = ms(19, 45)): CommandOutcome {
  return applyCommand(state, draftToEnvelope(openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, extra)), now);
}

const change = (lines: [string, number][], promise: Extract<ConfirmCommand, { type: 'promise.change' }>['payload']['promise']): ConfirmCommand => ({
  type: 'promise.change', payload: { orderId: 'o22', kind: 'return', lines: lines.map(([lineId, quantity]) => ({ lineId, quantity })), promise },
});
const DUSOL = { mode: 'vehicle', slot: { day: 'today', slotKey: 'night' }, placeKey: 'dusol', vehicleId: 'v1' } as const;

describe('V9 창의 읽기 모델(promiseSheet) — 19:40 박준호 팀', () => {
  it('처음 연 상태: 수량 모두 0, 지금 일정(야간 22:00 · 설천 주차장 · 1호 차량), 지난 반납 타임은 누를 수 없음, 주 버튼 일정 변경(누를 수 없음)', async () => {
    const { client } = at1940();
    const view = await client.query('promiseSheet', { orderId: 'o22' });
    expect(view.title).toBe('일정 변경 · 박준호 팀');
    expect(view.lines.map((l) => [l.label, l.note, l.quantity.value + l.quantity.unit, l.quantity.max])).toEqual([
      ['스키', '대여 2대', '0대', 2], ['보드', '대여 1대', '0대', 1], ['헬멧', '대여 3개', '0개', 3], ['야간권 성인', '대여 3매', '0매', 3],
    ]);
    expect(view.slots.map((s) => [s.label, s.selected, s.enabled, s.reason ?? '', s.short])).toEqual([
      ['오전타임 후 12:00', false, false, '선택 불가 · 시간 지남', '12:00'],
      ['오후 16:30', false, false, '선택 불가 · 시간 지남', '16:30'],
      ['야간 22:00', true, true, '', '22:00'],
      ['심야 24:00', false, true, '', '24:00'],
    ]);
    expect(view.days.map((d) => [d.label, d.selected, d.opens ?? false])).toEqual([['내일', false, false], ['다른 날', false, true]]);
    expect(view.calendar.map((d) => d.label)).toEqual(['모레', '12월 29일', '12월 30일', '12월 31일', '1월 1일', '1월 2일']);
    expect(view.areas.map((a) => a.label)).toEqual(['설천', '만선', '솔마을', '꽃마을']);
    expect(view.place).toEqual({ mode: 'vehicle', placeKey: 'seolcheon_parking' });
    expect(view.vehicles.map((v) => [v.label, v.selected])).toEqual([['1호 차량', true], ['2호 차량', false]]);
    expect(view.vehicleRowVisible).toBe(true);
    expect(text(view.summary.changed)).toBe('없음');
    expect(text(view.summary.kept)).toBe('스키 2 · 보드 1 · 헬멧 3 · 권 3매: 22:00 설천 주차장 · 1호 차량');
    expect(view.primary).toEqual({ label: '일정 변경', alts: ['일정 변경'], enabled: false });
    expect(view.command).toBeUndefined();
  });

  it('시안의 그린 상태: 보드 1 · 헬멧 1 · 권 1매 → 22:00 솔마을 두솔동(바뀐 뒤만 굵게), 주 버튼 일정 변경 · 보드 1 · 헬멧 1 · 권 1매', async () => {
    const { client } = at1940();
    const view = await client.query('promiseSheet', DRAWN);
    expect(view.lines.map((l) => l.quantity.value)).toEqual([0, 1, 1, 1]);
    expect(view.summary.changed).toEqual([
      { text: '보드 1 · 헬멧 1 · 권 1매: 22:00 설천 주차장 → ' }, { text: '22:00 솔마을 두솔동', strong: true }, { text: ' · 1호 차량' },
    ]);
    expect(text(view.summary.kept)).toBe('스키 2 · 헬멧 2 · 권 2매: 22:00 설천 주차장 · 1호 차량');
    expect(view.primary).toEqual({ label: '일정 변경 · 보드 1 · 헬멧 1 · 권 1매', alts: ['일정 변경 · 보드 1 · 헬멧 1 · 권 1매', '일정 변경 · 2개 · 1매', '일정 변경'], enabled: true });
    expect(view.command).toEqual({
      type: 'promise.change',
      payload: {
        orderId: 'o22', kind: 'return',
        lines: [{ lineId: 'o22-l2', quantity: 1 }, { lineId: 'o22-l3', quantity: 1 }, { lineId: 'o22-l4', quantity: 1 }],
        promise: DUSOL,
      },
    });
    expect(view.expect).toBeUndefined();
  });

  it('#store: 매장 직접이면 수거 차량 줄은 자리만(차량 없음), 요약은 22:00 매장 직접 반납', async () => {
    const { client } = at1940();
    const view = await client.query('promiseSheet', { ...DRAWN, place: { mode: 'store' } });
    expect(view.vehicleRowVisible).toBe(false);
    expect(view.vehicles.every((v) => !v.selected)).toBe(true);
    expect(text(view.summary.changed)).toBe('보드 1 · 헬멧 1 · 권 1매: 22:00 설천 주차장 → 22:00 매장 직접 반납');
    expect(view.summary.changed[1]).toEqual({ text: '22:00 매장 직접 반납', strong: true });
    expect(view.command?.payload).toMatchObject({ promise: { mode: 'store', slot: { day: 'today', slotKey: 'night' } } });
    expect(view.command?.payload).not.toHaveProperty('promise.vehicleId');
  });

  it('내일: 권이 있으면 한 줄(리프트권 당일 한정 · 날짜 변경 불가)과 누를 수 없는 주 버튼, 장비만이면 연장 + 30,000원과 견적', async () => {
    const { client } = at1940();
    const tomorrow = { day: 'tomorrow', slotKey: 'night' } as const;
    const lift = await client.query('promiseSheet', { ...DRAWN, slot: tomorrow });
    expect(lift.notice).toBe('리프트권 당일 한정 · 날짜 변경 불가');
    expect(lift.primary).toMatchObject({ label: '일정 변경', enabled: false });
    expect(lift.command).toBeUndefined();
    // 내일은 모든 반납 타임을 고를 수 있다.
    expect(lift.slots.every((s) => s.enabled)).toBe(true);
    expect(lift.days[0]).toMatchObject({ label: '내일', selected: true });
    const gear = await client.query('promiseSheet', { ...DRAWN, quantities: { 'o22-l2': 1, 'o22-l3': 1 }, slot: tomorrow });
    expect(gear.notice).toBeUndefined();
    expect(text(gear.summary.changed)).toBe('보드 1 · 헬멧 1: 22:00 설천 주차장 → 내일 22:00 솔마을 두솔동 · 1호 차량 · 연장 + 30,000원');
    expect(gear.primary).toMatchObject({ label: '일정 변경 · 보드 1 · 헬멧 1 · 30,000원', enabled: true });
    expect(gear.expect).toEqual({ quoteHash: 'extension:30000' });
    // 다른 날(작은 창의 날짜): 두 줄 버튼 '다른 날' / '12월 29일'.
    const other = await client.query('promiseSheet', { ...DRAWN, quantities: { 'o22-l2': 1 }, slot: { day: '2026-12-29', slotKey: 'night' } });
    expect(other.days[1]).toMatchObject({ label: '다른 날', secondLine: '12월 29일', selected: true });
    expect(text(other.summary.changed)).toContain('12월 29일 22:00 솔마을 두솔동');
    expect(text(other.summary.changed)).toContain('연장 + 75,000원');
  });

  it('반납 타임이 10분 안이면 누를 수 없고(선택 불가 · 10분 이내, 고른 것으로 보이지 않음), 지금 일정이 그 타임이면 주 버튼도 누를 수 없다', async () => {
    const { client, pass } = at1940();
    pass(2 * 60 + 12);
    const view = await client.query('promiseSheet', DRAWN);
    expect(view.slots.find((s) => s.key === 'night')).toMatchObject({ selected: false, enabled: false, reason: '선택 불가 · 10분 이내' });
    expect(view.primary.enabled).toBe(false);
    expect(view.command).toBeUndefined();
  });

  it('모두 돌아온 팀은 창 대신 한 줄(반납 완료)', async () => {
    const { client } = at1940();
    const view = await client.query('promiseSheet', { orderId: 'o24' });
    expect(view.lines).toEqual([]);
    expect(view.notice).toBe('반납 완료');
    await expect(client.query('promiseSheet', { orderId: 'none' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('promise.change — 일정이 품목 · 수량으로 나뉜다', () => {
  it('확정하면: 접수증 일정 줄은 반납 일정 2건, 처리 현황 둘째 줄은 두 장소, 수거 목록은 박준호 팀 두 줄(설천 주차장 · 솔마을 두솔동)', async () => {
    const { client, state } = at1940();
    const opened = await client.query('promiseSheet', { orderId: 'o22' });
    const drawn = await client.query('promiseSheet', DRAWN);
    expect((await confirm(client, opened, drawn)).outcome).toBe('applied');
    expect(state().orders.find((o) => o.id === 'o22')!.splits).toEqual([
      { id: 'p1', lineId: 'o22-l2', quantity: 1, promise: { at: ms(22, 0), mode: 'vehicle', placeId: 'dusol', vehicleId: 'v1' }, at: ms(19, 40) },
      { id: 'p1', lineId: 'o22-l3', quantity: 1, promise: { at: ms(22, 0), mode: 'vehicle', placeId: 'dusol', vehicleId: 'v1' }, at: ms(19, 40) },
      { id: 'p1', lineId: 'o22-l4', quantity: 1, promise: { at: ms(22, 0), mode: 'vehicle', placeId: 'dusol', vehicleId: 'v1' }, at: ms(19, 40) },
    ]);
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.promises).toMatchObject({ distinct: 2, lines: [{ kind: 'pickup' }, { kind: 'return', count: 2, at: iso(22, 0) }] });
    const back = slip.checklist.find((c) => c.stepKey === 'return')!;
    expect(back.parts.map((p) => p.text)).toEqual(['반납', '오늘 22:00']);
    expect(back.second?.map((p) => p.text)).toEqual(['설천 주차장', '솔마을 두솔동']);
    // 모든 줄의 반납은 여전히 차량 담당(22:00).
    expect(slip.lines.map((l) => (l.cells['stamp:return']?.renderer === 'stamp' ? l.cells['stamp:return'].stamp.state : null))).toEqual(Array(4).fill('delegated'));
    const list = await client.ledgerView('collection_list', { vehicleId: 'v1' });
    const main = list.rows.find((r) => r.id === 'collect:o22')!;
    const dusol = list.rows.find((r) => r.id === 'collect:o22:p1')!;
    expect(main).toMatchObject({ orderId: 'o22', subgroupLabel: '설천 주차장', groupKey: 's2200' });
    expect(main.cells['items']).toMatchObject({ items: [{ label: '스키', qty: 2 }, { label: '헬멧', qty: 2 }, { label: '야간권', qty: 2, unit: '매' }] });
    expect(dusol).toMatchObject({ orderId: 'o22', subgroupLabel: '솔마을 두솔동', groupKey: 's2200', taskId: 'collect:o22:p1' });
    expect(dusol.cells['items']).toMatchObject({ items: [{ label: '보드', qty: 1 }, { label: '헬멧', qty: 1 }, { label: '야간권', qty: 1, unit: '매' }] });
    // 같은 접수의 두 업무는 원래 일정 먼저.
    expect(list.rows.findIndex((r) => r.id === 'collect:o22')).toBeLessThan(list.rows.findIndex((r) => r.id === 'collect:o22:p1'));
    // 다시 열면 줄마다 일정별 수.
    const again = await client.query('promiseSheet', { orderId: 'o22' });
    expect(again.lines.map((l) => l.note)).toEqual(['대여 2대', '대여 1대', '설천 2 · 두솔동 1', '설천 2 · 두솔동 1']);
    expect(again.lines.map((l) => l.quantity.max)).toEqual([2, 1, 3, 3]);
  });

  it('뒷이야기 19:41: 박준호 팀 일정 변경(보드 1 · 헬멧 1 · 권 1매 → 22:00 솔마을 두솔동 · 1호 차량), 사람이 먼저 나눴으면 건너뜀', async () => {
    const { client, state } = at1940();
    client.advanceClock(10);
    expect(state().storyApplied).toContain('park-promise');
    expect(state().orders.find((o) => o.id === 'o22')!.splits?.map((s) => [s.lineId, s.quantity, s.id])).toEqual([['o22-l2', 1, 'p1'], ['o22-l3', 1, 'p1'], ['o22-l4', 1, 'p1']]);
    expect(state().outcomes['story:park-promise:0']?.outcome).toBe('applied');
    const tasks = orderTasks(state().orders.find((o) => o.id === 'o22')!).map((t) => t.id);
    expect(tasks).toEqual(['collect:o22', 'collect:o22:p1']);
    // 사람이 먼저 한 경우: 19:40에 창에서 스키 1을 매장 직접으로 → 19:41 사건은 없음.
    const other = at1940();
    const view = await other.client.query('promiseSheet', { orderId: 'o22', quantities: { 'o22-l1': 1 }, place: { mode: 'store' } });
    expect((await confirm(other.client, view, view)).outcome).toBe('applied');
    other.client.advanceClock(10);
    expect(other.state().orders.find((o) => o.id === 'o22')!.splits?.map((s) => [s.lineId, s.quantity])).toEqual([['o22-l1', 1]]);
    expect(other.state().outcomes['story:park-promise:0']).toBeUndefined();
  });

  it('매장 반납은 원래 일정부터 채운다: 21:31 스키 2 · 헬멧 2 · 권 2매가 오면 설천 주차장 업무는 매장 반납, 두솔동 업무만 남는다', async () => {
    const { client, state } = at1940();
    client.advanceClock(10);
    const s = state();
    expect(send(s, { type: 'stock.direct_return', payload: { orderId: 'o22', lines: [{ lineId: 'o22-l1', quantity: 2 }, { lineId: 'o22-l3', quantity: 2 }, { lineId: 'o22-l4', quantity: 2 }] } }, {}, ms(21, 31)).outcome).toBe('applied');
    const o = s.orders.find((x) => x.id === 'o22')!;
    expect(lineBuckets(o, o.lines[2]!).map((b) => [b.key, b.planned, b.returned])).toEqual([[null, 2, 2], ['p1', 1, 0]]);
    const list = await client.ledgerView('collection_list', { vehicleId: 'v1' });
    // 설천 주차장 업무는 받을 것이 없어져 수거 목록 · 완료 수에서 빠진다(data-model 4-18 · spec 3-1): `수거` 도장이 차량이 받은 것으로 읽히지 않게.
    expect(list.rows.find((r) => r.id === 'collect:o22')).toBeUndefined();
    expect(list.rows.find((r) => r.id === 'collect:o22:p1')?.cells['stamp:collect']).toMatchObject({ stamp: { state: 'todo' } });
    // 헬멧 반납은 매장에서 2개(첫 매장은 번호 없이 수), 남은 1개는 두솔동.
    expect(heldNumbers(o.lines[2]!)).toEqual([]);
    expect(o.lines[2]!.issued - o.lines[2]!.returned).toBe(1);
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    // 남은 일정은 하나(두솔동): 일정 줄은 그 일정 그대로.
    expect(slip.promises.lines[1]).toMatchObject({ kind: 'return', parts: [{ text: '솔마을 두솔동' }, { text: '1호 차량' }] });
    expect(slip.promises.lines[1]!.count).toBeUndefined();
    expect(slip.checklist.find((c) => c.stepKey === 'return')?.second?.map((p) => p.text)).toEqual(['솔마을 두솔동', '차량 수거']);
  });

  it('매장 일정으로 나눈 몫을 손님이 매장에 가져오면 그 일정이 채워진다(차량 업무가 받을 수는 그대로): 김민수 스키 1 → 오늘 16:30 매장', () => {
    const client = new FixtureClient({ realNow: () => 1_800_000_000_000 });
    const s = (client as unknown as { state: FxState }).state;
    const toStore: ConfirmCommand = { type: 'promise.change', payload: { orderId: 'o25', kind: 'return', lines: [{ lineId: 'o25-l1', quantity: 1 }], promise: { mode: 'store', slot: { day: 'today', slotKey: 'afternoon' } } } };
    expect(send(s, toStore, {}, ms(15, 40)).outcome).toBe('applied');
    expect(send(s, { type: 'stock.direct_return', payload: { orderId: 'o25', lines: [{ lineId: 'o25-l1', quantity: 1 }] } }, {}, ms(15, 45)).outcome).toBe('applied');
    const o = s.orders.find((x) => x.id === 'o25')!;
    expect(o.splits?.map((x) => [x.id, x.quantity, x.returned])).toEqual([['p1', 1, 1]]);
    expect(lineBuckets(o, o.lines[0]!).map((b) => [b.key, b.promise.mode, b.planned, b.returned])).toEqual([[null, 'vehicle', 3, 0], ['p1', 'store', 1, 1]]);
    // 차량 업무는 스키 3 · 헬멧 2를 그대로 받고, 남은 반납 일정은 22:00 설천 주차장(16:30 매장 일정은 채워짐).
    const task = findTask(s, 'collect:o25')!;
    expect(o.lines.map((l) => lineBuckets(o, l).find((b) => b.key === task.key)!.issued - lineBuckets(o, l).find((b) => b.key === task.key)!.returned)).toEqual([3, 2]);
    expect(orderTasks(o).map((t) => t.id)).toEqual(['collect:o25']);
  });

  it('연장 값은 계약한 날과의 차이만(요금표 1일 값): 스키 2를 내일로 + 80,000원, 다시 오늘로 − 80,000원(연장 취소), 같은 날로 두 번 옮겨도 한 번', () => {
    const client = new FixtureClient({ realNow: () => 1_800_000_000_000 });
    const s = (client as unknown as { state: FxState }).state;
    const o = s.orders.find((x) => x.id === 'o21')!;
    const before = charged(o);
    const move = (day: 'today' | 'tomorrow', slotKey: string, mode: 'store' | 'vehicle', amount: number): CommandOutcome => send(s, {
      type: 'promise.change',
      payload: { orderId: 'o21', kind: 'return', lines: [{ lineId: 'o21-l1', quantity: 2 }], promise: mode === 'store' ? { mode, slot: { day, slotKey } } : { mode, slot: { day, slotKey }, placeKey: 'manseon_plaza', vehicleId: 'v1' } },
    }, amount ? { expect: { quoteHash: 'extension:' + amount } } : {}, ms(15, 40));
    expect(move('tomorrow', 'afternoon', 'vehicle', 80_000).outcome).toBe('applied');
    expect(charged(o)).toBe(before + 80_000);
    expect(move('today', 'night', 'store', -80_000).outcome).toBe('applied');
    expect(charged(o)).toBe(before);
    expect(o.charges?.map((c) => c.amount)).toEqual([80_000, -80_000]);
    expect(o.charges?.map((c) => c.kind)).toEqual(['extension', 'extension_undo']);
  });

  it('차량 수거 · 입고는 그 업무(일정)의 몫만: 두솔동 업무를 받고 매장 입고하면 일정 행에 센다', () => {
    const { state, client } = at1940();
    client.advanceClock(10);
    const s = state();
    const collect: ConfirmCommand = { type: 'stock.collect', payload: { taskId: 'collect:o22:p1', lines: [{ lineId: 'o22-l2', quantity: 1 }, { lineId: 'o22-l3', quantity: 3 }, { lineId: 'o22-l4', quantity: 1 }] } };
    expect(send(s, collect, {}, ms(22, 5)).outcome).toBe('applied');
    const o = s.orders.find((x) => x.id === 'o22')!;
    // 헬멧은 3을 달라 해도 그 일정 몫(1)만.
    expect(o.lines.map((l) => l.collected)).toEqual([0, 1, 1, 1]);
    expect(o.splits?.map((x) => x.collected)).toEqual([1, 1, 1]);
    expect(findTask(s, 'collect:o22')).toBeDefined();
    expect(send(s, { type: 'stock.receive', payload: { vehicleId: 'v1', taskIds: ['collect:o22:p1'] } }, {}, ms(23, 0)).outcome).toBe('applied');
    expect(o.lines.map((l) => l.received)).toEqual([0, 1, 1, 1]);
    expect(o.splits?.map((x) => x.received)).toEqual([1, 1, 1]);
  });

  it('일정을 원래 일정으로 되돌리면 나눈 일정이 줄고(0이면 없어짐), 같은 나눈 일정으로 옮기면 더해진다', () => {
    const { state, client } = at1940();
    client.advanceClock(10);
    const s = state();
    expect(send(s, change([['o22-l3', 1]], DUSOL)).outcome).toBe('applied');
    expect(s.orders.find((o) => o.id === 'o22')!.splits?.find((x) => x.lineId === 'o22-l3')?.quantity).toBe(2);
    const back = { mode: 'vehicle', slot: { day: 'today', slotKey: 'night' }, placeKey: 'seolcheon_parking', vehicleId: 'v1' } as const;
    expect(send(s, change([['o22-l2', 1], ['o22-l3', 2], ['o22-l4', 1]], back)).outcome).toBe('applied');
    expect(s.orders.find((o) => o.id === 'o22')!.splits).toEqual([]);
    expect(orderTasks(s.orders.find((o) => o.id === 'o22')!).map((t) => t.id)).toEqual(['collect:o22']);
  });

  it('거절 · 충돌: 권은 다른 날 불가, 지난 반납 타임, 옮길 수보다 많음(수거 완료 · 일정 확인), 연장 견적 없이 날 옮기기', () => {
    const { state } = at1940();
    const s = state();
    const tomorrow = { ...DUSOL, slot: { day: 'tomorrow', slotKey: 'night' } } as const;
    expect(send(s, change([['o22-l4', 1]], tomorrow))).toMatchObject({ outcome: 'rejected', error: { message: '리프트권 당일 한정 · 날짜 변경 불가' } });
    expect(send(s, change([['o22-l2', 1]], { ...DUSOL, slot: { day: 'today', slotKey: 'afternoon' } }))).toMatchObject({ outcome: 'rejected', error: { message: '선택 불가 · 시간 지남' } });
    expect(send(s, change([['o22-l2', 1]], { ...DUSOL, placeKey: 'nowhere' }))).toMatchObject({ outcome: 'rejected', error: { message: '체험판 미지원' } });
    expect(send(s, change([['o22-l2', 1]], tomorrow))).toMatchObject({ outcome: 'conflict', error: { code: 'QUOTE_CHANGED' } });
    // 차량이 스키 2를 받은 뒤 옛 창에서 스키 2를 옮기려 함.
    send(s, { type: 'stock.collect', payload: { taskId: 'collect:o22', lines: [{ lineId: 'o22-l1', quantity: 2 }] } }, {}, ms(19, 50));
    expect(send(s, change([['o22-l1', 2]], DUSOL))).toMatchObject({ outcome: 'conflict', error: { code: 'PROMISE_CHANGED', message: '1호 차량 스키 2 수거 완료 · 일정 확인' } });
    expect(s.orders.find((o) => o.id === 'o22')!.splits ?? []).toEqual([]);
  });

  it('연장: 창이 본 견적(extension:30000)과 같으면 청구 조정으로 남는다(청구 225,000 → 255,000원)', async () => {
    const { client, state } = at1940();
    const params: PromiseSheetParams = { ...DRAWN, quantities: { 'o22-l2': 1, 'o22-l3': 1 }, slot: { day: 'tomorrow', slotKey: 'night' } };
    const view = await client.query('promiseSheet', params);
    expect((await confirm(client, view, view)).outcome).toBe('applied');
    const o = state().orders.find((x) => x.id === 'o22')!;
    expect(o.charges?.map((c) => [c.kind, c.lineId, c.kind === 'extension' ? c.quantity : 0, c.kind === 'extension' ? c.days : 0, c.amount])).toEqual([['extension', 'o22-l2', 1, 1, 25_000], ['extension', 'o22-l3', 1, 1, 5_000]]);
    expect(charged(o)).toBe(255_000);
    expect((await client.query('orderSlip', { orderId: 'o22' })).money).toMatchObject({ charged: 255_000, due: 150_000 });
    // 내일 22:00 일정은 오늘 목록에 없다(오늘 22:00 설천 주차장 업무만).
    const list = await client.ledgerView('collection_list', { vehicleId: 'v1' });
    expect(list.rows.filter((r) => r.orderId === 'o22').map((r) => r.id)).toEqual(['collect:o22']);
  });

  it('긴급 요청 · 순서는 업무(일정)마다: 두솔동 업무를 고정하면 그 줄이 긴급 줄', async () => {
    const { client, state } = at1940();
    client.advanceClock(10);
    const s = state();
    expect(send(s, { type: 'task.pin', payload: { taskId: 'collect:o22:p1' } }).outcome).toBe('applied');
    const list = await client.ledgerView('collection_list', { vehicleId: 'v1' });
    expect(list.pins?.find((p) => p.orderId === 'o22')).toMatchObject({ taskId: 'collect:o22:p1', parts: [{ text: '솔마을 두솔동' }, { text: '박준호 · 0022' }] });
    const draft = await client.query('confirmDraft', { orderId: 'o22', taskId: 'collect:o22', actionKey: 'pin' });
    expect(draft.command).toMatchObject({ type: 'task.pin', payload: { taskId: 'collect:o22' } });
    const move = send(s, { type: 'route.move', payload: { taskId: 'collect:o22', anchorTaskId: null, position: 'top' } });
    expect(move.outcome).toBe('applied');
  });
});

describe('V9 창의 화면 쪽(고른 것 → 인자, 봉투)', () => {
  const view = (over: Partial<PromiseSheetView> = {}): PromiseSheetView => ({
    basis: { epoch: 'e', rev: 1 }, title: '', lines: [], areas: [], place: { mode: 'store' }, vehicles: [], vehicleRowVisible: false,
    summary: { changed: [], kept: [] }, primary: { label: '', alts: [], enabled: false }, calendar: [],
    slots: [{ key: 'night', label: '야간 22:00', selected: true, enabled: true }],
    days: [{ key: 'tomorrow', label: '내일', selected: false, enabled: true }, { key: 'other', label: '다른 날', opens: true, selected: false, enabled: true }],
    ...over,
  });
  const base: PromiseSheetParams = { orderId: 'o22' };

  it('수량 · 반납 타임 · 날(내일은 켜고 끄기) · 날짜 · 장소 · 차량을 인자에 넣는다', () => {
    expect(withQuantity(base, 'o22-l2', 1)).toEqual({ orderId: 'o22', quantities: { 'o22-l2': 1 } });
    expect(withSlot(base, view(), 'late_night')).toEqual({ orderId: 'o22', slot: { day: 'today', slotKey: 'late_night' } });
    expect(withDay(base, view(), 'tomorrow')).toEqual({ orderId: 'o22', slot: { day: 'tomorrow', slotKey: 'night' } });
    const on = view({ days: [{ key: 'tomorrow', label: '내일', selected: true, enabled: true }] });
    expect(withDay({ orderId: 'o22', slot: { day: 'tomorrow', slotKey: 'night' } }, on, 'tomorrow')).toEqual({ orderId: 'o22', slot: { day: 'today', slotKey: 'night' } });
    expect(withSlot({ orderId: 'o22', slot: { day: 'tomorrow', slotKey: 'night' } }, on, 'morning').slot).toEqual({ day: 'tomorrow', slotKey: 'morning' });
    expect(withDay(base, view(), '2026-12-29').slot).toEqual({ day: '2026-12-29', slotKey: 'night' });
    expect(withPlace(base, { mode: 'vehicle', placeKey: 'dusol' }).place).toEqual({ mode: 'vehicle', placeKey: 'dusol' });
    expect(withVehicle(base, 'v2').vehicleId).toBe('v2');
  });

  it('봉투: 연 때의 요청번호 · basis에 서버가 준 명령과 견적. 명령이 없으면 보내지 않는다', () => {
    const draft = openOrRestoreDraft(null, { type: 'promise.change', payload: { orderId: 'o22', kind: 'return', lines: [], promise: { mode: 'store' } } }, { epoch: 'e', rev: 1 });
    expect(promiseEnvelope(draft, view())).toBeNull();
    const command: ConfirmCommand = change([['o22-l2', 1]], DUSOL);
    const envelope = promiseEnvelope(draft, view({ command, expect: { quoteHash: 'extension:25000' } }))!;
    expect(envelope).toMatchObject({ type: 'promise.change', requestId: draft.requestId, basis: { epoch: 'e', rev: 1 }, payload: command.payload, expect: { quoteHash: 'extension:25000' } });
  });

  it('카운터가 끊겼으면 창 대신 한 줄', () => {
    expect(promiseEntry(true)).toBe('dialog');
    expect(promiseEntry(false)).toBe('offline');
  });
});

// 둘째 판 3단계(work/impl-v2/plan.md 5절 Step 3): V1 반납 확인 창 · 부분 반납(spec 3-1). 창은 처음에 이 팀이 가진 것을 모두 골라 두고
// 안 가져온 번호만 빼며, 고른 것(번호 · 수량 · 반환 방법)을 인자로 다시 물으면 서버(returnSheet)가 미반납 줄 · 보증금 줄 · 반환 방법 ·
// 주 버튼 · 명령(반납 + 보증금 반환)을 새로 쓴다. 매장 반납은 원래 일정(설천 주차장)부터 채우고 나눈 일정(솔마을 두솔동)은 남는다.
// 뒷이야기 21:31(박준호 부분 반납 + 보증금 10,000원 현금), 21:32(미수 카드 120,000원), 27일 00:15(정하늘 매장 반납).
// 첫 매장(체험판 기본, 2026-09-26): 번호 · 권 보증금이 없어 모든 칸이 −/+ 수량이고 ④ ⑤ 줄이 없다(맨 앞 describe). 번호 버튼 · 보증금 반환은
// 그것을 켠 매장 모양(shop 'numbered')으로 계속 본다.
import {
  draftToEnvelope, openCommandDraft, type CommandOutcome, type ConfirmCommand, type Expect, type ReturnSheetParams, type ReturnSheetView, type RichText,
} from '@skinote/contract';
import { openOrRestoreDraft } from '@skinote/ui';
import { describe, expect, it } from 'vitest';
import { pickedOf, returnEnvelopes, togglePiece, withLineQuantity, withRefundMethod } from '../src/components/ReturnDialog.tsx';
import { collectDone, depositOf, findTask, type FxState, heldAmount, heldNumbers, heldUnits, kstAt, ownDue, type SampleShop, taskOrder } from '@skinote/domain';
import { applyCommand } from '../src/fixture/demo.ts';
import { FixtureClient } from '../src/fixture/fixture-client.ts';

const ms = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const iso = (h: number, m: number, day = 0) => new Date(ms(h, m, day)).toISOString();
const text = (runs: RichText | undefined) => (runs ?? []).map((r) => r.text).join('');

/** 체험 시계를 15:40에서 minutes만큼(뒷이야기 켬). 21:30 = 350분(16:05 박준호 지급(· 번호 매장은 보증금), 19:41 일정 변경은 적혔고 21:31 반납은 아직). */
function at(minutes: number, story = true, shop: SampleShop = 'first') {
  const client = new FixtureClient({ realNow: () => 1_800_000_000_000, story, shop });
  client.advanceClock(minutes);
  const state = () => (client as unknown as { state: FxState }).state;
  return { client, state };
}
/** 21:30, 번호 · 권 보증금을 켠 매장(시험). */
const at2130 = () => at(350, true, 'numbered');
/** 21:30, 첫 매장(수량 · 보증금 없음). */
const first2130 = () => at(350);

const line = (state: FxState, id: string) => {
  const hit = state.orders.flatMap((o) => o.lines).find((l) => l.id === id);
  if (!hit) throw new Error('줄이 없다: ' + id);
  return hit;
};

/** 시안의 그린 상태: 안 가져온 5 · 15 · 33번을 뺀 뒤(화면이 누르는 길 그대로). */
function drawn(opened: ReturnSheetView, base: ReturnSheetParams = { orderId: 'o22' }): ReturnSheetParams {
  let params = base;
  for (const [lineId, id] of [['o22-l2', 'board-5'], ['o22-l3', 'helmet-15'], ['o22-l4', 'night_adult-33']] as const) params = togglePiece(params, opened, lineId, id);
  return params;
}

/** 화면과 같은 길: 창을 연 때의 초안(반납 + 보증금, 보증금은 반납에 dependsOn) → 확정할 때 받은 명령으로 봉투 → 차례로 보냄. */
async function confirm(client: FixtureClient, opened: ReturnSheetView, view: ReturnSheetView): Promise<CommandOutcome[]> {
  const draft = openOrRestoreDraft(null, { type: 'stock.direct_return', payload: { orderId: 'o22', lines: [] } }, opened.basis);
  const step = opened.then?.[0];
  const deposit = step ? openCommandDraft(step.command, draft.basis, { ...(step.expect ? { expect: step.expect } : {}), dependsOn: [draft.requestId] }) : null;
  const envelopes = returnEnvelopes(draft, deposit ? [deposit] : [], view);
  if (!envelopes) throw new Error('보낼 명령이 없다');
  const out: CommandOutcome[] = [];
  for (const envelope of envelopes) out.push(await client.command(envelope));
  return out;
}

function send(state: FxState, command: ConfirmCommand, extra: { expect?: Expect; dependsOn?: string[] } = {}, now = ms(21, 30)): CommandOutcome {
  return applyCommand(state, draftToEnvelope(openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, extra)), now);
}

/** 첫 매장 시안의 그린 상태: 안 가져온 보드 1 · 헬멧 1 · 권 1매를 −로 뺀 뒤(화면이 누르는 길 그대로). */
function drawnCount(opened: ReturnSheetView, base: ReturnSheetParams = { orderId: 'o22' }): ReturnSheetParams {
  let params = base;
  for (const [lineId, value] of [['o22-l2', 0], ['o22-l3', 2], ['o22-l4', 2]] as const) params = withLineQuantity(params, opened, lineId, value);
  return params;
}

describe('V1 첫 매장(번호 · 보증금 없음) — 21:30 박준호 팀', () => {
  it('#all 처음 연 상태: 칸은 모두 −/+ 수량(가진 수 모두), 일정별 수, 미반납 없음 · 두 수거 취소, 보증금 줄 없음, 주 버튼 6개 · 3매', async () => {
    const { client } = first2130();
    const view = await client.query('returnSheet', { orderId: 'o22' });
    expect(view.title).toBe('반납 처리 · 박준호 팀');
    expect(view.lead).toEqual([{ text: '전체 선택 · 미반납 수량 감소' }]);
    expect(view.lines.map((l) => [l.label, l.note, l.mode, l.muted, l.wide, l.quantity, l.pieces ?? null])).toEqual([
      // 일정이 하나인 수량 칸의 둘째 줄은 차량 수거 장소만(−/+의 수와 같은 수를 두 번 쓰지 않음, 2026-09-26 검토).
      ['스키', '설천', 'count', false, false, { value: 2, min: 0, max: 2, unit: '대' }, null],
      ['보드', '두솔동', 'count', false, false, { value: 1, min: 0, max: 1, unit: '대' }, null],
      ['헬멧', '설천 2 · 두솔동 1', 'count', false, false, { value: 3, min: 0, max: 3, unit: '개' }, null],
      ['야간권 성인', '설천 2 · 두솔동 1', 'count', false, false, { value: 3, min: 0, max: 3, unit: '매' }, null],
    ]);
    expect(view.remainder).toEqual([{ text: '미반납 없음', strong: true }, { text: ' · 설천 주차장 · 솔마을 두솔동 수거 취소' }]);
    expect(view.deposit).toBeUndefined();
    expect(view.refundMethods).toBeUndefined();
    expect(view.lines.some((l) => l.deposit)).toBe(false);
    expect(view.primary).toEqual({ label: '반납 처리 · 6개 · 3매', alts: ['반납 처리 · 6개 · 3매', '반납 처리'], enabled: true });
    expect(view.command).toEqual({
      type: 'stock.direct_return',
      payload: { orderId: 'o22', lines: [{ lineId: 'o22-l1', quantity: 2 }, { lineId: 'o22-l2', quantity: 1 }, { lineId: 'o22-l3', quantity: 3 }, { lineId: 'o22-l4', quantity: 3 }] },
    });
    expect(view.then).toBeUndefined();
  });

  it('그린 상태(보드 1 · 헬멧 1 · 권 1매를 −로 뺌): 보드 칸은 옅은 먹 0대, 미반납 줄, 주 버튼 `반납 처리 · 스키 2 · 헬멧 2 · 권 2매`, 명령은 수만', async () => {
    const { client } = first2130();
    const opened = await client.query('returnSheet', { orderId: 'o22' });
    const view = await client.query('returnSheet', drawnCount(opened));
    expect(view.lines.map((l) => [l.label, l.muted, l.quantity?.value])).toEqual([['스키', false, 2], ['보드', true, 0], ['헬멧', false, 2], ['야간권 성인', false, 2]]);
    expect(text(view.remainder)).toBe('미반납: 보드 1 · 헬멧 1 · 권 1매 → 22:00 솔마을 두솔동 수거 예정 · 설천 주차장 수거 취소');
    expect(view.deposit).toBeUndefined();
    // 보증금 줄이 없는 창의 ④ 자리: 반납하러 온 팀의 미수(검정, 2026-09-26 검토).
    expect(view.money).toEqual([{ text: '미수 120,000원', strong: true }]);
    expect(view.primary.label).toBe('반납 처리 · 스키 2 · 헬멧 2 · 권 2매');
    expect(view.primary.alts).toContain('반납 처리 · 스키 2 외 2종');
    expect(view.command).toEqual({
      type: 'stock.direct_return',
      payload: { orderId: 'o22', lines: [{ lineId: 'o22-l1', quantity: 2 }, { lineId: 'o22-l3', quantity: 2 }, { lineId: 'o22-l4', quantity: 2 }] },
    });
    expect(view.then).toBeUndefined();
    // 모두 0이면 누를 수 없다.
    const none = await client.query('returnSheet', { orderId: 'o22', picked: opened.lines.map((l) => ({ lineId: l.lineId, quantity: 0 })) });
    expect(none.primary).toEqual({ label: '반납 처리', alts: ['반납 처리'], enabled: false });
    expect(none.command).toBeUndefined();
    // 가진 수보다 많이 적어도 가진 수까지.
    expect((await client.query('returnSheet', { orderId: 'o22', picked: [{ lineId: 'o22-l1', quantity: 9 }] })).lines[0]?.quantity?.value).toBe(2);
  });

  it('그린 상태로 확정: 반납 한 명령(보증금 명령 없음), 원래 일정(설천)이 채워지고 두솔동 일정만 남음, 다시 열면 남은 것만', async () => {
    const { client, state } = first2130();
    const opened = await client.query('returnSheet', { orderId: 'o22' });
    const view = await client.query('returnSheet', drawnCount(opened));
    const outcomes = await confirm(client, opened, view);
    expect(outcomes.map((o) => o.outcome)).toEqual(['applied']);
    expect([line(state(), 'o22-l1').returned, line(state(), 'o22-l3').returned, line(state(), 'o22-l4').returned]).toEqual([2, 2, 2]);
    expect(state().deposits).toEqual([]);
    expect(collectDone(taskOrder(findTask(state(), 'collect:o22')!))).toBe(true);
    const dusol = taskOrder(findTask(state(), 'collect:o22:p1')!);
    expect(dusol.lines.map((l) => [l.label, l.issued - l.returned - l.collected])).toEqual([['보드', 1], ['헬멧', 1], ['야간권 성인', 1]]);
    const again = await client.query('returnSheet', { orderId: 'o22' });
    expect(again.lines.map((l) => [l.label, l.note, l.quantity?.value])).toEqual([['보드', '두솔동', 1], ['헬멧', '두솔동', 1], ['야간권 성인', '두솔동', 1]]);
    expect(again.deposit).toBeUndefined();
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.money.depositHeld ?? 0).toBe(0);
    expect(slip.checklist.find((c) => c.stepKey === 'return')?.second?.map((p) => p.text)).toEqual(['솔마을 두솔동', '차량 수거']);
  });

  it('줄 하나(스키)의 반납 칸으로 열면 그 줄만, 주 버튼 `반납 처리 · 2개`', async () => {
    const { client } = first2130();
    const view = await client.query('returnSheet', { orderId: 'o22', lineIds: ['o22-l1'] });
    expect(view.lines.map((l) => [l.label, l.mode])).toEqual([['스키', 'count']]);
    expect(view.primary.label).toBe('반납 처리 · 2개');
    expect(view.command?.payload).toEqual({ orderId: 'o22', lines: [{ lineId: 'o22-l1', quantity: 2 }] });
  });

  it('뒷이야기 21:31 · 21:32(첫 매장): 스키 2 · 헬멧 2 · 권 2매 반납(보증금 없음), 미수 120,000원 카드, 두솔동 몫만 남음', async () => {
    const { client, state } = at(360);
    const s = state();
    expect(s.storyApplied).toEqual(expect.arrayContaining(['park-return', 'park-pay']));
    expect([line(s, 'o22-l1').returned, line(s, 'o22-l2').returned, line(s, 'o22-l3').returned, line(s, 'o22-l4').returned]).toEqual([2, 0, 2, 2]);
    expect(line(s, 'o22-l1').returnedAt).toBe(ms(21, 31));
    expect(s.deposits).toEqual([]);
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.money).toMatchObject({ charged: 225_000, paid: 225_000, due: 0 });
    const again = await client.query('returnSheet', { orderId: 'o22' });
    expect(again.lines.map((l) => [l.label, l.note])).toEqual([['보드', '두솔동'], ['헬멧', '두솔동'], ['야간권 성인', '두솔동']]);
  });

  it('사람이 21:30에 먼저 반납했으면 21:31 사건은 건너뛴다(두 번 반납하지 않음)', async () => {
    const { client, state } = first2130();
    const opened = await client.query('returnSheet', { orderId: 'o22' });
    await confirm(client, opened, await client.query('returnSheet', drawnCount(opened)));
    client.advanceClock(10);
    const s = state();
    expect(s.storyApplied).toContain('park-return');
    expect([line(s, 'o22-l1').returned, line(s, 'o22-l3').returned, line(s, 'o22-l4').returned]).toEqual([2, 2, 2]);
  });
});

describe('V1 창의 읽기 모델(returnSheet) — 21:30 박준호 팀 · 번호 · 권 보증금을 켠 매장(numbered)', () => {
  it('#all 처음 연 상태: 가진 번호 모두 골라짐, 일정별 수, 미반납 없음 · 두 수거 취소, 권 3매 보증금 15,000원 반환, 주 버튼 6개 · 3매', async () => {
    const { client } = at2130();
    const view = await client.query('returnSheet', { orderId: 'o22' });
    expect(view.title).toBe('반납 처리 · 박준호 팀');
    expect(view.lead).toEqual([{ text: '전체 선택 · 미반납 번호 해제' }]);
    expect(view.lines.map((l) => [l.label, l.note, l.mode, l.muted, l.wide, (l.pieces ?? []).map((p) => p.label + (p.picked ? '*' : ''))])).toEqual([
      ['스키', '설천 2대', 'unit', false, false, ['17번*', '18번*']],
      ['보드', '두솔동 1대', 'unit', false, false, ['5번*']],
      ['헬멧', '설천 2 · 두솔동 1', 'unit', false, false, ['12번*', '14번*', '15번*']],
      ['야간권 성인', '설천 2 · 두솔동 1', 'unit', false, false, ['31번*', '32번*', '33번*']],
    ]);
    expect(view.remainder).toEqual([{ text: '미반납 없음', strong: true }, { text: ' · 설천 주차장 · 솔마을 두솔동 수거 취소' }]);
    expect(text(view.deposit)).toBe('권 3매 보증금 15,000원 반환 · 매장 기준 1매 5,000원 · 잔여 보증금 없음');
    expect(view.deposit?.find((r) => r.strong)).toEqual({ text: '15,000원 반환', strong: true });
    expect(view.refundMethods?.map((m) => [m.key, m.label, m.selected, m.enabled])).toEqual([
      ['cash', '현금', true, true], ['offset_due', '미수 차감 · 120,000원 → 105,000원', false, true],
    ]);
    expect(view.primary).toEqual({ label: '반납 처리 · 6개 · 3매 · 보증금 15,000원', alts: ['반납 처리 · 6개 · 3매 · 보증금 15,000원', '반납 처리 · 6개 · 3매', '반납 처리'], enabled: true });
    expect(view.command?.type).toBe('stock.direct_return');
    expect(view.then?.[0]?.expect).toEqual({ depositHeld: 15_000, dueAmount: 120_000 });
  });

  it('그린 상태(5 · 15 · 33번 뺌): 보드 칸은 옅은 먹, 미반납 줄 · 보증금 10,000원 · 미수 차감 110,000원, 주 버튼과 두 명령(번호로)', async () => {
    const { client } = at2130();
    const opened = await client.query('returnSheet', { orderId: 'o22' });
    const view = await client.query('returnSheet', drawn(opened));
    expect(view.lines.map((l) => [l.label, l.muted])).toEqual([['스키', false], ['보드', true], ['헬멧', false], ['야간권 성인', false]]);
    expect(view.remainder).toEqual([
      { text: '미반납:', strong: true }, { text: ' 보드 1 · 헬멧 1 · 권 1매' }, { text: ' → 22:00 솔마을 두솔동 수거 예정' }, { text: ' · 설천 주차장 수거 취소' },
    ]);
    expect(text(view.remainder)).toBe('미반납: 보드 1 · 헬멧 1 · 권 1매 → 22:00 솔마을 두솔동 수거 예정 · 설천 주차장 수거 취소');
    expect(text(view.deposit)).toBe('권 2매 보증금 10,000원 반환 · 매장 기준 1매 5,000원 · 잔여 보증금 5,000원(권 1매)');
    expect(view.refundMethods?.map((m) => m.label)).toEqual(['현금', '미수 차감 · 120,000원 → 110,000원']);
    expect(view.primary.label).toBe('반납 처리 · 스키 2 · 헬멧 2 · 권 2매 · 보증금 10,000원');
    expect(view.primary.alts).toContain('반납 처리 · 스키 2 외 2종 · 보증금 10,000원');
    expect(view.command).toEqual({
      type: 'stock.direct_return',
      payload: {
        orderId: 'o22',
        lines: [
          { lineId: 'o22-l1', quantity: 2, assetIds: ['ski-17', 'ski-18'] },
          { lineId: 'o22-l3', quantity: 2, assetIds: ['helmet-12', 'helmet-14'] },
          { lineId: 'o22-l4', quantity: 2, assetIds: ['night_adult-31', 'night_adult-32'] },
        ],
      },
    });
    expect(view.then).toEqual([{
      command: {
        type: 'deposit.return',
        payload: { orderId: 'o22', ruleKey: 'lift_ticket_card', lines: [{ lineId: 'o22-l4', quantity: 2, assetIds: ['night_adult-31', 'night_adult-32'] }], amount: 10_000, refundMethodKey: 'cash' },
      },
      expect: { depositHeld: 15_000, dueAmount: 120_000 },
    }]);
  });

  it('미수 차감을 고르면 보증금 명령의 반환 방법이 offset_due, 권을 모두 빼면 보증금 반환 없음 · 방법 버튼은 누를 수 없음', async () => {
    const { client } = at2130();
    const opened = await client.query('returnSheet', { orderId: 'o22' });
    const offset = await client.query('returnSheet', withRefundMethod(drawn(opened), 'offset_due'));
    expect(offset.refundMethods?.map((m) => [m.key, m.selected])).toEqual([['cash', false], ['offset_due', true]]);
    expect(offset.then?.[0]?.command.payload).toMatchObject({ refundMethodKey: 'offset_due', amount: 10_000 });
    let params = drawn(opened);
    for (const id of ['night_adult-31', 'night_adult-32']) params = togglePiece(params, offset, 'o22-l4', id);
    const noTickets = await client.query('returnSheet', params);
    expect(text(noTickets.deposit)).toBe('보증금 반환 없음 · 매장 기준 1매 5,000원 · 잔여 보증금 15,000원(권 3매)');
    expect(noTickets.refundMethods?.map((m) => [m.label, m.enabled, m.selected])).toEqual([['현금', false, false]]);
    expect(noTickets.then).toBeUndefined();
    expect(noTickets.primary.label).toBe('반납 처리 · 스키 2 · 헬멧 2');
  });

  it('모두 빼면 주 버튼은 반납 처리(누를 수 없음) · 명령 없음, 미반납 줄은 두 일정 모두 수거 예정', async () => {
    const { client } = at2130();
    const view = await client.query('returnSheet', { orderId: 'o22', picked: [] });
    expect(view.primary).toEqual({ label: '반납 처리', alts: ['반납 처리'], enabled: false });
    expect(view.command).toBeUndefined();
    expect(view.lines.every((l) => l.muted)).toBe(true);
    expect(text(view.remainder)).toBe('미반납: 스키 2 · 보드 1 · 헬멧 3 · 권 3매 → 22:00 설천 주차장 수거 예정 · 22:00 솔마을 두솔동 수거 예정');
    // 보증금이 걸린 팀이라 ④ ⑤ 줄은 그대로 있다(창 높이가 흔들리지 않게).
    expect(view.deposit).toBeDefined();
    expect(view.refundMethods).toHaveLength(1);
  });

  it('줄 하나(스키)의 반납 칸으로 열면 그 줄만, 권이 없어 ④ ⑤ 줄도 없다. 미반납 줄은 접수 전체를 본다', async () => {
    const { client } = at2130();
    const view = await client.query('returnSheet', { orderId: 'o22', lineIds: ['o22-l1'] });
    expect(view.lines.map((l) => l.label)).toEqual(['스키']);
    expect(view.deposit).toBeUndefined();
    expect(view.refundMethods).toBeUndefined();
    expect(text(view.remainder)).toBe('미반납: 보드 1 · 헬멧 3 · 권 3매 → 22:00 설천 주차장 수거 예정 · 22:00 솔마을 두솔동 수거 예정');
    expect(view.primary.label).toBe('반납 처리 · 2개');
    expect(view.command?.payload).toEqual({ orderId: 'o22', lines: [{ lineId: 'o22-l1', quantity: 2, assetIds: ['ski-17', 'ski-18'] }] });
  });

  it('늦은 매장 반납(15:40 김영희 12:00): ① 자리에 빨강 반납 지연 · 일정 12:00, 둘째 줄은 매장 2대, 남는 일정은 일정 12:00(예정 아님)', async () => {
    const { client } = at(0, false, 'numbered');
    const view = await client.query('returnSheet', { orderId: 'o27', lineIds: ['o27-l1'] });
    expect(view.lead).toEqual([{ text: '반납 지연 · 일정 12:00', strong: true, tone: 'red' }]);
    expect(view.lines.map((l) => [l.label, l.note])).toEqual([['스키', '매장 2대']]);
    expect(text(view.remainder)).toBe('미반납: 의류 2 · 헬멧 1 → 매장 반납 · 일정 12:00');
    expect(view.deposit).toBeUndefined();
  });

  it('반납 칸 · 처리 현황 반납: confirmDraft가 틀이 따로인 반납 창(template return), 돌려받을 것이 없으면 한 줄', async () => {
    const { client } = at2130();
    const draft = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.return' });
    expect(draft.template).toBe('return');
    expect(draft.title).toBe('반납 처리 · 박준호 팀');
    const done = await client.query('confirmDraft', { orderId: 'o24', actionKey: 'stamp.return' });
    expect(done.template).toBeUndefined();
    expect(done.notice).toBe('반납 완료');
    // 처리 현황의 반납 줄은 접수 단위 도장을 가진다(차량 담당: 알림 한 줄과 매장 반납 처리 → 모든 줄의 창).
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    const back = slip.checklist.find((c) => c.stepKey === 'return');
    expect(back?.stamp).toMatchObject({ state: 'delegated', pressNote: { lines: ['1호 차량 수거 예정 · 22:00'], action: { actionKey: 'stamp.return', label: '매장 반납 처리' } } });
    expect(slip.checklist.find((c) => c.stepKey === 'pay')?.stamp?.state).toBe('partial');
  });
});

describe('창의 고른 것 → 인자(ReturnDialog의 순수 함수) — 번호 매장', () => {
  it('처음에는 창이 보인 그대로, 누를 때마다 인자에 쌓인다(답을 기다리는 사이에 또 눌러도 앞의 것을 잃지 않음)', async () => {
    const { client } = at2130();
    const opened = await client.query('returnSheet', { orderId: 'o22' });
    expect(pickedOf({ orderId: 'o22' }, opened).map((u) => [u.lineId, u.quantity])).toEqual([['o22-l1', 2], ['o22-l2', 1], ['o22-l3', 3], ['o22-l4', 3]]);
    const one = togglePiece({ orderId: 'o22' }, opened, 'o22-l2', 'board-5');
    // 두 번째 누름은 아직 옛 창(opened)을 보고 있어도 인자에서 이어 간다.
    const two = togglePiece(one, opened, 'o22-l3', 'helmet-15');
    expect(two.picked?.find((u) => u.lineId === 'o22-l2')).toEqual({ lineId: 'o22-l2', quantity: 0, assetIds: [] });
    expect(two.picked?.find((u) => u.lineId === 'o22-l3')).toEqual({ lineId: 'o22-l3', quantity: 2, assetIds: ['helmet-12', 'helmet-14'] });
    const back = togglePiece(two, opened, 'o22-l2', 'board-5');
    expect(back.picked?.find((u) => u.lineId === 'o22-l2')).toEqual({ lineId: 'o22-l2', quantity: 1, assetIds: ['board-5'] });
    expect(withLineQuantity(two, opened, 'o22-l1', 1).picked?.find((u) => u.lineId === 'o22-l1')).toEqual({ lineId: 'o22-l1', quantity: 1 });
    expect(withRefundMethod(two, 'offset_due').refundMethodKey).toBe('offset_due');
  });

  it('확정 봉투: 반납은 연 때의 요청번호 · basis, 보증금은 연 때 만든 요청번호로 반납에 dependsOn, 바탕은 연 때 본 보관 금액', async () => {
    const { client } = at2130();
    const opened = await client.query('returnSheet', { orderId: 'o22' });
    const view = await client.query('returnSheet', drawn(opened));
    const draft = openOrRestoreDraft(null, { type: 'stock.direct_return', payload: { orderId: 'o22', lines: [] } }, opened.basis);
    const step = opened.then![0]!;
    const deposit = openCommandDraft(step.command, draft.basis, { expect: step.expect!, dependsOn: [draft.requestId] });
    const [first, second] = returnEnvelopes(draft, [deposit], view)!;
    expect(first).toMatchObject({ type: 'stock.direct_return', requestId: draft.requestId, basis: opened.basis, payload: view.command!.payload });
    expect(second).toMatchObject({ type: 'deposit.return', requestId: deposit.requestId, dependsOn: [draft.requestId], expect: { depositHeld: 15_000 } });
    expect(second!.payload).toEqual(view.then![0]!.command.payload);
    // 권을 모두 빼면 보증금 명령은 없다(반납만).
    const noTickets = await client.query('returnSheet', { orderId: 'o22', picked: [{ lineId: 'o22-l1', quantity: 2, assetIds: ['ski-17', 'ski-18'] }] });
    expect(returnEnvelopes(draft, [deposit], noTickets)?.map((e) => e.type)).toEqual(['stock.direct_return']);
    // 하나도 고르지 않으면 보내지 않는다.
    expect(returnEnvelopes(draft, [deposit], await client.query('returnSheet', { orderId: 'o22', picked: [] }))).toBeNull();
  });
});

describe('확정한 뒤(stock.direct_return + deposit.return) — 번호 · 권 보증금 매장', () => {
  it('그린 상태로 확정: 원래 일정(설천)이 채워지고 두솔동 일정만 남음, 보증금 5,000원(권 1매) 보관, 카운터 돈통 10,000원 반환', async () => {
    const { client, state } = at2130();
    const opened = await client.query('returnSheet', { orderId: 'o22' });
    const view = await client.query('returnSheet', drawn(opened));
    const outcomes = await confirm(client, opened, view);
    expect(outcomes.map((o) => o.outcome)).toEqual(['applied', 'applied']);
    expect(heldNumbers(line(state(), 'o22-l1'))).toEqual([]);
    expect(heldNumbers(line(state(), 'o22-l3'))).toEqual(['helmet-15']);
    expect(heldNumbers(line(state(), 'o22-l4'))).toEqual(['night_adult-33']);
    const dep = depositOf(state(), 'o22', 'lift_ticket_card');
    expect(heldAmount(dep)).toBe(5_000);
    expect(heldUnits(dep, 'o22-l4')).toBe(1);
    expect(dep?.entries.at(-1)).toMatchObject({ kind: 'refund', quantity: 2, amount: 10_000, methodKey: 'cash', drawerId: 'counter', assetIds: ['night_adult-31', 'night_adult-32'] });
    // 설천 주차장 수거는 받을 것이 없어 끝(매장 반납), 두솔동 수거는 보드 1 · 헬멧 1 · 권 1매.
    expect(collectDone(taskOrder(findTask(state(), 'collect:o22')!))).toBe(true);
    const dusol = taskOrder(findTask(state(), 'collect:o22:p1')!);
    expect(dusol.lines.map((l) => [l.label, l.issued - l.returned - l.collected])).toEqual([['보드', 1], ['헬멧', 1], ['야간권 성인', 1]]);
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.money.depositHeld).toBe(5_000);
    expect(slip.promises.distinct).toBe(1);
    expect(slip.checklist.find((c) => c.stepKey === 'return')?.second?.map((p) => p.text)).toEqual(['솔마을 두솔동', '차량 수거']);
    // 창을 다시 열면 남은 것만(보드 5 · 헬멧 15 · 권 33, 모두 두솔동 일정).
    const again = await client.query('returnSheet', { orderId: 'o22' });
    expect(again.lines.map((l) => [l.label, l.note, (l.pieces ?? []).map((p) => p.label)])).toEqual([
      ['보드', '두솔동 1대', ['5번']], ['헬멧', '두솔동 1개', ['15번']], ['야간권 성인', '두솔동 1매', ['33번']],
    ]);
    expect(text(again.deposit)).toBe('권 1매 보증금 5,000원 반환 · 매장 기준 1매 5,000원 · 잔여 보증금 없음');
  });

  it('미수 차감: 보증금 장부에 미수 차감 줄, 접수의 수납에 보증금 결제 한 행(돈통 없음), 미수 120,000원 → 110,000원', async () => {
    const { client, state } = at2130();
    const opened = await client.query('returnSheet', { orderId: 'o22' });
    const view = await client.query('returnSheet', withRefundMethod(drawn(opened), 'offset_due'));
    expect((await confirm(client, opened, view)).map((o) => o.outcome)).toEqual(['applied', 'applied']);
    const o = state().orders.find((x) => x.id === 'o22')!;
    expect(ownDue(o)).toBe(110_000);
    expect(o.payments.at(-1)).toMatchObject({ amount: 10_000, methodKey: 'deposit' });
    expect(o.payments.at(-1)).not.toHaveProperty('drawerId');
    expect(depositOf(state(), 'o22', 'lift_ticket_card')?.entries.at(-1)).toMatchObject({ kind: 'apply', amount: 10_000 });
    expect(state().paymentGroups.some((g) => g.amount === 10_000)).toBe(false);
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.money).toMatchObject({ due: 110_000, depositHeld: 5_000 });
    expect(slip.money.payments.map((p) => p.methodLabel)).toContain('보증금 결제');
  });

  it('보증금 반환의 바탕 · 규칙: 보관 금액이 바뀌면 충돌, 돌아오지 않은 권은 거절, 금액은 매수 × 1매, 미수보다 크면 미수 차감 불가', () => {
    const { state } = at2130();
    const s = state();
    const refund = (lines: { lineId: string; quantity: number }[], amount: number, refundMethodKey = 'cash'): ConfirmCommand =>
      ({ type: 'deposit.return', payload: { orderId: 'o22', ruleKey: 'lift_ticket_card', lines, amount, refundMethodKey } });
    // 권이 아직 손님에게 있다(반납 전).
    expect(send(s, refund([{ lineId: 'o22-l4', quantity: 1 }], 5_000), { expect: { depositHeld: 15_000 } }))
      .toMatchObject({ outcome: 'rejected', error: { message: '보증금 반환 불가 · 리프트권 미반납' } });
    expect(send(s, { type: 'stock.direct_return', payload: { orderId: 'o22', lines: [{ lineId: 'o22-l4', quantity: 1, assetIds: ['night_adult-31'] }] } }).outcome).toBe('applied');
    expect(send(s, refund([{ lineId: 'o22-l4', quantity: 1 }], 5_000), { expect: { depositHeld: 10_000 } }))
      .toMatchObject({ outcome: 'conflict', error: { code: 'DEPOSIT_CHANGED' } });
    expect(send(s, refund([{ lineId: 'o22-l4', quantity: 1 }], 10_000), { expect: { depositHeld: 15_000 } }))
      .toMatchObject({ outcome: 'rejected', error: { message: '보증금 금액 불일치' } });
    expect(send(s, refund([{ lineId: 'o22-l4', quantity: 2 }], 10_000), { expect: { depositHeld: 15_000 } }))
      .toMatchObject({ outcome: 'rejected', error: { message: '보증금 반환 불가 · 리프트권 미반납' } });
    expect(send(s, refund([{ lineId: 'o22-l4', quantity: 1 }], 5_000, 'offset_due'), { expect: { depositHeld: 15_000, dueAmount: 100_000 } }))
      .toMatchObject({ outcome: 'conflict', error: { code: 'DUE_CHANGED' } });
    expect(send(s, refund([{ lineId: 'o22-l4', quantity: 1 }], 5_000), { expect: { depositHeld: 15_000 } }).outcome).toBe('applied');
    // 같은 권의 보증금을 두 번 돌려주지 않는다(돌아온 1매는 이미 정리).
    expect(send(s, refund([{ lineId: 'o22-l4', quantity: 1 }], 5_000), { expect: { depositHeld: 10_000 } }))
      .toMatchObject({ outcome: 'rejected', error: { message: '보증금 반환 불가 · 리프트권 미반납' } });
    // 미수 차감은 이 팀 미수가 반환 금액 이상일 때만(윤서준은 보증금이 없다: 권 매수 없음).
    expect(send(s, { type: 'deposit.return', payload: { orderId: 'o28', ruleKey: 'lift_ticket_card', lines: [], amount: 0, refundMethodKey: 'offset_due' } }, { expect: { depositHeld: 0 } }))
      .toMatchObject({ outcome: 'rejected', error: { message: '보증금 반환 불가 · 권 매수 없음' } });
  });
});

describe('재고 방식별 칸(ui 3-1): 수량 칸 · 넓은 칸 · 번호 선택 작은 창 — 번호 매장', () => {
  it('수량으로 세는 줄은 −/+(둘째 줄은 일정이 나뉘면 일정별 수, 하나면 차량 수거 장소만), 번호 4개부터 넓은 칸, 8개 넘으면 대여 N개 · 번호 선택 ›', async () => {
    const { client, state } = at(0, false, 'numbered');
    const s = state();
    // 예시: 김민수 팀 헬멧을 수량 품목으로, 백승현 팀 스키를 10대로(번호 28 ~ 37번).
    Object.assign(line(s, 'o25-l2'), { tracking: 'count' });
    const ski = line(s, 'o35-l1');
    const ids = Array.from({ length: 10 }, (_, i) => 'ski-' + (28 + i));
    Object.assign(ski, { qty: 10, issued: 10, assetIds: ids });
    const minsu = await client.query('returnSheet', { orderId: 'o25' });
    expect(minsu.lines.map((l) => [l.label, l.mode, l.note, l.wide, l.quantity ?? null])).toEqual([
      ['스키', 'unit', '설천 4대', true, null],
      ['헬멧', 'count', '설천', false, { value: 2, min: 0, max: 2, unit: '개' }],
    ]);
    const fewer = await client.query('returnSheet', { orderId: 'o25', picked: [{ lineId: 'o25-l1', quantity: 4, assetIds: heldNumbers(line(s, 'o25-l1')) }, { lineId: 'o25-l2', quantity: 1 }] });
    expect(fewer.lines[1]?.quantity?.value).toBe(1);
    expect(fewer.command?.type === 'stock.direct_return' ? fewer.command.payload.lines : null).toEqual([{ lineId: 'o25-l1', quantity: 4, assetIds: heldNumbers(line(s, 'o25-l1')) }, { lineId: 'o25-l2', quantity: 1 }]);
    expect(text(fewer.remainder)).toBe('미반납: 헬멧 1 → 22:00 설천 주차장 수거 예정');
    const many = await client.query('returnSheet', { orderId: 'o35' });
    expect(many.lines[0]).toMatchObject({ label: '스키', wide: true, pickerLabel: '대여 10대 · 번호 선택 ›' });
    expect(many.lines[0]?.pieces).toHaveLength(10);
  });
});

describe('뒷이야기(plan.md 4-2): 21:31 부분 반납 · 21:32 수납 · 27일 00:15 정하늘 반납', () => {
  it('번호 · 보증금 매장 21:40: 박준호 팀 스키 17 · 18, 헬멧 12 · 14, 권 31 · 32 반납, 보증금 10,000원 현금 반환, 미수 120,000원 카드', async () => {
    const { client, state } = at(360, true, 'numbered');
    const s = state();
    expect(s.storyApplied).toEqual(expect.arrayContaining(['park-return', 'park-pay']));
    expect(heldNumbers(line(s, 'o22-l1'))).toEqual([]);
    expect(heldNumbers(line(s, 'o22-l3'))).toEqual(['helmet-15']);
    expect(heldNumbers(line(s, 'o22-l4'))).toEqual(['night_adult-33']);
    expect(line(s, 'o22-l1').returnedAt).toBe(ms(21, 31));
    const dep = depositOf(s, 'o22', 'lift_ticket_card');
    expect(heldAmount(dep)).toBe(5_000);
    expect(dep?.entries.filter((e) => e.kind === 'refund')).toEqual([expect.objectContaining({ amount: 10_000, methodKey: 'cash', drawerId: 'counter', at: ms(21, 31) })]);
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.money).toMatchObject({ charged: 225_000, paid: 225_000, due: 0, depositHeld: 5_000 });
    expect(s.paymentGroups.find((g) => g.amount === 120_000)).toMatchObject({ methodKey: 'card', at: ms(21, 32) });
  });

  it('번호 · 보증금 매장: 사람이 21:30에 반납 창에서 먼저 했으면 21:31 사건은 건너뛴다(두 번 반납 · 두 번 반환하지 않음)', async () => {
    const { client, state } = at2130();
    const opened = await client.query('returnSheet', { orderId: 'o22' });
    await confirm(client, opened, await client.query('returnSheet', drawn(opened)));
    client.advanceClock(10);
    const s = state();
    expect(s.storyApplied).toContain('park-return');
    expect(depositOf(s, 'o22', 'lift_ticket_card')?.entries.filter((e) => e.kind === 'refund')).toHaveLength(1);
    expect(heldAmount(depositOf(s, 'o22', 'lift_ticket_card'))).toBe(5_000);
  });

  it('27일 00:15: 정하늘 팀 매장 반납은 26일 영업일(기준 06:00 전), 도장 시각이 찍힘', async () => {
    const { client, state } = at(8 * 60 + 40);
    const s = state();
    expect(s.businessDate).toBe('2026-12-26');
    expect(s.storyApplied).toContain('haneul-return');
    expect(line(s, 'o41-l1').returned).toBe(2);
    expect(line(s, 'o41-l1').returnedAt).toBe(ms(0, 15, 1));
    const slip = await client.query('orderSlip', { orderId: 'o41' });
    expect(slip.lines[0]?.cells['stamp:return']).toEqual({ renderer: 'stamp', stamp: { stepKey: 'return', state: 'done', at: iso(0, 15, 1) } });
  });
});

describe('같은 품목 말의 줄은 한 조각(점검 단계) — 21:10 이민호 팀(의류 사이즈 95 · 100 두 줄)', () => {
  it('첫 매장: 스키를 하나 줄이면 주 버튼 `반납 처리 · 스키 3 · 의류 3 · 헬멧 1 · 권 4매`, 미반납 `스키 1`', async () => {
    const { client, state } = at(330);
    const minho = state().orders.find((o) => o.last4 === '0042');
    if (!minho) throw new Error('이민호 팀이 없다');
    const opened = await client.query('returnSheet', { orderId: minho.id });
    const ski = opened.lines.find((l) => l.label === '스키')!;
    const view = await client.query('returnSheet', withLineQuantity({ orderId: minho.id }, opened, ski.lineId, 3));
    expect(view.primary.label).toBe('반납 처리 · 스키 3 · 의류 3 · 헬멧 1 · 권 4매');
    expect(text(view.remainder)).toMatch(/^미반납: 스키 1 → /);
    expect(view.deposit).toBeUndefined();
  });

  it('번호 · 보증금 매장: 반납 창의 미반납 줄 · 주 버튼과 일정 변경 창의 유지 줄에 `의류 2 · 의류 1`이 아니라 `의류 3`', async () => {
    const { client, state } = at(330, true, 'numbered');
    const minho = state().orders.find((o) => o.last4 === '0042');
    if (!minho) throw new Error('이민호 팀이 없다');
    const opened = await client.query('returnSheet', { orderId: minho.id });
    // 스키 줄의 번호를 하나 빼면 부분 반납: 주 버튼은 품목 조각, 미반납은 나머지 전부.
    const ski = opened.lines.find((l) => l.label === '스키');
    const piece = ski?.pieces?.[0];
    if (!ski || !piece) throw new Error('스키 줄이 없다');
    const view = await client.query('returnSheet', togglePiece({ orderId: minho.id }, opened, ski.lineId, piece.assetId));
    expect(view.primary.label).toBe('반납 처리 · 스키 3 · 의류 3 · 헬멧 1 · 권 4매 · 보증금 20,000원');
    expect(text(view.remainder)).toMatch(/^미반납: 스키 1 → /);
    const none = await client.query('returnSheet', { orderId: minho.id, picked: opened.lines.map((l) => ({ lineId: l.lineId, quantity: 0, assetIds: [] })) });
    expect(text(none.remainder)).toMatch(/^미반납: 스키 4 · 의류 3 · 헬멧 1 · 권 4매 → /);
    const promise = await client.query('promiseSheet', { orderId: minho.id });
    expect(text(promise.summary.kept)).toMatch(/^스키 4 · 의류 3 · 헬멧 1 · 권 4매: 22:00 매장/);
  });
});

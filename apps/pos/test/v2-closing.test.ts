// 둘째 판 8단계(work/impl-v2/plan.md 5절 Step 8): V6 하루 마감(spec 3-7, ui 6-8, data-model 4-12 · 4-13 · S16 · S17). 마감 화면의 읽기 모델
// (closingSheet: 기준 띠 · 결제 수단 · 현금 점검 · 이월 항목 · 바닥줄 · 지금 할 일 · 점검 판), 차량 현금 인계(cash.transfer) · 점검
// (cash.transfer_confirm) · 마감(closing.close), 부분 매장 입고(stock.receive lines)와 확인 필요 `헬멧 1개 미입고`. 시안의 순간은 27일 00:40
// (#before 00:31, #drawer 00:40 셈 전), 뒷이야기 23:48 매장 입고 · 현금 인계, 27일 00:32 차량 현금 점검(spec 2-4).
import {
  envelopeFor,
  type ClosingSheetParams, type ClosingSheetView, type CommandOutcome, type ConfirmCommand, type Expect,
} from '@skinote/contract';
import { DEVICE_PROFILES, openOrRestoreDraft } from '@skinote/ui';
import { describe, expect, it } from 'vitest';
import {
  amountOf, checkParams, draftParams, withCount, withDefer, withoutDefer,
} from '../src/app/closing-draft.ts';
import { applyCommand } from '../src/fixture/commands.ts';
import { postingDate, walletLeft } from '../src/fixture/closing.ts';
import { depositOf, heldAmount } from '../src/fixture/deposits.ts';
import { FixtureClient } from '../src/fixture/fixture-client.ts';
import type { FxState } from '../src/fixture/model.ts';
import { ownDue } from '../src/fixture/rules.ts';
import { applyStory, STORY } from '../src/fixture/story.ts';
import { kstAt } from '../src/fixture/time.ts';
import { closingColumns, closingLayout } from '../src/screens/ClosingScreen.tsx';
import { parseHash } from '../src/app/router.ts';

const ms = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const iso = (h: number, m: number, day = 0) => new Date(ms(h, m, day)).toISOString();
const DATE = '2026-12-26';

/** 15:40에서 minutes만큼(뒷이야기 켬: 27일 00:30 = 530분, 00:40 = 540분). 카운터 기기. */
function at(minutes: number, story = true) {
  const client = new FixtureClient({ realNow: () => 1_800_000_000_000, story });
  client.advanceClock(minutes);
  const state = () => (client as unknown as { state: FxState }).state;
  return { client, state };
}

const text = (runs: readonly { text: string }[] | undefined) => (runs ?? []).map((r) => r.text).join('');
const parts = (list: readonly { text: string }[] | undefined) => (list ?? []).map((p) => p.text).join(' · ');
const cashOf = (view: ClosingSheetView, kind: 'van' | 'drawer') => view.cash.find((r) => r.kind === kind)!;
const carryOf = (view: ClosingSheetView) => view.carry.map((c) => [text(c.title), parts(c.note), c.late]);

/** 화면과 같은 길: 판 · 마감 차례를 연 때의 초안(요청번호 · basis) + 서버가 지금 써 준 명령과 바탕. */
async function send(client: FixtureClient, view: { basis: ClosingSheetView['basis'] }, command: ConfirmCommand | undefined, expect: Expect | undefined): Promise<CommandOutcome> {
  if (!command) throw new Error('보낼 명령이 없다');
  const draft = openOrRestoreDraft(null, command, view.basis, {});
  const envelope = envelopeFor(draft, command, expect);
  if (!envelope) throw new Error('봉투가 없다');
  return client.command(envelope);
}

/** 점검 판에서 금액 · 사유를 넣고 확정한다(차량 현금은 명령, 돈통은 초안의 셈). */
async function check(client: FixtureClient, base: ClosingSheetParams, key: string, digits: string, reason: { reasonKey?: string; reasonNote?: string } = {}) {
  const view = await client.query('closingSheet', checkParams(base, key, digits, reason));
  const pad = view.check;
  if (!pad) return { view, pad, params: base };
  if (pad.kind === 'drawer') return { view, pad, params: pad.count ? withCount(base, pad.count) : base };
  const outcome = await send(client, view, pad.command, pad.expect);
  return { view, pad, outcome, params: withoutDefer(base, key) };
}

describe('V6 읽기 모델(closingSheet) — 27일 00:40 시안의 순간(spec 2-4 검산)', () => {
  it('기준 띠 · 결제 수단(카드 1,525,000원 · 11건, 현금 440,000원 · 6건 · 1호 차량 35,000원 포함, 계좌이체 줄 없음) · 바닥줄', async () => {
    const { client } = at(540);
    const view = await client.query('closingSheet', {});
    expect(view.date).toBe(DATE);
    expect(view.title).toBe('12월 26일 (토) 마감');
    expect(view.band.pill).toBe('현재 27일 00:40');
    expect(parts(view.band.parts)).toBe('26일 장부 · 기준 06:00 · 00:15 정하늘 · 0041 반납 포함');
    expect(view.methods.map((m) => [m.label, parts(m.note), m.count, m.amount])).toEqual([
      ['카드', '', 11, 1_525_000],
      ['현금', '1호 차량 35,000원 포함', 6, 440_000],
    ]);
    expect(parts(view.footer)).toBe('수납 합계 1,965,000원 · 돈통 점검 필요');
    expect(view.next).toMatchObject({ kind: 'drawer_count', label: '돈통 점검', enabled: true, targetKey: 'counter', expectedAmount: 545_000 });
    expect(view.blocked).toBeUndefined();
    expect(view.closed).toBeUndefined();
  });

  it('#drawer: 차량 현금은 00:32에 점검(도장 `점검` / 00:32, 차액 0원), 카운터 돈통 예상 545,000원 · 보증금 5,000원 포함 · 실제 — · 차액 —', async () => {
    const { client } = at(540);
    const view = await client.query('closingSheet', {});
    const van = cashOf(view, 'van');
    expect(van).toMatchObject({ label: '1호 차량 현금', now: false, stamp: { state: 'done', label: '점검', at: iso(0, 32, 1) }, stampAria: '현금 점검 완료 00:32' });
    expect(parts(van.note)).toBe('23:48 입고 · 전송 대기 0');
    expect(text(van.expected)).toBe('예상 35,000원');
    expect(text(van.actual)).toBe('실제 35,000원 · 차액 0원');
    expect(van.actual!.at(-1)).toMatchObject({ strong: true, tone: 'green' });
    expect(van.action).toBeUndefined();
    const drawer = cashOf(view, 'drawer');
    expect(drawer).toMatchObject({ label: '카운터 돈통', now: true });
    expect(parts(drawer.note)).toBe('시재 100,000원 포함');
    expect(text(drawer.expected)).toBe('예상 545,000원 · 보증금 5,000원 포함');
    expect(text(drawer.actual)).toBe('실제 — · 차액 —');
    expect(drawer.action).toBeUndefined();
  });

  it('이월 항목 · 5: 미수 윤서준 120,000원, 27일 반납 예정 8개 · 2팀, 리프트권 미반납 1매 지연(이 줄만 빨강), 보증금 보관 중, 확인 필요 1건', async () => {
    const { client } = at(540);
    const view = await client.query('closingSheet', {});
    expect(carryOf(view)).toEqual([
      ['미수 · 1팀 · 120,000원', '윤서준 · 0028 · 27일 09:00 반납 시', false],
      ['27일 반납 예정 · 8개 · 2팀', '윤서준 · 0028 / 이정호 · 0032', false],
      ['리프트권 미반납 · 1매 · 지연', '최하은 · 0026 · 반납 22:10', true],
      ['보증금 보관 중 · 리프트권 1매 · 5,000원', '최하은 · 0026 · 돈통 보관', false],
      ['확인 필요 · 1건', '김민수 · 0025 · 헬멧 1개 미입고', false],
    ]);
    // 빨강은 늦은 것의 `지연` 조각에만.
    const reds = view.carry.flatMap((c) => c.title.filter((r) => r.tone === 'red').map((r) => r.text));
    expect(reds).toEqual(['지연']);
    // 누르면: 한 팀이면 그 접수증.
    expect(view.carry.map((c) => c.orderId ?? c.tabKey)).toEqual(['o28', 'return', 'o26', 'o26', 'o25']);
  });

  it('돈의 검산: 1호 차량 지갑 00:32 뒤 0원(23:48 인계 35,000원), 보증금 보관은 최하은 1매 5,000원뿐, 미수는 윤서준 120,000원뿐', () => {
    const { state } = at(540);
    const s = state();
    expect(walletLeft(s, DATE, 'v1')).toBe(0);
    expect(s.cashTransfers).toEqual([{ id: 'story:van-2348:1', vehicleId: 'v1', amount: 35_000, at: ms(23, 48), confirmed: { at: ms(0, 32, 1), countedAmount: 35_000 } }]);
    const held = s.deposits.filter((d) => heldAmount(d) > 0).map((d) => [d.orderId, heldAmount(d)]);
    expect(held).toEqual([['o26', 5_000]]);
    expect(s.orders.filter((o) => ownDue(o) > 0 && !o.payerOrderId).map((o) => [o.teamName, ownDue(o)])).toEqual([['윤서준', 120_000]]);
    expect(heldAmount(depositOf(s, 'o22', 'lift_ticket_card'))).toBe(0);
  });
});

describe('V6 #before — 27일 00:30(23:48 입고 · 인계 뒤, 00:32 점검 전)', () => {
  it('차량 현금 줄이 지금 할 일(`미점검` 보라 · `점검 이월`), 돈통 줄은 `차량 현금 점검 후`, 주 버튼 `차량 현금 점검 · 35,000원`', async () => {
    const { client } = at(530);
    const view = await client.query('closingSheet', {});
    expect(view.band.pill).toBe('현재 27일 00:30');
    const van = cashOf(view, 'van');
    expect(van).toMatchObject({ key: 'story:van-2348:1', now: true, action: { key: 'defer', label: '점검 이월' } });
    expect(van.actual).toEqual([{ text: '미점검', strong: true, tone: 'purple' }]);
    const drawer = cashOf(view, 'drawer');
    expect(drawer).toMatchObject({ waiting: '차량 현금 점검 후', now: false, expected: [] });
    expect(view.next).toMatchObject({ kind: 'van_check', label: '차량 현금 점검 · 35,000원', alts: ['차량 현금 점검 · 35,000원', '차량 현금 점검'], targetKey: 'story:van-2348:1' });
    expect(parts(view.footer)).toBe('수납 합계 1,965,000원 · 차량 현금 점검 필요');
    expect(view.command).toBeUndefined();
  });

  it('점검 이월: 이월 항목 6(`미확인 현금 인계 · 35,000원` / `1호 차량 · 23:48 입고`), 돈통 예상 510,000원(보증금 5,000원 포함), 다음은 돈통 점검', async () => {
    const { client } = at(530);
    const view = await client.query('closingSheet', withDefer({}, 'story:van-2348:1'));
    const van = cashOf(view, 'van');
    expect(van).toMatchObject({ now: false, action: { key: 'check', label: '점검' } });
    expect(text(van.actual)).toBe('점검 이월');
    expect(text(cashOf(view, 'drawer').expected)).toBe('예상 510,000원 · 보증금 5,000원 포함');
    expect(view.carry).toHaveLength(6);
    expect(carryOf(view).at(-1)).toEqual(['미확인 현금 인계 · 35,000원', '1호 차량 · 23:48 입고', false]);
    expect(view.carry.at(-1)!.orderId ?? view.carry.at(-1)!.tabKey).toBeUndefined();
    expect(view.next).toMatchObject({ kind: 'drawer_count', label: '돈통 점검' });
  });

  it('점검 판(차량 현금): 친 금액이 다르면 `차액 −5,000원 · 사유 선택` · 사유 버튼 · 주 버튼 막힘, 사유를 고르면 명령(expectedCash)', async () => {
    const { client } = at(530);
    const key = 'story:van-2348:1';
    const empty = (await client.query('closingSheet', checkParams({}, key, ''))).check!;
    expect(empty).toMatchObject({ kind: 'van', title: '1호 차량 현금', diff: [], reasonsShown: false, primary: { label: '차량 현금 점검', enabled: false } });
    expect(text(empty.expected)).toBe('예상 35,000원');
    const wrong = (await client.query('closingSheet', checkParams({}, key, '30000'))).check!;
    expect(text(wrong.diff)).toBe('차액 −5,000원 · 사유 선택');
    expect(wrong.reasonsShown).toBe(true);
    expect(wrong.reasons.map((r) => [r.label, r.enabled, r.selected, r.opens ?? false])).toEqual([
      ['잔돈 착오', true, false, false], ['원인 불명', true, false, false], ['직접 입력', true, false, true],
    ]);
    expect(wrong.primary).toEqual({ label: '차량 현금 점검 · 30,000원', alts: ['차량 현금 점검 · 30,000원', '차량 현금 점검'], enabled: false });
    expect(wrong.command).toBeUndefined();
    // 직접 입력은 글이 있어야 한다.
    const manualEmpty = (await client.query('closingSheet', checkParams({}, key, '30000', { reasonKey: 'manual' }))).check!;
    expect(manualEmpty.primary.enabled).toBe(false);
    const picked = (await client.query('closingSheet', checkParams({}, key, '30000', { reasonKey: 'unknown' }))).check!;
    expect(text(picked.diff)).toBe('차액 −5,000원');
    expect(picked.primary.enabled).toBe(true);
    expect(picked.command).toEqual({ type: 'cash.transfer_confirm', payload: { transferId: key, countedAmount: 30_000, reasonKey: 'unknown' } });
    expect(picked.expect).toEqual({ expectedCash: { [key]: 35_000 } });
    const exact = (await client.query('closingSheet', checkParams({}, key, '35000'))).check!;
    expect(exact.diff).toEqual([{ text: '차액 0원', strong: true, tone: 'green' }]);
    expect(exact.reasons.every((r) => !r.enabled)).toBe(true);
    expect(exact.reasonsShown).toBe(false);
  });

  it('차량 현금 점검(cash.transfer_confirm): 적으면 도장, 돈통 예상에 센 금액(30,000원 → 540,000원), 두 번째는 `점검 완료`, 차액이 있는데 사유가 없으면 거절', async () => {
    const { client, state } = at(530);
    const key = 'story:van-2348:1';
    const noReason = await client.query('closingSheet', checkParams({}, key, '30000'));
    // 화면은 사유 없이 보내지 않지만, 서버도 막는다.
    const bad = await send(client, noReason, { type: 'cash.transfer_confirm', payload: { transferId: key, countedAmount: 30_000 } }, { expectedCash: { [key]: 35_000 } });
    expect(bad).toMatchObject({ outcome: 'rejected', error: { message: '차액 −5,000원 · 사유 선택' } });
    const conflicted = await send(client, noReason, { type: 'cash.transfer_confirm', payload: { transferId: key, countedAmount: 35_000 } }, { expectedCash: { [key]: 30_000 } });
    expect(conflicted).toMatchObject({ outcome: 'conflict', error: { code: 'CASH_CHANGED', message: '예상 현금 변경됨 · 재점검 필요' } });
    const done = await check(client, {}, key, '30000', { reasonKey: 'change_error' });
    expect(done.outcome).toMatchObject({ outcome: 'applied' });
    expect(state().cashTransfers[0]!.confirmed).toEqual({ at: ms(0, 30, 1), countedAmount: 30_000, reasonKey: 'change_error' });
    const view = await client.query('closingSheet', {});
    expect(cashOf(view, 'van')).toMatchObject({ stamp: { label: '점검', at: iso(0, 30, 1) }, stampAria: '현금 점검 완료 00:30' });
    expect(text(cashOf(view, 'van').actual)).toBe('실제 30,000원 · 차액 −5,000원');
    expect(text(cashOf(view, 'drawer').expected)).toBe('예상 540,000원 · 보증금 5,000원 포함');
    const again = await check(client, {}, key, '35000');
    expect(again.pad).toBeUndefined();
    const replay = await send(client, noReason, { type: 'cash.transfer_confirm', payload: { transferId: key, countedAmount: 35_000 } }, { expectedCash: { [key]: 35_000 } });
    expect(replay).toMatchObject({ outcome: 'superseded', error: { message: '점검 완료' } });
    // 00:32 이야기는 이미 센 인계를 건너뛴다.
    client.advanceClock(10);
    expect(state().storyApplied).toContain('van-cash-0032');
    expect(state().cashTransfers[0]!.confirmed?.countedAmount).toBe(30_000);
  });
});

describe('V6 돈통 점검 · 마감(closing.close)', () => {
  it('돈통 545,000원(차액 0원) → 마감 차례 `마감 · 12월 26일`, 바닥줄 `돈통 차액 0원`, 명령은 센 돈통 · 바탕(돈통 예상)', async () => {
    const { client } = at(540);
    const counted = await check(client, { date: DATE }, 'counter', '545000');
    expect(counted.pad).toMatchObject({ kind: 'drawer', title: '카운터 돈통', primary: { label: '돈통 점검 · 545,000원', enabled: true } });
    expect(counted.pad?.count).toEqual({ drawerId: 'counter', countedAmount: 545_000, expectedAmount: 545_000 });
    const view = await client.query('closingSheet', counted.params);
    const drawer = cashOf(view, 'drawer');
    expect(text(drawer.actual)).toBe('실제 545,000원 · 차액 0원');
    expect(drawer.action).toEqual({ key: 'recount', label: '재점검' });
    expect(view.next).toMatchObject({ kind: 'close', label: '마감 · 12월 26일', alts: ['마감 · 12월 26일', '마감'], enabled: true });
    expect(parts(view.footer)).toBe('수납 합계 1,965,000원 · 돈통 차액 0원');
    expect(view.command).toEqual({
      type: 'closing.close', payload: { date: DATE, drawerCounts: [{ drawerId: 'counter', countedAmount: 545_000, expectedAmount: 545_000 }], deferredTransferIds: [] },
    });
    expect(view.expect).toEqual({ expectedCash: { counter: 545_000 } });
  });

  it('마감: 얼린 줄 · `12월 26일 마감 완료` · 주 버튼 없음, 다시 보내면 `12월 26일 마감 완료`(이미 됨), 마감 뒤의 돈 · 인계는 다음 열린 날', async () => {
    const { client, state } = at(540);
    const counted = await check(client, { date: DATE }, 'counter', '545000');
    const ready = await client.query('closingSheet', counted.params);
    expect(await send(client, ready, ready.command, ready.expect)).toMatchObject({ outcome: 'applied' });
    expect(state().closings).toHaveLength(1);
    expect(state().closings[0]).toMatchObject({ date: DATE, closedAt: ms(0, 40, 1), counts: [{ drawerId: 'counter', expected: 545_000, counted: 545_000 }], deferredTransferIds: [] });
    const closed = await client.query('closingSheet', {});
    expect(closed.closed).toBe('12월 26일 마감 완료');
    expect(closed.next).toBeNull();
    expect(closed.command).toBeUndefined();
    expect(parts(closed.footer)).toBe('수납 합계 1,965,000원 · 돈통 차액 0원');
    expect(closed.cash.every((r) => !r.now && !r.action)).toBe(true);
    expect(text(cashOf(closed, 'drawer').actual)).toBe('실제 545,000원 · 차액 0원');
    expect(carryOf(closed)).toHaveLength(5);
    // 마감 뒤에 들어온 현금은 얼린 판에 들지 않는다(다음 열린 날의 몫).
    const s = state();
    applyCommand(s, { ...(await openEnvelope(s, { type: 'payment.take', payload: { orderIds: ['o28'], amount: 120_000, methodKey: 'cash' } }, { dueAmount: 120_000 })) }, ms(0, 50, 1));
    expect((await client.query('closingSheet', {})).methods.find((m) => m.key === 'cash')!.amount).toBe(440_000);
    const second = await send(client, closed, ready.command, ready.expect);
    expect(second).toMatchObject({ outcome: 'superseded', error: { message: '12월 26일 마감 완료' } });
    // 마감 뒤의 기록은 다음 열린 날(27일)에 올린다(posting date): 26일의 얼린 판 · 돈통 셈에 들지 않고 사라지지도 않는다.
    expect(postingDate(s, ms(0, 50, 1))).toBe('2026-12-27');
    expect(postingDate(s, ms(0, 30, 1))).toBe(DATE);
    const transfer = await send(client, closed, { type: 'cash.transfer', payload: { vehicleId: 'v1', amount: 5_000 } }, undefined);
    expect(transfer).toMatchObject({ outcome: 'applied' });
    expect(postingDate(state(), state().cashTransfers.at(-1)!.at)).toBe('2026-12-27');
    expect(walletLeft(state(), DATE, 'v1')).toBe(0);
  });

  it('마감이 막히는 것: 차량 현금 점검 전 · 돈통 셈 없음 · 차액 사유 없음 · 돈통 예상이 바뀜(충돌) · 센 뒤 예상이 바뀐 셈', async () => {
    const { client } = at(530);
    const base = { date: DATE };
    const close = (counts: ClosingSheetParams['counts'], deferred: string[] = []): ConfirmCommand => (
      { type: 'closing.close', payload: { date: DATE, drawerCounts: counts ?? [], deferredTransferIds: deferred } });
    const view = await client.query('closingSheet', base);
    expect(await send(client, view, close([]), { expectedCash: { counter: 510_000 } })).toMatchObject({ outcome: 'rejected', error: { message: '차량 현금 점검 필요' } });
    const key = 'story:van-2348:1';
    expect(await send(client, view, close([], [key]), { expectedCash: { counter: 510_000 } })).toMatchObject({ outcome: 'rejected', error: { message: '돈통 점검 필요' } });
    const diff = [{ drawerId: 'counter', countedAmount: 505_000, expectedAmount: 510_000 }];
    expect(await send(client, view, close(diff, [key]), { expectedCash: { counter: 510_000 } })).toMatchObject({ outcome: 'rejected', error: { message: '차액 −5,000원 · 사유 선택' } });
    const reasoned = [{ ...diff[0]!, reasonKey: 'change_error' }];
    expect(await send(client, view, close(reasoned, [key]), { expectedCash: { counter: 500_000 } })).toMatchObject({ outcome: 'conflict', error: { code: 'CASH_CHANGED' } });
    // 이월한 봉투를 오늘 세면 돈통 예상이 바뀐다(510,000 → 545,000): 앞의 셈은 다시 셀 차례.
    const deferredCount = withCount(withDefer(base, key), reasoned[0]!);
    const beforeVan = await client.query('closingSheet', deferredCount);
    expect(beforeVan.next).toMatchObject({ kind: 'close' });
    const van = await check(client, deferredCount, key, '35000');
    expect(van.outcome).toMatchObject({ outcome: 'applied' });
    const stale = await client.query('closingSheet', van.params);
    expect(van.params.deferredTransferIds).toEqual([]);
    expect(stale.next).toMatchObject({ kind: 'drawer_count', label: '돈통 점검' });
    const drawer = cashOf(stale, 'drawer');
    expect(drawer).toMatchObject({ now: true, action: { key: 'recount', label: '재점검' } });
    expect(text(drawer.actual)).toBe('실제 505,000원 · 차액 −40,000원');
    expect(parts(stale.footer)).toBe('수납 합계 1,965,000원 · 돈통 점검 필요');
    expect(await send(client, stale, close(reasoned), { expectedCash: { counter: 545_000 } })).toMatchObject({ outcome: 'rejected', error: { message: '돈통 점검 필요' } });
    // 재점검 540,000원 · 원인 불명 → 마감 차례, 바닥줄 돈통 차액 −5,000원.
    const recount = await check(client, van.params, 'counter', '540000', { reasonKey: 'unknown' });
    const ready = await client.query('closingSheet', recount.params);
    expect(ready.next).toMatchObject({ kind: 'close', enabled: true });
    expect(parts(ready.footer)).toBe('수납 합계 1,965,000원 · 돈통 차액 −5,000원');
    expect(await send(client, ready, ready.command, ready.expect)).toMatchObject({ outcome: 'applied' });
  });

  it('점검 이월한 채 마감: 인계는 확인하지 않은 채로 마감 판의 이월에 남고, 얼린 이월 항목에 `미확인 현금 인계`', async () => {
    const { client, state } = at(530);
    const key = 'story:van-2348:1';
    const deferred = withDefer({ date: DATE }, key);
    const counted = await check(client, deferred, 'counter', '510000');
    const ready = await client.query('closingSheet', counted.params);
    expect(ready.command).toMatchObject({ payload: { deferredTransferIds: [key] } });
    expect(await send(client, ready, ready.command, ready.expect)).toMatchObject({ outcome: 'applied' });
    expect(state().closings[0]!.deferredTransferIds).toEqual([key]);
    expect(state().cashTransfers[0]!.confirmed).toBeUndefined();
    const closed = await client.query('closingSheet', {});
    expect(carryOf(closed).at(-1)).toEqual(['미확인 현금 인계 · 35,000원', '1호 차량 · 23:48 입고', false]);
  });

  it('기사 기기에 보낼 것이 남으면 막힘: 차량 줄 `전송 대기 1`, 한 줄 `1호 차량 · 전송 대기 있음`, 마감 주 버튼 막힘 · 명령 거절', async () => {
    const { client, state } = at(540);
    client.setDevice('driver');
    client.setOffline(true);
    const list = await client.ledgerView('collection_list', { vehicleId: 'v1' });
    const taskId = list.rows[0]!.id;
    const queued = await client.command((await openEnvelope(state(), { type: 'route.move', payload: { taskId, anchorTaskId: null, position: 'top' } })));
    expect(queued.outcome).toBe('queued');
    client.setDevice('counter');
    const counted = await check(client, { date: DATE }, 'counter', '545000');
    const view = await client.query('closingSheet', counted.params);
    expect(parts(cashOf(view, 'van').note)).toBe('23:48 입고 · 전송 대기 1');
    expect(view.blocked).toBe('1호 차량 · 전송 대기 있음');
    expect(view.next).toMatchObject({ kind: 'close', enabled: false });
    expect(await send(client, view, view.command, view.expect)).toMatchObject({ outcome: 'rejected', error: { message: '1호 차량 · 전송 대기 있음' } });
  });

  it('체험 자료에 없는 날의 마감은 NOT_FOUND(화면은 `해당 없음`)', async () => {
    const { client } = at(0, false);
    await expect(client.query('closingSheet', { date: '2026-12-25' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(parseHash('#/closing/2026-12-26')).toEqual({ name: 'closing', date: DATE });
  });
});

describe('차량 현금 인계 · 부분 매장 입고(8단계 명령)', () => {
  it('인계하지 않은 지갑(17:00, 16:58 현장 수납 뒤): 줄 key `van:v1` · `입고 대기`, 점검 판이 인계 + 확인을 함께 적는다', async () => {
    const { client, state } = at(80);
    expect(walletLeft(state(), DATE, 'v1')).toBe(40_000);
    const view = await client.query('closingSheet', {});
    const van = cashOf(view, 'van');
    expect(van.key).toBe('van:v1');
    expect(parts(van.note)).toBe('입고 대기 · 전송 대기 0');
    expect(text(van.expected)).toBe('예상 40,000원');
    expect(view.next).toMatchObject({ kind: 'van_check', label: '차량 현금 점검 · 40,000원' });
    const done = await check(client, {}, 'van:v1', '40000');
    expect(done.outcome).toMatchObject({ outcome: 'applied' });
    expect(state().cashTransfers).toMatchObject([{ vehicleId: 'v1', amount: 40_000, at: ms(17, 0), confirmed: { countedAmount: 40_000 } }]);
    expect(walletLeft(state(), DATE, 'v1')).toBe(0);
    const after = await client.query('closingSheet', {});
    // 시재 100,000 + 카운터 현금 405,000 + 카운터 보증금 35,000(박준호 15,000 · 이민호 20,000) + 확인한 인계 40,000(차량 보증금 5,000 포함).
    expect(text(cashOf(after, 'drawer').expected)).toBe('예상 580,000원 · 보증금 40,000원 포함');
  });

  it('cash.transfer: 차량 지갑 → 넘기는 중(돈통 예상에는 확인한 뒤에야 든다), 금액이 없으면 거절', async () => {
    const { client, state } = at(80);
    const view = await client.query('closingSheet', {});
    expect(await send(client, view, { type: 'cash.transfer', payload: { vehicleId: 'v1', amount: 0 } }, undefined)).toMatchObject({ outcome: 'rejected' });
    expect(await send(client, view, { type: 'cash.transfer', payload: { vehicleId: 'v1', amount: 40_000 } }, undefined)).toMatchObject({ outcome: 'applied' });
    expect(walletLeft(state(), DATE, 'v1')).toBe(0);
    const after = await client.query('closingSheet', {});
    expect(after.cash.filter((r) => r.kind === 'van').map((r) => [r.key.startsWith('van:'), parts(r.note), text(r.actual)])).toEqual([[false, '17:00 입고 · 전송 대기 0', '미점검']]);
    expect(text(cashOf(after, 'drawer').expected)).toBe('');
  });

  it('부분 입고(stock.receive lines): 내려놓지 않은 것은 차에 남고 확인 필요 `김민수 팀 헬멧 1개 미입고`, 다시 입고하면 사라진다', async () => {
    const { client, state } = at(480);
    // 23:40: 22:00 · 22:10 수거 뒤, 23:48 입고 전.
    expect((await client.query('reviewList', {})).some((r) => r.kindKey === 'not_received')).toBe(false);
    client.advanceClock(10);
    expect(state().storyApplied).toContain('van-2348');
    const helmet = state().orders.find((o) => o.id === 'o25')!.lines.find((l) => l.id === 'o25-l2')!;
    expect([helmet.collected, helmet.received]).toEqual([2, 1]);
    expect(state().vanReceipts).toEqual([{ vehicleId: 'v1', at: ms(23, 48) }]);
    const reviews = await client.query('reviewList', {});
    expect(reviews.filter((r) => r.kindKey === 'not_received').map((r) => r.message)).toEqual(['김민수 팀 헬멧 1개 미입고']);
    const draft = await client.query('confirmDraft', { actionKey: 'receive_to_shop', vehicleId: 'v1' });
    expect(draft.confirmLabel).toBe('매장 입고 · 1개');
    expect(await send(client, draft, draft.command, draft.expect)).toMatchObject({ outcome: 'applied' });
    expect((await client.query('reviewList', {})).some((r) => r.kindKey === 'not_received')).toBe(false);
    expect((await client.query('closingSheet', {})).carry.some((c) => text(c.title).startsWith('확인 필요'))).toBe(false);
  });

  it('이야기 23:48 · 00:32는 이미 된 일을 건너뛴다(차에 남은 것이 없으면 입고 없음, 인계할 현금이 없으면 인계 없음)', () => {
    const state = at(0, false).state();
    const events = STORY.filter((e) => e.id === 'van-2348' || e.id === 'van-cash-0032');
    expect(events.map((e) => e.commands(state))).toEqual([[], []]);
    applyStory(state, ms(1, 0, 1), applyCommand, events);
    expect(state.cashTransfers).toEqual([]);
    expect(state.vanReceipts).toEqual([]);
  });
});

describe('V6 화면 도우미(칸 · 줄 높이 · 초안)', () => {
  const pos = DEVICE_PROFILES.pos;

  it('줄 높이(spec 3-7): 1024×600 73 · 68, 1024×569 65 · 62, 1024×529 55 · 54 — 세 크기 모두 한 쪽, 이월 항목 6이면 머리 52 · 두 쪽', () => {
    expect(closingLayout(pos, 600, { left: 4, carry: 5 })).toEqual({ leftRowPx: 73, leftPerPage: 5, carryRowPx: 68, carryPerPage: 5, carryHeadPx: 40 });
    expect(closingLayout(pos, 569, { left: 4, carry: 5 })).toMatchObject({ leftRowPx: 65, carryRowPx: 62, carryPerPage: 5 });
    expect(closingLayout(pos, 529, { left: 4, carry: 5 })).toMatchObject({ leftRowPx: 55, leftPerPage: 4, carryRowPx: 54, carryPerPage: 5 });
    expect(closingLayout(pos, 768, { left: 4, carry: 5 })).toMatchObject({ leftRowPx: 88, carryRowPx: 88 });
    expect(closingLayout(pos, 600, { left: 4, carry: 6 })).toMatchObject({ carryHeadPx: 52, carryRowPx: 66, carryPerPage: pos.pages.closingCarryRows });
    expect(closingLayout(pos, 529, { left: 4, carry: 6 })).toMatchObject({ carryHeadPx: 52, carryRowPx: 52, carryPerPage: 5 });
  });

  it('현금 점검 표의 칸: 1024 폭(왼쪽 600)은 시안 그대로, 좁은 포스(왼쪽 505 · 526)는 줄인 칸', () => {
    expect(closingColumns(pos, 600).compact).toBe(false);
    expect(closingColumns(pos, 816).compact).toBe(false);
    expect(closingColumns(pos, 526).compact).toBe(true);
    expect(closingColumns(pos, 505).compact).toBe(true);
    expect(closingColumns(pos, undefined).compact).toBe(false);
  });

  it('화면 초안: 셈은 돈통마다 하나(바꿈), 이월 넣고 빼기, 점검 판의 인자, 저장한 초안은 같은 날만', () => {
    const one = withCount({ date: DATE }, { drawerId: 'counter', countedAmount: 1 });
    expect(withCount(one, { drawerId: 'counter', countedAmount: 2 }).counts).toEqual([{ drawerId: 'counter', countedAmount: 2 }]);
    const deferred = withDefer(withDefer({}, 't1'), 't1');
    expect(deferred.deferredTransferIds).toEqual(['t1']);
    expect(withoutDefer(deferred, 't1').deferredTransferIds).toEqual([]);
    expect(withoutDefer({}, 't1')).toEqual({});
    expect(amountOf('')).toBeUndefined();
    expect(amountOf('505000')).toBe(505_000);
    expect(checkParams({ date: DATE }, 'counter', '', {})).toEqual({ date: DATE, check: { key: 'counter' } });
    expect(checkParams({ date: DATE }, 'counter', '12', { reasonKey: 'manual', reasonNote: '메모' })).toEqual({ date: DATE, check: { key: 'counter', countedAmount: 12, reasonKey: 'manual', reasonNote: '메모' } });
    const stored = { epoch: 'e', date: DATE, counts: [{ drawerId: 'counter', countedAmount: 5 }], deferredTransferIds: ['t1'] };
    expect(draftParams(DATE, stored)).toEqual({ date: DATE, counts: stored.counts, deferredTransferIds: ['t1'] });
    expect(draftParams('2026-12-25', stored)).toEqual({ date: '2026-12-25' });
    expect(draftParams(null, stored)).toEqual({});
  });
});

/** 지금 자료로 봉투 하나(시험의 명령). */
async function openEnvelope(state: FxState, command: ConfirmCommand, expect?: Expect) {
  const draft = openOrRestoreDraft(null, command, { epoch: state.epoch, rev: state.rev }, {});
  const envelope = envelopeFor(draft, command, expect);
  if (!envelope) throw new Error('봉투가 없다');
  return envelope;
}

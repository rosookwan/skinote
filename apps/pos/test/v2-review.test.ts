// 둘째 판 점검(2026-09-25 검토)의 고침: 체험 셈(돈 · 보증금 · 일정 몫 · 번호 · 마감)과 화면 판단(순수 함수)을 시험한다.
// 각 묶음의 이름이 검토 항목이다. 화면 효과의 판단(바로 보내기 · 초안 버리기 · 막힌 이어진 명령)은 순수 함수로 뽑아 여기서 본다.
import {
  draftToEnvelope, openCommandDraft, type CheckoutChoice, type CommandOutcome, type ConfirmCommand, type ConfirmDraftView, type Expect, type OrderDraftInput, type ReturnPieceLine,
  type RichText,
} from '@skinote/contract';
import { openOrRestoreDraft } from '@skinote/ui';
import { describe, expect, it } from 'vitest';
import { closingDraftStep } from '../src/screens/ClosingScreen.tsx';
import { autoSendStep } from '../src/screens/GroupPayScreen.tsx';
import { chainRetry, confirmEnvelope, draftOptions } from '../src/components/ConfirmFlow.tsx';
import { chainStep, returnPages } from '../src/components/ReturnDialog.tsx';
import { EMPTY_NEW_ORDER, hasDraft, withName, withQuantity } from '../src/app/new-order-draft.ts';
import { canOffset, depositOf, dueFor, type FxOrder, type FxState, heldAmount, heldNumbers, kstAt, moneyLateAt, othersDue, ownDue, type SampleShop, selfDue } from '@skinote/domain';
import { applyCommand } from '../src/fixture/demo.ts';
import { FixtureClient } from '../src/fixture/fixture-client.ts';

const ms = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const text = (runs: RichText) => runs.map((r) => r.text).join('');

/** 체험 시계를 15:40에서 minutes만큼(뒷이야기 켬이 기본: 16:40 = 60분). */
function at(minutes: number, story = true, shop: SampleShop = 'first') {
  const client = new FixtureClient({ realNow: () => 1_800_000_000_000, story, shop });
  client.advanceClock(minutes);
  const state = () => (client as unknown as { state: FxState }).state;
  return { client, state };
}

/** 체험 자료(state)에 명령 하나를 바로 적용한다(basis는 지금 자료). */
function apply(state: FxState, command: ConfirmCommand, extra: { expect?: Expect; dependsOn?: string[] } = {}, now = ms(16, 45)): CommandOutcome {
  return applyCommand(state, draftToEnvelope(openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, extra)), now);
}

/** 확인 창 초안 그대로 보낸다(연 때의 요청번호 · 바탕). */
async function confirmDraftSend(client: FixtureClient, view: ConfirmDraftView): Promise<CommandOutcome> {
  if (!view.command) throw new Error('보낼 명령이 없다: ' + (view.notice ?? ''));
  const draft = openOrRestoreDraft(null, view.command, view.basis, draftOptions(view));
  return client.command(confirmEnvelope(draft, view.command, null, null));
}

async function sendView(client: FixtureClient, view: { basis: { epoch: string; rev: number }; command?: ConfirmCommand; expect?: Expect }): Promise<CommandOutcome> {
  if (!view.command) throw new Error('보낼 명령이 없다');
  const draft = openCommandDraft(view.command, view.basis, view.expect ? { expect: view.expect } : {});
  return client.command(draftToEnvelope(draft));
}

const orderOf = (state: FxState, id: string): FxOrder => state.orders.find((o) => o.id === id)!;

/** 현장 접수 초안(대표자 · 연락처 · 품목). */
const walkIn = (name: string, phone: string, items: OrderDraftInput['items']): OrderDraftInput => ({
  channel: 'walk_in', leader: { name, phone, party: 0 }, items, pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' },
});

async function createOrder(client: FixtureClient, draft: OrderDraftInput, choices: CheckoutChoice[] = []): Promise<string> {
  const sheet = await client.query('checkoutSheet', { draft, choices });
  const outcome = await sendView(client, sheet);
  expect(outcome.outcome).toBe('applied');
  return (outcome.result as { orderId: string }).orderId;
}

describe('이 팀이 스스로 낼 미수(selfDue): 줄 단위 결제 약속이 섞인 팀', () => {
  it('장비는 이정호 팀 결제 예정 · 리프트권은 이 팀 후불: 수납 창은 리프트권만, 이정호 몫은 그대로, 마감 이월은 두 번 세지 않는다', async () => {
    const { client, state } = at(60);
    const id = await createOrder(client, walkIn('가족', '01000000091', [{ productKey: 'ski', quantity: 2 }, { productKey: 'night_adult', quantity: 2 }]), [
      { sectionKey: 'gear', methodKey: 'later', payerOrderId: 'o32' }, { sectionKey: 'lift', methodKey: 'later' },
    ]);
    const a = orderOf(state(), id);
    expect([ownDue(a), selfDue(a), dueFor(a, 'o32')]).toEqual([150_000, 70_000, 80_000]);
    const o32Before = othersDue(state(), orderOf(state(), 'o32'));
    const draft = await client.query('confirmDraft', { orderId: id, actionKey: 'pay' });
    expect(draft.summary).toEqual(['받을 금액 70,000원']);
    expect(draft.expect).toEqual({ dueAmount: 70_000 });
    expect((await confirmDraftSend(client, draft)).outcome).toBe('applied');
    // 이 팀 수납은 이 팀 줄(리프트권)만 채운다: 이정호 팀이 낼 장비 80,000원은 그대로.
    expect([selfDue(orderOf(state(), id)), dueFor(orderOf(state(), id), 'o32')]).toEqual([0, 80_000]);
    expect(othersDue(state(), orderOf(state(), 'o32'))).toBe(o32Before);
    // 장부 미수 탭 · 마감 이월: 이 팀은 스스로 낼 것이 없어 빠지고, 합은 모든 접수의 남은 돈과 같다(두 번 세지 않음).
    const ledger = await client.ledgerView('day_ledger', { tabKey: 'unpaid' });
    expect(ledger.rows.map((r) => r.orderId)).not.toContain(id);
    const closing = await client.query('closingSheet', {});
    const due = closing.carry.find((c) => c.key === 'due')!;
    const total = Number(/([\d,]+)원/.exec(text(due.title))![1]!.replace(/,/g, ''));
    expect(total).toBe(state().orders.reduce((n, o) => n + ownDue(o), 0));
  });

  it('미수 차감은 이 팀 몫으로만: 다른 팀이 이미 낸 줄에 결제 팀이 남아 있어도 이 팀 미수로 차감할 수 있다', () => {
    const { state } = at(0, false);
    const s = state();
    const park = orderOf(s, 'o22');
    // 선입금한 권 줄에 다른 팀 결제가 적혀 있어도(이미 다 냄) 이 팀 장비 미수 120,000원은 이 팀 몫이다.
    park.lines[3]!.payerOrderId = 'o32';
    expect(selfDue(park)).toBe(120_000);
    expect(canOffset(park, 20_000)).toBe(true);
    expect(canOffset(park, 130_000)).toBe(false);
  });
});

describe('돌려받지 않는 리프트권(반납 선택)에는 보증금이 없다', () => {
  it('보증금을 켠 매장이라도 반납 선택이면 접수 확정 창에 보증금 칸이 없고, 접수해도 보증금을 받지 않는다', async () => {
    const { client, state } = at(60, true, 'numbered');
    state().settings.liftReturnPolicy = 'optional';
    const draft = walkIn('반납선택', '01000000092', [{ productKey: 'ski', quantity: 2 }, { productKey: 'night_adult', quantity: 2 }]);
    const sheet = await client.query('checkoutSheet', { draft });
    expect(sheet.sections.map((s) => s.key)).toEqual(['gear', 'lift']);
    const id = await createOrder(client, draft);
    const o = orderOf(state(), id);
    expect(o.lines.find((l) => l.section === 'lift')?.returnable).toBe(false);
    expect(state().deposits.filter((d) => d.orderId === id)).toEqual([]);
  });
});

describe('현장 수납(field.collect)은 받을 돈을 넘지 않는다', () => {
  it('연결된 기기: 넘치면 거절 · 받을 돈이 없으면 거절. 전송 대기로 온 넘친 돈은 적고 확인 필요 `초과 수납`', async () => {
    const { client, state } = at(75);
    client.setDevice('driver');
    const collect = (amount: number): ConfirmCommand => ({ type: 'field.collect', payload: { taskId: 'deliver:o26', orderId: 'o26', amount, methodKey: 'cash' } });
    expect(apply(state(), collect(10_000), { expect: { dueAmount: 0 } }).error?.message).toBe('받을 금액 없음');
    const sheet = await client.query('addTicketSheet', { taskId: 'deliver:o26' });
    expect((await sendView(client, sheet)).outcome).toBe('applied');
    expect(apply(state(), collect(40_000), { expect: { dueAmount: 35_000 } })).toMatchObject({ outcome: 'rejected', error: { message: '초과 수납 · 받을 금액 35,000원' } });
    client.setOffline(true);
    const queued = await client.command(draftToEnvelope(openCommandDraft(collect(50_000), { epoch: state().epoch, rev: state().rev }, { expect: { dueAmount: 35_000 } })));
    expect(queued.outcome).toBe('queued');
    client.setOffline(false);
    const reviews = await client.query('reviewList', {});
    expect(reviews.find((r) => r.kindKey === 'overpaid')).toMatchObject({ orderId: 'o26', message: '최하은 팀 초과 수납 15,000원 · 환불 또는 다른 팀 이동' });
  });
});

describe('수납 · 번호 명령의 틀린 값', () => {
  it('0원 · 음수 · 소수 수납은 거절(카운터 수납 · 일괄 수납)', () => {
    const { state } = at(0, false);
    const take = (amount: number, payer?: string): ConfirmCommand => ({ type: 'payment.take', payload: { orderIds: ['o27'], amount, methodKey: 'cash', ...(payer ? { payerOrderId: payer } : {}) } });
    for (const amount of [0, -5_000, 1.5]) {
      expect(apply(state(), take(amount), { expect: { dueAmount: 65_000 } })).toMatchObject({ outcome: 'rejected', error: { message: '받을 금액 없음' } });
    }
    expect(apply(state(), take(-5_000, 'o27'), { expect: { dueAmount: 65_000 } }).outcome).toBe('rejected');
    expect(state().paymentGroups.every((g) => g.amount > 0)).toBe(true);
  });

  it('번호 매장: 같은 번호를 두 번 보내도 실물 하나: 반납 · 지급의 수는 서로 다른 번호의 수', () => {
    const { state } = at(0, false, 'numbered');
    const s = state();
    const ski = orderOf(s, 'o27').lines[0]!;
    const [first, second] = heldNumbers(ski);
    expect(apply(s, { type: 'stock.direct_return', payload: { orderId: 'o27', lines: [{ lineId: ski.id, quantity: 2, assetIds: [first!, first!] }] } }).outcome).toBe('applied');
    expect([ski.returned, ski.backAssetIds]).toEqual([1, [first]]);
    expect(heldNumbers(ski)).toEqual([second]);
    const park = orderOf(s, 'o22').lines[0]!;
    expect(apply(s, { type: 'stock.issue', payload: { orderId: 'o22', lines: [{ lineId: park.id, quantity: 2, assetIds: ['ski-17', 'ski-17'] }] } }).outcome).toBe('applied');
    expect([park.issued, park.assetIds]).toEqual([1, ['ski-17']]);
  });
});

describe('일괄 수납의 남은 줄 돌리기는 이 팀이 내기로 한 팀만', () => {
  it('미수 탭에서 더한 팀을 품목 일부만 내면 그 팀의 결제 시점(수령 때 · 늦음)은 그대로', async () => {
    const { client, state } = at(60);
    const yoon = orderOf(state(), 'o28');
    yoon.payWhen = 'pickup';
    const lateBefore = moneyLateAt(state(), yoon);
    expect(lateBefore).toBeLessThan(ms(16, 40));
    const view = await client.query('groupPaySheet', {
      orderId: 'o32', selected: ['o28'], added: ['o28'], parts: [{ orderId: 'o28', lines: [{ lineId: 'o28-l1', quantity: 1 }] }],
    });
    expect(view.total.amount).toBe(40_000);
    expect((await sendView(client, view)).outcome).toBe('applied');
    expect(orderOf(state(), 'o28').payWhen).toBe('pickup');
    expect(moneyLateAt(state(), orderOf(state(), 'o28'))).toBe(lateBefore);
  });
});

describe('접수증 · 처리 현황', () => {
  it('16:40 이정호 팀: 내일 반납은 지금 할 일이 아니다(주 버튼은 수납), 반납 창의 첫 줄은 `조기 반납 · 일정 내일 12:00`', async () => {
    const { client } = at(60);
    const slip = await client.query('orderSlip', { orderId: 'o32' });
    expect(slip.nextStep?.actionKey).toBe('stamp.pay');
    expect(slip.checklist.find((c) => c.stepKey === 'return')?.state).toBe('later');
    const sheet = await client.query('returnSheet', { orderId: 'o32' });
    expect(text(sheet.lead)).toBe('조기 반납 · 일정 내일 12:00');
  });

  it('부분 반납 뒤 차량 담당 줄은 돌아온 수를 함께(`2/3`): 21:35 박준호 헬멧 2 · 권 2매', async () => {
    const { client } = at(355);
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    const helmet = slip.lines.find((l) => l.id === 'o22-l3')!.cells['stamp:return'];
    expect(helmet).toMatchObject({ stamp: { state: 'delegated', delegatedTo: '1호 차량', progress: { done: 2, total: 3 } } });
    const board = slip.lines.find((l) => l.id === 'o22-l2')!.cells['stamp:return'];
    expect(board).toMatchObject({ stamp: { state: 'delegated' } });
    expect(board?.renderer === 'stamp' && board.stamp.progress).toBeFalsy();
  });

  it('연락처 · 인원을 적지 않은 현장 접수: 빈 연락처 칸 · `인원 0명` 없이, 일괄 수납한 팀은 `대납 395,000원 · 카드 485,000원`', async () => {
    const { client, state } = at(65);
    const id = await createOrder(client, walkIn('홍길동', '', [{ productKey: 'ski', quantity: 1 }]));
    const slip = await client.query('orderSlip', { orderId: id });
    expect(slip.fields.map((f) => f.key)).toEqual(['date', 'channel', 'name']);
    expect(slip.last4).toBe('');
    const payer = await client.query('orderSlip', { orderId: 'o32' });
    expect(payer.money.paidForOthers).toEqual({ amount: 395_000, methodLabel: '카드', total: 485_000 });
    expect(state().paymentGroups.find((g) => g.payerOrderId === 'o32')?.amount).toBe(485_000);
  });
});

describe('차량 재고 · 배달 목록', () => {
  it('16:55 1호 차량: 실은 배달 품목(최하은 스키 3 · 헬멧 3)과 예비권 6매가 차량 재고, 매장 입고 수는 수거한 것만. 배달 목록 주 버튼은 그 배달', async () => {
    const { client } = at(75);
    const list = await client.ledgerView('delivery_list', { vehicleId: 'v1' });
    expect(list.vehicleLoad?.byTask[0]).toEqual({ taskId: 'deliver:o26', teamName: '최하은', last4: '0026', items: [{ label: '스키', qty: 3 }, { label: '헬멧', qty: 3 }] });
    expect(list.vehicleLoad?.spareTickets).toEqual([{ label: '야간권', qty: 6, unit: '매' }]);
    // 차량 재고 = 실은 배달(스키 3 · 헬멧 3) + 16:30에 수거한 것(스키 2 · 의류 3 · 보드 2) + 예비권 6매. 매장 입고 수는 수거한 7개뿐.
    expect(list.vehicleLoad?.items).toEqual([
      { label: '스키', qty: 5 }, { label: '헬멧', qty: 3 }, { label: '의류', qty: 3 }, { label: '보드', qty: 2 }, { label: '예비권', qty: 6, unit: '매' },
    ]);
    expect(list.primaryFigure).toEqual({ count: 7 });
    expect(list.nextTask).toEqual({ taskId: 'deliver:o26', actionKey: 'stamp.issue', label: '배달 처리 · 6개', alts: ['배달 처리 · 6개', '배달 처리'], enabled: true });
    const deliver = await client.query('confirmDraft', { taskId: 'deliver:o26', actionKey: 'stamp.issue' });
    expect((await confirmDraftSend(client, deliver)).outcome).toBe('applied');
    const after = await client.ledgerView('delivery_list', { vehicleId: 'v1' });
    expect(after.nextTask).toEqual({ actionKey: 'stamp.issue', label: '배달 처리', alts: ['배달 처리'], enabled: false });
  });
});

describe('마감', () => {
  it('영업 중(15:40)에 마감하려면 먼저 묻는다: `26일 반납 예정 N개 · 1호 차량 미입고`, 27일 00:40에는 묻지 않는다', async () => {
    const early = at(0, false);
    const counted = await early.client.query('closingSheet', { check: { key: 'counter', countedAmount: 300_000 } });
    const count = counted.check?.count;
    expect(count).toBeDefined();
    const ready = await early.client.query('closingSheet', { counts: [count!] });
    expect(ready.next?.kind).toBe('close');
    expect(ready.confirm?.title).toBe('마감 · 12월 26일');
    expect(ready.confirm?.line).toMatch(/^26일 반납 예정 \d+개 · 1호 차량 미입고$/);
    const late = at(540);
    const lateCount = (await late.client.query('closingSheet', { check: { key: 'counter', countedAmount: 540_000 } })).check?.count;
    const lateReady = await late.client.query('closingSheet', { counts: [lateCount!] });
    expect(lateReady.next?.kind).toBe('close');
    expect(lateReady.confirm).toBeUndefined();
    // 마감하면 장부 제목 옆에 `마감 완료`.
    expect((await sendView(late.client, lateReady)).outcome).toBe('applied');
    expect((await late.client.ledgerView('day_ledger', {})).closedTag).toBe('마감 완료');
  });
});

describe('새 접수 초안', () => {
  it('품목은 있는데 대표자 이름이 없으면 까닭(`대표자 이름 필요`)과 대표자 칸 표시', async () => {
    const { client } = at(45);
    const view = await client.query('orderDraft', { draft: walkIn('', '', [{ productKey: 'ski', quantity: 1 }]) });
    expect(view.ready).toEqual({ items: false, schedule: false, itemsReason: '대표자 이름 필요', missing: 'name' });
    const named = await client.query('orderDraft', { draft: walkIn('가', '', [{ productKey: 'ski', quantity: 1 }]) });
    expect(named.ready.itemsReason).toBeUndefined();
  });

  it('예약 · 차량 배달 작은 창은 처음 값을 골라 둔 모양으로만 보인다(초안은 현장 접수 · 매장 직접 그대로)', async () => {
    const { client } = at(45);
    const view = await client.query('orderDraft', { draft: walkIn('가', '', [{ productKey: 'ski', quantity: 1 }]) });
    expect(view.schedule.pickup.find((o) => o.selected)?.key).toBe('now');
    expect(view.schedule.reserve.days?.find((d) => d.selected)?.key).toBe('tomorrow');
    expect(view.schedule.reserve.times.find((d) => d.selected)?.key).toBe('09:00');
    expect(view.schedule.reserve.place).toEqual({ mode: 'store' });
    expect(view.schedule.deliver.times.find((d) => d.selected)?.key).toBe('now');
    expect(view.channelTag).toBeUndefined();
  });

  it('남길 초안인지(hasDraft): 빈 초안은 아니고, 이름 · 품목 하나라도 있으면 남긴다', () => {
    expect(hasDraft(EMPTY_NEW_ORDER)).toBe(false);
    expect(hasDraft(withName(EMPTY_NEW_ORDER, '가'))).toBe(true);
    expect(hasDraft(withQuantity(EMPTY_NEW_ORDER, { productKey: 'ski' }, 1))).toBe(true);
  });
});

describe('막힌 이어진 명령을 창 안에서 다시(data-model 4-18)', () => {
  it('보증금 매장: 반납은 되었는데 보증금 반환이 막히면: 반납 창이 돌아온 권의 보증금만 다시 묻는다(새 요청번호), 처리 현황에 `보증금 반환 · 10,000원`', async () => {
    const { client, state } = at(340, true, 'numbered');
    const s = state();
    // 21:20 박준호: 권 두 매가 돌아왔는데(반납은 적용) 보증금 반환은 보내지 못했다.
    expect(apply(s, { type: 'stock.direct_return', payload: { orderId: 'o22', lines: [{ lineId: 'o22-l4', quantity: 2, assetIds: ['night_adult-31', 'night_adult-32'] }] } }, {}, ms(21, 20)).outcome).toBe('applied');
    expect(heldAmount(depositOf(s, 'o22', 'lift_ticket_card'))).toBe(15_000);
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.checklist.find((c) => c.stepKey === 'deposit_refund')).toMatchObject({ state: 'later', parts: [{ text: '보증금 반환' }, { text: '10,000원' }] });
    // 다른 줄이 아직 나가 있으면 반납 창의 보증금 줄이 돌아온 권 매수를 함께 돌려준다.
    const sheet = await client.query('returnSheet', { orderId: 'o22' });
    expect(text(sheet.deposit!)).toContain('권 3매 보증금 15,000원 반환');
    // 모두 돌아온 줄만 연 창: 돌려받을 것이 없고 보증금 반환 하나.
    const only = await client.query('returnSheet', { orderId: 'o22', lineIds: ['o22-l4'], picked: [{ lineId: 'o22-l4', quantity: 0, assetIds: [] }] });
    expect(only.command?.type).toBe('deposit.return');
    // 줄에는 권 한 매(33번)가 아직 나가 있지만 고르지 않았다: 돌아온 두 매의 보증금만.
    expect(only.primary.label).toBe('보증금 반환 · 10,000원');
    expect(only.expect).toEqual({ depositHeld: 15_000, dueAmount: 120_000 });
  });

  it('보증금 매장: 지급은 되었는데 보증금 입금이 막히면: 지급 창이 보증금 입금만 다시 묻는다', async () => {
    const { client, state } = at(0, false, 'numbered');
    const s = state();
    expect(apply(s, { type: 'stock.issue', payload: { orderId: 'o22', lines: [{ lineId: 'o22-l4', quantity: 3 }] } }, {}, ms(15, 45)).outcome).toBe('applied');
    const view = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue', lineIds: ['o22-l4'] });
    expect(view.command?.type).toBe('deposit.take');
    expect(view.confirmLabel).toBe('보증금 입금 · 15,000원');
    expect(chainRetry(view)).toBe('retry');
    expect((await confirmDraftSend(client, view)).outcome).toBe('applied');
    expect(heldAmount(depositOf(state(), 'o22', 'lift_ticket_card'))).toBe(15_000);
    expect(chainRetry(await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue', lineIds: ['o22-l4'] }))).toBe('spent');
  });

  it('화면 판단: 반납이 막혔으면 창을 닫고 다시(spent), 뒤의 보증금이 막혔으면 이 창에서 다시(retry)', () => {
    expect(chainStep(0, false)).toBe('spent');
    expect(chainStep(1, false)).toBe('retry');
    expect(chainStep(0, true)).toBe('retry');
    expect(chainRetry(null)).toBe('spent');
  });
});

describe('화면 효과의 판단(순수 함수)', () => {
  it('일괄 수납 `제외 후 수납`: 다시 물은 답에 보낼 것이 없으면 끄고(사람이 눌러야 보냄), 있으면 보낸다', () => {
    expect(autoSendStep({ autoSend: false, fresh: true, hasDraft: true, sendable: true })).toBe('wait');
    expect(autoSendStep({ autoSend: true, fresh: false, hasDraft: true, sendable: false })).toBe('wait');
    expect(autoSendStep({ autoSend: true, fresh: true, hasDraft: true, sendable: false })).toBe('cancel');
    expect(autoSendStep({ autoSend: true, fresh: true, hasDraft: true, sendable: true })).toBe('send');
  });

  it('마감 초안: 체험 자료를 초기화한 뒤 옛 초안은 한 번만 버리고, 그 뒤의 새 셈은 적는다', () => {
    expect(closingDraftStep({ closed: true, draftEpoch: 'a', viewEpoch: 'a', hasDraft: true })).toBe('clear');
    expect(closingDraftStep({ closed: false, draftEpoch: 'old', viewEpoch: 'new', hasDraft: true })).toBe('discard');
    // 버린 뒤에는 초안이 지금 자료의 것이다(draftEpoch = viewEpoch): 새 점검 이월 · 셈은 버리지 않는다.
    expect(closingDraftStep({ closed: false, draftEpoch: 'new', viewEpoch: 'new', hasDraft: true })).toBe('write');
    expect(closingDraftStep({ closed: false, draftEpoch: null, viewEpoch: 'new', hasDraft: true })).toBe('write');
  });

  it('반납 창의 쪽: 보증금을 맡은 줄(권)이 뒤 쪽이면 첫 쪽으로(④ 보증금 줄과 같은 쪽)', () => {
    const line = (lineId: string, pieces: number, deposit = false): ReturnPieceLine => ({
      lineId, label: lineId, note: '', mode: 'unit', muted: false, wide: pieces >= 4,
      pieces: Array.from({ length: pieces }, (_, i) => ({ assetId: lineId + i, label: i + '번', picked: true })), ...(deposit ? { deposit: true } : {}),
    });
    const lines = [line('ski', 4), line('c95', 2), line('c100', 1), line('helmet', 1), line('ticket', 4, true)];
    const pages = returnPages(lines, 3);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.flat().map((l) => l.lineId)).toContain('ticket');
    // 보증금 줄이 없으면 차례 그대로.
    const plain = returnPages(lines.map((l) => ({ ...l, deposit: false })), 3);
    expect(plain[0]!.flat()[0]!.lineId).toBe('ski');
  });
});

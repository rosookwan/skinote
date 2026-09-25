// 둘째 판 5단계(work/impl-v2/plan.md 5절 Step 5): V4 접수 확정 창 · 칸별 수납(spec 3-3, ui 4-5 · 6-4, catalog 15). 창은 칸마다 누른
// 수단 · 할인 · 결제 팀을 인자로 checkoutSheet를 다시 묻고, 서버(체험 자료)가 칸 글 · 결제 팀 줄 · 받을 금액 줄 · 주 버튼 · 명령을 쓴다.
// 확정은 order.create 하나(접수 · 품목 줄 · 일정 · 칸마다 돈 한 건 · 보증금 입금 · 결제 팀). 시안의 순간은 16:25 이민호 팀(스키 4 ·
// 의류 95 × 2 · 100 × 1 · 헬멧 중 1 · 야간권 성인 4매, 반납 오늘 22:00 매장 직접). 뒷이야기 16:26 ~ 16:35 새 접수 네 팀 · 21:55 반납.
import {
  CHECKOUT_KEYS, createdOrder, draftToEnvelope, openCommandDraft, type CheckoutSheetParams, type CheckoutSheetView, type CommandOutcome,
  type OrderDraftInput, type RichText,
} from '@skinote/contract';
import { openOrRestoreDraft } from '@skinote/ui';
import { describe, expect, it } from 'vitest';
import { checkoutEnvelope, choicesOf, withDiscount, withMethod, withPayer, withSectionPayer } from '../src/components/CheckoutDialog.tsx';
import { discountedAmounts, type FxOrder, type FxState, heldAmount, heldNumbers, kstAt, othersDue, ownDue } from '@skinote/domain';
import { applyCommand } from '../src/fixture/demo.ts';
import { FixtureClient } from '../src/fixture/fixture-client.ts';
import { STORY } from '../src/fixture/story.ts';

const ms = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const text = (runs: RichText) => runs.map((r) => r.text).join('');
const pick = <T extends { label: string; secondLine?: string; selected: boolean; enabled: boolean }>(options: readonly T[]) =>
  options.map((o) => o.label + (o.secondLine ? '/' + o.secondLine : '') + (o.selected ? '*' : '') + (o.enabled ? '' : '!'));

/** 체험 시계를 15:40에서 minutes만큼. 16:25 = 45분(뒷이야기는 기본으로 끔). */
function at(minutes: number, story = false) {
  let real = 1_800_000_000_000;
  const client = new FixtureClient({ realNow: () => real, story });
  client.advanceClock(minutes);
  const state = () => (client as unknown as { state: FxState }).state;
  return { client, state, pass: (m: number) => { real += m * 60_000; } };
}

/** 시안 V2 ~ V4의 초안(이민호 팀). */
const MINHO: OrderDraftInput = {
  channel: 'walk_in',
  leader: { name: '이민호', phone: '01000000042', party: 4 },
  items: [
    { productKey: 'ski', quantity: 4 }, { productKey: 'clothes', variantKey: '95', quantity: 2 }, { productKey: 'clothes', variantKey: '100', quantity: 1 },
    { productKey: 'helmet', variantKey: '중', quantity: 1 }, { productKey: 'night_adult', quantity: 4 },
  ],
  pickup: { mode: 'store', immediate: true },
  giveBack: { mode: 'store' },
};
/** 그린 상태: 장비 후불 → 결제 팀 이정호 · 0032, 리프트권 현금. */
const DRAWN: CheckoutSheetParams = {
  draft: MINHO, choices: [{ sectionKey: 'gear', methodKey: 'later' }, { sectionKey: 'lift', methodKey: 'cash' }], payerOrderId: 'o32',
};

/** 화면과 같은 길: 창을 연 때의 초안(요청번호 · basis) → 확정할 때 서버가 준 명령과 가격(expect)으로 봉투. */
async function confirm(client: FixtureClient, view: CheckoutSheetView, requestId?: string): Promise<CommandOutcome> {
  const draft = openOrRestoreDraft(null, { type: 'order.create', payload: { draft: MINHO, choices: [], payerOrderId: null } }, view.basis, requestId ? { requestId } : {});
  const envelope = checkoutEnvelope(draft, view);
  if (!envelope) throw new Error('보낼 명령이 없다');
  return client.command(envelope);
}

const orderOf = (state: FxState, last4: string): FxOrder => state.orders.find((o) => o.last4 === last4)!;

describe('V4 창의 읽기 모델(checkoutSheet) — 16:25 이민호 팀', () => {
  it('처음 연 상태(#card): 칸 셋(장비 · 리프트권 두 줄, 보증금 한 줄), 칸의 기본 수단(장비 카드 · 리프트권 현금), 결제 팀 줄은 자리만', async () => {
    const { client } = at(45);
    const view = await client.query('checkoutSheet', { draft: MINHO });
    expect(view.title).toBe('결제 · 이민호 팀');
    expect(view.sections.map((s) => [s.key, s.label, s.items, s.discount ?? '', s.amount, s.amountMuted, s.methods ? 'two' : 'one'])).toEqual([
      ['gear', '장비', '스키 4 · 의류 3 · 헬멧 1', '할인 없음', 225_000, false, 'two'],
      ['lift', '리프트권', '야간권 성인 4매', '할인 없음', 140_000, false, 'two'],
      ['lift_ticket_card', '리프트권 보증금', '4매 · 매장 기준 1매 5,000원 · 반납 시 반환', '', 20_000, false, 'one'],
    ]);
    expect(view.sections[0]?.itemList).toEqual(['스키 4', '의류 3', '헬멧 1']);
    expect(pick(view.sections[0]!.methods!)).toEqual(['카드*', '현금', '계좌이체', '후불', '기타']);
    expect(pick(view.sections[1]!.methods!)).toEqual(['카드', '현금*', '계좌이체', '후불', '기타']);
    expect(text(view.sections[2]!.single!)).toBe('현금 20,000원');
    expect(view.sections.map((s) => s.discountable)).toEqual([true, true, false]);
    expect(view.payer.visible).toBe(false);
    // 결제 팀 줄의 다른 팀은 이 창에서 고르거나 끝 4자리로 찾은 팀만(관련 없는 현장 접수에 남의 팀이 한 번 누름으로 걸리지 않게).
    expect(pick(view.payer.options)).toEqual(['이민호 · 0042*']);
    const found = await client.query('checkoutSheet', { draft: MINHO, foundPayerIds: ['o32'] });
    expect(pick(found.payer.options)).toEqual(['이민호 · 0042*', '이정호 · 0032']);
    expect(text(view.due)).toBe('받을 금액 카드 225,000원 · 현금 160,000원 (현금 중 보증금 20,000원)');
    expect(view.primary).toEqual({
      label: '접수 확정 · 카드 225,000원 · 현금 160,000원', alts: ['접수 확정 · 카드 225,000원 · 현금 160,000원', '접수 확정 · 385,000원', '접수 확정'], enabled: true,
    });
    expect(view.command?.type).toBe('order.create');
    expect(view.expect?.quoteHash).toMatch(/^quote:.*\|gear=225000,lift=140000$/);
    expect(view.notice).toBeUndefined();
  });

  it('그린 상태: 장비 후불 → 결제 팀 이정호 · 0032(파란 결제 예정 · 옅은 먹 금액), 받을 금액 현금 160,000원 = 리프트권 + 보증금', async () => {
    const { client } = at(45);
    const view = await client.query('checkoutSheet', DRAWN);
    const gear = view.sections[0]!;
    expect([gear.payerNote, gear.amountMuted, gear.amount]).toEqual(['이정호 팀 결제 예정', true, 225_000]);
    expect(pick(gear.methods!)).toEqual(['카드', '현금', '계좌이체', '후불*', '기타']);
    expect(view.payer).toEqual({
      visible: true, label: '장비 225,000원 · 결제 팀',
      options: [{ key: 'self', label: '이민호 · 0042', selected: false, enabled: true }, { key: 'o32', label: '이정호 · 0032', selected: true, enabled: true }],
    });
    expect(view.due).toEqual([
      { text: '받을 금액', strong: true }, { text: ' 현금 160,000원', strong: true }, { text: ' = 리프트권 140,000원 + 보증금 20,000원' },
    ]);
    expect(view.primary.label).toBe('접수 확정 · 현금 160,000원');
    expect(view.command).toMatchObject({ type: 'order.create', payload: { payerOrderId: 'o32', choices: [
      { sectionKey: 'gear', methodKey: 'later' }, { sectionKey: 'lift', methodKey: 'cash' }, { sectionKey: 'lift_ticket_card', methodKey: 'cash' },
    ] } });
    // 결제 팀 줄을 이 팀으로: 후불은 그대로, 결제 예정 글은 없다(이 팀 미수).
    const self = await client.query('checkoutSheet', { ...DRAWN, payerOrderId: null, foundPayerIds: ['o32'] });
    expect(self.sections[0]?.payerNote).toBeUndefined();
    expect(self.sections[0]?.amountMuted).toBe(true);
    expect(pick(self.payer.options)).toEqual(['이민호 · 0042*', '이정호 · 0032']);
    // 찾은 적 없는 팀은 이 팀으로 돌리면 사라진다(고른 팀만 남아 있었다).
    expect(pick((await client.query('checkoutSheet', { ...DRAWN, payerOrderId: null })).payer.options)).toEqual(['이민호 · 0042*']);
  });

  it('두 칸 모두 후불이면 결제 팀 줄이 두 칸을 적고, 보증금만 받는다', async () => {
    const { client } = at(45);
    const view = await client.query('checkoutSheet', { draft: MINHO, choices: [{ sectionKey: 'gear', methodKey: 'later' }, { sectionKey: 'lift', methodKey: 'later' }], payerOrderId: 'o32' });
    expect(view.payer.label).toBe('장비 · 리프트권 365,000원 · 결제 팀');
    expect(text(view.due)).toBe('받을 금액 현금 20,000원');
    expect(view.primary.label).toBe('접수 확정 · 현금 20,000원');
  });

  it('할인 적용: 칸마다 하나(10% · 10원 단위), 제목 줄 `10% 할인 · 225,000원 → 202,500원`, 가격(quoteHash)이 바뀐다', async () => {
    const { client } = at(45);
    const plain = await client.query('checkoutSheet', { draft: MINHO });
    expect(pick(plain.sections[0]!.discounts!)).toEqual(['할인 없음*', '10% 할인']);
    const view = await client.query('checkoutSheet', { draft: MINHO, choices: [{ sectionKey: 'gear', methodKey: 'card', discountKey: 'ten_percent' }] });
    expect([view.sections[0]?.discount, view.sections[0]?.discountShort, view.sections[0]?.amount]).toEqual(['10% 할인 · 225,000원 → 202,500원', '10% 할인', 202_500]);
    expect(pick(view.sections[0]!.discounts!)).toEqual(['할인 없음', '10% 할인*']);
    expect(view.primary.label).toBe('접수 확정 · 카드 202,500원 · 현금 160,000원');
    expect(view.expect?.quoteHash).not.toBe(plain.expect?.quoteHash);
    expect(view.expect?.quoteHash).toMatch(/gear-ten_percent=202500/);
    // 줄에 나눈 몫: 10원 단위, 끝전은 큰 줄부터, 합은 할인 뒤 금액.
    const shares = discountedAmounts([160_000, 40_000, 20_000, 5_000], 22_500);
    expect(shares).toEqual([144_000, 36_000, 18_000, 4_500]);
    expect(discountedAmounts([35_000, 35_000, 5_000], 7_500).reduce((a, b) => a + b, 0)).toBe(67_500);
    for (const n of discountedAmounts([33_330, 10_010, 5_000], 4_830)) expect(n % 10).toBe(0);
  });

  it('기타: 빠른 수단이 아닌 수단(간편결제 · 상품권)과 `다른 팀 결제`(이 칸만의 결제 팀)', async () => {
    const { client } = at(45);
    const easy = await client.query('checkoutSheet', { draft: MINHO, choices: [{ sectionKey: 'gear', methodKey: 'easy_pay' }] });
    expect(pick(easy.sections[0]!.methods!)).toEqual(['카드', '현금', '계좌이체', '후불', '기타/간편결제*']);
    expect(pick(easy.sections[0]!.others!)).toEqual(['간편결제*', '상품권', '다른 팀 결제']);
    expect(easy.sections[0]?.others?.[2]).toMatchObject({ key: CHECKOUT_KEYS.otherTeam, opens: true });
    expect(easy.primary.label).toBe('접수 확정 · 현금 160,000원 · 간편결제 225,000원');
    const team = await client.query('checkoutSheet', { draft: MINHO, choices: [{ sectionKey: 'gear', methodKey: 'later', payerOrderId: 'o32' }] });
    expect(pick(team.sections[0]!.methods!)).toEqual(['카드', '현금', '계좌이체', '후불', '기타/이정호 · 0032*']);
    expect(team.sections[0]?.payerNote).toBe('이정호 팀 결제 예정');
    // 이 칸만의 결제 팀이 있으면 결제 팀 줄에 걸 칸이 없다(자리만).
    expect(team.payer.visible).toBe(false);
    expect(team.command?.payload).toMatchObject({ choices: [{ sectionKey: 'gear', methodKey: 'later', payerOrderId: 'o32' }, { sectionKey: 'lift', methodKey: 'cash' }, { sectionKey: 'lift_ticket_card', methodKey: 'cash' }] });
  });

  it('전화 예약: 리프트권은 선입금 전액이라 후불을 누를 수 없고, 보증금 칸이 없다(지급 창이 묻는다)', async () => {
    const { client } = at(45);
    const phone: OrderDraftInput = { ...MINHO, channel: 'phone', pickup: { mode: 'store', day: 'tomorrow', time: '09:00' } };
    const view = await client.query('checkoutSheet', { draft: phone });
    expect(view.sections.map((s) => s.key)).toEqual(['gear', 'lift']);
    expect(pick(view.sections[1]!.methods!)).toEqual(['카드', '현금*', '계좌이체', '후불!', '기타']);
    expect(pick(view.sections[1]!.others!)).toEqual(['간편결제', '상품권']);
    const later = await client.query('checkoutSheet', { draft: phone, choices: [{ sectionKey: 'gear', methodKey: 'later' }, { sectionKey: 'lift', methodKey: 'later' }] });
    expect(later.primary.enabled).toBe(false);
    const all = await client.query('checkoutSheet', { draft: { ...phone, items: [{ productKey: 'ski', quantity: 1 }] }, choices: [{ sectionKey: 'gear', methodKey: 'later' }] });
    expect(text(all.due)).toBe('받을 금액 없음');
    expect(all.primary).toMatchObject({ label: '접수 확정', alts: ['접수 확정'], enabled: true });
  });

  it('그사이 반납 시각이 10분 안이 되면 확정할 수 없고 까닭 한 줄(주 버튼 흐림)', async () => {
    const { client } = at(45);
    // 16:25, 장비만: 처음 반납 시각 오후 16:30은 10분 안이라 내일로 간다. 사람이 오늘 16:30을 고른 초안(16:15에 고른 것)을 16:25에 연다.
    const draft: OrderDraftInput = { ...MINHO, items: [{ productKey: 'ski', quantity: 1 }], giveBack: { mode: 'store', slot: { day: 'today', slotKey: 'afternoon' } }, returnSet: { time: true } };
    const view = await client.query('checkoutSheet', { draft });
    expect(view.notice).toBe('선택 불가 · 10분 이내');
    expect(view.primary.enabled).toBe(false);
    expect(view.command).toBeUndefined();
  });
});

describe('접수 확정(order.create)', () => {
  it('시안대로 확정: 새 접수 261226-019(끝 4자리 0042), 규격마다 한 줄, 리프트권 현금 한 건 · 보증금 입금 20,000원 · 장비 이정호 팀 결제 예정', async () => {
    const { client, state } = at(46);
    const view = await client.query('checkoutSheet', DRAWN);
    const outcome = await confirm(client, view);
    expect(createdOrder(outcome)).toEqual({ orderId: 'n19', receiptNo: '261226-019' });
    const s = state();
    const o = s.orders.find((x) => x.id === 'n19')!;
    expect([o.receiptNo, o.teamName, o.last4, o.phone, o.channel, o.party, o.payerOrderId, o.payWhen]).toEqual(['261226-019', '이민호', '0042', '010-0000-0042', 'walk_in', 4, 'o32', 'pickup']);
    expect(o.lines.map((l) => [l.label, l.shortLabel, l.qty, l.amount, l.section, l.returnable, l.tracking, l.payerOrderId ?? '', l.issued])).toEqual([
      ['스키', '스키', 4, 160_000, 'gear', true, 'unit', 'o32', 0],
      ['의류 사이즈 95', '의류', 2, 40_000, 'gear', true, 'unit', 'o32', 0],
      ['의류 사이즈 100', '의류', 1, 20_000, 'gear', true, 'unit', 'o32', 0],
      ['헬멧 중 사이즈', '헬멧', 1, 5_000, 'gear', true, 'unit', 'o32', 0],
      ['야간권 성인', '야간권', 4, 140_000, 'lift', true, 'unit', '', 0],
    ]);
    expect([o.pickup, o.giveBack]).toEqual([{ at: ms(16, 26), mode: 'store' }, { at: ms(22, 0), mode: 'store' }]);
    expect(o.payments).toEqual([{ id: expect.stringMatching(/:lift$/), amount: 140_000, methodKey: 'cash', at: ms(16, 26), section: 'lift', groupId: expect.any(String), drawerId: 'counter' }]);
    expect(s.paymentGroups.at(-1)).toMatchObject({ purpose: 'intake_confirm', amount: 140_000, methodKey: 'cash', drawerId: 'counter' });
    const dep = s.deposits.find((d) => d.orderId === 'n19')!;
    expect(heldAmount(dep)).toBe(20_000);
    expect(dep.entries.map((e) => [e.kind, e.lineId, e.quantity, e.amount, e.drawerId])).toEqual([['take', 'n19-l5', 4, 20_000, 'counter']]);
    expect([ownDue(o), othersDue(s, s.orders.find((x) => x.id === 'o32')!)]).toEqual([225_000, 60_000 + 225_000]);
    expect(s.nextReceiptSeq).toBe(20);
    // 장부 · 접수증: 이정호 팀 결제 예정, 맡은 보증금, 품목 칸은 종류마다(의류 3).
    const ledger = await client.ledgerView('day_ledger', {});
    const row = ledger.rows.find((r) => r.id === 'n19')!;
    expect(row.cells['money']).toMatchObject({ alts: ['이정호 팀 결제 예정', '결제 예정'], tone: 'blue' });
    expect(row.cells['items']).toEqual({ renderer: 'items', items: [{ label: '스키', qty: 4 }, { label: '의류', qty: 3 }, { label: '헬멧', qty: 1 }, { label: '야간권', qty: 4, unit: '매' }] });
    const slip = await client.query('orderSlip', { orderId: 'n19' });
    expect(slip.money).toMatchObject({ charged: 365_000, paid: 140_000, due: 225_000, depositHeld: 20_000, promisedBy: { teamName: '이정호 팀', amount: 225_000 } });
    expect(slip.nextStep).toMatchObject({ stepKey: 'issue' });
  });

  it('같은 요청번호로 다시 보내면 같은 결과(접수가 둘이 되지 않는다)', async () => {
    const { client, state } = at(45);
    const view = await client.query('checkoutSheet', DRAWN);
    const first = await confirm(client, view, 'req-minho');
    const again = await confirm(client, view, 'req-minho');
    expect(createdOrder(again)).toEqual(createdOrder(first));
    expect(state().orders.filter((o) => o.last4 === '0042')).toHaveLength(1);
  });

  it('할인 · 섞인 수단: 칸마다 돈 한 건(카드 202,500 · 현금 140,000), 줄 값은 할인 뒤, 할인 기록', async () => {
    const { client, state } = at(45);
    const view = await client.query('checkoutSheet', { draft: MINHO, choices: [{ sectionKey: 'gear', methodKey: 'card', discountKey: 'ten_percent' }] });
    await confirm(client, view);
    const o = orderOf(state(), '0042');
    expect(o.payments.map((p) => [p.section, p.methodKey, p.amount, p.drawerId ?? ''])).toEqual([['gear', 'card', 202_500, ''], ['lift', 'cash', 140_000, 'counter']]);
    expect(o.lines.filter((l) => l.section === 'gear').reduce((sum, l) => sum + l.amount, 0)).toBe(202_500);
    expect(o.discounts).toEqual([{ sectionKey: 'gear', discountKey: 'ten_percent', label: '10% 할인', amount: 22_500, at: expect.any(Number) }]);
    expect(ownDue(o)).toBe(0);
  });

  it('이 팀 후불(매장 직접 · 즉시)은 반납 때 받는다: 미수는 이 팀, 결제 팀 없음', async () => {
    const { client, state } = at(45);
    const view = await client.query('checkoutSheet', { draft: MINHO, choices: [{ sectionKey: 'gear', methodKey: 'later' }] });
    await confirm(client, view);
    const o = orderOf(state(), '0042');
    expect([o.payerOrderId, o.payWhen, ownDue(o)]).toEqual([undefined, 'return', 225_000]);
    expect(o.lines.every((l) => l.payerOrderId === undefined)).toBe(true);
  });

  it('창이 본 가격이 다르면 충돌, 가격이 없으면 거절, 틀린 수단은 거절(접수가 생기지 않음)', () => {
    const { state } = at(45);
    const s = state();
    const send = (payload: Extract<import('@skinote/contract').ConfirmCommand, { type: 'order.create' }>['payload'], expect?: { quoteHash?: string }) =>
      applyCommand(s, draftToEnvelope(openCommandDraft({ type: 'order.create', payload }, { epoch: s.epoch, rev: s.rev }, expect ? { expect } : {})), ms(16, 25));
    const payload = { draft: MINHO, choices: [{ sectionKey: 'gear', methodKey: 'card' }, { sectionKey: 'lift', methodKey: 'cash' }], payerOrderId: null };
    expect(send(payload, { quoteHash: 'quote:old' })).toMatchObject({ outcome: 'conflict', error: { code: 'QUOTE_CHANGED', message: '받을 금액 변경됨 · 재시도 필요' } });
    expect(send(payload)).toMatchObject({ outcome: 'rejected', error: { code: 'EXPECT_REQUIRED' } });
    expect(send({ ...payload, choices: [{ sectionKey: 'gear', methodKey: 'bitcoin' }] }, { quoteHash: 'x' })).toMatchObject({ outcome: 'rejected', error: { message: '등록되지 않은 결제 수단' } });
    expect(send({ ...payload, payerOrderId: 'o99' }, { quoteHash: 'x' })).toMatchObject({ outcome: 'rejected', error: { message: '체험판 미지원' } });
    expect(s.orders.some((o) => o.last4 === '0042')).toBe(false);
    expect(s.nextReceiptSeq).toBe(19);
  });

  it('지급: 같은 종류의 줄 둘(의류 95 · 100)도 번호가 겹치지 않고, 권 4매는 보증금을 다시 묻지 않는다', async () => {
    const { client, state } = at(45);
    await confirm(client, await client.query('checkoutSheet', DRAWN));
    const draft = await client.query('confirmDraft', { orderId: 'n19', actionKey: 'stamp.issue' });
    expect(draft.then).toBeUndefined();
    expect(draft.confirmLabel).toBe('지급 처리 · 8개 · 4매');
    const s = state();
    applyCommand(s, draftToEnvelope(openCommandDraft(draft.command!, draft.basis)), ms(16, 27));
    const o = s.orders.find((x) => x.id === 'n19')!;
    const numbers = o.lines.flatMap((l) => heldNumbers(l));
    expect(numbers).toHaveLength(12);
    expect(new Set(numbers).size).toBe(12);
    expect(o.lines.find((l) => l.label === '의류 사이즈 100')?.assetIds).toHaveLength(1);
  });
});

describe('창의 고른 것 → 다시 물을 인자(CheckoutDialog 도우미)', () => {
  it('처음 누르면 창이 보인 선택에서 한 칸만 바꾸고, 할인 · 이 칸만의 팀 · 결제 팀 줄', async () => {
    const { client } = at(45);
    const params: CheckoutSheetParams = { draft: MINHO };
    const view = await client.query('checkoutSheet', params);
    expect(choicesOf(params, view)).toEqual([{ sectionKey: 'gear', methodKey: 'card' }, { sectionKey: 'lift', methodKey: 'cash' }, { sectionKey: 'lift_ticket_card', methodKey: 'cash' }]);
    const later = withMethod(params, view, 'gear', CHECKOUT_KEYS.later);
    expect(later.choices?.[0]).toEqual({ sectionKey: 'gear', methodKey: 'later' });
    const discounted = withDiscount(later, view, 'gear', 'ten_percent');
    expect(discounted.choices?.[0]).toEqual({ sectionKey: 'gear', methodKey: 'later', discountKey: 'ten_percent' });
    expect(withDiscount(discounted, view, 'gear', CHECKOUT_KEYS.noDiscount).choices?.[0]).toEqual({ sectionKey: 'gear', methodKey: 'later' });
    expect(withSectionPayer(discounted, view, 'lift', 'o32').choices?.[1]).toEqual({ sectionKey: 'lift', methodKey: 'later', payerOrderId: 'o32' });
    expect(withMethod(withSectionPayer(discounted, view, 'lift', 'o32'), view, 'lift', 'cash').choices?.[1]).toEqual({ sectionKey: 'lift', methodKey: 'cash' });
    expect(withPayer(later, 'o32').payerOrderId).toBe('o32');
    expect(withPayer(later, CHECKOUT_KEYS.self).payerOrderId).toBeNull();
  });

  it('확정 봉투: 연 때의 요청번호 · basis에 지금 명령과 그때 본 가격', async () => {
    const { client } = at(45);
    const view = await client.query('checkoutSheet', DRAWN);
    const draft = openOrRestoreDraft(null, { type: 'order.create', payload: { draft: MINHO, choices: [], payerOrderId: null } }, view.basis, { requestId: 'r1' });
    const envelope = checkoutEnvelope(draft, view)!;
    expect([envelope.type, envelope.requestId, envelope.expect]).toEqual(['order.create', 'r1', view.expect]);
    expect(envelope.payload).toEqual(view.command?.payload);
    expect(checkoutEnvelope(draft, { ...view, command: undefined } as unknown as CheckoutSheetView)).toBeNull();
  });
});

describe('뒷이야기 16:26 ~ 16:35 · 21:55(plan.md 4-2)', () => {
  it('16:40: 새 접수 네 팀(0042 ~ 0045) 지급, 장비는 모두 이정호 팀 결제 예정 → 이정호 팀 받을 금액 485,000원(6팀)', async () => {
    const { client, state } = at(60, true);
    const s = state();
    expect(['0042', '0043', '0044', '0045'].map((last4) => { const o = orderOf(s, last4); return [o.receiptNo, o.teamName, o.payerOrderId, ownDue(o), o.lines.every((l) => l.issued === l.qty)]; })).toEqual([
      ['261226-019', '이민호', 'o32', 225_000, true], ['261226-020', '강지은', 'o32', 45_000, true],
      ['261226-021', '이준서', 'o32', 40_000, true], ['261226-022', '송하윤', 'o32', 25_000, true],
    ]);
    expect(['0043', '0044', '0045'].map((last4) => orderOf(s, last4).giveBack)).toEqual(Array(3).fill({ at: ms(22, 0), mode: 'vehicle', placeId: 'seolcheon_parking', vehicleId: 'v1' }));
    const jungho = s.orders.find((o) => o.id === 'o32')!;
    expect(ownDue(jungho) + othersDue(s, jungho)).toBe(485_000);
    const slip = await client.query('orderSlip', { orderId: 'o32' });
    expect(slip.money).toMatchObject({ collectTotal: 485_000 });
    expect(heldAmount(s.deposits.find((d) => d.orderId === orderOf(s, '0042').id))).toBe(20_000);
    expect(s.storyApplied).toEqual(expect.arrayContaining(['minho-order', 'minho-issue', 'jieun-order', 'jieun-issue', 'junseo-order', 'junseo-issue', 'hayun-order', 'hayun-issue']));
  });

  it('22:00: 이민호 팀 매장 반납(권 4매 포함) + 보증금 20,000원 현금 반환(카운터 돈통)', () => {
    const { state } = at(6 * 60 + 20, true);
    const s = state();
    const o = orderOf(s, '0042');
    expect(o.lines.every((l) => l.returned === l.qty)).toBe(true);
    const dep = s.deposits.find((d) => d.orderId === o.id)!;
    expect(heldAmount(dep)).toBe(0);
    expect(dep.entries.map((e) => [e.kind, e.amount, e.drawerId, e.at])).toEqual([['take', 20_000, 'counter', ms(16, 26)], ['refund', 20_000, 'counter', ms(21, 55)]]);
  });

  it('사람이 먼저 이민호 팀을 접수했으면 사건은 건너뛴다(접수가 둘이 되지 않는다)', async () => {
    const { client, state, pass } = at(45, true);
    await confirm(client, await client.query('checkoutSheet', DRAWN));
    pass(0);
    client.advanceClock(10);
    const s = state();
    expect(s.orders.filter((o) => o.last4 === '0042')).toHaveLength(1);
    expect(s.outcomes['story:minho-order:0']).toBeUndefined();
    expect(s.storyApplied).toContain('minho-order');
    expect(STORY.find((e) => e.id === 'minho-order')?.at).toBe(ms(16, 26));
  });
});

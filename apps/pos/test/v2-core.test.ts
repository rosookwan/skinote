// 둘째 판 1단계(work/impl-v2/plan.md 5절 Step 1): 체험 자료의 바탕 규칙 — 리프트권 반납 필수, 번호(지급 · 반납 · 수거 · 적재),
// 보증금 입금(지급 창이 먼저 묻는 권 보증금), 이어진 명령(then · dependsOn), 영업일 기준 시각 · 반납 타임, 뒷이야기 16:05 ~ 21:50.
import {
  defaultUiConfig, draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type CommandOutcome, type ConfirmCommand, type ConfirmDraftView, type Expect,
} from '@skinote/contract';
import { openOrRestoreDraft } from '@skinote/ui';
import { describe, expect, it } from 'vitest';
import { chainDrafts, chainGoesOn, confirmEnvelope, draftOptions, sendChain } from '../src/components/ConfirmFlow.tsx';
import { assetId, depositOf, type FxState, heldAmount, heldNumbers, heldUnits, kstAt, lastReturnSlotAt, liftReturnable, nightPrepSlotAt, orderSlip, routeTasks, when } from '@skinote/domain';
import { SHOP_RULES } from '@skinote/domain/sample';
import { applyCommand, createSeed } from '../src/fixture/demo.ts';
import { FixtureClient } from '../src/fixture/fixture-client.ts';
import { STORY } from '../src/fixture/story.ts';

const ms = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const iso = (h: number, m: number, day = 0) => new Date(ms(h, m, day)).toISOString();

function setup(options: { story?: boolean } = {}) {
  let real = 1_800_000_000_000;
  const client = new FixtureClient({ realNow: () => real, ...options });
  return { client, pass: (minutes: number) => { real += minutes * 60_000; } };
}

/** 체험 자료(state)에 명령 하나를 바로 적용한다(basis는 지금 자료). */
function apply(state: FxState, command: ConfirmCommand, extra: { expect?: Expect; dependsOn?: string[]; requestId?: string } = {}, at = ms(16, 0)): CommandOutcome {
  const envelope = draftToEnvelope(openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, extra));
  return applyCommand(state, envelope, at);
}

const line = (state: FxState, id: string) => {
  const hit = state.orders.flatMap((o) => o.lines).find((l) => l.id === id);
  if (!hit) throw new Error('줄이 없다: ' + id);
  return hit;
};

/** 번호와 수 셈이 맞는지: 지급 수 = 번호 수, 돌아온 수 = 돌아온 번호 수, 돌아온 번호는 준 번호 안, 두 곳에 나간 번호 없음. */
function expectNumbersConsistent(state: FxState) {
  const out: string[] = [];
  for (const l of state.orders.flatMap((o) => o.lines)) {
    if ((l.tracking ?? 'unit') !== 'unit') continue;
    expect(l.assetIds ?? [], l.id).toHaveLength(l.issued);
    expect(l.backAssetIds ?? [], l.id).toHaveLength(l.returned + l.collected);
    for (const id of l.backAssetIds ?? []) expect(l.assetIds, l.id).toContain(id);
    out.push(...heldNumbers(l));
  }
  expect(new Set(out).size).toBe(out.length);
}

/** 화면과 같은 길: 창을 연 때의 초안 + 이어진 명령의 초안 → 첫 명령 → 이어진 명령(ConfirmFlow의 함수 그대로). */
async function confirmAll(client: FixtureClient, view: ConfirmDraftView) {
  if (!view.command) throw new Error('확정할 명령이 없다: ' + view.notice);
  const draft = openOrRestoreDraft(null, view.command, view.basis, draftOptions(view));
  const chain = chainDrafts(draft, view.then);
  const first = await client.command(confirmEnvelope(draft, view.command, null, null));
  const stopped = chainGoesOn(first) ? await sendChain((e) => client.command(e), chain) : first;
  return { draft, chain, first, stopped };
}

describe('리프트권 반납 필수(운영 규칙 → 줄에 복사)', () => {
  it('이 매장은 반납 필수: 권 줄도 반납 줄이고, 반납 선택 매장이면 반납 칸이 없다', () => {
    const state = createSeed('e');
    expect(line(state, 'o22-l4')).toMatchObject({ section: 'lift', returnable: true, tracking: 'unit', unit: '매' });
    expect(liftReturnable(SHOP_RULES)).toBe(true);
    expect(liftReturnable({ liftReturnPolicy: 'optional' })).toBe(false);
  });

  it('지급한 권은 반납 도장 · 수거 목록 품목 · 처리 현황의 반납 수에 들어간다', async () => {
    const { client } = setup();
    const view = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' });
    await confirmAll(client, view);
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.lines.map((l) => (l.cells['stamp:return']?.renderer === 'stamp' ? l.cells['stamp:return'].stamp.state : null))).toEqual(['delegated', 'delegated', 'delegated', 'delegated']);
    const list = await client.ledgerView('collection_list', { vehicleId: 'v1' });
    const park = list.rows.find((r) => r.id === 'collect:o22')!;
    expect(park.cells['items']).toMatchObject({ items: [{ label: '스키', qty: 2 }, { label: '보드', qty: 1 }, { label: '헬멧', qty: 3 }, { label: '야간권', qty: 3, unit: '매' }] });
    // 수거 확인 창도 권을 함께 센다(개 + 매). 맡은 보증금이 있는 권은 수거 현장에서 돌려드린다(7단계: field.deposit_return, spec 3-8).
    const collect = await client.query('confirmDraft', { taskId: 'collect:o22', actionKey: 'stamp.collect' });
    expect(collect.confirmLabel).toBe('수거 처리 · 6개 · 3매 · 보증금 15,000원');
    expect(collect.summary.at(-1)).toBe('권 3매 보증금 15,000원 반환 · 차량 현금');
  });
});

describe('번호(스티커 · 권 번호)', () => {
  it('지급: 준비 번호부터(박준호 팀은 시안 V1의 번호), 없으면 매장 재고의 가장 낮은 빈 번호', () => {
    const state = createSeed('e');
    expect(apply(state, { type: 'stock.issue', payload: { orderId: 'o22', lines: state.orders.find((o) => o.id === 'o22')!.lines.map((l) => ({ lineId: l.id, quantity: l.qty })) } }).outcome).toBe('applied');
    expect(line(state, 'o22-l1').assetIds).toEqual(['ski-17', 'ski-18']);
    expect(line(state, 'o22-l3').assetIds).toEqual(['helmet-12', 'helmet-14', 'helmet-15']);
    expect(line(state, 'o22-l4').assetIds).toEqual(['night_adult-31', 'night_adult-32', 'night_adult-33']);
    // 이정호 팀(준비 번호 없음): 지금 손님에게 나가 있지 않고 다른 팀이 준비해 두지 않은 가장 낮은 번호.
    apply(state, { type: 'stock.issue', payload: { orderId: 'o32', lines: [{ lineId: 'o32-l1', quantity: 2 }] } });
    const taken = new Set(state.orders.flatMap((o) => o.lines).filter((l) => l.id !== 'o32-l1').flatMap((l) => heldNumbers(l)));
    const ski = line(state, 'o32-l1').assetIds!;
    expect(ski).toHaveLength(2);
    for (const id of ski) expect(taken.has(id)).toBe(false);
    expectNumbersConsistent(state);
  });

  it('지급할 번호를 사람이 고르면 그 번호(수도 그만큼), 다른 팀에 나가 있는 번호는 거절', () => {
    const state = createSeed('e');
    const outside = line(state, 'o21-l1').assetIds![0]!;
    const refused = apply(state, { type: 'stock.issue', payload: { orderId: 'o32', lines: [{ lineId: 'o32-l1', quantity: 2, assetIds: [outside] }] } });
    expect(refused).toMatchObject({ outcome: 'rejected', error: { message: '장비 위치 불일치' } });
    expect(line(state, 'o32-l1').issued).toBe(0);
    expect(apply(state, { type: 'stock.issue', payload: { orderId: 'o32', lines: [{ lineId: 'o32-l1', quantity: 2, assetIds: [assetId('ski', '39')] }] } }).outcome).toBe('applied');
    expect(line(state, 'o32-l1')).toMatchObject({ issued: 1, assetIds: ['ski-39'] });
    expectNumbersConsistent(state);
  });

  it('반납: 고른 번호만 돌아오고 수가 따라간다, 이미 돌아온 번호는 반납 완료(superseded), 준 적 없는 번호는 거절', () => {
    const state = createSeed('e');
    apply(state, { type: 'stock.issue', payload: { orderId: 'o22', lines: [{ lineId: 'o22-l3', quantity: 3 }, { lineId: 'o22-l4', quantity: 3 }] } });
    const back = apply(state, { type: 'stock.direct_return', payload: { orderId: 'o22', lines: [{ lineId: 'o22-l3', quantity: 3, assetIds: ['helmet-12', 'helmet-14'] }] } });
    expect(back.outcome).toBe('applied');
    expect(line(state, 'o22-l3')).toMatchObject({ returned: 2, backAssetIds: ['helmet-12', 'helmet-14'] });
    expect(heldNumbers(line(state, 'o22-l3'))).toEqual(['helmet-15']);
    const again = apply(state, { type: 'stock.direct_return', payload: { orderId: 'o22', lines: [{ lineId: 'o22-l3', quantity: 1, assetIds: ['helmet-12'] }] } });
    expect(again).toMatchObject({ outcome: 'superseded', error: { message: '반납 완료' } });
    const wrong = apply(state, { type: 'stock.direct_return', payload: { orderId: 'o22', lines: [{ lineId: 'o22-l4', quantity: 1, assetIds: ['night_adult-40'] }] } });
    expect(wrong).toMatchObject({ outcome: 'rejected', error: { message: '장비 위치 불일치' } });
    // 번호 없이 보내면 내준 번호를 지급한 차례로.
    apply(state, { type: 'stock.direct_return', payload: { orderId: 'o22', lines: [{ lineId: 'o22-l4', quantity: 2 }] } });
    expect(line(state, 'o22-l4').backAssetIds).toEqual(['night_adult-31', 'night_adult-32']);
    expectNumbersConsistent(state);
  });

  it('수거 · 적재도 번호: 적재한 번호가 준비 번호가 되고 차량 배달의 지급은 그 번호', () => {
    const state = createSeed('e');
    apply(state, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: [{ lineId: 'o25-l2', quantity: 1 }] } });
    expect(line(state, 'o25-l2').backAssetIds).toEqual([line(state, 'o25-l2').assetIds![0]]);
    expect(apply(state, { type: 'stock.load', payload: { taskId: 'deliver:o26', lines: [{ lineId: 'o26-l1', quantity: 3 }, { lineId: 'o26-l2', quantity: 3 }] } }).outcome).toBe('applied');
    const loaded = line(state, 'o26-l1').plannedAssetIds!;
    expect(loaded).toHaveLength(3);
    apply(state, { type: 'stock.issue', payload: { orderId: 'o26', lines: [{ lineId: 'o26-l1', quantity: 3 }] } });
    expect(line(state, 'o26-l1').assetIds).toEqual(loaded);
    expectNumbersConsistent(state);
  });
});

describe('보증금 입금(deposit.take)', () => {
  const take = (lines: { lineId: string; quantity: number }[], amount: number, methodKey = 'cash'): ConfirmCommand =>
    ({ type: 'deposit.take', payload: { orderId: 'o22', ruleKey: 'lift_ticket_card', lines, amount, methodKey } });

  it('바탕(expect.depositHeld)이 없으면 거절, 다르면 충돌, 수단 · 매수 · 금액이 맞지 않으면 거절', () => {
    const state = createSeed('e');
    expect(apply(state, take([{ lineId: 'o22-l4', quantity: 3 }], 15_000)).error?.code).toBe('EXPECT_REQUIRED');
    expect(apply(state, take([{ lineId: 'o22-l4', quantity: 3 }], 15_000), { expect: { depositHeld: 5_000 } })).toMatchObject({ outcome: 'conflict', error: { code: 'DEPOSIT_CHANGED', message: '보증금 변경됨 · 재시도 필요' } });
    expect(apply(state, take([{ lineId: 'o22-l4', quantity: 3 }], 15_000, 'card'), { expect: { depositHeld: 0 } }).error?.message).toBe('등록되지 않은 결제 수단');
    expect(apply(state, take([{ lineId: 'o22-l4', quantity: 4 }], 20_000), { expect: { depositHeld: 0 } }).error?.message).toBe('보증금 입금 불가 · 권 매수 초과');
    expect(apply(state, take([{ lineId: 'o22-l1', quantity: 1 }], 5_000), { expect: { depositHeld: 0 } }).error?.message).toBe('보증금 입금 불가 · 권 매수 없음');
    expect(apply(state, take([{ lineId: 'o22-l4', quantity: 3 }], 10_000), { expect: { depositHeld: 0 } }).error?.message).toBe('보증금 금액 불일치');
    expect(state.deposits).toEqual([]);
  });

  it('받으면 팀 · 규칙마다 보관 하나(규칙 값 복사), 돈은 보증금 장부(카운터 돈통)이고 수납 · 미수는 그대로', async () => {
    const state = createSeed('e');
    apply(state, { type: 'stock.issue', payload: { orderId: 'o22', lines: [{ lineId: 'o22-l4', quantity: 3 }] } });
    expect(apply(state, take([{ lineId: 'o22-l4', quantity: 3 }], 15_000), { expect: { depositHeld: 0 }, requestId: 'dep-1' }, ms(16, 5)).outcome).toBe('applied');
    const dep = depositOf(state, 'o22', 'lift_ticket_card')!;
    expect(dep).toMatchObject({ orderId: 'o22', label: '리프트권 보증금', unitAmount: 5_000 });
    expect(dep.entries).toEqual([{
      id: 'dep-1:0', kind: 'take', lineId: 'o22-l4', quantity: 3, amount: 15_000, methodKey: 'cash', drawerId: 'counter', at: ms(16, 5),
      assetIds: ['night_adult-31', 'night_adult-32', 'night_adult-33'],
    }]);
    expect(heldAmount(dep)).toBe(15_000);
    expect(heldUnits(dep, 'o22-l4')).toBe(3);
    const park = state.orders.find((o) => o.id === 'o22')!;
    expect(park.payments.map((p) => p.amount)).toEqual([105_000]);
    // 더 받을 매수가 없다.
    expect(apply(state, take([{ lineId: 'o22-l4', quantity: 1 }], 5_000), { expect: { depositHeld: 15_000 } }).error?.message).toBe('보증금 입금 불가 · 권 매수 초과');
  });
});

describe('지급 창이 먼저 묻는 보증금 · 이어진 명령', () => {
  it('확정하면 지급 → 보증금 입금(dependsOn), 접수증 돈 줄에 보증금 15,000원, 다시 열면 보증금을 묻지 않는다', async () => {
    const { client, pass } = setup();
    const view = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' });
    pass(25);
    const { draft, chain, first, stopped } = await confirmAll(client, view);
    expect(first.outcome).toBe('applied');
    expect(stopped).toBeNull();
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ type: 'deposit.take', basis: view.basis, dependsOn: [draft.requestId], expect: { depositHeld: 0 } });
    expect(chain[0]!.requestId).not.toBe(draft.requestId);
    const slip = await client.query('orderSlip', { orderId: 'o22' });
    expect(slip.money).toMatchObject({ charged: 225_000, paid: 105_000, due: 120_000, depositHeld: 15_000 });
    expect(slip.checklist.find((c) => c.stepKey === 'issue')).toMatchObject({ state: 'done' });
    expect(slip.nextStep).toEqual({ stepKey: 'pay', actionKey: 'stamp.pay', figure: { amount: 120_000 } });
    // 다 지급했으니 다시 열면 창 대신 한 줄.
    const again = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' });
    expect(again.notice).toBe('지급 완료');
  });

  it('보증금을 받지 않는 권 · 장비 줄만 여는 지급 창은 예전 그대로(수량 −/+)', async () => {
    const { client } = setup();
    const ski = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue', lineIds: ['o22-l1'] });
    expect(ski).toMatchObject({ quantity: { value: 2, min: 1, max: 2, unit: '개' }, confirmLabel: '지급 처리' });
    expect(ski.then).toBeUndefined();
    // 권 줄 하나만 열어도 보증금이 이어진다(수량 −/+ 없이 잔여 3매).
    const ticket = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue', lineIds: ['o22-l4'] });
    expect(ticket).toMatchObject({ summary: ['야간권 성인 3매', '리프트권 보증금 · 3매 · 매장 기준 1매 5,000원 · 반납 시 반환 · 현금 15,000원'], confirmLabel: '지급 처리 · 3매 · 보증금 15,000원' });
    expect(ticket.quantity).toBeUndefined();
  });

  it('이어진 명령이 안 되면 거기서 멈추고 그 결과(뒤 명령은 보내지 않음)', async () => {
    const { client } = setup();
    const view = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' });
    // 창을 연 뒤 다른 카운터가 보증금을 먼저 받았다: 창이 본 보관 금액(0원)이 이제 맞지 않다.
    const other = await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' });
    await confirmAll(client, other);
    const sent: AnyCommandEnvelope[] = [];
    const draft = openOrRestoreDraft(null, view.command!, view.basis, draftOptions(view));
    const chain = [...chainDrafts(draft, view.then), ...chainDrafts(draft, view.then)];
    const stopped = await sendChain((e) => { sent.push(e); return client.command(e); }, chain);
    expect(stopped).toMatchObject({ outcome: 'conflict', error: { code: 'DEPOSIT_CHANGED' } });
    expect(sent).toHaveLength(1);
  });

  it('서버(체험): 먼저 적용될 명령이 안 된 돈 아닌 명령은 멈춤(blocked), 돈 명령은 멈추지 않는다(sync 2절 · 8-3)', () => {
    const state = createSeed('e');
    const issue: ConfirmCommand = { type: 'stock.issue', payload: { orderId: 'o32', lines: [{ lineId: 'o32-l1', quantity: 2 }] } };
    expect(apply(state, issue, { dependsOn: ['never-sent'] })).toMatchObject({ outcome: 'blocked', error: { message: '처리 불가 · 이전 단계 대기' } });
    expect(line(state, 'o32-l1').issued).toBe(0);
    const refused = apply(state, { type: 'stock.issue', payload: { orderId: 'nope', lines: [] } }, { requestId: 'bad' });
    expect(refused.outcome).toBe('rejected');
    expect(apply(state, issue, { dependsOn: ['bad'] }).outcome).toBe('blocked');
    const ok = apply(state, { type: 'stock.issue', payload: { orderId: 'o22', lines: [{ lineId: 'o22-l4', quantity: 3 }] } }, { requestId: 'first' });
    expect(ok.outcome).toBe('applied');
    expect(apply(state, issue, { dependsOn: ['first'] }).outcome).toBe('applied');
    const money: ConfirmCommand = { type: 'deposit.take', payload: { orderId: 'o22', ruleKey: 'lift_ticket_card', lines: [{ lineId: 'o22-l4', quantity: 3 }], amount: 15_000, methodKey: 'cash' } };
    expect(apply(state, money, { dependsOn: ['bad'], expect: { depositHeld: 0 } }).outcome).toBe('applied');
  });
});

describe('영업일 기준 시각 · 반납 타임(운영 규칙)', () => {
  it('마지막 반납 타임은 심야 24:00(27일 00:00), 야간 수거 준비는 차량 수거가 있는 마지막 타임(22:00)', () => {
    const state = createSeed('e');
    expect(lastReturnSlotAt(state, '2026-12-26')).toBe(ms(0, 0, 1));
    expect(nightPrepSlotAt(state, '2026-12-26')).toBe(ms(22, 0));
  });

  it('06:00 전의 새벽 기록은 전날 영업일: 도장 시각이 26일 장부에 찍히고, 심야 수거는 26일 수거 목록', () => {
    const state = createSeed('e');
    // 같은 영업일의 자정 뒤 시각은 24시 뒤로 쓴다(심야 24:00 반납이 `오늘 00:00`으로 아침처럼 읽히지 않게, V3 · V9와 같은 규칙).
    expect(when(ms(0, 0, 1), '2026-12-26', '06:00')).toBe('24:00');
    expect(when(ms(0, 15, 1), '2026-12-26', '06:00')).toBe('24:15');
    expect(when(ms(9, 0, 1), '2026-12-26', '06:00')).toBe('내일 09:00');
    const giveBack = state.orders.find((o) => o.id === 'o41')!.giveBack;
    state.orders.find((o) => o.id === 'o41')!.giveBack = { ...giveBack, at: ms(0, 0, 1) };
    expect(routeTasks(state, 'v1', '2026-12-26').map((t) => t.order.id)).toContain('o41');
    apply(state, { type: 'stock.direct_return', payload: { orderId: 'o41', lines: [{ lineId: 'o41-l1', quantity: 2 }, { lineId: 'o41-l2', quantity: 2 }] } }, {}, ms(0, 15, 1));
    const config = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
    const slip = orderSlip({ state, config, now: ms(0, 20, 1) }, 'o41')!;
    expect(slip.lines[0]!.cells['stamp:return']).toMatchObject({ stamp: { state: 'done', at: iso(0, 15, 1) } });
  });
});

describe('뒷이야기 16:05 ~ 21:50(plan.md 4-2)', () => {
  it('사건 목록: 1단계의 다섯 시각, 2단계의 19:41 일정 변경, 3단계의 21:31 부분 반납 · 21:32 수납 · 27일 00:15 반납, 5단계의 새 접수 네 팀 · 21:55 반납, 6단계의 16:41 일괄 수납, 7단계의 16:40 적재 · 16:57 배달 · 16:58 권 추가 · 22:00 · 22:10 수거, 8단계의 23:48 매장 입고 · 현금 인계 · 27일 00:32 차량 현금 점검', () => {
    expect(STORY.map((e) => [e.id, new Date(e.at).toISOString()])).toEqual([
      ['park-issue', iso(16, 5)], ['younghee-return', iso(16, 10)], ['jungho-pickup', iso(16, 20)],
      ['minho-order', iso(16, 26)], ['minho-issue', iso(16, 27)], ['jieun-order', iso(16, 28)], ['jieun-issue', iso(16, 29)],
      ['seoyeon-return', iso(16, 30)], ['van-1630', iso(16, 30)],
      ['junseo-order', iso(16, 31)], ['junseo-issue', iso(16, 32)], ['hayun-order', iso(16, 34)], ['hayun-issue', iso(16, 35)],
      ['haeun-load', iso(16, 40)], ['jungho-grouppay', iso(16, 41)], ['haeun-deliver', iso(16, 57)], ['haeun-ticket', iso(16, 58)],
      ['park-promise', iso(19, 41)], ['park-return', iso(21, 31)], ['park-pay', iso(21, 32)],
      ['oseungmin-collect', iso(21, 50)], ['minho-return', iso(21, 55)], ['van-2200', iso(22, 0)], ['tirol-2210', iso(22, 10)], ['van-2348', iso(23, 48)],
      ['haneul-return', iso(0, 15, 1)], ['van-cash-0032', iso(0, 32, 1)],
    ]);
  });

  it('16:30의 하루: 박준호 지급(준비 번호) · 보증금 15,000원, 김영희 반납 · 미수 65,000원 현금, 이정호 수령, 이서연 반납, 1호 차량 16:30 수거', async () => {
    const { client } = setup({ story: true });
    client.advanceClock(50);
    const ledger = await client.ledgerView('day_ledger', {});
    expect(ledger.serverTime).toBe(iso(16, 30));
    const park = await client.query('orderSlip', { orderId: 'o22' });
    expect(park.lines.map((l) => l.cells['stamp:issue'])).toEqual(Array(4).fill({ renderer: 'stamp', stamp: { stepKey: 'issue', state: 'done', at: iso(16, 5) } }));
    expect(park.money).toMatchObject({ charged: 225_000, paid: 105_000, due: 120_000, depositHeld: 15_000 });
    expect(park.nextStep).toEqual({ stepKey: 'pay', actionKey: 'stamp.pay', figure: { amount: 120_000 } });
    const younghee = await client.query('orderSlip', { orderId: 'o27' });
    expect(younghee.money).toMatchObject({ due: 0, paid: 125_000 });
    expect(younghee.nextStep).toBeNull();
    expect((await client.query('orderSlip', { orderId: 'o32' })).checklist.find((c) => c.stepKey === 'issue')).toMatchObject({ state: 'done' });
    expect((await client.query('orderSlip', { orderId: 'o36' })).checklist.find((c) => c.stepKey === 'return')).toMatchObject({ state: 'done' });
    const list = await client.ledgerView('collection_list', { vehicleId: 'v1' });
    expect(list.groups.find((g) => g.key === 's1630')).toMatchObject({ done: 2, total: 2 });
    // 1호 차량 22:00 묶음에 박준호 팀(권 포함)이 들어온다.
    expect(list.rows.find((r) => r.id === 'collect:o22')?.cells['items']).toMatchObject({ items: expect.arrayContaining([{ label: '야간권', qty: 3, unit: '매' }]) });
    expect(list.metrics.find((m) => m.metricKey === 'vehicle_load')).toMatchObject({ items: [{ label: '스키', qty: 2 }, { label: '의류', qty: 3 }, { label: '보드', qty: 2 }, { label: '예비권', qty: 6, unit: '매' }] });
    // 미수 합: 처음 455,000 − 김영희 65,000 + 새 접수(5단계) 이민호 장비 225,000 · 강지은 45,000(둘 다 이정호 팀 결제 예정).
    expect(ledger.metrics.find((m) => m.metricKey === 'due_total')).toMatchObject({ value: 455_000 - 65_000 + 225_000 + 45_000 });
  });

  it('16:30의 돈: 카운터 현금 수납 405,000원(200,000 + 김영희 65,000 + 이민호 권 140,000) · 보증금 15,000 · 20,000원은 수납이 아니라 보증금 장부', () => {
    const { client } = setup({ story: true });
    client.advanceClock(50);
    const state = (client as unknown as { state: FxState }).state;
    const cash = state.orders.flatMap((o) => o.payments).filter((p) => p.methodKey === 'cash');
    expect(cash.reduce((sum, p) => sum + p.amount, 0)).toBe(405_000);
    for (const p of cash) expect(p.drawerId).toBe('counter');
    expect(state.paymentGroups).toEqual([
      expect.objectContaining({ id: 'story:younghee-return:1', purpose: 'counter', amount: 65_000, methodKey: 'cash', drawerId: 'counter', at: ms(16, 10) }),
      expect.objectContaining({ id: 'story:minho-order:0:lift', purpose: 'intake_confirm', amount: 140_000, methodKey: 'cash', drawerId: 'counter', at: ms(16, 26) }),
    ]);
    expect(state.deposits.flatMap((d) => d.entries).map((e) => [e.kind, e.amount, e.drawerId, e.at])).toEqual([
      ['take', 15_000, 'counter', ms(16, 5)], ['take', 20_000, 'counter', ms(16, 26)],
    ]);
    expect(state.storyApplied).toEqual(['park-issue', 'younghee-return', 'jungho-pickup', 'minho-order', 'minho-issue', 'jieun-order', 'jieun-issue', 'seoyeon-return', 'van-1630']);
    expectNumbersConsistent(state);
  });

  it('21:50: 1호 차량이 오승민 팀을 수거하면 긴급 줄이 사라진다', async () => {
    const { client } = setup({ story: true });
    client.advanceClock(6 * 60 + 10);
    const list = await client.ledgerView('collection_list', { vehicleId: 'v1' });
    expect(list.pins).toEqual([]);
    expect(list.groups.find((g) => g.key === 's2150')).toMatchObject({ done: 1, total: 1 });
  });

  it('사람이 먼저 지급 · 보증금을 했으면 사건은 건너뛴다(보증금이 두 번 들어가지 않는다)', async () => {
    const { client, pass } = setup({ story: true });
    pass(5);
    await confirmAll(client, await client.query('confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' }));
    client.advanceClock(45);
    const state = (client as unknown as { state: FxState }).state;
    expect(heldAmount(depositOf(state, 'o22', 'lift_ticket_card'))).toBe(15_000);
    expect(line(state, 'o22-l1').issuedAt).toBe(ms(15, 45));
    // 남은 지급이 없으니 사건은 명령을 만들지 않았다.
    expect(state.outcomes['story:park-issue:0']).toBeUndefined();
    expect(state.storyApplied).toContain('park-issue');
  });
});

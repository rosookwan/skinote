// 둘째 판 6단계(work/impl-v2/plan.md 5절 Step 6): V5 일괄 수납 · 여러 팀(spec 3-6, ui 6-7). 다른 팀 몫까지 받을 팀(이정호 팀)의 접수증에서 연다.
// 화면은 고른 팀 · 탭 · 부분 결제 품목 수 · 수단 · 더한 팀을 인자로 groupPaySheet를 다시 묻고, 서버(체험 자료)가 줄 · 합계 · 주 버튼 · 명령을 쓴다.
// 수납은 payment.take 한 번(돈 한 건 + 팀 · 줄마다 배분, expect에 팀마다 받을 금액). 시안의 순간은 16:40(6팀 485,000원), #part는 이민호 팀이
// 스키 4 · 헬멧 1(165,000원)만 맡기고 의류 3(60,000원)은 이민호 팀 미수로 남김(425,000원). 뒷이야기 16:41 이정호 팀 일괄 수납 카드 485,000원.
import {
  changedOrders, CHECKOUT_KEYS, draftToEnvelope, type CommandOutcome, type GroupPaySheetParams, type GroupPaySheetView, type OrderDraftInput, type OrderSlip,
} from '@skinote/contract';
import { DEVICE_PROFILES, openOrRestoreDraft } from '@skinote/ui';
import { describe, expect, it } from 'vitest';
import { checkoutEnvelope } from '../src/components/CheckoutDialog.tsx';
import { pickedLines, stepLine } from '../src/components/PartialPayDialog.tsx';
import { amountFor, coveredOrders, dueFor, evenSplit, type FxOrder, type FxState, kstAt, lineLeft, othersDue, ownDue, payableLines } from '@skinote/domain';
import { applyCommand } from '../src/fixture/demo.ts';
import { FixtureClient } from '../src/fixture/fixture-client.ts';
import {
  groupPayColumns, groupPayEnvelope, groupPayRowsPerPage, withAdded, withExcluded, withMethod, withoutDropped, withPart, withTab, withToggle,
} from '../src/screens/GroupPayScreen.tsx';
import { groupPayEntry } from '../src/screens/OrderSlipScreen.tsx';

const ms = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);

/** 체험 시계를 15:40에서 minutes만큼(뒷이야기 켬: 16:40 = 60분). */
function at(minutes: number, story = true) {
  const client = new FixtureClient({ realNow: () => 1_800_000_000_000, story });
  client.advanceClock(minutes);
  const state = () => (client as unknown as { state: FxState }).state;
  return { client, state };
}

const orderOf = (state: FxState, last4: string): FxOrder => state.orders.find((o) => o.last4 === last4)!;
const rowsOf = (view: GroupPaySheetView) => view.rows.map((r) => [r.team, r.tag.text, r.tag.tone, r.items.map((i) => i.label + ' ' + i.qty + (i.unit ?? '')).join(' · '), r.amount, r.selected, r.partLabel]);

/** 화면과 같은 길: 이 시도의 초안(요청번호 · basis) → 보낼 때 서버가 준 명령과 받을 금액(expect)으로 봉투. */
async function pay(client: FixtureClient, view: GroupPaySheetView, requestId: string): Promise<CommandOutcome> {
  const draft = openOrRestoreDraft(null, { type: 'payment.take', payload: { orderIds: [], amount: 0, methodKey: 'card' } }, view.basis, { requestId });
  const envelope = groupPayEnvelope(draft, view);
  if (!envelope) throw new Error('보낼 명령이 없다');
  return client.command(envelope);
}

/** #part의 품목: 이민호 팀 스키 4 · 헬멧 1(의류 95 × 2 · 100 × 1은 이민호 팀 미수). */
const minhoPart = (state: FxState) => {
  const o = orderOf(state, '0042');
  return o.lines.filter((l) => l.section === 'gear').map((l) => ({ lineId: l.id, quantity: l.kind === 'clothes' ? 0 : l.qty }));
};

describe('V5 읽기 모델(groupPaySheet) — 16:40 이정호 팀', () => {
  it('그린 상태: 탭 `이정호 팀 결제 · 6팀` · `미수 3`, 여섯 줄(결제 팀 · 결제 예정), 받을 금액 485,000원, 카드, 주 버튼 `수납 처리 · 6팀 · 485,000원`', async () => {
    const { client } = at(60);
    const view = await client.query('groupPaySheet', { orderId: 'o32' });
    expect(view.title).toBe('일괄 수납');
    expect(view.tabs).toEqual([{ key: 'group', label: '이정호 팀 결제 · 6팀', selected: true }, { key: 'unpaid', label: '미수 3', selected: false }]);
    expect(rowsOf(view)).toEqual([
      ['이정호 · 0032', '결제 팀', 'grey', '스키 2 · 헬멧 2', 90_000, true, '부분 결제 ›'],
      ['이서연 · 0036', '결제 예정', 'blue', '스키 1 · 의류 1', 60_000, true, '부분 결제 ›'],
      ['이민호 · 0042', '결제 예정', 'blue', '스키 4 · 의류 3 · 헬멧 1', 225_000, true, '부분 결제 ›'],
      ['강지은 · 0043', '결제 예정', 'blue', '보드 1 · 의류 1', 45_000, true, '부분 결제 ›'],
      ['이준서 · 0044', '결제 예정', 'blue', '스키 1', 40_000, true, '부분 결제 ›'],
      ['송하윤 · 0045', '결제 예정', 'blue', '보드 1', 25_000, true, '부분 결제 ›'],
    ]);
    expect(view.rows[2]?.partAria).toBe('이민호 · 0042 · 부분 결제 · 품목 선택');
    expect(view.total).toEqual({ amount: 485_000, note: '6팀 · 이정호 팀 결제' });
    expect(view.methods.map((m) => m.label + (m.selected ? '*' : ''))).toEqual(['카드*', '현금', '계좌이체', '기타']);
    expect(view.others.map((m) => m.label)).toEqual(['간편결제']);
    expect(view.primary).toEqual({ label: '수납 처리 · 6팀 · 485,000원', alts: ['수납 처리 · 6팀 · 485,000원', '수납 처리 · 485,000원', '수납 처리'], enabled: true });
    expect(view.selectedIds).toEqual(['o32', 'o36', 'n19', 'n20', 'n21', 'n22']);
    // 명령: 돈 한 건(일괄 수납) + 팀마다의 몫(줄 · 수량 · 금액), expect에 합과 팀마다의 받을 금액.
    expect(view.command?.type).toBe('payment.take');
    const payload = view.command?.type === 'payment.take' ? view.command.payload : null;
    expect(payload).toMatchObject({ orderIds: ['o32', 'o36', 'n19', 'n20', 'n21', 'n22'], amount: 485_000, methodKey: 'card', purposeKey: 'multi_order', payerOrderId: 'o32' });
    expect(payload?.allocations?.map((a) => [a.orderId, a.amount, a.lines?.map((l) => l.quantity + '/' + l.amount).join(' ')])).toEqual([
      ['o32', 90_000, '2/80000 2/10000'], ['o36', 60_000, '1/40000 1/20000'], ['n19', 225_000, '4/160000 2/40000 1/20000 1/5000'],
      ['n20', 45_000, '1/25000 1/20000'], ['n21', 40_000, '1/40000'], ['n22', 25_000, '1/25000'],
    ]);
    expect(view.expect).toEqual({ dueAmount: 485_000, dueByOrder: { o32: 90_000, o36: 60_000, n19: 225_000, n20: 45_000, n21: 40_000, n22: 25_000 } });
  });

  it('미수 탭: 고른 팀이 먼저(보이는 체크 = 주 버튼 금액), 그다음 장부의 미수 탭과 같은 정의의 더할 팀(박준호 · 윤서준). 고르면 합계에 든다', async () => {
    const { client } = at(60);
    const view = await client.query('groupPaySheet', { orderId: 'o32', tabKey: 'unpaid' });
    expect(view.tabs.map((t) => t.selected)).toEqual([false, true]);
    expect(view.tabs[1]?.label).toBe('미수 3');
    expect(rowsOf(view)).toEqual([
      ['이정호 · 0032', '결제 팀', 'grey', '스키 2 · 헬멧 2', 90_000, true, '부분 결제 ›'],
      ['이서연 · 0036', '결제 예정', 'blue', '스키 1 · 의류 1', 60_000, true, '부분 결제 ›'],
      ['이민호 · 0042', '결제 예정', 'blue', '스키 4 · 의류 3 · 헬멧 1', 225_000, true, '부분 결제 ›'],
      ['강지은 · 0043', '결제 예정', 'blue', '보드 1 · 의류 1', 45_000, true, '부분 결제 ›'],
      ['이준서 · 0044', '결제 예정', 'blue', '스키 1', 40_000, true, '부분 결제 ›'],
      ['송하윤 · 0045', '결제 예정', 'blue', '보드 1', 25_000, true, '부분 결제 ›'],
      ['박준호 · 0022', '미수', 'grey', '스키 2 · 보드 1 · 헬멧 3', 120_000, false, '부분 결제 ›'],
      ['윤서준 · 0028', '미수', 'grey', '스키 2 · 의류 2', 120_000, false, '부분 결제 ›'],
    ]);
    // 체크된 줄의 합 = 주 버튼 금액.
    expect(view.rows.filter((r) => r.selected).reduce((n, r) => n + r.amount, 0)).toBe(view.total.amount);
    const ledger = await client.ledgerView('day_ledger', { tabKey: 'unpaid' });
    expect(ledger.rows.map((r) => r.orderId).sort()).toEqual(['o22', 'o28', 'o32']);
    const more = await client.query('groupPaySheet', withToggle({ orderId: 'o32', tabKey: 'unpaid' }, view, 'o28'));
    expect([more.total.amount, more.primary.label, more.tabs[0]?.label]).toEqual([605_000, '수납 처리 · 7팀 · 605,000원', '이정호 팀 결제 · 6팀']);
  });

  it('고름을 끄면 줄은 남고 합계 · 주 버튼이 바로 바뀐다(`수납 처리 · 5팀 · 425,000원`), 모두 끄면 주 버튼을 누를 수 없다', async () => {
    const { client } = at(60);
    const params: GroupPaySheetParams = { orderId: 'o32' };
    const view = await client.query('groupPaySheet', params);
    const off = await client.query('groupPaySheet', withToggle(params, view, 'o36'));
    expect(off.rows.map((r) => r.selected)).toEqual([true, false, true, true, true, true]);
    expect([off.total, off.primary.label]).toEqual([{ amount: 425_000, note: '5팀 · 이정호 팀 결제' }, '수납 처리 · 5팀 · 425,000원']);
    const none = await client.query('groupPaySheet', { orderId: 'o32', selected: [] });
    expect([none.primary.enabled, none.primary.label, none.command, none.total.amount]).toEqual([false, '수납 처리', undefined, 0]);
  });

  it('`기타` 판의 수단(간편결제)을 고르면 `기타` 두 줄, 틀린 수단은 주 버튼을 막는다', async () => {
    const { client } = at(60);
    const easy = await client.query('groupPaySheet', { orderId: 'o32', methodKey: 'easy_pay' });
    expect(easy.methods.map((m) => m.label + (m.secondLine ? '/' + m.secondLine : '') + (m.selected ? '*' : ''))).toEqual(['카드', '현금', '계좌이체', '기타/간편결제*']);
    expect(easy.command?.type === 'payment.take' && easy.command.payload.methodKey).toBe('easy_pay');
    const bad = await client.query('groupPaySheet', { orderId: 'o32', methodKey: 'bitcoin' });
    expect([bad.primary.enabled, bad.command]).toEqual([false, undefined]);
  });

  it('팀 추가 · 끝 4자리: 찾은 팀은 목록 끝에 선택된 채(`· 7팀`), 낼 것이 없는 팀은 한 줄로 빠진다', async () => {
    const { client } = at(60);
    const params: GroupPaySheetParams = { orderId: 'o32' };
    const view = await client.query('groupPaySheet', params);
    const added = await client.query('groupPaySheet', withAdded(params, view, 'o28'));
    expect(added.tabs[0]?.label).toBe('이정호 팀 결제 · 7팀');
    expect(rowsOf(added).at(-1)).toEqual(['윤서준 · 0028', '미수', 'grey', '스키 2 · 의류 2', 120_000, true, '부분 결제 ›']);
    expect(added.total.amount).toBe(605_000);
    const paidTeam = await client.query('groupPaySheet', withAdded(params, view, 'o24'));
    expect(paidTeam.dropped).toEqual([{ orderId: 'o24', note: '최은정 · 0024 · 받을 금액 없음' }]);
    expect(paidTeam.rows).toHaveLength(6);
    expect(withoutDropped(withAdded(params, view, 'o24'), ['o24'])).toMatchObject({ added: [], selected: ['o32', 'o36', 'n19', 'n20', 'n21', 'n22'] });
  });

  it('없는 접수는 NOT_FOUND', async () => {
    const { client } = at(60);
    await expect(client.query('groupPaySheet', { orderId: 'o99' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(client.query('partialPaySheet', { orderId: 'o99', payerOrderId: 'o32' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('부분 결제 판(partialPaySheet) · #part', () => {
  it('이민호 팀의 남은 품목 줄마다 −/+ (처음은 남은 것 모두), `잔여 전체 선택` · `균등 분할`(받을 금액 ÷ 2에 가장 가깝게, 넘지 않게)', async () => {
    const { client } = at(60);
    const view = await client.query('partialPaySheet', { orderId: 'n19', payerOrderId: 'o32' });
    expect(view.title).toBe('부분 결제 · 이민호 팀');
    expect(view.lines.map((l) => [l.label, l.note, l.quantity.value + '/' + l.quantity.max + l.quantity.unit, l.amount])).toEqual([
      ['스키', '잔여 4대 · 1대 40,000원', '4/4대', 160_000],
      // 규격은 둘째 줄 앞에(`의류` / `사이즈 95 · …`, `헬멧` / `중 사이즈 · …`).
      ['의류', '사이즈 95 · 잔여 2벌 · 1벌 20,000원', '2/2벌', 40_000],
      ['의류', '사이즈 100 · 잔여 1벌 · 1벌 20,000원', '1/1벌', 20_000],
      ['헬멧', '중 사이즈 · 잔여 1개 · 1개 5,000원', '1/1개', 5_000],
    ]);
    expect(view.summary.map((r) => r.text).join('')).toBe('선택 225,000원 · 받을 금액 225,000원');
    expect(view.primary).toEqual({ label: '선택 · 225,000원', alts: ['선택 · 225,000원', '선택'], enabled: true });
    expect(view.presets.map((p) => [p.label, p.enabled, p.lines.map((l) => l.quantity).join(' ')])).toEqual([['잔여 전체 선택', true, '4 2 1 1'], ['균등 분할', true, '2 1 0 1']]);
    const even = await client.query('partialPaySheet', { orderId: 'n19', payerOrderId: 'o32', lines: view.presets[1]!.lines });
    expect(even.total).toBe(105_000);
    const part = await client.query('partialPaySheet', { orderId: 'n19', payerOrderId: 'o32', lines: [{ lineId: 'n19-l1', quantity: 4 }, { lineId: 'n19-l4', quantity: 1 }] });
    expect([part.total, part.primary.label, part.summary.map((r) => r.text).join('')]).toEqual([165_000, '선택 · 165,000원', '선택 165,000원 · 받을 금액 225,000원']);
    const zero = await client.query('partialPaySheet', { orderId: 'n19', payerOrderId: 'o32', lines: [] });
    expect([zero.total, zero.primary.enabled, zero.primary.label]).toEqual([0, false, '선택']);
    // 한 개짜리 팀(이준서 스키 1)은 반으로 나눌 품목이 없다: 균등 분할을 누를 수 없다.
    const one = await client.query('partialPaySheet', { orderId: 'n21', payerOrderId: 'o32' });
    expect(one.presets.map((p) => p.enabled)).toEqual([true, false]);
  });

  it('#part: 이민호 줄은 `부분 · 165,000원 ›`(받을 금액 칸은 225,000원 그대로), 합계 425,000원, 배분은 고른 줄만', async () => {
    const { client, state } = at(60);
    const params: GroupPaySheetParams = { orderId: 'o32' };
    const view = await client.query('groupPaySheet', params);
    const part = await client.query('groupPaySheet', withPart(params, view, 'n19', minhoPart(state())));
    const minho = part.rows.find((r) => r.orderId === 'n19')!;
    expect([minho.amount, minho.partLabel, minho.partShort, minho.partAria]).toEqual([225_000, '부분 · 165,000원 ›', '165,000원 ›', '이민호 · 0042 · 부분 165,000원 · 스키 4 · 헬멧 1 · 품목 다시 선택']);
    expect([part.total, part.primary.label]).toEqual([{ amount: 425_000, note: '6팀 · 이정호 팀 결제' }, '수납 처리 · 6팀 · 425,000원']);
    const payload = part.command?.type === 'payment.take' ? part.command.payload : null;
    expect(payload?.allocations?.find((a) => a.orderId === 'n19')).toEqual({ orderId: 'n19', amount: 165_000, lines: [{ lineId: 'n19-l1', quantity: 4, amount: 160_000 }, { lineId: 'n19-l4', quantity: 1, amount: 5_000 }] });
    expect(part.expect?.dueByOrder?.['n19']).toBe(225_000);
    // 남은 것을 모두 고르면 부분이 아니다(버튼이 `부분 결제 ›`로).
    const all = orderOf(state(), '0042').lines.filter((l) => l.section === 'gear').map((l) => ({ lineId: l.id, quantity: l.qty }));
    const full = await client.query('groupPaySheet', withPart(params, view, 'n19', all));
    expect(full.rows.find((r) => r.orderId === 'n19')?.partLabel).toBe('부분 결제 ›');
  });
});

describe('일괄 수납 명령(payment.take + 결제 팀)', () => {
  it('#part 수납: 카드 한 번 425,000원(결제 자리 multi_order) · 팀마다 몫, 이민호 팀 의류 3은 이민호 팀 미수(반납 시)로 돌아간다', async () => {
    const { client, state } = at(60);
    const params: GroupPaySheetParams = { orderId: 'o32' };
    const view = await client.query('groupPaySheet', params);
    const part = await client.query('groupPaySheet', withPart(params, view, 'n19', minhoPart(state())));
    const outcome = await pay(client, part, 'r-part');
    expect(outcome.outcome).toBe('applied');
    const s = state();
    expect(s.paymentGroups.find((g) => g.id === 'r-part')).toMatchObject({ purpose: 'multi_order', amount: 425_000, methodKey: 'card' });
    const minho = orderOf(s, '0042');
    expect(minho.payments.find((p) => p.groupId === 'r-part')).toMatchObject({ amount: 165_000, lines: [{ lineId: 'n19-l1', quantity: 4, amount: 160_000 }, { lineId: 'n19-l4', quantity: 1, amount: 5_000 }] });
    expect([minho.payerOrderId, minho.payWhen, ownDue(minho), dueFor(minho, 'n19'), dueFor(minho, 'o32')]).toEqual([undefined, 'return', 60_000, 60_000, 0]);
    expect(minho.lines.filter((l) => lineLeft(minho, l) > 0).map((l) => [l.label, l.payerOrderId ?? ''])).toEqual([['의류 사이즈 95', ''], ['의류 사이즈 100', '']]);
    const jungho = s.orders.find((o) => o.id === 'o32')!;
    expect([ownDue(jungho), othersDue(s, jungho), coveredOrders(s, jungho)]).toEqual([0, 0, []]);
    // 장부: 이민호 팀은 이제 제 미수(검정, 반납 22:00 + 30분까지 지연 아님), 미수 탭에 든다. 이정호 접수증은 일괄 수납이 아니다.
    const ledger = await client.ledgerView('day_ledger', { tabKey: 'unpaid' });
    const row = ledger.rows.find((r) => r.orderId === 'n19')!;
    expect(row.cells['money']).toMatchObject({ alts: ['미수 60,000원', '60,000원'], tone: 'ink', lateAt: new Date(ms(22, 30)).toISOString() });
    const slip = await client.query('orderSlip', { orderId: 'o32' });
    expect(slip.groupPay).toBeUndefined();
    // 같은 요청번호를 다시 보내면 처음 결과(두 번 받지 않는다).
    expect((await pay(client, part, 'r-part')).outcome).toBe('applied');
    expect(s.paymentGroups.filter((g) => g.id === 'r-part')).toHaveLength(1);
  });

  it('그사이 다른 카운터가 강지은 팀을 받았으면 충돌 한 줄 `강지은 팀 45,000원 수납 완료 · 다른 카운터`, `제외 후 수납`은 새 요청번호로 5팀', async () => {
    const { client, state } = at(60);
    const params: GroupPaySheetParams = { orderId: 'o32' };
    const view = await client.query('groupPaySheet', params);
    // 다른 카운터: 강지은 팀 접수증의 수납(직접 수납 45,000원).
    const direct = await client.query('confirmDraft', { orderId: 'n20', actionKey: 'pay' });
    expect(direct.summary).toEqual(['이정호 팀 결제 예정', '직접 결제 · 45,000원']);
    const draft = openOrRestoreDraft(null, direct.command!, direct.basis, { expect: direct.expect!, requestId: 'r-direct' });
    expect((await client.command(draftToEnvelope(draft))).outcome).toBe('applied');
    const outcome = await pay(client, view, 'r-stale');
    expect(outcome).toMatchObject({ outcome: 'conflict', error: { code: 'DUE_CHANGED', message: '강지은 팀 45,000원 수납 완료 · 다른 카운터' } });
    expect(changedOrders(outcome)).toEqual(['n20']);
    expect(state().paymentGroups.some((g) => g.id === 'r-stale')).toBe(false);
    const excluded = await client.query('groupPaySheet', withExcluded(params, view, changedOrders(outcome)));
    expect([excluded.primary.label, excluded.rows.map((r) => r.orderId)]).toEqual(['수납 처리 · 5팀 · 440,000원', ['o32', 'o36', 'n19', 'n21', 'n22']]);
    expect((await pay(client, excluded, 'r-again')).outcome).toBe('applied');
    expect(state().paymentGroups.find((g) => g.id === 'r-again')?.amount).toBe(440_000);
  });

  it('받을 금액이 바뀐 것(일부만 받음)은 `받을 금액 변경됨 · 재시도 필요`, expect 없는 수납은 거절, 틀린 수단은 거절', async () => {
    const { client, state } = at(60);
    const view = await client.query('groupPaySheet', { orderId: 'o32' });
    const s = state();
    applyCommand(s, {
      type: 'payment.take', commandVersion: 1, requestId: 'r-some', basis: view.basis, expect: { dueAmount: 225_000 },
      payload: { orderIds: ['n19'], amount: 25_000, methodKey: 'cash' },
    }, ms(16, 40));
    const outcome = await pay(client, view, 'r-changed');
    expect(outcome).toMatchObject({ outcome: 'conflict', error: { message: '받을 금액 변경됨 · 재시도 필요' } });
    expect(changedOrders(outcome)).toEqual(['n19']);
    const noExpect = openOrRestoreDraft(null, view.command!, view.basis, { requestId: 'r-noexpect' });
    expect((await client.command(draftToEnvelope(noExpect))).outcome).toBe('rejected');
    if (view.command?.type !== 'payment.take') throw new Error('수납 명령이 아니다');
    const bad = openOrRestoreDraft(null, { type: 'payment.take', payload: { ...view.command.payload, methodKey: 'bitcoin' } }, view.basis, { requestId: 'r-bad', expect: view.expect! });
    expect(await client.command(draftToEnvelope(bad))).toMatchObject({ outcome: 'rejected', error: { message: '등록되지 않은 결제 수단' } });
  });

  it('대납 수납 창(장부 도장)도 결제 팀으로 보낸다: 이정호 팀 + 이서연 팀 150,000원', async () => {
    const { client } = at(0, false);
    const view = await client.query('confirmDraft', { orderId: 'o32', actionKey: 'stamp.pay' });
    expect(view.command).toMatchObject({ type: 'payment.take', payload: { orderIds: ['o32', 'o36'], amount: 150_000, payerOrderId: 'o32' } });
    expect(view.expect).toEqual({ dueAmount: 150_000 });
  });
});

describe('줄 단위 결제 약속(V4 `기타` → `다른 팀 결제`)과 일괄 수납', () => {
  it('장비만 이정호 팀이 내기로 한 팀: 이정호 팀의 받을 금액은 장비 몫만, 리프트권은 그 팀 미수', async () => {
    const { client, state } = at(45, false);
    const draft: OrderDraftInput = {
      channel: 'walk_in', leader: { name: '한지민', phone: '01000000099', party: 1 },
      items: [{ productKey: 'ski', quantity: 1 }, { productKey: 'night_adult', quantity: 1 }], pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' },
    };
    const sheet = await client.query('checkoutSheet', {
      draft, choices: [{ sectionKey: 'gear', methodKey: CHECKOUT_KEYS.later, payerOrderId: 'o32' }, { sectionKey: 'lift', methodKey: CHECKOUT_KEYS.later }], payerOrderId: null,
    });
    const envelope = checkoutEnvelope(openOrRestoreDraft(null, { type: 'order.create', payload: { draft, choices: [], payerOrderId: null } }, sheet.basis, { requestId: 'r-new' }), sheet)!;
    expect((await client.command(envelope)).outcome).toBe('applied');
    const s = state();
    const jimin = orderOf(s, '0099');
    const jungho = s.orders.find((o) => o.id === 'o32')!;
    expect([jimin.payerOrderId, ownDue(jimin), dueFor(jimin, 'o32'), dueFor(jimin, jimin.id)]).toEqual([undefined, 75_000, 40_000, 35_000]);
    expect(payableLines(jungho, jimin).map((l) => l.label)).toEqual(['스키']);
    expect(amountFor(jungho, jimin)).toBe(40_000);
    const view = await client.query('groupPaySheet', { orderId: 'o32' });
    expect(view.rows.find((r) => r.orderId === jimin.id)).toMatchObject({ amount: 40_000, tag: { text: '결제 예정' } });
    expect(view.total.amount).toBe(90_000 + 60_000 + 40_000);
    const slip = await client.query('orderSlip', { orderId: 'o32' });
    expect(slip.groupPay).toEqual({ teams: 3, amount: 190_000 });
  });
});

describe('접수증 · 뒷이야기', () => {
  it('15:40: 이정호 팀 접수증은 일괄 수납(2팀 · 150,000원), 딸린 팀이 없는 팀은 보통 수납 창', async () => {
    const { client } = at(0, false);
    expect((await client.query('orderSlip', { orderId: 'o32' })).groupPay).toEqual({ teams: 2, amount: 150_000 });
    expect((await client.query('orderSlip', { orderId: 'o22' })).groupPay).toBeUndefined();
    expect((await client.query('orderSlip', { orderId: 'o36' })).groupPay).toBeUndefined();
  });

  it('16:40 접수증은 6팀 · 485,000원, 16:41 뒷이야기: 카드 한 번 485,000원 · 6팀 수납 완료(결제 자리 하나)', async () => {
    const before = at(60);
    expect((await before.client.query('orderSlip', { orderId: 'o32' })).groupPay).toEqual({ teams: 6, amount: 485_000 });
    const { client, state } = at(70);
    const s = state();
    expect(s.storyApplied).toContain('jungho-grouppay');
    const group = s.paymentGroups.find((g) => g.id === 'story:jungho-grouppay:0')!;
    expect([group.purpose, group.amount, group.methodKey, group.at]).toEqual(['multi_order', 485_000, 'card', ms(16, 41)]);
    expect(['o32', 'o36'].map((id) => ownDue(s.orders.find((o) => o.id === id)!))).toEqual([0, 0]);
    expect(['0042', '0043', '0044', '0045'].map((last4) => ownDue(orderOf(s, last4)))).toEqual([0, 0, 0, 0]);
    expect(s.orders.flatMap((o) => o.payments).filter((p) => p.groupId === group.id).map((p) => p.amount)).toEqual([90_000, 60_000, 225_000, 45_000, 40_000, 25_000]);
    const slip: OrderSlip = await client.query('orderSlip', { orderId: 'o32' });
    expect(slip.groupPay).toBeUndefined();
    const unpaid = await client.ledgerView('day_ledger', { tabKey: 'unpaid' });
    expect(unpaid.rows.map((r) => r.orderId).sort()).toEqual(['o22', 'o28']);
  });

  it('사람이 먼저 V5에서 받았으면 사건은 건너뛴다', async () => {
    const { client, state } = at(60);
    const view = await client.query('groupPaySheet', { orderId: 'o32' });
    expect((await pay(client, view, 'r-first')).outcome).toBe('applied');
    client.advanceClock(10);
    const s = state();
    expect(s.storyApplied).toContain('jungho-grouppay');
    expect(s.outcomes['story:jungho-grouppay:0']).toBeUndefined();
    expect(s.paymentGroups.filter((g) => g.purpose === 'multi_order')).toHaveLength(1);
  });
});

describe('화면(GroupPayScreen · PartialPayDialog · 접수증)의 모양 계산', () => {
  const view = (over: Partial<GroupPaySheetView> = {}): GroupPaySheetView => ({
    basis: { epoch: 'e', rev: 1 }, serverTime: '2026-12-26T07:40:00.000Z', currentBusinessDate: '2026-12-26', title: '일괄 수납', tabs: [], rows: [],
    selectedIds: ['a', 'b'], total: { amount: 0, note: '' }, methods: [], others: [], primary: { label: '수납 처리', alts: [], enabled: false }, ...over,
  });

  it('인자 만들기: 고름 뒤집기 · 탭 · 수단 · 부분(그 팀은 고름) · 추가(탭 이 팀 결제로) · 빠진 팀 빼기 · 제외', () => {
    const p: GroupPaySheetParams = { orderId: 'o32' };
    expect(withToggle(p, view(), 'b').selected).toEqual(['a']);
    expect(withToggle(p, view(), 'c').selected).toEqual(['a', 'b', 'c']);
    expect(withTab(p, 'unpaid').tabKey).toBe('unpaid');
    expect(withMethod(p, 'cash').methodKey).toBe('cash');
    const part = withPart({ ...p, parts: [{ orderId: 'c', lines: [] }] }, view(), 'c', [{ lineId: 'c-l1', quantity: 1 }]);
    expect([part.parts, part.selected]).toEqual([[{ orderId: 'c', lines: [{ lineId: 'c-l1', quantity: 1 }] }], ['a', 'b', 'c']]);
    expect(withAdded({ ...p, tabKey: 'unpaid' }, view(), 'd')).toEqual({ orderId: 'o32', tabKey: 'group', added: ['d'], selected: ['a', 'b', 'd'] });
    expect(withAdded({ ...p, added: ['d'] }, view({ selectedIds: ['a', 'd'] }), 'd').added).toEqual(['d']);
    expect(withoutDropped({ ...p, added: ['d', 'e'], selected: ['a', 'e'] }, ['e'])).toEqual({ orderId: 'o32', added: ['d'], selected: ['a'] });
    expect(withExcluded(p, view(), ['b']).selected).toEqual(['a']);
  });

  it('봉투: 이 시도의 요청번호 · basis에 지금 명령과 받을 금액. 명령이 없으면 null', async () => {
    const { client } = at(60);
    const v = await client.query('groupPaySheet', { orderId: 'o32' });
    const draft = openOrRestoreDraft(null, { type: 'payment.take', payload: { orderIds: [], amount: 0, methodKey: 'card' } }, v.basis, { requestId: 'r1' });
    const envelope = groupPayEnvelope(draft, v)!;
    expect([envelope.requestId, envelope.expect, envelope.payload]).toEqual(['r1', v.expect, v.command?.payload]);
    expect(groupPayEnvelope(draft, { ...v, command: undefined } as unknown as GroupPaySheetView)).toBeNull();
  });

  it('칸 폭 · 쪽: 1024 폭(글 668)은 시안 칸, 좁은 포스(551 · 519)는 줄인 칸. 한 쪽 줄 수는 (잰 높이 − 표 머리) ÷ 줄', () => {
    const pos = DEVICE_PROFILES.pos;
    expect([668, 1010, 551, 519].map((w) => groupPayColumns(pos, w).compact)).toEqual([false, false, true, true]);
    expect(groupPayColumns(pos, undefined).compact).toBe(false);
    // 1024×600: 표 자리 396 → 6줄, 1024×529: 325 → 5줄, 재기 전에는 모두.
    expect([396, 325, 564].map((h) => groupPayRowsPerPage(h, pos.tableHeadPx, pos.rowPx, 9))).toEqual([6, 5, 10]);
    expect(groupPayRowsPerPage(undefined, pos.tableHeadPx, pos.rowPx, 9)).toBe(9);
  });

  it('접수증의 수납: groupPay가 있으면 수납 명령을 여는 동작(수납 · 수납 처리)은 V5, 그 밖은 그대로', () => {
    const slip = { groupPay: { teams: 6, amount: 485_000 } };
    expect([groupPayEntry(slip, 'pay'), groupPayEntry(slip, 'stamp.pay'), groupPayEntry(slip, 'stamp.return'), groupPayEntry({}, 'pay'), groupPayEntry(null, 'pay')])
      .toEqual([true, true, false, false, false]);
  });

  it('부분 결제 판: −/+ 는 이미 누른 수에서 센다(답이 오기 전 두 번 눌러도), 범위 안에서', async () => {
    const { client } = at(60);
    const v = await client.query('partialPaySheet', { orderId: 'n19', payerOrderId: 'o32' });
    expect(pickedLines(v).map((l) => l.quantity)).toEqual([4, 2, 1, 1]);
    const once = stepLine(undefined, v, 'n19-l2', -1);
    const twice = stepLine(once, v, 'n19-l2', -1);
    expect(twice.map((l) => l.quantity)).toEqual([4, 0, 1, 1]);
    expect(stepLine(twice, v, 'n19-l2', -1).map((l) => l.quantity)).toEqual([4, 0, 1, 1]);
    expect(stepLine(undefined, v, 'n19-l1', 1).map((l) => l.quantity)).toEqual([4, 2, 1, 1]);
    expect(evenSplit(orderOfClient(client, '0042'), payableLines(orderOfClient(client, '0032'), orderOfClient(client, '0042'))).map((u) => u.quantity)).toEqual([2, 1, 0, 1]);
  });
});

const orderOfClient = (client: FixtureClient, last4: string) => orderOf((client as unknown as { state: FxState }).state, last4);

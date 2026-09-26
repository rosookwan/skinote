// 둘째 판 7단계(work/impl-v2/plan.md 5절 Step 7): V7 기사 업무 판 · 한 팀과 배달 목록(spec 3-8, ui 6-5). 차량 배달 업무(deliver:<접수>),
// 배달(stock.deliver), 현장 수납(field.collect, 차량 지갑), 리프트권 추가(field.add_ticket: 권 줄 · 값 · 보증금 → 곧바로 현장 수납 dependsOn),
// 수거 현장의 권 보증금 반환(field.deposit_return), 후불 처리(payment_promise.set), 업무 종류마다의 방문 결과 사유, 기사 명령의 보냄 대기.
// 시안의 순간은 16:55(최하은 팀, 16:40 적재), 뒷이야기 16:57 배달 · 16:58 권 추가 · 22:00 · 22:10 일정의 차량 수거(첫 매장의 밤처럼 22:40 · 23:05, spec 2-4).
// 첫 매장(체험판 기본, 2026-09-26): 번호 · 권 보증금이 없고 차량 예비권은 수량, 기사 수단은 현금 · 계좌이체. 번호 · 보증금을 켠 매장은
// shop 'numbered'로 계속 본다.
import {
  envelopeFor, parseQuery,
  defaultUiConfig, draftToEnvelope, openCommandDraft, resolveLedgerView, uiDefaults, type CommandOutcome, type ConfirmCommand, type ConfirmDraftView,
  type Expect, type LedgerCell, type TaskSheetView,
} from '@skinote/contract';
import { fillRows } from '@skinote/layout';
import { DEVICE_PROFILES, openOrRestoreDraft } from '@skinote/ui';
import { describe, expect, it } from 'vitest';
import { chainDrafts, chainGoesOn, confirmEnvelope, draftOptions, draftParams, sendChain, withCount } from '../src/components/ConfirmFlow.tsx';
import { withAmount } from '../src/components/TaskPanels.tsx';
import { depositOf, type FxState, heldAmount, kstAt, OFFLINE_ALLOWED, ownDue, type SampleShop, spareTickets } from '@skinote/domain';
import { FixtureClient } from '../src/fixture/fixture-client.ts';
import { driverListRoute } from '../src/screens/CollectionListScreen.tsx';
import { phonePlanPx, phoneTaskLayout, planPx, taskButtonPx, taskRowRoom } from '../src/screens/TaskSheetScreen.tsx';

const ms = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const iso = (h: number, m: number, day = 0) => new Date(ms(h, m, day)).toISOString();

/** 15:40에서 minutes만큼(뒷이야기를 켜면 그 사이의 사건). 기사 기기(연결 · 보냄 대기)로 연다. */
function at(minutes: number, story = true, shop: SampleShop = 'first') {
  const client = new FixtureClient({ realNow: () => 1_800_000_000_000, story, shop });
  client.setDevice('driver');
  client.advanceClock(minutes);
  const state = () => (client as unknown as { state: FxState }).state;
  return { client, state };
}

const order = (state: FxState, id: string) => state.orders.find((o) => o.id === id)!;
const stampOf = (cell: LedgerCell | undefined) => (cell?.renderer === 'stamp' ? cell.stamp : null);
const lineStamps = (view: TaskSheetView, key: string) => view.lines.map((l) => stampOf(l.cells[key]));
const text = (runs: readonly { text: string }[] | undefined) => (runs ?? []).map((r) => r.text).join('');

/** 화면과 같은 길: 창을 연 때의 초안 + 이어진 명령의 초안 → 첫 명령 → 이어진 명령. */
async function confirmAll(client: FixtureClient, view: ConfirmDraftView, qty: number | null = null): Promise<CommandOutcome> {
  if (!view.command) throw new Error('확정할 명령이 없다: ' + view.notice);
  const draft = openOrRestoreDraft(null, view.command, view.basis, draftOptions(view));
  const chain = chainDrafts(draft, view.then);
  const first = await client.command(confirmEnvelope(draft, view.command, qty, null));
  const stopped = chainGoesOn(first) ? await sendChain((e) => client.command(e), chain) : first;
  return stopped ?? first;
}

/** 판(현장 수납 · 리프트권 추가)과 같은 길: 판을 연 때의 초안(요청번호 · dependsOn) + 서버가 지금 써 준 명령 · 바탕. */
async function sendPanel(client: FixtureClient, command: ConfirmCommand | undefined, expect: Expect | undefined, basis: { epoch: string; rev: number }, options: { requestId?: string; dependsOn?: string[] } = {}) {
  if (!command) throw new Error('보낼 명령이 없다');
  const draft = openOrRestoreDraft(null, command, basis, options);
  const envelope = envelopeFor(draft, command, expect);
  if (!envelope) throw new Error('봉투가 없다');
  return { outcome: await client.command(envelope), requestId: draft.requestId };
}

describe('설정: 배달 목록(delivery_list)과 기사 메뉴(plan §8 D4)', () => {
  it('기사 태블릿 판: 배달 도장 사슬(적재 → 지급, first_open, 칸 머리 `배달`) · 팀 · 품목 · 전화, 탭 전체 · 잔여, 숫자 완료 · 전송 대기 · 잔여, 주 버튼 다음 배달', () => {
    const view = resolveLedgerView(uiDefaults.ledger_views, 'delivery_list', 'driver_tablet')!;
    expect(view.screen_key).toBe('driver_list');
    expect(view.group_by_key).toBe('time_bucket');
    expect(view.columns.map((c) => c.column_key)).toEqual(['stamp:deliver', 'team', 'items', 'action:call']);
    expect(view.columns[0]).toMatchObject({ header_label: '배달', step_keys: ['load', 'issue'], stamp_rollup_key: 'first_open' });
    expect(view.tabs.map((t) => t.label)).toEqual(['전체', '잔여']);
    expect(view.metrics.map((m) => m.label)).toEqual(['완료', '전송 대기', '잔여']);
    // 주 버튼은 다음 할 배달(읽기 모델 nextTask `배달 처리 · 6개`): 매장 입고는 수거 목록의 일이다(plan §8 D56).
    expect(view.primary_actions.map((p) => p.action_key)).toEqual(['next_step']);
    const phone = resolveLedgerView(uiDefaults.ledger_views, 'delivery_list', 'driver_phone')!;
    expect(phone.primary_actions.map((p) => p.action_key)).toEqual(['next_step']);
    // 휴대폰 판은 칸을 덮는다(팀 11.5em, 품목은 팀 칸 둘째 줄: 바탕 판의 fold second_line).
    expect(phone.columns.map((c) => c.column_key)).toEqual(['stamp:deliver', 'team', 'items', 'action:call']);
    expect(phone.columns.find((c) => c.column_key === 'team')?.min_width_em).toBe(11.5);
    expect(phone.tabs).toEqual(view.tabs);
    expect(uiDefaults.rev).toBe(5);
  });

  it('기사 메뉴: 배달 목록 · 수거 목록(화면 driver_list) · 차량 재고, 목록 행은 메뉴 키로 경로를 고른다', () => {
    const driver = uiDefaults.menu_entries.filter((m) => m.workspace_key === 'driver').map((m) => [m.key, m.label, m.screen_key]);
    expect(driver).toEqual([['delivery_list', '배달 목록', 'driver_list'], ['collection_list', '수거 목록', 'driver_list'], ['van_stock', '차량 재고', 'van_stock']]);
    expect(driverListRoute('delivery_list', '2026-12-26', 'phone')).toEqual({ name: 'deliveries', date: '2026-12-26', device: 'phone' });
    expect(driverListRoute('collection_list', '2026-12-26', 'tablet')).toEqual({ name: 'driver', date: '2026-12-26', device: 'tablet' });
    expect(driverListRoute('van_stock', '2026-12-26', 'tablet')).toBeNull();
  });
});

describe('배달 목록(ledgerView delivery_list)', () => {
  it('15:40: 최하은 팀 한 줄(17:00 배달 묶음, 만선 광장), 아직 싣지 않아 적재 미처리, 완료 0 · 전송 대기 0 · 잔여 1', async () => {
    const { client } = at(0);
    const list = await client.ledgerView('delivery_list', { deviceClass: 'driver_tablet' });
    expect(list.groups).toEqual([{ key: 'd1700', label: '17:00 배달', shortLabel: '17:00', at: iso(17, 0), done: 0, total: 1 }]);
    expect(list.rows.map((r) => [r.id, r.subgroupLabel, r.groupKey])).toEqual([['deliver:o26', '만선 광장', 'd1700']]);
    expect(stampOf(list.rows[0]!.cells['stamp:deliver'])).toEqual({ stepKey: 'load', state: 'todo' });
    expect(list.rows[0]!.cells['items']).toEqual({ renderer: 'items', items: [{ label: '스키', qty: 3 }, { label: '헬멧', qty: 3 }] });
    expect(list.metrics.map((m) => (m.unit === 'count' ? m.value : null))).toEqual([0, 0, 1]);
    expect(list.tabCounts).toEqual({ all: 1, remaining: 1 });
    expect(list.visitReasons?.map((r) => r.label)).toEqual(['고객 부재', '장소 변경', '기타']);
  });

  it('16:55(16:40 적재 뒤): 기사가 할 배달 단계가 미처리 `배달`(카운터의 보라 `차량 17:00`이 아님), 16:57 배달 뒤에는 완료 `배달` 16:57', async () => {
    const { client } = at(75);
    const list = await client.ledgerView('delivery_list', { deviceClass: 'driver_tablet' });
    expect(stampOf(list.rows[0]!.cells['stamp:deliver'])).toEqual({ stepKey: 'issue', state: 'todo', label: '배달' });
    // 카운터의 장부는 그대로 차량 담당(보라 '차량 17:00', 이름 없음).
    const ledger = await client.ledgerView('day_ledger', {});
    expect(stampOf(ledger.rows.find((r) => r.id === 'o26')?.cells['stamp:issue'])).toMatchObject({ stepKey: 'issue', state: 'delegated', at: iso(17, 0) });
    expect(stampOf(ledger.rows.find((r) => r.id === 'o26')?.cells['stamp:issue'])?.label).toBeUndefined();
    client.advanceClock(2);
    const after = await client.ledgerView('delivery_list', { deviceClass: 'driver_tablet' });
    expect(stampOf(after.rows[0]!.cells['stamp:deliver'])).toEqual({ stepKey: 'issue', state: 'done', label: '배달', at: iso(16, 57) });
    expect(after.metrics.map((m) => (m.unit === 'count' ? m.value : null))).toEqual([1, 0, 0]);
    expect(after.tabCounts).toEqual({ all: 1, remaining: 0 });
  });
});

describe('V7 업무 판(taskSheet) — 16:55 최하은 팀', () => {
  it('시안의 글: 제목 · 팀 · 품목 표(적재 16:40 · 배달 미처리) · 돈 줄 · 큰 버튼 넷 · 반납 일정 · 완료 0 · 잔여 1 · 배달 처리 · 6개', async () => {
    const { client } = at(75);
    const view = await client.query('taskSheet', { taskId: 'deliver:o26', deviceClass: 'driver_tablet' });
    expect(view).toMatchObject({
      taskId: 'deliver:o26', orderId: 'o26', kind: 'deliver', title: '배달 · 17:00 만선 광장', team: '최하은 · 0026', teamName: '최하은', last4: '0026',
      contact: '010-0000-0026 · 3명', phone: '010-0000-0026', progress: '완료 0 · 잔여 1', vehicle: { id: 'v1', label: '1호 차량' },
      returnPlan: ['오늘 22:10 · 만선 티롤 앞 · 1호 차량'],
      primary: { label: '배달 처리 · 6개', alts: ['배달 처리 · 6개', '배달 처리'], enabled: true, actionKey: 'stamp.issue' },
    });
    expect(view.columns.map((c) => c.label)).toEqual(['품목', '수량', '적재', '배달']);
    expect(view.lines.map((l) => [l.label, l.qtyText])).toEqual([['스키', '3대'], ['헬멧', '3개']]);
    expect(lineStamps(view, 'load')).toEqual(Array(2).fill({ stepKey: 'load', state: 'done', at: iso(16, 40) }));
    expect(lineStamps(view, 'deliver')).toEqual(Array(2).fill({ stepKey: 'issue', state: 'todo', label: '배달' }));
    expect(view.money?.map(text)).toEqual(['미수 없음 · 12/25 계좌이체 수납']);
    expect(view.money?.[0]?.[0]).toEqual({ text: '미수 없음', strong: true, tone: 'green' });
    expect(view.actions.map((a) => [a.actionKey, a.label, a.secondLine ?? null, a.enabled])).toEqual([
      // 미수가 없으면 현장 수납은 누를 수 없다(숫자판이 할 일이 없음, 2026-09-26 검토). 리프트권 추가 뒤의 수납은 판이 이어서 연다.
      ['field_collect', '현장 수납', null, false], ['add_ticket', '리프트권 추가', '야간권 재고 6매', true],
      ['not_delivered', '배달 실패', null, true], ['call', '전화', null, true],
    ]);
    expect(view.visitReasons.map((r) => r.label)).toEqual(['고객 부재', '장소 변경', '기타']);
  });

  it('15:40(싣기 전): 배달 칸은 대기 `배달 불가 · 적재 대기`, 주 버튼은 매장에서 `적재 처리 · 6개`', async () => {
    const { client } = at(0);
    const view = await client.query('taskSheet', { taskId: 'deliver:o26' });
    expect(lineStamps(view, 'load')).toEqual(Array(2).fill({ stepKey: 'load', state: 'todo' }));
    expect(lineStamps(view, 'deliver')[0]).toEqual({ stepKey: 'issue', state: 'blocked', label: '배달', blockedBy: { stepKey: 'load', message: '배달 불가 · 적재 대기' } });
    expect(view.primary).toEqual({ label: '적재 처리 · 6개', alts: ['적재 처리 · 6개', '적재 처리'], enabled: true, actionKey: 'stamp.load' });
    const load = await client.query('confirmDraft', { orderId: 'o26', taskId: 'deliver:o26', actionKey: 'stamp.load' });
    expect(load).toMatchObject({ title: '적재 처리 · 최하은 팀', confirmLabel: '적재 처리 · 6개', command: { type: 'stock.load', payload: { taskId: 'deliver:o26' } } });
    // 싣기 전의 배달 창: 창 대신 한 줄.
    expect(await client.query('confirmDraft', { orderId: 'o26', taskId: 'deliver:o26', actionKey: 'stamp.issue' })).toMatchObject({ notice: '배달 불가 · 적재 대기' });
  });

  it('없는 업무는 NOT_FOUND', async () => {
    const { client } = at(0);
    await expect(client.query('taskSheet', { taskId: 'deliver:o99' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('배달 처리(stock.deliver)', () => {
  it('번호 매장: 실은 번호(준비 번호 맨 앞)를 건넨다', async () => {
    const { client, state } = at(75, true, 'numbered');
    const planned = order(state(), 'o26').lines.map((l) => [...(l.plannedAssetIds ?? [])]);
    expect(planned.map((ids) => ids.length)).toEqual([3, 3]);
    const draft = await client.query('confirmDraft', { orderId: 'o26', taskId: 'deliver:o26', actionKey: 'stamp.issue' });
    expect((await confirmAll(client, draft)).outcome).toBe('applied');
    expect(order(state(), 'o26').lines.map((l) => l.assetIds)).toEqual(planned.map((ids) => ids.slice(0, 3)));
  });

  it('확인 창 `배달 처리 · 최하은 팀` · `배달 처리 · 6개` → 실은 수를 지급(첫 매장: 번호 없음), 업무 판 `배달 완료 · 16:55` · 주 버튼 누를 수 없음, 카운터 장부는 지급 완료', async () => {
    const { client, state } = at(75);
    const draft = await client.query('confirmDraft', { orderId: 'o26', taskId: 'deliver:o26', actionKey: 'stamp.issue' });
    expect(draft).toMatchObject({ title: '배달 처리 · 최하은 팀', summary: ['스키 3 · 헬멧 3'], confirmLabel: '배달 처리 · 6개' });
    expect(draft.command).toEqual({ type: 'stock.deliver', payload: { taskId: 'deliver:o26', lines: [{ lineId: 'o26-l1', quantity: 3 }, { lineId: 'o26-l2', quantity: 3 }] } });
    expect((await confirmAll(client, draft)).outcome).toBe('applied');
    const o = order(state(), 'o26');
    expect(o.lines.map((l) => [l.issued, l.issuedAt])).toEqual([[3, ms(16, 55)], [3, ms(16, 55)]]);
    expect(o.lines.some((l) => l.assetIds || l.plannedAssetIds)).toBe(false);
    const view = await client.query('taskSheet', { taskId: 'deliver:o26' });
    expect(lineStamps(view, 'deliver')).toEqual(Array(2).fill({ stepKey: 'issue', state: 'done', label: '배달', at: iso(16, 55) }));
    expect(view.progress).toBe('배달 완료 · 16:55');
    expect(view.primary).toMatchObject({ label: '배달 처리', enabled: false });
    expect(view.actions.find((a) => a.actionKey === 'not_delivered')).toMatchObject({ enabled: false, reason: '배달 완료' });
    const ledger = await client.ledgerView('day_ledger', {});
    expect(stampOf(ledger.rows.find((r) => r.id === 'o26')?.cells['stamp:issue'])).toEqual({ stepKey: 'issue', state: 'done', at: iso(16, 55) });
    expect(await client.query('confirmDraft', { orderId: 'o26', taskId: 'deliver:o26', actionKey: 'stamp.issue' })).toMatchObject({ notice: '배달 완료' });
  });

  it('줄 하나의 배달 칸: 수량 −/+(부분 배달)', async () => {
    const { client, state } = at(75);
    const draft = await client.query('confirmDraft', { orderId: 'o26', taskId: 'deliver:o26', actionKey: 'stamp.issue', lineIds: ['o26-l1'] });
    expect(draft.quantity).toEqual({ value: 3, min: 1, max: 3, unit: '개' });
    expect((await confirmAll(client, draft, 2)).outcome).toBe('applied');
    expect(order(state(), 'o26').lines[0]!.issued).toBe(2);
    const view = await client.query('taskSheet', { taskId: 'deliver:o26' });
    expect(lineStamps(view, 'deliver')[0]).toEqual({ stepKey: 'issue', state: 'partial', label: '배달', progress: { done: 2, total: 3 } });
    expect(view.primary.label).toBe('배달 처리 · 4개');
  });
});

describe('리프트권 추가 → 현장 수납(field.add_ticket · field.collect) — 첫 매장(수량 예비권 · 보증금 없음)', () => {
  it('판: 권종(차량 예비권 6매) · 1매 · 값, 보증금 줄 없음, 주 버튼 `리프트권 추가 · 1매`, 명령은 번호 없이 수 · 가격 확인 값', async () => {
    const { client } = at(75);
    const sheet = await client.query('addTicketSheet', { taskId: 'deliver:o26' });
    expect(sheet.title).toBe('리프트권 추가 · 최하은 팀');
    expect(sheet.products).toEqual([{ key: 'night_adult', label: '야간권', secondLine: '재고 6매', selected: true, enabled: true }]);
    expect(sheet.quantity).toEqual({ value: 1, min: 1, max: 6, unit: '매' });
    expect(sheet.lines.map(text)).toEqual(['야간권 1매 35,000원']);
    expect(sheet.primary.label).toBe('리프트권 추가 · 1매');
    expect(sheet.command).toEqual({
      type: 'field.add_ticket', payload: { taskId: 'deliver:o26', orderId: 'o26', productKey: 'night_adult', quantity: 1, assetIds: [], amount: 35_000 },
    });
    expect(sheet.expect).toEqual({ quoteHash: 'ticket:night_adultx1=35000:d0' });
    expect((await client.query('addTicketSheet', { taskId: 'deliver:o26', quantity: 9 })).quantity).toEqual({ value: 6, min: 1, max: 6, unit: '매' });
  });

  it('권 줄(지급 · 반납 필수 · 수량) · 차량 예비권 6 → 5매 → 현장 수납 판(기사 수단 현금 · 계좌이체, 미수 35,000원) → 수납 현금 35,000원(차량 지갑)', async () => {
    const { client, state } = at(75);
    const sheet = await client.query('addTicketSheet', { taskId: 'deliver:o26' });
    const added = await sendPanel(client, sheet.command, sheet.expect, sheet.basis);
    expect(added.outcome.outcome).toBe('applied');
    const o = order(state(), 'o26');
    expect(o.lines.at(-1)).toMatchObject({ id: 'o26-l3', kind: 'night_adult', qty: 1, unit: '매', amount: 35_000, section: 'lift', returnable: true, tracking: 'count', issued: 1, issuedAt: ms(16, 55) });
    expect(o.lines.at(-1)!.assetIds).toBeUndefined();
    expect(state().deposits).toEqual([]);
    expect(state().vanSpares).toEqual([{ vehicleId: 'v1', productKey: 'night_adult', quantity: 5 }]);
    expect(spareTickets(state(), 'v1')).toEqual([{ productKey: 'night_adult', quantity: 5, ids: [] }]);

    const pay = await client.query('fieldPaySheet', { taskId: 'deliver:o26' });
    expect(text(pay.due)).toBe('미수 35,000원');
    // 카드 단말기는 카운터 1대: 기사는 현금 · 계좌이체만(그 밖은 매장에서 후불).
    expect(pay.methods.map((m) => m.label + (m.selected ? '*' : ''))).toEqual(['현금*', '계좌이체']);
    expect(pay.primary).toEqual({ label: '현장 수납 · 현금 35,000원', alts: ['현장 수납 · 현금 35,000원', '현장 수납 · 35,000원', '현장 수납'], enabled: true });
    expect(pay.leaveUnpaid).toEqual({ label: '후불 처리', command: { type: 'payment_promise.set', payload: { orderId: 'o26', payerOrderId: null } } });
    const card = await sendPanel(client, { type: 'field.collect', payload: { taskId: 'deliver:o26', orderId: 'o26', amount: 35_000, methodKey: 'card' } }, pay.expect, pay.basis);
    expect(card.outcome).toMatchObject({ outcome: 'rejected', error: { message: '등록되지 않은 결제 수단' } });
    const paid = await sendPanel(client, pay.command, pay.expect, pay.basis, { dependsOn: [added.requestId] });
    expect(paid.outcome.outcome).toBe('applied');
    expect(ownDue(order(state(), 'o26'))).toBe(0);
    expect(state().paymentGroups.at(-1)).toEqual({ id: paid.requestId, purpose: 'driver_field', amount: 35_000, methodKey: 'cash', at: ms(16, 55), drawerId: 'van:v1' });

    const view = await client.query('taskSheet', { taskId: 'deliver:o26' });
    expect(view.money?.map(text)).toEqual(['미수 없음 · 16:55 현금 수납']);
    expect(view.returnPlan).toEqual(['오늘 22:10 · 만선 티롤 앞 · 1호 차량', '권 1매 포함']);
    expect(view.actions.find((a) => a.actionKey === 'add_ticket')?.secondLine).toBe('야간권 재고 5매');
    // 권 추가에 이어 연 판: 보증금이 없어 받을 금액은 미수 한 줄.
    const after = await client.query('fieldPaySheet', { taskId: 'deliver:o26', afterTicket: added.requestId });
    expect(text(after.due)).toBe('미수 없음');
  });

  it('차량 예비권보다 많이 · 번호를 붙여 보내면 거절(차량 권 재고 없음), 예비권을 다 쓰면 판이 막힌다', async () => {
    const { client, state } = at(75);
    const sheet = await client.query('addTicketSheet', { taskId: 'deliver:o26' });
    const seven = await sendPanel(client, { type: 'field.add_ticket', payload: { taskId: 'deliver:o26', orderId: 'o26', productKey: 'night_adult', quantity: 7, assetIds: [], amount: 245_000 } }, sheet.expect, sheet.basis);
    expect(seven.outcome).toMatchObject({ outcome: 'rejected', error: { message: '차량 권 재고 없음' } });
    const numbered = await sendPanel(client, { type: 'field.add_ticket', payload: { taskId: 'deliver:o26', orderId: 'o26', productKey: 'night_adult', quantity: 1, assetIds: ['night_adult-51'], amount: 35_000 } }, sheet.expect, sheet.basis);
    expect(numbered.outcome).toMatchObject({ outcome: 'rejected', error: { message: '차량 권 재고 없음' } });
    const six = await client.query('addTicketSheet', { taskId: 'deliver:o26', quantity: 6 });
    expect((await sendPanel(client, six.command, six.expect, six.basis)).outcome.outcome).toBe('applied');
    expect(state().vanSpares).toEqual([{ vehicleId: 'v1', productKey: 'night_adult', quantity: 0 }]);
    const empty = await client.query('addTicketSheet', { taskId: 'deliver:o26' });
    expect(empty.lines.map(text)).toEqual(['차량 권 재고 없음']);
    expect(empty.primary.enabled).toBe(false);
    expect((await client.query('taskSheet', { taskId: 'deliver:o26' })).actions.find((a) => a.actionKey === 'add_ticket'))
      .toMatchObject({ secondLine: '차량 권 재고 없음', enabled: false, reason: '차량 권 재고 없음' });
  });
});

describe('리프트권 추가 — 번호 · 권 보증금을 켠 매장(numbered)', () => {
  it('판: 권종(차량 예비권) · 1매 · 값 · 보증금, 주 버튼 `리프트권 추가 · 1매 · 보증금 5,000원`, 명령은 예비권 51번 · 가격 확인 값', async () => {
    const { client } = at(75, true, 'numbered');
    const sheet = await client.query('addTicketSheet', { taskId: 'deliver:o26' });
    expect(sheet.title).toBe('리프트권 추가 · 최하은 팀');
    expect(sheet.products).toEqual([{ key: 'night_adult', label: '야간권', secondLine: '재고 6매', selected: true, enabled: true }]);
    expect(sheet.quantity).toEqual({ value: 1, min: 1, max: 6, unit: '매' });
    expect(sheet.lines.map(text)).toEqual(['야간권 1매 35,000원', '리프트권 보증금 · 1매 · 매장 기준 1매 5,000원 · 반납 시 반환 · 현금 5,000원']);
    expect(sheet.primary.label).toBe('리프트권 추가 · 1매 · 보증금 5,000원');
    expect(sheet.command).toEqual({
      type: 'field.add_ticket',
      payload: { taskId: 'deliver:o26', orderId: 'o26', productKey: 'night_adult', quantity: 1, assetIds: ['night_adult-51'], amount: 35_000, deposit: { ruleKey: 'lift_ticket_card', amount: 5_000 } },
    });
    expect(sheet.expect).toEqual({ quoteHash: 'ticket:night_adultx1=35000:d5000' });
    const two = await client.query('addTicketSheet', { taskId: 'deliver:o26', quantity: 2 });
    expect(two.primary.label).toBe('리프트권 추가 · 2매 · 보증금 10,000원');
  });

  it('권 줄(지급 · 반납 필수) · 보증금 입금(차량 지갑) → 현장 수납 판(미수 35,000원 · 후불 처리) → 수납(dependsOn) 현금 35,000원(결제 자리 driver_field · 차량 지갑)', async () => {
    const { client, state } = at(75, true, 'numbered');
    const sheet = await client.query('addTicketSheet', { taskId: 'deliver:o26' });
    const added = await sendPanel(client, sheet.command, sheet.expect, sheet.basis);
    expect(added.outcome.outcome).toBe('applied');
    const o = order(state(), 'o26');
    expect(o.lines.at(-1)).toMatchObject({ id: 'o26-l3', kind: 'night_adult', label: '야간권 성인', qty: 1, unit: '매', amount: 35_000, section: 'lift', returnable: true, issued: 1, issuedAt: ms(16, 55), assetIds: ['night_adult-51'] });
    const dep = depositOf(state(), 'o26', 'lift_ticket_card')!;
    expect(dep.entries).toEqual([expect.objectContaining({ kind: 'take', lineId: 'o26-l3', quantity: 1, amount: 5_000, methodKey: 'cash', drawerId: 'van:v1', assetIds: ['night_adult-51'] })]);
    expect(spareTickets(state(), 'v1')).toEqual([{ productKey: 'night_adult', quantity: 5, ids: ['night_adult-52', 'night_adult-53', 'night_adult-54', 'night_adult-55', 'night_adult-56'] }]);

    const pay = await client.query('fieldPaySheet', { taskId: 'deliver:o26' });
    expect(pay.title).toBe('현장 수납 · 최하은 팀');
    expect(text(pay.due)).toBe('미수 35,000원');
    // 견본 매장(번호 · 보증금)은 기사도 카드를 받는다(시안 V7의 세 버튼 기사 수단 줄, spec 2-3).
    expect(pay.methods.map((m) => m.label + (m.selected ? '*' : ''))).toEqual(['카드', '현금*', '계좌이체']);
    expect(pay.amount).toEqual({ value: 35_000, max: 35_000 });
    expect(pay.primary).toEqual({ label: '현장 수납 · 현금 35,000원', alts: ['현장 수납 · 현금 35,000원', '현장 수납 · 35,000원', '현장 수납'], enabled: true });
    expect(pay.leaveUnpaid).toEqual({ label: '후불 처리', command: { type: 'payment_promise.set', payload: { orderId: 'o26', payerOrderId: null } } });
    expect(pay.expect).toEqual({ dueAmount: 35_000 });
    const paid = await sendPanel(client, pay.command, pay.expect, pay.basis, { dependsOn: [added.requestId] });
    expect(paid.outcome.outcome).toBe('applied');
    expect(ownDue(order(state(), 'o26'))).toBe(0);
    expect(state().paymentGroups.at(-1)).toEqual({ id: paid.requestId, purpose: 'driver_field', amount: 35_000, methodKey: 'cash', at: ms(16, 55), drawerId: 'van:v1' });

    const view = await client.query('taskSheet', { taskId: 'deliver:o26' });
    expect(view.money?.map(text)).toEqual(['미수 없음 · 16:55 현금 수납 · 보증금 · 권 1매 5,000원']);
    expect(view.returnPlan).toEqual(['오늘 22:10 · 만선 티롤 앞 · 1호 차량', '권 1매 포함 · 보증금 5,000원 반환']);
    expect(view.actions.find((a) => a.actionKey === 'add_ticket')?.secondLine).toBe('야간권 재고 5매');
  });

  it('현장 수납 판: 미수가 없으면 받을 돈이 없다(넣은 금액도 누를 수 없음), 받을 돈보다 많이는 받지 않는다', async () => {
    const { client } = at(75);
    const sheet = await client.query('fieldPaySheet', { taskId: 'deliver:o26' });
    expect(text(sheet.due)).toBe('미수 없음');
    expect(sheet.amount).toEqual({ value: 0, max: 0 });
    expect(sheet.primary).toEqual({ label: '현장 수납', alts: ['현장 수납'], enabled: false });
    expect(sheet.command).toBeUndefined();
    expect(sheet.leaveUnpaid).toBeUndefined();
    const typed = await client.query('fieldPaySheet', { ...withAmount({ taskId: 'deliver:o26', methodKey: 'transfer' }, '10000') });
    expect(typed.primary).toEqual({ label: '현장 수납', alts: ['현장 수납'], enabled: false });
    expect(typed.command).toBeUndefined();
    expect(withAmount({ taskId: 't' }, '')).toEqual({ taskId: 't', amount: 0 });
  });

  it('권 추가에 이어 연 판(afterTicket): 받을 금액이 권 값 + 방금 받은 보증금(손에 받을 현금), 끊긴 기기에서는 전송 대기의 권 값을 받을 돈으로', async () => {
    const { client } = at(75, true, 'numbered');
    const sheet = await client.query('addTicketSheet', { taskId: 'deliver:o26' });
    const added = await sendPanel(client, sheet.command, sheet.expect, sheet.basis);
    const pay = await client.query('fieldPaySheet', { taskId: 'deliver:o26', afterTicket: added.requestId });
    expect(text(pay.due)).toBe('받을 금액 현금 40,000원 = 리프트권 35,000원 + 보증금 5,000원');
    expect(pay.primary.label).toBe('현장 수납 · 현금 35,000원');
    // 받을 돈(35,000원)보다 많이 넣으면 누를 수 없다(줄에 넣을 수 없는 돈은 수납이 아니다).
    const over = await client.query('fieldPaySheet', { ...withAmount({ taskId: 'deliver:o26', afterTicket: added.requestId }, '40000') });
    expect(over.primary.enabled).toBe(false);

    const offline = at(75, true, 'numbered');
    offline.client.setOffline(true);
    const sheet2 = await offline.client.query('addTicketSheet', { taskId: 'deliver:o26' });
    const queued = await sendPanel(offline.client, sheet2.command, sheet2.expect, sheet2.basis);
    expect(queued.outcome.outcome).toBe('queued');
    const pay2 = await offline.client.query('fieldPaySheet', { taskId: 'deliver:o26', afterTicket: queued.requestId });
    expect(text(pay2.due)).toBe('받을 금액 현금 40,000원 = 리프트권 35,000원 + 보증금 5,000원');
    expect(pay2.primary).toMatchObject({ label: '현장 수납 · 현금 35,000원', enabled: true });
    const paid = await sendPanel(offline.client, pay2.command, pay2.expect, pay2.basis, { dependsOn: [queued.requestId] });
    expect(paid.outcome.outcome).toBe('queued');
    offline.client.setOffline(false);
    expect(ownDue(order(offline.state(), 'o26'))).toBe(0);
  });

  it('창이 본 값과 다르면 충돌(가격 · 받을 금액), 보냄 대기로 온 명령은 참고 값이라 적는다(sync 8-12)', async () => {
    const { client, state } = at(75, true, 'numbered');
    const sheet = await client.query('addTicketSheet', { taskId: 'deliver:o26' });
    const stale = await sendPanel(client, sheet.command, { quoteHash: 'ticket:old' }, sheet.basis);
    expect(stale.outcome).toMatchObject({ outcome: 'conflict', error: { code: 'QUOTE_CHANGED', message: '받을 금액 변경됨 · 재시도 필요' } });
    const wrongDue = await sendPanel(client, { type: 'field.collect', payload: { taskId: 'deliver:o26', orderId: 'o26', amount: 10_000, methodKey: 'cash' } }, { dueAmount: 5_000 }, sheet.basis);
    expect(wrongDue.outcome).toMatchObject({ outcome: 'conflict', error: { code: 'DUE_CHANGED' } });
    // 끊긴 기사 기기: 쌓였다가 다시 연결되면 옛 바탕이어도 적힌다.
    client.setOffline(true);
    const queued = await sendPanel(client, sheet.command, { quoteHash: 'ticket:old' }, sheet.basis);
    expect(queued.outcome.outcome).toBe('queued');
    expect(order(state(), 'o26').lines).toHaveLength(2);
    client.setOffline(false);
    expect(order(state(), 'o26').lines).toHaveLength(3);
    // 차량에 없는 번호는 권을 줄 수 없다.
    const bad = await sendPanel(client, { type: 'field.add_ticket', payload: { taskId: 'deliver:o26', orderId: 'o26', productKey: 'night_adult', quantity: 1, assetIds: ['night_adult-31'], amount: 35_000, deposit: { ruleKey: 'lift_ticket_card', amount: 5_000 } } }, sheet.expect, sheet.basis);
    expect(bad.outcome).toMatchObject({ outcome: 'rejected', error: { message: '차량 권 재고 없음' } });
  });

  it('후불 처리(payment_promise.set): 이 팀 미수를 반납 때 받기로(늦음은 그 반납의 늦음: 첫 매장 22:10 차량 수거 + 야간 90분), 판에서 후불 처리가 사라진다', async () => {
    const { client, state } = at(75);
    const sheet = await client.query('addTicketSheet', { taskId: 'deliver:o26' });
    await sendPanel(client, sheet.command, sheet.expect, sheet.basis);
    const pay = await client.query('fieldPaySheet', { taskId: 'deliver:o26' });
    const later = await sendPanel(client, pay.leaveUnpaid?.command, undefined, pay.basis);
    expect(later.outcome.outcome).toBe('applied');
    expect(order(state(), 'o26').payWhen).toBe('return');
    expect((await client.query('fieldPaySheet', { taskId: 'deliver:o26' })).leaveUnpaid).toBeUndefined();
    // 업무 판의 돈 줄이 후불로 적힌 것을 보인다(누른 뒤 아무 표시가 없지 않게, 2026-09-26 검토).
    expect((await client.query('taskSheet', { taskId: 'deliver:o26' })).money?.map(text)).toEqual(['미수 35,000원 · 후불 · 12/25 계좌이체 수납']);
    const again = await sendPanel(client, pay.leaveUnpaid?.command, undefined, pay.basis);
    expect(again.outcome).toMatchObject({ outcome: 'superseded', error: { message: '처리 완료' } });
    const slip = await client.query('orderSlip', { orderId: 'o26' });
    expect(slip.money).toMatchObject({ due: 35_000, lateAt: iso(23, 40) });
  });
});

describe('수거 업무 판 · 수거 현장의 권 보증금 반환(field.deposit_return)', () => {
  it('첫 매장 16:10 박준호 팀 수거 업무: 돈 줄은 미수 한 줄(보증금 없음), 수거 확인 창은 보증금 줄 · 이어진 명령 없이 `수거 처리 · 6개 · 3매`', async () => {
    const { client } = at(30);
    const view = await client.query('taskSheet', { taskId: 'collect:o22' });
    expect(view).toMatchObject({ kind: 'collect', title: '수거 · 22:00 설천 주차장', progress: '완료 0 · 잔여 12' });
    expect(view.lines.map((l) => [l.label, l.qtyText])).toEqual([['스키', '2대'], ['보드', '1대'], ['헬멧', '3개'], ['야간권 성인', '3매']]);
    expect(view.money?.map(text)).toEqual(['미수 120,000원 · 12/24 계좌이체 수납']);
    expect(view.primary).toMatchObject({ label: '수거 처리 · 6개 · 3매', actionKey: 'stamp.collect' });
    const draft = await client.query('confirmDraft', { orderId: 'o22', taskId: 'collect:o22', actionKey: 'stamp.collect' });
    expect(draft.summary).toEqual(['스키 2 · 보드 1 · 헬멧 3 · 야간권 성인 3매']);
    expect(draft.confirmLabel).toBe('수거 처리 · 6개 · 3매');
    expect(draft.then).toBeUndefined();
  });

  it('번호 · 보증금 매장 16:10 박준호 팀 수거 업무: 제목 `수거 · 22:00 설천 주차장`, 수거 칸, 돈 줄 둘째 줄 `권 3매 보증금 15,000원 반환`, 반납 일정 없음, 주 버튼 `수거 처리 · 6개 · 3매`', async () => {
    const { client } = at(30, true, 'numbered');
    const view = await client.query('taskSheet', { taskId: 'collect:o22' });
    // 바닥줄 가운데는 1호 차량 수거 목록의 완료 · 잔여(16:30 · 21:50 · 22:00 · 22:10 업무 중 내준 것이 있는 12).
    expect(view).toMatchObject({ kind: 'collect', title: '수거 · 22:00 설천 주차장', progress: '완료 0 · 잔여 12' });
    expect(view.returnPlan).toBeUndefined();
    expect(view.columns.map((c) => c.label)).toEqual(['품목', '수량', '수거']);
    expect(view.lines.map((l) => [l.label, l.qtyText])).toEqual([['스키', '2대'], ['보드', '1대'], ['헬멧', '3개'], ['야간권 성인', '3매']]);
    expect(lineStamps(view, 'collect')).toEqual(Array(4).fill({ stepKey: 'collect', state: 'todo' }));
    expect(view.money?.map(text)).toEqual(['미수 120,000원 · 12/24 계좌이체 수납 · 보증금 · 권 3매 15,000원', '권 3매 보증금 15,000원 반환']);
    expect(view.actions.map((a) => a.label)).toEqual(['현장 수납', '리프트권 추가', '수거 실패', '전화']);
    expect(view.visitReasons.map((r) => r.label)).toEqual(['고객 부재', '장소 변경', '물품 미준비']);
    expect(view.primary).toMatchObject({ label: '수거 처리 · 6개 · 3매', actionKey: 'stamp.collect' });
  });

  it('번호 · 보증금 매장: 수거 확인 창에 보증금 한 줄 → 수거 · 이어서 현장 반환 15,000원(차량 지갑 현금), 보관 0원', async () => {
    const { client, state } = at(30, true, 'numbered');
    const draft = await client.query('confirmDraft', { orderId: 'o22', taskId: 'collect:o22', actionKey: 'stamp.collect' });
    expect(draft.summary).toEqual(['스키 2 · 보드 1 · 헬멧 3 · 야간권 성인 3매', '권 3매 보증금 15,000원 반환 · 차량 현금']);
    expect(draft.confirmLabel).toBe('수거 처리 · 6개 · 3매 · 보증금 15,000원');
    expect(draft.quantity).toBeUndefined();
    expect(draft.then).toEqual([{
      command: { type: 'field.deposit_return', payload: { taskId: 'collect:o22', orderId: 'o22', ruleKey: 'lift_ticket_card', lines: [{ lineId: 'o22-l4', quantity: 3 }], amount: 15_000 } },
      expect: { depositHeld: 15_000 },
    }]);
    expect((await confirmAll(client, draft)).outcome).toBe('applied');
    const dep = depositOf(state(), 'o22', 'lift_ticket_card')!;
    expect(heldAmount(dep)).toBe(0);
    expect(dep.entries.at(-1)).toMatchObject({ kind: 'refund', quantity: 3, amount: 15_000, methodKey: 'cash', drawerId: 'van:v1', assetIds: ['night_adult-31', 'night_adult-32', 'night_adult-33'] });
    // 권이 돌아오기 전의 반환은 거절(돈이라 멈추지 않지만 앞서 가지 않는다).
    const fresh = at(30, true, 'numbered').client;
    const other = await fresh.query('confirmDraft', { orderId: 'o22', taskId: 'collect:o22', actionKey: 'stamp.collect' });
    const early = await fresh.command(draftToEnvelope(openCommandDraft(other.then![0]!.command, other.basis, { expect: { depositHeld: 15_000 } })));
    expect(early).toMatchObject({ outcome: 'rejected', error: { message: '보증금 반환 불가 · 리프트권 미반납' } });
  });
});

describe('배달 실패(task.visit)', () => {
  it('배달 업무의 사유 `기타` · 재방문은 배달 시각(수령 일정)을 옮긴다, 수거 목록의 재방문 표시와 섞이지 않는다', async () => {
    const { client, state } = at(75);
    const view = await client.query('taskSheet', { taskId: 'deliver:o26' });
    const outcome = await client.command(draftToEnvelope(openCommandDraft({ type: 'task.visit', payload: { taskId: 'deliver:o26', outcomeKey: 'other', retry: { date: '2026-12-26', at: iso(18, 0) } } }, view.basis)));
    expect(outcome.outcome).toBe('applied');
    const o = order(state(), 'o26');
    expect(o.visits?.at(-1)).toEqual({ at: ms(16, 55), kind: 'deliver', outcomeKey: 'other', beforeAt: ms(17, 0), retryAt: ms(18, 0) });
    expect(o.pickup.at).toBe(ms(18, 0));
    expect(o.giveBack.at).toBe(ms(22, 10));
    expect((await client.query('taskSheet', { taskId: 'deliver:o26' })).title).toBe('배달 · 18:00 만선 광장');
    const collect = await client.ledgerView('collection_list', {});
    expect(collect.rows.find((r) => r.orderId === 'o26')?.reviewNote).toBeUndefined();
    const review = await client.query('reviewList', {});
    expect(review.find((r) => r.orderId === 'o26')?.message).toBe('최하은 팀 기타 · 재방문 18:00');
  });
});

describe('끊긴 기사 기기(보냄 대기, sync 8-2)', () => {
  it('배달 · 현장 수납 · 리프트권 추가 · 현장 반환은 쌓이고, 후불 처리 · 적재는 연결 뒤, 배달 도장은 점선(전송 대기)', async () => {
    expect([...OFFLINE_ALLOWED].filter((t) => t.startsWith('field.') || t === 'stock.deliver').sort()).toEqual(['field.add_ticket', 'field.collect', 'field.deposit_return', 'stock.deliver']);
    expect(OFFLINE_ALLOWED.has('payment_promise.set')).toBe(false);
    expect(OFFLINE_ALLOWED.has('stock.load')).toBe(false);
    const { client, state } = at(75);
    client.setOffline(true);
    const draft = await client.query('confirmDraft', { orderId: 'o26', taskId: 'deliver:o26', actionKey: 'stamp.issue' });
    expect((await confirmAll(client, draft)).outcome).toBe('queued');
    expect(client.connection()).toMatchObject({ online: false, pendingCount: 1, lastSyncAt: iso(16, 55) });
    expect((await client.pending()).map((p) => p.summary)).toEqual(['최하은 · 0026 배달 16:55']);
    const view = await client.query('taskSheet', { taskId: 'deliver:o26' });
    expect(lineStamps(view, 'deliver')[0]).toEqual({ stepKey: 'issue', state: 'done', label: '배달', at: iso(16, 55), pending: true });
    const list = await client.ledgerView('delivery_list', {});
    expect(stampOf(list.rows[0]!.cells['stamp:deliver'])).toMatchObject({ state: 'done', pending: true, pressNote: { lines: ['16:55 처리 · 전송 대기'] } });
    expect(list.metrics.map((m) => (m.unit === 'count' ? m.value : null))).toEqual([0, 1, 0]);
    expect(order(state(), 'o26').lines[0]!.issued).toBe(0);
    client.setOffline(false);
    expect(order(state(), 'o26').lines[0]!.issued).toBe(3);
  });
});

describe('뒷이야기 16:40 ~ 22:10(plan.md 4-2)', () => {
  it('첫 매장 17:00: 16:57 배달, 16:58 권 추가(차량 예비권 6 → 5매, 보증금 없음) · 현장 수납 35,000원 현금(차량 지갑)', async () => {
    const { client, state } = at(80);
    const o = order(state(), 'o26');
    expect(o.lines.map((l) => [l.kind, l.issued, l.issuedAt, l.tracking])).toEqual([['ski', 3, ms(16, 57), 'count'], ['helmet', 3, ms(16, 57), 'count'], ['night_adult', 1, ms(16, 58), 'count']]);
    expect(ownDue(o)).toBe(0);
    expect(state().paymentGroups.filter((g) => g.purpose === 'driver_field')).toEqual([
      { id: 'story:haeun-ticket:1', purpose: 'driver_field', amount: 35_000, methodKey: 'cash', at: ms(16, 58), drawerId: 'van:v1' },
    ]);
    expect(state().deposits).toEqual([]);
    expect(state().vanSpares).toEqual([{ vehicleId: 'v1', productKey: 'night_adult', quantity: 5 }]);
    const view = await client.query('taskSheet', { taskId: 'deliver:o26' });
    expect(view.progress).toBe('배달 완료 · 16:58');
    expect(view.returnPlan).toEqual(['오늘 22:10 · 만선 티롤 앞 · 1호 차량', '권 1매 포함']);
  });

  it('번호 · 보증금 매장 17:00: 16:57 배달, 16:58 권 추가(예비권 51번) · 보증금 5,000원 · 현장 수납 35,000원 현금(차량 지갑)', async () => {
    const { client, state } = at(80, true, 'numbered');
    const o = order(state(), 'o26');
    expect(o.lines.map((l) => [l.kind, l.issued, l.issuedAt])).toEqual([['ski', 3, ms(16, 57)], ['helmet', 3, ms(16, 57)], ['night_adult', 1, ms(16, 58)]]);
    expect(ownDue(o)).toBe(0);
    expect(state().paymentGroups.filter((g) => g.purpose === 'driver_field')).toEqual([
      { id: 'story:haeun-ticket:1', purpose: 'driver_field', amount: 35_000, methodKey: 'cash', at: ms(16, 58), drawerId: 'van:v1' },
    ]);
    expect(heldAmount(depositOf(state(), 'o26', 'lift_ticket_card'))).toBe(5_000);
    const view = await client.query('taskSheet', { taskId: 'deliver:o26' });
    expect(view.progress).toBe('배달 완료 · 16:58');
    expect(view.returnPlan).toEqual(['오늘 22:10 · 만선 티롤 앞 · 1호 차량', '권 1매 포함 · 보증금 5,000원 반환']);
  });

  it('첫 매장 23:10: 22:00 일정 1호 차량 수거(22:40, 설천 주차장 · 두솔동 박준호 수량), 22:10 일정 최하은 장비만 · 정하늘 고객 부재(23:05) — 차량 지갑 35,000원, 보증금 없음', async () => {
    const { client, state } = at(7 * 60 + 30);
    const s = state();
    const list = await client.ledgerView('collection_list', { vehicleId: 'v1' });
    expect(list.groups.find((g) => g.key === 's2200')).toMatchObject({ done: 11, total: 11 });
    expect(list.rows.map((r) => r.id)).not.toContain('collect:o22');
    expect(order(s, 'o22').lines.map((l) => [l.returned, l.collected])).toEqual([[2, 0], [0, 1], [2, 1], [2, 1]]);
    expect(order(s, 'o26').lines.map((l) => l.collected)).toEqual([3, 3, 0]);
    const vanIn = s.orders.flatMap((o) => o.payments).filter((p) => p.drawerId === 'van:v1').reduce((n, p) => n + p.amount, 0);
    expect(vanIn).toBe(35_000);
    expect(s.deposits).toEqual([]);
    expect(s.orders.flatMap((o) => o.lines).some((l) => l.assetIds?.length)).toBe(false);
  });

  it('번호 · 보증금 매장 23:10: 22:00 일정 1호 차량 수거(22:40, 설천 주차장 · 두솔동 박준호 + 권 1매 보증금 5,000원 현장 반환), 22:10 일정 최하은 장비만 · 정하늘 고객 부재(23:05) — 차량 지갑 35,000원, 맡은 보증금은 최하은 1매 5,000원뿐', async () => {
    const { client, state } = at(7 * 60 + 30, true, 'numbered');
    const s = state();
    const list = await client.ledgerView('collection_list', { vehicleId: 'v1' });
    // 22:00 묶음: 설천 주차장 7(박준호 원래 일정은 21:31 매장 반납이라 받을 것이 없어 목록에서 빠짐, data-model 4-18) + 강지은 · 이준서 ·
    // 송하윤 + 솔마을 두솔동 박준호.
    expect(list.groups.find((g) => g.key === 's2200')).toMatchObject({ done: 11, total: 11 });
    expect(list.rows.map((r) => r.id)).not.toContain('collect:o22');
    expect(list.groups.find((g) => g.key === 's2210')).toMatchObject({ done: 0, total: 2 });
    const park = order(s, 'o22');
    expect(park.lines.map((l) => [l.returned, l.collected])).toEqual([[2, 0], [0, 1], [2, 1], [2, 1]]);
    const haeun = order(s, 'o26');
    expect(haeun.lines.map((l) => l.collected)).toEqual([3, 3, 0]);
    expect(order(s, 'o41').visits).toEqual([{ at: ms(23, 5), outcomeKey: 'customer_absent', beforeAt: ms(22, 10) }]);
    // 차량 지갑: 권 추가 35,000 + 최하은 보증금 5,000 − 박준호 보증금 5,000.
    const vanIn = s.orders.flatMap((o) => o.payments).filter((p) => p.drawerId === 'van:v1').reduce((n, p) => n + p.amount, 0);
    const vanDeposits = s.deposits.flatMap((d) => d.entries).filter((e) => e.drawerId === 'van:v1').reduce((n, e) => n + (e.kind === 'take' ? e.amount : -e.amount), 0);
    expect(vanIn + vanDeposits).toBe(35_000);
    expect(s.deposits.map((d) => [d.orderId, heldAmount(d)]).filter(([, held]) => held !== 0)).toEqual([['o26', 5_000]]);
    expect(s.storyApplied).toEqual(expect.arrayContaining(['haeun-load', 'haeun-deliver', 'haeun-ticket', 'van-2200', 'tirol-2210']));
  });

  it('첫 매장 21:35: 두솔동 몫의 보드 1 · 헬멧 1을 손님이 카운터에 가져오면 기사 수거 줄의 품목이 남은 권 1매만(수거 창과 같음)', async () => {
    const { client, state } = at(5 * 60 + 55);
    const before = (await client.ledgerView('collection_list', { vehicleId: 'v1' })).rows.filter((r) => r.orderId === 'o22');
    const items = (r: (typeof before)[number]) => (r.cells['items']?.renderer === 'items' ? r.cells['items'].items.map((x) => x.label + ' ' + x.qty + (x.unit ?? '')) : []);
    expect(before.map(items)).toEqual([['보드 1', '헬멧 1', '야간권 1매']]);
    const back = await client.query('returnSheet', { orderId: 'o22', picked: [{ lineId: 'o22-l2', quantity: 1 }, { lineId: 'o22-l3', quantity: 1 }, { lineId: 'o22-l4', quantity: 0 }] });
    expect(back.command).toBeDefined();
    client.setDevice('counter');
    expect((await sendPanel(client, back.command, back.expect, back.basis)).outcome.outcome).toBe('applied');
    client.setDevice('driver');
    expect(order(state(), 'o22').lines.map((l) => l.issued - l.returned - l.collected)).toEqual([0, 0, 0, 1]);
    const after = (await client.ledgerView('collection_list', { vehicleId: 'v1' })).rows.filter((r) => r.orderId === 'o22');
    expect(after.map(items)).toEqual([['야간권 1매']]);
    const draft = await client.query('confirmDraft', { orderId: 'o22', taskId: after[0]!.taskId!, actionKey: 'stamp.collect' });
    expect(draft.summary).toEqual(['야간권 성인 1매']);
  });

  it('사람이 먼저 배달 · 권 추가를 했으면 사건은 건너뛴다', async () => {
    const { client, state } = at(75);
    const draft = await client.query('confirmDraft', { orderId: 'o26', taskId: 'deliver:o26', actionKey: 'stamp.issue' });
    await confirmAll(client, draft);
    const sheet = await client.query('addTicketSheet', { taskId: 'deliver:o26' });
    await sendPanel(client, sheet.command, sheet.expect, sheet.basis);
    client.advanceClock(5);
    const o = order(state(), 'o26');
    expect(o.lines.filter((l) => l.section === 'lift')).toHaveLength(1);
    expect(o.lines[0]!.issuedAt).toBe(ms(16, 55));
    expect(state().outcomes['story:haeun-deliver:0']).toBeUndefined();
    expect(state().outcomes['story:haeun-ticket:0']).toBeUndefined();
  });
});

describe('수거 창의 수량 칸(첫 매장: 부분 수거, 2026-09-26 검토)', () => {
  it('기사 수거 창은 줄마다 −/+ 칸: 권이 없으면 권 줄만 낮추고 수거 처리(보드 · 헬멧만), 권은 목록에 남는다', async () => {
    // 21:35: 박준호 팀은 21:31에 설천 몫을 매장에 반납했고 두솔동 몫(보드 1 · 헬멧 1 · 권 1매)만 차량이 받는다.
    const { client, state } = at(5 * 60 + 55);
    const rows = (await client.ledgerView('collection_list', { vehicleId: 'v1' })).rows.filter((r) => r.orderId === 'o22');
    const taskId = rows[0]!.taskId!;
    const view = await client.query('confirmDraft', { orderId: 'o22', taskId, actionKey: 'stamp.collect' });
    expect(view.counts?.map((c) => [c.label, c.quantity?.value])).toEqual([['보드', 1], ['헬멧', 1], ['야간권 성인', 1]]);
    const picked = withCount(null, view.counts!, 'o22-l4', 0)!;
    expect(picked).toEqual([{ lineId: 'o22-l2', quantity: 1 }, { lineId: 'o22-l3', quantity: 1 }, { lineId: 'o22-l4', quantity: 0 }]);
    const some = await client.query('confirmDraft', { orderId: 'o22', taskId, actionKey: 'stamp.collect', picked });
    expect(some.summary).toEqual(['보드 1 · 헬멧 1', '잔여 · 야간권 성인 1매']);
    expect(some.confirmLabel).toBe('수거 처리 · 2개');
    expect((await confirmAll(client, some)).outcome).toBe('applied');
    expect(order(state(), 'o22').lines.map((l) => l.collected)).toEqual([0, 1, 1, 0]);
    const after = (await client.ledgerView('collection_list', { vehicleId: 'v1' })).rows.filter((r) => r.orderId === 'o22');
    expect(after.map((r) => r.cells['items']?.renderer === 'items' ? r.cells['items'].items.map((x) => x.label + ' ' + x.qty + (x.unit ?? '')) : [])).toEqual([['보드 1', '헬멧 1', '야간권 1매']]);
    const left = await client.query('confirmDraft', { orderId: 'o22', taskId, actionKey: 'stamp.collect' });
    expect(left.summary).toEqual(['야간권 성인 1매']);
    // 모든 칸을 0으로 만드는 바꿈은 받지 않는다(보낼 것이 없는 창).
    expect(withCount(null, left.counts!, 'o22-l4', 0)).toBeNull();
  });

  it('서버로 묻는 초안 인자: 창의 앞 한 줄(lead)은 보내지 않고 고른 수(picked)는 보낸다 — 서버의 모양 검사를 지난다', () => {
    const request = { orderId: 'o22', actionKey: 'stamp.collect' as const, taskId: 'collect:o22:p1', lead: '반납 불가 · 지급 대기' };
    expect(draftParams(request)).toEqual({ orderId: 'o22', actionKey: 'stamp.collect', taskId: 'collect:o22:p1' });
    expect(parseQuery({ name: 'confirmDraft', params: draftParams(request) }).ok).toBe(true);
    const picked = [{ lineId: 'o22-l4', quantity: 0 }];
    expect(parseQuery({ name: 'confirmDraft', params: draftParams(request, picked) }).ok).toBe(true);
    expect(parseQuery({ name: 'confirmDraft', params: request }).ok).toBe(false);
  });
});

describe('업무 판의 크기(spec 3-8: 연결 띠를 늘 뺀 높이, DeviceProfile)', () => {
  const tablet = DEVICE_PROFILES.driver_tablet;
  const phone = DEVICE_PROFILES.driver_phone;
  it('태블릿: 품목 줄 자리 204 · 124(두 줄 88 · 62), 큰 버튼 164 · 124(반납 일정 한 줄), 권 줄이 더해지면 버튼이 그만큼 낮아진다', () => {
    expect(taskRowRoom(tablet, 600, { oneColumn: false, planLines: 1, pager: false })).toBe(204);
    expect(taskRowRoom(tablet, 520, { oneColumn: false, planLines: 1, pager: false })).toBe(124);
    expect(fillRows(204, 2, tablet.fill.rowMinPx, tablet.fill.rowMaxPx).rowPx).toBe(88);
    expect(fillRows(124, 2, tablet.fill.rowMinPx, tablet.fill.rowMaxPx).rowPx).toBe(62);
    expect(taskButtonPx(tablet, 600, 1)).toBe(164);
    expect(taskButtonPx(tablet, 520, 1)).toBe(124);
    expect(planPx(tablet, 2)).toBe(tablet.minTargetPx + 28);
    expect(taskButtonPx(tablet, 520, 2)).toBe(110);
    expect(taskButtonPx(tablet, 520, 0)).toBe(158);
  });

  it('휴대폰 360×640(첫 매장 기사의 주 기기, D7): 배달 품목 세 줄(스키 · 헬멧 · 야간권, 누르는 곳 56 이상)과 반납 일정 한 줄이 한 쪽에 든다', () => {
    // 반납 일정은 이름을 앞에 붙인 한 줄(위 사이 8 + 본문 18 × 4/3). 연결 띠는 보일 때만 뺀다.
    expect(phonePlanPx(phone, 1)).toBe(32);
    expect(phonePlanPx(phone, 2)).toBe(60);
    expect(taskRowRoom(phone, 640, { oneColumn: true, planLines: 1, pager: false })).toBe(144);
    const online = taskRowRoom(phone, 640, { oneColumn: true, planLines: 1, pager: false, strip: false });
    expect(online).toBe(176);
    expect(fillRows(online, 3, phone.fill.rowMinPx, phone.fill.rowMaxPx)).toEqual({ rowPx: 58, perPage: 3, pageCount: 1 });
    // 연결됨: 권 줄(`권 1매 포함`, 표의 권 줄과 같은 사실)만 빠지고 일정 한 줄 + 품목 세 줄.
    expect(phoneTaskLayout(phone, 640, 3, 2, false)).toMatchObject({ plan: 1, pager: false, rows: { perPage: 3, pageCount: 1 } });
    // 끊김(띠 32): 일정 줄도 빠지고 품목 세 줄은 그대로 한 쪽.
    expect(phoneTaskLayout(phone, 640, 3, 2, true)).toMatchObject({ plan: 0, pager: false, rows: { perPage: 3, pageCount: 1 } });
    // 수거 판(일정 없음)은 끊겨도 세 줄.
    expect(phoneTaskLayout(phone, 640, 3, 0, true)).toMatchObject({ plan: 0, pager: false, rows: { perPage: 3 } });
    // 다섯 줄은 일정 없이 표 아래 쪽 넘김(한 쪽 둘 이상).
    const many = phoneTaskLayout(phone, 640, 5, 2, false);
    expect(many.pager).toBe(true);
    expect(many.plan).toBe(0);
    expect(many.rows.perPage).toBeGreaterThanOrEqual(2);
    // 390×740: 일정 두 줄 + 품목 세 줄.
    expect(phoneTaskLayout(phone, 740, 3, 2, true)).toMatchObject({ plan: 2, pager: false, rows: { perPage: 3 } });
  });
});

describe('기본 설정의 판(체험 자료가 쓰는 화면 설정)', () => {
  it('defaultUiConfig에 배달 목록 판이 있다', () => {
    const config = defaultUiConfig({ shopName: '체험' });
    expect(config.ledgerViews.filter((v) => v.key === 'delivery_list').map((v) => v.device_class_key)).toEqual(['driver_tablet', 'driver_phone']);
  });
});

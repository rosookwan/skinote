// 즉시 교환(features-1 plan §7): 교환 창(ExchangeDialog)이 고른 것(교환 품목 · 수 · 지급 사이즈)을 인자로 exchangeSheet를 다시 묻고, 확정하면 창을
// 연 때의 요청번호로 exchange.swap을 보낸다. 체험판(FixtureClient)에서 접수증이 지금 사이즈와 출처 줄을 보이고, 돈은 그대로다. 옆 동작 `즉시 교환`은
// 사이즈가 있는 수량 줄에 바꿀 것이 있을 때만(조건 exchangeable), 카운터 권한(exchange.manage)으로 보인다.
import {
  availableActions, defaultUiConfig, envelopeFor, openCommandDraft, resolveLedgerView, type ExchangeSheetView,
} from '@skinote/contract';
import { charged, paidTotal, type FxState } from '@skinote/domain';
import { describe, expect, it } from 'vitest';
import { withItem, withQuantity, withSize } from '../src/components/ExchangeDialog.tsx';
import { DEMO_COUNTER_PERMISSIONS, FixtureClient } from '../src/fixture/fixture-client.ts';

function demo(options: { viewer?: 'counter' } = {}) {
  const client = new FixtureClient({ realNow: () => 1_800_000_000_000, ...options });
  const state = () => (client as unknown as { state: FxState }).state;
  return { client, state };
}

async function confirm(client: FixtureClient, opened: ExchangeSheetView, view: ExchangeSheetView) {
  const draft = openCommandDraft({ type: 'exchange.swap', payload: { orderId: 'x', lineId: '', quantity: 1, from: '', to: '', planned: false } }, opened.basis);
  const envelope = envelopeFor(draft, view.command);
  expect(envelope).not.toBeNull();
  return client.command(envelope!);
}

describe('교환 창(ExchangeDialog)', () => {
  it('백승현 팀 헬멧 4 중 1개를 다른 사이즈로: 품목 · 수 · 사이즈를 고르면 주 버튼과 명령, 확정하면 접수증 줄 이름 · 출처 줄, 돈 그대로', async () => {
    const { client, state } = demo();
    const opened = await client.query('exchangeSheet', { orderId: 'o35' });
    expect(opened.title).toBe('즉시 교환 · 백승현 팀');
    expect(opened.items).toHaveLength(1);
    const item = opened.items[0]!;
    expect(item.label).toMatch(/^헬멧 . 사이즈 · 4개$/);
    let params = withItem({ orderId: 'o35' }, opened, item.key);
    expect(params).toEqual({ orderId: 'o35', lineId: item.lineId, from: item.from, planned: false });
    params = withQuantity(params, opened, 2);
    const two = await client.query('exchangeSheet', params);
    expect(two.quantity?.input.value).toBe(2);
    expect(two.primary).toMatchObject({ label: '즉시 교환 · 헬멧 2개', enabled: false });
    const to = two.sizes.find((s) => !s.selected)!.key;
    params = withSize(params, two, to);
    expect(params.quantity).toBe(2);
    const view = await client.query('exchangeSheet', params);
    expect(view.primary.enabled).toBe(true);
    expect(view.summary.map((r) => r.text).join('')).toMatch(/ → .* 사이즈 · 2개 · 금액 유지$/);
    const o = () => state().orders.find((x) => x.id === 'o35')!;
    const money = [charged(o()), paidTotal(o())];
    expect((await confirm(client, opened, view)).outcome).toBe('applied');
    expect([charged(o()), paidTotal(o())]).toEqual(money);
    const slip = await client.query('orderSlip', { orderId: 'o35' });
    expect(slip.lines.find((l) => l.id === item.lineId)?.label).toBe('헬멧 ' + to + ' 사이즈 2 · ' + item.from + ' 사이즈 2');
    expect(slip.adjustments?.map((a) => a.parts.map((p) => p.text).join(' · '))).toEqual(['즉시 교환 · 헬멧 ' + item.from + ' 사이즈 → ' + to + ' 사이즈 · 2개 · 15:40']);
  });

  it('옆 동작 `즉시 교환`: 사이즈 줄이 있는 팀만(스키만 있는 팀은 없음), 카운터 권한에 exchange.manage', async () => {
    const { client } = demo({ viewer: 'counter' });
    const config = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
    const slipView = resolveLedgerView(config.ledgerViews, 'order_slip', 'pos')!;
    expect(DEMO_COUNTER_PERMISSIONS).toContain('exchange.manage');
    const sized = await client.query('orderSlip', { orderId: 'o21' });
    expect(availableActions(slipView.actions, sized.activeConditions, sized.deniedPermissions ?? []).map((a) => a.action_key)).toContain('exchange_swap');
    const without = await client.query('orderSlip', { orderId: 'o34' });
    expect(availableActions(slipView.actions, without.activeConditions, without.deniedPermissions ?? []).map((a) => a.action_key)).not.toContain('exchange_swap');
    // 교환 요청(exchange, 준비 중인 화면)은 접수증 옆 동작에서 빠졌다(rev 6).
    expect(slipView.actions.map((a) => a.action_key)).not.toContain('exchange');
  });

  it('교환할 것이 없는 접수(스키만): 한 줄 `교환 불가 · 교환 대상 없음`, 주 버튼 막힘', async () => {
    const { client } = demo();
    const view = await client.query('exchangeSheet', { orderId: 'o34' });
    expect(view).toMatchObject({ items: [], sizes: [], notice: '교환 불가 · 교환 대상 없음', primary: { enabled: false } });
    expect(view.command).toBeUndefined();
  });
});

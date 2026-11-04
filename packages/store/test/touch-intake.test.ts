// 터치 접수: 대표자 이름 검증, 픽업 표시 저장, 요청 재전송을 실제 저장 매핑으로 확인한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createdOrder, defaultUiConfig, type OrderDraftInput } from '@skinote/contract';
import { checkoutPlan, runQuery } from '@skinote/domain';
import { COUNTER, envelope, provisioned, rowCounts, T0 } from './helpers.ts';

const draft: OrderDraftInput = {
  channel: 'walk_in', leader: { name: '시험손님', phone: '', party: 0 }, customerPickup: true,
  items: [{ productKey: 'ski', quantity: 2 }],
  pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' },
};

test('대표자 필수: 픽업 표시 저장, 같은 요청 재전송은 한 팀, 다음 접수는 다른 접수번호', () => {
  const { db, store, reopen } = provisioned();
  try {
    const before = store.state(T0);
    const unnamed = { ...draft, leader: { ...draft.leader, name: '' } };
    const blocked = checkoutPlan(before, T0, unnamed, [], null);
    assert.equal(blocked.itemsReady, false);
    assert.equal(store.command(envelope('order.create', { draft: unnamed, choices: [], payerOrderId: null }, before, { expect: { quoteHash: blocked.hash } }), COUNTER, T0).outcome, 'rejected');
    const plan = checkoutPlan(before, T0, draft, [], null);
    assert.equal(plan.itemsReady, true);
    const request = envelope('order.create', { draft, choices: [], payerOrderId: null }, before, { expect: { quoteHash: plan.hash } });
    const result = store.command(request, COUNTER, T0);
    assert.equal(result.outcome, 'applied', JSON.stringify(result.error));
    const created = createdOrder(result)!;
    assert.ok(created);
    const saved = reopen().state(T0);
    const team = saved.orders.find((o) => o.id === created.orderId)!;
    assert.equal(team.teamName, draft.leader.name);
    assert.equal(team.customerPickup, true);
    assert.equal(team.phone, '');
    assert.equal(team.party, 0);
    assert.equal(team.pickup.mode, 'store', '손님 픽업은 장비 배달 일정을 만들지 않는다');
    assert.equal(team.giveBack.mode, 'store');
    assert.equal(team.lines[0]!.issued, 0, '접수 확정은 장비 지급을 대신하지 않는다');
    const read = { config: defaultUiConfig({ shopName: saved.registry.shopName, timezone: 'Asia/Seoul' }), now: T0 };
    const slip = runQuery(saved, 'orderSlip', { orderId: team.id }, read);
    assert.equal(slip.fields.find((f) => f.key === 'customerPickup')?.value, '요청');
    const counts = rowCounts(db);
    assert.deepEqual(store.command(request, COUNTER, T0), result, '같은 요청에는 저장한 같은 결과를 반환한다');
    assert.deepEqual(rowCounts(db), counts);
    const secondDraft = { ...draft, customerPickup: false };
    const secondPlan = checkoutPlan(saved, T0, secondDraft, [], null);
    const second = store.command(envelope('order.create', { draft: secondDraft, choices: [], payerOrderId: null }, saved, { expect: { quoteHash: secondPlan.hash } }), COUNTER, T0);
    assert.equal(second.outcome, 'applied');
    const secondTeam = reopen().state(T0).orders.find((o) => o.id === createdOrder(second)!.orderId)!;
    assert.notEqual(secondTeam.receiptNo, team.receiptNo);
    assert.equal(secondTeam.customerPickup, undefined);
  } finally { db.close(); }
});

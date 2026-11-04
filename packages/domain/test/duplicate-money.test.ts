// 중복 수납 의심(sync 6, work/impl-offline/plan.md §5-7): 끊긴 휴대폰이 35,000원을 받아 두고, 기사가 같은 돈을 차량 태블릿에 다시 적고, 휴대폰이 늦게
// 보낸다. 팀의 미수는 120,000원이라 초과 수납은 아니지만 두 기기 모두에 `중복 수납 의심`이 남고, 두 돈은 모두 적힌다(차량 예상 현금에 둘 다).
import { describe, expect, it } from 'vitest';
import { findOrder, walletLeft } from '../src/index.ts';
import { assertMoney } from './money-check.ts';
import { at, first, online, queued } from './offline-helpers.ts';

describe('possible duplicate money', () => {
  it('a queued phone payment after the same amount on the van tablet: both recorded, one review per device', () => {
    const s = first();
    const collect = { type: 'field.collect' as const, payload: { taskId: 'collect:o28', orderId: 'o28', amount: 35_000, methodKey: 'cash' } };
    expect(online(s, collect, at(21, 10), { expect: { dueAmount: 120_000 } }, { actor: { deviceId: 'dev-tablet', name: '박기사' } }).outcome).toBe('applied');
    expect(queued(s, collect, at(21, 0), at(22, 0), {}, 'dev-phone').outcome).toBe('applied');
    const o = findOrder(s, 'o28')!;
    expect(o.payments.filter((p) => p.amount === 35_000).map((p) => p.deviceId)).toEqual(['dev-tablet', 'dev-phone']);
    const reviews = s.reviews!.filter((r) => r.kindKey === 'possible_duplicate_money');
    expect(reviews.map((r) => [r.targetDeviceId, r.message])).toEqual([
      ['dev-phone', '윤서준 팀 35,000원 · 10분 안 2건 · 중복 여부 확인'],
      ['dev-tablet', '윤서준 팀 35,000원 · 10분 안 2건 · 중복 여부 확인'],
    ]);
    expect(walletLeft(s, '2026-12-26', 'v1')).toBe(70_000);
    assertMoney(s);
  });

  it('a counter payment (no device) and a queued field payment of the same amount: the review goes to the phone and the manager list', () => {
    const s = first();
    expect(online(s, { type: 'payment.take', payload: { orderIds: ['o28'], amount: 20_000, methodKey: 'cash' } }, at(21, 20), { expect: { dueAmount: 120_000 } }).outcome).toBe('applied');
    queued(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 20_000, methodKey: 'cash' } }, at(21, 5), at(22, 0));
    const reviews = s.reviews!.filter((r) => r.kindKey === 'possible_duplicate_money');
    expect(reviews.map((r) => r.targetDeviceId ?? null)).toEqual(['dev-phone', null]);
  });

  it('different amounts or the same device: no review', () => {
    const s = first();
    queued(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 35_000, methodKey: 'cash' } }, at(21, 0), at(22, 0));
    queued(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 35_000, methodKey: 'cash' } }, at(21, 5), at(22, 0));
    queued(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 10_000, methodKey: 'cash' } }, at(21, 6), at(22, 0), {}, 'dev-tablet');
    expect(s.reviews!.some((r) => r.kindKey === 'possible_duplicate_money')).toBe(false);
  });
});

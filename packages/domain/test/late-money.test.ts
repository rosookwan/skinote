// 늦게 온 돈과 차량 지갑의 이월(work/impl-offline/plan.md §5-2 · R2 29): 22:50에 끊긴 채 받은 현금이 23:00 마감 뒤에 오면 영업일은 26일, 올림 날은
// 27일이다(26일의 얼린 마감에 들지 않고 27일 마감에 한 번 든다). 26일에 `점검 이월`한 차량 지갑은 27일 예상 현금에 이어진다.
import { describe, expect, it } from 'vitest';
import { findOrder, postingDate, runQuery, walletLeft, type ShopState } from '../src/index.ts';
import { assertMoney } from './money-check.ts';
import { at, closeDay, ctx, first, online, queued } from './offline-helpers.ts';

/** 27일로 넘긴 같은 상태(영업일만 바꿈: 마감 · 돈은 그대로). */
const nextDay = (s: ShopState): ShopState => ({ ...s, businessDate: '2026-12-27' });

describe('late recording', () => {
  it('the S6 22:50 cash arriving after the 23:00 closing posts to the 27th, once, with a late_money review', () => {
    const s = first();
    expect(closeDay(s, at(23, 0)).outcome).toBe('applied');
    const frozen = JSON.stringify(s.closings[0]!.sheet);
    const out = queued(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 35_000, methodKey: 'cash' } }, at(22, 50), at(23, 30));
    expect(out.outcome).toBe('applied');
    const pay = findOrder(s, 'o28')!.payments.at(-1)!;
    expect(pay).toMatchObject({ at: at(22, 50), recordedAt: at(23, 30) });
    expect(postingDate(s, pay.at, pay.recordedAt)).toBe('2026-12-27');
    // 마감한 날의 얼린 판은 그대로, 이 돈은 26일의 지갑에 들지 않는다.
    expect(JSON.stringify(s.closings[0]!.sheet)).toBe(frozen);
    expect(walletLeft(s, '2026-12-26', 'v1')).toBe(0);
    expect(walletLeft(s, '2026-12-27', 'v1')).toBe(35_000);
    expect(s.reviews!.filter((r) => r.kindKey === 'late_money').map((r) => r.message)).toEqual(['윤서준 팀 35,000원 · 마감일(12월 26일) 수납 · 12월 27일 마감 반영']);
    const sheet = runQuery(nextDay(s), 'closingSheet', {}, ctx(at(12, 0, 1)));
    expect(sheet.cash.find((r) => r.key === 'van:v1')?.expected).toEqual([{ text: '예상 35,000원' }]);
    assertMoney(nextDay(s));
  });

  it('cash recorded before the closing (even if made earlier) stays on its own day', () => {
    const s = first();
    queued(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 35_000, methodKey: 'cash' } }, at(22, 50), at(22, 55));
    expect(walletLeft(s, '2026-12-26', 'v1')).toBe(35_000);
    expect(s.reviews!.some((r) => r.kindKey === 'late_money')).toBe(false);
  });
});

describe('van wallet carry-over', () => {
  it('a wallet deferred on the 26th (50,000) plus the late 35,000 = 85,000 expected on the 27th', () => {
    const s = first();
    // 21:30 1호 차량이 온라인으로 50,000원을 받음 → 21:40부터 끊김.
    expect(online(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 50_000, methodKey: 'cash' } }, at(21, 30), { expect: { dueAmount: 120_000 } }).outcome).toBe('applied');
    // 23:00 관리자 승인으로 마감(1호 차량 지갑은 점검 이월).
    const links = [{ vehicleId: 'v1', state: 'offline' as const, reportedPending: null, since: new Date(at(21, 40)).toISOString() }];
    const override = { approvalId: 'A'.repeat(22), reason: '휴대폰 꺼짐', approvedBy: 'staff:staff-1' };
    const closed = closeDay(s, at(23, 0), { links, override, deferredTransferIds: ['van:v1'] });
    expect(closed.outcome, JSON.stringify(closed.error ?? null)).toBe('applied');
    expect(s.closings[0]).toMatchObject({ deferredTransferIds: ['van:v1'], overrideReason: '휴대폰 꺼짐' });
    queued(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 35_000, methodKey: 'cash' } }, at(22, 50), at(23, 30));
    const tomorrow = nextDay(s);
    expect(walletLeft(tomorrow, '2026-12-27', 'v1')).toBe(85_000);
    const sheet = runQuery(tomorrow, 'closingSheet', {}, ctx(at(12, 0, 1)));
    expect(sheet.cash.find((r) => r.key === 'van:v1')?.expected).toEqual([{ text: '예상 85,000원' }]);
    assertMoney(s);
    assertMoney(tomorrow);
  });

  it('confirming the carried wallet on the 27th counts it once and empties the wallet', () => {
    const s = first();
    online(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 50_000, methodKey: 'cash' } }, at(21, 30), { expect: { dueAmount: 120_000 } });
    const links = [{ vehicleId: 'v1', state: 'offline' as const, reportedPending: null }];
    expect(closeDay(s, at(23, 0), { links, override: { approvalId: 'A'.repeat(22), reason: '휴대폰 꺼짐', approvedBy: 'staff:staff-1' }, deferredTransferIds: ['van:v1'] }).outcome).toBe('applied');
    const tomorrow = nextDay(s);
    const check = runQuery(tomorrow, 'closingSheet', { check: { key: 'van:v1', countedAmount: 50_000 } }, ctx(at(12, 0, 1))).check!;
    expect(check.expect).toEqual({ expectedCash: { 'van:v1': 50_000 } });
    expect(online(tomorrow, check.command!, at(12, 0, 1), { expect: check.expect! }).outcome).toBe('applied');
    expect(walletLeft(tomorrow, '2026-12-27', 'v1')).toBe(0);
  });
});

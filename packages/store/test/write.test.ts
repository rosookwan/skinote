// 앞뒤 상태 → 행(write.ts): 접수 번호 셈은 뒤로 가지 않고, 표로 옮길 수 없는 바뀜(목록 값 · 적은 사실을 고침 · 사라진 접수)은 아무것도
// 쓰기 전에 UNMAPPED_CHANGE로 트랜잭션을 되돌린다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDay, type ShopState } from '@skinote/domain';
import { inWriteTransaction, isStoreError, loadShopState, nextReceiptSeq, raiseReceiptCounter, writeState } from '../src/index.ts';
import { COUNTER, countDiff, provisioned, rowCounts, T0 } from './helpers.ts';

test('the receipt counter keeps the last given number per business day and never goes back', () => {
  const { db } = provisioned();
  inWriteTransaction(db, () => raiseReceiptCounter(db, 'shop0test', '2026-12-26', 3));
  assert.equal(nextReceiptSeq(db, 'shop0test', '2026-12-26'), 4);
  inWriteTransaction(db, () => raiseReceiptCounter(db, 'shop0test', '2026-12-26', 2));
  assert.equal(nextReceiptSeq(db, 'shop0test', '2026-12-26'), 4, 'a lower value (stale state, restore skip) does not reissue printed numbers');
  inWriteTransaction(db, () => raiseReceiptCounter(db, 'shop0test', '2026-12-26', 7));
  assert.equal(loadShopState(db, 'shop0test', T0).nextReceiptSeq, 8);
  assert.equal(nextReceiptSeq(db, 'shop0test', '2026-12-27'), 1, 'another day starts at 001');
});

const ctxOf = (db: Parameters<typeof loadShopState>[0], before: ShopState, after: ShopState) => ({
  db, shopId: 'shop0test', now: T0, rev: 1, actor: { key: COUNTER.key, name: COUNTER.name }, requestId: 'rq-1', before, after, touched: [],
});

test('a change the tables cannot hold refuses the whole write before anything is kept', () => {
  const { db, store } = provisioned();
  const empty = store.state(T0);
  const day = sampleDay({ date: '2026-12-26', epoch: empty.epoch, ids: 'demo' });
  store.importDay({ date: '2026-12-26', orders: day.orders, pins: day.pins, deposits: [], paymentGroups: [] }, 'import:sample:2026-12-26', T0, COUNTER);
  const before = store.state(T0);
  const counts = rowCounts(db);
  const cases: [string, (s: ShopState) => void][] = [
    ['a registry value', (s) => { (s.registry as { shopName: string }).shopName = '다른 이름'; }],
    ['a written payment', (s) => { s.orders[0]!.payments[0]!.amount += 1; }],
    ['a frozen line value', (s) => { s.orders[0]!.lines[0]!.amount += 1; }],
    ['a removed order', (s) => { s.orders.pop(); }],
    ['a team name', (s) => { s.orders[0]!.teamName = '고친 이름'; }],
    ['an issued count going down', (s) => { const l = s.orders[0]!.lines[0]!; l.issued -= 1; l.assetIds = l.assetIds?.slice(0, -1); }],
  ];
  for (const [name, change] of cases) {
    const after = structuredClone(before);
    change(after);
    assert.throws(() => inWriteTransaction(db, () => writeState(ctxOf(db, before, after))), (e: unknown) => isStoreError(e, 'UNMAPPED_CHANGE'), name);
    assert.deepEqual(countDiff(counts, rowCounts(db)), {}, name + ': nothing kept');
  }
});

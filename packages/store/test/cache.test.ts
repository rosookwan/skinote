// 상태 캐시(plan §4-4): (rev, 영업일)이 같으면 다시 읽지 않고, 다른 연결이 rev를 올리거나 영업일 기준 시각을 지나면 다시 읽는다.
// 적용한 명령 뒤에는 새 상태가 캐시가 된다(다시 읽지 않음). 오류 뒤에는 캐시를 버린다.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ruleKeys } from '@skinote/domain';
import { openDatabase } from '@skinote/schema';
import { openShopStore, run } from '../src/index.ts';
import { COUNTER, envelope, MINUTE, provisioned, T0, tempDir } from './helpers.ts';

const temp = tempDir();
after(() => temp.cleanup());

test('the cached state is reused while rev and business day stay; another connection bumping rev forces a reload', () => {
  const file = temp.dir + '/shop-cache.sqlite';
  const { store, db } = provisioned(file);
  const first = store.state(T0);
  assert.equal(store.state(T0 + MINUTE), first, 'same rev, same day: the same object');
  const other = openDatabase(file);
  try {
    run(other, "UPDATE shop_counters SET value = value + 1 WHERE counter_key = 'rev'");
    const reloaded = store.state(T0 + 2 * MINUTE);
    assert.notEqual(reloaded, first, 'an external rev bump reloads');
    assert.equal(reloaded.rev, 1);
    assert.equal(store.state(T0 + 3 * MINUTE), reloaded);
  } finally {
    other.close();
    db.close();
  }
});

test('crossing the business-day cutoff (06:00) reloads with the new business date', () => {
  const { store } = provisioned();
  const evening = store.state(T0 + 12 * 60 * MINUTE);
  assert.equal(evening.businessDate, '2026-12-26');
  assert.equal(store.state(T0 + 20 * 60 * MINUTE + 59 * MINUTE), evening, '05:59 the next morning is still the 26th');
  const morning = store.state(T0 + 21 * 60 * MINUTE);
  assert.notEqual(morning, evening);
  assert.equal(morning.businessDate, '2026-12-27');
});

test('after an applied command the new state is the cache (no reload); after a failure the cache is dropped', () => {
  let fail = false;
  const { db, options } = provisioned();
  const store = openShopStore(db, 'shop0test', { ...options, fault: (phase) => { if (fail && phase === 'commit') throw new Error('boom'); } });
  const s = store.state(T0);
  const keys = ruleKeys(s.registry, s.settings);
  const out = store.command(envelope('setting.set', { changes: [{ key: keys.refund, value: 'no_refund' }] }, { epoch: s.epoch, rev: 0 }), COUNTER, T0 + MINUTE);
  assert.equal(out.outcome, 'applied');
  const cached = store.state(T0 + MINUTE);
  assert.equal(cached.rev, 1);
  assert.equal(cached.settings.sameDayCancelRefund, 'no_refund');
  assert.equal(store.state(T0 + 2 * MINUTE), cached, 'the committed state was kept');
  fail = true;
  const crashed = store.command(envelope('setting.set', { changes: [{ key: keys.refund, value: 'refund' }] }, { epoch: s.epoch, rev: 1 }), COUNTER, T0 + 3 * MINUTE);
  assert.equal(crashed.error?.code, 'INTERNAL');
  const fresh = store.state(T0 + 4 * MINUTE);
  assert.notEqual(fresh, cached, 'dropped after the failure');
  assert.equal(fresh.settings.sameDayCancelRefund, 'no_refund', 'the failed change is not there');
});

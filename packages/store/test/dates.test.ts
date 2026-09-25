// 영업일 · 기록일 · 열린 날(plan §4-2, data-model 3-3): 기준 시각은 표(shops · config_changes)에서, 영업일 셈은 도메인이 한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kstAt } from '@skinote/domain';
import { businessDateAt, cutoffHistory, ensureBusinessDay, insert, isClosed, num, one, openDays, postingDateFor, run } from '../src/index.ts';
import { provisioned, T0 } from './helpers.ts';

const SHOP = 'shop0test';

test('business date follows the shop cutoff: 05:59 is the day before, 06:00 the day itself', () => {
  const { db } = provisioned();
  assert.equal(businessDateAt(db, SHOP, kstAt('2026-12-27', 0, 5, 59)), '2026-12-26');
  assert.equal(businessDateAt(db, SHOP, kstAt('2026-12-27', 0, 6, 0)), '2026-12-27');
  assert.deepEqual(cutoffHistory(db, SHOP), { current: '06:00', before: [] });
});

test('a changed cutoff keeps older records on the old rule (config_changes history)', () => {
  const { db } = provisioned();
  const changedAt = kstAt('2026-12-27', 0, 12, 0);
  run(db, "UPDATE shops SET business_day_cutoff = '04:00'");
  insert(db, 'config_changes', {
    shop_id: SHOP, config_rev: 1, seq: 1, entity_type: 'shops', entity_id: SHOP, before_json: '{"business_day_cutoff":"06:00"}', after_json: '{"business_day_cutoff":"04:00"}',
    actor_key: 'staff:x', at: new Date(changedAt).toISOString(),
  });
  assert.deepEqual(cutoffHistory(db, SHOP), { current: '04:00', before: [{ until: changedAt, cutoff: '06:00' }] });
  assert.equal(businessDateAt(db, SHOP, kstAt('2026-12-27', 0, 5, 0)), '2026-12-26', 'before the change: 06:00 rule');
  assert.equal(businessDateAt(db, SHOP, kstAt('2026-12-28', 0, 5, 0)), '2026-12-28', 'after the change: 04:00 rule');
});

test('posting date: a closed day posts to the next open day; open days list the unclosed days up to today', () => {
  const { db } = provisioned();
  const at = new Date(T0).toISOString();
  ensureBusinessDay(db, SHOP, '2026-12-26', at);
  ensureBusinessDay(db, SHOP, '2026-12-26', at);
  assert.equal(num(one(db, "SELECT count(*) AS n FROM business_days WHERE business_date = '2026-12-26'")?.n), 1, 'idempotent');
  assert.equal(isClosed(db, SHOP, '2026-12-26'), false);
  assert.equal(postingDateFor(db, SHOP, '2026-12-26'), '2026-12-26');
  assert.deepEqual(openDays(db, SHOP, '2026-12-27'), ['2026-12-26', '2026-12-27']);
  // 26일 마감(시험용 최소 행: 마감 행과 영업일의 active_closing_id)
  insert(db, 'closings', {
    shop_id: SHOP, id: 'closing:2026-12-26:1', closing_scope_id: 'main', business_date: '2026-12-26', version_no: 1, as_of_rev: 0, closed_at: at,
    opening_cash_amount: 0, expected_cash_amount: 0, counted_cash_amount: 0, difference_amount: 0, report_json: '{}', report_schema: 1, basis_json: '{}',
    actor_key: 'staff:x', actor_name: '한가람', request_id: 'rq-close', created_rev: 0,
  });
  run(db, "UPDATE business_days SET active_closing_id = 'closing:2026-12-26:1', last_version_no = 1 WHERE business_date = '2026-12-26'");
  assert.equal(isClosed(db, SHOP, '2026-12-26'), true);
  assert.equal(postingDateFor(db, SHOP, '2026-12-26'), '2026-12-27');
  assert.deepEqual(openDays(db, SHOP, '2026-12-27'), ['2026-12-27']);
});

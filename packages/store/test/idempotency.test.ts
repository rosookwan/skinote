// 명령 기록의 멱등(plan §4-5 3 · 9, §4-8): 같은 요청번호는 한 번만 적용된다. 같은 본문이면 저장한 결과, 다른 본문이면 첫 결과 +
// idempotencyMismatch + integrity_findings. 처리 중 오류(INTERNAL)와 멈춤(blocked)은 다시 보내면 처음부터 다시 판단한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execute, ruleKeys } from '@skinote/domain';
import { isStoreError, num, one, openShopStore, str, type FaultPhase, type Row } from '../src/index.ts';
import { COUNTER, countDiff, envelope, MINUTE, provisioned, rowCounts, T0 } from './helpers.ts';

const refundOff = (keys: ReturnType<typeof ruleKeys>) => [{ key: keys.refund, value: 'no_refund' as const }];

test('the same request id twice returns the stored result and changes no row', () => {
  const { store, db } = provisioned();
  const s = store.state(T0);
  const env = envelope('setting.set', { changes: refundOff(ruleKeys(s.registry, s.settings)) }, { epoch: s.epoch, rev: 0 });
  const first = store.command(env, COUNTER, T0 + MINUTE);
  assert.equal(first.outcome, 'applied');
  const counts = rowCounts(db);
  const again = store.command(env, COUNTER, T0 + 5 * MINUTE);
  assert.deepEqual(again, first);
  assert.deepEqual(countDiff(counts, rowCounts(db)), {});
  assert.equal(store.head(T0).rev, 1);
  // 다른 사람이 같은 요청번호를 보내도(권한 확인은 멱등 뒤) 저장한 결과다
  const guarded = store.command(env, { key: 'staff:driver', name: '문태오' }, T0 + 6 * MINUTE, () => ({ ...first, outcome: 'rejected', error: { code: 'FORBIDDEN', message: '권한 없음 · 관리자 확인 필요' } }));
  assert.deepEqual(guarded, first);
});

test('the same request id with another body: the first result + idempotencyMismatch and one integrity_findings row', () => {
  const { store, db } = provisioned();
  const s = store.state(T0);
  const keys = ruleKeys(s.registry, s.settings);
  const env = envelope('setting.set', { changes: refundOff(keys) }, { epoch: s.epoch, rev: 0 });
  const first = store.command(env, COUNTER, T0 + MINUTE);
  const other = { ...env, payload: { changes: [{ key: keys.prepay, value: 'none' }] } } as typeof env;
  const out = store.command(other, COUNTER, T0 + 2 * MINUTE);
  assert.equal(out.idempotencyMismatch, true);
  assert.deepEqual({ ...out, idempotencyMismatch: undefined }, { ...first, idempotencyMismatch: undefined });
  assert.equal(num(one(db, "SELECT count(*) AS n FROM integrity_findings WHERE check_key = 'idempotency_mismatch'")?.n), 1);
  assert.equal(store.head(T0).rev, 1, 'the other body was not applied');
});

for (const phase of ['load', 'execute', 'write', 'journal', 'commit'] as FaultPhase[]) {
  test(`a crash in the ${phase} phase: rejected INTERNAL (retryable), nothing written; the same id again applies once`, () => {
    let armed = true;
    const { db, options } = provisioned(':memory:');
    const store = openShopStore(db, 'shop0test', { ...options, fault: (at) => {
      if (armed && at === phase) {
        armed = false;
        throw new Error('fault ' + at);
      }
    } });
    const s = store.state(T0);
    const env = envelope('setting.set', { changes: refundOff(ruleKeys(s.registry, s.settings)) }, { epoch: s.epoch, rev: 0 });
    const counts = rowCounts(db);
    const crashed = store.command(env, COUNTER, T0 + MINUTE);
    assert.equal(crashed.outcome, 'rejected');
    assert.equal(crashed.error?.code, 'INTERNAL');
    assert.deepEqual(Object.keys(countDiff(counts, rowCounts(db))), ['command_log']);
    assert.deepEqual({ ...one<Row>(db, 'SELECT status_key, retryable, error_code FROM command_log') }, { status_key: 'rejected', retryable: 1, error_code: 'INTERNAL' });
    assert.equal(store.head(T0).rev, 0);
    const received = str(one(db, 'SELECT received_at FROM command_log')?.received_at);

    const retried = store.command(env, COUNTER, T0 + 3 * MINUTE);
    assert.equal(retried.outcome, 'applied');
    assert.equal(retried.rev, 1, 'the rev went up by exactly 1');
    assert.equal(num(one(db, 'SELECT count(*) AS n FROM events WHERE request_id = ?', env.requestId)?.n), 1, 'exactly one journal row');
    const log = one(db, 'SELECT status_key, retryable, error_code, applied_rev, received_at FROM command_log');
    assert.deepEqual({ ...log }, { status_key: 'applied', retryable: 0, error_code: null, applied_rev: 1, received_at: received }, 'the row is updated, received_at kept');
    assert.equal(store.state(T0 + 3 * MINUTE).settings.sameDayCancelRefund, 'no_refund');
  });
}

test('a blocked command (its dependency not applied yet) is judged again when sent again after the dependency applied', () => {
  // 충돌 키는 따로 본다(같은 바탕의 둘째 운영 규칙 저장은 충돌이다): 여기서는 멈춤 · 다시 판단만.
  const { store } = provisioned(':memory:', { conflictKeys: null });
  const s = store.state(T0);
  const keys = ruleKeys(s.registry, s.settings);
  const dep = envelope('setting.set', { changes: refundOff(keys) }, { epoch: s.epoch, rev: 0 });
  const later = envelope('setting.set', { changes: [{ key: keys.prepay, value: 'none' }] }, { epoch: s.epoch, rev: 0 }, { dependsOn: [dep.requestId] });
  const blocked = store.command(later, COUNTER, T0 + MINUTE);
  assert.equal(blocked.outcome, 'blocked');
  assert.equal(blocked.error?.code, 'DEPENDENCY_NOT_APPLIED');
  assert.equal(store.command(dep, COUNTER, T0 + 2 * MINUTE).outcome, 'applied');
  const again = store.command(later, COUNTER, T0 + 3 * MINUTE);
  assert.equal(again.outcome, 'applied');
  assert.equal(again.rev, 2);
  assert.equal(store.state(T0 + 3 * MINUTE).settings.prepaymentMode, 'none');
});

test('a guard refusal is a final rejected row: the resend gets the same refusal, nothing applied', () => {
  const { store, db } = provisioned();
  const s = store.state(T0);
  const env = envelope('setting.set', { changes: refundOff(ruleKeys(s.registry, s.settings)) }, { epoch: s.epoch, rev: 0 });
  let scopeSeen: unknown;
  const refused = store.command(env, { key: 'staff:driver', name: '문태오', vehicleId: 'v1', roleKey: 'driver' }, T0 + MINUTE, (scope) => {
    scopeSeen = scope;
    return { outcome: 'rejected', requestId: env.requestId, rev: 0, asOfRev: 0, epoch: s.epoch, rebased: false, changes: [], error: { code: 'FORBIDDEN', message: '권한 없음 · 관리자 확인 필요' } };
  });
  assert.deepEqual(scopeSeen, { kind: 'shop' }, 'setting.set is a shop-wide command (domain commandScope)');
  assert.equal(refused.outcome, 'rejected');
  assert.equal(refused.error?.code, 'FORBIDDEN');
  assert.deepEqual({ ...one<Row>(db, 'SELECT status_key, retryable, error_code FROM command_log') }, { status_key: 'rejected', retryable: 0, error_code: 'FORBIDDEN' });
  const resent = store.command(env, COUNTER, T0 + 2 * MINUTE);
  assert.deepEqual(resent, refused);
  assert.equal(store.head(T0).rev, 0);
});

test('an intent command whose conflict keys were touched after its basis gets VERSION_CONFLICT', () => {
  const { db, options } = provisioned();
  const store = openShopStore(db, 'shop0test', options);
  const s = store.state(T0);
  const keys = ruleKeys(s.registry, s.settings);
  const a = envelope('setting.set', { changes: refundOff(keys) }, { epoch: s.epoch, rev: 0 });
  assert.equal(store.command(a, COUNTER, T0 + MINUTE).outcome, 'applied');
  assert.equal(num(one(db, "SELECT rev FROM intent_marks WHERE conflict_key = 'registry:shop_rules'")?.rev), 1, 'the domain conflict key of setting.set');
  // 같은 바탕(rev 0)에서 연 두 번째 창: 그사이 rev 1이 같은 key를 건드렸다
  const b = envelope('setting.set', { changes: [{ key: keys.prepay, value: 'none' }] }, { epoch: s.epoch, rev: 0 });
  const out = store.command(b, COUNTER, T0 + 2 * MINUTE);
  assert.equal(out.outcome, 'conflict');
  assert.equal(out.error?.code, 'VERSION_CONFLICT');
  // 새 바탕으로 다시 연 창은 된다
  const c = envelope('setting.set', { changes: [{ key: keys.prepay, value: 'none' }] }, { epoch: s.epoch, rev: 1 });
  assert.equal(store.command(c, COUNTER, T0 + 3 * MINUTE).outcome, 'applied');
});

test('a throw after COMMIT (notify · log) keeps the applied result: command_log stays applied and a resend returns it', () => {
  let armed = true;
  const logs: string[] = [];
  const { db, options } = provisioned(':memory:');
  const store = openShopStore(db, 'shop0test', { ...options, log: (line) => logs.push(line), fault: (at) => {
    if (armed && at === 'after_commit') {
      armed = false;
      throw new Error('fault after commit');
    }
  } });
  const s = store.state(T0);
  const env = envelope('setting.set', { changes: refundOff(ruleKeys(s.registry, s.settings)) }, { epoch: s.epoch, rev: 0 });
  const first = store.command(env, COUNTER, T0 + MINUTE);
  assert.equal(first.outcome, 'applied', 'the caller hears the applied result');
  assert.deepEqual({ ...one<Row>(db, 'SELECT status_key, retryable, error_code, applied_rev FROM command_log') }, { status_key: 'applied', retryable: 0, error_code: null, applied_rev: 1 });
  assert.equal(num(one(db, 'SELECT count(*) AS n FROM events')?.n), 1);
  assert.ok(logs.some((l) => l.startsWith('after commit failed')), 'the failure is logged');
  const again = store.command(env, COUNTER, T0 + 2 * MINUTE);
  assert.deepEqual(again, first, 'a resend returns the stored applied result');
  assert.equal(store.head(T0).rev, 1);
});

test('the file must hold the shop the store was opened for (SHOP_MISMATCH), and a transaction inside a command is refused (REENTRANT)', () => {
  const { db, options, store } = provisioned();
  const s = store.state(T0);
  const env = envelope('setting.set', { changes: refundOff(ruleKeys(s.registry, s.settings)) }, { epoch: s.epoch, rev: 0 });
  const other = openShopStore(db, 'shop9other', options);
  assert.throws(() => other.command(env, COUNTER, T0), (e: unknown) => isStoreError(e, 'SHOP_MISMATCH'));
  let inner: unknown;
  const nested = openShopStore(db, 'shop0test', { ...options, execute: (state, e, ctx) => {
    try {
      nested.state(T0);
    } catch (error) {
      inner = error;
    }
    return execute(state, e, ctx);
  } });
  assert.equal(nested.command(env, COUNTER, T0 + MINUTE).outcome, 'applied');
  assert.ok(isStoreError(inner, 'REENTRANT'));
});

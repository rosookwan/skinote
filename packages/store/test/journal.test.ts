// 작업 기록(plan §4-5 7 · §4-8 Journal): 적용한 명령마다 events 한 줄과 rev + 1, 해시 사슬, 이름 · 전화 · 자유 글은 기록 줄이 아니라
// event_pii에(기록 줄에는 참조와 약속 해시만), 바뀐 행은 change_log에. 지문은 매장마다의 비밀 열쇠로 만든 HMAC이라 매장이 다르면 다르다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ruleKeys } from '@skinote/domain';
import {
  all, appendEvent, eventHash, fingerprintOf, inWriteTransaction, num, one, shopFingerprintKey, splitPii, str, text, verifyChain,
} from '../src/index.ts';
import { COUNTER, envelope, MINUTE, provisioned, secrets, T0 } from './helpers.ts';

test('splitPii replaces names, phones and free text by references and keeps them apart', () => {
  const payload = {
    draft: { channel: 'walk_in', leader: { name: '김민수', phone: '01000001234', party: 2 }, items: [{ productKey: 'ski', quantity: 1 }] },
    drawerCounts: [{ drawerId: 'counter', countedAmount: 1000, reasonKey: 'manual', reasonNote: '잔돈 교환' }],
    note: '조기 반납',
  };
  const { clean, pii } = splitPii(payload, 'payload');
  const text_ = JSON.stringify(clean);
  assert.doesNotMatch(text_, /김민수|01000001234|잔돈 교환|조기 반납/);
  assert.match(text_, /"reasonKey":"manual"/, 'code keys stay');
  assert.deepEqual(pii, {
    'payload.draft.leader.name': '김민수', 'payload.draft.leader.phone': '01000001234', 'payload.drawerCounts[0].reasonNote': '잔돈 교환', 'payload.note': '조기 반납',
  });
});

test('the fingerprint ignores names only through their references, and differs per shop key', () => {
  const key = shopFingerprintKey(secrets().fingerprintKey, 'shop0test');
  const a = { type: 'task.pin', commandVersion: 1, payload: { taskId: 't1', note: '조기 반납' } } as const;
  const b = { type: 'task.pin', commandVersion: 1, payload: { taskId: 't1', note: '다른 메모' } } as const;
  const c = { type: 'task.pin', commandVersion: 1, payload: { taskId: 't2', note: '조기 반납' } } as const;
  assert.match(fingerprintOf(key, a as never), /^[0-9a-f]{64}$/);
  assert.equal(fingerprintOf(key, a as never), fingerprintOf(key, b as never), 'free text is a reference: a resend with a corrected note is the same command');
  assert.notEqual(fingerprintOf(key, a as never), fingerprintOf(key, c as never));
  const bare = createHash('sha256').update(JSON.stringify(a)).digest('hex');
  assert.notEqual(fingerprintOf(key, a as never), bare, 'not a bare sha256');
  assert.notEqual(fingerprintOf(shopFingerprintKey(secrets().fingerprintKey, 'shop0test'), a as never), fingerprintOf(key, a as never), 'another secret, another fingerprint');
  assert.notEqual(fingerprintOf(shopFingerprintKey(new Uint8Array(32), 'shop1'), a as never), fingerprintOf(shopFingerprintKey(new Uint8Array(32), 'shop2'), a as never), 'per shop');
});

test('every applied command adds exactly one events row and one rev; the chain verifies; change_log names the touched rows', () => {
  const { store, db } = provisioned();
  const s = store.state(T0);
  const keys = ruleKeys(s.registry, s.settings);
  const values = [['no_refund', 'refund', 'no_refund'], ['fixed_amount', 'none']] as const;
  let rev = 0;
  for (const v of values[0]) {
    const out = store.command(envelope('setting.set', { changes: [{ key: keys.refund, value: v }] }, { epoch: s.epoch, rev }), COUNTER, T0 + (rev + 1) * MINUTE);
    assert.equal(out.outcome, 'applied');
    rev += 1;
    assert.equal(num(one(db, 'SELECT count(*) AS n FROM events')?.n), rev);
    assert.equal(store.head(T0).rev, rev);
  }
  const events = all(db, 'SELECT rev, request_id, command_type, engine_key, aggregate_type, aggregate_id, prev_hash, hash, business_date, actor_key, actor_name FROM events ORDER BY rev');
  assert.deepEqual(events.map((e) => num(e.rev)), [1, 2, 3]);
  assert.equal(str(events[0]!.prev_hash), '');
  assert.equal(str(events[1]!.prev_hash), str(events[0]!.hash));
  assert.deepEqual({ type: events[0]!.command_type, engine: events[0]!.engine_key, agg: events[0]!.aggregate_type, id: events[0]!.aggregate_id, day: events[0]!.business_date },
    { type: 'setting.set', engine: 'native', agg: 'shop', id: 'shop0test', day: '2026-12-26' });
  assert.equal(str(events[0]!.actor_key), COUNTER.key);
  assert.deepEqual(verifyChain(db, 'shop0test'), { rows: 3, brokenAt: null });
  const changes = all(db, 'SELECT rev, seq, scope_key, entity_type, entity_id FROM change_log ORDER BY rev, seq').map((r) => ({ ...r }));
  assert.deepEqual(changes, [1, 2, 3].map((r) => ({ rev: r, seq: 1, scope_key: 'store', entity_type: 'shops', entity_id: 'shop0test' })));
  // command_log: 적용 rev · 바탕 · 결과(90일 보관)
  const log = one(db, 'SELECT applied_rev, basis_rev, basis_epoch_id, result_json, result_expires_at, time_source_key FROM command_log WHERE applied_rev = 2');
  assert.equal(num(log?.basis_rev), 1);
  assert.equal(str(log?.basis_epoch_id), s.epoch);
  assert.equal(JSON.parse(str(log?.result_json)).rev, 2);
  assert.equal(str(log?.result_expires_at).slice(0, 10), '2027-03-26');
  assert.equal(str(log?.time_source_key), 'server');
});

test('a journal row keeps names and phones out of command_json: event_pii holds them, the chain commits to them by hash', () => {
  const { db } = provisioned();
  const { clean, pii } = splitPii({ type: 'task.pin', payload: { taskId: 'deliver:o21', note: '김민수 010-0000-0021 조기 반납' } });
  const at = T0 + MINUTE;
  inWriteTransaction(db, () => appendEvent(db, 'shop0test', {
    rev: 1, epoch: 'e', requestId: '01TESTREQUEST0000000000001', actorKey: COUNTER.key, actorName: COUNTER.name, type: 'task.pin', commandVersion: 1, engine: 'native',
    command: clean, result: { outcome: 'applied' }, pii, now: at, businessDate: '2026-12-26',
  }));
  const row = one(db, 'SELECT command_json, pii_commitment, hash, prev_hash, recorded_at, result_json FROM events WHERE rev = 1');
  assert.doesNotMatch(str(row?.command_json), /김민수|010-/);
  const piiRow = one(db, 'SELECT salt, pii_json, purge_after FROM event_pii WHERE rev = 1');
  assert.match(str(piiRow?.pii_json), /김민수/);
  assert.equal(str(row?.pii_commitment), createHash('sha256').update(str(piiRow?.salt) + str(piiRow?.pii_json), 'utf8').digest('hex'));
  assert.equal(str(piiRow?.purge_after).slice(0, 10), '2027-01-25', '30 days');
  const recomputed = eventHash('', {
    rev: 1, request_id: '01TESTREQUEST0000000000001', actor_key: COUNTER.key, command_type: 'task.pin', command_json: str(row?.command_json),
    result_json: text(row?.result_json) ?? null, pii_commitment: str(row?.pii_commitment), recorded_at: str(row?.recorded_at),
  });
  assert.equal(str(row?.hash), recomputed);
  // 한 칸만 달라도 해시가 다르다(사슬이 줄을 덮는다)
  assert.notEqual(eventHash('', { rev: 1, request_id: '01TESTREQUEST0000000000001', actor_key: COUNTER.key, command_type: 'task.pin', command_json: str(row?.command_json), result_json: '{}', pii_commitment: str(row?.pii_commitment), recorded_at: str(row?.recorded_at) }), recomputed);
  // 장부 트리거: 작업 기록은 고치지 못한다
  assert.throws(() => db.exec("UPDATE events SET command_json = '{}' WHERE rev = 1"), /APPEND_ONLY|events/);
});

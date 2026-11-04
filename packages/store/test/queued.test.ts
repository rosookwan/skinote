// 보냄 대기 명령의 저장소 길(work/impl-offline/plan.md §6-1): 쌍둥이(메모리 execute with recordedAt ↔ ShopStore.commandQueued)로 되읽기가 같고,
// command_log에 기기 번호 · 서명 · 시각의 출처 · 일어난 때 · 받은 때가 적히고, 같은 요청번호는 첫 결과(새 번호로 와도), 같은 번호의 다른 요청은 SEQ_REUSED,
// 보류 행은 봉투를 먼 끝까지 두고, 범위 밖은 적용 + `공급자 확인 중`, 한 항목의 처리 오류가 다음 항목에 닿지 않고, 늦은 돈의 기록일이 다음 열린 날이고,
// 번호 빈 곳 · 이어진 끝 · 기록 범위가 맞다. 공유 벡터(test/vectors)의 해시도 node:crypto로 같다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalJson as contractCanonical, unsignedItem, type AnyCommandEnvelope, type CommandOutcome } from '@skinote/contract';
import { execute, kstAt, postingDate, PRODUCTION_LINES, sampleDay, type ShopState } from '@skinote/domain';
import { all, canonicalJson, HELD_EXPIRES_AT, logPiiAccess, num, one, str, type Actor, type QueuedMeta } from '../src/index.ts';
import { COUNTER, envelope, provisioned, rowCounts, countDiff, T0 } from './helpers.ts';

const DATE = '2026-12-26';
const at = (h: number, m: number, day = 0) => kstAt(DATE, day, h, m);
const comparable = (s: ShopState) => canonicalJson({ ...s, outcomes: {}, storyApplied: [], driverDevice: { offline: false, queue: [] } });

/** 옛 저장소 canonicalJson(되읽기 비교에서 새 함수와 같은 글인지). */
function oldCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : oldCanonical(v))).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + oldCanonical(v)).join(',') + '}';
}

interface Twin {
  t: ReturnType<typeof provisioned>;
  memory: ShopState;
  phone: string;
  driver: Actor;
  sendOnline(env: AnyCommandEnvelope, now: number, actor?: Actor): CommandOutcome;
  sendQueued(env: AnyCommandEnvelope, meta: Partial<QueuedMeta> & { occurredAt: number; receivedAt: number }): ReturnType<ReturnType<typeof provisioned>['store']['commandQueued']>;
  check(now: number, name: string): void;
}

function twin(): Twin {
  const t = provisioned();
  const empty = t.store.state(T0);
  const day = sampleDay({ date: DATE, epoch: empty.epoch, ids: 'demo' });
  const imported = t.store.importDay({ date: DATE, orders: day.orders, pins: day.pins, deposits: day.deposits, paymentGroups: day.paymentGroups, reviews: day.reviews ?? [] }, 'import:sample:' + DATE, T0, COUNTER);
  let memory: ShopState = {
    ...structuredClone(empty), orders: day.orders.map((o) => ({ ...o, lines: o.lines.map((l) => ({ ...l, productKey: l.productKey ?? l.kind })) })), pins: day.pins,
    rev: imported.rev, nextReceiptSeq: day.nextReceiptSeq, reviews: day.reviews ?? [],
  };
  const code = t.store.devices.createCode({ codeHash: 'b'.repeat(64), kind: 'driver_phone', label: '1호 차량 휴대폰', vehicleId: 'v1', expiresAt: at(23, 0), now: T0 });
  const phone = t.store.devices.enroll({ codeId: code.id, publicKey: '{}', now: T0 + 1 }).id;
  const driver: Actor = { key: 'staff:test-driver', name: '문태오', roleKey: 'driver', deviceId: phone, vehicleId: 'v1' };
  const outcomes = new Map<string, CommandOutcome['outcome']>();
  const advance = (got: CommandOutcome, next: ShopState) => {
    outcomes.set(got.requestId, got.outcome);
    const wrote = got.outcome === 'applied' || got.outcome === 'partially_applied' || ((got.outcome === 'superseded' || got.outcome === 'needs_review') && next !== memory);
    if (wrote && got.rev === memory.rev + 1) memory = { ...next, rev: got.rev };
  };
  const self: Twin = {
    t, get memory() { return memory; }, phone, driver,
    sendOnline(env, now, actor = COUNTER) {
      const mem = execute(memory, env, { now, actor, outcomeOf: (id) => (outcomes.has(id) ? { outcome: outcomes.get(id)! } : undefined), lines: PRODUCTION_LINES, orderIds: 'dated' });
      const got = t.store.command(env, actor, now);
      assert.equal(got.outcome, mem.outcome.outcome, 'online ' + env.type + ' ' + JSON.stringify(got.error ?? null));
      advance(got, mem.state);
      return got;
    },
    sendQueued(env, meta) {
      const full: QueuedMeta = { deviceId: phone, deviceSeq: env.deviceSeq ?? 1, timeSource: 'monotonic', deviceLabel: '1호 차량 휴대폰', signature: 'S'.repeat(86), ...meta };
      const mem = execute(memory, env, {
        now: full.occurredAt, recordedAt: full.receivedAt, actor: driver, outcomeOf: (id) => (outcomes.has(id) ? { outcome: outcomes.get(id)! } : undefined), lines: PRODUCTION_LINES, orderIds: 'dated',
      });
      const got = t.store.commandQueued(env, driver, full);
      assert.equal(got.outcome, mem.outcome.outcome, 'queued ' + env.type + ' ' + JSON.stringify(got.error ?? null) + ' vs ' + JSON.stringify(mem.outcome.error ?? null));
      if (!full.flag && !full.reviews?.length) advance(got, mem.state);
      else memory = t.store.state(full.receivedAt);
      return got;
    },
    check(now, name) {
      const actual = comparable(t.store.state(now));
      if (actual !== comparable(memory)) {
        const a = JSON.parse(actual) as Record<string, unknown>;
        const b = JSON.parse(comparable(memory)) as Record<string, unknown>;
        for (const k of Object.keys(b)) assert.deepEqual(a[k], b[k], name + ': ' + k);
      }
      assert.equal(comparable(t.reopen().state(now)), comparable(memory), name + ' · fresh store');
    },
  };
  return self;
}

const basisOf = (s: ShopState) => ({ epoch: s.epoch, rev: s.rev });
const queuedEnv = (s: ShopState, type: string, payload: unknown, seq: number, extra: Partial<AnyCommandEnvelope> = {}) =>
  ({ ...envelope(type as never, payload as never, basisOf(s)), deviceSeq: seq, ageMs: 0, clockAnchor: 'mono-abcdefgh', madeAt: new Date(T0).toISOString(), ...extra }) as AnyCommandEnvelope;
const lines = (s: ShopState, id: string) => s.orders.find((o) => o.id === id)!.lines.map((l) => ({ lineId: l.id, quantity: l.qty }));
const log = (t: Twin, requestId: string) => one(t.t.db, `SELECT device_id AS d, device_seq AS seq, actor_signature AS sig, time_source_key AS ts, occurred_at AS o, received_at AS r,
  status_key AS st, error_code AS e, result_expires_at AS x, submitted_by_key AS sub, actor_key AS a FROM command_log WHERE request_id = ?`, requestId);

test('canonicalJson moved to the contract writes the same text as the old store function (the imported sample day)', () => {
  const t = twin();
  const state = t.t.store.state(at(15, 40));
  assert.equal(contractCanonical(state), oldCanonical(state));
  for (const r of all(t.t.db, 'SELECT result_json FROM command_log')) {
    const value = JSON.parse(str(r.result_json)) as unknown;
    assert.equal(contractCanonical(value), oldCanonical(value));
  }
});

test('the shared vectors hash the same with node:crypto', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../contract/test/vectors/queued-items.json', import.meta.url), 'utf8')) as { text: string; canonical: string; hash: string }[];
  for (const v of vectors) {
    const canonical = canonicalJson(unsignedItem(JSON.parse(v.text)));
    assert.equal(canonical, v.canonical);
    assert.equal(createHash('sha256').update(canonical, 'utf8').digest('base64url'), v.hash);
  }
});

test('queued collect: fields written, the twin reads back the same, idempotent by request id (also with a new seq)', () => {
  const t = twin();
  const env = queuedEnv(t.memory, 'stock.collect', { taskId: 'collect:o21', lines: lines(t.memory, 'o21') }, 1);
  const out = t.sendQueued(env, { occurredAt: at(16, 35), receivedAt: at(17, 5), timeSource: 'wall_clock', submittedByKey: 'staff:other' });
  assert.equal(out.outcome, 'applied');
  assert.equal(out.timeSource, 'wall_clock');
  t.check(at(17, 5), 'queued collect');
  const row = log(t, env.requestId)!;
  assert.deepEqual({ ...row }, {
    d: t.phone, seq: 1, sig: 'S'.repeat(86), ts: 'wall_clock', o: new Date(at(16, 35)).toISOString(), r: new Date(at(17, 5)).toISOString(), st: 'applied', e: null,
    x: row.x, sub: 'staff:other', a: 'staff:test-driver',
  });
  assert.equal(num(one(t.t.db, 'SELECT last_device_seq AS n FROM devices WHERE id = ?', t.phone)?.n), 1);
  // 같은 요청번호: 같은 번호 · 새 번호 모두 첫 결과, 아무것도 더 적지 않는다.
  const counts = rowCounts(t.t.db);
  const again = t.t.store.commandQueued(env, t.driver, { deviceId: t.phone, deviceSeq: 1, occurredAt: at(16, 35), receivedAt: at(17, 30), timeSource: 'monotonic', deviceLabel: 'x' });
  const renumbered = t.t.store.commandQueued({ ...env, deviceSeq: 9 } as AnyCommandEnvelope, t.driver, { deviceId: t.phone, deviceSeq: 9, occurredAt: at(16, 35), receivedAt: at(17, 31), timeSource: 'monotonic', deviceLabel: 'x' });
  assert.deepEqual([again.outcome, again.rev, renumbered.outcome, renumbered.rev], ['applied', out.rev, 'applied', out.rev]);
  assert.deepEqual(countDiff(counts, rowCounts(t.t.db)), {});
});

test('SEQ_REUSED: the same device number with another request id writes nothing', () => {
  const t = twin();
  t.sendQueued(queuedEnv(t.memory, 'task.visit', { taskId: 'collect:o23', outcomeKey: 'customer_absent' }, 3), { occurredAt: at(16, 40), receivedAt: at(16, 50) });
  const counts = rowCounts(t.t.db);
  const clash = queuedEnv(t.memory, 'task.visit', { taskId: 'collect:o29', outcomeKey: 'customer_absent' }, 3);
  const out = t.t.store.commandQueued(clash, t.driver, { deviceId: t.phone, deviceSeq: 3, occurredAt: at(16, 41), receivedAt: at(16, 51), timeSource: 'monotonic', deviceLabel: 'x' });
  assert.deepEqual([out.outcome, out.error?.code], ['rejected', 'SEQ_REUSED']);
  assert.deepEqual(countDiff(counts, rowCounts(t.t.db)), {});
});

test('an online command of the device queued again after a lost answer: the empty device_seq is filled once (switch-off path only)', () => {
  const t = twin();
  const env = envelope('task.visit', { taskId: 'collect:o23', outcomeKey: 'customer_absent' }, basisOf(t.memory));
  const first = t.sendOnline(env, at(16, 40), t.driver);
  assert.equal(log(t, env.requestId)!.seq, null);
  const again = t.t.store.commandQueued({ ...env, deviceSeq: 4 } as AnyCommandEnvelope, t.driver, { deviceId: t.phone, deviceSeq: 4, occurredAt: at(16, 40), receivedAt: at(16, 45), timeSource: 'monotonic', deviceLabel: 'x' });
  assert.deepEqual([again.outcome, again.rev], [first.outcome, first.rev]);
  assert.equal(log(t, env.requestId)!.seq, 4);
  assert.equal(t.t.store.devices.highWater(t.phone), 4);
  // 다른 기기의 줄은 채우지 않는다.
  const counter = envelope('task.visit', { taskId: 'collect:o29', outcomeKey: 'customer_absent' }, basisOf(t.memory));
  t.sendOnline(counter, at(16, 50));
  t.t.store.commandQueued({ ...counter, deviceSeq: 5 } as AnyCommandEnvelope, t.driver, { deviceId: t.phone, deviceSeq: 5, occurredAt: at(16, 50), receivedAt: at(16, 55), timeSource: 'monotonic', deviceLabel: 'x' });
  assert.equal(log(t, counter.requestId)!.seq, null);
});

test('a lost online refusal of the device queued again (switch-off path) is judged by the queued rules once: money applied with a duplicate review (§18 R4-1)', () => {
  const t = twin();
  // 손님이 카운터에서 먼저 냈다(o28의 미수 120,000원).
  const paid = t.sendOnline(envelope('payment.take', { orderIds: ['o28'], amount: 120_000, methodKey: 'cash' }, basisOf(t.memory), { expect: { dueAmount: 120_000 } }), at(21, 5));
  assert.equal(paid.outcome, 'applied');
  // 기사의 온라인 현장 수납: 받을 금액이 바뀌어 충돌(그 답을 기기가 잃는다).
  const pay = envelope('field.collect', { taskId: 'collect:o28', orderId: 'o28', amount: 120_000, methodKey: 'cash' }, basisOf(t.memory), { expect: { dueAmount: 120_000 } });
  const online = t.sendOnline(pay, at(21, 10), t.driver);
  assert.deepEqual([online.outcome, online.error?.code], ['conflict', 'DUE_CHANGED']);
  // 같은 봉투가 보냄 대기의 사실로 다시 온다: 번호를 채우고 보냄 대기 규칙으로 다시 판단한다.
  const queued = t.sendQueued({ ...pay, deviceSeq: 6 } as AnyCommandEnvelope, { deviceSeq: 6, occurredAt: at(21, 10), receivedAt: at(21, 30) });
  assert.equal(queued.outcome, 'applied');
  assert.ok(queued.reviews.includes('possible_duplicate_money'), JSON.stringify(queued.reviews));
  t.check(at(21, 30), 'rejudged');
  const row = log(t, pay.requestId)!;
  assert.deepEqual([row.st, row.seq, row.ts, row.sig], ['applied', 6, 'monotonic', 'S'.repeat(86)]);
  // 다시 오면 새 결과 그대로(두 번 적용하지 않는다).
  const counts = rowCounts(t.t.db);
  const again = t.t.store.commandQueued({ ...pay, deviceSeq: 6 } as AnyCommandEnvelope, t.driver, { deviceId: t.phone, deviceSeq: 6, occurredAt: at(21, 10), receivedAt: at(21, 40), timeSource: 'monotonic', deviceLabel: 'x' });
  assert.deepEqual([again.outcome, again.rev], ['applied', queued.rev]);
  assert.deepEqual(countDiff(counts, rowCounts(t.t.db)), {});
  // 다른 기기의 온라인 거절은 다시 판단하지 않는다(그 기기의 줄이 아니면 번호도 채우지 않는다).
  const other = envelope('field.collect', { taskId: 'collect:o28', orderId: 'o28', amount: 10_000, methodKey: 'cash' }, basisOf(t.memory), { expect: { dueAmount: 999_000 } });
  const refused = t.sendOnline(other, at(21, 50));
  assert.equal(refused.outcome, 'conflict');
  const stays = t.t.store.commandQueued({ ...other, deviceSeq: 7 } as AnyCommandEnvelope, t.driver, { deviceId: t.phone, deviceSeq: 7, occurredAt: at(21, 50), receivedAt: at(21, 55), timeSource: 'monotonic', deviceLabel: 'x' });
  assert.deepEqual([stays.outcome, log(t, other.requestId)!.seq], ['conflict', null]);
});

test('moved meanwhile: the pulled-back split rows read back the same', () => {
  const t = twin();
  const o = t.memory.orders.find((x) => x.id === 'o25')!;
  const moved = o.lines.map((l) => ({ lineId: l.id, quantity: l.qty }));
  const promise = { mode: 'vehicle' as const, slot: { day: DATE, slotKey: 'late_night' }, placeKey: o.giveBack.placeId!, vehicleId: 'v2' };
  assert.equal(t.sendOnline(envelope('promise.change', { orderId: 'o25', kind: 'return', lines: moved, promise }, basisOf(t.memory)), at(22, 10)).outcome, 'applied');
  t.check(at(22, 10), 'moved');
  const out = t.sendQueued(queuedEnv(t.memory, 'stock.collect', { taskId: 'collect:o25', lines: moved }, 1), { occurredAt: at(21, 55), receivedAt: at(22, 30) });
  assert.equal(out.outcome, 'applied');
  assert.deepEqual(out.reviews, ['task_moved_meanwhile']);
  t.check(at(22, 30), 'pulled back');
});

test('late money after the closing: posting_date is the next day, recordedAt round-trips, late_money review', () => {
  const t = twin();
  // 23:00 마감(돈통 예상대로).
  const sheetCounter = t.memory.settings.openingCash;
  const counterCash = t.memory.orders.reduce((sum, o) => sum + o.payments.filter((p) => p.drawerId === 'counter').reduce((n, p) => n + p.amount, 0), 0);
  const close = envelope('closing.close', { date: DATE, drawerCounts: [{ drawerId: 'counter', countedAmount: sheetCounter + counterCash, expectedAmount: sheetCounter + counterCash }], deferredTransferIds: [] },
    basisOf(t.memory), { expect: { expectedCash: { counter: sheetCounter + counterCash } } });
  assert.equal(t.sendOnline(close, at(23, 0)).outcome, 'applied');
  const env = queuedEnv(t.memory, 'field.collect', { taskId: 'collect:o28', orderId: 'o28', amount: 35_000, methodKey: 'cash' }, 1);
  const out = t.sendQueued(env, { occurredAt: at(22, 50), receivedAt: at(23, 30) });
  assert.equal(out.outcome, 'applied');
  assert.deepEqual(out.reviews, ['late_money']);
  t.check(at(23, 30), 'late money');
  const pay = one(t.t.db, 'SELECT business_date AS b, posting_date AS p, occurred_at AS o, recorded_at AS r, device_id AS d FROM payments WHERE request_id = ?', env.requestId)!;
  assert.deepEqual({ ...pay }, { b: DATE, p: '2026-12-27', o: new Date(at(22, 50)).toISOString(), r: new Date(at(23, 30)).toISOString(), d: t.phone });
  assert.equal(str(one(t.t.db, 'SELECT posting_date AS p FROM cash_movements WHERE source_id = ?', env.requestId)?.p), '2026-12-27');
  const loaded = t.t.store.state(at(23, 30)).orders.find((o) => o.id === 'o28')!.payments.at(-1)!;
  assert.deepEqual([loaded.recordedAt, loaded.deviceId], [at(23, 30), t.phone]);
});

test('possible duplicate money: reviews for both devices with target_device_id; the skipped delivery hop writes load + deliver moves', () => {
  const t = twin();
  const code = t.t.store.devices.createCode({ codeHash: 'c'.repeat(64), kind: 'driver_tablet', label: '1호 차량 태블릿', vehicleId: 'v1', expiresAt: at(23, 0), now: T0 });
  const tablet = t.t.store.devices.enroll({ codeId: code.id, publicKey: '{}', now: T0 + 2 }).id;
  const pay = { taskId: 'collect:o28', orderId: 'o28', amount: 35_000, methodKey: 'cash' };
  t.sendOnline(envelope('field.collect', pay, basisOf(t.memory), { expect: { dueAmount: 120_000 } }), at(21, 10), { ...t.driver, deviceId: tablet });
  const out = t.sendQueued(queuedEnv(t.memory, 'field.collect', pay, 1), { occurredAt: at(21, 0), receivedAt: at(22, 0) });
  assert.deepEqual(out.reviews, ['possible_duplicate_money', 'possible_duplicate_money']);
  t.check(at(22, 0), 'duplicate');
  assert.deepEqual(all(t.t.db, "SELECT target_device_id AS d FROM review_items WHERE kind_key = 'possible_duplicate_money' ORDER BY rowid").map((r) => r.d), [t.phone, tablet]);
  const deliver = t.sendQueued(queuedEnv(t.memory, 'stock.deliver', { taskId: 'deliver:o26', lines: lines(t.memory, 'o26') }, 2), { occurredAt: at(17, 5), receivedAt: at(22, 5) });
  assert.equal(deliver.outcome, 'applied');
  t.check(at(22, 5), 'skipped hop');
  assert.deepEqual(all(t.t.db, "SELECT kind_key AS k FROM stock_movements WHERE order_id = 'o26' ORDER BY rowid").map((r) => r.k), ['load', 'deliver']);
});

test('flagged (scope) items are applied with command_held; held items keep the envelope far into the future; INTERNAL of one item leaves the next alone', () => {
  const t = twin();
  const env = queuedEnv(t.memory, 'task.visit', { taskId: 'collect:o23', outcomeKey: 'customer_absent' }, 1);
  const flagged = t.t.store.commandQueued(env, t.driver, { deviceId: t.phone, deviceSeq: 1, occurredAt: at(16, 40), receivedAt: at(16, 45), timeSource: 'monotonic', deviceLabel: '1호 차량 휴대폰' },
    () => ({ code: 'FORBIDDEN_SCOPE' }));
  assert.equal(flagged.outcome, 'applied');
  assert.deepEqual(flagged.reviews, ['command_held']);
  assert.equal(log(t, env.requestId)!.e, 'FORBIDDEN_SCOPE');
  assert.equal(str(one(t.t.db, "SELECT message AS m FROM review_items WHERE kind_key = 'command_held'")?.m), '1호 차량 휴대폰 기록 1건 공급자 확인 중 · 다른 업무 정상');
  const held = t.t.store.holdQueued({ requestId: '01K62M4QG00000000000000001', type: 'stock.collect', deviceId: t.phone, deviceSeq: 2, reason: 'revoked', envelope: { any: '값' }, actorKey: 'device:' + t.phone, receivedAt: at(17, 0) });
  assert.equal(held.outcome, 'held');
  const heldRow = log(t, '01K62M4QG00000000000000001')!;
  assert.deepEqual([heldRow.st, heldRow.x, heldRow.seq], ['held', HELD_EXPIRES_AT, 2]);
  assert.deepEqual(JSON.parse(str(one(t.t.db, "SELECT result_json AS j FROM command_log WHERE request_id = '01K62M4QG00000000000000001'")?.j)).held, { reason: 'revoked', envelope: { any: '값' } });
  assert.deepEqual(t.t.store.devices.heldCounts(), [{ deviceId: t.phone, label: '1호 차량 휴대폰', revoked: 1, held: 0 }]);
  assert.equal(t.t.store.holdQueued({ requestId: '01K62M4QG00000000000000001', type: 'stock.collect', deviceId: t.phone, deviceSeq: 2, reason: 'revoked', envelope: {}, actorKey: 'x', receivedAt: at(17, 1) }).outcome, 'held');
  // 처리 오류(고장 고리): 그 항목은 적지 않고(다음 묶음이 같은 번호로), 다음 항목은 그대로 적용.
  const faulty = provisioned(':memory:', { fault: (phase, e) => { if (phase === 'write' && (e as { deviceSeq?: number }).deviceSeq === 1) throw new Error('boom'); } });
  const empty = faulty.store.state(T0);
  const day = sampleDay({ date: DATE, epoch: empty.epoch, ids: 'demo' });
  faulty.store.importDay({ date: DATE, orders: day.orders, pins: day.pins, deposits: day.deposits, paymentGroups: day.paymentGroups }, 'import:x', T0, COUNTER);
  const s0 = faulty.store.state(T0);
  const meta = (seq: number) => ({ deviceId: t.phone, deviceSeq: seq, occurredAt: at(16, 40), receivedAt: at(16, 45), timeSource: 'monotonic' as const, deviceLabel: 'x' });
  const code = faulty.store.devices.createCode({ codeHash: 'd'.repeat(64), kind: 'driver_phone', label: 'p', vehicleId: 'v1', expiresAt: at(23, 0), now: T0 });
  const dev = faulty.store.devices.enroll({ codeId: code.id, publicKey: '{}', now: T0 + 1 }).id;
  const a = faulty.store.commandQueued(queuedEnv(s0, 'task.visit', { taskId: 'collect:o23', outcomeKey: 'customer_absent' }, 1), { ...t.driver, deviceId: dev }, { ...meta(1), deviceId: dev });
  const b = faulty.store.commandQueued(queuedEnv(s0, 'task.visit', { taskId: 'collect:o29', outcomeKey: 'customer_absent' }, 2), { ...t.driver, deviceId: dev }, { ...meta(2), deviceId: dev });
  assert.deepEqual([a.outcome, a.error?.code, b.outcome], ['rejected', 'INTERNAL', 'applied']);
  assert.equal(num(one(faulty.db, 'SELECT count(*) AS n FROM command_log WHERE device_seq = 1')?.n), 0);
});

test('gaps: missing numbers below the high water, the contiguous end moves forward, numbers above count only when asked', () => {
  const t = twin();
  for (const seq of [1, 2, 4, 7]) {
    t.sendQueued(queuedEnv(t.memory, 'notification.ack', { notificationId: 'pin1' }, seq), { occurredAt: at(16, seq), receivedAt: at(17, seq) });
  }
  t.t.store.devices.noteLink(t.phone, { queueDepth: 0, lastSeq: 9, clockOffsetMs: 0, appVersion: 'test', offlineCapable: true, epoch: t.memory.epoch }, at(17, 10));
  const g = t.t.store.devices.gaps(t.phone);
  assert.deepEqual([g.missing, g.count, g.since], [[3, 5, 6], 3, at(17, 4)]);
  assert.equal(num(one(t.t.db, 'SELECT last_device_seq AS n FROM device_sync_cursors WHERE device_id = ?', t.phone)?.n), 2);
  assert.deepEqual(t.t.store.devices.gaps(t.phone, { lastSeq: 9, above: true }).missing, [3, 5, 6, 8, 9]);
  t.sendQueued(queuedEnv(t.memory, 'notification.ack', { notificationId: 'pin1' }, 3), { occurredAt: at(16, 3), receivedAt: at(17, 20) });
  assert.deepEqual(t.t.store.devices.gaps(t.phone).missing, [5, 6]);
  assert.equal(num(one(t.t.db, 'SELECT last_device_seq AS n FROM device_sync_cursors WHERE device_id = ?', t.phone)?.n), 4);
  // 기록 범위(사본과 같은 읽기).
  const rec = t.t.store.devices.recorded(t.phone, 3, 2);
  assert.deepEqual([rec.items.map((r) => r.deviceSeq), rec.more], [[3, 4], true]);
});

test('pii_access_log takes the working copy row', () => {
  const t = twin();
  logPiiAccess(t.t.db, 'shop0test', { actorKey: 'staff:test-driver', deviceId: t.phone, action: 'working_copy', subjectType: 'copy', subjectId: 'v1:' + DATE, itemCount: 12, now: at(21, 0) });
  assert.deepEqual({ ...one(t.t.db, 'SELECT action_key AS a, subject_type AS s, subject_id AS i, item_count AS n FROM pii_access_log')! }, { a: 'working_copy', s: 'copy', i: 'v1:' + DATE, n: 12 });
});

test('the closing prepare hook runs after the idempotency lookup; the override reason round-trips and the links are in the journal', () => {
  const t = twin();
  const counter = t.memory.settings.openingCash + t.memory.orders.reduce((sum, o) => sum + o.payments.filter((p) => p.drawerId === 'counter').reduce((n, p) => n + p.amount, 0), 0);
  const close = envelope('closing.close', { date: DATE, drawerCounts: [{ drawerId: 'counter', countedAmount: counter, expectedAmount: counter }], deferredTransferIds: [], unsynced: { approvalId: 'A'.repeat(22), reason: '휴대폰 꺼짐' } },
    basisOf(t.memory), { expect: { expectedCash: { counter } } });
  let calls = 0;
  const links = [{ vehicleId: 'v1', state: 'offline' as const, reportedPending: null, since: new Date(at(21, 40)).toISOString() }];
  const prepare = (e: AnyCommandEnvelope) => {
    calls += 1;
    const p = e.payload as Record<string, unknown>;
    const { unsynced: _u, ...rest } = p;
    return { ...e, payload: { ...rest, links, override: { approvalId: 'A'.repeat(22), reason: '휴대폰 꺼짐', approvedBy: 'staff:test-manager' } } } as AnyCommandEnvelope;
  };
  const out = t.t.store.command(close, COUNTER, at(23, 0), undefined, prepare);
  assert.equal(out.outcome, 'applied', JSON.stringify(out.error ?? null));
  const again = t.t.store.command(close, COUNTER, at(23, 1), undefined, prepare);
  assert.deepEqual([again.outcome, again.rev, calls], ['applied', out.rev, 1], 'a resend answers the first result without running the hook again');
  assert.equal(str(one(t.t.db, 'SELECT override_reason AS r FROM closings')?.r), '휴대폰 꺼짐');
  assert.equal(t.t.reopen().state(at(23, 2)).closings[0]?.overrideReason, '휴대폰 꺼짐');
  const journal = JSON.parse(str(one(t.t.db, "SELECT command_json AS j FROM events WHERE command_type = 'closing.close'")?.j)) as { payload: { links: unknown; unsynced?: unknown } };
  assert.deepEqual(journal.payload.links, links);
  assert.equal(journal.payload.unsynced, undefined);
});

test('a closing committed between two queued items: the later money is recorded at or after the closing, posts to the next day in SQL and in the domain, and raises late_money (§17 R3-2)', () => {
  const t = twin();
  const counter = t.memory.settings.openingCash + t.memory.orders.reduce((sum, o) => sum + o.payments.filter((p) => p.drawerId === 'counter').reduce((n, p) => n + p.amount, 0), 0);
  const close = envelope('closing.close', { date: DATE, drawerCounts: [{ drawerId: 'counter', countedAmount: counter, expectedAmount: counter }], deferredTransferIds: [] }, basisOf(t.memory),
    { expect: { expectedCash: { counter } } });
  assert.equal(t.t.store.command(close, COUNTER, at(23, 0)).outcome, 'applied');
  const s1 = t.t.store.state(at(23, 0));
  // 묶음이 받은 때를 22:59:59로 잡고 쉬는 사이 마감이 23:00에 COMMIT했다: 뒤의 항목은 마감 뒤에 적힌다.
  const env = queuedEnv(s1, 'field.collect', { taskId: 'collect:o28', orderId: 'o28', amount: 35_000, methodKey: 'cash' }, 1);
  const out = t.t.store.commandQueued(env, t.driver, {
    deviceId: t.phone, deviceSeq: 1, timeSource: 'monotonic', deviceLabel: '1호 차량 휴대폰', signature: 'S'.repeat(86), occurredAt: at(22, 50), receivedAt: at(23, 0) - 1_000,
  });
  assert.equal(out.outcome, 'applied', JSON.stringify(out.error ?? null));
  assert.ok(out.reviews.includes('late_money'), JSON.stringify(out.reviews));
  const sql = one(t.t.db, 'SELECT posting_date AS p, recorded_at AS r, business_date AS b FROM payments WHERE request_id = ?', env.requestId)!;
  const state = t.t.store.state(at(23, 1));
  const pay = state.orders.find((o) => o.id === 'o28')!.payments.at(-1)!;
  assert.equal(str(sql.b), DATE);
  assert.equal(str(sql.p), '2026-12-27');
  assert.equal(postingDate(state, pay.at, pay.recordedAt), '2026-12-27', 'the domain posting agrees with the SQL posting');
  assert.ok(Date.parse(str(sql.r)) >= state.closings[0]!.closedAt, 'recorded at or after the closing');
});

test('a non-money queued item outside the scope is superseded with nothing written; the high water still moves (§17 R3-10)', () => {
  const t = twin();
  const before = t.t.store.state(at(16, 45));
  const env = queuedEnv(before, 'task.visit', { taskId: 'collect:o23', outcomeKey: 'customer_absent' }, 3);
  const out = t.t.store.commandQueued(env, t.driver, { deviceId: t.phone, deviceSeq: 3, occurredAt: at(16, 40), receivedAt: at(16, 45), timeSource: 'monotonic', deviceLabel: '1호 차량 휴대폰' },
    () => ({ code: 'FORBIDDEN_SCOPE', supersede: true }));
  assert.deepEqual([out.outcome, out.error?.code, out.reviews], ['superseded', 'FORBIDDEN_SCOPE', []]);
  assert.equal(t.t.store.state(at(16, 46)).rev, before.rev, 'nothing written');
  assert.deepEqual([log(t, env.requestId)!.st, log(t, env.requestId)!.e, log(t, env.requestId)!.seq], ['superseded', 'FORBIDDEN_SCOPE', 3]);
  assert.equal(t.t.store.devices.highWater(t.phone), 3);
  // 권한 없음(서버가 meta.flag로 넘김): 돈 · 재고는 적용 + `공급자 확인 중`, 그 밖은 적지 않음.
  const pay = queuedEnv(before, 'field.collect', { taskId: 'collect:o28', orderId: 'o28', amount: 10_000, methodKey: 'cash' }, 4);
  const paid = t.t.store.commandQueued(pay, t.driver, { deviceId: t.phone, deviceSeq: 4, occurredAt: at(16, 41), receivedAt: at(16, 46), timeSource: 'monotonic', deviceLabel: '1호 차량 휴대폰', flag: { code: 'FORBIDDEN' } });
  assert.deepEqual([paid.outcome, paid.reviews.includes('command_held'), log(t, pay.requestId)!.e], ['applied', true, 'FORBIDDEN']);
});

test('restoredUpToRev is null on a provisioned shop and the value of shop_instance after a restore (§17 R3-1)', () => {
  const t = twin();
  assert.equal(t.t.store.restoredUpToRev(), null);
  t.t.db.prepare('UPDATE shop_instance SET restored_up_to_rev = 41').run();
  assert.equal(t.t.store.restoredUpToRev(), 41);
});

// 보냄 대기(work/impl-offline/plan.md O9 · O18 · O20 · O22, §7-9 queue.test): 실패한 트랜잭션은 번호도 칸도 남기지 않음, 다시 연 화면에서도 번호가
// 늘 오름, 같은 요청번호는 있는 항목, 잠금 없는 두 화면의 겹친 add는 하나만, 보내던 항목 → 결과 확인 중, 새 번호(SEQ_REUSED), 복구 뒤 되돌림,
// 묶음 답, 사본에 든 항목 옮김, 빠진 번호 다시 보냄, 보낸 기록 정리, 판 올림.
import type { QueuedItemResult } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { LocalStore, PageLocks } from '../src/local/local-store.ts';
import { SendQueue, stripPii, upgradeQueueRecord, type CommandCore } from '../src/local/queue.ts';
import { MemoryRawStore, TxAborted } from '../src/local/raw-store.ts';
import { copyBody, copyHead } from './local-helpers.ts';

const DEVICE = '01JF00000000000000000DEV01';
const clock = { createdWall: 1_000, createdMono: 5, pageAnchor: 'abcdefgh1234', offsetAtCreate: 0 };
let n = 0;
const rid = () => '01JF3Q8W2Z6N9XK4T7B5R1' + String(++n).padStart(4, '0');
const core = (requestId = rid(), taskId = 'collect:o25'): CommandCore => ({
  type: 'stock.collect', commandVersion: 1, requestId, basis: { epoch: 'e1', rev: 10 }, payload: { taskId, lines: [{ lineId: 'o25-l1', quantity: 1 }] },
  recordedBy: { staffId: 'staff-3', sessionId: 'S1' },
});

function page(raw: MemoryRawStore, locks = new PageLocks(), deviceId = DEVICE) {
  const local = new LocalStore({ raw, deviceId, locks });
  return { local, queue: new SendQueue(local) };
}

const result = (requestId: string, deviceSeq: number, outcome: QueuedItemResult['outcome'], extra: Partial<QueuedItemResult> = {}): QueuedItemResult => ({
  requestId, deviceSeq, outcome, rev: 20, reviews: [], ...extra,
});

describe('넣기(O9)', () => {
  it('실패한 트랜잭션은 번호를 올리지도 칸을 남기지도 않는다', async () => {
    const raw = new MemoryRawStore();
    const { queue } = page(raw);
    // 열쇠를 만드는 쓰기가 먼저 실패하지 않게 한 건을 먼저 넣는다.
    await queue.enqueue(core(), clock, { madeOffline: true });
    raw.failNextWrite = 'QuotaExceededError';
    await expect(queue.enqueue(core(), clock, { madeOffline: true })).rejects.toThrow();
    expect((await queue.list()).items.map((i) => i.seq)).toEqual([1]);
    expect((await queue.counter()).next).toBe(2);
    const next = await queue.enqueue(core(), clock, { madeOffline: true });
    expect(next.kind === 'queued' && next.item.seq).toBe(2);
  });

  it('다시 연 화면(새 SendQueue)에서도 번호는 늘 오르고, 같은 요청번호는 있는 항목을 돌려준다', async () => {
    const raw = new MemoryRawStore();
    const a = page(raw);
    const first = core();
    await a.queue.enqueue(first, clock, { madeOffline: true });
    await a.queue.enqueue(core(), clock, { madeOffline: true });
    const b = page(raw);
    const again = await b.queue.enqueue(first, clock, { madeOffline: false });
    expect(again).toMatchObject({ kind: 'queued', created: false });
    expect(again.kind === 'queued' && again.item.seq).toBe(1);
    const third = await b.queue.enqueue(core(), clock, { madeOffline: false });
    expect(third.kind === 'queued' && third.item.seq).toBe(3);
    expect((await b.queue.list()).items.map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  it('잠금이 없는 두 화면(사파리 15.4 전)이 같은 요청번호를 함께 넣어도 add가 겹쳐 하나만 남고 번호는 한 번만 오른다', async () => {
    const raw = new MemoryRawStore();
    const a = page(raw);
    const b = page(raw);
    await a.queue.enqueue(core(), clock, { madeOffline: true });
    const same = core();
    const results = await Promise.allSettled([a.queue.enqueue(same, clock, { madeOffline: true }), b.queue.enqueue(same, clock, { madeOffline: true })]);
    const created = results.filter((r) => r.status === 'fulfilled' && r.value.kind === 'queued' && r.value.created);
    const failed = results.filter((r) => r.status === 'rejected');
    expect(created).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(TxAborted);
    expect((await a.queue.list()).items.map((i) => i.seq)).toEqual([1, 2]);
    expect((await a.queue.counter()).next).toBe(3);
  });

  it('확인 전 검사가 거절하면 아무것도 넣지 않는다(검사는 잠금 안에서 다시 읽은 보냄 대기를 본다)', async () => {
    const raw = new MemoryRawStore();
    const { queue } = page(raw);
    await queue.enqueue(core(), clock, { madeOffline: true });
    let seen = -1;
    const refused = await queue.enqueue(core(), clock, {
      madeOffline: true,
      prevalidate: (items) => {
        seen = items.length;
        return { outcome: 'conflict', requestId: 'x', rev: 1, asOfRev: 1, epoch: 'e1', rebased: false, changes: [], error: { code: 'DUE_CHANGED', message: '받을 금액 변경' } };
      },
    });
    expect(seen).toBe(1);
    expect(refused.kind).toBe('refused');
    expect((await queue.list()).items).toHaveLength(1);
    expect((await queue.counter()).next).toBe(2);
  });

  it('새 기기 id는 번호를 1부터: 옛 기기의 보낸 기록 번호에 끌려가지 않는다(번호 빈 곳이 생기지 않게)', async () => {
    const raw = new MemoryRawStore();
    const old = page(raw, new PageLocks(), '01JF00000000000000000DEV00');
    for (let i = 0; i < 3; i += 1) await old.queue.enqueue(core(), clock, { madeOffline: true });
    const fresh = page(raw);
    const item = await fresh.queue.enqueue(core(), clock, { madeOffline: true });
    expect(item.kind === 'queued' && item.item.seq).toBe(1);
  });
});

describe('상태 · 답(O6 · O18)', () => {
  it('보내던 채 닫힌 화면의 항목은 다음 시작에 결과 확인 중이 된다', async () => {
    const raw = new MemoryRawStore();
    const { queue } = page(raw);
    const a = core();
    const b = core();
    await queue.enqueue(a, clock, { madeOffline: true });
    await queue.enqueue(b, clock, { madeOffline: true });
    await queue.setState([a.requestId], 'sending');
    const reopened = page(raw).queue;
    expect(await reopened.recoverSending()).toBe(1);
    expect((await reopened.list()).items.map((i) => [i.requestId, i.state])).toEqual([[a.requestId, 'unconfirmed'], [b.requestId, 'queued']]);
  });

  it('묶음 답: 적용 → answered(사본까지 남음), 보류 → 곧바로 보낸 기록, INTERNAL → 다시, BAD_INPUT → 이 판에서 건너뜀, SEQ_REUSED → 새 번호', async () => {
    const raw = new MemoryRawStore();
    const { queue } = page(raw);
    const ids = [core(), core(), core(), core(), core()];
    for (const c of ids) await queue.enqueue(c, clock, { madeOffline: true });
    await queue.noteHighWater(7);
    const summary = await queue.answer([
      result(ids[0]!.requestId, 1, 'applied'),
      result(ids[1]!.requestId, 2, 'held', { reviews: ['command_held'] }),
      result(ids[2]!.requestId, 3, 'rejected', { error: { code: 'INTERNAL', message: '' } }),
      result(ids[3]!.requestId, 4, 'rejected', { error: { code: 'BAD_INPUT', message: '' } }),
      result(ids[4]!.requestId, 5, 'rejected', { error: { code: 'SEQ_REUSED', message: '' } }),
    ], 'e1', 5_000, 'v1');
    expect(summary).toMatchObject({ answered: 1, held: 1, retry: 1, stuck: 1, restamped: 1, notApplied: 4 });
    const items = (await queue.list()).items;
    expect(items.map((i) => [i.requestId, i.state, i.seq, i.stuckVersion ?? null])).toEqual([
      [ids[0]!.requestId, 'answered', 1, null],
      [ids[2]!.requestId, 'queued', 3, null],
      [ids[3]!.requestId, 'queued', 4, 'v1'],
      [ids[4]!.requestId, 'queued', 8, null],
    ]);
    expect(items.find((i) => i.requestId === ids[2]!.requestId)!.attempts).toBe(1);
    expect((await queue.sent()).map((s) => [s.requestId, s.outcome])).toEqual([[ids[1]!.requestId, 'held']]);
  });

  it('답이 오기 전에 사본이 보낸 기록으로 옮긴 항목은 보낸 것으로 센다(띠의 결과 줄, §17-4). 칸은 그대로', async () => {
    const raw = new MemoryRawStore();
    const { local, queue } = page(raw);
    const [a, b] = [core(), core()];
    for (const x of [a, b]) await queue.enqueue(x, clock, { madeOffline: true });
    await queue.setState([a.requestId, b.requestId], 'sending');
    // 다시 보낸 묶음의 답보다 사본(recorded: a는 적용, b는 확인 필요)이 먼저 왔다.
    await local.writeCopy(copyHead(), copyBody(), (t) => queue.settleInTx(t, [
      { requestId: a.requestId, deviceSeq: 1, outcome: 'applied', rev: 20, reviews: [] },
      { requestId: b.requestId, deviceSeq: 2, outcome: 'needs_review', rev: 21, reviews: ['collect_exceeds'] },
    ], 'e1', 2));
    const before = await queue.sent();
    const summary = await queue.answer([result(a.requestId, 1, 'applied'), result(b.requestId, 2, 'needs_review'), result('01JF3Q8W2Z6N9XK4T7B5R19999', 9, 'applied')], 'e1', 3, 'v1');
    expect(summary).toMatchObject({ answered: 0, held: 0, settled: 2, notApplied: 1 });
    expect((await queue.list()).items).toEqual([]);
    expect(await queue.sent()).toEqual(before);
  });

  it('번호가 다른 답(그사이 새 번호를 받음)은 받지 않는다', async () => {
    const raw = new MemoryRawStore();
    const { queue } = page(raw);
    const c = core();
    await queue.enqueue(c, clock, { madeOffline: true });
    await queue.answer([result(c.requestId, 9, 'applied')], 'e1', 1, 'v1');
    expect((await queue.list()).items[0]!.state).toBe('queued');
  });

  it('사본의 recorded에 든 항목은 사본을 쓰는 트랜잭션에서 보낸 기록으로 옮긴다(답을 잃은 것도)', async () => {
    const raw = new MemoryRawStore();
    const { local, queue } = page(raw);
    const a = core();
    const b = core();
    await queue.enqueue(a, clock, { madeOffline: true });
    await queue.enqueue(b, clock, { madeOffline: true });
    await queue.setState([a.requestId], 'unconfirmed');
    await local.writeCopy(copyHead(), copyBody(), (t) => queue.settleInTx(t, [
      { requestId: a.requestId, deviceSeq: 1, outcome: 'superseded', rev: 12, reviews: ['already_returned'] },
    ], 'e1', 9_000));
    expect((await queue.list()).items.map((i) => i.requestId)).toEqual([b.requestId]);
    const sent = await queue.sent();
    expect(sent.map((s) => [s.requestId, s.outcome, s.reviews, s.answeredAt])).toEqual([[a.requestId, 'superseded', ['already_returned'], 9_000]]);
    // 봉인은 그대로 옮겨 여전히 열린다.
    expect((await queue.sentCore(sent[0]!))?.payload).toEqual(a.payload);
  });
});

describe('다시 보내기 · 복구(O9 · O20)', () => {
  it('서버가 빠졌다는 번호: 같은 epoch의 보낸 기록 · 답을 받은 항목을 같은 번호로 되돌린다(보류는 빼고)', async () => {
    const raw = new MemoryRawStore();
    const { local, queue } = page(raw);
    const [a, b, c] = [core(), core(), core()];
    for (const x of [a, b, c]) await queue.enqueue(x, clock, { madeOffline: true });
    await queue.answer([result(a.requestId, 1, 'applied'), result(b.requestId, 2, 'applied'), result(c.requestId, 3, 'held')], 'e1', 1, 'v1');
    await local.writeCopy(copyHead(), copyBody(), (t) => queue.settleInTx(t, [{ requestId: a.requestId, deviceSeq: 1, outcome: 'applied', rev: 20, reviews: [] }], 'e1', 2));
    expect(await queue.resendMissing([1, 2, 3], 'e1')).toBe(2);
    expect((await queue.list()).items.map((i) => [i.seq, i.state])).toEqual([[1, 'queued'], [2, 'queued']]);
    expect((await queue.sent()).map((s) => s.seq)).toEqual([3]);
  });

  it('복구 뒤: 지금 epoch보다 옛 epoch에서 restoredUpToRev 뒤에 적용된 기록만 같은 요청번호 · 번호로 보냄 대기에 되돌아가고 새 항목보다 먼저다', async () => {
    const raw = new MemoryRawStore();
    const { local, queue } = page(raw);
    const [a, b, c] = [core(), core(), core()];
    for (const x of [a, b]) await queue.enqueue(x, clock, { madeOffline: true });
    await queue.answer([result(a.requestId, 1, 'applied', { rev: 100 }), result(b.requestId, 2, 'applied', { rev: 105 })], 'e1', 1, 'v1');
    await local.writeCopy(copyHead(), copyBody(), (t) => queue.settleInTx(t, [
      { requestId: a.requestId, deviceSeq: 1, outcome: 'applied', rev: 100, reviews: [] },
      { requestId: b.requestId, deviceSeq: 2, outcome: 'applied', rev: 105, reviews: [] },
    ], 'e1', 2));
    await queue.enqueue(c, clock, { madeOffline: true });
    expect(await queue.requeueAfterRestore('e1', 102)).toBe(0);
    expect(await queue.requeueAfterRestore('e2', 102)).toBe(1);
    const items = (await queue.list()).items;
    expect(items.map((i) => [i.requestId, i.seq, i.state])).toEqual([[b.requestId, 2, 'queued'], [c.requestId, 3, 'queued']]);
    expect((await queue.sent()).map((s) => s.requestId)).toEqual([a.requestId]);
    // 되돌린 항목의 본문은 여전히 열린다(같은 봉인).
    expect(items[0]!.core.payload).toEqual(b.payload);
    // 한 번 더 불러도 같은 것을 두 번 되돌리지 않는다.
    expect(await queue.requeueAfterRestore('e2', 102)).toBe(0);
  });

  it('복구 뒤: 기준 rev와 같은 보류 기록은 되돌리고(보류는 rev를 적지 않아 백업 뒤에 쓰였을 수 있다) 기준 rev에 적용된 기록은 두 번 보내지 않는다(검토 1회 data-loss 2)', async () => {
    const raw = new MemoryRawStore();
    const { local, queue } = page(raw);
    const [a, h, g] = [core(), core(), core()];
    for (const x of [a, h, g]) await queue.enqueue(x, clock, { madeOffline: true });
    // a: rev 102에 적용(되살린 자료에 있음). h: 머리가 102일 때 보류(그 줄은 백업 뒤일 수 있음). g: 머리 101일 때 보류(기준 앞).
    await queue.answer([result(a.requestId, 1, 'applied', { rev: 102 }), result(h.requestId, 2, 'held', { rev: 102 }), result(g.requestId, 3, 'held', { rev: 101 })], 'e1', 1, 'v1');
    await local.writeCopy(copyHead(), copyBody(), (t) => queue.settleInTx(t, [{ requestId: a.requestId, deviceSeq: 1, outcome: 'applied', rev: 102, reviews: [] }], 'e1', 2));
    expect((await queue.sent()).map((s) => [s.seq, s.outcome])).toEqual([[1, 'applied'], [2, 'held'], [3, 'held']]);
    expect(await queue.requeueAfterRestore('e2', 102)).toBe(1);
    expect((await queue.list()).items.map((i) => [i.requestId, i.seq, i.state])).toEqual([[h.requestId, 2, 'queued']]);
    expect((await queue.sent()).map((s) => s.seq)).toEqual([1, 3]);
    // 빠진 번호로 알려도 같은 규칙(복구로 온 epoch의 기준).
    await local.patchMeta({ epoch: 'e2', restoredEpoch: 'e2', restoredUpToRev: 101 });
    expect(await queue.resendMissing([1, 3], 'e2')).toBe(2);
    expect((await queue.list()).items.map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  it('복구가 아닌 새 epoch(시험 매장 새로 만들기, §17 R3-1): 옛 답만 보낸 기록으로 옮기고 되돌리지 않는다. 보내지 않은 항목은 남는다', async () => {
    const raw = new MemoryRawStore();
    const { queue } = page(raw);
    const [a, b] = [core(), core()];
    for (const x of [a, b]) await queue.enqueue(x, clock, { madeOffline: true });
    await queue.answer([result(a.requestId, 1, 'applied', { rev: 100 })], 'e1', 1, 'v1');
    expect(await queue.settleOldEpoch('e2', 5)).toBe(1);
    expect((await queue.list()).items.map((i) => [i.requestId, i.state])).toEqual([[b.requestId, 'queued']]);
    expect((await queue.sent()).map((s) => [s.requestId, s.epoch, s.rev, s.outcome])).toEqual([[a.requestId, 'e1', 100, 'applied']]);
    expect(await queue.latestEpoch()).toBe('e1');
  });

  it('빠진 번호: 이 epoch의 보낸 기록만, 복구로 온 epoch면 기준 뒤의 옛 epoch 기록도(§17 R3-3)', async () => {
    const raw = new MemoryRawStore();
    const { local, queue } = page(raw);
    const [a, b] = [core(), core()];
    for (const x of [a, b]) await queue.enqueue(x, clock, { madeOffline: true });
    await queue.answer([result(a.requestId, 1, 'applied', { rev: 100 }), result(b.requestId, 2, 'applied', { rev: 105 })], 'e1', 1, 'v1');
    await local.writeCopy(copyHead(), copyBody(), (t) => queue.settleInTx(t, [
      { requestId: a.requestId, deviceSeq: 1, outcome: 'applied', rev: 100, reviews: [] },
      { requestId: b.requestId, deviceSeq: 2, outcome: 'applied', rev: 105, reviews: [] },
    ], 'e1', 2));
    // 새로 만든 매장(복구 표시 없음): 옛 epoch의 기록은 빠진 번호로 알려도 보내지 않는다.
    expect(await queue.resendMissing([1, 2], 'e2')).toBe(0);
    await local.patchMeta({ epoch: 'e2', restoredEpoch: 'e2', restoredUpToRev: 102 });
    expect(await queue.resendMissing([1, 2], 'e2')).toBe(1);
    expect((await queue.list()).items.map((i) => i.requestId)).toEqual([b.requestId]);
  });
});

describe('빠진 번호와 epoch(§17-4)', () => {
  it('새로 만든 매장이 알린 빠진 번호: 사본에 아직 들지 않은 옛 epoch의 답도 되돌리지 않는다. 같은 epoch의 답과 복구 기준 뒤의 옛 답은 되돌린다', async () => {
    const raw = new MemoryRawStore();
    const { local, queue } = page(raw);
    const [a, b, c] = [core(), core(), core()];
    for (const x of [a, b, c]) await queue.enqueue(x, clock, { madeOffline: true });
    // a · b는 옛 매장(e1)이 답했고 아직 사본에 들지 않았다. c는 새 매장(e2)이 답했다.
    await queue.answer([result(a.requestId, 1, 'applied', { rev: 100 }), result(b.requestId, 2, 'applied', { rev: 105 })], 'e1', 1, 'v1');
    await queue.answer([result(c.requestId, 3, 'applied', { rev: 7 })], 'e2', 2, 'v1');
    const states = async () => (await queue.list()).items.map((i) => [i.seq, i.state, i.answeredEpoch ?? null]);
    // 새 매장은 1 · 2를 받은 적이 없다고 알린다: 옛 매장의 답이라 새 매장에 다시 보내지 않는다(두 번 세지 않게).
    expect(await queue.resendMissing([1, 2], 'e2')).toBe(0);
    expect(await states()).toEqual([[1, 'answered', 'e1'], [2, 'answered', 'e1'], [3, 'answered', 'e2']]);
    // 같은 epoch의 답은 전처럼 되돌린다.
    expect(await queue.resendMissing([3], 'e2')).toBe(1);
    expect(await states()).toEqual([[1, 'answered', 'e1'], [2, 'answered', 'e1'], [3, 'queued', 'e2']]);
    // 복구로 온 epoch(기준 102)면 기준 뒤의 옛 답(b, rev 105)만 되돌린다.
    await local.patchMeta({ epoch: 'e2', restoredEpoch: 'e2', restoredUpToRev: 102 });
    expect(await queue.resendMissing([1, 2], 'e2')).toBe(1);
    expect(await states()).toEqual([[1, 'answered', 'e1'], [2, 'queued', 'e1'], [3, 'queued', 'e2']]);
  });

  it('기기가 아는 epoch보다 옛 epoch의 늦은 답이 알린 빠진 번호는 쓰지 않는다', async () => {
    const raw = new MemoryRawStore();
    const { local, queue } = page(raw);
    const a = core();
    await queue.enqueue(a, clock, { madeOffline: true });
    await queue.answer([result(a.requestId, 1, 'applied', { rev: 100 })], 'e1', 1, 'v1');
    await local.patchMeta({ epoch: 'e2' });
    expect(await queue.resendMissing([1], 'e1')).toBe(0);
    expect((await queue.list()).items.map((i) => [i.seq, i.state])).toEqual([[1, 'answered']]);
    // 같은 epoch를 아는 기기라면 되돌린다(빠진 번호 규칙 그대로).
    await local.patchMeta({ epoch: 'e1' });
    expect(await queue.resendMissing([1], 'e1')).toBe(1);
  });
});

describe('보낸 기록 정리 · 판(O14 f · O15)', () => {
  it('sentLogDays 지난 기록은 지우고, sentPiiHours 지난 기록은 개인정보 칸을 뺀 본문으로 다시 봉인한다', async () => {
    const raw = new MemoryRawStore();
    const { local, queue } = page(raw);
    const a = core();
    const b = { ...core(), payload: { taskId: 'collect:o25', note: '김민수 010-0000-0025', lines: [] } };
    await queue.enqueue(a, clock, { madeOffline: true });
    await queue.enqueue(b, clock, { madeOffline: true });
    const day = 86_400_000;
    await local.writeCopy(copyHead(), copyBody(), (t) => queue.settleInTx(t, [{ requestId: a.requestId, deviceSeq: 1, outcome: 'applied', rev: 1, reviews: [] }], 'e1', 0));
    await local.touchCopy({}, (t) => queue.settleInTx(t, [{ requestId: b.requestId, deviceSeq: 2, outcome: 'applied', rev: 2, reviews: [] }], 'e1', 6 * day));
    const out = await queue.pruneSent(7 * day + 1, 7, 24);
    expect(out).toEqual({ removed: 1, stripped: 1 });
    const sent = await queue.sent();
    expect(sent.map((s) => [s.requestId, s.piiStripped])).toEqual([[b.requestId, true]]);
    expect((await queue.sentCore(sent[0]!))?.payload).toEqual({ taskId: 'collect:o25', lines: [] });
  });

  it('판 올림: fmt 1만 받고, 빠진 칸 · 모르는 판은 null', () => {
    const base = { fmt: 1, requestId: 'r', seq: 1, deviceId: 'd', type: 'stock.collect', state: 'queued', createdWall: 1, createdMono: 1, pageAnchor: 'a', offsetAtCreate: 0, keyId: 'k', iv: new Uint8Array(12), body: new Uint8Array(4) };
    expect(upgradeQueueRecord(base)).toMatchObject({ attempts: 0, madeOffline: false, seq: 1 });
    expect(upgradeQueueRecord({ ...base, fmt: 2 })).toBeNull();
    expect(upgradeQueueRecord({ ...base, state: 'weird' })).toBeNull();
    const { seq: _seq, ...noSeq } = base;
    expect(upgradeQueueRecord(noSeq)).toBeNull();
  });

  it('stripPii는 깊이 들어가 PII_KEYS만 뺀다', () => {
    expect(stripPii({ a: 1, teamName: 'x', lines: [{ note: 'y', lineId: 'l' }] })).toEqual({ a: 1, lines: [{ lineId: 'l' }] });
  });
});

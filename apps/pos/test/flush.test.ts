// 보내기(work/impl-offline/plan.md §7-5 · O6 · O18, §7-9 flush.test): 연결마다 심장 박동부터, 묶음 크기(5 → 두 배 · 답을 잃으면 반), 400 → 하나씩 →
// 혼자서도 안 되는 항목은 건너뜀(stuckSeq), 빠진 번호 다시 보냄, 답을 잃으면 결과 확인 중 → 같은 번호로 다시, 409 · 429 · 네트워크 없음은 앞 상태로,
// 기다림(2 · 4 · 8 · 16 · 30초 ±20%), 다 보내면 onDrained.
import type { BatchRequest, BatchResponse, HeartbeatResponse, QueuedEnvelope, QueuedItemResult } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import type { PostAnswer } from '../src/app/http-client.ts';
import { backoffDelay, FLUSH, Flusher, type FlushResult } from '../src/local/flush.ts';
import { LocalStore } from '../src/local/local-store.ts';
import { overlayEnvelope, SendQueue, type CommandCore, type QueueItem } from '../src/local/queue.ts';
import { MemoryRawStore } from '../src/local/raw-store.ts';
import { ManualTimers, TEST_POLICY } from './fake-server.ts';

const DEVICE = '01JF00000000000000000DEV01';
let n = 0;
const core = (): CommandCore => ({
  type: 'task.visit', commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R2' + String(++n).padStart(4, '0'), basis: { epoch: 'e1', rev: 1 },
  payload: { taskId: 'collect:o25', outcomeKey: 'customer_absent' }, recordedBy: { staffId: 'staff-3', sessionId: 'S' },
});

type Batch = (body: BatchRequest) => PostAnswer<BatchResponse> | Promise<PostAnswer<BatchResponse>>;

const applied = (commands: readonly QueuedEnvelope[], extra: Partial<BatchResponse> = {}): PostAnswer<BatchResponse> => ({
  kind: 'ok', status: 200, body: {
    epoch: 'e1', rev: 50, configRev: 1, linkRev: 1, serverTime: new Date(0).toISOString(), heartbeatMs: 20_000,
    results: commands.map((c): QueuedItemResult => ({ requestId: c.requestId, deviceSeq: c.deviceSeq, outcome: 'applied', rev: 50, reviews: [] })),
    device: { highWater: Math.max(0, ...commands.map((c) => c.deviceSeq)), missing: [] }, ...extra,
  },
});

async function setup(batch: Batch, items = 3, extra: { report?: () => Promise<import('@skinote/contract').DeviceReport>; onAnswerEpoch?: (answer: BatchResponse, queue: SendQueue, log: string[]) => Promise<void> } = {}) {
  const raw = new MemoryRawStore();
  const local = new LocalStore({ raw, deviceId: DEVICE });
  const queue = new SendQueue(local);
  for (let i = 0; i < items; i += 1) await queue.enqueue(core(), { createdWall: 1, createdMono: 1, pageAnchor: 'pageanchor12', offsetAtCreate: 0 }, { madeOffline: true });
  const timers = new ManualTimers();
  const log: string[] = [];
  const sizes: number[] = [];
  const drained: FlushResult[] = [];
  let clock = 0;
  const heartbeat: () => Promise<PostAnswer<HeartbeatResponse>> = async () => {
    log.push('heartbeat');
    return { kind: 'ok', status: 200, body: { epoch: 'e1', rev: 1, configRev: 1, linkRev: 1, heartbeatMs: 20_000, serverTime: new Date(0).toISOString(), currentBusinessDate: '2026-12-26', restoredUpToRev: null, policy: TEST_POLICY } };
  };
  const flusher = new Flusher({
    queue, appVersion: 'v1',
    sign: async (item: QueueItem) => ({ ...overlayEnvelope(item), deviceSeq: item.seq, ageMs: 0, clockAnchor: 'mono-pageanchor12', madeAt: new Date(0).toISOString(), recordedBy: { ...item.core.recordedBy, signature: 'x'.repeat(86) } }) as QueuedEnvelope,
    report: extra.report ?? (async () => ({ pendingCount: 0, unconfirmedCount: 0, lastSeq: 0, clockOffsetMs: 0, appVersion: 'v1', offlineCapable: false, localFirst: true, visibility: 'visible', unreadable: 0 })),
    postBatch: async (body) => { log.push('batch ' + body.commands.map((c) => (c as QueuedEnvelope).deviceSeq).join(',')); sizes.push(body.commands.length); return batch(body); },
    heartbeat,
    onHeartbeat: async () => {},
    onBatch: async () => {},
    ...(extra.onAnswerEpoch ? { onAnswerEpoch: (answer: BatchResponse) => extra.onAnswerEpoch!(answer, queue, log) } : {}),
    onDrained: (r) => { drained.push(r); },
    onChange: () => {},
    timers,
    random: () => 0.5,
    now: () => clock,
  });
  return { raw, queue, flusher, timers, log, sizes, drained, tick: (ms: number) => { clock += ms; } };
}

const states = async (queue: SendQueue) => (await queue.list()).items.map((i) => [i.seq, i.state]);

describe('보내기 차례', () => {
  it('연결마다 심장 박동부터, 기기 번호 차례의 묶음, 다 보내면 onDrained(끊긴 채 만든 것)', async () => {
    const t = await setup((body) => applied(body.commands as QueuedEnvelope[]));
    t.flusher.kick();
    await t.flusher.settle();
    expect(t.log).toEqual(['heartbeat', 'batch 1,2,3']);
    expect(await states(t.queue)).toEqual([[1, 'answered'], [2, 'answered'], [3, 'answered']]);
    expect(t.drained).toEqual([{ sent: 3, offlineMade: true, notApplied: 0 }]);
    // 다음 보내기는 같은 연결: 심장 박동 없이, 보낼 것이 없으면 아무것도.
    t.flusher.kick();
    await t.flusher.settle();
    expect(t.log).toEqual(['heartbeat', 'batch 1,2,3']);
  });

  it('묶음 크기: 5에서 시작해 빠른 답이면 두 배(50까지)', async () => {
    const t = await setup((body) => applied(body.commands as QueuedEnvelope[]), 18);
    t.flusher.kick();
    await t.flusher.settle();
    expect(t.sizes).toEqual([5, 10, 3]);
    expect(t.flusher.size).toBe(40);
  });
});

describe('실패', () => {
  it('답을 잃으면(시간 초과) 그 묶음은 결과 확인 중 · 크기 반 · 기다렸다 같은 번호로 다시(심장 박동부터)', async () => {
    let lose = true;
    const t = await setup((body) => {
      if (lose) { lose = false; return { kind: 'failed', offline: false }; }
      return applied(body.commands as QueuedEnvelope[]);
    });
    t.flusher.kick();
    await t.flusher.settle();
    expect(await states(t.queue)).toEqual([[1, 'unconfirmed'], [2, 'unconfirmed'], [3, 'unconfirmed']]);
    expect(t.flusher.size).toBe(2);
    expect(t.timers.size()).toBe(1);
    t.timers.advance(FLUSH.backoffMs[0]!);
    await t.flusher.settle();
    expect(t.log).toEqual(['heartbeat', 'batch 1,2,3', 'heartbeat', 'batch 1,2', 'batch 3']);
    expect(await states(t.queue)).toEqual([[1, 'answered'], [2, 'answered'], [3, 'answered']]);
  });

  it('보내기 전부터 네트워크 없음 · 409 BUSY · 429는 앞 상태로(결과 확인 중이 아님), 429는 retry-after만큼', async () => {
    const answers: PostAnswer<BatchResponse>[] = [{ kind: 'failed', offline: true }, { kind: 'status', status: 409, code: 'BUSY' }, { kind: 'status', status: 429, code: 'RATE_LIMITED', retryAfterMs: 7_000 }];
    const t = await setup((body) => answers.shift() ?? applied(body.commands as QueuedEnvelope[]));
    t.flusher.kick();
    await t.flusher.settle();
    expect(await states(t.queue)).toEqual([[1, 'queued'], [2, 'queued'], [3, 'queued']]);
    t.timers.advance(backoffDelay(1, () => 0.5));
    await t.flusher.settle();
    expect(await states(t.queue)).toEqual([[1, 'queued'], [2, 'queued'], [3, 'queued']]);
    t.timers.advance(backoffDelay(2, () => 0.5));
    await t.flusher.settle();
    expect(t.timers.size()).toBe(1);
    t.timers.advance(6_999);
    await t.flusher.settle();
    expect(await states(t.queue)).toEqual([[1, 'queued'], [2, 'queued'], [3, 'queued']]);
    t.timers.advance(1);
    await t.flusher.settle();
    expect(await states(t.queue)).toEqual([[1, 'answered'], [2, 'answered'], [3, 'answered']]);
  });

  it('400이면 하나씩, 혼자서도 400인 항목은 이 앱 판에서 건너뛰고 뒤의 것은 보낸다', async () => {
    const t = await setup((body) => {
      const cmds = body.commands as QueuedEnvelope[];
      if (cmds.some((c) => c.deviceSeq === 2)) return { kind: 'status', status: 400, code: 'BAD_INPUT' };
      return applied(cmds);
    });
    t.flusher.kick();
    await t.flusher.settle();
    expect(t.log).toEqual(['heartbeat', 'batch 1,2,3', 'batch 1', 'batch 2', 'batch 3']);
    const items = (await t.queue.list()).items;
    expect(items.map((i) => [i.seq, i.state, i.stuckVersion ?? null])).toEqual([[1, 'answered', null], [2, 'queued', 'v1'], [3, 'answered', null]]);
    // 막힌 항목만 남으면 다시 돌아도 보내지 않는다.
    t.flusher.kick();
    await t.flusher.settle();
    expect(t.log).toHaveLength(5);
  });

  it('서버가 빠졌다는 번호를 알리면 같은 번호로 다시 보낸다', async () => {
    let first = true;
    const t = await setup((body) => {
      const cmds = body.commands as QueuedEnvelope[];
      if (first) { first = false; return applied(cmds, { device: { highWater: 3, missing: [2] } }); }
      return applied(cmds);
    });
    t.flusher.kick();
    await t.flusher.settle();
    expect(t.log).toEqual(['heartbeat', 'batch 1,2,3', 'batch 2']);
  });

  it('묶음 답의 epoch를 결과 · 빠진 번호보다 먼저 본다(§17-4): 연결이 이어진 채 새로 만든 매장이 옛 번호를 빠졌다고 해도 옛 답을 다시 보내지 않는다', async () => {
    let epoch = 'e1';
    const t = await setup((body) => {
      const cmds = body.commands as QueuedEnvelope[];
      // 새로 만든 매장(e2)은 기기의 옛 번호 1을 받은 적이 없다고 알린다(이어진 끝이 없는 서버).
      return applied(cmds, { epoch, device: { highWater: Math.max(...cmds.map((c) => c.deviceSeq)), missing: epoch === 'e2' ? [1] : [] } });
    }, 1, {
      // DriverClient처럼: 새 epoch(복구 아님)면 옛 epoch의 답을 보낸 기록으로 옮긴다. 부를 때 보낸 항목은 아직 답을 받지 않았다.
      onAnswerEpoch: async (answer, queue, log) => {
        log.push('epoch ' + answer.epoch + ' ' + JSON.stringify(await states(queue)));
        await queue.settleOldEpoch(answer.epoch, 0);
      },
    });
    t.flusher.kick();
    await t.flusher.settle();
    expect(await states(t.queue)).toEqual([[1, 'answered']]);
    // 매장을 새로 만듦(연결은 이어져 심장 박동 없이 다음 묶음).
    epoch = 'e2';
    await t.queue.enqueue(core(), { createdWall: 1, createdMono: 1, pageAnchor: 'pageanchor12', offsetAtCreate: 0 }, { madeOffline: false });
    t.flusher.kick();
    await t.flusher.settle();
    expect(t.log).toEqual(['heartbeat', 'batch 1', 'epoch e1 [[1,"sending"]]', 'batch 2', 'epoch e2 [[1,"answered"],[2,"sending"]]']);
    expect(await states(t.queue)).toEqual([[2, 'answered']]);
    expect((await t.queue.sent()).map((r) => [r.seq, r.epoch])).toEqual([[1, 'e1']]);
  });

  it('기다림은 2 · 4 · 8 · 16 · 30초(±20%)이고 30초에서 멈춘다', () => {
    expect([1, 2, 3, 4, 5, 9].map((f) => backoffDelay(f, () => 0.5))).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(backoffDelay(1, () => 0)).toBe(1_600);
    expect(backoffDelay(1, () => 1)).toBe(2_400);
  });
});

describe('다 보낼 때까지(drain)', () => {
  it('보낼 수 있으면 0, 막힌 항목만 남으면 그 수(기다리지 않음)', async () => {
    const ok = await setup((body) => applied(body.commands as QueuedEnvelope[]));
    expect(await ok.flusher.drain(1_000)).toBe(0);
    const stuck = await setup(() => ({ kind: 'status', status: 400, code: 'BAD_INPUT' }), 1);
    expect(await stuck.flusher.drain(1_000)).toBe(1);
  });

  it('닿지 않는 서버: 시간 안에 남은 수를 돌려준다', async () => {
    const t = await setup(() => ({ kind: 'failed', offline: true }), 2);
    expect(await t.flusher.drain(30)).toBe(2);
  });
});

describe('SEQ_REUSED(O9)', () => {
  it('서버가 받은 가장 큰 번호를 먼저 적고, 그 위의 새 번호로 다시 보낸다', async () => {
    let first = true;
    const t = await setup((body) => {
      const cmds = body.commands as QueuedEnvelope[];
      if (first) {
        first = false;
        const ok = applied(cmds, { device: { highWater: 10, missing: [] } });
        if (ok.kind === 'ok') ok.body.results[0] = { ...ok.body.results[0]!, outcome: 'rejected', error: { code: 'SEQ_REUSED', message: '' } };
        return ok;
      }
      return applied(cmds, { device: { highWater: 11, missing: [] } });
    }, 2);
    t.flusher.kick();
    await t.flusher.settle();
    expect(t.log).toEqual(['heartbeat', 'batch 1,2', 'batch 11']);
    expect(await states(t.queue)).toEqual([[2, 'answered'], [11, 'answered']]);
  });
});

describe('보내던 칸이 남지 않는다(§17 R3-6)', () => {
  const baseReport = { pendingCount: 0, unconfirmedCount: 0, lastSeq: 0, clockOffsetMs: 0, appVersion: 'v1', offlineCapable: false, localFirst: true, visibility: 'visible' as const, unreadable: 0 };

  it('기기 알림 읽기가 한 번 던지면 칸은 앞 상태로 남고(보내는 중이 아님) 다음 보내기가 보낸다', async () => {
    let calls = 0;
    const t = await setup((body) => applied(body.commands as QueuedEnvelope[]), 2, {
      report: async () => { calls += 1; if (calls === 1) throw new DOMException('transient', 'UnknownError'); return baseReport; },
    });
    t.flusher.kick();
    await t.flusher.settle();
    expect(await states(t.queue)).toEqual([[1, 'queued'], [2, 'queued']]);
    expect(t.log).toEqual(['heartbeat']);
    t.timers.advance(3_000);
    await t.flusher.settle();
    expect(await states(t.queue)).toEqual([[1, 'answered'], [2, 'answered']]);
  });

  it('보내기를 시작한 뒤 던지면(서버에 닿았을 수 있음) 결과 확인 중으로, 같은 번호로 다시 보낸다', async () => {
    let first = true;
    const t = await setup((body) => {
      if (first) { first = false; throw new Error('boom after send'); }
      return applied(body.commands as QueuedEnvelope[]);
    }, 1);
    t.flusher.kick();
    await t.flusher.settle();
    expect(await states(t.queue)).toEqual([[1, 'unconfirmed']]);
    t.timers.advance(3_000);
    await t.flusher.settle();
    expect(await states(t.queue)).toEqual([[1, 'answered']]);
  });
});

describe('네 번째 검토(§18)', () => {
  const internal = (commands: readonly QueuedEnvelope[], keep: (seq: number) => boolean = () => true): PostAnswer<BatchResponse> => ({
    kind: 'ok', status: 200, body: {
      epoch: 'e1', rev: 50, configRev: 1, linkRev: 1, serverTime: new Date(0).toISOString(), heartbeatMs: 20_000,
      results: commands.map((c): QueuedItemResult => (keep(c.deviceSeq)
        ? { requestId: c.requestId, deviceSeq: c.deviceSeq, outcome: 'rejected', rev: 50, error: { code: 'INTERNAL', message: '처리 실패 · 재시도 필요' }, reviews: [] }
        : { requestId: c.requestId, deviceSeq: c.deviceSeq, outcome: 'applied', rev: 50, reviews: [] })),
      device: { highWater: 0, missing: [] },
    },
  });

  it('R4-2: a per-item INTERNAL answer is a failure with backoff — one post per try, a timer between tries (no tight loop)', async () => {
    let posts = 0;
    const t = await setup((body) => { posts += 1; if (posts > 50) t.flusher.stop(); return internal(body.commands as QueuedEnvelope[]); }, 1);
    t.flusher.kick();
    await t.flusher.settle();
    expect(posts).toBe(1);
    expect(t.timers.size()).toBe(1);
    expect(t.flusher.failures).toBe(1);
    expect(await states(t.queue)).toEqual([[1, 'queued']]);
    t.timers.advance(3_000);
    await t.flusher.settle();
    expect(posts).toBe(2);
    expect(t.flusher.failures).toBe(2);
  });

  it('R4-2: items after an INTERNAL item still go out in the same try, then the loop waits', async () => {
    let posts = 0;
    const t = await setup((body) => { posts += 1; return internal(body.commands as QueuedEnvelope[], (seq) => seq === 1); }, 3);
    t.flusher.kick();
    await t.flusher.settle();
    expect(await states(t.queue)).toEqual([[1, 'queued'], [2, 'answered'], [3, 'answered']]);
    expect(posts).toBe(1);
    expect(t.timers.size()).toBe(1);
  });

  it('R4-2: drain answers by its deadline even while a send never finishes', async () => {
    const t = await setup(() => new Promise<PostAnswer<BatchResponse>>(() => {}), 1);
    const started = Date.now();
    const left = await t.flusher.drain(60);
    expect(left).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    t.flusher.stop();
  });

  it('R4-6: a row left `sending` by a page that died mid-post is re-sent by the page that holds the flush lock (unconfirmed, same number)', async () => {
    const t = await setup((body) => applied(body.commands as QueuedEnvelope[]), 1);
    const { items } = await t.queue.list();
    // 닫힌 화면이 보내는 중으로 바꾸고 보내다 죽었다.
    await t.queue.setState(items.map((i) => i.requestId), 'sending');
    t.flusher.kick();
    await t.flusher.settle();
    expect(t.log).toEqual(['heartbeat', 'batch 1']);
    expect(await states(t.queue)).toEqual([[1, 'answered']]);
    expect(await t.flusher.drain(50)).toBe(0);
  });
});

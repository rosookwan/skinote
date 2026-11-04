// 사본 받기(work/impl-offline/plan.md O4 · O20, §7-9 snapshots.test): 한 번에 하나 · 도는 동안 온 요청은 하나로, 2초 간격, 옛 사본 · 옛 unchanged는
// 새것을 덮지 않음, 항목은 recorded에 들 때만 보냄 대기를 떠남, 새 epoch는 되돌리기 뒤에, 지운 사본은 known 없이, 같은 사본 + 새 설정.
import { defaultUiConfig, type SnapshotRequest, type SnapshotResponse } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import type { PostAnswer } from '../src/app/http-client.ts';
import { LocalStore } from '../src/local/local-store.ts';
import { SendQueue, type CommandCore } from '../src/local/queue.ts';
import { MemoryRawStore } from '../src/local/raw-store.ts';
import { compareCopy, SnapshotSync } from '../src/local/snapshots.ts';
import { ManualTimers, TEST_POLICY } from './fake-server.ts';
import { copyBody } from './local-helpers.ts';

const DEVICE = '01JF00000000000000000DEV01';
let n = 0;
const core = (): CommandCore => ({
  type: 'task.visit', commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R3' + String(++n).padStart(4, '0'), basis: { epoch: 'e1', rev: 1 },
  payload: { taskId: 'collect:o25', outcomeKey: 'customer_absent' }, recordedBy: { staffId: 'staff-3', sessionId: 'S' },
});

function response(extra: Partial<SnapshotResponse> = {}): SnapshotResponse {
  const body = copyBody();
  return {
    epoch: '01JF000000000000000000EP01', rev: 50, configRev: 1, linkRev: 1, serverTime: new Date(0).toISOString(), currentBusinessDate: '2026-12-26', restoredUpToRev: null,
    policy: TEST_POLICY, scope: { vehicleId: 'v1', businessDate: '2026-12-26', cutoff: '06:00' }, hash: 'A'.repeat(43), unchanged: false,
    state: body.state as unknown as Record<string, unknown>, config: body.config, recorded: [], recordedMore: false, onlineRecorded: [],
    device: { highWater: 0, missing: [] }, ...extra,
  };
}

function setup(answer: (body: SnapshotRequest) => SnapshotResponse | Promise<SnapshotResponse> | PostAnswer<SnapshotResponse>) {
  const raw = new MemoryRawStore();
  const local = new LocalStore({ raw, deviceId: DEVICE });
  const queue = new SendQueue(local);
  const timers = new ManualTimers();
  const bodies: SnapshotRequest[] = [];
  const restores: [string, number | null][] = [];
  let wall = 10_000;
  let hold: (() => void) | null = null;
  let holding = false;
  const sync = new SnapshotSync({
    local, queue, appVersion: 'v1',
    post: async (body) => {
      bodies.push(body);
      if (holding) await new Promise<void>((resolve) => { hold = resolve; });
      const out = await answer(body);
      return 'kind' in out ? out : { kind: 'ok', status: 200, body: out };
    },
    report: async () => ({ pendingCount: 0, unconfirmedCount: 0, lastSeq: 0, clockOffsetMs: 0, appVersion: 'v1', offlineCapable: false, localFirst: true, visibility: 'visible', unreadable: 0 }),
    onlinePending: async () => [],
    onStored: () => {},
    onEpoch: async (epoch, upTo) => { restores.push([epoch, upTo]); },
    timers, wallNow: () => wall,
  });
  return {
    raw, local, queue, sync, timers, bodies, restores,
    hold: () => { holding = true; },
    release: () => { holding = false; hold?.(); },
    advance: (ms: number) => { wall += ms; timers.advance(ms); },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('한 번에 하나', () => {
  it('도는 동안 온 요청들은 하나로 묶여 끝난 뒤 2초 뒤에 한 번, urgent면 곧바로', async () => {
    const t = setup(() => response());
    t.hold();
    const first = t.sync.request(true);
    await flush();
    const a = t.sync.request();
    const b = t.sync.request();
    expect(t.bodies).toHaveLength(1);
    t.release();
    await first;
    await flush();
    expect(t.bodies).toHaveLength(1);
    t.advance(1_999);
    await flush();
    expect(t.bodies).toHaveLength(1);
    t.advance(1);
    await Promise.all([a, b]);
    expect(t.bodies).toHaveLength(2);
    // 두 번째는 받은 사본을 known으로 알린다.
    expect(t.bodies[1]!.known).toMatchObject({ epoch: '01JF000000000000000000EP01', rev: 50, hash: 'A'.repeat(43), configRev: 1 });
    await t.sync.request(true);
    expect(t.bodies).toHaveLength(3);
  });
});

describe('차례와 저장', () => {
  it('가진 것보다 옛 사본 · 옛 unchanged 답은 새것을 덮지 않는다', async () => {
    const answers = [response({ rev: 50 }), response({ rev: 40 }), response({ rev: 45, unchanged: true, state: undefined })];
    const t = setup(() => answers.shift()!);
    await t.sync.request(true);
    await t.sync.request(true);
    await t.sync.request(true);
    expect((await t.local.copyHead())?.rev).toBe(50);
    expect(compareCopy({ epoch: 'e2', rev: 1 }, { epoch: 'e1', rev: 99 })).toBeGreaterThan(0);
  });

  it('보냄 대기 항목은 사본의 recorded에 든 것만 떠난다(답을 받았어도 recorded에 없으면 겹쳐 둔다)', async () => {
    const t = setup(() => response());
    const a = core();
    const b = core();
    await t.queue.enqueue(a, { createdWall: 1, createdMono: 1, pageAnchor: 'pageanchor12', offsetAtCreate: 0 }, { madeOffline: true });
    await t.queue.enqueue(b, { createdWall: 1, createdMono: 1, pageAnchor: 'pageanchor12', offsetAtCreate: 0 }, { madeOffline: true });
    await t.queue.answer([{ requestId: a.requestId, deviceSeq: 1, outcome: 'applied', rev: 49, reviews: [] }, { requestId: b.requestId, deviceSeq: 2, outcome: 'applied', rev: 51, reviews: [] }], 'e', 1, 'v1');
    const answers = [response({ recorded: [{ requestId: a.requestId, deviceSeq: 1, outcome: 'applied', rev: 49, reviews: [] }] })];
    // 같은 저장소로 한 번 받기(이 시험의 답).
    const bodies: SnapshotRequest[] = [];
    const own = new SnapshotSync({
      local: t.local, queue: t.queue, appVersion: 'v1',
      post: async (body) => { bodies.push(body); return { kind: 'ok', status: 200, body: answers.shift() ?? response() }; },
      report: async () => ({ pendingCount: 0, unconfirmedCount: 0, lastSeq: 2, clockOffsetMs: 0, appVersion: 'v1', offlineCapable: false, localFirst: true, visibility: 'visible', unreadable: 0 }),
      onlinePending: async () => [], onStored: () => {}, onEpoch: async () => {}, timers: t.timers,
    });
    await own.request(true);
    expect(bodies[0]).toMatchObject({ fromSeq: 1, pendingTaskIds: ['collect:o25'] });
    expect((await t.queue.list()).items.map((i) => i.requestId)).toEqual([b.requestId]);
    expect((await t.queue.sent()).map((s) => s.requestId)).toEqual([a.requestId]);
  });

  it('받은 사본의 epoch를 쓰기 전에 늘 알린다(사본이 없어도, 복구 기준과 함께): 부르는 쪽이 기기 메모의 epoch와 견준다(§17 R3-3)', async () => {
    const answers = [response({ epoch: '01JF000000000000000000EP01', rev: 50 }), response({ epoch: '01JF000000000000000000EP02', rev: 30, restoredUpToRev: 44 })];
    const t = setup(() => answers.shift()!);
    await t.sync.request(true);
    await t.sync.request(true);
    expect(t.restores).toEqual([['01JF000000000000000000EP01', null], ['01JF000000000000000000EP02', 44]]);
    expect(await t.local.copyHead()).toMatchObject({ epoch: '01JF000000000000000000EP02', rev: 30, restoredUpToRev: 44 });
  });

  it('같은 사본(unchanged)은 머리만 바꾸고, 새 화면 설정이 오면 본문을 다시 쓴다', async () => {
    const config2 = { ...defaultUiConfig({ shopName: '새 이름', timezone: 'Asia/Seoul' }), configRev: 2 };
    const answers = [response(), response({ rev: 55, unchanged: true, state: undefined, config: undefined }), response({ rev: 56, unchanged: true, state: undefined, config: config2, configRev: 2 })];
    const t = setup(() => answers.shift()!);
    await t.sync.request(true);
    const firstKey = (await t.local.keys.currentCopyKey())!.id;
    await t.sync.request(true);
    expect((await t.local.copyHead())?.rev).toBe(55);
    expect((await t.local.keys.currentCopyKey())!.id).toBe(firstKey);
    await t.sync.request(true);
    const read = await t.local.readCopy();
    expect(read.status === 'ok' && read.body.config.shopName).toBe('새 이름');
    expect(read.status === 'ok' && read.head.rev).toBe(56);
  });

  it('24시간 지움을 한 사본은 known 없이 받는다(통째로)', async () => {
    const t = setup(() => response());
    await t.sync.request(true);
    await t.local.touchCopy({ scrubbed: true });
    await t.sync.request(true);
    expect(t.bodies[1]!.known).toBeUndefined();
    expect((await t.local.copyHead())?.scrubbed).toBe(false);
  });

  it('실패한 받기는 아무것도 바꾸지 않는다', async () => {
    const t = setup(() => ({ kind: 'failed', offline: false }));
    await t.sync.request(true);
    expect(await t.local.copyHead()).toBeNull();
  });
});

describe('네 번째 검토(§18)', () => {
  it('R4-5: 대기 업무 id는 답을 받지 않은 항목의 것이 먼저(서버가 알린 대기 수로 자를 때 아직 보내지 못한 팀이 남게)', async () => {
    const t = setup(() => response());
    const mk = (taskId: string): CommandCore => ({ ...core(), payload: { taskId, outcomeKey: 'customer_absent' } });
    const clock = { createdWall: 1, createdMono: 1, pageAnchor: 'pageanchor12', offsetAtCreate: 0 };
    const first = await t.queue.enqueue(mk('collect:o25'), clock, { madeOffline: true });
    await t.queue.enqueue(mk('collect:o29'), clock, { madeOffline: true });
    if (first.kind !== 'queued') throw new Error('not queued');
    await t.queue.answer([{ requestId: first.item.requestId, deviceSeq: first.item.seq, outcome: 'applied', rev: 11, reviews: [] }], 'e1', 5, 'v1');
    await t.sync.request(true);
    expect(t.bodies[0]!.pendingTaskIds).toEqual(['collect:o29', 'collect:o25']);
  });
});

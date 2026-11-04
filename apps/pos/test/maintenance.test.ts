// 지움 시계(work/impl-offline/plan.md O14, §7-9 maintenance.test): 마지막 연결 24시간 뒤 이름 · 전화를 비움(끝 4자리 · 보냄 대기는 남고 사본 열쇠가
// 바뀜), 06:00 넘기기는 끝난 접수를 빼되 보냄 대기 항목의 접수는 남김, 벽시계가 뒤로 가면 비움, 보낸 기록 정리.
import { defaultUiConfig, envelopeFor, openCommandDraft, type ConfirmCommand, type Expect } from '@skinote/contract';
import { applyCommand, runQuery, sampleDay, vehicleScope, type ShopState } from '@skinote/domain';
import { describe, expect, it } from 'vitest';
import { LocalStore } from '../src/local/local-store.ts';
import { Maintenance, scrubState } from '../src/local/maintenance.ts';
import { SendQueue } from '../src/local/queue.ts';
import { MemoryRawStore } from '../src/local/raw-store.ts';
import { at, TEST_POLICY } from './fake-server.ts';
import { copyHead } from './local-helpers.ts';

const DEVICE = '01JF00000000000000000DEV01';
const HOUR = 3_600_000;
const config = defaultUiConfig({ shopName: '시험 매장', timezone: 'Asia/Seoul' });

function run(s: ShopState, view: { basis: { epoch: string; rev: number }; command?: ConfirmCommand; expect?: Expect }, now: number): void {
  const envelope = envelopeFor(openCommandDraft(view.command!, view.basis, view.expect ? { expect: view.expect } : {}), view.command, view.expect)!;
  expect(applyCommand(s, envelope, now).outcome).toBe('applied');
}

/** 김민수(o25) · 이도윤(o29)을 수거하고 매장 입고까지 한 1호 차량의 사본(두 팀의 업무가 끝남). */
function finishedCopy(): ShopState {
  const s = sampleDay({ date: '2026-12-26', epoch: 'e1', ids: 'demo' });
  const ctx = { config, now: at(22, 0) };
  for (const id of ['o25', 'o29']) run(s, runQuery(s, 'confirmDraft', { actionKey: 'stamp.collect', taskId: 'collect:' + id, orderId: id }, ctx), at(22, 0));
  run(s, runQuery(s, 'confirmDraft', { actionKey: 'receive_to_shop', vehicleId: 'v1' }, ctx), at(22, 30));
  return vehicleScope(s, 'v1', { staffId: 'staff-3' });
}

async function setup(state: ShopState, lastContactAt: number) {
  const raw = new MemoryRawStore();
  const local = new LocalStore({ raw, deviceId: DEVICE });
  const queue = new SendQueue(local);
  await local.writeCopy(copyHead({ storedAt: lastContactAt }), { state, config });
  await local.patchMeta({ lastContactAt, maxSeenWall: lastContactAt });
  let wall = lastContactAt;
  const m = new Maintenance({ local, queue, staffId: 'staff-3', wallNow: () => wall, serverNow: () => wall, policy: () => TEST_POLICY });
  return { raw, local, queue, m, set: (ms: number) => { wall = ms; } };
}

describe('이름 · 전화 지움(O14 a)', () => {
  it('마지막 연결 24시간 뒤: 이름 · 전화 · 메모를 비우고 끝 4자리는 남긴다 · 새 사본 열쇠 · 보냄 대기는 그대로', async () => {
    const t = await setup(vehicleScope(sampleDay({ date: '2026-12-26', epoch: 'e1', ids: 'demo' }), 'v1', { staffId: 'staff-3' }), at(22, 0));
    await t.queue.enqueue({ type: 'task.visit', commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R4C0DM', basis: { epoch: 'e1', rev: 1 }, payload: { taskId: 'collect:o29', outcomeKey: 'customer_absent' }, recordedBy: { staffId: 'staff-3', sessionId: 'S' } },
      { createdWall: 1, createdMono: 1, pageAnchor: 'pageanchor12', offsetAtCreate: 0 }, { madeOffline: true });
    const keyBefore = (await t.local.keys.currentCopyKey())!.id;
    t.set(at(21, 59, 1));
    expect((await t.m.run()).scrubbed).toBe(false);
    t.set(at(22, 0, 1));
    const out = await t.m.run();
    expect(out.scrubbed).toBe(true);
    const read = await t.local.readCopy();
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(read.head.scrubbed).toBe(true);
    const o25 = read.body.state.orders.find((o) => o.id === 'o25')!;
    expect([o25.teamName, o25.phone, o25.last4]).toEqual(['', '', '0025']);
    expect(JSON.stringify(read.body.state.orders)).not.toMatch(/010-0000/);
    expect((await t.local.keys.currentCopyKey())!.id).not.toBe(keyBefore);
    expect(await t.local.keys.key(keyBefore)).toBeNull();
    expect((await t.queue.list()).items).toHaveLength(1);
    // 한 번 지운 사본은 다시 지우지 않는다.
    expect((await t.m.run()).scrubbed).toBe(false);
  });

  it('벽시계가 뒤로 가면(톱니) 기억한 세션을 믿지 않고 이름 · 전화를 비운다', async () => {
    const t = await setup(vehicleScope(sampleDay({ date: '2026-12-26', epoch: 'e1', ids: 'demo' }), 'v1', { staffId: 'staff-3' }), at(22, 0));
    t.set(at(22, 30));
    expect(await t.m.run()).toMatchObject({ wentBack: false, scrubbed: false });
    t.set(at(22, 10));
    expect(await t.m.run()).toMatchObject({ wentBack: true, scrubbed: true });
  });

  it('scrubState는 입력을 고치지 않는다', () => {
    const s = vehicleScope(sampleDay({ date: '2026-12-26', epoch: 'e1', ids: 'demo' }), 'v1', { staffId: 'staff-3' });
    const out = scrubState(s);
    expect(s.orders[0]!.teamName).not.toBe('');
    expect(out.orders[0]!.teamName).toBe('');
  });
});

describe('06:00 넘기기(O14 b)', () => {
  it('끝난 접수는 빠지고, 보냄 대기 항목이 가리키는 접수는 남는다', async () => {
    const state = finishedCopy();
    expect(state.orders.map((o) => o.id)).toEqual(expect.arrayContaining(['o25', 'o29']));
    const t = await setup(state, at(22, 40));
    await t.queue.enqueue({ type: 'task.visit', commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R4C0DN', basis: { epoch: 'e1', rev: 1 }, payload: { taskId: 'collect:o29', outcomeKey: 'customer_absent' }, recordedBy: { staffId: 'staff-3', sessionId: 'S' } },
      { createdWall: 1, createdMono: 1, pageAnchor: 'pageanchor12', offsetAtCreate: 0 }, { madeOffline: true });
    t.set(at(5, 59, 1));
    expect((await t.m.run()).rolledTo).toBeUndefined();
    t.set(at(6, 1, 1));
    expect((await t.m.run()).rolledTo).toBe('2026-12-27');
    const read = await t.local.readCopy();
    if (read.status !== 'ok') throw new Error(read.status);
    const ids = read.body.state.orders.map((o) => o.id);
    expect(ids).not.toContain('o25');
    expect(ids).toContain('o29');
    expect(read.head.businessDate).toBe('2026-12-27');
    expect(read.body.state.businessDate).toBe('2026-12-27');
  });
});

describe('보낸 기록(O14 f)', () => {
  it('지움 시계가 보낸 기록을 정리한다(보냄 대기는 건드리지 않음)', async () => {
    const t = await setup(vehicleScope(sampleDay({ date: '2026-12-26', epoch: 'e1', ids: 'demo' }), 'v1', { staffId: 'staff-3' }), at(22, 0));
    const a = { type: 'task.visit' as const, commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R4C0DP', basis: { epoch: 'e1', rev: 1 }, payload: { taskId: 'collect:o29', outcomeKey: 'customer_absent' }, recordedBy: { staffId: 'staff-3', sessionId: 'S' } };
    await t.queue.enqueue(a, { createdWall: 1, createdMono: 1, pageAnchor: 'pageanchor12', offsetAtCreate: 0 }, { madeOffline: true });
    await t.local.touchCopy({}, (tx) => t.queue.settleInTx(tx, [{ requestId: a.requestId, deviceSeq: 1, outcome: 'applied', rev: 1, reviews: [] }], 'e1', at(22, 0)));
    t.set(at(22, 0) + 8 * 24 * HOUR);
    const out = await t.m.run();
    expect(out.removedSent).toBe(1);
    expect(await t.queue.sent()).toHaveLength(0);
  });
});

describe('지움 시계와 사본 받기가 겹칠 때', () => {
  it('읽은 뒤 새 사본이 왔으면 옛 본문으로 덮지 않는다(다음 분에 다시)', async () => {
    const t = await setup(vehicleScope(sampleDay({ date: '2026-12-26', epoch: 'e1', ids: 'demo' }), 'v1', { staffId: 'staff-3' }), at(22, 0));
    const fresh = vehicleScope(sampleDay({ date: '2026-12-26', epoch: 'e1', ids: 'demo' }), 'v1', { staffId: 'staff-3' });
    // 지움 시계가 사본을 읽는 사이 새 사본(rev 11)이 쓰인 것처럼: 먼저 읽힌 머리와 다르게 만든다.
    const readCopy = t.local.readCopy.bind(t.local);
    t.local.readCopy = async () => {
      const read = await readCopy();
      await t.local.writeCopy(copyHead({ rev: 11, storedAt: at(22, 0) }), { state: fresh, config });
      return read;
    };
    t.set(at(22, 30, 1));
    const out = await t.m.run();
    expect(out.scrubbed).toBe(false);
    const now = await readCopy();
    expect(now.status === 'ok' && now.head.rev).toBe(11);
    expect(now.status === 'ok' && now.head.scrubbed).toBe(false);
  });
});

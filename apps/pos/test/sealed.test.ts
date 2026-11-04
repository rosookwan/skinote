// 봉인 · 두 열쇠(work/impl-offline/plan.md O13, §7-9 sealed.test): 되돌림, 자리(AAD)에 묶임, 다른 열쇠, 사본을 쓸 때마다 새 사본 열쇠로 다시 봉인하고 옛
// 열쇠를 지움, 기억한 세션도 새 열쇠로, 로그아웃 지움은 보냄 대기 열쇠를 남김, 열 수 없는 칸은 센다.
import { describe, expect, it } from 'vitest';
import { LocalStore } from '../src/local/local-store.ts';
import { SendQueue } from '../src/local/queue.ts';
import { MemoryRawStore } from '../src/local/raw-store.ts';
import { newSealKey, seal, sealContext, unseal, Unreadable } from '../src/local/sealed.ts';
import { copyBody, copyHead } from './local-helpers.ts';

const DEVICE = '01JF00000000000000000DEV01';

const body = copyBody;

describe('seal · unseal', () => {
  it('되돌리고, 다른 자리 · 다른 열쇠 · 깨진 값은 Unreadable', async () => {
    const key = await newSealKey();
    const other = await newSealKey();
    const sealed = await seal(key, 'k1', sealContext('command', 'r1', 'k1'), { a: '김민수', n: 35_000 });
    expect(sealed.iv).toHaveLength(12);
    expect(await unseal(key, sealed, sealContext('command', 'r1', 'k1'))).toEqual({ a: '김민수', n: 35_000 });
    await expect(unseal(key, sealed, sealContext('command', 'r2', 'k1'))).rejects.toBeInstanceOf(Unreadable);
    await expect(unseal(other, sealed, sealContext('command', 'r1', 'k1'))).rejects.toBeInstanceOf(Unreadable);
    const broken = { ...sealed, body: sealed.body.slice(0, -1) };
    await expect(unseal(key, broken, sealContext('command', 'r1', 'k1'))).rejects.toBeInstanceOf(Unreadable);
    // 봉인한 글에 평문이 보이지 않는다.
    expect(new TextDecoder().decode(sealed.body)).not.toContain('김민수');
  });
});

describe('두 열쇠(O13)', () => {
  it('사본을 쓸 때마다 새 사본 열쇠로 봉인하고 옛 사본 열쇠를 지운다 · 기억한 세션도 새 열쇠로 다시 봉인한다', async () => {
    const raw = new MemoryRawStore();
    const local = new LocalStore({ raw, deviceId: DEVICE });
    await local.writeCopy(copyHead(), body());
    const first = (await local.keys.list()).filter((k) => k.kind === 'copy');
    expect(first).toHaveLength(1);
    // 기억한 세션(다음 단계가 쓴다)을 지금 사본 열쇠로 넣어 둔다.
    const sealed = await seal(first[0]!.key, first[0]!.id, sealContext('session', 'current', first[0]!.id), { staff: '문태오' });
    raw.poke('session', { id: 'current', ...sealed });
    await local.writeCopy(copyHead({ rev: 11 }), body());
    const second = (await local.keys.list()).filter((k) => k.kind === 'copy');
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(first[0]!.id);
    const read = await local.readCopy();
    expect(read.status).toBe('ok');
    expect(read.status === 'ok' && read.head.rev).toBe(11);
    const session = raw.peek('session', 'current')!;
    expect(session.keyId).toBe(second[0]!.id);
    expect(await unseal(second[0]!.key, session as never, sealContext('session', 'current', second[0]!.id))).toEqual({ staff: '문태오' });
    // 옛 열쇠의 봉인(지운 열쇠)은 누구도 열 수 없다.
    expect(await local.keys.key(first[0]!.id)).toBeNull();
  });

  it('사본 지움(로그아웃)은 사본 · 세션 · 사본 열쇠만: 보냄 대기 열쇠와 보냄 대기는 남아 읽힌다', async () => {
    const raw = new MemoryRawStore();
    const local = new LocalStore({ raw, deviceId: DEVICE });
    const queue = new SendQueue(local);
    await local.writeCopy(copyHead(), body());
    const core = { type: 'task.visit' as const, commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R1C0DM', basis: { epoch: 'e1', rev: 10 }, payload: { taskId: 'collect:o29', outcomeKey: 'customer_absent' }, recordedBy: { staffId: 'staff-3', sessionId: 'S1' } };
    await queue.enqueue(core, { createdWall: 1, createdMono: 1, pageAnchor: 'abcdefgh1234', offsetAtCreate: 0 }, { madeOffline: true });
    await local.dropCopy();
    expect((await local.readCopy()).status).toBe('none');
    expect((await local.keys.list()).map((k) => k.kind)).toEqual(['queue']);
    const listed = await queue.list();
    expect(listed.unreadable).toBe(0);
    expect(listed.items.map((i) => i.core.payload)).toEqual([{ taskId: 'collect:o29', outcomeKey: 'customer_absent' }]);
  });

  it('열 수 없는 칸(지운 열쇠 · 모르는 판)은 조용히 건너뛰지 않고 센다', async () => {
    const raw = new MemoryRawStore();
    const local = new LocalStore({ raw, deviceId: DEVICE });
    const queue = new SendQueue(local);
    const core = { type: 'task.visit' as const, commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R1C0DM', basis: { epoch: 'e1', rev: 10 }, payload: { taskId: 'collect:o29', outcomeKey: 'customer_absent' }, recordedBy: { staffId: 'staff-3', sessionId: 'S1' } };
    await queue.enqueue(core, { createdWall: 1, createdMono: 1, pageAnchor: 'abcdefgh1234', offsetAtCreate: 0 }, { madeOffline: true });
    const rec = raw.peek('queue', core.requestId)!;
    raw.poke('queue', { ...rec, requestId: '01JF3Q8W2Z6N9XK4T7B5R1C0DN', keyId: 'queue:gone' });
    raw.poke('queue', { ...rec, requestId: '01JF3Q8W2Z6N9XK4T7B5R1C0DP', fmt: 9 });
    const listed = await queue.list();
    expect(listed.items).toHaveLength(1);
    expect(listed.unreadable).toBe(2);
  });

  it('모르는 사본 형식 · 상태 판은 그리지 않는다(format), 열쇠가 없으면 unreadable', async () => {
    const raw = new MemoryRawStore();
    const local = new LocalStore({ raw, deviceId: DEVICE });
    await local.writeCopy(copyHead(), body());
    const rec = raw.peek('snapshot', 'copy')!;
    raw.poke('snapshot', { ...rec, stateVersion: 0 });
    expect((await local.readCopy()).status).toBe('format');
    raw.poke('snapshot', { ...rec, keyId: 'copy:gone' });
    expect((await local.readCopy()).status).toBe('unreadable');
  });
});

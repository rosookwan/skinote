// 세 번째 검토(work/impl-offline/plan.md §17, 2026-09-28)의 기사 기기 쪽 — DriverClient와 가짜 서버:
//   - R3-1: 시험 매장 새로 만들기(새 epoch, restoredUpToRev null)는 옛 보낸 기록을 새 매장에 다시 보내지 않는다. 복구(수)는 다시 보낸다.
//   - R3-3: 로그아웃으로 사본이 없어도 기기 메모의 epoch로 복구를 알아 옛 기록을 다시 보낸다.
//   - §17-4: 연결이 이어진 채 매장이 바뀌면 묶음의 답이 epoch를 먼저 정한다(새로 만든 매장이 빠졌다고 알린 옛 번호를 다시 보내지 않고, 복구면 곧바로 보낸다).
//   - R3-4: 끊은 기기의 지움은 저장소를 본다(다른 화면이 넣은 기록을 지우지 않고 먼저 전달한다).
//   - R3-5: 두 화면의 답을 잃은 온라인 명령이 서로 덮지 않는다. 다시 보낸 답이 거절이면 띠에 한 줄.
//   - R3-7 · R3-11 · R3-24: 확인 값이 없으면 켤 때 잠금(온라인 로그인), 기사 역할만 확인 값, 서버에 닿지 못한 로그아웃의 표시, 다섯 번마다 시각까지 잠김.
//   - R3-9: 세션 끝(401)에 보낼 것이 남아도 사본은 지우고 보냄 대기는 남긴다. DriverClient가 돌지 않을 때(서버 묻기의 로그아웃 상태 · 끊은 기기)도.
//   - 앱 시작의 잠금(R3-7): 서버가 세션을 주어도 방금 비밀번호로 로그인한 것이 아니면 잠금 때인지 본다(startLock), 서버에 닿지 못한 로그아웃의 세션은
//     열지 않고 먼저 서버 로그아웃(pendingSignOut).
import { API_V2, envelopeFor, openCommandDraft, type AnyCommandEnvelope, type ConfirmCommand, type Expect, type SessionInfo } from '@skinote/contract';
import { sampleDay } from '@skinote/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthApi } from '../src/app/auth-api.ts';
import { HttpClient } from '../src/app/http-client.ts';
import { lockNeedsServer, startLock } from '../src/app/session.tsx';
import { localWords } from '../src/app/strings.ts';
import { DriverClient } from '../src/local/driver-client.ts';
import { LocalStore, MemoryChannelHub, PageLocks, type Channel } from '../src/local/local-store.ts';
import { MemoryRawStore } from '../src/local/raw-store.ts';
import { REMEMBERED_ID, VERIFIER_ID } from '../src/local/remembered.ts';
import { clearLocalAfterSignOut, pendingSignOut } from '../src/local/start.ts';
import { at, BASE, DATE, FakeServer, ManualTimers, ORIGIN, TestClocks } from './fake-server.ts';

const opened: DriverClient[] = [];
afterEach(() => { for (const c of opened.splice(0)) c.close(); });

interface World {
  server: FakeServer;
  clocks: TestClocks;
  timers: ManualTimers;
  raw: MemoryRawStore;
  pair: CryptoKeyPair;
  deviceId: string;
  session: SessionInfo;
  lost: string[];
  locks: PageLocks;
}

async function world(staffId = 'staff-3'): Promise<World> {
  const clocks = new TestClocks(at(21, 30));
  const server = new FakeServer(() => clocks.wall());
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const deviceId = server.enroll('driver_phone', 'v1', pair.publicKey);
  const session = server.login(deviceId, staffId);
  return { server, clocks, timers: new ManualTimers(), raw: new MemoryRawStore(), pair, deviceId, session, lost: [], locks: new PageLocks() };
}

async function open(w: World, extra: { session?: SessionInfo; channel?: Channel | null; failuresToOffline?: number } = {}): Promise<DriverClient> {
  const client = await DriverClient.open({
    session: extra.session ?? w.session, raw: w.raw, deviceKey: w.pair.privateKey, origin: ORIGIN, baseUrl: BASE, appVersion: 'test', fetch: w.server.fetch,
    auth: createAuthApi(BASE, w.server.fetch), onSessionLost: (code) => w.lost.push(code),
    eventSource: null, networkEvents: null, channel: extra.channel ?? null, locks: w.locks, clocks: w.clocks, timers: w.timers, random: () => 0.5,
    visibility: { visible: () => true, listen: () => () => {} }, failuresToOffline: extra.failuresToOffline ?? 1, recoverMs: 0, retryDelaysMs: [],
    timing: { drainMs: 200, refreshMs: 2_000, phoneMs: 2_000 }, log: () => {}, words: localWords(), makeHttp: (o) => new HttpClient(o), pinIterations: 1_000,
  });
  opened.push(client);
  return client;
}

async function waitFor(check: () => boolean | Promise<boolean>, what = 'condition', ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error('기다림 끝: ' + what);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function idle(client: DriverClient): Promise<void> {
  await waitFor(() => !client.busy(), 'idle');
  await client.flusher.settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await waitFor(() => !client.busy(), 'idle again');
}

function envelopeOf(view: { basis: { epoch: string; rev: number }; command?: ConfirmCommand; expect?: Expect }): AnyCommandEnvelope {
  return envelopeFor(openCommandDraft(view.command!, view.basis, view.expect ? { expect: view.expect } : {}), view.command, view.expect)!;
}
const collectDraft = (c: DriverClient, id: string) => c.query('confirmDraft', { actionKey: 'stamp.collect', taskId: 'collect:' + id, orderId: id });

async function online(w: World, extra: { session?: SessionInfo; channel?: Channel | null; failuresToOffline?: number } = {}): Promise<DriverClient> {
  const client = await open(w, extra);
  client.start();
  await waitFor(() => client.localClient.hasCopy(), 'first copy');
  await idle(client);
  return client;
}

/** 두 수거를 보내 답을 받고 사본에 들게 한다(보낸 기록 둘). */
async function twoCollectsSent(w: World, client: DriverClient) {
  const e1 = envelopeOf(await collectDraft(client, 'o25'));
  const e2 = envelopeOf(await collectDraft(client, 'o29'));
  expect((await client.command(e1)).outcome).toBe('queued');
  expect((await client.command(e2)).outcome).toBe('queued');
  await idle(client);
  await waitFor(async () => (await client.queue.list()).items.length === 0, 'settled');
  expect((await client.queue.sent()).map((s) => s.outcome)).toEqual(['applied', 'applied']);
  return { e1, e2 };
}

const NEW_EPOCH = '01JG000000000000000000EPOC';

/** 앱 시작 도우미(start.ts)는 저장소를 열고 닫는다: 시험은 닫지 않는 겉(같은 칸)을 넘긴다. */
const opener = (raw: MemoryRawStore) => {
  const view = Object.assign(Object.create(raw) as MemoryRawStore, { close: () => {} });
  return async () => view;
};
const metaOf = (raw: MemoryRawStore) => new LocalStore({ raw, deviceId: '', channel: null }).readMeta();

describe('epoch: restore vs reset (R3-1 · R3-3)', () => {
  it('a test-shop reset (new epoch, restoredUpToRev null) does not replay the old sent records into the fresh shop', async () => {
    const w = await world();
    const client = await online(w);
    const pay = await client.query('fieldPaySheet', { taskId: 'collect:o28' });
    expect((await client.command(envelopeOf(pay))).outcome).toBe('queued');
    await idle(client);
    await waitFor(async () => (await client.queue.list()).items.length === 0, 'settled');
    w.server.state = sampleDay({ date: DATE, epoch: NEW_EPOCH, ids: 'demo' });
    w.server.log.clear();
    client.http.poke();
    await waitFor(() => client.localClient.copyHead()?.epoch === NEW_EPOCH, 'new copy');
    await idle(client);
    expect(w.server.rows(w.deviceId)).toEqual([]);
    expect(w.server.state.orders.find((o) => o.id === 'o28')!.payments.filter((p) => p.deviceId === w.deviceId)).toEqual([]);
    expect((await client.local.readMeta()).epoch).toBe(NEW_EPOCH);
    expect((await client.queue.list()).items).toEqual([]);
  });

  it('a restore (restoredUpToRev a number) re-sends the sent records above it, with the copy', async () => {
    const w = await world();
    const client = await online(w);
    const before = structuredClone(w.server.state);
    const { e1, e2 } = await twoCollectsSent(w, client);
    w.server.state = { ...before, epoch: NEW_EPOCH };
    w.server.log.delete(e1.requestId);
    w.server.log.delete(e2.requestId);
    w.server.restoredUpToRev = before.rev;
    client.http.poke();
    await waitFor(() => w.server.rows(w.deviceId).length === 2, 're-sent');
    expect(w.server.rows(w.deviceId).map((r) => r.requestId).sort()).toEqual([e1.requestId, e2.requestId].sort());
  });

  it('a restore seen only after a logout (no copy) still re-sends from the device memo (R3-3)', async () => {
    const w = await world();
    let client = await online(w);
    const before = structuredClone(w.server.state);
    const { e1, e2 } = await twoCollectsSent(w, client);
    expect(await client.logout()).toBeNull();
    expect(w.raw.size('snapshot')).toBe(0);
    const session = w.server.login(w.deviceId, 'staff-3');
    w.server.state = { ...before, epoch: NEW_EPOCH };
    w.server.log.delete(e1.requestId);
    w.server.log.delete(e2.requestId);
    w.server.restoredUpToRev = before.rev;
    client = await online(w, { session });
    await waitFor(() => w.server.rows(w.deviceId).length === 2, 're-sent after logout');
    expect(w.server.rows(w.deviceId).map((r) => r.requestId).sort()).toEqual([e1.requestId, e2.requestId].sort());
  });
});

describe('epoch on a batch answer, while the phone stays online (§17-4)', () => {
  // 연결이 이어진 채 매장이 바뀌면 심장 박동 없이 묶음이 새 매장에 닿는다(보내기의 epoch 확인은 연결마다 한 번). 진짜 서버처럼 한 번의 실패로는
  // 끊김이 아니다(failuresToOffline 2): 보낸 뒤의 사본 받기가 한 번 실패하면 옛 매장의 답은 사본에 들지 않은 채 남는다.
  it('a reset: an old answer not yet in the copy is not replayed when the fresh shop reports its number missing, and is settled at that answer', async () => {
    const w = await world();
    w.server.gaps = true;
    const client = await online(w, { failuresToOffline: 2 });
    const pay = await client.query('fieldPaySheet', { taskId: 'collect:o28' });
    w.server.fault('api/v2/snapshot', 'down');
    const e1 = envelopeOf(pay);
    expect((await client.command(e1)).outcome).toBe('queued');
    await idle(client);
    expect(client.online()).toBe(true);
    expect((await client.queue.list()).items.map((i) => [i.seq, i.state, i.answeredEpoch])).toEqual([[1, 'answered', w.server.state.epoch]]);
    const oldEpoch = w.server.state.epoch;
    // 시험 매장 새로 만들기: 이어진 끝이 없는 서버라 새 매장이 1번을 빠졌다고 알린다(되살린 기준 없음).
    w.server.resetShop(sampleDay({ date: DATE, epoch: NEW_EPOCH, ids: 'demo' }), { keepCursor: false });
    // 사본 받기는 붙잡아 둔다: 묶음의 답만으로 정해야 한다.
    w.server.hold('api/v2/snapshot');
    const e2 = envelopeOf(await collectDraft(client, 'o29'));
    expect((await client.command(e2)).outcome).toBe('queued');
    await waitFor(async () => (await client.queue.list()).items.some((i) => i.requestId === e2.requestId && i.state === 'answered'), 'e2 answered');
    // 묶음의 답을 받은 때 이미: 옛 매장의 답은 보낸 기록으로 옮겨(새 매장의 목록에 겹쳐 그리지 않음) 다시 보낼 칸에 없다.
    expect((await client.queue.list()).items.map((i) => [i.seq, i.state, i.answeredEpoch])).toEqual([[2, 'answered', NEW_EPOCH]]);
    expect((await client.queue.sent()).map((s) => [s.seq, s.epoch])).toEqual([[1, oldEpoch]]);
    expect((await client.local.readMeta()).epoch).toBe(NEW_EPOCH);
    w.server.release('api/v2/snapshot');
    await idle(client);
    const batches = w.server.calls.filter((c) => c.path === API_V2.commandsBatch).map((c) => (c.body as { commands: { requestId: string }[] }).commands.map((x) => x.requestId));
    expect(batches).toEqual([[e1.requestId], [e2.requestId]]);
    expect(w.server.rows(w.deviceId).map((r) => [r.seq, r.requestId])).toEqual([[2, e2.requestId]]);
    expect(w.server.state.orders.find((o) => o.id === 'o28')!.payments.filter((p) => p.deviceId === w.deviceId)).toEqual([]);
    // 다음 연결 · 사본이 와도 다시 보내지 않는다.
    client.http.poke();
    await waitFor(() => client.localClient.copyHead()?.epoch === NEW_EPOCH, 'new copy');
    await idle(client);
    expect(w.server.rows(w.deviceId).map((r) => r.requestId)).toEqual([e2.requestId]);
  });

  it('a batch answer in the epoch of the copy is written at once: no epoch lock or memo read before the results', async () => {
    const w = await world();
    const names: string[] = [];
    const locks = new PageLocks();
    const request = locks.request.bind(locks);
    locks.request = (name, work) => { names.push(name); return request(name, work); };
    w.locks = locks;
    const client = await online(w);
    w.server.hold(API_V2.snapshot);
    w.server.hold(API_V2.commandsBatch);
    const e1 = envelopeOf(await collectDraft(client, 'o25'));
    expect((await client.command(e1)).outcome).toBe('queued');
    await waitFor(() => w.server.calls.some((c) => c.path === API_V2.commandsBatch), 'batch posted');
    names.length = 0;
    w.server.release(API_V2.commandsBatch);
    await waitFor(async () => (await client.queue.list()).items.some((i) => i.state === 'answered'), 'answered');
    expect(names).not.toContain('skinote-epoch');
    w.server.release(API_V2.snapshot);
    await idle(client);
  });

  it('a restore seen first on a batch answer re-sends the records above the restore point in the same flush', async () => {
    const w = await world();
    const client = await online(w, { failuresToOffline: 2 });
    const before = structuredClone(w.server.state);
    const { e1, e2 } = await twoCollectsSent(w, client);
    w.server.state = { ...before, epoch: NEW_EPOCH };
    w.server.log.delete(e1.requestId);
    w.server.log.delete(e2.requestId);
    w.server.restoredUpToRev = before.rev;
    // 사본 받기는 실패: 묶음의 답이 복구를 알린다.
    w.server.fault('api/v2/snapshot', 'down');
    const pay = await client.query('fieldPaySheet', { taskId: 'collect:o28' });
    const e3 = envelopeOf(pay);
    expect((await client.command(e3)).outcome).toBe('queued');
    await idle(client);
    expect(w.server.rows(w.deviceId).map((r) => r.requestId).sort()).toEqual([e1.requestId, e2.requestId, e3.requestId].sort());
    expect((await client.local.readMeta()).restoredEpoch).toBe(NEW_EPOCH);
  });
});

describe('results line after a resend that races a copy (§17-4)', () => {
  // 답을 잃은 묶음을 다시 보내는 동안 사본 받기가 먼저 끝나면(그 사본의 recorded가 항목을 보낸 기록으로 옮김) 묶음의 답이 찾을 칸이 없다. 그래도
  // 보낸 것이므로 띠는 결과 줄 `전송 대기 0`을 보인다(끊긴 채 만든 · 결과 확인 중이던 항목).
  it('a resent batch whose items a copy settled first still ends with the settled band', async () => {
    const w = await world();
    const client = await online(w, { failuresToOffline: 2 });
    w.server.down = true;
    const e1 = envelopeOf(await collectDraft(client, 'o25'));
    expect((await client.command(e1)).outcome).toBe('queued');
    await idle(client);
    w.server.down = false;
    // 다시 이음: 첫 묶음은 서버에 닿고 답만 잃는다.
    w.server.fault(API_V2.commandsBatch, 'lose-answer');
    client.flusher.reconnected();
    client.flusher.kick();
    await client.flusher.settle();
    expect((await client.queue.list()).items.map((i) => [i.seq, i.state])).toEqual([[1, 'unconfirmed']]);
    expect(w.server.rows(w.deviceId).map((r) => r.requestId)).toEqual([e1.requestId]);
    // 다시 보내는 묶음을 붙잡은 채 사본 받기가 먼저 끝난다.
    w.server.hold(API_V2.commandsBatch);
    client.flusher.kick();
    await waitFor(() => w.server.calls.filter((c) => c.path === API_V2.commandsBatch).length === 2, 'resend posted');
    await client.snapshots.request(true);
    expect((await client.queue.list()).items).toEqual([]);
    expect((await client.queue.sent()).map((r) => r.requestId)).toEqual([e1.requestId]);
    w.server.release(API_V2.commandsBatch);
    await idle(client);
    expect(client.connection()).toMatchObject({ pendingCount: 0, settled: true });
  });
});

describe('wipes and session end (R3-4 · R3-9)', () => {
  it('a 401 with a record left: the copy and remembered session go, the queue stays for the next login', async () => {
    const w = await world();
    const client = await online(w);
    await client.setVerifier('4821');
    await waitFor(async () => (await client.local.readSessionRecord(REMEMBERED_ID)) !== null, 'remembered');
    w.server.down = true;
    await client.command(envelopeOf(await collectDraft(client, 'o25')));
    await idle(client);
    w.server.down = false;
    // 전달도 막힌 채 세션이 끝남(보낼 것이 남는다).
    w.server.fault('api/v2/device/challenge', { status: 503, code: 'SHOP_UNAVAILABLE' });
    w.server.endSession(w.session.csrf, 'SESSION_EXPIRED');
    client.http.poke();
    await waitFor(() => w.lost.length > 0, 'lost');
    expect(w.raw.size('snapshot')).toBe(0);
    expect(w.raw.size('session')).toBe(0);
    expect(w.raw.size('queue')).toBe(1);
    expect(w.raw.peek('keys', 'queue:' + w.deviceId)).toBeDefined();
  });

  it('a revoked device: page A with a stale count delivers page B’s record before wiping (the store decides)', async () => {
    const w = await world();
    const a = await online(w);
    const b = await online(w);
    w.server.down = true;
    expect((await b.command(envelopeOf(await collectDraft(b, 'o29')))).outcome).toBe('queued');
    await idle(b);
    expect(a.localClient.counts().pending).toBe(0);
    w.server.devices.get(w.deviceId)!.revoked = true;
    w.server.down = false;
    a.http.poke();
    await waitFor(() => w.lost.includes('DEVICE_REVOKED'), 'A lost');
    const delivered = w.server.calls.filter((c) => c.path === 'api/v2/device/deliver').flatMap((c) => (c.body as { commands: { requestId: string }[] }).commands);
    expect(delivered).toHaveLength(1);
  });

  it('a revoked device with an item stuck for this app version: the copy and remembered session go at once, the queue and its key stay (R3-9)', async () => {
    const w = await world();
    const client = await online(w);
    await client.setVerifier('4821');
    w.server.down = true;
    const env = envelopeOf(await collectDraft(client, 'o25'));
    await client.command(env);
    await idle(client);
    await client.queue.markStuck(env.requestId, 'BAD_INPUT', 'test');
    w.server.devices.get(w.deviceId)!.revoked = true;
    w.server.down = false;
    client.http.poke();
    await waitFor(() => w.lost.includes('DEVICE_REVOKED'), 'lost');
    expect(w.raw.size('snapshot')).toBe(0);
    expect(w.raw.size('session')).toBe(0);
    expect(w.raw.size('queue')).toBe(1);
    expect(w.raw.peek('keys', 'queue:' + w.deviceId)).toBeDefined();
  });

  it('signed out at the start (no DriverClient running): the copy, remembered session and verifier go; a gone device is wiped whole only with nothing to send (R3-9)', async () => {
    const w = await world();
    const client = await online(w);
    await client.setVerifier('4821');
    w.server.down = true;
    await client.command(envelopeOf(await collectDraft(client, 'o25')));
    await idle(client);
    client.close();
    expect(w.raw.size('snapshot')).toBeGreaterThan(0);
    expect(w.raw.size('session')).toBeGreaterThan(0);
    // 끊은 기기인데 보낼 기록이 남음: 사본 · 세션 칸만 지우고 보냄 대기 · 열쇠는 남는다.
    expect(await clearLocalAfterSignOut(true, opener(w.raw))).toBe(false);
    expect([w.raw.size('snapshot'), w.raw.size('session'), w.raw.size('queue')]).toEqual([0, 0, 1]);
    expect(w.raw.peek('keys', 'queue:' + w.deviceId)).toBeDefined();
    // 보낼 기록이 없는 끊은 기기: 모두 지운다.
    const clean = await world();
    const other = await online(clean);
    await other.setVerifier('4821');
    other.close();
    expect(await clearLocalAfterSignOut(true, opener(clean.raw))).toBe(true);
    for (const store of ['snapshot', 'session', 'queue', 'keys', 'meta'] as const) expect(clean.raw.size(store), store).toBe(0);
  });

  it('wipeAll refuses while a record is not answered, in the same transaction', async () => {
    const w = await world();
    const client = await online(w);
    w.server.down = true;
    await client.command(envelopeOf(await collectDraft(client, 'o25')));
    await idle(client);
    expect(await client.local.wipeAll()).toBe(false);
    expect(w.raw.size('queue')).toBe(1);
    expect(w.raw.size('keys')).toBeGreaterThan(0);
  });
});

describe('lost-answer online commands (R3-5)', () => {
  it('two pages keep each other’s entries; after a reload both are resent once', async () => {
    const w = await world();
    const hub = new MemoryChannelHub();
    const a = await online(w, { channel: hub.channel() });
    const b = await online(w, { channel: hub.channel() });
    const basis = { epoch: w.server.state.epoch, rev: w.server.state.rev };
    w.server.fault('api/v2/command', 'down', 'down');
    const t1 = { type: 'cash.transfer' as const, commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R9C0D1', basis, payload: { vehicleId: 'v1', amount: 50_000 } };
    const t2 = { type: 'cash.transfer' as const, commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R9C0D2', basis, payload: { vehicleId: 'v1', amount: 10_000 } };
    expect((await a.command(t1)).outcome).toBe('unknown');
    expect((await b.command(t2)).outcome).toBe('unknown');
    expect((await a.local.readOnline()).map((p) => p.envelope.requestId).sort()).toEqual([t1.requestId, t2.requestId]);
    a.close();
    b.close();
    const c = await online(w);
    c.http.poke();
    await waitFor(() => w.server.state.cashTransfers.length === 2, 'both resent');
    expect(w.server.state.cashTransfers.map((t) => t.amount).sort()).toEqual([10_000, 50_000]);
    await waitFor(async () => (await c.local.readOnline()).length === 0, 'forgotten');
  });

  it('a resent online command that is not accepted leaves a band line instead of vanishing', async () => {
    const w = await world();
    const client = await online(w);
    const basis = { epoch: w.server.state.epoch, rev: w.server.state.rev };
    // 처음은 서버에 닿지 않고(답을 잃음), 다시 보낸 것은 받아들여지지 않는다(400 → rejected).
    w.server.fault('api/v2/command', 'down', { status: 400, code: 'BAD_INPUT' });
    const handover = { type: 'cash.transfer' as const, commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R9C0D3', basis, payload: { vehicleId: 'v1', amount: 999_999_999 } };
    expect((await client.command(handover)).outcome).toBe('unknown');
    client.http.poke();
    await waitFor(() => (client.connection().unconfirmedCount ?? 0) === 0, 'resolved');
    expect(w.server.state.cashTransfers).toEqual([]);
    expect(client.connection().refusedCount).toBe(1);
    // 무엇이 안 되었는지 남고(§18 R4-15: `처리 실패 · 현금 인계 999,999,999원 · 매장 확인`), 다른 확인 창을 열어도 걷히지 않는다.
    expect(client.connection().refused).toEqual([{ what: '현금 인계', money: '999,999,999원' }]);
    client.dismissResults();
    expect(client.connection().refusedCount).toBe(1);
  });
});

describe('app lock (R3-7 · R3-11 · R3-24)', () => {
  it('no verifier: at start the lock is due and needs an online login; on return only after the lock time', async () => {
    const w = await world();
    const client = await online(w);
    expect(await client.lockDue(true)).toEqual({ due: true, needLogin: true });
    client.noteUse();
    await waitFor(async () => (await client.local.readMeta()).lastUseAt !== undefined, 'noted');
    expect((await client.lockDue()).due).toBe(false);
    w.clocks.advance(6 * 60_000);
    expect(await client.lockDue()).toEqual({ due: true, needLogin: true });
  });

  it('five wrong PINs lock until a time (the remembered session stays); after it the right PIN opens; ten lock twice as long', async () => {
    const w = await world();
    const client = await online(w);
    await client.setVerifier('4821');
    await waitFor(async () => (await client.local.readSessionRecord(REMEMBERED_ID)) !== null, 'remembered');
    for (let i = 0; i < 4; i += 1) expect((await client.unlock('0000')).answer).toBe('wrong');
    const fifth = await client.unlock('0000');
    expect(fifth).toEqual({ answer: 'locked', until: w.clocks.wall() + 5 * 60_000 });
    expect(await client.unlock('4821')).toEqual({ answer: 'locked', until: fifth.until });
    expect(await client.lockDue()).toEqual({ due: true, needLogin: false, until: fifth.until });
    expect(await client.local.readSessionRecord(REMEMBERED_ID)).not.toBeNull();
    w.clocks.advance(5 * 60_000 + 1);
    for (let i = 0; i < 4; i += 1) expect((await client.unlock('0000')).answer).toBe('wrong');
    expect(await client.unlock('0000')).toEqual({ answer: 'locked', until: w.clocks.wall() + 10 * 60_000 });
    w.clocks.advance(10 * 60_000 + 1);
    expect(await client.unlock('4821')).toEqual({ answer: 'ok' });
    expect((await client.local.readMeta()).lockFailures).toBe(0);
  });

  it('only the driver role gets a verifier; another role’s login removes a verifier left on the device', async () => {
    const w = await world();
    const driver = await online(w);
    await driver.setVerifier('4821');
    expect(await driver.local.readSessionRecord(VERIFIER_ID)).not.toBeNull();
    driver.close();
    const counter = w.server.login(w.deviceId, 'staff-2');
    expect(counter.staff.roleKey).not.toBe('driver');
    const covering = await online(w, { session: counter });
    await covering.setVerifier('1234');
    expect(await covering.local.readSessionRecord(VERIFIER_ID)).toBeNull();
    expect(await covering.lockDue(true)).toEqual({ due: true, needLogin: true });
  });

  it('start with a server session and no fresh PIN (R3-7): a stale last use shows the PIN pad; no verifier, no store or a failing store needs an online login', async () => {
    const w = await world();
    const client = await online(w);
    await client.setVerifier('4821');
    expect(await startLock({}, client)).toBeNull();
    w.clocks.advance(6 * 60_000);
    expect(await startLock({}, client)).toEqual({ needLogin: false });
    // 방금 비밀번호로 로그인했으면 잠그지 않고, 기억한 세션의 잠금은 그대로.
    expect(await startLock({ pin: '4821' }, client)).toBeNull();
    expect(await startLock({ locked: { needLogin: false, until: 7 } }, client)).toEqual({ needLogin: false, until: 7 });
    // 저장소가 없음(HttpClient) · 묻기가 던짐: 온라인 로그인.
    expect(await startLock({}, null)).toEqual({ needLogin: true });
    expect(await startLock({}, { lockDue: () => Promise.reject(new Error('store')) })).toEqual({ needLogin: true });
    await client.local.deleteSessionRecord(VERIFIER_ID);
    const lock = await startLock({}, client);
    expect(lock).toEqual({ needLogin: true });
    expect(lockNeedsServer(lock!, true, w.clocks.wall())).toBe(true);
  });

  it('five wrong PINs, then a reload while online (R3-7): the new page keeps the lock and goes to the server login, offline the PIN pad with its time', async () => {
    const w = await world();
    const a = await online(w);
    await a.setVerifier('4821');
    for (let i = 0; i < 5; i += 1) await a.unlock('0000');
    a.close();
    const b = await online(w);
    const lock = await startLock({}, b);
    expect(lock?.needLogin).toBe(false);
    expect(lock?.until).toBeGreaterThan(w.clocks.wall());
    expect(lockNeedsServer(lock!, true, w.clocks.wall())).toBe(true);
    expect(lockNeedsServer(lock!, false, w.clocks.wall())).toBe(false);
    expect(await b.local.readSessionRecord(REMEMBERED_ID)).not.toBeNull();
  });

  it('a logout that never reached the server (R3-7): the next start does not open that session, signs it out first and clears the marker', async () => {
    const w = await world();
    const client = await online(w);
    w.server.fault('api/v2/logout', 'down');
    expect(await client.logout()).toBeNull();
    const kept = [...w.server.sessions.values()][0]!;
    expect(kept.open).toBe(true);
    // 다음 시작에도 서버에 닿지 않음: 열지 않고 표시는 남는다.
    w.server.fault('api/v2/logout', 'down');
    expect(await pendingSignOut(w.session, BASE, w.server.fetch, opener(w.raw))).toBe(true);
    expect(kept.open).toBe(true);
    expect((await metaOf(w.raw)).signOutPending).toBe(w.session.session!.id);
    // 연결됨: 서버 로그아웃 뒤 표시를 걷는다(그 세션은 여전히 열지 않는다).
    expect(await pendingSignOut(w.session, BASE, w.server.fetch, opener(w.raw))).toBe(true);
    expect(kept.open).toBe(false);
    expect((await metaOf(w.raw)).signOutPending).toBeUndefined();
    // 다른 세션(새 로그인)은 막지 않는다.
    expect(await pendingSignOut(w.server.login(w.deviceId, 'staff-3'), BASE, w.server.fetch, opener(w.raw))).toBe(false);
  });

  it('a logout that never reached the server leaves a sign-out marker with the session id', async () => {
    const w = await world();
    const client = await online(w);
    w.server.fault('api/v2/logout', 'down');
    expect(await client.logout()).toBeNull();
    const store = client.local;
    expect((await store.readMeta()).signOutPending).toBe(w.session.session!.id);
    expect([...w.server.sessions.values()][0]!.open).toBe(true);
  });
});

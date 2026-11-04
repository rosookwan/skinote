// 네 번째 검토(work/impl-offline/plan.md §18, review round 2, 2026-09-28)의 기사 기기 쪽 — DriverClient와 가짜 서버:
//   - R4-1: 스위치를 끈 길에서 답을 잃은 온라인 현장 수납(그사이 카운터가 받음 → 서버는 충돌)이 보냄 대기의 사실로 적힌다(돈 + `중복 수납 의심`).
//   - R4-4: 답을 잃은 온라인 명령(매장 입고)도 서버에 알리는 대기 수에 든다.
//   - R4-8: 시계가 366일 넘게 틀린 기기도 알림이 거절되지 않는다(자른 값, 서버는 시계 확인으로 본다).
//   - R4-10: 로그아웃은 저장소의 대기를 센다(다른 화면이 방금 넣은 기록).
//   - R4-11: 띠 · 바닥줄 · 업무 판 · 전송 대기 목록이 같은 수(기록 수)다.
//   - R4-13: 서버 없이 다시 연 앱의 띠는 기기 메모의 마지막 연결 때이고 첫 답까지 끊김이다.
//   - R4-14: 할 일이 없어 적지 않은 순서 변경(카운터가 같은 순서로 바꿈)은 줄 메모 · 띠 메모가 없다.
//   - R4-15: 다시 보낸 온라인 명령의 거절 줄은 무엇이 안 되었는지 말하고 다시 열어도 남으며 로그아웃하면 걷힌다.
import { envelopeFor, openCommandDraft, parseOfflineBody, type AnyCommandEnvelope, type ConfirmCommand, type Expect, type LedgerViewResult, type SessionInfo } from '@skinote/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthApi } from '../src/app/auth-api.ts';
import { HttpClient } from '../src/app/http-client.ts';
import { localWords } from '../src/app/strings.ts';
import { DriverClient } from '../src/local/driver-client.ts';
import { PageLocks, type Channel } from '../src/local/local-store.ts';
import { MemoryRawStore } from '../src/local/raw-store.ts';
import { at, BASE, FakeServer, ManualTimers, ORIGIN, TestClocks } from './fake-server.ts';

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

async function world(opts: { serverSkewMs?: number; localFirst?: boolean } = {}): Promise<World> {
  const clocks = new TestClocks(at(21, 30));
  const server = new FakeServer(() => clocks.wall() + (opts.serverSkewMs ?? 0));
  if (opts.localFirst === false) server.policy = { ...server.policy, localFirst: false };
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const deviceId = server.enroll('driver_phone', 'v1', pair.publicKey);
  const session = server.login(deviceId, 'staff-3');
  return { server, clocks, timers: new ManualTimers(), raw: new MemoryRawStore(), pair, deviceId, session, lost: [], locks: new PageLocks() };
}

async function open(w: World, extra: { channel?: Channel | null; remembered?: boolean } = {}): Promise<DriverClient> {
  const client = await DriverClient.open({
    session: w.session, raw: w.raw, deviceKey: w.pair.privateKey, origin: ORIGIN, baseUrl: BASE, appVersion: 'test', fetch: w.server.fetch,
    auth: createAuthApi(BASE, w.server.fetch), onSessionLost: (code) => w.lost.push(code),
    eventSource: null, networkEvents: null, channel: extra.channel ?? null, locks: w.locks, clocks: w.clocks, timers: w.timers, random: () => 0.5,
    visibility: { visible: () => true, listen: () => () => {} }, failuresToOffline: 1, recoverMs: 0, retryDelaysMs: [],
    timing: { drainMs: 200, refreshMs: 2_000, phoneMs: 2_000 }, log: () => {}, words: localWords(), makeHttp: (o) => new HttpClient(o), pinIterations: 1_000,
    ...(extra.remembered ? { remembered: true } : {}),
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
const list = (c: DriverClient) => c.ledgerView('collection_list', { deviceClass: 'driver_tablet' });
const metric = (l: LedgerViewResult, key: string) => (l.metrics.find((m) => m.metricKey === key) as { value?: number } | undefined)?.value;

async function online(w: World, extra: { channel?: Channel | null } = {}): Promise<DriverClient> {
  const client = await open(w, extra);
  client.start();
  await waitFor(() => client.localClient.hasCopy(), 'first copy');
  await idle(client);
  return client;
}

describe('R4-1 switch-off: a lost online refusal becomes a queued fact', () => {
  it('the counter took the due, the driver cash answer was lost: the resend is applied with `중복 수납 의심`, nothing vanishes', async () => {
    const w = await world({ localFirst: false });
    const client = await online(w);
    expect(client.localFirst()).toBe(false);
    const pay = await client.query('fieldPaySheet', { taskId: 'collect:o28', methodKey: 'cash' });
    const env = envelopeOf(pay);
    const due = pay.expect?.dueAmount ?? 0;
    expect(due).toBeGreaterThan(0);
    expect(w.server.counter({ type: 'payment.take', payload: { orderIds: ['o28'], amount: due, methodKey: 'cash' }, expect: { dueAmount: due } }).outcome).toBe('applied');
    w.server.fault('api/v2/command', 'lose-answer');
    // 창은 보냄 대기로 닫힌다(기사는 적었다고 안다).
    expect((await client.command(env)).outcome).toBe('queued');
    expect(w.server.log.get(env.requestId)!.outcome.outcome).toBe('conflict');
    await waitFor(async () => (await client.queue.list()).items.every((i) => i.state === 'answered'), 'answered');
    await idle(client);
    // 서버: 보냄 대기 규칙으로 다시 판단 → 기사의 돈이 적히고 `중복 수납 의심`.
    const row = w.server.log.get(env.requestId)!;
    expect(row.outcome.outcome).toBe('applied');
    expect(row.reviews).toContain('possible_duplicate_money');
    expect(w.server.state.orders.find((o) => o.id === 'o28')!.payments.filter((p) => p.deviceId === w.deviceId)).toHaveLength(1);
    // 기기: 띠의 결과 줄에 `중복 수납 의심 1팀`(스위치를 끈 기기는 연결된 동안 목록을 서버에서 읽는다: 줄 메모는 끊겼을 때의 사본 목록에).
    expect(client.connection()).toMatchObject({ pendingCount: 0, settled: true, settledNotes: [{ note: '중복 수납 의심', count: 1 }] });
    const settled = [...(await client.queue.list()).items.map((i) => [i.outcome, i.reviews]), ...(await client.queue.sent()).map((x) => [x.outcome, x.reviews])];
    expect(settled).toEqual([['applied', expect.arrayContaining(['possible_duplicate_money'])]]);
  });

  it('a queued record the server refuses is settled with the `처리 제외 · 매장 확인` row note and a band line, never silently', async () => {
    const w = await world();
    const client = await online(w);
    w.server.down = true;
    const visit = { type: 'task.visit' as const, commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R9D001', basis: { epoch: w.server.state.epoch, rev: w.server.state.rev }, payload: { taskId: 'collect:o29', outcomeKey: 'customer_absent' as const } };
    expect((await client.command(visit)).outcome).toBe('queued');
    // 서버에서 이 기록은 받아들여지지 않은 것으로 적힌다(가짜 서버의 기록 줄을 바꿔 사본의 recorded가 거절을 알리게).
    w.server.down = false;
    w.server.fault('api/v2/commands:batch', { status: 400, code: 'BAD_INPUT' });
    await waitFor(async () => (await client.queue.list()).items.some((i) => i.stuckVersion === 'test'), 'stuck');
    w.server.log.set(visit.requestId, {
      requestId: visit.requestId, deviceId: w.deviceId, seq: 1, reviews: [], occurredAt: w.clocks.wall(), receivedAt: w.clocks.wall(),
      outcome: { outcome: 'rejected', requestId: visit.requestId, rev: w.server.state.rev, asOfRev: visit.basis.rev, epoch: w.server.state.epoch, rebased: false, changes: [], error: { code: 'FORBIDDEN', message: 'x' } },
    });
    await client.snapshots.request(true);
    await waitFor(async () => (await client.queue.list()).items.length === 0, 'settled');
    expect((await client.queue.sent()).map((s) => [s.outcome, s.errorCode])).toEqual([['rejected', 'FORBIDDEN']]);
    expect((await list(client)).rows.find((r) => r.taskId === 'collect:o29')?.reviewNote).toBe('처리 제외 · 매장 확인');
    expect(client.connection()).toMatchObject({ pendingCount: 0, settledNotes: [{ note: '처리 제외 · 매장 확인', count: 1 }] });
  });
});

describe('R4-4 lost-answer online commands in the report', () => {
  it('매장 입고 whose answer was lost counts as a pending, unconfirmed record in every report the server gets', async () => {
    const w = await world();
    const client = await online(w);
    await client.command(envelopeOf(await collectDraft(client, 'o25')));
    await idle(client);
    const receive = envelopeOf(await client.query('confirmDraft', { actionKey: 'receive_to_shop', vehicleId: 'v1' }));
    w.server.fault('api/v2/command', 'lose-answer');
    expect((await client.command(receive)).outcome).toBe('unknown');
    expect(client.connection()).toMatchObject({ pendingCount: 1, unconfirmedCount: 1 });
    const report = await client.report();
    expect([report.pendingCount, report.unconfirmedCount]).toEqual([1, 1]);
    expect(report.oldestPendingAt).toBeDefined();
    // 심장 박동이 서버에 닿는다(카운터의 차량 표시 · 마감이 이 수를 본다).
    const device = w.server.devices.get(w.deviceId)!;
    await (client as unknown as { heartbeatNow(): Promise<unknown> }).heartbeatNow();
    expect([device.lastReport?.pendingCount, device.lastReport?.unconfirmedCount]).toEqual([1, 1]);
  });
});

describe('R4-8 a clock far off', () => {
  it('a device clock 400 days behind the server still reports and sends (the offset is clamped; the server flags the clock)', async () => {
    const w = await world({ serverSkewMs: 400 * 86_400_000 });
    const client = await online(w);
    w.clocks.advance(1_000);
    const out = await client.command({ type: 'task.visit', commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R9C0DN', basis: { epoch: w.server.state.epoch, rev: w.server.state.rev }, payload: { taskId: 'collect:o25', outcomeKey: 'customer_absent' } } as AnyCommandEnvelope);
    expect(out.outcome).toBe('queued');
    await waitFor(async () => (await client.queue.list()).items.every((i) => i.state === 'answered'), 'answered');
    const report = await client.report();
    expect(report.clockOffsetMs).toBe(366 * 86_400_000);
    expect(parseOfflineBody('heartbeat', { report }).ok).toBe(true);
    expect(parseOfflineBody('snapshot', { fromSeq: 1, pendingTaskIds: [], onlinePending: [], report }).ok).toBe(true);
  });
});

describe('R4-10 logout counts the store', () => {
  it('another page just recorded a collect: this page refuses to log out (`로그아웃 불가 · 전송 대기 1`)', async () => {
    const w = await world();
    const a = await online(w);
    const b = await open(w);
    await b.localClient.reload();
    w.server.down = true;
    expect((await b.command(envelopeOf(await collectDraft(b, 'o25')))).outcome).toBe('queued');
    expect(a.localClient.counts().pending).toBe(0);
    expect(await a.logout()).toBe('로그아웃 불가 · 전송 대기 1');
  });
});

describe('R4-11 one number for 전송 대기', () => {
  it('a collect and a field payment on one team, then a route move: band, list footer, task sheet and pending list all say 3', async () => {
    const w = await world();
    const client = await online(w);
    w.server.down = true;
    expect((await client.command(envelopeOf(await collectDraft(client, 'o28')))).outcome).toBe('queued');
    await waitFor(() => !client.connection().online, 'offline');
    expect((await client.command(envelopeOf(await client.query('fieldPaySheet', { taskId: 'collect:o28', methodKey: 'cash' })))).outcome).toBe('queued');
    const before = await list(client);
    const second = before.rows.filter((r) => r.taskId)[1]!.taskId!;
    const move = { type: 'route.move' as const, commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R9D002', basis: { epoch: w.server.state.epoch, rev: w.server.state.rev }, payload: { taskId: second, anchorTaskId: null, position: 'top' as const } };
    expect((await client.command(move)).outcome).toBe('queued');
    await idle(client);
    const l = await list(client);
    expect(client.connection().pendingCount).toBe(3);
    expect(metric(l, 'pending_count')).toBe(3);
    expect((await client.pending()).length).toBe(3);
    const sheet = await client.query('taskSheet', { taskId: 'collect:o29' });
    expect(sheet.progress).toMatch(/^완료 \d+ · 전송 대기 3 · 잔여 \d+$/);
    // 보내는 동안의 띠도 같은 수(sending.remaining).
    w.server.down = false;
    w.server.hold('api/v2/commands:batch');
    client.flusher.kick();
    await waitFor(() => client.flusher.sendingSince() !== null, 'sending');
    const c = client.connection();
    if (c.sending) expect(c.sending.remaining).toBe(c.pendingCount);
    w.server.release('api/v2/commands:batch');
    await idle(client);
  });

  it('only a route move while offline: the footer says 전송 대기 1, like the band', async () => {
    const w = await world();
    const client = await online(w);
    w.server.down = true;
    const rows = (await list(client)).rows.filter((r) => r.taskId);
    const move = { type: 'route.move' as const, commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R9D003', basis: { epoch: w.server.state.epoch, rev: w.server.state.rev }, payload: { taskId: rows[1]!.taskId!, anchorTaskId: null, position: 'top' as const } };
    expect((await client.command(move)).outcome).toBe('queued');
    await idle(client);
    expect(client.connection().pendingCount).toBe(1);
    expect(metric(await list(client), 'pending_count')).toBe(1);
  });
});

describe('R4-13 app start without the server', () => {
  it('last contact 21:40, reopened at 23:10 with the fetch failing: the band says 마지막 연결 21:40 and offline from the start', async () => {
    const w = await world();
    w.clocks.advance(10 * 60_000); // 21:40
    const first = await online(w);
    await (first as unknown as { heartbeatNow(): Promise<unknown> }).heartbeatNow();
    const contact = (await first.local.readMeta()).lastContactAt!;
    expect(contact).toBe(at(21, 40));
    first.close();
    w.clocks.advance(90 * 60_000); // 23:10
    w.server.down = true;
    const again = await open(w, { remembered: true });
    const c = again.connection();
    expect(c.online).toBe(false);
    expect(c.lastSyncAt).toBe(new Date(at(21, 40)).toISOString());
    again.start();
    await idle(again);
    expect(again.connection().lastSyncAt).toBe(new Date(at(21, 40)).toISOString());
    // 첫 답이 오면 곧바로 연결됨.
    w.server.down = false;
    again.http.poke();
    await waitFor(() => again.connection().online, 'online');
  });
});

describe('R4-14 harmless no-op records have no note', () => {
  it('the same route move on the phone (offline) and at the counter: after sending, no band note and no row note', async () => {
    const w = await world();
    const client = await online(w);
    const rows = (await list(client)).rows.filter((r) => r.taskId);
    const target = rows[1]!.taskId!;
    w.server.down = true;
    const move = { type: 'route.move' as const, commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R9D004', basis: { epoch: w.server.state.epoch, rev: w.server.state.rev }, payload: { taskId: target, anchorTaskId: null, position: 'top' as const } };
    expect((await client.command(move)).outcome).toBe('queued');
    await waitFor(() => !client.connection().online, 'offline');
    expect(w.server.counter({ type: 'route.move', payload: { taskId: target, anchorTaskId: null, position: 'top' } }).outcome).toBe('applied');
    w.server.down = false;
    client.http.poke();
    await waitFor(async () => (await client.queue.list()).items.every((i) => i.state === 'answered') && client.connection().online, 'answered');
    await idle(client);
    expect(w.server.log.get(move.requestId)!.outcome).toMatchObject({ outcome: 'superseded', error: { code: 'NOTHING_LEFT' } });
    const c = client.connection();
    expect(c.pendingCount).toBe(0);
    expect(c.settledNotes).toBeUndefined();
    expect((await list(client)).rows.find((r) => r.taskId === target)?.reviewNote).toBeUndefined();
  });
});

describe('R4-15 a refused resend names what failed and stays', () => {
  it('the band line survives a restart and other dialogs; logging out clears it', async () => {
    const w = await world();
    const client = await online(w);
    const basis = { epoch: w.server.state.epoch, rev: w.server.state.rev };
    w.server.fault('api/v2/command', 'down', { status: 400, code: 'BAD_INPUT' });
    const handover = { type: 'cash.transfer' as const, commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R9D005', basis, payload: { vehicleId: 'v1', amount: 350_000 } };
    expect((await client.command(handover)).outcome).toBe('unknown');
    client.http.poke();
    await waitFor(() => (client.connection().refusedCount ?? 0) === 1, 'refused');
    expect(client.connection().refused).toEqual([{ what: '현금 인계', money: '350,000원' }]);
    client.dismissResults();
    expect(client.connection().refused).toEqual([{ what: '현금 인계', money: '350,000원' }]);
    // 다시 켜도 남는다(기기 메모).
    client.close();
    const again = await open(w);
    again.start();
    await idle(again);
    expect(again.connection().refused).toEqual([{ what: '현금 인계', money: '350,000원' }]);
    expect(await again.logout()).toBeNull();
    expect((await again.local.readMeta()).refusedOnline ?? []).toEqual([]);
  });

  it('a superseded resend (already done) is not a refusal', async () => {
    const w = await world();
    const client = await online(w);
    await client.command(envelopeOf(await collectDraft(client, 'o25')));
    await idle(client);
    const receive = envelopeOf(await client.query('confirmDraft', { actionKey: 'receive_to_shop', vehicleId: 'v1' }));
    // 보낸 입고가 서버에 닿지 않았다(기기는 닿았는지 모른다: 결과 확인 중).
    w.server.fault('api/v2/command', 'down');
    expect((await client.command(receive)).outcome).toBe('unknown');
    // 그사이 카운터가 같은 입고를 했다: 다시 보낸 것은 할 일이 없다.
    expect(w.server.counter({ type: 'stock.receive', payload: (receive.payload as object) }).outcome).toBe('applied');
    client.http.poke();
    await waitFor(async () => (await client.local.readOnline()).length === 0 && (client.connection().unconfirmedCount ?? 0) === 0, 'resolved');
    expect(client.connection().refusedCount).toBeUndefined();
  });
});

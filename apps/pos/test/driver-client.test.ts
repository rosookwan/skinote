// DriverClient와 가짜 서버(work/impl-offline/plan.md §7-4 · §7-9 driver-client.test): S6을 작게 — 끊긴 채 기록, 같은 저장소로 다시 연 화면(새로 고침)이 같은
// 목록을 그림, 그사이 카운터 반납 · 수납, 다시 연결 → 결과 · 줄 메모 · 돈은 한 번씩. 묶음의 답을 잃음 → 결과 확인 중 → 다시 보냄 → 첫 결과. 온라인 명령의
// 답을 잃음이 새로 고침을 넘어 남음. 비우지 못한 매장 입고 · 현금 인계. 스위치를 끈 길(같은 요청번호로 보냄 대기). 세션 끝 · 끊은 기기 · 로그아웃.
import {
  envelopeFor, openCommandDraft, type AnyCommandEnvelope, type ConfirmCommand, type Expect, type LedgerViewResult, type SessionInfo, type StampCell,
} from '@skinote/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthApi } from '../src/app/auth-api.ts';
import { DriverClient } from '../src/local/driver-client.ts';
import { PageLocks } from '../src/local/local-store.ts';
import { MemoryRawStore } from '../src/local/raw-store.ts';
import { localWords } from '../src/app/strings.ts';
import { rememberedStart, isRemembered, REMEMBERED_ID, VERIFIER_ID } from '../src/local/remembered.ts';
import { LocalStore } from '../src/local/local-store.ts';
import { HttpClient } from '../src/app/http-client.ts';
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
}

async function world(options: { localFirst?: boolean } = {}): Promise<World> {
  const clocks = new TestClocks(at(21, 30));
  const server = new FakeServer(() => clocks.wall());
  if (options.localFirst === false) server.policy = { ...server.policy, localFirst: false };
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const deviceId = server.enroll('driver_phone', 'v1', pair.publicKey);
  const session = server.login(deviceId, 'staff-3');
  return { server, clocks, timers: new ManualTimers(), raw: new MemoryRawStore(), pair, deviceId, session, lost: [] };
}

async function open(w: World, session: SessionInfo = w.session): Promise<DriverClient> {
  const client = await DriverClient.open({
    session, raw: w.raw, deviceKey: w.pair.privateKey, origin: ORIGIN, baseUrl: BASE, appVersion: 'test', fetch: w.server.fetch,
    auth: createAuthApi(BASE, w.server.fetch), onSessionLost: (code) => w.lost.push(code),
    eventSource: null, networkEvents: null, channel: null, locks: new PageLocks(), clocks: w.clocks, timers: w.timers, random: () => 0.5,
    visibility: { visible: () => true, listen: () => () => {} }, failuresToOffline: 1, recoverMs: 0, retryDelaysMs: [],
    timing: { drainMs: 200, refreshMs: 2_000, phoneMs: 2_000 }, log: () => {}, words: localWords(), makeHttp: (o) => new HttpClient(o), pinIterations: 1_000,
  });
  opened.push(client);
  return client;
}

/** 조건이 참이 될 때까지(WebCrypto · 저장소의 약속들). */
async function waitFor(check: () => boolean | Promise<boolean>, what = 'condition', ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error('기다림 끝: ' + what);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 보내기 · 사본 받기가 모두 쉴 때까지. */
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
const list = (c: DriverClient) => c.ledgerView('collection_list', { deviceClass: 'driver_phone' });
const rowOf = (l: LedgerViewResult, taskId: string) => l.rows.find((r) => r.taskId === taskId)!;
const stampOf = (l: LedgerViewResult, taskId: string): StampCell => (Object.values(rowOf(l, taskId).cells).find((c) => c.renderer === 'stamp') as { stamp: StampCell }).stamp;
const payments = (s: FakeServer, orderId: string) => s.state.orders.find((o) => o.id === orderId)!.payments;

async function online(w: World): Promise<DriverClient> {
  const client = await open(w);
  client.start();
  await waitFor(() => client.localClient.hasCopy(), 'first copy');
  await idle(client);
  return client;
}

describe('로컬 먼저 · 연결됨', () => {
  it('첫 사본을 받아 사본으로 그리고, 수거는 보냄 대기 → 곧바로 보냄 → 서버 적용 → 사본에 들면 실선', async () => {
    const w = await world();
    const client = await online(w);
    expect(client.connection()).toMatchObject({ online: true, pendingCount: 0, sendQueue: true });
    const out = await client.command(envelopeOf(await collectDraft(client, 'o25')));
    expect(out.outcome).toBe('queued');
    await idle(client);
    const rows = w.server.rows(w.deviceId);
    expect(rows.map((r) => [r.seq, r.outcome.outcome, r.timeSource])).toEqual([[1, 'applied', 'monotonic']]);
    expect((await client.queue.list()).items).toHaveLength(0);
    expect((await client.queue.sent()).map((s) => s.outcome)).toEqual(['applied']);
    const l = await list(client);
    expect(stampOf(l, 'collect:o25').state).toBe('done');
    expect(stampOf(l, 'collect:o25').pending).toBeFalsy();
    expect(client.connection().pendingCount).toBe(0);
  });
});

describe('S6 작게(끊김 · 새로 고침 · 카운터 · 다시 연결)', () => {
  it('끊긴 채 기록한 것이 새로 고침을 넘어 남고, 다시 연결하면 결과 · 줄 메모가 오며 돈은 한 번씩 적힌다', async () => {
    const w = await world();
    let client = await online(w);
    // 산속: 서버에 닿지 않는다.
    w.server.down = true;
    w.clocks.advance(20 * 60_000);
    const collect29 = envelopeOf(await collectDraft(client, 'o29'));
    const pay = await client.query('fieldPaySheet', { taskId: 'collect:o28' });
    const pay28 = envelopeOf(pay);
    expect((await client.command(collect29)).outcome).toBe('queued');
    await waitFor(() => !client.connection().online, 'offline');
    expect((await client.command(pay28)).outcome).toBe('queued');
    const absent = await client.query('confirmDraft', { actionKey: 'not_collected', taskId: 'collect:o31', orderId: 'o31' }).catch(() => null);
    void absent;
    await idle(client);
    let l = await list(client);
    expect(stampOf(l, 'collect:o29').pending).toBe(true);
    expect(client.connection()).toMatchObject({ online: false, pendingCount: 2 });
    // 전송 대기 목록(§17 R3-19): 기기 번호 차례, 점선 도장이 없는 돈 기록도 팀 · 수단 · 금액과 함께.
    const listed = await client.pending();
    expect(listed.map((p) => p.summary)).toEqual([
      expect.stringMatching(/^이도윤 · 0029 수거 \d\d:\d\d$/), expect.stringMatching(/^윤서준 · 0028 현장 수납 현금 [\d,]+원 \d\d:\d\d$/),
    ]);
    expect(listed.every((p) => p.state === 'queued')).toBe(true);
    expect(listed[1]?.line).toMatchObject({ who: '윤서준 · 0028', what: '현장 수납', money: expect.stringMatching(/^현금 [\d,]+원$/) });
    // 연결이 있어야 하는 일은 한 줄, 전화는 사본의 온전한 번호.
    const receive = await client.command({ type: 'stock.receive', commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R9C0DM', basis: { epoch: 'x', rev: 1 }, payload: { vehicleId: 'v1', taskIds: [] } });
    expect(receive.error?.message).toBe('입고 불가 · 연결 끊김');
    expect((await client.query('phoneReveal', { orderId: 'o29' })).number).toBe('010-0000-0029');
    expect(await client.logout()).toBe('로그아웃 불가 · 전송 대기 2');

    // 새로 고침(끊긴 채): 같은 저장소의 새 클라이언트가 같은 목록 · 같은 점선.
    client.close();
    client = await open(w);
    client.start();
    await idle(client);
    l = await list(client);
    expect(stampOf(l, 'collect:o29').pending).toBe(true);
    expect(client.connection().pendingCount).toBe(2);
    expect((await client.fetchHead()).currentBusinessDate).toBe('2026-12-26');

    // 그사이 카운터: 이도윤(o29)이 매장에 직접 반납, 윤서준(o28)의 돈을 카운터에서 받음.
    const o29 = w.server.state.orders.find((o) => o.id === 'o29')!;
    expect(w.server.counter({ type: 'stock.direct_return', payload: { orderId: 'o29', lines: o29.lines.filter((x) => x.returnable).map((x) => ({ lineId: x.id, quantity: x.issued - x.returned })) } }).outcome).toBe('applied');
    const due = pay.expect?.dueAmount ?? 0;
    expect(w.server.counter({ type: 'payment.take', payload: { orderIds: ['o28'], amount: due, methodKey: 'cash' }, expect: { dueAmount: due } }).outcome).toBe('applied');

    // 다시 연결.
    w.server.down = false;
    w.clocks.advance(60_000);
    client.http.poke();
    await waitFor(async () => (await client.queue.list()).items.every((i) => i.state === 'answered') && client.connection().online, 'answered');
    await idle(client);
    const rows = w.server.rows(w.deviceId);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows.map((r) => r.timeSource)).toEqual(['wall_clock', 'wall_clock']);
    const byId = new Map(rows.map((r) => [r.requestId, r]));
    expect(byId.get(collect29.requestId)!.outcome.outcome).toBe('superseded');
    expect(byId.get(collect29.requestId)!.reviews).toContain('already_returned');
    expect(byId.get(pay28.requestId)!.reviews).toContain('possible_duplicate_money');
    // 돈: 카운터 한 번 + 기사 한 번(둘 다 적힌다, 확인 필요가 설명한다).
    expect(payments(w.server, 'o28')).toHaveLength(2);
    l = await list(client);
    // 이도윤은 모두 매장에 반납했다(받을 것 없음): 카운터의 목록에서는 빠지지만, 끊긴 채 수거한 이 기기의 목록에는 줄 메모 `매장 반납 완료`와 함께 남는다
    // (§5-9, 기사가 자기 기록이 어떻게 되었는지 본다).
    expect(l.rows.find((r) => r.taskId === 'collect:o29')?.reviewNote).toBe('매장 반납 완료');
    expect((await client.queue.sent()).find((s) => s.requestId === collect29.requestId)).toMatchObject({ outcome: 'superseded', reviews: ['already_returned'] });
    // 윤서준(o28)의 수거는 오늘 목록에 없다(다른 날 반납): 줄 메모 대신 보낸 기록이 `중복 수납 의심`을 안다(목록 · 업무 판의 자리는 화면 단계).
    expect((await client.queue.sent()).find((s) => s.requestId === pay28.requestId)?.reviews).toContain('possible_duplicate_money');
    expect(client.connection()).toMatchObject({ online: true, pendingCount: 0, settled: true });
    // 보낸 뒤의 띠에 줄 메모가 붙은 기록의 수(다른 쪽의 줄에 있어도 놓치지 않게, §17 R3-26).
    expect(client.connection().settledNotes).toEqual(expect.arrayContaining([{ note: '매장 반납 완료', count: 1 }, { note: '중복 수납 의심', count: 1 }]));
    expect(client.connection().settledNotes).toHaveLength(2);
    client.dismissResults();
    expect(client.connection().settled).toBeUndefined();
    expect(client.connection().settledNotes).toBeUndefined();
  });
});

describe('답을 잃음(O18)', () => {
  it('묶음의 답을 잃으면 결과 확인 중 → 다시 보내면 서버의 첫 결과(돈은 한 번)', async () => {
    const w = await world();
    const client = await online(w);
    w.server.fault('api/v2/commands:batch', 'lose-answer');
    const pay = await client.query('fieldPaySheet', { taskId: 'collect:o28' });
    expect((await client.command(envelopeOf(pay))).outcome).toBe('queued');
    await waitFor(async () => (await client.queue.list()).items[0]?.state === 'unconfirmed', 'unconfirmed');
    await waitFor(() => client.connection().unconfirmedCount === 1, 'band unconfirmed');
    expect(payments(w.server, 'o28')).toHaveLength(1);
    // 기다림 뒤 다시 보냄(같은 번호, 다시 서명).
    w.timers.advance(3_000);
    await waitFor(async () => (await client.queue.list()).items.length === 0, 'settled');
    expect(payments(w.server, 'o28')).toHaveLength(1);
    expect(w.server.rows(w.deviceId).map((r) => r.seq)).toEqual([1]);
    expect(w.server.calls.filter((c) => c.path === 'api/v2/commands:batch')).toHaveLength(2);
  });

  it('수거의 답을 잃으면 점선 도장의 누름 메모가 `결과 확인 중`', async () => {
    const w = await world();
    const client = await online(w);
    w.server.fault('api/v2/commands:batch', 'lose-answer');
    await client.command(envelopeOf(await collectDraft(client, 'o25')));
    await waitFor(async () => (await client.queue.list()).items[0]?.state === 'unconfirmed', 'unconfirmed');
    await client.localClient.reload('queue');
    expect(stampOf(await list(client), 'collect:o25').pressNote?.lines[0]).toMatch(/처리 · 결과 확인 중$/);
  });

  it('온라인 명령(매장 입고)의 답을 잃으면 `연결 끊김 · 결과 확인 중`, 새로 고침 뒤에도 남아 다음 연결에서 같은 봉투로 다시 보낸다', async () => {
    const w = await world();
    let client = await online(w);
    // 수거해 차에 싣는다(매장 입고할 것이 있게).
    await client.command(envelopeOf(await collectDraft(client, 'o25')));
    await idle(client);
    const receiveDraft = await client.query('confirmDraft', { actionKey: 'receive_to_shop', vehicleId: 'v1' });
    const receive = envelopeOf(receiveDraft);
    w.server.fault('api/v2/command', 'lose-answer');
    const out = await client.command(receive);
    expect(out.outcome).toBe('unknown');
    expect(out.error?.message).toBe('연결 끊김 · 결과 확인 중');
    expect(client.connection().unconfirmedCount).toBe(1);
    expect(w.server.log.get(receive.requestId)?.outcome.outcome).toBe('applied');
    // 새로 고침: 봉인해 둔 봉투가 남는다.
    client.close();
    w.server.down = true;
    client = await open(w);
    client.start();
    await idle(client);
    expect(client.connection().unconfirmedCount).toBe(1);
    // 전송 대기 목록에도 있다(띠의 수와 같게, §17 R3-19): 일 이름 `매장 입고`, 답을 잃음.
    const listed = await client.pending();
    expect(listed.map((p) => [p.requestId, p.state, p.line?.what])).toEqual([[receive.requestId, 'unconfirmed', '매장 입고']]);
    expect(listed).toHaveLength(client.connection().pendingCount);
    w.server.down = false;
    client.http.poke();
    await waitFor(() => (client.connection().unconfirmedCount ?? 0) === 0, 'resolved');
    const receives = w.server.calls.filter((c) => c.path === 'api/v2/command' && (c.body as { requestId?: string }).requestId === receive.requestId);
    expect(receives.length).toBeGreaterThanOrEqual(2);
    expect([...w.server.log.values()].filter((r) => r.outcome.requestId === receive.requestId)).toHaveLength(1);
  });
});

describe('연결이 있어야 하는 일 · 스위치', () => {
  it('보냄 대기를 비우지 못한 현금 인계는 `인계 불가 · 전송 대기 {n}`(서버에 보내지 않음)', async () => {
    const w = await world();
    const client = await online(w);
    w.server.fault('api/v2/commands:batch', { status: 409, code: 'BUSY' }, { status: 409, code: 'BUSY' }, { status: 409, code: 'BUSY' }, { status: 409, code: 'BUSY' }, { status: 409, code: 'BUSY' }, { status: 409, code: 'BUSY' });
    await client.command(envelopeOf(await client.query('fieldPaySheet', { taskId: 'collect:o28' })));
    const handover = await client.command({ type: 'cash.transfer', commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R9C0DN', basis: { epoch: w.server.state.epoch, rev: w.server.state.rev }, payload: { vehicleId: 'v1', amount: 10_000 } });
    expect(handover.error?.message).toBe('인계 불가 · 전송 대기 1');
    expect(w.server.calls.some((c) => c.path === 'api/v2/command')).toBe(false);
  });

  it('스위치를 끈 서버(localFirst off): 연결된 동안은 서버로 읽고 보내며, 보낸 뒤 답을 잃은 수거는 같은 요청번호로 보냄 대기에 들어가 한 번만 적힌다', async () => {
    const w = await world({ localFirst: false });
    const client = await online(w);
    const before = w.server.calls.filter((c) => c.path === 'api/v2/query').length;
    await list(client);
    expect(w.server.calls.filter((c) => c.path === 'api/v2/query').length).toBe(before + 1);
    const draft = await collectDraft(client, 'o25');
    const env = envelopeOf(draft);
    w.server.fault('api/v2/command', 'lose-answer');
    expect((await client.command(env)).outcome).toBe('queued');
    await waitFor(async () => (await client.queue.list()).items.length === 0, 'flushed');
    expect([...w.server.log.values()].filter((r) => r.requestId === env.requestId)).toHaveLength(1);
    // 서버는 온라인 행의 빈 기기 번호를 채운다(O9, 스위치를 끈 길에서만).
    expect(w.server.log.get(env.requestId)!.seq).toBe(1);
  });
});

describe('세션 끝 · 로그아웃(O14)', () => {
  it('로그인 만료(401)와 보낼 것: 세션 없는 전달로 보낸 뒤 사본을 지우고 알린다(보냄 대기 열쇠는 남음)', async () => {
    const w = await world();
    const client = await online(w);
    w.server.down = true;
    await client.command(envelopeOf(await collectDraft(client, 'o25')));
    await idle(client);
    w.server.down = false;
    w.server.endSession(w.session.csrf, 'SESSION_EXPIRED');
    client.http.poke();
    await waitFor(() => w.lost.length > 0, 'lost');
    expect(w.lost).toEqual(['SESSION_EXPIRED']);
    expect(w.server.rows(w.deviceId).map((r) => r.outcome.outcome)).toEqual(['applied']);
    expect(w.raw.size('snapshot')).toBe(0);
    expect(w.raw.peek('keys', 'queue:' + w.deviceId)).toBeDefined();
  });

  it('끊은 기기: 보낼 것을 전달(보류)한 뒤 두 열쇠까지 모두 지운다', async () => {
    const w = await world();
    const client = await online(w);
    w.server.down = true;
    await client.command(envelopeOf(await collectDraft(client, 'o25')));
    await idle(client);
    w.server.down = false;
    w.server.devices.get(w.deviceId)!.revoked = true;
    client.http.poke();
    await waitFor(() => w.lost.length > 0, 'lost');
    expect(w.lost).toEqual(['DEVICE_REVOKED']);
    expect(w.raw.size('keys')).toBe(0);
    expect(w.raw.size('queue')).toBe(0);
  });

  it('보낼 것이 없는 로그아웃은 세션을 끝내고 사본 · 사본 열쇠를 지운다(보낸 기록 · 번호는 남음)', async () => {
    const w = await world();
    const client = await online(w);
    await client.command(envelopeOf(await collectDraft(client, 'o25')));
    await idle(client);
    expect(await client.logout()).toBeNull();
    expect(w.raw.size('snapshot')).toBe(0);
    expect(w.raw.size('sent')).toBe(1);
    expect(w.raw.peek('counters', w.deviceId)).toMatchObject({ next: 2 });
    expect([...w.server.sessions.values()][0]!.open).toBe(false);
  });
});

describe('저장할 곳이 없는 기기(O2)', () => {
  it('보냄 대기에 넣지 못하면 `전송 실패 · 재전송 필요`, 그 뒤로는 연결된 동안 서버로 바로 보낸다', async () => {
    const w = await world();
    const client = await online(w);
    const draft = await collectDraft(client, 'o25');
    w.raw.failWrites = 'QuotaExceededError';
    const first = await client.command(envelopeOf(draft));
    expect(first.error?.message).toBe('전송 실패 · 재전송 필요');
    expect(client.connection().recordingOff).toBe(true);
    const again = await client.command(envelopeOf(draft));
    expect(again.outcome).toBe('applied');
    expect(w.server.rows(w.deviceId).map((r) => r.seq)).toEqual([null]);
    w.raw.failWrites = null;
  });
});

describe('기억한 세션 · 앱 잠금(O15)', () => {
  it('돌기 시작하면 세션을 봉인해 기억하고, 온라인 로그인의 비밀번호로 확인 값을 만든다: 서버 없이 열 수 있고 5분 뒤에는 잠금', async () => {
    const w = await world();
    const client = await online(w);
    await client.setVerifier('4821');
    await waitFor(async () => isRemembered(await client.local.readSessionRecord(REMEMBERED_ID)), 'remembered');
    const store = new LocalStore({ raw: w.raw, deviceId: w.deviceId, channel: null });
    const meta = await store.readMeta();
    const head = await store.copyHead();
    const input = {
      record: await store.readSessionRecord(REMEMBERED_ID) as never, copyOk: head !== null, verifier: (await store.readSessionRecord(VERIFIER_ID)) !== null, meta,
      policy: { piiWipeHours: 24, appLockMinutes: 5, clockWarnMinutes: 2 },
    };
    expect(rememberedStart({ ...input, now: w.clocks.wall() + 60_000 }).decision).toBe('open');
    expect(rememberedStart({ ...input, now: w.clocks.wall() + 6 * 60_000 }).decision).toBe('locked');
  });

  it('잠금 풀기: 맞으면 ok(틀린 수 0), 틀리면 wrong, 다섯 번 틀리면 5분 잠김(기억한 세션은 남는다, §17 R3-24)', async () => {
    const w = await world();
    const client = await online(w);
    await client.setVerifier('4821');
    expect(await client.lockDue()).toEqual({ due: false, needLogin: false });
    w.clocks.advance(6 * 60_000);
    expect(await client.lockDue()).toEqual({ due: true, needLogin: false });
    expect(await client.unlock('4821')).toEqual({ answer: 'ok' });
    expect(await client.lockDue()).toEqual({ due: false, needLogin: false });
    for (let i = 0; i < 4; i += 1) expect((await client.unlock('0000')).answer).toBe('wrong');
    const until = w.clocks.wall() + 5 * 60_000;
    expect(await client.unlock('0000')).toEqual({ answer: 'locked', until });
    expect(await client.lockDue()).toEqual({ due: true, needLogin: false, until });
    expect(await client.unlock('4821')).toEqual({ answer: 'locked', until });
    expect(await client.local.readSessionRecord(REMEMBERED_ID)).not.toBeNull();
  });

  it('로그아웃하면 기억한 세션 · 확인 값이 사본과 함께 지워진다', async () => {
    const w = await world();
    const client = await online(w);
    await client.setVerifier('4821');
    await waitFor(async () => (await client.local.readSessionRecord(REMEMBERED_ID)) !== null, 'remembered');
    expect(await client.logout()).toBeNull();
    const store = new LocalStore({ raw: w.raw, deviceId: w.deviceId, channel: null });
    expect(await store.readSessionRecord(REMEMBERED_ID)).toBeNull();
    expect(await store.readSessionRecord(VERIFIER_ID)).toBeNull();
  });
});

describe('띠 · 막힘(§8-1 · O18)', () => {
  it('연결된 채 누른 도장: 보내기 2초 전은 띠를 그리지 않는다(flushing), 답이 오면 없음', async () => {
    const w = await world();
    const client = await online(w);
    w.server.hold('api/v2/commands:batch');
    await client.command(envelopeOf(await collectDraft(client, 'o25')));
    await waitFor(() => client.connection().flushing === true, 'flushing');
    expect(client.connection().sending).toBeUndefined();
    w.server.release('api/v2/commands:batch');
    await idle(client);
    expect(client.connection().flushing).toBeUndefined();
  });

  it('답을 잃은 온라인 명령이 풀리기 전의 새 온라인 명령은 보내지 않고 `연결 끊김 · 결과 확인 중`', async () => {
    const w = await world();
    const client = await online(w);
    await client.command(envelopeOf(await collectDraft(client, 'o25')));
    await idle(client);
    const receive = envelopeOf(await client.query('confirmDraft', { actionKey: 'receive_to_shop', vehicleId: 'v1' }));
    w.server.fault('api/v2/command', 'lose-answer', 'lose-answer', 'lose-answer');
    expect((await client.command(receive)).outcome).toBe('unknown');
    const handover = { type: 'cash.transfer' as const, commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R9C0DP', basis: { epoch: w.server.state.epoch, rev: w.server.state.rev }, payload: { vehicleId: 'v1', amount: 10_000 } };
    const out = await client.command(handover);
    expect(out.outcome).toBe('unknown');
    expect(out.error?.message).toBe('연결 끊김 · 결과 확인 중');
    expect(w.server.calls.some((c) => c.path === 'api/v2/command' && (c.body as { requestId?: string }).requestId === handover.requestId)).toBe(false);
  });
});

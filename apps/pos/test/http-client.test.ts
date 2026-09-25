// 서버 클라이언트(HttpClient, 계획 work/impl-server/plan.md 6-2 · 6-6 http-client.test): 가짜 fetch · EventSource로 CSRF 머리(POST만),
// 상대 주소, 같은 본문으로 다시 보내기, 401 → 세션 끝, 실패 코드 옮기기, 알림 연결의 머리 · 설정 판, 끊긴 동안 머리 묻기, 연결 상태.
import { DomainError, type AnyCommandEnvelope, type CommandOutcome, type SessionInfo, type SyncHead } from '@skinote/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient, type EventSourceLike } from '../src/app/http-client.ts';

const SESSION: SessionInfo = {
  shop: { name: '시험 매장' },
  staff: { id: '01J00000000000000000000001', name: '김카운터', roleKey: 'counter' },
  device: { id: '01J00000000000000000000002', kind: 'pos', label: '카운터 1' },
  csrf: 'c'.repeat(43),
  idleTimeoutS: 28_800,
  serverTime: '2026-12-26T06:40:00.000Z',
};
const BASE = 'https://pos.example/app/';

interface Call { url: string; method: string; headers: Record<string, string>; body: string | undefined }
type Answer = Response | Error | (() => Promise<Response>);

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const apiError = (status: number, code: string) => json(status, { ok: false, service: 'skinote', code });

/** 차례로 답하는 가짜 fetch(모자라면 마지막 답을 되풀이). */
function fakeFetch(answers: Answer[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string | undefined });
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next.clone();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

class FakeStream implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly handlers = new Map<string, ((event: MessageEvent) => void)[]>();
  readonly url: string;
  constructor(url: string) { this.url = url; }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
  }
  close(): void { this.closed = true; this.readyState = 2; }
  open(): void { this.readyState = 1; this.onopen?.(new Event('open')); }
  send(type: string, data: unknown): void { for (const h of this.handlers.get(type) ?? []) h(new MessageEvent(type, { data: JSON.stringify(data) })); }
  fail(closed: boolean): void { this.readyState = closed ? 2 : 0; this.onerror?.(new Event('error')); }
}

function setup(answers: Answer[], extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  const f = fakeFetch(answers);
  const streams: FakeStream[] = [];
  const lost: string[] = [];
  const logs: string[] = [];
  // 넘기기 지연은 따로 본다(아래 '넘기기 지연'): 다른 시험은 한 번의 실패 · 성공으로 넘어가는 모양으로 본다.
  const client = new HttpClient({
    session: SESSION, baseUrl: BASE, fetch: f.fetch, eventSource: (url) => { const s = new FakeStream(url); streams.push(s); return s; },
    onSessionLost: (code) => lost.push(code), retryDelaysMs: [1, 1, 1], log: (m) => logs.push(m), failuresToOffline: 1, recoverMs: 0, ...extra,
  });
  return { client, calls: f.calls, streams, lost, logs };
}

const ENVELOPE = {
  type: 'payment.take', commandVersion: 1, requestId: '01J0000000000000000000000R', basis: { epoch: 'e1', rev: 3 },
  payload: { orderId: 'o1', amount: 10_000, methodKey: 'cash' },
} as unknown as AnyCommandEnvelope;
const APPLIED: CommandOutcome = { outcome: 'applied', requestId: ENVELOPE.requestId, rev: 4, asOfRev: 3, epoch: 'e1', rebased: false, changes: [] };
const HEAD = { epoch: 'e1', rev: 3, configRev: 1, serverTime: '2026-12-26T06:40:00.000Z', currentBusinessDate: '2026-12-26' };

describe('요청 모양', () => {
  it('상대 주소 · 같은 곳 쿠키 · POST만 JSON과 CSRF 머리', async () => {
    const { client, calls } = setup([json(200, { rows: [] }), json(200, HEAD)]);
    await client.ledgerView('day_ledger', { tabKey: 'all' });
    await client.fetchHead();
    expect(calls[0]).toMatchObject({ url: 'https://pos.example/app/api/v2/query', method: 'POST' });
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.headers['x-skinote-csrf']).toBe(SESSION.csrf);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ name: 'ledgerView', params: { viewKey: 'day_ledger', tabKey: 'all' } });
    expect(calls[1]).toMatchObject({ url: 'https://pos.example/app/api/v2/head', method: 'GET' });
    expect(calls[1]!.headers['x-skinote-csrf']).toBeUndefined();
    expect(calls[1]!.body).toBeUndefined();
  });

  it('조회는 이름과 인자 그대로', async () => {
    const { client, calls } = setup([json(200, { matches: [] })]);
    await client.query('findLast4', { last4: '0042' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ name: 'findLast4', params: { last4: '0042' } });
  });
});

describe('조회 실패 옮기기', () => {
  const failing = async (answer: Answer) => {
    const t = setup([answer]);
    const error = await t.client.query('orderSlip', { orderId: 'o9' }).then(() => null, (e: unknown) => e);
    return { error: error as DomainError, t };
  };

  it('404 → NOT_FOUND, 400 모르는 화면 · 조회 → UNKNOWN_VIEW, 403 권한 · 범위 밖 → FORBIDDEN(업무 없음으로 숨기지 않음, 다시 읽지 않음)', async () => {
    expect((await failing(apiError(404, 'NOT_FOUND'))).error.code).toBe('NOT_FOUND');
    expect((await failing(apiError(400, 'UNKNOWN_VIEW'))).error.code).toBe('UNKNOWN_VIEW');
    expect((await failing(apiError(400, 'UNKNOWN_QUERY'))).error.code).toBe('UNKNOWN_VIEW');
    const forbidden = await failing(apiError(403, 'FORBIDDEN'));
    expect(forbidden.error.code).toBe('FORBIDDEN');
    expect(forbidden.t.client.connection().online).toBe(true);
    expect((await failing(apiError(403, 'FORBIDDEN_SCOPE'))).error.code).toBe('FORBIDDEN');
  });

  it('401 → 세션 끝(한 번만 알림) + NETWORK, CSRF 불일치도 세션 끝', async () => {
    const { error, t } = await failing(apiError(401, 'SESSION_EXPIRED'));
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('NETWORK');
    expect(t.lost).toEqual(['SESSION_EXPIRED']);
    await t.client.query('orderSlip', { orderId: 'o9' }).catch(() => {});
    expect(t.lost).toEqual(['SESSION_EXPIRED']);
    expect((await failing(apiError(403, 'BAD_CSRF'))).t.lost).toEqual(['BAD_CSRF']);
  });

  it('연결 없음 · 앞단의 502(HTML) · 500 → NETWORK이고 연결 끊김', async () => {
    for (const answer of [new TypeError('network'), new Response('<html>', { status: 502, headers: { 'content-type': 'text/html' } }), apiError(500, 'INTERNAL')]) {
      const { error, t } = await failing(answer);
      expect(error.code).toBe('NETWORK');
      expect(t.client.connection().online).toBe(false);
    }
  });
});

describe('명령', () => {
  it('연결 없음 · 503이면 같은 본문으로 다시 보내 적용된 결과를 받는다', async () => {
    const { client, calls } = setup([new TypeError('network'), apiError(503, 'SHOP_UNAVAILABLE'), json(200, APPLIED)]);
    expect(await client.command(ENVELOPE)).toEqual(APPLIED);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.body)).size).toBe(1);
    expect(JSON.parse(calls[0]!.body!).requestId).toBe(ENVELOPE.requestId);
    expect(client.connection().online).toBe(true);
  });

  it('다시 보내도 안 되면 NETWORK(창이 초안을 쥐고 같은 요청번호로 다시 보낸다)', async () => {
    const { client, calls } = setup([new TypeError('network')]);
    await expect(client.command(ENVELOPE)).rejects.toMatchObject({ code: 'NETWORK' });
    expect(calls).toHaveLength(4);
  });

  it('서버가 모양을 거절하면(400) 거절 결과 BAD_INPUT · 처리 실패 한 줄, 개발자 줄을 남긴다', async () => {
    const { client, logs, calls } = setup([apiError(400, 'BAD_INPUT')]);
    const outcome = await client.command(ENVELOPE);
    expect(outcome).toMatchObject({ outcome: 'rejected', requestId: ENVELOPE.requestId, error: { code: 'BAD_INPUT', message: '처리 실패 · 재시도 필요' } });
    expect(calls).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  it('401 → 세션 끝 + NETWORK(다시 보내지 않음)', async () => {
    const { client, calls, lost } = setup([apiError(401, 'SIGNED_OUT')]);
    await expect(client.command(ENVELOPE)).rejects.toMatchObject({ code: 'NETWORK' });
    expect(calls).toHaveLength(1);
    expect(lost).toEqual(['SIGNED_OUT']);
  });

  it('업무 거절(권한 없음)은 200 결과 그대로', async () => {
    const refused: CommandOutcome = { ...APPLIED, outcome: 'rejected', rev: 3, error: { code: 'FORBIDDEN', message: '권한 없음 · 관리자 확인 필요' } };
    const { client } = setup([json(200, refused)]);
    expect(await client.command(ENVELOPE)).toEqual(refused);
  });

  it('적용된 명령의 rev가 알던 머리보다 크면 곧바로 알린다', async () => {
    const { client, streams } = setup([json(200, APPLIED)]);
    const seen: SyncHead[] = [];
    client.subscribe((head) => seen.push(head));
    client.start();
    streams[0]!.send('head', { epoch: 'e1', rev: 3, configRev: 1 });
    await client.command(ENVELOPE);
    expect(seen.map((h) => h.rev)).toEqual([4]);
    client.close();
  });
});

describe('알림 연결 · 머리 묻기 · 연결 상태', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('rev가 바뀌면 알리고, configRev가 바뀌면 설정을 다시 받는다', async () => {
    const { client, streams, calls } = setup([json(200, { configRev: 1, shopName: '시험 매장' }), json(200, { configRev: 2, shopName: '시험 매장' })]);
    const seen: SyncHead[] = [];
    client.subscribe((head) => seen.push(head));
    client.start();
    const stream = streams[0]!;
    expect(stream.url).toBe('https://pos.example/app/api/v2/stream');
    stream.open();
    stream.send('head', { epoch: 'e1', rev: 3, configRev: 1 });
    expect(seen).toEqual([]);
    await client.config();
    await client.config();
    expect(calls).toHaveLength(1);
    stream.send('head', { epoch: 'e1', rev: 4, configRev: 1 });
    stream.send('head', { epoch: 'e1', rev: 4, configRev: 1 });
    stream.send('head', { epoch: 'e1', rev: 5, configRev: 2 });
    expect(seen.map((h) => [h.rev, h.configRev])).toEqual([[4, 1], [5, 2]]);
    expect((await client.config()).configRev).toBe(2);
    expect(calls).toHaveLength(2);
    client.close();
    expect(stream.closed).toBe(true);
  });

  it('닫힌 알림 연결: 간격마다 머리를 묻고, 되면 다시 연다. 머리도 안 되면 연결 끊김 → 되면 연결됨', async () => {
    const { client, streams, calls } = setup([new TypeError('network'), json(200, { ...HEAD, rev: 7 })], { pollMs: 5_000 });
    const seen: boolean[] = [];
    client.subscribe(() => seen.push(client.connection().online));
    client.start();
    streams[0]!.send('head', { epoch: 'e1', rev: 3, configRev: 1 });
    streams[0]!.fail(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.map((c) => c.url)).toEqual(['https://pos.example/app/api/v2/head']);
    expect(client.connection().online).toBe(false);
    expect(client.connection().lastSyncAt).toBeTypeOf('string');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.connection().online).toBe(true);
    expect(seen).toEqual([false, true, true]);
    expect(streams).toHaveLength(2);
    client.close();
  });

  it('여는 중(다시 붙는 중)인 알림 연결은 브라우저에 맡기고 머리만 묻는다', async () => {
    const { client, streams, calls } = setup([json(200, HEAD)], { pollMs: 5_000 });
    client.start();
    streams[0]!.fail(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
    expect(streams).toHaveLength(1);
    streams[0]!.open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    client.close();
  });

  it('`bye`(기기 끊김 · 로그아웃) → 머리를 물어 401이면 세션 끝', async () => {
    const { client, streams, lost } = setup([apiError(401, 'DEVICE_REVOKED')]);
    client.start();
    streams[0]!.open();
    streams[0]!.send('bye', { reason: 'device_revoked' });
    await vi.advanceTimersByTimeAsync(0);
    expect(lost).toEqual(['DEVICE_REVOKED']);
    expect(streams[0]!.closed).toBe(true);
  });

  it('살아 보이는 알림 연결도 30초 동안 주고받은 것이 없으면 머리를 묻고, 안 되면 닫고 끊김(죽은 연결)', async () => {
    const { client, streams, calls } = setup([new TypeError('network'), json(200, HEAD)], { pollMs: 5_000, heartbeatMs: 30_000 });
    client.start();
    streams[0]!.open();
    streams[0]!.send('head', { epoch: 'e1', rev: 3, configRev: 1 });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.map((c) => c.url)).toEqual(['https://pos.example/app/api/v2/head']);
    expect(client.connection().online).toBe(false);
    expect(streams[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.connection().online).toBe(true);
    expect(streams).toHaveLength(2);
    client.close();
  });

  it('기기의 네트워크 사건: offline이면 곧바로 끊김 · 알림 연결 닫음, online이면 곧바로 머리를 묻는다', async () => {
    const net = new EventTarget();
    const { client, streams, calls } = setup([json(200, HEAD)], { pollMs: 60_000, networkEvents: net });
    client.start();
    streams[0]!.open();
    net.dispatchEvent(new Event('offline'));
    expect(client.connection().online).toBe(false);
    expect(streams[0]!.closed).toBe(true);
    net.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(client.connection().online).toBe(true);
    expect(streams).toHaveLength(2);
    client.close();
    net.dispatchEvent(new Event('offline'));
    expect(client.connection().online).toBe(true);
  });

  it('보냄 대기는 없다(서버 모드는 온라인만)', async () => {
    const { client } = setup([json(200, HEAD)]);
    expect(await client.pending()).toEqual([]);
    expect(client.connection()).toMatchObject({ online: true, pendingCount: 0 });
  });

  it('로그아웃: POST 뒤 알림 연결 · 머리 묻기를 멈춘다', async () => {
    const { client, streams, calls } = setup([new Response(null, { status: 204 })], { pollMs: 1_000 });
    client.start();
    await client.logout();
    expect(calls[0]).toMatchObject({ url: 'https://pos.example/app/api/v2/logout', method: 'POST' });
    expect(calls[0]!.headers['x-skinote-csrf']).toBe(SESSION.csrf);
    expect(streams[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
  });
});

describe('넘기기 지연(sync 8-1 · ui 4-3): 띠 · 이름표가 깜빡이지 않는다', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('한 번의 실패는 끊김이 아니다: 연속 두 번이면 끊김, 사이에 성공이 있으면 다시 센다', async () => {
    const { client } = setup([new Error('x'), json(200, HEAD), new Error('x'), new Error('x')], { failuresToOffline: 2, recoverMs: 10_000, eventSource: null });
    const changes: boolean[] = [];
    client.subscribe(() => changes.push(client.connection().online));
    await client.fetchHead().catch(() => {});
    expect(client.connection().online).toBe(true);
    await client.fetchHead();
    await client.fetchHead().catch(() => {});
    expect(client.connection().online, 'the success in between reset the count').toBe(true);
    await client.fetchHead().catch(() => {});
    expect(client.connection().online).toBe(false);
    expect(changes).toEqual([false]);
  });

  it('끊긴 뒤 답이 되어도 10초 동안 실패가 없어야 다시 연결됨: 그 사이 실패는 셈을 되돌린다', async () => {
    const { client } = setup([new Error('x'), new Error('x'), json(200, HEAD), new Error('x'), json(200, HEAD)], { failuresToOffline: 2, recoverMs: 10_000, eventSource: null });
    await client.fetchHead().catch(() => {});
    await client.fetchHead().catch(() => {});
    expect(client.connection().online).toBe(false);
    await client.fetchHead();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(client.connection().online, 'not yet: 9 s of good answers').toBe(false);
    await client.fetchHead().catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.connection().online, 'a failure restarted the wait').toBe(false);
    await client.fetchHead();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.connection().online).toBe(true);
    client.close();
  });

  it('기기가 네트워크를 잃으면(offline 사건) 곧바로 끊김', async () => {
    const events = new EventTarget();
    const { client } = setup([json(200, HEAD)], { failuresToOffline: 2, recoverMs: 10_000, networkEvents: events, eventSource: null });
    client.start();
    events.dispatchEvent(new Event('offline'));
    expect(client.connection().online).toBe(false);
    client.close();
  });
});

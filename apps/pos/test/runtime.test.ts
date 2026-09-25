// 어느 클라이언트로 돌지(계획 work/impl-server/plan.md D7 · 6-6 runtime.test): 표시 없음 → 체험판(서버에 묻지 않음), 표시가 있으면 ?demo도 서버,
// 표시 + 200 → 서버(세션), 표시 + 401 → 서버(로그아웃 상태), 그 밖(404 · HTML · 연결 없음 · 시간 초과 · 502) → 연결 끊김(체험판 아님).
import type { SessionInfo } from '@skinote/contract';
import { describe, expect, it, vi } from 'vitest';
import { decideMode, isSessionInfo, probeSession, readRuntimeMarker, wantsDemo, type SessionProbe } from '../src/app/runtime.ts';

const SESSION: SessionInfo = {
  shop: { name: '시험 매장' },
  staff: { id: '01J00000000000000000000001', name: '김카운터', roleKey: 'counter' },
  device: { id: '01J00000000000000000000002', kind: 'pos', label: '카운터 1' },
  csrf: 'x'.repeat(43),
  idleTimeoutS: 28_800,
  serverTime: '2026-12-26T06:40:00.000Z',
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const html = (status: number) => new Response('<html>bad gateway</html>', { status, headers: { 'content-type': 'text/html' } });
const fetchOf = (answer: () => Promise<Response>) => vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => answer()) as unknown as typeof fetch;

describe('모드 고르기(D7)', () => {
  it('표시가 없으면 체험판이고 서버에 묻지 않는다', async () => {
    const probe = vi.fn(async (): Promise<SessionProbe> => ({ kind: 'session', session: SESSION }));
    expect(await decideMode({ marker: null, search: '', probe })).toEqual({ mode: 'demo' });
    expect(await decideMode({ marker: 'desktop', search: '', probe })).toEqual({ mode: 'demo' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('?demo는 표시가 있으면 무시한다: 우리 주소의 ?demo 링크 · 설치한 앱이 기기 안의 가짜 장부로 가지 않는다', async () => {
    const probe = vi.fn(async (): Promise<SessionProbe> => ({ kind: 'signed_out', code: 'SIGNED_OUT' }));
    expect(await decideMode({ marker: 'server', search: '?demo', probe })).toEqual({ mode: 'server', session: null });
    expect(await decideMode({ marker: 'server', search: '?x=1&demo=1', probe })).toEqual({ mode: 'server', session: null });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(await decideMode({ marker: null, search: '?demo', probe })).toEqual({ mode: 'demo' });
    expect([wantsDemo(''), wantsDemo('?demo'), wantsDemo('?demos')]).toEqual([false, true, false]);
  });

  it('표시가 서버면 늘 서버 모드: 세션 · 로그아웃 상태 · 연결 끊김(던져도 연결 끊김)', async () => {
    expect(await decideMode({ marker: 'server', search: '', probe: async () => ({ kind: 'session', session: SESSION }) })).toEqual({ mode: 'server', session: SESSION });
    expect(await decideMode({ marker: 'server', search: '', probe: async () => ({ kind: 'signed_out', code: 'SIGNED_OUT' }) })).toEqual({ mode: 'server', session: null });
    expect(await decideMode({ marker: 'server', search: '', probe: async () => ({ kind: 'offline' }) })).toEqual({ mode: 'server-offline' });
    expect(await decideMode({ marker: 'server', search: '', probe: async () => { throw new Error('boom'); } })).toEqual({ mode: 'server-offline' });
  });

  it('앱 뼈대의 표시 읽기', () => {
    const doc = (content: string | null) => ({
      querySelector: (selector: string) => (content !== null && selector === 'meta[name="skinote-runtime"]' ? { getAttribute: () => content } : null),
    }) as unknown as Pick<Document, 'querySelector'>;
    expect(readRuntimeMarker(doc('server'))).toBe('server');
    expect(readRuntimeMarker(doc(null))).toBeNull();
    expect(readRuntimeMarker(undefined)).toBeNull();
  });
});

describe('세션 묻기(GET api/v2/session)', () => {
  const url = 'https://pos.example/api/v2/session';

  it('200 + SessionInfo → 세션, 모양이 틀린 200은 연결 끊김', async () => {
    expect(await probeSession(fetchOf(async () => json(200, SESSION)), url)).toEqual({ kind: 'session', session: SESSION });
    expect(await probeSession(fetchOf(async () => json(200, { ok: true, service: 'skinote' })), url)).toEqual({ kind: 'offline' });
    expect(isSessionInfo({ ...SESSION, device: { ...SESSION.device, kind: 'laptop' } })).toBe(false);
  });

  it('우리 서버의 401 → 로그아웃 상태(코드 그대로)', async () => {
    expect(await probeSession(fetchOf(async () => json(401, { ok: false, service: 'skinote', code: 'SESSION_EXPIRED', state: 'signed_out' })), url))
      .toEqual({ kind: 'signed_out', code: 'SESSION_EXPIRED' });
    expect(await probeSession(fetchOf(async () => json(401, { ok: false, service: 'skinote', code: 'DEVICE_REVOKED' })), url))
      .toEqual({ kind: 'signed_out', code: 'DEVICE_REVOKED' });
  });

  it('404(API 끔 · 옛 판) · HTML · 502 · 다른 곳의 401 · 연결 없음 · 시간 초과 → 연결 끊김', async () => {
    const offline = { kind: 'offline' };
    expect(await probeSession(fetchOf(async () => json(404, { ok: false, error: 'not_found' })), url)).toEqual(offline);
    expect(await probeSession(fetchOf(async () => html(404)), url)).toEqual(offline);
    expect(await probeSession(fetchOf(async () => html(502)), url)).toEqual(offline);
    expect(await probeSession(fetchOf(async () => json(401, { message: 'proxy auth' })), url)).toEqual(offline);
    expect(await probeSession(fetchOf(async () => { throw new TypeError('network'); }), url)).toEqual(offline);
    const hanging = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    expect(await probeSession(hanging, url, 20)).toEqual(offline);
  });

  it('같은 곳 쿠키로 GET(저장하지 않음)', async () => {
    const f = fetchOf(async () => json(200, SESSION));
    await probeSession(f, url);
    const init = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    expect([init.method, init.credentials, init.cache]).toEqual(['GET', 'same-origin', 'no-store']);
  });
});

// 기기의 알림(work/impl-offline/plan.md §4-1 · O11, §7-9 report.test): 대기 · 결과 확인 중 · 가장 오래된 것 · 막힌 번호(이 판만) · 앱 판 모양, 화면이 가려지면
// keepalive 알림 한 번(visibility hidden), 다시 보이면 심장 박동.
import { parseDeviceReport } from '@skinote/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { DriverClient, type Visibility } from '../src/local/driver-client.ts';
import { PageLocks } from '../src/local/local-store.ts';
import type { QueueItem } from '../src/local/queue.ts';
import { MemoryRawStore } from '../src/local/raw-store.ts';
import { localWords } from '../src/app/strings.ts';
import { HttpClient } from '../src/app/http-client.ts';
import { appVersionOf, deviceReport } from '../src/local/report.ts';
import { at, BASE, FakeServer, ManualTimers, ORIGIN, TestClocks } from './fake-server.ts';

const item = (seq: number, state: QueueItem['state'], extra: Partial<QueueItem> = {}): QueueItem => ({
  fmt: 1, requestId: 'r' + seq, seq, deviceId: 'd', type: 'task.visit', state, attempts: 0, madeOffline: true, createdWall: 1_000 * seq, createdMono: 0,
  pageAnchor: 'p', offsetAtCreate: 500, core: {} as QueueItem['core'], ...extra,
});

describe('deviceReport', () => {
  it('답을 받은 것은 세지 않고, 가장 오래된 것은 서버 시각 짐작, 막힌 번호는 이 판의 것만', () => {
    const report = deviceReport({
      items: [item(1, 'answered'), item(2, 'unconfirmed'), item(3, 'queued', { stuckVersion: 'old' }), item(4, 'queued', { stuckVersion: 'v 1+' })],
      lastSeq: 4, clockOffsetMs: -420.4, appVersion: 'v 1+', offlineCapable: true, localFirst: true, visibility: 'visible', unreadable: 0, copy: { epoch: 'e', rev: 3 },
    });
    expect(report).toEqual({
      pendingCount: 3, unconfirmedCount: 1, oldestPendingAt: new Date(2_500).toISOString(), lastSeq: 4, clockOffsetMs: -420, appVersion: 'v1', offlineCapable: true,
      localFirst: true, visibility: 'visible', unreadable: 0, stuckSeq: 4, copy: { epoch: 'e', rev: 3 },
    });
    // 서버의 검사를 지난다(개인정보 없음).
    expect(parseDeviceReport(report).ok).toBe(true);
    expect(appVersionOf('한글 판')).toBe('dev');
    expect(appVersionOf('x'.repeat(60))).toHaveLength(40);
  });
});

describe('가려질 때의 마지막 알림(O11)', () => {
  let client: DriverClient | null = null;
  afterEach(() => client?.close());

  it('화면이 가려지면 keepalive로 hidden 알림 한 번, 다시 보이면 곧바로 심장 박동', async () => {
    const clocks = new TestClocks(at(21, 0));
    const server = new FakeServer(() => clocks.wall());
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const deviceId = server.enroll('driver_phone', 'v1', pair.publicKey);
    const session = server.login(deviceId, 'staff-3');
    let listener: ((visible: boolean) => void) | null = null;
    let visible = true;
    const visibility: Visibility = { visible: () => visible, listen: (fn) => { listener = fn; return () => { listener = null; }; } };
    client = await DriverClient.open({
      session, raw: new MemoryRawStore(), deviceKey: pair.privateKey, origin: ORIGIN, baseUrl: BASE, appVersion: 'test', fetch: server.fetch,
      eventSource: null, networkEvents: null, channel: null, locks: new PageLocks(), clocks, timers: new ManualTimers(), visibility, failuresToOffline: 1, recoverMs: 0,
      retryDelaysMs: [], log: () => {}, words: localWords(), makeHttp: (o) => new HttpClient(o),
    });
    client.start();
    const beats = () => server.calls.filter((c) => c.path === 'api/v2/heartbeat');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = beats().length;
    visible = false;
    listener!(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const hidden = beats().slice(before);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.keepalive).toBe(true);
    expect((hidden[0]!.body as { report: { visibility: string } }).report.visibility).toBe('hidden');
    visible = true;
    listener!(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = beats().slice(before + 1);
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect((after[0]!.body as { report: { visibility: string } }).report.visibility).toBe('visible');
    expect(after[0]!.keepalive).toBeUndefined();
  });
});

describe('네 번째 검토(§18)', () => {
  it('R4-4: 답을 잃은 온라인 명령은 대기 · 결과 확인 중에 들고, 가장 오래된 때도 본다', () => {
    const report = deviceReport({
      items: [item(1, 'queued')], lastSeq: 1, clockOffsetMs: 100, appVersion: 'v1', offlineCapable: true, localFirst: true, visibility: 'visible', unreadable: 0,
      onlinePending: [{ at: 900 }],
    });
    expect([report.pendingCount, report.unconfirmedCount, report.oldestPendingAt]).toEqual([2, 1, new Date(1_000).toISOString()]);
  });

  it('R4-8: 366일 넘게 틀린 시계도 알림은 서버의 검사를 지난다(한도로 자른다: 서버는 여전히 시계 확인으로 본다)', () => {
    for (const offset of [400 * 86_400_000, -400 * 86_400_000]) {
      const report = deviceReport({ items: [], lastSeq: 0, clockOffsetMs: offset, appVersion: 'v1', offlineCapable: true, localFirst: true, visibility: 'visible', unreadable: 0 });
      expect(Math.abs(report.clockOffsetMs)).toBe(366 * 86_400_000);
      expect(parseDeviceReport(report).ok).toBe(true);
    }
  });
});

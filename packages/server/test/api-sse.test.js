// @ts-check
// 알림 연결(plan §5-4): 연결하자마자 지금 머리, 다른 세션의 명령이 COMMIT되면 1초 안에 새 rev, 짧게 줄인 심장 박동(: ping), 로그아웃 ·
// 기기 끊기 · 서버 닫기에 bye로 닫힘, 한 세션에 4개까지(5번째 429), 쿠키 없는 연결은 401.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { newRequestId } from '@skinote/contract';
import { startServer } from '../src/server.js';
import { device, deviceCode, provisionedShop, SHOP, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

/**
 * 알림 연결을 열고 받은 사건을 모은다.
 * @param {ReturnType<typeof device>} who
 */
async function openStream(who) {
  const res = await who.get('/api/v2/stream');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  /** @type {{ event: string, data: any }[]} */
  const events = [];
  let pings = 0;
  let ended = false;
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (block.startsWith(': ping')) { pings += 1; continue; }
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event) events.push({ event, data: data ? JSON.parse(data) : null });
        }
      }
    } catch {
      /* 끊음 */
    }
    ended = true;
  })();
  /** @param {(e: { event: string, data: any }) => boolean} match @param {number} [timeoutMs] */
  const waitFor = async (match, timeoutMs = 1_000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const found = events.find(match);
      if (found) return found;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('사건이 오지 않았습니다: ' + JSON.stringify(events));
  };
  return {
    events,
    waitFor,
    get pings() { return pings; },
    get ended() { return ended; },
    waitEnded: async (timeoutMs = 1_000) => {
      const until = Date.now() + timeoutMs;
      while (!ended && Date.now() < until) await new Promise(r => setTimeout(r, 5));
      return ended;
    },
    close: async () => { await reader.cancel().catch(() => {}); await pump; },
  };
}

async function setup(/** @type {string} */ name, /** @type {number} */ pingMs = 25_000) {
  const dataDir = join(temp.dir, name);
  const shop = await provisionedShop(dataDir);
  const codes = [await deviceCode(shop.env), await deviceCode(shop.env, ['--kind', 'pos', '--label', '카운터 2'])];
  const app = await startServer(testConfig(dataDir, shop.env), { log: () => {}, pingMs });
  const a = device(app.port);
  const b = device(app.port);
  await a.enroll(/** @type {string} */ (codes[0]));
  await b.enroll(/** @type {string} */ (codes[1]));
  assert.equal((await a.login('정하늘', /** @type {string} */ (shop.pins['정하늘']))).status, 200);
  assert.equal((await b.login('김카운터', /** @type {string} */ (shop.pins['김카운터']))).status, 200);
  return { app, a, b };
}

test('a command in one session reaches the other session\'s stream within a second', async () => {
  const { app, a, b } = await setup('live');
  try {
    const stream = await openStream(b);
    const first = await stream.waitFor(e => e.event === 'head');
    assert.deepEqual(Object.keys(first.data).sort(), ['configRev', 'epoch', 'rev']);
    const started = Date.now();
    const out = await (await a.command({
      type: 'setting.set', commandVersion: 1, requestId: newRequestId(), basis: { epoch: first.data.epoch, rev: first.data.rev },
      payload: { changes: [{ key: 'shop_settings:same_day_cancel_refund_default:decision', value: 'no_refund' }] },
    })).json();
    assert.equal(out.outcome, 'applied');
    const next = await stream.waitFor(e => e.event === 'head' && e.data.rev === out.rev);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(next.data.epoch, first.data.epoch);
    await stream.close();
  } finally {
    await app.close();
  }
});

test('heartbeats with a short interval; logout and device revoke end the stream with bye', async () => {
  const { app, a, b } = await setup('bye', 40);
  try {
    const sa = await openStream(a);
    const sb = await openStream(b);
    await new Promise(r => setTimeout(r, 150));
    assert.ok(sb.pings >= 2, 'pings arrive');

    assert.equal((await b.post('/api/v2/logout', null, { raw: '' })).status, 204);
    await sb.waitFor(e => e.event === 'bye');
    assert.ok(await sb.waitEnded());

    const auth = /** @type {NonNullable<typeof app.auth>} */ (app.auth);
    auth.revokeDevice(SHOP, a.state.deviceId, 'test', Date.now());
    const bye = await sa.waitFor(e => e.event === 'bye');
    assert.equal(bye.data.reason, 'device_revoked');
    assert.ok(await sa.waitEnded());
    assert.equal(/** @type {NonNullable<typeof app.hub>} */ (app.hub).count(), 0);
  } finally {
    await app.close();
  }
});

test('at most four streams per session; no cookie is 401; closing the server says bye', async () => {
  const { app, a } = await setup('limits');
  try {
    const streams = [];
    for (let i = 0; i < 4; i += 1) streams.push(await openStream(a));
    const fifth = await a.get('/api/v2/stream');
    assert.equal(fifth.status, 429);
    assert.equal((await fifth.json()).code, 'TOO_MANY_STREAMS');
    const anonymous = await device(app.port).get('/api/v2/stream');
    assert.equal(anonymous.status, 401);
    await anonymous.json();
    const closing = app.close();
    for (const s of streams) {
      await s.waitFor(e => e.event === 'bye' && e.data.reason === 'server_closing');
      assert.ok(await s.waitEnded());
    }
    await closing;
  } finally {
    await app.close();
  }
});

// @ts-check
// 요청의 안전 장치(plan §5-2 · §5-3): POST 확인 차례(415 → 413 → 403 → 401 → 403 CSRF), 다른 주소 · 다른 사이트, 큰 본문(적힌 길이 ·
// 흘려 보낸 본문), 깊은 JSON, 봉투 · 조회의 모양 오류, 답의 머리, 손님 주소(X-Forwarded-For)마다 따로 세는 제한, 크기를 막은 지도.

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { newRequestId } from '@skinote/contract';
import { jsonDepth } from '../src/http.js';
import { CappedMap, clientIp, createLimiter, csrfFor, isLoopbackAddress } from '../src/security.js';
import { startServer } from '../src/server.js';
import { collectLog, device, deviceCode, ORIGIN, provisionedShop, request, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
/** @type {Awaited<ReturnType<typeof startServer>>} */
let app;
/** @type {ReturnType<typeof device>} */
let counter;
/** @type {string[]} */
let lines;

before(async () => {
  const dataDir = join(temp.dir, 'security');
  const shop = await provisionedShop(dataDir);
  const code = await deviceCode(shop.env);
  const log = collectLog();
  lines = log.lines;
  app = await startServer(testConfig(dataDir, shop.env), { log: log.log });
  counter = device(app.port);
  assert.equal((await counter.enroll(code)).status, 200);
  assert.equal((await counter.login('김카운터', /** @type {string} */ (shop.pins['김카운터']))).status, 200);
});
after(async () => {
  await app?.close();
  temp.cleanup();
});

/**
 * 날 요청(흘려 보내는 본문 · 틀린 머리를 그대로 보내려고).
 * @param {string} path @param {Record<string, string>} headers @param {string[]} chunks
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: any }>}
 */
function rawPost(path, headers, chunks) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: app.port, path, method: 'POST', headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    (async () => {
      for (const chunk of chunks) {
        if (!req.write(chunk)) await new Promise(r => req.once('drain', r));
      }
      req.end();
    })().catch(reject);
  });
}

const envelope = (/** @type {Record<string, unknown>} */ extra = {}) => ({
  type: 'task.unpin', commandVersion: 1, requestId: newRequestId(), basis: { epoch: 'E', rev: 0 }, payload: { pinId: 'p1' }, ...extra,
});

test('the POST check order: 415, then 413, then 403 origin, then 401, then 403 CSRF', async () => {
  const big = String(70 * 1024);
  const cookie = counter.state.cookie;
  // 1. 형식이 틀리면 다른 모든 것보다 먼저 415
  let res = await rawPost('/api/v2/command', { 'content-type': 'text/plain', 'content-length': big, origin: 'https://evil.test' }, []);
  assert.equal(res.status, 415);
  assert.deepEqual(res.body, { ok: false, service: 'skinote', code: 'UNSUPPORTED_MEDIA_TYPE' });
  // 2. 적힌 길이가 한도를 넘으면 Origin보다 먼저 413
  res = await rawPost('/api/v2/command', { 'content-type': 'application/json', 'content-length': big, origin: 'https://evil.test' }, []);
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'TOO_LARGE');
  // 3. 다른 주소면 세션을 보기 전에 403
  res = await rawPost('/api/v2/command', { 'content-type': 'application/json; charset=utf-8', origin: 'https://evil.test', cookie }, ['{}']);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'BAD_ORIGIN');
  // 4. 쿠키가 없으면 401
  res = await rawPost('/api/v2/command', { 'content-type': 'application/json', origin: ORIGIN }, ['{}']);
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'SIGNED_OUT');
  // 5. 쿠키는 있는데 CSRF가 없거나 틀리면 403
  res = await rawPost('/api/v2/command', { 'content-type': 'application/json', origin: ORIGIN, cookie }, ['{}']);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'BAD_CSRF');
  res = await rawPost('/api/v2/command', { 'content-type': 'application/json', origin: ORIGIN, cookie, 'x-skinote-csrf': counter.state.csrf + 'x' }, ['{}']);
  assert.equal(res.body.code, 'BAD_CSRF');
  // 모두 맞으면 본문 검사(400)
  res = await rawPost('/api/v2/command', { 'content-type': 'application/json', origin: ORIGIN, cookie, 'x-skinote-csrf': counter.state.csrf }, ['{}']);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'UNKNOWN_COMMAND');
});

test('Origin: a foreign origin is refused; without Origin only Sec-Fetch-Site same-origin passes', async () => {
  const headers = { 'content-type': 'application/json', cookie: counter.state.cookie, 'x-skinote-csrf': counter.state.csrf };
  const body = [JSON.stringify({ name: 'config' })];
  assert.equal((await rawPost('/api/v2/query', { ...headers, origin: 'http://shop.test' }, body)).status, 403, 'another scheme is another origin');
  assert.equal((await rawPost('/api/v2/query', { ...headers, origin: 'null' }, body)).status, 403);
  assert.equal((await rawPost('/api/v2/query', { ...headers, 'sec-fetch-site': 'cross-site' }, body)).status, 403);
  assert.equal((await rawPost('/api/v2/query', headers, body)).status, 403, 'no Origin and no Sec-Fetch-Site (curl) is refused');
  assert.equal((await rawPost('/api/v2/query', { ...headers, 'sec-fetch-site': 'same-origin' }, body)).status, 200);
  assert.equal((await rawPost('/api/v2/query', { ...headers, origin: ORIGIN }, body)).status, 200);
  // GET: 다른 사이트에서 온 세션 읽기(CSRF 값이 들어 있다)는 막는다
  const cross = await counter.get('/api/v2/session', { 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 403);
  assert.equal((await counter.get('/api/v2/session', { origin: 'https://evil.test' })).status, 403);
  assert.equal((await counter.get('/api/v2/session', { 'sec-fetch-site': 'same-origin' })).status, 200);
});

test('bodies over the limit are refused while streaming (413) and deep JSON is 400', async () => {
  const headers = { 'content-type': 'application/json', origin: ORIGIN, cookie: counter.state.cookie, 'x-skinote-csrf': counter.state.csrf, 'transfer-encoding': 'chunked' };
  const pad = 'x'.repeat(16 * 1024);
  const res = await rawPost('/api/v2/command', headers, ['{"a":"', pad, pad, pad, pad, pad, '"}']);
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'TOO_LARGE');
  assert.equal(res.headers.connection, 'close', 'the rest of an unread body is not taken as the next request');

  const deep = '['.repeat(13) + ']'.repeat(13);
  assert.equal(jsonDepth(deep), 13);
  assert.equal(jsonDepth('{"a":"[[[[[[[[[[[[[[[["}'), 1, 'brackets inside strings are not counted');
  const deepRes = await counter.post('/api/v2/query', null, { raw: deep });
  assert.equal(deepRes.status, 400);
  assert.equal((await deepRes.json()).code, 'BAD_JSON');
  const broken = await counter.post('/api/v2/query', null, { raw: '{"name":' });
  assert.equal((await broken.json()).code, 'BAD_JSON');
});

test('envelope and query shapes: unknown keys 400, queue fields QUEUE_NOT_SUPPORTED, unknown query and view', async () => {
  /** @param {Response} res */
  const codeOf = async res => [res.status, (await res.json()).code];
  assert.deepEqual(await codeOf(await counter.command(envelope({ shopId: 'x' }))), [400, 'BAD_INPUT']);
  assert.deepEqual(await codeOf(await counter.command(envelope({ deviceSeq: 3 }))), [400, 'QUEUE_NOT_SUPPORTED']);
  assert.deepEqual(await codeOf(await counter.command(envelope({ recordedBy: { staffId: 'a', sessionId: 'b', signature: 'c' } }))), [400, 'QUEUE_NOT_SUPPORTED']);
  assert.deepEqual(await codeOf(await counter.command(envelope({ type: 'order.delete' }))), [400, 'UNKNOWN_COMMAND']);
  assert.deepEqual(await codeOf(await counter.command(envelope({ payload: { pinId: 'p1', extra: true } }))), [400, 'BAD_INPUT']);
  assert.deepEqual(await codeOf(await counter.query('dropTables', {})), [400, 'UNKNOWN_QUERY']);
  assert.deepEqual(await codeOf(await counter.query('ledgerView', { viewKey: 'secret' })), [400, 'UNKNOWN_VIEW']);
  assert.deepEqual(await codeOf(await counter.query('orderSlip', { orderId: 'o1', x: 1 })), [400, 'BAD_INPUT']);
  const bad = await (await counter.command(envelope({ payload: { pinId: '비밀-값' } }))).json();
  assert.ok(Array.isArray(bad.problems) && bad.problems.length > 0, 'the problems say where');
  assert.ok(!JSON.stringify(bad).includes('비밀-값'), 'the problems never echo the value');
});

test('responses: JSON, no-store, nosniff, service skinote, no stack traces', async () => {
  const res = await counter.command(envelope({ type: 'nope' }));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
  const body = await res.json();
  assert.equal(body.service, 'skinote');
  assert.equal(body.ok, false);
  const ok = await counter.query('config');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  await ok.json();
  const wrongMethod = await request(app.port, '/api/v2/command', { method: 'GET' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  await wrongMethod.json();
  assert.ok(!lines.some(l => /\bat .*\.js:\d+/.test(l)), 'no stack trace in the log');
});

test('per-address limits: each X-Forwarded-For address from the loopback peer has its own bucket', async () => {
  const a = device(app.port, { forwardedFor: '203.0.113.7' });
  const b = device(app.port, { forwardedFor: '203.0.113.8' });
  const deviceId = '01K62M1QG0000000000000000A';
  const statuses = [];
  for (let i = 0; i < 31; i += 1) statuses.push((await a.post('/api/v2/device/challenge', { deviceId })).status);
  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200));
  assert.equal(statuses[30], 429, 'the 31st challenge in a minute from one address');
  assert.equal((await b.post('/api/v2/device/challenge', { deviceId })).status, 200, 'another address is counted apart');
  // 두 주소가 든 머리는 마지막 주소(가장 가까운 앞단이 적은 것)로 센다: 손님이 앞에 다른 주소를 붙여도 자기 통을 벗어나지 못한다
  const prefixed = device(app.port, { forwardedFor: '198.51.100.1, 203.0.113.7' });
  assert.equal((await prefixed.post('/api/v2/device/challenge', { deviceId })).status, 429);
});

test('clientIp: the last forwarded address from loopback (the one Caddy set), IPv6 per /64, the proxy token when configured', () => {
  /** @param {string} peer @param {string | undefined} xff @param {Record<string, string>} [more] @param {string | null} [proxyToken] */
  const ip = (peer, xff, more = {}, proxyToken = null) =>
    clientIp({ socket: { remoteAddress: peer }, headers: { ...(xff === undefined ? {} : { 'x-forwarded-for': xff }), ...more } }, { proxyToken });
  assert.equal(ip('127.0.0.1', '203.0.113.7'), '203.0.113.7');
  assert.equal(ip('::ffff:127.0.0.1', '2001:db8::1'), '2001:db8:0:0::/64', 'IPv6 counts per /64');
  assert.equal(ip('127.0.0.1', '2001:db8:1:2:aaaa::1'), ip('127.0.0.1', '2001:db8:1:2:bbbb::9'), 'one /64 is one bucket');
  assert.notEqual(ip('127.0.0.1', '2001:db8:1:2::1'), ip('127.0.0.1', '2001:db8:1:3::1'));
  assert.equal(ip('127.0.0.1', undefined), 'loopback');
  assert.equal(ip('127.0.0.1', '198.51.100.1, 203.0.113.7'), '203.0.113.7', 'a client-sent header appended by a proxy: the last (proxy-set) address');
  assert.equal(ip('127.0.0.1', 'not-an-ip'), 'loopback');
  assert.equal(ip('192.0.2.10', '203.0.113.7'), '192.0.2.10', 'a spoofed header from a non-loopback peer is ignored');
  const token = 'x'.repeat(43);
  assert.equal(ip('127.0.0.1', '203.0.113.7', { 'x-skinote-proxy': token }, token), '203.0.113.7', 'Caddy sends the proxy token');
  assert.equal(ip('127.0.0.1', '203.0.113.7', {}, token), 'direct', 'a local process without the token shares one bucket');
  assert.equal(ip('127.0.0.1', '203.0.113.8', { 'x-skinote-proxy': 'wrong' }, token), 'direct');
  assert.ok(isLoopbackAddress('::1') && isLoopbackAddress('127.9.9.9') && !isLoopbackAddress('10.0.0.1'));
});

test('capped maps and token buckets stay bounded', () => {
  const map = new CappedMap(3);
  for (const k of ['a', 'b', 'c', 'd']) map.set(k, 1);
  assert.deepEqual([...map.keys()], ['b', 'c', 'd'], 'the oldest entry is dropped first');
  map.set('b', 2);
  map.set('e', 1);
  assert.deepEqual([...map.keys()], ['d', 'b', 'e'], 'writing an entry makes it the newest');
  const limiter = createLimiter({ capacity: 2, refillPerSec: 1, maxKeys: 100 });
  assert.equal(limiter.take('k', 0), true);
  assert.equal(limiter.take('k', 0), true);
  assert.equal(limiter.take('k', 0), false);
  assert.equal(limiter.take('k', 1000), true, 'one token back after a second');
  for (let i = 0; i < 500; i += 1) limiter.take('ip' + i, 0);
  assert.ok(limiter.size <= 100);
  const auth = /** @type {NonNullable<typeof app.auth>} */ (app.auth);
  assert.ok(auth.sizes().nonces <= 10_000 && auth.sizes().tickets <= 10_000);
  assert.notEqual(csrfFor(new Uint8Array(32), 'a'), csrfFor(new Uint8Array(32), 'b'));
});

test('SKINOTE_API=off: health only, /api/v2/* is 404 and no secret is needed', async () => {
  const dataDir = join(temp.dir, 'api-off');
  const config = testConfig(dataDir, { SKINOTE_SHOP_IDS: 'shop-a', SKINOTE_API: 'off' });
  assert.equal(config.secrets, null);
  const off = await startServer(config, { log: () => {} });
  try {
    for (const path of ['/api/v2/session', '/api/v2/head', '/api/v2/stream']) {
      const res = await request(off.port, path);
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { ok: false, error: 'not_found' });
    }
    const post = await request(off.port, '/api/v2/command', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{}' });
    assert.equal(post.status, 404);
    await post.json();
    assert.equal((await request(off.port, '/api/health')).status, 200);
  } finally {
    await off.close();
  }
  await assert.rejects(startServer({ ...testConfig(dataDir, { SKINOTE_SHOP_IDS: 'shop-a' }), secrets: null }, { log: () => {} }), /비밀값/);
});

// @ts-check
// HTTP 서버(node:http).
//   GET /api/health       감시 · 배포 확인용 JSON(모든 파일이 쓰기 가능하면 200, 아니면 503).
//                         자세한 본문은 서버 안에서 바로 온 요청에만 준다. 앞단(Caddy)을 거친 요청(X-Forwarded-* · Forwarded ·
//                         Via 머리가 있음)에는 { ok }만 준다. Caddy는 바깥의 이 길을 아예 404로 막는다(두 겹).
//   GET /api/health/live  프로세스가 살아 있는지(글자 ok, 200). 바깥 가동 확인 · 배포 스크립트가 부른다
//   /api/v2/*             기기 등록 · 로그인(auth.js)과 장부 API(api.js), 알림 연결(sse.js). SKINOTE_API=off면 없다(404).
// 그 밖은 모두 404 JSON. 요청 기록은 표준 출력(journald)에 '방법 경로 상태 시간'만 적는다: 물음표 뒤(query)와 본문은 적지 않고,
// 절대 주소 모양의 요청(GET http://host/path)은 경로만 적는다(사용자 정보 · 호스트를 적지 않음). 끝까지 보내지 못한 답은 'aborted'.
//
// 순서: 먼저 포트를 잡는다(같은 포트에 두 번째 서버가 뜨면 파일을 건드리기 전에 끝남) → 매장마다 쓰는 사람 잠금(다른 프로세스가
// 쥐었으면 시작하지 않음, D4) → 파일마다 마이그레이션(동기, 그동안의 요청은 기다림) → 저장소 창구 · 로그인 · 관리 소켓 → 답하기.
// 파일 하나가 거절 · 실패해도 멈추지 않고 그 파일만 쓰기를 막는다(그 매장의 API는 503).
// 닫을 때: 알림 연결에 bye → 관리 소켓 → 새 연결 막기 · 처리 중인 요청 끝내기 → 데이터베이스 → 쓰는 사람 잠금.

import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { openControlStore } from '@skinote/store';
import { startAdminSocket } from './admin-socket.js';
import { createApi } from './api.js';
import { createAuth } from './auth.js';
import { createLastBackupsReader } from './backup.js';
import { ConfigError } from './config.js';
import { canWrite, closeDatabases, openDatabases } from './databases.js';
import { buildHealth, healthOk } from './health.js';
import { HttpError, openGetRoute, postRoute, sendError, sessionGetRoute } from './http.js';
import { messageOf } from './errors.js';
import { acquireShopLocks, openShopPort, releaseShopLocks } from './shops.js';
import { ONLINE_OPS, OpError } from './shop-ops.js';
import { createHub, PING_MS } from './sse.js';

/**
 * @typedef {import('./config.js').ServerConfig} ServerConfig
 * @typedef {import('./databases.js').DatabaseEntry} DatabaseEntry
 * @typedef {import('node:http').IncomingMessage} IncomingMessage
 * @typedef {import('node:http').ServerResponse} ServerResponse
 * @typedef {(req: IncomingMessage, res: ServerResponse) => void | Promise<void>} Handler
 * @typedef {Partial<Record<'GET' | 'HEAD' | 'POST', Handler>>} Route
 */

/** 본문 한도(바이트, plan §5-1). */
export const BODY_LIMITS = Object.freeze({ enroll: 4096, challenge: 1024, staff: 4096, login: 1024, logout: 16, query: 32 * 1024, command: 64 * 1024 });

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

/**
 * @param {IncomingMessage} req @param {ServerResponse} res @param {number} status
 * @param {string} body @param {Record<string, string>} headers
 */
function send(req, res, status, body, headers) {
  const buffer = Buffer.from(body, 'utf8');
  res.writeHead(status, { ...headers, 'content-length': String(buffer.length) });
  res.end(req.method === 'HEAD' ? undefined : buffer);
}

/** @param {IncomingMessage} req @param {ServerResponse} res @param {number} status @param {unknown} value */
function sendJson(req, res, status, value) {
  send(req, res, status, JSON.stringify(value) + '\n', JSON_HEADERS);
}

/**
 * 요청 줄의 경로: 물음표 · 조각(#) 앞까지만. '/'로 시작하는 보통 모양은 해석하지 않고 그대로 비교한다(퍼센트 풀기 · 빗금 합치기 없음).
 * 절대 주소 모양(http://host/path)은 경로만, '*'는 그대로, 읽을 수 없는 것은 '-'.
 * @param {string | undefined} url
 */
export function pathOf(url) {
  let raw = url ?? '/';
  if (!raw.startsWith('/') && raw !== '*') {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '-';
      raw = url.pathname;
    } catch {
      return '-';
    }
  }
  const cut = raw.search(/[?#]/);
  return cut === -1 ? raw : raw.slice(0, cut);
}

/** 앞단(Caddy reverse_proxy)을 거친 요청인가. 서버는 127.0.0.1에만 붙으므로 이 머리가 없으면 서버 안에서 온 요청이다. */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'via'];
/** @param {IncomingMessage} req */
export function isProxied(req) {
  return PROXY_HEADERS.some(name => req.headers[name] !== undefined);
}

/** 기록에 쓸 경로: 보이는 ASCII만, 200자까지. @param {string} path */
function loggable(path) {
  const clean = path.replace(/[^\x21-\x7e]/g, '?');
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

/**
 * @param {ServerConfig} config
 * @param {{
 *   log?: (line: string) => void,
 *   now?: () => Date,
 *   graceMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   pingMs?: number,
 *   shopPort?: (port: import('./shops.js').ShopPort) => import('./shops.js').ShopPort,
 * }} [options] now · sleep · pingMs · shopPort는 시험이 바꾼다(가짜 시계, 짧은 심장 박동, 저장소 창구 감싸기)
 */
export async function startServer(config, { log = console.log, now = () => new Date(), graceMs = 5000, sleep, pingMs = PING_MS, shopPort } = {}) {
  if (config.api === 'on' && !config.secrets) {
    throw new ConfigError(['API를 켠 서버는 비밀값 넷(SKINOTE_PIN_PEPPER · SKINOTE_SESSION_KEY · SKINOTE_FINGERPRINT_KEY · SKINOTE_IP_KEY)이 있어야 합니다']);
  }
  const startedAt = now();
  const nowMs = () => now().getTime();
  /** @type {DatabaseEntry[] | null} */
  let entries = null;
  let shuttingDown = false;
  const lastBackups = createLastBackupsReader(config.backupDir);

  /** @type {Map<string, Route>} */
  const routes = new Map();
  /** @param {IncomingMessage} req @param {ServerResponse} res */
  const health = (req, res) => {
    if (isProxied(req)) {
      // 바깥에는 판 · 매장 id · 크기 · 디스크를 보이지 않는다(Caddy가 막지 못했을 때의 둘째 겹).
      const ok = healthOk(entries, shuttingDown);
      sendJson(req, res, ok ? 200 : 503, { ok });
      return;
    }
    if (!entries) {
      sendJson(req, res, 503, { ok: false, service: 'skinote-server', release: config.release, starting: true });
      return;
    }
    const { status, body } = buildHealth({ config, entries, startedAt, now: now(), lastBackups: lastBackups(), shuttingDown });
    sendJson(req, res, status, body);
  };
  /** @param {IncomingMessage} req @param {ServerResponse} res */
  const live = (req, res) => {
    send(req, res, shuttingDown ? 503 : 200, shuttingDown ? 'stopping\n' : 'ok\n', {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
  };
  routes.set('/api/health', { GET: health, HEAD: health });
  routes.set('/api/health/live', { GET: live, HEAD: live });

  const server = createServer((req, res) => {
    const began = performance.now();
    const path = pathOf(req.url);
    res.once('close', () => {
      const aborted = res.writableFinished ? '' : ' aborted';
      log(`${req.method} ${loggable(path)} ${res.statusCode} ${Math.round(performance.now() - began)}ms${aborted}`);
    });
    if (shuttingDown) res.setHeader('connection', 'close');
    const route = routes.get(path);
    if (!route) {
      sendJson(req, res, 404, { ok: false, error: 'not_found' });
      return;
    }
    const method = /** @type {'GET' | 'HEAD' | 'POST'} */ (req.method ?? '');
    const handler = Object.hasOwn(route, method) ? route[method] : undefined;
    if (!handler) {
      res.setHeader('allow', Object.keys(route).join(', '));
      sendJson(req, res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    /** @param {unknown} error */
    const fail = error => {
      if (error instanceof HttpError) {
        if (res.headersSent) { res.destroy(); return; }
        // 본문을 다 읽지 않은 채 답하는 실패(415 · 413 · 403 …)는 연결을 닫아 남은 본문이 다음 요청으로 읽히지 않게 한다.
        if (req.method === 'POST' && !req.complete) res.setHeader('connection', 'close');
        sendError(req, res, error.status, error.code, error.extra, error.headers);
        return;
      }
      log(`처리 오류 ${loggable(path)}: ${messageOf(error)}`);
      if (!res.headersSent) sendError(req, res, 500, 'INTERNAL');
      else res.destroy();
    };
    try {
      const done = handler(req, res);
      if (done && typeof done.then === 'function') done.catch(fail);
    } catch (error) {
      fail(error);
    }
  });
  // 앞단(Caddy)이 연결을 다시 쓰므로 유휴 시간은 앞단(30초)보다 길게 둔다: 막 닫힌 연결에 요청을 보내 502가 나지 않게.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 60_000;

  await new Promise((resolve, reject) => {
    const onError = /** @param {Error} error */ error => reject(error);
    server.once('error', onError);
    server.listen(config.port, config.host, () => {
      server.off('error', onError);
      resolve(undefined);
    });
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : config.port;
  log(`skinote-server ${config.release} · ${config.host}:${port} · 매장 ${config.shopIds.length}곳 · 기준 ${config.timeZone} ${config.cutoff}`);

  // 한 매장 파일에 쓰는 사람은 하나(D4): 마이그레이션보다 먼저 잡는다. 다른 서버 · 명령줄이 쥐었으면 파일을 건드리지 않고 끝낸다.
  /** @type {Map<string, import('@skinote/store').WriterLock>} */
  let locks;
  try {
    locks = acquireShopLocks(config);
  } catch (error) {
    server.close();
    throw error;
  }

  try {
    entries = openDatabases(config, { log, now });
  } catch (error) {
    // 폴더를 만들지 못하는 것처럼 파일 하나의 문제가 아닌 것은 시작하지 않는다.
    server.close();
    releaseShopLocks(locks);
    throw error;
  }
  const writable = entries.filter(e => e.writable).length;
  log(`데이터베이스 ${entries.length}개 중 쓰기 가능 ${writable}개`);

  /** @type {ReturnType<typeof createHub> | null} */
  let hub = null;
  /** @type {Awaited<ReturnType<typeof startAdminSocket>> | null} */
  let adminSocket = null;
  /** @type {Map<string, import('./shops.js').ShopPort>} */
  const ports = new Map();
  /** @type {ReturnType<typeof createAuth> | null} */
  let auth = null;
  if (config.api === 'on') {
    const secrets = /** @type {import('./secrets.js').Secrets} */ (config.secrets);
    const openEntries = /** @type {DatabaseEntry[]} */ (entries);
    const controlEntry = openEntries.find(e => e.kind === 'control');
    const control = controlEntry?.writable && controlEntry.db ? openControlStore(/** @type {any} */ (controlEntry.db)) : null;
    const liveHub = createHub({ pingMs, check: stream => (auth ? auth.streamAlive(stream) : false), log });
    hub = liveHub;
    for (const entry of openEntries) {
      if (entry.kind !== 'shop' || !entry.shopId || !entry.db || !canWrite(openEntries, entry.shopId)) continue;
      const shopId = entry.shopId;
      const real = openShopPort({ db: entry.db, shopId }, { secrets, log, onCommit: head => liveHub.publish(shopId, head) });
      ports.set(shopId, shopPort ? shopPort(real) : real);
    }
    if (control) {
      auth = createAuth({ secrets, control, shops: ports, hub: liveHub, nowMs, log, ...(sleep ? { sleep } : {}) });
      const api = createApi({ hub: liveHub, nowMs, log });
      const gate = { publicOrigin: config.publicOrigin, sessionOf: auth.sessionOf, csrfOk: auth.csrfOk, sessionLimit: auth.sessionLimit };
      const a = auth.handlers;
      routes.set('/api/v2/session', { GET: openGetRoute(a.session, gate) });
      routes.set('/api/v2/device/enroll', { POST: postRoute({ limit: BODY_LIMITS.enroll, ipLimit: auth.ipLimit('enroll'), handle: a.enroll }, gate) });
      routes.set('/api/v2/device/challenge', { POST: postRoute({ limit: BODY_LIMITS.challenge, ipLimit: auth.ipLimit('challenge'), handle: a.challenge }, gate) });
      routes.set('/api/v2/login/staff', { POST: postRoute({ limit: BODY_LIMITS.staff, ipLimit: auth.ipLimit('login'), handle: a.staff }, gate) });
      routes.set('/api/v2/login', { POST: postRoute({ limit: BODY_LIMITS.login, ipLimit: auth.ipLimit('login'), handle: a.login }, gate) });
      routes.set('/api/v2/logout', { POST: postRoute({ limit: BODY_LIMITS.logout, session: true, allowEmpty: true, handle: a.logout }, gate) });
      routes.set('/api/v2/head', { GET: sessionGetRoute(api.handlers.head, gate) });
      routes.set('/api/v2/query', { POST: postRoute({ limit: BODY_LIMITS.query, session: true, handle: api.handlers.query }, gate) });
      routes.set('/api/v2/command', { POST: postRoute({ limit: BODY_LIMITS.command, session: true, handle: api.handlers.command }, gate) });
      routes.set('/api/v2/stream', { GET: sessionGetRoute(api.handlers.stream, gate) });
      const liveAuth = auth;
      if (config.adminSocket) {
        try {
          adminSocket = await startAdminSocket({
            path: config.adminSocket,
            log,
            handle: async request => {
              const op = ONLINE_OPS[/** @type {keyof typeof ONLINE_OPS} */ (request.op)];
              if (!Object.hasOwn(ONLINE_OPS, request.op) || !op) return { ok: false, code: 'UNKNOWN_OP', message: '모르는 명령' };
              const target = ports.get(request.shopId);
              if (!target) return { ok: false, code: 'UNKNOWN_SHOP', message: '이 서버가 쓰지 않는 매장' };
              try {
                const result = await op({
                  shopId: request.shopId, port: target, control, secrets, now: nowMs,
                  onRevoke: deviceId => liveAuth.revokeDevice(request.shopId, deviceId, 'cli', nowMs()),
                  onPinReset: accountId => liveAuth.resetAccount(accountId),
                }, /** @type {any} */ (request.args));
                return { ok: true, result };
              } catch (error) {
                if (error instanceof OpError) return { ok: false, code: error.code, message: error.message };
                log(`관리 소켓 처리 오류: ${messageOf(error)}`);
                return { ok: false, code: 'INTERNAL', message: '처리 오류' };
              }
            },
          });
          log('관리 소켓을 열었습니다');
        } catch (error) {
          // 관리 소켓이 없으면 서버가 도는 동안 기기 끊기 · 비밀번호 바꾸기를 할 수 없다(잃어버린 기기를 서버를 멈춰야만 끊는다):
          // 켠 설정이면 시작하지 않는다(끄려면 SKINOTE_ADMIN_SOCKET=off). systemd 유닛의 RuntimeDirectory가 /run/skinote를 만든다.
          const code = /** @type {{ code?: string }} */ (error).code ?? 'ERROR';
          log(`관리 소켓을 열지 못함(${code}): 시작하지 않습니다(SKINOTE_ADMIN_SOCKET 경로 · 권한, 끄려면 off)`);
          hub?.closeAll();
          server.close();
          closeDatabases(/** @type {DatabaseEntry[]} */ (entries));
          releaseShopLocks(locks);
          throw Object.assign(new Error('관리 소켓을 열지 못했습니다(' + code + ')'), { code: 'ADMIN_SOCKET_FAILED' });
        }
      }
    } else {
      log('control 파일에 쓸 수 없어 로그인 · 장부 API를 열지 않았습니다(503)');
      const unavailable = () => { throw new HttpError(503, 'SHOP_UNAVAILABLE'); };
      for (const path of ['/api/v2/session', '/api/v2/head', '/api/v2/stream']) routes.set(path, { GET: unavailable });
      for (const path of ['/api/v2/device/enroll', '/api/v2/device/challenge', '/api/v2/login/staff', '/api/v2/login', '/api/v2/logout', '/api/v2/query', '/api/v2/command']) {
        routes.set(path, { POST: unavailable });
      }
    }
    log(`API 켬 · 매장 ${ports.size}곳${config.publicOrigin ? '' : ' · 앱 주소 없음(Host로 확인)'}`);
  }

  /** @type {Promise<void> | null} */
  let closing = null;
  const close = () => {
    if (closing) return closing;
    shuttingDown = true;
    const stopSocket = adminSocket ? adminSocket.close() : Promise.resolve();
    hub?.closeAll();
    closing = stopSocket.then(() => new Promise(resolve => {
      server.close(() => resolve(undefined));
      server.closeIdleConnections();
      const timer = setTimeout(() => server.closeAllConnections(), graceMs);
      timer.unref();
    })).then(() => {
      if (entries) closeDatabases(entries);
      releaseShopLocks(locks);
    });
    return closing;
  };

  return {
    server,
    port,
    get entries() { return /** @type {DatabaseEntry[]} */ (entries); },
    /** 매장마다의 저장소 창구(시험 · 관리). */
    ports,
    /** 로그인 · 세션(시험). */
    get auth() { return auth; },
    /** 알림 연결(시험). */
    get hub() { return hub; },
    get adminSocket() { return adminSocket?.path ?? null; },
    close,
  };
}

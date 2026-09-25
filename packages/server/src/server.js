// @ts-check
// HTTP 서버(node:http). 지금은 상태 확인 두 길만 있다:
//   GET /api/health       감시 · 배포 확인용 JSON(모든 파일이 쓰기 가능하면 200, 아니면 503).
//                         자세한 본문은 서버 안에서 바로 온 요청에만 준다. 앞단(Caddy)을 거친 요청(X-Forwarded-* · Forwarded ·
//                         Via 머리가 있음)에는 { ok }만 준다. Caddy는 바깥의 이 길을 아예 404로 막는다(두 겹).
//   GET /api/health/live  프로세스가 살아 있는지(글자 ok, 200). 바깥 가동 확인 · 배포 스크립트가 부른다
// 그 밖은 모두 404 JSON. 요청 기록은 표준 출력(journald)에 '방법 경로 상태 시간'만 적는다: 물음표 뒤(query)와 본문은 적지 않고,
// 절대 주소 모양의 요청(GET http://host/path)은 경로만 적는다(사용자 정보 · 호스트를 적지 않음). 끝까지 보내지 못한 답은 'aborted'.
//
// 순서: 먼저 포트를 잡는다(같은 포트에 두 번째 서버가 뜨면 파일을 건드리기 전에 끝남) → 파일마다 마이그레이션(동기, 그동안의
// 요청은 기다림) → 답하기. 파일 하나가 거절 · 실패해도 멈추지 않고 그 파일만 쓰기를 막는다.

import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { createLastBackupsReader } from './backup.js';
import { closeDatabases, openDatabases } from './databases.js';
import { buildHealth, healthOk } from './health.js';

/**
 * @typedef {import('./config.js').ServerConfig} ServerConfig
 * @typedef {import('./databases.js').DatabaseEntry} DatabaseEntry
 * @typedef {import('node:http').IncomingMessage} IncomingMessage
 * @typedef {import('node:http').ServerResponse} ServerResponse
 */

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
 * @param {{ log?: (line: string) => void, now?: () => Date, graceMs?: number }} [options]
 */
export async function startServer(config, { log = console.log, now = () => new Date(), graceMs = 5000 } = {}) {
  const startedAt = now();
  /** @type {DatabaseEntry[] | null} */
  let entries = null;
  let shuttingDown = false;
  const lastBackups = createLastBackupsReader(config.backupDir);

  /** @type {Map<string, (req: IncomingMessage, res: ServerResponse) => void>} */
  const routes = new Map([
    ['/api/health', (req, res) => {
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
    }],
    ['/api/health/live', (req, res) => {
      send(req, res, shuttingDown ? 503 : 200, shuttingDown ? 'stopping\n' : 'ok\n', {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
    }],
  ]);

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
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      sendJson(req, res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    try {
      route(req, res);
    } catch (error) {
      log(`처리 오류 ${loggable(path)}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendJson(req, res, 500, { ok: false, error: 'internal' });
      else res.destroy();
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

  try {
    entries = openDatabases(config, { log, now });
  } catch (error) {
    // 폴더를 만들지 못하는 것처럼 파일 하나의 문제가 아닌 것은 시작하지 않는다.
    server.close();
    throw error;
  }
  const writable = entries.filter(e => e.writable).length;
  log(`데이터베이스 ${entries.length}개 중 쓰기 가능 ${writable}개`);

  /** @type {Promise<void> | null} */
  let closing = null;
  const close = () => {
    if (closing) return closing;
    shuttingDown = true;
    closing = new Promise(resolve => {
      server.close(() => resolve(undefined));
      server.closeIdleConnections();
      const timer = setTimeout(() => server.closeAllConnections(), graceMs);
      timer.unref();
    }).then(() => {
      if (entries) closeDatabases(entries);
    });
    return closing;
  };

  return {
    server,
    port,
    get entries() { return /** @type {DatabaseEntry[]} */ (entries); },
    close,
  };
}

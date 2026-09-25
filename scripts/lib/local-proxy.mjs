// 로컬 앞단(계획 work/impl-server/plan.md §10 · I2): 운영의 Caddy를 흉내 낸다. 빌드한 앱(apps/pos/dist)을 주고, index.html은 보낼 때
// 서버 모드 표시를 그 자리에서 찍는다(packages/server/src/runtime-stamp.js, dist 파일은 고치지 않는다). /api/*는 서버(127.0.0.1:<서버
// 포트>)로 넘기고 X-Forwarded-For에 손님 주소 하나만 둔다(Caddy ≥ 2.5가 들어온 머리를 실제 상대 주소로 바꾸는 것과 같다). Host 머리는
// 그대로 넘긴다: 서버는 SKINOTE_PUBLIC_ORIGIN이 없으면 Host로 만든 주소(http://localhost:<앞단 포트>)와 Origin을 맞춰 본다.
// 알림 연결(SSE)은 모으지 않고 바로 흘린다. 브라우저는 localhost를 안전한 곳으로 보므로 __Host- · Secure 쿠키가 http에서도 된다.
//
// stamp: false면 표시를 찍지 않은 index.html을 준다(GitHub Pages처럼 체험판: 시험이 서버 없는 화면을 같은 빌드로 볼 때).
//
// 쓰는 곳: scripts/check-server-e2e.mjs(시험), npm run serve:local(손으로 볼 때: --port 5190 --server 3100).
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampRuntime } from '../../packages/server/src/runtime-stamp.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_DIST = join(ROOT, 'apps/pos/dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 소켓 주소 → 손님 주소 하나('::ffff:127.0.0.1' → '127.0.0.1'). */
const clientAddress = (address) => (address?.startsWith('::ffff:') ? address.slice(7) : address) || '127.0.0.1';

/**
 * 앞단을 띄운다. 끝낼 때 close()(열린 알림 연결도 끊는다).
 * @param {{ port: number, serverPort: number, host?: string, dist?: string, stamp?: boolean, log?: (line: string) => void }} options
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startLocalProxy({ port, serverPort, host = '127.0.0.1', dist = DEFAULT_DIST, stamp = true, log = () => {} }) {
  const base = resolve(dist);
  if (!existsSync(join(base, 'index.html'))) throw new Error('빌드한 앱이 없습니다: ' + base + ' (먼저 npm run build)');
  const sockets = new Set();

  const serveStatic = (req, res, pathname) => {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
    const file = normalize(join(base, rel));
    if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('not found');
      return;
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    if (rel === 'index.html') {
      // 서버 판의 앱 뼈대: 표시를 찍어 보낸다(배포의 stamp-runtime과 같은 함수).
      const html = readFileSync(file, 'utf8');
      const body = Buffer.from(stamp ? stampRuntime(html) : html, 'utf8');
      res.writeHead(200, { 'content-type': type, 'content-length': String(body.length), 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': String(statSync(file).size), 'cache-control': rel === 'sw.js' ? 'no-store' : 'no-cache' });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  };

  const proxy = (req, res) => {
    const headers = { ...req.headers, 'x-forwarded-for': clientAddress(req.socket.remoteAddress) };
    const upstream = httpRequest({ host: '127.0.0.1', port: serverPort, method: req.method, path: req.url, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      // 알림 연결: 머리를 바로 보내고 조각마다 흘린다(모으지 않음).
      if (String(answer.headers['content-type'] ?? '').startsWith('text/event-stream')) res.flushHeaders();
      answer.pipe(res);
      res.on('close', () => answer.destroy());
    });
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('bad gateway');
      } else {
        res.destroy();
      }
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const began = Date.now();
    res.once('close', () => log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - began}ms`));
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) proxy(req, res);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url.pathname);
    else {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok(undefined));
  });
  const address = server.address();
  const bound = address && typeof address === 'object' ? address.port : port;
  return {
    url: `http://localhost:${bound}/`,
    port: bound,
    close: () => new Promise((ok) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => ok(undefined));
    }),
  };
}

// 손으로 띄울 때: node scripts/lib/local-proxy.mjs --port 5190 --server 3100 [--dist apps/pos/dist]
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const arg = (name, fallback) => {
    const at = process.argv.indexOf(name);
    return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
  };
  const port = Number(arg('--port', '5190'));
  const serverPort = Number(arg('--server', '3100'));
  const dist = arg('--dist', DEFAULT_DIST);
  const proxy = await startLocalProxy({ port, serverPort, dist, log: (line) => console.log(line) });
  console.log(`앞단: ${proxy.url} → 서버 127.0.0.1:${serverPort} (앱 ${dist}, index.html에 서버 표시)`);
  const stop = () => { void proxy.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

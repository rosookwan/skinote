'use strict';
const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { ReturnError } = require('../src/returns/domain.js');
const { createService } = require('../src/returns/service.js');
const { createSqliteRepository } = require('./returns-repository.cjs');
const { createService: createNotificationService } = require('../src/notifications/service.js');
const { createService: createWorkflowService, publicRequest } = require('../src/workflows/service.js');

function tokenAuthenticator(credentials) {
  if (!Array.isArray(credentials) || !credentials.length) throw new Error('직원 API 인증 설정이 필요합니다.');
  const hashes = new Set();
  const entries = credentials.map(entry => {
    if (!/^[a-f0-9]{64}$/.test(entry.tokenHash ?? '') || hashes.has(entry.tokenHash)) throw new Error('인증 해시는 중복 없이 SHA-256 형식이어야 합니다.');
    hashes.add(entry.tokenHash);
    const context = { shopId: entry.shopId, actor: entry.actor, ...(entry.deviceId ? { deviceId: entry.deviceId } : {}) };
    createService({}, context); // Validate roles and shop identity before accepting requests.
    createNotificationService({}, context);
    return { hash: Buffer.from(entry.tokenHash, 'hex'), context };
  });
  return request => {
    const header = request.headers.authorization ?? '';
    if (!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(header)) throw new ReturnError('UNAUTHORIZED', '직원 인증이 필요합니다.');
    const hash = createHash('sha256').update(header.slice(7)).digest();
    const entry = entries.find(entry => timingSafeEqual(entry.hash, hash));
    if (!entry) throw new ReturnError('UNAUTHORIZED', '직원 인증을 확인해 주세요.');
    return entry.context;
  };
}
async function readBody(request) {
  if ((request.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') throw new ReturnError('INVALID_INPUT', 'JSON 요청이 필요합니다.');
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw new ReturnError('PAYLOAD_TOO_LARGE', '요청 크기를 줄여 주세요.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ReturnError('INVALID_INPUT', 'JSON 내용을 확인해 주세요.'); }
}
function createApiServer({ repository, authenticate, clock, allowedOrigins = [], workflowAdapters = {}, uiDirectory = null }) {
  if (typeof authenticate !== 'function') throw new Error('인증 함수를 지정해 주세요.');
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some(origin => typeof origin !== 'string' || !/^https?:\/\//.test(origin) || new URL(origin).origin !== origin)) throw new Error('허용할 화면 출처를 정확한 origin 목록으로 지정해 주세요.');
  const statuses = { DAY_CLOSED: 409, USE_UNIFIED_ORDER: 409, MIGRATION_CONFLICT: 409, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, ITEM_NOT_FOUND: 404, VERSION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, ALREADY_EXISTS: 409, DEPENDENT_RETURN: 409, DEPENDENT_MOVEMENT: 409, TICKET_UNAVAILABLE: 409, FORM_CLOSED: 410, QUANTITY_EXCEEDED: 409, NO_CHANGE: 409, NO_OUTSTANDING: 409, PAYLOAD_TOO_LARGE: 413 };
  const server = http.createServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(data));
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      if (uiDirectory && ['/pos', '/pos.html', '/guest', '/guest.html', '/ski-workflows.js'].includes(url.pathname) && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': url.pathname === '/ski-workflows.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
        response.end(readFileSync(path.join(uiDirectory, url.pathname === '/ski-workflows.js' ? 'ski-workflows.js' : url.pathname.startsWith('/guest') ? 'guest.html' : 'pos.html'))); return;
      }
      if (url.pathname === '/health' && request.method === 'GET') { send(200, { status: 'ok', service: 'ski-returns', storage: repository.mode }); return; }
      if (request.headers.origin) {
        if (!allowedOrigins.includes(request.headers.origin) && !(uiDirectory && request.headers.origin === 'http://' + request.headers.host)) throw new ReturnError('FORBIDDEN', '허용되지 않은 화면 출처입니다.');
        response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        send(200, {}); return;
      }
      const publicForm = url.pathname.match(/^\/api\/intake\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,159})\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,159})$/);
      if (publicForm) {
        if (url.search || !['GET', 'POST'].includes(request.method)) throw new ReturnError('INVALID_INPUT', '입력폼 요청을 확인해 주세요.');
        const authorization = request.headers.authorization || '';
        if (!/^Form [A-Za-z0-9_-]{43,128}$/.test(authorization)) throw new ReturnError('UNAUTHORIZED', '입력 링크를 확인해 주세요.');
        const command = request.method === 'POST' ? await readBody(request) : null;
        if (request.method === 'POST' && !command) throw new ReturnError('INVALID_INPUT', '제출 내용을 확인해 주세요.');
        send(200, await publicRequest(repository, { shopId: publicForm[1], formId: publicForm[2], accessToken: authorization.slice(5) }, command, clock));
        return;
      }
      const context = await authenticate(request);
      const service = createService(repository, context, clock);
      const query = Object.fromEntries(url.searchParams);
      if (url.pathname === '/api/workflows' || url.pathname.startsWith('/api/workflows/')) {
        const workflows = createWorkflowService(repository, context, clock, workflowAdapters);
        const route = url.pathname.slice('/api/workflows'.length);
        if (route === '/commands' && request.method === 'POST') send(200, workflows.execute(await readBody(request)));
        else if (route === '/forms/send' && request.method === 'POST') send(200, await workflows.sendFormLink(await readBody(request)));
        else if (route === '/moves/preview' && request.method === 'POST') send(200, workflows.prepareMove(await readBody(request)));
        else if (route === '/prints/dispatch' && request.method === 'POST') {
          const payload = await readBody(request);
          if (!payload || Object.keys(payload).length !== 1 || !payload.id) throw new ReturnError('INVALID_INPUT', '출력 요청을 확인해 주세요.');
          send(200, await workflows.dispatchPrint(payload.id));
        }
        else if (!route && request.method === 'GET') {
          if (Object.keys(query).length) throw new ReturnError('INVALID_INPUT', '조회 조건을 확인해 주세요.');
          send(200, workflows.snapshot());
        } else if (['/sync', '/reservations', '/vehicle', '/board', '/history', '/report'].includes(route) && request.method === 'GET') send(200, workflows[route.slice(1)](query));
        else {
          const entity = route.match(/^\/(forms|prints)\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,159})$/);
          if (!entity || request.method !== 'GET' || Object.keys(query).length) throw new ReturnError('NOT_FOUND', '업무 API 경로를 찾을 수 없습니다.');
          send(200, workflows[entity[1] === 'forms' ? 'intake' : 'print'](entity[2]));
        }
      }
      else if (url.pathname.startsWith('/api/notifications')) {
        const notifications = createNotificationService(repository, context, clock);
        const route = url.pathname.slice('/api/notifications'.length);
        if (route === '/commands' && request.method === 'POST') send(200, notifications.execute(await readBody(request)));
        else if (!route && request.method === 'GET') send(200, notifications.list(query));
        else if (route === '/sync' && request.method === 'GET') {
          if (Object.keys(query).some(key => key !== 'cursor')) throw new ReturnError('INVALID_INPUT', '알림 조회 조건을 확인해 주세요.');
          send(200, notifications.sync(query.cursor || 0));
        } else if (route === '/sent' && request.method === 'GET') send(200, notifications.sent());
        else if (route === '/tasks' && request.method === 'GET') send(200, { tasks: notifications.tasks() });
        else if (route === '/preferences' && request.method === 'GET') send(200, notifications.preferences());
        else throw new ReturnError('NOT_FOUND', '알림 API 경로를 찾을 수 없습니다.');
      }
      else if (url.pathname === '/api/returns/commands' && request.method === 'POST') send(200, service.execute(await readBody(request)));
      else if (url.pathname === '/api/returns' && request.method === 'GET') send(200, { orders: service.list(query) });
      else if (url.pathname === '/api/returns/report' && request.method === 'GET') send(200, service.report(query));
      else if (url.pathname === '/api/returns/sync' && request.method === 'GET') {
        if (Object.keys(query).some(key => key !== 'afterRevision') || !/^\d+$/.test(query.afterRevision ?? '0')) throw new ReturnError('INVALID_INPUT', '동기화 버전을 확인해 주세요.');
        send(200, service.sync(Number(query.afterRevision ?? 0)));
      } else {
        const match = url.pathname.match(/^\/api\/returns\/orders\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,79})(\/history)?$/);
        if (!match || request.method !== 'GET') throw new ReturnError('NOT_FOUND', 'API 경로를 찾을 수 없습니다.');
        send(200, match[2] ? { events: service.history(match[1]) } : { order: service.get(match[1]) });
      }
    } catch (error) {
      if (error instanceof ReturnError) send(statuses[error.code] ?? 400, { error: { code: error.code, message: error.message } });
      else send(500, { error: { code: 'INTERNAL_ERROR', message: '처리하지 못했습니다. 같은 요청 ID로 다시 확인해 주세요.' } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (require.main === module) {
  try {
    if (!process.env.SKI_RETURNS_ACCESS_FILE) throw new Error('SKI_RETURNS_ACCESS_FILE에 직원별 인증 해시 설정 파일을 지정해 주세요.');
    const config = JSON.parse(readFileSync(process.env.SKI_RETURNS_ACCESS_FILE, 'utf8'));
    const repository = createSqliteRepository(process.env.SKI_RETURNS_DB || path.join(__dirname, '../work/returns/ledger.sqlite'));
    const server = createApiServer({ repository, authenticate: tokenAuthenticator(config.credentials), allowedOrigins: config.allowedOrigins ?? [], uiDirectory: path.join(__dirname, '../dist') });
    server.listen(Number(process.env.SKI_RETURNS_PORT || 58149), '127.0.0.1', () => console.log('반납 API 실행: http://127.0.0.1:' + server.address().port + '/pos (SQLite 통합 포스)'));
    const stop = () => server.close(() => { repository.close(); process.exit(0); });
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createApiServer, tokenAuthenticator };

// @ts-check
// HTTP 도우미(plan §5-1 · §5-2): JSON 답(모든 답에 cache-control: no-store · nosniff · service 'skinote'), 실패 답
// { ok: false, service, code }(쌓인 호출 · SQL 없음), 본문 읽기(길이 한도), JSON 읽기(깊이 12까지), POST 확인 차례.
//
// POST 확인 차례(고정, 시험이 본다):
//   1. Content-Type이 application/json(charset은 있어도 됨) → 아니면 415
//   2. 적힌 Content-Length가 한도를 넘음 → 413(Caddy가 그 앞에서 1 MB로 막는다)
//   3. Origin(없으면 Sec-Fetch-Site: same-origin) → 아니면 403 BAD_ORIGIN
//   4. 로그인 전 길(기기 등록 · 한 번 값 · 로그인)의 주소마다 제한 → 429
//   5. 세션(필요한 길) → 401
//   6. CSRF 머리 → 403 BAD_CSRF
//   7. 세션마다 제한 → 429
//   8. 한도 안에서 본문 읽기 → 413, JSON → 400 BAD_JSON, 모양 검사(길마다) → 400

import { checkOrigin, clearedSessionCookie, crossSiteGet } from './security.js';

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */

export const SERVICE = 'skinote';

export const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

/** JSON 깊이 한도(객체 · 목록이 겹친 수). */
export const MAX_JSON_DEPTH = 12;

/** 답 없이 끝낼 실패(상태 · 코드 · 더 실을 값). */
export class HttpError extends Error {
  /** @param {number} status @param {string} code @param {Record<string, unknown>} [extra] @param {Record<string, string>} [headers] */
  constructor(status, code, extra = {}, headers = {}) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

/**
 * JSON 답. 204는 본문이 없다.
 * @param {IncomingMessage} req @param {ServerResponse} res @param {number} status @param {unknown} value
 * @param {Record<string, string | string[]>} [headers]
 */
export function sendJson(req, res, status, value, headers = {}) {
  if (status === 204) {
    res.writeHead(204, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end();
    return;
  }
  const buffer = Buffer.from(JSON.stringify(value) + '\n', 'utf8');
  res.writeHead(status, { ...JSON_HEADERS, ...headers, 'content-length': String(buffer.length) });
  res.end(req.method === 'HEAD' ? undefined : buffer);
}

/**
 * 실패 답 { ok: false, service, code, ...extra }.
 * @param {IncomingMessage} req @param {ServerResponse} res @param {number} status @param {string} code
 * @param {Record<string, unknown>} [extra] @param {Record<string, string | string[]>} [headers]
 */
export function sendError(req, res, status, code, extra = {}, headers = {}) {
  sendJson(req, res, status, { ok: false, service: SERVICE, code, ...extra }, headers);
}

/** Content-Type이 JSON인가(charset은 있어도 됨). @param {IncomingMessage} req */
export function isJsonRequest(req) {
  const type = req.headers['content-type'];
  if (typeof type !== 'string') return false;
  const [media = '', ...params] = type.split(';').map(p => p.trim().toLowerCase());
  if (media !== 'application/json') return false;
  return params.every(p => p === '' || /^charset="?utf-8"?$/.test(p));
}

/** 적힌 Content-Length(없거나 틀리면 undefined). @param {IncomingMessage} req */
export function declaredLength(req) {
  const raw = req.headers['content-length'];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * 본문을 한도 안에서 읽는다. 넘치면 413을 던지고 더 읽지 않는다.
 * @param {IncomingMessage} req @param {number} limit
 * @returns {Promise<Buffer>}
 */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (/** @type {Error | null} */ error, /** @type {Buffer} */ value = Buffer.alloc(0)) => {
      if (done) return;
      done = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      if (error) {
        req.resume();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onData = (/** @type {Buffer} */ chunk) => {
      size += chunk.length;
      if (size > limit) finish(new HttpError(413, 'TOO_LARGE'));
      else chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onError = (/** @type {Error} */ error) => finish(error);
    // 보내다 끊긴 요청: 'end'도 'error'도 오지 않을 수 있다. 답할 곳이 없으니 조용히 끝낸다(처리 오류로 적지 않음).
    const onClose = () => finish(new HttpError(400, 'ABORTED'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.once('close', onClose);
  });
}

/** 글의 JSON 깊이(따옴표 안은 세지 않는다). @param {string} text */
export function jsonDepth(text) {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i += 1; // 역빗금 다음 글자는 건너뛴다
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 34) inString = true;
    else if (c === 123 || c === 91) max = Math.max(max, (depth += 1));
    else if (c === 125 || c === 93) depth -= 1;
  }
  return max;
}

/**
 * 본문 → 값. 빈 본문은 allowEmpty이면 {}. 깊이가 넘치거나 JSON이 아니면 400 BAD_JSON.
 * @param {Buffer} buffer @param {{ allowEmpty?: boolean }} [options]
 */
export function parseJsonBody(buffer, { allowEmpty = false } = {}) {
  const text = buffer.toString('utf8');
  if (text.trim() === '') {
    if (allowEmpty) return {};
    throw new HttpError(400, 'BAD_JSON');
  }
  if (jsonDepth(text) > MAX_JSON_DEPTH) throw new HttpError(400, 'BAD_JSON');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'BAD_JSON');
  }
}

// ── 길의 확인 차례 ───────────────────────────────────────────────────────

/**
 * @typedef {{ ok: true, ctx: any } | { ok: false, status: number, code: string, clear: boolean }} GateSession
 * @typedef {{
 *   publicOrigin: string | null,
 *   sessionOf: (req: IncomingMessage, options?: { touch?: boolean }) => GateSession,
 *   csrfOk: (req: IncomingMessage, ctx: any) => boolean,
 *   sessionLimit: (ctx: any) => boolean,
 * }} GateDeps
 * @typedef {(req: IncomingMessage, res: ServerResponse, input: { body: unknown, origin: string, ctx?: any }) => Promise<void> | void} Handle
 * @typedef {{
 *   limit: number,
 *   handle: Handle,
 *   ipLimit?: (req: IncomingMessage) => boolean,
 *   session?: boolean,
 *   allowEmpty?: boolean,
 * }} PostSpec
 */

/** @param {GateSession & { ok: false }} check */
const sessionError = check => new HttpError(check.status, check.code, {}, check.clear ? { 'set-cookie': clearedSessionCookie() } : {});

/**
 * POST 길: 위의 확인 차례(1 ~ 8)를 지난 본문만 handle에 넘긴다.
 * @param {PostSpec} spec @param {GateDeps} deps
 * @returns {(req: IncomingMessage, res: ServerResponse) => Promise<void>}
 */
export function postRoute(spec, deps) {
  return async (req, res) => {
    if (!isJsonRequest(req)) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE');
    const length = declaredLength(req);
    if (length !== undefined && length > spec.limit) throw new HttpError(413, 'TOO_LARGE');
    const origin = checkOrigin(req, deps.publicOrigin);
    if (!origin.ok) throw new HttpError(403, 'BAD_ORIGIN');
    if (spec.ipLimit && !spec.ipLimit(req)) throw new HttpError(429, 'RATE_LIMITED');
    let ctx;
    if (spec.session) {
      const check = deps.sessionOf(req);
      if (!check.ok) throw sessionError(check);
      ctx = check.ctx;
      if (!deps.csrfOk(req, ctx)) throw new HttpError(403, 'BAD_CSRF');
      if (!deps.sessionLimit(ctx)) throw new HttpError(429, 'RATE_LIMITED');
    }
    const body = parseJsonBody(await readBody(req, spec.limit), { allowEmpty: spec.allowEmpty });
    await spec.handle(req, res, { body, origin: origin.origin, ctx });
  };
}

/**
 * 세션이 필요한 GET 길(머리 · 알림 연결): 다른 사이트에서 온 요청 → 403, 세션 → 401, 세션마다 제한 → 429. 앱이 저절로 묻는 길이라 세션의
 * 마지막 사용 시각을 바꾸지 않는다(쉬는 시간이 끝나게).
 * @param {Handle} handle @param {GateDeps} deps
 * @returns {(req: IncomingMessage, res: ServerResponse) => Promise<void>}
 */
export function sessionGetRoute(handle, deps) {
  return async (req, res) => {
    if (crossSiteGet(req, deps.publicOrigin)) throw new HttpError(403, 'BAD_ORIGIN');
    const check = deps.sessionOf(req, { touch: false });
    if (!check.ok) throw sessionError(check);
    if (!deps.sessionLimit(check.ctx)) throw new HttpError(429, 'RATE_LIMITED');
    await handle(req, res, { body: undefined, origin: '', ctx: check.ctx });
  };
}

/**
 * 세션이 없어도 되는 GET 길(세션 보기): 다른 사이트에서 온 요청만 막는다.
 * @param {Handle} handle @param {GateDeps} deps
 * @returns {(req: IncomingMessage, res: ServerResponse) => Promise<void>}
 */
export function openGetRoute(handle, deps) {
  return async (req, res) => {
    if (crossSiteGet(req, deps.publicOrigin)) throw new HttpError(403, 'BAD_ORIGIN');
    await handle(req, res, { body: undefined, origin: '' });
  };
}

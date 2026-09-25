// @ts-check
// 요청의 안전 장치(plan §5-2 · §5-3): 쿠키, 손님 주소(clientIp), 주소 해시(ip_hash), Origin · Sec-Fetch-Site 확인, CSRF 값,
// 토큰 통(token bucket) 제한, 크기를 막은 지도(capped map).
//
// 손님 주소: 서버는 Caddy 뒤의 127.0.0.1에 붙으므로 소켓 주소는 늘 루프백이다.
//   - 우리 사이트 파일(deploy/skinote.caddy.template)이 X-Forwarded-For를 Caddy가 본 상대 주소 하나로 못 박는다(header_up, 공통
//     Caddyfile의 trusted_proxies와 상관없이). 루프백에서 온 요청은 그 머리의 마지막 주소(가장 가까운 앞단이 적은 것)가 손님이다.
//   - 앞단 표(SKINOTE_PROXY_TOKEN, secrets.env)가 있으면 Caddy가 붙인 X-Skinote-Proxy가 같을 때만 X-Forwarded-For를 믿는다: 같은
//     VPS의 다른 프로세스가 127.0.0.1:3100에 바로 붙어 주소를 바꿔 가며 제한을 피하지 못하게. 표가 없거나 틀린 루프백 요청은 모두
//     'direct' 한 통으로 센다.
//   - 루프백인데 머리가 없으면 'loopback'(서버 안의 도구 · 상태 확인).
//   - 루프백이 아닌 상대(SKINOTE_HOST를 바깥에 연 시험)는 머리를 무시하고 소켓 주소를 쓴다.
//   - IPv6 주소는 /64로 센다(한 사람이 /64 안의 주소를 바꿔 가며 새 통을 얻지 못하게).
// 비밀값은 기록에 적지 않는다.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { SESSION_COOKIE } from '@skinote/contract';

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */

/** 크기를 막은 지도: 넘치면 가장 오래 쓰지 않은 것부터 버린다(Map의 넣은 차례, 쓸 때 뒤로 옮김). */
export class CappedMap {
  /** @param {number} max */
  constructor(max) {
    this.max = max;
    /** @type {Map<string, any>} */
    this.map = new Map();
  }

  /** @param {string} key */
  get(key) {
    return this.map.get(key);
  }

  /** @param {string} key */
  has(key) {
    return this.map.has(key);
  }

  /** @param {string} key @param {any} value */
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return this;
  }

  /** @param {string} key */
  delete(key) {
    return this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }

  keys() {
    return this.map.keys();
  }

  entries() {
    return this.map.entries();
  }
}

/**
 * 토큰 통 제한: 열쇠마다 capacity개까지 모았다가 초마다 refillPerSec개씩 채운다. take가 false면 넘친 것이다.
 * @param {{ capacity: number, refillPerSec: number, maxKeys?: number }} options
 */
export function createLimiter({ capacity, refillPerSec, maxKeys = 50_000 }) {
  const buckets = new CappedMap(maxKeys);
  return {
    /** @param {string} key @param {number} now 밀리초 */
    take(key, now) {
      const bucket = buckets.get(key) ?? { tokens: capacity, at: now };
      const tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.at) / 1000 * refillPerSec);
      const ok = tokens >= 1;
      buckets.set(key, { tokens: ok ? tokens - 1 : tokens, at: now });
      return ok;
    },
    get size() {
      return buckets.size;
    },
  };
}

/** @param {string | undefined} address */
export function isLoopbackAddress(address) {
  if (!address) return false;
  const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
  return plain === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain);
}

/** 앞단 표 머리 이름(Caddy가 붙인다). */
export const PROXY_HEADER = 'x-skinote-proxy';

/**
 * 제한 · 기록에 쓰는 주소 한 통: IPv4는 그대로, IPv6은 /64 앞부분('2001:db8:1:2::/64'). IPv4를 담은 IPv6(::ffff:a.b.c.d)은 IPv4.
 * @param {string} ip
 */
export function addressBucket(ip) {
  const plain = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  if (isIP(plain) !== 6) return plain;
  // 줄인 표기(::)를 풀어 앞 네 마디만.
  const [head = '', tail = ''] = plain.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = plain.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : plain.split(':');
  return groups.slice(0, 4).map(g => (g || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/**
 * 손님 주소(위 설명)의 통. 루프백 머리 없음 → 'loopback', 앞단 표가 틀림 → 'direct'.
 * @param {{ socket: { remoteAddress?: string }, headers: IncomingMessage['headers'] }} req
 * @param {{ proxyToken?: string | null }} [options]
 */
export function clientIp(req, { proxyToken = null } = {}) {
  const peer = req.socket.remoteAddress ?? '';
  if (!isLoopbackAddress(peer)) return peer ? addressBucket(peer) : 'unknown';
  if (proxyToken) {
    const given = req.headers[PROXY_HEADER];
    if (typeof given !== 'string' || !sameText(given, proxyToken)) return 'direct';
  }
  const header = req.headers['x-forwarded-for'];
  if (typeof header !== 'string') return 'loopback';
  const parts = header.split(',').map(p => p.trim()).filter(Boolean);
  const last = parts.at(-1);
  return last !== undefined && isIP(last) ? addressBucket(last) : 'loopback';
}

/** 기록 · 제한에 쓰는 주소 해시(HMAC, 주소를 거꾸로 맞춰 볼 수 없게). @param {Uint8Array} key @param {string} ip */
export function ipHashOf(key, ip) {
  return createHmac('sha256', key).update(ip, 'utf8').digest('base64url');
}

/** 쿠키 머리에서 이름 하나의 값. @param {string | undefined} header @param {string} name */
export function cookieValue(header, name) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** 세션 쿠키(없으면 undefined). @param {IncomingMessage} req */
export function sessionToken(req) {
  const value = cookieValue(req.headers.cookie, SESSION_COOKIE);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

/** 세션 쿠키 한 줄(__Host-: Path=/ · Secure · Domain 없음). @param {string} token @param {number} maxAgeS */
export function sessionCookie(token, maxAgeS) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeS))}`;
}

/** 세션 쿠키 지우기. */
export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** 새 비밀 글(32바이트 base64url 43자): 세션 토큰 · 한 번 값 · 로그인 표. */
export function newToken() {
  return randomBytes(32).toString('base64url');
}

/** 토큰의 sha256(control.sessions.token_hash, 등록 번호 해시). @param {string} value */
export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** CSRF 값: base64url(HMAC-SHA256(SKINOTE_SESSION_KEY, 세션 id)). @param {Uint8Array} key @param {string} sessionId */
export function csrfFor(key, sessionId) {
  return createHmac('sha256', key).update('csrf|' + sessionId, 'utf8').digest('base64url');
}

/** 시간이 같은 글 비교. @param {string} a @param {string} b */
export function sameText(a, b) {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Origin 확인(plan §5-2 3번): Origin이 있으면 기대한 주소와 같아야 한다. 없으면 Sec-Fetch-Site가 same-origin이어야 한다.
 * 기대한 주소는 SKINOTE_PUBLIC_ORIGIN, 없으면(루프백 서버의 로컬 실행) 요청의 Host로 만든 http · https 주소.
 * @param {IncomingMessage} req @param {string | null} publicOrigin
 * @returns {{ ok: true, origin: string } | { ok: false }}
 */
export function checkOrigin(req, publicOrigin) {
  const origin = req.headers.origin;
  const expected = expectedOrigins(req, publicOrigin);
  if (typeof origin === 'string' && origin !== 'null') {
    return expected.includes(origin) ? { ok: true, origin } : { ok: false };
  }
  if (req.headers['sec-fetch-site'] === 'same-origin' && expected[0]) return { ok: true, origin: publicOrigin ?? expected[0] };
  return { ok: false };
}

/** 이 요청에 맞는 주소들. @param {IncomingMessage} req @param {string | null} publicOrigin */
export function expectedOrigins(req, publicOrigin) {
  if (publicOrigin) return [publicOrigin];
  const host = req.headers.host;
  if (typeof host !== 'string' || !/^[A-Za-z0-9.:[\]-]{1,260}$/.test(host)) return [];
  return [`https://${host}`, `http://${host}`];
}

/**
 * GET(세션 · 머리 · 알림 연결)의 다른 곳 확인: 브라우저가 다른 사이트에서 왔다고 말하면(Sec-Fetch-Site: cross-site · same-site) 거절한다.
 * Origin을 보냈으면 POST와 같게 본다.
 * @param {IncomingMessage} req @param {string | null} publicOrigin
 */
export function crossSiteGet(req, publicOrigin) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return true;
  const origin = req.headers.origin;
  if (typeof origin === 'string') return !expectedOrigins(req, publicOrigin).includes(origin);
  return false;
}

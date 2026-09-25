// @ts-check
// 서버 비밀값(plan D9). 운영은 deploy.sh가 한 번 만든 /etc/skinote/secrets.env(root:skinote 0640)를 systemd가 EnvironmentFile=로
// 넣는다. 값은 저장소 · 데이터베이스 · 백업 · 기록 어디에도 적지 않는다: 문제를 알릴 때도 이름만 적는다.
//
//   SKINOTE_PIN_PEPPER        직원 비밀번호 해시의 후추(scrypt(HMAC(pepper, PIN))): control 사본만으로는 맞춰 볼 수 없게
//   SKINOTE_SESSION_KEY       CSRF 값(HMAC(key, 세션 id))
//   SKINOTE_FINGERPRINT_KEY   명령 지문(매장마다 HKDF로 나눠 쓴다, 저장소 journal.ts)
//   SKINOTE_IP_KEY            기록의 주소 해시(HMAC(key, 주소)): 맨 sha256이면 주소를 거꾸로 맞춰 볼 수 있다
//   SKINOTE_PROXY_TOKEN       (있으면) 앞단 표: Caddy가 X-Skinote-Proxy 머리로 붙이고, 서버는 그 머리가 같을 때만 X-Forwarded-For를
//                             믿는다(security.js clientIp). deploy.sh가 secrets.env에 만들고 Caddy 사이트 파일(0640)에 넣는다.
//
// 모양: base64url(패딩 '=' 없어도 됨), 풀어서 32바이트 이상. 네 값이 서로 같으면 거절한다(하나가 새면 모두 새지 않게).

import { randomBytes } from 'node:crypto';
import { ConfigError } from './config.js';

/** 비밀값 이름(환경 변수) → 서버 안의 이름. */
export const SECRET_NAMES = Object.freeze({
  pinPepper: 'SKINOTE_PIN_PEPPER',
  sessionKey: 'SKINOTE_SESSION_KEY',
  fingerprintKey: 'SKINOTE_FINGERPRINT_KEY',
  ipKey: 'SKINOTE_IP_KEY',
});

/** 풀어서 이 바이트 수 이상. */
export const SECRET_MIN_BYTES = 32;

/**
 * @typedef {{
 *   pinPepper: Uint8Array,
 *   sessionKey: Uint8Array,
 *   fingerprintKey: Uint8Array,
 *   ipKey: Uint8Array,
 *   proxyToken?: string | null,
 * }} Secrets
 */

/** 앞단 표(선택). */
export const PROXY_TOKEN_NAME = 'SKINOTE_PROXY_TOKEN';

/** @param {string} value @returns {Uint8Array | null} */
function decode(value) {
  const text = value.trim().replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length >= SECRET_MIN_BYTES ? new Uint8Array(bytes) : null;
}

/**
 * 환경 변수에서 비밀값 넷을 읽는다. 없거나 모양이 틀린 것은 이름만 모아 ConfigError(끝 코드 78)로 알린다.
 * @param {Record<string, string | undefined>} env
 * @returns {Secrets}
 */
export function loadSecrets(env) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Partial<Record<keyof typeof SECRET_NAMES, Uint8Array>>} */
  const out = {};
  for (const [key, name] of /** @type {[keyof typeof SECRET_NAMES, string][]} */ (Object.entries(SECRET_NAMES))) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
      problems.push(`${name}가 없습니다(API를 켠 서버는 비밀값 넷이 모두 있어야 합니다: deploy/README.md)`);
      continue;
    }
    const bytes = decode(raw);
    if (!bytes) {
      problems.push(`${name}는 base64url로 ${SECRET_MIN_BYTES}바이트 이상이어야 합니다`);
      continue;
    }
    out[key] = bytes;
  }
  const seen = new Set();
  for (const [key, bytes] of Object.entries(out)) {
    const hex = Buffer.from(bytes).toString('hex');
    if (seen.has(hex)) problems.push(`${SECRET_NAMES[/** @type {keyof typeof SECRET_NAMES} */ (key)]}가 다른 비밀값과 같습니다`);
    seen.add(hex);
  }
  const proxyRaw = env[PROXY_TOKEN_NAME];
  let proxyToken = null;
  if (proxyRaw !== undefined && proxyRaw.trim() !== '') {
    if (!decode(proxyRaw)) problems.push(`${PROXY_TOKEN_NAME}는 base64url로 ${SECRET_MIN_BYTES}바이트 이상이어야 합니다`);
    else proxyToken = proxyRaw.trim();
  }
  if (problems.length) throw new ConfigError(problems);
  return /** @type {Secrets} */ (Object.freeze({ ...out, proxyToken }));
}

/** 새 비밀값 하나(base64url 32바이트). 배포 스크립트 · 시험이 쓴다. */
export function newSecretValue() {
  return randomBytes(SECRET_MIN_BYTES).toString('base64url');
}

/** 새 비밀값 넷의 환경 변수(시험 · 로컬 실행용). @returns {Record<string, string>} */
export function newSecretsEnv() {
  return Object.fromEntries(Object.values(SECRET_NAMES).map(name => [name, newSecretValue()]));
}

// @ts-check
// 시험이 함께 쓰는 도우미(파일 이름이 *.test.js가 아니라 node --test가 따로 돌리지 않는다).

import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { loadSecrets, newSecretsEnv } from '../src/secrets.js';

export const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));

/** 시험마다 지울 임시 폴더(macOS의 /var → /private/var 링크를 푼 경로). */
export function tempDir(prefix = 'skinote-server-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 시험용 설정: 포트 0(운영체제가 고름), 판 이름 'test', 백업이 남길 디스크 여유 0(시험 기계의 디스크에 기대지 않음), 관리 소켓 없음,
 * 시험마다 새로 뽑은 비밀값(저장소에 비밀을 두지 않는다). 환경 변수로 더 바꿀 수 있다(SKINOTE_ADMIN_SOCKET · 비밀값 포함).
 * @param {string} dataDir @param {Record<string, string>} [env]
 * @returns {import('../src/config.js').ServerConfig}
 */
export function testConfig(dataDir, env = {}) {
  const all = { SKINOTE_DATA_DIR: dataDir, SKINOTE_RELEASE: 'test', SKINOTE_BACKUP_RESERVE_MB: '0', SKINOTE_ADMIN_SOCKET: 'off', ...newSecretsEnv(), ...env };
  const config = loadConfig(all, { releaseFile: join(dataDir, 'NO_RELEASE') });
  return { ...config, port: 0, secrets: config.api === 'on' ? loadSecrets(all) : null };
}

/** 기록을 모으는 log 함수. */
export function collectLog() {
  /** @type {string[]} */
  const lines = [];
  return { lines, log: /** @param {string} line */ line => { lines.push(line); } };
}

/** 비어 있는 포트 하나(잠깐 잡았다 놓는다). */
export async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  await new Promise(resolve => server.close(() => resolve(undefined)));
  return port;
}

/** @param {number} port @param {string} path @param {RequestInit} [init] */
export function request(port, path, init) {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

/** 파일의 sha256. @param {string} file */
export function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 파일 가운데 쪽들을 덮어써 '열리지만 VACUUM INTO는 실패하는' 파일로 만든다(첫 쪽 · 스키마 쪽은 그대로).
 * @param {string} file @param {{ from?: number, to?: number, step?: number, pageSize?: number }} [options]
 */
export function corruptPages(file, { from = 20, to = 800, step = 7, pageSize = 4096 } = {}) {
  const fd = openSync(file, 'r+');
  try {
    const junk = Buffer.alloc(pageSize, 0xa5);
    for (let page = from; page < to; page += step) writeSync(fd, junk, 0, pageSize, page * pageSize);
  } finally {
    closeSync(fd);
  }
}

// ── API 시험 도우미(기기 등록 · 로그인 · 세션) ───────────────────────────────────

/** 시험의 앱 주소(SKINOTE_PUBLIC_ORIGIN). 요청의 Origin 머리로도 보낸다. */
export const ORIGIN = 'https://shop.test';

/** 시험의 매장 id. */
export const SHOP = 'shop0test';

/** 시험 직원(견본 이름이 아니라 시험만의 이름). 기사는 1호 차량. */
export const STAFF = Object.freeze(['정하늘:manager', '김카운터:counter', '박기사:driver:v1']);

/**
 * 같은 프로세스에서 명령줄(bin/shop.js)을 돌린다.
 * @param {string[]} argv @param {Record<string, string>} env @param {{ stdin?: string, now?: () => number }} [options]
 */
export async function cli(argv, env, { stdin = '', now = () => Date.now() } = {}) {
  const { runShopCli } = await import('../bin/shop.js');
  let out = '';
  let err = '';
  const code = await runShopCli(argv, {
    env, out: text => { out += text; }, err: text => { err += text; }, readStdin: async () => stdin, now,
  });
  return { code, out, err };
}

/** 표준 출력의 비밀번호 표 → 이름 → 비밀번호. @param {string} out */
export function pinsOf(out) {
  /** @type {Record<string, string>} */
  const pins = {};
  for (const line of out.trim().split('\n').slice(1)) {
    const [name, , pin] = line.split('\t');
    if (name && pin) pins[name] = pin;
  }
  return pins;
}

/** 등록 번호 줄 → 숫자 12자리. @param {string} out */
export function codeOf(out) {
  const m = /등록 번호\t(\d{4})-(\d{4})-(\d{4})/.exec(out);
  if (!m) throw new Error('등록 번호가 출력에 없습니다');
  return m[1] + m[2] + m[3];
}

/**
 * 시험 매장 하나: 서버를 한 번 띄워 파일을 마이그레이션하고 닫은 뒤, 명령줄로 견본 명세 + 시험 직원을 만든다.
 * @param {string} dataDir @param {Record<string, string>} [extraEnv]
 */
export async function provisionedShop(dataDir, extraEnv = {}) {
  const { startServer } = await import('../src/server.js');
  const env = {
    SKINOTE_DATA_DIR: dataDir, SKINOTE_SHOP_IDS: SHOP, SKINOTE_RELEASE: 'test', SKINOTE_BACKUP_RESERVE_MB: '0', SKINOTE_ADMIN_SOCKET: 'off',
    SKINOTE_PUBLIC_ORIGIN: ORIGIN, ...newSecretsEnv(), ...extraEnv,
  };
  const first = await startServer(testConfig(dataDir, env), { log: () => {} });
  await first.close();
  const made = await cli(['provision', '--shop', SHOP, '--code', 'test-shop', '--name', '시험 매장', '--sample', '--test', ...STAFF.flatMap(s => ['--staff', s])], env);
  if (made.code !== 0) throw new Error('provision 실패: ' + made.err);
  return { env, pins: pinsOf(made.out) };
}

/** 기기 열쇠(WebCrypto P-256, 꺼낼 수 없음)와 공개 JWK. */
export async function deviceKey() {
  const { webcrypto } = await import('node:crypto');
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    publicKey: jwk,
    /** @param {string} text */
    async sign(text) {
      const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(text));
      return Buffer.from(signature).toString('base64url');
    },
  };
}

/**
 * 쿠키 · CSRF를 기억하는 작은 기기(브라우저 대신). 요청마다 Origin을 보낸다(끄려면 origin: null).
 * @param {number} port @param {{ origin?: string | null, forwardedFor?: string }} [options]
 */
export function device(port, { origin = ORIGIN, forwardedFor } = {}) {
  const state = { cookie: '', csrf: '', deviceId: '', key: /** @type {Awaited<ReturnType<typeof deviceKey>> | null} */ (null) };
  /** @param {Record<string, string>} [extra] */
  const headers = (extra = {}) => ({
    ...(origin ? { origin } : {}),
    ...(state.cookie ? { cookie: state.cookie } : {}),
    ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    ...extra,
  });
  /** @param {Response} res */
  const remember = res => {
    const set = res.headers.get('set-cookie');
    if (!set) return;
    const m = /__Host-sn_session=([^;]*)/.exec(set);
    if (m) state.cookie = m[1] ? `__Host-sn_session=${m[1]}` : '';
  };
  const self = {
    state,
    /** @param {string} path @param {Record<string, string>} [extra] */
    async get(path, extra) {
      const res = await request(port, path, { headers: headers(extra) });
      remember(res);
      return res;
    },
    /** @param {string} path @param {unknown} body @param {{ csrf?: boolean, headers?: Record<string, string>, raw?: string }} [options] */
    async post(path, body, options = {}) {
      const res = await request(port, path, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json', ...(options.csrf !== false && state.csrf ? { 'x-skinote-csrf': state.csrf } : {}), ...options.headers }),
        body: options.raw ?? JSON.stringify(body),
      });
      remember(res);
      return res;
    },
    /** 등록 번호로 기기 등록. @param {string} code */
    async enroll(code) {
      state.key = await deviceKey();
      const res = await self.post('/api/v2/device/enroll', { code, publicKey: state.key.publicKey, agent: 'test · node' });
      if (res.status === 200) state.deviceId = (await res.clone().json()).deviceId;
      return res;
    },
    /** 한 번 값 → 서명 → 직원 타일(로그인 표). */
    async staffList() {
      const challenge = await (await self.post('/api/v2/device/challenge', { deviceId: state.deviceId })).json();
      const key = /** @type {NonNullable<typeof state.key>} */ (state.key);
      const signature = await key.sign(`skinote-login-v1|${ORIGIN}|${state.deviceId}|${challenge.nonce}`);
      return self.post('/api/v2/login/staff', { deviceId: state.deviceId, nonce: challenge.nonce, signature });
    },
    /** 직원 이름 · 비밀번호로 로그인(성공이면 CSRF를 기억). @param {string} name @param {string} pin */
    async login(name, pin) {
      const list = await self.staffList();
      if (list.status !== 200) return list;
      const { ticket, staff } = await list.json();
      const tile = staff.find((/** @type {{ name: string }} */ s) => s.name === name);
      const res = await self.post('/api/v2/login', { ticket, staffId: tile?.id ?? '01K62M1QG0000000000000000Z', pin });
      if (res.status === 200) state.csrf = (await res.clone().json()).csrf;
      return res;
    },
    /** @param {string} name @param {unknown} [params] */
    async query(name, params) {
      return self.post('/api/v2/query', params === undefined ? { name } : { name, params });
    },
    /** @param {unknown} envelope */
    async command(envelope) {
      return self.post('/api/v2/command', envelope);
    },
  };
  return self;
}

/**
 * 등록 번호 하나(서버가 멈췄으면 파일 직접, 돌면 관리 소켓). now는 가짜 시계로 띄울 서버의 시각(번호의 끝 시각이 그 시계를 따른다).
 * @param {Record<string, string>} env @param {string[]} [args] @param {() => number} [now]
 */
export async function deviceCode(env, args = ['--kind', 'pos', '--label', '카운터 1'], now = () => Date.now()) {
  const made = await cli(['device-code', '--shop', SHOP, ...args], env, { now });
  if (made.code !== 0) throw new Error('device-code 실패: ' + made.err);
  return codeOf(made.out);
}

/** 짧은 이름의 임시 폴더(Unix 소켓 경로는 macOS에서 104바이트까지). */
export function shortTempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sn-')));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

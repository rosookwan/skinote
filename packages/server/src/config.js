// @ts-check
// 서버 설정은 환경 변수에서만 읽는다(운영은 /etc/skinote/skinote.env, deploy/skinote.env.example).
// 비밀값은 여기에 없다. 틀린 값이 하나라도 있으면 모두 모아 ConfigError로 알리고 시작하지 않는다.
//
//   SKINOTE_DATA_DIR   자료 폴더(기본 ./data). 그 안에 db/control.sqlite, db/shops/<매장 id>.sqlite, backups/
//   SKINOTE_PORT       기본 3100
//   SKINOTE_HOST       기본 127.0.0.1(앞단 Caddy만 붙는다)
//   SKINOTE_SHOP_IDS   쉼표로 나눈 매장 id. 파일 이름이 되므로 영문 · 숫자 · '-' · '_'만(1~64자)
//   SKINOTE_TZ         기본 Asia/Seoul(IANA 이름)
//   SKINOTE_CUTOFF     하루 기준 시각, 기본 06:00(data-model 3-3)
//   SKINOTE_RELEASE    판 이름. 없으면 배포가 적어 둔 server/RELEASE 파일, 그것도 없으면 'dev'
//   SKINOTE_BACKUP_KEEP_DAYS  날마다 백업 폴더를 몇 개 남길지, 기본 14
//   SKINOTE_BACKUP_RESERVE_MB 백업 뒤에도 디스크에 남겨 둘 여유(MB), 기본 2048. 여러 앱이 나눠 쓰는 디스크를 백업이 채우지 않게
//   SKINOTE_API        on(기본) · off. off는 상태 확인만 하는 비상용 서버(매장 기기는 '연결 끊김'을 보인다, 체험판으로 가지 않는다)
//   SKINOTE_PUBLIC_ORIGIN  앱 주소(https://…, 경로 없음). Origin 확인과 기기 서명 문장에 쓴다. 바깥에 연 주소(SKINOTE_HOST가 루프백이
//                      아님)로 API를 켜거나 운영(NODE_ENV=production, 유닛이 넣음)이면 꼭 있어야 한다. 루프백 로컬 실행에서 없으면 요청의
//                      Host로 만든 주소와 맞춰 본다
//   SKINOTE_ADMIN_SOCKET  관리 소켓 경로(기본 /run/skinote/admin.sock, 'off'면 열지 않음). 100바이트까지(macOS 104)
// 비밀값 넷(SKINOTE_PIN_PEPPER · SKINOTE_SESSION_KEY · SKINOTE_FINGERPRINT_KEY · SKINOTE_IP_KEY)은 secrets.js가 따로 읽는다.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULTS = Object.freeze({
  dataDir: './data',
  port: 3100,
  host: '127.0.0.1',
  timeZone: 'Asia/Seoul',
  cutoff: '06:00',
  release: 'dev',
  backupKeepDays: 14,
  backupReserveMb: 2048,
  api: 'on',
  adminSocket: '/run/skinote/admin.sock',
});

/** 매장 id: 파일 이름으로 안전한 모양(점 · 빗금 · 공백 없음). ULID(26자)도 이 모양이다. */
export const SHOP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** 판 이름: 배포가 만드는 '<UTC 시각>-<커밋>' 모양을 받고, 경로나 제어 문자는 받지 않는다. */
export const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
const HOST_PATTERN = /^(?:[A-Za-z0-9.-]{1,253}|[0-9A-Fa-f:.]{2,45}|\[[0-9A-Fa-f:.]{2,45}\])$/;
const CUTOFF_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** control 파일의 이름과 겹치지 않게(백업 파일 이름이 '<이름>.daily…'라 control과 섞이면 안 된다). */
const RESERVED_SHOP_IDS = new Set(['control']);

/** 배포가 적어 두는 판 이름 파일(릴리스의 server/RELEASE). */
export const RELEASE_FILE = fileURLToPath(new URL('../RELEASE', import.meta.url));

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super('설정이 맞지 않아 시작하지 않습니다:\n  - ' + problems.join('\n  - '));
    this.name = 'ConfigError';
    this.code = 'CONFIG';
    this.problems = problems;
  }
}

/**
 * @typedef {{
 *   dataDir: string,
 *   dbDir: string,
 *   shopDbDir: string,
 *   backupDir: string,
 *   migrationBackupDir: string,
 *   port: number,
 *   host: string,
 *   shopIds: readonly string[],
 *   timeZone: string,
 *   cutoff: string,
 *   cutoffMinutes: number,
 *   release: string,
 *   backupKeepDays: number,
 *   backupReserveBytes: number,
 *   api: 'on' | 'off',
 *   publicOrigin: string | null,
 *   adminSocket: string | null,
 *   secrets?: import('./secrets.js').Secrets | null,
 * }} ServerConfig
 */

/** 관리 소켓 경로의 끝(macOS sun_path 104바이트). */
export const ADMIN_SOCKET_MAX_BYTES = 100;

/**
 * 앱 주소(origin) 모양: http(s)://호스트[:포트], 경로 · 물음표 · 사용자 정보 없음. 맞으면 정규 모양(URL.origin), 아니면 undefined.
 * @param {string} value
 */
export function parsePublicOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return undefined;
    if (value.replace(/\/$/, '') !== url.origin) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * 비어 있으면 undefined(설정하지 않은 것과 같다).
 * @param {Record<string, string | undefined>} env @param {string} key
 */
function read(env, key) {
  const value = env[key];
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** @param {string} value @param {string} key @param {string[]} problems @param {{ min: number, max: number }} range */
function parseInteger(value, key, problems, { min, max }) {
  if (!/^\d+$/.test(value)) {
    problems.push(`${key}는 정수여야 합니다(${JSON.stringify(value)})`);
    return undefined;
  }
  const n = Number(value);
  if (n < min || n > max) {
    problems.push(`${key}는 ${min}~${max} 사이여야 합니다(${n})`);
    return undefined;
  }
  return n;
}

/**
 * 매장 id 목록을 읽는다. 빈 칸 · 겹침(대소문자만 다른 것 포함) · 파일 이름으로 위험한 값은 문제로 모은다.
 * @param {string | undefined} value @param {string[]} problems
 * @returns {string[]}
 */
export function parseShopIds(value, problems) {
  if (value === undefined) return [];
  const ids = [];
  const seen = new Set();
  const parts = value.split(',');
  parts.forEach((raw, index) => {
    const id = raw.trim();
    if (id === '') {
      problems.push(`SKINOTE_SHOP_IDS의 ${index + 1}번째 값이 비어 있습니다(쉼표가 겹쳤거나 끝에 남음)`);
      return;
    }
    if (!SHOP_ID_PATTERN.test(id)) {
      problems.push(`매장 id ${JSON.stringify(id)}: 영문 · 숫자로 시작하고 영문 · 숫자 · '-' · '_'만 1~64자여야 합니다`);
      return;
    }
    if (RESERVED_SHOP_IDS.has(id.toLowerCase())) {
      problems.push(`매장 id ${JSON.stringify(id)}: control 파일 이름과 겹쳐 쓸 수 없습니다`);
      return;
    }
    const key = id.toLowerCase();
    if (seen.has(key)) {
      problems.push(`매장 id ${JSON.stringify(id)}가 두 번 있습니다(대소문자만 다른 것도 같은 파일로 봅니다)`);
      return;
    }
    seen.add(key);
    ids.push(id);
  });
  return ids;
}

/** @param {string} timeZone */
export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** '06:00' → 360. 모양이 틀리면 undefined. @param {string} value */
export function parseCutoff(value) {
  const m = CUTOFF_PATTERN.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

/** 배포가 적어 둔 판 이름(없거나 읽지 못하면 undefined). @param {string} file */
function readReleaseFile(file) {
  try {
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, 'utf8').trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * 환경 변수에서 설정을 읽는다. 상대 경로(SKINOTE_DATA_DIR)는 cwd 기준으로 푼다.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ cwd?: string, releaseFile?: string }} [options]
 * @returns {Readonly<ServerConfig>}
 */
export function loadConfig(env = process.env, { cwd = process.cwd(), releaseFile = RELEASE_FILE } = {}) {
  /** @type {string[]} */
  const problems = [];

  const dataDirRaw = read(env, 'SKINOTE_DATA_DIR') ?? DEFAULTS.dataDir;
  if (/[\0\n\r]/.test(dataDirRaw)) problems.push('SKINOTE_DATA_DIR에 제어 문자가 있습니다');
  const dataDir = isAbsolute(dataDirRaw) ? resolve(dataDirRaw) : resolve(cwd, dataDirRaw);

  const portRaw = read(env, 'SKINOTE_PORT');
  const port = portRaw === undefined ? DEFAULTS.port : parseInteger(portRaw, 'SKINOTE_PORT', problems, { min: 1, max: 65535 });

  const host = read(env, 'SKINOTE_HOST') ?? DEFAULTS.host;
  if (!HOST_PATTERN.test(host)) problems.push(`SKINOTE_HOST 모양이 틀렸습니다(${JSON.stringify(host)})`);

  const shopIds = parseShopIds(read(env, 'SKINOTE_SHOP_IDS'), problems);

  const timeZone = read(env, 'SKINOTE_TZ') ?? DEFAULTS.timeZone;
  if (!isValidTimeZone(timeZone)) problems.push(`SKINOTE_TZ는 IANA 시간대 이름이어야 합니다(${JSON.stringify(timeZone)})`);

  const cutoff = read(env, 'SKINOTE_CUTOFF') ?? DEFAULTS.cutoff;
  const cutoffMinutes = parseCutoff(cutoff);
  if (cutoffMinutes === undefined) problems.push(`SKINOTE_CUTOFF는 HH:MM(00:00~23:59)이어야 합니다(${JSON.stringify(cutoff)})`);

  const releaseEnv = read(env, 'SKINOTE_RELEASE');
  const release = releaseEnv ?? readReleaseFile(releaseFile) ?? DEFAULTS.release;
  if (!RELEASE_PATTERN.test(release)) {
    problems.push(`판 이름(${releaseEnv === undefined ? 'RELEASE 파일' : 'SKINOTE_RELEASE'})은 영문 · 숫자 · '.' · '_' · '+' · '-'만 80자까지입니다`);
  }

  const keepRaw = read(env, 'SKINOTE_BACKUP_KEEP_DAYS');
  const backupKeepDays = keepRaw === undefined
    ? DEFAULTS.backupKeepDays
    : parseInteger(keepRaw, 'SKINOTE_BACKUP_KEEP_DAYS', problems, { min: 1, max: 3650 });

  const reserveRaw = read(env, 'SKINOTE_BACKUP_RESERVE_MB');
  const backupReserveMb = reserveRaw === undefined
    ? DEFAULTS.backupReserveMb
    : parseInteger(reserveRaw, 'SKINOTE_BACKUP_RESERVE_MB', problems, { min: 0, max: 1_048_576 });

  const apiRaw = (read(env, 'SKINOTE_API') ?? DEFAULTS.api).toLowerCase();
  if (apiRaw !== 'on' && apiRaw !== 'off') problems.push(`SKINOTE_API는 on 또는 off입니다(${JSON.stringify(apiRaw)})`);
  const api = apiRaw === 'off' ? 'off' : 'on';

  const originRaw = read(env, 'SKINOTE_PUBLIC_ORIGIN');
  const publicOrigin = originRaw === undefined ? null : parsePublicOrigin(originRaw) ?? null;
  if (originRaw !== undefined && publicOrigin === null) {
    problems.push('SKINOTE_PUBLIC_ORIGIN은 https://호스트[:포트] 모양이어야 합니다(경로 · 끝 빗금 없음)');
  }
  if (api === 'on' && originRaw === undefined && HOST_PATTERN.test(host) && !isLoopbackHost(host)) {
    problems.push('SKINOTE_HOST가 루프백이 아니면 SKINOTE_PUBLIC_ORIGIN이 있어야 합니다(Origin 확인 · 기기 서명)');
  } else if (api === 'on' && originRaw === undefined && read(env, 'NODE_ENV') === 'production') {
    problems.push('운영(NODE_ENV=production)에서 API를 켜면 SKINOTE_PUBLIC_ORIGIN=https://<사이트 주소>가 있어야 합니다(Host로 만든 주소를 믿지 않게)');
  }

  const socketRaw = read(env, 'SKINOTE_ADMIN_SOCKET') ?? DEFAULTS.adminSocket;
  const adminSocket = socketRaw.toLowerCase() === 'off' ? null : socketRaw;
  if (adminSocket !== null && (!isAbsolute(adminSocket) || /[\0\n\r]/.test(adminSocket) || Buffer.byteLength(adminSocket) > ADMIN_SOCKET_MAX_BYTES)) {
    problems.push(`SKINOTE_ADMIN_SOCKET은 절대 경로로 ${ADMIN_SOCKET_MAX_BYTES}바이트까지이거나 off입니다`);
  }

  if (problems.length) throw new ConfigError(problems);

  const dbDir = join(dataDir, 'db');
  const backupDir = join(dataDir, 'backups');
  return Object.freeze({
    dataDir,
    dbDir,
    shopDbDir: join(dbDir, 'shops'),
    backupDir,
    migrationBackupDir: join(backupDir, 'migrations'),
    port: /** @type {number} */ (port),
    host,
    shopIds: Object.freeze(shopIds),
    timeZone,
    cutoff,
    cutoffMinutes: /** @type {number} */ (cutoffMinutes),
    release,
    backupKeepDays: /** @type {number} */ (backupKeepDays),
    backupReserveBytes: /** @type {number} */ (backupReserveMb) * 1024 * 1024,
    api: /** @type {'on' | 'off'} */ (api),
    publicOrigin,
    adminSocket,
    secrets: null,
  });
}

/** 앞단 없이 바깥에서 붙을 수 있는 주소인지(시작할 때 경고만 한다). @param {string} host */
export function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

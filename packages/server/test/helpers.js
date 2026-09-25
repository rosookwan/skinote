// @ts-check
// 시험이 함께 쓰는 도우미(파일 이름이 *.test.js가 아니라 node --test가 따로 돌리지 않는다).

import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

export const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));

/** 시험마다 지울 임시 폴더(macOS의 /var → /private/var 링크를 푼 경로). */
export function tempDir(prefix = 'skinote-server-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 시험용 설정: 포트 0(운영체제가 고름), 판 이름 'test', 백업이 남길 디스크 여유 0(시험 기계의 디스크에 기대지 않음).
 * 환경 변수로 더 바꿀 수 있다.
 * @param {string} dataDir @param {Record<string, string>} [env]
 * @returns {import('../src/config.js').ServerConfig}
 */
export function testConfig(dataDir, env = {}) {
  const config = loadConfig(
    { SKINOTE_DATA_DIR: dataDir, SKINOTE_RELEASE: 'test', SKINOTE_BACKUP_RESERVE_MB: '0', ...env },
    { releaseFile: join(dataDir, 'NO_RELEASE') },
  );
  return { ...config, port: 0 };
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

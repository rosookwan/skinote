#!/usr/bin/env node
// @ts-check
// 서버 시작점(systemd skinote-server.service가 부른다: WorkingDirectory=/srv/skinote/current/server, node src/main.js).
// 설정이 틀리거나 API를 켰는데 비밀값(secrets.js)이 없으면 78(EX_CONFIG)로 끝난다: 유닛의 RestartPreventExitStatus=78이 같은 실패로
// 다시 시작하지 않게 한다. 다른 프로세스가 매장 파일의 쓰는 사람 잠금을 쥐고 있으면(WRITER_LOCKED) 1로 끝난다.
// SIGTERM · SIGINT를 받으면 새 연결을 받지 않고, 처리 중인 요청을 끝내고, 데이터베이스를 닫고 끝난다.
// 신호 처리는 시작(마이그레이션 · 실행기의 VACUUM INTO 백업, 동기) 전에 건다: 그동안 온 신호는 표시만 하고, 시작이 끝난 뒤에
// 곧바로 닫는다. 기본 동작(바로 죽음)으로 VACUUM INTO가 반쯤 쓴 사본이 남지 않게. systemd의 TimeoutStopSec는 긴 마이그레이션을
// 기다릴 만큼 길다(deploy/skinote-server.service).

import { ConfigError, isLoopbackHost, loadConfig } from './config.js';
import { loadSecrets } from './secrets.js';
import { startServer } from './server.js';

const EX_CONFIG = 78;
const FORCE_EXIT_MS = 15_000;

async function main() {
  let config;
  try {
    const loaded = loadConfig();
    config = { ...loaded, secrets: loaded.api === 'on' ? loadSecrets(process.env) : null };
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = EX_CONFIG;
      return;
    }
    throw error;
  }
  if (!isLoopbackHost(config.host)) {
    console.warn(`주의: SKINOTE_HOST=${config.host} — 앞단(Caddy) 없이 바깥에서 바로 붙을 수 있습니다`);
  }
  if (config.shopIds.length === 0) console.warn('주의: SKINOTE_SHOP_IDS가 비어 있습니다(control 파일만 엽니다)');

  /** @type {Awaited<ReturnType<typeof startServer>> | null} */
  let app = null;
  /** @type {NodeJS.Signals | null} */
  let stopRequested = null;
  const closeApp = () => {
    const force = setTimeout(() => {
      console.error('종료가 늦어 강제로 끝냅니다');
      process.exit(1);
    }, FORCE_EXIT_MS);
    force.unref();
    /** @type {NonNullable<typeof app>} */ (app).close().then(() => {
      console.log('종료: 데이터베이스를 닫았습니다');
      process.exitCode = 0;
    });
  };
  /** @param {NodeJS.Signals} signal */
  const stop = signal => {
    if (stopRequested) return;
    stopRequested = signal;
    if (app) {
      console.log(`${signal} 받음: 종료 시작`);
      closeApp();
    } else {
      console.log(`${signal} 받음: 시작(마이그레이션 · 백업)을 마친 뒤 종료`);
    }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  app = await startServer(config);
  if (stopRequested) {
    console.log(`${stopRequested} 받음: 종료 시작`);
    closeApp();
  }
}

main().catch(error => {
  const e = /** @type {Error & { code?: string }} */ (error);
  console.error(`시작하지 못함${e.code ? `(${e.code})` : ''}: ${e.message}`);
  process.exit(1);
});

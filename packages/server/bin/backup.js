#!/usr/bin/env node
// @ts-check
// 날마다 백업 명령(systemd skinote-backup.timer → skinote-backup.service, 새벽 04:00 Asia/Seoul).
//   node bin/backup.js          설정(환경 변수)의 모든 데이터베이스를 <자료 폴더>/backups/<날짜>/에 백업
// 끝 코드: 0 = 모두 성공, 1 = 하나라도 실패(디스크 여유 부족 NO_SPACE 포함. 오래된 폴더 정리는 그래도 하고, 파일마다 마지막 온전한
// 사본은 남긴다), 78 = 설정 오류. 1이면 systemd가 알림 유닛(skinote-alert@skinote-backup)을 돌린다.

import { ConfigError, loadConfig } from '../src/config.js';
import { runBackup } from '../src/backup.js';

try {
  const config = loadConfig();
  const result = runBackup(config);
  const failed = result.items.filter(item => !item.ok);
  console.log(`백업 ${result.date}: ${result.items.length - failed.length}/${result.items.length}개 성공${result.removed.length ? ` · 지운 폴더 ${result.removed.join(', ')}` : ''}`);
  for (const item of failed) console.error(`실패: ${item.source} (${item.error})`);
  if (!result.items.length) console.error('백업할 데이터베이스가 없습니다');
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exitCode = 78;
  } else {
    const e = /** @type {Error & { code?: string }} */ (error);
    console.error(`백업 오류${e.code ? `(${e.code})` : ''}: ${e.message}`);
    process.exitCode = 1;
  }
}

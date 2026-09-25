// 매장 파일마다 쓰는 사람 하나(D4, deployment 2-2): 옆 파일 `<dataDir>/locks/<shopId>.writer`를 openDatabase()로 열고
// busy_timeout = 0으로 BEGIN IMMEDIATE를 잡아 프로세스가 사는 동안 쥔다. 잠금은 운영체제의 파일 잠금이라 프로세스가 죽으면(충돌 ·
// kill -9 · 재부팅) 저절로 풀린다: 남은 pid 파일 같은 낡은 잠금이 생기지 않는다. 다른 서버나 쓰기가 필요한 명령줄은 곧바로
// SQLITE_BUSY를 받고 물러난다(null).
import { existsSync, mkdirSync } from 'node:fs';
import { openDatabase } from '@skinote/schema';
import type { Db } from './db.ts';

/** 잠금 파일 이름에 쓰는 매장 id 모양(경로를 벗어나지 않게). */
const SHOP_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface WriterLock {
  readonly file: string;
  release(): void;
}

/** 잠금 파일 경로. */
export function lockFile(dataDir: string, shopId: string): string {
  if (!SHOP_ID.test(shopId)) throw new Error('매장 id 모양: ' + shopId);
  return dataDir.replace(/\/+$/, '') + '/locks/' + shopId + '.writer';
}

const busy = (error: unknown) => /SQLITE_BUSY|database is locked/i.test(String((error as { message?: unknown })?.message ?? error)) || (error as { errcode?: unknown })?.errcode === 5;

/** 쓰는 사람 잠금을 잡는다. 다른 프로세스(또는 이 프로세스의 다른 연결)가 쥐고 있으면 기다리지 않고 null. */
export function acquireWriterLock(dataDir: string, shopId: string): WriterLock | null {
  const file = lockFile(dataDir, shopId);
  const dir = file.slice(0, file.lastIndexOf('/'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o750 });
  let db: Db;
  try {
    db = openDatabase(file);
  } catch (error) {
    if (busy(error)) return null;
    throw error;
  }
  try {
    // 빈 파일은 첫 쓰기가 커밋되어야 WAL 머리가 생긴다. 그 전에 잠금을 쥐면 다음 연결의 openDatabase()가 WAL로 바꾸려다 기다린다.
    // 그래서 처음 한 번 작은 표를 만들어 파일을 WAL로 굳힌 뒤 잠금을 잡는다(그 뒤의 연결은 바꿀 것이 없어 기다리지 않는다).
    db.exec('CREATE TABLE IF NOT EXISTS writer_lock (shop_id TEXT NOT NULL PRIMARY KEY) STRICT');
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    db.close();
    if (busy(error)) return null;
    throw error;
  }
  let held = true;
  return {
    file,
    release() {
      if (!held) return;
      held = false;
      try {
        db.exec('ROLLBACK');
      } finally {
        db.close();
      }
    },
  };
}

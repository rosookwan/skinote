// 저장소 시험이 함께 쓰는 도우미(이 파일은 *.test.ts가 아니라 node --test가 따로 돌리지 않는다).
// - 마이그레이션한 매장 · control 파일(메모리 또는 임시 폴더), 견본 매장을 만든 저장소, 무작위 비밀.
// - 명령 실행은 저장소의 기본(도메인 execute)이다.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { newRequestId, type AnyCommandEnvelope, type CommandOutcome, type CommandPayloads, type CommandType } from '@skinote/contract';
import { kstAt } from '@skinote/domain';
import { sampleSpec } from '@skinote/domain/sample';
import { applyPending, openDatabase } from '@skinote/schema';
import { all, num, one, openShopStore, str, type Actor, type Db, type ShopStore, type ShopStoreOptions } from '../src/index.ts';

export const SHOP = 'shop0test';
/** 매장을 만든 때: 12월 26일 09:00(한국). 영업일 기준 06:00이라 그날 영업일이다. */
export const T0 = kstAt('2026-12-26', 0, 9, 0);
export const MINUTE = 60_000;

export function tempDir(prefix = 'skinote-store-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 마이그레이션한 파일(file 없으면 메모리). */
export function migrated(kind: 'shop' | 'control', file = ':memory:'): Db {
  const db = openDatabase(file);
  applyPending(db, kind, { appVersion: 'test' });
  return db;
}

export const secrets = () => ({ fingerprintKey: new Uint8Array(randomBytes(32)) });

export const COUNTER: Actor = { key: 'staff:test-counter', name: '오세린', roleKey: 'counter' };

export interface Provisioned {
  db: Db;
  store: ShopStore;
  epoch: string;
  options: ShopStoreOptions;
  /** 같은 연결 위의 새 저장소(캐시 없음). */
  reopen(): ShopStore;
}

/** 견본 명세로 만든 매장(메모리 파일, 또는 file). */
export function provisioned(file = ':memory:', extra: Partial<ShopStoreOptions> = {}): Provisioned {
  const db = migrated('shop', file);
  const options: ShopStoreOptions = { secrets: secrets(), ...extra };
  const store = openShopStore(db, SHOP, options);
  const { epoch } = store.provision(sampleSpec(), T0, { isTest: true });
  return { db, store, epoch, options, reopen: () => openShopStore(db, SHOP, options) };
}

let serial = 0;
/** 명령 봉투(요청번호는 새로, 바탕은 지금 epoch · rev). */
export function envelope<T extends CommandType>(
  type: T, payload: CommandPayloads[T], basis: { epoch: string; rev: number }, extra: Partial<Pick<AnyCommandEnvelope, 'dependsOn' | 'expect' | 'requestId'>> = {},
): AnyCommandEnvelope {
  serial += 1;
  return { type, commandVersion: 1, requestId: extra.requestId ?? newRequestId(T0 + serial), basis, payload, ...(extra.dependsOn ? { dependsOn: extra.dependsOn } : {}), ...(extra.expect ? { expect: extra.expect } : {}) } as AnyCommandEnvelope;
}

/** 모든 사용자 표의 행 수(같은 요청을 두 번 보내도 바뀌지 않는지). */
export function rowCounts(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of all(db, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    const name = str(r.name);
    out[name] = num(one(db, 'SELECT count(*) AS n FROM "' + name + '"')?.n);
  }
  return out;
}

/** 두 행 수의 다른 표. */
export function countDiff(a: Record<string, number>, b: Record<string, number>): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) out[k] = [a[k] ?? 0, b[k] ?? 0];
  return out;
}

export const outcomeOf = (outcome: CommandOutcome) => outcome.outcome;

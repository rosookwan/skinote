// @skinote/schema(JS + JSDoc)에서 저장소가 쓰는 것의 형식. 연결은 늘 openDatabase()로 연다(node:sqlite를 직접 가져오지 않는다, D10).
declare module '@skinote/schema' {
  import type { Db } from '../src/db.ts';
  export function openDatabase(file: string, options?: { readOnly?: boolean }): Db;
  export function verifyConnection(db: Db, options?: { requireWal?: boolean }): Record<string, unknown>;
  export interface Migration { id: number; name: string; kind: 'control' | 'shop'; file: string | null; sql: string; checksum: string }
  export function loadMigrations(kind: 'control' | 'shop', dir?: string): Migration[];
  export function applyPending(db: Db, kind: 'control' | 'shop', options?: { migrations?: Migration[]; appVersion?: string; now?: () => Date }): unknown[];
  export function migrate(file: string, kind: 'control' | 'shop', options?: { appVersion?: string; migrationsDir?: string; backupDir?: string }): {
    db: Db; status: string; mode: string; version: number;
  };
}

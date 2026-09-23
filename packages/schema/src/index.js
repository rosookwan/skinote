// @ts-check
// @skinote/schema의 공개 입구. 서버 · 가져오기 · 검증기 · 복구 시험은 openDatabase()로 연결을 열고(설정 확인),
// 시작할 때 migrate()로 control · shop 파일을 맞춘다. 메모리 DB(시험 · 체험판)는 openDatabase(':memory:') + applyPending().

export { CONNECTION_SETTINGS, ConnectionSettingsError, isMemoryDatabase, openDatabase, verifyConnection } from './connection.js';
export { assertKind, checksum, FILE_PATTERN, fromSources, loadMigrations, MigrationSetError, MIGRATIONS_DIR } from './migrations.js';
export { applyPending, backupDatabase, inspectFile, migrate, MigrationError, readState, REFUSAL_MESSAGES } from './migrate.js';
export { buildMigration, buildMigrations, DATABASE_KINDS, SchemaSplitError, splitSchema } from './split.js';
export { findListChecks, guardedTables, inspectStructure, integrityOf, ledgerTables } from './structure.js';

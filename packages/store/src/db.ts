// 연결의 구조 형식(plan D10): 저장소는 node:sqlite를 가져오지 않고, @skinote/schema의 openDatabase()가 연 연결(DatabaseSync)을 이
// 모양으로 받는다. 행을 넣고 읽는 작은 도우미도 여기 둔다: 문장 캐시(연결마다), 객체 한 행 넣기, 한 행 · 여러 행 읽기, 불리언 → 0 · 1.
// 장부 표에는 INSERT만 쓰고 INSERT OR REPLACE · REPLACE INTO · INSERT OR IGNORE는 쓰지 않는다(AGENTS.md, lint --code가 찾는다).

/** SQLite에 넣는 값. 불리언은 bind 전에 0 · 1로 바꾼다(sqlValue). */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface Stmt {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
}

/** openDatabase()가 돌려주는 연결(DatabaseSync)이 맞추는 모양. */
export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
}

/** 행 객체에 넣을 수 있는 값(undefined는 NULL, 불리언은 0 · 1). */
export type InValue = SqlValue | boolean | undefined;

export const sqlValue = (value: InValue): SqlValue => (value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value);

const cache = new WeakMap<Db, Map<string, Stmt>>();

/** 연결마다 한 번만 준비하는 문장. */
export function stmt(db: Db, sql: string): Stmt {
  let map = cache.get(db);
  if (!map) {
    map = new Map();
    cache.set(db, map);
  }
  let s = map.get(sql);
  if (!s) {
    s = db.prepare(sql);
    map.set(sql, s);
  }
  return s;
}

export const run = (db: Db, sql: string, ...params: InValue[]) => stmt(db, sql).run(...params.map(sqlValue));
export const one = <T = Row>(db: Db, sql: string, ...params: InValue[]): T | undefined => stmt(db, sql).get(...params.map(sqlValue)) as T | undefined;
export const all = <T = Row>(db: Db, sql: string, ...params: InValue[]): T[] => stmt(db, sql).all(...params.map(sqlValue)) as T[];

/** 표 이름 · 열 이름으로 쓰는 글자(문장에 이어 붙이므로 모양을 확인한다). */
const NAME = /^[a-z_][a-z0-9_]*$/;

/** 객체 한 행 넣기: 열은 객체의 키(undefined 값의 열은 빼서 표의 기본값을 쓴다). */
export function insert(db: Db, table: string, row: Record<string, InValue>): void {
  if (!NAME.test(table)) throw new Error('표 이름 모양: ' + table);
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  for (const c of cols) if (!NAME.test(c)) throw new Error('열 이름 모양: ' + c);
  const sql = 'INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')';
  run(db, sql, ...cols.map((c) => row[c]));
}

/** 숫자 열(INTEGER) 읽기: 없거나 NULL이면 fallback. */
export const num = (value: SqlValue | undefined, fallback = 0): number => (typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : fallback);
/** 글 열 읽기: NULL이면 undefined. */
export const text = (value: SqlValue | undefined): string | undefined => (typeof value === 'string' ? value : undefined);
/** 글 열 읽기(NOT NULL 열). */
export const str = (value: SqlValue | undefined): string => {
  if (typeof value !== 'string') throw new Error('글 열이 비었다');
  return value;
};

let savepoints = 0;
/**
 * 여러 문장을 한 덩어리로(SAVEPOINT): 트랜잭션 안에서 불러도 밖에서 불러도 된다. 도중에 던지면 그 덩어리만 되돌리고 다시 던진다.
 * 기기 등록처럼 셈 · 행 · 표시를 함께 쓰는 곳이 쓴다.
 */
export function atomically<T>(db: Db, fn: () => T): T {
  const name = 'sn_' + (savepoints += 1);
  db.exec('SAVEPOINT ' + name);
  try {
    const out = fn();
    db.exec('RELEASE ' + name);
    return out;
  } catch (error) {
    db.exec('ROLLBACK TO ' + name);
    db.exec('RELEASE ' + name);
    throw error;
  }
}

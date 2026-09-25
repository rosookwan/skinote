// @ts-check
// 오류를 상태 확인 · 백업 목록에 싣는 코드로 바꾼다. 메시지(경로가 들어갈 수 있다)는 싣지 않고 코드만 싣는다.
// node:sqlite의 오류는 모두 code 'ERR_SQLITE_ERROR'라 그대로는 까닭을 가를 수 없다: errcode(SQLite 결과 코드)의
// 아래 8비트(주 코드)를 이름으로 바꿔 'SQLITE_READONLY' · 'SQLITE_CORRUPT' · 'SQLITE_NOTADB' 같은 코드로 싣는다.

/** SQLite 주 결과 코드(https://sqlite.org/rescode.html). */
const SQLITE_PRIMARY = Object.freeze({
  1: 'ERROR', 2: 'INTERNAL', 3: 'PERM', 4: 'ABORT', 5: 'BUSY', 6: 'LOCKED', 7: 'NOMEM', 8: 'READONLY',
  9: 'INTERRUPT', 10: 'IOERR', 11: 'CORRUPT', 12: 'NOTFOUND', 13: 'FULL', 14: 'CANTOPEN', 15: 'PROTOCOL',
  16: 'EMPTY', 17: 'SCHEMA', 18: 'TOOBIG', 19: 'CONSTRAINT', 20: 'MISMATCH', 21: 'MISUSE', 22: 'NOLFS',
  23: 'AUTH', 24: 'FORMAT', 25: 'RANGE', 26: 'NOTADB', 27: 'NOTICE', 28: 'WARNING',
});

const CODE_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/**
 * 오류의 코드(영문 · 숫자 · '_'만, 64자까지). 모르면 fallback.
 * @param {unknown} error @param {string} fallback
 */
export function errorCode(error, fallback) {
  const e = /** @type {{ code?: unknown, errcode?: unknown }} */ (error ?? {});
  if (e.code === 'ERR_SQLITE_ERROR' && typeof e.errcode === 'number') {
    const name = SQLITE_PRIMARY[/** @type {keyof typeof SQLITE_PRIMARY} */ (e.errcode & 0xff)];
    if (name) return `SQLITE_${name}`;
  }
  return typeof e.code === 'string' && CODE_PATTERN.test(e.code) ? e.code : fallback;
}

/** 기록(journald)에 적을 메시지. @param {unknown} error */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

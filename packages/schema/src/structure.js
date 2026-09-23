// @ts-check
// 스키마 모양 확인(옛 review/validate2.cjs의 구조 검사). 시험과 lint가 쓴다.
// - 모든 외래 키 묶음이 부모의 기본 키나 부분 조건 없는 유일 인덱스를 가리킨다(나중에 풀 수 있는 유일성만 FK 대상).
// - 표 안의 UNIQUE 제약이 없다(유일성은 모두 이름 있는 CREATE UNIQUE INDEX, data-model 3-8).
// - CHECK의 IN 목록은 불리언 · 부호뿐이다(닫힌 어휘는 sys_* 표, 1절 원칙 4).

import { ALLOWED_IN_LISTS, findInListsInChecks, splitStatements } from './sql.js';

/**
 * @typedef {import('node:sqlite').DatabaseSync} DatabaseSync
 * @typedef {{ code: string, table: string, message: string }} StructureProblem
 */

/** @param {DatabaseSync} db @param {string} sql @param {...any} args */
const all = (db, sql, ...args) => /** @type {any[]} */ (db.prepare(sql).all(...args));

/** @param {string} name */
const q = name => `"${name.replace(/"/g, '""')}"`;

/** @param {DatabaseSync} db */
export function tableNames(db) {
  return all(db, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name);
}

/** @param {DatabaseSync} db @param {string} table */
export function columnsOf(db, table) {
  const cols = all(db, `PRAGMA table_info(${q(table)})`).map(c => c.name);
  if (!cols.length) throw new Error(`표가 없습니다: ${table}`);
  return cols;
}

/** 기본 키 열(순서대로). @param {DatabaseSync} db @param {string} table */
export function primaryKeyOf(db, table) {
  return all(db, `PRAGMA table_info(${q(table)})`).filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
}

/**
 * 부모 표에서 FK가 가리킬 수 있는 열 묶음(기본 키, 부분 조건 없는 유일 인덱스). 정렬한 열 이름을 ','로 이은 글.
 * @param {DatabaseSync} db @param {string} table
 */
function keySets(db, table) {
  const sets = [];
  const pk = primaryKeyOf(db, table);
  if (pk.length) sets.push(pk);
  for (const ix of all(db, `PRAGMA index_list(${q(table)})`)) {
    if (ix.unique && !ix.partial) sets.push(all(db, `PRAGMA index_info(${q(ix.name)})`).map(c => c.name));
  }
  return sets.map(s => [...s].sort().join(','));
}

/**
 * 구조 검사. problems가 비어 있어야 한다.
 * @param {DatabaseSync} db
 */
export function inspectStructure(db) {
  const tables = tableNames(db);
  const indexes = /** @type {any} */ (db.prepare("SELECT count(*) AS c FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL").get()).c;
  const triggers = /** @type {any} */ (db.prepare("SELECT count(*) AS c FROM sqlite_schema WHERE type = 'trigger'").get()).c;
  /** @type {StructureProblem[]} */
  const problems = [];
  let fkGroups = 0;
  for (const t of tables) {
    for (const ix of all(db, `PRAGMA index_list(${q(t)})`)) {
      if (ix.origin === 'u') problems.push({ code: 'INLINE_UNIQUE', table: t, message: `표 안 UNIQUE 제약 ${ix.name}: 이름 있는 CREATE UNIQUE INDEX로 쓰세요` });
    }
    /** @type {Record<number, any[]>} */
    const byId = {};
    for (const fk of all(db, `PRAGMA foreign_key_list(${q(t)})`)) (byId[fk.id] ||= []).push(fk);
    const cols = columnsOf(db, t);
    for (const group of Object.values(byId)) {
      fkGroups += 1;
      const parent = group[0].table;
      const from = group.map(g => g.from).join(',');
      if (!tables.includes(parent)) {
        problems.push({ code: 'FK_MISSING_PARENT', table: t, message: `${t}(${from}) → 없는 표 ${parent}` });
        continue;
      }
      const target = group.some(g => g.to == null) ? primaryKeyOf(db, parent) : group.map(g => g.to);
      if (!keySets(db, parent).includes([...target].sort().join(','))) {
        problems.push({ code: 'FK_TARGET', table: t, message: `${t}(${from}) → ${parent}(${target.join(',')}): 기본 키나 부분 조건 없는 유일 인덱스가 아닙니다` });
      }
      for (const g of group) {
        if (!cols.includes(g.from)) problems.push({ code: 'FK_MISSING_COLUMN', table: t, message: `${t}에 ${g.from} 열이 없습니다` });
      }
      const parentCols = columnsOf(db, parent);
      for (const g of group) {
        if (g.to != null && !parentCols.includes(g.to)) problems.push({ code: 'FK_MISSING_COLUMN', table: parent, message: `${parent}에 ${g.to} 열이 없습니다` });
      }
    }
  }
  const sysTables = tables.filter(t => t.startsWith('sys_')).length;
  const tenantTables = tables.filter(t => all(db, `PRAGMA table_info(${q(t)})`).some(c => c.name === 'shop_id' && c.notnull)).length;
  return { tables: tables.length, sysTables, tenantTables, indexes, triggers, fkGroups, problems };
}

/**
 * SQL 글에서 불리언 · 부호가 아닌 CHECK IN 목록을 찾는다.
 * @param {string} sql
 * @returns {{ values: string, line: number }[]}
 */
export function findListChecks(sql) {
  const found = [];
  for (const statement of splitStatements(sql)) {
    for (const list of findInListsInChecks(statement.tokens)) if (!ALLOWED_IN_LISTS.includes(list.values)) found.push(list);
  }
  return found;
}

/**
 * 파일 전체 확인: foreign_key_check가 비고 integrity_check가 ok인지.
 * @param {DatabaseSync} db
 */
export function integrityOf(db) {
  const fkCheck = all(db, 'PRAGMA foreign_key_check');
  const integrity = all(db, 'PRAGMA integrity_check').map(r => r.integrity_check);
  return { fkCheck, integrity };
}

/**
 * 장부 표(추가 전용 트리거 'APPEND_ONLY <표>'가 걸린 표)와 그 트리거가 막는 열.
 * @param {DatabaseSync} db
 * @returns {Map<string, Set<string>>} 표 → 수정이 막힌 열
 */
export function guardedTables(db) {
  /** @type {Map<string, Set<string>>} */
  const out = new Map();
  for (const row of all(db, "SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'trigger'")) {
    const statement = splitStatements(row.sql)[0];
    if (!statement) continue;
    const tokens = statement.tokens;
    const raise = tokens.find(t => t.type === 'string' && /^(APPEND_ONLY|FROZEN) /.test(t.value));
    if (!raise) continue;
    const set = out.get(row.tbl_name) ?? new Set();
    out.set(row.tbl_name, set);
    const of = tokens.findIndex(t => t.type === 'word' && t.upper === 'OF');
    const on = tokens.findIndex(t => t.type === 'word' && t.upper === 'ON');
    const begin = tokens.findIndex(t => t.type === 'word' && t.upper === 'BEGIN');
    // WHEN이 붙은 트리거('한 번만' 등)는 빈 값을 채우는 수정을 허용하므로 막힌 열로 세지 않는다.
    const conditional = tokens.slice(on, begin).some(t => t.type === 'word' && t.upper === 'WHEN');
    if (of > 0 && on > of && !conditional) {
      for (const t of tokens.slice(of + 1, on)) if (t.type === 'word' || t.type === 'ident') set.add(t.value.toLowerCase());
    }
  }
  return out;
}

/**
 * 조건이 붙은 보호 트리거(WHEN: '한 번만' · '가리기만')가 지키는 열. 빈 칸을 채우는 수정은 트리거가 허락하지만, 값이 든 행을
 * 바꾸면 적용이 멈춘다. 마이그레이션 검사는 이 열의 UPDATE를 막는다(빈 시험 DB에서는 트리거가 돌지 않아 통과하므로).
 * @param {DatabaseSync} db
 * @returns {Map<string, Set<string>>} 표 → 열
 */
export function conditionallyGuardedColumns(db) {
  /** @type {Map<string, Set<string>>} */
  const out = new Map();
  for (const row of all(db, "SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'trigger'")) {
    const statement = splitStatements(row.sql)[0];
    if (!statement) continue;
    const tokens = statement.tokens;
    if (!tokens.some(t => t.type === 'string' && /^(APPEND_ONLY|FROZEN|REDACT_ONLY) /.test(t.value))) continue;
    const of = tokens.findIndex(t => t.type === 'word' && t.upper === 'OF');
    const on = tokens.findIndex(t => t.type === 'word' && t.upper === 'ON');
    const begin = tokens.findIndex(t => t.type === 'word' && t.upper === 'BEGIN');
    const conditional = tokens.slice(on, begin).some(t => t.type === 'word' && t.upper === 'WHEN');
    if (!conditional || of < 0 || on < of) continue;
    const set = out.get(row.tbl_name) ?? new Set();
    out.set(row.tbl_name, set);
    for (const t of tokens.slice(of + 1, on)) if (t.type === 'word' || t.type === 'ident') set.add(t.value.toLowerCase());
  }
  return out;
}

/**
 * 추가 전용(APPEND_ONLY) 장부 표 이름.
 * @param {DatabaseSync} db
 */
export function ledgerTables(db) {
  const out = new Set();
  for (const row of all(db, "SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'trigger'")) {
    if (String(row.sql).includes(`'APPEND_ONLY ${row.tbl_name}'`)) out.add(row.tbl_name);
  }
  return out;
}

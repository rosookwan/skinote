#!/usr/bin/env node
// @ts-check
// 마이그레이션 검사(data-model 7-2). CI와 시험이 돌린다.
//   node tools/lint.js [--dir <migrations 폴더>] [--code <파일이나 폴더> ...]
//
// 마이그레이션마다 문장을 나눠 허용 목록으로 확인한 뒤, 메모리 DB에 차례로 적용하며 적용 뒤 상태(열 목록, 장부 표)로
// 트리거 모양과 외래 키 대상을 확인한다.
// - 허용: CREATE TABLE · INDEX · VIEW, ADD COLUMN(빈 값 허용 또는 상수 기본값), sys_* · json_schemas INSERT,
//   sys_event_types.engine_key UPDATE, sys_event_types · sys_movement_routes의 offline_allowed = 1 UPDATE(0 → 1만: 새
//   sys_offline_commands 행과 함께 오프라인 허용을 넓힐 때), 채우기 UPDATE(장부 표는 0001 수정 금지 열 밖만), DROP INDEX · VIEW,
//   정해진 모양의 트리거 네 가지(src/guards.js가 만드는 글과 토큰이 같아야 함).
// - 금지: DROP TABLE · DROP COLUMN · RENAME, ADD COLUMN의 CHECK · REFERENCES · 기본값 없는 NOT NULL, CREATE TABLE … AS,
//   표 안 UNIQUE, CHECK IN 목록(불리언 · 부호 밖), sys_* 행 key 바꾸기 · 지우기(DELETE 전부), DROP TRIGGER,
//   INSERT OR REPLACE · REPLACE INTO · UPDATE OR REPLACE · INSERT OR IGNORE, INSERT … ON CONFLICT(DO UPDATE는 sys_event_types의
//   engine_key만, DO NOTHING은 금지), 트랜잭션 · PRAGMA 문장, 0001 보호 열(조건이 붙은 '한 번만' · '가리기만' 열 포함)의 UPDATE.
// - 이미 있는 장부 표에 ADD COLUMN을 하면 같은 마이그레이션에 그 열의 '한 번만'(<표>_<열>_once) 또는 자유 글이면 '가리기만'
//   (<표>_<열>_redact_only) 트리거가 있어야 한다(data-model E4).
// 0001은 기준판이다: 트리거는 생성기가 만든 것과 같아야 하고, 손으로 쓴 요금표 트리거(BASELINE_HANDWRITTEN)만 더 허용한다.
// --code: 앱 코드(store · server 등)에서 장부 표에 OR REPLACE · REPLACE INTO · INSERT OR IGNORE를 쓰는 곳,
//   node:sqlite를 가져오는 곳(이름을 바꾸거나 모듈째 가져와도)을 찾는다. 연결은 src/connection.js의 openDatabase()만 연다.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from '../src/connection.js';
import {
  BASELINE_HANDWRITTEN, baselineTriggers, ledgerGuards, oneOfGuard, redactOnlyGuard, requiredGuard, setOnceGuard,
} from '../src/guards.js';
import { loadMigrations, MIGRATIONS_DIR } from '../src/migrations.js';
import {
  ALLOWED_IN_LISTS, findInListsInChecks, isName, readQualifiedName, splitStatements, sqlKey, tokenKey,
} from '../src/sql.js';
import { columnsOf, conditionallyGuardedColumns, guardedTables, inspectStructure, ledgerTables, primaryKeyOf, tableNames } from '../src/structure.js';

/**
 * @typedef {import('../src/migrations.js').Migration} Migration
 * @typedef {import('../src/migrations.js').DatabaseKind} DatabaseKind
 * @typedef {import('../src/sql.js').Statement} Statement
 * @typedef {import('../src/sql.js').Token} Token
 * @typedef {{ file: string, line: number, code: string, message: string }} LintProblem
 */

/** sys_* 밖에서 마이그레이션이 행을 넣을 수 있는 시드 표. */
export const SEED_TABLES = Object.freeze(['json_schemas']);

/** @param {Token[]} t @param {number} i */
const word = (t, i) => (t[i]?.type === 'word' ? t[i].upper : '');

/**
 * WITH … 뒤의 첫 DML 낱말 위치.
 * @param {Token[]} t
 */
function dmlIndex(t) {
  let depth = 0;
  for (let k = 0; k < t.length; k += 1) {
    const x = t[k];
    if (x.type === 'punct' && x.value === '(') depth += 1;
    else if (x.type === 'punct' && x.value === ')') depth -= 1;
    else if (depth === 0 && x.type === 'word' && ['INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'SELECT'].includes(x.upper) && k > 0) return k;
  }
  return -1;
}

/**
 * UPDATE … SET 뒤의 열 이름들(소문자).
 * @param {Token[]} t @param {number} start SET 다음 위치
 */
function setColumns(t, start) {
  const cols = [];
  let depth = 0;
  let expectName = true;
  for (let k = start; k < t.length; k += 1) {
    const x = t[k];
    if (x.type === 'punct' && x.value === '(') {
      if (depth === 0 && expectName) {
        for (k += 1; k < t.length && !(t[k].type === 'punct' && t[k].value === ')'); k += 1) if (isName(t[k])) cols.push(t[k].value.toLowerCase());
        expectName = false;
        continue;
      }
      depth += 1;
      continue;
    }
    if (x.type === 'punct' && x.value === ')') { depth -= 1; continue; }
    if (depth > 0) continue;
    if (x.type === 'word' && ['FROM', 'WHERE', 'RETURNING', 'ORDER', 'LIMIT'].includes(x.upper)) break;
    if (x.type === 'punct' && x.value === ',') { expectName = true; continue; }
    if (expectName && isName(x)) {
      cols.push(x.value.toLowerCase());
      expectName = false;
    }
  }
  return cols;
}

/**
 * UPDATE … SET의 맨 바깥 `열 = 값` 중 그 열의 값 토큰들(다음 쉼표나 FROM · WHERE 전까지).
 * @param {Token[]} t @param {number} start SET 다음 위치 @param {string} column 소문자 열 이름
 * @returns {Token[][]}
 */
function setValues(t, start, column) {
  /** @type {Token[][]} */
  const out = [];
  let depth = 0;
  for (let k = start; k < t.length; k += 1) {
    const x = t[k];
    if (x.type === 'punct' && x.value === '(') { depth += 1; continue; }
    if (x.type === 'punct' && x.value === ')') { depth -= 1; continue; }
    if (depth > 0) continue;
    if (x.type === 'word' && ['FROM', 'WHERE', 'RETURNING', 'ORDER', 'LIMIT'].includes(x.upper)) break;
    if (isName(x) && x.value.toLowerCase() === column && t[k + 1]?.value === '=') {
      /** @type {Token[]} */
      const value = [];
      for (k += 2; k < t.length; k += 1) {
        const y = t[k];
        if (y.type === 'punct' && y.value === '(') depth += 1;
        if (y.type === 'punct' && y.value === ')') depth -= 1;
        if (depth === 0 && ((y.type === 'punct' && y.value === ',') || (y.type === 'word' && ['FROM', 'WHERE', 'RETURNING'].includes(y.upper)))) { k -= 1; break; }
        value.push(y);
      }
      out.push(value);
    }
  }
  return out;
}

/** sys 행에서 뒤 마이그레이션이 바꿀 수 있는 열: engine_key(묶음을 native로), offline_allowed(0 → 1만). */
const SYS_UPDATABLE = Object.freeze({ sys_event_types: ['engine_key', 'offline_allowed'], sys_movement_routes: ['offline_allowed'] });

/**
 * INSERT의 맨 바깥 ON CONFLICT 절: 없으면 null, 있으면 DO UPDATE(SET 열 목록) 또는 DO NOTHING.
 * @param {Token[]} t @param {number} from INSERT 다음 위치
 * @returns {{ action: 'UPDATE', columns: string[] } | { action: 'NOTHING' } | null}
 */
function upsertClause(t, from) {
  let depth = 0;
  for (let k = from; k < t.length; k += 1) {
    const x = t[k];
    if (x.type === 'punct' && x.value === '(') { depth += 1; continue; }
    if (x.type === 'punct' && x.value === ')') { depth -= 1; continue; }
    if (depth !== 0 || x.type !== 'word' || x.upper !== 'ON' || word(t, k + 1) !== 'CONFLICT') continue;
    const at = t.findIndex((y, j) => j > k && y.type === 'word' && y.upper === 'DO');
    if (at < 0) return null;
    if (word(t, at + 1) === 'NOTHING') return { action: 'NOTHING' };
    if (word(t, at + 1) === 'UPDATE' && word(t, at + 2) === 'SET') return { action: 'UPDATE', columns: setColumns(t, at + 3) };
    return { action: 'UPDATE', columns: [] };
  }
  return null;
}

/**
 * CREATE TRIGGER 문장의 이름과 대상 표.
 * @param {Statement} s
 */
function triggerParts(s) {
  const t = s.tokens;
  let i = word(t, 1) === 'TRIGGER' ? 2 : 3;
  if (word(t, i) === 'IF' && word(t, i + 1) === 'NOT' && word(t, i + 2) === 'EXISTS') i += 3;
  const named = readQualifiedName(t, i);
  const name = named ? named.name : '';
  const on = t.findIndex((x, k) => k > i && x.type === 'word' && x.upper === 'ON');
  const table = on > 0 ? readQualifiedName(t, on + 1)?.name ?? '' : '';
  return { name, table };
}

/** @param {string} sql 생성기가 만든 여러 트리거 글 @returns {Map<string, string>} 이름 → 비교 열쇠 */
function keyedTriggers(sql) {
  return new Map(splitStatements(sql).map(s => [triggerParts(s).name, tokenKey(s.tokens)]));
}

/**
 * 한 종류의 마이그레이션을 차례로 검사한다.
 * @param {DatabaseKind} kind
 * @param {Migration[]} migrations
 * @returns {{ problems: LintProblem[], ledgers: Set<string>, guarded: Set<string> }}
 */
export function lintMigrations(kind, migrations) {
  /** @type {LintProblem[]} */
  const problems = [];
  const db = openDatabase(':memory:');
  let structureBefore = new Set();
  try {
    for (const migration of migrations) {
      const file = migration.file ? migration.name + '.sql' : migration.name;
      /** @param {number} line @param {string} code @param {string} message */
      const report = (line, code, message) => problems.push({ file, line, code, message });
      const baseline = migration.id === 1;

      /** @type {Statement[]} */
      let statements;
      try {
        statements = splitStatements(migration.sql);
      } catch (error) {
        report(/** @type {any} */ (error).line ?? 0, 'SQL_SYNTAX', /** @type {Error} */ (error).message);
        break;
      }
      const tablesBefore = new Set(tableNames(db));
      const ledgersBefore = ledgerTables(db);
      const guardedBefore = guardedTables(db);
      const softGuardedBefore = conditionallyGuardedColumns(db);
      /** @type {Set<string>} */
      const created = new Set();
      /** @type {Map<string, Set<string>>} */
      const added = new Map();
      /** @type {Statement[]} */
      const triggers = [];

      for (const s of statements) {
        const t = s.tokens;
        const lead = word(t, 0);
        if (lead === 'CREATE') {
          let i = 1;
          if (word(t, i) === 'TEMP' || word(t, i) === 'TEMPORARY') { report(s.line, 'NOT_ALLOWED', '임시(TEMP) 개체는 마이그레이션에 쓰지 않습니다'); continue; }
          if (word(t, i) === 'UNIQUE') i += 1;
          const what = word(t, i);
          if (what === 'INDEX' || what === 'VIEW') continue;
          if (what === 'TRIGGER') { triggers.push(s); continue; }
          if (what !== 'TABLE') { report(s.line, 'NOT_ALLOWED', `CREATE ${what || t[i]?.value}는 허용 목록에 없습니다`); continue; }
          i += 1;
          if (word(t, i) === 'IF' && word(t, i + 1) === 'NOT' && word(t, i + 2) === 'EXISTS') i += 3;
          const named = readQualifiedName(t, i);
          if (!named) { report(s.line, 'NOT_ALLOWED', 'CREATE TABLE의 표 이름을 읽지 못했습니다'); continue; }
          if (word(t, named.next) === 'AS') { report(s.line, 'CREATE_TABLE_AS', `CREATE TABLE ${named.name} AS …: 표를 옮겨 만드는 재구성은 금지(새 표 + 뷰, E12)`); continue; }
          if (tablesBefore.has(named.name)) report(s.line, 'EXISTING_TABLE', `이미 있는 표 ${named.name}을(를) 다시 만들 수 없습니다(*_v2 + 뷰, E12)`);
          created.add(named.name);
          const unique = t.find(x => x.type === 'word' && x.upper === 'UNIQUE');
          if (unique) report(unique.line, 'INLINE_UNIQUE', `${named.name}: 표 안 UNIQUE 대신 이름 있는 CREATE UNIQUE INDEX`);
          for (const list of findInListsInChecks(t)) {
            if (!ALLOWED_IN_LISTS.includes(list.values)) report(list.line, 'LIST_CHECK', `${named.name}: CHECK … IN (${list.values}) — 닫힌 목록은 sys_* 표와 FK로`);
          }
          continue;
        }
        if (lead === 'ALTER') {
          const named = word(t, 1) === 'TABLE' ? readQualifiedName(t, 2) : null;
          if (!named) { report(s.line, 'NOT_ALLOWED', 'ALTER TABLE만 쓸 수 있습니다'); continue; }
          const action = word(t, named.next);
          if (action === 'RENAME') { report(s.line, 'RENAME', `ALTER TABLE ${named.name} RENAME: 이름 바꾸기 금지`); continue; }
          if (action === 'DROP') { report(s.line, 'DROP_COLUMN', `ALTER TABLE ${named.name} DROP COLUMN: 열 지우기 금지`); continue; }
          if (action !== 'ADD') { report(s.line, 'NOT_ALLOWED', `ALTER TABLE ${named.name} ${action}는 허용 목록에 없습니다`); continue; }
          let j = named.next + 1;
          if (word(t, j) === 'COLUMN') j += 1;
          if (!isName(t[j])) { report(s.line, 'NOT_ALLOWED', 'ADD COLUMN의 열 이름을 읽지 못했습니다'); continue; }
          const column = t[j].value;
          const def = t.slice(j + 1);
          const words = def.filter(x => x.type === 'word').map(x => x.upper);
          if (words.includes('CHECK')) report(s.line, 'ADD_COLUMN_CHECK', `${named.name}.${column}: ADD COLUMN에 CHECK 금지(트리거 · 검증기로)`);
          if (words.includes('REFERENCES')) report(s.line, 'ADD_COLUMN_REFERENCES', `${named.name}.${column}: ADD COLUMN에 REFERENCES 금지(sys_soft_references + 검증기, 또는 1:1 확장 표 E5)`);
          if (words.includes('UNIQUE') || words.includes('PRIMARY')) report(s.line, 'INLINE_UNIQUE', `${named.name}.${column}: 열 안 UNIQUE · PRIMARY KEY 금지`);
          const notNull = def.some((x, k) => x.type === 'word' && x.upper === 'NOT' && def[k + 1]?.upper === 'NULL');
          if (notNull && !words.includes('DEFAULT')) report(s.line, 'ADD_COLUMN_NOT_NULL', `${named.name}.${column}: 기본값 없는 NOT NULL 금지('이 판부터 필수' 트리거로)`);
          if (!added.has(named.name)) added.set(named.name, new Set());
          /** @type {Set<string>} */ (added.get(named.name)).add(column.toLowerCase());
          continue;
        }
        if (lead === 'DROP') {
          const what = word(t, 1);
          if (what === 'INDEX' || what === 'VIEW') continue;
          if (what === 'TABLE') report(s.line, 'DROP_TABLE', 'DROP TABLE 금지(값이 들어갈 수 있는 표는 지우지 않음)');
          else if (what === 'TRIGGER') report(s.line, 'DROP_TRIGGER', 'DROP TRIGGER 금지(장부 트리거를 지우지 않음)');
          else report(s.line, 'NOT_ALLOWED', `DROP ${what}는 허용 목록에 없습니다`);
          continue;
        }
        if (lead === 'INSERT' || lead === 'REPLACE' || lead === 'UPDATE' || lead === 'WITH') {
          const at = lead === 'WITH' ? dmlIndex(t) : 0;
          const verb = at >= 0 ? word(t, at) : '';
          if (verb === 'INSERT' || verb === 'REPLACE') {
            let i = at + 1;
            let conflict = verb === 'REPLACE' ? 'REPLACE' : '';
            if (verb === 'INSERT' && word(t, i) === 'OR') { conflict = word(t, i + 1); i += 2; }
            const named = word(t, i) === 'INTO' ? readQualifiedName(t, i + 1) : null;
            const table = named?.name ?? '?';
            const where = ledgersBefore.has(table) ? `장부 표 ${table}` : table;
            const upsert = upsertClause(t, i);
            if (conflict === 'REPLACE') report(s.line, 'REPLACE', `${where}에 INSERT OR REPLACE · REPLACE INTO 금지(행을 지우고 다시 넣음)`);
            else if (conflict === 'IGNORE') report(s.line, 'INSERT_OR_IGNORE', `${where}에 INSERT OR IGNORE 금지(충돌을 조용히 버림)`);
            else if (!(table.startsWith('sys_') || SEED_TABLES.includes(table))) report(s.line, 'INSERT_TARGET', `${table}: 마이그레이션은 sys_* 와 시드 표에만 행을 넣습니다`);
            // ON CONFLICT(뒤 마이그레이션): DO NOTHING은 INSERT OR IGNORE와 같고, DO UPDATE는 있는 행을 바꾼다(sys_* key 바꾸기 ·
            // json_schemas 판 고쳐 쓰기). 기준판(0001)은 같은 파일 안에서 파생 시드(되돌리기 경로)를 채울 때만 DO NOTHING을 쓴다.
            if (baseline) continue;
            if (upsert?.action === 'NOTHING') report(s.line, 'INSERT_OR_IGNORE', `${where}에 ON CONFLICT DO NOTHING 금지(충돌을 조용히 버림)`);
            else if (upsert?.action === 'UPDATE' && !(table === 'sys_event_types' && upsert.columns.length > 0 && upsert.columns.every(c => c === 'engine_key'))) {
              report(s.line, 'UPSERT', `${table}: ON CONFLICT DO UPDATE(${upsert.columns.join(', ')}) 금지 — 있는 행은 sys_event_types.engine_key UPDATE만, json_schemas는 새 판을 더함`);
            }
            continue;
          }
          if (verb === 'UPDATE') {
            let i = at + 1;
            if (word(t, i) === 'OR') {
              if (word(t, i + 1) === 'REPLACE') report(s.line, 'REPLACE', 'UPDATE OR REPLACE 금지(부딪히는 행을 지움)');
              i += 2;
            }
            const named = readQualifiedName(t, i);
            const table = named?.name ?? '?';
            const set = t.findIndex((x, k) => k > i && x.type === 'word' && x.upper === 'SET');
            const cols = set > 0 ? setColumns(t, set + 1) : [];
            if (table.startsWith('sys_')) {
              const updatable = /** @type {Record<string, string[]>} */ (SYS_UPDATABLE)[table] ?? [];
              if (!(cols.length > 0 && cols.every(c => updatable.includes(c)))) {
                report(s.line, 'SYS_UPDATE', `${table}(${cols.join(', ')}): sys_* 행은 sys_event_types.engine_key와 offline_allowed = 1(sys_event_types · sys_movement_routes)만 바꿀 수 있습니다`);
              } else if (cols.includes('offline_allowed')) {
                const values = setValues(t, set + 1, 'offline_allowed');
                if (!values.every(v => v.length === 1 && v[0].type === 'number' && Number(v[0].value) === 1)) {
                  report(s.line, 'SYS_UPDATE', `${table}.offline_allowed: 오프라인 허용은 0 → 1로 넓히기만 합니다(SET offline_allowed = 1)`);
                }
              }
            } else {
              const locked = guardedBefore.get(table);
              const hit = locked ? cols.filter(c => locked.has(c)) : [];
              if (hit.length) report(s.line, 'LEDGER_UPDATE', `${table}: 0001 수정 금지 열(${hit.join(', ')})은 채우기 대상이 아닙니다`);
              // 조건이 붙은 보호 열('한 번만' · '가리기만'): 값이 든 행이 있는 매장 파일에서는 적용이 멈춘다(빈 시험 DB에서는 통과하지만).
              const soft = softGuardedBefore.get(table);
              const softHit = soft ? cols.filter(c => soft.has(c) && !hit.includes(c) && !added.get(table)?.has(c)) : [];
              if (softHit.length) report(s.line, 'LEDGER_UPDATE', `${table}: 보호 트리거가 지키는 열(${softHit.join(', ')})은 채우기 대상이 아닙니다(값이 든 매장 파일에서 적용이 멈춤)`);
            }
            continue;
          }
          report(s.line, 'NOT_ALLOWED', `${verb || lead} 문장은 마이그레이션에 쓰지 않습니다`);
          continue;
        }
        if (lead === 'DELETE') { report(s.line, 'DELETE', 'DELETE 금지(sys_* 행 지우기 포함, 업무 행은 지우지 않음)'); continue; }
        report(s.line, 'NOT_ALLOWED', `${lead || t[0].value} 문장은 마이그레이션에 쓰지 않습니다(트랜잭션 · PRAGMA는 실행기가 맡음)`);
      }

      try {
        db.exec('BEGIN');
        db.exec(migration.sql);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* 이미 끝남 */ }
        report(0, 'APPLY_FAILED', `적용하지 못했습니다: ${/** @type {Error} */ (error).message}`);
        break;
      }

      /** @param {string} table */
      const colsOf = table => columnsOf(db, table);
      if (baseline) {
        const expected = keyedTriggers(baselineTriggers(kind, colsOf));
        const handwritten = new Set(BASELINE_HANDWRITTEN[kind]);
        for (const s of triggers) {
          const { name } = triggerParts(s);
          if (expected.has(name)) {
            if (expected.get(name) !== tokenKey(s.tokens)) report(s.line, 'TRIGGER_SHAPE', `${name}: 생성기가 만든 글과 다릅니다(npm run gen-triggers)`);
            expected.delete(name);
          } else if (!handwritten.has(name)) {
            report(s.line, 'TRIGGER_SHAPE', `${name}: 0001의 트리거는 생성기가 만든 것과 손으로 쓴 요금표 트리거뿐입니다`);
          }
        }
        for (const name of expected.keys()) report(0, 'TRIGGER_MISSING', `${name}: 생성기가 만드는 트리거가 없습니다(npm run gen-triggers)`);
      } else {
        /** @type {Map<string, Map<string, string>>} */
        const newLedgers = new Map();
        for (const s of triggers) {
          const { name, table } = triggerParts(s);
          const key = tokenKey(s.tokens);
          const addedCols = added.get(table) ?? new Set();
          /** @param {string} expectedSql @param {string} what */
          const same = (expectedSql, what) => {
            if (sqlKey(expectedSql) !== key) report(s.line, 'TRIGGER_SHAPE', `${name}: ${what} 모양이 아닙니다. 기대: ${expectedSql.trim()}`);
          };
          if (!table || !tableNames(db).includes(table)) { report(s.line, 'TRIGGER_SHAPE', `${name}: 대상 표를 찾지 못했습니다`); continue; }
          if ([`${table}_no_update`, `${table}_no_delete`, `${table}_redact_only`].includes(name)) {
            if (!created.has(table)) { report(s.line, 'TRIGGER_SHAPE', `${name}: 추가 전용 트리거는 같은 마이그레이션에서 만든 새 장부 표에만(①)`); continue; }
            if (!newLedgers.has(table)) newLedgers.set(table, keyedTriggers(ledgerGuards(table, colsOf(table), { redact: kind === 'shop' })));
            const expected = /** @type {Map<string, string>} */ (newLedgers.get(table));
            if (!expected.has(name)) report(s.line, 'TRIGGER_SHAPE', `${name}: 이 표의 열에는 이 트리거가 생기지 않습니다(①)`);
            else if (expected.get(name) !== key) report(s.line, 'TRIGGER_SHAPE', `${name}: 생성기가 만든 ① 모양과 다릅니다(열 목록 확인)`);
            expected.delete(name);
            continue;
          }
          const suffix = ['_once', '_redact_only', '_required', '_one_of'].find(x => name.startsWith(table + '_') && name.endsWith(x) && name.length > table.length + 1 + x.length);
          const column = suffix ? name.slice(table.length + 1, -suffix.length) : '';
          if (!suffix || !colsOf(table).includes(column)) {
            report(s.line, 'TRIGGER_SHAPE', `${name}: 허용된 네 가지 모양(data-model 7-2)의 이름이 아닙니다(<표>_no_update · <표>_<열>_once · _required · _one_of · _redact_only)`);
            continue;
          }
          if (suffix === '_once' || suffix === '_redact_only') {
            if (!ledgersBefore.has(table)) { report(s.line, 'TRIGGER_SHAPE', `${name}: ${suffix === '_once' ? '② 한 번만' : '④ 가리기만'} 트리거는 이미 있는 장부 표에만`); continue; }
            if (!addedCols.has(column)) { report(s.line, 'TRIGGER_SHAPE', `${name}: 같은 마이그레이션에서 ADD COLUMN한 열에만`); continue; }
            same(suffix === '_once' ? setOnceGuard(table, column) : redactOnlyGuard(table, column), suffix === '_once' ? '② 한 번만' : '④ 가리기만');
            continue;
          }
          if (suffix === '_required') { same(requiredGuard(table, column), "③ '이 판부터 필수'"); continue; }
          // _one_of: WHEN 안의 NEW.<열> 목록으로 기대 글을 만든다.
          if (!addedCols.has(column)) { report(s.line, 'TRIGGER_SHAPE', `${name}: '하나만' 트리거는 같은 마이그레이션에서 ADD COLUMN한 칸에만`); continue; }
          const t = s.tokens;
          const listed = [];
          for (let k = 0; k + 2 < t.length; k += 1) if (t[k].upper === 'NEW' && t[k + 1].value === '.' && isName(t[k + 2])) listed.push(t[k + 2].value);
          if (listed.length < 2 || !listed.includes(column) || listed.some(c => !colsOf(table).includes(c))) {
            report(s.line, 'TRIGGER_SHAPE', `${name}: '하나만' 트리거는 그 표의 칸 둘 이상(새 칸 포함)을 셉니다`);
            continue;
          }
          same(oneOfGuard(table, column, listed), "③ '하나만'");
        }
        for (const [table, expected] of newLedgers) for (const name of expected.keys()) report(0, 'TRIGGER_MISSING', `${table}: ${name}도 같은 마이그레이션에 있어야 합니다(①)`);
        // E4: 이미 있는 장부 표에 더한 열은 같은 마이그레이션에서 '한 번만'(자유 글이면 '가리기만') 트리거로 지킨다.
        const triggerNames = new Set(triggers.map(s => triggerParts(s).name));
        for (const [table, columns] of added) {
          if (!ledgersBefore.has(table)) continue;
          for (const column of columns) {
            if (triggerNames.has(`${table}_${column}_once`) || triggerNames.has(`${table}_${column}_redact_only`)) continue;
            report(0, 'LEDGER_COLUMN_UNGUARDED', `${table}.${column}: 장부 표에 더한 열은 같은 마이그레이션에 ${table}_${column}_once(자유 글이면 _redact_only) 트리거가 있어야 합니다(E4)`);
          }
        }
        if (kind === 'shop') {
          for (const table of created) {
            if (table.startsWith('sys_')) continue;
            const pk = primaryKeyOf(db, table);
            if (pk[0] !== 'shop_id') report(0, 'SHOP_KEY', `${table}: 매장 표의 기본 키는 shop_id로 시작합니다(지금 ${pk.join(', ') || '없음'})`);
          }
        }
      }

      const structure = inspectStructure(db).problems;
      const now = new Set(structure.map(p => `${p.code} ${p.message}`));
      for (const p of structure) if (!structureBefore.has(`${p.code} ${p.message}`)) report(0, p.code, p.message);
      structureBefore = now;
    }
    const ledgers = ledgerTables(db);
    const guarded = new Set(/** @type {{ tbl_name: string }[]} */ (db.prepare("SELECT DISTINCT tbl_name FROM sqlite_schema WHERE type = 'trigger'").all()).map(r => r.tbl_name));
    return { problems, ledgers, guarded };
  } finally {
    db.close();
  }
}

const CODE_FILE = /\.(c|m)?(j|t)sx?$/;

/** node:sqlite를 가져와도 되는 단 하나의 파일(연결을 열고 설정을 확인하는 곳). */
export const CONNECTION_MODULE = fileURLToPath(new URL('../src/connection.js', import.meta.url));

/** 주석을 지운 글(줄 번호는 지킨다). JSDoc의 형식 가져오기(import('node:sqlite'))는 코드가 아니다. */
function withoutComments(/** @type {string} */ text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (_, lead) => lead);
}

/**
 * 앱 코드 한 파일을 검사한다.
 * @param {string} text
 * @param {string} file
 * @param {{ ledgers: Set<string>, guarded: Set<string> }} tables
 * @returns {LintProblem[]}
 */
export function lintCode(text, file, { ledgers, guarded }) {
  /** @type {LintProblem[]} */
  const problems = [];
  const lineAt = (/** @type {number} */ index) => text.slice(0, index).split('\n').length;
  const re = /\b(INSERT\s+OR\s+(REPLACE|IGNORE)\s+INTO|REPLACE\s+INTO|UPDATE\s+OR\s+REPLACE)\s+[`"[]?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const m of text.matchAll(re)) {
    const table = m[3];
    const ignore = /IGNORE/i.test(m[1]);
    if (ignore && ledgers.has(table)) {
      problems.push({ file, line: lineAt(m.index ?? 0), code: 'CODE_INSERT_OR_IGNORE', message: `장부 표 ${table}에 INSERT OR IGNORE 금지(ON CONFLICT DO NOTHING 뒤에 지문 비교)` });
    } else if (!ignore && (ledgers.has(table) || guarded.has(table))) {
      problems.push({ file, line: lineAt(m.index ?? 0), code: 'CODE_REPLACE', message: `보호된 표 ${table}에 ${m[1].replace(/\s+/g, ' ').toUpperCase()} 금지` });
    }
  }
  // 연결은 openDatabase()로만 연다: node:sqlite를 가져오는 곳을 모두 찾는다(이름 바꾸기 · 모듈째 · require · 동적 가져오기 포함).
  if (resolve(file) !== CONNECTION_MODULE) {
    const code = withoutComments(text);
    const imports = [
      /\bimport\s+[^;]*?\bfrom\s*['"]node:sqlite['"]/g,
      /\bimport\s*\(\s*['"]node:sqlite['"]\s*\)/g,
      /\brequire\s*\(\s*['"]node:sqlite['"]\s*\)/g,
      /\bfrom\s*['"]sqlite['"]|\brequire\s*\(\s*['"]sqlite['"]\s*\)/g,
    ];
    for (const pattern of imports) {
      for (const m of code.matchAll(pattern)) {
        problems.push({ file, line: lineAt(m.index ?? 0), code: 'CODE_RAW_CONNECTION', message: 'node:sqlite를 직접 가져왔습니다: 연결은 openDatabase()로 열어 foreign_keys · recursive_triggers를 확인합니다' });
      }
    }
    // 가져온 곳이 이 파일 밖이어도(넘겨받은 생성자 · 모듈 객체) 직접 여는 곳은 잡는다.
    for (const m of code.matchAll(/\bnew\s+(?:[A-Za-z_$][\w$]*\.)?DatabaseSync\s*\(/g)) {
      problems.push({ file, line: lineAt(m.index ?? 0), code: 'CODE_RAW_CONNECTION', message: 'DatabaseSync를 직접 열었습니다: openDatabase()로 엽니다' });
    }
  }
  return problems;
}

/** @param {string} path @returns {string[]} */
function codeFiles(path) {
  if (statSync(path).isFile()) return [path];
  const out = [];
  for (const entry of readdirSync(path)) {
    if (entry === 'node_modules' || entry.startsWith('.') || entry === 'dist') continue;
    const full = join(path, entry);
    if (statSync(full).isDirectory()) out.push(...codeFiles(full));
    else if (CODE_FILE.test(entry)) out.push(full);
  }
  return out;
}

/**
 * 폴더의 control · shop 마이그레이션 전체와(선택) 코드 경로를 검사한다.
 * @param {{ dir?: string, code?: string[] }} [options]
 */
export function lintAll({ dir = MIGRATIONS_DIR, code = [] } = {}) {
  /** @type {LintProblem[]} */
  const problems = [];
  const ledgers = new Set();
  const guarded = new Set();
  for (const kind of /** @type {const} */ (['control', 'shop'])) {
    const result = lintMigrations(kind, loadMigrations(kind, dir));
    problems.push(...result.problems.map(p => ({ ...p, file: `migrations/${p.file}` })));
    for (const t of result.ledgers) ledgers.add(t);
    for (const t of result.guarded) guarded.add(t);
  }
  for (const path of code) {
    for (const file of codeFiles(path)) problems.push(...lintCode(readFileSync(file, 'utf8'), relative(process.cwd(), file) || file, { ledgers, guarded }));
  }
  return { problems, ledgers, guarded };
}

/** @param {string[]} argv */
function main(argv) {
  /** @type {{ dir?: string, code: string[] }} */
  const options = { code: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') options.dir = argv[++i];
    else if (argv[i] === '--code') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) options.code.push(argv[++i]);
    } else {
      console.error(`모르는 선택: ${argv[i]}\n사용법: lint [--dir <migrations 폴더>] [--code <파일이나 폴더> ...]`);
      process.exitCode = 1;
      return;
    }
  }
  const { problems, ledgers } = lintAll(options);
  for (const p of problems) console.log(`${p.file}:${p.line} ${p.code} ${p.message}`);
  if (problems.length) {
    console.log(`\n문제 ${problems.length}개`);
    process.exitCode = 1;
  } else {
    console.log(`마이그레이션 검사 통과(장부 표 ${ledgers.size}개${options.code.length ? ', 코드 포함' : ''}).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));

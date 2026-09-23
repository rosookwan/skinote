// @ts-check
// 문장 나누기(실행기 · lint · 트리거 생성기가 함께 씀). 트리거 몸통의 ';', 문자열 · 주석 안의 ';'로 끊지 않는지.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMigrations } from '../src/migrations.js';
import { findRunnerOwnedStatements, splitStatements, sqlKey, SqlSyntaxError } from '../src/sql.js';

test('trigger bodies, CASE ... END, strings and comments do not end a statement', () => {
  const sql = `
    -- 주석 안의 ; 는 끝이 아니다
    CREATE TABLE t (a TEXT DEFAULT 'x;y', "b;c" INTEGER); /* 여기도 ; */
    CREATE TRIGGER t_guard BEFORE UPDATE ON t
    WHEN (SELECT CASE WHEN NEW.a = ';' THEN 1 ELSE 0 END) = 1
    BEGIN SELECT RAISE(ABORT, 'NO; really'); SELECT 1; END;
    INSERT INTO t VALUES ('it''s; fine', 2)`;
  const statements = splitStatements(sql);
  assert.equal(statements.length, 3);
  assert.deepEqual(statements.map(s => s.tokens[1].upper), ['TABLE', 'TRIGGER', 'INTO']);
  assert.equal(statements[0].line, 3);
  assert.equal(statements[1].line, 4);
  assert.equal(statements[2].tokens.find(t => t.type === 'string')?.value, "it's; fine");
  assert.ok(statements[1].text.endsWith('END;'));
});

test('the 0001 migrations split into exactly their CREATE statements and seed INSERTs', () => {
  const counts = (/** @type {'control' | 'shop'} */ kind) => {
    const tally = { TABLE: 0, INDEX: 0, TRIGGER: 0, INSERT: 0, other: 0 };
    for (const s of splitStatements(loadMigrations(kind)[0].sql)) {
      const [a, b, c] = s.tokens.map(t => t.upper);
      if (a === 'CREATE' && b === 'TABLE') tally.TABLE += 1;
      else if (a === 'CREATE' && (b === 'INDEX' || (b === 'UNIQUE' && c === 'INDEX'))) tally.INDEX += 1;
      else if (a === 'CREATE' && b === 'TRIGGER') tally.TRIGGER += 1;
      else if (a === 'INSERT') tally.INSERT += 1;
      else tally.other += 1;
    }
    return tally;
  };
  const control = counts('control');
  assert.deepEqual({ ...control, INSERT: 0 }, { TABLE: 28, INDEX: 19, TRIGGER: 4, INSERT: 0, other: 0 });
  assert.ok(control.INSERT >= 1, 'control seeds sys_features');
  const shop = counts('shop');
  assert.deepEqual({ ...shop, INSERT: 0 }, { TABLE: 260, INDEX: 207, TRIGGER: 148, INSERT: 0, other: 0 });
  assert.ok(shop.INSERT > 50);
});

test('runner-owned statements are found, but a trigger BEGIN is not one of them', () => {
  assert.deepEqual(findRunnerOwnedStatements(loadMigrations('shop')[0].sql), []);
  const found = findRunnerOwnedStatements('BEGIN;\nCREATE TABLE x (a);\nCOMMIT;\nPRAGMA foreign_keys = OFF;\nEND;');
  assert.deepEqual(found.map(f => `${f.keyword}@${f.line}`), ['BEGIN@1', 'COMMIT@3', 'PRAGMA@4', 'END@5']);
});

test('comparison keys ignore spacing, comments and keyword case but not string values', () => {
  assert.equal(sqlKey("create trigger x before delete on t begin select raise(abort, 'A t'); end;"), sqlKey("CREATE TRIGGER x\n  BEFORE DELETE ON t -- 주석\n  BEGIN SELECT RAISE(ABORT, 'A t'); END;"));
  assert.notEqual(sqlKey("SELECT 'a'"), sqlKey("SELECT 'A'"));
});

test('an unterminated string or comment is a syntax error with its line', () => {
  assert.throws(() => splitStatements("SELECT 1;\nSELECT 'oops;\n"), e => e instanceof SqlSyntaxError && e.line === 2);
  assert.throws(() => splitStatements('SELECT 1; /* never closed'), SqlSyntaxError);
  assert.throws(() => splitStatements('CREATE TRIGGER x BEFORE DELETE ON t BEGIN SELECT 1;'), /END로 끝나지 않은/);
});

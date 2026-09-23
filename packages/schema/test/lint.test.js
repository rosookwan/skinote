// @ts-check
// 마이그레이션 검사(data-model 7-2). 배포할 마이그레이션은 통과하고, 금지 문장과 모양이 틀린 트리거는 알맞은 코드로 잡히는지.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ledgerGuards } from '../src/guards.js';
import { fromSources, loadMigrations } from '../src/migrations.js';
import { CONNECTION_MODULE, lintAll, lintCode, lintMigrations } from '../tools/lint.js';
import { PACKAGE_DIR } from './helpers.js';

const base = {
  control: loadMigrations('control')[0],
  shop: loadMigrations('shop')[0],
};

/**
 * 0001 뒤에 마이그레이션 하나를 붙여 검사하고, 그 마이그레이션의 문제만 돌려준다.
 * @param {string} sql
 * @param {'control' | 'shop'} [kind]
 */
function lintNext(sql, kind = 'shop') {
  const name = `0002_${kind}_test`;
  const migrations = fromSources(kind, [{ name: base[kind].name, sql: base[kind].sql }, { name, sql }]);
  const { problems } = lintMigrations(kind, migrations);
  assert.deepEqual(problems.filter(p => p.file !== name), [], '0001에는 문제가 없어야 합니다');
  return problems;
}

/** @param {ReturnType<typeof lintNext>} problems */
const codes = problems => [...new Set(problems.map(p => p.code))].sort();

test('the shipped control and shop migrations pass the lint', () => {
  const { problems, ledgers } = lintAll();
  assert.deepEqual(problems, []);
  assert.equal(ledgers.size, 52, '49 shop ledgers + events + 2 control ledgers');
});

test('the package code itself passes the code lint (no raw connections, no REPLACE on ledgers)', () => {
  const { problems } = lintAll({ code: ['src', 'tools', 'bin'].map(d => PACKAGE_DIR + d) });
  assert.deepEqual(problems, []);
});

const FORBIDDEN = [
  ['DROP TABLE', 'DROP TABLE order_batches;', 'DROP_TABLE'],
  ['DROP COLUMN', 'ALTER TABLE orders DROP COLUMN customer_name;', 'DROP_COLUMN'],
  ['RENAME TABLE', 'ALTER TABLE orders RENAME TO orders_old;', 'RENAME'],
  ['RENAME COLUMN', 'ALTER TABLE orders RENAME COLUMN customer_name TO team_name;', 'RENAME'],
  ['ADD COLUMN with CHECK', "ALTER TABLE orders ADD COLUMN room_no TEXT CHECK (room_no <> '');", 'ADD_COLUMN_CHECK'],
  ['ADD COLUMN with REFERENCES', 'ALTER TABLE orders ADD COLUMN lodging_place_id TEXT REFERENCES places (id);', 'ADD_COLUMN_REFERENCES'],
  ['ADD COLUMN NOT NULL without default', 'ALTER TABLE orders ADD COLUMN room_no TEXT NOT NULL;', 'ADD_COLUMN_NOT_NULL'],
  ['CREATE TABLE AS', 'CREATE TABLE orders_copy AS SELECT * FROM orders;', 'CREATE_TABLE_AS'],
  ['INSERT OR REPLACE on a ledger', "INSERT OR REPLACE INTO cash_entries (shop_id, id) VALUES ('S1', 'x');", 'REPLACE'],
  ['REPLACE INTO', "REPLACE INTO sys_place_uses (key, label, added_in) VALUES ('pickup', '수령', 1);", 'REPLACE'],
  ['UPDATE OR REPLACE', "UPDATE OR REPLACE payments SET van_batch_no = 'x';", 'REPLACE'],
  ['INSERT OR IGNORE on a ledger', "INSERT OR IGNORE INTO payments (shop_id, id) VALUES ('S1', 'x');", 'INSERT_OR_IGNORE'],
  ['INSERT into a business table', "INSERT INTO orders (shop_id, id) VALUES ('S1', 'x');", 'INSERT_TARGET'],
  ['changing a sys key', "UPDATE sys_features SET key = 'cars' WHERE key = 'vehicles';", 'SYS_UPDATE'],
  ['deleting a sys row', "DELETE FROM sys_features WHERE key = 'sms';", 'DELETE'],
  ['DROP TRIGGER', 'DROP TRIGGER payments_no_update;', 'DROP_TRIGGER'],
  ['editing a guarded ledger column', 'UPDATE payments SET amount = 0;', 'LEDGER_UPDATE'],
  ['inline UNIQUE in a new table', 'CREATE TABLE lockers (shop_id TEXT NOT NULL, id TEXT NOT NULL, code TEXT UNIQUE, PRIMARY KEY (shop_id, id)) STRICT;', 'INLINE_UNIQUE'],
  ['CHECK list in a new table', "CREATE TABLE lockers (shop_id TEXT NOT NULL, id TEXT NOT NULL, size_key TEXT CHECK (size_key IN ('big', 'small')), PRIMARY KEY (shop_id, id)) STRICT;", 'LIST_CHECK'],
  ['new shop table whose key does not start with shop_id', 'CREATE TABLE lockers (id TEXT NOT NULL PRIMARY KEY, shop_id TEXT NOT NULL) STRICT;', 'SHOP_KEY'],
  ['dropping a unique index that a foreign key targets', 'DROP INDEX payment_methods_cash;', 'FK_TARGET'],
  ['transaction control', "BEGIN; INSERT INTO sys_place_uses (key, label, added_in) VALUES ('garage', '차고', 2); COMMIT;", 'NOT_ALLOWED'],
  ['a PRAGMA', 'PRAGMA foreign_keys = OFF;', 'NOT_ALLOWED'],
  ['a trigger outside the four shapes', 'CREATE TRIGGER orders_touch AFTER UPDATE ON orders BEGIN UPDATE orders SET version = version + 1 WHERE shop_id = NEW.shop_id AND id = NEW.id; END;', 'TRIGGER_SHAPE'],
  ['a set-once guard on a column this migration did not add', "CREATE TRIGGER payments_approval_no_once BEFORE UPDATE OF approval_no ON payments WHEN OLD.approval_no IS NOT NULL BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payments'); END;", 'TRIGGER_SHAPE'],
  ['a set-once guard with the wrong condition', "ALTER TABLE payments ADD COLUMN van_batch_no TEXT;\nCREATE TRIGGER payments_van_batch_no_once BEFORE UPDATE OF van_batch_no ON payments BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payments'); END;", 'TRIGGER_SHAPE'],
  ['a column added to a ledger without its set-once guard (E4)', 'ALTER TABLE payments ADD COLUMN van_batch_no2 TEXT;', 'LEDGER_COLUMN_UNGUARDED'],
  ['an upsert that renames a sys key', "INSERT INTO sys_place_uses (key, label, added_in) VALUES ('pickup', 'x', 2) ON CONFLICT (key) DO UPDATE SET key = 'renamed';", 'UPSERT'],
  ['an upsert that rewrites a sys label', "INSERT INTO sys_place_uses (key, label, added_in) VALUES ('pickup', 'x', 2) ON CONFLICT (key) DO UPDATE SET label = excluded.label;", 'UPSERT'],
  ['ON CONFLICT DO NOTHING on sys rows', "INSERT INTO sys_place_uses (key, label, added_in) VALUES ('pickup', '수령', 2) ON CONFLICT DO NOTHING;", 'INSERT_OR_IGNORE'],
  ['rewriting a redact-only ledger column (conditional guard)', "UPDATE payments SET reason = 'rewritten';", 'LEDGER_UPDATE'],
];

for (const [label, sql, code] of FORBIDDEN) {
  test(`lint rejects ${label} (${code})`, () => {
    const problems = lintNext(sql);
    assert.ok(codes(problems).includes(code), `기대 ${code}, 받은 ${JSON.stringify(problems, null, 1)}`);
  });
}

test('lint points at the line of the forbidden statement', () => {
  const problems = lintNext("INSERT INTO sys_place_uses (key, label, added_in) VALUES ('garage', '차고', 2);\n\nDROP TABLE order_batches;\n");
  const drop = problems.find(p => p.code === 'DROP_TABLE');
  assert.equal(drop?.line, 3);
  assert.equal(drop?.file, '0002_shop_test');
});

/** 0002 예시: 7-1 · 7-2가 허용하는 것을 모두 쓴 마이그레이션. */
function allowedMigration() {
  const lockerColumns = [
    'shop_id', 'id', 'locker_no', 'order_id', 'amount', 'reason', 'occurred_at', 'recorded_at', 'business_date', 'posting_date',
    'closing_scope_id', 'actor_key', 'actor_name', 'request_id', 'created_rev',
  ];
  return [
    '-- E4: 빈 값을 허용하는 열과 찾기 인덱스',
    'ALTER TABLE orders ADD COLUMN lodging_room_no TEXT;',
    'CREATE INDEX orders_lodging_room ON orders (shop_id, lodging_room_no) WHERE lodging_room_no IS NOT NULL;',
    "INSERT INTO sys_soft_references (table_name, column_name, target_table, added_in) VALUES ('orders', 'lodging_room_no', 'places', 2);",
    '-- 장부 표에 더한 열: 채우기 → ② 한 번만 → ③ 이 판부터 필수',
    'ALTER TABLE payments ADD COLUMN van_batch_no TEXT;',
    "UPDATE payments SET van_batch_no = 'legacy' WHERE van_batch_no IS NULL;",
    "CREATE TRIGGER payments_van_batch_no_once BEFORE UPDATE OF van_batch_no ON payments WHEN OLD.van_batch_no IS NOT NULL BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payments'); END;",
    "CREATE TRIGGER payments_van_batch_no_required BEFORE INSERT ON payments WHEN NEW.van_batch_no IS NULL BEGIN SELECT RAISE(ABORT, 'REQUIRED payments.van_batch_no'); END;",
    '-- ④ 장부의 새 자유 글 칸은 가리기만',
    'ALTER TABLE payments ADD COLUMN van_note TEXT;',
    "CREATE TRIGGER payments_van_note_redact_only BEFORE UPDATE OF van_note ON payments WHEN (NEW.van_note IS NOT OLD.van_note AND NEW.van_note IS NOT '(지움)') BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY payments'); END;",
    "-- ③ 새 값 칸을 '하나만' 규칙에 잇기",
    'ALTER TABLE order_attribute_values ADD COLUMN value_date TEXT;',
    "CREATE TRIGGER order_attribute_values_value_date_one_of BEFORE INSERT ON order_attribute_values WHEN (NEW.value_text IS NOT NULL) + (NEW.value_int IS NOT NULL) + (NEW.value_real IS NOT NULL) + (NEW.option_id IS NOT NULL) + (NEW.value_date IS NOT NULL) > 1 BEGIN SELECT RAISE(ABORT, 'ONE_OF order_attribute_values'); END;",
    '-- ① 새 장부 표와 생성기가 만든 추가 전용 트리거',
    `CREATE TABLE locker_rentals (
  shop_id TEXT NOT NULL REFERENCES shops (id), id TEXT NOT NULL, locker_no TEXT NOT NULL, order_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0), reason TEXT, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
  business_date TEXT NOT NULL, posting_date TEXT NOT NULL, closing_scope_id TEXT NOT NULL DEFAULT 'main',
  actor_key TEXT NOT NULL, actor_name TEXT NOT NULL, request_id TEXT NOT NULL, created_rev INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders (shop_id, id),
  CHECK (posting_date >= business_date)
) STRICT;`,
    'CREATE INDEX locker_rentals_order ON locker_rentals (shop_id, order_id);',
    ledgerGuards('locker_rentals', lockerColumns).trim(),
    '-- sys 어휘 더하기, 묶음을 native로 옮기기, 뷰',
    "INSERT INTO sys_place_uses (key, label, added_in) VALUES ('ski_room', '스키 보관실', 2);",
    "UPDATE sys_event_types SET engine_key = 'native' WHERE key = 'order.extend';",
    'CREATE VIEW open_order_ids AS SELECT shop_id, id FROM orders WHERE is_open = 1;',
    'DROP VIEW open_order_ids;',
  ].join('\n');
}

test('lint accepts every shape that data-model 7-1 and 7-2 allow', () => {
  assert.deepEqual(lintNext(allowedMigration()), []);
});

test('a new ledger table whose guard misses a column or lacks the delete guard is caught', () => {
  const sql = allowedMigration();
  const missingColumn = sql.replace(/(CREATE TRIGGER locker_rentals_no_update BEFORE UPDATE OF\n\s+)shop_id, /, '$1');
  assert.notEqual(missingColumn, sql);
  assert.ok(codes(lintNext(missingColumn)).includes('TRIGGER_SHAPE'));
  const noDelete = sql.replace(/CREATE TRIGGER locker_rentals_no_delete[^\n]*\n?/, '');
  assert.notEqual(noDelete, sql);
  assert.ok(codes(lintNext(noDelete)).includes('TRIGGER_MISSING'));
});

test('a json_schemas version is never rewritten by an upsert (E11)', () => {
  const problems = lintNext("INSERT INTO json_schemas (key, version, json_schema, created_at) VALUES ('licence.claims', 1, '{}', '2026-12-26') ON CONFLICT (key, version) DO UPDATE SET json_schema = excluded.json_schema;", 'control');
  assert.ok(codes(problems).includes('UPSERT'), JSON.stringify(problems));
});

test('a control migration gets the same statement rules', () => {
  assert.ok(codes(lintNext('DROP TABLE sessions;', 'control')).includes('DROP_TABLE'));
  assert.deepEqual(lintNext("INSERT INTO sys_features (key, label, description, default_enabled, depends_on_json, added_in) VALUES ('lockers', '보관함', 'locker rentals', 0, '[]', 2);", 'control'), []);
});

test('a baseline trigger that drifts from the generator is caught in 0001', () => {
  const drifted = base.shop.sql.replace(/(CREATE TRIGGER cash_entries_no_update BEFORE UPDATE OF\n\s+)shop_id, /, '$1');
  assert.notEqual(drifted, base.shop.sql);
  const { problems } = lintMigrations('shop', fromSources('shop', [{ name: '0001_shop', sql: drifted }]));
  assert.deepEqual(codes(problems), ['TRIGGER_SHAPE']);
});

test('code lint flags REPLACE and INSERT OR IGNORE on ledgers and raw connections', () => {
  const { ledgers, guarded } = lintAll();
  const scan = (/** @type {string} */ text) => codes(lintCode(text, 'x.js', { ledgers, guarded }));
  assert.deepEqual(scan("db.prepare('INSERT OR REPLACE INTO payments (id) VALUES (?)')"), ['CODE_REPLACE']);
  assert.deepEqual(scan('db.exec(`REPLACE INTO closings VALUES (1)`)'), ['CODE_REPLACE']);
  assert.deepEqual(scan("sql`INSERT OR REPLACE INTO orders (id) VALUES (${id})`"), ['CODE_REPLACE'], 'business rows are guarded too');
  assert.deepEqual(scan("db.prepare('INSERT OR IGNORE INTO cash_entries (id) VALUES (?)')"), ['CODE_INSERT_OR_IGNORE']);
  assert.deepEqual(scan("db.prepare('INSERT OR IGNORE INTO device_sync_cursors (device_id) VALUES (?)')"), []);
  assert.deepEqual(scan("const db = new DatabaseSync(file);"), ['CODE_RAW_CONNECTION']);
  // 같은 파일이 openDatabase()를 부르더라도, 이름을 바꿔 가져와도, 모듈째 가져와도 직접 여는 곳은 잡는다.
  assert.deepEqual(scan("import { DatabaseSync } from 'node:sqlite';\nconst a = openDatabase(file);\nconst b = new DatabaseSync(file);"), ['CODE_RAW_CONNECTION']);
  assert.deepEqual(scan("import { DatabaseSync as Sqlite } from 'node:sqlite';\nconst b = new Sqlite(file);"), ['CODE_RAW_CONNECTION']);
  assert.deepEqual(scan("import * as sqlite from 'node:sqlite';\nconst b = new sqlite.DatabaseSync(file);"), ['CODE_RAW_CONNECTION']);
  assert.deepEqual(scan("const { DatabaseSync } = require('node:sqlite');"), ['CODE_RAW_CONNECTION']);
  assert.equal(lintCode("import { DatabaseSync } from 'node:sqlite';\nnew DatabaseSync(f);", 'x.js', { ledgers, guarded }).filter(p => p.code === 'CODE_RAW_CONNECTION').length, 2);
  // JSDoc 형식(import('node:sqlite'))은 코드가 아니다. 연결 모듈(src/connection.js)만 가져올 수 있다.
  assert.deepEqual(scan("/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */\nconst db = openDatabase(file);"), []);
  assert.deepEqual(lintCode("import { DatabaseSync } from 'node:sqlite';", CONNECTION_MODULE, { ledgers, guarded }), []);
});

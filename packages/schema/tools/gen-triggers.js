#!/usr/bin/env node
// @ts-check
// schema.sql의 장부 트리거(0001)를 마지막 열 목록에서 다시 만든다(옛 review/gen-triggers.cjs).
//   node tools/gen-triggers.js [schema.sql] [--check]
// 기본은 packages/schema/schema.sql을 제자리에서 고친다. --check는 고치지 않고, 다시 만든 글이 지금과 다르면 1로 끝난다.
// 게시된 요금표 트리거(price_*)는 손으로 쓴 것이라 건드리지 않는다(생성 구간 밖).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from '../src/connection.js';
import { controlTriggers, CONTROL_LEDGERS, LEDGERS, NO_DELETE, shopTriggers } from '../src/guards.js';
import { splitSchema } from '../src/split.js';
import { splitStatements } from '../src/sql.js';
import { columnsOf } from '../src/structure.js';

export const SCHEMA_FILE = fileURLToPath(new URL('../schema.sql', import.meta.url));

/** 생성 구간의 앞뒤 표시. 이 사이만 바꾼다. */
const CONTROL_START = 'CREATE TRIGGER platform_audit_log_no_update';
const CONTROL_END = '\n\n\n-- @database shop';
const SHOP_START = 'CREATE TRIGGER shop_settings_no_update';
const SHOP_END = '-- Published prices never change';

/**
 * 트리거를 뺀 DDL로 메모리 DB를 만든다(열 목록만 필요하므로).
 * @param {string} ddl
 */
function scratchWithoutTriggers(ddl) {
  const db = openDatabase(':memory:');
  const body = splitStatements(ddl)
    .filter(s => !(s.tokens[0]?.upper === 'CREATE' && s.tokens.slice(1, 3).some(t => t.upper === 'TRIGGER')))
    .map(s => (s.text.endsWith(';') ? s.text : s.text + ';'))
    .join('\n');
  db.exec(body);
  return db;
}

/**
 * @param {string} haystack @param {string} needle @param {number} [from]
 */
function mustFind(haystack, needle, from = 0) {
  const at = haystack.indexOf(needle, from);
  if (at < 0) throw new Error(`schema.sql에서 생성 구간 표시를 찾지 못했습니다: ${JSON.stringify(needle)}`);
  return at;
}

/**
 * schema.sql 글을 받아 생성 트리거를 다시 만든 글을 돌려준다(파일은 쓰지 않음).
 * @param {string} sql
 */
export function regenerate(sql) {
  const { parts } = splitSchema(sql);
  const shop = scratchWithoutTriggers(parts.shop.database);
  const control = scratchWithoutTriggers(parts.control.database);
  try {
    const controlText = controlTriggers(t => columnsOf(control, t));
    const shopText = shopTriggers(t => columnsOf(shop, t));
    let out = sql;
    const cStart = mustFind(out, CONTROL_START);
    const cEnd = mustFind(out, CONTROL_END, cStart);
    out = out.slice(0, cStart) + controlText.trimEnd() + out.slice(cEnd);
    const sStart = mustFind(out, SHOP_START);
    const sEnd = mustFind(out, SHOP_END, sStart);
    out = out.slice(0, sStart) + shopText.trimStart() + '\n' + out.slice(sEnd);
    return out;
  } finally {
    shop.close();
    control.close();
  }
}

/** @param {string[]} argv */
function main(argv) {
  const check = argv.includes('--check');
  const file = argv.find(a => !a.startsWith('--')) ?? SCHEMA_FILE;
  const before = readFileSync(file, 'utf8');
  const after = regenerate(before);
  const summary = `장부 ${LEDGERS.length} · control 장부 ${CONTROL_LEDGERS.length} · 삭제 금지 ${NO_DELETE.length}`;
  if (check) {
    if (after !== before) {
      console.error(`트리거가 열 목록과 다릅니다: ${file}\n고치려면: npm run gen-triggers -w @skinote/schema`);
      process.exitCode = 1;
      return;
    }
    console.log(`트리거가 열 목록과 같습니다(${summary}).`);
    return;
  }
  if (after === before) {
    console.log(`바뀐 것이 없습니다(${summary}).`);
    return;
  }
  writeFileSync(file, after);
  console.log(`트리거를 다시 만들었습니다: ${file} (${summary}). 마이그레이션도 다시 만드세요: npm run split -w @skinote/schema`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));

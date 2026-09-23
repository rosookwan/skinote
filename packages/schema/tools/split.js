#!/usr/bin/env node
// @ts-check
// schema.sql을 표시 줄로 나눠 migrations/0001_control.sql · 0001_shop.sql을 쓴다.
//   node tools/split.js [--check]
// --check는 쓰지 않고, 파일이 schema.sql과 어긋나면 1로 끝난다(CI · 시험과 같은 확인).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildMigrations } from '../src/split.js';

export const SCHEMA_FILE = fileURLToPath(new URL('../schema.sql', import.meta.url));
export const OUT_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/**
 * 만들어야 할 파일과 지금 파일이 다른 것의 목록.
 * @param {{ schemaFile?: string, outDir?: string }} [options]
 */
export function staleMigrations({ schemaFile = SCHEMA_FILE, outDir = OUT_DIR } = {}) {
  const wanted = buildMigrations(readFileSync(schemaFile, 'utf8'));
  return Object.entries(wanted)
    .filter(([name, text]) => {
      const file = join(outDir, name);
      return !existsSync(file) || readFileSync(file, 'utf8') !== text;
    })
    .map(([name]) => name);
}

/** @param {string[]} argv */
function main(argv) {
  const wanted = buildMigrations(readFileSync(SCHEMA_FILE, 'utf8'));
  if (argv.includes('--check')) {
    const stale = staleMigrations();
    if (stale.length) {
      console.error(`마이그레이션이 schema.sql과 어긋납니다: ${stale.join(', ')}\n고치려면: npm run split -w @skinote/schema`);
      process.exitCode = 1;
      return;
    }
    console.log('마이그레이션이 schema.sql과 같습니다.');
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, text] of Object.entries(wanted)) {
    const file = join(OUT_DIR, name);
    const same = existsSync(file) && readFileSync(file, 'utf8') === text;
    if (!same) writeFileSync(file, text);
    console.log(`${same ? '그대로' : '썼습니다'}: migrations/${name} (${text.split('\n').length}줄)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));

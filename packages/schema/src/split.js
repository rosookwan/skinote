// @ts-check
// schema.sql을 표시 줄(`-- @database control` · `-- @database shop` · `-- @seed control` · `-- @seed shop`)로 나눠
// 파일 종류마다 마이그레이션 0001 글을 만든다. 파일을 읽고 쓰지 않는 순수 함수라 브라우저(체험판 · 기사 기기의
// SQLite WASM)에서도 같은 나누기를 쓸 수 있다. 파일로 쓰는 일은 tools/split.js가 한다.

import { normalizeSource } from './sql.js';

export const DATABASE_KINDS = /** @type {const} */ (['control', 'shop']);

/** 표시 줄. 앞뒤 공백 없이 이 모양이어야 하고, 끝의 공백만 허용한다. */
export const MARKER = /^-- @(database|seed) (control|shop)[ \t]*$/;

/** '-- @'로 시작하지만 표시 줄이 아닌 줄(오타)은 조용히 넘기지 않고 오류로 한다. */
const MARKER_LIKE = /^-- @\S/;

export class SchemaSplitError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SchemaSplitError';
    this.code = 'SCHEMA_SPLIT';
  }
}

/**
 * @typedef {{ database: string, seed: string }} KindParts
 * @typedef {{ header: string, parts: { control: KindParts, shop: KindParts } }} SplitSchema
 */

/**
 * @param {string} text schema.sql 원문
 * @returns {SplitSchema}
 */
export function splitSchema(text) {
  const lines = normalizeSource(text).split('\n');
  /** @type {Record<string, string[]>} */
  const buckets = {};
  const header = [];
  /** @type {string | null} */
  let current = null;
  lines.forEach((line, index) => {
    const m = line.match(MARKER);
    if (m) {
      const key = `${m[1]} ${m[2]}`;
      if (buckets[key]) throw new SchemaSplitError(`표시 줄 "-- @${key}"가 두 번 있습니다(${index + 1}번째 줄)`);
      buckets[key] = [];
      current = key;
      return;
    }
    if (MARKER_LIKE.test(line)) throw new SchemaSplitError(`알 수 없는 표시 줄 "${line.trim()}"(${index + 1}번째 줄)`);
    if (current) buckets[current].push(line);
    else header.push(line);
  });
  const part = (/** @type {string} */ key) => {
    const body = buckets[key];
    if (!body) throw new SchemaSplitError(`표시 줄 "-- @${key}"가 없습니다`);
    const joined = trimBlankLines(body).join('\n');
    if (!joined.trim()) throw new SchemaSplitError(`"-- @${key}" 부분이 비어 있습니다`);
    return joined + '\n';
  };
  return {
    header: header.join('\n'),
    parts: {
      control: { database: part('database control'), seed: part('seed control') },
      shop: { database: part('database shop'), seed: part('seed shop') },
    },
  };
}

/** @param {string[]} lines */
function trimBlankLines(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a += 1;
  while (b > a && !lines[b - 1].trim()) b -= 1;
  return lines.slice(a, b);
}

const FILE_LABEL = { control: 'control.sqlite', shop: 'shop-<shop_id>.sqlite' };

/**
 * 한 종류의 마이그레이션 0001 글. 표시 줄은 남겨 두어 이 파일도 같은 방식으로 다시 나눌 수 있다.
 * @param {'control' | 'shop'} kind
 * @param {KindParts} parts
 */
export function buildMigration(kind, parts) {
  const header = [
    `-- 0001_${kind} · 스키노트 마이그레이션 0001 (${FILE_LABEL[kind]})`,
    '-- 이 파일은 tools/split.js가 packages/schema/schema.sql에서 만든다. 손으로 고치지 않는다.',
    `-- schema.sql의 "@database ${kind}" 부분과 "@seed ${kind}" 부분을 그대로 옮긴 것이고, 실행기가 한 트랜잭션으로 적용한다.`,
    '-- schema.sql을 고쳤으면 `npm run split -w @skinote/schema`로 다시 만든다(시험이 어긋남을 잡는다).',
    '-- 한 번 배포한 뒤에는 바꾸지 않는다: 적용한 파일의 checksum이 다르면 실행기가 쓰기를 거절한다.',
  ].join('\n');
  return `${header}\n\n-- @database ${kind}\n${parts.database}\n-- @seed ${kind}\n${parts.seed}`;
}

/**
 * @param {string} schemaText
 * @returns {Record<string, string>} 파일 이름 → 내용
 */
export function buildMigrations(schemaText) {
  const { parts } = splitSchema(schemaText);
  return Object.fromEntries(DATABASE_KINDS.map(kind => [`0001_${kind}.sql`, buildMigration(kind, parts[kind])]));
}

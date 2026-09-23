// @ts-check
// SQL 문장 나누기와 토큰. 실행기(마이그레이션 파일 안의 트랜잭션 · PRAGMA 문장 거절), lint(금지 문장 · 트리거 모양),
// 트리거 생성기(트리거를 뺀 스키마 만들기)가 같은 코드를 쓴다. SQLite 문법 전체를 해석하지 않고,
// 문자열 · 따옴표 이름 · 주석을 건너뛰며 토큰을 모으고, CREATE TRIGGER의 BEGIN … END 안의 ';'로는 문장을 끊지 않는다.

/**
 * @typedef {'word' | 'ident' | 'string' | 'number' | 'punct' | 'op' | 'param'} TokenType
 * @typedef {{ type: TokenType, value: string, upper: string, start: number, line: number }} Token
 * @typedef {{ text: string, tokens: Token[], line: number, start: number, end: number }} Statement
 */

export class SqlSyntaxError extends Error {
  /** @param {string} message @param {number} line */
  constructor(message, line) {
    super(`${message} (${line}번째 줄)`);
    this.name = 'SqlSyntaxError';
    this.code = 'SQL_SYNTAX';
    this.line = line;
  }
}

/** 파일 앞의 BOM을 떼고 줄 끝을 LF로 맞춘다. checksum과 나누기가 Windows에서 받은 파일에도 같게 나오도록. */
export function normalizeSource(text) {
  return String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

const SPACE = /[ \t\r\f\v]/;
const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DIGIT = /[0-9]/;
const TWO_CHAR_OPS = new Set(['<>', '!=', '<=', '>=', '==', '||', '<<', '>>', '->']);

/**
 * 원문을 문장으로 나눈다. 끝의 ';'는 문장 글(text)에는 들어가고 토큰에는 들어가지 않는다.
 * @param {string} source
 * @returns {Statement[]}
 */
export function splitStatements(source) {
  const src = normalizeSource(source);
  /** @type {Statement[]} */
  const statements = [];
  /** @type {Token[]} */
  let tokens = [];
  let stmtStart = -1;
  let line = 1;
  let trigger = false;
  let inBody = false;
  let bodyEnded = false;
  let caseDepth = 0;

  /** @param {TokenType} type @param {string} value @param {number} start @param {number} startLine */
  const push = (type, value, start, startLine) => {
    if (stmtStart < 0) stmtStart = start;
    const upper = type === 'word' ? value.toUpperCase() : value;
    tokens.push({ type, value, upper, start, line: startLine });
    if (type !== 'word') return;
    if (!trigger && upper === 'TRIGGER' && tokens.length <= 3 && tokens[0].upper === 'CREATE') trigger = true;
    else if (trigger && !inBody && upper === 'BEGIN') inBody = true;
    else if (inBody && !bodyEnded) {
      if (upper === 'CASE') caseDepth += 1;
      else if (upper === 'END') {
        if (caseDepth > 0) caseDepth -= 1;
        else bodyEnded = true;
      }
    }
  };
  /** @param {number} end */
  const finish = end => {
    if (tokens.length) statements.push({ text: src.slice(stmtStart, end), tokens, line: tokens[0].line, start: stmtStart, end });
    tokens = [];
    stmtStart = -1;
    trigger = inBody = bodyEnded = false;
    caseDepth = 0;
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (SPACE.test(c)) { i += 1; continue; }
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) throw new SqlSyntaxError('닫히지 않은 /* 주석', line);
      for (let k = i; k < close; k += 1) if (src[k] === '\n') line += 1;
      i = close + 2;
      continue;
    }
    const start = i;
    const startLine = line;
    if (c === "'" || c === '"' || c === '`') {
      let value = '';
      i += 1;
      for (;;) {
        if (i >= n) throw new SqlSyntaxError(c === "'" ? '닫히지 않은 문자열' : '닫히지 않은 따옴표 이름', startLine);
        const d = src[i];
        if (d === c) {
          if (src[i + 1] === c) { value += c; i += 2; continue; }
          i += 1;
          break;
        }
        if (d === '\n') line += 1;
        value += d;
        i += 1;
      }
      push(c === "'" ? 'string' : 'ident', value, start, startLine);
      continue;
    }
    if (c === '[') {
      const close = src.indexOf(']', i + 1);
      if (close < 0) throw new SqlSyntaxError('닫히지 않은 [이름]', line);
      push('ident', src.slice(i + 1, close), start, startLine);
      i = close + 1;
      continue;
    }
    if (WORD_START.test(c)) {
      if ((c === 'x' || c === 'X') && src[i + 1] === "'") {
        const close = src.indexOf("'", i + 2);
        if (close < 0) throw new SqlSyntaxError("닫히지 않은 X'…'", line);
        push('string', src.slice(i + 2, close), start, startLine);
        i = close + 1;
        continue;
      }
      let j = i + 1;
      while (j < n && WORD_PART.test(src[j])) j += 1;
      push('word', src.slice(i, j), start, startLine);
      i = j;
      continue;
    }
    if (DIGIT.test(c) || (c === '.' && DIGIT.test(src[i + 1] || ''))) {
      let j = i;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2;
        while (j < n && /[0-9A-Fa-f]/.test(src[j])) j += 1;
      } else {
        while (j < n && DIGIT.test(src[j])) j += 1;
        if (src[j] === '.') { j += 1; while (j < n && DIGIT.test(src[j])) j += 1; }
        if ((src[j] === 'e' || src[j] === 'E') && /[0-9+-]/.test(src[j + 1] || '')) {
          j += 2;
          while (j < n && DIGIT.test(src[j])) j += 1;
        }
      }
      push('number', src.slice(i, j), start, startLine);
      i = j;
      continue;
    }
    if (c === ';') {
      if (trigger && !bodyEnded) {
        push('punct', ';', start, startLine);
        i += 1;
        continue;
      }
      finish(i + 1);
      i += 1;
      continue;
    }
    if (c === '(' || c === ')' || c === ',' || c === '.') {
      push('punct', c, start, startLine);
      i += 1;
      continue;
    }
    if (c === '?' || c === ':' || c === '@' || c === '$') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      push('param', src.slice(i, j), start, startLine);
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '->' && src[i + 2] === '>') { push('op', '->>', start, startLine); i += 3; continue; }
    if (TWO_CHAR_OPS.has(two)) { push('op', two, start, startLine); i += 2; continue; }
    push('op', c, start, startLine);
    i += 1;
  }
  if (trigger && !bodyEnded && tokens.length) throw new SqlSyntaxError('END로 끝나지 않은 CREATE TRIGGER', tokens[0].line);
  finish(n);
  return statements;
}

/**
 * 공백 · 주석 · 대소문자 · 따옴표와 상관없이 같은 문장인지 비교하는 열쇠. 문자열 값은 그대로 비교한다.
 * @param {Token[]} tokens
 */
export function tokenKey(tokens) {
  return tokens
    .map(t => (t.type === 'word' || t.type === 'ident' ? 'n:' + t.value.toLowerCase() : t.type === 'string' ? "s:'" + t.value + "'" : t.value))
    .join(' ');
}

/** 한 문장만 있는 SQL 글의 비교 열쇠. */
export function sqlKey(text) {
  const statements = splitStatements(text);
  if (statements.length !== 1) throw new Error(`문장 하나를 기대했는데 ${statements.length}개입니다`);
  return tokenKey(statements[0].tokens);
}

/**
 * tokens[open]의 '('와 짝이 맞는 ')'의 위치.
 * @param {Token[]} tokens @param {number} open
 */
export function matchParen(tokens, open) {
  let depth = 0;
  for (let k = open; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type !== 'punct') continue;
    if (t.value === '(') depth += 1;
    else if (t.value === ')') {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** 이름 토큰(따옴표 없는 낱말이나 따옴표 이름)인지. */
export function isName(t) {
  return !!t && (t.type === 'word' || t.type === 'ident');
}

/**
 * tokens[at]부터 '[schema.]name'을 읽는다.
 * @param {Token[]} tokens @param {number} at
 * @returns {{ name: string, next: number } | null}
 */
export function readQualifiedName(tokens, at) {
  if (!isName(tokens[at])) return null;
  if (tokens[at + 1]?.type === 'punct' && tokens[at + 1].value === '.' && isName(tokens[at + 2])) {
    return { name: tokens[at + 2].value, next: at + 3 };
  }
  return { name: tokens[at].value, next: at + 1 };
}

/** 문장의 첫 낱말들(대문자). */
export function leadingWords(statement, count = 4) {
  const out = [];
  for (const t of statement.tokens) {
    if (t.type !== 'word') break;
    out.push(t.upper);
    if (out.length >= count) break;
  }
  return out;
}

/** 트랜잭션과 연결 설정은 실행기가 맡으므로 마이그레이션 파일에는 쓸 수 없다. */
export const RUNNER_OWNED_STATEMENTS = new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'PRAGMA', 'VACUUM', 'ATTACH', 'DETACH']);

/**
 * 실행기가 맡는 문장(트랜잭션 · PRAGMA · VACUUM · ATTACH)을 찾는다.
 * @param {string} sql
 * @returns {{ keyword: string, line: number }[]}
 */
export function findRunnerOwnedStatements(sql) {
  return splitStatements(sql)
    .filter(s => s.tokens[0]?.type === 'word' && RUNNER_OWNED_STATEMENTS.has(s.tokens[0].upper))
    .map(s => ({ keyword: s.tokens[0].upper, line: s.line }));
}

/**
 * CHECK (...) 안의 'x IN (값, 값…)' 목록을 모두 찾는다. 불리언 · 부호 목록만 허용한다(data-model 1절 원칙 4).
 * @param {Token[]} tokens
 * @returns {{ values: string, line: number }[]}
 */
export function findInListsInChecks(tokens) {
  const found = [];
  for (let k = 0; k < tokens.length; k += 1) {
    if (tokens[k].upper !== 'CHECK' || tokens[k].type !== 'word') continue;
    const open = k + 1;
    if (tokens[open]?.value !== '(' || tokens[open].type !== 'punct') continue;
    const close = matchParen(tokens, open);
    if (close < 0) continue;
    for (let j = open + 1; j < close; j += 1) {
      if (tokens[j].type !== 'word' || tokens[j].upper !== 'IN') continue;
      const lo = j + 1;
      if (tokens[lo]?.value !== '(' || tokens[lo].type !== 'punct') continue;
      const hi = matchParen(tokens, lo);
      if (hi < 0) continue;
      const inner = tokens.slice(lo + 1, hi);
      if (inner.some(t => t.type === 'word' && t.upper === 'SELECT')) continue;
      const values = inner
        .map(t => (t.type === 'string' ? `'${t.value}'` : t.value))
        .join('')
        .replace(/\s/g, '');
      found.push({ values, line: tokens[j].line });
    }
    k = close;
  }
  return found;
}

/** 불리언 · 부호 목록. 그 밖의 IN 목록은 닫힌 어휘이므로 sys_* 표와 FK로 바꿔야 한다. */
export const ALLOWED_IN_LISTS = Object.freeze(['0,1', '-1,0,1', '-1,1']);

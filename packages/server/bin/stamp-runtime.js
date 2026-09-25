#!/usr/bin/env node
// @ts-check
// 릴리스의 index.html에 서버 모드 표시를 넣는다(계획 D7 · §11): node bin/stamp-runtime.js <릴리스>/app/index.html
// 이미 있으면 그대로 둔다(여러 번 불러도 같다). apps/pos/dist에는 부르지 않는다(체험판 빌드에는 표시가 없어야 한다).
import { readFileSync, writeFileSync } from 'node:fs';
import { stampRuntime } from '../src/runtime-stamp.js';

const [file, ...rest] = process.argv.slice(2);
if (!file || rest.length) {
  console.error('쓰는 법: node bin/stamp-runtime.js <index.html>');
  process.exit(64);
}
const before = readFileSync(file, 'utf8');
const after = stampRuntime(before);
if (after !== before) writeFileSync(file, after);
console.log(after === before ? '이미 서버 표시가 있음: ' + file : '서버 표시를 넣음: ' + file);

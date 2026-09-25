// @ts-check
// 서버 판 앱 뼈대 표시(계획 D7): <head> 바로 뒤에 한 번만, 여러 번 찍어도 같고, <head>가 없으면 거절. bin/stamp-runtime.js는 파일을 고친다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RUNTIME_META_TAG, isStamped, stampRuntime } from '../src/runtime-stamp.js';

const HTML = '<!doctype html>\n<html lang="ko">\n  <head>\n    <meta charset="utf-8" />\n    <title>스키노트</title>\n  </head>\n  <body></body>\n</html>\n';

test('표시는 <head> 바로 뒤에 한 번 들어가고 다시 찍어도 같다', () => {
  const once = stampRuntime(HTML);
  assert.ok(isStamped(once));
  assert.equal(once.split(RUNTIME_META_TAG).length - 1, 1);
  assert.ok(once.indexOf(RUNTIME_META_TAG) > once.indexOf('<head>') && once.indexOf(RUNTIME_META_TAG) < once.indexOf('<meta charset'));
  assert.equal(stampRuntime(once), once);
  assert.equal(isStamped(HTML), false);
});

test('다른 모양으로 이미 있는 표시도 알아본다(두 번 넣지 않음)', () => {
  const custom = HTML.replace('<head>', "<head>\n<meta content='server' name='skinote-runtime'>");
  assert.ok(isStamped(custom));
  assert.equal(stampRuntime(custom), custom);
});

test('<head>가 없는 글은 거절한다', () => {
  assert.throws(() => stampRuntime('<html><body></body></html>'), /head/);
});

test('bin/stamp-runtime.js는 파일에 한 번 넣는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sn-stamp-'));
  try {
    const file = join(dir, 'index.html');
    writeFileSync(file, HTML);
    const bin = fileURLToPath(new URL('../bin/stamp-runtime.js', import.meta.url));
    execFileSync(process.execPath, [bin, file], { stdio: 'pipe' });
    execFileSync(process.execPath, [bin, file], { stdio: 'pipe' });
    const text = readFileSync(file, 'utf8');
    assert.equal(text.split(RUNTIME_META_TAG).length - 1, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

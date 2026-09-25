// 쓰는 사람 잠금(D4, deployment 2-2): 매장마다 하나. 다른 연결 · 다른 프로세스는 기다리지 않고 null을 받는다. 쥔 프로세스가
// SIGKILL로 죽으면 운영체제가 잠금을 풀어 곧바로 다시 잡을 수 있다(낡은 잠금이 없다).
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireWriterLock, lockFile } from '../src/index.ts';
import { tempDir } from './helpers.ts';

const temp = tempDir('skinote-lock-');
after(() => temp.cleanup());
const HOLDER = fileURLToPath(new URL('./fixtures/hold-lock.ts', import.meta.url));

/** 자식이 첫 줄을 쓸 때까지(시간 제한). */
function firstLine(child: ChildProcess, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('child did not answer')), timeoutMs);
    child.stdout?.on('data', (chunk) => {
      text += chunk.toString('utf8');
      const nl = text.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        resolve(text.slice(0, nl));
      }
    });
  });
}

const exited = (child: ChildProcess) => new Promise<void>((resolve) => child.on('exit', () => resolve()));

test('one writer per shop in this process: a second connection gets null at once, release frees it', () => {
  const dir = temp.dir + '/a';
  const first = acquireWriterLock(dir, 'shop0test');
  assert.ok(first);
  assert.ok(existsSync(lockFile(dir, 'shop0test')));
  const started = Date.now();
  assert.equal(acquireWriterLock(dir, 'shop0test'), null);
  assert.ok(Date.now() - started < 1_000, 'no waiting (busy_timeout 0)');
  const other = acquireWriterLock(dir, 'shop1test');
  assert.ok(other, 'another shop has its own lock');
  first.release();
  first.release();
  const again = acquireWriterLock(dir, 'shop0test');
  assert.ok(again);
  again.release();
  other.release();
  assert.throws(() => lockFile(dir, '../etc'), /모양/);
});

test('another process holding the lock refuses us; after it is killed with SIGKILL the lock is free immediately', { timeout: 30_000 }, async () => {
  const dir = temp.dir + '/b';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOLDER, dir, 'shop0test'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const gone = exited(child);
  try {
    assert.equal(await firstLine(child), 'held');
    assert.equal(acquireWriterLock(dir, 'shop0test'), null, 'held by the other process');
    child.kill('SIGKILL');
    await gone;
    const mine = acquireWriterLock(dir, 'shop0test');
    assert.ok(mine, 'no stale lock after a kill -9');
    // 이제 우리가 쥐었으니 새 자식은 못 잡는다
    const second = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOLDER, dir, 'shop0test'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const secondGone = exited(second);
    assert.equal(await firstLine(second), 'busy');
    await secondGone;
    mine.release();
  } finally {
    child.kill('SIGKILL');
  }
});

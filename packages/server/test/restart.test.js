// @ts-check
// 다시 시작(plan §5-7, D4): 멈추고 같은 자료 폴더로 다시 띄우면 상태와 세션이 이어지고, 닫으면 쓰는 사람 잠금이 풀리며, 같은 자료 폴더에
// 두 번째 서버는 파일을 건드리지 않고 시작하지 않는다(WRITER_LOCKED), SIGKILL로 죽은 서버는 낡은 잠금을 남기지 않는다(곧바로 다시 뜬다).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { newRequestId } from '@skinote/contract';
import { startServer } from '../src/server.js';
import { WriterLockedError } from '../src/shops.js';
import { device, deviceCode, freePort, PACKAGE_DIR, provisionedShop, request, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

test('state and sessions survive a restart; the writer lock is released on close', async () => {
  const dataDir = join(temp.dir, 'restart');
  const shop = await provisionedShop(dataDir);
  const code = await deviceCode(shop.env);
  const config = testConfig(dataDir, shop.env);
  let app = await startServer(config, { log: () => {} });
  const a = device(app.port);
  await a.enroll(code);
  assert.equal((await a.login('정하늘', /** @type {string} */ (shop.pins['정하늘']))).status, 200);
  const head = await (await a.get('/api/v2/head')).json();
  const out = await (await a.command({
    type: 'setting.set', commandVersion: 1, requestId: newRequestId(), basis: { epoch: head.epoch, rev: head.rev },
    payload: { changes: [{ key: 'shop_settings:same_day_cancel_refund_default:decision', value: 'no_refund' }] },
  })).json();
  assert.equal(out.outcome, 'applied');
  await app.close();

  app = await startServer(config, { log: () => {} });
  try {
    const again = device(app.port);
    Object.assign(again.state, { cookie: a.state.cookie, csrf: a.state.csrf });
    const session = await again.get('/api/v2/session');
    assert.equal(session.status, 200, 'the session survives the restart');
    assert.equal((await session.json()).csrf, a.state.csrf, 'the CSRF value is the same (same session, same key)');
    const after = await (await again.get('/api/v2/head')).json();
    assert.equal(after.rev, out.rev);
    assert.equal(after.epoch, head.epoch);
    const rules = await (await again.query('shopRules', {})).json();
    const card = rules.cards.find((/** @type {{ key: string }} */ c) => c.key === 'refund');
    assert.ok(card.rows[0].options.some((/** @type {any} */ o) => o.key === 'no_refund' && o.selected));
  } finally {
    await app.close();
  }
});

test('a second server on the same data dir refuses to start and never touches the files', async () => {
  const dataDir = join(temp.dir, 'second');
  const shop = await provisionedShop(dataDir);
  const app = await startServer(testConfig(dataDir, shop.env), { log: () => {} });
  try {
    /** @type {string[]} */
    const lines = [];
    await assert.rejects(startServer(testConfig(dataDir, shop.env), { log: line => { lines.push(line); } }), error => {
      assert.ok(error instanceof WriterLockedError);
      assert.equal(/** @type {WriterLockedError} */ (error).code, 'WRITER_LOCKED');
      return true;
    });
    assert.ok(!lines.some(l => l.includes('shops/')), 'no migration line for the locked shop');
    const port = await freePort();
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
      cwd: PACKAGE_DIR, env: { PATH: process.env.PATH ?? '', ...shop.env, SKINOTE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => child.on('exit', resolve));
    assert.equal(code, 1, output);
    assert.match(output, /WRITER_LOCKED/);
    assert.equal((await request(app.port, '/api/health/live')).status, 200, 'the first server is still serving');
  } finally {
    await app.close();
  }
});

test('a server killed with SIGKILL leaves no stale lock: the next start works at once', async () => {
  const dataDir = join(temp.dir, 'killed');
  const shop = await provisionedShop(dataDir);
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
    cwd: PACKAGE_DIR, env: { PATH: process.env.PATH ?? '', ...shop.env, SKINOTE_PORT: String(port) }, stdio: ['ignore', 'ignore', 'ignore'],
  });
  const exited = new Promise(resolve => child.on('exit', resolve));
  try {
    const until = Date.now() + 15_000;
    let live = false;
    while (!live && Date.now() < until) {
      try {
        live = (await request(port, '/api/health/live')).ok;
      } catch {
        await new Promise(r => setTimeout(r, 50));
      }
    }
    assert.ok(live, 'the child server came up');
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  const started = Date.now();
  const app = await startServer(testConfig(dataDir, shop.env), { log: () => {} });
  try {
    assert.ok(Date.now() - started < 5_000, 'no wait for a stale lock');
    assert.equal((await request(app.port, '/api/health')).status, 200);
  } finally {
    await app.close();
  }
});

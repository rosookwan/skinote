// @ts-check
// 관리 소켓(plan §5-5): 서버가 도는 동안 명령줄의 등록 번호 · 비밀번호 새로 · 기기 끊기 · 상태는 서버를 거친다(한 매장 파일에 쓰는 사람은
// 하나). 소켓 파일은 0600, 모르는 명령 · 매장 · 모양은 거절, 기기 끊기는 그 기기의 세션과 알림 연결을 곧바로 끝내고, 비밀번호 새로는 그
// 사람의 잠금을 곧바로 푼다. 서버는 답(비밀)을 기록에 적지 않는다.

import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { sendAdminRequest, startAdminSocket } from '../src/admin-socket.js';
import { startServer } from '../src/server.js';
import { cli, codeOf, collectLog, device, pinsOf, provisionedShop, SHOP, shortTempDir, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
const socketDir = shortTempDir();
const SOCKET = join(socketDir.dir, 'a.sock');
/** @type {Awaited<ReturnType<typeof startServer>>} */
let app;
/** @type {Record<string, string>} */
let env;
/** @type {Record<string, string>} */
let pins;
/** @type {string[]} */
let lines;

before(async () => {
  const dataDir = join(temp.dir, 'socket');
  const shop = await provisionedShop(dataDir, { SKINOTE_ADMIN_SOCKET: SOCKET });
  env = shop.env;
  pins = shop.pins;
  const log = collectLog();
  lines = log.lines;
  app = await startServer(testConfig(dataDir, env), { log: log.log, sleep: async () => {} });
  assert.equal(app.adminSocket, SOCKET);
});
after(async () => {
  await app?.close();
  temp.cleanup();
  socketDir.cleanup();
});

test('the socket file is 0600 and unknown ops, shops and shapes are refused', async () => {
  assert.equal(statSync(SOCKET).mode & 0o777, 0o600);
  assert.ok(statSync(SOCKET).isSocket());
  assert.deepEqual(await sendAdminRequest(SOCKET, { op: 'provision', shopId: SHOP, args: {} }), { ok: false, code: 'UNKNOWN_OP', message: '모르는 명령' });
  assert.deepEqual(await sendAdminRequest(SOCKET, { op: 'toString', shopId: SHOP, args: {} }), { ok: false, code: 'UNKNOWN_OP', message: '모르는 명령' });
  assert.equal((await sendAdminRequest(SOCKET, { op: 'status', shopId: 'other', args: {} })).ok, false);
  const status = await sendAdminRequest(SOCKET, { op: 'status', shopId: SHOP, args: {} });
  assert.equal(status.ok, true);
  assert.equal(/** @type {any} */ (status.ok && status.result).staff, 3);
  const bad = await sendAdminRequest(SOCKET, /** @type {any} */ ({ op: 7 }));
  assert.equal(bad.ok ? '' : bad.code, 'BAD_REQUEST');
  // 같은 경로로 듣는 서버가 있으면 두 번째 소켓은 빼앗지 않는다
  await assert.rejects(startAdminSocket({ path: SOCKET, handle: async () => ({ ok: true, result: null }) }), { code: 'ADMIN_SOCKET_BUSY' });
  assert.equal((await sendAdminRequest(SOCKET, { op: 'status', shopId: SHOP, args: {} })).ok, true, 'the first server still answers');
});

test('device-code, rotate-pin, revoke-device and status go through the running server', async () => {
  // 서버가 잠금을 쥐고 있으니 명령줄은 관리 소켓으로 보낸다
  const made = await cli(['device-code', '--shop', SHOP, '--kind', 'driver_tablet', '--label', '1호차 태블릿', '--vehicle', 'v1'], env);
  assert.equal(made.code, 0, made.err);
  const driver = device(app.port);
  assert.equal((await driver.enroll(codeOf(made.out))).status, 200);
  const driverPin = /** @type {string} */ (pins['박기사']);
  const wrong = driverPin === '0000' ? '1111' : '0000';
  for (let i = 0; i < 5; i += 1) await driver.login('박기사', wrong);
  assert.equal((await driver.login('박기사', driverPin)).status, 423, 'locked on this device');

  const rotated = await cli(['rotate-pin', '--shop', SHOP, '--staff', '박기사'], env);
  assert.equal(rotated.code, 0, rotated.err);
  const newPin = /** @type {string} */ (pinsOf(rotated.out)['박기사']);
  if (newPin !== driverPin) assert.equal((await driver.login('박기사', driverPin)).status, 401, 'the old PIN no longer works, and the lock is gone');
  assert.equal((await driver.login('박기사', newPin)).status, 200);

  const stream = await driver.get('/api/v2/stream');
  assert.equal(stream.status, 200);
  const reader = /** @type {ReadableStream<Uint8Array>} */ (stream.body).getReader();
  let text = '';
  const done = (async () => {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      text += new TextDecoder().decode(value);
    }
  })();

  const revoked = await cli(['revoke-device', '--shop', SHOP, '--device', '1호차 태블릿'], env);
  assert.equal(revoked.code, 0, revoked.err);
  assert.match(revoked.out, /끊음 · 끝낸 세션 1개 · 닫은 알림 연결 1개/);
  await done;
  assert.match(text, /event: bye\ndata: \{"reason":"device_revoked"\}/);
  const after = await driver.get('/api/v2/head');
  assert.equal(after.status, 401);
  assert.equal((await after.json()).code, 'DEVICE_REVOKED');

  const status = JSON.parse((await cli(['status', '--shop', SHOP], env)).out);
  assert.deepEqual(status.devices, { active: 0, revoked: 1 });
  assert.ok(!lines.some(l => new RegExp('\\b' + newPin + '\\b').test(l) || /\d{4}-\d{4}-\d{4}/.test(l)), 'the server never logs the answers');
  assert.ok(lines.some(l => /^관리 소켓 rotate-pin shop0test ok$/.test(l)));
});

test('a configured admin socket that cannot be opened stops the start (a lost device must be revocable while the server runs)', async () => {
  const dataDir = join(temp.dir, 'socket-fail');
  const shop = await provisionedShop(dataDir);
  // 부모 자리가 폴더가 아니라 파일이라 소켓 폴더를 만들 수 없다(권한 없는 /run/skinote와 같은 실패).
  const blocker = join(socketDir.dir, 'blocker');
  writeFileSync(blocker, '');
  const bad = join(blocker, 'a.sock');
  const log = collectLog();
  /** @type {Awaited<ReturnType<typeof startServer>> | null} */
  let started = null;
  await assert.rejects(startServer(testConfig(dataDir, { ...shop.env, SKINOTE_ADMIN_SOCKET: bad }), { log: log.log }).then(x => { started = x; }),
    (e) => /** @type {{ code?: string }} */ (e).code === 'ADMIN_SOCKET_FAILED');
  await /** @type {any} */ (started)?.close();
  assert.ok(log.lines.some(l => l.includes('관리 소켓을 열지 못함')));
  // 잠금을 놓았다: 같은 자료 폴더로 바로 다시 시작할 수 있다.
  const again = await startServer(testConfig(dataDir, shop.env), { log: () => {} });
  await again.close();
});

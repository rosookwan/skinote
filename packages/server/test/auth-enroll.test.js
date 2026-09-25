// @ts-check
// 기기 등록(plan §5-3): 맞는 번호는 한 번만(두 번째 410), 지난 번호 410, 틀린 번호 400이고 한 주소에서 15분에 10번까지(11번째 429),
// 모든 시도가 login_attempts에 남고, 기기 행에 기기 번호(short_no) · 공개 열쇠가 적히고, 한 시간 전체 시도가 100번을 넘으면 경보 줄만
// 남기고 막지는 않는다. 공개 열쇠가 P-256이 아니면 거절한다.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openDatabase } from '@skinote/schema';
import { startServer } from '../src/server.js';
import { cli, codeOf, collectLog, device, deviceCode, provisionedShop, SHOP, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());

/** @param {string} dataDir */
const readControl = dataDir => openDatabase(join(dataDir, 'db', 'control.sqlite'), { readOnly: true });
/** @param {string} dataDir */
const readShop = dataDir => openDatabase(join(dataDir, 'db', 'shops', SHOP + '.sqlite'), { readOnly: true });

test('a good code enrols once; the device row gets a short number and the public key; a used code is 410', async () => {
  const dataDir = join(temp.dir, 'once');
  const { env } = await provisionedShop(dataDir);
  const first = await deviceCode(env, ['--kind', 'pos', '--label', '카운터 1']);
  const second = await deviceCode(env, ['--kind', 'driver_tablet', '--label', '1호차 태블릿', '--vehicle', 'v1']);
  const app = await startServer(testConfig(dataDir, env), { log: () => {} });
  try {
    const a = device(app.port);
    const res = await a.enroll(first);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['deviceId', 'kind', 'label']);
    assert.equal(body.kind, 'pos');
    assert.equal(body.label, '카운터 1');
    assert.match(body.deviceId, /^[0-9A-HJKMNP-TV-Z]{26}$/);

    const again = await device(app.port).enroll(first);
    assert.equal(again.status, 410);
    assert.equal((await again.json()).code, 'CODE_USED');

    const driver = await device(app.port).enroll(second);
    assert.equal(driver.status, 200);
    const d = await driver.json();
    assert.equal(d.kind, 'driver_tablet');
    assert.equal(d.vehicleId, 'v1');

    const shop = readShop(dataDir);
    try {
      const rows = shop.prepare('SELECT id, short_no, kind_key, label, vehicle_id, public_key, registered_by, status_key, offline_capable FROM devices ORDER BY short_no').all();
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map(r => [r.short_no, r.kind_key, r.status_key, r.offline_capable, r.registered_by]), [[1, 'pos', 'active', 0, 'system:cli'], [2, 'driver_tablet', 'active', 0, 'system:cli']]);
      const key = JSON.parse(String(rows[0]?.public_key));
      assert.deepEqual(Object.keys(key).sort(), ['crv', 'kty', 'x', 'y'], 'only the public part is kept');
      const codes = shop.prepare('SELECT used_at, device_id, claimed_agent FROM device_enrollment_codes ORDER BY created_at').all();
      assert.ok(codes.every(c => c.used_at !== null && c.device_id !== null));
      assert.equal(codes[0]?.claimed_agent, 'test · node');
    } finally {
      shop.close();
    }
    const control = readControl(dataDir);
    try {
      const attempts = control.prepare("SELECT succeeded, reason_key, tenant_id, device_id, ip_hash FROM login_attempts WHERE method_key = 'enrollment' ORDER BY id").all();
      assert.deepEqual(attempts.map(r => [r.succeeded, r.reason_key]), [[1, 'ok'], [0, 'code_used'], [1, 'ok']]);
      assert.ok(attempts.every(r => typeof r.ip_hash === 'string' && String(r.ip_hash).length >= 40), 'the address is kept only as a keyed hash');
      const routes = control.prepare('SELECT used_at FROM enrollment_routes').all();
      assert.ok(routes.every(r => r.used_at !== null));
    } finally {
      control.close();
    }
  } finally {
    await app.close();
  }
});

test('an expired code is 410; a wrong code is 400 BAD_CODE; a key that is not P-256 is 400', async () => {
  const dataDir = join(temp.dir, 'expired');
  const { env } = await provisionedShop(dataDir);
  const made = await cli(['device-code', '--shop', SHOP, '--kind', 'pos', '--label', '카운터 2', '--minutes', '5'], env);
  assert.equal(made.code, 0, made.err);
  const code = codeOf(made.out);
  const spare = await deviceCode(env);
  const clock = Date.now() + 6 * 60_000;
  const app = await startServer(testConfig(dataDir, env), { log: () => {}, now: () => new Date(clock) });
  try {
    const late = await device(app.port).enroll(code);
    assert.equal(late.status, 410);
    assert.equal((await late.json()).code, 'CODE_USED');
    const wrong = await device(app.port).enroll('000000000000');
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).code, 'BAD_CODE');

    const a = device(app.port);
    const notP256 = await a.post('/api/v2/device/enroll', { code: spare, publicKey: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) }, agent: 'x' });
    assert.equal(notP256.status, 400, 'a point that is not on the curve');
    const withPrivate = await a.post('/api/v2/device/enroll', { code: spare, publicKey: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43), d: 'C'.repeat(43) }, agent: 'x' });
    assert.equal(withPrivate.status, 400);
    assert.equal((await a.enroll(spare)).status, 200, 'the code still works after the bad attempts');
  } finally {
    await app.close();
  }
});

test('wrong codes: ten per 15 minutes from one address, the 11th is 429; above 100 in an hour an alert line, no block', async () => {
  const dataDir = join(temp.dir, 'limits');
  const { env } = await provisionedShop(dataDir);
  const { lines, log } = collectLog();
  const app = await startServer(testConfig(dataDir, env), { log });
  try {
    const one = device(app.port, { forwardedFor: '203.0.113.50' });
    const statuses = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await one.post('/api/v2/device/enroll', { code: String(100000000000 + i), publicKey: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) }, agent: 'x' })).status);
    assert.deepEqual(statuses, [...Array(10).fill(400), 429]);
    assert.ok(!lines.some(l => l.includes('ALERT')), 'no alert yet');

    for (let i = 0; i < 95; i += 1) {
      const other = device(app.port, { forwardedFor: `198.51.100.${i + 1}` });
      const res = await other.post('/api/v2/device/enroll', { code: String(200000000000 + i), publicKey: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) }, agent: 'x' });
      assert.equal(res.status, 400, 'many addresses are never blocked as a whole');
    }
    assert.equal(lines.filter(l => l === 'ALERT enroll_attempts_high').length, 1, 'one alert line in the hour');
    assert.ok(!lines.some(l => /\d{12}/.test(l)), 'no code in the log');
  } finally {
    await app.close();
  }
});

// @ts-check
// 비밀값(secrets.js)과 직원 비밀번호(pin.js): 넷이 모두 있어야 하고(없거나 짧거나 겹치면 이름만 알림, 값은 적지 않음), 비밀번호 해시는
// PHC 모양이고 후추가 다르면 맞지 않으며, 새 비밀번호는 약한 모양(되풀이 · 이어짐)을 쓰지 않는다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError } from '../src/config.js';
import { generatePin, hashPin, isWeakPin, verifyPin } from '../src/pin.js';
import { loadSecrets, newSecretsEnv, SECRET_NAMES } from '../src/secrets.js';

test('secrets: all four, base64url of 32 bytes or more, all different; problems name the variable, never the value', () => {
  const env = newSecretsEnv();
  const secrets = loadSecrets(env);
  assert.deepEqual(Object.keys(secrets).filter(k => k !== 'proxyToken').sort(), ['fingerprintKey', 'ipKey', 'pinPepper', 'sessionKey']);
  assert.equal(secrets.proxyToken, null, 'the proxy token is optional');
  for (const [key, value] of Object.entries(secrets)) if (key !== 'proxyToken') assert.equal(/** @type {Uint8Array} */ (value).length, 32);
  const token = newSecretsEnv().SKINOTE_IP_KEY;
  assert.equal(loadSecrets({ ...env, SKINOTE_PROXY_TOKEN: token }).proxyToken, token);
  assert.equal(loadSecrets({ ...env, SKINOTE_IP_KEY: env.SKINOTE_IP_KEY + '==' }).ipKey.length, 32, 'padding is fine');

  /** @param {Record<string, string | undefined>} bad */
  const problems = bad => {
    try {
      loadSecrets(bad);
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      return error.problems;
    }
    return [];
  };
  const missing = problems({ ...env, SKINOTE_PIN_PEPPER: undefined, SKINOTE_SESSION_KEY: ' ' });
  assert.equal(missing.length, 2);
  assert.match(missing.join('\n'), /SKINOTE_PIN_PEPPER가 없습니다/);
  const short = problems({ ...env, SKINOTE_FINGERPRINT_KEY: 'c2hvcnQ' });
  assert.match(short[0] ?? '', /SKINOTE_FINGERPRINT_KEY는 base64url로 32바이트 이상/);
  assert.equal(problems({ ...env, SKINOTE_IP_KEY: '!!!' + env.SKINOTE_IP_KEY }).length, 1);
  const same = problems({ ...env, SKINOTE_IP_KEY: env.SKINOTE_SESSION_KEY });
  assert.equal(same.length, 1);
  assert.match(problems({ ...env, SKINOTE_PROXY_TOKEN: 'short' })[0] ?? '', /SKINOTE_PROXY_TOKEN는 base64url로 32바이트 이상/);
  const text = [...missing, ...short, ...same].join('\n');
  for (const value of Object.values(env)) assert.ok(!text.includes(value), 'no secret value in a problem');
  assert.deepEqual(Object.values(SECRET_NAMES).sort(), Object.keys(env).sort());
});

test('PIN hashes: PHC scrypt string, the right PIN and pepper only, malformed hashes are false', async () => {
  const pepper = new Uint8Array(32).fill(7);
  const hash = await hashPin(pepper, '4821');
  assert.match(hash, /^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(await hashPin(pepper, '4821'), hash, 'a new salt each time');
  assert.equal(await verifyPin(pepper, '4821', hash), true);
  assert.equal(await verifyPin(pepper, '4822', hash), false);
  assert.equal(await verifyPin(new Uint8Array(32).fill(8), '4821', hash), false, 'another pepper');
  assert.equal(await verifyPin(pepper, '4821', undefined), false);
  assert.equal(await verifyPin(pepper, '4821', 'plain:4821'), false);
  assert.equal(await verifyPin(pepper, '4821', 'scrypt$N=1073741824,r=8,p=1$AAAA$AAAA'), false, 'an absurd cost is refused');
});

test('new PINs avoid repeated digits and runs', () => {
  for (const weak of ['0000', '1111', '1234', '4321', '0123', '9876', '56789', '999999']) assert.ok(isWeakPin(weak), weak);
  for (const fine of ['4821', '1357', '9090', '120394']) assert.ok(!isWeakPin(fine), fine);
  for (let i = 0; i < 200; i += 1) {
    const pin = generatePin(4 + (i % 3));
    assert.match(pin, /^\d{4,6}$/);
    assert.equal(pin.length, 4 + (i % 3));
    assert.ok(!isWeakPin(pin));
  }
  assert.throws(() => generatePin(3), RangeError);
  assert.throws(() => generatePin(7), RangeError);
});

// @ts-check
// 직원 비밀번호(숫자 4~6자리, plan D6 · §5-3). 해시는 scrypt(HMAC-SHA256(pepper, PIN))이고 control.accounts.pin_hash에 PHC 모양
// 'scrypt$N=16384,r=8,p=1$<salt>$<hash>'(base64url)로 둔다. 후추(pepper)는 데이터베이스 · 백업 밖의 비밀값이라 control 사본만으로는
// 10,000개의 비밀번호를 맞춰 볼 수 없다. scrypt는 비동기(crypto.scrypt)로 돌려 한 로그인이 다른 매장의 명령을 막지 않는다.
// 새 비밀번호는 crypto.randomInt로 만들고, 0000 · 같은 숫자 되풀이(1111) · 이어지는 숫자(1234 · 4321)는 쓰지 않는다.

import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const PREFIX = `scrypt$N=${N},r=${R},p=${P}$`;

/** @param {Uint8Array} pepper @param {string} pin */
const peppered = (pepper, pin) => createHmac('sha256', pepper).update(pin, 'utf8').digest();

/** @param {Buffer} input @param {Buffer} salt @param {{ N: number, r: number, p: number }} cost @returns {Promise<Buffer>} */
function scryptAsync(input, salt, cost) {
  return new Promise((resolve, reject) => {
    scrypt(input, salt, KEY_BYTES, { N: cost.N, r: cost.r, p: cost.p, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/**
 * 비밀번호 해시(PHC 글).
 * @param {Uint8Array} pepper @param {string} pin
 */
export async function hashPin(pepper, pin) {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(peppered(pepper, pin), salt, { N, r: R, p: P });
  return PREFIX + salt.toString('base64url') + '$' + key.toString('base64url');
}

/**
 * 비밀번호가 해시와 맞는지(시간이 같은 비교). 모양이 틀린 해시는 false.
 * @param {Uint8Array} pepper @param {string} pin @param {string | undefined} phc
 */
export async function verifyPin(pepper, pin, phc) {
  const m = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(phc ?? '');
  if (!m) return false;
  const cost = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  if (cost.N > 1 << 20 || cost.r > 32 || cost.p > 16) return false;
  const expected = Buffer.from(/** @type {string} */ (m[5]), 'base64url');
  const key = await scryptAsync(peppered(pepper, pin), Buffer.from(/** @type {string} */ (m[4]), 'base64url'), cost);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** 쓰지 않는 비밀번호: 같은 숫자 되풀이, 한 칸씩 오르거나 내리는 숫자(0123 · 9876). @param {string} pin */
export function isWeakPin(pin) {
  if (/^(\d)\1+$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - /** @type {number} */ (digits[i])));
  return steps.size === 1 && (steps.has(1) || steps.has(-1));
}

/** 새 비밀번호(숫자 digits자리, 약한 모양은 다시 뽑는다). @param {number} [digits] */
export function generatePin(digits = 4) {
  if (!Number.isInteger(digits) || digits < 4 || digits > 6) throw new RangeError('비밀번호는 4~6자리');
  for (;;) {
    let pin = '';
    for (let i = 0; i < digits; i += 1) pin += String(randomInt(10));
    if (!isWeakPin(pin)) return pin;
  }
}

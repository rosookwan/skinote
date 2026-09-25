// @ts-check
// ULID(시각 48비트 + 무작위 80비트, Crockford base32 26자). 새 id는 ULID다(data-model 3절). 첫 매장 id를 만들 때 쓴다.

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** @param {number} [time] 밀리초 */
export function ulid(time = Date.now()) {
  if (!Number.isSafeInteger(time) || time < 0 || time > 2 ** 48 - 1) throw new RangeError('ULID 시각이 범위를 벗어났습니다');
  let head = '';
  let t = time;
  for (let i = 0; i < 10; i += 1) {
    head = ALPHABET[t % 32] + head;
    t = Math.floor(t / 32);
  }
  // 무작위 80비트 = 16글자 × 5비트. 바이트를 비트 흐름으로 읽는다.
  const bytes = randomBytes(10);
  let tail = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      tail += ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return head + tail;
}

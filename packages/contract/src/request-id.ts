// 요청번호(ULID). 확인 창이 열릴 때 만들어 초안에 저장하고, 다시 보낼 때마다 같은 것을 쓴다(sync 2절).
// 앞 10자는 만든 시각(ms), 뒤 16자는 무작위 80비트다. 글자는 Crockford base32.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type RandomBytes = (size: number) => Uint8Array;

const cryptoRandom: RandomBytes = (size) => {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > 0xffff_ffff_ffff) throw new RangeError('요청번호 시각이 범위를 벗어났다: ' + ms);
  let out = '';
  let rest = ms;
  for (let i = 0; i < 10; i += 1) {
    out = ALPHABET.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80비트 = 10바이트 → 5비트씩 16글자
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

/** 새 요청번호. 시험에서는 시각과 무작위 함수를 넣어 같은 값을 만든다. */
export function newRequestId(nowMs: number = Date.now(), random: RandomBytes = cryptoRandom): string {
  const bytes = random(10);
  if (bytes.length !== 10) throw new RangeError('요청번호 무작위 값은 10바이트여야 한다');
  return encodeTime(nowMs) + encodeRandom(bytes);
}

/** 요청번호 모양 확인(26자, Crockford base32). */
export function isRequestId(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

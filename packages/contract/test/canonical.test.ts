// 정규 JSON(work/impl-offline/plan.md O5)과 함께 쓰는 벡터(test/vectors/queued-items.json): 저장소 · 서버 시험도 같은 벡터를 읽는다.
//   - 열쇠 차례 · 빈칸 없음 · undefined 빠짐 · -0은 0 · 유한하지 않은 수는 던짐 · 한글은 그대로.
//   - 벡터마다 받은 글(text)을 JSON으로 읽어 서명 칸을 뺀 정규 글과 해시가 적어 둔 값과 같다(WebCrypto).
//   - 보냄 대기 봉투 검사는 벡터의 정규 값을 바꾸지 않는다(서버는 검사 전의 값으로 해시한다).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalJson, itemHash, itemHashInput, parseQueuedEnvelope, unsignedItem } from '../src/index.ts';

interface Vector { name: string; text: string; canonical: string; hash: string }
const VECTORS = JSON.parse(readFileSync(new URL('./vectors/queued-items.json', import.meta.url), 'utf8')) as Vector[];

describe('canonicalJson', () => {
  it('sorts keys by UTF-16 code units, drops undefined, keeps arrays in order', () => {
    expect(canonicalJson({ b: 1, a: [3, undefined, { d: undefined, c: 'x' }], 가: true, A: null })).toBe('{"A":null,"a":[3,null,{"c":"x"}],"b":1,"가":true}');
  });
  it('writes -0 as 0 and throws on non-finite numbers', () => {
    expect(canonicalJson({ n: -0 })).toBe('{"n":0}');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow();
  });
  it('writes strings like JSON.stringify (Korean kept, control characters escaped)', () => {
    expect(canonicalJson('김민수\n· 0025')).toBe(JSON.stringify('김민수\n· 0025'));
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('the shared vectors (contract · store · server · e2e)', () => {
  for (const v of VECTORS) {
    it(v.name, async () => {
      const item = JSON.parse(v.text) as unknown;
      expect(itemHashInput(item)).toBe(v.canonical);
      expect(await itemHash(item)).toBe(v.hash);
      // 서명 칸만 빠진다.
      expect(JSON.stringify(unsignedItem(item))).not.toContain('"signature"');
    });
  }

  it('parseQueuedEnvelope accepts every envelope vector and never changes its canonical value', () => {
    for (const v of VECTORS.filter((x) => x.name !== 'generic korean nested')) {
      const item = JSON.parse(v.text) as unknown;
      const parsed = parseQueuedEnvelope(item, { deviceKind: 'driver_phone' });
      expect(parsed.ok, v.name + ' ' + JSON.stringify(parsed)).toBe(true);
      expect(itemHashInput(parsed.ok ? parsed.envelope : item)).toBe(v.canonical);
    }
  });
});

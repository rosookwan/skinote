// id와 시각 글. 새 id는 ULID다(data-model 3-1, @skinote/contract의 newRequestId와 같은 모양). 매장 목록 행은 도메인 key를 id로 쓴다
// (상품 'ski', 결제 수단 'cash' …: 한 매장 파일 안에서 유일하고, 도메인이 key로 가리키므로 되읽을 때 옮길 것이 없다).
import { randomBytes } from 'node:crypto';
import { newRequestId } from '@skinote/contract';

/** 새 ULID(시각은 now). */
export const ulid = (now: number = Date.now()): string => newRequestId(now, (size) => randomBytes(size));

/** ms → ISO UTC('2026-12-26T06:40:00.000Z'). 표의 모든 시각 열이 이 모양이다(data-model 3-3). */
export const isoOf = (ms: number): string => new Date(ms).toISOString();

/** ISO → ms. */
export const msOf = (iso: string): number => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error('시각 글 모양: ' + iso);
  return ms;
};

/** 날짜에 날 더하기('YYYY-MM-DD'). */
export function addDays(date: string, days: number): string {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 판단 없이 JSON을 같은 글로(키 차례 고정): 지문 · 해시 · 비교에 쓴다. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
}

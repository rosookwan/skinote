// 장부 옮기기의 공통 도움(plan §4-2): 한 명령(또는 가져오기)의 쓰기 문맥, 사실 행의 머리 칸(일어난 때 · 적은 때 · 영업일 · 기록일 ·
// 행위자 · 요청번호 · rev), 한국 시각의 날짜 · 'HH:MM', 새 행 id.
// 약속 시각은 표에 날짜 + 'HH:MM'으로 적는다: 도메인은 약속 시각을 분 단위로 둔다(plan §3-3 6). 분 단위가 아니면 되읽을 수 없어 던진다.
import type { AnyCommandEnvelope } from '@skinote/contract';
import type { ShopState } from '@skinote/domain';
import { StoreError } from '../errors.ts';
import { canonicalJson, isoOf } from '../ids.ts';
import { num, one, run, type Db, type InValue } from '../db.ts';
import { businessDateAt, ensureBusinessDay, postingDateFor } from '../dates.ts';
import { MAIN_SCOPE } from '../registry-keys.ts';
import type { ChangeEntry } from '../journal.ts';

const KST = 9 * 3_600_000;
const MINUTE = 60_000;

/** ms → 한국 날짜 'YYYY-MM-DD'. */
export const localDate = (ms: number): string => new Date(ms + KST).toISOString().slice(0, 10);
/** ms → 한국 시각 'HH:MM'(분 단위여야 한다). */
export function localTime(ms: number, what = '약속 시각'): string {
  if (ms % MINUTE !== 0) throw new StoreError('UNMAPPED_CHANGE', what + '이 분 단위가 아니다');
  return new Date(ms + KST).toISOString().slice(11, 16);
}
/** 한국 날짜 + 'HH:MM' → ms. */
export const msOfLocal = (date: string, time: string): number => Date.parse(date + 'T' + time + ':00.000Z') - KST;

/** 쓰기 문맥: 명령(또는 가져오기) 하나. */
export interface WriteContext {
  db: Db;
  shopId: string;
  /** 서버 시각(recorded_at). */
  now: number;
  rev: number;
  actor: { key: string; name: string; deviceId?: string };
  requestId: string;
  /** 명령 봉투(가져오기는 없음): 차량 · 업무를 고를 때 본다. */
  envelope?: AnyCommandEnvelope;
  before: ShopState;
  after: ShopState;
  /** 이 rev가 건드린 행(change_log). */
  touched: ChangeEntry[];
}

/** 이 문맥의 새 id: `${요청번호}:${종류}${n}`. */
export function idMaker(ctx: WriteContext): (kind: string) => string {
  const counts = new Map<string, number>();
  return (kind) => {
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    return ctx.requestId + ':' + kind + n;
  };
}

const dateCache = new WeakMap<WriteContext, Map<number, string>>();

/** 그 시각의 영업일(매장의 기준 시각 기록째). */
export function businessDateOfCtx(ctx: WriteContext, ms: number): string {
  let cache = dateCache.get(ctx);
  if (!cache) {
    cache = new Map();
    dateCache.set(ctx, cache);
  }
  let date = cache.get(ms);
  if (date === undefined) {
    date = businessDateAt(ctx.db, ctx.shopId, ms);
    cache.set(ms, date);
  }
  return date;
}

/** 사실 행의 머리 칸(돈 · 재고 · 마감 · 방문 …): 일어난 때(occurredMs), 적은 때(지금), 영업일 · 기록일, 행위자, 요청번호, rev. */
export function factMeta(ctx: WriteContext, occurredMs: number): Record<string, InValue> {
  const businessDate = businessDateOfCtx(ctx, occurredMs);
  ensureBusinessDay(ctx.db, ctx.shopId, businessDate, isoOf(ctx.now));
  return {
    occurred_at: isoOf(occurredMs),
    recorded_at: isoOf(ctx.now),
    closing_scope_id: MAIN_SCOPE,
    business_date: businessDate,
    posting_date: postingDateFor(ctx.db, ctx.shopId, businessDate),
    actor_key: ctx.actor.key,
    actor_name: ctx.actor.name,
    device_id: ctx.actor.deviceId,
    request_id: ctx.requestId,
    created_rev: ctx.rev,
  };
}

/** 지금 설정 판(shops.config_rev). */
export const configRevOf = (ctx: WriteContext): number => num(one(ctx.db, 'SELECT config_rev FROM shops WHERE id = ?', ctx.shopId)?.config_rev);

/** 매장 셈 하나를 올리고 새 값을 돌려준다(shop_counters, 장부가 아니다). */
export function bumpCounter(db: Db, shopId: string, key: string, scope = ''): number {
  const row = one(db, 'SELECT value FROM shop_counters WHERE shop_id = ? AND counter_key = ? AND scope_key = ?', shopId, key, scope);
  const value = num(row?.value) + 1;
  if (row) run(db, 'UPDATE shop_counters SET value = ? WHERE shop_id = ? AND counter_key = ? AND scope_key = ?', value, shopId, key, scope);
  else run(db, 'INSERT INTO shop_counters (shop_id, counter_key, scope_key, value) VALUES (?, ?, ?, ?)', shopId, key, scope, value);
  return value;
}

/** 도메인 상태가 표로 옮길 수 없는 바뀜(고쳐진 사실 · 사라진 행 …). 트랜잭션이 통째로 되돌아간다. */
export function unmapped(what: string): never {
  throw new StoreError('UNMAPPED_CHANGE', what);
}

/** 앞 목록이 뒤 목록의 앞부분인지(추가만 하는 사실 목록): 아니면 던진다. 새로 붙은 것을 돌려준다. */
export function appended<T>(before: readonly T[] | undefined, after: readonly T[] | undefined, what: string): T[] {
  const a = before ?? [];
  const b = after ?? [];
  if (b.length < a.length) unmapped(what + ': 사실이 사라졌다');
  for (let i = 0; i < a.length; i += 1) if (canonicalJson(a[i]) !== canonicalJson(b[i])) unmapped(what + ': 적은 사실이 바뀌었다');
  return b.slice(a.length);
}

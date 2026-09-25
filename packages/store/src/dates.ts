// 영업일 · 기록일 · 열린 날(data-model 3-3, plan §4-2 · D13). 영업일은 도메인이 센다(businessDateOf, 기준 시각을 바꾼 기록째). 저장소는
// 기준 시각의 기록을 표(shops · config_changes)에서 읽고, 마감이 닫은 날의 기록은 다음 열린 날로 올린다(posting_date).
import { businessDateOf, type CutoffHistory } from '@skinote/domain';
import { addDays, msOf } from './ids.ts';
import { all, one, run, str, type Db } from './db.ts';

/** 기준 시각을 바꾼 기록 한 줄(config_changes, entity_type 'shops'의 business_day_cutoff). */
export interface CutoffChange {
  until: number;
  cutoff: string;
}

/** 매장의 영업일 기준 시각과 바꾼 기록(바꾼 차례, 옛것부터). 도메인의 FxShopRules.cutoffBefore와 같은 모양이다. */
export function cutoffHistory(db: Db, shopId: string): CutoffHistory & { before: CutoffChange[] } {
  const shop = one(db, 'SELECT business_day_cutoff FROM shops WHERE id = ?', shopId);
  if (!shop) throw new Error('매장 행이 없다: ' + shopId);
  const before: CutoffChange[] = [];
  for (const row of all(db, "SELECT before_json, at FROM config_changes WHERE shop_id = ? AND entity_type = 'shops' AND entity_id = ? ORDER BY config_rev, seq", shopId, shopId)) {
    const value = JSON.parse(str(row.before_json)) as { business_day_cutoff?: unknown };
    if (typeof value.business_day_cutoff === 'string') before.push({ until: msOf(str(row.at)), cutoff: value.business_day_cutoff });
  }
  return { current: str(shop.business_day_cutoff), before };
}

/** 이 시각의 영업일(기준 시각을 바꾼 기록째). */
export const businessDateAt = (db: Db, shopId: string, ms: number): string => businessDateOf(ms, cutoffHistory(db, shopId));

/** 그 날이 마감으로 닫혔는지(business_days 행이 없으면 열린 날). */
export function isClosed(db: Db, shopId: string, date: string, scope = 'main'): boolean {
  const row = one(db, 'SELECT active_closing_id FROM business_days WHERE shop_id = ? AND closing_scope_id = ? AND business_date = ?', shopId, scope, date);
  return row !== undefined && row.active_closing_id !== null;
}

/** 기록일(posting_date): 영업일이 열려 있으면 그날, 닫혔으면 그 뒤의 첫 열린 날(늦게 들어온 사실이 닫은 날을 바꾸지 않게). */
export function postingDateFor(db: Db, shopId: string, businessDate: string, scope = 'main'): string {
  let date = businessDate;
  for (let guard = 0; isClosed(db, shopId, date, scope); guard += 1) {
    if (guard > 366) throw new Error('열린 날을 찾지 못했다: ' + businessDate);
    date = addDays(date, 1);
  }
  return date;
}

/** 영업일 행을 만든다(이미 있으면 그대로). business_days는 장부가 아니라 ON CONFLICT DO NOTHING이 괜찮다(plan §4-5). */
export function ensureBusinessDay(db: Db, shopId: string, date: string, nowIso: string, scope = 'main'): void {
  run(db, 'INSERT INTO business_days (shop_id, closing_scope_id, business_date, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (shop_id, closing_scope_id, business_date) DO NOTHING', shopId, scope, date, nowIso);
}

/** 아직 닫지 않은 영업일(옛날부터, 오늘 영업일로 끝남). 오늘 전의 열린 날은 business_days 행이 있는 날만이다. */
export function openDays(db: Db, shopId: string, businessDate: string, scope = 'main'): string[] {
  const rows = all(db, 'SELECT business_date FROM business_days WHERE shop_id = ? AND closing_scope_id = ? AND active_closing_id IS NULL AND business_date < ? ORDER BY business_date', shopId, scope, businessDate);
  return [...rows.map((r) => str(r.business_date)), businessDate];
}

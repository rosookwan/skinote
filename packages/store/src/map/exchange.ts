// 즉시 교환 ↔ 표(features-1 plan §7-3, data-model 4-18). 교환 한 건(FxSwap)은 exchanges(그 접수의 줄, 방법 shop_counter, 상태 completed, 옛 · 새
// 규격과 그 이름의 사본, 만든 사람 · 때 · 요청번호) + exchange_units 한 행(수량 교환: 옛 · 새 규격 · 수; 손님에게 있던 것은 건넨 때 · 받은 때 = 지금,
// 지급 전 것은 둘 다 없음)이다. 손님에게 있던 것은 이동 두 줄(exchange_id): 옛 규격 손님 → 매장(direct_return), 새 규격 매장 → 손님(deliver)과
// 수량 재고(stock_balances) ±. 줄의 수 셈은 바뀌지 않는다(되읽기 loadStock이 exchange_id 이동을 넣지 않는다). 뒤의 지급 · 반납 · 수거 이동은 자리 셈
// (map/stock countParts)으로 규격을 나눈다.
// 되읽기: exchanges 차례(rowid)대로 줄의 swaps. base(그때의 첫 자리)는 표에 칸이 없어 그 교환의 rev 앞 이동을 접어 센다(held = 돌아온 수, planned =
// 지급 + 차에 실린 수), 누가는 그 요청번호의 작업 기록(events.actor_name).
import { swapBase, type FxLine, type FxOrder, type FxSwap } from '@skinote/domain';
import { isoOf, msOf } from '../ids.ts';
import { all, insert, num, one, str, text, type Db } from '../db.ts';
import { SHOP_LOCATION, variantId } from '../registry-keys.ts';
import { appended, idMaker, unmapped, type WriteContext } from './common.ts';
import { ensureCustomer, insertMovement } from './stock.ts';

type Ids = ReturnType<typeof idMaker>;

/** 이 명령이 쌓은 교환(줄마다 앞 뒤를 비교): exchanges · exchange_units, 손님에게 있던 것은 이동 두 줄. */
export function writeExchanges(ctx: WriteContext, ids: Ids, prevLine: (o: FxOrder, l: FxLine) => FxLine): void {
  for (const o of ctx.after.orders) {
    for (const n of o.lines) {
      const added = appended(prevLine(o, n).swaps, n.swaps, '교환 ' + n.id);
      for (const s of added) insertSwap(ctx, ids, o, n, s);
    }
  }
}

function insertSwap(ctx: WriteContext, ids: Ids, o: FxOrder, l: FxLine, s: FxSwap): void {
  if (!(s.quantity >= 1) || s.from === s.to) unmapped('교환의 모양: ' + s.id);
  const at = isoOf(s.at);
  const oldVariant = variantId(l.kind, s.from);
  const newVariant = variantId(l.kind, s.to);
  const label = (id: string) => text(one(ctx.db, 'SELECT label FROM item_variants WHERE shop_id = ? AND id = ?', ctx.shopId, id)?.label) ?? unmapped('규격이 없다: ' + id);
  insert(ctx.db, 'exchanges', {
    shop_id: ctx.shopId, id: s.id, order_id: o.id, line_id: l.id, catalog_item_id: l.kind, old_size: label(oldVariant), new_size: label(newVariant),
    old_variant_id: oldVariant, new_variant_id: newVariant, method_key: 'shop_counter', status_key: 'completed', created_at: at, created_by: ctx.actor.key,
    request_id: ctx.requestId, updated_rev: ctx.rev,
  });
  insert(ctx.db, 'exchange_units', {
    shop_id: ctx.shopId, exchange_id: s.id, seq: 1, order_id: o.id, old_variant_id: oldVariant, new_variant_id: newVariant, quantity: s.quantity,
    ...(s.planned ? {} : { delivered_at: at, received_at: at }),
  });
  ctx.touched.push({ scope: 'store', entityType: 'exchanges', entityId: s.id, aggregateType: 'order', aggregateId: o.id });
  if (s.planned) return;
  // 손님에게 있던 것: 옛 규격이 매장으로 돌아오고(direct_return) 새 규격이 나간다(deliver). 줄의 수 셈에는 넣지 않는다.
  const customer = ensureCustomer(ctx, o.id);
  insertMovement(ctx, ids, { kind: 'direct_return', from: customer, to: SHOP_LOCATION, orderId: o.id, at: s.at, exchangeId: s.id, lines: [{ order: o, line: l, quantity: s.quantity, variantKey: s.from }] });
  insertMovement(ctx, ids, { kind: 'deliver', from: SHOP_LOCATION, to: customer, orderId: o.id, at: s.at, exchangeId: s.id, lines: [{ order: o, line: l, quantity: s.quantity, variantKey: s.to }] });
}

/** 줄의 수 셈 모양(그 교환 앞의 이동을 접어 base를 센다). */
type Counts = Pick<FxLine, 'loaded' | 'issued' | 'returned' | 'collected' | 'received' | 'unloaded'>;

/** 그 줄의 rev 앞 이동(교환 이동 빼고)을 되읽기(loadStock)와 같은 규칙으로 접는다. */
function countsBefore(db: Db, shopId: string, lineId: string, rev: number): Counts {
  const c: Counts = { loaded: 0, issued: 0, returned: 0, collected: 0, received: 0, unloaded: 0 };
  for (const r of all(db, `SELECT m.kind_key, m.order_id, ml.quantity FROM stock_movement_lines ml JOIN stock_movements m ON m.shop_id = ml.shop_id AND m.id = ml.movement_id
      WHERE ml.shop_id = ? AND ml.order_line_id = ? AND m.exchange_id IS NULL AND m.created_rev < ? ORDER BY m.created_rev, m.rowid, ml.line_no`, shopId, lineId, rev)) {
    const q = num(r.quantity);
    switch (str(r.kind_key)) {
      case 'load': c.loaded = Math.max(c.loaded, c.issued) + q; break;
      case 'deliver': c.issued += q; break;
      case 'direct_return': c.returned += q; break;
      case 'collect': c.collected += q; break;
      case 'receive':
        if (text(r.order_id) !== undefined) c.unloaded = (c.unloaded ?? 0) + q;
        else c.received += q;
        break;
    }
  }
  return c;
}

/** 되읽기: 줄마다 교환(차례대로). 규격 key는 item_variants.code, base는 그 rev 앞의 수 셈, 누가는 작업 기록의 이름. */
export function loadSwaps(db: Db, shopId: string, lineById: Map<string, FxLine>): void {
  const rows = all(db, `SELECT e.id, e.line_id, e.created_at, e.request_id, e.updated_rev, u.quantity, u.delivered_at, ov.code AS old_code, nv.code AS new_code, ev.actor_name
    FROM exchanges e JOIN exchange_units u ON u.shop_id = e.shop_id AND u.exchange_id = e.id
    JOIN item_variants ov ON ov.shop_id = u.shop_id AND ov.id = u.old_variant_id JOIN item_variants nv ON nv.shop_id = u.shop_id AND nv.id = u.new_variant_id
    LEFT JOIN events ev ON ev.shop_id = e.shop_id AND ev.request_id = e.request_id
    WHERE e.shop_id = ? AND e.status_key = 'completed' ORDER BY e.rowid, u.seq`, shopId);
  for (const r of rows) {
    const l = lineById.get(str(r.line_id));
    if (!l) continue;
    const planned = text(r.delivered_at) === undefined;
    const before = { ...l, ...countsBefore(db, shopId, l.id, num(r.updated_rev)) };
    const swap: FxSwap = {
      id: str(r.id), at: msOf(str(r.created_at)), quantity: num(r.quantity), from: str(r.old_code), to: str(r.new_code), planned, base: swapBase(before, planned),
      ...(text(r.actor_name) !== undefined ? { byName: str(r.actor_name) } : {}),
    };
    l.swaps = [...(l.swaps ?? []), swap];
  }
}

// 명령 앞뒤의 도메인 상태 → 행(plan §4-2 · §4-5 7). 도메인은 상태를 돌려주고(execute), 저장소가 앞뒤를 비교해 늘어난 사실을 표에 적는다:
//   운영 규칙(registry-write) · 접수 번호 셈 · 접수 · 줄 · 약속 · 결제 약속 · 할인(map/orders) · 재고 이동 · 준비 번호 · 일정 몫(map/stock)
//   · 돈 · 보증금(map/money) · 방문 · 청구 조정 · 빨리 확인 · 방문 순서(map/dispatch) · 차량 현금 · 마감(map/cash), 그리고 접수 · 줄의 투영 칸.
// 표로 옮길 수 없는 바뀜(적은 사실이 고쳐짐 · 사라진 행 · 목록 값 바뀜 …)은 UNMAPPED_CHANGE를 던져 트랜잭션이 통째로 되돌아간다
// (반쯤 쓴 명령이 남지 않는다). 쌍둥이 실행 시험이 모든 명령의 되읽기를 맞춘다(test/twin-run.test.ts).
import { charged, heldAmount, ownDue, paidTotal, type FxLine, type FxOrder, type ShopState } from '@skinote/domain';
import { canonicalJson, isoOf } from './ids.ts';
import { one, run, str, type Db } from './db.ts';
import { writeSettingsChange } from './registry-write.ts';
import type { ChangeEntry } from './journal.ts';
import { appended, idMaker, unmapped, type WriteContext } from './map/common.ts';
import { checkFixedLine, checkFixedOrder, insertAddedLines, insertOrder, syncPaymentPromises, syncPromises } from './map/orders.ts';
import { blankLine, checkAssets, writeClaims, writeFulfillments, writeStock } from './map/stock.ts';
import { writeMoney } from './map/money.ts';
import { writeCharges, writePins, writeRouteRanks, writeVisits } from './map/dispatch.ts';
import { writeCash } from './map/cash.ts';

export type { WriteContext } from './map/common.ts';

/** 접수 번호 셈(마지막으로 준 번호): 뒤로 가지 않는다(다시 쓴 번호가 이미 찍힌 접수증과 겹치지 않게). */
export function raiseReceiptCounter(db: Db, shopId: string, date: string, lastGiven: number): void {
  run(db, `INSERT INTO shop_counters (shop_id, counter_key, scope_key, value) VALUES (?, 'receipt', ?, ?)
    ON CONFLICT (shop_id, counter_key, scope_key) DO UPDATE SET value = max(value, excluded.value)`, shopId, date, lastGiven);
}

/** 새 접수의 '앞' 모양(수 셈 0, 사실 없음). 약속 · 결제 약속은 뼈대가 이미 적었다. */
function blankOrder(o: FxOrder): FxOrder {
  const { visits: _v, charges: _c, splits: _s, ...rest } = o;
  return { ...rest, payments: [], lines: o.lines.map(blankLine) };
}

/** 명령 하나의 앞뒤 상태를 표에 적는다(명령 트랜잭션 안). 건드린 행(change_log)을 ctx.touched에 모은다. */
export function writeState(ctx: WriteContext): void {
  const { before, after, db, shopId } = ctx;
  const ids = idMaker(ctx);
  if (before.epoch !== after.epoch) unmapped('epoch');
  if (canonicalJson(before.registry) !== canonicalJson(after.registry)) unmapped('매장 목록 값');
  if (canonicalJson(before.drawers) !== canonicalJson(after.drawers)) unmapped('돈통');
  if (before.businessDate !== after.businessDate) unmapped('영업일');

  if (canonicalJson(before.settings) !== canonicalJson(after.settings)) {
    writeSettingsChange(db, shopId, before.registry, before.settings, after.settings, { now: ctx.now, actorKey: ctx.actor.key, requestId: ctx.requestId, rev: ctx.rev });
    ctx.touched.push({ scope: 'store', entityType: 'shops', entityId: shopId, aggregateType: 'shop', aggregateId: shopId });
  }
  if (after.nextReceiptSeq !== before.nextReceiptSeq) {
    if (after.nextReceiptSeq < before.nextReceiptSeq) unmapped('접수 번호 셈이 뒤로 갔다');
    raiseReceiptCounter(db, shopId, after.businessDate, after.nextReceiptSeq - 1);
  }

  // 접수: 사라지거나 차례가 바뀌지 않는다(새 접수는 끝에).
  const prevById = new Map(before.orders.map((o) => [o.id, o]));
  if (after.orders.length < before.orders.length || before.orders.some((o, i) => after.orders[i]?.id !== o.id)) unmapped('접수의 차례가 바뀌었다');
  for (const o of after.orders) if (!prevById.has(o.id)) insertOrder(ctx, ids, o);
  const touchedOrders = new Set<string>();
  for (const o of after.orders) {
    const prev = prevById.get(o.id);
    if (prev) {
      if (canonicalJson(prev) === canonicalJson(o)) continue;
      checkFixedOrder(prev, o);
      if (o.lines.length < prev.lines.length || prev.lines.some((l, i) => o.lines[i]?.id !== l.id)) unmapped('줄의 차례가 바뀌었다: ' + o.id);
      prev.lines.forEach((l, i) => checkFixedLine(l, o.lines[i]!));
      insertAddedLines(ctx, o, o.lines.slice(prev.lines.length));
    }
    touchedOrders.add(o.id);
    // 뼈대는 원래 일정만 적었다(새 접수의 나눈 일정 · 결제 약속은 여기서).
    syncPromises(ctx, ids, prev ?? { ...o, splits: [] }, o);
    syncPaymentPromises(ctx, ids, prev, o);
    writeCharges(ctx, prev, o);
    writeVisits(ctx, prev, o, ids);
  }

  // 재고 이동 · 준비 번호 · 일정 몫.
  const prevLine = (o: FxOrder, l: FxLine): FxLine => prevById.get(o.id)?.lines.find((x) => x.id === l.id) ?? blankLine(l);
  const movements = writeStock(ctx, ids, prevLine);
  writeClaims(ctx, ids, movements, prevLine);
  writeFulfillments(ctx, movements, (orderId, lineId, schedule) => {
    const row = one(db, `SELECT id FROM line_promises WHERE shop_id = ? AND order_id = ? AND line_id = ? AND promise_type_key = 'return' AND schedule_id = ?
      AND status_key = 'active'`, shopId, orderId, lineId, schedule);
    return row ? str(row.id) : undefined;
  });
  checkAssets(before, after, movements);
  const receives = appended(before.vanReceipts, after.vanReceipts, '매장 입고');
  const receiveMoves = movements.filter((m) => m.kind === 'receive');
  if (receives.length !== receiveMoves.length) unmapped('매장 입고 기록과 입고 이동의 수가 다르다');

  // 돈 · 보증금.
  writeMoney(ctx, (id) => prevById.get(id));
  for (const d of after.deposits) {
    const prev = before.deposits.find((x) => x.id === d.id);
    if (!prev || prev.entries.length !== d.entries.length) touchedOrders.add(d.orderId);
  }

  // 차량 업무 · 차량 현금 · 마감.
  writePins(ctx);
  writeRouteRanks(ctx);
  writeCash(ctx);

  // 투영(접수 · 줄) — 진실이 아니라 SQL 읽기를 돕는 칸.
  for (const id of touchedOrders) {
    const o = after.orders.find((x) => x.id === id);
    if (!o) continue;
    writeProjections(ctx, o, prevById.get(id) === undefined ? blankOrder(o) : prevById.get(id)!);
    ctx.touched.push({ scope: 'store', entityType: 'orders', entityId: id, aggregateType: 'order', aggregateId: id });
  }
  for (const p of after.pins.slice(before.pins.length)) ctx.touched.push({ scope: 'store', entityType: 'task_pins', entityId: p.id });
  if (canonicalJson(before.routeRanks) !== canonicalJson(after.routeRanks)) ctx.touched.push({ scope: 'store', entityType: 'route_positions', entityId: '*' });
  for (const c of after.closings.slice(before.closings.length)) ctx.touched.push({ scope: 'store', entityType: 'closings', entityId: c.date });
  for (const t of after.cashTransfers) {
    const prev = before.cashTransfers.find((x) => x.id === t.id);
    if (!prev || (!prev.confirmed && t.confirmed)) ctx.touched.push({ scope: 'store', entityType: 'cash_transfers', entityId: t.id });
  }
}

/** 접수 · 줄의 투영 칸(청구 · 받은 돈 · 미수 · 보증금 · 진행 수). */
function writeProjections(ctx: WriteContext, o: FxOrder, prev: FxOrder): void {
  const chargedAmount = Math.max(0, charged(o));
  const paid = paidTotal(o);
  const due = ownDue(o);
  const held = ctx.after.deposits.filter((d) => d.orderId === o.id).reduce((sum, d) => sum + Math.max(0, heldAmount(d)), 0);
  const back = (l: FxLine) => l.returned + l.collected;
  const openLine = (l: FxLine) => l.issued < l.qty || (l.returnable && back(l) < l.issued);
  const open = due > 0 || held > 0 || o.lines.some(openLine);
  const anyIssued = o.lines.some((l) => l.issued > 0);
  const payState = chargedAmount === 0 ? 'none' : due === 0 ? 'paid' : o.payerOrderId ? 'promised' : paid > 0 ? 'partial' : 'unpaid';
  run(ctx.db, `UPDATE orders SET status_key = ?, is_open = ?, charged_amount = ?, net_paid_amount = ?, due_amount = ?, credit_amount = ?, deposit_held_amount = ?,
    pay_state_key = ?, updated_at = ?, updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?`,
  !open ? 'completed' : anyIssued ? 'in_use' : 'booked', open, chargedAmount, paid, due, Math.max(0, paid - chargedAmount), held, payState, isoOf(ctx.now), ctx.rev,
  ctx.shopId, o.id);
  for (const l of o.lines) {
    const p = prev.lines.find((x) => x.id === l.id);
    if (p && canonicalJson(p) === canonicalJson(l)) continue;
    const loaded = Math.max(l.loaded, l.issued);
    const progress = l.returnable ? (back(l) >= l.qty ? 'done' : l.issued > 0 ? 'partial' : 'todo') : l.issued >= l.qty ? 'done' : l.issued > 0 ? 'partial' : 'todo';
    run(ctx.db, `UPDATE order_lines SET qty_loaded = ?, qty_issued = ?, qty_with_customer = ?, qty_in_vehicle = ?, qty_returned = ?, progress_key = ?, updated_at = ?,
      updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?`,
    loaded, l.issued, Math.max(0, l.issued - back(l)), Math.max(0, l.collected - l.received) + Math.max(0, loaded - l.issued), l.returned + l.received, progress,
    isoOf(ctx.now), ctx.rev, ctx.shopId, l.id);
  }
}

/** 이 rev가 건드린 행(change_log에 적을 것). */
export const touchedEntries = (ctx: WriteContext): ChangeEntry[] => ctx.touched;

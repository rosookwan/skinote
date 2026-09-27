// 접수 취소 · 품목 취소 ↔ 표(features-1 plan §5-2, data-model S8). 취소 한 건(FxCancellation)은 order_cancellations(구분 = reason_codes
// cancellation, 이름 = `접수 취소 · 연락 없음`, 돈의 결정 refund_decision_key) + 줄마다 order_cancellation_lines(수 · 값 · 그 값의 cancellation 조정)이고,
// 미수 결제(released)는 payment_reallocations + payment_allocations(묶였던 줄 · 칸에서 음수, 접수 전체에 양수). 청구 조정(cancellation −,
// cancellation_fee +)은 dispatch.ts writeCharges가 쓴다(취소 머리 → 조정 → 취소 줄 차례: FK).
// 되읽기: 취소 차례(rowid), 줄의 취소한 수 = 취소 줄의 합, 범위 · 구분은 이름에서(cancellation-words), 옮긴 돈은 reallocation id의 앞(`<취소 id>:r<k>`).
import { cancellationLabel, cancellationOfLabel, type FxCancellation, type FxLine, type FxOrder } from '@skinote/domain';
import { msOf } from '../ids.ts';
import { all, insert, num, one, str, text, type Db } from '../db.ts';
import { CANCELLATION_REASON, reasonId } from '../registry-keys.ts';
import { ensureCancellationKinds } from '../registry-write.ts';
import { appended, factMeta, unmapped, type WriteContext } from './common.ts';
import { isoOf } from '../ids.ts';

/** 이 명령이 더한 취소의 머리(order_cancellations). 조정 · 취소 줄보다 먼저(FK). */
export function insertCancellationHeads(ctx: WriteContext, prev: FxOrder | undefined, next: FxOrder): FxCancellation[] {
  const added = appended(prev?.cancellations, next.cancellations, '취소 ' + next.id);
  if (!added.length) return added;
  ensureCancellationKinds(ctx.db, ctx.shopId, isoOf(ctx.now));
  for (const c of added) {
    if (!c.lines.length || c.lines.some((x) => !(x.quantity >= 1) || !(x.amount >= 0))) unmapped('취소의 모양: ' + c.id);
    insert(ctx.db, 'order_cancellations', {
      shop_id: ctx.shopId, id: c.id, order_id: next.id, reason_code_id: reasonId(CANCELLATION_REASON, c.reasonKey), reason: cancellationLabel(c),
      refund_decision_key: c.decision, total_amount: c.lines.reduce((sum, x) => sum + x.amount, 0), ...factMeta(ctx, c.at),
    });
  }
  return added;
}

/** 취소 줄(order_cancellation_lines, 조정 뒤)과 미수 결제의 옮김(payment_reallocations · payment_allocations). */
export function insertCancellationLines(ctx: WriteContext, next: FxOrder, added: readonly FxCancellation[]): void {
  for (const c of added) {
    for (const x of c.lines) {
      const charge = (next.charges ?? []).find((k) => k.kind === 'cancellation' && k.cancellationId === c.id && k.lineId === x.lineId);
      if (x.amount > 0 && (!charge || -charge.amount !== x.amount)) unmapped('취소 줄의 조정이 없다: ' + c.id + ' ' + x.lineId);
      insert(ctx.db, 'order_cancellation_lines', {
        shop_id: ctx.shopId, cancellation_id: c.id, order_id: next.id, line_id: x.lineId, quantity: x.quantity, amount: x.amount, adjustment_id: x.amount > 0 ? charge!.id : undefined,
      });
    }
    (c.released ?? []).forEach((r, k) => insertReallocation(ctx, next, c, r, k));
  }
}

/** 미수 결제 한 건: 묶였던 자리(줄 또는 칸)에서 빼고 접수 전체에 둔다(payment_allocations, 음수는 옮김 안에서만). */
function insertReallocation(ctx: WriteContext, o: FxOrder, c: FxCancellation, r: NonNullable<FxCancellation['released']>[number], k: number): void {
  const share = o.payments.find((p) => p.id === r.paymentId) ?? unmapped('옮길 수납이 없다: ' + r.paymentId);
  if (!(r.amount > 0)) unmapped('옮길 돈이 0 이하: ' + c.id);
  const tender = share.groupId ?? share.id;
  const id = c.id + ':r' + k;
  const meta = factMeta(ctx, c.at);
  insert(ctx.db, 'payment_reallocations', { shop_id: ctx.shopId, id, payment_id: tender, reason: cancellationLabel(c), ...meta });
  let seq = num(one(ctx.db, 'SELECT max(seq) AS n FROM payment_allocations WHERE shop_id = ? AND payment_id = ?', ctx.shopId, tender)?.n);
  const base = {
    shop_id: ctx.shopId, payment_id: tender, order_id: o.id, reallocation_id: id, closing_scope_id: meta.closing_scope_id, business_date: meta.business_date,
    posting_date: meta.posting_date, actor_key: ctx.actor.key, request_id: ctx.requestId, created_rev: ctx.rev,
  };
  seq += 1;
  insert(ctx.db, 'payment_allocations', { ...base, seq, line_id: r.lineId, amount: -r.amount });
  if (r.lineId === undefined && share.section !== undefined) {
    insert(ctx.db, 'payment_allocation_sections', { shop_id: ctx.shopId, payment_id: tender, seq, payment_section_id: share.section, created_rev: ctx.rev });
  }
  seq += 1;
  insert(ctx.db, 'payment_allocations', { ...base, seq, amount: r.amount });
}

/** 되읽기: 접수마다 취소(차례대로) · 줄의 취소한 수 · 미수 결제의 옮김. */
export function loadCancellations(db: Db, shopId: string, byId: Map<string, FxOrder>, lineById: Map<string, FxLine>): void {
  const byCancel = new Map<string, FxCancellation>();
  for (const r of all(db, 'SELECT id, order_id, reason, refund_decision_key, occurred_at FROM order_cancellations WHERE shop_id = ? ORDER BY rowid', shopId)) {
    const o = byId.get(str(r.order_id));
    if (!o) continue;
    const c: FxCancellation = {
      id: str(r.id), at: msOf(str(r.occurred_at)), ...cancellationOfLabel(str(r.reason)), decision: str(r.refund_decision_key) as FxCancellation['decision'], lines: [],
    };
    o.cancellations = [...(o.cancellations ?? []), c];
    byCancel.set(c.id, c);
  }
  for (const r of all(db, 'SELECT cancellation_id, line_id, quantity, amount FROM order_cancellation_lines WHERE shop_id = ? ORDER BY rowid', shopId)) {
    const c = byCancel.get(str(r.cancellation_id));
    if (!c) continue;
    c.lines.push({ lineId: str(r.line_id), quantity: num(r.quantity), amount: num(r.amount) });
    const l = lineById.get(str(r.line_id));
    if (l) l.cancelled = (l.cancelled ?? 0) + num(r.quantity);
  }
  for (const r of all(db, `SELECT p.id, p.payment_id, a.order_id, a.line_id, a.amount FROM payment_reallocations p
      JOIN payment_allocations a ON a.shop_id = p.shop_id AND a.reallocation_id = p.id AND a.amount < 0 WHERE p.shop_id = ? ORDER BY p.rowid`, shopId)) {
    const id = str(r.id);
    const c = byCancel.get(id.slice(0, id.lastIndexOf(':r')));
    const o = byId.get(str(r.order_id));
    if (!c || !o) continue;
    const tender = str(r.payment_id);
    const share = o.payments.find((p) => (p.groupId ?? p.id) === tender);
    if (!share) continue;
    const lineId = text(r.line_id);
    c.released = [...(c.released ?? []), { paymentId: share.id, ...(lineId !== undefined ? { lineId } : {}), amount: -num(r.amount) }];
  }
}

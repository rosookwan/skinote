// 차량 현금 인계 · 점검과 마감 ↔ 표(plan §4-2 cash · closing, data-model 4-12 · 4-13).
//   - 인계(FxCashTransfer) = cash_transfers(차량 지갑 → 넘기는 중) + cash_movements 두 다리. 점검(confirmed) = cash_transfer_confirmations
//     (넘기는 중 → 카운터 돈통의 센 금액, 차액은 과부족 돈통) + cash_movements.
//   - 마감(FxClosing) = closings + closing_drawer_counts + closing_handover_items(이월한 봉투) + business_days.active_closing_id. 그때의
//     화면 줄 · 돈통 셈 · 이월은 report_json에 그대로 얼린다(되읽기는 이 글에서).
import type { FxCashTransfer, FxClosing, FxDrawer, ShopState } from '@skinote/domain';
import { canonicalJson, isoOf, msOf } from '../ids.ts';
import { all, insert, num, one, run, str, text, type Db } from '../db.ts';
import { ensureBusinessDay } from '../dates.ts';
import { HANDOVER, MAIN_SCOPE, reasonId } from '../registry-keys.ts';
import { appended, factMeta, unmapped, type WriteContext } from './common.ts';

const drawerOf = (drawers: readonly FxDrawer[], kind: FxDrawer['kind'], vehicleId?: string): string =>
  drawers.find((d) => d.kind === kind && (vehicleId === undefined || d.vehicleId === vehicleId))?.id ?? unmapped('돈통이 없다: ' + kind + (vehicleId ? ' ' + vehicleId : ''));

function cashLeg(ctx: WriteContext, meta: Record<string, unknown>, source: string, sourceId: string, leg: number, drawerId: string, amount: number): void {
  if (amount === 0) return;
  insert(ctx.db, 'cash_movements', {
    shop_id: ctx.shopId, id: source + ':' + sourceId + ':' + leg, cash_drawer_id: drawerId, closing_scope_id: MAIN_SCOPE, amount, source_kind_key: source, source_id: sourceId,
    leg_no: leg, business_date: meta.business_date as string, posting_date: meta.posting_date as string, occurred_at: meta.occurred_at as string, created_rev: ctx.rev,
  });
}

export function writeCash(ctx: WriteContext): void {
  const { before, after } = ctx;
  const drawers = after.drawers;
  if (after.cashTransfers.length < before.cashTransfers.length || before.cashTransfers.some((t, i) => after.cashTransfers[i]?.id !== t.id)) unmapped('인계의 차례가 바뀌었다');
  after.cashTransfers.forEach((t, i) => {
    const prev = before.cashTransfers[i];
    if (prev) {
      if (prev.vehicleId !== t.vehicleId || prev.amount !== t.amount || prev.at !== t.at) unmapped('인계의 칸이 바뀌었다: ' + t.id);
      if (prev.confirmed) {
        if (JSON.stringify(prev.confirmed) !== JSON.stringify(t.confirmed)) unmapped('점검한 인계가 바뀌었다: ' + t.id);
        return;
      }
    } else {
      if (!(t.amount > 0)) unmapped('인계 금액이 0 이하: ' + t.id);
      const van = drawerOf(drawers, 'vehicle', t.vehicleId);
      const counter = drawerOf(drawers, 'counter');
      const transit = drawerOf(drawers, 'transit');
      const meta = factMeta(ctx, t.at);
      insert(ctx.db, 'cash_transfers', { shop_id: ctx.shopId, id: t.id, from_drawer_id: van, to_drawer_id: counter, transit_drawer_id: transit, amount: t.amount, ...meta });
      cashLeg(ctx, meta, 'cash_transfer', t.id, 1, van, -t.amount);
      cashLeg(ctx, meta, 'cash_transfer', t.id, 2, transit, t.amount);
    }
    if (!t.confirmed) return;
    const c = t.confirmed;
    const diff = c.countedAmount - t.amount;
    const overShort = drawerOf(drawers, 'over_short');
    const meta = factMeta(ctx, c.at);
    insert(ctx.db, 'cash_transfer_confirmations', {
      shop_id: ctx.shopId, transfer_id: t.id, counted_amount: c.countedAmount, difference_amount: diff, over_short_drawer_id: diff !== 0 ? overShort : undefined,
      reason_code_id: c.reasonKey !== undefined ? reasonId(HANDOVER, c.reasonKey) : undefined, note: c.reasonNote, confirmed_at: meta.occurred_at, recorded_at: meta.recorded_at,
      closing_scope_id: meta.closing_scope_id, business_date: meta.business_date, posting_date: meta.posting_date, actor_key: meta.actor_key, actor_name: meta.actor_name,
      device_id: meta.device_id, request_id: meta.request_id, created_rev: meta.created_rev,
    });
    const transit = drawerOf(drawers, 'transit');
    cashLeg(ctx, meta, 'cash_transfer_confirmation', t.id, 1, transit, -t.amount);
    cashLeg(ctx, meta, 'cash_transfer_confirmation', t.id, 2, drawerOf(drawers, 'counter'), c.countedAmount);
    cashLeg(ctx, meta, 'cash_transfer_confirmation', t.id, 3, overShort, -diff);
  });

  for (const c of appended(before.closings, after.closings, '마감')) writeClosing(ctx, c, after);
}

function writeClosing(ctx: WriteContext, c: FxClosing, state: ShopState): void {
  const at = isoOf(ctx.now);
  ensureBusinessDay(ctx.db, ctx.shopId, c.date, at);
  const day = one(ctx.db, 'SELECT active_closing_id, last_version_no FROM business_days WHERE shop_id = ? AND closing_scope_id = ? AND business_date = ?', ctx.shopId, MAIN_SCOPE, c.date);
  if (text(day?.active_closing_id) !== undefined) unmapped('이미 마감한 날: ' + c.date);
  const version = num(day?.last_version_no) + 1;
  const id = 'closing:' + c.date + ':' + version;
  const expected = c.counts.reduce((sum, x) => sum + x.expected, 0);
  const counted = c.counts.reduce((sum, x) => sum + x.counted, 0);
  const previous = (drawerId: string) => one(ctx.db, `SELECT k.closing_id, k.counted_amount FROM closing_drawer_counts k JOIN closings c ON c.shop_id = k.shop_id AND c.id = k.closing_id
    WHERE k.shop_id = ? AND k.cash_drawer_id = ? ORDER BY c.business_date DESC, c.version_no DESC LIMIT 1`, ctx.shopId, drawerId);
  const counterPrev = previous(drawerOf(state.drawers, 'counter'));
  insert(ctx.db, 'closings', {
    shop_id: ctx.shopId, id, closing_scope_id: MAIN_SCOPE, business_date: c.date, version_no: version,
    opening_cash_amount: counterPrev ? num(counterPrev.counted_amount) : state.settings.openingCash, expected_cash_amount: expected, counted_cash_amount: counted,
    difference_amount: counted - expected, as_of_rev: ctx.rev, basis_json: '{}',
    report_json: canonicalJson({ schema: 1, counts: c.counts, deferredTransferIds: c.deferredTransferIds, ...(c.sheet ? { sheet: c.sheet } : {}) }), report_schema: 1,
    closed_at: isoOf(c.closedAt), actor_key: ctx.actor.key, actor_name: ctx.actor.name, device_id: ctx.actor.deviceId, request_id: ctx.requestId, created_rev: ctx.rev,
  });
  for (const k of c.counts) {
    const prev = previous(k.drawerId);
    insert(ctx.db, 'closing_drawer_counts', {
      shop_id: ctx.shopId, closing_id: id, cash_drawer_id: k.drawerId, prev_closing_id: prev ? str(prev.closing_id) : undefined,
      opening_amount: prev ? num(prev.counted_amount) : state.settings.openingCash, expected_amount: k.expected, counted_amount: k.counted,
      difference_amount: k.counted - k.expected, difference_reason: k.reasonNote,
    });
  }
  c.deferredTransferIds.forEach((subject, i) => insert(ctx.db, 'closing_handover_items', {
    shop_id: ctx.shopId, closing_id: id, seq: i + 1, subject_type_key: subject.startsWith('van:') ? 'cash_drawer' : 'cash_transfer', subject_id: subject,
    issue_key: 'unconfirmed_transfer', carried_forward: 1,
  }));
  run(ctx.db, `UPDATE business_days SET active_closing_id = ?, last_version_no = ?, updated_at = ?, updated_rev = ?, version = version + 1
    WHERE shop_id = ? AND closing_scope_id = ? AND business_date = ?`, id, version, at, ctx.rev, ctx.shopId, MAIN_SCOPE, c.date);
}

// ── 되읽기 ──────────────────────────────────────────────────────────

export function loadCash(db: Db, shopId: string): { cashTransfers: FxCashTransfer[]; closings: FxClosing[] } {
  const cashTransfers: FxCashTransfer[] = all(db, `SELECT t.id, d.vehicle_id, t.amount, t.occurred_at, c.counted_amount, c.reason_code_id, c.note, c.confirmed_at
      FROM cash_transfers t JOIN cash_drawers d ON d.shop_id = t.shop_id AND d.id = t.from_drawer_id
      LEFT JOIN cash_transfer_confirmations c ON c.shop_id = t.shop_id AND c.transfer_id = t.id WHERE t.shop_id = ? ORDER BY t.rowid`, shopId).map((r) => {
    const reason = text(r.reason_code_id);
    return {
      id: str(r.id), vehicleId: str(r.vehicle_id), amount: num(r.amount), at: msOf(str(r.occurred_at)),
      ...(text(r.confirmed_at) !== undefined ? {
        confirmed: {
          at: msOf(str(r.confirmed_at)), countedAmount: num(r.counted_amount),
          ...(reason !== undefined ? { reasonKey: reason.slice(reason.indexOf(':') + 1) } : {}),
          ...(text(r.note) !== undefined ? { reasonNote: str(r.note) } : {}),
        },
      } : {}),
    };
  });
  const closings: FxClosing[] = all(db, `SELECT c.business_date, c.closed_at, c.report_json FROM closings c JOIN business_days d ON d.shop_id = c.shop_id
      AND d.closing_scope_id = c.closing_scope_id AND d.business_date = c.business_date AND d.active_closing_id = c.id WHERE c.shop_id = ? ORDER BY c.rowid`, shopId).map((r) => {
    const report = JSON.parse(str(r.report_json)) as { counts: FxClosing['counts']; deferredTransferIds: string[]; sheet?: FxClosing['sheet'] };
    return {
      date: str(r.business_date), closedAt: msOf(str(r.closed_at)), counts: report.counts, deferredTransferIds: report.deferredTransferIds,
      ...(report.sheet ? { sheet: report.sheet } : {}),
    };
  });
  return { cashTransfers, closings };
}

// 돈 · 보증금 ↔ 표(plan §4-2 Stock, money: ADR-09 · ADR-18). 실제 돈 한 건(FxPaymentGroup)은 payment_groups + payments 한 행이고,
// 팀마다의 몫(각 접수의 FxPayment)은 payment_allocations(줄 · 수량, 또는 결제 칸 — 0002 payment_allocation_sections — 또는 접수 전체)다. 현금은
// cash_movements(마감이 현금을 읽는 곳)에도 적는다.
//   - 결제 자리 없이 적힌 몫(견본 하루의 옛 수납)은 결제 자리 없는 payments 한 행과 그 몫이다.
//   - 보증금 결제(미수 차감, methodKey 'deposit')는 명령마다 deposit_apply 한 행(돈이 움직이지 않음)과 그 몫이고, 그 명령의 보증금
//     장부 apply 줄이 이 행을 가리킨다.
//   - 보증금(FxDeposit)은 deposits, 장부 줄(FxDepositEntry)은 deposit_entries(번호마다 한 행, 번호 없는 나머지는 한 행)이다. 입금 ·
//     반환 · 몰수 · 몰수 취소는 줄마다 자기 돈 행(deposit_in · deposit_out · deposit_forfeit · deposit_restore, id = 장부 줄 id)이다.
// 되읽기: 몫의 id는 결제 자리 id + ':' + 차례(접수 확정의 칸별 결제는 결제 자리 id 그대로 — 요청번호와 id가 다른 결제 자리), 몫의 차례는
// 행을 넣은 차례.
import { resolveTask, type FxDeposit, type FxDepositEntry, type FxMethodKey, type FxOrder, type FxPayment, type FxPaymentGroup } from '@skinote/domain';
import { isoOf, msOf } from '../ids.ts';
import { all, insert, num, one, str, text, type Db, type InValue } from '../db.ts';
import { DEPOSIT_METHOD } from '../registry-keys.ts';
import { appended, bumpCounter, factMeta, unmapped, type WriteContext } from './common.ts';

const PAYMENT_KINDS = {
  payment: { requires_refund_of: 0, requires_deposit: 0, cash_sign: 1 },
  deposit_in: { requires_refund_of: 0, requires_deposit: 1, cash_sign: 1 },
  deposit_out: { requires_refund_of: 0, requires_deposit: 1, cash_sign: -1 },
  deposit_apply: { requires_refund_of: 0, requires_deposit: 1, cash_sign: 0 },
  deposit_forfeit: { requires_refund_of: 0, requires_deposit: 1, cash_sign: 0 },
  deposit_restore: { requires_refund_of: 0, requires_deposit: 1, cash_sign: 0 },
} as const;
type PaymentKind = keyof typeof PAYMENT_KINDS;

const ENTRY_PAYMENT: Record<FxDepositEntry['kind'], PaymentKind> = {
  take: 'deposit_in', refund: 'deposit_out', apply: 'deposit_apply', keep: 'deposit_forfeit', restore: 'deposit_restore',
};

const affectsCash = (db: Db, shopId: string, methodId: string): boolean => {
  const row = one(db, 'SELECT affects_cash_drawer FROM payment_methods WHERE shop_id = ? AND id = ?', shopId, methodId);
  if (!row) unmapped('모르는 결제 수단: ' + methodId);
  return num(row.affects_cash_drawer) === 1;
};

interface PaymentRow {
  id: string;
  kind: PaymentKind;
  groupId?: string;
  methodId: string;
  amount: number;
  drawerId?: string;
  at: number;
  depositId?: string;
  payerOrderId?: string;
  vehicleId?: string;
  purpose?: 'charge' | 'prepayment' | 'deposit';
}

/** 돈 한 행(payments) + 현금이면 cash_movements. */
function insertPayment(ctx: WriteContext, p: PaymentRow): void {
  if (!(p.amount > 0)) unmapped('돈 행의 금액이 0 이하: ' + p.id);
  const flags = PAYMENT_KINDS[p.kind];
  const cash = affectsCash(ctx.db, ctx.shopId, p.methodId);
  const needsDrawer = cash && flags.cash_sign !== 0;
  if (needsDrawer !== (p.drawerId !== undefined)) unmapped('현금 돈통이 수단과 맞지 않는다: ' + p.id);
  const meta = factMeta(ctx, p.at);
  insert(ctx.db, 'payments', {
    shop_id: ctx.shopId, id: p.id, payment_group_id: p.groupId, kind_key: p.kind, kind_requires_refund_of: flags.requires_refund_of, kind_requires_deposit: flags.requires_deposit,
    kind_cash_sign: flags.cash_sign, purpose_key: p.purpose ?? (p.kind === 'payment' ? 'charge' : 'deposit'), method_id: p.methodId, method_affects_cash: cash,
    amount: p.amount, cash_drawer_id: p.drawerId, deposit_id: p.depositId, payer_order_id: p.payerOrderId, collected_by_vehicle_id: p.vehicleId, ...meta,
  });
  if (needsDrawer) {
    insert(ctx.db, 'cash_movements', {
      shop_id: ctx.shopId, id: 'payment:' + p.id + ':1', cash_drawer_id: p.drawerId!, closing_scope_id: meta.closing_scope_id, amount: flags.cash_sign * p.amount,
      source_kind_key: 'payment', source_id: p.id, leg_no: 1, business_date: meta.business_date, posting_date: meta.posting_date, occurred_at: meta.occurred_at,
      created_rev: ctx.rev,
    });
  }
}

/** 몫 하나의 배분 행들(줄 · 수량, 또는 결제 칸, 또는 접수 전체). seq는 돈 행 안의 차례. */
function insertAllocations(ctx: WriteContext, paymentId: string, orderId: string, share: FxPayment, seq: { n: number }, at: number): void {
  const meta = factMeta(ctx, at);
  const base: Record<string, InValue> = {
    shop_id: ctx.shopId, payment_id: paymentId, order_id: orderId, closing_scope_id: meta.closing_scope_id, business_date: meta.business_date,
    posting_date: meta.posting_date, actor_key: ctx.actor.key, request_id: ctx.requestId, created_rev: ctx.rev,
  };
  if (share.lines?.length) {
    if (share.section !== undefined) unmapped('줄과 결제 칸을 함께 가진 몫');
    let total = 0;
    for (const x of share.lines) {
      if (!(x.amount > 0)) unmapped('금액 없는 줄 배분: ' + share.id);
      if (x.quantity < 0) unmapped('수량이 음수인 줄 배분: ' + share.id);
      insert(ctx.db, 'payment_allocations', { ...base, seq: (seq.n += 1), line_id: x.lineId, amount: x.amount, allocated_quantity: x.quantity > 0 ? x.quantity : undefined });
      total += x.amount;
    }
    if (total !== share.amount) unmapped('줄 배분의 합이 몫과 다르다: ' + share.id);
  } else {
    if (share.lines !== undefined) unmapped('빈 줄 배분 목록: ' + share.id);
    const n = (seq.n += 1);
    insert(ctx.db, 'payment_allocations', { ...base, seq: n, amount: share.amount });
    if (share.section !== undefined) {
      insert(ctx.db, 'payment_allocation_sections', { shop_id: ctx.shopId, payment_id: paymentId, seq: n, payment_section_id: share.section, created_rev: ctx.rev });
    }
  }
}

/** 몫 id의 차례(결제 자리 id + ':' + 차례). 결제 자리 id 그대로면 0. */
function shareIndex(groupId: string, share: FxPayment): number {
  if (share.id === groupId) return 0;
  const tail = share.id.startsWith(groupId + ':') ? share.id.slice(groupId.length + 1) : '';
  if (!/^\d+$/.test(tail)) unmapped('몫 id가 결제 자리 id의 차례가 아니다: ' + share.id);
  return Number(tail);
}

/** 이 명령이 더한 돈(결제 자리 · 몫 · 결제 자리 없는 몫 · 보증금 결제)과 보증금 장부. */
export function writeMoney(ctx: WriteContext, prevOrder: (id: string) => FxOrder | undefined): void {
  const { before, after } = ctx;
  const newGroups = appended(before.paymentGroups, after.paymentGroups, '결제 자리');
  // 접수마다 새 몫.
  const newShares: { order: FxOrder; share: FxPayment }[] = [];
  for (const o of after.orders) {
    for (const share of appended(prevOrder(o.id)?.payments, o.payments, '수납 ' + o.id)) newShares.push({ order: o, share });
  }
  const used = new Set<FxPayment>();
  for (const g of newGroups) {
    const shares = newShares.filter((x) => x.share.groupId === g.id).sort((a, b) => shareIndex(g.id, a.share) - shareIndex(g.id, b.share));
    if (!shares.length) unmapped('몫 없는 결제 자리: ' + g.id);
    shares.forEach((x, k) => {
      if (shareIndex(g.id, x.share) !== k || (k === 0 && x.share.id === g.id && shares.length > 1)) unmapped('몫의 차례가 비었다: ' + x.share.id);
      if (x.share.methodKey !== g.methodKey || x.share.at !== g.at || x.share.drawerId !== g.drawerId) unmapped('몫과 결제 자리의 수단 · 시각 · 돈통이 다르다: ' + x.share.id);
      used.add(x.share);
    });
    const total = shares.reduce((sum, x) => sum + x.share.amount, 0);
    if (total !== g.amount) unmapped('몫의 합이 결제 자리 금액과 다르다: ' + g.id);
    insert(ctx.db, 'payment_groups', {
      shop_id: ctx.shopId, id: g.id, group_no: String(bumpCounter(ctx.db, ctx.shopId, 'payment_group')), purpose_key: g.purpose, occurred_at: isoOf(g.at),
      actor_key: ctx.actor.key, actor_name: ctx.actor.name, device_id: ctx.actor.deviceId, request_id: ctx.requestId, created_rev: ctx.rev,
    });
    const vehicleId = g.purpose === 'driver_field' ? after.drawers.find((d) => d.id === g.drawerId)?.vehicleId ?? taskVehicleOf(ctx) : undefined;
    // 되읽기의 몫 id 규칙과 맞는지: 요청번호와 id가 다른 결제 자리(접수 확정의 칸별 결제)는 몫 하나이고 id가 같다.
    if (g.id !== ctx.requestId && (shares.length !== 1 || shares[0]!.share.id !== g.id)) unmapped('결제 자리 id와 몫 id의 모양이 다르다: ' + g.id);
    if (g.id === ctx.requestId && shares.some((x) => x.share.id === g.id)) unmapped('결제 자리 id와 몫 id의 모양이 다르다: ' + g.id);
    insertPayment(ctx, {
      id: g.id, kind: 'payment', groupId: g.id, methodId: g.methodKey, amount: g.amount, ...(g.drawerId ? { drawerId: g.drawerId } : {}), at: g.at,
      ...(g.payerOrderId ? { payerOrderId: g.payerOrderId } : {}), ...(vehicleId ? { vehicleId } : {}),
    });
    const seq = { n: 0 };
    for (const x of shares) insertAllocations(ctx, g.id, x.order.id, x.share, seq, g.at);
  }
  for (const x of newShares) {
    if (used.has(x.share)) continue;
    if (x.share.groupId !== undefined) unmapped('결제 자리가 없는 몫: ' + x.share.id);
    if (x.share.methodKey === DEPOSIT_METHOD) continue; // 보증금 결제는 보증금 장부와 함께(writeDeposits).
    insertPayment(ctx, {
      id: x.share.id, kind: 'payment', methodId: x.share.methodKey, amount: x.share.amount, ...(x.share.drawerId ? { drawerId: x.share.drawerId } : {}), at: x.share.at,
    });
    insertAllocations(ctx, x.share.id, x.order.id, x.share, { n: 0 }, x.share.at);
  }
  writeDeposits(ctx, newShares.filter((x) => !used.has(x.share) && x.share.methodKey === DEPOSIT_METHOD));
}

/** 현장 수납의 차량(돈통이 현금이 아니면 봉투의 업무 차량). */
function taskVehicleOf(ctx: WriteContext): string | undefined {
  const p = ctx.envelope?.payload as { taskId?: unknown } | undefined;
  if (typeof p?.taskId !== 'string') return undefined;
  return resolveTask(ctx.before, p.taskId)?.promise.vehicleId;
}

function writeDeposits(ctx: WriteContext, applies: { order: FxOrder; share: FxPayment }[]): void {
  const { before, after } = ctx;
  const prevDeposits = new Map(before.deposits.map((d) => [d.id, d]));
  if (after.deposits.length < before.deposits.length || before.deposits.some((d, i) => after.deposits[i]?.id !== d.id)) unmapped('보증금 보관의 차례가 바뀌었다');
  const pendingApplies = new Map(applies.map((x) => [x.share.id, x]));
  for (const d of after.deposits) {
    const prev = prevDeposits.get(d.id);
    if (prev && (prev.orderId !== d.orderId || prev.ruleKey !== d.ruleKey || prev.label !== d.label || prev.unitAmount !== d.unitAmount)) unmapped('보증금 보관의 칸이 바뀌었다: ' + d.id);
    const entries = appended(prev?.entries, d.entries, '보증금 장부 ' + d.id);
    if (!entries.length && prev) continue;
    if (!prev) insertDeposit(ctx, d);
    let seq = num(one(ctx.db, 'SELECT max(seq) AS n FROM deposit_entries WHERE shop_id = ? AND deposit_id = ?', ctx.shopId, d.id)?.n);
    for (const e of entries) {
      const paymentKind = ENTRY_PAYMENT[e.kind];
      let paymentId: string;
      if (e.kind === 'apply') {
        paymentId = e.id.slice(0, e.id.lastIndexOf(':'));
        const apply = pendingApplies.get(paymentId);
        if (apply) {
          pendingApplies.delete(paymentId);
          insertPayment(ctx, { id: paymentId, kind: 'deposit_apply', methodId: DEPOSIT_METHOD, amount: apply.share.amount, at: apply.share.at, depositId: d.id });
          insertAllocations(ctx, paymentId, apply.order.id, apply.share, { n: 0 }, apply.share.at);
        } else if (!one(ctx.db, "SELECT 1 AS x FROM payments WHERE shop_id = ? AND id = ? AND kind_key = 'deposit_apply'", ctx.shopId, paymentId)) {
          unmapped('보증금 결제 행이 없는 미수 차감: ' + e.id);
        }
      } else {
        paymentId = e.id;
        insertPayment(ctx, {
          id: e.id, kind: paymentKind, methodId: e.methodKey ?? DEPOSIT_METHOD, amount: e.amount, ...(e.drawerId ? { drawerId: e.drawerId } : {}), at: e.at, depositId: d.id,
        });
      }
      const meta = factMeta(ctx, e.at);
      const assets = e.assetIds ?? [];
      if (assets.length > e.quantity) unmapped('보증금 번호가 매수보다 많다: ' + e.id);
      const rows: { asset?: string; quantity: number }[] = assets.map((a) => ({ asset: a, quantity: 1 }));
      if (e.quantity > assets.length) rows.push({ quantity: e.quantity - assets.length });
      if (!rows.length) unmapped('매수 없는 보증금 줄: ' + e.id);
      let left = e.amount;
      rows.forEach((r, i) => {
        const amount = i === rows.length - 1 ? left : Math.floor((e.amount * r.quantity) / e.quantity);
        left -= amount;
        if (!(amount > 0)) unmapped('보증금 줄의 금액이 0 이하: ' + e.id);
        insert(ctx.db, 'deposit_entries', {
          shop_id: ctx.shopId, deposit_id: d.id, seq: (seq += 1), order_id: d.orderId, line_id: e.lineId, asset_id: r.asset, entry_kind_key: e.kind, payment_kind_key: paymentKind,
          quantity: r.quantity, amount, payment_id: paymentId, ...meta,
        });
      });
    }
  }
  if (pendingApplies.size) unmapped('보증금 장부 없는 보증금 결제: ' + [...pendingApplies.keys()].join(', '));
}

function insertDeposit(ctx: WriteContext, d: FxDeposit): void {
  const rule = [ctx.after.settings.liftDeposit, ctx.after.settings.liftDepositOff].find((r) => r?.key === d.ruleKey) ?? undefined;
  insert(ctx.db, 'deposits', {
    shop_id: ctx.shopId, id: d.id, order_id: d.orderId, deposit_rule_id: d.ruleKey, label: d.label, unit_amount: d.unitAmount,
    refund_default_key: rule?.refundDefault, unreturned_key: rule?.unreturned, unreturned_after_days: rule?.afterDays ?? undefined, loss_amount: rule?.lossAmount,
    created_at: isoOf(ctx.now), created_by: ctx.actor.key, request_id: ctx.requestId, updated_rev: ctx.rev,
  });
}

// ── 되읽기 ──────────────────────────────────────────────────────────

/** 결제 자리 · 접수마다의 몫 · 보증금. */
export function loadMoney(db: Db, shopId: string, byId: Map<string, FxOrder>): { paymentGroups: FxPaymentGroup[]; deposits: FxDeposit[] } {
  const payments = all(db, `SELECT p.id, p.payment_group_id, p.kind_key, p.method_id, p.amount, p.cash_drawer_id, p.payer_order_id, p.occurred_at, p.request_id,
      g.purpose_key AS group_purpose FROM payments p LEFT JOIN payment_groups g ON g.shop_id = p.shop_id AND g.id = p.payment_group_id
      WHERE p.shop_id = ? ORDER BY p.rowid`, shopId);
  const allocations = new Map<string, { order_id: string; line_id?: string; amount: number; quantity?: number; section?: string; seq: number }[]>();
  for (const r of all(db, `SELECT a.payment_id, a.seq, a.order_id, a.line_id, a.amount, a.allocated_quantity, s.payment_section_id FROM payment_allocations a
      LEFT JOIN payment_allocation_sections s ON s.shop_id = a.shop_id AND s.payment_id = a.payment_id AND s.seq = a.seq
      WHERE a.shop_id = ? ORDER BY a.payment_id, a.seq`, shopId)) {
    const list = allocations.get(str(r.payment_id)) ?? [];
    list.push({
      order_id: str(r.order_id), ...(text(r.line_id) !== undefined ? { line_id: str(r.line_id) } : {}), amount: num(r.amount),
      ...(r.allocated_quantity !== null ? { quantity: num(r.allocated_quantity) } : {}), ...(text(r.payment_section_id) !== undefined ? { section: str(r.payment_section_id) } : {}),
      seq: num(r.seq),
    });
    allocations.set(str(r.payment_id), list);
  }
  const paymentGroups: FxPaymentGroup[] = [];
  const depositMoney = new Map<string, { method: string; drawer?: string; at: number }>();
  for (const p of payments) {
    const id = str(p.id);
    const kind = str(p.kind_key);
    const at = msOf(str(p.occurred_at));
    const method = str(p.method_id);
    const drawer = text(p.cash_drawer_id);
    if (kind !== 'payment' && kind !== 'deposit_apply') {
      depositMoney.set(id, { method, ...(drawer !== undefined ? { drawer } : {}), at });
      continue;
    }
    const groupId = text(p.payment_group_id);
    if (groupId !== undefined) {
      paymentGroups.push({
        id: groupId, purpose: str(p.group_purpose) as FxPaymentGroup['purpose'], amount: num(p.amount), methodKey: method as FxMethodKey, at,
        ...(drawer !== undefined ? { drawerId: drawer } : {}), ...(text(p.payer_order_id) !== undefined ? { payerOrderId: str(p.payer_order_id) } : {}),
      });
    }
    // 몫: 배분 행을 접수로 묶는다(한 결제 자리에 접수마다 몫 하나, 차례는 첫 배분 행).
    const shares: { orderId: string; rows: NonNullable<ReturnType<typeof allocations.get>> }[] = [];
    for (const a of allocations.get(id) ?? []) {
      let s = shares.find((x) => x.orderId === a.order_id);
      if (!s) {
        s = { orderId: a.order_id, rows: [] };
        shares.push(s);
      }
      s.rows.push(a);
    }
    const bare = groupId !== undefined && id !== str(p.request_id);
    shares.forEach((s, k) => {
      const o = byId.get(s.orderId);
      if (!o) return;
      const lines = s.rows.filter((r) => r.line_id !== undefined);
      const section = s.rows.length === 1 && s.rows[0]!.line_id === undefined ? s.rows[0]!.section : undefined;
      const share: FxPayment = {
        id: groupId === undefined || bare ? id : id + ':' + k,
        amount: s.rows.reduce((sum, r) => sum + r.amount, 0),
        methodKey: method as FxPayment['methodKey'],
        at,
        ...(section !== undefined ? { section: section as NonNullable<FxPayment['section']> } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
        ...(drawer !== undefined ? { drawerId: drawer } : {}),
        ...(lines.length ? { lines: lines.map((r) => ({ lineId: r.line_id!, quantity: r.quantity ?? 0, amount: r.amount })) } : {}),
      };
      o.payments.push(share);
    });
  }
  // 보증금: 보관마다 장부 줄을 (돈 행, 줄)로 묶는다.
  const deposits: FxDeposit[] = [];
  const depositById = new Map<string, FxDeposit>();
  for (const r of all(db, 'SELECT id, order_id, deposit_rule_id, label, unit_amount FROM deposits WHERE shop_id = ? ORDER BY rowid', shopId)) {
    const d: FxDeposit = { id: str(r.id), orderId: str(r.order_id), ruleKey: text(r.deposit_rule_id) ?? '', label: text(r.label) ?? '', unitAmount: num(r.unit_amount), entries: [] };
    deposits.push(d);
    depositById.set(d.id, d);
  }
  const applyIndex = new Map<string, string[]>();
  let last: { d: FxDeposit; payment: string; line: string; entry: FxDepositEntry } | undefined;
  for (const r of all(db, 'SELECT deposit_id, seq, line_id, asset_id, entry_kind_key, quantity, amount, payment_id, occurred_at FROM deposit_entries WHERE shop_id = ? ORDER BY deposit_id, seq', shopId)) {
    const d = depositById.get(str(r.deposit_id));
    if (!d) continue;
    const payment = str(r.payment_id);
    const line = text(r.line_id) ?? '';
    const asset = text(r.asset_id);
    if (last && last.d === d && last.payment === payment && last.line === line) {
      last.entry.quantity += num(r.quantity);
      last.entry.amount += num(r.amount);
      if (asset) last.entry.assetIds = [...(last.entry.assetIds ?? []), asset];
      continue;
    }
    const kind = str(r.entry_kind_key) as FxDepositEntry['kind'];
    let id = payment;
    if (kind === 'apply') {
      const lines = applyIndex.get(payment) ?? [];
      id = payment + ':' + lines.length;
      lines.push(line);
      applyIndex.set(payment, lines);
    }
    const money = depositMoney.get(payment);
    const entry: FxDepositEntry = {
      id, kind, lineId: line, quantity: num(r.quantity), ...(asset ? { assetIds: [asset] } : {}), amount: num(r.amount),
      ...(money && money.method !== DEPOSIT_METHOD ? { methodKey: money.method as FxMethodKey } : {}),
      ...(money?.drawer !== undefined ? { drawerId: money.drawer } : {}),
      at: msOf(str(r.occurred_at)),
    };
    d.entries.push(entry);
    last = { d, payment, line, entry };
  }
  // 보관의 장부 줄은 넣은 차례(seq)다. 보관들의 차례는 만든 차례.
  return { paymentGroups, deposits };
}

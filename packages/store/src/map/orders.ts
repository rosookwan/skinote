// 접수 · 줄 · 약속 · 결제 약속 · 할인 ↔ 표(plan §4-2 Orders). 접수 행은 orders · order_batches(차수) · order_lines(값은 만들 때 얼린다),
// 약속은 line_promises(줄마다 수령 · 반납, 나눈 반납 일정은 schedule_id — 0002), 결제 팀 · 받을 때는 payment_promises, 할인은
// discount_applications. 약속 · 결제 약속은 고치지 않고 이전 행을 끝내고(superseded) 새 행을 넣는다.
// 되읽기: 수령 일정 = 그 접수의 가장 늦은 수령 행, 원래 반납 일정 = 가장 늦은 schedule_id 없는 반납 행(끝난 것이어도 — 모든 수량을 다른
// 일정으로 옮기면 살아 있는 행이 없다), 나눈 일정 = 살아 있는 schedule 행(만든 때는 그 일정 사슬의 첫 행).
import { liveQty, returnQty, type FxDiscountApplication, type FxLine, type FxOrder, type FxPromise, type FxPromiseSplit, type ShopRegistry } from '@skinote/domain';
import { isoOf, msOf } from '../ids.ts';
import { all, insert, num, one, run, str, text, type Db, type Row } from '../db.ts';
import { variantId } from '../registry-keys.ts';
import { ensureGroupKind } from '../registry-write.ts';
import { businessDateOfCtx, configRevOf, idMaker, localDate, localTime, msOfLocal, unmapped, type WriteContext } from './common.ts';

type Ids = ReturnType<typeof idMaker>;

/** 줄의 약속 한 행이 가질 값(key = 줄 | 종류 | 일정). */
interface PromiseWant {
  lineId: string;
  type: 'pickup' | 'return';
  schedule: string | null;
  quantity: number;
  promise: FxPromise;
  /** 나눈 일정의 만든 때(사슬의 첫 행 created_at). */
  splitAt?: number;
}

const promiseKey = (lineId: string, type: string, schedule: string | null) => lineId + '|' + type + '|' + (schedule ?? '');

/**
 * 접수 상태에서 줄마다 있어야 할 약속 행: 수령(살아 있는 수), 원래 반납(반납 쪽의 수 − 나눈 일정), 나눈 반납 일정들. 취소하면 수가 줄어 새 행이
 * 대신하고, 0이면 끝내기만 한다(features-1 §5-2).
 */
export function wantedPromises(o: FxOrder): Map<string, PromiseWant> {
  const out = new Map<string, PromiseWant>();
  for (const l of o.lines) {
    out.set(promiseKey(l.id, 'pickup', null), { lineId: l.id, type: 'pickup', schedule: null, quantity: liveQty(l), promise: o.pickup });
    const splits = (o.splits ?? []).filter((s) => s.lineId === l.id);
    const moved = splits.reduce((sum, s) => sum + s.quantity, 0);
    out.set(promiseKey(l.id, 'return', null), { lineId: l.id, type: 'return', schedule: null, quantity: returnQty(l) - moved, promise: o.giveBack });
    for (const s of splits) {
      out.set(promiseKey(l.id, 'return', s.id), { lineId: l.id, type: 'return', schedule: s.id, quantity: s.quantity, promise: s.promise, splitAt: s.at });
    }
  }
  return out;
}

const samePromiseRow = (a: PromiseWant | undefined, b: PromiseWant | undefined) =>
  a !== undefined && b !== undefined && a.quantity === b.quantity && JSON.stringify(promiseCols(a.promise)) === JSON.stringify(promiseCols(b.promise));

function promiseCols(p: FxPromise) {
  return { at: p.at, mode: p.mode, placeId: p.placeId ?? null, vehicleId: p.vehicleId ?? null, note: p.note ?? null };
}

const methodOf = (type: 'pickup' | 'return', mode: FxPromise['mode']) =>
  type === 'pickup' ? (mode === 'vehicle' ? 'vehicle_delivery' : 'shop_counter') : (mode === 'vehicle' ? 'vehicle_collection' : 'shop_direct');

function placeSnapshot(reg: ShopRegistry, placeId: string | undefined): { area_name?: string; place_name?: string } {
  if (!placeId) return {};
  for (const a of reg.areas) {
    const p = a.places.find((x) => x.id === placeId);
    if (p) return { area_name: a.label, place_name: p.label };
  }
  return {};
}

/** 살아 있는 약속 행(줄 · 종류 · 일정마다 하나). */
function activePromise(db: Db, shopId: string, orderId: string, w: { lineId: string; type: string; schedule: string | null }): Row | undefined {
  return one(db, `SELECT id FROM line_promises WHERE shop_id = ? AND order_id = ? AND line_id = ? AND promise_type_key = ? AND schedule_id IS ?
    AND status_key = 'active'`, shopId, orderId, w.lineId, w.type, w.schedule);
}

function insertPromise(ctx: WriteContext, ids: Ids, orderId: string, w: PromiseWant, supersedes: string | undefined): string {
  const id = ids('lp');
  const p = w.promise;
  insert(ctx.db, 'line_promises', {
    shop_id: ctx.shopId, id, order_id: orderId, line_id: w.lineId, promise_type_key: w.type, method_key: methodOf(w.type, p.mode), quantity: w.quantity,
    promised_date: localDate(p.at), promised_time: localTime(p.at), place_id: p.placeId, ...placeSnapshot(ctx.after.registry, p.placeId), vehicle_id: p.vehicleId,
    config_rev: configRevOf(ctx), status_key: 'active', supersedes_promise_id: supersedes, reason: p.note,
    created_at: isoOf(w.splitAt !== undefined && supersedes === undefined ? w.splitAt : ctx.now), created_by: ctx.actor.key, request_id: ctx.requestId,
    created_rev: ctx.rev, schedule_id: w.schedule ?? undefined,
  });
  return id;
}

/** 약속 행을 바뀐 대로: 달라진 행은 끝내고(superseded) 새 행을 넣는다. 원래 반납 몫이 0이면 새 행 없이 끝내기만 한다. */
export function syncPromises(ctx: WriteContext, ids: Ids, prev: FxOrder | undefined, next: FxOrder): void {
  const before = prev ? wantedPromises(prev) : new Map<string, PromiseWant>();
  const after = wantedPromises(next);
  const at = isoOf(ctx.now);
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(key);
    const a = after.get(key);
    if (samePromiseRow(b, a)) continue;
    if (b && a && b.quantity <= 0 && a.quantity <= 0) {
      if (JSON.stringify(promiseCols(b.promise)) !== JSON.stringify(promiseCols(a.promise))) unmapped('모든 수량을 옮긴 원래 반납 일정의 시각 바꿈');
      continue;
    }
    const w = (a ?? b)!;
    const active = activePromise(ctx.db, ctx.shopId, next.id, w);
    if (active) {
      run(ctx.db, "UPDATE line_promises SET status_key = 'superseded', ended_at = ?, updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?",
        at, ctx.rev, ctx.shopId, str(active.id));
    }
    if (a && a.quantity >= 1) insertPromise(ctx, ids, next.id, a, b && b.quantity >= 1 && active ? str(active.id) : undefined);
    if (a && a.quantity < 0) unmapped('약속 수량이 음수');
  }
}

// ── 결제 약속(결제 팀 · 받을 때) ─────────────────────────────────────

interface PayWant {
  lineId: string | null;
  timing: string;
  payer: string | null;
}

function wantedPayments(o: FxOrder): Map<string, PayWant> {
  const out = new Map<string, PayWant>();
  out.set('', { lineId: null, timing: o.payWhen === 'pickup' ? 'at_issue' : 'at_return', payer: o.payerOrderId ?? null });
  for (const l of o.lines) if (l.payerOrderId !== undefined) out.set(l.id, { lineId: l.id, timing: 'by_other_order', payer: l.payerOrderId });
  return out;
}

export function syncPaymentPromises(ctx: WriteContext, ids: Ids, prev: FxOrder | undefined, next: FxOrder): void {
  const before = prev ? wantedPayments(prev) : new Map<string, PayWant>();
  const after = wantedPayments(next);
  const at = isoOf(ctx.now);
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(key);
    const a = after.get(key);
    if (b && a && b.timing === a.timing && b.payer === a.payer) continue;
    const active = one(ctx.db, "SELECT id FROM payment_promises WHERE shop_id = ? AND order_id = ? AND line_id IS ? AND status_key = 'open'", ctx.shopId, next.id, key || null);
    if (active) {
      run(ctx.db, "UPDATE payment_promises SET status_key = 'superseded', ended_at = ?, updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?",
        at, ctx.rev, ctx.shopId, str(active.id));
    }
    if (a) {
      insert(ctx.db, 'payment_promises', {
        shop_id: ctx.shopId, id: ids('pp'), order_id: next.id, line_id: a.lineId ?? undefined, purpose_key: 'charge', timing_key: a.timing,
        payer_order_id: a.payer ?? undefined, status_key: 'open', supersedes_promise_id: active ? str(active.id) : undefined,
        created_at: at, created_by: ctx.actor.key, request_id: ctx.requestId, created_rev: ctx.rev,
      });
    }
  }
}

// ── 접수 · 줄 넣기 ──────────────────────────────────────────────────

const batchIdOf = (orderId: string, seq: number) => orderId + ':b' + seq;

function productOf(reg: ShopRegistry, key: string) {
  return reg.products[key] ?? unmapped('목록에 없는 상품의 줄: ' + key);
}

/**
 * 줄 한 행(값은 얼린다: order_lines_frozen). 수 셈은 이동(stock.ts)이 투영으로 적는다. 접수 때 할인을 받은 줄은 할인 앞 값(gross_amount)과 몫
 * (discount_amount)을 적고, 값의 구성(line_price_components)은 기본 값 + 할인 몫(그 칸의 할인 적용, features-1 §6-3) — 합 = net_amount.
 */
export function insertLine(ctx: WriteContext, o: FxOrder, l: FxLine, batchId: string, createdAt: number): void {
  const reg = ctx.after.registry;
  const product = productOf(reg, l.kind);
  if (l.productKey !== undefined && l.productKey !== l.kind) unmapped('줄의 상품 key가 종류와 다르다: ' + l.id);
  if (!(l.qty >= 1)) unmapped('수량 없는 줄: ' + l.id);
  if (!(l.amount >= 0)) unmapped('값이 음수인 줄: ' + l.id);
  const gross = l.gross ?? l.amount;
  if (!(gross >= l.amount) || (l.gross !== undefined && l.gross === l.amount)) unmapped('할인 앞 값이 맞지 않는 줄: ' + l.id);
  const start = businessDateOfCtx(ctx, o.pickup.at);
  const endRaw = businessDateOfCtx(ctx, o.giveBack.at);
  const end = endRaw < start ? start : endRaw;
  // 1일 값이 있는 장비 줄(연장 · 취소의 연장 몫이 쓴다, domain extension.ts)은 per_day: 단가 = 1일 값, 청구 날 = 수령 ~ 반납. 없으면 정액(옛 줄 · 권).
  const perDay = l.dayPrice !== undefined
    ? { price_basis_key: 'per_day', billable_units: Math.max(1, Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86_400_000) + 1), unit_price: l.dayPrice }
    : { price_basis_key: 'flat', billable_units: 1, unit_price: gross };
  insert(ctx.db, 'order_lines', {
    shop_id: ctx.shopId, id: l.id, order_id: o.id, batch_id: batchId, catalog_item_id: l.kind,
    variant_id: l.variantKey !== undefined ? variantId(l.kind, l.variantKey) : undefined, item_kind_id: product.kindKey,
    fulfillment_mode_key: product.unit !== undefined ? 'ticket' : 'rental', tracking_key: l.tracking ?? 'unit',
    return_policy_key: l.returnable ? 'required' : product.unit !== undefined ? 'optional' : 'none',
    payment_section_id: l.section, discount_group_id: l.section, label: l.label, unit_label: l.countWord ?? l.unit ?? '개', quantity: l.qty,
    start_date: start, end_date: end, ...perDay, gross_amount: gross,
    discount_amount: gross - l.amount, net_amount: l.amount, price_source_key: 'rule', price_engine_key: 'domain@1',
    created_at: isoOf(createdAt), created_by: ctx.actor.key, request_id: ctx.requestId, created_rev: ctx.rev, updated_at: isoOf(ctx.now), updated_rev: ctx.rev,
  });
  const componentBase = { shop_id: ctx.shopId, order_id: o.id, line_id: l.id, created_at: isoOf(createdAt), created_rev: ctx.rev };
  insert(ctx.db, 'line_price_components', { ...componentBase, seq: 1, component_key: 'base', label: l.label, quantity: l.qty, amount: gross });
  if (gross > l.amount) {
    const app = [...(o.discounts ?? [])].reverse().find((d) => d.sectionKey === l.section) ?? unmapped('할인 적용 없는 할인 줄: ' + l.id);
    insert(ctx.db, 'line_price_components', {
      ...componentBase, seq: 2, component_key: app.kind === 'manual_amount' || app.kind === 'manual_percent' ? 'manual_discount' : 'discount',
      discount_application_id: app.id, label: app.label, ...(app.kind === 'percent' || app.kind === 'manual_percent' ? { percent_bp: Math.round((app.value ?? 0) * 100) } : {}),
      amount: l.amount - gross, reason: app.reason,
    });
  }
}

/** 새 접수의 뼈대: 접수 · 첫 차수 · 줄 · 약속 · 할인. 사실(수납 · 이동 · 방문 …)은 빈 접수에서의 바뀜으로 따로 적는다. */
export function insertOrder(ctx: WriteContext, ids: Ids, o: FxOrder): void {
  const at = isoOf(ctx.now);
  const created = isoOf(o.createdAt);
  const businessDate = businessDateOfCtx(ctx, o.createdAt);
  insert(ctx.db, 'orders', {
    shop_id: ctx.shopId, id: o.id, receipt_no: o.receiptNo, customer_name: o.teamName, customer_phone: o.phone === '' ? undefined : o.phone,
    booking_channel_key: o.channel, headcount_expected: o.party > 0 ? o.party : undefined, business_date: businessDate, config_rev: configRevOf(ctx),
    created_at: created, created_by: ctx.actor.key, device_id: ctx.actor.deviceId, request_id: ctx.requestId, created_rev: ctx.rev, updated_at: at, updated_rev: ctx.rev,
  });
  const batchId = batchIdOf(o.id, 1);
  insert(ctx.db, 'order_batches', {
    shop_id: ctx.shopId, id: batchId, order_id: o.id, seq: 1, label: '첫 접수', source_key: 'counter', business_date: businessDate, posting_date: businessDate,
    created_at: created, created_by: ctx.actor.key, device_id: ctx.actor.deviceId, request_id: ctx.requestId,
  });
  // 할인 적용이 먼저(줄의 값 구성이 가리킨다).
  for (const d of o.discounts ?? []) insertDiscount(ctx, o.id, batchId, d);
  for (const l of o.lines) insertLine(ctx, o, l, batchId, o.createdAt);
  syncPromises(ctx, ids, undefined, { ...o, splits: [] });
}

/** 해제(kind none)의 종류 열(sys_discount_kinds FK): 대신한 적용의 종류(없으면 금액). 되읽기는 규칙 · 값이 모두 없는 행을 해제로 읽는다. */
const REMOVAL_KIND = 'amount';

/**
 * 할인 적용 한 행(추가만): 값의 사본(비율 · 금액)과 사유, 대신한 앞 적용(supersedes). 규칙을 뒤에 바꿔도 이 행은 그대로다(features-1 E12).
 * 직접 입력 · 해제는 규칙이 없다(discount_rule_id NULL). 할인 묶음이 내는 종류(discount_group_kinds)를 처음 쓸 때 둔다(E10).
 */
function insertDiscount(ctx: WriteContext, orderId: string, batchId: string, d: FxDiscountApplication): void {
  if (!(d.amount >= 0)) unmapped('할인 금액이 음수');
  if (d.kind === 'none' && (d.value !== undefined || d.discountKey !== undefined || d.amount !== 0)) unmapped('할인 해제의 모양: ' + d.id);
  if (d.kind !== 'none' && d.value === undefined) unmapped('할인 값이 없다: ' + d.id);
  const percent = d.kind === 'percent' || d.kind === 'manual_percent';
  const kind = d.kind === 'none' ? REMOVAL_KIND : d.kind;
  ensureGroupKind(ctx.db, ctx.shopId, d.sectionKey, kind);
  insert(ctx.db, 'discount_applications', {
    shop_id: ctx.shopId, id: d.id, order_id: orderId, batch_id: batchId, discount_group_id: d.sectionKey, discount_rule_id: d.discountKey,
    kind_key: kind, label: d.label, value_percent_bp: d.kind !== 'none' && percent ? Math.round(d.value! * 100) : undefined,
    value_amount: d.kind !== 'none' && !percent ? d.value : undefined, rounding_unit: 10, total_amount: d.amount, supersedes_application_id: d.supersedes,
    reason: d.reason, occurred_at: isoOf(d.at), recorded_at: isoOf(ctx.now), actor_key: ctx.actor.key, actor_name: ctx.actor.name, request_id: ctx.requestId,
    created_rev: ctx.rev,
  });
}

/** 이미 있는 접수에 더한 할인 적용(할인 적용 · 변경 · 해제, features-1 §6-3): 그 접수의 마지막 차수에 적는다. */
export function insertAppendedDiscounts(ctx: WriteContext, prev: FxOrder, next: FxOrder): void {
  const added = (next.discounts ?? []).slice((prev.discounts ?? []).length);
  if (!added.length) return;
  const batch = one(ctx.db, 'SELECT id FROM order_batches WHERE shop_id = ? AND order_id = ? ORDER BY seq DESC LIMIT 1', ctx.shopId, next.id);
  if (!batch) unmapped('차수 없는 접수: ' + next.id);
  for (const d of added) insertDiscount(ctx, next.id, str(batch.id), d);
}

/**
 * 이미 있는 접수에 더한 줄의 차수: 카운터의 품목 추가(줄의 batch, features-1 §5-5)는 `품목 추가`(counter), 기사의 현장 리프트권 추가는 `배달 중 추가`
 * (driver_field). 줄 → 차수 id. 할인 적용(대신하는 적용)이 이 차수를 가리키므로 줄보다 먼저 넣는다.
 */
export function insertAddedBatches(ctx: WriteContext, o: FxOrder, lines: readonly FxLine[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!lines.length) return out;
  const groups = new Map<string, FxLine[]>();
  for (const l of lines) {
    const key = l.batch ? 'counter:' + l.batch.at : 'driver_field';
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const businessDate = businessDateOfCtx(ctx, ctx.now);
  for (const [key, list] of groups) {
    const counter = key.startsWith('counter:');
    const at = counter ? list[0]!.batch!.at : ctx.now;
    const seq = num(one(ctx.db, 'SELECT max(seq) AS n FROM order_batches WHERE shop_id = ? AND order_id = ?', ctx.shopId, o.id)?.n) + 1;
    const batchId = batchIdOf(o.id, seq);
    insert(ctx.db, 'order_batches', {
      shop_id: ctx.shopId, id: batchId, order_id: o.id, seq, label: counter ? '품목 추가' : '배달 중 추가', source_key: counter ? 'counter' : 'driver_field',
      business_date: businessDate, posting_date: businessDate, created_at: isoOf(at), created_by: ctx.actor.key, device_id: ctx.actor.deviceId, request_id: ctx.requestId,
    });
    for (const l of list) out.set(l.id, batchId);
  }
  return out;
}

/** 이미 있는 접수에 더한 줄(차수는 insertAddedBatches). 약속은 syncPromises가 넣는다. */
export function insertAddedLines(ctx: WriteContext, o: FxOrder, lines: readonly FxLine[], batches: ReadonlyMap<string, string>): void {
  for (const l of lines) insertLine(ctx, o, l, batches.get(l.id) ?? unmapped('차수 없는 줄: ' + l.id), l.batch?.at ?? ctx.now);
}

/** 접수의 고정 칸(이름 · 번호 · 경로 · 인원 · 만든 때)이 그대로이고, 할인 적용 · 환불은 뒤에 더하기만 했는지(features-1 §6-3). */
export function checkFixedOrder(prev: FxOrder, next: FxOrder): void {
  const fixed = (o: FxOrder) => JSON.stringify([o.receiptNo, o.teamName, o.last4, o.phone, o.channel, o.party, o.createdAt]);
  if (fixed(prev) !== fixed(next)) unmapped('접수의 고정 칸이 바뀌었다: ' + next.id);
  const prefix = <T,>(a: readonly T[] | undefined, b: readonly T[] | undefined) => JSON.stringify(a ?? []) === JSON.stringify((b ?? []).slice(0, (a ?? []).length));
  if (!prefix(prev.discounts, next.discounts)) unmapped('할인 적용이 고쳐졌다: ' + next.id);
  if (!prefix(prev.refunds, next.refunds)) unmapped('환불이 고쳐졌다: ' + next.id);
  if (!prefix(prev.cancellations, next.cancellations)) unmapped('취소가 고쳐졌다: ' + next.id);
}

/** 줄의 고정 칸(얼린 값)이 그대로인지. */
export function checkFixedLine(prev: FxLine, next: FxLine): void {
  const fixed = (l: FxLine) => JSON.stringify([
    l.kind, l.label, l.shortLabel, l.qty, l.unit, l.countWord, l.amount, l.gross, l.section, l.returnable, l.capabilities, l.tracking, l.productKey, l.variantKey,
  ]);
  if (fixed(prev) !== fixed(next)) unmapped('줄의 얼린 칸이 바뀌었다: ' + next.id);
}

// ── 되읽기 ──────────────────────────────────────────────────────────

const promiseOfRow = (r: Row): FxPromise => {
  const mode: FxPromise['mode'] = str(r.method_key).startsWith('vehicle') ? 'vehicle' : 'store';
  return {
    at: msOfLocal(str(r.promised_date), str(r.promised_time)),
    mode,
    ...(text(r.place_id) !== undefined ? { placeId: str(r.place_id) } : {}),
    ...(text(r.vehicle_id) !== undefined ? { vehicleId: str(r.vehicle_id) } : {}),
    ...(text(r.reason) !== undefined ? { note: str(r.reason) } : {}),
  };
};

/** 전화번호의 끝 4자리(도메인의 last4 규칙: 숫자가 4자리 이상일 때만). */
const last4Of = (phone: string) => {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
};

/** 접수 뼈대 되읽기(줄의 수 셈 · 번호 · 수납 · 방문 · 조정은 다른 되읽기가 채운다). 만든 차례. */
export function loadOrderShells(db: Db, shopId: string, reg: ShopRegistry): { orders: FxOrder[]; byId: Map<string, FxOrder>; lineById: Map<string, FxLine> } {
  const orders: FxOrder[] = [];
  const byId = new Map<string, FxOrder>();
  const lineById = new Map<string, FxLine>();
  for (const r of all(db, 'SELECT id, receipt_no, customer_name, customer_phone, booking_channel_key, headcount_expected, created_at FROM orders WHERE shop_id = ? ORDER BY rowid', shopId)) {
    const phone = text(r.customer_phone) ?? '';
    const o: FxOrder = {
      id: str(r.id), receiptNo: text(r.receipt_no) ?? '', teamName: str(r.customer_name), last4: last4Of(phone), phone, channel: str(r.booking_channel_key) as FxOrder['channel'],
      party: num(r.headcount_expected), createdAt: msOf(str(r.created_at)), pickup: { at: 0, mode: 'store' }, giveBack: { at: 0, mode: 'store' }, lines: [], payments: [],
      payWhen: 'pickup',
    };
    orders.push(o);
    byId.set(o.id, o);
  }
  for (const r of all(db, `SELECT l.id, l.order_id, l.catalog_item_id, l.label, l.quantity, l.unit_label, l.net_amount, l.gross_amount, l.discount_amount, l.price_basis_key, l.unit_price,
      l.payment_section_id, l.return_policy_key, l.tracking_key, v.code AS variant_key, b.seq AS batch_seq, b.source_key AS batch_source, b.created_at AS batch_at
      FROM order_lines l LEFT JOIN item_variants v ON v.shop_id = l.shop_id AND v.id = l.variant_id
      LEFT JOIN order_batches b ON b.shop_id = l.shop_id AND b.id = l.batch_id
      WHERE l.shop_id = ? ORDER BY l.rowid`, shopId)) {
    const o = byId.get(str(r.order_id));
    if (!o) continue;
    const kind = str(r.catalog_item_id);
    const product = reg.products[kind];
    const l: FxLine = {
      id: str(r.id), kind, label: str(r.label), shortLabel: product?.shortLabel ?? product?.label ?? str(r.label), qty: num(r.quantity),
      ...(product?.unit !== undefined ? { unit: product.unit } : {}), countWord: str(r.unit_label), amount: num(r.net_amount),
      ...(num(r.discount_amount) > 0 ? { gross: num(r.gross_amount) } : {}),
      ...(str(r.price_basis_key) === 'per_day' ? { dayPrice: num(r.unit_price) } : {}),
      section: str(r.payment_section_id) as FxLine['section'], returnable: str(r.return_policy_key) === 'required', capabilities: [...(product?.capabilities ?? [])],
      loaded: 0, issued: 0, returned: 0, collected: 0, received: 0, tracking: str(r.tracking_key) as NonNullable<FxLine['tracking']>, productKey: kind,
      ...(text(r.variant_key) !== undefined ? { variantKey: str(r.variant_key) } : {}),
      // 카운터의 품목 추가 차수(첫 차수 뒤, features-1 §5-5).
      ...(str(r.batch_source) === 'counter' && num(r.batch_seq) > 1 ? { batch: { source: 'counter' as const, at: msOf(str(r.batch_at)) } } : {}),
    };
    o.lines.push(l);
    lineById.set(l.id, l);
  }
  // 약속: 수령 = 가장 늦은 수령 행, 원래 반납 = 가장 늦은 schedule 없는 반납 행, 나눈 일정 = 살아 있는 schedule 행.
  const everSplit = new Set<string>();
  const splitRows = new Map<string, Row>();
  const chainParent = new Map<string, string>();
  const created = new Map<string, number>();
  for (const r of all(db, `SELECT id, order_id, line_id, promise_type_key, method_key, quantity, promised_date, promised_time, place_id, vehicle_id, reason, status_key,
      supersedes_promise_id, schedule_id, created_at FROM line_promises WHERE shop_id = ? ORDER BY created_rev, rowid`, shopId)) {
    const o = byId.get(str(r.order_id));
    if (!o) continue;
    const id = str(r.id);
    created.set(id, msOf(str(r.created_at)));
    if (text(r.supersedes_promise_id) !== undefined) chainParent.set(id, str(r.supersedes_promise_id));
    const schedule = text(r.schedule_id);
    if (str(r.promise_type_key) === 'pickup') o.pickup = promiseOfRow(r);
    else if (schedule === undefined) o.giveBack = promiseOfRow(r);
    else {
      everSplit.add(o.id);
      if (str(r.status_key) === 'active') splitRows.set(id, r);
    }
  }
  const rootOf = (id: string): string => {
    let at = id;
    for (let guard = 0; chainParent.has(at) && guard < 10_000; guard += 1) at = chainParent.get(at)!;
    return at;
  };
  const splitsByOrder = new Map<string, { root: string; split: FxPromiseSplit; chain: string }[]>();
  for (const [id, r] of splitRows) {
    const root = rootOf(id);
    const split: FxPromiseSplit = { id: str(r.schedule_id), lineId: str(r.line_id), quantity: num(r.quantity), promise: promiseOfRow(r), at: created.get(root) ?? 0 };
    const list = splitsByOrder.get(str(r.order_id)) ?? [];
    list.push({ root, split, chain: id });
    splitsByOrder.set(str(r.order_id), list);
  }
  const rowOrder = new Map(all(db, 'SELECT id, rowid AS n FROM line_promises WHERE shop_id = ?', shopId).map((r) => [str(r.id), num(r.n)]));
  for (const o of orders) {
    if (!everSplit.has(o.id)) continue;
    const list = (splitsByOrder.get(o.id) ?? []).sort((a, b) => (rowOrder.get(a.root) ?? 0) - (rowOrder.get(b.root) ?? 0));
    o.splits = list.map((x) => x.split);
  }
  // 결제 약속(살아 있는 행).
  for (const r of all(db, "SELECT order_id, line_id, timing_key, payer_order_id FROM payment_promises WHERE shop_id = ? AND status_key = 'open' ORDER BY rowid", shopId)) {
    const o = byId.get(str(r.order_id));
    if (!o) continue;
    const payer = text(r.payer_order_id);
    const lineId = text(r.line_id);
    if (lineId === undefined) {
      o.payWhen = str(r.timing_key) === 'at_issue' ? 'pickup' : 'return';
      if (payer !== undefined) o.payerOrderId = payer;
    } else if (payer !== undefined) {
      const l = lineById.get(lineId);
      if (l) l.payerOrderId = payer;
    }
  }
  // 할인 적용(규칙 · 값이 모두 없는 행은 해제).
  for (const r of all(db, `SELECT id, order_id, discount_group_id, discount_rule_id, kind_key, label, value_amount, value_percent_bp, total_amount, supersedes_application_id,
      reason, occurred_at FROM discount_applications WHERE shop_id = ? ORDER BY rowid`, shopId)) {
    const o = byId.get(str(r.order_id));
    if (!o) continue;
    const rule = text(r.discount_rule_id);
    const amountValue = r.value_amount === null ? undefined : num(r.value_amount);
    const percentValue = r.value_percent_bp === null ? undefined : num(r.value_percent_bp) / 100;
    const removal = rule === undefined && amountValue === undefined && percentValue === undefined;
    const value = amountValue ?? percentValue;
    o.discounts = [...(o.discounts ?? []), {
      id: str(r.id), sectionKey: str(r.discount_group_id) as FxDiscountApplication['sectionKey'], ...(rule !== undefined ? { discountKey: rule } : {}),
      kind: removal ? 'none' : (str(r.kind_key) as FxDiscountApplication['kind']), label: str(r.label), ...(value !== undefined ? { value } : {}), amount: num(r.total_amount),
      ...(text(r.reason) !== undefined ? { reason: str(r.reason) } : {}), ...(text(r.supersedes_application_id) !== undefined ? { supersedes: str(r.supersedes_application_id) } : {}),
      at: msOf(str(r.occurred_at)),
    }];
  }
  return { orders, byId, lineById };
}

/** 나눈 일정 행의 사슬(지금 살아 있는 행 → 첫 행까지의 id): 일정 몫의 수거 · 반납 · 입고를 셀 때 쓴다. */
export function splitChains(db: Db, shopId: string): Map<string, string[]> {
  const parent = new Map<string, string>();
  const active: Row[] = [];
  for (const r of all(db, 'SELECT id, order_id, line_id, schedule_id, status_key, supersedes_promise_id FROM line_promises WHERE shop_id = ? AND schedule_id IS NOT NULL', shopId)) {
    if (text(r.supersedes_promise_id) !== undefined) parent.set(str(r.id), str(r.supersedes_promise_id));
    if (str(r.status_key) === 'active') active.push(r);
  }
  const out = new Map<string, string[]>();
  for (const r of active) {
    const chain = [str(r.id)];
    for (let at = str(r.id), guard = 0; parent.has(at) && guard < 10_000; guard += 1) {
      at = parent.get(at)!;
      chain.push(at);
    }
    out.set(str(r.order_id) + '|' + str(r.line_id) + '|' + str(r.schedule_id), chain);
  }
  return out;
}

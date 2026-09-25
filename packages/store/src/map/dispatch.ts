// 차량 업무 · 방문 · 빨리 확인 · 방문 순서 · 청구 조정 ↔ 표(plan §4-2 dispatch · charges).
//   - 업무(tasks): 도메인은 업무를 접수에서 셈한다(배달 'deliver:<접수>', 수거 'collect:<접수>[:<일정>]'). 방문 · 고정 · 순서가 가리킬
//     행이 있어야 하므로 처음 쓸 때 그 id로 만든다(상태 투영은 아직 셈하지 않는다: waiting).
//   - 방문 결과(FxVisit) = task_visits, 빨리 확인(FxPin) = task_pins + notifications(약속 시각은 params_json.promiseAt), 방문 순서
//     (routeRanks) = route_positions(시간순으로 되돌리면 rank_key NULL).
//   - 청구 조정(FxCharge): 연장은 order_extensions + order_extension_lines + charge_adjustments(extension), 연장 취소는
//     charge_adjustments(extension_undo, 음수)만.
import type { FxCharge, FxOrder, FxPin, FxVisit, FxVisitOutcome } from '@skinote/domain';
import { addDays, isoOf, msOf } from '../ids.ts';
import { all, insert, num, one, run, str, text, type Db } from '../db.ts';
import { EXTENSION, EXTENSION_UNDO, VISIT_RESULT, reasonId } from '../registry-keys.ts';
import { appended, businessDateOfCtx, factMeta, localDate, localTime, msOfLocal, unmapped, type WriteContext } from './common.ts';

const orderOfTask = (taskId: string) => taskId.split(':')[1] ?? '';

/** 업무 행을 처음 쓸 때 만든다(도메인 업무 id 그대로). */
export function ensureTask(ctx: WriteContext, taskId: string): { vehicleId?: string; serviceDate: string } {
  const row = one(ctx.db, 'SELECT vehicle_id, service_date FROM tasks WHERE shop_id = ? AND id = ?', ctx.shopId, taskId);
  if (row) return { ...(text(row.vehicle_id) !== undefined ? { vehicleId: str(row.vehicle_id) } : {}), serviceDate: str(row.service_date) };
  const orderId = orderOfTask(taskId);
  const o = ctx.after.orders.find((x) => x.id === orderId) ?? ctx.before.orders.find((x) => x.id === orderId) ?? unmapped('업무의 접수가 없다: ' + taskId);
  const deliver = taskId.startsWith('deliver:');
  const key = deliver ? undefined : taskId.split(':')[2];
  const promise = deliver ? o.pickup : key ? o.splits?.find((s) => s.id === key)?.promise ?? o.giveBack : o.giveBack;
  const serviceDate = businessDateOfCtx(ctx, promise.at);
  const at = isoOf(ctx.now);
  insert(ctx.db, 'tasks', {
    shop_id: ctx.shopId, id: taskId, kind_key: deliver ? 'delivery' : 'collection', vehicle_id: promise.vehicleId, service_date: serviceDate,
    promised_time: promise.at % 60_000 === 0 ? localTime(promise.at) : undefined, place_id: promise.placeId, order_id: o.id, source_key: 'promise',
    created_at: at, created_by: ctx.actor.key, request_id: ctx.requestId, created_rev: ctx.rev, updated_at: at, updated_rev: ctx.rev,
  });
  return { ...(promise.vehicleId ? { vehicleId: promise.vehicleId } : {}), serviceDate };
}

// ── 방문 결과 ────────────────────────────────────────────────────────

export function writeVisits(ctx: WriteContext, prev: FxOrder | undefined, next: FxOrder, nextId: (kind: string) => string): void {
  const visits = appended(prev?.visits, next.visits, '방문 결과 ' + next.id);
  if (!visits.length) return;
  const payload = ctx.envelope?.type === 'task.visit' ? ctx.envelope.payload : undefined;
  for (const v of visits) {
    const taskId = v.kind === 'deliver'
      ? 'deliver:' + next.id
      : payload && !payload.taskId.startsWith('deliver:') && orderOfTask(payload.taskId) === next.id ? payload.taskId : 'collect:' + next.id;
    ensureTask(ctx, taskId);
    const seq = num(one(ctx.db, 'SELECT max(seq) AS n FROM task_visits WHERE shop_id = ? AND task_id = ?', ctx.shopId, taskId)?.n) + 1;
    const meta = factMeta(ctx, v.at);
    insert(ctx.db, 'task_visits', {
      shop_id: ctx.shopId, id: nextId('tv'), task_id: taskId, seq, result_reason_id: reasonId(VISIT_RESULT, v.outcomeKey),
      before_date: localDate(v.beforeAt), before_time: localTime(v.beforeAt, '방문 전 약속 시각'),
      ...(v.retryAt !== undefined ? { after_date: localDate(v.retryAt), after_time: localTime(v.retryAt, '다시 갈 때') } : {}),
      occurred_at: meta.occurred_at, recorded_at: meta.recorded_at, business_date: meta.business_date, actor_key: meta.actor_key, actor_name: meta.actor_name,
      device_id: meta.device_id, request_id: meta.request_id, created_rev: meta.created_rev,
    });
  }
}

// ── 청구 조정 ────────────────────────────────────────────────────────

export function writeCharges(ctx: WriteContext, prev: FxOrder | undefined, next: FxOrder): void {
  const charges = appended(prev?.charges, next.charges, '청구 조정 ' + next.id);
  for (const c of charges) {
    const meta = factMeta(ctx, c.at);
    if (c.kind === 'extension') {
      if (!(c.amount > 0) || !(c.quantity >= 1) || c.days < 0) unmapped('연장 값의 모양: ' + c.id);
      const extensionId = c.id + ':x';
      insert(ctx.db, 'order_extensions', { shop_id: ctx.shopId, id: extensionId, order_id: next.id, reason: '일정 변경', total_amount: c.amount, ...meta });
      insert(ctx.db, 'charge_adjustments', {
        shop_id: ctx.shopId, id: c.id, order_id: next.id, line_id: c.lineId, adjustment_type_id: EXTENSION, type_sign: 1, amount: c.amount, reason: '연장',
        extension_id: extensionId, ...meta,
      });
      const beforeEnd = businessDateOfCtx(ctx, (prev ?? next).giveBack.at);
      insert(ctx.db, 'order_extension_lines', {
        shop_id: ctx.shopId, extension_id: extensionId, order_id: next.id, line_id: c.lineId, scope_key: 'line', quantity: c.quantity, before_end_date: beforeEnd,
        after_end_date: addDays(beforeEnd, Math.max(1, c.days)), price_basis_key: 'per_day', added_units: c.days, amount: c.amount, adjustment_id: c.id,
      });
    } else {
      if (!(c.amount < 0)) unmapped('연장 취소 값의 모양: ' + c.id);
      insert(ctx.db, 'charge_adjustments', {
        shop_id: ctx.shopId, id: c.id, order_id: next.id, line_id: c.lineId, adjustment_type_id: EXTENSION_UNDO, type_sign: -1, amount: c.amount, reason: '연장 취소',
        ...meta,
      });
    }
  }
}

// ── 빨리 확인 ────────────────────────────────────────────────────────

const mainCollect = (orderId: string) => 'collect:' + orderId;

export function writePins(ctx: WriteContext): void {
  const { before, after } = ctx;
  if (after.pins.length < before.pins.length || before.pins.some((p, i) => after.pins[i]?.id !== p.id)) unmapped('빨리 확인의 차례가 바뀌었다');
  const at = isoOf(ctx.now);
  after.pins.forEach((pin, i) => {
    const prev = before.pins[i];
    if (prev) {
      const same = (p: FxPin) => JSON.stringify([p.orderId, p.taskId ?? null, p.at, p.note ?? null]);
      if (same(prev) !== same(pin)) unmapped('빨리 확인의 칸이 바뀌었다: ' + pin.id);
      if (prev.status === pin.status) return;
      run(ctx.db, `UPDATE notifications SET lifecycle_key = ?, delivered_at = coalesce(delivered_at, ?), acknowledged_at = ?, acknowledged_by = ?, updated_rev = ?,
        version = version + 1 WHERE shop_id = ? AND id = ?`,
      pin.status, pin.status === 'requested' ? null : at, pin.status === 'acknowledged' ? at : null, pin.status === 'acknowledged' ? ctx.actor.key : null, ctx.rev,
      ctx.shopId, 'pin:' + pin.id);
      return;
    }
    const taskId = pin.taskId ?? mainCollect(pin.orderId);
    const task = ensureTask(ctx, taskId);
    for (const r of all(ctx.db, 'SELECT id FROM task_pins WHERE shop_id = ? AND task_id = ? AND released_at IS NULL', ctx.shopId, taskId)) {
      run(ctx.db, "UPDATE task_pins SET released_at = ?, released_by = ?, release_reason_key = 'manual', updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?",
        at, ctx.actor.key, ctx.rev, ctx.shopId, str(r.id));
    }
    insert(ctx.db, 'notifications', {
      shop_id: ctx.shopId, id: 'pin:' + pin.id, recipient_scope_key: 'vehicle', recipient_vehicle_id: task.vehicleId, type_key: 'pin', source_key: 'pin:' + pin.id,
      source_request_id: ctx.requestId, order_id: pin.orderId, task_id: taskId, title: '빨리 확인', params_json: JSON.stringify({ promiseAt: pin.at }),
      attention_required: 1, lifecycle_key: pin.status, ...(pin.status !== 'requested' ? { delivered_at: at } : {}),
      ...(pin.status === 'acknowledged' ? { acknowledged_at: at, acknowledged_by: ctx.actor.key } : {}), created_at: at, created_rev: ctx.rev,
    });
    insert(ctx.db, 'task_pins', {
      shop_id: ctx.shopId, id: pin.id, task_id: taskId, message: pin.note, pinned_at: at, pinned_by: ctx.actor.key, notification_id: 'pin:' + pin.id, request_id: ctx.requestId,
      updated_rev: ctx.rev,
    });
  });
}

// ── 방문 순서 ────────────────────────────────────────────────────────

export function writeRouteRanks(ctx: WriteContext): void {
  const before = ctx.before.routeRanks;
  const after = ctx.after.routeRanks;
  const at = isoOf(ctx.now);
  for (const taskId of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const rank = after[taskId];
    if (before[taskId] === rank) continue;
    const task = ensureTask(ctx, taskId);
    if (!task.vehicleId) unmapped('차량 없는 업무의 순서: ' + taskId);
    run(ctx.db, `INSERT INTO route_positions (shop_id, task_id, vehicle_id, service_date, rank_key, decided_at, updated_at, updated_by, request_id, updated_rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (shop_id, task_id) DO UPDATE SET rank_key = excluded.rank_key, decided_at = excluded.decided_at,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by, request_id = excluded.request_id, updated_rev = excluded.updated_rev, version = version + 1`,
    ctx.shopId, taskId, task.vehicleId, task.serviceDate, rank ?? null, at, at, ctx.actor.key, ctx.requestId, ctx.rev);
  }
}

// ── 되읽기 ──────────────────────────────────────────────────────────

export function loadDispatch(db: Db, shopId: string, byId: Map<string, FxOrder>): { pins: FxPin[]; routeRanks: Record<string, string> } {
  // 방문 결과.
  for (const r of all(db, `SELECT v.task_id, v.result_reason_id, v.before_date, v.before_time, v.after_date, v.after_time, v.occurred_at, t.kind_key, t.order_id
      FROM task_visits v JOIN tasks t ON t.shop_id = v.shop_id AND t.id = v.task_id WHERE v.shop_id = ? ORDER BY v.created_rev, v.rowid`, shopId)) {
    const o = byId.get(text(r.order_id) ?? '');
    if (!o) continue;
    const reason = str(r.result_reason_id);
    const visit: FxVisit = {
      at: msOf(str(r.occurred_at)),
      ...(str(r.kind_key) === 'delivery' ? { kind: 'deliver' as const } : {}),
      outcomeKey: reason.slice(reason.indexOf(':') + 1) as FxVisitOutcome,
      ...(text(r.after_date) !== undefined ? { retryAt: msOfLocal(str(r.after_date), str(r.after_time)) } : {}),
      beforeAt: msOfLocal(str(r.before_date), str(r.before_time)),
    };
    o.visits = [...(o.visits ?? []), visit];
  }
  // 청구 조정.
  const extensionLines = new Map(all(db, 'SELECT adjustment_id, quantity, added_units FROM order_extension_lines WHERE shop_id = ? AND adjustment_id IS NOT NULL', shopId)
    .map((r) => [str(r.adjustment_id), { quantity: num(r.quantity), days: num(r.added_units) }]));
  for (const r of all(db, 'SELECT id, order_id, line_id, adjustment_type_id, amount, occurred_at FROM charge_adjustments WHERE shop_id = ? ORDER BY rowid', shopId)) {
    const o = byId.get(str(r.order_id));
    if (!o) continue;
    const type = str(r.adjustment_type_id);
    const base = { id: str(r.id), lineId: text(r.line_id) ?? '', amount: num(r.amount), at: msOf(str(r.occurred_at)) };
    let charge: FxCharge;
    if (type === EXTENSION) {
      const x = extensionLines.get(base.id) ?? { quantity: 0, days: 0 };
      charge = { id: base.id, kind: 'extension', lineId: base.lineId, quantity: x.quantity, days: x.days, amount: base.amount, at: base.at };
    } else if (type === EXTENSION_UNDO) {
      charge = { id: base.id, kind: 'extension_undo', lineId: base.lineId, amount: base.amount, at: base.at };
    } else {
      continue;
    }
    o.charges = [...(o.charges ?? []), charge];
  }
  // 빨리 확인.
  const pins: FxPin[] = all(db, `SELECT p.id, p.task_id, p.message, n.params_json, n.lifecycle_key, t.order_id FROM task_pins p
      JOIN notifications n ON n.shop_id = p.shop_id AND n.id = p.notification_id JOIN tasks t ON t.shop_id = p.shop_id AND t.id = p.task_id
      WHERE p.shop_id = ? ORDER BY p.rowid`, shopId).map((r) => {
    const orderId = str(r.order_id);
    const taskId = str(r.task_id);
    const params = JSON.parse(text(r.params_json) ?? '{}') as { promiseAt?: number };
    return {
      id: str(r.id), orderId, ...(taskId !== mainCollect(orderId) ? { taskId } : {}), at: params.promiseAt ?? 0,
      ...(text(r.message) !== undefined ? { note: str(r.message) } : {}), status: str(r.lifecycle_key) as FxPin['status'],
    };
  });
  // 방문 순서.
  const routeRanks: Record<string, string> = {};
  for (const r of all(db, 'SELECT task_id, rank_key FROM route_positions WHERE shop_id = ? AND rank_key IS NOT NULL ORDER BY rowid', shopId)) routeRanks[str(r.task_id)] = str(r.rank_key);
  return { pins, routeRanks };
}


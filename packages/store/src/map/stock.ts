// 재고 이동 ↔ 표(plan §4-2 FxLine.moves · stock). 도메인의 줄은 수 셈(loaded · issued · returned · collected · received와 그 시각)과
// 번호(assetIds · backAssetIds)를 갖고, 표는 이동 사실(stock_movements + 줄마다 stock_movement_lines)을 갖는다:
//   - 명령 앞뒤의 줄을 비교해 늘어난 몫을 이동으로 적는다: 적재(매장 → 차량), 지급 · 배달(매장 · 차량 → 손님), 매장 반납(손님 → 매장),
//     수거(손님 → 차량), 매장 입고(차량 → 매장, 여러 접수가 한 이동). 번호로 세는 줄은 번호 하나가 이동 줄 하나, 수량으로 세는 줄(고글)은
//     규격 · 수량 한 줄(상태 ok)이다.
//   - 나눈 반납 일정의 몫(split.returned · collected · received)은 이동 줄 ↔ 약속 행(line_promise_fulfillments, 0002)으로 적는다.
//   - 준비 번호(plannedAssetIds)는 준비 claim(asset_claims + asset_bindings): 바뀌면 줄의 claim을 모두 끝내고 새 차례로 넣는다(지급한
//     번호는 끝난 claim으로). 지급하면 그 번호의 claim이 끝난다(fulfilled).
//   - 번호 실물의 위치(assets.location_id)는 마지막 이동의 도착지다. 차량 예비권(FxAsset.vehicleId)은 접수 없이 차량에 있는 번호다.
// 되읽기는 줄의 이동을 적은 차례(rev · 이동 · 줄 번호)로 접는다(foldLine): 적재는 도메인과 같이 max(loaded, issued) + 수.
import type { FxAsset, FxLine, FxOrder, ShopState } from '@skinote/domain';
import { findDeliverTask, orderIdOfTask, plannedLeft, resolveTask } from '@skinote/domain';
import { isoOf, msOf } from '../ids.ts';
import { all, insert, num, one, run, str, text, type Db, type Row } from '../db.ts';
import { OK_CONDITION, SHOP_LOCATION, customerLocation, variantId, vehicleLocation } from '../registry-keys.ts';
import { factMeta, idMaker, unmapped, type WriteContext } from './common.ts';

type Ids = ReturnType<typeof idMaker>;
type MoveKind = 'load' | 'deliver' | 'direct_return' | 'collect' | 'receive';
/** 한 명령 안의 이동 차례(되읽기의 접기 차례와 같다). */
const KIND_ORDER: readonly MoveKind[] = ['load', 'deliver', 'direct_return', 'collect', 'receive'];

interface MoveLine {
  order: FxOrder;
  line: FxLine;
  /** 번호로 세는 줄의 번호(하나), 수량 줄은 없음. */
  assetId?: string;
  quantity: number;
}

interface Movement {
  kind: MoveKind;
  from: string;
  to: string;
  orderId?: string;
  at: number;
  lines: MoveLine[];
  id?: string;
}

const numbered = (l: FxLine) => (l.tracking ?? 'unit') === 'unit';

/** 줄의 빈 모양(새 접수 · 새 줄의 '앞'): 수 셈 0, 번호 · 시각 없음. */
export function blankLine(l: FxLine): FxLine {
  const { loadedAt: _a, issuedAt: _b, returnedAt: _c, collectedAt: _d, receivedAt: _e, assetIds: _f, backAssetIds: _g, plannedAssetIds: _h, ...rest } = l;
  return { ...rest, loaded: 0, issued: 0, returned: 0, collected: 0, received: 0 };
}

/** 손님 위치(접수마다 처음 쓸 때 만든다). */
function ensureCustomer(ctx: WriteContext, orderId: string): string {
  const id = customerLocation(orderId);
  if (!one(ctx.db, 'SELECT 1 AS x FROM stock_locations WHERE shop_id = ? AND id = ?', ctx.shopId, id)) {
    insert(ctx.db, 'stock_locations', { shop_id: ctx.shopId, id, kind_key: 'customer', label: '손님', order_id: orderId, created_at: isoOf(ctx.now) });
  }
  return id;
}

const locationKind = (ctx: WriteContext, id: string): string => str(one(ctx.db, 'SELECT kind_key FROM stock_locations WHERE shop_id = ? AND id = ?', ctx.shopId, id)?.kind_key ?? 'shop');
const assetLocation = (ctx: WriteContext, assetId: string): string | undefined => text(one(ctx.db, 'SELECT location_id FROM assets WHERE shop_id = ? AND id = ?', ctx.shopId, assetId)?.location_id);

/** 명령의 업무 차량(적재 · 수거 · 배달의 차량). 봉투에 업무가 없으면 접수의 약속 차량. */
function taskVehicle(ctx: WriteContext, o: FxOrder, kind: 'load' | 'deliver' | 'collect', schedule?: string | null): string | undefined {
  const env = ctx.envelope;
  const payload = env?.payload as { taskId?: unknown } | undefined;
  if (typeof payload?.taskId === 'string' && orderIdOfTask(payload.taskId) === o.id) {
    const t = resolveTask(ctx.before, payload.taskId) ?? findDeliverTask(ctx.before, payload.taskId);
    if (t?.promise.vehicleId) return t.promise.vehicleId;
  }
  if (kind === 'collect') {
    const split = schedule ? o.splits?.find((s) => s.id === schedule) : undefined;
    return split?.promise.vehicleId ?? o.giveBack.vehicleId;
  }
  return o.pickup.vehicleId ?? o.giveBack.vehicleId;
}

/** 늘어난 번호 목록(앞 목록이 앞부분이어야 한다). */
function added(before: readonly string[] | undefined, after: readonly string[] | undefined, what: string): string[] {
  const a = before ?? [];
  const b = after ?? [];
  if (b.length < a.length || a.some((id, i) => b[i] !== id)) unmapped(what + ': 번호 목록이 앞에서 바뀌었다');
  return b.slice(a.length);
}

/** 한 줄의 이동 몫(앞 → 뒤). 수가 줄면 던진다(이동 사실은 되돌리지 않는다). */
function lineMoves(ctx: WriteContext, o: FxOrder, p: FxLine, n: FxLine): { kind: MoveKind; qty: number; assets: string[]; at: number; vehicle?: string }[] {
  const out: { kind: MoveKind; qty: number; assets: string[]; at: number; vehicle?: string }[] = [];
  const delta = (k: 'loaded' | 'issued' | 'returned' | 'collected' | 'received') => {
    const d = (n[k] ?? 0) - (p[k] ?? 0);
    if (d < 0) unmapped('줄의 ' + k + '이 줄었다: ' + n.id);
    return d;
  };
  const dIssued = delta('issued');
  const dReturned = delta('returned');
  const dCollected = delta('collected');
  const dReceived = delta('received');
  // 적재: 도메인은 loaded = max(loaded, issued) + 수. 옮긴 수 = 뒤 loaded − max(앞 loaded, 앞 issued).
  const loadedFloor = Math.max(p.loaded, p.issued);
  if (n.loaded !== p.loaded) {
    const qty = n.loaded - loadedFloor;
    if (qty <= 0) unmapped('적재 수가 맞지 않는다: ' + n.id);
    let assets: string[] = [];
    if (numbered(n)) {
      const onVan = loadedFloor - p.issued;
      assets = plannedLeft(n).slice(onVan, onVan + qty);
      if (assets.length !== qty) unmapped('적재한 번호가 수와 다르다: ' + n.id);
    }
    out.push({ kind: 'load', qty, assets, at: n.loadedAt ?? ctx.now, vehicle: taskVehicle(ctx, o, 'load') });
  }
  const given = added(p.assetIds, n.assetIds, '지급 번호');
  if (dIssued > 0 || given.length) {
    if (numbered(n) && given.length !== dIssued) unmapped('지급한 번호가 수와 다르다: ' + n.id);
    out.push({ kind: 'deliver', qty: dIssued, assets: given, at: n.issuedAt ?? ctx.now });
  }
  const back = added(p.backAssetIds, n.backAssetIds, '돌아온 번호');
  if (numbered(n) && back.length !== dReturned + dCollected) unmapped('돌아온 번호가 수와 다르다: ' + n.id);
  if (dReturned > 0) out.push({ kind: 'direct_return', qty: dReturned, assets: numbered(n) ? back.slice(0, dReturned) : [], at: n.returnedAt ?? ctx.now });
  if (dCollected > 0) {
    out.push({ kind: 'collect', qty: dCollected, assets: numbered(n) ? back.slice(dReturned) : [], at: n.collectedAt ?? ctx.now, vehicle: collectVehicle(ctx, o, n) });
  }
  if (dReceived > 0) out.push({ kind: 'receive', qty: dReceived, assets: [], at: n.receivedAt ?? ctx.now });
  return out;
}

/** 수거한 차량: 이 명령의 업무, 없으면 일정 몫이 늘어난 나눈 일정 또는 원래 일정의 차량. */
function collectVehicle(ctx: WriteContext, o: FxOrder, n: FxLine): string | undefined {
  const prev = ctx.before.orders.find((x) => x.id === o.id);
  const grown = (o.splits ?? []).find((s) => s.lineId === n.id && (s.collected ?? 0) > (prev?.splits?.find((x) => x.id === s.id && x.lineId === n.id)?.collected ?? 0));
  return taskVehicle(ctx, o, 'collect', grown?.id ?? null);
}

/** 매장 입고할 번호: 이 줄로 수거해 아직 차량에 있는 번호(수거한 차례). */
function receiveAssets(ctx: WriteContext, lineId: string, qty: number, vehicleLoc: string): string[] {
  const rows = all(ctx.db, `SELECT ml.asset_id FROM stock_movement_lines ml JOIN stock_movements m ON m.shop_id = ml.shop_id AND m.id = ml.movement_id
    JOIN assets a ON a.shop_id = ml.shop_id AND a.id = ml.asset_id
    WHERE ml.shop_id = ? AND ml.order_line_id = ? AND m.kind_key = 'collect' AND a.location_id = ? ORDER BY m.created_rev, m.rowid, ml.line_no`, ctx.shopId, lineId, vehicleLoc);
  const ids = [...new Set(rows.map((r) => str(r.asset_id)))];
  return ids.slice(0, qty);
}

/**
 * 줄마다의 이동을 표에 적는다(접수의 뼈대 · 새 줄을 넣은 뒤). 돌려주는 것: 지급한 번호(준비 claim 끝내기) · 번호의 새 위치.
 * prevLine(order, line)은 그 줄의 앞 모양(없으면 빈 줄).
 */
export function writeStock(ctx: WriteContext, ids: Ids, prevLine: (o: FxOrder, l: FxLine) => FxLine): Movement[] {
  const movements: Movement[] = [];
  const key = (m: Pick<Movement, 'kind' | 'from' | 'to' | 'orderId'>) => m.kind + '|' + m.from + '|' + m.to + '|' + (m.orderId ?? '');
  const byKey = new Map<string, Movement>();
  const addLine = (kind: MoveKind, from: string, to: string, orderId: string | undefined, at: number, line: MoveLine) => {
    const k = key({ kind, from, to, orderId });
    let m = byKey.get(k);
    if (!m) {
      m = { kind, from, to, ...(orderId !== undefined ? { orderId } : {}), at, lines: [] };
      byKey.set(k, m);
      movements.push(m);
    }
    m.lines.push(line);
  };
  const receiveVehicle = (() => {
    const p = ctx.envelope?.payload as { vehicleId?: unknown } | undefined;
    return ctx.envelope?.type === 'stock.receive' && typeof p?.vehicleId === 'string' ? p.vehicleId : undefined;
  })();

  for (const o of ctx.after.orders) {
    for (const n of o.lines) {
      const p = prevLine(o, n);
      for (const mv of lineMoves(ctx, o, p, n)) {
        const unit = numbered(n);
        const customer = ensureCustomer(ctx, o.id);
        const pushUnits = (from: (asset: string) => string, to: string, orderId: string | undefined) => {
          if (unit) for (const a of mv.assets) addLine(mv.kind, from(a), to, orderId, mv.at, { order: o, line: n, assetId: a, quantity: 1 });
          else addLine(mv.kind, from(''), to, orderId, mv.at, { order: o, line: n, quantity: mv.qty });
        };
        switch (mv.kind) {
          case 'load': {
            if (!mv.vehicle) unmapped('적재 차량이 없다: ' + o.id);
            pushUnits(() => SHOP_LOCATION, vehicleLocation(mv.vehicle), o.id);
            break;
          }
          case 'deliver': {
            const van = ctx.envelope?.type === 'stock.deliver' ? taskVehicle(ctx, o, 'deliver') : undefined;
            pushUnits((a) => {
              const at = a ? assetLocation(ctx, a) : undefined;
              if (at && (at === SHOP_LOCATION || at.startsWith('vehicle:'))) return at;
              return van ? vehicleLocation(van) : SHOP_LOCATION;
            }, customer, o.id);
            break;
          }
          case 'direct_return':
            pushUnits(() => customer, SHOP_LOCATION, o.id);
            break;
          case 'collect': {
            if (!mv.vehicle) unmapped('수거 차량이 없다: ' + o.id);
            pushUnits(() => customer, vehicleLocation(mv.vehicle), o.id);
            break;
          }
          case 'receive': {
            const vehicle = receiveVehicle ?? collectVehicleOf(ctx, o, n);
            if (!vehicle) unmapped('입고 차량이 없다: ' + o.id);
            const from = vehicleLocation(vehicle);
            if (unit) {
              const assets = receiveAssets(ctx, n.id, mv.qty, from);
              if (assets.length !== mv.qty) unmapped('입고할 번호가 차량에 없다: ' + n.id);
              for (const a of assets) addLine('receive', from, SHOP_LOCATION, undefined, mv.at, { order: o, line: n, assetId: a, quantity: 1 });
            } else {
              addLine('receive', from, SHOP_LOCATION, undefined, mv.at, { order: o, line: n, quantity: mv.qty });
            }
            break;
          }
        }
      }
    }
  }

  movements.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  for (const m of movements) insertMovement(ctx, ids, m);
  return movements;
}

/** 입고 차량을 봉투로 모를 때(가져오기): 수거한 이동의 도착 차량. */
function collectVehicleOf(ctx: WriteContext, o: FxOrder, l: FxLine): string | undefined {
  const row = one(ctx.db, `SELECT loc.vehicle_id FROM stock_movement_lines ml JOIN stock_movements m ON m.shop_id = ml.shop_id AND m.id = ml.movement_id
    JOIN stock_locations loc ON loc.shop_id = m.shop_id AND loc.id = m.to_location_id WHERE ml.shop_id = ? AND ml.order_line_id = ? AND m.kind_key = 'collect'
    ORDER BY m.created_rev DESC LIMIT 1`, ctx.shopId, l.id);
  return text(row?.vehicle_id) ?? o.giveBack.vehicleId;
}

function insertMovement(ctx: WriteContext, ids: Ids, m: Movement): void {
  const id = ids('m');
  m.id = id;
  insert(ctx.db, 'stock_movements', {
    shop_id: ctx.shopId, id, kind_key: m.kind, from_location_id: m.from, from_kind_key: locationKind(ctx, m.from), to_location_id: m.to, to_kind_key: locationKind(ctx, m.to),
    order_id: m.orderId, ...factMeta(ctx, m.at),
  });
  m.lines.forEach((x, i) => {
    const variant = x.line.variantKey !== undefined ? variantId(x.line.kind, x.line.variantKey) : undefined;
    if (!x.assetId && !variant) unmapped('번호도 규격도 없는 이동 줄: ' + x.line.id);
    insert(ctx.db, 'stock_movement_lines', {
      shop_id: ctx.shopId, movement_id: id, line_no: i + 1, catalog_item_id: x.line.kind, asset_id: x.assetId, variant_id: variant, quantity: x.quantity,
      order_id: x.order.id, order_line_id: x.line.id,
      ...(x.assetId ? {} : { before_condition_id: OK_CONDITION, after_condition_id: OK_CONDITION }),
      created_rev: ctx.rev,
    });
    if (x.assetId) {
      run(ctx.db, 'UPDATE assets SET location_id = ?, last_movement_id = ?, updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?', m.to, id, ctx.rev, ctx.shopId, x.assetId);
    } else if (variant) {
      moveBalance(ctx, m.from, variant, -x.quantity);
      moveBalance(ctx, m.to, variant, x.quantity);
    }
  });
}

/** 수량 재고(stock_balances, 투영): 음수가 되면 0에 멈춘다(도메인은 고글 재고를 아직 막지 않는다). */
function moveBalance(ctx: WriteContext, location: string, variant: string, delta: number): void {
  const row = one(ctx.db, "SELECT quantity FROM stock_balances WHERE shop_id = ? AND location_id = ? AND variant_id = ? AND condition_id = ? AND owner_key = '' AND lot_key = ''",
    ctx.shopId, location, variant, OK_CONDITION);
  const value = Math.max(0, num(row?.quantity) + delta);
  if (row) {
    run(ctx.db, "UPDATE stock_balances SET quantity = ?, updated_rev = ? WHERE shop_id = ? AND location_id = ? AND variant_id = ? AND condition_id = ? AND owner_key = '' AND lot_key = ''",
      value, ctx.rev, ctx.shopId, location, variant, OK_CONDITION);
  } else {
    insert(ctx.db, 'stock_balances', { shop_id: ctx.shopId, location_id: location, variant_id: variant, condition_id: OK_CONDITION, quantity: value, updated_rev: ctx.rev });
  }
}

// ── 나눈 일정 몫(line_promise_fulfillments) ────────────────────────────

/**
 * 나눈 반납 일정의 몫(split.returned · collected · received가 늘어난 수)을 이 명령의 이동 줄에 붙인다: 그 줄 · 종류의 이동 줄 차례로.
 * activeSplitRow(order, line, schedule) = 지금 살아 있는 그 일정의 약속 행 id.
 */
export function writeFulfillments(ctx: WriteContext, movements: readonly Movement[], activeSplitRow: (orderId: string, lineId: string, schedule: string) => string | undefined): void {
  const kindOf = { returned: 'direct_return', collected: 'collect', received: 'receive' } as const;
  for (const o of ctx.after.orders) {
    const prev = ctx.before.orders.find((x) => x.id === o.id);
    for (const s of o.splits ?? []) {
      const ps = prev?.splits?.find((x) => x.id === s.id && x.lineId === s.lineId);
      for (const field of ['returned', 'collected', 'received'] as const) {
        let need = (s[field] ?? 0) - (ps?.[field] ?? 0);
        if (need < 0) unmapped('일정 몫의 ' + field + '이 줄었다');
        if (need === 0) continue;
        const promiseId = activeSplitRow(o.id, s.lineId, s.id) ?? unmapped('나눈 일정의 약속 행이 없다: ' + s.id);
        for (const m of movements) {
          if (m.kind !== kindOf[field]) continue;
          m.lines.forEach((x, i) => {
            if (need <= 0 || x.line.id !== s.lineId || x.order.id !== o.id) return;
            const used = num(one(ctx.db, 'SELECT sum(quantity) AS n FROM line_promise_fulfillments WHERE shop_id = ? AND movement_id = ? AND line_no = ?', ctx.shopId, m.id!, i + 1)?.n);
            const take = Math.min(need, x.quantity - used);
            if (take <= 0) return;
            insert(ctx.db, 'line_promise_fulfillments', { shop_id: ctx.shopId, movement_id: m.id!, line_no: i + 1, order_id: o.id, promise_id: promiseId, quantity: take, created_rev: ctx.rev });
            need -= take;
          });
        }
        if (need > 0) unmapped('일정 몫을 붙일 이동 줄이 모자라다: ' + s.id);
      }
    }
  }
}

// ── 준비 번호(asset_claims · asset_bindings) ──────────────────────────

function endClaim(ctx: WriteContext, claimId: string, bindingId: string | undefined, reason: string, movementId?: string): void {
  const at = isoOf(ctx.now);
  run(ctx.db, `UPDATE asset_claims SET ended_at = ?, end_reason_key = ?, ended_by = ?, fulfilled_at = ?, fulfilled_movement_id = ?, updated_rev = ?, version = version + 1
    WHERE shop_id = ? AND id = ?`, at, reason, ctx.actor.key, reason === 'fulfilled' ? at : null, movementId ?? null, ctx.rev, ctx.shopId, claimId);
  if (bindingId) run(ctx.db, 'UPDATE asset_bindings SET ended_at = ?, end_reason_key = ?, updated_rev = ?, version = version + 1 WHERE shop_id = ? AND id = ?', at, reason, ctx.rev, ctx.shopId, bindingId);
}

/** 준비 번호가 바뀐 줄: 살아 있는 claim을 끝내고 새 차례를 넣는다(이미 지급한 번호는 끝난 claim). 지급 이동은 그 번호의 claim을 끝낸다. */
export function writeClaims(ctx: WriteContext, ids: Ids, movements: readonly Movement[], prevLine: (o: FxOrder, l: FxLine) => FxLine): void {
  const at = isoOf(ctx.now);
  for (const o of ctx.after.orders) {
    for (const n of o.lines) {
      const p = prevLine(o, n);
      if (JSON.stringify(p.plannedAssetIds ?? []) === JSON.stringify(n.plannedAssetIds ?? [])) continue;
      if (!n.plannedAssetIds?.length) unmapped('준비 번호를 모두 지우는 바뀜: ' + n.id);
      for (const r of all(ctx.db, "SELECT id, binding_id FROM asset_claims WHERE shop_id = ? AND order_line_id = ? AND claim_type_key = 'preparation' AND ended_at IS NULL", ctx.shopId, n.id)) {
        endClaim(ctx, str(r.id), text(r.binding_id), 'released');
      }
      const given = new Set(n.assetIds ?? []);
      for (const assetId of n.plannedAssetIds) {
        const ended = given.has(assetId);
        const bindingId = ids('bd');
        insert(ctx.db, 'asset_bindings', {
          shop_id: ctx.shopId, id: bindingId, asset_id: assetId, purpose_key: 'order', order_id: o.id, created_at: at, created_by: ctx.actor.key, request_id: ctx.requestId,
          created_rev: ctx.rev, ...(ended ? { ended_at: at, end_reason_key: 'fulfilled' } : {}),
        });
        insert(ctx.db, 'asset_claims', {
          shop_id: ctx.shopId, id: ids('cl'), asset_id: assetId, binding_id: bindingId, claim_type_key: 'preparation', lane_key: 'preparation', lane_exclusive: 1, lane_bound: 1,
          exclusive_key: assetId + '|preparation', order_id: o.id, order_line_id: n.id, created_at: at, created_by: ctx.actor.key, request_id: ctx.requestId,
          created_rev: ctx.rev, ...(ended ? { ended_at: at, end_reason_key: 'fulfilled', ended_by: ctx.actor.key, fulfilled_at: at } : {}),
        });
      }
    }
  }
  for (const m of movements) {
    if (m.kind !== 'deliver') continue;
    m.lines.forEach((x) => {
      if (!x.assetId) return;
      const claim = one(ctx.db, "SELECT id, binding_id FROM asset_claims WHERE shop_id = ? AND asset_id = ? AND order_line_id = ? AND claim_type_key = 'preparation' AND ended_at IS NULL",
        ctx.shopId, x.assetId, x.line.id);
      if (claim) endClaim(ctx, str(claim.id), text(claim.binding_id), 'fulfilled', m.id);
    });
  }
}

// ── 되읽기 ──────────────────────────────────────────────────────────

/**
 * 줄마다 이동을 접어 수 셈 · 시각 · 번호를 채운다(도메인 명령의 셈과 같은 규칙), 준비 번호(마지막 차례의 claim), 나눈 일정 몫(약속 사슬의
 * 몫 합). 돌려주는 것: 매장 입고(vanReceipts, 입고 이동의 차례).
 */
export function loadStock(db: Db, shopId: string, orders: readonly FxOrder[], lineById: Map<string, FxLine>, chains: Map<string, string[]>): { vehicleId: string; at: number }[] {
  const rows = all(db, `SELECT m.id, m.kind_key, m.occurred_at, ml.order_line_id, ml.asset_id, ml.quantity FROM stock_movement_lines ml
    JOIN stock_movements m ON m.shop_id = ml.shop_id AND m.id = ml.movement_id
    WHERE ml.shop_id = ? AND ml.order_line_id IS NOT NULL ORDER BY m.created_rev, m.rowid, ml.line_no`, shopId);
  for (const r of rows) {
    const l = lineById.get(str(r.order_line_id));
    if (!l) continue;
    const q = num(r.quantity);
    const t = msOf(str(r.occurred_at));
    const asset = text(r.asset_id);
    switch (str(r.kind_key)) {
      case 'load':
        l.loaded = Math.max(l.loaded, l.issued) + q;
        l.loadedAt = t;
        break;
      case 'deliver':
        l.issued += q;
        l.issuedAt = t;
        if (asset) l.assetIds = [...(l.assetIds ?? []), asset];
        break;
      case 'direct_return':
        l.returned += q;
        l.returnedAt = t;
        if (asset) l.backAssetIds = [...(l.backAssetIds ?? []), asset];
        break;
      case 'collect':
        l.collected += q;
        l.collectedAt = t;
        if (asset) l.backAssetIds = [...(l.backAssetIds ?? []), asset];
        break;
      case 'receive':
        l.received += q;
        l.receivedAt = t;
        break;
    }
  }
  // 준비 번호: 줄마다 마지막 차례(가장 늦은 rev)의 claim, 넣은 차례.
  const claims = new Map<string, { rev: number; ids: string[] }>();
  for (const r of all(db, "SELECT order_line_id, asset_id, created_rev FROM asset_claims WHERE shop_id = ? AND claim_type_key = 'preparation' AND order_line_id IS NOT NULL ORDER BY rowid", shopId)) {
    const lineId = str(r.order_line_id);
    const rev = num(r.created_rev);
    const seen = claims.get(lineId);
    if (!seen || rev > seen.rev) claims.set(lineId, { rev, ids: [str(r.asset_id)] });
    else if (rev === seen.rev) seen.ids.push(str(r.asset_id));
  }
  for (const [lineId, c] of claims) {
    const l = lineById.get(lineId);
    if (l) l.plannedAssetIds = c.ids;
  }
  // 나눈 일정 몫.
  const byPromise = new Map<string, { returned: number; collected: number; received: number }>();
  for (const r of all(db, `SELECT f.promise_id, f.quantity, m.kind_key FROM line_promise_fulfillments f JOIN stock_movements m ON m.shop_id = f.shop_id AND m.id = f.movement_id
    WHERE f.shop_id = ?`, shopId)) {
    const sum = byPromise.get(str(r.promise_id)) ?? { returned: 0, collected: 0, received: 0 };
    const k = str(r.kind_key);
    if (k === 'direct_return') sum.returned += num(r.quantity);
    else if (k === 'collect') sum.collected += num(r.quantity);
    else if (k === 'receive') sum.received += num(r.quantity);
    byPromise.set(str(r.promise_id), sum);
  }
  for (const o of orders) {
    for (const s of o.splits ?? []) {
      const chain = chains.get(o.id + '|' + s.lineId + '|' + s.id) ?? [];
      const total = { returned: 0, collected: 0, received: 0 };
      for (const id of chain) {
        const x = byPromise.get(id);
        if (!x) continue;
        total.returned += x.returned;
        total.collected += x.collected;
        total.received += x.received;
      }
      if (total.returned > 0) s.returned = total.returned;
      if (total.collected > 0) s.collected = total.collected;
      if (total.received > 0) s.received = total.received;
    }
  }
  return all(db, `SELECT m.occurred_at, loc.vehicle_id FROM stock_movements m JOIN stock_locations loc ON loc.shop_id = m.shop_id AND loc.id = m.from_location_id
    WHERE m.shop_id = ? AND m.kind_key = 'receive' ORDER BY m.created_rev, m.rowid`, shopId).map((r) => ({ vehicleId: str(r.vehicle_id), at: msOf(str(r.occurred_at)) }));
}

/**
 * 번호 실물(쓰지 않게 된 것 빼고, 넣은 차례). 차량 예비권(vehicleId)은 차량에 있고 마지막 이동이 접수 없는 이동(처음 재고)인 번호다: 적재 ·
 * 수거로 차에 있는 번호는 그 접수의 것이라 예비권이 아니다.
 */
export function loadAssets(db: Db, shopId: string): FxAsset[] {
  return all(db, `SELECT a.id, a.catalog_item_id, a.serial_no, l.vehicle_id, m.order_id AS moved_for FROM assets a
    JOIN stock_locations l ON l.shop_id = a.shop_id AND l.id = a.location_id
    LEFT JOIN stock_movements m ON m.shop_id = a.shop_id AND m.id = a.last_movement_id
    WHERE a.shop_id = ? AND a.retired_at IS NULL ORDER BY a.rowid`, shopId).map((r: Row) => ({
    id: str(r.id), kind: str(r.catalog_item_id), no: str(r.serial_no),
    ...(text(r.vehicle_id) !== undefined && text(r.moved_for) === undefined ? { vehicleId: str(r.vehicle_id) } : {}),
  }));
}

/** 명령 앞뒤의 번호 실물 목록이 이동과 맞는지: 차량 예비권이 사라지는 것은 차량에서 지급한 번호만. 목록 자체는 늘거나 줄지 않는다. */
export function checkAssets(before: ShopState, after: ShopState, movements: readonly Movement[]): void {
  if (before.assets.length !== after.assets.length) unmapped('번호 실물 목록이 늘거나 줄었다');
  const fromVan = new Set(movements.filter((m) => m.kind === 'deliver' && m.from.startsWith('vehicle:')).flatMap((m) => m.lines.map((x) => x.assetId).filter((a): a is string => !!a)));
  before.assets.forEach((a, i) => {
    const b = after.assets[i]!;
    if (a.id !== b.id || a.kind !== b.kind || a.no !== b.no) unmapped('번호 실물의 차례 · 모양이 바뀌었다');
    if (a.vehicleId === b.vehicleId) return;
    if (a.vehicleId !== undefined && b.vehicleId === undefined && fromVan.has(a.id)) return;
    unmapped('차량 예비권이 이동 없이 바뀌었다: ' + a.id);
  });
}

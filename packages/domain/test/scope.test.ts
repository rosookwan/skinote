// 기사 기기의 차량 범위 사본(work/impl-offline/plan.md §5-4)이 기사 읽기 모델에 모자라지 않은지(판정 시험): 첫 매장 · 번호 매장의 견본 하루, 차량마다,
// 기사 세션이 읽는 모든 조회(수거 · 배달 목록 두 등급, 업무 판 · 현장 수납 · 리프트권 추가 · 확인 창 초안, 차량 짐, 열린 업무의 전화)가 사본과 전체 상태에서
// 같다. 무작위 기사 명령(보냄 대기 규칙) 30개를 둘 모두에 적용한 뒤, 카운터 명령을 전체에만 적용하고 다시 뽑은 사본(옮긴 업무의 대기 항목 포함)에서도.
import { describe, expect, it } from 'vitest';
import { DomainError, type ConfirmCommand, type LedgerViewResult } from '@skinote/contract';
import {
  allowedPendingTaskIds, applyCommand, fullNumberOrders, ledgerView, orderVans, overlayQueue, runQuery, vanOrderIds, vehicleScope, type ShopState,
} from '../src/index.ts';
import { at, ctx, envelopeOf, first, lines, moveToVan, numbered, online } from './offline-helpers.ts';

const NOW = at(21, 45);

/** 작은 난수(시험을 되풀이할 수 있게). */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

const safe = (read: () => unknown) => {
  try {
    return read();
  } catch (error) {
    return 'ERR:' + (error instanceof DomainError ? error.code : String(error));
  }
};

/** 기사 세션이 읽는 모든 것(한 차량). */
function driverReads(s: ShopState, vehicleId: string, now = NOW): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const taskIds = new Set<string>();
  const openOrders = new Set<string>();
  for (const deviceClass of ['driver_phone', 'driver_tablet'] as const) {
    for (const viewKey of ['collection_list', 'delivery_list']) {
      const view = safe(() => ledgerView(s, viewKey, { vehicleId, deviceClass }, ctx(now))) as LedgerViewResult;
      out[viewKey + ':' + deviceClass] = view;
      for (const row of typeof view === 'object' ? view.rows : []) {
        if (row.taskId) taskIds.add(row.taskId);
        if (row.orderId && !row.finished) openOrders.add(row.orderId);
      }
    }
  }
  for (const taskId of [...taskIds].sort()) {
    for (const deviceClass of ['driver_phone', 'driver_tablet'] as const) out['taskSheet:' + taskId + ':' + deviceClass] = safe(() => runQuery(s, 'taskSheet', { taskId, deviceClass }, ctx(now)));
    out['fieldPaySheet:' + taskId] = safe(() => runQuery(s, 'fieldPaySheet', { taskId }, ctx(now)));
    out['addTicketSheet:' + taskId] = safe(() => runQuery(s, 'addTicketSheet', { taskId }, ctx(now)));
    const actionKey = taskId.startsWith('deliver:') ? 'stamp.issue' : 'stamp.collect';
    out['confirmDraft:' + taskId] = safe(() => runQuery(s, 'confirmDraft', { actionKey, taskId, orderId: taskId.split(':')[1]! }, ctx(now)));
  }
  out.vehicleLoad = safe(() => runQuery(s, 'vehicleLoad', { vehicleId }, ctx(now)));
  return { reads: out, openOrders: [...openOrders].sort() };
}

function phoneReads(s: ShopState, orderIds: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(orderIds.map((id) => [id, safe(() => runQuery(s, 'phoneReveal', { orderId: id }, ctx(NOW)))]));
}

function sameReads(full: ShopState, vehicleId: string, pendingTaskIds: string[] = []): void {
  const scoped = vehicleScope(full, vehicleId, { staffId: 'staff-3', pendingTaskIds });
  const a = driverReads(full, vehicleId) as { reads: Record<string, unknown>; openOrders: string[] };
  const b = driverReads(scoped, vehicleId) as { reads: Record<string, unknown>; openOrders: string[] };
  for (const key of Object.keys(a.reads)) expect(JSON.stringify(b.reads[key]), vehicleId + ' ' + key).toBe(JSON.stringify(a.reads[key]));
  expect(b.openOrders).toEqual(a.openOrders);
  // 열린 업무의 전화: 온전한 번호가 같다.
  expect(phoneReads(scoped, a.openOrders)).toEqual(phoneReads(full, a.openOrders));
  for (const id of a.openOrders) expect(fullNumberOrders(scoped), id).toContain(id);
}

/** 무작위 기사 명령(보냄 대기) 하나. */
function randomDriverCommand(s: ShopState, vehicleId: string, pick: () => number): ConfirmCommand | null {
  const list = ledgerView(s, 'collection_list', { vehicleId, deviceClass: 'driver_phone' }, ctx(NOW));
  const deliveries = ledgerView(s, 'delivery_list', { vehicleId, deviceClass: 'driver_phone' }, ctx(NOW));
  const rows = [...list.rows, ...deliveries.rows].filter((r) => r.taskId);
  const row = rows[Math.floor(pick() * rows.length)];
  if (!row?.taskId || !row.orderId) return null;
  const taskId = row.taskId;
  const orderId = row.orderId;
  switch (Math.floor(pick() * 4)) {
    case 0: return taskId.startsWith('deliver:') ? { type: 'stock.deliver', payload: { taskId, lines: lines(s, orderId) } } : { type: 'stock.collect', payload: { taskId, lines: lines(s, orderId) } };
    case 1: return { type: 'task.visit', payload: { taskId, outcomeKey: 'customer_absent' } };
    case 2: return { type: 'field.collect', payload: { taskId, orderId, amount: 10_000, methodKey: 'cash' } };
    default: return { type: 'route.move', payload: { taskId, anchorTaskId: null, position: 'top' } };
  }
}

describe('vehicleScope is enough for every driver read model', () => {
  for (const [shop, make] of [['first', first], ['numbered', numbered]] as const) {
    for (const vehicleId of ['v1', 'v2']) {
      it(shop + ' ' + vehicleId + ': the sample day', () => sameReads(make(), vehicleId));
    }

    it(shop + ': after 30 random driver commands on both copies and counter commands on the full state', () => {
      const full = make();
      let scoped = vehicleScope(full, 'v1', { staffId: 'staff-3' });
      const pick = rng(shop === 'first' ? 7 : 11);
      for (let i = 0; i < 30; i += 1) {
        const command = randomDriverCommand(full, 'v1', pick);
        if (!command) continue;
        const env = envelopeOf(full, command, { deviceSeq: i + 1 });
        const now = NOW + i * 60_000;
        const opts = { orderIds: 'dated' as const, actor: { deviceId: 'dev-phone', name: '박기사' } };
        applyCommand(full, env, now, undefined, opts);
        applyCommand(scoped, structuredClone(env), now, undefined, opts);
      }
      // 사본에 적은 기사 명령의 결과가 전체와 같아 기사 읽기 모델도 같다.
      const direct = driverReads(scoped, 'v1') as { reads: Record<string, unknown> };
      const expected = driverReads(full, 'v1') as { reads: Record<string, unknown> };
      for (const key of Object.keys(expected.reads)) expect(JSON.stringify(direct.reads[key]), 'after driver commands ' + key).toBe(JSON.stringify(expected.reads[key]));
      // 카운터: 한 팀 매장 반납, 한 팀을 2호 차량으로 옮김, 한 팀 수납.
      online(full, { type: 'stock.direct_return', payload: { orderId: 'o21', lines: lines(full, 'o21') } }, NOW + 40 * 60_000);
      // 아직 아무것도 돌아오지 않은 1호 차량의 팀 하나를 2호 차량으로.
      const untouched = full.orders.find((o) => o.giveBack.vehicleId === 'v1' && o.lines.every((l) => l.issued > 0 && l.collected === 0 && l.returned === 0) && !(o.splits?.length));
      expect(untouched).toBeDefined();
      moveToVan(full, untouched!.id, 'v2', NOW + 41 * 60_000);
      scoped = vehicleScope(full, 'v1', { staffId: 'staff-3' });
      sameReads(full, 'v1');
      sameReads(full, 'v2');
      expect(scoped.orders.some((o) => o.id === untouched!.id)).toBe(false);
    });
  }

  it('a moved task with a pending item stays in the copy and its queued item still overlays', () => {
    const full = first();
    const collect = envelopeOf(full, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(full, 'o25') } }, { deviceSeq: 1 });
    moveToVan(full, 'o25', 'v2', at(22, 10));
    const scoped = vehicleScope(full, 'v1', { staffId: 'staff-3', pendingTaskIds: ['collect:o25'] });
    expect(scoped.orders.some((o) => o.id === 'o25')).toBe(true);
    // 옮긴 업무는 사본의 기사 판에 없지만 대기 항목은 겹쳐진다(옮긴 몫을 되돌림).
    const overlay = overlayQueue(scoped, [{ envelope: collect, at: at(21, 55), state: 'queued' }]);
    expect(overlay.unplaced).toEqual([]);
    expect(overlay.outcomes.get(collect.requestId)?.outcome).toBe('applied');
    expect(overlay.pendingTasks.has('collect:o25')).toBe(true);
  });

  it('forged pending task ids (another van, a store-only order) leave the copy unchanged; a known order keeps its place (§17 R3-8)', () => {
    const full = first();
    const plain = vehicleScope(full, 'v1', { staffId: 'staff-3' });
    const own = new Set(plain.orders.map((o) => o.id));
    const strangers = full.orders.filter((o) => !own.has(o.id) && !orderVans(o).includes('v1'));
    expect(strangers.length).toBeGreaterThan(1);
    expect(strangers.some((o) => orderVans(o).length === 0), 'a store-only order').toBe(true);
    const forged = strangers.flatMap((o) => ['collect:' + o.id, 'deliver:' + o.id]);
    expect(allowedPendingTaskIds(full, 'v1', forged)).toEqual([]);
    const copy = vehicleScope(full, 'v1', { staffId: 'staff-3', pendingTaskIds: forged });
    expect(copy.orders.map((o) => o.id)).toEqual(plain.orders.map((o) => o.id));
    expect(fullNumberOrders(copy)).toEqual(fullNumberOrders(plain));
    // 이 기기에 앞서 보낸 사본에 들었던 접수(옮겨져 이 차량과 끊김)는 남는다.
    const moved = strangers[0]!;
    const known = vehicleScope(full, 'v1', { staffId: 'staff-3', pendingTaskIds: ['collect:' + moved.id], knownOrderIds: new Set([moved.id]) });
    expect(known.orders.some((o) => o.id === moved.id)).toBe(true);
    // 없는 접수는 버린다(같은 id는 한 번).
    expect(allowedPendingTaskIds(full, 'v1', ['collect:o25', 'collect:o25', 'collect:nope'])).toEqual(['collect:o25']);
  });

  it('only orders tied to this van are remembered as sent: a payer-only team cannot pull the next team through a forged pending id (§17 R3-8)', () => {
    const full = first();
    const plain = vehicleScope(full, 'v1', { staffId: 'staff-3' });
    const own = new Set(plain.orders.map((o) => o.id));
    const mine = plain.orders.find((o) => orderVans(o).includes('v1'))!;
    const [payer, next] = full.orders.filter((o) => !own.has(o.id) && orderVans(o).length === 0);
    expect(payer && next, 'two store-only orders').toBeTruthy();
    // 매장만의 팀(payer)이 이 차량의 팀(mine)과 다른 매장 팀(next)을 대신 낸다.
    full.orders.find((o) => o.id === mine.id)!.payerOrderId = payer!.id;
    full.orders.find((o) => o.id === next!.id)!.payerOrderId = payer!.id;
    const ids = (s: ShopState) => s.orders.map((o) => o.id);
    const copy = vehicleScope(full, 'v1', { staffId: 'staff-3' });
    expect(ids(copy)).toContain(payer!.id);
    expect(ids(copy)).not.toContain(next!.id);
    const known = new Set(vanOrderIds(copy, 'v1'));
    expect(known.has(mine.id)).toBe(true);
    expect(known.has(payer!.id)).toBe(false);
    // 결제로만 든 접수의 위조한 대기 업무 id는 버린다: 다음 팀(next)을 끌어오지 않는다.
    const forged = vehicleScope(full, 'v1', { staffId: 'staff-3', pendingTaskIds: ['collect:' + payer!.id], knownOrderIds: known });
    expect(ids(forged)).toEqual(ids(copy));
  });

  it('privacy: only open orders of this van carry the full number; staff is the session’s own row; no reviews', () => {
    const full = first();
    full.orders.find((o) => o.id === 'o21')!.lines.forEach((l) => { l.returned = l.issued; });
    const scoped = vehicleScope(full, 'v1', { staffId: 'staff-3' });
    const o21 = scoped.orders.find((o) => o.id === 'o21');
    if (o21) expect(o21.phone).toContain('*');
    expect(scoped.staff?.map((x) => x.id)).toEqual(['staff-3']);
    expect(scoped.reviews).toEqual([]);
    expect(scoped.orders.every((o) => o.phone === '' || o.phone.includes('*') || fullNumberOrders(scoped).includes(o.id))).toBe(true);
    // 다른 차량(v2)의 사본에는 1호 차량의 팀이 없다.
    expect(vehicleScope(full, 'v2', { staffId: 'staff-4' }).orders.map((o) => o.id)).not.toContain('o25');
  });
});

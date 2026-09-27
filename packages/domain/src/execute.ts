// 입력을 고치지 않는 명령 실행(plan §3-4 · B2c의 첫 몫)과 서버가 권한 · 충돌에 쓰는 범위(B2d의 첫 몫: commandScope · queryScope ·
// conflictKeys). 서버 저장소(packages/store)는 execute가 돌려준 새 상태와 옛 상태를 비교해 표에 적는다(바뀐 것을 표로 옮기는 셈은 저장소
// 몫이다: store/src/write.ts). 메모리 어댑터는 지금처럼 applyCommand로 상태를 고친다.
//   - execute: 복사본에 applyCommand를 적용한다. 같은 요청번호의 멱등은 어댑터 몫이다(서버는 command_log). 앞 명령(dependsOn)의
//     결과는 문맥의 outcomeOf로 묻는다.
//   - commandScope: 명령이 닿는 차량(기사 세션의 '자기 차량' 규칙, 서버 permissions.js). 카운터 일(지급 · 매장 반납)은 매장 범위다.
//   - queryScope: 기사 세션이 여는 업무 판 · 확인 창 초안이 어느 차량의 업무인지.
//   - conflictKeys: sync 4-2의 충돌 키(intent 명령은 기준 뒤에 같은 키를 쓴 rev가 있으면 충돌, D12).
import type { AnyCommandEnvelope, QueryName } from '@skinote/contract';
import { applyCommand } from './commands.ts';
import type { ChangeSet, ExecContext, ExecResult } from './change.ts';
import { findDeliverTask, resolveTask } from './driver.ts';
import { linesOf } from './lines.ts';
import type { FxOrder, ShopState } from './model.ts';
import { orderTasks } from './promises.ts';
import { findOrder, isVehiclePickup, orderIdOfTask, pinTask } from './rules.ts';
import { settingsTouches } from './settings.ts';

const EMPTY: ChangeSet = { changes: [], touchedOrders: [], touchedTasks: [], touchedVehicles: [] };

/**
 * 명령 하나를 복사본에 적용한다(입력 상태는 그대로). 적용했으면 새 상태, 아니면 입력 상태를 돌려준다. 바뀐 것(ChangeSet)은 건드린
 * 접수만 적는다: 표로 옮기는 셈은 저장소가 옛 상태와 새 상태를 비교해 한다.
 */
export function execute(state: ShopState, envelope: AnyCommandEnvelope, ctx: ExecContext): ExecResult {
  const next = structuredClone(state);
  next.outcomes = {};
  for (const id of envelope.dependsOn ?? []) {
    const seen = ctx.outcomeOf(id);
    if (seen) next.outcomes[id] = { outcome: seen.outcome, requestId: id, rev: 0, asOfRev: 0, epoch: state.epoch, rebased: false, changes: [] };
  }
  // 명령을 한 사람: 서버의 행위자 key 'staff:<직원 id>'(세션에서 온다).
  const staffId = ctx.actor.key.startsWith('staff:') ? ctx.actor.key.slice('staff:'.length) : undefined;
  const outcome = applyCommand(next, envelope, ctx.now, linesOf(ctx), {
    orderIds: ctx.orderIds ?? 'sequence',
    actor: { ...(staffId ? { staffId } : {}), name: ctx.actor.name, ...(ctx.actor.deviceId ? { deviceId: ctx.actor.deviceId } : {}) },
    ...(ctx.viewer ? { viewer: ctx.viewer } : {}),
  });
  next.outcomes = {};
  // 적은 것이 확인 필요뿐인 명령(이미 매장에 반납된 보냄 대기 수거: 결과는 superseded)도 새 상태를 돌려준다(features-1 E18).
  const applied = outcome.outcome === 'applied' || outcome.outcome === 'partially_applied' || (next.reviews?.length ?? 0) > (state.reviews?.length ?? 0);
  if (!applied) return { outcome, changes: EMPTY, state };
  const before = new Map(state.orders.map((o) => [o.id, o]));
  const touchedOrders = next.orders.filter((o) => before.get(o.id) !== undefined ? JSON.stringify(before.get(o.id)) !== JSON.stringify(o) : true).map((o) => o.id);
  return { outcome, changes: { ...EMPTY, touchedOrders }, state: next };
}

// ── 범위 ─────────────────────────────────────────────────────────────

/** 명령이 닿는 범위: 매장, 또는 차량(그 업무 · 접수가 걸린 차량들)과 접수. */
export type CommandScope = { kind: 'shop' } | { kind: 'vehicle'; vehicleIds: string[]; orderId?: string };
/** 조회가 닿는 범위. null = 모름(없는 업무 · 접수: 기사 세션은 거절). */
export type QueryScope = { kind: 'shop' } | { kind: 'vehicle'; vehicleIds: string[] };

const unique = (ids: (string | undefined)[]): string[] => [...new Set(ids.filter((id): id is string => typeof id === 'string'))];

/** 접수의 차량 업무(배달 · 수거)가 걸린 차량. */
function orderVehicles(o: FxOrder): string[] {
  return unique([...(isVehiclePickup(o) ? [o.pickup.vehicleId] : []), ...orderTasks(o).map((t) => t.promise.vehicleId)]);
}

/** 업무 id의 차량(배달 · 수거). 업무가 없으면 빈 목록. */
function taskVehicles(state: ShopState, taskId: string): string[] {
  const t = resolveTask(state, taskId) ?? findDeliverTask(state, taskId);
  return t ? unique([t.promise.vehicleId]) : [];
}

const vehicleScope = (vehicleIds: string[], orderId?: string): CommandScope => ({ kind: 'vehicle', vehicleIds, ...(orderId ? { orderId } : {}) });

export function commandScope(state: ShopState, envelope: AnyCommandEnvelope): CommandScope {
  switch (envelope.type) {
    case 'stock.load': {
      // 카운터의 예비권 적재(features-1 E21)는 그 차량. 배달 업무의 적재는 그 업무의 차량.
      const p = envelope.payload;
      if ('spares' in p) return vehicleScope([p.vehicleId]);
      return vehicleScope(taskVehicles(state, p.taskId), orderIdOfTask(p.taskId));
    }
    case 'stock.deliver':
    case 'stock.collect':
    case 'task.visit':
    case 'route.move':
    case 'field.collect':
    case 'field.add_ticket':
    case 'field.deposit_return': {
      const taskId = envelope.payload.taskId;
      return vehicleScope(taskVehicles(state, taskId), orderIdOfTask(taskId));
    }
    case 'stock.receive':
    case 'cash.transfer':
    case 'route.reset':
      return vehicleScope([envelope.payload.vehicleId]);
    case 'notification.ack': {
      const pin = state.pins.find((p) => p.id === envelope.payload.notificationId);
      const task = pin ? pinTask(state, pin) : undefined;
      return vehicleScope(task?.promise.vehicleId ? [task.promise.vehicleId] : [], pin?.orderId);
    }
    case 'payment_promise.set': {
      const o = findOrder(state, envelope.payload.orderId);
      return vehicleScope(o ? orderVehicles(o) : [], envelope.payload.orderId);
    }
    default:
      return { kind: 'shop' };
  }
}

/** 기사 세션의 조회가 닿는 차량(업무 판 · 현장 수납 · 리프트권 추가 · 확인 창 초안 · 차량 짐). 그 밖은 매장. */
export function queryScope(state: ShopState, name: QueryName | 'config' | 'ledgerView', params: unknown): QueryScope | null {
  const p = (params ?? {}) as { taskId?: unknown; orderId?: unknown; vehicleId?: unknown };
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  switch (name) {
    case 'taskSheet':
    case 'fieldPaySheet':
    case 'addTicketSheet': {
      const taskId = text(p.taskId);
      const vehicles = taskId ? taskVehicles(state, taskId) : [];
      return vehicles.length ? { kind: 'vehicle', vehicleIds: vehicles } : null;
    }
    case 'vehicleLoad': {
      const vehicleId = text(p.vehicleId);
      return vehicleId ? { kind: 'vehicle', vehicleIds: [vehicleId] } : null;
    }
    case 'phoneReveal': {
      // 전화 창(features-1 §8-4): 기사 세션은 자기 차량의 업무(배달 · 수거)가 있는 접수만.
      const o = findOrder(state, text(p.orderId));
      return o ? { kind: 'vehicle', vehicleIds: orderVehicles(o) } : null;
    }
    case 'confirmDraft': {
      const taskId = text(p.taskId);
      if (taskId) {
        const vehicles = taskVehicles(state, taskId);
        return vehicles.length ? { kind: 'vehicle', vehicleIds: vehicles } : null;
      }
      const vehicleId = text(p.vehicleId);
      if (vehicleId) return { kind: 'vehicle', vehicleIds: [vehicleId] };
      const o = findOrder(state, text(p.orderId));
      return o ? { kind: 'vehicle', vehicleIds: orderVehicles(o) } : null;
    }
    default:
      return { kind: 'shop' };
  }
}

// ── 충돌 키(sync 4-2) ────────────────────────────────────────────────

export interface ConflictKeys {
  writes: string[];
  reads: string[];
}

/** 운영 규칙(매장 설정 V8)의 키. */
export const SHOP_RULES_KEY = 'registry:shop_rules';

const moneyKey = (orderId: string) => 'order:' + orderId + ':money';

/**
 * 명령의 충돌 키: 쓰는 키(적용하면 intent_marks에 남는다)와 읽는 키. intent 명령(일정 변경 · 결제 팀 · 마감 · 매장 설정)은 기준(basis.rev)
 * 뒤에 이 키들을 쓴 rev가 있으면 충돌이다. 사실 명령(수납 · 보증금 …)은 쓰는 키만 남겨 돈을 보고 한 결정을 충돌시킨다.
 */
export function conflictKeys(state: ShopState, envelope: AnyCommandEnvelope): ConflictKeys {
  switch (envelope.type) {
    case 'setting.set':
      return { writes: [SHOP_RULES_KEY], reads: [SHOP_RULES_KEY] };
    case 'registry.update':
    case 'staff.set': {
      // 건드리는 목록 행마다(E19): 다른 사람이 그 행을 먼저 바꿨으면 충돌(창을 다시 연다).
      const keys = settingsTouches(envelope.payload.changes, envelope.requestId, envelope.dependsOn?.[0]);
      return { writes: keys, reads: keys };
    }
    case 'promise.change': {
      const keys = envelope.payload.lines.map((l) => 'line:' + l.lineId + ':return_promise');
      return { writes: keys, reads: keys };
    }
    case 'task.visit': {
      const o = findOrder(state, orderIdOfTask(envelope.payload.taskId));
      const kind = envelope.payload.taskId.startsWith('deliver:') ? 'pickup_promise' : 'return_promise';
      return { writes: (o?.lines ?? []).map((l) => 'line:' + l.id + ':' + kind), reads: [] };
    }
    case 'payment_promise.set':
      return { writes: ['order:' + envelope.payload.orderId + ':payer'], reads: [moneyKey(envelope.payload.orderId)] };
    case 'closing.close':
      return { writes: ['closing:main:' + envelope.payload.date], reads: [] };
    case 'payment.take':
      return { writes: unique([...envelope.payload.orderIds, ...(envelope.payload.allocations ?? []).map((a) => a.orderId)]).map(moneyKey), reads: [] };
    case 'discount.apply': {
      // 할인 적용(E19): 그 칸 줄의 값을 쓰고, 받을 돈과 그 줄의 수량을 읽는다.
      const o = findOrder(state, envelope.payload.orderId);
      const lines = (o?.lines ?? []).filter((l) => l.section === envelope.payload.sectionKey);
      return {
        writes: [...lines.map((l) => 'line:' + l.id + ':price'), moneyKey(envelope.payload.orderId)],
        reads: [moneyKey(envelope.payload.orderId), ...lines.map((l) => 'line:' + l.id + ':quantity')],
      };
    }
    case 'payment.refund':
      return { writes: [moneyKey(envelope.payload.orderId)], reads: [] };
    case 'order.cancel': {
      // 접수 취소 · 품목 취소(E19): 취소한 줄의 수량과 돈을 쓰고, 돈과 그 줄의 값(할인 적용이 바꿈)을 읽는다. 접수 취소는 모든 줄.
      const o = findOrder(state, envelope.payload.orderId);
      const ids = envelope.payload.scope === 'order' ? (o?.lines ?? []).map((l) => l.id) : unique(envelope.payload.lines.map((l) => l.lineId));
      return {
        writes: [...ids.map((id) => 'line:' + id + ':quantity'), moneyKey(envelope.payload.orderId)],
        reads: [moneyKey(envelope.payload.orderId), ...ids.map((id) => 'line:' + id + ':price')],
      };
    }
    case 'order.add': {
      // 품목 추가(E19): 새 줄과 돈을 쓴다. 칸의 비율 할인을 이어받으므로 있는 줄의 값(할인 적용이 바꿈)을 읽는다.
      const o = findOrder(state, envelope.payload.orderId);
      return {
        writes: ['order:' + envelope.payload.orderId + ':lines', moneyKey(envelope.payload.orderId)],
        reads: (o?.lines ?? []).map((l) => 'line:' + l.id + ':price'),
      };
    }
    case 'stock.issue':
    case 'stock.direct_return':
    case 'stock.collect':
    case 'stock.deliver':
      // 지급 · 반납 · 수거 · 배달(사실): 그 줄의 수량을 쓴다(그 뒤의 취소 · 할인 창이 옛 수로 확정하지 않게, E19).
      return { writes: unique(envelope.payload.lines.map((l) => 'line:' + l.lineId + ':quantity')), reads: [] };
    case 'exchange.swap':
      // 즉시 교환(E19): 그 줄의 수량을 읽는다(그사이 반납 · 취소로 바뀐 수는 도메인이 다시 본다).
      return { writes: [], reads: ['line:' + envelope.payload.lineId + ':quantity'] };
    case 'stock.write_off':
    case 'asset.found':
      // 분실 처리 · 분실 회수(E19): 그 줄의 수량을 쓴다(수거 예정이 줄거나 되살아난다).
      return { writes: unique(envelope.payload.lines.map((l) => 'line:' + l.lineId + ':quantity')), reads: [] };
    case 'stock.load':
      // 예비권 적재(E21): 그 차량의 예비권. 배달 적재는 사실이라 키가 없다.
      return 'spares' in envelope.payload ? { writes: ['vehicle:' + envelope.payload.vehicleId + ':spares'], reads: [] } : { writes: [], reads: [] };
    case 'stock.receive':
      return envelope.payload.spares?.length ? { writes: ['vehicle:' + envelope.payload.vehicleId + ':spares'], reads: [] } : { writes: [], reads: [] };
    case 'review.resolve': {
      // 확인 필요 처리(E19): 그 한 건. 다른 사람이 먼저 끝냈으면 충돌(창은 목록을 다시 읽는다).
      const key = 'review:' + envelope.payload.reviewId;
      return { writes: [key], reads: [key] };
    }
    case 'field.collect':
    case 'field.add_ticket':
      return { writes: [moneyKey(envelope.payload.orderId)], reads: [] };
    case 'deposit.take':
      return { writes: ['deposit:' + envelope.payload.orderId + ':' + envelope.payload.ruleKey], reads: [] };
    case 'deposit.return':
    case 'field.deposit_return':
      return { writes: ['deposit:' + envelope.payload.orderId + ':' + envelope.payload.ruleKey, moneyKey(envelope.payload.orderId)], reads: [] };
    default:
      return { writes: [], reads: [] };
  }
}

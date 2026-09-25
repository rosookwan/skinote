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
  const outcome = applyCommand(next, envelope, ctx.now, linesOf(ctx), { orderIds: ctx.orderIds ?? 'sequence' });
  next.outcomes = {};
  const applied = outcome.outcome === 'applied' || outcome.outcome === 'partially_applied';
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
    case 'stock.load':
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

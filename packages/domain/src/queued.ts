// 보냄 대기로 온 기사 기록(queued facts, sync 8-3 · 8-12, work/impl-offline/plan.md §5-1 · O7). 기기에서 이미 일어난 일이라 서버는 되도록 적고
// 거절하지 않는다: epoch · 앞 명령 · 돈의 바탕(expect)은 보지 않고, 그사이 바뀐 것은 확인 필요로 남긴다. 봉투에 기기 번호(deviceSeq)가 있으면
// 보냄 대기 기록이다. 서버 · 기사 기기의 겹치기(overlay.ts) · 메모리 어댑터가 같은 규칙을 쓴다.
//   - 업무의 차량은 업무 id 자체로 정한다(queuedCommandScope): 차량을 옮기면 새 나눈 일정 id가 생기므로 업무 id의 차량은 바뀌지 않는다 —
//     기사가 본 때 그 업무를 가진 차량이다.
//   - 옮겨진 몫 되돌리기(pullBackMoved): 수거한 뒤에 다른 차량으로 옮긴 몫(나눈 일정이 수거보다 늦게 생김)은 이 업무로 되돌린다. 다른 차량이 이미
//     받은 수는 건드리지 않는다(손님에게 남은 것만). 수량 줄만(번호 줄은 번호가 이미 가려 준다).
import type { AnyCommandEnvelope, CommandEnvelope } from '@skinote/contract';
import { numbered } from './assets.ts';
import type { FxOrder, FxPromise, ShopState } from './model.ts';
import { bucketOut, findTask, lineBuckets, orderTasks, splitRow, taskBucket } from './promises.ts';
import { storeReview } from './review-store.ts';
import type { ReviewActor } from './reviews.ts';
import { findOrder, isDeliverTaskId, isVehiclePickup, orderIdOfTask, pinTask, vehicleLabel } from './rules.ts';
import { businessDateOf, shopCutoff } from './time.ts';

/** 보냄 대기로 온 기록인지(기기 번호가 있음). */
export const isQueued = (envelope: { deviceSeq?: number }): boolean => envelope.deviceSeq !== undefined;

/** 업무 id의 나눈 일정 id(원래 일정 · 배달은 null). */
const splitKeyOf = (taskId: string): string | null => (isDeliverTaskId(taskId) ? null : taskId.split(':')[2] ?? null);

/**
 * 업무 id 자체의 차량: 배달은 수령 일정의 차량, 원래 일정 수거는 반납 일정의 차량, 나눈 일정 수거는 그 일정의 차량. 모르면 undefined(없는 접수 ·
 * 사라진 나눈 일정).
 */
export function taskIdVehicle(state: ShopState, taskId: string): string | undefined {
  const o = findOrder(state, orderIdOfTask(taskId));
  if (!o) return undefined;
  if (isDeliverTaskId(taskId)) return o.pickup.mode === 'vehicle' ? o.pickup.vehicleId : undefined;
  const key = splitKeyOf(taskId);
  if (!key) return o.giveBack.mode === 'vehicle' ? o.giveBack.vehicleId : undefined;
  const row = (o.splits ?? []).find((s) => s.id === key);
  return row?.promise.mode === 'vehicle' ? row.promise.vehicleId : undefined;
}

/** 접수가 이어진 차량(배달의 차량 · 수거 업무의 차량들): 기사 세션이 온라인으로 그 접수를 읽을 수 있는 차량과 같다(execute.ts queryScope). */
export function orderVans(o: FxOrder): string[] {
  return [...new Set([...(isVehiclePickup(o) ? [o.pickup.vehicleId] : []), ...orderTasks(o).map((t) => t.promise.vehicleId)].filter((v): v is string => typeof v === 'string'))];
}

/**
 * 보냄 대기 기록이 닿는 범위: 차량(업무 id 자체의 차량) · 접수. 서버의 보냄 대기 권한 확인이 쓴다(sync 8-12). 업무 id의 차량을 모르면(사라진 나눈
 * 일정 · 차량에서 매장으로 바꾼 일정) 그 접수가 이어진 차량으로 본다. 그것도 없으면(매장만의 접수 · 없는 접수) 빈 목록이고, 서버는 업무에 묶인 기록의
 * 빈 목록을 범위 밖으로 본다(§17 R3-10).
 */
export function queuedCommandScope(state: ShopState, envelope: AnyCommandEnvelope): { kind: 'vehicle'; vehicleIds: string[]; orderId?: string } {
  const vehicles = (ids: (string | undefined)[]) => [...new Set(ids.filter((x): x is string => typeof x === 'string'))];
  switch (envelope.type) {
    case 'stock.collect':
    case 'stock.deliver':
    case 'task.visit':
    case 'route.move':
    case 'field.collect':
    case 'field.add_ticket':
    case 'field.deposit_return': {
      const taskId = envelope.payload.taskId;
      const orderId = orderIdOfTask(taskId);
      const own = taskIdVehicle(state, taskId);
      const o = own === undefined ? findOrder(state, orderId) : undefined;
      return { kind: 'vehicle', vehicleIds: own !== undefined ? [own] : o ? orderVans(o) : [], ...(orderId ? { orderId } : {}) };
    }
    case 'route.reset':
      return { kind: 'vehicle', vehicleIds: [envelope.payload.vehicleId] };
    case 'notification.ack': {
      const pin = state.pins.find((p) => p.id === envelope.payload.notificationId);
      const task = pin ? pinTask(state, pin) : undefined;
      const byId = pin?.taskId ? taskIdVehicle(state, pin.taskId) : pin ? taskIdVehicle(state, 'collect:' + pin.orderId) : undefined;
      return { kind: 'vehicle', vehicleIds: pin?.vehicleId ? [pin.vehicleId] : vehicles([task?.promise.vehicleId, byId]), ...(pin ? { orderId: pin.orderId } : {}) };
    }
    default:
      return { kind: 'vehicle', vehicleIds: [] };
  }
}

/** 옮긴 몫을 되돌린 것 하나(어느 차량의 일정에서 몇 개). */
export interface PulledBack {
  vehicleId: string;
  qty: number;
}

/**
 * 보냄 대기 수거(stock.collect)가 받은 수보다 이 업무에 남은 수가 적고, 그 차이가 수거한 뒤(일어난 때 now 뒤)에 다른 차량으로 옮긴 나눈 일정에 있으면
 * 그 몫을 이 업무로 되돌린다(§5-1: 옮긴 사이에 받은 것). 다른 차량이 이미 받은 수는 그대로 둔다(bucketOut: 손님에게 남은 것만). 이 업무가 나눈
 * 일정인데 그 일정이 사라졌으면 되돌리지 않는다. 되돌린 것(차량 · 수)을 돌려준다.
 */
export function pullBackMoved(state: ShopState, envelope: CommandEnvelope<'stock.collect'>, now: number): PulledBack[] {
  const p = envelope.payload;
  const o = findOrder(state, orderIdOfTask(p.taskId));
  const vehicle = taskIdVehicle(state, p.taskId);
  if (!o || !vehicle || isDeliverTaskId(p.taskId)) return [];
  const key = splitKeyOf(p.taskId);
  const own = key ? (o.splits ?? []).find((s) => s.id === key) : undefined;
  if (key && !own) return [];
  const pulled = new Map<string, number>();
  for (const entry of p.lines) {
    const l = o.lines.find((x) => x.id === entry.lineId);
    if (!l || !l.returnable || numbered(l) || entry.assetIds?.length) continue;
    const task = findTask(state, p.taskId);
    const bucket = task ? taskBucket(task, l) : undefined;
    let need = Math.max(0, Math.floor(entry.quantity)) - (bucket ? bucketOut(bucket) : 0);
    if (need <= 0) continue;
    // 늦게 생긴 나눈 일정부터(가장 최근에 옮긴 것).
    const others = lineBuckets(o, l)
      .filter((b) => b.key !== null && b.key !== key && b.promise.mode === 'vehicle' && b.promise.vehicleId !== vehicle)
      .map((b) => ({ b, row: splitRow(o, b.key!, l.id) }))
      .filter((x): x is { b: typeof x.b; row: NonNullable<typeof x.row> } => x.row !== undefined && x.row.at > now)
      .sort((a, b) => b.row.at - a.row.at);
    for (const { b, row } of others) {
      if (need <= 0) break;
      const take = Math.min(need, bucketOut(b));
      if (take <= 0) continue;
      row.quantity -= take;
      need -= take;
      const from = b.promise.vehicleId ?? '';
      pulled.set(from, (pulled.get(from) ?? 0) + take);
      if (key && own) {
        let mine = splitRow(o, key, l.id);
        if (!mine) {
          mine = { id: key, lineId: l.id, quantity: 0, promise: { ...own.promise }, at: own.at };
          o.splits = [...(o.splits ?? []), mine];
        }
        mine.quantity += take;
      }
    }
  }
  if (pulled.size) o.splits = (o.splits ?? []).filter((s) => s.quantity > 0);
  return [...pulled].map(([vehicleId, qty]) => ({ vehicleId, qty }));
}

/** 옮긴 몫을 되돌린 수거의 확인 필요 `업무 차량 변경 확인`(차량마다 한 건). */
export function movedMeanwhileReviews(state: ShopState, o: FxOrder, envelope: AnyCommandEnvelope, taskId: string, pulled: readonly PulledBack[], now: number): void {
  const from = vehicleLabel(state.registry, taskIdVehicle(state, taskId));
  pulled.forEach((x, i) => {
    storeReview(state, {
      id: envelope.requestId + ':m' + (i + 1), kindKey: 'task_moved_meanwhile', params: { team: o.teamName, from_vehicle: from, to_vehicle: vehicleLabel(state.registry, x.vehicleId) },
      orderId: o.id, taskId, source: 'sync', createdAt: now,
    });
  });
}

/** 늦게 온 돈(§5-2): 그 영업일을 마감한 뒤 적혔으면 기록일(다음 열린 날)과 영업일. 아니면 null. */
export function lateMoneyDays(state: ShopState, at: number, recordedAt: number | undefined, postingDate: (state: ShopState, ms: number, recordedAt?: number) => string):
  { day: string; posting: string } | null {
  if (recordedAt === undefined || recordedAt === at) return null;
  const day = businessDateOf(at, shopCutoff(state.settings));
  const posting = postingDate(state, at, recordedAt);
  return posting === day ? null : { day, posting };
}

const monthDay = (date: string) => { const [, m = '1', d = '1'] = date.split('-'); return Number(m) + '월 ' + Number(d) + '일'; };
const amountText = (n: number) => Math.round(n).toLocaleString('ko-KR');

/** 마감 뒤에 온 돈의 확인 필요 `마감 후 수납`(`… 팀 35,000원 · 마감일(12월 26일) 수납 · 12월 27일 마감 반영`). */
export function lateMoneyReview(state: ShopState, o: FxOrder, envelope: AnyCommandEnvelope, amount: number, days: { day: string; posting: string }, now: number, actor: ReviewActor | undefined): void {
  const taskId = (envelope.payload as { taskId?: string }).taskId;
  storeReview(state, {
    id: envelope.requestId + ':l1', kindKey: 'late_money', params: { team: o.teamName, amount: amountText(amount), day: monthDay(days.day), posting_day: monthDay(days.posting) },
    orderId: o.id, ...(taskId ? { taskId } : {}), source: 'sync', createdAt: now, ...(actor?.deviceId ? { targetDeviceId: actor.deviceId } : {}),
  });
}

/** 보냄 대기 기록의 업무를 찾지 못했을 때(옮겨짐 · 끝남) 기록이 가리키는 업무의 모양(확인 필요를 그 업무 id로 남기려고). */
export function ghostTask(o: FxOrder, taskId: string): { id: string; order: FxOrder; key: string | null; promise: FxPromise } {
  return { id: taskId, order: o, key: splitKeyOf(taskId), promise: o.giveBack };
}

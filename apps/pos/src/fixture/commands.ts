// FixtureClient가 받는 명령(sync 2절의 봉투). 같은 요청번호가 다시 오면 다시 하지 않고 처음 결과를 돌려준다(멱등).
// 돈 명령은 창이 본 받을 돈(expect)이 없으면 거절하고, 지금과 다르면 충돌로 돌려보낸다. 체험 자료에 필요한 만큼만 한다.
// 봉투는 종류(type)로 가르면 본문(payload)의 모양이 정해진다(AnyCommandEnvelope): 형 변환 없이 읽는다.
import { MONEY_COMMANDS, type AnyCommandEnvelope, type CommandOutcome, type CommandOutcomeKey, type CommandPayloads, type CommandType } from '@skinote/contract';
import type { FxMethodKey, FxOrder, FxState, FxVisitOutcome } from './model.ts';
import {
  backCount, collectDone, collectTaskId, findOrder, isVehiclePickup, onVan, openPins, orderIdOfTask, ownDue, routeOrders, slotKey,
  sortRoute, VISIT_OUTCOMES,
} from './rules.ts';

const KEEP_OUTCOMES = 300;

type Result = { outcome: CommandOutcomeKey; error?: { code: string; message: string } };

const done: Result = { outcome: 'applied' };
const nothing = (message: string): Result => ({ outcome: 'superseded', error: { code: 'NOTHING_LEFT', message } });
const rejected = (message: string): Result => ({ outcome: 'rejected', error: { code: 'NOT_AVAILABLE', message } });

type StockLines = CommandPayloads['stock.issue']['lines'];

const METHODS: readonly FxMethodKey[] = ['card', 'cash', 'transfer'];
const isMethod = (key: string): key is FxMethodKey => (METHODS as readonly string[]).includes(key);
const isVisitOutcome = (key: string): key is FxVisitOutcome => key in VISIT_OUTCOMES;

/** 줄마다 남은 만큼만 옮긴다. 하나라도 옮겼으면 true. */
function moveStock(o: FxOrder, lines: StockLines, left: (lineId: string) => number, apply: (lineId: string, qty: number) => void): boolean {
  let moved = false;
  for (const entry of lines) {
    const take = Math.min(Math.max(0, Math.floor(entry.quantity)), left(entry.lineId));
    if (take <= 0) continue;
    apply(entry.lineId, take);
    moved = true;
  }
  return moved && o.lines.length > 0;
}

function lineOf(o: FxOrder, lineId: string) {
  return o.lines.find((l) => l.id === lineId);
}

function run(state: FxState, envelope: AnyCommandEnvelope, now: number): Result {
  switch (envelope.type) {
    case 'stock.issue': {
      const p = envelope.payload;
      const o = findOrder(state, p.orderId);
      if (!o) return rejected('접수 없음');
      const moved = moveStock(o, p.lines, (id) => { const l = lineOf(o, id); return l ? l.qty - l.issued : 0; }, (id, qty) => {
        const l = lineOf(o, id)!;
        l.issued += qty;
        l.issuedAt = now;
        if (isVehiclePickup(o)) l.loaded = Math.max(l.loaded, l.issued);
      });
      return moved ? done : nothing('지급 완료');
    }
    case 'stock.direct_return': {
      const p = envelope.payload;
      const o = findOrder(state, p.orderId);
      if (!o) return rejected('접수 없음');
      const moved = moveStock(o, p.lines, (id) => { const l = lineOf(o, id); return l && l.returnable ? l.issued - backCount(l) : 0; }, (id, qty) => {
        const l = lineOf(o, id)!;
        l.returned += qty;
        l.returnedAt = now;
      });
      return moved ? done : nothing('반납 완료');
    }
    case 'stock.load': {
      const p = envelope.payload;
      const o = findOrder(state, orderIdOfTask(p.taskId));
      if (!o) return rejected('업무 없음');
      const moved = moveStock(o, p.lines, (id) => { const l = lineOf(o, id); return l ? l.qty - Math.max(l.loaded, l.issued) : 0; }, (id, qty) => {
        const l = lineOf(o, id)!;
        l.loaded = Math.max(l.loaded, l.issued) + qty;
        l.loadedAt = now;
      });
      return moved ? done : nothing('적재 완료');
    }
    case 'stock.collect': {
      const p = envelope.payload;
      const o = findOrder(state, orderIdOfTask(p.taskId));
      if (!o) return rejected('업무 없음');
      const moved = moveStock(o, p.lines, (id) => { const l = lineOf(o, id); return l && l.returnable ? l.issued - backCount(l) : 0; }, (id, qty) => {
        const l = lineOf(o, id)!;
        l.collected += qty;
        l.collectedAt = now;
      });
      return moved ? done : nothing('수거 완료');
    }
    case 'payment.take': {
      const p = envelope.payload;
      const targets = p.orderIds.map((id) => findOrder(state, id)).filter((o): o is FxOrder => o !== undefined);
      if (targets.length !== p.orderIds.length) return rejected('접수 없음');
      const current = targets.reduce((sum, o) => sum + ownDue(o), 0);
      if (current === 0) return nothing('받을 금액 없음');
      if (envelope.expect?.dueAmount !== undefined && envelope.expect.dueAmount !== current) {
        return { outcome: 'conflict', error: { code: 'DUE_CHANGED', message: '받을 금액 변경됨 · 재시도 필요' } };
      }
      const methodKey = p.methodKey;
      if (!isMethod(methodKey)) return rejected('등록되지 않은 결제 수단');
      let rest = Math.min(p.amount, current);
      targets.forEach((o, i) => {
        const share = Math.min(ownDue(o), rest);
        if (share <= 0) return;
        o.payments.push({ id: envelope.requestId + ':' + i, amount: share, methodKey, at: now, groupId: envelope.requestId });
        rest -= share;
      });
      return done;
    }
    case 'stock.receive': {
      // 매장 입고: 차에 있는 것(받은 것 − 내려놓은 것)을 매장으로. 업무마다 남은 만큼만.
      const p = envelope.payload;
      let moved = false;
      for (const taskId of p.taskIds) {
        const o = findOrder(state, orderIdOfTask(taskId));
        if (!o || o.giveBack.vehicleId !== p.vehicleId) continue;
        for (const l of o.lines) {
          const take = onVan(l);
          if (take <= 0) continue;
          l.received = (l.received ?? 0) + take;
          l.receivedAt = now;
          moved = true;
        }
      }
      return moved ? done : nothing('입고 대상 없음');
    }
    case 'route.move': {
      // ▲ · ▼ · 맨 위로(sync 4-5): 기준 업무 앞 · 뒤로. 지금 순서에서 자리를 정하고, 첫 손 이동이면 경로 전체에 순위를 쓴다.
      const p = envelope.payload;
      const o = findOrder(state, orderIdOfTask(p.taskId));
      const anchor = p.anchorTaskId ? findOrder(state, orderIdOfTask(p.anchorTaskId)) : undefined;
      if (!o || !o.giveBack.vehicleId || (p.anchorTaskId && !anchor)) return rejected('업무 없음');
      if (anchor && slotKey(anchor) !== slotKey(o)) return rejected('이동 불가 · 다른 반납 타임');
      const order = sortRoute(state, routeOrders(state, o.giveBack.vehicleId, state.businessDate)).map(collectTaskId);
      const rest = order.filter((id) => id !== p.taskId);
      let at = anchor ? rest.indexOf(collectTaskId(anchor)) : rest.findIndex((id) => { const x = findOrder(state, orderIdOfTask(id)); return x !== undefined && slotKey(x) === slotKey(o); });
      if (at < 0) return rejected('업무 없음');
      if (p.position === 'after') at += 1;
      const next = [...rest.slice(0, at), p.taskId, ...rest.slice(at)];
      if (next.join() === order.join()) return nothing('순서 변경 없음');
      next.forEach((id, i) => { state.routeRanks[id] = 'r' + String(i).padStart(4, '0'); });
      return done;
    }
    case 'route.reset': {
      // 시간순 되돌리기: 이 차량 · 날짜의 손 순서를 지운다.
      const p = envelope.payload;
      const ids = routeOrders(state, p.vehicleId, p.date).map(collectTaskId).filter((id) => id in state.routeRanks);
      if (ids.length === 0) return nothing('이미 시간순');
      for (const id of ids) delete state.routeRanks[id];
      return done;
    }
    case 'task.pin': {
      // 빨리 확인: 수거 목록 맨 위에 고정하고 기사 기기에 알린다. 같은 업무를 두 번 누르면 '이미 됨'(sync 4-5).
      const p = envelope.payload;
      const o = findOrder(state, orderIdOfTask(p.taskId));
      if (!o || collectDone(o)) return rejected('차량 수거 대상 없음');
      if (openPins(state).some((pin) => pin.orderId === o.id)) return nothing('긴급 요청 완료');
      state.pins.push({ id: 'pin' + (state.pins.length + 1), orderId: o.id, at: o.giveBack.at, ...(p.note ? { note: p.note } : {}), status: 'requested' });
      return done;
    }
    case 'notification.ack': {
      const p = envelope.payload;
      const pin = state.pins.find((x) => x.id === p.notificationId);
      if (!pin) return rejected('알림 없음');
      if (pin.status === 'acknowledged') return nothing('확인 완료');
      pin.status = 'acknowledged';
      return done;
    }
    case 'task.visit': {
      // 방문 결과(못 받음): 기록을 쌓고, 다시 갈 때가 있으면 약속을 그때로 옮긴다(목록의 그 반납 타임 · 그날로).
      const p = envelope.payload;
      const o = findOrder(state, orderIdOfTask(p.taskId));
      if (!o) return rejected('업무 없음');
      const outcomeKey = p.outcomeKey;
      if (!isVisitOutcome(outcomeKey)) return rejected('등록되지 않은 사유');
      const retryAt = p.retry?.at ? Date.parse(p.retry.at) : undefined;
      o.visits = [...(o.visits ?? []), { at: now, outcomeKey, beforeAt: o.giveBack.at, ...(retryAt !== undefined ? { retryAt } : {}) }];
      if (retryAt !== undefined && Number.isFinite(retryAt)) o.giveBack = { ...o.giveBack, at: retryAt };
      return done;
    }
    default:
      return rejected('체험판 미지원');
  }
}

/** 오프라인 기사 기기가 보냄 대기에 넣을 수 있는 명령(sync 8-2의 체험 몫). 매장 입고는 연결이 필요하다. */
export const OFFLINE_ALLOWED: ReadonlySet<CommandType> = new Set<CommandType>(['stock.collect', 'task.visit', 'route.move', 'route.reset', 'notification.ack']);

/** 명령 하나를 적용한다. state를 바꾸고 결과를 돌려준다(적용했으면 rev가 오른다). */
export function applyCommand(state: FxState, envelope: AnyCommandEnvelope, now: number): CommandOutcome {
  const seen = state.outcomes[envelope.requestId];
  if (seen) return seen;
  const base = { requestId: envelope.requestId, asOfRev: envelope.basis.rev, epoch: state.epoch, changes: [] };
  if (envelope.basis.epoch !== state.epoch) {
    // 체험 자료를 처음으로 되돌린 뒤 옛 창에서 누른 것.
    return { ...base, outcome: 'conflict', rev: state.rev, rebased: false, error: { code: 'EPOCH_CHANGED', message: '체험 자료 초기화됨 · 재시도 필요' } };
  }
  // 돈 명령은 창이 본 받을 돈(expect)과 함께 와야 한다(sync 4-2). 없으면 적용하지 않는다.
  if (MONEY_COMMANDS.has(envelope.type) && envelope.expect?.dueAmount === undefined) {
    return { ...base, outcome: 'rejected', rev: state.rev, rebased: false, error: { code: 'EXPECT_REQUIRED', message: '받을 금액 미확인 · 미수납 · 재시도 필요' } };
  }
  const result = run(state, envelope, now);
  if (result.outcome === 'applied') state.rev += 1;
  const outcome: CommandOutcome = {
    ...base,
    outcome: result.outcome,
    rev: state.rev,
    rebased: result.outcome === 'applied' && envelope.basis.rev !== state.rev - 1,
    ...(result.error ? { error: result.error } : {}),
  };
  // 받은 명령은 결과와 함께 남긴다(거절 · 충돌도). 창은 충돌이면 닫고 다시 열어 새 요청번호로 보낸다.
  state.outcomes[envelope.requestId] = outcome;
  const keys = Object.keys(state.outcomes);
  for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_OUTCOMES))) delete state.outcomes[key];
  return outcome;
}

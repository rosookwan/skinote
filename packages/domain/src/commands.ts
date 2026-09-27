// 명령 처리(sync 2절의 봉투). 같은 요청번호가 다시 오면 다시 하지 않고 처음 결과를 돌려준다(멱등, B2c에서 어댑터 몫으로 옮긴다).
// 돈 명령은 창이 본 받을 돈(expect)이 없으면 거절하고, 지금과 다르면 충돌로 돌려보낸다. 거절 문구는 문맥의 lines(D16).
// 봉투는 종류(type)로 가르면 본문(payload)의 모양이 정해진다(AnyCommandEnvelope): 형 변환 없이 읽는다.
import {
  COMMAND_TYPES, hasRequiredExpect, MONEY_COMMANDS, OFFLINE_COMMANDS, type AnyCommandEnvelope, type CommandOutcome, type CommandPayloads, type CommandType,
} from '@skinote/contract';
import { backNumbers, issueNumbers, loadNumbers, numbered, plannedLeft, quantityOf, type NumberPick } from './assets.ts';
import { payMethodOf } from './catalog.ts';
import { createOrder } from './checkout.ts';
import { applyDiscount, refundPayments, type DiscountViewer } from './discounts.ts';
import { closeDay, confirmTransfer, transferCash } from './closing.ts';
import { takeGroupPayment } from './group-pay.ts';
import { returnDeposit, takeDeposit } from './deposits.ts';
import { addTicket, fieldCollect, fieldDepositReturn, findDeliverTask, onVanToDeliver, setPaymentPromise } from './driver.ts';
import { addItems, cancelOrder } from './order-edit.ts';
import { exchangeSwap } from './exchange.ts';
import { foundTickets, lostNow, moveSpares, writeOffTickets } from './tickets.ts';
import { cancelledTaskReview, collectReviews, resolveReview } from './reviews.ts';
import type { DomainLines, FxLine, FxMethodKey, FxOrder, ShopState } from './model.ts';
import { PRODUCTION_LINES } from './lines.ts';
import { changePromise } from './promise-sheet.ts';
import { applySettings } from './shop-rules.ts';
import { applyRegistryUpdate, applyStaffSet } from './settings.ts';
import { attributeReturn, bucketOnVan, bucketOut, findTask, splitRow, taskBucket, taskOrder, type FxTask } from './promises.ts';
import { done, nothing, rejected, unsupported, type Result } from './result.ts';
import { floorMinute } from './time.ts';
import {
  backCount, collectDone, fillLines, findOrder, isDeliverTaskId, leftover, liveQty, openPins, orderIdOfTask, ownDue, pendingIssue, pinTaskId, routeTasks,
  isVisitOutcome, selfDue, selfLines, slotKey, sortTasks, vanLoaded,
} from './rules.ts';

const KEEP_OUTCOMES = 300;

type StockLines = CommandPayloads['stock.issue']['lines'];

const isMethod = (state: ShopState, key: string): key is FxMethodKey => payMethodOf(state.registry, key) !== undefined;

/** 줄 하나에서 옮길 수와 번호(번호로 세는 줄). */
interface StockMove {
  l: FxLine;
  qty: number;
  ids: string[];
}

/**
 * 줄마다 남은 만큼만 옮긴다(수 셈이 기준, 번호는 그 사본). 사람이 번호를 골랐으면 옮길 수는 그 번호 수까지이고, 번호는 pick이
 * 정한다(지급: 준비 번호 → 빈 번호, 반납 · 수거: 내준 번호). 번호가 맞지 않으면 아무것도 옮기지 않고 거절한다(한 명령은 통째로).
 * 옮긴 것이 없으면 null.
 */
function planStock(
  o: FxOrder,
  lines: StockLines,
  left: (l: FxLine) => number,
  pick: (l: FxLine, qty: number, requested: readonly string[] | undefined, taken: ReadonlySet<string>) => NumberPick,
): StockMove[] | { error: string } {
  const moves: StockMove[] = [];
  // 한 명령 안에서 이미 고른 번호(같은 종류의 줄이 둘 이상일 때: 새 접수의 의류 사이즈 95 · 100). 뒤 줄은 이 번호를 건너뛴다.
  const taken = new Set<string>();
  for (const entry of lines) {
    const l = o.lines.find((x) => x.id === entry.lineId);
    if (!l) continue;
    // 같은 번호를 두 번 보내도 실물 하나다(수는 다른 번호의 수).
    const requested = entry.assetIds ? [...new Set(entry.assetIds)] : undefined;
    const want = Math.min(quantityOf(l, entry.quantity, requested), left(l));
    if (want <= 0) continue;
    const picked = pick(l, want, requested, taken);
    if ('error' in picked) return picked;
    for (const id of picked.ids) taken.add(id);
    // 번호로 세는 줄은 번호가 있는 만큼만(이미 돌아온 번호를 고른 것은 건너뛴다).
    const qty = numbered(l) ? picked.ids.length : want;
    if (qty > 0) moves.push({ l, qty, ids: picked.ids });
  }
  return moves;
}

function run(state: ShopState, envelope: AnyCommandEnvelope, now: number, lines: DomainLines, options: ApplyOptions): Result {
  switch (envelope.type) {
    case 'stock.issue': {
      const p = envelope.payload;
      const o = findOrder(state, p.orderId);
      if (!o) return rejected('접수 없음');
      const plan = planStock(o, p.lines, (l) => Math.max(0, liveQty(l) - l.issued), (l, qty, requested, taken) => issueNumbers(state, l, qty, requested, taken));
      if ('error' in plan) return rejected(plan.error);
      if (plan.length === 0) return nothing('지급 완료');
      // 차량 배달 접수를 카운터에서 지급해도 적재 수는 그대로다: '실을 것 없음'은 모든 곳이 max(loaded, issued)로 센다(plan §3-3 1).
      for (const { l, qty, ids } of plan) {
        l.issued += qty;
        l.issuedAt = now;
        if (ids.length) l.assetIds = [...(l.assetIds ?? []), ...ids];
      }
      return done;
    }
    case 'stock.deliver': {
      // 차량 배달(기사가 손님께 건넴, 오프라인 허용): 차에 실은 것만(적재한 번호가 준비 번호 맨 앞이라 그 번호를 지급한다).
      const p = envelope.payload;
      const task = findDeliverTask(state, p.taskId);
      if (!task) return rejected('업무 없음');
      const o = task.order;
      // 보냄 대기로 온 배달(기기에서 이미 건넨 사실, sync 8-12 · features-1 E23): 그사이 취소했어도 차에 실린 것까지 적는다(돌려받을 것이 된다).
      const deliverable = envelope.deviceSeq !== undefined ? vanLoaded : onVanToDeliver;
      if (!o.lines.some((l) => deliverable(l) > 0)) return pendingIssue(o) ? rejected('배달 불가 · 적재 대기') : nothing('배달 완료');
      const plan = planStock(o, p.lines, deliverable, (l, qty, requested, taken) => issueNumbers(state, l, qty, requested, taken));
      if ('error' in plan) return rejected(plan.error);
      if (plan.length === 0) return nothing('배달 완료');
      for (const { l, qty, ids } of plan) {
        l.issued += qty;
        l.issuedAt = now;
        if (ids.length) l.assetIds = [...(l.assetIds ?? []), ...ids];
      }
      return done;
    }
    case 'stock.direct_return': {
      const p = envelope.payload;
      const o = findOrder(state, p.orderId);
      if (!o) return rejected('접수 없음');
      const plan = planStock(o, p.lines, (l) => (l.returnable ? l.issued - backCount(l) : 0), backNumbers);
      if ('error' in plan) return rejected(plan.error);
      if (plan.length === 0) return nothing('반납 완료');
      for (const { l, qty, ids } of plan) {
        // 어느 반납 일정 몫인지 먼저 적는다(매장 일정 → 원래 일정 → 차량으로 나눈 일정, promises.ts).
        attributeReturn(o, l, qty);
        l.returned += qty;
        l.returnedAt = now;
        if (ids.length) l.backAssetIds = [...(l.backAssetIds ?? []), ...ids];
      }
      return done;
    }
    case 'stock.load': {
      // 적재: 실은 번호는 그 줄의 준비 번호 맨 앞이 된다(차량이 배달할 때 그 번호를 지급한다).
      const p = envelope.payload;
      // 카운터가 차량에 싣는 예비권(features-1 E21, 수량 권만).
      if ('spares' in p) return moveSpares(state, p.vehicleId, p.spares, 'load') ?? done;
      const o = findOrder(state, orderIdOfTask(p.taskId));
      if (!o) return rejected('업무 없음');
      const plan = planStock(o, p.lines, (l) => Math.max(0, liveQty(l) - Math.max(l.loaded, l.issued)), (l, qty, requested, taken) => loadNumbers(state, l, qty, requested, taken));
      if ('error' in plan) return rejected(plan.error);
      if (plan.length === 0) return nothing('적재 완료');
      for (const { l, qty, ids } of plan) {
        if (ids.length) {
          const given = l.assetIds ?? [];
          const mine = plannedLeft(l);
          const onVan = Math.max(l.loaded, l.issued) - l.issued;
          l.plannedAssetIds = [
            ...(l.plannedAssetIds ?? []).filter((id) => given.includes(id)), ...mine.slice(0, onVan), ...ids,
            ...mine.slice(onVan).filter((id) => !ids.includes(id)),
          ];
        }
        l.loaded = Math.max(l.loaded, l.issued) + qty;
        l.loadedAt = now;
      }
      return done;
    }
    case 'stock.collect': {
      // 차량 수거: 그 업무(반납 일정)의 몫만. 일정 변경으로 나눈 일정은 그 일정의 수거 수를 따로 센다(promises.ts).
      const p = envelope.payload;
      const task = findTask(state, p.taskId);
      if (!task) return rejected('업무 없음');
      const o = task.order;
      // 보냄 대기로 온 수거(기기에서 이미 받은 사실, features-1 E20): 그사이 분실 처리한 권을 받아 왔으면 그 몫의 분실 처리를 먼저 되돌린다.
      const queuedFact = envelope.deviceSeq !== undefined;
      const outOf = (l: FxLine) => { const b = l.returnable ? taskBucket(task, l) : undefined; return b ? bucketOut(b) : 0; };
      const reversible = (l: FxLine) => { const b = l.returnable ? taskBucket(task, l) : undefined; return b && queuedFact ? Math.min(b.lost, lostNow(l)) : 0; };
      const plan = planStock(o, p.lines, (l) => outOf(l) + reversible(l), backNumbers);
      if ('error' in plan) return rejected(plan.error);
      // 보냄 대기로 온 수거가 남은 것보다 많이 받았다고 하면(그사이 매장 반납 · 다른 기록) 확인 필요로 적는다(features-1 E18). 움직임은 남은 것만.
      if (queuedFact) {
        const asked = new Map<string, number>();
        for (const x of p.lines) {
          const l = o.lines.find((y) => y.id === x.lineId);
          if (l) asked.set(l.id, (asked.get(l.id) ?? 0) + quantityOf(l, x.quantity, x.assetIds ? [...new Set(x.assetIds)] : undefined));
        }
        collectReviews(state, envelope, task, asked, plan, now, options.actor);
      }
      if (plan.length === 0) return nothing('수거 완료');
      for (const { l, qty, ids } of plan) {
        const reverse = Math.max(0, qty - outOf(l));
        if (reverse > 0) l.lost = Math.max(0, (l.lost ?? 0) - reverse);
        l.collected += qty;
        l.collectedAt = now;
        if (ids.length) l.backAssetIds = [...(l.backAssetIds ?? []), ...ids];
        const split = task.key ? splitRow(o, task.key, l.id) : undefined;
        if (split) split.collected = (split.collected ?? 0) + qty;
      }
      return done;
    }
    case 'payment.take': {
      const p = envelope.payload;
      // 결제 팀이 있는 수납(일괄 수납 V5 · 대납 수납 창): 팀마다의 몫 · 줄 배분 · 남은 줄 돌리기(group-pay.ts).
      if (p.payerOrderId !== undefined) return takeGroupPayment(state, envelope, now);
      const targets = p.orderIds.map((id) => findOrder(state, id)).filter((o): o is FxOrder => o !== undefined);
      if (targets.length !== p.orderIds.length) return rejected('접수 없음');
      if (!(p.amount > 0) || !Number.isInteger(p.amount)) return rejected('받을 금액 없음');
      // 팀마다 이 수납이 채울 몫: 이 팀이 스스로 낼 줄(다른 팀이 내기로 한 줄은 그 팀 몫). 스스로 낼 것이 없고 다른 팀이 내기로 한 돈만
      // 남았으면 그 돈을 지금 직접 낸다(`직접 수납 · 60,000원`, 예정 도장).
      const shareOf = (o: FxOrder) => { const self = selfDue(o); return { amount: self > 0 ? self : ownDue(o), lines: self > 0 ? selfLines(o) : null }; };
      const current = targets.reduce((sum, o) => sum + shareOf(o).amount, 0);
      if (current === 0) return nothing('받을 금액 없음');
      if (envelope.expect?.dueAmount !== undefined && envelope.expect.dueAmount !== current) {
        return { outcome: 'conflict', error: { code: 'DUE_CHANGED', message: '받을 금액 변경됨 · 재시도 필요' } };
      }
      const methodKey = p.methodKey;
      if (!isMethod(state, methodKey)) return rejected('등록되지 않은 결제 수단');
      // 실제 돈 한 건(결제 자리)과 팀마다의 몫(배분). 현금은 카운터 돈통에 들어간다(마감의 돈통 예상).
      const amount = Math.min(p.amount, current);
      const drawer = methodKey === 'cash' ? { drawerId: 'counter' } : {};
      state.paymentGroups.push({
        id: envelope.requestId, purpose: p.purposeKey ?? (targets.length > 1 ? 'multi_order' : 'counter'), amount, methodKey, at: now, ...drawer,
      });
      let rest = amount;
      // 몫의 id는 적은 차례(결제 자리 안의 차례: 받을 돈이 없어 건너뛴 팀은 세지 않는다, plan §3-3 3).
      let k = 0;
      for (const o of targets) {
        const due = shareOf(o);
        const share = Math.min(due.amount, rest);
        if (share <= 0) continue;
        // 이 팀 몫의 줄만 채운다(배분 lines): 줄이 없는 돈이 다른 팀이 내기로 한 줄을 채우지 않게.
        const lines = due.lines ? fillLines(o, due.lines, share) : [];
        o.payments.push({ id: envelope.requestId + ':' + k, amount: share, methodKey, at: now, groupId: envelope.requestId, ...drawer, ...(lines.length ? { lines } : {}) });
        k += 1;
        rest -= share;
      }
      return done;
    }
    case 'stock.receive': {
      // 매장 입고: 차에 있는 것(받은 것 − 내려놓은 것)을 매장으로. 업무(반납 일정)마다 그 몫만. 줄(lines)을 주면 그 줄 · 수만(부분 입고:
      // 내려놓지 않은 것은 차에 남고, 마감의 확인 필요 `헬멧 1개 미입고`가 된다). 입고한 때는 차량마다 남긴다(vanReceipts).
      // 차량 예비권을 내림(spares, 카운터 `예비권 입고`, features-1 E21): 먼저 확인하고 내린다(매장 입고 기록은 아니다).
      const p = envelope.payload;
      const spareMove = p.spares?.length ? moveSpares(state, p.vehicleId, p.spares, 'unload') : null;
      if (spareMove) return spareMove;
      const budget = p.lines ? new Map<string, number>() : null;
      for (const x of p.lines ?? []) budget?.set(x.lineId, (budget.get(x.lineId) ?? 0) + Math.max(0, Math.floor(x.quantity)));
      let moved = false;
      let unloaded = false;
      for (const taskId of p.taskIds) {
        // 취소한 배달의 차에 남은 것(features-1 E7): 배달 업무 id면 그 접수의 차에 남은 것을 매장으로(unloaded).
        if (isDeliverTaskId(taskId)) {
          const o = findOrder(state, orderIdOfTask(taskId));
          if (!o || o.pickup.vehicleId !== p.vehicleId) continue;
          for (const l of o.lines) {
            let take = leftover(l);
            if (budget) {
              const left = budget.get(l.id) ?? 0;
              take = Math.min(take, left);
              budget.set(l.id, left - Math.max(0, take));
            }
            if (take <= 0) continue;
            l.unloaded = (l.unloaded ?? 0) + take;
            unloaded = true;
          }
          continue;
        }
        const task = findTask(state, taskId);
        if (!task || task.promise.vehicleId !== p.vehicleId) continue;
        for (const l of task.order.lines) {
          const b = l.returnable ? taskBucket(task, l) : undefined;
          let take = b ? bucketOnVan(b) : 0;
          if (budget) {
            const left = budget.get(l.id) ?? 0;
            take = Math.min(take, left);
            budget.set(l.id, left - Math.max(0, take));
          }
          if (take <= 0) continue;
          l.received = (l.received ?? 0) + take;
          l.receivedAt = now;
          const split = task.key ? splitRow(task.order, task.key, l.id) : undefined;
          if (split) split.received = (split.received ?? 0) + take;
          moved = true;
        }
      }
      if (!moved && !unloaded) return p.spares?.length ? done : nothing('입고 대상 없음');
      // 매장 입고 기록(미입고의 기준)은 수거한 것을 내려놓았을 때만(차에 남은 취소 품목만 내려놓은 것은 입고 기록이 아니다).
      if (moved) state.vanReceipts = [...(state.vanReceipts ?? []), { vehicleId: p.vehicleId, at: now }];
      return done;
    }
    case 'route.move': {
      // ▲ · ▼ · 맨 위로(sync 4-5): 기준 업무 앞 · 뒤로. 지금 순서에서 자리를 정하고, 첫 손 이동이면 경로 전체에 순위를 쓴다.
      const p = envelope.payload;
      const task = findTask(state, p.taskId);
      const anchor = p.anchorTaskId ? findTask(state, p.anchorTaskId) : undefined;
      if (!task || !task.promise.vehicleId || (p.anchorTaskId && !anchor)) return rejected('업무 없음');
      const slotOf = (t: FxTask) => slotKey(taskOrder(t));
      if (anchor && slotOf(anchor) !== slotOf(task)) return rejected('이동 불가 · 다른 반납 타임');
      const route = sortTasks(state, routeTasks(state, task.promise.vehicleId, state.businessDate));
      const order = route.map((t) => t.id);
      const rest = order.filter((id) => id !== p.taskId);
      let at = anchor ? rest.indexOf(anchor.id) : rest.findIndex((id) => { const x = route.find((t) => t.id === id); return x !== undefined && slotOf(x) === slotOf(task); });
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
      const ids = routeTasks(state, p.vehicleId, p.date).map((t) => t.id).filter((id) => id in state.routeRanks);
      if (ids.length === 0) return nothing('이미 시간순');
      for (const id of ids) delete state.routeRanks[id];
      return done;
    }
    case 'task.pin': {
      // 빨리 확인: 수거 목록 맨 위에 고정하고 기사 기기에 알린다. 같은 업무를 두 번 누르면 '이미 됨'(sync 4-5).
      const p = envelope.payload;
      const task = findTask(state, p.taskId);
      if (!task || collectDone(taskOrder(task))) return rejected('차량 수거 대상 없음');
      if (openPins(state).some((pin) => pinTaskId(state, pin) === task.id)) return nothing('긴급 요청 완료');
      state.pins.push({
        id: 'pin' + (state.pins.length + 1), orderId: task.order.id, ...(task.key ? { taskId: task.id } : {}), at: task.promise.at,
        ...(p.note ? { note: p.note } : {}), status: 'requested',
      });
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
      // 방문 결과(못 받음): 기록을 쌓고, 다시 갈 때가 있으면 그 업무의 일정을 그때로 옮긴다(목록의 그 반납 타임 · 그날로).
      const p = envelope.payload;
      const outcomeKey = p.outcomeKey;
      if (!isVisitOutcome(state.registry, outcomeKey)) return rejected('등록되지 않은 사유');
      // 다시 갈 때는 분 단위로 적는다(약속 시각은 'HH:MM', plan §3-3 6).
      const retryAt = p.retry?.at ? floorMinute(Date.parse(p.retry.at)) : undefined;
      // 배달 실패(배달 업무): 재방문은 배달 시각(수령 일정)을 옮긴다.
      if (isDeliverTaskId(p.taskId)) {
        const delivery = findDeliverTask(state, p.taskId);
        if (!delivery) return rejected('업무 없음');
        const o = delivery.order;
        o.visits = [...(o.visits ?? []), { at: now, kind: 'deliver', outcomeKey, beforeAt: o.pickup.at, ...(retryAt !== undefined ? { retryAt } : {}) }];
        if (retryAt !== undefined && Number.isFinite(retryAt)) o.pickup = { ...o.pickup, at: retryAt };
        return done;
      }
      const task = findTask(state, p.taskId);
      const o = task?.order ?? findOrder(state, orderIdOfTask(p.taskId));
      if (!o) return rejected('업무 없음');
      const before = task?.promise.at ?? o.giveBack.at;
      o.visits = [...(o.visits ?? []), { at: now, outcomeKey, beforeAt: before, ...(retryAt !== undefined ? { retryAt } : {}) }];
      if (retryAt !== undefined && Number.isFinite(retryAt)) {
        if (task?.key) for (const split of o.splits ?? []) { if (split.id === task.key) split.promise = { ...split.promise, at: retryAt }; }
        else o.giveBack = { ...o.giveBack, at: retryAt };
      }
      return done;
    }
    case 'deposit.take':
      // 지급 창의 보증금 입금(전화 예약처럼 접수 때 받지 못한 권, catalog 11-1). 5단계의 접수 확정도 같은 처리기를 쓴다.
      return takeDeposit(state, envelope, now);
    case 'promise.change':
      // 일정 변경(V9 · N2): 줄 수량 일부를 새 반납 일정으로(promise-sheet.ts).
      return changePromise(state, envelope, now, lines);
    case 'deposit.return':
      // 반납 창(V1)의 보증금 반환: 돌아온 권만큼 현금 · 동일 수단 · 미수 차감(deposits.ts).
      return returnDeposit(state, envelope, now);
    case 'order.create':
      // 새 접수 확정(V4): 접수 · 품목 줄 · 일정 · 칸별 수납 · 보증금 입금 · 결제 팀이 한 명령(checkout.ts).
      return createOrder(state, envelope, now, lines, options.orderIds ?? 'sequence', options.viewer);
    case 'field.collect':
      // 기사 현장 수납(V7, 차량 지갑 · 오프라인 허용, driver.ts).
      return fieldCollect(state, envelope, now);
    case 'field.add_ticket':
      // 차량 예비권으로 리프트권 추가(권 줄 · 값 · 보증금 입금을 한 명령으로, driver.ts).
      return addTicket(state, envelope, now, lines);
    case 'field.deposit_return':
      // 수거 현장의 권 보증금 반환(차량 지갑, 수거에 이어짐, driver.ts).
      return fieldDepositReturn(state, envelope, now);
    case 'payment_promise.set':
      // 현장 수납 판의 후불 처리(이 팀 미수를 반납 때 받기로, driver.ts).
      return setPaymentPromise(state, envelope, now, lines);
    case 'cash.transfer':
      // 차량 현금 인계(매장 입고 때 기사가 봉투를 건넴, 이야기 23:48, closing.ts).
      return transferCash(state, envelope, now, lines);
    case 'cash.transfer_confirm':
      // 마감 화면의 차량 현금 점검(V6, 넘기는 중 → 카운터 돈통, closing.ts).
      return confirmTransfer(state, envelope, now, lines);
    case 'closing.close':
      // 하루 마감(V6, closing.ts).
      return closeDay(state, envelope, now, lines);
    case 'setting.set':
      // 운영 규칙 저장(V8, 다음 기록부터, shop-rules.ts).
      return applySettings(state, envelope, now, lines);
    case 'registry.update':
      // 매장 목록 바꿈(매장 정보 · 장소 · 반납 타임 · 요금 · 할인 · 차량, 다음 기록부터, settings.ts).
      return applyRegistryUpdate(state, envelope, lines);
    case 'staff.set':
      // 직원 바꿈(더하기 · 역할 · 차량 배정 · 사용 종료, settings.ts). 본인 막힘은 명령을 한 사람(options.actor)으로.
      return applyStaffSet(state, envelope, lines, options.actor);
    case 'discount.apply':
      // 할인 적용 · 변경 · 해제(접수증 옆 동작, discounts.ts). 권한 · 한도는 명령을 한 사람(options.viewer)으로.
      return applyDiscount(state, envelope, now, lines, options.viewer);
    case 'payment.refund':
      // 환불(할인 변경 · 접수 취소 · 초과 수납의 까닭, discounts.ts).
      // 받은 수단과 다른 수단의 환불은 명령을 한 사람의 cash.entry로(options.viewer).
      return refundPayments(state, envelope, now, lines, options.viewer);
    case 'order.cancel':
      // 접수 취소 · 품목 취소(접수증 옆 동작, order-edit.ts).
      return cancelOrder(state, envelope, now, lines, options.viewer);
    case 'order.add':
      // 품목 추가(접수증 옆 동작, order-edit.ts).
      // 품목 추가: 칸의 할인을 새 줄에 이어받을 때 그 할인의 권한 · 한도를 명령을 한 사람(options.viewer)으로 다시 본다.
      return addItems(state, envelope, now, lines, options.viewer);
    case 'exchange.swap':
      // 즉시 교환(접수증 옆 동작, exchange.ts). 누가는 명령을 한 사람(options.actor).
      return exchangeSwap(state, envelope, now, lines, options.actor);
    case 'stock.write_off':
      // 분실 처리(리프트권 화면 · 접수증 옆 동작, tickets.ts): 청구 없이 닫는다.
      return writeOffTickets(state, envelope, now);
    case 'asset.found':
      // 분실 회수(리프트권 화면 분실 탭, tickets.ts).
      return foundTickets(state, envelope, now);
    case 'review.resolve':
      // 확인 필요의 `확인`(확인 필요 화면, reviews.ts). 누가는 명령을 한 사람(options.actor).
      return resolveReview(state, envelope, now, options.actor);
    default:
      return unsupported(lines);
  }
}

/**
 * 끊긴 기사 기기가 보냄 대기에 넣을 수 있는 명령(sync 8-2): 계약의 OFFLINE_COMMANDS(sys_offline_commands 시드) 기사 태블릿 몫 그대로. 매장 입고 ·
 * 적재(카운터가 적음) · 후불 처리(결제 약속은 결정)는 연결이 필요하다. 기사 휴대폰도 같은 목록이다.
 */
export const OFFLINE_ALLOWED: ReadonlySet<CommandType> = new Set<CommandType>(
  COMMAND_TYPES.filter((type) => OFFLINE_COMMANDS.driver_tablet.includes(type)),
);

const SETTLED: ReadonlySet<CommandOutcome['outcome']> = new Set(['applied', 'partially_applied', 'superseded', 'needs_review']);

/** 먼저 적용되어야 할 명령 중 적용되지 않은 것이 있는지. */
function unmetDependency(state: ShopState, dependsOn: readonly string[] | undefined): boolean {
  return (dependsOn ?? []).some((id) => { const seen = state.outcomes[id]; return !seen || !SETTLED.has(seen.outcome); });
}

/**
 * 명령 적용의 선택. orderIds: 새 접수 id의 모양 — 'sequence'는 메모리 어댑터의 id('n19', 한 날짜만 쓰는 자료), 'dated'는 접수 번호에서
 * 만든 id('n261226019', 날짜가 여럿인 서버 장부에서 겹치지 않는다).
 */
export interface ApplyOptions {
  orderIds?: 'sequence' | 'dated';
  /**
   * 명령을 한 사람(서버는 세션의 직원, 봉투에서 오지 않는다). 직원 바꿈의 `사용 종료 불가 · 본인`이 staffId를, 즉시 교환의 기록(누가)이 name을 본다.
   * 없으면(메모리 어댑터) 보지 않는다.
   */
  actor?: { staffId?: string; name?: string; deviceId?: string };
  /**
   * 명령을 한 사람의 권한 · 한도(서버: 세션의 역할, 메모리 어댑터: 보는 사람). 할인의 권한(직접 입력 · 매장 할인의 권한)과 직접 입력 한도를 본다
   * (features-1 E10). 없으면 모두 허락.
   */
  viewer?: DiscountViewer;
}

/**
 * 명령 하나를 적용한다. state를 바꾸고 결과를 돌려준다(적용했으면 rev가 오른다). lines는 거절 문구(없으면 운영 문구). 입력을 고치지
 * 않는 모양은 execute(execute.ts)다.
 */
export function applyCommand(state: ShopState, envelope: AnyCommandEnvelope, now: number, lines: DomainLines = PRODUCTION_LINES, options: ApplyOptions = {}): CommandOutcome {
  const seen = state.outcomes[envelope.requestId];
  if (seen) return seen;
  const base = { requestId: envelope.requestId, asOfRev: envelope.basis.rev, epoch: state.epoch, changes: [] };
  if (envelope.basis.epoch !== state.epoch) {
    // 자료를 처음으로 되돌리거나 복구한 뒤 옛 창에서 누른 것.
    return { ...base, outcome: 'conflict', rev: state.rev, rebased: false, error: { code: 'EPOCH_CHANGED', message: lines.epochChanged } };
  }
  // 돈 명령은 창이 본 바탕(expect: 받을 금액 · 보관 보증금 · 예상 현금 …)과 함께 와야 한다(sync 4-2). 없으면 적용하지 않는다.
  if (!hasRequiredExpect(envelope.type, envelope.expect)) {
    return { ...base, outcome: 'rejected', rev: state.rev, rebased: false, error: { code: 'EXPECT_REQUIRED', message: '받을 금액 미확인 · 미수납 · 재시도 필요' } };
  }
  // 이어진 명령(sync 2절 4): 먼저 적용되어야 할 명령(dependsOn)이 적용되지 않았으면(받지 못함 · 거절 · 충돌 · 멈춤) 돈이 아닌
  // 명령은 멈춘다(blocked). 돈 명령은 멈추지 않는다(받은 돈은 사실이고, 바탕 expect가 지킨다, 8-3). 이미 된 일(superseded)은 된 것으로 본다.
  const reviewsBefore = state.reviews?.length ?? 0;
  const result: Result = !MONEY_COMMANDS.has(envelope.type) && unmetDependency(state, envelope.dependsOn)
    ? { outcome: 'blocked', error: { code: 'DEPENDENCY_NOT_APPLIED', message: '처리 불가 · 이전 단계 대기' } }
    : run(state, envelope, now, lines, options);
  // 취소한 접수에 온 보냄 대기 기사 기록(features-1 E23): 사실은 적고 확인 필요 `취소된 업무`를 남긴다.
  if (result.outcome === 'applied') cancelledTaskReview(state, envelope, now, options.actor);
  // 적은 것이 확인 필요뿐이어도(이미 매장에 반납된 보냄 대기 수거: 결과는 `처리 완료`) 상태가 바뀌었으므로 rev가 오른다.
  if (result.outcome === 'applied' || (state.reviews?.length ?? 0) > reviewsBefore) state.rev += 1;
  const outcome: CommandOutcome = {
    ...base,
    outcome: result.outcome,
    rev: state.rev,
    rebased: result.outcome === 'applied' && envelope.basis.rev !== state.rev - 1,
    ...(result.error ? { error: result.error } : {}),
    ...(result.result ? { result: result.result } : {}),
  };
  // 받은 명령은 결과와 함께 남긴다(거절 · 충돌도). 창은 충돌이면 닫고 다시 열어 새 요청번호로 보낸다.
  state.outcomes[envelope.requestId] = outcome;
  const keys = Object.keys(state.outcomes);
  for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_OUTCOMES))) delete state.outcomes[key];
  return outcome;
}

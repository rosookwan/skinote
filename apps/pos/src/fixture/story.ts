// 체험 자료의 뒷이야기(docs/design/screens-v2/spec.md 2-4): 15:40 뒤에 다른 직원 · 기사가 한 일. 체험 시계를 앞으로 돌리면
// (나가기 화면의 +10분 · +1시간) 그 사이의 사건을 같은 명령(applyCommand)으로 그 시각에 적는다. 그래서 시계를 시안의 시각으로
// 돌리면 그 화면의 예시 자료가 된다(V5 16:40, V7 16:55, V9 19:40, V1 21:30, V6 27일 00:40). 7단계는 16:40 적재 · 16:57 배달 · 16:58 권 추가 ·
// 22:00 · 22:10 차량 수거를, 8단계는 23:48 매장 입고 · 현금 인계와 27일 00:32 차량 현금 점검을 더했다.
// 사건은 한 번만 적고(storyApplied), 사람이 먼저 같은 일을 했으면(명령이 superseded · rejected) 건너뛴다.
// 사건의 시각은 시안 화면의 '바로 뒤'다: 시계가 그 시각에 멈추면 화면은 시안처럼 사건 전 상태다.
// 사건은 단계마다 더한다(work/impl-v2/plan.md 5절의 표). 이 파일은 체험 전용이고 LocalClient가 오면 없어진다.
import {
  draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type CheckoutChoice, type CommandOutcome, type ConfirmCommand, type DraftItem, type Expect,
  type PromiseInput,
} from '@skinote/contract';
import { heldNumbers, plannedLeft, numbered } from './assets.ts';
import { checkoutPlan, LATER } from './checkout.ts';
import { groupPayCommand, groupPayPlan } from './group-pay.ts';
import { depositDueAtIssue, depositOf, heldAmount, heldUnits } from './deposits.ts';
import { collectDepositStep, fieldDue, onVanToDeliver, spareTickets, ticketQuote } from './driver.ts';
import type { FxLine, FxOrder, FxState } from './model.ts';
import { walletLeft } from './closing.ts';
import { bucketOnVan, bucketOut, orderTasks, taskBucket, taskOrder } from './promises.ts';
import { backCount, collectDone, deliverTaskId, findOrder, isVehiclePickup, routeTasks, selfDue } from './rules.ts';
import { assetId, DEMO_DATE } from './seed.ts';
import { kstAt } from './time.ts';

/** 사건 하나: 그 시각에 적을 명령들(지금 자료를 보고 만든다: 번호 · 받을 금액 · 보관 보증금). */
export interface FxStoryEvent {
  id: string;
  /** 명령을 적는 시각(ms). */
  at: number;
  /** 무슨 일인지(시험 · 읽는 사람용). */
  note: string;
  /** 명령을 만든다. 이미 된 일이면 빈 목록. basis는 지금 자료의 epoch · rev, 요청번호는 'story:<id>:<n>'. */
  commands: (state: FxState) => AnyCommandEnvelope[];
}

const at = (hour: number, minute: number, dayOffset = 0) => kstAt(DEMO_DATE, dayOffset, hour, minute);

/** 사건의 봉투 하나(요청번호 story:<id>:<n>, basis는 지금 자료, 만든 때는 사건 시각). */
function envelope(state: FxState, eventId: string, n: number, command: ConfirmCommand, extra: { expect?: Expect; dependsOn?: string[] } = {}): AnyCommandEnvelope {
  return draftToEnvelope(openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, { requestId: storyRequestId(eventId, n), ...extra }));
}

/** 아직 지급하지 않은 줄 모두(번호로 세는 줄은 준비 번호가 있으면 그 번호로). */
function issueLeft(o: FxOrder): { l: FxLine; qty: number; units: { lineId: string; quantity: number; assetIds?: string[] } }[] {
  return o.lines.flatMap((l) => {
    const qty = l.qty - l.issued;
    if (qty <= 0) return [];
    const planned = numbered(l) ? plannedLeft(l).slice(0, qty) : [];
    return [{ l, qty, units: { lineId: l.id, quantity: qty, ...(planned.length === qty ? { assetIds: planned } : {}) } }];
  });
}

/** 매장 반납 · 차량 수거로 아직 돌아오지 않은 것 모두. */
const backLeft = (o: FxOrder) => o.lines.filter((l) => l.returnable && l.issued - backCount(l) > 0).map((l) => ({ lineId: l.id, quantity: l.issued - backCount(l) }));

/** 지급(준비 번호) + 권 보증금(창이 먼저 묻는 것과 같은 매수 · 금액, 지급에 이어짐). 이미 지급했으면 없음. */
function issueWithDeposit(state: FxState, eventId: string, orderId: string): AnyCommandEnvelope[] {
  const o = findOrder(state, orderId);
  const picks = o ? issueLeft(o) : [];
  if (!o || picks.length === 0) return [];
  const issue = envelope(state, eventId, 0, { type: 'stock.issue', payload: { orderId: o.id, lines: picks.map((x) => x.units) } });
  const due = depositDueAtIssue(state, o, picks);
  if (!due) return [issue];
  const deposit = envelope(state, eventId, 1, {
    type: 'deposit.take',
    payload: { orderId: o.id, ruleKey: due.rule.key, lines: due.lines, amount: due.amount, methodKey: due.methodKey },
  }, { expect: { depositHeld: due.held }, dependsOn: [issue.requestId] });
  return [issue, deposit];
}

/** 매장 반납(남은 것 모두) + 그 팀 미수 수납(현금, 카운터). */
function returnAndPay(state: FxState, eventId: string, orderId: string, methodKey: string): AnyCommandEnvelope[] {
  const o = findOrder(state, orderId);
  if (!o) return [];
  const out: AnyCommandEnvelope[] = [];
  const lines = backLeft(o);
  if (lines.length) out.push(envelope(state, eventId, 0, { type: 'stock.direct_return', payload: { orderId: o.id, lines } }));
  const due = selfDue(o);
  if (due > 0) {
    out.push(envelope(state, eventId, 1, {
      type: 'payment.take', payload: { orderIds: [o.id], amount: due, methodKey, allocations: [{ orderId: o.id, amount: due }] },
    }, { expect: { dueAmount: due } }));
  }
  return out;
}

/** 차량 수거(그 차량의 업무마다 남은 것 모두: 일정이 나뉜 팀은 그 차량 · 시각의 일정 몫만). */
function collect(state: FxState, eventId: string, orderIds: readonly string[], at?: number): AnyCommandEnvelope[] {
  const tasks = orderIds.flatMap((orderId) => {
    const o = findOrder(state, orderId);
    return o ? orderTasks(o).filter((t) => at === undefined || t.promise.at === at) : [];
  });
  return tasks.flatMap((task, n) => {
    const lines = task.order.lines.flatMap((l) => {
      const b = l.returnable ? taskBucket(task, l) : undefined;
      const left = b ? bucketOut(b) : 0;
      return left > 0 ? [{ lineId: l.id, quantity: left }] : [];
    });
    return lines.length ? [envelope(state, eventId, n, { type: 'stock.collect', payload: { taskId: task.id, lines } })] : [];
  });
}

/**
 * 박준호 팀 일정 변경(19:40 전화, V9): 보드 1 · 헬멧 1 · 권 1매는 22:00 솔마을 두솔동(숙소)에서 1호 차량이 받는다. 나머지는 설천 주차장
 * 일정 그대로. 이미 일정을 나눴거나(사람이 V9에서 먼저 함) 옮길 것이 없으면 없음.
 */
function parkPromise(state: FxState, eventId: string): AnyCommandEnvelope[] {
  const o = findOrder(state, 'o22');
  if (!o || (o.splits ?? []).length > 0) return [];
  const want: [string, number][] = [['o22-l2', 1], ['o22-l3', 1], ['o22-l4', 1]];
  const lines = want.filter(([id]) => { const l = o.lines.find((x) => x.id === id); return l !== undefined && l.issued - backCount(l) > 0; })
    .map(([lineId, quantity]) => ({ lineId, quantity }));
  if (lines.length !== want.length) return [];
  return [envelope(state, eventId, 0, {
    type: 'promise.change',
    payload: { orderId: o.id, kind: 'return', lines, promise: { mode: 'vehicle', slot: { day: 'today', slotKey: 'night' }, placeKey: 'dusol', vehicleId: 'v1' } },
  })];
}

/** 그 팀 미수 수납 한 번(받을 금액 그대로, 창이 본 받을 금액 expect). 받을 것이 없거나 다른 팀이 내기로 했으면 없음. */
function payDue(state: FxState, eventId: string, orderId: string, methodKey: string): AnyCommandEnvelope[] {
  const o = findOrder(state, orderId);
  const due = o ? selfDue(o) : 0;
  if (!o || due === 0) return [];
  return [envelope(state, eventId, 0, {
    type: 'payment.take', payload: { orderIds: [o.id], amount: due, methodKey, allocations: [{ orderId: o.id, amount: due }] },
  }, { expect: { dueAmount: due } })];
}

/**
 * 박준호 팀 부분 반납(21:30 가족이 매장에 옴, V1): 스키 17 · 18번, 헬멧 12 · 14번, 권 31 · 32번(반납 창과 같은 번호) + 돌아온 권 2매의
 * 보증금 10,000원 현금 반환(반납에 이어짐, 창을 연 때의 보관 금액 expect). 보드 5번 · 헬멧 15번 · 권 33번은 22:00 솔마을 두솔동에서
 * 1호 차량이 받는다. 이미 돌아온 번호는 빼고, 남은 것이 없으면(사람이 V1에서 먼저 함) 없음.
 */
function parkReturn(state: FxState, eventId: string): AnyCommandEnvelope[] {
  const o = findOrder(state, 'o22');
  if (!o) return [];
  const want: [string, string[]][] = [['o22-l1', ['17', '18']], ['o22-l3', ['12', '14']], ['o22-l4', ['31', '32']]];
  const lines = want.flatMap(([lineId, nos]) => {
    const l = o.lines.find((x) => x.id === lineId);
    if (!l) return [];
    const held = new Set(heldNumbers(l));
    const ids = nos.map((no) => assetId(l.kind, no)).filter((id) => held.has(id));
    return ids.length ? [{ lineId, quantity: ids.length, assetIds: ids }] : [];
  });
  if (lines.length === 0) return [];
  const back = envelope(state, eventId, 0, { type: 'stock.direct_return', payload: { orderId: o.id, lines } });
  const rule = state.settings.liftDeposit;
  const dep = rule ? depositOf(state, o.id, rule.key) : undefined;
  const refunds = dep ? lines.flatMap((x) => {
    const units = Math.min(x.quantity, heldUnits(dep, x.lineId));
    return units > 0 ? [{ lineId: x.lineId, quantity: units, assetIds: x.assetIds.slice(0, units) }] : [];
  }) : [];
  const units = refunds.reduce((sum, x) => sum + x.quantity, 0);
  if (!dep || units === 0) return [back];
  const refund = envelope(state, eventId, 1, {
    type: 'deposit.return', payload: { orderId: o.id, ruleKey: dep.ruleKey, lines: refunds, amount: units * dep.unitAmount, refundMethodKey: 'cash' },
  }, { expect: { depositHeld: heldAmount(dep), dueAmount: selfDue(o) }, dependsOn: [back.requestId] });
  return [back, refund];
}

/** 차량 배달 적재(매장에서 1호 차량에 실음, spec 2-4 16:40): 아직 싣지 않은 것 모두. 이미 실었거나 배달 접수가 아니면 없음. */
function loadVan(state: FxState, eventId: string, orderId: string): AnyCommandEnvelope[] {
  const o = findOrder(state, orderId);
  if (!o || !isVehiclePickup(o)) return [];
  const lines = o.lines.flatMap((l) => {
    const left = l.qty - Math.max(l.loaded, l.issued);
    return left > 0 ? [{ lineId: l.id, quantity: left }] : [];
  });
  return lines.length ? [envelope(state, eventId, 0, { type: 'stock.load', payload: { taskId: deliverTaskId(o), lines } })] : [];
}

/** 차량 배달(기사가 손님께 건넴, 16:57): 실은 것 모두. 이미 건넸으면(사람이 V7에서 먼저 함) 없음. */
function deliverAll(state: FxState, eventId: string, orderId: string): AnyCommandEnvelope[] {
  const o = findOrder(state, orderId);
  if (!o || !isVehiclePickup(o)) return [];
  const lines = o.lines.flatMap((l) => (onVanToDeliver(l) > 0 ? [{ lineId: l.id, quantity: onVanToDeliver(l) }] : []));
  return lines.length ? [envelope(state, eventId, 0, { type: 'stock.deliver', payload: { taskId: deliverTaskId(o), lines } })] : [];
}

/**
 * 배달 자리의 리프트권 추가(16:58, V7): 차량 예비권 번호가 낮은 것부터 매수만큼, 값 · 보증금은 그때 셈(quoteHash) + 이어서 현장 수납(값만큼,
 * 추가에 이어짐 dependsOn, 창이 본 받을 금액 = 지금 미수 + 권 값). 이미 권이 있는 팀(사람이 V7에서 먼저 추가)이면 없음.
 */
function addTicketAndPay(state: FxState, eventId: string, orderId: string, productKey: string, quantity: number, methodKey: string): AnyCommandEnvelope[] {
  const o = findOrder(state, orderId);
  if (!o || !isVehiclePickup(o) || o.lines.some((l) => l.section === 'lift')) return [];
  const taskId = deliverTaskId(o);
  const spare = spareTickets(state, o.pickup.vehicleId ?? 'v1').find((x) => x.productKey === productKey)?.ids ?? [];
  if (spare.length < quantity) return [];
  const quote = ticketQuote(state, o, productKey, quantity);
  const add = envelope(state, eventId, 0, {
    type: 'field.add_ticket',
    payload: {
      taskId, orderId: o.id, productKey, quantity, assetIds: spare.slice(0, quantity), amount: quote.amount,
      ...(quote.deposit ? { deposit: { ruleKey: quote.deposit.ruleKey, amount: quote.deposit.amount } } : {}),
    },
  }, { expect: { quoteHash: quote.hash } });
  const due = fieldDue(state, o) + quote.amount;
  const pay = envelope(state, eventId, 1, {
    type: 'field.collect', payload: { taskId, orderId: o.id, amount: due, methodKey },
  }, { expect: { dueAmount: due }, dependsOn: [add.requestId] });
  return [add, pay];
}

/**
 * 차량 수거(그 차량 · 그 시각의 업무 모두, 남은 것 모두) + 수거한 권의 보증금 현장 반환(차량 지갑, 수거에 이어짐 — 수거 확인 창과 같은 셈,
 * spec 2-4 22:00 박준호 권 1매 5,000원). only가 있으면 그 줄만(권을 못 받은 22:10 최하은 팀: 장비만).
 */
function vanCollect(state: FxState, eventId: string, vehicleId: string, at: number, options: { orderIds?: readonly string[]; only?: (l: FxLine) => boolean } = {}): AnyCommandEnvelope[] {
  const tasks = routeTasks(state, vehicleId, state.businessDate)
    .filter((t) => t.promise.at === at && (!options.orderIds || options.orderIds.includes(t.order.id)));
  const out: AnyCommandEnvelope[] = [];
  let n = 0;
  for (const task of tasks) {
    const picks = task.order.lines.flatMap((l) => {
      const b = l.returnable && (!options.only || options.only(l)) ? taskBucket(task, l) : undefined;
      const left = b ? bucketOut(b) : 0;
      return left > 0 ? [{ l, qty: left }] : [];
    });
    if (!picks.length) continue;
    const collect = envelope(state, eventId, n, { type: 'stock.collect', payload: { taskId: task.id, lines: picks.map(({ l, qty }) => ({ lineId: l.id, quantity: qty })) } });
    n += 1;
    out.push(collect);
    for (const step of collectDepositStep(state, task, picks)?.then ?? []) {
      out.push(envelope(state, eventId, n, step.command, { ...(step.expect ? { expect: step.expect } : {}), dependsOn: [collect.requestId] }));
      n += 1;
    }
  }
  return out;
}

/** 수거 실패(고객 부재 등, 재방문 없이): 아직 받을 것이 있는 업무만. */
function visitFailed(state: FxState, eventId: string, orderId: string, outcomeKey: string): AnyCommandEnvelope[] {
  const o = findOrder(state, orderId);
  const task = o ? orderTasks(o)[0] : undefined;
  if (!o || !task || collectDone(taskOrder(task))) return [];
  return [envelope(state, eventId, 0, { type: 'task.visit', payload: { taskId: task.id, outcomeKey } })];
}

/**
 * 차량 매장 입고 + 현금 인계(spec 2-4 23:48): 차에 있는 것 모두를 매장으로, keep의 줄 · 수는 빼고(김민수 팀 헬멧 1개 미입고 → 마감의
 * `확인 필요`), 이어서 차량 지갑의 현금을 인계(넘기는 중 돈통, 카운터가 세기 전). 차에 남은 것이 없거나 지갑이 비었으면 그 명령은 없음.
 */
function vanReturn(state: FxState, eventId: string, vehicleId: string, keep: Readonly<Record<string, number>>): AnyCommandEnvelope[] {
  const tasks = routeTasks(state, vehicleId, state.businessDate);
  const onVan = new Map<string, number>();
  const taskIds: string[] = [];
  for (const task of tasks) {
    let any = false;
    for (const l of task.order.lines) {
      const b = l.returnable ? taskBucket(task, l) : undefined;
      const n = b ? bucketOnVan(b) : 0;
      if (n <= 0) continue;
      onVan.set(l.id, (onVan.get(l.id) ?? 0) + n);
      any = true;
    }
    if (any) taskIds.push(task.id);
  }
  const lines = [...onVan].map(([lineId, n]) => ({ lineId, quantity: n - (keep[lineId] ?? 0) })).filter((x) => x.quantity > 0);
  const out: AnyCommandEnvelope[] = [];
  if (lines.length) out.push(envelope(state, eventId, 0, { type: 'stock.receive', payload: { vehicleId, taskIds, lines } }));
  const cash = walletLeft(state, state.businessDate, vehicleId);
  if (cash > 0) out.push(envelope(state, eventId, 1, { type: 'cash.transfer', payload: { vehicleId, amount: cash } }));
  return out;
}

/** 카운터의 차량 현금 점검(spec 2-4 27일 00:32): 확인하지 않은 그 차량 인계를 센 금액 = 인계 금액(차액 0원)으로. 이미 셌거나 마감했으면 없음. */
function vanCashCheck(state: FxState, eventId: string, vehicleId: string): AnyCommandEnvelope[] {
  if (state.closings.some((c) => c.date === state.businessDate)) return [];
  const t = state.cashTransfers.find((x) => x.vehicleId === vehicleId && !x.confirmed);
  if (!t) return [];
  return [envelope(state, eventId, 0, {
    type: 'cash.transfer_confirm', payload: { transferId: t.id, countedAmount: t.amount },
  }, { expect: { expectedCash: { [t.id]: t.amount } } })];
}

/** 새 접수 한 팀(spec 2-4 16:26 ~ 16:34): 대표자 · 품목 · 반납 일정 · 칸마다 수단, 장비 후불이면 결제 팀(끝 4자리). */
interface NewTeam {
  name: string;
  last4: string;
  party: number;
  items: DraftItem[];
  /** 반납 일정(없으면 서버의 처음 값: 권종의 사용 창 끝 · 매장 직접). */
  giveBack?: PromiseInput;
  /** 칸마다 수단(없는 칸은 기본). */
  methods: Record<string, string>;
  /** 후불 칸을 낼 팀의 끝 4자리. */
  payerLast4?: string;
}

const byLast4 = (state: FxState, last4: string) => state.orders.find((o) => o.last4 === last4);

/**
 * 새 접수 확정(order.create, V4): 창이 누르는 길 그대로 초안 · 선택을 만들고 지금 셈의 가격(quoteHash)을 싣는다. 같은 끝 4자리의 팀이
 * 이미 있으면(사람이 V4에서 먼저 접수) 없음.
 */
function newOrder(state: FxState, eventId: string, at: number, team: NewTeam): AnyCommandEnvelope[] {
  if (byLast4(state, team.last4)) return [];
  const payer = team.payerLast4 ? byLast4(state, team.payerLast4) : undefined;
  if (team.payerLast4 && !payer) return [];
  const draft = {
    channel: 'walk_in' as const,
    leader: { name: team.name, phone: '0100000' + team.last4, party: team.party },
    items: team.items,
    pickup: { mode: 'store' as const, immediate: true },
    giveBack: team.giveBack ?? { mode: 'store' as const },
    ...(team.giveBack ? { returnSet: { time: true, place: true } } : {}),
  };
  const choices: CheckoutChoice[] = Object.entries(team.methods).map(([sectionKey, methodKey]) => ({ sectionKey, methodKey }));
  const plan = checkoutPlan(state, at, draft, choices, payer?.id ?? null);
  if (plan.invalid || !plan.itemsReady || !plan.scheduleReady) return [];
  return [envelope(state, eventId, 0, {
    type: 'order.create', payload: { draft, choices: plan.choices, payerOrderId: payer?.id ?? null },
  }, { expect: { quoteHash: plan.hash } })];
}

/** 새 접수 팀의 지급(그 팀이 있고 아직 주지 않은 것이 있을 때). */
function issueNew(state: FxState, eventId: string, last4: string): AnyCommandEnvelope[] {
  const o = byLast4(state, last4);
  return o ? issueWithDeposit(state, eventId, o.id) : [];
}

/** 22:00 설천 주차장 · 1호 차량 수거(spec 2-4 16:28 ~ 16:34의 새 팀). */
const SEOLCHEON_2200: PromiseInput = { mode: 'vehicle', slot: { day: 'today', slotKey: 'night' }, placeKey: 'seolcheon_parking', vehicleId: 'v1' };

/**
 * 이정호 팀 일괄 수납(16:41, V5 바로 뒤): 이 팀과 이 팀이 내기로 한 팀 모두(처음 연 상태), 카드 한 번. 창과 같은 셈(groupPayPlan)의 명령 ·
 * 팀마다의 받을 금액(expect.dueByOrder). 받을 것이 없으면(사람이 V5에서 먼저 받음) 없음.
 */
function groupPay(state: FxState, eventId: string, orderId: string, methodKey: string): AnyCommandEnvelope[] {
  if (!findOrder(state, orderId)) return [];
  const send = groupPayCommand(groupPayPlan(state, { orderId, methodKey }));
  return send ? [envelope(state, eventId, 0, send.command, { expect: send.expect })] : [];
}

/**
 * 매장 반납(남은 것 모두) + 돌아온 권의 보증금 현금 반환(반납에 이어짐, 창을 연 때의 보관 금액 expect). 이미 돌아왔으면 없음.
 */
function returnWithDeposit(state: FxState, eventId: string, orderId: string): AnyCommandEnvelope[] {
  const o = findOrder(state, orderId);
  if (!o) return [];
  const lines = o.lines.filter((l) => l.returnable && l.issued - backCount(l) > 0).map((l) => ({ lineId: l.id, quantity: l.issued - backCount(l), assetIds: heldNumbers(l) }));
  if (lines.length === 0) return [];
  const back = envelope(state, eventId, 0, { type: 'stock.direct_return', payload: { orderId: o.id, lines } });
  const rule = state.settings.liftDeposit;
  const dep = rule ? depositOf(state, o.id, rule.key) : undefined;
  const refunds = dep ? lines.flatMap((x) => {
    const units = Math.min(x.quantity, heldUnits(dep, x.lineId));
    return units > 0 ? [{ lineId: x.lineId, quantity: units, assetIds: x.assetIds.slice(0, units) }] : [];
  }) : [];
  const units = refunds.reduce((sum, x) => sum + x.quantity, 0);
  if (!dep || units === 0) return [back];
  const refund = envelope(state, eventId, 1, {
    type: 'deposit.return', payload: { orderId: o.id, ruleKey: dep.ruleKey, lines: refunds, amount: units * dep.unitAmount, refundMethodKey: 'cash' },
  }, { expect: { depositHeld: heldAmount(dep), dueAmount: selfDue(o) }, dependsOn: [back.requestId] });
  return [back, refund];
}

/** 이민호 팀(0042, V2 ~ V4): 스키 4 · 의류 95 × 2 · 100 × 1 · 헬멧 중 1 · 야간권 성인 4매, 반납 오늘 22:00 매장 직접(야간권의 처음 값). */
const MINHO: NewTeam = {
  name: '이민호', last4: '0042', party: 4,
  items: [
    { productKey: 'ski', quantity: 4 }, { productKey: 'clothes', variantKey: '95', quantity: 2 }, { productKey: 'clothes', variantKey: '100', quantity: 1 },
    { productKey: 'helmet', variantKey: '중', quantity: 1 }, { productKey: 'night_adult', quantity: 4 },
  ],
  methods: { gear: LATER, lift: 'cash' },
  payerLast4: '0032',
};
/** 이정호 가족의 나머지 세 팀(장비 값은 이정호 팀 결제 예정, 반납 22:00 설천 주차장 · 1호 차량). */
const JIEUN: NewTeam = {
  name: '강지은', last4: '0043', party: 1, items: [{ productKey: 'board', quantity: 1 }, { productKey: 'clothes', variantKey: '100', quantity: 1 }],
  giveBack: SEOLCHEON_2200, methods: { gear: LATER }, payerLast4: '0032',
};
const JUNSEO: NewTeam = { name: '이준서', last4: '0044', party: 1, items: [{ productKey: 'ski', quantity: 1 }], giveBack: SEOLCHEON_2200, methods: { gear: LATER }, payerLast4: '0032' };
const HAYUN: NewTeam = { name: '송하윤', last4: '0045', party: 1, items: [{ productKey: 'board', quantity: 1 }], giveBack: SEOLCHEON_2200, methods: { gear: LATER }, payerLast4: '0032' };

/**
 * 이야기 사건(시각 순). 단계마다 더한다: 1단계는 16:05 · 16:10 · 16:20 · 16:30 · 21:50, 2단계는 19:41 일정 변경, 3단계는 21:31 부분 반납 ·
 * 21:32 미수 수납 · 27일 00:15 정하늘 반납, 5단계는 16:26 ~ 16:35 새 접수 네 팀 · 지급과 21:55 이민호 팀 반납, 6단계는 16:41 이정호 팀
 * 일괄 수납, 7단계는 16:40 적재 · 16:57 배달 · 16:58 권 추가 · 22:00 · 22:10 차량 수거, 8단계는 23:48 매장 입고 · 현금 인계와 27일 00:32 차량
 * 현금 점검(plan.md 4-2 표). 9단계(운영 규칙)는 사건이 없다.
 */
export const STORY: readonly FxStoryEvent[] = [
  {
    id: 'park-issue', at: at(16, 5), note: '박준호 팀 수령 · 지급(준비 번호) + 권 3매 보증금 15,000원 현금',
    commands: (state) => issueWithDeposit(state, 'park-issue', 'o22'),
  },
  {
    id: 'younghee-return', at: at(16, 10), note: '김영희 팀 매장 반납(12:00 일정, 지연) + 미수 65,000원 현금',
    commands: (state) => returnAndPay(state, 'younghee-return', 'o27', 'cash'),
  },
  {
    id: 'jungho-pickup', at: at(16, 20), note: '이정호 팀 수령 · 지급',
    commands: (state) => issueWithDeposit(state, 'jungho-pickup', 'o32'),
  },
  {
    id: 'minho-order', at: at(16, 26), note: '이민호 팀 접수 확정 261226-019: 리프트권 140,000원 현금 + 보증금 20,000원 현금, 장비 225,000원 후불 → 이정호 팀',
    commands: (state) => newOrder(state, 'minho-order', at(16, 26), MINHO),
  },
  { id: 'minho-issue', at: at(16, 27), note: '이민호 팀 지급', commands: (state) => issueNew(state, 'minho-issue', MINHO.last4) },
  {
    id: 'jieun-order', at: at(16, 28), note: '강지은 팀 접수(보드 1 · 의류 1, 22:00 설천 주차장), 장비 후불 → 이정호 팀',
    commands: (state) => newOrder(state, 'jieun-order', at(16, 28), JIEUN),
  },
  { id: 'jieun-issue', at: at(16, 29), note: '강지은 팀 지급', commands: (state) => issueNew(state, 'jieun-issue', JIEUN.last4) },
  {
    id: 'seoyeon-return', at: at(16, 30), note: '이서연 팀 매장 반납(결제는 이정호 팀)',
    commands: (state) => returnAndPay(state, 'seoyeon-return', 'o36', 'cash'),
  },
  {
    id: 'van-1630', at: at(16, 30), note: '1호 차량 만선 광장 수거: 김민재 · 이수진',
    commands: (state) => collect(state, 'van-1630', ['o21', 'o23']),
  },
  {
    id: 'junseo-order', at: at(16, 31), note: '이준서 팀 접수(스키 1, 22:00 설천 주차장), 장비 후불 → 이정호 팀',
    commands: (state) => newOrder(state, 'junseo-order', at(16, 31), JUNSEO),
  },
  { id: 'junseo-issue', at: at(16, 32), note: '이준서 팀 지급', commands: (state) => issueNew(state, 'junseo-issue', JUNSEO.last4) },
  {
    id: 'hayun-order', at: at(16, 34), note: '송하윤 팀 접수(보드 1, 22:00 설천 주차장), 장비 후불 → 이정호 팀',
    commands: (state) => newOrder(state, 'hayun-order', at(16, 34), HAYUN),
  },
  { id: 'hayun-issue', at: at(16, 35), note: '송하윤 팀 지급', commands: (state) => issueNew(state, 'hayun-issue', HAYUN.last4) },
  {
    id: 'haeun-load', at: at(16, 40), note: '최하은 팀 차량 배달 적재(1호 차량, 스키 3 · 헬멧 3)',
    commands: (state) => loadVan(state, 'haeun-load', 'o26'),
  },
  {
    id: 'jungho-grouppay', at: at(16, 41), note: '이정호 팀 일괄 수납 카드 485,000원 · 6팀(이정호 · 이서연 · 이민호 · 강지은 · 이준서 · 송하윤)',
    commands: (state) => groupPay(state, 'jungho-grouppay', 'o32', 'card'),
  },
  {
    id: 'haeun-deliver', at: at(16, 57), note: '1호 차량 만선 광장 배달: 최하은 팀 스키 3 · 헬멧 3',
    commands: (state) => deliverAll(state, 'haeun-deliver', 'o26'),
  },
  {
    id: 'haeun-ticket', at: at(16, 58), note: '최하은 팀 리프트권 추가 야간권 1매 35,000원 + 보증금 5,000원(예비권 51번, 차량 지갑) → 현장 수납 35,000원 현금',
    commands: (state) => addTicketAndPay(state, 'haeun-ticket', 'o26', 'night_adult', 1, 'cash'),
  },
  {
    id: 'park-promise', at: at(19, 41), note: '박준호 팀 일정 변경: 보드 1 · 헬멧 1 · 권 1매 → 22:00 솔마을 두솔동 · 1호 차량',
    commands: (state) => parkPromise(state, 'park-promise'),
  },
  {
    id: 'park-return', at: at(21, 31), note: '박준호 팀 부분 반납: 스키 17 · 18, 헬멧 12 · 14, 권 31 · 32 + 권 2매 보증금 10,000원 현금 반환',
    commands: (state) => parkReturn(state, 'park-return'),
  },
  {
    id: 'park-pay', at: at(21, 32), note: '박준호 팀 미수 120,000원 카드',
    commands: (state) => payDue(state, 'park-pay', 'o22', 'card'),
  },
  {
    id: 'oseungmin-collect', at: at(21, 50), note: '1호 차량 꽃마을 들국화 수거: 오승민(긴급 · 조기 반납)',
    commands: (state) => collect(state, 'oseungmin-collect', ['o39']),
  },
  {
    id: 'minho-return', at: at(21, 55), note: '이민호 팀 매장 반납(권 4매 포함) + 보증금 20,000원 현금 반환',
    commands: (state) => { const o = byLast4(state, MINHO.last4); return o ? returnWithDeposit(state, 'minho-return', o.id) : [
]; },
  },
  {
    id: 'van-2200', at: at(22, 0), note: '1호 차량 22:00 수거: 설천 주차장(7팀 + 강지은 · 이준서 · 송하윤), 솔마을 두솔동 박준호(보드 5 · 헬멧 15 · 권 33) + 권 1매 보증금 5,000원 현장 반환',
    commands: (state) => vanCollect(state, 'van-2200', 'v1', at(22, 0)),
  },
  {
    id: 'tirol-2210', at: at(22, 10), note: '만선 티롤 앞: 최하은 팀 장비 수거(권 1매 못 받음), 정하늘 팀 고객 부재',
    commands: (state) => [
      ...vanCollect(state, 'tirol-2210', 'v1', at(22, 10), { orderIds: ['o26'], only: (l) => l.section !== 'lift' }),
      ...visitFailed(state, 'tirol-2210-visit', 'o41', 'customer_absent'),
    ],
  },
  {
    id: 'van-2348', at: at(23, 48), note: '1호 차량 매장 입고(김민수 팀 헬멧 1개 미입고) + 현금 인계 35,000원',
    commands: (state) => vanReturn(state, 'van-2348', 'v1', { 'o25-l2': 1 }),
  },
  {
    id: 'haneul-return', at: at(0, 15, 1), note: '정하늘 팀 매장 반납(27일 00:15, 기준 06:00 전이라 26일 영업일)',
    commands: (state) => returnAndPay(state, 'haneul-return', 'o41', 'cash'),
  },
  {
    id: 'van-cash-0032', at: at(0, 32, 1), note: '카운터가 1호 차량 현금 35,000원 점검(차액 0원, 넘기는 중 → 카운터 돈통)',
    commands: (state) => vanCashCheck(state, 'van-cash-0032', 'v1'),
  },
];

/** 명령 하나를 적는 함수(fixture-client가 applyCommand를 넘긴다: 여기서 commands.ts를 가져오면 순환이 생긴다). */
export type ApplyFn = (state: FxState, envelope: AnyCommandEnvelope, now: number) => CommandOutcome;

/**
 * upTo(ms)까지의 사건 중 아직 적지 않은 것을 시각 순으로 적는다. 적은 사건 id를 돌려준다.
 * 사건의 명령이 적용되지 않아도(사람이 먼저 함) 그 사건은 끝난 것으로 적는다(다시 시도하지 않는다).
 */
export function applyStory(state: FxState, upTo: number, apply: ApplyFn, events: readonly FxStoryEvent[] = STORY): string[] {
  const done: string[] = [];
  const due = events.filter((e) => e.at <= upTo && !state.storyApplied.includes(e.id)).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const event of due) {
    for (const envelope of event.commands(state)) apply(state, envelope, event.at);
    state.storyApplied.push(event.id);
    done.push(event.id);
  }
  return done;
}

/** 사건 명령의 요청번호(같은 사건을 다시 만들어도 같은 번호라 두 번 적히지 않는다). */
export const storyRequestId = (eventId: string, n = 0) => 'story:' + eventId + ':' + n;

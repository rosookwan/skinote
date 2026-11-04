// 보냄 대기로 온 기사 기록(sync 8-3 · 8-12, work/impl-offline/plan.md §5-1): 이미 일어난 사실이라 되도록 적고 거절하지 않는다. 표의 줄마다 한 시험과,
// 기사가 끊긴 채 할 수 있는 모든 명령 × 그사이의 바뀜(옮김 · 옮기고 다른 차량이 받음 · 매장 반납 · 끝남 · 접수 취소 · 마감 · epoch · 앞 명령 실패)에서
// 결과가 rejected · conflict · blocked가 아니고 돈이 맞는지(assertMoney).
import { describe, expect, it } from 'vitest';
import { offlineCommandTypes, type AnyCommandEnvelope, type ConfirmCommand } from '@skinote/contract';
import { applyCommand, findOrder, findTask, orderTasks, queuedCommandScope, runQuery, taskIdVehicle, type ShopState } from '../src/index.ts';
import { assertMoney } from './money-check.ts';
import { at, closeDay, ctx, envelopeOf, first, lines, moveToVan, online, queued } from './offline-helpers.ts';

const kinds = (s: ShopState) => (s.reviews ?? []).filter((r) => r.source === 'sync').map((r) => r.kindKey);

describe('any queued command', () => {
  it('another epoch, a failed dependency and a missing expect do not stop a queued fact', () => {
    const s = first();
    const collect = queued(s, { type: 'stock.collect', payload: { taskId: 'collect:o21', lines: lines(s, 'o21') } }, at(16, 35), undefined, { epoch: 'old-epoch' });
    expect(collect.outcome).toBe('applied');
    const visit = queued(s, { type: 'task.visit', payload: { taskId: 'collect:o23', outcomeKey: 'customer_absent' } }, at(16, 40), undefined, { dependsOn: ['01K62M3QG00000000000009999'] });
    expect(visit.outcome).toBe('applied');
    const money = queued(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 50_000, methodKey: 'cash' } }, at(16, 45));
    expect(money.outcome).toBe('applied');
    assertMoney(s);
  });

  it('the online path still refuses the same envelopes (epoch, dependency, expect)', () => {
    const s = first();
    expect(online(s, { type: 'stock.collect', payload: { taskId: 'collect:o21', lines: lines(s, 'o21') } }, at(16, 35), { epoch: 'old-epoch' }).error?.code).toBe('EPOCH_CHANGED');
    expect(online(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 50_000, methodKey: 'cash' } }, at(16, 45)).error?.code).toBe('EXPECT_REQUIRED');
    expect(online(s, { type: 'task.visit', payload: { taskId: 'collect:o23', outcomeKey: 'customer_absent' } }, at(16, 40), { dependsOn: ['01K62M3QG00000000000009999'] }).outcome).toBe('blocked');
  });
});

describe('stock.collect', () => {
  it('units moved to another van after the collection come back to this task: applied + task_moved_meanwhile; the other van loses the task', () => {
    const s = first();
    // 21:55 1호 차량 기사가 끊긴 채 김민수 팀(o25)을 받음 → 22:10 카운터가 모두 2호 차량으로 옮김 → 22:30 기록 도착.
    moveToVan(s, 'o25', 'v2', at(22, 10));
    expect(findTask(s, 'collect:o25')).toBeUndefined();
    const moved = orderTasks(findOrder(s, 'o25')!);
    expect(moved.map((t) => t.promise.vehicleId)).toEqual(['v2']);
    expect(taskIdVehicle(s, 'collect:o25')).toBe('v1');
    const out = queued(s, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(s, 'o25') } }, at(21, 55), at(22, 30));
    expect(out.outcome).toBe('applied');
    const o = findOrder(s, 'o25')!;
    expect(o.lines.map((l) => l.collected)).toEqual([4, 2]);
    expect(orderTasks(o).map((t) => t.id)).toEqual(['collect:o25']);
    expect(kinds(s)).toEqual(['task_moved_meanwhile']);
    expect(s.reviews!.at(-1)!.message).toBe('김민수 팀 업무 · 1호 차량 처리 완료 · 2호 차량 업무 취소');
    assertMoney(s);
  });

  it('moved and the other van already collected some: only what is still with the customer comes back (partially_applied + collect_exceeds)', () => {
    const s = first();
    moveToVan(s, 'o25', 'v2', at(22, 10));
    const task = orderTasks(findOrder(s, 'o25')!)[0]!;
    // 2호 차량이 스키 3대를 받음(온라인).
    expect(online(s, { type: 'stock.collect', payload: { taskId: task.id, lines: [{ lineId: 'o25-l1', quantity: 3 }] } }, at(22, 20)).outcome).toBe('applied');
    const out = queued(s, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(s, 'o25') } }, at(21, 55), at(22, 30));
    expect(out.outcome).toBe('partially_applied');
    const o = findOrder(s, 'o25')!;
    // 스키: 2호 3대 + 1호 1대, 헬멧 2개는 1호. 두 차량이 같은 것을 두 번 세지 않는다.
    expect(o.lines.map((l) => l.collected)).toEqual([4, 2]);
    const split = o.splits!.find((x) => x.lineId === 'o25-l1')!;
    expect(split.collected).toBe(3);
    expect(split.quantity).toBeGreaterThanOrEqual(3);
    expect(kinds(s).sort()).toEqual(['collect_exceeds', 'task_moved_meanwhile']);
    assertMoney(s);
  });

  it('moved and the other van collected everything: needs_review + collect_exceeds, nothing moves', () => {
    const s = first();
    moveToVan(s, 'o25', 'v2', at(22, 10));
    const task = orderTasks(findOrder(s, 'o25')!)[0]!;
    expect(online(s, { type: 'stock.collect', payload: { taskId: task.id, lines: lines(s, 'o25') } }, at(22, 20)).outcome).toBe('applied');
    const before = JSON.stringify(findOrder(s, 'o25')!.lines);
    const out = queued(s, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(s, 'o25') } }, at(21, 55), at(22, 30));
    expect(out.outcome).toBe('needs_review');
    expect(JSON.stringify(findOrder(s, 'o25')!.lines)).toBe(before);
    expect(kinds(s)).toEqual(['collect_exceeds']);
  });

  it('a split made before the collection is not pulled back (the driver saw it moved)', () => {
    const s = first();
    moveToVan(s, 'o25', 'v2', at(21, 0));
    const out = queued(s, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(s, 'o25') } }, at(21, 55), at(22, 30));
    expect(out.outcome).toBe('needs_review');
    expect(findOrder(s, 'o25')!.lines.map((l) => l.collected)).toEqual([0, 0]);
  });

  it('the scope of a queued fact is the van of the task id itself, also after a move', () => {
    const s = first();
    moveToVan(s, 'o25', 'v2', at(22, 10));
    const env = envelopeOf(s, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(s, 'o25') } }, { deviceSeq: 1 });
    expect(queuedCommandScope(s, env)).toEqual({ kind: 'vehicle', vehicleIds: ['v1'], orderId: 'o25' });
  });

  it('the scope of a task whose own van is unknown falls back to the order’s vans; a store-only order has none (§17 R3-10)', () => {
    const s = first();
    const vanless = s.orders.find((o) => o.pickup.mode !== 'vehicle' && o.giveBack.mode !== 'vehicle');
    expect(vanless, 'a store-only order in the sample').toBeDefined();
    const pay = envelopeOf(s, { type: 'field.collect', payload: { taskId: 'collect:' + vanless!.id, orderId: vanless!.id, amount: 1_000, methodKey: 'cash' } }, { deviceSeq: 1 });
    expect(queuedCommandScope(s, pay)).toEqual({ kind: 'vehicle', vehicleIds: [], orderId: vanless!.id });
    // 사라진 나눈 일정의 업무 id: 업무 id 자체의 차량은 모르지만 접수는 1호 차량과 이어져 있다.
    const ghost = envelopeOf(s, { type: 'task.visit', payload: { taskId: 'collect:o25:gone', outcomeKey: 'customer_absent' } }, { deviceSeq: 2 });
    expect(taskIdVehicle(s, 'collect:o25:gone')).toBeUndefined();
    expect(queuedCommandScope(s, ghost)).toEqual({ kind: 'vehicle', vehicleIds: ['v1'], orderId: 'o25' });
  });
});

describe('stock.deliver', () => {
  it('nothing loaded (the load was never recorded): the skipped hop is written with the delivery', () => {
    const s = first();
    const o26 = () => findOrder(s, 'o26')!;
    expect(o26().lines.map((l) => l.loaded)).toEqual([0, 0]);
    expect(online(s, { type: 'stock.deliver', payload: { taskId: 'deliver:o26', lines: lines(s, 'o26') } }, at(17, 5)).outcome).toBe('rejected');
    const out = queued(s, { type: 'stock.deliver', payload: { taskId: 'deliver:o26', lines: lines(s, 'o26') } }, at(17, 5), at(17, 30));
    expect(out.outcome).toBe('applied');
    expect(o26().lines.map((l) => [l.loaded, l.issued])).toEqual([[3, 3], [3, 3]]);
  });
});

describe('task.visit', () => {
  it('the task was collected meanwhile: the visit is recorded, the retry time is not applied', () => {
    const s = first();
    const before = findOrder(s, 'o21')!.giveBack.at;
    expect(online(s, { type: 'stock.collect', payload: { taskId: 'collect:o21', lines: lines(s, 'o21') } }, at(16, 50)).outcome).toBe('applied');
    const out = queued(s, { type: 'task.visit', payload: { taskId: 'collect:o21', outcomeKey: 'customer_absent', retry: { date: '2026-12-26', at: new Date(at(18, 0)).toISOString() } } }, at(16, 35), at(17, 0));
    expect(out.outcome).toBe('applied');
    const o = findOrder(s, 'o21')!;
    expect(o.visits?.at(-1)).toMatchObject({ at: at(16, 35), outcomeKey: 'customer_absent' });
    expect(o.visits?.at(-1)?.retryAt).toBeUndefined();
    expect(o.giveBack.at).toBe(before);
  });

  it('a later visit already decided: the older queued retry does not move the task', () => {
    const s = first();
    expect(online(s, { type: 'task.visit', payload: { taskId: 'collect:o23', outcomeKey: 'customer_absent', retry: { date: '2026-12-26', at: new Date(at(19, 0)).toISOString() } } }, at(17, 0)).outcome).toBe('applied');
    queued(s, { type: 'task.visit', payload: { taskId: 'collect:o23', outcomeKey: 'place_changed', retry: { date: '2026-12-26', at: new Date(at(18, 0)).toISOString() } } }, at(16, 40), at(17, 10));
    expect(findOrder(s, 'o23')!.giveBack.at).toBe(at(19, 0));
  });

  it('a moved task: the visit is recorded on the order without moving any promise', () => {
    const s = first();
    moveToVan(s, 'o25', 'v2', at(22, 10));
    const splitAt = findOrder(s, 'o25')!.splits![0]!.promise.at;
    const out = queued(s, { type: 'task.visit', payload: { taskId: 'collect:o25', outcomeKey: 'customer_absent', retry: { date: '2026-12-26', at: new Date(at(23, 30)).toISOString() } } }, at(21, 55), at(22, 30));
    expect(out.outcome).toBe('applied');
    expect(findOrder(s, 'o25')!.splits![0]!.promise.at).toBe(splitAt);
  });
});

describe('field money', () => {
  it('a ghost task: money for a task moved away is still recorded on the order, in the van wallet of the task id', () => {
    const s = first();
    moveToVan(s, 'o28', 'v2', at(10, 0));
    const out = queued(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 120_000, methodKey: 'cash' } }, at(9, 55), at(10, 30));
    expect(out.outcome).toBe('applied');
    const pay = findOrder(s, 'o28')!.payments.at(-1)!;
    expect(pay).toMatchObject({ amount: 120_000, drawerId: 'van:v1', deviceId: 'dev-phone', recordedAt: at(10, 30) });
    assertMoney(s);
  });

  it('field.add_ticket with a changed price is recorded at the device amount', () => {
    const s = first();
    const quote = runQuery(s, 'addTicketSheet', { taskId: 'collect:o25', productKey: 'night_adult', quantity: 1 }, ctx(at(21, 0)));
    const amount = (quote.command?.payload as { amount: number }).amount;
    const out = queued(s, { type: 'field.add_ticket', payload: { taskId: 'collect:o25', orderId: 'o25', productKey: 'night_adult', quantity: 1, assetIds: [], amount: amount - 5_000 } }, at(21, 0), at(21, 20));
    expect(out.outcome).toBe('applied');
    expect(findOrder(s, 'o25')!.lines.at(-1)!.amount).toBe(amount - 5_000);
  });
});

describe('route and notices', () => {
  it('a route move whose task is gone and an ack of a vanished pin are superseded, nothing written', () => {
    const s = first();
    const rev = s.rev;
    expect(queued(s, { type: 'route.move', payload: { taskId: 'collect:o99', anchorTaskId: null, position: 'top' } }, at(21, 0)).outcome).toBe('superseded');
    expect(queued(s, { type: 'notification.ack', payload: { notificationId: 'pin99' } }, at(21, 0)).outcome).toBe('superseded');
    expect(s.rev).toBe(rev);
  });
});

/** 기사가 끊긴 채 보낼 수 있는 명령의 본문(첫 매장, 1호 차량). */
function commandsOf(s: ShopState): { name: string; command: ConfirmCommand }[] {
  return [
    { name: 'collect o25', command: { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(s, 'o25') } } },
    { name: 'collect o21', command: { type: 'stock.collect', payload: { taskId: 'collect:o21', lines: lines(s, 'o21') } } },
    { name: 'deliver o26', command: { type: 'stock.deliver', payload: { taskId: 'deliver:o26', lines: lines(s, 'o26') } } },
    { name: 'visit o25', command: { type: 'task.visit', payload: { taskId: 'collect:o25', outcomeKey: 'customer_absent', retry: { date: '2026-12-26', at: new Date(at(23, 30)).toISOString() } } } },
    { name: 'field.collect o28', command: { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 120_000, methodKey: 'cash' } } },
    { name: 'add_ticket o25', command: { type: 'field.add_ticket', payload: { taskId: 'collect:o25', orderId: 'o25', productKey: 'night_adult', quantity: 1, assetIds: [], amount: 35_000 } } },
    { name: 'route.move', command: { type: 'route.move', payload: { taskId: 'collect:o25', anchorTaskId: null, position: 'top' } } },
    { name: 'route.reset', command: { type: 'route.reset', payload: { vehicleId: 'v1', date: '2026-12-26' } } },
    { name: 'ack pin1', command: { type: 'notification.ack', payload: { notificationId: 'pin1' } } },
  ];
}

/** 그사이의 바뀜(카운터 · 다른 차량). */
const PERTURB: Record<string, (s: ShopState) => void> = {
  none: () => {},
  moved: (s) => { moveToVan(s, 'o25', 'v2', at(22, 10)); moveToVan(s, 'o28', 'v2', at(22, 10)); },
  'moved and collected': (s) => {
    moveToVan(s, 'o25', 'v2', at(22, 10));
    const task = orderTasks(findOrder(s, 'o25')!)[0]!;
    online(s, { type: 'stock.collect', payload: { taskId: task.id, lines: lines(s, 'o25') } }, at(22, 15));
  },
  'returned at counter': (s) => {
    for (const id of ['o25', 'o21']) online(s, { type: 'stock.direct_return', payload: { orderId: id, lines: lines(s, id) } }, at(22, 12));
  },
  'task finished': (s) => { online(s, { type: 'stock.collect', payload: { taskId: 'collect:o25', lines: lines(s, 'o25') } }, at(22, 12)); },
  'order cancelled': (s) => {
    const sheet = runQuery(s, 'cancelSheet', { orderId: 'o26', scope: 'order', reasonKey: 'request' }, ctx(at(16, 0)));
    if (sheet.command) online(s, sheet.command, at(16, 0), sheet.expect ? { expect: sheet.expect } : {});
  },
  'day closed': (s) => { expect(closeDay(s, at(23, 0)).outcome).toBe('applied'); },
  'epoch changed': (s) => { s.epoch = 'restored-epoch'; },
};

describe('never refused: every driver offline command × every perturbation', () => {
  for (const [name, perturb] of Object.entries(PERTURB)) {
    it(name, () => {
      const probe = first();
      for (const { name: what } of commandsOf(probe)) {
        const s = first();
        const command = commandsOf(s).find((x) => x.name === what)!.command;
        const env: AnyCommandEnvelope = envelopeOf(s, command, { deviceSeq: 7, dependsOn: ['01K62M3QG00000000000009998'] });
        perturb(s);
        const out = applyCommand(s, env, at(21, 55), undefined, { orderIds: 'dated', recordedAt: at(23, 30), actor: { deviceId: 'dev-phone', name: '박기사' } });
        expect(['rejected', 'conflict', 'blocked'], what + ': ' + JSON.stringify(out)).not.toContain(out.outcome);
        assertMoney(s);
      }
    });
  }

  it('covers every command type a driver device may queue', () => {
    expect(new Set(commandsOf(first()).map((x) => x.command.type))).toEqual(new Set(offlineCommandTypes('driver_phone').filter((t) => t !== 'field.deposit_return')));
  });
});

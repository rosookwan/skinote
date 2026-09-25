// 쌍둥이 실행(plan §4-8의 주 시험): 견본 하루를 넣고(importDay), 체험판 뒷이야기의 모든 명령(apps/pos/src/fixture/story.ts)과 더한
// 명령 묶음을 메모리(도메인 execute)와 저장소(ShopStore.command, 매장 파일)에 차례로 보낸다. 명령마다:
//   - 결과가 같다(rev 빼고),
//   - store.state(표에서 읽은 상태)가 메모리 상태와 같다(메모리 어댑터 몫 outcomes · storyApplied · driverDevice 빼고),
//   - 캐시 없이 새로 연 저장소도 같은 상태를 읽는다.
// 장부 트리거가 켜져 있으므로 장부 표를 고치는 쓰기가 있으면 명령이 INTERNAL로 끝나 결과 비교에서 걸린다. 표 옮기기의 되읽기를 명령
// 종류마다(접수 · 지급 · 반납 · 수납 · 일괄 수납 · 보증금 · 일정 변경 · 적재 · 배달 · 수거 · 입고 · 현장 수납 · 리프트권 추가 · 방문 ·
// 빨리 확인 · 순서 · 현금 인계 · 점검 · 마감 · 운영 규칙 · 후불 처리) 맞춘다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultUiConfig, type AnyCommandEnvelope, type CommandOutcome, type OrderDraftInput, type PromiseSheetParams } from '@skinote/contract';
import {
  PRODUCTION_LINES, checkoutPlan, execute, kstAt, orderTasks, routeTasks, ruleKeys, runQuery, sampleDay, sortTasks, type ReadContext, type ShopState,
} from '@skinote/domain';
import { STORY } from '../../../apps/pos/src/fixture/story.ts';
import { canonicalJson, num, one, verifyChain, type Db, type ShopStore } from '../src/index.ts';
import { COUNTER, envelope, provisioned, T0 } from './helpers.ts';

const DATE = '2026-12-26';

/** 저장소가 들고 있지 않은 칸(메모리 어댑터 몫)을 뺀 모양. */
const comparable = (s: ShopState) => canonicalJson({ ...s, outcomes: {}, storyApplied: [], driverDevice: { offline: false, queue: [] } });

/** 두 모양이 다르면 처음 다른 곳을 보여 준다. */
function sameState(actual: ShopState, expected: ShopState, name: string): void {
  if (comparable(actual) === comparable(expected)) return;
  const x = JSON.parse(comparable(actual)) as Record<string, unknown>;
  const y = JSON.parse(comparable(expected)) as Record<string, unknown>;
  for (const key of Object.keys(y)) {
    if (canonicalJson(x[key]) === canonicalJson(y[key])) continue;
    if (key === 'orders') {
      const xs = x.orders as { id: string }[];
      for (const o of y.orders as { id: string }[]) {
        const got = xs.find((q) => q.id === o.id);
        if (canonicalJson(got) !== canonicalJson(o)) assert.deepEqual(got, o, name + ': order ' + o.id);
      }
    }
    assert.deepEqual(x[key], y[key], name + ': ' + key);
  }
}

interface Twin {
  db: Db;
  store: ShopStore;
  memory: ShopState;
  applied: number;
  run(env: AnyCommandEnvelope, now: number, name: string): CommandOutcome;
  read(now: number): ReadContext;
}

/** 견본 매장 + 견본 하루(체험 id)를 넣은 쌍둥이. */
function twin(): Twin {
  const { db, store, reopen } = provisioned();
  const empty = store.state(T0);
  const day = sampleDay({ date: DATE, epoch: empty.epoch, ids: 'demo' });
  const imported = store.importDay({ date: DATE, orders: day.orders, pins: day.pins, deposits: day.deposits, paymentGroups: day.paymentGroups }, 'import:sample:' + DATE, T0, COUNTER);
  assert.equal(imported.replay, false);
  const again = store.importDay({ date: DATE, orders: day.orders, pins: day.pins, deposits: day.deposits, paymentGroups: day.paymentGroups }, 'import:sample:' + DATE, T0, COUNTER);
  assert.deepEqual(again, { orders: day.orders.length, replay: true, rev: imported.rev }, 'the same import request id twice writes nothing');
  const memory: ShopState = {
    ...structuredClone(empty),
    orders: day.orders.map((o) => ({ ...o, lines: o.lines.map((l) => ({ ...l, productKey: l.productKey ?? l.kind })) })),
    pins: day.pins,
    rev: imported.rev,
    nextReceiptSeq: day.nextReceiptSeq,
  };
  sameState(store.state(T0), memory, 'import');
  sameState(reopen().state(T0), memory, 'import · fresh store');
  const outcomes = new Map<string, CommandOutcome['outcome']>();
  const t: Twin = {
    db, store, memory, applied: 0,
    run(env, now, name) {
      const mem = execute(t.memory, env, {
        now, actor: COUNTER, outcomeOf: (id) => (outcomes.has(id) ? { outcome: outcomes.get(id)! } : undefined), lines: PRODUCTION_LINES, orderIds: 'dated',
      });
      const got = store.command(env, COUNTER, now);
      assert.equal(got.outcome, mem.outcome.outcome, name + ': outcome ' + JSON.stringify(got.error ?? null) + ' vs ' + JSON.stringify(mem.outcome.error ?? null));
      assert.deepEqual(got.error ?? null, mem.outcome.error ?? null, name + ': error');
      assert.deepEqual(got.result ?? null, mem.outcome.result ?? null, name + ': result');
      outcomes.set(env.requestId, got.outcome);
      if (got.outcome === 'applied') {
        t.applied += 1;
        assert.equal(got.rev, t.memory.rev + 1, name + ': one rev per applied command');
        t.memory = { ...mem.state, rev: got.rev };
      }
      sameState(store.state(now), t.memory, name);
      sameState(reopen().state(now), t.memory, name + ' · fresh store');
      return got;
    },
    read: (now) => ({ config: defaultUiConfig({ shopName: t.memory.registry.shopName, timezone: 'Asia/Seoul' }), now, lines: PRODUCTION_LINES }),
  };
  return t;
}

const at = (h: number, m: number, dayOffset = 0, s = 0) => kstAt(DATE, dayOffset, h, m) + s * 1000;
const basisOf = (t: Twin) => ({ epoch: t.memory.epoch, rev: t.memory.rev });

/** 마감: 돈통을 예상대로 센 뒤 마감 명령(창이 주는 그대로). */
function closeDay(t: Twin, now: number): CommandOutcome | null {
  const first = runQuery(t.memory, 'closingSheet', { date: DATE }, t.read(now));
  if (!first.next || first.next.kind === 'van_check') return null;
  const expected = first.next.kind === 'drawer_count' ? first.next.expectedAmount ?? 0 : 0;
  const sheet = runQuery(t.memory, 'closingSheet', { date: DATE, counts: [{ drawerId: 'counter', countedAmount: expected }] }, t.read(now));
  if (!sheet.command) return null;
  return t.run(envelope(sheet.command.type, sheet.command.payload as never, basisOf(t), { expect: sheet.expect! }), now, 'closing');
}

test('twin run: the sample day, every story command and the closing give the same state in memory and in the shop file', () => {
  const t = twin();
  const events = [...STORY].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const types = new Set<string>();
  let commands = 0;
  for (const event of events) {
    for (const env of event.commands(t.memory)) {
      commands += 1;
      types.add(env.type);
      t.run(env, event.at, event.id + ' ' + env.type);
    }
  }
  assert.ok(commands >= 30, 'the story sends many commands: ' + commands);
  for (const type of ['order.create', 'stock.issue', 'stock.direct_return', 'payment.take', 'deposit.take', 'deposit.return', 'promise.change', 'stock.load', 'stock.deliver',
    'stock.collect', 'stock.receive', 'field.collect', 'field.add_ticket', 'field.deposit_return', 'task.visit', 'cash.transfer', 'cash.transfer_confirm']) {
    assert.ok(types.has(type), 'the story covers ' + type);
  }
  const closed = closeDay(t, at(0, 40, 1));
  assert.equal(closed?.outcome, 'applied', 'the day closes after the story');
  assert.equal(t.memory.closings.length, 1);
  assert.deepEqual(verifyChain(t.db, 'shop0test'), { rows: t.applied + 1, brokenAt: null }, 'one events row per applied command + the import');
  assert.equal(num(one(t.db, "SELECT count(*) AS n FROM events WHERE engine_key = 'import' AND imported = 1")?.n), 1);
});

test('twin run: the corpus beyond the story (walk-in off the minute, goggles, pin · ack, route order, visit retry, extension and undo, rules, pay later)', () => {
  const t = twin();

  // 현장 대여를 분이 아닌 시각에(수령 약속은 분으로 내림), 고글(수량 품목 · 규격)과 함께. 현금.
  const draft: OrderDraftInput = {
    channel: 'walk_in', leader: { name: '김민수', phone: '01000001234', party: 2 },
    items: [{ productKey: 'ski', quantity: 1 }, { productKey: 'goggles', variantKey: '어른', quantity: 2 }], pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' },
  };
  const choices = [{ sectionKey: 'gear', methodKey: 'cash' }];
  const now = at(15, 50, 0, 17);
  const plan = checkoutPlan(structuredClone(t.memory), now, draft, choices, null);
  const created = t.run(envelope('order.create', { draft, choices, payerOrderId: null }, basisOf(t), { expect: { quoteHash: plan.hash } }), now, 'walk-in with goggles');
  assert.equal(created.outcome, 'applied');
  const orderId = (created.result as { orderId: string }).orderId;
  assert.match(orderId, /^n261226\d{3}$/, 'server order ids come from the receipt number');
  const o = t.memory.orders.find((x) => x.id === orderId)!;
  assert.equal(o.pickup.at % 60_000, 0, 'the walk-in pickup is floored to the minute');
  t.run(envelope('stock.issue', { orderId, lines: o.lines.map((l) => ({ lineId: l.id, quantity: l.qty })) }, basisOf(t)), at(15, 51, 0, 3), 'issue ski + goggles');
  t.run(envelope('stock.direct_return', { orderId, lines: o.lines.map((l) => ({ lineId: l.id, quantity: 1 })) }, basisOf(t)), at(15, 52), 'partial return');

  // 빨리 확인 → 기사 확인.
  const o25 = t.memory.orders.find((x) => x.id === 'o25')!;
  const task = orderTasks(o25)[0]!;
  assert.equal(t.run(envelope('task.pin', { taskId: task.id, note: '조기 반납' }, basisOf(t)), at(16, 1), 'pin').outcome, 'applied');
  t.run(envelope('notification.ack', { notificationId: t.memory.pins.at(-1)!.id }, basisOf(t)), at(16, 2), 'ack');

  // 방문 순서: 끝 업무를 맨 앞으로, 그다음 시간순으로 되돌림.
  const route = sortTasks(t.memory, routeTasks(t.memory, 'v1', DATE));
  assert.ok(route.length >= 2, 'v1 has a route');
  t.run(envelope('route.move', { taskId: route.at(-1)!.id, anchorTaskId: route[0]!.id, position: 'before' }, basisOf(t)), at(16, 3), 'route move');
  t.run(envelope('route.reset', { vehicleId: 'v1', date: DATE }, basisOf(t)), at(16, 4), 'route reset');

  // 방문 결과(수거 · 고객 부재 · 재방문 22:30:42 → 22:30).
  t.run(envelope('task.visit', { taskId: 'collect:o29', outcomeKey: 'customer_absent', retry: { date: DATE, at: new Date(at(22, 30, 0, 42)).toISOString() } }, basisOf(t)), at(16, 5), 'visit retry');

  // 일정 변경: 스키 1대를 내일 오후 매장 반납으로(연장 +), 다시 오늘 22:00 설천 주차장으로(연장 취소 −).
  const o31 = t.memory.orders.find((x) => x.id === 'o31')!;
  const move = (params: Omit<PromiseSheetParams, 'orderId'>, when: number, name: string) => {
    const view = runQuery(t.memory, 'promiseSheet', { orderId: o31.id, ...params }, t.read(when));
    assert.ok(view.command, name + ': the sheet offers a command');
    return t.run(envelope(view.command.type, view.command.payload as never, basisOf(t), view.expect ? { expect: view.expect } : {}), when, name);
  };
  const line = o31.lines[0]!.id;
  assert.equal(move({ quantities: { [line]: 1 }, slot: { day: 'tomorrow', slotKey: 'afternoon' }, place: { mode: 'store' } }, at(16, 6), 'promise +1 day').outcome, 'applied');
  assert.ok(t.memory.orders.find((x) => x.id === 'o31')!.charges?.some((c) => c.kind === 'extension' && c.amount > 0), 'an extension charge');
  assert.equal(move({ quantities: { [line]: 1 }, slot: { day: 'today', slotKey: 'night' }, place: { mode: 'vehicle', placeKey: 'seolcheon_parking' }, vehicleId: 'v1' }, at(16, 7), 'promise back').outcome, 'applied');
  assert.ok(t.memory.orders.find((x) => x.id === 'o31')!.charges?.some((c) => c.kind === 'extension_undo' && c.amount < 0), 'an extension undo');

  // 운영 규칙(당일 취소 환불 없음) — 같은 바탕의 두 번째 창은 충돌(registry:shop_rules).
  const keys = ruleKeys(t.memory.registry, t.memory.settings);
  const stale = basisOf(t);
  t.run(envelope('setting.set', { changes: [{ key: keys.refund, value: 'no_refund' }] }, stale), at(16, 8), 'rules');
  const conflict = t.store.command(envelope('setting.set', { changes: [{ key: keys.prepay, value: 'none' }] }, stale), COUNTER, at(16, 9));
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(conflict.error?.code, 'VERSION_CONFLICT');

  // 후불 처리(현장 수납 판): 이 팀 미수를 반납 때 받기로(윤서준 팀, 미수 있음 · 받을 때 반납이 아니게 먼저 바꾼 뒤).
  const o37 = t.memory.orders.find((x) => x.id === 'o28')!;
  t.run(envelope('payment_promise.set', { orderId: o37.id, payerOrderId: null }, basisOf(t)), at(16, 10), 'pay later');
});

test('importDay refuses a shop that is not a test shop', () => {
  const { db, store } = provisioned();
  db.exec('UPDATE shops SET is_test = 0');
  const empty = store.state(T0);
  const day = sampleDay({ date: DATE, epoch: empty.epoch, ids: 'demo' });
  assert.throws(() => store.importDay({ date: DATE, orders: day.orders, pins: day.pins, deposits: day.deposits, paymentGroups: day.paymentGroups }, 'import:sample:x', T0, COUNTER),
    (e: unknown) => (e as { code?: string }).code === 'NOT_TEST_SHOP');
  assert.equal(num(one(db, 'SELECT count(*) AS n FROM orders')?.n), 0);
});

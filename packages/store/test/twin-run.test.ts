// 쌍둥이 실행(plan §4-8의 주 시험): 견본 하루를 넣고(importDay), 체험판 뒷이야기의 모든 명령(apps/pos/src/fixture/story.ts)과 더한
// 명령 묶음을 메모리(도메인 execute)와 저장소(ShopStore.command, 매장 파일)에 차례로 보낸다. 명령마다:
//   - 결과가 같다(rev 빼고),
//   - store.state(표에서 읽은 상태)가 메모리 상태와 같다(메모리 어댑터 몫 outcomes · storyApplied · driverDevice 빼고),
//   - 캐시 없이 새로 연 저장소도 같은 상태를 읽는다.
// 장부 트리거가 켜져 있으므로 장부 표를 고치는 쓰기가 있으면 명령이 INTERNAL로 끝나 결과 비교에서 걸린다. 표 옮기기의 되읽기를 명령
// 종류마다(접수 · 지급 · 반납 · 수납 · 일괄 수납 · 보증금 · 일정 변경 · 적재 · 배달 · 수거 · 입고 · 현장 수납 · 리프트권 추가 · 방문 ·
// 빨리 확인 · 순서 · 현금 인계 · 점검 · 마감 · 운영 규칙 · 후불 처리) 맞춘다.
// 견본 매장은 첫 매장(2026-09-26: 모든 품목 수량 · 보증금 없음 · 수량 차량 예비권)이고, 번호 · 권 보증금을 켠 매장(shop 'numbered')도 같은
// 이야기로 한 번 더 돌린다(번호 실물 · 보증금 장부의 되읽기).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultUiConfig, type AnyCommandEnvelope, type CancelSheetParams, type CheckoutChoice, type CommandOutcome, type DiscountChoice, type DraftItem, type ExchangeSheetParams,
  type OrderDraftInput,
  type PromiseSheetParams,
} from '@skinote/contract';
import {
  PRODUCTION_LINES, checkoutPlan, execute, kstAt, orderTasks, routeTasks, ruleKeys, runQuery, sampleDay, sortTasks, type ReadContext, type SampleShop, type ShopState,
} from '@skinote/domain';
import { STORY } from '../../../apps/pos/src/fixture/story.ts';
import { all, canonicalJson, num, one, str, verifyChain, type Actor, type Db, type ShopStore } from '../src/index.ts';
import { COUNTER, countDiff, envelope, provisioned, rowCounts, T0 } from './helpers.ts';

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
  run(env: AnyCommandEnvelope, now: number, name: string, actor?: Actor): CommandOutcome;
  read(now: number): ReadContext;
}

/** 견본 매장 + 견본 하루(체험 id)를 넣은 쌍둥이. shop: 첫 매장(기본) · 번호 매장. */
function twin(shop: SampleShop = 'first'): Twin {
  const { db, store, reopen } = provisioned(':memory:', {}, shop);
  const empty = store.state(T0);
  const day = sampleDay({ date: DATE, epoch: empty.epoch, ids: 'demo', shop });
  // 견본 하루에는 견본 확인 필요 한 건(최은정 팀, 출처 import)도 있다(features-1 §9-6).
  const input = { date: DATE, orders: day.orders, pins: day.pins, deposits: day.deposits, paymentGroups: day.paymentGroups, reviews: day.reviews ?? [] };
  const imported = store.importDay(input, 'import:sample:' + DATE, T0, COUNTER);
  assert.equal(imported.replay, false);
  const again = store.importDay(input, 'import:sample:' + DATE, T0, COUNTER);
  assert.deepEqual(again, { orders: day.orders.length, replay: true, rev: imported.rev }, 'the same import request id twice writes nothing');
  const memory: ShopState = {
    ...structuredClone(empty),
    orders: day.orders.map((o) => ({ ...o, lines: o.lines.map((l) => ({ ...l, productKey: l.productKey ?? l.kind })) })),
    pins: day.pins,
    rev: imported.rev,
    nextReceiptSeq: day.nextReceiptSeq,
    reviews: day.reviews ?? [],
  };
  sameState(store.state(T0), memory, 'import');
  sameState(reopen().state(T0), memory, 'import · fresh store');
  const outcomes = new Map<string, CommandOutcome['outcome']>();
  const t: Twin = {
    db, store, memory, applied: 0,
    run(env, now, name, actor = COUNTER) {
      const mem = execute(t.memory, env, {
        now, actor, outcomeOf: (id) => (outcomes.has(id) ? { outcome: outcomes.get(id)! } : undefined), lines: PRODUCTION_LINES, orderIds: 'dated',
      });
      const got = store.command(env, actor, now);
      assert.equal(got.outcome, mem.outcome.outcome, name + ': outcome ' + JSON.stringify(got.error ?? null) + ' vs ' + JSON.stringify(mem.outcome.error ?? null));
      assert.deepEqual(got.error ?? null, mem.outcome.error ?? null, name + ': error');
      assert.deepEqual(got.result ?? null, mem.outcome.result ?? null, name + ': result');
      outcomes.set(env.requestId, got.outcome);
      // 적은 것이 확인 필요뿐인 명령(결과는 superseded, features-1 E18)도 한 rev를 쓴다.
      if (got.outcome === 'applied' || (got.outcome === 'superseded' && mem.state !== t.memory)) {
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

/** 이야기의 모든 사건을 시각 순으로 쌍둥이에 보낸다. 보낸 명령 종류와 수. */
function runStory(t: Twin): { types: Set<string>; commands: number } {
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
  return { types, commands };
}

/**
 * 수량 재고의 투영(stock_balances)이 이동 줄의 합과 같은지(위치 · 규격마다, 처음 재고의 출발인 바깥 위치는 빼고). 첫 매장은 모든 종류가
 * 수량이라 이 투영이 재고 기록의 전부다(2026-09-26). 음수를 0으로 멈춘 기록(integrity_findings projection_drift)도 없어야 한다.
 */
function assertBalancesMatchMovements(db: Db, name: string): void {
  const moved = new Map<string, number>();
  const add = (location: string, variant: string, n: number) => moved.set(location + '|' + variant, (moved.get(location + '|' + variant) ?? 0) + n);
  for (const r of all(db, `SELECT m.from_location_id AS f, m.to_location_id AS t, ml.variant_id AS v, ml.quantity AS q FROM stock_movement_lines ml
    JOIN stock_movements m ON m.shop_id = ml.shop_id AND m.id = ml.movement_id WHERE ml.asset_id IS NULL AND ml.variant_id IS NOT NULL`)) {
    add(str(r.t), str(r.v), num(r.q));
    add(str(r.f), str(r.v), -num(r.q));
  }
  const balances = new Map(all(db, "SELECT location_id, variant_id, quantity FROM stock_balances WHERE owner_key = '' AND lot_key = ''")
    .map((r) => [str(r.location_id) + '|' + str(r.variant_id), num(r.quantity)] as const));
  for (const [key, n] of moved) {
    if (key.startsWith('external|')) continue;
    assert.equal(balances.get(key) ?? 0, n, name + ': stock_balances ' + key + ' = the sum of its movement lines');
  }
  for (const [key, n] of balances) if (!moved.has(key)) assert.equal(n, 0, name + ': a balance row without movements is 0: ' + key);
  assert.equal(num(one(db, "SELECT count(*) AS n FROM integrity_findings WHERE check_key = 'projection_drift'")?.n), 0, name + ': no balance was clamped at 0');
}

const STOCK_AND_MONEY = ['order.create', 'stock.issue', 'stock.direct_return', 'payment.take', 'promise.change', 'stock.load', 'stock.deliver',
  'stock.collect', 'stock.receive', 'field.collect', 'field.add_ticket', 'task.visit', 'cash.transfer', 'cash.transfer_confirm'];
const DEPOSIT = ['deposit.take', 'deposit.return', 'field.deposit_return'];

test('twin run (first shop: count only, no deposit): the sample day, every story command and the closing give the same state in memory and in the shop file', () => {
  const t = twin();
  const { types, commands } = runStory(t);
  assert.ok(commands >= 25, 'the story sends many commands: ' + commands);
  for (const type of STOCK_AND_MONEY) assert.ok(types.has(type), 'the story covers ' + type);
  for (const type of DEPOSIT) assert.equal(types.has(type), false, 'no deposit command in the first shop: ' + type);
  // 수량만: 번호 실물 · 번호 이동 줄이 없고, 리프트권 추가는 차량 예비권(수량)에서 1매.
  assert.deepEqual(t.memory.assets, []);
  assert.deepEqual(t.memory.deposits, []);
  assert.deepEqual(t.memory.vanSpares, [{ vehicleId: 'v1', productKey: 'night_adult', quantity: 5 }]);
  assert.equal(num(one(t.db, 'SELECT count(*) AS n FROM stock_movement_lines WHERE asset_id IS NOT NULL')?.n), 0);
  // 수량 재고: 규격 품목(의류 · 헬멧)의 줄은 규격을 가져 없는 규격('')의 재고를 움직이지 않고, 투영이 이동과 맞는다.
  assertBalancesMatchMovements(t.db, 'first shop story');
  assert.equal(num(one(t.db, "SELECT count(*) AS n FROM stock_movement_lines WHERE variant_id IN ('helmet:', 'clothes:', 'boots:', 'goggles:')")?.n), 0,
    'no movement line uses the empty variant of a sized kind');
  const given = (variant: string) => num(one(t.db, "SELECT sum(ml.quantity) AS n FROM stock_movement_lines ml JOIN stock_movements m ON m.shop_id = ml.shop_id AND m.id = ml.movement_id WHERE m.kind_key = 'deliver' AND ml.variant_id = ?", variant)?.n);
  for (const variant of ['helmet:소', 'helmet:중', 'helmet:대', 'clothes:95', 'clothes:100', 'clothes:105', 'ski:']) assert.ok(given(variant) > 0, variant + ' is handed out by its own variant row');
  // 김민수 팀 헬멧 1개는 매장 입고되지 않아(23:48) 그 규격의 매장 재고가 처음보다 하나 적다.
  const o25helmet = t.memory.orders.find((o) => o.id === 'o25')!.lines.find((l) => l.kind === 'helmet')!;
  const opening = num(one(t.db, "SELECT sum(ml.quantity) AS n FROM stock_movement_lines ml JOIN stock_movements m ON m.shop_id = ml.shop_id AND m.id = ml.movement_id WHERE m.kind_key = 'stock_opening' AND m.to_location_id = 'shop' AND ml.variant_id = ?", 'helmet:' + o25helmet.variantKey)?.n);
  const atShop = num(one(t.db, "SELECT quantity AS n FROM stock_balances WHERE location_id = 'shop' AND variant_id = ?", 'helmet:' + o25helmet.variantKey)?.n);
  assert.ok(atShop < opening, 'the helmet left on the van is missing from the shop count of its size: ' + atShop + ' < ' + opening);
  const closed = closeDay(t, at(0, 40, 1));
  assert.equal(closed?.outcome, 'applied', 'the day closes after the story');
  assert.equal(t.memory.closings.length, 1);
  assert.deepEqual(verifyChain(t.db, 'shop0test'), { rows: t.applied + 1, brokenAt: null }, 'one events row per applied command + the import');
});

test('twin run (numbered shop with the lift-ticket deposit): the sample day, every story command and the closing give the same state in memory and in the shop file', () => {
  const t = twin('numbered');
  const { types, commands } = runStory(t);
  assert.ok(commands >= 30, 'the story sends many commands: ' + commands);
  for (const type of [...STOCK_AND_MONEY, ...DEPOSIT]) assert.ok(types.has(type), 'the story covers ' + type);
  const closed = closeDay(t, at(0, 40, 1));
  assert.equal(closed?.outcome, 'applied', 'the day closes after the story');
  assert.equal(t.memory.closings.length, 1);
  assert.deepEqual(verifyChain(t.db, 'shop0test'), { rows: t.applied + 1, brokenAt: null }, 'one events row per applied command + the import');
  assert.equal(num(one(t.db, "SELECT count(*) AS n FROM events WHERE engine_key = 'import' AND imported = 1")?.n), 1);
});

test('twin run (first shop): turning the lift-ticket deposit on later (V8 사용) creates its section and rule, and deposit take · return on count tickets round-trip', () => {
  const t = twin();
  assert.equal(num(one(t.db, "SELECT count(*) AS n FROM deposit_rules")?.n), 0, 'the first shop is provisioned without a deposit rule');
  assert.equal(num(one(t.db, "SELECT count(*) AS n FROM payment_sections WHERE id = 'lift_deposit'")?.n), 0);
  const keys = ruleKeys(t.memory.registry, t.memory.settings);
  const on = t.run(envelope('setting.set', { changes: [{ key: keys.depositOn, value: 1 }] }, basisOf(t)), at(15, 45), 'deposit on');
  assert.equal(on.outcome, 'applied');
  assert.ok(t.memory.settings.liftDeposit, 'the deposit rule is on');
  assert.equal(num(one(t.db, "SELECT count(*) AS n FROM deposit_rules WHERE active = 1")?.n), 1);
  assert.equal(num(one(t.db, "SELECT count(*) AS n FROM payment_sections WHERE id = 'lift_deposit'")?.n), 1, 'the deposit section is created on the fly');
  const change = one(t.db, "SELECT entity_type, before_json FROM config_changes WHERE entity_type = 'deposit_rules' ORDER BY config_rev DESC LIMIT 1");
  assert.equal(change?.entity_type, 'deposit_rules', 'config_changes records the new rule');
  assert.equal(change?.before_json, null);

  // 새 접수(현장, 권 2매): 확정 창의 보증금 칸이 생기고 접수 확정이 보증금을 받는다(수량 권: 번호 없음).
  const draft: OrderDraftInput = {
    channel: 'walk_in', leader: { name: '한지민', phone: '01000005151', party: 2 },
    items: [{ productKey: 'board', quantity: 1 }, { productKey: 'night_adult', quantity: 2 }], pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' },
  };
  const now = at(15, 50);
  const plan = checkoutPlan(structuredClone(t.memory), now, draft, [{ sectionKey: 'gear', methodKey: 'card' }, { sectionKey: 'lift', methodKey: 'cash' }], null);
  assert.ok(plan.deposit && plan.deposit.amount > 0, 'the checkout plan has a deposit section');
  const created = t.run(envelope('order.create', { draft, choices: plan.choices, payerOrderId: null }, basisOf(t), { expect: { quoteHash: plan.hash } }), now, 'order with deposit');
  assert.equal(created.outcome, 'applied');
  const orderId = (created.result as { orderId: string }).orderId;
  const o = () => t.memory.orders.find((x) => x.id === orderId)!;
  t.run(envelope('stock.issue', { orderId, lines: o().lines.map((l) => ({ lineId: l.id, quantity: l.qty })) }, basisOf(t)), at(15, 51), 'issue');
  const ticket = o().lines.find((l) => l.section === 'lift')!;
  assert.equal(ticket.tracking, 'count');
  const held = t.memory.deposits.find((d) => d.orderId === orderId);
  assert.ok(held && held.entries.some((e) => e.kind === 'take' && !e.assetIds), 'deposit.take on count tickets has no numbers');
  // 권 1매만 돌아옴(부분 반납) + 그 1매의 보증금 반환.
  const back = t.run(envelope('stock.direct_return', { orderId, lines: [{ lineId: ticket.id, quantity: 1 }] }, basisOf(t)), at(21, 40), 'partial return');
  assert.equal(back.outcome, 'applied');
  const dep = t.memory.deposits.find((d) => d.orderId === orderId)!;
  const heldBefore = dep.entries.reduce((n, e) => n + (e.kind === 'take' ? e.amount : -e.amount), 0);
  const refund = t.run(envelope('deposit.return', { orderId, ruleKey: dep.ruleKey, lines: [{ lineId: ticket.id, quantity: 1 }], amount: dep.unitAmount, refundMethodKey: 'cash' }, basisOf(t),
    { expect: { depositHeld: heldBefore, dueAmount: 0 } }), at(21, 41), 'deposit return');
  assert.equal(refund.outcome, 'applied');
  assertBalancesMatchMovements(t.db, 'deposit on later');
  const closed = closeDay(t, at(0, 40, 1));
  assert.equal(closed?.outcome, 'applied', 'the day closes with one deposit still held');
});

test('twin run (first shop): a queued lift-ticket add beyond the recorded van spares is written (sync 8-12), the spare row goes below 0 and the drift is recorded', () => {
  const t = twin();
  const quote = 'ticket:night_adultx7=245000:d0';
  const online = t.run(envelope('field.add_ticket', { taskId: 'deliver:o26', orderId: 'o26', productKey: 'night_adult', quantity: 7, assetIds: [], amount: 245_000 }, basisOf(t),
    { expect: { quoteHash: quote } }), at(16, 58), 'online add beyond spares');
  assert.equal(online.outcome, 'rejected');
  const queuedEnv = { ...envelope('field.add_ticket', { taskId: 'deliver:o26', orderId: 'o26', productKey: 'night_adult', quantity: 7, assetIds: [], amount: 245_000 }, { epoch: t.memory.epoch, rev: 1 },
    { expect: { quoteHash: quote } }), deviceSeq: 1 } as AnyCommandEnvelope;
  assert.equal(t.run(queuedEnv, at(16, 59), 'queued add beyond spares').outcome, 'applied');
  assert.deepEqual(t.memory.vanSpares, [{ vehicleId: 'v1', productKey: 'night_adult', quantity: -1 }], 'the spare row reads back from the facts below 0');
  assert.equal(num(one(t.db, "SELECT count(*) AS n FROM integrity_findings WHERE check_key = 'projection_drift' AND entity_id = 'vehicle:v1|night_adult:'")?.n), 1, 'the van balance was clamped and recorded');
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

test('twin run (first shop): discounts — checkout rule and manual, apply · change · removal later, refunds by card and in cash, then the closing (features-1 §6)', () => {
  const t = twin();
  const sheetRun = (orderId: string, sectionKey: 'gear' | 'lift', choice: DiscountChoice, now: number, name: string, methods?: Record<string, string>): CommandOutcome[] => {
    const view = runQuery(t.memory, 'discountSheet', { orderId, sectionKey, choice, ...(methods ? { methods } : {}) }, t.read(now));
    assert.ok(view.command, name + ': the sheet offers a command');
    const first = envelope(view.command.type, view.command.payload as never, basisOf(t), view.expect ? { expect: view.expect } : {});
    const out = [t.run(first, now, name)];
    let previous = first.requestId;
    for (const step of view.then ?? []) {
      const next = envelope(step.command.type, step.command.payload as never, basisOf(t), { ...(step.expect ? { expect: step.expect } : {}), dependsOn: [previous] });
      out.push(t.run(next, now, name + ' · refund'));
      previous = next.requestId;
    }
    return out;
  };

  // 접수 때: 장비 10%(매장 할인), 리프트권 직접 입력 15%(사유). 줄의 할인 앞 값 · 몫, 값의 구성(기본 + 할인)의 합 = 뺀 값.
  const draft: OrderDraftInput = {
    channel: 'walk_in', leader: { name: '할인손님', phone: '01000007777', party: 2 },
    items: [{ productKey: 'ski', quantity: 2 }, { productKey: 'helmet', variantKey: '중', quantity: 1 }, { productKey: 'night_adult', quantity: 2 }],
    pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' },
  };
  const choices = [
    { sectionKey: 'gear', methodKey: 'card', discountKey: 'ten_percent' },
    { sectionKey: 'lift', methodKey: 'cash', discountKey: 'manual', manual: { kind: 'percent' as const, value: 15, reason: '단체' } },
  ];
  const now = at(15, 45);
  const plan = checkoutPlan(structuredClone(t.memory), now, draft, choices, null);
  const created = t.run(envelope('order.create', { draft, choices, payerOrderId: null }, basisOf(t), { expect: { quoteHash: plan.hash } }), now, 'checkout with discounts');
  assert.equal(created.outcome, 'applied');
  const orderId = (created.result as { orderId: string }).orderId;
  for (const r of all(t.db, 'SELECT l.id, l.net_amount AS net, l.gross_amount AS gross, l.discount_amount AS cut, (SELECT sum(amount) FROM line_price_components c WHERE c.line_id = l.id) AS parts FROM order_lines l WHERE l.order_id = ?', orderId)) {
    assert.equal(num(r.parts), num(r.net), 'components add up to the net amount: ' + str(r.id));
    assert.equal(num(r.gross) - num(r.cut), num(r.net));
  }
  assert.deepEqual(all(t.db, "SELECT kind_key, value_percent_bp, total_amount, reason FROM discount_applications WHERE order_id = ? ORDER BY rowid", orderId)
    .map((r) => [str(r.kind_key), num(r.value_percent_bp), num(r.total_amount), r.reason]), [['percent', 1000, 8_500, null], ['manual_percent', 1500, 10_500, '단체']]);
  assert.ok(one(t.db, "SELECT 1 AS x FROM discount_group_kinds WHERE discount_group_id = 'lift' AND discount_kind_key = 'manual_percent'"), 'the manual kind is ensured for its group');

  // 결제 전(박준호 장비): 10% → 직접 입력 5,000원 → 해제. 적용 행이 앞 행을 대신하고, 조정은 줄마다 한 행.
  assert.deepEqual(sheetRun('o22', 'gear', { ruleKey: 'ten_percent' }, at(16, 0), 'o22 10%').map((x) => x.outcome), ['applied']);
  assert.deepEqual(sheetRun('o22', 'gear', { manual: { kind: 'amount', value: 5_000, reason: '단골' } }, at(16, 1), 'o22 manual').map((x) => x.outcome), ['applied']);
  assert.deepEqual(sheetRun('o22', 'gear', { none: true }, at(16, 2), 'o22 off').map((x) => x.outcome), ['applied']);
  const chain = all(t.db, "SELECT id, supersedes_application_id AS prev, total_amount FROM discount_applications WHERE order_id = 'o22' ORDER BY rowid");
  assert.equal(chain.length, 3);
  assert.equal(chain[1]!.prev, chain[0]!.id);
  assert.equal(chain[2]!.prev, chain[1]!.id);
  assert.equal(num(chain[2]!.total_amount), 0, 'a removal is an application of 0');
  assert.equal(num(one(t.db, "SELECT sum(amount) AS n FROM charge_adjustments WHERE order_id = 'o22' AND adjustment_type_id = 'discount_change'")?.n), 0, 'apply + change + removal net to 0');
  // 리프트권 20%: 선입금이 넘쳐 장비 미수를 채운다(환불 없음).
  assert.deepEqual(sheetRun('o22', 'lift', { ruleKey: 'lift_twenty' }, at(16, 3), 'o22 lift 20%').map((x) => x.outcome), ['applied']);

  // 결제 뒤(김민재 카드 100,000원): 10% → 카드 환불 10,000원(단말기 취소). 이수진(카드): 10% → 현금 환불(돈통에서 나감).
  assert.deepEqual(sheetRun('o21', 'gear', { ruleKey: 'ten_percent' }, at(16, 5), 'o21 10% refund card').map((x) => x.outcome), ['applied', 'applied']);
  const refund = one(t.db, "SELECT kind_key, refund_of_payment_id AS of, method_id, amount, purpose_key, reason FROM payments WHERE kind_key = 'refund' ORDER BY rowid LIMIT 1");
  assert.deepEqual({ ...refund }, { kind_key: 'refund', of: 'o21-p1', method_id: 'card', amount: 10_000, purpose_key: 'charge', reason: '할인 변경' });
  assert.deepEqual(sheetRun('o23', 'gear', { ruleKey: 'ten_percent' }, at(16, 6), 'o23 10% refund cash', { 'o23-p1': 'cash' }).map((x) => x.outcome), ['applied', 'applied']);
  const cash = one(t.db, "SELECT m.amount FROM cash_movements m JOIN payments p ON p.shop_id = m.shop_id AND p.id = m.source_id WHERE p.kind_key = 'refund' AND m.cash_drawer_id = 'counter'");
  assert.ok(cash && num(cash.amount) < 0, 'a cash refund leaves the counter drawer');
  // 다른 팀이 낼 접수(이서연 → 이정호)의 할인.
  assert.deepEqual(sheetRun('o36', 'gear', { ruleKey: 'gear_5000' }, at(16, 7), 'o36 5,000').map((x) => x.outcome), ['applied']);

  const closed = closeDay(t, at(0, 40, 1));
  assert.equal(closed?.outcome, 'applied', 'the day closes with the refund row');
  const frozen = t.memory.closings[0]!.sheet!.methods;
  assert.ok(frozen.some((m) => m.key === 'refund' && m.amount < 0), 'the frozen closing keeps the refund row');
});

test('twin run (first shop): order edit — cancel with refund · apply to due · no refund, van leftovers back to the shop, payer release, add items, then the closing (features-1 §5)', () => {
  const t = twin();
  const cancelRun = (params: CancelSheetParams, now: number, name: string): CommandOutcome[] => {
    const view = runQuery(t.memory, 'cancelSheet', params, t.read(now));
    assert.ok(view.command, name + ': the sheet offers a command ' + (view.notice ?? ''));
    const first = envelope(view.command.type, view.command.payload as never, basisOf(t), view.expect ? { expect: view.expect } : {});
    const out = [t.run(first, now, name)];
    let previous = first.requestId;
    for (const step of view.then ?? []) {
      const next = envelope(step.command.type, step.command.payload as never, basisOf(t), { ...(step.expect ? { expect: step.expect } : {}), dependsOn: [previous] });
      out.push(t.run(next, now, name + ' · refund'));
      previous = next.requestId;
    }
    return out;
  };
  const draftRun = (actionKey: 'stamp.load' | 'receive_to_shop', params: { orderId?: string; vehicleId?: string }, now: number, name: string) => {
    const view = runQuery(t.memory, 'confirmDraft', { actionKey, ...params }, t.read(now));
    assert.ok(view.command, name);
    return t.run(envelope(view.command.type, view.command.payload as never, basisOf(t)), now, name);
  };
  const addRun = (orderId: string, items: DraftItem[], choices: CheckoutChoice[], payer: 'order' | 'self', now: number, name: string) => {
    const draft: OrderDraftInput = { channel: 'walk_in', leader: { name: '', phone: '', party: 0 }, items, pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' } };
    const view = runQuery(t.memory, 'checkoutSheet', { draft, addTo: orderId, choices, payer }, t.read(now));
    assert.ok(view.command, name);
    return t.run(envelope(view.command.type, view.command.payload as never, basisOf(t), { expect: view.expect! }), now, name);
  };

  // 박준호 리프트권만 취소 · 미수 결제: 선입금이 장비 미수로 옮겨진다(payment_reallocations + 음수 · 양수 배분).
  assert.deepEqual(cancelRun({ orderId: 'o22', scope: 'lines', picked: [{ lineId: 'o22-l4', quantity: 3 }], decision: 'apply_to_due' }, at(15, 45), 'o22 lift apply to due')
    .map((x) => x.outcome), ['applied']);
  const moved = all(t.db, "SELECT a.line_id, a.amount, s.payment_section_id AS section FROM payment_allocations a LEFT JOIN payment_allocation_sections s ON s.shop_id = a.shop_id AND s.payment_id = a.payment_id AND s.seq = a.seq WHERE a.reallocation_id IS NOT NULL ORDER BY a.seq");
  assert.deepEqual(moved.map((r) => [r.line_id, num(r.amount), r.section]), [[null, -105_000, 'lift'], [null, 105_000, null]]);
  const head = one(t.db, "SELECT reason, refund_decision_key, total_amount, reason_code_id FROM order_cancellations WHERE order_id = 'o22'");
  assert.deepEqual({ ...head }, { reason: '품목 취소 · 취소 요청', refund_decision_key: 'apply_to_due', total_amount: 105_000, reason_code_id: 'cancellation:request' });
  assert.equal(num(one(t.db, "SELECT qty_cancelled FROM order_lines WHERE id = 'o22-l4'")?.qty_cancelled), 3);

  // 최하은: 적재한 뒤 접수 취소(연락 없음) · 현금 환불 → 차에 남은 6개를 매장 입고(접수가 있는 입고 이동) → 마감.
  assert.equal(draftRun('stamp.load', { orderId: 'o26' }, at(16, 40), 'o26 load').outcome, 'applied');
  const paymentId = t.memory.orders.find((o) => o.id === 'o26')!.payments[0]!.id;
  assert.deepEqual(cancelRun({ orderId: 'o26', scope: 'order', reasonKey: 'no_show', methods: { [paymentId]: 'cash' } }, at(16, 45), 'o26 cancel no show').map((x) => x.outcome), ['applied', 'applied']);
  const refundRow = one(t.db, "SELECT refund_of_payment_id AS of, method_id, amount, reason, purpose_key FROM payments WHERE kind_key = 'refund'");
  assert.deepEqual({ ...refundRow }, { of: paymentId, method_id: 'cash', amount: 135_000, reason: '접수 취소 · 연락 없음', purpose_key: 'charge' });
  assert.equal(str(one(t.db, "SELECT status_key FROM orders WHERE id = 'o26'")?.status_key), 'cancelled');
  assert.equal(draftRun('receive_to_shop', { vehicleId: 'v1' }, at(16, 50), 'o26 leftovers back').outcome, 'applied');
  const leftoverMove = all(t.db, "SELECT m.order_id, sum(ml.quantity) AS n FROM stock_movements m JOIN stock_movement_lines ml ON ml.shop_id = m.shop_id AND ml.movement_id = m.id WHERE m.kind_key = 'receive' AND m.order_id IS NOT NULL GROUP BY m.order_id");
  assert.deepEqual(leftoverMove.map((r) => [r.order_id, num(r.n)]), [['o26', 6]]);

  // 이정호(이서연 팀의 결제 팀) 접수 취소: 돈이 없어 해당 없음, 이서연 팀의 결제 예정이 풀린다.
  assert.deepEqual(cancelRun({ orderId: 'o32', scope: 'order' }, at(16, 55), 'o32 cancel').map((x) => x.outcome), ['applied']);
  assert.equal(t.memory.orders.find((o) => o.id === 'o36')!.payerOrderId, undefined);
  assert.equal(str(one(t.db, "SELECT refund_decision_key FROM order_cancellations WHERE order_id = 'o32'")?.refund_decision_key), 'not_applicable');

  // 최은정 스키 1(반납함)을 품목 취소 · 현금 환불.
  assert.deepEqual(cancelRun({ orderId: 'o24', scope: 'lines', picked: [{ lineId: 'o24-l1', quantity: 1 }] }, at(17, 0), 'o24 cancel returned').map((x) => x.outcome), ['applied', 'applied']);

  // 새 접수(스키 2 · 카드 · 할인 10%) 뒤 스키 1을 환불 없음으로 취소: 할인을 다시 센 적용(조정 없음) + 수납 유지 조정.
  const draft: OrderDraftInput = {
    channel: 'phone', leader: { name: '취소손님', phone: '01000007788', party: 2 }, items: [{ productKey: 'ski', quantity: 2 }],
    pickup: { mode: 'store', day: 'tomorrow', time: '09:00' }, giveBack: { mode: 'store' },
  };
  const choices = [{ sectionKey: 'gear', methodKey: 'card', discountKey: 'ten_percent' }];
  const plan = checkoutPlan(structuredClone(t.memory), at(17, 5), draft, choices, null);
  const created = t.run(envelope('order.create', { draft, choices, payerOrderId: null }, basisOf(t), { expect: { quoteHash: plan.hash } }), at(17, 5), 'checkout to cancel');
  const newId = (created.result as { orderId: string }).orderId;
  assert.deepEqual(cancelRun({ orderId: newId, scope: 'lines', picked: [{ lineId: newId + '-l1', quantity: 1 }], decision: 'no_refund' }, at(17, 10), 'new order no refund').map((x) => x.outcome), ['applied']);
  assert.deepEqual(all(t.db, 'SELECT adjustment_type_id AS type, amount FROM charge_adjustments WHERE order_id = ? ORDER BY rowid', newId).map((r) => [r.type, num(r.amount)]),
    [['cancellation', -36_000], ['cancellation_fee', 36_000]]);
  assert.equal(num(one(t.db, 'SELECT total_amount FROM discount_applications WHERE order_id = ? ORDER BY rowid DESC LIMIT 1', newId)?.total_amount), 4_000);

  // 품목 추가: 김민재 헬멧(현금, 새 차수 `품목 추가`), 이서연 헬멧(후불 · 이 팀).
  assert.equal(addRun('o21', [{ productKey: 'helmet', variantKey: '중', quantity: 1 }], [{ sectionKey: 'gear', methodKey: 'cash' }], 'order', at(17, 20), 'o21 add').outcome, 'applied');
  const batch = one(t.db, "SELECT seq, label, source_key FROM order_batches WHERE order_id = 'o21' ORDER BY seq DESC LIMIT 1");
  assert.deepEqual([num(batch?.seq), batch?.label, batch?.source_key], [2, '품목 추가', 'counter']);
  assert.equal(addRun('o36', [{ productKey: 'helmet', variantKey: '소', quantity: 1 }], [{ sectionKey: 'gear', methodKey: 'later' }], 'self', at(17, 25), 'o36 add').outcome, 'applied');

  const closed = closeDay(t, at(0, 40, 1));
  assert.equal(closed?.outcome, 'applied', 'the day closes with the refund rows');
  const refunds = t.memory.closings[0]!.sheet!.methods.find((m) => m.key === 'refund');
  assert.equal(refunds?.amount, -(135_000 + 40_000));
});

test('twin run (first shop): size exchange — held and planned swaps, later issue · return · collect · receive split by size, replay writes nothing (features-1 §7)', () => {
  const t = twin();
  const swapRun = (params: ExchangeSheetParams, now: number, name: string): CommandOutcome => {
    const view = runQuery(t.memory, 'exchangeSheet', params, t.read(now));
    assert.ok(view.command, name + ': the sheet offers a command ' + (view.notice ?? ''));
    return t.run(envelope(view.command.type, view.command.payload as never, basisOf(t)), now, name);
  };
  const lineOf = (orderId: string, kind: string) => t.memory.orders.find((o) => o.id === orderId)!.lines.find((l) => l.kind === kind)!;
  const movedSizes = (sql: string, ...args: string[]) => all(t.db, `SELECT m.kind_key AS kind, v.code AS size, ml.quantity AS n, m.exchange_id AS ex FROM stock_movement_lines ml
    JOIN stock_movements m ON m.shop_id = ml.shop_id AND m.id = ml.movement_id JOIN item_variants v ON v.shop_id = ml.shop_id AND v.id = ml.variant_id
    WHERE ${sql} ORDER BY m.created_rev, m.rowid, ml.line_no`, ...args).map((r) => [r.kind, r.size, num(r.n), r.ex === null ? null : 'ex']);

  // 김민재 의류(손님에게 있음) 100 → 110: 교환 · 교환 단위 · 이동 두 줄(exchange_id), 줄의 수 셈은 그대로.
  const clothes = lineOf('o21', 'clothes');
  const from = clothes.variantKey!;
  const held = swapRun({ orderId: 'o21', lineId: clothes.id, from, planned: false, to: '110' }, at(15, 45), 'o21 held swap');
  assert.equal(held.outcome, 'applied');
  const ex = one(t.db, 'SELECT id, line_id, catalog_item_id, old_size, new_size, method_key, status_key, created_by, request_id FROM exchanges WHERE order_id = ?', 'o21');
  assert.deepEqual({ ...ex }, {
    id: held.requestId, line_id: clothes.id, catalog_item_id: 'clothes', old_size: '사이즈 ' + from, new_size: '사이즈 110', method_key: 'shop_counter',
    status_key: 'completed', created_by: COUNTER.key, request_id: held.requestId,
  });
  const unit = one(t.db, 'SELECT seq, quantity, old_variant_id, new_variant_id, delivered_at, received_at FROM exchange_units WHERE exchange_id = ?', held.requestId);
  assert.deepEqual([num(unit?.seq), num(unit?.quantity), unit?.old_variant_id, unit?.new_variant_id, unit?.delivered_at !== null, unit?.received_at !== null],
    [1, 1, 'clothes:' + from, 'clothes:110', true, true]);
  assert.deepEqual(movedSizes('m.exchange_id = ?', held.requestId), [['direct_return', from, 1, 'ex'], ['deliver', '110', 1, 'ex']]);
  assert.equal(t.memory.orders.find((o) => o.id === 'o21')!.lines.find((l) => l.id === clothes.id)!.swaps?.[0]?.byName, COUNTER.name);
  // 같은 요청을 다시 보내도(저장소의 요청번호) 행이 늘지 않는다.
  const counts = rowCounts(t.db);
  const again = t.store.command(envelope('exchange.swap', { orderId: 'o21', lineId: clothes.id, quantity: 1, from, to: '110', planned: false }, basisOf(t), { requestId: held.requestId }), COUNTER, at(15, 46));
  assert.equal(again.outcome, 'applied');
  assert.deepEqual(countDiff(counts, rowCounts(t.db)), {});
  // 매장 반납: 지금 사이즈(110)가 돌아온다.
  assert.equal(t.run(envelope('stock.direct_return', { orderId: 'o21', lines: [{ lineId: clothes.id, quantity: 1 }] }, basisOf(t)), at(15, 50), 'o21 return').outcome, 'applied');
  assert.deepEqual(movedSizes("ml.order_line_id = ? AND m.kind_key = 'direct_return' AND m.exchange_id IS NULL", clothes.id), [['direct_return', '110', 1, null]]);

  // 박준호 헬멧(예약, 지급 전) 1개를 다른 사이즈로 → 지급하면 이동 줄이 사이즈마다(바꾼 것이 먼저).
  const helmet = lineOf('o22', 'helmet');
  const was = helmet.variantKey!;
  const to = was === '대' ? '소' : '대';
  assert.equal(swapRun({ orderId: 'o22', lineId: helmet.id, from: was, planned: true, quantity: 1, to }, at(15, 55), 'o22 planned swap').outcome, 'applied');
  assert.equal(num(one(t.db, "SELECT count(*) AS n FROM stock_movements WHERE order_id = 'o22' AND exchange_id IS NOT NULL")?.n), 0, 'a planned swap moves nothing');
  assert.equal(one(t.db, "SELECT delivered_at FROM exchange_units u JOIN exchanges e ON e.shop_id = u.shop_id AND e.id = u.exchange_id WHERE e.order_id = 'o22'")?.delivered_at, null);
  assert.equal(t.run(envelope('stock.issue', { orderId: 'o22', lines: [{ lineId: helmet.id, quantity: 3 }] }, basisOf(t)), at(16, 0), 'o22 issue').outcome, 'applied');
  assert.deepEqual(movedSizes("ml.order_line_id = ? AND m.kind_key = 'deliver'", helmet.id), [['deliver', to, 1, null], ['deliver', was, 2, null]]);

  // 김민수 헬멧 2 중 1 교환 → 22:05 차량 수거 → 매장 입고: 수거 · 입고 이동도 사이즈마다.
  const van = lineOf('o25', 'helmet');
  const vanFrom = van.variantKey!;
  const vanTo = vanFrom === '소' ? '중' : '소';
  assert.equal(swapRun({ orderId: 'o25', lineId: van.id, from: vanFrom, planned: false, quantity: 1, to: vanTo }, at(16, 5), 'o25 held swap').outcome, 'applied');
  assert.equal(t.run(envelope('stock.collect', { taskId: 'collect:o25', lines: [{ lineId: van.id, quantity: 2 }] }, basisOf(t)), at(22, 5), 'o25 collect').outcome, 'applied');
  assert.deepEqual(movedSizes("ml.order_line_id = ? AND m.kind_key = 'collect'", van.id), [['collect', vanTo, 1, null], ['collect', vanFrom, 1, null]]);
  const receive = runQuery(t.memory, 'confirmDraft', { actionKey: 'receive_to_shop', vehicleId: 'v1' }, t.read(at(22, 30)));
  assert.equal(t.run(envelope(receive.command!.type, receive.command!.payload as never, basisOf(t)), at(22, 30), 'receive').outcome, 'applied');
  assert.deepEqual(movedSizes("ml.order_line_id = ? AND m.kind_key = 'receive'", van.id).map((x) => x[1]).sort(), [vanFrom, vanTo].sort());

  // 백승현 헬멧 4 중 1 교환 → 2개 매장 반납: 먼저 나간 자리(바꾼 사이즈)부터.
  const four = lineOf('o35', 'helmet');
  const fourFrom = four.variantKey!;
  const fourTo = fourFrom === '대' ? '중' : '대';
  assert.equal(swapRun({ orderId: 'o35', lineId: four.id, from: fourFrom, planned: false, quantity: 1, to: fourTo }, at(16, 10), 'o35 held swap').outcome, 'applied');
  assert.equal(t.run(envelope('stock.direct_return', { orderId: 'o35', lines: [{ lineId: four.id, quantity: 2 }] }, basisOf(t)), at(16, 15), 'o35 return 2').outcome, 'applied');
  assert.deepEqual(movedSizes("ml.order_line_id = ? AND m.kind_key = 'direct_return' AND m.exchange_id IS NULL", four.id), [['direct_return', fourTo, 1, null], ['direct_return', fourFrom, 1, null]]);

  assertBalancesMatchMovements(t.db, 'size exchange');
  const closed = closeDay(t, at(0, 40, 1));
  assert.equal(closed?.outcome, 'applied', 'the day closes after the exchanges');
});

test('twin run (first shop): lift tickets — write-off · found · queued collect over a write-off · spare load and unload, replay writes nothing (features-1 §8)', () => {
  const t = twin();
  const o22 = () => t.memory.orders.find((o) => o.id === 'o22')!;
  const ticket = () => o22().lines.find((l) => l.section === 'lift')!;
  const sheetRun = <Q extends 'ticketLossSheet' | 'spareSheet'>(name: Q, params: Parameters<typeof runQuery<Q>>[2], now: number, label: string): CommandOutcome => {
    const view = runQuery(t.memory, name, params, t.read(now)) as { command?: { type: string; payload: unknown }; notice?: string };
    assert.ok(view.command, label + ': the sheet offers a command ' + (view.notice ?? ''));
    return t.run(envelope(view.command.type as never, view.command.payload as never, basisOf(t)), now, label);
  };
  const moves = (kind: string) => all(t.db, `SELECT m.kind_key AS kind, m.from_location_id AS f, m.to_location_id AS t, m.order_id AS o, ml.order_line_id AS line, ml.quantity AS n,
    m.reverses_movement_id AS rev FROM stock_movement_lines ml JOIN stock_movements m ON m.shop_id = ml.shop_id AND m.id = ml.movement_id WHERE m.kind_key = ?
    ORDER BY m.created_rev, m.rowid, ml.line_no`, kind).map((r) => ({ f: r.f, t: r.t, o: r.o, line: r.line, n: num(r.n), reverses: r.rev !== null }));

  assert.equal(t.run(envelope('stock.issue', { orderId: 'o22', lines: o22().lines.map((l) => ({ lineId: l.id, quantity: l.qty })) }, basisOf(t)), at(16, 5), 'o22 issue').outcome, 'applied');

  // 예비권 적재 · 입고: 접수 없는 이동, 2호 차량은 새 행, 매장 입고 기록(vanReceipts)은 생기지 않는다.
  assert.equal(sheetRun('spareSheet', { vehicleId: 'v1', direction: 'load', picked: [{ productKey: 'night_adult', quantity: 2 }] }, at(16, 6), 'v1 spare load').outcome, 'applied');
  assert.equal(sheetRun('spareSheet', { vehicleId: 'v2', direction: 'load', picked: [{ productKey: 'morning_adult', quantity: 3 }] }, at(16, 7), 'v2 spare load').outcome, 'applied');
  assert.equal(sheetRun('spareSheet', { vehicleId: 'v2', direction: 'unload', picked: [{ productKey: 'morning_adult', quantity: 1 }] }, at(16, 8), 'v2 spare unload').outcome, 'applied');
  assert.deepEqual(t.memory.vanSpares, [
    { vehicleId: 'v1', productKey: 'night_adult', quantity: 8 }, { vehicleId: 'v2', productKey: 'morning_adult', quantity: 2 },
  ]);
  assert.deepEqual(moves('load').filter((m) => m.o === null), [
    { f: 'shop', t: 'vehicle:v1', o: null, line: null, n: 2, reverses: false }, { f: 'shop', t: 'vehicle:v2', o: null, line: null, n: 3, reverses: false },
  ]);
  assert.deepEqual(moves('receive').filter((m) => m.line === null), [{ f: 'vehicle:v2', t: 'shop', o: null, line: null, n: 1, reverses: false }]);
  assert.deepEqual(t.memory.vanReceipts ?? [], []);

  // 분실 처리 1매: 손님 → 폐기·분실(돈 없음), 투영 qty_not_returned. 같은 요청을 다시 보내도 행이 늘지 않는다.
  const id = ticket().id;
  const lost = sheetRun('ticketLossSheet', { orderId: 'o22', direction: 'loss', picked: [{ lineId: id, quantity: 1 }] }, at(16, 10), 'o22 write-off 1');
  assert.equal(lost.outcome, 'applied');
  assert.deepEqual(moves('write_off'), [{ f: 'cust:o22', t: 'void', o: 'o22', line: id, n: 1, reverses: false }]);
  assert.equal(one(t.db, "SELECT kind_key FROM stock_locations WHERE id = 'void'")?.kind_key, 'void');
  assert.deepEqual([num(one(t.db, 'SELECT qty_not_returned AS n FROM order_lines WHERE id = ?', id)?.n), num(one(t.db, 'SELECT qty_with_customer AS n FROM order_lines WHERE id = ?', id)?.n)], [1, 2]);
  const counts = rowCounts(t.db);
  const again = t.store.command(envelope('stock.write_off', { orderId: 'o22', lines: [{ lineId: id, quantity: 1 }], reasonKey: 'lost' }, basisOf(t), { requestId: lost.requestId }), COUNTER, at(16, 11));
  assert.equal(again.outcome, 'applied');
  assert.deepEqual(countDiff(counts, rowCounts(t.db)), {});

  // 분실 회수 1매(폐기·분실 → 매장) · 다시 1매 분실 처리.
  assert.equal(sheetRun('ticketLossSheet', { orderId: 'o22', direction: 'found' }, at(16, 20), 'o22 found 1').outcome, 'applied');
  assert.deepEqual(moves('found'), [{ f: 'void', t: 'shop', o: 'o22', line: id, n: 1, reverses: false }]);
  assert.equal(sheetRun('ticketLossSheet', { orderId: 'o22', direction: 'loss', picked: [{ lineId: id, quantity: 1 }] }, at(16, 25), 'o22 write-off 1 more').outcome, 'applied');
  assert.deepEqual([ticket().lost, ticket().found], [2, 1]);

  // 보냄 대기로 온 수거 2매(손님에게 1매뿐): 분실 1매를 먼저 되돌리고(폐기·분실 → 손님, 되돌린 분실 처리를 가리킴) 2매 수거.
  const queued = { ...envelope('stock.collect', { taskId: 'collect:o22', lines: [{ lineId: id, quantity: 2 }] }, basisOf(t)), deviceSeq: 1 } as AnyCommandEnvelope;
  assert.equal(t.run(queued, at(22, 40), 'queued collect over the write-off').outcome, 'applied');
  assert.deepEqual([ticket().lost, ticket().collected], [1, 2]);
  assert.deepEqual(moves('reversal'), [{ f: 'void', t: 'cust:o22', o: 'o22', line: id, n: 1, reverses: true }]);

  assertBalancesMatchMovements(t.db, 'lift tickets');
  const closed = closeDay(t, at(0, 40, 1));
  assert.equal(closed?.outcome, 'applied', 'the day closes after the ticket moves');
});

test('twin run (first shop): 확인 필요 — the imported sample item, queued collects over a counter return (already_returned · collect_exceeds with the device and a real task), resolve once', () => {
  const t = twin();
  const reviews = () => all(t.db, `SELECT id, kind_key AS k, source_key AS s, order_id AS o, task_id AS task, device_id AS d, target_device_id AS td, message AS m,
    status_key AS st, resolution_key AS rk, resolved_by AS rb, created_rev AS cr, updated_rev AS ur, version AS v FROM review_items ORDER BY created_rev, rowid`);
  // 가져온 견본 한 건: 출처 import, 기기 · 업무 없음.
  assert.deepEqual(reviews().map((r) => [r.id, r.k, r.s, r.o, r.task, r.d, r.st]), [['review-o24', 'already_returned', 'import', 'o24', null, null, 'open']]);
  assert.equal(reviews()[0]!.m, '최은정 팀 스키 1대 매장 반납 완료 · 기사 수거 기록 제외');
  // 기사 휴대폰(1호 차량) 기기 행: 보냄 대기 명령을 보낸 기기.
  const code = t.store.devices.createCode({ codeHash: 'a'.repeat(64), kind: 'driver_phone', label: '1호 차량 휴대폰', vehicleId: 'v1', expiresAt: at(23, 0), now: at(15, 0) });
  const phone = t.store.devices.enroll({ codeId: code.id, publicKey: '{}', now: at(15, 1) });
  const DRIVER: Actor = { key: 'staff:test-driver', name: '문태오', roleKey: 'driver', deviceId: phone.id, vehicleId: 'v1' };
  const lines = (orderId: string) => t.memory.orders.find((o) => o.id === orderId)!.lines.map((l) => ({ lineId: l.id, quantity: l.qty }));
  // 김민재(o21)는 매장에서 모두 반납 → 기사의 보냄 대기 수거(모두)는 처리 완료 · 줄마다 already_returned.
  assert.equal(t.run(envelope('stock.direct_return', { orderId: 'o21', lines: lines('o21') }, basisOf(t)), at(16, 0), 'o21 counter return').outcome, 'applied');
  const queued = { ...envelope('stock.collect', { taskId: 'collect:o21', lines: lines('o21') }, basisOf(t)), deviceSeq: 1 } as AnyCommandEnvelope;
  const out = t.run(queued, at(16, 35), 'queued collect over the counter return', DRIVER);
  assert.equal(out.outcome, 'superseded');
  const sync = () => reviews().filter((r) => r.s === 'sync');
  assert.deepEqual(sync().map((r) => [r.k, r.o, r.task, r.d, r.td, r.st, r.cr]), [
    ['already_returned', 'o21', 'collect:o21', phone.id, phone.id, 'open', out.rev],
    ['already_returned', 'o21', 'collect:o21', phone.id, phone.id, 'open', out.rev],
  ]);
  assert.deepEqual(sync().map((r) => r.m), ['김민재 팀 스키 2대 매장 반납 완료 · 기사 수거 기록 제외', '김민재 팀 의류 1벌 매장 반납 완료 · 기사 수거 기록 제외']);
  assert.equal(num(one(t.db, "SELECT count(*) AS n FROM tasks WHERE id = 'collect:o21'")?.n), 1, 'the review points at a real task row');
  assert.equal(num(one(t.db, 'SELECT count(*) AS n FROM stock_movements WHERE order_id = ? AND kind_key = ?', 'o21', 'collect')?.n), 0, 'nothing moved');
  const counts = rowCounts(t.db);
  const replay = t.store.command(queued, DRIVER, at(16, 36));
  assert.deepEqual([replay.outcome, replay.rev], ['superseded', out.rev], 'the same request again answers the first result');
  assert.deepEqual(countDiff(counts, rowCounts(t.db)), {});
  // 이수진(o23): 보드 3대라고 적은 수거(대여 중 2대) → collect_exceeds 한 건, 2대만 수거.
  const board = t.memory.orders.find((o) => o.id === 'o23')!.lines[0]!;
  const exceeds = { ...envelope('stock.collect', { taskId: 'collect:o23', lines: [{ lineId: board.id, quantity: 3 }] }, basisOf(t)), deviceSeq: 2 } as AnyCommandEnvelope;
  assert.equal(t.run(exceeds, at(16, 40), 'queued collect beyond what is out', DRIVER).outcome, 'applied');
  assert.deepEqual(sync().filter((r) => r.k === 'collect_exceeds').map((r) => r.m), ['이수진 팀 수거 3대 · 대여 중 2대 · 2대만 반영']);
  // 확인: 한 번만 끝낸다(누가 · 때 · rev), 다른 요청은 `확인 완료`.
  const resolve = envelope('review.resolve', { reviewId: 'review-o24', resolutionKey: 'acknowledged' }, basisOf(t));
  const done = t.run(resolve, at(16, 50), 'resolve the sample item');
  assert.equal(done.outcome, 'applied');
  assert.deepEqual(reviews().filter((r) => r.id === 'review-o24').map((r) => [r.st, r.rk, r.rb, r.ur, r.v]), [['resolved', 'acknowledged', COUNTER.key, done.rev, 2]]);
  assert.deepEqual(t.memory.reviews!.find((r) => r.id === 'review-o24')!.resolution, { key: 'acknowledged', at: at(16, 50), byName: COUNTER.name });
  const second = t.run(envelope('review.resolve', { reviewId: 'review-o24', resolutionKey: 'acknowledged' }, basisOf(t)), at(16, 55), 'resolve again');
  assert.deepEqual([second.outcome, second.error?.message], ['superseded', '확인 완료']);
  const view = runQuery(t.memory, 'reviewList', {}, t.read(at(17, 0)));
  assert.deepEqual([view.count, view.done.map((x) => x.resolvedLine)], [3, ['확인 완료 · 16:50 · ' + COUNTER.name]]);
  assert.deepEqual(verifyChain(t.db, 'shop0test'), { rows: t.applied + 1, brokenAt: null }, 'one events row per written command + the import');
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

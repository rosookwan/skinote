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
import { defaultUiConfig, type AnyCommandEnvelope, type CommandOutcome, type OrderDraftInput, type PromiseSheetParams } from '@skinote/contract';
import {
  PRODUCTION_LINES, checkoutPlan, execute, kstAt, orderTasks, routeTasks, ruleKeys, runQuery, sampleDay, sortTasks, type ReadContext, type SampleShop, type ShopState,
} from '@skinote/domain';
import { STORY } from '../../../apps/pos/src/fixture/story.ts';
import { all, canonicalJson, num, one, str, verifyChain, type Db, type ShopStore } from '../src/index.ts';
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

/** 견본 매장 + 견본 하루(체험 id)를 넣은 쌍둥이. shop: 첫 매장(기본) · 번호 매장. */
function twin(shop: SampleShop = 'first'): Twin {
  const { db, store, reopen } = provisioned(':memory:', {}, shop);
  const empty = store.state(T0);
  const day = sampleDay({ date: DATE, epoch: empty.epoch, ids: 'demo', shop });
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

test('importDay refuses a shop that is not a test shop', () => {
  const { db, store } = provisioned();
  db.exec('UPDATE shops SET is_test = 0');
  const empty = store.state(T0);
  const day = sampleDay({ date: DATE, epoch: empty.epoch, ids: 'demo' });
  assert.throws(() => store.importDay({ date: DATE, orders: day.orders, pins: day.pins, deposits: day.deposits, paymentGroups: day.paymentGroups }, 'import:sample:x', T0, COUNTER),
    (e: unknown) => (e as { code?: string }).code === 'NOT_TEST_SHOP');
  assert.equal(num(one(db, 'SELECT count(*) AS n FROM orders')?.n), 0);
});

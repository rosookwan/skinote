// 들어오는 본문의 검사(plan §5-2): 명령마다 · 조회마다 손으로 쓴 맞는 본문이 통과하고, 바꾼 사본(모르는 칸 · 틀린 형식 · 너무 긴 글 ·
// 너무 긴 목록)은 거절된다. 보냄 대기 칸은 QUEUE_NOT_SUPPORTED, 모르는 명령 · 조회 · 화면은 각자의 코드다.
import { describe, expect, it } from 'vitest';
import {
  COMMAND_TYPES, WIRE_LIMITS, WIRE_QUERY_NAMES, loginMessage, formatEnrollCode, enrollCodeDigits, isEnrollCode, isEnrollMode, isPin, parseAuthBody, parseEnvelope,
  parseQuery, type CommandPayloads, type CommandType, type OrderDraftInput, type QueryName, type QueryParams,
} from '../src/index.ts';

const RID = '01K62M1QG0000000000000000A';
const RID2 = '01K62M1QG0000000000000000B';
const draft: OrderDraftInput = {
  channel: 'walk_in',
  leader: { name: '김민수', phone: '01000001234', party: 2 },
  items: [{ productKey: 'ski', quantity: 2 }, { productKey: 'helmet', variantKey: '중', quantity: 1 }],
  pickup: { mode: 'store', immediate: true },
  giveBack: { mode: 'vehicle', slot: { day: 'tomorrow', slotKey: 'afternoon' }, placeKey: 'dusol', vehicleId: 'v1' },
  returnSet: { time: true },
};
const lines = [{ lineId: 'o21-l1', quantity: 2, assetIds: ['ski-1', 'ski-2'] }, { lineId: 'o21-l2', quantity: 1 }];

/** 명령마다 맞는 본문 하나(형식이 모든 명령을 담았는지 컴파일러가 본다). */
const PAYLOADS: { [T in CommandType]: CommandPayloads[T] } = {
  'stock.issue': { orderId: 'o21', lines },
  'stock.direct_return': { orderId: 'o21', lines },
  'stock.load': { taskId: 'deliver:o5', lines },
  'stock.collect': { taskId: 'collect:o21', lines },
  'stock.receive': { vehicleId: 'v1', taskIds: ['collect:o21', 'collect:o22:01K62M1QG0000000000000000A'], lines },
  'stock.deliver': { taskId: 'deliver:o5', lines },
  'payment.take': {
    orderIds: ['o21', 'o22'], amount: 120_000, methodKey: 'card', purposeKey: 'multi_order', payerOrderId: 'o21',
    allocations: [{ orderId: 'o21', amount: 80_000, lines: [{ lineId: 'o21-l1', quantity: 1, amount: 40_000 }] }, { orderId: 'o22', amount: 40_000 }],
  },
  'payment_promise.set': { orderId: 'o21', payerOrderId: null, lineIds: ['o21-l1'] },
  'promise.change': { orderId: 'o21', kind: 'return', lines: [{ lineId: 'o21-l1', quantity: 1 }], promise: { mode: 'store', slot: { day: '2026-12-28', slotKey: 'night' } } },
  'order.create': { draft: structuredClone(draft), choices: [{ sectionKey: 'gear', methodKey: 'card', discountKey: 'ten_percent' }, { sectionKey: 'lift', methodKey: 'later', payerOrderId: 'o22' }], payerOrderId: null },
  'deposit.take': { orderId: 'o21', ruleKey: 'lift_ticket_card', lines, amount: 10_000, methodKey: 'cash' },
  'deposit.return': { orderId: 'o21', ruleKey: 'lift_ticket_card', lines, amount: 10_000, refundMethodKey: 'offset_due' },
  'field.collect': { taskId: 'collect:o21', orderId: 'o21', amount: 35_000, methodKey: 'cash' },
  'field.add_ticket': { taskId: 'deliver:o5', orderId: 'o5', productKey: 'night_adult', quantity: 1, assetIds: ['night_adult-91'], amount: 35_000, deposit: { ruleKey: 'lift_ticket_card', amount: 5_000 } },
  'field.deposit_return': { taskId: 'collect:o21', orderId: 'o21', ruleKey: 'lift_ticket_card', lines, amount: 5_000 },
  'cash.transfer': { vehicleId: 'v1', amount: 85_000 },
  'cash.transfer_confirm': { transferId: 'van:v1', countedAmount: 84_000, reasonKey: 'manual', reasonNote: '잔돈 교환' },
  'closing.close': { date: '2026-12-26', drawerCounts: [{ drawerId: 'counter', countedAmount: 510_000, expectedAmount: -3_000, reasonKey: 'unknown' }], deferredTransferIds: ['van:v2'], overrideReason: '늦은 반납' },
  'setting.set': { changes: [{ key: 'shops::business_day_cutoff', value: '05:00' }, { key: 'deposit_rules:lift_ticket_card:active', value: 0 }, { key: 'x_y:z:w', value: true }, { key: 'shop_settings:prepayment_mode:amount', value: null }] },
  'route.move': { taskId: 'collect:o21', anchorTaskId: null, position: 'top' },
  'route.reset': { vehicleId: 'v1', date: '2026-12-26' },
  'task.pin': { taskId: 'collect:o21', note: '조기 반납' },
  'task.unpin': { pinId: 'pin-1' },
  'task.visit': { taskId: 'collect:o21', outcomeKey: 'customer_absent', retry: { date: '2026-12-26', at: '2026-12-26T13:30:00.000Z' } },
  'notification.ack': { notificationId: 'pin:pin-1' },
};

const envelope = (type: CommandType, payload: unknown = PAYLOADS[type], extra: Record<string, unknown> = {}) => ({
  type, commandVersion: 1, requestId: RID, basis: { epoch: '01K62M1QG0000000000000000E', rev: 12 }, payload, ...extra,
});

/** 조회마다 맞는 인자 하나. */
const PARAMS: { [Q in QueryName]: QueryParams[Q] } = {
  orderSlip: { orderId: 'o21', deviceClass: 'pos_narrow' },
  findLast4: { last4: '1234', date: '2026-12-26' },
  confirmDraft: { orderId: 'o21', actionKey: 'stamp.issue', lineIds: ['o21-l1'] },
  reviewList: { scope: 'all' },
  vehicleLoad: { vehicleId: 'v1' },
  returnSheet: { orderId: 'o21', lineIds: ['o21-l1'], picked: lines, refundMethodKey: 'cash' },
  promiseSheet: { orderId: 'o21', quantities: { 'o21-l1': 1 }, slot: { day: 'today', slotKey: 'night' }, place: { mode: 'vehicle', placeKey: 'dusol' }, vehicleId: 'v2' },
  orderDraft: { draft: structuredClone(draft), openKindKey: 'helmet', openVariantKey: '중' },
  checkoutSheet: { draft: structuredClone(draft), choices: [{ sectionKey: 'gear', methodKey: 'cash' }], payerOrderId: null, foundPayerIds: ['o22'] },
  groupPaySheet: { orderId: 'o21', tabKey: 'unpaid', selected: ['o21'], parts: [{ orderId: 'o21', lines }], methodKey: 'card', added: ['o30'] },
  partialPaySheet: { orderId: 'o21', payerOrderId: 'o22', lines },
  closingSheet: { date: '2026-12-26', counts: [{ drawerId: 'counter', countedAmount: 1000 }], deferredTransferIds: ['van:v1'], check: { key: 'van:v1', countedAmount: 5000, reasonKey: 'manual', reasonNote: '봉투' } },
  taskSheet: { taskId: 'collect:o21', deviceClass: 'driver_phone' },
  fieldPaySheet: { taskId: 'collect:o21', amount: 35_000, methodKey: 'cash', afterTicket: RID2 },
  addTicketSheet: { taskId: 'deliver:o5', productKey: 'night_adult', quantity: 2 },
  shopRules: { changes: [{ key: 'shop_settings:same_day_cancel_refund_default:decision', value: 'no_refund' }] },
};

describe('명령 봉투', () => {
  it('모든 명령의 맞는 봉투가 통과한다', () => {
    expect(Object.keys(PAYLOADS).sort()).toEqual([...COMMAND_TYPES].sort());
    for (const type of COMMAND_TYPES) {
      const out = parseEnvelope(envelope(type, PAYLOADS[type], { expect: { dueAmount: -5_000, quoteHash: 'quote:ski/어른x2=80000:n1:d0|gear=80000' }, dependsOn: [RID2] }));
      expect(out.ok ? 'ok' : out.problems.join(' / '), type).toBe('ok');
    }
  });

  it('명령마다 모르는 칸 · 틀린 형식 · 빠진 칸이면 BAD_INPUT', () => {
    for (const type of COMMAND_TYPES) {
      const payload = PAYLOADS[type] as Record<string, unknown>;
      const extra = parseEnvelope(envelope(type, { ...payload, sneaky: 1 }));
      expect(extra.ok, type + ' extra key').toBe(false);
      if (!extra.ok) {
        expect(extra.code).toBe('BAD_INPUT');
        expect(extra.problems.join('\n')).toMatch(/payload\.sneaky: 모르는 칸/);
      }
      const first = Object.keys(payload)[0]!;
      const wrong = parseEnvelope(envelope(type, { ...payload, [first]: { nested: true } }));
      expect(wrong.ok, type + ' wrong type').toBe(false);
      const missing = { ...payload };
      delete missing[first];
      expect(parseEnvelope(envelope(type, missing)).ok, type + ' missing').toBe(false);
      expect(parseEnvelope(envelope(type, null)).ok, type + ' null payload').toBe(false);
    }
  });

  it('봉투: 모르는 칸, 판 1이 아님, 요청번호 모양, basis, dependsOn 5개까지', () => {
    const base = envelope('task.unpin');
    const fail = (value: unknown) => {
      const out = parseEnvelope(value);
      return out.ok ? 'ok' : out.code + ' ' + out.problems.join(' / ');
    };
    expect(fail(base)).toBe('ok');
    expect(fail({ ...base, shopId: 's1' })).toMatch(/^BAD_INPUT shopId: 모르는 칸/);
    expect(fail({ ...base, commandVersion: 2 })).toMatch(/commandVersion/);
    expect(fail({ ...base, requestId: 'n19' })).toMatch(/requestId/);
    expect(fail({ ...base, requestId: RID.toLowerCase() })).toMatch(/requestId/);
    expect(fail({ ...base, basis: { epoch: 'E', rev: -1 } })).toMatch(/basis\.rev/);
    expect(fail({ ...base, basis: { epoch: 'E' } })).toMatch(/basis\.rev: 빠진 칸/);
    expect(fail({ ...base, dependsOn: Array(6).fill(RID2) })).toMatch(/dependsOn: 5개까지/);
    expect(fail({ ...base, expect: { dueAmount: 1.5 } })).toMatch(/expect\.dueAmount/);
    expect(fail({ ...base, expect: { mystery: 1 } })).toMatch(/expect\.mystery: 모르는 칸/);
    expect(fail({ ...base, expect: { expectedCash: { 'bad key!': 1 } } })).toMatch(/열쇠 모양/);
    expect(fail([base])).toMatch(/^BAD_INPUT 본문/);
    expect(fail('x')).toMatch(/^BAD_INPUT/);
  });

  it('모르는 명령은 UNKNOWN_COMMAND, 보냄 대기 칸은 QUEUE_NOT_SUPPORTED(다른 문제보다 먼저)', () => {
    const unknown = parseEnvelope({ ...envelope('task.unpin'), type: 'order.delete' });
    expect(unknown.ok ? '' : unknown.code).toBe('UNKNOWN_COMMAND');
    for (const field of ['deviceSeq', 'ageMs', 'clockAnchor', 'recordedBy', 'replay']) {
      const out = parseEnvelope({ ...envelope('task.unpin'), [field]: field === 'recordedBy' ? { staffId: 'a', sessionId: 'b', signature: 'c' } : 1, requestId: 'bad' });
      expect(out.ok ? '' : out.code, field).toBe('QUEUE_NOT_SUPPORTED');
    }
  });

  it('글 길이 · 제어 문자 · 꺾쇠, 돈 범위, 목록 길이, 수량 한도', () => {
    const create = (leader: Record<string, unknown>) => parseEnvelope(envelope('order.create', { ...PAYLOADS['order.create'], draft: { ...draft, leader: { ...draft.leader, ...leader } } }));
    expect(create({ name: '가'.repeat(WIRE_LIMITS.nameMax) }).ok).toBe(true);
    expect(create({ name: '가'.repeat(WIRE_LIMITS.nameMax + 1) }).ok).toBe(false);
    expect(create({ name: '김\n민수' }).ok).toBe(false);
    expect(create({ name: '<b>김</b>' }).ok).toBe(false);
    expect(create({ name: '' }).ok, 'an empty name is the domain\'s call').toBe(true);
    expect(create({ phone: '010-0000-1234' }).ok, 'digits only').toBe(false);
    expect(create({ phone: '0'.repeat(16) }).ok).toBe(false);

    const pin = (note: string) => parseEnvelope(envelope('task.pin', { taskId: 'collect:o21', note })).ok;
    expect(pin('가'.repeat(WIRE_LIMITS.noteMax))).toBe(true);
    expect(pin('가'.repeat(WIRE_LIMITS.noteMax + 1))).toBe(false);

    const pay = (amount: number) => parseEnvelope(envelope('payment.take', { ...PAYLOADS['payment.take'], amount })).ok;
    expect(pay(0)).toBe(true);
    expect(pay(WIRE_LIMITS.money)).toBe(true);
    expect(pay(WIRE_LIMITS.money + 1)).toBe(false);
    expect(pay(-1)).toBe(false);
    expect(pay(1.5)).toBe(false);
    expect(parseEnvelope(envelope('payment.take', { ...PAYLOADS['payment.take'], orderIds: [] })).ok, 'at least one team').toBe(false);
    expect(parseEnvelope(envelope('payment.take', { ...PAYLOADS['payment.take'], orderIds: Array.from({ length: 31 }, (_, i) => 'o' + i) })).ok).toBe(false);

    const many = Array.from({ length: WIRE_LIMITS.lines + 1 }, (_, i) => ({ lineId: 'l' + i, quantity: 1 }));
    expect(parseEnvelope(envelope('stock.issue', { orderId: 'o21', lines: many })).ok).toBe(false);
    const assets = Array.from({ length: WIRE_LIMITS.assetIds + 1 }, (_, i) => 'a' + i);
    expect(parseEnvelope(envelope('stock.issue', { orderId: 'o21', lines: [{ lineId: 'l', quantity: 1, assetIds: assets }] })).ok).toBe(false);
    expect(parseEnvelope(envelope('stock.issue', { orderId: 'o/21', lines })).ok, 'id pattern').toBe(false);
    expect(parseEnvelope(envelope('stock.issue', { orderId: 'o'.repeat(97), lines })).ok, 'id length').toBe(false);

    const qty = (quantity: number, maxQuantity?: number) => parseEnvelope(envelope('stock.issue', { orderId: 'o21', lines: [{ lineId: 'l', quantity }] }), maxQuantity ? { maxQuantity } : {}).ok;
    expect(qty(20, 20)).toBe(true);
    expect(qty(21, 20), 'the shop limit').toBe(false);
    expect(qty(WIRE_LIMITS.quantity)).toBe(true);
    expect(qty(WIRE_LIMITS.quantity + 1)).toBe(false);
  });

  it('문제 글에는 보낸 값이 없다(이름 · 전화가 기록에 남지 않게)', () => {
    const out = parseEnvelope(envelope('order.create', { ...PAYLOADS['order.create'], draft: { ...draft, leader: { name: '비밀이름'.repeat(9), phone: '010-0000-9999', party: -1 } } }));
    expect(out.ok).toBe(false);
    const text = out.ok ? '' : out.problems.join('\n');
    expect(text).toMatch(/payload\.draft\.leader\.name/);
    expect(text).not.toMatch(/비밀이름|9999/);
  });

  it('운영 규칙 바꿈: key 모양과 값의 형식(글 · 정수 · 참거짓 · null)', () => {
    const set = (change: unknown) => parseEnvelope(envelope('setting.set', { changes: [change] })).ok;
    expect(set({ key: 'item_kinds:lift:return_policy_key', value: 'optional' })).toBe(true);
    expect(set({ key: 'item_kinds:리프트:return_policy_key', value: 'optional' })).toBe(true);
    expect(set({ key: 'item_kinds:lift', value: 'optional' })).toBe(false);
    expect(set({ key: 'DROP TABLE x', value: 1 })).toBe(false);
    expect(set({ key: 'shops::business_day_cutoff', value: { h: 5 } })).toBe(false);
    expect(set({ key: 'shops::business_day_cutoff', value: [1] })).toBe(false);
    expect(set({ key: 'shops::business_day_cutoff', value: '가'.repeat(41) })).toBe(false);
  });
});

/** 조회마다 꼭 있어야 하는 칸 하나(없으면 BAD_INPUT). */
const REQUIRED: { [Q in QueryName]: string | null } = {
  orderSlip: 'orderId', findLast4: 'last4', confirmDraft: 'actionKey', reviewList: null, vehicleLoad: 'vehicleId', returnSheet: 'orderId',
  promiseSheet: 'orderId', orderDraft: 'draft', checkoutSheet: 'draft', groupPaySheet: 'orderId', partialPaySheet: 'payerOrderId', closingSheet: null,
  taskSheet: 'taskId', fieldPaySheet: 'taskId', addTicketSheet: 'taskId', shopRules: null,
};

describe('조회', () => {
  it('모든 조회의 맞는 인자가 통과한다(config · ledgerView 포함)', () => {
    expect([...WIRE_QUERY_NAMES].sort()).toEqual(Object.keys(PARAMS).sort());
    for (const name of WIRE_QUERY_NAMES) {
      const out = parseQuery({ name, params: PARAMS[name] });
      expect(out.ok ? 'ok' : out.problems.join(' / '), name).toBe('ok');
    }
    expect(parseQuery({ name: 'config' })).toEqual({ ok: true, query: { name: 'config' } });
    expect(parseQuery({ name: 'config', params: {} }).ok).toBe(true);
    expect(parseQuery({ name: 'reviewList' }).ok, 'params may be left out when none is required').toBe(true);
    expect(parseQuery({ name: 'ledgerView', params: { viewKey: 'collection_list', vehicleId: 'v1', tabKey: 'all', deviceClass: 'driver_tablet' } }))
      .toEqual({ ok: true, query: { name: 'ledgerView', viewKey: 'collection_list', params: { vehicleId: 'v1', tabKey: 'all', deviceClass: 'driver_tablet' } } });
  });

  it('조회마다 모르는 칸 · 빠진 칸이면 BAD_INPUT', () => {
    for (const name of WIRE_QUERY_NAMES) {
      const params = PARAMS[name] as Record<string, unknown>;
      const out = parseQuery({ name, params: { ...params, extra: 1 } });
      expect(out.ok ? '' : out.code, name).toBe('BAD_INPUT');
      const required = REQUIRED[name];
      if (!required) continue;
      const missing = { ...params };
      delete missing[required];
      expect(parseQuery({ name, params: missing }).ok, name + ' without ' + required).toBe(false);
    }
  });

  it('모르는 조회 · 화면, 본문 모양', () => {
    const code = (value: unknown) => {
      const out = parseQuery(value);
      return out.ok ? 'ok' : out.code;
    };
    expect(code({ name: 'dropEverything', params: {} })).toBe('UNKNOWN_QUERY');
    expect(code({ name: 'ledgerView', params: { viewKey: 'secret_view' } })).toBe('UNKNOWN_VIEW');
    expect(code({ name: 'ledgerView', params: {} })).toBe('BAD_INPUT');
    expect(code({ name: 'config', params: { x: 1 } })).toBe('BAD_INPUT');
    expect(code({ name: 'orderSlip', params: { orderId: 'o21' }, extra: true })).toBe('BAD_INPUT');
    expect(code({ name: 'findLast4', params: { last4: '12a4' } })).toBe('BAD_INPUT');
    expect(code(null)).toBe('BAD_INPUT');
  });
});

describe('기기 등록 · 로그인 본문', () => {
  const jwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43), ext: true, key_ops: ['verify'] };
  it('맞는 본문', () => {
    expect(parseAuthBody('enroll', { code: '123456789012', publicKey: jwk, agent: 'Windows · Chrome' }).ok).toBe(true);
    expect(parseAuthBody('challenge', { deviceId: RID }).ok).toBe(true);
    expect(parseAuthBody('staff', { deviceId: RID, nonce: 'n'.repeat(43), signature: 's'.repeat(86) }).ok).toBe(true);
    expect(parseAuthBody('login', { ticket: 't'.repeat(43), staffId: RID2, pin: '4821' }).ok).toBe(true);
    expect(parseAuthBody('login', { ticket: 't'.repeat(43), staffId: RID2, pin: '482190' }).ok).toBe(true);
  });
  it('틀린 본문(비밀 열쇠가 든 JWK, 숫자가 아닌 번호, 짧은 비밀번호, 모르는 칸)', () => {
    expect(parseAuthBody('enroll', { code: '1234-5678-9012', publicKey: jwk, agent: 'x' }).ok).toBe(false);
    expect(parseAuthBody('enroll', { code: '123456789012', publicKey: { ...jwk, d: 'secret' }, agent: 'x' }).ok).toBe(false);
    expect(parseAuthBody('enroll', { code: '123456789012', publicKey: { ...jwk, crv: 'P-384' }, agent: 'x' }).ok).toBe(false);
    expect(parseAuthBody('enroll', { code: '123456789012', publicKey: jwk, agent: 'x'.repeat(81) }).ok).toBe(false);
    expect(parseAuthBody('login', { ticket: 't'.repeat(43), staffId: RID2, pin: '482' }).ok).toBe(false);
    expect(parseAuthBody('login', { ticket: 't'.repeat(43), staffId: RID2, pin: '1234567' }).ok).toBe(false);
    expect(parseAuthBody('login', { ticket: 't'.repeat(43), staffId: RID2, pin: '4821', remember: true }).ok).toBe(false);
    const bad = parseAuthBody('login', { ticket: 't'.repeat(43), staffId: RID2, pin: '48x1' });
    expect(bad.ok ? '' : bad.problems.join(' ')).not.toContain('48x1');
  });
  it('열린 등록(시험 매장): 카운터는 차량 없이, 기사 기기는 차량과 함께만', () => {
    const agent = 'Android · Chrome';
    expect(parseAuthBody('openEnroll', { kind: 'pos', publicKey: jwk, agent }).ok).toBe(true);
    expect(parseAuthBody('openEnroll', { kind: 'driver_phone', vehicleId: 'v1', publicKey: jwk, agent }).ok).toBe(true);
    expect(parseAuthBody('openEnroll', { kind: 'driver_tablet', vehicleId: 'v2', publicKey: jwk, agent }).ok).toBe(true);
    expect(parseAuthBody('openEnroll', { kind: 'driver_phone', publicKey: jwk, agent }).ok).toBe(false);
    expect(parseAuthBody('openEnroll', { kind: 'pos', vehicleId: 'v1', publicKey: jwk, agent }).ok).toBe(false);
    expect(parseAuthBody('openEnroll', { kind: 'admin', publicKey: jwk, agent }).ok).toBe(false);
    expect(parseAuthBody('openEnroll', { kind: 'driver_phone', vehicleId: '../v1', publicKey: jwk, agent }).ok).toBe(false);
    expect(parseAuthBody('openEnroll', { kind: 'pos', publicKey: { ...jwk, d: 'secret' }, agent }).ok).toBe(false);
    expect(parseAuthBody('openEnroll', { kind: 'pos', publicKey: jwk, agent, label: '카운터 1' }).ok).toBe(false);
    expect(parseAuthBody('openEnroll', { kind: 'pos', publicKey: jwk, agent: 'x'.repeat(81) }).ok).toBe(false);
  });
  it('열린 등록 기기 놓기는 staff와 같은 서명 본문만', () => {
    const body = { deviceId: RID, nonce: 'n'.repeat(43), signature: 's'.repeat(86) };
    expect(parseAuthBody('openRelease', body).ok).toBe(true);
    expect(parseAuthBody('openRelease', { ...body, kind: 'pos' }).ok).toBe(false);
    expect(parseAuthBody('openRelease', { deviceId: RID, nonce: 'n'.repeat(43) }).ok).toBe(false);
  });
  it('등록 방법 답의 모양(번호 · 열린 등록과 차량), 다른 것은 아님', () => {
    expect(isEnrollMode({ mode: 'code' })).toBe(true);
    expect(isEnrollMode({ mode: 'open', vehicles: [{ id: 'v1', name: '1호 차량' }] })).toBe(true);
    expect(isEnrollMode({ mode: 'open', vehicles: [] })).toBe(true);
    expect(isEnrollMode({ mode: 'open' })).toBe(false);
    expect(isEnrollMode({ mode: 'open', vehicles: [{ id: 'v1' }] })).toBe(false);
    expect(isEnrollMode({ ok: false, error: 'method_not_allowed' })).toBe(false);
    expect(isEnrollMode(null)).toBe(false);
  });
  it('서명 문장 · 등록 번호 모양 · 비밀번호 모양', () => {
    expect(loginMessage('https://shop.example', RID, 'abc')).toBe('skinote-login-v1|https://shop.example|' + RID + '|abc');
    expect(formatEnrollCode('123456789012')).toBe('1234-5678-9012');
    expect(enrollCodeDigits('1234-5678 9012')).toBe('123456789012');
    expect(isEnrollCode('12345678901')).toBe(false);
    expect(isPin('0000')).toBe(true);
    expect(isPin('00000000')).toBe(false);
  });
});

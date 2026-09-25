import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_KEYS, DomainError, GROUP_PAY_TABS, MONEY_COMMANDS, chainDrafts, changedOrders, createdOrder, domainErrorCode, draftToEnvelope, envelopeFor, hasRequiredExpect,
  isAccepted, isRequestId, newRequestId, openCommandDraft, reusableDraft, statusTerm, uiDefaults, type CommandOutcome, type ConfirmCommand,
} from '../src/index.ts';

describe('요청번호(ULID)', () => {
  it('26자 Crockford base32, 앞 10자는 시각', () => {
    const id = newRequestId(Date.UTC(2026, 11, 26, 6, 40), () => new Uint8Array(10));
    expect(id).toHaveLength(26);
    expect(isRequestId(id)).toBe(true);
    expect(id.slice(10)).toBe('0000000000000000');
    const later = newRequestId(Date.UTC(2026, 11, 26, 6, 41), () => new Uint8Array(10));
    expect(later > id).toBe(true);
  });

  it('무작위 부분이 달라진다', () => {
    const a = newRequestId(1_000);
    const b = newRequestId(1_000);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(a).not.toBe(b);
  });
});

describe('확인 창 초안', () => {
  it('창이 열릴 때 요청번호와 basis를 고정하고, 확정 때 그대로 봉투에 싣는다', () => {
    const basis = { epoch: 'E1', rev: 48213 };
    const draft = openCommandDraft({ type: 'stock.collect', payload: { taskId: 't1', lines: [{ lineId: 'l1', quantity: 4 }] } }, basis, { now: Date.UTC(2026, 11, 26, 12, 42) });
    basis.rev = 48300; // 창이 열린 동안 새 rev가 와도
    expect(draft.basis.rev).toBe(48213);
    const envelope = draftToEnvelope(draft, { deviceSeq: 12, ageMs: 5_000, clockAnchor: 'boot-1' }, { type: 'stock.collect', payload: { taskId: 't1', lines: [{ lineId: 'l1', quantity: 3 }] } });
    expect(envelope.requestId).toBe(draft.requestId);
    expect(envelope.basis).toEqual({ epoch: 'E1', rev: 48213 });
    if (envelope.type !== 'stock.collect') throw new Error('종류가 바뀌었다');
    // type으로 가르면 본문의 모양이 정해진다(형 변환 없이 lines를 읽는다).
    expect(envelope.payload.lines[0]?.quantity).toBe(3);
    expect(envelope.deviceSeq).toBe(12);
    expect(draft.openedAt).toBe('2026-12-26T12:42:00.000Z');
  });

  it('돈 명령의 expect는 창을 연 때 초안에 들어가 봉투까지 간다', () => {
    const draft = openCommandDraft(
      { type: 'payment.take', payload: { orderIds: ['o1'], amount: 120_000, methodKey: 'card' } },
      { epoch: 'E1', rev: 7 },
      { expect: { dueAmount: 120_000 }, dependsOn: ['r0'] },
    );
    const envelope = draftToEnvelope(draft, {}, { type: 'payment.take', payload: { orderIds: ['o1'], amount: 120_000, methodKey: 'cash' } });
    expect(envelope.expect).toEqual({ dueAmount: 120_000 });
    expect(envelope.dependsOn).toEqual(['r0']);
    expect(envelope.requestId).toBe(draft.requestId);
  });

  it('초안과 다른 종류의 본문은 보내지 않는다', () => {
    const draft = openCommandDraft({ type: 'stock.issue', payload: { orderId: 'o1', lines: [] } }, { epoch: 'E', rev: 1 });
    expect(() => draftToEnvelope(draft, {}, { type: 'payment.take', payload: { orderIds: ['o1'], amount: 1, methodKey: 'card' } })).toThrow('초안과 다른 명령');
  });

  it('종류와 본문이 어긋난 명령은 형식에서 막힌다', () => {
    // @ts-expect-error 지급 명령에 수납 본문
    const wrong: ConfirmCommand = { type: 'stock.issue', payload: { orderIds: ['o1'], amount: 1000, methodKey: 'cash' } };
    expect(wrong.type).toBe('stock.issue');
  });

  it('저장된 초안은 보내기 전 · 같은 basis일 때만 다시 쓴다(보낸 초안의 번호를 새 창에 쓰지 않는다)', () => {
    const basis = { epoch: 'E1', rev: 5 };
    const draft = openCommandDraft({ type: 'stock.issue', payload: { orderId: 'o1', lines: [{ lineId: 'l1', quantity: 1 }] } }, basis);
    expect(reusableDraft(draft, 'stock.issue', basis)).toBe(draft);
    expect(reusableDraft(draft, 'stock.issue', { epoch: 'E1', rev: 6 })).toBeNull();
    expect(reusableDraft(draft, 'stock.direct_return', basis)).toBeNull();
    expect(reusableDraft({ ...draft, sentAt: '2026-12-26T06:41:00.000Z' }, 'stock.issue', basis)).toBeNull();
    expect(reusableDraft(null, 'stock.issue', basis)).toBeNull();
  });
});

describe('보낼 봉투 · 이어진 명령 · 받아들임(화면들이 같이 쓰는 도우미)', () => {
  const basis = { epoch: 'e1', rev: 7 };
  const take: ConfirmCommand = { type: 'payment.take', payload: { orderIds: ['o1'], amount: 1_000, methodKey: 'card' } };

  it('envelopeFor: 연 때의 초안(요청번호 · basis)에 지금 명령 본문과 바탕, 명령이 없거나 종류가 다르면 null', () => {
    const draft = openCommandDraft(take, basis, { expect: { dueAmount: 1_000 } });
    const now: ConfirmCommand = { type: 'payment.take', payload: { orderIds: ['o1'], amount: 2_000, methodKey: 'cash' } };
    expect(envelopeFor(draft, now)).toMatchObject({ requestId: draft.requestId, basis, payload: now.payload, expect: { dueAmount: 1_000 } });
    expect(envelopeFor(draft, now, { dueAmount: 2_000 })?.expect).toEqual({ dueAmount: 2_000 });
    expect(envelopeFor(draft, undefined)).toBeNull();
    expect(envelopeFor(draft, { type: 'stock.issue', payload: { orderId: 'o1', lines: [] } })).toBeNull();
  });

  it('chainDrafts: 명령마다 새 요청번호, 앞 명령에 dependsOn, basis는 첫 명령', () => {
    const first = openCommandDraft({ type: 'stock.issue', payload: { orderId: 'o1', lines: [] } }, basis);
    const [deposit] = chainDrafts(first, [{ command: { type: 'deposit.take', payload: { orderId: 'o1', ruleKey: 'r', lines: [], amount: 5_000, methodKey: 'cash' } }, expect: { depositHeld: 0 } }]);
    expect(deposit).toMatchObject({ type: 'deposit.take', basis, dependsOn: [first.requestId], expect: { depositHeld: 0 } });
    expect(deposit!.requestId).not.toBe(first.requestId);
  });

  it('isAccepted: 적용 · 일부 적용 · 보냄 대기만', () => {
    expect((['applied', 'partially_applied', 'queued', 'superseded', 'conflict', 'rejected', 'blocked'] as const).map((outcome) => isAccepted({ outcome })))
      .toEqual([true, true, true, false, false, false, false]);
  });
});

describe('실패의 약속', () => {
  it('DomainError는 코드로 가르고, 모르는 실패는 연결 문제로 본다', () => {
    expect(domainErrorCode(new DomainError('NOT_FOUND', '없는 접수'))).toBe('NOT_FOUND');
    expect(domainErrorCode(new Error('fetch failed'))).toBe('NETWORK');
    expect(MONEY_COMMANDS.has('payment.take')).toBe(true);
  });

  it('돈 명령은 종류마다 정해진 바탕(expect)이 있어야 한다', () => {
    expect([...MONEY_COMMANDS].sort()).toEqual([
      'cash.transfer_confirm', 'closing.close', 'deposit.return', 'deposit.take', 'field.add_ticket', 'field.collect', 'field.deposit_return',
      'order.create', 'payment.take',
    ]);
    expect(hasRequiredExpect('payment.take', { dueAmount: 120_000 })).toBe(true);
    expect(hasRequiredExpect('payment.take', {})).toBe(false);
    expect(hasRequiredExpect('deposit.return', { dueAmount: 10_000 })).toBe(false);
    expect(hasRequiredExpect('deposit.return', { depositHeld: 15_000 })).toBe(true);
    expect(hasRequiredExpect('stock.collect', undefined)).toBe(true);
  });
});

describe('새 접수 확정(order.create)의 결과', () => {
  it('적용된 결과의 새 접수(id · 접수 번호)만 읽고, 모양이 틀리거나 적용되지 않았으면 null', () => {
    const base: CommandOutcome = { outcome: 'applied', requestId: 'r', rev: 2, asOfRev: 1, epoch: 'E', rebased: false, changes: [] };
    expect(createdOrder({ ...base, result: { orderId: 'n19', receiptNo: '261226-019' } })).toEqual({ orderId: 'n19', receiptNo: '261226-019' });
    expect(createdOrder({ ...base, result: { orderId: 19 } })).toBeNull();
    expect(createdOrder(base)).toBeNull();
    expect(createdOrder({ ...base, outcome: 'conflict', result: { orderId: 'n19', receiptNo: '261226-019' } })).toBeNull();
    expect(CHECKOUT_KEYS).toEqual({ later: 'later', other: 'other', otherTeam: 'other_team', noDiscount: 'none', self: 'self' });
    expect(hasRequiredExpect('order.create', {})).toBe(false);
    expect(hasRequiredExpect('order.create', { quoteHash: 'quote:x' })).toBe(true);
  });
});

describe('일괄 수납(payment.take + 결제 팀)의 충돌', () => {
  it('충돌의 error.current.orderIds(그사이 받을 금액이 바뀐 팀)만 읽고, 충돌이 아니거나 모양이 틀리면 빈 목록', () => {
    const base: CommandOutcome = { outcome: 'conflict', requestId: 'r', rev: 2, asOfRev: 1, epoch: 'E', rebased: false, changes: [] };
    const error = (current: unknown) => ({ code: 'DUE_CHANGED', message: '강지은 팀 45,000원 수납 완료 · 다른 카운터', current });
    expect(changedOrders({ ...base, error: error({ orderIds: ['n20'] }) })).toEqual(['n20']);
    expect(changedOrders({ ...base, error: error({ orderIds: ['n20', 7] }) })).toEqual(['n20']);
    expect(changedOrders({ ...base, error: error('n20') })).toEqual([]);
    expect(changedOrders(base)).toEqual([]);
    expect(changedOrders({ ...base, outcome: 'applied', error: error({ orderIds: ['n20'] }) })).toEqual([]);
    expect(GROUP_PAY_TABS).toEqual({ group: 'group', unpaid: 'unpaid' });
    expect(hasRequiredExpect('payment.take', { dueByOrder: { o32: 90_000 } })).toBe(false);
    expect(hasRequiredExpect('payment.take', { dueAmount: 485_000, dueByOrder: { o32: 90_000 } })).toBe(true);
  });
});

describe('상태 문구', () => {
  it('매장 문구 → 기본 문구 → 모르는 키는 —', () => {
    expect(statusTerm(uiDefaults.status_terms, 'stamp', 'done')).toEqual({ label: '완료', tone: 'seal', rank: 90 });
    expect(statusTerm([], 'order', 'awaiting_load').label).toBe('차량 적재 대기');
    expect(statusTerm([], 'order', 'from_the_future').label).toBe('—');
  });
});

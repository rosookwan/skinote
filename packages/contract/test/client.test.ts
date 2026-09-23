import { describe, expect, it } from 'vitest';
import {
  DomainError, MONEY_COMMANDS, domainErrorCode, draftToEnvelope, isRequestId, newRequestId, openCommandDraft, reusableDraft, statusTerm, uiDefaults,
  type ConfirmCommand,
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

describe('실패의 약속', () => {
  it('DomainError는 코드로 가르고, 모르는 실패는 연결 문제로 본다', () => {
    expect(domainErrorCode(new DomainError('NOT_FOUND', '없는 접수'))).toBe('NOT_FOUND');
    expect(domainErrorCode(new Error('fetch failed'))).toBe('NETWORK');
    expect(MONEY_COMMANDS.has('payment.take')).toBe(true);
  });
});

describe('상태 문구', () => {
  it('매장 문구 → 기본 문구 → 모르는 키는 —', () => {
    expect(statusTerm(uiDefaults.status_terms, 'stamp', 'done')).toEqual({ label: '끝', tone: 'seal', rank: 90 });
    expect(statusTerm([], 'order', 'awaiting_load').label).toBe('차량 적재 대기');
    expect(statusTerm([], 'order', 'from_the_future').label).toBe('—');
  });
});

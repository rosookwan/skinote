// 확인 필요(features-1 plan §9-5): 보냄 대기로 온 수거가 이미 매장에 반납된 것(already_returned) · 남은 것보다 많은 것(collect_exceeds)을 한 번만 적는지,
// 온라인 수거는 적지 않는지, `확인`(review.resolve)이 한 번만 끝내고 다른 사람에게는 `확인 완료`인지, 지금 상태에서 센 것(초과 수납 · 차량 예비권 기록
// 부족)이 고치면 사라지는지, 메뉴의 수 · 알림 나눔, 취소 뒤에 온 기사 기록(task_cancelled), 초과 수납의 환불 창, 마감의 막는 단계를 본다.
import {
  defaultUiConfig, draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type CancelSheetParams, type ConfirmCommand, type Expect, type UiConfig,
} from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import {
  applyCommand, conflictKeys, execute, findOrder, kstAt, overpaid, PRODUCTION_LINES, runQuery, type ShopState,
} from '../src/index.ts';
import { sampleDay } from '../src/sample/index.ts';
import { assertMoney, assertMoneyViews } from './money-check.ts';

const at = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const NOW = at(15, 40);
const config: UiConfig = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
const first = (): ShopState => sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
const ctx = (now = NOW, viewer?: { roleKey: string; permissions: string[] }) => ({ config, now, ...(viewer ? { viewer } : {}) });

let seq = 0;
const rid = () => '01K62M2QG00000000000009' + String(++seq).padStart(3, '0');
function envelopeOf(state: ShopState, command: ConfirmCommand, extra: { expect?: Expect; dependsOn?: string[]; deviceSeq?: number } = {}): AnyCommandEnvelope {
  const draft = openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, {
    requestId: rid(), ...(extra.expect ? { expect: extra.expect } : {}), ...(extra.dependsOn ? { dependsOn: extra.dependsOn } : {}),
  });
  return draftToEnvelope(draft, extra.deviceSeq !== undefined ? { deviceSeq: extra.deviceSeq } : {});
}
const send = (s: ShopState, command: ConfirmCommand, now = NOW, extra: Parameters<typeof envelopeOf>[2] = {}) => applyCommand(s, envelopeOf(s, command, extra), now);
const list = (s: ShopState, now = NOW) => runQuery(s, 'reviewList', {}, ctx(now));
const stored = (s: ShopState) => s.reviews ?? [];
const lineIds = (s: ShopState, orderId: string) => findOrder(s, orderId)!.lines.map((l) => ({ lineId: l.id, quantity: l.qty }));

/** 박준호 팀(o22): 16:05 수령 · 지급(스키 2 · 보드 1 · 헬멧 3 · 야간권 3매, 반납 22:00 · 1호 차량). */
function issued(s = first()): ShopState {
  expect(send(s, { type: 'stock.issue', payload: { orderId: 'o22', lines: lineIds(s, 'o22') } }, at(16, 5)).outcome).toBe('applied');
  return s;
}

describe('견본 확인 필요 · 목록', () => {
  it('15:40: 견본 한 건(최은정 팀 스키 1대, 가져오기 몫), 메뉴의 수 1, 탭 · 버튼 `확인` · `접수증`, 알림은 따로', () => {
    const s = first();
    const view = list(s);
    expect(view.title).toBe('확인 필요');
    expect(view.tabs).toEqual([{ key: 'open', label: '미처리', count: 1 }, { key: 'done', label: '처리 완료' }]);
    expect(view.count).toBe(1);
    expect(view.empty).toEqual({ open: '미처리 없음', done: '처리 완료 없음' });
    expect(view.items).toEqual([{
      id: 'review-o24', kindKey: 'already_returned', message: '최은정 팀 스키 1대 매장 반납 완료 · 기사 수거 기록 제외',
      parts: [{ text: '최은정 팀 스키 1대 매장 반납 완료', drop: 0 }, { text: '기사 수거 기록 제외', drop: 1 }], severity: 'info', createdAt: '2026-12-26T03:05:00.000Z',
      orderId: 'o24', source: 'stored', status: 'open',
      choices: [
        { key: 'resolve', label: '확인', enabled: true, command: { type: 'review.resolve', payload: { reviewId: 'review-o24', resolutionKey: 'acknowledged' } } },
        { key: 'slip', label: '접수증', enabled: true, orderId: 'o24' },
      ],
    }]);
    expect(view.done).toEqual([]);
    expect(stored(s)[0]).toMatchObject({ source: 'import', status: 'open' });
    expect(stored(s)[0]!.targetDeviceId).toBeUndefined();
    // 23:30: 늦은 반납 · 방문 결과는 알림(머리줄 종)이고 목록 · 수에 들지 않는다.
    const night = list(s, at(23, 30));
    expect(night.notices.some((x) => x.kindKey === 'late_return' && x.source === 'notice')).toBe(true);
    expect(night.items.some((x) => x.kindKey === 'late_return')).toBe(false);
  });

  it('`확인` 권한이 없는 사람: 버튼이 흐리고 까닭 `권한 없음 · 관리자 확인 필요`', () => {
    const view = runQuery(first(), 'reviewList', {}, ctx(NOW, { roleKey: 'driver', permissions: ['stock.move'] }));
    expect(view.items[0]!.choices![0]).toMatchObject({ key: 'resolve', enabled: false, reason: '권한 없음 · 관리자 확인 필요' });
  });
});

describe('보냄 대기로 온 수거(stock.collect, deviceSeq)의 확인 필요(E18)', () => {
  it('그사이 매장에서 모두 반납: 줄마다 `already_returned` 한 건씩, 결과는 처리 완료(움직임 없음), 같은 요청번호를 다시 보내도 한 번', () => {
    const s = first();
    expect(send(s, { type: 'stock.direct_return', payload: { orderId: 'o21', lines: lineIds(s, 'o21') } }, at(16, 0)).outcome).toBe('applied');
    const rev = s.rev;
    const collect = envelopeOf(s, { type: 'stock.collect', payload: { taskId: 'collect:o21', lines: lineIds(s, 'o21') } }, { deviceSeq: 3 });
    const outcome = applyCommand(s, collect, at(16, 35));
    expect(outcome.outcome).toBe('superseded');
    expect(s.rev, 'the stored review is a change').toBe(rev + 1);
    expect(findOrder(s, 'o21')!.lines.map((l) => l.collected)).toEqual([0, 0]);
    expect(stored(s).filter((r) => r.source === 'sync').map((r) => [r.kindKey, r.message, r.taskId, r.orderId])).toEqual([
      ['already_returned', '김민재 팀 스키 2대 매장 반납 완료 · 기사 수거 기록 제외', 'collect:o21', 'o21'],
      ['already_returned', '김민재 팀 의류 1벌 매장 반납 완료 · 기사 수거 기록 제외', 'collect:o21', 'o21'],
    ]);
    expect(stored(s).find((r) => r.source === 'sync')!.params).toEqual({ team: '김민재', item: '스키', qty: 2, unit: '대' });
    expect(applyCommand(s, collect, at(16, 36))).toEqual(outcome);
    expect(stored(s).filter((r) => r.source === 'sync')).toHaveLength(2);
    expect(list(s, at(16, 40)).count).toBe(3);
    assertMoney(s);
  });

  it('권 1매를 매장에서 받은 뒤 온 수거(3매): 2매는 적고 1매는 `야간권 1매` 확인 필요, 결과는 적용', () => {
    const s = issued();
    const ticket = findOrder(s, 'o22')!.lines.find((l) => l.section === 'lift')!;
    expect(send(s, { type: 'stock.direct_return', payload: { orderId: 'o22', lines: [{ lineId: ticket.id, quantity: 1 }] } }, at(21, 0)).outcome).toBe('applied');
    const out = send(s, { type: 'stock.collect', payload: { taskId: 'collect:o22', lines: lineIds(s, 'o22') } }, at(22, 10), { deviceSeq: 5 });
    expect(out.outcome).toBe('applied');
    expect(ticket.collected).toBe(2);
    expect(stored(s).filter((r) => r.source === 'sync').map((r) => r.message)).toEqual(['박준호 팀 야간권 1매 매장 반납 완료 · 기사 수거 기록 제외']);
    assertMoney(s);
    assertMoneyViews(s, 'o22', at(22, 10));
  });

  it('남은 것보다 많이(매장 반납도 아님): 팀에 한 건 `collect_exceeds`, 남은 것만 적음', () => {
    const s = first();
    const ski = findOrder(s, 'o21')!.lines[0]!;
    const out = send(s, { type: 'stock.collect', payload: { taskId: 'collect:o21', lines: [{ lineId: ski.id, quantity: 3 }] } }, at(16, 35), { deviceSeq: 1 });
    expect(out.outcome).toBe('applied');
    expect(ski.collected).toBe(2);
    expect(stored(s).filter((r) => r.source === 'sync').map((r) => [r.kindKey, r.message])).toEqual([['collect_exceeds', '김민재 팀 수거 3대 · 대여 중 2대 · 2대만 반영']]);
  });

  it('온라인 수거(보냄 대기가 아님)는 남은 것만 적고 확인 필요를 만들지 않는다', () => {
    const s = first();
    send(s, { type: 'stock.direct_return', payload: { orderId: 'o21', lines: lineIds(s, 'o21') } }, at(16, 0));
    const rev = s.rev;
    expect(send(s, { type: 'stock.collect', payload: { taskId: 'collect:o21', lines: lineIds(s, 'o21') } }, at(16, 35)).outcome).toBe('superseded');
    expect(s.rev).toBe(rev);
    expect(stored(s)).toHaveLength(1);
  });

  it('execute: 확인 필요만 적은 명령도 새 상태를 돌려준다(저장소가 review_items를 적는다), 기기 id는 세션의 기기', () => {
    const s = first();
    send(s, { type: 'stock.direct_return', payload: { orderId: 'o21', lines: lineIds(s, 'o21') } }, at(16, 0));
    const env = envelopeOf(s, { type: 'stock.collect', payload: { taskId: 'collect:o21', lines: lineIds(s, 'o21') } }, { deviceSeq: 2 });
    const result = execute(s, env, { now: at(16, 35), actor: { key: 'staff:s3', name: '문태오', deviceId: 'dev-1' }, outcomeOf: () => undefined });
    expect(result.outcome.outcome).toBe('superseded');
    expect(result.state).not.toBe(s);
    expect(result.state.reviews!.filter((r) => r.source === 'sync').every((r) => r.targetDeviceId === 'dev-1')).toBe(true);
    expect(s.reviews).toHaveLength(1);
  });
});

describe('확인(review.resolve)', () => {
  it('끝내면 처리 완료 탭(`확인 완료 · 16:20 · 한가람`), 같은 요청 두 번은 한 번, 다른 사람은 `확인 완료`, 없는 것은 거절', () => {
    const s = first();
    const env = envelopeOf(s, { type: 'review.resolve', payload: { reviewId: 'review-o24', resolutionKey: 'acknowledged' } });
    const first1 = applyCommand(s, env, at(16, 20), PRODUCTION_LINES, { actor: { staffId: 'staff-1', name: '한가람' } });
    expect(first1.outcome).toBe('applied');
    expect(applyCommand(s, env, at(16, 25), PRODUCTION_LINES, { actor: { name: '오세린' } })).toEqual(first1);
    expect(stored(s)[0]!.resolution).toEqual({ key: 'acknowledged', at: at(16, 20), byName: '한가람' });
    const other = send(s, { type: 'review.resolve', payload: { reviewId: 'review-o24', resolutionKey: 'acknowledged' } }, at(16, 30));
    expect([other.outcome, other.error?.message]).toEqual(['superseded', '확인 완료']);
    const view = list(s, at(16, 40));
    expect(view.count).toBe(0);
    expect(view.items).toEqual([]);
    expect(view.done.map((x) => [x.id, x.resolvedLine, x.tone, x.choices])).toEqual([['review-o24', '확인 완료 · 16:20 · 한가람', 'muted', undefined]]);
    const none = send(s, { type: 'review.resolve', payload: { reviewId: 'nope', resolutionKey: 'acknowledged' } });
    expect([none.outcome, none.error?.message]).toEqual(['rejected', '확인 대상 없음']);
    // 다음 영업일의 처리 완료 탭에는 없다(오늘 끝낸 것만).
    const next = structuredClone(s);
    next.businessDate = '2026-12-27';
    expect(list(next, at(10, 0, 1)).done).toEqual([]);
  });

  it('충돌 키: 그 한 건(review:<id>)을 읽고 쓴다', () => {
    const s = first();
    expect(conflictKeys(s, envelopeOf(s, { type: 'review.resolve', payload: { reviewId: 'review-o24', resolutionKey: 'acknowledged' } })))
      .toEqual({ writes: ['review:review-o24'], reads: ['review:review-o24'] });
  });
});

describe('지금 상태에서 센 것(derived)', () => {
  it('초과 수납: `환불 · 10,000원` · `접수증` → 환불 창 → 환불하면 사라진다(돈이 맞음)', () => {
    const s = first();
    const o = findOrder(s, 'o21')!;
    o.payments.push({ id: 'o21-extra', amount: 10_000, methodKey: 'cash', at: at(15, 50), drawerId: 'counter' });
    const view = list(s, at(16, 0));
    const item = view.items.find((x) => x.kindKey === 'overpaid')!;
    expect(item.message).toBe('김민재 팀 초과 수납 10,000원 · 환불 필요');
    expect(item.source).toBe('derived');
    expect(item.choices).toEqual([
      { key: 'refund', label: '환불 · 10,000원', enabled: true, orderId: 'o21' },
      { key: 'slip', label: '접수증', enabled: true, orderId: 'o21' },
    ]);
    expect(view.count).toBe(2);
    const sheet = runQuery(s, 'refundSheet', { orderId: 'o21' }, ctx(at(16, 0)));
    expect(sheet.title).toBe('환불 · 김민재 팀');
    expect(sheet.refunds.map((r) => r.parts.map((p) => p.text).join(' · '))).toEqual(['환불 · 현금 10,000원']);
    expect(sheet.summary.map((r) => r.text).join('')).toBe('초과 수납 10,000원 · 환불 10,000원');
    expect(sheet.primary).toEqual({ label: '환불 · 현금 10,000원', alts: ['환불 · 현금 10,000원', '환불 · 10,000원', '환불'], enabled: true });
    expect(sheet.command).toEqual({ type: 'payment.refund', payload: { orderId: 'o21', cause: 'overpaid', refunds: [{ paymentId: 'o21-extra', methodKey: 'cash', amount: 10_000 }] } });
    const env = envelopeOf(s, sheet.command!, { expect: sheet.expect! });
    expect(applyCommand(s, env, at(16, 5)).outcome).toBe('applied');
    expect(applyCommand(s, env, at(16, 6)).outcome, 'the same request again').toBe('applied');
    expect(overpaid(o)).toBe(0);
    expect(o.refunds).toHaveLength(1);
    expect(list(s, at(16, 10)).items.some((x) => x.kindKey === 'overpaid')).toBe(false);
    const after = runQuery(s, 'refundSheet', { orderId: 'o21' }, ctx(at(16, 10)));
    expect([after.notice, after.command, after.primary.enabled]).toEqual(['환불 대상 없음', undefined, false]);
    assertMoney(s);
    assertMoneyViews(s, 'o21', at(16, 10));
  });

  it('차량 예비권 기록 부족: `예비권 적재` · `리프트권`, 적재로 채우면 사라진다', () => {
    const s = first();
    s.vanSpares = [{ vehicleId: 'v1', productKey: 'night_adult', quantity: -2 }];
    const item = list(s).items.find((x) => x.kindKey === 'ticket_unavailable')!;
    expect(item.message).toBe('1호 차량 야간권 재고 기록 부족 2매 · 차량 재고 확인');
    expect(item.choices).toEqual([
      { key: 'spare_load', label: '예비권 적재', enabled: true, vehicleId: 'v1' },
      { key: 'tickets', label: '리프트권', enabled: true },
    ]);
    expect(send(s, { type: 'stock.load', payload: { vehicleId: 'v1', spares: [{ productKey: 'night_adult', quantity: 2 }] } }).outcome).toBe('applied');
    expect(list(s).items.some((x) => x.kindKey === 'ticket_unavailable')).toBe(false);
    expect(list(s).count).toBe(1);
  });
});

describe('취소 뒤에 온 기사 기록(E23)', () => {
  it('최하은 팀 적재 → 접수 취소 → 보냄 대기로 온 배달: 적용하고 `최하은 팀 업무 취소 후 기사 기록 수신` 한 건', () => {
    const s = first();
    const load = runQuery(s, 'confirmDraft', { orderId: 'o26', actionKey: 'stamp.load' }, ctx());
    applyCommand(s, envelopeOf(s, load.command!), NOW);
    const params: CancelSheetParams = { orderId: 'o26', scope: 'order', decision: 'no_refund' };
    const view = runQuery(s, 'cancelSheet', params, ctx());
    expect(applyCommand(s, envelopeOf(s, view.command!, view.expect ? { expect: view.expect } : {}), NOW).outcome).toBe('applied');
    const deliver = envelopeOf(s, { type: 'stock.deliver', payload: { taskId: 'deliver:o26', lines: lineIds(s, 'o26') } }, { deviceSeq: 7 });
    expect(applyCommand(s, deliver, at(17, 5)).outcome).toBe('applied');
    expect(applyCommand(s, deliver, at(17, 6)).outcome).toBe('applied');
    expect(stored(s).filter((r) => r.kindKey === 'task_cancelled').map((r) => [r.message, r.taskId, r.source])).toEqual([
      ['최하은 팀 업무 취소 후 기사 기록 수신', 'deliver:o26', 'sync'],
    ]);
    expect(list(s, at(17, 10)).items.find((x) => x.kindKey === 'task_cancelled')!.choices!.map((c) => c.label)).toEqual(['확인', '접수증']);
    assertMoney(s);
  });

  it('취소하지 않은 접수의 보냄 대기 배달은 확인 필요를 만들지 않는다', () => {
    const s = first();
    const load = runQuery(s, 'confirmDraft', { orderId: 'o26', actionKey: 'stamp.load' }, ctx());
    applyCommand(s, envelopeOf(s, load.command!), NOW);
    const deliver = envelopeOf(s, { type: 'stock.deliver', payload: { taskId: 'deliver:o26', lines: lineIds(s, 'o26') } }, { deviceSeq: 1 });
    expect(applyCommand(s, deliver, at(17, 5)).outcome).toBe('applied');
    expect(stored(s)).toHaveLength(1);
  });
});

describe('마감의 막는 단계(van_unsynced)', () => {
  it('기사 기기에 보낼 기록 2건: 마감 차례에 `1호 차량 기록 2건 전송 대기 · 마감 전 전송 필요` · `재확인` · `닫기`, 마감은 거절', () => {
    const s = first();
    const env = envelopeOf(s, { type: 'route.reset', payload: { vehicleId: 'v1', date: '2026-12-26' } });
    s.driverDevice = { offline: true, since: NOW, queue: [{ envelope: env, at: NOW, summary: '' }, { envelope: env, at: NOW, summary: '' }] };
    const before = runQuery(s, 'closingSheet', {}, ctx());
    expect(before.next?.kind).toBe('drawer_count');
    expect(before.step, 'only when the close is next').toBeUndefined();
    const amount = before.next!.expectedAmount!;
    const sheet = runQuery(s, 'closingSheet', { counts: [{ drawerId: 'counter', countedAmount: amount, expectedAmount: amount }] }, ctx());
    expect(sheet.next?.kind).toBe('close');
    expect(sheet.blocked).toBe('1호 차량 · 전송 대기 있음');
    expect(sheet.step).toEqual({
      kindKey: 'van_unsynced', message: '1호 차량 기록 2건 전송 대기 · 마감 전 전송 필요',
      parts: [{ text: '1호 차량 기록 2건 전송 대기', drop: 0 }, { text: '마감 전 전송 필요', drop: 1 }],
      choices: [{ key: 'recheck', label: '재확인' }, { key: 'close', label: '닫기' }],
    });
    const close = applyCommand(s, envelopeOf(s, sheet.command!, { expect: sheet.expect! }), NOW);
    expect([close.outcome, close.error?.message]).toEqual(['rejected', '1호 차량 · 전송 대기 있음']);
    // 기기의 차량이 있으면 그 차량.
    s.driverDevice.vehicleId = 'v2';
    expect(runQuery(s, 'closingSheet', { counts: [{ drawerId: 'counter', countedAmount: amount, expectedAmount: amount }] }, ctx()).step?.message)
      .toBe('2호 차량 기록 2건 전송 대기 · 마감 전 전송 필요');
    s.driverDevice = { offline: false, queue: [] };
    expect(runQuery(s, 'closingSheet', { counts: [{ drawerId: 'counter', countedAmount: amount, expectedAmount: amount }] }, ctx()).step).toBeUndefined();
  });
});

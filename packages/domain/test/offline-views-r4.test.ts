// 네 번째 검토(work/impl-offline/plan.md §18, review round 2)의 기사 · 카운터 읽기 모델:
//   - R4-11: 바닥줄 · 업무 판의 `전송 대기`는 기기에 남은 기록 수(pendingRecordCount): 한 팀의 두 기록 · 도장 없는 기록(순서 변경)도 센다.
//   - R4-14: 할 일이 없어 적지 않은 기록(순서 변경 · 시간순 정렬 · 긴급 확인 · NOTHING_LEFT)은 줄 메모가 없다. 거절 · 충돌은 `처리 제외 · 매장 확인`(R4-1).
//   - R4-16: 장부 제목 줄의 표시는 문제 있는 차량 모두(끊김이 먼저).
//   - R4-17: 띠의 메모 수는 팀 수.
//   - R4-18: 보내지 않은 돈의 `미수 없음`은 초록이 아니다.
import type { LedgerViewResult, VehicleLink } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { ledgerView, outcomeNoteCounts, outcomeNoteKey, overlayQueue, recordTeam, routeTasks, runQuery, vehicleScope } from '../src/index.ts';
import { vanLinksChip } from '../src/links.ts';
import { at, ctx, envelopeOf, first, lines, online, queued } from './offline-helpers.ts';

const metric = (l: LedgerViewResult, key: string) => { const m = l.metrics.find((x) => x.metricKey === key); return m && 'value' in m ? m.value : undefined; };

describe('one 전송 대기 number (R4-11)', () => {
  it('the list footer and the task sheet use the device record count when given (two records of one team count twice; a route move counts)', () => {
    const copy = vehicleScope(first(), 'v1', { staffId: 'staff-3' });
    const collect = envelopeOf(copy, { type: 'stock.collect', payload: { taskId: 'collect:o28', lines: lines(copy, 'o28') } }, { deviceSeq: 1 });
    const pay = envelopeOf(copy, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 1_000, methodKey: 'cash' } }, { deviceSeq: 2 });
    const second = routeTasks(copy, 'v1', copy.businessDate)[1]!.id;
    const move = envelopeOf(copy, { type: 'route.move', payload: { taskId: second, anchorTaskId: null, position: 'top' } }, { deviceSeq: 3 });
    const out = overlayQueue(copy, [collect, pay, move].map((envelope, i) => ({ envelope, at: at(22, i), state: 'queued' as const })));
    const extra = { pendingTasks: out.pendingTasks, unconfirmedTasks: out.unconfirmedTasks, pendingMoney: out.pendingMoney };
    // 예전 셈(점선 도장 팀 수)은 1, 기기의 기록 수는 3.
    expect(metric(ledgerView(out.state, 'collection_list', { vehicleId: 'v1', deviceClass: 'driver_tablet' }, ctx(at(22, 5), extra)), 'pending_count')).toBe(1);
    const l = ledgerView(out.state, 'collection_list', { vehicleId: 'v1', deviceClass: 'driver_tablet' }, ctx(at(22, 5), { ...extra, pendingRecordCount: 3 }));
    expect(metric(l, 'pending_count')).toBe(3);
    const d = ledgerView(out.state, 'delivery_list', { vehicleId: 'v1', deviceClass: 'driver_tablet' }, ctx(at(22, 5), { ...extra, pendingRecordCount: 3 }));
    expect(metric(d, 'pending_count')).toBe(3);
    const sheet = runQuery(out.state, 'taskSheet', { taskId: 'collect:o29', deviceClass: 'driver_tablet' }, ctx(at(22, 5), { ...extra, pendingRecordCount: 3 }));
    expect(sheet.progress).toMatch(/^완료 \d+ · 전송 대기 3 · 잔여 \d+$/);
    // 보냄 대기가 없는 읽기(서버의 온라인 읽기)는 예전 모양.
    expect(runQuery(copy, 'taskSheet', { taskId: 'collect:o29', deviceClass: 'driver_tablet' }, ctx(at(22, 5))).progress).toMatch(/^완료 \d+ · 잔여 \d+$/);
  });
});

describe('outcome notes (R4-1 · R4-14)', () => {
  it('no note for a superseded route move · time sort · urgent ack or any NOTHING_LEFT; excluded for a real exclusion and for refusals', () => {
    for (const type of ['route.move', 'route.reset', 'notification.ack']) expect(outcomeNoteKey('superseded', [], { type })).toBeNull();
    expect(outcomeNoteKey('superseded', [], { type: 'stock.deliver', errorCode: 'NOTHING_LEFT' })).toBeNull();
    expect(outcomeNoteKey('superseded', [], { type: 'task.visit', errorCode: 'FORBIDDEN_SCOPE' })).toBe('excluded');
    expect(outcomeNoteKey('superseded', [], { type: 'stock.collect' })).toBe('excluded');
    expect(outcomeNoteKey('superseded', ['already_returned'], { type: 'stock.collect', errorCode: 'NOTHING_LEFT' })).toBe('returned');
    for (const outcome of ['rejected', 'conflict', 'blocked']) expect(outcomeNoteKey(outcome, [], { type: 'field.collect', errorCode: 'X' })).toBe('excluded');
    expect(outcomeNoteKey('applied', [], { type: 'route.move' })).toBeNull();
  });

  it('the three no-ops really answer NOTHING_LEFT when the counter already did the same (queued path)', () => {
    const s = first();
    const second = routeTasks(s, 'v1', s.businessDate)[1]!.id;
    const move = { type: 'route.move' as const, payload: { taskId: second, anchorTaskId: null, position: 'top' as const } };
    expect(online(s, move, at(21, 50)).outcome).toBe('applied');
    const again = queued(s, move, at(21, 45), at(22, 0), { deviceSeq: 1 });
    expect([again.outcome, again.error?.code]).toEqual(['superseded', 'NOTHING_LEFT']);
    expect(outcomeNoteKey(again.outcome, [], { type: 'route.move', ...(again.error ? { errorCode: again.error.code } : {}) })).toBeNull();
    // 시간순 정렬: 이미 시간순인 목록(카운터가 먼저 정렬했거나 원래 그 순서).
    const reset = { type: 'route.reset' as const, payload: { vehicleId: 'v1', date: s.businessDate } };
    const fresh = first();
    const twice = queued(fresh, { ...reset, payload: { ...reset.payload, date: fresh.businessDate } }, at(22, 0), at(22, 2), { deviceSeq: 2 });
    expect([twice.outcome, twice.error?.code]).toEqual(['superseded', 'NOTHING_LEFT']);
    // 긴급 확인: 카운터 쪽에서 이미 확인된 요청.
    const pin = s.pins[0]!;
    const ack = { type: 'notification.ack' as const, payload: { notificationId: pin.id } };
    expect(online(s, ack, at(22, 3)).outcome).toBe('applied');
    const a2 = queued(s, ack, at(22, 2), at(22, 4), { deviceSeq: 3 });
    expect([a2.outcome, a2.error?.code]).toEqual(['superseded', 'NOTHING_LEFT']);
    expect(outcomeNoteKey(a2.outcome, [], { type: 'notification.ack', errorCode: 'NOTHING_LEFT' })).toBeNull();
  });

  it('band note counts are teams: a collect and a field payment of one team held together count once (R4-17)', () => {
    expect(recordTeam({ taskId: 'collect:o28' })).toBe('o28');
    expect(recordTeam({ orderId: 'o28', taskId: 'collect:o28' })).toBe('o28');
    expect(recordTeam({ notificationId: 'p1' })).toBeUndefined();
    expect(outcomeNoteCounts([
      { key: 'held', team: 'o28' }, { key: 'held', team: 'o28' }, { key: 'held', team: 'o29' }, { key: 'duplicate', team: 'o28' },
    ])).toEqual([{ note: '처리 보류 · 관리자 확인 필요', count: 2 }, { note: '중복 수납 의심', count: 1 }]);
  });
});

describe('the day ledger chip names every van with a problem (R4-16)', () => {
  const since = new Date(at(21, 40)).toISOString();
  const later = new Date(at(22, 5)).toISOString();
  it('offline first, then stuck; times and counts drop before any van fact', () => {
    const s = first();
    const links: VehicleLink[] = [
      { vehicleId: 'v1', state: 'stuck', since: later, reportedPending: 1 },
      { vehicleId: 'v2', state: 'offline', since, reportedPending: null },
    ];
    const chip = vanLinksChip(s, links)!;
    expect(chip.vehicleId).toBe('v2');
    expect(chip.parts.filter((p) => p.drop === 0).map((p) => p.text)).toEqual(['2호 차량 연결 끊김', '1호 차량 기록 1건 전송 대기']);
    expect(chip.parts.map((p) => p.text)).toEqual(['2호 차량 연결 끊김', '21:40부터', '1호 차량 기록 1건 전송 대기', '22:05부터']);
    // 뒤 차량의 시각이 먼저 빠진다(drop이 더 크다).
    const dropOf = (text: string) => chip.parts.find((p) => p.text === text)!.drop;
    expect(dropOf('22:05부터')).toBeGreaterThan(dropOf('21:40부터'));
    const l = ledgerView(s, 'day_ledger', { deviceClass: 'pos' }, ctx(at(22, 10), { vehicleLinks: links }));
    expect(l.link?.parts.filter((p) => p.drop === 0).map((p) => p.text)).toEqual(['2호 차량 연결 끊김', '1호 차량 기록 1건 전송 대기']);
    // 한 차량만이면 예전과 같다.
    expect(vanLinksChip(s, [links[0]])!.parts).toEqual([{ text: '1호 차량 기록 1건 전송 대기', drop: 0 }, { text: '22:05부터', drop: 1 }]);
    expect(vanLinksChip(s, [{ vehicleId: 'v1', state: 'online', reportedPending: 0 }])).toBeUndefined();
  });
});

describe('queued money is not drawn as settled (R4-18)', () => {
  it('`미수 없음` is plain ink while the payment is only queued, green once it is in the copy', () => {
    const copy = vehicleScope(first(), 'v1', { staffId: 'staff-3' });
    const due = runQuery(copy, 'fieldPaySheet', { taskId: 'collect:o28' }, ctx(at(15, 40))).expect?.dueAmount ?? 0;
    const pay = envelopeOf(copy, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: due, methodKey: 'cash' } }, { deviceSeq: 1, expect: { dueAmount: due } });
    const out = overlayQueue(copy, [{ envelope: pay, at: at(15, 40), state: 'queued' }]);
    const sheet = runQuery(out.state, 'taskSheet', { taskId: 'collect:o28', deviceClass: 'driver_tablet' }, ctx(at(15, 45), { pendingMoney: out.pendingMoney }));
    const head = sheet.money?.[0]?.[0];
    expect(head?.text).toBe('미수 없음');
    expect(head?.tone).toBeUndefined();
    const answered = overlayQueue(copy, [{ envelope: pay, at: at(15, 40), state: 'answered', outcome: 'applied' }]);
    const done = runQuery(answered.state, 'taskSheet', { taskId: 'collect:o28', deviceClass: 'driver_tablet' }, ctx(at(15, 45), { pendingMoney: answered.pendingMoney }));
    expect(done.money?.[0]?.[0]).toMatchObject({ text: '미수 없음', tone: 'green' });
  });
});

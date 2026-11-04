// 끊긴 차량과 마감(work/impl-offline/plan.md O12 · §5-6): 서버가 넘긴 차량 연결(읽기 문맥 · 정규 명령의 links)로 막는다. 알린 대기 기록 · 혼자 못 보내는
// 항목(stuck) · 열린 일이 남은 끊긴 차량은 막고, 조용한(asleep) · 로그아웃(idle) · 열린 일이 없는 끊긴 차량은 막지 않는다. 관리자 승인(override)은 막는
// 차량의 지갑을 점검 이월하고 사유를 적는다. 카운터의 수거 목록 표시와 일정 변경 · 긴급 요청의 경고.
import { describe, expect, it } from 'vitest';
import type { VehicleLink, VehicleLinkFact } from '@skinote/contract';
import { findOrder, ledgerView, runQuery, unsyncedVans } from '../src/index.ts';
import { at, closeDay, ctx, first, online } from './offline-helpers.ts';

const since = new Date(at(21, 40)).toISOString();
const link = (over: Partial<VehicleLink> = {}): VehicleLink => ({ vehicleId: 'v1', state: 'offline', since, reportedPending: null, ...over });
const fact = (l: VehicleLink): VehicleLinkFact => ({ vehicleId: l.vehicleId, state: l.state, reportedPending: l.reportedPending, ...(l.since ? { since: l.since } : {}), ...(l.state === 'stuck' ? { stuck: true } : {}) });
const manager = { roleKey: 'manager', permissions: ['closing.close', 'closing.reopen'] };
const counterRole = { roleKey: 'counter', permissions: ['closing.close'] };
const sheetAt = (s: ReturnType<typeof first>, links: VehicleLink[], viewer = counterRole) => {
  const counted = runQuery(s, 'closingSheet', {}, ctx(at(23, 0), { vehicleLinks: links, viewer }));
  const expected = counted.next?.kind === 'drawer_count' ? counted.next.expectedAmount ?? 0 : 0;
  return runQuery(s, 'closingSheet', { counts: [{ drawerId: 'counter', countedAmount: expected }] }, ctx(at(23, 0), { vehicleLinks: links, viewer }));
};

describe('which vans block the closing', () => {
  it('reported pending, stuck, and offline with open work block; asleep, idle and offline without work do not', () => {
    const s = first();
    const date = s.businessDate;
    expect(unsyncedVans(s, date, [fact(link({ state: 'online', reportedPending: 3 }))]).map((x) => x.count)).toEqual([3]);
    expect(unsyncedVans(s, date, [fact(link({ state: 'stuck', reportedPending: 0 }))]).map((x) => x.count)).toEqual([null]);
    expect(unsyncedVans(s, date, [fact(link())]).map((x) => x.vehicleId)).toEqual(['v1']);
    expect(unsyncedVans(s, date, [fact(link({ state: 'asleep' }))])).toEqual([]);
    expect(unsyncedVans(s, date, [fact(link({ state: 'idle' }))])).toEqual([]);
    // 2호 차량은 오늘 일이 없다: 끊겨도 막지 않는다.
    expect(unsyncedVans(s, date, [fact(link({ vehicleId: 'v2' }))])).toEqual([]);
    // 연결 사실이 없으면 메모리 어댑터의 기사 기기(보냄 대기 없음).
    expect(unsyncedVans(s, date, undefined)).toEqual([]);
  });

  it('the step line: a known count uses the seed template, an unknown one the offline line; approve only for closing.reopen', () => {
    const s = first();
    const known = sheetAt(s, [link({ reportedPending: 3 })]);
    expect(known.next?.kind).toBe('close');
    expect(known.next?.enabled).toBe(false);
    expect(known.step?.message).toBe('1호 차량 기록 3건 전송 대기 · 마감 전 전송 필요');
    expect(known.step?.choices.map((c) => c.key)).toEqual(['recheck', 'close']);
    const unknown = sheetAt(s, [link()], manager);
    expect(unknown.step?.message).toBe('1호 차량 연결 끊김 · 21:40부터 · 마감 전 전송 필요');
    expect(unknown.step?.choices.map((c) => [c.key, c.label])).toEqual([['recheck', '재확인'], ['approve', '관리자 승인'], ['close', '닫기']]);
    expect(unknown.blocked).toBe('1호 차량 연결 끊김 · 21:40부터');
    const asleep = sheetAt(s, [link({ state: 'asleep' })]);
    expect(asleep.step).toBeUndefined();
    expect(asleep.next?.enabled).toBe(true);
  });

  it('the van row note for an offline van: last contact and pending', () => {
    const s = first();
    online(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 50_000, methodKey: 'cash' } }, at(21, 30), { expect: { dueAmount: 120_000 } });
    const sheet = runQuery(s, 'closingSheet', {}, ctx(at(23, 0), { vehicleLinks: [link({ reportedPending: 2 })] }));
    expect(sheet.cash.find((r) => r.key === 'van:v1')?.note).toEqual([{ text: '마지막 연결 21:40', drop: 1 }, { text: '전송 대기 2', drop: 2 }]);
    const unknown = runQuery(s, 'closingSheet', {}, ctx(at(23, 0), { vehicleLinks: [link()] }));
    expect(unknown.cash.find((r) => r.key === 'van:v1')?.note?.[1]).toEqual({ text: '전송 대기 있음', drop: 2 });
  });

  it('closing.close reads only the links in its payload: blocked without override, applied with it (override reason kept)', () => {
    const s = first();
    const links = [fact(link())];
    const blocked = closeDay(s, at(23, 0), { links });
    expect([blocked.outcome, blocked.error?.message]).toEqual(['rejected', '1호 차량 연결 끊김 · 21:40부터']);
    const done = closeDay(s, at(23, 0), { links, override: { approvalId: 'B'.repeat(22), reason: '휴대폰 꺼짐', approvedBy: 'staff:staff-1' } });
    expect(done.outcome).toBe('applied');
    expect(s.closings[0]?.overrideReason).toBe('휴대폰 꺼짐');
  });

  it('the frozen sheet of an overridden closing keeps the offline van as it was: last contact · 전송 대기 있음, wallet 점검 이월', () => {
    const s = first();
    online(s, { type: 'field.collect', payload: { taskId: 'collect:o28', orderId: 'o28', amount: 50_000, methodKey: 'cash' } }, at(21, 30), { expect: { dueAmount: 120_000 } });
    const done = closeDay(s, at(23, 0), {
      links: [fact(link())], deferredTransferIds: ['van:v1'], override: { approvalId: 'B'.repeat(22), reason: '방전', approvedBy: 'staff:staff-1' },
    });
    expect(done.outcome).toBe('applied');
    const row = s.closings[0]?.sheet?.cash.find((r) => r.key === 'van:v1');
    expect(row?.note).toEqual([{ text: '마지막 연결 21:40', drop: 1 }, { text: '전송 대기 있음', drop: 2 }]);
    expect(row?.actual).toEqual([{ text: '점검 이월', strong: true, tone: 'grey' }]);
    // 다시 읽어도(얼린 표) 같은 줄이다.
    const again = runQuery(s, 'closingSheet', {}, ctx(at(23, 5), { vehicleLinks: [] }));
    expect(again.cash.find((r) => r.key === 'van:v1')?.note?.[1]).toEqual({ text: '전송 대기 있음', drop: 2 });
  });

  it('an overridden closing leaves the blocking van, the approval and the reason on the frozen sheet, also without a van cash row (§17 R3-27)', () => {
    const s = first();
    const done = closeDay(s, at(23, 0), {
      links: [fact(link())], override: { approvalId: 'B'.repeat(22), reason: '방전', approvedBy: 'staff:staff-1' },
    });
    expect(done.outcome).toBe('applied');
    const frozen = s.closings[0]?.sheet;
    expect(frozen?.cash.some((r) => r.key === 'van:v1')).toBe(false);
    const carry = frozen?.carry.find((c) => c.key === 'override:v1');
    expect(carry?.title).toEqual([{ text: '1호 차량 · 전송 대기 있음' }]);
    expect(carry?.note.map((p) => p.text)).toEqual(['마지막 연결 21:40', '관리자 승인', '사유 · 방전']);
    // 다시 읽어도(얼린 표) 남는다.
    const again = runQuery(s, 'closingSheet', {}, ctx(at(23, 5), { vehicleLinks: [] }));
    expect(again.carry.find((c) => c.key === 'override:v1')?.note.map((p) => p.text)).toEqual(['마지막 연결 21:40', '관리자 승인', '사유 · 방전']);
    // 승인 없이 닫힌 날(막는 차량 없음)에는 이 줄이 없다.
    const plain = first();
    expect(closeDay(plain, at(23, 0), { links: [] }).outcome).toBe('applied');
    expect(plain.closings[0]?.sheet?.carry.some((c) => c.key.startsWith('override:'))).toBe(false);
  });

  it('an empty links list (the server saw every van online) does not fall back to the demo queue', () => {
    const s = first();
    s.driverDevice = { offline: true, queue: [{ envelope: {} as never, at: 0, summary: '' }] };
    expect(closeDay(s, at(23, 0), { links: [] }).outcome).toBe('applied');
  });
});

describe('counter indicators', () => {
  it('the counter collection list carries the chip for an offline or stuck van; drivers never get it', () => {
    const s = first();
    const counter = (links: VehicleLink[]) => ledgerView(s, 'collection_list', { vehicleId: 'v1', deviceClass: 'pos' }, ctx(at(22, 0), { vehicleLinks: links }));
    expect(counter([link({ reportedPending: 3 })]).link).toEqual({ vehicleId: 'v1', parts: [{ text: '1호 차량 연결 끊김', drop: 0 }, { text: '21:40부터', drop: 1 }, { text: '전송 대기 3', drop: 2 }] });
    expect(counter([link({ state: 'stuck', reportedPending: 3 })]).link?.parts).toEqual([{ text: '1호 차량 기록 3건 전송 대기', drop: 0 }, { text: '21:40부터', drop: 1 }]);
    expect(counter([link({ state: 'asleep' })]).link).toBeUndefined();
    expect(counter([]).link).toBeUndefined();
    const driver = ledgerView(s, 'collection_list', { vehicleId: 'v1', deviceClass: 'driver_phone' }, ctx(at(22, 0), { vehicleLinks: [link()] }));
    expect(driver.link).toBeUndefined();
  });

  it('the counter’s return notice of a van team and the ledger title carry the van’s link fact (§17 R3-23)', () => {
    const s = first();
    const slip = (links: VehicleLink[]) => runQuery(s, 'orderSlip', { orderId: 'o21' }, ctx(at(21, 50), { vehicleLinks: links }));
    const back = (links: VehicleLink[]) => slip(links)?.checklist.find((c) => c.stamp?.state === 'delegated')?.stamp?.pressNote?.lines;
    expect(back([])?.length).toBe(1);
    expect(back([link()])).toEqual([expect.stringMatching(/^1호 차량 수거 예정 · /), '1호 차량 연결 끊김 · 21:40부터 · 수거 여부 미확인']);
    expect(back([link({ state: 'online' })])?.length).toBe(1);
    // 카운터 수거 목록의 기사 도장 알림에도.
    const counterList = ledgerView(s, 'collection_list', { vehicleId: 'v1', deviceClass: 'pos' }, ctx(at(21, 50), { vehicleLinks: [link()] }));
    const notes = counterList.rows.flatMap((r) => Object.values(r.cells).flatMap((c) => (c.renderer === 'stamp' ? c.stamp.pressNote?.lines ?? [] : [])));
    expect(notes).toContain('1호 차량 연결 끊김 · 21:40부터 · 수거 여부 미확인');
    // 장부의 보라 `차량` 도장을 눌러도 같은 줄(매장 반납 처리 전에 본다).
    const ledgerNotes = (links: VehicleLink[]) => ledgerView(s, 'day_ledger', { deviceClass: 'pos' }, ctx(at(21, 50), { vehicleLinks: links })).rows
      .filter((r) => r.orderId === 'o21').flatMap((r) => Object.values(r.cells).flatMap((c) => (c.renderer === 'stamp' && c.stamp.state === 'delegated' ? c.stamp.pressNote?.lines ?? [] : [])));
    expect(ledgerNotes([link()])).toEqual([expect.stringMatching(/^1호 차량 수거 예정 · /), '1호 차량 연결 끊김 · 21:40부터 · 수거 여부 미확인']);
    expect(ledgerNotes([link({ state: 'online' })])).not.toContain('1호 차량 연결 끊김 · 21:40부터 · 수거 여부 미확인');
    expect(ledgerNotes([])).toEqual([expect.stringMatching(/^1호 차량 수거 예정 · /)]);
    // 장부(카운터의 첫 화면) 제목 줄 표시. 기사 판 · 연결된 차량은 없음.
    expect(ledgerView(s, 'day_ledger', { deviceClass: 'pos' }, ctx(at(21, 50), { vehicleLinks: [link()] })).link?.parts.map((p) => p.text)).toEqual(['1호 차량 연결 끊김', '21:40부터']);
    expect(ledgerView(s, 'day_ledger', { deviceClass: 'pos' }, ctx(at(21, 50), { vehicleLinks: [link({ state: 'online' })] })).link).toBeUndefined();
  });

  it('일정 변경 and 긴급 요청 carry the warning when the moved lines sit in that van’s open task (asleep: the quieter line)', () => {
    const s = first();
    const quantities = Object.fromEntries(findOrder(s, 'o25')!.lines.map((l) => [l.id, l.qty]));
    const sheet = (links: VehicleLink[]) => runQuery(s, 'promiseSheet', { orderId: 'o25', quantities, vehicleId: 'v2', slot: { day: 'today', slotKey: 'late_night' } }, ctx(at(21, 50), { vehicleLinks: links }));
    expect(sheet([link()]).linkWarning?.map((p) => p.text)).toEqual(['1호 차량 연결 끊김', '21:40부터', '수거 여부 미확인']);
    expect(sheet([link({ state: 'asleep', lastContactAt: since })]).linkWarning?.map((p) => p.text)).toEqual(['1호 차량 마지막 연결 21:40', '수거 여부 미확인']);
    expect(sheet([link({ state: 'online' })]).linkWarning).toBeUndefined();
    const pin = runQuery(s, 'confirmDraft', { actionKey: 'pin', orderId: 'o25', taskId: 'collect:o25' }, ctx(at(21, 50), { vehicleLinks: [link({ state: 'stuck', reportedPending: 2 })] }));
    expect(pin.summary.at(-1)).toBe('1호 차량 기록 2건 전송 대기 · 21:40부터 · 수거 여부 미확인');
  });
});

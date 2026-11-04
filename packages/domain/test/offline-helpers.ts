// 보냄 대기 시험의 도우미(work/impl-offline/plan.md §5): 견본 하루, 온라인 · 보냄 대기 봉투, 하루 마감(창이 주는 그대로), 기사 판의 명령.
import { defaultUiConfig, draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type ConfirmCommand, type Expect, type UiConfig } from '@skinote/contract';
import { expect } from 'vitest';
import { applyCommand, kstAt, runQuery, type ApplyOptions, type ShopState } from '../src/index.ts';
import { sampleDay } from '../src/sample/index.ts';

export const DATE = '2026-12-26';
export const at = (h: number, m: number, day = 0) => kstAt(DATE, day, h, m);
export const config: UiConfig = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
export const ctx = (now: number, extra: Record<string, unknown> = {}) => ({ config, now, ...extra });
export const first = (): ShopState => sampleDay({ date: DATE, epoch: 'e', ids: 'demo' });
export const numbered = (): ShopState => sampleDay({ date: DATE, epoch: 'e', ids: 'demo', shop: 'numbered' });

let n = 0;
/** 시험마다 다른 요청번호(ULID 모양). */
export const rid = () => '01K62M3QG0000000000000' + String(++n).padStart(4, '0');

export interface EnvelopeExtra { expect?: Expect; dependsOn?: string[]; deviceSeq?: number; epoch?: string }

export function envelopeOf(state: ShopState, command: ConfirmCommand, extra: EnvelopeExtra = {}): AnyCommandEnvelope {
  const draft = openCommandDraft(command, { epoch: extra.epoch ?? state.epoch, rev: state.rev }, {
    requestId: rid(), ...(extra.expect ? { expect: extra.expect } : {}), ...(extra.dependsOn ? { dependsOn: extra.dependsOn } : {}),
  });
  return draftToEnvelope(draft, extra.deviceSeq !== undefined ? { deviceSeq: extra.deviceSeq } : {});
}

/** 온라인 명령(카운터). */
export const online = (s: ShopState, command: ConfirmCommand, now: number, extra: EnvelopeExtra = {}, options: ApplyOptions = {}) =>
  applyCommand(s, envelopeOf(s, command, extra), now, undefined, options);

let seq = 0;
/** 보냄 대기 명령: 일어난 때(now) · 서버가 받은 때(recordedAt) · 기사 기기(deviceId). */
export const queued = (s: ShopState, command: ConfirmCommand, now: number, recordedAt?: number, extra: EnvelopeExtra = {}, deviceId = 'dev-phone') =>
  applyCommand(s, envelopeOf(s, command, { deviceSeq: ++seq, ...extra }), now, undefined, {
    orderIds: 'dated', actor: { deviceId, name: '박기사', staffId: 'staff-3' }, ...(recordedAt !== undefined ? { recordedAt } : {}),
  });

export const lines = (s: ShopState, orderId: string) => s.orders.find((o) => o.id === orderId)!.lines.map((l) => ({ lineId: l.id, quantity: l.qty }));

/** 접수의 모든 반납 줄을 다른 차량의 심야 24:00 · 같은 장소로 옮긴다(일정 변경, 카운터). */
export function moveToVan(s: ShopState, orderId: string, vehicleId: string, now: number): void {
  const o = s.orders.find((x) => x.id === orderId)!;
  const moved = o.lines.filter((l) => l.returnable).map((l) => ({ lineId: l.id, quantity: l.qty }));
  const promise = { mode: 'vehicle' as const, slot: { day: DATE, slotKey: 'late_night' }, placeKey: o.giveBack.placeId!, vehicleId };
  const out = online(s, { type: 'promise.change', payload: { orderId, kind: 'return', lines: moved, promise } }, now);
  expect(out.outcome, JSON.stringify(out.error ?? null)).toBe('applied');
}

/**
 * 하루 마감(창이 주는 그대로): 차량 현금 점검(센 금액 = 예상, 점검 이월한 것은 빼고) → 돈통 점검 → 마감. payloadExtra의 links · override는 서버가 정규
 * 명령에 적는 칸, deferredTransferIds는 점검 이월.
 */
export function closeDay(s: ShopState, now: number, payloadExtra: Record<string, unknown> = {}): ReturnType<typeof applyCommand> {
  const deferred = (payloadExtra.deferredTransferIds as string[] | undefined) ?? [];
  for (let guard = 0; guard < 10; guard += 1) {
    const sheet = runQuery(s, 'closingSheet', { deferredTransferIds: deferred }, ctx(now));
    if (sheet.next?.kind !== 'van_check') break;
    const check = runQuery(s, 'closingSheet', { deferredTransferIds: deferred, check: { key: sheet.next.targetKey!, countedAmount: sheet.next.expectedAmount! } }, ctx(now)).check!;
    expect(online(s, check.command!, now, { expect: check.expect! }).outcome).toBe('applied');
  }
  const first = runQuery(s, 'closingSheet', { deferredTransferIds: deferred }, ctx(now));
  const expected = first.next?.kind === 'drawer_count' ? first.next.expectedAmount ?? 0 : 0;
  const sheet = runQuery(s, 'closingSheet', { deferredTransferIds: deferred, counts: [{ drawerId: 'counter', countedAmount: expected }] }, ctx(now));
  const command = sheet.command ?? {
    type: 'closing.close' as const, payload: { date: s.businessDate, drawerCounts: [{ drawerId: 'counter', countedAmount: expected, expectedAmount: expected }], deferredTransferIds: deferred },
  };
  const cmd = { type: 'closing.close' as const, payload: { ...(command.payload as object), ...payloadExtra } } as ConfirmCommand;
  return online(s, cmd, now, { expect: sheet.expect ?? { expectedCash: { counter: expected } } });
}

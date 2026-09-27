// 즉시 교환(features-1 plan §7-6): 창(exchangeSheet) · 명령(exchange.swap). 손님에게 있는 것(held) · 아직 지급하지 않은 것(planned)의 사이즈를 바꾸고,
// 뒤의 반납 · 지급 · 수거가 지금 사이즈를 쓰는지(자리 셈, variants.ts), 접수증 · 반납 창 · 기사 업무 판 · 확인 창이 지금 사이즈를 보이는지, 돈이
// 바뀌지 않는지(assertMoney), 같은 요청번호를 두 번 보내도 한 번만 적용되는지, 교환할 수 없는 줄(번호 줄 · 사이즈 없는 줄)은 거절되는지 본다.
import {
  defaultUiConfig, draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type ConfirmCommand, type ExchangeSheetParams, type UiConfig,
} from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import {
  applyCommand, charged, conflictKeys, findOrder, heldVariants, kstAt, orderConditions, orderSlip, paidTotal, plannedVariants, runQuery, type FxLine,
  type ShopState,
} from '../src/index.ts';
import { sampleDay } from '../src/sample/index.ts';
import { assertMoney, assertMoneyViews } from './money-check.ts';

const at = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const NOW = at(15, 40);
const config: UiConfig = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
const first = (): ShopState => sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
const ctx = (now = NOW) => ({ config, now });

let seq = 0;
const rid = () => '01K62M2QG00000000000003' + String(++seq).padStart(3, '0');
function envelopeOf(state: ShopState, command: ConfirmCommand): AnyCommandEnvelope {
  return draftToEnvelope(openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, { requestId: rid() }));
}
const line = (s: ShopState, orderId: string, kind: string): FxLine => findOrder(s, orderId)!.lines.find((l) => l.kind === kind)!;
const sheet = (s: ShopState, params: ExchangeSheetParams, now = NOW) => runQuery(s, 'exchangeSheet', params, ctx(now));

/** 창이 써 준 명령을 보낸다(고른 것: 줄 · 옛 사이즈 · 지급 전인지 · 수 · 새 사이즈). */
function swap(s: ShopState, params: ExchangeSheetParams, now = NOW, name?: string) {
  const view = sheet(s, params, now);
  if (!view.command) return { view, outcome: null, env: null };
  const env = envelopeOf(s, view.command);
  return { view, env, outcome: applyCommand(s, env, now, undefined, name ? { actor: { name } } : {}) };
}
const check = (s: ShopState, ...ids: string[]) => {
  assertMoney(s);
  for (const id of ids) assertMoneyViews(s, id, NOW);
};
const rows = (s: ShopState, orderId: string) => orderSlip({ state: s, config, now: NOW }, orderId)!.adjustments?.map((a) => a.parts.map((p) => p.text).join(' · ')) ?? [];

describe('즉시 교환 창(exchangeSheet)', () => {
  it('손님에게 있는 의류(김민재): 교환 품목 · 반납 사이즈 · 지급 사이즈(다른 사이즈) · 사이즈를 고르기 전에는 주 버튼이 막힘', () => {
    const s = first();
    const clothes = line(s, 'o21', 'clothes');
    const view = sheet(s, { orderId: 'o21' });
    expect(view.title).toBe('즉시 교환 · 김민재 팀');
    expect(view.items.map((i) => i.label)).toEqual(['의류 사이즈 ' + clothes.variantKey + ' · 1벌']);
    expect(view.items[0]).toMatchObject({ lineId: clothes.id, from: clothes.variantKey, planned: false, selected: true });
    expect(view.quantity).toEqual({ name: '반납 사이즈', note: '사이즈 ' + clothes.variantKey, input: { value: 1, min: 1, max: 1, unit: '벌' } });
    expect(view.sizes.map((x) => x.label)).toEqual(['90', '95', '100', '105', '110'].filter((x) => x !== clothes.variantKey));
    expect(view.primary).toEqual({ label: '즉시 교환 · 의류 1벌', alts: ['즉시 교환 · 의류 1벌', '즉시 교환'], enabled: false });
    expect(view.command).toBeUndefined();
    expect(view.summary.map((r) => r.text).join('')).toBe('의류 사이즈 ' + clothes.variantKey + ' · 1벌 · 금액 유지');
    const picked = sheet(s, { orderId: 'o21', lineId: clothes.id, from: clothes.variantKey!, planned: false, to: '110' });
    expect(picked.summary.map((r) => r.text).join('')).toBe('의류 사이즈 ' + clothes.variantKey + ' → 사이즈 110 · 1벌 · 금액 유지');
    expect(picked.primary.enabled).toBe(true);
    expect(picked.command).toEqual({ type: 'exchange.swap', payload: { orderId: 'o21', lineId: clothes.id, quantity: 1, from: clothes.variantKey, to: '110', planned: false } });
  });

  it('조건 exchangeable은 사이즈가 있는 수량 줄에 바꿀 것이 있을 때만(스키만 있는 팀 · 번호 매장은 없음)', () => {
    const s = first();
    expect(orderConditions(s, findOrder(s, 'o21')!)).toContain('exchangeable');
    // 박준호(전화 예약, 지급 전): 준비한 헬멧 사이즈의 교환(planned).
    expect(orderConditions(s, findOrder(s, 'o22')!)).toContain('exchangeable');
    expect(orderConditions(s, findOrder(s, 'o34')!)).not.toContain('exchangeable');
    const numbered = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo', shop: 'numbered' });
    expect(numbered.orders.some((o) => orderConditions(numbered, o).includes('exchangeable'))).toBe(false);
    expect(sheet(numbered, { orderId: 'o21' })).toMatchObject({ items: [], notice: '교환 불가 · 교환 대상 없음', primary: { enabled: false } });
  });
});

describe('즉시 교환(exchange.swap)', () => {
  it('손님에게 있는 것: 줄에 교환 기록(누가 · 언제) · 돈 그대로 · 접수증 줄 이름과 출처 줄 · 같은 요청번호 두 번 → 한 번', () => {
    const s = first();
    const o = findOrder(s, 'o21')!;
    const clothes = line(s, 'o21', 'clothes');
    const before = { charged: charged(o), paid: paidTotal(o) };
    const { env, outcome } = swap(s, { orderId: 'o21', lineId: clothes.id, from: clothes.variantKey!, planned: false, to: '110' }, NOW, '오세린');
    expect(outcome?.outcome).toBe('applied');
    expect(outcome?.result).toEqual({ exchangeId: env!.requestId });
    expect(clothes.swaps).toEqual([{ id: env!.requestId, at: NOW, quantity: 1, from: clothes.variantKey, to: '110', planned: false, base: 0, byName: '오세린' }]);
    expect(applyCommand(s, env!, NOW).outcome).toBe('applied');
    expect(clothes.swaps).toHaveLength(1);
    expect({ charged: charged(o), paid: paidTotal(o) }).toEqual(before);
    expect(heldVariants(clothes)).toEqual([{ key: '110', quantity: 1 }]);
    const slip = orderSlip({ state: s, config, now: NOW }, 'o21')!;
    expect(slip.lines.find((l) => l.id === clothes.id)?.label).toBe('의류 사이즈 110');
    expect(rows(s, 'o21')).toEqual(['즉시 교환 · 의류 사이즈 ' + clothes.variantKey + ' → 사이즈 110 · 1벌 · 15:40']);
    // 반납 창의 품목 칸도 지금 사이즈.
    const back = runQuery(s, 'returnSheet', { orderId: 'o21' }, ctx());
    expect(back.lines.find((l) => l.lineId === clothes.id)?.note).toContain('사이즈 110');
    check(s, 'o21');
  });

  it('일부 · 같은 줄 두 번 · 뒤의 반납은 먼저 나간 자리부터(FIFO)', () => {
    const s = first();
    const helmet = line(s, 'o35', 'helmet');
    const from = helmet.variantKey!;
    const other = ['소', '중', '대'].filter((x) => x !== from);
    expect(swap(s, { orderId: 'o35', lineId: helmet.id, from, planned: false, quantity: 1, to: other[0] }).outcome?.outcome).toBe('applied');
    expect(heldVariants(helmet)).toEqual([{ key: other[0], quantity: 1 }, { key: from, quantity: 3 }]);
    // 같은 줄을 한 번 더: 새 사이즈를 또 다른 사이즈로.
    expect(swap(s, { orderId: 'o35', lineId: helmet.id, from: other[0], planned: false, quantity: 1, to: other[1] }).outcome?.outcome).toBe('applied');
    expect(heldVariants(helmet)).toEqual([{ key: other[1], quantity: 1 }, { key: from, quantity: 3 }]);
    const slip = orderSlip({ state: s, config, now: NOW }, 'o35')!;
    const names = (k: string) => (k === '소' || k === '중' || k === '대' ? k + ' 사이즈' : k);
    expect(slip.lines.find((l) => l.id === helmet.id)?.label).toBe('헬멧 ' + names(other[1]!) + ' 1 · ' + names(from) + ' 3');
    // 매장 반납 1개: 먼저 나간 자리(바꾼 사이즈)가 돌아온다.
    const ret = applyCommand(s, envelopeOf(s, { type: 'stock.direct_return', payload: { orderId: 'o35', lines: [{ lineId: helmet.id, quantity: 1 }] } }), NOW);
    expect(ret.outcome).toBe('applied');
    expect(heldVariants(helmet)).toEqual([{ key: from, quantity: 3 }]);
    expect(rows(s, 'o35')).toHaveLength(2);
    check(s, 'o35');
  });

  it('지급 전(박준호 예약 헬멧 3): 준비한 사이즈를 바꾸고 지급하면 새 사이즈가 나간다', () => {
    const s = first();
    const helmet = line(s, 'o22', 'helmet');
    const from = helmet.variantKey!;
    const to = from === '대' ? '소' : '대';
    const view = sheet(s, { orderId: 'o22' });
    expect(view.items.map((i) => i.planned)).toEqual([true]);
    expect(view.quantity?.name).toBe('지급 예정 사이즈');
    const { outcome } = swap(s, { orderId: 'o22', lineId: helmet.id, from, planned: true, quantity: 1, to });
    expect(outcome?.outcome).toBe('applied');
    expect(helmet.swaps?.[0]).toMatchObject({ planned: true, base: 0 });
    expect(plannedVariants(helmet)).toEqual([{ key: to, quantity: 1 }, { key: from, quantity: 2 }]);
    // 지급 창의 헬멧 줄도 지금 사이즈.
    const draft = runQuery(s, 'confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' }, ctx());
    expect(draft.counts?.find((c) => c.lineId === helmet.id)?.note).toBe(to + ' 사이즈 1 · ' + from + ' 사이즈 2');
    expect(draft.summary.join(' / ')).toContain('헬멧 ' + to + ' 사이즈 1 · ' + from + ' 사이즈 2');
    expect(applyCommand(s, envelopeOf(s, { type: 'stock.issue', payload: { orderId: 'o22', lines: [{ lineId: helmet.id, quantity: 3 }] } }), NOW).outcome).toBe('applied');
    expect(heldVariants(helmet)).toEqual([{ key: to, quantity: 1 }, { key: from, quantity: 2 }]);
    expect(plannedVariants(helmet)).toEqual([]);
    check(s, 'o22');
  });

  it('일부 지급 뒤의 지급 전 교환은 남은 자리만 바꾼다(이미 나간 것은 그대로)', () => {
    const s = first();
    const helmet = line(s, 'o22', 'helmet');
    const from = helmet.variantKey!;
    const to = from === '대' ? '소' : '대';
    applyCommand(s, envelopeOf(s, { type: 'stock.issue', payload: { orderId: 'o22', lines: [{ lineId: helmet.id, quantity: 1 }] } }), NOW);
    const view = sheet(s, { orderId: 'o22' });
    expect(view.items.map((i) => [i.planned, i.label])).toEqual([[false, '헬멧 ' + from + ' 사이즈 · 1개'], [true, '헬멧 ' + from + ' 사이즈 · 2개']]);
    expect(swap(s, { orderId: 'o22', lineId: helmet.id, from, planned: true, quantity: 2, to }).outcome?.outcome).toBe('applied');
    expect(helmet.swaps?.[0]?.base).toBe(1);
    expect(heldVariants(helmet)).toEqual([{ key: from, quantity: 1 }]);
    expect(plannedVariants(helmet)).toEqual([{ key: to, quantity: 2 }]);
    applyCommand(s, envelopeOf(s, { type: 'stock.issue', payload: { orderId: 'o22', lines: [{ lineId: helmet.id, quantity: 2 }] } }), NOW);
    expect(heldVariants(helmet)).toEqual([{ key: from, quantity: 1 }, { key: to, quantity: 2 }]);
    check(s, 'o22');
  });

  it('기사 업무 판 · 수거 창은 손님이 가진 사이즈(김민수 헬멧 2 중 1 교환)', () => {
    const s = first();
    const helmet = line(s, 'o25', 'helmet');
    const from = helmet.variantKey!;
    const to = from === '소' ? '대' : '소';
    swap(s, { orderId: 'o25', lineId: helmet.id, from, planned: false, quantity: 1, to });
    const task = runQuery(s, 'taskSheet', { taskId: 'collect:o25' }, ctx());
    expect(task.lines.find((l) => l.lineId === helmet.id)?.label).toBe('헬멧 ' + to + ' 사이즈 1 · ' + from + ' 사이즈 1');
    const draft = runQuery(s, 'confirmDraft', { orderId: 'o25', actionKey: 'stamp.collect', taskId: 'collect:o25' }, ctx(at(22, 0)));
    expect(draft.counts?.find((c) => c.lineId === helmet.id)?.note).toBe(to + ' 사이즈 1 · ' + from + ' 사이즈 1');
    expect(conflictKeys(s, envelopeOf(s, { type: 'exchange.swap', payload: { orderId: 'o25', lineId: helmet.id, quantity: 1, from, to, planned: false } })))
      .toEqual({ writes: [], reads: ['line:' + helmet.id + ':quantity'] });
    check(s, 'o25');
  });

  it('거절: 가진 것보다 많이 · 같은 사이즈 · 없는 사이즈 · 사이즈 없는 줄(스키) · 번호 줄 → `교환 불가 · 교환 대상 없음`, 아무것도 바뀌지 않음', () => {
    const s = first();
    const clothes = line(s, 'o21', 'clothes');
    const ski = line(s, 'o21', 'ski');
    const send = (payload: Partial<{ lineId: string; quantity: number; from: string; to: string; planned: boolean }>) => applyCommand(s, envelopeOf(s, {
      type: 'exchange.swap',
      payload: { orderId: 'o21', lineId: clothes.id, quantity: 1, from: clothes.variantKey!, to: '110', planned: false, ...payload },
    }), NOW);
    for (const bad of [{ quantity: 2 }, { to: clothes.variantKey! }, { to: '300' }, { planned: true }, { lineId: ski.id, from: '' }]) {
      const out = send(bad);
      expect(out.outcome, JSON.stringify(bad)).toBe('rejected');
      expect(out.error?.message).toBe('교환 불가 · 교환 대상 없음');
    }
    expect(clothes.swaps).toBeUndefined();
    const numbered = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo', shop: 'numbered' });
    const unit = line(numbered, 'o21', 'clothes');
    const out = applyCommand(numbered, envelopeOf(numbered, {
      type: 'exchange.swap', payload: { orderId: 'o21', lineId: unit.id, quantity: 1, from: '100', to: '105', planned: false },
    }), NOW);
    expect(out.error?.message).toBe('교환 불가 · 교환 대상 없음');
    expect(runQuery(s, 'exchangeSheet', { orderId: 'o34' }, ctx()).notice).toBe('교환 불가 · 교환 대상 없음');
    check(s, 'o21');
  });

  it('차에 실은 것은 지급 전 교환에서 빠진다(최하은 헬멧: 적재 뒤 매장에 남은 것만)', () => {
    const s = first();
    const helmet = line(s, 'o26', 'helmet');
    expect(sheet(s, { orderId: 'o26' }).items.map((i) => i.label)).toEqual(['헬멧 ' + helmet.variantKey + ' 사이즈 · 3개']);
    applyCommand(s, envelopeOf(s, { type: 'stock.load', payload: { taskId: 'deliver:o26', lines: [{ lineId: helmet.id, quantity: 2 }] } }), NOW);
    const view = sheet(s, { orderId: 'o26' });
    expect(view.items.map((i) => i.label)).toEqual(['헬멧 ' + helmet.variantKey + ' 사이즈 · 1개']);
    const to = helmet.variantKey === '대' ? '중' : '대';
    expect(swap(s, { orderId: 'o26', lineId: helmet.id, from: helmet.variantKey!, planned: true, quantity: 1, to }).outcome?.outcome).toBe('applied');
    expect(helmet.swaps?.[0]?.base).toBe(2);
    // 배달은 실은 자리(옛 사이즈)부터, 남은 하나는 새 사이즈.
    const deliver = runQuery(s, 'taskSheet', { taskId: 'deliver:o26' }, ctx());
    expect(deliver.lines.find((l) => l.lineId === helmet.id)?.label).toBe('헬멧 ' + helmet.variantKey + ' 사이즈 2 · ' + to + ' 사이즈 1');
    check(s, 'o26');
  });
});

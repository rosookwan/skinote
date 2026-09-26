// 첫 매장 답(2026-09-26, README D7)으로 매장 설정이 된 규칙: 밤 수거의 늦음 여유(답 15)와 야간 수거 준비 안내의 길이, 끊긴 기사 기기의 리프트권
// 추가가 기록된 차량 예비권보다 많을 때(답 14, sync 8-12). 번호 · 보증금이 없는 첫 매장 모양(견본 기본)으로 본다.
import { defaultUiConfig, draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type ConfirmCommand, type OrderDraftInput, type UiConfig } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { applyCommand, checkoutPlan, kstAt, lateAfter, lateAtOf, ledgerView, MINUTE, runQuery, spareTickets, type ShopState } from '../src/index.ts';
import { sampleDay } from '../src/sample/index.ts';

const at = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const config: UiConfig = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
const ctx = (now: number) => ({ config, now });
const first = () => sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
const numbered = () => sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo', shop: 'numbered' });

describe('차량 늦음의 여유(매장 설정 vehicleLate, 답 15)', () => {
  it('첫 매장: 낮 차량 약속은 60분, 야간 반납 타임(22:00) 이후는 90분, 매장 반납은 30분', () => {
    const { settings } = first();
    expect(settings.vehicleLate).toEqual({ minutes: 60, nightMinutes: 90 });
    expect(lateAfter(settings, { at: at(16, 30), mode: 'vehicle' })).toBe(60 * MINUTE);
    expect(lateAfter(settings, { at: at(21, 50), mode: 'vehicle' })).toBe(60 * MINUTE);
    expect(lateAtOf(settings, { at: at(22, 0), mode: 'vehicle' })).toBe(at(23, 30));
    expect(lateAtOf(settings, { at: at(22, 10), mode: 'vehicle' })).toBe(at(23, 40));
    // 심야 24:00(27일 00:00)도 야간 반납 타임 뒤다(영업일 안의 시각 24:00).
    expect(lateAtOf(settings, { at: at(0, 0, 1), mode: 'vehicle' })).toBe(at(1, 30, 1));
    expect(lateAfter(settings, { at: at(22, 0), mode: 'store' })).toBe(30 * MINUTE);
  });

  it('설정이 없는 매장(번호 매장 모양 · 옛 자료)은 전과 같다: 차량 60분', () => {
    const { settings } = numbered();
    expect(settings.vehicleLate).toBeUndefined();
    expect(lateAtOf(settings, { at: at(22, 0), mode: 'vehicle' })).toBe(at(23, 0));
  });

  it('첫 매장 23:00: 22:00 차량 수거가 남아도 장부 · 수거 목록 · 확인 필요에 지연이 없고, 23:30부터 지연', () => {
    const state = first();
    const list = (now: number) => ledgerView(state, 'collection_list', { vehicleId: 'v1' }, ctx(now));
    // 22:00 반납 타임 묶음만 본다(견본 하루는 15:40의 모습이라 16:30 · 21:50 수거는 그대로 남아 늦음이다).
    const late = (now: number) => list(now).rows.filter((r) => r.groupKey === 's2200' && r.lateAt !== undefined && Date.parse(r.lateAt) <= now).map((r) => r.id);
    expect(list(at(23, 0)).rows.filter((r) => r.groupKey === 's2200').length).toBeGreaterThan(5);
    expect(late(at(23, 0))).toEqual([]);
    expect(runQuery(state, 'reviewList', {}, ctx(at(23, 0))).filter((x) => x.kindKey === 'late_return').map((x) => x.orderId)).not.toContain('o25');
    expect(late(at(23, 30))).toContain('collect:o25');
    expect(runQuery(state, 'reviewList', {}, ctx(at(23, 30))).filter((x) => x.kindKey === 'late_return').map((x) => x.orderId)).toContain('o25');
  });

  it('야간 수거 준비 안내: 알림 분(60분) 전 21:00부터 그 타임의 수거가 늦음이 되는 23:30 전까지', () => {
    const state = first();
    const prep = (now: number) => ledgerView(state, 'day_ledger', {}, ctx(now)).nightPrep;
    expect(prep(at(20, 59))).toBeUndefined();
    expect(prep(at(21, 0))).toMatchObject({ placeLabel: '설천 주차장' });
    expect(prep(at(22, 45))).toMatchObject({ placeLabel: '설천 주차장' });
    expect(prep(at(23, 30))).toBeUndefined();
    // 알림 분을 바꾼 매장(night_collection_notice_minutes 30)은 21:30부터.
    state.settings.nightNoticeMinutes = 30;
    expect(prep(at(21, 20))).toBeUndefined();
    expect(prep(at(21, 30))).toMatchObject({ placeLabel: '설천 주차장' });
  });
});

describe('차량 예비권(수량)보다 많이 건넨 끊긴 기사 기기의 리프트권 추가(답 14, sync 8-12)', () => {
  const addTicket = (state: ShopState, quantity: number, extra: Partial<AnyCommandEnvelope> = {}) => {
    const command: ConfirmCommand = {
      type: 'field.add_ticket',
      payload: { taskId: 'deliver:o26', orderId: 'o26', productKey: 'night_adult', quantity, assetIds: [], amount: 35_000 * quantity },
    };
    const env = { ...draftToEnvelope(openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, { expect: { quoteHash: 'ticket:night_adultx' + quantity + '=' + 35_000 * quantity + ':d0' } })), ...extra };
    return applyCommand(state, env as AnyCommandEnvelope, at(16, 58));
  };

  it('연결된 기기는 기록된 차량 재고(6매)까지만: 7매는 거절', () => {
    const state = first();
    expect(addTicket(state, 7).outcome).toBe('rejected');
    expect(state.vanSpares).toEqual([{ vehicleId: 'v1', productKey: 'night_adult', quantity: 6 }]);
  });

  it('보냄 대기로 온 7매는 적고(건넨 사실), 차량 예비권 기록이 −1이 되어 추가 판이 닫히고 확인 필요 한 줄', () => {
    const state = first();
    const result = addTicket(state, 7, { deviceSeq: 3 });
    expect(result.outcome).toBe('applied');
    expect(state.orders.find((o) => o.id === 'o26')!.lines.at(-1)).toMatchObject({ kind: 'night_adult', qty: 7, issued: 7, tracking: 'count' });
    expect(state.vanSpares).toEqual([{ vehicleId: 'v1', productKey: 'night_adult', quantity: -1 }]);
    expect(spareTickets(state, 'v1')).toEqual([]);
    const review = runQuery(state, 'reviewList', {}, ctx(at(17, 0))).filter((x) => x.kindKey === 'ticket_unavailable');
    expect(review.map((x) => x.message)).toEqual(['1호 차량 야간권 재고 기록 부족 1매 · 차량 재고 확인']);
  });

  it('그 차량에 그 권종의 예비권 행이 없으면 보냄 대기라도 적을 곳이 없어 거절(차량 재고 기록 없음)', () => {
    const state = first();
    state.vanSpares = [];
    expect(addTicket(state, 1, { deviceSeq: 4 }).outcome).toBe('rejected');
  });
});

describe('수량 칸(여러 줄의 지급 · 수거, 모두 수량인 첫 매장)', () => {
  it('수거 창: 줄마다 −/+ 칸(처음은 모두), 낮추면 `잔여 · …` 줄과 주 버튼 · 명령이 고른 수로', () => {
    const state = first();
    const all = runQuery(state, 'confirmDraft', { taskId: 'collect:o25', actionKey: 'stamp.collect' }, ctx(at(22, 40)));
    expect(all.counts?.map((c) => [c.label, c.quantity?.value, c.quantity?.max, c.quantity?.unit])).toEqual([['스키', 4, 4, '대'], ['헬멧', 2, 2, '개']]);
    expect(all.summary).toEqual(['스키 4 · 헬멧 2']);
    expect(all.confirmLabel).toBe('수거 처리 · 6개');
    const some = runQuery(state, 'confirmDraft', { taskId: 'collect:o25', actionKey: 'stamp.collect', picked: [{ lineId: 'o25-l2', quantity: 1 }] }, ctx(at(22, 40)));
    expect(some.summary).toEqual(['스키 4 · 헬멧 1', '잔여 · 헬멧 1']);
    expect(some.confirmLabel).toBe('수거 처리 · 5개');
    expect(some.command).toEqual({ type: 'stock.collect', payload: { taskId: 'collect:o25', lines: [{ lineId: 'o25-l1', quantity: 4 }, { lineId: 'o25-l2', quantity: 1 }] } });
    expect(some.counts?.find((c) => c.lineId === 'o25-l2')?.quantity?.value).toBe(1);
    // 한 줄을 0으로: 그 줄은 명령에서 빠지고 이름이 옅다(muted).
    const none = runQuery(state, 'confirmDraft', { taskId: 'collect:o25', actionKey: 'stamp.collect', picked: [{ lineId: 'o25-l2', quantity: 0 }] }, ctx(at(22, 40)));
    expect(none.command).toEqual({ type: 'stock.collect', payload: { taskId: 'collect:o25', lines: [{ lineId: 'o25-l1', quantity: 4 }] } });
    expect(none.counts?.find((c) => c.lineId === 'o25-l2')?.muted).toBe(true);
    // 범위 밖의 수는 잔여 안으로 줄인다.
    const over = runQuery(state, 'confirmDraft', { taskId: 'collect:o25', actionKey: 'stamp.collect', picked: [{ lineId: 'o25-l1', quantity: 9 }] }, ctx(at(22, 40)));
    expect(over.confirmLabel).toBe('수거 처리 · 6개');
  });

  it('권이 든 수거는 권 매수를 끝까지 센다: 권 줄을 0으로 낮추면 `잔여 · 야간권 성인 1매`(가게가 두고 오지 않게)', () => {
    const state = first();
    const view = runQuery(state, 'confirmDraft', { taskId: 'collect:o22', actionKey: 'stamp.collect', picked: [{ lineId: 'o22-l4', quantity: 2 }] }, ctx(at(16, 10)));
    // 박준호 팀은 아직 지급 전(16:00 수령)이라 수거할 것이 없다: 지급 뒤의 창을 본다.
    expect(view.notice ?? view.confirmLabel).toBeDefined();
    const issue = runQuery(state, 'confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' }, ctx(at(16, 5)));
    expect(issue.counts?.map((c) => c.label)).toEqual(['스키', '보드', '헬멧', '야간권 성인']);
    applyCommand(state, draftToEnvelope(openCommandDraft(issue.command!, { epoch: state.epoch, rev: state.rev })), at(16, 5));
    const collect = runQuery(state, 'confirmDraft', { taskId: 'collect:o22', actionKey: 'stamp.collect', picked: [{ lineId: 'o22-l4', quantity: 2 }] }, ctx(at(22, 40)));
    expect(collect.summary).toEqual(['스키 2 · 보드 1 · 헬멧 3 · 야간권 성인 2매', '잔여 · 야간권 성인 1매']);
    expect(collect.confirmLabel).toBe('수거 처리 · 6개 · 2매');
  });

  it('규격이 있는 줄의 요약은 규격 이름과 수 사이에 세는 말: `의류 95 2벌 · 의류 100 1벌`', () => {
    const state = first();
    const draft: OrderDraftInput = {
      channel: 'walk_in', leader: { name: '이민호', phone: '01000000042', party: 4 },
      items: [{ productKey: 'clothes', variantKey: '95', quantity: 2 }, { productKey: 'clothes', variantKey: '100', quantity: 1 }, { productKey: 'helmet', variantKey: '중', quantity: 1 }],
      pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' },
    };
    const plan = checkoutPlan(state, at(16, 26), draft, [{ sectionKey: 'gear', methodKey: 'card' }], null);
    const created = applyCommand(state, draftToEnvelope(openCommandDraft({ type: 'order.create', payload: { draft, choices: plan.choices, payerOrderId: null } }, { epoch: state.epoch, rev: state.rev }, { expect: { quoteHash: plan.hash } })), at(16, 26));
    expect(created.outcome).toBe('applied');
    const orderId = (created.result as { orderId: string }).orderId;
    const issue = runQuery(state, 'confirmDraft', { orderId, actionKey: 'stamp.issue' }, ctx(at(16, 27)));
    expect(issue.summary).toEqual(['의류 95 2벌 · 의류 100 1벌 · 헬멧 중 1개']);
    expect(issue.counts?.map((c) => [c.label, c.note])).toEqual([['의류', '사이즈 95'], ['의류', '사이즈 100'], ['헬멧', '중 사이즈']]);
  });
});

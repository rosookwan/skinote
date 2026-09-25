// 매장 목록(registry)이 모듈 상수가 아니라 상태에서 읽힌다(plan §3-1 Registry reads): 목록 값을 바꾸면 읽기 모델 · 명령이 그 값을 쓴다.
import { defaultUiConfig, draftToEnvelope, openCommandDraft, type UiConfig } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { applyCommand, kstAt, ledgerView, runQuery, sampleDay, type ShopState } from '../src/index.ts';

const NOW = kstAt('2026-12-26', 0, 15, 40);
const config: UiConfig = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
const ctx = { config, now: NOW };

function renamed(): ShopState {
  const state = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
  const reg = state.registry;
  state.registry = {
    ...reg,
    vehicles: reg.vehicles.map((v) => (v.id === 'v1' ? { ...v, label: '가 차량' } : v)),
    areas: reg.areas.map((a) => ({ ...a, places: a.places.map((p) => (p.id === 'seolcheon_parking' ? { ...p, label: '가 주차장' } : p)) })),
    products: { ...reg.products, ski: { ...reg.products.ski!, price: 41_000 } },
    payMethods: reg.payMethods.map((m) => (m.key === 'cash' ? { ...m, label: '현찰' } : m)),
    visitOutcomes: reg.visitOutcomes.map((v) => (v.key === 'customer_absent' ? { ...v, label: '손님 없음' } : v)),
    cashReasons: reg.cashReasons.map((r) => (r.key === 'unknown' ? { ...r, label: '모름' } : r)),
  };
  state.drawers = state.drawers.map((d) => (d.id === 'counter' ? { ...d, label: '가 돈통' } : d));
  return state;
}

describe('매장 목록 읽기', () => {
  it('차량 · 장소 이름: 수거 목록 제목 · 장부 반납 칸', () => {
    const state = renamed();
    const list = ledgerView(state, 'collection_list', { vehicleId: 'v1', deviceClass: 'driver_tablet' }, ctx);
    expect(list.vehicle?.label).toBe('가 차량');
    expect(JSON.stringify(list.rows)).toContain('가 주차장');
    const ledger = ledgerView(state, 'day_ledger', { deviceClass: 'pos' }, ctx);
    expect(JSON.stringify(ledger.rows.find((r) => r.orderId === 'o25'))).toContain('가 주차장');
  });

  it('상품 값: 새 접수 타일의 1일 값', () => {
    const view = runQuery(renamed(), 'orderDraft', {
      draft: { channel: 'walk_in', leader: { name: '', phone: '', party: 0 }, items: [], pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' } },
    }, ctx);
    expect(view.tiles[0]).toMatchObject({ label: '스키', secondLine: '1일 41,000원' });
  });

  it('결제 수단 이름: 기사 현장 수납 판 · 접수증 수납 줄 · 수납 창', () => {
    const state = renamed();
    const view = runQuery(state, 'fieldPaySheet', { taskId: 'collect:o25' }, ctx);
    expect(view.methods.map((m) => m.label)).toEqual(['카드', '현찰', '계좌이체']);
    // 최은정 팀(0024)은 현금으로 냈다.
    expect(runQuery(state, 'orderSlip', { orderId: 'o24' }, ctx).money.payments.map((p) => p.methodLabel)).toEqual(['현찰']);
    expect(runQuery(state, 'confirmDraft', { orderId: 'o27', actionKey: 'pay' }, ctx).methods?.map((m) => m.label)).toEqual(['카드', '현찰', '계좌이체']);
  });

  it('방문 결과 이름: 수거 실패 뒤 확인 필요 줄', () => {
    const state = renamed();
    const envelope = draftToEnvelope(openCommandDraft({ type: 'task.visit', payload: { taskId: 'collect:o25', outcomeKey: 'customer_absent' } }, { epoch: 'e', rev: state.rev }));
    expect(applyCommand(state, envelope, NOW).outcome).toBe('applied');
    const review = runQuery(state, 'reviewList', {}, ctx);
    expect(review.find((r) => r.kindKey === 'visit_result')?.message).toContain('손님 없음');
  });

  it('차액 사유 · 돈통 이름: 마감의 돈통 점검 판', () => {
    const sheet = runQuery(renamed(), 'closingSheet', { check: { key: 'counter', countedAmount: 1 } }, ctx);
    expect(sheet.check?.title).toBe('가 돈통');
    expect(sheet.check?.reasons.map((r) => r.label)).toEqual(['잔돈 착오', '모름', '직접 입력']);
    expect(sheet.cash.find((c) => c.key === 'counter')?.label).toBe('가 돈통');
  });

  it('매장 목록에 없는 결제 수단 · 방문 결과는 거절한다', () => {
    const state = renamed();
    state.registry = { ...state.registry, visitOutcomes: state.registry.visitOutcomes.filter((v) => v.key !== 'other') };
    const visit = draftToEnvelope(openCommandDraft({ type: 'task.visit', payload: { taskId: 'collect:o25', outcomeKey: 'other' } }, { epoch: 'e', rev: state.rev }));
    expect(applyCommand(state, visit, NOW)).toMatchObject({ outcome: 'rejected', error: { message: '등록되지 않은 사유' } });
  });
});

describe('읽기 모델 묻기(ledgerView · runQuery)', () => {
  it('모르는 화면 · 조회는 UNKNOWN_VIEW, 없는 접수는 NOT_FOUND', () => {
    const state = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
    expect(() => ledgerView(state, 'nothing', {}, ctx)).toThrow(expect.objectContaining({ code: 'UNKNOWN_VIEW' }));
    expect(() => runQuery(state, 'nothing' as never, {} as never, ctx)).toThrow(expect.objectContaining({ code: 'UNKNOWN_VIEW' }));
    expect(() => runQuery(state, 'orderSlip', { orderId: 'o99' }, ctx)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('장부는 견본 하루의 18팀, 접수증은 그 팀', () => {
    const state = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
    expect(ledgerView(state, 'day_ledger', {}, ctx).rows).toHaveLength(18);
    expect(runQuery(state, 'orderSlip', { orderId: 'o22' }, ctx)).toMatchObject({ receiptNo: '261226-017', teamName: '박준호' });
  });
});

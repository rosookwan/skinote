// 번호 · 권 보증금 규칙은 매장이 켜면 계속 돈다(2026-09-26 첫 매장 답 뒤의 지킴 시험). 첫 매장(견본 기본)은 번호 · 보증금이 없지만, 규칙과
// 화면 자리는 다른 매장을 위해 그대로다(README D7 · ADR-18). 여기서는 도메인만으로(읽기 모델 + 명령) 두 길을 본다:
//   - 번호 · 보증금을 켠 견본 매장(sampleDay shop 'numbered'): 준비 번호 지급 → 이어진 보증금 입금, 번호 반납 → 보증금 반환, 차량 예비권 번호로
//     리프트권 추가 + 보증금, 마감의 보증금 보관.
//   - 첫 매장이 나중에 켤 때: 운영 규칙 `리프트권 보증금 · 사용`(setting.set) 뒤의 새 접수, 상품의 재고 방식을 번호로 바꾼 뒤의 지급 · 반납.
import { defaultUiConfig, draftToEnvelope, openCommandDraft, type ConfirmCommand, type Expect, type OrderDraftInput, type UiConfig } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import {
  applyCommand, checkoutPlan, depositOf, heldAmount, heldNumbers, heldUnits, kstAt, ruleKeys, runQuery, spareTickets, type ShopState,
} from '../src/index.ts';
import { sampleDay } from '../src/sample/index.ts';

const at = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const config: UiConfig = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
const ctx = (now: number) => ({ config, now });
const text = (runs: readonly { text: string }[] | undefined) => (runs ?? []).map((r) => r.text).join('');

function send(state: ShopState, command: ConfirmCommand, now: number, extra: { expect?: Expect; dependsOn?: string[] } = {}) {
  return applyCommand(state, draftToEnvelope(openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, extra)), now);
}

const line = (state: ShopState, id: string) => state.orders.flatMap((o) => o.lines).find((l) => l.id === id)!;

describe('번호 · 권 보증금을 켠 매장(견본 shop numbered)', () => {
  it('지급: 준비 번호(스키 17 · 18번 …)로 지급하고, 지급 창이 권 3매 보증금 15,000원을 이어서 받는다', () => {
    const state = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo', shop: 'numbered' });
    const view = runQuery(state, 'confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' }, ctx(at(16, 5)));
    expect(view.confirmLabel).toBe('지급 처리 · 6개 · 3매 · 보증금 15,000원');
    expect(send(state, view.command!, at(16, 5)).outcome).toBe('applied');
    expect(line(state, 'o22-l1').assetIds).toEqual(['ski-17', 'ski-18']);
    expect(line(state, 'o22-l4').assetIds).toEqual(['night_adult-31', 'night_adult-32', 'night_adult-33']);
    const step = view.then![0]!;
    expect(send(state, step.command, at(16, 5), { expect: step.expect! }).outcome).toBe('applied');
    expect(heldAmount(depositOf(state, 'o22', 'lift_ticket_card'))).toBe(15_000);
  });

  it('반납: 번호 버튼(가진 번호 모두 골라 둠), 두 번호를 빼면 권 2매 보증금 10,000원 반환 · 번호로 반납', () => {
    const state = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo', shop: 'numbered' });
    const issue = runQuery(state, 'confirmDraft', { orderId: 'o22', actionKey: 'stamp.issue' }, ctx(at(16, 5)));
    send(state, issue.command!, at(16, 5));
    send(state, issue.then![0]!.command, at(16, 5), { expect: issue.then![0]!.expect! });
    const opened = runQuery(state, 'returnSheet', { orderId: 'o22' }, ctx(at(21, 30)));
    expect(opened.lead).toEqual([{ text: '전체 선택 · 미반납 번호 해제' }]);
    expect(opened.lines.map((l) => [l.label, l.mode, (l.pieces ?? []).length])).toEqual([['스키', 'unit', 2], ['보드', 'unit', 1], ['헬멧', 'unit', 3], ['야간권 성인', 'unit', 3]]);
    const view = runQuery(state, 'returnSheet', {
      orderId: 'o22',
      picked: [
        { lineId: 'o22-l1', quantity: 2, assetIds: ['ski-17', 'ski-18'] }, { lineId: 'o22-l4', quantity: 2, assetIds: ['night_adult-31', 'night_adult-32'] },
      ],
    }, ctx(at(21, 30)));
    expect(text(view.deposit)).toBe('권 2매 보증금 10,000원 반환 · 매장 기준 1매 5,000원 · 잔여 보증금 5,000원(권 1매)');
    expect(view.primary.label).toBe('반납 처리 · 스키 2 · 권 2매 · 보증금 10,000원');
    expect(send(state, view.command!, at(21, 31)).outcome).toBe('applied');
    expect(send(state, view.then![0]!.command, at(21, 31), { expect: view.then![0]!.expect! }).outcome).toBe('applied');
    expect(heldNumbers(line(state, 'o22-l4'))).toEqual(['night_adult-33']);
    const dep = depositOf(state, 'o22', 'lift_ticket_card')!;
    expect([heldAmount(dep), heldUnits(dep, 'o22-l4')]).toEqual([5_000, 1]);
  });

  it('리프트권 추가: 차량 예비권 번호(51번)와 보증금 5,000원(차량 지갑), 마감 이월에 보증금 보관 중', () => {
    const state = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo', shop: 'numbered' });
    send(state, { type: 'stock.load', payload: { taskId: 'deliver:o26', lines: [{ lineId: 'o26-l1', quantity: 3 }, { lineId: 'o26-l2', quantity: 3 }] } }, at(16, 40));
    const sheet = runQuery(state, 'addTicketSheet', { taskId: 'deliver:o26' }, ctx(at(16, 58)));
    expect(sheet.primary.label).toBe('리프트권 추가 · 1매 · 보증금 5,000원');
    expect(sheet.command).toMatchObject({ payload: { assetIds: ['night_adult-51'], deposit: { ruleKey: 'lift_ticket_card', amount: 5_000 } } });
    expect(send(state, sheet.command!, at(16, 58), { expect: sheet.expect! }).outcome).toBe('applied');
    expect(spareTickets(state, 'v1')[0]).toMatchObject({ productKey: 'night_adult', quantity: 5 });
    expect(depositOf(state, 'o26', 'lift_ticket_card')?.entries[0]).toMatchObject({ kind: 'take', amount: 5_000, drawerId: 'van:v1', assetIds: ['night_adult-51'] });
    const closing = runQuery(state, 'closingSheet', {}, ctx(at(0, 40, 1)));
    expect(closing.carry.map((c) => text(c.title))).toContain('보증금 보관 중 · 리프트권 1매 · 5,000원');
  });
});

describe('첫 매장이 나중에 켤 때', () => {
  const MINHO: OrderDraftInput = {
    channel: 'walk_in', leader: { name: '이민호', phone: '01000000042', party: 1 }, items: [{ productKey: 'night_adult', quantity: 2 }],
    pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' },
  };

  it('운영 규칙 `리프트권 보증금 · 사용`을 저장하면 새 접수의 확정 창에 보증금 칸(1매 5,000원 · 현금)이 생기고 접수가 보증금을 맡는다', () => {
    const state = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
    const now = at(16, 0);
    expect(checkoutPlan(structuredClone(state), now, MINHO, [], null).quote.deposit).toBe(0);
    const keys = ruleKeys(state.registry, state.settings);
    expect(send(state, { type: 'setting.set', payload: { changes: [{ key: keys.depositOn, value: 1 }] } }, now).outcome).toBe('applied');
    expect(state.settings.liftDeposit).toMatchObject({ unitAmount: 5_000, methods: ['cash'] });
    const sheet = runQuery(state, 'checkoutSheet', { draft: MINHO }, ctx(now));
    expect(sheet.sections.map((s) => s.key)).toEqual(['lift', 'lift_ticket_card']);
    expect(send(state, sheet.command!, now, { expect: sheet.expect! }).outcome).toBe('applied');
    const created = state.orders.at(-1)!;
    expect(heldAmount(depositOf(state, created.id, 'lift_ticket_card'))).toBe(10_000);
  });

  it('상품의 재고 방식을 번호로 바꾸고 번호 실물을 두면(스키 1 ~ 3번) 새 접수의 지급 · 반납이 번호로 된다(지난 줄은 수량 그대로)', () => {
    const state = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
    state.registry = { ...state.registry, products: { ...state.registry.products, ski: { ...state.registry.products.ski!, tracking: 'unit' } } };
    state.assets = ['1', '2', '3'].map((no) => ({ id: 'ski-' + no, kind: 'ski', no }));
    const now = at(16, 0);
    const draft: OrderDraftInput = { ...MINHO, items: [{ productKey: 'ski', quantity: 2 }] };
    const sheet = runQuery(state, 'checkoutSheet', { draft }, ctx(now));
    expect(send(state, sheet.command!, now, { expect: sheet.expect! }).outcome).toBe('applied');
    const created = state.orders.at(-1)!;
    expect(created.lines[0]).toMatchObject({ tracking: 'unit' });
    const issue = runQuery(state, 'confirmDraft', { orderId: created.id, actionKey: 'stamp.issue' }, ctx(now));
    expect(send(state, issue.command!, now).outcome).toBe('applied');
    expect(created.lines[0]!.assetIds).toEqual(['ski-1', 'ski-2']);
    const back = runQuery(state, 'returnSheet', { orderId: created.id }, ctx(now));
    expect(back.lines[0]).toMatchObject({ mode: 'unit', pieces: [{ label: '1번', picked: true }, { label: '2번', picked: true }] });
    // 번호를 켜기 전에 만든 줄(김민재 팀 스키)은 수량 줄 그대로다.
    expect(line(state, 'o21-l1')).toMatchObject({ tracking: 'count' });
    expect(line(state, 'o21-l1').assetIds).toBeUndefined();
  });
});

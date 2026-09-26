// 둘째 판 화면의 바탕(work/impl-v2/plan.md 0단계): 체험 자료 판 3(운영 규칙 · 번호 · 돈통), 영업일 기준 시각, 뒷이야기 사건,
// 조회 · 명령의 자리(9단계까지 모두 채웠다). 단계마다 이 파일이 아니라 자기 시험 파일(v2-<화면>.test.ts)을 더한다.
import { DomainError, draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type ConfirmCommand } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { assetId, businessDateOf, kstAt } from '@skinote/domain';
import { DRAWERS, NUMBERED_SHOP_RULES, SHOP_RULES } from '@skinote/domain/sample';
import { applyCommand, createSeed } from '../src/fixture/demo.ts';
import { FixtureClient, type FixtureStorage } from '../src/fixture/fixture-client.ts';
import { applyStory, type FxStoryEvent, storyRequestId } from '../src/fixture/story.ts';

class MemoryStorage implements FixtureStorage {
  readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

const at = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);

describe('영업일 기준 시각(data-model 3-3)', () => {
  it('06:00보다 이른 기록은 전날 영업일: 27일 00:15 반납 · 00:40 마감은 26일', () => {
    expect(businessDateOf(at(0, 15, 1), '06:00')).toBe('2026-12-26');
    expect(businessDateOf(at(0, 40, 1), '06:00')).toBe('2026-12-26');
    expect(businessDateOf(at(5, 59, 1), '06:00')).toBe('2026-12-26');
    expect(businessDateOf(at(6, 0, 1), '06:00')).toBe('2026-12-27');
    expect(businessDateOf(at(7, 0, 1), '06:00')).toBe('2026-12-27');
    expect(businessDateOf(at(0, 15, 1), '00:00')).toBe('2026-12-27');
    expect(businessDateOf(at(15, 40), '06:00')).toBe('2026-12-26');
  });
});

describe('체험 자료 판 3', () => {
  it('첫 매장의 운영 규칙(2026-09-26): 리프트권 반납 필수 · 권 보증금 없음 · 당일 취소 환불 · 06:00 · 시재 100,000원', () => {
    const state = createSeed('e');
    expect(state.version).toBe(3);
    expect(state.settings).toEqual(SHOP_RULES);
    expect(state.settings.liftReturnPolicy).toBe('required');
    // 권 카드의 1,000원은 리조트와 가게 사이의 돈이라 손님과 주고받지 않는다: 보증금 규칙이 없다.
    expect(state.settings.liftDeposit).toBeNull();
    expect(state.settings.sameDayCancelRefund).toBe('refund');
    expect(state.settings.businessDayCutoff).toBe('06:00');
    expect(state.settings.openingCash).toBe(100_000);
    expect(state.settings.returnSlots.map((s) => s.label + ' ' + String(s.hour).padStart(2, '0') + ':' + String(s.minute).padStart(2, '0')))
      .toEqual(['오전타임 후 12:00', '오후 16:30', '야간 22:00', '심야 24:00']);
    expect(state.drawers.map((d) => d.id)).toEqual(DRAWERS.map((d) => d.id));
    expect(state.deposits).toEqual([]);
    expect(state.nextReceiptSeq).toBe(19);
    expect(state.storyApplied).toEqual([]);
  });

  it('첫 매장은 번호가 없다: 모든 줄이 수량, 번호 실물 없음, 1호 차량 예비권은 야간권 6매(수량)', () => {
    const state = createSeed('e');
    const lines = state.orders.flatMap((o) => o.lines);
    expect(lines.every((l) => l.tracking === 'count')).toBe(true);
    expect(lines.some((l) => l.assetIds || l.plannedAssetIds || l.backAssetIds)).toBe(false);
    expect(state.assets).toEqual([]);
    expect(state.vanSpares).toEqual([{ vehicleId: 'v1', productKey: 'night_adult', quantity: 6 }]);
  });

  it('번호 매장(numbered)의 운영 규칙과 번호: 보증금 1매 5,000원 현금 · 접수 시 · 몰수(1일), 박준호 팀의 준비 번호는 시안 V1, 지급한 줄은 겹치지 않는 번호', () => {
    const state = createSeed('e', 'numbered');
    expect(state.settings).toEqual(NUMBERED_SHOP_RULES);
    expect(state.settings.liftDeposit).toMatchObject({ unitAmount: 5_000, timing: 'at_intake', refundDefault: 'cash', unreturned: 'keep', afterDays: 1, methods: ['cash'] });
    const park = state.orders.find((o) => o.id === 'o22')!;
    expect(park.lines.map((l) => l.plannedAssetIds)).toEqual([
      ['ski-17', 'ski-18'], ['board-5'], ['helmet-12', 'helmet-14', 'helmet-15'], ['night_adult-31', 'night_adult-32', 'night_adult-33'],
    ]);
    const issued = state.orders.flatMap((o) => o.lines).filter((l) => l.issued > 0);
    for (const l of issued) expect(l.assetIds).toHaveLength(l.issued);
    const held = issued.flatMap((l) => l.assetIds ?? []);
    expect(new Set(held).size).toBe(held.length);
    const planned = new Set(park.lines.flatMap((l) => l.plannedAssetIds ?? []));
    expect(held.filter((id) => planned.has(id))).toEqual([]);
    const known = new Set(state.assets.map((a) => a.id));
    for (const id of [...held, ...planned]) expect(known.has(id)).toBe(true);
    // 반납이 끝난 줄(최은정)은 돌아온 번호도 같다.
    const done = state.orders.find((o) => o.id === 'o24')!.lines[0]!;
    expect(done.backAssetIds).toEqual(done.assetIds);
    // 1호 차량 예비권 야간권 6매(시안 V7).
    expect(state.assets.filter((a) => a.vehicleId === 'v1').map((a) => a.id)).toEqual(['51', '52', '53', '54', '55', '56'].map((no) => assetId('night_adult', no)));
  });

  it('현금 수납은 카운터 돈통에 들어간다(마감의 돈통 예상이 읽는 곳)', () => {
    const state = createSeed('e');
    const cash = state.orders.flatMap((o) => o.payments).filter((p) => p.methodKey === 'cash');
    expect(cash.map((p) => p.amount).reduce((a, b) => a + b, 0)).toBe(200_000);
    for (const p of cash) expect(p.drawerId).toBe('counter');
    for (const p of state.orders.flatMap((o) => o.payments).filter((x) => x.methodKey !== 'cash')) expect(p.drawerId).toBeUndefined();
  });

  it('옛 판(2)으로 저장된 체험 자료는 버리고 판 3으로 시작한다', async () => {
    const storage = new MemoryStorage();
    storage.setItem('skinote.demo.v1', JSON.stringify({ version: 2, state: { ...createSeed('old'), version: 2 }, clock: 0 }));
    const client = new FixtureClient({ storage, realNow: () => 1_800_000_000_000 });
    const ledger = await client.ledgerView('day_ledger', {});
    expect(ledger.basis.epoch).not.toBe('old');
    expect(JSON.parse(storage.getItem('skinote.demo.v1') ?? '{}').version).toBe(3);
  });

  it('옛 견본(번호 · 보증금)으로 저장한 판 3 자료도 버리고 첫 매장 견본으로 시작한다(견본 판 표시가 다름)', async () => {
    const storage = new MemoryStorage();
    storage.setItem('skinote.demo.v1', JSON.stringify({ version: 3, state: createSeed('old', 'numbered'), clock: at(18, 0) }));
    const client = new FixtureClient({ storage, realNow: () => 1_800_000_000_000 });
    expect((await client.ledgerView('day_ledger', {})).basis.epoch).not.toBe('old');
    const saved = JSON.parse(storage.getItem('skinote.demo.v1') ?? '{}') as { sample: string; state: { assets: unknown[] } };
    expect(saved.sample).toMatch(/:first$/);
    expect(saved.state.assets).toEqual([]);
    // 같은 견본으로 저장한 자료는 그대로 이어 간다.
    const again = new FixtureClient({ storage, realNow: () => 1_800_000_000_000 });
    expect((await again.ledgerView('day_ledger', {})).basis.epoch).toBe((await client.ledgerView('day_ledger', {})).basis.epoch);
  });
});

describe('뒷이야기(story.ts)', () => {
  const issue = (eventId: string, basis: { epoch: string; rev: number }): AnyCommandEnvelope => {
    const command: ConfirmCommand = { type: 'stock.issue', payload: { orderId: 'o32', lines: [{ lineId: 'o32-l1', quantity: 2 }] } };
    return draftToEnvelope(openCommandDraft(command, basis, { requestId: storyRequestId(eventId) }));
  };
  const events: FxStoryEvent[] = [
    { id: 'jungho-pickup', at: at(16, 20), note: '이정호 팀 수령(스키 2)', commands: (s) => [issue('jungho-pickup', { epoch: s.epoch, rev: s.rev })] },
    { id: 'later', at: at(19, 40), note: '뒤의 사건', commands: () => [] },
  ];

  it('시각이 지난 사건만 그 시각으로 한 번 적는다(두 번 돌려도 같은 결과)', () => {
    const state = createSeed('e');
    expect(applyStory(state, at(16, 19), applyCommand, events)).toEqual([]);
    expect(applyStory(state, at(16, 30), applyCommand, events)).toEqual(['jungho-pickup']);
    const ski = state.orders.find((o) => o.id === 'o32')!.lines[0]!;
    expect(ski.issued).toBe(2);
    expect(ski.issuedAt).toBe(at(16, 20));
    const rev = state.rev;
    expect(applyStory(state, at(17, 0), applyCommand, events)).toEqual([]);
    expect(state.rev).toBe(rev);
    expect(applyStory(state, at(20, 0), applyCommand, events)).toEqual(['later']);
    expect(state.storyApplied).toEqual(['jungho-pickup', 'later']);
  });

  it('사람이 먼저 한 일은 건너뛴다(사건은 끝난 것으로 적고 다시 하지 않는다)', () => {
    const state = createSeed('e');
    applyCommand(state, issue('by-hand', { epoch: state.epoch, rev: state.rev }), at(16, 5));
    applyStory(state, at(16, 30), applyCommand, events);
    const ski = state.orders.find((o) => o.id === 'o32')!.lines[0]!;
    expect(ski.issued).toBe(2);
    expect(ski.issuedAt).toBe(at(16, 5));
    expect(state.storyApplied).toContain('jungho-pickup');
  });
});

describe('둘째 판 조회 · 명령(9단계까지 모두 채움)', () => {
  it('체험 자료에 없는 조회는 UNKNOWN_VIEW로 거절한다(운영 규칙 shopRules는 9단계가 채웠다, v2-settings.test.ts)', async () => {
    const client = new FixtureClient({ realNow: () => 1_800_000_000_000 });
    await expect(client.query('shopRules', {})).resolves.toMatchObject({ footer: '변경 없음' });
    const unknown = client.query as unknown as (name: string, params: object) => Promise<unknown>;
    await expect(unknown.call(client, 'nothing', {})).rejects.toBeInstanceOf(DomainError);
    await expect(unknown.call(client, 'nothing', {})).rejects.toMatchObject({ code: 'UNKNOWN_VIEW' });
  });

  it('돈 명령은 돈의 바탕(expect)을 먼저 본다. 운영 규칙 저장(setting.set)은 바꾼 곳이 없으면 할 것이 없다', async () => {
    const client = new FixtureClient({ realNow: () => 1_800_000_000_000 });
    const basis = (await client.ledgerView('day_ledger', {})).basis;
    const send = (command: ConfirmCommand, expect?: Parameters<typeof openCommandDraft>[2]) => client.command(draftToEnvelope(openCommandDraft(command, basis, expect)));
    const check: ConfirmCommand = { type: 'cash.transfer_confirm', payload: { transferId: 't1', countedAmount: 35_000 } };
    expect(await send(check, { expect: { dueAmount: 35_000 } })).toMatchObject({ outcome: 'rejected', error: { code: 'EXPECT_REQUIRED' } });
    const rules: ConfirmCommand = { type: 'setting.set', payload: { changes: [] } };
    expect(await send(rules)).toMatchObject({ outcome: 'superseded', error: { message: '변경 없음' } });
  });
});

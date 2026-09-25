// 둘째 판 9단계(work/impl-v2/plan.md 5절 Step 9): V8 관리 · 매장 설정 · 운영 규칙(spec 3-9, ui 6-9, catalog 2 · 3 · 11-1, data-model 3-3 · 4-4).
// 읽기 모델(shopRules: 카드 · 바뀐 곳 · 바닥줄 · 주 버튼 · 저장 명령 · 거절 까닭), 저장(setting.set: 다음 기록부터, 기준 시각은 옛 기준과 새 기준
// 사이에 거절, 보증금 미사용이어도 맡은 보증금은 반환), 화면의 초안 도우미(settings-draft.ts)와 카드 쪽 나누기(rulesLayout · saveRowsPerPage).
import { readFileSync } from 'node:fs';
import { envelopeFor, parseRuleKey, type ConfirmCommand, type RuleChange, type ShopRulesView } from '@skinote/contract';
import { fitList } from '@skinote/layout';
import { DEVICE_PROFILES, openOrRestoreDraft } from '@skinote/ui';
import { describe, expect, it } from 'vitest';
import { inputAccepts, optionPress, padValue, withChange } from '../src/app/settings-draft.ts';
import { businessDateOf, type FxState, heldRule, kstAt, liftReturnable, ruleKeys, shopCutoff } from '@skinote/domain';
import { SHOP_RULES, sampleRegistry } from '@skinote/domain/sample';
import { FixtureClient } from '../src/fixture/fixture-client.ts';
import { rulesLayout, saveRowsPerPage, settingsTabs } from '../src/screens/ShopSettingsScreen.tsx';

const ms = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);

/** 15:40에서 minutes만큼(27일 00:40 = 540분). 카운터 기기. */
function at(minutes = 0, story = true) {
  const client = new FixtureClient({ realNow: () => 1_800_000_000_000, story });
  if (minutes) client.advanceClock(minutes);
  const state = () => (client as unknown as { state: FxState }).state;
  return { client, state };
}

const K = {
  returnPolicy: 'item_kinds:lift:return_policy_key',
  depositOn: 'deposit_rules:lift_ticket_card:active',
  depositAmount: 'deposit_rules:lift_ticket_card:unit_amount',
  timing: 'deposit_rules:lift_ticket_card:timing_key',
  unreturned: 'deposit_rules:lift_ticket_card:unreturned_key',
  lossAmount: 'deposit_rules:lift_ticket_card:loss_amount',
  prepay: 'shop_settings:prepayment_mode:mode',
  prepayAmount: 'shop_settings:prepayment_mode:amount',
  refund: 'shop_settings:same_day_cancel_refund_default:decision',
  cutoff: 'shops::business_day_cutoff',
};

const text = (runs: readonly { text: string }[]) => runs.map((r) => r.text).join('');
const card = (view: ShopRulesView, title: string) => view.cards.find((c) => c.title === title)!;
const picked = (view: ShopRulesView, title: string) => card(view, title).rows.map((r) => [r.label ?? '', r.options.filter((o) => o.selected).map((o) => o.label).join(), r.value?.label ?? '']);

/** 화면과 같은 길: 저장 확인 창을 연 때의 초안(요청번호 · basis) + 서버가 지금 써 준 명령. */
async function save(client: FixtureClient, view: ShopRulesView) {
  if (!view.command) throw new Error('보낼 명령이 없다');
  const draft = openOrRestoreDraft(null, { type: 'setting.set', payload: { changes: [] } } as ConfirmCommand, view.basis, {});
  const envelope = envelopeFor(draft, view.command, undefined);
  if (!envelope) throw new Error('봉투가 없다');
  return client.command(envelope);
}

const THREE: RuleChange[] = [
  { key: K.returnPolicy, value: 'optional' },
  { key: K.timing, value: 'at_issue' },
  { key: K.cutoff, value: '03:00' },
];

describe('V8 읽기 모델(shopRules) — 이 매장의 저장된 값(catalog 3 · spec 2-3)', () => {
  it('카드 다섯 장(행에서): 리프트권 반납 · 리프트권 보증금 · 리프트권 결제 · 전화 예약 · 당일 취소 환불(한 줄) · 영업일 기준 시각, 변경 없음', async () => {
    const { client } = at();
    const view = await client.query('shopRules', {});
    expect(view.cards.map((c) => [c.title, c.inline, c.changed])).toEqual([
      ['리프트권 반납', false, false],
      ['리프트권 보증금', false, false],
      ['리프트권 결제 · 전화 예약', false, false],
      ['당일 취소 환불', true, false],
      ['영업일 기준 시각', false, false],
    ]);
    expect(picked(view, '리프트권 반납')).toEqual([['', '반납 필수', '']]);
    expect(card(view, '리프트권 반납').rows[0]!.options.map((o) => o.label)).toEqual(['반납 필수', '반납 선택 · 반납 시 기록']);
    expect(card(view, '리프트권 반납').notes.map(text)).toEqual(['반납 필수 · 리프트권 반납 후 완료']);
    expect(picked(view, '리프트권 보증금')).toEqual([['보증금', '사용', '1매 5,000원'], ['입금 시점', '접수 시', ''], ['미반납 시', '보증금 몰수', '']]);
    const timing = card(view, '리프트권 보증금').rows[1]!.options[0]!;
    expect([timing.label, timing.secondLine]).toEqual(['접수 시', '미입금: 지급 시']);
    const loss = card(view, '리프트권 보증금').rows[2]!.options[1]!;
    expect([loss.label, loss.secondLine, loss.short]).toEqual(['분실금 청구', '보증금 공제', '차액 청구']);
    expect(picked(view, '리프트권 결제 · 전화 예약')).toEqual([['', '선입금 전액', '']]);
    expect(picked(view, '당일 취소 환불')).toEqual([['', '환불', '']]);
    expect(card(view, '영업일 기준 시각').rows[0]!.options.map((o) => [o.label, o.selected])).toEqual([['00:00', false], ['03:00', false], ['06:00', true], ['직접 입력', false]]);
    expect(card(view, '영업일 기준 시각').notes.map(text)).toEqual(['27일 00:15 반납 → 26일 장부', '27일 07:00 반납 → 27일 장부', '마감 후 기록 · 다음 마감 반영']);
    expect(view.footer).toBe('변경 없음');
    expect(view.primary).toEqual({ label: '저장', alts: ['저장'], enabled: false });
    expect(view.command).toBeUndefined();
    expect(view.changes).toEqual([]);
    expect(view.saveTitle).toBeUndefined();
  });

  it('세 곳을 바꾸면(반납 선택 · 지급 시 · 03:00) `변경 3건 · 다음 기록부터 적용` · `저장 · 3건`, 바뀐 카드에 `변경됨`, 전 → 후 목록 · 명령', async () => {
    const { client } = at();
    const view = await client.query('shopRules', { changes: THREE });
    expect(view.cards.map((c) => [c.title, c.changed])).toEqual([
      ['리프트권 반납', true], ['리프트권 보증금', true], ['리프트권 결제 · 전화 예약', false], ['당일 취소 환불', false], ['영업일 기준 시각', true],
    ]);
    expect(view.footer).toBe('변경 3건 · 다음 기록부터 적용');
    expect(view.primary).toEqual({ label: '저장 · 3건', alts: ['저장 · 3건', '저장'], enabled: true });
    expect(view.saveTitle).toBe('변경 3건');
    expect(view.unsavedTitle).toBe('미저장 변경 3건');
    expect(view.changes.map((c) => [c.label, c.before, c.after])).toEqual([
      ['리프트권 반납', '반납 필수', '반납 선택 · 반납 시 기록'],
      ['리프트권 보증금 · 입금 시점', '접수 시 · 미입금: 지급 시', '지급 시'],
      ['영업일 기준 시각', '06:00', '03:00'],
    ]);
    expect(view.command).toEqual({ type: 'setting.set', payload: { changes: [
      { key: K.returnPolicy, value: 'optional' }, { key: K.timing, value: 'at_issue' }, { key: K.cutoff, value: '03:00' },
    ] } });
    expect(card(view, '영업일 기준 시각').notes.map(text)).toEqual(['27일 00:15 반납 → 26일 장부', '27일 07:00 반납 → 27일 장부', '마감 후 기록 · 다음 마감 반영']);
    expect(view.rejection).toBeUndefined();
  });

  it('저장된 값으로 되돌리면 바뀐 곳이 아니다(같은 곳은 마지막 누름)', async () => {
    const { client } = at();
    const changes = withChange(withChange([], { key: K.returnPolicy, value: 'optional' }), { key: K.returnPolicy, value: 'required' });
    expect(changes).toEqual([{ key: K.returnPolicy, value: 'required' }]);
    const view = await client.query('shopRules', { changes });
    expect(view.footer).toBe('변경 없음');
    expect(card(view, '리프트권 반납').changed).toBe(false);
  });

  it('보증금 미사용: 입금 시점 · 미반납 시 줄과 값 버튼이 사라지고 회색 한 줄 `보증금 미사용`, 숨은 줄의 바꿈은 세지 않는다', async () => {
    const { client } = at();
    const view = await client.query('shopRules', { changes: [{ key: K.timing, value: 'at_issue' }, { key: K.depositOn, value: 0 }] });
    const deposit = card(view, '리프트권 보증금');
    expect(picked(view, '리프트권 보증금')).toEqual([['보증금', '미사용', '']]);
    expect(deposit.notes.map(text)).toEqual(['보증금 미사용']);
    expect(view.changes.map((c) => [c.label, c.before, c.after])).toEqual([['리프트권 보증금', '사용', '미사용']]);
    expect(view.command?.payload).toEqual({ changes: [{ key: K.depositOn, value: 0 }] });
  });

  it('분실금 청구면 이름표 줄 `분실금 청구` · 값 버튼 `1매 35,000원 ›`, 예약금이면 이름표 줄 `예약금` · `팀당 50,000원 ›`, 금액은 숫자판(범위는 읽기 모델)', async () => {
    const { client } = at();
    const view = await client.query('shopRules', { changes: [{ key: K.unreturned, value: 'charge_loss' }, { key: K.prepay, value: 'fixed_amount' }, { key: K.lossAmount, value: 40_000 }] });
    expect(picked(view, '리프트권 보증금')).toEqual([['보증금', '사용', '1매 5,000원'], ['입금 시점', '접수 시', ''], ['미반납 시', '분실금 청구', ''], ['분실금 청구', '', '1매 40,000원']]);
    const row = card(view, '리프트권 보증금').rows[3]!;
    expect(row.value?.label).toBe('1매 40,000원');
    expect(row.value?.input).toMatchObject({ key: K.lossAmount, mode: 'amount', title: '분실금 청구 · 1매 40,000원' });
    const prepay = card(view, '리프트권 결제 · 전화 예약').rows;
    expect(prepay.map((r) => [r.label ?? '', r.options.length, r.value?.label ?? ''])).toEqual([['', 3, ''], ['예약금', 0, '팀당 50,000원']]);
    expect(view.changes.map((c) => [c.label, c.before, c.after])).toEqual([
      ['리프트권 보증금 · 미반납 시', '보증금 몰수', '분실금 청구(보증금 공제)'],
      ['리프트권 보증금 · 미반납 시', '1매 35,000원', '1매 40,000원'],
      ['리프트권 결제 · 전화 예약', '선입금 전액', '예약금'],
    ]);
  });

  it('영업일 기준 시각 `직접 입력`: 시각 숫자판(00:00 ~ 11:59), 고르면 두 줄 버튼과 예시가 그 기준으로', async () => {
    const { client } = at();
    const first = await client.query('shopRules', {});
    const row = card(first, '영업일 기준 시각').rows[0]!;
    const custom = row.options.find((o) => o.key === 'custom')!;
    const press = optionPress(row, custom);
    expect('input' in press && press.input).toMatchObject({ key: K.cutoff, mode: 'time', min: 0, max: 719, note: '00:00 ~ 11:59', title: '영업일 기준 시각 · 06:00' });
    if (!('input' in press)) throw new Error('숫자판이 아니다');
    expect(inputAccepts(press.input, '0100')).toBe(true);
    expect(inputAccepts(press.input, '1159')).toBe(true);
    expect(inputAccepts(press.input, '1200')).toBe(false);
    expect(inputAccepts(press.input, '0575')).toBe(false);
    expect(inputAccepts(press.input, '010')).toBe(false);
    expect(padValue(press.input, '0100')).toBe('01:00');
    const view = await client.query('shopRules', { changes: [{ key: K.cutoff, value: padValue(press.input, '0100') }] });
    const options = card(view, '영업일 기준 시각').rows[0]!.options;
    expect(options.map((o) => [o.label, o.secondLine ?? '', o.selected])).toEqual([['00:00', '', false], ['03:00', '', false], ['06:00', '', false], ['직접 입력', '01:00', true]]);
    expect(card(view, '영업일 기준 시각').notes.map(text).slice(0, 2)).toEqual(['27일 00:15 반납 → 26일 장부', '27일 07:00 반납 → 27일 장부']);
    const midnight = await client.query('shopRules', { changes: [{ key: K.cutoff, value: '00:00' }] });
    expect(card(midnight, '영업일 기준 시각').notes.map(text).slice(0, 2)).toEqual(['27일 00:15 반납 → 27일 장부', '27일 07:00 반납 → 27일 장부']);
    // 고르기 버튼은 버튼 key가 값이다.
    expect(optionPress(row, row.options[0]!)).toEqual({ change: { key: K.cutoff, value: '00:00' } });
  });

  it('범위 밖 · 모르는 바꿈은 화면에서 무시하고, 명령으로 오면 거절한다(체험판 미지원)', async () => {
    const { client } = at();
    const view = await client.query('shopRules', { changes: [{ key: K.cutoff, value: '13:00' }, { key: 'shops::nothing', value: 1 }] });
    expect(view.footer).toBe('변경 없음');
    const draft = openOrRestoreDraft(null, { type: 'setting.set', payload: { changes: [] } } as ConfirmCommand, view.basis, {});
    const bad = envelopeFor(draft, { type: 'setting.set', payload: { changes: [{ key: K.cutoff, value: '13:00' }] } }, undefined)!;
    expect(await client.command(bad)).toMatchObject({ outcome: 'rejected', error: { message: '체험판 미지원' } });
  });
});

describe('바꿈 key(RuleChange.key)는 schema.sql의 표 · 열(contract ruleKey · parseRuleKey)', () => {
  it('체험 자료가 쓰는 key는 모두 세 마디로 읽히고, 표의 열(item_kinds · deposit_rules · shops) · 설정 key(shop_settings)가 스키마에 있다', () => {
    const sql = readFileSync(new URL('../../../packages/schema/schema.sql', import.meta.url), 'utf8');
    const columnsOf = (table: string) => {
      const start = sql.indexOf('CREATE TABLE ' + table + ' (');
      expect(start, table).toBeGreaterThanOrEqual(0);
      return sql.slice(start, sql.indexOf('\n);', start));
    };
    for (const key of Object.values(ruleKeys(sampleRegistry(), SHOP_RULES))) {
      const parts = parseRuleKey(key);
      expect(parts, key).not.toBeNull();
      if (parts!.table === 'shop_settings') expect(sql, key).toContain("('" + parts!.row + "',");
      else expect(columnsOf(parts!.table), key).toMatch(new RegExp('\\n\\s+' + parts!.column + '\\s'));
    }
    // 보증금 사용(deposit_rules.active)은 INTEGER 0 · 1: 버튼이 보낼 값.
    expect(columnsOf('deposit_rules')).toContain('CHECK (active IN (0,1))');
    expect(parseRuleKey('shop_settings::prepayment_amount')?.column).toBe('prepayment_amount');
    expect(parseRuleKey('nope:x:y')).toBeNull();
  });

  it('보증금 사용 버튼은 0 · 1을 보낸다(RuleRow.values)', async () => {
    const { client } = at(0);
    const view = await client.query('shopRules', {});
    const row = view.cards.flatMap((c) => c.rows).find((r) => r.key === K.depositOn)!;
    expect(row.values).toEqual({ true: 1, false: 0 });
    expect(optionPress(row, row.options.find((o) => o.key === 'false')!)).toEqual({ change: { key: K.depositOn, value: 0 } });
  });
});

describe('저장(setting.set) — 다음 기록부터(data-model 3-3 · catalog 2 · 11-1)', () => {
  it('세 곳 저장: 운영 규칙이 바뀌고(새 권 줄은 반납 선택 복사) 지난 줄은 그대로, 다시 열면 변경 없음', async () => {
    const { client, state } = at();
    const view = await client.query('shopRules', { changes: THREE });
    const before = state().orders.flatMap((o) => o.lines).filter((l) => l.section === 'lift').map((l) => l.returnable);
    expect(await save(client, view)).toMatchObject({ outcome: 'applied' });
    const s = state().settings;
    expect(s.liftReturnPolicy).toBe('optional');
    expect(liftReturnable(s)).toBe(false);
    expect(s.liftDeposit?.timing).toBe('at_issue');
    expect(s.businessDayCutoff).toBe('03:00');
    expect(s.cutoffBefore).toEqual([{ until: ms(15, 40), cutoff: '06:00' }]);
    expect(state().orders.flatMap((o) => o.lines).filter((l) => l.section === 'lift').map((l) => l.returnable)).toEqual(before);
    const again = await client.query('shopRules', {});
    expect(again.footer).toBe('변경 없음');
    expect(picked(again, '리프트권 반납')).toEqual([['', '반납 선택 · 반납 시 기록', '']]);
  });

  it('기준 시각을 바꿔도 지난 기록의 영업일은 움직이지 않는다(ADR-06): 10:00 저장 뒤에도 08:45 수납은 26일, 마감 수단 표 그대로', async () => {
    const { client, state } = at();
    const methods = (await client.query('closingSheet', {})).methods.map((m) => [m.label, m.count, m.amount]);
    const view = await client.query('shopRules', { changes: [{ key: K.cutoff, value: '10:00' }] });
    expect(view.rejection).toBeUndefined();
    expect(await save(client, view)).toMatchObject({ outcome: 'applied' });
    const cutoff = shopCutoff(state().settings);
    expect(businessDateOf(ms(8, 45), cutoff)).toBe('2026-12-26');
    expect(businessDateOf(ms(8, 45), '10:00')).toBe('2026-12-25');
    expect(businessDateOf(ms(9, 30, 1), cutoff)).toBe('2026-12-26');
    expect((await client.query('closingSheet', {})).methods.map((m) => [m.label, m.count, m.amount])).toEqual(methods);
  });

  it('옛 기준과 새 기준 사이에는 거절(`변경 불가 · 06:00 이후 가능`): 27일 00:40에 00:00, 03:00은 된다', async () => {
    const { client } = at(540);
    const view = await client.query('shopRules', { changes: [{ key: K.cutoff, value: '00:00' }] });
    expect(view.rejection).toBe('변경 불가 · 06:00 이후 가능');
    expect(view.primary.enabled).toBe(true);
    expect(await save(client, view)).toMatchObject({ outcome: 'rejected', error: { message: '변경 불가 · 06:00 이후 가능' } });
    const ok = await client.query('shopRules', { changes: [{ key: K.cutoff, value: '03:00' }] });
    expect(ok.rejection).toBeUndefined();
  });

  it('보증금 미사용 저장: 새 보증금은 받지 않고, 맡은 보증금(박준호 15,000원)은 그대로 반환 창에 있다. `사용`으로 되돌리면 그 값(1매 5,000원)으로', async () => {
    const { client, state } = at(30);
    const off = await client.query('shopRules', { changes: [{ key: K.depositOn, value: 0 }] });
    expect(await save(client, off)).toMatchObject({ outcome: 'applied' });
    expect(state().settings.liftDeposit).toBeNull();
    expect(heldRule(state())?.unitAmount).toBe(5_000);
    const back = await client.query('returnSheet', { orderId: 'o22' });
    expect(back.deposit ? text(back.deposit) : '').toContain('보증금 15,000원 반환');
    const on = await client.query('shopRules', { changes: [{ key: K.depositOn, value: 1 }, { key: K.depositAmount, value: 6_000 }] });
    expect(on.changes.map((c) => [c.before, c.after])).toEqual([['미사용', '사용'], ['1매 5,000원', '1매 6,000원']]);
    expect(await save(client, on)).toMatchObject({ outcome: 'applied' });
    expect(state().settings.liftDeposit).toMatchObject({ key: 'lift_ticket_card', unitAmount: 6_000, timing: 'at_intake', unreturned: 'keep' });
    // 이미 맡은 보증금은 맡을 때 값(1매 5,000원)대로다.
    expect(state().deposits.find((d) => d.orderId === 'o22')?.unitAmount).toBe(5_000);
  });
});

describe('V8 화면 도우미 — 카드 쪽 · 저장 창 줄 수 · 탭', () => {
  const pos = DEVICE_PROFILES.pos;
  /** 본문 상자: 폭 = 화면 − 2 × (책상 12 + 종이 18), 높이 = 화면 − 머리 60 − 바닥 72 − 제목 · 탭 60. */
  const bodyOf = (width: number, height: number) => ({ width: width - 60, height: height - 60 - 72 - 60 });

  it('1024×600 한 쪽 두 칸, 1024×569 · 529 두 쪽, 875×600(한 칸) 두 쪽, 1024×768 한 쪽', async () => {
    const { client } = at();
    const view = await client.query('shopRules', {});
    expect(rulesLayout(pos, bodyOf(1024, 600), view.cards)).toEqual({ columns: 2, pages: [[[0, 1], [2, 3, 4]]] });
    expect(rulesLayout(pos, bodyOf(1024, 529), view.cards)).toEqual({ columns: 2, pages: [[[0], [1]], [[2, 3], [4]]] });
    expect(rulesLayout(pos, bodyOf(1024, 569), view.cards).pages).toHaveLength(2);
    expect(rulesLayout(DEVICE_PROFILES.pos_narrow, bodyOf(875, 600), view.cards)).toEqual({ columns: 1, pages: [[[0, 1]], [[2, 3, 4]]] });
    expect(rulesLayout(pos, bodyOf(1024, 768), view.cards)).toEqual({ columns: 2, pages: [[[0, 1, 2], [3, 4]]] });
    expect(rulesLayout(pos, null, view.cards)).toEqual({ columns: 1, pages: [[[]]] });
  });

  it('예약금 줄이 붙으면 1024×600에서도 영업일 기준 시각이 다음 쪽으로', async () => {
    const { client } = at();
    const view = await client.query('shopRules', { changes: [{ key: K.prepay, value: 'fixed_amount' }] });
    expect(rulesLayout(pos, bodyOf(1024, 600), view.cards).pages).toEqual([[[0, 1], [2, 3]], [[4]]]);
  });

  it('저장 창 한 쪽 줄 수(창 552 · 505에서 7 · 6), 금액 숫자판은 0원 · 범위 밖을 받지 않는다', () => {
    expect(saveRowsPerPage(pos, { width: 1024, height: 600 })).toBe(7);
    expect(saveRowsPerPage(pos, { width: 1024, height: 529 })).toBe(6);
    const input = { key: K.depositAmount, mode: 'amount' as const, title: '리프트권 보증금', min: 100, max: 1_000_000 };
    expect(inputAccepts(input, '')).toBe(false);
    expect(inputAccepts(input, '0')).toBe(false);
    expect(inputAccepts(input, '6000')).toBe(true);
    expect(inputAccepts(input, '2000000')).toBe(false);
    expect(padValue(input, '6000')).toBe(6_000);
  });

  it('색인 탭 여섯(차례 그대로), 좁은 포스(탭 5칸)에서도 `운영 규칙`은 남는다', () => {
    const tabs = settingsTabs();
    expect(tabs.map((tab) => tab.label)).toEqual(['매장 정보', '장소', '반납 타임', '요금 · 할인', '차량 · 직원', '운영 규칙']);
    const fitted = fitList(tabs.map((tab) => ({ ...tab, pinnedEnd: false })), DEVICE_PROFILES.pos_narrow.capacity.tabs, { moreTakesSlot: true });
    expect(fitted.shown.map((tab) => tab.label)).toEqual(['매장 정보', '장소', '반납 타임', '운영 규칙']);
    expect(fitList(tabs.map((tab) => ({ ...tab, pinnedEnd: false })), pos.capacity.tabs, { moreTakesSlot: true }).overflow).toEqual([]);
  });
});

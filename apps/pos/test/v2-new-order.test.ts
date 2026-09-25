// 둘째 판 4단계(work/impl-v2/plan.md 5절 Step 4): V2 새 접수 ① 품목 · V3 ② 일정(spec 3-4 · 3-5). 초안은 기기에 있고(app/new-order-draft.ts),
// 화면은 누른 것만 초안에 넣어 orderDraft를 다시 묻는다. 서버(체험 자료)가 종류 타일 · 고르는 줄 · 선택 품목 · 합계 · 일정 버튼 · 작은 창의
// 선택지 · 접수 내용 · 바닥줄 · 견적을 쓴다. 시안의 순간은 16:25 이민호 팀(스키 4 · 의류 95 × 2 · 100 × 1 · 헬멧 중 1 · 야간권 4매).
import type { ChoiceOption, OrderDraftInput, OrderDraftParams, OrderDraftView } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_NEW_ORDER, clearNewOrder, draftParams, loadNewOrder, qtyOf, saveNewOrder, withDeliver, withName, withOpenKind, withOpenVariant, withParty,
  withPhone, withPickupNow, withQuantity, withReserve, withReturnDay, withReturnPlace, withReturnSlot, type NewOrderState,
} from '../src/app/new-order-draft.ts';
import { type FxState, kstAt, resolveSchedule } from '@skinote/domain';
import { MAX_QTY } from '@skinote/domain/sample';
import { createSeed } from '../src/fixture/demo.ts';
import { FixtureClient } from '../src/fixture/fixture-client.ts';
import { footerAlts, rowPages, tilesPerPage } from '../src/screens/NewOrderScreen.tsx';

const ms = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);

/** 체험 시계를 15:40에서 minutes만큼(뒷이야기 끔: 새 접수는 다른 팀과 관계없다). 16:25 = 45분. */
function at(minutes: number) {
  const client = new FixtureClient({ realNow: () => 1_800_000_000_000 });
  client.advanceClock(minutes);
  const state = () => (client as unknown as { state: FxState }).state;
  return { client, state };
}
const at1625 = () => at(45);

/** 시안 V2의 초안(화면이 누르는 길 그대로 helper로 만든다). */
function drawnState(): NewOrderState {
  let s = withName(EMPTY_NEW_ORDER, '이민호');
  s = withPhone(s, '01000000042');
  s = withParty(s, 4);
  s = withQuantity(s, { productKey: 'ski' }, 4);
  s = withQuantity(s, { productKey: 'clothes', variantKey: '95' }, 2);
  s = withQuantity(s, { productKey: 'clothes', variantKey: '100' }, 1);
  s = withQuantity(s, { productKey: 'helmet', variantKey: '중' }, 1);
  s = withQuantity(s, { productKey: 'night_adult' }, 4);
  return withOpenVariant(withOpenKind(s, 'clothes'), '100');
}

const ask = (client: FixtureClient, params: OrderDraftParams) => client.query('orderDraft', params);
const labels = (options: readonly ChoiceOption[]) => options.map((o) => o.label + (o.secondLine ? '/' + o.secondLine : '') + (o.selected ? '*' : '') + (o.enabled ? '' : '!'));

describe('V2 ① 품목의 읽기 모델(orderDraft)', () => {
  it('빈 초안: 종류 타일 일곱(스키 · 보드 · 부츠 · 의류 · 헬멧 · 고글 · 리프트권, 강습 없음), 고르는 줄 없음, 선택 품목 · 합계 없음, 다음 불가', async () => {
    const { client } = at(0);
    const view = await ask(client, draftParams(EMPTY_NEW_ORDER));
    expect(view.tiles.map((t) => [t.label, t.secondLine, t.secondShort ?? '', t.count ?? 0, t.open])).toEqual([
      ['스키', '1일 40,000원', '40,000원', 0, false],
      ['보드', '1일 25,000원', '25,000원', 0, false],
      ['부츠', '1일 10,000원', '10,000원', 0, false],
      ['의류', '1일 20,000원', '20,000원', 0, false],
      ['헬멧', '1일 5,000원', '5,000원', 0, false],
      ['고글', '1일 5,000원', '5,000원', 0, false],
      ['리프트권', '권종 선택', '', 0, false],
    ]);
    expect(view.tilePages).toBe(1);
    expect(view.picker).toBeUndefined();
    expect(view.selected).toEqual([]);
    expect(view.totals).toEqual([]);
    expect(view.ready).toEqual({ items: false, schedule: false });
    expect(view.footer).toBe('새 접수');
    expect(view.leader).toEqual({ phone: '', party: { value: 0, min: 0, max: 30, unit: '명' } });
    expect(view.channelTag).toBeUndefined();
    expect(view.quoteHash).toBe('');
    expect(view.currentBusinessDate).toBe('2026-12-26');
  });

  it('시안 V2(16:25 이민호 팀): 타일 수 · 연 의류 · 규격 버튼 · 사이즈 100 수량 · 선택 품목 넷 · 합계(보증금 별도) · 바닥줄', async () => {
    const { client } = at1625();
    const view = await ask(client, draftParams(drawnState()));
    expect(view.tiles.map((t) => [t.label, t.secondLine, t.count ?? 0, t.open])).toEqual([
      ['스키', '1일 40,000원', 4, false], ['보드', '1일 25,000원', 0, false], ['부츠', '1일 10,000원', 0, false], ['의류', '1일 20,000원', 3, true],
      ['헬멧', '1일 5,000원', 1, false], ['고글', '1일 5,000원', 0, false], ['리프트권', '야간권 35,000원', 4, false],
    ]);
    expect(view.tiles[6]?.secondShort).toBe('야간권');
    expect(view.picker?.variants?.label).toBe('의류 사이즈');
    expect(labels(view.picker!.variants!.options)).toEqual(['90', '95 · 2벌', '100 · 1벌*', '105', '110']);
    expect(view.picker?.variants?.options.map((o) => o.short)).toEqual(['90', '95', '100', '105', '110']);
    expect(view.picker?.quantity).toEqual({ label: '사이즈 100', value: { value: 1, min: 0, max: MAX_QTY, unit: '벌' }, note: '의류 합계 3벌', target: { productKey: 'clothes', variantKey: '100' } });
    expect(view.selected.map((r) => [r.title, r.note, r.amount])).toEqual([
      ['스키 4대', '부츠 · 폴 포함', 160_000],
      ['의류 3벌', '95 2벌 · 100 1벌', 60_000],
      ['헬멧 1개', '중 사이즈', 5_000],
      ['야간권 성인 4매', '보증금 · 매장 기준 1매 5,000원', 140_000],
    ]);
    expect(view.selected.map((r) => r.open)).toEqual([
      { kindKey: 'ski' }, { kindKey: 'clothes', variantKey: '95' }, { kindKey: 'helmet', variantKey: '중' }, { kindKey: 'lift', variantKey: 'night_adult' },
    ]);
    expect(view.totals).toEqual([
      { label: '장비', amount: 225_000 }, { label: '리프트권', amount: 140_000 }, { label: '합계', amount: 365_000, strong: true },
      { label: '보증금 · 별도', amount: 20_000, muted: true },
    ]);
    expect(view.leader.phone).toBe('010-0000-0042');
    expect(view.leader.party.value).toBe(4);
    expect(view.footer).toBe('새 접수 · 이민호 팀 · 4명');
    expect(view.ready).toEqual({ items: true, schedule: true });
    expect(view.quoteHash).toBe('quote:skix4=160000,clothes/95x2=40000,clothes/100x1=20000,helmet/중x1=5000,night_adultx4=140000:n1:d20000');
  });

  it('고르는 줄: 규격을 고르기 전은 한 줄 안내, 스키는 규격 없이 수량, 부츠는 17칸 + 규격 더 보기, 고글은 규격, 리프트권은 권종', async () => {
    const { client } = at1625();
    const open = (kind: string, variant?: string) => ask(client, { draft: EMPTY_NEW_ORDER.draft, openKindKey: kind, ...(variant ? { openVariantKey: variant } : {}) });
    const clothes = await open('clothes');
    expect(clothes.picker).toMatchObject({ kindKey: 'clothes', hint: '사이즈 선택' });
    expect(clothes.picker?.quantity).toBeUndefined();
    const ski = await open('ski');
    expect(ski.picker?.variants).toBeUndefined();
    expect(ski.picker?.quantity).toMatchObject({ label: '수량', value: { value: 0, unit: '대' }, target: { productKey: 'ski' } });
    expect(ski.picker?.quantity?.note).toBeUndefined();
    const boots = await open('boots', '250');
    expect(boots.picker?.variants?.moreLabel).toBe('규격 더 보기');
    expect(boots.picker?.variants?.options.map((o) => o.label)).toEqual(Array.from({ length: 17 }, (_, i) => String(220 + i * 5)));
    expect(boots.picker?.quantity?.label).toBe('사이즈 250');
    const goggles = await open('goggles', '어린이');
    expect(goggles.picker?.variants?.label).toBe('고글 규격');
    expect(goggles.picker?.quantity?.label).toBe('어린이');
    const lift = await open('lift');
    expect(lift.picker?.variants?.label).toBe('리프트권 권종');
    expect(labels(lift.picker!.variants!.options)).toEqual(['오전권', '오후권', '야간권', '주간권', '종일권']);
    expect(lift.picker?.hint).toBe('권종 선택');
    const night = await ask(client, { draft: withQuantity(EMPTY_NEW_ORDER, { productKey: 'night_adult' }, 2).draft, openKindKey: 'lift' });
    expect(night.picker?.quantity).toMatchObject({ label: '야간권', value: { value: 2, unit: '매' }, note: '리프트권 합계 2매', target: { productKey: 'night_adult' } });
    const two = withQuantity(withQuantity(EMPTY_NEW_ORDER, { productKey: 'night_adult' }, 2), { productKey: 'full_adult' }, 1);
    const both = await ask(client, draftParams(two));
    expect([both.tiles[6]?.secondLine, both.tiles[6]?.secondShort, both.tiles[6]?.count]).toEqual(['야간권 · 종일권', '야간권 외 1종', 3]);
    expect(both.selected.map((r) => r.title)).toEqual(['야간권 성인 2매', '종일권 성인 1매']);
  });

  it('보증금을 쓰지 않는 매장은 권 줄 둘째 줄이 1매 값이고 합계에 보증금 줄이 없다', async () => {
    const { client, state } = at1625();
    state().settings.liftDeposit = null;
    const view = await ask(client, draftParams(withQuantity(withName(EMPTY_NEW_ORDER, '가'), { productKey: 'night_adult' }, 2)));
    expect(view.selected.map((r) => r.note)).toEqual(['1매 35,000원']);
    expect(view.totals.map((t) => t.label)).toEqual(['리프트권', '합계']);
  });

  // 품목 목록의 순수 셈(cleanItems · quoteOf · phoneText)은 도메인 시험으로 옮겼다(packages/domain/test/catalog.test.ts).
});

describe('V3 ② 일정의 읽기 모델', () => {
  it('시안 V3(16:25): 매장 직접 · 즉시, 오늘, 12:00 지남 · 16:30 10분 이내(누를 수 없음), 야간권 → 야간 22:00, 매장 직접, 접수 내용 넷', async () => {
    const { client } = at1625();
    const view = await ask(client, draftParams(drawnState()));
    const s = view.schedule;
    expect(labels(s.pickup)).toEqual(['매장 직접 · 즉시*', '예약 · 수령일', '차량 배달']);
    expect(s.pickup.map((o) => o.opens ?? false)).toEqual([false, true, true]);
    expect(labels(s.returnDays)).toEqual(['오늘*', '내일', '다른 날']);
    expect(labels(s.returnSlots)).toEqual(['오전타임 후 12:00!', '오후 16:30!', '야간 22:00*', '심야 24:00']);
    expect(s.returnSlots.map((o) => o.reason)).toEqual(['선택 불가 · 시간 지남', '선택 불가 · 10분 이내', undefined, undefined]);
    expect(s.returnPlace).toEqual({ mode: 'store' });
    expect(s.areas.map((a) => a.label)).toEqual(['설천', '만선', '솔마을', '꽃마을']);
    expect(s.calendar.map((d) => d.label)).toEqual(['모레', '12월 29일', '12월 30일', '12월 31일', '1월 1일', '1월 2일']);
    expect(view.summary.map((r) => [r.title, r.note])).toEqual([
      ['수령 · 즉시 16:25', '매장 직접'],
      ['반납 · 오늘 22:00', '매장 직접 반납'],
      ['장비 225,000원', '스키 4 · 의류 3 · 헬멧 1'],
      ['리프트권 140,000원', '야간권 4매 · 보증금 20,000원 별도'],
    ]);
    expect(view.summary[2]?.items).toEqual(['스키 4', '의류 3', '헬멧 1']);
    expect(view.summary.every((r) => r.open === undefined)).toBe(true);
    expect(view.ready.schedule).toBe(true);
  });

  it('반납 시각의 처음 값: 권이 없으면 기본 반납 타임(오후 16:30) — 오늘 고를 수 없으면(10분 안) 오늘의 다음 타임(야간 22:00), 하루 값으로 하룻밤을 말없이 빌려주지 않는다', async () => {
    const { client } = at1625();
    const gear = withQuantity(withName(EMPTY_NEW_ORDER, '가'), { productKey: 'ski' }, 1);
    const view = await ask(client, draftParams(gear));
    expect(labels(view.schedule.returnDays)).toEqual(['오늘*', '내일', '다른 날']);
    expect(labels(view.schedule.returnSlots)).toEqual(['오전타임 후 12:00!', '오후 16:30!', '야간 22:00*', '심야 24:00']);
    expect(view.summary[1]?.title).toBe('반납 · 오늘 22:00');
    expect(view.summary[2]).toMatchObject({ title: '장비 40,000원', note: '스키 1' });
    // 오전권(12:00, 오늘 지남)도 오늘의 다음 고를 수 있는 타임.
    const morning = await ask(client, draftParams(withQuantity(gear, { productKey: 'morning_adult' }, 1)));
    expect(morning.summary[1]?.title).toBe('반납 · 오늘 22:00');
    // 권종이 여럿이면 가장 늦은 사용 창 끝(야간권 22:00).
    const mixed = await ask(client, draftParams(withQuantity(withQuantity(gear, { productKey: 'morning_adult' }, 1), { productKey: 'night_adult' }, 1)));
    expect(mixed.summary[1]?.title).toBe('반납 · 오늘 22:00');
  });

  it('값은 대여 날 수로(catalog 8: 장비 1일 값 × 수 × 날, 리프트권은 하루권): 반납일을 내일로 옮기면 장비 값이 두 배, 선택 품목 · 접수 내용에 `2일`', async () => {
    const { client } = at1625();
    const gear = withQuantity(withName(EMPTY_NEW_ORDER, '가'), { productKey: 'board' }, 1);
    const today = await ask(client, draftParams(gear));
    expect(today.totals.find((t) => t.strong)?.amount).toBe(25_000);
    const tomorrow = await ask(client, draftParams(withReturnDay(gear, today, 'tomorrow')));
    expect(tomorrow.summary[1]?.title).toBe('반납 · 내일 22:00');
    expect(tomorrow.totals.find((t) => t.strong)?.amount).toBe(50_000);
    expect(tomorrow.selected[0]).toMatchObject({ title: '보드 1대', note: '2일 · 1일 25,000원', amount: 50_000 });
    expect(tomorrow.summary[2]).toMatchObject({ title: '장비 50,000원', note: '보드 1 · 2일' });
    expect(tomorrow.quoteHash).toContain(':n2:');
    // 리프트권은 하루권이라 날과 상관없다.
    const lift = await ask(client, draftParams(withQuantity(withReturnDay(gear, today, 'tomorrow'), { productKey: 'night_adult' }, 1)));
    expect(lift.totals.find((t) => t.label === '리프트권')?.amount).toBe(35_000);
  });

  it('반납일 · 반납 시각을 누른 뒤에는 권종을 따라가지 않는다, 반납 장소를 고르면 두 줄 구역 · 차량 수거', async () => {
    const { client } = at1625();
    let s = drawnState();
    const first = await ask(client, draftParams(s));
    s = withReturnSlot(s, first, 'late_night');
    expect(s.draft.returnSet).toEqual({ time: true });
    expect(s.draft.giveBack.slot).toEqual({ day: 'today', slotKey: 'late_night' });
    s = withQuantity(s, { productKey: 'morning_adult' }, 1);
    let view = await ask(client, draftParams(s));
    expect(view.summary[1]?.title).toBe('반납 · 오늘 24:00');
    s = withReturnDay(s, view, 'tomorrow');
    expect(s.draft.giveBack.slot).toEqual({ day: 'tomorrow', slotKey: 'late_night' });
    view = await ask(client, draftParams(s));
    expect(labels(view.schedule.returnDays)).toEqual(['오늘', '내일*', '다른 날']);
    expect(labels(view.schedule.returnSlots)).toEqual(['오전타임 후 12:00', '오후 16:30', '야간 22:00', '심야 24:00*']);
    s = withReturnDay(s, view, '2026-12-29');
    view = await ask(client, draftParams(s));
    expect(labels(view.schedule.returnDays)).toEqual(['오늘', '내일', '다른 날/12월 29일*']);
    s = withReturnPlace(s, { mode: 'vehicle', placeKey: 'dusol' });
    view = await ask(client, draftParams(s));
    expect(view.schedule.returnPlace).toEqual({ mode: 'vehicle', placeKey: 'dusol' });
    expect(view.summary[1]).toMatchObject({ title: '반납 · 12월 29일 24:00', note: '솔마을 두솔동 · 차량 수거' });
    // 지난 반납 타임을 고른 채로 두면 누를 수 없고 다음 단계도 막힌다.
    s = withReturnDay(s, view, 'today');
    view = await ask(client, draftParams(s));
    s = withReturnSlot(s, view, 'morning');
    view = await ask(client, draftParams(s));
    expect(view.schedule.returnSlots.some((o) => o.selected)).toBe(false);
    expect(view.summary[1]?.title).toBe('반납 · 오늘');
    expect(view.ready).toEqual({ items: true, schedule: false });
  });

  it('전화 예약: 수령일 · 시각 · 장소 작은 창, 이름표 전화 예약, 수령일보다 이른 반납일은 누를 수 없음, 처음 값은 수령일에 맞춤', async () => {
    const { client } = at1625();
    let s = withReserve(drawnState(), {});
    expect(s.draft.channel).toBe('phone');
    let view = await ask(client, draftParams(s));
    expect(view.channelTag).toBe('전화 예약');
    expect(labels(view.schedule.pickup)).toEqual(['매장 직접 · 즉시', '예약/내일 09:00 매장 직접*', '차량 배달']);
    expect(labels(view.schedule.reserve.days ?? [])).toEqual(['오늘', '내일*', '다른 날']);
    expect(labels(view.schedule.reserve.times)).toEqual(['08:00', '09:00*', '13:00', '18:00', '직접 입력']);
    expect(view.schedule.reserve.place).toEqual({ mode: 'store' });
    expect(labels(view.schedule.returnDays)).toEqual(['오늘!', '내일*', '다른 날']);
    expect(view.summary.slice(0, 2).map((r) => r.title)).toEqual(['수령 · 내일 09:00', '반납 · 내일 22:00']);
    // 오늘 수령 예약: 지난 시각은 누를 수 없다(08:00 · 09:00 · 13:00 지남, 18:00 가능).
    s = withReserve(s, { day: 'today', time: '18:00', place: { mode: 'vehicle', placeKey: 'hansol' } });
    view = await ask(client, draftParams(s));
    expect(labels(view.schedule.reserve.times)).toEqual(['08:00!', '09:00!', '13:00!', '18:00*', '직접 입력']);
    expect(view.schedule.pickup[1]?.secondLine).toBe('오늘 18:00 솔마을 한솔동');
    expect(view.schedule.reserve.place).toEqual({ mode: 'vehicle', placeKey: 'hansol' });
    // 반납 장소는 수령한 곳을 따른다(누르기 전). 18:00 수령이라 22:00까지 오늘 반납.
    expect(view.schedule.returnPlace).toEqual({ mode: 'vehicle', placeKey: 'hansol' });
    expect(labels(view.schedule.returnSlots)).toEqual(['오전타임 후 12:00!', '오후 16:30!', '야간 22:00*', '심야 24:00']);
    // 직접 입력한 시각은 그 버튼의 둘째 줄.
    s = withReserve(s, { time: '19:20' });
    view = await ask(client, draftParams(s));
    expect(view.schedule.reserve.times.at(-1)).toMatchObject({ key: 'custom', secondLine: '19:20', selected: true });
    // 매장 직접 · 즉시로 되돌리면 현장 접수.
    s = withPickupNow(s);
    view = await ask(client, draftParams(s));
    expect(view.channelTag).toBeUndefined();
    expect(view.schedule.pickup[0]?.selected).toBe(true);
  });

  it('차량 배달(현장 접수): 즉시 · 다음 30분 둘 · 직접 입력, 장소를 고르기 전에는 다음 단계 불가, 반납 장소 · 접수 내용이 배달 장소를 따름', async () => {
    const { client } = at1625();
    let s = withDeliver(drawnState(), { time: 'now' });
    let view = await ask(client, draftParams(s));
    expect(labels(view.schedule.deliver.times)).toEqual(['즉시*', '16:30', '17:00', '직접 입력']);
    expect(view.schedule.deliver.place).toEqual({ mode: 'store' });
    expect(labels(view.schedule.pickup)).toEqual(['매장 직접 · 즉시', '예약 · 수령일', '차량 배달/즉시*']);
    expect(view.ready.schedule).toBe(false);
    s = withDeliver(s, { time: '17:00', place: { mode: 'vehicle', placeKey: 'manseon_plaza' } });
    view = await ask(client, draftParams(s));
    expect(view.channelTag).toBeUndefined();
    expect(labels(view.schedule.pickup)).toEqual(['매장 직접 · 즉시', '예약 · 수령일', '차량 배달/17:00 만선 광장*']);
    expect(view.schedule.returnPlace).toEqual({ mode: 'vehicle', placeKey: 'manseon_plaza' });
    expect(view.summary.slice(0, 2).map((r) => [r.title, r.note])).toEqual([
      ['수령 · 오늘 17:00', '만선 광장 · 차량 배달'], ['반납 · 오늘 22:00', '만선 광장 · 차량 수거'],
    ]);
    expect(view.ready.schedule).toBe(true);
    // 반납 장소를 사람이 고르면 더는 따라가지 않는다.
    s = withDeliver(withReturnPlace(s, { mode: 'store' }), { place: { mode: 'vehicle', placeKey: 'seolcheon_parking' } });
    view = await ask(client, draftParams(s));
    expect(view.schedule.returnPlace).toEqual({ mode: 'store' });
  });

  it('resolveSchedule(5단계 order.create가 쓰는 일정): 수령 · 반납 시각과 장소 · 차량', () => {
    const state = createSeed('e');
    const { pickup, giveBack, quote } = resolveSchedule(state, ms(16, 25), drawnState().draft);
    expect([pickup.kind, pickup.at, pickup.mode, pickup.complete]).toEqual(['now', ms(16, 25), 'store', true]);
    expect([giveBack.date, giveBack.slot?.key, giveBack.at, giveBack.mode, giveBack.vehicleId, giveBack.complete]).toEqual(['2026-12-26', 'night', ms(22, 0), 'store', 'v1', true]);
    expect(quote.total).toBe(365_000);
    // 심야 24:00은 27일 00:00(기준 시각 전이라 26일 영업일).
    const late = withReturnSlot(drawnState(), { schedule: { returnDays: [], calendar: [], returnSlots: [] } } as unknown as OrderDraftView, 'late_night');
    expect(resolveSchedule(state, ms(16, 25), late.draft).giveBack.at).toBe(ms(0, 0, 1));
  });
});

describe('초안 도우미(app/new-order-draft.ts) · 화면의 쪽 셈', () => {
  it('수량은 초안의 수에서 바꾸고(0이면 뺌), 연 종류는 규격을 비운다', () => {
    let s = withQuantity(EMPTY_NEW_ORDER, { productKey: 'clothes', variantKey: '95' }, 1);
    s = withQuantity(s, { productKey: 'clothes', variantKey: '95' }, qtyOf(s, { productKey: 'clothes', variantKey: '95' }) + 1);
    expect(s.draft.items).toEqual([{ productKey: 'clothes', variantKey: '95', quantity: 2 }]);
    expect(withQuantity(s, { productKey: 'clothes', variantKey: '95' }, 0).draft.items).toEqual([]);
    expect(withOpenKind(withOpenVariant(s, '95'), 'ski')).toEqual({ draft: s.draft, openKindKey: 'ski' });
    expect(withParty(EMPTY_NEW_ORDER, -1).draft.leader.party).toBe(0);
    expect(withPhone(EMPTY_NEW_ORDER, '010-0000-0042').draft.leader.phone).toBe('01000000042');
    expect(EMPTY_NEW_ORDER.draft).toEqual({ channel: 'walk_in', leader: { name: '', phone: '', party: 0 }, items: [], pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' } } satisfies OrderDraftInput);
  });

  it('저장소: 저장 · 읽기 · 지우기, 모양이 틀리면 빈 초안', () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); } };
    saveNewOrder(drawnState(), storage);
    expect(loadNewOrder(storage)).toEqual(drawnState());
    clearNewOrder(storage);
    expect(loadNewOrder(storage)).toEqual(EMPTY_NEW_ORDER);
    memory.set('sn-new-order', '{"draft":{"items":3}}');
    expect(loadNewOrder(storage)).toEqual(EMPTY_NEW_ORDER);
    expect(loadNewOrder(null)).toEqual(EMPTY_NEW_ORDER);
  });

  it('종류 격자 · 판 줄의 쪽: 잰 높이로 센다(1024×600 3줄 = 9칸, 1024×529 2줄 = 6칸), 줄이 넘치면 쪽 넘김 한 줄을 빼고', () => {
    expect(tilesPerPage(196, 56, 8, 7)).toBe(9);
    expect(tilesPerPage(125, 56, 8, 7)).toBe(6);
    expect(tilesPerPage(undefined, 56, 8, 7)).toBe(7);
    expect(rowPages(208, 52, 4)).toEqual({ perPage: 4, pages: 1, extra: true });
    expect(rowPages(249, 52, 4, 34)).toEqual({ perPage: 4, pages: 1, extra: true });
    expect(rowPages(210, 52, 4, 34)).toEqual({ perPage: 4, pages: 1, extra: false });
    expect(rowPages(177, 52, 4)).toEqual({ perPage: 2, pages: 2, extra: false });
    expect(footerAlts('새 접수 · 이민호 팀 · 4명')).toEqual(['새 접수 · 이민호 팀 · 4명', '새 접수 · 이민호 팀', '새 접수']);
  });
});

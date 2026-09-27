// 매장 설정의 목록 바꿈(registry.update) · 직원 바꿈(staff.set)과 그 읽기 모델(shopSettings), features-1 plan §4-1 · §4-4 · §4-6.
// 바꿈은 다음 기록부터: 만든 접수의 값 · 늦음은 그대로, 숨긴 행은 고르기에서만 빠지고 지난 접수는 그대로 보인다(E12). 차량 사용 종료는
// 업무 · 재고 · 현금이 남으면 막힌다(E13). 같은 요청번호를 두 번 보내도 한 번만 적용된다(멱등).
import {
  defaultUiConfig, draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type ConfirmCommand, type OrderDraftInput, type RegistryOp, type SettingsOp,
  type StaffOp, type UiConfig,
} from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import {
  activeAreas, applyCommand, checkoutPlan, discountAmount, execute, findOrder, kstAt, lateAtOf, ledgerView, runQuery, slotHourOf, vehicleEndRefusal,
  type ShopState,
} from '../src/index.ts';
import { sampleDay } from '../src/sample/index.ts';

const at = (h: number, m: number, day = 0) => kstAt('2026-12-26', day, h, m);
const config: UiConfig = defaultUiConfig({ shopName: '우리 스키샵', timezone: 'Asia/Seoul' });
const ctx = (now: number, extra: Record<string, unknown> = {}) => ({ config, now, ...extra });
const first = (): ShopState => sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });

let seq = 0;
const rid = () => '01K62M1QG00000000000000' + String(++seq).padStart(3, '0');
function envelopeOf(state: ShopState, command: ConfirmCommand, extra: Partial<AnyCommandEnvelope> = {}): AnyCommandEnvelope {
  return { ...draftToEnvelope(openCommandDraft(command, { epoch: state.epoch, rev: state.rev }, { requestId: rid() })), ...extra } as AnyCommandEnvelope;
}
const registry = (state: ShopState, changes: RegistryOp[], now = at(15, 40), extra: Partial<AnyCommandEnvelope> = {}) =>
  applyCommand(state, envelopeOf(state, { type: 'registry.update', payload: { changes } }, extra), now);
const staff = (state: ShopState, changes: StaffOp[], now = at(15, 40), extra: Partial<AnyCommandEnvelope> = {}, actor?: string) =>
  applyCommand(state, envelopeOf(state, { type: 'staff.set', payload: { changes } }, extra), now, undefined, actor ? { actor: { staffId: actor } } : {});
const settings = (state: ShopState, tab: 'info' | 'places' | 'slots' | 'pricing' | 'fleet', changes: SettingsOp[] = [], extra: Record<string, unknown> = {}) =>
  runQuery(state, 'shopSettings', { tab, changes }, ctx(at(15, 40), extra));

describe('장소(구역 → 장소)', () => {
  it('구역 더하기 · 그 구역에 장소 더하기(new:ref) · 이름 변경 · 숨김 · 순서', () => {
    const s = first();
    const out = registry(s, [
      { op: 'area.add', ref: 'n1', label: '설천 입구' }, { op: 'place.add', ref: 'n2', areaId: 'new:n1', label: '매표소' },
      { op: 'place.rename', id: 'seolcheon_house', label: '설천 하우스' }, { op: 'place.hide', id: 'seolcheon_parking', hidden: true },
      { op: 'area.move', id: 'manseon', toIndex: 0 },
    ]);
    expect(out.outcome).toBe('applied');
    const newArea = s.registry.areas.find((a) => a.label === '설천 입구')!;
    expect(newArea.id).toBe(out.requestId + ':n1');
    expect(newArea.places).toEqual([{ id: out.requestId + ':n2', label: '매표소' }]);
    expect(s.registry.areas.map((a) => a.id).slice(0, 2)).toEqual(['manseon', 'seolcheon']);
    expect(s.registry.areas.find((a) => a.id === 'seolcheon')!.places).toEqual([
      { id: 'seolcheon_parking', label: '설천 주차장', hidden: true }, { id: 'seolcheon_house', label: '설천 하우스' },
    ]);
    // 숨긴 장소는 새 접수의 고르기에서 빠진다(구역에 남은 장소가 없으면 구역도).
    expect(activeAreas(s.registry).find((a) => a.id === 'seolcheon')!.places.map((p) => p.id)).toEqual(['seolcheon_house']);
  });

  it('이름 겹침은 숨긴 행까지 본다: `이름 중복 · 다른 이름 필요` · `숨김 항목 중복 · 숨김 해제 필요`, 거절이면 아무것도 바뀌지 않는다', () => {
    const s = first();
    expect(registry(s, [{ op: 'place.hide', id: 'seolcheon_parking', hidden: true }]).outcome).toBe('applied');
    const before = JSON.stringify(s.registry);
    const dup = registry(s, [{ op: 'area.add', ref: 'n1', label: '새 구역' }, { op: 'place.add', ref: 'n2', areaId: 'seolcheon', label: '설천 하우스 앞' }]);
    expect(dup.outcome).toBe('rejected');
    expect(dup.error?.message).toBe('이름 중복 · 다른 이름 필요');
    const hidden = registry(s, [{ op: 'place.add', ref: 'n2', areaId: 'seolcheon', label: '설천 주차장' }]);
    expect(hidden.error?.message).toBe('숨김 항목 중복 · 숨김 해제 필요');
    expect(JSON.stringify(s.registry)).toBe(before);
  });

  it('숨긴 장소: 그 장소를 고른 접수의 일정 변경(V9)은 골라 둔 채 남고, 다른 접수 · 새 접수에서는 빠진다', () => {
    const s = first();
    registry(s, [{ op: 'place.hide', id: 'seolcheon_parking', hidden: true }]);
    const own = runQuery(s, 'promiseSheet', { orderId: 'o22' }, ctx(at(15, 40)));
    expect(findOrder(s, 'o22')!.giveBack.placeId).toBe('seolcheon_parking');
    expect(own.areas.find((a) => a.key === 'seolcheon')!.places.map((p) => p.key)).toContain('seolcheon_parking');
    const other = runQuery(s, 'promiseSheet', { orderId: 'o21' }, ctx(at(15, 40)));
    expect(other.areas.find((a) => a.key === 'seolcheon')!.places.map((p) => p.key)).not.toContain('seolcheon_parking');
    // 지난 접수의 장소 이름은 그대로 읽힌다(수거 목록의 장소 칸).
    const list = ledgerView(s, 'collection_list', { vehicleId: 'v1' }, ctx(at(21, 0)));
    expect(JSON.stringify(list.rows)).toContain('설천 주차장');
  });
});

describe('반납 타임', () => {
  it('더하기: 20:00 이후면 야간, 기준 시각 전 새벽은 그 영업일의 24시 뒤', () => {
    expect(slotHourOf('20:00', '06:00')).toEqual({ hour: 20, minute: 0 });
    expect(slotHourOf('00:30', '06:00')).toEqual({ hour: 24, minute: 30 });
    expect(slotHourOf('24:00', '06:00')).toBeUndefined();
    const s = first();
    const out = registry(s, [{ op: 'slot.add', ref: 'n1', label: '저녁', time: '20:00' }, { op: 'setting.default_slot', slotId: 'new:n1' }]);
    expect(out.outcome).toBe('applied');
    const slot = s.settings.returnSlots.at(-1)!;
    expect(slot).toMatchObject({ key: out.requestId + ':n1', label: '저녁', hour: 20, minute: 0, night: true });
    expect(s.settings.defaultReturnSlotKey).toBe(slot.key);
  });

  it('야간 22:00 → 22:30: 이미 22:00에 잡은 접수의 늦음(빨강) 시각이 그대로다', () => {
    const s = first();
    const promises = s.orders.map((o) => o.giveBack);
    const beforeLate = promises.map((p) => lateAtOf(s.settings, p));
    expect(registry(s, [{ op: 'slot.update', id: 'night', time: '22:30' }]).outcome).toBe('applied');
    const night = s.settings.returnSlots.find((x) => x.key === 'night')!;
    expect(night).toMatchObject({ hour: 22, minute: 30, night: true, earliest: { hour: 22, minute: 0 } });
    expect(promises.map((p) => lateAtOf(s.settings, p))).toEqual(beforeLate);
    // 되돌리면 가장 이른 시각이 지금 시각이 되어 표시가 사라진다.
    registry(s, [{ op: 'slot.update', id: 'night', time: '22:00' }]);
    expect(s.settings.returnSlots.find((x) => x.key === 'night')!.earliest).toBeUndefined();
  });

  it('숨김의 막힘: 기본 반납 타임 · 리프트권 반납 타임 · 마지막 반납 타임', () => {
    const s = first();
    expect(registry(s, [{ op: 'slot.hide', id: 'afternoon', hidden: true }]).error?.message).toBe('숨김 불가 · 기본 반납 타임');
    expect(registry(s, [{ op: 'slot.hide', id: 'night', hidden: true }]).error?.message).toBe('숨김 불가 · 리프트권 반납 타임');
    expect(registry(s, [{ op: 'slot.hide', id: 'late_night', hidden: true }]).outcome).toBe('applied');
    const view = runQuery(s, 'orderDraft', { draft: { channel: 'walk_in', leader: { name: '', phone: '', party: 0 }, items: [], pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' } } }, ctx(at(15, 40)));
    expect(view.schedule.returnSlots.map((o) => o.key)).not.toContain('late_night');
  });

  it('야간 수거 준비 · 차량 지연 기준', () => {
    const s = first();
    expect(registry(s, [{ op: 'setting.night_notice', minutes: 30 }, { op: 'setting.vehicle_late', minutes: 45, nightMinutes: 120 }]).outcome).toBe('applied');
    expect(s.settings.nightNoticeMinutes).toBe(30);
    expect(s.settings.vehicleLate).toEqual({ minutes: 45, nightMinutes: 120 });
    expect(registry(s, [{ op: 'setting.night_notice', minutes: 181 }]).error?.code).toBe('UNSUPPORTED');
  });
});

describe('요금 · 할인(다음 기록부터)', () => {
  const draft: OrderDraftInput = {
    channel: 'walk_in', leader: { name: '이민호', phone: '01000000042', party: 1 }, items: [{ productKey: 'ski', quantity: 1 }],
    pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' },
  };
  const create = (s: ShopState, hash: string, now: number) => applyCommand(s, envelopeOf(s, {
    type: 'order.create', payload: { draft, choices: [{ sectionKey: 'gear', methodKey: 'card' }], payerOrderId: null },
  }, { expect: { quoteHash: hash } }), now);

  it('값을 바꾸기 전에 만든 접수는 그 값 그대로, 뒤의 접수는 새 값, 창이 본 옛 값으로 보내면 QUOTE_CHANGED', () => {
    const s = first();
    const old = checkoutPlan(s, at(15, 41), draft, [{ sectionKey: 'gear', methodKey: 'card' }], null);
    const made = create(s, old.hash, at(15, 41));
    const madeId = (made.result as { orderId: string }).orderId;
    expect(findOrder(s, madeId)!.lines[0]!.amount).toBe(40_000);
    expect(registry(s, [{ op: 'price.set', productKey: 'ski', amount: 45_000 }], at(15, 42)).outcome).toBe('applied');
    expect(findOrder(s, madeId)!.lines[0]!.amount).toBe(40_000);
    expect(create(s, old.hash, at(15, 43)).error?.code).toBe('QUOTE_CHANGED');
    const fresh = checkoutPlan(s, at(15, 43), draft, [{ sectionKey: 'gear', methodKey: 'card' }], null);
    const next = create(s, fresh.hash, at(15, 43));
    expect(findOrder(s, (next.result as { orderId: string }).orderId)!.lines[0]!.amount).toBe(45_000);
  });

  it('할인: 비율 · 금액(10원 단위, 칸 합계까지), 리프트권은 비율만, 미사용은 확정 창에서 빠진다', () => {
    expect(discountAmount(12_345, { key: 'a', label: 'a', kind: 'amount', value: 5_000, sections: ['gear'] })).toBe(5_000);
    expect(discountAmount(3_000, { key: 'a', label: 'a', kind: 'amount', value: 5_000, sections: ['gear'] })).toBe(3_000);
    expect(discountAmount(12_345, { key: 'p', label: 'p', kind: 'percent', value: 10, sections: ['gear'] })).toBe(1_230);
    const s = first();
    expect(registry(s, [{ op: 'discount.add', ref: 'n1', label: '리프트권 5,000원', kind: 'amount', value: 5_000, sections: ['lift'] }]).error?.code).toBe('UNSUPPORTED');
    expect(registry(s, [{ op: 'discount.add', ref: 'n1', label: '단골', kind: 'amount', value: 5_005, sections: ['gear'] }]).error?.code).toBe('UNSUPPORTED');
    const added = registry(s, [
      { op: 'discount.add', ref: 'n1', label: '단골 3,000원', kind: 'amount', value: 3_000, sections: ['gear'] },
      { op: 'discount.update', id: 'ten_percent', value: 15 }, { op: 'discount.active', id: 'lift_twenty', active: false },
    ]);
    expect(added.outcome).toBe('applied');
    expect(s.registry.discounts.find((d) => d.key === 'ten_percent')!.value).toBe(15);
    const sheet = runQuery(s, 'checkoutSheet', { draft, choices: [] }, ctx(at(15, 45)));
    const gear = sheet.sections.find((x) => x.key === 'gear')!;
    expect(gear.discounts?.map((o) => o.label)).toEqual(['할인 없음', '10% 할인', '장비 5,000원 할인', '단골 3,000원', '직접 입력']);
    const plan = checkoutPlan(s, at(15, 45), draft, [{ sectionKey: 'gear', methodKey: 'card', discountKey: added.requestId + ':n1' }], null);
    expect(plan.sections.find((x) => x.pay.key === 'gear')!.net).toBe(37_000);
  });
});

describe('차량(임시 차량 · 사용 종료)', () => {
  it('차량 추가는 지갑 돈통을 함께 만든다. 업무 · 재고 · 현금이 없으면 사용 종료, 다시 사용은 같은 행', () => {
    const s = first();
    const out = registry(s, [{ op: 'vehicle.add', ref: 'n1', label: '3호 차량' }]);
    const id = out.requestId + ':n1';
    expect(s.registry.vehicles.at(-1)).toEqual({ id, label: '3호 차량' });
    expect(s.drawers.find((d) => d.id === 'van:' + id)).toEqual({ id: 'van:' + id, kind: 'vehicle', label: '3호 차량 현금', vehicleId: id });
    expect(registry(s, [{ op: 'vehicle.active', id, active: false }]).outcome).toBe('applied');
    expect(s.registry.vehicles.at(-1)).toEqual({ id, label: '3호 차량', ended: true });
    // 사용 종료한 차량은 새 접수의 차량 고르기에서 빠지지만 목록에는 남는다(마감 · 지난 업무가 이름을 읽는다).
    expect(registry(s, [{ op: 'vehicle.active', id, active: true }]).outcome).toBe('applied');
    expect(s.registry.vehicles.filter((v) => v.label === '3호 차량')).toHaveLength(1);
  });

  it('미처리 업무(날짜 상관없음) · 차량 재고 · 차량 현금이 남으면 막힌다', () => {
    const s = first();
    expect(vehicleEndRefusal(s, 'v1')).toMatch(/^사용 종료 불가 · 미처리 (수거 \d+ · 배달 \d+|수거 \d+건|배달 \d+건)$/);
    expect(registry(s, [{ op: 'vehicle.active', id: 'v1', active: false }]).error?.message).toMatch(/^사용 종료 불가 · 미처리 (수거|배달)/);
    // 업무가 없는 차량이라도 예비권이 실려 있으면 차량 재고.
    const t = first();
    t.orders = [];
    expect(vehicleEndRefusal(t, 'v1')).toBe('사용 종료 불가 · 차량 재고 6개');
    t.vanSpares = [];
    expect(vehicleEndRefusal(t, 'v1')).toBeUndefined();
    t.orders = first().orders.filter((o) => o.payments.some((p) => p.drawerId === 'van:v2'));
    for (const o of t.orders) { o.pickup = { ...o.pickup, mode: 'store' }; o.giveBack = { ...o.giveBack, mode: 'store' }; o.splits = []; }
    if (t.orders.length) expect(vehicleEndRefusal(t, 'v2')).toMatch(/^사용 종료 불가 · 차량 현금 /);
  });
});

describe('직원(staff.set)', () => {
  it('더하기(새 차량은 앞 명령의 것) · 역할 · 차량 · 사용 종료 · 다시 사용, 결과에 새 직원 id', () => {
    const s = first();
    const vehicles = registry(s, [{ op: 'vehicle.add', ref: 'n1', label: '3호 차량' }]);
    const out = staff(s, [{ op: 'staff.add', ref: 'n2', name: '박준', role: 'driver', vehicleId: 'new:n1' }], at(15, 40), { dependsOn: [vehicles.requestId] });
    expect(out.outcome).toBe('applied');
    const id = out.requestId + ':n2';
    expect(out.result).toEqual({ staffIds: [id] });
    expect(s.staff!.at(-1)).toEqual({ id, name: '박준', roleKey: 'driver', vehicleId: vehicles.requestId + ':n1', status: 'active' });
    expect(staff(s, [{ op: 'staff.update', id: 'staff-2', role: 'manager' }]).outcome).toBe('applied');
    expect(staff(s, [{ op: 'staff.active', id: 'staff-5', active: false }]).outcome).toBe('applied');
    expect(s.staff!.find((x) => x.id === 'staff-5')!.status).toBe('suspended');
    expect(staff(s, [{ op: 'staff.active', id: 'staff-5', active: true }]).outcome).toBe('applied');
  });

  it('막힘: 마지막 관리자 · 본인 · 차량 없는 기사, 차량 사용 종료는 배정을 끝낸다', () => {
    const s = first();
    expect(staff(s, [{ op: 'staff.active', id: 'staff-1', active: false }]).error?.message).toBe('사용 종료 불가 · 마지막 관리자');
    expect(staff(s, [{ op: 'staff.update', id: 'staff-1', role: 'counter' }]).error?.message).toBe('사용 종료 불가 · 마지막 관리자');
    expect(staff(s, [{ op: 'staff.active', id: 'staff-2', active: false }], at(15, 40), {}, 'staff-2').error?.message).toBe('사용 종료 불가 · 본인');
    expect(staff(s, [{ op: 'staff.add', ref: 'n1', name: '강다온', role: 'driver' }]).error?.message).toBe('차량 없음 · 관리자 확인 필요');
    expect(staff(s, [{ op: 'staff.update', id: 'staff-3', vehicleId: null }]).error?.message).toBe('차량 없음 · 관리자 확인 필요');
    expect(staff(s, [{ op: 'staff.add', ref: 'n1', name: '문태오', role: 'counter' }]).error?.message).toBe('이름 중복 · 다른 이름 필요');
  });
});

describe('멱등 · execute', () => {
  it('같은 봉투를 두 번: 결과가 같고 두 번째는 상태를 바꾸지 않는다', () => {
    const s = first();
    const envelope = envelopeOf(s, { type: 'registry.update', payload: { changes: [{ op: 'area.add', ref: 'n1', label: '설천 입구' }] } });
    const one = applyCommand(s, envelope, at(15, 40));
    const snapshot = JSON.stringify(s);
    const two = applyCommand(s, envelope, at(15, 41));
    expect(two).toEqual(one);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('execute는 입력을 고치지 않고 서버의 행위자(staff:<id>)로 본인 막힘을 본다', () => {
    const s = first();
    const envelope = envelopeOf(s, { type: 'staff.set', payload: { changes: [{ op: 'staff.active', id: 'staff-2', active: false }] } });
    const before = JSON.stringify(s);
    const out = execute(s, envelope, { now: at(15, 40), actor: { key: 'staff:staff-2', name: '오세린' }, outcomeOf: () => undefined });
    expect(out.outcome.error?.message).toBe('사용 종료 불가 · 본인');
    expect(JSON.stringify(s)).toBe(before);
    const other = execute(s, envelope, { now: at(15, 40), actor: { key: 'staff:staff-1', name: '한가람' }, outcomeOf: () => undefined });
    expect(other.outcome.outcome).toBe('applied');
    expect(other.state.staff!.find((x) => x.id === 'staff-2')!.status).toBe('suspended');
  });
});

describe('읽기 모델 shopSettings', () => {
  it('매장 정보: 이름 · 전화 · 영업일 기준 시각(운영 규칙 ›), 바꾸면 전 → 후와 저장 명령', () => {
    const s = first();
    const view = settings(s, 'info');
    expect(view.cards.map((c) => c.title)).toEqual(['매장 이름', '전화', '영업일 기준 시각']);
    expect(view.cards[1]!.rows[0]!.value!.label).toBe('010-0000-0000');
    expect(view.cards[2]!.rows[0]).toMatchObject({ label: '06:00', link: { label: '운영 규칙', to: 'rules' } });
    expect(view.footer).toBe('변경 없음');
    expect(view.primary.enabled).toBe(false);
    const changed = settings(s, 'info', [{ op: 'shop.set', name: '첫 매장' }]);
    expect(changed.changes).toEqual([{ key: 'shop.name', label: '매장 이름', before: '우리 스키샵', after: '첫 매장' }]);
    expect(changed.footer).toBe('변경 1건 · 다음 기록부터 적용');
    expect(changed.primary).toMatchObject({ label: '저장 · 1건', enabled: true });
    expect(changed.command).toEqual({ type: 'registry.update', payload: { changes: [{ op: 'shop.set', name: '첫 매장' }] } });
    expect(changed.cards[0]!.changed).toBe(true);
  });

  it('장소: 구역마다 카드(구역 칸 · 장소 칸 · 장소 추가), 끝은 구역 추가, 새 구역을 가리키는 장소 추가(new:ref)', () => {
    const s = first();
    const view = settings(s, 'places');
    expect(view.cards.map((c) => c.title)).toEqual(['설천', '만선', '솔마을', '꽃마을', '구역']);
    const seolcheon = view.cards[0]!.list!;
    expect(seolcheon.items.map((i) => [i.label, i.tag ?? ''])).toEqual([['설천', '구역'], ['설천 주차장', ''], ['설천 하우스 앞', '']]);
    expect(seolcheon.add!.run).toMatchObject({ kind: 'op', op: { op: 'place.add', ref: 'n1', areaId: 'seolcheon' }, steps: [{ kind: 'input', field: 'label' }] });
    const drafted = settings(s, 'places', [{ op: 'area.add', ref: 'n1', label: '설천 입구' }, { op: 'place.add', ref: 'n2', areaId: 'new:n1', label: '매표소' }]);
    expect(drafted.cards.map((c) => c.title)).toContain('설천 입구');
    const added = drafted.cards.find((c) => c.title === '설천 입구')!.list!;
    expect(added.add!.run).toMatchObject({ op: { ref: 'n3', areaId: 'new:n1' } });
    expect(drafted.changes.map((c) => c.label + ' ' + c.after)).toEqual(['구역 추가 설천 입구', '장소 추가 설천 입구 · 매표소']);
  });

  it('초안의 거절: refused(차례 · 한 줄)와 그 앞까지만', () => {
    const s = first();
    const view = settings(s, 'places', [{ op: 'area.add', ref: 'n1', label: '설천 입구' }, { op: 'area.add', ref: 'n2', label: '만선' }]);
    expect(view.refused).toEqual({ at: 1, message: '이름 중복 · 다른 이름 필요' });
    expect(view.changes).toHaveLength(1);
  });

  it('반납 타임 · 요금 · 할인 탭의 카드', () => {
    const s = first();
    const slots = settings(s, 'slots');
    expect(slots.cards.map((c) => c.title)).toEqual(['반납 타임', '야간 수거 준비', '차량 지연 기준']);
    expect(slots.cards[0]!.list!.items.map((i) => [i.label, i.tag ?? ''])).toEqual([['오전타임 후 12:00', ''], ['오후 16:30', '기본'], ['야간 22:00', ''], ['심야 24:00', '']]);
    // 차량 지연 기준의 야간 밖은 `주간`(`기본`은 기본 반납 타임의 이름표, 2026-09-27 점검).
    expect(slots.cards[2]!.rows.map((r) => [r.label, r.value!.label])).toEqual([['주간', '60분'], ['야간', '90분']]);
    const pricing = settings(s, 'pricing');
    expect(pricing.cards.map((c) => c.title)).toEqual(['장비', '리프트권', '할인']);
    expect(pricing.cards[0]!.list!.items[0]).toMatchObject({ label: '스키', tag: '1일 40,000원' });
    expect(pricing.cards[1]!.list!.items.find((i) => i.label === '야간권 성인')!.tag).toBe('1매 35,000원');
    expect(pricing.cards[0]!.notes).toEqual([[{ text: '2일 이상 · 1일 금액 × 일수' }]]);
    expect(pricing.cards[2]!.list!.items.map((i) => i.tag)).toEqual(['10% · 장비 · 리프트권', '20% · 리프트권', '5,000원 · 장비']);
  });

  it('역할 · 차량 판: 지금 값은 고른 것(남색), 막힌 것만 점선과 판 위의 까닭(2026-09-27 점검)', () => {
    const s = first();
    const staffItems = settings(s, 'fleet').cards[1]!.list!.items;
    const sheetOf = (name: string) => { const run = staffItems.find((i) => i.label === name)!.run; return run.kind === 'sheet' ? run.sheet : undefined; };
    const sub = (name: string, key: string) => { const run = sheetOf(name)!.actions.find((a) => a.key === key)!.run; return run.kind === 'sheet' ? run.sheet : undefined; };
    // 한가람(마지막 관리자): 관리자는 고른 것, 카운터 · 기사는 막힘 + 까닭.
    const role = sub('한가람', 'role')!;
    expect(role.lines).toEqual(['역할 변경 불가 · 마지막 관리자']);
    expect(role.actions.map((a) => [a.label, a.selected ?? false, a.enabled])).toEqual([['관리자', true, true], ['카운터', false, false], ['기사', false, false]]);
    // 오세린(카운터): 카운터가 고른 것, 나머지는 누를 수 있음. 차량 판은 `없음`이 고른 것.
    expect(sub('오세린', 'role')!.actions.map((a) => [a.label, a.selected ?? false, a.enabled])).toEqual([['관리자', false, true], ['카운터', true, true], ['기사', false, true]]);
    expect(sub('오세린', 'vehicle')!.actions.find((a) => a.key === 'none')).toMatchObject({ selected: true, enabled: true });
  });

  it('차량 · 직원: 목록 바꿈 뒤에 직원 바꿈(then), 새 차량은 new:ref로', () => {
    const s = first();
    const view = settings(s, 'fleet');
    expect(view.cards.map((c) => c.title)).toEqual(['차량', '직원']);
    expect(view.cards[0]!.list!.items.map((i) => [i.label, i.tag])).toEqual([['1호 차량', '담당 문태오'], ['2호 차량', '담당 윤지호']]);
    expect(view.cards[0]!.list!.add!.run).toMatchObject({ op: { op: 'vehicle.add', ref: 'n1' }, steps: [{ input: { value: '3호 차량' } }] });
    expect(view.cards[1]!.list!.items.map((i) => i.tag)).toEqual(['관리자', '카운터', '기사 · 1호 차량', '기사 · 2호 차량', '카운터']);
    const v1 = view.cards[0]!.list!.items[0]!.run;
    expect(v1.kind === 'sheet' && v1.sheet.lines[0]).toMatch(/^사용 종료 불가 · 미처리 (수거|배달)/);
    expect(v1.kind === 'sheet' && v1.sheet.actions.find((a) => a.key === 'end')!.enabled).toBe(false);
    expect(v1.kind === 'sheet' && v1.sheet.actions.find((a) => a.key === 'collection')!.run).toEqual({ kind: 'go', to: 'collection', vehicleId: 'v1' });
    const drafted = settings(s, 'fleet', [{ op: 'vehicle.add', ref: 'n1', label: '3호 차량' }, { op: 'staff.update', id: 'staff-5', vehicleId: 'new:n1' }]);
    expect(drafted.command).toEqual({ type: 'registry.update', payload: { changes: [{ op: 'vehicle.add', ref: 'n1', label: '3호 차량' }] } });
    expect(drafted.then).toEqual([{ command: { type: 'staff.set', payload: { changes: [{ op: 'staff.update', id: 'staff-5', vehicleId: 'new:n1' }] } } }]);
    expect(drafted.changes.map((c) => [c.label, c.before ?? '', c.after])).toEqual([['차량 추가', '', '3호 차량'], ['서하준 · 차량', '없음', '3호 차량']]);
  });

  it('권한 없는 사람(카운터): 바닥줄 `권한 없음 · 관리자 확인 필요`, 저장이 막힌다', () => {
    const s = first();
    const view = settings(s, 'places', [{ op: 'area.add', ref: 'n1', label: '설천 입구' }], { viewer: { roleKey: 'counter', permissions: ['order.create'] } });
    expect(view.footer).toBe('권한 없음 · 관리자 확인 필요');
    expect(view.rejection).toBe('권한 없음 · 관리자 확인 필요');
    expect(view.primary.enabled).toBe(false);
    const manager = settings(s, 'places', [{ op: 'area.add', ref: 'n1', label: '설천 입구' }], { viewer: { roleKey: 'manager', permissions: ['settings.manage', 'staff.manage'] } });
    expect(manager.primary.enabled).toBe(true);
  });

  it('권한 없는 사람은 처음부터 읽기만: 칸은 초안을 만들지 않고, 항목 판은 한 줄과 누를 수 없는 버튼(2026-09-27 점검)', () => {
    const s = first();
    const counter = { viewer: { roleKey: 'counter', permissions: ['order.create'] } };
    for (const tab of ['places', 'slots', 'pricing', 'fleet'] as const) {
      const view = settings(s, tab, [], counter);
      expect(view.footer, tab).toBe('권한 없음 · 관리자 확인 필요');
      for (const card of view.cards) {
        for (const row of card.rows) {
          expect(row.options.every((o) => !o.enabled), tab + ' ' + card.title).toBe(true);
          expect(row.ops, tab).toBeUndefined();
          if (row.value) expect(row.value.enabled, tab).toBe(false);
        }
        for (const item of [...(card.list?.items ?? []), ...(card.list?.add ? [card.list.add] : [])]) {
          expect(['sheet', 'go'], tab + ' ' + item.label).toContain(item.run.kind);
          if (item.run.kind !== 'sheet') continue;
          expect(item.run.sheet.lines[0]).toBe('권한 없음 · 관리자 확인 필요');
          expect(item.run.sheet.actions.every((a) => !a.enabled || a.run.kind === 'go'), tab + ' ' + item.label).toBe(true);
        }
      }
    }
  });
});

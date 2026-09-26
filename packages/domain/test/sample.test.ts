// 견본 매장(sample/): 목록 값 · 운영 규칙 · 견본 하루 · 명세 · 직원 예시(plan D14).
import { describe, expect, it } from 'vitest';
import { SAMPLE_STAFF, sampleDay, sampleRegistry, sampleRules, sampleSpec } from '../src/index.ts';
import { DRAWERS, NO_VARIANT, NUMBERED_SHOP_RULES, SHOP_RULES, STOCK_NUMBERS, VAN_SPARE } from '../src/sample/index.ts';

const DAY = 86_400_000;

/** 하루 뒤의 견본을 하루 앞으로 되돌린 모양(시각 −1일, 날짜 · 접수 번호의 날짜 부분을 바꿈). */
function shiftBack(value: unknown): unknown {
  if (typeof value === 'number') return value > 1e12 ? value - DAY : value;
  if (typeof value === 'string') return value.replace('2026-12-27', '2026-12-26').replace(/^261227-/, '261226-');
  if (Array.isArray(value)) return value.map(shiftBack);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shiftBack(v)]));
  return value;
}

describe('견본 하루(sampleDay)', () => {
  it('12월 26일: 18팀 · 접수 번호 261226-0NN · 다음 번호 19 · 번호 없음 · 1호 차량 예비권 야간권 6매(수량)', () => {
    const day = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
    expect(day.orders).toHaveLength(18);
    expect(day.orders.every((o) => /^261226-0\d\d$/.test(o.receiptNo))).toBe(true);
    expect(day.nextReceiptSeq).toBe(19);
    expect(day.businessDate).toBe('2026-12-26');
    // 첫 매장(2026-09-26 사장님 답): 관리 번호 · 권 번호가 없어 모든 줄이 수량이고 번호 실물이 없다.
    expect(day.assets).toEqual([]);
    expect(day.orders.flatMap((o) => o.lines).every((l) => l.tracking === 'count' && !l.assetIds && !l.plannedAssetIds)).toBe(true);
    expect(day.vanSpares).toEqual([{ vehicleId: 'v1', productKey: 'night_adult', quantity: 6 }]);
    // 수량으로 세는 규격 품목(의류 · 헬멧)의 줄은 규격이 있다(규격마다 재고, catalog 3): 규격 없는 줄이 없는 규격('')의 재고를 움직이지 않게.
    const sized = day.orders.flatMap((o) => o.lines).filter((l) => l.kind === 'helmet' || l.kind === 'clothes');
    expect(sized.length).toBeGreaterThan(0);
    expect(sized.every((l) => day.registry.kinds.find((k) => k.key === l.kind)!.variants!.some((v) => v.key === l.variantKey))).toBe(true);
    expect(new Set(sized.filter((l) => l.kind === 'helmet').map((l) => l.variantKey))).toEqual(new Set(['소', '중', '대']));
    expect(day.orders.flatMap((o) => o.lines).filter((l) => l.kind !== 'helmet' && l.kind !== 'clothes').every((l) => l.variantKey === undefined)).toBe(true);
    expect(day.settings).toEqual(SHOP_RULES);
    expect(day.registry).toEqual(sampleRegistry());
    expect(day.drawers).toEqual(DRAWERS);
  });

  it('첫 매장의 값: 보증금 규칙 없음 · 반납 필수 · 당일 취소 환불 · 야간 22:00 · 결제 카드 · 현금 · 계좌이체(+ 기타) · 기사 현금 · 계좌이체 · 차량 2대', () => {
    const reg = sampleRegistry();
    expect(SHOP_RULES.liftDeposit).toBeNull();
    expect(SHOP_RULES.liftDepositOff).toBeUndefined();
    expect(SHOP_RULES.liftReturnPolicy).toBe('required');
    expect(SHOP_RULES.sameDayCancelRefund).toBe('refund');
    expect(SHOP_RULES.returnSlots.find((x) => x.key === 'night')).toMatchObject({ label: '야간', hour: 22, minute: 0 });
    expect(Object.values(reg.products).every((p) => p.tracking === 'count')).toBe(true);
    expect(reg.payMethods.filter((m) => m.quick).map((m) => m.label)).toEqual(['카드', '현금', '계좌이체']);
    expect(reg.payMethods.filter((m) => m.driver).map((m) => m.key)).toEqual(['cash', 'transfer']);
    expect(reg.vehicles.map((v) => v.label)).toEqual(['1호 차량', '2호 차량']);
  });

  it('번호 매장 모양(시험): 번호 실물 · 준비 번호 · 1호 차량 예비권 51 ~ 56번, 권 보증금 1매 5,000원', () => {
    const day = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo', shop: 'numbered' });
    expect(day.assets.filter((a) => a.vehicleId === 'v1').map((a) => a.no)).toEqual([...VAN_SPARE.numbers]);
    expect(day.vanSpares).toEqual([]);
    expect(day.settings).toEqual(NUMBERED_SHOP_RULES);
    expect(day.settings.liftDeposit).toMatchObject({ unitAmount: 5_000, methods: ['cash'] });
    const park = day.orders.find((o) => o.id === 'o22')!;
    expect(park.lines.map((l) => [l.tracking, (l.plannedAssetIds ?? []).length])).toEqual([['unit', 2], ['unit', 1], ['unit', 3], ['unit', 3]]);
    expect(day.orders.find((o) => o.id === 'o21')!.lines[0]!.assetIds).toEqual(['ski-1', 'ski-2']);
    expect(day.registry.products.goggles!.tracking).toBe('count');
    // 두 모양은 재고 방식 · 보증금 · 번호 · 수량 줄의 규격만 다르다(팀 · 돈 · 일정은 같다).
    const first = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
    const bare = (s: typeof day) => s.orders.map((o) => ({
      ...o, lines: o.lines.map(({ tracking: _t, assetIds: _a, plannedAssetIds: _p, backAssetIds: _b, variantKey: _v, ...l }) => l),
    }));
    expect(bare(day)).toEqual(bare(first));
    expect(day.orders.flatMap((o) => o.lines).some((l) => l.variantKey !== undefined)).toBe(false);
  });

  it('27일로 부르면 26일의 하루를 꼭 하루 뒤로 옮긴 것이다(날짜를 코드에 박아 두지 않았다)', () => {
    const d26 = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
    const d27 = sampleDay({ date: '2026-12-27', epoch: 'e', ids: 'demo' });
    expect(d27.orders.every((o) => o.receiptNo.startsWith('261227-'))).toBe(true);
    expect(shiftBack(d27)).toEqual(d26);
  });

  it('부를 때마다 새 사본이다(한 하루를 고쳐도 다른 하루 · 견본 값은 그대로)', () => {
    const a = sampleDay({ date: '2026-12-26', epoch: 'a', ids: 'demo' });
    a.settings.openingCash = 1;
    a.registry.vehicles[0]!.label = '가';
    a.vanSpares![0]!.quantity = 0;
    const n = sampleDay({ date: '2026-12-26', epoch: 'a', ids: 'demo', shop: 'numbered' });
    (n.settings.liftDeposit!.methods as string[]).push('card');
    const b = sampleDay({ date: '2026-12-26', epoch: 'b', ids: 'demo' });
    expect(b.settings).toEqual(SHOP_RULES);
    expect(b.registry.vehicles[0]!.label).toBe('1호 차량');
    expect(b.vanSpares![0]!.quantity).toBe(6);
    expect(sampleRules()).toEqual(SHOP_RULES);
    expect(sampleRules('numbered')).toEqual(NUMBERED_SHOP_RULES);
  });
});

describe('견본 명세(sampleSpec)와 직원 예시', () => {
  it('명세는 견본 목록 · 규칙 · 돈통 · 재고를 담는다: 첫 매장은 모든 상품이 수량(규격마다, 규격 없는 상품은 빈 key), 차량 예비권 야간권 6매', () => {
    const spec = sampleSpec();
    expect(spec.shop).toEqual({ code: 'sample', name: '우리 스키샵', cutoff: '06:00', timezone: 'Asia/Seoul' });
    expect(spec.registry).toEqual(sampleRegistry());
    expect(spec.settings).toEqual(SHOP_RULES);
    expect(spec.drawers).toEqual(DRAWERS);
    expect(spec.stock.numbers).toEqual({});
    expect(spec.stock.vehicleSpares).toEqual([]);
    expect(spec.stock.vehicleCounts).toEqual([{ vehicleId: 'v1', productKey: 'night_adult', quantity: 6 }]);
    expect(Object.keys(spec.stock.counts).sort()).toEqual(Object.keys(spec.registry.products).sort());
    expect(spec.stock.counts.ski).toEqual({ [NO_VARIANT]: 120 });
    expect(spec.stock.counts.night_adult).toEqual({ [NO_VARIANT]: 60 });
    expect(Object.keys(spec.stock.counts.clothes!)).toEqual(['90', '95', '100', '105', '110']);
    expect(spec.stock.counts.goggles).toEqual({ 어른: 30, 어린이: 20 });
    expect(spec.season.from < spec.season.to).toBe(true);
  });

  it('번호 매장 모양의 명세: 번호 범위 · 차량 예비권 번호(고글만 수량)', () => {
    const spec = sampleSpec('numbered');
    expect(spec.settings).toEqual(NUMBERED_SHOP_RULES);
    for (const key of Object.keys(spec.stock.numbers)) expect(spec.registry.products[key], key).toBeDefined();
    // 시험 매장의 재고는 견본 하루의 번호를 모두 담는다(여러 날짜를 넣을 수 있게 더 넉넉하다). 야간권은 1호 차량 예비권 앞에서 끝난다.
    for (const [k, [from, to]] of Object.entries(STOCK_NUMBERS)) {
      const [sFrom, sTo] = spec.stock.numbers[k]!;
      expect(sFrom <= from && sTo >= to, k).toBe(true);
    }
    const night = spec.stock.numbers.night_adult!;
    expect(VAN_SPARE.numbers.every((no) => Number(no) > night[1])).toBe(true);
    expect(spec.stock.counts).toEqual({ goggles: { 어른: 30, 어린이: 20 } });
    expect(spec.stock.vehicleSpares).toEqual([{ vehicleId: 'v1', productKey: 'night_adult', numbers: [...VAN_SPARE.numbers] }]);
    expect(spec.stock.vehicleCounts).toEqual([]);
  });

  it('직원 예시는 관리자 · 카운터 · 기사(차량이 있는 기사)이고 이름이 겹치지 않는다', () => {
    expect(SAMPLE_STAFF.map((s) => s.role)).toEqual(['manager', 'counter', 'driver']);
    expect(new Set(SAMPLE_STAFF.map((s) => s.name)).size).toBe(SAMPLE_STAFF.length);
    const vehicles = sampleRegistry().vehicles.map((v) => v.id);
    for (const s of SAMPLE_STAFF) if (s.role === 'driver') expect(vehicles).toContain(s.vehicleKey);
    // 견본 팀(손님) 이름과 겹치지 않는다(로그인 타일과 장부 줄이 헷갈리지 않게).
    const teams = new Set(sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' }).orders.map((o) => o.teamName));
    for (const s of SAMPLE_STAFF) expect(teams.has(s.name), s.name).toBe(false);
  });
});

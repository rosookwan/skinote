// 견본 매장(sample/): 목록 값 · 운영 규칙 · 견본 하루 · 명세 · 직원 예시(plan D14).
import { describe, expect, it } from 'vitest';
import { SAMPLE_STAFF, sampleDay, sampleRegistry, sampleRules, sampleSpec } from '../src/index.ts';
import { DRAWERS, SHOP_RULES, STOCK_NUMBERS, VAN_SPARE } from '../src/sample/index.ts';

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
  it('12월 26일: 18팀 · 접수 번호 261226-0NN · 다음 번호 19 · 번호 실물 · 1호 차량 예비권 6매', () => {
    const day = sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
    expect(day.orders).toHaveLength(18);
    expect(day.orders.every((o) => /^261226-0\d\d$/.test(o.receiptNo))).toBe(true);
    expect(day.nextReceiptSeq).toBe(19);
    expect(day.businessDate).toBe('2026-12-26');
    expect(day.assets.filter((a) => a.vehicleId === 'v1')).toHaveLength(6);
    expect(day.settings).toEqual(SHOP_RULES);
    expect(day.registry).toEqual(sampleRegistry());
    expect(day.drawers).toEqual(DRAWERS);
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
    (a.settings.liftDeposit!.methods as string[]).push('card');
    const b = sampleDay({ date: '2026-12-26', epoch: 'b', ids: 'demo' });
    expect(b.settings).toEqual(SHOP_RULES);
    expect(b.registry.vehicles[0]!.label).toBe('1호 차량');
    expect(sampleRules()).toEqual(SHOP_RULES);
  });
});

describe('견본 명세(sampleSpec)와 직원 예시', () => {
  it('명세는 견본 목록 · 규칙 · 돈통 · 재고를 담는다', () => {
    const spec = sampleSpec();
    expect(spec.shop).toEqual({ code: 'sample', name: '우리 스키샵', cutoff: '06:00', timezone: 'Asia/Seoul' });
    expect(spec.registry).toEqual(sampleRegistry());
    expect(spec.settings).toEqual(SHOP_RULES);
    expect(spec.drawers).toEqual(DRAWERS);
    for (const key of Object.keys(spec.stock.numbers)) expect(spec.registry.products[key], key).toBeDefined();
    // 시험 매장의 재고는 견본 하루의 번호를 모두 담는다(여러 날짜를 넣을 수 있게 더 넉넉하다). 야간권은 1호 차량 예비권 앞에서 끝난다.
    for (const [k, [from, to]] of Object.entries(STOCK_NUMBERS)) {
      const [sFrom, sTo] = spec.stock.numbers[k]!;
      expect(sFrom <= from && sTo >= to, k).toBe(true);
    }
    const night = spec.stock.numbers.night_adult!;
    expect(VAN_SPARE.numbers.every((no) => Number(no) > night[1])).toBe(true);
    expect(spec.stock.counts.goggles).toEqual({ 어른: 30, 어린이: 20 });
    expect(spec.stock.vehicleSpares).toEqual([{ vehicleId: 'v1', productKey: 'night_adult', numbers: [...VAN_SPARE.numbers] }]);
    expect(spec.season.from < spec.season.to).toBe(true);
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

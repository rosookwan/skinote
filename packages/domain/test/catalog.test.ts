// 품목 목록의 순수 셈(apps/pos/test/v2-new-order.test.ts에서 옮김): 초안 품목 정리 · 요금표 견적 · 연락처 글 · 규격 더 보기.
import { describe, expect, it } from 'vitest';
import { cleanItems, liftReturnable, moreLabelOf, phoneText, quoteOf } from '../src/index.ts';
import { KINDS, MAX_QTY, NUMBERED_SHOP_RULES, PRODUCTS, SHOP_RULES, sampleRegistry } from '../src/sample/index.ts';

const REG = sampleRegistry();

describe('품목 목록(견본 매장)', () => {
  it('모르는 상품 · 규격 · 0개는 빼고, 같은 품목은 합치고, 수는 한도까지', () => {
    expect(cleanItems(REG, [
      { productKey: 'ski', quantity: 2 }, { productKey: 'ski', quantity: 1 }, { productKey: 'lesson', quantity: 1 }, { productKey: 'clothes', variantKey: '999', quantity: 1 },
      { productKey: 'clothes', quantity: 1 }, { productKey: 'night_adult', variantKey: '100', quantity: 1 }, { productKey: 'helmet', variantKey: '소', quantity: 0 },
      { productKey: 'board', quantity: 99 },
    ])).toEqual([{ productKey: 'ski', quantity: 3 }, { productKey: 'board', quantity: MAX_QTY }]);
    expect(KINDS.map((k) => k.key)).toEqual(['ski', 'board', 'boots', 'clothes', 'helmet', 'goggles', 'lift']);
    expect(Object.values(PRODUCTS).filter((p) => p.section === 'lift').map((p) => [p.shortLabel, p.price, p.returnSlotKey])).toEqual([
      ['오전권', 45_000, 'morning'], ['오후권', 45_000, 'afternoon'], ['야간권', 35_000, 'night'], ['주간권', 60_000, 'afternoon'], ['종일권', 75_000, 'afternoon'],
    ]);
    // 시안 V2의 초안(이민호 팀: 스키 4 · 의류 95 × 2 · 100 × 1 · 헬멧 중 1 · 야간권 4매).
    const items = [
      { productKey: 'ski', quantity: 4 }, { productKey: 'clothes', variantKey: '95', quantity: 2 }, { productKey: 'clothes', variantKey: '100', quantity: 1 },
      { productKey: 'helmet', variantKey: '중', quantity: 1 }, { productKey: 'night_adult', quantity: 4 },
    ];
    // 첫 매장은 권 보증금이 없다(리조트와 가게 사이의 1,000원은 손님 돈이 아님, 2026-09-26). 보증금을 켠 매장이면 매수 × 1매 값.
    const quote = quoteOf(REG, items, SHOP_RULES);
    expect([quote.gear, quote.lift, quote.total, quote.depositUnits, quote.deposit]).toEqual([225_000, 140_000, 365_000, 0, 0]);
    const withDeposit = quoteOf(sampleRegistry('numbered'), items, NUMBERED_SHOP_RULES);
    expect([withDeposit.gear, withDeposit.lift, withDeposit.total, withDeposit.depositUnits, withDeposit.deposit]).toEqual([225_000, 140_000, 365_000, 4, 20_000]);
    expect(phoneText('01000000042')).toBe('010-0000-0042');
    expect(phoneText('0101234567')).toBe('010-123-4567');
  });

  it('한도와 값은 매장 목록(registry)에서 읽는다: 다른 매장 목록이면 다른 한도 · 값', () => {
    const other = { ...REG, maxLineQuantity: 5, products: { ...REG.products, ski: { ...REG.products.ski!, price: 50_000 } } };
    expect(cleanItems(other, [{ productKey: 'ski', quantity: 9 }])).toEqual([{ productKey: 'ski', quantity: 5 }]);
    expect(quoteOf(other, [{ productKey: 'ski', quantity: 2 }], SHOP_RULES, 2).gear).toBe(200_000);
  });

  it('규격 더 보기는 규격이 한 줄에 다 들어가지 않는 종류(부츠 17개)에만 붙는다', () => {
    expect(KINDS.map((k) => [k.key, moreLabelOf(k) ?? ''])).toEqual([
      ['ski', ''], ['board', ''], ['boots', '규격 더 보기'], ['clothes', ''], ['helmet', ''], ['goggles', ''], ['lift', ''],
    ]);
  });

  it('리프트권 반납 여부는 운영 규칙에서 복사한다', () => {
    expect(liftReturnable(SHOP_RULES)).toBe(true);
    expect(liftReturnable({ liftReturnPolicy: 'optional' })).toBe(false);
  });
});

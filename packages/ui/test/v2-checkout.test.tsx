// 둘째 판 5단계의 부품(work/impl-v2/plan.md Step 5): 접수 확정 창의 결제 칸(MethodRow). 두 줄 칸(제목 줄 글만 + 수단 줄 + `할인 적용 ›`),
// 버튼 없는 한 줄 칸(보증금 현금만), 후불인 칸의 옅은 먹 금액 · 파란 결제 예정, 기타 수단의 두 줄 버튼, 누를 수 없는 후불. 서버 그리기로 본다.
import type { CheckoutSection, ChoiceOption } from '@skinote/contract';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { DeviceProfileProvider, MethodRow, profileCssVars, DEVICE_PROFILES, t } from '../src/index.ts';

const noop = () => {};
const render = (node: ReactElement) => renderToStaticMarkup(<DeviceProfileProvider role="counter" timezone="Asia/Seoul" size={{ width: 1024, height: 600 }}>{node}</DeviceProfileProvider>);
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const option = (key: string, label: string, selected = false, extra: Partial<ChoiceOption> = {}): ChoiceOption => ({ key, label, selected, enabled: true, ...extra });

const GEAR: CheckoutSection = {
  key: 'gear', label: '장비', items: '스키 4 · 의류 3 · 헬멧 1', itemList: ['스키 4', '의류 3', '헬멧 1'], discount: '할인 없음',
  payerNote: '이정호 팀 결제 예정', amount: 225_000, amountMuted: true,
  methods: [option('card', '카드'), option('cash', '현금'), option('transfer', '계좌이체'), option('later', '후불', true), option('other', '기타')],
  discountable: true, choice: { sectionKey: 'gear', methodKey: 'later' },
};

describe('결제 칸(MethodRow)', () => {
  it('두 줄 칸: 제목 줄(이름 · 품목 · 할인 없음 · 파란 결제 예정 · 옅은 먹 금액) + 수단 줄(고른 후불 남색) + 할인 적용 ›', () => {
    const html = render(<MethodRow section={GEAR} onMethod={noop} onDiscount={noop} />);
    expect(visible(html)).toBe('장비 스키 4 · 의류 3 · 헬멧 1 할인 없음 이정호 팀 결제 예정 225,000원 카드 현금 계좌이체 후불 기타 할인 적용 ›');
    expect(html).toContain('<section class="sn-method-row" aria-label="장비">');
    expect(html).toContain('class="sn-method-payer tone-blue"');
    expect(html).toContain('<b class="sn-method-amount is-later">225,000원</b>');
    expect(html).toContain('role="group" aria-label="장비 결제 수단"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>후불</);
    expect(html).toContain('aria-label="장비 할인 적용"');
    expect([t('discountApply'), t('discountApplyFor', { section: '리프트권' }), t('methodsFor', { section: '리프트권' })]).toEqual(['할인 적용', '리프트권 할인 적용', '리프트권 결제 수단']);
  });

  it('기타 수단은 두 줄 버튼(기타 / 간편결제), 누를 수 없는 후불(전화 예약의 리프트권), 할인 상태의 짧은 글', () => {
    const lift: CheckoutSection = {
      ...GEAR, key: 'lift', label: '리프트권', items: '야간권 성인 4매', itemList: ['야간권 성인 4매'], discount: '10% 할인 · 140,000원 → 126,000원', discountShort: '10% 할인',
      amount: 126_000, amountMuted: false,
      methods: [option('card', '카드'), option('cash', '현금'), option('transfer', '계좌이체'), { ...option('later', '후불'), enabled: false }, option('other', '기타', true, { secondLine: '간편결제' })],
      choice: { sectionKey: 'lift', methodKey: 'easy_pay' },
    };
    const { payerNote: _drop, ...plain } = lift;
    const html = render(<MethodRow section={plain} onMethod={noop} onDiscount={noop} />);
    expect(html).toContain('<b class="sn-method-amount">126,000원</b>');
    expect(html).toMatch(/disabled=""[^>]*>후불</);
    expect(html).toContain('class="sn-button sn-choice is-two" aria-pressed="true"');
    expect(visible(html)).toContain('기타 간편결제');
    expect(visible(html)).toContain('10% 할인 · 140,000원 → 126,000원');
    expect(html).not.toContain('tone-blue');
  });

  it('한 줄 칸(보증금 · 수단 하나): 버튼 없이 이름 · 설명 · 받는 돈, 할인 적용 없음', () => {
    const deposit: CheckoutSection = {
      key: 'lift_ticket_card', label: '리프트권 보증금', items: '4매 · 매장 기준 1매 5,000원 · 반납 시 반환', amount: 20_000, amountMuted: false,
      discountable: false, single: [{ text: '현금 20,000원', strong: true }], choice: { sectionKey: 'lift_ticket_card', methodKey: 'cash' },
    };
    const html = render(<MethodRow section={deposit} onMethod={noop} onDiscount={noop} />);
    expect(html).toContain('<section class="sn-method-row is-single" aria-label="리프트권 보증금">');
    expect(visible(html)).toBe('리프트권 보증금 4매 · 매장 기준 1매 5,000원 · 반납 시 반환 현금 20,000원');
    expect(html).not.toContain('<button');
  });

  it('칸 높이는 DeviceProfile의 확정 창 값(두 줄 칸 104 · 결제 팀 줄 64)', () => {
    const vars = profileCssVars(DEVICE_PROFILES.pos);
    expect([vars['--sn-confirm-section-h'], vars['--sn-confirm-payer-h'], vars['--sn-method-min']]).toEqual(['104px', '64px', '110px']);
  });
});

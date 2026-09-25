// 둘째 판 9단계의 부품(work/impl-v2/plan.md Step 9): 매장 설정 · 운영 규칙(V8)의 카드(RuleCard: 제목 · `변경됨` · 이름표 줄 · 고르기 ·
// 값 버튼 `1매 5,000원 ›` · 안내 줄, 한 줄 카드), 카드 높이(ruleCardHeight: 시안 138 · 232 · 112 · 80 · 182), 좁을 때 두 줄 버튼의 짧은
// 이름(`차액 청구`), 숫자판의 받는 값(accept: 범위 밖이면 `입력`이 눌리지 않음). 서버 그리기로 본다.
import type { RuleCard as RuleCardView } from '@skinote/contract';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChoiceButton, DEVICE_PROFILES, DeviceProfileProvider, NumberPad, RuleCard, ruleCardHeight } from '../src/index.ts';

const render = (node: ReactElement) =>
  renderToStaticMarkup(<DeviceProfileProvider role="counter" timezone="Asia/Seoul" deviceClass="pos" size={{ width: 1024, height: 600 }}>{node}</DeviceProfileProvider>);
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const none = () => {};

const option = (key: string, label: string, selected = false, extra: object = {}) => ({ key, label, selected, enabled: true, ...extra });

const RETURN: RuleCardView = {
  key: 'return:lift', title: '리프트권 반납', changed: true, inline: false,
  rows: [{ key: 'item_kinds:lift:return_policy_key', options: [option('required', '반납 필수', true), option('optional', '반납 선택 · 반납 시 기록')] }],
  notes: [[{ text: '반납 필수 · 리프트권 반납 후 완료' }]],
};
const DEPOSIT: RuleCardView = {
  key: 'deposit:lift_ticket_card', title: '리프트권 보증금', changed: false, inline: false,
  rows: [
    {
      key: 'deposit_rules:lift_ticket_card:active', label: '보증금', options: [option('true', '사용', true), option('false', '미사용')],
      value: { label: '1매 5,000원', input: { key: 'deposit_rules:lift_ticket_card:unit_amount', mode: 'amount', title: '리프트권 보증금', min: 100, max: 1_000_000 } },
    },
    { key: 'deposit_rules:lift_ticket_card:timing_key', label: '입금 시점', options: [option('at_intake', '접수 시', true, { secondLine: '미입금: 지급 시' }), option('at_issue', '지급 시')] },
    { key: 'deposit_rules:lift_ticket_card:unreturned_key', label: '미반납 시', options: [option('keep', '보증금 몰수', true), option('charge_loss', '분실금 청구', false, { secondLine: '보증금 공제', short: '차액 청구' })] },
  ],
  notes: [],
};
const PREPAY: RuleCardView = { key: 'prepay', title: '리프트권 결제 · 전화 예약', changed: false, inline: false, rows: [{ key: 'p', options: [option('a', '선입금 전액', true), option('b', '예약금'), option('c', '당일 결제')] }], notes: [] };
const REFUND: RuleCardView = { key: 'refund', title: '당일 취소 환불', changed: false, inline: true, rows: [{ key: 'r', options: [option('refund', '환불', true), option('no', '환불 없음')] }], notes: [] };
const CUTOFF: RuleCardView = {
  key: 'cutoff', title: '영업일 기준 시각', changed: true, inline: false,
  rows: [{ key: 'c', options: [option('00:00', '00:00'), option('03:00', '03:00'), option('06:00', '06:00', true), option('custom', '직접 입력')] }],
  notes: [
    [{ text: '27일 00:15 반납 → ' }, { text: '26일 장부', strong: true }],
    [{ text: '27일 07:00 반납 → ' }, { text: '27일 장부', strong: true }],
    [{ text: '마감 후 기록 · 다음 마감 반영' }],
  ],
};

describe('V8 운영 규칙 카드(RuleCard)', () => {
  it('제목 · 이름표 `변경됨`(바꾼 카드만) · 고르기(남색 = aria-pressed) · 안내 줄', () => {
    const html = render(<RuleCard card={RETURN} onOption={none} onValue={none} />);
    expect(html).toContain('<section class="sn-rule-card" aria-label="리프트권 반납">');
    expect(html).toContain('<h2>리프트권 반납</h2><span class="sn-chip">변경됨</span>');
    expect(html).toContain('aria-pressed="true">반납 필수</button>');
    expect(visible(html)).toBe('리프트권 반납 변경됨 반납 필수 반납 선택 · 반납 시 기록 반납 필수 · 리프트권 반납 후 완료');
    expect(render(<RuleCard card={DEPOSIT} onOption={none} onValue={none} />)).not.toContain('변경됨');
  });

  it('보증금 카드: 이름표 줄 셋(6em 칸), 줄 끝 값 버튼 `1매 5,000원 ›`(고르기가 아님), 두 줄 버튼', () => {
    const html = render(<RuleCard card={DEPOSIT} onOption={none} onValue={none} />);
    expect(html.match(/class="sn-form-row sn-rule-row"/g)).toHaveLength(3);
    expect(html).toContain('<button type="button" class="sn-button sn-rule-value">1매 5,000원 <span class="sn-choice-more">›</span></button>');
    expect(html).toContain('<span>접수 시</span><small>미입금: 지급 시</small>');
    expect(visible(html)).toBe('리프트권 보증금 보증금 사용 미사용 1매 5,000원 › 입금 시점 접수 시 미입금: 지급 시 지급 시 미반납 시 보증금 몰수 분실금 청구 보증금 공제');
  });

  it('한 줄 카드(당일 취소 환불): is-inline, 제목 뒤에 버튼 둘', () => {
    const html = render(<RuleCard card={REFUND} onOption={none} onValue={none} />);
    expect(html).toContain('class="sn-rule-card is-inline"');
    expect(visible(html)).toBe('당일 취소 환불 환불 환불 없음');
  });

  it('영업일 기준 시각의 예시: 장부 날만 굵게', () => {
    const html = render(<RuleCard card={CUTOFF} onOption={none} onValue={none} />);
    expect(html).toContain('<span class="sn-rich sn-rule-note"><span>27일 00:15 반납 → </span><b>26일 장부</b></span>');
  });

  it('카드 높이(ruleCardHeight)는 시안의 값: 138 · 232 · 112 · 80 · 182(pos), 보증금 미사용(버튼 줄 하나 + 한 줄)은 138', () => {
    const pos = DEVICE_PROFILES.pos;
    expect([RETURN, DEPOSIT, PREPAY, REFUND, CUTOFF].map((card) => ruleCardHeight(card, pos))).toEqual([138, 232, 112, 80, 182]);
    const off = { ...DEPOSIT, rows: DEPOSIT.rows.slice(0, 1), notes: [[{ text: '보증금 미사용' }]] };
    expect(ruleCardHeight(off, pos)).toBe(138);
  });
});

describe('V8에서 쓰는 부품 바꿈', () => {
  it('두 줄 버튼도 좁을 때 짧은 이름이 있으면 한 줄(`분실금 청구` / `보증금 공제` → `차액 청구`, 읽는 이름은 온전한 이름)', () => {
    const loss = option('charge_loss', '분실금 청구', false, { secondLine: '보증금 공제', short: '차액 청구' });
    expect(render(<ChoiceButton option={loss} onPress={none} />)).toContain('<span>분실금 청구</span><small>보증금 공제</small>');
    const short = render(<ChoiceButton option={loss} onPress={none} useShort />);
    expect(short).toContain('class="sn-button sn-choice"');
    expect(short).toContain('aria-label="분실금 청구"');
    expect(visible(short)).toBe('차액 청구');
  });

  it('숫자판 accept: 받지 않는 값이면 `입력`이 눌리지 않는다(영업일 기준 시각 12:00)', () => {
    const accept = (d: string) => d.length === 4 && Number(d.slice(0, 2)) * 60 + Number(d.slice(2)) <= 719;
    const off = render(<NumberPad mode="time" title="영업일 기준 시각" value="1200" onChange={none} onSubmit={none} onClose={none} note="00:00 ~ 11:59" accept={accept} />);
    expect(off).toMatch(/<button type="button" class="sn-key is-go" disabled="">입력<\/button>/);
    expect(off).toContain('00:00 ~ 11:59');
    const on = render(<NumberPad mode="time" title="영업일 기준 시각" value="0300" onChange={none} onSubmit={none} onClose={none} accept={accept} />);
    expect(on).toMatch(/<button type="button" class="sn-key is-go">입력<\/button>/);
  });
});

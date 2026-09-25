// 둘째 판 8단계의 부품 쓰임(work/impl-v2/plan.md Step 8): 하루 마감(V6)의 차량 현금 점검 도장(단계 설정 없이 자리 이름 `점검` + 시각 두 줄),
// 이월 항목 윗줄의 늦음 조각(`지연`만 늦음 색), 점검 판의 숫자 키(`000` · `정정`, `입력` 없음). 서버 그리기로 본다.
import type { StampCell } from '@skinote/contract';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeviceProfileProvider, NumberPad, RichLine, StampMark } from '../src/index.ts';

const render = (node: ReactElement) =>
  renderToStaticMarkup(<DeviceProfileProvider role="counter" timezone="Asia/Seoul" deviceClass="pos" size={{ width: 1024, height: 600 }}>{node}</DeviceProfileProvider>);
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('V6 하루 마감의 부품 쓰임', () => {
  it('차량 현금 점검 도장: 단계 설정 없이 자리 이름(`점검`)과 찍은 시각을 도장 안 두 줄로(주홍 타원, 빨강 아님)', () => {
    const cell: StampCell = { stepKey: 'cash_check', state: 'done', label: '점검', at: '2026-12-26T15:32:00.000Z' };
    const html = render(<StampMark cell={cell} step={undefined} />);
    expect(html).toContain('<span class="sn-stamp is-done is-dated"><span class="sn-stamp-text">점검</span><span class="sn-stamp-time">00:32</span></span>');
  });

  it('이월 항목 윗줄: `지연` 조각만 늦음 색(tone-late), 나머지는 먹', () => {
    const html = render(<RichLine runs={[{ text: '리프트권 미반납 · 1매 · ' }, { text: '지연', strong: true, tone: 'red' }]} />);
    expect(html).toContain('<span class="sn-rich"><span>리프트권 미반납 · 1매 · </span><b class="tone-late">지연</b></span>');
  });

  it('점검 판의 숫자 키: 3 × 4(1 ~ 9 · 000 · 0 · 정정), 제목 · 표시 칸 · 입력 없이(판의 주 버튼이 확정)', () => {
    const html = render(<NumberPad mode="amount" title="실제" value="545000" onChange={() => {}} onSubmit={() => {}} placement="inline" keysOnly />);
    expect(visible(html)).toBe('1 2 3 4 5 6 7 8 9 000 0 정정');
    expect(html).toContain('aria-label="실제"');
    expect(html).not.toContain('<output');
  });
});

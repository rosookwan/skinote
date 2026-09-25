// 둘째 판 3단계의 부품(work/impl-v2/plan.md Step 3): 반납 창의 품목 칸(ReturnPieces — 번호 버튼 · 수량 칸 · 번호 선택 버튼, 넓은 칸,
// 옅은 먹, 줄 자리), 칸을 줄 · 쪽으로 나누기(pieceRows · piecePages), 처리 현황의 누르는 줄(Checklist onItemPress). 서버 그리기로 그려 본다.
import type { ChecklistItem, ReturnPieceLine } from '@skinote/contract';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Checklist, DeviceProfileProvider, ReturnPieces, pieceRows, piecePages, profileCssVars, DEVICE_PROFILES } from '../src/index.ts';
import { NOW_MS } from './fixtures.ts';

const noop = () => {};

function render(node: ReactElement): string {
  return renderToStaticMarkup(<DeviceProfileProvider role="counter" timezone="Asia/Seoul" size={{ width: 1024, height: 600 }}>{node}</DeviceProfileProvider>);
}

const visible = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const unit = (lineId: string, label: string, note: string, numbers: [string, boolean][], extra: Partial<ReturnPieceLine> = {}): ReturnPieceLine => ({
  lineId, label, note, mode: 'unit', muted: numbers.every(([, picked]) => !picked), wide: numbers.length >= 4,
  pieces: numbers.map(([no, picked]) => ({ assetId: lineId + '-' + no, label: no + '번', picked })),
  ...extra,
});

/** 시안 V1의 그린 상태(5 · 15 · 33번 뺌). */
const DRAWN: ReturnPieceLine[] = [
  unit('l1', '스키', '설천 2대', [['17', true], ['18', true]]),
  unit('l2', '보드', '두솔동 1대', [['5', false]]),
  unit('l3', '헬멧', '설천 2 · 두솔동 1', [['12', true], ['14', true], ['15', false]]),
  unit('l4', '야간권 성인', '설천 2 · 두솔동 1', [['31', true], ['32', true], ['33', false]]),
];

describe('반납 창의 품목 칸(ReturnPieces)', () => {
  it('칸마다 굵은 이름 · 회색 둘째 줄 · 번호 버튼(고른 번호는 aria-pressed), 하나도 안 고른 칸은 옅은 먹(is-muted), 읽는 이름', () => {
    const html = render(<ReturnPieces rows={pieceRows(DRAWN)} rowCount={2} groupLabel={(l) => l.label + ' 번호'} onPiece={noop} onQuantity={noop} onPicker={noop} />);
    expect(visible(html)).toBe('스키 설천 2대 17번 18번 보드 두솔동 1대 5번 헬멧 설천 2 · 두솔동 1 12번 14번 15번 야간권 성인 설천 2 · 두솔동 1 31번 32번 33번');
    expect(html).toContain('style="grid-template-rows:repeat(2, var(--sn-target))"');
    expect(html).toContain('<div class="sn-piece-line is-muted" role="group" aria-label="보드 번호">');
    expect(html).toContain('<div class="sn-piece-line" role="group" aria-label="스키 번호">');
    expect(html).toMatch(/class="sn-button sn-choice sn-piece" aria-pressed="true">17번</);
    expect(html).toMatch(/class="sn-button sn-choice sn-piece" aria-pressed="false">15번</);
    expect(html).not.toContain('…');
  });

  it('수량으로 세는 칸은 − 값 +(0은 옅은 먹, 끝에서 누를 수 없음), 넓은 칸(is-wide), 번호가 많은 칸은 번호 선택 버튼', () => {
    const goggles: ReturnPieceLine = { lineId: 'g', label: '고글', note: '대여 6개', mode: 'count', muted: true, wide: false, quantity: { value: 0, min: 0, max: 6, unit: '개' } };
    const many = unit('s', '스키', '설천 12대', Array.from({ length: 12 }, (_, i) => [String(20 + i), true] as [string, boolean]), { pickerLabel: '대여 12대 · 번호 선택 ›' });
    const html = render(<ReturnPieces rows={pieceRows([goggles, many])} rowCount={2} groupLabel={(l) => l.label} onPiece={noop} onQuantity={noop} onPicker={noop} />);
    expect(html).toContain('aria-label="수량 감소" disabled=""');
    expect(html).toContain('<output class="sn-qty-value is-zero" aria-live="polite">0개</output>');
    expect(html).toContain('class="sn-piece-line is-wide"');
    expect(html).toContain('<button type="button" class="sn-button sn-choice">대여 12대 · 번호 선택 ›</button>');
    expect(html).not.toContain('20번');
  });

  it('칸을 줄로: 넓은 칸은 혼자 한 줄, 나머지는 둘씩(넓은 칸 앞 홀수 칸은 혼자) · 쪽은 세 줄씩, 칸이 없으면 빈 쪽 하나', () => {
    const wide = unit('w', '스키', '설천 4대', [['1', true], ['2', true], ['3', true], ['4', true]]);
    const [a, b, c, d] = DRAWN as [ReturnPieceLine, ReturnPieceLine, ReturnPieceLine, ReturnPieceLine];
    expect(pieceRows([a, b, c, d]).map((r) => r.map((l) => l.lineId))).toEqual([['l1', 'l2'], ['l3', 'l4']]);
    expect(pieceRows([a, wide, b, c]).map((r) => r.map((l) => l.lineId))).toEqual([['l1'], ['w'], ['l2', 'l3']]);
    const lines = [a, b, c, d, wide, { ...a, lineId: 'x' }, { ...b, lineId: 'y' }];
    expect(piecePages(lines, 3).map((p) => p.map((r) => r.map((l) => l.lineId)))).toEqual([[['l1', 'l2'], ['l3', 'l4'], ['w']], [['x', 'y']]]);
    expect(piecePages([], 3)).toEqual([[]]);
  });

  it('품목 이름 글자는 DeviceProfile이 까는 --sn-font-name(포스 22px = 주 버튼 글자 20 + 2)', () => {
    expect(profileCssVars(DEVICE_PROFILES.pos)['--sn-font-name']).toBe('22px');
    expect(profileCssVars(DEVICE_PROFILES.pos_narrow)['--sn-font-name']).toBe('22px');
  });
});

describe('처리 현황의 누르는 줄(Checklist onItemPress)', () => {
  const stamp = { stepKey: 'return', state: 'delegated' as const, delegatedTo: '1호 차량' };
  const items: ChecklistItem[] = [
    { stepKey: 'order', parts: [{ text: '접수', drop: 0 }], state: 'done', actionKey: 'next_step' },
    { stepKey: 'issue', parts: [{ text: '장비 지급', drop: 0 }], state: 'done', actionKey: 'stamp.issue', stamp: { stepKey: 'issue', state: 'done' } },
    { stepKey: 'return', parts: [{ text: '반납', drop: 0 }, { text: '오늘 22:00', drop: 1 }], second: [{ text: '설천 주차장', drop: 0 }], state: 'later', actionKey: 'stamp.return', stamp },
    { stepKey: 'pay', parts: [{ text: '수납', drop: 0 }, { text: '120,000원', drop: 1 }], state: 'now', actionKey: 'stamp.pay', stamp: { stepKey: 'pay', state: 'partial' } },
  ];

  it('onItemPress를 주면 도장이 있는 끝나지 않은 줄만 줄 전체가 버튼(끝난 일은 한 줄로 접힘), 안 주면 글', () => {
    const pressable = render(<Checklist nowMs={NOW_MS} items={items} onItemPress={noop} />);
    expect(pressable.match(/class="sn-check-press"/g)).toHaveLength(2);
    expect(pressable).toContain('<li class="sn-check is-later is-pressable"><button type="button" class="sn-check-press">');
    expect(pressable).toContain('<li class="sn-check is-now is-pressable" aria-current="step"><button type="button" class="sn-check-press">');
    expect(pressable).toContain('완료 2건');
    const plain = render(<Checklist nowMs={NOW_MS} items={items} />);
    expect(plain).not.toContain('sn-check-press');
    expect(visible(plain)).toBe(visible(pressable));
  });
});

// 둘째 판 6단계의 부품(work/impl-v2/plan.md Step 6): 일괄 수납(V5)의 고르는 칸(SelectCell, 칸 전체 56 × 52가 누르는 곳 · 28px 네모에 체크)과
// 결제 수단 2 × 2(MethodGrid, 고른 것은 남색 · 기타 판의 수단이면 `기타` 두 줄). 서버 그리기로 본다.
import type { ChoiceOption } from '@skinote/contract';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEVICE_PROFILES, DeviceProfileProvider, MethodGrid, SelectCell, profileCssVars } from '../src/index.ts';

const noop = () => {};
const render = (node: ReactElement) => renderToStaticMarkup(<DeviceProfileProvider role="counter" timezone="Asia/Seoul" size={{ width: 1024, height: 600 }}>{node}</DeviceProfileProvider>);
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const option = (key: string, label: string, selected = false, extra: Partial<ChoiceOption> = {}): ChoiceOption => ({ key, label, selected, enabled: true, ...extra });

describe('고르는 칸(SelectCell)', () => {
  it('고름: 칸 전체가 checkbox 버튼(읽는 이름은 부르는 쪽), 네모 안에 체크 그림', () => {
    const html = render(<SelectCell checked label="이정호 · 0032 선택" onToggle={noop} />);
    expect(html).toContain('<button type="button" role="checkbox" aria-checked="true" aria-label="이정호 · 0032 선택" class="sn-select-cell">');
    expect(html).toContain('<span class="sn-select-box" aria-hidden="true"><svg class="sn-icon"');
    expect(visible(html)).toBe('');
  });

  it('안 고름: 빈 네모, 누를 수 없으면 disabled', () => {
    const html = render(<SelectCell checked={false} label="박준호 · 0022 선택" onToggle={noop} disabled />);
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('<span class="sn-select-box" aria-hidden="true"></span>');
  });

  it('크기는 DeviceProfile 변수만(칸 = 누르는 곳 · 줄 높이, 네모 = 제목 글자 + 여백): px 숫자 없음', () => {
    const css = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8');
    const block = css.slice(css.indexOf('.sn-select-cell {'), css.indexOf('.sn-method-grid {'));
    expect(block).toContain('min-width: var(--sn-target)');
    expect(block).toContain('height: var(--sn-row-h)');
    expect(block).toContain('calc(var(--sn-font-title) + var(--sn-space-xs))');
    expect(block).not.toMatch(/\d+px/);
    const vars = profileCssVars(DEVICE_PROFILES.pos);
    expect([vars['--sn-target'], vars['--sn-row-h'], vars['--sn-font-title'], vars['--sn-space-xs']]).toEqual(['52px', '52px', '24px', '4px']);
  });
});

describe('결제 수단 2 × 2(MethodGrid)', () => {
  it('카드(고름, 남색) · 현금 · 계좌이체 · 기타, 묶음 읽는 이름', () => {
    const html = render(<MethodGrid options={[option('card', '카드', true), option('cash', '현금'), option('transfer', '계좌이체'), option('other', '기타')]} label="결제 수단" onPress={noop} />);
    expect(html).toContain('<div class="sn-method-grid" role="group" aria-label="결제 수단">');
    expect(visible(html)).toBe('카드 현금 계좌이체 기타');
    expect(html).toMatch(/aria-pressed="true"[^>]*>카드</);
    expect((html.match(/class="sn-button sn-choice"/g) ?? []).length).toBe(4);
  });

  it('기타 판의 수단을 고르면 `기타` 두 줄(기타 / 간편결제)', () => {
    const html = render(<MethodGrid options={[option('card', '카드'), option('cash', '현금'), option('transfer', '계좌이체'), option('other', '기타', true, { secondLine: '간편결제' })]} label="결제 수단" onPress={noop} />);
    expect(html).toContain('class="sn-button sn-choice is-two" aria-pressed="true"');
    expect(visible(html)).toBe('카드 현금 계좌이체 기타 간편결제');
  });
});

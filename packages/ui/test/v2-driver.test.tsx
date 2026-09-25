// 둘째 판 7단계의 부품(work/impl-v2/plan.md Step 7): 기사 업무 판(V7)의 큰 옆 버튼(BigButton: 선 그림 위 · 큰 글 아래, 휴대폰은 한 줄),
// 지폐 · 권 · 금지 그림(24 격자 · 선 2), 도장의 자리 이름(StampCell.label: 기사 기기의 차량 배달 = `배달`), 숫자 키만 있는 숫자판(현장 수납 판),
// 아래 판 높이와 품목 줄 범위(DeviceProfile fill). 서버 그리기로 본다.
import type { StampCell, StampStepRow } from '@skinote/contract';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BigButton, DEVICE_PROFILES, DeviceProfileProvider, Icon, NumberPad, Stamp, profileCssVars, stampLabel, stampWord } from '../src/index.ts';

const noop = () => {};
const render = (node: ReactElement, device: 'driver_tablet' | 'driver_phone' = 'driver_tablet') =>
  renderToStaticMarkup(<DeviceProfileProvider role="driver" timezone="Asia/Seoul" deviceClass={device} size={{ width: 1024, height: 600 }}>{node}</DeviceProfileProvider>);
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const ISSUE: StampStepRow = {
  key: 'issue', label: '지급', short_label: null, stamp_text: '지급', checklist_label: '장비 지급', rule_key: 'qty_issued', action_key: 'stamp.issue',
  required_permission_key: null, urgency_out: 20, urgency_back: 0, tone_key: 'seal', shows_time: 0, feature_key: null, sort: 20,
};

describe('큰 옆 버튼(BigButton)', () => {
  it('그림 위 · 이름 아래 · 둘째 줄(`리프트권 추가` / `야간권 재고 6매`), 읽는 이름은 두 줄을 잇는다', () => {
    const html = render(<BigButton icon="ticket" label="리프트권 추가" secondLine="야간권 재고 6매" onPress={noop} />);
    expect(html).toContain('<button type="button" class="sn-button sn-big-button" aria-label="리프트권 추가 · 야간권 재고 6매">');
    expect(html).toContain('<svg class="sn-icon"');
    expect(visible(html)).toBe('리프트권 추가 야간권 재고 6매');
    expect(html).toContain('class="sn-fit sn-big-second"');
  });

  it('누를 수 없으면 disabled이고 읽는 이름에 까닭, 휴대폰은 한 줄로 누운 버튼(is-row)', () => {
    const off = render(<BigButton icon="ban" label="배달 실패" disabled reason="배달 완료" onPress={noop} />);
    expect(off).toContain('disabled=""');
    expect(off).toContain('aria-label="배달 실패 · 배달 완료"');
    const row = render(<BigButton icon="money" label="현장 수납" layout="row" onPress={noop} />, 'driver_phone');
    expect(row).toContain('class="sn-button sn-big-button is-row"');
  });

  it('지폐 · 권 · 금지 그림(시안 V7의 선 그림, 24 격자)', () => {
    for (const name of ['money', 'ticket', 'ban'] as const) {
      const html = renderToStaticMarkup(<Icon name={name} />);
      expect(html).toMatch(/^<svg class="sn-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">/);
      expect(html.length).toBeGreaterThan(90);
    }
  });

  it('모양은 DeviceProfile 변수만(px 숫자 없음): 이름은 큰 글자, 둘째 줄은 본문 글자', () => {
    const css = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8');
    const block = css.slice(css.indexOf('.sn-big-button {'));
    expect(block).toContain('font-size: var(--sn-font-big)');
    expect(block).toContain('.sn-big-second { font-size: var(--sn-font-body)');
    expect(block).not.toMatch(/\d+px/);
  });
});

describe('도장의 자리 이름(StampCell.label)', () => {
  it('기사 기기의 차량 배달: 도장 글자 · 읽는 이름이 `배달`(단계 설정의 `지급` 대신)', () => {
    const todo: StampCell = { stepKey: 'issue', state: 'todo', label: '배달' };
    const done: StampCell = { stepKey: 'issue', state: 'done', label: '배달', at: '2026-12-26T07:57:00.000Z' };
    expect(stampLabel(todo, ISSUE)).toBe('배달 미처리');
    expect(stampWord(done, ISSUE)).toBe('배달 완료');
    const html = render(<Stamp cell={done} step={ISSUE} onPress={noop} />);
    expect(html).toContain('aria-label="배달 완료 16:57"');
    expect(visible(html)).toBe('배달 16:57');
    const labelled = render(<Stamp cell={todo} step={ISSUE} labelled />);
    expect(visible(labelled)).toBe('배달');
  });

  it('이름이 없으면 단계 설정 그대로(카운터의 `지급`)', () => {
    const html = render(<Stamp cell={{ stepKey: 'issue', state: 'done', at: '2026-12-26T07:57:00.000Z' }} step={ISSUE} />);
    expect(visible(html)).toBe('지급 16:57');
  });
});

describe('숫자 키만 있는 숫자판(NumberPad keysOnly)', () => {
  it('제목 · 표시 칸 · 입력 없이 키만(읽는 이름은 제목), 금액 모드의 000 · 0 · 정정', () => {
    const html = render(<NumberPad mode="amount" title="금액" value="35000" onChange={noop} onSubmit={noop} placement="inline" keysOnly />);
    expect(html).toContain('<section class="sn-keypad sn-numpad is-inline is-keys" aria-label="금액">');
    expect(html).not.toContain('<output');
    expect(html).not.toContain('<h2');
    expect(visible(html)).toBe('1 2 3 4 5 6 7 8 9 000 0 정정');
  });
});

describe('품목 줄 · 아래 판의 크기(DeviceProfile fill)', () => {
  it('기사 태블릿 60 ~ 88(spec 3-8), 휴대폰은 누르는 곳 56부터, 포스 52 ~ 88(V6), 아래 판 440(ui 6-5)', () => {
    expect(DEVICE_PROFILES.driver_tablet.fill).toEqual({ rowMinPx: 60, rowMaxPx: 88, panelMaxPx: 440 });
    expect(DEVICE_PROFILES.driver_phone.fill).toEqual({ rowMinPx: 56, rowMaxPx: 88, panelMaxPx: 440 });
    expect(DEVICE_PROFILES.pos.fill).toEqual({ rowMinPx: 52, rowMaxPx: 88, panelMaxPx: 440 });
    expect(DEVICE_PROFILES.driver_phone.fill.rowMinPx).toBeGreaterThanOrEqual(DEVICE_PROFILES.driver_phone.minTargetPx);
    expect(profileCssVars(DEVICE_PROFILES.driver_tablet)['--sn-panel-max']).toBe('440px');
  });
});

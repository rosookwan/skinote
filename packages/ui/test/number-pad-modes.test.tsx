// 숫자판의 서버 연결 모드(계획 work/impl-server/plan.md A3 · §10): 기기 등록 번호(code, 12자리를 넷씩 끊음, 열두 자리일 때만 `입력`)와
// 직원 비밀번호(pin, 가린 표시 ● ● ● ●, 숫자는 어디에도 없음, 네 ~ 여섯 자리일 때만 `입력`). 자리 수는 계약과 같다. 서버 그리기로 본다.
import { ENROLL_CODE_DIGITS, PIN_MAX_DIGITS, PIN_MIN_DIGITS } from '@skinote/contract';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  DeviceProfileProvider, NUMBER_PAD_DIGITS, NUMBER_PAD_PIN_MIN, NumberPad, formatEnrollDigits, formatPinMask, numberPadReady, numberPadText,
} from '../src/index.ts';

const noop = () => {};
const render = (node: ReactElement) => renderToStaticMarkup(<DeviceProfileProvider role="counter" timezone="Asia/Seoul" size={{ width: 1024, height: 600 }}>{node}</DeviceProfileProvider>);
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('등록 번호(code)', () => {
  it('넷씩 끊어 보인다(치는 동안에도), 열두 자리까지', () => {
    expect(['', '1', '1234', '12345', '12345678', '123456789', '123456789012', '1234567890123', '1234-5678-9012'].map(formatEnrollDigits)).toEqual([
      '', '1', '1234', '1234-5', '1234-5678', '1234-5678-9', '1234-5678-9012', '1234-5678-9012', '1234-5678-9012',
    ]);
    expect(numberPadText('code', '12345678')).toBe('1234-5678');
  });

  it('열두 자리일 때만 입력, 화면 안의 판(닫기 없음)', () => {
    const partial = render(<NumberPad mode="code" title="등록 번호" value="12345678901" onChange={noop} onSubmit={noop} placement="inline" />);
    expect(partial).toMatch(/class="sn-key is-go" disabled="">입력</);
    expect(partial).toContain('data-mode="code"');
    expect(visible(partial)).toBe('등록 번호 1234-5678-901 1 2 3 4 5 6 7 8 9 정정 0 입력');
    const full = render(<NumberPad mode="code" title="등록 번호" value="123456789012" onChange={noop} onSubmit={noop} placement="inline" note="등록 번호 불일치 · 재입력 필요" />);
    expect(full).toMatch(/class="sn-key is-go">입력</);
    expect(visible(full)).toContain('1234-5678-9012 등록 번호 불일치 · 재입력 필요');
    expect(full).not.toContain('sn-sheet-overlay');
    expect([numberPadReady('code', '12345678901'), numberPadReady('code', '123456789012')]).toEqual([false, true]);
  });
});

describe('비밀번호(pin)', () => {
  it('가린 표시: 자리 수만큼 ●, 숫자는 표시 칸에 없다', () => {
    expect([formatPinMask(0), formatPinMask(1), formatPinMask(4), formatPinMask(6)]).toEqual(['', '●', '● ● ● ●', '● ● ● ● ● ●']);
    const html = render(<NumberPad mode="pin" title="김카운터 · 비밀번호" value="4821" onChange={noop} onSubmit={noop} onClose={noop} />);
    const output = /<output[^>]*>([^<]*)<\/output>/.exec(html);
    expect(output?.[1]).toBe('● ● ● ●');
    expect(html).toContain('is-masked');
    expect(html).not.toMatch(/4821/);
    expect(html).toContain('class="sn-sheet-overlay" role="dialog" aria-modal="true"');
    expect(visible(html)).toBe('김카운터 · 비밀번호 ● ● ● ● 1 2 3 4 5 6 7 8 9 정정 0 입력 닫기');
  });

  it('네 ~ 여섯 자리일 때만 입력, 여섯 자리 넘게는 치지 않는다', () => {
    expect(['', '123', '1234', '12345', '123456', '1234567'].map((d) => numberPadReady('pin', d))).toEqual([false, false, true, true, true, false]);
    expect(render(<NumberPad mode="pin" title="비밀번호" value="123" onChange={noop} onSubmit={noop} onClose={noop} />)).toMatch(/class="sn-key is-go" disabled="">입력</);
    expect(numberPadText('pin', '1234567'.slice(0, NUMBER_PAD_DIGITS.pin))).toBe('● ● ● ● ● ●');
  });

  it('자리 수는 계약(기기 등록 · 로그인 본문 검사)과 같다', () => {
    expect([NUMBER_PAD_DIGITS.code, NUMBER_PAD_DIGITS.pin, NUMBER_PAD_PIN_MIN]).toEqual([ENROLL_CODE_DIGITS, PIN_MAX_DIGITS, PIN_MIN_DIGITS]);
  });
});

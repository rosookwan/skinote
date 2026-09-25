// 둘째 판 4단계의 부품(work/impl-v2/plan.md Step 4): 새 접수 종류 타일(KindTile), 두 줄 목록 줄(ListRow2), 작은 이름표(Tag), 숫자판
// (NumberPad: 연락처 · 금액 · 시각), 장소 고르기의 작은 창 길(onArea) · 매장 직접 없는 줄(store false), 숫자 모양(연락처 · 시각). 서버 그리기로 본다.
import type { KindTile as KindTileView, PlaceArea } from '@skinote/contract';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  DeviceProfileProvider, KindTile, ListRow2, NUMBER_PAD_DIGITS, NumberPad, PlaceChooser, Tag, formatPhone, formatTimeDigits, numberPadReady, numberPadText,
  t, timeFromDigits,
} from '../src/index.ts';

const noop = () => {};
const render = (node: ReactElement) => renderToStaticMarkup(<DeviceProfileProvider role="counter" timezone="Asia/Seoul" size={{ width: 1024, height: 600 }}>{node}</DeviceProfileProvider>);
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('종류 타일(KindTile)', () => {
  it('이름 · 둘째 줄 · 고른 수(읽는 이름 선택 N), 연 종류는 aria-expanded와 아래 갈매기', () => {
    const tile: KindTileView = { key: 'clothes', label: '의류', secondLine: '1일 20,000원', secondShort: '20,000원', count: 3, open: true };
    const html = render(<KindTile tile={tile} onPress={noop} />);
    expect(html).toContain('class="sn-button sn-kind" aria-expanded="true"');
    expect(visible(html)).toBe('의류 1일 20,000원 3');
    expect(html).toContain('aria-label="선택 3"');
    expect(html).toContain('<path d="m6 9 6 6 6-6"></path>');
    const plain = render(<KindTile tile={{ key: 'board', label: '보드', secondLine: '1일 25,000원', open: false }} onPress={noop} />);
    expect(plain).toContain('aria-expanded="false"');
    expect(plain).not.toContain('sn-kind-end');
    expect(t('pickedCount', { n: 4 })).toBe('선택 4');
  });
});

describe('두 줄 목록 줄 · 이름표', () => {
  it('누르는 줄은 줄 전체가 버튼, 금액은 윗줄 오른쪽, 품목 목록 둘째 줄', () => {
    const pressable = render(<ul><ListRow2 title="스키 4대" note="부츠 · 폴 포함" amount="160,000원" onPress={noop} /></ul>);
    expect(pressable).toContain('<li class="sn-list-row is-pressable"><button type="button" class="sn-list-main sn-list-press">');
    expect(visible(pressable)).toBe('스키 4대 160,000원 부츠 · 폴 포함');
    const plain = render(<ul><ListRow2 title="장비 225,000원" note="스키 4 · 의류 3 · 헬멧 1" items={['스키 4', '의류 3', '헬멧 1']} /></ul>);
    expect(plain).not.toContain('<button');
    expect(visible(plain)).toBe('장비 225,000원 스키 4 · 의류 3 · 헬멧 1');
    expect(render(<Tag text="전화 예약" tone="blue" />)).toContain('<span class="sn-chip is-blue">전화 예약</span>');
    expect(render(<Tag text="결제 팀" />)).toContain('<span class="sn-chip">결제 팀</span>');
  });
});

describe('숫자판(NumberPad)', () => {
  it('연락처: 3 × 4 키(정정 · 0 · 입력), 표시는 010-0000-0042, 아래 판에는 닫기', () => {
    const html = render(<NumberPad mode="phone" title="연락처" value="01000000042" onChange={noop} onSubmit={noop} onClose={noop} />);
    expect(html).toContain('class="sn-sheet-overlay" role="dialog" aria-modal="true"');
    expect(html).toContain('>010-0000-0042</output>');
    expect(visible(html)).toBe('연락처 010-0000-0042 1 2 3 4 5 6 7 8 9 정정 0 입력 닫기');
    expect(html).not.toContain('000<');
  });

  it('금액은 000 키와 줄 전체의 입력, 시각은 네 자리일 때만 입력(화면 안의 판에는 닫기 없음)', () => {
    const amount = render(<NumberPad mode="amount" title="현금" value="160000" onChange={noop} onSubmit={noop} placement="inline" />);
    expect(visible(amount)).toBe('현금 160,000원 1 2 3 4 5 6 7 8 9 000 0 정정 입력');
    expect(amount).toContain('class="sn-key is-go is-wide"');
    expect(amount).not.toContain('sn-sheet-overlay');
    const time = render(<NumberPad mode="time" title="수령 시각" value="172" onChange={noop} onSubmit={noop} onClose={noop} />);
    expect(time).toContain('>17:2_</output>');
    expect(time).toMatch(/class="sn-key is-go" disabled="">입력</);
    expect([numberPadReady('time', '1720'), numberPadReady('time', '172'), numberPadReady('phone', ''), numberPadReady('amount', '')]).toEqual([true, false, true, true]);
    expect(NUMBER_PAD_DIGITS).toEqual({ phone: 11, amount: 9, time: 4, code: 12, pin: 6 });
    expect([numberPadText('amount', ''), numberPadText('time', ''), numberPadText('phone', '010')]).toEqual(['', '__:__', '010']);
  });

  it('숫자 모양: 연락처(치는 동안 · 10자리 · 11자리), 시각', () => {
    expect(['010', '0100', '0100000', '01000000', '0101234567', '01000000042', '010-0000-0042'].map(formatPhone)).toEqual([
      '010', '010-0', '010-0000', '010-000-00', '010-123-4567', '010-0000-0042', '010-0000-0042',
    ]);
    expect([formatTimeDigits('1'), formatTimeDigits('1720')]).toEqual(['1_:__', '17:20']);
    expect([timeFromDigits('1720'), timeFromDigits('172')]).toEqual(['17:20', null]);
  });
});

describe('장소 고르기의 새 접수 길', () => {
  const AREAS: PlaceArea[] = [
    { key: 'manseon', label: '만선', lodging: false, places: [{ key: 'manseon_plaza', label: '만선 광장' }] },
    { key: 'solmaeul', label: '솔마을', lodging: true, places: [{ key: 'dusol', label: '두솔동' }] },
  ];
  it('store false면 매장 직접 없이 구역만, 고른 구역은 두 줄', () => {
    const html = render(<PlaceChooser areas={AREAS} place={{ mode: 'vehicle', placeKey: 'manseon_plaza' }} store={false} label="배달 장소" onPick={noop} onArea={noop} />);
    expect(visible(html)).toBe('만선 만선 광장 솔마을 ›');
    expect(visible(render(<PlaceChooser areas={AREAS} place={{ mode: 'store' }} label="반납 장소" onPick={noop} onArea={noop} />))).toBe('매장 직접 만선 › 솔마을 ›');
  });
});

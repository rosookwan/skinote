// 둘째 판 2단계의 부품(work/impl-v2/plan.md Step 2): 고르기 버튼 · 이름표 줄 · 수량 칸 · 반납 시각 · 장소 고르기 · 글 조각 줄 · 틀이
// 따로인 확인 창, 그리고 접수증 일정 줄의 나뉜 일정('반납 일정 2건 ›')과 처리 현황의 둘째 줄(장소). 서버 그리기로 그려 본다.
import { resolveLedgerView, stampStepMap, uiDefaults, visibleView, DEFAULT_FEATURES, type ChoiceOption, type OrderSlip, type PlaceArea } from '@skinote/contract';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  Checklist, ChoiceButton, ChoiceRow, DeviceProfileProvider, DialogFrame, FormRow, PlaceChooser, PrimaryButton, QtyStepper, RichLine, Slip,
  SlotChooser,
} from '../src/index.ts';
import type { Size } from '../src/device-profile.ts';
import { NOW_MS, kst, orderSlip } from './fixtures.ts';

const noop = () => {};

function render(node: ReactElement, size: Size = { width: 1024, height: 600 }): string {
  return renderToStaticMarkup(<DeviceProfileProvider role="counter" timezone="Asia/Seoul" size={size}>{node}</DeviceProfileProvider>);
}

/** 보이는 글(태그를 빼고 줄바꿈 하나로). */
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const SLOTS: ChoiceOption[] = [
  { key: 'morning', label: '오전타임 후 12:00', short: '12:00', selected: false, enabled: false, reason: '선택 불가 · 시간 지남' },
  { key: 'night', label: '야간 22:00', short: '22:00', selected: true, enabled: true },
];
const DAYS: ChoiceOption[] = [
  { key: 'tomorrow', label: '내일', selected: false, enabled: true },
  { key: 'other', label: '다른 날', opens: true, selected: false, enabled: true },
];
const AREAS: PlaceArea[] = [
  { key: 'seolcheon', label: '설천', lodging: false, places: [{ key: 'seolcheon_parking', label: '설천 주차장' }] },
  { key: 'solmaeul', label: '솔마을', lodging: true, places: [{ key: 'hansol', label: '한솔동' }, { key: 'dusol', label: '두솔동' }] },
];

describe('고르기 버튼 · 줄', () => {
  it('고름은 aria-pressed(남색), 누를 수 없음은 disabled와 까닭의 읽는 이름, 열리는 버튼은 글 뒤 ›(글자), 두 줄 버튼', () => {
    const html = render(<SlotChooser slots={SLOTS} days={DAYS} label="반납 시각" names={{ other: '다른 날 · 날짜 선택' }} onSlot={noop} onDay={noop} />);
    expect(html).toContain('role="group" aria-label="반납 시각"');
    expect(html).toMatch(/aria-pressed="false" disabled="" aria-label="오전타임 후 12:00 · 선택 불가 · 시간 지남"/);
    expect(html).toMatch(/aria-pressed="true">야간 22:00</);
    expect(html).toContain('aria-label="다른 날 · 날짜 선택">다른 날 <span class="sn-choice-more">›</span>');
    const two = render(<ChoiceButton option={{ key: 'solmaeul', label: '솔마을', secondLine: '두솔동', selected: true, enabled: true }} name="솔마을 두솔동 · 장소 다시 선택" onPress={noop} />);
    expect(two).toContain('class="sn-button sn-choice is-two"');
    expect(two).toContain('<span>솔마을</span><small>두솔동</small>');
    // 짧은 이름으로 보일 때 읽는 이름은 온전한 이름.
    const short = render(<ChoiceButton option={SLOTS[1]!} useShort onPress={noop} />);
    expect(short).toContain('aria-label="야간 22:00">22:00<');
    expect(render(<ChoiceRow options={DAYS} label="날" onPress={noop} />)).not.toContain('더 보기');
  });

  it('장소 고르기: 매장 직접 + 구역 ›, 고른 구역은 두 줄(구역 / 장소)과 다시 고르는 읽는 이름', () => {
    const areas = render(<PlaceChooser areas={AREAS} place={{ mode: 'vehicle', placeKey: 'seolcheon_parking' }} label="반납 장소" againName={(p) => p + ' · 장소 다시 선택'} onPick={noop} />);
    expect(visible(areas)).toBe('매장 직접 설천 설천 주차장 솔마을 ›');
    expect(areas).toContain('aria-label="설천 주차장 · 장소 다시 선택"');
    const lodging = render(<PlaceChooser areas={AREAS} place={{ mode: 'vehicle', placeKey: 'dusol' }} label="반납 장소" againName={(p) => p + ' · 장소 다시 선택'} onPick={noop} />);
    expect(visible(lodging)).toBe('매장 직접 설천 › 솔마을 두솔동');
    expect(lodging).toContain('aria-label="솔마을 두솔동 · 장소 다시 선택"');
    const store = render(<PlaceChooser areas={AREAS} place={{ mode: 'store' }} label="반납 장소" onPick={noop} />);
    expect(store).toMatch(/aria-pressed="true">매장 직접</);
  });

  it('이름표 줄: 이름표 칸 + 내용, 자리만 남기는 줄(is-blank · 읽지 않음)', () => {
    expect(render(<FormRow label="반납 시각"><span>내용</span></FormRow>)).toContain('<div class="sn-form-row"><span class="sn-form-label">반납 시각</span><div class="sn-form-value"><span>내용</span></div></div>');
    const blank = render(<FormRow label="수거 차량" blank><span>1호 차량</span></FormRow>);
    expect(blank).toContain('class="sn-form-row is-blank" aria-hidden="true"');
  });

  it('수량 칸: 이름 · 둘째 줄 · − · 값 · +, 0은 옅은 먹, 끝에서는 누를 수 없음', () => {
    const html = render(<QtyStepper name="스키" note="대여 2대" quantity={{ value: 0, min: 0, max: 2, unit: '대' }} label="스키 수량" onChange={noop} />);
    expect(html).toContain('role="group" aria-label="스키 수량"');
    // 둘째 줄은 글 맞춤(좁으면 ' · ' 조각을 뒤에서부터 뺀다).
    expect(html).toContain('<b>스키</b><small><span class="sn-fit">대여 2대</span></small>');
    expect(html).toMatch(/aria-label="수량 감소" disabled=""/);
    expect(html).toContain('class="sn-qty-value is-zero"');
    expect(html).toContain('>0대<');
    const full = render(<QtyStepper name="보드" note="대여 1대" quantity={{ value: 1, min: 0, max: 1, unit: '대' }} label="보드 수량" onChange={noop} />);
    expect(full).toMatch(/aria-label="수량 증가" disabled=""/);
    expect(full).not.toContain('is-zero');
  });

  it('글 조각 줄: 굵은 조각은 b, 색은 tone(빨강은 늦음 색 tone-late로만)', () => {
    const html = render(<RichLine runs={[{ text: '보드 1: 22:00 설천 주차장 → ' }, { text: '22:00 솔마을 두솔동', strong: true }, { text: ' · 지연', tone: 'red' }, { text: '없음', tone: 'grey' }]} />);
    expect(html).toContain('<span class="sn-rich"><span>보드 1: 22:00 설천 주차장 → </span><b>22:00 솔마을 두솔동</b><span class="tone-late"> · 지연</span><span class="tone-grey">없음</span></span>');
  });
});

describe('틀이 따로인 확인 창(DialogFrame)', () => {
  it('1024×600: 폭 860 · 최대 높이 552, 바닥줄은 닫기 · 쪽 넘김 · 주 버튼 하나, 요청번호', () => {
    const html = render(
      <DialogFrame title="일정 변경 · 박준호 팀" onClose={noop} requestId="01JF3Q8W2Z6N9XK4T7B5R1C0DM" pager={<span>1 / 2쪽</span>} primary={<PrimaryButton label="일정 변경" onPress={noop} />}>
        <p>본문</p>
      </DialogFrame>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('width:860px;max-height:552px');
    expect(html).toContain('data-request-id="01JF3Q8W2Z6N9XK4T7B5R1C0DM"');
    expect(html).toContain('<div class="sn-dialog-pager"><span>1 / 2쪽</span></div>');
    expect(html.match(/data-primary="true"/g)).toHaveLength(1);
    expect(visible(html)).toContain('닫기');
  });

  it('1024×529(설치한 앱): 최대 높이 505(위아래 여백 12), 875×600: 폭 811', () => {
    expect(render(<DialogFrame title="" onClose={noop}><p /></DialogFrame>, { width: 1024, height: 529 })).toContain('max-height:505px');
    expect(render(<DialogFrame title="" onClose={noop}><p /></DialogFrame>, { width: 875, height: 600 })).toContain('width:811px');
  });
});

describe('접수증 · 처리 현황의 나뉜 일정', () => {
  const slipView = visibleView(resolveLedgerView(uiDefaults.ledger_views, 'order_slip', 'pos')!, DEFAULT_FEATURES);
  const steps = stampStepMap(uiDefaults.stamp_steps, DEFAULT_FEATURES);

  it('반납 일정이 둘로 나뉘면 일정 줄은 수령 16:00 · 매장 · 반납 일정 2건(누르는 곳이 아니라 `›` 없음, 일정 변경은 옆 동작)', () => {
    const split: OrderSlip = {
      ...orderSlip,
      promises: {
        distinct: 2,
        lines: [
          { kind: 'pickup', at: kst(16, 0), parts: [{ text: '매장', drop: 1 }] },
          { kind: 'return', at: kst(22, 0), parts: [{ text: '설천 주차장', drop: 1 }, { text: '1호 차량', drop: 2 }], count: 2 },
        ],
      },
    };
    const html = render(<Slip slip={split} view={slipView} steps={steps} nowMs={NOW_MS} itemsPage={0} tableSize={{ width: 664, height: 244 }} />);
    expect(html).toContain('>수령 16:00 · 매장 · 반납 일정 2건<');
    expect(html).not.toContain('2건 ›');
  });

  it('처리 현황: 반납은 둘째 줄에 장소(second), 차례는 읽기 모델 그대로(차량이 할 반납이 지금 할 수납 위)', () => {
    const html = render(<Checklist nowMs={NOW_MS} items={[
      { stepKey: 'order', parts: [{ text: '접수', drop: 0 }], state: 'done', actionKey: 'next_step' },
      { stepKey: 'return', parts: [{ text: '반납', drop: 0 }, { text: '오늘 22:00', drop: 1 }], second: [{ text: '설천 주차장', drop: 0 }, { text: '솔마을 두솔동', drop: 1 }], state: 'later', actionKey: 'stamp.return' },
      { stepKey: 'pay', parts: [{ text: '수납', drop: 0 }, { text: '120,000원', drop: 1 }], state: 'now', actionKey: 'stamp.pay' },
    ]} />);
    expect(html).toContain('<span class="sn-fit sn-check-items">설천 주차장 · 솔마을 두솔동</span>');
    expect(html.indexOf('반납 · 오늘 22:00')).toBeGreaterThan(0);
    expect(html.indexOf('반납 · 오늘 22:00')).toBeLessThan(html.indexOf('수납 · 120,000원'));
  });
});

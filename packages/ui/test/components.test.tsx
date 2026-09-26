// 부품을 서버 그리기(renderToStaticMarkup)로 그려 본다: 설정 · 읽기 모델만으로 그려지는지, 문구 · 모양 규칙.
// 잰 크기는 size 값으로 고정한다(브라우저 크기 규칙 검사는 Playwright 촬영 몫).
import { menuFor, resolveLedgerView, stampStepMap, uiDefaults, visibleView, DEFAULT_FEATURES, type LedgerViewResult } from '@skinote/contract';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  AppHeader, Checklist, ConfirmDialog, ConnectionStrip, DeviceProfileProvider, FooterBar, IndexTabs, Keypad, Ledger, Pager, PinBar,
  PrimaryButton, RowActionBar, Slip, Stamp, confirmLabelAlts, paymentParts, fillTitle, fitLines, keypadKeyAction, rowBarSteps, typingIn, type RowAction,
} from '../src/index.ts';
import type { DeviceRole, Size } from '../src/device-profile.ts';
import { collectionList, dayLedger, NOW_MS, kst, orderSlip } from './fixtures.ts';

const steps = stampStepMap(uiDefaults.stamp_steps, DEFAULT_FEATURES);
const noop = () => {};

function render(node: ReactElement, size: Size = { width: 1024, height: 600 }, role: DeviceRole = 'counter'): string {
  return renderToStaticMarkup(<DeviceProfileProvider role={role} timezone="Asia/Seoul" size={size}>{node}</DeviceProfileProvider>);
}

/** 보이는 글자(태그 사이)와 읽는 이름(aria-label). */
function visibleText(html: string): string {
  const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
  const text = html.replace(/<[^>]+>/g, '\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
  return [text, ...labels].join('\n');
}

function expectPlainKorean(html: string) {
  const text = visibleText(html);
  expect(text).not.toContain('…');
  expect(text).not.toMatch(/[A-Za-z]/);
}

const ledgerView = visibleView(resolveLedgerView(uiDefaults.ledger_views, 'day_ledger', 'pos')!, DEFAULT_FEATURES);
const driverView = visibleView(resolveLedgerView(uiDefaults.ledger_views, 'collection_list', 'driver_tablet')!, DEFAULT_FEATURES);
const phoneView = visibleView(resolveLedgerView(uiDefaults.ledger_views, 'collection_list', 'driver_phone')!, DEFAULT_FEATURES);
const slipView = visibleView(resolveLedgerView(uiDefaults.ledger_views, 'order_slip', 'pos')!, DEFAULT_FEATURES);

const rowCount = (html: string) => (html.match(/<tr class="sn-row/g) ?? []).length;

describe('장부(Ledger)', () => {
  const ledger = (size: Size, page = 0, result: LedgerViewResult = dayLedger) =>
    render(<Ledger view={ledgerView} result={result} steps={steps} nowMs={NOW_MS} page={page} size={size} onRowPress={noop} onStampPress={noop} />);

  it('1024×600: 표 머리 40 + 368px에 52px 줄 — 현재 줄이 있는 쪽은 6줄, 지연 줄만 빨강', () => {
    const html = ledger({ width: 964, height: 408 });
    expect(rowCount(html)).toBe(6);
    expect(html).toContain('현재 15:40');
    expect(html).toContain('<th scope="col" class="align-start"><span class="sn-fit">시각</span></th>');
    // 12:00 반납이 12:30에 늦음 → 그 줄만 is-late, 시각 칸이 tone-late.
    expect(html.match(/sn-row is-late/g)).toHaveLength(1);
    // 늦은 미수(지급일 지난 미수)는 돈 칸만 빨강, 늦지 않은 미수는 검정.
    expect(html).toContain('<span class="sn-fit tone-late">미수 65,000원</span>');
    expect(html).toMatch(/<span class="sn-fit">(미수 )?120,000원<\/span>/);
    // 늦은 줄이라도 받을 돈이 늦지 않았으면 돈 칸은 검정(빨강은 늦은 것에만).
    // 시각 칸은 두 줄: 작은 윗줄 종류('반납'), 아랫줄 시각. 늦은 줄은 두 줄 모두 늦음 색.
    expect(html).toContain('<span class="sn-cell-stack tone-late"><span class="sn-fit sn-cell-over">반납</span><span class="sn-fit">12:00</span></span>');
    expect(html).toContain('<span class="sn-fit sn-cell-over">수령</span><span class="sn-fit">16:00</span>');
    expect(html).not.toContain('<span class="sn-fit tone-late">완료</span>');
    expectPlainKorean(html);
  });

  it('1024×529(설치한 PWA): 297px에 5줄(현재 줄 24px가 있어도 5줄)', () => {
    expect(rowCount(ledger({ width: 964, height: 337 }))).toBe(5);
    expect(rowCount(ledger({ width: 964, height: 337 }, 1))).toBe(5);
  });

  it('875×600: 시각 칸이 따로 남아 모든 줄에 시각이 있고, 더 좁으면(판 790) 팀 칸 앞으로 합쳐진다', () => {
    const html = ledger({ width: 815, height: 408 });
    expect(html).toContain('>시각<');
    for (const row of html.split('<tr class="sn-row').slice(1)) expect(row).toMatch(/\d{2}:\d{2}/);
    const folded = ledger({ width: 790, height: 408 });
    expect(folded).not.toContain('>시각<');
    expect(folded).toContain('>팀<');
  });

  it('좁은 돈 칸: 한 줄 문구가 안 들어가면 두 줄(미수 · 금액), 이름과 원을 함께 지킨다', () => {
    const html = ledger({ width: 815, height: 408 }, 0);
    expect(html).toMatch(/<span class="sn-fit sn-cell-over">미수<\/span><span class="sn-fit">120,000원<\/span>/);
  });

  it('현재 줄의 쪽보다 이전 쪽에 지연 줄이 있으면 현재 줄에 지연 색으로 알린다', () => {
    // 늦은 줄(12:00 반납)이 첫 쪽에만 있도록 작은 판(줄 2개)에서 지금 줄이 있는 둘째 쪽을 본다.
    const small = { width: 964, height: 40 + 2 * 52 };
    const html = ledger(small, 1);
    expect(html).toContain('현재 15:40');
    expect(html).toContain('<span class="sn-now-late tone-late">이전 쪽 지연 1팀</span>');
    expect(ledger(small, 0)).not.toContain('이전 쪽 지연');
  });

  it('125% 확대(판 759): 도장 칸이 한 칸(도장)으로 모여 다음 단계만', () => {
    const html = ledger({ width: 759, height: 408 });
    expect(html).toContain('>도장<');
    expect(html).toContain('sn-stamp-cell is-collapsed');
    expect(html).not.toContain('>지급</span></th>');
  });

  it('도장 칸은 칸 전체가 버튼, 해당 없음(—)은 버튼이 아니다', () => {
    const html = ledger({ width: 964, height: 408 }) + ledger({ width: 964, height: 408 }, 1);
    expect(html).toMatch(/<button type="button" class="sn-stamp-cell is-todo" aria-label="수납 미처리">/);
    expect(html).toMatch(/<span class="sn-stamp-cell is-na" role="img" aria-label="반납 해당 없음">/);
    expect(html).toContain('sn-stamp is-done');
    expect(html).toContain('sn-stamp is-delegated');
  });
});

describe('기사 수거 목록', () => {
  const pin = collectionList.pins![0]!;
  it('태블릿 1024×520: 긴급 줄 + 묶음 제목 + 60px 줄 3개 + 다음 묶음 알림', () => {
    const threeInFirstSlot = { ...collectionList, rows: collectionList.rows.filter((r) => r.id !== 't29') };
    const html = render(
      <Ledger view={driverView} result={threeInFirstSlot} steps={steps} nowMs={Date.parse(kst(21, 40))} page={0} size={{ width: 992, height: 324 }}
        pinSlot={<PinBar pin={pin} moreCount={0} onCall={noop} onAck={noop} />} onActionPress={noop} />,
      { width: 1024, height: 520 }, 'driver',
    );
    expect(rowCount(html)).toBe(3);
    expect(html).toContain('22:00 반납 · 2 / 4');
    expect(html).toContain('sn-group-row is-hint');
    expect(html).toContain('긴급 · 21:50');
    expect(html).toContain('수거');
    expect(html).toMatch(/sn-stamp is-done is-timed/);
    expectPlainKorean(html);
  });

  it('묶음이 다음 쪽으로 이어지면 제목을 다시(계속), 전송 대기 도장은 점선', () => {
    const page = (n: number) => render(
      <Ledger view={driverView} result={collectionList} steps={steps} nowMs={NOW_MS} page={n} size={{ width: 992, height: 324 }} pinSlot={<span />} />,
      { width: 1024, height: 520 }, 'driver',
    );
    expect(rowCount(page(0))).toBe(3);
    expect(page(1)).toContain('22:00 반납 · 2 / 4 · (계속)');
    expect(page(1)).toContain('sn-stamp is-done is-pending');
  });

  it('지연 줄이 있는 반납 타임은 묶음 제목도 지연 색과 \'지연\'', () => {
    const late = { ...collectionList, rows: collectionList.rows.map((r) => (r.groupKey === 's2200' ? { ...r, lateAt: kst(21, 0) } : r)) };
    const html = render(<Ledger view={driverView} result={late} steps={steps} nowMs={Date.parse(kst(21, 40))} page={0} size={{ width: 992, height: 324 }} />, { width: 1024, height: 520 }, 'driver');
    expect(html).toContain('<span class="sn-fit tone-late">22:00 반납 · 지연 · 2 / 4</span>');
  });

  it('합친 묶음 제목은 늦은 묶음의 조각만 지연 색(끝난 · 늦지 않은 묶음은 보통 먹, 2026-09-26 검토)', () => {
    const late = {
      ...collectionList,
      groups: [{ key: 's1630', label: '16:30 반납', at: kst(16, 30), done: 1, total: 1 }, ...collectionList.groups],
      rows: [
        { ...collectionList.rows[0]!, id: 't21', groupKey: 's1630', finished: false },
        ...collectionList.rows.map((r) => (r.groupKey === 's2200' ? { ...r, lateAt: kst(21, 0) } : r)),
      ],
    };
    // 284: 나눈 제목(16:30 한 줄 + 22:00 두 줄 = 세 줄)보다 합친 제목(네 줄)이 더 많이 들어가 한 줄로 합친다.
    const html = render(<Ledger view={driverView} result={late} steps={steps} nowMs={Date.parse(kst(21, 40))} page={0} size={{ width: 992, height: 284 }} />, { width: 1024, height: 520 }, 'driver');
    const heading = /<th colSpan="\d+" scope="colgroup"><span class="sn-fit">(.*?)<\/span><\/th>/.exec(html)?.[1] ?? '';
    expect(heading).toContain('16:30 반납 · 1 / 1');
    expect(heading).toContain('<span class="tone-late">22:00 반납 · 지연 · 2 / 4</span>');
    expect(heading).not.toMatch(/tone-late">16:30/);
  });

  it('휴대폰 360×640: 품목이 팀 칸 둘째 줄로(64px 두 줄 줄), 묶음 제목과 6줄', () => {
    const rows = { ...collectionList, rows: [...collectionList.rows, ...collectionList.rows.map((r) => ({ ...r, id: r.id + 'b', groupKey: 's2200' }))].sort((a, b) => (a.groupKey ?? '').localeCompare(b.groupKey ?? '')) };
    const html = render(<Ledger view={phoneView} result={rows} steps={steps} nowMs={NOW_MS} page={0} size={{ width: 328, height: 456 }} />, { width: 360, height: 640 }, 'driver');
    expect(rowCount(html)).toBe(6);
    expect(html).toContain('sn-cell-second');
    expect(html).not.toContain('>품목<');
  });
});

describe('접수증 · 처리 현황 · 확인 창', () => {
  it('접수증: 칸 한 줄 · 품목 표(1024×600은 4줄) · 일정 요약 · 금액 줄', () => {
    const html = render(<Slip slip={orderSlip} view={slipView} steps={steps} nowMs={NOW_MS} itemsPage={0} tableSize={{ width: 668, height: 248 }} onStampPress={noop} />);
    expect(html).toContain('대여 접수증');
    expect(html).toContain('접수 번호 261226-017');
    expect(rowCount(html)).toBe(4);
    expect(html).toContain('수령 16:00');
    expect(html).toContain('미수 120,000원');
    expect(html).toContain('계좌이체 12/24');
    // 돈 줄의 수납 도장은 상태를 글로 쓴다(끝 · 일부 · 할 일이 그림만으로 갈리지 않게).
    expect(html).toContain('<span class="sn-stamp is-partial is-word">부분 수납</span>');
    // 품목 표는 서버가 채운 칸만 그린다.
    expect(html).toContain('야간권 성인');
    expect(html).toContain('105,000원');
    expectPlainKorean(html);
  });

  it('접수증: 대납하는 팀은 굵은 글이 받을 금액(합), 미수는 이 팀 몫', () => {
    const slip = { ...orderSlip, money: { ...orderSlip.money, due: 90_000, collectForOthers: 60_000, collectTotal: 150_000 } };
    const html = render(<Slip slip={slip} view={slipView} steps={steps} nowMs={NOW_MS} itemsPage={0} tableSize={{ width: 668, height: 248 }} />);
    expect(html).toContain('<span class="sn-slip-due">받을 금액 150,000원</span>');
    expect(html).not.toContain('>미수 150,000원<');
  });

  it('접수증: 맡은 보증금은 청구 · 미수와 따로 한 조각(보증금 15,000원), 없으면 조각이 없다', () => {
    const slip = { ...orderSlip, money: { ...orderSlip.money, depositHeld: 15_000 } };
    const html = render(<Slip slip={slip} view={slipView} steps={steps} nowMs={NOW_MS} itemsPage={0} tableSize={{ width: 668, height: 248 }} />);
    expect(html).toMatch(/청구 225,000원 · 수납 105,000원 · 계좌이체 12\/24 · 보증금 15,000원</);
    expect(html).toContain('<span class="sn-slip-due">미수 120,000원</span>');
    const none = render(<Slip slip={orderSlip} view={slipView} steps={steps} nowMs={NOW_MS} itemsPage={0} tableSize={{ width: 668, height: 248 }} />);
    expect(none).not.toContain('보증금');
  });

  it('접수증: 지연 반납은 일정 줄에 지연과 지연 색', () => {
    const slip = { ...orderSlip, promises: { distinct: 1, lines: [orderSlip.promises.lines[0]!, { ...orderSlip.promises.lines[1]!, lateAt: kst(15, 0) }] } };
    const html = render(<Slip slip={slip} view={slipView} steps={steps} nowMs={NOW_MS} itemsPage={0} tableSize={{ width: 668, height: 248 }} />);
    expect(html).toMatch(/<span class="sn-fit tone-late">[^<]*반납 지연 22:00/);
    expect(html).not.toContain('· 지연 ·');
  });

  it('접수증 품목 표가 좁으면 장부와 같이 두 줄 줄(88px)로 쪽을 나누고, 더 좁으면 한 문장', () => {
    const stacked = render(<Slip slip={orderSlip} view={slipView} steps={steps} nowMs={NOW_MS} itemsPage={0} tableSize={{ width: 370, height: 208 }} />);
    expect(stacked).toContain('data-layout="stacked"');
    expect(stacked).toContain('sn-row is-stacked');
    // 표 머리 40 + 88px 줄 → 한 쪽에 1줄(반쯤 잘린 줄 없음).
    expect(rowCount(stacked)).toBe(1);
    expect(stacked.match(/<th /g)).toHaveLength(1);
    const narrow = render(<Slip slip={orderSlip} view={slipView} steps={steps} nowMs={NOW_MS} itemsPage={0} tableSize={{ width: 150, height: 208 }} />);
    expect(narrow).toContain('화면 폭 부족');
    expect(rowCount(narrow)).toBe(0);
  });

  it('처리 현황: 완료는 한 줄로, 현재 처리 표시', () => {
    const html = render(<Checklist items={orderSlip.checklist} nowMs={NOW_MS} primary={<PrimaryButton label="지급 처리 · 6개 · 3매" onPress={noop} />} />);
    expect(html).toContain('완료 1');
    // 품목은 둘째 줄의 품목 맞춤(넘치면 '외 N종'으로 끝난다, 조용히 빠지지 않는다).
    expect(html).toContain('<span class="sn-fit sn-check-items">스키 2 · 보드 1 · 헬멧 3 · 야간권 3매</span>');
    expect(html).toContain('sn-check is-now');
    expect(html).toContain('aria-current="step"');
    expect(html.match(/data-primary="true"/g)).toHaveLength(1);
  });

  it('확인 창: 1024×600에서 폭 860, 수량 −/+, 요청번호가 창에 붙는다', () => {
    const html = render(
      <ConfirmDialog open title="수거 처리 · 김민수 팀" summary={['김민수 · 0025', '스키 4 · 헬멧 2']} quantity={{ value: 4, min: 1, max: 4, unit: '개' }} confirmLabel="수거 처리 · 4개" onConfirm={noop} onClose={noop} requestId="01JF3Q8W2Z6N9XK4T7B5R1C0DM" />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('width:860px');
    expect(html).toContain('data-request-id="01JF3Q8W2Z6N9XK4T7B5R1C0DM"');
    expect(html).toMatch(/aria-label="수량 증가" disabled=""/);
    expect(render(<ConfirmDialog open={false} title="" summary={[]} confirmLabel="" onConfirm={noop} onClose={noop} />)).not.toContain('sn-dialog');
  });
});

describe('머리줄 · 탭 · 바닥줄 · 작은 부품', () => {
  it('머리줄: 장부 · 끝 4자리 · 메뉴(등급 칸 수) · 알림 · 관리 · 나가기, 새 접수는 없다', () => {
    const menu = menuFor(uiDefaults.menu_entries, 'pos', 'pos', { ...DEFAULT_FEATURES, size_preinput: true }, null);
    const html = render(<AppHeader shopName="우리 스키샵" menu={menu} alertCount={2} onHome={noop} onFind={noop} onMenu={noop} onMore={noop} onAlerts={noop} onExit={noop} />);
    expect(html).toContain('>장부<');
    expect(html).toContain('>끝 4자리<');
    expect(html).toContain('>수거 목록<');
    expect(html).toContain('>확인 필요<');
    expect(html).toContain('>더 보기<'); // 메뉴 4개 > 칸 수 3 → 사이즈 요청이 더 보기로
    expect(html).not.toContain('>사이즈 요청<');
    expect(html).toContain('>관리<');
    expect(html).toContain('aria-label="알림 2건"');
    expect(html).not.toContain('새 접수');
    expectPlainKorean(html);
  });

  it('끝 4자리 숫자판의 자판(카운터 PC, NumberPad와 같음): 숫자 넣기(네 자리까지) · 지우기 · 네 자리면 찾기 · 닫기, 다른 키는 가져가지 않음', () => {
    expect(keypadKeyAction('0', '')).toEqual({ kind: 'press', digit: '0' });
    expect(keypadKeyAction('2', '0022')).toEqual({ kind: 'ignore' });
    expect(keypadKeyAction('Backspace', '002')).toEqual({ kind: 'erase' });
    expect(keypadKeyAction('Enter', '002')).toEqual({ kind: 'ignore' });
    expect(keypadKeyAction('Enter', '0022')).toEqual({ kind: 'submit' });
    expect(keypadKeyAction('Escape', '')).toEqual({ kind: 'close' });
    expect(keypadKeyAction('a', '')).toBeNull();
    expect(typingIn(null)).toBe(false);
  });

  it('두 줄 주 버튼(휴대폰 아래 판): 긴 이름부터 한 줄 또는 두 줄에 들어가는 첫 이름(돈을 빼는 짧은 이름보다 먼저)', () => {
    const measure = (text: string) => text.length * 10;
    const alts = ['리프트권 추가 · 1매 · 보증금 5,000원', '리프트권 추가 · 보증금 5,000원', '리프트권 추가'];
    expect(fitLines({ mode: 'alts', alts }, 100, 1, measure)).toMatchObject({ text: '리프트권 추가', fits: true, wrapped: false });
    expect(fitLines({ mode: 'alts', alts }, 130, 2, measure)).toEqual({ text: '리프트권 추가 · 보증금 5,000원', fits: true, wrapped: true });
    expect(fitLines({ mode: 'alts', alts }, 400, 2, measure)).toEqual({ text: alts[0], fits: true, wrapped: false });
  });

  it('제목 · 탭: 마감한 영업일은 제목 옆 이름표(`마감 완료`)', () => {
    const html = render(<IndexTabs title="12월 26일 (토) 대여 장부" tabs={ledgerView.tabs} counts={dayLedger.tabCounts} active="all" onSelect={noop} tag="마감 완료" />);
    expect(html).toContain('>마감 완료<');
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it('제목 · 탭: 제목 하나, 켜진 탭, 개수', () => {
    const html = render(<IndexTabs title={fillTitle(ledgerView.label, dayLedger.titleValues)} tabs={ledgerView.tabs} counts={dayLedger.tabCounts} active="all" onSelect={noop} />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('12월 26일 (토) 대여 장부');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('>전체 18<');
    expect(html).toContain('>미수 3<');
  });

  it('바닥줄: 숫자 · 쪽 넘김 · 주 버튼 하나', () => {
    const html = render(
      <FooterBar metrics={ledgerView.metrics.map((row, i) => ({ row, value: dayLedger.metrics[i]! }))} pager={<Pager page={0} pageCount={3} onChange={noop} />} primary={{ label: '새 접수', onPress: noop }} />,
    );
    expect(html).toContain('합계 18팀 · 지급 14 · 반납 9 · 미수 485,000원');
    expect(html).toContain('1 / 3쪽');
    expect(html).toContain('aria-label="이전 쪽" disabled=""');
    expect(html.match(/data-primary="true"/g)).toHaveLength(1);
    expect(render(<Pager page={0} pageCount={1} onChange={noop} />)).not.toContain('sn-pager');
  });

  it('연결 띠: 연결되어 있으면 없고, 끊기면 한 줄', () => {
    expect(render(<ConnectionStrip online pendingCount={0} />)).not.toContain('class="sn-strip');
    const html = render(<ConnectionStrip online={false} pendingCount={3} lastSyncAt={kst(21, 40)} />);
    expect(html).toContain('연결 끊김 · 전송 대기 3 · 마지막 연결 21:40');
  });

  it('숫자판: 태블릿 1024×600은 옆 판, 1024×520은 아래 판(닫혀 있으면 없음)', () => {
    const side = render(<Keypad value="00" onChange={noop} onSubmit={noop} />, { width: 1024, height: 600 }, 'driver');
    expect(side).toContain('sn-keypad is-side');
    expect(side).toContain('0 0 _ _');
    expect(side).toMatch(/class="sn-key is-go" disabled=""/);
    expect(render(<Keypad value="" onChange={noop} onSubmit={noop} open={false} />, { width: 1024, height: 520 }, 'driver')).toBe(render(<></>, { width: 1024, height: 520 }, 'driver'));
    expect(render(<Keypad value="" onChange={noop} onSubmit={noop} open />, { width: 1024, height: 520 }, 'driver')).toContain('sn-keypad is-sheet');
  });

  it('숫자판 옆 판의 차량 재고: 이름 한 줄 + 품목 한 줄', () => {
    const html = render(<Keypad value="" onChange={noop} onSubmit={noop} loadSummary={{ label: '차량 재고', items: ['스키 14', '보드 3'] }} />, { width: 1024, height: 600 }, 'driver');
    expect(html).toContain('sn-keypad-load is-items');
    expect(html).toContain('<b>차량 재고</b>');
    expect(html).toContain('스키 14 · 보드 3');
  });

  it('긴급 줄: 좁은 화면은 전화 버튼을 그림만(읽는 이름은 전화)', () => {
    const pin = collectionList.pins![0]!;
    const html = render(<PinBar pin={pin} moreCount={1} onCall={noop} onAck={noop} compact />, { width: 360, height: 640 }, 'driver');
    expect(html).toContain('class="sn-icon-button" aria-label="전화"');
    expect(html).toContain('긴급');
    // 좁으면 메모와 시각이 먼저 빠지고 장소는 짧은 이름으로 남는다(기사에게 장소가 가장 중요).
    expect(html).toContain('들국화');
    expectPlainKorean(html);
  });

  it('머리줄(기사): 장부 버튼 없이 차량 이름표 · 끝 4자리 · 메뉴 · 알림 · 나가기', () => {
    const menu = menuFor(uiDefaults.menu_entries, 'driver', 'driver_tablet', DEFAULT_FEATURES, null);
    const html = render(<AppHeader shopName="우리 스키샵" vehicleLabel="1호 차량" menu={menu} alertCount={1} onFind={noop} onMenu={noop} onAlerts={noop} onExit={noop} />, { width: 1024, height: 520 }, 'driver');
    expect(html).not.toContain('>장부<');
    expect(html).toContain('>1호 차량<');
    expect(html).toContain('>끝 4자리<');
    expect(html).toContain('>차량 재고<');
    expectPlainKorean(html);
  });

  it('줄 동작: 채운 ▲ · ▼와 낱말, 맨 위로 · 수거 실패 · 전화, 끝에 닫기(누를 수 없는 것은 까닭과 함께 회색)', () => {
    const actions: RowAction[] = [
      { key: 'move_up', label: '위로', glyph: '▲', repeat: true, priority: 70, disabled: true, reason: '맨 위' },
      { key: 'move_down', label: '아래로', glyph: '▼', repeat: true, priority: 70 },
      { key: 'move_top', label: '맨 위로', priority: 60 },
      { key: 'not_collected', label: '수거 실패', priority: 80 },
      { key: 'call', label: '전화', icon: 'phone', priority: 90 },
      { key: 'route_reset', label: '시간순 정렬', priority: 10 },
    ];
    const html = render(<RowActionBar actions={actions} onAction={noop} onClose={noop} />, { width: 1024, height: 520 }, 'driver');
    expect(html).toContain('aria-label="위로 · 맨 위" disabled=""');
    expect(html).toContain('<span class="sn-action-glyph" aria-hidden="true">▲</span><span>위로</span>');
    expect(html).toContain('>맨 위로<');
    expect(html).toContain('>수거 실패<');
    expect(html).toContain('>시간순 정렬<');
    expect(html).toMatch(/class="sn-action-button is-close"><span>닫기<\/span>/);
    // 좁아질 때의 차례: 가장 낮은 동작(시간순 되돌리기)을 빼고 → 그림 있는 버튼의 낱말 → 낮은 것부터 빼기.
    expect(rowBarSteps(actions).map((step) => step.kind + ':' + step.key)).toEqual([
      'hide:route_reset', 'compact:move_up', 'compact:move_down', 'compact:call', 'hide:move_top', 'hide:move_up', 'hide:move_down', 'hide:not_collected', 'hide:call',
    ]);
  });

  it('도장 일곱 상태', () => {
    const issue = steps.get('issue');
    const states = ['todo', 'partial', 'done', 'na', 'blocked', 'scheduled', 'delegated'] as const;
    const html = render(<>{states.map((state) => <Stamp key={state} cell={{ stepKey: 'issue', state, progress: { done: 2, total: 4 }, at: kst(22, 0) }} step={issue} onPress={noop} />)}</>);
    for (const state of states) expect(html).toContain('sn-stamp is-' + state);
    expect(html).toContain('>2/4<');
    expect(html).toContain('>예정<');
    expect(html).toContain('>22:00<');
    expectPlainKorean(html);
  });

  it('도장의 시각 · 이름 · 부분: 지급은 칸 안 두 줄, 수거는 넓은 타원, 사슬 앞 단계는 이름, 셀 수 없는 부분은 부분', () => {
    const html = render(
      <>
        <Stamp cell={{ stepKey: 'issue', state: 'done', at: kst(15, 42) }} step={steps.get('issue')} onPress={noop} />
        <Stamp cell={{ stepKey: 'collect', state: 'done', at: kst(21, 42) }} step={steps.get('collect')} onPress={noop} />
        <Stamp cell={{ stepKey: 'load', state: 'todo' }} step={steps.get('load')} labelled onPress={noop} />
        <Stamp cell={{ stepKey: 'pay', state: 'partial' }} step={steps.get('pay')} onPress={noop} />
      </>,
    );
    expect(html).toContain('sn-stamp is-done is-dated');
    expect(html).toContain('<span class="sn-stamp-text">지급</span><span class="sn-stamp-time">15:42</span>');
    expect(html).toContain('aria-label="지급 완료 15:42"');
    expect(html).toContain('sn-stamp is-done is-timed');
    expect(html).toContain('<span class="sn-stamp is-todo is-labelled">적재</span>');
    expect(html).toContain('<span class="sn-stamp is-partial">부분</span>');
    expect(html).toContain('aria-label="수납 부분"');
    expectPlainKorean(html);
  });

  it('장부: 단계 사슬(적재 → 지급)의 앞 단계가 보이면 동그라미에 이름', () => {
    const html = render(<Ledger view={ledgerView} result={dayLedger} steps={steps} nowMs={NOW_MS} page={0} size={{ width: 964, height: 408 }} onStampPress={noop} />);
    expect(html).toContain('<span class="sn-stamp is-todo is-labelled">적재</span>');
  });

  it('접수증: 영업일이 아닌 일정에는 내일 · 모레, 오늘 수납에는 날짜를 다시 쓰지 않는다', () => {
    const tomorrow = new Date(Date.UTC(2026, 11, 27, 0, 0)).toISOString();
    const slip = {
      ...orderSlip,
      promises: { distinct: 1, lines: [orderSlip.promises.lines[0]!, { kind: 'return' as const, at: tomorrow, parts: [{ text: '매장', drop: 1 }] }] },
      money: { ...orderSlip.money, payments: [{ amount: 105_000, methodLabel: '현금', date: '2026-12-26' }] },
    };
    const html = render(<Slip slip={slip} view={slipView} steps={steps} nowMs={NOW_MS} itemsPage={0} tableSize={{ width: 668, height: 248 }} />);
    expect(html).toContain('반납 내일 09:00');
    expect(html).toContain('수령 16:00');
    expect(html).toMatch(/수납 105,000원 · 현금</);
  });

  it('숫자판: 찾기 결과 한 줄', () => {
    const html = render(<Keypad value="0099" onChange={noop} onSubmit={noop} note="끝 4자리 0099 · 해당 팀 없음" placement="sheet" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('끝 4자리 0099 · 해당 팀 없음');
  });

  it('뿌리: 등급 · 강조색 · 크기 변수', () => {
    const pos = render(<span />);
    expect(pos).toContain('data-device="pos"');
    expect(pos).toContain('data-accent="orange"');
    expect(pos).toContain('--sn-target:52px');
    const phone = render(<span />, { width: 360, height: 640 }, 'driver');
    expect(phone).toContain('data-device="driver_phone"');
    expect(phone).toContain('data-accent="purple"');
    expect(phone).toContain('--sn-target:56px');
  });
});

describe('확인 창 주 버튼의 짧은 글(confirmLabelAlts)', () => {
  it('수를 끝까지 지킨다: 이름의 `처리`를 떼고, 금액 조각을 뺀 뒤에야 뒤 조각을 뺀다', () => {
    expect(confirmLabelAlts('수거 처리 · 2개 · 1매')).toEqual(['수거 처리 · 2개 · 1매', '수거 · 2개 · 1매', '수거 처리 · 2개', '수거 처리']);
    expect(confirmLabelAlts('지급 처리 · 6개 · 3매 · 보증금 15,000원')).toEqual([
      '지급 처리 · 6개 · 3매 · 보증금 15,000원', '지급 · 6개 · 3매 · 보증금 15,000원', '지급 처리 · 6개 · 3매', '지급 · 6개 · 3매', '지급 처리 · 6개', '지급 처리',
    ]);
    expect(confirmLabelAlts('긴급 요청')).toEqual(['긴급 요청']);
    expect(confirmLabelAlts('반납 처리 · 5개')).toEqual(['반납 처리 · 5개', '반납 · 5개', '반납 처리']);
  });
});

describe('접수증 돈 줄의 수단(paymentParts)', () => {
  it('수단이 하나면 이름만, 둘 이상이면 수단마다 금액(오늘 받은 수단 먼저), 다른 날 받은 돈은 날짜', () => {
    expect(paymentParts([{ amount: 365_000, methodLabel: '카드', date: '2026-12-26' }], '2026-12-26')).toEqual([{ text: '카드', drop: 5 }]);
    expect(paymentParts([{ amount: 105_000, methodLabel: '계좌이체', date: '2026-12-24' }], '2026-12-26')).toEqual([{ text: '계좌이체 12/24', drop: 5 }]);
    expect(paymentParts([
      { amount: 225_000, methodLabel: '카드', date: '2026-12-26' }, { amount: 140_000, methodLabel: '현금', date: '2026-12-26' },
    ], '2026-12-26')).toEqual([{ text: '카드 225,000원 · 현금 140,000원', drop: 5 }]);
    // 선입금(12/24 계좌이체) 뒤 오늘 카드: 오늘 받은 카드가 먼저.
    expect(paymentParts([
      { amount: 105_000, methodLabel: '계좌이체', date: '2026-12-24' }, { amount: 120_000, methodLabel: '카드', date: '2026-12-26' },
    ], '2026-12-26')).toEqual([{ text: '카드 120,000원 · 계좌이체 12/24 105,000원', drop: 5 }]);
    // 같은 수단 여러 번(선입금 + 오늘 현장 계좌이체)은 한 조각(오늘).
    expect(paymentParts([
      { amount: 135_000, methodLabel: '계좌이체', date: '2026-12-25' }, { amount: 35_000, methodLabel: '계좌이체', date: '2026-12-26' },
    ], '2026-12-26')).toEqual([{ text: '계좌이체', drop: 5 }]);
    expect(paymentParts([], '2026-12-26')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { fitAlts, fitItems, fitMetrics, fitParts, fitText, fullText, type Measure } from '../src/index.ts';

// 시험용 글자 폭: 한글 16px, 숫자 · 영문 9px, 빈칸 · 쉼표 · 쌍점 4px, 가운데 점 · 빗금 5px.
const measure: Measure = (text) =>
  [...text].reduce((w, ch) => w + (/[가-힣]/.test(ch) ? 16 : ' ,:'.includes(ch) ? 4 : '·/'.includes(ch) ? 5 : 9), 0);

describe('글자 맞추기(ui 4-3)', () => {
  it('품목: 뒤에서부터 외 N종, 그래도 넘치면 품목 N종 — 말줄임표 없음', () => {
    const items = ['스키 2', '보드 1', '헬멧 3'];
    const full = fitItems(items, 400, measure);
    expect(full).toEqual({ text: '스키 2 · 보드 1 · 헬멧 3', fits: true, dropped: 0 });
    expect(fitItems(items, measure('스키 2 · 보드 1 외 1종'), measure).text).toBe('스키 2 · 보드 1 외 1종');
    expect(fitItems(items, measure('스키 2 외 2종'), measure).text).toBe('스키 2 외 2종');
    expect(fitItems(items, measure('품목 3종'), measure).text).toBe('품목 3종');
    for (const w of [20, 60, 90, 120, 160, 200]) expect(fitItems(items, w, measure).text).not.toContain('…');
  });

  it('조각: 합쳐 들어온 시각이 먼저 빠지고 이름과 끝 4자리는 남는다', () => {
    const parts = [{ text: '09:10', drop: 3 }, { text: '김민수', drop: 0 }, { text: '0025', drop: 0 }];
    expect(fitParts(parts, 300, measure).text).toBe('09:10 · 김민수 · 0025');
    const tight = fitParts(parts, measure('김민수 · 0025'), measure);
    expect(tight).toEqual({ text: '김민수 · 0025', fits: true, dropped: 1 });
  });

  it('짧은 글이 있는 조각은 빠지기 전에 짧은 글로 바뀐다(빨리 확인 줄: 메모 → 긴 장소 → 짧은 장소 순)', () => {
    const parts = [{ text: '꽃마을 들국화', short: '들국화', drop: 1 }, { text: '오승민 · 0039', drop: 0 }, { text: '조기 반납', drop: 2 }];
    expect(fitParts(parts, 400, measure).text).toBe('꽃마을 들국화 · 오승민 · 0039 · 조기 반납');
    expect(fitParts(parts, measure('꽃마을 들국화 · 오승민 · 0039'), measure).text).toBe('꽃마을 들국화 · 오승민 · 0039');
    expect(fitParts(parts, measure('들국화 · 오승민 · 0039'), measure).text).toBe('들국화 · 오승민 · 0039');
    expect(fitParts(parts, measure('오승민 · 0039'), measure).text).toBe('오승민 · 0039');
  });

  it('긴 단체 이름은 이름 안에서 낱말을 줄인다(끝 4자리는 남음)', () => {
    const parts = [{ text: '한국대학교 스키동아리', drop: 0, words: true }, { text: '0025', drop: 0 }];
    const result = fitParts(parts, measure('한국대학교 · 0025') + 2, measure);
    expect(result.text).toBe('한국대학교 · 0025');
    expect(result.fits).toBe(true);
  });

  it('약속: 우선순위 낮은 조각부터(22:00 · 설천 주차장 · 차량)', () => {
    const parts = [{ text: '22:00', drop: 0 }, { text: '설천 주차장', drop: 1 }, { text: '차량', drop: 2 }];
    expect(fitParts(parts, measure('22:00 · 설천 주차장'), measure).text).toBe('22:00 · 설천 주차장');
    expect(fitParts(parts, measure('22:00'), measure).text).toBe('22:00');
  });

  it('짧은 대체 문구(미수 120,000원 → 120,000원)', () => {
    expect(fitAlts(['미수 120,000원', '120,000원'], 200, measure).text).toBe('미수 120,000원');
    expect(fitAlts(['미수 120,000원', '120,000원'], measure('120,000원'), measure).text).toBe('120,000원');
  });

  it('fitText는 모드로 나눈다', () => {
    expect(fitText({ mode: 'words', text: '야간권 성인 오후' }, measure('야간권 성인'), measure).text).toBe('야간권 성인');
    expect(fullText({ mode: 'parts', parts: [{ text: 'a', drop: 0 }, { text: '', drop: 1 }, { text: 'b', drop: 1 }] })).toBe('a · b');
  });
});

describe('바닥줄 숫자(ui 4-4)', () => {
  const metrics = [
    { key: 'team_count', label: '합계', value: '18팀', priority: 100, foldable: false },
    { key: 'issued_count', label: '지급', value: '14', priority: 60, foldable: true },
    { key: 'returned_count', label: '반납', value: '9', priority: 50, foldable: true },
    { key: 'due_total', label: '미수', value: '485,000원', priority: 80, foldable: false },
  ];

  it('들어가면 그대로', () => {
    expect(fitMetrics(metrics, 600, measure).text).toBe('합계 18팀 · 지급 14 · 반납 9 · 미수 485,000원');
  });

  it('넘치면 지급 · 반납을 합치고, 그래도 넘치면 우선순위 낮은 숫자를 뺀다', () => {
    const folded = fitMetrics(metrics, measure('합계 18팀 · 지급/반납 14/9 · 미수 485,000원'), measure);
    expect(folded.text).toBe('합계 18팀 · 지급/반납 14/9 · 미수 485,000원');
    expect(folded.folded).toBe(true);
    const dropped = fitMetrics(metrics, measure('합계 18팀 · 미수 485,000원'), measure);
    expect(dropped.text).toBe('합계 18팀 · 미수 485,000원');
  });

  it('차에 있는 것 목록은 외 N종으로 줄인다', () => {
    const driver = [
      { key: 'collected_count', label: '받음', value: '4', priority: 90, foldable: true },
      { key: 'remaining_count', label: '남음', value: '3', priority: 100, foldable: true },
      { key: 'vehicle_load', label: '차에 있는 것', value: '스키 14 · 보드 3 · 의류 2 · 헬멧 6', priority: 40, foldable: false, items: ['스키 14', '보드 3', '의류 2', '헬멧 6'] },
    ];
    const width = measure('받음 4 · 남음 3 · 차에 있는 것 스키 14 · 보드 3 외 2종');
    expect(fitMetrics(driver, width, measure).text).toBe('받음 4 · 남음 3 · 차에 있는 것 스키 14 · 보드 3 외 2종');
  });
});

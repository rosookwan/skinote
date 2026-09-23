// 보이는 모양 도우미: 방문 결과의 '내일 22:00'을 명령 시각으로, 영업일 더하기, 빈 '차에 있는 것'.
import { describe, expect, it } from 'vitest';
import { addDays, formatMetricValue, zonedTimeToIso } from '../src/format.ts';

describe('시각 · 날짜', () => {
  it('매장 시간대의 날짜 · 시각 → UTC(한국은 +9, 서머타임이 있는 곳도 맞게)', () => {
    expect(zonedTimeToIso('2026-12-27', 22, 0, 'Asia/Seoul')).toBe('2026-12-27T13:00:00.000Z');
    expect(zonedTimeToIso('2026-12-27', 0, 30, 'Asia/Seoul')).toBe('2026-12-26T15:30:00.000Z');
    expect(zonedTimeToIso('2026-03-08', 3, 30, 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
  });

  it('영업일 더하기(달 · 해 넘김)', () => {
    expect(addDays('2026-12-26', 1)).toBe('2026-12-27');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
  });
});

describe('바닥줄 숫자', () => {
  it('빈 품목 목록은 없음(이름만 남지 않게)', () => {
    expect(formatMetricValue({ metricKey: 'vehicle_load', unit: 'items', items: [] })).toEqual({ text: '없음' });
    expect(formatMetricValue({ metricKey: 'vehicle_load', unit: 'items', items: [{ label: '스키', qty: 4 }] })).toEqual({ text: '스키 4', items: ['스키 4'] });
  });
});

// 시각 도우미: 영업일(기준 시각)과 카운터 로그인이 끝나는 때(sessionExpiry, plan §5-3).
import { describe, expect, it } from 'vitest';
import { businessDateOf, kstAt, sessionExpiry } from '../src/index.ts';

const at = (day: number, h: number, m: number) => kstAt('2026-12-26', day, h, m);

describe('sessionExpiry: 로그인에서 적어도 12시간 뒤인 첫 영업일 기준 시각', () => {
  it('07:00 로그인은 다음 날 06:00', () => {
    expect(sessionExpiry(at(0, 7, 0), '06:00')).toBe(at(1, 6, 0));
  });

  it('05:50 로그인은 그날 06:00이 10분 뒤라 다음 날 06:00', () => {
    expect(sessionExpiry(at(0, 5, 50), '06:00')).toBe(at(1, 6, 0));
  });

  it('18:00 로그인은 12시간 뒤인 다음 날 06:00, 18:01은 그다음 날 06:00', () => {
    expect(sessionExpiry(at(0, 18, 0), '06:00')).toBe(at(1, 6, 0));
    expect(sessionExpiry(at(0, 18, 1), '06:00')).toBe(at(2, 6, 0));
  });

  it('자정 뒤 새벽 로그인(27일 00:30)은 그날 06:00이 5시간 반 뒤라 28일 06:00', () => {
    expect(sessionExpiry(at(1, 0, 30), '06:00')).toBe(at(2, 6, 0));
  });

  it('기준 시각을 따른다(00:00 매장)', () => {
    expect(sessionExpiry(at(0, 9, 0), '00:00')).toBe(at(1, 0, 0));
    expect(sessionExpiry(at(0, 13, 0), '00:00')).toBe(at(2, 0, 0));
  });

  it('끝나는 때는 늘 기준 시각이고, 새 영업일이 시작하는 때다', () => {
    for (const [h, m] of [[0, 0], [5, 59], [6, 0], [11, 30], [23, 59]] as const) {
      const login = at(0, h, m);
      const end = sessionExpiry(login, '06:00');
      expect(end - login).toBeGreaterThanOrEqual(12 * 3_600_000);
      expect(end - login).toBeLessThan(36 * 3_600_000);
      expect(businessDateOf(end - 1, '06:00')).not.toBe(businessDateOf(end, '06:00'));
    }
  });
});

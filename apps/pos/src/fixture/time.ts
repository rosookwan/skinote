// 체험 자료의 시각 도우미. 매장 시간대는 한국(UTC+9, 서머타임 없음)으로 고정한다. 영업일은 'YYYY-MM-DD'.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
const KST_OFFSET = 9 * HOUR;

/** 영업일 + 날 차이 + 한국 시각(시:분) → ms. */
export function kstAt(date: string, dayOffset: number, hour: number, minute: number): number {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d + dayOffset, hour, minute) - KST_OFFSET;
}

/** ms → 한국 날짜 'YYYY-MM-DD'. */
export function kstDate(ms: number): string {
  return new Date(ms + KST_OFFSET).toISOString().slice(0, 10);
}

/** ms → 'HH:MM'(한국 시각, 24시간). */
export function hm(ms: number): string {
  return new Date(ms + KST_OFFSET).toISOString().slice(11, 16);
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function dayDiff(date: string, today: string): number {
  return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000);
}

/** 날짜 글자: 오늘 · 내일 · 모레, 그 밖은 '12월 29일'(N14). */
export function dayWord(ms: number, today: string): string {
  const date = kstDate(ms);
  const diff = dayDiff(date, today);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  if (diff === 2) return '모레';
  const [, m = '1', d = '1'] = date.split('-');
  return Number(m) + '월 ' + Number(d) + '일';
}

/** 장부 안의 시각: 오늘이면 '22:00', 다른 날이면 '내일 09:00'(같은 날짜를 두 번 쓰지 않는다). */
export function when(ms: number, today: string): string {
  return kstDate(ms) === today ? hm(ms) : dayWord(ms, today) + ' ' + hm(ms);
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** '12월 26일 (토)'. */
export function dateTitle(date: string): string {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return m + '월 ' + d + '일 (' + (WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '') + ')';
}

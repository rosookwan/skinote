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

/**
 * 영업일 기준 시각(shops.business_day_cutoff). 하나('06:00'), 또는 운영 규칙(V8)에서 바꾼 기록: 바꾼 시각(until) 전의 기록은
 * 그때의 기준으로 센다(data-model 3-3 · ADR-06: 저장한 영업일은 다시 계산하지 않는다 — 체험 자료는 영업일을 저장하지 않으므로 기록
 * 시각에 맞는 기준으로 다시 세어 같은 값을 얻는다). before는 until 차례.
 */
export interface CutoffHistory {
  current: string;
  before: readonly { until: number; cutoff: string }[];
}
export type Cutoff = string | CutoffHistory;

/** 이 시각의 기록에 쓰는 기준 시각('HH:MM'). */
export function cutoffAt(cutoff: Cutoff, ms: number): string {
  if (typeof cutoff === 'string') return cutoff;
  for (const b of cutoff.before) if (ms < b.until) return b.cutoff;
  return cutoff.current;
}

/** 매장 운영 규칙의 기준 시각(바꾼 기록이 있으면 기록째). */
export function shopCutoff(rules: { businessDayCutoff: string; cutoffBefore?: readonly { until: number; cutoff: string }[] | undefined }): Cutoff {
  return rules.cutoffBefore?.length ? { current: rules.businessDayCutoff, before: rules.cutoffBefore } : rules.businessDayCutoff;
}

/** 'HH:MM' → 하루의 분. */
export function minutesOf(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * 영업일(data-model 3-3): 매장 시각이 기준 시각(cutoff 'HH:MM', 이 매장 06:00)보다 이르면 전날이다.
 * 27일 00:15 반납 · 00:40 마감은 26일 영업일, 27일 06:00부터는 27일.
 */
export function businessDateOf(ms: number, cutoff: Cutoff): string {
  return kstDate(ms - minutesOf(cutoffAt(cutoff, ms)) * MINUTE);
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

/**
 * 영업일 하나(날짜 + 기준 시각). 오늘 · 내일 말과 도장 시각은 이 영업일로 가른다: 기준 시각이 06:00이면 27일 00:15 반납은
 * 26일 영업일의 일이다(data-model 3-3).
 */
export interface BizDay {
  date: string;
  cutoff: Cutoff;
}

/** 이 시각이 그 영업일의 일인지. */
export const onBizDay = (ms: number, day: BizDay) => businessDateOf(ms, day.cutoff) === day.date;

/** 날짜 글자: 오늘 · 내일 · 모레, 그 밖은 '12월 29일'(N14). 날은 영업일로 센다(기준 시각 전의 새벽은 전날). */
export function dayWord(ms: number, today: string, cutoff: Cutoff = '00:00'): string {
  const date = businessDateOf(ms, cutoff);
  const diff = dayDiff(date, today);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  if (diff === 2) return '모레';
  const [, m = '1', d = '1'] = date.split('-');
  return Number(m) + '월 ' + Number(d) + '일';
}

/**
 * 영업일 안의 시각 글: 기준 시각(06:00) 전의 새벽은 그 영업일의 24시 뒤로 쓴다(심야 24:00 반납 = 27일 00:00은 `24:00`, `오늘 00:00`이
 * 아침으로 읽히지 않게). 일정 변경 창(V9)의 timeText와 같은 규칙.
 */
export function bizHm(ms: number, cutoff: Cutoff = '00:00'): string {
  const text = hm(ms);
  if (kstDate(ms) === businessDateOf(ms, cutoff)) return text;
  const [h = 0, m = 0] = text.split(':').map(Number);
  return String(h + 24).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/** 장부 안의 시각: 오늘이면 '22:00'(심야 '24:00'), 다른 날이면 '내일 09:00'(같은 날짜를 두 번 쓰지 않는다). 날은 영업일로 센다. */
export function when(ms: number, today: string, cutoff: Cutoff = '00:00'): string {
  return businessDateOf(ms, cutoff) === today ? bizHm(ms, cutoff) : dayWord(ms, today, cutoff) + ' ' + bizHm(ms, cutoff);
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** '12월 26일 (토)'. */
export function dateTitle(date: string): string {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return m + '월 ' + d + '일 (' + (WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '') + ')';
}

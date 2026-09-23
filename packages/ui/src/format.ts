// 보이는 모양(돈 · 시각 · 날짜 · 품목). 계산이 아니라 글자로 바꾸기만 한다. 시각은 매장 시간대(UiConfig.timezone)로 쓴다.
import type { BusinessDate, IsoTime, ItemCount, MetricValue } from '@skinote/contract';
import { t } from './strings.ko-KR.ts';

export function formatWon(amount: number): string {
  return t('won', { n: Math.round(amount).toLocaleString('ko-KR') });
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();

/** 'HH:MM'(24시간). */
export function formatTime(at: IsoTime | number | Date, timeZone: string): string {
  let format = timeFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('ko-KR', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    timeFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(typeof at === 'string' ? new Date(at) : at);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return hour.padStart(2, '0') + ':' + minute.padStart(2, '0');
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** 매장 시간대의 날짜 'YYYY-MM-DD'(영업일과 견주려고). 글자로 보이지 않는다. */
export function formatLocalDate(at: IsoTime | number | Date, timeZone: string): string {
  let format = dateFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(typeof at === 'string' ? new Date(at) : at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return get('year') + '-' + get('month') + '-' + get('day');
}

/** 영업일 + 날 수('2026-12-26' + 1 → '2026-12-27'). */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * 매장 시간대의 날짜 · 시각('2026-12-27', 22, 0) → UTC ISO. 방문 결과의 '내일 22:00'처럼 사람이 고른 시각을 명령에 넣을 때 쓴다.
 * 시간대의 차이는 Intl로 재고(서머타임이 있어도 맞게 두 번 고친다), 규칙 계산은 하지 않는다.
 */
export function zonedTimeToIso(date: BusinessDate, hour: number, minute: number, timeZone: string): IsoTime {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const offsetAt = (ms: number) => {
    const local = formatLocalDate(ms, timeZone);
    const [hh = '0', mm = '0'] = formatTime(ms, timeZone).split(':');
    const [ly = 0, lm = 1, ld = 1] = local.split('-').map(Number);
    return Date.UTC(ly, lm - 1, ld, Number(hh), Number(mm)) - Math.floor(ms / 60_000) * 60_000;
  };
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  return new Date(guess).toISOString();
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function parseDate(date: BusinessDate): { y: number; m: number; d: number } {
  const [y = '0', m = '1', d = '1'] = date.split('-');
  return { y: Number(y), m: Number(m), d: Number(d) };
}

/** 제목의 날짜: '12월 26일 (토)'. */
export function formatDateTitle(date: BusinessDate): string {
  const { y, m, d } = parseDate(date);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
  return m + '월 ' + d + '일 (' + weekday + ')';
}

/** 줄 안의 날짜: 오늘 · 내일 · 모레, 그 밖은 '12월 29일'(N14). */
export function formatRelativeDay(date: BusinessDate, today: BusinessDate): string {
  const a = parseDate(date);
  const b = parseDate(today);
  const diff = Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 86_400_000);
  if (diff === 0) return t('today');
  if (diff === 1) return t('tomorrow');
  if (diff === 2) return t('dayAfter');
  return a.m + '월 ' + a.d + '일';
}

/** 품목 요약 한 칸: '스키 2', '야간권 3매'. */
export function formatItem(item: ItemCount): string {
  return item.label + ' ' + item.qty + (item.unit ?? '');
}

/** 제목 틀('{date} 대여 장부')에 값을 넣는다. */
export function fillTitle(template: string, values: { date?: BusinessDate; vehicle?: string }): string {
  return template
    .replace('{date}', values.date ? formatDateTitle(values.date) : '')
    .replace('{vehicle}', values.vehicle ?? '')
    .trim();
}

/** 바닥줄 숫자 값 글자: '18팀', '14', '485,000원', '스키 14 · 보드 3'. */
export function formatMetricValue(value: MetricValue): { text: string; items?: string[] } {
  switch (value.unit) {
    case 'team': return { text: t('team', { n: value.value }) };
    case 'count': return { text: String(value.value) };
    case 'won': return { text: formatWon(value.value) };
    case 'items': {
      // 빈 목록은 '없음'(이름만 덩그러니 남지 않게: '차에 있는 것 없음').
      if (value.items.length === 0) return { text: t('none') };
      const items = value.items.map(formatItem);
      return { text: items.join(' · '), items };
    }
  }
}

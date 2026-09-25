// @ts-check
// 시각과 영업일(data-model 3-3). 영업일은 시각을 매장 시간대로 바꾼 뒤 그 시각이 하루 기준 시각보다 이르면 전날로 친다.
// 스키 매장의 기준은 06:00이라 12월 27일 00:15 반납은 26일 영업일이다. 모든 계산은 Intl로 하고 서버의 TZ 환경 변수에 기대지 않는다.

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

/** @param {string} timeZone */
function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * 그 시간대의 벽시계 값.
 * @param {Date} at @param {string} timeZone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number }}
 */
export function localParts(at, timeZone) {
  /** @type {Record<string, number>} */
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute };
}

/** @param {number} year @param {number} month 1~12 @param {number} day 날짜 넘침(0, 32)은 Date.UTC가 맞춘다 */
function isoDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

/**
 * 그 시간대의 달력 날짜(YYYY-MM-DD). 백업 폴더 이름에 쓴다.
 * @param {Date} at @param {string} timeZone
 */
export function localDate(at, timeZone) {
  const p = localParts(at, timeZone);
  return isoDate(p.year, p.month, p.day);
}

/**
 * 영업일(YYYY-MM-DD): 매장 시간대의 시각이 기준 시각(분)보다 이르면 전날.
 * @param {Date} at @param {string} timeZone @param {number} cutoffMinutes 0~1439
 */
export function businessDate(at, timeZone, cutoffMinutes) {
  const p = localParts(at, timeZone);
  const minutes = p.hour * 60 + p.minute;
  return isoDate(p.year, p.month, minutes < cutoffMinutes ? p.day - 1 : p.day);
}

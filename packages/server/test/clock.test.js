// @ts-check
// 영업일(data-model 3-3): 매장 시간대의 시각이 기준 시각(06:00)보다 이르면 전날. 달 · 해가 바뀌는 날, 기준 00:00.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { businessDate, localDate } from '../src/clock.js';

const SEOUL = 'Asia/Seoul';
const SIX = 360;
/** 서울 벽시계 시각(UTC+9, 서머타임 없음) → Date. @param {string} local 'YYYY-MM-DDTHH:MM' */
const seoul = local => new Date(`${local}:00+09:00`);

test('06:00 cutoff: 00:15 and 05:59 belong to the previous day, 06:00 starts the new one', () => {
  assert.equal(businessDate(seoul('2026-12-26T23:48'), SEOUL, SIX), '2026-12-26');
  assert.equal(businessDate(seoul('2026-12-27T00:15'), SEOUL, SIX), '2026-12-26');
  assert.equal(businessDate(seoul('2026-12-27T00:40'), SEOUL, SIX), '2026-12-26');
  assert.equal(businessDate(seoul('2026-12-27T05:59'), SEOUL, SIX), '2026-12-26');
  assert.equal(businessDate(seoul('2026-12-27T06:00'), SEOUL, SIX), '2026-12-27');
  assert.equal(businessDate(seoul('2026-12-27T07:00'), SEOUL, SIX), '2026-12-27');
});

test('the cutoff uses the shop time zone, not UTC or the machine time zone', () => {
  // 서울 06:00 = UTC 전날 21:00. UTC 날짜로 계산하면 틀린다.
  assert.equal(businessDate(new Date('2026-12-26T20:59:00Z'), SEOUL, SIX), '2026-12-26');
  assert.equal(businessDate(new Date('2026-12-26T21:00:00Z'), SEOUL, SIX), '2026-12-27');
  assert.equal(businessDate(new Date('2026-12-26T21:00:00Z'), 'UTC', SIX), '2026-12-26');
});

test('month and year boundaries', () => {
  assert.equal(businessDate(seoul('2027-01-01T03:00'), SEOUL, SIX), '2026-12-31');
  assert.equal(businessDate(seoul('2027-03-01T05:00'), SEOUL, SIX), '2027-02-28');
  assert.equal(businessDate(seoul('2028-03-01T05:00'), SEOUL, SIX), '2028-02-29');
});

test('cutoff 00:00 is the calendar date; localDate ignores the cutoff', () => {
  assert.equal(businessDate(seoul('2026-12-27T00:00'), SEOUL, 0), '2026-12-27');
  assert.equal(businessDate(seoul('2026-12-26T23:59'), SEOUL, 0), '2026-12-26');
  assert.equal(localDate(seoul('2026-12-27T04:00'), SEOUL), '2026-12-27');
  assert.equal(localDate(new Date('2026-12-26T19:00:00Z'), SEOUL), '2026-12-27');
});

// 기기의 시계(work/impl-offline/plan.md O8 · O14 g, §7-9 clock.test): 두 시계가 맞으면 벽시계 나이 · `mono-`, 잠든 휴대폰(단조 시계가 40분 멈춤)은
// 벽시계 나이 · `wall-`, 벽시계가 10분 뒤로 가면 단조 시계 나이 · `jump-`, 앞 화면의 항목은 `wall-`, 만든 때 · 보낼 때의 서버 시각 차이, 톱니.
import { CLOCK_ANCHOR_PATTERN } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { ageOf, localBusinessDate, madeAtOf, newPageAnchor, offsetFrom, ratchet, stampItem } from '../src/local/clock.ts';
import { at, TestClocks } from './fake-server.ts';

const MIN = 60_000;
const WARN = 2 * MIN;

describe('나이와 시계 기준(O8)', () => {
  it('두 시계가 맞으면 벽시계 나이, mono-', () => {
    const clocks = new TestClocks(at(21, 55));
    const page = newPageAnchor();
    const item = stampItem(clocks, page, 0);
    clocks.advance(15 * MIN);
    const age = ageOf(item, clocks, page, 0, WARN);
    expect(age).toEqual({ ageMs: 15 * MIN, clockAnchor: 'mono-' + page });
    expect(age.clockAnchor).toMatch(CLOCK_ANCHOR_PATTERN);
  });

  it('주머니 속 휴대폰: 단조 시계가 40분 멈춰도 벽시계 나이(21:55의 수거가 22:10 옮김 뒤로 가지 않게), wall-', () => {
    const clocks = new TestClocks(at(21, 55));
    const page = newPageAnchor();
    const item = stampItem(clocks, page, 0);
    clocks.wallMs += 45 * MIN;
    clocks.monoMs += 5 * MIN;
    expect(ageOf(item, clocks, page, 0, WARN)).toEqual({ ageMs: 45 * MIN, clockAnchor: 'wall-' + page });
  });

  it('벽시계가 10분 뒤로 가면 단조 시계 나이, jump-', () => {
    const clocks = new TestClocks(at(22, 0));
    const page = newPageAnchor();
    const item = stampItem(clocks, page, 0);
    clocks.monoMs += 20 * MIN;
    clocks.wallMs += 10 * MIN;
    expect(ageOf(item, clocks, page, 0, WARN)).toEqual({ ageMs: 20 * MIN, clockAnchor: 'jump-' + page });
  });

  it('앞 화면(다시 연 뒤)의 항목은 단조 시계를 쓸 수 없어 벽시계 나이, wall- · 되돌린 기록(기준 글자 없음)은 이 화면의 글자', () => {
    const clocks = new TestClocks(at(22, 0));
    const item = stampItem(clocks, 'oldpage12345', 0);
    clocks.advance(30 * MIN);
    const page = newPageAnchor();
    expect(ageOf(item, clocks, page, 0, WARN)).toEqual({ ageMs: 30 * MIN, clockAnchor: 'wall-oldpage12345' });
    const restored = { ...item, pageAnchor: '' };
    expect(ageOf(restored, clocks, page, 0, WARN).clockAnchor).toBe('wall-' + page);
  });

  it('서버 시각 차이: 만든 때의 차이와 보낼 때의 차이로 센다(서버 시각 짐작이 양 끝에서 같게), 만든 때는 서버 시각', () => {
    const clocks = new TestClocks(at(22, 0) - 90_000);
    const page = newPageAnchor();
    const item = stampItem(clocks, page, 90_000);
    expect(madeAtOf(item)).toBe(new Date(at(22, 0)).toISOString());
    clocks.advance(10 * MIN);
    // 그사이 기기 시계를 맞춰 차이가 0이 되었다: 서버 시각 기준 나이는 그대로 10분.
    clocks.wallMs += 90_000;
    clocks.monoMs += 0;
    expect(ageOf(item, clocks, page, 0, WARN).ageMs).toBe(10 * MIN);
    // 나이는 0 아래로 가지 않는다.
    expect(ageOf({ ...item, pageAnchor: 'x' }, new TestClocks(0), page, 0, WARN).ageMs).toBe(0);
  });

  it('좋은 답의 서버 시각: 보낸 때와 받은 때의 가운데로 차이를 센다', () => {
    expect(offsetFrom('2026-12-26T13:00:01.000Z', Date.parse('2026-12-26T13:00:00.000Z'), Date.parse('2026-12-26T13:00:00.400Z'))).toBe(800);
    expect(offsetFrom(undefined, 0, 0)).toBeNull();
    expect(offsetFrom('not a time', 0, 0)).toBeNull();
  });
});

describe('톱니 · 영업일(O14 g)', () => {
  it('본 가장 늦은 벽시계보다 경고 시간 넘게 뒤면 뒤로 간 것', () => {
    expect(ratchet(undefined, 1_000, WARN)).toEqual({ maxSeenWall: 1_000, wentBack: false });
    expect(ratchet(10 * MIN, 9 * MIN, WARN)).toEqual({ maxSeenWall: 10 * MIN, wentBack: false });
    expect(ratchet(10 * MIN, 7 * MIN, WARN)).toEqual({ maxSeenWall: 10 * MIN, wentBack: true });
    expect(ratchet(10 * MIN, 12 * MIN, WARN)).toEqual({ maxSeenWall: 12 * MIN, wentBack: false });
  });

  it('영업일은 기준 시각 06:00으로(27일 05:59는 26일, 06:00은 27일)', () => {
    const settings = { businessDayCutoff: '06:00' } as Parameters<typeof localBusinessDate>[0]['settings'];
    expect(localBusinessDate({ settings }, at(5, 59, 1))).toBe('2026-12-26');
    expect(localBusinessDate({ settings }, at(6, 0, 1))).toBe('2026-12-27');
  });

  it('화면 기준 글자는 [0-9A-Za-z] 12자이고 화면마다 다르다', () => {
    const a = newPageAnchor();
    expect(a).toMatch(/^[0-9A-Za-z]{12}$/);
    expect(newPageAnchor()).not.toBe(a);
  });
});

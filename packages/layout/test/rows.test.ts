// 남는 높이를 줄에 나누기(fillRows): 기사 업무 판(V7, spec 3-8)의 품목 줄 60 ~ 88. 높이는 연결 띠를 늘 뺀 값이다.
import { describe, expect, it } from 'vitest';
import { fillRows } from '../src/rows.ts';

/** V7 왼쪽 종이의 품목 줄 자리: 화면 − 머리 60 − 띠 32 − 바닥 80 − 제목 56 − 팀 64 − 사이 8 − 표 머리 40 − 사이 8 − 돈 줄 48. */
const taskRows = (height: number) => height - 60 - 32 - 80 - 56 - 64 - 8 - 40 - 8 - 48;

describe('fillRows', () => {
  it('시안 V7: 1024×600은 두 줄 88, 1024×520은 두 줄 62(spec 3-8)', () => {
    expect(taskRows(600)).toBe(204);
    expect(fillRows(taskRows(600), 2, 60, 88)).toEqual({ rowPx: 88, perPage: 3, pageCount: 1 });
    expect(taskRows(520)).toBe(124);
    expect(fillRows(taskRows(520), 2, 60, 88)).toEqual({ rowPx: 62, perPage: 2, pageCount: 1 });
  });

  it('줄이 많으면 최소 높이로 한 쪽에 들어가는 만큼, 나머지는 다음 쪽', () => {
    expect(fillRows(124, 3, 60, 88)).toEqual({ rowPx: 62, perPage: 2, pageCount: 2 });
    expect(fillRows(324, 7, 60, 88)).toEqual({ rowPx: 64, perPage: 5, pageCount: 2 });
  });

  it('줄이 하나뿐이어도 최대 높이를 넘지 않고, 자리가 모자라도 한 줄은 최소 높이로 둔다', () => {
    expect(fillRows(400, 1, 60, 88)).toEqual({ rowPx: 88, perPage: 6, pageCount: 1 });
    expect(fillRows(40, 2, 60, 88)).toEqual({ rowPx: 60, perPage: 1, pageCount: 2 });
    expect(fillRows(200, 0, 52, 88)).toEqual({ rowPx: 88, perPage: 3, pageCount: 1 });
  });

  it('소수 높이는 내려 센다(반쯤 잘린 줄이 없게)', () => {
    expect(fillRows(179.6, 3, 52, 88)).toEqual({ rowPx: 59, perPage: 3, pageCount: 1 });
  });
});

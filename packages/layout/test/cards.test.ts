// 카드 목록의 칸 · 쪽 나누기(packCards · cardColumns): 매장 설정 · 운영 규칙(V8, spec 3-9)의 카드 다섯 장(높이 138 · 232 · 112 · 80 · 182).
// 자리 = 화면 높이 − 머리 60 − 바닥 72 − 제목 · 탭 60 − 위 여백 12.
import { describe, expect, it } from 'vitest';
import { cardColumns, packCards } from '../src/cards.ts';

const V8 = [138, 232, 112, 80, 182];
const room = (height: number) => height - 60 - 72 - 60 - 12;

describe('packCards', () => {
  it('1024×600: 한 쪽 두 칸(반납 · 보증금 | 결제 · 환불 · 영업일 기준 시각)', () => {
    expect(room(600)).toBe(396);
    expect(packCards(V8, room(600), 8, 2)).toEqual([[[0, 1], [2, 3, 4]]]);
  });

  it('1024×529: 두 쪽(반납 | 보증금, 결제 · 환불 | 영업일 기준 시각) — 카드는 자르지 않는다', () => {
    expect(room(529)).toBe(325);
    expect(packCards(V8, room(529), 8, 2)).toEqual([[[0], [1]], [[2, 3], [4]]]);
  });

  it('1024×569: 위에서 아래로 채우고 모자라면 오른쪽 칸(결제는 보증금 아래에 들어간다)', () => {
    expect(packCards(V8, room(569), 8, 2)).toEqual([[[0], [1, 2]], [[3, 4]]]);
  });

  it('한 칸(좁은 포스)이면 칸마다 쪽이다', () => {
    expect(packCards(V8, room(600), 8, 1)).toEqual([[[0, 1]], [[2, 3, 4]]]);
  });

  it('칸보다 큰 카드는 그 칸을 혼자 쓰고, 카드가 없으면 빈 칸 하나', () => {
    expect(packCards([500, 100], 300, 8, 2)).toEqual([[[0], [1]]]);
    expect(packCards([], 300, 8, 2)).toEqual([[[]]]);
  });
});

describe('cardColumns', () => {
  it('글 폭 964(1024)는 두 칸, 815 · 847(875 · 907)은 한 칸, 1306(1366)은 두 칸(카드 최소 468)', () => {
    expect(cardColumns(964, 468, 16)).toBe(2);
    expect(cardColumns(815, 468, 16)).toBe(1);
    expect(cardColumns(847, 468, 16)).toBe(1);
    expect(cardColumns(1306, 468, 16)).toBe(2);
    expect(cardColumns(0, 468, 16)).toBe(1);
  });
});

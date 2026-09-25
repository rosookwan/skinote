import { describe, expect, it } from 'vitest';
import { safeToApply } from '../src/app/pwa';

// 새 판 바꾸기(deployment 7절): 손대기 전이거나 새벽 5시대에 오래 손대지 않았고 열린 창이 없을 때만.
describe('safeToApply', () => {
  const loaded = 1_000_000;
  it('열고 나서 아무것도 누르지 않은 20초 안에는 바꾼다', () => {
    expect(safeToApply(loaded + 5_000, loaded, null, 14, false)).toBe(true);
  });
  it('20초가 지나면 손대지 않았어도 낮에는 바꾸지 않는다', () => {
    expect(safeToApply(loaded + 60_000, loaded, null, 14, false)).toBe(false);
  });
  it('한 번이라도 누른 뒤에는 낮에 바꾸지 않는다', () => {
    expect(safeToApply(loaded + 5_000, loaded, loaded + 1_000, 14, false)).toBe(false);
  });
  it('새벽 5시대에 5분 넘게 손대지 않았으면 바꾼다', () => {
    expect(safeToApply(loaded + 10 * 60_000, loaded, loaded + 60_000, 5, false)).toBe(true);
    expect(safeToApply(loaded + 3 * 60_000, loaded, loaded + 60_000, 5, false)).toBe(false);
  });
  it('열린 창(대화 상자)이 있으면 언제든 바꾸지 않는다', () => {
    expect(safeToApply(loaded + 1_000, loaded, null, 5, true)).toBe(false);
  });
});

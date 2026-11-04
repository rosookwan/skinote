// 기기의 시계(work/impl-offline/plan.md O8 · O14 g): 보냄 대기 항목이 언제 일어났는지를 서버에 알리는 법.
//   - 항목을 만들 때 벽시계(Date.now) · 단조 시계(performance.now) · 이 화면의 기준 글자 · 그때 아는 서버 시각 차이를 적는다.
//   - 보낼 때 나이(ageMs)를 센다. 벽시계 나이가 먼저다: 휴대폰이 잠들면 단조 시계가 멈춘다(Android CLOCK_MONOTONIC · iOS). 단조 시계는 같은
//     화면에서 만든 항목의 확인에만 쓴다.
//       · 앞 화면(다시 연 뒤)의 항목 → 벽시계 나이, `wall-…`
//       · 두 시계가 clock_warn_minutes 안에서 맞음 → 벽시계 나이, `mono-…`
//       · 벽시계 나이가 더 김(단조 시계가 멈춤: 잠) → 벽시계 나이, `wall-…`
//       · 벽시계 나이가 더 짧음(벽시계가 뒤로 감) → 단조 시계 나이, `jump-…`
//   - 만든 때(madeAt) = 만든 때의 벽시계 + 그때의 서버 시각 차이(서명에 든다).
//   - 서버 시각 짐작 = 벽시계 + 마지막 좋은 답의 차이(오간 시간의 반을 뺀다).
//   - 시계 톱니(ratchet): 본 가장 늦은 벽시계를 적어 두고, 벽시계가 그보다 clock_warn_minutes 넘게 뒤면 뒤로 간 것이다(기억한 세션을 믿지 않는다).
import { businessDateOf, shopCutoff, type ShopState } from '@skinote/domain';

export interface Clocks {
  wall(): number;
  mono(): number;
}

export const systemClocks: Clocks = {
  wall: () => Date.now(),
  mono: () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
};

const ALPHANUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 이 화면의 기준 글자(12자, [0-9A-Za-z]): 화면을 다시 열면 바뀐다. */
export function newPageAnchor(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  let out = '';
  for (const b of bytes) out += ALPHANUM[b % ALPHANUM.length];
  return out;
}

/** 항목을 만든 때의 시계. */
export interface ItemClock {
  createdWall: number;
  createdMono: number;
  pageAnchor: string;
  offsetAtCreate: number;
}

/** 항목을 만든 때를 적는다. */
export function stampItem(clocks: Clocks, pageAnchor: string, offsetMs: number): ItemClock {
  return { createdWall: clocks.wall(), createdMono: clocks.mono(), pageAnchor, offsetAtCreate: Math.round(offsetMs) };
}

/** 보낼 때의 나이와 시계 기준(O8). ageMs는 0 이상의 정수. */
export function ageOf(item: ItemClock, clocks: Clocks, pageAnchor: string, offsetNowMs: number, warnMs: number): { ageMs: number; clockAnchor: string } {
  const wallAge = (clocks.wall() + offsetNowMs) - (item.createdWall + item.offsetAtCreate);
  const clamp = (n: number) => Math.max(0, Math.round(n));
  // 앞 화면의 항목(되돌린 보낸 기록은 기준 글자가 비어 있다: 이 화면의 글자를 쓴다).
  if (item.pageAnchor !== pageAnchor) return { ageMs: clamp(wallAge), clockAnchor: 'wall-' + (/^[0-9A-Za-z]{8,32}$/.test(item.pageAnchor) ? item.pageAnchor : pageAnchor) };
  const monoAge = clocks.mono() - item.createdMono;
  if (wallAge < monoAge - warnMs) return { ageMs: clamp(monoAge), clockAnchor: 'jump-' + pageAnchor };
  if (wallAge > monoAge + warnMs) return { ageMs: clamp(wallAge), clockAnchor: 'wall-' + pageAnchor };
  return { ageMs: clamp(wallAge), clockAnchor: 'mono-' + pageAnchor };
}

/** 만든 때(서버 시각 짐작, ISO). */
export const madeAtOf = (item: ItemClock): string => new Date(item.createdWall + item.offsetAtCreate).toISOString();

/**
 * 서버 시각 − 기기 벽시계(좋은 답 하나에서): 보낸 때와 받은 때의 가운데를 서버가 답한 때로 본다. 답의 시각을 읽지 못하면 null.
 */
export function offsetFrom(serverTime: string | undefined, sentAtWall: number, receivedAtWall: number): number | null {
  const server = serverTime ? Date.parse(serverTime) : NaN;
  if (!Number.isFinite(server)) return null;
  return Math.round(server - (sentAtWall + receivedAtWall) / 2);
}

/** 시계 톱니: 본 가장 늦은 벽시계와 뒤로 갔는지. */
export function ratchet(maxSeenWall: number | undefined, wall: number, warnMs: number): { maxSeenWall: number; wentBack: boolean } {
  const seen = maxSeenWall ?? wall;
  return { maxSeenWall: Math.max(seen, wall), wentBack: wall < seen - warnMs };
}

/** 사본의 영업일 기준 시각으로 센 지금의 영업일(06:00 넘으면 다음 날). */
export function localBusinessDate(state: Pick<ShopState, 'settings'>, serverNowMs: number): string {
  return businessDateOf(serverNowMs, shopCutoff(state.settings));
}

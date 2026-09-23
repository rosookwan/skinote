// 해시 경로(GitHub Pages의 /skinote/ 아래에서도, base './'로 어디에 올려도 돈다). 경로 모양은 sys_screens의 route와 같다
// (/ledger/:date, /orders/:orderId, /collections/:date, /driver/:date). #/ledger는 오늘 장부, #/collection/:date는 수거 목록의
// 줄임 주소(같은 화면). 체험판 전용 경로: #/ 처음 화면, #/exit 나가기(?from=driver면 기사 기기의 나가기),
// #/driver/:date?device=phone 휴대폰 모양으로 보기.
// 온 곳(장부의 탭 · 쪽 · 고른 줄)은 브라우저 기록 상태에 넣어, 접수증의 '‹ 장부'가 그 쪽 그 줄로 돌아간다(ui 3-6, N9).
import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'start' }
  /** date가 null이면 서버가 준 오늘 영업일로 바꿔 연다. */
  | { name: 'ledger'; date: string | null }
  | { name: 'slip'; orderId: string }
  /** 카운터의 수거 목록(N3). date가 null이면 오늘. */
  | { name: 'collection'; date: string | null }
  | { name: 'exit'; from?: 'driver' }
  | { name: 'driver'; date: string; device: 'tablet' | 'phone' }
  | { name: 'unknown' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseHash(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts.length === 0) return { name: 'start' };
  const [head, arg] = parts;
  if (head === 'ledger' && parts.length === 1) return { name: 'ledger', date: null };
  if (head === 'ledger' && arg && DATE.test(arg) && parts.length === 2) return { name: 'ledger', date: arg };
  if (head === 'orders' && arg && parts.length === 2) return { name: 'slip', orderId: arg };
  if ((head === 'collections' || head === 'collection') && parts.length === 1) return { name: 'collection', date: null };
  if ((head === 'collections' || head === 'collection') && arg && DATE.test(arg) && parts.length === 2) return { name: 'collection', date: arg };
  if (head === 'exit' && parts.length === 1) return new URLSearchParams(query).get('from') === 'driver' ? { name: 'exit', from: 'driver' } : { name: 'exit' };
  if (head === 'driver' && arg && DATE.test(arg) && parts.length === 2) {
    return { name: 'driver', date: arg, device: new URLSearchParams(query).get('device') === 'phone' ? 'phone' : 'tablet' };
  }
  return { name: 'unknown' };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'start': return '#/';
    case 'ledger': return route.date ? '#/ledger/' + route.date : '#/ledger';
    case 'slip': return '#/orders/' + encodeURIComponent(route.orderId);
    case 'collection': return route.date ? '#/collections/' + route.date : '#/collections';
    case 'exit': return route.from === 'driver' ? '#/exit?from=driver' : '#/exit';
    case 'driver': return '#/driver/' + route.date + (route.device === 'phone' ? '?device=phone' : '');
    case 'unknown': return '#/';
  }
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  window.addEventListener('hashchange', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
    window.removeEventListener('hashchange', listener);
  };
}

const snapshot = () => window.location.hash;

export function useRoute(): Route {
  return parseHash(useSyncExternalStore(subscribe, snapshot, () => ''));
}

/** 기록 상태: 이 화면을 어디서 열었나, 장부로 돌아올 자리. */
export interface NavState {
  /** 장부에서 열었으면 true: '‹ 장부'가 브라우저 뒤로 가기로 그 자리에 돌아간다. */
  fromLedger?: boolean;
  /** 기사 목록에서 나가기를 열었으면 true: '수거 목록으로'가 뒤로 가기로 그 자리에 돌아간다. */
  fromDriver?: boolean;
  /** 장부 기록에 남기는 자리(탭 · 쪽 · 고른 줄). */
  ledger?: { tab: string; page: number; selected: string | null };
}

export function navState(): NavState {
  const state: unknown = typeof window === 'undefined' ? null : window.history.state;
  return state && typeof state === 'object' ? (state as NavState) : {};
}

/** 지금 기록의 상태를 고친다(주소는 그대로). */
export function patchNavState(patch: NavState): void {
  window.history.replaceState({ ...navState(), ...patch }, '');
}

export function go(route: Route, options: { replace?: boolean; state?: NavState } = {}): void {
  const url = hrefFor(route);
  if (options.replace) window.history.replaceState(options.state ?? null, '', url);
  else window.history.pushState(options.state ?? null, '', url);
  for (const listener of [...listeners]) listener();
}

export function back(): void {
  window.history.back();
}

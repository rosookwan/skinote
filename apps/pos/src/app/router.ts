// 해시 경로(GitHub Pages의 /skinote/ 아래에서도, base './'로 어디에 올려도 돈다). 경로 모양은 sys_screens의 route와 같다
// (/ledger/:date, /orders/:orderId, /orders/new, /collections/:date, /closing/:date, /driver/:date, /driver/tasks/:taskId, /manage).
// #/ledger는 오늘 장부, #/collection/:date는 수거 목록의 줄임 주소(같은 화면). 화면 안의 하위 경로(sys_screens에 따로 없음):
// #/orders/new/schedule 새 접수 ② 일정, #/orders/:orderId/pay 일괄 수납(접수증의 수납), #/driver/:date/deliveries 배달 목록,
// #/manage/settings/:tab 매장 설정(탭, 기본 운영 규칙). 체험판 전용 경로: #/ 처음 화면, #/exit 나가기(?from=driver면 기사 기기의
// 나가기), 기사 화면의 ?device=phone 휴대폰 모양으로 보기, 미리 보기 #/preview/keyboard · enroll · choose · login · offline · exit(화면
// 키보드, 서버 모드의 기기 등록 · 기기 선택(시험 매장의 열린 등록) · 로그인 · 연결 끊김 · 나가기 화면. 어디에도 연결하지 않은 주소 —
// 규칙 검사기가 기기 크기마다 재려고 연다. ?device=phone · tablet이면 기사 기기, 없으면 카운터. 로그인 · 기기 선택 미리 보기의 ?many는
// 쪽 넘김을 보려고 예시 이름 · 차량을 여러 번 늘어놓는다).
// 온 곳(장부의 탭 · 쪽 · 고른 줄)은 브라우저 기록 상태에 넣어, 접수증의 '‹ 장부'가 그 쪽 그 줄로 돌아간다(ui 3-6, N9).
import type { ScreenKey } from '@skinote/contract';
import { useSyncExternalStore } from 'react';

export type DeviceShape = 'tablet' | 'phone';

/** 새 접수의 단계(① 품목 · ② 일정). ③ 결제는 ② 위의 확인 창(V4)이라 경로가 없다. */
export type NewOrderStep = 'items' | 'schedule';

/** 매장 설정의 색인 탭(V8). 운영 규칙만 만들었고 나머지 탭은 준비 중인 화면이다. */
export const SETTINGS_TABS = ['info', 'places', 'slots', 'pricing', 'fleet', 'rules'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** 체험판 전용 미리 보기(계획 6-3): 화면 키보드, 서버 모드의 기기 등록 · 로그인 · 연결 끊김 · 나가기(로그아웃) 화면(규칙 검사기가 잰다). */
export const PREVIEW_VIEWS = ['keyboard', 'enroll', 'choose', 'login', 'offline', 'exit'] as const;
export type PreviewView = (typeof PREVIEW_VIEWS)[number];

export type Route =
  | { name: 'start' }
  /** date가 null이면 서버가 준 오늘 영업일로 바꿔 연다. */
  | { name: 'ledger'; date: string | null }
  | { name: 'slip'; orderId: string }
  /** 새 접수 ① 품목 · ② 일정(V2 · V3). */
  | { name: 'newOrder'; step: NewOrderStep }
  /** 일괄 수납(V5): 다른 팀 몫까지 받을 팀의 접수증에서. */
  | { name: 'groupPay'; orderId: string }
  /** 하루 마감(V6). date가 null이면 서버의 영업일. */
  | { name: 'closing'; date: string | null }
  /** 관리(머리줄 `관리`): 매장 설정 · 마감으로 가는 카드. */
  | { name: 'manage' }
  /** 매장 설정(V8은 운영 규칙 탭). */
  | { name: 'shopSettings'; tab: SettingsTab }
  /** 카운터의 수거 목록(N3). date가 null이면 오늘. */
  | { name: 'collection'; date: string | null }
  | { name: 'exit'; from?: 'driver' }
  | { name: 'driver'; date: string; device: DeviceShape }
  /** 기사 배달 목록(아침 · 낮, ui 6-5). */
  | { name: 'deliveries'; date: string; device: DeviceShape }
  /** 기사 업무 판(V7): 배달 · 수거 한 팀. */
  | { name: 'task'; taskId: string; device: DeviceShape }
  /** 체험판 전용 미리 보기. device가 있으면 기사 기기(휴대폰 · 태블릿), 없으면 카운터. */
  | { name: 'preview'; view: PreviewView; device: DeviceShape | null }
  | { name: 'unknown' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const deviceOf = (query: string): DeviceShape => (new URLSearchParams(query).get('device') === 'phone' ? 'phone' : 'tablet');
const deviceQuery = (device: DeviceShape) => (device === 'phone' ? '?device=phone' : '');
const isSettingsTab = (tab: string | undefined): tab is SettingsTab => (SETTINGS_TABS as readonly string[]).includes(tab ?? '');
const isPreviewView = (view: string | undefined): view is PreviewView => (PREVIEW_VIEWS as readonly string[]).includes(view ?? '');
/** 미리 보기의 기기: ?device=phone · tablet이면 기사 기기, 없으면 카운터. */
const previewDevice = (query: string): DeviceShape | null => {
  const device = new URLSearchParams(query).get('device');
  return device === 'phone' || device === 'tablet' ? device : null;
};

export function parseHash(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts.length === 0) return { name: 'start' };
  const [head, arg, third] = parts;
  if (head === 'ledger' && parts.length === 1) return { name: 'ledger', date: null };
  if (head === 'ledger' && arg && DATE.test(arg) && parts.length === 2) return { name: 'ledger', date: arg };
  // 새 접수(/orders/new)는 접수 번호 자리보다 먼저 가른다(접수 id가 'new'인 일은 없다).
  if (head === 'orders' && arg === 'new' && parts.length === 2) return { name: 'newOrder', step: 'items' };
  if (head === 'orders' && arg === 'new' && third === 'schedule' && parts.length === 3) return { name: 'newOrder', step: 'schedule' };
  if (head === 'orders' && arg && parts.length === 2) return { name: 'slip', orderId: arg };
  if (head === 'orders' && arg && arg !== 'new' && third === 'pay' && parts.length === 3) return { name: 'groupPay', orderId: arg };
  if (head === 'closing' && parts.length === 1) return { name: 'closing', date: null };
  if (head === 'closing' && arg && DATE.test(arg) && parts.length === 2) return { name: 'closing', date: arg };
  if (head === 'manage' && parts.length === 1) return { name: 'manage' };
  if (head === 'manage' && arg === 'settings' && parts.length === 2) return { name: 'shopSettings', tab: 'rules' };
  if (head === 'manage' && arg === 'settings' && isSettingsTab(third) && parts.length === 3) return { name: 'shopSettings', tab: third };
  if ((head === 'collections' || head === 'collection') && parts.length === 1) return { name: 'collection', date: null };
  if ((head === 'collections' || head === 'collection') && arg && DATE.test(arg) && parts.length === 2) return { name: 'collection', date: arg };
  if (head === 'exit' && parts.length === 1) return new URLSearchParams(query).get('from') === 'driver' ? { name: 'exit', from: 'driver' } : { name: 'exit' };
  if (head === 'driver' && arg === 'tasks' && third && parts.length === 3) return { name: 'task', taskId: third, device: deviceOf(query) };
  if (head === 'driver' && arg && DATE.test(arg) && parts.length === 2) return { name: 'driver', date: arg, device: deviceOf(query) };
  if (head === 'driver' && arg && DATE.test(arg) && third === 'deliveries' && parts.length === 3) return { name: 'deliveries', date: arg, device: deviceOf(query) };
  if (head === 'preview' && isPreviewView(arg) && parts.length === 2) return { name: 'preview', view: arg, device: previewDevice(query) };
  return { name: 'unknown' };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'start': return '#/';
    case 'ledger': return route.date ? '#/ledger/' + route.date : '#/ledger';
    case 'slip': return '#/orders/' + encodeURIComponent(route.orderId);
    case 'newOrder': return route.step === 'schedule' ? '#/orders/new/schedule' : '#/orders/new';
    case 'groupPay': return '#/orders/' + encodeURIComponent(route.orderId) + '/pay';
    case 'closing': return route.date ? '#/closing/' + route.date : '#/closing';
    case 'manage': return '#/manage';
    case 'shopSettings': return '#/manage/settings/' + route.tab;
    case 'collection': return route.date ? '#/collections/' + route.date : '#/collections';
    case 'exit': return route.from === 'driver' ? '#/exit?from=driver' : '#/exit';
    case 'driver': return '#/driver/' + route.date + deviceQuery(route.device);
    case 'deliveries': return '#/driver/' + route.date + '/deliveries' + deviceQuery(route.device);
    case 'task': return '#/driver/tasks/' + encodeURIComponent(route.taskId) + deviceQuery(route.device);
    case 'preview': return '#/preview/' + route.view + (route.device ? '?device=' + route.device : '');
    case 'unknown': return '#/';
  }
}

/**
 * 화면 키(sys_screens, 동작의 screen_key · 메뉴의 screen_key)가 여는 경로. 아직 없는 화면은 null(부르는 쪽이 `준비 중인 화면`).
 * date는 날짜가 있는 화면(마감 · 수거 목록)의 영업일, 없으면 오늘.
 */
export function screenRoute(screen: ScreenKey, params: { date?: string | null; orderId?: string } = {}): Route | null {
  switch (screen) {
    case 'day_ledger': return { name: 'ledger', date: params.date ?? null };
    case 'order_slip': return params.orderId ? { name: 'slip', orderId: params.orderId } : null;
    case 'new_order': return { name: 'newOrder', step: 'items' };
    case 'closing': return { name: 'closing', date: params.date ?? null };
    case 'collection_list': return { name: 'collection', date: params.date ?? null };
    case 'management': return { name: 'manage' };
    default: return null;
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
  /** 접수증에서 일괄 수납(V5)을 열었으면 true: '‹ 접수증' · 수납 뒤에 뒤로 가기로 그 접수증에 돌아간다(장부 자리도 그대로). */
  fromSlip?: boolean;
  /** 장부 기록에 남기는 자리(탭 · 쪽 · 고른 줄). */
  ledger?: { tab: string; page: number; selected: string | null };
  /** 기사 목록(배달 · 수거)에서 업무 판(V7)을 열었으면 true: '‹ 배달 목록'이 뒤로 가기로 그 쪽 그 줄에 돌아간다(N9). */
  fromList?: boolean;
  /** 기사 목록 기록에 남기는 자리(쪽 · 연 줄). 탭은 기기에 남는다. */
  list?: { page: number; selected: string | null };
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

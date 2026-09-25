// 선 그림 아이콘(시안의 기호와 같은 모양). 크기는 글자 크기를 따른다(em).
import type { ReactElement } from 'react';

export type IconName =
  | 'book' | 'keypad' | 'bell' | 'exit' | 'phone' | 'lock' | 'check' | 'up' | 'down' | 'top' | 'left' | 'right' | 'more' | 'truck' | 'clock'
  | 'money' | 'ticket' | 'ban';

const PATHS: Record<IconName, ReactElement> = {
  book: <><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v15H5.5A1.5 1.5 0 0 0 4 19.5z" /><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H19v-3" /><path d="M8 7h7M8 10.5h7" /></>,
  keypad: <><rect x="4" y="3" width="4" height="4" rx="1" /><rect x="10" y="3" width="4" height="4" rx="1" /><rect x="16" y="3" width="4" height="4" rx="1" /><rect x="4" y="10" width="4" height="4" rx="1" /><rect x="10" y="10" width="4" height="4" rx="1" /><rect x="16" y="10" width="4" height="4" rx="1" /><rect x="10" y="17" width="4" height="4" rx="1" /></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9" /><path d="M10.3 20.5a1.9 1.9 0 0 0 3.4 0" /></>,
  exit: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
  phone: <path d="M21 16.5v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2.5 5.2 2 2 0 0 1 4.5 3h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.4 10.8a16 16 0 0 0 4.8 4.8l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  up: <path d="m6 15 6-6 6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  top: <><path d="M5 4h14" /><path d="m6 15 6-6 6 6" /><path d="M12 9v11" /></>,
  left: <path d="m15 6-6 6 6 6" />,
  right: <path d="m9 6 6 6-6 6" />,
  more: <><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>,
  truck: <><path d="M2 6h12v10H2z" /><path d="M14 9h4l3 3v4h-7" /><circle cx="6.5" cy="17.5" r="2" /><circle cx="17.5" cy="17.5" r="2" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  // 기사 업무 판(V7, spec 3-8)의 큰 옆 버튼: 지폐(현장 수납) · 권(리프트권 추가) · 금지(배달 실패 · 수거 실패). 24 격자 · 선 2.
  money: <><rect x="2" y="5" width="20" height="14" rx="2" /><circle cx="12" cy="12" r="3" /><path d="M6 10v4M18 10v4" /></>,
  ticket: <><path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v2.5a2.5 2.5 0 0 0 0 5V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2.5a2.5 2.5 0 0 0 0-5z" /><path d="M15 5v2.5M15 11v2M15 16.5V19" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></>,
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="sn-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

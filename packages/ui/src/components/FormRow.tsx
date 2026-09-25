// 이름표 줄(시안의 mk-form-row): 왼쪽 이름표 칸(6em, 회색 굵은 16px) + 내용. 창 안 · 종이 안의 한 줄이다(일정 변경의 반납 시각 등).
// 쓰지 않게 된 줄(매장 직접일 때의 수거 차량)은 blank로 자리만 남긴다: 창 높이 · 다른 줄 자리가 흔들리지 않는다(spec 2-1 다).
import type { ReactNode } from 'react';

export interface FormRowProps {
  label: string;
  children: ReactNode;
  /** 내용이 여러 줄이면 이름표를 첫 줄 높이에 맞춘다(변경 품목의 수량 칸 두 줄). */
  top?: boolean;
  /** 자리만 남기고 보이지 않게(읽지도 않는다). */
  blank?: boolean;
  className?: string;
}

export function FormRow({ label, children, top = false, blank = false, className }: FormRowProps) {
  const classes = ['sn-form-row', top ? 'is-top' : '', blank ? 'is-blank' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={classes} {...(blank ? { 'aria-hidden': true } : {})}>
      <span className="sn-form-label">{label}</span>
      <div className="sn-form-value">{children}</div>
    </div>
  );
}

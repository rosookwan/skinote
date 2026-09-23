// 주 버튼: 한 화면에 하나(포스 주황 · 기사 보라, 색은 등급의 강조색). 높이는 등급의 주 버튼 크기, 휴대폰은 가로 전체.
import type { ReactNode } from 'react';
import { TextFit } from './TextFit.tsx';

export interface PrimaryButtonProps {
  label: ReactNode;
  /** 폭이 모자라면 쓸 짧은 이름들(긴 것부터: '매장 입고 14개', '입고 14개'). 주면 label 대신 맞춰 쓴다. */
  alts?: readonly string[];
  /** 남는 폭을 모두 차지(휴대폰 바닥줄: 가로 전체). */
  fill?: boolean;
  onPress: () => void;
  disabled?: boolean;
  /** 결과를 기다리는 중('처리 중'): 두 번 눌러도 같은 요청번호로 간다. */
  busy?: boolean;
  className?: string;
}

export function PrimaryButton({ label, alts, fill = false, onPress, disabled = false, busy = false, className }: PrimaryButtonProps) {
  return (
    <button
      type="button"
      className={['sn-primary', fill ? 'is-fill' : '', className ?? ''].filter(Boolean).join(' ')}
      data-primary="true"
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={onPress}
    >
      {alts && alts.length ? <TextFit input={{ mode: 'alts', alts }} /> : label}
    </button>
  );
}

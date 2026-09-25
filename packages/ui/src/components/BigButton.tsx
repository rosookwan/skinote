// 큰 옆 버튼(기사 업무 판 V7, spec 3-8 · ui 6-5): 선 그림 위 · 굵은 글(등급의 큰 글자) 아래, 둘째 줄은 작은 회색 글
// (`리프트권 추가` / `야간권 재고 6매`). 태블릿은 2 × 2로 판을 채우고(높이는 부르는 쪽이 정함), 휴대폰은 한 줄로 누운 56px 버튼(layout row).
// 글은 읽기 모델(TaskSheetAction)이 주고 부품은 그리기만 한다. 누를 수 없으면 회색이고 읽는 이름에 까닭이 붙는다.
import type { IconName } from '../icons.tsx';
import { Icon } from '../icons.tsx';
import { TextFit } from './TextFit.tsx';

export interface BigButtonProps {
  icon: IconName;
  label: string;
  secondLine?: string;
  disabled?: boolean;
  /** 누를 수 없는 까닭(읽는 이름에 붙음). */
  reason?: string;
  /** 'row': 그림 왼쪽 · 글 오른쪽(휴대폰 2 × 2). 기본은 그림 위 · 글 아래. */
  layout?: 'column' | 'row';
  onPress: () => void;
}

export function BigButton({ icon, label, secondLine, disabled = false, reason, layout = 'column', onPress }: BigButtonProps) {
  const aria = [label, secondLine, disabled ? reason : undefined].filter(Boolean).join(' · ');
  return (
    <button type="button" className={'sn-button sn-big-button' + (layout === 'row' ? ' is-row' : '')} disabled={disabled} aria-label={aria} onClick={onPress}>
      <Icon name={icon} />
      <span className="sn-big-text">
        {/* 이름은 줄이지 않는다(`리프트권 추가`에서 낱말이 빠지면 뜻이 바뀜). 둘째 줄은 들어가지 않으면 통째로 빠진다. */}
        <TextFit input={{ mode: 'alts', alts: [label] }} />
        {secondLine ? <TextFit className="sn-big-second" input={{ mode: 'alts', alts: [secondLine, ''] }} /> : null}
      </span>
    </button>
  );
}

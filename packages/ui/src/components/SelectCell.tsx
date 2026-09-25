// 고르는 칸(SelectCell, 시안 V5의 v5-check): 표 줄 맨 앞의 칸 전체(56 × 52)가 누르는 곳이고, 가운데 28px 네모에 체크 그림(고름 = 남색 바탕 ·
// 크림 체크, 안 고름 = 빈 네모). 읽는 이름은 부르는 쪽이 준다('이정호 · 0032 선택'). 무엇이 골라졌는지는 읽기 모델이 정했고 부품은 누름만 알린다.
import { Icon } from '../icons.tsx';

export interface SelectCellProps {
  checked: boolean;
  label: string;
  onToggle: () => void;
  disabled?: boolean;
}

export function SelectCell({ checked, label, onToggle, disabled = false }: SelectCellProps) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} className="sn-select-cell" disabled={disabled} onClick={onToggle}>
      <span className="sn-select-box" aria-hidden="true">{checked ? <Icon name="check" /> : null}</span>
    </button>
  );
}

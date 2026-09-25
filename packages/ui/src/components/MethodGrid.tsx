// 결제 수단 2 × 2(MethodGrid, 시안 V5 오른쪽 판의 v5-methods): 카드 · 현금 · 계좌이체 · `기타`. 버튼은 고르기 버튼(ChoiceButton)이라 고른 것은
// 남색 바탕 · 크림 글자(주황 아님), `기타` 판의 수단을 고르면 `기타` 두 줄(`기타` / `간편결제`). 칸 수 · 이름 · 고름은 읽기 모델(ChoiceOption)이
// 정하고 부품은 누른 key만 알린다.
import type { ChoiceOption } from '@skinote/contract';
import { ChoiceButton } from './Choice.tsx';

export interface MethodGridProps {
  options: ChoiceOption[];
  /** 묶음의 읽는 이름('결제 수단'). */
  label: string;
  onPress: (key: string) => void;
}

export function MethodGrid({ options, label, onPress }: MethodGridProps) {
  return (
    <div className="sn-method-grid" role="group" aria-label={label}>
      {options.map((option) => <ChoiceButton key={option.key} option={option} onPress={onPress} />)}
    </div>
  );
}

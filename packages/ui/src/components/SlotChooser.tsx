// 반납 시각 고르기(SlotChooser, ui 5): 반납 타임(`오전타임 후 12:00` · `오후 16:30` · `야간 22:00` · `심야 24:00`)과 날(`내일` · `다른 날 ›`)이
// 한 줄. 오늘 이미 지났거나 10분 안인 타임은 읽기 모델이 누를 수 없게 준다(점선 · 회색, 까닭은 읽는 이름). 좁으면 타임은 시각만.
import type { ChoiceOption } from '@skinote/contract';
import { ChoiceRow } from './Choice.tsx';

export interface SlotChooserProps {
  slots: ChoiceOption[];
  days: ChoiceOption[];
  onSlot: (key: string) => void;
  onDay: (key: string) => void;
  label: string;
  /** 버튼마다 읽는 이름('다른 날 · 날짜 선택'). */
  names?: Readonly<Record<string, string>>;
}

export function SlotChooser({ slots, days, onSlot, onDay, label, names }: SlotChooserProps) {
  const slotKeys = new Set(slots.map((s) => s.key));
  return (
    <ChoiceRow
      options={[...slots, ...days]}
      onPress={(key) => (slotKeys.has(key) ? onSlot(key) : onDay(key))}
      label={label}
      {...(names ? { names } : {})}
    />
  );
}

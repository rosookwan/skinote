// 수량 −/+ 칸(시안의 mk-step): 이름 · 둘째 줄('대여 2대' · '설천 2 · 두솔동 1') · − · 값 · +. 누르는 곳은 등급 최소 크기(sn-qty-button).
// 0은 옅은 먹(옮기지 않음). 범위(최소 · 최대 · 단위)는 읽기 모델이 준다: 부품은 누른 값을 알리기만 한다.
// 둘째 줄이 칸보다 넓으면 ' · ' 조각을 뒤에서부터 통째로 뺀다(첫 조각은 남김, 말줄임 없음: `사이즈 95 · 잔여 2벌 · 1벌 20,000원` → `사이즈 95 · 잔여 2벌`).
import type { QuantityInput } from '@skinote/contract';
import { t } from '../strings.ko-KR.ts';
import { TextFit } from './TextFit.tsx';

export interface QtyStepperProps {
  name: string;
  note: string;
  quantity: QuantityInput;
  onChange: (value: number) => void;
  /** 묶음의 읽는 이름('스키 수량'). */
  label: string;
}

export function QtyStepper({ name, note, quantity, onChange, label }: QtyStepperProps) {
  const { value, min, max, unit } = quantity;
  return (
    <div className="sn-step" role="group" aria-label={label}>
      <span className="sn-step-name">
        <b>{name}</b>
        <small><TextFit input={{ mode: 'parts', parts: note.split(' · ').map((text, i) => ({ text, drop: i })) }} /></small>
      </span>
      <button type="button" className="sn-qty-button" aria-label={t('qtyMinus')} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
      <output className={'sn-qty-value' + (value === 0 ? ' is-zero' : '')} aria-live="polite">{value + unit}</output>
      <button type="button" className="sn-qty-button" aria-label={t('qtyPlus')} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}

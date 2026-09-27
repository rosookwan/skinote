// 직접 입력 할인의 흐름(features-1 §6-2 · §6-5): 종류 판(`금액` · `비율`, 종류가 하나면 건너뜀 — 리프트권은 비율만) → 숫자판(범위 · 10원 단위는
// 읽기 모델의 값, 보는 사람의 한도를 넘으면 숫자판 아래 `권한 없음 · 관리자 확인 필요`이고 `입력`이 눌리지 않는다) → 사유 키보드(`할인 사유`,
// 20자). 끝나면 고른 것(금액 · 비율 · 사유)을 부르는 쪽에 넘긴다: 접수 확정 창(V4 `할인 적용 ›`)과 접수증의 할인 적용 창이 같이 쓴다.
// 화면은 할인 금액을 셈하지 않는다: 값과 사유를 인자로 다시 물으면 읽기 모델이 상태 글 · 받을 금액을 써 준다.
import type { ManualDiscount, ManualDiscountKind, ManualDiscountSpec } from '@skinote/contract';
import { NumberPad } from '@skinote/ui';
import { useState } from 'react';
import { inputAccepts } from '../app/settings-draft.ts';
import { ChoiceSheet } from './NoticeDialog.tsx';
import { TextSheet } from './TextSheet.tsx';

/** 숫자판이 받는 값인지: 범위 · 단위 안이고 한도를 넘지 않는다(한도는 읽기 모델의 값). */
export function manualAccepts(kind: ManualDiscountKind, digits: string): boolean {
  if (!inputAccepts(kind.input, digits)) return false;
  return kind.limit === undefined || Number(digits) <= kind.limit;
}

/** 한도를 넘은 값인지(숫자판 아래 한 줄). */
export const overLimit = (kind: ManualDiscountKind, digits: string) => kind.limit !== undefined && digits !== '' && Number(digits) > kind.limit;

type Step = { kind: 'kind' } | { kind: 'pad'; key: ManualDiscount['kind']; digits: string } | { kind: 'reason'; key: ManualDiscount['kind']; value: number };

export interface ManualDiscountFlowProps {
  spec: ManualDiscountSpec;
  onDone: (manual: ManualDiscount) => void;
  onClose: () => void;
}

export function ManualDiscountFlow({ spec, onDone, onClose }: ManualDiscountFlowProps) {
  const only = spec.kinds.length === 1 ? spec.kinds[0]! : null;
  const [step, setStep] = useState<Step>(only ? { kind: 'pad', key: only.key, digits: '' } : { kind: 'kind' });
  const kindOf = (key: ManualDiscount['kind']) => spec.kinds.find((k) => k.key === key)!;

  if (step.kind === 'kind') {
    return (
      <ChoiceSheet
        title={spec.title}
        choices={spec.kinds.map((k) => ({ key: k.key, label: k.label }))}
        onPick={(key) => setStep({ kind: 'pad', key: key as ManualDiscount['kind'], digits: '' })}
        onClose={onClose}
      />
    );
  }
  if (step.kind === 'pad') {
    const kind = kindOf(step.key);
    const over = overLimit(kind, step.digits);
    return (
      <NumberPad
        mode={kind.input.mode === 'percent' ? 'percent' : 'amount'}
        title={kind.input.title}
        value={step.digits}
        onChange={(digits) => setStep({ ...step, digits })}
        accept={(digits) => manualAccepts(kind, digits)}
        onSubmit={(digits) => { if (manualAccepts(kind, digits)) setStep({ kind: 'reason', key: step.key, value: Number(digits) }); }}
        onClose={only ? onClose : () => setStep({ kind: 'kind' })}
        {...(over ? { note: kind.overLimit ?? spec.overLimit } : kind.input.note ? { note: kind.input.note } : {})}
      />
    );
  }
  return (
    <TextSheet
      title={spec.reason.title}
      value=""
      placeholder={spec.reason.title}
      maxLength={spec.reason.maxLength}
      required
      onSubmit={(text) => onDone({ kind: step.key, value: step.value, reason: text.trim() })}
      onClose={() => setStep({ kind: 'pad', key: step.key, digits: String(step.value) })}
    />
  );
}

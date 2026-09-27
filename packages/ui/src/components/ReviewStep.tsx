// 막는 단계(ui 5 `ReviewStep`, sync 4-3 dialog_step, features-1 §9-3): 열린 창 안에서 먼저 답할 `사실 · 할 일` 한 줄(두 줄까지, 할 일 조각이 먼저 빠짐)과
// 그 버튼 둘. 첫 버튼이 그 창의 주 버튼 하나(`재확인`), 둘째는 보통 버튼(`닫기`)이다. 마감 창의 `1호 차량 기록 2건 전송 대기 · 마감 전 전송 필요`.
// 빨강을 쓰지 않는다(늦음이 아니다): 연결 띠와 같은 노랑 바탕.
import type { ReviewStepView } from '@skinote/contract';
import { PrimaryButton } from './PrimaryButton.tsx';
import { TextFit } from './TextFit.tsx';

export interface ReviewStepProps {
  step: ReviewStepView;
  /** 버튼을 누름(key = 읽기 모델의 choices key). */
  onChoice: (key: ReviewStepView['choices'][number]['key']) => void;
  /** 주 버튼이 일하는 중(다시 묻는 동안). */
  busy?: boolean;
}

/** 단계의 한 줄(읽는 이름은 온전한 문장). 창의 본문에 둔다. */
export function ReviewStepLine({ step }: Pick<ReviewStepProps, 'step'>) {
  return (
    <div className="sn-review-step" role="alert" aria-label={step.message}>
      <TextFit className="sn-review-step-text" input={{ mode: 'parts', parts: step.parts }} lines={2} />
    </div>
  );
}

/** 단계의 버튼 둘(창의 바닥줄): 둘째(닫기)는 보통 버튼, 첫째(재확인)는 주 버튼. */
export function ReviewStepButtons({ step, onChoice, busy = false }: ReviewStepProps) {
  const [first, ...rest] = step.choices;
  return (
    <>
      {rest.map((choice) => (
        <button key={choice.key} type="button" className="sn-button" onClick={() => onChoice(choice.key)}>{choice.label}</button>
      ))}
      {first ? <PrimaryButton label={first.label} busy={busy} disabled={busy} onPress={() => onChoice(first.key)} /> : null}
    </>
  );
}

// 빨리 확인 줄(ui 5 PinBar, A3): 목록 맨 위에 고정. '빨리 확인 · 21:50 · 꽃마을 들국화 · 오승민 · 0039 · 조기 반납' + 전화.
// 둘 이상이면 '빨리 확인 N건 더'. 기사가 확인하면 notification.ack(부르는 쪽). 늦음이 아니므로 빨강을 쓰지 않는다.
// 좁으면(휴대폰) 읽기 모델의 조각 순서대로 빠진다: 메모 → 시각(묶음 제목에 있다) → 장소는 짧은 이름('들국화')으로. 이름 · 끝 4자리는 남는다.
import type { PinRow } from '@skinote/contract';
import { useUi } from '../context.tsx';
import { formatTime } from '../format.ts';
import { Icon } from '../icons.tsx';
import { t } from '../strings.ko-KR.ts';
import { TextFit } from './TextFit.tsx';

export interface PinBarProps {
  /** 가장 급한 한 건(읽기 모델의 pins[0]). */
  pin: PinRow;
  /** 나머지 수. */
  moreCount: number;
  onOpen?: (pin: PinRow) => void;
  onCall?: (pin: PinRow) => void;
  onAck?: (pin: PinRow) => void;
  onMore?: () => void;
  /** 좁은 화면(휴대폰): 전화 버튼을 그림만으로(읽는 이름은 그대로) 해 글자 자리를 넓힌다. */
  compact?: boolean;
}

export function PinBar({ pin, moreCount, onOpen, onCall, onAck, onMore, compact = false }: PinBarProps) {
  const { timezone } = useUi();
  const parts = [
    { text: t('pinTitle'), drop: 0 },
    // 시각은 줄의 묶음 제목('21:50 반납')에도 있어 메모 다음으로 빠진다(장소보다 먼저).
    { text: formatTime(pin.at, timezone), drop: 2 },
    ...pin.parts,
    ...(moreCount > 0 ? [{ text: t('pinMore', { n: moreCount }), drop: 1 }] : []),
  ];
  // 빨리 확인 줄(64px)은 두 줄까지 내려 쓴다(휴대폰).
  const text = <TextFit className="sn-pin-text" input={{ mode: 'parts', parts }} lines={2} />;
  return (
    <div className="sn-pin" role="status">
      {onOpen || (moreCount > 0 && onMore) ? (
        <button type="button" className="sn-pin-open" onClick={() => (moreCount > 0 && onMore ? onMore() : onOpen?.(pin))}>
          {text}
        </button>
      ) : (
        <div className="sn-pin-open">{text}</div>
      )}
      {pin.phone && onCall ? (
        compact ? (
          <button type="button" className="sn-icon-button" aria-label={t('call')} onClick={() => onCall(pin)}>
            <Icon name="phone" />
          </button>
        ) : (
          <button type="button" className="sn-button" onClick={() => onCall(pin)}>
            <Icon name="phone" />
            <span>{t('call')}</span>
          </button>
        )
      ) : null}
      {pin.status !== 'acknowledged' && onAck ? (
        <button type="button" className="sn-button" onClick={() => onAck(pin)}>
          {t('pinAck')}
        </button>
      ) : null}
    </div>
  );
}

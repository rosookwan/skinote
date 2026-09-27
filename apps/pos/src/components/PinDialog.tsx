// 비밀번호 재발급 창(매장 설정 `차량 · 직원`의 직원 항목 판, features-1 plan E15 · §4-4): 서버 모드에만 있다. 먼저 숫자판 `본인 비밀번호`
// (요청한 관리자의 비밀번호, 표시는 ● ● ● ●)를 받아 서버에 보내고, 맞으면 새 비밀번호를 한 번 보인다: 제목 `새 비밀번호 · {이름}`, 숫자는 큰 글자로
// 띄어서, 한 줄 `1회 표시 · 직원 전달`, 버튼은 주 버튼 `확인` 하나(닫기 · Esc 없음). 닫으면 새 비밀번호를 메모리에서 버린다(다시 볼 수 없다: 잊으면 다시 재발급).
// 틀리면 숫자판에 한 줄(`비밀번호 불일치 · 재입력 필요` · `로그인 잠김 · {time} 이후 가능`). 브라우저에서 비밀번호를 만들지 않는다(서버가 만든다).
// 미리 보기(#/preview/pin)는 정한 예시 숫자로 둘째 단계만 그린다(규칙 검사기가 잰다).
import { DialogFrame, NumberPad, PrimaryButton, formatTime, t, useUi } from '@skinote/ui';
import { useState } from 'react';
import type { AppClient } from '../app/client.tsx';
import { ServerRefusal } from '../app/server-refusal.ts';
import { say } from '../app/strings.ts';

export interface PinDialogProps {
  client: AppClient;
  staffId: string;
  name: string;
  onClose: () => void;
  /** 미리 보기: 서버 없이 둘째 단계(새 비밀번호)를 이 숫자로 그린다. */
  preview?: string;
}

/** 서버의 거절 코드 → 숫자판의 한 줄(문구 표 3-17). */
function refusalLine(error: unknown, timezone: string): string {
  const code = error instanceof ServerRefusal ? error.code : 'NETWORK';
  if (code === 'PIN_MISMATCH') return say('pinWrong');
  if (code === 'LOCKED' && error instanceof ServerRefusal && error.lockedUntil) return say('loginLocked', { time: formatTime(error.lockedUntil, timezone) });
  if (code === 'RATE_LIMITED' || code === 'BUSY' || code === 'LOCKED') return say('tooManyTries');
  if (code === 'NETWORK') return say('sendFailed');
  return say('commandFailed');
}

/** 새 비밀번호의 큰 글(숫자 사이를 띄운다: `4 8 2 1`). */
export const pinSpaced = (pin: string): string => [...pin].join(' ');

export function PinDialog({ client, staffId, name, onClose, preview }: PinDialogProps) {
  const { timezone } = useUi();
  const [digits, setDigits] = useState('');
  const [line, setLine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState<string | null>(preview ?? null);
  const close = () => {
    setPin(null);
    setDigits('');
    onClose();
  };
  if (pin === null) {
    const submit = (own: string) => {
      if (busy || !client.staffPin) return;
      setBusy(true);
      setLine(null);
      client.staffPin(staffId, own).then((result) => {
        setBusy(false);
        setDigits('');
        setPin(result.pin);
      }, (error: unknown) => {
        setBusy(false);
        setDigits('');
        setLine(refusalLine(error, timezone));
      });
    };
    return (
      <NumberPad
        mode="pin"
        title={say('pinOwn')}
        value={digits}
        onChange={(d) => { setDigits(d); setLine(null); }}
        onSubmit={submit}
        onClose={close}
        {...(line ? { note: line } : busy ? { note: t('processing') } : {})}
      />
    );
  }
  return (
    <DialogFrame
      title={say('pinNewTitle', { name })}
      onClose={close}
      className="pos-pin-dialog"
      // 버튼은 `확인` 하나(닫기 · Esc 없음): 적기 전에 잘못 눌러 한 번뿐인 비밀번호를 잃지 않게.
      closable={false}
      primary={<PrimaryButton label={t('confirm')} onPress={close} />}
    >
      <p className="pos-pin-digits" aria-label={say('pinNewTitle', { name })}>{pinSpaced(pin)}</p>
      <p className="pos-pin-note" role="status">{say('pinOnce')}</p>
    </DialogFrame>
  );
}

// 기기 등록(계획 work/impl-server/plan.md 6-3): 종이 한 장에 `기기 등록` · `등록 번호 12자리`와 화면 안 숫자판(등록 번호 모드, 넷씩
// 끊어 보임). 번호는 운영자가 명령줄로 한 번 받은 12자리다(화면에 영어 글자가 없어 숫자만). `입력`을 누르면 부르는 쪽(session.tsx)이
// 서버에 보내고, 틀리면 한 줄(`등록 번호 불일치 · 재입력 필요` …)이 숫자판 표시 칸 아래에 뜬다. 시험 매장의 기기 선택이 번호 등록으로
// 바뀌어 온 때는 처음부터 한 줄(notice: `기기 선택 종료 · 등록 번호 필요`)이 있고, 숫자를 누르면 사라진다.
// 서버의 연결 끊김 화면(OfflineScreen)도 여기 둔다: `연결 끊김` · `마지막 연결 16:48` · `재시도`, 5초마다 저절로 다시 묻는다.
// 둘 다 체험판 미리 보기(#/preview/enroll)가 규칙 검사를 위해 그린다(보내는 일은 부르는 쪽이 정한다).
import { NumberPad, formatTime, t, useUi } from '@skinote/ui';
import { useEffect, useState } from 'react';
import { say } from '../app/strings.ts';

export interface EnrollScreenProps {
  /** 12자리를 보낸다. 실패하면 보일 한 줄, 되면 null(부르는 쪽이 다음 화면으로 간다). */
  onSubmit: (code: string) => Promise<string | null>;
  /** 처음부터 보일 한 줄(기기 선택이 번호 등록으로 바뀐 때). */
  notice?: string;
}

export function EnrollScreen({ onSubmit, notice }: EnrollScreenProps) {
  const [digits, setDigits] = useState('');
  const [note, setNote] = useState<string | null>(notice ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = say('titleEnroll'); }, []);
  const submit = (code: string) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    onSubmit(code).then((line) => {
      setBusy(false);
      if (line) {
        setNote(line);
        setDigits('');
      }
    }, () => {
      setBusy(false);
      setNote(say('sendFailed'));
    });
  };
  return (
    <div className="pos-plain">
      <main className="pos-card pos-enroll">
        <div className="pos-enroll-text">
          <h1 className="pos-card-title">{say('enrollTitle')}</h1>
          <p className="pos-card-line">{say('enrollLine')}</p>
        </div>
        <NumberPad
          mode="code"
          title={say('enrollCode')}
          value={digits}
          onChange={(value) => { setDigits(value); if (note) setNote(null); }}
          onSubmit={submit}
          placement="inline"
          accept={() => !busy}
          {...(note ? { note } : {})}
        />
      </main>
    </div>
  );
}

export interface OfflineScreenProps {
  /** 마지막으로 서버와 주고받은 때(모르면 없음). */
  lastSyncAt?: string | undefined;
  onRetry: () => void;
  /** 저절로 다시 묻는 간격(밀리초). 없으면 5초. */
  retryEveryMs?: number;
}

/** 서버 모드인데 서버에 닿지 않을 때(시작 · 로그인 전). 체험판으로 가지 않는다(D7). */
export function OfflineScreen({ lastSyncAt, onRetry, retryEveryMs = 5_000 }: OfflineScreenProps) {
  const { timezone } = useUi();
  useEffect(() => {
    document.title = say('appName');
    const timer = setInterval(onRetry, retryEveryMs);
    return () => clearInterval(timer);
  }, [onRetry, retryEveryMs]);
  return (
    <div className="pos-plain">
      <main className="pos-card" role="alert">
        <h1 className="pos-card-title">{t('offline')}</h1>
        {lastSyncAt ? <p className="pos-card-line">{t('lastSync', { time: formatTime(lastSyncAt, timezone) })}</p> : null}
        <div className="pos-card-row">
          <button type="button" className="sn-primary" data-primary="true" onClick={onRetry}>{say('retry')}</button>
        </div>
      </main>
    </div>
  );
}

// 방문 결과 판(ui 6-3 · N11): 기사가 줄을 고르고 '수거 실패'를 누르면 연다. 모두 버튼이다(장갑, 고령):
//   ① 사유: 고객 부재 · 장소 변경 · 물품 미준비
//   ② 재방문: 오늘 · 내일 · 날짜(→ 재방문 날짜: 모레부터 날짜 버튼)
//   ③ 재방문 시각: 목록의 반납 타임 시각 · 직접 입력(→ 숫자판으로 시 · 분, 숫자 칸 왼쪽에 '재방문 시각 · 직접 입력')
//   ④ 기록 확인: 한 줄 요약과 보라 주 버튼 '저장' → task.visit(오프라인이면 전송 대기).
// 창 크기는 확인 창과 같은 규칙(layout의 confirmWindow)이고 스크롤이 없다. 화면은 무엇을 옮길지 계산하지 않는다:
// 고른 이유 · 날짜 · 시각만 명령에 넣고, 약속을 옮기는 것은 서버(체험판은 FixtureClient)가 한다. 이유 목록은 읽기 모델
// (visitReasons, 매장 설정의 reason_codes)에서 온다. 시각 버튼은 날짜 · 시각을 매장 시간대의 절대 시각으로 바꿔 지금과 견준다
// (자정을 넘긴 야간 수거에서 영업일 '오늘'의 22:00은 이미 지난 시각이다).
import type { BusinessDate, CommandPayloads, ReasonCode } from '@skinote/contract';
import { confirmWindow } from '@skinote/layout';
import { Icon, PrimaryButton, TextFit, addDays, formatDateTitle, formatRelativeDay, t, useUi, zonedTimeToIso } from '@skinote/ui';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { say } from '../app/strings.ts';

/** 오늘 다시 갈 시각은 지금부터 이만큼 뒤부터 고를 수 있다. */
const RETRY_LEAD_MS = 10 * 60_000;
/** 시각 버튼은 이만큼까지(나머지는 직접 입력). */
const MAX_SLOT_BUTTONS = 3;

type Step = 'reason' | 'when' | 'date' | 'time' | 'custom' | 'review';

export interface VisitResultDialogProps {
  taskId: string;
  teamName: string;
  last4: string;
  /** 영업일(오늘). */
  today: BusinessDate;
  /** 서버 시각 차이로 고친 지금. 오늘 다시 갈 시각은 지금보다 뒤만 보인다. */
  nowMs: number;
  /** 방문 결과 이유(읽기 모델의 visitReasons). */
  reasons: readonly ReasonCode[];
  /** 고를 만한 시각(목록의 반납 타임 시각, 'HH:MM'). */
  slotTimes: readonly string[];
  onSubmit: (payload: CommandPayloads['task.visit']) => void;
  onClose: () => void;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const toMinutes = (hhmm: string) => {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

/** 그 날짜 · 시각(매장 시간대)이 지금부터 lead 뒤 이후인지: 날짜 · 시각을 절대 시각으로 바꿔 견준다. */
export function laterThanNow(date: BusinessDate, hhmm: string, nowMs: number, timezone: string, leadMs = 0): boolean {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Date.parse(zonedTimeToIso(date, Number(h), Number(m), timezone)) >= nowMs + leadMs;
}

export function VisitResultDialog({ taskId, teamName, last4, today, nowMs, reasons, slotTimes, onSubmit, onClose }: VisitResultDialogProps) {
  const { profile, viewport, timezone } = useUi();
  const titleId = useId();
  const [trail, setTrail] = useState<Step[]>(['reason']);
  const [reason, setReason] = useState<ReasonCode | null>(null);
  const [date, setDate] = useState<BusinessDate | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [digits, setDigits] = useState('');
  const step = trail.at(-1) ?? 'reason';
  const go = (next: Step) => setTrail((list) => [...list, next]);
  const back = () => setTrail((list) => (list.length > 1 ? list.slice(0, -1) : list));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 시각 버튼: 목록의 반납 타임 시각. 고른 날짜의 그 시각이 지금부터 10분 뒤 이후인 것만, 세 개까지.
  const times = useMemo(() => {
    const unique = [...new Set(slotTimes)].sort((a, b) => toMinutes(a) - toMinutes(b));
    return (date ? unique.filter((hhmm) => laterThanNow(date, hhmm, nowMs, timezone, RETRY_LEAD_MS)) : unique).slice(0, MAX_SLOT_BUTTONS);
  }, [slotTimes, date, nowMs, timezone]);
  const dayChoices = useMemo(() => [2, 3, 4, 5, 6, 7].map((n) => addDays(today, n)), [today]);

  // 오늘 · 내일 · 모레는 그 말로, 그 뒤는 요일까지('12월 29일 (화)'). 날짜로 가른다(글자를 견주지 않는다).
  const near = useMemo(() => new Set([0, 1, 2].map((n) => addDays(today, n))), [today]);
  const dayWord = (d: BusinessDate) => (near.has(d) ? formatRelativeDay(d, today) : formatDateTitle(d));
  const typed = digits.slice(0, 2) + ':' + digits.slice(2);
  const customValid = digits.length === 4 && Number(digits.slice(0, 2)) < 24 && Number(digits.slice(2)) < 60
    && date !== null && laterThanNow(date, typed, nowMs, timezone);

  const submit = () => {
    if (!reason || !date || !time) return;
    const [h = '0', m = '0'] = time.split(':');
    onSubmit({ taskId, outcomeKey: reason.key, retry: { date, at: zonedTimeToIso(date, Number(h), Number(m), timezone) } });
  };

  const size = confirmWindow(viewport, profile.confirm, 1, 0);
  const choice = (key: string, label: string, onPress: () => void, selected = false) => (
    <button key={key} type="button" className="sn-button pos-visit-choice" aria-pressed={selected} onClick={onPress}>
      <TextFit input={{ mode: 'words', text: label }} />
    </button>
  );

  let question = '';
  let body: ReactNode = null;
  switch (step) {
    case 'reason':
      question = say('visitWhat');
      body = reasons.map((r) => choice(r.key, r.label, () => { setReason(r); go('when'); }, reason?.key === r.key));
      break;
    case 'when':
      question = say('visitWhen');
      body = [
        choice('today', say('visitToday'), () => { setDate(today); setTime(null); go('time'); }, date === today),
        choice('tomorrow', t('tomorrow'), () => { setDate(addDays(today, 1)); setTime(null); go('time'); }, date === addDays(today, 1)),
        choice('date', say('visitDate'), () => go('date'), date !== null && date !== today && date !== addDays(today, 1)),
      ];
      break;
    case 'date':
      question = say('visitWhichDay');
      body = dayChoices.map((d) => choice(d, dayWord(d), () => { setDate(d); setTime(null); go('time'); }, date === d));
      break;
    case 'time':
      question = (date ? dayWord(date) + ' ' : '') + say('visitWhatTime');
      body = [
        ...times.map((hhmm) => choice(hhmm, hhmm, () => { setTime(hhmm); go('review'); }, time === hhmm)),
        choice('custom', say('visitCustom'), () => { setDigits(''); go('custom'); }),
      ];
      break;
    case 'custom': {
      const shown = (digits + '____').slice(0, 4);
      // 숫자판은 높이를 다 쓰므로 무엇을 넣는지('오늘 재방문 시각 · 직접 입력')는 숫자 칸 왼쪽에 둔다(좁으면 '직접 입력'이 빠짐).
      body = (
        <div className="pos-visit-keypad">
          <div className="pos-visit-keypad-head">
            <TextFit
              className="pos-visit-question"
              input={{ mode: 'parts', parts: [{ text: (date ? dayWord(date) + ' ' : '') + say('visitWhatTime'), drop: 0 }, { text: say('visitCustom'), drop: 1 }] }}
            />
            <output className={'sn-keypad-display' + (digits.length ? ' has-value' : '')} aria-live="polite">
              {shown.slice(0, 2).split('').join(' ') + ' : ' + shown.slice(2).split('').join(' ')}
            </output>
          </div>
          <div className="sn-keypad-keys">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button key={d} type="button" className="sn-key" onClick={() => setDigits((v) => (v.length < 4 ? v + d : v))}>{d}</button>
            ))}
            <button type="button" className="sn-key is-word" onClick={() => setDigits((v) => v.slice(0, -1))}>{t('erase')}</button>
            <button type="button" className="sn-key" onClick={() => setDigits((v) => (v.length < 4 ? v + '0' : v))}>0</button>
            <button type="button" className="sn-key is-go" disabled={!customValid} onClick={() => { setTime(pad2(Number(digits.slice(0, 2))) + ':' + digits.slice(2)); go('review'); }}>
              {t('confirm')}
            </button>
          </div>
        </div>
      );
      break;
    }
    case 'review':
      question = say('visitReview');
      body = (
        <div className="pos-visit-review">
          <p>{reason?.label ?? ''}</p>
          <p>{say('visitAgain', { when: (date ? dayWord(date) + ' ' : '') + (time ?? '') })}</p>
        </div>
      );
      break;
  }

  return (
    <div className="sn-overlay">
      <div className="sn-dialog pos-visit" role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ width: size.widthPx, maxHeight: size.heightPx }}>
        <header className="sn-dialog-head">
          <h2 id={titleId} className="sn-dialog-title"><TextFit input={{ mode: 'parts', parts: [{ text: t('notCollected'), drop: 0 }, { text: teamName, drop: 1, words: true }, { text: last4, drop: 2 }] }} /></h2>
        </header>
        <div className="sn-dialog-body">
          {question ? <p className="pos-visit-question">{question}</p> : null}
          <div className={step === 'custom' || step === 'review' ? 'pos-visit-block' : 'pos-visit-choices'}>{body}</div>
        </div>
        <footer className="sn-dialog-foot">
          <button type="button" className="sn-button" onClick={trail.length > 1 ? back : onClose}>
            <Icon name="left" />
            <span>{trail.length > 1 ? say('back') : t('close')}</span>
          </button>
          {step === 'review' ? <PrimaryButton label={say('visitSave')} onPress={submit} /> : null}
        </footer>
      </div>
    </div>
  );
}

// 숫자판(NumberPad, ui 5): 연락처 · 금액 · 시각을 넣는 3 × 4 판(키 = 등급의 숫자판 키 크기, 기사 56px 이상). 끝 4자리 찾기 숫자판
// (Keypad)과 같은 모양이고 `정정` · `입력`, 금액은 `000`도 가진다. 새 접수의 연락처 · 직접 입력 시각(V2 · V3), 확정 창 · 일괄 수납 ·
// 마감 · 기사 현장 수납의 금액(V4 · V5 · V6 · V7), 매장 설정의 값(V8)이 쓴다. 아래에서 올라오는 판(sheet) 또는 화면 안의 판(inline).
// 부품은 보이는 모양만 만든다: 번호 · 금액이 맞는지는 부르는 쪽이 서버에 묻는다. 카운터 PC의 자판(숫자 · 지움 · 들어가기 · Esc)도 받는다.
// 서버 연결(계획 work/impl-server/plan.md 6-3)의 두 모드: 기기 등록 번호(code, 12자리를 넷씩 끊어 '1234-5678-9012')와 직원
// 비밀번호(pin, 4 ~ 6자리를 가려 '● ● ● ●'로만 보인다). 비밀번호는 표시 칸 · 읽는 이름 어디에도 숫자로 나오지 않는다.
import { useEffect, useId } from 'react';
import { formatEnrollDigits, formatPhone, formatPinMask, formatTimeDigits, formatWon } from '../format.ts';
import { t } from '../strings.ko-KR.ts';
import { TextFit } from './TextFit.tsx';

export type NumberPadMode = 'phone' | 'amount' | 'time' | 'code' | 'pin';

export interface NumberPadProps {
  mode: NumberPadMode;
  /** 판 제목('연락처', '수령 시각'). */
  title: string;
  /** 지금 친 숫자(숫자만). */
  value: string;
  onChange: (value: string) => void;
  /** `입력`: 친 숫자를 넘긴다. */
  onSubmit: (value: string) => void;
  /** 아래 판의 `닫기`(inline에는 없음). */
  onClose?: () => void;
  /** 표시 칸 아래 한 줄('차액 0원' 같은 부르는 쪽의 글). */
  note?: string;
  placement?: 'sheet' | 'inline';
  /**
   * 숫자 키만(제목 · 표시 칸 · `입력` 없이, inline). 부르는 쪽이 친 값을 바로 쓰고 따로 크게 보이는 판(기사 현장 수납 판: 금액은 왼쪽 칸,
   * 확정은 판의 주 버튼)이 쓴다. 판의 읽는 이름은 title이다. 자판의 들어가기는 그대로 onSubmit이다.
   */
  keysOnly?: boolean;
  /**
   * 받는 값인지(부르는 쪽이 읽기 모델의 범위로 정함: 영업일 기준 시각 00:00 ~ 11:59, 금액 0원 아님). 아니면 `입력`이 눌리지 않는다.
   * 없으면 모드의 기본(시각은 네 자리).
   */
  accept?: (digits: string) => boolean;
}

/**
 * 모드마다 칠 수 있는 숫자 수(휴대폰 11, 시각 HHMM 4, 금액 9자리 = 999,999,999원, 등록 번호 12, 비밀번호 6).
 * 등록 번호 · 비밀번호의 자리 수는 계약(@skinote/contract의 ENROLL_CODE_DIGITS · PIN_MAX_DIGITS)과 같다(시험이 맞춰 본다).
 */
export const NUMBER_PAD_DIGITS: Readonly<Record<NumberPadMode, number>> = { phone: 11, amount: 9, time: 4, code: 12, pin: 6 };

/** 비밀번호의 가장 짧은 자리 수(계약의 PIN_MIN_DIGITS). */
export const NUMBER_PAD_PIN_MIN = 4;

/** 표시 칸의 글: 연락처 '010-0000-0042', 시각 '17:2_', 금액 '160,000원'(빈 금액은 비움), 등록 번호 '1234-5678-90', 비밀번호 '● ● ●'. */
export function numberPadText(mode: NumberPadMode, digits: string): string {
  if (mode === 'phone') return formatPhone(digits);
  if (mode === 'time') return formatTimeDigits(digits);
  if (mode === 'code') return formatEnrollDigits(digits);
  if (mode === 'pin') return formatPinMask(digits.length);
  return digits ? formatWon(Number(digits)) : '';
}

/**
 * `입력`을 누를 수 있는지: 시각은 네 자리, 등록 번호는 열두 자리, 비밀번호는 네 자리 이상일 때만(그 밖은 빈 값도 넘긴다 — 빈
 * 연락처는 지움).
 */
export function numberPadReady(mode: NumberPadMode, digits: string): boolean {
  if (mode === 'time' || mode === 'code') return digits.length === NUMBER_PAD_DIGITS[mode];
  if (mode === 'pin') return digits.length >= NUMBER_PAD_PIN_MIN && digits.length <= NUMBER_PAD_DIGITS.pin;
  return true;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** 글자를 치는 칸(입력 칸 · 글 상자 · 편집 칸)에서 온 자판 누름인지. */
/** 글자 입력 칸(입력 · 글상자 · 고르기 · 편집 가능한 요소)에서 친 키인지: 숫자판은 그 키를 가져가지 않는다. */
export const typingIn = (target: EventTarget | null) =>
  typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export function NumberPad({ mode, title, value, onChange, onSubmit, onClose, note, placement = 'sheet', keysOnly = false, accept }: NumberPadProps) {
  const titleId = useId();
  const digits = value.replace(/\D/g, '').slice(0, NUMBER_PAD_DIGITS[mode]);
  const press = (d: string) => onChange((digits + d).slice(0, NUMBER_PAD_DIGITS[mode]));
  const erase = () => onChange(digits.slice(0, -1));
  const ready = numberPadReady(mode, digits) && (accept ? accept(digits) : true);
  const submit = () => { if (ready) onSubmit(digits); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 위에 뜬 글자 입력 판(직접 입력 사유 · 대표자 이름)에서 치는 글자는 이 판의 숫자가 아니다.
      if (typingIn(event.target)) return;
      if (/^\d$/.test(event.key)) press(event.key);
      else if (event.key === 'Backspace') erase();
      else if (event.key === 'Enter') submit();
      else if (event.key === 'Escape' && onClose) onClose();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const text = numberPadText(mode, digits);
  const go = <button type="button" className={'sn-key is-go' + (mode === 'amount' ? ' is-wide' : '')} disabled={!ready} onClick={submit}>{t('enter')}</button>;
  const pad = (
    <section
      className={'sn-keypad sn-numpad is-' + placement + (keysOnly ? ' is-keys' : '')}
      {...(keysOnly ? { 'aria-label': title } : { 'aria-labelledby': titleId })}
    >
      {keysOnly ? null : (
        <>
          <h2 id={titleId} className="sn-keypad-title">{title}</h2>
          <output
            className={'sn-keypad-display sn-numpad-display' + (digits.length ? ' has-value' : '') + (mode === 'pin' ? ' is-masked' : '')}
            aria-live="polite"
            data-mode={mode}
          >{text}</output>
          {note ? <p className="sn-keypad-note" role="status"><TextFit input={{ mode: 'words', text: note }} lines={2} /></p> : null}
        </>
      )}
      <div className="sn-keypad-keys">
        {DIGITS.map((d) => (
          <button key={d} type="button" className="sn-key" onClick={() => press(d)}>{d}</button>
        ))}
        {mode === 'amount' ? (
          <>
            <button type="button" className="sn-key" onClick={() => press('000')}>000</button>
            <button type="button" className="sn-key" onClick={() => press('0')}>0</button>
            <button type="button" className="sn-key is-word" onClick={erase}>{t('erase')}</button>
            {keysOnly ? null : go}
          </>
        ) : (
          <>
            <button type="button" className="sn-key is-word" onClick={erase}>{t('erase')}</button>
            <button type="button" className="sn-key" onClick={() => press('0')}>0</button>
            {go}
          </>
        )}
      </div>
      {placement === 'sheet' && onClose ? (
        <button type="button" className="sn-button sn-keypad-close" onClick={onClose}>{t('close')}</button>
      ) : null}
    </section>
  );
  if (placement === 'inline') return pad;
  return <div className="sn-sheet-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>{pad}</div>;
}

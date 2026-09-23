// 끝 4자리 숫자판(ui 5 Keypad, 6-3). 3×4 숫자판, 키는 등급의 숫자판 키 크기(기사 56px 이상).
// 높이 600px 이상 태블릿은 오른쪽 판, 1024×520과 휴대폰은 아래에서 올라오는 판(layout의 keypadPlacement).
// 손님이 다가오면 끝 4자리 → 그 줄로 이동 · 강조(찾기 결과는 부르는 쪽이 정한다).
import { keypadPlacement } from '@skinote/layout';
import { useId } from 'react';
import { useUi } from '../context.tsx';
import { t } from '../strings.ko-KR.ts';
import { TextFit } from './TextFit.tsx';

export interface KeypadProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (last4: string) => void;
  /** 아래 판일 때 열렸는지. 옆 판은 늘 보인다. */
  open?: boolean;
  onClose?: () => void;
  /** 판 아래 '차에 있는 것'(기사): 이름 한 줄 + 품목 한 줄(넘치면 '외 N종'). 글 하나만 주면 그대로. */
  loadSummary?: string | { label: string; items: readonly string[] };
  /** 찾기 결과 한 문장('0099로 찾은 팀이 없습니다'). 표시 칸 아래에 보인다. */
  note?: string;
  /** 자리를 고정할 때(시험). 없으면 등급 · 잰 높이로 고른다. */
  placement?: 'side' | 'sheet';
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** 지금 크기와 등급에서 숫자판 자리. */
export function useKeypadPlacement(): 'side' | 'sheet' {
  const { profile, viewport } = useUi();
  return keypadPlacement(viewport.height, profile.keypad.sidePanelMinHeightPx, profile.keypad.allowSide);
}

export function Keypad({ value, onChange, onSubmit, open = true, onClose, loadSummary, note, placement }: KeypadProps) {
  const auto = useKeypadPlacement();
  const where = placement ?? auto;
  const titleId = useId();
  if (where === 'sheet' && !open) return null;
  const digits = value.replace(/\D/g, '').slice(0, 4);
  const press = (d: string) => { if (digits.length < 4) onChange(digits + d); };
  const display = Array.from({ length: 4 }, (_, i) => digits[i] ?? '_').join(' ');
  const pad = (
    <section className={'sn-keypad is-' + where} aria-labelledby={titleId}>
      <h2 id={titleId} className="sn-keypad-title">{t('findTitle')}</h2>
      <output className={'sn-keypad-display' + (digits.length ? ' has-value' : '')} aria-live="polite">{display}</output>
      {note ? <p className="sn-keypad-note" role="status"><TextFit input={{ mode: 'words', text: note }} lines={2} /></p> : null}
      <div className="sn-keypad-keys">
        {DIGITS.map((d) => (
          <button key={d} type="button" className="sn-key" onClick={() => press(d)}>{d}</button>
        ))}
        <button type="button" className="sn-key is-word" onClick={() => onChange(digits.slice(0, -1))}>{t('erase')}</button>
        <button type="button" className="sn-key" onClick={() => press('0')}>0</button>
        <button type="button" className="sn-key is-go" disabled={digits.length !== 4} onClick={() => onSubmit(digits)}>{t('search')}</button>
      </div>
      {typeof loadSummary === 'string' ? <p className="sn-keypad-load"><TextFit input={{ mode: 'words', text: loadSummary }} /></p> : null}
      {loadSummary && typeof loadSummary === 'object' ? (
        <p className="sn-keypad-load is-items">
          <b>{loadSummary.label}</b>
          <TextFit input={{ mode: 'items', items: loadSummary.items }} />
        </p>
      ) : null}
      {where === 'sheet' && onClose ? (
        <button type="button" className="sn-button sn-keypad-close" onClick={onClose}>{t('close')}</button>
      ) : null}
    </section>
  );
  if (where === 'side') return pad;
  return <div className="sn-sheet-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>{pad}</div>;
}

// 한 문장 알림 창과 고르기 판. 확인 창(ConfirmDialog)과 같은 모양이지만 명령을 보내지 않는다.
// 주 버튼은 있어도 하나(PrimaryButton), 나머지는 보통 버튼이다. 글자는 쉬운 가게 말로 한두 문장.
// 고르기 판(더 보기 · 여러 팀 · 빨리 확인 목록)은 창 높이(confirmWindow)로 한 쪽에 들어가는 버튼 수를 세고, 넘치면 쪽을 넘긴다.
import type { DeviceProfile } from '@skinote/ui';
import { confirmWindow } from '@skinote/layout';
import { Icon, Pager, PrimaryButton, TextFit, t, useUi } from '@skinote/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface NoticeAction {
  label: string;
  onPress: () => void;
  /** 이 창의 주 버튼(하나만). */
  primary?: boolean;
}

export interface NoticeDialogProps {
  title: string;
  lines: string[];
  actions?: NoticeAction[];
  onClose: () => void;
  /** 닫기 버튼 이름(기본 '닫기'). */
  closeLabel?: string;
  children?: ReactNode;
}

/** 알림 창의 폭: 확인 창의 여백 규칙(등급 값) 안에서 넓지 않게. */
function useDialogWidth(max: number): number {
  const { profile, viewport } = useUi();
  return Math.min(viewport.width - 2 * profile.confirm.sideMarginPx, max);
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

export function NoticeDialog({ title, lines, actions = [], onClose, closeLabel, children }: NoticeDialogProps) {
  const { profile } = useUi();
  const titleId = useId();
  const width = useDialogWidth(profile.confirm.maxWidthPx * 0.75);
  const footRef = useRef<HTMLElement>(null);
  useEscape(onClose);
  useEffect(() => { footRef.current?.querySelector<HTMLButtonElement>('button:last-child')?.focus(); }, []);
  return (
    <div className="sn-overlay">
      <div className="sn-dialog pos-notice" role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ width }}>
        <header className="sn-dialog-head">
          <h2 id={titleId} className="sn-dialog-title"><TextFit input={{ mode: 'words', text: title }} /></h2>
        </header>
        <div className="sn-dialog-body">
          {lines.map((line, i) => <p key={i} className="sn-dialog-line">{line}</p>)}
          {children}
        </div>
        <footer ref={footRef} className="sn-dialog-foot">
          <button type="button" className="sn-button" onClick={onClose}>
            <Icon name="left" />
            <span>{closeLabel ?? t('close')}</span>
          </button>
          {actions.length ? (
            <div className="pos-notice-actions">
              {actions.map((action) => action.primary
                ? <PrimaryButton key={action.label} label={action.label} onPress={action.onPress} />
                : <button key={action.label} type="button" className="sn-button" onClick={action.onPress}>{action.label}</button>)}
            </div>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

export interface Choice {
  key: string;
  label: string;
  /** 이름 아래 작은 줄(약속 · 끝 4자리). */
  note?: string;
  icon?: 'phone' | 'exit';
}

export interface ChoiceSheetProps {
  title: string;
  choices: Choice[];
  onPick: (key: string) => void;
  onClose: () => void;
}

/** 고르기 판의 한 줄에 놓는 버튼 수(app.css의 .pos-choices 칸 수와 같다). */
const CHOICE_COLUMNS = 2;

/**
 * 한 쪽에 들어가는 고르기 버튼 수: 창 높이 − 제목 − 바닥 − 본문 위아래 여백(− 쪽 넘김이 본문에 들 때는 없음: 바닥에 있다)을
 * 버튼 높이(주 버튼 높이) + 사이로 나눈 줄 수 × 칸 수.
 */
export function choicesPerPage(profile: DeviceProfile, heightPx: number): number {
  const body = heightPx - profile.confirm.titlePx - profile.confirm.primaryRowPx - 2 * profile.space.m;
  const rows = Math.max(1, Math.floor((body + profile.space.s) / (profile.primaryButtonPx + profile.space.s)));
  return rows * CHOICE_COLUMNS;
}

/** 더 보기 · 여러 팀 중 고르기. 버튼은 두 칸씩, 모두 등급의 누르는 곳 크기 이상. 넘치면 쪽 넘김(스크롤 없음). */
export function ChoiceSheet({ title, choices, onPick, onClose }: ChoiceSheetProps) {
  const { profile, viewport } = useUi();
  const titleId = useId();
  const width = useDialogWidth(profile.confirm.maxWidthPx * 0.75);
  const box = confirmWindow(viewport, profile.confirm, 1, 0);
  const perPage = choicesPerPage(profile, box.heightPx);
  const pageCount = Math.max(1, Math.ceil(choices.length / perPage));
  const [page, setPage] = useState(0);
  const current = Math.min(page, pageCount - 1);
  const shown = choices.slice(current * perPage, (current + 1) * perPage);
  useEscape(onClose);
  return (
    <div className="sn-overlay">
      <div className="sn-dialog pos-notice" role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ width, maxHeight: box.heightPx }}>
        <header className="sn-dialog-head">
          <h2 id={titleId} className="sn-dialog-title"><TextFit input={{ mode: 'words', text: title }} /></h2>
        </header>
        <div className="sn-dialog-body pos-choices">
          {shown.map((choice) => (
            <button key={choice.key} type="button" className="sn-button pos-choice-button" onClick={() => onPick(choice.key)}>
              {choice.icon ? <Icon name={choice.icon} /> : null}
              <span className="pos-choice-text">
                <TextFit input={{ mode: 'words', text: choice.label }} />
                {choice.note ? <TextFit className="pos-choice-note" input={{ mode: 'words', text: choice.note }} /> : null}
              </span>
            </button>
          ))}
        </div>
        <footer className="sn-dialog-foot">
          <button type="button" className="sn-button" onClick={onClose}>
            <Icon name="left" />
            <span>{t('close')}</span>
          </button>
          {pageCount > 1 ? <Pager page={current} pageCount={pageCount} onChange={setPage} /> : null}
        </footer>
      </div>
    </div>
  );
}

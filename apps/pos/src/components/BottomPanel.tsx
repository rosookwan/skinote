// 아래에서 올라오는 판(ui 5 · 6-5 · 6-8): 제목줄 · 본문 · 바닥줄(`닫기` · 보통 버튼 · 주 버튼 하나). 기사 업무 판(V7)의 현장 수납 ·
// 리프트권 추가 판과 하루 마감(V6)의 점검 판이 쓴다. 폭은 확인 창 규칙(confirmWindow), 높이는 판 한도(DeviceProfile fill.panelMaxPx,
// CSS --sn-panel-max)까지이고 스크롤은 없다. 주 버튼이 가로 전체인 등급(기사 휴대폰)은 전체 화면 판이다.
import { confirmWindow } from '@skinote/layout';
import { Icon, TextFit, t, useUi } from '@skinote/ui';
import { useEffect, useId, type ReactNode } from 'react';

export interface BottomPanelProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 바닥줄 가운데(`후불 처리` 같은 보통 버튼). */
  extra?: ReactNode;
  primary?: ReactNode;
  requestId?: string;
  className?: string;
}

export function BottomPanel({ title, onClose, children, extra, primary, requestId, className }: BottomPanelProps) {
  const { profile, viewport } = useUi();
  const titleId = useId();
  const full = profile.primaryFullWidth;
  const width = full ? viewport.width : confirmWindow(viewport, profile.confirm, 1, 0).widthPx;
  useEffect(() => {
    // 위에 뜬 글자 입력 판의 Esc는 그 판만 닫는다.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement)) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sn-sheet-overlay pos-panel-overlay">
      <section
        className={['pos-panel', full ? 'is-full' : '', className ?? ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-request-id={requestId}
        style={{ width }}
      >
        <header className="sn-dialog-head">
          <h2 id={titleId} className="sn-dialog-title"><TextFit input={{ mode: 'words', text: title }} /></h2>
        </header>
        <div className="pos-panel-body">{children}</div>
        <footer className="sn-dialog-foot">
          <button type="button" className="sn-button" onClick={onClose}>
            <Icon name="left" />
            <span>{t('close')}</span>
          </button>
          {extra}
          <div className="sn-dialog-primary">{primary}</div>
        </footer>
      </section>
    </div>
  );
}

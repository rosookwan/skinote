// 틀이 따로인 확인 창(DialogFrame): 일정 변경(V9) · 반납(V1) · 접수 확정(V4) 창의 껍데기. 제목줄 · 본문 · 바닥줄(`닫기` · 쪽 넘김 · 주 버튼
// 하나). 폭 · 최대 높이는 잰 화면으로 정한다(layout의 confirmWindow, ui 4-5: 1024×529에서 505). 창 높이는 흔들리지 않는다(spec 2-1 다):
// 본문이 자리를 남겨 가장 긴 상태의 높이로 열고, 그래도 연 동안 본 가장 큰 높이 아래로는 줄지 않는다(누를 때마다 줄이 움직이지 않게).
// 스크롤은 없다. 요청번호는 창을 연 쪽이 만들어 붙인다(data-request-id).
import { confirmWindow } from '@skinote/layout';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useUi } from '../context.tsx';
import { Icon } from '../icons.tsx';
import { useIsoLayoutEffect } from '../measure.ts';
import { t } from '../strings.ko-KR.ts';
import { TextFit } from './TextFit.tsx';

export interface DialogFrameProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 바닥줄 가운데(쪽 넘김 '‹ 1 / 2쪽 ›'). */
  pager?: ReactNode;
  /** 바닥줄 오른쪽의 주 버튼(PrimaryButton 하나). */
  primary?: ReactNode;
  requestId?: string;
  className?: string;
}

export function DialogFrame({ title, onClose, children, pager, primary, requestId, className }: DialogFrameProps) {
  const { profile, viewport } = useUi();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLDivElement>(null);
  const size = confirmWindow(viewport, profile.confirm, 1, 0);
  // 연 동안 본 가장 큰 높이(화면 크기가 바뀌면 다시 잰다).
  const [floor, setFloor] = useState({ key: viewport.width + 'x' + viewport.height, px: 0 });
  const floorPx = floor.key === viewport.width + 'x' + viewport.height ? floor.px : 0;
  useIsoLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    const key = viewport.width + 'x' + viewport.height;
    if (h > floorPx) setFloor({ key, px: Math.min(h, size.heightPx) });
  });
  useEffect(() => {
    primaryRef.current?.querySelector('button')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sn-overlay">
      <div
        ref={ref}
        className={['sn-dialog', 'sn-dialog-frame', className ?? ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-request-id={requestId}
        style={{ width: size.widthPx, maxHeight: size.heightPx, ...(floorPx > 0 ? { minHeight: floorPx } : {}) }}
      >
        <header className="sn-dialog-head">
          <h2 id={titleId} className="sn-dialog-title"><TextFit input={{ mode: 'words', text: title }} /></h2>
        </header>
        <div className="sn-dialog-body">{children}</div>
        <footer className="sn-dialog-foot">
          <button type="button" className="sn-button" onClick={onClose}>
            <Icon name="left" />
            <span>{t('close')}</span>
          </button>
          {pager ? <div className="sn-dialog-pager">{pager}</div> : null}
          <div ref={primaryRef} className="sn-dialog-primary">{primary}</div>
        </footer>
      </div>
    </div>
  );
}

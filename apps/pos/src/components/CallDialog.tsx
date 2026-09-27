// 전화 창(features-1 §8-4, E17): 접수증 · 카운터 수거 목록 · 기사 목록 · 업무 판의 `전화`가 모두 이 창이다. 제목 `전화 · 최하은 팀`, 번호를 크게.
// 온전한 번호는 조회(phoneReveal)로만 받는다: 서버가 볼 때마다 개인정보 열람 기록(pii_access_log phone_reveal)을 남기고, 기사는 자기 차량 업무의
// 접수만 본다. 거는 것은 기기 능력(runtime canDial): 기사 휴대폰 · 태블릿은 주 버튼 `전화 · 010-0000-0026`(`tel:` 링크), 카운터 PC는 번호와 `닫기`만.
// 체험판은 가짜 번호로 걸지 않는다: 주 버튼이 막히고 한 줄 `체험판 · 전화 연결 없음`.
import { ACTION_LABELS, type PhoneRevealView } from '@skinote/contract';
import { Icon, PrimaryButton, TextFit, t, useUi } from '@skinote/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useClient } from '../app/client.tsx';
import { canDial, telHref } from '../app/runtime.ts';
import { useSession } from '../app/session-context.ts';
import { say } from '../app/strings.ts';

export interface CallDialogProps {
  orderId: string;
  /** 번호를 읽기 전 · 읽지 못했을 때의 제목(`전화 · 최하은 팀`). */
  fallbackTitle: string;
  onClose: () => void;
}

export function CallDialog({ orderId, fallbackTitle, onClose }: CallDialogProps) {
  const client = useClient();
  const session = useSession();
  const { profile, viewport } = useUi();
  const titleId = useId();
  const footRef = useRef<HTMLElement>(null);
  const [view, setView] = useState<PhoneRevealView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    client.query('phoneReveal', { orderId }).then((next) => { if (alive) setView(next); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [client, orderId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!view && !failed) return null;
  const number = view?.number ?? '';
  const dial = canDial(profile.key) && number !== '';
  const demo = session === null;
  const href = telHref(number);
  const lines = failed ? [say('openFailed')] : number ? (dial && demo ? [say('demoNoCall')] : []) : [say('noPhone')];
  // 주 버튼 `전화 · 010-0000-0026`(동작 이름 + 번호, 좁으면 `전화`).
  const label = ACTION_LABELS.call + ' · ' + number;
  const width = Math.min(viewport.width - 2 * profile.confirm.sideMarginPx, profile.confirm.maxWidthPx * 0.75);
  return (
    <div className="sn-overlay">
      <div className="sn-dialog pos-notice pos-call" role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ width }}>
        <header className="sn-dialog-head">
          <h2 id={titleId} className="sn-dialog-title"><TextFit input={{ mode: 'words', text: view?.title ?? fallbackTitle }} /></h2>
        </header>
        <div className="sn-dialog-body">
          {number ? <p className="pos-call-number">{number}</p> : null}
          {lines.map((line, i) => <p key={i} className="sn-dialog-line">{line}</p>)}
        </div>
        <footer ref={footRef} className="sn-dialog-foot">
          <button type="button" className="sn-button" onClick={onClose}>
            <Icon name="left" />
            <span>{t('close')}</span>
          </button>
          {dial ? (
            <div className="pos-notice-actions">
              {demo || !href ? (
                <PrimaryButton label={label} alts={[label, ACTION_LABELS.call]} disabled onPress={() => undefined} />
              ) : (
                <a className="sn-primary pos-call-link" data-primary="true" href={href}>
                  <TextFit input={{ mode: 'alts', alts: [label, ACTION_LABELS.call] }} />
                </a>
              )}
            </div>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

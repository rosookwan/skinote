// 하루 마감(V6, spec 3-7)의 점검 판: `차량 현금 점검 · 35,000원` · `돈통 점검` · `재점검`을 누르면 아래에서 올라오는 판(높이 ≤ 판 한도,
// ui 6-8). 왼쪽 칸은 예상 · 실제(친 금액) · 차액 한 줄 · 차액 사유(`잔돈 착오` · `원인 불명` · `직접 입력 ›`), 오른쪽은 금액 숫자 키(3 × 4,
// `000` · `정정`). 판의 주 버튼(`차량 현금 점검 · 35,000원` · `돈통 점검 · 545,000원`)이 확정한다: 차량 현금은 인계 확인 명령
// (cash.transfer_confirm, 판을 연 때의 요청번호)을 보내고, 돈통은 셈을 화면 초안에 넣는다(마감 명령이 싣는다, plan §8 D3). 차액이 0이
// 아니면 사유를 고른 뒤에 누를 수 있다. 사유 줄은 차액이 0이면 자리만 남는다(판 높이가 흔들리지 않게).
// 화면은 계산하지 않는다: 친 금액 · 사유를 인자로 closingSheet를 다시 묻고 차액 · 주 버튼 · 보낼 것을 받는다.
import { envelopeFor, type Basis, type ClosingCount, type ClosingSheetParams, type ClosingSheetView, type ConfirmCommand } from '@skinote/contract';
import { ChoiceRow, NumberPad, PrimaryButton, RichLine, formatWon, t, useCommandDraft } from '@skinote/ui';
import { useEffect, useState } from 'react';
import { checkParams, type ClosingReason } from '../app/closing-draft.ts';
import { useClient } from '../app/client.tsx';
import { say } from '../app/strings.ts';
import { BottomPanel } from './BottomPanel.tsx';
import { TextSheet } from './TextSheet.tsx';

const NO_BASIS: Basis = { epoch: '', rev: 0 };
const CHECK_SHAPE: ConfirmCommand = { type: 'cash.transfer_confirm', payload: { transferId: '', countedAmount: 0 } };
/** 직접 입력한 사유의 글 길이 한도(체험 값). */
const NOTE_MAX = 40;

export interface CashCheckPanelProps {
  /** 화면 초안(센 돈통 · 이월한 봉투): 판은 여기에 그 줄 · 친 금액 · 사유를 더해 묻는다. */
  base: ClosingSheetParams;
  /** 점검할 줄(차량 현금 인계 id · `van:v1` · `counter`). */
  rowKey: string;
  onClose: () => void;
  /** 돈통 셈이 끝났다(화면 초안에 넣는다). */
  onCount: (count: ClosingCount) => void;
  /** 차량 현금 점검이 적혔다(또는 이미 적혀 있었다). */
  onChecked: () => void;
}

export function CashCheckPanel({ base, rowKey, onClose, onCount, onChecked }: CashCheckPanelProps) {
  const client = useClient();
  const [digits, setDigits] = useState('');
  const [reason, setReason] = useState<ClosingReason>({});
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const params = checkParams(base, rowKey, digits, reason);
  const paramsKey = JSON.stringify(params);
  const [view, setView] = useState<ClosingSheetView | null>(null);
  const [answered, setAnswered] = useState('');
  useEffect(() => {
    let alive = true;
    client.query('closingSheet', params).then((next) => { if (alive) { setView(next); setAnswered(paramsKey); } }, () => { if (alive) setError(say('openFailed')); });
    return () => { alive = false; };
  }, [client, paramsKey]);
  const check = view?.check;
  // 차량 현금 점검의 요청번호: 판을 연 때(시도마다) 하나. 금액 · 사유를 바꿔도 같은 번호이고 보낼 때 본문 · 바탕만 지금 것이다.
  const draftKey = check?.kind === 'van' ? 'cashcheck:' + rowKey + ':' + attempt : null;
  const { draft, markSent } = useCommandDraft(draftKey, draftKey ? CHECK_SHAPE : null, view?.basis ?? NO_BASIS);
  // 금액 · 사유를 바꾼 뒤 새 답이 오기 전에는 누르지 않는다(보낼 것이 화면과 같게).
  const fresh = view !== null && answered === paramsKey;
  const ready = check !== undefined && check.primary.enabled && fresh && !busy && (check.kind === 'drawer' ? check.count !== undefined : draft !== null && check.command !== undefined);

  const confirm = () => {
    if (!ready || !check) return;
    if (check.kind === 'drawer') { if (check.count) onCount(check.count); return; }
    const envelope = draft ? envelopeFor(draft, check.command, check.expect) : null;
    if (!envelope) return;
    setBusy(true);
    markSent();
    client.command(envelope).then((outcome) => {
      setBusy(false);
      // 적혔다 · 이미 적혀 있었다(다른 카운터 · 이야기): 판을 닫는다.
      if (outcome.outcome === 'applied' || outcome.outcome === 'superseded') { onChecked(); return; }
      setAttempt((n) => n + 1);
      setError(outcome.error?.message ?? say('commandFailed'));
    }, () => { setBusy(false); setError(say('sendFailed')); });
  };
  const type = (value: string) => { setDigits(value); setError(null); };
  const pick = (key: string) => {
    setError(null);
    if (check?.reasons.find((r) => r.key === key)?.opens) setNoteOpen(true);
    else setReason({ reasonKey: key });
  };
  const manual = check?.reasons.find((r) => r.opens);

  return (
    <>
      <BottomPanel
        title={check?.title ?? ''}
        onClose={onClose}
        className="pos-cash-check"
        {...(draft ? { requestId: draft.requestId } : {})}
        primary={check ? (
          <PrimaryButton
            label={busy ? t('processing') : check.primary.label}
            {...(busy ? {} : { alts: check.primary.alts })}
            disabled={!ready}
            busy={busy}
            onPress={confirm}
          />
        ) : null}
      >
        {check ? (
          <div className="pos-field-pay-grid">
            <div className="pos-field-pay-side">
              <div className="pos-cash-check-line"><RichLine runs={check.expected} /></div>
              <div className="pos-field-pay-amount" role="group" aria-label={say('actual')}>
                <span className="pos-field-pay-label">{say('actual')}</span>
                <output className={'sn-keypad-display' + (digits ? ' has-value' : '')} aria-live="polite">{digits ? formatWon(Number(digits)) : ''}</output>
              </div>
              {/* 차액 한 줄의 자리: 보내지 못했으면 그 한 줄(판 높이는 그대로). */}
              <div className={'pos-cash-check-line' + (error ? ' is-alert' : '')} role="status">
                {error ? <span className="sn-fit">{error}</span> : check.diff.length ? <RichLine runs={check.diff} /> : null}
              </div>
              <div className={'pos-cash-check-reasons' + (check.reasonsShown ? '' : ' is-hidden')} aria-hidden={check.reasonsShown ? undefined : true}>
                <ChoiceRow options={check.reasons} label={say('diffReason')} onPress={pick} />
              </div>
            </div>
            <NumberPad mode="amount" title={say('actual')} value={digits} onChange={type} onSubmit={() => confirm()} placement="inline" keysOnly />
          </div>
        ) : error ? <p className="pos-dialog-error" role="alert">{error}</p> : null}
      </BottomPanel>
      {noteOpen && manual ? (
        <TextSheet
          title={manual.label}
          value={reason.reasonKey === manual.key ? reason.reasonNote ?? '' : ''}
          placeholder={say('diffReason')}
          maxLength={NOTE_MAX}
          onSubmit={(text) => { setNoteOpen(false); if (text) setReason({ reasonKey: manual.key, reasonNote: text }); }}
          onClose={() => setNoteOpen(false)}
        />
      ) : null}
    </>
  );
}

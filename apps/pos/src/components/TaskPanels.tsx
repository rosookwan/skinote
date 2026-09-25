// 기사 업무 판(V7)의 아래에서 올라오는 판(ui 6-5): 현장 수납(field.collect)과 리프트권 추가(field.add_ticket). 태블릿은 높이 ≤ 440
// (DeviceProfile fill.panelMaxPx)의 아래 판, 휴대폰은 전체 화면 판(숫자판 3 × 4 · 56px). 스크롤은 없다.
// 화면은 계산하지 않는다: 고른 수단 · 넣은 금액 · 권종 · 매수를 인자로 fieldPaySheet · addTicketSheet를 다시 묻고, 줄 글 · 주 버튼 · 명령을
// 받는다. 요청번호는 판을 연 때 하나(useCommandDraft), 보낼 때는 서버가 지금 고른 것으로 써 준 명령과 바탕(expect)을 싣는다.
// 리프트권 추가가 되면 곧바로 현장 수납 판을 연다: 그 수납은 권 추가 명령을 dependsOn으로 가진다(spec 3-8, 오프라인이면 둘 다 보냄 대기).
import {
  envelopeFor, isAccepted, type AddTicketSheetParams, type AddTicketSheetView, type AnyCommandEnvelope, type Basis,
  type ConfirmCommand, type FieldPaySheetParams, type FieldPaySheetView,
} from '@skinote/contract';
import {
  ChoiceRow, NumberPad, PrimaryButton, QtyStepper, RichLine, formatWon, t, useCommandDraft, useDeviceProfile,
} from '@skinote/ui';
import { useEffect, useState } from 'react';
import { useClient } from '../app/client.tsx';
import { say } from '../app/strings.ts';
import { BottomPanel } from './BottomPanel.tsx';

const NO_BASIS: Basis = { epoch: '', rev: 0 };

/** 현장 수납 판의 인자: 넣은 숫자(금액) · 고른 수단. 빈 숫자는 0원. */
export function withAmount(params: FieldPaySheetParams, digits: string): FieldPaySheetParams {
  return { ...params, amount: Number(digits.replace(/\D/g, '') || '0') };
}

// ── 현장 수납 ─────────────────────────────────────────────────────────

const PAY_SHAPE: ConfirmCommand = { type: 'field.collect', payload: { taskId: '', orderId: '', amount: 0, methodKey: 'cash' } };
const PROMISE_SHAPE: ConfirmCommand = { type: 'payment_promise.set', payload: { orderId: '', payerOrderId: null } };

export interface FieldPayPanelProps {
  taskId: string;
  /** 리프트권 추가에 이어 열었으면 그 명령의 요청번호(이 수납이 dependsOn으로 가진다). */
  dependsOn?: string;
  onClose: () => void;
  /** 수납 · 후불 처리가 끝났다(판을 닫는다). */
  onDone: () => void;
}

/**
 * 현장 수납 판: 받을 금액(미수) 한 줄과 `후불 처리`, 금액(숫자판으로), 빠른 수단(기사 허용 ≤ 3), 주 버튼 `현장 수납 · 현금 35,000원`.
 * 미수가 없으면 금액을 직접 넣는 판(0원부터). 태블릿은 왼쪽 칸(금액 · 수단) + 오른쪽 숫자 키, 휴대폰은 한 칸 세로.
 */
export function FieldPayPanel({ taskId, dependsOn, onClose, onDone }: FieldPayPanelProps) {
  const client = useClient();
  const profile = useDeviceProfile();
  // 권 추가에 이어 열었으면 그 요청번호(afterTicket): 받을 금액 줄이 권 값 + 방금 받은 보증금을 합한 손에 받을 돈을 적는다.
  const [params, setParams] = useState<FieldPaySheetParams>(() => ({ taskId, ...(dependsOn ? { afterTicket: dependsOn } : {}) }));
  const [view, setView] = useState<FieldPaySheetView | null>(null);
  const [digits, setDigits] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const paramsKey = JSON.stringify(params);
  const [answered, setAnswered] = useState('');
  useEffect(() => {
    let alive = true;
    client.query('fieldPaySheet', params).then((next) => {
      if (!alive) return;
      setView(next);
      setAnswered(paramsKey);
      // 처음 연 때의 금액은 미수(없으면 빈 칸).
      setDigits((prev) => prev ?? (next.amount.value > 0 ? String(next.amount.value) : ''));
    }, () => { if (alive) setError(say('openFailed')); });
    return () => { alive = false; };
  }, [client, paramsKey]);
  const key = view ? 'fieldpay:' + taskId + ':' + attempt : null;
  const { draft, markSent } = useCommandDraft(key, key ? PAY_SHAPE : null, view?.basis ?? NO_BASIS, dependsOn ? { dependsOn: [dependsOn] } : {});
  const unpaidKey = view?.leaveUnpaid ? 'leaveunpaid:' + taskId + ':' + attempt : null;
  const unpaid = useCommandDraft(unpaidKey, unpaidKey ? PROMISE_SHAPE : null, view?.basis ?? NO_BASIS);

  const send = (envelope: AnyCommandEnvelope | null, sent: () => void) => {
    if (!envelope || busy) return;
    setBusy(true);
    sent();
    client.command(envelope).then((outcome) => {
      setBusy(false);
      if (isAccepted(outcome)) { onDone(); return; }
      setAttempt((n) => n + 1);
      setError(outcome.error?.message ?? say('commandFailed'));
    }, () => { setBusy(false); setError(say('sendFailed')); });
  };
  const confirm = () => { if (draft && view) send(envelopeFor(draft, view.command, view.expect), markSent); };
  const leaveUnpaid = () => { if (unpaid.draft && view?.leaveUnpaid) send(envelopeFor(unpaid.draft, view.leaveUnpaid.command, undefined), unpaid.markSent); };
  const type = (value: string) => { setDigits(value); setError(null); setParams((prev) => withAmount(prev, value)); };
  // 금액 · 수단을 바꾼 뒤 새 답이 오기 전에는 누르지 않는다(보낼 명령이 화면과 같게).
  const fresh = view !== null && answered === paramsKey;

  return (
    <BottomPanel
      title={view?.title ?? ''}
      onClose={onClose}
      className="pos-field-pay"
      {...(draft ? { requestId: draft.requestId } : {})}
      primary={view ? (
        <PrimaryButton
          // 휴대폰(전체 화면 판)은 이름이 한 줄에 들어가지 않으면 두 줄로(받을 돈 · 보증금을 빼기 전에).
          lines={profile.primaryFullWidth ? 2 : 1}
          label={busy ? t('processing') : view.primary.label}
          {...(busy ? {} : { alts: view.primary.alts })}
          disabled={!view.primary.enabled || !draft || !fresh}
          busy={busy}
          onPress={confirm}
        />
      ) : null}
    >
      {view ? (
        <div className="pos-field-pay-grid">
          <div className="pos-field-pay-side">
            <div className="pos-field-pay-due">
              <RichLine runs={view.due} />
              {view.leaveUnpaid ? <button type="button" className="sn-button" onClick={leaveUnpaid}>{view.leaveUnpaid.label}</button> : null}
            </div>
            <div className="pos-field-pay-amount" role="group" aria-label={say('fieldAmount')}>
              <span className="pos-field-pay-label">{say('fieldAmount')}</span>
              <output className={'sn-keypad-display' + (digits ? ' has-value' : '')} aria-live="polite">{digits ? formatWon(Number(digits)) : ''}</output>
            </div>
            <ChoiceRow options={view.methods} label={say('methodGroup')} onPress={(methodKey) => { setError(null); setParams((prev) => ({ ...prev, methodKey })); }} />
            {error ? <p className="pos-dialog-error" role="alert">{error}</p> : null}
          </div>
          <NumberPad mode="amount" title={say('fieldAmount')} value={digits ?? ''} onChange={type} onSubmit={type} placement="inline" keysOnly />
        </div>
      ) : error ? <p className="pos-dialog-error" role="alert">{error}</p> : null}
    </BottomPanel>
  );
}

// ── 리프트권 추가 ──────────────────────────────────────────────────────

const TICKET_SHAPE: ConfirmCommand = { type: 'field.add_ticket', payload: { taskId: '', orderId: '', productKey: '', quantity: 0, assetIds: [], amount: 0 } };

export interface AddTicketPanelProps {
  taskId: string;
  onClose: () => void;
  /** 권 추가가 끝났다(적용 · 보냄 대기): 그 요청번호로 곧바로 현장 수납 판을 연다. */
  onAdded: (requestId: string) => void;
}

/** 리프트권 추가 판: 권종(차량 예비권 재고) · 수량 −/+ · 값 · 보증금 줄 · 주 버튼 `리프트권 추가 · 1매 · 보증금 5,000원`. */
export function AddTicketPanel({ taskId, onClose, onAdded }: AddTicketPanelProps) {
  const client = useClient();
  const profile = useDeviceProfile();
  const [params, setParams] = useState<AddTicketSheetParams>({ taskId });
  const [view, setView] = useState<AddTicketSheetView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const paramsKey = JSON.stringify(params);
  const [answered, setAnswered] = useState('');
  useEffect(() => {
    let alive = true;
    client.query('addTicketSheet', params).then((next) => { if (alive) { setView(next); setAnswered(paramsKey); } }, () => { if (alive) setError(say('openFailed')); });
    return () => { alive = false; };
  }, [client, paramsKey]);
  const key = view ? 'addticket:' + taskId + ':' + attempt : null;
  const { draft, markSent } = useCommandDraft(key, key ? TICKET_SHAPE : null, view?.basis ?? NO_BASIS);
  const confirm = () => {
    const envelope = draft && view ? envelopeFor(draft, view.command, view.expect) : null;
    if (!envelope || busy || !draft) return;
    setBusy(true);
    markSent();
    client.command(envelope).then((outcome) => {
      setBusy(false);
      if (isAccepted(outcome)) { onAdded(draft.requestId); return; }
      setAttempt((n) => n + 1);
      setError(outcome.error?.message ?? say('commandFailed'));
    }, () => { setBusy(false); setError(say('sendFailed')); });
  };
  const product = view?.products.find((p) => p.selected);
  return (
    <BottomPanel
      title={view?.title ?? ''}
      onClose={onClose}
      className="pos-add-ticket"
      {...(draft ? { requestId: draft.requestId } : {})}
      primary={view ? (
        <PrimaryButton
          // 휴대폰(전체 화면 판)은 이름이 한 줄에 들어가지 않으면 두 줄로(받을 돈 · 보증금을 빼기 전에).
          lines={profile.primaryFullWidth ? 2 : 1}
          label={busy ? t('processing') : view.primary.label}
          {...(busy ? {} : { alts: view.primary.alts })}
          disabled={!view.primary.enabled || !draft || answered !== paramsKey}
          busy={busy}
          onPress={confirm}
        />
      ) : null}
    >
      {view ? (
        <>
          {/* 권종이 하나뿐이면 권종 줄 없이 수량 줄의 이름(`야간권` / `재고 6매`)만: 같은 글을 두 번 쓰지 않는다. */}
          {view.products.length > 1 ? (
            <div className="pos-add-ticket-row">
              <span className="pos-field-pay-label">{say('ticketKind')}</span>
              <ChoiceRow options={view.products} label={say('ticketKind')} onPress={(productKey) => { setError(null); setParams((prev) => ({ ...prev, productKey, quantity: 1 })); }} />
            </div>
          ) : null}
          {view.quantity.max > 0 ? (
            <QtyStepper
              name={product?.label ?? ''}
              note={product?.secondLine ?? ''}
              quantity={view.quantity}
              label={say('qtyOf', { item: product?.label ?? say('ticketQty') })}
              onChange={(quantity) => { setError(null); setParams((prev) => ({ ...prev, quantity })); }}
            />
          ) : null}
          <div className="pos-add-ticket-lines">
            {view.lines.map((line, i) => <RichLine key={i} runs={line} />)}
          </div>
          {error ? <p className="pos-dialog-error" role="alert">{error}</p> : null}
        </>
      ) : error ? <p className="pos-dialog-error" role="alert">{error}</p> : null}
    </BottomPanel>
  );
}

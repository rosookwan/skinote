// 확인 필요 `초과 수납`의 `환불 · {금액}` 창(features-1 §9-1 · §9-3): 더 받은 돈을 돌려준다(payment.refund, cause 'overpaid'). 환불 줄 두 줄(수납마다
// 원래 수단 · 현금, 카드면 `단말기 취소`, 셋 이상이면 그 자리 안에서 쪽 넘김)과 요약 `초과 수납 10,000원 · 환불 10,000원`, 주 버튼 `환불 · 현금 10,000원`.
// 할인 · 취소 창의 환불 줄 모양(.pos-discount-refund)을 쓴다. 창은 연 때 요청번호와 기준(basis)을 정하고(useCommandDraft), 수단을 바꿀 때마다
// refundSheet를 다시 물어 줄 글 · 주 버튼 · 명령을 받는다. 화면은 금액을 셈하지 않는다. 창 높이는 흔들리지 않는다(환불 줄 두 줄 자리를 늘 남긴다).
import { envelopeFor, isAccepted, type Basis, type ConfirmCommand, type RefundSheetParams, type RefundSheetView } from '@skinote/contract';
import { DialogFrame, PrimaryButton, RichLine, t, useCommandDraft } from '@skinote/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '../app/client.tsx';
import { say } from '../app/strings.ts';
import { REFUND_LINE_ROWS, RefundRows } from './RefundRows.tsx';

const NO_BASIS: Basis = { epoch: '', rev: 0 };
/** 환불 줄 자리(두 줄, 셋 이상이면 그 자리 안에서 쪽 넘김, RefundRows). */
export const REFUND_ROWS = REFUND_LINE_ROWS;

/** 환불 줄의 수단(그 수납의 수단 · 현금). */
export const withRefundMethod = (params: RefundSheetParams, paymentId: string, methodKey: string): RefundSheetParams => ({
  ...params, methods: { ...params.methods, [paymentId]: methodKey },
});

/** 창을 연 때의 초안 모양(본문은 확정할 때 서버가 준 것으로 바뀐다: 요청번호 · basis만 이것으로 정한다). */
const draftShape = (orderId: string): ConfirmCommand => ({ type: 'payment.refund', payload: { orderId, cause: 'overpaid', refunds: [] } });

export interface RefundDialogProps {
  orderId: string;
  onClose: () => void;
  /** 창을 열지 못함(연결 끊김): 부르는 쪽이 한 줄 알림. */
  onFail: (line: string) => void;
}

export function RefundDialog({ orderId, onClose, onFail }: RefundDialogProps) {
  const client = useClient();
  const [params, setParams] = useState<RefundSheetParams>({ orderId });
  const [loaded, setLoaded] = useState<{ key: string; view: RefundSheetView } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 이 요청번호로 보낸 명령이 적용되지 않았다: 창을 닫고 다시 열어야 새 요청번호가 된다(sync 2절). */
  const [spent, setSpent] = useState(false);
  const paramsKey = JSON.stringify(params);
  const asked = useRef('');
  const view = loaded?.view ?? null;
  const stale = loaded !== null && loaded.key !== paramsKey;

  useEffect(() => {
    let alive = true;
    asked.current = paramsKey;
    client.query('refundSheet', params).then(
      (next) => { if (alive && asked.current === paramsKey) setLoaded({ key: paramsKey, view: next }); },
      () => { if (alive) { if (loaded) setError(say('openFailed')); else onFail(say('openFailed')); } },
    );
    return () => { alive = false; };
  }, [client, paramsKey]);

  const shape = useMemo(() => (view ? draftShape(orderId) : null), [view !== null, orderId]);
  const { draft, markSent } = useCommandDraft(view ? 'refund:' + orderId : null, shape, view?.basis ?? NO_BASIS);

  if (!view) return null;

  const confirm = () => {
    if (busy || spent || stale || !draft) return;
    const envelope = envelopeFor(draft, view.command, view.expect);
    if (!envelope) return;
    setBusy(true);
    markSent();
    client.command(envelope).then((outcome) => {
      if (isAccepted(outcome)) { onClose(); return; }
      setBusy(false);
      setSpent(true);
      setError(outcome.error?.message ?? say('commandFailed'));
    }, () => {
      // 보내지 못했다(연결 끊김): 같은 창에서 다시 누르면 같은 요청번호로 다시 보낸다.
      setBusy(false);
      setError(say('sendFailed'));
    });
  };

  const alert = error ?? view.notice ?? null;
  const ready = view.primary.enabled && view.command !== undefined && !stale && !spent && draft !== null;

  return (
    <DialogFrame
      title={view.title}
      onClose={onClose}
      className="pos-refund"
      {...(draft ? { requestId: draft.requestId } : {})}
      primary={(
        <PrimaryButton
          label={busy ? t('processing') : view.primary.label}
          {...(busy ? {} : { alts: view.primary.alts.length ? view.primary.alts : [view.primary.label] })}
          disabled={!ready}
          busy={busy}
          onPress={confirm}
        />
      )}
    >
      <RefundRows lines={view.refunds} onMethod={(paymentId, key) => { if (!spent) setError(null); setParams(withRefundMethod(params, paymentId, key)); }} />
      <div className={'pos-discount-summary' + (alert ? ' is-alert' : '')} {...(alert ? { role: 'alert' } : {})}>
        <RichLine runs={alert ? [{ text: alert, strong: true }] : view.summary} />
      </div>
    </DialogFrame>
  );
}

// 손님 픽업은 접수 체크만 바꾼다. 기존 장비 일정·차량 업무·정산은 건드리지 않는다.
import { envelopeFor, isAccepted, type ConfirmCommand, type OrderSlip } from '@skinote/contract';
import { DialogFrame, PrimaryButton, t, useCommandDraft } from '@skinote/ui';
import { useMemo, useState } from 'react';
import { useClient, useConnection } from '../app/client.tsx';
import { say } from '../app/strings.ts';

export function CustomerPickupDialog({ slip, onClose }: { slip: OrderSlip; onClose: () => void }) {
  const client = useClient();
  const connection = useConnection();
  const [initial] = useState(slip.counter?.customerPickup === true);
  const [enabled, setEnabled] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shape = useMemo<ConfirmCommand>(() => ({ type: 'order.customer_pickup', payload: { orderId: slip.orderId, enabled: initial, expected: initial } }), [slip.orderId, initial]);
  const { draft, markSent } = useCommandDraft('customer-pickup:' + slip.orderId, shape, slip.basis);
  const save = () => {
    if (!draft || busy || spent || !connection.online || !slip.customerPickupEditable) return;
    const envelope = envelopeFor(draft, { type: 'order.customer_pickup', payload: { orderId: slip.orderId, enabled, expected: initial } });
    if (!envelope) return;
    setBusy(true); markSent();
    client.command(envelope).then((outcome) => {
      setBusy(false);
      if (isAccepted(outcome)) { onClose(); return; }
      setSpent(true); setError(outcome.error?.message ?? say('commandFailed'));
    }, () => { setBusy(false); setError(say('sendFailed')); });
  };
  return <DialogFrame title={say('customerPickupTitle')} onClose={onClose} className="pos-customer-pickup"
    {...(draft ? { requestId: draft.requestId } : {})}
    primary={<PrimaryButton label={busy ? t('processing') : say('customerPickupSave')} disabled={busy || spent || !connection.online || !slip.customerPickupEditable || enabled === initial} busy={busy} onPress={save} />}>
    <p className="pos-customer-pickup-team">{slip.teamName}</p>
    <button type="button" className="sn-button pos-customer-pickup-check" role="checkbox" aria-checked={enabled} disabled={busy || spent}
      onClick={() => setEnabled(!enabled)}><span aria-hidden="true">{enabled ? '☑' : '□'}</span><span>{say('customerPickupNeed')}</span></button>
    <p className="pos-customer-pickup-note">{say('customerPickupSeparate')}</p>
    {error || !connection.online ? <p role="alert">{error ?? say('customerPickupOffline')}</p> : null}
  </DialogFrame>;
}

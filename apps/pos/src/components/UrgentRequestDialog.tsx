// 긴급 요청은 기존 배달·수거 업무를 가리킨다. 자유 메모나 새 배차를 만들지 않는다.
import { envelopeFor, isAccepted, type ConfirmCommand, type OrderSlip, type UrgentTaskOption } from '@skinote/contract';
import { DialogFrame, Pager, PrimaryButton, formatTime, t, useCommandDraft, useUi } from '@skinote/ui';
import { useMemo, useState } from 'react';
import { useClient, useConnection } from '../app/client.tsx';
import { say } from '../app/strings.ts';

function Request({ slip, task, onClose, onSchedule }: { slip: OrderSlip; task: UrgentTaskOption; onClose: () => void; onSchedule?: () => void }) {
  const client = useClient(); const connection = useConnection(); const { timezone } = useUi();
  const [busy, setBusy] = useState(false); const [spent, setSpent] = useState(false); const [error, setError] = useState<string | null>(null);
  const shape = useMemo<ConfirmCommand>(() => task.pin ? {type:'task.unpin',payload:{pinId:task.pin.id}} : {type:'task.pin',payload:{taskId:task.taskId}}, [task.taskId, task.pin?.id]);
  const { draft, markSent } = useCommandDraft('urgent:' + task.taskId, shape, slip.basis);
  const save = () => {
    const envelope = draft && !busy && !spent && connection.online ? envelopeFor(draft, shape) : null;
    if (!envelope) return;
    setBusy(true); markSent();
    client.command(envelope).then((outcome) => {
      setBusy(false); if (isAccepted(outcome)) { onClose(); return; }
      setSpent(true); setError(outcome.error?.message ?? say('commandFailed'));
    }, () => { setBusy(false); setError(say('sendFailed')); });
  };
  return <>
    <div className="pos-urgent-request-info"><strong>{task.kindLabel}</strong><span>{task.placeLabel}</span><span>{formatTime(task.at, timezone)} · {task.vehicleLabel}</span></div>
    {task.pin ? <p>{say(task.pin.status === 'acknowledged' ? 'urgentAcknowledged' : 'urgentWaiting')}</p> : null}
    {task.connectionNotes?.map(note => <p key={note}>{note}</p>)}
    {error || !connection.online ? <p role="alert">{error ?? say('urgentOffline')}</p> : null}
    <div className="pos-urgent-request-actions">
      {onSchedule ? <button type="button" className="sn-button" disabled={busy} onClick={onSchedule}>{say('counterSchedule')}</button> : null}
      <PrimaryButton label={busy ? t('processing') : say(task.pin ? 'urgentRelease' : 'urgentTitle')} busy={busy} disabled={busy || spent || !connection.online} onPress={save} />
    </div>
  </>;
}
export function UrgentRequestDialog({ slip, onClose, onSchedule }: { slip: OrderSlip; onClose: () => void; onSchedule?: () => void }) {
  const tasks = slip.urgentTasks ?? []; const [page, setPage] = useState(0); const task = tasks[Math.min(page, tasks.length - 1)];
  return <DialogFrame title={say('urgentTitle')} onClose={onClose} className="pos-urgent-request"
    pager={tasks.length > 1 ? <Pager page={page} pageCount={tasks.length} onChange={setPage} /> : null}>
    <p className="pos-customer-pickup-team">{slip.teamName}</p>
    {task ? <Request key={task.taskId} slip={slip} task={task} onClose={onClose} {...(onSchedule ? {onSchedule} : {})} /> : <p>{say('urgentNoTarget')}</p>}
  </DialogFrame>;
}

// 여러 긴급을 한 목록에서 확인한다. 기사 확인과 장비 작업 완료를 분리한다.
import { draftToEnvelope, isAccepted, type Basis, type ConfirmCommand, type PinRow } from '@skinote/contract';
import { confirmWindow } from '@skinote/layout';
import { DialogFrame, Pager, formatTime, useCommandDraft, useUi, useElementSize, useIsoLayoutEffect } from '@skinote/ui';
import { useMemo, useRef, useState } from 'react';
import { useClient } from '../app/client.tsx';
import { say } from '../app/strings.ts';

function UrgentRow({ pin, basis, driver, onOpen }: { pin: PinRow; basis: Basis; driver: boolean; onOpen: (pin: PinRow) => void }) {
  const client = useClient(); const {timezone}=useUi(); const [busy,setBusy]=useState(false); const [error,setError]=useState<string|null>(null);
  const shape=useMemo<ConfirmCommand>(()=>({type:'notification.ack',payload:{notificationId:pin.pinId}}),[pin.pinId]);
  const {draft,markSent}=useCommandDraft('urgent-ack:'+pin.pinId,shape,basis);
  const ack=()=>{
    if (!draft || busy || pin.pendingAck) return;
    setBusy(true);markSent();
    client.command(draftToEnvelope(draft)).then((outcome)=>{setBusy(false);if(!isAccepted(outcome))setError(outcome.error?.message??say('commandFailed'));},()=>{setBusy(false);setError(say('sendFailed'));});
  };
  return <div className="pos-urgent-row">
    <div className="pos-urgent-team"><strong>{pin.teamName ?? pin.parts.filter(p=>p.drop===0).map(p=>p.text).join(' · ')}</strong><span>{pin.kindLabel}</span></div>
    <div className="pos-urgent-place"><span>{pin.placeLabel ?? pin.parts.filter(p=>p.drop!==0).map(p=>p.text).join(' · ')}</span><span>{formatTime(pin.at,timezone)} · {pin.vehicleLabel}</span></div>
    <div className="pos-urgent-state"><span>{say(pin.pendingAck?'urgentPending':pin.status==='acknowledged'?'urgentAcknowledged':'urgentWaiting')}</span>
      <button type="button" className="sn-button" disabled={busy || pin.pendingAck} onClick={()=>driver&&pin.status!=='acknowledged'?ack():onOpen(pin)}>{say(driver&&pin.status!=='acknowledged'?'urgentAck':'urgentOpen')}</button></div>
    {error?<p role="alert">{error}</p>:null}
  </div>;
}
export function UrgentListDialog({pins,basis,driver=false,onOpen,onClose}:{pins:readonly PinRow[];basis:Basis;driver?:boolean;onOpen:(pin:PinRow)=>void;onClose:()=>void}) {
  const {profile,viewport}=useUi();const [page,setPage]=useState(0);
  const compact=viewport.width<profile.counter.compactBelowPx;
  const box=confirmWindow(viewport,profile.confirm,1,0);
  const rowsRef=useRef<HTMLDivElement>(null);const rowsSize=useElementSize(rowsRef);
  const [measured,setMeasured]=useState(0);
  // 실제 줄바꿈 높이를 쪽 나누기에 포함한다. 긴 이름·장소를 자르지 않고 열린 동안 가장 큰 줄을 예약한다.
  useIsoLayoutEffect(()=>{
    const height=Math.max(0,...[...(rowsRef.current?.children??[])].map(el=>el.getBoundingClientRect().height));
    if(height>measured)setMeasured(height);
  },[pins,rowsSize,measured]);
  const rowHeight=Math.max(profile.minTargetPx*(compact?4:2),measured)+profile.space.m;
  const available=box.heightPx-profile.confirm.titlePx-profile.confirm.primaryRowPx-profile.space.m*2;
  const perPage=Math.max(1,Math.floor(available/rowHeight)); const pages=Math.max(1,Math.ceil(pins.length/perPage));const current=Math.min(page,pages-1);
  return <DialogFrame title={say('urgentTitle')} onClose={onClose} className={'pos-urgent-list'+(compact?' is-compact':'')}
    pager={pages>1?<Pager page={current} pageCount={pages} onChange={setPage}/>:null}>
    <div ref={rowsRef} className="pos-urgent-rows">{pins.slice(current*perPage,(current+1)*perPage).map(pin=><UrgentRow key={pin.pinId} pin={pin} basis={basis} driver={driver} onOpen={onOpen}/>)}</div>
    {!pins.length?<p>{say('urgentNoTarget')}</p>:null}
  </DialogFrame>;
}

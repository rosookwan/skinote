// 첫 화면에는 긴급 건수만 싣고 개별 목록은 열 때 읽는다.
import type { PinRow } from '@skinote/contract';
import { TextFit } from '@skinote/ui';
import { say } from '../app/strings.ts';

export const urgentUnconfirmed = (pins: readonly PinRow[]) => pins.filter((p) => p.status !== 'acknowledged' || p.pendingAck).length;
export function UrgentBar({ pins, onOpen }: { pins: readonly PinRow[]; onOpen: () => void }) {
  if (!pins.length) return null;
  const count = urgentUnconfirmed(pins);
  return <button type="button" className="sn-button pos-urgent-bar" onClick={onOpen}><TextFit input={{mode:'words',text:say(count ? 'urgentUnread' : 'urgentConfirmedCount',{n:count || pins.length})}} /></button>;
}

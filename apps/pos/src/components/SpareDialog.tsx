// `예비권 적재` · `예비권 입고` 창(features-1 §8-2, E21): 리프트권 화면 현황 탭의 차량 칸이 연다(카운터만). 권종마다 −/+(처음 0, 입고는 차에 있는 수까지),
// 요약 `1호 차량 예비권 재고 6매 → 8매`, 주 버튼 `예비권 적재 · 야간권 2매`. 틀은 분실 처리 창과 같다(PieceSheet).
import type { ConfirmCommand, SpareSheetParams, SpareSheetView, SpareUnits } from '@skinote/contract';
import { useClient } from '../app/client.tsx';
import { say } from '../app/strings.ts';
import { PieceSheet, useSheet, withPiece } from './TicketLossDialog.tsx';

export interface SpareDialogProps {
  vehicleId: string;
  direction: 'load' | 'unload';
  onClose: () => void;
  onFail: (line: string) => void;
}

export function SpareDialog({ vehicleId, direction, onClose, onFail }: SpareDialogProps) {
  const client = useClient();
  const sheet = useSheet<SpareSheetParams, SpareSheetView>((p) => client.query('spareSheet', p), { vehicleId, direction }, onFail);
  const view = sheet.view;
  if (!view) return null;
  const picked = (sheet.params.picked ?? view.picked) as SpareUnits[];
  const shape: ConfirmCommand = direction === 'load'
    ? { type: 'stock.load', payload: { vehicleId, spares: [] } }
    : { type: 'stock.receive', payload: { vehicleId, taskIds: [], spares: [] } };
  return (
    <PieceSheet
      kind="spare"
      view={{ ...view, text: [view.summary] }}
      stale={sheet.stale}
      textRows={1}
      shape={shape}
      draftKey={'spare-' + direction + ':' + vehicleId}
      groupLabel={say('ticketPieces')}
      onQuantity={(key, value) => sheet.setParams({ ...sheet.params, picked: withPiece(picked, (x) => x.productKey, key, value, (id, quantity) => ({ productKey: id, quantity })) })}
      onClose={onClose}
    />
  );
}

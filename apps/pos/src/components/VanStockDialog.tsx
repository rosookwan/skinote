// 차량 재고(ui 6-5): 차량에 있는 장비 · 권의 합(배달할 것 · 수거한 것 · 예비권)과 팀별로 누구 것인지. 읽기 모델(vehicleLoad)을 그리기만 한다.
// 팀 줄은 잰 창 높이로 쪽을 나눈다(스크롤 없음). 수가 없으면 '입고 대상 없음'.
import type { VehicleLoad } from '@skinote/contract';
import { confirmWindow } from '@skinote/layout';
import { Pager, TextFit, formatItem, useUi } from '@skinote/ui';
import { useState } from 'react';
import { say } from '../app/strings.ts';
import { NoticeDialog } from './NoticeDialog.tsx';

export function VanStockDialog({ load, onClose }: { load: VehicleLoad; onClose: () => void }) {
  const { profile, viewport } = useUi();
  const [page, setPage] = useState(0);
  const box = confirmWindow(viewport, profile.confirm, 1, 0);
  const { space } = profile;
  // 창 높이 − 제목 − 바닥 − 본문 위아래 여백 − 합계 한 줄(본문 글자 × 줄 간격, DeviceProfile) − 쪽 넘김 줄 → 팀 줄(누르는 곳 높이) 몇 개.
  const room = box.heightPx - profile.confirm.titlePx - profile.confirm.primaryRowPx - 2 * space.m
    - Math.ceil(profile.bodyFontPx * profile.bodyLineHeight) - space.s - profile.minTargetPx - space.s;
  const perPage = Math.max(1, Math.floor((room + space.s) / (profile.minTargetPx + space.s)));
  // 팀 줄(배달할 것 · 수거한 것) 뒤에 예비권 한 줄(`예비권 · 야간권 6매`).
  const all = [
    ...load.byTask.map((row) => ({ key: row.taskId, name: row.teamName + ' · ' + row.last4, items: row.items })),
    ...(load.spareTickets.length ? [{ key: 'spare', name: say('spareTickets'), items: load.spareTickets }] : []),
  ];
  const pageCount = Math.max(1, Math.ceil(all.length / perPage));
  const current = Math.min(page, pageCount - 1);
  const rows = all.slice(current * perPage, (current + 1) * perPage);
  const total = load.items.length ? load.items.map(formatItem).join(' · ') : say('vanEmpty');
  return (
    <NoticeDialog title={say('onVan') + ' · ' + load.vehicleLabel} lines={[]} onClose={onClose}>
      <TextFit className="pos-van-total" input={load.items.length ? { mode: 'items', items: load.items.map(formatItem) } : { mode: 'words', text: total }} />
      {rows.length ? (
        <ul className="pos-van-rows">
          {rows.map((row) => (
            <li key={row.key} className="pos-van-row">
              <span className="pos-van-name">{row.name}</span>
              <TextFit className="pos-van-items" input={{ mode: 'items', items: row.items.map(formatItem) }} />
            </li>
          ))}
        </ul>
      ) : null}
      {pageCount > 1 ? <Pager page={current} pageCount={pageCount} onChange={setPage} /> : null}
    </NoticeDialog>
  );
}

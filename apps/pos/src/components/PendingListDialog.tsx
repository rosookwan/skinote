// 전송 대기 목록(ui 7 `pending(): PendingCommand[] // 전송 대기 목록`, work/impl-offline/plan.md §17 R3-19): 이 기기가 아직 서버의 답을 받지 않은
// 기록마다 한 줄 — 첫 줄 팀 · 끝 4자리, 둘째 줄 일 이름 · 돈 · 시각(문구 표 3-14 `김민수 · 0025 수거 21:42`), 답을 잃은 것은 `· 결과 확인 중`.
// 점선 도장이 없는 기록(현장 수납 · 수거 실패 · 리프트권 추가 · 순서 변경)도 여기서 찾는다. 줄은 잰 창 높이로 쪽을 나눈다(스크롤 없음).
// 둘째 줄은 좁으면 돈 · 시각부터 뺀다(TextFit 대체 문구). 창은 기록을 고치지 않는다(보기만).
import type { PendingCommand } from '@skinote/contract';
import { confirmWindow } from '@skinote/layout';
import { Pager, TextFit, t, useUi } from '@skinote/ui';
import { useState } from 'react';
import { say } from '../app/strings.ts';
import { NoticeDialog } from './NoticeDialog.tsx';

/** 한 줄의 둘째 줄 대체 문구(긴 것부터): 일 이름 · 돈 · 시각, 답을 잃은 것은 `· 결과 확인 중`. 순수 함수(시험). */
export function pendingRowAlts(item: PendingCommand): { name: string; alts: string[] } {
  const line = item.line;
  const suffix = item.state === 'unconfirmed' ? ' · ' + say('resultPending') : '';
  if (!line) return { name: item.summary, alts: suffix ? [suffix.slice(3)] : [] };
  const parts = (withMoney: boolean, withAt: boolean) => [line.who ? line.what : undefined, withMoney ? line.money : undefined, withAt ? line.at : undefined].filter(Boolean).join(' ');
  const raw = [parts(true, true), parts(false, true), parts(false, false)].map((text) => (text + suffix).replace(/^ · /, ''));
  return { name: line.who ?? line.what, alts: [...new Set(raw.filter(Boolean))] };
}

export function PendingListDialog({ items, onClose }: { items: readonly PendingCommand[]; onClose: () => void }) {
  const { profile, viewport } = useUi();
  const [page, setPage] = useState(0);
  const box = confirmWindow(viewport, profile.confirm, 1, 0);
  const { space } = profile;
  // 줄 높이: 두 줄 글(본문 글자 × 줄 간격) + 위아래 여백, 누르는 곳 높이보다 작지 않게(차량 재고 창의 줄과 같은 셈).
  const rowPx = Math.max(profile.minTargetPx, 2 * Math.ceil(profile.bodyFontPx * profile.bodyLineHeight) + 2 * space.xs);
  // 창 높이 − 제목 − 바닥 − 본문 위아래 여백 − 쪽 넘김 줄 → 줄 몇 개.
  const room = box.heightPx - profile.confirm.titlePx - profile.confirm.primaryRowPx - 2 * space.m - profile.minTargetPx - space.s;
  const perPage = Math.max(1, Math.floor((room + space.s) / (rowPx + space.s)));
  const pageCount = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(page, pageCount - 1);
  const rows = items.slice(current * perPage, (current + 1) * perPage);
  return (
    <NoticeDialog title={t('pendingCount', { n: items.length })} lines={[]} onClose={onClose}>
      <ul className="pos-pending-rows">
        {rows.map((item) => {
          const row = pendingRowAlts(item);
          return (
            <li key={item.requestId} className="pos-pending-row" style={{ minHeight: rowPx }}>
              <span className="pos-pending-name">{row.name}</span>
              {row.alts.length ? <TextFit className="pos-pending-what" input={{ mode: 'alts', alts: row.alts }} /> : null}
            </li>
          );
        })}
      </ul>
      {pageCount > 1 ? <Pager page={current} pageCount={pageCount} onChange={setPage} /> : null}
    </NoticeDialog>
  );
}

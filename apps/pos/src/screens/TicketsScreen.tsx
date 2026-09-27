// 리프트권(features-1 §8-2, 머리줄 메뉴 `리프트권`, #/tickets · #/tickets/unreturned · #/tickets/lost): 장부형 종이 한 장, 주 버튼 없음.
//   - 제목 `12월 26일 (토) 리프트권`과 색인 탭 `현황` · `미반납 {n}` · `분실 {n}`.
//   - 현황(그 영업일): 왼쪽 표(권종 · 지급 · 미반납 · 반납 · 분실, 끝 줄 합계), 오른쪽 차량 칸(차량마다 `예비권 재고 야간권 6매`와 `예비권 적재` ·
//     `예비권 입고`). 줄 높이는 남는 높이를 나눠 쓰고(layout fillRows) 넘치면 쪽을 넘긴다.
//   - 미반납(모든 날): 팀마다 한 줄(팀 · 권, 둘째 줄 반납 일정 — 늦으면 빨강), 버튼 `분실 처리` · `전화`. 줄을 누르면 그 접수증.
//   - 분실: 팀마다 한 줄(팀 · 권, 둘째 줄 `분실 12/26`), 버튼 `분실 회수`.
// 화면은 셈하지 않는다: 줄 · 수 · 누를 수 있는지는 읽기 모델(ticketBoard) 그대로다. 창은 분실 처리 · 분실 회수(TicketLossDialog), 예비권 적재 · 입고
// (SpareDialog), 전화(CallDialog).
import { ACTION_LABELS, type LedgerTabRow, type TicketBoardView, type TicketRow, type TicketStatusRow, type TicketTabKey, type TicketVehicleBlock } from '@skinote/contract';
import { fillRows } from '@skinote/layout';
import { FooterBar, Icon, IndexTabs, Pager, TextFit, t, useElementSize, useUi } from '@skinote/ui';
import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLive } from '../app/client.tsx';
import { go } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { CallDialog } from '../components/CallDialog.tsx';
import { ChoiceSheet, NoticeDialog } from '../components/NoticeDialog.tsx';
import { usePosHeader } from '../components/PosHeader.tsx';
import { SpareDialog } from '../components/SpareDialog.tsx';
import { TicketLossDialog } from '../components/TicketLossDialog.tsx';

/** 읽기 모델의 탭 → 색인 탭 행(화면 설정 행과 같은 모양: 수를 보이는 탭만 수). */
export function ticketTabs(view: Pick<TicketBoardView, 'tabs'>): { tabs: LedgerTabRow[]; counts: Record<string, number> } {
  const tabs: LedgerTabRow[] = view.tabs.map((tab, i) => ({
    tab_key: tab.key, label: tab.label, short_label: null, filter_key: 'all', params: null, seq: (i + 1) * 10, priority: 100 - i * 10,
    overflow_key: 'more_sheet', shows_count: tab.count === undefined ? 0 : 1, feature_key: null, feature_on: 1,
  }));
  const counts = Object.fromEntries(view.tabs.flatMap((tab) => (tab.count === undefined ? [] : [[tab.key, tab.count]])));
  return { tabs, counts };
}

/** 차량 칸 한 칸의 최소 높이(이름 줄 · 재고 줄 · 버튼 줄 · 사이): 등급 값으로 센다. */
export const vehicleBlockPx = (profile: { minTargetPx: number; minFontPx: number; bodyLineHeight: number; space: { s: number } }) =>
  Math.ceil(2 * profile.minFontPx * profile.bodyLineHeight) + profile.minTargetPx + 3 * profile.space.s;

type Dialog =
  | { kind: 'loss' | 'found'; orderId: string }
  | { kind: 'load' | 'unload'; vehicleId: string }
  | { kind: 'call'; orderId: string; teamName: string };

export function TicketsScreen({ tab }: { tab: TicketTabKey }) {
  const header = usePosHeader('other', 'lift_tickets');
  const { profile } = useUi();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<{ title: string; lines: string[] } | null>(null);
  const [more, setMore] = useState<LedgerTabRow[] | null>(null);
  const [page, setPage] = useState(0);
  const [vanPage, setVanPage] = useState(0);
  const live = useLive<TicketBoardView>('tickets:' + tab, (c) => c.query('ticketBoard', { tab }), dialog !== null || notice !== null || more !== null || header.active);
  const view = live.data;
  const bodyRef = useRef<HTMLDivElement>(null);
  const body = useElementSize(bodyRef);
  const tabRows = useMemo(() => (view ? ticketTabs(view) : { tabs: [], counts: {} }), [view]);

  // 본문 높이(잰 값)에서 위 · 아래 여백(app.css .pos-tickets-body의 s · l)을 뺀 자리.
  const room = Math.max(0, (body?.height ?? 0) - profile.space.s - profile.space.l);
  const { rowMinPx: min, rowMaxPx: max } = profile.fill;
  // 현황 표: 머리 한 줄 + 줄들. 차량 칸: 머리(쪽 넘김이 들면 누르는 곳 높이) + 칸들.
  const status = view?.status ?? [];
  const statusFit = fillRows(room - profile.tableHeadPx, status.length, min, max);
  const vehicles = view?.vehicles ?? [];
  const blockMin = vehicleBlockPx(profile);
  let vanFit = fillRows(room - profile.tableHeadPx, vehicles.length, blockMin, blockMin * 1.25);
  const vanHead = vanFit.pageCount > 1 ? profile.minTargetPx : profile.tableHeadPx;
  if (vanFit.pageCount > 1) vanFit = fillRows(room - vanHead, vehicles.length, blockMin, blockMin * 1.25);
  // 미반납 · 분실 줄: 두 줄 글 + 버튼(긴급 줄 높이부터).
  const rows = view?.rows ?? [];
  const rowFit = fillRows(room, rows.length, profile.pinRowPx, max);

  const listPages = tab === 'status' ? statusFit.pageCount : rowFit.pageCount;
  const current = Math.min(page, listPages - 1);
  const vanAt = Math.min(vanPage, vanFit.pageCount - 1);
  const statusShown = status.slice(current * statusFit.perPage, (current + 1) * statusFit.perPage);
  const rowsShown = rows.slice(current * rowFit.perPage, (current + 1) * rowFit.perPage);
  const vansShown = vehicles.slice(vanAt * vanFit.perPage, (vanAt + 1) * vanFit.perPage);

  const toTab = (key: string) => {
    setPage(0);
    if (key === 'status' || key === 'unreturned' || key === 'lost') go({ name: 'tickets', tab: key }, { replace: true });
  };
  const onRow = (row: TicketRow, key: TicketRow['actions'][number]['key']) => {
    if (key === 'call') setDialog({ kind: 'call', orderId: row.orderId, teamName: row.teamName });
    else setDialog({ kind: key, orderId: row.orderId });
  };
  const fail = (title: string) => (line: string) => { setDialog(null); setNotice({ title, lines: [line] }); };
  const style = {
    '--pos-tickets-row': statusFit.rowPx + 'px', '--pos-tickets-van': vanFit.rowPx + 'px', '--pos-tickets-van-head': vanHead + 'px',
    '--pos-tickets-line': rowFit.rowPx + 'px',
  } as CSSProperties;

  return (
    <div className="sn-screen">
      {header.element}
      <div className="sn-desk">
        <main className="sn-sheet pos-tickets" aria-label={view?.title ?? say('titleTickets')} style={style}>
          {view ? (
            <IndexTabs
              title={view.title}
              tabs={tabRows.tabs}
              counts={tabRows.counts}
              active={view.tab}
              onSelect={toTab}
              onMore={(tabs) => setMore(tabs)}
            />
          ) : null}
          {!view && live.error ? <p className="pos-sheet-note" role="status">{say('ticketsUnreadable')}</p> : null}
          <div ref={bodyRef} className={'pos-tickets-body is-' + tab}>
            {view && tab === 'status' ? (
              <>
                <div className="pos-tickets-left">
                  <table className="sn-ledger-table pos-tickets-table">
                    <colgroup><col className="is-name" />{view.columns.slice(1).map((c) => <col key={c.key} />)}</colgroup>
                    <thead>
                      <tr>{view.columns.map((c, i) => <th key={c.key} scope="col" className={i === 0 ? undefined : 'align-end'}>{c.label}</th>)}</tr>
                    </thead>
                    <tbody>{statusShown.map((row) => <StatusLine key={row.key} row={row} />)}</tbody>
                  </table>
                </div>
                <section className="pos-tickets-right" aria-label={say('ticketVehicles')}>
                  <div className="pos-tickets-van-head">
                    <span className="pos-tickets-van-title">{say('ticketVehicles')}</span>
                    <Pager page={vanAt} pageCount={vanFit.pageCount} onChange={setVanPage} />
                  </div>
                  <ul className="pos-tickets-vans">
                    {vansShown.map((v) => <VehicleBlock key={v.vehicleId} block={v} onPress={(kind) => setDialog({ kind, vehicleId: v.vehicleId })} />)}
                  </ul>
                </section>
              </>
            ) : null}
            {view && tab !== 'status' ? (
              rows.length ? (
                <ul className="pos-tickets-rows">
                  {rowsShown.map((row) => <TicketLine key={row.key} row={row} onOpen={() => go({ name: 'slip', orderId: row.orderId })} onAction={(key) => onRow(row, key)} />)}
                </ul>
              ) : <p className="pos-tickets-empty" role="status">{view.empty}</p>
            ) : null}
          </div>
        </main>
      </div>
      <FooterBar metrics={[]} pager={<Pager page={current} pageCount={listPages} onChange={setPage} />}>
        <div className="pos-footer-back">
          <button type="button" className="sn-button" onClick={() => go({ name: 'ledger', date: null })}>
            <Icon name="left" />
            <span>{t('home')}</span>
          </button>
        </div>
      </FooterBar>
      {more ? (
        <ChoiceSheet
          title={t('more')}
          choices={more.map((x) => ({ key: x.tab_key, label: x.label + (tabRows.counts[x.tab_key] !== undefined ? ' ' + tabRows.counts[x.tab_key] : '') }))}
          onPick={(key) => { setMore(null); toTab(key); }}
          onClose={() => setMore(null)}
        />
      ) : null}
      {dialog && (dialog.kind === 'loss' || dialog.kind === 'found') ? (
        <TicketLossDialog orderId={dialog.orderId} direction={dialog.kind} onClose={() => setDialog(null)} onFail={fail(say('titleTickets'))} />
      ) : null}
      {dialog && (dialog.kind === 'load' || dialog.kind === 'unload') ? (
        <SpareDialog vehicleId={dialog.vehicleId} direction={dialog.kind} onClose={() => setDialog(null)} onFail={fail(say('titleTickets'))} />
      ) : null}
      {dialog?.kind === 'call' ? (
        <CallDialog orderId={dialog.orderId} fallbackTitle={say('noticeTitle', { label: ACTION_LABELS.call, name: dialog.teamName })} onClose={() => setDialog(null)} />
      ) : null}
      {notice ? <NoticeDialog title={notice.title} lines={notice.lines} onClose={() => setNotice(null)} /> : null}
      {header.overlays}
    </div>
  );
}

/** 현황 표 한 줄(권종 · 지급 · 미반납 · 반납 · 분실, 합계는 굵은 줄). */
function StatusLine({ row }: { row: TicketStatusRow }) {
  // 0매는 옅은 먹(2026-09-27 점검: 칸 대부분이 `0매`라 실제 수가 묻혔다).
  const cell = (n: number) => <td className={'align-end pos-tickets-count' + (n === 0 ? ' is-zero' : '')}>{n + row.unit}</td>;
  return (
    <tr className={'sn-row' + (row.total ? ' is-total' : '')}>
      <td className="pos-tickets-kind">{row.label}</td>
      {cell(row.issued)}
      {cell(row.out)}
      {cell(row.returned)}
      {cell(row.lost)}
    </tr>
  );
}

/** 차량 칸: 이름 · 예비권 재고 · 적재 · 입고. 누를 수 없으면 점선(까닭은 읽는 이름). */
function VehicleBlock({ block, onPress }: { block: TicketVehicleBlock; onPress: (kind: 'load' | 'unload') => void }) {
  const button = (kind: 'load' | 'unload', b: TicketVehicleBlock['load']) => (
    <button type="button" className="sn-button pos-tickets-van-button" disabled={!b.enabled} aria-label={b.reason ? b.label + ' · ' + b.reason : b.label} onClick={() => onPress(kind)}>
      <TextFit input={{ mode: 'words', text: b.label }} />
    </button>
  );
  return (
    <li className="pos-tickets-van">
      <span className="pos-tickets-van-name">{block.label}</span>
      <TextFit className="pos-tickets-van-stock" input={{ mode: 'words', text: block.stock }} />
      <span className="pos-tickets-van-buttons">
        {button('load', block.load)}
        {button('unload', block.unload)}
      </span>
    </li>
  );
}

/** 미반납 · 분실 줄: 팀 · 권(첫 줄), 반납 일정 · 분실한 날(둘째 줄, 늦으면 빨강), 버튼. 글을 누르면 그 접수증. */
function TicketLine({ row, onOpen, onAction }: { row: TicketRow; onOpen: () => void; onAction: (key: TicketRow['actions'][number]['key']) => void }) {
  const [first, second] = [row.parts.filter((p) => p.drop === 0), row.parts.filter((p) => p.drop !== 0)];
  return (
    <li className={'pos-tickets-line' + (row.late ? ' is-late' : '')}>
      <button type="button" className="pos-tickets-open" onClick={onOpen}>
        <TextFit className="pos-tickets-line-main" input={{ mode: 'parts', parts: [{ text: row.team, drop: 0 }, ...first.map((p) => ({ ...p, drop: 1 }))] }} />
        <TextFit className={'pos-tickets-line-note' + (row.late ? ' tone-late' : '')} input={{ mode: 'parts', parts: second }} />
      </button>
      <span className="pos-tickets-line-actions">
        {row.actions.map((a) => (
          <button key={a.key} type="button" className="sn-button" disabled={!a.enabled} aria-label={a.reason ? a.label + ' · ' + a.reason : a.label} onClick={() => onAction(a.key)}>
            {a.key === 'call' ? <Icon name="phone" /> : null}
            <span>{a.label}</span>
          </button>
        ))}
      </span>
    </li>
  );
}

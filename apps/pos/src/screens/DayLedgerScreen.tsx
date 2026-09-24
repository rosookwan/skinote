// C1 오늘 대여 장부(ui 6-1): 한 줄 한 팀, 색인 탭(전체 · 수령 · 반납 · 미수 · 차량), 시각 · 팀 · 품목 · 반납 약속 · 돈 칸과
// 지급 · 반납 · 수납 도장 칸, 시각순 줄 사이의 노란 '지금' 줄, 바닥줄 숫자 · 쪽 넘김 · 주황 주 버튼 하나(새 접수, 마지막 반납 타임 뒤 마감).
// 줄을 누르면 접수증, 도장 동그라미를 누르면 확인 창. 칸 · 탭 · 숫자 · 주 버튼은 화면 설정(day_ledger)에서 온다.
import {
  pickPrimaryAction, resolveLedgerView, stampStepMap, visibleView, type LedgerRow, type LedgerTabRow, type LedgerViewResult, type StampCell,
} from '@skinote/contract';
import {
  FooterBar, IndexTabs, Ledger, Pager, fillTitle, t, useDeviceProfile, useServerNow, useUi, type FooterMetric, type LedgerPaging,
} from '@skinote/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dispatchAction } from '../app/actions.ts';
import { useConfig, useLive, usePointerDown } from '../app/client.tsx';
import { actionLabel } from '../app/labels.ts';
import { go, navState, patchNavState } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { pressStamp, useConfirmFlow } from '../components/ConfirmFlow.tsx';
import { ChoiceSheet } from '../components/NoticeDialog.tsx';
import { usePosHeader } from '../components/PosHeader.tsx';
import { useKeptRows } from './keep-position.ts';

const TAB_KEY = 'skinote.pos.ledgerTab';
/** 손을 대지 않은 채 이만큼 지나면 자리 바뀐 줄이 제자리로 간다. */
const SETTLE_AFTER_MS = 60_000;

function storedTab(): string | null {
  try { return window.localStorage.getItem(TAB_KEY); } catch { return null; }
}
function storeTab(tab: string): void {
  try { window.localStorage.setItem(TAB_KEY, tab); } catch { /* 저장이 막혀도 탭은 돈다 */ }
}

export function DayLedgerScreen({ date }: { date: string | null }) {
  const config = useConfig();
  const profile = useDeviceProfile();
  const { timezone } = useUi();
  const restored = useMemo(() => navState().ledger ?? null, []);
  // 돌아왔을 때: 고른 줄이 있으면 그 줄의 쪽(Ledger가 정함), 없으면 보던 쪽.
  const restoredPage = restored && !restored.selected ? restored.page : null;
  const [tab, setTab] = useState<string>(() => restored?.tab ?? storedTab() ?? 'all');
  // null: 아직 쪽 수를 모름 → 처음 여는 쪽(고른 줄 → 지금 줄이 있는 쪽)으로.
  const [page, setPage] = useState<number | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [selected, setSelected] = useState<string | null>(restored?.selected ?? null);
  const [settle, setSettle] = useState(0);
  const [tabSheet, setTabSheet] = useState<LedgerTabRow[] | null>(null);
  const flow = useConfirmFlow();
  const header = usePosHeader('ledger');
  const pointer = usePointerDown();
  const hold = flow.active || header.active || pointer || tabSheet !== null;

  const live = useLive<LedgerViewResult>(
    ['ledger', date ?? '', tab, profile.key].join(':'),
    (c) => c.ledgerView('day_ledger', { ...(date ? { date } : {}), tabKey: tab, deviceClass: profile.key }),
    hold,
  );
  const result = live.data;

  // 날짜 없이 열면(#/ledger) 서버의 오늘 영업일 주소로 바꾼다(기록 상태는 그대로).
  useEffect(() => {
    if (!date && result) go({ name: 'ledger', date: result.currentBusinessDate }, { replace: true, state: navState() });
  }, [date, result]);

  const view = useMemo(() => {
    const resolved = config ? resolveLedgerView(config.ledgerViews, 'day_ledger', profile.key) : undefined;
    return resolved && config ? visibleView(resolved, config.features) : null;
  }, [config, profile.key]);
  const steps = useMemo(() => (config ? stampStepMap(config.stampSteps, config.features) : new Map()), [config]);
  const nowMs = useServerNow(result?.serverTime);

  const rows = useKeptRows(result?.rows, tab + ':' + settle);
  const shown = useMemo(() => (result ? { ...result, rows } : null), [result, rows]);

  // 60초 동안 손을 대지 않았고 창이 닫혀 있으면 자리 바뀐 줄을 제자리로.
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const movedRef = useRef(false);
  movedRef.current = rows.some((r) => r.moved);
  useEffect(() => {
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    document.addEventListener('pointerdown', touch, true);
    const timer = setInterval(() => {
      if (!holdRef.current && movedRef.current && Date.now() - last >= SETTLE_AFTER_MS) setSettle((s) => s + 1);
    }, 5_000);
    return () => { document.removeEventListener('pointerdown', touch, true); clearInterval(timer); };
  }, []);

  // 이 장부의 자리(탭 · 쪽 · 고른 줄)를 기록 상태에 남긴다: 접수증의 '‹ 장부'가 여기로 돌아온다.
  // 쪽을 아직 모르면(처음 그리기 · 날짜 없는 주소를 오늘 주소로 바꾸는 중) 남기지 않는다: 다시 열 때 지금 줄의 쪽으로 가게.
  useEffect(() => {
    if (page === null) return;
    patchNavState({ ledger: { tab, page, selected } });
  }, [tab, page, selected]);

  const onPaging = useCallback((paging: LedgerPaging) => {
    setPageCount(paging.pageCount);
    setPage((current) => Math.min(current ?? restoredPage ?? paging.initialPage, paging.pageCount - 1));
  }, [restoredPage]);

  const flip = (next: number) => {
    setPage(next);
    setSettle((s) => s + 1);
  };

  const selectTab = (key: string) => {
    if (key === tab) return;
    setTab(key);
    storeTab(key);
    setPage(null);
    setSelected(null);
  };

  const openRow = (row: LedgerRow) => {
    if (!row.orderId) return;
    setSelected(row.id);
    patchNavState({ ledger: { tab, page: page ?? 0, selected: row.id } });
    go({ name: 'slip', orderId: row.orderId }, { state: { fromLedger: true } });
  };

  const onStamp = (row: LedgerRow, _column: string, cell: StampCell) => {
    const orderId = row.orderId;
    if (!orderId) return;
    setSelected(row.id);
    const team = Object.values(row.cells).find((c) => c.renderer === 'team');
    const teamName = team?.renderer === 'team' ? team.name : undefined;
    pressStamp(flow, steps, timezone, { orderId, ...(teamName ? { teamName } : {}) }, cell, (key) => dispatchAction(key, { flow, target: { orderId } }));
  };

  // 주 버튼 하나(조건으로 고른 설정 행): 동작 종류로 가른다(새 접수 · 마감은 화면).
  const primary = view && result ? pickPrimaryAction(view.primary_actions, result.activeConditions) : null;
  const onPrimary = () => {
    if (primary) dispatchAction(primary.action_key, { flow, target: {} });
  };

  const metrics: FooterMetric[] = view && result
    ? view.metrics.flatMap((row) => {
        const value = result.metrics.find((m) => m.metricKey === row.metric_key);
        return value ? [{ row, value }] : [];
      })
    : [];

  return (
    <div className="sn-screen">
      {header.element}
      <div className="sn-desk">
        <section className="sn-sheet">
          {!shown && live.error ? <p className="pos-sheet-note" role="status">{say('ledgerUnreadable')}</p> : null}
          {view && shown ? (
            <>
              <IndexTabs
                title={fillTitle(view.label, shown.titleValues)}
                tabs={view.tabs}
                counts={shown.tabCounts}
                active={shown.activeTabKey}
                onSelect={selectTab}
                onMore={setTabSheet}
              />
              <Ledger
                view={view}
                result={shown}
                steps={steps}
                nowMs={nowMs}
                page={page ?? 0}
                onPaging={onPaging}
                selectedRowId={selected}
                onRowPress={openRow}
                onStampPress={onStamp}
              />
            </>
          ) : null}
        </section>
      </div>
      <FooterBar
        metrics={metrics}
        pager={<Pager page={page ?? 0} pageCount={pageCount} onChange={flip} />}
        primary={primary ? { label: actionLabel(primary.action_key), onPress: onPrimary } : null}
      />
      {tabSheet ? (
        <ChoiceSheet
          title={t('more')}
          choices={tabSheet.map((t) => ({ key: t.tab_key, label: t.label }))}
          onPick={(key) => { setTabSheet(null); selectTab(key); }}
          onClose={() => setTabSheet(null)}
        />
      ) : null}
      {flow.element}
      {header.overlays}
    </div>
  );
}

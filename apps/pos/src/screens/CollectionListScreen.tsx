// C3 야간 수거 목록(ui 6-3)과 카운터의 수거 목록(N3). 같은 화면 설정(collection_list)의 등급 판을 그린다:
//   기사 태블릿(1024×520 ~ 1280×720) · 기사 휴대폰(360×640, 품목은 팀 칸 둘째 줄) · 카운터(pos 판, 바탕은 기사 태블릿 판).
// 촘촘한 줄 목록과 쪽 넘김(카드가 아님, 사용자 결정 2026-09-17): 반납 타임 묶음 제목('22:00 반납 · 4 / 8'), 줄 안의 장소 이름표,
// 맨 위 긴급 줄(전화 · 확인), 줄마다 수거 도장 칸 하나(확인 창 → stock.collect, 오프라인이면 전송 대기 점선).
// 줄을 누르면 고르고, 바닥줄 자리에 동작 줄: 설정의 동작(▲ 위로 · ▼ 아래로 · 맨 위로 · 수거 실패 · 전화 · 시간순 정렬)과 '닫기'.
// 어느 동작이 보일지는 설정(ledger_view_actions)과 줄의 능력(conditions), 누를 수 있는지는 줄의 disabledActions(서버)가 정한다.
// 끝 4자리 숫자판은 높이 600px 이상 기사 태블릿에서 오른쪽 판, 그보다 낮거나 휴대폰이면 머리줄 '끝 4자리'로 아래 판.
// 바닥줄: '완료 4 · 전송 대기 0 · 잔여 7 · 차량 재고 …'(카운터는 전송 대기 없음), 쪽 넘김, 주 버튼 하나(기사 보라 '매장 입고 · 14개', 카운터 주황 '인쇄').
// 화면은 규칙을 계산하지 않는다: 순서 · 도장 · 숫자 · 긴급 · 누를 수 있는지는 읽기 모델 그대로이고, 누르면 명령을 보낸다.
import {
  ACTION_LABELS, availableActions, draftToEnvelope, menuFor, openCommandDraft, pickPrimaryAction, resolveLedgerView, stampStepMap, visibleView,
  type ActionKey, type ConfirmCommand, type LedgerCell, type LedgerRow, type LedgerTabRow, type LedgerViewResult, type PinRow, type StampCell,
  type StampStepRow,
} from '@skinote/contract';
import {
  AppHeader, ConnectionStrip, FooterBar, IndexTabs, Keypad, Ledger, Pager, PinBar, REORDER_LOOK, RowActionBar, fillTitle, formatItem, formatTime, t,
  useDeviceProfile, useKeypadPlacement, useServerNow, useUi, type FooterMetric, type LedgerPaging, type PrimaryButtonProps, type RowAction,
} from '@skinote/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { dispatchAction } from '../app/actions.ts';
import { useClient, useConfig, useConnection, useLive, usePointerDown } from '../app/client.tsx';
import { go } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { pressStamp, useConfirmFlow } from '../components/ConfirmFlow.tsx';
import { ChoiceSheet, NoticeDialog, type Choice } from '../components/NoticeDialog.tsx';
import { usePosHeader } from '../components/PosHeader.tsx';
import { VanStockDialog } from '../components/VanStockDialog.tsx';
import { VisitResultDialog } from '../components/VisitResultDialog.tsx';

type Workspace = 'driver' | 'pos';

const tabStorageKey = (workspace: Workspace) => 'skinote.' + workspace + '.collectionTab';
function storedTab(workspace: Workspace): string | null {
  try { return window.localStorage.getItem(tabStorageKey(workspace)); } catch { return null; }
}
function storeTab(workspace: Workspace, tab: string): void {
  try { window.localStorage.setItem(tabStorageKey(workspace), tab); } catch { /* 저장이 막혀도 탭은 돈다 */ }
}

/** 줄의 팀 칸(이름 · 끝 4자리). */
function teamOf(row: LedgerRow): Extract<LedgerCell, { renderer: 'team' }> | null {
  for (const cell of Object.values(row.cells)) if (cell.renderer === 'team') return cell;
  return null;
}
function phoneOf(row: LedgerRow): string | undefined {
  for (const cell of Object.values(row.cells)) if (cell.renderer === 'action' && cell.phone) return cell.phone;
  return undefined;
}

/** 탭을 바꾼 뒤 새 목록에서 고를 것(빨리 확인 줄 · 끝 4자리가 지금 탭에 없을 때). */
type PendingPick = { kind: 'task'; taskId: string } | { kind: 'last4'; last4: string };

type Sheet = { title: string; choices: Choice[]; onPick: (key: string) => void };

interface CollectionScreenParts {
  /** 기사 머리줄(카운터는 PosHeader). */
  header: ReactNode;
  strip: ReactNode;
  /** 제목 · 탭 + 목록(종이 한 장 안). */
  sheet: ReactNode;
  /** 오른쪽 숫자판(기사 태블릿, 높이 600px 이상). */
  sidePad: ReactNode;
  /** 바닥줄 또는 고른 줄의 동작 줄. */
  footer: ReactNode;
  overlays: ReactNode;
}

function useCollectionScreen(workspace: Workspace, date: string | null, externalHold: boolean): CollectionScreenParts {
  const client = useClient();
  const config = useConfig();
  const profile = useDeviceProfile();
  const { timezone } = useUi();
  const driver = workspace === 'driver';
  const placement = useKeypadPlacement();
  const sideKeypad = driver && placement === 'side';

  const [tab, setTab] = useState<string>(() => storedTab(workspace) ?? 'all');
  const [page, setPage] = useState<number | null>(null);
  const [paging, setPaging] = useState<LedgerPaging | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pick, setPick] = useState<PendingPick | null>(null);
  const [digits, setDigits] = useState('');
  const [note, setNote] = useState<string | undefined>(undefined);
  const [findOpen, setFindOpen] = useState(false);
  const [visit, setVisit] = useState<LedgerRow | null>(null);
  const [call, setCall] = useState<{ title: string; phone: string } | null>(null);
  /** 전화 알림 창 제목: '전화 · 김민재 팀'(접수증의 전화 창과 같은 모양). */
  const callTitle = (name: string) => say('noticeTitle', { label: ACTION_LABELS.call, name });
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [vanOpen, setVanOpen] = useState(false);
  const flow = useConfirmFlow();
  const pointer = usePointerDown();
  const hold = externalHold || flow.active || pointer || findOpen || visit !== null || call !== null || sheet !== null || vanOpen;

  const live = useLive<LedgerViewResult>(
    ['collection', workspace, date ?? '', tab, profile.key].join(':'),
    (c) => c.ledgerView('collection_list', { ...(date ? { date } : {}), tabKey: tab, deviceClass: profile.key }),
    hold,
  );
  const result = live.data;
  const connection = useConnection();

  // 날짜 없이 열면(#/collections) 서버의 오늘 영업일 주소로 바꾼다.
  useEffect(() => {
    if (!date && result) go({ name: 'collection', date: result.currentBusinessDate }, { replace: true });
  }, [date, result]);

  const view = useMemo(() => {
    const resolved = config ? resolveLedgerView(config.ledgerViews, 'collection_list', profile.key) : undefined;
    return resolved && config ? visibleView(resolved, config.features) : null;
  }, [config, profile.key]);
  const steps = useMemo(() => (config ? stampStepMap(config.stampSteps, config.features) : new Map<string, StampStepRow>()), [config]);
  const nowMs = useServerNow(result?.serverTime);
  const rows = useMemo(() => result?.rows ?? [], [result]);
  const pins = useMemo(() => result?.pins ?? [], [result]);
  const pinnedTasks = useMemo(() => new Set(pins.map((p) => p.taskId)), [pins]);
  const selectedRow = rows.find((r) => r.id === selected) ?? null;
  const vehicleId = result?.vehicle?.id;
  const vehicleName = result?.vehicle?.label ?? say('vehicle');

  const choose = (row: LedgerRow) => {
    setSelected(row.id);
    setPage(null); // 고른 줄이 있는 쪽으로(Ledger가 처음 여는 쪽을 고른 줄로 정한다).
  };

  const foundNote = (row: LedgerRow) => say('found', { name: teamOf(row)?.name ?? '' });

  const changeTab = (key: string) => {
    // 지금 탭을 다시 눌러도 고르기를 끝낸다(동작 줄이 닫히고 바닥줄이 돌아온다).
    setSelected(null);
    if (key === tab) return;
    setTab(key);
    storeTab(workspace, key);
    setPage(null);
  };

  // 탭을 바꾼 뒤 온 새 목록에서 고른다.
  useEffect(() => {
    if (!pick || !result || result.activeTabKey !== tab) return;
    setPick(null);
    const hit = pick.kind === 'task' ? rows.find((r) => r.taskId === pick.taskId) : rows.find((r) => teamOf(r)?.last4 === pick.last4);
    if (hit) {
      choose(hit);
      if (pick.kind === 'last4') { setFindOpen(false); setNote(foundNote(hit)); }
    } else if (pick.kind === 'last4') {
      setNote(say('notInList', { last4: pick.last4 }));
    }
    // choose · foundNote는 상태만 바꾼다(의존에 넣지 않음).
  }, [pick, result, tab, rows]);

  const selectTask = (taskId: string) => {
    const hit = rows.find((r) => r.taskId === taskId);
    if (hit) choose(hit);
    else if (tab !== 'all') { changeTab('all'); setPick({ kind: 'task', taskId }); }
  };

  /** 끝 4자리(N10): 그 팀 줄로 가서 고른다. 지금 탭에 없으면 전체 탭에서 찾는다. */
  const find = (last4: string) => {
    setDigits('');
    const hit = rows.find((r) => teamOf(r)?.last4 === last4);
    if (hit) {
      choose(hit);
      setFindOpen(false);
      setNote(foundNote(hit));
      return;
    }
    if (tab !== 'all') {
      changeTab('all');
      setPick({ kind: 'last4', last4 });
      return;
    }
    setNote(say('notInList', { last4 }));
  };

  /** 확인 창이 필요 없는 명령(순서 · 확인 · 방문 결과): 목록의 basis로 보내고, 안 되면 한 문장. */
  const send = (command: ConfirmCommand, title: string): Promise<void> => {
    if (!result) return Promise.resolve();
    return client.command(draftToEnvelope(openCommandDraft(command, result.basis))).then((outcome) => {
      if (outcome.outcome === 'applied' || outcome.outcome === 'partially_applied' || outcome.outcome === 'queued') return;
      flow.notify({ title, lines: [outcome.error?.message ?? say('commandFailed')] });
    }, () => {
      flow.notify({ title, lines: [say('sendFailed')] });
    });
  };

  const callRow = (row: LedgerRow) => {
    const team = teamOf(row);
    const phone = phoneOf(row);
    if (phone) setCall({ title: callTitle(team?.name ?? ''), phone });
  };

  /** 줄의 동작: 종류로 가르고(app/actions.ts), 자기 창이 따로 있는 것만 여기서. */
  const rowDispatch = (row: LedgerRow, key: ActionKey) => {
    dispatchAction(key, {
      flow,
      target: { ...(row.orderId ? { orderId: row.orderId } : {}), ...(row.taskId ? { taskId: row.taskId } : {}), ...(vehicleId ? { vehicleId } : {}) },
      own: {
        not_collected: () => setVisit(row),
        call: () => callRow(row),
        move_up: () => move(row, 'up'),
        move_down: () => move(row, 'down'),
        move_top: () => move(row, 'top'),
      },
    });
  };

  const onStamp = (row: LedgerRow, _column: string, cell: StampCell) => {
    if (!row.orderId) return;
    const teamName = teamOf(row)?.name;
    const target = { orderId: row.orderId, ...(row.taskId ? { taskId: row.taskId } : {}), ...(teamName ? { teamName } : {}) };
    pressStamp(flow, steps, timezone, target, cell, (key) => rowDispatch(row, key));
  };

  const toggleRow = (row: LedgerRow) => {
    setSelected((current) => (current === row.id ? null : row.id));
  };

  /** 방문 순서(▲ · ▼ · 맨 위로): 기준 업무는 보이는 목록에서 같은 반납 타임 · 고정되지 않은 이웃. 할 수 있는지는 서버가 정했다. */
  function move(row: LedgerRow, where: 'up' | 'down' | 'top') {
    if (!row.taskId) return;
    const group = rows.filter((r) => r.groupKey === row.groupKey && !pinnedTasks.has(r.taskId ?? ''));
    const at = group.findIndex((r) => r.id === row.id);
    const anchor = where === 'up' ? group[at - 1] : where === 'down' ? group[at + 1] : group[0];
    if (!anchor?.taskId || anchor.taskId === row.taskId) return;
    const position = where === 'down' ? 'after' : where === 'top' ? 'top' : 'before';
    void send({ type: 'route.move', payload: { taskId: row.taskId, anchorTaskId: anchor.taskId, position } }, ACTION_LABELS.move_top).then(() => setPage(null));
  }

  // 고른 줄의 동작 줄: 설정의 동작(순서 동작 포함)을 줄의 능력으로 거르고, 누를 수 없는 것은 서버가 준 까닭과 함께 회색.
  const rowActions: RowAction[] = view && selectedRow
    ? availableActions(view.actions, selectedRow.conditions ?? []).map((a) => {
        const look = REORDER_LOOK[a.action_key];
        const off = selectedRow.disabledActions?.find((d) => d.actionKey === a.action_key);
        return {
          key: a.action_key,
          label: look?.word ?? ACTION_LABELS[a.action_key],
          priority: a.priority,
          ...(look?.glyph ? { glyph: look.glyph, repeat: true } : {}),
          ...(a.action_key === 'call' ? { icon: 'phone' as const } : {}),
          ...(off ? { disabled: true, reason: off.reason } : {}),
        };
      })
    : [];

  // 주 버튼 하나: 기사 '매장 입고 · 14개'(연결이 필요), 카운터 '인쇄'. 이름은 동작 이름(sys_actions)과 서버가 준 수.
  const primaryRow = view && result ? pickPrimaryAction(view.primary_actions, result.activeConditions) : null;
  const count = result?.primaryFigure?.count ?? 0;
  const primary: PrimaryButtonProps | null = primaryRow ? (() => {
    const key = primaryRow.action_key;
    const name = ACTION_LABELS[key];
    const target = vehicleId ? { vehicleId } : {};
    if (key === 'receive_to_shop') {
      const alts = count > 0 ? [say('withCount', { name, n: count }), say('receiveShort', { n: count }), name, say('receiveShortName')] : [name, say('receiveShortName')];
      return {
        label: alts[0],
        alts,
        // 차에 받은 것이 없으면 누를 일이 없다(회색).
        disabled: count === 0,
        onPress: () => {
          // 매장 입고는 연결이 있어야 한다(sync 8-4): 끊겼으면 창을 열지 않고 한 문장.
          if (!connection.online) flow.notify({ title: name, lines: [say('receiveNeedsLink')] });
          else dispatchAction(key, { flow, target });
        },
      };
    }
    return { label: name, onPress: () => dispatchAction(key, { flow, target }) };
  })() : null;

  const metrics: FooterMetric[] = view && result
    ? view.metrics.flatMap((row) => {
        const value = result.metrics.find((m) => m.metricKey === row.metric_key);
        return value ? [{ row, value }] : [];
      })
    : [];

  const pageCount = paging?.pageCount ?? 1;
  const shownPage = Math.min(Math.max(0, page ?? paging?.initialPage ?? 0), pageCount - 1);

  const pinText = (pin: PinRow) => [t('pinTitle') + ' · ' + formatTime(pin.at, timezone), ...pin.parts.map((p) => p.text)].join(' · ');
  const ack = (pin: PinRow) => { void send({ type: 'notification.ack', payload: { notificationId: pin.pinId } }, t('pinTitle')); };
  const pin = pins[0];
  const pinSlot = pin ? (
    <PinBar
      pin={pin}
      moreCount={pins.length - 1}
      onOpen={(p) => selectTask(p.taskId)}
      onCall={(p) => {
        if (!p.phone) return;
        // 목록에 그 줄이 있으면 팀 이름으로('전화 · 오승민 팀'), 없으면(다른 탭) 긴급 줄의 이름 · 끝 4자리로.
        const hit = rows.find((r) => r.taskId === p.taskId);
        const name = hit ? teamOf(hit)?.name : undefined;
        setCall({ title: name ? callTitle(name) : ACTION_LABELS.call + ' · ' + (p.parts.find((x) => x.drop === 0)?.text ?? ''), phone: p.phone });
      }}
      {...(driver ? { onAck: ack } : {})}
      compact={profile.key === 'driver_phone'}
      onMore={() => setSheet({
        title: t('pinTitle'),
        choices: pins.map((p) => ({
          key: p.taskId,
          label: p.parts.filter((x) => x.drop === 0).map((x) => x.text).join(' · '),
          note: [formatTime(p.at, timezone), ...p.parts.filter((x) => x.drop !== 0).map((x) => x.text)].join(' · '),
        })),
        onPick: (taskId) => { setSheet(null); selectTask(taskId); },
      })}
    />
  ) : undefined;

  const sheetBody = view && result ? (
    <>
      <IndexTabs
        title={fillTitle(view.label, result.titleValues)}
        tabs={view.tabs}
        counts={result.tabCounts}
        active={result.activeTabKey}
        onSelect={changeTab}
        onMore={(tabs: LedgerTabRow[]) => setSheet({ title: t('more'), choices: tabs.map((x) => ({ key: x.tab_key, label: x.label })), onPick: (key) => { setSheet(null); changeTab(key); } })}
      />
      <Ledger
        view={view}
        result={result}
        steps={steps}
        nowMs={nowMs}
        page={shownPage}
        onPaging={setPaging}
        selectedRowId={selected}
        {...(pinSlot ? { pinSlot } : {})}
        onRowPress={toggleRow}
        onStampPress={onStamp}
        onActionPress={(row) => callRow(row)}
      />
    </>
  ) : !result && live.error ? <p className="pos-sheet-note" role="status">{say('listUnreadable')}</p> : null;

  const footer = selectedRow ? (
    <RowActionBar actions={rowActions} onAction={(key) => rowDispatch(selectedRow, key)} onClose={() => setSelected(null)} />
  ) : (
    <FooterBar metrics={metrics} pager={<Pager page={shownPage} pageCount={pageCount} onChange={setPage} />} primary={primary} />
  );

  const load = result?.vehicleLoad;
  const keypadProps = {
    value: digits,
    onChange: (value: string) => { setDigits(value); setNote(undefined); },
    onSubmit: find,
  };
  const sidePad = sideKeypad ? (
    <Keypad
      {...keypadProps}
      placement="side"
      {...(note ? { note } : connection.online && load ? { loadSummary: { label: say('onVan'), items: load.items.length ? load.items.map(formatItem) : [t('none')] } } : {})}
    />
  ) : null;

  const menu = useMemo(() => (config && driver ? menuFor(config.menuEntries, 'driver', profile.key, config.features, null) : []), [config, driver, profile.key]);
  const waitingPins = pins.filter((p) => p.status === 'requested');
  const openDriverMenu = (key: string) => {
    if (key === 'van_stock') setVanOpen(true);
    else flow.notify({ title: menu.find((m) => m.key === key)?.label ?? '', lines: [say('screenSoon')] });
  };
  const exit = () => go({ name: 'exit', from: 'driver' }, { state: { fromDriver: true } });
  const header = driver ? (
    <AppHeader
      shopName={config?.shopName ?? ''}
      vehicleLabel={vehicleName}
      menu={menu}
      alertCount={waitingPins.length}
      {...(sideKeypad ? {} : { onFind: () => { setDigits(''); setNote(undefined); setFindOpen(true); } })}
      onMenu={(entry) => openDriverMenu(entry.key)}
      onMore={(more) => setSheet({
        title: more.vehicleLabel ? t('more') + ' · ' + more.vehicleLabel : t('more'),
        choices: [...more.entries.map((e) => ({ key: e.key, label: e.label })), ...(more.includesExit ? [{ key: '__exit', label: t('exit'), icon: 'exit' as const }] : [])],
        onPick: (key) => { setSheet(null); if (key === '__exit') exit(); else openDriverMenu(key); },
      })}
      onAlerts={() => flow.notify({ title: t('alerts'), lines: waitingPins.length ? waitingPins.map(pinText) : [say('noAlerts')] })}
      onExit={exit}
    />
  ) : null;

  const strip = driver ? (
    <ConnectionStrip online={connection.online} pendingCount={connection.pendingCount} {...(connection.lastSyncAt ? { lastSyncAt: connection.lastSyncAt } : {})} />
  ) : null;

  const visitTeam = visit ? teamOf(visit) : null;
  const overlays = (
    <>
      {driver && !sideKeypad && findOpen ? (
        <Keypad {...keypadProps} placement="sheet" open onClose={() => setFindOpen(false)} {...(note ? { note } : {})} />
      ) : null}
      {sheet ? <ChoiceSheet title={sheet.title} choices={sheet.choices} onPick={sheet.onPick} onClose={() => setSheet(null)} /> : null}
      {visit && visit.taskId && result ? (
        <VisitResultDialog
          taskId={visit.taskId}
          teamName={visitTeam?.name ?? ''}
          last4={visitTeam?.last4 ?? ''}
          today={result.currentBusinessDate}
          nowMs={nowMs}
          reasons={result.visitReasons ?? []}
          slotTimes={result.groups.flatMap((g) => (g.at ? [formatTime(g.at, timezone)] : []))}
          onSubmit={(payload) => { setVisit(null); setSelected(null); void send({ type: 'task.visit', payload }, ACTION_LABELS.not_collected); }}
          onClose={() => setVisit(null)}
        />
      ) : null}
      {call ? (
        <NoticeDialog title={call.title} lines={[call.phone, say('demoNoCall')]} onClose={() => setCall(null)} />
      ) : null}
      {vanOpen && load ? <VanStockDialog load={load} onClose={() => setVanOpen(false)} /> : null}
      {flow.element}
    </>
  );

  return { header, strip, sheet: sheetBody, sidePad, footer, overlays };
}

/** 기사 태블릿 · 휴대폰의 오늘 야간 수거 목록(#/driver/:date). */
export function DriverListScreen({ date }: { date: string }) {
  const parts = useCollectionScreen('driver', date, false);
  return (
    <div className="sn-screen">
      {parts.header}
      {parts.strip}
      <div className="sn-desk">
        <section className="sn-sheet">{parts.sheet}</section>
        {parts.sidePad}
      </div>
      {parts.footer}
      {parts.overlays}
    </div>
  );
}

/** 카운터의 수거 목록(#/collections/:date, N3): 같은 설정의 pos 판. 순서 바꾸기 · 빨리 확인 · 접수증 · 전화. */
export function PosCollectionScreen({ date }: { date: string | null }) {
  const header = usePosHeader('collection', 'collection_list');
  const parts = useCollectionScreen('pos', date, header.active);
  return (
    <div className="sn-screen">
      {header.element}
      <div className="sn-desk">
        <section className="sn-sheet">{parts.sheet}</section>
      </div>
      {parts.footer}
      {parts.overlays}
      {header.overlays}
    </div>
  );
}

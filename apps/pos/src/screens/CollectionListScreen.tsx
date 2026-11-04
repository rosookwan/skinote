// C3 야간 수거 목록(ui 6-3)과 카운터의 수거 목록(N3). 같은 화면 설정(collection_list)의 등급 판을 그린다:
//   기사 태블릿(1024×520 ~ 1280×720) · 기사 휴대폰(360×640, 품목은 팀 칸 둘째 줄) · 카운터(pos 판, 바탕은 기사 태블릿 판).
// 촘촘한 줄 목록과 쪽 넘김(카드가 아님, 사용자 결정 2026-09-17): 반납 타임 묶음 제목('22:00 반납 · 4 / 8'), 줄 안의 장소 이름표,
// 맨 위 긴급 줄(전화 · 확인), 줄마다 수거 도장 칸 하나(확인 창 → stock.collect, 오프라인이면 전송 대기 점선).
// 줄을 누르면 고르고, 바닥줄 자리에 동작 줄: 설정의 동작(▲ 위로 · ▼ 아래로 · 맨 위로 · 수거 실패 · 전화 · 시간순 정렬)과 '닫기'.
// 어느 동작이 보일지는 설정(ledger_view_actions)과 줄의 능력(conditions), 누를 수 있는지는 줄의 disabledActions(서버)가 정한다.
// 끝 4자리 숫자판은 높이 600px 이상 기사 태블릿에서 오른쪽 판, 그보다 낮거나 휴대폰이면 머리줄 '끝 4자리'로 아래 판.
// 바닥줄: '완료 4 · 전송 대기 0 · 잔여 7 · 차량 재고 …'(카운터는 보냄 대기가 없어 전송 대기 없음), 쪽 넘김,
// 주 버튼 하나(기사 보라 '매장 입고 · 14개', 카운터 주황 '인쇄').
// 화면은 규칙을 계산하지 않는다: 순서 · 도장 · 숫자 · 긴급 · 누를 수 있는지는 읽기 모델 그대로이고, 누르면 명령을 보낸다.
// 기사의 배달 목록(delivery_list, ui 6-5, #/driver/:date/deliveries)도 같은 틀이다: 배달 시각 묶음, 배달 도장(적재 → 배달), 줄의 팀 칸을
// 누르면 줄 고르기 대신 업무 판(V7, plan §8 D2)을 열고, 끝 4자리로 찾은 팀도 업무 판으로 간다. 머리줄 메뉴 `배달 목록` · `수거 목록`은
// 지금 목록이 아닌 쪽만 보인다(plan §8 D4).
import {
  ACTION_LABELS, availableActions, draftToEnvelope, isAccepted, menuFor, openCommandDraft, pickPrimaryAction, resolveLedgerView, stampStepMap, visibleView,
  type ActionKey, type ConfirmCommand, type ConnectionState, type LedgerCell, type LedgerRow, type LedgerTabRow, type LedgerViewResult, type MenuEntryRow,
  type PendingCommand, type PinRow, type StampCell, type StampStepRow,
} from '@skinote/contract';
import {
  AppHeader, ConnectionStrip, FooterBar, IndexTabs, Keypad, Ledger, Pager, REORDER_LOOK, RowActionBar, connectionStripVisible, fillTitle, formatItem, formatTime, t,
  useDeviceProfile, useKeypadPlacement, useServerNow, useUi, type FooterMetric, type LedgerPaging, type PrimaryButtonProps, type RowAction,
} from '@skinote/ui';
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { dispatchAction } from '../app/actions.ts';
import { useClient, useConfig, useConnection, useLive, usePointerDown } from '../app/client.tsx';
import { figureText } from '../app/labels.ts';
import { go, navState, patchNavState, type DeviceShape } from '../app/router.ts';
import { elsewhereLine, useSession } from '../app/session-context.ts';
import { say } from '../app/strings.ts';
import { pressStamp, useConfirmFlow } from '../components/ConfirmFlow.tsx';
import { ChoiceSheet, type Choice } from '../components/NoticeDialog.tsx';
import { usePosHeader } from '../components/PosHeader.tsx';
import { VanStockDialog } from '../components/VanStockDialog.tsx';
import { VisitResultDialog } from '../components/VisitResultDialog.tsx';
import { CallDialog } from '../components/CallDialog.tsx';
import { UrgentListDialog } from '../components/UrgentListDialog.tsx';
import { UrgentBar, urgentUnconfirmed } from '../components/UrgentBar.tsx';

// 카운터의 A4 인쇄(features-1 §8-3): 처음 누를 때 받는다(첫 화면 묶음을 작게).
const loadPrint = () => import('../components/PrintHost.tsx');
const PrintHost = lazy(() => loadPrint().then((m) => ({ default: m.PrintHost })));
// 전송 대기 목록 창(§17 R3-19)도 처음 열 때 받는다(서비스 워커가 미리 받아 두므로 끊긴 채로도 열린다).
const PendingListDialog = lazy(() => import('../components/PendingListDialog.tsx').then((m) => ({ default: m.PendingListDialog })));

type Workspace = 'driver' | 'pos';

/** 기사 목록의 화면 설정 키: 야간 수거 목록 · 배달 목록(같은 틀, 같은 메뉴 키). */
export type DriverListKey = 'collection_list' | 'delivery_list';

const tabStorageKey = (workspace: Workspace, viewKey: DriverListKey) => 'skinote.' + workspace + (viewKey === 'delivery_list' ? '.deliveryTab' : '.collectionTab');
function storedTab(workspace: Workspace, viewKey: DriverListKey): string | null {
  try { return window.localStorage.getItem(tabStorageKey(workspace, viewKey)); } catch { return null; }
}
function storeTab(workspace: Workspace, viewKey: DriverListKey, tab: string): void {
  try { window.localStorage.setItem(tabStorageKey(workspace, viewKey), tab); } catch { /* 저장이 막혀도 탭은 돈다 */ }
}

/** 머리줄의 `전송 대기` 자리(설정 메뉴가 아니라 이 기기의 상태, 나가기처럼 코드가 더한다: work/impl-offline/plan.md §17 R3-19). */
export const PENDING_MENU_KEY = '__pending';

/**
 * 이 기기에 서버의 답을 받지 않은 기록이 있으면 머리줄 메뉴 끝에 `전송 대기`(수는 메뉴 버튼 안의 수, 좁으면 더 보기 안 `전송 대기 3`). 우선순위가 가장
 * 낮아 좁은 머리줄(휴대폰 · 메뉴 두 칸인 태블릿)에서는 먼저 더 보기로 간다. 보냄 대기가 없는 기기(서버에 붙은 기기)는 없음. 순수 함수(시험).
 */
export function pendingMenu(connection: Pick<ConnectionState, 'pendingCount' | 'sendQueue'>): { entry: MenuEntryRow; count: number } | null {
  if (connection.sendQueue === false || connection.pendingCount <= 0) return null;
  return {
    entry: {
      workspace_key: 'driver', key: PENDING_MENU_KEY, label: t('pendingStamp'), short_label: null, screen_key: 'driver_list', seq: 1000, priority: 0,
      overflow_key: 'more_sheet', feature_key: null, feature_on: 1, permission_key: null, device_class_key: null, pinned_end: 0,
    },
    count: connection.pendingCount,
  };
}

/**
 * 기사 머리줄 메뉴의 목록 행(화면 driver_list)이 여는 경로: 메뉴 키 = 목록의 화면 설정 키. 지금 목록은 메뉴에서 빠진다.
 * 없는 키면 null(부르는 쪽이 `준비 중인 화면`).
 */
export function driverListRoute(menuKey: string, date: string, device: DeviceShape): { name: 'driver' | 'deliveries'; date: string; device: DeviceShape } | null {
  if (menuKey === 'collection_list') return { name: 'driver', date, device };
  if (menuKey === 'delivery_list') return { name: 'deliveries', date, device };
  return null;
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

function useCollectionScreen(
  workspace: Workspace, viewKey: DriverListKey, date: string | null, externalHold: boolean, device: DeviceShape = 'tablet', listVehicle?: string,
): CollectionScreenParts {
  const client = useClient();
  const config = useConfig();
  const profile = useDeviceProfile();
  const { timezone } = useUi();
  const driver = workspace === 'driver';
  const deliveries = viewKey === 'delivery_list';
  const placement = useKeypadPlacement();
  const sideKeypad = driver && placement === 'side';
  // 업무 판에서 돌아왔으면 그 쪽 · 그 줄(배달 목록, N9).
  const restored = useMemo(() => (deliveries ? navState().list ?? null : null), []);

  const [tab, setTab] = useState<string>(() => storedTab(workspace, viewKey) ?? 'all');
  const [page, setPage] = useState<number | null>(restored?.page ?? null);
  const [paging, setPaging] = useState<LedgerPaging | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pick, setPick] = useState<PendingPick | null>(null);
  const [digits, setDigits] = useState('');
  const [note, setNote] = useState<string | undefined>(undefined);
  const [findOpen, setFindOpen] = useState(false);
  const [visit, setVisit] = useState<LedgerRow | null>(null);
  /** 전화 창(features-1 §8-4): 온전한 번호는 창이 phoneReveal로 받는다. */
  const [call, setCall] = useState<{ title: string; orderId: string } | null>(null);
  /** 카운터의 A4 인쇄(features-1 §8-3). */
  const [printing, setPrinting] = useState(false);
  /** 전화 알림 창 제목: '전화 · 김민재 팀'(접수증의 전화 창과 같은 모양). */
  const callTitle = (name: string) => say('noticeTitle', { label: ACTION_LABELS.call, name });
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [vanOpen, setVanOpen] = useState(false);
  /** 전송 대기 목록 창(§17 R3-19): 연 동안 기기의 목록(pending())을 읽는다. */
  const [pendingOpen, setPendingOpen] = useState(false);
  const [urgentOpen, setUrgentOpen] = useState(false);
  const [pendingItems, setPendingItems] = useState<readonly PendingCommand[] | null>(null);
  const flow = useConfirmFlow();
  const pointer = usePointerDown();
  const hold = externalHold || flow.active || pointer || findOpen || visit !== null || call !== null || sheet !== null || vanOpen || printing || pendingOpen;

  const live = useLive<LedgerViewResult>(
    [viewKey, workspace, date ?? '', tab, profile.key, listVehicle ?? ''].join(':'),
    (c) => c.ledgerView(viewKey, { ...(date ? { date } : {}), tabKey: tab, deviceClass: profile.key, ...(listVehicle ? { vehicleId: listVehicle } : {}) }),
    hold,
  );
  const result = live.data;
  const connection = useConnection();
  // 전송 대기 목록 창이 열린 동안 보내기가 이어지면(수가 바뀌면) 다시 읽는다. 다 보내 비면 창에 `전송 대기 0`(닫기로 나간다).
  useEffect(() => {
    if (!pendingOpen) return undefined;
    let alive = true;
    void client.pending().then((items) => { if (alive) setPendingItems(items); }, () => {});
    return () => { alive = false; };
  }, [pendingOpen, client, connection.pendingCount, connection.unconfirmedCount]);
  // 로그인 때 같은 차량의 다른 기기가 보낼 기록을 가졌으면 한 번 알린다(`1호 차량 휴대폰 미전송 기록 가능 · 휴대폰 전송 필요`, sync 6).
  const session = useSession();
  const elsewhere = driver ? session?.elsewhere : undefined;
  const vanLabel = result?.vehicle?.label;
  useEffect(() => {
    if (!elsewhere || !vanLabel) return;
    flow.notify({ title: t('alerts'), lines: [elsewhereLine(elsewhere, vanLabel)] });
    session?.dismissElsewhere?.();
  }, [elsewhere, vanLabel]);
  // 카운터의 인쇄 묶음은 목록을 연 뒤 미리 받아 둔다(누르면 곧바로 인쇄 창).
  useEffect(() => { if (!driver) void loadPrint().catch(() => undefined); }, [driver]);

  // 날짜 없이 열면(#/collections) 서버의 오늘 영업일 주소로 바꾼다.
  useEffect(() => {
    if (!date && result) go({ name: 'collection', date: result.currentBusinessDate, ...(listVehicle ? { vehicleId: listVehicle } : {}) }, { replace: true });
  }, [date, result]);

  const view = useMemo(() => {
    const resolved = config ? resolveLedgerView(config.ledgerViews, viewKey, profile.key) : undefined;
    return resolved && config ? visibleView(resolved, config.features) : null;
  }, [config, profile.key, viewKey]);
  const steps = useMemo(() => (config ? stampStepMap(config.stampSteps, config.features) : new Map<string, StampStepRow>()), [config]);
  const nowMs = useServerNow(result?.serverTime);
  const rows = useMemo(() => result?.rows ?? [], [result]);
  const pins = useMemo(() => result?.pins ?? [], [result]);
  const pinnedTasks = useMemo(() => new Set(pins.map((p) => p.taskId)), [pins]);
  const selectedRow = rows.find((r) => r.id === selected) ?? null;
  const vehicleId = result?.vehicle?.id;
  const vehicleName = result?.vehicle?.label ?? say('vehicle');

  /** 배달 목록: 줄의 팀 칸 · 끝 4자리로 찾은 팀 → 업무 판(V7). 돌아올 쪽 · 줄을 기록에 남긴다. */
  const openTask = (row: LedgerRow) => {
    if (!row.taskId) return;
    patchNavState({ list: { page: shownPage, selected: row.id } });
    go({ name: 'task', taskId: row.taskId, device }, { state: { fromList: true } });
  };

  const choose = (row: LedgerRow) => {
    if (deliveries) { openTask(row); return; }
    setSelected(row.id);
    setPage(null); // 고른 줄이 있는 쪽으로(Ledger가 처음 여는 쪽을 고른 줄로 정한다).
  };

  const foundNote = (row: LedgerRow) => say('found', { name: teamOf(row)?.name ?? '' });

  const changeTab = (key: string) => {
    // 지금 탭을 다시 눌러도 고르기를 끝낸다(동작 줄이 닫히고 바닥줄이 돌아온다).
    setSelected(null);
    if (key === tab) return;
    setTab(key);
    storeTab(workspace, viewKey, key);
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
      if (isAccepted(outcome)) return;
      flow.notify({ title, lines: [outcome.error?.message ?? say('commandFailed')] });
    }, () => {
      flow.notify({ title, lines: [say('sendFailed')] });
    });
  };

  const callRow = (row: LedgerRow) => {
    const team = teamOf(row);
    if (phoneOf(row) && row.orderId) setCall({ title: callTitle(team?.name ?? ''), orderId: row.orderId });
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
    if (deliveries) { openTask(row); return; }
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
  // 차량 재고의 수(개 + 권 매, 서버가 센 것). 확인 창의 '매장 입고 · 6개 · 1매'와 같은 셈.
  const figure = figureText(result?.primaryFigure);
  const primary: PrimaryButtonProps | null = primaryRow ? (() => {
    const key = primaryRow.action_key;
    const name = ACTION_LABELS[key];
    const target = vehicleId ? { vehicleId } : {};
    if (key === 'receive_to_shop') {
      const full = figure ? name + ' · ' + figure : null;
      const counted = count > 0 ? [say('withCount', { name, n: count }), say('receiveShort', { n: count })] : [];
      const alts = [...(full && full !== counted[0] ? [full] : []), ...counted, name, say('receiveShortName')];
      return {
        label: alts[0]!,
        alts,
        // 차에 받은 것이 없으면 누를 일이 없다(회색).
        disabled: !figure,
        onPress: () => {
          // 매장 입고는 연결이 있어야 한다(sync 8-4): 끊겼으면 창을 열지 않고 한 문장.
          if (!connection.online) flow.notify({ title: name, lines: [say('receiveNeedsLink')] });
          else dispatchAction(key, { flow, target });
        },
      };
    }
    // 다음 할 업무(배달 목록: 아직 건네지 않은 첫 배달의 `배달 처리 · 6개`): 읽기 모델의 nextTask 동작을 그 업무로 연다.
    const task = result?.nextTask;
    if (key === 'next_step' && task) {
      return {
        label: task.label,
        alts: task.alts,
        disabled: !task.enabled,
        onPress: () => { if (task.taskId) dispatchAction(task.actionKey, { flow, target: { ...target, taskId: task.taskId } }); },
      };
    }
    // 카운터의 `인쇄`(features-1 §8-3): 이 날 · 차량의 A4 수거 목록을 브라우저 인쇄 창으로.
    if (key === 'print') return { label: name, onPress: () => setPrinting(true) };
    return { label: name, onPress: () => dispatchAction(key, { flow, target }) };
  })() : null;

  // 보냄 대기가 없는 기기(서버에 붙은 기기)는 `전송 대기` 숫자를 그리지 않는다(늘 0이라 뜻이 없다).
  const noQueue = connection.sendQueue === false;
  const metrics: FooterMetric[] = view && result
    ? view.metrics.flatMap((row) => {
        if (noQueue && row.metric_key === 'pending_count') return [];
        const value = result.metrics.find((m) => m.metricKey === row.metric_key);
        return value ? [{ row, value }] : [];
      })
    : [];

  const pageCount = paging?.pageCount ?? 1;
  const shownPage = Math.min(Math.max(0, page ?? paging?.initialPage ?? 0), pageCount - 1);

  const pinSlot = pins.length ? <UrgentBar pins={pins} onOpen={() => setUrgentOpen(true)} /> : undefined;

  // 기사 목록: 연결 띠 자리를 늘 비워 두고 쪽을 센다(ui 4-3, §18 R4-12). 띠가 보이면 띠가 그 자리를 쓴다: 띠가 나고 들어도 쪽의 줄이 옮겨 가지 않는다.
  const reserveStrip = driver && !connectionStripVisible(connection);
  // 카운터: 이 차량의 기사 기기가 끊겼거나 기록을 보내지 못하면 제목 줄의 노랑 표시(`1호 차량 연결 끊김 · 21:40부터`, 서버의 차량 연결 · 읽기 모델 link).
  const sheetBody = view && result ? (
    <>
      <IndexTabs
        title={fillTitle(view.label, result.titleValues)}
        tabs={view.tabs}
        counts={result.tabCounts}
        active={result.activeTabKey}
        {...(result.link ? { chip: result.link.parts } : {})}
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
        selectedRowId={deliveries ? restored?.selected ?? null : selected}
        {...(pinSlot ? { pinSlot } : {})}
        {...(reserveStrip ? { reservePx: profile.connectionStripPx } : {})}
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

  // 지금 목록은 메뉴에서 뺀다(배달 목록에서는 `수거 목록`, 수거 목록에서는 `배달 목록`).
  const menu = useMemo(
    () => (config && driver ? menuFor(config.menuEntries, 'driver', profile.key, config.features, null).filter((m) => m.key !== viewKey) : []),
    [config, driver, profile.key, viewKey],
  );
  const waitingPins = urgentUnconfirmed(pins);
  const pendingEntry = driver ? pendingMenu(connection) : null;
  const headerMenu = pendingEntry ? [...menu, pendingEntry.entry] : menu;
  const openDriverMenu = (key: string) => {
    const listRoute = date ? driverListRoute(key, date, device) : null;
    if (key === PENDING_MENU_KEY) setPendingOpen(true);
    else if (key === 'van_stock') setVanOpen(true);
    else if (listRoute) go(listRoute);
    else flow.notify({ title: menu.find((m) => m.key === key)?.label ?? '', lines: [say('screenSoon')] });
  };
  const exit = () => go({ name: 'exit', from: 'driver' }, { state: { fromDriver: true } });
  const header = driver ? (
    <AppHeader
      shopName={config?.shopName ?? ''}
      vehicleLabel={vehicleName}
      menu={headerMenu}
      {...(pendingEntry ? { menuCounts: { [PENDING_MENU_KEY]: pendingEntry.count } } : {})}
      alertCount={waitingPins}
      {...(sideKeypad ? {} : { onFind: () => { setDigits(''); setNote(undefined); setFindOpen(true); } })}
      onMenu={(entry) => openDriverMenu(entry.key)}
      onMore={(more) => setSheet({
        title: more.vehicleLabel ? t('more') + ' · ' + more.vehicleLabel : t('more'),
        choices: [
          // 더 보기 안의 `전송 대기`는 수와 함께(`전송 대기 3`: 띠와 같은 말).
          ...more.entries.map((e) => ({ key: e.key, label: e.key === PENDING_MENU_KEY && pendingEntry ? t('pendingCount', { n: pendingEntry.count }) : e.label })),
          ...(more.includesExit ? [{ key: '__exit', label: t('exit'), icon: 'exit' as const }] : []),
        ],
        onPick: (key) => { setSheet(null); if (key === '__exit') exit(); else openDriverMenu(key); },
      })}
      onAlerts={() => setUrgentOpen(true)}
      onExit={exit}
    />
  ) : null;

  // 연결 띠(기사 기기): 끊김 · 보내는 중 · 남은 대기 · 보낸 뒤 결과 · 저장할 곳 없음(work/impl-offline/plan.md §8-1).
  const strip = driver ? <ConnectionStrip {...connection} /> : null;

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
      {call ? <CallDialog orderId={call.orderId} fallbackTitle={call.title} onClose={() => setCall(null)} /> : null}
      {printing ? (
        <Suspense fallback={null}>
          <PrintHost
            job={{ kind: 'collection', date: result?.titleValues.date ?? date, vehicleId: vehicleId ?? null }}
            onDone={() => setPrinting(false)}
            onFail={(line) => { setPrinting(false); flow.notify({ title: ACTION_LABELS.print, lines: [line] }); }}
          />
        </Suspense>
      ) : null}
      {urgentOpen && result ? <UrgentListDialog pins={pins} basis={result.basis} driver={driver} onClose={() => setUrgentOpen(false)} onOpen={(pin) => { setUrgentOpen(false); if (driver) go({name:'task',taskId:pin.taskId,device}); else if (pin.orderId) go({name:'slip',orderId:pin.orderId}); }} /> : null}
      {vanOpen && load ? <VanStockDialog load={load} onClose={() => setVanOpen(false)} /> : null}
      {pendingOpen && pendingItems ? (
        <Suspense fallback={null}>
          <PendingListDialog items={pendingItems} onClose={() => { setPendingOpen(false); setPendingItems(null); }} />
        </Suspense>
      ) : null}
      {flow.element}
    </>
  );

  return { header, strip, sheet: sheetBody, sidePad, footer, overlays };
}

/** 기사 태블릿 · 휴대폰의 오늘 야간 수거 목록(#/driver/:date). */
export function DriverListScreen({ date, device = 'tablet' }: { date: string; device?: DeviceShape }) {
  const parts = useCollectionScreen('driver', 'collection_list', date, false, device);
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

/** 기사 태블릿 · 휴대폰의 오늘 배달 목록(#/driver/:date/deliveries, ui 6-5). 줄의 팀 칸 → 업무 판(V7). */
export function DeliveryListScreen({ date, device = 'tablet' }: { date: string; device?: DeviceShape }) {
  const parts = useCollectionScreen('driver', 'delivery_list', date, false, device);
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
export function PosCollectionScreen({ date, vehicleId }: { date: string | null; vehicleId?: string }) {
  const header = usePosHeader('collection', 'collection_list', undefined, { urgent: false });
  const parts = useCollectionScreen('pos', 'collection_list', date, header.active, 'tablet', vehicleId);
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

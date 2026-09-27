// C2 대여 접수증 + B2 남은 일 목록(ui 6-2): 왼쪽은 손으로 쓰던 접수증(칸 한 줄 · 품목 표와 도장 · 약속 요약 · 돈 줄),
// 오른쪽 판은 남은 일 목록과 주황 큰 버튼 하나(늘 '다음 할 일'), 그 아래 옆 동작(ledger_view_actions, 등급 칸 수를 넘으면 더 보기).
// 품목이 많으면 품목 표만 쪽을 넘긴다('품목 1 / 2쪽'). 바닥줄의 '‹ 장부'는 온 자리(그 쪽 그 줄)로 돌아간다.
// 동작은 종류로 가른다(app/actions.ts): 도장 · 명령은 서버의 확인 창 초안, 화면은 그 화면, 전화는 이 화면의 전화 창,
// 일정 변경(change_promise)은 이 화면의 일정 변경 창(V9, PromiseDialog), 즉시 교환(exchange_swap)은 교환 창(ExchangeDialog). 일정 변경은 연결이
// 있어야 하는 결정이라(sync 8-2) 카운터가 끊겼으면 창 대신 한 줄(`일정 변경 불가 · 연결 끊김 · 종이 접수증에 기록`).
// 처리 현황의 끝나지 않은 줄은 누르면 그 단계를 접수 전체로 연다(장부의 팀 도장과 같은 길): 반납 줄은 모든 줄의 반납 확인 창(V1),
// 차량이 할 반납이면 먼저 `1호 차량 수거 예정 · 22:00`과 `매장 반납 처리`(spec 3-1). 품목 줄의 반납 칸은 그 줄만.
// 다른 팀 몫까지 받을 팀(읽기 모델 groupPay)의 수납은 어느 길로 눌러도 일괄 수납 화면(V5, #/orders/:orderId/pay)이다.
// 전화(call)는 전화 창(CallDialog: 온전한 번호는 phoneReveal, 카운터는 번호와 `닫기`), 인쇄(print)는 A4 대여 접수증(PrintHost: 브라우저 인쇄 창),
// 분실 처리(ticket_loss)는 분실 처리 창(TicketLossDialog, features-1 §8). 인쇄 · 분실 처리 창은 처음 누를 때 받는다(첫 화면 묶음을 작게).
import {
  ACTION_COMMAND, availableActions, offlineAllowed, type DeviceClassKey, resolveLedgerView, stampStepMap, visibleView, type ActionKey, type OrderSlip, type ResolvedLedgerView,
  type ViewActionRow,
} from '@skinote/contract';
import { fitList } from '@skinote/layout';
import {
  Checklist, FooterBar, Icon, Pager, PrimaryButton, Slip, TextFit, t, useDeviceProfile, useServerNow, useUi,
} from '@skinote/ui';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { dispatchAction } from '../app/actions.ts';
import { useConfig, useConnection, useLive, usePointerDown } from '../app/client.tsx';
import { actionLabel, stepButton } from '../app/labels.ts';
import { back, go, navState } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { pressStamp, useConfirmFlow, type ConfirmFlow } from '../components/ConfirmFlow.tsx';
import { ChoiceSheet } from '../components/NoticeDialog.tsx';
import { usePosHeader } from '../components/PosHeader.tsx';
import { PromiseDialog } from '../components/PromiseDialog.tsx';
import { CallDialog } from '../components/CallDialog.tsx';

const loadPrint = () => import('../components/PrintHost.tsx');
const loadLoss = () => import('../components/TicketLossDialog.tsx');
const PrintHost = lazy(() => loadPrint().then((m) => ({ default: m.PrintHost })));
const TicketLossDialog = lazy(() => loadLoss().then((m) => ({ default: m.TicketLossDialog })));
// 할인 · 취소 · 교환 창은 첫 화면 묶음에 넣지 않고(한도, scripts/check-dist.mjs ④) 접수증이 뜰 때 받는다(서비스 워커가 미리 받아 두므로 끊겨도 열린다).
// React.lazy를 쓰지 않는다: 처음 여는 창이 Suspense에 걸려 받은 뒤에도 0.8초쯤 늦게 뜬다. 받은 묶음을 상태로 들고 있다가 바로 그린다.
const loadEdit = () => import('../components/SlipEditDialogs.ts');

/** 따로 받는 묶음을 화면이 뜰 때 받아 상태로 든다. 받기 전이면 null(누른 창은 받는 대로 뜬다). */
function useLoaded<T>(load: () => Promise<T>): T | null {
  const [loaded, setLoaded] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    load().then((m) => { if (live) setLoaded(m); }).catch(() => undefined);
    return () => { live = false; };
  }, [load]);
  return loaded;
}

/** 일정 변경을 누르면: 연결되어 있거나 이 기기가 끊긴 채 보낼 수 있는 명령이면 창, 아니면 한 줄 알림(sync 8-2, 계약 offlineAllowed). */
export function promiseEntry(online: boolean, deviceClass: DeviceClassKey = 'pos'): 'dialog' | 'offline' {
  return online || offlineAllowed(deviceClass, 'promise.change') ? 'dialog' : 'offline';
}

/**
 * 수납(수납 명령을 여는 동작: 옆 동작 `수납` · 처리 현황 `수납` · 주 버튼 `수납 처리 · …`)을 일괄 수납 화면(V5)으로 여는지: 다른 팀 몫까지
 * 받을 팀(읽기 모델 groupPay)이면 V5, 아니면 보통 수납 창(ui 6-7).
 */
export function groupPayEntry(slip: Pick<OrderSlip, 'groupPay'> | null, actionKey: ActionKey): boolean {
  return slip?.groupPay !== undefined && ACTION_COMMAND[actionKey] === 'payment.take';
}

/** 칸 값이 한 줄에도 없는 도장 칸은 그리지 않는다(적재 칸은 차량 배달 접수에만, 조건 vehicle_pickup). */
function slipColumns(view: ResolvedLedgerView, slip: OrderSlip): ResolvedLedgerView {
  return { ...view, columns: view.columns.filter((c) => c.renderer_key !== 'stamp' || slip.lines.some((l) => l.cells[c.column_key])) };
}

export function OrderSlipScreen({ orderId }: { orderId: string }) {
  const config = useConfig();
  const profile = useDeviceProfile();
  const { timezone } = useUi();
  const baseFlow = useConfirmFlow();
  const header = usePosHeader('slip');
  const pointer = usePointerDown();
  const [itemsPage, setItemsPage] = useState(0);
  const [itemsPages, setItemsPages] = useState(1);
  const [moreOpen, setMoreOpen] = useState(false);
  const [phone, setPhone] = useState(false);
  const [promise, setPromise] = useState(false);
  const [discount, setDiscount] = useState(false);
  /** 접수 취소 · 품목 취소 창(features-1 §5-4). */
  const [cancel, setCancel] = useState<'order' | 'lines' | null>(null);
  /** 즉시 교환 창(features-1 §7-5). */
  const [exchange, setExchange] = useState(false);
  /** 분실 처리 창 · A4 인쇄(features-1 §8). */
  const [loss, setLoss] = useState(false);
  const [printing, setPrinting] = useState(false);
  const connection = useConnection();
  // 인쇄 · 분실 처리 창의 묶음은 접수증을 연 뒤 미리 받아 둔다(누르면 곧바로 뜨게, 첫 화면 묶음에는 넣지 않음).
  useEffect(() => { void loadPrint().catch(() => undefined); void loadLoss().catch(() => undefined); }, []);
  const edit = useLoaded(loadEdit);
  const hold = baseFlow.active || header.active || pointer || moreOpen || phone || promise || discount || cancel !== null || exchange || loss || printing;
  const live = useLive<OrderSlip>('slip:' + orderId + ':' + profile.key, (c) => c.query('orderSlip', { orderId, deviceClass: profile.key }), hold);
  const slip = live.data;
  // 다른 팀 몫까지 받을 팀의 수납은 확인 창 대신 일괄 수납 화면(V5). 도장 · 처리 현황 · 옆 동작 · 주 버튼이 모두 이 길을 지난다.
  const flow: ConfirmFlow = {
    ...baseFlow,
    open: (request) => {
      if (slip && groupPayEntry(slip, request.actionKey)) go({ name: 'groupPay', orderId: slip.orderId }, { state: { fromSlip: true } });
      else baseFlow.open(request);
    },
  };

  const baseView = useMemo(() => {
    const resolved = config ? resolveLedgerView(config.ledgerViews, 'order_slip', profile.key) : undefined;
    return resolved && config ? visibleView(resolved, config.features) : null;
  }, [config, profile.key]);
  const view = useMemo(() => (baseView && slip ? slipColumns(baseView, slip) : null), [baseView, slip]);
  const steps = useMemo(() => (config ? stampStepMap(config.stampSteps, config.features) : new Map()), [config]);
  const nowMs = useServerNow(slip?.serverTime);

  const toLedger = () => {
    if (navState().fromLedger) back();
    else go({ name: 'ledger', date: slip?.businessDate ?? null });
  };

  const next = slip?.nextStep ?? null;
  // 옆 동작: 접수의 능력(조건)으로 거르고, 주황 버튼과 같은 명령을 하는 동작(수납 도장 · 수납)은 한 번만 보인다.
  const actions = useMemo(() => {
    if (!view || !slip) return { shown: [] as ViewActionRow[], overflow: [] as ViewActionRow[] };
    const primaryCommand = next ? ACTION_COMMAND[next.actionKey] : null;
    // 보는 사람에게 없는 권한이 걸린 줄은 뺀다(읽기 모델 deniedPermissions, features-1 E11).
    const rows = availableActions(view.actions, slip.activeConditions, slip.deniedPermissions ?? [])
      .filter((a) => primaryCommand === null || ACTION_COMMAND[a.action_key] !== primaryCommand);
    const fitted = fitList(rows.map((a) => ({ ...a, pinnedEnd: false })), profile.capacity.sideActions);
    return { shown: fitted.shown, overflow: fitted.overflow };
  }, [view, slip, next, profile.capacity.sideActions]);

  const dispatch = (key: ActionKey, lineIds?: string[]) => {
    if (!slip) return;
    dispatchAction(key, {
      flow,
      target: { orderId: slip.orderId, ...(lineIds ? { lineIds } : {}) },
      own: {
        call: () => setPhone(true),
        change_promise: () => {
          if (promiseEntry(connection.online, profile.key) === 'dialog') setPromise(true);
          else flow.notify({ title: actionLabel('change_promise'), lines: [say('promiseOffline')] });
        },
        // 할인 적용(features-1 §6): 할인 · 환불 창(읽지 못하면 창 대신 한 줄).
        apply_discount: () => setDiscount(true),
        // 접수 취소 · 품목 취소(features-1 §5-4): 취소 · 환불 창. 품목 추가(§5-5): 품목 추가 화면(새 접수의 ① 품목).
        cancel: () => setCancel('order'),
        remove_items: () => setCancel('lines'),
        add_items: () => go({ name: 'addItems', orderId: slip.orderId }, { state: { fromSlip: true } }),
        // 즉시 교환(features-1 §7): 교환 창(카운터만, E14).
        exchange_swap: () => setExchange(true),
        // 분실 처리(features-1 §8-2): 안 돌아온 권을 청구 없이 닫는 창. 인쇄(§8-3): A4 대여 접수증.
        ticket_loss: () => setLoss(true),
        print: () => setPrinting(true),
      },
      next: next?.actionKey ?? null,
    });
  };
  const doAction = (row: ViewActionRow) => {
    setMoreOpen(false);
    dispatch(row.action_key);
  };

  if (!slip && live.error) {
    const missing = live.error === 'NOT_FOUND';
    return (
      <div className="sn-screen">
        {header.element}
        <div className="pos-plain">
          <main className="pos-card">
            <h1 className="pos-card-title">{t('slipTitle')}</h1>
            <p className="pos-card-line">{missing ? say('slipMissing') : say('slipUnreadable')}</p>
            <div className="pos-card-row">
              <button type="button" className="sn-button" onClick={() => go({ name: 'ledger', date: null })}><Icon name="left" /><span>{t('home')}</span></button>
            </div>
          </main>
        </div>
        {header.overlays}
      </div>
    );
  }

  const primary = next ? stepButton(next.actionKey, next.figure) : null;

  return (
    <div className="sn-screen">
      {header.element}
      <div className="sn-desk pos-slip-desk">
        {slip && view ? (
          <>
            <Slip
              slip={slip}
              view={view}
              steps={steps}
              nowMs={nowMs}
              itemsPage={itemsPage}
              onItemsPaging={setItemsPages}
              onStampPress={(line, _column, cell) => pressStamp(flow, steps, timezone, { orderId: slip.orderId, lineIds: [line.id], teamName: slip.teamName }, cell, (key) => dispatch(key, [line.id]))}
            />
            <aside className="pos-side" aria-label={say('remainingSteps')}>
              <Checklist
                items={slip.checklist}
                nowMs={nowMs}
                onItemPress={(item) => { if (item.stamp) pressStamp(flow, steps, timezone, { orderId: slip.orderId, teamName: slip.teamName }, item.stamp, (key) => dispatch(key)); }}
                primary={primary && next ? (
                  <PrimaryButton label={primary.label} alts={primary.alts} onPress={() => dispatch(next.actionKey)} />
                ) : null}
              />
              <div className="pos-side-actions">
                {actions.shown.map((row) => (
                  <button key={row.action_key} type="button" className="sn-button" onClick={() => doAction(row)}>
                    {row.action_key === 'call' ? <Icon name="phone" /> : null}
                    <TextFit input={{ mode: 'alts', alts: [actionLabel(row.action_key)] }} />
                  </button>
                ))}
                {actions.overflow.length ? (
                  <button type="button" className="sn-button" onClick={() => setMoreOpen(true)}>
                    <Icon name="more" />
                    <span>{t('more')}</span>
                  </button>
                ) : null}
              </div>
            </aside>
          </>
        ) : null}
      </div>
      <FooterBar metrics={[]} pager={<Pager label={say('itemsPager')} page={itemsPage} pageCount={itemsPages} onChange={setItemsPage} />}>
        <div className="pos-footer-back">
          <button type="button" className="sn-button" onClick={toLedger}>
            <Icon name="left" />
            <span>{t('home')}</span>
          </button>
          {slip ? <TextFit input={{ mode: 'parts', parts: [{ text: say('teamName', { name: slip.teamName }), drop: 0 }, ...(slip.last4 ? [{ text: say('last4', { last4: slip.last4 }), drop: 1 }] : [])] }} /> : null}
        </div>
      </FooterBar>
      {moreOpen ? (
        <ChoiceSheet
          title={t('more')}
          choices={actions.overflow.map((row) => ({ key: row.action_key, label: actionLabel(row.action_key) }))}
          onPick={(key) => { const row = actions.overflow.find((a) => a.action_key === key); if (row) doAction(row); }}
          onClose={() => setMoreOpen(false)}
        />
      ) : null}
      {phone && slip ? (
        <CallDialog orderId={slip.orderId} fallbackTitle={say('noticeTitle', { label: actionLabel('call'), name: slip.teamName })} onClose={() => setPhone(false)} />
      ) : null}
      {loss && slip ? (
        <Suspense fallback={null}>
          <TicketLossDialog
            orderId={slip.orderId}
            direction="loss"
            onClose={() => setLoss(false)}
            onFail={(line) => { setLoss(false); flow.notify({ title: actionLabel('ticket_loss'), lines: [line] }); }}
          />
        </Suspense>
      ) : null}
      {printing && slip ? (
        <Suspense fallback={null}>
          <PrintHost
            job={{ kind: 'slip', orderId: slip.orderId }}
            onDone={() => setPrinting(false)}
            onFail={(line) => { setPrinting(false); flow.notify({ title: actionLabel('print'), lines: [line] }); }}
          />
        </Suspense>
      ) : null}
      {discount && slip && edit ? (
        <edit.DiscountDialog
          orderId={slip.orderId}
          onClose={() => setDiscount(false)}
          onFail={(line) => { setDiscount(false); flow.notify({ title: actionLabel('apply_discount'), lines: [line] }); }}
        />
      ) : null}
      {cancel && slip && edit ? (
        <edit.CancelDialog
          orderId={slip.orderId}
          scope={cancel}
          onClose={() => setCancel(null)}
          onFail={(line) => { setCancel(null); flow.notify({ title: actionLabel(cancel === 'order' ? 'cancel' : 'remove_items'), lines: [line] }); }}
        />
      ) : null}
      {exchange && slip && edit ? (
        <edit.ExchangeDialog
          orderId={slip.orderId}
          onClose={() => setExchange(false)}
          onFail={(line) => { setExchange(false); flow.notify({ title: actionLabel('exchange_swap'), lines: [line] }); }}
        />
      ) : null}
      {promise && slip ? (
        <PromiseDialog
          orderId={slip.orderId}
          onClose={() => setPromise(false)}
          onFail={(line) => { setPromise(false); flow.notify({ title: actionLabel('change_promise'), lines: [line] }); }}
        />
      ) : null}
      {flow.element}
      {header.overlays}
    </div>
  );
}

// C2 대여 접수증 + B2 남은 일 목록(ui 6-2): 왼쪽은 손으로 쓰던 접수증(칸 한 줄 · 품목 표와 도장 · 약속 요약 · 돈 줄),
// 오른쪽 판은 남은 일 목록과 주황 큰 버튼 하나(늘 '다음 할 일'), 그 아래 옆 동작(ledger_view_actions, 등급 칸 수를 넘으면 더 보기).
// 품목이 많으면 품목 표만 쪽을 넘긴다('품목 1 / 2쪽'). 바닥줄의 '‹ 장부'는 온 자리(그 쪽 그 줄)로 돌아간다.
// 동작은 종류로 가른다(app/actions.ts): 도장 · 명령은 서버의 확인 창 초안, 화면은 그 화면, 전화는 이 화면의 전화 창,
// 일정 변경(change_promise)은 이 화면의 일정 변경 창(V9, PromiseDialog). 일정 변경은 연결이 있어야 하는 결정이라(sync 8-2) 카운터가
// 끊겼으면 창 대신 한 줄(`일정 변경 불가 · 연결 끊김 · 종이 접수증에 기록`).
// 처리 현황의 끝나지 않은 줄은 누르면 그 단계를 접수 전체로 연다(장부의 팀 도장과 같은 길): 반납 줄은 모든 줄의 반납 확인 창(V1),
// 차량이 할 반납이면 먼저 `1호 차량 수거 예정 · 22:00`과 `매장 반납 처리`(spec 3-1). 품목 줄의 반납 칸은 그 줄만.
// 다른 팀 몫까지 받을 팀(읽기 모델 groupPay)의 수납은 어느 길로 눌러도 일괄 수납 화면(V5, #/orders/:orderId/pay)이다.
import {
  ACTION_COMMAND, availableActions, offlineAllowed, type DeviceClassKey, resolveLedgerView, stampStepMap, visibleView, type ActionKey, type OrderSlip, type ResolvedLedgerView,
  type ViewActionRow,
} from '@skinote/contract';
import { fitList } from '@skinote/layout';
import {
  Checklist, FooterBar, Icon, Pager, PrimaryButton, Slip, TextFit, t, useDeviceProfile, useServerNow, useUi,
} from '@skinote/ui';
import { useMemo, useState } from 'react';
import { dispatchAction } from '../app/actions.ts';
import { useConfig, useConnection, useLive, usePointerDown } from '../app/client.tsx';
import { actionLabel, stepButton } from '../app/labels.ts';
import { back, go, navState } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { pressStamp, useConfirmFlow, type ConfirmFlow } from '../components/ConfirmFlow.tsx';
import { ChoiceSheet, NoticeDialog } from '../components/NoticeDialog.tsx';
import { usePosHeader } from '../components/PosHeader.tsx';
import { PromiseDialog } from '../components/PromiseDialog.tsx';

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
  const connection = useConnection();
  const hold = baseFlow.active || header.active || pointer || moreOpen || phone || promise;
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
    const rows = availableActions(view.actions, slip.activeConditions).filter((a) => primaryCommand === null || ACTION_COMMAND[a.action_key] !== primaryCommand);
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
  const phoneField = slip?.fields.find((f) => f.key === 'phone');

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
        <NoticeDialog
          title={say('noticeTitle', { label: actionLabel('call'), name: slip.teamName })}
          lines={phoneField?.value ? [phoneField.value, say('demoNoCall')] : [say('noPhone')]}
          onClose={() => setPhone(false)}
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

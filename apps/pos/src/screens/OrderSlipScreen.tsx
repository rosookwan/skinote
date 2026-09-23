// C2 대여 접수증 + B2 남은 일 목록(ui 6-2): 왼쪽은 손으로 쓰던 접수증(칸 한 줄 · 품목 표와 도장 · 약속 요약 · 돈 줄),
// 오른쪽 판은 남은 일 목록과 주황 큰 버튼 하나(늘 '다음 할 일'), 그 아래 옆 동작(ledger_view_actions, 등급 칸 수를 넘으면 더 보기).
// 품목이 많으면 품목 표만 쪽을 넘긴다('품목 1 / 2쪽'). 바닥줄의 '‹ 장부'는 온 자리(그 쪽 그 줄)로 돌아간다.
// 동작은 종류로 가른다(app/actions.ts): 도장 · 명령은 서버의 확인 창 초안, 화면은 그 화면, 전화는 이 화면의 전화 창.
import {
  ACTION_COMMAND, availableActions, resolveLedgerView, stampStepMap, visibleView, type ActionKey, type OrderSlip, type ResolvedLedgerView,
  type ViewActionRow,
} from '@skinote/contract';
import { fitList } from '@skinote/layout';
import {
  Checklist, FooterBar, Icon, Pager, PrimaryButton, Slip, TextFit, t, useDeviceProfile, useServerNow, useUi,
} from '@skinote/ui';
import { useMemo, useState } from 'react';
import { dispatchAction } from '../app/actions.ts';
import { useConfig, useLive, usePointerDown } from '../app/client.tsx';
import { actionLabel, stepButton } from '../app/labels.ts';
import { back, go, navState } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { pressStamp, useConfirmFlow } from '../components/ConfirmFlow.tsx';
import { ChoiceSheet, NoticeDialog } from '../components/NoticeDialog.tsx';
import { usePosHeader } from '../components/PosHeader.tsx';

/** 칸 값이 한 줄에도 없는 도장 칸은 그리지 않는다(적재 칸은 차량 배달 접수에만, 조건 vehicle_pickup). */
function slipColumns(view: ResolvedLedgerView, slip: OrderSlip): ResolvedLedgerView {
  return { ...view, columns: view.columns.filter((c) => c.renderer_key !== 'stamp' || slip.lines.some((l) => l.cells[c.column_key])) };
}

export function OrderSlipScreen({ orderId }: { orderId: string }) {
  const config = useConfig();
  const profile = useDeviceProfile();
  const { timezone } = useUi();
  const flow = useConfirmFlow();
  const header = usePosHeader('slip');
  const pointer = usePointerDown();
  const [itemsPage, setItemsPage] = useState(0);
  const [itemsPages, setItemsPages] = useState(1);
  const [moreOpen, setMoreOpen] = useState(false);
  const [phone, setPhone] = useState(false);
  const hold = flow.active || header.active || pointer || moreOpen || phone;
  const live = useLive<OrderSlip>('slip:' + orderId + ':' + profile.key, (c) => c.query('orderSlip', { orderId, deviceClass: profile.key }), hold);
  const slip = live.data;

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
      own: { call: () => setPhone(true) },
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
              onStampPress={(line, _column, cell) => pressStamp(flow, steps, timezone, { orderId: slip.orderId, lineIds: [line.id] }, cell, (key) => dispatch(key, [line.id]))}
            />
            <aside className="pos-side" aria-label={say('remainingSteps')}>
              <Checklist
                items={slip.checklist}
                nowMs={nowMs}
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
          {slip ? <TextFit input={{ mode: 'parts', parts: [{ text: say('teamName', { name: slip.teamName }), drop: 0 }, { text: say('last4', { last4: slip.last4 }), drop: 1 }] }} /> : null}
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
          title={actionLabel('call')}
          lines={[say('teamName', { name: slip.teamName }) + ' · ' + (phoneField?.value ?? ''), say('demoNoCall')]}
          onClose={() => setPhone(false)}
        />
      ) : null}
      {flow.element}
      {header.overlays}
    </div>
  );
}

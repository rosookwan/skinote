// V7 기사 업무 판 · 한 팀(spec 3-8, ui 6-5): 배달 목록의 줄(팀 칸)을 누르면 연다(#/driver/tasks/:taskId). 배달 · 수거 한 팀의 일을 크게 본다.
// 태블릿(1024×520 ~ 1280×720): 왼쪽 종이(제목 · 팀 · 품목 표 · 돈 줄) + 오른쪽 판(2 × 2 큰 버튼 · 반납 일정), 바닥줄 `‹ 배달 목록` ·
// `완료 0 · 잔여 1` · 보라 주 버튼. 휴대폰(360×640, ui 6-5): 한 칸 세로, 2 × 2 버튼 56px, 주 버튼 가로 전체 64px.
// 태블릿의 줄 · 버튼 높이는 연결 띠가 떠 있을 때의 높이로 정한다(화면 높이에서 띠를 늘 뺌, spec 3-8): 연결이 끊겨도 크기가 그대로이고 띠 아래가
// 내려갈 뿐이다. 휴대폰(360×640)은 품목 세 줄이 들어가야 해서 띠가 보일 때만 빼고, 끊기면 반납 일정 줄부터 뺀다(phoneTaskLayout).
// 품목 줄은 남는 높이를 나눠 쓴다(layout fillRows, DeviceProfile fill 60 ~ 88), 넘치면 쪽을 넘긴다. 스크롤은 없다.
// 화면은 규칙을 계산하지 않는다: 제목 · 표 · 돈 줄 · 버튼 · 주 버튼 · 바닥줄 글은 읽기 모델(taskSheet) 그대로이고, 누르면 확인 창(stamp.* →
// confirmDraft: 배달 처리 · 적재 처리 · 수거 처리)이나 판(현장 수납 · 리프트권 추가 · 방문 결과)을 연다.
import {
  ACTION_LABELS, draftToEnvelope, isAccepted, menuFor, openCommandDraft, stampStepMap, type ActionKey, type ConfirmCommand, type LedgerViewResult, type StampCell,
  type StampStepRow, type TaskSheetView,
} from '@skinote/contract';
import { fillRows } from '@skinote/layout';
import {
  AppHeader, BigButton, ConnectionStrip, Icon, Keypad, Pager, PrimaryButton, RichLine, Stamp, TextFit, connectionStripVisible, formatTime, t, useDeviceProfile, useServerNow,
  useUi, type DeviceProfile, type IconName,
} from '@skinote/ui';
import { useMemo, useState, type CSSProperties } from 'react';
import { useClient, useConfig, useConnection, useLive, usePointerDown } from '../app/client.tsx';
import { back, go, navState, type DeviceShape } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { pressStamp, useConfirmFlow } from '../components/ConfirmFlow.tsx';
import { ChoiceSheet, NoticeDialog } from '../components/NoticeDialog.tsx';
import { AddTicketPanel, FieldPayPanel } from '../components/TaskPanels.tsx';
import { VanStockDialog } from '../components/VanStockDialog.tsx';
import { VisitResultDialog } from '../components/VisitResultDialog.tsx';
import { driverListRoute } from './CollectionListScreen.tsx';

/** 오른쪽 판 큰 버튼의 그림(동작 키로 고름: 그림은 화면의 몫, 글은 읽기 모델). */
const ACTION_ICON: Partial<Record<ActionKey, IconName>> = {
  field_collect: 'money', add_ticket: 'ticket', not_delivered: 'ban', not_collected: 'ban', call: 'phone',
};

/**
 * 품목 줄에 쓸 높이(spec 3-8): 화면 높이 − 머리 − 연결 띠 − 바닥 − 제목 − 팀 묶음 − 돈 줄 − 사이. 태블릿은 표 머리(묶음 제목 높이)가 있고 연결
 * 띠를 늘 뺀다(끊겨도 크기가 그대로). 휴대폰은 한 칸 세로라 반납 일정(배달만, 이름을 앞에 붙인 한 줄씩) · 2 × 2 버튼(누르는 곳 높이 두 줄)도
 * 빼고 표 머리가 없다(도장 동그라미 안에 단계 이름). 휴대폰은 띠가 보일 때만 뺀다(strip): 360×640에 품목 세 줄(스키 · 헬멧 · 야간권)이
 * 들어가야 해서 띠 자리를 비워 두지 않고, 끊기면 반납 일정 줄부터 뺀다(화면의 차례). 값은 모두 DeviceProfile에서 온다.
 */
export function taskRowRoom(profile: DeviceProfile, height: number, options: { oneColumn: boolean; planLines: number; pager: boolean; strip?: boolean }): number {
  const strip = options.oneColumn && options.strip === false ? 0 : profile.connectionStripPx;
  const fixed = profile.headerPx + strip + profile.footerPx + profile.titleTabsPx + profile.pinRowPx + profile.keypad.loadPx;
  if (!options.oneColumn) return height - fixed - profile.groupTitlePx - 2 * profile.space.s;
  const gap = profile.space.xs;
  const plan = options.planLines ? phonePlanPx(profile, options.planLines) + gap : 0;
  const actions = 2 * profile.minTargetPx + profile.space.s + gap;
  const pager = options.pager ? profile.minTargetPx + gap : 0;
  return height - fixed - 2 * gap - plan - actions - pager;
}

/** 반납 일정 칸의 높이(태블릿 판): 이름 + 첫 줄이 누르는 곳 높이(56, 시안), 권이 있는 둘째 줄마다 본문 한 줄(글자 × 4/3) + 사이. */
export function planPx(profile: DeviceProfile, lines: number): number {
  return lines <= 0 ? 0 : profile.minTargetPx + (lines - 1) * (Math.round((profile.bodyFontPx * 4) / 3) + profile.space.xs);
}

/** 휴대폰의 반납 일정 칸 높이: 위 사이(가는 선) + 줄마다 본문 한 줄(글자 × 4/3, 첫 줄 앞에 이름 `반납 일정`) + 줄 사이. */
export function phonePlanPx(profile: DeviceProfile, lines: number): number {
  return lines <= 0 ? 0 : profile.space.s + lines * Math.round((profile.bodyFontPx * 4) / 3) + (lines - 1) * profile.space.xs;
}

/**
 * 휴대폰 업무 판의 품목 줄 · 반납 일정 줄 수: 품목이 한 쪽에 들 때까지 반납 일정의 권 줄(`권 1매 포함`, 표의 권 줄과 같은 사실) → 일정 줄 순서로
 * 빼고, 그래도 넘치면 일정 없이 표 아래 쪽 넘김.
 */
export function phoneTaskLayout(profile: DeviceProfile, height: number, lines: number, planLines: number, strip: boolean): { plan: number; rows: ReturnType<typeof fillRows>; pager: boolean } {
  const fit = (plan: number, pager: boolean) => fillRows(taskRowRoom(profile, height, { oneColumn: true, planLines: plan, pager, strip }), lines, profile.fill.rowMinPx, profile.fill.rowMaxPx);
  let plan = planLines;
  let rows = fit(plan, false);
  while (rows.pageCount > 1 && plan > 0) {
    plan -= 1;
    rows = fit(plan, false);
  }
  if (rows.pageCount === 1) return { plan, rows, pager: false };
  return { plan: 0, rows: fit(0, true), pager: true };
}

/**
 * 오른쪽 판 큰 버튼 한 칸의 높이(태블릿): 판 안(여백 둘) − 버튼 사이 − (배달이면 반납 일정과 그 사이)를 둘로(spec 3-8: 1024×600 164 ·
 * 1024×520 124). 연결 띠를 늘 뺀 높이라 끊겨도 그대로다.
 */
export function taskButtonPx(profile: DeviceProfile, height: number, planLines: number): number {
  const desk = height - profile.headerPx - profile.connectionStripPx - profile.footerPx;
  const plan = planLines ? profile.space.m + planPx(profile, planLines) : 0;
  return Math.max(profile.minTargetPx, Math.floor((desk - 2 * profile.space.m - profile.space.s - plan) / 2));
}

/** 돌아갈 목록: 배달 업무는 배달 목록, 수거 업무는 수거 목록. */
const listOf = (kind: TaskSheetView['kind']) => (kind === 'deliver' ? 'delivery_list' : 'collection_list');

type Panel =
  | { kind: 'pay'; dependsOn?: string }
  | { kind: 'ticket' }
  | { kind: 'visit' }
  | { kind: 'call' }
  | { kind: 'find' }
  | { kind: 'van' }
  | { kind: 'more'; entries: { key: string; label: string }[]; title: string; exit: boolean };

export function TaskSheetScreen({ taskId, device }: { taskId: string; device: DeviceShape }) {
  const client = useClient();
  const config = useConfig();
  const profile = useDeviceProfile();
  const { viewport, timezone } = useUi();
  const connection = useConnection();
  const flow = useConfirmFlow();
  const pointer = usePointerDown();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [page, setPage] = useState(0);
  const [digits, setDigits] = useState('');
  const [note, setNote] = useState<string | undefined>(undefined);
  const hold = flow.active || pointer || panel !== null;
  const live = useLive<TaskSheetView>('task:' + taskId + ':' + profile.key, (c) => c.query('taskSheet', { taskId, deviceClass: profile.key }), hold);
  const view = live.data;
  // 머리줄의 알림(긴급) · 차량 재고 · 재방문 시각은 같은 차량의 수거 목록에서 읽는다.
  const list = useLive<LedgerViewResult>('task-list:' + profile.key, (c) => c.ledgerView('collection_list', { tabKey: 'all', deviceClass: profile.key }), hold);
  const steps = useMemo(() => (config ? stampStepMap(config.stampSteps, config.features) : new Map<string, StampStepRow>()), [config]);
  const nowMs = useServerNow(view?.serverTime);
  const oneColumn = profile.primaryFullWidth;
  const deliver = view?.kind !== 'collect';
  const planLines = view?.returnPlan?.length ?? 0;

  const date = view?.currentBusinessDate ?? list.data?.currentBusinessDate ?? null;
  const backLabel = view?.kind === 'collect' ? say('toList') : say('toDeliveries');
  const toList = () => {
    if (navState().fromList) { back(); return; }
    const route = date ? driverListRoute(listOf(view?.kind ?? 'deliver'), date, device) : null;
    if (route) go(route, { replace: true });
  };

  // 품목 줄의 높이 · 쪽(태블릿은 바닥줄의 쪽 넘김, 휴대폰은 표 아래 한 줄). 휴대폰에서 품목이 한 쪽에 들지 않으면 반납 일정의 권 줄
  // (`권 1매 포함 · …`, 표의 권 줄과 같은 사실) → 일정 줄을 빼고, 그래도 넘치면 쪽을 넘긴다(phoneTaskLayout). 휴대폰은 연결 띠가 보일 때만
  // 그 높이를 뺀다(360×640에 품목 세 줄).
  const lines = view?.lines ?? [];
  const { fill } = profile;
  const phone = oneColumn ? phoneTaskLayout(profile, viewport.height, lines.length, planLines, connectionStripVisible(connection)) : null;
  const shownPlan = phone ? phone.plan : planLines;
  const rows = phone ? phone.rows : fillRows(taskRowRoom(profile, viewport.height, { oneColumn, planLines, pager: false }), lines.length, fill.rowMinPx, fill.rowMaxPx);
  const current = Math.min(page, rows.pageCount - 1);
  const shown = lines.slice(current * rows.perPage, (current + 1) * rows.perPage);
  const pager = rows.pageCount > 1 ? <Pager page={current} pageCount={rows.pageCount} onChange={setPage} /> : null;

  const target = view ? { orderId: view.orderId, taskId: view.taskId, teamName: view.teamName } : null;
  const dispatch = (key: ActionKey, lineIds?: string[]) => {
    if (!view || !target) return;
    switch (key) {
      case 'field_collect': setPanel({ kind: 'pay' }); return;
      case 'add_ticket': setPanel({ kind: 'ticket' }); return;
      case 'not_delivered':
      case 'not_collected': setPanel({ kind: 'visit' }); return;
      case 'call': setPanel({ kind: 'call' }); return;
      default: flow.open({ orderId: target.orderId, taskId: target.taskId, actionKey: key, ...(lineIds ? { lineIds } : {}) });
    }
  };
  const onStamp = (lineId: string, cell: StampCell) => {
    if (!target) return;
    pressStamp(flow, steps, timezone, { ...target, lineIds: [lineId] }, cell, (key) => dispatch(key, [lineId]));
  };

  /** 확인 창이 필요 없는 명령(방문 결과): 업무 판의 basis로 보내고, 안 되면 한 줄. */
  const send = (command: ConfirmCommand, title: string) => {
    if (!view) return;
    client.command(draftToEnvelope(openCommandDraft(command, view.basis))).then((outcome) => {
      if (isAccepted(outcome)) return;
      flow.notify({ title, lines: [outcome.error?.message ?? say('commandFailed')] });
    }, () => flow.notify({ title, lines: [say('sendFailed')] }));
  };

  /** 끝 4자리: 같은 차량의 배달 · 수거 목록에서 그 팀의 업무 판으로(같은 기록 자리에서 바꿈). 없으면 한 줄. */
  const find = (last4: string) => {
    setDigits('');
    const ask = (key: 'delivery_list' | 'collection_list') => client.ledgerView(key, { tabKey: 'all', deviceClass: profile.key });
    Promise.all([ask('delivery_list'), ask('collection_list')]).then((results) => {
      const hit = results.flatMap((r) => r.rows).find((r) => Object.values(r.cells).some((c) => c.renderer === 'team' && c.last4 === last4));
      if (hit?.taskId) { setPanel(null); go({ name: 'task', taskId: hit.taskId, device }, { replace: true, state: navState() }); }
      else setNote(say('notInList', { last4 }));
    }, () => setNote(say('findFailed')));
  };

  const pins = list.data?.pins ?? [];
  const waitingPins = pins.filter((p) => p.status === 'requested');
  // 업무 판의 머리줄에는 목록 메뉴(배달 목록 · 수거 목록)가 없다: 돌아가기는 바닥줄 `‹ 배달 목록`(plan §8 D4).
  const menu = useMemo(
    () => (config ? menuFor(config.menuEntries, 'driver', profile.key, config.features, null).filter((m) => m.screen_key !== 'driver_list') : []),
    [config, profile.key],
  );
  const exit = () => go({ name: 'exit', from: 'driver' }, { state: { fromDriver: true } });
  const header = (
    <AppHeader
      shopName={config?.shopName ?? ''}
      vehicleLabel={view?.vehicle.label ?? list.data?.vehicle?.label ?? say('vehicle')}
      menu={menu}
      alertCount={waitingPins.length}
      onFind={() => { setDigits(''); setNote(undefined); setPanel({ kind: 'find' }); }}
      onMenu={(entry) => { if (entry.key === 'van_stock') setPanel({ kind: 'van' }); else flow.notify({ title: entry.label, lines: [say('screenSoon')] }); }}
      onMore={(more) => setPanel({
        kind: 'more',
        title: more.vehicleLabel ? t('more') + ' · ' + more.vehicleLabel : t('more'),
        entries: more.entries.map((e) => ({ key: e.key, label: e.label })),
        exit: more.includesExit,
      })}
      onAlerts={() => flow.notify({
        title: t('alerts'),
        lines: waitingPins.length ? waitingPins.map((p) => [t('pinTitle') + ' · ' + formatTime(p.at, timezone), ...p.parts.map((x) => x.text)].join(' · ')) : [say('noAlerts')],
      })}
      onExit={exit}
    />
  );

  if (!view) {
    return (
      <div className="sn-screen">
        {header}
        <div className="pos-plain">
          <main className="pos-card">
            <h1 className="pos-card-title">{say('taskOfTeam')}</h1>
            {live.error ? <p className="pos-card-line" role="status">{live.error === 'NOT_FOUND' ? say('taskMissing') : live.error === 'FORBIDDEN' ? say('deviceUnavailable') : say('taskUnreadable')}</p> : null}
            <div className="pos-card-row">
              <button type="button" className="sn-button" onClick={toList}><Icon name="left" /><span>{backLabel}</span></button>
            </div>
          </main>
        </div>
        {flow.element}
      </div>
    );
  }

  const stampColumns = view.columns.slice(2);
  const rowStyle = { '--pos-task-row': rows.rowPx + 'px' } as CSSProperties;
  const table = (
    <table className={'sn-ledger-table pos-task-items' + (oneColumn ? ' is-bare' : '')} style={rowStyle}>
      <colgroup>
        <col />
        <col className="is-qty" />
        {stampColumns.map((c) => <col key={c.key} className="is-stamp" />)}
      </colgroup>
      {oneColumn ? null : (
        <thead>
          <tr>
            {view.columns.map((c, i) => (
              <th key={c.key} scope="col" className={i === 1 ? 'align-end' : i > 1 ? 'align-center' : undefined}>{c.label}</th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {shown.map((line) => (
          <tr key={line.lineId} className="sn-row">
            <td><TextFit className="pos-task-item" input={{ mode: 'words', text: line.label }} /></td>
            <td className="align-end"><b className="pos-task-qty">{line.qtyText}</b></td>
            {stampColumns.map((c) => {
              const cell = line.cells[c.key];
              if (cell?.renderer !== 'stamp') return <td key={c.key} className="is-stamp" />;
              const step = steps.get(cell.stamp.stepKey);
              return (
                <td key={c.key} className="is-stamp align-center">
                  <Stamp cell={cell.stamp} step={step} labelled={oneColumn} onPress={() => onStamp(line.lineId, cell.stamp)} />
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
  const money = view.money ? (
    <div className={'pos-task-money' + (view.money.length > 1 ? ' is-two' : '')}>
      {view.money.map((line, i) => <RichLine key={i} runs={line} />)}
    </div>
  ) : null;
  // 반납 일정: 태블릿은 이름 한 줄 + 일정 줄, 휴대폰은 이름을 첫 줄 앞에 붙인 한 줄씩(좁으면 뒤 조각부터 뺌: 차량 → 장소, 시각은 남김).
  const plan = view.returnPlan?.length && (!oneColumn || shownPlan > 0) ? (
    oneColumn ? (
      <div className="pos-task-plan is-inline">
        {view.returnPlan.slice(0, shownPlan).map((line, i) => (
          <div key={i} className="pos-task-plan-row">
            {i === 0 ? <span className="pos-task-plan-label">{say('returnPlan')}</span> : null}
            <TextFit className="pos-task-plan-line" input={{ mode: 'parts', parts: line.split(' · ').map((text, j) => ({ text, drop: j })) }} />
          </div>
        ))}
      </div>
    ) : (
      <div className="pos-task-plan">
        <span className="pos-task-plan-label">{say('returnPlan')}</span>
        {view.returnPlan.map((line, i) => <TextFit key={i} className="pos-task-plan-line" input={{ mode: 'words', text: line }} />)}
      </div>
    )
  ) : null;
  const buttonPx = taskButtonPx(profile, viewport.height, planLines);
  const actions = (
    <div className="pos-task-actions" style={oneColumn ? undefined : { gridAutoRows: buttonPx + 'px' }}>
      {view.actions.map((a) => (
        <BigButton
          key={a.actionKey}
          icon={ACTION_ICON[a.actionKey] ?? 'more'}
          label={a.label}
          {...(a.secondLine ? { secondLine: a.secondLine } : {})}
          disabled={!a.enabled}
          {...(a.reason ? { reason: a.reason } : {})}
          layout={oneColumn ? 'row' : 'column'}
          onPress={() => dispatch(a.actionKey)}
        />
      ))}
    </div>
  );
  const team = (
    <div className="pos-task-team">
      <TextFit className="pos-task-team-name" input={{ mode: 'words', text: view.team }} />
      <TextFit className="pos-task-team-line" input={{ mode: 'words', text: view.contact }} />
    </div>
  );
  const title = (
    <div className="sn-titlebar">
      <h1 className="sn-title"><TextFit input={{ mode: 'words', text: view.title }} /></h1>
    </div>
  );

  const primary = view.primary;
  const footer = (
    <footer className={'sn-footer pos-task-footer' + (oneColumn ? ' is-one' : '')}>
      <div className="pos-footer-back">
        <button type="button" className="sn-button" aria-label={backLabel} onClick={toList}>
          <Icon name="left" />
          <span>{oneColumn ? say('toListShort') : backLabel}</span>
        </button>
        {oneColumn ? null : <TextFit input={{ mode: 'words', text: view.progress }} />}
      </div>
      {!oneColumn && pager ? <div className="sn-footer-pager">{pager}</div> : null}
      <PrimaryButton
        label={primary.label}
        alts={primary.alts}
        disabled={!primary.enabled}
        fill={oneColumn}
        onPress={() => dispatch(primary.actionKey)}
      />
    </footer>
  );

  const load = list.data?.vehicleLoad;
  return (
    <div className="sn-screen">
      {header}
      <ConnectionStrip online={connection.online} pendingCount={connection.pendingCount} {...(connection.lastSyncAt ? { lastSyncAt: connection.lastSyncAt } : {})} />
      {oneColumn ? (
        <div className="sn-desk">
          <section className="sn-sheet pos-task-sheet is-one" aria-label={say('taskOfTeam')}>
            {title}
            <div className="pos-task-body">
              {team}
              {table}
              {pager ? <div className="pos-task-pager">{pager}</div> : null}
              {money}
              {plan}
              {actions}
            </div>
          </section>
        </div>
      ) : (
        <div className="sn-desk">
          <section className="sn-sheet pos-task-sheet">
            {title}
            <div className="pos-task-body">
              {team}
              {table}
              {money}
            </div>
          </section>
          <aside className="pos-task-side" aria-label={say('taskOfTeam')}>
            {actions}
            {plan}
          </aside>
        </div>
      )}
      {footer}
      {panel?.kind === 'pay' ? (
        <FieldPayPanel taskId={view.taskId} {...(panel.dependsOn ? { dependsOn: panel.dependsOn } : {})} onClose={() => setPanel(null)} onDone={() => setPanel(null)} />
      ) : null}
      {panel?.kind === 'ticket' ? (
        <AddTicketPanel taskId={view.taskId} onClose={() => setPanel(null)} onAdded={(requestId) => setPanel({ kind: 'pay', dependsOn: requestId })} />
      ) : null}
      {panel?.kind === 'visit' ? (
        <VisitResultDialog
          taskId={view.taskId}
          title={ACTION_LABELS[deliver ? 'not_delivered' : 'not_collected']}
          teamName={view.teamName}
          last4={view.last4}
          today={view.currentBusinessDate}
          nowMs={nowMs}
          reasons={view.visitReasons}
          slotTimes={(list.data?.groups ?? []).flatMap((g) => (g.at ? [formatTime(g.at, timezone)] : []))}
          onSubmit={(payload) => { setPanel(null); send({ type: 'task.visit', payload }, ACTION_LABELS[deliver ? 'not_delivered' : 'not_collected']); }}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {panel?.kind === 'call' ? (
        <NoticeDialog
          title={say('noticeTitle', { label: ACTION_LABELS.call, name: view.teamName })}
          lines={[view.phone ?? '', say('demoNoCall')]}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {panel?.kind === 'find' ? (
        <Keypad
          value={digits}
          onChange={(value) => { setDigits(value); setNote(undefined); }}
          onSubmit={find}
          open
          placement="sheet"
          onClose={() => setPanel(null)}
          {...(note ? { note } : {})}
        />
      ) : null}
      {panel?.kind === 'van' && load ? <VanStockDialog load={load} onClose={() => setPanel(null)} /> : null}
      {panel?.kind === 'more' ? (
        <ChoiceSheet
          title={panel.title}
          choices={[...panel.entries, ...(panel.exit ? [{ key: '__exit', label: t('exit'), icon: 'exit' as const }] : [])]}
          onPick={(key) => { const exitNow = key === '__exit'; setPanel(key === 'van_stock' ? { kind: 'van' } : null); if (exitNow) exit(); }}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {flow.element}
    </div>
  );
}

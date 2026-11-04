// 오늘 손님: 큰 세 단계·한 팀 한 줄. 상세와 확인 창은 기존 명령 흐름을 그대로 쓴다.
import { pickPrimaryAction, resolveLedgerView, visibleView, type CounterPhase, type CounterTeam, type LedgerViewResult } from '@skinote/contract';
import { Icon, PrimaryButton, TextFit, formatDateTitle, t, useDeviceProfile } from '@skinote/ui';
import { useEffect, useMemo, useState } from 'react';
import { dispatchAction } from '../app/actions.ts';
import { useConfig, useLive, usePointerDown } from '../app/client.tsx';
import { actionLabel } from '../app/labels.ts';
import { go, navState, patchNavState } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { useConfirmFlow } from '../components/ConfirmFlow.tsx';
import { CounterList, CounterSteps, readCounterPhase, saveCounterPhase, useCounterLayout } from '../components/CounterWorkspace.tsx';
import { ChoiceSheet } from '../components/NoticeDialog.tsx';
import { usePosHeader } from '../components/PosHeader.tsx';
import { useKeptRows } from './keep-position.ts';

export function DayLedgerScreen({ date }: { date: string | null }) {
  const config = useConfig();
  const profile = useDeviceProfile();
  const layout = useCounterLayout();
  const restored = useMemo(() => navState().ledger, []);
  const [phase, setPhase] = useState<CounterPhase>(readCounterPhase);
  const [completed, setCompleted] = useState(restored?.completed ?? false);
  const [tab, setTab] = useState(restored?.tab ?? 'all');
  const [page, setPage] = useState(restored?.page ?? 0);
  const [filter, setFilter] = useState(false);
  const flow = useConfirmFlow();
  const header = usePosHeader('ledger', undefined, undefined, { compact: true });
  const pointer = usePointerDown();
  const live = useLive<LedgerViewResult>(['ledger', date ?? '', tab, profile.key].join(':'),
    (c) => c.ledgerView('day_ledger', { ...(date ? { date } : {}), tabKey: tab, deviceClass: profile.key }), flow.active || header.active || pointer || filter);
  const result = live.data;
  const rows = useKeptRows(result?.rows, tab);
  const view = useMemo(() => {
    const resolved = config ? resolveLedgerView(config.ledgerViews, 'day_ledger', profile.key) : undefined;
    return resolved && config ? visibleView(resolved, config.features) : null;
  }, [config, profile.key]);
  useEffect(() => { if (!date && result) go({ name: 'ledger', date: result.currentBusinessDate }, { replace: true, state: navState() }); }, [date, result]);
  useEffect(() => { patchNavState({ ledger: { tab, page, completed, selected: restored?.selected ?? null } }); }, [tab, page, completed, restored?.selected]);
  const overview = result?.counter;
  const teams = rows.flatMap((row) => { const team = overview?.teams.find((o) => o.orderId === row.orderId); return team ? [team] : []; })
    .filter((team) => completed ? team.complete : !team.complete && team.phase === phase);
  const select = (next: CounterPhase) => { saveCounterPhase(next); setPhase(next); setCompleted(false); setPage(0); };
  const open = (team: CounterTeam) => {
    patchNavState({ ledger: { tab, page, completed, selected: team.orderId } });
    go({ name: 'slip', orderId: team.orderId }, { state: { fromLedger: true } });
  };
  const primary = view && result ? pickPrimaryAction(view.primary_actions, result.activeConditions) : null;
  return <div className={'sn-screen pos-counter' + (layout.compact ? ' is-compact' : '')}>
    {header.element}
    <main className="pos-counter-main">
      <div className="pos-counter-title-row"><div><h1>{say('counterTitle')}</h1>{result?.closedTag ? <span className="sn-title-tag">{result.closedTag}</span> : null}{!layout.compact && result ? <span>{formatDateTitle(result.titleValues.date ?? result.currentBusinessDate)}</span> : null}</div>
        {primary ? <PrimaryButton label={actionLabel(primary.action_key)} onPress={() => dispatchAction(primary.action_key, { flow, target: {}, date: result?.titleValues.date ?? date ?? undefined })} /> : null}
      </div>
      {overview ? <CounterSteps overview={overview} active={phase} onSelect={select} /> : null}
      <button type="button" className="sn-button pos-counter-search" onClick={header.find}><Icon name="keypad" /><span>{t('findTitle')}</span></button>
      {result?.link ? <TextFit className="pos-counter-link" input={{ mode: 'parts', parts: result.link.parts }} /> : null}
      {overview ? <CounterList key={phase + ':' + completed + ':' + tab} teams={teams} serverTime={result?.serverTime} onOpen={open} compact={layout.compact} selected={restored?.selected} initialPage={page} onPage={setPage}
        leading={<button type="button" className="sn-button" aria-pressed={completed} onClick={() => { setCompleted(!completed); setPage(0); }}><Icon name="clock" /><span>{say(completed ? 'counterActive' : 'counterCompleted')}</span></button>}
        trailing={<button type="button" className="sn-button" onClick={() => setFilter(true)}>{say('counterFilter')}{tab !== 'all' ? ' · ' + (view?.tabs.find((t) => t.tab_key === tab)?.label ?? '') : ''}<Icon name="down" /></button>}
      /> : live.error ? <p>{say('ledgerUnreadable')}</p> : null}
    </main>
    {filter && view ? <ChoiceSheet title={say('counterFilter')} choices={view.tabs.map((row) => ({ key: row.tab_key, label: row.label, selected: row.tab_key === tab }))} onPick={(key) => { setTab(key); setPage(0); setFilter(false); }} onClose={() => setFilter(false)} /> : null}
    {flow.element}{header.overlays}
  </div>;
}

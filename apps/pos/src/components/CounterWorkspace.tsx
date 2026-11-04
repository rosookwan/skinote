// 사용자 시안의 큰 흐름·목록·팀 상세. 업무 상태는 읽기 모델이 주며 이 부품은 표시와 쪽 나누기만 한다.
import type { CounterOverview, CounterPhase, CounterTeam, IsoTime, OrderSlip } from '@skinote/contract';
import { DialogFrame, Icon, Pager, PrimaryButton, TextFit, formatItem, formatWon, t, useDeviceProfile, useElementSize, useViewportSize, useUi, useServerNow, useFontsVersion, useIsoLayoutEffect, measureFor } from '@skinote/ui';
import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { say } from '../app/strings.ts';
import { stepButton } from '../app/labels.ts';
import { confirmWindow } from '@skinote/layout';


/** 정산 내역이 많아도 창을 늘리거나 일부를 버리지 않고 쪽으로 보여준다. */
export function CounterMoneySheet({ lines, onClose }: { lines: string[]; onClose: () => void }) {
  const { profile, viewport } = useUi();
  const [page, setPage] = useState(0);
  const box = confirmWindow(viewport, profile.confirm, 1, 0);
  const count = Math.max(1, Math.floor((box.heightPx - profile.confirm.titlePx - profile.confirm.primaryRowPx - profile.space.l * 2) / profile.minTargetPx));
  const pages = Math.max(1, Math.ceil(lines.length / count));
  const current = Math.min(page, pages - 1);
  return <DialogFrame title={say('counterMoney')} onClose={onClose} pager={<Pager page={current} pageCount={pages} onChange={setPage} />}>
    <div className="pos-counter-money-detail">{lines.slice(current * count, (current + 1) * count).map((line, i) => <p key={i}><TextFit input={{ mode: 'alts', alts: [line] }} lines={2} /></p>)}</div>
  </DialogFrame>;
}

const PHASE_KEY = 'skinote.pos.counterPhase';
export function readCounterPhase(): CounterPhase {
  try { const phase = localStorage.getItem(PHASE_KEY); return phase === 'rental' || phase === 'settlement' ? phase : 'intake'; } catch { return 'intake'; }
}
export function saveCounterPhase(phase: CounterPhase): void { try { localStorage.setItem(PHASE_KEY, phase); } catch { /* 표시 선택의 저장 실패가 처리를 막지 않는다. */ } }
export function useCounterLayout() {
  const profile = useDeviceProfile();
  const size = useViewportSize(profile.checkSizes[0]!);
  return { wide: size.width >= profile.counter.splitMinPx, compact: size.width < profile.counter.compactBelowPx };
}
export function CounterSteps({ overview, active, onSelect }: { overview: CounterOverview; active: CounterPhase; onSelect: (phase: CounterPhase) => void }) {
  return <nav className="pos-counter-stages" aria-label={say('counterSteps')}>
    {overview.stages.map((stage) => <button key={stage.key} type="button" aria-pressed={stage.key === active} onClick={() => onSelect(stage.key)}>
      <span>{stage.label}</span><b>{stage.count}</b>
    </button>)}
  </nav>;
}

export function CounterList({ teams, onOpen, rail = false, compact = false, selected, serverTime, initialPage = 0, onPage, leading, trailing }: {
  teams: CounterTeam[]; serverTime?: IsoTime; onOpen: (team: CounterTeam) => void; rail?: boolean; compact?: boolean; selected?: string | null;
  initialPage?: number; onPage?: (page: number) => void; leading?: ReactNode; trailing?: ReactNode;
}) {
  const profile = useDeviceProfile();
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  const [page, setPage] = useState(initialPage);
  const nameRef = useRef<HTMLSpanElement>(null);
  const nameSize = useElementSize(nameRef);
  const placeRef = useRef<HTMLSpanElement>(null);
  const placeSize = useElementSize(placeRef);
  const fonts = useFontsVersion();
  const [rowHeight, setRowHeight] = useState(profile.counter.rowPx);
  // 이름을 줄이거나 잘라 버리지 않는다. 실제 글꼴·이름 칸 폭으로 가장 긴 줄의 높이를 예약하고 그 높이로 쪽을 나눈다.
  useIsoLayoutEffect(() => {
    const el = nameRef.current;
    const width = nameSize?.width;
    if (!el || !width) return;
    const measure = measureFor(el, profile.bigFontPx);
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
    const lineCounts = teams.map(team => {
      let lines = 1, line = '';
      for (const ch of [team.name, team.party].filter(Boolean).join(' · ')) {
        if (line && measure(line + ch) > width) { lines += 1; line = ch; } else line += ch;
      }
      return lines;
    });
    const extra = rail || compact || teams.some(team => team.customerPickup) ? profile.minFontPx * profile.bodyLineHeight + profile.space.xs : 0;
    let placeHeight = 0;
    if (placeRef.current && placeSize?.width) {
      const placeMeasure = measureFor(placeRef.current, profile.minFontPx);
      const placeLine = Number.parseFloat(getComputedStyle(placeRef.current).lineHeight);
      for (const team of teams) {
        let count = 1, line = '';
        for (const ch of team.returnPlace) {
          if (line && placeMeasure(line + ch) > placeSize.width) { count += 1; line = ch; } else line += ch;
        }
        placeHeight = Math.max(placeHeight, count * placeLine + profile.bodyFontPx * profile.bodyLineHeight + profile.space.xs);
      }
    }
    setRowHeight(Math.max(profile.counter.rowPx, Math.ceil(Math.max(Math.max(1, ...lineCounts) * lineHeight + extra, placeHeight) + profile.space.s * 2)));
  }, [teams, nameSize?.width, placeSize?.width, fonts, profile, rail, compact]);
  const count = Math.max(1, Math.floor((size?.height ?? rowHeight) / rowHeight));
  const pages = Math.max(1, Math.ceil(teams.length / count));
  const current = Math.min(page, pages - 1);
  useEffect(() => { onPage?.(current); }, [current, onPage]);
  const rows = teams.slice(current * count, (current + 1) * count);
  const now = useServerNow(serverTime);
  return <section className={'pos-counter-list' + (rail ? ' is-rail' : '') + (compact ? ' is-compact' : '')} aria-label={say('counterTeams')} style={{ '--sn-counter-row': rowHeight + 'px' } as CSSProperties}>
    {!rail && !compact ? <div className="pos-counter-columns" aria-hidden="true"><span>{say('counterTeams')}</span><span>{say('counterItems')}</span><span>{say('counterReturn')}</span><span>{say('counterStatus')}</span><span /></div> : null}
    <div className="pos-counter-rows" ref={ref}>
      {rows.map((team) => { const late = team.lateAt !== undefined && Date.parse(team.lateAt) <= now; return <button type="button" className={'pos-counter-row' + (team.orderId === selected ? ' is-selected' : '') + (team.complete ? ' is-finished' : '') + (late ? ' is-late' : '')} key={team.orderId} data-order-id={team.orderId} data-receipt={team.receiptNo} data-complete={team.complete} onClick={() => onOpen(team)}>
        <span className="pos-counter-person"><span className="pos-counter-name" ref={team === rows[0] ? nameRef : undefined}>{[team.name, team.party].filter(Boolean).join(' · ')}</span>
          {team.customerPickup ? <small>{say('counterPickup')}</small> : rail || compact ? <small>{team.returnWhen} · {late ? t('late') + ' · ' : ''}{team.status}</small> : null}
        </span>
        {!rail && !compact ? <><TextFit input={{ mode: 'items', items: team.items.map(formatItem) }} /><span className="pos-counter-return"><strong>{team.returnWhen}</strong><span className="pos-counter-place" ref={team === rows[0] ? placeRef : undefined}>{team.returnPlace}</span></span><span className="pos-counter-status"><TextFit input={{ mode: 'words', text: (late ? t('late') + ' · ' : '') + team.status }} lines={2} /></span></> : null}
        <span className="pos-counter-open">{rail || compact ? <Icon name="right" /> : say('counterOpen')}</span>
      </button>; })}
      {!teams.length ? <p className="pos-counter-empty">{say('counterEmpty')}</p> : null}
    </div>
    <div className="pos-counter-paging"><span>{leading}</span><Pager page={current} pageCount={pages} onChange={setPage} /><span>{trailing}</span></div>
  </section>;
}

export function CounterDetail({ slip, wide, compact, onBack, onPrimary, onMore, onItem, onSchedule }: {
  slip: OrderSlip; wide: boolean; compact: boolean; onBack: () => void; onPrimary: () => void; onMore: () => void; onItem: (lineId: string) => void; onSchedule?: (() => void) | undefined;
}) {
  const profile = useDeviceProfile();
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  const [page, setPage] = useState(0);
  const [moneyOpen, setMoneyOpen] = useState(false);
  const itemHeight = !wide && !compact ? profile.repeatTargetPx : profile.counter.itemPx;
  const count = Math.max(1, Math.floor((size?.height ?? itemHeight) / itemHeight));
  // 금액 출처(할인·취소)는 기존 접수증과 같은 쪽 넘김에 포함한다. 현재 청구액을 품목 합으로 다시 계산하지 않는다.
  const entries = [
    ...slip.lines.map((line) => ({ key: line.id, lineId: line.id, label: line.label, qty: line.qtyText, amount: line.amount })),
    ...(slip.adjustments ?? []).map((line) => ({ key: line.key, lineId: null, label: line.parts.map((p) => p.text).join(' · '), qty: '', amount: line.amount })),
  ];
  const pages = Math.max(1, Math.ceil(entries.length / count));
  const current = Math.min(page, pages - 1);
  const next = slip.nextStep ? stepButton(slip.nextStep.actionKey, slip.nextStep.figure) : null;
  const money = slip.money;
  const now = useServerNow(slip.serverTime);
  const moneyLate = money.lateAt !== undefined && Date.parse(money.lateAt) <= now;
  const moneyLines = [
    say('counterCharged') + ' · ' + formatWon(money.charged),
    say('counterPaid') + ' · ' + formatWon(money.paid),
    say('counterDue') + ' · ' + formatWon(money.due),
    ...(money.depositHeld ? [say('counterDeposit') + ' · ' + formatWon(money.depositHeld)] : []),
    ...(money.promisedBy ? [say('counterPayer', { name: money.promisedBy.teamName }) + ' · ' + formatWon(money.promisedBy.amount)] : []),
    ...(money.collectForOthers ? [say('counterOthers') + ' · ' + formatWon(money.collectForOthers)] : []),
    ...(money.paidForOthers ? [say('counterOthers') + ' · ' + formatWon(money.paidForOthers.amount) + ' · ' + money.paidForOthers.methodLabel + ' ' + formatWon(money.paidForOthers.total)] : []),
    ...(money.refunded ? [say('counterRefund') + ' · ' + formatWon(money.refunded)] : []),
    ...money.payments.map((p) => p.methodLabel + ' · ' + formatWon(p.amount)),
  ];
  return <section className={'pos-counter-detail' + (wide ? ' is-wide' : '') + (compact ? ' is-compact' : '')} aria-label={say('counterDetail')}>
    <div className="pos-counter-detail-content">
      <div className="pos-counter-team-head">
        <button type="button" className="sn-button" onClick={onBack}><Icon name="left" /><span>{t('home')}</span></button>
        <div className="pos-counter-team-title"><h1><span className="pos-counter-name">{say('teamName', { name: slip.teamName })}{slip.counter?.party ? ' · ' + slip.counter.party : ''}</span></h1><span>{say('counterReceipt', { n: slip.receiptNo })}</span></div>
        {slip.cancelled ? <span className="pos-counter-badge pos-counter-cancelled">{slip.cancelled.label}</span> : null}
        {slip.counter?.customerPickup ? <span className="pos-counter-badge">{say('counterPickup')}</span> : null}
      </div>
      <button type="button" className="sn-button pos-counter-schedule" onClick={onSchedule} disabled={!onSchedule}>
        <Icon name="clock" /><TextFit input={{ mode: 'parts', parts: slip.promises.lines.map((p) => ({ text: (p.kind === 'return' ? say('counterReturn') : t('pickup')) + ' ' + (p.when ?? '') + (p.count ? ' · ' + p.count : '') + ' · ' + (p.parts[0]?.text ?? ''), drop: p.kind === 'return' ? 0 : 1, words: true })) }} /><span>{say('counterSchedule')}</span>
      </button>
      <div className="pos-counter-items-title"><h2>{say('counterItems')}</h2><TextFit input={{ mode: 'parts', parts: slip.counter?.facts ?? [] }} /></div>
      <div className="pos-counter-items" ref={ref}>
        {entries.slice(current * count, (current + 1) * count).map((line) => {
          const body = <><span className="pos-counter-item-mark"><Icon name={line.lineId ? 'right' : 'book'} /></span><TextFit input={{ mode: 'alts', alts: [line.label] }} lines={2} /><strong>{line.qty}</strong><span>{line.amount === undefined ? '' : formatWon(line.amount)}</span></>;
          return line.lineId ? <button type="button" className="pos-counter-item" key={line.key} onClick={() => onItem(line.lineId!)}>{body}</button> : <div className="pos-counter-item" data-adjustment key={line.key}>{body}</div>;
        })}
      </div>
      {wide || compact ? <div className="pos-counter-paging"><Pager page={current} pageCount={pages} onChange={setPage} label={say('itemsPager')} /></div> : null}
    </div>
    <aside className="pos-counter-money" aria-label={say('counterMoney')}>
      <button type="button" className="pos-counter-money-card" onClick={() => setMoneyOpen(true)}>
        <span>{say('counterDue')}</span><strong className={moneyLate ? 'tone-late' : undefined}>{formatWon(money.due)}</strong>
        <TextFit input={{ mode: 'parts', parts: [{ text: say('counterCharged') + ' ' + formatWon(money.charged), drop: 0 }, { text: say('counterPaid') + ' ' + formatWon(money.paid), drop: 1 }] }} />
        {money.depositHeld ? <span>{say('counterDeposit')} {formatWon(money.depositHeld)}</span> : null}
      </button>
      {wide ? <div className="pos-counter-money-lines">{moneyLines.slice(3, 9).map((line, i) => <p key={i}>{line}</p>)}<button type="button" className="sn-button" onClick={() => setMoneyOpen(true)}>{say('counterMoney')}<Icon name="right" /></button></div> : null}
    </aside>
    <footer className="pos-counter-detail-actions">
      {next ? <PrimaryButton label={next.label} alts={next.alts} fill onPress={onPrimary} /> : <span className="pos-counter-no-action">{slip.counter?.status ?? ''}</span>}
      {!wide && !compact ? <div className="pos-counter-paging"><Pager page={current} pageCount={pages} onChange={setPage} label={say('itemsPager')} /></div> : null}
      <button type="button" className="sn-button" onClick={onMore}><Icon name="more" /><span>{say('counterExtra')}</span></button>
    </footer>
    {moneyOpen ? <CounterMoneySheet lines={moneyLines} onClose={() => setMoneyOpen(false)} /> : null}
  </section>;
}

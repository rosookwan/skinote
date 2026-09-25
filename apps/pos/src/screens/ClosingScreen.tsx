// V6 하루 마감(spec 3-7, ui 6-8): 영업일(`12월 26일 (토) 마감`)의 돈을 수단별로 맞추고, 차량 현금과 돈통을 차례로 점검하고, 이월 항목을
// 본 뒤 닫는다. 장부형 틀(ui 2-1 나): 제목줄(명조 제목 + 오른쪽 기준 띠 `현재 27일 00:40` · `26일 장부 · 기준 06:00 · …`), 본문 왼쪽
// (결제 수단 표 · 현금 점검 표)과 오른쪽(이월 항목), 바닥줄(`‹ 장부` · 굵은 요약 · 주황 주 버튼 = 지금 할 일 하나: 차량 현금 점검 → 돈통
// 점검 → 마감). 줄 높이는 남는 높이를 나눠 쓴다(layout fillRows, DeviceProfile fill 52 ~ 88): 1024×600 73 · 68, 1024×569 65 · 62,
// 1024×529 55 · 54 — 세 크기 모두 한 쪽이다. 이월 항목은 한 쪽 5줄(spec)이고 넘치면 머리 오른쪽 끝에서 쪽을 넘긴다.
// 화면은 계산하지 않는다: 센 돈통 · 이월한 봉투(화면 초안, app/closing-draft.ts)를 인자로 closingSheet를 묻고, 줄 · 요약 · 주 버튼 · 마감
// 명령(closing.close)을 받는다. 점검은 아래 판(CashCheckPanel), 마감은 주 버튼이 바로 보낸다(요청번호는 마감 차례가 된 때 하나).
import {
  envelopeFor, isAccepted, offlineAllowed, type Basis, type CarryItem, type CashCheckRow, type ClosingCount, type ClosingMethodRow, type ClosingSheetParams, type ClosingSheetView,
  type ConfirmCommand,
} from '@skinote/contract';
import { fillRows } from '@skinote/layout';
import {
  FooterBar, Icon, Pager, RichLine, StampMark, TextFit, formatWon, t, useCommandDraft, useElementSize, useUi, type DeviceProfile,
} from '@skinote/ui';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  clearClosingDraft, draftParams, readClosingDraft, withCount, withDefer, withoutDefer, writeClosingDraft,
} from '../app/closing-draft.ts';
import { useClient, useConnection, useLive } from '../app/client.tsx';
import { go } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { CashCheckPanel } from '../components/CashCheckPanel.tsx';
import { NoticeDialog } from '../components/NoticeDialog.tsx';
import { usePosHeader } from '../components/PosHeader.tsx';

const NO_BASIS: Basis = { epoch: '', rev: 0 };
const CLOSE_SHAPE: ConfirmCommand = { type: 'closing.close', payload: { date: '', drawerCounts: [], deferredTransferIds: [] } };


export interface ClosingLayout {
  /** 왼쪽 두 표의 줄 높이 · 한 쪽 줄 수(두 표를 합쳐 센다). */
  leftRowPx: number;
  leftPerPage: number;
  /** 이월 항목 줄 높이 · 한 쪽 줄 수 · 머리 높이(쪽 넘김이 있으면 누르는 곳 높이). */
  carryRowPx: number;
  carryPerPage: number;
  carryHeadPx: number;
}

/**
 * 줄 높이(spec 3-7): 본문 = 창 높이 − 머리 · 바닥 · 제목 − 위(8) · 아래(16) 여백. 왼쪽은 표 머리 둘과 사이(12)를 뺀 높이를 두 표의 줄 수로,
 * 오른쪽은 머리를 뺀 높이를 한 쪽 5줄로 나눈다(52 이상 88 이하, DeviceProfile fill). 이월 항목이 한 쪽을 넘으면 머리에 쪽 넘김이 들어가
 * 머리가 누르는 곳 높이가 된다.
 */
export function closingLayout(profile: DeviceProfile, heightPx: number, rows: { left: number; carry: number }): ClosingLayout {
  const room = heightPx - profile.headerPx - profile.footerPx - profile.titleTabsPx - profile.space.s - profile.space.l;
  const { rowMinPx: min, rowMaxPx: max } = profile.fill;
  const left = fillRows(room - 2 * profile.tableHeadPx - profile.space.m, rows.left, min, max);
  const carry = (head: number) => {
    // 이월 항목 한 쪽의 줄 수(DeviceProfile pages, spec 3-7: 한 쪽 5줄, 넘치면 쪽을 넘긴다).
    const rowsPerPage = profile.pages.closingCarryRows;
    const fit = fillRows(room - head, rowsPerPage, min, max);
    return { rowPx: fit.rowPx, perPage: Math.min(rowsPerPage, fit.perPage), head };
  };
  let right = carry(profile.tableHeadPx);
  if (rows.carry > right.perPage) right = carry(profile.minTargetPx);
  return { leftRowPx: left.rowPx, leftPerPage: left.perPage, carryRowPx: right.rowPx, carryPerPage: right.perPage, carryHeadPx: right.head };
}

/**
 * 왼쪽 표의 칸 폭(잰 폭으로 고르는 모양, 업무 규칙이 아님): 시안(글 폭 600)은 이름 196 · 끝 칸 112. 예상 · 실제 칸에 `실제 540,000원 ·
 * 차액 −5,000원`(누르는 곳 다섯 칸 폭쯤)이 들어가지 않으면(좁은 포스) 현금 점검 표의 이름 · 끝 칸을 줄인다(compact, 결제 수단 표는 금액 칸이
 * 넓어 그대로). 값은 DeviceProfile에서 센다.
 */
export function closingColumns(profile: Pick<DeviceProfile, 'minTargetPx' | 'space'>, widthPx: number | undefined): { compact: boolean } {
  const { minTargetPx: target, space } = profile;
  const name = target * 4 - space.s * 1.5;
  const end = target * 2 + space.s;
  return { compact: widthPx !== undefined && widthPx < name + end + target * 5 + space.s };
}

type LeftRow = { kind: 'method'; row: ClosingMethodRow } | { kind: 'cash'; row: CashCheckRow };

export function ClosingScreen({ date }: { date: string | null }) {
  const client = useClient();
  const header = usePosHeader('other');
  const { profile, viewport } = useUi();
  const connection = useConnection();
  const [stored] = useState(() => readClosingDraft());
  // 초안이 어느 체험 자료(epoch)의 것인지: 처음에는 저장된 초안의 것, 버리거나 적으면 지금 답의 것(한 번 버린 뒤 새 셈을 다시 버리지 않게).
  const draftEpoch = useRef<string | null>(stored?.epoch ?? null);
  const [params, setParams] = useState<ClosingSheetParams>(() => draftParams(date, stored));
  const [pad, setPad] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; lines: string[] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [leftPage, setLeftPage] = useState(0);
  const [carryPage, setCarryPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const live = useLive<ClosingSheetView>(
    'closing:' + JSON.stringify(params),
    (c) => c.query('closingSheet', params),
    pad !== null || notice !== null || confirming || busy || header.active,
  );
  const view = live.data;

  // 날짜 없이 열면(#/closing) 서버의 영업일 주소로 바꾼다.
  useEffect(() => {
    if (!date && view) go({ name: 'closing', date: view.date }, { replace: true });
  }, [date, view?.date]);

  // 화면 초안: 체험 자료를 초기화했으면(epoch) 버리고, 바뀌면 탭에 남긴다. 마감했으면 지운다(closingDraftStep).
  useEffect(() => {
    if (!view || !date) return;
    const step = closingDraftStep({
      closed: view.closed !== undefined, draftEpoch: draftEpoch.current, viewEpoch: view.basis.epoch,
      hasDraft: params.counts !== undefined || params.deferredTransferIds !== undefined,
    });
    draftEpoch.current = view.basis.epoch;
    if (step === 'clear') { clearClosingDraft(); return; }
    if (step === 'discard') {
      setParams({ date });
      clearClosingDraft();
      return;
    }
    writeClosingDraft({ epoch: view.basis.epoch, date, counts: params.counts ?? [], deferredTransferIds: params.deferredTransferIds ?? [] });
  }, [view?.basis.epoch, view?.closed, JSON.stringify(params)]);

  // 마감의 요청번호: 마감 차례가 된 때 한 번(시도마다). 보낼 때 본문 · 바탕(돈통 예상)은 지금 답의 것이다.
  const closeKey = view && view.next?.kind === 'close' && view.command ? 'closing:' + view.date + ':' + attempt : null;
  const { draft, markSent } = useCommandDraft(closeKey, closeKey ? CLOSE_SHAPE : null, view?.basis ?? NO_BASIS);

  const leftRef = useRef<HTMLDivElement>(null);
  const leftBox = useElementSize(leftRef);
  const { compact } = closingColumns(profile, leftBox?.width);
  const rows = view ? { left: view.methods.length + view.cash.length, carry: view.carry.length } : { left: 0, carry: 0 };
  const layout = closingLayout(profile, viewport.height, rows);
  const leftRows: LeftRow[] = useMemo(() => (view ? [
    ...view.methods.map((row): LeftRow => ({ kind: 'method', row })),
    ...view.cash.map((row): LeftRow => ({ kind: 'cash', row })),
  ] : []), [view]);
  const leftPages = Math.max(1, Math.ceil(leftRows.length / layout.leftPerPage));
  const leftAt = Math.min(leftPage, leftPages - 1);
  const leftShown = leftRows.slice(leftAt * layout.leftPerPage, (leftAt + 1) * layout.leftPerPage);
  const carry = view?.carry ?? [];
  const carryPages = Math.max(1, Math.ceil(carry.length / layout.carryPerPage));
  const carryAt = Math.min(carryPage, carryPages - 1);
  const carryShown = carry.slice(carryAt * layout.carryPerPage, (carryAt + 1) * layout.carryPerPage);

  // 마감은 연결이 필요한 결정이다(sync 8-2, 계약 offlineAllowed): 끊겼으면 주 버튼 대신 한 줄.
  const offline = !connection.online && !offlineAllowed(profile.key, 'closing.close');
  const blocked = offline ? say('closingOffline') : view?.blocked;
  const next = view?.next ?? null;

  const close = () => {
    const envelope = draft && view ? envelopeFor(draft, view.command, view.expect) : null;
    if (!envelope || busy) return;
    setBusy(true);
    markSent();
    client.command(envelope).then((outcome) => {
      setBusy(false);
      if (outcome.outcome === 'applied' || outcome.outcome === 'superseded') { clearClosingDraft(); return; }
      // 이 요청번호는 끝났다: 다음 누름은 새 번호(지금 자료로 다시 묻는다).
      setAttempt((n) => n + 1);
      setNotice({ title: say('closing'), lines: [outcome.error?.message ?? say('commandFailed')] });
    }, () => {
      setBusy(false);
      setNotice({ title: say('closing'), lines: [say('sendFailed')] });
    });
  };
  const onPrimary = () => {
    if (!next || !next.enabled) return;
    // 영업 중 마감(반납 예정 · 차량 미입고 · 마지막 반납 타임 전)은 한 번 묻는다(읽기 모델 confirm).
    if (next.kind === 'close') { if (view?.confirm) setConfirming(true); else close(); }
    else if (next.targetKey) setPad(next.targetKey);
  };
  const onAction = (row: CashCheckRow) => {
    if (!row.action) return;
    if (row.action.key === 'defer') { setParams((prev) => withDefer(prev, row.key)); return; }
    setPad(row.key);
  };
  const onCarry = (item: CarryItem) => {
    if (item.orderId) go({ name: 'slip', orderId: item.orderId });
    else if (item.tabKey && view) go({ name: 'ledger', date: view.date }, { state: { ledger: { tab: item.tabKey, page: 0, selected: null } } });
  };
  const toLedger = () => go({ name: 'ledger', date: view?.date ?? date });

  if (!view && live.error === 'NOT_FOUND') {
    return (
      <div className="sn-screen">
        {header.element}
        <div className="pos-plain">
          <main className="pos-card">
            <h1 className="pos-card-title">{say('closing')}</h1>
            <p className="pos-card-line">{say('closingNone')}</p>
            <div className="pos-card-row">
              <button type="button" className="sn-button" onClick={() => go({ name: 'ledger', date: null })}><Icon name="left" /><span>{t('home')}</span></button>
            </div>
          </main>
        </div>
        {header.overlays}
      </div>
    );
  }

  const leftStyle = { '--pos-closing-row': layout.leftRowPx + 'px' } as CSSProperties;
  const carryStyle = { '--pos-closing-carry-row': layout.carryRowPx + 'px', '--pos-closing-carry-head': layout.carryHeadPx + 'px' } as CSSProperties;
  const methods = leftShown.flatMap((x) => (x.kind === 'method' ? [x.row] : []));
  const cash = leftShown.flatMap((x) => (x.kind === 'cash' ? [x.row] : []));
  const primaryReady = next !== null && next.enabled && !busy && !(next.kind === 'close' && (blocked !== undefined || !draft));

  return (
    <div className="sn-screen">
      {header.element}
      <div className="sn-desk">
        <main className="sn-sheet pos-closing" aria-label={view?.title ?? say('closing')}>
          <div className="sn-titlebar">
            <h1 className="sn-title"><TextFit input={{ mode: 'words', text: view?.title ?? say('closing') }} /></h1>
            {view ? (
              <div className="pos-closing-band" role="status">
                <span className="sn-now-label">{view.band.pill}</span>
                <TextFit className="pos-closing-band-text" input={{ mode: 'parts', parts: view.band.parts }} />
              </div>
            ) : null}
          </div>
          {!view && live.error ? <p className="pos-sheet-note" role="status">{say('closingUnreadable')}</p> : null}
          {/* 본문 틀은 읽기 전에도 둔다: 왼쪽 칸의 폭을 처음부터 잰다(칸 폭 고르기). */}
          <div className="pos-closing-body">
            <div ref={leftRef} className="pos-closing-left" style={leftStyle}>
              {methods.length ? (
                <table className="sn-ledger-table pos-closing-table">
                  <colgroup><col className="is-name" /><col className="is-count" /><col /></colgroup>
                  <thead>
                    <tr>
                      <th scope="col">{say('colMethod')}</th>
                      <th scope="col" className="align-end">{say('colCount')}</th>
                      <th scope="col" className="align-end">{say('colAmount')}</th>
                    </tr>
                  </thead>
                  <tbody>{methods.map((m) => <MethodLine key={m.key} row={m} />)}</tbody>
                </table>
              ) : null}
              {cash.length ? (
                <table className={'sn-ledger-table pos-closing-table is-cash' + (compact ? ' is-compact' : '')}>
                  <colgroup><col className="is-name" /><col /><col className="is-end" /></colgroup>
                  <thead>
                    <tr>
                      <th scope="col">{say('cashCheck')}</th>
                      <th scope="col" colSpan={2}>{say('expectedActual')}</th>
                    </tr>
                  </thead>
                  <tbody>{cash.map((row) => <CashLine key={row.key} row={row} onAction={() => onAction(row)} />)}</tbody>
                </table>
              ) : null}
            </div>
            {view ? (
              <section className="pos-closing-right" style={carryStyle} aria-label={say('carryOver', { n: carry.length })}>
                <div className="pos-closing-carry-head">
                  <span className="pos-closing-carry-title">{say('carryOver', { n: carry.length })}</span>
                  <Pager page={carryAt} pageCount={carryPages} onChange={setCarryPage} />
                </div>
                <ul className="pos-closing-carry">
                  {carryShown.map((item) => <CarryLine key={item.key} item={item} onPress={item.orderId || item.tabKey ? () => onCarry(item) : undefined} />)}
                </ul>
              </section>
            ) : null}
          </div>
        </main>
      </div>
      <FooterBar
        metrics={[]}
        pager={<Pager page={leftAt} pageCount={leftPages} onChange={setLeftPage} />}
        primary={next ? {
          label: busy ? t('processing') : next.label,
          ...(busy || !next.alts.length ? {} : { alts: next.alts }),
          disabled: !primaryReady,
          busy,
          onPress: onPrimary,
        } : null}
      >
        <div className="pos-footer-back pos-closing-foot">
          <button type="button" className="sn-button" aria-label={t('home')} onClick={toLedger}>
            <Icon name="left" />
            <span>{t('home')}</span>
          </button>
          {view ? (
            <span className="pos-closing-sum">
              <TextFit className="pos-closing-sum-main" input={{ mode: 'parts', parts: view.footer }} />
              {view.closed ? <TextFit className="pos-closing-sum-note" input={{ mode: 'words', text: view.closed }} /> : null}
              {!view.closed && blocked ? <TextFit className="pos-closing-sum-note" input={{ mode: 'words', text: blocked }} /> : null}
            </span>
          ) : null}
          {view?.closed ? (
            <button type="button" className="sn-button pos-closing-print" onClick={() => setNotice({ title: say('closingPrint'), lines: [say('demoUnsupported')] })}>
              {say('closingPrint')}
            </button>
          ) : null}
        </div>
      </FooterBar>
      {pad !== null && view ? (
        <CashCheckPanel
          base={params}
          rowKey={pad}
          onClose={() => setPad(null)}
          onCount={(count: ClosingCount) => { setPad(null); setParams((prev) => withCount(prev, count)); }}
          onChecked={() => { const key = pad; setPad(null); setParams((prev) => withoutDefer(prev, key)); }}
        />
      ) : null}
      {notice ? <NoticeDialog title={notice.title} lines={notice.lines} onClose={() => setNotice(null)} /> : null}
      {confirming && view?.confirm && next?.kind === 'close' ? (
        <NoticeDialog
          title={view.confirm.title}
          lines={[view.confirm.line]}
          actions={[{ label: next.label, primary: true, onPress: () => { setConfirming(false); close(); } }]}
          onClose={() => setConfirming(false)}
        />
      ) : null}
      {header.overlays}
    </div>
  );
}

/**
 * 마감 화면 초안의 할 일(효과의 판단, 순수 함수): 마감했으면 지움, 초안이 다른 체험 자료(epoch)의 것이고 셈 · 이월이 있으면 버림, 아니면 적음.
 * draftEpoch는 초안이 속한 자료(처음에는 저장된 초안의 것, 한 번 버리거나 적은 뒤에는 지금 답의 것)라 한 번 버린 뒤의 새 셈은 버리지 않는다.
 */
export function closingDraftStep(input: { closed: boolean; draftEpoch: string | null; viewEpoch: string; hasDraft: boolean }): 'clear' | 'discard' | 'write' {
  if (input.closed) return 'clear';
  if (input.draftEpoch !== null && input.draftEpoch !== input.viewEpoch && input.hasDraft) return 'discard';
  return 'write';
}

/** 결제 수단 표 한 줄: 수단(회색 둘째 줄 `1호 차량 35,000원 포함`) · 건수 · 금액. */
function MethodLine({ row }: { row: ClosingMethodRow }) {
  return (
    <tr className="sn-row">
      <td>
        <span className="sn-cell-stack">
          <span className="pos-closing-name">{row.label}</span>
          {row.note ? <TextFit className="pos-closing-sub" input={{ mode: 'parts', parts: row.note }} /> : null}
        </span>
      </td>
      <td className="align-end"><span className="pos-closing-count">{say('cases', { n: row.count })}</span></td>
      <td className="align-end"><span className="pos-closing-amount">{formatWon(row.amount)}</span></td>
    </tr>
  );
}

/** 현금 점검 표 한 줄: 이름(회색 둘째 줄) · 예상 / 실제(또는 차례가 아닌 회색 한 줄) · 끝 칸(점검 도장 또는 칸 전체가 버튼). */
function CashLine({ row, onAction }: { row: CashCheckRow; onAction: () => void }) {
  return (
    <tr className={'sn-row' + (row.now ? ' is-now' : '')}>
      <td>
        <span className="sn-cell-stack">
          <span className="pos-closing-name">{row.label}</span>
          <TextFit className="pos-closing-sub" input={{ mode: 'parts', parts: row.note }} />
        </span>
      </td>
      {row.waiting ? (
        <td colSpan={2}><span className="pos-closing-wait">{row.waiting}</span></td>
      ) : (
        <>
          <td>
            <span className="sn-cell-stack">
              {row.expected.length ? <RichLine className="pos-closing-line" runs={row.expected} /> : null}
              {row.actual ? <RichLine className="pos-closing-line" runs={row.actual} /> : null}
            </span>
          </td>
          {row.stamp ? (
            <td className="is-stamp align-center">
              <span className="sn-stamp-cell is-done" role="img" aria-label={row.stampAria}>
                <StampMark cell={row.stamp} step={undefined} />
              </span>
            </td>
          ) : row.action ? (
            <td className="is-action">
              <button type="button" className="sn-cell-action" onClick={onAction}>
                <TextFit input={{ mode: 'words', text: row.action.label }} />
              </button>
            </td>
          ) : <td className="is-action" />}
        </>
      )}
    </tr>
  );
}

/** 이월 항목 한 줄: 굵은 윗줄(늦은 것만 `지연` 빨강 · 줄 앞 늦음 막대) · 작은 둘째 줄, 누르면 그 접수증 · 장부 탭(오른쪽 끝 `›`). */
function CarryLine({ item, onPress }: { item: CarryItem; onPress?: (() => void) | undefined }) {
  const body = (
    <>
      <span className="pos-closing-carry-main">
        <RichLine className="pos-closing-carry-name" runs={item.title} />
        <TextFit className="pos-closing-carry-note" input={{ mode: 'parts', parts: item.note }} />
      </span>
      {onPress ? <Icon name="right" /> : null}
    </>
  );
  return (
    <li className={'pos-closing-carry-row' + (item.late ? ' is-late' : '')}>
      {onPress ? <button type="button" className="pos-closing-carry-press" onClick={onPress}>{body}</button> : <span className="pos-closing-carry-press">{body}</span>}
    </li>
  );
}

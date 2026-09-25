// V5 일괄 수납 · 여러 팀(spec 3-6, ui 6-7): 가족 여러 팀의 돈을 한 사람이 한 번에 낸다. 다른 팀 몫까지 받을 팀(OrderSlip.groupPay)의 접수증에서
// `수납`을 누르면 연다(#/orders/:orderId/pay). 틀은 접수증형(왼쪽 장부 종이 + 오른쪽 판): 종이 제목 `일괄 수납`과 탭(`이정호 팀 결제 · 6팀` ·
// `미수 3`), 표(선택 · 팀 · 품목 · 받을 금액 · `부분 결제 ›`), 오른쪽 판(받을 금액 · 2 × 2 결제 수단 · 주 버튼), 바닥줄(`‹ 접수증` ·
// `팀 추가 · 끝 4자리` · 쪽 넘김).
// 화면은 계산하지 않는다: 고른 팀 · 탭 · 팀마다 고른 품목 수(부분 결제 판) · 수단 · 더한 팀을 인자로 groupPaySheet를 다시 묻고, 줄 · 합계 ·
// 주 버튼 · 명령(payment.take 한 번, 팀마다의 받을 금액 expect)을 받는다. 보는 동안 다른 카운터의 일로 줄이 움직이지 않게 새 rev에는 다시
// 묻지 않는다: 그사이 받은 팀은 보낼 때 충돌로 알린다(`강지은 팀 45,000원 수납 완료 · 다른 카운터` + `제외 후 수납` · `닫기`, sync 4-3).
// 요청번호는 이 화면의 시도마다 하나(useCommandDraft): 보내지 못함(연결 끊김)은 같은 번호로 다시, 충돌 · 거절 뒤에는 새 번호다.
// 줄은 잰 높이로 쪽을 나눈다(스크롤 없음). 폭이 좁으면(좁은 포스) 칸 폭을 줄이고 품목은 '외 N종', 부분 금액은 짧은 글로 맞춘다.
import {
  CHECKOUT_KEYS, changedOrders, envelopeFor, GROUP_PAY_TABS, isAccepted, type AnyCommandDraft, type AnyCommandEnvelope, type Basis, type ConfirmCommand,
  type FindResult, type GroupPayRow, type GroupPaySheetParams, type GroupPaySheetView, type LineUnits,
} from '@skinote/contract';
import {
  FooterBar, Icon, Keypad, MethodGrid, Pager, PrimaryButton, SelectCell, Tag, TextFit, formatItem, formatWon, t, useCommandDraft, useDeviceProfile,
  useElementSize, type DeviceProfile,
} from '@skinote/ui';
import { useEffect, useRef, useState } from 'react';
import { useClient } from '../app/client.tsx';
import { back, go, navState } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { ChoiceSheet, NoticeDialog } from '../components/NoticeDialog.tsx';
import { PartialPayDialog } from '../components/PartialPayDialog.tsx';
import { usePosHeader } from '../components/PosHeader.tsx';

const NO_BASIS: Basis = { epoch: '', rev: 0 };

// ── 고른 것 → 다시 물을 인자(화면이 하는 일은 이것뿐) ─────────────────────────────

/** 줄의 고름을 뒤집는다(두 탭을 통틀어 지금 고른 팀에서). */
export function withToggle(params: GroupPaySheetParams, view: GroupPaySheetView, orderId: string): GroupPaySheetParams {
  const now = view.selectedIds;
  return { ...params, selected: now.includes(orderId) ? now.filter((id) => id !== orderId) : [...now, orderId] };
}

/** 탭(이 팀이 내는 팀들 · 미수). */
export function withTab(params: GroupPaySheetParams, tabKey: 'group' | 'unpaid'): GroupPaySheetParams {
  return { ...params, tabKey };
}

/** 결제 수단(빠른 수단 · `기타` 판의 수단). */
export function withMethod(params: GroupPaySheetParams, methodKey: string): GroupPaySheetParams {
  return { ...params, methodKey };
}

/** 한 팀의 부분 결제(고른 품목 수). 그 팀은 고른 팀이 된다. 남은 것 모두면 서버가 부분으로 보지 않는다. */
export function withPart(params: GroupPaySheetParams, view: GroupPaySheetView, orderId: string, lines: LineUnits[]): GroupPaySheetParams {
  const parts = [...(params.parts ?? []).filter((p) => p.orderId !== orderId), { orderId, lines }];
  const selected = view.selectedIds.includes(orderId) ? view.selectedIds : [...view.selectedIds, orderId];
  return { ...params, parts, selected };
}

/** `팀 추가 · 끝 4자리`로 찾은 팀: 목록 끝에 선택된 채(이 팀이 내는 팀 탭으로). */
export function withAdded(params: GroupPaySheetParams, view: GroupPaySheetView, orderId: string): GroupPaySheetParams {
  const added = (params.added ?? []).includes(orderId) ? params.added ?? [] : [...(params.added ?? []), orderId];
  const selected = view.selectedIds.includes(orderId) ? view.selectedIds : [...view.selectedIds, orderId];
  return { ...params, added, selected, tabKey: GROUP_PAY_TABS.group };
}

/** 더한 팀 중 낼 것이 없어 빠진 팀을 인자에서 뺀다(알림은 한 번만). */
export function withoutDropped(params: GroupPaySheetParams, dropped: readonly string[]): GroupPaySheetParams {
  if (!dropped.length) return params;
  return {
    ...params,
    ...(params.added ? { added: params.added.filter((id) => !dropped.includes(id)) } : {}),
    ...(params.selected ? { selected: params.selected.filter((id) => !dropped.includes(id)) } : {}),
  };
}

/** `제외 후 수납`: 그사이 받을 금액이 바뀐 팀을 빼고 다시 묻는다(그 뒤 새 요청번호로 보낸다). */
export function withExcluded(params: GroupPaySheetParams, view: GroupPaySheetView, orderIds: readonly string[]): GroupPaySheetParams {
  return { ...params, selected: view.selectedIds.filter((id) => !orderIds.includes(id)) };
}

/** 보낼 봉투: 이 시도의 초안(요청번호 · basis)에 서버가 지금 고른 것으로 써 준 명령과 그때 본 받을 금액(expect). 명령이 없으면 null. */
export function groupPayEnvelope(draft: AnyCommandDraft, view: GroupPaySheetView): AnyCommandEnvelope | null {
  return envelopeFor(draft, view.command, view.expect);
}

/**
 * `제외 후 수납`의 바로 보내기(효과의 판단, 순수 함수): 켜져 있고 다시 물은 답이 왔으면, 보낼 명령이 있고 주 버튼을 누를 수 있을 때만 보내고
 * (send), 아니면 끈다(cancel: 사람이 주 버튼을 눌러야 보낸다). 답을 기다리는 동안은 그대로(wait).
 */
export function autoSendStep(input: { autoSend: boolean; fresh: boolean; hasDraft: boolean; sendable: boolean }): 'send' | 'cancel' | 'wait' {
  if (!input.autoSend || !input.fresh || !input.hasDraft) return 'wait';
  return input.sendable ? 'send' : 'cancel';
}

/** 초안의 모양(요청번호 · basis만 정한다: 본문 · 바탕은 보낼 때 서버가 준 것). */
const DRAFT_SHAPE: ConfirmCommand = { type: 'payment.take', payload: { orderIds: [], amount: 0, methodKey: 'card' } };

// ── 칸 폭(잰 폭으로 고르는 모양, 업무 규칙이 아님) ───────────────────────────────

/**
 * 표 칸 폭(spec 3-6, 글 폭 668에서 선택 56 · 팀 150 · 받을 금액 112 · 부분 결제 164 · 품목 나머지). 품목 칸이 누르는 곳 세 칸 폭보다 좁아지면
 * (좁은 포스) 팀 · 받을 금액 · 부분 결제 칸을 줄인다(compact). 값은 DeviceProfile에서 센다.
 */
export function groupPayColumns(profile: Pick<DeviceProfile, 'minTargetPx' | 'space'>, widthPx: number | undefined): { compact: boolean } {
  const { minTargetPx: target, space } = profile;
  const fixed = target + space.xs + (target * 3 - space.s * 0.75) + (target * 2 + space.s) + (target * 3 + space.s);
  return { compact: widthPx !== undefined && widthPx < fixed + target * 3 };
}

/** 한 쪽의 줄 수: 잰 높이 − 표 머리를 줄 높이로(온전한 줄만). 재기 전에는 모두. */
export function groupPayRowsPerPage(heightPx: number | undefined, headPx: number, rowPx: number, count: number): number {
  if (!heightPx) return Math.max(1, count);
  return Math.max(1, Math.floor((heightPx - headPx + 0.5) / rowPx));
}

// ── 화면 ──────────────────────────────────────────────────────────

type Sheet =
  | { kind: 'part'; orderId: string }
  | { kind: 'other' }
  | { kind: 'find' }
  | { kind: 'pick'; found: FindResult };

interface Notice {
  title: string;
  lines: string[];
  /** 충돌: 그사이 받을 금액이 바뀐 팀(`제외 후 수납`이 뺀다). */
  changed?: string[];
}

export function GroupPayScreen({ orderId }: { orderId: string }) {
  const client = useClient();
  const header = usePosHeader('other');
  const profile = useDeviceProfile();
  const [params, setParams] = useState<GroupPaySheetParams>({ orderId });
  /** 이 화면의 보내기 시도(요청번호 하나씩). 충돌 · 거절 뒤에 오른다. */
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; attempt: number; view: GroupPaySheetView } | null>(null);
  const [missing, setMissing] = useState(false);
  const [page, setPage] = useState(0);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [digits, setDigits] = useState('');
  const [note, setNote] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  /** `제외 후 수납`: 다시 물은 답이 오면 새 요청번호로 바로 보낸다. */
  const [autoSend, setAutoSend] = useState(false);
  const paramsKey = JSON.stringify(params);
  const asked = useRef('');
  const view = loaded?.view ?? null;
  const fresh = loaded !== null && loaded.key === paramsKey && loaded.attempt === attempt;

  useEffect(() => {
    let alive = true;
    const ask = paramsKey + '#' + attempt;
    asked.current = ask;
    client.query('groupPaySheet', params).then(
      (next) => { if (alive && asked.current === ask) { setLoaded({ key: paramsKey, attempt, view: next }); setMissing(false); } },
      (error: unknown) => { if (alive && (error as { code?: string })?.code === 'NOT_FOUND') setMissing(true); },
    );
    return () => { alive = false; };
  }, [client, paramsKey, attempt]);

  // 더한 팀 중 낼 것이 없는 팀: 한 줄 알리고 인자에서 뺀다.
  const dropped = view?.dropped ?? [];
  useEffect(() => {
    if (!dropped.length) return;
    setNotice({ title: say('addTeam'), lines: dropped.map((d) => d.note) });
    setParams((prev) => withoutDropped(prev, dropped.map((d) => d.orderId)));
  }, [dropped.map((d) => d.orderId).join()]);

  // 이 시도의 초안: 화면이 처음 그려질 때(시도마다) 한 번 만들고, 고름을 바꿔도 요청번호는 그대로다(보낼 때 본문 · 바탕만 지금 것).
  const draftKey = view ? 'grouppay:' + orderId + ':' + attempt : null;
  const { draft, markSent } = useCommandDraft(draftKey, draftKey ? DRAFT_SHAPE : null, view?.basis ?? NO_BASIS);

  const toSlip = () => {
    if (navState().fromSlip) back();
    else go({ name: 'slip', orderId }, { replace: true });
  };

  // 사람이 고른 것을 바꾸면 `제외 후 수납`의 바로 보내기는 끝난다(보내는 것은 주 버튼을 누를 때뿐).
  const change = (next: GroupPaySheetParams) => { setAutoSend(false); setParams(next); };
  // 주 버튼을 누를 수 있는 때와 같은 조건(보낼 명령 · 누를 수 있음 · 지금 고른 것의 답 · 요청번호).
  const sendable = view !== null && view.primary.enabled && view.command !== undefined && fresh && draft !== null;
  const confirm = () => {
    const envelope = draft && view && sendable && !busy ? groupPayEnvelope(draft, view) : null;
    if (!envelope) return;
    setBusy(true);
    markSent();
    client.command(envelope).then((outcome) => {
      if (isAccepted(outcome)) { toSlip(); return; }
      // 이 요청번호는 끝났다: 다음 누름은 새 시도(새 번호, 지금 자료로 다시 묻는다).
      setBusy(false);
      setAttempt((n) => n + 1);
      const changed = changedOrders(outcome);
      setNotice({ title: say('groupPay'), lines: [outcome.error?.message ?? say('commandFailed')], ...(changed.length ? { changed } : {}) });
    }, () => {
      // 보내지 못했다(연결 끊김): 같은 화면에서 다시 누르면 같은 요청번호로 다시 보낸다.
      setBusy(false);
      setNotice({ title: say('groupPay'), lines: [say('sendFailed')] });
    });
  };
  useEffect(() => {
    const step = autoSendStep({ autoSend, fresh, hasDraft: draft !== null, sendable });
    if (step === 'wait') return;
    setAutoSend(false);
    if (step === 'send') confirm();
  }, [autoSend, draft?.requestId, fresh, sendable]);

  // 줄 쪽 나누기 · 칸 폭: 표 자리를 잰다.
  const bodyRef = useRef<HTMLDivElement>(null);
  const body = useElementSize(bodyRef);
  const rows = view?.rows ?? [];
  const perPage = groupPayRowsPerPage(body?.height, profile.tableHeadPx, profile.rowPx, rows.length);
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const current = Math.min(page, pages - 1);
  const shown = rows.slice(current * perPage, (current + 1) * perPage);
  const { compact } = groupPayColumns(profile, body?.width);

  const openFind = () => { setDigits(''); setNote(undefined); setSheet({ kind: 'find' }); };
  const add = (id: string) => {
    if (!view) return;
    setSheet(null);
    change(withAdded(params, view, id));
    // 더한 팀은 목록 끝: 마지막 쪽으로.
    setPage(Number.MAX_SAFE_INTEGER);
  };
  const find = (last4: string) => {
    client.query('findLast4', { last4 }).then((found) => {
      if (found.matches.length === 1) add(found.matches[0]!.orderId);
      else if (found.matches.length === 0) setNote(say('notFound', { last4 }));
      else setSheet({ kind: 'pick', found });
    }, () => setNote(say('findFailed')));
  };
  const onMethod = (key: string) => {
    if (key === CHECKOUT_KEYS.other) setSheet({ kind: 'other' });
    else change(withMethod(params, key));
  };
  const partOf = (id: string) => params.parts?.find((p) => p.orderId === id)?.lines;

  if (missing && !view) {
    return (
      <div className="sn-screen">
        {header.element}
        <div className="pos-plain">
          <main className="pos-card">
            <h1 className="pos-card-title">{say('groupPay')}</h1>
            <p className="pos-card-line">{say('slipMissing')}</p>
            <div className="pos-card-row">
              <button type="button" className="sn-button" onClick={() => go({ name: 'ledger', date: null })}><Icon name="left" /><span>{t('home')}</span></button>
            </div>
          </main>
        </div>
        {header.overlays}
      </div>
    );
  }

  const ready = sendable;
  return (
    <div className="sn-screen">
      {header.element}
      <div className="sn-desk pos-slip-desk">
        <main className="sn-sheet pos-group" aria-label={say('groupPay')}>
          <div className="sn-titlebar">
            <h1 className="sn-title">{view?.title ?? say('groupPay')}</h1>
            <div className="sn-tabs" role="tablist" aria-label={say('pickTeams')}>
              {(view?.tabs ?? []).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  className="sn-tab"
                  aria-selected={tab.selected}
                  onClick={() => { if (!tab.selected) { change(withTab(params, tab.key === GROUP_PAY_TABS.unpaid ? 'unpaid' : 'group')); setPage(0); } }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          <div ref={bodyRef} className="pos-group-body">
            <table className={'sn-ledger-table pos-group-table' + (compact ? ' is-compact' : '')}>
              <colgroup><col className="is-check" /><col className="is-team" /><col className="is-items" /><col className="is-due" /><col className="is-pay" /></colgroup>
              <thead>
                <tr>
                  <th scope="col" className="align-center">{say('colSelect')}</th>
                  <th scope="col">{say('colTeam')}</th>
                  <th scope="col">{say('colItems')}</th>
                  <th scope="col" className="align-end">{say('colDue')}</th>
                  <th scope="col" aria-label={say('partialPick')} />
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <GroupRow
                    key={row.orderId}
                    row={row}
                    onToggle={() => { if (view) change(withToggle(params, view, row.orderId)); }}
                    onPart={() => setSheet({ kind: 'part', orderId: row.orderId })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </main>
        <aside className="pos-side pos-group-side" aria-label={say('colDue')}>
          <h2 className="pos-new-panel-title">{say('colDue')}</h2>
          {view ? (
            <>
              <div className="pos-group-money">
                <b className="pos-group-total">{formatWon(view.total.amount)}</b>
                <TextFit className="pos-group-note" input={{ mode: 'words', text: view.total.note }} />
              </div>
              <h3 className="pos-group-methods-title">{say('methodGroup')}</h3>
              <MethodGrid options={view.methods} label={say('methodGroup')} onPress={onMethod} />
              <PrimaryButton
                className="pos-group-go"
                label={busy ? t('processing') : view.primary.label}
                {...(busy || !view.primary.alts.length ? {} : { alts: view.primary.alts })}
                disabled={!ready}
                busy={busy}
                onPress={confirm}
              />
            </>
          ) : null}
        </aside>
      </div>
      <FooterBar metrics={[]} pager={<Pager page={current} pageCount={pages} onChange={setPage} />}>
        <div className="pos-footer-back">
          <button type="button" className="sn-button" onClick={toSlip}>
            <Icon name="left" />
            <span>{say('toSlip')}</span>
          </button>
          <button type="button" className="sn-button" onClick={openFind}>
            <Icon name="keypad" />
            <span>{say('addTeam')}</span>
          </button>
        </div>
      </FooterBar>
      {sheet?.kind === 'part' ? (
        <PartialPayDialog
          orderId={sheet.orderId}
          payerOrderId={orderId}
          {...(partOf(sheet.orderId) ? { initial: partOf(sheet.orderId)! } : {})}
          onPick={(lines) => { const id = sheet.orderId; setSheet(null); if (view) change(withPart(params, view, id, lines)); }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet?.kind === 'other' && view ? (
        <ChoiceSheet
          title={say('methodGroup')}
          choices={view.others.map((o) => ({ key: o.key, label: o.label }))}
          onPick={(key) => { setSheet(null); change(withMethod(params, key)); }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet?.kind === 'find' ? (
        <Keypad
          value={digits}
          onChange={(value) => { setDigits(value); setNote(undefined); }}
          onSubmit={find}
          open
          placement="sheet"
          onClose={() => setSheet(null)}
          {...(note ? { note } : {})}
        />
      ) : null}
      {sheet?.kind === 'pick' ? (
        <ChoiceSheet
          title={say('last4', { last4: sheet.found.last4 })}
          choices={sheet.found.matches.map((m) => ({ key: m.orderId, label: say('teamName', { name: m.teamName }) + ' · ' + m.last4, note: m.parts.map((p) => p.text).join(' · ') }))}
          onPick={add}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {notice ? (
        <NoticeDialog
          title={notice.title}
          lines={notice.lines}
          {...(notice.changed && view
            ? {
              actions: [{
                label: say('excludeAndPay'),
                primary: true,
                onPress: () => { const changed = notice.changed!; setNotice(null); setParams(withExcluded(params, view, changed)); setAutoSend(true); },
              }],
            }
            : {})}
          onClose={() => setNotice(null)}
        />
      ) : null}
      {header.overlays}
    </div>
  );
}

/** 표 한 줄: 선택 칸(칸 전체) · 팀(굵은 이름 · 끝 4자리 / 이름표) · 품목(좁으면 '외 N종') · 받을 금액 · 부분 결제 버튼(칸 전체). */
function GroupRow({ row, onToggle, onPart }: { row: GroupPayRow; onToggle: () => void; onPart: () => void }) {
  const [name, ...rest] = row.team.split(' · ');
  return (
    <tr className={'sn-row' + (row.selected ? '' : ' is-off')}>
      <td className="is-action">
        <SelectCell checked={row.selected} label={say('teamSelected', { team: row.team })} onToggle={onToggle} />
      </td>
      <td>
        <span className="sn-cell-stack pos-group-team">
          <TextFit input={{ mode: 'parts', parts: [{ text: name ?? row.team, drop: 0 }, ...(rest.length ? [{ text: rest.join(' · '), drop: 1 }] : [])] }} />
          <Tag text={row.tag.text} tone={row.tag.tone === 'blue' ? 'blue' : 'plain'} />
        </span>
      </td>
      <td><TextFit className="pos-group-items" input={{ mode: 'items', items: row.items.map(formatItem) }} /></td>
      <td className="align-end"><b className="pos-group-due">{formatWon(row.amount)}</b></td>
      <td className="is-action">
        <button type="button" className="pos-group-part" aria-label={row.partAria} onClick={onPart}>
          <span className="pos-group-part-face">
            <TextFit input={{ mode: 'alts', alts: row.partShort ? [row.partLabel, row.partShort] : [row.partLabel] }} />
          </span>
        </button>
      </td>
    </tr>
  );
}

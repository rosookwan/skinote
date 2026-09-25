// V1 반납 확인 창 · 부분 반납(spec 3-1, ui 6-2): 손님이 매장에 가져온 것만 반납 처리한다. 창을 열면 이 팀이 가진 것이 모두 골라져
// 있고, 안 가져온 번호만 눌러 뺀다(`모두 반납` / `일부만` 고르기는 없다). 줄 차례: ① 한 줄(`전체 선택 · 미반납 번호 해제`, 늦으면
// 빨강 `반납 지연 · 일정 22:00`) ② 품목 칸(한 줄에 둘, 세 줄까지 한 쪽, 넘치면 이 칸만 쪽 넘김) ③ 미반납 ④ 보증금 ⑤ 반환 방법.
// 창은 연 때 요청번호와 기준(basis)을 정하고(반납 하나 + 보증금 반환 하나, 뒤는 앞에 dependsOn), 사람이 고를 때마다(번호 · 수량 ·
// 반환 방법) 서버에 returnSheet를 다시 물어 줄 글 · 주 버튼 · 명령을 받는다. 화면은 계산하지 않는다: 확정하면 받은 명령의 본문만
// 연 때의 초안에 덮어 같은 요청번호로 차례로 보낸다(보증금의 바탕 expect는 연 때 본 보관 금액). 창 높이는 흔들리지 않는다
// (DialogFrame, 품목 칸은 가장 많은 쪽의 줄 수만큼 자리를 남김, ④ ⑤는 보증금을 맡은 팀이면 연 동안 늘 있음).
import {
  chainDrafts, envelopeFor, isAccepted, type AnyCommandDraft, type AnyCommandEnvelope, type Basis, type ConfirmCommand,
  type LineUnits, type ReturnPieceLine, type ReturnSheetParams, type ReturnSheetView,
} from '@skinote/contract';
import { confirmWindow } from '@skinote/layout';
import {
  ChoiceRow, DialogFrame, Pager, PrimaryButton, ReturnPieces, RichLine, piecePages, t, useCommandDraft, useUi,
} from '@skinote/ui';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useClient } from '../app/client.tsx';
import { actionLabel } from '../app/labels.ts';
import { say } from '../app/strings.ts';


const NO_BASIS: Basis = { epoch: '', rev: 0 };

// ── 고른 것 → 다시 물을 인자(화면이 하는 일은 이것뿐: 누른 번호 · 수량 · 방법을 인자에 넣는다) ─────────────────

/**
 * 지금 고른 것: 사람이 한 번이라도 골랐으면 인자의 것(누를 때마다 쌓임: 답을 기다리는 사이에 또 눌러도 앞의 것을 잃지 않는다),
 * 아니면 창이 보인 그대로(처음 연 상태 = 모두).
 */
export function pickedOf(params: ReturnSheetParams, view: ReturnSheetView): LineUnits[] {
  if (params.picked) return params.picked;
  return view.lines.map((line) => {
    if (line.mode === 'count') return { lineId: line.lineId, quantity: line.quantity?.value ?? 0 };
    const ids = (line.pieces ?? []).filter((p) => p.picked).map((p) => p.assetId);
    return { lineId: line.lineId, quantity: ids.length, assetIds: ids };
  });
}

/** 번호 하나를 넣거나 뺀다. */
export function togglePiece(params: ReturnSheetParams, view: ReturnSheetView, lineId: string, assetId: string): ReturnSheetParams {
  const picked = pickedOf(params, view).map((u) => {
    if (u.lineId !== lineId) return u;
    const ids = u.assetIds ?? [];
    const next = ids.includes(assetId) ? ids.filter((id) => id !== assetId) : [...ids, assetId];
    return { ...u, quantity: next.length, assetIds: next };
  });
  return { ...params, picked };
}

/** 수량 칸(수량으로 세는 품목)의 수. */
export function withLineQuantity(params: ReturnSheetParams, view: ReturnSheetView, lineId: string, value: number): ReturnSheetParams {
  return { ...params, picked: pickedOf(params, view).map((u) => (u.lineId === lineId ? { lineId, quantity: Math.max(0, value) } : u)) };
}

export function withRefundMethod(params: ReturnSheetParams, key: string): ReturnSheetParams {
  return { ...params, refundMethodKey: key };
}

/**
 * 확정: 연 때의 초안(요청번호 · basis)에 서버가 지금 고른 것으로 써 준 명령을 덮는다. 반납 하나와, 권이 돌아오면 보증금 반환 하나
 * (연 때 만든 초안: 반납 요청번호에 dependsOn, 바탕은 연 때 본 보관 금액). 명령이 없으면(하나도 고르지 않음) 보내지 않는다.
 */
export function returnEnvelopes(draft: AnyCommandDraft, chain: readonly AnyCommandDraft[], view: ReturnSheetView): AnyCommandEnvelope[] | null {
  const first = envelopeFor(draft, view.command);
  if (!first) return null;
  // 이어진 명령(보증금 반환)은 연 때의 초안 차례대로(요청번호 · dependsOn · 연 때 본 바탕), 본문은 지금 고른 것.
  const rest = (view.then ?? []).map((step, i) => (chain[i] ? envelopeFor(chain[i], step.command) : null));
  return rest.every((e): e is AnyCommandEnvelope => e !== null) ? [first, ...rest] : null;
}

/**
 * 품목 칸의 쪽(ui piecePages, 한 쪽 세 줄). 여러 쪽이고 보증금을 맡은 줄(권)이 첫 쪽에 없으면 그 줄들을 앞으로 옮겨 다시 나눈다: ④ 보증금
 * 줄(`권 4매 보증금 20,000원 반환`)과 같은 쪽에서 안 가져온 권 번호를 뺄 수 있게(옮기지 않으면 뒤 쪽을 넘기지 않은 채 권 보증금을 모두 돌려준다).
 */
export function returnPages(lines: readonly ReturnPieceLine[], rowsPerPage: number): ReturnPieceLine[][][] {
  const pages = piecePages(lines, rowsPerPage);
  const first = new Set((pages[0] ?? []).flat().map((l) => l.lineId));
  if (pages.length <= 1 || lines.every((l) => !l.deposit || first.has(l.lineId))) return pages;
  return piecePages([...lines.filter((l) => l.deposit), ...lines.filter((l) => !l.deposit)], rowsPerPage);
}

/** 연 때의 반납 초안 모양(본문은 확정할 때 서버가 준 것으로 바뀐다: 요청번호 · basis만 이것으로 정한다). */
const draftShape = (orderId: string): ConfirmCommand => ({ type: 'stock.direct_return', payload: { orderId, lines: [] } });

/**
 * 보낸 명령 하나가 막혔을 때(순수 함수): 앞의 반납이 적용된 뒤의 보증금(i > 0)이나 보증금만 보낸 창이면 이 창에서 새 요청번호로 다시(retry),
 * 첫 명령(반납)이 막혔으면 창을 닫고 다시 여는 것(spent).
 */
export function chainStep(index: number, refundOnly: boolean): 'retry' | 'spent' {
  return index > 0 || refundOnly ? 'retry' : 'spent';
}


// ── 번호가 많은 줄의 작은 창(`대여 12개 · 번호 선택 ›`) ─────────────────────────────

interface PiecePickSheetProps {
  line: ReturnPieceLine;
  onPiece: (assetId: string) => void;
  onClose: () => void;
}

/** 번호 버튼만 있는 작은 창. 한 쪽의 버튼 수는 창 크기(confirmWindow)와 번호 버튼 크기(누르는 곳 + 여백)로 세고 넘치면 쪽을 넘긴다. */
function PiecePickSheet({ line, onPiece, onClose }: PiecePickSheetProps) {
  const { profile, viewport } = useUi();
  const [page, setPage] = useState(0);
  const box = confirmWindow(viewport, profile.confirm, 1, 0);
  const cell = profile.minTargetPx + profile.space.m + profile.space.s;
  const columns = Math.max(1, Math.floor((box.widthPx - 2 * profile.confirm.paddingXPx + profile.space.s) / cell));
  const rows = Math.max(1, Math.floor((box.heightPx - profile.confirm.titlePx - profile.confirm.primaryRowPx - 2 * profile.space.m + profile.space.s) / (profile.minTargetPx + profile.space.s)));
  const perPage = columns * rows;
  const pieces = line.pieces ?? [];
  const pageCount = Math.max(1, Math.ceil(pieces.length / perPage));
  const current = Math.min(page, pageCount - 1);
  const style = { '--pos-picker-columns': String(columns) } as CSSProperties;
  return (
    <DialogFrame
      title={say('piecesOf', { item: line.ariaLabel ?? line.label })}
      onClose={onClose}
      className="pos-return-picker"
      pager={pageCount > 1 ? <Pager page={current} pageCount={pageCount} onChange={setPage} /> : null}
    >
      <div className="pos-picker-grid" role="group" aria-label={say('piecesOf', { item: line.ariaLabel ?? line.label })} style={style}>
        {pieces.slice(current * perPage, (current + 1) * perPage).map((piece) => (
          <button key={piece.assetId} type="button" className="sn-button sn-choice sn-piece" aria-pressed={piece.picked} onClick={() => onPiece(piece.assetId)}>
            {piece.label}
          </button>
        ))}
      </div>
    </DialogFrame>
  );
}

// ── 창 ───────────────────────────────────────────────────────────

export interface ReturnDialogProps {
  orderId: string;
  /** 줄 하나의 반납 칸을 눌러 열면 그 줄만(없으면 모든 줄). */
  lineIds?: string[];
  onClose: () => void;
  /** 창을 닫고 한 줄 알림(열지 못함 · 다른 카운터가 먼저 처리함). */
  onNotice: (title: string, line: string) => void;
}

export function ReturnDialog({ orderId, lineIds, onClose, onNotice }: ReturnDialogProps) {
  const client = useClient();
  const { profile } = useUi();
  const [params, setParams] = useState<ReturnSheetParams>(() => ({ orderId, ...(lineIds?.length ? { lineIds } : {}) }));
  const [loaded, setLoaded] = useState<{ key: string; view: ReturnSheetView } | null>(null);
  /**
   * 시도: 창을 연 때 0. 반납은 되었는데 이어 보낸 보증금 반환이 막히면 오른다(data-model 4-18 `창 안에서 다시 보임`): 그 시도의 읽기 모델로
   * 새 요청번호의 초안을 만든다(돌려받을 것이 없으면 보증금 반환 하나).
   */
  const [attempt, setAttempt] = useState(0);
  /** 이 시도를 연 때의 읽기 모델(초안의 바탕 · 명령 모양). */
  const [opened, setOpened] = useState<{ attempt: number; view: ReturnSheetView } | null>(null);
  const [page, setPage] = useState(0);
  const [picker, setPicker] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 첫 명령(반납)이 적용되지 않았다: 창을 닫고 다시 열어야 새 요청번호가 된다(sync 2절). */
  const [spent, setSpent] = useState(false);
  const paramsKey = JSON.stringify(params);
  const asked = useRef('');
  const view = loaded?.view ?? null;
  const stale = loaded !== null && loaded.key !== paramsKey + '#' + attempt;

  useEffect(() => {
    let alive = true;
    const ask = paramsKey + '#' + attempt;
    asked.current = ask;
    client.query('returnSheet', params).then(
      (next) => {
        if (!alive || asked.current !== ask) return;
        setLoaded({ key: ask, view: next });
        setOpened((first) => (first && first.attempt === attempt ? first : { attempt, view: next }));
      },
      () => { if (!alive) return; if (loaded) setError(say('openFailed')); else onNotice(actionLabel('stamp.return'), say('openFailed')); },
    );
    return () => { alive = false; };
  }, [client, paramsKey, attempt]);

  const base = opened && opened.attempt === attempt ? opened.view : null;
  const shape = useMemo(() => (base ? draftShape(orderId) : null), [base !== null, orderId]);
  const { draft, markSent } = useCommandDraft(base ? 'return:' + orderId + ':' + (lineIds ?? []).join(',') + ':' + attempt : null, shape, base?.basis ?? NO_BASIS);
  // 이어진 명령(보증금 반환)의 초안: 반납 초안(요청번호)이 정해지면 한 번(앞 명령에 dependsOn, 바탕은 연 때 본 보관 금액 · 미수).
  const steps = base?.then ?? view?.then;
  const chain = useMemo(() => (draft && steps?.length ? chainDrafts(draft, steps) : []), [draft?.requestId, steps?.length ?? 0]);
  // 보증금 반환만 하는 창(돌려받을 것은 없고 돌아온 권의 보증금이 남음): 그 명령의 초안(바탕은 연 때 본 보관 금액).
  const refundShape = base?.command?.type === 'deposit.return' ? base.command : null;
  const refund = useCommandDraft(refundShape ? 'refund:' + orderId + ':' + attempt : null, refundShape, base?.basis ?? NO_BASIS, base?.expect ? { expect: base.expect } : {});

  if (!view) return null;

  // 다시 고르면 알림 한 줄을 지운다(요청번호를 쓴 뒤의 실패는 창을 닫을 때까지 남긴다: 주 버튼도 누를 수 없다).
  const change = (next: ReturnSheetParams) => { if (!spent) setError(null); setParams(next); };
  const refundOnly = view.command?.type === 'deposit.return';
  const confirm = () => {
    if (busy || spent || stale) return;
    const envelopes = refundOnly
      ? refund.draft ? [envelopeFor(refund.draft, view.command)].filter((e): e is AnyCommandEnvelope => e !== null) : null
      : draft ? returnEnvelopes(draft, chain, view) : null;
    if (!envelopes) return;
    setBusy(true);
    if (refundOnly) refund.markSent();
    else markSent();
    (async () => {
      for (const [i, envelope] of envelopes.entries()) {
        const outcome = await client.command(envelope);
        if (isAccepted(outcome)) continue;
        // 반납이 이미 끝났으면(다른 카운터) 창을 닫고 한 줄.
        if (i === 0 && !refundOnly && outcome.outcome === 'superseded') { onNotice(view.title, outcome.error?.message ?? say('alreadyDone')); return; }
        setBusy(false);
        setError(outcome.error?.message ?? say('commandFailed'));
        // 반납은 되었는데 보증금이 막혔다(또는 보증금만 보냈다): 이 창에서 지금 자료로 보증금을 다시 묻는다(새 요청번호). 반납부터 막혔으면
        // 창을 닫고 다시 연다.
        if (chainStep(i, refundOnly) === 'retry') setAttempt((n) => n + 1);
        else setSpent(true);
        return;
      }
      onClose();
    })().catch(() => {
      // 보내지 못했다(연결 끊김): 같은 창에서 다시 누르면 같은 요청번호로 처음부터 다시 보낸다(된 명령은 서버가 처음 결과를 준다).
      setBusy(false);
      setError(say('sendFailed'));
    });
  };

  // 한 쪽의 품목 칸 줄 수(DeviceProfile pages, spec 3-1: 세 줄까지 한 쪽, 창 500 ≤ 1024×529의 한도 505).
  const pages = returnPages(view.lines, profile.pages.returnPieceRows);
  const rowCount = Math.max(1, ...pages.map((p) => p.length));
  const current = Math.min(page, pages.length - 1);
  const ready = view.primary.enabled && view.command !== undefined && (refundOnly ? refund.draft !== null : draft !== null) && !stale && !spent;
  const pickerLine = picker ? view.lines.find((l) => l.lineId === picker) : undefined;

  return (
    <>
      <DialogFrame
        title={view.title}
        onClose={onClose}
        className="pos-return"
        {...(refundOnly && refund.draft ? { requestId: refund.draft.requestId } : draft ? { requestId: draft.requestId } : {})}
        pager={pages.length > 1 ? <Pager page={current} pageCount={pages.length} onChange={setPage} /> : null}
        primary={(
          <PrimaryButton
            label={busy ? t('processing') : view.primary.label}
            {...(busy ? {} : { alts: view.primary.alts.length ? view.primary.alts : [view.primary.label] })}
            disabled={!ready}
            busy={busy}
            onPress={confirm}
          />
        )}
      >
        <p className="pos-return-lead"><RichLine runs={view.lead} /></p>
        <ReturnPieces
          rows={pages[current] ?? []}
          rowCount={rowCount}
          groupLabel={(line) => say(line.mode === 'count' ? 'qtyOf' : 'piecesOf', { item: line.ariaLabel ?? line.label })}
          onPiece={(lineId, assetId) => change(togglePiece(params, view, lineId, assetId))}
          onQuantity={(lineId, value) => change(withLineQuantity(params, view, lineId, value))}
          onPicker={setPicker}
        />
        {error ? (
          <p className="pos-return-left is-alert" role="alert"><RichLine runs={[{ text: error, strong: true }]} /></p>
        ) : (
          <p className="pos-return-left"><RichLine runs={view.remainder} /></p>
        )}
        {view.deposit ? <p className="pos-return-deposit"><RichLine runs={view.deposit} /></p> : null}
        {view.refundMethods ? (
          <div className="pos-return-refund">
            <span className="sn-form-label">{say('refundMethod')}</span>
            <ChoiceRow options={view.refundMethods} label={say('refundMethodGroup')} onPress={(key) => change(withRefundMethod(params, key))} />
          </div>
        ) : null}
      </DialogFrame>
      {pickerLine ? (
        <PiecePickSheet line={pickerLine} onPiece={(assetId) => change(togglePiece(params, view, pickerLine.lineId, assetId))} onClose={() => setPicker(null)} />
      ) : null}
    </>
  );
}

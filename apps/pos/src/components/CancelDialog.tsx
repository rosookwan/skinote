// 접수증 옆 동작 `접수 취소` · `품목 취소`의 창(features-1 §5-4): 품목 취소는 취소할 수 있는 줄마다 −/+(반납 창의 수량 칸과 같은 모양, 처음 0), 접수
// 취소는 `구분`(취소 요청 · 연락 없음). 그 아래 돈 줄 `환불`(환불 · 미수 결제 · 환불 없음, 비운 돈이 없으면 자리만), 환불 줄 두 줄(수납마다 원래 수단 ·
// 현금, 카드면 `단말기 취소`, 셋 이상이면 그 자리 안에서 쪽 넘김), 요약(`취소 금액 225,000원 · 환불 105,000원`, 접수 취소의 둘째 줄 `이정호 팀 결제 예정 해제`).
// 창은 연 때 요청번호와 기준(basis)을 정하고(useCommandDraft · chainDrafts: 환불은 취소의 요청번호를 dependsOn으로), 사람이 고를 때마다(수 · 구분 · 결정 ·
// 수단) 서버에 cancelSheet를 다시 물어 줄 글 · 주 버튼 · 명령을 받는다. 화면은 금액을 셈하지 않는다. 창 높이는 흔들리지 않는다: 수량 칸은 잰 창
// 높이로 센 줄 수만큼 자리를 남기고(넘치면 바닥줄 쪽 넘김), 돈 줄 · 환불 두 줄 · 요약은 늘 자리를 지킨다.
import {
  chainDrafts, envelopeFor, isAccepted, type AnyCommandEnvelope, type Basis, type CancelScope, type CancelSheetParams, type CancelSheetView, type ConfirmCommand,
  type LineUnits,
} from '@skinote/contract';
import { confirmWindow } from '@skinote/layout';
import {
  ChoiceRow, DialogFrame, FormRow, Pager, PrimaryButton, ReturnPieces, RichLine, piecePages, t, useCommandDraft, useUi,
} from '@skinote/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '../app/client.tsx';
import { say } from '../app/strings.ts';
import { REFUND_LINE_ROWS, RefundRows } from './RefundRows.tsx';

const NO_BASIS: Basis = { epoch: '', rev: 0 };
/** 환불 줄 자리(두 줄, 셋 이상이면 그 자리 안에서 쪽 넘김, RefundRows). */
export const CANCEL_REFUND_ROWS = REFUND_LINE_ROWS;

// ── 고른 것 → 다시 물을 인자 ────────────────────────────────────────────

/** 지금 고른 수(한 번이라도 골랐으면 인자의 것, 아니면 창이 보인 것). */
export function pickedOf(params: CancelSheetParams, view: CancelSheetView): LineUnits[] {
  return params.picked ?? view.picked;
}

/** 품목 취소의 수 하나. */
export function withCancelQuantity(params: CancelSheetParams, view: CancelSheetView, lineId: string, value: number): CancelSheetParams {
  const picked = pickedOf(params, view);
  const next = picked.some((x) => x.lineId === lineId)
    ? picked.map((x) => (x.lineId === lineId ? { lineId, quantity: Math.max(0, value) } : x))
    : [...picked, { lineId, quantity: Math.max(0, value) }];
  return { ...params, picked: next };
}

/** 접수 취소의 구분(취소 요청 · 연락 없음): 결정은 그 구분의 처음 값으로 다시(E8). */
export function withReason(params: CancelSheetParams, key: string): CancelSheetParams {
  const { decision: _drop, ...rest } = params;
  return { ...rest, reasonKey: key === 'no_show' ? 'no_show' : 'request' };
}

/** 비운 돈의 결정(환불 · 미수 결제 · 환불 없음). */
export function withDecision(params: CancelSheetParams, key: string): CancelSheetParams {
  return key === 'refund' || key === 'apply_to_due' || key === 'no_refund' ? { ...params, decision: key } : params;
}

/** 환불 줄의 수단(그 수납의 수단 · 현금). */
export const withMethod = (params: CancelSheetParams, paymentId: string, methodKey: string): CancelSheetParams => ({
  ...params, methods: { ...params.methods, [paymentId]: methodKey },
});

/**
 * 품목 취소의 수량 칸 줄 수(잰 창 높이의 모양 계산, 업무 규칙이 아님): 창 높이 − 제목 − 바닥 − 본문 위아래 여백 − 돈 줄 − 환불 두 줄 − 요약 한 줄 →
 * 누르는 곳 높이 + 사이로 몇 줄. 적어도 1, 반납 창의 끝(returnPieceRows)까지.
 */
export function cancelPieceRows(heightPx: number, profile: {
  confirm: { titlePx: number; primaryRowPx: number }; space: { s: number; m: number }; minTargetPx: number; minFontPx: number; pages: { returnPieceRows: number };
}): number {
  const { space, minTargetPx: target } = profile;
  const fixed = profile.confirm.titlePx + profile.confirm.primaryRowPx + 2 * space.m + (target + space.s) + (CANCEL_REFUND_ROWS * target + space.s + space.s)
    + (profile.minFontPx * 2 + space.s);
  const rows = Math.floor((heightPx - fixed + space.s) / (target + space.s));
  return Math.max(1, Math.min(profile.pages.returnPieceRows, rows));
}

/** 창을 연 때의 초안 모양(본문은 확정할 때 서버가 준 것으로 바뀐다: 요청번호 · basis만 이것으로 정한다). */
const draftShape = (orderId: string, scope: CancelScope): ConfirmCommand => ({
  type: 'order.cancel', payload: { orderId, scope, lines: [], reasonKey: 'request', decision: 'not_applicable' },
});

// ── 창 ───────────────────────────────────────────────────────────

export interface CancelDialogProps {
  orderId: string;
  scope: CancelScope;
  onClose: () => void;
  /** 창을 열지 못함(연결 끊김): 부르는 쪽이 한 줄 알림. */
  onFail: (line: string) => void;
}

export function CancelDialog({ orderId, scope, onClose, onFail }: CancelDialogProps) {
  const client = useClient();
  const { profile, viewport } = useUi();
  const [params, setParams] = useState<CancelSheetParams>({ orderId, scope });
  const [loaded, setLoaded] = useState<{ key: string; view: CancelSheetView } | null>(null);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 이 요청번호로 보낸 명령이 적용되지 않았다: 창을 닫고 다시 열어야 새 요청번호가 된다(sync 2절). */
  const [spent, setSpent] = useState(false);
  const paramsKey = JSON.stringify(params);
  const asked = useRef('');
  const view = loaded?.view ?? null;
  const stale = loaded !== null && loaded.key !== paramsKey;

  useEffect(() => {
    let alive = true;
    asked.current = paramsKey;
    client.query('cancelSheet', params).then(
      (next) => { if (alive && asked.current === paramsKey) setLoaded({ key: paramsKey, view: next }); },
      () => { if (alive) { if (loaded) setError(say('openFailed')); else onFail(say('openFailed')); } },
    );
    return () => { alive = false; };
  }, [client, paramsKey]);

  const shape = useMemo(() => (view ? draftShape(orderId, scope) : null), [view !== null, orderId, scope]);
  const { draft, markSent } = useCommandDraft(view ? 'cancel:' + orderId + ':' + scope : null, shape, view?.basis ?? NO_BASIS);
  // 이어진 환불(있을 때만)의 초안: 창을 연 때의 취소 요청번호를 dependsOn으로.
  const steps = view?.then;
  const chain = useMemo(() => (draft && steps?.length ? chainDrafts(draft, steps) : []), [draft?.requestId, steps?.length ?? 0]);

  if (!view) return null;

  const change = (next: CancelSheetParams) => { if (!spent) setError(null); setParams(next); };
  const confirm = () => {
    if (busy || spent || stale || !draft) return;
    const first = envelopeFor(draft, view.command, view.expect);
    const rest = (view.then ?? []).map((step, i) => (chain[i] ? envelopeFor(chain[i]!, step.command, step.expect) : null));
    if (!first || rest.some((x) => x === null)) return;
    const envelopes = [first, ...(rest as AnyCommandEnvelope[])];
    setBusy(true);
    markSent();
    (async () => {
      for (const envelope of envelopes) {
        const outcome = await client.command(envelope);
        if (isAccepted(outcome)) continue;
        setBusy(false);
        setSpent(true);
        setError(outcome.error?.message ?? say('commandFailed'));
        return;
      }
      onClose();
    })().catch(() => {
      // 보내지 못했다(연결 끊김): 같은 창에서 다시 누르면 같은 요청번호로 처음부터 다시 보낸다(된 명령은 서버가 처음 결과를 준다).
      setBusy(false);
      setError(say('sendFailed'));
    });
  };

  // 품목 취소의 수량 칸: 잰 창 높이로 센 줄 수만큼 한 쪽, 넘치면 바닥줄 쪽 넘김.
  const box = confirmWindow(viewport, profile.confirm, 1, 0);
  const rowsPerPage = cancelPieceRows(box.heightPx, profile);
  const pages = scope === 'lines' ? piecePages(view.lines, rowsPerPage) : [[]];
  const rowCount = scope === 'lines' ? Math.max(1, ...pages.map((p) => p.length)) : 0;
  const current = Math.min(page, pages.length - 1);
  const alert = error ?? view.notice ?? null;
  const ready = view.primary.enabled && view.command !== undefined && !stale && !spent && draft !== null;
  const summaryRows = scope === 'order' ? 2 : 1;
  const summary = alert ? [[{ text: alert, strong: true }]] : view.summary;

  return (
    <DialogFrame
      title={view.title}
      onClose={onClose}
      className={'pos-cancel is-' + scope}
      {...(draft ? { requestId: draft.requestId } : {})}
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
      {scope === 'lines' ? (
        <div className="pos-cancel-pieces" role="group" aria-label={say('cancelPieces')}>
          <ReturnPieces
            rows={pages[current] ?? []}
            rowCount={rowCount}
            groupLabel={(line) => say('qtyOf', { item: line.ariaLabel ?? line.label })}
            onPiece={() => undefined}
            onQuantity={(lineId, value) => change(withCancelQuantity(params, view, lineId, value))}
            onPicker={() => undefined}
          />
        </div>
      ) : (
        <FormRow label={say('cancelReason')}>
          <ChoiceRow options={view.reasons ?? []} label={say('cancelReason')} onPress={(key) => change(withReason(params, key))} />
        </FormRow>
      )}
      <FormRow label={say('cancelMoney')} blank={!view.decisions}>
        <ChoiceRow options={view.decisions ?? []} label={say('cancelMoney')} onPress={(key) => change(withDecision(params, key))} />
      </FormRow>
      <RefundRows lines={view.refunds} onMethod={(paymentId, key) => change(withMethod(params, paymentId, key))} />
      <div className={'pos-cancel-summary' + (alert ? ' is-alert' : '')} {...(alert ? { role: 'alert' } : {})}>
        {Array.from({ length: summaryRows }, (_, i) => (
          <p key={i} className="pos-cancel-summary-line">{summary[i] ? <RichLine runs={summary[i]!} /> : null}</p>
        ))}
      </div>
    </DialogFrame>
  );
}

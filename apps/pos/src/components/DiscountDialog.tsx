// 접수증 옆 동작 `할인 적용`의 창(features-1 §6-2 · §6-5): 한 팀의 결제 칸(장비 · 리프트권)마다 할인을 적용 · 변경 · 해제한다. 결제 뒤면 더 낸 돈을
// 이어서 환불한다(그 수납의 수단 또는 현금, 환불 줄의 수단 버튼).
// 창은 연 때 요청번호와 기준(basis)을 정하고(useCommandDraft · chainDrafts: 환불은 할인 적용의 요청번호를 dependsOn으로), 사람이 고를 때마다(칸 ·
// 할인 · 직접 입력 · 환불 수단) 서버에 discountSheet를 다시 물어 요약 · 환불 줄 · 주 버튼 · 명령을 받는다. 화면은 금액을 셈하지 않는다.
// 창 높이는 흔들리지 않는다: 칸 줄은 칸이 하나여도 그 칸을 보이고, 할인 고르기는 두 줄(넘치면 쪽 넘김), 환불 줄은 두 줄 자리를 늘 남긴다.
import {
  CHECKOUT_KEYS, chainDrafts, envelopeFor, isAccepted, type AnyCommandEnvelope, type Basis, type ConfirmCommand, type DiscountChoice,
  type DiscountSheetParams, type DiscountSheetView,
} from '@skinote/contract';
import { listColumns } from '@skinote/layout';
import {
  ChoiceButton, ChoiceRow, DialogFrame, FormRow, Pager, PrimaryButton, RichLine, t, useCommandDraft, useElementSize, useUi,
} from '@skinote/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '../app/client.tsx';
import { say } from '../app/strings.ts';
import { ManualDiscountFlow } from './ManualDiscountFlow.tsx';
import { REFUND_LINE_ROWS, RefundRows } from './RefundRows.tsx';

const NO_BASIS: Basis = { epoch: '', rev: 0 };
/** 할인 고르기의 줄 수(창 높이 고정: 1024×529의 한도 505 안, plan §6-5). */
export const DISCOUNT_CHOICE_ROWS = 2;
/** 환불 줄 자리(두 줄, 셋 이상이면 그 자리 안에서 쪽 넘김, RefundRows). */
export const DISCOUNT_REFUND_ROWS = REFUND_LINE_ROWS;

// ── 고른 것 → 다시 물을 인자 ────────────────────────────────────────────

/** 칸: 고른 할인 · 환불 수단은 그 칸의 처음 것으로(칸마다 지금 할인이 다르다). */
export const withSection = (params: DiscountSheetParams, sectionKey: 'gear' | 'lift'): DiscountSheetParams => ({ orderId: params.orderId, sectionKey });

/** 할인 고르기의 key → 고른 것(`할인 없음` = 해제, 매장 할인). `직접 입력`은 숫자판 · 사유 뒤에 withManual. */
export function withChoice(params: DiscountSheetParams, view: DiscountSheetView, key: string): DiscountSheetParams {
  const choice: DiscountChoice = key === CHECKOUT_KEYS.noDiscount ? { none: true } : { ruleKey: key };
  return { orderId: params.orderId, sectionKey: view.sectionKey, choice, ...(params.methods ? { methods: params.methods } : {}) };
}

export function withManual(params: DiscountSheetParams, view: DiscountSheetView, manual: { kind: 'amount' | 'percent'; value: number; reason: string }): DiscountSheetParams {
  return { orderId: params.orderId, sectionKey: view.sectionKey, choice: { manual }, ...(params.methods ? { methods: params.methods } : {}) };
}

/** 환불 줄의 수단(그 수납의 수단 · 현금). */
export const withRefundMethod = (params: DiscountSheetParams, view: DiscountSheetView, paymentId: string, methodKey: string): DiscountSheetParams => ({
  ...params, sectionKey: view.sectionKey, choice: view.choice, methods: { ...params.methods, [paymentId]: methodKey },
});

/** 창을 연 때의 초안 모양(본문은 확정할 때 서버가 준 것으로 바뀐다). */
const draftShape = (orderId: string): ConfirmCommand => ({ type: 'discount.apply', payload: { orderId, sectionKey: 'gear', choice: { none: true } } });

// ── 창 ───────────────────────────────────────────────────────────

export interface DiscountDialogProps {
  orderId: string;
  onClose: () => void;
  /** 창을 열지 못함(연결 끊김): 부르는 쪽이 한 줄 알림. */
  onFail: (line: string) => void;
}

export function DiscountDialog({ orderId, onClose, onFail }: DiscountDialogProps) {
  const client = useClient();
  const { profile } = useUi();
  const [params, setParams] = useState<DiscountSheetParams>({ orderId });
  const [loaded, setLoaded] = useState<{ key: string; view: DiscountSheetView } | null>(null);
  const [manual, setManual] = useState(false);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 이 요청번호로 보낸 명령이 적용되지 않았다: 창을 닫고 다시 열어야 새 요청번호가 된다(sync 2절). */
  const [spent, setSpent] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const grid = useElementSize(gridRef);
  const paramsKey = JSON.stringify(params);
  const asked = useRef('');
  const view = loaded?.view ?? null;
  const stale = loaded !== null && loaded.key !== paramsKey;

  useEffect(() => {
    let alive = true;
    asked.current = paramsKey;
    client.query('discountSheet', params).then(
      (next) => { if (alive && asked.current === paramsKey) setLoaded({ key: paramsKey, view: next }); },
      () => { if (alive) { if (loaded) setError(say('openFailed')); else onFail(say('openFailed')); } },
    );
    return () => { alive = false; };
  }, [client, paramsKey]);

  const shape = useMemo(() => (view ? draftShape(orderId) : null), [view !== null, orderId]);
  const { draft, markSent } = useCommandDraft(view ? 'discount:' + orderId : null, shape, view?.basis ?? NO_BASIS);
  // 이어진 환불(있을 때만)의 초안: 창을 연 때의 할인 적용 요청번호를 dependsOn으로.
  const steps = view?.then;
  const chain = useMemo(() => (draft && steps?.length ? chainDrafts(draft, steps) : []), [draft?.requestId, steps?.length ?? 0]);

  if (!view) return null;

  const change = (next: DiscountSheetParams) => { setParams(next); setError(null); };
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

  // 할인 고르기: 잰 폭에 들어가는 칸 수(DeviceProfile의 끝 수까지) × 두 줄, 넘치면 쪽.
  const columns = grid ? listColumns(grid.width, view.choices.map((c) => c.label + (c.opens ? ' ›' : '')), profile.baseFontPx, profile.space.m, profile.space.s, profile.pages.choiceGridColumns) : profile.pages.choiceGridColumns;
  const perPage = Math.max(1, columns * DISCOUNT_CHOICE_ROWS);
  const pageCount = Math.max(1, Math.ceil(view.choices.length / perPage));
  const current = Math.min(page, pageCount - 1);
  const shown = view.choices.slice(current * perPage, (current + 1) * perPage);
  const alert = error ?? view.notice ?? null;
  const ready = view.primary.enabled && view.command !== undefined && !stale && !spent && draft !== null;
  const onChoice = (key: string) => {
    const option = view.choices.find((c) => c.key === key);
    if (!option?.enabled) return;
    if (key === CHECKOUT_KEYS.manual) setManual(true);
    else change(withChoice(params, view, key));
  };

  return (
    <>
      <DialogFrame
        title={view.title}
        onClose={onClose}
        className="pos-discount"
        {...(draft ? { requestId: draft.requestId } : {})}
        pager={pageCount > 1 ? <Pager page={current} pageCount={pageCount} onChange={setPage} /> : null}
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
        <FormRow label={say('discountTarget')}>
          <ChoiceRow options={view.sections} label={say('discountTarget')} onPress={(key) => change(withSection(params, key as 'gear' | 'lift'))} />
        </FormRow>
        <FormRow label={say('discountChoice')} top>
          <div ref={gridRef} className="pos-discount-grid" role="group" aria-label={say('discountChoice')} style={{ gridTemplateColumns: 'repeat(' + columns + ', minmax(0, 1fr))' }}>
            {shown.map((c) => <ChoiceButton key={c.key} option={c} onPress={onChoice} />)}
          </div>
        </FormRow>
        <p className={'pos-discount-summary' + (alert ? ' is-alert' : '')} {...(alert ? { role: 'alert' } : {})}>
          <RichLine runs={alert ? [{ text: alert, strong: true }] : view.summary} />
        </p>
        <RefundRows lines={view.refunds} onMethod={(paymentId, key) => change(withRefundMethod(params, view, paymentId, key))} />
      </DialogFrame>
      {manual && view.manual ? (
        <ManualDiscountFlow
          spec={view.manual}
          onDone={(value) => { setManual(false); change(withManual(params, view, value)); }}
          onClose={() => setManual(false)}
        />
      ) : null}
    </>
  );
}

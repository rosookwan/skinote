// 접수증 옆 동작 `즉시 교환`의 창(features-1 §7-2 · §7-5): 교환 품목(손님에게 있는 것 · 지급 전 것의 줄 · 사이즈마다 버튼, 넘치면 같은 줄의 `더 보기`) ·
// 수량(−/+, 이름 `반납 사이즈` · `지급 예정 사이즈`와 둘째 줄의 지금 사이즈) · 지급 사이즈(그 종류의 다른 사이즈, 두 줄 · 넘치면 바닥 쪽 넘김) · 요약
// 한 줄(`헬멧 중 사이즈 → 대 사이즈 · 1개 · 금액 유지`) · 주 버튼(`즉시 교환 · 헬멧 1개`). 기사 기기에는 없다(E14).
// 창은 연 때 요청번호와 기준(basis)을 정하고(useCommandDraft), 사람이 고를 때마다 서버에 exchangeSheet를 다시 물어 줄 글 · 주 버튼 · 명령을 받는다.
// 화면은 무엇을 바꿀 수 있는지 셈하지 않는다. 창 높이는 흔들리지 않는다: 줄마다 자리를 지키고(품목이 없으면 빈 자리), 사이즈는 늘 두 줄이다.
import {
  envelopeFor, isAccepted, type Basis, type ConfirmCommand, type ExchangeSheetParams, type ExchangeSheetView,
} from '@skinote/contract';
import { listColumns } from '@skinote/layout';
import {
  ChoiceButton, ChoiceRow, DialogFrame, FormRow, Pager, PrimaryButton, QtyStepper, RichLine, t, useCommandDraft, useElementSize, useUi,
} from '@skinote/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '../app/client.tsx';
import { say } from '../app/strings.ts';

const NO_BASIS: Basis = { epoch: '', rev: 0 };
/** 지급 사이즈의 줄 수(창 높이 고정: 1024×529의 한도 505 안, plan §7-5). */
export const EXCHANGE_SIZE_ROWS = 2;

// ── 고른 것 → 다시 물을 인자 ────────────────────────────────────────────

/** 교환 품목(버튼 key → 줄 · 옛 사이즈 · 지급 전인지): 수와 지급 사이즈는 새로(그 품목의 처음). */
export function withItem(params: ExchangeSheetParams, view: ExchangeSheetView, key: string): ExchangeSheetParams {
  const item = view.items.find((x) => x.key === key);
  return item ? { orderId: params.orderId, lineId: item.lineId, from: item.from, planned: item.planned } : params;
}

/** 지금 고른 품목(창이 보인 것)을 인자에 굳힌다. */
const pinned = (params: ExchangeSheetParams, view: ExchangeSheetView): ExchangeSheetParams => ({
  orderId: params.orderId,
  ...(view.lineId !== undefined ? { lineId: view.lineId } : {}),
  ...(view.from !== undefined ? { from: view.from } : {}),
  ...(view.planned !== undefined ? { planned: view.planned } : {}),
  ...(view.quantity ? { quantity: view.quantity.input.value } : {}),
  ...(view.to !== undefined ? { to: view.to } : {}),
});

/** 수량 −/+. */
export const withQuantity = (params: ExchangeSheetParams, view: ExchangeSheetView, value: number): ExchangeSheetParams => ({ ...pinned(params, view), quantity: value });

/** 지급 사이즈. */
export const withSize = (params: ExchangeSheetParams, view: ExchangeSheetView, key: string): ExchangeSheetParams => ({ ...pinned(params, view), to: key });

/** 창을 연 때의 초안 모양(본문은 확정할 때 서버가 준 것으로 바뀐다: 요청번호 · basis만 이것으로 정한다). */
const draftShape = (orderId: string): ConfirmCommand => ({ type: 'exchange.swap', payload: { orderId, lineId: '', quantity: 1, from: '', to: '', planned: false } });

// ── 창 ───────────────────────────────────────────────────────────

export interface ExchangeDialogProps {
  orderId: string;
  onClose: () => void;
  /** 창을 열지 못함(연결 끊김): 부르는 쪽이 한 줄 알림. */
  onFail: (line: string) => void;
}

export function ExchangeDialog({ orderId, onClose, onFail }: ExchangeDialogProps) {
  const client = useClient();
  const { profile } = useUi();
  const [params, setParams] = useState<ExchangeSheetParams>({ orderId });
  const [loaded, setLoaded] = useState<{ key: string; view: ExchangeSheetView } | null>(null);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 이 요청번호로 보낸 명령이 적용되지 않았다: 창을 닫고 다시 열어야 새 요청번호가 된다(sync 2절). */
  const [spent, setSpent] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const grid = useElementSize(gridRef);
  const paramsKey = JSON.stringify(params);
  /** 거절 뒤 창을 다시 묻는다(그사이 반납돼 바꿀 것이 없어진 창이 옛 줄을 그대로 보이지 않게, 2026-09-27 점검). */
  const [reload, setReload] = useState(0);
  const asked = useRef('');
  const view = loaded?.view ?? null;
  const stale = loaded !== null && loaded.key !== paramsKey;

  useEffect(() => {
    let alive = true;
    asked.current = paramsKey;
    client.query('exchangeSheet', params).then(
      (next) => { if (alive && asked.current === paramsKey) setLoaded({ key: paramsKey, view: next }); },
      () => { if (alive) { if (loaded) setError(say('openFailed')); else onFail(say('openFailed')); } },
    );
    return () => { alive = false; };
  }, [client, paramsKey, reload]);

  const shape = useMemo(() => (view ? draftShape(orderId) : null), [view !== null, orderId]);
  const { draft, markSent } = useCommandDraft(view ? 'exchange:' + orderId : null, shape, view?.basis ?? NO_BASIS);

  if (!view) return null;

  const change = (next: ExchangeSheetParams) => { if (!spent) setError(null); setParams(next); };
  const confirm = () => {
    if (busy || spent || stale || !draft) return;
    const envelope = envelopeFor(draft, view.command);
    if (!envelope) return;
    setBusy(true);
    markSent();
    client.command(envelope).then((outcome) => {
      if (isAccepted(outcome)) { onClose(); return; }
      setBusy(false);
      setSpent(true);
      setError(outcome.error?.message ?? say('commandFailed'));
      // 처음 고른 것 없이 지금 상태로 다시 그린다(교환할 것이 없으면 빈 자리와 거절 한 줄만).
      setParams({ orderId });
      setReload((n) => n + 1);
    }, () => {
      // 보내지 못했다(연결 끊김): 같은 창에서 다시 누르면 같은 요청번호로 다시 보낸다(된 명령은 서버가 처음 결과를 준다).
      setBusy(false);
      setError(say('sendFailed'));
    });
  };

  // 지급 사이즈: 잰 폭에 들어가는 칸 수(DeviceProfile의 끝 수까지) × 두 줄, 넘치면 쪽(부츠 220 ~ 300).
  const columns = grid ? listColumns(grid.width, view.sizes.map((c) => c.label), profile.baseFontPx, profile.space.m, profile.space.s, profile.pages.choiceGridColumns) : profile.pages.choiceGridColumns;
  const perPage = Math.max(1, columns * EXCHANGE_SIZE_ROWS);
  const pageCount = Math.max(1, Math.ceil(view.sizes.length / perPage));
  const current = Math.min(page, pageCount - 1);
  const shown = view.sizes.slice(current * perPage, (current + 1) * perPage);
  const alert = error ?? view.notice ?? null;
  const ready = view.primary.enabled && view.command !== undefined && !stale && !spent && draft !== null;
  const quantity = view.quantity;

  return (
    <DialogFrame
      title={view.title}
      onClose={onClose}
      className="pos-exchange"
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
      <FormRow label={say('exchangeItem')} blank={view.items.length === 0}>
        <ChoiceRow options={view.items} label={say('exchangeItem')} onPress={(key) => { setPage(0); change(withItem(params, view, key)); }} />
      </FormRow>
      <FormRow label={say('exchangeQty')} blank={!quantity} className="pos-exchange-qty">
        {quantity ? (
          <QtyStepper
            name={quantity.name}
            note={quantity.note}
            quantity={quantity.input}
            label={say('qtyOf', { item: quantity.name })}
            onChange={(value) => change(withQuantity(params, view, value))}
          />
        ) : null}
      </FormRow>
      <FormRow label={say('exchangeSize')} top blank={view.sizes.length === 0}>
        <div ref={gridRef} className="pos-exchange-grid" role="group" aria-label={say('exchangeSize')} style={{ gridTemplateColumns: 'repeat(' + columns + ', minmax(0, 1fr))' }}>
          {shown.map((c) => <ChoiceButton key={c.key} option={c} onPress={(key) => change(withSize(params, view, key))} />)}
        </div>
      </FormRow>
      <p className={'pos-exchange-summary' + (alert ? ' is-alert' : '')} {...(alert ? { role: 'alert' } : {})}>
        <RichLine runs={alert ? [{ text: alert, strong: true }] : view.summary} />
      </p>
    </DialogFrame>
  );
}

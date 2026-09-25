// V4 접수 확정 창 · 칸별 수납(spec 3-3, ui 4-5 · 6-4): 새 접수의 ③ 결제. 결제 칸마다 받을 금액과 수단을 정하고 한 번에 접수를 확정한다
// (order.create 하나: 약속 · 결제 약속 · 칸별 수납 · 보증금 입금). 뒤 화면은 ② 일정(V3) 그대로다.
// 창은 연 때 요청번호와 기준(basis)을 정하고(useCommandDraft), 사람이 누를 때마다(수단 · 할인 · 결제 팀) 서버에 checkoutSheet를 다시
// 물어 칸 글 · 결제 팀 줄 · 받을 금액 줄 · 주 버튼 · 명령을 받는다. 화면은 계산하지 않는다: 확정하면 받은 명령의 본문과 그때 본 가격
// (expect.quoteHash)을 연 때의 초안에 덮어 같은 요청번호로 보낸다. 적용되면 새 접수의 접수증으로 간다(부르는 쪽, 주소 바꿈).
// 창 높이는 흔들리지 않는다(spec 2-1 다): 결제 팀 줄은 `후불`인 칸이 없어도 자리를 지키고(visibility hidden), 받을 금액 줄은 알림이 와도
// 같은 한 줄이다. 작은 창: `할인 적용 ›`(그 칸 할인 묶음), `기타`(간편결제 · 상품권 · `다른 팀 결제`), `다른 팀 찾기 · 끝 4자리`(숫자판).
import {
  CHECKOUT_KEYS, createdOrder, envelopeFor, type AnyCommandDraft, type AnyCommandEnvelope, type Basis, type CheckoutChoice,
  type CheckoutSheetParams, type CheckoutSheetView, type ConfirmCommand, type FindResult, type OrderDraftInput,
} from '@skinote/contract';
import { ChoiceRow, DialogFrame, Icon, Keypad, MethodRow, PrimaryButton, RichLine, t, useCommandDraft } from '@skinote/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '../app/client.tsx';
import { say } from '../app/strings.ts';
import { ChoiceSheet } from './NoticeDialog.tsx';

const NO_BASIS: Basis = { epoch: '', rev: 0 };
/** 그사이 반납 시각이 지나는지(10분 이내 · 시간 지남) 다시 읽는 간격. */
const REFRESH_MS = 60_000;

// ── 고른 것 → 다시 물을 인자(화면이 하는 일은 이것뿐: 누른 수단 · 할인 · 팀을 인자에 넣는다) ─────────────────

/** 지금 선택(한 번이라도 눌렀으면 인자의 것, 아니면 창이 보인 칸마다의 선택). */
export function choicesOf(params: CheckoutSheetParams, view: CheckoutSheetView): CheckoutChoice[] {
  return params.choices ?? view.sections.map((s) => s.choice);
}

const replace = (params: CheckoutSheetParams, view: CheckoutSheetView, sectionKey: string, make: (current: CheckoutChoice) => CheckoutChoice): CheckoutSheetParams => ({
  ...params,
  choices: choicesOf(params, view).map((c) => (c.sectionKey === sectionKey ? make(c) : c)),
});

/** 수단(빠른 수단 · `후불` · 기타 판의 수단). 할인은 그대로, 이 칸만의 결제 팀은 지운다. */
export function withMethod(params: CheckoutSheetParams, view: CheckoutSheetView, sectionKey: string, methodKey: string): CheckoutSheetParams {
  return replace(params, view, sectionKey, (c) => ({ sectionKey, methodKey, ...(c.discountKey ? { discountKey: c.discountKey } : {}) }));
}

/** 할인(`할인 없음`이면 뺀다). 수단 · 결제 팀은 그대로. */
export function withDiscount(params: CheckoutSheetParams, view: CheckoutSheetView, sectionKey: string, discountKey: string): CheckoutSheetParams {
  return replace(params, view, sectionKey, ({ discountKey: _drop, ...rest }) => ({ ...rest, ...(discountKey !== CHECKOUT_KEYS.noDiscount ? { discountKey } : {}) }));
}

/** `기타` 판의 `다른 팀 결제`: 이 칸만 찾은 팀이 낸다(후불). */
export function withSectionPayer(params: CheckoutSheetParams, view: CheckoutSheetView, sectionKey: string, orderId: string): CheckoutSheetParams {
  return replace(params, view, sectionKey, (c) => ({ sectionKey, methodKey: CHECKOUT_KEYS.later, ...(c.discountKey ? { discountKey: c.discountKey } : {}), payerOrderId: orderId }));
}

/** 결제 팀 줄(이 팀 = self, 아니면 그 팀의 접수 id): `후불`인 칸 모두에 건다. */
export function withPayer(params: CheckoutSheetParams, key: string): CheckoutSheetParams {
  return { ...params, payerOrderId: key === CHECKOUT_KEYS.self ? null : key };
}

/** 끝 4자리로 찾은 팀을 결제 팀 줄의 버튼 자리에 남긴다(이 창 안에서, 가장 최근 것이 앞). */
export function withFound(params: CheckoutSheetParams, orderId: string): CheckoutSheetParams {
  return { ...params, foundPayerIds: [orderId, ...(params.foundPayerIds ?? []).filter((id) => id !== orderId)] };
}

/** 확정: 연 때의 초안(요청번호 · basis)에 서버가 지금 선택으로 써 준 명령과 그때 본 가격(expect)을 덮는다. 명령이 없으면 보내지 않는다. */
export function checkoutEnvelope(draft: AnyCommandDraft, view: CheckoutSheetView): AnyCommandEnvelope | null {
  return envelopeFor(draft, view.command, view.expect);
}

/** 연 때의 초안 모양(본문 · 가격은 확정할 때 서버가 준 것으로 바뀐다: 요청번호 · basis만 이것으로 정한다). */
const draftShape = (draft: OrderDraftInput): ConfirmCommand => ({ type: 'order.create', payload: { draft, choices: [], payerOrderId: null } });

// ── 창 ───────────────────────────────────────────────────────────

/** 팀 찾기가 누구의 결제 팀을 정하는지: 결제 팀 줄(`후불`인 칸 모두) 또는 한 칸(`기타` → `다른 팀 결제`). */
type FindTarget = { kind: 'row' } | { kind: 'section'; sectionKey: string };

type Sheet =
  | { kind: 'discount'; sectionKey: string }
  | { kind: 'other'; sectionKey: string }
  | { kind: 'find'; target: FindTarget }
  | { kind: 'pick'; target: FindTarget; found: FindResult };

export interface CheckoutDialogProps {
  draft: OrderDraftInput;
  onClose: () => void;
  /** 접수 확정이 적용됨: 새 접수(부르는 쪽이 초안을 지우고 접수증으로 간다). */
  onDone: (orderId: string) => void;
}

export function CheckoutDialog({ draft: orderDraft, onClose, onDone }: CheckoutDialogProps) {
  const client = useClient();
  const [params, setParams] = useState<CheckoutSheetParams>({ draft: orderDraft });
  const [loaded, setLoaded] = useState<{ key: string; view: CheckoutSheetView } | null>(null);
  const [tick, setTick] = useState(0);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [digits, setDigits] = useState('');
  const [note, setNote] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 이 요청번호로 보낸 명령이 적용되지 않았다: 창을 닫고 다시 열어야 새 요청번호가 된다(sync 2절). */
  const [spent, setSpent] = useState(false);
  const paramsKey = JSON.stringify(params);
  const asked = useRef('');
  const view = loaded?.view ?? null;
  const stale = loaded !== null && loaded.key !== paramsKey;

  useEffect(() => {
    const off = client.subscribe(() => setTick((n) => n + 1));
    const timer = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => { off(); clearInterval(timer); };
  }, [client]);
  useEffect(() => {
    let alive = true;
    const ask = paramsKey + '#' + tick;
    asked.current = ask;
    client.query('checkoutSheet', params).then(
      (next) => { if (alive && asked.current === ask) setLoaded({ key: paramsKey, view: next }); },
      () => { if (alive) setError(say('openFailed')); },
    );
    return () => { alive = false; };
  }, [client, paramsKey, tick]);

  const shape = useMemo(() => (view ? draftShape(orderDraft) : null), [view !== null]);
  const { draft, markSent } = useCommandDraft(view ? 'checkout:new' : null, shape, view?.basis ?? NO_BASIS);

  if (!view) return null;

  const change = (next: CheckoutSheetParams) => { setParams(next); setError(null); };
  const confirm = () => {
    const envelope = draft && !busy && !spent && !stale ? checkoutEnvelope(draft, view) : null;
    if (!envelope) return;
    setBusy(true);
    markSent();
    client.command(envelope).then((outcome) => {
      const created = createdOrder(outcome);
      if (created) { onDone(created.orderId); return; }
      setBusy(false);
      setSpent(true);
      setError(outcome.error?.message ?? say('commandFailed'));
    }, () => {
      // 보내지 못했다(연결 끊김): 같은 창에서 다시 누르면 같은 요청번호로 다시 보낸다.
      setBusy(false);
      setError(say('sendFailed'));
    });
  };

  const openFind = (target: FindTarget) => { setDigits(''); setNote(undefined); setSheet({ kind: 'find', target }); };
  const applyTeam = (target: FindTarget, orderId: string) => {
    setSheet(null);
    const found = withFound(params, orderId);
    change(target.kind === 'row' ? withPayer(found, orderId) : withSectionPayer(found, view, target.sectionKey, orderId));
  };
  const find = (target: FindTarget, last4: string) => {
    client.query('findLast4', { last4 }).then((found) => {
      if (found.matches.length === 1) applyTeam(target, found.matches[0]!.orderId);
      else if (found.matches.length === 0) setNote(say('notFound', { last4 }));
      else setSheet({ kind: 'pick', target, found });
    }, () => setNote(say('findFailed')));
  };
  const onMethod = (sectionKey: string, key: string) => {
    if (key === CHECKOUT_KEYS.other) setSheet({ kind: 'other', sectionKey });
    else change(withMethod(params, view, sectionKey, key));
  };

  const section = (key: string) => view.sections.find((s) => s.key === key);
  const alert = error ?? view.notice ?? null;
  const ready = view.primary.enabled && view.command !== undefined && !stale && !spent;

  return (
    <>
      <DialogFrame
        title={view.title}
        onClose={onClose}
        className="pos-checkout"
        {...(draft ? { requestId: draft.requestId } : {})}
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
        {view.sections.map((s) => (
          <MethodRow
            key={s.key}
            section={s}
            onMethod={(key) => onMethod(s.key, key)}
            {...(s.discountable ? { onDiscount: () => setSheet({ kind: 'discount', sectionKey: s.key }) } : {})}
          />
        ))}
        <div className={'pos-checkout-payer' + (view.payer.visible ? '' : ' is-blank')} {...(view.payer.visible ? {} : { 'aria-hidden': true })}>
          <span className="pos-checkout-payer-label">{view.payer.label}</span>
          <ChoiceRow options={view.payer.options} label={say('payerGroup')} onPress={(key) => change(withPayer(params, key))} />
          <button type="button" className="sn-button sn-choice pos-checkout-find" onClick={() => openFind({ kind: 'row' })}>
            <Icon name="keypad" />
            <span>{say('findOtherTeam')}</span>
          </button>
        </div>
        <p className={'pos-checkout-due' + (alert ? ' is-alert' : '')} {...(alert ? { role: 'alert' } : {})}>
          <RichLine runs={alert ? [{ text: alert, strong: true }] : view.due} />
        </p>
      </DialogFrame>
      {sheet?.kind === 'discount' && section(sheet.sectionKey) ? (
        <ChoiceSheet
          title={t('discountApplyFor', { section: section(sheet.sectionKey)!.label })}
          choices={(section(sheet.sectionKey)!.discounts ?? []).map((o) => ({ key: o.key, label: o.label }))}
          onPick={(key) => { setSheet(null); change(withDiscount(params, view, sheet.sectionKey, key)); }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet?.kind === 'other' && section(sheet.sectionKey) ? (
        <ChoiceSheet
          title={t('methodsFor', { section: section(sheet.sectionKey)!.label })}
          choices={(section(sheet.sectionKey)!.others ?? []).map((o) => ({ key: o.key, label: o.label }))}
          onPick={(key) => {
            if (key === CHECKOUT_KEYS.otherTeam) openFind({ kind: 'section', sectionKey: sheet.sectionKey });
            else { setSheet(null); change(withMethod(params, view, sheet.sectionKey, key)); }
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet?.kind === 'find' ? (
        <Keypad
          value={digits}
          onChange={(value) => { setDigits(value); setNote(undefined); }}
          onSubmit={(last4) => find(sheet.target, last4)}
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
          onPick={(key) => applyTeam(sheet.target, key)}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}

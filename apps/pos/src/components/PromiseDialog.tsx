// V9 일정 변경 · 부분 품목(spec 3-2, ui 6-2 N2): 한 팀 품목의 일부 수량만 반납 일정(시각 · 장소 · 수거 차량)을 바꾸는 창.
// 창은 연 때 요청번호와 기준(basis)을 정하고(useCommandDraft), 사람이 고를 때마다(수량 · 반납 타임 · 날 · 장소 · 차량) 서버에
// promiseSheet를 다시 물어 줄 글 · 요약 · 주 버튼 · 명령을 받는다. 화면은 계산하지 않는다: 확정하면 받은 명령의 본문만 초안에 덮어
// 같은 요청번호로 보낸다(draftToEnvelope). 날을 옮겨 연장 값이 붙으면 창이 본 견적(expect)을 함께 보낸다.
// 창 높이는 흔들리지 않는다: 변경 품목 칸은 두 줄 자리를 늘 남기고, `매장 직접`이면 수거 차량 줄은 자리만 남는다(DialogFrame).
// 카운터가 끊겼을 때 · 기사 기기에서는 열지 않는다(부르는 쪽이 한 줄 알림, sync 8-2).
import {
  envelopeFor, isAccepted, type AnyCommandDraft, type AnyCommandEnvelope, type Basis, type ConfirmCommand, type PlacePick, type PromiseSheetParams,
  type PromiseSheetView, type SlotPick,
} from '@skinote/contract';
import {
  ChoiceRow, DialogFrame, FormRow, Pager, PlaceChooser, PrimaryButton, QtyStepper, RichLine, SlotChooser, t, useCommandDraft,
} from '@skinote/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '../app/client.tsx';
import { say } from '../app/strings.ts';
import { ChoiceSheet, NoticeDialog } from './NoticeDialog.tsx';

/** 변경 품목 칸: 한 줄에 둘, 두 줄(spec 3-2 ① 112 = 52 + 8 + 52). 품목 줄이 넷을 넘으면 이 칸만 쪽을 넘긴다. */
const ITEMS_PER_ROW = 2;
const ITEM_ROWS = 2;
export const PROMISE_ITEMS_PER_PAGE = ITEMS_PER_ROW * ITEM_ROWS;

const NO_BASIS: Basis = { epoch: '', rev: 0 };

// ── 고른 것 → 다시 물을 인자(화면이 하는 일은 이것뿐: 누른 것을 인자에 넣는다) ─────────────────────

/** 지금 고른 날(인자에 없으면 창이 보인 날: 내일 · 다른 날이 켜져 있으면 그 날, 아니면 오늘). */
function dayOf(params: PromiseSheetParams, view: PromiseSheetView): SlotPick['day'] {
  if (params.slot) return params.slot.day;
  if (view.days.find((d) => d.key === 'tomorrow')?.selected) return 'tomorrow';
  return view.calendar.find((d) => d.selected)?.key ?? 'today';
}

/** 지금 고른 반납 타임(없으면 '' = 시각 그대로). */
const slotKeyOf = (params: PromiseSheetParams, view: PromiseSheetView) => params.slot?.slotKey ?? view.slots.find((s) => s.selected)?.key ?? '';

export function withQuantity(params: PromiseSheetParams, lineId: string, value: number): PromiseSheetParams {
  return { ...params, quantities: { ...params.quantities, [lineId]: value } };
}

export function withSlot(params: PromiseSheetParams, view: PromiseSheetView, slotKey: string): PromiseSheetParams {
  return { ...params, slot: { day: dayOf(params, view), slotKey } };
}

/** `내일`은 켜고 끄는 버튼(끄면 오늘), 날짜(`다른 날 ›`의 작은 창에서 고른 영업일)는 그 날. 반납 타임은 그대로. */
export function withDay(params: PromiseSheetParams, view: PromiseSheetView, day: 'tomorrow' | string): PromiseSheetParams {
  const on = day === 'tomorrow' ? view.days.find((d) => d.key === 'tomorrow')?.selected === true : false;
  return { ...params, slot: { day: day === 'tomorrow' ? (on ? 'today' : 'tomorrow') : day, slotKey: slotKeyOf(params, view) } };
}

export function withPlace(params: PromiseSheetParams, place: PlacePick): PromiseSheetParams {
  return { ...params, place };
}

export function withVehicle(params: PromiseSheetParams, vehicleId: string): PromiseSheetParams {
  return { ...params, vehicleId };
}

/**
 * 확정: 창을 연 때의 초안(요청번호 · basis)에 서버가 지금 고른 것으로 써 준 명령을 덮고, 창이 본 견적(연장 값)을 함께 보낸다.
 * 명령이 없으면(수량 0 · 일정 그대로 · 리프트권 날짜 변경) 보내지 않는다.
 */
export function promiseEnvelope(draft: AnyCommandDraft, view: PromiseSheetView): AnyCommandEnvelope | null {
  return envelopeFor(draft, view.command, view.expect);
}

/** 창을 연 때의 초안을 만들 명령 모양(본문은 확정할 때 서버가 준 것으로 바뀐다: 요청번호 · basis만 이것으로 정한다). */
const draftShape = (orderId: string): ConfirmCommand => ({ type: 'promise.change', payload: { orderId, kind: 'return', lines: [], promise: { mode: 'store' } } });

// ── 창 ───────────────────────────────────────────────────────────

export interface PromiseDialogProps {
  orderId: string;
  onClose: () => void;
  /** 창을 열지 못함(연결 끊김): 부르는 쪽이 한 줄 알림. */
  onFail: (line: string) => void;
}

export function PromiseDialog({ orderId, onClose, onFail }: PromiseDialogProps) {
  const client = useClient();
  const [params, setParams] = useState<PromiseSheetParams>({ orderId });
  const [loaded, setLoaded] = useState<{ key: string; view: PromiseSheetView } | null>(null);
  const [page, setPage] = useState(0);
  const [calendar, setCalendar] = useState(false);
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
    client.query('promiseSheet', params).then(
      (next) => { if (alive && asked.current === paramsKey) setLoaded({ key: paramsKey, view: next }); },
      () => { if (alive) { if (loaded) setError(say('openFailed')); else onFail(say('openFailed')); } },
    );
    return () => { alive = false; };
  }, [client, paramsKey]);

  const shape = useMemo(() => (view ? draftShape(orderId) : null), [view !== null, orderId]);
  const { draft, markSent } = useCommandDraft(view ? 'promise:' + orderId : null, shape, view?.basis ?? NO_BASIS);

  if (!view) return null;
  if (view.lines.length === 0) return <NoticeDialog title={view.title} lines={view.notice ? [view.notice] : []} onClose={onClose} />;

  const change = (next: PromiseSheetParams) => setParams(next);
  const confirm = () => {
    const envelope = draft && !busy && !spent && !stale ? promiseEnvelope(draft, view) : null;
    if (!envelope) return;
    setBusy(true);
    markSent();
    client.command(envelope).then((outcome) => {
      if (isAccepted(outcome)) {
        onClose();
        return;
      }
      setBusy(false);
      setSpent(true);
      setError(outcome.error?.message ?? (outcome.outcome === 'superseded' ? say('alreadyDone') : say('commandFailed')));
    }, () => {
      // 보내지 못했다(연결 끊김): 같은 창에서 다시 누르면 같은 요청번호로 다시 보낸다.
      setBusy(false);
      setError(say('sendFailed'));
    });
  };

  const pageCount = Math.max(1, Math.ceil(view.lines.length / PROMISE_ITEMS_PER_PAGE));
  const current = Math.min(page, pageCount - 1);
  const lines = view.lines.slice(current * PROMISE_ITEMS_PER_PAGE, (current + 1) * PROMISE_ITEMS_PER_PAGE);
  // 변경 품목 칸의 줄 수는 가장 많은 쪽 기준(쪽을 넘겨도 창 높이가 그대로).
  const itemRows = Math.min(ITEM_ROWS, Math.ceil(Math.min(view.lines.length, PROMISE_ITEMS_PER_PAGE) / ITEMS_PER_ROW));
  const alert = error ?? view.notice ?? null;
  const ready = view.primary.enabled && view.command !== undefined && !stale && !spent;

  return (
    <>
      <DialogFrame
        title={view.title}
        onClose={onClose}
        className="pos-promise"
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
        <FormRow label={say('changeItems')} top>
          <div className={'sn-steps' + (itemRows > 1 ? ' is-two-rows' : '')}>
            {lines.map((line) => (
              <QtyStepper
                key={line.lineId}
                name={line.label}
                note={line.note}
                quantity={line.quantity}
                label={say('qtyOf', { item: line.label })}
                onChange={(value) => change(withQuantity(params, line.lineId, value))}
              />
            ))}
          </div>
        </FormRow>
        <FormRow label={say('returnTime')}>
          <SlotChooser
            slots={view.slots}
            days={view.days}
            label={say('returnTime')}
            names={{ other: say('pickDay') }}
            onSlot={(key) => change(withSlot(params, view, key))}
            onDay={(key) => (key === 'tomorrow' ? change(withDay(params, view, 'tomorrow')) : setCalendar(true))}
          />
        </FormRow>
        <FormRow label={say('returnPlace')}>
          <PlaceChooser
            areas={view.areas}
            place={view.place}
            label={say('returnPlace')}
            againName={(place) => say('placeAgain', { place })}
            onPick={(place) => change(withPlace(params, place))}
          />
        </FormRow>
        <FormRow label={say('pickupVehicle')} blank={!view.vehicleRowVisible}>
          <ChoiceRow options={view.vehicles} label={say('pickupVehicle')} onPress={(key) => change(withVehicle(params, key))} />
        </FormRow>
        <div className="sn-summary">
          {alert ? (
            <p className="sn-summary-row is-alert" role="alert"><b>{say('summaryChanged')}</b><RichLine runs={[{ text: alert, strong: true }]} /></p>
          ) : (
            <p className="sn-summary-row"><b>{say('summaryChanged')}</b><RichLine runs={view.summary.changed} /></p>
          )}
          <p className="sn-summary-row"><b>{say('summaryKept')}</b><RichLine runs={view.summary.kept} /></p>
        </div>
      </DialogFrame>
      {calendar ? (
        <ChoiceSheet
          title={say('pickDay')}
          choices={view.calendar.map((c) => ({ key: c.key, label: c.label }))}
          onPick={(key) => { setCalendar(false); change(withDay(params, view, key)); }}
          onClose={() => setCalendar(false)}
        />
      ) : null}
    </>
  );
}

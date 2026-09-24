// 도장 · 주 버튼 · 옆 동작을 누르면: 서버에 확인 창 초안을 묻고(confirmDraft) → 확인 창(요청번호는 창이 열릴 때 만듦) →
// 명령 → 창을 닫는다. 도장은 이 창을 거친 뒤에만 찍힌다(docs/53). 확정할 것이 없으면 창 대신 한 문장 알림.
// 화면은 무엇을 몇 개 보낼지 계산하지 않는다: 초안의 명령을 그대로 보내고, 사람이 고른 수량 · 수단만 넣는다.
// 돈 결정의 바탕(expect: 받을 돈)은 창을 연 때 초안에 넣어 명령과 함께 보낸다(ui 7절, sync 4-2).
// 연결이 끊겨 묻거나 보내지 못하면 '처리 중'을 풀고 쉬운 한 문장을 보인다(같은 창에서 다시 누르면 같은 요청번호).
import {
  draftToEnvelope, type ActionKey, type AnyCommandDraft, type AnyCommandEnvelope, type Basis, type ConfirmCommand, type ConfirmDraftParams,
  type ConfirmDraftView, type OpenDraftOptions, type StampCell, type StampStepRow,
} from '@skinote/contract';
import { ConfirmDialog, formatTime, useCommandDraft } from '@skinote/ui';
import { useCallback, useState, type ReactNode } from 'react';
import { useClient } from '../app/client.tsx';
import { actionLabel } from '../app/labels.ts';
import { say } from '../app/strings.ts';
import { NoticeDialog, type NoticeAction } from './NoticeDialog.tsx';

export interface ConfirmRequest extends ConfirmDraftParams {
  /** 창 맨 위에 붙일 한 문장(막힌 칸을 눌러 앞 단계 창이 열렸을 때). */
  lead?: string;
}

export interface Notice {
  title: string;
  lines: string[];
  actions?: NoticeAction[];
}

export interface ConfirmFlow {
  open: (request: ConfirmRequest) => void;
  notify: (notice: Notice | null) => void;
  /** 창이나 알림이 열려 있다(그동안 새로 고침을 미룬다). */
  active: boolean;
  element: ReactNode;
}

const NO_BASIS: Basis = { epoch: '', rev: 0 };

function draftKey(request: ConfirmRequest): string {
  return ['confirm', request.orderId ?? request.taskId ?? request.vehicleId ?? '', request.actionKey, ...(request.lineIds ?? [])].join(':');
}

/** 줄 하나만 고른 창의 수량 −/+를 본문에 넣는다. */
function withQuantity<P extends { lines: { lineId: string; quantity: number }[] }>(payload: P, qty: number | null): P {
  const [only] = payload.lines;
  return qty !== null && only && payload.lines.length === 1 ? { ...payload, lines: [{ ...only, quantity: qty }] } : payload;
}

/** 창에서 사람이 고른 것(수량 · 수단)만 본문에 넣는다. 종류는 그대로다. */
export function withChoices(command: ConfirmCommand, qty: number | null, method: string | null): ConfirmCommand {
  switch (command.type) {
    case 'payment.take': return method ? { type: command.type, payload: { ...command.payload, methodKey: method } } : command;
    case 'stock.issue': return { type: command.type, payload: withQuantity(command.payload, qty) };
    case 'stock.direct_return': return { type: command.type, payload: withQuantity(command.payload, qty) };
    case 'stock.load': return { type: command.type, payload: withQuantity(command.payload, qty) };
    case 'stock.collect': return { type: command.type, payload: withQuantity(command.payload, qty) };
    default: return command;
  }
}

/** 창을 열 때 초안에 고정할 것: 돈 결정의 바탕(expect)과 먼저 적용될 명령(dependsOn). 서버가 준 초안 그대로. */
export function draftOptions(view: ConfirmDraftView | null): OpenDraftOptions {
  return { ...(view?.expect ? { expect: view.expect } : {}), ...(view?.dependsOn ? { dependsOn: view.dependsOn } : {}) };
}

/** 확정: 창을 연 때의 초안(요청번호 · basis · expect)에 사람이 고른 수량 · 수단만 넣은 봉투. */
export function confirmEnvelope(draft: AnyCommandDraft, command: ConfirmCommand, qty: number | null, method: string | null): AnyCommandEnvelope {
  return draftToEnvelope(draft, {}, withChoices(command, qty, method));
}

/** 주 버튼 글: 초안의 동작 이름에, 수량 −/+가 있으면 지금 수량을 붙인다('지급 처리 · 2개', 수를 바꾸면 따라 바뀜). */
export function confirmText(view: ConfirmDraftView, qty: number | null): string {
  const label = view.confirmLabel ?? view.title;
  return view.quantity && qty !== null ? say('confirmQty', { label, n: qty, unit: view.quantity.unit }) : label;
}

export function useConfirmFlow(): ConfirmFlow {
  const client = useClient();
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [view, setView] = useState<ConfirmDraftView | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [qty, setQty] = useState<number | null>(null);
  const [method, setMethod] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const command = view?.command ?? null;
  const key = request && command ? draftKey(request) : null;
  const { draft, markSent } = useCommandDraft(key, command, view?.basis ?? NO_BASIS, draftOptions(view));

  const close = useCallback(() => {
    setRequest(null);
    setView(null);
    setError(null);
    setBusy(false);
  }, []);

  const open = useCallback((next: ConfirmRequest) => {
    client.query('confirmDraft', next).then((draftView) => {
      if (!draftView.command) {
        setNotice({ title: draftView.title, lines: [...(next.lead ? [next.lead] : []), draftView.notice ?? ''] });
        return;
      }
      setNotice(null);
      setRequest(next);
      setView(draftView);
      setQty(draftView.quantity?.value ?? null);
      setMethod(draftView.methods?.[0]?.key ?? null);
      setError(null);
      setBusy(false);
    }, () => {
      setNotice({ title: actionLabel(next.actionKey), lines: [say('openFailed')] });
    });
  }, [client]);

  const confirm = useCallback(() => {
    if (!draft || !command || busy) return;
    setBusy(true);
    markSent();
    client.command(confirmEnvelope(draft, command, qty, method)).then((outcome) => {
      // queued: 오프라인 기사 기기가 보냄 대기에 넣었다(목록에 점선 도장). 창은 닫는다.
      if (outcome.outcome === 'applied' || outcome.outcome === 'partially_applied' || outcome.outcome === 'queued') {
        close();
      } else if (outcome.outcome === 'superseded') {
        const title = view?.title ?? '';
        close();
        setNotice({ title, lines: [outcome.error?.message ?? say('alreadyDone')] });
      } else {
        setBusy(false);
        setError(outcome.error?.message ?? say('commandFailed'));
      }
    }, () => {
      // 보내지 못했다(연결 끊김): '처리 중'을 풀고, 같은 창에서 다시 누르면 같은 요청번호로 다시 보낸다.
      setBusy(false);
      setError(say('sendFailed'));
    });
  }, [draft, command, busy, client, qty, method, close, view, markSent]);

  const element = (
    <>
      {view && draft && command ? (
        <ConfirmDialog
          open
          title={view.title}
          summary={[...(request?.lead ? [request.lead] : []), ...view.summary]}
          {...(view.quantity && qty !== null ? { quantity: { ...view.quantity, value: qty }, onQuantityChange: setQty } : {})}
          confirmLabel={confirmText(view, qty)}
          onConfirm={confirm}
          onClose={close}
          busy={busy}
          requestId={draft.requestId}
        >
          {view.methods ? (
            <div className="pos-methods" role="group" aria-label={say('methodGroup')}>
              {view.methods.map((m) => (
                <button key={m.key} type="button" className="sn-button pos-method" aria-pressed={m.key === method} onClick={() => setMethod(m.key)}>
                  {m.label}
                </button>
              ))}
            </div>
          ) : null}
          {error ? <p className="pos-dialog-error" role="alert">{error}</p> : null}
        </ConfirmDialog>
      ) : null}
      {notice ? <NoticeDialog title={notice.title} lines={notice.lines} {...(notice.actions ? { actions: notice.actions } : {})} onClose={() => setNotice(null)} /> : null}
    </>
  );

  return { open, notify: setNotice, active: request !== null || notice !== null, element };
}

/**
 * 도장 칸을 눌렀을 때(장부 · 접수증 · 수거 목록 같음). 서버가 알림(pressNote)을 붙였으면 창 대신 그 문장과 대신 할 동작(차량이 할 도장,
 * 이 기기가 찍지 않는 도장, 전송 대기, 다른 팀 결제 예정). 그 밖에는 상태로: 미처리 · 부분 → 그 단계의 확인 창, 대기 → 막고 있는
 * 단계의 창(첫 줄에 '반납 불가 · 지급 대기'), 완료 → '지급 완료 · 09:26', 예정 → 한 줄('이정호 팀 결제 예정')과 '직접 수납'.
 * 알림 창 제목은 단계 이름 + 팀('반납 · 김민재 팀')이다. 확인 창 제목(동작 이름 + 팀)과 같은 모양.
 */
export function pressStamp(
  flow: ConfirmFlow,
  steps: ReadonlyMap<string, StampStepRow>,
  timezone: string,
  target: { orderId: string; lineIds?: string[]; taskId?: string; teamName?: string },
  cell: StampCell,
  dispatch: (actionKey: ActionKey) => void,
): void {
  const step = steps.get(cell.stepKey);
  if (!step) return;
  const { teamName, ...draftTarget } = target;
  const title = teamName ? say('noticeTitle', { label: step.label, name: teamName }) : step.label;
  const openStep = (actionKey: StampStepRow['action_key'], lead?: string) => flow.open({ ...draftTarget, actionKey, ...(lead ? { lead } : {}) });
  if (cell.pressNote) {
    const action = cell.pressNote.action;
    flow.notify({
      title,
      lines: cell.pressNote.lines,
      ...(action ? { actions: [{ label: action.label, onPress: () => { flow.notify(null); dispatch(action.actionKey); } }] } : {}),
    });
    return;
  }
  switch (cell.state) {
    case 'todo':
    case 'partial':
      openStep(step.action_key);
      return;
    case 'blocked': {
      const blocker = cell.blockedBy ? steps.get(cell.blockedBy.stepKey) : undefined;
      // 까닭은 짧은 표시('반납 불가 · 지급 대기')라 마침표를 붙이지 않는다.
      const message = cell.blockedBy?.message ?? say('blockedDefault');
      if (blocker && blocker.key !== step.key) openStep(blocker.action_key, message);
      else flow.notify({ title, lines: [message] });
      return;
    }
    case 'done':
      flow.notify({ title, lines: [cell.at ? say('stampedAt', { label: step.label, time: formatTime(cell.at, timezone) }) : say('stamped', { label: step.label })] });
      return;
    case 'delegated':
      flow.notify({ title, lines: [say('delegatedTo', { who: cell.delegatedTo ?? say('vehicle') })] });
      return;
    case 'scheduled':
      flow.notify({
        title,
        lines: [say('scheduledNote', { note: cell.scheduledNote ?? say('scheduledDefault') })],
        actions: [{ label: say('payNow'), onPress: () => openStep(step.action_key) }],
      });
      return;
    case 'na':
      return;
  }
}

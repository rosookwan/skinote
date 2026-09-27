// `분실 처리` · `분실 회수` 창(features-1 §8-2): 리프트권 화면의 미반납 · 분실 줄과 접수증 옆 동작 `분실 처리`가 연다. 권 줄마다 −/+(반납 창의 수량
// 칸과 같은 모양, 처음 값은 모두), 줄 `청구 없음`(손님에게 청구하지 않음)과 수거가 없어지면 `22:10 만선 티롤 앞 수거 취소`, 주 버튼
// `분실 처리 · 야간권 1매`. 예비권 적재 · 입고 창(SpareDialog)도 같은 틀(PieceSheet)을 쓴다.
// 창은 연 때 요청번호와 기준(basis)을 정하고(useCommandDraft), 수를 바꿀 때마다 서버에 창을 다시 물어 줄 글 · 주 버튼 · 명령을 받는다. 화면은 셈하지
// 않는다. 창 높이는 흔들리지 않는다: 수량 칸 줄 수 · 글 줄 수만큼 늘 자리를 남긴다(넘치는 수량 칸은 바닥줄 쪽 넘김).
import {
  envelopeFor, isAccepted, type Basis, type ConfirmCommand, type LineUnits, type PrimaryLabel, type ReturnPieceLine, type RichText, type TicketLossSheetParams,
  type TicketLossSheetView,
} from '@skinote/contract';
import { confirmWindow } from '@skinote/layout';
import { DialogFrame, Pager, PrimaryButton, ReturnPieces, RichLine, piecePages, t, useCommandDraft, useUi, type DeviceProfile } from '@skinote/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '../app/client.tsx';
import { say } from '../app/strings.ts';

const NO_BASIS: Basis = { epoch: '', rev: 0 };

/**
 * 수량 칸의 줄 수(잰 창 높이의 모양 계산, 업무 규칙이 아님): 창 높이 − 제목 − 바닥 − 본문 위아래 여백 − 글 줄 → 누르는 곳 높이 + 사이로 몇 줄.
 * 적어도 1, 반납 창의 끝(returnPieceRows)까지.
 */
export function pieceSheetRows(heightPx: number, textRows: number, profile: Pick<DeviceProfile, 'confirm' | 'space' | 'minTargetPx' | 'minFontPx' | 'pages'>): number {
  const { space, minTargetPx: target } = profile;
  const fixed = profile.confirm.titlePx + profile.confirm.primaryRowPx + 2 * space.m + textRows * (profile.minFontPx * 2 + space.s);
  const rows = Math.floor((heightPx - fixed + space.s) / (target + space.s));
  return Math.max(1, Math.min(profile.pages.returnPieceRows, rows));
}

/** 줄 하나의 수를 바꾼 고른 것(처음이면 창이 보인 것에서). */
export function withPiece<T extends { quantity: number }>(picked: readonly T[], key: (x: T) => string, id: string, value: number, make: (id: string, quantity: number) => T): T[] {
  const next = Math.max(0, value);
  return picked.some((x) => key(x) === id) ? picked.map((x) => (key(x) === id ? { ...x, quantity: next } : x)) : [...picked, make(id, next)];
}

export interface PieceSheetView {
  basis: Basis;
  title: string;
  lines: ReturnPieceLine[];
  /** 수량 칸 아래의 글(자리는 textRows만큼 늘 남긴다). */
  text: RichText[];
  notice?: string;
  primary: PrimaryLabel;
  command?: ConfirmCommand;
}

export interface PieceSheetProps {
  /** 창의 이름(초안 key · CSS). */
  kind: 'ticket-loss' | 'spare';
  view: PieceSheetView;
  /** 고른 것이 바뀌어 창을 다시 묻는 중(보내지 않는다). */
  stale: boolean;
  /** 글 줄 자리 수. */
  textRows: number;
  /** 창을 연 때의 초안 모양(요청번호 · basis만 정한다). */
  shape: ConfirmCommand;
  draftKey: string;
  groupLabel: string;
  onQuantity: (lineId: string, value: number) => void;
  onClose: () => void;
}

/** 수량 칸 + 글 줄 + 주 버튼 하나의 창(분실 처리 · 분실 회수 · 예비권 적재 · 입고). */
export function PieceSheet({ kind, view, stale, textRows, shape, draftKey, groupLabel, onQuantity, onClose }: PieceSheetProps) {
  const client = useClient();
  const { profile, viewport } = useUi();
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 이 요청번호로 보낸 명령이 적용되지 않았다: 창을 닫고 다시 열어야 새 요청번호가 된다(sync 2절). */
  const [spent, setSpent] = useState(false);
  const stableShape = useMemo(() => shape, [draftKey]);
  const { draft, markSent } = useCommandDraft(draftKey, stableShape, view.basis ?? NO_BASIS);

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
    }, () => {
      // 보내지 못했다(연결 끊김): 같은 창에서 다시 누르면 같은 요청번호로 다시 보낸다(된 명령은 서버가 처음 결과를 준다).
      setBusy(false);
      setError(say('sendFailed'));
    });
  };

  const box = confirmWindow(viewport, profile.confirm, 1, 0);
  const rowsPerPage = pieceSheetRows(box.heightPx, textRows, profile);
  const pages = piecePages(view.lines, rowsPerPage);
  const rowCount = Math.max(1, ...pages.map((p) => p.length));
  const current = Math.min(page, pages.length - 1);
  const alert = error ?? view.notice ?? null;
  const text = alert ? [[{ text: alert, strong: true }], ...view.text.slice(1)] : view.text;
  const ready = view.primary.enabled && view.command !== undefined && !stale && !spent && draft !== null;
  return (
    <DialogFrame
      title={view.title}
      onClose={onClose}
      className={'pos-pieces-sheet is-' + kind}
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
      <div className="pos-pieces-sheet-pieces" role="group" aria-label={groupLabel}>
        <ReturnPieces
          rows={pages[current] ?? []}
          rowCount={rowCount}
          groupLabel={(line) => say('qtyOf', { item: line.ariaLabel ?? line.label })}
          onPiece={() => undefined}
          onQuantity={onQuantity}
          onPicker={() => undefined}
        />
      </div>
      <div className={'pos-pieces-sheet-text' + (alert ? ' is-alert' : '')} {...(alert ? { role: 'alert' } : {})}>
        {Array.from({ length: textRows }, (_, i) => (
          <p key={i} className="pos-pieces-sheet-line">{text[i] ? <RichLine runs={text[i]!} /> : null}</p>
        ))}
      </div>
    </DialogFrame>
  );
}

/** 창을 묻는 흐름(인자 → 읽기 모델, 마지막 답만 쓴다). 읽지 못하면 onFail(처음) 또는 창 안의 한 줄. */
export function useSheet<P, V>(load: (params: P) => Promise<V>, initial: P, onFail: (line: string) => void): { params: P; setParams: (p: P) => void; view: V | null; stale: boolean } {
  const [params, setParams] = useState<P>(initial);
  const [loaded, setLoaded] = useState<{ key: string; view: V } | null>(null);
  const key = JSON.stringify(params);
  const asked = useRef('');
  useEffect(() => {
    let alive = true;
    asked.current = key;
    load(params).then(
      (next) => { if (alive && asked.current === key) setLoaded({ key, view: next }); },
      () => { if (alive && !loaded) onFail(say('openFailed')); },
    );
    return () => { alive = false; };
  }, [key]);
  return { params, setParams, view: loaded?.view ?? null, stale: loaded !== null && loaded.key !== key };
}

export interface TicketLossDialogProps {
  orderId: string;
  direction: 'loss' | 'found';
  onClose: () => void;
  onFail: (line: string) => void;
}

/** 분실 처리 · 분실 회수 창. */
export function TicketLossDialog({ orderId, direction, onClose, onFail }: TicketLossDialogProps) {
  const client = useClient();
  const sheet = useSheet<TicketLossSheetParams, TicketLossSheetView>((p) => client.query('ticketLossSheet', p), { orderId, direction }, onFail);
  const view = sheet.view;
  if (!view) return null;
  const picked = (sheet.params.picked ?? view.picked) as LineUnits[];
  const shape: ConfirmCommand = direction === 'loss'
    ? { type: 'stock.write_off', payload: { orderId, lines: [], reasonKey: 'lost' } }
    : { type: 'asset.found', payload: { orderId, lines: [] } };
  return (
    <PieceSheet
      kind="ticket-loss"
      view={{ ...view, text: view.notes }}
      stale={sheet.stale}
      textRows={2}
      shape={shape}
      draftKey={'ticket-' + direction + ':' + orderId}
      groupLabel={say('ticketPieces')}
      onQuantity={(lineId, value) => sheet.setParams({ ...sheet.params, picked: withPiece(picked, (x) => x.lineId, lineId, value, (id, quantity) => ({ lineId: id, quantity })) })}
      onClose={onClose}
    />
  );
}

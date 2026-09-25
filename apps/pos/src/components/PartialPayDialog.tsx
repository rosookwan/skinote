// V5 부분 결제 판(spec 3-6, ui 6-7, docs/44 S08R 모양): 일괄 수납의 한 팀 줄에서 `부분 결제 ›`를 누르면 그 팀의 남은 품목 줄마다 −/+,
// `잔여 전체 선택` · `균등 분할`, 합계 한 줄, 주 버튼 `선택 · 165,000원`. 사람이 아니라 품목으로 고른다(사장님 답 5). 명령을 보내지 않는다:
// 고른 수를 일괄 수납 화면에 돌려주고, 그 화면이 인자(parts)로 다시 물어 줄의 버튼이 `부분 · 165,000원 ›`이 된다.
// 누를 때마다 서버에 partialPaySheet를 다시 물어 줄 값 · 합계 · 주 버튼을 받는다(화면은 계산하지 않는다). 창 높이는 흔들리지 않는다:
// 품목 칸은 연 때의 줄 수만큼 자리를 두고(한 줄에 둘, 넘치면 쪽), 묶음 버튼 줄 · 합계 줄은 늘 있다.
import type { LineUnits, PartialPaySheetView } from '@skinote/contract';
import { DialogFrame, Pager, PrimaryButton, QtyStepper, RichLine, useDeviceProfile } from '@skinote/ui';
import { useEffect, useRef, useState } from 'react';
import { useClient } from '../app/client.tsx';
import { say } from '../app/strings.ts';

/** 한 줄에 두는 품목 칸 수. 한 쪽의 줄 수는 DeviceProfile pages.partialPayRows(확인 창 한도 1024×529에서 505 안에 묶음 줄 · 합계 줄과 함께). */
const PER_ROW = 2;

/** 창이 보인 고른 수(주 버튼이 돌려줄 것). */
export const pickedLines = (view: PartialPaySheetView): LineUnits[] => view.lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity.value }));

/**
 * 한 줄을 −/+ 한 뒤의 고른 수. 바탕은 이미 누른 수(답이 오기 전에 두 번 눌러도 둘 다 센다), 없으면 창이 보인 수. 범위는 창이 준 최소 · 최대.
 */
export function stepLine(base: LineUnits[] | undefined, view: PartialPaySheetView, lineId: string, delta: number): LineUnits[] {
  const from = base ?? pickedLines(view);
  return view.lines.map((l) => {
    const now = from.find((u) => u.lineId === l.lineId)?.quantity ?? l.quantity.value;
    const next = l.lineId === lineId ? Math.min(l.quantity.max, Math.max(l.quantity.min, now + delta)) : now;
    return { lineId: l.lineId, quantity: next };
  });
}

export interface PartialPayDialogProps {
  orderId: string;
  payerOrderId: string;
  /** 앞서 고른 수(다시 열어 고칠 때). 없으면 남은 것 모두. */
  initial?: LineUnits[];
  onPick: (lines: LineUnits[]) => void;
  onClose: () => void;
}

export function PartialPayDialog({ orderId, payerOrderId, initial, onPick, onClose }: PartialPayDialogProps) {
  const profile = useDeviceProfile();
  const client = useClient();
  const [lines, setLines] = useState<LineUnits[] | undefined>(initial);
  const [loaded, setLoaded] = useState<{ key: string; view: PartialPaySheetView } | null>(null);
  const [page, setPage] = useState(0);
  const [failed, setFailed] = useState(false);
  const key = JSON.stringify(lines ?? null);
  const asked = useRef('');
  useEffect(() => {
    let alive = true;
    asked.current = key;
    client.query('partialPaySheet', { orderId, payerOrderId, ...(lines ? { lines } : {}) }).then(
      (next) => { if (alive && asked.current === key) { setLoaded({ key, view: next }); setFailed(false); } },
      () => { if (alive) setFailed(true); },
    );
    return () => { alive = false; };
  }, [client, orderId, payerOrderId, key]);

  const view = loaded?.view ?? null;
  if (!view) return null;
  // 누른 뒤 답이 오기 전에는 주 버튼을 받지 않는다(앞의 수로 돌려주지 않게).
  const stale = loaded?.key !== key;
  const rowsPerPage = profile.pages.partialPayRows;
  const perPage = rowsPerPage * PER_ROW;
  const pages = Math.max(1, Math.ceil(view.lines.length / perPage));
  const current = Math.min(page, pages - 1);
  const shown = view.lines.slice(current * perPage, (current + 1) * perPage);
  // 품목 칸 자리: 연 때의 줄 수(쪽이 여럿이면 한 쪽 가득)만큼 늘 둔다.
  const rows = Math.min(rowsPerPage, Math.max(1, Math.ceil(view.lines.length / PER_ROW)));
  return (
    <DialogFrame
      title={view.title}
      onClose={onClose}
      className="pos-partial"
      pager={<Pager page={current} pageCount={pages} onChange={setPage} />}
      primary={(
        <PrimaryButton
          label={view.primary.label}
          {...(view.primary.alts.length ? { alts: view.primary.alts } : {})}
          disabled={!view.primary.enabled || stale}
          onPress={() => onPick(pickedLines(view))}
        />
      )}
    >
      <div className="sn-steps pos-partial-steps" style={{ gridTemplateRows: 'repeat(' + rows + ', var(--sn-target))' }}>
        {shown.map((l) => (
          <QtyStepper
            key={l.lineId}
            name={l.label}
            note={l.note}
            quantity={l.quantity}
            label={say('qtyOf', { item: l.ariaLabel })}
            onChange={(value) => setLines((prev) => stepLine(prev, view, l.lineId, value - l.quantity.value))}
          />
        ))}
      </div>
      <div className="pos-partial-presets" role="group" aria-label={say('partialPick')}>
        {view.presets.map((p) => (
          <button key={p.key} type="button" className="sn-button sn-choice" disabled={!p.enabled} onClick={() => setLines(p.lines)}>{p.label}</button>
        ))}
      </div>
      <p className={'pos-partial-sum' + (failed ? ' is-alert' : '')} {...(failed ? { role: 'alert' } : {})}>
        <RichLine runs={failed ? [{ text: say('openFailed'), strong: true }] : view.summary} />
      </p>
    </DialogFrame>
  );
}

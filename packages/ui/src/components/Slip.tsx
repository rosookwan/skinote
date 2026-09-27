// 대여 접수증(ui 5 Slip, 6-2): 손으로 쓰던 접수증 모양. 위에서부터 제목 · 칸 한 줄(날짜 · 구분 · 대표자 · 연락처 · 인원) ·
// 품목 표(품목마다 적재 · 지급 · 반납 도장) · 약속 요약 한 줄 · 돈 줄. 품목이 많으면 품목 표만 쪽을 넘긴다('품목 1 / 3쪽').
// 오른쪽 판(남은 일 + 주 버튼 + 옆 동작)은 화면 틀이 옆에 붙인다. 같은 설정으로 인쇄(receipt_slip)한다.
// 품목 표의 칸 값은 읽기 모델(SlipLine.cells)이 설정의 칸마다 채운 것만 그린다: 칸을 더해도 여기서 뜻을 짐작하지 않는다.
// 칸이 한 줄에 들어가지 않으면 장부와 같은 규칙(4-2)으로 두 줄 줄(88px) 또는 '화면을 크게 해 주세요'.
import type { LedgerRow as LedgerRowModel, OrderSlip, ResolvedLedgerView, SlipAdjustment, SlipLine, StampCell, StampStepRow } from '@skinote/contract';
import { columnSpecs, fitColumns, rowsPerPage, type TextPart } from '@skinote/layout';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isLate, useDeviceProfile, useUi } from '../context.tsx';
import type { Size } from '../device-profile.ts';
import { formatLocalDate, formatRelativeDay, formatTime, formatWon } from '../format.ts';
import { measureFor, useElementSize, useFontsVersion, useIsoLayoutEffect } from '../measure.ts';
import { t } from '../strings.ko-KR.ts';
import { LedgerRow } from './LedgerRow.tsx';
import { StampMark, stampLabel } from './Stamp.tsx';
import { TextFit } from './TextFit.tsx';

export interface SlipProps {
  slip: OrderSlip;
  /** 기능으로 거른 접수증 화면 정의(order_slip). */
  view: ResolvedLedgerView;
  steps: ReadonlyMap<string, StampStepRow>;
  nowMs: number;
  /** 품목 표의 쪽(0부터). */
  itemsPage: number;
  onItemsPaging?: (pageCount: number) => void;
  onStampPress?: (line: SlipLine, columnKey: string, cell: StampCell) => void;
  /** 품목 표 자리의 크기를 고정할 때(서버 그리기 · 시험). */
  tableSize?: Size;
  /** 확대를 되돌리는 방법이 있을 때(데스크톱 포장 앱). */
  onZoomReset?: () => void;
}

/** 접수증 품목 줄을 장부 줄 모양으로(같은 LedgerRow로 그린다). 칸 값은 읽기 모델 그대로다. */
function lineRow(line: SlipLine, cancelled = false): LedgerRowModel {
  // 모두 취소한 접수의 줄은 장부의 취소 줄처럼 옅은 먹(finished 모양).
  return { id: line.id, rank: '', finished: cancelled, cells: line.cells };
}

/**
 * 돈 줄의 수단 조각(2026-09-26 검토: 여러 수단으로 낸 팀이 한 수단으로 읽히지 않게). 수단마다 묶어 오늘 받은 수단을 먼저(큰 금액부터), 다른 날
 * 받은 것(선입금)은 날짜를 붙인다('계좌이체 12/24'). 수단이 하나면 수단 이름만(`카드`), 둘 이상이면 수단마다 금액(`카드 225,000원 · 현금
 * 140,000원`). 좁으면 이 조각이 통째로 빠진다(청구 · 수납은 남음).
 */
export function paymentParts(payments: readonly { amount: number; methodLabel: string; date: string }[], businessDate: string): TextPart[] {
  const groups = new Map<string, { method: string; amount: number; today: boolean; date: string }>();
  for (const p of payments) {
    const g = groups.get(p.methodLabel) ?? { method: p.methodLabel, amount: 0, today: false, date: p.date };
    g.amount += p.amount;
    g.today ||= p.date === businessDate;
    groups.set(p.methodLabel, g);
  }
  const list = [...groups.values()].sort((a, b) => Number(b.today) - Number(a.today) || b.amount - a.amount);
  const name = (g: (typeof list)[number]) => (g.today ? g.method : g.method + ' ' + g.date.slice(5).replace('-', '/'));
  if (list.length === 0) return [];
  if (list.length === 1) return [{ text: name(list[0]!), drop: 5 }];
  return [{ text: list.map((g) => t('methodAmount', { method: name(g), amount: formatWon(g.amount) })).join(' · '), drop: 5 }];
}

/**
 * 출처 줄 하나(할인 `장비 10% 할인 · −22,500원`, 해제 · 환불은 옅은 먹): 글은 금액 칸 앞의 칸들을 합친 자리, 금액은 금액 칸 자리(청구에 드는 줄만),
 * 도장 칸 자리는 비운다. 두 줄 줄(stacked)이면 한 칸에 글과 금액.
 */
function AdjustmentRow({ adj, columnCount, moneyIndex, stacked }: { adj: SlipAdjustment; columnCount: number; moneyIndex: number; stacked: boolean }) {
  const amount = adj.amount !== undefined ? formatWon(adj.amount) : null;
  const className = 'sn-row sn-slip-adjust' + (stacked ? ' is-stacked' : '') + (adj.tone === 'muted' ? ' is-muted' : '');
  if (moneyIndex < 0) {
    return (
      <tr className={className}>
        <td colSpan={columnCount}>
          <span className="sn-slip-adjust-line">
            <TextFit input={{ mode: 'parts', parts: adj.parts }} />
            {amount ? <span className="sn-slip-adjust-amount">{amount}</span> : null}
          </span>
        </td>
      </tr>
    );
  }
  const after = columnCount - moneyIndex - 1;
  return (
    <tr className={className}>
      {moneyIndex > 0 ? <td colSpan={moneyIndex}><TextFit input={{ mode: 'parts', parts: adj.parts }} /></td> : null}
      <td className="align-end">{amount ? <span className="sn-slip-adjust-amount">{amount}</span> : null}</td>
      {after > 0 ? <td colSpan={after} /> : null}
    </tr>
  );
}

export function Slip({ slip, view, steps, nowMs, itemsPage, onItemsPaging, onStampPress, tableSize, onZoomReset }: SlipProps) {
  const profile = useDeviceProfile();
  const { timezone } = useUi();
  const fonts = useFontsVersion();
  const tableRef = useRef<HTMLDivElement>(null);
  const measured = useElementSize(tableRef, tableSize ?? null);
  const box = tableSize ?? measured;
  const columns = useMemo(() => new Map(view.columns.map((c) => [c.column_key, c] as const)), [view.columns]);
  const layout = useMemo(
    () => fitColumns(columnSpecs(view.columns), box?.width ?? 0, { basePx: profile.baseFontPx, secondLineAllowed: false }),
    [view.columns, box?.width, profile.baseFontPx, fonts],
  );
  // 쪽 나누기는 장부와 같은 계산(layout의 rowsPerPage): 표 머리를 뺀 잰 높이 ÷ 줄 높이(두 줄 줄이면 88px).
  const rowPx = layout.mode === 'stacked' ? profile.stackedRowPx : profile.rowPx;
  // 품목 줄 뒤에 출처 줄(할인 · 환불, features-1 §6-2)이 같은 줄 높이로 이어지고 함께 쪽을 넘긴다.
  const rows: ({ kind: 'line'; line: SlipLine } | { kind: 'adjust'; adj: SlipAdjustment })[] = [
    ...slip.lines.map((line) => ({ kind: 'line' as const, line })), ...(slip.adjustments ?? []).map((adj) => ({ kind: 'adjust' as const, adj })),
  ];
  const perPage = box ? Math.max(1, rowsPerPage(box.height - profile.tableHeadPx, rowPx)) : Math.max(1, rows.length);
  const pageCount = layout.mode === 'too_narrow' ? 1 : Math.max(1, Math.ceil(rows.length / perPage));
  const page = Math.min(Math.max(0, itemsPage), pageCount - 1);
  useEffect(() => { onItemsPaging?.(pageCount); }, [pageCount, onItemsPaging]);
  const shownRows = rows.slice(page * perPage, page * perPage + perPage);
  // 출처 줄의 금액 칸: 설정의 금액(money) 칸 자리(없으면 줄 끝).
  const moneyIndex = layout.mode === 'fit' ? layout.columns.findIndex((c) => columns.get(c.key)?.renderer_key === 'money') : -1;
  const byId = useMemo(() => new Map(slip.lines.map((l) => [l.id, l] as const)), [slip.lines]);

  // 칸 한 줄: 넓이가 모자라면 drop이 큰 칸부터 뺀다(대표자 · 연락처는 빠지지 않음).
  const fieldsRef = useRef<HTMLDListElement>(null);
  const fieldsBox = useElementSize(fieldsRef);
  const [hiddenFields, setHiddenFields] = useState<ReadonlySet<string>>(new Set());
  const droppable = useMemo(() => [...slip.fields].filter((f) => f.drop > 0).sort((a, b) => b.drop - a.drop), [slip.fields]);
  useIsoLayoutEffect(() => {
    const el = fieldsRef.current;
    if (!el || !fieldsBox) return;
    // 이름(dt)과 값(dd)은 글자 크기 · 굵기가 달라 각자의 글꼴로 잰다(칸 줄 전체의 글꼴로 재면 좁게 나와 넘친다).
    const field = el.querySelector('.sn-slip-field');
    const measureLabel = measureFor(el.querySelector('dt') ?? el, profile.baseFontPx);
    const measureValue = measureFor(el.querySelector('dd') ?? el, profile.bodyFontPx);
    // 칸 하나 = 이름 + 값(한 줄) + 사이 + 좌우 여백(칸의 계산된 모양에서 읽는다).
    const fs = field && typeof getComputedStyle !== 'undefined' ? getComputedStyle(field) : null;
    const pad = fs ? parseFloat(fs.paddingLeft) + parseFloat(fs.paddingRight) + (parseFloat(fs.columnGap) || 0) : 2 * profile.space.s + profile.space.xs;
    const need = (keys: ReadonlySet<string>) => slip.fields.filter((f) => !keys.has(f.key)).reduce((w, f) => w + measureLabel(f.label) + measureValue(f.value) + pad, 0);
    const hidden = new Set<string>();
    const order = [...droppable];
    while (need(hidden) > fieldsBox.width && order.length) hidden.add(order.shift()!.key);
    setHiddenFields((prev) => (prev.size === hidden.size && [...hidden].every((k) => prev.has(k)) ? prev : hidden));
  }, [slip.fields, droppable, fieldsBox, fonts, profile.baseFontPx, profile.bodyFontPx, profile.space.s]);
  // 그린 뒤에도 넘치면(잰 폭과 그린 폭의 차이) 다음 칸을 하나 더 뺀다.
  useIsoLayoutEffect(() => {
    const el = fieldsRef.current;
    if (!el || el.scrollWidth <= el.clientWidth + 1) return;
    const next = droppable.find((f) => !hiddenFields.has(f.key));
    if (next) setHiddenFields(new Set([...hiddenFields, next.key]));
  });

  // 날짜는 영업일과 다를 때만 '내일' · '모레'로(같은 날짜를 두 번 쓰지 않는다, N14).
  const dayOf = (at: string) => {
    const date = formatLocalDate(at, timezone);
    return date === slip.businessDate ? '' : formatRelativeDay(date, slip.businessDate) + ' ';
  };
  // 지연된 일정(반납이 일정 시각을 넘김)은 종류 말에 '지연'을 붙이고('반납 지연 12:00 · 매장', 시각과 한 조각이라 빠지지 않음)
  // 일정 줄을 지연 색으로.
  const promiseLate = slip.promises.lines.some((line) => isLate(line.lateAt, nowMs));
  // 한 종류의 일정이 품목 · 수량으로 나뉘었으면(일정 변경) 그 종류는 '반납 일정 2건 ›'(수는 읽기 모델의 count).
  const perKind = slip.promises.lines.some((line) => line.count !== undefined);
  const promiseParts: TextPart[] = slip.promises.distinct > 1 && !perKind
    ? [{ text: t('promisesMany', { n: slip.promises.distinct }), drop: 0 }]
    : slip.promises.lines.flatMap((line) => {
        const kind = t(line.kind === 'pickup' ? 'pickup' : 'giveBack');
        const word = isLate(line.lateAt, nowMs) ? t('lateKind', { label: kind }) : kind;
        if ((line.count ?? 1) > 1) return [{ text: t('promisesKind', { label: word, n: line.count ?? 1 }), drop: 0 }];
        // 날 말 + 시각은 읽기 모델의 글(영업일로 센 것, 심야 `24:00`)이 있으면 그것, 없으면 at에서 센다.
        return [
          { text: word + ' ' + (line.when ?? dayOf(line.at) + formatTime(line.at, timezone)), drop: 0 },
          ...line.parts.map((p) => ({ ...p, drop: Math.max(1, p.drop) })),
        ];
      });

  // 돈 줄: 미수는 늘 이 팀 몫이다. 이 팀이 다른 팀 몫까지 낼 때만 굵은 글이 '받을 돈'(합)이고, 나눔은 앞 글에 적는다.
  // 맡은 보증금은 청구 · 미수와 따로 한 조각('보증금 15,000원'). 좁으면 수단(계좌이체 12/24) → 청구 → 보증금 → 수납 순으로 빠진다.
  const money = slip.money;
  const others = money.paidForOthers;
  const moneyParts: TextPart[] = [
    { text: t('charged', { amount: formatWon(money.charged) }), drop: 4 },
    // 지금 할인(청구에 이미 들어 있다): 할인 출처 줄이 품목 표의 다음 쪽에 있어도 첫 쪽에서 청구가 설명된다.
    ...(money.discount ? [{ text: t('discountPart', { amount: formatWon(-money.discount) }), drop: 4 }] : []),
    { text: t('paid', { amount: formatWon(money.paid) }), drop: 2 },
    // 돌려준 돈: `수납 0원 · 환불 145,000원`(수단 조각은 돌려준 몫을 뺀 것).
    ...(money.refunded ? [{ text: t('refundedPart', { amount: formatWon(money.refunded) }), drop: 2 }] : []),
    // 다른 팀 몫까지 낸 팀: `대납 395,000원 · 카드 485,000원`(한 번에 낸 실제 금액). 아니면 오늘 받은 돈은 수단만, 다른 날 받은 돈(선입금)은
    // 날짜를 붙인다('계좌이체 12/24').
    ...(others
      ? [
        { text: t('forOthers', { amount: formatWon(others.amount) }), drop: 3 },
        { text: t('methodAmount', { method: others.methodLabel, amount: formatWon(others.total) }), drop: 5 },
      ]
      : paymentParts(money.payments, slip.businessDate)),
    ...(money.depositHeld ? [{ text: t('depositHeld', { amount: formatWon(money.depositHeld) }), drop: 3 }] : []),
    ...(money.promisedBy ? [{ text: t('promisedBy', { team: money.promisedBy.teamName, amount: formatWon(money.promisedBy.amount) }), drop: 1 }] : []),
    ...(money.collectTotal !== undefined && money.due > 0 ? [{ text: t('due', { amount: formatWon(money.due) }), drop: 1 }] : []),
    ...(money.collectForOthers ? [{ text: t('forOthers', { amount: formatWon(money.collectForOthers) }), drop: 1 }] : []),
  ];
  const bold = money.collectTotal !== undefined ? t('toCollect', { amount: formatWon(money.collectTotal) }) : money.due > 0 ? t('due', { amount: formatWon(money.due) }) : null;
  const dueLate = isLate(money.lateAt, nowMs);

  const headerLabel = (key: string, collapsed: boolean) => {
    if (collapsed) return [t('stamps')];
    const config = columns.get(key);
    return [config?.header_label ?? '', ...(config?.short_header_label ? [config.short_header_label] : [])];
  };

  return (
    <article className="sn-slip">
      <header className="sn-slip-head">
        <h1 className="sn-slip-title">{t('slipTitle')}</h1>
        {slip.cancelled ? <span className="sn-slip-status">{slip.cancelled.label}</span> : null}
        <span className="sn-slip-no">{t('receiptNo', { no: slip.receiptNo })}</span>
      </header>
      <dl ref={fieldsRef} className="sn-slip-fields">
        {slip.fields.filter((f) => !hiddenFields.has(f.key)).map((f) => (
          <div key={f.key} className="sn-slip-field">
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      <div ref={tableRef} className="sn-slip-items" data-layout={layout.mode}>
        {layout.mode === 'too_narrow' ? (
          <div className="sn-too-narrow" role="status">
            <p>{t('tooNarrow')}</p>
            {onZoomReset ? <button type="button" className="sn-button" onClick={onZoomReset}>{t('zoomReset')}</button> : null}
          </div>
        ) : (
          <table className="sn-ledger-table" style={{ width: layout.widthPx }}>
            {layout.mode === 'fit' ? <colgroup>{layout.columns.map((c) => <col key={c.key} style={{ width: c.px }} />)}</colgroup> : null}
            <thead>
              {layout.mode === 'stacked' ? (
                <tr>
                  <th scope="col" className="align-start">
                    <TextFit input={{ mode: 'parts', parts: layout.columns.filter((c) => c.line === 1).map((c) => ({ text: columns.get(c.key)?.header_label ?? '', drop: 0 })) }} />
                  </th>
                </tr>
              ) : (
                <tr>
                  {layout.columns.map((c) => (
                    <th key={c.key} scope="col" className={'align-' + (c.collapsed.length ? 'center' : columns.get(c.key)?.align_key ?? 'start')}>
                      <TextFit input={{ mode: 'alts', alts: headerLabel(c.key, c.collapsed.length > 0) }} width={Math.max(0, c.px - 2 * profile.space.s)} />
                    </th>
                  ))}
                </tr>
              )}
            </thead>
            <tbody>
              {shownRows.map((r) => (r.kind === 'line' ? (
                <LedgerRow
                  key={r.line.id}
                  row={lineRow(r.line, slip.cancelled !== undefined)}
                  layout={layout}
                  columns={columns}
                  steps={steps}
                  nowMs={nowMs}
                  {...(r.line.parentLineId ? { extraClass: 'is-component' } : r.line.isBundle ? { extraClass: 'is-bundle' } : {})}
                  {...(onStampPress ? { onStampPress: (row: LedgerRowModel, key: string, cell: StampCell) => { const l = byId.get(row.id); if (l) onStampPress(l, key, cell); } } : {})}
                />
              ) : (
                <AdjustmentRow key={r.adj.key} adj={r.adj} columnCount={layout.mode === 'fit' ? layout.columns.length : 1} moneyIndex={moneyIndex} stacked={layout.mode === 'stacked'} />
              )))}
            </tbody>
          </table>
        )}
      </div>
      <div className={'sn-slip-promise' + (slip.cancelled ? ' is-cancelled' : '')}>
        <TextFit input={{ mode: 'parts', parts: promiseParts }} {...(promiseLate && !slip.cancelled ? { className: 'tone-late' } : {})} />
      </div>
      <div className="sn-slip-money">
        <TextFit className="sn-slip-money-text" input={{ mode: 'parts', parts: moneyParts }} />
        {bold ? <span className={'sn-slip-due' + (dueLate ? ' tone-late' : '')}>{bold}</span> : null}
        <span className="sn-slip-stamps">
          {slip.orderStamps.map((cell) => (
            <span key={cell.stepKey} className="sn-slip-stamp" role="img" aria-label={stampLabel(cell, steps.get(cell.stepKey))}>
              <StampMark cell={cell} step={steps.get(cell.stepKey)} size="word" />
            </span>
          ))}
        </span>
      </div>
    </article>
  );
}

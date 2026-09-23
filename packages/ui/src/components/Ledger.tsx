// 장부(ui 5 Ledger): 설정의 칸을 잰 폭에 맞추고(4-2), 잰 높이로 쪽을 나눈다(4-3). 스크롤 영역은 없다.
// 같은 부품이 오늘 대여 장부(표 머리 있음, 지금 줄)와 기사 수거 목록(묶음 제목, 빨리 확인 고정 줄)을 그린다.
// 줄 순서 · 묶음 · 도장 상태는 읽기 모델 그대로다. 자리 지키기(보는 동안 줄이 옮겨 가지 않음)는 화면 틀이 줄 순서를 넘길 때 한다.
import type { LedgerColumnRow, LedgerViewResult, ResolvedLedgerView, StampStepRow } from '@skinote/contract';
import {
  columnSpecs, fitColumns, initialPage, nowLineIndex, paginate, type ColumnLayout, type FittedColumn, type Page, type PageEntry,
} from '@skinote/layout';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { isLate, useDeviceProfile } from '../context.tsx';
import type { Size } from '../device-profile.ts';
import { useElementSize, useFontsVersion } from '../measure.ts';
import { t } from '../strings.ko-KR.ts';
import { LedgerRow, type LedgerRowHandlers } from './LedgerRow.tsx';
import { NowLine } from './NowLine.tsx';
import { TextFit } from './TextFit.tsx';

export interface LedgerPaging {
  pageCount: number;
  /** 처음 열 쪽(고른 줄 → 지금 줄 → 첫 쪽). */
  initialPage: number;
  /** 칸이 들어가지 않아 두 줄 줄이 되었거나 들어가지 않는지. */
  mode: ColumnLayout['mode'];
}

export interface LedgerProps extends LedgerRowHandlers {
  /** 기능으로 거른 화면 정의(visibleView). */
  view: ResolvedLedgerView;
  result: LedgerViewResult;
  steps: ReadonlyMap<string, StampStepRow>;
  /** 서버 시각 차이로 고친 지금(useServerNow). */
  nowMs: number;
  /** 보일 쪽(0부터). 넘치면 마지막 쪽. */
  page: number;
  onPaging?: (paging: LedgerPaging) => void;
  selectedRowId?: string | null;
  /** 쪽마다 목록 맨 위에 고정되는 빨리 확인 줄(PinBar). 높이는 등급의 pinRowPx로 센다. */
  pinSlot?: ReactNode;
  /** 크기를 고정할 때(서버 그리기 · 시험). 없으면 스스로 잰다. */
  size?: Size;
  /** 확대를 되돌리는 방법이 있을 때(데스크톱 포장 앱). */
  onZoomReset?: () => void;
}

export function Ledger({ view, result, steps, nowMs, page, onPaging, selectedRowId, pinSlot, size, onZoomReset, ...handlers }: LedgerProps) {
  const profile = useDeviceProfile();
  const ref = useRef<HTMLElement>(null);
  const measured = useElementSize(ref, size ?? null);
  const fonts = useFontsVersion();
  const box = size ?? measured;
  const showHead = view.template_key === 'ledger';
  const groupHeadings = view.template_key !== 'ledger' && view.group_by_key !== null;

  const columns = useMemo(() => new Map<string, LedgerColumnRow>(view.columns.map((c) => [c.column_key, c])), [view.columns]);
  const layout = useMemo(
    () => fitColumns(columnSpecs(view.columns), box?.width ?? 0, { basePx: profile.baseFontPx, secondLineAllowed: profile.secondLineRows }),
    // fonts: 묶은 글꼴을 읽으면 폭을 다시 잰다(칸 폭은 em이라 같지만 판 폭이 바뀔 수 있다).
    [view.columns, box?.width, profile.baseFontPx, profile.secondLineRows, fonts],
  );
  const rowPx = layout.mode === 'stacked' ? profile.stackedRowPx : profile.rowPx;
  const nowIndex = useMemo(() => {
    if (!view.now_line_field) return null;
    return nowLineIndex(result.rows.map((r) => (r.finished || !r.dueAt ? null : Date.parse(r.dueAt))), nowMs);
  }, [view.now_line_field, result.rows, nowMs]);
  const pages: Page[] = useMemo(() => {
    if (!box) return [{ index: 0, entries: [], from: 0, to: 0, usedPx: 0, overflow: false }];
    return paginate(
      result.rows.map((r) => ({ id: r.id, heightPx: rowPx, ...(groupHeadings && r.groupKey !== undefined ? { group: r.groupKey } : {}) })),
      {
        availablePx: box.height - (showHead ? profile.tableHeadPx : 0),
        fixedTopPx: pinSlot ? profile.pinRowPx : 0,
        groupTitlePx: groupHeadings ? profile.groupTitlePx : 0,
        nowLinePx: profile.nowLinePx,
        nowBeforeIndex: nowIndex,
        hintNextGroup: groupHeadings,
        combineHeadingsBelowPx: profile.combineHeadingsBelowPx,
      },
    );
  }, [box, result.rows, rowPx, groupHeadings, showHead, pinSlot, profile, nowIndex]);

  const first = initialPage(pages, selectedRowId ?? null);
  const measuredBox = box !== null;
  useEffect(() => {
    // 재기 전(판 크기를 모를 때)의 빈 쪽은 알리지 않는다: 처음 여는 쪽(지금 줄 · 고른 줄)이 잘못 정해지지 않게.
    if (!measuredBox) return;
    onPaging?.({ pageCount: pages.length, initialPage: first, mode: layout.mode });
  }, [measuredBox, pages.length, first, layout.mode, onPaging]);

  const current = pages[Math.min(Math.max(0, page), pages.length - 1)] ?? pages[0]!;
  // 이 쪽이 묶음 제목 여럿을 한 줄로 합쳤으면 줄마다 묶음 이름을 붙인다.
  const combinedPage = current.entries.some((e) => e.kind === 'groups' && e.keys.length > 1);
  const groups = useMemo(() => new Map(result.groups.map((g) => [g.key, g])), [result.groups]);
  const colSpan = Math.max(1, layout.mode === 'stacked' ? 1 : layout.columns.length);

  // 늦은 줄이 있는 묶음(반납 타임): 제목도 늦음 색과 '늦음'(시각이 적힌 곳이 제목뿐인 기사 목록에서 놓치지 않게).
  const lateGroups = useMemo(
    () => new Set(result.rows.filter((r) => r.groupKey !== undefined && isLate(r.lateAt, nowMs)).map((r) => r.groupKey!)),
    [result.rows, nowMs],
  );
  const groupText = (key: string) => {
    const g = groups.get(key);
    if (!g) return key;
    return g.label + (lateGroups.has(key) ? ' · ' + t('late') : '') + ' · ' + t('groupCount', { done: g.done, total: g.total });
  };
  const groupTone = (keys: readonly string[]) => (keys.some((key) => lateGroups.has(key)) ? 'tone-late' : undefined);
  // 이 쪽보다 앞쪽에 있는 늦은 줄 수: 지금 줄에 '앞쪽에 늦은 팀 N'(늦음 색)으로 알린다(처음 여는 쪽이 지금 줄의 쪽이라 놓치기 쉽다).
  const lateBefore = result.rows.slice(0, current.from).filter((r) => isLate(r.lateAt, nowMs)).length;
  const renderEntry = (entry: PageEntry, i: number): ReactNode => {
    switch (entry.kind) {
      case 'group': {
        const parts = [
          { text: groupText(entry.key), drop: 0, words: true },
          ...(entry.continued ? [{ text: t('continued'), drop: 1 }] : []),
        ];
        const tone = groupTone([entry.key]);
        return (
          <tr key={'g' + i} className="sn-group-row">
            <th colSpan={colSpan} scope="colgroup"><TextFit input={{ mode: 'parts', parts }} {...(tone ? { className: tone } : {})} /></th>
          </tr>
        );
      }
      case 'groups': {
        // 한 쪽에 합친 묶음 제목: 넘치면 개수를 빼고, 그다음 짧은 이름만('16:30 · 21:50 · 22:00'), 끝으로 '16:30 반납 외 2'.
        // 낱말을 잘라 묶음 하나가 사라지거나 '·'가 매달리지 않게 통째로 바꾼다.
        const list = entry.keys.map((key) => groups.get(key));
        const label = (key: string, g: (typeof list)[number]) => g?.label ?? key;
        const more = entry.continued ? ' · ' + t('continued') : '';
        const alts = [
          entry.keys.map(groupText).join(' · ') + more,
          entry.keys.map((key, n) => label(key, list[n])).join(' · ') + more,
          entry.keys.map((key, n) => list[n]?.shortLabel ?? label(key, list[n])).join(' · '),
          ...(entry.keys.length > 1 ? [t('groupsMore', { first: list[0]?.shortLabel ?? label(entry.keys[0]!, list[0]), n: entry.keys.length - 1 })] : []),
        ];
        const tone = groupTone(entry.keys);
        return (
          <tr key={'g' + i} className="sn-group-row">
            <th colSpan={colSpan} scope="colgroup"><TextFit input={{ mode: 'alts', alts }} {...(tone ? { className: tone } : {})} /></th>
          </tr>
        );
      }
      case 'hint':
        return (
          <tr key={'h' + i} className="sn-group-row is-hint">
            <td colSpan={colSpan}><TextFit input={{ mode: 'parts', parts: [{ text: groupText(entry.key), drop: 0 }, { text: t('nextPageHint'), drop: 1 }] }} /></td>
          </tr>
        );
      case 'now':
        return <NowLine key={'n' + i} nowMs={nowMs} nightPrep={result.nightPrep ?? null} lateBefore={lateBefore} colSpan={colSpan} />;
      case 'row': {
        const row = result.rows[entry.index];
        if (!row) return null;
        const g = combinedPage && row.groupKey !== undefined ? groups.get(row.groupKey) : undefined;
        const groupPrefix = g ? g.shortLabel ?? g.label : undefined;
        return <LedgerRow key={row.id} row={row} layout={layout} columns={columns} steps={steps} nowMs={nowMs} selected={row.id === selectedRowId} {...(groupPrefix ? { groupPrefix } : {})} {...handlers} />;
      }
    }
  };

  const headerLabel = (fitted: FittedColumn) => {
    if (fitted.collapsed.length) return t('stamps');
    const c = columns.get(fitted.key);
    return c ? [c.header_label, ...(c.short_header_label ? [c.short_header_label] : [])] : [''];
  };

  return (
    <section ref={ref} className={'sn-ledger is-' + view.template_key} data-layout={layout.mode}>
      {pinSlot ? <div className="sn-ledger-pin">{pinSlot}</div> : null}
      {layout.mode === 'too_narrow' ? (
        <div className="sn-too-narrow" role="status">
          <p>{t('tooNarrow')}</p>
          {onZoomReset ? <button type="button" className="sn-button" onClick={onZoomReset}>{t('zoomReset')}</button> : null}
        </div>
      ) : (
        <table className="sn-ledger-table" style={{ width: layout.widthPx }}>
          {layout.mode === 'fit' ? (
            <colgroup>
              {layout.columns.map((c) => <col key={c.key} style={{ width: c.px }} />)}
            </colgroup>
          ) : null}
          {showHead ? (
            <thead>
              {layout.mode === 'stacked' ? (
                <tr>
                  <th scope="col" className="align-start">
                    <TextFit input={{ mode: 'parts', parts: layout.columns.filter((c) => c.line === 1).map((c) => ({ text: columns.get(c.key)?.header_label ?? '', drop: 0 })) }} />
                  </th>
                </tr>
              ) : (
                <tr>
                  {layout.columns.map((c) => {
                    const label = headerLabel(c);
                    const config = columns.get(c.key);
                    return (
                      <th key={c.key} scope="col" className={'align-' + (c.collapsed.length ? 'center' : config?.align_key ?? 'start')}>
                        <TextFit input={{ mode: 'alts', alts: Array.isArray(label) ? label : [label] }} width={Math.max(0, c.px - 2 * profile.space.s)} />
                      </th>
                    );
                  })}
                </tr>
              )}
            </thead>
          ) : null}
          <tbody>{current.entries.map(renderEntry)}</tbody>
        </table>
      )}
    </section>
  );
}

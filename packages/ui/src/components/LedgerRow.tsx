// 장부 · 목록의 한 줄(ui 5 LedgerRow). 칸 값은 읽기 모델이 이미 만들었고, 여기서는 칸 폭에 맞춰 그리기만 한다.
// 늦은 줄만 빨강(lateAt과 고친 지금 시각의 비교), 끝난 줄은 흐리게. 팀 칸을 누르면 접수증, 도장 칸을 누르면 확인 창.
// 두 줄 칸(52px 줄 안에 16px 두 줄): 시각 칸은 작은 윗줄에 종류('수령' · '반납', 자리 바뀐 줄은 '자리 바뀜'), 아랫줄에 시각.
// 돈 칸은 한 줄 문구가 들어가지 않으면 작은 윗줄에 이름('미수' · '받을 돈'), 아랫줄에 금액(원까지).
import type { ActionKey, LedgerCell, LedgerColumnRow, LedgerRow as LedgerRowModel, StampCell, StampStepRow } from '@skinote/contract';
import { fitAlts, type ColumnLayout, type FittedColumn, type TextFitInput, type TextPart } from '@skinote/layout';
import { useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { isLate, useDeviceProfile } from '../context.tsx';
import { formatItem } from '../format.ts';
import { Icon } from '../icons.tsx';
import { approximateMeasure, measureFor, useElementSize, useFontsVersion, useIsoLayoutEffect } from '../measure.ts';
import { t } from '../strings.ko-KR.ts';
import { Stamp, StampGroup, type StampGroupMember } from './Stamp.tsx';
import { TextFit } from './TextFit.tsx';

export interface LedgerRowHandlers {
  onRowPress?: (row: LedgerRowModel) => void;
  onStampPress?: (row: LedgerRowModel, columnKey: string, cell: StampCell) => void;
  onActionPress?: (row: LedgerRowModel, columnKey: string, actionKey: ActionKey) => void;
}

export interface LedgerRowProps extends LedgerRowHandlers {
  row: LedgerRowModel;
  layout: ColumnLayout;
  /** column_key → 칸 설정(그리기 · 맞춤 · 정렬 · 빠지는 순서). */
  columns: ReadonlyMap<string, LedgerColumnRow>;
  steps: ReadonlyMap<string, StampStepRow>;
  nowMs: number;
  selected?: boolean;
  /** 줄에 더할 모양(접수증의 세트 구성품 들여쓰기 등). */
  extraClass?: string;
  /** 한 쪽에 묶음 제목을 합쳤을 때 팀 칸 앞에 붙일 묶음 이름('16:30'). 어느 반납 타임의 줄인지 보이게. */
  groupPrefix?: string;
}

/** 칸 값을 글자 맞추기 입력으로(다른 칸 안에 합쳐 들어갈 때의 조각 포함). */
export function cellFitInput(cell: LedgerCell | undefined, foldDrop = 0): TextFitInput | null {
  if (!cell) return null;
  // 합쳐 들어온 조각은 받는 칸의 조각보다 먼저 빠지되, 저희끼리의 순서는 지킨다('반납 · 12:00'이면 '반납'이 먼저).
  const bump = (parts: readonly TextPart[]) => parts.map((p) => ({ ...p, drop: foldDrop > 0 ? p.drop + foldDrop : p.drop }));
  switch (cell.renderer) {
    case 'time':
    case 'promise':
    case 'place':
    case 'vehicle':
    case 'text':
    case 'attribute':
      return { mode: 'parts', parts: bump(cell.parts) };
    case 'team':
      return { mode: 'parts', parts: [{ text: cell.name, drop: 0, words: true }, { text: cell.last4, drop: 0 }, ...bump(cell.parts ?? [])] };
    case 'items':
      return { mode: 'items', items: cell.items.map(formatItem) };
    case 'money':
      return { mode: 'alts', alts: cell.alts };
    case 'stamp':
    case 'action':
      return null;
  }
}

/**
 * 줄 안의 장소 이름표(보조 묶음, ui 3-5 · 6-3). 팀 이름 · 끝 4자리가 먼저 자리를 잡고, 이름표는 남는 폭에만 들어간다:
 * 온전한 이름('설천 주차장') → 짧은 이름('설천') → 빼기. 말줄임표로 자르지 않는다.
 */
export function PlaceTag({ label, short }: { label: string; short?: string | undefined }) {
  const profile = useDeviceProfile();
  const ref = useRef<HTMLSpanElement>(null);
  const size = useElementSize(ref);
  const input = useMemo<TextFitInput>(() => ({ mode: 'alts', alts: [label, ...(short && short !== label ? [short] : []), ''] }), [label, short]);
  // 이름표 안 좌우 여백(--sn-space-xs)과 테두리(--sn-line)를 뺀 폭에 맞춘다.
  const width = size ? Math.max(0, size.width - 2 * profile.space.xs - 2 * profile.line.hair) : undefined;
  return (
    <span ref={ref} className="sn-tag-slot">
      {width !== undefined ? <TextFit className="sn-tag" input={input} width={width} /> : null}
    </span>
  );
}

/** 두 줄 칸: 작은 윗줄(없으면 한 줄) + 아랫줄. 두 줄 모두 칸 폭에 맞춘다. */
function CellStack({ over, main, width, className }: { over: TextFitInput | null; main: TextFitInput; width: number; className: string }) {
  return (
    <span className={['sn-cell-stack', className].filter(Boolean).join(' ')}>
      {over ? <TextFit className="sn-cell-over" input={over} width={width} /> : null}
      <TextFit input={main} width={width} />
    </span>
  );
}

type MoneyCell = Extract<LedgerCell, { renderer: 'money' }>;

/** 돈 칸: 첫 한 줄 문구가 들어가면 그것, 아니면 두 줄(이름 / 금액), 그것도 안 되면 나머지 한 줄 문구. */
function MoneyText({ cell, width, className }: { cell: MoneyCell; width: number; className: string }) {
  const profile = useDeviceProfile();
  const fonts = useFontsVersion();
  const ref = useRef<HTMLSpanElement>(null);
  const decide = (measure: (text: string) => number): 'one' | 'stack' | 'rest' => {
    const fits = (text: string) => measure(text) <= width + 0.5;
    if (fits(cell.alts[0] ?? '')) return 'one';
    if (cell.stacked && fits(cell.stacked.over) && fits(cell.stacked.main)) return 'stack';
    return 'rest';
  };
  const [mode, setMode] = useState(() => decide(approximateMeasure(profile.baseFontPx)));
  useIsoLayoutEffect(() => {
    setMode(decide(measureFor(ref.current, profile.baseFontPx)));
  }, [cell, width, fonts, profile.baseFontPx]);
  if (mode === 'stack' && cell.stacked) {
    return <span ref={ref} className="sn-cell-money"><CellStack over={{ mode: 'words', text: cell.stacked.over }} main={{ mode: 'words', text: cell.stacked.main }} width={width} className={className} /></span>;
  }
  const alts = mode === 'one' ? cell.alts.slice(0, 1) : cell.alts.slice(1).length ? cell.alts.slice(1) : cell.alts;
  return <span ref={ref} className="sn-cell-money"><TextFit input={{ mode: 'alts', alts }} width={width} className={className} /></span>;
}

/** 칸 글자 색. 빨강은 늦은 것에만(N8): 늦지 않았는데 red가 와도 검정으로 그린다. */
function toneClass(cell: LedgerCell, late: boolean): string {
  if (late) return 'tone-late';
  if (cell.renderer === 'money' && cell.tone !== 'red' && cell.tone !== 'ink') return 'tone-' + cell.tone;
  return '';
}

export function LedgerRow({ row, layout, columns, steps, nowMs, selected = false, extraClass, groupPrefix, onRowPress, onStampPress, onActionPress }: LedgerRowProps) {
  const profile = useDeviceProfile();
  const pad = profile.space.s;
  const late = isLate(row.lateAt, nowMs);
  const classes = ['sn-row', late ? 'is-late' : '', row.finished ? 'is-finished' : '', selected ? 'is-selected' : '', row.moved ? 'is-moved' : '', layout.mode === 'stacked' ? 'is-stacked' : '', extraClass ?? '']
    .filter(Boolean)
    .join(' ');

  const stop = (event: MouseEvent) => event.stopPropagation();

  const renderCell = (fitted: FittedColumn): ReactNode => {
    const config = columns.get(fitted.key);
    const cell = row.cells[fitted.key];
    const width = Math.max(0, fitted.px - 2 * pad);
    if (fitted.collapsed.length > 0) {
      const members: StampGroupMember[] = fitted.collapsed.flatMap((key) => {
        const c = row.cells[key];
        return c?.renderer === 'stamp' ? [{ columnKey: key, cell: c.stamp, step: steps.get(c.stamp.stepKey) }] : [];
      });
      return (
        <StampGroup
          members={members}
          {...(row.nextStepKey ? { nextStepKey: row.nextStepKey } : {})}
          {...(onStampPress ? { onPress: (m: StampGroupMember) => onStampPress(row, m.columnKey, m.cell) } : {})}
        />
      );
    }
    if (!cell) return null;
    if (cell.renderer === 'stamp') {
      const press = onStampPress ? () => onStampPress(row, fitted.key, cell.stamp) : undefined;
      // 단계 사슬(적재 → 지급)의 앞 단계가 보이면 동그라미에 그 단계 이름을 쓴다(칸 제목은 마지막 단계).
      const chain = config?.step_keys ?? [];
      const labelled = chain.length > 1 && cell.stamp.stepKey !== chain.at(-1);
      return <Stamp cell={cell.stamp} step={steps.get(cell.stamp.stepKey)} labelled={labelled} {...(press ? { onPress: press } : {})} />;
    }
    if (cell.renderer === 'action') {
      const label = config?.header_label ?? t('call');
      return (
        <button
          type="button"
          className="sn-cell-action"
          aria-label={label}
          disabled={!cell.enabled}
          onClick={(event) => { stop(event); onActionPress?.(row, fitted.key, cell.actionKey); }}
        >
          <Icon name={cell.actionKey === 'call' ? 'phone' : 'more'} />
          <TextFit input={{ mode: 'alts', alts: [label, ''] }} width={Math.max(0, width - profile.baseFontPx * 2)} />
        </button>
      );
    }
    // 늦은 줄은 시각 칸이 빨강(+ 줄 앞 빨간 띠), 늦은 미수(지급일이 지난 미수)는 돈 칸만 빨강.
    const cellLate = (late && cell.renderer === 'time') || (cell.renderer === 'money' && isLate(cell.lateAt, nowMs));
    if (cell.renderer === 'time') {
      // 시각 칸: 빠지지 않는 조각(시각)이 아랫줄, 나머지(날짜 말 · 종류)가 윗줄. 자리 바뀐 줄은 종류 대신 '자리 바뀜'(좁으면 '옮김').
      const main = cell.parts.filter((p) => p.drop === 0);
      const overParts = cell.parts.filter((p) => p.drop > 0);
      const kindDrop = Math.max(0, ...overParts.map((p) => p.drop));
      const movedPart: TextPart = { text: t('moved'), short: t('movedShort'), drop: Math.max(1, kindDrop) };
      const shown = row.moved
        ? [...overParts.filter((p) => p.drop !== kindDrop), movedPart]
        : overParts;
      const over: TextFitInput | null = shown.length ? { mode: 'parts', parts: shown } : null;
      return <CellStack over={over} main={{ mode: 'parts', parts: main.length ? main : cell.parts }} width={width} className={toneClass(cell, cellLate)} />;
    }
    if (cell.renderer === 'money') return <MoneyText cell={cell} width={width} className={toneClass(cell, cellLate)} />;
    // 합쳐 들어온 칸(시각 → 팀 앞, 품목 → 팀 둘째 줄).
    const prefix: TextPart[] = [];
    const secondLines: { key: string; input: TextFitInput }[] = [];
    for (const fold of fitted.folded) {
      const foldedCell = row.cells[fold.key];
      const foldDrop = columns.get(fold.key)?.drop_priority ?? 1;
      const input = cellFitInput(foldedCell, Math.max(1, foldDrop));
      if (!input) continue;
      if (fold.mode === 'prefix' && input.mode === 'parts') prefix.push(...input.parts);
      else secondLines.push({ key: fold.key, input });
    }
    let input = cellFitInput(cell);
    if (!input) return null;
    // 합친 묶음 제목의 쪽: 팀 칸 앞에 반납 타임('16:30 · 김민재 · 0021'), 좁으면 먼저 빠진다(이름 · 끝 4자리는 남음).
    if (cell.renderer === 'team' && groupPrefix) prefix.unshift({ text: groupPrefix, drop: 3 });
    // 시각 칸이 따로 보이면 '자리 바뀜'은 그 칸 윗줄에 있다. 시각이 팀 칸에 합쳐졌을 때만 팀 칸 조각으로 붙인다.
    const movedInTeam = row.moved && cell.renderer === 'team' && !layout.columns.some((c) => c.renderer === 'time');
    if (input.mode === 'parts' && (prefix.length || movedInTeam || row.reviewNote)) {
      const extra: TextPart[] = [];
      if (row.reviewNote && cell.renderer === 'team') extra.push({ text: row.reviewNote, drop: 5 });
      if (movedInTeam) extra.push({ text: t('moved'), drop: 9 });
      input = { mode: 'parts', parts: [...prefix, ...input.parts, ...extra] };
    }
    const fittedText = <TextFit input={input} width={width} className={toneClass(cell, cellLate)} />;
    // 장소 이름표는 팀 이름 뒤 남는 폭에(이름 · 끝 4자리가 먼저).
    const firstLine = cell.renderer === 'team' && row.subgroupLabel ? (
      <span className="sn-team-line">
        {fittedText}
        <PlaceTag label={row.subgroupLabel} short={row.subgroupShortLabel} />
      </span>
    ) : fittedText;
    const content = secondLines.length ? (
      <span className="sn-cell-lines">
        {firstLine}
        {secondLines.map((line) => <TextFit key={line.key} input={line.input} width={width} className="sn-cell-second" />)}
      </span>
    ) : firstLine;
    if (cell.renderer === 'team' && onRowPress) {
      return (
        <button type="button" className="sn-cell-open" onClick={(event) => { stop(event); onRowPress(row); }}>
          {content}
        </button>
      );
    }
    return content;
  };

  const cellClass = (fitted: FittedColumn) => {
    const config = columns.get(fitted.key);
    return ['sn-cell', 'is-' + (config?.renderer_key ?? 'text'), 'align-' + (config?.align_key ?? 'start'), fitted.collapsed.length ? 'is-collapsed' : ''].filter(Boolean).join(' ');
  };

  if (layout.mode === 'stacked') {
    const lines = [1, 2] as const;
    return (
      <tr className={classes} onClick={onRowPress ? () => onRowPress(row) : undefined} data-selected={selected ? "true" : undefined}>
        <td className="sn-cell is-stack">
          {lines.map((line) => (
            <div key={line} className="sn-stack-line">
              {layout.columns.filter((c) => c.line === line).map((fitted) => (
                <div key={fitted.key} className={cellClass(fitted)} style={{ width: fitted.px }}>{renderCell(fitted)}</div>
              ))}
            </div>
          ))}
        </td>
      </tr>
    );
  }
  return (
    <tr className={classes} onClick={onRowPress ? () => onRowPress(row) : undefined} data-selected={selected ? "true" : undefined}>
      {layout.columns.map((fitted) => (
        <td key={fitted.key} className={cellClass(fitted)}>{renderCell(fitted)}</td>
      ))}
    </tr>
  );
}

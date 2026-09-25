// 반납 창의 품목 칸(V1 ②, spec 3-1 · ui 3-1): 줄마다 옅은 종이색 칸 하나 — 왼쪽에 굵은 품목 이름과 회색 둘째 줄(일정별 수 · 대여 수),
// 오른쪽에 재고 방식의 고르기: 번호로 세는 품목은 이 팀이 가진 번호 버튼(고른 번호는 남색 바탕), 수량 품목은 −/+ 수량, 번호가 너무
// 많은 줄은 작은 창을 여는 버튼(`대여 12개 · 번호 선택 ›`). 한 줄에 칸 둘, 번호가 많은 칸(wide)은 한 줄 전체.
// 무엇이 골라졌는지 · 둘째 줄 · 넓은 칸인지는 읽기 모델(returnSheet)이 정했다: 부품은 그리고 누른 것만 알린다. 칸 줄 수는 부르는 쪽이
// 가장 많은 쪽 기준으로 자리를 남겨(rowCount) 쪽을 넘겨도 · 번호를 빼도 창 높이가 그대로다.
import type { ReturnPieceLine } from '@skinote/contract';
import type { CSSProperties } from 'react';
import { t } from '../strings.ko-KR.ts';
import { TextFit } from './TextFit.tsx';

/** 한 줄에 놓는 칸 수(넓은 칸은 혼자 한 줄). */
export const PIECES_PER_ROW = 2;

/** 칸들을 줄로(차례 그대로: 넓은 칸은 혼자, 나머지는 둘씩. 넓은 칸 앞의 홀수 칸은 혼자 한 줄). */
export function pieceRows(lines: readonly ReturnPieceLine[]): ReturnPieceLine[][] {
  const rows: ReturnPieceLine[][] = [];
  let open: ReturnPieceLine[] = [];
  for (const line of lines) {
    if (line.wide) {
      if (open.length) rows.push(open);
      rows.push([line]);
      open = [];
      continue;
    }
    open.push(line);
    if (open.length === PIECES_PER_ROW) {
      rows.push(open);
      open = [];
    }
  }
  if (open.length) rows.push(open);
  return rows;
}

/** 줄들을 쪽으로(한 쪽 rowsPerPage 줄, spec 3-1: 품목 줄 6개 · 세 줄까지 한 쪽). 칸이 없으면 빈 쪽 하나. */
export function piecePages(lines: readonly ReturnPieceLine[], rowsPerPage: number): ReturnPieceLine[][][] {
  const rows = pieceRows(lines);
  const per = Math.max(1, rowsPerPage);
  const pages: ReturnPieceLine[][][] = [];
  for (let i = 0; i < rows.length; i += per) pages.push(rows.slice(i, i + per));
  return pages.length ? pages : [[]];
}

export interface ReturnPiecesProps {
  /** 이 쪽의 줄들(pieceRows · piecePages). */
  rows: readonly (readonly ReturnPieceLine[])[];
  /** 자리를 남길 줄 수(가장 많은 쪽의 줄 수). */
  rowCount: number;
  onPiece: (lineId: string, assetId: string) => void;
  onQuantity: (lineId: string, value: number) => void;
  onPicker: (lineId: string) => void;
  /** 칸의 읽는 이름('스키 번호', '고글 수량'). */
  groupLabel: (line: ReturnPieceLine) => string;
}

function PieceLine({ line, onPiece, onQuantity, onPicker, groupLabel }: Omit<ReturnPiecesProps, 'rows' | 'rowCount'> & { line: ReturnPieceLine }) {
  const classes = ['sn-piece-line', line.wide ? 'is-wide' : '', line.muted ? 'is-muted' : ''].filter(Boolean).join(' ');
  const notes = line.note.split(' · ').map((text, i) => ({ text, drop: i }));
  return (
    <div className={classes} role="group" aria-label={groupLabel(line)}>
      <span className="sn-piece-name">
        <TextFit className="sn-piece-title" input={{ mode: 'words', text: line.label }} />
        <TextFit className="sn-piece-note" input={{ mode: 'parts', parts: notes }} />
      </span>
      <span className="sn-pieces">
        {line.mode === 'count' && line.quantity ? (
          <>
            <button type="button" className="sn-qty-button" aria-label={t('qtyMinus')} disabled={line.quantity.value <= line.quantity.min} onClick={() => onQuantity(line.lineId, line.quantity!.value - 1)}>−</button>
            <output className={'sn-qty-value' + (line.quantity.value === 0 ? ' is-zero' : '')} aria-live="polite">{line.quantity.value + line.quantity.unit}</output>
            <button type="button" className="sn-qty-button" aria-label={t('qtyPlus')} disabled={line.quantity.value >= line.quantity.max} onClick={() => onQuantity(line.lineId, line.quantity!.value + 1)}>+</button>
          </>
        ) : line.pickerLabel ? (
          <button type="button" className="sn-button sn-choice" onClick={() => onPicker(line.lineId)}>{line.pickerLabel}</button>
        ) : (line.pieces ?? []).map((piece) => (
          <button key={piece.assetId} type="button" className="sn-button sn-choice sn-piece" aria-pressed={piece.picked} onClick={() => onPiece(line.lineId, piece.assetId)}>
            {piece.label}
          </button>
        ))}
      </span>
    </div>
  );
}

export function ReturnPieces({ rows, rowCount, ...handlers }: ReturnPiecesProps) {
  // 남길 줄 수만큼 줄 자리(줄 높이는 등급의 누르는 곳 --sn-target): 칸이 적은 쪽에서도 품목 칸 높이가 그대로다.
  const style: CSSProperties = { gridTemplateRows: 'repeat(' + Math.max(1, rowCount) + ', var(--sn-target))' };
  return (
    <div className="sn-piece-lines" style={style}>
      {rows.flatMap((row) => row.map((line) => <PieceLine key={line.lineId} line={line} {...handlers} />))}
    </div>
  );
}

// 자리 지키기(ui 6-1): 보고 있는 동안 줄이 자리를 옮기지 않는다. 도장을 찍어 다음 약속(dueAt)이 바뀐 줄, 다른 기기의
// 변경으로 바뀐 줄은 제자리에 두고 '자리 바뀜'(moved)을 붙인다. 쪽을 넘기거나, 화면을 떠났다 오거나, 60초 동안 손을 대지 않으면
// (settleKey가 바뀌면) 서버 순서로 돌아간다. 새로 생긴 줄은 끝에 붙고, 없어진 줄은 빠진다.
import type { LedgerRow } from '@skinote/contract';
import { useMemo, useRef } from 'react';

interface Placed {
  settleKey: string;
  order: string[];
  /** 자리를 잡을 때의 다음 약속 시각(정렬 기준). 이것이 바뀐 줄이 '자리 바뀜'이다. */
  dueAt: Map<string, string | undefined>;
}

export function keepPositions(rows: readonly LedgerRow[], placed: Placed | null, settleKey: string): { rows: LedgerRow[]; placed: Placed } {
  if (!placed || placed.settleKey !== settleKey) {
    return { rows: [...rows], placed: { settleKey, order: rows.map((r) => r.id), dueAt: new Map(rows.map((r) => [r.id, r.dueAt])) } };
  }
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const kept = placed.order.filter((id) => byId.has(id));
  const known = new Set(kept);
  const added = rows.filter((r) => !known.has(r.id)).map((r) => r.id);
  const dueAt = new Map(placed.dueAt);
  for (const id of added) dueAt.set(id, byId.get(id)!.dueAt);
  const out = [...kept, ...added].map((id) => {
    const row = byId.get(id)!;
    return dueAt.get(id) !== row.dueAt ? { ...row, moved: true } : row;
  });
  return { rows: out, placed: { settleKey, order: [...kept, ...added], dueAt } };
}

/** 화면에서 쓰는 모양: 읽기 모델의 줄 순서를 받아 보고 있는 자리를 지킨 순서를 돌려준다. */
export function useKeptRows(rows: readonly LedgerRow[] | undefined, settleKey: string): LedgerRow[] {
  const placed = useRef<Placed | null>(null);
  return useMemo(() => {
    if (!rows) return [];
    const next = keepPositions(rows, placed.current, settleKey);
    placed.current = next.placed;
    return next.rows;
  }, [rows, settleKey]);
}

// 칸 폭 정하기(ui 4-2). 장부 판의 잰 폭 W에 설정의 칸(em)을 맞춘다. 브라우저 확대(110 · 125%)는 CSS px 폭이
// 줄어든 것으로 똑같이 계산한다. 같은 함수가 화면(기기), 설정 명령(서버), 시험에서 돈다.
//
//   보일 칸 = 기능 · 권한으로 거른 칸(부르는 쪽이 거름)
//   반복:
//     Σ원함 ≤ W  → 남는 폭을 weight 비율로 나눔
//     Σ최소 ≤ W  → 모자란 폭을 (원함 − 최소) 비율로 줄임
//     아니면 하나:  a) drop_priority가 가장 높은 칸을 뺌(fold_into가 있으면 그 칸 안에 합침)
//                  b) 같은 collapse_group의 도장 칸들을 한 칸으로 모음
//                  c) 두 줄 줄(stacked)
//                  d) 그래도 안 되면 too_narrow('화면을 크게 해 주세요')
import type { FoldModeKey, LedgerColumnRow } from '@skinote/contract';

/** 모인 도장 칸의 최소 폭(em): 단계 이름 + 작은 동그라미('반납 ○'). 시각 도장이 섞이면 그 폭이 더 크다. */
export const COLLAPSED_STAMP_MIN_EM = 5;

export interface ColumnSpec {
  key: string;
  renderer: string;
  minEm: number;
  preferredEm: number;
  weight: number;
  /** 0 = 빠지지 않음, 큰 것부터 먼저 빠진다. */
  dropPriority: number;
  foldInto: string | null;
  foldMode: FoldModeKey;
  foldMinShareEm: number;
  collapseGroup: string | null;
}

export function columnSpecs(rows: readonly LedgerColumnRow[]): ColumnSpec[] {
  return [...rows]
    .sort((a, b) => a.seq - b.seq)
    .map((row) => ({
      key: row.column_key,
      renderer: row.renderer_key,
      minEm: row.min_width_em,
      preferredEm: row.preferred_width_em,
      weight: row.weight,
      dropPriority: row.drop_priority,
      foldInto: row.fold_into_column_key,
      foldMode: row.fold_mode_key,
      foldMinShareEm: row.fold_min_share_em,
      collapseGroup: row.collapse_group_key,
    }));
}

export interface FitColumnsOptions {
  /** 등급의 기본 글자 크기(px). em을 px로 바꾸는 값. */
  basePx: number;
  /** 줄 높이가 두 줄을 허락하는지(휴대폰 64px 두 줄 줄). second_line 합침은 이때만. */
  secondLineAllowed: boolean;
  collapsedStampMinEm?: number;
}

export interface FoldedColumn {
  key: string;
  mode: FoldModeKey;
}

export interface FittedColumn {
  key: string;
  renderer: string;
  px: number;
  minPx: number;
  preferredPx: number;
  /** 이 칸 안에 합쳐 그릴 칸(prefix: 앞부분, second_line: 둘째 줄). */
  folded: FoldedColumn[];
  /** 모인 도장 칸이면 모인 칸들(다음 할 단계 하나만 보인다). */
  collapsed: string[];
  /** 두 줄 줄(stacked)에서 몇째 줄인지. 한 줄이면 1. */
  line: 1 | 2;
}

export type ColumnLayoutMode = 'fit' | 'stacked' | 'too_narrow';

export interface ColumnLayout {
  mode: ColumnLayoutMode;
  widthPx: number;
  columns: FittedColumn[];
  /** 합치지 못하고 빠진 칸(내용은 접수증에서 본다). */
  dropped: string[];
  folds: { from: string; into: string; mode: FoldModeKey }[];
  collapsedGroups: { group: string; keys: string[] }[];
  /** 한 줄(또는 두 줄 줄의 넓은 줄)의 최소 · 원함 합(px). */
  totalMinPx: number;
  totalPreferredPx: number;
  /** 나눠 주지 못한 폭(비율이 모두 0일 때). */
  slackPx: number;
}

interface WorkColumn {
  key: string;
  renderer: string;
  minEm: number;
  preferredEm: number;
  weight: number;
  dropPriority: number;
  foldInto: string | null;
  foldMode: FoldModeKey;
  foldMinShareEm: number;
  collapseGroup: string | null;
  folded: FoldedColumn[];
  collapsed: string[];
}

const EPSILON = 1e-6;
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/** 폭을 나눈다: 원함이 들어가면 weight로 늘리고, 최소만 들어가면 (원함 − 최소) 비율로 줄인다. 안 들어가면 null. */
function distribute(columns: readonly WorkColumn[], widthPx: number, basePx: number): { px: number[]; slack: number } | null {
  const min = columns.map((c) => c.minEm * basePx);
  const pref = columns.map((c) => c.preferredEm * basePx);
  const totalPref = sum(pref);
  const totalMin = sum(min);
  if (totalPref <= widthPx + EPSILON) {
    const leftover = widthPx - totalPref;
    const totalWeight = sum(columns.map((c) => c.weight));
    if (totalWeight <= 0) return { px: pref, slack: leftover };
    return { px: pref.map((p, i) => p + (leftover * (columns[i]?.weight ?? 0)) / totalWeight), slack: 0 };
  }
  if (totalMin <= widthPx + EPSILON) {
    const deficit = totalPref - widthPx;
    const room = sum(pref.map((p, i) => p - (min[i] ?? 0)));
    return { px: pref.map((p, i) => p - (room > 0 ? (deficit * (p - (min[i] ?? 0))) / room : 0)), slack: 0 };
  }
  return null;
}

function toFitted(columns: readonly WorkColumn[], px: readonly number[], basePx: number, line: 1 | 2): FittedColumn[] {
  return columns.map((c, i) => ({
    key: c.key,
    renderer: c.renderer,
    px: px[i] ?? 0,
    minPx: c.minEm * basePx,
    preferredPx: c.preferredEm * basePx,
    folded: c.folded,
    collapsed: c.collapsed,
    line,
  }));
}

/** 칸을 잰 폭에 맞춘다. 칸 순서는 설정의 seq 순서 그대로다. */
export function fitColumns(specs: readonly ColumnSpec[], widthPx: number, options: FitColumnsOptions): ColumnLayout {
  const basePx = options.basePx;
  const collapsedMinEm = options.collapsedStampMinEm ?? COLLAPSED_STAMP_MIN_EM;
  let columns: WorkColumn[] = specs.map((s) => ({ ...s, folded: [], collapsed: [] }));
  const dropped: string[] = [];
  const folds: ColumnLayout['folds'] = [];
  const collapsedGroups: ColumnLayout['collapsedGroups'] = [];
  const totals = () => ({
    totalMinPx: sum(columns.map((c) => c.minEm * basePx)),
    totalPreferredPx: sum(columns.map((c) => c.preferredEm * basePx)),
  });

  for (;;) {
    const fit = distribute(columns, widthPx, basePx);
    if (fit) {
      return { mode: 'fit', widthPx, columns: toFitted(columns, fit.px, basePx, 1), dropped, folds, collapsedGroups, ...totals(), slackPx: fit.slack };
    }

    // a) 가장 높은 drop_priority 칸을 뺀다(같으면 뒤쪽 칸부터).
    let victimIndex = -1;
    columns.forEach((c, i) => {
      if (c.dropPriority > 0 && (victimIndex < 0 || c.dropPriority >= (columns[victimIndex]?.dropPriority ?? 0))) victimIndex = i;
    });
    const victim = columns[victimIndex];
    if (victim) {
      columns = columns.filter((_, i) => i !== victimIndex);
      const host = victim.foldInto ? columns.find((c) => c.key === victim.foldInto) : undefined;
      const canFold = host && (victim.foldMode === 'prefix' || options.secondLineAllowed);
      if (host && canFold) {
        host.folded = [...host.folded, { key: victim.key, mode: victim.foldMode }];
        if (victim.foldMode === 'prefix') {
          host.minEm += victim.foldMinShareEm;
          host.preferredEm += victim.foldMinShareEm;
        }
        folds.push({ from: victim.key, into: host.key, mode: victim.foldMode });
      } else {
        dropped.push(victim.key);
      }
      continue;
    }

    // b) 같은 collapse_group의 도장 칸들을 한 칸으로 모은다(다음 할 단계 하나).
    const groupKey = columns.find((c) => c.collapseGroup !== null && c.collapsed.length === 0 && columns.filter((o) => o.collapseGroup === c.collapseGroup).length > 1)?.collapseGroup;
    if (groupKey) {
      const members = columns.filter((c) => c.collapseGroup === groupKey);
      const first = members[0]!;
      const minEm = Math.max(collapsedMinEm, ...members.map((m) => m.minEm));
      const merged: WorkColumn = {
        ...first,
        minEm,
        preferredEm: Math.max(minEm, ...members.map((m) => m.preferredEm)),
        weight: 0,
        dropPriority: 0,
        collapsed: members.map((m) => m.key),
      };
      const at = columns.indexOf(first);
      columns = columns.filter((c) => c.collapseGroup !== groupKey);
      columns.splice(at, 0, merged);
      collapsedGroups.push({ group: groupKey, keys: merged.collapsed });
      continue;
    }

    // c) 두 줄 줄: 1줄 = 도장 · 동작이 아닌 앞의 두 칸(팀 · 품목), 2줄 = 나머지(약속 · 돈 · 도장).
    const lineOne = columns.filter((c) => c.renderer !== 'stamp' && c.renderer !== 'action').slice(0, 2);
    const lineTwo = columns.filter((c) => !lineOne.includes(c));
    const fitOne = distribute(lineOne, widthPx, basePx);
    const fitTwo = distribute(lineTwo, widthPx, basePx);
    const minOne = sum(lineOne.map((c) => c.minEm * basePx));
    const minTwo = sum(lineTwo.map((c) => c.minEm * basePx));
    const prefOne = sum(lineOne.map((c) => c.preferredEm * basePx));
    const prefTwo = sum(lineTwo.map((c) => c.preferredEm * basePx));
    const stackedTotals = { totalMinPx: Math.max(minOne, minTwo), totalPreferredPx: Math.max(prefOne, prefTwo) };
    if (lineOne.length > 0 && lineTwo.length > 0 && fitOne && fitTwo) {
      const fitted = [...toFitted(lineOne, fitOne.px, basePx, 1), ...toFitted(lineTwo, fitTwo.px, basePx, 2)];
      return { mode: 'stacked', widthPx, columns: fitted, dropped, folds, collapsedGroups, ...stackedTotals, slackPx: Math.max(fitOne.slack, fitTwo.slack) };
    }

    // d) 들어가지 않는다: 최소 폭 그대로 두고 화면이 한 문장과 [확대 되돌리기]를 보인다.
    return {
      mode: 'too_narrow',
      widthPx,
      columns: toFitted(columns, columns.map((c) => c.minEm * basePx), basePx, 1),
      dropped,
      folds,
      collapsedGroups,
      ...totals(),
      slackPx: 0,
    };
  }
}


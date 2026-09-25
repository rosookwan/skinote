// 번호로 세는 실물(스키 17번 · 야간권 31번)의 번호 고르기(impl-v2 plan.md 4-1). 줄의 수 셈(issued · returned · collected)이
// 기준이고 번호(assetIds · backAssetIds)는 그 사본이다: 늘 assetIds 길이 = 지급 수, backAssetIds 길이 = 반납 + 수거 수,
// backAssetIds ⊂ assetIds. 수량으로 세는 품목(고글, tracking count)과 세지 않는 품목(none)은 번호가 없다.
// 서버 저장소는 번호를 장비 위치(assets · 이동 줄)로 적는다(plan §4-2). 이동 사실(moves)은 B2a에서 더한다.
import type { FxLine, ShopState } from './model.ts';

/** 실물 id(`${상품 key}-${번호}`, 'ski-17'). 서버의 assets.id와 같다. */
export const assetId = (kind: string, no: string) => kind + '-' + no;

/** 번호로 세는 줄인지(tracking이 없으면 옛 줄 = unit). */
export const numbered = (l: FxLine) => (l.tracking ?? 'unit') === 'unit';

/** 이 줄이 지금 내준 번호(지급했고 아직 돌아오지 않은 것, 지급한 차례). */
export function heldNumbers(l: FxLine): string[] {
  const back = new Set(l.backAssetIds ?? []);
  return (l.assetIds ?? []).filter((id) => !back.has(id));
}

/** 준비해 둔 번호 중 아직 내주지 않은 것(적재한 번호 · 박준호 팀의 준비 번호). */
export function plannedLeft(l: FxLine): string[] {
  const given = new Set(l.assetIds ?? []);
  return (l.plannedAssetIds ?? []).filter((id) => !given.has(id));
}

const noOf = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1)) || 0;

/**
 * 매장 재고의 빈 번호(그 종류, 번호 순): 손님에게 나가 있지 않고, 차량 예비권이 아니고, 다른 줄이 준비해 둔 번호가 아닌 것.
 * forLine의 준비 번호는 비어 있는 것으로 본다(그 줄이 쓸 번호).
 */
export function freeNumbers(state: ShopState, kind: string, forLine?: FxLine): string[] {
  const busy = new Set<string>();
  for (const o of state.orders) {
    for (const l of o.lines) {
      for (const id of heldNumbers(l)) busy.add(id);
      if (l !== forLine) for (const id of plannedLeft(l)) busy.add(id);
    }
  }
  return state.assets
    .filter((a) => a.kind === kind && !a.vehicleId && !busy.has(a.id))
    .map((a) => a.id)
    .sort((a, b) => noOf(a) - noOf(b));
}

export type NumberPick = { ids: string[] } | { error: string };

/**
 * 지급할 번호: 사람이 고른 번호(requested)가 있으면 그것(이 줄의 준비 번호이거나 매장 재고의 빈 번호여야 함), 없으면 준비 번호부터,
 * 그다음 매장 재고의 가장 낮은 빈 번호. 번호가 없는 줄은 빈 목록. taken은 같은 명령의 앞 줄이 이미 고른 번호(같은 종류의 줄이 둘일 때).
 */
export function issueNumbers(state: ShopState, l: FxLine, qty: number, requested?: readonly string[], taken: ReadonlySet<string> = new Set()): NumberPick {
  if (!numbered(l) || qty <= 0) return { ids: [] };
  const mine = plannedLeft(l).filter((id) => !taken.has(id));
  const free = freeNumbers(state, l.kind, l).filter((id) => !taken.has(id));
  if (requested?.length) {
    const ok = new Set([...mine, ...free]);
    if (requested.some((id) => !ok.has(id))) return { error: '장비 위치 불일치' };
    return { ids: requested.slice(0, qty) };
  }
  const pool = [...mine, ...free.filter((id) => !mine.includes(id))];
  if (pool.length < qty) return { error: '지급 불가 · 재고 없음' };
  return { ids: pool.slice(0, qty) };
}

/**
 * 적재할 번호: 이 줄의 준비 번호 중 아직 싣지 않은 것부터, 그다음 매장 재고의 빈 번호(사람이 고른 번호가 있으면 그것).
 * 돌려주는 번호는 준비 번호에 더할 새 번호다(이미 준비 번호였던 것 포함). 실은 번호는 준비 번호의 맨 앞 차례다.
 */
export function loadNumbers(state: ShopState, l: FxLine, qty: number, requested?: readonly string[], taken: ReadonlySet<string> = new Set()): NumberPick {
  if (!numbered(l) || qty <= 0) return { ids: [] };
  const mine = plannedLeft(l);
  const loadedAlready = Math.max(l.loaded, l.issued) - l.issued;
  const pool = [...mine.slice(loadedAlready), ...freeNumbers(state, l.kind, l).filter((id) => !mine.includes(id))].filter((id) => !taken.has(id));
  if (requested?.length) {
    const ok = new Set(pool);
    if (requested.some((id) => !ok.has(id))) return { error: '장비 위치 불일치' };
    return { ids: requested.slice(0, qty) };
  }
  if (pool.length < qty) return { error: '적재 불가 · 재고 없음' };
  return { ids: pool.slice(0, qty) };
}

/**
 * 돌아온 번호(매장 반납 · 차량 수거): 사람이 고른 번호가 있으면 그중 이 줄이 아직 내준 것(이미 돌아온 번호는 건너뜀 —
 * 다른 카운터가 먼저 받았으면 superseded로 끝난다), 이 줄에 준 적 없는 번호가 있으면 거절. 없으면 내준 번호를 지급한 차례로.
 */
export function backNumbers(l: FxLine, qty: number, requested?: readonly string[]): NumberPick {
  if (!numbered(l) || qty <= 0) return { ids: [] };
  const held = heldNumbers(l);
  if (requested?.length) {
    const given = new Set(l.assetIds ?? []);
    if (requested.some((id) => !given.has(id))) return { error: '장비 위치 불일치' };
    const out = new Set(held);
    return { ids: requested.filter((id) => out.has(id)).slice(0, qty) };
  }
  return { ids: held.slice(0, qty) };
}

/** 번호가 있는 줄에서 사람이 번호를 골랐으면 옮길 수는 고른 번호(서로 다른 것) 수를 넘지 않는다. */
export function quantityOf(l: FxLine, quantity: number, requested?: readonly string[]): number {
  const n = Math.max(0, Math.floor(quantity));
  return numbered(l) && requested?.length ? Math.min(n, new Set(requested).size) : n;
}

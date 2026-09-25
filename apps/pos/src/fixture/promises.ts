// 반납 일정이 품목 · 수량으로 나뉜 접수(일정 변경 N2, V9 · data-model 4-6 · 4-18)의 셈(체험 전용). 줄마다 일정 몫(bucket)을 나누고,
// 차량이 받는 일정마다 차량 업무 하나(collect:<접수> · collect:<접수>:<일정 id>)를 만든다. 줄의 수 셈(issued · returned · collected ·
// received)이 기준이고, 일정 몫은 그것을 나눈 것이다:
//   - 지급은 **원래 일정부터** 채운다.
//   - 매장 반납은 명령 때 어느 일정 몫인지 적는다(attributeReturn): 매장 일정(이른 차례)부터, 그다음 원래 일정, 그다음 차량으로 나눈 일정
//     (손님이 두솔동에서 주기로 한 것은 그대로, data-model 4-18 — 차량 → 차량으로 나눈 경우의 규칙). 매장 일정으로 옮긴 몫을 손님이
//     가져오면 그 일정이 채워진다(차량 업무가 받을 수는 줄지 않는다). 적지 않은 반납(옛 자료)은 원래 일정부터 채운다.
//   - 차량 수거 · 매장 입고는 그 업무의 일정 몫이다(나눈 일정은 split.returned · collected · received로 따로 센다).
// 화면은 이 셈을 모른다: 읽기 모델(수거 목록 줄 · 접수증 일정 줄 · 처리 현황)만 받는다. LocalClient가 오면 폴더째 없어진다.
// 이 파일은 model · time만 가져온다(rules.ts가 이 파일을 쓴다).
import type { FxLine, FxOrder, FxPromise, FxPromiseSplit, FxState } from './model.ts';

/** 줄 하나의 일정 몫. key null = 원래 일정(giveBack), 아니면 나눈 일정의 id. */
export interface FxBucket {
  key: string | null;
  promise: FxPromise;
  /** 이 일정으로 돌아올 수. */
  planned: number;
  issued: number;
  returned: number;
  collected: number;
  received: number;
}

/** 아직 돌아오지 않은 수(지급 전 포함): 일정 변경으로 옮길 수 있는 수. */
export const bucketLeft = (b: FxBucket) => Math.max(0, b.planned - b.returned - b.collected);
/** 손님에게 나가 있는 수(차량이 받을 수). */
export const bucketOut = (b: FxBucket) => Math.max(0, b.issued - b.returned - b.collected);
/** 차에 있는 수(수거했지만 매장 입고 전). */
export const bucketOnVan = (b: FxBucket) => Math.max(0, b.collected - b.received);

/** 같은 일정인지(시각 · 방법 · 장소 · 차량). */
export function samePromise(a: FxPromise, b: FxPromise): boolean {
  if (a.at !== b.at || a.mode !== b.mode) return false;
  return a.mode === 'store' || (a.placeId === b.placeId && a.vehicleId === b.vehicleId);
}

const splitsOf = (o: FxOrder, l: FxLine): FxPromiseSplit[] => (o.splits ?? []).filter((s) => s.lineId === l.id && s.quantity > 0);
const sum = (list: readonly FxPromiseSplit[], pick: (s: FxPromiseSplit) => number) => list.reduce((n, s) => n + pick(s), 0);

/** 줄 하나를 일정 몫으로 나눈다(원래 일정 먼저, 나눈 일정은 만든 차례). */
export function lineBuckets(o: FxOrder, l: FxLine): FxBucket[] {
  const splits = splitsOf(o, l);
  const main: FxBucket = {
    key: null, promise: o.giveBack, planned: Math.max(0, l.qty - sum(splits, (s) => s.quantity)), issued: 0, returned: 0,
    collected: Math.max(0, l.collected - sum(splits, (s) => s.collected ?? 0)),
    received: Math.max(0, (l.received ?? 0) - sum(splits, (s) => s.received ?? 0)),
  };
  const list: FxBucket[] = [
    main,
    ...splits.map((s) => ({ key: s.id, promise: s.promise, planned: s.quantity, issued: 0, returned: 0, collected: s.collected ?? 0, received: s.received ?? 0 })),
  ];
  // 지급은 원래 일정부터(수거한 수보다 적게 나눠 주지 않는다).
  let issued = l.issued;
  for (const b of list) {
    b.issued = Math.min(b.planned, Math.max(b.collected, issued));
    issued = Math.max(0, issued - b.issued);
  }
  // 매장 반납: 나눈 일정에 적어 둔 몫(attributeReturn)은 그 일정에, 적지 않은 몫은 원래 일정부터(data-model 4-18).
  splits.forEach((s, i) => { const b = list[i + 1]!; b.returned = Math.min(s.returned ?? 0, Math.max(0, b.issued - b.collected)); });
  let returned = Math.max(0, l.returned - list.reduce((n, b) => n + b.returned, 0));
  for (const b of list) {
    const take = Math.min(returned, Math.max(0, b.issued - b.collected - b.returned));
    b.returned += take;
    returned -= take;
  }
  return list;
}

/**
 * 매장 반납 qty개를 일정 몫에 적는다(명령 때, 줄의 returned를 더하기 전에 부른다): 매장 일정(원래 일정이 매장이면 그것도, 이른 차례)부터,
 * 그다음 차량인 원래 일정, 그다음 차량으로 나눈 일정. 나눈 일정의 몫은 split.returned에 적고, 원래 일정 몫은 적지 않는다(적지 않은 반납은
 * 원래 일정부터 채운다).
 */
export function attributeReturn(o: FxOrder, l: FxLine, qty: number): void {
  const buckets = lineBuckets(o, l).filter((b) => b.planned > 0);
  const store = buckets.filter((b) => b.promise.mode === 'store').sort((a, b) => a.promise.at - b.promise.at);
  const van = buckets.filter((b) => b.promise.mode !== 'store');
  let rest = qty;
  for (const b of [...store, ...van.filter((b) => b.key === null), ...van.filter((b) => b.key !== null)]) {
    if (rest <= 0) break;
    const take = Math.min(rest, bucketOut(b));
    if (take <= 0) continue;
    rest -= take;
    if (b.key === null) continue;
    const row = splitRow(o, b.key, l.id);
    if (row) row.returned = (row.returned ?? 0) + take;
  }
}

/** 줄이 아직 돌려받을 수(모든 일정 몫). */
export const lineLeft = (o: FxOrder, l: FxLine) => (l.returnable ? lineBuckets(o, l).reduce((n, b) => n + bucketLeft(b), 0) : 0);

/** 반납 일정 하나와 그 일정에 남은 품목(돌려받는 줄만). */
export interface FxReturnPromise {
  key: string | null;
  promise: FxPromise;
  lines: { l: FxLine; left: number; bucket: FxBucket }[];
}

/**
 * 접수의 반납 일정들(원래 일정 + 나눈 일정, 같은 일정은 하나로). lines는 그 일정에 걸린 돌려받는 줄 모두(left = 아직 돌아오지 않은 수).
 * 원래 일정에 걸린 줄이 없으면(모두 옮김) 원래 일정은 빠진다.
 */
export function returnPromises(o: FxOrder): FxReturnPromise[] {
  const out: FxReturnPromise[] = [];
  for (const l of o.lines) {
    if (!l.returnable) continue;
    for (const bucket of lineBuckets(o, l)) {
      if (bucket.planned <= 0) continue;
      let group = out.find((g) => samePromise(g.promise, bucket.promise));
      if (!group) {
        group = { key: bucket.key, promise: bucket.promise, lines: [] };
        out.push(group);
      }
      group.lines.push({ l, left: bucketLeft(bucket), bucket });
    }
  }
  return out;
}

/** 아직 돌려받을 것이 남은 반납 일정(이른 차례). */
export function openReturns(o: FxOrder): FxReturnPromise[] {
  return returnPromises(o).filter((g) => g.lines.some((x) => x.left > 0)).sort((a, b) => a.promise.at - b.promise.at);
}

/** 지금의 반납 일정: 아직 남은 것 중 가장 이른 일정, 모두 돌아왔으면 원래 일정. 장부 칸 · 늦음 · 접수증 일정 줄이 쓴다. */
export function currentReturn(o: FxOrder): FxPromise {
  return openReturns(o)[0]?.promise ?? o.giveBack;
}

// ── 차량 업무(수거) ────────────────────────────────────────────────

/** 차량 수거 업무 하나 = 차량이 받는 반납 일정 하나. */
export interface FxTask {
  id: string;
  order: FxOrder;
  /** null = 원래 일정. */
  key: string | null;
  promise: FxPromise;
}

export const collectTaskIdOf = (o: FxOrder, key: string | null) => 'collect:' + o.id + (key ? ':' + key : '');

/** 이 접수의 차량 수거 업무(차량 일정마다 하나, 원래 일정 먼저). */
export function orderTasks(o: FxOrder): FxTask[] {
  const seen = new Set<string>();
  const out: FxTask[] = [];
  for (const l of o.lines) {
    if (!l.returnable) continue;
    for (const b of lineBuckets(o, l)) {
      const id = collectTaskIdOf(o, b.key);
      if (b.planned <= 0 || b.promise.mode !== 'vehicle' || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, order: o, key: b.key, promise: b.promise });
    }
  }
  return out.sort((a, b) => Number(a.key !== null) - Number(b.key !== null));
}

/** 업무 id로 업무를 찾는다('collect:o22' · 'collect:o22:s19411'). */
export function findTask(state: FxState, taskId: string): FxTask | undefined {
  const [, orderId] = taskId.split(':');
  const o = state.orders.find((x) => x.id === orderId);
  return o ? orderTasks(o).find((t) => t.id === taskId) : undefined;
}

/** 줄의 이 업무 몫(없으면 undefined). */
export function taskBucket(task: FxTask, l: FxLine): FxBucket | undefined {
  return lineBuckets(task.order, l).find((b) => b.key === task.key && b.planned > 0);
}

/**
 * 업무 하나를 접수 모양으로 비춘 것(읽기 전용): 일정 = 그 업무의 일정, 줄 = 그 일정 몫의 수만. 수거 목록의 칸 · 도장 · 품목과
 * 수거 확인 창은 이 모양으로 그린다(원래 셈을 그대로 쓴다). 여기에 명령을 적용하지 않는다(명령은 원래 접수에).
 */
export function taskOrder(task: FxTask): FxOrder {
  const o = task.order;
  const lines = o.lines.flatMap((l): FxLine[] => {
    const b = l.returnable ? taskBucket(task, l) : undefined;
    if (!b) return [];
    return [{
      ...l,
      qty: b.planned,
      amount: l.qty > 0 ? Math.round((l.amount * b.planned) / l.qty) : 0,
      issued: b.issued,
      returned: b.returned,
      collected: b.collected,
      received: b.received,
    }];
  });
  const { splits: _splits, ...rest } = o;
  return { ...rest, giveBack: task.promise, lines };
}

/** 나눈 일정의 행(줄 하나). */
export function splitRow(o: FxOrder, key: string, lineId: string): FxPromiseSplit | undefined {
  return (o.splits ?? []).find((s) => s.id === key && s.lineId === lineId);
}

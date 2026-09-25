// 견본 하루를 서버의 시험 매장에 넣을 모양으로 바꾼다(plan §4-6 load-sample, D14). 견본 하루(sampleDay)는 체험판 id('o21' …)와 그 날짜의
// 접수 번호 1 ~ 18, 매장 재고의 가장 낮은 번호를 쓴다. 이미 쓰던 매장에 넣으면 겹치므로:
//   - id: 모든 접수 id에 날짜 앞글자를 붙인다('o21' → 'i261226-o21'). 줄 · 수납 · 고정 id와 결제 팀 참조도 따라간다. 날짜가 다른 두
//     가져오기는 겹치지 않는다(같은 날짜 두 번은 저장소가 요청번호로 막는다).
//   - 접수 번호: 그 날짜의 다음 빈 번호부터 차례로(원래 번호 차례를 지킨다).
//   - 번호 실물: 견본이 쓴 번호를 그 종류의 빈 번호(손님에게 나가 있지 않고 준비해 두지 않은 것)로 바꾼다. 빈 번호가 모자라면 던진다.
// 체험판은 이 함수를 쓰지 않는다(체험 id 그대로).
import type { FxOrder, FxPin, ShopState } from '../model.ts';

export interface ImportOptions {
  /** 날짜 'YYYY-MM-DD'(접수 번호 · id 앞글자). */
  date: string;
  /** 그 날짜의 다음 빈 접수 번호. */
  startSeq: number;
  /** 종류(상품 key)의 빈 번호 실물 id(번호 차례). */
  free: (kind: string) => readonly string[];
}

/** 가져올 하루(새 사본). id · 접수 번호 · 번호 실물을 바꾸고, 다음 접수 번호를 적는다. */
export function prepareImport(day: ShopState, options: ImportOptions): ShopState {
  const out = structuredClone(day);
  const yymmdd = options.date.slice(2).replace(/-/g, '');
  const prefix = 'i' + yymmdd + '-';
  const ids = new Map(out.orders.map((o) => [o.id, prefix + o.id]));
  const orderId = (id: string | undefined) => (id === undefined ? undefined : ids.get(id) ?? id);
  const swapPrefix = (id: string, from: string, to: string) => (id.startsWith(from) ? to + id.slice(from.length) : id);

  // 번호 실물: 종류마다 빈 번호를 차례로 준다(같은 견본 번호는 같은 새 번호).
  const assetMap = new Map<string, string>();
  const pools = new Map<string, string[]>();
  const asset = (kind: string, id: string): string => {
    const seen = assetMap.get(id);
    if (seen) return seen;
    let pool = pools.get(kind);
    if (!pool) {
      pool = [...options.free(kind)];
      pools.set(kind, pool);
    }
    const next = pool.shift();
    if (next === undefined) throw new Error('빈 번호가 모자라다: ' + kind);
    assetMap.set(id, next);
    return next;
  };

  // 접수 번호: 원래 번호 차례대로 startSeq부터.
  const byNo = [...out.orders].sort((a, b) => a.receiptNo.localeCompare(b.receiptNo));
  const receipts = new Map(byNo.map((o, i) => [o.id, yymmdd + '-' + String(options.startSeq + i).padStart(3, '0')]));

  const renameOrder = (o: FxOrder): FxOrder => {
    const from = o.id;
    const to = ids.get(from) ?? from;
    return {
      ...o,
      id: to,
      receiptNo: receipts.get(from) ?? o.receiptNo,
      ...(o.payerOrderId !== undefined ? { payerOrderId: orderId(o.payerOrderId)! } : {}),
      lines: o.lines.map((l) => ({
        ...l,
        id: swapPrefix(l.id, from, to),
        ...(l.payerOrderId !== undefined ? { payerOrderId: orderId(l.payerOrderId)! } : {}),
        ...(l.assetIds ? { assetIds: l.assetIds.map((a) => asset(l.kind, a)) } : {}),
        ...(l.backAssetIds ? { backAssetIds: l.backAssetIds.map((a) => asset(l.kind, a)) } : {}),
        ...(l.plannedAssetIds ? { plannedAssetIds: l.plannedAssetIds.map((a) => asset(l.kind, a)) } : {}),
      })),
      payments: o.payments.map((p) => ({
        ...p,
        id: swapPrefix(p.id, from, to),
        ...(p.lines ? { lines: p.lines.map((x) => ({ ...x, lineId: swapPrefix(x.lineId, from, to) })) } : {}),
      })),
      ...(o.splits ? { splits: o.splits.map((s) => ({ ...s, lineId: swapPrefix(s.lineId, from, to) })) } : {}),
      ...(o.charges ? { charges: o.charges.map((c) => ({ ...c, lineId: swapPrefix(c.lineId, from, to) })) } : {}),
    };
  };
  out.orders = out.orders.map(renameOrder);
  out.pins = out.pins.map((p): FxPin => ({
    ...p,
    id: prefix + p.id,
    orderId: orderId(p.orderId)!,
    ...(p.taskId !== undefined ? { taskId: p.taskId.replace(':' + p.orderId, ':' + orderId(p.orderId)) } : {}),
  }));
  out.deposits = out.deposits.map((d) => {
    const to = orderId(d.orderId)!;
    return {
      ...d, id: swapPrefix(d.id, 'dep:' + d.orderId, 'dep:' + to), orderId: to,
      entries: d.entries.map((e) => ({ ...e, lineId: swapPrefix(e.lineId, d.orderId, to), ...(e.assetIds ? { assetIds: e.assetIds.map((a) => assetMap.get(a) ?? a) } : {}) })),
    };
  });
  out.paymentGroups = out.paymentGroups.map((g) => ({ ...g, ...(g.payerOrderId !== undefined ? { payerOrderId: orderId(g.payerOrderId)! } : {}) }));
  out.routeRanks = Object.fromEntries(Object.entries(out.routeRanks).map(([taskId, rank]) => [taskId.replace(/^(\w+):([^:]+)/, (_, kind: string, id: string) => kind + ':' + (orderId(id) ?? id)), rank]));
  out.nextReceiptSeq = options.startSeq + out.orders.length;
  return out;
}

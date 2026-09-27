// 리프트권(work/impl-features-1/plan.md §8-1 · §8-2, E20 · E21): 머리줄 메뉴 `리프트권`의 화면과 그 명령.
//   - 분실 처리(stock.write_off): 손님에게서 돌아오지 않은 권(수량으로 세고 보증금이 없는 줄)을 청구 없이 닫는다(폐기·분실로 옮김, 돈 없음,
//     README 열린 질문 35 ①). 줄의 lost가 늘고 수거 예정(일정 몫)이 준다(나눈 일정 먼저, promises.ts lineBuckets). 접수가 끝날 수 있다.
//   - 분실 회수(asset.found): 분실 처리한 권을 찾음(폐기·분실 → 매장, found가 는다).
//   - 보냄 대기로 온 수거가 손님에게 있는 수보다 많으면(분실 처리한 뒤 기사가 받아 옴) 그 몫의 분실 처리를 먼저 되돌린다(commands.ts stock.collect).
//   - 예비권 적재 · 입고(stock.load · stock.receive의 spares, E21): 카운터가 차량에 싣는 · 내리는 수량 예비권(ShopState.vanSpares).
//   - 화면(ticketBoard): `현황`(그 영업일의 권종마다 지급 · 미반납 · 반납 · 분실, 차량 칸마다 예비권 재고와 적재 · 입고) · `미반납`(모든 날의 안 돌아온
//     권, 늦으면 빨강) · `분실`(분실 처리한 권, `분실 회수`). 창: ticketLossSheet(분실 처리 · 분실 회수) · spareSheet(예비권 적재 · 입고).
// 화면 글은 docs/design/wording.md 3-20(확인 대기)의 말이다. 화면은 셈하지 않는다(읽기 모델만).
import {
  ACTION_LABELS, DomainError, type CommandEnvelope, type FitPart, type LineUnits, type ReturnPieceLine, type RichText, type SlipAdjustment, type SpareSheetParams,
  type SpareSheetView, type SpareUnits, type TicketBoardParams, type TicketBoardView, type TicketLossSheetParams, type TicketLossSheetView, type TicketRow,
  type TicketStatusRow, type TicketTabKey, type TicketVehicleBlock,
} from '@skinote/contract';
import { productOf, type FxProduct } from './catalog.ts';
import type { FxLine, FxOrder, FxPromise, FxVanSpare, ShopRegistry, ShopState } from './model.ts';
import { bucketOut, lineBuckets, orderTasks, taskOrder } from './promises.ts';
import { rejected, type Result } from './result.ts';
import { activeVehicles, collectDone, findOrder, lateAtOf, lineHasDeposit, lossEligible, outQty, placeLabel } from './rules.ts';
import { bizHm, businessDateOf, dateTitle, dayWord, hm, iso, shopCutoff } from './time.ts';
import type { ViewContext } from './views.ts';

export const TICKET_WORDS = Object.freeze({
  /** 화면 이름(메뉴 `리프트권`). */
  screen: '리프트권',
  status: '현황',
  unreturned: '미반납',
  lost: '분실',
  total: '합계',
  kind: '권종',
  issued: '지급',
  returned: '반납',
  /** 동작 이름(0004 sys_actions.ticket_loss). */
  loss: ACTION_LABELS.ticket_loss,
  found: '분실 회수',
  load: '예비권 적재',
  unload: '예비권 입고',
  spareStock: '예비권 재고',
  none: '없음',
  noCharge: '청구 없음',
  cancelCollect: '수거 취소',
  vanStock: '차량 재고',
  yesterday: '어제',
  noLoss: '분실 대상 없음',
  noUnload: '입고 대상 없음',
  noUnreturned: '미반납 없음',
  noLost: '분실 없음',
  lossDeposit: '분실 처리 불가 · 보증금 몰수',
  loadNumbered: '예비권 적재 불가 · 번호 권',
  noPhone: '전화번호 없음',
});

// ── 권 줄 ───────────────────────────────────────────────────────────

/** 권(리프트권) 줄: 리프트권 결제 칸의 줄. */
export const isTicketLine = (l: Pick<FxLine, 'section'>) => l.section === 'lift';
/** 지금 분실인 수(분실 처리 − 찾은 것). */
export const lostNow = (l: Pick<FxLine, 'lost' | 'found'>) => Math.max(0, (l.lost ?? 0) - (l.found ?? 0));
/** 줄의 세는 말(`매`). */
const unitOf = (l: Pick<FxLine, 'unit' | 'countWord'>) => l.unit ?? l.countWord ?? '매';

const hasDeposit = lineHasDeposit;

/** 손님에게 있는 권 줄(분실 처리의 대상). */
const ticketsOut = (o: FxOrder) => o.lines.filter((l) => isTicketLine(l) && l.returnable && outQty(l) > 0);

/** 미반납 리프트권(0004 tickets_out, 접수증 옆 동작 `분실 처리`의 조건): 분실 처리할 수 있는 줄에 손님에게 있는 권이 있다. */
export const hasTicketsOut = (state: ShopState, o: FxOrder) => o.lines.some((l) => lossEligible(state, o, l) && outQty(l) > 0);

/** 권종(리프트권 상품, 종류 타일 차례). */
export function ticketProducts(reg: ShopRegistry): FxProduct[] {
  const seen = new Set<string>();
  const out: FxProduct[] = [];
  for (const kind of reg.kinds) {
    for (const key of kind.products) {
      const p = reg.products[key];
      if (!p || p.section !== 'lift' || seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/** 차량 예비권으로 싣고 내릴 수 있는 권종(수량으로 세는 권, E21). */
export const spareProducts = (reg: ShopRegistry) => ticketProducts(reg).filter((p) => p.tracking === 'count');

const shortOf = (p: Pick<FxProduct, 'label' | 'shortLabel'> | undefined, fallback: string) => p?.shortLabel ?? p?.label ?? fallback;
const productOfLine = (reg: ShopRegistry, l: FxLine) => productOf(reg, l.productKey ?? l.kind);

/** 권 조각 글(`야간권 1매 · 오전권 2매`): 같은 권종(짧은 이름)은 더한다. */
function ticketText(reg: ShopRegistry, list: readonly { l: FxLine; qty: number }[]): string {
  const out: { label: string; qty: number; unit: string }[] = [];
  for (const { l, qty } of list) {
    if (qty <= 0) continue;
    const label = shortOf(productOfLine(reg, l), l.shortLabel);
    const same = out.find((x) => x.label === label);
    if (same) same.qty += qty;
    else out.push({ label, qty, unit: unitOf(l) });
  }
  return out.map((x) => x.label + ' ' + x.qty + x.unit).join(' · ');
}

// ── 명령 ────────────────────────────────────────────────────────────

/** 줄마다 수(같은 줄을 두 번 보내면 더한다, 0은 뺀다). */
function picks(o: FxOrder, lines: readonly LineUnits[]): { l: FxLine; qty: number }[] | null {
  const out = new Map<string, { l: FxLine; qty: number }>();
  for (const x of lines) {
    const l = o.lines.find((y) => y.id === x.lineId);
    if (!l) return null;
    const qty = Math.floor(x.quantity);
    if (!(qty >= 0)) return null;
    if (qty === 0) continue;
    const seen = out.get(l.id);
    if (seen) seen.qty += qty;
    else out.set(l.id, { l, qty });
  }
  return [...out.values()];
}

/**
 * 분실 처리(stock.write_off, E20): 분실 처리할 수 있는 권 줄에서 손님에게 있는 수까지. 돈은 움직이지 않는다(청구 없음). 결과: 분실 처리한 수.
 */
export function writeOffTickets(state: ShopState, envelope: CommandEnvelope<'stock.write_off'>, now: number): Result {
  const p = envelope.payload;
  const o = findOrder(state, p.orderId);
  if (!o) return rejected('접수 없음');
  if (p.reasonKey !== 'lost') return rejected(TICKET_WORDS.noLoss);
  const list = picks(o, p.lines);
  if (!list || list.length === 0) return rejected(TICKET_WORDS.noLoss);
  for (const { l, qty } of list) {
    if (!lossEligible(state, o, l)) return rejected(hasDeposit(state, o, l) ? TICKET_WORDS.lossDeposit : TICKET_WORDS.noLoss);
    if (qty > outQty(l)) return rejected(TICKET_WORDS.noLoss);
  }
  for (const { l, qty } of list) {
    l.lost = (l.lost ?? 0) + qty;
    l.lostAt = now;
  }
  return { outcome: 'applied', result: { lost: list.reduce((n, x) => n + x.qty, 0) } };
}

/** 분실 회수(asset.found, E20): 지금 분실인 수까지 찾음(매장으로). 결과: 찾은 수. */
export function foundTickets(state: ShopState, envelope: CommandEnvelope<'asset.found'>, now: number): Result {
  const p = envelope.payload;
  const o = findOrder(state, p.orderId);
  if (!o) return rejected('접수 없음');
  const list = picks(o, p.lines);
  if (!list || list.length === 0) return rejected(TICKET_WORDS.noLoss);
  for (const { l, qty } of list) if (!isTicketLine(l) || qty > lostNow(l)) return rejected(TICKET_WORDS.noLoss);
  for (const { l, qty } of list) {
    l.found = (l.found ?? 0) + qty;
    l.foundAt = now;
  }
  return { outcome: 'applied', result: { found: list.reduce((n, x) => n + x.qty, 0) } };
}

/** 차량 · 상품의 예비권 행(없으면 없음). */
const spareRow = (state: ShopState, vehicleId: string, productKey: string) => (state.vanSpares ?? []).find((x) => x.vehicleId === vehicleId && x.productKey === productKey);

/** 예비권 행의 차례(매장 목록의 차량 차례 → 상품 차례, 저장소 loadVanSpares와 같다). */
function sortSpares(reg: ShopRegistry, rows: FxVanSpare[]): FxVanSpare[] {
  const vehicles = reg.vehicles.map((v) => v.id);
  const products = Object.keys(reg.products);
  return rows.sort((a, b) => vehicles.indexOf(a.vehicleId) - vehicles.indexOf(b.vehicleId) || products.indexOf(a.productKey) - products.indexOf(b.productKey));
}

/**
 * 예비권 적재 · 입고(stock.load · stock.receive의 spares, E21): 수량으로 세는 권종만. 적재는 쓰는 차량에(행이 없으면 만든다), 입고는 차에 있는 수까지.
 * 잘못이면 거절 결과, 괜찮으면 null(적용함).
 */
export function moveSpares(state: ShopState, vehicleId: string, spares: readonly SpareUnits[], direction: 'load' | 'unload'): Result | null {
  const reg = state.registry;
  const vehicle = reg.vehicles.find((v) => v.id === vehicleId);
  if (!vehicle || (direction === 'load' && vehicle.ended)) return rejected('차량 없음');
  const allowed = new Set(spareProducts(reg).map((p) => p.key));
  const want = new Map<string, number>();
  for (const x of spares) {
    const qty = Math.floor(x.quantity);
    if (!allowed.has(x.productKey) || !(qty >= 1)) return rejected(direction === 'load' ? TICKET_WORDS.loadNumbered : TICKET_WORDS.noUnload);
    want.set(x.productKey, (want.get(x.productKey) ?? 0) + qty);
  }
  if (want.size === 0) return rejected(direction === 'load' ? TICKET_WORDS.loadNumbered : TICKET_WORDS.noUnload);
  if (direction === 'unload') {
    for (const [key, qty] of want) if (qty > Math.max(0, spareRow(state, vehicleId, key)?.quantity ?? 0)) return rejected(TICKET_WORDS.noUnload);
  }
  const rows = [...(state.vanSpares ?? [])];
  for (const [key, qty] of want) {
    let row = rows.find((x) => x.vehicleId === vehicleId && x.productKey === key);
    if (!row) {
      row = { vehicleId, productKey: key, quantity: 0 };
      rows.push(row);
    }
    row.quantity += direction === 'load' ? qty : -qty;
  }
  state.vanSpares = sortSpares(reg, rows);
  return null;
}

// ── 화면(ticketBoard) ─────────────────────────────────────────────────

/** 반납 일정 글(`반납 22:10 · 만선 티롤 앞`, 어제면 `반납 어제 22:00 · …`, 매장이면 `… · 매장`). */
function backText(state: ShopState, p: FxPromise): string {
  const cutoff = shopCutoff(state.settings);
  const day = businessDateOf(p.at, cutoff);
  const yesterday = businessDateOf(p.at + 24 * 3_600_000, cutoff) === state.businessDate;
  const dayPart = day === state.businessDate ? '' : (yesterday ? TICKET_WORDS.yesterday : dayWord(p.at, state.businessDate, cutoff)) + ' ';
  const where = p.mode === 'store' ? '매장' : placeLabel(state.registry, p.placeId);
  return TICKET_WORDS.returned + ' ' + dayPart + bizHm(p.at, cutoff) + (where ? ' · ' + where : '');
}

/**
 * 분실한 때: 오늘이면 시각(`분실 23:40`), 어제면 `분실 어제`, 그 앞은 날짜(`분실 12/24`). 제목이 이미 오늘 날짜를 말하므로 같은 날짜를 다시 쓰지
 * 않는다(2026-09-27 점검, 날짜 규칙 `오늘 · 내일 · 모레`).
 */
function lostDay(state: ShopState, at: number | undefined): string {
  if (at === undefined) return TICKET_WORDS.lost;
  const cutoff = shopCutoff(state.settings);
  const day = businessDateOf(at, cutoff);
  if (day === state.businessDate) return TICKET_WORDS.lost + ' ' + bizHm(at, cutoff);
  if (businessDateOf(at + 24 * 3_600_000, cutoff) === state.businessDate) return TICKET_WORDS.lost + ' ' + TICKET_WORDS.yesterday;
  const [, m = '1', d = '1'] = day.split('-');
  return TICKET_WORDS.lost + ' ' + Number(m) + '/' + Number(d);
}

/** 접수의 안 돌아온 권의 가장 이른 반납 일정(일정 몫마다). */
function earliestBack(o: FxOrder): FxPromise | undefined {
  let first: FxPromise | undefined;
  for (const l of ticketsOut(o)) {
    for (const b of lineBuckets(o, l)) {
      if (bucketOut(b) <= 0) continue;
      if (!first || b.promise.at < first.at) first = b.promise;
    }
  }
  return first;
}

/** 미반납 줄(팀마다, 모든 날): 늦은 것은 빨강. */
function unreturnedRows(ctx: ViewContext): TicketRow[] {
  const state = ctx.state;
  const rows: { at: number; row: TicketRow }[] = [];
  for (const o of state.orders) {
    const out = ticketsOut(o);
    if (!out.length) continue;
    const back = earliestBack(o) ?? o.giveBack;
    const late = lateAtOf(state.settings, back) <= ctx.now;
    const eligible = out.some((l) => lossEligible(state, o, l));
    const deposit = out.some((l) => hasDeposit(state, o, l));
    rows.push({
      at: back.at,
      row: {
        key: 'out:' + o.id, orderId: o.id, team: o.teamName + ' · ' + o.last4, teamName: o.teamName,
        parts: [{ text: ticketText(state.registry, out.map((l) => ({ l, qty: outQty(l) }))), drop: 0 }, { text: backText(state, back), drop: 1, words: true }],
        late,
        actions: [
          { key: 'loss', label: TICKET_WORDS.loss, enabled: eligible, ...(eligible ? {} : { reason: deposit ? TICKET_WORDS.lossDeposit : TICKET_WORDS.noLoss }) },
          { key: 'call', label: ACTION_LABELS.call, enabled: o.phone !== '', ...(o.phone ? {} : { reason: TICKET_WORDS.noPhone }) },
        ],
      },
    });
  }
  return rows.sort((a, b) => a.at - b.at || a.row.orderId.localeCompare(b.row.orderId)).map((x) => x.row);
}

/** 분실 줄(팀마다): `분실 회수`. */
function lostRows(ctx: ViewContext): TicketRow[] {
  const state = ctx.state;
  const rows: { at: number; row: TicketRow }[] = [];
  for (const o of state.orders) {
    const lost = o.lines.filter((l) => isTicketLine(l) && lostNow(l) > 0);
    if (!lost.length) continue;
    const at = Math.max(...lost.map((l) => l.lostAt ?? 0));
    rows.push({
      at,
      row: {
        key: 'lost:' + o.id, orderId: o.id, team: o.teamName + ' · ' + o.last4, teamName: o.teamName,
        parts: [{ text: ticketText(state.registry, lost.map((l) => ({ l, qty: lostNow(l) }))), drop: 0 }, { text: lostDay(state, at || undefined), drop: 1 }],
        late: false,
        actions: [{ key: 'found', label: TICKET_WORDS.found, enabled: true }],
      },
    });
  }
  return rows.sort((a, b) => b.at - a.at || a.row.orderId.localeCompare(b.row.orderId)).map((x) => x.row);
}

/** 현황 표(권종마다 + 합계): 그 영업일에 지급한 권 줄의 지급 · 미반납 · 반납 · 분실. */
function statusRows(state: ShopState, date: string): TicketStatusRow[] {
  const cutoff = shopCutoff(state.settings);
  const products = ticketProducts(state.registry);
  const rows: TicketStatusRow[] = products.map((p) => ({ key: p.key, label: shortOf(p, p.key), issued: 0, out: 0, returned: 0, lost: 0, unit: p.unit ?? '매' }));
  for (const o of state.orders) {
    for (const l of o.lines) {
      if (!isTicketLine(l) || l.issued <= 0 || l.issuedAt === undefined || businessDateOf(l.issuedAt, cutoff) !== date) continue;
      const row = rows.find((r) => r.key === (l.productKey ?? l.kind));
      if (!row) continue;
      row.issued += l.issued;
      if (l.returnable) {
        row.out += outQty(l);
        row.returned += l.returned + l.collected;
        row.lost += lostNow(l);
      }
    }
  }
  const sum = (pick: (r: TicketStatusRow) => number) => rows.reduce((n, r) => n + pick(r), 0);
  return [
    ...rows,
    { key: 'total', label: TICKET_WORDS.total, issued: sum((r) => r.issued), out: sum((r) => r.out), returned: sum((r) => r.returned), lost: sum((r) => r.lost), unit: rows[0]?.unit ?? '매', total: true },
  ];
}

/** 차량의 예비권 재고 글(`야간권 6매 · 오전권 2매`). 없으면 빈 글. */
function spareText(state: ShopState, vehicleId: string): string {
  const reg = state.registry;
  const counted = spareProducts(reg).flatMap((p) => {
    const n = Math.max(0, spareRow(state, vehicleId, p.key)?.quantity ?? 0);
    return n > 0 ? [shortOf(p, p.key) + ' ' + n + (p.unit ?? '매')] : [];
  });
  // 번호로 세는 권(견본 매장): 차량에 있는 번호(assets.vehicleId).
  const numbered = ticketProducts(reg).filter((p) => p.tracking !== 'count').flatMap((p) => {
    const n = state.assets.filter((a) => a.vehicleId === vehicleId && a.kind === p.key).length;
    return n > 0 ? [shortOf(p, p.key) + ' ' + n + (p.unit ?? '매')] : [];
  });
  return [...counted, ...numbered].join(' · ');
}

/** 현황 탭의 차량 칸(쓰는 차량마다). */
function vehicleBlocks(state: ShopState): TicketVehicleBlock[] {
  const countable = spareProducts(state.registry).length > 0;
  return activeVehicles(state.registry).map((v) => {
    const text = spareText(state, v.id);
    const unloadable = countable && spareProducts(state.registry).some((p) => (spareRow(state, v.id, p.key)?.quantity ?? 0) > 0);
    return {
      vehicleId: v.id,
      label: v.label,
      stock: TICKET_WORDS.spareStock + ' ' + (text || TICKET_WORDS.none),
      load: { label: TICKET_WORDS.load, enabled: countable, ...(countable ? {} : { reason: TICKET_WORDS.loadNumbered }) },
      unload: { label: TICKET_WORDS.unload, enabled: unloadable, ...(unloadable ? {} : { reason: countable ? TICKET_WORDS.noUnload : TICKET_WORDS.loadNumbered }) },
    };
  });
}

const head = (ctx: ViewContext) => ({ basis: { epoch: ctx.state.epoch, rev: ctx.state.rev }, serverTime: iso(ctx.now), currentBusinessDate: ctx.state.businessDate });

/**
 * 리프트권 화면(ticketBoard): 제목 `12월 26일 (토) 리프트권`, 탭 `현황` · `미반납 {n}` · `분실 {n}`. 현황만 그 영업일의 셈이고 미반납 · 분실은 날을
 * 가리지 않는다(§8-2).
 */
export function ticketBoard(ctx: ViewContext, params: TicketBoardParams): TicketBoardView {
  const state = ctx.state;
  const date = params.date ?? state.businessDate;
  const tab: TicketTabKey = params.tab ?? 'status';
  const unreturned = unreturnedRows(ctx);
  const lost = lostRows(ctx);
  const rows = tab === 'unreturned' ? unreturned : tab === 'lost' ? lost : [];
  return {
    ...head(ctx),
    date,
    title: dateTitle(date) + ' ' + TICKET_WORDS.screen,
    tab,
    tabs: [
      { key: 'status', label: TICKET_WORDS.status },
      { key: 'unreturned', label: TICKET_WORDS.unreturned, count: unreturned.length },
      { key: 'lost', label: TICKET_WORDS.lost, count: lost.length },
    ],
    columns: [
      { key: 'label', label: TICKET_WORDS.kind },
      { key: 'issued', label: TICKET_WORDS.issued },
      { key: 'out', label: TICKET_WORDS.unreturned },
      { key: 'returned', label: TICKET_WORDS.returned },
      { key: 'lost', label: TICKET_WORDS.lost },
    ],
    status: tab === 'status' ? statusRows(state, date) : [],
    vehicles: tab === 'status' ? vehicleBlocks(state) : [],
    rows,
    ...(tab !== 'status' && rows.length === 0 ? { empty: tab === 'lost' ? TICKET_WORDS.noLost : TICKET_WORDS.noUnreturned } : {}),
  };
}

// ── 분실 처리 · 분실 회수 창(ticketLossSheet) ───────────────────────────────

/** 분실 처리 뒤 받을 것이 없어지는 차량 수거(`22:10 만선 티롤 앞 수거 취소`). */
function cancelledCollects(state: ShopState, o: FxOrder, picked: readonly { l: FxLine; qty: number }[]): string[] {
  const after: FxOrder = structuredClone(o);
  for (const { l, qty } of picked) {
    const line = after.lines.find((x) => x.id === l.id);
    if (line) line.lost = (line.lost ?? 0) + qty;
  }
  const before = orderTasks(o).filter((t) => !collectDone(taskOrder(t)));
  const now = new Map(orderTasks(after).map((t) => [t.id, t] as const));
  return before.flatMap((t) => {
    const next = now.get(t.id);
    if (next && !collectDone(taskOrder(next))) return [];
    return [bizHm(t.promise.at, shopCutoff(state.settings)) + ' ' + placeLabel(state.registry, t.promise.placeId) + ' ' + TICKET_WORDS.cancelCollect];
  });
}

/**
 * 분실 처리 · 분실 회수 창: 권 줄마다 −/+(처음 값은 분실 처리 0 · 분실 회수 모두), 줄 `청구 없음`과 수거가 없어지면 `22:10 만선 티롤 앞 수거 취소`,
 * 주 버튼 `분실 처리 · 야간권 1매`(수거가 없어지면 `… · 수거 취소`) · `분실 회수 · 야간권 1매`.
 */
export function ticketLossSheet(ctx: ViewContext, params: TicketLossSheetParams): TicketLossSheetView {
  const state = ctx.state;
  const o = findOrder(state, params.orderId);
  if (!o) throw new DomainError('NOT_FOUND', '없는 접수: ' + params.orderId);
  const loss = params.direction === 'loss';
  const word = loss ? TICKET_WORDS.loss : TICKET_WORDS.found;
  const title = word + ' · ' + o.teamName + ' 팀';
  const lines = o.lines.filter((l) => (loss ? lossEligible(state, o, l) && outQty(l) > 0 : isTicketLine(l) && lostNow(l) > 0));
  const maxOf = (l: FxLine) => (loss ? outQty(l) : lostNow(l));
  const picked = lines.map((l) => {
    const want = params.picked?.find((x) => x.lineId === l.id)?.quantity;
    // 분실 처리는 처음 0매(품목 취소처럼 사람이 고른다: 한 번 더 누르면 모두 지워지고 수거가 취소되는 창이 되지 않게, 2026-09-27 점검). 회수는 모두.
    return { l, qty: Math.max(0, Math.min(maxOf(l), want === undefined ? (loss ? 0 : maxOf(l)) : Math.floor(want))) };
  });
  const pieces: ReturnPieceLine[] = picked.map(({ l, qty }) => {
    const back = lineBuckets(o, l).find((b) => bucketOut(b) > 0)?.promise;
    return {
      lineId: l.id, label: l.label, mode: 'count', muted: qty === 0, wide: false,
      note: loss ? (back ? backText(state, back) : '') : lostDay(state, l.lostAt),
      quantity: { value: qty, min: 0, max: maxOf(l), unit: unitOf(l) },
    };
  });
  const chosen = picked.filter((x) => x.qty > 0);
  const text = ticketText(state.registry, chosen);
  const cancels = loss ? cancelledCollects(state, o, chosen) : [];
  const notes: RichText[] = loss ? [[{ text: TICKET_WORDS.noCharge, strong: true }], ...cancels.map((t): RichText => [{ text: t, strong: true }])] : [];
  // 차량 수거가 없어지면 주 버튼에도 말한다(`분실 처리 · 야간권 1매 · 수거 취소`): 기사가 가지 않게 되는 일이다.
  const base = text ? word + ' · ' + text : word;
  const label = cancels.length ? base + ' · ' + TICKET_WORDS.cancelCollect : base;
  return {
    ...head(ctx),
    title,
    direction: params.direction,
    lines: pieces,
    picked: picked.map(({ l, qty }) => ({ lineId: l.id, quantity: qty })),
    notes,
    ...(lines.length === 0 ? { notice: TICKET_WORDS.noLoss } : {}),
    primary: { label, alts: [...new Set([label, ...(cancels.length ? [word + ' · ' + TICKET_WORDS.cancelCollect] : []), word])], enabled: chosen.length > 0 },
    ...(chosen.length ? {
      command: loss
        ? { type: 'stock.write_off' as const, payload: { orderId: o.id, lines: chosen.map(({ l, qty }) => ({ lineId: l.id, quantity: qty })), reasonKey: 'lost' as const } }
        : { type: 'asset.found' as const, payload: { orderId: o.id, lines: chosen.map(({ l, qty }) => ({ lineId: l.id, quantity: qty })) } },
    } : {}),
  };
}

// ── 예비권 적재 · 입고 창(spareSheet) ────────────────────────────────────

/**
 * 예비권 적재 · 입고 창: 권종마다 −/+(처음 값 0, 입고는 차에 있는 수까지), 요약 `1호 차량 예비권 재고 6매 → 12매`, 주 버튼 `예비권 적재 · 야간권 6매`.
 */
export function spareSheet(ctx: ViewContext, params: SpareSheetParams): SpareSheetView {
  const state = ctx.state;
  const reg = state.registry;
  const vehicle = reg.vehicles.find((v) => v.id === params.vehicleId);
  if (!vehicle) throw new DomainError('NOT_FOUND', '없는 차량: ' + params.vehicleId);
  const load = params.direction === 'load';
  const word = load ? TICKET_WORDS.load : TICKET_WORDS.unload;
  const have = (key: string) => Math.max(0, spareRow(state, vehicle.id, key)?.quantity ?? 0);
  const products = spareProducts(reg).filter((p) => load || have(p.key) > 0);
  const limit = (key: string) => (load ? reg.maxLineQuantity : have(key));
  const picked = products.map((p) => {
    const want = params.picked?.find((x) => x.productKey === p.key)?.quantity ?? 0;
    return { p, qty: Math.max(0, Math.min(limit(p.key), Math.floor(want))) };
  });
  const lines: ReturnPieceLine[] = picked.map(({ p, qty }) => ({
    lineId: p.key, label: p.label, mode: 'count', muted: qty === 0, wide: false,
    note: TICKET_WORDS.vanStock + ' ' + have(p.key) + (p.unit ?? '매'),
    quantity: { value: qty, min: 0, max: limit(p.key), unit: p.unit ?? '매' },
  }));
  const chosen = picked.filter((x) => x.qty > 0);
  const unit = products[0]?.unit ?? '매';
  const before = spareProducts(reg).reduce((n, p) => n + have(p.key), 0);
  const moved = chosen.reduce((n, x) => n + x.qty, 0);
  const after = load ? before + moved : before - moved;
  const text = chosen.map(({ p, qty }) => shortOf(p, p.key) + ' ' + qty + (p.unit ?? '매')).join(' · ');
  const label = text ? word + ' · ' + text : word;
  const spares = chosen.map(({ p, qty }) => ({ productKey: p.key, quantity: qty }));
  const notice = products.length === 0 ? (load ? TICKET_WORDS.loadNumbered : TICKET_WORDS.noUnload) : undefined;
  return {
    ...head(ctx),
    title: word + ' · ' + vehicle.label,
    direction: params.direction,
    lines,
    picked: picked.map(({ p, qty }) => ({ productKey: p.key, quantity: qty })),
    summary: [{ text: vehicle.label + ' ' + TICKET_WORDS.spareStock + ' ' + before + unit, strong: true }, { text: ' → ' + after + unit }],
    ...(notice ? { notice } : {}),
    primary: { label, alts: [label, word], enabled: chosen.length > 0 },
    ...(chosen.length ? {
      command: load
        ? { type: 'stock.load' as const, payload: { vehicleId: vehicle.id, spares } }
        : { type: 'stock.receive' as const, payload: { vehicleId: vehicle.id, taskIds: [], spares } },
    } : {}),
  };
}

// ── 접수증 출처 줄 ────────────────────────────────────────────────────

/**
 * 분실 처리 · 분실 회수의 출처 줄(옅은 먹 · 금액 없음, 청구 없음): `분실 처리 · 야간권 1매 · 23:40`, `분실 회수 · 야간권 1매 · 00:10`. 줄마다 지금 분실 ·
 * 찾은 수와 마지막 시각(order-edit.ts editAdjustments가 시각 순으로 섞는다).
 */
export function lossAdjustments(reg: ShopRegistry, o: FxOrder): { at: number; rows: SlipAdjustment[] }[] {
  const out: { at: number; rows: SlipAdjustment[] }[] = [];
  for (const l of o.lines) {
    if (!isTicketLine(l)) continue;
    const lost = l.lost ?? 0;
    if (lost > 0 && l.lostAt !== undefined) out.push({ at: l.lostAt, rows: [{ key: 'lost:' + l.id, tone: 'muted', parts: lossParts(TICKET_WORDS.loss, ticketText(reg, [{ l, qty: lost }]), l.lostAt) }] });
    const found = l.found ?? 0;
    if (found > 0 && l.foundAt !== undefined) out.push({ at: l.foundAt, rows: [{ key: 'found:' + l.id, tone: 'muted', parts: lossParts(TICKET_WORDS.found, ticketText(reg, [{ l, qty: found }]), l.foundAt) }] });
  }
  return out;
}

const lossParts = (word: string, items: string, at: number): FitPart[] => [{ text: word, drop: 0 }, { text: items, drop: 1 }, { text: hm(at), drop: 2 }];

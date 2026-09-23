// 체험 자료: 시안(docs/design/redesign-mockups.html)과 같은 하루 — 12월 26일 (토) 오후 3시 40분, 18팀.
// 이름은 시안의 이름을 쓰고, 전화번호는 모두 가짜(010-0000-xxxx)다. 실제 손님 자료는 없다.
// 들어 있는 경우: 전화 예약 · 리프트권 선입금(박준호), 차량 배달(최하은), 매장 수령(박준호 · 이정호), 조기 반납(오승민),
// 다른 팀이 결제(이서연 → 이정호), 늦은 미수(김영희), 숙소 수거(솔마을 한솔동 · 꽃마을 들국화), 반납 끝(최은정).
import type { ConditionKey } from '@skinote/contract';
import type { FxArea, FxLine, FxOrder, FxPayment, FxPin, FxPromise, FxSection, FxState, FxVehicle } from './model.ts';
import { kstAt } from './time.ts';

export const DEMO_DATE = '2026-12-26';
/** 체험 시계가 처음 가리키는 시각(15:40). */
export const DEMO_START_MS = kstAt(DEMO_DATE, 0, 15, 40);
export const SHOP_NAME = '우리 스키샵';

export const AREAS: readonly FxArea[] = [
  { id: 'seolcheon', label: '설천', lodging: false, places: [{ id: 'seolcheon_parking', label: '설천 주차장' }, { id: 'seolcheon_house', label: '설천 하우스 앞' }] },
  { id: 'manseon', label: '만선', lodging: false, places: [{ id: 'manseon_plaza', label: '만선 광장' }, { id: 'manseon_tirol', label: '만선 티롤 앞' }] },
  {
    id: 'solmaeul', label: '솔마을', lodging: true,
    places: [{ id: 'hansol', label: '한솔동' }, { id: 'dusol', label: '두솔동' }, { id: 'sesol', label: '세솔동' }, { id: 'nesol', label: '네솔동' }],
  },
  {
    id: 'kkotmaeul', label: '꽃마을', lodging: true,
    places: [
      { id: 'deulgukhwa', label: '들국화' }, { id: 'baekhap', label: '백합' }, { id: 'mindeulle', label: '민들레' },
      { id: 'gaenari', label: '개나리' }, { id: 'haebaragi', label: '해바라기' }, { id: 'cosmos', label: '코스모스' },
    ],
  },
];

export const VEHICLES: readonly FxVehicle[] = [
  { id: 'v1', label: '1호 차량' },
  { id: 'v2', label: '2호 차량' },
];

interface CatalogItem {
  label: string;
  shortLabel?: string;
  unit?: string;
  price: number;
  section: FxSection;
  returnable: boolean;
  capabilities: ConditionKey[];
}

const CATALOG = {
  ski: { label: '스키', price: 40_000, section: 'gear', returnable: true, capabilities: ['exchangeable', 'extendable'] },
  board: { label: '보드', price: 25_000, section: 'gear', returnable: true, capabilities: ['exchangeable', 'extendable'] },
  helmet: { label: '헬멧', price: 5_000, section: 'gear', returnable: true, capabilities: ['exchangeable', 'extendable'] },
  clothes: { label: '의류', price: 20_000, section: 'gear', returnable: true, capabilities: ['exchangeable', 'extendable'] },
  night_adult: { label: '야간권 성인', shortLabel: '야간권', unit: '매', price: 35_000, section: 'lift', returnable: false, capabilities: [] },
} as const satisfies Record<string, CatalogItem>;

type Kind = keyof typeof CATALOG;

const at = (hour: number, minute: number, dayOffset = 0) => kstAt(DEMO_DATE, dayOffset, hour, minute);

/** 품목 줄. done: 지급(issued) · 반납(returned)까지 된 시각. */
function line(orderId: string, n: number, kind: Kind, qty: number, done: { issuedAt?: number; returnedAt?: number } = {}): FxLine {
  const item: CatalogItem = CATALOG[kind];
  return {
    id: orderId + '-l' + n,
    kind,
    label: item.label,
    shortLabel: item.shortLabel ?? item.label,
    qty,
    ...(item.unit ? { unit: item.unit } : {}),
    amount: item.price * qty,
    section: item.section,
    returnable: item.returnable,
    capabilities: [...item.capabilities],
    loaded: 0,
    issued: done.issuedAt !== undefined ? qty : 0,
    ...(done.issuedAt !== undefined ? { issuedAt: done.issuedAt } : {}),
    returned: done.returnedAt !== undefined && item.returnable ? qty : 0,
    ...(done.returnedAt !== undefined && item.returnable ? { returnedAt: done.returnedAt } : {}),
    collected: 0,
    received: 0,
  };
}

const store = (atMs: number): FxPromise => ({ at: atMs, mode: 'store' });
const van = (atMs: number, placeId: string, note?: string): FxPromise => ({ at: atMs, mode: 'vehicle', placeId, vehicleId: 'v1', ...(note ? { note } : {}) });
const paid = (orderId: string, amount: number, methodKey: FxPayment['methodKey'], atMs: number, section?: FxSection): FxPayment => ({
  id: orderId + '-p1', amount, methodKey, at: atMs, ...(section ? { section } : {}),
});

interface OrderInput {
  id: string;
  no: number;
  teamName: string;
  last4: string;
  channel: FxOrder['channel'];
  party: number;
  createdAt: number;
  pickup: FxPromise;
  giveBack: FxPromise;
  lines: (orderId: string) => FxLine[];
  payments?: (orderId: string, charged: number) => FxPayment[];
  payerOrderId?: string;
  payWhen?: FxOrder['payWhen'];
}

function order(input: OrderInput): FxOrder {
  const lines = input.lines(input.id);
  const charged = lines.reduce((sum, l) => sum + l.amount, 0);
  return {
    id: input.id,
    receiptNo: '261226-' + String(input.no).padStart(3, '0'),
    teamName: input.teamName,
    last4: input.last4,
    phone: '010-0000-' + input.last4,
    channel: input.channel,
    party: input.party,
    createdAt: input.createdAt,
    pickup: input.pickup,
    giveBack: input.giveBack,
    lines,
    payments: input.payments ? input.payments(input.id, charged) : [],
    ...(input.payerOrderId ? { payerOrderId: input.payerOrderId } : {}),
    payWhen: input.payWhen ?? 'pickup',
  };
}

/** 이미 지급까지 끝난 현장 대여(접수 = 수령). */
function walkIn(input: Omit<OrderInput, 'channel' | 'pickup' | 'lines'> & { kinds: [Kind, number][]; issuedAt: number; returnedAt?: number }): FxOrder {
  const { kinds, issuedAt, returnedAt, ...rest } = input;
  return order({
    ...rest,
    channel: 'walk_in',
    pickup: store(input.createdAt),
    lines: (id) => kinds.map(([kind, qty], i) => line(id, i + 1, kind, qty, { issuedAt, ...(returnedAt !== undefined ? { returnedAt } : {}) })),
  });
}

function orders(): FxOrder[] {
  return [
    walkIn({
      id: 'o21', no: 3, teamName: '김민재', last4: '0021', party: 2, createdAt: at(9, 0), issuedAt: at(9, 5),
      giveBack: van(at(16, 30), 'manseon_plaza'), kinds: [['ski', 2], ['clothes', 1]],
      payments: (id, charged) => [paid(id, charged, 'card', at(9, 5))],
    }),
    order({
      id: 'o22', no: 17, teamName: '박준호', last4: '0022', channel: 'phone', party: 3, createdAt: at(10, 12, -2),
      pickup: store(at(16, 0)), giveBack: van(at(22, 0), 'seolcheon_parking'),
      lines: (id) => [line(id, 1, 'ski', 2), line(id, 2, 'board', 1), line(id, 3, 'helmet', 3), line(id, 4, 'night_adult', 3)],
      // 리프트권은 리조트에서 미리 끊어 두므로 값을 먼저 받는다(선입금). 장비 값은 받을 때.
      payments: (id) => [paid(id, 105_000, 'transfer', at(10, 20, -2), 'lift')],
    }),
    walkIn({
      id: 'o23', no: 6, teamName: '이수진', last4: '0023', party: 2, createdAt: at(10, 5), issuedAt: at(10, 12),
      giveBack: van(at(16, 30), 'manseon_plaza'), kinds: [['board', 2], ['clothes', 2]],
      payments: (id, charged) => [paid(id, charged, 'card', at(10, 12))],
    }),
    walkIn({
      id: 'o24', no: 1, teamName: '최은정', last4: '0024', party: 1, createdAt: at(8, 40), issuedAt: at(8, 45), returnedAt: at(11, 52),
      giveBack: store(at(12, 0)), kinds: [['ski', 1], ['clothes', 1]],
      payments: (id, charged) => [paid(id, charged, 'cash', at(8, 45))],
    }),
    walkIn({
      id: 'o25', no: 4, teamName: '김민수', last4: '0025', party: 4, createdAt: at(9, 10), issuedAt: at(9, 18),
      giveBack: van(at(22, 0), 'seolcheon_parking'), kinds: [['ski', 4], ['helmet', 2]],
      payments: (id, charged) => [paid(id, charged, 'card', at(9, 18))],
    }),
    order({
      id: 'o26', no: 12, teamName: '최하은', last4: '0026', channel: 'phone', party: 3, createdAt: at(19, 30, -1),
      // 차량 배달: 17:00 만선 광장에 갖다 주고, 밤에는 다른 곳(만선 티롤 앞)에서 받는다.
      pickup: van(at(17, 0), 'manseon_plaza'), giveBack: van(at(22, 10), 'manseon_tirol'),
      lines: (id) => [line(id, 1, 'ski', 3), line(id, 2, 'helmet', 3)],
      payments: (id, charged) => [paid(id, charged, 'transfer', at(19, 40, -1))],
    }),
    walkIn({
      id: 'o27', no: 5, teamName: '김영희', last4: '0027', party: 3, createdAt: at(9, 20), issuedAt: at(9, 26),
      // 오전타임(12:00) 반납이 늦었고, 나머지 돈은 반납 때 받기로 했다: 늦은 미수.
      giveBack: store(at(12, 0)), kinds: [['ski', 2], ['clothes', 2], ['helmet', 1]], payWhen: 'return',
      payments: (id) => [paid(id, 60_000, 'cash', at(9, 26))],
    }),
    walkIn({
      id: 'o28', no: 15, teamName: '윤서준', last4: '0028', party: 2, createdAt: at(13, 30), issuedAt: at(13, 36),
      giveBack: van(at(9, 0, 1), 'hansol'), kinds: [['ski', 2], ['clothes', 2]], payWhen: 'return',
    }),
    walkIn({
      id: 'o29', no: 9, teamName: '이도윤', last4: '0029', party: 2, createdAt: at(11, 10), issuedAt: at(11, 15),
      giveBack: van(at(22, 0), 'seolcheon_parking'), kinds: [['board', 2]],
      payments: (id, charged) => [paid(id, charged, 'card', at(11, 15))],
    }),
    walkIn({
      id: 'o31', no: 11, teamName: '서지훈', last4: '0031', party: 3, createdAt: at(12, 20), issuedAt: at(12, 26),
      giveBack: van(at(22, 0), 'seolcheon_parking'), kinds: [['ski', 3]],
      payments: (id, charged) => [paid(id, charged, 'card', at(12, 26))],
    }),
    order({
      id: 'o32', no: 13, teamName: '이정호', last4: '0032', channel: 'phone', party: 2, createdAt: at(20, 5, -1),
      // 가족 두 팀: 이서연 팀 몫까지 이정호 팀이 내일 반납할 때 한 번에 낸다.
      pickup: store(at(16, 20)), giveBack: store(at(12, 0, 1)), payWhen: 'return',
      lines: (id) => [line(id, 1, 'ski', 2), line(id, 2, 'helmet', 2)],
    }),
    walkIn({
      id: 'o33', no: 14, teamName: '조은비', last4: '0033', party: 2, createdAt: at(13, 5), issuedAt: at(13, 10),
      giveBack: van(at(22, 0), 'seolcheon_parking'), kinds: [['board', 1], ['helmet', 1]],
      payments: (id, charged) => [paid(id, charged, 'card', at(13, 10))],
    }),
    walkIn({
      id: 'o34', no: 7, teamName: '한동수', last4: '0034', party: 2, createdAt: at(10, 30), issuedAt: at(10, 34),
      giveBack: van(at(22, 0), 'seolcheon_parking'), kinds: [['ski', 2]],
      payments: (id, charged) => [paid(id, charged, 'cash', at(10, 34))],
    }),
    walkIn({
      id: 'o35', no: 8, teamName: '백승현', last4: '0035', party: 4, createdAt: at(9, 40), issuedAt: at(9, 48),
      giveBack: van(at(22, 0), 'seolcheon_parking'), kinds: [['ski', 4], ['helmet', 4]],
      payments: (id, charged) => [paid(id, charged, 'card', at(9, 48))],
    }),
    walkIn({
      id: 'o36', no: 10, teamName: '이서연', last4: '0036', party: 2, createdAt: at(11, 0), issuedAt: at(11, 6),
      giveBack: store(at(16, 30)), kinds: [['ski', 1], ['clothes', 1]], payerOrderId: 'o32', payWhen: 'return',
    }),
    walkIn({
      id: 'o37', no: 16, teamName: '임하늘', last4: '0037', party: 1, createdAt: at(14, 10), issuedAt: at(14, 15),
      giveBack: van(at(22, 0), 'seolcheon_parking'), kinds: [['ski', 1], ['clothes', 1]],
      payments: (id, charged) => [paid(id, charged, 'card', at(14, 15))],
    }),
    order({
      id: 'o39', no: 2, teamName: '오승민', last4: '0039', channel: 'phone', party: 2, createdAt: at(18, 0, -2),
      // 숙소(꽃마을 들국화)에서 받기로 했는데 일찍 끝내겠다고 해서 21:50으로 당겼다(조기 반납).
      pickup: store(at(9, 50)), giveBack: van(at(21, 50), 'deulgukhwa', '조기 반납'),
      lines: (id) => [line(id, 1, 'ski', 2, { issuedAt: at(9, 55) }), line(id, 2, 'helmet', 2, { issuedAt: at(9, 55) })],
      payments: (id, charged) => [paid(id, charged, 'transfer', at(18, 10, -2))],
    }),
    walkIn({
      id: 'o41', no: 18, teamName: '정하늘', last4: '0041', party: 2, createdAt: at(13, 50), issuedAt: at(13, 56),
      giveBack: van(at(22, 10), 'manseon_tirol'), kinds: [['ski', 2], ['clothes', 2]],
      payments: (id, charged) => [paid(id, charged, 'card', at(13, 56))],
    }),
  ];
}

function pins(): FxPin[] {
  return [{ id: 'pin1', orderId: 'o39', at: at(21, 50), note: '조기 반납', status: 'requested' }];
}

/** 처음 자료. epoch는 되돌릴 때마다 새로 받는다. */
export function createSeed(epoch: string): FxState {
  return {
    version: 2,
    epoch,
    rev: 1,
    businessDate: DEMO_DATE,
    orders: orders(),
    pins: pins(),
    routeRanks: {},
    outcomes: {},
    driverDevice: { offline: false, queue: [] },
  };
}

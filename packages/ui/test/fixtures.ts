// 시험용 읽기 모델: 시안(docs/design/redesign-mockups.html)의 C1 · C2 · C3 화면과 같은 자료. 이름 · 번호는 지어낸 것이다.
import type { LedgerRow, LedgerViewResult, OrderSlip, StampCell } from '@skinote/contract';

/** 2026-12-26(토) KST 시각 → UTC ISO. */
export const kst = (h: number, m: number) => new Date(Date.UTC(2026, 11, 26, h - 9, m)).toISOString();
export const NOW_MS = Date.parse(kst(15, 40));
const HEAD = { basis: { epoch: 'E1', rev: 48213 }, serverTime: kst(15, 40), currentBusinessDate: '2026-12-26' };

const stamp = (stepKey: string, state: StampCell['state'], extra: Partial<StampCell> = {}): StampCell => ({ stepKey, state, ...extra });

function orderRow(id: string, h: number, m: number, name: string, last4: string, items: [string, number][], promise: string[], money: { alts: string[]; lateAt?: string }, stamps: [StampCell, StampCell, StampCell], due: { kind?: string; lateAt?: string; finished?: boolean } = {}): LedgerRow {
  return {
    id,
    orderId: id,
    rank: id,
    ...(due.finished ? {} : { dueAt: kst(h, m) }),
    ...(due.lateAt ? { lateAt: due.lateAt } : {}),
    finished: due.finished ?? false,
    cells: {
      time: { renderer: 'time', at: kst(h, m), parts: [{ text: due.kind ?? '반납', drop: 1 }, { text: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'), drop: 0 }] },
      team: { renderer: 'team', name, last4 },
      items: { renderer: 'items', items: items.map(([label, qty]) => ({ label, qty })) },
      promise: { renderer: 'promise', parts: promise.map((text, i) => ({ text, drop: i })) },
      money: {
        renderer: 'money', alts: money.alts, tone: 'ink',
        // 미수는 좁으면 두 줄(작은 윗줄 '미수' · 아랫줄 금액).
        ...(money.alts.length > 1 && money.alts[0]!.startsWith('미수 ') ? { stacked: { over: '미수', main: money.alts[1]! } } : {}),
        ...(money.lateAt ? { lateAt: money.lateAt } : {}),
      },
      'stamp:issue': { renderer: 'stamp', stamp: stamps[0] },
      'stamp:return': { renderer: 'stamp', stamp: stamps[1] },
      'stamp:pay': { renderer: 'stamp', stamp: stamps[2] },
    },
  };
}

export const dayLedger: LedgerViewResult = {
  ...HEAD,
  viewKey: 'day_ledger',
  deviceClass: 'pos',
  titleValues: { date: '2026-12-26' },
  activeTabKey: 'all',
  tabCounts: { all: 18, unpaid: 3, vehicle: 12 },
  groups: [],
  rows: [
    orderRow('o24', 12, 0, '최은정', '0024', [['스키', 1], ['의류', 1]], ['12:00', '매장'], { alts: ['완료'] }, [stamp('issue', 'done'), stamp('return', 'todo'), stamp('pay', 'done')], { lateAt: kst(12, 30) }),
    orderRow('o22', 16, 0, '박준호', '0022', [['스키', 2], ['보드', 1], ['헬멧', 3]], ['22:00', '설천 주차장', '차량'], { alts: ['미수 120,000원', '120,000원'] }, [stamp('load', 'todo'), stamp('return', 'delegated', { at: kst(22, 0) }), stamp('pay', 'partial', { progress: { done: 1, total: 2 } })], { kind: '수령' }),
    orderRow('o21', 16, 30, '김민재', '0021', [['스키', 2], ['의류', 1]], ['16:30', '만선 광장', '차량'], { alts: ['완료'] }, [stamp('issue', 'done'), stamp('return', 'delegated', { at: kst(16, 30) }), stamp('pay', 'done')]),
    orderRow('o27', 16, 30, '김영희', '0027', [['스키', 2], ['의류', 2], ['헬멧', 1]], ['16:30', '매장'], { alts: ['미수 65,000원', '65,000원'], lateAt: kst(15, 0) }, [stamp('issue', 'done'), stamp('return', 'todo'), stamp('pay', 'todo')]),
    orderRow('o25', 22, 0, '김민수', '0025', [['스키', 4], ['헬멧', 2]], ['22:00', '설천 주차장', '차량'], { alts: ['완료'] }, [stamp('issue', 'done'), stamp('return', 'delegated', { at: kst(22, 0) }), stamp('pay', 'done')]),
    orderRow('o23', 22, 0, '이수진', '0023', [['보드', 2], ['의류', 2]], ['22:00', '만선 광장', '차량'], { alts: ['완료'] }, [stamp('issue', 'done'), stamp('return', 'scheduled'), stamp('pay', 'done', { pending: true })]),
    orderRow('o28', 23, 0, '윤서준', '0028', [['스키', 2], ['의류', 2]], ['내일 09:00', '솔마을 한솔동'], { alts: ['미수 120,000원', '120,000원'] }, [stamp('issue', 'blocked', { blockedBy: { stepKey: 'ticket_secure', message: '발권을 먼저 해야 지급할 수 있습니다' } }), stamp('return', 'na'), stamp('pay', 'todo')]),
    orderRow('o29', 23, 30, '한국대학교 스키동아리', '0029', [['스키', 12], ['보드', 3], ['의류', 15], ['헬멧', 15]], ['23:30', '매장'], { alts: ['완료'] }, [stamp('issue', 'done'), stamp('return', 'todo'), stamp('pay', 'done')]),
    ...Array.from({ length: 8 }, (_, i) => orderRow('x' + i, 23, 40 + i, '손님' + (i + 1), String(30 + i).padStart(4, '0'), [['스키', 1]], ['23:59', '매장'], { alts: ['완료'] }, [stamp('issue', 'done'), stamp('return', 'todo'), stamp('pay', 'done')])),
    orderRow('f1', 9, 0, '박지훈', '0020', [['스키', 1]], ['12:00', '매장'], { alts: ['완료'] }, [stamp('issue', 'done'), stamp('return', 'done'), stamp('pay', 'done')], { finished: true }),
  ],
  metrics: [
    { metricKey: 'team_count', unit: 'team', value: 18 },
    { metricKey: 'issued_count', unit: 'count', value: 14 },
    { metricKey: 'returned_count', unit: 'count', value: 9 },
    { metricKey: 'due_total', unit: 'won', value: 485_000 },
  ],
  activeConditions: [],
};

function taskRow(id: string, group: string, name: string, last4: string, items: [string, number][], collected: string | null, pending = false): LedgerRow {
  return {
    id,
    taskId: id,
    groupKey: group,
    subgroupLabel: '설천 주차장',
    rank: id,
    finished: false,
    cells: {
      'stamp:collect': { renderer: 'stamp', stamp: collected ? stamp('collect', 'done', { at: collected, pending }) : stamp('collect', 'todo') },
      team: { renderer: 'team', name, last4 },
      items: { renderer: 'items', items: items.map(([label, qty]) => ({ label, qty })) },
      'action:call': { renderer: 'action', actionKey: 'call', enabled: true, phone: '010-0000-' + last4 },
    },
  };
}

export const collectionList: LedgerViewResult = {
  ...HEAD,
  serverTime: kst(21, 40),
  viewKey: 'collection_list',
  deviceClass: 'driver_tablet',
  titleValues: { vehicle: '1호 차량' },
  activeTabKey: 'all',
  tabCounts: { all: 10, remaining: 7, collected: 3 },
  groups: [
    { key: 's2200', label: '22:00 반납', at: kst(22, 0), done: 2, total: 4 },
    { key: 's2210', label: '22:10 반납', at: kst(22, 10), done: 0, total: 2 },
  ],
  rows: [
    taskRow('t25', 's2200', '김민수', '0025', [['스키', 4], ['헬멧', 2]], kst(21, 42)),
    taskRow('t22', 's2200', '박준호', '0022', [['스키', 2], ['보드', 1], ['헬멧', 3]], null),
    taskRow('t31', 's2200', '서지훈', '0031', [['스키', 3]], null),
    taskRow('t29', 's2200', '이도윤', '0029', [['보드', 2]], kst(21, 45), true),
    taskRow('t41', 's2210', '정하늘', '0041', [['스키', 2], ['의류', 2]], null),
    taskRow('t42', 's2210', '문가은', '0042', [['보드', 1]], null),
  ],
  metrics: [
    { metricKey: 'collected_count', unit: 'count', value: 4 },
    { metricKey: 'pending_count', unit: 'count', value: 1 },
    { metricKey: 'remaining_count', unit: 'count', value: 7 },
    { metricKey: 'vehicle_load', unit: 'items', items: [{ label: '스키', qty: 14 }, { label: '보드', qty: 3 }, { label: '의류', qty: 2 }, { label: '헬멧', qty: 6 }] },
  ],
  activeConditions: [],
  primaryFigure: { count: 14 },
  pins: [
    { pinId: 'p1', taskId: 't39', at: kst(21, 50), parts: [{ text: '꽃마을 들국화', short: '들국화', drop: 1 }, { text: '오승민 · 0039', drop: 0 }, { text: '조기 반납', drop: 3 }], phone: '010-0000-0039', status: 'delivered' },
  ],
  vehicle: { id: 'v1', label: '1호 차량' },
};

/** 접수증 품목 줄의 칸: 서버가 설정의 칸마다 채운다(품목 이름 · 수량 · 금액 · 도장). */
function slipCells(label: string, qtyText: string, amount: number, stamps: [StampCell, StampCell, StampCell]): OrderSlip['lines'][number]['cells'] {
  return {
    items: { renderer: 'text', parts: [{ text: label, drop: 0, words: true }] },
    qty: { renderer: 'text', parts: [{ text: qtyText, drop: 0 }] },
    amount: { renderer: 'money', alts: [amount.toLocaleString('ko-KR') + '원'], tone: 'ink' },
    'stamp:load': { renderer: 'stamp', stamp: stamps[0] },
    'stamp:issue': { renderer: 'stamp', stamp: stamps[1] },
    'stamp:return': { renderer: 'stamp', stamp: stamps[2] },
  };
}

export const orderSlip: OrderSlip = {
  ...HEAD,
  orderId: 'o22',
  receiptNo: '261226-017',
  businessDate: '2026-12-26',
  teamName: '박준호',
  last4: '0022',
  fields: [
    { key: 'date', label: '날짜', value: '12월 26일 (토)', drop: 2 },
    { key: 'channel', label: '구분', value: '전화 예약', drop: 3 },
    { key: 'name', label: '대표자', value: '박준호', drop: 0 },
    { key: 'phone', label: '연락처', value: '010-0000-0022', drop: 0 },
    { key: 'party', label: '인원', value: '3명', drop: 1 },
  ],
  lines: [
    { id: 'l1', isBundle: false, label: '스키', qty: 2, qtyText: '2', amount: 80_000, capabilities: ['exchangeable'], cells: slipCells('스키', '2', 80_000, [stamp('load', 'na'), stamp('issue', 'todo'), stamp('return', 'todo')]) },
    { id: 'l2', isBundle: false, label: '보드', qty: 1, qtyText: '1', amount: 25_000, capabilities: [], cells: slipCells('보드', '1', 25_000, [stamp('load', 'na'), stamp('issue', 'todo'), stamp('return', 'todo')]) },
    { id: 'l3', isBundle: false, label: '헬멧', qty: 3, qtyText: '3', amount: 15_000, capabilities: [], cells: slipCells('헬멧', '3', 15_000, [stamp('load', 'na'), stamp('issue', 'todo'), stamp('return', 'todo')]) },
    { id: 'l4', isBundle: false, label: '야간권 성인', qty: 3, qtyText: '3매', amount: 105_000, capabilities: [], cells: slipCells('야간권 성인', '3매', 105_000, [stamp('load', 'na'), stamp('issue', 'todo'), stamp('return', 'na')]) },
    { id: 'l5', isBundle: true, label: '스키 세트', qty: 1, qtyText: '1', amount: 0, capabilities: [], cells: slipCells('스키 세트', '1', 0, [stamp('load', 'na'), stamp('issue', 'na'), stamp('return', 'na')]) },
  ],
  promises: {
    distinct: 1,
    lines: [
      { kind: 'pickup', at: kst(16, 0), parts: [{ text: '매장', drop: 1 }] },
      { kind: 'return', at: kst(22, 0), parts: [{ text: '설천 주차장', drop: 1 }, { text: '1호차', drop: 2 }] },
    ],
  },
  money: { charged: 225_000, paid: 105_000, due: 120_000, payments: [{ amount: 105_000, methodLabel: '계좌이체', date: '2026-12-24' }] },
  orderStamps: [stamp('pay', 'partial')],
  checklist: [
    { stepKey: 'order', parts: [{ text: '예약 · 리프트권 105,000원 받음', drop: 0 }], state: 'done', actionKey: 'next_step' },
    { stepKey: 'issue', parts: [{ text: '장비 지급', drop: 0 }], items: [{ label: '스키', qty: 2 }, { label: '보드', qty: 1 }, { label: '헬멧', qty: 3 }, { label: '야간권', qty: 3, unit: '매' }], state: 'now', actionKey: 'stamp.issue', figure: { count: 6, units: [{ unit: '매', qty: 3 }] } },
    { stepKey: 'pay', parts: [{ text: '수납', drop: 0 }, { text: '120,000원', drop: 1 }], state: 'later', actionKey: 'stamp.pay', figure: { amount: 120_000 } },
    { stepKey: 'return', parts: [{ text: '반납', drop: 0 }, { text: '오늘 22:00', drop: 1 }, { text: '설천 주차장', drop: 2 }, { text: '차량이 받음', drop: 3 }], state: 'later', actionKey: 'stamp.return' },
  ],
  nextStep: { stepKey: 'issue', actionKey: 'stamp.issue', figure: { count: 6 } },
  activeConditions: [],
};

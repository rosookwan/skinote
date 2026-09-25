// 읽기 모델(ui 7절): 서버(또는 오프라인 기기의 같은 코드)가 만들고, 화면은 그리기만 한다.
// 도장 상태, 다음 할 일, 늦음의 기준 시각(dueAt · lateAt), 맞춤 조각은 이미 들어 있다. 화면이 스스로 정하는 것은
// '지금'(서버 시각 차이로 고친 시각)과 lateAt의 비교, 쪽 나누기, 칸 폭뿐이다.
import type {
  ActionKey, ConditionKey, DeviceClassKey, LedgerMetricKey, StampStateKey, StatusDomainKey, ToneKey,
} from './vocab.ts';

/** UTC ISO 8601 시각('2026-12-26T06:40:00Z'). */
export type IsoTime = string;
/** 영업일('2026-12-26'). 서버가 매장 시간대와 기준 시각으로 정한다. */
export type BusinessDate = string;

/** 읽기 모델이 그려진 시점. 확인 창은 연 때의 이 값을 명령의 basis로 보낸다. */
export interface Basis {
  epoch: string;
  rev: number;
}

/** 모든 읽기 모델의 머리: 기준 시점, 서버 시각(시계 차이), 영업일. */
export interface ReadModelHead {
  basis: Basis;
  serverTime: IsoTime;
  currentBusinessDate: BusinessDate;
}

/**
 * 맞춤 조각(parts 모드). drop은 칸의 drop_priority와 같은 뜻이다: 0은 빠지지 않고, 큰 것부터 먼저 빠진다.
 * words가 true면 조각을 다 빼도 넘칠 때 그 조각 안에서 낱말을 뒤에서부터 뺀다(긴 단체 이름).
 */
export interface FitPart {
  text: string;
  drop: number;
  words?: boolean;
  /** 빠질 차례가 오면 먼저 이 짧은 글로 바뀌고, 그래도 넘치면 빠진다('꽃마을 들국화' → '들국화'). */
  short?: string;
}

/** 품목 요약 한 칸('스키 2'). 목록이 넘치면 뒤에서부터 '외 N종'으로 접는다. */
export interface ItemCount {
  label: string;
  qty: number;
  /** 수량 단위('매' 등). 없으면 숫자만. */
  unit?: string;
}

/** 도장 칸 하나(ui 3-2의 일곱 상태). */
export interface StampCell {
  /** 보이는 단계(first_open 사슬이면 사슬에서 아직 끝나지 않은 첫 단계). */
  stepKey: string;
  state: StampStateKey;
  /**
   * 이 도장을 이 자리에서 부르는 이름(도장 글자 · 읽는 이름). 없으면 단계 설정의 이름 · 도장 글자. 기사 기기의 차량 배달은 매장의 `지급`과
   * 같은 단계지만 `배달`이다(sys_movement_kinds deliver `지급·배달`, 문구 표 결정 4: 도장 `배달` / `16:57`, 읽는 이름 `배달 미처리`).
   */
  label?: string;
  /**
   * done: 도장을 찍은 시각. shows_time 단계는 한 줄('받음 21:42', 칸 5.5em), 그 밖의 단계는 도장 안 두 줄(지급 / 15:42, 칸 4em).
   * delegated: 약속 시각('차량 22:00').
   */
  at?: IsoTime;
  /** 보냄 대기(오프라인에서 확인한 도장): 점선으로 그린다. */
  pending?: boolean;
  /** 서버가 결과를 기다리는 중('처리 중'). */
  processing?: boolean;
  /** partial: 끝난 수 / 전체 수. */
  progress?: { done: number; total: number };
  /** blocked: 먼저 해야 하는 단계와 한 문장('발권을 먼저 해야 지급할 수 있습니다'). */
  blockedBy?: { stepKey: string; message: string };
  /** delegated: 누가 받나('1호차'). */
  delegatedTo?: string;
  /** scheduled: 누가 · 언제('김OO 팀 결제 예정'). */
  scheduledNote?: string;
  /**
   * 이 기기에서 누르면 확인 창 대신 보일 한두 문장과 대신 할 동작(서버가 정함). 차량이 할 도장('1호 차량이 22:00에 받습니다')이나
   * 이 기기가 찍지 않는 도장(카운터의 받음 도장)에 온다. 동작이 없으면 문장만.
   */
  pressNote?: PressNote;
}

/** 누른 도장 대신 보일 알림(StampCell.pressNote). */
export interface PressNote {
  lines: string[];
  /** 알림 창의 다른 동작 하나('매장에서 지급', '접수증 열기'). */
  action?: { actionKey: ActionKey; label: string };
}

/** 장부 칸 값. column_key마다 하나, 칸의 그리기(renderer_key)와 모양이 맞는다. */
export type LedgerCell =
  /** 시각 칸: drop 0 조각(시각)이 아랫줄, 나머지가 작은 윗줄. 윗줄에서 drop이 가장 큰 조각이 종류('수령' · '반납')다. */
  | { renderer: 'time'; at: IsoTime; parts: FitPart[] }
  | { renderer: 'team'; name: string; last4: string; parts?: FitPart[] }
  | { renderer: 'items'; items: ItemCount[] }
  | { renderer: 'promise'; parts: FitPart[] }
  | { renderer: 'place'; parts: FitPart[] }
  | { renderer: 'vehicle'; parts: FitPart[] }
  | { renderer: 'text'; parts: FitPart[] }
  | { renderer: 'attribute'; parts: FitPart[] }
  | {
      renderer: 'money';
      /** 긴 것부터 짧은 것 순의 한 줄 대체 문구(alts): ['미수 120,000원', '120,000원']. */
      alts: string[];
      /**
       * 첫 한 줄 문구가 들어가지 않을 때의 두 줄(작은 윗줄 이름 · 아랫줄 금액): { over: '미수', main: '120,000원' }.
       * 좁은 칸에서도 '미수'와 '원'을 함께 지킨다. 두 줄도 들어가지 않으면 나머지 대체 문구.
       */
      stacked?: { over: string; main: string };
      tone: ToneKey;
      /** 이 시각이 지나면 빨강(늦은 미수). 늦지 않은 미수는 검정이다. */
      lateAt?: IsoTime;
    }
  | { renderer: 'stamp'; stamp: StampCell }
  | { renderer: 'action'; actionKey: ActionKey; enabled: boolean; phone?: string };

export type LedgerCellRenderer = LedgerCell['renderer'];

/** 장부 · 목록의 한 줄. 줄의 단위(팀 · 업무 · 품목 줄)는 화면 설정의 row_grain_key가 정한다. */
export interface LedgerRow {
  id: string;
  orderId?: string;
  taskId?: string;
  /** 묶음 키(시간대 · 반납 타임). groups의 key와 같다. */
  groupKey?: string;
  /** 보조 묶음 이름표(장소 '설천 주차장'). 제목이 아니라 줄 안의 이름표. */
  subgroupLabel?: string;
  /** 이름표가 좁은 자리에 들어가지 않을 때의 짧은 이름('설천', '들국화'). 그것도 안 들어가면 이름표를 뺀다. */
  subgroupShortLabel?: string;
  /** 정렬 순위(방문 순서는 분수 순위 글자, 그 밖은 서버 순서). 화면은 이 순서대로 그린다. */
  rank: string;
  /** 다음 약속 시각(next_due_at). 지금 줄의 기준. 끝난 팀은 없다. */
  dueAt?: IsoTime;
  /** 이 시각이 지나면 그 줄이 빨개진다(서버가 정한 기준, 화면이 매분 비교). */
  lateAt?: IsoTime;
  /** 끝난 팀(다음 약속 없음): 맨 뒤에 흐리게. */
  finished: boolean;
  cells: Record<string, LedgerCell>;
  /** 모인 도장 칸(collapse_group)이 보일 다음 단계. 없으면 칸 순서에서 첫 남은 도장. */
  nextStepKey?: string;
  /** 같은 쪽을 보는 동안 자리가 바뀌었음(자리 지키기 표시). */
  moved?: boolean;
  /** 이 줄에 온 확인 필요 한 문장('매장에서 이미 받음'). */
  reviewNote?: string;
  /** 이 줄의 능력(옆 동작 · 동작 줄의 조건, 서버가 계산). 'always' 아닌 조건은 이것으로만 맞춘다. */
  conditions?: ConditionKey[];
  /** 이 줄에서 지금 누를 수 없는 동작과 그 까닭 한 문장(받은 줄의 '못 받음', 빨리 확인으로 고정된 줄의 ▲ · ▼). */
  disabledActions?: DisabledAction[];
}

/** 누를 수 없는 동작(회색 버튼)과 까닭. */
export interface DisabledAction {
  actionKey: ActionKey;
  reason: string;
}

/** 묶음(시간대 · 반납 타임). 제목 '22:00 반납 · 4 / 8'. */
export interface LedgerGroup {
  key: string;
  label: string;
  /** 좁은 자리의 짧은 이름('22:00'). 한 쪽에 묶음 제목을 합칠 때 넘치면 짧은 이름들을 잇는다. */
  shortLabel?: string;
  /** 묶음 시각(반납 타임). */
  at?: IsoTime;
  done: number;
  total: number;
}

/** 바닥줄 숫자 값. 모양(unit)에 따라 화면이 '18팀', '지급 14', '미수 485,000원'으로 쓴다. */
export type MetricValue =
  | { metricKey: LedgerMetricKey; unit: 'team'; value: number }
  | { metricKey: LedgerMetricKey; unit: 'count'; value: number }
  | { metricKey: LedgerMetricKey; unit: 'won'; value: number }
  | { metricKey: LedgerMetricKey; unit: 'items'; items: ItemCount[] };

/** 빨리 확인 한 건(task_pins + 세 단계 알림). */
export interface PinRow {
  pinId: string;
  taskId: string;
  orderId?: string;
  at: IsoTime;
  /** '꽃마을 들국화 · 오승민 · 0039 · 조기 반납'의 조각(시각은 at으로 따로). */
  parts: FitPart[];
  phone?: string;
  status: 'requested' | 'delivered' | 'acknowledged';
}

/** 야간 수거 준비 안내(반납 타임 60분 전부터, 설정). */
export interface NightPrepNotice {
  slotAt: IsoTime;
  placeLabel: string;
  teams: number;
}

/** 차에 있는 것(vehicle_load 숫자와 같은 읽기 모델). */
export interface VehicleLoad {
  vehicleId: string;
  vehicleLabel: string;
  items: ItemCount[];
  /** 예비권(권종별). */
  spareTickets: ItemCount[];
  /** 업무별로 누구 것인지. */
  byTask: { taskId: string; teamName: string; last4: string; items: ItemCount[] }[];
}

/** 주 버튼에 붙는 수(매장 입고 14개, 지급 도장 · 6개 · 3매, 수납 · 120,000원). */
export interface PrimaryFigure {
  /** 개로 세는 장비 수. */
  count?: number;
  /** 개가 아닌 단위로 센 수(리프트권 3매). 확인 창의 수와 같게 버튼에도 붙인다. */
  units?: { qty: number; unit: string }[];
  amount?: number;
}

/** ledgerView(viewKey, params)의 결과: 설정으로 그리는 모든 목록(대여 장부, 수거 목록, 기사 목록). */
export interface LedgerViewResult extends ReadModelHead {
  viewKey: string;
  deviceClass: DeviceClassKey;
  /** 제목 틀('{date} 대여 장부')에 넣을 값. */
  titleValues: { date?: BusinessDate; vehicle?: string };
  activeTabKey: string;
  tabCounts: Record<string, number>;
  groups: LedgerGroup[];
  rows: LedgerRow[];
  metrics: MetricValue[];
  /** 서버가 이 시점에 맞다고 본 화면 조건(after_last_return_slot 등). 주 버튼 고르기에 쓴다. */
  activeConditions: ConditionKey[];
  /** 주 버튼 이름에 붙는 수. */
  primaryFigure?: PrimaryFigure;
  /** pin_urgent 화면: 가장 급한 것부터. 화면은 첫 건을 고정 줄에, 나머지는 'N건 더'로. */
  pins?: PinRow[];
  vehicle?: { id: string; label: string };
  vehicleLoad?: VehicleLoad;
  nightPrep?: NightPrepNotice;
  /**
   * 다음 할 업무(주 버튼 next_step, 배달 목록): 아직 건네지 않은 첫 배달 업무와 그 동작 · 이름(`배달 처리 · 6개`). 실은 것이 없거나 남은
   * 배달이 없으면 enabled false(`배달 처리`, taskId 없음).
   */
  nextTask?: { taskId?: string; actionKey: ActionKey; label: string; alts: string[]; enabled: boolean };
  /** 이 영업일을 이미 마감했으면 제목 옆 이름표(`마감 완료`): 마감 뒤의 기록은 다음 날 마감에 든다. */
  closedTag?: string;
  /** 방문 결과 판(못 받음)의 이유(reason_codes의 visit_result, 매장 설정). 수거 목록에만. */
  visitReasons?: ReasonCode[];
}

/** 이유 하나(reason_codes). */
export interface ReasonCode {
  key: string;
  label: string;
}

/** 접수증 칸 한 줄(날짜 · 구분 · 대표자 · 연락처 · 인원 + 자리 'slip'의 속성). */
export interface SlipField {
  key: string;
  label: string;
  value: string;
  /** 칸이 좁을 때 빠지는 순서(0 = 빠지지 않음). */
  drop: number;
}

/** 접수증의 품목 줄. 세트 구성품은 parentLineId로 들여 쓴다. 화면은 cells만 그린다(칸마다 서버가 채운 값, 없으면 빈칸). */
export interface SlipLine {
  id: string;
  parentLineId?: string;
  isBundle: boolean;
  label: string;
  qty: number;
  /** 수량 글자('3매', '2'). */
  qtyText: string;
  amount: number;
  /** column_key → 칸 값. 설정의 모든 칸(품목 · 수량 · 금액 · 도장 · 속성)을 서버가 채운다. 세트 줄의 도장은 na. */
  cells: Record<string, LedgerCell>;
  /** 이 줄에서 쓸 수 있는 능력(교환 가능 · 연장 가능 · 일부 취소 가능). */
  capabilities: ConditionKey[];
}

/** 약속 요약 한 줄: '받기 16:00 매장 · 돌려주기 22:00 설천 · 1호차'. */
export interface PromiseSummary {
  /** 줄마다 일정이 다르면 몇 가지인지('일정 3건'). 1이면 lines를 그대로 쓴다. */
  distinct: number;
  /**
   * 종류마다 한 줄(수령 · 반납). 한 종류의 일정이 품목 · 수량으로 나뉘었으면(일정 변경 N2) count가 그 수이고, 화면은 그 종류를
   * '반납 일정 2건 ›'으로 줄여 쓴다(at · parts는 가장 이른 일정).
   */
  lines: {
    kind: 'pickup' | 'return';
    at: IsoTime;
    /**
     * 날 말 + 시각 글(영업일로 센 것: 오늘이면 `22:00`, 심야 반납은 `24:00`, 다른 날이면 `내일 09:00`). 있으면 화면은 at에서 세지 않고 이
     * 글을 쓴다(기준 시각 전의 새벽이 `오늘 00:00`으로 아침처럼 읽히지 않게).
     */
    when?: string;
    parts: FitPart[];
    lateAt?: IsoTime;
    count?: number;
  }[];
}

/** 접수증의 돈 줄: '청구 225,000원 · 수납 105,000원(계좌이체 12/24) · 미수 120,000원'. */
export interface SlipMoney {
  charged: number;
  paid: number;
  due: number;
  payments: { amount: number; methodLabel: string; date: BusinessDate }[];
  /** 다른 팀이 낼 몫('김OO 팀 결제 예정'). */
  promisedBy?: { teamName: string; amount: number };
  /** 이 팀이 대신 낼 몫('다른 팀 몫 400,000원'). */
  collectForOthers?: number;
  /** 대신 낼 몫이 있을 때 이 창구에서 받을 돈(이 팀 미수 + 대신 낼 몫, '받을 돈 150,000원'). 미수는 늘 이 팀 몫만이다. */
  collectTotal?: number;
  /** 맡고 있는 보증금(청구 · 미수에 넣지 않고 따로: '보증금 15,000원', data-model 4-12). 없으면 조각이 없다. */
  depositHeld?: number;
  /**
   * 이 팀이 이미 다른 팀 몫까지 낸 돈(일괄 수납 뒤): `대납 395,000원 · 카드 485,000원`(대납한 몫 · 그 결제의 수단과 실제 금액). 다시 인쇄하거나
   * 손님께 설명할 때 한 번에 낸 돈이 보인다. 없으면 조각이 없다.
   */
  paidForOthers?: { amount: number; methodLabel: string; total: number };
  /** 이 시각이 지나면 미수가 빨강. */
  lateAt?: IsoTime;
}

/** 남은 일 목록(B2) 한 줄. 끝난 일은 화면이 한 줄('끝난 일 3')로 접는다. */
export interface ChecklistItem {
  stepKey: string;
  /** checklist_label + 요약 조각: '장비 지급 · 스키 2 · 보드 1 · 헬멧 3'. */
  parts: FitPart[];
  state: 'done' | 'now' | 'later';
  actionKey: ActionKey;
  figure?: PrimaryFigure;
  /** 둘째 줄 품목 요약('스키 2 · 보드 1 · 헬멧 3 · 야간권 3매', 넘치면 '외 N종'). */
  items?: ItemCount[];
  /**
   * 둘째 줄 조각(품목이 아닌 것): 반납의 장소 · 방법('설천 주차장 · 차량 수거', 일정이 둘이면 '설천 주차장 · 솔마을 두솔동').
   * items가 있으면 items를 쓴다.
   */
  second?: FitPart[];
  /** 이 시각이 지나면 이 일이 늦음(빨강, '늦음'). */
  lateAt?: IsoTime;
  /**
   * 이 단계의 접수 단위 도장(장부의 팀 한 줄 도장과 같은 모음). 있으면 처리 현황의 줄을 눌러 그 단계를 접수 전체로 연다
   * (차량이 할 반납이면 먼저 '1호 차량 수거 예정 · 22:00'과 '매장 반납 처리', 매장 반납이면 모든 줄의 반납 창 — spec 3-1).
   */
  stamp?: StampCell;
}

/** 다음 할 일(주황 큰 버튼 하나): '지급 도장 · 6개', '차량 적재 6개', '수납 · 120,000원'. */
export interface NextStep {
  stepKey: string;
  actionKey: ActionKey;
  figure?: PrimaryFigure;
}

/** orderSlip(orderId)의 결과(ui 6-2). */
export interface OrderSlip extends ReadModelHead {
  orderId: string;
  receiptNo: string;
  businessDate: BusinessDate;
  teamName: string;
  last4: string;
  fields: SlipField[];
  lines: SlipLine[];
  promises: PromiseSummary;
  money: SlipMoney;
  /** 접수 단위 도장(수납). */
  orderStamps: StampCell[];
  checklist: ChecklistItem[];
  nextStep: NextStep | null;
  /** 접수 단위 능력(열린 차량 업무 등). */
  activeConditions: ConditionKey[];
  /**
   * 이 팀이 다른 팀 몫까지 받을 팀이면(결제 예정 팀이 딸림): 수납은 보통 수납 창이 아니라 일괄 수납 화면(V5)을 연다(ui 6-7).
   * teams는 이 팀을 포함한 팀 수, amount는 처음 고른 합(받을 금액).
   */
  groupPay?: { teams: number; amount: number };
}

/** 끝 4자리 찾기 결과. 하나면 그 접수증을 바로 연다. */
export interface FindResult {
  last4: string;
  matches: { orderId: string; teamName: string; last4: string; parts: FitPart[] }[];
}

/** 확인 필요 한 건(sys_review_kinds). 한 줄 한 문장 · 버튼 두 개. */
export interface ReviewItem {
  id: string;
  kindKey: string;
  message: string;
  severity: 'info' | 'action' | 'blocking';
  createdAt: IsoTime;
  orderId?: string;
  taskId?: string;
}

/** 상태 문구를 부를 때의 키 쌍. */
export interface StatusRef {
  domain: StatusDomainKey;
  key: string;
}

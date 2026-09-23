// 체험 자료(FixtureClient)의 저장 모양. 운영 서버의 표(orders · order_lines · promises · payments …)를 아주 줄인 것이다.
// 화면은 이 모양을 보지 않는다: FixtureClient가 여기서 읽기 모델(@skinote/contract)을 만들어 준다.
import type { AnyCommandEnvelope, CommandOutcome, ConditionKey } from '@skinote/contract';

/** 받기 · 돌려주기 방법: 매장에서 직접, 또는 차량(배달 · 수거). */
export type FxMode = 'store' | 'vehicle';

/** 약속 하나(받기 또는 돌려주기). 장소는 구역 → 장소(솔마을 → 한솔동). */
export interface FxPromise {
  at: number;
  mode: FxMode;
  placeId?: string;
  vehicleId?: string;
  /** 약속에 붙은 말('조기 반납'). */
  note?: string;
}

/** 결제 칸. 리프트권은 선입금으로 먼저 받는 일이 많다(docs/52 2-6). */
export type FxSection = 'gear' | 'lift';

export type FxMethodKey = 'card' | 'cash' | 'transfer';

export interface FxLine {
  id: string;
  kind: string;
  /** 접수증의 이름('야간권 성인'). */
  label: string;
  /** 장부 품목 칸의 짧은 이름('야간권'). */
  shortLabel: string;
  qty: number;
  /** 수량 단위('매'). 없으면 '개'. */
  unit?: string;
  amount: number;
  section: FxSection;
  /** 돌려받는 품목인지(리프트권은 반납 없음). */
  returnable: boolean;
  capabilities: ConditionKey[];
  loaded: number;
  loadedAt?: number;
  issued: number;
  issuedAt?: number;
  /** 매장에서 직접 돌려받은 수. */
  returned: number;
  returnedAt?: number;
  /** 차량이 받은 수. */
  collected: number;
  collectedAt?: number;
  /** 차량이 받은 것 중 매장에 내려놓은 수(매장 입고). 차에 있는 것 = collected − received. */
  received: number;
  receivedAt?: number;
}

export interface FxPayment {
  id: string;
  amount: number;
  methodKey: FxMethodKey;
  at: number;
  /** 이 돈이 채운 결제 칸(선입금은 리프트권). 없으면 장비 → 리프트권 순으로 채운다. */
  section?: FxSection;
  /** 한 번에 여러 팀을 받은 묶음(요청번호). */
  groupId?: string;
}

export interface FxOrder {
  id: string;
  receiptNo: string;
  /** 대표자 이름(현장 대여는 대표자만 적는다). */
  teamName: string;
  last4: string;
  /** 체험 자료의 번호는 모두 가짜(010-0000-xxxx). */
  phone: string;
  channel: 'walk_in' | 'phone';
  party: number;
  /** 접수(전화 예약이면 예약한 때). */
  createdAt: number;
  pickup: FxPromise;
  giveBack: FxPromise;
  lines: FxLine[];
  payments: FxPayment[];
  /** 이 팀의 미수를 대신 낼 팀(결제할 팀, N19). */
  payerOrderId?: string;
  /** 돈을 받기로 한 때: 받을 때(수령) 또는 돌려줄 때(반납). */
  payWhen: 'pickup' | 'return';
  /** 기사 방문 결과(못 받음). 쌓기만 한다(task_visits). */
  visits?: FxVisit[];
}

/** 방문 결과 하나: 고객 부재 · 장소 변경 · 물품을 받지 못함 → 다시 갈 때. */
export interface FxVisit {
  at: number;
  outcomeKey: FxVisitOutcome;
  /** 다시 갈 약속(없으면 매장이 정한다). */
  retryAt?: number;
  /** 옮기기 전의 약속 시각. */
  beforeAt: number;
}

export type FxVisitOutcome = 'customer_absent' | 'place_changed' | 'items_not_ready';

/** 빨리 확인(매장이 기사에게 맨 위로 고정해 알림). */
export interface FxPin {
  id: string;
  orderId: string;
  at: number;
  note: string;
  status: 'requested' | 'delivered' | 'acknowledged';
}

export interface FxArea {
  id: string;
  label: string;
  /** 숙소 구역이면 장소 이름 앞에 구역 이름을 붙여 쓴다('솔마을 한솔동'). */
  lodging: boolean;
  places: { id: string; label: string }[];
}

export interface FxVehicle {
  id: string;
  label: string;
}

/** 기사 기기의 보냄 대기 한 건(오프라인에서 확인한 명령). 다시 연결되면 순서대로 보낸다(sync 8-3). */
export interface FxQueued {
  envelope: AnyCommandEnvelope;
  /** 기기에서 확인한 때(도장에 찍히는 시각). */
  at: number;
  summary: string;
}

/** 기사 기기(체험판에서는 이 브라우저)의 연결 상태와 보냄 대기. 카운터는 매장 네트워크라 늘 연결되어 있다. */
export interface FxDevice {
  offline: boolean;
  /** 연결이 끊긴 때(마지막 맞춤). */
  since?: number;
  queue: FxQueued[];
}

export interface FxState {
  version: 2;
  /** 체험 자료를 처음으로 되돌릴 때마다 바뀐다(열린 확인 창의 basis가 옛것이면 거절). */
  epoch: string;
  rev: number;
  businessDate: string;
  orders: FxOrder[];
  pins: FxPin[];
  /** 기사 방문 순서(업무 id → 순위 글자). 없으면 약속 시각순. */
  routeRanks: Record<string, string>;
  /** 받은 명령의 결과(요청번호 → 결과). 같은 요청번호가 다시 오면 다시 하지 않고 이것을 돌려준다. */
  outcomes: Record<string, CommandOutcome>;
  /** 기사 기기의 연결과 보냄 대기(체험 '나가기'에서 끊고 잇는다). */
  driverDevice: FxDevice;
}

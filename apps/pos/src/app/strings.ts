// 포스 앱 화면의 문구 표(ui 3-9). 부품 문구는 @skinote/ui의 표(t), 동작 · 도장 · 상태 이름은 설정(sys_actions · 도장 단계 ·
// status_terms)에서 온다. 여기에는 화면 틀과 체험판에만 있는 문장을 둔다. 코드에 한글 문장을 흩어 두지 않는다.
// 말투: 짧은 이름씨 표시(docs/design/wording.md). 버튼 · 이름표에 문장 끝과 안내 문장을 쓰지 않고, 꼭 남길 알림은 '사실 · 할 일'
// 모양이다('처리 실패 · 재시도 필요'). 가게 말: 장부 · 접수증 · 지급 · 반납 · 수납 · 미수 · 수거 · 수거 실패 · 차량 재고 ·
// 전송 대기 · 긴급 · 끝 4자리 · 매장 입고 · 연결 끊김. 조사를 이름 뒤에 붙여 만들지 않는다(받침에 따라 틀린다).
// 자리({name})의 값은 say()의 형식이 요구한다(빠지면 컴파일 오류).
import { createStrings } from '@skinote/ui';

export const APP_STRINGS_KO = {
  appName: '스키노트',
  titleLedger: '대여 장부 · 스키노트',
  titleSlip: '대여 접수증 · 스키노트',
  titleCollection: '수거 목록 · 스키노트',
  titleExit: '나가기 · 스키노트',
  titleDriver: '야간 수거 목록 · 스키노트',
  titleNewOrder: '새 접수 · 스키노트',
  titleGroupPay: '일괄 수납 · 스키노트',
  titleClosing: '마감 · 스키노트',
  titleManage: '관리 · 스키노트',
  titleShopSettings: '매장 설정 · 스키노트',
  titleDeliveries: '배달 목록 · 스키노트',
  titleTask: '업무 판 · 스키노트',

  // 처음 화면 · 나가기(체험판)
  demoData: '체험 자료',
  startCounter: '카운터(포스)',
  startCounterNote: '오늘 대여 장부 · 대여 접수증',
  startTablet: '기사 태블릿',
  startPhone: '기사 휴대폰',
  startDriverNote: '야간 수거 목록',
  startNote: '체험 자료 · 이 기기에만 저장 · 초기화: 나가기 화면',
  exitTitle: '나가기',
  toStart: '처음 화면',
  toLedger: '장부',
  toList: '수거 목록',
  /** 휴대폰 업무 판 바닥줄의 돌아가는 버튼(가는 곳의 짧은 말, 문구 표 3-16). */
  toListShort: '목록',
  demoClock: '체험 시계',
  demoClockAt: '체험 시계 {time}',
  demoClockNote: '시각 이동 · 지연 반납 · 야간 수거 준비 확인용',
  plus10: '+10분',
  plus60: '+1시간',
  resetNote: '처리 · 수납 기록 삭제 · 시계 15:40',
  resetButton: '체험 자료 초기화',
  resetConfirm: '처리 · 수납 기록 삭제 · 시계 15:40',
  resetAction: '초기화',
  resetDone: '초기화 완료',
  deviceOffline: '기사 기기 · 연결 끊김',
  deviceOnline: '기사 기기 · 연결됨',
  offlineNote: '연결 끊김 중 수거 처리 · 점선 도장',
  onlineNote: '연결 끊김 체험',
  disconnect: '연결 해제',
  reconnect: '재연결',
  reconnectWaiting: '재연결 · 전송 대기 {n}',

  // 공통 문장
  teamName: '{name} 팀',
  last4: '끝 4자리 {last4}',
  vehicle: '차량',
  back: '이전',
  noAlerts: '새 알림 없음',
  demoNoCall: '체험판 · 전화 연결 없음',
  noPhone: '전화번호 없음',
  screenSoon: '준비 중인 화면',
  deviceUnavailable: '이 기기에서 사용 불가',

  // 확인 창 · 명령
  openFailed: '연결 끊김 · 창 열기 실패 · 재시도 필요',
  sendFailed: '전송 실패 · 재전송 필요',
  commandFailed: '처리 실패 · 재시도 필요',
  alreadyDone: '처리 완료',
  methodGroup: '결제 수단',
  blockedDefault: '이전 단계 대기',
  stampedAt: '{label} 완료 · {time}',
  stamped: '{label} 완료',
  delegatedTo: '{who} 담당',
  scheduledNote: '{note}',
  scheduledDefault: '다른 팀 결제 예정',
  payNow: '직접 수납',
  /** 알림 창 제목: 도장 단계 · 동작 이름 + 팀('반납 · 김민재 팀', '전화 · 김민재 팀'). */
  noticeTitle: '{label} · {name} 팀',
  /** 수량 −/+가 있는 확인 창의 주 버튼: 동작 이름 + 지금 수량('지급 처리 · 2개'). */
  confirmQty: '{label} · {n}{unit}',

  // 장부 · 접수증
  ledgerUnreadable: '연결 끊김 · 장부 조회 실패 · 자동 재시도',
  slipMissing: '접수 없음',
  slipUnreadable: '연결 끊김 · 접수증 조회 실패 · 자동 재시도',
  remainingSteps: '처리 현황',
  itemsPager: '품목',

  // 끝 4자리 찾기
  found: '조회 결과 · {name} 팀',
  notFound: '끝 4자리 {last4} · 해당 팀 없음',
  notInList: '끝 4자리 {last4} · 목록에 없음',
  findFailed: '연결 끊김 · 조회 실패',

  // 수거 목록
  listUnreadable: '연결 끊김 · 수거 목록 조회 실패 · 자동 재시도',
  onVan: '차량 재고',
  vanEmpty: '입고 대상 없음',
  /** 차량 재고 창의 예비권 줄 이름(`예비권 · 야간권 6매`). */
  spareTickets: '예비권',
  withCount: '{name} · {n}개',
  receiveShort: '입고 · {n}개',
  receiveShortName: '입고',
  receiveNeedsLink: '입고 불가 · 연결 끊김',

  // 방문 결과 판(수거 실패)
  visitWhat: '사유',
  visitWhen: '재방문',
  visitToday: '오늘',
  visitDate: '날짜',
  visitWhichDay: '재방문 날짜',
  visitWhatTime: '재방문 시각',
  visitCustom: '직접 입력',
  visitReview: '기록 확인',
  visitAgain: '재방문 {when}',
  visitSave: '저장',

  // ── 둘째 판 화면(docs/design/screens-v2 V1 ~ V9). 글은 채택한 시안 · 문구 표의 말 그대로다. 줄마다 다른 글(팀 · 금액 · 일정)은
  //    읽기 모델(서버)이 쓰고, 여기에는 화면 틀의 이름표 · 버튼 · 읽는 이름만 둔다. 돌아가기 버튼은 가는 곳 이름(원칙 13).
  toSlip: '접수증',
  toDeliveries: '배달 목록',
  toManage: '관리',

  // V1 반납 확인 창 · 부분 반납
  refundMethod: '반환 방법',
  refundMethodGroup: '보증금 반환 방법',
  piecesOf: '{item} 번호',

  // V9 일정 변경 · 부분 품목
  changeItems: '변경 품목',
  returnTime: '반납 시각',
  returnPlace: '반납 장소',
  pickupVehicle: '수거 차량',
  qtyOf: '{item} 수량',
  summaryChanged: '변경',
  summaryKept: '유지',
  placeAgain: '{place} · 장소 다시 선택',
  pickDay: '다른 날 · 날짜 선택',
  /** 카운터가 끊겼을 때(sync 8-2: 일정 변경은 연결이 필요한 결정, 문구 표 3-5). */
  promiseOffline: '일정 변경 불가 · 연결 끊김 · 종이 접수증에 기록',

  // V2 · V3 새 접수
  newOrder: '새 접수',
  newOrderSteps: '새 접수 단계',
  stepItems: '① 품목',
  stepSchedule: '② 일정',
  stepPay: '③ 결제',
  newOrderItemsAria: '새 접수 · 품목',
  newOrderScheduleAria: '새 접수 · 일정',
  leader: '대표자',
  leaderEmpty: '이름',
  leaderInput: '대표자 {name} · 이름 입력',
  contact: '연락처',
  contactInput: '연락처 {phone} · 숫자판',
  party: '인원',
  kindGroup: '품목 종류',
  kindPickHint: '품목 종류 선택',
  kindPick: '{kind} 선택',
  selectedItems: '선택 품목',
  nextToSchedule: '다음 · 일정',
  nextToPay: '다음 · 결제',
  pickupMethod: '수령 방법',
  returnDay: '반납일',
  orderSummary: '접수 내용',
  perItemSchedule: '품목별 일정 · 접수 후 일정 변경',
  reserveAria: '예약 · 수령일 · 시각 선택(전화 예약)',
  /** 빈 칸의 읽는 이름(대표자 · 연락처를 아직 넣지 않음). */
  leaderPad: '대표자 · 이름 입력',
  contactPad: '연락처 · 숫자판',
  /** `예약 · 수령일 ›` 작은 창(제목은 구분 이름 `전화 예약`, 줄 이름표는 수령일 · 수령 시각 · 수령 장소). */
  reserveTitle: '전화 예약',
  pickupDay: '수령일',
  pickupTime: '수령 시각',
  pickupPlace: '수령 장소',
  /** `차량 배달 ›` 작은 창(배달 시각 · 배달 장소). */
  deliverTitle: '차량 배달',
  deliverTime: '배달 시각',
  deliverPlace: '배달 장소',

  // V4 접수 확정 창 · 칸별 수납(칸의 `할인 적용 ›` · 읽는 이름은 부품 문구 t.discountApply · discountApplyFor · methodsFor)
  payerGroup: '결제 팀',
  findOtherTeam: '다른 팀 찾기 · 끝 4자리',

  // V5 일괄 수납 · 여러 팀
  groupPay: '일괄 수납',
  colSelect: '선택',
  colTeam: '팀',
  colItems: '품목',
  colDue: '받을 금액',
  pickTeams: '선택 팀',
  teamSelected: '{team} 선택',
  partialPick: '부분 결제 품목 선택',
  addTeam: '팀 추가 · 끝 4자리',
  excludeAndPay: '제외 후 수납',

  // V6 하루 마감
  colMethod: '결제 수단',
  colCount: '건수',
  colAmount: '금액',
  cashCheck: '현금 점검',
  expectedActual: '예상 · 실제',
  carryOver: '이월 항목 · {n}',
  closingPrint: '마감표 인쇄',
  /** 결제 수단 표의 건수 칸(`11건`). */
  cases: '{n}건',
  /** 점검 판: 친 금액 칸 이름, 차액 사유 버튼 줄 이름(문구 표 1-2 `예상` · `실제` · `차액` · `사유`). */
  actual: '실제',
  diffReason: '사유',
  closingUnreadable: '연결 끊김 · 마감 조회 실패 · 자동 재시도',
  /** 체험 자료에 없는 날의 마감(문구 표 1-4 `해당 없음`). */
  closingNone: '해당 없음',
  /** 카운터가 끊겼을 때(sync 8-2, 문구 표 3-9). */
  closingOffline: '마감 · 연결 후 가능',
  /** 마감표 인쇄(문구 표 3-1 · 3-3의 인쇄 `체험판 미지원`). */
  demoUnsupported: '체험판 미지원',

  // V7 기사 업무 판 · 배달 목록(판 · 버튼 · 표의 글은 읽기 모델이 쓴다)
  taskOfTeam: '이 팀 업무',
  returnPlan: '반납 일정',
  taskMissing: '업무 없음',
  taskUnreadable: '연결 끊김 · 업무 판 조회 실패 · 자동 재시도',
  /** 리프트권 추가 판의 이름표(권종 버튼 줄 · 수량). */
  ticketKind: '권종',
  ticketQty: '수량',
  /** 현장 수납 판의 금액 칸 이름(숫자판으로 넣는 금액). */
  fieldAmount: '금액',

  // V8 관리 · 매장 설정 · 운영 규칙(머리줄 버튼 `관리`는 부품 문구 t.manage, 카드의 이름표 `변경됨`은 t.changed). 카드 · 바뀐 곳 ·
  // 바닥줄 · 저장 확인 창 제목(`변경 3건`) · 떠날 때 창 제목(`미저장 변경 3건`) · 거절 까닭은 읽기 모델(shopRules)이 쓴다.
  shopSettings: '매장 설정',
  closing: '마감',
  tabInfo: '매장 정보',
  tabPlaces: '장소',
  tabSlots: '반납 타임',
  tabPricing: '요금 · 할인',
  tabFleet: '차량 · 직원',
  tabRules: '운영 규칙',
  dontSave: '저장 안 함',
  /** 저장 확인 창의 한 줄(문구 표 3-11). */
  saveNote: '다음 기록부터 적용 · 지난 기록 · 접수 유지',
  /** 카운터가 끊겼을 때(ui 6-9, 문구 표 3-11). */
  settingsOffline: '설정 변경 · 연결 후 가능',
  settingsUnreadable: '연결 끊김 · 설정 조회 실패 · 자동 재시도',

  // ── 서버 연결(계획 work/impl-server/plan.md 6-3 · 8절, 문구 표 3-17 확인 대기): 기기 등록 · 로그인 · 로그아웃 · 연결 끊김 화면.
  //    `연결 끊김` · `마지막 연결 {time}`은 부품 문구(t.offline · t.lastSync), `입력` · `정정` · `닫기`는 숫자판의 말이다.
  titleEnroll: '기기 등록 · 스키노트',
  titleLogin: '로그인 · 스키노트',
  enrollTitle: '기기 등록',
  enrollCode: '등록 번호',
  enrollLine: '등록 번호 12자리',
  enrollBadCode: '등록 번호 불일치 · 재입력 필요',
  enrollUsed: '등록 번호 만료 · 새 번호 필요',
  tooManyTries: '시도 횟수 초과 · 잠시 후 재시도',
  loginTitle: '로그인',
  /** 비밀번호 숫자판의 제목(고른 직원 이름 + `비밀번호`). */
  pinPadTitle: '{name} · 비밀번호',
  pinWrong: '비밀번호 불일치 · 재입력 필요',
  loginLocked: '로그인 잠김 · {time} 이후 가능',
  loginExpired: '로그인 만료 · 재로그인 필요',
  logout: '로그아웃',
  retry: '재시도',

  // ── 시험 매장의 열린 기기 등록(2026-09-26 시험 중 요청, 문구 표 3-19 확인 대기): 등록 번호 대신 처음 온 기기가 고른다. 종류 버튼은
  //    처음 화면의 말(startCounter · startPhone · startTablet과 그 아래 줄), 돌아가는 버튼은 `이전`(back)이다.
  titleChoose: '기기 선택 · 스키노트',
  chooseTitle: '기기 선택',
  chooseVehicleTitle: '차량 선택',
  /** 열린 등록으로 붙은 기기가 끝 수(서버 30대)에 닿았을 때. */
  deviceLimit: '기기 수 초과 · 관리자 확인 필요',
  /** 기기 선택의 종류 단계: 매장에 쓰는 차량이 없어 기사 기기를 고를 수 없을 때. */
  noVehicles: '차량 없음 · 관리자 확인 필요',
  /** 기기 선택 화면이 번호 등록으로 바뀜(서버가 열린 등록을 끔 · 기한 지남): 기기 등록 숫자판의 첫 한 줄. */
  chooseClosed: '기기 선택 종료 · 등록 번호 필요',
} as const;

/** 앱 화면 문구를 부르고 {이름} 자리를 채운다. */
export const say = createStrings(APP_STRINGS_KO);

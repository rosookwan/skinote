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
} as const;

/** 앱 화면 문구를 부르고 {이름} 자리를 채운다. */
export const say = createStrings(APP_STRINGS_KO);

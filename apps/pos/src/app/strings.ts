// 포스 앱 화면의 문구 표(ui 3-9). 부품 문구는 @skinote/ui의 표(t), 동작 · 도장 · 상태 이름은 설정(sys_actions · 도장 단계 ·
// status_terms)에서 온다. 여기에는 화면 틀과 체험판에만 있는 문장을 둔다. 코드에 한글 문장을 흩어 두지 않는다.
// 말투: 가게에서 쓰는 쉬운 말, 짧은 한 문장. 조사를 이름 뒤에 붙여 만들지 않는다(받침에 따라 틀리므로 문장을 통째로 둔다).
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
  startNote: '체험 자료는 이 기기에만 남습니다. 처음 자료로 되돌리려면 나가기 화면에서 \'처음 자료로 되돌리기\'를 누릅니다.',
  exitTitle: '나가기',
  toStart: '처음 화면으로',
  toLedger: '장부로 돌아가기',
  toList: '수거 목록으로',
  demoClock: '체험 시계',
  demoClockAt: '체험 시계 {time}',
  demoClockNote: '시계를 앞으로 돌리면 늦은 반납과 야간 수거 준비가 어떻게 보이는지 볼 수 있습니다.',
  plus10: '10분 앞으로',
  plus60: '1시간 앞으로',
  resetNote: '찍은 도장과 수납을 모두 지우고 처음 자료(15:40)로 되돌립니다.',
  resetButton: '처음 자료로 되돌리기',
  resetConfirm: '찍은 도장과 수납이 모두 지워지고 시계가 15:40으로 돌아갑니다.',
  resetAction: '되돌리기',
  resetDone: '처음 자료로 되돌렸습니다.',
  deviceOffline: '기사 기기 · 연결 끊김',
  deviceOnline: '기사 기기 · 연결됨',
  offlineNote: '끊긴 동안 찍은 받음 도장은 점선입니다.',
  onlineNote: '산에서 신호를 잃은 것처럼 해 봅니다.',
  disconnect: '연결 끊기',
  reconnect: '다시 연결',
  reconnectWaiting: '다시 연결 · 보냄 대기 {n}',

  // 공통 문장
  teamName: '{name} 팀',
  last4: '끝 4자리 {last4}',
  vehicle: '차량',
  back: '뒤로',
  noAlerts: '새 알림이 없습니다.',
  demoNoCall: '체험 화면에서는 전화를 걸지 않습니다.',
  screenSoon: '아직 만드는 중인 화면입니다. 지금은 장부와 접수증에서 도장을 찍어 볼 수 있습니다.',
  deviceUnavailable: '이 기기에서는 할 수 없는 일입니다.',

  // 확인 창 · 명령
  openFailed: '연결이 끊겨 창을 열지 못했습니다. 잠시 뒤 다시 눌러 주세요.',
  sendFailed: '연결이 끊겨 보내지 못했습니다. 다시 누르면 같은 일로 다시 보냅니다.',
  commandFailed: '처리하지 못했습니다. 창을 닫고 다시 열어 주세요.',
  alreadyDone: '이미 끝난 일입니다.',
  methodGroup: '결제 수단',
  blockedDefault: '먼저 할 일이 있습니다',
  stampedAt: '{time}에 찍었습니다.',
  stamped: '이미 찍었습니다.',
  delegatedTo: '{who} 차례입니다.',
  scheduledNote: '{note}입니다.',
  scheduledDefault: '다른 팀 결제 예정',
  payNowHint: '이 팀이 지금 내면 지금 수납을 누릅니다.',
  payNow: '지금 수납',

  // 장부 · 접수증
  ledgerUnreadable: '연결이 끊겨 장부를 읽지 못했습니다. 잠시 뒤 다시 읽습니다.',
  slipMissing: '이 접수를 찾을 수 없습니다.',
  slipUnreadable: '연결이 끊겨 접수증을 읽지 못했습니다. 잠시 뒤 다시 읽습니다.',
  remainingSteps: '남은 일',
  itemsPager: '품목',

  // 끝 4자리 찾기
  found: '{name} 팀을 찾았습니다',
  notFound: '끝 4자리가 {last4}인 팀이 없습니다',
  notInList: '끝 4자리가 {last4}인 팀이 이 목록에 없습니다',
  findFailed: '연결이 끊겨 찾지 못했습니다. 다시 눌러 주세요',

  // 수거 목록
  listUnreadable: '연결이 끊겨 수거 목록을 읽지 못했습니다. 잠시 뒤 다시 읽습니다.',
  onVan: '차에 있는 것',
  vanEmpty: '차에 받은 것이 없습니다.',
  withCount: '{name} {n}개',
  receiveShort: '입고 {n}개',
  receiveShortName: '입고',
  offlineNow: '연결이 끊겨 있습니다.',
  receiveNeedsLink: '매장 입고는 연결된 뒤에 합니다.',

  // 방문 결과 판(못 받음)
  visitWhat: '무슨 일인가요?',
  visitWhen: '언제 다시 갈까요?',
  visitToday: '오늘 다시',
  visitDate: '날짜',
  visitWhichDay: '어느 날 갈까요?',
  visitWhatTime: '몇 시에 갈까요?',
  visitCustom: '직접 입력',
  visitReview: '이대로 남길까요?',
  visitAgain: '{when}에 다시 갑니다.',
  visitSave: '남기기',
} as const;

/** 앱 화면 문구를 부르고 {이름} 자리를 채운다. */
export const say = createStrings(APP_STRINGS_KO);

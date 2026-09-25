// 화면 문구 표(ui 3-9, 기본 ko-KR). 부품은 문구를 코드에 박지 않고 이 표의 키로 부른다.
// 말투는 짧은 가게 · 포스 업무 말이다(장부 · 접수증 · 지급 · 반납 · 수납 · 미수 · 도장 · 수거 목록 · 긴급 · 끝 4자리).
// 말의 기준은 docs/design/wording.md(문구 표)다. 표에 없는 말을 새로 만들지 않는다.
// fixed: 시험 · 촬영이 기대는 고정 문구(docs/42 부록 A 개정 대상). 바꾸면 CI가 알린다.

export const STRINGS_KO = {
  home: '장부',
  find: '끝 4자리',
  findTitle: '끝 4자리 찾기',
  more: '더 보기',
  alerts: '알림',
  alertsCount: '알림 {n}건',
  manage: '관리',
  exit: '나가기',
  offline: '연결 끊김',
  pendingCount: '전송 대기 {n}',
  sendingCount: '전송 중 {n}',
  lastSync: '마지막 연결 {time}',
  now: '현재 {time}',
  nightPrep: '야간 수거 준비 · {place} {n}팀',
  page: '{page} / {total}쪽',
  pageOf: '{label} {page} / {total}쪽',
  prevPage: '이전 쪽',
  nextPage: '다음 쪽',
  continued: '(계속)',
  nextPageHint: '다음 쪽',
  groupCount: '{done} / {total}',
  doneSteps: '완료 {n}건',
  moreSteps: '외 {n}건',
  erase: '정정',
  search: '찾기',
  call: '전화',
  moveUp: '▲',
  moveUpLabel: '위로',
  moveDown: '▼',
  moveDownLabel: '아래로',
  moveTop: '맨 위로',
  notCollected: '수거 실패',
  close: '닫기',
  confirm: '확인',
  pinTitle: '긴급',
  pinMore: '외 {n}건',
  pinAck: '확인',
  tooNarrow: '화면 폭 부족',
  zoomReset: '확대 초기화',
  moved: '순서 변경',
  movedShort: '변경',
  processing: '처리 중',
  pendingStamp: '전송 대기',
  qtyMinus: '수량 감소',
  qtyPlus: '수량 증가',
  qtySet: '수량 설정',
  partialOnly: '부분',
  slipTitle: '대여 접수증',
  receiptNo: '접수 번호 {no}',
  promisesMany: '일정 {n}건',
  pickup: '수령',
  giveBack: '반납',
  charged: '청구 {amount}',
  paid: '수납 {amount}',
  due: '미수 {amount}',
  dueWord: '미수',
  toCollect: '받을 금액 {amount}',
  promisedBy: '{team} 결제 예정 {amount}',
  forOthers: '대납 {amount}',
  /** 접수증 돈 줄: 다른 팀 몫까지 한 번에 낸 결제의 수단 · 실제 금액('카드 485,000원'). */
  methodAmount: '{method} {amount}',
  won: '{n}원',
  team: '{n}팀',
  count: '{n}개',
  today: '오늘',
  tomorrow: '내일',
  dayAfter: '모레',
  vehicle: '차량',
  vehicleAt: '차량 {time}',
  scheduled: '예정',
  stamps: '도장',
  late: '지연',
  /** 지연된 일정 · 처리 현황 줄의 종류 말('반납 지연 12:00 · 매장', '반납 지연 · 오늘 12:00'). */
  lateKind: '{label} 지연',
  lateBefore: '이전 쪽 지연 {n}팀',
  stampTodo: '{label} 미처리',
  stampDone: '{label} 완료',
  stampPartial: '{label} {done} / {total}',
  stampPartialSome: '{label} 부분',
  stampWordPartial: '부분 {label}',
  partialShort: '부분',
  stampBlocked: '{label} 대기',
  stampScheduled: '{label} 예정',
  stampDelegated: '{label} 차량 담당',
  /** 일부는 돌아왔고 나머지는 차량이 받는 줄(부분 반납 뒤): 읽는 이름 `반납 2 / 3 · 차량 담당`, 도장 윗줄 `2/3`. */
  stampDelegatedPartial: '{label} {done} / {total} · 차량 담당',
  stampNa: '{label} 해당 없음',
  none: '없음',
  groupsMore: '{first} 외 {n}',
  // 둘째 판 부품(work/impl-v2/plan.md): 접수증 돈 줄의 맡은 보증금(청구 · 미수와 따로), 장소 고르기의 구역으로 돌아가기(‹ 구역),
  // 금액 · 번호 숫자판의 입력 키.
  depositHeld: '보증금 {amount}',
  areas: '구역',
  enter: '입력',
  // 일정 변경(V9) · 새 접수(V3)의 장소 고르기 첫 버튼(문구 표 1-4 '매장 직접'), 접수증 일정 줄의 나뉜 일정('반납 일정 2건 ›', 3-3).
  storeDirect: '매장 직접',
  promisesKind: '{label} 일정 {n}건',
  // 새 접수(V2) 종류 타일의 고른 수 표시(읽는 이름, 문구 표 3-6 `선택 4`).
  pickedCount: '선택 {n}',
  // 접수 확정 창(V4)의 결제 칸(MethodRow, 문구 표 3-7): 수단 줄 끝의 `할인 적용 ›`(갈매기는 부품이 그린다)과 읽는 이름.
  discountApply: '할인 적용',
  discountApplyFor: '{section} 할인 적용',
  methodsFor: '{section} 결제 수단',
  // 관리 화면 카드(RuleCard, 매장 설정 · 운영 규칙 V8)의 저장하지 않은 바꿈 이름표(문구 표 3-11 `변경됨`).
  changed: '변경됨',
} as const;

export type StringKey = keyof typeof STRINGS_KO;

/**
 * 시험 · 촬영 · 규칙 검사기가 기대는 고정 문구(버튼 이름으로 찾는다). 값은 test/strings.test.ts가 그대로 적어 두고 맞춰 본다:
 * 바꾸면 그 시험이 실패하므로, 검사기 · 문서(docs/42 부록 A)를 함께 고친다.
 */
export const FIXED_STRING_KEYS = ['home', 'find', 'more', 'manage', 'exit', 'offline', 'page', 'pinTitle', 'tooNarrow', 'zoomReset', 'close', 'prevPage', 'nextPage', 'qtyMinus', 'qtyPlus', 'moveUpLabel', 'moveDownLabel', 'moveTop', 'notCollected', 'search', 'erase', 'confirm', 'pinAck'] as const satisfies readonly StringKey[];

export type Strings = Record<StringKey, string>;

/** '{n}팀' → 'n'. 문구 안의 자리 이름을 형식으로 꺼낸다. */
export type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholders<Rest> : never;

/** 문구 하나에 채울 값: 자리가 없으면 넘기지 않고, 있으면 모든 자리의 값이 있어야 한다(빠지면 컴파일 오류). */
export type StringArgs<S extends string> = [Placeholders<S>] extends [never] ? [] : [values: Record<Placeholders<S>, string | number>];

function fill(key: string, text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!(name in values)) throw new Error('문구 ' + key + '의 {' + name + '} 값이 없다');
    return String(values[name]);
  });
}

/**
 * 문구 표 하나로 부르는 함수를 만든다(부품 표 t, 앱 화면 표 say). 자리의 값은 형식이 요구하고, 실행 중에 빠지면 빈칸이나
 * '{n}' 글자를 보이는 대신 던진다(시험이 잡는다).
 */
export function createStrings<const T extends Readonly<Record<string, string>>>(table: T) {
  return <K extends keyof T & string>(key: K, ...args: StringArgs<T[K]>): string => fill(key, table[key] as string, args[0] ?? {});
}

/** 부품 문구를 부르고 {이름} 자리를 채운다. */
export const t = createStrings(STRINGS_KO);

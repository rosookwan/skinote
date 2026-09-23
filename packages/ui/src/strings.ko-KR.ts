// 화면 문구 표(ui 3-9, 기본 ko-KR). 부품은 문구를 코드에 박지 않고 이 표의 키로 부른다.
// 말투는 가게에서 쓰는 쉬운 말이다(장부 · 접수증 · 지급 · 반납 · 수납 · 미수 · 도장 · 수거 목록 · 빨리 확인 · 끝 4자리).
// fixed: 시험 · 촬영이 기대는 고정 문구(docs/42 부록 A 개정 대상). 바꾸면 CI가 알린다.

export const STRINGS_KO = {
  home: '장부',
  find: '끝 4자리',
  findTitle: '끝 4자리로 찾기',
  more: '더 보기',
  alerts: '알림',
  alertsCount: '알림 {n}건',
  manage: '관리',
  exit: '나가기',
  offline: '연결 끊김',
  pendingCount: '보냄 대기 {n}',
  sendingCount: '보내는 중 {n}',
  lastSync: '마지막 맞춤 {time}',
  now: '지금 {time}',
  nightPrep: '야간 수거 준비 · {place} {n}팀',
  page: '{page} / {total}쪽',
  pageOf: '{label} {page} / {total}쪽',
  prevPage: '이전 쪽',
  nextPage: '다음 쪽',
  continued: '(이어서)',
  nextPageHint: '다음 쪽',
  groupCount: '{done} / {total}',
  doneSteps: '끝난 일 {n}',
  moreSteps: '남은 일 {n}개 더',
  erase: '지우기',
  search: '찾기',
  call: '전화',
  moveUp: '▲',
  moveUpLabel: '위로',
  moveDown: '▼',
  moveDownLabel: '아래로',
  moveTop: '맨 위로',
  notCollected: '못 받음',
  close: '닫기',
  confirm: '확인',
  pinTitle: '빨리 확인',
  pinMore: '빨리 확인 {n}건 더',
  pinAck: '확인',
  tooNarrow: '화면을 크게 해 주세요',
  zoomReset: '확대 되돌리기',
  moved: '자리 바뀜',
  movedShort: '옮김',
  processing: '처리 중',
  pendingStamp: '보냄 대기',
  qtyMinus: '하나 빼기',
  qtyPlus: '하나 더하기',
  qtySet: '수량 설정',
  partialOnly: '일부만',
  slipTitle: '대여 접수증',
  receiptNo: '접수 번호 {no}',
  promisesMany: '약속 {n}가지',
  pickup: '받기',
  giveBack: '돌려주기',
  charged: '청구 {amount}',
  paid: '수납 {amount}',
  due: '미수 {amount}',
  dueWord: '미수',
  toCollect: '받을 돈 {amount}',
  promisedBy: '{team} 결제 예정 {amount}',
  forOthers: '다른 팀 몫 {amount}',
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
  late: '늦음',
  lateBefore: '앞쪽에 늦은 팀 {n}',
  stampTodo: '{label} 할 일',
  stampDone: '{label} 끝',
  stampPartial: '{label} {done} / {total}',
  stampPartialSome: '{label} 일부',
  partialShort: '일부',
  stampBlocked: '{label} 먼저 할 일 있음',
  stampScheduled: '{label} 예정',
  stampDelegated: '{label} 차량이 함',
  stampNa: '{label} 해당 없음',
  none: '없음',
  groupsMore: '{first} 외 {n}',
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

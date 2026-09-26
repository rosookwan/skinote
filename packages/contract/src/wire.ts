// 서버로 들어오는 본문의 엄격한 검사(work/impl-server/plan.md §5-2, D5): 명령 봉투, 조회, 기기 등록 · 로그인. 형식(TypeScript)은 실행
// 중에 없으므로 서버는 이 검사를 지난 값만 도메인 · 저장소에 넘긴다.
//   - 모르는 칸은 거절한다(오타 · 옛 앱 · 꾸민 요청이 조용히 지나가지 않게).
//   - id는 `^[A-Za-z0-9:_.-]{1,96}$`, 요청번호는 ULID, 이름은 20자 · 메모는 40자까지(제어 문자와 '<' 없음), 돈은 0 ~ 999,999,999원,
//     수량은 매장의 한 줄 한도까지, 목록은 길이를 막는다(줄 50 · 번호 100 · 팀 30).
//   - 봉투는 type · commandVersion(1) · requestId · basis · expect · dependsOn(5개까지) · payload만. 보냄 대기 명령의 칸(deviceSeq ·
//     ageMs · clockAnchor · recordedBy · replay)은 QUEUE_NOT_SUPPORTED다: 서버 모드는 온라인만이다(plan §0).
// 문제 글은 칸의 자리와 까닭만 적고 보낸 값은 적지 않는다(이름 · 전화가 기록에 남지 않게).
import { ACTION_KEYS, DEVICE_CLASS_KEYS } from './vocab.ts';
import { COMMAND_TYPES, type AnyCommandEnvelope, type CommandType, type QueryName, type QueryParams, type ViewParams } from './client.ts';
import type { ChallengeRequest, EnrollRequest, LoginRequest, OpenEnrollRequest, StaffListRequest } from './auth.ts';

// ── 작은 검사 말(DSL) ──────────────────────────────────────────────────

/** 검사 하나: 틀리면 out에 '자리: 까닭'을 더한다. */
export type Checker = (value: unknown, path: string, out: string[]) => void;
export interface Rule {
  readonly check: Checker;
  /** 칸이 없어도 된다(obj 안에서만 뜻이 있다). */
  readonly optional: boolean;
}

/** 한 본문에서 모으는 문제 수의 끝(긴 목록이 문제를 끝없이 쌓지 않게). */
const MAX_PROBLEMS = 20;

const rule = (check: Checker, optional = false): Rule => ({ check, optional });
const add = (out: string[], path: string, message: string) => {
  if (out.length < MAX_PROBLEMS) out.push((path || '본문') + ': ' + message);
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 없어도 되는 칸. */
export const opt = (r: Rule): Rule => rule(r.check, true);

/** null이어도 되는 값. */
export const nullable = (r: Rule): Rule => rule((v, p, out) => { if (v !== null) r.check(v, p, out); }, r.optional);

const CONTROL = /\p{Cc}/u;

/** 글. text: 제어 문자 · '<'가 없는 사람의 글(이름 · 메모). 길이는 글자(코드 포인트) 수다. */
export function str(o: { min?: number; max: number; pattern?: RegExp; text?: boolean }): Rule {
  return rule((v, p, out) => {
    if (typeof v !== 'string') return add(out, p, '글이어야 한다');
    const length = [...v].length;
    if (length < (o.min ?? 0)) return add(out, p, (o.min ?? 0) + '자 이상이어야 한다');
    if (length > o.max) return add(out, p, o.max + '자까지다');
    if (o.text && (CONTROL.test(v) || v.includes('<'))) return add(out, p, '쓸 수 없는 글자가 있다');
    if (o.pattern && !o.pattern.test(v)) add(out, p, '모양이 틀렸다');
  });
}

/** 정수(범위 안). */
export function int(min: number, max: number): Rule {
  return rule((v, p, out) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) return add(out, p, '정수여야 한다');
    if (v < min || v > max) add(out, p, min + ' ~ ' + max + ' 사이여야 한다');
  });
}

/** 참 · 거짓. */
export const bool = (): Rule => rule((v, p, out) => { if (typeof v !== 'boolean') add(out, p, '참 · 거짓이어야 한다'); });

/** 정해진 글 가운데 하나. */
export function lit(...values: readonly string[]): Rule {
  return rule((v, p, out) => { if (typeof v !== 'string' || !values.includes(v)) add(out, p, '정해진 값이 아니다'); });
}

/** 목록(길이를 막는다). */
export function arr(item: Rule, o: { min?: number; max: number }): Rule {
  return rule((v, p, out) => {
    if (!Array.isArray(v)) return add(out, p, '목록이어야 한다');
    if (v.length < (o.min ?? 0)) return add(out, p, (o.min ?? 0) + '개 이상이어야 한다');
    if (v.length > o.max) return add(out, p, o.max + '개까지다');
    v.forEach((x, i) => item.check(x, p + '[' + i + ']', out));
  });
}

/** 객체(모르는 칸은 거절, 빠진 칸은 선택 칸이 아니면 거절). */
export function obj(shape: Readonly<Record<string, Rule>>): Rule {
  return rule((v, p, out) => {
    if (!isObject(v)) return add(out, p, '객체여야 한다');
    for (const key of Object.keys(v)) if (!Object.hasOwn(shape, key)) add(out, p ? p + '.' + key : key, '모르는 칸');
    for (const [key, r] of Object.entries(shape)) {
      const here = p ? p + '.' + key : key;
      if (v[key] === undefined) {
        if (!r.optional) add(out, here, '빠진 칸');
        continue;
      }
      r.check(v[key], here, out);
    }
  });
}

/** 열쇠 → 값 객체(돈통 · 팀마다의 금액, 줄마다의 수량). */
export function rec(key: RegExp, value: Rule, maxKeys: number): Rule {
  return rule((v, p, out) => {
    if (!isObject(v)) return add(out, p, '객체여야 한다');
    const keys = Object.keys(v);
    if (keys.length > maxKeys) return add(out, p, maxKeys + '개까지다');
    for (const k of keys) {
      if (!key.test(k)) add(out, p + '.' + '?', '열쇠 모양이 틀렸다');
      else value.check(v[k], p + '.' + k, out);
    }
  });
}

/** 구분 칸(tag)의 값으로 모양을 고른다({ mode: 'store' } | { mode: 'vehicle', placeKey }). */
export function union(tag: string, cases: Readonly<Record<string, Rule>>): Rule {
  return rule((v, p, out) => {
    if (!isObject(v)) return add(out, p, '객체여야 한다');
    const kind = v[tag];
    const r = typeof kind === 'string' && Object.hasOwn(cases, kind) ? cases[kind] : undefined;
    if (!r) return add(out, p ? p + '.' + tag : tag, '정해진 값이 아니다');
    r.check(v, p, out);
  });
}

/** 여러 모양 중 하나(앞에서부터, 처음 맞는 것). 모두 틀리면 한 줄. */
export function anyOf(...rules: Rule[]): Rule {
  return rule((v, p, out) => {
    for (const r of rules) {
      const probe: string[] = [];
      r.check(v, p, probe);
      if (probe.length === 0) return;
    }
    add(out, p, '맞는 모양이 없다');
  });
}

/** 규칙으로 값을 본다: 문제 목록(없으면 빈 목록). */
export function problemsOf(r: Rule, value: unknown, path = ''): string[] {
  const out: string[] = [];
  r.check(value, path, out);
  return out;
}

// ── 한도와 공통 칸 ─────────────────────────────────────────────────────
// 규칙 값은 처음 쓸 때 만든다(common()): 모듈을 읽기만 하는 체험판 묶음에 검사 코드가 남지 않게(빌드의 나무 흔들기).

export const WIRE_LIMITS = /* @__PURE__ */ Object.freeze({
  /** 이름(대표자, 새 접수 화면의 NAME_MAX). */
  nameMax: 20,
  /** 메모 · 사유 직접 입력(NOTE_MAX). */
  noteMax: 40,
  /** 돈(원). */
  money: 999_999_999,
  /** 한 줄의 수량(매장 설정 max_line_quantity를 모를 때의 끝). 서버는 명령에 매장 한도를 넘긴다. */
  quantity: 999,
  /** 인원. */
  party: 999,
  lines: 50,
  assetIds: 100,
  orderIds: 30,
  dependsOn: 5,
  ruleChanges: 20,
});

/** id(접수 · 줄 · 업무 · 번호 · 차량 · 알림 · 인계 · 돈통). */
export const ID_PATTERN = /^[A-Za-z0-9:_.-]{1,96}$/;
/** 매장 목록의 key(상품 · 규격 · 수단 · 칸 · 할인 · 장소 · 반납 타임 · 사유 · 규칙). 규격 key는 한글일 수 있다('소' · '어른'). */
export const KEY_PATTERN = /^[\p{L}\p{N}_.:-]{1,64}$/u;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HHMM = /^\d{2}:\d{2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const EPOCH = /^[A-Za-z0-9_.:-]{1,64}$/;
/** 운영 규칙 바꿈의 key('<표>:<행 key>:<열>', 'shops::business_day_cutoff'). */
const RULE_KEY = /^[a-z_]+:[\p{L}\p{N}_.-]{0,64}:[a-z_]+$/u;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** 모든 검사가 함께 쓰는 칸(처음 부를 때 한 번 만든다). */
function makeCommon() {
  const id = str({ max: 96, pattern: ID_PATTERN });
  const key = str({ max: 64, pattern: KEY_PATTERN });
  const requestId = str({ max: 26, pattern: ULID });
  const date = str({ max: 10, pattern: DATE });
  const money = int(0, WIRE_LIMITS.money);
  const signedMoney = int(-WIRE_LIMITS.money, WIRE_LIMITS.money);
  return {
    id, key, requestId, date, money, signedMoney,
    isoTime: str({ max: 40, pattern: ISO_TIME }),
    name: str({ max: WIRE_LIMITS.nameMax, text: true }),
    note: str({ max: WIRE_LIMITS.noteMax, text: true }),
    day: anyOf(lit('today', 'tomorrow'), date),
    flag: bool(),
    deviceClass: lit(...DEVICE_CLASS_KEYS),
  };
}
let commonRules: ReturnType<typeof makeCommon> | undefined;
const common = () => (commonRules ??= makeCommon());

/** 수량이 들어가는 칸들(매장 한도로 만든다). */
function shapes(maxQuantity: number) {
  const { id, key, day, name, note, money, signedMoney, flag: bool } = common();
  const quantity = int(0, maxQuantity);
  const lineUnits = obj({ lineId: id, quantity, assetIds: opt(arr(id, { max: WIRE_LIMITS.assetIds })) });
  const lines = arr(lineUnits, { max: WIRE_LIMITS.lines });
  const slot = obj({ day, slotKey: key });
  const place = union('mode', { store: obj({ mode: lit('store') }), vehicle: obj({ mode: lit('vehicle'), placeKey: key }) });
  const promise = obj({
    mode: lit('store', 'vehicle'), immediate: opt(bool), slot: opt(slot), time: opt(str({ max: 5, pattern: HHMM })), day: opt(day),
    placeKey: opt(key), vehicleId: opt(id),
  });
  const draft = obj({
    channel: lit('walk_in', 'phone'),
    leader: obj({ name, phone: str({ max: 15, pattern: /^\d*$/ }), party: int(0, WIRE_LIMITS.party) }),
    items: arr(obj({ productKey: key, variantKey: opt(key), quantity }), { max: WIRE_LIMITS.lines }),
    pickup: promise,
    giveBack: promise,
    returnSet: opt(obj({ time: opt(bool), place: opt(bool) })),
  });
  const choice = obj({ sectionKey: key, methodKey: key, discountKey: opt(key), payerOrderId: opt(id) });
  const ruleChange = obj({ key: str({ max: 160, pattern: RULE_KEY }), value: anyOf(str({ max: 40, text: true }), int(-WIRE_LIMITS.money, WIRE_LIMITS.money), bool, rule((v, p, out) => { if (v !== null) add(out, p, 'null이어야 한다'); })) });
  const closingCount = obj({ drawerId: id, countedAmount: money, expectedAmount: opt(signedMoney), reasonKey: opt(key), reasonNote: opt(note) });
  return { quantity, lineUnits, lines, slot, place, promise, draft, choice, ruleChange, closingCount };
}

// ── 명령 본문 ───────────────────────────────────────────────────────────

const commandCache = new Map<number, Record<CommandType, Rule>>();

function commandRules(maxQuantity: number): Record<CommandType, Rule> {
  const cached = commandCache.get(maxQuantity);
  if (cached) return cached;
  const s = shapes(maxQuantity);
  const { id, key, date, money, note, isoTime } = common();
  const byTask = obj({ taskId: id, lines: s.lines });
  const byOrder = obj({ orderId: id, lines: s.lines });
  const rules: Record<CommandType, Rule> = {
    'stock.issue': byOrder,
    'stock.direct_return': byOrder,
    'stock.load': byTask,
    'stock.collect': byTask,
    'stock.deliver': byTask,
    'stock.receive': obj({ vehicleId: id, taskIds: arr(id, { max: 200 }), lines: opt(s.lines) }),
    'payment.take': obj({
      orderIds: arr(id, { min: 1, max: WIRE_LIMITS.orderIds }),
      amount: money,
      methodKey: key,
      allocations: opt(arr(obj({
        orderId: id, amount: money, lines: opt(arr(obj({ lineId: id, quantity: s.quantity, amount: money }), { max: WIRE_LIMITS.lines })),
      }), { max: WIRE_LIMITS.orderIds })),
      purposeKey: opt(lit('multi_order', 'split_by_items', 'intake_confirm')),
      payerOrderId: opt(id),
    }),
    'payment_promise.set': obj({ orderId: id, payerOrderId: nullable(id), lineIds: opt(arr(id, { max: WIRE_LIMITS.lines })) }),
    'promise.change': obj({
      orderId: id, kind: lit('pickup', 'return'), lines: arr(obj({ lineId: id, quantity: s.quantity }), { max: WIRE_LIMITS.lines }), promise: s.promise,
    }),
    'order.create': obj({ draft: s.draft, choices: arr(s.choice, { max: 10 }), payerOrderId: nullable(id) }),
    'deposit.take': obj({ orderId: id, ruleKey: key, lines: s.lines, amount: money, methodKey: key }),
    'deposit.return': obj({ orderId: id, ruleKey: key, lines: s.lines, amount: money, refundMethodKey: key }),
    'field.collect': obj({ taskId: id, orderId: id, amount: money, methodKey: key }),
    'field.add_ticket': obj({
      taskId: id, orderId: id, productKey: key, quantity: s.quantity, assetIds: arr(id, { max: WIRE_LIMITS.assetIds }), amount: money,
      deposit: opt(obj({ ruleKey: key, amount: money })),
    }),
    'field.deposit_return': obj({ taskId: id, orderId: id, ruleKey: key, lines: s.lines, amount: money }),
    'cash.transfer': obj({ vehicleId: id, amount: money }),
    'cash.transfer_confirm': obj({ transferId: id, countedAmount: money, reasonKey: opt(key), reasonNote: opt(note) }),
    'closing.close': obj({
      date, drawerCounts: arr(s.closingCount, { max: 20 }), deferredTransferIds: arr(id, { max: 50 }), overrideReason: opt(note),
    }),
    'setting.set': obj({ changes: arr(s.ruleChange, { max: WIRE_LIMITS.ruleChanges }) }),
    'route.move': obj({ taskId: id, anchorTaskId: nullable(id), position: lit('before', 'after', 'top') }),
    'route.reset': obj({ vehicleId: id, date }),
    'task.pin': obj({ taskId: id, note: opt(note) }),
    'task.unpin': obj({ pinId: id }),
    'task.visit': obj({ taskId: id, outcomeKey: key, retry: opt(obj({ date, at: opt(isoTime) })) }),
    'notification.ack': obj({ notificationId: id }),
  };
  if (commandCache.size > 16) commandCache.clear();
  commandCache.set(maxQuantity, rules);
  return rules;
}

/** 돈 결정의 바탕(Expect). */
function expectRule(): Rule {
  const { signedMoney } = common();
  return obj({
    dueAmount: opt(signedMoney),
    refundAmount: opt(signedMoney),
    expectedCash: opt(rec(ID_PATTERN, signedMoney, 20)),
    depositHeld: opt(signedMoney),
    dueByOrder: opt(rec(ID_PATTERN, signedMoney, WIRE_LIMITS.orderIds)),
    quoteHash: opt(str({ max: 4000, text: true })),
  });
}

/** 보냄 대기 명령만의 칸(서버 모드는 온라인만, plan §0 · §5-2). */
export const QUEUE_FIELDS = ['deviceSeq', 'ageMs', 'clockAnchor', 'recordedBy', 'replay'] as const;

const ENVELOPE_KEYS = new Set(['type', 'commandVersion', 'requestId', 'basis', 'expect', 'dependsOn', 'payload']);

export type WireFailure<C extends string> = { ok: false; code: C; problems: string[] };

export interface EnvelopeOptions {
  /** 한 줄의 수량 한도(매장 설정 max_line_quantity). 없으면 WIRE_LIMITS.quantity. */
  maxQuantity?: number;
}

/**
 * 명령 봉투 검사. 통과하면 같은 값을 AnyCommandEnvelope로 돌려준다(복사하지 않는다: JSON에서 막 읽은 값이다).
 * 실패: QUEUE_NOT_SUPPORTED(보냄 대기 칸), UNKNOWN_COMMAND(모르는 명령), BAD_INPUT(그 밖의 모양).
 */
export function parseEnvelope(value: unknown, options: EnvelopeOptions = {}):
  | { ok: true; envelope: AnyCommandEnvelope }
  | WireFailure<'QUEUE_NOT_SUPPORTED' | 'UNKNOWN_COMMAND' | 'BAD_INPUT'> {
  if (!isObject(value)) return { ok: false, code: 'BAD_INPUT', problems: ['본문: 객체여야 한다'] };
  const queued = QUEUE_FIELDS.filter((k) => value[k] !== undefined);
  if (queued.length) return { ok: false, code: 'QUEUE_NOT_SUPPORTED', problems: queued.map((k) => k + ': 보냄 대기 명령은 받지 않는다') };
  const out: string[] = [];
  for (const k of Object.keys(value)) if (!ENVELOPE_KEYS.has(k)) add(out, k, '모르는 칸');
  const type = value.type;
  if (typeof type !== 'string' || !(COMMAND_TYPES as readonly string[]).includes(type)) {
    return { ok: false, code: 'UNKNOWN_COMMAND', problems: ['type: 모르는 명령'] };
  }
  const { requestId } = common();
  if (value.commandVersion !== 1) add(out, 'commandVersion', '1이어야 한다');
  requestId.check(value.requestId, 'requestId', out);
  obj({ epoch: str({ max: 64, pattern: EPOCH }), rev: int(0, Number.MAX_SAFE_INTEGER) }).check(value.basis, 'basis', out);
  if (value.expect !== undefined) expectRule().check(value.expect, 'expect', out);
  if (value.dependsOn !== undefined) arr(requestId, { max: WIRE_LIMITS.dependsOn }).check(value.dependsOn, 'dependsOn', out);
  const payload = commandRules(options.maxQuantity ?? WIRE_LIMITS.quantity)[type as CommandType];
  if (value.payload === undefined) add(out, 'payload', '빠진 칸');
  else payload.check(value.payload, 'payload', out);
  if (out.length) return { ok: false, code: 'BAD_INPUT', problems: out };
  return { ok: true, envelope: value as unknown as AnyCommandEnvelope };
}

// ── 조회 ────────────────────────────────────────────────────────────────

/** 장부 화면(ledgerView)의 화면 key. */
export const LEDGER_VIEW_KEYS = ['day_ledger', 'collection_list', 'delivery_list'] as const;
export type LedgerViewKey = (typeof LEDGER_VIEW_KEYS)[number];

const queryCache = new Map<number, Record<QueryName, Rule>>();

function queryRules(maxQuantity: number): Record<QueryName, Rule> {
  const cached = queryCache.get(maxQuantity);
  if (cached) return cached;
  const s = shapes(maxQuantity);
  const { id, key, date, money, note, requestId, deviceClass } = common();
  const ids = (max: number) => arr(id, { max });
  const rules: Record<QueryName, Rule> = {
    orderSlip: obj({ orderId: id, deviceClass: opt(deviceClass) }),
    findLast4: obj({ last4: str({ max: 4, pattern: /^\d{4}$/ }), date: opt(date) }),
    confirmDraft: obj({
      orderId: opt(id), draftId: opt(id), actionKey: lit(...ACTION_KEYS), lineIds: opt(ids(WIRE_LIMITS.lines)), taskId: opt(id), vehicleId: opt(id),
      picked: opt(s.lines),
    }),
    reviewList: obj({ scope: opt(lit('mine', 'all')) }),
    vehicleLoad: obj({ vehicleId: id }),
    returnSheet: obj({ orderId: id, lineIds: opt(ids(WIRE_LIMITS.lines)), picked: opt(s.lines), refundMethodKey: opt(key) }),
    promiseSheet: obj({
      orderId: id, quantities: opt(rec(ID_PATTERN, s.quantity, WIRE_LIMITS.lines)), slot: opt(s.slot), place: opt(s.place), vehicleId: opt(id),
    }),
    orderDraft: obj({ draft: s.draft, openKindKey: opt(key), openVariantKey: opt(key) }),
    checkoutSheet: obj({
      draft: s.draft, choices: opt(arr(s.choice, { max: 10 })), payerOrderId: opt(nullable(id)), foundPayerIds: opt(ids(WIRE_LIMITS.orderIds)),
    }),
    groupPaySheet: obj({
      orderId: id, tabKey: opt(lit('group', 'unpaid')), selected: opt(ids(WIRE_LIMITS.orderIds)),
      parts: opt(arr(obj({ orderId: id, lines: s.lines }), { max: WIRE_LIMITS.orderIds })), methodKey: opt(key), added: opt(ids(WIRE_LIMITS.orderIds)),
    }),
    partialPaySheet: obj({ orderId: id, payerOrderId: id, lines: opt(s.lines) }),
    closingSheet: obj({
      date: opt(date), counts: opt(arr(s.closingCount, { max: 20 })), deferredTransferIds: opt(ids(50)),
      check: opt(obj({ key: id, countedAmount: opt(money), reasonKey: opt(key), reasonNote: opt(note) })),
    }),
    taskSheet: obj({ taskId: id, deviceClass: opt(deviceClass) }),
    fieldPaySheet: obj({ taskId: id, amount: opt(money), methodKey: opt(key), afterTicket: opt(requestId) }),
    addTicketSheet: obj({ taskId: id, productKey: opt(key), quantity: opt(s.quantity) }),
    shopRules: obj({ changes: opt(arr(s.ruleChange, { max: WIRE_LIMITS.ruleChanges })) }),
  };
  if (queryCache.size > 16) queryCache.clear();
  queryCache.set(maxQuantity, rules);
  return rules;
}

/** 조회 이름(권한 표 · 시험이 쓴다). queryRules가 모든 이름의 규칙을 가지는지는 형식(Record<QueryName, Rule>)이 본다. */
export const WIRE_QUERY_NAMES = [
  'orderSlip', 'findLast4', 'confirmDraft', 'reviewList', 'vehicleLoad', 'returnSheet', 'promiseSheet', 'orderDraft', 'checkoutSheet', 'groupPaySheet',
  'partialPaySheet', 'closingSheet', 'taskSheet', 'fieldPaySheet', 'addTicketSheet', 'shopRules',
] as const satisfies readonly QueryName[];
// 목록이 모든 조회를 담았는지 형식으로 확인한다(조회를 더하고 목록을 잊으면 컴파일 오류).
const QUERY_NAMES_COMPLETE: [Exclude<QueryName, (typeof WIRE_QUERY_NAMES)[number]>] extends [never] ? true : never = true;
void QUERY_NAMES_COMPLETE;
const QUERY_NAMES: readonly string[] = WIRE_QUERY_NAMES;

/** 장부 화면 인자(viewKey를 안에 둔다). */
function viewParamsRule(): Rule {
  const { id, key, date, deviceClass } = common();
  return obj({ viewKey: lit(...LEDGER_VIEW_KEYS), date: opt(date), tabKey: opt(key), vehicleId: opt(id), deviceClass: opt(deviceClass) });
}

/** 검사를 지난 조회. */
export type WireQuery =
  | { name: 'config' }
  | { name: 'ledgerView'; viewKey: LedgerViewKey; params: ViewParams }
  | { [Q in QueryName]: { name: Q; params: QueryParams[Q] } }[QueryName];

/**
 * 조회 본문 `{ name, params }` 검사. ledgerView는 params 안에 viewKey를 둔다(`{ viewKey: 'day_ledger', date? … }`).
 * 실패: UNKNOWN_QUERY(모르는 이름), UNKNOWN_VIEW(모르는 화면), BAD_INPUT(그 밖의 모양).
 */
export function parseQuery(value: unknown, options: EnvelopeOptions = {}):
  | { ok: true; query: WireQuery }
  | WireFailure<'UNKNOWN_QUERY' | 'UNKNOWN_VIEW' | 'BAD_INPUT'> {
  if (!isObject(value)) return { ok: false, code: 'BAD_INPUT', problems: ['본문: 객체여야 한다'] };
  const out: string[] = [];
  for (const k of Object.keys(value)) if (k !== 'name' && k !== 'params') add(out, k, '모르는 칸');
  const queryName = value.name;
  const params = value.params ?? {};
  if (queryName === 'config') {
    obj({}).check(params, 'params', out);
    return out.length ? { ok: false, code: 'BAD_INPUT', problems: out } : { ok: true, query: { name: 'config' } };
  }
  if (queryName === 'ledgerView') {
    if (isObject(params) && typeof params.viewKey === 'string' && !(LEDGER_VIEW_KEYS as readonly string[]).includes(params.viewKey)) {
      return { ok: false, code: 'UNKNOWN_VIEW', problems: ['params.viewKey: 모르는 화면'] };
    }
    viewParamsRule().check(params, 'params', out);
    if (out.length) return { ok: false, code: 'BAD_INPUT', problems: out };
    const { viewKey, ...rest } = params as { viewKey: LedgerViewKey } & ViewParams;
    return { ok: true, query: { name: 'ledgerView', viewKey, params: rest } };
  }
  if (typeof queryName !== 'string' || !QUERY_NAMES.includes(queryName)) {
    return { ok: false, code: 'UNKNOWN_QUERY', problems: ['name: 모르는 조회'] };
  }
  queryRules(options.maxQuantity ?? WIRE_LIMITS.quantity)[queryName as QueryName].check(params, 'params', out);
  if (out.length) return { ok: false, code: 'BAD_INPUT', problems: out };
  return { ok: true, query: { name: queryName, params } as WireQuery };
}

// ── 기기 등록 · 로그인 ────────────────────────────────────────────────────

const b64url = (length: number) => str({ min: length, max: length, pattern: B64URL });

/** 기기 등록 · 로그인 본문 규칙. P-256 공개 열쇠(JWK)의 x · y는 32바이트(base64url 43자), 비밀 열쇠(d)는 모르는 칸이라 거절된다. */
function authRules() {
  const { id, requestId, flag } = common();
  const publicKey = obj({
    kty: lit('EC'), crv: lit('P-256'), x: b64url(43), y: b64url(43), ext: opt(flag), key_ops: opt(arr(lit('verify'), { max: 1 })),
  });
  const agent = str({ max: 80, text: true });
  const driver = (kind: string) => obj({ kind: lit(kind), vehicleId: id, publicKey, agent });
  return {
    enroll: obj({ code: str({ max: 12, pattern: /^\d{12}$/ }), publicKey, agent }),
    // 열린 등록: 카운터는 차량 칸이 없고(있으면 모르는 칸), 기사 기기는 차량 칸이 꼭 있다.
    openEnroll: union('kind', { pos: obj({ kind: lit('pos'), publicKey, agent }), driver_tablet: driver('driver_tablet'), driver_phone: driver('driver_phone') }),
    challenge: obj({ deviceId: requestId }),
    staff: obj({ deviceId: requestId, nonce: b64url(43), signature: b64url(86) }),
    // 열린 등록 기기 놓기: staff와 같은 서명(한 번 값 · 기기 열쇠).
    openRelease: obj({ deviceId: requestId, nonce: b64url(43), signature: b64url(86) }),
    login: obj({ ticket: b64url(43), staffId: requestId, pin: str({ min: 4, max: 6, pattern: /^\d{4,6}$/ }) }),
  };
}
let authRuleCache: ReturnType<typeof authRules> | undefined;

export interface AuthBodies {
  enroll: EnrollRequest;
  openEnroll: OpenEnrollRequest;
  challenge: ChallengeRequest;
  staff: StaffListRequest;
  openRelease: StaffListRequest;
  login: LoginRequest;
}

/** 기기 등록 · 한 번 값 · 직원 목록 · 로그인 본문 검사. 비밀번호 · 등록 번호는 문제 글에 싣지 않는다. */
export function parseAuthBody<K extends keyof AuthBodies>(kind: K, value: unknown): { ok: true; body: AuthBodies[K] } | WireFailure<'BAD_INPUT'> {
  const out = problemsOf((authRuleCache ??= authRules())[kind], value);
  return out.length ? { ok: false, code: 'BAD_INPUT', problems: out } : { ok: true, body: value as AuthBodies[K] };
}

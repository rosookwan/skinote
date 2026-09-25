// V8 관리 · 매장 설정 · 운영 규칙(spec 3-9, ui 6-9, catalog 2 · 3 · 11-1, data-model 3-3 · 4-4)의 읽기 모델(shopRules)과 저장(setting.set).
// 체험 전용(LocalClient가 오면 폴더째 없어진다). 카드는 규칙 행에서 나온다(ADR-05): 반납 정책을 매장이 고르는 품목 종류마다 `○○ 반납`
// (체험 자료는 리프트권 하나), 보증금 규칙마다 `○○ 보증금`(체험 자료는 리프트권 보증금 하나), 그리고 매장 설정 셋(리프트권 결제 · 당일 취소
// 환불 · 영업일 기준 시각). 화면은 누른 버튼의 key를 바꿈(RuleChange)으로 모아 다시 묻고, 여기서 카드 · 바뀐 곳(전 → 후) · 바닥줄 ·
// 주 버튼 · 보낼 명령 · 거절 까닭을 새로 쓴다. 저장은 다음 기록부터다: 만든 줄 · 맡은 보증금은 만들 때 복사한 값을 쓰고(seed
// liftReturnable · FxDeposit), 기준 시각은 바꾼 시각 전의 기록에 옛 기준을 남긴다(time.ts shopCutoff).
import {
  ruleKey, type ChoiceOption, type CommandEnvelope, type RichText, type RuleCard, type RuleChange, type RuleChangeLine, type RuleInput,
  type RuleRow, type ShopRulesParams, type ShopRulesView,
} from '@skinote/contract';
import { KINDS, productOf } from './catalog.ts';
import type { FxDepositRule, FxShopRules, FxState } from './model.ts';
import { done, nothing, rejected, type Result } from './result.ts';
import { SHOP_RULES } from './seed.ts';
import { businessDateOf, hm, iso, kstAt, kstDate, minutesOf } from './time.ts';
import type { ViewContext } from './views.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';
const UNKNOWN = '체험판 미지원';

/** 운영 규칙의 값들(카드가 보이고 바꾸는 것만). */
export interface RuleValues {
  returnPolicy: FxShopRules['liftReturnPolicy'];
  depositOn: boolean;
  depositAmount: number;
  timing: FxDepositRule['timing'];
  unreturned: FxDepositRule['unreturned'];
  lossAmount: number;
  prepay: FxShopRules['prepaymentMode'];
  prepayAmount: number;
  refund: FxShopRules['sameDayCancelRefund'];
  cutoff: string;
}

/** 분실 값 · 예약금의 시작 값(spec 3-9 `1매 35,000원 ›` · `팀당 50,000원 ›`). */
const DEFAULT_LOSS = 35_000;
const DEFAULT_PREPAY = 50_000;
/** 금액 숫자판이 받는 범위(체험 값). 영업일 기준 시각은 00:00 ~ 11:59(spec 3-9). */
const AMOUNT = { min: 100, max: 1_000_000 };
const PREPAY_AMOUNT = { min: 1_000, max: 10_000_000 };
const CUTOFF = { min: 0, max: 11 * 60 + 59 };
const CUTOFF_PRESETS = ['00:00', '03:00', '06:00'] as const;
const CUSTOM = 'custom';

// ── 선택지(글은 문구 표 3-11) ───────────────────────────────────────────

interface Choice<K extends string> {
  key: K;
  label: string;
  secondLine?: string;
  short?: string;
  /** 저장 확인 창의 전 → 후 글(두 줄 버튼은 한 줄로). */
  word?: string;
}

const RETURN_POLICY: readonly Choice<RuleValues['returnPolicy']>[] = [
  { key: 'required', label: '반납 필수' },
  { key: 'optional', label: '반납 선택 · 반납 시 기록' },
];
const USE: readonly Choice<'true' | 'false'>[] = [{ key: 'true', label: '사용' }, { key: 'false', label: '미사용' }];
const TIMING: readonly Choice<RuleValues['timing']>[] = [
  { key: 'at_intake', label: '접수 시', secondLine: '미입금: 지급 시', word: '접수 시 · 미입금: 지급 시' },
  { key: 'at_issue', label: '지급 시' },
];
const UNRETURNED: readonly Choice<RuleValues['unreturned']>[] = [
  { key: 'keep', label: '보증금 몰수' },
  { key: 'charge_loss', label: '분실금 청구', secondLine: '보증금 공제', short: '차액 청구', word: '분실금 청구(보증금 공제)' },
];
const PREPAY: readonly Choice<RuleValues['prepay']>[] = [
  { key: 'full_lift_ticket', label: '선입금 전액' },
  { key: 'fixed_amount', label: '예약금' },
  { key: 'none', label: '당일 결제' },
];
const REFUND: readonly Choice<RuleValues['refund']>[] = [{ key: 'refund', label: '환불' }, { key: 'no_refund', label: '환불 없음' }];

const wordOf = <K extends string>(list: readonly Choice<K>[], key: K) => { const c = list.find((x) => x.key === key); return c?.word ?? c?.label ?? key; };

// ── 규칙 행 · 바꿈 key ────────────────────────────────────────────────

/** 반납 정책을 매장이 고르는 품목 종류(체험 자료: 리프트권 칸의 종류). 장비는 늘 반납이라 카드가 없다. */
const policyKinds = () => KINDS.filter((k) => k.products.some((p) => productOf(p)?.section === 'lift'));

/** 이 매장의 보증금 규칙(미사용으로 바꾼 동안에는 둔 값, 없으면 시작 값). */
const depositRule = (settings: FxShopRules): FxDepositRule => settings.liftDeposit ?? settings.liftDepositOff ?? SHOP_RULES.liftDeposit!;

/** 카드 · 줄의 바꿈 key(RuleChange.key, '<표>:<행>:<열>'). */
export function ruleKeys(settings: FxShopRules) {
  const rule = depositRule(settings).key;
  const kind = policyKinds()[0]?.key ?? 'lift';
  // schema.sql의 표 · 열(contract ruleKey): 보증금 사용은 deposit_rules.active(0 · 1), 선입금 · 환불은 shop_settings JSON 값의 칸.
  return {
    returnPolicy: ruleKey('item_kinds', kind, 'return_policy_key'),
    depositOn: ruleKey('deposit_rules', rule, 'active'),
    depositAmount: ruleKey('deposit_rules', rule, 'unit_amount'),
    timing: ruleKey('deposit_rules', rule, 'timing_key'),
    unreturned: ruleKey('deposit_rules', rule, 'unreturned_key'),
    lossAmount: ruleKey('deposit_rules', rule, 'loss_amount'),
    prepay: ruleKey('shop_settings', 'prepayment_mode', 'mode'),
    prepayAmount: ruleKey('shop_settings', 'prepayment_mode', 'amount'),
    refund: ruleKey('shop_settings', 'same_day_cancel_refund_default', 'decision'),
    cutoff: ruleKey('shops', '', 'business_day_cutoff'),
  } satisfies Record<keyof RuleValues, string>;
}

/** 저장된 운영 규칙의 값. */
export function ruleValues(settings: FxShopRules): RuleValues {
  const rule = depositRule(settings);
  return {
    returnPolicy: settings.liftReturnPolicy,
    depositOn: settings.liftDeposit !== null,
    depositAmount: rule.unitAmount,
    timing: rule.timing,
    unreturned: rule.unreturned,
    lossAmount: rule.lossAmount ?? DEFAULT_LOSS,
    prepay: settings.prepaymentMode,
    prepayAmount: settings.prepaymentAmount ?? DEFAULT_PREPAY,
    refund: settings.sameDayCancelRefund,
    cutoff: settings.businessDayCutoff,
  };
}

const oneOf = <K extends string>(list: readonly Choice<K>[], value: RuleChange['value']): K | undefined =>
  list.find((c) => c.key === value)?.key;
const amountIn = (range: { min: number; max: number }, value: RuleChange['value']): number | undefined => {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= range.min && n <= range.max ? n : undefined;
};
const cutoffIn = (value: RuleChange['value']): string | undefined => {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return undefined;
  const [h = 0, m = 0] = value.split(':').map(Number);
  const minutes = h * 60 + m;
  return m < 60 && minutes >= CUTOFF.min && minutes <= CUTOFF.max ? value : undefined;
};

/** 바꿈 하나를 값에 넣는다. 모르는 key · 받지 않는 값이면 false(값은 그대로). */
function applyOne(values: RuleValues, keys: ReturnType<typeof ruleKeys>, change: RuleChange): boolean {
  const set = <F extends keyof RuleValues>(field: F, value: RuleValues[F] | undefined) => {
    if (value === undefined) return false;
    values[field] = value;
    return true;
  };
  switch (change.key) {
    case keys.returnPolicy: return set('returnPolicy', oneOf(RETURN_POLICY, change.value));
    // deposit_rules.active는 INTEGER 0 · 1(버튼 값 RuleRow.values). 옛 초안의 참 · 거짓도 받는다.
    case keys.depositOn: return set('depositOn', change.value === 1 || change.value === true ? true : change.value === 0 || change.value === false ? false : undefined);
    case keys.depositAmount: return set('depositAmount', amountIn(AMOUNT, change.value));
    case keys.timing: return set('timing', oneOf(TIMING, change.value));
    case keys.unreturned: return set('unreturned', oneOf(UNRETURNED, change.value));
    case keys.lossAmount: return set('lossAmount', amountIn(AMOUNT, change.value));
    case keys.prepay: return set('prepay', oneOf(PREPAY, change.value));
    case keys.prepayAmount: return set('prepayAmount', amountIn(PREPAY_AMOUNT, change.value));
    case keys.refund: return set('refund', oneOf(REFUND, change.value));
    case keys.cutoff: return set('cutoff', cutoffIn(change.value));
    default: return false;
  }
}

/** 저장된 값에 화면의 바꿈을 차례로 넣은 값. 받지 않은 바꿈(모르는 key · 범위 밖)은 invalid로 알린다. */
export function draftValues(settings: FxShopRules, changes: readonly RuleChange[] = []): { values: RuleValues; invalid: RuleChange[] } {
  const keys = ruleKeys(settings);
  const values = ruleValues(settings);
  const invalid = changes.filter((c) => !applyOne(values, keys, c));
  return { values, invalid };
}

/** 줄이 보이는지(보증금 미사용이면 입금 시점 · 미반납 시 · 금액 줄이 없고, 분실 값은 분실금 청구일 때만, 예약금은 예약금일 때만). */
const visible: Record<keyof RuleValues, (v: RuleValues) => boolean> = {
  returnPolicy: () => true,
  depositOn: () => true,
  depositAmount: (v) => v.depositOn,
  timing: (v) => v.depositOn,
  unreturned: (v) => v.depositOn,
  lossAmount: (v) => v.depositOn && v.unreturned === 'charge_loss',
  prepay: () => true,
  prepayAmount: (v) => v.prepay === 'fixed_amount',
  refund: () => true,
  cutoff: () => true,
};

const ORDER: readonly (keyof RuleValues)[] = ['returnPolicy', 'depositOn', 'depositAmount', 'timing', 'unreturned', 'lossAmount', 'prepay', 'prepayAmount', 'refund', 'cutoff'];

/** 카드 key(바뀐 카드의 `변경됨`). */
const CARD_OF: Record<keyof RuleValues, 'return' | 'deposit' | 'prepay' | 'refund' | 'cutoff'> = {
  returnPolicy: 'return', depositOn: 'deposit', depositAmount: 'deposit', timing: 'deposit', unreturned: 'deposit', lossAmount: 'deposit',
  prepay: 'prepay', prepayAmount: 'prepay', refund: 'refund', cutoff: 'cutoff',
};

interface Diff {
  field: keyof RuleValues;
  key: string;
  line: RuleChangeLine;
  value: RuleChange['value'];
}

/** 저장된 값과 다른 곳(보이는 줄만, 카드 차례). */
export function diffValues(settings: FxShopRules, after: RuleValues): Diff[] {
  const keys = ruleKeys(settings);
  const before = ruleValues(settings);
  const unit = unitOf();
  const kind = policyKinds()[0]?.label ?? '리프트권';
  const rule = depositRule(settings).label;
  const text: Record<keyof RuleValues, { label: string; word: (v: RuleValues) => string; value: (v: RuleValues) => RuleChange['value'] }> = {
    returnPolicy: { label: kind + ' 반납', word: (v) => wordOf(RETURN_POLICY, v.returnPolicy), value: (v) => v.returnPolicy },
    depositOn: { label: rule, word: (v) => wordOf(USE, v.depositOn ? 'true' : 'false'), value: (v) => (v.depositOn ? 1 : 0) },
    depositAmount: { label: rule, word: (v) => '1' + unit + ' ' + won(v.depositAmount), value: (v) => v.depositAmount },
    timing: { label: rule + ' · 입금 시점', word: (v) => wordOf(TIMING, v.timing), value: (v) => v.timing },
    unreturned: { label: rule + ' · 미반납 시', word: (v) => wordOf(UNRETURNED, v.unreturned), value: (v) => v.unreturned },
    lossAmount: { label: rule + ' · 미반납 시', word: (v) => '1' + unit + ' ' + won(v.lossAmount), value: (v) => v.lossAmount },
    prepay: { label: PREPAY_TITLE, word: (v) => wordOf(PREPAY, v.prepay), value: (v) => v.prepay },
    prepayAmount: { label: PREPAY_TITLE, word: (v) => '팀당 ' + won(v.prepayAmount), value: (v) => v.prepayAmount },
    refund: { label: REFUND_TITLE, word: (v) => wordOf(REFUND, v.refund), value: (v) => v.refund },
    cutoff: { label: CUTOFF_TITLE, word: (v) => v.cutoff, value: (v) => v.cutoff },
  };
  return ORDER.filter((f) => visible[f](after) && before[f] !== after[f]).map((field) => ({
    field,
    key: keys[field],
    value: text[field].value(after),
    line: { key: keys[field], label: text[field].label, before: text[field].word(before), after: text[field].word(after) },
  }));
}

const PREPAY_TITLE = '리프트권 결제 · 전화 예약';
const REFUND_TITLE = '당일 취소 환불';
const CUTOFF_TITLE = '영업일 기준 시각';

/** 리프트권의 단위(`매`). */
const unitOf = () => productOf(policyKinds()[0]?.products[0])?.unit ?? '매';

/**
 * 기준 시각을 바꿀 수 없는 때(data-model 3-3): 지금 시각이 옛 기준과 새 기준 사이이면 영업일이 거꾸로 가거나 한 시간대가 두 날로
 * 나뉜다(02:00에 00:00 → 06:00). 까닭 `변경 불가 · 06:00 이후 가능`(둘 중 늦은 기준).
 */
export function cutoffRejection(before: string, after: string, now: number): string | undefined {
  if (before === after) return undefined;
  const [low, high] = minutesOf(before) <= minutesOf(after) ? [before, after] : [after, before];
  const at = minutesOf(hm(now));
  return at >= minutesOf(low) && at < minutesOf(high) ? '변경 불가 · ' + high + ' 이후 가능' : undefined;
}

// ── 카드 ───────────────────────────────────────────────────────────

const options = <K extends string>(list: readonly Choice<K>[], selected: K): ChoiceOption[] =>
  list.map((c) => ({ key: c.key, label: c.label, selected: c.key === selected, enabled: true, ...(c.secondLine ? { secondLine: c.secondLine } : {}), ...(c.short ? { short: c.short } : {}) }));

/** 기준 시각의 예시(`27일 00:15 반납 → 26일 장부`): 다음 날 00:15(V6의 정하늘 팀)과 07:00을 이 기준으로 센 장부 날. */
function cutoffExample(businessDate: string, hour: number, minute: number, cutoff: string): RichText {
  const at = kstAt(businessDate, 1, hour, minute);
  const day = (date: string) => Number(date.slice(8)) + '일';
  return [{ text: day(kstDate(at)) + ' ' + hm(at) + ' 반납 → ' }, { text: day(businessDateOf(at, cutoff)) + ' 장부', strong: true }];
}

function cards(state: FxState, v: RuleValues, changed: ReadonlySet<string>): RuleCard[] {
  const keys = ruleKeys(state.settings);
  const unit = unitOf();
  const rule = depositRule(state.settings);
  const kinds = policyKinds();
  const amountInput = (key: string, title: string, range: { min: number; max: number }): RuleInput => ({ key, mode: 'amount', title, ...range });
  const returnCards: RuleCard[] = kinds.map((kind) => ({
    key: 'return:' + kind.key,
    title: kind.label + ' 반납',
    changed: changed.has('return'),
    inline: false,
    rows: [{ key: keys.returnPolicy, options: options(RETURN_POLICY, v.returnPolicy) }],
    notes: [[{ text: '반납 필수 · ' + kind.label + ' 반납 후 완료' }]],
  }));
  const depositRows: RuleRow[] = [{
    key: keys.depositOn,
    label: '보증금',
    options: options(USE, v.depositOn ? 'true' : 'false'),
    values: { true: 1, false: 0 },
    ...(v.depositOn ? { value: { label: '1' + unit + ' ' + won(v.depositAmount), input: amountInput(keys.depositAmount, rule.label + ' · 1' + unit + ' ' + won(v.depositAmount), AMOUNT) } } : {}),
  }];
  if (v.depositOn) {
    depositRows.push({ key: keys.timing, label: '입금 시점', options: options(TIMING, v.timing) });
    depositRows.push({ key: keys.unreturned, label: '미반납 시', options: options(UNRETURNED, v.unreturned) });
    // 분실 값은 제 줄(이름표 `분실금 청구` · 값 버튼 `1매 35,000원 ›`): 미반납 시 줄 끝에 붙이면 474 폭 카드에서 고른 버튼이 `더 보기`
    // 뒤로 숨는다(plan §8 D78). 예약금 줄과 같은 모양.
    if (v.unreturned === 'charge_loss') {
      const loss = '1' + unit + ' ' + won(v.lossAmount);
      depositRows.push({ key: keys.lossAmount, label: '분실금 청구', options: [], value: { label: loss, input: amountInput(keys.lossAmount, '분실금 청구 · ' + loss, AMOUNT) } });
    }
  }
  const prepayRows: RuleRow[] = [{ key: keys.prepay, options: options(PREPAY, v.prepay) }];
  if (v.prepay === 'fixed_amount') {
    prepayRows.push({ key: keys.prepayAmount, label: '예약금', options: [], value: { label: '팀당 ' + won(v.prepayAmount), input: amountInput(keys.prepayAmount, '예약금 · 팀당 ' + won(v.prepayAmount), PREPAY_AMOUNT) } });
  }
  const preset = (CUTOFF_PRESETS as readonly string[]).includes(v.cutoff);
  const cutoffOptions: ChoiceOption[] = [
    ...CUTOFF_PRESETS.map((c) => ({ key: c, label: c, selected: v.cutoff === c, enabled: true })),
    { key: CUSTOM, label: '직접 입력', selected: !preset, enabled: true, ...(preset ? {} : { secondLine: v.cutoff }) },
  ];
  const timeInput: RuleInput = { key: keys.cutoff, mode: 'time', title: CUTOFF_TITLE + ' · ' + v.cutoff, ...CUTOFF, note: '00:00 ~ 11:59' };
  return [
    ...returnCards,
    {
      key: 'deposit:' + rule.key,
      title: rule.label,
      changed: changed.has('deposit'),
      inline: false,
      rows: depositRows,
      notes: v.depositOn ? [] : [[{ text: '보증금 미사용' }]],
    },
    { key: 'prepay', title: PREPAY_TITLE, changed: changed.has('prepay'), inline: false, rows: prepayRows, notes: [] },
    { key: 'refund', title: REFUND_TITLE, changed: changed.has('refund'), inline: true, rows: [{ key: keys.refund, options: options(REFUND, v.refund) }], notes: [] },
    {
      key: 'cutoff',
      title: CUTOFF_TITLE,
      changed: changed.has('cutoff'),
      inline: false,
      rows: [{ key: keys.cutoff, options: cutoffOptions, inputs: { [CUSTOM]: timeInput } }],
      notes: [cutoffExample(state.businessDate, 0, 15, v.cutoff), cutoffExample(state.businessDate, 7, 0, v.cutoff), [{ text: '마감 후 기록 · 다음 마감 반영' }]],
    },
  ];
}

// ── 읽기 모델 · 명령 ───────────────────────────────────────────────────

/** V8 운영 규칙(shopRules): 저장된 값 + 화면의 바꿈 → 카드 · 바뀐 곳 · 바닥줄 · 주 버튼 · setting.set · 거절 까닭. */
export function shopRules(ctx: ViewContext, params: ShopRulesParams): ShopRulesView {
  const { state, now } = ctx;
  const { values } = draftValues(state.settings, params.changes ?? []);
  const diff = diffValues(state.settings, values);
  const n = diff.length;
  const changed = new Set(diff.map((d) => CARD_OF[d.field]));
  const rejection = cutoffRejection(state.settings.businessDayCutoff, values.cutoff, now);
  const save = '저장';
  return {
    basis: { epoch: state.epoch, rev: state.rev },
    serverTime: iso(now),
    currentBusinessDate: state.businessDate,
    cards: cards(state, values, changed),
    changes: diff.map((d) => d.line),
    footer: n ? '변경 ' + n + '건 · 다음 기록부터 적용' : '변경 없음',
    ...(n ? { saveTitle: '변경 ' + n + '건', unsavedTitle: '미저장 변경 ' + n + '건' } : {}),
    primary: n ? { label: save + ' · ' + n + '건', alts: [save + ' · ' + n + '건', save], enabled: true } : { label: save, alts: [save], enabled: false },
    ...(n ? { command: { type: 'setting.set', payload: { changes: diff.map((d) => ({ key: d.key, value: d.value })) } } } : {}),
    ...(rejection ? { rejection } : {}),
  };
}

/**
 * 운영 규칙 저장(setting.set, 연결 필요): 바꿈을 모두 받을 수 있어야 하고(모르는 key · 범위 밖이면 거절), 기준 시각은 옛 기준과 새 기준
 * 사이에 바꿀 수 없다. 다음 기록부터: 리프트권 반납은 새 권 줄이, 보증금 규칙은 새 보관이 복사하고, 기준 시각은 바꾼 시각 전의 기록에
 * 옛 기준을 남긴다(cutoffBefore). 보증금 미사용이면 규칙 값을 따로 두어(liftDepositOff) 맡은 보증금은 그대로 반환하고, `사용`으로 되돌리면
 * 그 값으로 다시 시작한다.
 */
export function applySettings(state: FxState, envelope: CommandEnvelope<'setting.set'>, now: number): Result {
  const changes = envelope.payload.changes ?? [];
  const { values, invalid } = draftValues(state.settings, changes);
  if (invalid.length) return rejected(UNKNOWN);
  const diff = diffValues(state.settings, values);
  if (!diff.length) return nothing('변경 없음');
  const before = state.settings.businessDayCutoff;
  const refused = cutoffRejection(before, values.cutoff, now);
  if (refused) return rejected(refused);
  const s = state.settings;
  s.liftReturnPolicy = values.returnPolicy;
  const rule: FxDepositRule = { ...depositRule(s), unitAmount: values.depositAmount, timing: values.timing, unreturned: values.unreturned, lossAmount: values.lossAmount };
  if (values.depositOn) {
    s.liftDeposit = rule;
    delete s.liftDepositOff;
  } else {
    s.liftDeposit = null;
    s.liftDepositOff = rule;
  }
  s.prepaymentMode = values.prepay;
  s.prepaymentAmount = values.prepayAmount;
  s.sameDayCancelRefund = values.refund;
  if (values.cutoff !== before) {
    s.cutoffBefore = [...(s.cutoffBefore ?? []), { until: now, cutoff: before }];
    s.businessDayCutoff = values.cutoff;
  }
  return done;
}


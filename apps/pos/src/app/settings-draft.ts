// 매장 설정 · 운영 규칙(V8, spec 3-9) 화면의 초안: 누른 고르기 · 숫자판에 넣은 값을 바꿈(RuleChange)으로 모은다. 같은 곳(key)은 마지막
// 것 하나다(다시 누르면 덮는다). 무엇이 저장된 값과 다른지 · 몇 건인지 · 어느 줄이 보이는지 · 저장할 수 있는지는 서버(shopRules)가 정한다:
// 여기는 모으고 숫자판의 값을 읽기 모델의 범위로 보기만 한다. 초안은 화면에만 있다(떠나면 `미저장 변경 N건` 창이 묻는다).
import type { ChoiceOption, RuleChange, RuleInput, RuleRow, SettingsOp, SettingsStep, SettingsValue } from '@skinote/contract';
import { timeFromDigits } from '@skinote/ui';

/** 바꿈 하나를 넣는다(같은 key의 앞 바꿈은 뺀다). */
export function withChange(changes: readonly RuleChange[], change: RuleChange): RuleChange[] {
  return [...changes.filter((c) => c.key !== change.key), change];
}

/** 고르기 버튼 하나의 누름: 숫자판을 여는 버튼(`직접 입력`)이면 그 숫자판, 아니면 바꿈(값 = 버튼 key). */
export function optionPress(row: RuleRow, option: ChoiceOption): { input: RuleInput } | { change: RuleChange } {
  const input = row.inputs?.[option.key];
  return input ? { input } : { change: { key: row.key, value: row.values?.[option.key] ?? option.key } };
}

/** 숫자판의 값(시각 'HH:MM', 전화는 숫자 글, 금액 · 분 · 비율은 수). */
export function padValue(input: RuleInput, digits: string): string | number {
  const d = digits.replace(/\D/g, '');
  if (input.mode === 'time') return timeFromDigits(d) ?? '';
  if (input.mode === 'phone') return d;
  return Number(d || '0');
}

/**
 * 숫자판의 `입력`을 누를 수 있는지: 읽기 모델이 준 범위 안(시각은 네 자리 · 분 60 미만, 하루의 분으로 min ~ max; 금액은 단위 step으로 나누어떨어짐;
 * 전화는 비우거나 9 ~ 11자리).
 */
export function inputAccepts(input: RuleInput, digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (input.mode === 'time') {
    if (d.length !== 4) return false;
    const h = Number(d.slice(0, 2));
    const m = Number(d.slice(2));
    const minutes = h * 60 + m;
    return h < 24 && m < 60 && minutes >= input.min && minutes <= input.max;
  }
  if (input.mode === 'phone') return d.length === 0 || (d.length >= 9 && d.length <= 11);
  if (!d) return false;
  const n = Number(d);
  return n >= input.min && n <= input.max && (!input.step || n % input.step === 0);
}

// ── 매장 설정의 다른 탭(features-1 §4-4): 초안은 op 목록 ──────────────────────────

/** 초안 끝에 한 건(차례대로 적용된다: 같은 행을 두 번 바꾸면 뒤의 것이 남는다). */
export function withOp(ops: readonly SettingsOp[], op: SettingsOp): SettingsOp[] {
  return [...ops, op];
}

/** 거절된 건부터 뺀 초안(읽기 모델의 refused.at). */
export const dropFrom = (ops: readonly SettingsOp[], at: number): SettingsOp[] => ops.slice(0, Math.max(0, at));

/** op의 자리(field: 점으로 이은 자리 'value.minutes')에 값을 채운 새 op. */
export function fillOp(op: SettingsOp, field: string, value: SettingsValue): SettingsOp {
  const next = structuredClone(op) as unknown as Record<string, unknown>;
  const path = field.split('.');
  let at: Record<string, unknown> = next;
  for (const key of path.slice(0, -1)) {
    const inner = at[key];
    at[key] = inner && typeof inner === 'object' ? { ...(inner as Record<string, unknown>) } : {};
    at = at[key] as Record<string, unknown>;
  }
  at[path[path.length - 1]!] = value;
  return next as unknown as SettingsOp;
}

/** 값을 받는 단계들을 차례로 도는 자리(화면이 쥔다): 지금 단계, 채워 가는 op. */
export interface StepRun {
  op: SettingsOp;
  steps: SettingsStep[];
  index: number;
}

/** 한 단계의 값을 넣는다: 다음 단계가 있으면 그 자리, 끝났으면 초안에 넣을 op. */
export function stepValue(run: StepRun, value: SettingsValue): { next: StepRun } | { done: SettingsOp } {
  const step = run.steps[run.index];
  if (!step) return { done: run.op };
  const op = fillOp(run.op, step.field, value);
  return run.index + 1 < run.steps.length ? { next: { op, steps: run.steps, index: run.index + 1 } } : { done: op };
}

/** 줄의 값 버튼 · `직접 입력`의 숫자판 · 키보드가 매장 설정의 op를 가졌으면 그 단계(운영 규칙의 값 버튼은 op가 없다). */
export function inputRun(input: RuleInput): StepRun | null {
  return input.op && input.field ? { op: input.op, steps: [{ kind: 'input', field: input.field, input }], index: 0 } : null;
}

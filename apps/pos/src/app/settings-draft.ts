// 매장 설정 · 운영 규칙(V8, spec 3-9) 화면의 초안: 누른 고르기 · 숫자판에 넣은 값을 바꿈(RuleChange)으로 모은다. 같은 곳(key)은 마지막
// 것 하나다(다시 누르면 덮는다). 무엇이 저장된 값과 다른지 · 몇 건인지 · 어느 줄이 보이는지 · 저장할 수 있는지는 서버(shopRules)가 정한다:
// 여기는 모으고 숫자판의 값을 읽기 모델의 범위로 보기만 한다. 초안은 화면에만 있다(떠나면 `미저장 변경 N건` 창이 묻는다).
import type { ChoiceOption, RuleChange, RuleInput, RuleRow } from '@skinote/contract';
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

/** 숫자판의 값(시각 'HH:MM', 금액은 원). */
export function padValue(input: RuleInput, digits: string): string | number {
  const d = digits.replace(/\D/g, '');
  return input.mode === 'time' ? (timeFromDigits(d) ?? '') : Number(d || '0');
}

/** 숫자판의 `입력`을 누를 수 있는지: 읽기 모델이 준 범위 안(시각은 네 자리 · 분 60 미만, 하루의 분으로 min ~ max). */
export function inputAccepts(input: RuleInput, digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (input.mode === 'time') {
    if (d.length !== 4) return false;
    const h = Number(d.slice(0, 2));
    const m = Number(d.slice(2));
    const minutes = h * 60 + m;
    return m < 60 && minutes >= input.min && minutes <= input.max;
  }
  if (!d) return false;
  const n = Number(d);
  return n >= input.min && n <= input.max;
}

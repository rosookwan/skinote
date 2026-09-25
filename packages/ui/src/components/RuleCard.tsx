// 운영 규칙 카드(RuleCard): 관리 화면의 카드 목록(매장 설정 · 운영 규칙, 둘째 판 시안 V8 · spec 3-9 · ui 6-9). 크림 바탕 · 2px 옅은 테두리 ·
// 모서리 10 · 안 여백 12, 제목 줄 28(굵은 17px, 저장하지 않은 바꿈이 있으면 오른쪽에 이름표 `변경됨`) · 버튼 줄 52(사이 8) · 안내 줄 22.
// 한 줄 카드(`당일 취소 환불`)는 왼쪽 제목, 오른쪽 버튼. 고르기 버튼은 카드 폭을 나눠 채우고(글 폭보다 줄지 않음), 값 버튼(`1매 5,000원 ›`)은
// 제 폭으로 줄 끝에 둔다(누르면 숫자판: 고르기가 아니라 남색이 되지 않는다). 줄이 좁으면 ChoiceRow가 짧은 이름(`차액 청구`) → `더 보기`로 줄인다.
// 무엇이 골라졌는지 · 어떤 줄이 보이는지는 읽기 모델이 정했다(부품은 그리기만). 카드 높이는 ruleCardHeight가 같은 값으로 센다: 화면이 카드를
// 통째로 칸 · 쪽에 나눈다(자르지 않음, ui 4-3).
import type { ChoiceOption, RuleCard as RuleCardView, RuleRow } from '@skinote/contract';
import type { DeviceProfile } from '../device-profile.ts';
import { t } from '../strings.ko-KR.ts';
import { ChoiceRow } from './Choice.tsx';
import { FormRow } from './FormRow.tsx';
import { RichLine } from './RichLine.tsx';
import { Tag } from './Tag.tsx';

/** 제목 줄 · 안내 줄의 높이(글자 크기의 배수). components.css의 .sn-rule-title · .sn-rule-note와 같은 값. */
export const RULE_TITLE_LINE = 1.75;
export const RULE_NOTE_LINE = 1.375;

/**
 * 카드 높이(px): 안 여백 · 테두리 + 제목 줄 + 버튼 줄(사이 8) + 안내 줄. 한 줄 카드는 버튼 줄 하나 높이. 부품의 CSS와 같은 값을
 * DeviceProfile로 센다(화면의 쪽 나누기가 그리기 전에 쓴다).
 */
export function ruleCardHeight(card: Pick<RuleCardView, 'inline' | 'rows' | 'notes'>, profile: Pick<DeviceProfile, 'minFontPx' | 'minTargetPx' | 'space' | 'line'>): number {
  const frame = 2 * profile.space.m + 2 * profile.line.strong;
  if (card.inline) return frame + Math.max(profile.minTargetPx, Math.ceil(profile.minFontPx * RULE_TITLE_LINE));
  const title = Math.ceil(profile.minFontPx * RULE_TITLE_LINE);
  const rows = card.rows.length ? card.rows.length * profile.minTargetPx + (card.rows.length - 1) * profile.space.s : 0;
  const notes = card.notes.length ? card.notes.length * Math.ceil(profile.minFontPx * RULE_NOTE_LINE) : 0;
  const blocks = [title, rows, notes].filter((h) => h > 0);
  return frame + blocks.reduce((sum, h) => sum + h, 0) + (blocks.length - 1) * profile.space.xs;
}

export interface RuleCardProps {
  card: RuleCardView;
  /** 고르기 버튼(값은 그 버튼 key, 숫자판을 여는 버튼은 row.inputs에 있다). */
  onOption: (row: RuleRow, option: ChoiceOption) => void;
  /** 값 버튼(`1매 5,000원 ›`): 숫자판을 연다. */
  onValue: (row: RuleRow) => void;
}

export function RuleCard({ card, onOption, onValue }: RuleCardProps) {
  const title = (
    <div className="sn-rule-title">
      <h2>{card.title}</h2>
      {card.changed ? <Tag text={t('changed')} /> : null}
    </div>
  );
  const row = (r: RuleRow) => {
    const value = r.value ? (
      <button type="button" className="sn-button sn-rule-value" onClick={() => onValue(r)}>
        {r.value.label}{' '}<span className="sn-choice-more">›</span>
      </button>
    ) : null;
    const choices = (
      <ChoiceRow
        options={r.options}
        label={r.label ?? card.title}
        onPress={(key) => { const option = r.options.find((o) => o.key === key); if (option) onOption(r, option); }}
        {...(value ? { trail: value } : {})}
      />
    );
    return r.label
      ? <FormRow key={r.key} label={r.label} className="sn-rule-row">{choices}</FormRow>
      : <div key={r.key} className="sn-rule-row">{choices}</div>;
  };
  return (
    <section className={'sn-rule-card' + (card.inline ? ' is-inline' : '')} aria-label={card.title}>
      {title}
      {card.rows.length ? <div className="sn-rule-rows">{card.rows.map(row)}</div> : null}
      {card.notes.length ? (
        <div className="sn-rule-notes">
          {card.notes.map((note, i) => <RichLine key={i} className="sn-rule-note" runs={note} />)}
        </div>
      ) : null}
    </section>
  );
}

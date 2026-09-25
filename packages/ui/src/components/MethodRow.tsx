// 결제 칸 하나(MethodRow, ui 5 · 4-5, 시안 V4의 v4-sec · v4-deposit): 접수 확정 창의 칸별 수납. 두 줄 칸(104) = 제목 줄(글만: 굵은 칸
// 이름 · 회색 품목 · 회색 할인 상태 · 파란 `이정호 팀 결제 예정` · 금액) + 수단 줄(빠른 수단 · `후불` · `기타` 버튼, 끝에 윤곽
// `할인 적용 ›`) + 아래 틈. 수단이 하나뿐인 칸(보증금 현금만)은 버튼 없는 한 줄(52)이고 끝에 받는 돈(`현금 20,000원`). `후불`인 칸의
// 금액은 옅은 먹(지금 받지 않음). 칸 사이는 높이를 먹지 않는 가는 선이다. 좁으면 품목은 '외 N종', 할인 상태는 짧은 글(`10% 할인`)로
// 줄인다(말줄임 없음). 무엇을 고를 수 있는지 · 글은 읽기 모델(CheckoutSection)이 정했고, 부품은 누른 key만 알린다.
import type { CheckoutSection } from '@skinote/contract';
import { formatWon } from '../format.ts';
import { t } from '../strings.ko-KR.ts';
import { ChoiceButton } from './Choice.tsx';
import { RichLine } from './RichLine.tsx';
import { TextFit } from './TextFit.tsx';

export interface MethodRowProps {
  section: CheckoutSection;
  /** 수단 버튼(빠른 수단 key · `later` · `other`)을 눌렀다. */
  onMethod: (key: string) => void;
  /** `할인 적용 ›`(그 칸 할인 묶음의 작은 창). */
  onDiscount?: () => void;
}

export function MethodRow({ section, onMethod, onDiscount }: MethodRowProps) {
  const items = (
    <TextFit
      className="sn-method-items"
      input={section.itemList && section.itemList.length > 1 ? { mode: 'items', items: section.itemList } : { mode: 'words', text: section.items }}
    />
  );
  const amount = section.single
    ? <RichLine className="sn-method-amount" runs={section.single} />
    : <b className={'sn-method-amount' + (section.amountMuted ? ' is-later' : '')}>{formatWon(section.amount)}</b>;
  if (!section.methods) {
    return (
      <section className="sn-method-row is-single" aria-label={section.label}>
        <b className="sn-method-name">{section.label}</b>
        {items}
        {amount}
      </section>
    );
  }
  const discountAlts = section.discount ? [section.discount, ...(section.discountShort ? [section.discountShort] : [])] : [];
  return (
    <section className="sn-method-row" aria-label={section.label}>
      <div className="sn-method-top">
        <b className="sn-method-name">{section.label}</b>
        {items}
        {discountAlts.length ? <TextFit className="sn-method-disc" input={{ mode: 'alts', alts: discountAlts }} /> : null}
        {section.payerNote ? <span className="sn-method-payer tone-blue">{section.payerNote}</span> : null}
        {amount}
      </div>
      <div className="sn-method-buttons" role="group" aria-label={t('methodsFor', { section: section.label })}>
        {section.methods.map((option) => <ChoiceButton key={option.key} option={option} onPress={onMethod} />)}
        {section.discountable && onDiscount ? (
          <button type="button" className="sn-button sn-choice sn-method-discount" aria-label={t('discountApplyFor', { section: section.label })} onClick={onDiscount}>
            {t('discountApply')}{' '}<span className="sn-choice-more">›</span>
          </button>
        ) : null}
      </div>
    </section>
  );
}

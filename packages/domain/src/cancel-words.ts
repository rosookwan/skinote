// 접수 취소 · 품목 취소 · 품목 추가의 화면 글(docs/design/wording.md 3-20, 확인 대기)과 취소 한 건의 이름(payments.reason · order_cancellations.reason).
// 읽기 모델(order-edit.ts) · 환불의 까닭(discounts.ts) · 저장소가 같은 말을 쓴다. 이 파일은 model만 가져온다.
import type { FxCancellation } from './model.ts';

export const CANCEL_WORDS = Object.freeze({
  orderCancel: '접수 취소',
  removeItems: '품목 취소',
  addItems: '품목 추가',
  reasonRow: '구분',
  request: '취소 요청',
  noShow: '연락 없음',
  moneyRow: '환불',
  refund: '환불',
  applyToDue: '미수 결제',
  noRefund: '환불 없음',
  keep: '수납 유지',
  amount: '취소 금액',
  notCancellable: '취소 불가 · 미반납',
  loadedRefusal: '취소 불가 · 차량 적재',
  nothing: '취소 대상 없음',
  /** 창을 연 뒤 취소할 수가 바뀜(다른 카운터의 지급 · 취소, 2026-09-27 점검). */
  quantityChanged: '수량 변경됨 · 재시도 필요',
  payerRelease: '결제 예정 해제',
  /** 취소가 푼 보증금의 반환 줄(있음: 반납 창 `보증금 반환`). */
  depositReturn: '보증금 반환',
  status: '취소',
  confirmAdd: '추가 확정',
  payerTeam: '결제 팀',
  selfPay: '이 팀 결제',
  /** 품목 추가 확정 창의 결제 팀 줄 버튼(`이정호 팀` · `이 팀`). */
  thisTeam: '이 팀',
  inherited: '적용 중',
});

/** 취소의 구분 이름(reason_codes cancellation). */
export const reasonLabel = (key: FxCancellation['reasonKey']) => (key === 'no_show' ? CANCEL_WORDS.noShow : CANCEL_WORDS.request);

/** 취소 한 건의 이름: `접수 취소 · 연락 없음` · `품목 취소 · 취소 요청`(order_cancellations.reason · 환불의 payments.reason). */
export const cancellationLabel = (c: Pick<FxCancellation, 'scope' | 'reasonKey'>) =>
  (c.scope === 'order' ? CANCEL_WORDS.orderCancel : CANCEL_WORDS.removeItems) + ' · ' + reasonLabel(c.reasonKey);

/** 이름에서 범위 · 구분을 되읽는다(저장소, order_cancellations.reason). 모르면 품목 취소 · 취소 요청. */
export function cancellationOfLabel(label: string): Pick<FxCancellation, 'scope' | 'reasonKey'> {
  const [head, reason] = label.split(' · ');
  return { scope: head === CANCEL_WORDS.orderCancel ? 'order' : 'lines', reasonKey: reason === CANCEL_WORDS.noShow ? 'no_show' : 'request' };
}

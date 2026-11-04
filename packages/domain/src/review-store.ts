// 저장하는 확인 필요 한 건 더하기(features-1 E18, work/impl-offline/plan.md §5-1 · §5-7): 명령 처리기(수거 · 현장 수납 · 방문 …)가 함께 쓴다.
// 문장은 종류의 틀로 한 번 그린다. 같은 id가 이미 있으면 더하지 않는다(같은 요청번호의 재시도는 명령 결과가 막는다).
import { reviewMessage } from '@skinote/contract';
import type { FxReview, ShopState } from './model.ts';

/** 저장된 확인 필요 한 건을 더한다(문장은 종류의 틀로 그린다). 같은 id가 있으면 그것을 돌려준다. */
export function storeReview(state: ShopState, review: Omit<FxReview, 'message' | 'status'>): FxReview {
  const found = (state.reviews ?? []).find((r) => r.id === review.id);
  if (found) return found;
  const row: FxReview = { ...review, message: reviewMessage(review.kindKey, review.params), status: 'open' };
  state.reviews = [...(state.reviews ?? []), row];
  return row;
}

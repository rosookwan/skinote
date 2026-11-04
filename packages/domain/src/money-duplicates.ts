// 중복 수납 의심(sync 6, work/impl-offline/plan.md §5-7): 끊긴 기사 기기가 받은 돈과 같은 날 · 같은 금액의 돈이 다른 기기(카운터 · 같은 차량의 다른
// 기기)에서 이미 적혀 있으면 두 돈을 모두 적고 확인 필요 `중복 수납 의심`을 기기마다 한 줄 남긴다(보낸 기기 · 다른 기기, 다른 기기를 모르면 관리자
// 목록에만). 돈은 거절하지 않는다: 받은 돈은 사실이고 사람이 확인한다.
import type { AnyCommandEnvelope } from '@skinote/contract';
import type { FxOrder, FxPayment, ShopState } from './model.ts';
import { storeReview } from './review-store.ts';
import { businessDateOf, shopCutoff } from './time.ts';

const amountText = (n: number) => Math.round(n).toLocaleString('ko-KR');

/**
 * 방금 적은 돈(payment)과 같은 영업일 · 같은 금액의 다른 기기 돈이 이 접수에 있으면 `중복 수납 의심` 두 줄(이 기기 · 다른 기기). {minutes}는 두 돈의
 * 일어난 때 차이(분, 1 이상). 적은 줄 수.
 */
export function duplicateMoneyReviews(state: ShopState, o: FxOrder, payment: FxPayment, envelope: AnyCommandEnvelope, now: number): number {
  const cutoff = shopCutoff(state.settings);
  const day = businessDateOf(payment.at, cutoff);
  const mine = payment.deviceId ?? '';
  const twins = o.payments
    .filter((p) => p !== payment && p.methodKey !== 'deposit' && p.amount === payment.amount && (p.deviceId ?? '') !== mine && businessDateOf(p.at, cutoff) === day)
    .sort((a, b) => Math.abs(a.at - payment.at) - Math.abs(b.at - payment.at));
  const other = twins[0];
  if (!other) return 0;
  const minutes = Math.max(1, Math.round(Math.abs(payment.at - other.at) / 60_000));
  const params = { team: o.teamName, amount: amountText(payment.amount), minutes };
  const taskId = (envelope.payload as { taskId?: string }).taskId;
  const base = { kindKey: 'possible_duplicate_money', params, orderId: o.id, ...(taskId ? { taskId } : {}), source: 'sync' as const, createdAt: now };
  storeReview(state, { ...base, id: envelope.requestId + ':d1', ...(payment.deviceId ? { targetDeviceId: payment.deviceId } : {}) });
  storeReview(state, { ...base, id: envelope.requestId + ':d2', ...(other.deviceId ? { targetDeviceId: other.deviceId } : {}) });
  return 2;
}

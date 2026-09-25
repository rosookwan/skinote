// 둘째 판 화면(V1 ~ V9)의 읽기 모델 만들기(서버 몫). 단계마다 하나씩 채운다(work/impl-v2/plan.md 5절): 2단계 V9(promiseSheet),
// 3단계 V1(returnSheet), 4단계 V2 · V3(orderDraft), 5단계 V4(checkoutSheet), 6단계 V5(groupPaySheet · partialPaySheet),
// 7단계 V7(taskSheet · fieldPaySheet · addTicketSheet), 8단계 V6(closingSheet), 9단계 V8(shopRules). 아홉 화면 모두 채웠다.
// 규칙은 rules.ts · stamps.ts의 것을 쓰고, 여기에는 창 · 화면의 글 조각과 명령 만들기만 둔다.
import {
  type AddTicketSheetParams, type AddTicketSheetView, type CheckoutSheetParams, type CheckoutSheetView, type ClosingSheetParams,
  type ClosingSheetView, type FieldPaySheetParams, type FieldPaySheetView, type GroupPaySheetParams, type GroupPaySheetView, type OrderDraftParams,
  type OrderDraftView, type PartialPaySheetParams, type PartialPaySheetView, type PromiseSheetParams, type PromiseSheetView, type ReturnSheetParams,
  type ReturnSheetView, type ShopRulesParams, type ShopRulesView, type TaskSheetParams, type TaskSheetView,
} from '@skinote/contract';
import { checkoutSheet as buildCheckoutSheet } from './checkout.ts';
import { closingSheet as buildClosingSheet } from './closing.ts';
import { addTicketSheet as buildAddTicketSheet, fieldPaySheet as buildFieldPaySheet, taskSheet as buildTaskSheet } from './driver.ts';
import { groupPaySheet as buildGroupPaySheet, partialPaySheet as buildPartialPaySheet } from './group-pay.ts';
import { orderDraft as buildOrderDraft } from './order-draft.ts';
import { promiseSheet as buildPromiseSheet } from './promise-sheet.ts';
import { returnSheet as buildReturnSheet } from './return-sheet.ts';
import { shopRules as buildShopRules } from './shop-rules.ts';
import type { ViewContext } from './views.ts';

/** V1 반납 확인 창 · 부분 반납(3단계, return-sheet.ts). */
export function returnSheet(ctx: ViewContext, params: ReturnSheetParams): ReturnSheetView {
  return buildReturnSheet(ctx, params);
}

/** V9 일정 변경(2단계, promise-sheet.ts). */
export function promiseSheet(ctx: ViewContext, params: PromiseSheetParams): PromiseSheetView {
  return buildPromiseSheet(ctx, params);
}

/** V2 · V3 새 접수(4단계, order-draft.ts). */
export function orderDraft(ctx: ViewContext, params: OrderDraftParams): OrderDraftView {
  return buildOrderDraft(ctx, params);
}

/** V4 접수 확정 창 · 칸별 수납(5단계, checkout.ts). */
export function checkoutSheet(ctx: ViewContext, params: CheckoutSheetParams): CheckoutSheetView {
  return buildCheckoutSheet(ctx, params);
}

/** V5 일괄 수납 · 여러 팀(6단계, group-pay.ts). */
export function groupPaySheet(ctx: ViewContext, params: GroupPaySheetParams): GroupPaySheetView {
  return buildGroupPaySheet(ctx, params);
}

/** V5 부분 결제 판(6단계, group-pay.ts). */
export function partialPaySheet(ctx: ViewContext, params: PartialPaySheetParams): PartialPaySheetView {
  return buildPartialPaySheet(ctx, params);
}

/** V7 기사 업무 판(7단계, driver.ts). */
export function taskSheet(ctx: ViewContext, params: TaskSheetParams): TaskSheetView {
  return buildTaskSheet(ctx, params);
}

/** V7 현장 수납 판(7단계, driver.ts). */
export function fieldPaySheet(ctx: ViewContext, params: FieldPaySheetParams): FieldPaySheetView {
  return buildFieldPaySheet(ctx, params);
}

/** V7 리프트권 추가 판(7단계, driver.ts). */
export function addTicketSheet(ctx: ViewContext, params: AddTicketSheetParams): AddTicketSheetView {
  return buildAddTicketSheet(ctx, params);
}

/** V6 하루 마감(8단계, closing.ts). */
export function closingSheet(ctx: ViewContext, params: ClosingSheetParams): ClosingSheetView {
  return buildClosingSheet(ctx, params);
}

/** V8 관리 · 매장 설정 · 운영 규칙(9단계, shop-rules.ts). */
export function shopRules(ctx: ViewContext, params: ShopRulesParams): ShopRulesView {
  return buildShopRules(ctx, params);
}

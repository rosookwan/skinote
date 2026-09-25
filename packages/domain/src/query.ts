// 읽기 모델 묻기(DomainClient.ledgerView · query의 도메인 몫, plan §3-4): 화면 이름 · 조회 이름을 읽기 모델 만들기(views.ts · sheets.ts)로
// 보낸다. 메모리 어댑터(FixtureClient)와 서버가 같은 함수를 부른다. 돌려준 값은 상태의 조각을 품을 수 있으니 어댑터가 복사해 넘긴다.
import {
  DomainError, type LedgerViewResult, type QueryName, type QueryParams, type QueryResult, type UiConfig, type ViewParams,
} from '@skinote/contract';
import type { DomainLines, ShopState } from './model.ts';
import {
  addTicketSheet, checkoutSheet, closingSheet, fieldPaySheet, groupPaySheet, orderDraft, partialPaySheet, promiseSheet, returnSheet, shopRules,
  taskSheet,
} from './sheets.ts';
import { collectionList, confirmDraft, dayLedger, deliveryList, findLast4, orderSlip, reviewList, type ViewContext } from './views.ts';

/** 읽기 문맥: 화면 설정, 지금 시각, 기사 기기의 보냄 대기 겹치기(점선 도장), 거절 · 알림 문구. */
export interface ReadContext {
  config: UiConfig;
  now: number;
  pendingTasks?: ReadonlySet<string>;
  lines?: DomainLines;
}

const viewContext = (state: ShopState, ctx: ReadContext): ViewContext => ({ ...ctx, state });

/** 장부 화면(오늘 대여 장부 · 수거 목록 · 배달 목록). 모르는 화면은 UNKNOWN_VIEW. */
export function ledgerView(state: ShopState, viewKey: string, params: ViewParams, ctx: ReadContext): LedgerViewResult {
  const view = viewContext(state, ctx);
  switch (viewKey) {
    case 'day_ledger': return dayLedger(view, params);
    case 'collection_list': return collectionList(view, params);
    case 'delivery_list': return deliveryList(view, params);
    default: throw new DomainError('UNKNOWN_VIEW', '없는 화면: ' + viewKey);
  }
}

/** 조회 하나(접수증 · 확인 창 초안 · 둘째 판 화면 …). 없는 접수는 NOT_FOUND, 모르는 조회는 UNKNOWN_VIEW. */
export function runQuery<Q extends QueryName>(state: ShopState, name: Q, params: QueryParams[Q], ctx: ReadContext): QueryResult[Q] {
  const view = viewContext(state, ctx);
  const answer = (value: QueryResult[QueryName]) => value as QueryResult[Q];
  switch (name) {
    case 'orderSlip': {
      const p = params as QueryParams['orderSlip'];
      const slip = orderSlip(view, p.orderId, p.deviceClass);
      if (!slip) throw new DomainError('NOT_FOUND', '없는 접수: ' + p.orderId);
      return answer(slip);
    }
    case 'findLast4': return answer(findLast4(view, (params as QueryParams['findLast4']).last4));
    case 'confirmDraft': return answer(confirmDraft(view, params as QueryParams['confirmDraft']));
    case 'reviewList': return answer(reviewList(view));
    case 'vehicleLoad': {
      const list = collectionList(view, { vehicleId: (params as QueryParams['vehicleLoad']).vehicleId });
      return answer(list.vehicleLoad!);
    }
    case 'returnSheet': return answer(returnSheet(view, params as QueryParams['returnSheet']));
    case 'promiseSheet': return answer(promiseSheet(view, params as QueryParams['promiseSheet']));
    case 'orderDraft': return answer(orderDraft(view, params as QueryParams['orderDraft']));
    case 'checkoutSheet': return answer(checkoutSheet(view, params as QueryParams['checkoutSheet']));
    case 'groupPaySheet': return answer(groupPaySheet(view, params as QueryParams['groupPaySheet']));
    case 'partialPaySheet': return answer(partialPaySheet(view, params as QueryParams['partialPaySheet']));
    case 'closingSheet': return answer(closingSheet(view, params as QueryParams['closingSheet']));
    case 'taskSheet': return answer(taskSheet(view, params as QueryParams['taskSheet']));
    case 'fieldPaySheet': return answer(fieldPaySheet(view, params as QueryParams['fieldPaySheet']));
    case 'addTicketSheet': return answer(addTicketSheet(view, params as QueryParams['addTicketSheet']));
    case 'shopRules': return answer(shopRules(view, params as QueryParams['shopRules']));
    default: throw new DomainError('UNKNOWN_VIEW', '없는 조회: ' + String(name));
  }
}

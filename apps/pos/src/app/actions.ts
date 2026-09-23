// 동작 누르기를 동작 종류(sys_actions.kind_key, ACTION_KIND)로 가른다. 화면은 동작 키마다 코드를 두지 않는다:
//   stamp · command → 서버에 확인 창 초안을 묻는다(confirmDraft). 서버가 창이나 한 문장 알림을 정한다.
//   screen → 그 화면(ACTION_SCREEN)으로. 아직 없는 화면은 한 문장.
//   device → 기기 기능(전화 · 인쇄 도우미). 체험판은 부르는 쪽이 넘긴 처리.
//   next → 다음 할 일(읽기 모델의 nextStep 동작).
// 자기 창이 따로 있는 동작(못 받음의 방문 결과 판, 순서 바꾸기)만 부르는 쪽이 own으로 넘긴다.
import { ACTION_KIND, ACTION_LABELS, ACTION_SCREEN, type ActionKey } from '@skinote/contract';
import type { ConfirmFlow, ConfirmRequest } from '../components/ConfirmFlow.tsx';
import { go } from './router.ts';
import { say } from './strings.ts';

export interface ActionContext {
  flow: ConfirmFlow;
  /** 동작의 대상(접수 · 업무 · 차량 · 품목 줄). */
  target: Omit<ConfirmRequest, 'actionKey'>;
  /** 이 화면에서 따로 처리하는 동작(방문 결과 판 · 순서 바꾸기 · 전화). */
  own?: Partial<Record<ActionKey, () => void>>;
  /** next(다음 할 일)의 실제 동작. */
  next?: ActionKey | null;
}

export function dispatchAction(key: ActionKey, ctx: ActionContext): void {
  const own = ctx.own?.[key];
  if (own) { own(); return; }
  switch (ACTION_KIND[key]) {
    case 'stamp':
    case 'command':
      ctx.flow.open({ ...ctx.target, actionKey: key });
      return;
    case 'next':
      if (ctx.next) dispatchAction(ctx.next, ctx);
      return;
    case 'screen': {
      const screen = (ACTION_SCREEN as Partial<Record<ActionKey, string>>)[key];
      if (screen === 'order_slip' && ctx.target.orderId) {
        go({ name: 'slip', orderId: ctx.target.orderId });
        return;
      }
      ctx.flow.notify({ title: ACTION_LABELS[key], lines: [say('screenSoon')] });
      return;
    }
    case 'device':
      // 기기 기능(전화 등)은 부르는 쪽이 own으로 넘긴다. 없으면 이 기기에서 할 수 없는 일이다.
      ctx.flow.notify({ title: ACTION_LABELS[key], lines: [say('deviceUnavailable')] });
      return;
  }
}

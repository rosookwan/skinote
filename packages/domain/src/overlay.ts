// 보냄 대기 겹치기(work/impl-offline/plan.md §5-5): 기사 기기는 사본(차량 범위 ShopState) 위에 아직 사본에 들지 않은 보냄 대기 항목을 기기 번호
// 차례로 다시 적용해 그린다. 서버와 같은 보냄 대기 규칙(queued.ts)으로 적용하므로 목록 · 점선 도장 · 바닥줄 수가 서버가 받은 뒤의 모습과 같다.
// 부르는 쪽은 사본의 recorded에 든 요청번호와 보류(held)된 답을 빼고 넘긴다. 답을 받은 항목도 사본이 알릴 때까지 겹친다(점선 → 없음 → 실선의
// 깜빡임 없이, 옛 사본에서도 빠지지 않게).
import type { AnyCommandEnvelope, CommandOutcome, CommandOutcomeKey } from '@skinote/contract';
import { applyCommand, type ApplyOptions } from './commands.ts';
import { PRODUCTION_LINES } from './lines.ts';
import type { DomainLines, ShopState } from './model.ts';
import { findOrder, orderIdOfTask } from './rules.ts';

/** 겹칠 항목 하나: 기기에서 만든 때(at = 일어난 때), 보내는 상태, 받은 답. */
export interface OverlayItem {
  envelope: AnyCommandEnvelope;
  at: number;
  state: 'queued' | 'sending' | 'unconfirmed' | 'answered';
  outcome?: CommandOutcomeKey;
}

export interface OverlayResult {
  state: ShopState;
  /** 답을 받지 않은 수거 · 배달의 업무(점선 도장, '전송 대기' 수). */
  pendingTasks: Set<string>;
  /** 그중 보낸 뒤 답을 잃은 것(`{time} 처리 · 결과 확인 중`). */
  unconfirmedTasks: Set<string>;
  /** 업무 · 접수가 사본에 없는 항목(바닥줄 `전송 대기`에 센다: 조용히 버리지 않는다). */
  unplaced: { requestId: string; taskId: string }[];
  /** 답을 받지 않은 돈 기록(현장 수납 · 리프트권 추가 · 보증금 반환)의 접수 → 답을 잃었는지(업무 판 돈 줄의 `· 전송 대기`, §17 R3-18). */
  pendingMoney: Map<string, boolean>;
  /** 항목마다 겹쳐 본 결과. */
  outcomes: Map<string, CommandOutcome>;
}

const STAMP_TYPES = new Set<AnyCommandEnvelope['type']>(['stock.collect', 'stock.deliver']);
const MONEY_TYPES = new Set<AnyCommandEnvelope['type']>(['field.collect', 'field.add_ticket', 'field.deposit_return']);

/**
 * 사본에 보냄 대기 항목을 겹친다(입력은 고치지 않는다). 항목은 기기 번호 차례(없으면 넘긴 차례)로, 일어난 때(at)를 now로 적용한다.
 */
export function overlayQueue(state: ShopState, items: readonly OverlayItem[], opts: { lines?: DomainLines; actor?: ApplyOptions['actor'] } = {}): OverlayResult {
  const next = structuredClone(state);
  next.outcomes = {};
  const pendingTasks = new Set<string>();
  const unconfirmedTasks = new Set<string>();
  const unplaced: { requestId: string; taskId: string }[] = [];
  const pendingMoney = new Map<string, boolean>();
  const outcomes = new Map<string, CommandOutcome>();
  const ordered = [...items].sort((a, b) => (a.envelope.deviceSeq ?? 0) - (b.envelope.deviceSeq ?? 0));
  for (const item of ordered) {
    const envelope = item.envelope.deviceSeq !== undefined ? item.envelope : { ...item.envelope, deviceSeq: 0 } as AnyCommandEnvelope;
    const taskId = (envelope.payload as { taskId?: string }).taskId;
    if (taskId !== undefined && !findOrder(next, orderIdOfTask(taskId))) {
      unplaced.push({ requestId: envelope.requestId, taskId });
      continue;
    }
    const outcome = applyCommand(next, envelope, item.at, opts.lines ?? PRODUCTION_LINES, { orderIds: 'dated', ...(opts.actor ? { actor: opts.actor } : {}) });
    outcomes.set(envelope.requestId, outcome);
    if (envelope.type === 'notification.ack' && item.state !== 'answered') {
      const pin = next.pins.find((p) => p.id === envelope.payload.notificationId);
      if (pin && pin.releasedAt === undefined) pin.pendingAck = true;
    }
    if (taskId !== undefined && STAMP_TYPES.has(envelope.type) && item.state !== 'answered') {
      pendingTasks.add(taskId);
      if (item.state === 'unconfirmed') unconfirmedTasks.add(taskId);
    }
    if (MONEY_TYPES.has(envelope.type) && item.state !== 'answered') {
      const orderId = (envelope.payload as { orderId?: string }).orderId ?? (taskId !== undefined ? orderIdOfTask(taskId) : undefined);
      if (orderId) pendingMoney.set(orderId, (pendingMoney.get(orderId) ?? false) || item.state === 'unconfirmed');
    }
  }
  next.outcomes = {};
  return { state: next, pendingTasks, unconfirmedTasks, unplaced, pendingMoney, outcomes };
}

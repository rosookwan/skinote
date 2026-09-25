// 체험 자료 명령 처리기의 결과 모양(commands.ts · deposits.ts가 함께 쓴다). 체험 전용이고 LocalClient가 오면 없어진다.
import type { CommandOutcomeKey } from '@skinote/contract';

/** 처리 결과. result는 적용한 명령이 돌려줄 값(order.create의 새 접수 id · 접수 번호). */
export type Result = { outcome: CommandOutcomeKey; error?: { code: string; message: string; current?: unknown }; result?: Record<string, unknown> };

export const done: Result = { outcome: 'applied' };
/** 할 것이 남지 않음(다른 사람이 먼저 함). 돈 · 장비는 움직이지 않는다. */
export const nothing = (message: string): Result => ({ outcome: 'superseded', error: { code: 'NOTHING_LEFT', message } });
export const rejected = (message: string): Result => ({ outcome: 'rejected', error: { code: 'NOT_AVAILABLE', message } });
/** 창이 본 바탕(expect)과 지금이 다름: 창을 닫고 다시 연다(새 요청번호). */
export const conflict = (code: string, message: string): Result => ({ outcome: 'conflict', error: { code, message } });

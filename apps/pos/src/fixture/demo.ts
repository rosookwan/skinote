// 체험판의 몫(FixtureClient · story.ts · 시험이 쓴다): 체험 날짜와 시계의 처음 시각, 체험 문구(D16), 처음 자료, 체험 문구로 부르는 명령.
// 규칙은 모두 @skinote/domain에 있고, 여기에는 체험판만의 값만 둔다(work/impl-server/plan.md §3-1 · §3-5).
import type { AnyCommandEnvelope, CommandOutcome } from '@skinote/contract';
import { PRODUCTION_LINES, applyCommand as applyDomainCommand, kstAt, sampleDay, type DomainLines, type ShopState } from '@skinote/domain';

export const DEMO_DATE = '2026-12-26';
/** 체험 시계가 처음 가리키는 시각(15:40). */
export const DEMO_START_MS = kstAt(DEMO_DATE, 0, 15, 40);

/** 체험판의 거절 문구: 운영 문구 대신 체험판의 말(문구 표 3-1 `체험판 미지원` · 3-15 `체험 자료 초기화됨 · 재시도 필요`). */
export const DEMO_LINES: DomainLines = Object.freeze({
  ...PRODUCTION_LINES,
  unsupported: '체험판 미지원',
  epochChanged: '체험 자료 초기화됨 · 재시도 필요',
});

/** 처음 자료(12월 26일 15:40의 18팀). epoch는 되돌릴 때마다 새로 받는다. */
export const createSeed = (epoch: string): ShopState => sampleDay({ date: DEMO_DATE, epoch, ids: 'demo' });

/** 명령 하나를 체험 문구로 적용한다(state를 바꾼다). */
export const applyCommand = (state: ShopState, envelope: AnyCommandEnvelope, now: number): CommandOutcome =>
  applyDomainCommand(state, envelope, now, DEMO_LINES);

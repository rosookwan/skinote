// 도메인의 거절 · 충돌 한 줄(D16, plan §3-2 · §8). 운영 문구가 기본이고, 메모리 어댑터(FixtureClient)는 자기 문구를 넘긴다
// (ExecContext.lines · 읽기 문맥의 lines). 말은 docs/design/wording.md의 표에서 온다(`미지원 기능 · 처리 불가` · `권한 없음 · 관리자
// 확인 필요`는 3-17 `확인 대기`).
import type { DomainLines } from './model.ts';

export const PRODUCTION_LINES: Readonly<DomainLines> = Object.freeze({
  unsupported: '미지원 기능 · 처리 불가',
  epochChanged: '자료 복구 · 재확인 필요',
  forbidden: '권한 없음 · 관리자 확인 필요',
  forbiddenScope: '이 기기에서 사용 불가',
  failed: '처리 실패 · 재시도 필요',
});

/** 문맥에 문구가 없으면 운영 문구. */
export const linesOf = (ctx: { lines?: DomainLines | undefined } | undefined): DomainLines => ctx?.lines ?? PRODUCTION_LINES;

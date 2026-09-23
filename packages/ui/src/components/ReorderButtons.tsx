// 방문 순서 바꾸기(ui 5 ReorderButtons, A3 · N12): ▲ · ▼ · 맨 위로 · 시간순 되돌리기. 한 묶음(반납 타임) 안에서만.
// 버튼은 고른 줄의 동작 줄(RowActionBar)에 다른 동작과 함께 선다: 어느 것이 보일지는 화면 설정(ledger_view_actions의 move_* 행)이,
// 누를 수 있는지는 읽기 모델(LedgerRow.disabledActions: 묶음의 첫 줄 · 끝 줄, 빨리 확인으로 고정된 줄)이 정한다.
// 여기서는 모양만 정한다: 채운 삼각형(▲ · ▼)과 낱말('위로' · '아래로'). 좁으면 낱말만 빠지고 삼각형은 남는다(길게 누르기 없음).
import type { ActionKey } from '@skinote/contract';
import { t } from '../strings.ko-KR.ts';

export type ReorderMove = 'up' | 'down' | 'top';

/** 순서 동작의 모양: 삼각형 글자(없으면 낱말만)와 낱말. */
export const REORDER_LOOK: Readonly<Partial<Record<ActionKey, { move: ReorderMove; glyph?: string; word: string }>>> = {
  move_up: { move: 'up', glyph: '▲', word: t('moveUpLabel') },
  move_down: { move: 'down', glyph: '▼', word: t('moveDownLabel') },
  move_top: { move: 'top', word: t('moveTop') },
};

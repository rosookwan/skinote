// 도장 칸(ui 3-2, 5 Stamp · StampGroup). 칸 전체가 누르는 곳이고, 동그라미는 그림일 뿐이다.
// 일곱 상태: todo 빈 동그라미 · partial 주황 테두리 · done 도장 주홍 · na — · blocked 회색 자물쇠 · scheduled 파란 예정 ·
// delegated 보라 '차량 22:00'. 전송 대기(연결 끊김 중 처리한 도장)는 점선 도장이다. 도장 주홍은 지연 빨강이 아니다.
import type { StampCell, StampStepRow } from '@skinote/contract';
import type { MouseEvent } from 'react';
import { useUi } from '../context.tsx';
import { formatTime } from '../format.ts';
import { Icon } from '../icons.tsx';
import { t } from '../strings.ko-KR.ts';

export interface StampProps {
  cell: StampCell;
  /** 보이는 단계의 설정(도장 글자 · 이름 · 시각 표시). */
  step: StampStepRow | undefined;
  /** 'mini'는 모인 칸의 작은 그림, 'word'는 접수증 돈 줄의 글자 도장('수납 완료' · '부분 수납'). */
  size?: StampSize;
  /** 없으면 누를 수 없는 그림(접수증 돈 줄의 도장). 누름은 줄(행)까지 올라가지 않는다(줄을 누르면 접수증이 열리므로). */
  onPress?: () => void;
  /** 빈 동그라미 안에 도장 글자를 쓴다: 칸 제목과 다른 단계가 보일 때(지급 칸의 첫 단계 '적재'). */
  labelled?: boolean;
  className?: string;
}

export type StampSize = 'full' | 'mini' | 'word';

/**
 * 글자 도장의 글: 상태를 글로 쓴다(그림만으로 완료 · 부분 · 미처리가 갈리지 않게). 미처리는 도장 글자만('수납'),
 * 완료 · 부분은 도장 글자 + 상태('수납 완료' · '부분 수납' · '지급 2 / 4'), 예정은 '예정'. 셀 수 없는 부분은
 * 상태 이름(pay_state.partial '부분 수납')과 같은 순서로 쓰고, 읽는 이름(stampLabel)은 단계 이름이 앞이다('수납 부분').
 */
export function stampWord(cell: StampCell, step: StampStepRow | undefined): string {
  const label = step?.stamp_text ?? step?.label ?? '';
  switch (cell.state) {
    case 'todo':
    case 'blocked': return label;
    case 'partial': return cell.progress ? t('stampPartial', { label, done: cell.progress.done, total: cell.progress.total }) : t('stampWordPartial', { label });
    case 'done': return t('stampDone', { label });
    case 'na': return '—';
    // 예정은 장부 도장 칸과 같은 '예정' 한 말(앞 글이 이미 '이정호 팀 결제 예정'이라 '수납 예정'을 겹쳐 쓰지 않는다).
    case 'scheduled': return t('scheduled');
    case 'delegated': return t('stampDelegated', { label });
  }
}

/** 도장 칸의 읽는 이름('반납 완료', '지급 2 / 4'). */
export function stampLabel(cell: StampCell, step: StampStepRow | undefined): string {
  const label = step?.label ?? '';
  switch (cell.state) {
    case 'todo': return t('stampTodo', { label });
    case 'partial': return cell.progress ? t('stampPartial', { label, done: cell.progress.done, total: cell.progress.total }) : t('stampPartialSome', { label });
    case 'done': return t('stampDone', { label });
    case 'na': return t('stampNa', { label });
    case 'blocked': return t('stampBlocked', { label });
    case 'scheduled': return t('stampScheduled', { label });
    case 'delegated': return t('stampDelegated', { label });
  }
}

/** 도장 그림만(누르는 곳은 부르는 쪽의 칸). */
export function StampMark({ cell, step, size = 'full', labelled = false }: { cell: StampCell; step: StampStepRow | undefined; size?: StampSize; labelled?: boolean }) {
  const { timezone } = useUi();
  const text = step?.stamp_text ?? step?.label ?? '';
  const classes = ['sn-stamp', 'is-' + cell.state, size === 'mini' ? 'is-mini' : size === 'word' ? 'is-word' : '', cell.pending ? 'is-pending' : '', cell.processing ? 'is-processing' : '']
    .filter(Boolean)
    .join(' ');
  // 글자 도장: 모양(테두리 · 색)은 상태별 도장과 같고, 안에 상태를 글로 쓴다.
  if (size === 'word') return <span className={classes}>{stampWord(cell, step)}</span>;
  switch (cell.state) {
    case 'todo':
      return labelled && size === 'full' ? <span className={classes + ' is-labelled'}>{text}</span> : <span className={classes} />;
    case 'partial':
      // 개수가 있으면 '2/4', 없으면(돈처럼 셀 수 없는 단계) '부분'.
      return <span className={classes}>{size === 'mini' ? null : cell.progress ? cell.progress.done + '/' + cell.progress.total : t('partialShort')}</span>;
    case 'done': {
      // 시각이 있으면 도장에 찍는다: shows_time 단계는 넓은 타원('수거 21:42', 칸 5.5em),
      // 그 밖의 단계는 4em 칸 안의 작은 타원에 두 줄(지급 / 15:42).
      const timed = step?.shows_time === 1 && cell.at !== undefined && size === 'full';
      const dated = !timed && cell.at !== undefined && size === 'full';
      return (
        <span className={classes + (timed ? ' is-timed' : dated ? ' is-dated' : '')}>
          {size === 'mini' ? null : <span className="sn-stamp-text">{text}</span>}
          {(timed || dated) && cell.at ? <span className="sn-stamp-time">{formatTime(cell.at, timezone)}</span> : null}
        </span>
      );
    }
    case 'na':
      return <span className={classes}>—</span>;
    case 'blocked':
      return <span className={classes}><Icon name="lock" /></span>;
    case 'scheduled':
      return <span className={classes}>{size === 'mini' ? null : t('scheduled')}</span>;
    case 'delegated':
      // '차량 22:00'을 두 줄로(도장 칸 4em 안에 들어가게).
      return (
        <span className={classes}>
          {size === 'mini' ? null : <span className="sn-stamp-text">{t('vehicle')}</span>}
          {size === 'mini' ? null : <span className="sn-stamp-time">{cell.at ? formatTime(cell.at, timezone) : (cell.delegatedTo ?? '')}</span>}
        </span>
      );
  }
}

/** 도장 칸 하나. na는 누를 수 없고, 나머지는 칸 전체가 버튼이다(blocked를 누르면 막고 있는 단계로). */
export function Stamp({ cell, step, size = 'full', onPress, labelled = false, className }: StampProps) {
  const { timezone } = useUi();
  const time = cell.state === 'done' && cell.at ? ' ' + formatTime(cell.at, timezone) : '';
  const label = stampLabel(cell, step) + time + (cell.pending ? ' · ' + t('pendingStamp') : '') + (cell.processing ? ' · ' + t('processing') : '');
  const classes = ['sn-stamp-cell', 'is-' + cell.state, className ?? ''].filter(Boolean).join(' ');
  if (cell.state === 'na' || !onPress) {
    return (
      <span className={classes} role="img" aria-label={label}>
        <StampMark cell={cell} step={step} size={size} labelled={labelled} />
      </span>
    );
  }
  const press = (event: MouseEvent) => {
    event.stopPropagation();
    onPress();
  };
  return (
    <button type="button" className={classes} aria-label={label} aria-busy={cell.processing ? true : undefined} onClick={press}>
      <StampMark cell={cell} step={step} size={size} labelled={labelled} />
    </button>
  );
}

export interface StampGroupMember {
  columnKey: string;
  cell: StampCell;
  step: StampStepRow | undefined;
}

export interface StampGroupProps {
  members: StampGroupMember[];
  /** 읽기 모델이 준 다음 단계. 없으면 칸 순서에서 끝나지 않은 첫 도장. */
  nextStepKey?: string;
  onPress?: (member: StampGroupMember) => void;
}

/** 폭이 모자라 모인 도장 칸: 다음 할 단계 하나만('반납 ○'). 전체 도장은 접수증에서 본다. */
export function StampGroup({ members, nextStepKey, onPress }: StampGroupProps) {
  const open = (m: StampGroupMember) => m.cell.state !== 'done' && m.cell.state !== 'na';
  const shown = members.find((m) => m.cell.stepKey === nextStepKey) ?? members.find(open) ?? members.at(-1);
  if (!shown) return null;
  const label = stampLabel(shown.cell, shown.step);
  const classes = 'sn-stamp-cell is-collapsed is-' + shown.cell.state;
  const body = (
    <>
      <span className="sn-stamp-name">{shown.step?.short_label ?? shown.step?.label ?? ''}</span>
      <StampMark cell={shown.cell} step={shown.step} size="mini" />
    </>
  );
  if (shown.cell.state === 'na' || !onPress) return <span className={classes} role="img" aria-label={label}>{body}</span>;
  return (
    <button type="button" className={classes} aria-label={label} onClick={(event) => { event.stopPropagation(); onPress(shown); }}>
      {body}
    </button>
  );
}

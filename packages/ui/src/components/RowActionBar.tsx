// 고른 줄의 동작 줄(ui 5 RowActionBar, 6-3): 줄을 고르면 바닥줄 자리에 '▲ 위로 · ▼ 아래로 · 맨 위로 · 못 받음 · 전화 · 닫기'
// (기사 56px 이상, ▲ · ▼는 자주 누르므로 더 넓게). 길게 누르기에 기대지 않는다(장갑, 고령). 동작 목록 · 순서 · 우선순위는
// 화면 설정(ledger_view_actions)에서, 누를 수 있는지는 읽기 모델에서 온다. '닫기'는 늘 끝에 있고 고르기를 끝낸다.
// 폭이 모자라면 잰 폭으로 차례대로 줄인다: ① 우선순위가 가장 낮은 동작 하나(시간순 되돌리기)를 빼고 ② 그림이 있는 버튼
// (▲ · ▼ · 전화)의 낱말을 우선순위 낮은 것부터 빼고 ③ 그래도 넘치면 우선순위 낮은 동작부터 뺀다. 우선순위가 없는 동작은 빠지지 않는다.
import type { ActionKey } from '@skinote/contract';
import { useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '../icons.tsx';
import { useElementSize, useFontsVersion, useIsoLayoutEffect } from '../measure.ts';
import { t } from '../strings.ko-KR.ts';

export interface RowAction {
  key: ActionKey;
  /** 보이는 낱말('못 받음', '위로'). */
  label: string;
  /** 낱말 앞의 글자 그림('▲'). 좁으면 이것만 남는다. */
  glyph?: string;
  icon?: IconName;
  disabled?: boolean;
  /** 누를 수 없는 까닭(읽어 주는 이름에 붙는다). */
  reason?: string;
  /** 자주 누르는 버튼(▲ · ▼): 더 넓게. */
  repeat?: boolean;
  /** 폭이 모자랄 때 낮은 것부터 줄어든다(ledger_view_actions.priority). 없으면 줄지 않는다. */
  priority?: number;
}

export interface RowActionBarProps {
  actions: RowAction[];
  onAction: (key: ActionKey) => void;
  /** 고르기 끝(닫기). 있으면 늘 끝에 보인다. */
  onClose?: () => void;
}

type Step = { kind: 'hide' | 'compact'; key: ActionKey };

/** 줄이는 차례: 가장 낮은 동작 하나 빼기 → 그림 있는 버튼의 낱말 빼기 → 나머지를 낮은 것부터 빼기. */
export function rowBarSteps(actions: readonly RowAction[]): Step[] {
  const ranked = actions.filter((a) => a.priority !== undefined).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const [lowest, ...rest] = ranked;
  if (!lowest) return [];
  return [
    { kind: 'hide', key: lowest.key },
    ...rest.filter((a) => a.glyph || a.icon).map((a): Step => ({ kind: 'compact', key: a.key })),
    ...rest.map((a): Step => ({ kind: 'hide', key: a.key })),
  ];
}

export function RowActionBar({ actions, onAction, onClose }: RowActionBarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  const fonts = useFontsVersion();
  const signature = actions.map((a) => a.key + ':' + a.label + ':' + (a.priority ?? '')).join('|');
  const steps = useMemo(() => rowBarSteps(actions), [signature]);
  const [applied, setApplied] = useState(0);
  // 크기 · 글꼴 · 동작이 바뀌면 모두 보인 채로 다시 잰다.
  useIsoLayoutEffect(() => { setApplied(0); }, [size?.width, fonts, signature]);
  useIsoLayoutEffect(() => {
    const bar = ref.current;
    if (!bar || applied >= steps.length) return;
    const buttons = [...bar.querySelectorAll('button')];
    const over = bar.scrollWidth > bar.clientWidth + 1 || buttons.some((b) => b.scrollWidth > b.clientWidth + 1);
    if (over) setApplied(applied + 1);
  });
  const done = steps.slice(0, applied);
  const hidden = new Set(done.filter((s) => s.kind === 'hide').map((s) => s.key));
  const compact = new Set(done.filter((s) => s.kind === 'compact').map((s) => s.key));
  return (
    <div ref={ref} className="sn-rowbar" role="toolbar">
      {actions.filter((a) => !hidden.has(a.key)).map((action) => {
        const wordShown = !compact.has(action.key) || (!action.glyph && !action.icon);
        return (
          <button
            key={action.key}
            type="button"
            className={['sn-action-button', action.repeat ? 'is-repeat' : '', wordShown ? '' : 'is-compact'].filter(Boolean).join(' ')}
            aria-label={action.reason ? action.label + ' · ' + action.reason : action.label}
            disabled={action.disabled}
            onClick={() => onAction(action.key)}
          >
            {action.glyph ? <span className="sn-action-glyph" aria-hidden="true">{action.glyph}</span> : null}
            {action.icon ? <Icon name={action.icon} /> : null}
            {wordShown ? <span>{action.label}</span> : null}
          </button>
        );
      })}
      {onClose ? (
        <button type="button" className="sn-action-button is-close" onClick={onClose}>
          <span>{t('close')}</span>
        </button>
      ) : null}
    </div>
  );
}

// 버튼 이름 짓기: 동작 이름(sys_actions.label) + 읽기 모델이 준 수('지급 도장 · 6개', '수납 도장 · 120,000원').
// 수를 세지 않는다 — 서버가 준 figure를 글자로 바꾸기만 한다.
import { ACTION_LABELS, type ActionKey, type PrimaryFigure } from '@skinote/contract';
import { formatWon, t } from '@skinote/ui';

export function actionLabel(key: ActionKey): string {
  return ACTION_LABELS[key];
}

/** '120,000원', '6개', '6개 · 3매'(확인 창의 수와 같은 셈: 개로 세는 장비 + 다른 단위). */
export function figureText(figure: PrimaryFigure | undefined): string {
  if (!figure) return '';
  if (figure.amount !== undefined && figure.amount > 0) return formatWon(figure.amount);
  const parts = [
    ...(figure.count !== undefined && figure.count > 0 ? [t('count', { n: figure.count })] : []),
    ...(figure.units ?? []).filter((u) => u.qty > 0).map((u) => u.qty + u.unit),
  ];
  return parts.join(' · ');
}

/** 주 버튼 이름과 짧은 이름들(폭이 모자라면 뒤의 것). */
export function stepButton(key: ActionKey, figure: PrimaryFigure | undefined): { label: string; alts: string[] } {
  const name = actionLabel(key);
  const fig = figureText(figure);
  const label = fig ? name + ' · ' + fig : name;
  // 좁으면 다른 단위부터 빼고('지급 도장 · 6개'), 그다음 수를 뺀다.
  const count = figure?.count ? name + ' · ' + t('count', { n: figure.count }) : null;
  return { label, alts: fig ? [label, ...(count && count !== label ? [count] : []), name] : [name] };
}

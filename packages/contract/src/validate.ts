// 화면 설정 행의 검사. 데이터베이스의 FK · CHECK가 막는 것과 같은 것을 파일(ui-defaults.json)과
// 설정 명령 앞에서 미리 본다: 먼저 모양(필드 · 형식, shape.ts), 그다음 어휘와 행 사이의 약속.
// 칸이 화면에 들어가는지(4-2 폭 계산)는 @skinote/layout이 따로 본다.
import type { LedgerColumnRow, LedgerViewRow, UiDefaults } from './config.ts';
import { resolveLedgerView } from './config.ts';
import {
  ACTION_KIND, ALIGN_KEYS, COLUMN_BINDING, COLUMN_RENDERER_KEYS, CONDITION_SCOPE, DEVICE_CLASS_KEYS, FEATURE_KEYS,
  FIT_MODE_KEYS, FOLD_MODE_KEYS, GROUP_KEYS, LATE_ONLY_TONES, LEDGER_FILTER_KEYS, LEDGER_METRIC_KEYS, OVERFLOW_MODE_KEYS,
  ROW_GRAIN_KEYS, SCREEN_ROUTES, SCREEN_TEMPLATE_KEYS, SORT_KEY_IS_TIME, STAMP_ROLLUP_KEYS, STAMP_RULE_SCOPE,
  STATUS_DOMAIN_KEYS, TONE_KEYS, WORKSPACE_KEYS,
} from './vocab.ts';
import { STATUS_DEFAULT_LABELS } from './status-terms.ts';
import { checkShape, UI_DEFAULTS_SHAPE } from './shape.ts';

/** 도장 칸의 최소 폭(em)은 설정이 아니라 도장 글자에서 나온다(ui 4-2). */
export const STAMP_MIN_WIDTH_EM = { text: 4, timed: 5.5 } as const;

const has = (list: readonly string[], value: string | null | undefined): boolean => value === null || value === undefined || list.includes(value);

/**
 * 문제를 한 줄씩 돌려준다(없으면 빈 배열). JSON을 그대로(unknown) 받는다: 모양이 틀리면 모양 문제만 돌려주고
 * 어휘는 보지 않는다(모양이 맞아야 행을 읽을 수 있다).
 */
export function validateUiDefaults(input: unknown): string[] {
  const problems: string[] = [];
  const add = (where: string, message: string) => problems.push(where + ': ' + message);
  checkShape(input, UI_DEFAULTS_SHAPE, 'ui_defaults', add);
  if (problems.length) return problems;
  const defaults = input as UiDefaults;
  const stepKeys = new Map(defaults.stamp_steps.map((s) => [s.key, s] as const));

  if (stepKeys.size !== defaults.stamp_steps.length) add('stamp_steps', 'key가 겹친다');
  for (const step of defaults.stamp_steps) {
    const where = 'stamp_steps.' + step.key;
    if (!(step.rule_key in STAMP_RULE_SCOPE)) add(where, '모르는 도장 규칙 ' + step.rule_key);
    if (!(step.action_key in ACTION_KIND)) add(where, '모르는 동작 ' + step.action_key);
    else if (ACTION_KIND[step.action_key] !== 'stamp') add(where, '도장 단계의 동작이 도장 동작이 아니다: ' + step.action_key);
    if (!has(TONE_KEYS, step.tone_key)) add(where, '모르는 색 ' + step.tone_key);
    if (step.tone_key && LATE_ONLY_TONES.includes(step.tone_key)) add(where, '도장에 늦음 빨강을 쓸 수 없다(도장 주홍 seal)');
    if (!has(FEATURE_KEYS, step.feature_key)) add(where, '모르는 기능 ' + step.feature_key);
    if (!step.stamp_text.trim() || !step.checklist_label.trim() || !step.label.trim()) add(where, '빈 문구');
  }

  const viewIds = new Set<string>();
  for (const view of defaults.ledger_views) {
    const where = 'ledger_views.' + view.key + '/' + view.device_class_key;
    if (viewIds.has(where)) add(where, '같은 화면 · 등급이 두 번 있다');
    viewIds.add(where);
    checkView(view, where, add);
    if (view.base_view && !defaults.ledger_views.some((v) => v.key === view.base_view?.key && v.device_class_key === view.base_view.device_class_key)) {
      add(where, '바탕 판이 없다');
      continue;
    }
    const resolved = resolveLedgerView(defaults.ledger_views, view.key, view.device_class_key);
    if (!resolved) continue;
    const columnKeys = new Set(resolved.columns.map((c) => c.column_key));
    if (columnKeys.size !== resolved.columns.length) add(where, 'column_key가 겹친다');
    for (const column of resolved.columns) checkColumn(column, where + '.' + column.column_key, columnKeys, stepKeys, add);
    const tabKeys = new Set(resolved.tabs.map((t) => t.tab_key));
    if (tabKeys.size !== resolved.tabs.length) add(where, 'tab_key가 겹친다');
    if (resolved.primary_actions.length === 0) add(where, '주 버튼 행이 없다');
    if (!resolved.primary_actions.some((p) => p.condition_key === 'always')) add(where, "마지막 주 버튼은 조건 'always'여야 한다");
  }

  for (const entry of defaults.menu_entries) {
    const where = 'menu_entries.' + entry.workspace_key + '.' + entry.key;
    if (!has(WORKSPACE_KEYS, entry.workspace_key)) add(where, '모르는 일터');
    if (!(entry.screen_key in SCREEN_ROUTES)) add(where, '모르는 화면 ' + entry.screen_key);
    if (!has(OVERFLOW_MODE_KEYS, entry.overflow_key)) add(where, '모르는 넘칠 때 ' + entry.overflow_key);
    if (!has(FEATURE_KEYS, entry.feature_key)) add(where, '모르는 기능 ' + entry.feature_key);
    if (!has(DEVICE_CLASS_KEYS, entry.device_class_key)) add(where, '모르는 등급 ' + entry.device_class_key);
  }

  const termKeys = new Set<string>();
  for (const term of defaults.status_terms) {
    const where = 'status_terms.' + term.domain_key + '.' + term.key + '.' + term.locale;
    if (termKeys.has(where)) add(where, '겹친다');
    termKeys.add(where);
    if (!has(STATUS_DOMAIN_KEYS, term.domain_key)) { add(where, '모르는 상태 묶음'); continue; }
    const known: Readonly<Record<string, string>> = STATUS_DEFAULT_LABELS[term.domain_key];
    if (!(term.key in known)) add(where, 'sys_status_keys에 없는 상태');
    if (!has(TONE_KEYS, term.tone_key)) add(where, '모르는 색 ' + term.tone_key);
    // 상태 문구는 늦음을 나타내지 않는다: 늦음은 lateAt과 지금 시각으로 화면이 칠한다(N8).
    if (LATE_ONLY_TONES.includes(term.tone_key)) add(where, '늦음 빨강은 상태 문구에 쓸 수 없다');
  }
  return problems;
}

function checkView(view: LedgerViewRow, where: string, add: (where: string, message: string) => void): void {
  if (!has(DEVICE_CLASS_KEYS, view.device_class_key)) add(where, '모르는 등급');
  if (!has(Object.keys(SCREEN_ROUTES), view.screen_key)) add(where, '모르는 화면 ' + view.screen_key);
  if (!has(SCREEN_TEMPLATE_KEYS, view.template_key)) add(where, '모르는 틀 ' + view.template_key);
  if (!has(ROW_GRAIN_KEYS, view.row_grain_key)) add(where, '모르는 줄 단위 ' + view.row_grain_key);
  if (!has(GROUP_KEYS, view.group_by_key) || !has(GROUP_KEYS, view.subgroup_by_key)) add(where, '모르는 묶음 키');
  if (!has(Object.keys(SORT_KEY_IS_TIME), view.sort_key)) add(where, '모르는 정렬 키 ' + view.sort_key);
  if (view.now_line_field !== null && SORT_KEY_IS_TIME[view.now_line_field] !== true) add(where, '지금 줄 기준은 시각인 정렬 키여야 한다');
  if (view.reorderable === 1 && view.sort_key !== 'manual_route') add(where, '▲▼는 방문 순서 정렬에서만 쓴다');
  if (!has(FEATURE_KEYS, view.feature_key)) add(where, '모르는 기능 ' + view.feature_key);
  for (const tab of view.tabs ?? []) {
    if (!has(LEDGER_FILTER_KEYS, tab.filter_key)) add(where + '.tabs.' + tab.tab_key, '모르는 필터 ' + tab.filter_key);
    if (!has(OVERFLOW_MODE_KEYS, tab.overflow_key) || !has(FEATURE_KEYS, tab.feature_key)) add(where + '.tabs.' + tab.tab_key, '모르는 키');
  }
  for (const metric of view.metrics ?? []) {
    const w = where + '.metrics.' + metric.metric_key;
    if (!has(LEDGER_METRIC_KEYS, metric.metric_key)) add(w, '모르는 숫자');
    if (!has(OVERFLOW_MODE_KEYS, metric.overflow_key) || !has(FIT_MODE_KEYS, metric.fit_mode_key) || !has(FEATURE_KEYS, metric.feature_key)) add(w, '모르는 키');
  }
  for (const primary of view.primary_actions ?? []) {
    if (!(primary.action_key in ACTION_KIND)) add(where + '.primary', '모르는 동작 ' + primary.action_key);
    if (!(primary.condition_key in CONDITION_SCOPE)) add(where + '.primary', '모르는 조건 ' + primary.condition_key);
    else if (!['any', 'view'].includes(CONDITION_SCOPE[primary.condition_key])) add(where + '.primary', '주 버튼 조건은 화면 조건이어야 한다: ' + primary.condition_key);
  }
  for (const action of view.actions ?? []) {
    const w = where + '.actions.' + action.action_key;
    if (!(action.action_key in ACTION_KIND)) add(w, '모르는 동작');
    if (!(action.condition_key in CONDITION_SCOPE)) add(w, '모르는 조건 ' + action.condition_key);
    if (!has(OVERFLOW_MODE_KEYS, action.overflow_key) || !has(FEATURE_KEYS, action.feature_key)) add(w, '모르는 키');
  }
}

function checkColumn(
  column: LedgerColumnRow,
  where: string,
  columnKeys: ReadonlySet<string>,
  steps: ReadonlyMap<string, UiDefaults['stamp_steps'][number]>,
  add: (where: string, message: string) => void,
): void {
  if (!has(COLUMN_RENDERER_KEYS, column.renderer_key)) { add(where, '모르는 그리기 ' + column.renderer_key); return; }
  if (!has(FIT_MODE_KEYS, column.fit_mode_key) || !has(FOLD_MODE_KEYS, column.fold_mode_key) || !has(ALIGN_KEYS, column.align_key)) add(where, '모르는 맞춤 · 합침 · 정렬 키');
  if (!has(STAMP_ROLLUP_KEYS, column.stamp_rollup_key) || !has(FEATURE_KEYS, column.feature_key)) add(where, '모르는 키');
  if (column.min_width_em < 2.5) add(where, '최소 폭은 2.5em 이상');
  if (column.preferred_width_em < column.min_width_em) add(where, '원하는 폭이 최소 폭보다 작다');
  if (column.weight < 0) add(where, '비율은 0 이상');
  if (column.fold_into_column_key !== null) {
    if (column.fold_into_column_key === column.column_key) add(where, '자기 칸에 합칠 수 없다');
    else if (!columnKeys.has(column.fold_into_column_key)) add(where, '합칠 칸이 같은 화면에 없다: ' + column.fold_into_column_key);
    if (column.drop_priority <= 0) add(where, '합쳐지는 칸은 빠지는 순서(drop_priority)가 있어야 한다');
  }
  const binding = COLUMN_BINDING[column.renderer_key];
  const bound = [column.step_keys?.length ? 'stamp_step' : null, column.attribute_key ? 'attribute' : null, column.action_key ? 'action' : null].filter(Boolean);
  if (bound.length > 1) add(where, '연결은 하나만');
  if (binding === 'none' && bound.length) add(where, '이 그리기에는 연결이 없어야 한다');
  if (binding !== 'none' && bound[0] !== binding) add(where, '그리기에 맞는 연결이 없다: ' + binding);
  if (column.action_key && !(column.action_key in ACTION_KIND)) add(where, '모르는 동작 ' + column.action_key);
  if (binding === 'stamp_step') {
    const chain = column.step_keys ?? [];
    for (const key of chain) if (!steps.has(key)) add(where, '없는 도장 단계 ' + key);
    if (chain.length > 1 && column.stamp_rollup_key !== 'first_open') add(where, "단계 사슬은 'first_open'으로 모은다");
    const timed = chain.some((key) => steps.get(key)?.shows_time === 1);
    const floor = timed ? STAMP_MIN_WIDTH_EM.timed : STAMP_MIN_WIDTH_EM.text;
    if (column.min_width_em < floor) add(where, '도장 칸 최소 폭은 ' + floor + 'em 이상(도장 글자에서 나옴)');
  } else if (column.collapse_group_key !== null) {
    add(where, '도장 칸만 모일 수 있다');
  }
}

/** 모양 · 어휘 검사를 거친 뒤에만 UiDefaults로 쓴다. 문제가 있으면 모두 적어 던진다. */
export function parseUiDefaults(input: unknown): UiDefaults {
  const problems = validateUiDefaults(input);
  if (problems.length) throw new Error('화면 기본 설정이 틀렸다:\n' + problems.join('\n'));
  return input as UiDefaults;
}

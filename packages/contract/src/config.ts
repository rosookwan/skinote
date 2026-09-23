// 화면 설정(레지스트리) 행의 형식과, 설정을 화면에 맞게 푸는 순수 함수들(ui 2 · 3절).
// 행의 필드 이름은 매장 파일의 열 이름(snake_case)과 같다. ui-defaults.json의 행이 그대로 시스템 행이 되고,
// ui_defaults.apply가 키(stamp_step_key 등)를 매장 파일의 id로 바꿔 넣는다.
// 여기 함수는 업무 규칙을 계산하지 않는다: 기능 켜짐, 등급 판 폴백, 바탕 판 물려받기, 주 버튼 조건 고르기뿐이다.
import type { StatusTermRow } from './status-terms.ts';
import {
  DEVICE_CLASS_FALLBACK,
  type ActionKey, type AlignKey, type ColumnRendererKey, type ConditionKey, type DeviceClassKey, type FeatureKey,
  type FitModeKey, type FoldModeKey, type GroupKey, type LedgerFilterKey, type LedgerMetricKey, type OverflowModeKey,
  type RowGrainKey, type ScreenKey, type ScreenTemplateKey, type SortKey, type StampRollupKey, type StampRuleKey,
  type ToneKey, type WorkspaceKey,
} from './vocab.ts';

export type Flag = 0 | 1;

/** 기능으로 보이고 숨는 행의 공통 열(ui 3-8). */
export interface FeatureGate {
  feature_key: FeatureKey | null;
  /** 1: 기능이 켜졌을 때만, 0: 꺼졌을 때만 보임. 열이 없는 표(stamp_steps)는 빠지고 1로 본다. */
  feature_on?: Flag;
}

/** 도장 단계(ui 3-2, stamp_steps). */
export interface StampStepRow extends FeatureGate {
  key: string;
  label: string;
  short_label: string | null;
  stamp_text: string;
  checklist_label: string;
  rule_key: StampRuleKey;
  action_key: ActionKey;
  required_permission_key: string | null;
  urgency_out: number;
  urgency_back: number;
  tone_key: ToneKey | null;
  shows_time: Flag;
  sort: number;
}

/** 장부 칸(ui 3-4, ledger_view_columns). 폭은 등급 기본 글자 크기의 em. */
export interface LedgerColumnRow extends FeatureGate {
  column_key: string;
  seq: number;
  header_label: string;
  short_header_label: string | null;
  renderer_key: ColumnRendererKey;
  /** 도장 칸의 단계 사슬(ledger_view_column_steps). 하나면 단계 하나, 여럿이면 first_open으로 첫 남은 단계. */
  step_keys: string[] | null;
  stamp_rollup_key: StampRollupKey | null;
  attribute_key: string | null;
  action_key: ActionKey | null;
  min_width_em: number;
  preferred_width_em: number;
  weight: number;
  drop_priority: number;
  fold_into_column_key: string | null;
  fold_mode_key: FoldModeKey;
  fold_min_share_em: number;
  collapse_group_key: string | null;
  fit_mode_key: FitModeKey;
  align_key: AlignKey;
}

/** 색인 탭(ledger_view_tabs). */
export interface LedgerTabRow extends FeatureGate {
  tab_key: string;
  label: string;
  short_label: string | null;
  filter_key: LedgerFilterKey;
  params: Record<string, unknown> | null;
  seq: number;
  priority: number;
  overflow_key: OverflowModeKey;
  shows_count: Flag;
}

/** 바닥줄 숫자(ledger_view_metrics). */
export interface LedgerMetricRow extends FeatureGate {
  metric_key: LedgerMetricKey;
  params: Record<string, unknown> | null;
  seq: number;
  label: string;
  priority: number;
  overflow_key: OverflowModeKey;
  fit_mode_key: FitModeKey;
}

/** 조건별 주 버튼(ledger_view_primary_actions): 순서대로 첫 번째로 맞는 조건(N7). */
export interface PrimaryActionRow {
  seq: number;
  action_key: ActionKey;
  condition_key: ConditionKey;
}

/** 옆 동작(ledger_view_actions). */
export interface ViewActionRow extends FeatureGate {
  action_key: ActionKey;
  condition_key: ConditionKey;
  seq: number;
  priority: number;
  overflow_key: OverflowModeKey;
  required_permission_key: string | null;
}

export interface ViewRef {
  key: string;
  device_class_key: DeviceClassKey;
}

/** 화면 정의(ui 3-5, ledger_views + 딸린 행). 바탕 판이 있으면 적은 것만 덮는다. */
export interface LedgerViewRow extends FeatureGate {
  key: string;
  device_class_key: DeviceClassKey;
  label: string;
  screen_key: ScreenKey | null;
  template_key: ScreenTemplateKey;
  base_view: ViewRef | null;
  row_grain_key: RowGrainKey;
  group_by_key: GroupKey | null;
  subgroup_by_key: GroupKey | null;
  sort_key: SortKey | null;
  now_line_field: SortKey | null;
  reorderable: Flag;
  pin_urgent: Flag;
  sort: number;
  /** 바탕 판이 있을 때: 같은 column_key는 덮고, 없는 것은 더한다. */
  columns: LedgerColumnRow[];
  /** 바탕 판이 있을 때 빠지면(undefined) 바탕 것을 쓴다. */
  tabs?: LedgerTabRow[];
  metrics?: LedgerMetricRow[];
  primary_actions?: PrimaryActionRow[];
  actions?: ViewActionRow[];
}

/** 머리줄 메뉴(ui 3-6, menu_entries). */
export interface MenuEntryRow extends FeatureGate {
  workspace_key: WorkspaceKey;
  key: string;
  label: string;
  short_label: string | null;
  screen_key: ScreenKey;
  seq: number;
  priority: number;
  overflow_key: OverflowModeKey;
  permission_key: string | null;
  device_class_key: DeviceClassKey | null;
  pinned_end: Flag;
}

/** packages/contract/ui-defaults.json의 모양. rev가 기본 설정 판 번호다. */
export interface UiDefaults {
  rev: number;
  stamp_steps: StampStepRow[];
  ledger_views: LedgerViewRow[];
  menu_entries: MenuEntryRow[];
  status_terms: StatusTermRow[];
}

/** DomainClient.config()가 주는 것: 매장 설정 + 사용 기능 + 판 번호(기기가 아는 키만). */
export interface UiConfig {
  configRev: number;
  defaultsRev: number;
  /** 기기가 아는 계약 판(devices.command_contract). */
  contract: number;
  locale: string;
  /** 매장 시간대(IANA). 시각 표시는 이것으로 한다. */
  timezone: string;
  shopName: string;
  features: Partial<Record<FeatureKey, boolean>>;
  stampSteps: StampStepRow[];
  ledgerViews: LedgerViewRow[];
  menuEntries: MenuEntryRow[];
  statusTerms: StatusTermRow[];
}

export type Features = Partial<Record<FeatureKey, boolean>>;

/** 행이 지금 기능 상태에서 보이는지(꺼진 기능은 회색으로 남지 않고 사라진다). */
export function featureVisible(row: FeatureGate, features: Features): boolean {
  if (row.feature_key === null) return true;
  const on = features[row.feature_key] === true;
  return (row.feature_on ?? 1) === 1 ? on : !on;
}

export function visibleRows<T extends FeatureGate>(rows: readonly T[], features: Features): T[] {
  return rows.filter((row) => featureVisible(row, features));
}

function findView(views: readonly LedgerViewRow[], key: string, deviceClass: DeviceClassKey): LedgerViewRow | undefined {
  return views.find((v) => v.key === key && v.device_class_key === deviceClass);
}

/** 풀어 쓴 화면 정의: 바탕 판을 물려받아 모든 목록이 채워진 모양. */
export interface ResolvedLedgerView extends Omit<LedgerViewRow, 'tabs' | 'metrics' | 'primary_actions' | 'actions' | 'base_view'> {
  /** 요청한 등급(폴백으로 다른 등급 판을 썼어도 요청한 값). */
  requested_device_class_key: DeviceClassKey;
  tabs: LedgerTabRow[];
  metrics: LedgerMetricRow[];
  primary_actions: PrimaryActionRow[];
  actions: ViewActionRow[];
}

function mergeColumns(base: readonly LedgerColumnRow[], own: readonly LedgerColumnRow[]): LedgerColumnRow[] {
  const merged = new Map(base.map((c) => [c.column_key, c] as const));
  for (const c of own) merged.set(c.column_key, c);
  return [...merged.values()].sort((a, b) => a.seq - b.seq);
}

function inheritView(views: readonly LedgerViewRow[], view: LedgerViewRow, seen: Set<string>): Omit<ResolvedLedgerView, 'requested_device_class_key'> {
  const id = view.key + '/' + view.device_class_key;
  if (seen.has(id)) throw new Error('화면 설정의 바탕 판이 돌고 돈다: ' + id);
  seen.add(id);
  const { base_view: baseRef, tabs, metrics, primary_actions, actions, ...rest } = view;
  const baseRow = baseRef ? findView(views, baseRef.key, baseRef.device_class_key) : undefined;
  if (baseRef && !baseRow) throw new Error('화면 설정의 바탕 판이 없다: ' + baseRef.key + '/' + baseRef.device_class_key);
  const base = baseRow ? inheritView(views, baseRow, seen) : undefined;
  return {
    ...rest,
    columns: base ? mergeColumns(base.columns, view.columns) : [...view.columns].sort((a, b) => a.seq - b.seq),
    tabs: tabs ?? base?.tabs ?? [],
    metrics: metrics ?? base?.metrics ?? [],
    primary_actions: primary_actions ?? base?.primary_actions ?? [],
    actions: actions ?? base?.actions ?? [],
  };
}

/**
 * 화면 키와 등급으로 쓸 화면 정의를 고른다. 등급 판이 없으면 pos_narrow → pos, driver_phone → driver_tablet 순(ui 3-5),
 * 바탕 판(base_view)의 칸 · 탭 · 숫자 · 동작을 물려받고 적은 것만 덮는다. 없으면 undefined.
 */
export function resolveLedgerView(views: readonly LedgerViewRow[], key: string, deviceClass: DeviceClassKey): ResolvedLedgerView | undefined {
  let cls: DeviceClassKey | undefined = deviceClass;
  while (cls) {
    const hit = findView(views, key, cls);
    if (hit) return { ...inheritView(views, hit, new Set()), requested_device_class_key: deviceClass };
    cls = DEVICE_CLASS_FALLBACK[cls];
  }
  return undefined;
}

/** 기능으로 거른 화면 정의(칸 · 탭 · 숫자 · 동작). 주 버튼 행에는 기능 열이 없다. */
export function visibleView(view: ResolvedLedgerView, features: Features): ResolvedLedgerView {
  return {
    ...view,
    columns: visibleRows(view.columns, features),
    tabs: visibleRows(view.tabs, features),
    metrics: visibleRows(view.metrics, features),
    actions: visibleRows(view.actions, features),
  };
}

/**
 * 주 버튼 하나를 고른다: seq 순서로 첫 번째로 맞는 조건(N7). 'always'는 늘 맞고, 나머지 조건이 맞는지는
 * 읽기 모델이 준 activeConditions(서버가 계산)로만 본다. 맞는 것이 없으면 null.
 */
export function pickPrimaryAction(rows: readonly PrimaryActionRow[], activeConditions: readonly ConditionKey[]): PrimaryActionRow | null {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  return sorted.find((row) => row.condition_key === 'always' || activeConditions.includes(row.condition_key)) ?? null;
}

/** 옆 동작을 읽기 모델이 준 능력(조건)으로 거른다. 순서는 seq. */
export function availableActions(rows: readonly ViewActionRow[], activeConditions: readonly ConditionKey[]): ViewActionRow[] {
  return rows
    .filter((row) => row.condition_key === 'always' || activeConditions.includes(row.condition_key))
    .sort((a, b) => a.seq - b.seq);
}

/** 메뉴 칸: 일터 · 등급 · 기능 · 권한으로 거른다(등급 칸 수로 자르는 것은 layout의 fitList). */
export function menuFor(
  rows: readonly MenuEntryRow[],
  workspace: WorkspaceKey,
  deviceClass: DeviceClassKey,
  features: Features,
  permissions: ReadonlySet<string> | null,
): MenuEntryRow[] {
  return rows
    .filter((row) => row.workspace_key === workspace)
    .filter((row) => row.device_class_key === null || row.device_class_key === deviceClass)
    .filter((row) => featureVisible(row, features))
    .filter((row) => row.permission_key === null || permissions === null || permissions.has(row.permission_key))
    .sort((a, b) => a.seq - b.seq);
}

/** 도장 단계를 key로 찾는 표(기능이 꺼진 단계는 빠진다). */
export function stampStepMap(rows: readonly StampStepRow[], features: Features): ReadonlyMap<string, StampStepRow> {
  return new Map(visibleRows(rows, features).map((row) => [row.key, row] as const));
}

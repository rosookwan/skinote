// 화면 설정 행의 모양(필드 · 형식) 검사. ui-defaults.json과 설정 명령의 행은 JSON이라 형식 검사기가 보지 못한다:
// 여기서 빠진 필드, 문자열로 적은 숫자, true/false로 적은 0/1, 모르는 필드를 잡는다. 어휘(키 목록)는 validate.ts가 본다.

/** 필드 형식: 글자 · 빈 값 허용 글자 · 정수 · 0 이상 수 · 0보다 큰 em · 0/1 · 글자 목록 · 객체 · 바탕 판 참조 · 행 목록. */
export type FieldKind =
  | 'string' | 'string?' | 'int' | 'nonneg' | 'em' | 'flag' | 'flag?' | 'strings?' | 'object?' | 'ref?'
  | { rows: Shape; optional?: boolean };

export type Shape = Readonly<Record<string, FieldKind>>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function kindProblem(kind: Exclude<FieldKind, object>, value: unknown): string | null {
  switch (kind) {
    case 'string': return typeof value === 'string' ? null : '글자여야 한다';
    case 'string?': return value === null || typeof value === 'string' ? null : '글자나 null이어야 한다';
    case 'int': return finite(value) && Number.isInteger(value) ? null : '정수여야 한다';
    case 'nonneg': return finite(value) && value >= 0 ? null : '0 이상의 수여야 한다';
    case 'em': return finite(value) && value > 0 ? null : '0보다 큰 em 수여야 한다';
    case 'flag':
    case 'flag?': return value === 0 || value === 1 ? null : '0 또는 1이어야 한다';
    case 'strings?': return value === null || (Array.isArray(value) && value.every((v) => typeof v === 'string')) ? null : '글자 목록이나 null이어야 한다';
    case 'object?': return value === null || isObject(value) ? null : '객체나 null이어야 한다';
    case 'ref?': return value === null || (isObject(value) && typeof value['key'] === 'string' && typeof value['device_class_key'] === 'string') ? null : '{ key, device_class_key }나 null이어야 한다';
  }
}

const optional = (kind: FieldKind) => kind === 'flag?' || (typeof kind === 'object' && kind.optional === true);

/** 행 하나를 모양과 맞춘다: 빠진 필드(선택 필드 제외), 모르는 필드, 형식. 행 목록 필드는 안으로 들어간다. */
export function checkShape(value: unknown, shape: Shape, where: string, add: (where: string, message: string) => void): void {
  if (!isObject(value)) { add(where, '객체여야 한다'); return; }
  for (const key of Object.keys(value)) if (!(key in shape)) add(where, '모르는 필드 ' + key);
  for (const [key, kind] of Object.entries(shape)) {
    const field = value[key];
    if (field === undefined) {
      if (!optional(kind)) add(where, '빠진 필드 ' + key);
      continue;
    }
    if (typeof kind === 'object') {
      if (!Array.isArray(field)) { add(where + '.' + key, '목록이어야 한다'); continue; }
      field.forEach((row, i) => checkShape(row, kind.rows, where + '.' + key + '[' + i + ']', add));
      continue;
    }
    const problem = kindProblem(kind, field);
    if (problem) add(where + '.' + key, problem + '(지금 ' + JSON.stringify(field) + ')');
  }
}

const GATE = { feature_key: 'string?', feature_on: 'flag?' } as const satisfies Shape;

export const STAMP_STEP_SHAPE: Shape = {
  key: 'string', label: 'string', short_label: 'string?', stamp_text: 'string', checklist_label: 'string', rule_key: 'string',
  action_key: 'string', required_permission_key: 'string?', urgency_out: 'int', urgency_back: 'int', tone_key: 'string?',
  shows_time: 'flag', sort: 'int', ...GATE,
};

export const COLUMN_SHAPE: Shape = {
  column_key: 'string', seq: 'int', header_label: 'string', short_header_label: 'string?', renderer_key: 'string', step_keys: 'strings?',
  stamp_rollup_key: 'string?', attribute_key: 'string?', action_key: 'string?', min_width_em: 'em', preferred_width_em: 'em', weight: 'nonneg',
  drop_priority: 'int', fold_into_column_key: 'string?', fold_mode_key: 'string', fold_min_share_em: 'nonneg', collapse_group_key: 'string?',
  fit_mode_key: 'string', align_key: 'string', ...GATE,
};

export const TAB_SHAPE: Shape = {
  tab_key: 'string', label: 'string', short_label: 'string?', filter_key: 'string', params: 'object?', seq: 'int', priority: 'int',
  overflow_key: 'string', shows_count: 'flag', ...GATE,
};

export const METRIC_SHAPE: Shape = {
  metric_key: 'string', params: 'object?', seq: 'int', label: 'string', priority: 'int', overflow_key: 'string', fit_mode_key: 'string', ...GATE,
};

export const PRIMARY_SHAPE: Shape = { seq: 'int', action_key: 'string', condition_key: 'string' };

export const ACTION_SHAPE: Shape = {
  action_key: 'string', condition_key: 'string', seq: 'int', priority: 'int', overflow_key: 'string', required_permission_key: 'string?', ...GATE,
};

export const VIEW_SHAPE: Shape = {
  key: 'string', device_class_key: 'string', label: 'string', screen_key: 'string?', template_key: 'string', base_view: 'ref?',
  row_grain_key: 'string', group_by_key: 'string?', subgroup_by_key: 'string?', sort_key: 'string?', now_line_field: 'string?',
  reorderable: 'flag', pin_urgent: 'flag', sort: 'int', ...GATE,
  columns: { rows: COLUMN_SHAPE },
  tabs: { rows: TAB_SHAPE, optional: true },
  metrics: { rows: METRIC_SHAPE, optional: true },
  primary_actions: { rows: PRIMARY_SHAPE, optional: true },
  actions: { rows: ACTION_SHAPE, optional: true },
};

export const MENU_SHAPE: Shape = {
  workspace_key: 'string', key: 'string', label: 'string', short_label: 'string?', screen_key: 'string', seq: 'int', priority: 'int',
  overflow_key: 'string', permission_key: 'string?', device_class_key: 'string?', pinned_end: 'flag', ...GATE,
};

export const STATUS_TERM_SHAPE: Shape = { domain_key: 'string', key: 'string', locale: 'string', label: 'string', tone_key: 'string', rank: 'int' };

export const UI_DEFAULTS_SHAPE: Shape = {
  rev: 'int',
  stamp_steps: { rows: STAMP_STEP_SHAPE },
  ledger_views: { rows: VIEW_SHAPE },
  menu_entries: { rows: MENU_SHAPE },
  status_terms: { rows: STATUS_TERM_SHAPE },
};

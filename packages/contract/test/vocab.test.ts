// 코드 쪽 어휘(src/vocab.ts, status-terms.ts)가 schema.sql의 sys_* 시드와 같은지 본다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTION_COMMAND, ACTION_KIND, ACTION_LABELS, ACTION_SCREEN, ALIGN_KEYS, COLUMN_BINDING, COLUMN_RENDERER_KEYS, COMMAND_TYPES, CONDITION_SCOPE, CONFIRM_TEMPLATE_KEYS, DEVICE_CLASS_KEYS,
  FEATURE_KEYS, FIT_MODE_KEYS, OFFLINE_COMMANDS, offlineAllowed, FOLD_MODE_KEYS, GROUP_KEYS, LEDGER_FILTER_KEYS, LEDGER_METRIC_KEYS, OVERFLOW_MODE_KEYS,
  REVIEW_COUNT_TEMPLATES, REVIEW_TEMPLATES, reviewMessage, ROW_GRAIN_KEYS, SCREEN_ROUTES, SCREEN_TEMPLATE_KEYS, SORT_KEY_IS_TIME, STAMP_ROLLUP_KEYS, STAMP_RULE_SCOPE,
  STAMP_STATE_KEYS, STAMP_TONE_BY_STATE, STATUS_DEFAULT_LABELS, TONE_KEYS, WORKSPACE_KEYS,
} from '../src/index.ts';

// 참조 스키마는 @skinote/schema 한 곳에 있다. 없으면 건너뛰지 않고 실패한다(어휘 맞춤이 몰래 빠지지 않게).
const schemaUrl = new URL('../../schema/schema.sql', import.meta.url);
if (!existsSync(schemaUrl)) throw new Error('참조 스키마가 없다: ' + schemaUrl.pathname);
const schema = readFileSync(schemaUrl, 'utf8');
// 0001 뒤의 마이그레이션(0002 ~ 0009)이 더한 sys_* 행(features-1 plan §3-1: 0004의 조건 · 동작 · 명령). 시드와 합쳐 본다.
const migrationsUrl = new URL('../../schema/migrations/', import.meta.url);
const migrations = readdirSync(migrationsUrl).filter((name) => /^000[2-9]_shop.*\.sql$/.test(name)).sort()
  .map((name) => readFileSync(new URL(name, migrationsUrl), 'utf8'));

const insertPattern = (table: string) => new RegExp('INSERT INTO ' + table + ' \\(([^)]*)\\) VALUES([\\s\\S]*?);\\n', 'g');

/** 한 표의 시드 행: schema.sql의 마지막 INSERT 묶음(shop 시드가 뒤에 오면 그것)과 뒤 마이그레이션의 INSERT 묶음 모두. */
function seedRows(table: string): string[][] {
  const last = [...schema.matchAll(insertPattern(table))].at(-1);
  const bodies = [...(last ? [last[2] ?? ''] : []), ...migrations.flatMap((sql) => [...sql.matchAll(insertPattern(table))].map((m) => m[2] ?? ''))];
  return bodies.flatMap(rowsOf);
}

/** INSERT 묶음 하나의 행마다 따옴표 값들. */
function rowsOf(body: string): string[][] {
  const rows: string[][] = [];
  let depth = 0;
  let current = '';
  let inString = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (inString) {
      if (ch === "'" && body.charAt(i + 1) === "'") { current += "''"; i += 1; continue; }
      if (ch === "'") inString = false;
      current += ch;
      continue;
    }
    if (ch === "'") { inString = true; current += ch; continue; }
    if (ch === '(') { depth += 1; if (depth === 1) { current = ''; continue; } }
    if (ch === ')') { depth -= 1; if (depth === 0) { rows.push(splitValues(current)); continue; } }
    if (depth >= 1) current += ch;
  }
  return rows;
}

function splitValues(text: string): string[] {
  const out: string[] = [];
  let value = '';
  let inString = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      if (ch === "'" && text.charAt(i + 1) === "'") { value += "'"; i += 1; continue; }
      if (ch === "'") { inString = false; continue; }
      value += ch;
      continue;
    }
    if (ch === "'") { inString = true; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(value.trim()); value = ''; continue; }
    value += ch;
  }
  out.push(value.trim());
  return out;
}

const keysOf = (table: string) => seedRows(table).map((row) => row[0]).sort();
const sorted = (values: readonly string[]) => [...values].sort();

describe('끊긴 채 보내는 명령(OFFLINE_COMMANDS)이 sys_offline_commands 시드와 같다', () => {
  it('기기 종류마다 명령 목록이 시드 그대로, 연결이 필요한 결정은 들지 않는다', () => {
    const rows = seedRows('sys_offline_commands');
    expect(rows.length).toBeGreaterThan(0);
    for (const kind of Object.keys(OFFLINE_COMMANDS) as (keyof typeof OFFLINE_COMMANDS)[]) {
      expect(sorted(OFFLINE_COMMANDS[kind]), kind).toEqual(sorted(rows.filter((r) => r[1] === kind).map((r) => r[0]!)));
    }
    expect(offlineAllowed('pos_narrow', 'payment.take')).toBe(true);
    for (const type of ['promise.change', 'setting.set', 'closing.close', 'stock.receive', 'cash.transfer'] as const) {
      expect(offlineAllowed('pos', type), type).toBe(false);
      expect(offlineAllowed('driver_phone', type), type).toBe(false);
    }
    expect(offlineAllowed('driver_tablet', 'field.collect')).toBe(true);
  });
});

describe('어휘가 schema.sql 시드와 같다', () => {
  it.each([
    ['sys_device_classes', DEVICE_CLASS_KEYS],
    ['sys_stamp_states', STAMP_STATE_KEYS],
    ['sys_tones', TONE_KEYS],
    ['sys_column_renderers', COLUMN_RENDERER_KEYS],
    ['sys_fit_modes', FIT_MODE_KEYS],
    ['sys_fold_modes', FOLD_MODE_KEYS],
    ['sys_align_keys', ALIGN_KEYS],
    ['sys_overflow_modes', OVERFLOW_MODE_KEYS],
    ['sys_stamp_rollups', STAMP_ROLLUP_KEYS],
    ['sys_stamp_rules', Object.keys(STAMP_RULE_SCOPE)],
    ['sys_screen_templates', SCREEN_TEMPLATE_KEYS],
    ['sys_screens', Object.keys(SCREEN_ROUTES)],
    ['sys_workspaces', WORKSPACE_KEYS],
    ['sys_group_keys', GROUP_KEYS],
    ['sys_sort_keys', Object.keys(SORT_KEY_IS_TIME)],
    ['sys_ledger_filters', LEDGER_FILTER_KEYS],
    ['sys_ledger_metrics', LEDGER_METRIC_KEYS],
    ['sys_conditions', Object.keys(CONDITION_SCOPE)],
    ['sys_actions', Object.keys(ACTION_KIND)],
    ['sys_features', FEATURE_KEYS],
    ['sys_row_grains', ROW_GRAIN_KEYS],
    ['sys_confirm_templates', CONFIRM_TEMPLATE_KEYS],
  ] as const)('%s', (table, keys) => {
    const seeded = keysOf(table);
    expect(seeded.length).toBeGreaterThan(0);
    expect(sorted(keys)).toEqual(seeded);
  });

  it('칸 그리기의 연결 · 도장 규칙의 범위 · 조건의 범위 · 정렬 키의 시각 여부 · 동작 종류', () => {
    for (const [key, , binding] of seedRows('sys_column_renderers')) expect(COLUMN_BINDING[key as keyof typeof COLUMN_BINDING]).toBe(binding);
    for (const [key, scope] of seedRows('sys_stamp_rules')) expect(STAMP_RULE_SCOPE[key as keyof typeof STAMP_RULE_SCOPE]).toBe(scope);
    for (const [key, scope] of seedRows('sys_conditions')) expect(CONDITION_SCOPE[key as keyof typeof CONDITION_SCOPE]).toBe(scope);
    for (const [key, , isTime] of seedRows('sys_sort_keys')) expect(SORT_KEY_IS_TIME[key as keyof typeof SORT_KEY_IS_TIME]).toBe(isTime === '1');
    for (const [key, , kind] of seedRows('sys_actions')) expect(ACTION_KIND[key as keyof typeof ACTION_KIND]).toBe(kind);
    for (const [key, label] of seedRows('sys_actions')) expect(ACTION_LABELS[key as keyof typeof ACTION_LABELS]).toBe(label);
    for (const [key, , , command] of seedRows('sys_actions')) expect(ACTION_COMMAND[key as keyof typeof ACTION_COMMAND]).toBe(command === 'NULL' ? null : command);
    for (const [key, , , , , , screen] of seedRows('sys_actions')) {
      expect((ACTION_SCREEN as Record<string, string>)[key ?? ''] ?? 'NULL').toBe(screen);
    }
    for (const [key, , route] of seedRows('sys_screens')) expect(SCREEN_ROUTES[key as keyof typeof SCREEN_ROUTES]).toBe(route);
  });

  it('계약의 명령 이름은 모두 sys_event_types의 key다', () => {
    const events = new Set(keysOf('sys_event_types'));
    expect(events.size).toBeGreaterThan(0);
    expect(COMMAND_TYPES.filter((type) => !events.has(type))).toEqual([]);
  });

  it('도장 상태의 색과 늦음 · 도장 색 표시', () => {
    for (const [key, , tone] of seedRows('sys_stamp_states')) expect(STAMP_TONE_BY_STATE[key as keyof typeof STAMP_TONE_BY_STATE]).toBe(tone);
    const tones = Object.fromEntries(seedRows('sys_tones').map(([key, , late, seal]) => [key, { late, seal }]));
    expect(tones['red']).toEqual({ late: '1', seal: '0' });
    expect(tones['seal']).toEqual({ late: '0', seal: '1' });
  });

  it('확인 필요 종류(REVIEW_TEMPLATES)가 sys_review_kinds 시드와 같다: 이름 · 틀 · 무게 · 보일 곳(features-1 E18)', () => {
    const seeded = seedRows('sys_review_kinds');
    expect(seeded.length).toBeGreaterThan(30);
    expect(sorted(Object.keys(REVIEW_TEMPLATES))).toEqual(keysOf('sys_review_kinds'));
    for (const [key, label, template, severity, routing] of seeded) {
      expect(REVIEW_TEMPLATES[key ?? ''], key).toEqual({ label, template, severity, routing });
    }
    // 세는 말 틀은 시드 틀의 `{qty}개`(와 `{left}개`)를 `{qty}{unit}`로 바꾼 것뿐이다.
    for (const [key, counted] of Object.entries(REVIEW_COUNT_TEMPLATES)) {
      expect(counted.replace(/\{unit\}/g, '개'), key).toBe(REVIEW_TEMPLATES[key]?.template);
    }
    expect(reviewMessage('already_returned', { team: '최은정', item: '스키', qty: 1, unit: '대' })).toBe('최은정 팀 스키 1대 매장 반납 완료 · 기사 수거 기록 제외');
    expect(reviewMessage('already_returned', { team: '최은정', item: '헬멧', qty: 2, unit: '개' })).toBe('최은정 팀 헬멧 2개 매장 반납 완료 · 기사 수거 기록 제외');
    expect(reviewMessage('van_unsynced', { vehicle: '1호 차량', count: 2 })).toBe('1호 차량 기록 2건 전송 대기 · 마감 전 전송 필요');
    expect(reviewMessage('no_such_kind', {})).toBe('');
  });

  it('상태 기본 문구가 sys_status_keys와 같다', () => {
    const seeded = seedRows('sys_status_keys');
    expect(seeded.length).toBeGreaterThan(0);
    const defaults: Record<string, Record<string, string>> = STATUS_DEFAULT_LABELS;
    for (const [domain, key, label] of seeded) expect(defaults[domain ?? '']?.[key ?? '']).toBe(label);
    const count = Object.values(STATUS_DEFAULT_LABELS).reduce((n, labels) => n + Object.keys(labels).length, 0);
    expect(count).toBe(seeded.length);
  });
});

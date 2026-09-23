// 코드 쪽 어휘(src/vocab.ts, status-terms.ts)가 schema.sql의 sys_* 시드와 같은지 본다.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTION_COMMAND, ACTION_KIND, ACTION_LABELS, ACTION_SCREEN, ALIGN_KEYS, COLUMN_BINDING, COLUMN_RENDERER_KEYS, CONDITION_SCOPE, CONFIRM_TEMPLATE_KEYS, DEVICE_CLASS_KEYS,
  FEATURE_KEYS, FIT_MODE_KEYS, FOLD_MODE_KEYS, GROUP_KEYS, LEDGER_FILTER_KEYS, LEDGER_METRIC_KEYS, OVERFLOW_MODE_KEYS,
  ROW_GRAIN_KEYS, SCREEN_ROUTES, SCREEN_TEMPLATE_KEYS, SORT_KEY_IS_TIME, STAMP_ROLLUP_KEYS, STAMP_RULE_SCOPE,
  STAMP_STATE_KEYS, STAMP_TONE_BY_STATE, STATUS_DEFAULT_LABELS, TONE_KEYS, WORKSPACE_KEYS,
} from '../src/index.ts';

// 참조 스키마는 @skinote/schema 한 곳에 있다. 없으면 건너뛰지 않고 실패한다(어휘 맞춤이 몰래 빠지지 않게).
const schemaUrl = new URL('../../schema/schema.sql', import.meta.url);
if (!existsSync(schemaUrl)) throw new Error('참조 스키마가 없다: ' + schemaUrl.pathname);
const schema = readFileSync(schemaUrl, 'utf8');

/** 한 표의 첫 시드 INSERT 묶음에서 행마다 따옴표 값들을 꺼낸다(shop 시드가 뒤에 오면 마지막 것). */
function seedRows(table: string): string[][] {
  const pattern = new RegExp('INSERT INTO ' + table + ' \\(([^)]*)\\) VALUES([\\s\\S]*?);\\n', 'g');
  const blocks = [...schema.matchAll(pattern)];
  const last = blocks.at(-1);
  if (!last) return [];
  const body = last[2] ?? '';
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

  it('도장 상태의 색과 늦음 · 도장 색 표시', () => {
    for (const [key, , tone] of seedRows('sys_stamp_states')) expect(STAMP_TONE_BY_STATE[key as keyof typeof STAMP_TONE_BY_STATE]).toBe(tone);
    const tones = Object.fromEntries(seedRows('sys_tones').map(([key, , late, seal]) => [key, { late, seal }]));
    expect(tones['red']).toEqual({ late: '1', seal: '0' });
    expect(tones['seal']).toEqual({ late: '0', seal: '1' });
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

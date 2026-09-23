// @ts-check
// 장부 트리거의 모양. tools/gen-triggers.js(schema.sql의 0001 트리거를 열 목록에서 다시 만듦)와
// tools/lint.js(뒤 마이그레이션의 트리거가 data-model 7-2의 네 가지 모양인지 확인)가 같은 글을 쓴다.
// 모든 함수는 순수 함수다: 표 이름과 열 목록을 받아 SQL 글을 돌려준다.

/** 장부의 자유 글 칸. 이 이름의 열은 수정 금지 목록에서 빠지고 '(지움)'으로 가리기만 허용된다. */
export const REDACT = Object.freeze(['reason', 'memo', 'note', 'difference_reason', 'override_reason', 'resolution_note']);
/** 이름이 달라도 개인정보가 드는 자유 글 칸. */
export const EXTRA_REDACT = Object.freeze({ intake_submission_people: ['name'], intake_answers: ['value_text'] });

/** 0001의 매장 장부 표 49개(추가만). 순서가 schema.sql의 트리거 순서다. */
export const LEDGERS = Object.freeze([
  'shop_settings', 'config_changes', 'template_applications', 'ui_default_applications', 'device_sign_ins',
  'discount_applications', 'line_price_components',
  'order_cancellations', 'order_cancellation_lines', 'order_extensions', 'order_extension_lines', 'order_extension_assets',
  'intake_submissions', 'intake_submission_people', 'intake_answers', 'intake_reviews',
  'stock_movements', 'stock_movement_lines', 'stock_movement_reversals', 'asset_reclassifications', 'asset_condition_changes',
  'exchange_recoveries', 'vendor_refund_attempts', 'task_visits', 'task_reassignments',
  'payment_groups', 'payment_intent_allocations', 'payments', 'tax_documents', 'payment_reallocations', 'payment_allocations',
  'charge_adjustments', 'adjustment_assets', 'cash_entries', 'cash_transfers', 'cash_transfer_confirmations',
  'closings', 'closing_reopenings', 'closing_totals', 'closing_drawer_counts', 'closing_handover_items',
  'counterparty_trades', 'counterparty_trade_lines', 'counterparty_settlements', 'counterparty_settlement_allocations',
  'print_template_versions', 'message_template_versions', 'archive_manifests', 'archive_verifications',
]);

/** 지우지 않는 업무 행(끝남 · 취소 · 익명화로 대신). */
export const NO_DELETE = Object.freeze([
  'orders', 'order_batches', 'order_lines', 'line_promises', 'payment_promises', 'service_bookings', 'customers',
  'assets', 'asset_bindings', 'asset_claims', 'tasks', 'payment_intents', 'deposits',
]);

/** control 파일의 장부(자유 글 가리기 없음: 플랫폼 사용 내역과 템플릿 판은 통째로 고정). */
export const CONTROL_LEDGERS = Object.freeze(['platform_audit_log', 'resort_template_versions']);

/** 0001에서 손으로 쓴 트리거(게시된 요금표 고정). 생성기가 만들지 않으며 lint는 0001에서만 이 이름을 허용한다. */
export const BASELINE_HANDWRITTEN = Object.freeze({
  control: Object.freeze([]),
  shop: Object.freeze([
    'price_list_versions_frozen', 'price_list_versions_no_delete',
    'price_rules_frozen_insert', 'price_rules_frozen_update', 'price_rules_frozen_delete',
    'price_rule_tiers_frozen_insert', 'price_rule_tiers_frozen_update', 'price_rule_tiers_frozen_delete',
  ]),
});

/** order_lines에서 투영이라 계속 쓸 수 있는 열. 나머지(가격 · 수량 · 날짜 · 스냅샷 · 참조)는 만든 뒤 고정. */
export const isOrderLineProjection = (/** @type {string} */ c) =>
  /^qty_/.test(c) || ['current_end_date', 'current_end_time', 'progress_key', 'updated_at', 'updated_rev', 'version'].includes(c);

/**
 * 열 목록을 118자 안으로 줄바꿈한다(schema.sql의 모양).
 * @param {readonly string[]} list @param {string} indent
 */
export function wrap(list, indent) {
  const out = [];
  let line = indent;
  for (const [i, c] of list.entries()) {
    const piece = c + (i < list.length - 1 ? ', ' : '');
    if ((line + piece).length > 118) {
      out.push(line.trimEnd());
      line = indent;
    }
    line += piece;
  }
  out.push(line.trimEnd());
  return out.join('\n');
}

/**
 * 자유 글 칸 규칙으로 가리기만 허용할 열.
 * @param {string} table @param {readonly string[]} columns
 */
export function redactColumns(table, columns) {
  const extra = /** @type {Record<string, readonly string[]>} */ (EXTRA_REDACT)[table] || [];
  return columns.filter(c => REDACT.includes(c) || extra.includes(c));
}

/**
 * ① 장부 표의 추가 전용 트리거: 수정 금지(열 목록) + 자유 글 가리기만 + 삭제 금지.
 * @param {string} table @param {readonly string[]} columns 그 표의 모든 열(표 순서)
 * @param {{ redact?: boolean }} [options] control 장부는 redact: false
 */
export function ledgerGuards(table, columns, { redact = true } = {}) {
  const red = redact ? redactColumns(table, columns) : [];
  const fixed = columns.filter(c => !red.includes(c));
  let s = `CREATE TRIGGER ${table}_no_update BEFORE UPDATE OF\n${wrap(fixed, '  ')}\n  ON ${table} BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY ${table}'); END;\n`;
  if (red.length) {
    const cond = red.map(c => `(NEW.${c} IS NOT OLD.${c} AND NEW.${c} IS NOT '(지움)')`).join(' OR ');
    s += `CREATE TRIGGER ${table}_redact_only BEFORE UPDATE OF ${red.join(', ')} ON ${table}\n  WHEN ${cond}\n  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY ${table}'); END;\n`;
  }
  s += `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY ${table}'); END;\n`;
  return s;
}

/**
 * ② 장부 표에 더한 열의 '한 번만' 트리거(값이 들어간 뒤에는 못 바꿈). 같은 마이그레이션이 지난 행을 채운 뒤 단다.
 * @param {string} table @param {string} column
 */
export function setOnceGuard(table, column) {
  return `CREATE TRIGGER ${table}_${column}_once BEFORE UPDATE OF ${column} ON ${table} WHEN OLD.${column} IS NOT NULL BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY ${table}'); END;\n`;
}

/**
 * ③ '이 판부터 필수' 트리거(새 행부터 그 열이 꼭 있어야 함).
 * @param {string} table @param {string} column
 */
export function requiredGuard(table, column) {
  return `CREATE TRIGGER ${table}_${column}_required BEFORE INSERT ON ${table} WHEN NEW.${column} IS NULL BEGIN SELECT RAISE(ABORT, 'REQUIRED ${table}.${column}'); END;\n`;
}

/**
 * ③ 새 값 칸을 '하나만' 규칙에 잇는 트리거: 새 칸과 옛 칸들 중 값이 둘 이상이면 거절(표 안 CHECK는 옛 칸만 안다).
 * @param {string} table @param {string} column 새로 더한 칸 @param {readonly string[]} columns 규칙에 드는 모든 칸(새 칸 포함)
 */
export function oneOfGuard(table, column, columns) {
  const sum = columns.map(c => `(NEW.${c} IS NOT NULL)`).join(' + ');
  return `CREATE TRIGGER ${table}_${column}_one_of BEFORE INSERT ON ${table} WHEN ${sum} > 1 BEGIN SELECT RAISE(ABORT, 'ONE_OF ${table}'); END;\n`;
}

/**
 * ④ 장부 표에 더한 자유 글 칸의 가리기만 트리거.
 * @param {string} table @param {string} column
 */
export function redactOnlyGuard(table, column) {
  return `CREATE TRIGGER ${table}_${column}_redact_only BEFORE UPDATE OF ${column} ON ${table} WHEN (NEW.${column} IS NOT OLD.${column} AND NEW.${column} IS NOT '(지움)') BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY ${table}'); END;\n`;
}

/**
 * @callback ColumnsOf
 * @param {string} table
 * @returns {string[]} 그 표의 열(표 순서). 표가 없으면 오류.
 */

/**
 * control 0001의 생성 트리거.
 * @param {ColumnsOf} columnsOf
 */
export function controlTriggers(columnsOf) {
  return CONTROL_LEDGERS.map(t => ledgerGuards(t, columnsOf(t), { redact: false })).join('');
}

/**
 * shop 0001의 생성 트리거: 장부 49개, 작업 기록(보관 확인 뒤에만 지움), 품목 줄 고정, 업무 행 삭제 금지.
 * @param {ColumnsOf} columnsOf
 */
export function shopTriggers(columnsOf) {
  let s = LEDGERS.map(t => ledgerGuards(t, columnsOf(t))).join('');
  s += `
-- The journal: never updated; a row may be deleted only inside a season archive range that has an
-- append-only archive_verifications row (a manifest alone is not enough).
CREATE TRIGGER events_no_update BEFORE UPDATE OF
${wrap(columnsOf('events'), '  ')}
  ON events BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY events'); END;
CREATE TRIGGER events_delete_only_archived BEFORE DELETE ON events
WHEN NOT EXISTS (
  SELECT 1 FROM archive_manifests m JOIN archive_verifications v ON v.manifest_id = m.id
   WHERE m.shop_id = OLD.shop_id AND m.table_name = 'events' AND OLD.rev BETWEEN m.from_rev AND m.to_rev)
BEGIN SELECT RAISE(ABORT, 'ARCHIVE_FIRST events'); END;
`;
  const frozen = columnsOf('order_lines').filter(c => !isOrderLineProjection(c));
  s += `
-- What is owed is as fixed as what was paid: price, quantity, dates, snapshots and references of a line
-- never change after it is made (a change is a cancellation line, an extension line or an adjustment);
-- the projection columns (qty_*, current_end_*, progress_key) stay writable.
CREATE TRIGGER order_lines_frozen BEFORE UPDATE OF
${wrap(frozen, '  ')}
  ON order_lines BEGIN SELECT RAISE(ABORT, 'FROZEN order_lines'); END;
`;
  s += `
-- Business rows are never deleted (ended, cancelled or anonymised instead).
` + NO_DELETE.map(t => {
    columnsOf(t);
    return `CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, 'NO_DELETE ${t}'); END;\n`;
  }).join('');
  return s;
}

/**
 * 종류별 0001 생성 트리거.
 * @param {'control' | 'shop'} kind @param {ColumnsOf} columnsOf
 */
export function baselineTriggers(kind, columnsOf) {
  return kind === 'control' ? controlTriggers(columnsOf) : shopTriggers(columnsOf);
}

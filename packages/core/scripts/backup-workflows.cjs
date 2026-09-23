'use strict';
const { DatabaseSync } = require('node:sqlite');
const { existsSync, mkdirSync, chmodSync, copyFileSync, constants } = require('node:fs');
const { dirname, resolve } = require('node:path');

function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('데이터베이스 무결성 검사가 실패했습니다.');
    const tables = ['return_orders', 'return_events', 'workflow_state', 'workflow_events', 'notification_state'];
    return { integrity: 'ok', schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
      counts: Object.fromEntries(tables.map(table => [table, db.prepare('SELECT COUNT(*) AS total FROM ' + table).get().total])),
      workflows: db.prepare('SELECT shop_id, revision, state_json FROM workflow_state ORDER BY shop_id').all().map(row => {
        const state = JSON.parse(row.state_json);
        return { shopId: row.shop_id, revision: row.revision, orders: (state.orders || []).length, assets: state.assets.length, payments: (state.payments || []).length, closings: (state.closings || []).length, events: state.events.length };
      }) };
  } finally { db.close(); }
}
function backup(source, destination) {
  source = resolve(source); destination = resolve(destination);
  if (!existsSync(source)) throw new Error('원본 데이터베이스가 없습니다.');
  if (existsSync(destination)) throw new Error('백업 대상 파일이 이미 있습니다. 다른 이름을 사용해 주세요.');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(source, { readOnly: true });
  try { db.prepare('VACUUM INTO ?').run(destination); } finally { db.close(); }
  chmodSync(destination, 0o600);
  return inspect(destination);
}
function restore(source, destination) {
  const verified = inspect(source);
  if (existsSync(destination)) throw new Error('복원 대상이 이미 있습니다. 운영 파일을 덮어쓰지 않습니다.');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination, constants.COPYFILE_EXCL); chmodSync(destination, 0o600);
  const restored = inspect(destination);
  if (JSON.stringify(restored) !== JSON.stringify(verified)) throw new Error('복원 전후 집계가 다릅니다.');
  return restored;
}
if (require.main === module) {
  const args = process.argv.slice(2), mode = args[0];
  try {
    if (!['backup', 'restore', 'inspect'].includes(mode) || !args[1] || mode !== 'inspect' && !args[2]) throw new Error('사용: node scripts/backup-workflows.cjs backup|restore 원본 새대상 / inspect 파일');
    console.log(JSON.stringify(mode === 'backup' ? backup(args[1], args[2]) : mode === 'restore' ? restore(args[1], args[2]) : inspect(args[1]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { backup, restore, inspect };

'use strict';
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync, chmodSync } = require('node:fs');
const { dirname } = require('node:path');
const { ReturnError } = require('../src/returns/domain.js');
const N = require('../src/notifications/domain.js');

function createSqliteRepository(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
  if (schemaVersion > 3) { db.close(); throw new Error('지원하지 않는 업무 데이터베이스 버전입니다.'); }
  db.exec(`
    CREATE TABLE IF NOT EXISTS return_shops (shop_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS return_orders (
      shop_id TEXT NOT NULL, order_id TEXT NOT NULL, version INTEGER NOT NULL,
      revision INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY (shop_id, order_id)
    );
    CREATE INDEX IF NOT EXISTS return_orders_revision ON return_orders (shop_id, revision);
    CREATE TABLE IF NOT EXISTS return_events (
      shop_id TEXT NOT NULL, order_id TEXT NOT NULL, version INTEGER NOT NULL,
      request_id TEXT NOT NULL, event_json TEXT NOT NULL,
      PRIMARY KEY (shop_id, order_id, version), UNIQUE (shop_id, order_id, request_id),
      FOREIGN KEY (shop_id, order_id) REFERENCES return_orders (shop_id, order_id)
    );
    CREATE TABLE IF NOT EXISTS notification_state (shop_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_state (shop_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_events (
      shop_id TEXT NOT NULL, version INTEGER NOT NULL, actor_key TEXT NOT NULL, request_id TEXT NOT NULL, event_json TEXT NOT NULL,
      PRIMARY KEY (shop_id, version), UNIQUE (shop_id, actor_key, request_id)
    );
    PRAGMA user_version = 3;
  `);
  const getOrder = db.prepare('SELECT state_json FROM return_orders WHERE shop_id = ? AND order_id = ?');
  const getRevision = db.prepare('SELECT revision FROM return_shops WHERE shop_id = ?');
  const notificationState = shopId => {
    const row = db.prepare('SELECT state_json FROM notification_state WHERE shop_id = ?').get(shopId);
    return row ? JSON.parse(row.state_json) : N.fresh();
  };
  const saveNotifications = (shopId, state) => db.prepare('INSERT INTO notification_state VALUES (?, ?) ON CONFLICT(shop_id) DO UPDATE SET state_json = excluded.state_json').run(shopId, JSON.stringify(state));
  const workflowState = shopId => {
    const row = db.prepare('SELECT state_json FROM workflow_state WHERE shop_id = ?').get(shopId);
    if (!row) return null;
    const state = JSON.parse(row.state_json);
    if (state.schemaVersion !== 1) throw new Error('지원하지 않는 업무 데이터 버전입니다.');
    return state;
  };
  const decode = row => {
    if (!row) return null;
    const order = JSON.parse(row.state_json);
    if (order.schemaVersion !== 1) throw new Error('지원하지 않는 접수 데이터 버전입니다.');
    return order;
  };
  return {
    mode: 'sqlite',
    get: (shopId, orderId) => decode(getOrder.get(shopId, orderId)),
    list: shopId => db.prepare('SELECT state_json FROM return_orders WHERE shop_id = ? ORDER BY order_id').all(shopId).map(decode),
    notifications: notificationState,
    workflows: workflowState,
    transactWorkflows(shopId, apply) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = workflowState(shopId), notifications = notificationState(shopId), result = apply(previous, notifications);
        if (!result.duplicate) {
          db.prepare('INSERT INTO workflow_state VALUES (?, ?, ?) ON CONFLICT(shop_id) DO UPDATE SET revision = excluded.revision, state_json = excluded.state_json').run(shopId, result.state.revision, JSON.stringify(result.state));
          for (const event of result.state.events.filter(event => event.version > (previous?.revision || 0))) db.prepare('INSERT INTO workflow_events VALUES (?, ?, ?, ?, ?)').run(shopId, event.version, event.actor.role + ':' + event.actor.id, event.requestId, JSON.stringify(event));
          saveNotifications(shopId, notifications);
        }
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    transactNotifications(shopId, apply) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const state = notificationState(shopId), result = apply(state);
        saveNotifications(shopId, state); db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    transact(shopId, orderId, apply) {
      if (typeof orderId !== 'string') throw new ReturnError('INVALID_INPUT', 'orderId가 필요합니다.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = decode(getOrder.get(shopId, orderId)), result = apply(previous);
        if (!result.duplicate) {
          const notifications = notificationState(shopId);
          N.project(notifications, previous, result);
          db.prepare('INSERT INTO return_shops VALUES (?, 1) ON CONFLICT(shop_id) DO UPDATE SET revision = revision + 1').run(shopId);
          const revision = getRevision.get(shopId).revision;
          db.prepare(`INSERT INTO return_orders VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(shop_id, order_id) DO UPDATE SET version = excluded.version, revision = excluded.revision, state_json = excluded.state_json`).run(shopId, orderId, result.order.version, revision, JSON.stringify(result.order));
          db.prepare('INSERT INTO return_events VALUES (?, ?, ?, ?, ?)').run(shopId, orderId, result.event.version, result.event.requestId, JSON.stringify(result.event));
          saveNotifications(shopId, notifications);
        }
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    changes(shopId, afterRevision) {
      if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) throw new ReturnError('INVALID_INPUT', '동기화 버전을 확인해 주세요.');
      db.exec('BEGIN');
      try {
        const revision = getRevision.get(shopId)?.revision ?? 0;
        if (afterRevision > revision) throw new ReturnError('INVALID_INPUT', '현재보다 큰 동기화 버전입니다.');
        const orders = db.prepare('SELECT state_json FROM return_orders WHERE shop_id = ? AND revision > ? ORDER BY revision').all(shopId, afterRevision).map(decode);
        db.exec('COMMIT');
        return { revision, orders };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close: () => db.close()
  };
}
module.exports = { createSqliteRepository };

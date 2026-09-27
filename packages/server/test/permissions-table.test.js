// @ts-check
// 권한 표가 모든 명령 · 조회를 담는지(features-1 plan §3-2 · §4-3): 명령마다 권한 행이 있고, 조회마다 기사 세션의 규칙이 있다. 매장 설정의
// 목록 바꿈은 settings.manage(값을 바꾸면 price_list.publish도), 직원 바꿈은 staff.manage이고 기사 기기에서는 거절이다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMAND_TYPES, WIRE_QUERY_NAMES, newRequestId } from '@skinote/contract';
import { COMMAND_PERMISSIONS, DRIVER_QUERY_RULES, commandGuard } from '../src/permissions.js';

test('every command type has a permission row and every query a driver rule', () => {
  assert.deepEqual(Object.keys(COMMAND_PERMISSIONS).sort(), [...COMMAND_TYPES].sort());
  for (const name of WIRE_QUERY_NAMES) assert.ok(DRIVER_QUERY_RULES[name] !== undefined, name);
  assert.equal(DRIVER_QUERY_RULES.shopSettings, 'deny');
});

test('registry.update needs settings.manage and, with a price change, price_list.publish; staff.set needs staff.manage', () => {
  const basis = { epoch: 'e', rev: 1 };
  /** @param {string} type @param {unknown} payload */
  const env = (type, payload) => /** @type {any} */ ({ type, commandVersion: 1, requestId: newRequestId(), basis, payload });
  const counter = { roleKey: 'counter', deviceKind: /** @type {const} */ ('pos') };
  const driver = { roleKey: 'driver', deviceKind: /** @type {const} */ ('driver_phone'), vehicleId: 'v1' };
  const area = env('registry.update', { changes: [{ op: 'area.add', ref: 'n1', label: '설천 입구' }] });
  const price = env('registry.update', { changes: [{ op: 'price.set', productKey: 'ski', amount: 45_000 }] });
  const staff = env('staff.set', { changes: [{ op: 'staff.active', id: 's1', active: false }] });
  const shop = /** @type {const} */ ({ kind: 'shop' });
  assert.equal(commandGuard(counter, new Map([['settings.manage', 'shop']]), area)(shop), null);
  assert.equal(commandGuard(counter, new Map([['settings.manage', 'shop']]), price)(shop)?.error?.code, 'FORBIDDEN');
  assert.equal(commandGuard(counter, new Map([['settings.manage', 'shop'], ['price_list.publish', 'shop']]), price)(shop), null);
  assert.equal(commandGuard(counter, new Map([['settings.manage', 'shop']]), staff)(shop)?.error?.code, 'FORBIDDEN');
  assert.equal(commandGuard(counter, new Map([['staff.manage', 'shop']]), staff)(shop), null);
  assert.equal(commandGuard(driver, new Map([['settings.manage', 'shop'], ['staff.manage', 'shop']]), area)(shop)?.error?.code, 'FORBIDDEN_SCOPE');
  assert.equal(commandGuard(driver, new Map([['settings.manage', 'shop'], ['staff.manage', 'shop']]), staff)(shop)?.error?.code, 'FORBIDDEN_SCOPE');
});

test('order.cancel with 미수 결제 (apply_to_due) also needs payment.reallocate; a refund or no refund needs order.cancel only', () => {
  const basis = { epoch: 'e', rev: 1 };
  const counter = { roleKey: 'counter', deviceKind: /** @type {const} */ ('pos') };
  const shop = /** @type {const} */ ({ kind: 'shop' });
  /** @param {string} decision */
  const cancel = decision => /** @type {any} */ ({
    type: 'order.cancel', commandVersion: 1, requestId: newRequestId(), basis,
    payload: { orderId: 'o1', scope: 'lines', lines: [{ lineId: 'o1-l1', quantity: 1 }], reasonKey: 'request', decision },
  });
  const only = new Map([['order.cancel', 'shop']]);
  assert.equal(commandGuard(counter, only, cancel('refund'))(shop), null);
  assert.equal(commandGuard(counter, only, cancel('apply_to_due'))(shop)?.error?.code, 'FORBIDDEN');
  assert.equal(commandGuard(counter, new Map([['order.cancel', 'shop'], ['payment.reallocate', 'shop']]), cancel('apply_to_due'))(shop), null);
});

// 기사 기기의 연결 끊김 기록의 형식(work/impl-offline/plan.md §4): 서명 문장, 끊긴 채 넣을 수 있는 명령(시드 ∩ 명령), 보냄 대기 봉투의 검사
// (맞는 것 통과 · 바꾼 사본 거절), 기사 기기 길의 겉모양, 기사 명령 본문에 개인정보 칸이 없음, 온라인 길이 보냄 대기 칸을 받지 않음.
import { describe, expect, it } from 'vitest';
import {
  COMMAND_CONTEXT, LOGIN_CONTEXT, OFFLINE_COMMANDS, PII_KEYS, commandMessage, deliverMessage, hasPii, loginMessage, offlineCommandTypes, parseDeviceReport,
  parseEnvelope, parseOfflineBody, parseQueuedEnvelope, timeSourceOf, type CommandPayloads, type DeviceReport,
} from '../src/index.ts';

const SIG = 'B'.repeat(86);
const report: DeviceReport = {
  pendingCount: 1, unconfirmedCount: 0, lastSeq: 12, clockOffsetMs: -420, appVersion: 'a1b2c3d4e5f6', offlineCapable: true, localFirst: true, visibility: 'visible',
  unreadable: 0, copy: { epoch: '01JF0EPOCH00000000000000AA', rev: 48190 },
};
const queued = (over: Record<string, unknown> = {}) => ({
  type: 'stock.collect', commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R1C0DM', deviceSeq: 12, ageMs: 5_400_123, clockAnchor: 'mono-k3Jd9Qa1Zx',
  madeAt: '2026-12-26T12:55:00.000Z', basis: { epoch: '01JF0EPOCH00000000000000AA', rev: 48190 }, dependsOn: [],
  recordedBy: { staffId: '01JE0STAFF00000000000000AA', sessionId: '01JF0SESS000000000000000AA', signature: SIG },
  payload: { taskId: 'collect:n261226005', lines: [{ lineId: 'n261226005-l1', quantity: 2 }] },
  ...over,
});

describe('signature messages', () => {
  it('the command prefix differs from the login prefix; the message carries origin, device, sequence and hash', () => {
    expect(COMMAND_CONTEXT).not.toBe(LOGIN_CONTEXT);
    expect(commandMessage('https://shop.test', 'DEV', 12, 'HASH')).toBe('skinote-cmd-v1|https://shop.test|DEV|12|HASH');
    expect(deliverMessage('https://shop.test', 'DEV', 'N')).toBe('skinote-deliver-v1|https://shop.test|DEV|N');
    expect(loginMessage('https://shop.test', 'DEV', 'N').startsWith('skinote-login-v1|')).toBe(true);
  });
  it('the time source follows the anchor prefix', () => {
    expect(timeSourceOf('mono-abcdefgh')).toBe('monotonic');
    expect(timeSourceOf('jump-abcdefgh')).toBe('monotonic');
    expect(timeSourceOf('wall-abcdefgh')).toBe('wall_clock');
  });
});

describe('offlineCommandTypes', () => {
  it('is the seed list intersected with command types (vendor_refund.attempt and device.sign_in are not commands)', () => {
    for (const kind of ['driver_phone', 'driver_tablet', 'pos'] as const) {
      const list = offlineCommandTypes(kind);
      expect(list.every((t) => OFFLINE_COMMANDS[kind].includes(t))).toBe(true);
      expect(list).not.toContain('vendor_refund.attempt');
    }
    expect(offlineCommandTypes('driver_phone').sort()).toEqual([
      'field.add_ticket', 'field.collect', 'field.deposit_return', 'notification.ack', 'route.move', 'route.reset', 'stock.collect', 'stock.deliver', 'task.visit',
    ]);
    expect(offlineCommandTypes('driver_phone')).not.toContain('stock.receive');
    expect(offlineCommandTypes('driver_phone')).not.toContain('cash.transfer');
  });
  it('no driver offline payload type carries a personal-data key', () => {
    const samples: Partial<CommandPayloads> = {
      'stock.collect': { taskId: 'collect:o1', lines: [{ lineId: 'o1-l1', quantity: 1 }] },
      'stock.deliver': { taskId: 'deliver:o1', lines: [{ lineId: 'o1-l1', quantity: 1 }] },
      'task.visit': { taskId: 'collect:o1', outcomeKey: 'customer_absent', retry: { date: '2026-12-26', at: '2026-12-26T13:30:00.000Z' } },
      'field.collect': { taskId: 'collect:o1', orderId: 'o1', amount: 1000, methodKey: 'cash' },
      'field.add_ticket': { taskId: 'collect:o1', orderId: 'o1', productKey: 'night', quantity: 1, assetIds: [], amount: 35_000 },
      'field.deposit_return': { taskId: 'collect:o1', orderId: 'o1', ruleKey: 'r', lines: [], amount: 0 },
      'route.move': { taskId: 'collect:o1', anchorTaskId: null, position: 'top' },
      'route.reset': { vehicleId: 'v1', date: '2026-12-26' },
      'notification.ack': { notificationId: 'pin1' },
    };
    for (const type of offlineCommandTypes('driver_phone')) {
      const payload = samples[type];
      expect(payload, type).toBeDefined();
      expect(hasPii(payload), type).toBe(false);
      // 본문 형식의 열쇠 이름에도 개인정보 칸이 없다(값이 비어 있어도).
      expect(Object.keys(payload as object).some((k) => PII_KEYS.has(k)), type).toBe(false);
    }
  });
});

describe('parseQueuedEnvelope', () => {
  it('accepts a signed queued envelope', () => {
    expect(parseQueuedEnvelope(queued(), { deviceKind: 'driver_phone' }).ok).toBe(true);
    expect(parseQueuedEnvelope(queued({ replay: null }), { deviceKind: 'driver_tablet' }).ok).toBe(true);
  });
  it('refuses commands this device kind cannot queue, and unknown commands', () => {
    const receive = parseQueuedEnvelope(queued({ type: 'stock.receive', payload: { vehicleId: 'v1', taskIds: [] } }), { deviceKind: 'driver_phone' });
    expect(receive.ok ? '' : receive.code).toBe('OFFLINE_NOT_ALLOWED');
    const unknown = parseQueuedEnvelope(queued({ type: 'nope' }), { deviceKind: 'driver_phone' });
    expect(unknown.ok ? '' : unknown.code).toBe('UNKNOWN_COMMAND');
  });
  const mutations: [string, Record<string, unknown>][] = [
    ['seq 0', { deviceSeq: 0 }], ['seq text', { deviceSeq: '1' }], ['negative age', { ageMs: -5 }], ['age over a year', { ageMs: 400 * 86_400_000 }],
    ['bad anchor', { clockAnchor: 'clock-12345678' }], ['short anchor', { clockAnchor: 'mono-1' }], ['bad madeAt', { madeAt: 'yesterday' }],
    ['no recordedBy', { recordedBy: undefined }], ['short signature', { recordedBy: { staffId: 'a', sessionId: 'b', signature: 'x' } }],
    ['replay set', { replay: { receiptNo: '1' } }], ['unknown field', { extra: 1 }], ['bad payload', { payload: { taskId: 'collect:o1' } }],
    ['no deviceSeq', { deviceSeq: undefined }],
  ];
  for (const [name, over] of mutations) {
    it('refuses: ' + name, () => {
      const out = parseQueuedEnvelope(queued(over), { deviceKind: 'driver_phone' });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe('BAD_INPUT');
    });
  }
  it('the online route still refuses every queue field', () => {
    for (const field of ['deviceSeq', 'ageMs', 'clockAnchor', 'madeAt', 'recordedBy']) {
      const { deviceSeq: _a, ageMs: _b, clockAnchor: _c, madeAt: _d, recordedBy: _e, ...online } = queued();
      const out = parseEnvelope({ ...online, [field]: (queued() as Record<string, unknown>)[field] });
      expect(out.ok ? '' : out.code, field).toBe('QUEUE_NOT_SUPPORTED');
    }
  });
  it('closing.close takes a client approval but never server-set links or override', () => {
    const base = { type: 'closing.close', commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R1C0DM', basis: { epoch: 'e', rev: 1 }, expect: { expectedCash: { counter: 0 } } };
    const payload = { date: '2026-12-26', drawerCounts: [], deferredTransferIds: [] };
    expect(parseEnvelope({ ...base, payload: { ...payload, unsynced: { approvalId: 'A'.repeat(22), reason: '휴대폰 꺼짐' } } }).ok).toBe(true);
    expect(parseEnvelope({ ...base, payload: { ...payload, unsynced: { approvalId: 'A'.repeat(22), reason: '' } } }).ok).toBe(false);
    expect(parseEnvelope({ ...base, payload: { ...payload, links: [] } }).ok).toBe(false);
    expect(parseEnvelope({ ...base, payload: { ...payload, override: { approvalId: 'x', reason: 'y', approvedBy: 'z' } } }).ok).toBe(false);
  });
});

describe('offline route bodies', () => {
  it('snapshot · batch · heartbeat · deliver · closing approval accept the examples', () => {
    expect(parseOfflineBody('snapshot', { known: { epoch: 'e', rev: 1, hash: 'h'.repeat(43), configRev: 12 }, fromSeq: 12, pendingTaskIds: ['collect:n1'], onlinePending: [], report }).ok).toBe(true);
    expect(parseOfflineBody('snapshot', { fromSeq: 1, pendingTaskIds: [], onlinePending: [], report }).ok).toBe(true);
    expect(parseOfflineBody('batch', { report, commands: [queued()] }).ok).toBe(true);
    expect(parseOfflineBody('heartbeat', { report: { ...report, visibility: 'hidden', stuckSeq: 3 } }).ok).toBe(true);
    expect(parseOfflineBody('deliver', { deviceId: '01JF3Q8W2Z6N9XK4T7B5R1C0DM', nonce: 'n'.repeat(43), signature: SIG, report, commands: [queued()] }).ok).toBe(true);
    expect(parseOfflineBody('closingApprove', { date: '2026-12-26', ownPin: '1234' }).ok).toBe(true);
  });
  it('refuses the mutations', () => {
    expect(parseOfflineBody('batch', { report, commands: [] }).ok).toBe(false);
    expect(parseOfflineBody('batch', { report, commands: Array(51).fill(queued()) }).ok).toBe(false);
    expect(parseOfflineBody('batch', { report, commands: ['x'] }).ok).toBe(false);
    expect(parseOfflineBody('snapshot', { fromSeq: 0, pendingTaskIds: [], onlinePending: [], report }).ok).toBe(false);
    expect(parseOfflineBody('snapshot', { fromSeq: 1, pendingTaskIds: Array(301).fill('t'), onlinePending: [], report }).ok).toBe(false);
    expect(parseOfflineBody('heartbeat', { report: { ...report, visibility: 'gone' } }).ok).toBe(false);
    expect(parseOfflineBody('heartbeat', { report: { ...report, phone: '01000001234' } }).ok).toBe(false);
    expect(parseOfflineBody('closingApprove', { date: '2026-12-26', ownPin: '12' }).ok).toBe(false);
    expect(parseDeviceReport({ ...report, appVersion: '한글' }).ok).toBe(false);
    expect(parseDeviceReport(report).ok).toBe(true);
  });
});

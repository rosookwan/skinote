// @ts-check
// 매장 운영 명령 넷(plan §5-5): 등록 번호 만들기, 비밀번호 새로, 기기 끊기, 상태. 명령줄(bin/shop.js)이 서버가 멈췄을 때 직접 부르고,
// 서버가 돌면 관리 소켓(admin-socket.js)을 거쳐 서버가 자기 연결로 부른다(한 매장 파일에 쓰는 사람은 하나, D4). SQL은 저장소에만 있다.
// 돌려주는 값 가운데 비밀(등록 번호 · 비밀번호)은 명령줄이 표준 출력에 한 번 보여 줄 뿐 어디에도 적지 않는다.

import { randomInt } from 'node:crypto';
import { DEVICE_KINDS, formatEnrollCode, isDriverDevice } from '@skinote/contract';
import { generatePin, hashPin } from './pin.js';
import { sha256Hex } from './security.js';

/**
 * @typedef {import('@skinote/store').ControlStore} ControlStore
 * @typedef {import('./shops.js').ShopPort} ShopPort
 * @typedef {import('./secrets.js').Secrets} Secrets
 * @typedef {{
 *   shopId: string,
 *   port: ShopPort,
 *   control: ControlStore,
 *   secrets: Pick<Secrets, 'pinPepper'>,
 *   now: () => number,
 *   onRevoke?: (deviceId: string) => { sessions: number, streams: number } | void,
 *   onPinReset?: (accountId: string) => void,
 * }} OpsContext
 */

/** 운영 명령의 실패(코드는 명령줄 · 소켓이 그대로 알린다). */
export class OpError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'OpError';
    this.code = code;
  }
}

const LABEL = /^[^\p{Cc}<>]{1,40}$/u;
/** 등록 번호의 기본 유효 시간(분)과 범위. */
export const CODE_MINUTES = Object.freeze({ default: 60, min: 5, max: 24 * 60 });

/** 숫자 12자리(crypto.randomInt). */
function newEnrollCode() {
  let code = '';
  for (let i = 0; i < 12; i += 1) code += String(randomInt(10));
  return code;
}

/**
 * 등록 번호(12자리, 미리 승인). 기사 기기는 차량이 있어야 하고 포스는 없어야 한다.
 * @param {OpsContext} ctx @param {{ kind?: unknown, label?: unknown, vehicle?: unknown, minutes?: unknown }} args
 */
export function deviceCodeOp(ctx, args) {
  const kind = /** @type {import('@skinote/contract').DeviceKind} */ (args.kind);
  if (!DEVICE_KINDS.includes(kind)) throw new OpError('BAD_ARGS', '--kind는 pos · driver_tablet · driver_phone 가운데 하나');
  const label = typeof args.label === 'string' ? args.label.trim() : '';
  if (!LABEL.test(label)) throw new OpError('BAD_ARGS', '--label은 1~40자(제어 문자 · 꺾쇠 없음)');
  const vehicle = typeof args.vehicle === 'string' && args.vehicle !== '' ? args.vehicle : undefined;
  if (isDriverDevice(kind) !== (vehicle !== undefined)) throw new OpError('BAD_ARGS', '기사 기기는 --vehicle이 있어야 하고 포스는 없어야 합니다');
  const minutes = args.minutes === undefined ? CODE_MINUTES.default : Number(args.minutes);
  if (!Number.isInteger(minutes) || minutes < CODE_MINUTES.min || minutes > CODE_MINUTES.max) throw new OpError('BAD_ARGS', `--minutes는 ${CODE_MINUTES.min}~${CODE_MINUTES.max}`);
  if (!ctx.control.tenant(ctx.shopId)) throw new OpError('NOT_PROVISIONED', '아직 만들지 않은 매장입니다(provision 먼저)');
  const now = ctx.now();
  const expiresAt = now + minutes * 60_000;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newEnrollCode();
    const codeHash = sha256Hex(code);
    if (ctx.control.route(codeHash) || ctx.port.devices.codeByHash(codeHash)) continue;
    let row;
    try {
      row = ctx.port.devices.createCode({ codeHash, kind, label, ...(vehicle ? { vehicleId: vehicle } : {}), expiresAt, now });
    } catch (error) {
      if (/FOREIGN KEY/i.test(String(/** @type {Error} */ (error).message))) throw new OpError('BAD_ARGS', '--vehicle이 이 매장의 차량이 아닙니다');
      throw error;
    }
    ctx.control.insertRoute({ codeHash, tenantId: ctx.shopId, codeId: row.id, expiresAt, now });
    return { code, formatted: formatEnrollCode(code), expiresAt: new Date(expiresAt).toISOString(), kind, label, ...(vehicle ? { vehicleId: vehicle } : {}) };
  }
  throw new OpError('INTERNAL', '등록 번호를 만들지 못했습니다(다시 시도)');
}

/** 직원 찾기: id 또는 이름(같은 이름이 둘이면 id로). @param {OpsContext} ctx @param {unknown} who */
function staffOf(ctx, who) {
  if (typeof who !== 'string' || who.trim() === '') throw new OpError('BAD_ARGS', '--staff가 없습니다');
  const all = ctx.port.staff().filter(s => s.accountId !== undefined);
  const byId = all.find(s => s.id === who);
  if (byId) return byId;
  const named = all.filter(s => s.name === who.trim());
  if (named.length === 0) throw new OpError('NOT_FOUND', '그 이름의 직원이 없습니다');
  if (named.length > 1) throw new OpError('AMBIGUOUS', '같은 이름의 직원이 둘 이상입니다: --staff에 직원 id를 넣습니다');
  return /** @type {typeof all[number]} */ (named[0]);
}

/**
 * 새 비밀번호(한 번 보여 줌)와 잠금 풀기: 계정에 'pin_reset' 표시 한 줄(방법 pin_reset — 로그인 성공으로 적지 않는다). 그 계정이 걸린
 * 실패 셈((계정, 기기) 잠금 · 계정 늦춤)이 거기서 다시 시작한다. 기기의 쉼(한 기기에서 여러 사람이 틀림)은 풀지 않는다.
 * @param {OpsContext} ctx @param {{ staff?: unknown, pinDigits?: unknown }} args
 */
export async function rotatePinOp(ctx, args) {
  const staff = staffOf(ctx, args.staff);
  const digits = args.pinDigits === undefined ? 4 : Number(args.pinDigits);
  if (!Number.isInteger(digits) || digits < 4 || digits > 6) throw new OpError('BAD_ARGS', '--pin-digits는 4~6');
  const accountId = /** @type {string} */ (staff.accountId);
  const account = ctx.control.account(accountId);
  if (!account) throw new OpError('NOT_FOUND', '직원 계정이 없습니다');
  const pin = generatePin(digits);
  const pinHash = await hashPin(ctx.secrets.pinPepper, pin);
  const now = ctx.now();
  ctx.control.setPinHash(accountId, pinHash, now);
  ctx.control.recordAttempt({ loginId: account.loginId ?? 'staff', accountId, tenantId: ctx.shopId, method: 'pin_reset', succeeded: true, reason: 'pin_reset', now });
  ctx.onPinReset?.(accountId);
  return { staff: staff.name, role: staff.roleKey, pin };
}

/**
 * 기기 끊기: 새 세션을 막고 그 기기의 세션을 끝낸다(서버가 돌면 알림 연결도 곧바로 닫는다).
 * @param {OpsContext} ctx @param {{ device?: unknown }} args
 */
export function revokeDeviceOp(ctx, args) {
  if (typeof args.device !== 'string' || args.device === '') throw new OpError('BAD_ARGS', '--device가 없습니다(기기 이름이나 id)');
  const device = ctx.port.devices.find(args.device);
  if (!device) throw new OpError('NOT_FOUND', '그 기기가 없습니다');
  const now = ctx.now();
  const revoked = ctx.port.devices.revoke(device.id, 'cli', now);
  const sessions = ctx.control.revokeDeviceSessions(ctx.shopId, device.id, 'device_revoked', now);
  const after = ctx.onRevoke?.(device.id);
  return { deviceId: device.id, label: device.label, revoked, sessions: sessions + (after?.sessions ?? 0), streams: after?.streams ?? 0 };
}

/**
 * 매장 상태(이름 없이 수만): rev · 영업일 · 읽은 접수 수 · 기기 · 직원.
 * @param {OpsContext} ctx
 */
export function statusOp(ctx) {
  const now = ctx.now();
  if (!ctx.control.tenant(ctx.shopId)) return { shopId: ctx.shopId, provisioned: false };
  const head = ctx.port.head(now);
  const devices = ctx.port.devices.list();
  return {
    shopId: ctx.shopId,
    provisioned: true,
    rev: head.rev,
    businessDate: head.businessDate,
    orders: ctx.port.orderCount(now),
    devices: { active: devices.filter(d => d.status === 'active').length, revoked: devices.filter(d => d.status === 'revoked').length },
    staff: ctx.port.staff().length,
  };
}

/** 관리 소켓 · 명령줄이 부르는 이름 → 명령. */
export const ONLINE_OPS = Object.freeze({
  'device-code': deviceCodeOp,
  'rotate-pin': rotatePinOp,
  'revoke-device': revokeDeviceOp,
  status: statusOp,
});

/** @typedef {keyof typeof ONLINE_OPS} OnlineOp */

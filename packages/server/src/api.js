// @ts-check
// 장부 API(plan §5-1 · §5-4, D5). 매장은 세션에서 온다(봉투 · 인자에서 받지 않는다).
//   GET  /api/v2/head     → { epoch, rev, configRev, serverTime, currentBusinessDate }
//   POST /api/v2/query    { name, params } → 읽기 모델(config · ledgerView · 조회 이름). GET 조회 길은 없다: 끝 4자리 · 이름이 주소 ·
//                         앞단 기록에 남지 않게.
//   POST /api/v2/command  명령 봉투 → CommandOutcome(거절 · 충돌도 200: 업무 결과다)
//   GET  /api/v2/stream   알림 연결(sse.js)
// 본문은 @skinote/contract의 엄격한 검사(parseEnvelope · parseQuery)를 지난 것만 저장소 창구(ShopPort)로 간다. 행위자는 세션의 직원 ·
// 기기이고, 권한 확인(permissions.js)은 저장소가 명령 트랜잭션 안에서 멱등 확인 뒤에 부른다.

import { DomainError, isDriverDevice, parseEnvelope, parseQuery } from '@skinote/contract';
import { HttpError, sendJson } from './http.js';
import { commandGuard, queryAccess } from './permissions.js';

/**
 * @typedef {import('node:http').IncomingMessage} IncomingMessage
 * @typedef {import('node:http').ServerResponse} ServerResponse
 * @typedef {import('./auth.js').SessionContext} SessionContext
 * @typedef {import('./sse.js').Hub} Hub
 */

/** 저장소가 던진 매장 파일 문제(만들지 않은 매장 · 다른 매장 파일 · 시간대)는 503. @param {unknown} error */
function shopProblem(error) {
  const code = /** @type {{ code?: unknown }} */ (error ?? {}).code;
  return code === 'SHOP_NOT_PROVISIONED' || code === 'SHOP_MISMATCH' || code === 'TIMEZONE_UNSUPPORTED' || code === 'REENTRANT';
}

/**
 * 이 조회가 남길 개인정보 열람 한 줄(없으면 null): 전화 창의 온전한 번호(phone_reveal, 접수), 인쇄 판 수거 목록(list_print, 목록 · 줄 수 — 온전한
 * 번호, 2026-09-28), 인쇄 판 대여 접수증(list_print, 접수 — 가린 번호). 그 밖의 읽기 모델에는 온전한 번호가 없다(가린 번호, domain maskPhone).
 * @param {import('@skinote/contract').WireQuery} q @param {unknown} result
 * @returns {{ action: 'phone_reveal' | 'list_print', subjectType: 'order' | 'list', subjectId?: string, itemCount?: number } | null}
 */
export function piiOf(q, result) {
  if (q.name === 'phoneReveal') return { action: 'phone_reveal', subjectType: 'order', subjectId: q.params.orderId };
  // 인쇄 판 대여 접수증(A4, 손님 이름 · 가린 번호): 인쇄마다 한 줄(2026-09-27 점검: 인쇄한 접수증은 적지 않았다).
  if (q.name === 'orderSlip' && q.params.deviceClass === 'print') return { action: 'list_print', subjectType: 'order', subjectId: q.params.orderId };
  if (q.name === 'ledgerView' && q.viewKey === 'collection_list' && q.params.deviceClass === 'print') {
    const rows = /** @type {{ rows?: unknown[], titleValues?: { date?: string } }} */ (result ?? {});
    return { action: 'list_print', subjectType: 'list', subjectId: q.params.date ?? rows.titleValues?.date ?? 'today', itemCount: Math.max(1, rows.rows?.length ?? 0) };
  }
  return null;
}

/**
 * 세션의 권한 역할: 기사 기기의 세션은 역할과 관계없이 기사 역할의 권한이다(임시 차량을 맡은 카운터 · 관리자, features-1 E13b). 카운터 기기는
 * 직원의 역할.
 * @param {SessionContext} ctx
 */
export const permissionRole = ctx => (isDriverDevice(ctx.device.kind) ? 'driver' : ctx.staff.roleKey);

/**
 * 읽기 모델에 넘기는 보는 사람(역할 · 권한 key · 직원 id, features-1 E11). 읽기 모델은 막힌 것을 회색 · 까닭으로 그리고, 서버의 권한 확인이 다시 막는다.
 * @param {SessionContext} ctx
 */
export function viewerOf(ctx) {
  const roleKey = permissionRole(ctx);
  return { roleKey, permissions: [...ctx.port.permissions(roleKey).keys()], staffId: ctx.staff.id, limits: ctx.port.roleLimits(roleKey) };
}

/**
 * @param {{
 *   hub: Hub, nowMs: () => number, log?: (line: string) => void,
 *   afterCommand?: (ctx: SessionContext, envelope: import('@skinote/contract').AnyCommandEnvelope, outcome: import('@skinote/contract').CommandOutcome) => void,
 * }} deps afterCommand = 적용한 명령 뒤의 일(직원 바꿈 뒤 그 사람의 세션 · 알림 연결, features-1 §4-3)
 */
export function createApi({ hub, nowMs, log = () => {}, afterCommand }) {
  /** @param {() => unknown} read */
  const guarded = read => {
    try {
      return read();
    } catch (error) {
      if (error instanceof DomainError) {
        if (error.code === 'NOT_FOUND') throw new HttpError(404, 'NOT_FOUND');
        if (error.code === 'UNKNOWN_VIEW') throw new HttpError(400, 'UNKNOWN_VIEW');
      }
      if (shopProblem(error)) {
        log(`매장 파일 문제 ${String(/** @type {{ code?: unknown }} */ (error).code)}`);
        throw new HttpError(503, 'SHOP_UNAVAILABLE');
      }
      throw error;
    }
  };

  /** @type {Record<string, (req: IncomingMessage, res: ServerResponse, input: { body?: unknown, origin?: string, ctx?: SessionContext }) => void>} */
  const handlers = {
    head(req, res, { ctx }) {
      const { port } = /** @type {SessionContext} */ (ctx);
      const now = nowMs();
      const head = /** @type {ReturnType<typeof port.head>} */ (guarded(() => port.head(now)));
      sendJson(req, res, 200, { epoch: head.epoch, rev: head.rev, configRev: head.configRev, serverTime: new Date(now).toISOString(), currentBusinessDate: head.businessDate });
    },

    query(req, res, { body, ctx }) {
      const session = /** @type {SessionContext} */ (ctx);
      const { port, who } = session;
      const now = nowMs();
      const parsed = parseQuery(body);
      if (!parsed.ok) throw new HttpError(400, parsed.code, { problems: parsed.problems.slice(0, 5) });
      const query = parsed.query;
      const access = queryAccess(who, query, () => (query.name === 'config' || query.name === 'ledgerView' ? null : port.queryScope(query.name, query.params, now)));
      if (!access.ok) throw new HttpError(403, 'FORBIDDEN');
      const q = access.query;
      const result = guarded(() => {
        if (q.name === 'config') return port.config(now);
        if (q.name === 'ledgerView') return port.ledgerView(q.viewKey, q.params, now);
        return port.query(q.name, q.params, now, { viewer: viewerOf(session), deviceId: session.device.id });
      });
      // 개인정보 열람 기록(features-1 E16 · E17, deployment 10-4): 전화 창의 온전한 번호 · 수거 목록 인쇄. 기록이 실패하면 보이지 않는다(500).
      const pii = piiOf(q, result);
      if (pii) port.logPii({ actorKey: 'staff:' + session.staff.id, deviceId: session.device.id, now, ...pii });
      sendJson(req, res, 200, result);
    },

    command(req, res, { body, ctx }) {
      const { port, who, staff, device } = /** @type {SessionContext} */ (ctx);
      const now = nowMs();
      const limits = /** @type {{ maxQuantity: number }} */ (guarded(() => port.limits(now)));
      const parsed = parseEnvelope(body, { maxQuantity: limits.maxQuantity });
      if (!parsed.ok) throw new HttpError(400, parsed.code, { problems: parsed.problems.slice(0, 5) });
      const envelope = parsed.envelope;
      const guard = commandGuard(who, port.permissions(permissionRole(/** @type {SessionContext} */ (ctx))), envelope, log);
      // 도메인이 다시 보는 권한 · 한도(할인의 권한 · 직접 입력 한도, features-1 E10): 세션 역할의 것.
      const viewer = viewerOf(/** @type {SessionContext} */ (ctx));
      // 기록(events.actor_role_key)은 쓴 권한의 역할(기사 기기의 관리자는 기사 권한으로 한다, E13b · 2026-09-27 점검): 누가 무엇을 할 수 있었는지가 맞게.
      const actor = {
        key: 'staff:' + staff.id, name: staff.name, deviceId: device.id, roleKey: viewer.roleKey, ...(who.vehicleId ? { vehicleId: who.vehicleId } : {}),
        viewer: { permissions: viewer.permissions, limits: viewer.limits },
      };
      const outcome = /** @type {import('@skinote/contract').CommandOutcome} */ (guarded(() => port.command(envelope, actor, now, guard)));
      if (outcome.outcome === 'applied' && afterCommand) {
        try {
          afterCommand(/** @type {SessionContext} */ (ctx), envelope, outcome);
        } catch (error) {
          log(`명령 뒤의 일 실패 ${envelope.type} ${error instanceof Error ? error.name : 'Error'}`);
        }
      }
      sendJson(req, res, 200, outcome);
    },

    stream(req, res, { ctx }) {
      const { port, session, device, shopId } = /** @type {SessionContext} */ (ctx);
      const head = /** @type {ReturnType<typeof port.head>} */ (guarded(() => port.head(nowMs())));
      if (!hub.open(req, res, { shopId, sessionId: session.id, deviceId: device.id, head: { epoch: head.epoch, rev: head.rev, configRev: head.configRev } })) {
        throw new HttpError(429, 'TOO_MANY_STREAMS');
      }
    },
  };
  return { handlers };
}

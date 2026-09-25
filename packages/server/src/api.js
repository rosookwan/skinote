// @ts-check
// 장부 API(plan §5-1 · §5-4, D5). 매장은 세션에서 온다(봉투 · 인자에서 받지 않는다).
//   GET  /api/v2/head     → { epoch, rev, configRev, serverTime, currentBusinessDate }
//   POST /api/v2/query    { name, params } → 읽기 모델(config · ledgerView · 조회 이름). GET 조회 길은 없다: 끝 4자리 · 이름이 주소 ·
//                         앞단 기록에 남지 않게.
//   POST /api/v2/command  명령 봉투 → CommandOutcome(거절 · 충돌도 200: 업무 결과다)
//   GET  /api/v2/stream   알림 연결(sse.js)
// 본문은 @skinote/contract의 엄격한 검사(parseEnvelope · parseQuery)를 지난 것만 저장소 창구(ShopPort)로 간다. 행위자는 세션의 직원 ·
// 기기이고, 권한 확인(permissions.js)은 저장소가 명령 트랜잭션 안에서 멱등 확인 뒤에 부른다.

import { DomainError, parseEnvelope, parseQuery } from '@skinote/contract';
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
 * @param {{ hub: Hub, nowMs: () => number, log?: (line: string) => void }} deps
 */
export function createApi({ hub, nowMs, log = () => {} }) {
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
      const { port, who } = /** @type {SessionContext} */ (ctx);
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
        return port.query(q.name, q.params, now);
      });
      sendJson(req, res, 200, result);
    },

    command(req, res, { body, ctx }) {
      const { port, who, staff, device } = /** @type {SessionContext} */ (ctx);
      const now = nowMs();
      const limits = /** @type {{ maxQuantity: number }} */ (guarded(() => port.limits(now)));
      const parsed = parseEnvelope(body, { maxQuantity: limits.maxQuantity });
      if (!parsed.ok) throw new HttpError(400, parsed.code, { problems: parsed.problems.slice(0, 5) });
      const envelope = parsed.envelope;
      const guard = commandGuard(who, port.permissions(staff.roleKey), envelope, log);
      const actor = {
        key: 'staff:' + staff.id, name: staff.name, deviceId: device.id, roleKey: staff.roleKey, ...(who.vehicleId ? { vehicleId: who.vehicleId } : {}),
      };
      const outcome = guarded(() => port.command(envelope, actor, now, guard));
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

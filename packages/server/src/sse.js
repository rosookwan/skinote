// @ts-check
// 알림 연결(GET /api/v2/stream, Server-Sent Events, plan §5-4). 매장마다 열린 연결의 모임이고, 명령이 COMMIT되면 그 매장의 연결 모두에
// `event: head` + `data: {epoch, rev, configRev}`를 보낸다. 기기는 rev가 바뀌면 읽기 모델을 다시 묻는다(부분 동기화는 뒤, sync 5).
//   - 연결하자마자 지금 머리를 한 번 보낸다(놓친 사이의 바뀜을 따라잡게).
//   - 25초마다 `: ping`(앞단 · 공유기가 조용한 연결을 끊지 않게). 그때 세션과 기기를 다시 본다: 끝났으면 `event: bye`를 보내고 닫는다.
//   - 한 세션에 4개, 한 매장에 100개까지(넘으면 429).
//   - 서버를 닫을 때 모두에게 `event: bye`를 보내고 닫는다(닫기 유예 5초를 알림 연결이 쓰지 않게).
// 답의 머리에는 캐시 금지와 앞단 버퍼링 끔(x-accel-buffering: no)을 둔다. 본문에 개인정보는 없다(판 번호뿐).

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @typedef {{ epoch: string, rev: number, configRev: number }} Head */
/**
 * @typedef {{
 *   id: number,
 *   shopId: string,
 *   sessionId: string,
 *   deviceId: string,
 *   res: ServerResponse,
 *   timer: NodeJS.Timeout,
 * }} Stream
 */

export const STREAM_LIMITS = Object.freeze({ perSession: 4, perShop: 100 });
export const PING_MS = 25_000;

/**
 * @param {{
 *   pingMs?: number,
 *   check: (stream: Stream) => boolean,
 *   log?: (line: string) => void,
 * }} options check: 세션 · 기기가 아직 살아 있는지(심장 박동마다)
 */
export function createHub({ pingMs = PING_MS, check, log = () => {} }) {
  /** @type {Map<string, Set<Stream>>} */
  const byShop = new Map();
  let serial = 0;
  let closed = false;

  /** @param {Stream} stream @param {string} text */
  const write = (stream, text) => {
    if (stream.res.writableEnded || stream.res.destroyed) return false;
    stream.res.write(text);
    return true;
  };

  /** @param {Stream} stream */
  const forget = stream => {
    clearInterval(stream.timer);
    const set = byShop.get(stream.shopId);
    if (!set) return;
    set.delete(stream);
    if (set.size === 0) byShop.delete(stream.shopId);
  };

  /** @param {Stream} stream @param {string} [reason] */
  const end = (stream, reason = 'closed') => {
    forget(stream);
    if (!stream.res.writableEnded && !stream.res.destroyed) {
      stream.res.write(`event: bye\ndata: ${JSON.stringify({ reason })}\n\n`);
      stream.res.end();
    }
  };

  return {
    /**
     * 연결을 연다. 한도를 넘으면 false(부르는 쪽이 429로 답한다).
     * @param {IncomingMessage} req @param {ServerResponse} res
     * @param {{ shopId: string, sessionId: string, deviceId: string, head: Head }} who
     */
    open(req, res, who) {
      if (closed) return false;
      const set = byShop.get(who.shopId) ?? new Set();
      const mine = [...set].filter(s => s.sessionId === who.sessionId).length;
      if (set.size >= STREAM_LIMITS.perShop || mine >= STREAM_LIMITS.perSession) return false;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      res.flushHeaders();
      /** @type {Stream} */
      const stream = {
        id: (serial += 1),
        shopId: who.shopId,
        sessionId: who.sessionId,
        deviceId: who.deviceId,
        res,
        timer: setInterval(() => {
          if (!check(stream)) {
            end(stream, 'signed_out');
            return;
          }
          write(stream, ': ping\n\n');
        }, pingMs),
      };
      stream.timer.unref();
      set.add(stream);
      byShop.set(who.shopId, set);
      req.socket.setKeepAlive(true);
      req.socket.setNoDelay(true);
      res.on('close', () => forget(stream));
      write(stream, `retry: 3000\nevent: head\ndata: ${JSON.stringify(who.head)}\n\n`);
      return true;
    },
    /** COMMIT 뒤: 그 매장의 연결 모두에 새 머리. @param {string} shopId @param {Head} head */
    publish(shopId, head) {
      const set = byShop.get(shopId);
      if (!set) return 0;
      const text = `event: head\ndata: ${JSON.stringify({ epoch: head.epoch, rev: head.rev, configRev: head.configRev })}\n\n`;
      let sent = 0;
      for (const stream of [...set]) if (write(stream, text)) sent += 1;
      return sent;
    },
    /** 세션 하나의 연결을 닫는다(로그아웃 · 다시 로그인). @param {string} sessionId */
    closeSession(sessionId) {
      let n = 0;
      for (const set of [...byShop.values()]) for (const stream of [...set]) if (stream.sessionId === sessionId) { end(stream, 'signed_out'); n += 1; }
      return n;
    },
    /** 기기 하나의 연결을 닫는다(기기 끊기). @param {string} shopId @param {string} deviceId */
    closeDevice(shopId, deviceId) {
      let n = 0;
      for (const stream of [...(byShop.get(shopId) ?? [])]) if (stream.deviceId === deviceId) { end(stream, 'device_revoked'); n += 1; }
      return n;
    },
    /** 서버를 닫을 때. */
    closeAll() {
      closed = true;
      let n = 0;
      for (const set of [...byShop.values()]) for (const stream of [...set]) { end(stream, 'server_closing'); n += 1; }
      if (n) log(`알림 연결 ${n}개를 닫음`);
      return n;
    },
    /** 열린 연결 수(시험 · 상태). @param {string} [shopId] */
    count(shopId) {
      if (shopId) return byShop.get(shopId)?.size ?? 0;
      let n = 0;
      for (const set of byShop.values()) n += set.size;
      return n;
    },
  };
}

/** @typedef {ReturnType<typeof createHub>} Hub */

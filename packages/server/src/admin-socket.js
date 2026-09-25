// @ts-check
// 관리 소켓(plan §5-5): 서버가 도는 동안 명령줄(bin/shop.js)의 작은 운영 명령(등록 번호 · 비밀번호 새로 · 기기 끊기 · 상태)을 서버가
// 자기 쓰기 연결로 처리한다. 한 매장 파일에 쓰는 사람은 하나(D4)이고, 기기 끊기는 곧바로 효과가 있다(기기 캐시 · 세션 · 알림 연결).
//
// Unix 도메인 소켓(SKINOTE_ADMIN_SOCKET, 기본 /run/skinote/admin.sock). 서버가 만들 때 0600이라 skinote 사용자(와 root)만 붙는다:
// 같은 VPS의 다른 사용자는 붙지 못한다(루프백 TCP면 붙을 수 있다). 부탁 한 줄(JSON { op, shopId, args }) → 답 한 줄(JSON). 답에는
// 비밀(등록 번호 · 비밀번호)이 들어가므로 서버는 답을 기록에 적지 않는다(명령 이름 · 매장 · 결과 코드만).

import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname } from 'node:path';

/** 한 줄 부탁의 크기 끝. */
const MAX_LINE = 64 * 1024;

/**
 * @typedef {{ op: string, shopId: string, args: Record<string, unknown> }} AdminRequest
 * @typedef {{ ok: true, result: unknown } | { ok: false, code: string, message: string }} AdminResponse
 */

/**
 * 소켓을 연다. 충돌한 서버가 남긴 소켓 파일은 지우고, 다른 서버(다른 자료 폴더)가 같은 경로로 듣고 있으면 빼앗지 않는다(ADMIN_SOCKET_BUSY).
 * @param {{ path: string, handle: (request: AdminRequest) => Promise<AdminResponse>, log?: (line: string) => void }} options
 * @returns {Promise<{ path: string, close: () => Promise<void> }>}
 */
export async function startAdminSocket({ path, handle, log = () => {} }) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o750 });
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error('관리 소켓 자리에 소켓이 아닌 파일이 있습니다');
    // 다른 서버(다른 자료 폴더)가 같은 경로로 듣고 있으면 빼앗지 않는다. 붙지 못하면 충돌한 서버가 남긴 파일이다.
    if (await answers(path)) throw Object.assign(new Error('다른 서버가 관리 소켓을 쓰는 중입니다'), { code: 'ADMIN_SOCKET_BUSY' });
    unlinkSync(path);
  }
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.setTimeout(30_000, () => socket.destroy());
    let buffer = '';
    let answered = false;
    socket.on('data', chunk => {
      if (answered) return;
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        answered = true;
        socket.end(JSON.stringify({ ok: false, code: 'TOO_LARGE', message: '부탁이 너무 깁니다' }) + '\n');
        return;
      }
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      answered = true;
      const line = buffer.slice(0, nl);
      /** @type {AdminResponse} */
      let answer;
      void (async () => {
        let op = '?';
        let shopId = '?';
        try {
          const request = JSON.parse(line);
          if (!request || typeof request !== 'object' || typeof request.op !== 'string' || typeof request.shopId !== 'string') {
            answer = { ok: false, code: 'BAD_REQUEST', message: '{ op, shopId, args } 한 줄이어야 합니다' };
          } else {
            op = request.op.slice(0, 32);
            shopId = request.shopId.slice(0, 64);
            answer = await handle({ op: request.op, shopId: request.shopId, args: request.args && typeof request.args === 'object' ? request.args : {} });
          }
        } catch {
          answer = { ok: false, code: 'BAD_REQUEST', message: 'JSON 한 줄이어야 합니다' };
        }
        log(`관리 소켓 ${op.replace(/[^\w.-]/g, '?')} ${shopId.replace(/[^\w-]/g, '?')} ${answer.ok ? 'ok' : answer.code}`);
        socket.end(JSON.stringify(answer) + '\n');
      })();
    });
    socket.on('error', () => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  chmodSync(path, 0o600);
  return {
    path,
    close: () => new Promise(resolve => {
      for (const socket of sockets) /** @type {import('node:net').Socket} */ (socket).destroy();
      server.close(() => {
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
          /* 이미 없음 */
        }
        resolve(undefined);
      });
    }),
  };
}

/** 소켓이 살아 있는지(붙어 보기만 한다). @param {string} path @returns {Promise<boolean>} */
function answers(path) {
  return new Promise(resolve => {
    const socket = connect(path);
    const done = (/** @type {boolean} */ alive) => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * 명령줄 쪽: 부탁 한 줄을 보내고 답 한 줄을 받는다.
 * @param {string} path @param {AdminRequest} request @param {number} [timeoutMs]
 * @returns {Promise<AdminResponse>}
 */
export function sendAdminRequest(path, request, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('관리 소켓이 답하지 않습니다'), { code: 'ADMIN_TIMEOUT' }));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { buffer += chunk; });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.trim()));
      } catch {
        reject(Object.assign(new Error('관리 소켓의 답을 읽지 못했습니다'), { code: 'ADMIN_BAD_ANSWER' }));
      }
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

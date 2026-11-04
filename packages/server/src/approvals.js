// @ts-check
// 마감의 관리자 승인(work/impl-offline/plan.md O12 · §4-7): 끊긴 · 전송 대기 차량이 마감을 막을 때 closing.reopen 권한의 세션이 자기 비밀번호를 다시 넣어
// 5분 쓰는 승인 id를 받는다(세션 · 날짜에 묶임). 마감 명령은 승인 id와 사유(unsynced)만 싣고, 서버가 명령 트랜잭션 안에서(멱등 확인 뒤) 승인을 쓰고
// 그때의 차량 연결(links)과 승인(override)을 정규 명령에 적는다. 한 번 쓴 승인은 그 요청번호에만 다시 받는다(답을 잃은 재전송이 APPROVAL_INVALID가 되지
// 않게). 비밀번호 · 승인 id는 기록 줄에 적지 않는다. 승인은 서버 메모리에만 있다(다시 띄우면 다시 받는다).

import { randomBytes } from 'node:crypto';
import { CappedMap } from './security.js';

export const APPROVAL_MS = 5 * 60_000;

/**
 * @typedef {{ id: string, sessionId: string, staffKey: string, date: string, expiresAt: number, usedBy?: string }} Approval
 */

export function createApprovals({ nowMs = () => Date.now() } = {}) {
  /** @type {CappedMap} */
  const approvals = new CappedMap(1_000);
  return {
    /**
     * 승인 하나를 만든다(비밀번호 확인은 부르는 쪽: auth.js의 확인 · 잠금). @param {{ sessionId: string, staffKey: string, date: string }} input
     * @returns {{ approvalId: string, expiresAt: string }}
     */
    issue(input) {
      const id = randomBytes(16).toString('base64url');
      const expiresAt = nowMs() + APPROVAL_MS;
      approvals.set(id, { id, ...input, expiresAt });
      return { approvalId: id, expiresAt: new Date(expiresAt).toISOString() };
    },
    /**
     * 마감 명령 트랜잭션 안에서: 승인을 이 요청번호에 묶고(처음) 누가 승인했는지 돌려준다. 없거나 · 지났거나 · 다른 세션 · 다른 날짜 · 다른 요청에 쓰인 승인은 null.
     * @param {string} approvalId @param {{ sessionId: string, date: string, requestId: string }} use
     */
    bind(approvalId, use) {
      /** @type {Approval | undefined} */
      const a = approvals.get(approvalId);
      if (!a || a.sessionId !== use.sessionId || a.date !== use.date) return null;
      if (a.usedBy !== undefined) return a.usedBy === use.requestId ? a : null;
      if (a.expiresAt <= nowMs()) return null;
      a.usedBy = use.requestId;
      return a;
    },
    size: () => approvals.size,
  };
}

/** @typedef {ReturnType<typeof createApprovals>} Approvals */

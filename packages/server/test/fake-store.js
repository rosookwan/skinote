// @ts-check
// 저장소 창구(ShopPort)의 가짜(plan D1b): 로그인 · 기기 · 직원 · 권한은 진짜 창구(시험 매장 파일)를 그대로 쓰고, 명령 · 조회 · 범위만
// 정해 둔 답으로 바꾼다. 도메인(@skinote/domain)을 가져오지 않는다: 서버의 권한 · 범위 표와 HTTP 길만 본다.
//   - 명령: 정해 둔 범위(scopes[명령 종류] 또는 scopeOf(봉투))로 서버의 권한 확인(guard)을 부르고, 거절이 없으면 적용된 것으로 답한다.
//     같은 요청번호는 첫 결과를 돌려준다(멱등). 보낸 봉투 · 행위자는 calls에 남는다.
//   - 조회: 받은 이름 · 인자를 그대로 돌려준다(기사 목록의 차량이 바뀌었는지 보게).
//   - 조회 범위: scopeOfQuery(이름, 인자).

/**
 * @typedef {import('../src/shops.js').ShopPort} ShopPort
 * @typedef {import('../src/shops.js').QueryScope} QueryScope
 * @typedef {import('@skinote/store').CommandScope} CommandScope
 * @typedef {import('@skinote/contract').AnyCommandEnvelope} AnyCommandEnvelope
 * @typedef {import('@skinote/contract').CommandOutcome} CommandOutcome
 */

/**
 * @param {ShopPort} real
 * @param {{
 *   scopeOf?: (envelope: AnyCommandEnvelope) => CommandScope,
 *   scopeOfQuery?: (name: string, params: any) => QueryScope | null,
 *   failFirstCommand?: boolean,
 * }} [options]
 */
export function fakeShop(real, { scopeOf = () => ({ kind: 'shop' }), scopeOfQuery = () => null, failFirstCommand = false } = {}) {
  /** @type {{ envelope: AnyCommandEnvelope, actor: import('@skinote/store').Actor }[]} */
  const calls = [];
  /** @type {Map<string, CommandOutcome>} */
  const done = new Map();
  let rev = 0;
  let failNext = failFirstCommand;
  /** @type {ShopPort & { calls: typeof calls, rev: () => number }} */
  const port = {
    ...real,
    calls,
    rev: () => rev,
    head: now => ({ ...real.head(now), rev }),
    ledgerView: (viewKey, params) => /** @type {any} */ ({ echo: 'ledgerView', viewKey, params }),
    query: (name, params) => ({ echo: name, params }),
    queryScope: (name, params) => scopeOfQuery(name, params),
    command(envelope, actor, now, guard) {
      const seen = done.get(envelope.requestId);
      if (seen) return seen;
      calls.push({ envelope, actor });
      const base = { requestId: envelope.requestId, asOfRev: envelope.basis.rev, epoch: real.head(now).epoch, rebased: false, changes: [] };
      const refusal = guard?.(scopeOf(envelope));
      if (refusal) {
        const outcome = /** @type {CommandOutcome} */ ({ ...base, ...refusal, rev, outcome: 'rejected' });
        done.set(envelope.requestId, outcome);
        return outcome;
      }
      if (failNext) {
        failNext = false;
        throw new Error('가짜 처리 오류');
      }
      rev += 1;
      const outcome = /** @type {CommandOutcome} */ ({ ...base, outcome: 'applied', rev });
      done.set(envelope.requestId, outcome);
      return outcome;
    },
  };
  return port;
}

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SkiReturnClient = factory();
})(globalThis, function () {
  'use strict';
  class ApiError extends Error {
    constructor(code, message, status = 0) { super(message); this.name = 'ApiError'; this.code = code; this.status = status; }
  }
  function withWatch(client) {
    client.watch = ({ intervalMs = 3000, onChange, onStatus = () => {}, onError = () => {} }) => {
      if (!Number.isInteger(intervalMs) || intervalMs < 1000 || typeof onChange !== 'function') throw new ApiError('INVALID_INPUT', '갱신 간격과 변경 콜백을 확인해 주세요.');
      let stopped = false, timer, cursor = 0, first = true;
      async function poll() {
        try {
          const result = await client.sync(cursor);
          if (stopped) return;
          if (first || result.revision !== cursor) onChange(result);
          first = false; cursor = result.revision;
          onStatus({ connected: true, lastSyncedAt: new Date().toISOString(), mode: client.mode });
        } catch (error) {
          if (stopped) return;
          onStatus({ connected: false, mode: client.mode });
          onError(error);
        } finally { if (!stopped) timer = setTimeout(poll, intervalMs); }
      }
      void poll();
      return () => { stopped = true; clearTimeout(timer); };
    };
    return client;
  }
  function createLocalClient(service) {
    const client = { mode: service.mode };
    for (const method of ['execute', 'get', 'history', 'list', 'report', 'sync']) client[method] = async (...args) => service[method](...args);
    return withWatch(client);
  }
  function createHttpClient({ baseUrl, token, fetchImpl = globalThis.fetch }) {
    const url = new URL(baseUrl);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new ApiError('INVALID_INPUT', 'HTTPS 또는 로컬 API 주소를 지정해 주세요.');
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token) || typeof fetchImpl !== 'function') throw new ApiError('INVALID_INPUT', 'API 인증과 요청 함수를 확인해 주세요.');
    const base = baseUrl.replace(/\/$/, '');
    async function request(route, body) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 10000);
      try {
        const response = await fetchImpl(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, cache: 'no-store', redirect: 'error', signal: abort.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json();
        if (!response.ok) throw new ApiError(data.error?.code ?? 'API_ERROR', data.error?.message ?? '처리 결과를 확인해 주세요.', response.status);
        return data;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError('CONNECTION_ERROR', '서버 응답을 확인하지 못했습니다. 최신 상태를 조회하거나 같은 요청 ID로 재시도해 주세요.');
      } finally { clearTimeout(timer); }
    }
    const query = options => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options ?? {})) if (value != null) params.set(key, String(value));
      return params.size ? '?' + params : '';
    };
    return withWatch({ mode: 'api',
      execute: command => request('/api/returns/commands', command),
      get: async orderId => (await request('/api/returns/orders/' + encodeURIComponent(orderId))).order,
      history: async orderId => (await request('/api/returns/orders/' + encodeURIComponent(orderId) + '/history')).events,
      list: async options => (await request('/api/returns' + query(options))).orders,
      report: options => request('/api/returns/report' + query(options)),
      sync: (afterRevision = 0) => request('/api/returns/sync' + query({ afterRevision }))
    });
  }
  function newCommand(type, order, payload) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const requestId = 'return-' + [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return { type, orderId: order.id, expectedVersion: order.version, requestId, payload: JSON.parse(JSON.stringify(payload)) };
  }
  return { ApiError, createLocalClient, createHttpClient, newCommand };
});

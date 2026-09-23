(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SkiNotificationClient = factory();
})(globalThis, function () {
  'use strict';
  function command(type, payload = {}, notificationId) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return { type, payload, requestId: 'notice-' + [...bytes].map(value => value.toString(16).padStart(2, '0')).join(''), ...(notificationId ? { notificationId } : {}) };
  }
  function watch(client) {
    client.watch = ({ onChange, onStatus = () => {}, intervalMs = 3000 }) => {
      if (typeof onChange !== 'function' || !Number.isFinite(intervalMs) || intervalMs < 1000) throw new Error('알림 갱신 설정을 확인해 주세요.');
      let stopped = false, timer, cursor = 0;
      const poll = async () => {
        try {
          const data = await client.sync(cursor);
          if (stopped) return;
          if (!cursor || data.cursor !== cursor || data.reset) onChange(data);
          cursor = data.cursor; onStatus({ connected: true, at: new Date().toISOString() });
        } catch (error) { if (!stopped) onStatus({ connected: false, message: error.message }); }
        finally { if (!stopped) timer = setTimeout(poll, intervalMs); }
      };
      void poll();
      return () => { stopped = true; clearTimeout(timer); };
    };
    return client;
  }
  function createLocalClient(service) {
    const client = {};
    for (const method of ['list', 'sync', 'sent', 'tasks', 'preferences', 'execute']) client[method] = async (...args) => service[method](...args);
    return watch(client);
  }
  function createHttpClient({ baseUrl, token, fetchImpl = globalThis.fetch }) {
    const url = new URL(baseUrl);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_-]{32,256}$/.test(token || '')) throw new Error('알림 API 주소와 인증을 확인해 주세요.');
    const base = baseUrl.replace(/\/$/, '');
    async function request(path, body) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetchImpl(base + '/api/notifications' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, cache: 'no-store', redirect: 'error' });
        const result = await response.json();
        if (!response.ok) { const error = new Error(result.error?.message || '알림 요청을 처리하지 못했습니다.'); error.code = result.error?.code; throw error; }
        return result;
      } catch (error) {
        if (error.code) throw error;
        const failure = new Error('연결을 확인하고 같은 요청으로 다시 시도해 주세요.'); failure.code = 'CONNECTION_ERROR'; throw failure;
      } finally { clearTimeout(timer); }
    }
    return watch({
      list: (options = {}) => request('?' + new URLSearchParams(options)),
      sync: (cursor = 0) => request('/sync?cursor=' + cursor),
      sent: () => request('/sent'), tasks: async () => (await request('/tasks')).tasks,
      preferences: () => request('/preferences'), execute: value => request('/commands', value)
    });
  }
  return { createLocalClient, createHttpClient, command };
});

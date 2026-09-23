(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./common.js'), require('./service.js'), require('../returns/client.js'));
  else root.SkiWorkflowClient = factory(root.SkiWorkflowCommon, root.SkiWorkflowService, root.SkiReturnClient);
})(globalThis, function (C, S, R) {
  'use strict';
  function randomId(prefix = 'workflow-') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
    return prefix + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  function newCommand(type, current, payload) {
    return { type, requestId: randomId(), expectedVersion: C.integer(typeof current === 'number' ? current : current.revision, 0, Number.MAX_SAFE_INTEGER), payload: C.copy(payload) };
  }
  async function newIntakeCommand(current, payload) {
    const accessToken = randomId('');
    return { command: newCommand('intake.create', current, { ...C.copy(payload), accessHash: await S.hashToken(accessToken) }), accessToken };
  }
  function withWatch(client, subscribe) {
    client.watch = ({ intervalMs = 2000, onChange = () => {}, onStatus = () => {}, onError = () => {} } = {}) => {
      if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new R.ApiError('INVALID_INPUT', '갱신 간격은 1초 이상이어야 합니다.');
      let stopped = false, busy = false, dirty = false, timer, afterRevision = 0, afterNotificationRevision = 0, lastSyncedAt = null;
      async function refresh() {
        if (stopped) return;
        if (busy) { dirty = true; return; }
        busy = true; clearTimeout(timer);
        try {
          const update = await client.sync({ afterRevision, afterNotificationRevision });
          if (stopped) return;
          lastSyncedAt = update.at;
          if (update.changed) onChange(update.data);
          afterRevision = update.revision; afterNotificationRevision = update.notificationRevision;
          onStatus({ connected: true, lastSyncedAt, mode: client.mode });
        } catch (error) { if (!stopped) { onStatus({ connected: false, lastSyncedAt, mode: client.mode }); onError(error); } }
        finally {
          busy = false;
          if (!stopped) { timer = setTimeout(refresh, dirty ? 0 : intervalMs); dirty = false; }
        }
      }
      const unsubscribe = subscribe?.(refresh); refresh();
      return { refresh, stop() { stopped = true; clearTimeout(timer); unsubscribe?.(); } };
    };
    return client;
  }
  function createLocalClient(service, repository) {
    const client = { mode: service.mode };
    for (const name of ['execute', 'snapshot', 'sync', 'reservations', 'vehicle', 'board', 'intake', 'print', 'history', 'report', 'sendFormLink', 'prepareMove', 'dispatchPrint']) client[name] = async (...args) => service[name](...args);
    return withWatch(client, repository?.subscribe?.bind(repository));
  }
  function transport({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10000 }, form = false) {
    let base;
    try { base = new URL(baseUrl); } catch { throw new R.ApiError('INVALID_INPUT', 'API 주소를 확인해 주세요.'); }
    if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw new R.ApiError('INVALID_INPUT', 'HTTPS 또는 로컬 API 주소를 사용해 주세요.');
    if (!(form ? /^[A-Za-z0-9_-]{43,128}$/ : /^[A-Za-z0-9_-]{32,256}$/).test(token || '') || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new R.ApiError('INVALID_INPUT', 'API 연결 설정을 확인해 주세요.');
    const prefix = base.toString().replace(/\/$/, '');
    return async (route, body) => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(prefix + route, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
          headers: { Authorization: (form ? 'Form ' : 'Bearer ') + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        let data;
        try { data = await response.json(); } catch { throw new R.ApiError('INVALID_RESPONSE', '서버 응답을 확인하지 못했습니다.', response.status); }
        if (!response.ok) throw new R.ApiError(data.error?.code || 'API_ERROR', data.error?.message || '처리하지 못했습니다.', response.status);
        return data;
      } catch (error) {
        if (error instanceof R.ApiError) throw error;
        throw new R.ApiError('CONNECTION_ERROR', '처리 결과를 확인하지 못했습니다. 연결 후 같은 요청번호로 다시 확인해 주세요.');
      } finally { clearTimeout(timer); }
    };
  }
  function createHttpClient(options) {
    const request = transport(options), client = { mode: 'api', execute: command => request('/api/workflows/commands', command), snapshot: () => request('/api/workflows'),
      intake: id => request('/api/workflows/forms/' + encodeURIComponent(C.id(id))), print: id => request('/api/workflows/prints/' + encodeURIComponent(C.id(id))),
      sendFormLink: envelope => request('/api/workflows/forms/send', envelope) };
    client.prepareMove = payload => request('/api/workflows/moves/preview', payload);
    client.dispatchPrint = id => request('/api/workflows/prints/dispatch', { id });
    // Keep uncertain writes across reloads without persisting the staff key or
    // readable customer/payment data on a shared POS browser.
    const storage = options.pendingStorage === undefined ? globalThis.localStorage : options.pendingStorage;
    let pendingCrypto;
    async function pendingKey() {
      if (!pendingCrypto) pendingCrypto = (async () => {
        const identity = options.baseUrl + ':' + options.token;
        const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode('ski-pos-encryption-v1:' + identity));
        const lookup = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode('ski-pos-lookup-v1:' + identity));
        const digest = [...new Uint8Array(lookup)].map(b => b.toString(16).padStart(2, '0')).join('');
        return { name: 'ski-pos-pending-v1:' + digest, key: await globalThis.crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) };
      })();
      return pendingCrypto;
    }
    client.persistPending = async command => {
      if (!storage) return;
      try {
        const { name, key } = await pendingKey(), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const data = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(command)));
        storage.setItem(name, JSON.stringify({ iv: [...iv], data: [...new Uint8Array(data)] }));
      } catch { throw new R.ApiError('PENDING_STORAGE_ERROR', '처리 복구 기록을 저장하지 못했습니다. 브라우저 저장 공간을 확인한 뒤 다시 시도해 주세요.'); }
    };
    client.restorePending = async () => {
      if (!storage) return null;
      try {
        const { name, key } = await pendingKey(), raw = storage.getItem(name); if (!raw) return null;
        const value = JSON.parse(raw), data = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(value.iv) }, key, new Uint8Array(value.data));
        return JSON.parse(new TextDecoder().decode(data));
      } catch { throw new R.ApiError('PENDING_STORAGE_ERROR', '앞선 처리 복구 기록을 읽지 못했습니다. 이 기기의 기록을 관리자와 확인해 주세요.'); }
    };
    client.clearPending = async () => { if (storage) storage.removeItem((await pendingKey()).name); };
    for (const name of ['sync', 'reservations', 'vehicle', 'board', 'history', 'report']) client[name] = (query = {}) => request('/api/workflows/' + name + '?' + new URLSearchParams(query));
    return withWatch(client);
  }
  function createGuestHttpClient({ shopId, formId, accessToken, ...options }) {
    const request = transport({ ...options, token: accessToken }, true), route = '/api/intake/' + encodeURIComponent(C.id(shopId)) + '/' + encodeURIComponent(C.id(formId));
    return { get: () => request(route), submit: command => request(route, command) };
  }
  return { newCommand, newIntakeCommand, randomId, createLocalClient, createHttpClient, createGuestHttpClient, formLink: S.formLink };
});

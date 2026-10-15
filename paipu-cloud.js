(function () {
  'use strict';
  const BACKEND_ORIGIN = 'https://mahjong-paipu-kevin-9d6b.diwang39.chatgpt.site';
  const APP_ORIGINS = new Set(['https://diw1.github.io', 'http://127.0.0.1:8873']);
  const VERSION = 1;
  const PREFIX = 'mahjong-paipu:';
  const CONNECT_TIMEOUT = 5 * 60 * 1000;
  const RECORD_TIMEOUT = 120000;
  let activeConnection = null;

  function cloudError(code, message) { const error = new Error(message); error.name = 'PaipuCloudError'; error.code = code; return error; }
  function abortError() { const error = new Error('已取消私有后台读取。'); error.name = 'AbortError'; error.code = 'ABORTED'; return error; }
  function token(bytes = 24) { const values = new Uint8Array(bytes); crypto.getRandomValues(values); return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join(''); }
  function recordURL(meta) { if (!meta || typeof meta.url !== 'string' || meta.url.length > 8192) throw cloudError('INVALID_URL', '缺少有效牌谱链接。'); return meta.url; }
  function rawRecord(body) { if (!body || !body.head || typeof body.head !== 'object' || Array.isArray(body.head) || typeof body.data !== 'string' || !body.data) throw cloudError('INVALID_RESPONSE', '私有后台没有返回完整的原始牌谱。'); return { head: body.head, data: body.data }; }
  function responseError(body, status) {
    const code = typeof body?.error?.code === 'string' ? body.error.code : typeof body?.error === 'string' ? body.error : typeof body?.code === 'string' ? body.code : 'HTTP_' + status;
    const messages = {
      ERR_NOT_LOGIN: '雀魂登录已失效，请在私有后台重新授权。', NOT_CONNECTED: '请先打开私有后台管理页登录已有雀魂账号，再返回读取。',
      UNAUTHORIZED: '请先在私有后台页面完成 ChatGPT 登录。', AUTH_REQUIRED: '请先在私有后台页面完成 ChatGPT 登录。', FORBIDDEN: '当前账号无权使用此私有后台。',
      SESSION_EXPIRED: '雀魂登录已失效，请在私有后台重新授权。', TIMEOUT: '私有后台读取超时，请稍后重试。',
      INVALID_URL: '私有后台不支持这个牌谱链接。', NOT_FOUND: '未找到牌谱，或当前雀魂账号没有读取权限。',
    };
    return cloudError(code, messages[code] || (status === 401 ? '请在私有后台重新登录与授权。' : '私有后台读取失败，请打开管理页查看连接状态后重试。'));
  }
  async function localRequest(path, body, signal) {
    const response = await fetch(path, { method: body == null ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: body == null ? {} : { 'Content-Type': 'application/json' }, ...(body == null ? {} : { body: JSON.stringify(body) }), signal });
    let data;
    try { data = await response.json(); } catch (_) { throw cloudError('INVALID_RESPONSE', '私有后台响应不可读取，请确认已登录此私有页面。'); }
    if (!response.ok) throw responseError(data, response.status);
    return data;
  }
  async function connectSameOrigin({ signal } = {}) {
    const statusRequest = new AbortController();
    const cancelStatus = () => statusRequest.abort();
    signal?.addEventListener('abort', cancelStatus, { once: true });
    let statusTimedOut = false, state;
    const statusTimeout = setTimeout(() => { statusTimedOut = true; statusRequest.abort(); }, 25000);
    try { state = await localRequest('/api/status', null, statusRequest.signal); }
    catch (error) { if (statusTimedOut) throw cloudError('CONNECT_TIMEOUT', '私有后台连接检查超时，请稍后重试。'); if (signal?.aborted) throw abortError(); throw error; }
    finally { clearTimeout(statusTimeout); signal?.removeEventListener('abort', cancelStatus); }
    if (!state.connected) throw cloudError('NOT_CONNECTED', '请先打开私有后台管理页登录已有雀魂账号，再返回读取。');
    return async function loader(meta, { signal: taskSignal, onProgress } = {}) {
      if (taskSignal?.aborted) throw abortError();
      const url = recordURL(meta), request = new AbortController();
      let timedOut = false;
      const cancel = () => request.abort();
      taskSignal?.addEventListener('abort', cancel, { once: true });
      const timeout = setTimeout(() => { timedOut = true; request.abort(); }, RECORD_TIMEOUT);
      try {
        if (typeof onProgress === 'function') onProgress('正在通过私有后台读取牌谱…');
        return rawRecord(await localRequest('/api/record', { url }, request.signal));
      } catch (error) { if (timedOut) throw cloudError('TIMEOUT', '私有后台读取超时，请稍后重试。'); if (taskSignal?.aborted) throw abortError(); throw error; }
      finally { clearTimeout(timeout); taskSignal?.removeEventListener('abort', cancel); }
    };
  }
  function connect({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (location.origin === BACKEND_ORIGIN) return connectSameOrigin({ signal });
    if (!APP_ORIGINS.has(location.origin)) return Promise.reject(cloudError('UNTRUSTED_ORIGIN', '请从正式牌谱结算网站打开私有后台连接。'));
    if (activeConnection) activeConnection.dispose(cloudError('RECONNECTED', '已建立新的私有后台连接。'), true);
    return new Promise((resolve, reject) => {
      let state, popup;
      try {
        state = token();
        // This call is deliberately synchronous within the user's submit event.
        popup = window.open(BACKEND_ORIGIN + '/bridge', 'mahjong-paipu-' + state.slice(0, 12), 'popup,width=460,height=760');
      } catch (_) { reject(cloudError('POPUP_BLOCKED', '授权窗口无法打开。请允许弹窗，或打开云端牌谱页面继续。')); return; }
      if (!popup) { reject(cloudError('POPUP_BLOCKED', '授权弹窗被拦截。请允许弹窗，或打开云端牌谱页面继续。')); return; }
      let disposed = false, ready = false;
      let bootstrapTimer, closeTimer, connectTimer;
      const pending = new Map();
      function post(type, fields = {}) { if (!disposed && !popup.closed) popup.postMessage({ version: VERSION, type: PREFIX + type, state, ...fields }, BACKEND_ORIGIN); }
      function complete(rid, error, data) {
        const task = pending.get(rid); if (!task) return;
        pending.delete(rid); clearTimeout(task.timer); task.signal?.removeEventListener('abort', task.abort);
        if (error) task.reject(error); else task.resolve(data);
      }
      function dispose(error, closePopup = false) {
        if (disposed) return; disposed = true;
        clearInterval(bootstrapTimer); clearInterval(closeTimer); clearTimeout(connectTimer);
        window.removeEventListener('message', onMessage); signal?.removeEventListener('abort', onAbort);
        pending.forEach((_, rid) => complete(rid, error));
        if (!ready) reject(error);
        if (closePopup) { try { popup.close(); } catch (_) { /* The user can still close the window manually. */ } }
        if (activeConnection?.dispose === dispose) activeConnection = null;
      }
      function loader(meta, { signal: taskSignal, onProgress } = {}) {
        if (disposed || popup.closed) return Promise.reject(cloudError('POPUP_CLOSED', '私有后台窗口已关闭，请重新连接，或打开云端牌谱页面继续。'));
        if (taskSignal?.aborted) return Promise.reject(abortError());
        let url, rid;
        try { url = recordURL(meta); rid = token(16); } catch (error) { return Promise.reject(error); }
        return new Promise((resolveTask, rejectTask) => {
          const abort = () => { post('cancel', { rid }); complete(rid, abortError()); };
          const timer = setTimeout(() => { post('cancel', { rid }); complete(rid, cloudError('TIMEOUT', '读取牌谱超时，请重试，或打开云端牌谱页面继续。')); }, RECORD_TIMEOUT);
          pending.set(rid, { resolve: resolveTask, reject: rejectTask, timer, signal: taskSignal, abort });
          taskSignal?.addEventListener('abort', abort, { once: true });
          try { if (typeof onProgress === 'function') onProgress('正在通过私有后台读取牌谱…'); } catch (error) { complete(rid, error); return; }
          try { post('record', { rid, url }); } catch (_) { complete(rid, cloudError('CONNECTION_LOST', '私有后台连接已中断，请重新连接。')); }
        });
      }
      function onMessage(event) {
        if (disposed || event.origin !== BACKEND_ORIGIN || event.source !== popup) return;
        const data = event.data;
        if (!data || typeof data !== 'object' || data.version !== VERSION || data.state !== state) return;
        if (data.type === PREFIX + 'ready' && !ready) {
          ready = true; clearInterval(bootstrapTimer); clearTimeout(connectTimer); resolve(loader);
        } else if (data.type === PREFIX + 'result' && ready && typeof data.rid === 'string' && pending.has(data.rid)) {
          try { complete(data.rid, null, rawRecord(data.raw)); } catch (error) { complete(data.rid, error); }
        } else if (data.type === PREFIX + 'error' && ready && typeof data.rid === 'string' && pending.has(data.rid)) {
          const allowed = /^[A-Z0-9_]{1,64}$/.test(data.error?.code || '') ? data.error.code : 'READ_FAILED';
          complete(data.rid, responseError({ code: allowed }, 400));
        } else if (data.type === PREFIX + 'disconnected') dispose(cloudError('NOT_CONNECTED', '私有后台已退出雀魂登录，请重新连接。'));
      }
      function onAbort() { dispose(abortError(), true); }
      window.addEventListener('message', onMessage);
      signal?.addEventListener('abort', onAbort, { once: true });
      connectTimer = setTimeout(() => dispose(cloudError('CONNECT_TIMEOUT', '等待私有后台授权超时。请重新连接，或打开云端牌谱页面继续。'), true), CONNECT_TIMEOUT);
      closeTimer = setInterval(() => { if (popup.closed) dispose(cloudError('POPUP_CLOSED', '授权窗口已关闭或登录连接不兼容。可打开云端牌谱页面继续。')); }, 400);
      bootstrapTimer = setInterval(() => { try { post('bootstrap'); } catch (_) { /* Navigation during sign-in may temporarily prevent delivery. */ } }, 700);
      activeConnection = { dispose };
      try { post('bootstrap'); } catch (_) { /* The next bootstrap follows after the private page finishes loading. */ }
    });
  }
  window.PaipuCloud = Object.freeze({ backendOrigin: BACKEND_ORIGIN, connect });
})();

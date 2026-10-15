'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(__dirname + '/paipu-cloud.js', 'utf8');
const BACKEND = 'https://mahjong-paipu-kevin-9d6b.diwang39.chatgpt.site';
const APP = 'https://diw1.github.io';
const URL = 'https://example.test/synthetic-record';
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const clean = value => JSON.parse(JSON.stringify(value));

// Every request, popup and clock is mocked; these tests never contact an account or service.
function boot({ enabled = false, origin = APP, fetchImpl, blocked = false } = {}) {
  const calls = [], sent = [], listeners = new Map(), timers = new Map();
  let opened = 0, nextTimer = 0;
  const popup = { closed: false, postMessage(data, target) { sent.push({ data, target }); }, close() { this.closed = true; } };
  const window = {
    open(url, name, options) { opened++; calls.push({ popup: { url, name, options } }); return blocked ? null : popup; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  const timer = (fn, delay, interval) => { const id = ++nextTimer; timers.set(id, { fn, delay, interval }); return id; };
  const context = {
    window, location: { origin }, crypto: webcrypto, AbortController, Uint8Array,
    setTimeout: (fn, delay) => timer(fn, delay, false), setInterval: (fn, delay) => timer(fn, delay, true),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fetchImpl ? fetchImpl(url, options) : url.endsWith('/status') ? reply({ enabled: true, connected: true }) : reply({ head: { uuid: 'synthetic' }, data: 'AAAA', ignoredPrivateField: 'discard' });
    },
  };
  vm.runInNewContext(enabled ? source.replace('const PUBLIC_READ_ENABLED = false;', 'const PUBLIC_READ_ENABLED = true;') : source, context);
  return {
    api: window.PaipuCloud, calls, sent, popup, timers,
    get opened() { return opened; }, get requests() { return calls.filter(item => item.url); },
    message(data, eventOrigin = BACKEND, eventSource = popup) { listeners.get('message')?.({ origin: eventOrigin, source: eventSource, data }); },
    fire(delay) { for (const [id, item] of timers) if (item.delay === delay) { if (!item.interval) timers.delete(id); item.fn(); return; } throw new Error('Missing mock timer ' + delay); },
  };
}

test('public switch stays disabled and private popup opens synchronously', async () => {
  const app = boot(), controller = new AbortController();
  assert.equal(app.api.publicReadEnabled, false);
  const connection = app.api.connect({ signal: controller.signal });
  assert.equal(app.opened, 1);
  assert.equal(app.requests.length, 0);
  assert.equal(app.calls[0].popup.url, BACKEND + '/bridge');
  const state = app.sent[0].data.state;
  app.message({ version: 1, type: 'mahjong-paipu:ready', state });
  const loader = await connection;
  const task = loader({ url: URL }), rid = app.sent.at(-1).data.rid;
  app.message({ version: 1, type: 'mahjong-paipu:result', state, rid, raw: { head: { uuid: 'synthetic' }, data: 'AAAA', session: 'discard' } });
  assert.deepEqual(clean(await task), { head: { uuid: 'synthetic' }, data: 'AAAA' });
  controller.abort();
  assert.equal(app.popup.closed, true);
  assert.equal(app.timers.size, 0);
});

test('private bridge rejects wrong origin, popup source and nonce', async () => {
  const app = boot(), controller = new AbortController();
  const connection = app.api.connect({ signal: controller.signal });
  const state = app.sent[0].data.state;
  app.message({ version: 1, type: 'mahjong-paipu:ready', state }, 'https://untrusted.example');
  app.message({ version: 1, type: 'mahjong-paipu:ready', state }, BACKEND, {});
  app.message({ version: 1, type: 'mahjong-paipu:ready', state: 'wrong' });
  assert([...app.timers.values()].some(timer => timer.delay === 300000));
  app.message({ version: 1, type: 'mahjong-paipu:ready', state });
  assert.equal(typeof await connection, 'function');
  controller.abort();
});

test('private same-origin fallback keeps personal endpoint and credentials', async () => {
  const app = boot({ origin: BACKEND });
  const loader = await app.api.connect();
  await loader({ url: URL });
  assert.equal(app.opened, 0);
  assert.deepEqual(app.requests.map(call => call.url), ['/api/status', '/api/record']);
  assert(app.requests.every(call => call.options.credentials === 'same-origin'));
});

test('public loader uses only fixed anonymous endpoints and returns only record fields', async () => {
  const app = boot({ enabled: true });
  const loader = await app.api.connect(), progress = [];
  const raw = await loader({ url: URL }, { onProgress: text => progress.push(text) });
  assert.equal(app.opened, 0);
  assert.deepEqual(clean(raw), { head: { uuid: 'synthetic' }, data: 'AAAA' });
  assert.deepEqual(app.requests.map(call => call.url), [BACKEND + '/api/public/status', BACKEND + '/api/public/record']);
  for (const call of app.requests) {
    assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.mode, 'cors');
    assert.equal(call.options.cache, 'no-store'); assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.referrerPolicy, 'no-referrer');
  }
  assert.deepEqual(JSON.parse(app.requests[1].options.body), { url: URL });
  assert.equal(progress.length, 1);
  assert.equal(app.timers.size, 0);
});

for (const [body, status, code] of [[{ enabled: false }, 200, 'PUBLIC_DISABLED'], [{ enabled: true, connected: false }, 200, 'SERVICE_NOT_CONNECTED'], [{}, 404, 'PUBLIC_DISABLED']]) {
  test('public unavailable status rejects without personal fallback: ' + code + '/' + status, async () => {
    const app = boot({ enabled: true, fetchImpl: async () => reply(body, status) });
    await assert.rejects(app.api.connect(), error => error.code === code);
    assert.equal(app.opened, 0); assert.equal(app.requests.length, 1);
  });
}

for (const code of ['BUSY', 'RATE_LIMITED', 'SERVICE_NOT_CONNECTED', 'PUBLIC_DISABLED']) {
  test('public record error has safe distinct message: ' + code, async () => {
    const app = boot({ enabled: true, fetchImpl: async url => url.endsWith('/status') ? reply({ enabled: true, connected: true }) : reply({ error: code, message: 'PRIVATE SDK DETAILS', diagnostic: { token: 'discard' } }, 409) });
    const loader = await app.api.connect();
    await assert.rejects(loader({ url: URL }), error => error.code === code && !error.message.includes('PRIVATE SDK'));
    assert.equal(app.opened, 0);
  });
}

test('public network failure never opens an authorization popup', async () => {
  const app = boot({ enabled: true, fetchImpl: async () => { throw new Error('private transport details'); } });
  await assert.rejects(app.api.connect(), error => error.code === 'NETWORK_ERROR' && !error.message.includes('private transport'));
  assert.equal(app.opened, 0);
});

test('public response must include a complete raw record', async () => {
  const app = boot({ enabled: true, fetchImpl: async url => url.endsWith('/status') ? reply({ enabled: true, connected: true }) : reply({ head: {}, data: '' }) });
  const loader = await app.api.connect();
  await assert.rejects(loader({ url: URL }), error => error.code === 'INVALID_RESPONSE');
});

test('untrusted caller and pre-canceled public requests never access the service', async () => {
  const app = boot({ enabled: true, origin: 'https://untrusted.example' });
  await assert.rejects(app.api.connect(), error => error.code === 'UNTRUSTED_ORIGIN');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(app.api.connectPublic({ signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(app.requests.length, 0); assert.equal(app.opened, 0);
});

function pendingUntilAborted(url, options) {
  return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('mock cancellation'), { name: 'AbortError' })), { once: true }));
}

test('public status timeout settles and clears its clock', async () => {
  const app = boot({ enabled: true, fetchImpl: pendingUntilAborted });
  const connection = app.api.connect(); app.fire(25000);
  await assert.rejects(connection, error => error.code === 'CONNECT_TIMEOUT');
  assert.equal(app.timers.size, 0);
});

test('public record timeout settles and clears its clock', async () => {
  const app = boot({ enabled: true, fetchImpl: (url, options) => url.endsWith('/status') ? reply({ enabled: true, connected: true }) : pendingUntilAborted(url, options) });
  const loader = await app.api.connect(), task = loader({ url: URL }); app.fire(120000);
  await assert.rejects(task, error => error.code === 'TIMEOUT'); assert.equal(app.timers.size, 0);
});

test('public task cancel aborts request without affecting saved records', async () => {
  const app = boot({ enabled: true, fetchImpl: (url, options) => url.endsWith('/status') ? reply({ enabled: true, connected: true }) : pendingUntilAborted(url, options) });
  const loader = await app.api.connect(), controller = new AbortController();
  const task = loader({ url: URL }, { signal: controller.signal }); controller.abort();
  await assert.rejects(task, error => error.name === 'AbortError'); assert.equal(app.timers.size, 0);
});

'use strict';

// Each deployment scope owns only its Mahjong Score static caches.
const CACHE_PREFIX = 'mahjong-score-cn-static:' + self.registration.scope + ':';
const CACHE_NAME = CACHE_PREFIX + 'v1';
const SCOPE_URL = new URL(self.registration.scope);
const STATIC_FILES = [
  'index.html', 'app.js', 'app.css', 'engine.js', 'web-app.js',
  'manifest.webmanifest', 'icon.svg'
];
const STATIC_URLS = STATIC_FILES.map(path => new URL(path, SCOPE_URL).href);
const STATIC_BY_PATH = new Map(STATIC_URLS.map(url => [new URL(url).pathname, url]));
const INDEX_URL = new URL('index.html', SCOPE_URL).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(STATIC_URLS.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

function staticCacheKey(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== SCOPE_URL.origin || !url.pathname.startsWith(SCOPE_URL.pathname)) return null;
  if (url.pathname === SCOPE_URL.pathname) return INDEX_URL;
  return STATIC_BY_PATH.get(url.pathname) || null;
}

async function staticResponse(request, cacheKey) {
  let cache;
  try { cache = await caches.open(CACHE_NAME); } catch (_) { /* Network still works without Cache Storage. */ }
  try {
    const response = await fetch(request);
    const responseKey = response.url ? staticCacheKey({ method: 'GET', url: response.url }) : cacheKey;
    if (response.ok && response.type === 'basic' && responseKey === cacheKey) {
      if (cache) {
        try { await cache.put(cacheKey, response.clone()); } catch (_) { /* Quota failure must not break the page. */ }
      }
      return response;
    }
    // A temporary server error can use the last successful static response.
    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }
    return response;
  } catch (networkError) {
    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }
    throw networkError;
  }
}

self.addEventListener('fetch', event => {
  const cacheKey = staticCacheKey(event.request);
  if (cacheKey) event.respondWith(staticResponse(event.request, cacheKey));
});

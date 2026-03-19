// Service worker — cache hashed assets only (NOT index.html)
// index.html must always come from the network to pick up new JS bundle references.

const CACHE_NAME = 'shizuha-v5';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Clear all old caches on activation
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache: HTML pages, API calls, WS upgrades, sw.js itself
  if (
    url.pathname === '/' ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/sw.js' ||
    url.pathname.startsWith('/v1/') ||
    url.pathname.startsWith('/ws/')
  ) {
    return; // Let the browser handle normally (network-first, no cache)
  }

  // Only cache /assets/ files (content-hashed filenames — immutable)
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
  }
});

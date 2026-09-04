// Fit Cube ERP service worker.
// Bump CACHE_VERSION whenever app shell files change so clients pick up the new build.
const CACHE_VERSION = 'fitcube-shell-v13';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/db.js',
  '/api.js',
  '/sync.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/header-logo.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never let the SW intercept API calls — api.js handles online/offline
  // logic itself (network first, IndexedDB fallback, outbox queue).
  if (url.pathname.startsWith('/api/')) return;

  if (event.request.mode === 'navigate') {
    // Network-first for the app shell page, falling back to cache when offline.
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for static shell assets.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

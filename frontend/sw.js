const CACHE_NAME = 'basescriptions-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass through all requests - no caching
  event.respondWith(fetch(event.request));
});

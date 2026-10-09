// Cache-first service worker. The page fills the cache (with progress) from asset-manifest.json;
// after that every request is answered from this phone, Wi-Fi or not.
const PREFIX = 'twolay-';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    (async () => {
      const keys = (await caches.keys()).filter((k) => k.startsWith(PREFIX)).sort().reverse();
      for (const k of keys) {
        const hit = await (await caches.open(k)).match(e.request, { ignoreSearch: true });
        if (hit) return hit;
      }
      return fetch(e.request);
    })(),
  );
});

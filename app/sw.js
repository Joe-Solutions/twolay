// Offline-first service worker. The page fills the "twolay-files" cache (with progress) from
// asset-manifest.json and keeps it up to date (only changed files are downloaded); after that every
// request is answered from this phone, Wi-Fi or not.
//   - requests made with cache: 'no-store' / 'reload' (update checks, downloads) always go to the network;
//   - anything not saved goes to the network, revalidated so a new deploy shows up at once;
//   - offline and not saved: older per-version caches from before this scheme, if any.
const FILES = 'twolay-files';
const STAGING = 'twolay-staging';
const legacy = (k) => k.startsWith('twolay-') && k !== FILES && k !== STAGING;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.cache === 'no-store' || req.cache === 'reload') return;
  e.respondWith(
    (async () => {
      const hit = await (await caches.open(FILES)).match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        return await fetch(req.mode === 'navigate' ? new Request(url.href, { cache: 'no-cache' }) : new Request(req, { cache: 'no-cache' }));
      } catch (err) {
        for (const k of (await caches.keys()).filter(legacy)) {
          const old = await (await caches.open(k)).match(req, { ignoreSearch: true });
          if (old) return old;
        }
        throw err;
      }
    })(),
  );
});

// Save every app file + model into Cache Storage so the app runs with no network.
const base = new URL('..', import.meta.url);

async function manifest() {
  const res = await fetch(new URL('asset-manifest.json', base), { cache: 'no-store' }).catch(() => null);
  if (res?.ok) return res.json();
  // Server unreachable (we are offline): use the copy saved in the cache.
  for (const k of await caches.keys()) {
    const hit = k.startsWith('tulay-') && (await (await caches.open(k)).match(new URL('asset-manifest.json', base)));
    if (hit) return hit.json();
  }
  return null;
}

export async function registerSW() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return false;
  try {
    await navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname });
    return true;
  } catch {
    return false;
  }
}

export async function offlineStatus() {
  if (!('caches' in window)) return { ready: false, reason: 'walang Cache Storage (kailangan ng https o localhost)' };
  const m = await manifest();
  if (!m) return { ready: false, reason: 'walang manifest' };
  const cache = await caches.open(`tulay-${m.version}`);
  const have = (await cache.keys()).length;
  const sw = !!navigator.serviceWorker?.controller;
  return { ready: have >= m.files.length + 1 && sw, have, total: m.files.length + 1, version: m.version, sw };
}

export async function cacheAll(onProgress) {
  const m = await manifest();
  if (!m) throw new Error('hindi makuha ang asset-manifest.json');
  const name = `tulay-${m.version}`;
  const cache = await caches.open(name);
  const files = [...m.files, './asset-manifest.json'];
  let done = 0;
  for (const f of files) {
    const url = new URL(f, base);
    if (!(await cache.match(url))) {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
      await cache.put(url, res);
    }
    onProgress?.(++done / files.length, f);
  }
  for (const k of await caches.keys()) if (k.startsWith('tulay-') && k !== name) await caches.delete(k);
  if (navigator.storage?.persist) await navigator.storage.persist();
  return files.length;
}

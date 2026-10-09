// Save every app file + model into Cache Storage so the app runs with no network, and keep it current:
// asset-manifest.json lists a hash per file, so after a new deploy only the changed files are fetched.
// What this phone holds is recorded in the cache itself as __installed.json: { version, hashes, complete }.
const base = new URL('..', import.meta.url);
const FILES = 'twolay-files';
const STAGING = 'twolay-staging';
const abs = (f) => new URL(f, base).href;
const INSTALLED = abs('__installed.json');
const isLegacy = (k) => k.startsWith('twolay-') && k !== FILES && k !== STAGING;

/** The deployed manifest, or null when the server can't be reached. */
async function remoteManifest() {
  const res = await fetch(abs('asset-manifest.json'), { cache: 'no-store' }).catch(() => null);
  return res?.ok ? res.json() : null;
}

async function readInstalled(cache) {
  const res = await cache.match(INSTALLED);
  return res ? res.json() : { version: null, hashes: {}, complete: false };
}

function writeInstalled(cache, inst) {
  return cache.put(INSTALLED, new Response(JSON.stringify(inst), { headers: { 'content-type': 'application/json' } }));
}

async function sha16(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Phones saved before per-file hashes: keep every cached file that is still current, drop the old caches. */
async function migrateLegacy(cache, m, inst, onProgress) {
  const keys = (await caches.keys()).filter(isLegacy);
  for (const k of keys) {
    const old = await caches.open(k);
    const oldManifest = await (await old.match(abs('asset-manifest.json')))?.json().catch(() => null);
    if (oldManifest && (await old.keys()).length >= oldManifest.files.length) inst.complete = true;
    let done = 0;
    for (const f of m.files) {
      onProgress?.(++done / m.files.length, `sinusuri ${f}`);
      if (inst.hashes[f] === m.hashes[f]) continue;
      const res = await old.match(abs(f));
      if (!res || (await sha16(await res.clone().arrayBuffer())) !== m.hashes[f]) continue;
      await cache.put(abs(f), res);
      inst.hashes[f] = m.hashes[f];
    }
    await caches.delete(k);
  }
  return inst;
}

/**
 * Bring the saved copy to manifest `m`. `full`: also fetch files never saved (the "save for offline" button);
 * otherwise only a phone that was fully saved downloads anything. Returns the number of files fetched.
 */
async function sync(m, { full = false, onProgress } = {}) {
  const cache = await caches.open(FILES);
  let inst = await readInstalled(cache);
  if (!inst.version) inst = await migrateLegacy(cache, m, inst, onProgress);
  const stale = Object.keys(inst.hashes).filter((f) => inst.hashes[f] !== m.hashes[f]);
  if (!full && !inst.complete) {
    // Not saved for offline: never serve an outdated copy; the network has the current one.
    for (const f of stale) {
      await cache.delete(abs(f));
      delete inst.hashes[f];
    }
    if (stale.length || inst.version) await writeInstalled(cache, { ...inst, version: null });
    return 0;
  }
  const need = m.files.filter((f) => inst.hashes[f] !== m.hashes[f]);
  // Changed files go to a side cache first, so the app never runs on a mix of old and new files.
  // Files this phone never had are only asked for by the new version, so they go straight in.
  const staging = await caches.open(STAGING);
  const changed = need.filter((f) => f in inst.hashes);
  let done = 0;
  for (const f of need) {
    const res = await fetch(abs(f), { cache: 'no-store' });
    if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
    if (f in inst.hashes) {
      await staging.put(abs(f), res);
    } else {
      await cache.put(abs(f), res);
      inst.hashes[f] = m.hashes[f];
      await writeInstalled(cache, inst);
    }
    onProgress?.(++done / need.length, f);
  }
  for (const f of changed) {
    await cache.put(abs(f), await staging.match(abs(f)));
    inst.hashes[f] = m.hashes[f];
  }
  for (const f of Object.keys(inst.hashes)) {
    if (f in m.hashes) continue;
    await cache.delete(abs(f));
    delete inst.hashes[f];
  }
  await cache.put(abs('asset-manifest.json'), new Response(JSON.stringify(m), { headers: { 'content-type': 'application/json' } }));
  await writeInstalled(cache, { version: m.version, hashes: inst.hashes, complete: true });
  await caches.delete(STAGING);
  return need.length;
}

export async function registerSW() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return false;
  try {
    await navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname, updateViaCache: 'none' });
    return true;
  } catch {
    return false;
  }
}

/** On start, online: update a saved copy to the deployed version. Returns files fetched (0 = already current). */
export async function checkForUpdate(onProgress) {
  if (!('caches' in window) || !window.isSecureContext) return 0;
  const m = await remoteManifest();
  if (!m?.hashes) return 0;
  return sync(m, { onProgress });
}

export async function offlineStatus() {
  if (!('caches' in window)) return { ready: false, reason: 'walang Cache Storage (kailangan ng https o localhost)' };
  const cache = await caches.open(FILES);
  const inst = await readInstalled(cache);
  const m = (await remoteManifest()) ?? (await (await cache.match(abs('asset-manifest.json')))?.json());
  if (!m) return { ready: false, reason: 'walang manifest' };
  const have = m.files.filter((f) => inst.hashes[f] === m.hashes?.[f]).length;
  const sw = !!navigator.serviceWorker?.controller;
  return { ready: inst.complete && have === m.files.length && sw, have, total: m.files.length, version: m.version, sw };
}

export async function cacheAll(onProgress) {
  const m = await remoteManifest();
  if (!m?.hashes) throw new Error('hindi makuha ang asset-manifest.json');
  await sync(m, { full: true, onProgress });
  if (navigator.storage?.persist) await navigator.storage.persist();
  return m.files.length;
}

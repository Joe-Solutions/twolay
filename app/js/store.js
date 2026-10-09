// On-device storage (IndexedDB). Training samples and sign clips never leave the phone
// unless the team explicitly exports a pack file.
const DB = 'tulay';
let dbp;

function db() {
  dbp ??= new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('samples', { keyPath: 'id', autoIncrement: true }).createIndex('label', 'label');
      d.createObjectStore('clips', { keyPath: 'label' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}

export const store = {
  addSample: (label, frames, source) =>
    tx('samples', 'readwrite', (s) => s.add({ label, frames, source, createdAt: Date.now() })),
  samples: () => tx('samples', 'readonly', (s) => s.getAll()),
  deleteSample: (id) => tx('samples', 'readwrite', (s) => s.delete(id)),
  clearLabel: async (label) => {
    const all = await store.samples();
    await Promise.all(all.filter((x) => x.label === label).map((x) => store.deleteSample(x.id)));
  },
  putClip: (label, blob) => tx('clips', 'readwrite', (s) => s.put({ label, blob, type: blob.type, at: Date.now() })),
  clip: (label) => tx('clips', 'readonly', (s) => s.get(label)),
  clips: () => tx('clips', 'readonly', (s) => s.getAll()),

  async exportPack() {
    const samples = await store.samples();
    const clips = {};
    for (const c of await store.clips()) clips[c.label] = await blobToDataURL(c.blob);
    return new Blob([JSON.stringify({ tulayPack: 1, samples, clips })], { type: 'application/json' });
  },

  async importPack(file) {
    const pack = JSON.parse(await file.text());
    if (pack.tulayPack !== 1) throw new Error('hindi Tulay pack ang file');
    for (const s of pack.samples) await store.addSample(s.label, s.frames, s.source || 'pack');
    for (const [label, url] of Object.entries(pack.clips || {})) {
      await store.putClip(label, await (await fetch(url)).blob());
    }
    return { samples: pack.samples.length, clips: Object.keys(pack.clips || {}).length };
  },
};

function blobToDataURL(blob) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(blob);
  });
}

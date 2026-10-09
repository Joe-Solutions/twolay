// Main-thread side of the Kokoro voice: loads the worker in the background and returns audio per text.
import { netlog } from './netlog.js';
import { connectAI } from './ai.js';

let worker;
let booted;
let ready = null;
let isReady = false;
let nextId = 1;
const pending = new Map();
const cache = new Map();   // text -> {audio, rate}; sign words repeat a lot

function getWorker() {
  if (worker) return worker;
  worker = connectAI('kokoro');
  // The service is ready for messages once it says 'booted'.
  booted = new Promise((res) => {
    worker.addEventListener('message', function first(e) {
      if (e.data.type === 'booted') {
        worker.removeEventListener('message', first);
        res();
      }
    });
  });
  worker.addEventListener('message', ({ data }) => {
    if ((data.type === 'audio' || data.type === 'error') && data.id) {
      pending.get(data.id)?.(data);
      pending.delete(data.id);
    }
  });
  return worker;
}

/** Start loading Kokoro (about 90 MB from this app's own cache). Safe to call repeatedly. */
export function loadKokoro() {
  ready ??= new Promise((res, rej) => {
    netlog.model('Kokoro-82M v1.0 (int8 ONNX), voice ef_dora', 'models/onnx-community/Kokoro-82M-v1.0-ONNX/');
    const w = getWorker();
    const h = ({ data }) => {
      if (data.type === 'ready') { w.removeEventListener('message', h); isReady = true; markLoaded(); res(); }
      if (data.type === 'error' && !data.id) { w.removeEventListener('message', h); rej(new Error(data.error)); }
    };
    w.addEventListener('message', h);
    booted.then(() => w.postMessage({ type: 'load' }));
  });
  ready.catch((err) => {
    netlog.info(`Kokoro unavailable, using fallback voice: ${err.message}`);
    ready = null;
  });
  return ready;
}

export const kokoroReady = () => isReady;
let markLoaded;
const loaded = new Promise((r) => (markLoaded = r));
/** Resolves once Kokoro has loaded, without starting it. */
export const whenKokoroLoaded = () => loaded;

/**
 * Synthesize text; resolves to {audio: Float32Array, rate}.
 * lang 'en' uses the English voice; strict rejects English words missing from the lexicon.
 */
export function synthesize(text, { lang = 'fil', strict = false } = {}) {
  const key = `${lang}|${text.trim().toLowerCase()}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, (d) => {
      if (d.type === 'error') return rej(new Error(d.error));
      const out = { audio: d.audio, rate: d.rate };
      remember(key, out);
      res(out);
    });
    getWorker();
    booted.then(() => worker.postMessage({ type: 'say', id, text, lang, strict }));
  });
}

function remember(key, out) {
  cache.set(key, out);
  if (cache.size > 60) cache.delete(cache.keys().next().value);
}

// ---------- saved audio for words said again and again (the signs) ----------
// Generating a word takes 1-3 s; saved, it plays at once, even before Kokoro has loaded.
// Not named twolay-*: the offline updater treats those caches as old app copies.
const SAVED = 'voice-kokoro-v1';
const savedURL = (key) => new URL(`/__voice/${encodeURIComponent(key)}`, location.origin).href;

/** Saved audio for this text, or null. Never waits for Kokoro. */
export async function savedVoice(text, { lang = 'fil' } = {}) {
  const key = `${lang}|${text.trim().toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  if (!('caches' in window)) return null;
  const res = await (await caches.open(SAVED)).match(savedURL(key)).catch(() => null);
  if (!res) return null;
  const out = { audio: new Float32Array(await res.arrayBuffer()), rate: Number(res.headers.get('x-rate')) };
  remember(key, out);
  return out;
}

// The AI worker is shared, so background voices pause while the mic's VAD and Whisper need it.
let held = false;
export function holdVoices(on) {
  held = on;
}

/** Generate (once, in the background) and save audio for each text. */
export async function saveVoices(texts, { lang = 'fil' } = {}) {
  if (!('caches' in window)) return;
  await loadKokoro();
  const store = await caches.open(SAVED);
  for (const text of texts) {
    while (held) await new Promise((r) => setTimeout(r, 250));
    const key = `${lang}|${text.trim().toLowerCase()}`;
    if (await store.match(savedURL(key))) continue;
    // English: only words the lexicon knows; others are left to the system English voice, as when speaking.
    const out = await synthesize(text, { lang, strict: lang === 'en' }).catch(() => null);
    if (out) await store.put(savedURL(key), new Response(out.audio.slice().buffer, { headers: { 'x-rate': String(out.rate) } }));
  }
}

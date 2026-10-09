// Main-thread side of the Kokoro voice: loads the worker in the background and returns audio per text.
import { netlog } from './netlog.js';

let worker;
let booted;
let ready = null;
let isReady = false;
let nextId = 1;
const pending = new Map();
const cache = new Map();   // text -> {audio, rate}; sign words repeat a lot

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
  // The worker sets onmessage only after its imports; messages sent earlier would be dropped.
  booted = new Promise((res) => {
    worker.addEventListener('message', function first(e) {
      if (e.data.type === 'booted') {
        worker.removeEventListener('message', first);
        res();
      }
    });
  });
  worker.addEventListener('message', ({ data }) => {
    if (data.type === 'net') {
      if (data.blocked) netlog.blocked(data.url, 'tts-worker fetch');
      else netlog.resource(data.url, 'tts-worker');
    } else if (data.type === 'audio' || data.type === 'error') {
      pending.get(data.id)?.(data);
      pending.delete(data.id);
    }
  });
  worker.onerror = (e) => netlog.info(`kokoro worker error: ${e.message}`);
  return worker;
}

/** Start loading Kokoro (about 90 MB from this app's own cache). Safe to call repeatedly. */
export function loadKokoro() {
  ready ??= new Promise((res, rej) => {
    netlog.model('Kokoro-82M v1.0 (int8 ONNX), voice ef_dora', 'models/onnx-community/Kokoro-82M-v1.0-ONNX/');
    const w = getWorker();
    const h = ({ data }) => {
      if (data.type === 'ready') { w.removeEventListener('message', h); isReady = true; res(); }
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

/** Synthesize text; resolves to {audio: Float32Array, rate}. */
export function synthesize(text) {
  const key = text.trim().toLowerCase();
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, (d) => {
      if (d.type === 'error') return rej(new Error(d.error));
      const out = { audio: d.audio, rate: d.rate };
      cache.set(key, out);
      if (cache.size > 60) cache.delete(cache.keys().next().value);
      res(out);
    });
    getWorker();
    booted.then(() => worker.postMessage({ type: 'say', id, text }));
  });
}

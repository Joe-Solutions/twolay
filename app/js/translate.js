// Main-thread side of the offline English <-> Filipino translator (OPUS-MT, ai-translate.js in ai-worker.js).
import { netlog } from './netlog.js';
import { connectAI } from './ai.js';

let worker;
let booted;
let nextId = 1;
const pending = new Map();
const loading = {};
const ready = new Set();
const cache = new Map();   // `${dir}|text` -> translation

function getWorker() {
  if (worker) return worker;
  worker = connectAI('translate');
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
    if ((data.type === 'result' || data.type === 'error') && data.id) {
      pending.get(data.id)?.(data);
      pending.delete(data.id);
    }
  });
  return worker;
}

/** Start loading one direction ('en-tl' or 'tl-en'), about 134 MB each. Safe to call repeatedly. */
export function loadTranslator(dir) {
  loading[dir] ??= new Promise((res, rej) => {
    netlog.model(`OPUS-MT ${dir} (Marian, int8 ONNX)`, `models/Helsinki-NLP/opus-mt-${dir}/`);
    const w = getWorker();
    const h = ({ data }) => {
      if (data.dir !== dir || data.id) return;
      if (data.type === 'ready') { w.removeEventListener('message', h); ready.add(dir); res(); }
      if (data.type === 'error') { w.removeEventListener('message', h); rej(new Error(data.error)); }
    };
    w.addEventListener('message', h);
    booted.then(() => w.postMessage({ type: 'load', dir }));
  });
  loading[dir].catch((err) => {
    netlog.info(`translator ${dir} unavailable: ${err.message}`);
    delete loading[dir];
  });
  return loading[dir];
}

export const translatorReady = (dir) => ready.has(dir);

/** Translate short text. dir: 'en-tl' (English -> Filipino) or 'tl-en'. */
export async function translate(text, dir) {
  const key = `${dir}|${text.trim().toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  await loadTranslator(dir);
  const id = nextId++;
  const out = await new Promise((res, rej) => {
    pending.set(id, (d) => (d.type === 'error' ? rej(new Error(d.error)) : res(d.text)));
    worker.postMessage({ type: 'translate', id, dir, text });
  });
  cache.set(key, out);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return out;
}

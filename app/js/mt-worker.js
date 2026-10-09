// OPUS-MT English <-> Tagalog (Marian, int8 ONNX) running in this worker via Transformers.js + ONNX Runtime wasm.
// Every file is loaded from this app's own origin; remote model download is disabled.
const ownOrigin = self.location.origin;
const realFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), self.location.href);
  if (url.origin !== ownOrigin && !['blob:', 'data:'].includes(url.protocol)) {
    self.postMessage({ type: 'net', blocked: true, url: url.href });
    return Promise.reject(new TypeError(`Twolay offline guard blocked ${url.href}`));
  }
  self.postMessage({ type: 'net', url: url.href });
  return realFetch(input, init);
};

const { pipeline, env } = await import('../vendor/transformers/transformers.js');

const base = new URL('..', import.meta.url);
env.allowRemoteModels = false;
env.allowLocalModels = true;
// Must be a path, not a full URL: transformers 4.3.1 skips local file checks for http(s) URLs.
env.localModelPath = new URL('models/', base).pathname;
env.useBrowserCache = false;
const oldSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) && !('gpu' in navigator);
const variant = oldSafari ? '' : '.asyncify';
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL(`vendor/ort/ort-wasm-simd-threaded${variant}.mjs`, base).href,
  wasm: new URL(`vendor/ort/ort-wasm-simd-threaded${variant}.wasm`, base).href,
};
env.backends.onnx.wasm.numThreads = 1;

const MODELS = { 'en-tl': 'Helsinki-NLP/opus-mt-en-tl', 'tl-en': 'Helsinki-NLP/opus-mt-tl-en' };
const pipes = {};

function load(dir) {
  if (!MODELS[dir]) throw new Error(`unknown direction ${dir}`);
  pipes[dir] ??= pipeline('translation', MODELS[dir], { dtype: 'q8', device: 'wasm' });
  return pipes[dir];
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load(data.dir);
      self.postMessage({ type: 'ready', dir: data.dir, model: MODELS[data.dir] });
    } else if (data.type === 'translate') {
      const t0 = performance.now();
      const [out] = await (await load(data.dir))(data.text, { max_new_tokens: 64 });
      self.postMessage({ type: 'result', id: data.id, text: (out?.translation_text || '').trim(), ms: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, dir: data.dir, error: String(err?.message || err) });
  }
};

self.postMessage({ type: 'booted' });

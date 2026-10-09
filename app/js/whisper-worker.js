// Whisper tiny (multilingual, int8 ONNX) running in this worker via Transformers.js + ONNX Runtime wasm.
// Every file is loaded from this app's own origin; remote model download is disabled.
const ownOrigin = self.location.origin;
const realFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, self.location.href);
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

const MODEL = 'onnx-community/whisper-tiny';
let asr;

async function load() {
  asr ??= pipeline('automatic-speech-recognition', MODEL, {
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    device: 'wasm',
    progress_callback: (p) => {
      if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, progress: p.progress });
    },
  });
  return asr;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load();
      self.postMessage({ type: 'ready', model: MODEL });
    } else if (data.type === 'transcribe') {
      const t0 = performance.now();
      const out = await (await load())(data.audio, {
        language: data.language || 'tagalog',
        task: 'transcribe',
        max_new_tokens: 48,
      });
      self.postMessage({ type: 'result', id: data.id, text: (out.text || '').trim(), ms: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, error: String(err?.message || err) });
  }
};

self.postMessage({ type: 'booted' });

// One worker and one ONNX Runtime for every model: Whisper, Silero VAD, Kokoro and OPUS-MT.
// iPhone Safari fails with "RangeError: Out of memory" once each model has a runtime of its own.
// Each model is a service (ai-*.js) talking to its main-thread module over its own MessagePort.
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

const SERVICES = {
  whisper: './ai-whisper.js',
  vad: './ai-vad.js',
  kokoro: './ai-kokoro.js',
  translate: './ai-translate.js',
};

const base = new URL('..', import.meta.url);
const lib = import('../vendor/transformers/transformers.js').then((tf) => {
  const { env } = tf;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  // Must be a path, not a full URL: transformers 4.3.1 skips local file checks for http(s) URLs.
  env.localModelPath = new URL('models/', base).pathname;
  env.useBrowserCache = false;
  // Plain wasm build, not .asyncify (WebGPU/JSPI only): asyncify costs ~700 MB more in Safari.
  env.backends.onnx.wasm.wasmPaths = {
    mjs: new URL('vendor/ort/ort-wasm-simd-threaded.mjs', base).href,
    wasm: new URL('vendor/ort/ort-wasm-simd-threaded.wasm', base).href,
  };
  env.backends.onnx.wasm.numThreads = 1;
  return tf;
});

// Set before any await: a module worker drops messages that arrive while it has no handler.
self.onmessage = async ({ data }) => {
  if (data.type !== 'connect') return;
  const { svc, port } = data;
  try {
    if (!SERVICES[svc]) throw new Error(`unknown service ${svc}`);
    const [tf, mod] = await Promise.all([lib, import(SERVICES[svc])]);
    mod.serve(port, tf);
  } catch (err) {
    port.postMessage({ type: 'booted' });
    port.postMessage({ type: 'error', error: String(err?.message || err) });
  }
};

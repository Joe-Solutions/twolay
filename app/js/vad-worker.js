// Silero VAD v5 (2 MB ONNX) in this worker: speech probability per 32 ms frame of 16 kHz audio.
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

const { AutoModel, Tensor, env } = await import('../vendor/transformers/transformers.js');

const base = new URL('..', import.meta.url);
env.allowRemoteModels = false;
env.allowLocalModels = true;
// Must be a path, not a full URL: transformers 4.3.1 skips local file checks for http(s) URLs.
env.localModelPath = new URL('models/', base).pathname;
env.useBrowserCache = false;
// Plain wasm build, not .asyncify (WebGPU/JSPI only): asyncify costs ~700 MB more per model in Safari,
// enough to crash an iPhone tab with Whisper and Kokoro both loaded.
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('vendor/ort/ort-wasm-simd-threaded.mjs', base).href,
  wasm: new URL('vendor/ort/ort-wasm-simd-threaded.wasm', base).href,
};
env.backends.onnx.wasm.numThreads = 1;

const MODEL = 'onnx-community/silero-vad';
const FRAME = 512;             // samples per frame at 16 kHz
const CONTEXT = 64;            // v5 expects the last 64 samples of the previous frame in front
let model;
let state;
let context;
const sr = new Tensor('int64', [16000n], []);

function reset() {
  state = new Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  context = new Float32Array(CONTEXT);
}

async function load() {
  model ??= AutoModel.from_pretrained(MODEL, { config: { model_type: 'custom' }, dtype: 'fp32', device: 'wasm' });
  return model;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load();
      reset();
      self.postMessage({ type: 'ready', model: MODEL });
    } else if (data.type === 'reset') {
      reset();
    } else if (data.type === 'frames') {
      const vad = await load();
      if (!state) reset();
      const probs = [];
      for (let o = 0; o + FRAME <= data.audio.length; o += FRAME) {
        const input = new Float32Array(CONTEXT + FRAME);
        input.set(context);
        input.set(data.audio.subarray(o, o + FRAME), CONTEXT);
        const out = await vad({ input: new Tensor('float32', input, [1, input.length]), sr, state });
        state = out.stateN;
        context = input.slice(-CONTEXT);
        probs.push(out.output.data[0]);
      }
      self.postMessage({ type: 'probs', id: data.id, probs });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, error: String(err?.message || err) });
  }
};

self.postMessage({ type: 'booted' });

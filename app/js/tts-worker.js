// Kokoro-82M (int8 ONNX) text-to-speech in this worker via Transformers.js + ONNX Runtime wasm.
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

const { StyleTextToSpeech2Model, AutoTokenizer, Tensor, env } = await import('../vendor/transformers/transformers.js');
const { tagalogToIPA } = await import('./tl-g2p.js');
const { englishToIPA } = await import('./en-g2p.js');

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

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// Spanish voice for Filipino: Tagalog vowels and the tapped r are close to Spanish.
const VOICES = { fil: 'ef_dora', en: 'af_heart' };
const STYLE = 256;
let loaded;
const voices = {};
let lexicon;

function voice(lang) {
  const name = VOICES[lang] ?? VOICES.fil;
  voices[name] ??= fetch(new URL(`models/${MODEL}/voices/${name}.bin`, base)).then(async (r) => {
    if (!r.ok) throw new Error(`voice ${name}: HTTP ${r.status}`);
    return new Float32Array(await r.arrayBuffer());
  });
  return voices[name];
}

function englishLexicon() {
  lexicon ??= fetch(new URL('models/en-lexicon.json', base)).then((r) => {
    if (!r.ok) throw new Error(`en-lexicon: HTTP ${r.status}`);
    return r.json();
  });
  return lexicon;
}

async function load() {
  loaded ??= Promise.all([
    StyleTextToSpeech2Model.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm' }),
    AutoTokenizer.from_pretrained(MODEL),
    voice('fil'),
  ]).then(([model, tokenizer]) => ({ model, tokenizer }));
  return loaded;
}

async function toPhonemes(text, lang, strict) {
  if (lang !== 'en') return tagalogToIPA(text);
  const { ipa, missing } = englishToIPA(text, await englishLexicon());
  if (strict && missing.length) throw new Error(`oov: ${missing.join(' ')}`);
  return ipa;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load();
      self.postMessage({ type: 'ready', model: MODEL, voice: VOICES.fil });
    } else if (data.type === 'say') {
      const t0 = performance.now();
      const { model, tokenizer } = await load();
      const phonemes = (await toPhonemes(data.text, data.lang, data.strict)).slice(0, 400);
      const style = await voice(data.lang);
      const { input_ids } = tokenizer(phonemes, { truncation: true });
      const at = Math.min(Math.max(input_ids.dims.at(-1) - 2, 0), 509) * STYLE;
      const { waveform } = await model({
        input_ids,
        style: new Tensor('float32', style.slice(at, at + STYLE), [1, STYLE]),
        speed: new Tensor('float32', [data.speed ?? 0.9], [1]),
      });
      const audio = new Float32Array(waveform.data);
      self.postMessage(
        { type: 'audio', id: data.id, audio, rate: 24000, phonemes, ms: Math.round(performance.now() - t0) },
        [audio.buffer],
      );
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, error: String(err?.message || err) });
  }
};

self.postMessage({ type: 'booted' });

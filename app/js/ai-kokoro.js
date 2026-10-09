// Kokoro-82M (int8 ONNX) text-to-speech, a service in ai-worker.js (Transformers.js + ONNX Runtime wasm).
import { tagalogToIPA } from './tl-g2p.js';
import { englishToIPA } from './en-g2p.js';

const base = new URL('..', import.meta.url);

/** Runs inside ai-worker.js; `port` is this service's MessagePort. */
export function serve(port, { StyleTextToSpeech2Model, AutoTokenizer, Tensor }) {
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

  port.onmessage = async ({ data }) => {
    try {
      if (data.type === 'load') {
        await load();
        port.postMessage({ type: 'ready', model: MODEL, voice: VOICES.fil });
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
        port.postMessage(
          { type: 'audio', id: data.id, audio, rate: 24000, phonemes, ms: Math.round(performance.now() - t0) },
          [audio.buffer],
        );
      }
    } catch (err) {
      port.postMessage({ type: 'error', id: data.id, error: String(err?.message || err) });
    }
  };

  port.postMessage({ type: 'booted' });
}

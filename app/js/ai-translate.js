// OPUS-MT English <-> Tagalog (Marian, int8 ONNX), a service in ai-worker.js.

/** Runs inside ai-worker.js; `port` is this service's MessagePort. */
export function serve(port, { pipeline }) {
  const MODELS = { 'en-tl': 'Helsinki-NLP/opus-mt-en-tl', 'tl-en': 'Helsinki-NLP/opus-mt-tl-en' };
  const pipes = {};

  function load(dir) {
    if (!MODELS[dir]) throw new Error(`unknown direction ${dir}`);
    pipes[dir] ??= pipeline('translation', MODELS[dir], { dtype: 'q8', device: 'wasm' });
    return pipes[dir];
  }

  port.onmessage = async ({ data }) => {
    try {
      if (data.type === 'load') {
        await load(data.dir);
        port.postMessage({ type: 'ready', dir: data.dir, model: MODELS[data.dir] });
      } else if (data.type === 'translate') {
        const t0 = performance.now();
        const [out] = await (await load(data.dir))(data.text, { max_new_tokens: 64 });
        port.postMessage({ type: 'result', id: data.id, text: (out?.translation_text || '').trim(), ms: Math.round(performance.now() - t0) });
      }
    } catch (err) {
      port.postMessage({ type: 'error', id: data.id, dir: data.dir, error: String(err?.message || err) });
    }
  };

  port.postMessage({ type: 'booted' });
}

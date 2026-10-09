// Silero VAD v5 (2 MB ONNX), a service in ai-worker.js: speech probability per 32 ms frame of 16 kHz audio.

/** Runs inside ai-worker.js; `port` is this service's MessagePort. */
export function serve(port, { AutoModel, Tensor }) {
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

  port.onmessage = async ({ data }) => {
    try {
      if (data.type === 'load') {
        await load();
        reset();
        port.postMessage({ type: 'ready', model: MODEL });
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
        port.postMessage({ type: 'probs', id: data.id, probs });
      }
    } catch (err) {
      port.postMessage({ type: 'error', id: data.id, error: String(err?.message || err) });
    }
  };

  port.postMessage({ type: 'booted' });
}

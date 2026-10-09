// Whisper tiny (multilingual, int8 ONNX), a service in ai-worker.js (Transformers.js + ONNX Runtime wasm).

/** Runs inside ai-worker.js; `port` is this service's MessagePort. */
export function serve(port, { pipeline }) {
  const MODEL = 'onnx-community/whisper-tiny';
  let asr;

  async function load() {
    asr ??= pipeline('automatic-speech-recognition', MODEL, {
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress') port.postMessage({ type: 'progress', file: p.file, progress: p.progress });
      },
    });
    return asr;
  }

  port.onmessage = async ({ data }) => {
    try {
      if (data.type === 'load') {
        await load();
        port.postMessage({ type: 'ready', model: MODEL });
      } else if (data.type === 'transcribe') {
        const t0 = performance.now();
        const out = await (await load())(data.audio, {
          language: data.language || 'tagalog',
          task: 'transcribe',
          max_new_tokens: 48,
        });
        port.postMessage({ type: 'result', id: data.id, text: (out.text || '').trim(), ms: Math.round(performance.now() - t0) });
      }
    } catch (err) {
      port.postMessage({ type: 'error', id: data.id, error: String(err?.message || err) });
    }
  };

  port.postMessage({ type: 'booted' });
}

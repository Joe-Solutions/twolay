// Microphone capture with simple energy VAD, then local Whisper tiny in a worker.
import { netlog } from './netlog.js';

const TARGET_RATE = 16000;
const MAX_MS = 7000;
const NO_SPEECH_MS = 5000;
const END_SILENCE_MS = 900;

let worker;
let booted;
let ready;
let nextId = 1;
const pending = new Map();
let onProgress = () => {};

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
  booted = new Promise((res) => {
    worker.addEventListener('message', function first(e) {
      if (e.data.type === 'booted') {
        worker.removeEventListener('message', first);
        res();
      }
    });
  });
  worker.addEventListener('message', ({ data }) => {
    if (data.type === 'net') {
      if (data.blocked) netlog.blocked(data.url, 'whisper-worker fetch');
      else netlog.resource(data.url, 'whisper-worker');
    } else if (data.type === 'progress') onProgress(data);
    else if (data.type === 'result' || data.type === 'error') {
      pending.get(data.id)?.(data);
      pending.delete(data.id);
    }
  });
  worker.onerror = (e) => netlog.info(`whisper worker error: ${e.message}`);
  return worker;
}

export function loadWhisper(progress) {
  if (progress) onProgress = progress;
  ready ??= (async () => {
    netlog.model('Whisper tiny (multilingual, int8 ONNX)', 'models/onnx-community/whisper-tiny/');
    const w = getWorker();
    await booted;
    return new Promise((res, rej) => {
      const h = ({ data }) => {
        if (data.type === 'ready') { w.removeEventListener('message', h); res(); }
        if (data.type === 'error' && !data.id) { w.removeEventListener('message', h); rej(new Error(data.error)); }
      };
      w.addEventListener('message', h);
      w.postMessage({ type: 'load' });
    });
  })();
  ready.catch(() => (ready = null));
  return ready;
}

export async function transcribe(audio, language = 'tagalog') {
  await loadWhisper();
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, (d) => (d.type === 'error' ? rej(new Error(d.error)) : res(d)));
    getWorker().postMessage({ type: 'transcribe', id, audio, language }, [audio.buffer]);
  });
}

function resampleTo16k(chunks, rate) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const src = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { src.set(c, o); o += c.length; }
  if (rate === TARGET_RATE) return src;
  const ratio = rate / TARGET_RATE;
  const out = new Float32Array(Math.floor(len / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(len, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += src[j];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}

/**
 * Record one utterance. Resolves { audio: Float32Array@16k, heardSpeech } when the speaker
 * pauses, after MAX_MS, or when stop() is called.
 */
export function recordUtterance({ onLevel } = {}) {
  let stopFn;
  const done = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    const srcNode = ctx.createMediaStreamSource(stream);
    const chunks = [];
    let node;
    const onChunk = (buf) => chunks.push(buf);
    if (ctx.audioWorklet) {
      await ctx.audioWorklet.addModule(new URL('./rec-worklet.js', import.meta.url));
      node = new AudioWorkletNode(ctx, 'tulay-rec');
      node.port.onmessage = (e) => onChunk(e.data);
    } else {
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => onChunk(e.inputBuffer.getChannelData(0).slice(0));
    }
    srcNode.connect(node);
    node.connect(ctx.destination);

    const t0 = performance.now();
    let floor = Infinity;
    let speechAt = 0;
    let lastVoice = 0;
    let seen = 0;

    await new Promise((resolve) => {
      stopFn = resolve;
      const tick = () => {
        const now = performance.now() - t0;
        const recent = chunks.slice(seen);
        seen = chunks.length;
        for (const c of recent) {
          let s = 0;
          for (let i = 0; i < c.length; i++) s += c[i] * c[i];
          const rms = Math.sqrt(s / c.length);
          // Quietest chunk = room noise, so speaking right after the tap doesn't raise the bar.
          floor = Math.min(floor, Math.max(0.002, Math.min(0.03, rms)));
          const voiced = rms > Math.max(0.015, floor * 3);
          if (voiced) { lastVoice = now; speechAt ||= now; }
          onLevel?.(Math.min(1, rms * 12), voiced);
        }
        if (now > MAX_MS) return resolve();
        if (!speechAt && now > NO_SPEECH_MS) return resolve();
        if (speechAt && now - lastVoice > END_SILENCE_MS) return resolve();
        setTimeout(tick, 60);
      };
      tick();
    });

    srcNode.disconnect();
    node.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    const rate = ctx.sampleRate;
    await ctx.close();
    return { audio: resampleTo16k(chunks, rate), heardSpeech: !!speechAt };
  })();
  return { done, stop: () => stopFn?.() };
}

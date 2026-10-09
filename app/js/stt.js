// Microphone capture with Silero VAD (energy VAD as fallback), then local Whisper tiny, both in ai-worker.js.
import { netlog } from './netlog.js';
import { connectAI } from './ai.js';

const TARGET_RATE = 16000;
const MAX_MS = 7000;
const NO_SPEECH_MS = 5000;
const END_SILENCE_MS = 900;
const VAD_FRAME = 512;            // 32 ms at 16 kHz
const VAD_ON = 0.5;               // speech starts above this probability
const VAD_OFF = 0.35;             // and continues while above this
const VAD_MIN_FRAMES = 3;         // ~100 ms of speech before it counts
const LEAD_IN_MS = 400;           // audio kept before the detected start

// ---------- Silero VAD ----------
let vadWorker;
let vadReady = null;
let vadOk = false;
let vadNext = 1;
const vadPending = new Map();

export function loadVAD() {
  vadReady ??= new Promise((res, rej) => {
    netlog.model('Silero VAD v5 (ONNX)', 'models/onnx-community/silero-vad/');
    vadWorker = connectAI('vad');
    vadWorker.addEventListener('message', ({ data }) => {
      if (data.type === 'booted') vadWorker.postMessage({ type: 'load' });
      else if (data.type === 'ready') { vadOk = true; res(); }
      else if (data.id) {
        vadPending.get(data.id)?.(data);
        vadPending.delete(data.id);
      } else if (data.type === 'error') rej(new Error(data.error));
    });
  });
  vadReady.catch((err) => {
    netlog.info(`Silero VAD unavailable, using energy VAD: ${err.message}`);
    vadOk = false;
  });
  return vadReady;
}

export const vadActive = () => vadOk;

function vadProbs(audio) {
  const id = vadNext++;
  return new Promise((res) => {
    vadPending.set(id, (d) => res(d.type === 'probs' ? d.probs : null));
    vadWorker.postMessage({ type: 'frames', id, audio }, [audio.buffer]);
  });
}

/** Streaming average-downsampler to 16 kHz. */
class Downsampler {
  constructor(rate) {
    this.ratio = rate / TARGET_RATE;
    this.acc = 0;
    this.n = 0;
    this.pos = 0;   // source samples consumed toward the current output sample
  }
  push(chunk) {
    const out = [];
    for (let i = 0; i < chunk.length; i++) {
      this.acc += chunk[i];
      this.n++;
      if (++this.pos >= this.ratio) {
        out.push(this.acc / this.n);
        this.acc = 0;
        this.n = 0;
        this.pos -= this.ratio;
      }
    }
    return out;
  }
}

let worker;
let booted;
let ready;
let nextId = 1;
const pending = new Map();
let onProgress = () => {};

function getWorker() {
  if (worker) return worker;
  worker = connectAI('whisper');
  booted = new Promise((res) => {
    worker.addEventListener('message', function first(e) {
      if (e.data.type === 'booted') {
        worker.removeEventListener('message', first);
        res();
      }
    });
  });
  worker.addEventListener('message', ({ data }) => {
    if (data.type === 'progress') onProgress(data);
    else if (data.type === 'result' || data.type === 'error') {
      pending.get(data.id)?.(data);
      pending.delete(data.id);
    }
  });
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
      node = new AudioWorkletNode(ctx, 'twolay-rec');
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

    // Silero decides on audio time (ms of 16 kHz audio); energy VAD is only the fallback.
    const useVad = vadOk;
    if (useVad) vadWorker.postMessage({ type: 'reset' });
    const down = new Downsampler(ctx.sampleRate);
    let vadBuf = [];
    let vadBusy = false;
    let vadFrames = 0;
    let voicedRun = 0;
    let inSpeech = false;
    let vadStartMs = -1;
    let vadLastMs = -1;

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
          const voiced = useVad ? inSpeech : rms > Math.max(0.015, floor * 3);
          if (!useVad && voiced) { lastVoice = now; speechAt ||= now; }
          onLevel?.(Math.min(1, rms * 12), voiced);
          if (useVad) vadBuf.push(...down.push(c));
        }
        if (useVad && !vadBusy && vadBuf.length >= VAD_FRAME) {
          const n = Math.floor(vadBuf.length / VAD_FRAME) * VAD_FRAME;
          const batch = Float32Array.from(vadBuf.slice(0, n));
          vadBuf = vadBuf.slice(n);
          vadBusy = true;
          vadProbs(batch).then((probs) => {
            vadBusy = false;
            for (const p of probs ?? []) {
              const ms = (vadFrames++ * VAD_FRAME * 1000) / TARGET_RATE;
              voicedRun = p > (inSpeech ? VAD_OFF : VAD_ON) ? voicedRun + 1 : 0;
              if (voicedRun >= VAD_MIN_FRAMES && !inSpeech) {
                inSpeech = true;
                if (vadStartMs < 0) vadStartMs = ms - (VAD_MIN_FRAMES - 1) * 32;
              }
              if (p > VAD_OFF && vadStartMs >= 0) vadLastMs = ms;
              if (p <= VAD_OFF) inSpeech = false;
            }
          });
        }
        const audioMs = (vadFrames * VAD_FRAME * 1000) / TARGET_RATE;
        if (now > MAX_MS) return resolve();
        if (useVad) {
          if (vadStartMs < 0 && audioMs > NO_SPEECH_MS) return resolve();
          if (vadStartMs >= 0 && audioMs - vadLastMs > END_SILENCE_MS) return resolve();
        } else {
          if (!speechAt && now > NO_SPEECH_MS) return resolve();
          if (speechAt && now - lastVoice > END_SILENCE_MS) return resolve();
        }
        setTimeout(tick, 60);
      };
      tick();
    });

    srcNode.disconnect();
    node.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    const rate = ctx.sampleRate;
    await ctx.close();
    let audio = resampleTo16k(chunks, rate);
    if (useVad && vadStartMs > LEAD_IN_MS) audio = audio.slice(Math.floor(((vadStartMs - LEAD_IN_MS) * TARGET_RATE) / 1000));
    return { audio, heardSpeech: useVad ? vadStartMs >= 0 : !!speechAt, vad: useVad ? 'silero' : 'energy' };
  })();
  return { done, stop: () => stopFn?.() };
}

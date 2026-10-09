// Local speech output. Never uses a network voice:
//   1. Kokoro-82M running in a worker on this device, once loaded
//   2. an on-device system voice for Filipino (speechSynthesis, localService === true only)
//   3. pre-rendered espeak-ng / Piper clip shipped in app/audio/<label>.wav
//   4. any other on-device system voice
import { LABELS } from './signs.js';
import { kokoroReady, synthesize } from './kokoro.js';
import { buzz } from './haptics.js';

const audioBase = new URL('../audio/', import.meta.url);
let voices = [];

function loadVoices() {
  voices = (speechSynthesis?.getVoices() ?? []).filter((v) => v.localService);
}
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

const filipinoVoice = () => voices.find((v) => /^(fil|tl)\b/i.test(v.lang) || /filipino|tagalog/i.test(v.name));
const englishVoice = () => voices.find((v) => /^en\b/i.test(v.lang));

export let lastEngine = 'none';

export function voiceInfo() {
  const v = filipinoVoice();
  const fallback = v ? `system: ${v.name} (${v.lang}, on-device)` : 'clips: app/audio (espeak-ng) + on-device system voice';
  return `${kokoroReady() ? 'Kokoro-82M (ef_dora Filipino, af_heart English), on-device' : 'Kokoro: naglo-load pa'} · fallback: ${fallback} · huling ginamit: ${lastEngine}`;
}

let kokoroSource;
async function playKokoro(text, opts, pre) {
  if (!pre && !kokoroReady()) return false;
  try {
    const { audio, rate } = pre ?? (await synthesize(text, opts));
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    await actx.resume();
    const buf = actx.createBuffer(1, audio.length, rate);
    buf.copyToChannel(audio, 0);
    kokoroSource?.stop();
    const src = (kokoroSource = actx.createBufferSource());
    src.buffer = buf;
    src.connect(actx.destination);
    await new Promise((res) => {
      src.onended = res;
      src.start();
    });
    return true;
  } catch {
    return false;
  }
}

function speakSystem(text, voice) {
  return new Promise((res) => {
    if (!('speechSynthesis' in window) || !voice) return res(false);
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = 0.95;
    u.onend = () => res(true);
    u.onerror = () => res(false);
    speechSynthesis.speak(u);
  });
}

function playClip(label) {
  return new Promise((res) => {
    const a = new Audio(new URL(`${label}.wav`, audioBase).href);
    a.onended = () => res(true);
    a.onerror = () => res(false);
    a.play().catch(() => res(false));
  });
}

/** Speak English with a native English voice; Kokoro only when every word is in the lexicon. */
export async function speakEnglish(text) {
  lastEngine = await (async () => {
    if (await playKokoro(text, { lang: 'en', strict: true })) return 'kokoro-en';
    if (await speakSystem(text, englishVoice())) return 'system-en';
    if (await playKokoro(text, { lang: 'en' })) return 'kokoro-en-guess';
    return 'none';
  })();
  return lastEngine;
}

/** Speak a sign label (e.g. 'tulong') or free text. */
export async function speak(text, label) {
  lastEngine = await (async () => {
    if (await playKokoro(text)) return 'kokoro';
    const fil = filipinoVoice();
    if (fil && (await speakSystem(text, fil))) return 'system';
    if (label && LABELS.includes(label) && (await playClip(label))) return 'clip';
    if (await speakSystem(text, voices[0])) return 'system-other';
    return 'none';
  })();
  return lastEngine;
}

// ---------- navigation prompts ----------
// Short, interruptible: a new prompt or stopSpeech() cuts the current one off. The fastest voice wins
// (a cached Kokoro clip, then an on-device system voice), since these answer every swipe.
const promptCache = new Map();
let promptToken = 0;

export function stopSpeech() {
  promptToken++;
  kokoroSource?.stop();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

async function cachedPrompt(text, lang) {
  const key = `${lang}:${text}`;
  if (!promptCache.has(key)) {
    const opts = lang === 'en' ? { lang: 'en' } : undefined;
    promptCache.set(key, synthesize(text, opts).catch(() => promptCache.delete(key)));
  }
  return promptCache.get(key);
}

/** Speak a navigation prompt in 'fil' or 'en'. */
export async function say(text, lang = 'fil') {
  stopSpeech();
  const token = promptToken;
  const key = `${lang}:${text}`;
  const ready = promptCache.has(key) && (await Promise.race([promptCache.get(key), null]));
  if (ready?.audio) return playKokoro(text, null, ready);
  const sys = lang === 'en' ? englishVoice() : filipinoVoice();
  if (sys) return speakSystem(text, sys);
  if (!kokoroReady()) return speakSystem(text, voices[0]);
  const pre = await cachedPrompt(text, lang);
  if (token !== promptToken || !pre?.audio) return false;
  return playKokoro(text, null, pre);
}

/** Render prompts in the background once Kokoro is loaded, so swipes answer instantly. */
export async function prewarm(texts, lang = 'fil') {
  if (lang === 'en' ? englishVoice() : filipinoVoice()) return;
  for (const t of texts) {
    if (!kokoroReady()) return;
    await cachedPrompt(t, lang);
  }
}

// Short tones so a blind user knows what the app is doing without looking.
let actx;
export function earcon(kind) {
  actx ??= new (window.AudioContext || window.webkitAudioContext)();
  const seq = {
    start: [[660, 0.08]],
    stop: [[440, 0.08]],
    sent: [[523, 0.07], [784, 0.1]],
    recv: [[784, 0.07], [523, 0.1]],
    error: [[220, 0.25]],
  }[kind] ?? [];
  buzz(kind);
  let t = actx.currentTime;
  for (const [f, d] of seq) {
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    o.connect(g).connect(actx.destination);
    o.start(t);
    o.stop(t + d);
    t += d + 0.03;
  }
}

/** Must be called from a user gesture once, so audio can play later (iOS). */
export function unlockAudio() {
  actx ??= new (window.AudioContext || window.webkitAudioContext)();
  actx.resume();
  if ('speechSynthesis' in window) speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(''), { volume: 0 }));
}

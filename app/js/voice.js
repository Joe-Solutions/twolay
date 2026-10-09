// Local speech output. Never uses a network voice:
//   1. an on-device system voice for Filipino (speechSynthesis, localService === true only)
//   2. pre-rendered espeak-ng / Piper clip shipped in app/audio/<label>.wav
//   3. any other on-device system voice
import { LABELS } from './signs.js';

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

export function voiceInfo() {
  const v = filipinoVoice();
  return v ? `system: ${v.name} (${v.lang}, on-device)` : `clips: app/audio (espeak-ng) + on-device system voice fallback`;
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

/** Speak a sign label (e.g. 'tulong') or free text. */
export async function speak(text, label) {
  const fil = filipinoVoice();
  if (fil && (await speakSystem(text, fil))) return 'system';
  if (label && LABELS.includes(label) && (await playClip(label))) return 'clip';
  if (await speakSystem(text, voices[0])) return 'system-other';
  return 'none';
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

// One-phone conversation ("Usap"). The phone is held by the Blind person:
//   - the camera (rear by default) watches the Deaf signer all the time; each recognised sign is
//     shown and spoken aloud with the offline voice;
//   - the big button records the Blind person's speech; the Deaf person reads it on the same screen
//     and sees the matching sign clips.
import { UNKNOWN_TEXT, signText, signEnglish, textToSigns, customWords } from './signs.js';
import { SignCam } from './camera.js';
import { trimFrames } from './classifier.js';
import { speak, speakEnglish, earcon, unlockAudio, stopSpeech } from './voice.js';
import { loadWhisper, loadVAD, recordUtterance, transcribe } from './stt.js';
import { loadKokoro } from './kokoro.js';
import { loadTranslator, translate } from './translate.js';
import { netlog } from './netlog.js';

const $ = (s) => document.querySelector(s);
const HAND_STREAK = 4;        // frames with hands before a sign capture starts
const COOLDOWN_MS = 1200;     // after a sign, so the hands dropping doesn't start another

export const settings = {
  // Spoken language: 'fil', or 'en' (English speech is translated for the signer, signs are spoken in English).
  lang: localStorage.getItem('twolay.lang') === 'en' ? 'en' : 'fil',
};

const st = { active: false, capture: null, recording: null, busy: false, streak: 0, cooldownUntil: 0 };
let deps;
let cam;

/** deps: { classifier, retrain(), clipURL(label), toast(text, ms) } */
export function initUsap(d) {
  deps = d;
  cam = new SignCam($('#u-cam'), $('#u-overlay'), { facing: localStorage.getItem('twolay.facing') || 'environment' });
  cam.onFrame = onFrame;
  $('#u-mic').onclick = () => talk();
  $('#u-flip').onclick = () => flipCamera();
  $('#u-clipbox').addEventListener('click', () => {
    const v = $('#u-clip');
    if (v.src) { v.currentTime = 0; v.play(); }
  });
  for (const id of ['#lang', '#u-lang']) {
    $(id).onchange = (e) => setLang(e.target.value);
  }
  renderLang();
}

export function setLang(lang) {
  settings.lang = lang === 'en' ? 'en' : 'fil';
  localStorage.setItem('twolay.lang', settings.lang);
  renderLang();
  preloadTranslation();
  deps.toast(settings.lang === 'en' ? 'English: translated offline (OPUS-MT)' : 'Filipino');
}

/** Switch front/rear camera. Returns the new facing. */
export async function flipCamera() {
  const facing = cam.facing === 'environment' ? 'user' : 'environment';
  localStorage.setItem('twolay.facing', facing);
  try {
    await cam.setFacing(facing);
    deps.toast(facing === 'environment' ? 'Camera sa likod: itutok sa nagsa-sign' : 'Camera sa harap');
  } catch (err) {
    deps.toast(`Camera error: ${err.message}`, 4000);
  }
  return facing;
}

function renderLang() {
  for (const id of ['#lang', '#u-lang']) $(id).value = settings.lang;
  $('#u-hint').textContent = settings.lang === 'en'
    ? 'Point the camera at the signer: signs are spoken in English. Press the button and speak English to reply.'
    : 'Itutok ang camera sa nagsa-sign: babasahin nang malakas ang bawat sign. Pindutin ang button para sumagot.';
}

function preloadTranslation() {
  if (settings.lang !== 'en' || !st.active) return;
  loadTranslator('en-tl').catch(() => {});
  if (customWords().length) loadTranslator('tl-en').catch(() => {});
}

export async function enterUsap() {
  st.active = true;
  unlockAudio();
  $('#u-status').textContent = 'Inihahanda ang camera at hand tracking…';
  await deps.retrain();
  try {
    await cam.start();
    $('#u-status').textContent = deps.classifier.ready ? 'Nakatutok. Hinihintay ang sign…' : 'Wala pang training: Home → Turuan';
  } catch (err) {
    $('#u-status').textContent = `Camera error: ${err.message}`;
  }
  loadVAD().catch(() => {});
  loadKokoro().catch(() => {});
  preloadTranslation();
  const mic = $('#u-mic');
  mic.classList.add('busy');
  try {
    await loadWhisper((p) => {
      if (p.progress != null && mic.classList.contains('busy')) mic.textContent = `Naglo-load ${Math.round(p.progress)}%`;
    });
  } catch (err) {
    $('#u-hint').textContent = `Hindi ma-load ang Whisper: ${err.message}`;
  }
  mic.classList.remove('busy');
  mic.textContent = 'Magsalita';
}

export function leaveUsap() {
  st.active = false;
  st.capture?.stop();
  st.recording?.stop();
  cam?.stop();
}

export const usapOpen = () => st.active;
export const isRecording = () => !!st.recording;

/** Conversation so far, oldest first: { from: 'kamay' | 'boses', text, label?, english? }. */
export const messages = [];

/** Say a message from the history again (the newest by default). */
export async function repeatMessage(m = messages.at(-1)) {
  if (!m) return false;
  if (m.from === 'kamay') {
    if (m.english) await speakEnglish(m.english);
    else await speak(m.text, m.label);
  } else if (settings.lang === 'en' && m.english) {
    await speakEnglish(`You said: ${m.english}`);
  } else {
    await speak(`Sinabi mo: ${m.text}`);
  }
  return true;
}

// ---------- signs (camera, always on) ----------
function onFrame(frame) {
  if (!frame.hands) $('#u-status').dataset.hands = 0;
  if (!st.active || st.capture || st.recording || st.busy) return;
  st.streak = frame.hands ? st.streak + 1 : 0;
  if (st.streak >= HAND_STREAK && performance.now() > st.cooldownUntil) captureSign();
}

async function captureSign() {
  if (!deps.classifier.ready) return;
  const status = $('#u-status');
  status.textContent = 'Nakikita ang kamay…';
  st.capture = cam.captureSign({ onState: (s) => s === 'signing' && (status.textContent = 'Nagsa-sign…') });
  const { frames } = await st.capture.done;
  st.capture = null;
  st.streak = 0;
  st.cooldownUntil = performance.now() + COOLDOWN_MS;
  if (!st.active) return;
  const res = deps.classifier.predict(trimFrames(frames));
  if (!res.label) {
    if (res.reason === 'no-hands') {
      status.textContent = 'Nakatutok. Hinihintay ang sign…';
      return;
    }
    status.textContent = `hindi sigurado (pinakamalapit: ${signText(res.guess)})`;
    setCaption(UNKNOWN_TEXT, '🤟');
    addHistory({ from: 'kamay', text: UNKNOWN_TEXT, note: 'ulitin ang sign', local: true });
    earcon('error');
    return;
  }
  status.textContent = `${signText(res.label)} — ${Math.round(res.confidence * 100)}%`;
  await announceSign(res.label);
}

/** English for a sign: the built-in meaning, or the offline translator for added words. */
async function englishFor(label, text) {
  return signEnglish(label) || (await translate(text, 'tl-en').catch(() => '')) || text;
}

/** Show a recognised sign and say it aloud in the chosen language. */
export async function announceSign(label) {
  const text = signText(label);
  const en = settings.lang === 'en' ? await englishFor(label, text) : '';
  const shown = en && en.toLowerCase() !== text.toLowerCase() ? `${text} — ${en}` : text;
  setCaption(shown, '🤟');
  addHistory({ from: 'kamay', text: shown });
  messages.push({ from: 'kamay', text, label, english: en || undefined });
  earcon('recv');
  stopSpeech();
  return en ? speakEnglish(en) : speak(text, label);
}

// ---------- speech (button) ----------
export async function talk() {
  unlockAudio();
  if (st.recording) return st.recording.stop();
  if (st.busy || $('#u-mic').classList.contains('busy')) return;
  st.capture?.stop();
  stopSpeech();
  const btn = $('#u-mic');
  earcon('start');
  btn.classList.add('live');
  btn.textContent = 'Nakikinig…';
  st.recording = recordUtterance({ onLevel: (lvl) => ($('#u-level').style.width = `${Math.round(lvl * 100)}%`) });
  let result;
  try {
    result = await st.recording.done;
  } catch (err) {
    deps.toast(`Mic error: ${err.message}`, 4000);
  }
  st.recording = null;
  $('#u-level').style.width = '0';
  btn.classList.remove('live');
  earcon('stop');
  if (!result?.heardSpeech) {
    btn.textContent = 'Magsalita';
    earcon('error');
    setCaption('Walang narinig. Subukan ulit.');
    return;
  }
  st.busy = true;
  btn.classList.add('busy');
  btn.textContent = 'Isinusulat…';
  try {
    const english = settings.lang === 'en';
    const { text: heard, ms } = await transcribe(result.audio, english ? 'english' : 'tagalog');
    if (!heard) throw new Error('walang teksto');
    if (english) btn.textContent = 'Isinasalin…';
    await announceSpeech(heard, { english, ms });
    earcon('sent');
  } catch (err) {
    earcon('error');
    setCaption('Hindi naintindihan. Subukan ulit.');
    netlog.info(`transcribe error: ${err.message}`);
  } finally {
    st.busy = false;
    st.cooldownUntil = performance.now() + COOLDOWN_MS;
    btn.classList.remove('busy');
    btn.textContent = 'Magsalita';
  }
}

/** Show what the speaker said (in Filipino) with its sign clips, for the signer to read. */
export async function announceSpeech(heard, { english = false, ms } = {}) {
  let text = heard;
  if (english) {
    text = await translate(heard, 'en-tl').catch((err) => {
      netlog.info(`translate error: ${err.message}`);
      return heard;
    });
  }
  // English keywords still match when the translation drifts.
  const signs = textToSigns(english ? `${text} ${heard}` : text);
  setCaption(text, '🗣');
  const notes = [english && text !== heard && `English: ${heard}`, signs.length && `sign: ${signs.join(', ')}`, ms && `${ms} ms`];
  addHistory({ from: 'boses', text, note: notes.filter(Boolean).join(' · ') });
  messages.push({ from: 'boses', text, english: english ? heard : undefined });
  playSigns(signs);
  return { text, signs };
}

// ---------- screen helpers ----------
function setCaption(text, from) {
  const el = $('#u-caption');
  el.innerHTML = '';
  if (from) el.append(Object.assign(document.createElement('span'), { className: 'from', textContent: from === '🤟' ? '🤟 Sign' : '🗣 Boses' }));
  el.append(document.createTextNode(text));
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 600);
}

function addHistory({ from, text, note = '', local = false }) {
  const list = $('#u-history');
  const li = document.createElement('li');
  li.className = `from-${from}${local ? ' local' : ''}`;
  li.textContent = `${from === 'kamay' ? '🤟' : '🗣'} ${text}`;
  if (note) li.append(Object.assign(document.createElement('small'), { textContent: note }));
  list.append(li);
  while (list.children.length > 30) list.firstChild.remove();
}

let playToken = 0;
async function playSigns(labels) {
  const token = ++playToken;
  const video = $('#u-clip');
  const card = $('#u-card');
  const caption = $('#u-clip-label');
  if (!labels.length) {
    card.hidden = false;
    card.textContent = '—';
    caption.textContent = 'Walang katugmang sign';
    return;
  }
  for (const label of labels) {
    if (token !== playToken) return;
    const url = await deps.clipURL(label);
    caption.textContent = signText(label).toUpperCase();
    card.textContent = signText(label).toUpperCase();
    if (!url) {
      card.hidden = false;
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    card.hidden = true;
    video.src = url;
    await video.play().catch(() => {});
    await new Promise((r) => { video.onended = r; video.onerror = r; setTimeout(r, 6000); });
  }
}

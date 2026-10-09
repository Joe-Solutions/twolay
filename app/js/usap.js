// One-phone conversation ("Usap"). The phone is held by the Blind person:
//   - the camera (rear by default) watches the Deaf signer all the time; each recognised sign is
//     shown and spoken aloud with the offline voice;
//   - the big button records the Blind person's speech; the Deaf person reads it on the same screen
//     and sees the matching sign clips.
import { UNKNOWN_TEXT, SIGNS, signText, signEnglish, textToSigns, customWords } from './signs.js';
import { SignCam } from './camera.js';
import { speak, speakEnglish, earcon, unlockAudio, stopSpeech } from './voice.js';
import * as voice from './voice.js';
import { SignSpotter } from './spotter.js';
import { loadWhisper, loadVAD, recordUtterance, transcribe } from './stt.js';
import { loadKokoro, saveVoices } from './kokoro.js';
import { loadTranslator, translate } from './translate.js';
import { netlog } from './netlog.js';

const $ = (s) => document.querySelector(s);

export const settings = {
  // Spoken language: 'fil', or 'en' (English speech is translated for the signer, signs are spoken in English).
  lang: localStorage.getItem('twolay.lang') === 'en' ? 'en' : 'fil',
};

const st = { active: false, recording: null, busy: false, voiceQueue: Promise.resolve() };
let deps;
let cam;
let spotter;

/** deps: { classifier, retrain(), clipURL(label), toast(text, ms) } */
export function initUsap(d) {
  deps = d;
  cam = new SignCam($('#u-cam'), $('#u-overlay'), { facing: localStorage.getItem('twolay.facing') || 'environment' });
  spotter = new SignSpotter(d.classifier, { onSign, onUnknown, onActivity });
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
  if (st.active) loadKokoro().then(saveSignVoices).catch(() => {});
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
  loadKokoro().then(saveSignVoices).catch(() => {});
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

/** Pre-generate the voice for every sign (trained ones first), so a recognised sign is said at once. */
async function saveSignVoices() {
  const trained = Object.keys(deps.classifier.counts ?? {});
  const labels = [...new Set([...trained, ...SIGNS.map((s) => s.label)])];
  await saveVoices(labels.map(signText));
  if (settings.lang === 'en') await saveVoices(labels.map(signEnglish).filter(Boolean), { lang: 'en' });
}

export function leaveUsap() {
  st.active = false;
  st.recording?.stop();
  spotter.reset();
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
  if (!st.active || st.recording || st.busy) return;
  spotter.push(frame);
}

function onActivity(signing) {
  if (!st.active || st.recording) return;
  $('#u-status').textContent = signing ? 'Nagsa-sign…' : 'Nakatutok. Hinihintay ang sign…';
}

function onUnknown(res) {
  $('#u-status').textContent = `hindi sigurado (pinakamalapit: ${signText(res.guess)})`;
  setCaption(UNKNOWN_TEXT, '🤟');
  addHistory({ from: 'kamay', text: UNKNOWN_TEXT, note: 'ulitin ang sign', local: true });
  earcon('error');
}

async function onSign(res) {
  const foundAt = performance.now();
  $('#u-status').textContent = `${signText(res.label)} — ${Math.round(res.confidence * 100)}%`;
  const before = voice.voiceStartedAt;
  // Signs chained quickly are said one after another, not cut off.
  const spoken = (st.voiceQueue = st.voiceQueue.then(() => announceSign(res.label)).catch(() => {}));
  // Timing in the Network log, to see where the delay is on a real phone.
  const poll = setInterval(() => {
    if (voice.voiceStartedAt === before && performance.now() - foundAt < 10000) return;
    clearInterval(poll);
    const v = voice.voiceStartedAt === before ? 'no voice' : `voice +${Math.round(voice.voiceStartedAt - foundAt)} ms`;
    netlog.info(`sign ${res.label} ${Math.round(res.confidence * 100)}% · ${res.frames} frames / ${Math.round(res.endAt - res.startAt)} ms · found +${Math.round(foundAt - res.endAt)} ms after it · ${v}`);
  }, 20);
  await spoken;
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
    spotter.reset();
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

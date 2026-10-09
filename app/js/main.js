import { netlog, installGuard } from './netlog.js';
installGuard();

import { SIGNS, LABELS, UNKNOWN_TEXT, signText, signEnglish, textToSigns, customWords, setCustomWords } from './signs.js';
import { createTrainer, TAKES_TARGET } from './trainer.js';
import { SignClassifier, trimFrames } from './classifier.js';
import { SignCam } from './camera.js';
import { framesFromVideoFile } from './hands.js';
import { store, shippedClip } from './store.js';
import { DemoLink, P2PLink } from './link.js';
import { speak, speakEnglish, earcon, unlockAudio, voiceInfo } from './voice.js';
import { loadWhisper, loadVAD, recordUtterance, transcribe } from './stt.js';
import { loadKokoro } from './kokoro.js';
import { loadTranslator, translate } from './translate.js';
import { renderQR, scanQR } from './qrpair.js';
import { registerSW, offlineStatus, cacheAll } from './offline.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

const state = {
  role: null,
  link: null,
  busy: false,
  capture: null,
  recording: null,
  auto: localStorage.getItem('twolay.auto') === '1',
  useStarter: localStorage.getItem('twolay.starter') !== '0',
  audience: localStorage.getItem('twolay.audience') === '1',
  // Spoken language on this phone: 'fil', or 'en' (English speech is translated for the signer, signs are voiced in English).
  lang: localStorage.getItem('twolay.lang') === 'en' ? 'en' : 'fil',
  cooldownUntil: 0,
  handStreak: 0,
};
const classifier = new SignClassifier();
const cam = new SignCam($('#k-cam'), $('#k-overlay'));
let msgId = 0;

// ---------- UI helpers ----------
function toast(text, ms = 2200) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), ms);
}

function setCaption(text, from) {
  for (const el of [$('#k-caption'), $('#b-caption')]) {
    el.innerHTML = '';
    if (from) el.append(Object.assign(document.createElement('span'), { className: 'from', textContent: from }));
    el.append(document.createTextNode(text));
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 600);
  }
}

function addHistory({ from, text, note = '', local = false }) {
  for (const list of [$('#k-history'), $('#b-history')]) {
    const li = document.createElement('li');
    li.className = `from-${from}${local ? ' local' : ''}`;
    li.textContent = `${from === 'kamay' ? '🤟' : '🗣'} ${text}`;
    if (note) li.append(Object.assign(document.createElement('small'), { textContent: note }));
    list.append(li);
    while (list.children.length > 30) list.firstChild.remove();
  }
}

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

// ---------- link ----------
function useLink(link) {
  state.link?.close();
  state.link = link;
  link.setRole(state.role);
  link.addEventListener('status', renderLink);
  link.addEventListener('status', () => link.status === 'connected' && shareWords());
  link.addEventListener('message', (e) => onMessage(e.detail));
  renderLink();
}

function renderLink() {
  const l = state.link;
  const pill = $('#link-pill');
  const s = l?.status ?? 'idle';
  const kind = l?.kind === 'demo' ? 'demo' : 'phone';
  const text = {
    idle: 'Walang link',
    waiting: `Naghihintay (${kind})`,
    connected: `Konektado (${kind})`,
    lost: 'Nawala ang link',
  }[s];
  pill.textContent = text;
  pill.className = `pill ${{ connected: 'link-ok', waiting: 'link-wait', lost: 'link-lost' }[s] ?? 'link-idle'}`;
  $('#link-status').textContent = `${text}${l?.peerRole ? ` — kabila: ${l.peerRole}` : ''}`;
  if (s === 'connected' && l.peerRole && l.peerRole === state.role) toast('Pareho kayo ng role. Dapat isa Kamay, isa Boses.', 4000);
}

function send(msg) {
  return !!state.link?.send({ ...msg, id: `${Date.now()}-${++msgId}`, from: state.role });
}

/** The signer's device owns the word list; the speaker's device follows it so speech maps to the same signs. */
function shareWords() {
  if (state.role !== 'boses') send({ t: 'words', words: customWords() });
}

/** English for a sign: the built-in meaning, or the offline translator for added words. */
async function englishFor(label, text) {
  return signEnglish(label) || (await translate(text, 'tl-en').catch(() => '')) || text;
}

/** Voice a recognised sign in this phone's language. */
async function speakSign(label, text) {
  if (state.lang === 'en') return speakEnglish(await englishFor(label, text));
  return speak(text, label);
}

async function onMessage(msg) {
  if (msg.t === 'ping') return toast('Natanggap ang test mula sa kabila ✓');
  if (msg.t === 'words') {
    if (state.role === 'boses' && Array.isArray(msg.words) && setCustomWords(msg.words)) {
      toast(`Mga salita mula sa Kamay: ${msg.words.join(', ') || 'wala'}`, 3000);
    }
    return;
  }
  if (msg.t === 'sign' && state.role === 'boses') {
    earcon('recv');
    if (state.audience) playSigns([msg.label], 'b');
    const en = state.lang === 'en' ? await englishFor(msg.label, msg.text) : '';
    const shown = en && en.toLowerCase() !== msg.text.toLowerCase() ? `${msg.text} — ${en}` : msg.text;
    setCaption(shown, 'Kamay:');
    addHistory({ from: 'kamay', text: shown });
    setTimeout(() => (en ? speakEnglish(en) : speak(msg.text, msg.label)), 250);
  } else if (msg.t === 'speech' && state.role === 'kamay') {
    setCaption(msg.text, 'Boses:');
    const notes = [msg.src && `English: ${msg.src}`, msg.signs?.length && `sign: ${msg.signs.join(', ')}`].filter(Boolean);
    addHistory({ from: 'boses', text: msg.text, note: notes.join(' · ') });
    playSigns(msg.signs || []);
    if (state.audience) speak(msg.text);
  }
}

// ---------- Kamay (signer) ----------
async function enterKamay() {
  showScreen('screen-kamay');
  $('#k-status').textContent = 'Inihahanda ang camera at hand tracking…';
  await retrain();
  try {
    await cam.start();
    $('#k-status').textContent = classifier.ready ? 'Handa. Pindutin ang Kamay at mag-sign.' : 'Wala pang training: Home → Turuan';
    loadKokoro().catch(() => {});
    preloadTranslation();
  } catch (err) {
    $('#k-status').textContent = `Camera error: ${err.message}`;
  }
}

cam.onFrame = (frame) => {
  if (!state.capture) $('#k-status').dataset.hands = frame.hands;
  if (!state.auto || state.capture || state.role !== 'kamay') return;
  state.handStreak = frame.hands ? state.handStreak + 1 : 0;
  if (state.handStreak >= 4 && performance.now() > state.cooldownUntil) kamayCapture();
};

let starterPack;
function loadStarter() {
  starterPack ??= fetch(new URL('../packs/fsl105.json', import.meta.url))
    .then((r) => (r.ok ? r.json() : null))
    .then((p) => ({
      samples: (p?.samples ?? []).map((s, i) => ({ ...s, id: `starter-${i}` })),
      clips: new Set(p?.bundledClips ?? []),
    }))
    .catch(() => ({ samples: [], clips: new Set() }));
  return starterPack;
}

async function retrain() {
  const own = await store.samples();
  const starter = state.useStarter ? await loadStarter() : { samples: [], clips: new Set() };
  classifier.fit([...own, ...starter.samples].filter((s) => LABELS.includes(s.label)));
  renderTrainGrid(own, starter);
  return { own, starter };
}

async function kamayCapture() {
  if (state.capture) return state.capture.stop();
  if (!cam.running) return toast('Hindi pa bukas ang camera');
  if (!classifier.ready) return toast('Wala pang training. Home → Turuan', 3500);
  const btn = $('#k-btn');
  btn.classList.add('live');
  btn.textContent = 'Ipakita ang kamay…';
  state.capture = cam.captureSign({
    onState: (s) => (btn.textContent = s === 'signing' ? 'Nagsa-sign…' : 'Ipakita ang kamay…'),
  });
  const { frames } = await state.capture.done;
  state.capture = null;
  state.handStreak = 0;
  state.cooldownUntil = performance.now() + 1200;
  btn.classList.remove('live');
  btn.textContent = 'Kamay';
  const trimmed = trimFrames(frames);

  const res = classifier.predict(trimmed);
  if (!res.label) {
    setCaption(UNKNOWN_TEXT, 'Ikaw:');
    $('#k-status').textContent =
      res.reason === 'no-hands' ? 'Walang kamay na nakita' : `hindi sigurado (pinakamalapit: ${signText(res.guess)})`;
    addHistory({ from: 'kamay', text: UNKNOWN_TEXT, note: 'hindi ipinadala', local: true });
    return;
  }
  const text = signText(res.label);
  const sent = send({ t: 'sign', label: res.label, text, conf: +res.confidence.toFixed(2) });
  setCaption(text, 'Ikaw:');
  // A connected Boses device voices the sign; otherwise this device must, or nobody hears it.
  if (state.audience || !(sent && state.link?.peerRole === 'boses')) speakSign(res.label, text);
  $('#k-status').textContent = `${text} — ${Math.round(res.confidence * 100)}% ${sent ? '→ naipadala' : '(walang link, dito lang)'}`;
  addHistory({ from: 'kamay', text, note: sent ? '' : 'hindi naipadala — walang link', local: !sent });
}

async function clipURL(label) {
  const saved = await store.clip(label);
  if (saved) return URL.createObjectURL(saved.blob);
  if (shippedClip.hidden(label)) return null;
  for (const ext of ['mp4', 'webm']) {
    const url = new URL(`../clips/${label}.${ext}`, import.meta.url);
    const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
    if (head?.ok) return url.href;
  }
  return null;
}

const playToken = {};
/** Play sign clips in the Kamay ('k') or, in audience mode, the Boses ('b') clip box. */
async function playSigns(labels, at = 'k') {
  const token = (playToken[at] = (playToken[at] ?? 0) + 1);
  const video = $(`#${at}-clip`);
  const card = $(`#${at}-card`);
  const caption = $(`#${at}-clip-label`);
  if (!labels.length) {
    card.hidden = false;
    card.textContent = '—';
    caption.textContent = 'Walang katugmang sign';
    return;
  }
  for (const label of labels) {
    if (token !== playToken[at]) return;
    const url = await clipURL(label);
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
for (const id of ['#k-clip', '#b-clip']) {
  $(id).parentElement.addEventListener('click', () => {
    const v = $(id);
    if (v.src) { v.currentTime = 0; v.play(); }
  });
}

// ---------- training ----------
function renderTrainGrid(own, starter) {
  const counts = {};
  const starterCounts = {};
  for (const s of own) counts[s.label] = (counts[s.label] || 0) + 1;
  for (const s of starter.samples) starterCounts[s.label] = (starterCounts[s.label] || 0) + 1;
  store.clips().then((clips) => {
    const hasClip = new Set([...clips.map((c) => c.label), ...starter.clips]);
    const test = classifier.selfTest();
    $('#train-grid').innerHTML = '';
    for (const { label, text } of SIGNS) {
      const n = counts[label] || 0;
      const m = starterCounts[label] || 0;
      const t = test.perLabel[label];
      const cell = document.createElement('div');
      cell.className = `cell ${n + m >= TAKES_TARGET ? 'good' : n + m < 2 ? 'low' : ''}`;
      cell.innerHTML = `<b>${text}</b>iyo: ${n}${m ? ` · FSL-105: ${m}` : ''}<br>clip: ${hasClip.has(label) ? '✓' : '—'}${t ? `<br>self-test ${t.ok}/${t.n}` : ''}`;
      $('#train-grid').append(cell);
    }
    $('#train-eval').textContent = test.accuracy == null
      ? 'Self-test: kailangan ng 2+ sample.'
      : `Self-test (leave-one-out): ${Math.round(test.accuracy * 100)}% tama sa ${test.n} sample. Threshold ${classifier.threshold.toFixed(3)}.`;
  });
}

const trainer = createTrainer({ classifier, retrain, clipURL, toast, onWordsChanged: shareWords });

async function enterTrain() {
  unlockAudio();
  if (state.role === 'kamay') cam.stop();
  showScreen('screen-train');
  document.title = 'Twolay — Turuan';
  history.replaceState(null, '', `?role=train${state.link?.kind === 'demo' ? '&link=demo' : ''}`);
  await trainer.enter();
}
const trainOpen = () => !$('#screen-train').hidden;

$('#train-btn').onclick = () => enterTrain();
$('#train-start').onclick = () => {
  $('#setup').close();
  enterTrain();
};

$('#import-clips').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const wasRunning = cam.running;
  const wasTraining = trainOpen();
  cam.stop();
  trainer.leave();
  const byLen = [...LABELS].sort((a, b) => b.length - a.length);
  let ok = 0;
  const skipped = [];
  for (const [i, file] of files.entries()) {
    const name = file.name.toLowerCase();
    const label = byLen.find((l) => name.startsWith(l));
    if (!label) { skipped.push(`${file.name} (walang sign sa pangalan)`); continue; }
    try {
      const frames = await framesFromVideoFile(file, (p) => toast(`${i + 1}/${files.length} ${file.name} ${Math.round(p * 100)}%`, 4000));
      const trimmed = trimFrames(frames);
      if (!trimmed) { skipped.push(`${file.name} (walang kamay)`); continue; }
      await store.addSample(label, trimmed, `file:${file.name}`);
      if (!(await store.clip(label))) await store.putClip(label, file);
      ok++;
    } catch (err) {
      skipped.push(`${file.name} (${err.message})`);
    }
  }
  await retrain();
  toast(`Na-import: ${ok}. ${skipped.length ? `Nilaktawan: ${skipped.join(', ')}` : ''}`, 6000);
  if (wasRunning) cam.start();
  if (wasTraining) trainer.enter();
};

$('#pack-export').onclick = async () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await store.exportPack());
  a.download = `twolay-pack-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
};
$('#pack-import').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const r = await store.importPack(file);
    await retrain();
    toast(`Pack: ${r.samples} sample, ${r.clips} clip${r.words ? `, ${r.words} salita` : ''}`);
    shareWords();
  } catch (err) {
    toast(err.message, 4000);
  }
};
$('#train-clear').onclick = async () => {
  if (!confirm('Burahin lahat ng training sample at clip sa phone na ito?')) return;
  indexedDB.deleteDatabase('twolay');
  location.reload();
};
$('#use-starter').checked = state.useStarter;
$('#use-starter').onchange = (e) => {
  state.useStarter = e.target.checked;
  localStorage.setItem('twolay.starter', state.useStarter ? '1' : '0');
  retrain();
};
function renderAudience() {
  $('#b-clipbox').hidden = !state.audience;
}
function preloadTranslation() {
  if (state.lang !== 'en') return;
  if (state.role === 'boses') loadTranslator('en-tl').catch(() => {});
  if (customWords().length) loadTranslator('tl-en').catch(() => {});
}
function renderLang() {
  for (const id of ['#lang', '#b-lang']) $(id).value = state.lang;
  $('#b-hint').textContent = state.lang === 'en'
    ? 'Press, speak English, then pause. It is translated to Filipino for the signer.'
    : 'Pindutin, magsalita, at huminto. Kusa itong titigil.';
}
for (const id of ['#lang', '#b-lang']) {
  $(id).onchange = (e) => {
    state.lang = e.target.value === 'en' ? 'en' : 'fil';
    localStorage.setItem('twolay.lang', state.lang);
    renderLang();
    preloadTranslation();
    toast(state.lang === 'en' ? 'English: translated offline (OPUS-MT)' : 'Filipino');
  };
}
renderLang();
$('#audience-mode').checked = state.audience;
$('#audience-mode').onchange = (e) => {
  state.audience = e.target.checked;
  localStorage.setItem('twolay.audience', state.audience ? '1' : '0');
  renderAudience();
};
renderAudience();
$('#auto-mode').checked = state.auto;
$('#auto-mode').onchange = (e) => {
  state.auto = e.target.checked;
  localStorage.setItem('twolay.auto', state.auto ? '1' : '0');
};

// ---------- Boses (speaker) ----------
async function enterBoses() {
  showScreen('screen-boses');
  const btn = $('#b-btn');
  btn.classList.add('busy');
  btn.textContent = 'Naglo-load…';
  loadVAD().catch(() => {});
  try {
    await loadWhisper((p) => {
      if (p.progress != null) btn.textContent = `Naglo-load ${Math.round(p.progress)}%`;
    });
    btn.textContent = 'Boses';
    renderLang();
    loadKokoro().catch(() => {});
    preloadTranslation();
  } catch (err) {
    btn.textContent = 'Boses';
    $('#b-hint').textContent = `Hindi ma-load ang Whisper: ${err.message}`;
  }
  btn.classList.remove('busy');
}

async function bosesTalk() {
  unlockAudio();
  if (state.recording) return state.recording.stop();
  if (state.busy) return;
  const btn = $('#b-btn');
  earcon('start');
  btn.classList.add('live');
  btn.textContent = 'Nakikinig…';
  state.recording = recordUtterance({
    onLevel: (lvl) => ($('#b-level').style.width = `${Math.round(lvl * 100)}%`),
  });
  let result;
  try {
    result = await state.recording.done;
  } catch (err) {
    result = null;
    toast(`Mic error: ${err.message}`, 4000);
  }
  state.recording = null;
  $('#b-level').style.width = '0';
  btn.classList.remove('live');
  earcon('stop');
  if (!result?.heardSpeech) {
    btn.textContent = 'Boses';
    earcon('error');
    setCaption('Walang narinig. Subukan ulit.');
    return;
  }
  state.busy = true;
  btn.classList.add('busy');
  btn.textContent = 'Isinusulat…';
  try {
    const english = state.lang === 'en';
    const { text: heard, ms } = await transcribe(result.audio, english ? 'english' : 'tagalog');
    if (!heard) throw new Error('walang teksto');
    let text = heard;
    let src;
    if (english) {
      btn.textContent = 'Isinasalin…';
      src = heard;
      text = await translate(heard, 'en-tl').catch((err) => {
        netlog.info(`translate error: ${err.message}`);
        return heard;
      });
    }
    // English keywords still match when the translation drifts.
    const signs = textToSigns(src ? `${text} ${src}` : text);
    const sent = send({ t: 'speech', text, src, signs });
    const shown = src && src !== text ? `${src} → ${text}` : text;
    setCaption(shown, 'Ikaw:');
    addHistory({
      from: 'boses',
      text: shown,
      note: `${signs.length ? `sign: ${signs.join(', ')} · ` : ''}${ms} ms${sent ? '' : ' · hindi naipadala — walang link'}`,
      local: !sent,
    });
    earcon(sent ? 'sent' : 'error');
  } catch (err) {
    earcon('error');
    setCaption('Hindi naintindihan. Subukan ulit.');
    netlog.info(`transcribe error: ${err.message}`);
  } finally {
    state.busy = false;
    btn.classList.remove('busy');
    btn.textContent = 'Boses';
  }
}

// ---------- roles / navigation ----------
async function enterRole(role) {
  unlockAudio();
  if (state.role === 'kamay' && role !== 'kamay') cam.stop();
  trainer.leave();
  state.role = role;
  state.link?.setRole(role);
  $('#role-pill').hidden = false;
  $('#role-pill').textContent = role === 'kamay' ? '🤟 Kamay' : '🗣 Boses';
  document.title = `Twolay — ${role === 'kamay' ? 'Kamay' : 'Boses'}`;
  history.replaceState(null, '', `?role=${role}${state.link?.kind === 'demo' ? '&link=demo' : ''}`);
  if (role === 'kamay') await enterKamay();
  else await enterBoses();
}

$('#k-btn').onclick = () => kamayCapture();
$('#b-btn').onclick = () => bosesTalk();
for (const b of document.querySelectorAll('.role')) b.onclick = () => enterRole(b.dataset.role);
$('#home-btn').onclick = () => {
  cam.stop();
  trainer.leave();
  document.title = 'Twolay';
  state.role = null;
  $('#role-pill').hidden = true;
  showScreen('home');
};
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || $('#setup').open || e.target.closest('textarea, input, select')) return;
  e.preventDefault();
  if (trainOpen()) trainer.record();
  else if (state.role === 'kamay') kamayCapture();
  else if (state.role === 'boses') bosesTalk();
});

$('#demo-btn').onclick = async () => {
  useLink(new DemoLink());
  window.open(`${location.pathname}?role=boses&link=demo`, 'twolay-boses', 'width=520,height=860');
  await enterRole('kamay');
};

// ---------- setup dialog ----------
$('#setup-btn').onclick = () => openSetup('link');
$('#link-pill').onclick = () => openSetup('link');
function openSetup(tab) {
  selectTab(tab);
  $('#setup').showModal();
}
function selectTab(tab) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const t of document.querySelectorAll('.tab')) t.hidden = t.dataset.tab !== tab;
  if (tab === 'net') renderNet();
  if (tab === 'offline') renderOffline();
  if (tab === 'train') retrain();
  if (tab === 'models') $('#voice-info').textContent = voiceInfo();
}
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => selectTab(b.dataset.tab);

$('#use-demo').onclick = () => { useLink(new DemoLink()); toast('Demo link: BroadcastChannel, walang network'); };
$('#open-other').onclick = () => {
  if (state.link?.kind !== 'demo') useLink(new DemoLink());
  const other = state.role === 'boses' ? 'kamay' : 'boses';
  window.open(`${location.pathname}?role=${other}&link=demo`, `twolay-${other}`, 'width=520,height=860');
};
$('#ping').onclick = () => toast(send({ t: 'ping' }) ? 'Test ipinadala' : 'Walang link');

let scanning = null;
async function scan() {
  $('#scan-box').hidden = false;
  scanning = scanQR($('#scan-video'));
  try {
    return await scanning.promise;
  } finally {
    $('#scan-box').hidden = true;
    scanning = null;
  }
}
$('#scan-cancel').onclick = () => scanning?.cancel();

function showCode(code, note) {
  renderQR($('#qr-out'), code);
  $('#code-out').value = code;
  toast(note, 4000);
}

$('#p2p-offer').onclick = async () => {
  const link = new P2PLink();
  useLink(link);
  showCode(await link.createOffer(), 'Ipa-scan ito sa kabilang phone');
};
$('#p2p-scan-offer').onclick = async () => {
  try {
    const code = await scan();
    await answerOffer(code);
  } catch (err) {
    if (err.message !== 'cancelled') toast(err.message, 4000);
  }
};
async function answerOffer(code) {
  const link = new P2PLink();
  useLink(link);
  showCode(await link.acceptOffer(code), 'Ipa-scan ang sagot na ito kay Phone A');
}
$('#p2p-scan-answer').onclick = async () => {
  if (!(state.link instanceof P2PLink)) return toast('Gumawa muna ng pairing code (hakbang 1)');
  try {
    await state.link.acceptAnswer(await scan());
    toast('Kumokonekta…');
  } catch (err) {
    if (err.message !== 'cancelled') toast(err.message, 4000);
  }
};
$('#code-apply').onclick = async () => {
  const code = $('#code-in').value.trim();
  try {
    if (state.link instanceof P2PLink && state.link.pc.signalingState === 'have-local-offer') await state.link.acceptAnswer(code);
    else await answerOffer(code);
  } catch (err) {
    toast(err.message, 4000);
  }
};

function renderNet() {
  const list = $('#net-list');
  list.innerHTML = '';
  for (const e of netlog.entries.slice(-300).reverse()) {
    const li = document.createElement('li');
    li.className = `k-${e.kind}`;
    li.textContent = `${e.t} [${e.kind}] ${e.text}`;
    list.append(li);
  }
  const n = netlog.externalCount;
  $('#net-external').textContent = n;
  $('#net-external').className = n ? 'bad' : 'zero';
}
netlog.subscribe(() => {
  if (!$('.tab[data-tab="net"]').hidden && $('#setup').open) renderNet();
  $('#net-external').textContent = netlog.externalCount;
});
$('#net-copy').onclick = async () => {
  await navigator.clipboard?.writeText(netlog.dump());
  toast('Nakopya ang log');
};

async function renderOffline() {
  const s = await offlineStatus();
  const pill = $('#offline-pill');
  pill.textContent = s.ready ? 'Offline ✓' : 'Offline ✗';
  pill.classList.toggle('offline-ok', !!s.ready);
  $('#offline-status').textContent = s.ready
    ? `Handa offline ✓ — ${s.have} file naka-save sa phone (v${s.version}).`
    : s.reason ?? `${s.have}/${s.total} file naka-save. ${s.sw ? '' : 'Service worker: hindi pa aktibo (i-reload pagkatapos).'}`;
  $('#offline-progress').value = s.total ? s.have / s.total : 0;
}
$('#offline-cache').onclick = async () => {
  try {
    await cacheAll((p, f) => {
      $('#offline-progress').value = p;
      $('#offline-status').textContent = `Sine-save: ${f}`;
    });
    await renderOffline();
    toast('Naka-save ang app para offline');
  } catch (err) {
    $('#offline-status').textContent = `Error: ${err.message}`;
  }
};

// ---------- boot ----------
(async function boot() {
  netlog.info(`app start at ${location.origin} (secure context: ${window.isSecureContext})`);
  await registerSW();
  renderOffline();
  if (params.get('link') === 'demo') useLink(new DemoLink());
  const role = params.get('role');
  if (role === 'kamay' || role === 'boses') await enterRole(role);
  else if (role === 'train') await enterTrain();
  else showScreen('home');
})();

import { netlog, installGuard } from './netlog.js';
installGuard();

import { SIGNS, LABELS } from './signs.js';
import { createTrainer, TAKES_TARGET } from './trainer.js';
import { SignClassifier, trimFrames } from './classifier.js';
import { framesFromVideoFile } from './hands.js';
import { store, shippedClip } from './store.js';
import { unlockAudio, voiceInfo } from './voice.js';
import { initUsap, enterUsap, leaveUsap, usapOpen, talk } from './usap.js';
import { registerSW, offlineStatus, cacheAll } from './offline.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

const state = {
  useStarter: localStorage.getItem('twolay.starter') !== '0',
};
const classifier = new SignClassifier();

// ---------- UI helpers ----------
function toast(text, ms = 2200) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), ms);
}

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

// ---------- training data ----------
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

// ---------- screens ----------
initUsap({ classifier, retrain, clipURL, toast });
const trainer = createTrainer({ classifier, retrain, clipURL, toast });
const trainOpen = () => !$('#screen-train').hidden;

async function openUsap() {
  trainer.leave();
  showScreen('screen-usap');
  document.title = 'Twolay — Usap';
  history.replaceState(null, '', '?screen=usap');
  await enterUsap();
}

async function openTrain() {
  unlockAudio();
  leaveUsap();
  showScreen('screen-train');
  document.title = 'Twolay — Turuan';
  history.replaceState(null, '', '?screen=train');
  await trainer.enter();
}

function openHome() {
  leaveUsap();
  trainer.leave();
  document.title = 'Twolay';
  history.replaceState(null, '', location.pathname);
  showScreen('home');
}

$('#start-btn').onclick = () => openUsap();
$('#train-btn').onclick = () => openTrain();
$('#home-btn').onclick = () => openHome();
$('#train-start').onclick = () => {
  $('#setup').close();
  openTrain();
};

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || $('#setup').open || e.target.closest('textarea, input, select')) return;
  e.preventDefault();
  if (trainOpen()) trainer.record();
  else if (usapOpen()) talk();
});

// ---------- training tab ----------
$('#import-clips').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const wasUsap = usapOpen();
  const wasTraining = trainOpen();
  leaveUsap();
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
  if (wasUsap) enterUsap();
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

// ---------- setup dialog ----------
$('#setup-btn').onclick = () => openSetup('settings');
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
  const screen = params.get('screen') ?? params.get('role');
  if (screen === 'usap') await openUsap();
  else if (screen === 'train') await openTrain();
  else showScreen('home');
})();

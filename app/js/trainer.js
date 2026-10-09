// "Turuan" screen: a signer teaches Twolay one FSL sign at a time from the camera.
import { SIGNS, signText, isCustom, addWord, removeWord } from './signs.js';
import { SignCam } from './camera.js';
import { trimFrames } from './classifier.js';
import { store } from './store.js';
import { earcon } from './voice.js';

export const TAKES_TARGET = 5;
const COUNTDOWN = 3;

const $ = (s) => document.querySelector(s);

/** deps: { classifier, retrain(): {own, starter}, clipURL(label), toast(text, ms), onWordsChanged() } */
export function createTrainer({ classifier, retrain, clipURL, toast, onWordsChanged }) {
  const cam = new SignCam($('#t-cam'), $('#t-overlay'));
  let label = SIGNS[0].label;
  let counts = {};
  let starterCounts = {};
  let lastSampleId = null;
  let busy = null;          // the running capture, or 'countdown'
  let refURL = null;

  async function refresh() {
    const { own, starter } = await retrain();
    counts = {};
    starterCounts = {};
    for (const s of own) counts[s.label] = (counts[s.label] || 0) + 1;
    for (const s of starter.samples) starterCounts[s.label] = (starterCounts[s.label] || 0) + 1;
    renderChips();
    renderProgress();
  }

  const total = (l) => (counts[l] || 0) + (starterCounts[l] || 0);

  function renderChips() {
    const box = $('#t-chips');
    box.innerHTML = '';
    for (const { label: l, text } of SIGNS) {
      const b = document.createElement('button');
      const n = counts[l] || 0;
      const m = starterCounts[l] || 0;
      b.className = `chip ${l === label ? 'on' : ''} ${total(l) >= TAKES_TARGET ? 'done' : n ? 'some' : ''} ${isCustom(l) ? 'custom' : ''}`;
      b.innerHTML = `<b>${text}</b><small>${n}/${TAKES_TARGET}${m ? ` · +${m} FSL-105` : ''}</small>`;
      b.onclick = () => select(l);
      box.append(b);
    }
  }

  function renderProgress() {
    const n = counts[label] || 0;
    const m = starterCounts[label] || 0;
    $('#t-progress').textContent = `${n} / ${TAKES_TARGET} takes mo${m ? ` (+${m} mula sa FSL-105)` : ''}`;
    $('#t-undo').disabled = lastSampleId == null;
  }

  async function select(l) {
    const sign = SIGNS.find((s) => s.label === l) ?? SIGNS[0];
    label = l = sign.label;
    lastSampleId = null;
    $('#t-word').textContent = sign.text.toUpperCase();
    $('#t-en').textContent = sign.en || 'sariling salita';
    $('#t-remove-word').hidden = !isCustom(l);
    renderChips();
    renderProgress();
    await showReference();
  }

  async function showReference() {
    const video = $('#t-ref');
    const card = $('#t-ref-card');
    if (refURL?.startsWith('blob:')) URL.revokeObjectURL(refURL);
    refURL = await clipURL(label);
    if (refURL) {
      card.hidden = true;
      video.src = refURL;
      video.play().catch(() => {});
      $('#t-ref-label').textContent = 'Halimbawa';
    } else {
      video.removeAttribute('src');
      video.load();
      card.hidden = false;
      card.textContent = 'Wala pang halimbawa';
      $('#t-ref-label').textContent = 'Ikaw ang unang magtuturo nito';
    }
  }

  function setStatus(text) {
    $('#t-status').textContent = text;
  }

  async function countdown() {
    const el = $('#t-count');
    el.hidden = false;
    for (let i = COUNTDOWN; i > 0; i--) {
      el.textContent = i;
      earcon('stop');
      await new Promise((r) => setTimeout(r, 700));
    }
    el.hidden = true;
    earcon('start');
  }

  async function capture(recordClip) {
    busy = 'countdown';
    await countdown();
    const btn = $('#t-record');
    busy = cam.captureSign({
      recordClip,
      onState: (s) => setStatus(s === 'signing' ? 'Nagsa-sign… ibaba ang kamay kapag tapos' : 'Ipakita ang kamay sa camera'),
    });
    btn.classList.add('live');
    const result = await busy.done;
    busy = null;
    btn.classList.remove('live');
    return { ...result, trimmed: trimFrames(result.frames) };
  }

  async function record() {
    if (busy && busy !== 'countdown') return busy.stop();
    if (busy || !cam.running) return;
    const { trimmed, clip } = await capture(true);
    if (!trimmed) {
      earcon('error');
      return setStatus('Walang sapat na kamay na nakita. Ulitin.');
    }
    // Before saving: does this take already look like a different sign?
    const before = classifier.ready ? classifier.predict(trimmed) : null;
    lastSampleId = await store.addSample(label, trimmed, 'camera');
    const existing = await clipURL(label);
    if (existing?.startsWith('blob:')) URL.revokeObjectURL(existing);
    if (clip?.size && !existing) {
      await store.putClip(label, clip);
      await showReference();
    }
    earcon('sent');
    await refresh();
    const n = counts[label] || 0;
    if (before?.label && before.label !== label) {
      setStatus(`Nai-save ang take ${n}. Paalala: kahawig ito ng "${signText(before.label)}".`);
    } else {
      setStatus(`Nai-save ✓ take ${n} ng ${signText(label)}`);
    }
    if (total(label) >= TAKES_TARGET && n >= Math.min(TAKES_TARGET, 3)) {
      const next = SIGNS.find((s) => total(s.label) < TAKES_TARGET);
      if (next && next.label !== label) {
        toast(`${signText(label)} tapos ✓ — susunod: ${next.text}`, 2500);
        await select(next.label);
      }
    }
  }

  async function test() {
    if (busy || !cam.running) return;
    if (!classifier.ready) return setStatus('Wala pang natutunang sign.');
    const { trimmed } = await capture(false);
    const r = classifier.predict(trimmed);
    if (r.label) {
      earcon(r.label === label ? 'sent' : 'recv');
      setStatus(`Nakita: ${signText(r.label)} (${Math.round(r.confidence * 100)}%)${r.label === label ? ' ✓' : ''}`);
    } else {
      earcon('error');
      setStatus(r.reason === 'no-hands' ? 'Walang kamay na nakita' : `hindi kita (pinakamalapit: ${signText(r.guess)})`);
    }
  }

  async function undo() {
    if (lastSampleId == null) return;
    await store.deleteSample(lastSampleId);
    lastSampleId = null;
    await refresh();
    setStatus('Binawi ang huling take');
  }

  async function clearSign() {
    if (!confirm(`Burahin ang lahat ng take mo para sa "${signText(label)}"?`)) return;
    await store.clearLabel(label);
    await store.deleteClip(label);
    lastSampleId = null;
    await refresh();
    await showReference();
    setStatus('Nabura');
  }

  async function add(e) {
    e.preventDefault();
    const input = $('#t-new-word');
    try {
      const l = addWord(input.value);
      input.value = '';
      onWordsChanged?.();
      await refresh();
      await select(l);
      setStatus(`Naidagdag ang "${signText(l)}". I-record ang 5 take.`);
    } catch (err) {
      toast(err.message, 3000);
    }
  }

  async function remove() {
    if (!isCustom(label)) return;
    if (!confirm(`Tanggalin ang salitang "${signText(label)}" at lahat ng take nito?`)) return;
    const gone = label;
    await store.clearLabel(gone);
    await store.deleteClip(gone);
    removeWord(gone);
    onWordsChanged?.();
    await refresh();
    await select(SIGNS[0].label);
    setStatus(`Natanggal ang "${gone}"`);
  }

  function next() {
    const i = SIGNS.findIndex((s) => s.label === label);
    select(SIGNS[(i + 1) % SIGNS.length].label);
  }

  $('#t-record').onclick = record;
  $('#t-test').onclick = test;
  $('#t-undo').onclick = undo;
  $('#t-next').onclick = next;
  $('#t-clear-sign').onclick = clearSign;
  $('#t-remove-word').onclick = remove;
  $('#t-add').onsubmit = add;

  return {
    async enter() {
      setStatus('Binubuksan ang camera…');
      await refresh();
      const first = SIGNS.find((s) => total(s.label) < TAKES_TARGET) ?? SIGNS[0];
      await select(first.label);
      try {
        await cam.start();
        setStatus('Handa. I-record → 3-2-1 → sign');
      } catch (err) {
        setStatus(`Camera error: ${err.message}`);
      }
    },
    leave() {
      busy?.stop?.();
      cam.stop();
      $('#t-ref').pause();
    },
    record,
  };
}

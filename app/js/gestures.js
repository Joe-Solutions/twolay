// Touch navigation for a blind user, without a screen reader:
//   swipe right / left  next / previous action (spoken + a tick)
//   double tap anywhere do the focused action
//   swipe up            say the newest message again
//   swipe down          go one message back in the conversation
//   single tap          passed through to whatever is under the finger (for sighted helpers);
//                       on an empty spot it says the focused action again
// Keyboard: arrows and Enter do the same. With VoiceOver / TalkBack on, turn this off in ⚙ and use theirs.
import { buzz } from './haptics.js';
import { say, prewarm, stopSpeech } from './voice.js';
import { loadKokoro } from './kokoro.js';
import { settings, talk, isRecording, messages, repeatMessage, flipCamera, setLang } from './usap.js';

const SWIPE_MIN = 40;      // px
const SWIPE_MAX_MS = 800;
const TAP_MOVE = 20;       // px a tap may drift
const DOUBLE_MS = 320;

const $ = (s) => document.querySelector(s);
const t = (fil, en) => (settings.lang === 'en' ? en : fil);

/** Turns raw pointer events on `pad` into swipe / tap / double tap callbacks. */
export function detectGestures(pad, { onSwipe, onTap, onDoubleTap }) {
  let down = null;
  let lastTap = null;
  let tapTimer = 0;
  pad.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
  });
  pad.addEventListener('pointercancel', () => { down = null; });
  pad.addEventListener('pointerup', (e) => {
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    const dt = performance.now() - down.t;
    down = null;
    const dist = Math.hypot(dx, dy);
    if (dist >= SWIPE_MIN && dt <= SWIPE_MAX_MS) {
      clearTimeout(tapTimer);
      lastTap = null;
      onSwipe(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
      return;
    }
    if (dist > TAP_MOVE) return;
    const now = performance.now();
    if (lastTap && now - lastTap.t < DOUBLE_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 60) {
      clearTimeout(tapTimer);
      lastTap = null;
      onDoubleTap();
      return;
    }
    const { clientX: x, clientY: y } = e;
    lastTap = { x, y, t: now };
    tapTimer = setTimeout(() => { lastTap = null; onTap(x, y); }, DOUBLE_MS);
  });
}

/** Click what is under (x, y) below the pad. Returns false on an empty spot. */
function passThrough(pad, x, y) {
  pad.style.pointerEvents = 'none';
  const el = document.elementFromPoint(x, y);
  pad.style.pointerEvents = '';
  const target = el?.closest('button, select, a, input, label, #u-clipbox');
  if (!target) return false;
  if (target.tagName === 'SELECT') {
    target.focus();
    try { target.showPicker(); } catch {}
  } else {
    target.click();
  }
  return true;
}

const HELP = () => t(
  'Mag-swipe pakanan o pakaliwa para pumili. Mag-double tap kahit saan para pindutin. Mag-swipe pataas para ulitin ang huling mensahe, pababa para sa mas luma.',
  'Swipe right or left to choose. Double tap anywhere to press. Swipe up to repeat the last message, down for older ones.',
);

/** deps: { openUsap(), openTrain(), openHome(), toast() } */
export function initGestures(deps) {
  const pad = $('#gesture-pad');
  const banner = $('#g-focus');
  const nav = { screen: null, index: 0, back: null };

  const screens = {
    home: [
      { el: '#start-btn', label: () => t('Simulan ang usapan', 'Start the conversation'), run: () => deps.openUsap() },
      { el: '#train-btn', label: () => t('Turuan ang mga sign', 'Train signs'), run: () => deps.openTrain() },
      { label: () => t('Paano gamitin', 'How to use'), run: () => say(HELP(), settings.lang) },
    ],
    usap: [
      { el: '#u-mic', label: () => t('Magsalita', 'Speak'), run: () => talk(), quiet: true },
      {
        label: () => t('Ulitin ang huling mensahe', 'Repeat the last message'),
        run: async () => (await repeatMessage()) || say(t('Wala pang mensahe', 'No messages yet'), settings.lang),
      },
      {
        el: '#u-lang',
        label: () => t('Wika: Filipino', 'Language: English'),
        run: () => {
          setLang(settings.lang === 'en' ? 'fil' : 'en');
          return say(t('Filipino na', 'English now'), settings.lang);
        },
      },
      {
        el: '#u-flip',
        label: () => t('Palitan ang camera', 'Switch camera'),
        run: async () => {
          const facing = await flipCamera();
          return say(facing === 'environment' ? t('Camera sa likod', 'Back camera') : t('Camera sa harap', 'Front camera'), settings.lang);
        },
      },
      { label: () => t('Paano gamitin', 'How to use'), run: () => say(HELP(), settings.lang) },
      { el: '#home-btn', label: () => t('Bumalik sa simula', 'Back to home'), run: () => deps.openHome() },
    ],
  };
  const items = () => screens[nav.screen] ?? [];
  const current = () => items()[nav.index];

  function render() {
    for (const el of document.querySelectorAll('.g-focus')) el.classList.remove('g-focus');
    const item = current();
    banner.hidden = !enabled() || !item;
    if (!item) return;
    banner.textContent = `▶ ${item.label()}`;
    if (item.el) $(item.el)?.classList.add('g-focus');
  }

  function announce() {
    render();
    const item = current();
    if (item) say(item.label(), settings.lang);
  }

  function move(step) {
    const next = nav.index + step;
    if (next < 0 || next >= items().length) {
      buzz('edge');
      announce();
      return;
    }
    nav.index = next;
    buzz('tick');
    announce();
  }

  async function activate() {
    const item = current();
    if (!item) return;
    if (!item.quiet) {
      buzz('select');
      stopSpeech();
    }
    const done = item.run();
    render();
    await done;
  }

  function history(dir) {
    if (nav.screen !== 'usap') return announce();
    if (!messages.length) {
      buzz('edge');
      return say(t('Wala pang mensahe', 'No messages yet'), settings.lang);
    }
    if (dir === 'up') nav.back = messages.length - 1;
    else nav.back = (nav.back ?? messages.length - 1) - 1;
    if (nav.back < 0) {
      nav.back = 0;
      buzz('edge');
      return say(t('Ito na ang pinakauna', 'That was the first message'), settings.lang);
    }
    buzz('tick');
    stopSpeech();
    repeatMessage(messages[nav.back]);
  }

  // While the mic is on, only "double tap to stop" is allowed, so nothing talks over the speaker.
  const recording = () => nav.screen === 'usap' && isRecording();

  function onSwipe(dir) {
    if (recording()) return buzz('edge');
    if (dir === 'right') move(1);
    else if (dir === 'left') move(-1);
    else history(dir);
  }
  function onDoubleTap() {
    if (recording()) return talk();
    activate();
  }
  function onTap(x, y) {
    if (recording()) return;
    if (!passThrough(pad, x, y)) announce();
  }
  detectGestures(pad, { onSwipe, onTap, onDoubleTap });

  document.addEventListener('keydown', (e) => {
    if (!enabled() || pad.hidden || $('#setup').open || e.target.closest('textarea, input, select, button')) return;
    const act = { ArrowRight: () => onSwipe('right'), ArrowLeft: () => onSwipe('left'), ArrowUp: () => onSwipe('up'), ArrowDown: () => onSwipe('down'), Enter: onDoubleTap }[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  });

  function sync() {
    pad.hidden = !enabled() || !screens[nav.screen];
    render();
  }

  return {
    /** Call on every screen change: 'home' | 'usap' | 'train'. */
    screen(name) {
      nav.screen = name;
      nav.index = 0;
      nav.back = null;
      sync();
      if (pad.hidden) return;
      buzz('screen');
      if (name === 'usap') {
        say(t('Usap. Nakatutok ang camera sa nagsa-sign. Mag-double tap para magsalita.', 'Conversation. The camera is watching the signer. Double tap to speak.'), settings.lang);
        loadKokoro().then(() => prewarm(screens.usap.map((i) => i.label()), settings.lang)).catch(() => {});
      } else if (name === 'home') {
        say(t('Twolay. Simulan ang usapan. Mag-double tap para pindutin, mag-swipe para sa iba.', 'Twolay. Start the conversation. Double tap to press, swipe for more.'), settings.lang);
      }
    },
    sync,
  };
}

const coarse = matchMedia('(pointer: coarse)').matches;
export const enabled = () => (localStorage.getItem('twolay.gestures') ?? (coarse ? '1' : '0')) === '1';
export function setEnabled(on) {
  localStorage.setItem('twolay.gestures', on ? '1' : '0');
}

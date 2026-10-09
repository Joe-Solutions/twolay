// Vibration patterns so a blind user can tell events apart by touch.
// Android: navigator.vibrate. iPhone Safari has no vibrate API; since iOS 18 toggling an
// <input type="checkbox" switch> gives one system haptic tick, but only inside a user gesture,
// so on iPhone a pattern becomes ticks and events outside a tap (e.g. a sign arriving) rely on the earcon.
const PATTERNS = {
  tick: [12],                 // moved to another action
  select: [35],               // action done
  edge: [30, 60, 30],         // end of the list
  start: [50],                // mic on
  stop: [20, 40, 20],         // mic off
  sent: [20, 40, 60],         // reply transcribed
  recv: [80, 60, 80],         // a sign arrived
  error: [250],               // "hindi kita", nothing heard
  screen: [20, 40, 20, 40, 60], // changed screen
};

let enabled = localStorage.getItem('twolay.haptics') !== '0';
export const hapticsOn = () => enabled;
export function setHaptics(on) {
  enabled = on;
  localStorage.setItem('twolay.haptics', on ? '1' : '0');
}

const canVibrate = typeof navigator.vibrate === 'function';

function iosTick() {
  const label = document.createElement('label');
  label.ariaHidden = 'true';
  label.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  label.append(input);
  document.head.append(label);
  label.click();
  label.remove();
}

export let lastHaptic = null;

export function buzz(kind) {
  const pattern = PATTERNS[kind];
  if (!enabled || !pattern) return;
  lastHaptic = kind;
  if (canVibrate) {
    navigator.vibrate(pattern);
    return;
  }
  // Pulses are the even entries; one tick each, spaced like the pattern.
  let t = 0;
  for (let i = 0; i < pattern.length; i += 2) {
    if (t === 0) iosTick();
    else setTimeout(iosTick, t);
    t += pattern[i] + (pattern[i + 1] ?? 0);
  }
}

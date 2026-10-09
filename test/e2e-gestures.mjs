// Blind-user touch navigation on a phone-sized touch screen:
//   swipe right/left moves the focus (with a vibration tick, edge buzz at the ends),
//   double tap anywhere presses the focused action (start, speak, language, home),
//   swipe up repeats the newest message, a single tap still reaches the button under the finger.
// navigator.vibrate is stubbed to record the patterns. Fails if any request leaves 127.0.0.1.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8130;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = spawn('python3', [path.join(here, '../scripts/serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const external = [];
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.join(here, 'ano48.wav')}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({
  permissions: ['camera', 'microphone'],
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
await ctx.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(ORIGIN) || u.startsWith('blob:') || u.startsWith('data:')) return route.continue();
  external.push(u);
  return route.abort();
});
await ctx.addInitScript(() => {
  localStorage.setItem('twolay.gestures', '1');
  window.__vib = [];
  navigator.vibrate = (p) => { window.__vib.push(p); return true; };
});

let failed = false;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};
const step = (s) => console.log(`\n== ${s}`);

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
await page.goto(`${ORIGIN}/`);

// Synthetic touch input on the gesture layer.
await page.evaluate(() => {
  let id = 1;
  const fire = (type, x, y, pid) => document.querySelector('#gesture-pad').dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, pointerId: pid, pointerType: 'touch', bubbles: true }),
  );
  window.__swipe = async (dir) => {
    const [dx, dy] = { right: [150, 0], left: [-150, 0], up: [0, -200], down: [0, 200] }[dir];
    const pid = id++;
    fire('pointerdown', 195, 420, pid);
    await new Promise((r) => setTimeout(r, 120));
    fire('pointerup', 195 + dx, 420 + dy, pid);
  };
  window.__tap = async (x = 195, y = 760) => {
    const pid = id++;
    fire('pointerdown', x, y, pid);
    fire('pointerup', x, y, pid);
  };
  window.__doubleTap = async (x = 195, y = 760) => {
    await window.__tap(x, y);
    await new Promise((r) => setTimeout(r, 80));
    await window.__tap(x, y);
  };
});
const swipe = (d) => page.evaluate((d) => window.__swipe(d), d);
const doubleTap = () => page.evaluate(() => window.__doubleTap());
const focus = () => page.textContent('#g-focus');
const lastVib = () => page.evaluate(() => JSON.stringify(window.__vib.at(-1)));

step('home: gesture layer on, focus on Simulan');
check(await page.$eval('#gesture-pad', (p) => !p.hidden), 'gesture layer is shown on a touch phone');
check(/Simulan/.test(await focus()), `focus: ${await focus()}`);

step('swipe right / left');
await swipe('right');
check(/Turuan/.test(await focus()), `swipe right -> ${await focus()}`);
check(await lastVib() === '[12]', `tick vibration ${await lastVib()}`);
await swipe('right');
await swipe('right');
check(/Paano gamitin/.test(await focus()), `stays on the last item -> ${await focus()}`);
check(await lastVib() === '[30,60,30]', `edge vibration ${await lastVib()}`);
await swipe('left');
await swipe('left');
check(/Simulan/.test(await focus()), `swipe left back -> ${await focus()}`);
check(await page.$eval('#start-btn', (b) => b.classList.contains('g-focus')), 'focused button is outlined for sighted helpers');

step('double tap anywhere: start the conversation');
await doubleTap();
await page.waitForFunction(() => !document.querySelector('#screen-usap').hidden, null, { timeout: 5000 });
check(true, 'Usap screen opened');
check(/Magsalita/.test(await focus()), `focus: ${await focus()}`);
check(await lastVib() === '[20,40,20,40,60]', `screen-change vibration ${await lastVib()}`);

step('swipe up with no messages yet');
await swipe('up');
check(await lastVib() === '[30,60,30]', 'edge vibration (nothing to repeat)');

step('double tap: speak "Ano ang sakit?"');
await page.waitForFunction(() => document.querySelector('#u-mic').textContent === 'Magsalita', null, { timeout: 120000 });
await doubleTap();
await page.waitForFunction(() => document.querySelector('#u-mic').classList.contains('live'), null, { timeout: 5000 });
check(await lastVib() === '[50]', `mic-on vibration ${await lastVib()}`);
await swipe('right');
check(/Magsalita/.test(await focus()), 'swipes are ignored while the mic is on');
await page.waitForFunction(() => document.querySelectorAll('#u-history li.from-boses').length > 0, null, { timeout: 90000 });
console.log(`  caption: ${await page.textContent('#u-caption')}`);
const vibs = await page.evaluate(() => window.__vib.map((p) => JSON.stringify(p)));
check(vibs.includes('[20,40,20]') && vibs.includes('[20,40,60]'), 'mic-off and sent vibrations');

step('swipe up: repeat the newest message');
const before = await page.evaluate(() => window.__vib.length);
await swipe('up');
await page.waitForFunction(async () => (await import('./js/voice.js')).lastEngine !== 'none', null, { timeout: 30000 });
check(await page.evaluate((n) => window.__vib.length > n, before), 'tick on repeat');

step('language: swipe to it, double tap');
await swipe('right');
await swipe('right');
check(/Wika: Filipino/.test(await focus()), `focus: ${await focus()}`);
await doubleTap();
check(/Language: English/.test(await focus()), `after double tap: ${await focus()}`);
check(await page.$eval('#u-lang', (s) => s.value) === 'en', 'language picker switched to English');
await doubleTap();
check(/Wika: Filipino/.test(await focus()), 'and back to Filipino');

step('back to home');
for (let i = 0; i < 3; i++) await swipe('right');
check(/Bumalik sa simula/.test(await focus()), `focus: ${await focus()}`);
await doubleTap();
await page.waitForFunction(() => !document.querySelector('#home').hidden, null, { timeout: 5000 });
check(true, 'home screen');

step('single tap still presses the button under the finger');
const box = await page.$eval('#train-btn', (b) => { const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
await page.evaluate(([x, y]) => window.__tap(x, y), box);
await page.waitForFunction(() => !document.querySelector('#screen-train').hidden, null, { timeout: 5000 });
check(true, 'Turuan opened by a single tap');
check(await page.$eval('#gesture-pad', (p) => p.hidden), 'gesture layer is off on the Turuan screen');

await page.screenshot({ path: path.join(here, 'shot-gestures.png') });
console.log(`\nexternal requests: ${external.length}`);
for (const u of external) console.log(`    ${u}`);
await browser.close();
server.kill();
if (failed || external.length) { console.log('FAIL'); process.exit(1); }
console.log('PASS');

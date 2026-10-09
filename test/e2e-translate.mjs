// Offline translation, both ways, with the language set to English:
//   1. OPUS-MT en->tl and tl->en load from this origin and translate ("Thank you" -> "Salamat").
//   2. English speech (fake mic: "I need water, please.") -> Whisper English -> Filipino caption + TUBIG sign.
//   3. The Salamat sign is shown as "Salamat — thank you" and said with Kokoro's English voice.
//   4. An added word (no built-in English) is translated tl->en before it is spoken.
// Fails if any request leaves 127.0.0.1.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8128;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = spawn('python3', [path.join(here, '../scripts/serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const external = [];
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.join(here, 'water48.wav')}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], serviceWorkers: 'block' });
await ctx.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(ORIGIN) || u.startsWith('blob:') || u.startsWith('data:')) return route.continue();
  external.push(u);
  return route.abort();
});
await ctx.addInitScript(() => {
  localStorage.setItem('twolay.lang', 'en');
});

let failed = false;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};
const step = (s) => console.log(`\n== ${s}`);

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
await page.goto(`${ORIGIN}/?screen=usap`);

step('translator: OPUS-MT both directions');
const t = await page.evaluate(async () => {
  const { translate } = await import('./js/translate.js');
  const out = {};
  for (const [text, dir] of [['Thank you', 'en-tl'], ['Where is the bathroom?', 'en-tl'], ['salamat', 'tl-en'], ['Hindi ko maintindihan', 'tl-en']]) {
    const t0 = performance.now();
    out[`${dir}: ${text}`] = `${await translate(text, dir)} (${Math.round(performance.now() - t0)} ms)`;
  }
  return out;
});
for (const [k, v] of Object.entries(t)) console.log(`  ${k} -> ${v}`);
check(/^salamat/i.test(t['en-tl: Thank you']), '"Thank you" -> "Salamat"');
check(/thank/i.test(t['tl-en: salamat']), '"salamat" -> "Thank you"');

step('speaker (English) says "I need water, please."');
await page.waitForFunction(() => document.querySelector('#u-mic').textContent === 'Magsalita', null, { timeout: 120000 });
check(await page.$eval('#u-lang', (s) => s.value) === 'en', 'language picker shows English');
await page.click('#u-mic');
await page.waitForFunction(
  () => document.querySelector('#u-mic').textContent === 'Magsalita' && document.querySelectorAll('#u-history li.from-boses').length > 0,
  null,
  { timeout: 90000 },
).catch(() => {});
await page.waitForTimeout(1500);
const caption = await page.textContent('#u-caption');
const note = await page.$$eval('#u-history li.from-boses', (l) => l.at(-1)?.textContent ?? '');
console.log(`  caption: ${caption}`);
console.log(`  history: ${note}`);
check(/tubig/i.test(caption), 'signer reads the Filipino translation (has "tubig")');
check(/English: .*water/i.test(note), 'history keeps the English original');
check(await page.textContent('#u-clip-label') === 'TUBIG', 'signer is shown the TUBIG sign');

step('sign Salamat -> said in English');
await page.evaluate(async () => (await import('./js/kokoro.js')).loadKokoro());
const sign = (label) => page.evaluate(async (label) => (await import('./js/usap.js')).announceSign(label), label);
await sign('salamat');
const said = await page.textContent('#u-caption');
console.log(`  caption: ${said}`);
check(/Salamat — thank you/.test(said), 'shows "Salamat — thank you"');
const engine = await page.evaluate(async () => (await import('./js/voice.js')).lastEngine);
check(engine === 'kokoro-en', `spoken with Kokoro English voice (engine: ${engine})`);

step('added word: translated tl->en before speaking');
await page.evaluate(async () => (await import('./js/signs.js')).setCustomWords(['Gutom ako']));
await sign('gutom-ako');
const custom = await page.textContent('#u-caption');
console.log(`  caption: ${custom}`);
check(/Gutom ako — .*hungry/i.test(custom), 'added word is translated to English');

step('english voice: Kokoro af_heart');
const v = await page.evaluate(async () => {
  const { synthesize } = await import('./js/kokoro.js');
  const t0 = performance.now();
  const { audio, rate } = await synthesize("I don't understand.", { lang: 'en', strict: true });
  let peak = 0;
  for (const x of audio) peak = Math.max(peak, Math.abs(x));
  return { secs: audio.length / rate, ms: Math.round(performance.now() - t0), peak };
});
console.log(`  "I don't understand." -> ${v.secs.toFixed(2)} s audio in ${v.ms} ms, peak ${v.peak.toFixed(2)}`);
check(v.secs > 0.4 && v.secs < 5 && v.peak > 0.05, 'English audio looks like speech');
// Round trip: Whisper (English) should understand what Kokoro said.
for (const phrase of ['Thank you.', 'I need help.', 'Where is the bathroom?', "You're welcome."]) {
  const heard = await page.evaluate(async (phrase) => {
    const { synthesize } = await import('./js/kokoro.js');
    const { transcribe } = await import('./js/stt.js');
    const { audio, rate } = await synthesize(phrase, { lang: 'en', strict: true });
    const out = new Float32Array(Math.floor(audio.length * 16000 / rate));
    for (let i = 0; i < out.length; i++) out[i] = audio[Math.floor(i * rate / 16000)];
    return (await transcribe(out, 'english')).text;
  }, phrase);
  const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').trim();
  check(norm(heard).includes(norm(phrase).split(' ').at(-1)), `Kokoro "${phrase}" -> Whisper heard "${heard}"`);
}

console.log(`\nexternal requests: ${external.length}`);
for (const u of external) console.log(`    ${u}`);
await browser.close();
server.kill();
if (failed || external.length) { console.log('FAIL'); process.exit(1); }
console.log('PASS');

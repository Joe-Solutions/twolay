// Offline translation, both ways, with Boses set to English:
//   1. OPUS-MT en->tl and tl->en load from this origin and translate ("Thank you" -> "Salamat").
//   2. Boses speaks English (fake mic: "I need water, please.") -> Whisper English -> Filipino on Kamay + TUBIG sign.
//   3. Kamay signs Salamat -> Boses shows "Salamat — thank you" and says it with Kokoro's English voice.
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
  if (location.search.includes('role=boses')) localStorage.setItem('twolay.lang', 'en');
});

let failed = false;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};
const step = (s) => console.log(`\n== ${s}`);

const kamay = await ctx.newPage();
kamay.on('pageerror', (e) => console.log(`  [kamay pageerror] ${e.message}`));
await kamay.goto(`${ORIGIN}/?role=kamay&link=demo`);
const boses = await ctx.newPage();
boses.on('pageerror', (e) => console.log(`  [boses pageerror] ${e.message}`));
await boses.goto(`${ORIGIN}/?role=boses&link=demo`);
await boses.waitForFunction(() => document.querySelector('#link-pill').textContent.includes('Konektado'), null, { timeout: 15000 });

step('translator: OPUS-MT both directions');
const t = await boses.evaluate(async () => {
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

step('boses (English) speaks "I need water, please."');
await boses.waitForFunction(() => document.querySelector('#b-btn').textContent === 'Boses', null, { timeout: 120000 });
check(await boses.$eval('#b-lang', (s) => s.value) === 'en', 'Boses language picker shows English');
await boses.click('#b-btn');
await boses.waitForFunction(
  () => document.querySelector('#b-btn').textContent === 'Boses' && document.querySelectorAll('#b-history li.from-boses').length > 0,
  null,
  { timeout: 90000 },
).catch(() => {});
console.log(`  boses caption: ${await boses.textContent('#b-caption')}`);
await kamay.waitForTimeout(1500);
const kCaption = await kamay.textContent('#k-caption');
const kNote = await kamay.$$eval('#k-history li.from-boses', (l) => l.at(-1)?.textContent ?? '');
console.log(`  kamay caption: ${kCaption}`);
console.log(`  kamay history: ${kNote}`);
check(/tubig/i.test(kCaption), 'Kamay reads the Filipino translation (has "tubig")');
check(/English: .*water/i.test(kNote), 'Kamay history keeps the English original');
check(await kamay.textContent('#k-clip-label') === 'TUBIG', 'Kamay is shown the TUBIG sign');

step('kamay signs Salamat -> boses says it in English');
await boses.evaluate(async () => (await import('./js/kokoro.js')).loadKokoro());
const signFromKamay = (label, text) =>
  kamay.evaluate(([label, text]) => {
    new BroadcastChannel('twolay-demo-link').postMessage({ t: 'sign', label, text, conf: 0.9, from: 'kamay', role: 'kamay', id: `t-${label}` });
  }, [label, text]);
await signFromKamay('salamat', 'Salamat');
await boses.waitForFunction(() => /—/.test(document.querySelector('#b-caption').textContent), null, { timeout: 20000 }).catch(() => {});
console.log(`  boses caption: ${await boses.textContent('#b-caption')}`);
check(/Salamat — thank you/.test(await boses.textContent('#b-caption')), 'Boses shows "Salamat — thank you"');
let engine = 'none';
for (let i = 0; i < 30 && engine === 'none'; i++) {
  await boses.waitForTimeout(500);
  engine = await boses.evaluate(async () => (await import('./js/voice.js')).lastEngine);
}
check(engine === 'kokoro-en', `spoken with Kokoro English voice (engine: ${engine})`);

step('added word: translated tl->en before speaking');
await boses.evaluate(async () => (await import('./js/signs.js')).setCustomWords(['Gutom ako']));
await signFromKamay('gutom-ako', 'Gutom ako');
await boses.waitForFunction(() => /Gutom ako —/.test(document.querySelector('#b-caption').textContent), null, { timeout: 60000 }).catch(() => {});
const custom = await boses.textContent('#b-caption');
console.log(`  boses caption: ${custom}`);
check(/Gutom ako — .*hungry/i.test(custom), 'added word is translated to English');

step('english voice: Kokoro af_heart');
const v = await boses.evaluate(async () => {
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
  const heard = await boses.evaluate(async (phrase) => {
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

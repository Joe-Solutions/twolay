// Silero VAD on the speech side:
//   1. loud pink noise (no speech) -> "Walang narinig", nothing sent, Whisper never runs
//      (a loudness check can mistake it for speech, and Whisper then invents words);
//   2. "Ano ang sakit?" -> speech detected by Silero, leading silence trimmed, transcript sent;
//   3. the same, pressed while a slow Kokoro loads in the shared AI worker (Silero answers late, as on an
//      iPhone): the loudness check takes over and the speech is still transcribed, not "Walang narinig".
// Fails if any request leaves 127.0.0.1.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8129;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = spawn('python3', [path.join(here, '../scripts/serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const external = [];
let failed = false;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};

async function usapWith(wav, { slowKokoro = false } = {}) {
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.join(here, wav)}`,
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
  if (slowKokoro) {
    await ctx.route('**/js/ai-kokoro.js', async (route) => {
      const r = await route.fetch();
      const spin = (ms) => `{ const e = performance.now() + ${ms}; while (performance.now() < e); }`;
      const body = (await r.text()).replace("await load();\n        port.postMessage({ type: 'ready'", `await load(); ${spin(10000)}\n        port.postMessage({ type: 'ready'`);
      route.fulfill({ response: r, body });
    });
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(`${ORIGIN}/?screen=usap`);
  await page.waitForFunction(() => document.querySelector('#u-mic').textContent === 'Magsalita', null, { timeout: 120000 });
  await page.waitForFunction(async () => (await import('./js/stt.js')).vadActive(), null, { timeout: 30000, polling: 250 });
  if (!slowKokoro) await page.waitForFunction(async () => (await import('./js/kokoro.js')).kokoroReady(), null, { timeout: 120000, polling: 250 });
  return { browser, page };
}

console.log('== loud noise, nobody talking');
{
  const { browser, page } = await usapWith('noise48.wav');
  check(true, 'Silero VAD loaded');
  const t0 = Date.now();
  await page.click('#u-mic');
  await page.waitForFunction(() => document.querySelector('#u-mic').textContent === 'Magsalita' && !document.querySelector('#u-mic').classList.contains('live'), null, { timeout: 20000 });
  const caption = await page.textContent('#u-caption');
  console.log(`  caption after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${caption}`);
  check(/Walang narinig/.test(caption), 'noise is not treated as speech');
  check((await page.$$('#u-history li.from-boses')).length === 0, 'nothing transcribed or sent');
  await browser.close();
}

console.log('\n== "Ano ang sakit?" after 1.5 s of silence');
{
  const { browser, page } = await usapWith('ano48.wav');
  const r = await page.evaluate(async () => {
    const { recordUtterance } = await import('./js/stt.js');
    const { holdVoices } = await import('./js/kokoro.js');
    holdVoices(true); // as the Magsalita button does: background sign voices wait
    await new Promise((r) => setTimeout(r, 4000)); // let a sign voice already being made finish
    const t0 = performance.now();
    const res = await recordUtterance().done;
    holdVoices(false);
    return { heard: res.heardSpeech, vad: res.vad, secs: res.audio.length / 16000, ms: Math.round(performance.now() - t0) };
  });
  console.log(`  ${JSON.stringify(r)}`);
  check(r.heard && r.vad === 'silero', 'Silero detected the speech');
  check(r.secs < 4.5, `audio trimmed to the speech (${r.secs.toFixed(2)} s kept)`);
  await page.click('#u-mic');
  await page.waitForFunction(() => document.querySelectorAll('#u-history li.from-boses').length > 0, null, { timeout: 60000 }).catch(() => {});
  const text = await page.$$eval('#u-history li', (l) => l.map((x) => x.textContent).join(' | '));
  console.log(`  history: ${text}`);
  check(/sakit/i.test(text), 'transcript reaches the sign map (sakit)');
  await browser.close();
}

console.log('\n== pressed while a slow Kokoro loads (Silero answers late)');
{
  const { browser, page } = await usapWith('ano48.wav', { slowKokoro: true });
  await page.click('#u-mic');
  await page.waitForFunction(() => !document.querySelector('#u-mic').classList.contains('live') && !document.querySelector('#u-mic').classList.contains('busy'), null, { timeout: 120000, polling: 100 });
  const caption = await page.textContent('#u-caption');
  console.log(`  caption: ${caption}`);
  check(!/Walang narinig/.test(caption), 'speech is not missed while Kokoro loads');
  check(/sakit|sa k/i.test(caption), 'and it is transcribed');
  await browser.close();
}

console.log(`\nexternal requests: ${external.length}`);
server.kill();
if (failed || external.length) { console.log('FAIL'); process.exit(1); }
console.log('PASS');

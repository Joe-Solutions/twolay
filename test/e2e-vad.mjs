// Silero VAD on the Boses side:
//   1. loud pink noise (no speech) -> "Walang narinig", nothing sent, Whisper never runs
//      (a loudness check can mistake it for speech, and Whisper then invents words);
//   2. "Ano ang sakit?" -> speech detected by Silero, leading silence trimmed, transcript sent.
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

async function bosesWith(wav) {
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.join(here, wav)}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctx = await browser.newContext({ permissions: ['microphone'], serviceWorkers: 'block' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(ORIGIN) || u.startsWith('blob:') || u.startsWith('data:')) return route.continue();
    external.push(u);
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(`${ORIGIN}/?role=boses`);
  await page.waitForFunction(() => document.querySelector('#b-btn').textContent === 'Boses', null, { timeout: 120000 });
  await page.waitForFunction(async () => (await import('./js/stt.js')).vadActive(), null, { timeout: 30000, polling: 250 });
  return { browser, page };
}

console.log('== loud noise, nobody talking');
{
  const { browser, page } = await bosesWith('noise48.wav');
  check(true, 'Silero VAD loaded');
  const t0 = Date.now();
  await page.click('#b-btn');
  await page.waitForFunction(() => document.querySelector('#b-btn').textContent === 'Boses' && !document.querySelector('#b-btn').classList.contains('live'), null, { timeout: 20000 });
  const caption = await page.textContent('#b-caption');
  console.log(`  caption after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${caption}`);
  check(/Walang narinig/.test(caption), 'noise is not treated as speech');
  check((await page.$$('#b-history li')).length === 0, 'nothing transcribed or sent');
  await browser.close();
}

console.log('\n== "Ano ang sakit?" after 1.5 s of silence');
{
  const { browser, page } = await bosesWith('ano48.wav');
  const r = await page.evaluate(async () => {
    const { recordUtterance } = await import('./js/stt.js');
    const t0 = performance.now();
    const res = await recordUtterance().done;
    return { heard: res.heardSpeech, vad: res.vad, secs: res.audio.length / 16000, ms: Math.round(performance.now() - t0) };
  });
  console.log(`  ${JSON.stringify(r)}`);
  check(r.heard && r.vad === 'silero', 'Silero detected the speech');
  check(r.secs < 4.5, `audio trimmed to the speech (${r.secs.toFixed(2)} s kept)`);
  await page.click('#b-btn');
  await page.waitForFunction(() => document.querySelectorAll('#b-history li.from-boses').length > 0, null, { timeout: 60000 }).catch(() => {});
  const text = await page.$$eval('#b-history li', (l) => l.map((x) => x.textContent).join(' | '));
  console.log(`  history: ${text}`);
  check(/sakit/i.test(text), 'transcript reaches the sign map (sakit)');
  await browser.close();
}

console.log(`\nexternal requests: ${external.length}`);
server.kill();
if (failed || external.length) { console.log('FAIL'); process.exit(1); }
console.log('PASS');

// Kokoro voice: loads from this origin only, synthesizes Tagalog phrases, and writes them to
// test/voice-samples/*.wav so a person can listen. Fails if any request leaves 127.0.0.1.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8127;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = spawn('python3', [path.join(here, '../scripts/serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const external = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: 'block' });
await ctx.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(ORIGIN) || u.startsWith('blob:') || u.startsWith('data:')) return route.continue();
  external.push(u);
  return route.abort();
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
await page.goto(ORIGIN);

const PHRASES = ['Tulong', 'Salamat po', 'Magandang umaga', 'Hindi ko maintindihan', 'Ano ang sakit?', 'Gusto mo ba ng tubig?'];
console.log('== load Kokoro');
const t0 = Date.now();
await page.evaluate(async () => (await import('./js/kokoro.js')).loadKokoro());
console.log(`  loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const outDir = path.join(here, 'voice-samples');
mkdirSync(outDir, { recursive: true });
let failed = false;
console.log('== synthesize');
for (const text of PHRASES) {
  const r = await page.evaluate(async (text) => {
    const t = performance.now();
    const { audio, rate } = await (await import('./js/kokoro.js')).synthesize(text);
    const { tagalogToIPA } = await import('./js/tl-g2p.js');
    let peak = 0;
    for (const x of audio) peak = Math.max(peak, Math.abs(x));
    return { pcm: Array.from(audio, (x) => Math.round(Math.max(-1, Math.min(1, x)) * 32767)), rate, ms: Math.round(performance.now() - t), ipa: tagalogToIPA(text), peak };
  }, text);
  const secs = r.pcm.length / r.rate;
  console.log(`  "${text}" /${r.ipa}/ -> ${secs.toFixed(2)} s audio in ${r.ms} ms, peak ${r.peak.toFixed(2)}`);
  if (secs < 0.2 || secs > 8 || r.peak < 0.05) failed = true;
  writeFileSync(path.join(outDir, `${text.replace(/[^a-z]+/gi, '_').replace(/_$/, '')}.wav`), wav(r.pcm, r.rate));
}
console.log(`  wav files: ${outDir}`);

console.log(`\nexternal requests: ${external.length}`);
await browser.close();
server.kill();
if (failed || external.length) { console.log('FAIL'); process.exit(1); }
console.log('PASS');

function wav(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => b.writeInt16LE(s, 44 + i * 2));
  return b;
}

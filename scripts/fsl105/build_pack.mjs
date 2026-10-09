// Turn the prepared FSL-105 clips into app/packs/fsl105.json by running them through the app's own
// MediaPipe + feature code in headless Chromium, so training features match live-camera features.
// Usage: node scripts/fsl105/build_pack.mjs   (needs `npm run test:setup` once for Playwright)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(path.join(root, 'test/package.json'))('playwright');
const WORK = process.env.WORK || '/tmp/fsl105';
const PORT = 8131;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const server = spawn('python3', [path.join(root, 'scripts/serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
// The app's service worker would bypass page.route and fetch /__fsl/ from the real server.
const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
await page.route(`${ORIGIN}/__fsl/**`, (route) => {
  const file = path.join(WORK, 'webm', path.basename(new URL(route.request().url()).pathname));
  route.fulfill({ body: readFileSync(file), contentType: 'video/webm' });
});
await page.goto(`${ORIGIN}/`);

const files = readdirSync(path.join(WORK, 'webm')).filter((f) => f.endsWith('.webm')).sort();
// Reuse samples already in the pack (same source clip); FRESH=1 re-extracts everything.
const packFile = path.join(root, 'app/packs/fsl105.json');
const previous = new Map();
if (!process.env.FRESH) {
  try {
    for (const s of JSON.parse(readFileSync(packFile, 'utf8')).samples) previous.set(s.source, s);
  } catch {}
}
const samples = [];
for (const [i, f] of files.entries()) {
  const label = f.split('_')[0];
  const reused = previous.get(`FSL-105 ${f}`);
  if (reused) {
    samples.push(reused);
    continue;
  }
  const t0 = Date.now();
  const frames = await Promise.race([
    page.evaluate(async (name) => {
      const { framesFromVideoFile } = await import('./js/hands.js');
      const { trimFrames } = await import('./js/classifier.js');
      const blob = await (await fetch(`/__fsl/${name}`)).blob();
      const trimmed = trimFrames(await framesFromVideoFile(new File([blob], name, { type: 'video/webm' })));
      return trimmed && trimmed.map((v) => v.map((x) => Math.round(x * 1000) / 1000));
    }, f),
    new Promise((r) => setTimeout(() => r('timeout'), 60000)),
  ]).catch((e) => `error: ${e.message.split('\n')[0]}`);
  const ok = Array.isArray(frames);
  console.log(`[${i + 1}/${files.length}] ${f}: ${ok ? `${frames.length} frames` : frames ?? 'no hands, skipped'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (frames === 'timeout') break;
  if (!ok) continue;
  samples.push({ label, frames, source: `FSL-105 ${f}` });
}
await browser.close();
server.kill();

mkdirSync(path.join(root, 'app/packs'), { recursive: true });
mkdirSync(path.join(root, 'app/clips'), { recursive: true });
const pack = {
  twolayPack: 1,
  name: 'FSL-105 starter',
  attribution: 'FSL-105 (Tupal & Cabatuan), CC BY 4.0, https://data.mendeley.com/datasets/48y2y99mb9/2',
  bundledClips: readdirSync(path.join(WORK, 'mp4')).map((f) => path.basename(f, '.mp4')),
  samples,
};
writeFileSync(path.join(root, 'app/packs/fsl105.json'), JSON.stringify(pack));
for (const f of readdirSync(path.join(WORK, 'mp4'))) copyFileSync(path.join(WORK, 'mp4', f), path.join(root, 'app/clips', f));
const per = samples.reduce((m, s) => ((m[s.label] = (m[s.label] || 0) + 1), m), {});
console.log('pack:', per);

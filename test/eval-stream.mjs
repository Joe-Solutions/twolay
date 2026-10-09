// How well signs are found in a continuous camera stream (FSL-105 takes played one after another).
// 5-fold: the takes in the stream are never in the training set. Compares the old capture
// (start after 4 hand frames, stop when the hands leave or after 3.5 s) with SignSpotter, for:
//   drop  - full takes: the signer's hands leave the frame between signs;
//   chain - takes cut to the signing and run back to back: hands never leave, no rest (phone at a distance);
// at 15, 10 and 7.5 frames per second (phones are often at 8-12).
// Needs the FSL-105 clips (scripts/fsl105/prepare.sh, FSL_DIR=/tmp/fsl105). Landmarks are cached.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FSL = process.env.FSL_DIR ?? '/tmp/fsl105';
const CACHE = path.join(FSL, 'stream-frames.json');
const PORT = 8133;
const server = spawn('python3', [path.join(here, '../scripts/serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: 'block' });
await ctx.route('**/__fsl/*', (route) => route.fulfill({ path: path.join(FSL, 'webm', path.basename(new URL(route.request().url()).pathname)) }));
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`);

// ---------- landmarks per take (15 fps, untrimmed), cached ----------
let takes = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const pack = JSON.parse(readFileSync(path.join(here, '../app/packs/fsl105.json'), 'utf8'));
const names = [...new Set(pack.samples.map((s) => s.source.replace(/^FSL-105 /, '')))].filter((n) => readdirSync(path.join(FSL, 'webm')).includes(n));
const todo = names.filter((n) => !takes[n]);
if (todo.length) console.log(`extracting landmarks for ${todo.length} takes (once)…`);
for (const [i, name] of todo.entries()) {
  takes[name] = await page.evaluate(async (name) => {
    const { framesFromVideoFile } = await import('./js/hands.js');
    const blob = await (await fetch(`/__fsl/${name}`)).blob();
    const frames = await framesFromVideoFile(new File([blob], name));
    return frames.map((f) => ({ vec: f.vec.map((x) => Math.round(x * 1e4) / 1e4), hands: f.hands }));
  }, name);
  if (i % 20 === 19 || i === todo.length - 1) {
    writeFileSync(CACHE, JSON.stringify(takes));
    console.log(`  ${i + 1}/${todo.length}`);
  }
}

// ---------- evaluate ----------
const samples = pack.samples.map((s, i) => ({ ...s, id: i, name: s.source.replace(/^FSL-105 /, '') })).filter((s) => takes[s.name]);
const report = await page.evaluate(async ({ samples, takes }) => {
  const { SignClassifier, trimFrames } = await import('./js/classifier.js');
  const { SignSpotter } = await import('./js/spotter.js');
  const K = 5;
  const STEP = 1000 / 15;

  // Old Usap capture, replayed on timestamps.
  function oldCapture(classifier, frames) {
    const out = [];
    let streak = 0, cap = null, cooldownUntil = 0;
    for (const f of frames) {
      if (cap) {
        if (f.hands) { cap.first ??= f.at; cap.last = f.at; }
        if (cap.first) cap.frames.push(f);
        const end = (cap.first && f.at - cap.first > 3500) || (cap.first && f.at - cap.last > 450) || (!cap.first && f.at - cap.t0 > 5000);
        if (end) {
          const r = classifier.predict(trimFrames(cap.frames));
          if (r.label) out.push({ label: r.label, startAt: cap.first, endAt: cap.last });
          else if (r.reason !== 'no-hands') out.push({ label: null, startAt: cap.first, endAt: cap.last });
          cap = null; streak = 0; cooldownUntil = f.at + 1200;
        }
        continue;
      }
      streak = f.hands ? streak + 1 : 0;
      if (streak >= 4 && f.at > cooldownUntil) cap = { frames: [], t0: f.at };
    }
    return out;
  }

  function spotter(classifier, frames) {
    const out = [];
    const sp = new SignSpotter(classifier, {
      onSign: (r) => out.push({ label: r.label, startAt: r.startAt, endAt: r.endAt, foundAt: now }),
      onUnknown: () => out.push({ label: null, startAt: now - 500, endAt: now }),
    });
    let now = 0;
    for (const f of frames) { now = f.at; sp.push(f); }
    return out;
  }

  function stream(test, mode, fps) {
    const frames = [];
    const truth = [];
    let t = 0;
    for (const s of test) {
      let fr = takes[s.name];
      if (mode === 'chain') {
        let a = 0, b = fr.length - 1;
        while (a < b && !fr[a].hands) a++;
        while (b > a && !fr[b].hands) b--;
        fr = fr.slice(a, b + 1);
      }
      const start = t;
      for (const f of fr) { frames.push({ ...f, at: t }); t += STEP; }
      truth.push({ label: s.label, start, end: t });
    }
    const keepEvery = 15 / fps;
    const sub = frames.filter((_, i) => Math.floor(i / keepEvery) !== Math.floor((i - 1) / keepEvery) || i === 0);
    return { frames: sub, truth };
  }

  function score(found, truth) {
    let correct = 0, wrong = 0, unknown = 0, extra = 0;
    const hit = new Set();
    for (const e of found) {
      const mid = (e.startAt + e.endAt) / 2;
      const i = truth.findIndex((x) => mid >= x.start && mid < x.end);
      if (i < 0) { extra++; continue; }
      if (!e.label) unknown++;
      else if (e.label === truth[i].label && !hit.has(i)) { correct++; hit.add(i); }
      else if (e.label === truth[i].label) extra++;
      else wrong++;
    }
    return { correct, wrong, unknown, extra, n: truth.length };
  }

  const results = {};
  for (const mode of ['drop', 'chain']) {
    for (const fps of [15, 10, 7.5]) {
      for (const algo of ['old', 'spotter']) {
        const tot = { correct: 0, wrong: 0, unknown: 0, extra: 0, n: 0 };
        for (let k = 0; k < K; k++) {
          const train = samples.filter((s) => s.id % K !== k);
          const test = samples.filter((s) => s.id % K === k);
          const c = new SignClassifier().fit(train);
          const { frames, truth } = stream(test, mode, fps);
          const found = algo === 'old' ? oldCapture(c, frames) : spotter(c, frames);
          const r = score(found, truth);
          for (const key in tot) tot[key] += r[key];
        }
        results[`${mode} ${fps}fps ${algo}`] = tot;
      }
    }
  }
  return results;
}, { samples, takes });

const pct = (x, n) => `${String(Math.round((x / n) * 100)).padStart(3)}%`;
console.log('\nstream                     correct  wrong  hindi-kita  extra   (of N signs)');
for (const [k, r] of Object.entries(report)) {
  console.log(`${k.padEnd(26)} ${pct(r.correct, r.n)}   ${pct(r.wrong, r.n)}   ${pct(r.unknown, r.n)}      ${pct(r.extra, r.n)}   ${r.n}`);
}
await browser.close();
server.kill();

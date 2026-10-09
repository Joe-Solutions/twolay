// 5-fold cross-validation of the classifier on app/packs/fsl105.json:
// train on 4/5 of the takes, classify the held-out 1/5, report accuracy / rejections / confusions.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8132;
const server = spawn('python3', [path.join(here, '../scripts/serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
await page.goto(`http://127.0.0.1:${PORT}/`);

const report = await page.evaluate(async () => {
  const { SignClassifier } = await import('./js/classifier.js');
  const pack = await (await fetch('./packs/fsl105.json')).json();
  const samples = pack.samples.map((s, i) => ({ ...s, id: i }));
  const K = 5;
  let correct = 0, wrong = 0, rejected = 0;
  const confusions = {};
  const per = {};
  for (let k = 0; k < K; k++) {
    const train = samples.filter((s) => s.id % K !== k);
    const test = samples.filter((s) => s.id % K === k);
    const c = new SignClassifier().fit(train);
    for (const s of test) {
      const r = c.predict(s.frames);
      const p = (per[s.label] ??= { n: 0, ok: 0, rej: 0 });
      p.n++;
      if (!r.label) { rejected++; p.rej++; }
      else if (r.label === s.label) { correct++; p.ok++; }
      else { wrong++; const key = `${s.label}->${r.label}`; confusions[key] = (confusions[key] || 0) + 1; }
    }
  }
  const n = samples.length;
  return { n, correct, wrong, rejected, confusions, per };
});
const pct = (x) => `${Math.round((x / report.n) * 100)}%`;
console.log(`held-out takes: ${report.n}`);
console.log(`correct:  ${report.correct} (${pct(report.correct)})`);
console.log(`wrong:    ${report.wrong} (${pct(report.wrong)})`, report.confusions);
console.log(`"hindi kita" (rejected): ${report.rejected} (${pct(report.rejected)})`);
for (const [label, p] of Object.entries(report.per)) {
  console.log(`  ${label.padEnd(20)} ${String(Math.round((p.ok / p.n) * 100)).padStart(3)}% correct, ${p.rej}/${p.n} rejected`);
}
await browser.close();
server.kill();

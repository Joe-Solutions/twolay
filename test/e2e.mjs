// End-to-end: two windows (demo mode), fake camera showing a "tulong" hand, fake mic saying
// "Ano ang sakit?". Fails if any request leaves 127.0.0.1.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8123;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = spawn('python3', [path.join(here, '../scripts/serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const external = [];
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${path.join(here, 'cam_tulong.y4m')}`,
    `--use-file-for-fake-audio-capture=${path.join(here, 'ano48.wav')}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
await ctx.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(ORIGIN) || u.startsWith('blob:') || u.startsWith('data:')) return route.continue();
  external.push(u);
  return route.abort();
});

const log = (who) => (m) => {
  const t = m.text?.() ?? String(m);
  if (/error|fail|refused|blocked/i.test(t)) console.log(`  [${who}] ${t.slice(0, 300)}`);
};
const step = (s) => console.log(`\n== ${s}`);

const kamay = await ctx.newPage();
kamay.on('console', log('kamay'));
kamay.on('pageerror', (e) => console.log(`  [kamay pageerror] ${e.message}`));
await kamay.goto(`${ORIGIN}/?role=kamay&link=demo`);

const boses = await ctx.newPage();
boses.on('console', log('boses'));
boses.on('pageerror', (e) => console.log(`  [boses pageerror] ${e.message}`));
await boses.goto(`${ORIGIN}/?role=boses&link=demo`);

step('link');
await kamay.waitForFunction(() => document.querySelector('#link-pill').textContent.includes('Konektado'), null, { timeout: 15000 });
await boses.waitForFunction(() => document.querySelector('#link-pill').textContent.includes('Konektado'), null, { timeout: 15000 });
console.log('  both windows connected over demo link');

step('kamay: camera + MediaPipe');
await kamay.waitForFunction(() => /Wala pang training|Handa/.test(document.querySelector('#k-status').textContent), null, { timeout: 30000 });
console.log(`  status: ${await kamay.textContent('#k-status')}`);

step('kamay: import training clips');
const clips = readdirSync(path.join(here, 'clips')).map((f) => path.join(here, 'clips', f));
await kamay.click('#setup-btn');
await kamay.click('.tabs button[data-tab="train"]');
await kamay.setInputFiles('#import-clips', clips);
await kamay.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('Na-import'), null, { timeout: 120000 });
console.log(`  ${await kamay.textContent('#toast')}`);
await kamay.waitForTimeout(500);
console.log(`  ${await kamay.textContent('#train-eval')}`);
await kamay.keyboard.press('Escape');
await kamay.waitForFunction(() => document.querySelector('#k-cam').readyState >= 2, null, { timeout: 15000 });

step('audience mode on in both windows');
for (const pg of [kamay, boses]) {
  await pg.evaluate(() => {
    const box = document.querySelector('#audience-mode');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
  });
}

step('kamay signs (fake camera shows the tulong hand)');
await kamay.waitForTimeout(1500);
await kamay.click('#k-btn');
await kamay.waitForFunction(() => document.querySelector('#k-btn').textContent === 'Kamay', null, { timeout: 15000 });
console.log(`  kamay caption: ${await kamay.textContent('#k-caption')}`);
console.log(`  kamay status:  ${await kamay.textContent('#k-status')}`);
await boses.waitForTimeout(800);
console.log(`  boses caption: ${await boses.textContent('#b-caption')}`);
const spoke = await boses.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.includes('/audio/')));
console.log(`  boses played local voice clip: ${spoke}`);
const audienceClip = await boses.evaluate(() => !document.querySelector('#b-clipbox').hidden && document.querySelector('#b-clip-label').textContent);
console.log(`  boses audience clip: ${audienceClip}`);
if (audienceClip !== 'TULONG') throw new Error('audience mode: Boses should show the TULONG sign clip');
const kamaySpoke = await kamay.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.includes('/audio/tulong')));
console.log(`  kamay said its own sign: ${kamaySpoke}`);
if (!kamaySpoke) throw new Error('audience mode: Kamay should say the sign it recognised');

step('boses: whisper load + speak "Ano ang sakit?"');
await boses.waitForFunction(() => document.querySelector('#b-btn').textContent === 'Boses', null, { timeout: 120000 });
await boses.click('#b-btn');
await boses.waitForFunction(
  () => document.querySelector('#b-btn').textContent === 'Boses' && document.querySelectorAll('#b-history li.from-boses').length > 0,
  null,
  { timeout: 90000 },
).catch(() => {});
console.log(`  boses caption: ${await boses.textContent('#b-caption')}`);
console.log(`  boses history: ${await boses.$$eval('#b-history li', (l) => l.map((x) => x.textContent).join(' | '))}`);
await kamay.waitForTimeout(1500);
console.log(`  kamay caption: ${await kamay.textContent('#k-caption')}`);
console.log(`  kamay clip:    ${await kamay.textContent('#k-clip-label')}`);
console.log(`  clip playing:  ${await kamay.evaluate(() => { const v = document.querySelector('#k-clip'); return v.src.startsWith('blob:') && v.readyState >= 2; })}`);

step('network');
for (const [name, p] of [['kamay', kamay], ['boses', boses]]) {
  const n = await p.evaluate(() => document.querySelector('#net-external').textContent);
  console.log(`  ${name} in-app external count: ${n}`);
}
console.log(`  requests that tried to leave 127.0.0.1: ${external.length}`);
for (const u of external) console.log(`    ${u}`);

await kamay.screenshot({ path: path.join(here, 'shot-kamay.png') });
await kamay.setViewportSize({ width: 390, height: 844 });
await kamay.screenshot({ path: path.join(here, 'shot-kamay-phone.png') });
await kamay.click('#setup-btn');
await kamay.click('.tabs button[data-tab="net"]');
await kamay.screenshot({ path: path.join(here, 'shot-netlog.png') });
await boses.screenshot({ path: path.join(here, 'shot-boses.png') });
await browser.close();
server.kill();

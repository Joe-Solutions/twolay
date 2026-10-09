// End-to-end, one phone: the fake camera shows a "tulong" hand and the fake mic says
// "Ano ang sakit?". The sign must be picked up automatically and spoken; the speech must show up
// as a caption with the SAKIT clip. Fails if any request leaves 127.0.0.1.
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

const step = (s) => console.log(`\n== ${s}`);
const page = await ctx.newPage();
page.on('console', (m) => { if (/error|fail|refused|blocked/i.test(m.text())) console.log(`  [page] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

step('import training clips');
await page.goto(`${ORIGIN}/`);
const clips = readdirSync(path.join(here, 'clips')).map((f) => path.join(here, 'clips', f));
await page.click('#setup-btn');
await page.click('.tabs button[data-tab="train"]');
await page.setInputFiles('#import-clips', clips);
await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('Na-import'), null, { timeout: 120000 });
console.log(`  ${await page.textContent('#toast')}`);
await page.waitForTimeout(500);
console.log(`  ${await page.textContent('#train-eval')}`);
await page.keyboard.press('Escape');

step('home → Simulan: camera + MediaPipe');
await page.click('#start-btn');
await page.waitForFunction(() => document.querySelector('#u-cam').readyState >= 2, null, { timeout: 30000 });
console.log(`  status: ${await page.textContent('#u-status')}`);

step('sign is picked up automatically (no button) and spoken');
await page.waitForFunction(() => document.querySelectorAll('#u-history li.from-kamay:not(.local)').length > 0, null, { timeout: 60000 });
console.log(`  caption: ${await page.textContent('#u-caption')}`);
console.log(`  status:  ${await page.textContent('#u-status')}`);
const signed = await page.$$eval('#u-history li.from-kamay', (l) => l.map((x) => x.textContent));
console.log(`  history: ${signed.join(' | ')}`);
if (!signed.some((t) => /tulong/i.test(t))) throw new Error('auto capture: expected the tulong sign');
let engine = 'none';
for (let i = 0; i < 60 && engine === 'none'; i++) {
  await page.waitForTimeout(500);
  engine = await page.evaluate(async () => (await import('./js/voice.js')).lastEngine);
}
console.log(`  said it via: ${engine}`);
if (engine === 'none') throw new Error('the recognised sign should be read aloud');

step('whisper load + speak "Ano ang sakit?"');
await page.waitForFunction(() => document.querySelector('#u-mic').textContent === 'Magsalita', null, { timeout: 120000 });
await page.click('#u-mic');
await page.waitForFunction(
  () => document.querySelector('#u-mic').textContent === 'Magsalita' && document.querySelectorAll('#u-history li.from-boses').length > 0,
  null,
  { timeout: 90000 },
);
console.log(`  caption: ${await page.textContent('#u-caption')}`);
console.log(`  history: ${await page.$$eval('#u-history li.from-boses', (l) => l.map((x) => x.textContent).join(' | '))}`);
await page.waitForTimeout(1500);
const clip = await page.textContent('#u-clip-label');
console.log(`  clip: ${clip}`);
console.log(`  clip playing: ${await page.evaluate(() => { const v = document.querySelector('#u-clip'); return v.src.startsWith('blob:') && v.readyState >= 2; })}`);
if (clip !== 'SAKIT') throw new Error('speech: expected the SAKIT sign clip');

step('network');
console.log(`  in-app external count: ${await page.evaluate(() => document.querySelector('#net-external').textContent)}`);
console.log(`  requests that tried to leave 127.0.0.1: ${external.length}`);
for (const u of external) console.log(`    ${u}`);

await page.screenshot({ path: path.join(here, 'shot-usap.png') });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: path.join(here, 'shot-usap-phone.png') });
await page.click('#setup-btn');
await page.click('.tabs button[data-tab="net"]');
await page.screenshot({ path: path.join(here, 'shot-netlog.png') });
await browser.close();
server.kill();
if (external.length) process.exit(1);

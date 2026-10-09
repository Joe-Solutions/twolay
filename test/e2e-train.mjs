// Turuan screen: record takes from the fake camera ("tulong" hand), undo, test-recognize.
// Fails if any request leaves 127.0.0.1.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8125;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = spawn('python3', [path.join(here, '../scripts/serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const external = [];
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${path.join(here, 'cam_tulong.y4m')}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({ permissions: ['camera'] });
await ctx.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(ORIGIN) || u.startsWith('blob:') || u.startsWith('data:')) return route.continue();
  external.push(u);
  return route.abort();
});

const step = (s) => console.log(`\n== ${s}`);
const fail = async (msg) => {
  console.log(`FAIL: ${msg}`);
  await browser.close();
  server.kill();
  process.exit(1);
};

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
await page.goto(ORIGIN);

step('home → Turuan');
await page.click('#train-btn');
await page.waitForFunction(() => /Handa/.test(document.querySelector('#t-status').textContent), null, { timeout: 30000 });
const chips = await page.$$eval('#t-chips .chip', (els) => els.length);
if (chips !== 12) await fail(`expected 12 sign chips, got ${chips}`);
console.log(`  ${chips} chips, first unfinished sign: ${await page.textContent('#t-word')}`);

step('pick Tulong (no reference clip yet)');
await page.click('#t-chips .chip:has-text("Tulong")');
await page.waitForFunction(() => document.querySelector('#t-word').textContent === 'TULONG');
if (await page.isHidden('#t-ref-card')) await fail('expected "Wala pang halimbawa" card for tulong');
console.log(`  progress: ${await page.textContent('#t-progress')}`);

async function take(n) {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => (document.querySelector('#t-status').textContent = ''));
    await page.click('#t-record');
    await page.waitForFunction(() => /take \d|Walang/.test(document.querySelector('#t-status').textContent), null, { timeout: 30000 });
    const status = await page.textContent('#t-status');
    console.log(`  ${status} — ${await page.textContent('#t-progress')}`);
    if (status.includes(`take ${n}`)) return;
  }
  await fail(`take ${n} never saved`);
}

step('record 2 takes, undo one');
await take(1);
await take(2);
await page.click('#t-undo');
await page.waitForFunction(() => document.querySelector('#t-progress').textContent.startsWith('1 /'));
console.log(`  after undo: ${await page.textContent('#t-progress')}`);
if (await page.isVisible('#t-ref-card')) await fail('first take should have saved a reference clip');

step('record up to 3 takes, then Subukan');
await take(2);
await take(3);
// The fake camera loops 1.5 s of hand per 4 s, so a capture can start at the tail end; retry.
let result = '';
for (let i = 0; i < 3 && !result.includes('Nakita'); i++) {
  await page.evaluate(() => (document.querySelector('#t-status').textContent = ''));
  await page.click('#t-test');
  await page.waitForFunction(() => /Nakita|hindi kita|Walang kamay/.test(document.querySelector('#t-status').textContent), null, { timeout: 30000 });
  result = await page.textContent('#t-status');
  console.log(`  ${result}`);
}
if (!result.includes('Tulong')) await fail('test should recognize tulong');

step('chip shows count; Home stops the camera');
const chip = await page.textContent('#t-chips .chip:has-text("Tulong") small');
console.log(`  Tulong chip: ${chip}`);
await page.click('#home-btn');
const live = await page.evaluate(() => !!document.querySelector('#t-cam').srcObject?.getTracks().some((t) => t.readyState === 'live'));
if (live) await fail('camera still live after Home');

console.log(`\nexternal requests: ${external.length}`);
await browser.close();
server.kill();
if (external.length) process.exit(1);
console.log('PASS');

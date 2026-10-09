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
  for (let i = 0; i < 4; i++) {
    if (i) await page.waitForTimeout(900 * i);   // shift the phase of the 4 s fake-camera loop
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
for (let i = 0; i < 4 && !result.includes('Nakita'); i++) {
  if (i) await page.waitForTimeout(900 * i);
  await page.evaluate(() => (document.querySelector('#t-status').textContent = ''));
  await page.click('#t-test');
  await page.waitForFunction(() => /Nakita|hindi kita|Walang kamay/.test(document.querySelector('#t-status').textContent), null, { timeout: 30000 });
  result = await page.textContent('#t-status');
  console.log(`  ${result}`);
}
if (!result.includes('Tulong')) await fail('test should recognize tulong');

step('add a new word "gutom", record it, map speech to it, remove it');
await page.fill('#t-new-word', 'Gutom');
await page.click('#t-add button');
await page.waitForFunction(() => document.querySelector('#t-word').textContent === 'GUTOM');
const chipCount = await page.$$eval('#t-chips .chip', (els) => els.length);
if (chipCount !== 13) await fail(`expected 13 chips after adding a word, got ${chipCount}`);
if (await page.isHidden('#t-remove-word')) await fail('remove button should show for an added word');
await take(1);
const mapped = await page.evaluate(async () => (await import('./js/signs.js')).textToSigns('Gutom na ako, pahingi ng tubig'));
console.log(`  "Gutom na ako, pahingi ng tubig" -> ${JSON.stringify(mapped)}`);
if (JSON.stringify(mapped) !== '["gutom","tubig"]') await fail('added word should win over the built-in synonym');
await page.fill('#t-new-word', 'tubig');
await page.click('#t-add button');
await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Nasa listahan na'));
console.log(`  duplicate rejected: ${await page.textContent('#toast')}`);
page.once('dialog', (d) => d.accept());
await page.click('#t-chips .chip:has-text("Gutom")');
await page.click('#t-remove-word');
await page.waitForFunction(() => document.querySelectorAll('#t-chips .chip').length === 12);
const after = await page.evaluate(async () => (await import('./js/signs.js')).textToSigns('gutom'));
console.log(`  after removal "gutom" -> ${JSON.stringify(after)}`);
if (JSON.stringify(after) !== '["pagkain"]') await fail('removed word should fall back to built-in mapping');

step('clear and restore the example clip');
// Tulong's example is the first take; Salamat's is the shipped FSL-105 clip.
for (const [sign, shipped] of [['Tulong', false], ['Salamat', true]]) {
  await page.click(`#t-chips .chip:has-text("${sign}")`);
  await page.waitForFunction(() => !document.querySelector('#t-clear-ref').hidden, null, { timeout: 10000 });
  page.once('dialog', (d) => d.accept());
  await page.click('#t-clear-ref');
  await page.waitForFunction(() => !document.querySelector('#t-ref-card').hidden);
  const restore = await page.isVisible('#t-restore-ref');
  console.log(`  ${sign}: example cleared, restore button ${restore ? 'shown' : 'hidden'}`);
  if (restore !== shipped) await fail(`${sign}: restore button should be ${shipped ? 'shown' : 'hidden'}`);
}
await page.click('#t-restore-ref');
await page.waitForFunction(() => document.querySelector('#t-ref-card').hidden);
console.log('  Salamat: FSL-105 example restored');

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

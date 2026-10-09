// 1) An untrained hand shape must give "hindi kita", not a guess.
// 2) After "save for offline", the app reloads and runs (camera + Whisper) with the server killed.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8125;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = spawn('python3', [path.join(here, '../scripts/serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${path.join(here, 'cam_unknown.y4m')}`,
    `--use-file-for-fake-audio-capture=${path.join(here, 'ano48.wav')}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
const step = (s) => console.log(`\n== ${s}`);

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
await page.goto(`${ORIGIN}/`);

step('train on tulong / sakit / tubig clips');
await page.click('#setup-btn');
await page.click('.tabs button[data-tab="train"]');
await page.setInputFiles('#import-clips', readdirSync(path.join(here, 'clips')).map((f) => path.join(here, 'clips', f)));
await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('Na-import'), null, { timeout: 120000 });
await page.keyboard.press('Escape');

step('untrained hand shape (two open hands), picked up automatically');
await page.click('#start-btn');
await page.waitForFunction(() => document.querySelectorAll('#u-history li.from-kamay').length > 0, null, { timeout: 150000 }).catch(async (err) => {
  console.log(`  status: ${await page.textContent('#u-status')}`);
  throw err;
});
const first = await page.$$eval('#u-history li.from-kamay', (l) => ({ text: l[0].textContent, local: l[0].classList.contains('local') }));
console.log(`  caption: ${await page.textContent('#u-caption')}\n  status:  ${await page.textContent('#u-status')}`);
if (!first.local) throw new Error(`untrained shape should be "hindi kita", got: ${first.text}`);

step('save for offline, kill server, reload');
await page.click('#setup-btn');
await page.click('.tabs button[data-tab="offline"]');
await page.click('#offline-cache');
await page.waitForFunction(() => /Handa offline|Error/.test(document.querySelector('#offline-status').textContent), null, { timeout: 120000 }).catch(() => {});
console.log(`  ${await page.textContent('#offline-status')}`);
server.kill();
await new Promise((r) => setTimeout(r, 500));
await page.goto(`${ORIGIN}/?screen=usap`);
await page.waitForFunction(() => /Nakatutok|Wala pang training/.test(document.querySelector('#u-status')?.textContent || ''), null, { timeout: 30000 });
console.log(`  after reload with server DOWN: ${await page.textContent('#u-status')} | ${await page.textContent('#offline-pill')}`);
await page.waitForFunction(() => document.querySelector('#u-mic').textContent === 'Magsalita', null, { timeout: 120000 });
await page.click('#u-mic');
await page.waitForFunction(() => document.querySelectorAll('#u-history li.from-boses').length > 0, null, { timeout: 90000 });
const heard = await page.textContent('#u-caption');
console.log(`  offline transcript: ${heard}`);
if (/Walang narinig|Hindi naintindihan/.test(heard)) throw new Error('offline Whisper should return a transcript');
await browser.close();

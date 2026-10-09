// 1) An untrained hand shape must give "hindi kita", not a guess.
// 2) When the other window disappears, the signer still recognises locally.
// 3) After "save for offline", the app reloads and runs with the server killed.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8125;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server = spawn('python3', [path.join(here, '../scripts/serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
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

const kamay = await ctx.newPage();
kamay.on('pageerror', (e) => console.log(`  [kamay pageerror] ${e.message}`));
await kamay.goto(`${ORIGIN}/?role=kamay&link=demo`);
const boses = await ctx.newPage();
await boses.goto(`${ORIGIN}/?role=boses&link=demo`);
await kamay.waitForFunction(() => document.querySelector('#link-pill').textContent.includes('Konektado'), null, { timeout: 15000 });

step('train on tulong / sakit / tubig clips');
await kamay.waitForFunction(() => /Wala pang training|Handa/.test(document.querySelector('#k-status').textContent), null, { timeout: 30000 });
await kamay.click('#setup-btn');
await kamay.click('.tabs button[data-tab="train"]');
await kamay.setInputFiles('#import-clips', readdirSync(path.join(here, 'clips')).map((f) => path.join(here, 'clips', f)));
await kamay.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('Na-import'), null, { timeout: 120000 });
await kamay.keyboard.press('Escape');
await kamay.waitForFunction(() => document.querySelector('#k-cam').readyState >= 2, null, { timeout: 15000 });

async function sign() {
  await kamay.waitForTimeout(1200);
  await kamay.click('#k-btn');
  await kamay.waitForFunction(() => document.querySelector('#k-btn').textContent === 'Kamay', null, { timeout: 15000 });
  return { caption: await kamay.textContent('#k-caption'), status: await kamay.textContent('#k-status') };
}

step('untrained hand shape (two open hands)');
const r1 = await sign();
console.log(`  caption: ${r1.caption}\n  status:  ${r1.status}`);
console.log(`  boses got anything: ${(await boses.$$('#b-history li')).length > 0}`);

step('link drop: close the Boses window');
await boses.close();
await kamay.waitForFunction(() => document.querySelector('#link-pill').textContent.includes('Nawala'), null, { timeout: 15000 });
console.log(`  link pill: ${await kamay.textContent('#link-pill')}`);
const r2 = await sign();
console.log(`  still recognises locally -> caption: ${r2.caption} | status: ${r2.status}`);

step('save for offline, kill server, reload');
await kamay.click('#setup-btn');
await kamay.click('.tabs button[data-tab="offline"]');
await kamay.click('#offline-cache');
await kamay.waitForFunction(() => /Handa offline|Error/.test(document.querySelector('#offline-status').textContent), null, { timeout: 120000 }).catch(() => {});
console.log(`  ${await kamay.textContent('#offline-status')}`);
server.kill();
await new Promise((r) => setTimeout(r, 500));
await kamay.reload();
await kamay.waitForFunction(() => /Wala pang training|Handa/.test(document.querySelector('#k-status')?.textContent || ''), null, { timeout: 30000 });
console.log(`  after reload with server DOWN: ${await kamay.textContent('#k-status')} | ${await kamay.textContent('#offline-pill')}`);

const b2 = await ctx.newPage();
await b2.goto(`${ORIGIN}/?role=boses&link=demo`);
await b2.waitForFunction(() => document.querySelector('#b-btn').textContent === 'Boses', null, { timeout: 120000 });
console.log(`  boses window opened offline, whisper ready: ${await b2.textContent('#b-hint')}`);
await b2.click('#b-btn');
await b2.waitForFunction(() => document.querySelectorAll('#b-history li.from-boses').length > 0, null, { timeout: 90000 }).catch(() => {});
console.log(`  offline transcript: ${await b2.textContent('#b-caption')}`);
await browser.close();

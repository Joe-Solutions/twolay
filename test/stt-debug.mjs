// Boses-only: load Whisper, record from the fake mic, print transcript or the error.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8124;
const wav = process.argv[2] || 'ano48.wav';
const server = spawn('python3', [path.join(here, '../scripts/serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(here, wav)}`],
});
const ctx = await browser.newContext({ permissions: ['microphone'] });
const p = await ctx.newPage();
p.on('console', (m) => console.log(`  [console] ${m.text().slice(0, 400)}`));
p.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
await p.goto(`http://127.0.0.1:${PORT}/?role=boses`);
await p.waitForFunction(() => {
  const b = document.querySelector('#b-btn');
  return !document.querySelector('#role-pill').hidden && b.textContent === 'Boses' && !b.classList.contains('busy');
}, null, { timeout: 120000 });
console.log('hint:', await p.textContent('#b-hint'));
await p.click('#b-btn');
await p.waitForFunction(() => !/Nakikinig|Isinusulat/.test(document.querySelector('#b-btn').textContent), null, { timeout: 90000 });
console.log('caption:', await p.textContent('#b-caption'));
console.log('history:', await p.$$eval('#b-history li', (l) => l.map((x) => x.textContent)));
const log = await p.evaluate(async () => (await import('./js/netlog.js')).netlog.dump());
console.log(log.split('\n').filter((l) => !l.includes('[local]')).join('\n'));
await browser.close();
server.kill();
